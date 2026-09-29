package controllers_test

import (
	"context"
	"testing"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	coordinationv1 "k8s.io/api/coordination/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	reviewv1alpha2 "github.com/calltelemetry/ct-review-bot/k8s-operator/api/v1alpha2"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/controllers"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/job"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/workspace"
)

func testLeaseFixture(now time.Time, repoID int64, prNumber int32, runID string) workspace.LeaseAcquireResult {
	labels, annotations := workspace.Metadata(repoID, prNumber)
	holder := runID
	seconds := int32(16 * 60)
	renewed := metav1.NewMicroTime(now)
	return workspace.LeaseAcquireResult{
		Acquired:       true,
		HolderIdentity: runID,
		Lease: &coordinationv1.Lease{
			ObjectMeta: metav1.ObjectMeta{
				Name:        workspace.LeaseName(repoID, prNumber),
				Namespace:   "ct-review-system",
				Labels:      labels,
				Annotations: annotations,
			},
			Spec: coordinationv1.LeaseSpec{
				HolderIdentity:       &holder,
				LeaseDurationSeconds: &seconds,
				RenewTime:            &renewed,
			},
		},
	}
}

func TestPRReviewJobV1Alpha2Reconciler_ContinuationResumption(t *testing.T) {
	now := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	review := v1alpha2Review(now)

	// Set review into PhaseAwaitingResumption with ConditionAwaitingResumption = True
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

	// Resumption trigger: annotation review-yeti.ai/job-phase = continuation
	if review.Annotations == nil {
		review.Annotations = make(map[string]string)
	}
	review.Annotations[job.JobPhaseLabel] = job.JobPhaseContinuation

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

	result, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("reconcile continuation resumption: %v", err)
	}
	if result.RequeueAfter > 0 {
		t.Fatalf("expected immediate continuation Job creation, got RequeueAfter: %v", result.RequeueAfter)
	}

	// 1. Verify continuation Job was created with name <review.Name>-continuation
	continuationJobName := review.Name + "-continuation"
	var continuationJob batchv1.Job
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: continuationJobName}, &continuationJob); err != nil {
		t.Fatalf("expected continuation Job %q to be created, got error: %v", continuationJobName, err)
	}

	if continuationJob.Labels[job.JobPhaseLabel] != job.JobPhaseContinuation {
		t.Fatalf("expected Job label %q = %q, got %q", job.JobPhaseLabel, job.JobPhaseContinuation, continuationJob.Labels[job.JobPhaseLabel])
	}

	// 2. Verify PRReviewJob status transition
	var updated reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), req.NamespacedName, &updated); err != nil {
		t.Fatalf("get updated review: %v", err)
	}

	if updated.Status.Phase != reviewv1alpha2.PhaseRunning {
		t.Fatalf("expected status.phase = %s, got %s", reviewv1alpha2.PhaseRunning, updated.Status.Phase)
	}
	if updated.Status.JobName != continuationJobName {
		t.Fatalf("expected status.jobName = %q, got %q", continuationJobName, updated.Status.JobName)
	}

	// 3. Verify ConditionAwaitingResumption transitioned to False with Reason Resumed
	resumpCond := meta.FindStatusCondition(updated.Status.Conditions, reviewv1alpha2.ConditionAwaitingResumption)
	if resumpCond == nil {
		t.Fatal("expected ConditionAwaitingResumption in conditions")
	}
	if resumpCond.Status != metav1.ConditionFalse {
		t.Fatalf("expected ConditionAwaitingResumption = False, got %s", resumpCond.Status)
	}
	if resumpCond.Reason != "Resumed" {
		t.Fatalf("expected ConditionAwaitingResumption reason = Resumed, got %s", resumpCond.Reason)
	}
}

func TestPRReviewJobV1Alpha2Reconciler_ContinuationResumptionViaResumedAnnotation(t *testing.T) {
	now := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	review := v1alpha2Review(now)

	review.Status.Phase = reviewv1alpha2.PhaseAwaitingResumption
	meta.SetStatusCondition(&review.Status.Conditions, metav1.Condition{
		Type:               reviewv1alpha2.ConditionAwaitingResumption,
		Status:             metav1.ConditionTrue,
		Reason:             "PrepCompleted",
		LastTransitionTime: metav1.NewTime(now.Add(-2 * time.Minute)),
	})
	review.Status.StartTime = &metav1.Time{Time: now.Add(-3 * time.Minute)}

	// Resumption trigger via review-yeti.ai/resumed: "true"
	if review.Annotations == nil {
		review.Annotations = make(map[string]string)
	}
	review.Annotations["review-yeti.ai/resumed"] = "true"

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
		t.Fatalf("reconcile continuation resumption: %v", err)
	}

	continuationJobName := review.Name + "-continuation"
	var continuationJob batchv1.Job
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: continuationJobName}, &continuationJob); err != nil {
		t.Fatalf("expected continuation Job %q to be created, got error: %v", continuationJobName, err)
	}
}

func TestPRReviewJobV1Alpha2Reconciler_AwaitingResumptionRemainsIdleWithoutAnnotation(t *testing.T) {
	now := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	review := v1alpha2Review(now)

	review.Status.Phase = reviewv1alpha2.PhaseAwaitingResumption
	meta.SetStatusCondition(&review.Status.Conditions, metav1.Condition{
		Type:               reviewv1alpha2.ConditionAwaitingResumption,
		Status:             metav1.ConditionTrue,
		Reason:             "PrepCompleted",
		LastTransitionTime: metav1.NewTime(now.Add(-2 * time.Minute)),
	})

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

	result, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if result.RequeueAfter != 0 {
		t.Fatalf("expected no requeue, got: %v", result.RequeueAfter)
	}

	var jobs batchv1.JobList
	if err := kube.List(context.Background(), &jobs); err != nil {
		t.Fatal(err)
	}
	if len(jobs.Items) > 0 {
		t.Fatalf("expected 0 jobs created while awaiting resumption, got %d", len(jobs.Items))
	}
}

func TestPRReviewJobV1Alpha2Reconciler_ContinuationAdmissionNoDoubleCounting(t *testing.T) {
	now := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)

	// Review 1 has an active continuation Job
	review1 := v1alpha2Review(now.Add(-1 * time.Second))
	review1.Name = "ct-review-review1"
	review1.Spec.RunID = "run_11111111111111111111111111111111"
	review1.Status.Phase = reviewv1alpha2.PhaseRunning
	review1.Status.JobName = review1.Name + "-continuation"
	review1.Status.StartTime = &metav1.Time{Time: now.Add(-1 * time.Second)}

	activeContinuationJob, err := job.BuildWorkerJob(job.Input{
		Review:         review1,
		WorkspaceLease: testLeaseFixture(now, review1.Spec.RepositoryID, review1.Spec.PRNumber, review1.Spec.RunID),
		Now:            now,
		Phase:          job.JobPhaseContinuation,
	})
	if err != nil {
		t.Fatalf("build active continuation worker: %v", err)
	}
	activeContinuationJob.Status.Active = 1

	// Review 2 is a new admission candidate
	review2 := v1alpha2Review(now)
	review2.Name = "ct-review-review2"
	review2.Spec.RunID = "run_22222222222222222222222222222222"
	review2.Spec.RunSecretName = "ct-review-run-22222222222222222222222222222222"
	review2.Spec.PRNumber = 43

	// Limit is 2 slots. With review1 running, active count should be exactly 1, allowing review2 to admit.
	kube := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(review1, review2, activeContinuationJob).
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).
		Build()

	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client:            kube,
		Scheme:            scheme,
		MaxConcurrentJobs: 2,
		Now:               func() time.Time { return now },
	}

	// Reconcile review2 - should be admitted (1 active job + 0 double counting < limit of 2)
	req2 := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review2.Namespace, Name: review2.Name}}
	result, err := reconciler.Reconcile(context.Background(), req2)
	if err != nil {
		t.Fatalf("reconcile review2: %v", err)
	}
	if result.RequeueAfter > 0 {
		t.Fatalf("review2 was queued unexpectedly (possible double-counting of continuation job): RequeueAfter %v", result.RequeueAfter)
	}

	// Confirm review2 worker was created
	var review2Job batchv1.Job
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review2.Namespace, Name: review2.Name + "-worker"}, &review2Job); err != nil {
		t.Fatalf("expected review2 worker to be admitted, got err: %v", err)
	}
}

func TestPRReviewJobV1Alpha2Reconciler_ContinuationCompletionPromotesToSucceeded(t *testing.T) {
	now := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)

	review := v1alpha2Review(now)
	continuationJobName := review.Name + "-continuation"
	review.Status.Phase = reviewv1alpha2.PhaseRunning
	review.Status.JobName = continuationJobName
	review.Status.StartTime = &metav1.Time{Time: now.Add(-5 * time.Minute)}

	successContinuationJob, err := job.BuildWorkerJob(job.Input{
		Review:         review,
		WorkspaceLease: testLeaseFixture(now, review.Spec.RepositoryID, review.Spec.PRNumber, review.Spec.RunID),
		Now:            now,
		Phase:          job.JobPhaseContinuation,
	})
	if err != nil {
		t.Fatalf("build success continuation worker: %v", err)
	}
	attachReceiptAnnotations(successContinuationJob)
	successContinuationJob.Status.Succeeded = 1

	kube := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(review, successContinuationJob).
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
		t.Fatalf("reconcile: %v", err)
	}

	var updated reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), req.NamespacedName, &updated); err != nil {
		t.Fatal(err)
	}

	// Verify promotion to PhaseSucceeded
	if updated.Status.Phase != reviewv1alpha2.PhaseSucceeded {
		t.Fatalf("expected phase %s, got %s", reviewv1alpha2.PhaseSucceeded, updated.Status.Phase)
	}

	// Verify TTL on Job was patched to 0
	var updatedJob batchv1.Job
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: continuationJobName}, &updatedJob); err != nil {
		t.Fatal(err)
	}
	if updatedJob.Spec.TTLSecondsAfterFinished == nil || *updatedJob.Spec.TTLSecondsAfterFinished != 0 {
		t.Fatalf("expected Job TTLSecondsAfterFinished = 0, got %v", updatedJob.Spec.TTLSecondsAfterFinished)
	}
}
