/*
Copyright 2026 exampleorg.

Challenger 1 Empirical Adversarial Test Suite:
Requirement R3: Pod Suspension & Zero-Quota Wait
- Quota reclamation & immediate TTL=0 deletion upon prep pod exit 0
- admissionSnapshot exclusion for AwaitingResumption / PhaseAwaitingResumption
- Prep Job deletion before next reconcile pass (errors.IsNotFound handling)
- Race condition testing: Status update conflict while prep Job TTL is lowered and finalizer removed
*/

package controllers_test

import (
	"context"
	"testing"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"

	reviewv1alpha2 "github.com/review-yeti-ai/review-yeti-bot/k8s-operator/api/v1alpha2"
	"github.com/review-yeti-ai/review-yeti-bot/k8s-operator/controllers"
	"github.com/review-yeti-ai/review-yeti-bot/k8s-operator/pkg/job"
	"github.com/review-yeti-ai/review-yeti-bot/k8s-operator/pkg/workspace"
)

// Helper to calculate total active worker pod resources in namespace
func calculateActiveWorkerPodQuota(ctx context.Context, kube client.Client, namespace string) (cpuReq resource.Quantity, memReq resource.Quantity, memLim resource.Quantity, err error) {
	var podList corev1.PodList
	if err = kube.List(ctx, &podList, client.InNamespace(namespace)); err != nil {
		return
	}
	for _, pod := range podList.Items {
		if pod.Status.Phase == corev1.PodFailed || pod.Status.Phase == corev1.PodSucceeded {
			// In Kubernetes, completed pods whose Job was deleted are removed from quota
			continue
		}
		for _, c := range pod.Spec.Containers {
			if reqCPU, ok := c.Resources.Requests[corev1.ResourceCPU]; ok {
				cpuReq.Add(reqCPU)
			}
			if reqMem, ok := c.Resources.Requests[corev1.ResourceMemory]; ok {
				memReq.Add(reqMem)
			}
			if limMem, ok := c.Resources.Limits[corev1.ResourceMemory]; ok {
				memLim.Add(limMem)
			}
		}
	}
	return
}

// 1. Empirically verify that when a prep pod exits 0, the pod is immediately deleted (TTL=0)
// and quota consumption drops to 0m CPU and 0Mi memory in ct-review-system-workers.
func TestChallenger_PrepPodSuccess_DropsTTLAndReclaimsQuota(t *testing.T) {
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

	// Verify Job was created with prep label, build TTL (fail-safe >= 300s), and terminal outcome finalizer
	if !job.IsPrepWorkerJob(&worker) {
		t.Fatalf("expected worker job to be a prep worker")
	}
	if worker.Spec.TTLSecondsAfterFinished == nil || *worker.Spec.TTLSecondsAfterFinished < 300 {
		t.Fatalf("worker Job should initially be created with build TTL >= 300s, got: %v", worker.Spec.TTLSecondsAfterFinished)
	}
	hasFinalizer := false
	for _, f := range worker.Finalizers {
		if f == "review-yeti.ai/terminal-outcome" {
			hasFinalizer = true
			break
		}
	}
	if !hasFinalizer {
		t.Fatalf("worker Job must initially have terminal-outcome finalizer")
	}

	// Create a worker pod associated with the Job to model quota consumption
	workerPod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Namespace: review.Namespace,
			Name:      review.Name + "-worker-pod-0",
			Labels: map[string]string{
				"job-name":        worker.Name,
				job.JobPhaseLabel: job.JobPhasePrep,
			},
		},
		Spec: corev1.PodSpec{
			Containers: []corev1.Container{
				{
					Name: "reviewer-worker",
					Resources: corev1.ResourceRequirements{
						Requests: corev1.ResourceList{
							corev1.ResourceCPU:    resource.MustParse("50m"),
							corev1.ResourceMemory: resource.MustParse("96Mi"),
						},
						Limits: corev1.ResourceList{
							corev1.ResourceMemory: resource.MustParse("256Mi"),
						},
					},
				},
			},
		},
		Status: corev1.PodStatus{
			Phase: corev1.PodRunning,
		},
	}
	if err := kube.Create(context.Background(), workerPod); err != nil {
		t.Fatalf("failed to create simulated worker pod: %v", err)
	}

	// Verify active quota before completion: 50m CPU, 96Mi mem request, 256Mi mem limit
	cpuReq, memReq, memLim, err := calculateActiveWorkerPodQuota(context.Background(), kube, review.Namespace)
	if err != nil {
		t.Fatal(err)
	}
	if cpuReq.String() != "50m" || memReq.String() != "96Mi" || memLim.String() != "256Mi" {
		t.Fatalf("expected running quota to be 50m/96Mi/256Mi, got cpuReq=%s, memReq=%s, memLim=%s", cpuReq.String(), memReq.String(), memLim.String())
	}

	// Prep pod exits 0: Succeeded = 1
	attachReceiptAnnotations(&worker)
	worker.Status.Succeeded = 1
	if err := kube.Status().Update(context.Background(), &worker); err != nil {
		t.Fatalf("update worker status succeeded: %v", err)
	}

	// Pass 2: Observe completion
	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("second reconcile failed: %v", err)
	}

	// Verify review state
	var updatedReview reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), req.NamespacedName, &updatedReview); err != nil {
		t.Fatal(err)
	}
	if updatedReview.Status.Phase != reviewv1alpha2.PhaseAwaitingResumption {
		t.Fatalf("review phase want %s, got %s", reviewv1alpha2.PhaseAwaitingResumption, updatedReview.Status.Phase)
	}
	cond := meta.FindStatusCondition(updatedReview.Status.Conditions, reviewv1alpha2.ConditionAwaitingResumption)
	if cond == nil || cond.Status != metav1.ConditionTrue {
		t.Fatalf("review condition %s want True, got %#v", reviewv1alpha2.ConditionAwaitingResumption, cond)
	}

	// Verify worker Job was patched down to TTL=0 and finalizer was removed
	var updatedWorker batchv1.Job
	if err := kube.Get(context.Background(), workerName, &updatedWorker); err != nil {
		t.Fatal(err)
	}
	if updatedWorker.Spec.TTLSecondsAfterFinished == nil || *updatedWorker.Spec.TTLSecondsAfterFinished != 0 {
		t.Fatalf("worker Job TTL want 0, got %v", updatedWorker.Spec.TTLSecondsAfterFinished)
	}
	for _, f := range updatedWorker.Finalizers {
		if f == "review-yeti.ai/terminal-outcome" {
			t.Fatalf("worker Job finalizer review-yeti.ai/terminal-outcome must be removed upon prep completion to allow immediate TTL collection")
		}
	}

	// Now simulate Kubernetes TTL controller: immediately deletes Job and cascades to Pod
	if err := kube.Delete(context.Background(), &updatedWorker); err != nil {
		t.Fatalf("simulated TTL deletion of worker Job: %v", err)
	}
	if err := kube.Delete(context.Background(), workerPod); err != nil {
		t.Fatalf("simulated TTL deletion of worker Pod: %v", err)
	}

	// Verify quota consumption in ct-review-system-workers has dropped to 0 CPU and 0 Memory!
	cpuReqPost, memReqPost, memLimPost, err := calculateActiveWorkerPodQuota(context.Background(), kube, review.Namespace)
	if err != nil {
		t.Fatal(err)
	}
	if !cpuReqPost.IsZero() || !memReqPost.IsZero() || !memLimPost.IsZero() {
		t.Fatalf("expected post-prep quota consumption to be 0m CPU, 0Mi Memory request, 0Mi Memory limit; got cpu=%s, memReq=%s, memLim=%s",
			cpuReqPost.String(), memReqPost.String(), memLimPost.String())
	}
}

// 2. Verify that admissionSnapshot does NOT count reviews in AwaitingResumption / PhaseAwaitingResumption
// toward the MAX_CONCURRENT_JOBS limit, allowing newly queued reviews to be scheduled without capacity stalls.
func TestChallenger_AdmissionSnapshot_ExcludesAwaitingResumption_AllowsConcurrency(t *testing.T) {
	now := time.Date(2026, 9, 28, 14, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)

	// Create 2 reviews in PhaseAwaitingResumption
	reviewA := v1alpha2Review(now)
	reviewA.Name = "ct-review-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	reviewA.Spec.RunID = "run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	reviewA.Spec.RunSecretName = "ct-review-run-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	reviewA.Spec.PRNumber = 101
	reviewA.Status.Phase = reviewv1alpha2.PhaseAwaitingResumption
	meta.SetStatusCondition(&reviewA.Status.Conditions, metav1.Condition{
		Type:               reviewv1alpha2.ConditionAwaitingResumption,
		Status:             metav1.ConditionTrue,
		Reason:             "PrepCompleted",
		LastTransitionTime: metav1.NewTime(now),
	})

	reviewB := v1alpha2Review(now)
	reviewB.Name = "ct-review-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	reviewB.Spec.RunID = "run_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	reviewB.Spec.RunSecretName = "ct-review-run-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	reviewB.Spec.PRNumber = 102
	reviewB.Status.Phase = reviewv1alpha2.PhaseAwaitingResumption
	meta.SetStatusCondition(&reviewB.Status.Conditions, metav1.Condition{
		Type:               reviewv1alpha2.ConditionAwaitingResumption,
		Status:             metav1.ConditionTrue,
		Reason:             "PrepCompleted",
		LastTransitionTime: metav1.NewTime(now),
	})

	// Create 2 queued reviews
	reviewC := v1alpha2Review(now)
	reviewC.Name = "ct-review-cccccccccccccccccccccccccccccccc"
	reviewC.Spec.RunID = "run_cccccccccccccccccccccccccccccccc"
	reviewC.Spec.RunSecretName = "ct-review-run-cccccccccccccccccccccccccccccccc"
	reviewC.Spec.PRNumber = 103

	reviewD := v1alpha2Review(now)
	reviewD.Name = "ct-review-dddddddddddddddddddddddddddddddd"
	reviewD.Spec.RunID = "run_dddddddddddddddddddddddddddddddd"
	reviewD.Spec.RunSecretName = "ct-review-run-dddddddddddddddddddddddddddddddd"
	reviewD.Spec.PRNumber = 104

	// Create 1 more queued review for testing limit saturation
	reviewE := v1alpha2Review(now)
	reviewE.Name = "ct-review-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
	reviewE.Spec.RunID = "run_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
	reviewE.Spec.RunSecretName = "ct-review-run-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
	reviewE.Spec.PRNumber = 105

	kube := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(reviewA, reviewB, reviewC, reviewD, reviewE).
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}, &batchv1.Job{}).
		Build()

	// MaxConcurrentJobs = 2.
	// If reviewA and reviewB were counted, concurrency would be 2/2 and reviewC and reviewD would be stalled!
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client:            kube,
		Scheme:            scheme,
		Now:               func() time.Time { return now },
		MaxConcurrentJobs: 2,
	}

	// Reconcile reviewC: MUST BE ADMITTED (not stalled by reviewA / reviewB)
	reqC := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: reviewC.Namespace, Name: reviewC.Name}}
	if _, err := reconciler.Reconcile(context.Background(), reqC); err != nil {
		t.Fatalf("reconcile reviewC failed: %v", err)
	}
	var checkC reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), reqC.NamespacedName, &checkC); err != nil {
		t.Fatal(err)
	}
	if checkC.Status.Phase != reviewv1alpha2.PhaseRunning {
		t.Fatalf("reviewC want PhaseRunning, got %s (message: %s)", checkC.Status.Phase, checkC.Status.Message)
	}

	// Reconcile reviewD: MUST BE ADMITTED
	reqD := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: reviewD.Namespace, Name: reviewD.Name}}
	if _, err := reconciler.Reconcile(context.Background(), reqD); err != nil {
		t.Fatalf("reconcile reviewD failed: %v", err)
	}
	var checkD reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), reqD.NamespacedName, &checkD); err != nil {
		t.Fatal(err)
	}
	if checkD.Status.Phase != reviewv1alpha2.PhaseRunning {
		t.Fatalf("reviewD want PhaseRunning, got %s (message: %s)", checkD.Status.Phase, checkD.Status.Message)
	}

	// Now slots are saturated: C and D are Running (2/2 active slots occupied).
	// Review E must be queued with CapacityExceeded
	reqE := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: reviewE.Namespace, Name: reviewE.Name}}
	if _, err := reconciler.Reconcile(context.Background(), reqE); err != nil {
		t.Fatalf("reconcile reviewE failed: %v", err)
	}
	var checkE reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), reqE.NamespacedName, &checkE); err != nil {
		t.Fatal(err)
	}
	if checkE.Status.Phase != reviewv1alpha2.PhaseQueued || checkE.Status.Message != "waiting for one of 2 worker slots" {
		t.Fatalf("reviewE should be queued waiting for slots, got phase=%s, message=%s", checkE.Status.Phase, checkE.Status.Message)
	}

	// Now simulate reviewC worker completion via reconciler:
	var jobC batchv1.Job
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: reviewC.Namespace, Name: reviewC.Name + "-worker"}, &jobC); err != nil {
		t.Fatal(err)
	}
	attachReceiptAnnotations(&jobC)
	jobC.Status.Succeeded = 1
	if err := kube.Status().Update(context.Background(), &jobC); err != nil {
		t.Fatal(err)
	}

	// Reconcile reviewC: controller removes finalizer, patches TTL 0, sets PhaseAwaitingResumption
	if _, err := reconciler.Reconcile(context.Background(), reqC); err != nil {
		t.Fatalf("reconcile reviewC completion failed: %v", err)
	}

	// Now TTL controller deletes the finished job
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: reviewC.Namespace, Name: reviewC.Name + "-worker"}, &jobC); err == nil {
		_ = kube.Delete(context.Background(), &jobC)
	}

	// Now reconcile reviewE again: slot was freed, reviewE MUST admit into PhaseRunning!
	if _, err := reconciler.Reconcile(context.Background(), reqE); err != nil {
		t.Fatalf("reconcile reviewE second pass failed: %v", err)
	}
	if err := kube.Get(context.Background(), reqE.NamespacedName, &checkE); err != nil {
		t.Fatal(err)
	}
	if checkE.Status.Phase != reviewv1alpha2.PhaseRunning {
		t.Fatalf("reviewE want PhaseRunning after slot released, got %s (message: %s)", checkE.Status.Phase, checkE.Status.Message)
	}
}

// 3. Stress-test race conditions: what happens if the prep Job is deleted by Kubernetes
// before the operator's next reconciliation pass? Does the controller handle errors.IsNotFound gracefully without failing the review?
func TestChallenger_JobDeletedByKubernetes_AwaitingResumption_ToleratesNotFound(t *testing.T) {
	now := time.Date(2026, 9, 28, 14, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)

	// Review was successfully transitioned to PhaseAwaitingResumption
	review := v1alpha2Review(now)
	review.Status.Phase = reviewv1alpha2.PhaseAwaitingResumption
	review.Status.JobName = review.Name + "-worker"
	meta.SetStatusCondition(&review.Status.Conditions, metav1.Condition{
		Type:               reviewv1alpha2.ConditionAwaitingResumption,
		Status:             metav1.ConditionTrue,
		Reason:             "PrepCompleted",
		Message:            "prep phase completed, awaiting model resumption",
		LastTransitionTime: metav1.NewTime(now),
	})

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

	// Worker Job is completely missing from Kubernetes (NotFound)
	var checkJob batchv1.Job
	err := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: review.Name + "-worker"}, &checkJob)
	if !apierrors.IsNotFound(err) {
		t.Fatalf("expected Job to be absent/NotFound, got: %v", err)
	}

	// Reconcile runs (e.g. periodic resync or metadata update)
	res, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("reconcile must tolerate IsNotFound when in AwaitingResumption, got err: %v", err)
	}
	if res.Requeue || res.RequeueAfter > 0 {
		t.Fatalf("unexpected requeue: %#v", res)
	}

	// Ensure review remains in PhaseAwaitingResumption and was NOT failed with WorkerJobMissing
	var updated reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), req.NamespacedName, &updated); err != nil {
		t.Fatal(err)
	}
	if updated.Status.Phase != reviewv1alpha2.PhaseAwaitingResumption {
		t.Fatalf("review phase want PhaseAwaitingResumption, got %s (message: %s)", updated.Status.Phase, updated.Status.Message)
	}
}

// 4. Stress-test: Job NotFound while prep pod is still RUNNING must fail closed with WorkerJobMissing.
func TestChallenger_JobNotFound_WhilePrepPodRunning_FailsClosed(t *testing.T) {
	now := time.Date(2026, 9, 28, 14, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)

	// Review was running, worker Job was created, but then mysteriously vanished before finishing
	review := v1alpha2Review(now)
	review.Status.Phase = reviewv1alpha2.PhaseRunning
	review.Status.JobName = review.Name + "-worker"
	meta.SetStatusCondition(&review.Status.Conditions, metav1.Condition{
		Type:               "WorkerCreationReserved",
		Status:             metav1.ConditionTrue,
		Reason:             "WorkerCreated",
		LastTransitionTime: metav1.NewTime(now.Add(-60 * time.Second)),
	})

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

	// Reconcile: Job is missing, review is Running (not AwaitingResumption)
	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("reconcile error: %v", err)
	}

	var updated reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), req.NamespacedName, &updated); err != nil {
		t.Fatal(err)
	}
	// Must fail-closed because a running worker vanished without observation
	if updated.Status.Phase != reviewv1alpha2.PhaseFailed {
		t.Fatalf("expected phase PhaseFailed for vanished running worker, got: %s", updated.Status.Phase)
	}
	cond := meta.FindStatusCondition(updated.Status.Conditions, "Ready")
	if cond == nil || cond.Reason != "WorkerJobMissing" {
		t.Fatalf("expected Ready condition with reason WorkerJobMissing, got %#v", cond)
	}
}

// 5. Stress-test race condition: Status update conflict while prep Job TTL is lowered and finalizer removed.
func TestChallenger_StatusUpdateConflict_DuringPrepCompletion_Race(t *testing.T) {
	conflictArmed := false
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
						return apierrors.NewConflict(
							schema.GroupResource{Group: "review-yeti.ai", Resource: "prreviewjobs"},
							obj.GetName(), nil)
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
		t.Fatalf("first reconcile failed: %v", err)
	}

	var worker batchv1.Job
	workerName := types.NamespacedName{Namespace: review.Namespace, Name: review.Name + "-worker"}
	if err := kube.Get(context.Background(), workerName, &worker); err != nil {
		t.Fatalf("failed to get created worker job: %v", err)
	}

	// Mark worker succeeded
	attachReceiptAnnotations(&worker)
	worker.Status.Succeeded = 1
	if err := kube.Status().Update(context.Background(), &worker); err != nil {
		t.Fatalf("update worker status succeeded: %v", err)
	}

	// Arm conflict on the review status update!
	conflictArmed = true

	// Pass 2: Reconcile observes worker success, patches TTL to 0, removes finalizer,
	// but the status write to PRReviewJob encounters a CONFLICT!
	res, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("conflict must be handled quietly via conflictRequeue, got: %v", err)
	}
	if res.RequeueAfter != 2*time.Second {
		t.Fatalf("expected quiet requeue after 2s, got: %v", res.RequeueAfter)
	}

	// Check the worker Job in the cluster:
	// Because finalizer was removed and TTL was set to 0, Kubernetes TTL controller now deletes it!
	var workerInCluster batchv1.Job
	if err := kube.Get(context.Background(), workerName, &workerInCluster); err != nil {
		t.Fatalf("failed to get worker in cluster: %v", err)
	}
	if err := kube.Delete(context.Background(), &workerInCluster); err != nil {
		t.Fatalf("TTL controller deletes Job: %v", err)
	}

	// Disarm conflict so the retry pass can succeed
	conflictArmed = false

	// Pass 3: The requeue runs 2 seconds later.
	// At this point, the worker Job is GONE (deleted by TTL controller).
	// Let's see how the controller handles this!
	reconciler.Now = func() time.Time { return now.Add(2 * time.Second) }
	_, retryErr := reconciler.Reconcile(context.Background(), req)

	var checkReview reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), req.NamespacedName, &checkReview); err != nil {
		t.Fatal(err)
	}

	t.Logf("Post-conflict retry result: err=%v, phase=%s, message=%s", retryErr, checkReview.Status.Phase, checkReview.Status.Message)
	if checkReview.Status.Phase == reviewv1alpha2.PhaseFailed {
		t.Errorf("RACE VULNERABILITY DETECTED: Review failed with phase=%s, message=%s because worker Job finalizer was removed and TTL patched before status write succeeded!",
			checkReview.Status.Phase, checkReview.Status.Message)
	}
}
