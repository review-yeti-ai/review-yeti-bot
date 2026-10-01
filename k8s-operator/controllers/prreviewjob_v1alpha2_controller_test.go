package controllers_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	coordinationv1 "k8s.io/api/coordination/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"
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
			// A real API server always stamps this on create; set it explicitly so
			// terminalObservedAt's metadata.creationTimestamp fallback (used only
			// when status.completionTime is unset) is exercised the same way here
			// as it would be against a live cluster, instead of the fake client's
			// zero-value default.
			CreationTimestamp: metav1.NewTime(now),
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

func TestPRReviewJobV1Alpha2ReconcilerCreatesEmptyDirWorkerWithoutPVC(t *testing.T) {
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
	if result.RequeueAfter > 0 {
		t.Fatal("worker Job should be created without requeue")
	}

	var pvc corev1.PersistentVolumeClaim
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: workspace.PVCName(review.Spec.RepositoryID, review.Spec.PRNumber)}, &pvc); !apierrors.IsNotFound(err) {
		t.Fatalf("expected no PVC to be created under emptyDir storage: %v", err)
	}

	var worker batchv1.Job
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: review.Name + "-worker"}, &worker); err != nil {
		t.Fatalf("get worker Job: %v", err)
	}
	var foundWorkspace bool
	for _, vol := range worker.Spec.Template.Spec.Volumes {
		if vol.Name == "workspace" {
			foundWorkspace = true
			if vol.EmptyDir == nil {
				t.Fatalf("workspace volume %#v is not emptyDir", vol)
			}
		}
	}
	if !foundWorkspace {
		t.Fatal("workspace volume not found")
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
	pvc, err := workspace.BuildPVC(review.Namespace, review.Spec.RepositoryID, review.Spec.PRNumber, now.Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(review, pvc).WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: kube, Scheme: scheme, Now: func() time.Time { return now }}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}
	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	var worker batchv1.Job
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: review.Name + "-worker"}, &worker); err != nil {
		t.Fatal(err)
	}
	attachReceiptAnnotations(&worker)
	if err := kube.Update(context.Background(), &worker); err != nil {
		t.Fatalf("update worker annotations: %v", err)
	}
	worker.Status.Succeeded = 1
	if err := kube.Status().Update(context.Background(), &worker); err != nil {
		t.Fatalf("mark worker succeeded: %v", err)
	}
	beforeWebhookToJob := histogramSampleCount(t, "review_yeti_operator_webhook_to_job_duration_seconds")
	beforeWebhookToCompletion := histogramSampleCount(t, "review_yeti_operator_webhook_to_completion_duration_seconds")
	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("terminal reconcile: %v", err)
	}
	if got := histogramSampleCount(t, "review_yeti_operator_webhook_to_job_duration_seconds"); got != beforeWebhookToJob+1 {
		t.Fatalf("webhook-to-job histogram count = %d, want %d", got, beforeWebhookToJob+1)
	}
	if got := histogramSampleCount(t, "review_yeti_operator_webhook_to_completion_duration_seconds"); got != beforeWebhookToCompletion+1 {
		t.Fatalf("webhook-to-completion histogram count = %d, want %d", got, beforeWebhookToCompletion+1)
	}
	var updated reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), req.NamespacedName, &updated); err != nil {
		t.Fatal(err)
	}
	if updated.Status.Phase != reviewv1alpha2.PhaseSucceeded || updated.Status.CompletionTime == nil {
		t.Fatalf("terminal status = %#v", updated.Status)
	}
	var storedPVC corev1.PersistentVolumeClaim
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: workspace.PVCName(review.Spec.RepositoryID, review.Spec.PRNumber)}, &storedPVC); err != nil {
		t.Fatal(err)
	}
	if storedPVC.Annotations[workspace.LastUsedAtAnnotation] != now.Format(time.RFC3339Nano) {
		t.Fatalf("last-used-at = %q, want %q", storedPVC.Annotations[workspace.LastUsedAtAnnotation], now.Format(time.RFC3339Nano))
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
	// REL-896: pin an explicit terminal retention so this test's "immediate"
	// claim is about the PVC/lease reclaim, not the (separate) review
	// deletion requeue that reconcileTerminalDeletion now also schedules.
	t.Setenv("REVIEW_YETI_TERMINAL_RETENTION_SECONDS", "120")
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: kube, Scheme: v1alpha2Scheme(t), Now: func() time.Time { return currentNow }}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	result, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("reconcile immediately after terminal review: %v", err)
	}
	if result.RequeueAfter != 120*time.Second {
		t.Fatalf("requeue after reclamation = %s, want the 120s terminal retention window", result.RequeueAfter)
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

func TestPRReviewJobV1Alpha2ReconcilerProceedsWithEmptyDirDespiteForeignPVC(t *testing.T) {
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
	if updated.Status.Phase != reviewv1alpha2.PhaseRunning {
		t.Fatalf("phase = %s, want Running", updated.Status.Phase)
	}
	var worker batchv1.Job
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: review.Name + "-worker"}, &worker); err != nil {
		t.Fatalf("worker Job must be created with emptyDir despite foreign PVC: %v", err)
	}
}

func TestPRReviewJobV1Alpha2ReconcilerAdmitsWorkerDespiteTerminatingPriorPVC(t *testing.T) {
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
	if result.RequeueAfter != 0 {
		t.Fatalf("terminating PVC must not cause requeue under emptyDir storage, got: %v", result.RequeueAfter)
	}
	var updated reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), req.NamespacedName, &updated); err != nil {
		t.Fatalf("get review: %v", err)
	}
	if updated.Status.Phase != reviewv1alpha2.PhaseRunning {
		t.Fatalf("status = %#v, want Running", updated.Status)
	}
	var worker batchv1.Job
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: review.Name + "-worker"}, &worker); err != nil {
		t.Fatalf("terminating PVC must not prevent worker Job creation: %v", err)
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

// REL-896: unlike the receipt-only case above, an app-gate review whose worker
// Job cannot even be built still owes the dispatcher a durable verdict -- a
// plain fail leaves the terminal deadline reaper as the only thing left to
// notice it, 15 minutes later. BuildWorkerJob's validatePublishing refuses to
// build with no publishing transport configured, so leaving Publishing unset
// deterministically reproduces a rejected worker contract with no Job ever
// created.
func TestPRReviewJobV1Alpha2ReconcilerDelegatesAppGateWorkerContractRejection(t *testing.T) {
	now := time.Date(2026, 9, 17, 12, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	review := v1alpha2Review(now)
	review.UID = types.UID("app-gate-contract-rejected")
	review.Spec.PublicationMode = "app-gate"
	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(review).WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: kube, Scheme: scheme, Now: func() time.Time { return now }}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	// PVC creation, the rejected build, and the failure-publication delegation
	// each take their own reconcile pass; run enough passes to reach stability.
	for attempt := 0; attempt < 5; attempt++ {
		if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
			t.Fatalf("reconcile %d: %v", attempt, err)
		}
	}

	var updated reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), req.NamespacedName, &updated); err != nil {
		t.Fatal(err)
	}
	if updated.Status.Phase != reviewv1alpha2.PhaseFailed {
		t.Fatalf("phase = %s, want Failed", updated.Status.Phase)
	}
	ready := meta.FindStatusCondition(updated.Status.Conditions, "Ready")
	if ready == nil || ready.Reason != "WorkerContractRejected" {
		t.Fatalf("Ready condition = %#v, want reason WorkerContractRejected", ready)
	}
	publication := meta.FindStatusCondition(updated.Status.Conditions, "FailurePublication")
	if publication == nil || publication.Status != metav1.ConditionUnknown || publication.Reason != "DelegatedToTrustedService" {
		t.Fatalf("FailurePublication condition = %#v, want Unknown/DelegatedToTrustedService", publication)
	}

	if _, err := workspace.NewLeaseManager(kube).Acquire(context.Background(), review.Namespace, review.Spec.RepositoryID, review.Spec.PRNumber, "run_22222222222222222222222222222222", now.Add(15*time.Minute), now.Add(time.Second)); err != nil {
		t.Fatalf("lease remained held after rejected worker contract: %v", err)
	}

	workerKey := types.NamespacedName{Namespace: review.Namespace, Name: review.Name + "-worker"}
	if err := kube.Get(context.Background(), workerKey, &batchv1.Job{}); !apierrors.IsNotFound(err) {
		t.Fatalf("no worker Job should ever exist for a rejected contract, got err=%v", err)
	}

	// Further reconciles must be stable: no error, and no attempt to rebuild
	// the worker Job now that its contract was already rejected.
	for i := 0; i < 3; i++ {
		if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
			t.Fatalf("stabilizing reconcile %d: %v", i, err)
		}
		if err := kube.Get(context.Background(), workerKey, &batchv1.Job{}); !apierrors.IsNotFound(err) {
			t.Fatalf("stabilizing reconcile %d created a worker Job: %v", i, err)
		}
	}
}

// An invalid projection window is rejected before anything is built, the same
// class as a rejected worker contract: an app-gate review must be delegated so
// the pull request gets a failed check promptly rather than at its deadline.
func TestPRReviewJobV1Alpha2ReconcilerDelegatesAppGateInvalidProjection(t *testing.T) {
	now := time.Date(2026, 9, 17, 12, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	review := v1alpha2Review(now)
	review.UID = types.UID("app-gate-invalid-projection")
	review.Spec.PublicationMode = "app-gate"
	review.Spec.TerminalDeadline = metav1.NewTime(now.Add(time.Duration(job.MaxTerminalDeadlineSeconds)*time.Second + time.Second))
	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(review).WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: kube, Scheme: scheme, Now: func() time.Time { return now }}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	workerKey := types.NamespacedName{Namespace: review.Namespace, Name: review.Name + "-worker"}
	for attempt := 0; attempt < 5; attempt++ {
		if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
			t.Fatalf("reconcile %d: %v", attempt, err)
		}
		if err := kube.Get(context.Background(), workerKey, &batchv1.Job{}); !apierrors.IsNotFound(err) {
			t.Fatalf("reconcile %d: no worker Job should exist for an invalid projection, got err=%v", attempt, err)
		}
	}

	var updated reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), req.NamespacedName, &updated); err != nil {
		t.Fatal(err)
	}
	if updated.Status.Phase != reviewv1alpha2.PhaseFailed {
		t.Fatalf("phase = %s, want Failed", updated.Status.Phase)
	}
	ready := meta.FindStatusCondition(updated.Status.Conditions, "Ready")
	if ready == nil || ready.Reason != "InvalidProjection" {
		t.Fatalf("Ready condition = %#v, want reason InvalidProjection", ready)
	}
	publication := meta.FindStatusCondition(updated.Status.Conditions, "FailurePublication")
	if publication == nil || publication.Status != metav1.ConditionUnknown || publication.Reason != "DelegatedToTrustedService" {
		t.Fatalf("FailurePublication condition = %#v, want Unknown/DelegatedToTrustedService", publication)
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

// Pin the exact 15-minute admission invariant through Reconcile independently
// from pkg/job's validation.
func TestPRReviewJobV1Alpha2ReconcilerValidatesProjectionWindow(t *testing.T) {
	received := time.Date(2026, 8, 31, 12, 0, 0, 0, time.UTC)
	for _, test := range []struct {
		name        string
		window      time.Duration
		phase       reviewv1alpha2.PRReviewJobPhase
		wantInvalid bool
	}{
		{name: "one second under", window: 899 * time.Second, wantInvalid: true},
		{name: "legacy queued one second under", window: 899 * time.Second, phase: reviewv1alpha2.PhaseQueued, wantInvalid: true},
		{name: "exactly fifteen minutes", window: 900 * time.Second, wantInvalid: false},
		{name: "one second over", window: 901 * time.Second, wantInvalid: true},
		{name: "legacy unmarked window", window: 35 * time.Minute, wantInvalid: true},
		{name: "legacy queued window", window: 35 * time.Minute, phase: reviewv1alpha2.PhaseQueued, wantInvalid: true},
		{name: "one hour queued window", window: 60 * time.Minute, phase: reviewv1alpha2.PhaseQueued, wantInvalid: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			scheme := v1alpha2Scheme(t)
			review := v1alpha2Review(received)
			review.Spec.TerminalDeadline = metav1.NewTime(received.Add(test.window))
			review.Status.Phase = test.phase
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
		Name:      newer.Name + "-worker",
	}, &batchv1.Job{}); !apierrors.IsNotFound(err) {
		t.Fatalf("newer review must not allocate a worker before the older review: %v", err)
	}

	oldestReq := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: oldest.Namespace, Name: oldest.Name}}
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
			if result.RequeueAfter != 0 {
				t.Fatalf("valid newer review should proceed without requeue, got: %v", result)
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
				Name:      newer.Name + "-worker",
			}, &batchv1.Job{}); err != nil {
				t.Fatalf("valid newer review did not create worker Job: %v", err)
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
					LastTransitionTime: metav1.NewTime(now.Add(-time.Minute)),
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
				Name:      newer.Name + "-worker",
			}, &batchv1.Job{}); err != nil {
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
			var worker batchv1.Job
			err = kube.Get(context.Background(), types.NamespacedName{
				Namespace: newer.Namespace,
				Name:      newer.Name + "-worker",
			}, &worker)
			if test.wantBlocked && !apierrors.IsNotFound(err) {
				t.Fatalf("blocked newer review must not create a worker Job: %v", err)
			}
			if !test.wantBlocked && err != nil {
				t.Fatalf("unblocked newer review must create a worker Job: %v", err)
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

func TestPRReviewJobV1Alpha2WorkerInjectsTripartiteFencingEnv(t *testing.T) {
	now := time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	review := v1alpha2Review(now)
	review.Spec.LogicalChildID = "child-exec-99"
	review.Spec.FencingEpoch = 3
	review.Spec.WorkerLeaseToken = "token-attempt-1"

	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(review).WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: kube, Scheme: scheme, Now: func() time.Time { return now }}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	// First reconcile creates PVC
	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("first reconcile: %v", err)
	}
	// Second reconcile acquires lease and creates worker Job
	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("second reconcile: %v", err)
	}

	var worker batchv1.Job
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: review.Name + "-worker"}, &worker); err != nil {
		t.Fatalf("get worker Job: %v", err)
	}

	container := worker.Spec.Template.Spec.Containers[0]
	childID := ""
	epoch := ""
	token := ""
	for _, env := range container.Env {
		switch env.Name {
		case "CT_LOGICAL_CHILD_ID":
			childID = env.Value
		case "CT_FENCING_EPOCH":
			epoch = env.Value
		case "CT_WORKER_LEASE_TOKEN":
			token = env.Value
		}
	}
	if childID != "child-exec-99" {
		t.Fatalf("CT_LOGICAL_CHILD_ID = %q, want child-exec-99", childID)
	}
	if epoch != "3" {
		t.Fatalf("CT_FENCING_EPOCH = %q, want 3", epoch)
	}
	if token != "token-attempt-1" {
		t.Fatalf("CT_WORKER_LEASE_TOKEN = %q, want token-attempt-1", token)
	}
}

func TestPRReviewJobV1Alpha2FailsClosedOnStaleFencingEpoch(t *testing.T) {
	now := time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	review := v1alpha2Review(now)
	review.Spec.FencingEpoch = 2
	review.Status.AuthoritativeFencingEpoch = 4 // Stale epoch: authoritative is higher

	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(review).WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: kube, Scheme: scheme, Now: func() time.Time { return now }}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	result, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("reconcile error: %v", err)
	}
	if result.RequeueAfter > 0 {
		t.Fatalf("expected immediate fail-closed without requeue, got %v", result.RequeueAfter)
	}

	var updated reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), req.NamespacedName, &updated); err != nil {
		t.Fatalf("get updated review: %v", err)
	}

	if updated.Status.Phase != reviewv1alpha2.PhaseFailed {
		t.Fatalf("status.phase = %s, want %s", updated.Status.Phase, reviewv1alpha2.PhaseFailed)
	}

	cond := meta.FindStatusCondition(updated.Status.Conditions, reviewv1alpha2.ConditionFencingEpochMismatch)
	if cond == nil {
		t.Fatal("expected ConditionFencingEpochMismatch to be set")
	}
	if cond.Status != metav1.ConditionTrue {
		t.Fatalf("ConditionFencingEpochMismatch status = %s, want True", cond.Status)
	}
	if cond.Reason != "EpochMismatch" {
		t.Fatalf("ConditionFencingEpochMismatch reason = %s, want EpochMismatch", cond.Reason)
	}

	readyCond := meta.FindStatusCondition(updated.Status.Conditions, "Ready")
	if readyCond == nil || readyCond.Status != metav1.ConditionFalse {
		t.Fatal("expected Ready condition to be False on epoch mismatch")
	}

	// Verify no worker Job was created
	var worker batchv1.Job
	workerErr := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: review.Name + "-worker"}, &worker)
	if workerErr == nil {
		t.Fatal("worker Job must NOT be created when fencing epoch mismatch occurs")
	}
}

func TestPRReviewJobV1Alpha2FailsClosedOnNamespaceMissionAuthorityRegression(t *testing.T) {
	now := time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)

	// Sibling review for the same PR with higher authoritative epoch 5
	sibling := v1alpha2Review(now)
	sibling.Name = "ct-review-sibling-000000000000000000"
	sibling.Spec.RunID = "run_sibling00000000000000000000000"
	sibling.Spec.RunSecretName = "ct-review-run-sibling00000000000000000000000"
	sibling.Spec.FencingEpoch = 5
	sibling.Status.AuthoritativeFencingEpoch = 5

	// New candidate review with regressed epoch 3
	candidate := v1alpha2Review(now)
	candidate.Name = "ct-review-candidate-0000000000000000"
	candidate.Spec.RunID = "run_candidate000000000000000000000"
	candidate.Spec.RunSecretName = "ct-review-run-candidate000000000000000000000"
	candidate.Spec.FencingEpoch = 3
	candidate.Status.AuthoritativeFencingEpoch = 0 // Unset

	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(sibling, candidate).WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: kube, Scheme: scheme, Now: func() time.Time { return now }}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: candidate.Namespace, Name: candidate.Name}}

	result, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("reconcile returned unexpected error: %v", err)
	}
	if result.RequeueAfter > 0 {
		t.Fatalf("expected immediate fail-closed, got %v", result.RequeueAfter)
	}

	var updated reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), req.NamespacedName, &updated); err != nil {
		t.Fatalf("get candidate: %v", err)
	}

	if updated.Status.Phase != reviewv1alpha2.PhaseFailed {
		t.Fatalf("candidate phase = %s, want Failed due to mission authority epoch mismatch", updated.Status.Phase)
	}
	cond := meta.FindStatusCondition(updated.Status.Conditions, reviewv1alpha2.ConditionFencingEpochMismatch)
	if cond == nil || cond.Status != metav1.ConditionTrue {
		t.Fatalf("expected ConditionFencingEpochMismatch=True, got %#v", cond)
	}
}

func TestPRReviewJobV1Alpha2InitializesAuthoritativeFencingEpoch(t *testing.T) {
	now := time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	review := v1alpha2Review(now)
	review.Spec.FencingEpoch = 2
	review.Status.AuthoritativeFencingEpoch = 0

	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(review).WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: kube, Scheme: scheme, Now: func() time.Time { return now }}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	// First reconcile creates PVC
	_, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("first reconcile: %v", err)
	}

	var updated reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), req.NamespacedName, &updated); err != nil {
		t.Fatalf("get updated review: %v", err)
	}
	if updated.Status.AuthoritativeFencingEpoch != 2 {
		t.Fatalf("status.AuthoritativeFencingEpoch = %d, want 2", updated.Status.AuthoritativeFencingEpoch)
	}
	if cond := meta.FindStatusCondition(updated.Status.Conditions, reviewv1alpha2.ConditionFencingEpochMismatch); cond != nil {
		t.Fatalf("unexpected ConditionFencingEpochMismatch: %#v", cond)
	}
}

func TestPRReviewJobV1Alpha2FailsClosedOnStaleWorkerLeaseToken(t *testing.T) {
	now := time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	review := v1alpha2Review(now)
	review.Spec.FencingEpoch = 1
	review.Status.AuthoritativeFencingEpoch = 1
	review.Spec.WorkerLeaseToken = "token-attempt-1"
	review.Status.ActiveWorkerLeaseToken = "token-attempt-2" // Mismatch: active token has moved on

	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(review).WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: kube, Scheme: scheme, Now: func() time.Time { return now }}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	result, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("reconcile error: %v", err)
	}
	if result.RequeueAfter > 0 {
		t.Fatalf("expected immediate fail-closed, got %v", result.RequeueAfter)
	}

	var updated reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), req.NamespacedName, &updated); err != nil {
		t.Fatalf("get updated: %v", err)
	}

	if updated.Status.Phase != reviewv1alpha2.PhaseFailed {
		t.Fatalf("status.phase = %s, want Failed", updated.Status.Phase)
	}
	cond := meta.FindStatusCondition(updated.Status.Conditions, reviewv1alpha2.ConditionStaleWorkerLease)
	if cond == nil || cond.Status != metav1.ConditionTrue {
		t.Fatalf("expected ConditionStaleWorkerLease=True, got %#v", cond)
	}
	if cond.Reason != "LeaseExpired" {
		t.Fatalf("condition reason = %s, want LeaseExpired", cond.Reason)
	}
}

func TestPRReviewJobV1Alpha2FailsClosedOnExpiredWorkspaceLease(t *testing.T) {
	now := time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	review := v1alpha2Review(now)
	review.Spec.WorkerLeaseToken = "token-1"

	// Create an expired Lease in ct-review-system
	leaseName := workspace.LeaseName(review.Spec.RepositoryID, review.Spec.PRNumber)
	pastTime := metav1.NewMicroTime(now.Add(-10 * time.Minute))
	duration := int32(120) // 2 minutes duration, expired 8 minutes ago
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

	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(review, lease).WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: kube, Scheme: scheme, Now: func() time.Time { return now }}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	result, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("reconcile error: %v", err)
	}
	if result.RequeueAfter > 0 {
		t.Fatalf("expected immediate fail-closed, got %v", result.RequeueAfter)
	}

	var updated reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), req.NamespacedName, &updated); err != nil {
		t.Fatalf("get review: %v", err)
	}
	if updated.Status.Phase != reviewv1alpha2.PhaseFailed {
		t.Fatalf("phase = %s, want Failed", updated.Status.Phase)
	}
	cond := meta.FindStatusCondition(updated.Status.Conditions, reviewv1alpha2.ConditionStaleWorkerLease)
	if cond == nil || cond.Status != metav1.ConditionTrue || cond.Reason != "LeaseExpired" {
		t.Fatalf("expected ConditionStaleWorkerLease True LeaseExpired, got %#v", cond)
	}
}

func TestPRReviewJobV1Alpha2FailsClosedDuringRunningJobWithoutPodMutation(t *testing.T) {
	now := time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	review := v1alpha2Review(now)
	review.Spec.FencingEpoch = 2
	review.Status.Phase = reviewv1alpha2.PhaseRunning
	review.Status.AuthoritativeFencingEpoch = 4 // Regressed: status epoch was bumped

	// Existing running worker Job
	worker := &batchv1.Job{
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
				Spec: corev1.PodSpec{
					Containers: []corev1.Container{{Name: "reviewer-worker", Image: review.Spec.WorkerImage}},
				},
			},
		},
		Status: batchv1.JobStatus{
			Active: 1, // Currently running
		},
	}

	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(review, worker).WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: kube, Scheme: scheme, Now: func() time.Time { return now }}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	result, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("reconcile error: %v", err)
	}
	if result.RequeueAfter > 0 {
		t.Fatalf("expected immediate fail-closed, got %v", result.RequeueAfter)
	}

	var updated reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), req.NamespacedName, &updated); err != nil {
		t.Fatalf("get review: %v", err)
	}
	if updated.Status.Phase != reviewv1alpha2.PhaseFailed {
		t.Fatalf("phase = %s, want Failed", updated.Status.Phase)
	}
	cond := meta.FindStatusCondition(updated.Status.Conditions, reviewv1alpha2.ConditionFencingEpochMismatch)
	if cond == nil || cond.Status != metav1.ConditionTrue {
		t.Fatalf("expected ConditionFencingEpochMismatch=True, got %#v", cond)
	}

	// CRITICAL: Worker Job must NOT be deleted or mutated
	var survivingWorker batchv1.Job
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: worker.Namespace, Name: worker.Name}, &survivingWorker); err != nil {
		t.Fatalf("worker Job was mutated or deleted: %v", err)
	}
}

func TestPRReviewJobV1Alpha2DoesNotPromoteToSucceededOnEpochMismatch(t *testing.T) {
	now := time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	review := v1alpha2Review(now)
	review.Spec.FencingEpoch = 1
	review.Status.Phase = reviewv1alpha2.PhaseRunning
	review.Status.AuthoritativeFencingEpoch = 2 // Epoch regressed

	worker := &batchv1.Job{
		ObjectMeta: metav1.ObjectMeta{
			Name:      review.Name + "-worker",
			Namespace: review.Namespace,
			Labels: map[string]string{
				"review-yeti.ai/run-id":           review.Spec.RunID,
				"review-yeti.ai/publication-mode": review.Spec.PublicationMode,
			},
		},
		Status: batchv1.JobStatus{
			Succeeded: 1, // Worker claims success
		},
	}

	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(review, worker).WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: kube, Scheme: scheme, Now: func() time.Time { return now }}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	_, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("reconcile error: %v", err)
	}

	var updated reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), req.NamespacedName, &updated); err != nil {
		t.Fatalf("get review: %v", err)
	}
	if updated.Status.Phase == reviewv1alpha2.PhaseSucceeded {
		t.Fatalf("CRITICAL SAFETY VIOLATION: review was promoted to Succeeded despite epoch mismatch!")
	}
	if updated.Status.Phase != reviewv1alpha2.PhaseFailed {
		t.Fatalf("phase = %s, want Failed", updated.Status.Phase)
	}
	cond := meta.FindStatusCondition(updated.Status.Conditions, reviewv1alpha2.ConditionFencingEpochMismatch)
	if cond == nil || cond.Status != metav1.ConditionTrue {
		t.Fatalf("expected ConditionFencingEpochMismatch=True, got %#v", cond)
	}
}

func TestPRReviewJobV1Alpha2Reconciler_AdmissionSerializationPreventsOverAdmissionUnderConcurrency(t *testing.T) {
	now := time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)

	rev1 := v1alpha2Review(now)
	rev1.Name = "ct-review-concurrent-1"
	rev1.Spec.RunID = "run_11111111111111111111111111111111"
	rev1.Spec.PRNumber = 101

	rev2 := v1alpha2Review(now.Add(1 * time.Second))
	rev2.Name = "ct-review-concurrent-2"
	rev2.Spec.RunID = "run_22222222222222222222222222222222"
	rev2.Spec.PRNumber = 102

	kube := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(rev1, rev2).
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}, &batchv1.Job{}).
		Build()

	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client:                  kube,
		Scheme:                  scheme,
		Now:                     func() time.Time { return now },
		MaxConcurrentJobs:       1,
		MaxConcurrentReconciles: 4,
	}

	var wg sync.WaitGroup
	wg.Add(2)

	go func() {
		defer wg.Done()
		_, _ = reconciler.Reconcile(context.Background(), ctrl.Request{
			NamespacedName: types.NamespacedName{Namespace: rev1.Namespace, Name: rev1.Name},
		})
	}()

	go func() {
		defer wg.Done()
		_, _ = reconciler.Reconcile(context.Background(), ctrl.Request{
			NamespacedName: types.NamespacedName{Namespace: rev2.Namespace, Name: rev2.Name},
		})
	}()

	wg.Wait()

	var updated1, updated2 reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: rev1.Namespace, Name: rev1.Name}, &updated1); err != nil {
		t.Fatalf("get rev1: %v", err)
	}
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: rev2.Namespace, Name: rev2.Name}, &updated2); err != nil {
		t.Fatalf("get rev2: %v", err)
	}

	runningCount := 0
	queuedCount := 0
	for _, rev := range []*reviewv1alpha2.PRReviewJob{&updated1, &updated2} {
		if rev.Status.Phase == reviewv1alpha2.PhaseRunning {
			runningCount++
		} else if rev.Status.Phase == reviewv1alpha2.PhaseQueued {
			queuedCount++
		}
	}

	if runningCount != 1 || queuedCount != 1 {
		t.Fatalf("expected exactly 1 Running and 1 Queued review under MaxConcurrentJobs=1, got Running=%d, Queued=%d", runningCount, queuedCount)
	}
}
func testTimePtr(t metav1.Time) *metav1.Time {
	return &t
}

func testBoolPtr(b bool) *bool {
	return &b
}

func testLeaseResult(review *reviewv1alpha2.PRReviewJob, now time.Time, duration time.Duration) workspace.LeaseAcquireResult {
	labels, annotations := workspace.Metadata(review.Spec.RepositoryID, review.Spec.PRNumber)
	holder := review.Spec.RunID
	seconds := int32(duration / time.Second)
	renewed := metav1.NewMicroTime(now)
	return workspace.LeaseAcquireResult{
		Acquired:       true,
		HolderIdentity: review.Spec.RunID,
		Lease: &coordinationv1.Lease{
			ObjectMeta: metav1.ObjectMeta{
				Name:        workspace.LeaseName(review.Spec.RepositoryID, review.Spec.PRNumber),
				Namespace:   review.Namespace,
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

// TestPRReviewJobV1Alpha2_AlreadyExistsWorkerJobReconcilesAuthoritativeOutcome proves that
// when an existing worker Job is encountered on the admission path (r.Create returns AlreadyExists),
// the operator recovers through the canonical reconcileExistingJob path, querying the receipt
// asynchronously and promoting the review to PhaseSucceeded with a valid ReceiptDigest.
func TestPRReviewJobV1Alpha2_AlreadyExistsWorkerJobReconcilesAuthoritativeOutcome(t *testing.T) {
	now := time.Date(2026, 9, 30, 12, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	review := v1alpha2Review(now)
	review.Name = "ct-review-ad0b1111111111111111111111111111"
	review.Spec.RunID = "run_ad0b1111111111111111111111111111"
	review.Spec.RunSecretName = "ct-review-run-ad0b1111111111111111111111111111"
	review.Spec.PublicationMode = job.PublicationModeAppGate
	review.Spec.RunnerMode = "generic"
	review.Status.Phase = reviewv1alpha2.PhaseQueued

	var httpCallCount int32
	var httpMu sync.Mutex

	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		httpMu.Lock()
		httpCallCount++
		httpMu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(validAppGateRunStatus(t, review))
	}))
	defer server.Close()

	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: review.Spec.RunSecretName, Namespace: review.Namespace},
		Data:       map[string][]byte{"GITHUB_PUBLISH_TOKEN": []byte(testPublishToken)},
	}

	publishingConfig := job.PublishingConfig{
		GatewayBaseURL:    "https://gateway.example.invalid/v1",
		Model:             "ollama/glm-5.3-flash",
		GatewaySecretName: "review-yeti-gateway-credentials",
		GatewaySecretKey:  "REVIEW_YETI_BIFROST_API_KEY",
		CompletionURL:     server.URL + "/api/dispatch/completion",
	}

	worker, buildErr := job.BuildWorkerJob(job.Input{
		Review:           review,
		WorkspacePVCName: workspace.PVCName(review.Spec.RepositoryID, review.Spec.PRNumber),
		WorkspaceLease:   testLeaseResult(review, now, 15*time.Minute),
		Now:              now,
		Publishing:       publishingConfig,
	})
	if buildErr != nil {
		t.Fatalf("build worker job: %v", buildErr)
	}
	// Mark worker as already Succeeded to verify that admission NEVER executes inline receipt lookups
	worker.Status.Succeeded = 1
	worker.Status.Conditions = []batchv1.JobCondition{{Type: batchv1.JobComplete, Status: corev1.ConditionTrue}}

	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(review, secret, worker).
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}, &batchv1.Job{}).Build()

	var getWorkerCount int32
	interceptedClient := interceptor.NewClient(kube, interceptor.Funcs{
		Get: func(ctx context.Context, c client.WithWatch, key client.ObjectKey, obj client.Object, opts ...client.GetOption) error {
			if _, isJob := obj.(*batchv1.Job); isJob && key.Name == worker.Name {
				if atomic.AddInt32(&getWorkerCount, 1) == 1 {
					// Simulate cache lag: informer hasn't observed the Job yet when reconcile begins
					return apierrors.NewNotFound(schema.GroupResource{Group: "batch", Resource: "jobs"}, key.Name)
				}
			}
			return c.Get(ctx, key, obj, opts...)
		},
	})

	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client:            interceptedClient,
		SecretReader:      kube,
		Scheme:            scheme,
		Now:               func() time.Time { return now },
		ReceiptHTTPClient: server.Client(),
		Publishing:        publishingConfig,
	}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	// Reset HTTP call count before admission reconcile
	httpMu.Lock()
	httpCallCount = 0
	httpMu.Unlock()

	// Step 3: Run admission reconcile. Because the Job already exists, Create returns AlreadyExists,
	// and reconcileExistingJob seamlessly reconciles the existing succeeded worker, promoting to PhaseSucceeded.
	admitRes, admitErr := reconciler.Reconcile(context.Background(), req)
	if admitErr != nil {
		t.Fatalf("admission reconcile failed: %v", admitErr)
	}
	_ = admitRes

	httpMu.Lock()
	calls := httpCallCount
	httpMu.Unlock()
	if calls != 1 {
		t.Fatalf("expected 1 receipt HTTP query during reconciliation of existing worker, got %d", calls)
	}

	var afterAdmit reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), req.NamespacedName, &afterAdmit); err != nil {
		t.Fatalf("get after admit: %v", err)
	}
	if afterAdmit.Status.Phase != reviewv1alpha2.PhaseSucceeded {
		t.Fatalf("expected PhaseSucceeded after reconciling already existing worker, got %s", afterAdmit.Status.Phase)
	}
	if afterAdmit.Status.ReceiptDigest == "" {
		t.Fatal("expected non-empty ReceiptDigest after reconciling already existing worker")
	}
}

// TestPRReviewJobV1Alpha2_StalledReceiptEndpointDoesNotBlockUnrelatedReconciles proves that
// a slow or stalled external receipt endpoint on Review A does not block concurrent reconciliations
// for unrelated reviews (Review B admission and Review C cancellation) from completing cleanly in < 100ms.
func TestPRReviewJobV1Alpha2_StalledReceiptEndpointDoesNotBlockUnrelatedReconciles(t *testing.T) {
	now := time.Date(2026, 9, 30, 12, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)

	// Review A: AppGate review with completed worker
	revA := v1alpha2Review(now)
	revA.Name = "ct-review-aaaa1111111111111111111111111111"
	revA.Spec.RunID = "run_aaaa1111111111111111111111111111"
	revA.Spec.RunSecretName = "ct-review-run-aaaa1111111111111111111111111111"
	revA.Spec.PRNumber = 101
	revA.Spec.PublicationMode = job.PublicationModeAppGate
	revA.Spec.RunnerMode = "ephemeral"
	revA.Status.Phase = reviewv1alpha2.PhaseRunning
	revA.Status.JobName = revA.Name + "-worker"
	revA.Status.StartTime = testTimePtr(metav1.NewTime(now))

	// Review B: Queued review waiting for worker admission
	revB := v1alpha2Review(now)
	revB.Name = "ct-review-bbbb2222222222222222222222222222"
	revB.Spec.RunID = "run_bbbb2222222222222222222222222222"
	revB.Spec.RunSecretName = "ct-review-run-bbbb2222222222222222222222222222"
	revB.Spec.PRNumber = 102
	revB.Spec.PublicationMode = "disabled"
	revB.Spec.RunnerMode = "ephemeral"
	revB.Status.Phase = reviewv1alpha2.PhaseQueued

	// Review C: Running review requesting cancellation
	revC := v1alpha2Review(now)
	revC.Name = "ct-review-cccc3333333333333333333333333333"
	revC.Spec.RunID = "run_cccc3333333333333333333333333333"
	revC.Spec.RunSecretName = "ct-review-run-cccc3333333333333333333333333333"
	revC.Spec.PRNumber = 103
	revC.Spec.PublicationMode = "disabled"
	revC.Spec.RunnerMode = "ephemeral"
	revC.Spec.CancelRequested = testBoolPtr(true)
	revC.Status.Phase = reviewv1alpha2.PhaseRunning
	revC.Status.JobName = revC.Name + "-worker"
	revC.Status.StartTime = testTimePtr(metav1.NewTime(now))

	secretA := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: revA.Spec.RunSecretName, Namespace: revA.Namespace},
		Data:       map[string][]byte{"GITHUB_PUBLISH_TOKEN": []byte(testPublishToken)},
	}
	secretB := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: revB.Spec.RunSecretName, Namespace: revB.Namespace},
		Data:       map[string][]byte{"GITHUB_PUBLISH_TOKEN": []byte(testPublishToken)},
	}
	secretC := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: revC.Spec.RunSecretName, Namespace: revC.Namespace},
		Data:       map[string][]byte{"GITHUB_PUBLISH_TOKEN": []byte(testPublishToken)},
	}

	stallReleaseCh := make(chan struct{})
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, revA.Spec.RunID) {
			select {
			case <-stallReleaseCh:
			case <-time.After(4 * time.Second):
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(validAppGateRunStatus(t, revA))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(validAppGateRunStatus(t, revA))
	}))
	defer server.Close()
	defer func() {
		select {
		case <-stallReleaseCh:
		default:
			close(stallReleaseCh)
		}
	}()

	publishingConfig := job.PublishingConfig{
		GatewayBaseURL:    "https://gateway.example.invalid/v1",
		Model:             "ollama/glm-5.3-flash",
		GatewaySecretName: "review-yeti-gateway-credentials",
		GatewaySecretKey:  "REVIEW_YETI_BIFROST_API_KEY",
		CompletionURL:     server.URL + "/api/dispatch/completion",
	}

	leaseA := testLeaseResult(revA, now, 15*time.Minute).Lease
	leaseC := testLeaseResult(revC, now, 15*time.Minute).Lease

	workerA, err := job.BuildWorkerJob(job.Input{
		Review:         revA,
		WorkspaceLease: testLeaseResult(revA, now, 15*time.Minute),
		Now:            now,
		Publishing:     publishingConfig,
	})
	if err != nil {
		t.Fatalf("build worker A: %v", err)
	}
	workerA.Status.Succeeded = 1
	workerA.Status.Conditions = []batchv1.JobCondition{{Type: batchv1.JobComplete, Status: corev1.ConditionTrue}}

	workerC, err := job.BuildWorkerJob(job.Input{
		Review:         revC,
		WorkspaceLease: testLeaseResult(revC, now, 15*time.Minute),
		Now:            now,
		Publishing:     publishingConfig,
	})
	if err != nil {
		t.Fatalf("build worker C: %v", err)
	}

	kube := fake.NewClientBuilder().WithScheme(scheme).
		WithObjects(revA, revB, revC, secretA, secretB, secretC, workerA, workerC, leaseA, leaseC).
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}, &batchv1.Job{}).Build()

	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client:                  kube,
		SecretReader:            kube,
		Scheme:                  scheme,
		Now:                     func() time.Time { return now },
		ReceiptHTTPClient:       server.Client(),
		Publishing:              publishingConfig,
		MaxConcurrentJobs:       10,
		MaxConcurrentReconciles: 1, // Strict single-thread test: Any blocking in Review A would block B and C!
	}
	coordinator := reconciler.ReceiptCoordinator
	if coordinator == nil {
		coordinator = controllers.NewAppGateReceiptCoordinator(reconciler)
		reconciler.ReceiptCoordinator = coordinator
	}
	coordinator.WaitTimeout = 10 * time.Millisecond

	reqA := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: revA.Namespace, Name: revA.Name}}
	reqB := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: revB.Namespace, Name: revB.Name}}
	reqC := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: revC.Namespace, Name: revC.Name}}

	start := time.Now()

	// Reconcile Review A: Its external receipt endpoint hangs for 4 seconds.
	// Non-blocking coordinator must release in < 25ms.
	resA, errA := reconciler.Reconcile(context.Background(), reqA)
	if errA != nil {
		t.Fatalf("reconcile A should not error on pending lookup: %v", errA)
	}
	if resA.RequeueAfter != 500*time.Millisecond {
		t.Fatalf("reconcile A expected RequeueAfter: 500ms, got %+v", resA)
	}

	// Reconcile Review B: Admitting worker while Review A's receipt fetch is stalled in background.
	if _, errB := reconciler.Reconcile(context.Background(), reqB); errB != nil {
		t.Fatalf("reconcile B admission failed: %v", errB)
	}

	// Reconcile Review C: Cancelling while Review A's receipt fetch is stalled in background.
	if _, errC := reconciler.Reconcile(context.Background(), reqC); errC != nil {
		t.Fatalf("reconcile C cancellation failed: %v", errC)
	}

	elapsed := time.Since(start)
	if elapsed >= 2*time.Second {
		t.Fatalf("total elapsed time for all 3 reconciles was %v, want < 2s (server hang is 4s)", elapsed)
	}

	var afterB reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), reqB.NamespacedName, &afterB); err != nil {
		t.Fatalf("get after B: %v", err)
	}
	if afterB.Status.Phase != reviewv1alpha2.PhaseRunning {
		t.Fatalf("expected Review B in PhaseRunning, got %s", afterB.Status.Phase)
	}

	var afterC reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), reqC.NamespacedName, &afterC); err != nil {
		t.Fatalf("get after C: %v", err)
	}
	if afterC.Status.Phase != reviewv1alpha2.PhaseCancelled {
		t.Fatalf("expected Review C in PhaseCancelled, got %s", afterC.Status.Phase)
	}

	// Release stall and verify Review A finishes when background fetch caches receipt
	close(stallReleaseCh)

	pollDeadline := time.Now().Add(2 * time.Second)
	var afterA reviewv1alpha2.PRReviewJob
	for time.Now().Before(pollDeadline) {
		_, _ = reconciler.Reconcile(context.Background(), reqA)
		if err := kube.Get(context.Background(), reqA.NamespacedName, &afterA); err == nil {
			if afterA.Status.Phase == reviewv1alpha2.PhaseSucceeded {
				break
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	if afterA.Status.Phase != reviewv1alpha2.PhaseSucceeded {
		t.Fatalf("expected Review A in PhaseSucceeded after receipt cached, got %s", afterA.Status.Phase)
	}
	if afterA.Status.ReceiptDigest == "" {
		t.Fatal("expected non-empty ReceiptDigest on Review A")
	}
}

// TestPRReviewJobV1Alpha2_ReceiptEndpoint500And503FailSoftWithoutBlocking proves that
// 500/503 temporary errors from external receipt endpoints requeue with backoff without
// failing or blocking unrelated healthy reviews.
func TestPRReviewJobV1Alpha2_ReceiptEndpoint500And503FailSoftWithoutBlocking(t *testing.T) {
	now := time.Date(2026, 9, 30, 12, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)

	revA := v1alpha2Review(now)
	revA.Name = "ct-review-500a1111111111111111111111111111"
	revA.Spec.RunID = "run_500a1111111111111111111111111111"
	revA.Spec.RunSecretName = "ct-review-run-500a1111111111111111111111111111"
	revA.Spec.PRNumber = 201
	revA.Spec.PublicationMode = job.PublicationModeAppGate
	revA.Spec.RunnerMode = "ephemeral"
	revA.Status.Phase = reviewv1alpha2.PhaseRunning
	revA.Status.JobName = revA.Name + "-worker"
	revA.Status.StartTime = testTimePtr(metav1.NewTime(now))

	revB := v1alpha2Review(now)
	revB.Name = "ct-review-200b2222222222222222222222222222"
	revB.Spec.RunID = "run_200b2222222222222222222222222222"
	revB.Spec.RunSecretName = "ct-review-run-200b2222222222222222222222222222"
	revB.Spec.PRNumber = 202
	revB.Spec.PublicationMode = job.PublicationModeAppGate
	revB.Spec.RunnerMode = "ephemeral"
	revB.Status.Phase = reviewv1alpha2.PhaseRunning
	revB.Status.JobName = revB.Name + "-worker"
	revB.Status.StartTime = testTimePtr(metav1.NewTime(now))

	secretA := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: revA.Spec.RunSecretName, Namespace: revA.Namespace},
		Data:       map[string][]byte{"GITHUB_PUBLISH_TOKEN": []byte(testPublishToken)},
	}
	secretB := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: revB.Spec.RunSecretName, Namespace: revB.Namespace},
		Data:       map[string][]byte{"GITHUB_PUBLISH_TOKEN": []byte(testPublishToken)},
	}

	var failRevAMu sync.Mutex
	failRevA := true

	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		failRevAMu.Lock()
		shouldFailA := failRevA
		failRevAMu.Unlock()

		if strings.Contains(r.URL.Path, revA.Spec.RunID) {
			if shouldFailA {
				w.WriteHeader(http.StatusServiceUnavailable) // 503
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(validAppGateRunStatus(t, revA))
			return
		}
		if strings.Contains(r.URL.Path, revB.Spec.RunID) {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(validAppGateRunStatus(t, revB))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()

	publishingConfig := job.PublishingConfig{
		GatewayBaseURL:    "https://gateway.example.invalid/v1",
		Model:             "ollama/glm-5.3-flash",
		GatewaySecretName: "review-yeti-gateway-credentials",
		GatewaySecretKey:  "REVIEW_YETI_BIFROST_API_KEY",
		CompletionURL:     server.URL + "/api/dispatch/completion",
	}

	leaseA := testLeaseResult(revA, now, 15*time.Minute).Lease
	leaseB := testLeaseResult(revB, now, 15*time.Minute).Lease

	workerA, err := job.BuildWorkerJob(job.Input{
		Review:         revA,
		WorkspaceLease: testLeaseResult(revA, now, 15*time.Minute),
		Now:            now,
		Publishing:     publishingConfig,
	})
	if err != nil {
		t.Fatalf("build worker A: %v", err)
	}
	workerA.Status.Succeeded = 1
	workerA.Status.Conditions = []batchv1.JobCondition{{Type: batchv1.JobComplete, Status: corev1.ConditionTrue}}

	workerB, err := job.BuildWorkerJob(job.Input{
		Review:         revB,
		WorkspaceLease: testLeaseResult(revB, now, 15*time.Minute),
		Now:            now,
		Publishing:     publishingConfig,
	})
	if err != nil {
		t.Fatalf("build worker B: %v", err)
	}
	workerB.Status.Succeeded = 1
	workerB.Status.Conditions = []batchv1.JobCondition{{Type: batchv1.JobComplete, Status: corev1.ConditionTrue}}

	kube := fake.NewClientBuilder().WithScheme(scheme).
		WithObjects(revA, revB, secretA, secretB, workerA, workerB, leaseA, leaseB).
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}, &batchv1.Job{}).Build()

	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client:                  kube,
		SecretReader:            kube,
		Scheme:                  scheme,
		Now:                     func() time.Time { return now },
		ReceiptHTTPClient:       server.Client(),
		Publishing:              publishingConfig,
		MaxConcurrentReconciles: 1,
	}

	reqA := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: revA.Namespace, Name: revA.Name}}
	reqB := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: revB.Namespace, Name: revB.Name}}

	// Step 1: Reconcile Review A (returns 503). Must fail soft with RequeueAfter: 500ms without failing the review.
	resA, _ := reconciler.Reconcile(context.Background(), reqA)
	if resA.RequeueAfter != 500*time.Millisecond {
		t.Fatalf("expected RequeueAfter: 500ms for temporary 503 outage, got %+v", resA)
	}

	var afterA reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), reqA.NamespacedName, &afterA); err != nil {
		t.Fatalf("get after A: %v", err)
	}
	if afterA.Status.Phase == reviewv1alpha2.PhaseFailed {
		t.Fatalf("review A must not fail on temporary 503 error: %+v", afterA.Status)
	}

	// Step 2: Reconcile healthy Review B. Must succeed immediately without being blocked.
	startB := time.Now()
	resB, errB := reconciler.Reconcile(context.Background(), reqB)
	elapsedB := time.Since(startB)
	if errB != nil {
		t.Fatalf("reconcile B failed: %v", errB)
	}
	_ = resB
	if elapsedB >= 500*time.Millisecond {
		t.Fatalf("reconcile B took %v, want < 500ms", elapsedB)
	}

	var afterB reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), reqB.NamespacedName, &afterB); err != nil {
		t.Fatalf("get after B: %v", err)
	}
	if afterB.Status.Phase != reviewv1alpha2.PhaseSucceeded {
		t.Fatalf("expected Review B in PhaseSucceeded, got %s", afterB.Status.Phase)
	}
	if afterB.Status.ReceiptDigest == "" {
		t.Fatal("expected non-empty ReceiptDigest on Review B")
	}

	// Step 3: Recover Review A endpoint (returns 200). Subsequent reconcile promotes to PhaseSucceeded.
	failRevAMu.Lock()
	failRevA = false
	failRevAMu.Unlock()

	if _, errA2 := reconciler.Reconcile(context.Background(), reqA); errA2 != nil {
		t.Fatalf("reconcile A after recovery failed: %v", errA2)
	}

	if err := kube.Get(context.Background(), reqA.NamespacedName, &afterA); err != nil {
		t.Fatalf("get after A recovery: %v", err)
	}
	if afterA.Status.Phase != reviewv1alpha2.PhaseSucceeded {
		t.Fatalf("expected Review A in PhaseSucceeded after recovery, got %s", afterA.Status.Phase)
	}
	if afterA.Status.ReceiptDigest == "" {
		t.Fatal("expected non-empty ReceiptDigest on Review A after recovery")
	}
}
