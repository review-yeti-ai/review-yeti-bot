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

// REL-896: the v1alpha2 operator previously never deleted a terminal
// PRReviewJob, so a production sidecar/CronJob had to `kubectl delete` them
// out-of-band -- and that sidecar skipped phase Expired, leaking those
// forever. These tests exercise the native terminal-resource deletion added
// to reconcileTerminalWorkspace/reconcileTerminalDeletion, and the paired
// worker-Job TTL fail-safe shape (build with the failed TTL, patch down to
// the success TTL once Succeeded is observed).
package controllers_test

import (
	"context"
	"testing"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	reviewv1alpha2 "github.com/calltelemetry/ct-review-bot/k8s-operator/api/v1alpha2"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/controllers"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/job"
)

// terminalReviewFixture returns a review already in the given terminal phase,
// with RunnerMode "prebaked" so reconcileTerminalWorkspace has no PVC to
// reclaim and falls straight through to reconcileTerminalDeletion once no
// active Pod/Lease is observed (there are none in these fixtures).
func terminalReviewFixture(now time.Time, phase reviewv1alpha2.PRReviewJobPhase, completionTime *metav1.Time) *reviewv1alpha2.PRReviewJob {
	review := v1alpha2Review(now)
	review.Spec.RunnerMode = "prebaked"
	review.Status.Phase = phase
	review.Status.CompletionTime = completionTime
	return review
}

func TestPRReviewJobV1Alpha2ReconcilerRequeuesTerminalReviewWithinRetentionAndDoesNotDeleteEarly(t *testing.T) {
	t.Setenv("REVIEW_YETI_TERMINAL_RETENTION_SECONDS", "120")
	now := time.Date(2026, 9, 17, 12, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	completed := metav1.NewTime(now)
	review := terminalReviewFixture(now, reviewv1alpha2.PhaseSucceeded, &completed)
	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(review).WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: kube, Scheme: scheme, Now: func() time.Time { return now }}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	res, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("reconcile terminal review inside retention window: %v", err)
	}
	if res.RequeueAfter != 120*time.Second {
		t.Fatalf("RequeueAfter = %s, want the full 120s retention window", res.RequeueAfter)
	}
	if err := kube.Get(context.Background(), req.NamespacedName, &reviewv1alpha2.PRReviewJob{}); err != nil {
		t.Fatalf("terminal review must not be deleted before its retention window elapses: %v", err)
	}
}

func TestPRReviewJobV1Alpha2ReconcilerDeletesTerminalReviewAfterRetentionForEveryTerminalPhase(t *testing.T) {
	for _, phase := range []reviewv1alpha2.PRReviewJobPhase{
		reviewv1alpha2.PhaseSucceeded,
		reviewv1alpha2.PhaseFailed,
		reviewv1alpha2.PhaseExpired,
	} {
		t.Run(string(phase), func(t *testing.T) {
			t.Setenv("REVIEW_YETI_TERMINAL_RETENTION_SECONDS", "60")
			now := time.Date(2026, 9, 17, 12, 0, 0, 0, time.UTC)
			scheme := v1alpha2Scheme(t)
			// Became terminal 61s ago: one second past the 60s retention window.
			completed := metav1.NewTime(now.Add(-61 * time.Second))
			review := terminalReviewFixture(now.Add(-61*time.Second), phase, &completed)
			kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(review).WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
			reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: kube, Scheme: scheme, Now: func() time.Time { return now }}
			req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

			if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
				t.Fatalf("reconcile terminal review past retention: %v", err)
			}
			// The first reconcile both attaches the REL-896 run-secret cleanup
			// finalizer (spec.runSecretName is set in this fixture) and issues the
			// retention Delete in the same pass; against a finalized object the
			// fake client (like a real API server) only stamps
			// metadata.deletionTimestamp instead of removing it. A second
			// reconcile observes that deletionTimestamp, deletes the (absent,
			// tolerated-NotFound) run Secret, and removes the finalizer -- which is
			// what actually lets the object disappear.
			if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
				t.Fatalf("reconcile terminal review to process its run-secret cleanup finalizer: %v", err)
			}
			if err := kube.Get(context.Background(), req.NamespacedName, &reviewv1alpha2.PRReviewJob{}); !apierrors.IsNotFound(err) {
				t.Fatalf("terminal review past its retention window must be deleted, got err=%v", err)
			}
		})
	}
}

func TestPRReviewJobV1Alpha2ReconcilerDeleteIsIdempotentAndTolerantOfNotFound(t *testing.T) {
	t.Setenv("REVIEW_YETI_TERMINAL_RETENTION_SECONDS", "60")
	now := time.Date(2026, 9, 17, 12, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	completed := metav1.NewTime(now.Add(-61 * time.Second))
	review := terminalReviewFixture(now.Add(-61*time.Second), reviewv1alpha2.PhaseSucceeded, &completed)
	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(review).WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: kube, Scheme: scheme, Now: func() time.Time { return now }}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("first reconcile: attach run-secret finalizer and issue the retention Delete: %v", err)
	}
	if err := kube.Get(context.Background(), req.NamespacedName, &reviewv1alpha2.PRReviewJob{}); err != nil {
		t.Fatalf("review with a run-secret cleanup finalizer must survive the first Delete call (deletionTimestamp only), got err=%v", err)
	}
	// Second reconcile observes deletionTimestamp, tolerates the absent (never
	// created in this fixture) run Secret as NotFound, and removes the
	// finalizer -- which is what actually lets the review disappear.
	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("second reconcile: process the run-secret cleanup finalizer: %v", err)
	}
	if err := kube.Get(context.Background(), req.NamespacedName, &reviewv1alpha2.PRReviewJob{}); !apierrors.IsNotFound(err) {
		t.Fatalf("review must be fully deleted once its run-secret cleanup finalizer clears, got err=%v", err)
	}
	// The review is now already gone; Reconcile's own NotFound handling
	// (releaseOrphanedWorkerObservation) takes over from here, but re-running
	// against the exact same request must still not error.
	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("repeated reconcile of an already-deleted terminal review: %v", err)
	}
}

func TestPRReviewJobV1Alpha2ReconcilerExpiredPhaseGetsCompletionTime(t *testing.T) {
	now := time.Date(2026, 9, 17, 12, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	// A valid 15-minute admission window, entirely in the past relative to
	// `now`, so validateProjectionWindow accepts it but reconcileElapsedDeadline
	// still finds the deadline already elapsed.
	review := v1alpha2Review(now.Add(-20 * time.Minute))
	review.Spec.TerminalDeadline = metav1.NewTime(now.Add(-5 * time.Minute))
	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(review).WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: kube, Scheme: scheme, Now: func() time.Time { return now }}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("expire review with no worker ever created: %v", err)
	}
	var expired reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), req.NamespacedName, &expired); err != nil {
		t.Fatal(err)
	}
	if expired.Status.Phase != reviewv1alpha2.PhaseExpired {
		t.Fatalf("phase = %s, want Expired", expired.Status.Phase)
	}
	if expired.Status.CompletionTime == nil || !expired.Status.CompletionTime.Time.Equal(now) {
		t.Fatalf("completionTime = %v, want %v (set so terminal deletion never needs the creationTimestamp fallback for a review expired after this change)", expired.Status.CompletionTime, now)
	}
}

func TestPRReviewJobV1Alpha2ReconcilerUsesCreationTimestampFallbackWhenCompletionTimeIsAbsent(t *testing.T) {
	t.Setenv("REVIEW_YETI_TERMINAL_RETENTION_SECONDS", "60")
	now := time.Date(2026, 9, 17, 12, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	// A legacy resource persisted by an operator build older than this change:
	// terminal but status.completionTime was never populated.
	review := terminalReviewFixture(now.Add(-61*time.Second), reviewv1alpha2.PhaseFailed, nil)
	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(review).WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: kube, Scheme: scheme, Now: func() time.Time { return now }}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("reconcile legacy terminal review without completionTime: %v", err)
	}
	// The run-secret cleanup finalizer (attached on this same first reconcile,
	// since the fixture carries a valid spec.runSecretName) means the retention
	// Delete only marks deletionTimestamp; a second reconcile clears the
	// finalizer and lets the object actually disappear.
	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("reconcile legacy terminal review to process its run-secret cleanup finalizer: %v", err)
	}
	if err := kube.Get(context.Background(), req.NamespacedName, &reviewv1alpha2.PRReviewJob{}); !apierrors.IsNotFound(err) {
		t.Fatalf("legacy terminal review whose creationTimestamp is past retention must be deleted via the fallback, got err=%v", err)
	}
}

func TestPRReviewJobV1Alpha2ReconcilerCreationTimestampFallbackRetainsRecentLegacyReview(t *testing.T) {
	t.Setenv("REVIEW_YETI_TERMINAL_RETENTION_SECONDS", "3600")
	now := time.Date(2026, 9, 17, 12, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	// Only just went terminal; creationTimestamp is recent, no completionTime.
	review := terminalReviewFixture(now, reviewv1alpha2.PhaseFailed, nil)
	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(review).WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: kube, Scheme: scheme, Now: func() time.Time { return now }}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	res, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("reconcile recent legacy terminal review: %v", err)
	}
	if res.RequeueAfter != 3600*time.Second {
		t.Fatalf("RequeueAfter = %s, want the full 3600s retention window measured from creationTimestamp", res.RequeueAfter)
	}
	if err := kube.Get(context.Background(), req.NamespacedName, &reviewv1alpha2.PRReviewJob{}); err != nil {
		t.Fatalf("recent legacy terminal review must not be deleted yet: %v", err)
	}
}

func pendingFailurePublicationReview(now time.Time, completed metav1.Time) *reviewv1alpha2.PRReviewJob {
	review := terminalReviewFixture(now, reviewv1alpha2.PhaseFailed, &completed)
	review.Spec.PublicationMode = job.PublicationModeAppGate
	meta.SetStatusCondition(&review.Status.Conditions, metav1.Condition{
		Type:               "FailurePublication",
		Status:             metav1.ConditionUnknown,
		Reason:             "DelegatedToTrustedService",
		Message:            "fail-closed publication delegated to the trusted dispatcher deadline reaper for exact-identity reconciliation with a fresh App token",
		ObservedGeneration: review.Generation,
		LastTransitionTime: completed,
	})
	return review
}

func TestPRReviewJobV1Alpha2ReconcilerDoesNotDeleteAtRetentionWhilePublicationIsPending(t *testing.T) {
	t.Setenv("REVIEW_YETI_TERMINAL_RETENTION_SECONDS", "60")
	t.Setenv("REVIEW_YETI_TERMINAL_MAX_RETENTION_SECONDS", "600")
	now := time.Date(2026, 9, 17, 12, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	// Retention (60s) has long elapsed, but the hard cap (600s) has not.
	completed := metav1.NewTime(now.Add(-300 * time.Second))
	review := pendingFailurePublicationReview(now.Add(-300*time.Second), completed)
	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(review).WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: kube, Scheme: scheme, Now: func() time.Time { return now }}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	res, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("reconcile past-retention pending-publication review: %v", err)
	}
	if err := kube.Get(context.Background(), req.NamespacedName, &reviewv1alpha2.PRReviewJob{}); err != nil {
		t.Fatalf("review with a pending failure-publication delegation must survive its ordinary retention window: %v", err)
	}
	// completed + 600s hard cap - now(=completed+300s) = 300s remaining.
	if res.RequeueAfter != 300*time.Second {
		t.Fatalf("RequeueAfter = %s, want the 300s remaining until the hard cap", res.RequeueAfter)
	}
}

func TestPRReviewJobV1Alpha2ReconcilerDeletesAtHardCapDespitePendingPublication(t *testing.T) {
	t.Setenv("REVIEW_YETI_TERMINAL_RETENTION_SECONDS", "60")
	t.Setenv("REVIEW_YETI_TERMINAL_MAX_RETENTION_SECONDS", "600")
	now := time.Date(2026, 9, 17, 12, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	// One second past the hard cap; FailurePublication is still Unknown.
	completed := metav1.NewTime(now.Add(-601 * time.Second))
	review := pendingFailurePublicationReview(now.Add(-601*time.Second), completed)
	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(review).WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: kube, Scheme: scheme, Now: func() time.Time { return now }}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("reconcile hard-capped pending-publication review: %v", err)
	}
	// The run-secret cleanup finalizer (attached on this same first reconcile)
	// means the hard-cap Delete only marks deletionTimestamp; a second
	// reconcile clears the finalizer and lets the object actually disappear.
	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("reconcile hard-capped pending-publication review to process its run-secret cleanup finalizer: %v", err)
	}
	if err := kube.Get(context.Background(), req.NamespacedName, &reviewv1alpha2.PRReviewJob{}); !apierrors.IsNotFound(err) {
		t.Fatalf("review must be deleted once the hard cap elapses even with FailurePublication still Unknown, got err=%v", err)
	}
}

// TestPRReviewJobV1Alpha2ReconcilerDelegatedRequeueUsesHardCapWhenItIsSmaller
// is a review-finding regression test (REL-896 PR #828): reconcileTerminalDeletion's
// delegated branch requeues after min(time until the hard cap, time until
// ordinary retention), but no prior test exercised the branch where the hard
// cap is the smaller of the two. Here retention (3600s) is far larger than
// the hard cap (600s), and `now` is before both, so the minimum must be the
// hard cap.
func TestPRReviewJobV1Alpha2ReconcilerDelegatedRequeueUsesHardCapWhenItIsSmaller(t *testing.T) {
	t.Setenv("REVIEW_YETI_TERMINAL_RETENTION_SECONDS", "3600")
	t.Setenv("REVIEW_YETI_TERMINAL_MAX_RETENTION_SECONDS", "600")
	now := time.Date(2026, 9, 17, 12, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	// terminalAt == now: both the 3600s retention deadline and the 600s hard
	// cap are still entirely ahead of `now`.
	completed := metav1.NewTime(now)
	review := pendingFailurePublicationReview(now, completed)
	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(review).WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: kube, Scheme: scheme, Now: func() time.Time { return now }}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	res, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("reconcile delegated review with a smaller hard cap than retention: %v", err)
	}
	if res.RequeueAfter != 600*time.Second {
		t.Fatalf("RequeueAfter = %s, want the 600s hard cap (the smaller of the two windows)", res.RequeueAfter)
	}
	if err := kube.Get(context.Background(), req.NamespacedName, &reviewv1alpha2.PRReviewJob{}); err != nil {
		t.Fatalf("review must still exist while the smaller (hard cap) window has not elapsed: %v", err)
	}
}

// TestPRReviewJobV1Alpha2ReconcilerDelegatedRequeueUsesRetentionRemainderWhenItIsSmaller
// is the mirror regression test: retention (60s) is far smaller than the hard
// cap (86400s), and `now` is before retention, so the minimum must be the
// ordinary retention remainder, not the hard cap.
func TestPRReviewJobV1Alpha2ReconcilerDelegatedRequeueUsesRetentionRemainderWhenItIsSmaller(t *testing.T) {
	t.Setenv("REVIEW_YETI_TERMINAL_RETENTION_SECONDS", "60")
	t.Setenv("REVIEW_YETI_TERMINAL_MAX_RETENTION_SECONDS", "86400")
	now := time.Date(2026, 9, 17, 12, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	// terminalAt == now: both the 60s retention deadline and the 86400s hard
	// cap are still entirely ahead of `now`.
	completed := metav1.NewTime(now)
	review := pendingFailurePublicationReview(now, completed)
	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(review).WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: kube, Scheme: scheme, Now: func() time.Time { return now }}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	res, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("reconcile delegated review with a smaller retention than hard cap: %v", err)
	}
	if res.RequeueAfter != 60*time.Second {
		t.Fatalf("RequeueAfter = %s, want the 60s retention remainder (the smaller of the two windows)", res.RequeueAfter)
	}
	if err := kube.Get(context.Background(), req.NamespacedName, &reviewv1alpha2.PRReviewJob{}); err != nil {
		t.Fatalf("review must still exist while the smaller (retention) window has not elapsed: %v", err)
	}
}

// --- Task 2: worker Job TTL fail-safe shape ---

func workerJobLifecycleFixture(t *testing.T, now time.Time) (*fake.ClientBuilder, *reviewv1alpha2.PRReviewJob) {
	t.Helper()
	scheme := v1alpha2Scheme(t)
	review := v1alpha2Review(now)
	builder := fake.NewClientBuilder().WithScheme(scheme).WithObjects(review).WithStatusSubresource(&reviewv1alpha2.PRReviewJob{})
	return builder, review
}

func TestPRReviewJobV1Alpha2ReconcilerBuildsWorkerWithFailedTTLThenPatchesToSuccessOnSuccess(t *testing.T) {
	t.Setenv("REVIEW_YETI_WORKER_FAILED_TTL_AFTER_FINISHED", "456")
	t.Setenv("REVIEW_YETI_WORKER_TTL_AFTER_FINISHED", "123")
	now := time.Date(2026, 9, 17, 12, 0, 0, 0, time.UTC)
	builder, review := workerJobLifecycleFixture(t, now)
	kube := builder.Build()
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: kube, Scheme: v1alpha2Scheme(t), Now: func() time.Time { return now }}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("create worker: %v", err)
	}
	workerKey := types.NamespacedName{Namespace: review.Namespace, Name: review.Name + "-worker"}
	var worker batchv1.Job
	if err := kube.Get(context.Background(), workerKey, &worker); err != nil {
		t.Fatal(err)
	}
	if worker.Spec.TTLSecondsAfterFinished == nil || *worker.Spec.TTLSecondsAfterFinished != 456 {
		t.Fatalf("built worker TTL = %v, want 456 (the failed-TTL env)", worker.Spec.TTLSecondsAfterFinished)
	}

	worker.Status.Succeeded = 1
	if err := kube.Status().Update(context.Background(), &worker); err != nil {
		t.Fatalf("mark worker succeeded: %v", err)
	}
	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("observe worker success: %v", err)
	}
	var patched batchv1.Job
	if err := kube.Get(context.Background(), workerKey, &patched); err != nil {
		t.Fatal(err)
	}
	if patched.Spec.TTLSecondsAfterFinished == nil || *patched.Spec.TTLSecondsAfterFinished != 123 {
		t.Fatalf("worker TTL after success = %v, want 123 (patched down to the success-TTL env)", patched.Spec.TTLSecondsAfterFinished)
	}
	var updatedReview reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), req.NamespacedName, &updatedReview); err != nil {
		t.Fatal(err)
	}
	if updatedReview.Status.Phase != reviewv1alpha2.PhaseSucceeded {
		t.Fatalf("phase = %s, want Succeeded", updatedReview.Status.Phase)
	}
}

func TestPRReviewJobV1Alpha2ReconcilerLeavesFailedWorkerAtTheFailedTTL(t *testing.T) {
	t.Setenv("REVIEW_YETI_WORKER_FAILED_TTL_AFTER_FINISHED", "456")
	t.Setenv("REVIEW_YETI_WORKER_TTL_AFTER_FINISHED", "123")
	now := time.Date(2026, 9, 17, 12, 0, 0, 0, time.UTC)
	builder, review := workerJobLifecycleFixture(t, now)
	kube := builder.Build()
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: kube, Scheme: v1alpha2Scheme(t), Now: func() time.Time { return now }}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("create worker: %v", err)
	}
	workerKey := types.NamespacedName{Namespace: review.Namespace, Name: review.Name + "-worker"}
	var worker batchv1.Job
	if err := kube.Get(context.Background(), workerKey, &worker); err != nil {
		t.Fatal(err)
	}
	worker.Status.Failed = 1
	if err := kube.Status().Update(context.Background(), &worker); err != nil {
		t.Fatalf("mark worker failed: %v", err)
	}
	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("observe worker failure: %v", err)
	}
	var untouched batchv1.Job
	if err := kube.Get(context.Background(), workerKey, &untouched); err != nil {
		t.Fatal(err)
	}
	if untouched.Spec.TTLSecondsAfterFinished == nil || *untouched.Spec.TTLSecondsAfterFinished != 456 {
		t.Fatalf("worker TTL after failure = %v, want unchanged 456 (the failed-TTL it was built with)", untouched.Spec.TTLSecondsAfterFinished)
	}
	var updatedReview reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), req.NamespacedName, &updatedReview); err != nil {
		t.Fatal(err)
	}
	if updatedReview.Status.Phase != reviewv1alpha2.PhaseFailed {
		t.Fatalf("phase = %s, want Failed", updatedReview.Status.Phase)
	}
}
