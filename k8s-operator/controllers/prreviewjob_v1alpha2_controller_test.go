package controllers_test

import (
	"context"
	"reflect"
	"testing"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	coordinationv1 "k8s.io/api/coordination/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	crmetrics "sigs.k8s.io/controller-runtime/pkg/metrics"

	reviewv1alpha2 "github.com/calltelemetry/ct-review-bot/k8s-operator/api/v1alpha2"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/controllers"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/job"
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
			RunnerMode:       "generic",
			RunSecretName:    "ct-review-run-11111111111111111111111111111111",
		},
	}
}

type countingAdmissionReader struct {
	client.Reader
	reviewListCalls int
}

func (r *countingAdmissionReader) List(ctx context.Context, list client.ObjectList, opts ...client.ListOption) error {
	if _, ok := list.(*reviewv1alpha2.PRReviewJobList); ok {
		r.reviewListCalls++
	}
	return r.Reader.List(ctx, list, opts...)
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

func TestPRReviewJobV1Alpha2ReconcilerReobservesSameHeadWorker(t *testing.T) {
	now := time.Date(2026, 9, 1, 20, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	review := v1alpha2Review(now)
	review.Spec.QualificationProfile = job.SameHeadQualificationProfile
	review.Spec.QualificationModel = "deepseek/deepseek-v4-flash-0731"
	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(review).WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: kube, Scheme: scheme, Now: func() time.Time { return now }}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("create same-head worker: %v", err)
	}
	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("reobserve same-head worker: %v", err)
	}

	var updated reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), req.NamespacedName, &updated); err != nil {
		t.Fatal(err)
	}
	if updated.Status.Phase != reviewv1alpha2.PhaseRunning {
		t.Fatalf("phase = %s, want Running after idempotent same-head reconcile", updated.Status.Phase)
	}
}

func TestPRReviewJobV1Alpha2ReconcilerStopsOwnedWorkerAndReleasesLeaseOnContractMismatch(t *testing.T) {
	now := time.Date(2026, 9, 1, 20, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	review := v1alpha2Review(now)
	review.UID = types.UID("same-head-review")
	review.Spec.QualificationProfile = job.SameHeadQualificationProfile
	review.Spec.QualificationModel = "deepseek/deepseek-v4-flash-0731"
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
	workerKey := types.NamespacedName{Namespace: review.Namespace, Name: review.Name + "-worker"}
	if err := kube.Get(context.Background(), workerKey, &worker); err != nil {
		t.Fatal(err)
	}
	for index := range worker.Spec.Template.Spec.Containers[0].Env {
		variable := &worker.Spec.Template.Spec.Containers[0].Env[index]
		if variable.Name == job.SameHeadQualificationEnv {
			variable.Value = "false"
		}
	}
	if err := kube.Update(context.Background(), &worker); err != nil {
		t.Fatalf("tamper worker fixture: %v", err)
	}

	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("fail mismatched worker: %v", err)
	}
	var failed reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), req.NamespacedName, &failed); err != nil {
		t.Fatal(err)
	}
	if failed.Status.Phase != reviewv1alpha2.PhaseFailed {
		t.Fatalf("phase = %s, want Failed before worker evidence is released", failed.Status.Phase)
	}
	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("release mismatched worker evidence: %v", err)
	}
	if err := kube.Get(context.Background(), workerKey, &batchv1.Job{}); !apierrors.IsNotFound(err) {
		t.Fatalf("mismatched owned worker still exists: %v", err)
	}
	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("release terminal workspace: %v", err)
	}
	if _, err := workspace.NewLeaseManager(kube).Acquire(
		context.Background(),
		review.Namespace,
		review.Spec.RepositoryID,
		review.Spec.PRNumber,
		"run_22222222222222222222222222222222",
		now.Add(16*time.Minute),
		now.Add(time.Minute),
	); err != nil {
		t.Fatalf("contract mismatch stranded workspace lease: %v", err)
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
	assignFakeWorkerUID(t, kube, &worker)
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
	bindTestPodToWorker(pod, &worker)
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
	assignFakeWorkerUID(t, kube, &worker)
	scheduled := metav1.NewTime(now.Add(2 * time.Second))
	started := metav1.NewTime(now.Add(4 * time.Second))
	finished := metav1.NewTime(now.Add(5 * time.Second))
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      worker.Name + "-terminated-pod",
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
				State:   corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{StartedAt: started, FinishedAt: finished}},
			}},
		},
	}
	bindTestPodToWorker(pod, &worker)
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

func TestPRReviewJobV1Alpha2ReconcilerImmediatelyReclaimsIdleWorkspaceAfterTerminalReview(t *testing.T) {
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
	// REL-732 changed the idle window to zero. The terminal state still needs
	// the collector's exact lease/Pod safety checks, but no thirty-minute wait.
	currentNow := lastUsed
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: kube, Scheme: v1alpha2Scheme(t), Now: func() time.Time { return currentNow }}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	result, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("reconcile immediately after terminal review: %v", err)
	}
	if result.RequeueAfter != 0 {
		t.Fatalf("requeue after reclamation = %s, want zero", result.RequeueAfter)
	}
	var reclaimed corev1.PersistentVolumeClaim
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: pvc.Name}, &reclaimed); !apierrors.IsNotFound(err) {
		t.Fatalf("idle terminal review must immediately reclaim its workspace PVC: %v", err)
	}
	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("repeated cleanup of an absent workspace: %v", err)
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

func TestPRReviewJobV1Alpha2ReconcilerQueuesWhilePriorWorkspacePVCTerminates(t *testing.T) {
	now := time.Date(2026, 9, 10, 16, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	review := v1alpha2Review(now)
	pvc, err := workspace.BuildPVC(review.Namespace, review.Spec.RepositoryID, review.Spec.PRNumber, now.Add(-time.Minute))
	if err != nil {
		t.Fatalf("build PVC: %v", err)
	}
	deletingAt := metav1.NewTime(now.Add(-time.Second))
	pvc.DeletionTimestamp = &deletingAt
	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(review, pvc).WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: kube, Scheme: scheme, Now: func() time.Time { return now }}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	result, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("reconcile terminating workspace: %v", err)
	}
	if result.RequeueAfter <= 0 {
		t.Fatal("terminating workspace must requeue within the existing review deadline")
	}
	var updated reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), req.NamespacedName, &updated); err != nil {
		t.Fatalf("get queued review: %v", err)
	}
	if updated.Status.Phase != reviewv1alpha2.PhaseQueued || updated.Status.Message != workspace.ErrWorkspaceTerminating.Error() {
		t.Fatalf("status = %#v, want queued terminating-workspace state", updated.Status)
	}
	var worker batchv1.Job
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: review.Name + "-worker"}, &worker); !apierrors.IsNotFound(err) {
		t.Fatalf("terminating workspace must not create a worker Job: %v", err)
	}

	// Simulate Kubernetes finishing the prior PVC deletion. The next two
	// reconciles provision the replacement PVC and then admit this attempt.
	pvc.Finalizers = nil
	if err := kube.Update(context.Background(), pvc); err != nil && !apierrors.IsNotFound(err) {
		t.Fatalf("release terminating PVC finalizer: %v", err)
	}
	if err := kube.Delete(context.Background(), pvc); err != nil && !apierrors.IsNotFound(err) {
		t.Fatalf("finish terminating PVC deletion: %v", err)
	}
	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("provision replacement workspace: %v", err)
	}
	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("admit review after workspace deletion: %v", err)
	}
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: review.Name + "-worker"}, &worker); err != nil {
		t.Fatalf("get worker after workspace deletion: %v", err)
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

// REL-733 follow-up: validateProjectionWindow rewrote an exact 15-minute
// equality check into a bounded [900s, 3600s] range check, but that rewrite
// is a distinct code path from pkg/job's own validateInput (job_test.go's
// TestBuildWorkerJobScalesActiveDeadlineWithAdmittedWindow does not exercise
// this file). Pin all four boundary cases directly through Reconcile so a
// regression in either bound fails here.
func TestPRReviewJobV1Alpha2ReconcilerValidatesProjectionWindow(t *testing.T) {
	received := time.Date(2026, 8, 31, 12, 0, 0, 0, time.UTC)
	for _, test := range []struct {
		name        string
		window      time.Duration
		wantInvalid bool
	}{
		{name: "one second under the floor", window: time.Duration(job.MinTerminalDeadlineSeconds)*time.Second - time.Second, wantInvalid: true},
		{name: "exactly the floor", window: time.Duration(job.MinTerminalDeadlineSeconds) * time.Second, wantInvalid: false},
		{name: "exactly the ceiling", window: time.Duration(job.MaxTerminalDeadlineSeconds) * time.Second, wantInvalid: false},
		{name: "one second over the ceiling", window: time.Duration(job.MaxTerminalDeadlineSeconds)*time.Second + time.Second, wantInvalid: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			scheme := v1alpha2Scheme(t)
			review := v1alpha2Review(received)
			review.Spec.TerminalDeadline = metav1.NewTime(received.Add(test.window))
			kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(review).WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
			// now == received: stay well inside whichever window is under test so a
			// valid window does not also trip the separate DeadlineExpired path.
			reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: kube, Scheme: scheme, Now: func() time.Time { return received }}

			if _, err := reconciler.Reconcile(context.Background(), ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}); err != nil {
				t.Fatalf("reconcile: %v", err)
			}
			var updated reviewv1alpha2.PRReviewJob
			if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: review.Name}, &updated); err != nil {
				t.Fatalf("get review: %v", err)
			}
			isInvalidProjection := updated.Status.Phase == reviewv1alpha2.PhaseFailed && meta.FindStatusCondition(updated.Status.Conditions, "Ready") != nil &&
				meta.FindStatusCondition(updated.Status.Conditions, "Ready").Reason == "InvalidProjection"
			if isInvalidProjection != test.wantInvalid {
				t.Fatalf("phase=%s conditions=%#v, want InvalidProjection=%v", updated.Status.Phase, updated.Status.Conditions, test.wantInvalid)
			}
		})
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

func TestPRReviewJobV1Alpha2ReconcilerCountsPublishingWorkersAgainstGlobalLimit(t *testing.T) {
	now := time.Date(2026, 9, 10, 18, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	review := v1alpha2Review(now)
	activePublishingJob := &batchv1.Job{ObjectMeta: metav1.ObjectMeta{
		Name:      "active-publishing-review",
		Namespace: review.Namespace,
		Labels:    map[string]string{"review-yeti.ai/component": job.PublishingWorkerComponent},
	}, Status: batchv1.JobStatus{Active: 1}}
	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(review, activePublishingJob).
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client: kube, Scheme: scheme, Now: func() time.Time { return now }, MaxConcurrentJobs: 1,
	}

	result, err := reconciler.Reconcile(context.Background(), ctrl.Request{
		NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name},
	})
	if err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if result.RequeueAfter <= 0 {
		t.Fatal("an active publishing review must consume the global worker slot")
	}
	var updated reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: review.Name}, &updated); err != nil {
		t.Fatalf("get review: %v", err)
	}
	if updated.Status.Phase != reviewv1alpha2.PhaseQueued {
		t.Fatalf("phase = %s, want Queued", updated.Status.Phase)
	}
	ready := meta.FindStatusCondition(updated.Status.Conditions, "Ready")
	if ready == nil || ready.Reason != "CapacityExceeded" {
		t.Fatalf("ready condition = %#v, want CapacityExceeded", ready)
	}
	var pvc corev1.PersistentVolumeClaim
	if err := kube.Get(context.Background(), types.NamespacedName{
		Namespace: review.Namespace,
		Name:      workspace.PVCName(review.Spec.RepositoryID, review.Spec.PRNumber),
	}, &pvc); err == nil {
		t.Fatal("capacity-queued review must not allocate a workspace PVC")
	}
}

func TestPRReviewJobV1Alpha2ReconcilerAdmitsOldestWaitingReviewFirst(t *testing.T) {
	now := time.Date(2026, 9, 10, 18, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	oldest := v1alpha2Review(now)
	newer := v1alpha2Review(now.Add(time.Minute))
	newer.Name = "ct-review-22222222222222222222222222222222"
	newer.Spec.RunID = "run_22222222222222222222222222222222"
	newer.Spec.DeliveryID = "delivery-2"
	newer.Spec.PRNumber = 43
	newer.Spec.RunSecretName = "ct-review-run-22222222222222222222222222222222"
	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(oldest, newer).
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client: kube, Scheme: scheme, Now: func() time.Time { return now }, MaxConcurrentJobs: 1,
	}

	newerReq := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: newer.Namespace, Name: newer.Name}}
	result, err := reconciler.Reconcile(context.Background(), newerReq)
	if err != nil {
		t.Fatalf("reconcile newer review: %v", err)
	}
	if result.RequeueAfter <= 0 {
		t.Fatal("newer review must requeue behind the older waiting review")
	}
	var queued reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), newerReq.NamespacedName, &queued); err != nil {
		t.Fatalf("get queued newer review: %v", err)
	}
	if queued.Status.Phase != reviewv1alpha2.PhaseQueued {
		t.Fatalf("newer phase = %s, want Queued", queued.Status.Phase)
	}
	ready := meta.FindStatusCondition(queued.Status.Conditions, "Ready")
	if ready == nil || ready.Reason != "CapacityExceeded" {
		t.Fatalf("newer ready condition = %#v, want CapacityExceeded", ready)
	}
	if err := kube.Get(context.Background(), types.NamespacedName{
		Namespace: newer.Namespace,
		Name:      workspace.PVCName(newer.Spec.RepositoryID, newer.Spec.PRNumber),
	}, &corev1.PersistentVolumeClaim{}); !apierrors.IsNotFound(err) {
		t.Fatalf("newer review must not allocate a workspace before the older review: %v", err)
	}

	oldestReq := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: oldest.Namespace, Name: oldest.Name}}
	if result, err := reconciler.Reconcile(context.Background(), oldestReq); err != nil || result.RequeueAfter <= 0 {
		t.Fatalf("provision oldest workspace: result=%#v err=%v", result, err)
	}
	if result, err := reconciler.Reconcile(context.Background(), oldestReq); err != nil || result.RequeueAfter != 0 {
		t.Fatalf("admit oldest review: result=%#v err=%v", result, err)
	}
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: oldest.Namespace, Name: oldest.Name + "-worker"}, &batchv1.Job{}); err != nil {
		t.Fatalf("oldest review worker was not created: %v", err)
	}
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: newer.Namespace, Name: newer.Name + "-worker"}, &batchv1.Job{}); !apierrors.IsNotFound(err) {
		t.Fatalf("newer review must remain unadmitted: %v", err)
	}
}

func TestPRReviewJobV1Alpha2ReconcilerUsesOneAuthoritativeReviewSnapshotPerAdmission(t *testing.T) {
	now := time.Date(2026, 9, 10, 18, 0, 0, 0, time.UTC)

	t.Run("free capacity reuses one snapshot for FIFO", func(t *testing.T) {
		scheme := v1alpha2Scheme(t)
		oldest := v1alpha2Review(now.Add(-time.Minute))
		oldest.Name = "ct-review-99999999999999999999999999999999"
		oldest.Spec.RunID = "run_99999999999999999999999999999999"
		oldest.Spec.DeliveryID = "delivery-count-oldest"
		oldest.Spec.PRNumber = 49
		oldest.Spec.RunSecretName = "ct-review-run-99999999999999999999999999999999"

		current := v1alpha2Review(now)
		current.Name = "ct-review-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
		current.Spec.RunID = "run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
		current.Spec.DeliveryID = "delivery-count-current"
		current.Spec.PRNumber = 50
		current.Spec.RunSecretName = "ct-review-run-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

		kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(oldest, current).
			WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
		reader := &countingAdmissionReader{Reader: kube}
		reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
			Client: kube, APIReader: reader, Scheme: scheme, Now: func() time.Time { return now }, MaxConcurrentJobs: 1,
		}

		result, err := reconciler.Reconcile(context.Background(), ctrl.Request{
			NamespacedName: types.NamespacedName{Namespace: current.Namespace, Name: current.Name},
		})
		if err != nil {
			t.Fatalf("reconcile current review: %v", err)
		}
		if result.RequeueAfter <= 0 {
			t.Fatal("current review must remain behind the older waiting review")
		}
		if reader.reviewListCalls != 1 {
			t.Fatalf("authoritative PRReviewJobList calls = %d, want 1", reader.reviewListCalls)
		}
		var queued reviewv1alpha2.PRReviewJob
		if err := kube.Get(context.Background(), types.NamespacedName{Namespace: current.Namespace, Name: current.Name}, &queued); err != nil {
			t.Fatalf("get queued review: %v", err)
		}
		if queued.Status.Message != "waiting for an older worker admission candidate" {
			t.Fatalf("queue message = %q, want FIFO blocking", queued.Status.Message)
		}
	})

	t.Run("occupied capacity skips the review snapshot", func(t *testing.T) {
		scheme := v1alpha2Scheme(t)
		current := v1alpha2Review(now)
		activeWorker := &batchv1.Job{ObjectMeta: metav1.ObjectMeta{
			Name:      "other-review-worker",
			Namespace: current.Namespace,
			Labels: map[string]string{
				"review-yeti.ai/component": job.ReceiptOnlyWorkerComponent,
			},
		}}
		kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(current, activeWorker).
			WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
		reader := &countingAdmissionReader{Reader: kube}
		reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
			Client: kube, APIReader: reader, Scheme: scheme, Now: func() time.Time { return now }, MaxConcurrentJobs: 1,
		}

		result, err := reconciler.Reconcile(context.Background(), ctrl.Request{
			NamespacedName: types.NamespacedName{Namespace: current.Namespace, Name: current.Name},
		})
		if err != nil {
			t.Fatalf("reconcile current review: %v", err)
		}
		if result.RequeueAfter <= 0 {
			t.Fatal("current review must remain queued behind the active worker")
		}
		if reader.reviewListCalls != 0 {
			t.Fatalf("authoritative PRReviewJobList calls = %d, want 0 when Job capacity is full", reader.reviewListCalls)
		}
	})
}

func TestPRReviewJobV1Alpha2ReconcilerUsesAPIReaderForReservationAdmissionSnapshot(t *testing.T) {
	now := time.Date(2026, 9, 10, 18, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	// The reservation is later than the current request. A cached-only
	// implementation would see an unreserved, newer sibling and admit the
	// current review, so FIFO alone cannot make this regression pass.
	cachedCandidate := v1alpha2Review(now.Add(time.Minute))
	cachedCandidate.Name = "ct-review-77777777777777777777777777777777"
	cachedCandidate.Spec.RunID = "run_77777777777777777777777777777777"
	cachedCandidate.Spec.DeliveryID = "delivery-7"
	cachedCandidate.Spec.PRNumber = 47
	cachedCandidate.Spec.RunSecretName = "ct-review-run-77777777777777777777777777777777"
	authoritativeCandidate := cachedCandidate.DeepCopy()
	meta.SetStatusCondition(&authoritativeCandidate.Status.Conditions, metav1.Condition{
		Type:               "WorkerCreationReserved",
		Status:             metav1.ConditionTrue,
		LastTransitionTime: metav1.NewTime(now),
	})

	cachedCurrent := v1alpha2Review(now)
	cachedCurrent.Name = "ct-review-88888888888888888888888888888888"
	cachedCurrent.Spec.RunID = "run_88888888888888888888888888888888"
	cachedCurrent.Spec.DeliveryID = "delivery-8"
	cachedCurrent.Spec.PRNumber = 48
	cachedCurrent.Spec.RunSecretName = "ct-review-run-88888888888888888888888888888888"
	authoritativeCurrent := cachedCurrent.DeepCopy()

	cached := fake.NewClientBuilder().WithScheme(scheme).WithObjects(cachedCandidate, cachedCurrent).
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
	authoritative := fake.NewClientBuilder().WithScheme(scheme).WithObjects(authoritativeCandidate, authoritativeCurrent).
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client: cached, APIReader: authoritative, Scheme: scheme, Now: func() time.Time { return now }, MaxConcurrentJobs: 1,
	}
	currentReq := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: cachedCurrent.Namespace, Name: cachedCurrent.Name}}
	result, err := reconciler.Reconcile(context.Background(), currentReq)
	if err != nil {
		t.Fatalf("reconcile newer review: %v", err)
	}
	if result.RequeueAfter <= 0 {
		t.Fatal("authoritative reservation must keep the current review queued")
	}
	var queued reviewv1alpha2.PRReviewJob
	if err := cached.Get(context.Background(), currentReq.NamespacedName, &queued); err != nil {
		t.Fatalf("get queued current review: %v", err)
	}
	ready := meta.FindStatusCondition(queued.Status.Conditions, "Ready")
	if queued.Status.Phase != reviewv1alpha2.PhaseQueued || ready == nil || ready.Reason != "CapacityExceeded" || queued.Status.Message != "waiting for one of 1 worker slots" {
		t.Fatalf("current status = %#v, want CapacityExceeded queue", queued.Status)
	}
	if err := cached.Get(context.Background(), types.NamespacedName{
		Namespace: cachedCurrent.Namespace,
		Name:      workspace.PVCName(cachedCurrent.Spec.RepositoryID, cachedCurrent.Spec.PRNumber),
	}, &corev1.PersistentVolumeClaim{}); !apierrors.IsNotFound(err) {
		t.Fatalf("current review must not allocate against a stale cache: %v", err)
	}
	var cachedCandidateAfter reviewv1alpha2.PRReviewJob
	if err := cached.Get(context.Background(), types.NamespacedName{Namespace: cachedCandidate.Namespace, Name: cachedCandidate.Name}, &cachedCandidateAfter); err != nil {
		t.Fatalf("get cached candidate: %v", err)
	}
	if meta.IsStatusConditionTrue(cachedCandidateAfter.Status.Conditions, "WorkerCreationReserved") {
		t.Fatal("cached unreserved candidate was unexpectedly mutated")
	}
	var authoritativeCandidateAfter reviewv1alpha2.PRReviewJob
	if err := authoritative.Get(context.Background(), types.NamespacedName{Namespace: authoritativeCandidate.Namespace, Name: authoritativeCandidate.Name}, &authoritativeCandidateAfter); err != nil {
		t.Fatalf("get authoritative candidate: %v", err)
	}
	if !meta.IsStatusConditionTrue(authoritativeCandidateAfter.Status.Conditions, "WorkerCreationReserved") {
		t.Fatal("authoritative reservation was not preserved")
	}
}

func TestPRReviewJobV1Alpha2ReconcilerUsesAPIReaderForFIFOAdmissionSnapshot(t *testing.T) {
	now := time.Date(2026, 9, 10, 18, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	oldest := v1alpha2Review(now.Add(-time.Minute))
	oldest.Name = "ct-review-99999999999999999999999999999999"
	oldest.Spec.RunID = "run_99999999999999999999999999999999"
	oldest.Spec.DeliveryID = "delivery-9"
	oldest.Spec.PRNumber = 49
	oldest.Spec.RunSecretName = "ct-review-run-99999999999999999999999999999999"

	newer := v1alpha2Review(now)
	newer.Name = "ct-review-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	newer.Spec.RunID = "run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	newer.Spec.DeliveryID = "delivery-a"
	newer.Spec.PRNumber = 50
	newer.Spec.RunSecretName = "ct-review-run-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	cached := fake.NewClientBuilder().WithScheme(scheme).WithObjects(newer).
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
	authoritative := fake.NewClientBuilder().WithScheme(scheme).WithObjects(oldest, newer.DeepCopy()).
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client: cached, APIReader: authoritative, Scheme: scheme, Now: func() time.Time { return now }, MaxConcurrentJobs: 1,
	}
	newerReq := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: newer.Namespace, Name: newer.Name}}
	result, err := reconciler.Reconcile(context.Background(), newerReq)
	if err != nil {
		t.Fatalf("reconcile newer review: %v", err)
	}
	if result.RequeueAfter <= 0 {
		t.Fatal("authoritative older candidate must keep the newer review queued")
	}
	var queued reviewv1alpha2.PRReviewJob
	if err := cached.Get(context.Background(), newerReq.NamespacedName, &queued); err != nil {
		t.Fatalf("get queued newer review: %v", err)
	}
	ready := meta.FindStatusCondition(queued.Status.Conditions, "Ready")
	if queued.Status.Phase != reviewv1alpha2.PhaseQueued || ready == nil || ready.Reason != "CapacityExceeded" {
		t.Fatalf("newer status = %#v, want CapacityExceeded queue", queued.Status)
	}
	if err := cached.Get(context.Background(), types.NamespacedName{
		Namespace: newer.Namespace,
		Name:      workspace.PVCName(newer.Spec.RepositoryID, newer.Spec.PRNumber),
	}, &corev1.PersistentVolumeClaim{}); !apierrors.IsNotFound(err) {
		t.Fatalf("newer review must not allocate against a stale FIFO cache: %v", err)
	}
}

func TestPRReviewJobV1Alpha2ReconcilerSkipsInvalidAdmissionCandidates(t *testing.T) {
	now := time.Date(2026, 9, 10, 18, 0, 0, 0, time.UTC)
	for _, test := range []struct {
		name   string
		mutate func(*reviewv1alpha2.PRReviewJob)
	}{
		{
			name: "unmarked expired",
			mutate: func(candidate *reviewv1alpha2.PRReviewJob) {
				received := now.Add(-20 * time.Minute)
				candidate.Spec.ReceivedAt = metav1.NewTime(received)
				candidate.Spec.TerminalDeadline = metav1.NewTime(received.Add(15 * time.Minute))
			},
		},
		{
			name: "malformed projection window",
			mutate: func(candidate *reviewv1alpha2.PRReviewJob) {
				candidate.Spec.TerminalDeadline = metav1.NewTime(candidate.Spec.ReceivedAt.Time.Add(10 * time.Minute))
			},
		},
		{
			name: "unknown phase",
			mutate: func(candidate *reviewv1alpha2.PRReviewJob) {
				candidate.Status.Phase = reviewv1alpha2.PRReviewJobPhase("Unknown")
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			scheme := v1alpha2Scheme(t)
			candidate := v1alpha2Review(now.Add(-time.Minute))
			candidate.Name = "ct-review-33333333333333333333333333333333"
			candidate.Spec.RunID = "run_33333333333333333333333333333333"
			candidate.Spec.DeliveryID = "delivery-3"
			candidate.Spec.PRNumber = 43
			candidate.Spec.RunSecretName = "ct-review-run-33333333333333333333333333333333"
			test.mutate(candidate)
			beforeStatus := candidate.Status.DeepCopy()

			newer := v1alpha2Review(now)
			newer.Name = "ct-review-44444444444444444444444444444444"
			newer.Spec.RunID = "run_44444444444444444444444444444444"
			newer.Spec.DeliveryID = "delivery-4"
			newer.Spec.PRNumber = 44
			newer.Spec.RunSecretName = "ct-review-run-44444444444444444444444444444444"
			kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(candidate, newer).
				WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
			reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
				Client: kube, Scheme: scheme, Now: func() time.Time { return now }, MaxConcurrentJobs: 1,
			}

			newerReq := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: newer.Namespace, Name: newer.Name}}
			result, err := reconciler.Reconcile(context.Background(), newerReq)
			if err != nil {
				t.Fatalf("reconcile newer review: %v", err)
			}
			if result.RequeueAfter <= 0 {
				t.Fatal("valid newer review must continue through workspace admission")
			}
			var updated reviewv1alpha2.PRReviewJob
			if err := kube.Get(context.Background(), newerReq.NamespacedName, &updated); err != nil {
				t.Fatalf("get newer review: %v", err)
			}
			ready := meta.FindStatusCondition(updated.Status.Conditions, "Ready")
			if ready != nil && ready.Reason == "CapacityExceeded" {
				t.Fatal("invalid sibling must not make a valid newer review capacity-queued")
			}
			if err := kube.Get(context.Background(), types.NamespacedName{
				Namespace: newer.Namespace,
				Name:      workspace.PVCName(newer.Spec.RepositoryID, newer.Spec.PRNumber),
			}, &corev1.PersistentVolumeClaim{}); err != nil {
				t.Fatalf("valid newer review did not reach workspace admission: %v", err)
			}

			var storedCandidate reviewv1alpha2.PRReviewJob
			if err := kube.Get(context.Background(), types.NamespacedName{Namespace: candidate.Namespace, Name: candidate.Name}, &storedCandidate); err != nil {
				t.Fatalf("get sibling candidate: %v", err)
			}
			gotStatus := storedCandidate.Status.DeepCopy()
			wantStatus := beforeStatus.DeepCopy()
			for index := range gotStatus.Conditions {
				gotStatus.Conditions[index].LastTransitionTime = metav1.NewTime(gotStatus.Conditions[index].LastTransitionTime.Time.UTC())
			}
			for index := range wantStatus.Conditions {
				wantStatus.Conditions[index].LastTransitionTime = metav1.NewTime(wantStatus.Conditions[index].LastTransitionTime.Time.UTC())
			}
			if !reflect.DeepEqual(*gotStatus, *wantStatus) {
				t.Fatalf("sibling candidate status mutated during newer reconcile: got=%#v want=%#v", *gotStatus, *wantStatus)
			}
		})
	}
}

func TestPRReviewJobV1Alpha2ReconcilerCountsUnobservedWorkerAttemptAgainstCapacity(t *testing.T) {
	now := time.Date(2026, 9, 10, 18, 0, 0, 0, time.UTC)
	for _, test := range []struct {
		name   string
		mutate func(*reviewv1alpha2.PRReviewJob)
	}{
		{
			name: "creation reservation",
			mutate: func(candidate *reviewv1alpha2.PRReviewJob) {
				meta.SetStatusCondition(&candidate.Status.Conditions, metav1.Condition{
					Type:               "WorkerCreationReserved",
					Status:             metav1.ConditionTrue,
					LastTransitionTime: metav1.NewTime(now),
				})
			},
		},
		{
			name: "legacy running phase",
			mutate: func(candidate *reviewv1alpha2.PRReviewJob) {
				candidate.Status.Phase = reviewv1alpha2.PhaseRunning
			},
		},
		{
			name: "legacy job name",
			mutate: func(candidate *reviewv1alpha2.PRReviewJob) {
				candidate.Status.JobName = candidate.Name + "-worker"
			},
		},
		{
			name: "legacy start time",
			mutate: func(candidate *reviewv1alpha2.PRReviewJob) {
				started := metav1.NewTime(now)
				candidate.Status.StartTime = &started
			},
		},
		{
			name: "legacy timing",
			mutate: func(candidate *reviewv1alpha2.PRReviewJob) {
				started := metav1.NewTime(now)
				candidate.Status.Timing = &reviewv1alpha2.DispatchTimingStatus{JobCreatedAt: &started}
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			scheme := v1alpha2Scheme(t)
			candidate := v1alpha2Review(now.Add(-time.Minute))
			candidate.Name = "ct-review-55555555555555555555555555555555"
			candidate.Spec.RunID = "run_55555555555555555555555555555555"
			candidate.Spec.DeliveryID = "delivery-5"
			candidate.Spec.PRNumber = 45
			candidate.Spec.RunSecretName = "ct-review-run-55555555555555555555555555555555"
			test.mutate(candidate)

			newer := v1alpha2Review(now)
			newer.Name = "ct-review-66666666666666666666666666666666"
			newer.Spec.RunID = "run_66666666666666666666666666666666"
			newer.Spec.DeliveryID = "delivery-6"
			newer.Spec.PRNumber = 46
			newer.Spec.RunSecretName = "ct-review-run-66666666666666666666666666666666"
			kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(candidate, newer).
				WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
			reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
				Client: kube, Scheme: scheme, Now: func() time.Time { return now }, MaxConcurrentJobs: 1,
			}
			newerReq := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: newer.Namespace, Name: newer.Name}}
			result, err := reconciler.Reconcile(context.Background(), newerReq)
			if err != nil {
				t.Fatalf("reconcile newer review: %v", err)
			}
			if result.RequeueAfter <= 0 {
				t.Fatal("unobserved worker attempt must keep the valid newer review queued")
			}
			var queued reviewv1alpha2.PRReviewJob
			if err := kube.Get(context.Background(), newerReq.NamespacedName, &queued); err != nil {
				t.Fatalf("get queued newer review: %v", err)
			}
			ready := meta.FindStatusCondition(queued.Status.Conditions, "Ready")
			if queued.Status.Phase != reviewv1alpha2.PhaseQueued || ready == nil || ready.Reason != "CapacityExceeded" {
				t.Fatalf("newer status = %#v, want CapacityExceeded queue", queued.Status)
			}
			if err := kube.Get(context.Background(), types.NamespacedName{
				Namespace: newer.Namespace,
				Name:      workspace.PVCName(newer.Spec.RepositoryID, newer.Spec.PRNumber),
			}, &corev1.PersistentVolumeClaim{}); !apierrors.IsNotFound(err) {
				t.Fatalf("newer review must not allocate while worker evidence is unobserved: %v", err)
			}

			candidateReq := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: candidate.Namespace, Name: candidate.Name}}
			if result, err := reconciler.Reconcile(context.Background(), candidateReq); err != nil || result.RequeueAfter <= 0 {
				t.Fatalf("terminalize unobserved candidate: result=%#v err=%v", result, err)
			}
			var terminal reviewv1alpha2.PRReviewJob
			if err := kube.Get(context.Background(), candidateReq.NamespacedName, &terminal); err != nil {
				t.Fatalf("get terminal candidate: %v", err)
			}
			if terminal.Status.Phase != reviewv1alpha2.PhaseFailed {
				t.Fatalf("candidate phase = %s, want Failed after guarded missing-Job attempt", terminal.Status.Phase)
			}
			if _, err := reconciler.Reconcile(context.Background(), newerReq); err != nil {
				t.Fatalf("reconcile newer review after terminal attempt: %v", err)
			}
			if err := kube.Get(context.Background(), types.NamespacedName{
				Namespace: newer.Namespace,
				Name:      workspace.PVCName(newer.Spec.RepositoryID, newer.Spec.PRNumber),
			}, &corev1.PersistentVolumeClaim{}); err != nil {
				t.Fatalf("newer review did not proceed after candidate terminalized: %v", err)
			}
		})
	}
}

func TestPRReviewJobV1Alpha2ReconcilerUsesStableEqualReceivedAtTieBreakers(t *testing.T) {
	now := time.Date(2026, 9, 10, 18, 0, 0, 0, time.UTC)
	for _, test := range []struct {
		name             string
		candidateName    string
		newerName        string
		candidateCreated time.Time
		newerCreated     time.Time
		wantBlocked      bool
	}{
		{
			name:             "creation timestamp wins before name",
			candidateName:    "ct-review-99999999999999999999999999999999",
			newerName:        "ct-review-11111111111111111111111111111111",
			candidateCreated: now.Add(-time.Minute),
			newerCreated:     now,
			wantBlocked:      true,
		},
		{
			name:             "newer creation timestamp does not block",
			candidateName:    "ct-review-11111111111111111111111111111111",
			newerName:        "ct-review-99999999999999999999999999999999",
			candidateCreated: now,
			newerCreated:     now.Add(-time.Minute),
			wantBlocked:      false,
		},
		{
			name:             "name wins when creation timestamps match",
			candidateName:    "ct-review-11111111111111111111111111111111",
			newerName:        "ct-review-99999999999999999999999999999999",
			candidateCreated: now,
			newerCreated:     now,
			wantBlocked:      true,
		},
		{
			name:             "higher name does not block when timestamps match",
			candidateName:    "ct-review-99999999999999999999999999999999",
			newerName:        "ct-review-11111111111111111111111111111111",
			candidateCreated: now,
			newerCreated:     now,
			wantBlocked:      false,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			scheme := v1alpha2Scheme(t)
			candidate := v1alpha2Review(now)
			candidate.Spec.RunnerMode = "generic"
			candidate.Name = test.candidateName
			candidate.Spec.RunID = "run_11111111111111111111111111111111"
			candidate.Spec.DeliveryID = "delivery-tie-candidate"
			candidate.Spec.PRNumber = 43
			candidate.Spec.RunSecretName = "ct-review-run-11111111111111111111111111111111"
			candidate.CreationTimestamp = metav1.NewTime(test.candidateCreated)

			newer := v1alpha2Review(now)
			newer.Spec.RunnerMode = "generic"
			newer.Name = test.newerName
			newer.Spec.RunID = "run_99999999999999999999999999999999"
			newer.Spec.DeliveryID = "delivery-tie-newer"
			newer.Spec.PRNumber = 44
			newer.Spec.RunSecretName = "ct-review-run-99999999999999999999999999999999"
			newer.CreationTimestamp = metav1.NewTime(test.newerCreated)

			kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(candidate, newer).
				WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
			reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
				Client: kube, Scheme: scheme, Now: func() time.Time { return now }, MaxConcurrentJobs: 1,
			}
			result, err := reconciler.Reconcile(context.Background(), ctrl.Request{
				NamespacedName: types.NamespacedName{Namespace: newer.Namespace, Name: newer.Name},
			})
			if err != nil {
				t.Fatalf("reconcile newer review: %v", err)
			}
			var updated reviewv1alpha2.PRReviewJob
			if err := kube.Get(context.Background(), types.NamespacedName{Namespace: newer.Namespace, Name: newer.Name}, &updated); err != nil {
				t.Fatalf("get newer review: %v", err)
			}
			ready := meta.FindStatusCondition(updated.Status.Conditions, "Ready")
			blocked := ready != nil && ready.Reason == "CapacityExceeded"
			if blocked != test.wantBlocked {
				t.Fatalf("blocked=%v condition=%#v result=%#v, want %v", blocked, ready, result, test.wantBlocked)
			}
			var pvc corev1.PersistentVolumeClaim
			err = kube.Get(context.Background(), types.NamespacedName{
				Namespace: newer.Namespace,
				Name:      workspace.PVCName(newer.Spec.RepositoryID, newer.Spec.PRNumber),
			}, &pvc)
			if test.wantBlocked && !apierrors.IsNotFound(err) {
				t.Fatalf("blocked newer review must not create a PVC: %v", err)
			}
			if !test.wantBlocked && err != nil {
				t.Fatalf("unblocked newer review must create a PVC: %v", err)
			}
		})
	}
}

// REL-586: no controller test exercised the app-gate lane, so the Job builder and
// the reconciler's contract matcher drifted apart unnoticed. The matcher required
// the publication-mode label to be "disabled" and rejected any env carrying
// GH_TOKEN -- both true of every publishing Job the builder produces -- and a
// rejected Job is DELETED. The operator destroyed each publishing worker it had
// just created, so the lane could never have run once.
func TestPRReviewJobV1Alpha2ReconcilerKeepsItsOwnAppGateWorker(t *testing.T) {
	now := time.Date(2026, 9, 1, 20, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	review := v1alpha2Review(now)
	review.UID = types.UID("app-gate-review")
	review.Spec.PublicationMode = "app-gate"
	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(review).WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client: kube,
		Scheme: scheme,
		Now:    func() time.Time { return now },
		Publishing: job.PublishingConfig{
			GatewayBaseURL:    "https://gateway.example.invalid/v1",
			Model:             "ollama/glm-5.3-flash",
			GatewaySecretName: "review-yeti-gateway-credentials",
			GatewaySecretKey:  "REVIEW_YETI_BIFROST_API_KEY",
			CompletionURL:     "https://dispatch.example.invalid/api/dispatch/completion",
		},
	}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	for attempt := 0; attempt < 3; attempt++ {
		if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
			t.Fatalf("reconcile %d: %v", attempt, err)
		}
	}

	workerKey := types.NamespacedName{Namespace: review.Namespace, Name: review.Name + "-worker"}
	var worker batchv1.Job
	if err := kube.Get(context.Background(), workerKey, &worker); err != nil {
		t.Fatalf("app-gate worker was deleted by its own operator: %v", err)
	}
	if worker.Labels["review-yeti.ai/publication-mode"] != "app-gate" {
		t.Fatalf("publication-mode label = %q", worker.Labels["review-yeti.ai/publication-mode"])
	}
	var updated reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), req.NamespacedName, &updated); err != nil {
		t.Fatal(err)
	}
	if updated.Status.Phase == reviewv1alpha2.PhaseFailed {
		t.Fatalf("app-gate review failed its own contract: %s", updated.Status.Message)
	}
}

// A tampered app-gate worker must still be rejected. Widening the matcher to admit
// the lane must not turn it into a lane that accepts anything -- and this PR exists
// because a matcher and a builder drifted apart untested, so the matcher's own
// constraints get the same treatment.
func TestPRReviewJobV1Alpha2ReconcilerStopsTamperedAppGateWorkers(t *testing.T) {
	cases := map[string]func(env []corev1.EnvVar) []corev1.EnvVar{
		"app private key injected": func(env []corev1.EnvVar) []corev1.EnvVar {
			return append(env, corev1.EnvVar{Name: "GITHUB_APP_PRIVATE_KEY", Value: "leaked"})
		},
		"provider key injected": func(env []corev1.EnvVar) []corev1.EnvVar {
			return append(env, corev1.EnvVar{Name: "OPENROUTER_API_KEY", Value: "leaked"})
		},
		"publish token missing": func(env []corev1.EnvVar) []corev1.EnvVar {
			return withoutEnv(env, "GITHUB_PUBLISH_TOKEN")
		},
		"read token missing": func(env []corev1.EnvVar) []corev1.EnvVar {
			return withoutEnv(env, "GH_TOKEN")
		},
		"read token points at the publish key": func(env []corev1.EnvVar) []corev1.EnvVar {
			out := withoutEnv(env, "GH_TOKEN")
			return append(out, secretEnv("GH_TOKEN", runSecretNameOf(env), "GITHUB_PUBLISH_TOKEN"))
		},
		"publish token points at a foreign secret": func(env []corev1.EnvVar) []corev1.EnvVar {
			out := withoutEnv(env, "GITHUB_PUBLISH_TOKEN")
			return append(out, secretEnv("GITHUB_PUBLISH_TOKEN", "ct-review-action-dispatch-runtime", "GITHUB_PUBLISH_TOKEN"))
		},
		"publish token duplicated": func(env []corev1.EnvVar) []corev1.EnvVar {
			return append(env, secretEnv("GITHUB_PUBLISH_TOKEN", runSecretNameOf(env), "GITHUB_PUBLISH_TOKEN"))
		},
		"receipt-only marker injected": func(env []corev1.EnvVar) []corev1.EnvVar {
			return append(env, corev1.EnvVar{Name: job.ReceiptOnlyEnv, Value: "true"})
		},
		"qualification marker injected": func(env []corev1.EnvVar) []corev1.EnvVar {
			return append(env, corev1.EnvVar{Name: job.SameHeadQualificationEnv, Value: "true"})
		},
	}
	for name, tamper := range cases {
		t.Run(name, func(t *testing.T) {
			now := time.Date(2026, 9, 1, 20, 0, 0, 0, time.UTC)
			scheme := v1alpha2Scheme(t)
			review := v1alpha2Review(now)
			review.UID = types.UID("app-gate-tampered")
			review.Spec.PublicationMode = "app-gate"
			kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(review).
				WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
			reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
				Client: kube, Scheme: scheme, Now: func() time.Time { return now },
				Publishing: job.PublishingConfig{
					GatewayBaseURL:    "https://gateway.example.invalid/v1",
					Model:             "ollama/glm-5.3-flash",
					GatewaySecretName: "review-yeti-gateway-credentials",
					GatewaySecretKey:  "REVIEW_YETI_BIFROST_API_KEY",
					CompletionURL:     "https://dispatch.example.invalid/api/dispatch/completion",
				},
			}
			req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}
			for attempt := 0; attempt < 2; attempt++ {
				if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
					t.Fatal(err)
				}
			}
			workerKey := types.NamespacedName{Namespace: review.Namespace, Name: review.Name + "-worker"}
			var worker batchv1.Job
			if err := kube.Get(context.Background(), workerKey, &worker); err != nil {
				t.Fatal(err)
			}
			container := &worker.Spec.Template.Spec.Containers[0]
			container.Env = tamper(container.Env)
			if err := kube.Update(context.Background(), &worker); err != nil {
				t.Fatal(err)
			}
			if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
				t.Fatal(err)
			}
			var failed reviewv1alpha2.PRReviewJob
			if err := kube.Get(context.Background(), req.NamespacedName, &failed); err != nil {
				t.Fatal(err)
			}
			if failed.Status.Phase != reviewv1alpha2.PhaseFailed {
				t.Fatalf("tampered app-gate worker (%s) did not durably fail before deletion", name)
			}
			publication := meta.FindStatusCondition(failed.Status.Conditions, "FailurePublication")
			if publication == nil || publication.Status != metav1.ConditionFalse || publication.Reason != "WorkerContractMismatch" {
				t.Fatalf("failure publication condition = %#v, want durable pending obligation", publication)
			}
			if err := kube.Get(context.Background(), workerKey, &batchv1.Job{}); err != nil {
				t.Fatalf("tampered app-gate worker was removed before the parent obligation became durable: %v", err)
			}
			if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
				t.Fatal(err)
			}
			if err := kube.Get(context.Background(), req.NamespacedName, &failed); err != nil {
				t.Fatal(err)
			}
			publication = meta.FindStatusCondition(failed.Status.Conditions, "FailurePublication")
			if publication == nil || publication.Status != metav1.ConditionUnknown || publication.Reason != "DelegatedToTrustedService" {
				t.Fatalf("failure publication condition = %#v, want trusted-service delegation", publication)
			}
			var stopping batchv1.Job
			if err := kube.Get(context.Background(), workerKey, &stopping); err != nil {
				t.Fatalf("tampered app-gate worker disappeared before terminal evidence was released: %v", err)
			}
			if stopping.DeletionTimestamp == nil {
				t.Fatal("tampered app-gate worker was not stopped after durable delegation")
			}
			assertFailurePublisherAbsent(t, kube, req)
			if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
				t.Fatal(err)
			}
			if err := kube.Get(context.Background(), workerKey, &batchv1.Job{}); !apierrors.IsNotFound(err) {
				t.Fatalf("tampered app-gate worker (%s) was not removed after finalizer release: %v", name, err)
			}
		})
	}
}

func withoutEnv(env []corev1.EnvVar, name string) []corev1.EnvVar {
	out := make([]corev1.EnvVar, 0, len(env))
	for _, variable := range env {
		if variable.Name != name {
			out = append(out, variable)
		}
	}
	return out
}

func secretEnv(name, secret, key string) corev1.EnvVar {
	return corev1.EnvVar{Name: name, ValueFrom: &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{
		LocalObjectReference: corev1.LocalObjectReference{Name: secret},
		Key:                  key,
	}}}
}

func runSecretNameOf(env []corev1.EnvVar) string {
	for _, variable := range env {
		if variable.Name == "GITHUB_PUBLISH_TOKEN" && variable.ValueFrom != nil && variable.ValueFrom.SecretKeyRef != nil {
			return variable.ValueFrom.SecretKeyRef.Name
		}
	}
	return ""
}
