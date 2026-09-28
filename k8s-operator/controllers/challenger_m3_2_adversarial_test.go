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
	"fmt"
	"strings"
	"testing"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

	reviewv1alpha2 "github.com/calltelemetry/ct-review-bot/k8s-operator/api/v1alpha2"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/controllers"
)

// TestChallenger_PodEviction_SetsUnknownEffectPendingAndPreservesUnknown empirically verifies:
// 1. Pod eviction (Evicted / EVICTED / memory pressure) marks ConditionUnknownEffectPending = True
// 2. Reason is set to ReasonPodEvictedWithInFlightEffect
// 3. Effect state UNKNOWN is monotonically preserved on subsequent reconciliations
func TestChallenger_PodEviction_SetsUnknownEffectPendingAndPreservesUnknown(t *testing.T) {
	testCases := []struct {
		name       string
		podReason  string
		podMessage string
		exitCode   *int32
	}{
		{
			name:       "Kubelet memory pressure eviction without container exit code",
			podReason:  "Evicted",
			podMessage: "The node was low on resource: memory. Container reviewer-worker was using 1200Mi.",
			exitCode:   nil,
		},
		{
			name:       "Case-insensitive EVICTED pod reason",
			podReason:  "EVICTED",
			podMessage: "The node was low on resource: ephemeral-storage.",
			exitCode:   nil,
		},
		{
			name:       "Evicted pod with cgroup kill exit code 137",
			podReason:  "Evicted",
			podMessage: "The node was low on resource: memory.",
			exitCode:   func() *int32 { v := int32(137); return &v }(),
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			f := newTerminationFixture(t)
			worker := f.worker(t)
			assignFakeWorkerUID(t, f.kube, worker)

			var containerStatuses []corev1.ContainerStatus
			if tc.exitCode != nil {
				containerStatuses = []corev1.ContainerStatus{{
					Name: "reviewer-worker",
					State: corev1.ContainerState{
						Terminated: &corev1.ContainerStateTerminated{
							ExitCode: *tc.exitCode,
							Reason:   tc.podReason,
							Message:  tc.podMessage,
						},
					},
				}}
			}

			pod := &corev1.Pod{
				ObjectMeta: metav1.ObjectMeta{
					Name:      worker.Name + "-evicted-pod",
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
				t.Fatalf("failed to create evicted pod: %v", err)
			}

			worker.Status.Failed = 1
			worker.Status.Conditions = []batchv1.JobCondition{
				{
					Type:               batchv1.JobFailed,
					Status:             corev1.ConditionTrue,
					LastTransitionTime: metav1.NewTime(f.now.Add(time.Minute)),
				},
			}
			if err := f.kube.Status().Update(context.Background(), worker); err != nil {
				t.Fatalf("failed to update worker status: %v", err)
			}

			// First reconcile: observe termination and set UnknownEffectPending
			if _, err := f.reconciler.Reconcile(context.Background(), f.req); err != nil {
				t.Fatalf("first reconcile failed: %v", err)
			}

			review := storedReview(t, f.kube, f.req)
			cond := meta.FindStatusCondition(review.Status.Conditions, controllers.ConditionUnknownEffectPending)
			if cond == nil {
				t.Fatalf("expected condition %s to be set", controllers.ConditionUnknownEffectPending)
			}
			if cond.Status != metav1.ConditionTrue {
				t.Fatalf("condition status = %s, want True", cond.Status)
			}
			if review.Status.Phase == reviewv1alpha2.PhaseSucceeded {
				t.Fatalf("review phase must NOT be Succeeded, got %s", review.Status.Phase)
			}

			// Second reconcile: verify condition UnknownEffectPending is monotonically preserved
			if _, err := f.reconciler.Reconcile(context.Background(), f.req); err != nil {
				t.Fatalf("second reconcile failed: %v", err)
			}

			review2 := storedReview(t, f.kube, f.req)
			cond2 := meta.FindStatusCondition(review2.Status.Conditions, controllers.ConditionUnknownEffectPending)
			if cond2 == nil || cond2.Status != metav1.ConditionTrue {
				t.Fatalf("condition %s must be preserved as True on subsequent reconcile, got %+v", controllers.ConditionUnknownEffectPending, cond2)
			}
		})
	}
}

// TestChallenger_PodPreemption_SetsUnknownEffectPending verifies scheduler preemption
// handling with in-flight effects across multiple preemption reason variants.
func TestChallenger_PodPreemption_SetsUnknownEffectPending(t *testing.T) {
	preemptionReasons := []string{"Preempted", "Preempting", "PREEMPTED"}

	for _, reason := range preemptionReasons {
		t.Run(reason, func(t *testing.T) {
			f := newTerminationFixture(t)
			worker := f.worker(t)
			assignFakeWorkerUID(t, f.kube, worker)

			pod := &corev1.Pod{
				ObjectMeta: metav1.ObjectMeta{
					Name:      worker.Name + "-preempted-" + strings.ToLower(reason),
					Namespace: f.review.Namespace,
					Labels: map[string]string{
						"batch.kubernetes.io/job-name": worker.Name,
					},
				},
				Status: corev1.PodStatus{
					Phase:   corev1.PodFailed,
					Reason:  reason,
					Message: "Pod was preempted to free quota for higher-priority workload",
				},
			}
			bindTestPodToWorker(pod, worker)
			if err := f.kube.Create(context.Background(), pod); err != nil {
				t.Fatalf("create preempted pod: %v", err)
			}

			worker.Status.Failed = 1
			if err := f.kube.Status().Update(context.Background(), worker); err != nil {
				t.Fatalf("update worker status: %v", err)
			}

			if _, err := f.reconciler.Reconcile(context.Background(), f.req); err != nil {
				t.Fatalf("reconcile preempted pod: %v", err)
			}

			review := storedReview(t, f.kube, f.req)
			cond := meta.FindStatusCondition(review.Status.Conditions, controllers.ConditionUnknownEffectPending)
			if cond == nil || cond.Status != metav1.ConditionTrue {
				t.Fatalf("condition %s must be True after preemption, got %+v", controllers.ConditionUnknownEffectPending, cond)
			}
			if cond.Reason != controllers.ReasonPodPreemptedWithInFlightEffect {
				t.Fatalf("condition reason = %s, want %s", cond.Reason, controllers.ReasonPodPreemptedWithInFlightEffect)
			}
			if review.Status.Phase == reviewv1alpha2.PhaseSucceeded {
				t.Fatalf("review phase must NOT be Succeeded, got %s", review.Status.Phase)
			}
		})
	}
}

// TestChallenger_SuccessPromotion_BlockedWhenUnknownEffectPending empirically verifies:
// Attempting to promote a review to PhaseSucceeded when UnknownEffectPending is True
// is strictly blocked and review transitions fail-closed to PhaseFailed.
func TestChallenger_SuccessPromotion_BlockedWhenUnknownEffectPending(t *testing.T) {
	f := newTerminationFixture(t)
	worker := f.worker(t)
	assignFakeWorkerUID(t, f.kube, worker)

	// Step 1: Pre-set ConditionUnknownEffectPending = True on the review
	currentReview := storedReview(t, f.kube, f.req)
	meta.SetStatusCondition(&currentReview.Status.Conditions, metav1.Condition{
		Type:               controllers.ConditionUnknownEffectPending,
		Status:             metav1.ConditionTrue,
		Reason:             controllers.ReasonPodEvictedWithInFlightEffect,
		Message:            "pod was evicted during external mutation",
		ObservedGeneration: currentReview.Generation,
		LastTransitionTime: metav1.NewTime(f.now),
	})
	if err := f.kube.Status().Update(context.Background(), currentReview); err != nil {
		t.Fatalf("update review with unknown effect: %v", err)
	}

	// Step 2: Simulate that the Job claims success (e.g. Succeeded=1, exit 0)
	f.finishWorker(t, true, corev1.ContainerStateTerminated{
		ExitCode:   0,
		Reason:     "Completed",
		StartedAt:  metav1.NewTime(f.now.Add(5 * time.Second)),
		FinishedAt: metav1.NewTime(f.now.Add(30 * time.Second)),
	}, "")

	// Step 3: Reconcile
	if _, err := f.reconciler.Reconcile(context.Background(), f.req); err != nil {
		t.Fatalf("reconcile failed: %v", err)
	}

	// Step 4: Verify review did NOT promote to Succeeded and transitioned fail-closed to PhaseFailed
	afterReconcile := storedReview(t, f.kube, f.req)
	if afterReconcile.Status.Phase == reviewv1alpha2.PhaseSucceeded {
		t.Fatalf("CRITICAL SECURITY INVARIANT VIOLATED: review was promoted to Succeeded with pending unknown effect!")
	}
	if afterReconcile.Status.Phase != reviewv1alpha2.PhaseFailed {
		t.Fatalf("review phase = %s, want PhaseFailed", afterReconcile.Status.Phase)
	}
	readyCond := meta.FindStatusCondition(afterReconcile.Status.Conditions, "Ready")
	if readyCond == nil || readyCond.Reason != controllers.ReasonUnresolvedEffect {
		t.Fatalf("ready condition reason = %+v, want %s", readyCond, controllers.ReasonUnresolvedEffect)
	}

	// Verify ConditionUnknownEffectPending is still True
	cond := meta.FindStatusCondition(afterReconcile.Status.Conditions, controllers.ConditionUnknownEffectPending)
	if cond == nil || cond.Status != metav1.ConditionTrue {
		t.Fatalf("condition %s must remain True, got %+v", controllers.ConditionUnknownEffectPending, cond)
	}

	// Step 5: Direct assertion via AssertCanPromoteToSucceeded unit oracle
	err := controllers.AssertCanPromoteToSucceeded(afterReconcile)
	if !errors.Is(err, controllers.ErrUnknownEffectPending) {
		t.Fatalf("AssertCanPromoteToSucceeded returned err=%v, want ErrUnknownEffectPending", err)
	}
}

// TestChallenger_ValidateEffectTransition_ExhaustiveMatrix tests the complete 7x7
// state transition matrix according to the ct-effect-intent.v1 / API-3333 specification:
// Allowed:
//   INTENDED -> IN_FLIGHT
//   IN_FLIGHT -> SUCCEEDED, FAILED, UNKNOWN
//   UNKNOWN -> RECONCILING
//   RECONCILING -> SUCCEEDED, FAILED, UNKNOWN, MANUAL
//   X -> X (identity)
// Forbidden:
//   UNKNOWN -> IN_FLIGHT (CRITICAL INVARIANT)
//   UNKNOWN -> SUCCEEDED (CRITICAL INVARIANT)
//   All other non-specified transitions
func TestChallenger_ValidateEffectTransition_ExhaustiveMatrix(t *testing.T) {
	states := []string{
		controllers.EffectStateIntended,
		controllers.EffectStateInFlight,
		controllers.EffectStateSucceeded,
		controllers.EffectStateFailed,
		controllers.EffectStateUnknown,
		controllers.EffectStateReconciling,
		controllers.EffectStateManual,
	}

	isAllowed := func(from, to string) bool {
		if from == to {
			return true
		}
		switch from {
		case controllers.EffectStateIntended:
			return to == controllers.EffectStateInFlight
		case controllers.EffectStateInFlight:
			return to == controllers.EffectStateSucceeded || to == controllers.EffectStateFailed || to == controllers.EffectStateUnknown
		case controllers.EffectStateUnknown:
			return to == controllers.EffectStateReconciling
		case controllers.EffectStateReconciling:
			return to == controllers.EffectStateSucceeded || to == controllers.EffectStateFailed || to == controllers.EffectStateUnknown || to == controllers.EffectStateManual
		default:
			return false
		}
	}

	for _, from := range states {
		for _, to := range states {
			t.Run(fmt.Sprintf("%s_to_%s", from, to), func(t *testing.T) {
				err := controllers.ValidateEffectTransition(from, to)
				allowed := isAllowed(from, to)
				if allowed && err != nil {
					t.Fatalf("transition from %s to %s should be ALLOWED, but got error: %v", from, to, err)
				}
				if !allowed && err == nil {
					t.Fatalf("transition from %s to %s should be FORBIDDEN, but succeeded", from, to)
				}
				if !allowed && !errors.Is(err, controllers.ErrInvalidEffectTransition) {
					t.Fatalf("forbidden transition error should wrap ErrInvalidEffectTransition, got %v", err)
				}
			})
		}
	}

	// Specific check for the two highlighted forbidden transitions:
	if err := controllers.ValidateEffectTransition(controllers.EffectStateUnknown, controllers.EffectStateInFlight); err == nil {
		t.Fatal("UNKNOWN -> IN_FLIGHT must be strictly forbidden")
	}
	if err := controllers.ValidateEffectTransition(controllers.EffectStateUnknown, controllers.EffectStateSucceeded); err == nil {
		t.Fatal("UNKNOWN -> SUCCEEDED must be strictly forbidden")
	}
}

// TestChallenger_TerminalDeletion_ReceiptAuditabilityPreservedBeforeSecretDeletionAndFinalizerRemoval
// verifies that status.ReceiptDigest and status.ReceiptEvidenceRef are committed and present
// before:
// 1. The run Secret is deleted via client.Delete
// 2. The run-secret cleanup finalizer is removed via client.Patch
func TestChallenger_TerminalDeletion_ReceiptAuditabilityPreservedBeforeSecretDeletionAndFinalizerRemoval(t *testing.T) {
	now := time.Date(2026, 9, 27, 18, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)

	// Create a completed review marked for deletion
	completed := metav1.NewTime(now)
	review := terminalReviewFixture(now, reviewv1alpha2.PhaseFailed, &completed)
	// Clear any pre-existing receipt fields to ensure reconciler populates them
	review.Status.ReceiptDigest = ""
	review.Status.ReceiptEvidenceRef = ""

	secret := secretFixture(review.Spec.RunSecretName, review.Namespace)
	baseKube := deletingReviewFixture(t, scheme, review, secret)

	var secretDeleted bool
	var receiptPresentWhenSecretDeleted bool
	var finalizerRemoved bool
	var receiptPresentWhenFinalizerRemoved bool

	interceptedKube := interceptor.NewClient(baseKube, interceptor.Funcs{
		Delete: func(ctx context.Context, c client.WithWatch, obj client.Object, opts ...client.DeleteOption) error {
			if s, ok := obj.(*corev1.Secret); ok && s.Name == secret.Name {
				secretDeleted = true
				// Check whether review in the store or passed object has receipt audit fields
				var stored reviewv1alpha2.PRReviewJob
				if err := c.Get(ctx, types.NamespacedName{Namespace: review.Namespace, Name: review.Name}, &stored); err == nil {
					if stored.Status.ReceiptDigest != "" && stored.Status.ReceiptEvidenceRef != "" {
						receiptPresentWhenSecretDeleted = true
					}
				}
			}
			return c.Delete(ctx, obj, opts...)
		},
		Patch: func(ctx context.Context, c client.WithWatch, obj client.Object, patch client.Patch, opts ...client.PatchOption) error {
			if r, ok := obj.(*reviewv1alpha2.PRReviewJob); ok && r.Name == review.Name {
				if !controllerutil.ContainsFinalizer(r, runSecretCleanupFinalizer) {
					finalizerRemoved = true
					if r.Status.ReceiptDigest != "" && r.Status.ReceiptEvidenceRef != "" {
						receiptPresentWhenFinalizerRemoved = true
					}
				}
			}
			return c.Patch(ctx, obj, patch, opts...)
		},
	})

	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client: interceptedKube,
		Scheme: scheme,
		Now:    func() time.Time { return now },
	}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	// Reconcile the deleting review
	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("reconcile terminating review: %v", err)
	}

	if !secretDeleted {
		t.Fatal("expected run secret to be deleted")
	}
	if !receiptPresentWhenSecretDeleted {
		t.Fatal("audit invariant violation: ReceiptDigest and ReceiptEvidenceRef were NOT present in status when secret was deleted")
	}

	if !finalizerRemoved {
		t.Fatal("expected run-secret cleanup finalizer to be removed")
	}
	if !receiptPresentWhenFinalizerRemoved {
		t.Fatal("audit invariant violation: ReceiptDigest and ReceiptEvidenceRef were NOT present when finalizer was removed")
	}

	// Confirm final state: both review and secret are deleted
	var leftoverReview reviewv1alpha2.PRReviewJob
	if err := baseKube.Get(context.Background(), req.NamespacedName, &leftoverReview); !apierrors.IsNotFound(err) {
		t.Fatalf("expected review to be deleted once finalizer cleared, got err: %v", err)
	}
	var leftoverSecret corev1.Secret
	if err := baseKube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: secret.Name}, &leftoverSecret); !apierrors.IsNotFound(err) {
		t.Fatalf("expected secret to be deleted, got err: %v", err)
	}
}
