/*
Copyright 2026 Exampleorg.

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
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	reviewv1alpha2 "github.com/calltelemetry/ct-review-bot/k8s-operator/api/v1alpha2"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/controllers"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/job"
)

// TestWorkerEvictionPreservesUnknownEffectState verifies that node-level pod eviction
// (such as memory pressure) surfaces UnknownEffectPending = True with Reason PodEvictedWithInFlightEffect.
func TestWorkerEvictionPreservesUnknownEffectState(t *testing.T) {
	f := newTerminationFixture(t)
	worker := f.worker(t)
	assignFakeWorkerUID(t, f.kube, worker)

	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      worker.Name + "-evict-oom",
			Namespace: f.review.Namespace,
			Labels: map[string]string{
				"batch.kubernetes.io/job-name": worker.Name,
			},
		},
		Status: corev1.PodStatus{
			Phase:   corev1.PodFailed,
			Reason:  "Evicted",
			Message: "The node was low on resource: memory. Container reviewer-worker was using 1100Mi.",
		},
	}
	bindTestPodToWorker(pod, worker)
	if err := f.kube.Create(context.Background(), pod); err != nil {
		t.Fatalf("create evicted pod: %v", err)
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
		t.Fatalf("update worker status: %v", err)
	}

	if _, err := f.reconciler.Reconcile(context.Background(), f.req); err != nil {
		t.Fatalf("reconcile evicted worker: %v", err)
	}

	review := storedReview(t, f.kube, f.req)
	cond := meta.FindStatusCondition(review.Status.Conditions, controllers.ConditionUnknownEffectPending)
	if cond == nil {
		t.Fatalf("condition %s is missing after pod eviction", controllers.ConditionUnknownEffectPending)
	}
	if cond.Status != metav1.ConditionTrue {
		t.Fatalf("condition status = %s, want True", cond.Status)
	}
	if cond.Reason != controllers.ReasonPodEvictedWithInFlightEffect {
		t.Fatalf("condition reason = %s, want %s", cond.Reason, controllers.ReasonPodEvictedWithInFlightEffect)
	}
	if review.Status.Phase == reviewv1alpha2.PhaseSucceeded {
		t.Fatalf("phase must not be Succeeded, got %s", review.Status.Phase)
	}
}

// TestWorkerPreemptionPreservesUnknownEffectState verifies that scheduler preemption
// surfaces UnknownEffectPending = True with Reason PodPreemptedWithInFlightEffect.
func TestWorkerPreemptionPreservesUnknownEffectState(t *testing.T) {
	f := newTerminationFixture(t)
	worker := f.worker(t)
	assignFakeWorkerUID(t, f.kube, worker)

	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      worker.Name + "-preempted",
			Namespace: f.review.Namespace,
			Labels: map[string]string{
				"batch.kubernetes.io/job-name": worker.Name,
			},
		},
		Status: corev1.PodStatus{
			Phase:   corev1.PodFailed,
			Reason:  "Preempting",
			Message: "Pod was preempted by scheduler to accommodate high-priority pod system-critical-0",
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
		t.Fatalf("reconcile preempted worker: %v", err)
	}

	review := storedReview(t, f.kube, f.req)
	cond := meta.FindStatusCondition(review.Status.Conditions, controllers.ConditionUnknownEffectPending)
	if cond == nil || cond.Status != metav1.ConditionTrue {
		t.Fatalf("condition %s must be True after preemption, got %+v", controllers.ConditionUnknownEffectPending, cond)
	}
	if cond.Reason != controllers.ReasonPodPreemptedWithInFlightEffect {
		t.Fatalf("condition reason = %s, want %s", cond.Reason, controllers.ReasonPodPreemptedWithInFlightEffect)
	}
}

// TestWorkerTimeoutPreservesUnknownEffectState verifies that activeDeadlineSeconds expiration
// surfaces UnknownEffectPending = True with Reason PodTimeoutWithInFlightEffect.
func TestWorkerTimeoutPreservesUnknownEffectState(t *testing.T) {
	f := newTerminationFixture(t)
	worker := f.worker(t)
	assignFakeWorkerUID(t, f.kube, worker)

	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      worker.Name + "-timeout",
			Namespace: f.review.Namespace,
			Labels: map[string]string{
				"batch.kubernetes.io/job-name": worker.Name,
			},
		},
		Status: corev1.PodStatus{
			Phase:   corev1.PodFailed,
			Reason:  "DeadlineExceeded",
			Message: "Pod was active on the node longer than the specified deadline",
		},
	}
	bindTestPodToWorker(pod, worker)
	if err := f.kube.Create(context.Background(), pod); err != nil {
		t.Fatalf("create timeout pod: %v", err)
	}

	worker.Status.Failed = 1
	if err := f.kube.Status().Update(context.Background(), worker); err != nil {
		t.Fatalf("update worker status: %v", err)
	}

	if _, err := f.reconciler.Reconcile(context.Background(), f.req); err != nil {
		t.Fatalf("reconcile timeout worker: %v", err)
	}

	review := storedReview(t, f.kube, f.req)
	cond := meta.FindStatusCondition(review.Status.Conditions, controllers.ConditionUnknownEffectPending)
	if cond == nil || cond.Status != metav1.ConditionTrue {
		t.Fatalf("condition %s must be True after deadline exceeded, got %+v", controllers.ConditionUnknownEffectPending, cond)
	}
	if cond.Reason != controllers.ReasonPodTimeoutWithInFlightEffect {
		t.Fatalf("condition reason = %s, want %s", cond.Reason, controllers.ReasonPodTimeoutWithInFlightEffect)
	}
}

// TestWorkerOOMKilledPreservesUnknownEffectState verifies that OOMKilled worker container
// surfaces UnknownEffectPending = True with Reason PodFailedWithInFlightEffect.
func TestWorkerOOMKilledPreservesUnknownEffectState(t *testing.T) {
	f := newTerminationFixture(t)
	worker := f.finishWorker(t, false, corev1.ContainerStateTerminated{
		ExitCode:   137,
		Reason:     "OOMKilled",
		StartedAt:  metav1.NewTime(f.now.Add(5 * time.Second)),
		FinishedAt: metav1.NewTime(f.now.Add(55 * time.Second)),
		Message:    "Process out of memory",
	}, "")

	if _, err := f.reconciler.Reconcile(context.Background(), f.req); err != nil {
		t.Fatalf("reconcile OOM worker: %v", err)
	}

	review := storedReview(t, f.kube, f.req)
	cond := meta.FindStatusCondition(review.Status.Conditions, controllers.ConditionUnknownEffectPending)
	if cond == nil || cond.Status != metav1.ConditionTrue {
		t.Fatalf("condition %s must be True after OOMKilled, got %+v", controllers.ConditionUnknownEffectPending, cond)
	}
	if cond.Reason != controllers.ReasonPodFailedWithInFlightEffect {
		t.Fatalf("condition reason = %s, want %s", cond.Reason, controllers.ReasonPodFailedWithInFlightEffect)
	}
	if !strings.Contains(cond.Message, "OOMKilled") {
		t.Fatalf("condition message = %q, want mention of OOMKilled", cond.Message)
	}
	if worker.Status.Failed != 1 {
		t.Fatalf("worker failed status = %d, want 1", worker.Status.Failed)
	}
}

// TestWorkerSuccessCannotPromoteUnknownEffect proves that even if worker.Status.Succeeded > 0,
// an existing UnknownEffectPending = True condition strictly blocks promotion to PhaseSucceeded.
func TestWorkerSuccessCannotPromoteUnknownEffect(t *testing.T) {
	f := newTerminationFixture(t)
	worker := f.worker(t)
	assignFakeWorkerUID(t, f.kube, worker)

	// Pre-seed condition UnknownEffectPending = True on the freshest review
	currentReview := storedReview(t, f.kube, f.req)
	meta.SetStatusCondition(&currentReview.Status.Conditions, metav1.Condition{
		Type:               controllers.ConditionUnknownEffectPending,
		Status:             metav1.ConditionTrue,
		Reason:             controllers.ReasonUnknownEffectPreserved,
		Message:            "prior ambiguous effect in flight",
		ObservedGeneration: currentReview.Generation,
		LastTransitionTime: metav1.NewTime(f.now),
	})
	if err := f.kube.Status().Update(context.Background(), currentReview); err != nil {
		t.Fatalf("update review with unknown effect: %v", err)
	}

	// Worker reports clean exit 0
	f.finishWorker(t, true, corev1.ContainerStateTerminated{
		ExitCode:   0,
		Reason:     "Completed",
		StartedAt:  metav1.NewTime(f.now.Add(5 * time.Second)),
		FinishedAt: metav1.NewTime(f.now.Add(40 * time.Second)),
	}, "")

	if _, err := f.reconciler.Reconcile(context.Background(), f.req); err != nil {
		t.Fatalf("reconcile completed worker with unknown effect: %v", err)
	}

	review := storedReview(t, f.kube, f.req)
	if review.Status.Phase == reviewv1alpha2.PhaseSucceeded {
		t.Fatalf("CRITICAL SAFETY VIOLATION: review was promoted to Succeeded while %s is True!",
			controllers.ConditionUnknownEffectPending)
	}
	if review.Status.Phase != reviewv1alpha2.PhaseFailed {
		t.Fatalf("review phase = %s, want Failed due to unresolved effect", review.Status.Phase)
	}
	cond := meta.FindStatusCondition(review.Status.Conditions, controllers.ConditionUnknownEffectPending)
	if cond == nil || cond.Status != metav1.ConditionTrue {
		t.Fatalf("condition %s must remain True", controllers.ConditionUnknownEffectPending)
	}
}

// TestForbiddenTransitionsFromUnknownAreRejected tests the state machine transition guards.
func TestForbiddenTransitionsFromUnknownAreRejected(t *testing.T) {
	// Forbidden: UNKNOWN -> EXECUTING (IN_FLIGHT)
	if err := controllers.ValidateEffectTransition(controllers.EffectStateUnknown, controllers.EffectStateInFlight); err == nil {
		t.Fatal("transition UNKNOWN -> IN_FLIGHT must be rejected")
	}

	// Forbidden: UNKNOWN -> SUCCEEDED
	if err := controllers.ValidateEffectTransition(controllers.EffectStateUnknown, controllers.EffectStateSucceeded); err == nil {
		t.Fatal("transition UNKNOWN -> SUCCEEDED must be rejected")
	}

	// Forbidden: INTENDED -> SUCCEEDED
	if err := controllers.ValidateEffectTransition(controllers.EffectStateIntended, controllers.EffectStateSucceeded); err == nil {
		t.Fatal("transition INTENDED -> SUCCEEDED must be rejected")
	}

	// Allowed: UNKNOWN -> RECONCILING
	if err := controllers.ValidateEffectTransition(controllers.EffectStateUnknown, controllers.EffectStateReconciling); err != nil {
		t.Fatalf("transition UNKNOWN -> RECONCILING must be allowed, got: %v", err)
	}

	// Allowed: RECONCILING -> SUCCEEDED
	if err := controllers.ValidateEffectTransition(controllers.EffectStateReconciling, controllers.EffectStateSucceeded); err != nil {
		t.Fatalf("transition RECONCILING -> SUCCEEDED must be allowed, got: %v", err)
	}

	// Allowed: RECONCILING -> MANUAL
	if err := controllers.ValidateEffectTransition(controllers.EffectStateReconciling, controllers.EffectStateManual); err != nil {
		t.Fatalf("transition RECONCILING -> MANUAL must be allowed, got: %v", err)
	}

	// Allowed: RECONCILING -> FAILED
	if err := controllers.ValidateEffectTransition(controllers.EffectStateReconciling, controllers.EffectStateFailed); err != nil {
		t.Fatalf("transition RECONCILING -> FAILED must be allowed, got: %v", err)
	}

	// Allowed: INTENDED -> IN_FLIGHT
	if err := controllers.ValidateEffectTransition(controllers.EffectStateIntended, controllers.EffectStateInFlight); err != nil {
		t.Fatalf("transition INTENDED -> IN_FLIGHT must be allowed, got: %v", err)
	}

	// Allowed: IN_FLIGHT -> SUCCEEDED
	if err := controllers.ValidateEffectTransition(controllers.EffectStateInFlight, controllers.EffectStateSucceeded); err != nil {
		t.Fatalf("transition IN_FLIGHT -> SUCCEEDED must be allowed, got: %v", err)
	}

	// Allowed: IN_FLIGHT -> FAILED
	if err := controllers.ValidateEffectTransition(controllers.EffectStateInFlight, controllers.EffectStateFailed); err != nil {
		t.Fatalf("transition IN_FLIGHT -> FAILED must be allowed, got: %v", err)
	}

	// Allowed: IN_FLIGHT -> UNKNOWN
	if err := controllers.ValidateEffectTransition(controllers.EffectStateInFlight, controllers.EffectStateUnknown); err != nil {
		t.Fatalf("transition IN_FLIGHT -> UNKNOWN must be allowed, got: %v", err)
	}
}

// TestReceiptAuditabilityPersistsBeforeTerminalFinalization verifies that ReceiptDigest
// and ReceiptEvidenceRef are persisted to CR status before finalizers are released.
func TestReceiptAuditabilityPersistsBeforeTerminalFinalization(t *testing.T) {
	f := newTerminationFixture(t)
	f.finishWorker(t, true, corev1.ContainerStateTerminated{
		ExitCode:   0,
		Reason:     "Completed",
		StartedAt:  metav1.NewTime(f.now.Add(5 * time.Second)),
		FinishedAt: metav1.NewTime(f.now.Add(40 * time.Second)),
	}, "")

	// Before reconcile, audit fields are empty
	initial := storedReview(t, f.kube, f.req)
	if initial.Status.ReceiptDigest != "" || initial.Status.ReceiptEvidenceRef != "" {
		t.Fatalf("initial receipt audit fields must be empty, got %+v", initial.Status)
	}

	if _, err := f.reconciler.Reconcile(context.Background(), f.req); err != nil {
		t.Fatalf("reconcile terminal worker: %v", err)
	}

	// After reconcile, audit fields must be populated
	committed := storedReview(t, f.kube, f.req)
	if committed.Status.ReceiptDigest == "" || !strings.HasPrefix(committed.Status.ReceiptDigest, "sha256:") {
		t.Fatalf("status.ReceiptDigest = %q, want valid sha256 prefix", committed.Status.ReceiptDigest)
	}
	if committed.Status.ReceiptEvidenceRef == "" || !strings.HasPrefix(committed.Status.ReceiptEvidenceRef, "audit://") {
		t.Fatalf("status.ReceiptEvidenceRef = %q, want audit URI", committed.Status.ReceiptEvidenceRef)
	}
}

// TestAssertCanPromoteToSucceededGuard verifies the promotion gate logic.
func TestAssertCanPromoteToSucceededGuard(t *testing.T) {
	review := &reviewv1alpha2.PRReviewJob{
		Status: reviewv1alpha2.PRReviewJobStatus{
			ReceiptDigest:      "sha256:1111222233334444555566667777888899990000aaaaabbbbbcccccdddddeeeee",
			ReceiptEvidenceRef: "audit://ct-review-system/run-1/receipt",
		},
	}

	// Valid review with no conditions and non-empty receipts
	if err := controllers.AssertCanPromoteToSucceeded(review); err != nil {
		t.Fatalf("expected promotion allowed, got %v", err)
	}

	// Pending unknown effect blocks promotion
	meta.SetStatusCondition(&review.Status.Conditions, metav1.Condition{
		Type:   controllers.ConditionUnknownEffectPending,
		Status: metav1.ConditionTrue,
		Reason: controllers.ReasonUnknownEffectPreserved,
	})
	if err := controllers.AssertCanPromoteToSucceeded(review); !errors.Is(err, controllers.ErrUnknownEffectPending) {
		t.Fatalf("expected ErrUnknownEffectPending, got %v", err)
	}

	// Remove condition, but missing ReceiptDigest blocks promotion
	meta.RemoveStatusCondition(&review.Status.Conditions, controllers.ConditionUnknownEffectPending)
	review.Status.ReceiptDigest = ""
	if err := controllers.AssertCanPromoteToSucceeded(review); !errors.Is(err, controllers.ErrMissingReceiptAudit) {
		t.Fatalf("expected ErrMissingReceiptAudit for missing digest, got %v", err)
	}

	// Restore ReceiptDigest, but missing ReceiptEvidenceRef blocks promotion
	review.Status.ReceiptDigest = "sha256:11112222"
	review.Status.ReceiptEvidenceRef = ""
	if err := controllers.AssertCanPromoteToSucceeded(review); !errors.Is(err, controllers.ErrMissingReceiptAudit) {
		t.Fatalf("expected ErrMissingReceiptAudit for missing evidence ref, got %v", err)
	}
}

// TestSuccessfulWorkerWithoutReceiptAnnotationsFailsClosed verifies that when a worker completes
// with exit 0 and JobComplete, but lacks receipt annotations, the controller never synthesizes
// fake receipt digests and fails closed to PhaseFailed with ReasonUnresolvedEffect.
func TestSuccessfulWorkerWithoutReceiptAnnotationsFailsClosed(t *testing.T) {
	f := newTerminationFixture(t)
	worker := f.worker(t)
	assignFakeWorkerUID(t, f.kube, worker)

	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      worker.Name + "-bare",
			Namespace: f.review.Namespace,
			Labels: map[string]string{
				"review-yeti.ai/run-id":        f.review.Spec.RunID,
				"batch.kubernetes.io/job-name": worker.Name,
			},
		},
		Spec: corev1.PodSpec{NodeName: "workers-memory-16gb-bare"},
		Status: corev1.PodStatus{
			Phase: corev1.PodSucceeded,
			ContainerStatuses: []corev1.ContainerStatus{{
				Name:  job.WorkerContainerName,
				State: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{ExitCode: 0, Reason: "Completed"}},
			}},
		},
	}
	bindTestPodToWorker(pod, worker)
	if err := f.kube.Create(context.Background(), pod); err != nil {
		t.Fatalf("create worker pod: %v", err)
	}

	worker.Status.Succeeded = 1
	worker.Status.Conditions = []batchv1.JobCondition{{
		Type: batchv1.JobComplete, Status: corev1.ConditionTrue, LastTransitionTime: metav1.NewTime(f.now),
	}}
	if err := f.kube.Status().Update(context.Background(), worker); err != nil {
		t.Fatalf("mark worker succeeded: %v", err)
	}

	if _, err := f.reconciler.Reconcile(context.Background(), f.req); err != nil {
		t.Fatalf("reconcile bare successful worker: %v", err)
	}

	review := storedReview(t, f.kube, f.req)
	if review.Status.Phase != reviewv1alpha2.PhaseFailed {
		t.Fatalf("phase = %s, want PhaseFailed (missing receipt audit must fail closed)", review.Status.Phase)
	}
	if review.Status.ReceiptDigest != "" {
		t.Fatalf("receiptDigest = %q, want empty (must never synthesize fake receipt for successful worker)", review.Status.ReceiptDigest)
	}
	ready := meta.FindStatusCondition(review.Status.Conditions, "Ready")
	if ready == nil || ready.Reason != controllers.ReasonUnresolvedEffect {
		t.Fatalf("ready condition = %+v, want ReasonUnresolvedEffect", ready)
	}
}

