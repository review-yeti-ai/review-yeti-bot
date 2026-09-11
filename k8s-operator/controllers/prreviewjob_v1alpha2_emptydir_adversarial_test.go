/*
Copyright 2026 CallTelemetry.

Adversarial empirical tests for operator emptyDir lifecycle, worker failure modes, and zero PVC leakage.
*/

package controllers_test

import (
	"context"
	"testing"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	reviewv1alpha2 "github.com/calltelemetry/ct-review-bot/k8s-operator/api/v1alpha2"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/controllers"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/job"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/workspace"
)

// TestAdversarialPrebakedRunningWorkerNeverDeleted verifies that repeated reconciliations
// on an active prebaked worker job with emptyDir workspace NEVER delete the worker job.
func TestAdversarialPrebakedRunningWorkerNeverDeleted(t *testing.T) {
	now := time.Date(2026, 9, 10, 12, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	review := v1alpha2Review(now)
	review.Spec.RunnerMode = "prebaked"

	kube := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(review).
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).
		Build()

	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client: kube,
		Scheme: scheme,
		Now:    func() time.Time { return now },
	}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	// 1. First Reconcile: creates worker Job
	res, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("reconcile 1 (creation) failed: %v", err)
	}
	if res.RequeueAfter != 0 {
		t.Fatalf("expected immediate creation without requeue, got: %v", res.RequeueAfter)
	}

	workerKey := types.NamespacedName{Namespace: review.Namespace, Name: review.Name + "-worker"}
	var worker batchv1.Job
	if err := kube.Get(context.Background(), workerKey, &worker); err != nil {
		t.Fatalf("worker Job not found after creation: %v", err)
	}

	// Verify it has emptyDir
	if worker.Spec.Template.Spec.Volumes[0].EmptyDir == nil {
		t.Fatal("worker Job must have emptyDir workspace")
	}

	// 2. Mark worker active (running)
	worker.Status.Active = 1
	if err := kube.Status().Update(context.Background(), &worker); err != nil {
		t.Fatalf("update worker active status: %v", err)
	}

	// 3. Reconcile 10 times consecutively while worker is running
	for i := 1; i <= 10; i++ {
		advanceTime := now.Add(time.Duration(i) * time.Minute)
		reconciler.Now = func() time.Time { return advanceTime }

		if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
			t.Fatalf("reconcile iteration %d failed: %v", i, err)
		}

		// Ensure worker Job was NOT deleted
		var checkWorker batchv1.Job
		if err := kube.Get(context.Background(), workerKey, &checkWorker); err != nil {
			t.Fatalf("worker Job was deleted or missing at reconcile iteration %d: %v", i, err)
		}
	}

	// 4. Verify exactly ZERO PVCs exist in the namespace
	var pvcs corev1.PersistentVolumeClaimList
	if err := kube.List(context.Background(), &pvcs, client.InNamespace(review.Namespace)); err != nil {
		t.Fatalf("list PVCs: %v", err)
	}
	if len(pvcs.Items) != 0 {
		t.Fatalf("expected 0 PVCs in prebaked mode, found %d: %#v", len(pvcs.Items), pvcs.Items)
	}
}

// TestAdversarialWorkerFailureLifecycleZeroPVCLeakage verifies that when a prebaked worker
// fails (e.g. crash, non-zero exit code), the controller marks PhaseFailed, releases the PR lease,
// and leaves zero lingering PVCs or dangling finalizers.
func TestAdversarialWorkerFailureLifecycleZeroPVCLeakage(t *testing.T) {
	now := time.Date(2026, 9, 10, 12, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	review := v1alpha2Review(now)
	review.Spec.RunnerMode = "prebaked"

	kube := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(review).
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).
		Build()

	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client: kube,
		Scheme: scheme,
		Now:    func() time.Time { return now },
	}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	// 1. Initial reconcile creates worker
	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("initial reconcile: %v", err)
	}

	workerKey := types.NamespacedName{Namespace: review.Namespace, Name: review.Name + "-worker"}
	var worker batchv1.Job
	if err := kube.Get(context.Background(), workerKey, &worker); err != nil {
		t.Fatalf("get worker: %v", err)
	}

	// 2. Simulate worker failure
	worker.Status.Active = 0
	worker.Status.Failed = 1
	worker.Status.Conditions = []batchv1.JobCondition{
		{
			Type:               batchv1.JobFailed,
			Status:             corev1.ConditionTrue,
			Reason:             "BackoffLimitExceeded",
			Message:            "Job has reached the specified backoff limit",
			LastTransitionTime: metav1.NewTime(now.Add(2 * time.Minute)),
		},
	}
	if err := kube.Status().Update(context.Background(), &worker); err != nil {
		t.Fatalf("update worker failed status: %v", err)
	}

	// 3. Reconcile failure
	failTime := now.Add(3 * time.Minute)
	reconciler.Now = func() time.Time { return failTime }
	res, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("reconcile terminal failure: %v", err)
	}
	if res.RequeueAfter != 0 {
		t.Fatalf("terminal failure should not requeue, got: %v", res.RequeueAfter)
	}

	// 4. Verify review state
	var updated reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), req.NamespacedName, &updated); err != nil {
		t.Fatal(err)
	}
	if updated.Status.Phase != reviewv1alpha2.PhaseFailed {
		t.Fatalf("phase = %s, want Failed", updated.Status.Phase)
	}
	if updated.Status.PVCName != "" {
		t.Fatalf("status.PVCName = %q, want empty", updated.Status.PVCName)
	}

	// 5. Verify PR lease was released and can be acquired by a new run
	nextRunID := "run_22222222222222222222222222222222"
	leaseResult, err := workspace.NewLeaseManager(kube).Acquire(
		context.Background(),
		review.Namespace,
		review.Spec.RepositoryID,
		review.Spec.PRNumber,
		nextRunID,
		failTime.Add(15*time.Minute),
		failTime.Add(time.Second),
	)
	if err != nil {
		t.Fatalf("failed to acquire lease after worker failure: %v", err)
	}
	if !leaseResult.Acquired {
		t.Fatal("lease was not released after worker failure")
	}

	// 6. Verify ZERO PVCs exist in namespace
	var pvcs corev1.PersistentVolumeClaimList
	if err := kube.List(context.Background(), &pvcs, client.InNamespace(review.Namespace)); err != nil {
		t.Fatalf("list PVCs: %v", err)
	}
	if len(pvcs.Items) != 0 {
		t.Fatalf("leakage detected: %d PVCs found in namespace: %#v", len(pvcs.Items), pvcs.Items)
	}
}

// TestAdversarialWorkerTimeoutDeadlineExceededZeroPVCLeakage verifies that when a worker
// times out (ActiveDeadlineSeconds exceeded or CR deadline elapsed), the reconciler completes terminal cleanup without leaking PVCs.
func TestAdversarialWorkerTimeoutDeadlineExceededZeroPVCLeakage(t *testing.T) {
	now := time.Date(2026, 9, 10, 12, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	review := v1alpha2Review(now)
	review.Spec.RunnerMode = "prebaked"

	kube := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(review).
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).
		Build()

	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client: kube,
		Scheme: scheme,
		Now:    func() time.Time { return now },
	}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("reconcile: %v", err)
	}

	workerKey := types.NamespacedName{Namespace: review.Namespace, Name: review.Name + "-worker"}
	var worker batchv1.Job
	if err := kube.Get(context.Background(), workerKey, &worker); err != nil {
		t.Fatalf("get worker: %v", err)
	}

	// Scenario A: Job active deadline exceeded within admitted window (e.g. 10m into 15m window)
	worker.Status.Active = 0
	worker.Status.Failed = 1
	worker.Status.Conditions = []batchv1.JobCondition{
		{
			Type:    batchv1.JobFailed,
			Status:  corev1.ConditionTrue,
			Reason:  "DeadlineExceeded",
			Message: "Job was active longer than specified deadline",
		},
	}
	if err := kube.Status().Update(context.Background(), &worker); err != nil {
		t.Fatalf("update worker status: %v", err)
	}

	timeoutTime := now.Add(10 * time.Minute)
	reconciler.Now = func() time.Time { return timeoutTime }
	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("reconcile timeout: %v", err)
	}

	var updated reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), req.NamespacedName, &updated); err != nil {
		t.Fatal(err)
	}
	if updated.Status.Phase != reviewv1alpha2.PhaseFailed {
		t.Fatalf("phase = %s, want Failed", updated.Status.Phase)
	}

	// Verify Zero PVCs
	var pvcs corev1.PersistentVolumeClaimList
	if err := kube.List(context.Background(), &pvcs, client.InNamespace(review.Namespace)); err != nil {
		t.Fatalf("list PVCs: %v", err)
	}
	if len(pvcs.Items) != 0 {
		t.Fatalf("PVC leakage: found %d PVCs", len(pvcs.Items))
	}

	// Scenario B: CR terminal deadline elapsed entirely (e.g. 16m)
	elapsedTime := now.Add(16 * time.Minute)
	reconciler.Now = func() time.Time { return elapsedTime }
	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("reconcile elapsed deadline: %v", err)
	}

	if err := kube.List(context.Background(), &pvcs, client.InNamespace(review.Namespace)); err != nil {
		t.Fatalf("list PVCs: %v", err)
	}
	if len(pvcs.Items) != 0 {
		t.Fatalf("PVC leakage after CR expiry: found %d PVCs", len(pvcs.Items))
	}
}

// TestAdversarialMultiRunSamePRNoPVCLeakage verifies sequential runs on the same PR:
// Run 1 fails, Run 2 succeeds. Neither creates any PVC, and leases hand over cleanly.
func TestAdversarialMultiRunSamePRNoPVCLeakage(t *testing.T) {
	now := time.Date(2026, 9, 10, 12, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)

	// Run 1
	review1 := v1alpha2Review(now)
	review1.Name = "ct-review-11111111111111111111111111111111"
	review1.Spec.RunID = "run_11111111111111111111111111111111"
	review1.Spec.RunSecretName = "ct-review-run-11111111111111111111111111111111"
	review1.Spec.RunnerMode = "prebaked"

	// Run 2 (same repository 123, same PR 42, new run identity)
	review2 := v1alpha2Review(now.Add(5 * time.Minute))
	review2.Name = "ct-review-22222222222222222222222222222222"
	review2.Spec.RunID = "run_22222222222222222222222222222222"
	review2.Spec.RunSecretName = "ct-review-run-22222222222222222222222222222222"
	review2.Spec.RunnerMode = "prebaked"

	kube := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(review1, review2).
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).
		Build()

	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client: kube,
		Scheme: scheme,
		Now:    func() time.Time { return now },
	}

	req1 := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review1.Namespace, Name: review1.Name}}
	req2 := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review2.Namespace, Name: review2.Name}}

	// Step 1: Reconcile Run 1 -> creates worker 1
	if _, err := reconciler.Reconcile(context.Background(), req1); err != nil {
		t.Fatalf("reconcile run1: %v", err)
	}

	// Step 2: Worker 1 fails
	var worker1 batchv1.Job
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review1.Namespace, Name: review1.Name + "-worker"}, &worker1); err != nil {
		t.Fatal(err)
	}
	worker1.Status.Failed = 1
	if err := kube.Status().Update(context.Background(), &worker1); err != nil {
		t.Fatal(err)
	}

	// Step 3: Terminal cleanup for Run 1
	reconciler.Now = func() time.Time { return now.Add(2 * time.Minute) }
	if _, err := reconciler.Reconcile(context.Background(), req1); err != nil {
		t.Fatalf("reconcile run1 cleanup: %v", err)
	}

	// Step 4: Reconcile Run 2 -> should acquire lease immediately and create worker 2
	reconciler.Now = func() time.Time { return now.Add(5 * time.Minute) }
	if _, err := reconciler.Reconcile(context.Background(), req2); err != nil {
		t.Fatalf("reconcile run2: %v", err)
	}

	var worker2 batchv1.Job
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review2.Namespace, Name: review2.Name + "-worker"}, &worker2); err != nil {
		t.Fatalf("run2 worker job missing: %v", err)
	}
	if worker2.Spec.Template.Spec.Volumes[0].EmptyDir == nil {
		t.Fatal("run2 worker must use EmptyDir")
	}

	// Step 5: Worker 2 succeeds
	worker2.Status.Succeeded = 1
	if err := kube.Status().Update(context.Background(), &worker2); err != nil {
		t.Fatal(err)
	}

	// Step 6: Terminal cleanup for Run 2
	reconciler.Now = func() time.Time { return now.Add(7 * time.Minute) }
	if _, err := reconciler.Reconcile(context.Background(), req2); err != nil {
		t.Fatalf("reconcile run2 cleanup: %v", err)
	}

	// Step 7: Final verification of zero PVCs in namespace
	var pvcs corev1.PersistentVolumeClaimList
	if err := kube.List(context.Background(), &pvcs, client.InNamespace(review1.Namespace)); err != nil {
		t.Fatal(err)
	}
	if len(pvcs.Items) != 0 {
		t.Fatalf("Zero PVC leakage violation: found %d PVCs", len(pvcs.Items))
	}
}

// TestAdversarialTerminalReconcileProtectsWorkspaceWhilePodIsActive verifies that
// reconcileTerminalWorkspace waits for active pods to terminate before finishing terminal cleanup.
func TestAdversarialTerminalReconcileProtectsWorkspaceWhilePodIsActive(t *testing.T) {
	now := time.Date(2026, 9, 10, 12, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	review := v1alpha2Review(now)
	review.Spec.RunnerMode = "prebaked"
	review.Status.Phase = reviewv1alpha2.PhaseFailed // Already in terminal phase

	// Active pod still running in namespace
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      review.Name + "-worker-pod-xyz",
			Namespace: review.Namespace,
			Labels: map[string]string{
				"review-yeti.ai/run-id":    review.Spec.RunID,
				"review-yeti.ai/component": job.WorkerComponentFor(review.Spec.PublicationMode, review.Spec.QualificationProfile),
			},
		},
		Status: corev1.PodStatus{
			Phase: corev1.PodRunning,
		},
	}

	kube := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(review, pod).
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).
		Build()

	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client: kube,
		Scheme: scheme,
		Now:    func() time.Time { return now },
	}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	// Reconcile terminal state while Pod is PodRunning -> MUST requeue
	res, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("reconcile terminal: %v", err)
	}
	if res.RequeueAfter == 0 {
		t.Fatal("expected RequeueAfter > 0 while worker pod is still running")
	}

	// Now pod reaches PodFailed
	pod.Status.Phase = corev1.PodFailed
	if err := kube.Status().Update(context.Background(), pod); err != nil {
		t.Fatal(err)
	}

	// Next reconcile: now pod is terminated -> RequeueAfter is 0, terminal cleanup completes
	res, err = reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("reconcile after pod termination: %v", err)
	}
	if res.RequeueAfter != 0 {
		t.Fatalf("expected RequeueAfter == 0 after pod termination, got: %v", res.RequeueAfter)
	}

	// Zero PVCs
	var pvcs corev1.PersistentVolumeClaimList
	if err := kube.List(context.Background(), &pvcs, client.InNamespace(review.Namespace)); err != nil {
		t.Fatal(err)
	}
	if len(pvcs.Items) != 0 {
		t.Fatalf("found %d PVCs", len(pvcs.Items))
	}
}
