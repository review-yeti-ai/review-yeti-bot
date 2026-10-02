/*
Copyright 2026 Review Yeti.

Challenger 1 Deep Empirical Stress Test Suite:
Milestone 2 Iteration 2 Gate:
- Multi-pass optimistic concurrency conflict resilience during prep completion
- Quota reclamation & slot recycling across PhaseAwaitingResumption & PhaseSuspended
- Fail-closed behavior & debug TTL preservation on prep pod non-zero exit
*/

package controllers_test

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/runtime/schema"
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

// TestChallenger_MultipleConflictRetries_DuringPrepCompletion asserts that even if the API server
// generates multiple consecutive optimistic concurrency conflicts (e.g. 3 consecutive conflict passes)
// when committing the status update for prep completion, the controller NEVER removes the worker finalizer
// or patches TTL=0 until the status update succeeds, preventing premature worker deletion and false WorkerJobMissing.
func TestChallenger_MultipleConflictRetries_DuringPrepCompletion(t *testing.T) {
	var conflictArmed bool
	var conflictCounter int32 = 3 // Generate 3 conflicts before succeeding
	now := time.Date(2026, 9, 28, 14, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)

	review := v1alpha2Review(now)
	review.Annotations = map[string]string{
		job.JobPhaseLabel: job.JobPhasePrep,
	}

	pvc, err := workspace.BuildPVC(review.Namespace, review.Spec.RepositoryID, review.Spec.PRNumber, now.Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}

	kube := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(review, pvc).
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}, &batchv1.Job{}).
		WithInterceptorFuncs(interceptor.Funcs{
			SubResourceUpdate: func(ctx context.Context, c client.Client, subResourceName string, obj client.Object, opts ...client.SubResourceUpdateOption) error {
				if conflictArmed {
					if _, isReview := obj.(*reviewv1alpha2.PRReviewJob); isReview {
						if atomic.AddInt32(&conflictCounter, -1) >= 0 {
							return apierrors.NewConflict(
								schema.GroupResource{Group: "review-yeti.ai", Resource: "prreviewjobs"},
								obj.GetName(), nil)
						}
					}
				}
				return c.SubResource(subResourceName).Update(ctx, obj, opts...)
			},
		}).
		Build()

	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client: kube,
		Scheme: scheme,
		Now:    func() time.Time { return now },
	}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	// Pass 1: Admitted and worker Job created
	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("pass 1 failed: %v", err)
	}

	var worker batchv1.Job
	workerName := types.NamespacedName{Namespace: review.Namespace, Name: review.Name + "-worker"}
	if err := kube.Get(context.Background(), workerName, &worker); err != nil {
		t.Fatalf("failed to get created worker job: %v", err)
	}

	// Succeeded prep pod
	attachReceiptAnnotations(&worker)
	worker.Status.Succeeded = 1
	if err := kube.Status().Update(context.Background(), &worker); err != nil {
		t.Fatalf("update worker status succeeded: %v", err)
	}

	conflictArmed = true

	// Passes 2, 3, 4: Reconcile encounters conflict on status update
	for i := 1; i <= 3; i++ {
		res, err := reconciler.Reconcile(context.Background(), req)
		if err != nil {
			t.Fatalf("pass %d unexpected err: %v", i+1, err)
		}
		if res.RequeueAfter != 2*time.Second {
			t.Fatalf("pass %d expected requeue after 2s, got: %v", i+1, res.RequeueAfter)
		}

		// Invariant during all conflict passes: worker finalizer MUST still be present and TTL MUST NOT be 0!
		var checkWorker batchv1.Job
		if err := kube.Get(context.Background(), workerName, &checkWorker); err != nil {
			t.Fatalf("pass %d: worker disappeared during conflict: %v", i+1, err)
		}
		hasFinalizer := false
		for _, f := range checkWorker.Finalizers {
			if f == "review-yeti.ai/terminal-outcome" {
				hasFinalizer = true
				break
			}
		}
		if !hasFinalizer {
			t.Fatalf("pass %d: worker finalizer was prematurely removed before status update committed!", i+1)
		}
		if checkWorker.Spec.TTLSecondsAfterFinished != nil && *checkWorker.Spec.TTLSecondsAfterFinished == 0 {
			t.Fatalf("pass %d: worker TTL was prematurely lowered to 0 before status update committed!", i+1)
		}
	}

	// Pass 5: Conflicts exhausted; reconcile succeeds
	reconciler.Now = func() time.Time { return now.Add(10 * time.Second) }
	res, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("pass 5 reconcile error: %v", err)
	}
	if res.Requeue || res.RequeueAfter > 0 {
		t.Fatalf("pass 5 unexpected requeue: %#v", res)
	}

	var updatedReview reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), req.NamespacedName, &updatedReview); err != nil {
		t.Fatal(err)
	}
	if updatedReview.Status.Phase != reviewv1alpha2.PhaseAwaitingResumption {
		t.Fatalf("review phase want %s, got %s", reviewv1alpha2.PhaseAwaitingResumption, updatedReview.Status.Phase)
	}

	// Check worker Job: now finalizer is removed and TTL is 0
	var finalWorker batchv1.Job
	if err := kube.Get(context.Background(), workerName, &finalWorker); err != nil {
		t.Fatal(err)
	}
	if finalWorker.Spec.TTLSecondsAfterFinished == nil || *finalWorker.Spec.TTLSecondsAfterFinished != 0 {
		t.Fatalf("worker TTL want 0, got %v", finalWorker.Spec.TTLSecondsAfterFinished)
	}
	for _, f := range finalWorker.Finalizers {
		if f == "review-yeti.ai/terminal-outcome" {
			t.Fatalf("worker finalizer must be removed after successful status update")
		}
	}
}

// TestChallenger_PrepJob_NonZeroExit_FailsClosed_PreservesDebugTTL verifies that if a prep pod
// fails with exit code 1 or OOM (Succeeded=0, Failed=1), the operator fails closed to PhaseFailed,
// does NOT transition to PhaseAwaitingResumption, and does NOT set TTL=0 so debug logs are preserved.
func TestChallenger_PrepJob_NonZeroExit_FailsClosed_PreservesDebugTTL(t *testing.T) {
	now := time.Date(2026, 9, 28, 14, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)

	review := v1alpha2Review(now)
	review.Annotations = map[string]string{
		job.JobPhaseLabel: job.JobPhasePrep,
	}

	pvc, err := workspace.BuildPVC(review.Namespace, review.Spec.RepositoryID, review.Spec.PRNumber, now.Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}

	kube := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(review, pvc).
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}, &batchv1.Job{}).
		Build()

	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client: kube,
		Scheme: scheme,
		Now:    func() time.Time { return now },
	}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	// Pass 1: Admitted and worker Job created
	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("first reconcile failed: %v", err)
	}

	var worker batchv1.Job
	workerName := types.NamespacedName{Namespace: review.Namespace, Name: review.Name + "-worker"}
	if err := kube.Get(context.Background(), workerName, &worker); err != nil {
		t.Fatalf("failed to get created worker job: %v", err)
	}

	initialTTL := *worker.Spec.TTLSecondsAfterFinished

	// Worker fails with exit code 1 / OOM (Succeeded = 0, Failed = 1)
	attachReceiptAnnotations(&worker)
	worker.Status.Failed = 1
	if err := kube.Status().Update(context.Background(), &worker); err != nil {
		t.Fatalf("update worker status failed: %v", err)
	}

	// Pass 2: Reconcile failure
	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("second reconcile failed: %v", err)
	}

	var updatedReview reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), req.NamespacedName, &updatedReview); err != nil {
		t.Fatal(err)
	}

	// Review MUST be PhaseFailed, NOT PhaseAwaitingResumption
	if updatedReview.Status.Phase != reviewv1alpha2.PhaseFailed {
		t.Fatalf("expected PhaseFailed for failed prep pod, got %s", updatedReview.Status.Phase)
	}
	if meta.IsStatusConditionTrue(updatedReview.Status.Conditions, reviewv1alpha2.ConditionAwaitingResumption) {
		t.Fatalf("failed prep pod MUST NOT have ConditionAwaitingResumption=True")
	}

	// Worker TTL MUST NOT be lowered to 0 (preserves post-mortem debug logs)
	var updatedWorker batchv1.Job
	if err := kube.Get(context.Background(), workerName, &updatedWorker); err != nil {
		t.Fatal(err)
	}
	if updatedWorker.Spec.TTLSecondsAfterFinished == nil || *updatedWorker.Spec.TTLSecondsAfterFinished < initialTTL {
		t.Fatalf("failed worker TTL must not be shortened, want >= %d, got %v", initialTTL, updatedWorker.Spec.TTLSecondsAfterFinished)
	}
}

// TestChallenger_ConcurrentReconciles_IdempotentResumption_NoFinalizerReattach verifies that once
// a review is in PhaseAwaitingResumption, subsequent reconcile passes (informer resync, status touch)
// do NOT re-add the terminalOutcomeFinalizer to the worker Job before TTL controller collects it.
func TestChallenger_ConcurrentReconciles_IdempotentResumption_NoFinalizerReattach(t *testing.T) {
	now := time.Date(2026, 9, 28, 14, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)

	review := v1alpha2Review(now)
	review.Annotations = map[string]string{
		job.JobPhaseLabel: job.JobPhasePrep,
	}

	pvc, err := workspace.BuildPVC(review.Namespace, review.Spec.RepositoryID, review.Spec.PRNumber, now.Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}

	kube := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(review, pvc).
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}, &batchv1.Job{}).
		Build()

	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client: kube,
		Scheme: scheme,
		Now:    func() time.Time { return now },
	}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	// Pass 1: Admitted and worker Job created
	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("pass 1 failed: %v", err)
	}

	var worker batchv1.Job
	workerName := types.NamespacedName{Namespace: review.Namespace, Name: review.Name + "-worker"}
	if err := kube.Get(context.Background(), workerName, &worker); err != nil {
		t.Fatalf("failed to get created worker job: %v", err)
	}

	// Succeeded prep pod
	attachReceiptAnnotations(&worker)
	worker.Status.Succeeded = 1
	if err := kube.Status().Update(context.Background(), &worker); err != nil {
		t.Fatalf("update worker status succeeded: %v", err)
	}

	// Pass 2: Reconcile prep completion -> PhaseAwaitingResumption, TTL=0, finalizer removed
	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("pass 2 failed: %v", err)
	}

	var completedWorker batchv1.Job
	if err := kube.Get(context.Background(), workerName, &completedWorker); err != nil {
		t.Fatal(err)
	}
	for _, f := range completedWorker.Finalizers {
		if f == "review-yeti.ai/terminal-outcome" {
			t.Fatalf("expected terminalOutcomeFinalizer to be removed on prep completion")
		}
	}

	// Pass 3, 4, 5: Subsequent reconciles while the Job is still in the API server (awaiting TTL cleanup)
	for i := 3; i <= 5; i++ {
		reconciler.Now = func() time.Time { return now.Add(time.Duration(i) * time.Second) }
		res, err := reconciler.Reconcile(context.Background(), req)
		if err != nil {
			t.Fatalf("pass %d failed: %v", i, err)
		}
		if res.Requeue || res.RequeueAfter > 0 {
			t.Fatalf("pass %d unexpected requeue: %#v", i, res)
		}

		// Verify finalizer was NOT re-attached!
		var checkWorker batchv1.Job
		if err := kube.Get(context.Background(), workerName, &checkWorker); err != nil {
			t.Fatal(err)
		}
		for _, f := range checkWorker.Finalizers {
			if f == "review-yeti.ai/terminal-outcome" {
				t.Fatalf("pass %d: finalizer was improperly re-attached to succeeded prep worker Job!", i)
			}
		}
	}
}

// TestChallenger_PhaseSuspended_ExcludedFromAdmissionSnapshot asserts that reviews in PhaseSuspended
// release their worker slot immediately and do not block newly queued reviews.
func TestChallenger_PhaseSuspended_ExcludedFromAdmissionSnapshot(t *testing.T) {
	now := time.Date(2026, 9, 28, 14, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)

	// Review 1 is in PhaseSuspended
	review1 := v1alpha2Review(now)
	review1.Name = "ct-review-11111111111111111111111111111111"
	review1.Spec.RunID = "run_11111111111111111111111111111111"
	review1.Spec.RunSecretName = "ct-review-run-11111111111111111111111111111111"
	review1.Status.Phase = reviewv1alpha2.PhaseSuspended

	// Review 2 is Queued
	review2 := v1alpha2Review(now)
	review2.Name = "ct-review-22222222222222222222222222222222"
	review2.Spec.RunID = "run_22222222222222222222222222222222"
	review2.Spec.RunSecretName = "ct-review-run-22222222222222222222222222222222"

	kube := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(review1, review2).
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}, &batchv1.Job{}).
		Build()

	// MaxConcurrentJobs = 1.
	// If review1 in PhaseSuspended were counted, review2 could not admit!
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client:            kube,
		Scheme:            scheme,
		Now:               func() time.Time { return now },
		MaxConcurrentJobs: 1,
	}

	req2 := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review2.Namespace, Name: review2.Name}}
	if _, err := reconciler.Reconcile(context.Background(), req2); err != nil {
		t.Fatalf("reconcile review2 failed: %v", err)
	}

	var checkReview2 reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), req2.NamespacedName, &checkReview2); err != nil {
		t.Fatal(err)
	}
	if checkReview2.Status.Phase != reviewv1alpha2.PhaseRunning {
		t.Fatalf("review2 want PhaseRunning, got %s (message: %s)", checkReview2.Status.Phase, checkReview2.Status.Message)
	}
}
