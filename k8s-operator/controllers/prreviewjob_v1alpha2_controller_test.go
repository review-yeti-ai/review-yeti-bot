package controllers_test

import (
	"context"
	"testing"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	coordinationv1 "k8s.io/api/coordination/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	crmetrics "sigs.k8s.io/controller-runtime/pkg/metrics"

	reviewv1alpha2 "github.com/calltelemetry/ct-review-bot/k8s-operator/api/v1alpha2"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/controllers"
	operatorMetrics "github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/metrics"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/workspace"
)

func v1alpha2Scheme(t *testing.T) *runtime.Scheme {
	t.Helper()
	scheme := runtime.NewScheme()
	for _, add := range []func(*runtime.Scheme) error{
		corev1.AddToScheme,
		batchv1.AddToScheme,
		coordinationv1.AddToScheme,
		reviewv1alpha2.AddToScheme,
	} {
		if err := add(scheme); err != nil {
			t.Fatalf("register scheme: %v", err)
		}
	}
	return scheme
}

func v1alpha2Review(now time.Time) *reviewv1alpha2.PRReviewJob {
	return &reviewv1alpha2.PRReviewJob{
		TypeMeta: metav1.TypeMeta{APIVersion: "review-yeti.ai/v1alpha2", Kind: "PRReviewJob"},
		ObjectMeta: metav1.ObjectMeta{
			Name:      "ct-review-11111111111111111111111111111111",
			Namespace: "ct-review-system",
		},
		Spec: reviewv1alpha2.PRReviewJobSpec{
			RunID:            "run_11111111111111111111111111111111",
			DeliveryID:       "delivery-1",
			RepositoryID:     123,
			Repo:             "calltelemetry/cisco-cdr",
			PRNumber:         42,
			HeadSHA:          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			BaseSHA:          "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			ReceivedAt:       metav1.NewTime(now),
			TerminalDeadline: metav1.NewTime(now.Add(15 * time.Minute)),
			PolicyDigest:     "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
			ConfigDigest:     "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
			PublicationMode:  "disabled",
			WorkerImage:      "registry.digitalocean.com/calltelemetry/review-yeti-worker@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
			RunSecretName:    "ct-review-run-11111111111111111111111111111111",
		},
	}
}

func TestPRReviewJobV1Alpha2ReconcilerCreatesPVCThenHardenedWorkerJob(t *testing.T) {
	now := time.Date(2026, 8, 31, 12, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	review := v1alpha2Review(now)
	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(review).WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: kube, Scheme: scheme, Now: func() time.Time { return now }}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	result, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("first reconcile: %v", err)
	}
	if result.RequeueAfter <= 0 {
		t.Fatal("PVC creation must requeue before acquiring a lease")
	}

	var pvc corev1.PersistentVolumeClaim
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: workspace.PVCName(review.Spec.RepositoryID, review.Spec.PRNumber)}, &pvc); err != nil {
		t.Fatalf("get workspace PVC: %v", err)
	}
	if err := workspace.ValidatePVC(&pvc, review.Namespace, review.Spec.RepositoryID, review.Spec.PRNumber); err != nil {
		t.Fatalf("created PVC failed identity validation: %v", err)
	}

	result, err = reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("second reconcile: %v", err)
	}
	if result.RequeueAfter > 0 {
		t.Fatal("worker Job should be created after PVC and lease acquisition")
	}

	var worker batchv1.Job
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: review.Name + "-worker"}, &worker); err != nil {
		t.Fatalf("get worker Job: %v", err)
	}
	if worker.Spec.BackoffLimit == nil || *worker.Spec.BackoffLimit != 0 {
		t.Fatalf("backoffLimit = %v, want 0", worker.Spec.BackoffLimit)
	}
	if worker.Spec.ActiveDeadlineSeconds == nil || *worker.Spec.ActiveDeadlineSeconds > 840 || *worker.Spec.ActiveDeadlineSeconds < 120 {
		t.Fatalf("activeDeadlineSeconds = %v, want 120..840", worker.Spec.ActiveDeadlineSeconds)
	}
	container := worker.Spec.Template.Spec.Containers[0]
	if container.Image != review.Spec.WorkerImage || container.ImagePullPolicy != corev1.PullIfNotPresent {
		t.Fatalf("worker image contract mismatch: %#v", container)
	}
	if worker.Spec.Template.Spec.AutomountServiceAccountToken == nil || *worker.Spec.Template.Spec.AutomountServiceAccountToken {
		t.Fatal("worker must not receive a Kubernetes API token")
	}
	if len(worker.OwnerReferences) != 1 || worker.OwnerReferences[0].Name != review.Name {
		t.Fatalf("worker owner reference = %#v, want PRReviewJob", worker.OwnerReferences)
	}

	var updated reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), req.NamespacedName, &updated); err != nil {
		t.Fatalf("get updated review: %v", err)
	}
	if updated.Status.Phase != reviewv1alpha2.PhaseRunning || updated.Status.JobName != worker.Name {
		t.Fatalf("status = %#v, want Running with worker name", updated.Status)
	}
	if updated.Status.Timing == nil || updated.Status.Timing.ReceivedAt == nil || updated.Status.Timing.JobCreatedAt == nil {
		t.Fatalf("durable timing receipt = %#v, want receipt and Job creation timestamps", updated.Status.Timing)
	}
	if !updated.Status.Timing.ReceivedAt.Equal(&review.Spec.ReceivedAt) || !updated.Status.Timing.JobCreatedAt.Equal(&metav1.Time{Time: now}) {
		t.Fatalf("durable timing receipt = %#v, want received=%s job-created=%s", updated.Status.Timing, review.Spec.ReceivedAt.Time, now)
	}
	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("idempotent reconcile: %v", err)
	}
	var workers batchv1.JobList
	if err := kube.List(context.Background(), &workers); err != nil {
		t.Fatalf("list worker Jobs: %v", err)
	}
	if len(workers.Items) != 1 {
		t.Fatalf("worker Job count = %d, want 1", len(workers.Items))
	}
}

func TestPRReviewJobV1Alpha2ReconcilerPersistsPodLifecycleTiming(t *testing.T) {
	now := time.Date(2026, 8, 31, 12, 0, 0, 0, time.UTC)
	observationNow := now.Add(6 * time.Second)
	scheme := v1alpha2Scheme(t)
	review := v1alpha2Review(now)
	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(review).WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
	currentNow := now
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: kube, Scheme: scheme, Now: func() time.Time { return currentNow }}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}
	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	var worker batchv1.Job
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: review.Name + "-worker"}, &worker); err != nil {
		t.Fatal(err)
	}
	scheduled := metav1.NewTime(now.Add(2 * time.Second))
	started := metav1.NewTime(now.Add(4 * time.Second))
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      worker.Name + "-pod",
			Namespace: review.Namespace,
			Labels: map[string]string{
				"review-yeti.ai/run-id":        review.Spec.RunID,
				"review-yeti.ai/component":     "receipt-only-worker",
				"batch.kubernetes.io/job-name": worker.Name,
			},
		},
		Status: corev1.PodStatus{
			Conditions: []corev1.PodCondition{{Type: corev1.PodScheduled, Status: corev1.ConditionTrue, LastTransitionTime: scheduled}},
			ContainerStatuses: []corev1.ContainerStatus{{
				Name:    "reviewer-worker",
				ImageID: "registry.digitalocean.com/calltelemetry/review-yeti-worker@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
				State:   corev1.ContainerState{Running: &corev1.ContainerStateRunning{StartedAt: started}},
			}},
		},
	}
	if err := kube.Create(context.Background(), pod); err != nil {
		t.Fatalf("create worker pod: %v", err)
	}
	currentNow = observationNow
	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("observe worker pod: %v", err)
	}
	var updated reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), req.NamespacedName, &updated); err != nil {
		t.Fatal(err)
	}
	if updated.Status.Timing == nil || updated.Status.Timing.PodScheduledAt == nil || updated.Status.Timing.ImageObservedAt == nil || updated.Status.Timing.ProcessStartedAt == nil {
		t.Fatalf("timing = %#v, want scheduled/image/process stages", updated.Status.Timing)
	}
	if !updated.Status.Timing.PodScheduledAt.Equal(&scheduled) || !updated.Status.Timing.ProcessStartedAt.Equal(&started) {
		t.Fatalf("timing = %#v, want scheduled=%s started=%s", updated.Status.Timing, scheduled.Time, started.Time)
	}
	if !updated.Status.Timing.ImageObservedAt.Equal(&started) {
		t.Fatalf("image observed at = %s, want safe process-start upper bound %s", updated.Status.Timing.ImageObservedAt.Time, started.Time)
	}
}

func TestPRReviewJobV1Alpha2ReconcilerPersistsTerminatedPodProcessTiming(t *testing.T) {
	now := time.Date(2026, 8, 31, 12, 0, 0, 0, time.UTC)
	observationNow := now.Add(6 * time.Second)
	scheme := v1alpha2Scheme(t)
	review := v1alpha2Review(now)
	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(review).WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
	currentNow := now
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: kube, Scheme: scheme, Now: func() time.Time { return currentNow }}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}
	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	var worker batchv1.Job
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: review.Name + "-worker"}, &worker); err != nil {
		t.Fatal(err)
	}
	scheduled := metav1.NewTime(now.Add(2 * time.Second))
	started := metav1.NewTime(now.Add(4 * time.Second))
	finished := metav1.NewTime(now.Add(5 * time.Second))
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      worker.Name + "-terminated-pod",
			Namespace: review.Namespace,
			Labels: map[string]string{
				"review-yeti.ai/run-id":    review.Spec.RunID,
				"review-yeti.ai/component": "receipt-only-worker",
				"batch.kubernetes.io/job-name": worker.Name,
			},
		},
		Status: corev1.PodStatus{
			Conditions: []corev1.PodCondition{{Type: corev1.PodScheduled, Status: corev1.ConditionTrue, LastTransitionTime: scheduled}},
			ContainerStatuses: []corev1.ContainerStatus{{
				Name:    "reviewer-worker",
				ImageID: "registry.digitalocean.com/calltelemetry/review-yeti-worker@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
				State:   corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{StartedAt: started, FinishedAt: finished}},
			}},
		},
	}
	if err := kube.Create(context.Background(), pod); err != nil {
		t.Fatalf("create terminated worker pod: %v", err)
	}
	currentNow = observationNow
	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("observe terminated worker pod: %v", err)
	}
	var updated reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), req.NamespacedName, &updated); err != nil {
		t.Fatal(err)
	}
	if updated.Status.Timing == nil || updated.Status.Timing.ProcessStartedAt == nil {
		t.Fatalf("timing = %#v, want process-start stage from terminated container", updated.Status.Timing)
	}
	if !updated.Status.Timing.ProcessStartedAt.Equal(&started) {
		t.Fatalf("process started at = %s, want %s", updated.Status.Timing.ProcessStartedAt.Time, started.Time)
	}
}

func TestPRReviewJobV1Alpha2ReconcilerReleasesWorkspaceAfterTerminalWorker(t *testing.T) {
	now := time.Date(2026, 8, 31, 12, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	review := v1alpha2Review(now)
	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(review).WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: kube, Scheme: scheme, Now: func() time.Time { return now }}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}
	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	var worker batchv1.Job
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: review.Name + "-worker"}, &worker); err != nil {
		t.Fatal(err)
	}
	worker.Status.Succeeded = 1
	if err := kube.Status().Update(context.Background(), &worker); err != nil {
		t.Fatalf("mark worker succeeded: %v", err)
	}
	beforeWebhookToJob := histogramSampleCount(t, "ct_operator_webhook_to_job_duration_seconds")
	beforeWebhookToCompletion := histogramSampleCount(t, "ct_operator_webhook_to_completion_duration_seconds")
	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("terminal reconcile: %v", err)
	}
	if got := histogramSampleCount(t, "ct_operator_webhook_to_job_duration_seconds"); got != beforeWebhookToJob+1 {
		t.Fatalf("webhook-to-job histogram count = %d, want %d", got, beforeWebhookToJob+1)
	}
	if got := histogramSampleCount(t, "ct_operator_webhook_to_completion_duration_seconds"); got != beforeWebhookToCompletion+1 {
		t.Fatalf("webhook-to-completion histogram count = %d, want %d", got, beforeWebhookToCompletion+1)
	}
	var updated reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), req.NamespacedName, &updated); err != nil {
		t.Fatal(err)
	}
	if updated.Status.Phase != reviewv1alpha2.PhaseSucceeded || updated.Status.CompletionTime == nil {
		t.Fatalf("terminal status = %#v", updated.Status)
	}
	var pvc corev1.PersistentVolumeClaim
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: workspace.PVCName(review.Spec.RepositoryID, review.Spec.PRNumber)}, &pvc); err != nil {
		t.Fatal(err)
	}
	if pvc.Annotations[workspace.LastUsedAtAnnotation] != now.Format(time.RFC3339Nano) {
		t.Fatalf("last-used-at = %q, want %q", pvc.Annotations[workspace.LastUsedAtAnnotation], now.Format(time.RFC3339Nano))
	}
	if _, err := workspace.NewLeaseManager(kube).Acquire(context.Background(), review.Namespace, review.Spec.RepositoryID, review.Spec.PRNumber, "run_22222222222222222222222222222222", now.Add(15*time.Minute), now.Add(time.Second)); err != nil {
		t.Fatalf("released workspace lease should be acquirable: %v", err)
	}
}

func TestPRReviewJobV1Alpha2ReconcilerReclaimsIdleWorkspaceAfterTerminalReview(t *testing.T) {
	lastUsed := time.Date(2026, 8, 31, 12, 0, 0, 0, time.UTC)
	review := v1alpha2Review(lastUsed.Add(-30 * time.Minute))
	review.Status.Phase = reviewv1alpha2.PhaseSucceeded
	completion := metav1.NewTime(lastUsed)
	review.Status.CompletionTime = &completion
	pvc, err := workspace.BuildPVC(review.Namespace, review.Spec.RepositoryID, review.Spec.PRNumber, lastUsed)
	if err != nil {
		t.Fatalf("build PVC: %v", err)
	}
	kube := fake.NewClientBuilder().WithScheme(v1alpha2Scheme(t)).WithObjects(review, pvc).WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
	currentNow := lastUsed.Add(29*time.Minute + 59*time.Second)
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: kube, Scheme: v1alpha2Scheme(t), Now: func() time.Time { return currentNow }}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	result, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("reconcile before idle TTL: %v", err)
	}
	if result.RequeueAfter != time.Second {
		t.Fatalf("requeue after 1799 seconds = %s, want 1s", result.RequeueAfter)
	}
	var retained corev1.PersistentVolumeClaim
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: pvc.Name}, &retained); err != nil {
		t.Fatalf("get retained PVC: %v", err)
	}

	currentNow = lastUsed.Add(30 * time.Minute)
	result, err = reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("reconcile at idle TTL: %v", err)
	}
	if result.RequeueAfter != 0 {
		t.Fatalf("requeue after reclamation = %s, want zero", result.RequeueAfter)
	}
	var reclaimed corev1.PersistentVolumeClaim
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: pvc.Name}, &reclaimed); err == nil {
		t.Fatal("idle terminal review must reclaim its workspace PVC")
	}
}

func histogramSampleCount(t *testing.T, name string) uint64 {
	t.Helper()
	operatorMetrics.RegisterMetrics()
	families, err := crmetrics.Registry.Gather()
	if err != nil {
		t.Fatalf("gather metrics: %v", err)
	}
	for _, family := range families {
		if family.GetName() != name || len(family.GetMetric()) == 0 {
			continue
		}
		return family.GetMetric()[0].GetHistogram().GetSampleCount()
	}
	return 0
}

func TestPRReviewJobV1Alpha2ReconcilerFailsClosedOnPVCIdentityMismatch(t *testing.T) {
	now := time.Date(2026, 8, 31, 12, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	review := v1alpha2Review(now)
	pvc, err := workspace.BuildPVC(review.Namespace, review.Spec.RepositoryID, review.Spec.PRNumber, now)
	if err != nil {
		t.Fatalf("build PVC: %v", err)
	}
	pvc.Labels[workspace.RepositoryIDLabel] = "999"
	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(review, pvc).WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: kube, Scheme: scheme, Now: func() time.Time { return now }}

	_, err = reconciler.Reconcile(context.Background(), ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}})
	if err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	var updated reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: review.Name}, &updated); err != nil {
		t.Fatalf("get review: %v", err)
	}
	if updated.Status.Phase != reviewv1alpha2.PhaseFailed {
		t.Fatalf("phase = %s, want Failed", updated.Status.Phase)
	}
	var worker batchv1.Job
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: review.Name + "-worker"}, &worker); err == nil {
		t.Fatal("identity mismatch must not create a worker Job")
	}
}

func TestPRReviewJobV1Alpha2ReconcilerReleasesLeaseWhenWorkerContractIsRejected(t *testing.T) {
	now := time.Date(2026, 8, 31, 12, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	review := v1alpha2Review(now)
	review.Spec.WorkerImage = "registry.digitalocean.com/calltelemetry/review-yeti-worker:latest"
	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(review).WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: kube, Scheme: scheme, Now: func() time.Time { return now }}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}
	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	var updated reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), req.NamespacedName, &updated); err != nil {
		t.Fatal(err)
	}
	if updated.Status.Phase != reviewv1alpha2.PhaseFailed {
		t.Fatalf("phase = %s, want Failed", updated.Status.Phase)
	}
	if _, err := workspace.NewLeaseManager(kube).Acquire(context.Background(), review.Namespace, review.Spec.RepositoryID, review.Spec.PRNumber, "run_22222222222222222222222222222222", now.Add(15*time.Minute), now.Add(time.Second)); err != nil {
		t.Fatalf("lease remained held after rejected worker contract: %v", err)
	}
}

func TestPRReviewJobV1Alpha2ReconcilerExpiresBeforeCreatingResources(t *testing.T) {
	received := time.Date(2026, 8, 31, 12, 0, 0, 0, time.UTC)
	now := received.Add(15 * time.Minute)
	scheme := v1alpha2Scheme(t)
	review := v1alpha2Review(received)
	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(review).WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: kube, Scheme: scheme, Now: func() time.Time { return now }}

	_, err := reconciler.Reconcile(context.Background(), ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}})
	if err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	var updated reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: review.Name}, &updated); err != nil {
		t.Fatalf("get review: %v", err)
	}
	if updated.Status.Phase != reviewv1alpha2.PhaseExpired {
		t.Fatalf("phase = %s, want Expired", updated.Status.Phase)
	}
	var pvc corev1.PersistentVolumeClaim
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: workspace.PVCName(review.Spec.RepositoryID, review.Spec.PRNumber)}, &pvc); err == nil {
		t.Fatal("expired review must not create a PVC")
	}
}

func TestPRReviewJobV1Alpha2ReconcilerQueuesAboveActiveJobLimit(t *testing.T) {
	now := time.Date(2026, 8, 31, 12, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	review := v1alpha2Review(now)
	activeJobs := make([]runtime.Object, 0, 4)
	for i := 0; i < 4; i++ {
		activeJobs = append(activeJobs, &batchv1.Job{ObjectMeta: metav1.ObjectMeta{
			Name:      "active-" + string(rune('a'+i)),
			Namespace: review.Namespace,
			Labels:    map[string]string{"review-yeti.ai/component": "receipt-only-worker"},
		}, Status: batchv1.JobStatus{Active: 1}})
	}
	objects := []runtime.Object{review}
	objects = append(objects, activeJobs...)
	kube := fake.NewClientBuilder().WithScheme(scheme).WithRuntimeObjects(objects...).WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: kube, Scheme: scheme, Now: func() time.Time { return now }, MaxConcurrentJobs: 4}

	result, err := reconciler.Reconcile(context.Background(), ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}})
	if err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if result.RequeueAfter <= 0 {
		t.Fatal("capacity exhaustion must requeue")
	}
	var updated reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: review.Name}, &updated); err != nil {
		t.Fatalf("get review: %v", err)
	}
	if updated.Status.Phase != reviewv1alpha2.PhaseQueued {
		t.Fatalf("phase = %s, want Queued", updated.Status.Phase)
	}
	var pvc corev1.PersistentVolumeClaim
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: workspace.PVCName(review.Spec.RepositoryID, review.Spec.PRNumber)}, &pvc); err == nil {
		t.Fatal("queued review must not allocate a PVC")
	}
}
