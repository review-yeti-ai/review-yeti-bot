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
	"testing"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	coordinationv1 "k8s.io/api/coordination/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

	reviewv1alpha2 "github.com/review-yeti-ai/review-yeti-bot/k8s-operator/api/v1alpha2"
	"github.com/review-yeti-ai/review-yeti-bot/k8s-operator/controllers"
	"github.com/review-yeti-ai/review-yeti-bot/k8s-operator/pkg/job"
	"github.com/review-yeti-ai/review-yeti-bot/k8s-operator/pkg/workspace"
)

const terminalOutcomeFinalizer = "review-yeti.ai/terminal-outcome"

// =========================================================================
// PROBE 1: ORPHANED CONTINUATION JOBS
// =========================================================================

// TestChallengerM5_1_OrphanedWorkerJob_FinalizerReleasedOnOwnerDeletion
// verifies that for standard prep worker jobs (<review.Name>-worker),
// releaseOrphanedWorkerObservation successfully clears terminalOutcomeFinalizer.
func TestChallengerM5_1_OrphanedWorkerJob_FinalizerReleasedOnOwnerDeletion(t *testing.T) {
	now := time.Date(2026, 9, 28, 14, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)

	review := v1alpha2Review(now)
	workerJobName := review.Name + "-worker"
	review.Status.Phase = reviewv1alpha2.PhaseRunning
	review.Status.JobName = workerJobName

	workerJob, err := job.BuildWorkerJob(job.Input{
		Review:         review,
		WorkspaceLease: testLeaseFixture(now, review.Spec.RepositoryID, review.Spec.PRNumber, review.Spec.RunID),
		Now:            now,
		Phase:          job.JobPhasePrep,
	})
	if err != nil {
		t.Fatalf("build worker job: %v", err)
	}

	if err := controllerutil.SetControllerReference(review, workerJob, scheme); err != nil {
		t.Fatalf("set controller reference: %v", err)
	}
	controllerutil.AddFinalizer(workerJob, terminalOutcomeFinalizer)

	kube := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(workerJob). // review is already DELETED
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}, &batchv1.Job{}).
		Build()

	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client: kube,
		Scheme: scheme,
		Now:    func() time.Time { return now },
	}

	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	_, err = reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("reconcile deleted review returned unexpected error: %v", err)
	}

	var survivingJob batchv1.Job
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: workerJobName}, &survivingJob); err != nil {
		t.Fatalf("get worker job: %v", err)
	}

	if controllerutil.ContainsFinalizer(&survivingJob, terminalOutcomeFinalizer) {
		t.Fatalf("expected finalizer to be removed from worker job %q", workerJobName)
	}
}

// TestChallengerM5_1_OrphanedContinuationJob_FinalizerReleasedOnOwnerDeletion
// tests what happens when a PRReviewJob in continuation phase is deleted externally
// (leaving an orphaned continuation Job carrying terminalOutcomeFinalizer).
// The operator's releaseOrphanedWorkerObservation MUST remove the finalizer from
// <review.Name>-continuation so Kubernetes garbage collection is not blocked.
func TestChallengerM5_1_OrphanedContinuationJob_FinalizerReleasedOnOwnerDeletion(t *testing.T) {
	now := time.Date(2026, 9, 28, 14, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)

	review := v1alpha2Review(now)
	continuationJobName := review.Name + "-continuation"
	review.Status.Phase = reviewv1alpha2.PhaseRunning
	review.Status.JobName = continuationJobName
	review.Status.StartTime = &metav1.Time{Time: now.Add(-2 * time.Minute)}

	continuationJob, err := job.BuildWorkerJob(job.Input{
		Review:         review,
		WorkspaceLease: testLeaseFixture(now, review.Spec.RepositoryID, review.Spec.PRNumber, review.Spec.RunID),
		Now:            now,
		Phase:          job.JobPhaseContinuation,
	})
	if err != nil {
		t.Fatalf("build continuation job: %v", err)
	}

	// Add controller reference linking continuationJob to review
	if err := controllerutil.SetControllerReference(review, continuationJob, scheme); err != nil {
		t.Fatalf("set controller reference: %v", err)
	}
	controllerutil.AddFinalizer(continuationJob, terminalOutcomeFinalizer)

	kube := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(continuationJob). // review is already DELETED (not in cluster)
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}, &batchv1.Job{}).
		Build()

	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client: kube,
		Scheme: scheme,
		Now:    func() time.Time { return now },
	}

	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	// Reconcile the request for the deleted review
	_, err = reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("reconcile deleted review returned unexpected error: %v", err)
	}

	// Verify that the finalizer was removed from the continuation job
	var survivingJob batchv1.Job
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: continuationJobName}, &survivingJob); err != nil {
		t.Fatalf("get continuation job: %v", err)
	}

	if controllerutil.ContainsFinalizer(&survivingJob, terminalOutcomeFinalizer) {
		t.Fatalf("DEFECT: orphaned continuation Job %q still carries %q finalizer after parent review was deleted!",
			continuationJobName, terminalOutcomeFinalizer)
	}
}

// TestChallengerM5_1_OrphanedBothWorkerAndContinuationJobs_FinalizersReleasedOnOwnerDeletion
// tests what happens when both the prep worker (<review.Name>-worker) and continuation Job (<review.Name>-continuation)
// exist when the review is deleted. Both jobs must have their finalizers released.
func TestChallengerM5_1_OrphanedBothWorkerAndContinuationJobs_FinalizersReleasedOnOwnerDeletion(t *testing.T) {
	now := time.Date(2026, 9, 28, 14, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)

	review := v1alpha2Review(now)
	workerJobName := review.Name + "-worker"
	continuationJobName := review.Name + "-continuation"

	workerJob, err := job.BuildWorkerJob(job.Input{
		Review:         review,
		WorkspaceLease: testLeaseFixture(now, review.Spec.RepositoryID, review.Spec.PRNumber, review.Spec.RunID),
		Now:            now,
		Phase:          job.JobPhasePrep,
	})
	if err != nil {
		t.Fatalf("build worker job: %v", err)
	}
	if err := controllerutil.SetControllerReference(review, workerJob, scheme); err != nil {
		t.Fatalf("set worker controller reference: %v", err)
	}
	controllerutil.AddFinalizer(workerJob, terminalOutcomeFinalizer)

	continuationJob, err := job.BuildWorkerJob(job.Input{
		Review:         review,
		WorkspaceLease: testLeaseFixture(now, review.Spec.RepositoryID, review.Spec.PRNumber, review.Spec.RunID),
		Now:            now,
		Phase:          job.JobPhaseContinuation,
	})
	if err != nil {
		t.Fatalf("build continuation job: %v", err)
	}
	if err := controllerutil.SetControllerReference(review, continuationJob, scheme); err != nil {
		t.Fatalf("set continuation controller reference: %v", err)
	}
	controllerutil.AddFinalizer(continuationJob, terminalOutcomeFinalizer)

	kube := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(workerJob, continuationJob). // review is already DELETED
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}, &batchv1.Job{}).
		Build()

	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client: kube,
		Scheme: scheme,
		Now:    func() time.Time { return now },
	}

	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	_, err = reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("reconcile deleted review returned unexpected error: %v", err)
	}

	var survivingWorker batchv1.Job
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: workerJobName}, &survivingWorker); err != nil {
		t.Fatal(err)
	}
	if controllerutil.ContainsFinalizer(&survivingWorker, terminalOutcomeFinalizer) {
		t.Fatalf("expected finalizer to be removed from worker job %q", workerJobName)
	}

	var survivingContinuation batchv1.Job
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: continuationJobName}, &survivingContinuation); err != nil {
		t.Fatal(err)
	}
	if controllerutil.ContainsFinalizer(&survivingContinuation, terminalOutcomeFinalizer) {
		t.Fatalf("DEFECT: orphaned continuation Job %q still carries %q finalizer when both jobs existed!",
			continuationJobName, terminalOutcomeFinalizer)
	}
}

// =========================================================================
// PROBE 2: RAPID CONSECUTIVE RESUMPTIONS
// =========================================================================

// TestChallengerM5_1_RapidConsecutiveResumptions_IdempotentAndNoDuplicateJobs
// tests that rapid consecutive resumption triggers:
// 1. Do not spawn duplicate continuation jobs.
// 2. Do not corrupt PRReviewJob phase or active worker lease token.
// 3. Gracefully tolerate repeated resumption annotations while continuation is running or completed.
func TestChallengerM5_1_RapidConsecutiveResumptions_IdempotentAndNoDuplicateJobs(t *testing.T) {
	now := time.Date(2026, 9, 28, 14, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)

	review := v1alpha2Review(now)
	review.Status.Phase = reviewv1alpha2.PhaseAwaitingResumption
	meta.SetStatusCondition(&review.Status.Conditions, metav1.Condition{
		Type:               reviewv1alpha2.ConditionAwaitingResumption,
		Status:             metav1.ConditionTrue,
		Reason:             "PrepCompleted",
		Message:            "prep phase completed, awaiting model resumption",
		LastTransitionTime: metav1.NewTime(now.Add(-2 * time.Minute)),
	})
	review.Status.StartTime = &metav1.Time{Time: now.Add(-3 * time.Minute)}
	review.Status.JobName = review.Name + "-worker"

	if review.Annotations == nil {
		review.Annotations = make(map[string]string)
	}
	review.Annotations[job.JobPhaseLabel] = job.JobPhaseContinuation

	kube := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(review).
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}, &batchv1.Job{}).
		Build()

	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client: kube,
		Scheme: scheme,
		Now:    func() time.Time { return now },
	}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	// First resumption pass: creates continuation job
	res1, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("first resumption reconcile failed: %v", err)
	}
	if res1.RequeueAfter > 0 {
		t.Fatalf("expected immediate continuation creation, got RequeueAfter: %v", res1.RequeueAfter)
	}

	continuationJobName := review.Name + "-continuation"
	var job1 batchv1.Job
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: continuationJobName}, &job1); err != nil {
		t.Fatalf("continuation job not found after first pass: %v", err)
	}

	// Rapid consecutive pass 2: identical trigger received immediately
	res2, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("second resumption reconcile failed: %v", err)
	}
	if res2.RequeueAfter > 0 {
		t.Fatalf("unexpected requeue on second pass: %v", res2.RequeueAfter)
	}

	// Rapid consecutive pass 3: review-yeti.ai/resumed annotation added additionally
	var updated reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), req.NamespacedName, &updated); err != nil {
		t.Fatal(err)
	}
	updated.Annotations["review-yeti.ai/resumed"] = "true"
	if err := kube.Update(context.Background(), &updated); err != nil {
		t.Fatal(err)
	}

	res3, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("third resumption reconcile failed: %v", err)
	}
	if res3.RequeueAfter > 0 {
		t.Fatalf("unexpected requeue on third pass: %v", res3.RequeueAfter)
	}

	// Verify only ONE continuation job exists in the namespace
	var jobs batchv1.JobList
	if err := kube.List(context.Background(), &jobs, client.InNamespace(review.Namespace)); err != nil {
		t.Fatal(err)
	}
	continuationCount := 0
	for _, j := range jobs.Items {
		if j.Name == continuationJobName {
			continuationCount++
		}
	}
	if continuationCount != 1 {
		t.Fatalf("expected exactly 1 continuation job, found %d", continuationCount)
	}
}

// =========================================================================
// PROBE 3: LEASE RELEASE TIMING ACROSS PREP AND CONTINUATION
// =========================================================================

// TestChallengerM5_1_LeaseReleaseTiming_PrepCompletionReleasesLease
// tests that when a prep worker succeeds:
// 1. The workspace Lease is immediately released (holder is cleared).
// 2. This allows other PR workers or tools to access the workspace while the review is suspended.
// 3. When continuation resumes, the lease is re-acquired.
func TestChallengerM5_1_LeaseReleaseTiming_PrepCompletionReleasesLease(t *testing.T) {
	now := time.Date(2026, 9, 28, 14, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)

	review := v1alpha2Review(now)
	prepJobName := review.Name + "-worker"
	review.Status.Phase = reviewv1alpha2.PhaseRunning
	review.Status.JobName = prepJobName
	review.Status.StartTime = &metav1.Time{Time: now.Add(-2 * time.Minute)}

	// Pre-create Lease held by review.Spec.RunID
	leaseName := workspace.LeaseName(review.Spec.RepositoryID, review.Spec.PRNumber)
	holder := review.Spec.RunID
	duration := int32(600)
	renewTime := metav1.NewMicroTime(now)
	labels, annotations := workspace.Metadata(review.Spec.RepositoryID, review.Spec.PRNumber)
	lease := &coordinationv1.Lease{
		ObjectMeta: metav1.ObjectMeta{
			Name:        leaseName,
			Namespace:   review.Namespace,
			Labels:      labels,
			Annotations: annotations,
		},
		Spec: coordinationv1.LeaseSpec{
			HolderIdentity:       &holder,
			LeaseDurationSeconds: &duration,
			AcquireTime:          &renewTime,
			RenewTime:            &renewTime,
		},
	}

	prepJob, err := job.BuildWorkerJob(job.Input{
		Review:         review,
		WorkspaceLease: testLeaseFixture(now, review.Spec.RepositoryID, review.Spec.PRNumber, review.Spec.RunID),
		Now:            now,
		Phase:          job.JobPhasePrep,
	})
	if err != nil {
		t.Fatalf("build prep worker: %v", err)
	}
	prepJob.Status.Succeeded = 1

	kube := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(review, lease, prepJob).
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}, &batchv1.Job{}).
		Build()

	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client: kube,
		Scheme: scheme,
		Now:    func() time.Time { return now },
	}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	// Reconcile prep worker completion
	_, err = reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("reconcile prep completion failed: %v", err)
	}

	// Verify review entered PhaseAwaitingResumption
	var updated reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), req.NamespacedName, &updated); err != nil {
		t.Fatal(err)
	}
	if updated.Status.Phase != reviewv1alpha2.PhaseAwaitingResumption {
		t.Fatalf("expected phase %s, got %s", reviewv1alpha2.PhaseAwaitingResumption, updated.Status.Phase)
	}

	// Verify workspace Lease holder was CLEARED upon prep completion
	var updatedLease coordinationv1.Lease
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: leaseName}, &updatedLease); err != nil {
		t.Fatal(err)
	}
	if updatedLease.Spec.HolderIdentity != nil && *updatedLease.Spec.HolderIdentity != "" {
		t.Fatalf("DEFECT: workspace lease holder identity %q was NOT released upon prep completion!", *updatedLease.Spec.HolderIdentity)
	}

	// Now trigger continuation
	updated.Annotations = map[string]string{job.JobPhaseLabel: job.JobPhaseContinuation}
	if err := kube.Update(context.Background(), &updated); err != nil {
		t.Fatal(err)
	}

	// Reconcile continuation resumption
	_, err = reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("reconcile continuation failed: %v", err)
	}

	// Verify lease is re-acquired by continuation phase
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: leaseName}, &updatedLease); err != nil {
		t.Fatal(err)
	}
	if updatedLease.Spec.HolderIdentity == nil || *updatedLease.Spec.HolderIdentity != review.Spec.RunID {
		t.Fatalf("expected lease re-acquired by %q, got: %v", review.Spec.RunID, updatedLease.Spec.HolderIdentity)
	}
}

// =========================================================================
// PROBE 4: DROPLET NODE MEMORY EXHAUSTION SIMULATIONS
// =========================================================================

// TestChallengerM5_1_MemoryExhaustion_KubeletEvictionDuringPrepPhase
// tests that when a Droplet node experiences severe memory pressure during the prep phase
// causing Kubelet to evict the prep pod:
// 1. The controller records UnknownEffectPending condition.
// 2. The review transitions to PhaseFailed.
// 3. The controller NEVER marks ConditionAwaitingResumption or schedules continuation.
func TestChallengerM5_1_MemoryExhaustion_KubeletEvictionDuringPrepPhase(t *testing.T) {
	f := newTerminationFixture(t)
	worker := f.worker(t)
	assignFakeWorkerUID(t, f.kube, worker)

	// Prep pod is evicted due to Droplet node memory exhaustion
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      worker.Name + "-mem-evicted",
			Namespace: f.review.Namespace,
			Labels: map[string]string{
				"batch.kubernetes.io/job-name": worker.Name,
				"review-yeti.ai/run-id":        f.review.Spec.RunID,
				"review-yeti.ai/component":     job.ReceiptOnlyWorkerComponent,
			},
		},
		Status: corev1.PodStatus{
			Phase:   corev1.PodFailed,
			Reason:  "Evicted",
			Message: "The node was low on resource: memory. Pod reviewer-worker was using 250Mi of 256Mi limit.",
		},
	}
	bindTestPodToWorker(pod, worker)
	if err := f.kube.Create(context.Background(), pod); err != nil {
		t.Fatal(err)
	}

	worker.Status.Failed = 1
	worker.Status.Conditions = []batchv1.JobCondition{
		{
			Type:               batchv1.JobFailed,
			Status:             corev1.ConditionTrue,
			LastTransitionTime: metav1.NewTime(f.now),
		},
	}
	if err := f.kube.Status().Update(context.Background(), worker); err != nil {
		t.Fatal(err)
	}

	_, err := f.reconciler.Reconcile(context.Background(), f.req)
	if err != nil {
		t.Fatalf("reconcile failed: %v", err)
	}

	review := storedReview(t, f.kube, f.req)

	// Must fail closed
	if review.Status.Phase != reviewv1alpha2.PhaseFailed {
		t.Fatalf("expected phase %s, got %s", reviewv1alpha2.PhaseFailed, review.Status.Phase)
	}

	// ConditionAwaitingResumption must NOT be True
	awaitCond := meta.FindStatusCondition(review.Status.Conditions, reviewv1alpha2.ConditionAwaitingResumption)
	if awaitCond != nil && awaitCond.Status == metav1.ConditionTrue {
		t.Fatalf("DEFECT: ConditionAwaitingResumption was set to True despite memory eviction failure: %#v", awaitCond)
	}

	// UnknownEffectPending must be recorded
	unknownCond := meta.FindStatusCondition(review.Status.Conditions, controllers.ConditionUnknownEffectPending)
	if unknownCond == nil || unknownCond.Status != metav1.ConditionTrue {
		t.Fatalf("expected ConditionUnknownEffectPending=True, got: %#v", unknownCond)
	}
}

// TestChallengerM5_1_MemoryExhaustion_ContinuationOOMKilled
// tests that when a continuation pod is OOMKilled by the Linux kernel cgroup killer (exit code 137):
// 1. The controller records UnknownEffectPending condition.
// 2. The review transitions to PhaseFailed.
// 3. The review is NEVER promoted to Succeeded.
func TestChallengerM5_1_MemoryExhaustion_ContinuationOOMKilled(t *testing.T) {
	now := time.Date(2026, 9, 28, 14, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)

	review := v1alpha2Review(now)
	continuationJobName := review.Name + "-continuation"
	review.Status.Phase = reviewv1alpha2.PhaseRunning
	review.Status.JobName = continuationJobName
	review.Status.StartTime = &metav1.Time{Time: now.Add(-3 * time.Minute)}

	continuationJob, err := job.BuildWorkerJob(job.Input{
		Review:         review,
		WorkspaceLease: testLeaseFixture(now, review.Spec.RepositoryID, review.Spec.PRNumber, review.Spec.RunID),
		Now:            now,
		Phase:          job.JobPhaseContinuation,
	})
	if err != nil {
		t.Fatalf("build continuation job: %v", err)
	}
	continuationJob.UID = types.UID("fake-continuation-uid")
	continuationJob.Status.Failed = 1

	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      continuationJobName + "-oom-pod",
			Namespace: review.Namespace,
			Labels: map[string]string{
				"batch.kubernetes.io/job-name": continuationJobName,
				"review-yeti.ai/run-id":        review.Spec.RunID,
				"review-yeti.ai/component":     job.ReceiptOnlyWorkerComponent,
			},
		},
		Status: corev1.PodStatus{
			Phase: corev1.PodFailed,
			ContainerStatuses: []corev1.ContainerStatus{
				{
					Name: job.WorkerContainerName,
					State: corev1.ContainerState{
						Terminated: &corev1.ContainerStateTerminated{
							ExitCode: 137,
							Reason:   "OOMKilled",
							Message:  "Memory cgroup out of memory: Killed process 42 (node)",
						},
					},
				},
			},
		},
	}
	bindTestPodToWorker(pod, continuationJob)

	kube := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(review, continuationJob, pod).
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}, &batchv1.Job{}).
		Build()

	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client: kube,
		Scheme: scheme,
		Now:    func() time.Time { return now },
	}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	_, err = reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("reconcile failed: %v", err)
	}

	var updated reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), req.NamespacedName, &updated); err != nil {
		t.Fatal(err)
	}

	if updated.Status.Phase != reviewv1alpha2.PhaseFailed {
		t.Fatalf("expected phase %s, got %s", reviewv1alpha2.PhaseFailed, updated.Status.Phase)
	}

	unknownCond := meta.FindStatusCondition(updated.Status.Conditions, controllers.ConditionUnknownEffectPending)
	if unknownCond == nil || unknownCond.Status != metav1.ConditionTrue {
		t.Fatalf("expected ConditionUnknownEffectPending=True, got %#v", unknownCond)
	}
}

// =========================================================================
// PROBE 5: UNEXPECTED STATUS TRANSITIONS ON TERMINAL REVIEWS
// =========================================================================

// TestChallengerM5_1_TerminalReviews_ImmuneToResumptionTriggers
// tests that once a review reaches ANY terminal phase (Succeeded, Failed, Expired, Cancelled),
// injecting resumption annotations or triggers NEVER causes re-admission or continuation job creation.
func TestChallengerM5_1_TerminalReviews_ImmuneToResumptionTriggers(t *testing.T) {
	terminalPhases := []reviewv1alpha2.PRReviewJobPhase{
		reviewv1alpha2.PhaseSucceeded,
		reviewv1alpha2.PhaseFailed,
		reviewv1alpha2.PhaseExpired,
		reviewv1alpha2.PhaseCancelled,
	}

	for _, phase := range terminalPhases {
		t.Run(string(phase), func(t *testing.T) {
			now := time.Date(2026, 9, 28, 14, 0, 0, 0, time.UTC)
			scheme := v1alpha2Scheme(t)

			review := v1alpha2Review(now.Add(-10 * time.Minute))
			review.Status.Phase = phase
			completed := metav1.NewTime(now.Add(-5 * time.Minute))
			review.Status.CompletionTime = &completed

			// Inject adversarial resumption annotations
			if review.Annotations == nil {
				review.Annotations = make(map[string]string)
			}
			review.Annotations[job.JobPhaseLabel] = job.JobPhaseContinuation
			review.Annotations["review-yeti.ai/resumed"] = "true"

			kube := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(review).
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}, &batchv1.Job{}).
		Build()

			reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
				Client: kube,
				Scheme: scheme,
				Now:    func() time.Time { return now },
			}
			req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

			_, err := reconciler.Reconcile(context.Background(), req)
			if err != nil {
				t.Fatalf("reconcile terminal review failed: %v", err)
			}

			// Verify NO continuation job was created
			continuationJobName := review.Name + "-continuation"
			var continuationJob batchv1.Job
			err = kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: continuationJobName}, &continuationJob)
			if err == nil {
				t.Fatalf("CRITICAL DEFECT: continuation job was created for terminal review in phase %s!", phase)
			}
			if !apierrors.IsNotFound(err) {
				t.Fatalf("unexpected error getting continuation job: %v", err)
			}
		})
	}
}
