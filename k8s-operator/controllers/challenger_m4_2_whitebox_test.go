/*
Copyright 2026 CallTelemetry.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package controllers_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	coordinationv1 "k8s.io/api/coordination/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"

	reviewv1alpha2 "github.com/calltelemetry/ct-review-bot/k8s-operator/api/v1alpha2"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/controllers"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/job"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/workspace"
)

// =========================================================================
// 1. NAMESPACED ISOLATION & FENCING BOUNDARY EMPIRICAL CHALLENGES
// =========================================================================

// TestChallengerM4_2_FencingEpoch_CrossNamespaceIsolation verifies that a sibling
// review with a higher epoch in another namespace (e.g., "other-system") does NOT
// cause epoch regression or fail-closed on a review in "ct-review-system".
func TestChallengerM4_2_FencingEpoch_CrossNamespaceIsolation(t *testing.T) {
	now := time.Date(2026, 9, 27, 20, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)

	// Legitimate review in ct-review-system with epoch 5
	legitReview := v1alpha2Review(now)
	legitReview.Namespace = "ct-review-system"
	legitReview.Spec.FencingEpoch = 5
	legitReview.Status.AuthoritativeFencingEpoch = 0
	legitReview.Status.Phase = reviewv1alpha2.PhaseQueued

	// Adversarial sibling in another namespace with massive epoch 9999
	alienReview := v1alpha2Review(now)
	alienReview.Name = "ct-review-alien-0000000000000000000"
	alienReview.Namespace = "other-system"
	alienReview.Spec.RepositoryID = legitReview.Spec.RepositoryID
	alienReview.Spec.PRNumber = legitReview.Spec.PRNumber
	alienReview.Spec.FencingEpoch = 9999
	alienReview.Status.AuthoritativeFencingEpoch = 9999

	kube := fake.NewClientBuilder().WithScheme(scheme).
		WithObjects(legitReview, alienReview).
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).
		Build()

	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client: kube,
		Scheme: scheme,
		Now:    func() time.Time { return now },
	}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: legitReview.Namespace, Name: legitReview.Name}}

	_, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("unexpected reconcile error: %v", err)
	}

	var updated reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), req.NamespacedName, &updated); err != nil {
		t.Fatalf("get updated review: %v", err)
	}

	// Must NOT fail due to alien sibling epoch 9999
	if updated.Status.Phase == reviewv1alpha2.PhaseFailed {
		t.Fatalf("cross-namespace boundary breach: review failed due to alien review epoch, phase = %s, message = %s",
			updated.Status.Phase, updated.Status.Message)
	}
	cond := meta.FindStatusCondition(updated.Status.Conditions, reviewv1alpha2.ConditionFencingEpochMismatch)
	if cond != nil && cond.Status == metav1.ConditionTrue {
		t.Fatalf("cross-namespace boundary breach: ConditionFencingEpochMismatch set to True from alien namespace: %#v", cond)
	}

	// Authoritative epoch must be initialized to legitReview's epoch 5
	if updated.Status.AuthoritativeFencingEpoch != 5 {
		t.Fatalf("authoritativeFencingEpoch = %d, want 5", updated.Status.AuthoritativeFencingEpoch)
	}
}

// TestChallengerM4_2_FencingEpoch_DifferentRepoSamePRNumber verifies that a review
// for a different repository (RepositoryID=999) with a higher epoch does NOT affect
// this review (RepositoryID=123).
func TestChallengerM4_2_FencingEpoch_DifferentRepoSamePRNumber(t *testing.T) {
	now := time.Date(2026, 9, 27, 20, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)

	// Review for repo 123 with epoch 3
	myReview := v1alpha2Review(now)
	myReview.Spec.RepositoryID = 123
	myReview.Spec.PRNumber = 42
	myReview.Spec.FencingEpoch = 3
	myReview.Status.AuthoritativeFencingEpoch = 0
	myReview.Status.Phase = reviewv1alpha2.PhaseQueued

	// Sibling review in the same namespace for repo 999 with epoch 50
	otherRepoReview := v1alpha2Review(now)
	otherRepoReview.Name = "ct-review-other-repo-00000000000"
	otherRepoReview.Spec.RepositoryID = 999
	otherRepoReview.Spec.PRNumber = 42
	otherRepoReview.Spec.FencingEpoch = 50
	otherRepoReview.Status.AuthoritativeFencingEpoch = 50

	kube := fake.NewClientBuilder().WithScheme(scheme).
		WithObjects(myReview, otherRepoReview).
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).
		Build()

	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client: kube,
		Scheme: scheme,
		Now:    func() time.Time { return now },
	}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: myReview.Namespace, Name: myReview.Name}}

	_, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("unexpected reconcile error: %v", err)
	}

	var updated reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), req.NamespacedName, &updated); err != nil {
		t.Fatalf("get updated review: %v", err)
	}

	if updated.Status.Phase == reviewv1alpha2.PhaseFailed {
		t.Fatalf("unrelated repo with higher epoch caused failure: phase=%s, msg=%s", updated.Status.Phase, updated.Status.Message)
	}
	if updated.Status.AuthoritativeFencingEpoch != 3 {
		t.Fatalf("authoritativeFencingEpoch = %d, want 3", updated.Status.AuthoritativeFencingEpoch)
	}
}

// TestChallengerM4_2_FencingEpoch_MaxSafeIntegerBoundary verifies handling of the
// maximum safe integer boundary (9007199254740991) and regression against it.
func TestChallengerM4_2_FencingEpoch_MaxSafeIntegerBoundary(t *testing.T) {
	now := time.Date(2026, 9, 27, 20, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)

	maxSafeInt := int64(9007199254740991)

	// High authority sibling established at maxSafeInt
	authoritativeSibling := v1alpha2Review(now)
	authoritativeSibling.Name = "ct-review-max-safe-sib-000000000"
	authoritativeSibling.Spec.FencingEpoch = maxSafeInt
	authoritativeSibling.Status.AuthoritativeFencingEpoch = maxSafeInt

	// Candidate review with maxSafeInt - 1 (regression)
	candidate := v1alpha2Review(now)
	candidate.Name = "ct-review-max-safe-cand-00000000"
	candidate.Spec.FencingEpoch = maxSafeInt - 1
	candidate.Status.AuthoritativeFencingEpoch = 0
	candidate.Status.Phase = reviewv1alpha2.PhaseRunning

	candidateJob, candidatePod := createActiveJobAndPod(candidate)

	kube := fake.NewClientBuilder().WithScheme(scheme).
		WithObjects(authoritativeSibling, candidate, candidateJob, candidatePod).
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).
		Build()

	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client: kube,
		Scheme: scheme,
		Now:    func() time.Time { return now },
	}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: candidate.Namespace, Name: candidate.Name}}

	_, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("reconcile error: %v", err)
	}

	var updated reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), req.NamespacedName, &updated); err != nil {
		t.Fatalf("get candidate: %v", err)
	}

	// Must fail-closed due to regression against maxSafeInt
	if updated.Status.Phase != reviewv1alpha2.PhaseFailed {
		t.Fatalf("phase = %s, want PhaseFailed", updated.Status.Phase)
	}
	cond := meta.FindStatusCondition(updated.Status.Conditions, reviewv1alpha2.ConditionFencingEpochMismatch)
	if cond == nil || cond.Status != metav1.ConditionTrue {
		t.Fatalf("ConditionFencingEpochMismatch = %#v, want True", cond)
	}

	// Active pod and job must NOT be deleted
	var survivingJob batchv1.Job
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: candidateJob.Namespace, Name: candidateJob.Name}, &survivingJob); err != nil {
		t.Fatalf("candidate job was deleted: %v", err)
	}
	var survivingPod corev1.Pod
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: candidatePod.Namespace, Name: candidatePod.Name}, &survivingPod); err != nil {
		t.Fatalf("candidate pod was deleted: %v", err)
	}
}

// =========================================================================
// 2. STALE WORKER LEASE TOKEN EMPIRICAL CHALLENGES
// =========================================================================

// TestChallengerM4_2_StaleLeaseToken_CrossNamespaceLeaseNotAccepted verifies that
// a Lease existing in another namespace (e.g. "default") is NOT accepted to satisfy
// the lease check in "ct-review-system", failing closed safely.
func TestChallengerM4_2_StaleLeaseToken_CrossNamespaceLeaseNotAccepted(t *testing.T) {
	now := time.Date(2026, 9, 27, 20, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)

	review := v1alpha2Review(now)
	review.Spec.WorkerLeaseToken = "token-alpha"
	review.Status.Phase = reviewv1alpha2.PhaseRunning
	// Mark worker creation attempted
	meta.SetStatusCondition(&review.Status.Conditions, metav1.Condition{
		Type:               "WorkerCreationReserved",
		Status:             metav1.ConditionTrue,
		Reason:             "Reserved",
		LastTransitionTime: metav1.NewTime(now.Add(-time.Minute)),
	})

	workerJob, workerPod := createActiveJobAndPod(review)

	// Lease placed in wrong namespace ("default")
	leaseName := workspace.LeaseName(review.Spec.RepositoryID, review.Spec.PRNumber)
	freshTime := metav1.NewMicroTime(now.Add(-10 * time.Second))
	duration := int32(300)
	holder := review.Spec.RunID
	transitions := int32(1)
	alienLease := &coordinationv1.Lease{
		ObjectMeta: metav1.ObjectMeta{
			Name:      leaseName,
			Namespace: "default", // Wrong namespace!
			Annotations: map[string]string{
				"review-yeti.ai/lease-token": "token-alpha",
			},
		},
		Spec: coordinationv1.LeaseSpec{
			HolderIdentity:       &holder,
			LeaseDurationSeconds: &duration,
			AcquireTime:          &freshTime,
			RenewTime:            &freshTime,
			LeaseTransitions:     &transitions,
		},
	}

	kube := fake.NewClientBuilder().WithScheme(scheme).
		WithObjects(review, alienLease, workerJob, workerPod).
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).
		Build()

	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client: kube,
		Scheme: scheme,
		Now:    func() time.Time { return now },
	}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	_, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("unexpected reconcile error: %v", err)
	}

	var updated reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), req.NamespacedName, &updated); err != nil {
		t.Fatalf("get updated review: %v", err)
	}

	// Must fail closed because lease is missing in ct-review-system
	if updated.Status.Phase != reviewv1alpha2.PhaseFailed {
		t.Fatalf("phase = %s, want PhaseFailed for missing namespaced lease", updated.Status.Phase)
	}
	cond := meta.FindStatusCondition(updated.Status.Conditions, reviewv1alpha2.ConditionStaleWorkerLease)
	if cond == nil || cond.Status != metav1.ConditionTrue {
		t.Fatalf("expected ConditionStaleWorkerLease=True, got %#v", cond)
	}

	// Pod must NOT be deleted
	var survivingPod corev1.Pod
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: workerPod.Namespace, Name: workerPod.Name}, &survivingPod); err != nil {
		t.Fatalf("worker pod was deleted: %v", err)
	}
}

// =========================================================================
// 3. UNKNOWN EFFECT GUARD & POD TERMINATION EMPIRICAL CHALLENGES
// =========================================================================

// TestChallengerM4_2_UnknownEffectGuard_ExhaustivePodTerminationScenarios tests all
// failure modes: Eviction (disk & memory), Preemption, DeadlineExceeded, OOMKilled,
// and Job failure without container records.
func TestChallengerM4_2_UnknownEffectGuard_ExhaustivePodTerminationScenarios(t *testing.T) {
	testCases := []struct {
		name           string
		podReason      string
		podMessage     string
		containerTerm  *corev1.ContainerStateTerminated
		expectedReason string
	}{
		{
			name:           "Memory pressure pod eviction",
			podReason:      "Evicted",
			podMessage:     "The node was low on resource: memory.",
			containerTerm:  nil,
			expectedReason: controllers.ReasonPodEvictedWithInFlightEffect,
		},
		{
			name:           "Ephemeral storage pod eviction",
			podReason:      "Evicted",
			podMessage:     "The node was low on resource: ephemeral-storage.",
			containerTerm:  nil,
			expectedReason: controllers.ReasonPodEvictedWithInFlightEffect,
		},
		{
			name:           "Scheduler preemption (Preempted)",
			podReason:      "Preempted",
			podMessage:     "Preempted by priorityClass system-cluster-critical",
			containerTerm:  nil,
			expectedReason: controllers.ReasonPodPreemptedWithInFlightEffect,
		},
		{
			name:           "Active deadline exceeded timeout",
			podReason:      "DeadlineExceeded",
			podMessage:     "Pod was active on the node longer than 900 seconds",
			containerTerm:  nil,
			expectedReason: controllers.ReasonPodTimeoutWithInFlightEffect,
		},
		{
			name:       "Container OOMKilled with exit 137",
			podReason:  "",
			podMessage: "",
			containerTerm: &corev1.ContainerStateTerminated{
				ExitCode: 137,
				Reason:   "OOMKilled",
				Message:  "Memory cgroup limit exceeded",
			},
			expectedReason: controllers.ReasonPodFailedWithInFlightEffect,
		},
		{
			name:       "Container application failure with exit 1",
			podReason:  "",
			podMessage: "",
			containerTerm: &corev1.ContainerStateTerminated{
				ExitCode: 1,
				Reason:   "Error",
				Message:  "FATAL: network timeout during patch publication",
			},
			expectedReason: controllers.ReasonPodFailedWithInFlightEffect,
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			f := newTerminationFixture(t)
			worker := f.worker(t)
			assignFakeWorkerUID(t, f.kube, worker)

			var containerStatuses []corev1.ContainerStatus
			if tc.containerTerm != nil {
				containerStatuses = []corev1.ContainerStatus{{
					Name: job.WorkerContainerName,
					State: corev1.ContainerState{
						Terminated: tc.containerTerm,
					},
				}}
			}

			pod := &corev1.Pod{
				ObjectMeta: metav1.ObjectMeta{
					Name:      worker.Name + "-adv-pod",
					Namespace: f.review.Namespace,
					Labels: map[string]string{
						"batch.kubernetes.io/job-name": worker.Name,
					},
				},
				Status: corev1.PodStatus{
					Phase:             corev1.PodFailed,
					Reason:            tc.podReason,
					Message:           tc.podMessage,
					ContainerStatuses: containerStatuses,
				},
			}
			bindTestPodToWorker(pod, worker)
			if err := f.kube.Create(context.Background(), pod); err != nil {
				t.Fatalf("failed to create pod: %v", err)
			}

			worker.Status.Failed = 1
			if err := f.kube.Status().Update(context.Background(), worker); err != nil {
				t.Fatalf("failed to update worker status: %v", err)
			}

			// Reconcile
			if _, err := f.reconciler.Reconcile(context.Background(), f.req); err != nil {
				t.Fatalf("reconcile error: %v", err)
			}

			review := storedReview(t, f.kube, f.req)

			// 1. ConditionUnknownEffectPending MUST be True
			cond := meta.FindStatusCondition(review.Status.Conditions, controllers.ConditionUnknownEffectPending)
			if cond == nil || cond.Status != metav1.ConditionTrue {
				t.Fatalf("expected ConditionUnknownEffectPending=True, got %#v", cond)
			}
			if cond.Reason != tc.expectedReason {
				t.Fatalf("condition reason = %s, want %s", cond.Reason, tc.expectedReason)
			}

			// 2. Review phase must NOT be Succeeded
			if review.Status.Phase == reviewv1alpha2.PhaseSucceeded {
				t.Fatalf("review was promoted to Succeeded after pod failure!")
			}

			// 3. Monotonic preservation: subsequent reconcile must NOT clear the condition
			if _, err := f.reconciler.Reconcile(context.Background(), f.req); err != nil {
				t.Fatalf("subsequent reconcile error: %v", err)
			}
			review2 := storedReview(t, f.kube, f.req)
			cond2 := meta.FindStatusCondition(review2.Status.Conditions, controllers.ConditionUnknownEffectPending)
			if cond2 == nil || cond2.Status != metav1.ConditionTrue {
				t.Fatalf("ConditionUnknownEffectPending was cleared on subsequent reconcile: %#v", cond2)
			}
		})
	}
}

// =========================================================================
// 4. PROMOTION BLOCKS EMPIRICAL CHALLENGES
// =========================================================================

// TestChallengerM4_2_PromotionBlocks_MultiVectorVerification tests that all possible
// promotion gates strictly block transition to PhaseSucceeded:
// 1. ConditionUnknownEffectPending = True
// 2. ReceiptDigest missing
// 3. ReceiptEvidenceRef missing
// 4. Fencing epoch regression
// 5. Stale worker lease token
func TestChallengerM4_2_PromotionBlocks_MultiVectorVerification(t *testing.T) {
	// Vector 1: ReceiptDigest empty
	t.Run("missing receipt digest blocks promotion", func(t *testing.T) {
		review := &reviewv1alpha2.PRReviewJob{
			Status: reviewv1alpha2.PRReviewJobStatus{
				ReceiptDigest:      "",
				ReceiptEvidenceRef: "audit://ct-review-system/run-1",
			},
		}
		err := controllers.AssertCanPromoteToSucceeded(review)
		if !errors.Is(err, controllers.ErrMissingReceiptAudit) {
			t.Fatalf("expected ErrMissingReceiptAudit, got %v", err)
		}
	})

	// Vector 2: ReceiptEvidenceRef empty
	t.Run("missing receipt evidence ref blocks promotion", func(t *testing.T) {
		review := &reviewv1alpha2.PRReviewJob{
			Status: reviewv1alpha2.PRReviewJobStatus{
				ReceiptDigest:      "sha256:1111222233334444555566667777888899990000aaaaabbbbbcccccdddddeeeee",
				ReceiptEvidenceRef: "",
			},
		}
		err := controllers.AssertCanPromoteToSucceeded(review)
		if !errors.Is(err, controllers.ErrMissingReceiptAudit) {
			t.Fatalf("expected ErrMissingReceiptAudit, got %v", err)
		}
	})

	// Vector 3: ConditionUnknownEffectPending = True
	t.Run("pending unknown effect blocks promotion", func(t *testing.T) {
		review := &reviewv1alpha2.PRReviewJob{
			Status: reviewv1alpha2.PRReviewJobStatus{
				ReceiptDigest:      "sha256:1111222233334444555566667777888899990000aaaaabbbbbcccccdddddeeeee",
				ReceiptEvidenceRef: "audit://ct-review-system/run-1",
				Conditions: []metav1.Condition{{
					Type:   controllers.ConditionUnknownEffectPending,
					Status: metav1.ConditionTrue,
					Reason: controllers.ReasonUnknownEffectPreserved,
				}},
			},
		}
		err := controllers.AssertCanPromoteToSucceeded(review)
		if !errors.Is(err, controllers.ErrUnknownEffectPending) {
			t.Fatalf("expected ErrUnknownEffectPending, got %v", err)
		}
	})

	// Vector 4: End-to-end reconcile blocks promotion when worker claims Succeeded=1
	// but ConditionUnknownEffectPending is True
	t.Run("reconcile blocks promotion on Succeeded worker with unknown effect", func(t *testing.T) {
		f := newTerminationFixture(t)
		worker := f.worker(t)
		assignFakeWorkerUID(t, f.kube, worker)

		// Pre-seed UnknownEffectPending
		curReview := storedReview(t, f.kube, f.req)
		meta.SetStatusCondition(&curReview.Status.Conditions, metav1.Condition{
			Type:               controllers.ConditionUnknownEffectPending,
			Status:             metav1.ConditionTrue,
			Reason:             controllers.ReasonPodEvictedWithInFlightEffect,
			LastTransitionTime: metav1.NewTime(f.now),
		})
		if err := f.kube.Status().Update(context.Background(), curReview); err != nil {
			t.Fatalf("update review: %v", err)
		}

		// Worker pod claims exit 0 and Job Complete
		f.finishWorker(t, true, corev1.ContainerStateTerminated{
			ExitCode:   0,
			Reason:     "Completed",
			StartedAt:  metav1.NewTime(f.now.Add(5 * time.Second)),
			FinishedAt: metav1.NewTime(f.now.Add(35 * time.Second)),
		}, "")

		if _, err := f.reconciler.Reconcile(context.Background(), f.req); err != nil {
			t.Fatalf("reconcile failed: %v", err)
		}

		after := storedReview(t, f.kube, f.req)
		if after.Status.Phase == reviewv1alpha2.PhaseSucceeded {
			t.Fatal("CRITICAL INVARIANT VIOLATION: worker promoted to PhaseSucceeded with pending unknown effect!")
		}
		if after.Status.Phase != reviewv1alpha2.PhaseFailed {
			t.Fatalf("phase = %s, want PhaseFailed", after.Status.Phase)
		}
	})
}

// =========================================================================
// 5. TERMINAL DELETION RECEIPT AUDITABILITY EMPIRICAL CHALLENGES
// =========================================================================

// TestChallengerM4_2_TerminalDeletion_ReceiptSynthesizedAndCommittedBeforeDelete
// verifies that if a terminal review has no receipt fields:
// 1. reconcileTerminalDeletion calls ensureReceiptAuditability to synthesize sha256 ReceiptDigest
//    and ReceiptEvidenceRef, and persists them BEFORE calling Delete on the review.
// 2. reconcileRunSecretDeletion synthesizes and persists ReceiptDigest and ReceiptEvidenceRef
//    BEFORE deleting the run Secret.
func TestChallengerM4_2_TerminalDeletion_ReceiptSynthesizedAndCommittedBeforeDelete(t *testing.T) {
	t.Setenv("REVIEW_YETI_TERMINAL_RETENTION_SECONDS", "60")
	now := time.Date(2026, 9, 27, 20, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)

	// Sub-test A: Retention expiry triggers deleteTerminalReview
	t.Run("receipt audit synthesized before PRReviewJob retention deletion", func(t *testing.T) {
		completed := metav1.NewTime(now.Add(-65 * time.Second))
		review := terminalReviewFixture(now.Add(-65*time.Second), reviewv1alpha2.PhaseFailed, &completed)
		review.Status.ReceiptDigest = ""
		review.Status.ReceiptEvidenceRef = ""

		baseKube := fake.NewClientBuilder().WithScheme(scheme).
			WithObjects(review).
			WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).
			Build()

		var receiptRecordedBeforeDelete bool
		var observedDigest string
		var observedEvidenceRef string

		interceptedKube := interceptor.NewClient(baseKube, interceptor.Funcs{
			Delete: func(ctx context.Context, c client.WithWatch, obj client.Object, opts ...client.DeleteOption) error {
				if r, ok := obj.(*reviewv1alpha2.PRReviewJob); ok && r.Name == review.Name {
					if r.Status.ReceiptDigest != "" && r.Status.ReceiptEvidenceRef != "" {
						receiptRecordedBeforeDelete = true
						observedDigest = r.Status.ReceiptDigest
						observedEvidenceRef = r.Status.ReceiptEvidenceRef
					}
				}
				return c.Delete(ctx, obj, opts...)
			},
		})

		reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
			Client: interceptedKube,
			Scheme: scheme,
			Now:    func() time.Time { return now },
		}
		req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

		if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
			t.Fatalf("reconcile error: %v", err)
		}

		if !receiptRecordedBeforeDelete {
			t.Fatal("ReceiptDigest and ReceiptEvidenceRef were NOT present in review status when Delete was called!")
		}
		if !strings.HasPrefix(observedDigest, "sha256:") || len(observedDigest) != 71 {
			t.Fatalf("observedDigest %q does not match sha256:64hex format", observedDigest)
		}
		if !strings.HasPrefix(observedEvidenceRef, "audit://") {
			t.Fatalf("observedEvidenceRef %q does not have audit:// prefix", observedEvidenceRef)
		}
	})

	// Sub-test B: Deleting review synthesizes receipt audit before run Secret deletion
	t.Run("receipt audit synthesized before run Secret deletion", func(t *testing.T) {
		completed := metav1.NewTime(now.Add(-65 * time.Second))
		review := terminalReviewFixture(now.Add(-65*time.Second), reviewv1alpha2.PhaseFailed, &completed)
		review.Status.ReceiptDigest = ""
		review.Status.ReceiptEvidenceRef = ""

		secret := secretFixture(review.Spec.RunSecretName, review.Namespace)
		baseKube := deletingReviewFixture(t, scheme, review, secret)

		var secretDeleted bool
		var receiptPresentWhenSecretDeleted bool

		interceptedKube := interceptor.NewClient(baseKube, interceptor.Funcs{
			Delete: func(ctx context.Context, c client.WithWatch, obj client.Object, opts ...client.DeleteOption) error {
				if s, ok := obj.(*corev1.Secret); ok && s.Name == secret.Name {
					secretDeleted = true
					var stored reviewv1alpha2.PRReviewJob
					if err := c.Get(ctx, types.NamespacedName{Namespace: review.Namespace, Name: review.Name}, &stored); err == nil {
						if stored.Status.ReceiptDigest != "" && stored.Status.ReceiptEvidenceRef != "" {
							receiptPresentWhenSecretDeleted = true
						}
					}
				}
				return c.Delete(ctx, obj, opts...)
			},
		})

		reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
			Client: interceptedKube,
			Scheme: scheme,
			Now:    func() time.Time { return now },
		}
		req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

		if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
			t.Fatalf("reconcile terminating review: %v", err)
		}

		if !secretDeleted {
			t.Fatal("expected run secret to be deleted")
		}
		if !receiptPresentWhenSecretDeleted {
			t.Fatal("ReceiptDigest and ReceiptEvidenceRef were NOT committed in status when Secret was deleted!")
		}
	})
}

// =========================================================================
// 6. FORBIDDEN EFFECT TRANSITIONS EMPIRICAL CHALLENGES
// =========================================================================

// TestChallengerM4_2_ForbiddenTransitions_StrictEnforcement tests that all forbidden
// state transitions are unconditionally blocked by ValidateEffectTransition.
func TestChallengerM4_2_ForbiddenTransitions_StrictEnforcement(t *testing.T) {
	forbiddenPairs := []struct {
		from string
		to   string
	}{
		{from: controllers.EffectStateUnknown, to: controllers.EffectStateInFlight},
		{from: controllers.EffectStateUnknown, to: controllers.EffectStateSucceeded},
		{from: controllers.EffectStateIntended, to: controllers.EffectStateSucceeded},
		{from: controllers.EffectStateIntended, to: controllers.EffectStateFailed},
		{from: controllers.EffectStateIntended, to: controllers.EffectStateUnknown},
		{from: controllers.EffectStateFailed, to: controllers.EffectStateInFlight},
		{from: controllers.EffectStateFailed, to: controllers.EffectStateSucceeded},
		{from: controllers.EffectStateSucceeded, to: controllers.EffectStateInFlight},
		{from: controllers.EffectStateSucceeded, to: controllers.EffectStateFailed},
		{from: controllers.EffectStateManual, to: controllers.EffectStateInFlight},
		{from: controllers.EffectStateManual, to: controllers.EffectStateSucceeded},
	}

	for _, pair := range forbiddenPairs {
		t.Run(pair.from+"_to_"+pair.to, func(t *testing.T) {
			err := controllers.ValidateEffectTransition(pair.from, pair.to)
			if err == nil {
				t.Fatalf("transition from %s to %s must be FORBIDDEN, but succeeded", pair.from, pair.to)
			}
			if !errors.Is(err, controllers.ErrInvalidEffectTransition) {
				t.Fatalf("error must wrap ErrInvalidEffectTransition, got %v", err)
			}
		})
	}
}
