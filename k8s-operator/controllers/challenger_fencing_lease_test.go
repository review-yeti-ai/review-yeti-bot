package controllers_test

import (
	"context"
	"testing"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	coordinationv1 "k8s.io/api/coordination/v1"
	corev1 "k8s.io/api/core/v1"
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

// Helper to construct an active Job and Pod for a review
func createActiveJobAndPod(review *reviewv1alpha2.PRReviewJob) (*batchv1.Job, *corev1.Pod) {
	workerJob := &batchv1.Job{
		ObjectMeta: metav1.ObjectMeta{
			Name:      review.Name + "-worker",
			Namespace: review.Namespace,
			Labels: map[string]string{
				"review-yeti.ai/run-id":           review.Spec.RunID,
				"review-yeti.ai/publication-mode": review.Spec.PublicationMode,
			},
		},
		Spec: batchv1.JobSpec{
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{
					Labels: map[string]string{
						"review-yeti.ai/run-id":        review.Spec.RunID,
						"review-yeti.ai/component":     job.WorkerComponentFor(review.Spec.PublicationMode, review.Spec.QualificationProfile),
						"batch.kubernetes.io/job-name": review.Name + "-worker",
					},
				},
				Spec: corev1.PodSpec{
					Containers: []corev1.Container{{Name: "reviewer-worker", Image: review.Spec.WorkerImage}},
				},
			},
		},
		Status: batchv1.JobStatus{
			Active: 1,
		},
	}

	workerPod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      review.Name + "-worker-pod-0",
			Namespace: review.Namespace,
			Labels: map[string]string{
				"review-yeti.ai/run-id":        review.Spec.RunID,
				"review-yeti.ai/component":     job.WorkerComponentFor(review.Spec.PublicationMode, review.Spec.QualificationProfile),
				"batch.kubernetes.io/job-name": review.Name + "-worker",
			},
		},
		Spec: corev1.PodSpec{
			Containers: []corev1.Container{{Name: "reviewer-worker", Image: review.Spec.WorkerImage}},
		},
		Status: corev1.PodStatus{
			Phase: corev1.PodRunning,
		},
	}

	return workerJob, workerPod
}

// 1. Empirical Challenge: Fencing epoch mismatch with active running Pod and Job.
// Must set ConditionFencingEpochMismatch=True, PhaseFailed, and NOT delete or kill Pod or Job.
func TestChallengerEmpirical_FencingEpochMismatch_ActivePodAndJobNotKilled(t *testing.T) {
	now := time.Date(2026, 9, 27, 14, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	review := v1alpha2Review(now)
	review.Spec.FencingEpoch = 1
	review.Status.Phase = reviewv1alpha2.PhaseRunning
	review.Status.AuthoritativeFencingEpoch = 3 // Authoritative is higher (epoch mismatch)

	workerJob, workerPod := createActiveJobAndPod(review)

	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(review, workerJob, workerPod).WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: kube, Scheme: scheme, Now: func() time.Time { return now }}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	result, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("unexpected reconcile error: %v", err)
	}
	if result.RequeueAfter > 0 {
		t.Fatalf("expected immediate fail-closed, got requeueAfter %v", result.RequeueAfter)
	}

	var updated reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), req.NamespacedName, &updated); err != nil {
		t.Fatalf("get updated review: %v", err)
	}

	// Invariant: Phase must be PhaseFailed
	if updated.Status.Phase != reviewv1alpha2.PhaseFailed {
		t.Fatalf("status.phase = %s, want %s", updated.Status.Phase, reviewv1alpha2.PhaseFailed)
	}

	// Invariant: ConditionFencingEpochMismatch must be True with Reason EpochMismatch
	cond := meta.FindStatusCondition(updated.Status.Conditions, reviewv1alpha2.ConditionFencingEpochMismatch)
	if cond == nil {
		t.Fatal("ConditionFencingEpochMismatch condition was NOT set")
	}
	if cond.Status != metav1.ConditionTrue {
		t.Fatalf("ConditionFencingEpochMismatch status = %s, want True", cond.Status)
	}
	if cond.Reason != "EpochMismatch" {
		t.Fatalf("ConditionFencingEpochMismatch reason = %s, want EpochMismatch", cond.Reason)
	}

	// Invariant: Ready condition must be False
	readyCond := meta.FindStatusCondition(updated.Status.Conditions, "Ready")
	if readyCond == nil || readyCond.Status != metav1.ConditionFalse {
		t.Fatalf("Ready condition = %#v, want False", readyCond)
	}

	// Invariant: Active Job must NOT be deleted or mutated
	var survivingJob batchv1.Job
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: workerJob.Namespace, Name: workerJob.Name}, &survivingJob); err != nil {
		t.Fatalf("Worker Job was deleted or mutated on fencing epoch mismatch: %v", err)
	}
	if survivingJob.DeletionTimestamp != nil {
		t.Fatalf("Worker Job DeletionTimestamp is set (%v); should not be terminating", survivingJob.DeletionTimestamp)
	}

	// Invariant: Active Pod must NOT be deleted or killed
	var survivingPod corev1.Pod
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: workerPod.Namespace, Name: workerPod.Name}, &survivingPod); err != nil {
		t.Fatalf("Worker Pod was deleted on fencing epoch mismatch: %v", err)
	}
	if survivingPod.DeletionTimestamp != nil {
		t.Fatalf("Worker Pod DeletionTimestamp is set (%v); should not be terminating", survivingPod.DeletionTimestamp)
	}
	if survivingPod.Status.Phase != corev1.PodRunning {
		t.Fatalf("Worker Pod phase = %s, want PodRunning (Pod must not be killed)", survivingPod.Status.Phase)
	}

	// Subsequent reconcile check: simulate next reconcile cycle
	_, err = reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("subsequent reconcile error: %v", err)
	}
	// Verify Job and Pod still exist
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: workerJob.Namespace, Name: workerJob.Name}, &survivingJob); err != nil {
		t.Fatalf("Worker Job deleted in subsequent reconcile: %v", err)
	}
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: workerPod.Namespace, Name: workerPod.Name}, &survivingPod); err != nil {
		t.Fatalf("Worker Pod deleted in subsequent reconcile: %v", err)
	}
}

// 2. Empirical Challenge: Sibling reviews regression across multiple siblings.
// When multiple siblings exist in ct-review-system, candidate epoch is checked against
// the maximum authoritative epoch across all siblings.
func TestChallengerEmpirical_SiblingRegression_HighestAuthoritativeWins_PodNotKilled(t *testing.T) {
	now := time.Date(2026, 9, 27, 14, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)

	// Sibling 1 with epoch 2
	sib1 := v1alpha2Review(now)
	sib1.Name = "ct-review-sib-1-00000000000000000000"
	sib1.Spec.RunID = "run_sib100000000000000000000000000"
	sib1.Spec.FencingEpoch = 2
	sib1.Status.AuthoritativeFencingEpoch = 2

	// Sibling 2 with epoch 8 (highest)
	sib2 := v1alpha2Review(now)
	sib2.Name = "ct-review-sib-2-00000000000000000000"
	sib2.Spec.RunID = "run_sib200000000000000000000000000"
	sib2.Spec.FencingEpoch = 8
	sib2.Status.AuthoritativeFencingEpoch = 8

	// Sibling 3 with epoch 4
	sib3 := v1alpha2Review(now)
	sib3.Name = "ct-review-sib-3-00000000000000000000"
	sib3.Spec.RunID = "run_sib300000000000000000000000000"
	sib3.Spec.FencingEpoch = 4
	sib3.Status.AuthoritativeFencingEpoch = 4

	// Candidate review with epoch 5 (higher than sib1 and sib3, but lower than sib2's 8)
	candidate := v1alpha2Review(now)
	candidate.Name = "ct-review-cand-0000000000000000000"
	candidate.Spec.RunID = "run_cand00000000000000000000000000"
	candidate.Spec.FencingEpoch = 5
	candidate.Status.AuthoritativeFencingEpoch = 0 // uninitialized
	candidate.Status.Phase = reviewv1alpha2.PhaseRunning

	candidateJob, candidatePod := createActiveJobAndPod(candidate)

	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(sib1, sib2, sib3, candidate, candidateJob, candidatePod).WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: kube, Scheme: scheme, Now: func() time.Time { return now }}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: candidate.Namespace, Name: candidate.Name}}

	result, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("unexpected reconcile error: %v", err)
	}
	if result.RequeueAfter > 0 {
		t.Fatalf("expected immediate fail-closed, got requeueAfter %v", result.RequeueAfter)
	}

	var updated reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), req.NamespacedName, &updated); err != nil {
		t.Fatalf("get candidate: %v", err)
	}

	// Must fail-closed due to regression against sib2's epoch 8
	if updated.Status.Phase != reviewv1alpha2.PhaseFailed {
		t.Fatalf("candidate phase = %s, want PhaseFailed", updated.Status.Phase)
	}
	cond := meta.FindStatusCondition(updated.Status.Conditions, reviewv1alpha2.ConditionFencingEpochMismatch)
	if cond == nil || cond.Status != metav1.ConditionTrue {
		t.Fatalf("expected ConditionFencingEpochMismatch=True, got %#v", cond)
	}

	// Pod and Job must NOT be deleted or killed
	var survivingJob batchv1.Job
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: candidateJob.Namespace, Name: candidateJob.Name}, &survivingJob); err != nil {
		t.Fatalf("candidate Job was deleted: %v", err)
	}
	var survivingPod corev1.Pod
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: candidatePod.Namespace, Name: candidatePod.Name}, &survivingPod); err != nil {
		t.Fatalf("candidate Pod was deleted: %v", err)
	}
	if survivingPod.Status.Phase != corev1.PodRunning {
		t.Fatalf("candidate Pod phase = %s, want PodRunning", survivingPod.Status.Phase)
	}
}

// 3. Empirical Challenge: Stale worker lease token (mismatch between spec and active token).
// Must set ConditionStaleWorkerLease=True, PhaseFailed, and NOT delete Pod/Job.
func TestChallengerEmpirical_StaleWorkerLeaseToken_Mismatch_PodNotKilled(t *testing.T) {
	now := time.Date(2026, 9, 27, 14, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	review := v1alpha2Review(now)
	review.Spec.FencingEpoch = 1
	review.Status.AuthoritativeFencingEpoch = 1
	review.Spec.WorkerLeaseToken = "token-alpha"
	review.Status.ActiveWorkerLeaseToken = "token-beta" // Mismatch
	review.Status.Phase = reviewv1alpha2.PhaseRunning

	workerJob, workerPod := createActiveJobAndPod(review)

	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(review, workerJob, workerPod).WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: kube, Scheme: scheme, Now: func() time.Time { return now }}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	result, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("unexpected reconcile error: %v", err)
	}
	if result.RequeueAfter > 0 {
		t.Fatalf("expected immediate fail-closed, got %v", result.RequeueAfter)
	}

	var updated reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), req.NamespacedName, &updated); err != nil {
		t.Fatalf("get updated review: %v", err)
	}

	if updated.Status.Phase != reviewv1alpha2.PhaseFailed {
		t.Fatalf("status.phase = %s, want %s", updated.Status.Phase, reviewv1alpha2.PhaseFailed)
	}
	cond := meta.FindStatusCondition(updated.Status.Conditions, reviewv1alpha2.ConditionStaleWorkerLease)
	if cond == nil || cond.Status != metav1.ConditionTrue || cond.Reason != "LeaseExpired" {
		t.Fatalf("expected ConditionStaleWorkerLease=True (LeaseExpired), got %#v", cond)
	}

	// Verify Job and Pod are NOT deleted or killed
	var survivingJob batchv1.Job
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: workerJob.Namespace, Name: workerJob.Name}, &survivingJob); err != nil {
		t.Fatalf("Worker Job was deleted on stale worker lease token: %v", err)
	}
	var survivingPod corev1.Pod
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: workerPod.Namespace, Name: workerPod.Name}, &survivingPod); err != nil {
		t.Fatalf("Worker Pod was deleted on stale worker lease token: %v", err)
	}
	if survivingPod.Status.Phase != corev1.PodRunning {
		t.Fatalf("Worker Pod phase = %s, want PodRunning", survivingPod.Status.Phase)
	}
}

// 4. Empirical Challenge: Expired coordinationv1.Lease in ct-review-system.
// Must set ConditionStaleWorkerLease=True, PhaseFailed, and NOT delete Pod/Job.
func TestChallengerEmpirical_StaleWorkerLeaseToken_ExpiredLease_PodNotKilled(t *testing.T) {
	now := time.Date(2026, 9, 27, 14, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	review := v1alpha2Review(now)
	review.Spec.FencingEpoch = 1
	review.Status.AuthoritativeFencingEpoch = 1
	review.Spec.WorkerLeaseToken = "token-1"
	review.Status.Phase = reviewv1alpha2.PhaseRunning

	workerJob, workerPod := createActiveJobAndPod(review)

	leaseName := workspace.LeaseName(review.Spec.RepositoryID, review.Spec.PRNumber)
	pastTime := metav1.NewMicroTime(now.Add(-15 * time.Minute))
	duration := int32(120) // 2 minutes, expired 13 minutes ago
	holder := review.Spec.RunID
	transitions := int32(1)
	lease := &coordinationv1.Lease{
		ObjectMeta: metav1.ObjectMeta{
			Name:      leaseName,
			Namespace: review.Namespace,
			Labels: map[string]string{
				"review-yeti.ai/repository-id": "123",
				"review-yeti.ai/pr-number":     "42",
			},
		},
		Spec: coordinationv1.LeaseSpec{
			HolderIdentity:       &holder,
			LeaseDurationSeconds: &duration,
			AcquireTime:          &pastTime,
			RenewTime:            &pastTime,
			LeaseTransitions:     &transitions,
		},
	}

	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(review, lease, workerJob, workerPod).WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: kube, Scheme: scheme, Now: func() time.Time { return now }}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	result, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("unexpected reconcile error: %v", err)
	}
	if result.RequeueAfter > 0 {
		t.Fatalf("expected immediate fail-closed, got %v", result.RequeueAfter)
	}

	var updated reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), req.NamespacedName, &updated); err != nil {
		t.Fatalf("get updated review: %v", err)
	}

	if updated.Status.Phase != reviewv1alpha2.PhaseFailed {
		t.Fatalf("status.phase = %s, want %s", updated.Status.Phase, reviewv1alpha2.PhaseFailed)
	}
	cond := meta.FindStatusCondition(updated.Status.Conditions, reviewv1alpha2.ConditionStaleWorkerLease)
	if cond == nil || cond.Status != metav1.ConditionTrue || cond.Reason != "LeaseExpired" {
		t.Fatalf("expected ConditionStaleWorkerLease=True (LeaseExpired), got %#v", cond)
	}

	// Verify Job and Pod are NOT deleted or killed
	var survivingJob batchv1.Job
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: workerJob.Namespace, Name: workerJob.Name}, &survivingJob); err != nil {
		t.Fatalf("Worker Job was deleted on expired lease: %v", err)
	}
	var survivingPod corev1.Pod
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: workerPod.Namespace, Name: workerPod.Name}, &survivingPod); err != nil {
		t.Fatalf("Worker Pod was deleted on expired lease: %v", err)
	}
	if survivingPod.Status.Phase != corev1.PodRunning {
		t.Fatalf("Worker Pod phase = %s, want PodRunning", survivingPod.Status.Phase)
	}
}

// 5. Empirical Challenge: Worker lease held by another run.
// Must set ConditionStaleWorkerLease=True, PhaseFailed, and NOT delete Pod/Job.
func TestChallengerEmpirical_StaleWorkerLeaseToken_HeldByOtherRun_PodNotKilled(t *testing.T) {
	now := time.Date(2026, 9, 27, 14, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	review := v1alpha2Review(now)
	review.Spec.FencingEpoch = 1
	review.Status.AuthoritativeFencingEpoch = 1
	review.Spec.WorkerLeaseToken = "token-1"
	review.Status.Phase = reviewv1alpha2.PhaseRunning

	workerJob, workerPod := createActiveJobAndPod(review)

	leaseName := workspace.LeaseName(review.Spec.RepositoryID, review.Spec.PRNumber)
	freshTime := metav1.NewMicroTime(now.Add(-10 * time.Second))
	duration := int32(300)
	otherHolder := "run_someone_else_00000000000000000"
	transitions := int32(1)
	lease := &coordinationv1.Lease{
		ObjectMeta: metav1.ObjectMeta{
			Name:      leaseName,
			Namespace: review.Namespace,
		},
		Spec: coordinationv1.LeaseSpec{
			HolderIdentity:       &otherHolder, // Another run holds the lease
			LeaseDurationSeconds: &duration,
			AcquireTime:          &freshTime,
			RenewTime:            &freshTime,
			LeaseTransitions:     &transitions,
		},
	}

	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(review, lease, workerJob, workerPod).WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: kube, Scheme: scheme, Now: func() time.Time { return now }}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	result, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("unexpected reconcile error: %v", err)
	}
	if result.RequeueAfter > 0 {
		t.Fatalf("expected immediate fail-closed, got %v", result.RequeueAfter)
	}

	var updated reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), req.NamespacedName, &updated); err != nil {
		t.Fatalf("get updated review: %v", err)
	}

	if updated.Status.Phase != reviewv1alpha2.PhaseFailed {
		t.Fatalf("status.phase = %s, want %s", updated.Status.Phase, reviewv1alpha2.PhaseFailed)
	}
	cond := meta.FindStatusCondition(updated.Status.Conditions, reviewv1alpha2.ConditionStaleWorkerLease)
	if cond == nil || cond.Status != metav1.ConditionTrue || cond.Reason != "LeaseExpired" {
		t.Fatalf("expected ConditionStaleWorkerLease=True (LeaseExpired), got %#v", cond)
	}

	// Verify Job and Pod are NOT deleted or killed
	var survivingJob batchv1.Job
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: workerJob.Namespace, Name: workerJob.Name}, &survivingJob); err != nil {
		t.Fatalf("Worker Job was deleted when lease held by other run: %v", err)
	}
	var survivingPod corev1.Pod
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: workerPod.Namespace, Name: workerPod.Name}, &survivingPod); err != nil {
		t.Fatalf("Worker Pod was deleted when lease held by other run: %v", err)
	}
	if survivingPod.Status.Phase != corev1.PodRunning {
		t.Fatalf("Worker Pod phase = %s, want PodRunning", survivingPod.Status.Phase)
	}
}

// 6. Empirical Challenge: Worker lease terminating.
// Must set ConditionStaleWorkerLease=True, PhaseFailed, and NOT delete Pod/Job.
func TestChallengerEmpirical_StaleWorkerLeaseToken_LeaseTerminating_PodNotKilled(t *testing.T) {
	now := time.Date(2026, 9, 27, 14, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	review := v1alpha2Review(now)
	review.Spec.FencingEpoch = 1
	review.Status.AuthoritativeFencingEpoch = 1
	review.Spec.WorkerLeaseToken = "token-1"
	review.Status.Phase = reviewv1alpha2.PhaseRunning

	workerJob, workerPod := createActiveJobAndPod(review)

	leaseName := workspace.LeaseName(review.Spec.RepositoryID, review.Spec.PRNumber)
	freshTime := metav1.NewMicroTime(now.Add(-10 * time.Second))
	duration := int32(300)
	holder := review.Spec.RunID
	transitions := int32(1)
	deletionTime := metav1.NewTime(now)
	lease := &coordinationv1.Lease{
		ObjectMeta: metav1.ObjectMeta{
			Name:              leaseName,
			Namespace:         review.Namespace,
			DeletionTimestamp: &deletionTime, // Terminating lease
			Finalizers:        []string{"review-yeti.ai/hold"},
		},
		Spec: coordinationv1.LeaseSpec{
			HolderIdentity:       &holder,
			LeaseDurationSeconds: &duration,
			AcquireTime:          &freshTime,
			RenewTime:            &freshTime,
			LeaseTransitions:     &transitions,
		},
	}

	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(review, lease, workerJob, workerPod).WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: kube, Scheme: scheme, Now: func() time.Time { return now }}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	result, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("unexpected reconcile error: %v", err)
	}
	if result.RequeueAfter > 0 {
		t.Fatalf("expected immediate fail-closed, got %v", result.RequeueAfter)
	}

	var updated reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), req.NamespacedName, &updated); err != nil {
		t.Fatalf("get updated review: %v", err)
	}

	if updated.Status.Phase != reviewv1alpha2.PhaseFailed {
		t.Fatalf("status.phase = %s, want %s", updated.Status.Phase, reviewv1alpha2.PhaseFailed)
	}
	cond := meta.FindStatusCondition(updated.Status.Conditions, reviewv1alpha2.ConditionStaleWorkerLease)
	if cond == nil || cond.Status != metav1.ConditionTrue || cond.Reason != "LeaseExpired" {
		t.Fatalf("expected ConditionStaleWorkerLease=True (LeaseExpired), got %#v", cond)
	}

	// Verify Job and Pod are NOT deleted or killed
	var survivingJob batchv1.Job
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: workerJob.Namespace, Name: workerJob.Name}, &survivingJob); err != nil {
		t.Fatalf("Worker Job was deleted when lease is terminating: %v", err)
	}
	var survivingPod corev1.Pod
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: workerPod.Namespace, Name: workerPod.Name}, &survivingPod); err != nil {
		t.Fatalf("Worker Pod was deleted when lease is terminating: %v", err)
	}
	if survivingPod.Status.Phase != corev1.PodRunning {
		t.Fatalf("Worker Pod phase = %s, want PodRunning", survivingPod.Status.Phase)
	}
}

// 7. Empirical Challenge: Worker lease token annotation mismatch.
// Must set ConditionStaleWorkerLease=True, PhaseFailed, and NOT delete Pod/Job.
func TestChallengerEmpirical_StaleWorkerLeaseToken_AnnotationMismatch_PodNotKilled(t *testing.T) {
	now := time.Date(2026, 9, 27, 14, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	review := v1alpha2Review(now)
	review.Spec.FencingEpoch = 1
	review.Status.AuthoritativeFencingEpoch = 1
	review.Spec.WorkerLeaseToken = "token-wrong"
	review.Status.Phase = reviewv1alpha2.PhaseRunning

	workerJob, workerPod := createActiveJobAndPod(review)

	leaseName := workspace.LeaseName(review.Spec.RepositoryID, review.Spec.PRNumber)
	freshTime := metav1.NewMicroTime(now.Add(-10 * time.Second))
	duration := int32(300)
	holder := review.Spec.RunID
	transitions := int32(1)
	lease := &coordinationv1.Lease{
		ObjectMeta: metav1.ObjectMeta{
			Name:      leaseName,
			Namespace: review.Namespace,
			Annotations: map[string]string{
				"review-yeti.ai/lease-token": "token-correct", // Annotation differs from spec
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

	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(review, lease, workerJob, workerPod).WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: kube, Scheme: scheme, Now: func() time.Time { return now }}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	result, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("unexpected reconcile error: %v", err)
	}
	if result.RequeueAfter > 0 {
		t.Fatalf("expected immediate fail-closed, got %v", result.RequeueAfter)
	}

	var updated reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), req.NamespacedName, &updated); err != nil {
		t.Fatalf("get updated review: %v", err)
	}

	if updated.Status.Phase != reviewv1alpha2.PhaseFailed {
		t.Fatalf("status.phase = %s, want %s", updated.Status.Phase, reviewv1alpha2.PhaseFailed)
	}
	cond := meta.FindStatusCondition(updated.Status.Conditions, reviewv1alpha2.ConditionStaleWorkerLease)
	if cond == nil || cond.Status != metav1.ConditionTrue || cond.Reason != "LeaseExpired" {
		t.Fatalf("expected ConditionStaleWorkerLease=True (LeaseExpired), got %#v", cond)
	}

	// Verify Job and Pod are NOT deleted or killed
	var survivingJob batchv1.Job
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: workerJob.Namespace, Name: workerJob.Name}, &survivingJob); err != nil {
		t.Fatalf("Worker Job was deleted on annotation mismatch: %v", err)
	}
	var survivingPod corev1.Pod
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: workerPod.Namespace, Name: workerPod.Name}, &survivingPod); err != nil {
		t.Fatalf("Worker Pod was deleted on annotation mismatch: %v", err)
	}
	if survivingPod.Status.Phase != corev1.PodRunning {
		t.Fatalf("Worker Pod phase = %s, want PodRunning", survivingPod.Status.Phase)
	}
}
