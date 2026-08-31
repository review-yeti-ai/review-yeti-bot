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

	reviewv1alpha2 "github.com/calltelemetry/ct-review-bot/k8s-operator/api/v1alpha2"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/controllers"
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
	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("terminal reconcile: %v", err)
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
