/*
Copyright 2026 exampleorg.

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
	"fmt"
	"testing"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	reviewv1alpha2 "github.com/review-yeti-ai/review-yeti-bot/k8s-operator/api/v1alpha2"
	"github.com/review-yeti-ai/review-yeti-bot/k8s-operator/controllers"
	"github.com/review-yeti-ai/review-yeti-bot/k8s-operator/pkg/job"
)

// =========================================================================
// 1. RESUMPTION UNDER SATURATED CONCURRENCY & FIFO QUEUEING
// =========================================================================

// TestChallengerM4_1_ResumptionUnderSaturatedConcurrency_FIFOOrderAndAnnotationPreserved
// tests that when 10 concurrent jobs are actively running in the cluster:
// 1. A resuming review in PhaseAwaitingResumption transitions to PhaseQueued.
// 2. The resumption annotation is PRESERVED and not stripped.
// 3. ConditionAwaitingResumption is retained.
// 4. The review waits in FIFO order behind older admission candidates.
// 5. When capacity frees up, the older candidate admits first, then the resuming review admits.
func TestChallengerM4_1_ResumptionUnderSaturatedConcurrency_FIFOOrderAndAnnotationPreserved(t *testing.T) {
	now := time.Date(2026, 9, 28, 14, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)

	// Create 10 active jobs to saturate concurrency (limit = 10)
	initObjects := []client.Object{}
	activeJobs := make([]*batchv1.Job, 10)
	for i := 0; i < 10; i++ {
		rev := v1alpha2Review(now.Add(-time.Duration(10-i) * time.Minute))
		hexID := fmt.Sprintf("%02d000000000000000000000000000000", i)
		rev.Name = "ct-review-" + hexID
		rev.Spec.RunID = "run_" + hexID
		rev.Spec.RunSecretName = "ct-review-run-" + hexID
		rev.Spec.PRNumber = int32(100 + i)
		rev.Status.Phase = reviewv1alpha2.PhaseRunning
		rev.Status.JobName = rev.Name + "-worker"
		rev.Status.StartTime = &metav1.Time{Time: now.Add(-5 * time.Minute)}

		activeJob, err := job.BuildWorkerJob(job.Input{
			Review:         rev,
			WorkspaceLease: testLeaseFixture(now, rev.Spec.RepositoryID, rev.Spec.PRNumber, rev.Spec.RunID),
			Now:            now,
			Phase:          job.JobPhasePrep,
		})
		if err != nil {
			t.Fatalf("build active worker %d: %v", i, err)
		}
		activeJob.Status.Active = 1
		activeJobs[i] = activeJob

		initObjects = append(initObjects, rev, activeJob)
	}

	// Create an older queued review (T0 = now - 4 minutes)
	olderQueued := v1alpha2Review(now.Add(-4 * time.Minute))
	olderHex := "91000000000000000000000000000000"
	olderQueued.Name = "ct-review-" + olderHex
	olderQueued.Spec.RunID = "run_" + olderHex
	olderQueued.Spec.RunSecretName = "ct-review-run-" + olderHex
	olderQueued.Spec.PRNumber = 201
	olderQueued.Status.Phase = reviewv1alpha2.PhaseQueued
	olderQueued.Spec.ReceivedAt = metav1.Time{Time: now.Add(-4 * time.Minute)}
	initObjects = append(initObjects, olderQueued)

	// Create the resuming review (T1 = now - 2 minutes)
	resumingReview := v1alpha2Review(now.Add(-2 * time.Minute))
	resumingHex := "92000000000000000000000000000000"
	resumingReview.Name = "ct-review-" + resumingHex
	resumingReview.Spec.RunID = "run_" + resumingHex
	resumingReview.Spec.RunSecretName = "ct-review-run-" + resumingHex
	resumingReview.Spec.PRNumber = 202
	resumingReview.Spec.ReceivedAt = metav1.Time{Time: now.Add(-2 * time.Minute)}
	resumingReview.Status.Phase = reviewv1alpha2.PhaseAwaitingResumption
	meta.SetStatusCondition(&resumingReview.Status.Conditions, metav1.Condition{
		Type:               reviewv1alpha2.ConditionAwaitingResumption,
		Status:             metav1.ConditionTrue,
		Reason:             "PrepCompleted",
		Message:            "prep phase completed, awaiting model resumption",
		LastTransitionTime: metav1.NewTime(now.Add(-2 * time.Minute)),
	})
	resumingReview.Status.StartTime = &metav1.Time{Time: now.Add(-3 * time.Minute)}
	resumingReview.Status.JobName = resumingReview.Name + "-worker"

	// Resumption trigger annotation
	if resumingReview.Annotations == nil {
		resumingReview.Annotations = make(map[string]string)
	}
	resumingReview.Annotations[job.JobPhaseLabel] = job.JobPhaseContinuation

	initObjects = append(initObjects, resumingReview)

	kube := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(initObjects...).
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}, &batchv1.Job{}).
		Build()

	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client:            kube,
		Scheme:            scheme,
		MaxConcurrentJobs: 10,
		Now:               func() time.Time { return now },
	}

	resumingReq := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: resumingReview.Namespace, Name: resumingReview.Name}}

	// STEP 1: Reconcile resuming review under saturation (10 active jobs)
	res1, err := reconciler.Reconcile(context.Background(), resumingReq)
	if err != nil {
		t.Fatalf("step 1 reconcile: %v", err)
	}
	if res1.RequeueAfter == 0 {
		t.Fatalf("expected requeue under saturation, got RequeueAfter == 0")
	}

	// Verify resuming review state
	var updatedResuming reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), resumingReq.NamespacedName, &updatedResuming); err != nil {
		t.Fatal(err)
	}

	if updatedResuming.Status.Phase != reviewv1alpha2.PhaseQueued {
		t.Fatalf("expected phase %s under saturation, got %s", reviewv1alpha2.PhaseQueued, updatedResuming.Status.Phase)
	}
	if updatedResuming.Annotations[job.JobPhaseLabel] != job.JobPhaseContinuation {
		t.Fatalf("resumption annotation lost! expected %q, got %q", job.JobPhaseContinuation, updatedResuming.Annotations[job.JobPhaseLabel])
	}
	cond := meta.FindStatusCondition(updatedResuming.Status.Conditions, reviewv1alpha2.ConditionAwaitingResumption)
	if cond == nil || cond.Status != metav1.ConditionTrue {
		t.Fatalf("ConditionAwaitingResumption must remain True while queued, got: %#v", cond)
	}

	// Verify NO continuation Job was created
	var continuationJob batchv1.Job
	continuationJobName := resumingReview.Name + "-continuation"
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: resumingReview.Namespace, Name: continuationJobName}, &continuationJob); err == nil {
		t.Fatalf("continuation Job must NOT be created under saturated concurrency")
	}

	// STEP 2: Free 1 slot by completing activeJob[0]
	markWorkerSucceeded(t, kube, activeJobs[0], metav1.NewTime(now))

	var checkJob batchv1.Job
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: activeJobs[0].Namespace, Name: activeJobs[0].Name}, &checkJob); err != nil {
		t.Fatal(err)
	}
	t.Logf("checkJob.Status.Succeeded = %d, checkJob.Status.Active = %d", checkJob.Status.Succeeded, checkJob.Status.Active)

	// Now active jobs = 9. Reconcile resuming review.
	// Since olderQueued has earlier ReceivedAt (T0 < T1), resumingReview MUST wait in FIFO order!
	res2, err := reconciler.Reconcile(context.Background(), resumingReq)
	if err != nil {
		t.Fatalf("step 2 reconcile: %v", err)
	}
	if res2.RequeueAfter == 0 {
		t.Fatalf("expected requeue waiting for older candidate in FIFO order")
	}

	if err := kube.Get(context.Background(), resumingReq.NamespacedName, &updatedResuming); err != nil {
		t.Fatal(err)
	}
	t.Logf("res2 updatedResuming.Status.Phase=%s, Message=%q", updatedResuming.Status.Phase, updatedResuming.Status.Message)
	if updatedResuming.Status.Message != "waiting for an older worker admission candidate" {
		t.Fatalf("expected message 'waiting for an older worker admission candidate', got %q", updatedResuming.Status.Message)
	}

	// STEP 3: Reconcile olderQueued - it should admit!
	olderReq := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: olderQueued.Namespace, Name: olderQueued.Name}}
	res3, err := reconciler.Reconcile(context.Background(), olderReq)
	if err != nil {
		t.Fatalf("step 3 reconcile older: %v", err)
	}
	if res3.RequeueAfter > 0 {
		t.Fatalf("older queued review should admit, got RequeueAfter: %v", res3.RequeueAfter)
	}

	var olderWorker batchv1.Job
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: olderQueued.Namespace, Name: olderQueued.Name + "-worker"}, &olderWorker); err != nil {
		t.Fatalf("expected older queued review worker to be created, got %v", err)
	}
	olderWorker.Status.Active = 1
	if err := kube.Update(context.Background(), &olderWorker); err != nil {
		t.Fatal(err)
	}

	// Active jobs is now 10 again. Resuming review must still wait.
	res4, err := reconciler.Reconcile(context.Background(), resumingReq)
	if err != nil {
		t.Fatalf("step 4 reconcile resuming: %v", err)
	}
	if res4.RequeueAfter == 0 {
		t.Fatalf("expected resuming review to wait when capacity saturated again")
	}

	// STEP 4: Free another slot by completing activeJobs[1]
	markWorkerSucceeded(t, kube, activeJobs[1], metav1.NewTime(now))

	// Now active jobs = 9, and NO older candidates!
	// Resuming review MUST admit and launch continuation Job!
	res5, err := reconciler.Reconcile(context.Background(), resumingReq)
	if err != nil {
		t.Fatalf("step 5 reconcile resuming: %v", err)
	}
	if res5.RequeueAfter > 0 {
		t.Fatalf("resuming review must admit when capacity freed and no older candidate, got RequeueAfter: %v", res5.RequeueAfter)
	}

	// Verify continuation Job was created
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: resumingReview.Namespace, Name: continuationJobName}, &continuationJob); err != nil {
		t.Fatalf("continuation Job %q was NOT created: %v", continuationJobName, err)
	}

	// Verify PRReviewJob status
	if err := kube.Get(context.Background(), resumingReq.NamespacedName, &updatedResuming); err != nil {
		t.Fatal(err)
	}
	if updatedResuming.Status.Phase != reviewv1alpha2.PhaseRunning {
		t.Fatalf("expected phase %s, got %s", reviewv1alpha2.PhaseRunning, updatedResuming.Status.Phase)
	}
	if updatedResuming.Status.JobName != continuationJobName {
		t.Fatalf("expected jobName %s, got %s", continuationJobName, updatedResuming.Status.JobName)
	}
	resumpCond := meta.FindStatusCondition(updatedResuming.Status.Conditions, reviewv1alpha2.ConditionAwaitingResumption)
	if resumpCond == nil || resumpCond.Status != metav1.ConditionFalse || resumpCond.Reason != "Resumed" {
		t.Fatalf("expected ConditionAwaitingResumption = False (Resumed), got: %#v", resumpCond)
	}
}

// TestChallengerM4_1_ResumptionUnderSaturation_MissingConditionAwaitingResumption_Deadlock
// tests what happens when a review in PhaseAwaitingResumption (WITHOUT the ConditionAwaitingResumption condition)
// is queued due to saturated concurrency, and then capacity frees up.
// When Phase transitions to PhaseQueued, it loses the PhaseAwaitingResumption match on line 202,
// falls through to line 388, and wedges in a 2-second requeue loop forever.
func TestChallengerM4_1_ResumptionUnderSaturation_MissingConditionAwaitingResumption_Deadlock(t *testing.T) {
	now := time.Date(2026, 9, 28, 14, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)

	// Review in PhaseAwaitingResumption, but ConditionAwaitingResumption is NOT set in Conditions
	resumingReview := v1alpha2Review(now)
	resumingReview.Name = "ct-review-no-cond"
	resumingReview.Spec.RunID = "run_99000000000000000000000000000000"
	resumingReview.Spec.RunSecretName = "ct-review-run-99000000000000000000000000000000"
	resumingReview.Status.Phase = reviewv1alpha2.PhaseAwaitingResumption
	resumingReview.Status.JobName = resumingReview.Name + "-worker"
	resumingReview.Status.StartTime = &metav1.Time{Time: now.Add(-5 * time.Minute)}
	// Empty conditions - ConditionAwaitingResumption is NOT set
	resumingReview.Status.Conditions = []metav1.Condition{}
	resumingReview.Annotations = map[string]string{job.JobPhaseLabel: job.JobPhaseContinuation}

	// 1 active job running, MaxConcurrentJobs = 1 (saturated)
	revActive := v1alpha2Review(now.Add(-10 * time.Minute))
	revActive.Name = "ct-review-active"
	revActive.Spec.RunID = "run_88000000000000000000000000000000"
	revActive.Spec.RunSecretName = "ct-review-run-88000000000000000000000000000000"
	revActive.Status.Phase = reviewv1alpha2.PhaseRunning
	revActive.Status.JobName = revActive.Name + "-worker"
	revActive.Status.StartTime = &metav1.Time{Time: now.Add(-5 * time.Minute)}

	activeJob, err := job.BuildWorkerJob(job.Input{
		Review:         revActive,
		WorkspaceLease: testLeaseFixture(now, revActive.Spec.RepositoryID, revActive.Spec.PRNumber, revActive.Spec.RunID),
		Now:            now,
		Phase:          job.JobPhasePrep,
	})
	if err != nil {
		t.Fatal(err)
	}
	activeJob.Status.Active = 1

	kube := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(resumingReview, revActive, activeJob).
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}, &batchv1.Job{}).
		Build()

	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client:            kube,
		Scheme:            scheme,
		MaxConcurrentJobs: 1,
		Now:               func() time.Time { return now },
	}

	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: resumingReview.Namespace, Name: resumingReview.Name}}

	// Pass 1: Saturated. Review transitions to PhaseQueued.
	res1, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	if res1.RequeueAfter == 0 {
		t.Fatalf("expected requeue when capacity exceeded")
	}

	var updated reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), req.NamespacedName, &updated); err != nil {
		t.Fatal(err)
	}
	t.Logf("Pass 1: Phase=%s, Message=%s", updated.Status.Phase, updated.Status.Message)
	if updated.Status.Phase != reviewv1alpha2.PhaseQueued {
		t.Fatalf("expected PhaseQueued, got %s", updated.Status.Phase)
	}

	// Pass 2: Active job completes! Capacity is now available!
	markWorkerSucceeded(t, kube, activeJob, metav1.NewTime(now))

	res2, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}

	if err := kube.Get(context.Background(), req.NamespacedName, &updated); err != nil {
		t.Fatal(err)
	}
	t.Logf("Pass 2: RequeueAfter=%v, Phase=%s, JobName=%s", res2.RequeueAfter, updated.Status.Phase, updated.Status.JobName)

	// Check if continuation Job was created or if controller wedged in 2s requeue loop
	var continuationJob batchv1.Job
	continuationJobName := resumingReview.Name + "-continuation"
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: resumingReview.Namespace, Name: continuationJobName}, &continuationJob); err != nil {
		t.Errorf("DEADLOCK BUG CONFIRMED: Continuation Job %q was NOT created when capacity freed up! Review is stuck in Phase=%s with RequeueAfter=%v: %v",
			continuationJobName, updated.Status.Phase, res2.RequeueAfter, err)
	}
}

// =========================================================================
// 2. ADMISSION SNAPSHOT DOUBLE-COUNTING EMPIRICAL CHALLENGES
// =========================================================================

// TestChallengerM4_1_AdmissionSnapshot_DoesNotDoubleCountContinuationOrAwaitingResumption
// rigorously verifies that:
// 1. A running continuation Job is counted as exactly 1 active worker, not 2.
// 2. Reviews in PhaseAwaitingResumption consume 0 worker slots.
// 3. A candidate review does not count against itself even if it has prior worker evidence.
// 4. Completed/deleted prep worker jobs do not leave phantom reservations.
func TestChallengerM4_1_AdmissionSnapshot_DoesNotDoubleCountContinuationOrAwaitingResumption(t *testing.T) {
	now := time.Date(2026, 9, 28, 14, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)

	// Review 1: Has an active continuation Job
	rev1 := v1alpha2Review(now.Add(-10 * time.Minute))
	rev1.Name = "ct-review-rev1"
	rev1.Spec.RunID = "run_11111111111111111111111111111111"
	rev1.Spec.PRNumber = 301
	rev1.Status.Phase = reviewv1alpha2.PhaseRunning
	rev1.Spec.RunSecretName = "ct-review-run-11111111111111111111111111111111"
	rev1.Status.JobName = rev1.Name + "-continuation"
	rev1.Status.StartTime = &metav1.Time{Time: now.Add(-5 * time.Minute)}

	job1, err := job.BuildWorkerJob(job.Input{
		Review:         rev1,
		WorkspaceLease: testLeaseFixture(now, rev1.Spec.RepositoryID, rev1.Spec.PRNumber, rev1.Spec.RunID),
		Now:            now,
		Phase:          job.JobPhaseContinuation,
	})
	if err != nil {
		t.Fatal(err)
	}
	job1.Status.Active = 1

	// Review 2: In PhaseAwaitingResumption (prep finished, prep job deleted)
	rev2 := v1alpha2Review(now.Add(-8 * time.Minute))
	rev2.Name = "ct-review-rev2"
	rev2.Spec.RunID = "run_22222222222222222222222222222222"
	rev2.Spec.RunSecretName = "ct-review-run-22222222222222222222222222222222"
	rev2.Spec.PRNumber = 302
	rev2.Status.Phase = reviewv1alpha2.PhaseAwaitingResumption
	meta.SetStatusCondition(&rev2.Status.Conditions, metav1.Condition{
		Type:               reviewv1alpha2.ConditionAwaitingResumption,
		Status:             metav1.ConditionTrue,
		Reason:             "PrepCompleted",
		LastTransitionTime: metav1.NewTime(now.Add(-6 * time.Minute)),
	})
	rev2.Status.JobName = rev2.Name + "-worker"
	rev2.Status.StartTime = &metav1.Time{Time: now.Add(-7 * time.Minute)}

	// Review 3: Another in PhaseAwaitingResumption WITH continuation requested
	rev3 := v1alpha2Review(now.Add(-6 * time.Minute))
	rev3.Name = "ct-review-rev3"
	rev3.Spec.RunID = "run_33333333333333333333333333333333"
	rev3.Spec.RunSecretName = "ct-review-run-33333333333333333333333333333333"
	rev3.Spec.PRNumber = 303
	rev3.Status.Phase = reviewv1alpha2.PhaseAwaitingResumption
	meta.SetStatusCondition(&rev3.Status.Conditions, metav1.Condition{
		Type:               reviewv1alpha2.ConditionAwaitingResumption,
		Status:             metav1.ConditionTrue,
		Reason:             "PrepCompleted",
		LastTransitionTime: metav1.NewTime(now.Add(-5 * time.Minute)),
	})
	rev3.Status.JobName = rev3.Name + "-worker"
	rev3.Status.StartTime = &metav1.Time{Time: now.Add(-5 * time.Minute)}
	rev3.Annotations = map[string]string{job.JobPhaseLabel: job.JobPhaseContinuation}

	// Review 4: Candidate trying to admit. Limit = 2.
	// Only Review 1 has an active worker (active count = 1).
	// If double-counting occurred (e.g. rev1 counted twice, or rev2/rev3 counted as active), active >= 2 would block rev4!
	rev4 := v1alpha2Review(now.Add(-1 * time.Minute))
	rev4.Name = "ct-review-rev4"
	rev4.Spec.RunID = "run_44444444444444444444444444444444"
	rev4.Spec.RunSecretName = "ct-review-run-44444444444444444444444444444444"
	rev4.Spec.PRNumber = 304

	kube := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(rev1, job1, rev2, rev3, rev4).
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).
		Build()

	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client:            kube,
		Scheme:            scheme,
		MaxConcurrentJobs: 2,
		Now:               func() time.Time { return now },
	}

	// Reconcile rev3 (resumption candidate): should admit because active = 1 < limit = 2
	req3 := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: rev3.Namespace, Name: rev3.Name}}
	res3, err := reconciler.Reconcile(context.Background(), req3)
	if err != nil {
		t.Fatalf("reconcile rev3: %v", err)
	}
	if res3.RequeueAfter > 0 {
		t.Fatalf("rev3 was unexpectedly rejected/queued: RequeueAfter: %v", res3.RequeueAfter)
	}

	var job3 batchv1.Job
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: rev3.Namespace, Name: rev3.Name + "-continuation"}, &job3); err != nil {
		t.Fatalf("expected rev3 continuation job to be created: %v", err)
	}
}

// =========================================================================
// 3. RACE CONDITIONS: CONTINUATION JOB RAPID COMPLETION & NOTFOUND
// =========================================================================

// TestChallengerM4_1_RaceCondition_ContinuationJobCompletesBeforeNextReconciliation
// tests the race condition where the continuation Job finishes and succeeds
// before the controller's subsequent reconciliation pass runs.
func TestChallengerM4_1_RaceCondition_ContinuationJobCompletesBeforeNextReconciliation(t *testing.T) {
	now := time.Date(2026, 9, 28, 14, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)

	review := v1alpha2Review(now)
	continuationJobName := review.Name + "-continuation"
	review.Status.Phase = reviewv1alpha2.PhaseRunning
	review.Status.JobName = continuationJobName
	review.Status.StartTime = &metav1.Time{Time: now.Add(-2 * time.Minute)}
	if review.Annotations == nil {
		review.Annotations = make(map[string]string)
	}
	review.Annotations[job.JobPhaseLabel] = job.JobPhaseContinuation

	// Build continuation job that has already completed
	jobObj, err := job.BuildWorkerJob(job.Input{
		Review:         review,
		WorkspaceLease: testLeaseFixture(now, review.Spec.RepositoryID, review.Spec.PRNumber, review.Spec.RunID),
		Now:            now,
		Phase:          job.JobPhaseContinuation,
	})
	if err != nil {
		t.Fatal(err)
	}
	attachReceiptAnnotations(jobObj)
	jobObj.Status.Succeeded = 1

	kube := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(review, jobObj).
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).
		Build()

	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client: kube,
		Scheme: scheme,
		Now:    func() time.Time { return now },
	}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	_, err = reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("reconcile fast-completed continuation job: %v", err)
	}

	var updated reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), req.NamespacedName, &updated); err != nil {
		t.Fatal(err)
	}

	// Must transition cleanly to PhaseSucceeded
	if updated.Status.Phase != reviewv1alpha2.PhaseSucceeded {
		t.Fatalf("expected PhaseSucceeded, got %s (message: %s)", updated.Status.Phase, updated.Status.Message)
	}

	// Job TTL must be patched to 0 for collection
	var updatedJob batchv1.Job
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: continuationJobName}, &updatedJob); err != nil {
		t.Fatal(err)
	}
	if updatedJob.Spec.TTLSecondsAfterFinished == nil || *updatedJob.Spec.TTLSecondsAfterFinished != 0 {
		t.Fatalf("expected TTL 0 on finished continuation job, got %v", updatedJob.Spec.TTLSecondsAfterFinished)
	}
}

// TestChallengerM4_1_RaceCondition_ContinuationJobMissingNotFound_FailsClosed
// tests that if the continuation Job was created and recorded in status.JobName,
// but disappears (errors.IsNotFound) without terminal status or receipts,
// the controller fails closed with WorkerJobMissing and does NOT leak or promote.
func TestChallengerM4_1_RaceCondition_ContinuationJobMissingNotFound_FailsClosed(t *testing.T) {
	now := time.Date(2026, 9, 28, 14, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)

	review := v1alpha2Review(now)
	continuationJobName := review.Name + "-continuation"
	review.Status.Phase = reviewv1alpha2.PhaseRunning
	review.Status.JobName = continuationJobName
	review.Status.StartTime = &metav1.Time{Time: now.Add(-5 * time.Minute)}
	if review.Annotations == nil {
		review.Annotations = make(map[string]string)
	}
	review.Annotations[job.JobPhaseLabel] = job.JobPhaseContinuation

	// The continuation Job is absent from the cluster (deleted/NotFound)
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

	_, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("reconcile missing continuation job: %v", err)
	}

	var updated reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), req.NamespacedName, &updated); err != nil {
		t.Fatal(err)
	}

	// Controller must fail closed with WorkerJobMissing
	if updated.Status.Phase != reviewv1alpha2.PhaseFailed {
		t.Fatalf("expected PhaseFailed for missing continuation job, got %s", updated.Status.Phase)
	}
	readyCond := meta.FindStatusCondition(updated.Status.Conditions, "Ready")
	if readyCond == nil || readyCond.Reason != "WorkerJobMissing" {
		t.Fatalf("expected Reason == WorkerJobMissing, got: %#v", readyCond)
	}
}

// =========================================================================
// 4. ADVERSARIAL TIMING: RESUMPTION ANNOTATION ADDED DURING PREP PHASE
// =========================================================================

// TestChallengerM4_1_ResumptionAnnotationAddedWhileInPhaseRunning_PrepJob
// empirically challenges the operator behavior when the resumption annotation
// is added prematurely while the review is still in PhaseRunning (prep phase).
//
// 1. Verifies that it does NOT launch a duplicate continuation job prematurely.
// 2. Verifies whether the controller correctly reconciles the active prep job
//    to completion, OR if it gets stuck looking for -continuation job.
func TestChallengerM4_1_ResumptionAnnotationAddedWhileInPhaseRunning_PrepJob(t *testing.T) {
	now := time.Date(2026, 9, 28, 14, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)

	review := v1alpha2Review(now)
	prepJobName := review.Name + "-worker"
	review.Status.Phase = reviewv1alpha2.PhaseRunning
	review.Status.JobName = prepJobName
	review.Status.StartTime = &metav1.Time{Time: now.Add(-1 * time.Minute)}

	prepJob, err := job.BuildWorkerJob(job.Input{
		Review:         review,
		WorkspaceLease: testLeaseFixture(now, review.Spec.RepositoryID, review.Spec.PRNumber, review.Spec.RunID),
		Now:            now,
		Phase:          job.JobPhasePrep,
	})
	if err != nil {
		t.Fatal(err)
	}
	prepJob.Status.Active = 1
	prepJob.Finalizers = []string{"review-yeti.ai/terminal-outcome"}

	// Adversarial trigger: resumption annotation is attached PREMATURELY while prep is still running
	if review.Annotations == nil {
		review.Annotations = make(map[string]string)
	}
	review.Annotations[job.JobPhaseLabel] = job.JobPhaseContinuation

	kube := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(review, prepJob).
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}, &batchv1.Job{}).
		Build()

	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client: kube,
		Scheme: scheme,
		Now:    func() time.Time { return now },
	}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	// Pass 1: Prep job is still active. Premature annotation must NOT launch a duplicate continuation job!
	res1, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("pass 1 reconcile: %v", err)
	}
	_ = res1

	// Verify no continuation Job was created
	var continuationJob batchv1.Job
	continuationJobName := review.Name + "-continuation"
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: continuationJobName}, &continuationJob); err == nil {
		t.Fatalf("DUPLICATE JOB LAUNCHED PREMATURELY! Continuation job %q exists while prep job is running!", continuationJobName)
	}

	// Pass 2: Prep job now succeeds in the cluster!
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: prepJobName}, prepJob); err != nil {
		t.Fatal(err)
	}
	prepJob.Status.Active = 0
	markWorkerSucceeded(t, kube, prepJob, metav1.NewTime(now))

	res2, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("pass 2 reconcile after prep success: %v", err)
	}

	var updated reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), req.NamespacedName, &updated); err != nil {
		t.Fatal(err)
	}

	// The controller should have transitioned the prep job completion cleanly.
	// If it wedged in line 388 because resolveWorkerJobName returned -continuation,
	// updated.Status.Phase will still be PhaseRunning with JobName = -worker and no continuation job!
	t.Logf("Pass 2 result: RequeueAfter=%v, Phase=%s, JobName=%s, Conditions=%+v",
		res2.RequeueAfter, updated.Status.Phase, updated.Status.JobName, updated.Status.Conditions)

	if updated.Status.Phase == reviewv1alpha2.PhaseRunning && updated.Status.JobName == prepJobName {
		t.Errorf("CONTROLLER WEDGED: Premature resumption annotation caused controller to ignore prep job completion! Status is still %s with JobName=%s, RequeueAfter=%v",
			updated.Status.Phase, updated.Status.JobName, res2.RequeueAfter)
	}
}
