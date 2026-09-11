package controllers_test

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	coordinationv1 "k8s.io/api/coordination/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"

	reviewv1alpha2 "github.com/calltelemetry/ct-review-bot/k8s-operator/api/v1alpha2"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/controllers"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/job"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/workspace"
)

// Reuse the production reconciler and Job builder; intercept only Kubernetes
// persistence boundaries to make response loss and immediate GC deterministic.
func missingJobFixture(t *testing.T, mode string, hooks interceptor.Funcs) (*controllers.PRReviewJobV1Alpha2Reconciler, client.Client, ctrl.Request) {
	t.Helper()
	t.Setenv("REVIEW_YETI_WORKER_TTL_AFTER_FINISHED", "0")
	now := time.Date(2026, 9, 9, 19, 0, 0, 0, time.UTC)
	review := v1alpha2Review(now)
	review.UID = types.UID("missing-job-test")
	review.Spec.PublicationMode = mode
	review.Spec.RunnerMode = "generic"
	attempt := int32(2)
	review.Spec.ExecutionAttempt = &attempt
	review.Name += "-a2"
	review.Spec.RunSecretName += "-a2"
	scheme := v1alpha2Scheme(t)
	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(review).
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}, &batchv1.Job{}).
		WithInterceptorFuncs(hooks).Build()
	r := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client: kube, Scheme: scheme, Now: func() time.Time { return now },
		Publishing: job.PublishingConfig{
			GatewayBaseURL: "https://gateway.example.invalid/v1", Model: "ollama/glm-5.3-flash",
			GatewaySecretName: "review-yeti-gateway-credentials", GatewaySecretKey: "REVIEW_YETI_BIFROST_API_KEY",
			CompletionURL: "https://dispatch.example.invalid/api/dispatch/completion",
		},
	}
	req := ctrl.Request{NamespacedName: client.ObjectKeyFromObject(review)}
	if _, err := r.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("provision never-started workspace: %v", err)
	}
	return r, kube, req
}

func storedReview(t *testing.T, kube client.Client, req ctrl.Request) *reviewv1alpha2.PRReviewJob {
	t.Helper()
	review := &reviewv1alpha2.PRReviewJob{}
	if err := kube.Get(context.Background(), req.NamespacedName, review); err != nil {
		t.Fatal(err)
	}
	return review
}

func storedWorker(t *testing.T, kube client.Client, req ctrl.Request) *batchv1.Job {
	t.Helper()
	worker := &batchv1.Job{}
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: req.Namespace, Name: req.Name + "-worker"}, worker); err != nil {
		t.Fatal(err)
	}
	return worker
}

func assignFakeWorkerUID(t *testing.T, kube client.Client, worker *batchv1.Job) {
	t.Helper()
	if worker.UID != "" {
		return
	}
	worker.UID = types.UID("uid-" + worker.Name)
	if err := kube.Update(context.Background(), worker); err != nil {
		t.Fatalf("assign fake worker UID: %v", err)
	}
}

func bindTestPodToWorker(pod *corev1.Pod, worker *batchv1.Job) {
	controller := true
	pod.OwnerReferences = []metav1.OwnerReference{{
		APIVersion: batchv1.SchemeGroupVersion.String(), Kind: "Job", Name: worker.Name,
		UID: worker.UID, Controller: &controller,
	}}
}

func assertFailurePublisherAbsent(t *testing.T, kube client.Client, req ctrl.Request) {
	t.Helper()
	err := kube.Get(context.Background(), types.NamespacedName{
		Namespace: req.Namespace,
		Name:      req.Name + "-fail",
	}, &batchv1.Job{})
	if !apierrors.IsNotFound(err) {
		t.Fatalf("operator created a direct failure publisher using the expiring run credential: %v", err)
	}
}

func assertWorkerAbsent(t *testing.T, kube client.Client, req ctrl.Request) {
	t.Helper()
	err := kube.Get(context.Background(), types.NamespacedName{Namespace: req.Namespace, Name: req.Name + "-worker"}, &batchv1.Job{})
	if !apierrors.IsNotFound(err) {
		t.Fatalf("same admitted execution was (re)created: get Job error=%v", err)
	}
}

// deleteLegacyWorker models a Job created before the terminal-outcome
// finalizer existed (or an external administrator forcibly removing that
// guard). Tests that exercise the current lifecycle must use ordinary Delete
// and assert that the finalizer retains the Job until its outcome is durable.
func deleteLegacyWorker(t *testing.T, kube client.Client, req ctrl.Request) {
	t.Helper()
	ctx := context.Background()
	worker := storedWorker(t, kube, req)
	worker.Finalizers = nil
	if err := kube.Update(ctx, worker); err != nil {
		t.Fatalf("remove legacy worker finalizers: %v", err)
	}
	if err := kube.Delete(ctx, worker); err != nil && !apierrors.IsNotFound(err) {
		t.Fatalf("delete legacy worker: %v", err)
	}
}

func TestTerminalWorkerFinalizerPreservesSuccessfulOutcomeAcrossTTLDeletion(t *testing.T) {
	ctx := context.Background()
	r, kube, req := missingJobFixture(t, "app-gate", interceptor.Funcs{})
	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	worker := storedWorker(t, kube, req)
	if !containsString(worker.Finalizers, "review-yeti.ai/terminal-outcome") {
		t.Fatalf("worker finalizers = %v, want terminal-outcome protection", worker.Finalizers)
	}

	completed := r.Now().Add(time.Minute)
	r.Now = func() time.Time { return completed }
	worker.Status.Succeeded = 1
	worker.Status.Conditions = []batchv1.JobCondition{{
		Type: batchv1.JobComplete, Status: corev1.ConditionTrue,
		LastTransitionTime: metav1.NewTime(completed),
	}}
	if err := kube.Status().Update(ctx, worker); err != nil {
		t.Fatal(err)
	}
	if err := kube.Delete(ctx, worker); err != nil {
		t.Fatal(err)
	}
	deleting := storedWorker(t, kube, req)
	if deleting.DeletionTimestamp == nil {
		t.Fatal("TTL deletion must leave the finalizer-protected terminal Job observable")
	}

	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	completedReview := storedReview(t, kube, req)
	if completedReview.Status.Phase != reviewv1alpha2.PhaseSucceeded || completedReview.Status.CompletionTime == nil {
		t.Fatalf("terminal status = %#v, want durable successful outcome", completedReview.Status)
	}
	if completedReview.Status.Timing == nil || completedReview.Status.Timing.CompletedAt == nil {
		t.Fatalf("timing = %#v, want durable completion receipt", completedReview.Status.Timing)
	}
	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	assertWorkerAbsent(t, kube, req)
}

// Regression for the deployed 1.55.2 a2 sequence observed on 2026-09-11:
// the exact App check run_45df...:a2 had already completed SHIP when immediate
// TTL collection hid the successful Job and the parent was incorrectly failed.
// The finalizer must keep that Kubernetes success observable until the parent
// terminal receipt is durable; recovery must not manufacture a failure path.
func TestLiveRefreshA2ShipIsDurableBeforeTTLDeletesWorker(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 9, 11, 19, 34, 0, 0, time.UTC)
	review := v1alpha2Review(now)
	review.Name = "ct-review-45df3bc195cee92c4612505adc8f6603-a2"
	review.UID = types.UID("live-refresh-a2")
	review.Spec.RunID = "run_45df3bc195cee92c4612505adc8f6603"
	review.Spec.HeadSHA = "51d32639eac249f437b66ac863138ce2069f472c"
	review.Spec.RunSecretName = "ct-review-run-45df3bc195cee92c4612505adc8f6603-a2"
	attempt := int32(2)
	review.Spec.ExecutionAttempt = &attempt
	review.Spec.PublicationMode = job.PublicationModeAppGate
	review.Spec.RunnerMode = "generic"
	scheme := v1alpha2Scheme(t)
	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(review).
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}, &batchv1.Job{}).Build()
	r := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client: kube, Scheme: scheme, Now: func() time.Time { return now },
		Publishing: job.PublishingConfig{
			GatewayBaseURL: "https://gateway.example.invalid/v1", Model: "ollama/glm-5.3-flash",
			GatewaySecretName: "review-yeti-gateway-credentials", GatewaySecretKey: "REVIEW_YETI_BIFROST_API_KEY",
			CompletionURL: "https://dispatch.example.invalid/api/dispatch/completion",
		},
	}
	req := ctrl.Request{NamespacedName: client.ObjectKeyFromObject(review)}
	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	worker := storedWorker(t, kube, req)
	completed := time.Date(2026, 9, 11, 19, 35, 10, 0, time.UTC)
	worker.Status.Succeeded = 1
	worker.Status.CompletionTime = &metav1.Time{Time: completed}
	worker.Status.Conditions = []batchv1.JobCondition{{
		Type: batchv1.JobComplete, Status: corev1.ConditionTrue, LastTransitionTime: metav1.NewTime(completed),
	}}
	if err := kube.Status().Update(ctx, worker); err != nil {
		t.Fatal(err)
	}
	if err := kube.Delete(ctx, worker); err != nil {
		t.Fatal(err)
	}

	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	stored := storedReview(t, kube, req)
	ready := meta.FindStatusCondition(stored.Status.Conditions, "Ready")
	if stored.Status.Phase != reviewv1alpha2.PhaseSucceeded || stored.Status.CompletionTime == nil ||
		!stored.Status.CompletionTime.Time.Equal(completed) || ready == nil || ready.Reason != "WorkerSucceeded" {
		t.Fatalf("live a2 terminal receipt = %#v, want exact successful completion", stored.Status)
	}
	if publication := meta.FindStatusCondition(stored.Status.Conditions, "FailurePublication"); publication != nil {
		t.Fatalf("live App SHIP entered failure publication: %#v", publication)
	}
	if !containsString(storedWorker(t, kube, req).Finalizers, "review-yeti.ai/terminal-outcome") {
		t.Fatal("worker evidence was released in the same write as the parent terminal receipt")
	}
	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	assertWorkerAbsent(t, kube, req)
}

func TestSuccessfulWorkerObservedAfterFailurePendingPreservesAppShip(t *testing.T) {
	ctx := context.Background()
	r, kube, req := missingJobFixture(t, "app-gate", interceptor.Funcs{})
	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	review := storedReview(t, kube, req)
	r.Now = func() time.Time { return review.Spec.TerminalDeadline.Add(time.Second) }
	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	if !failurePublicationIsPending(storedReview(t, kube, req)) {
		t.Fatal("deadline race did not persist the expected pending failure state")
	}

	worker := storedWorker(t, kube, req)
	completed := review.Spec.TerminalDeadline.Add(-time.Second)
	worker.Status.Succeeded = 1
	worker.Status.CompletionTime = &metav1.Time{Time: completed}
	worker.Status.Conditions = []batchv1.JobCondition{{
		Type: batchv1.JobComplete, Status: corev1.ConditionTrue, LastTransitionTime: metav1.NewTime(completed),
	}}
	if err := kube.Status().Update(ctx, worker); err != nil {
		t.Fatal(err)
	}

	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	stored := storedReview(t, kube, req)
	if stored.Status.Phase != reviewv1alpha2.PhaseSucceeded || stored.Status.CompletionTime == nil ||
		!stored.Status.CompletionTime.Time.Equal(completed) {
		t.Fatalf("late observed SHIP = %#v, want authoritative worker success", stored.Status)
	}
	if condition := meta.FindStatusCondition(stored.Status.Conditions, "FailurePublication"); condition != nil {
		t.Fatalf("late observed SHIP retained failure delegation: %#v", condition)
	}
	assertFailurePublisherAbsent(t, kube, req)
}

func TestMismatchedSucceededWorkerCannotOverridePendingFailure(t *testing.T) {
	ctx := context.Background()
	r, kube, req := missingJobFixture(t, "app-gate", interceptor.Funcs{})
	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	review := storedReview(t, kube, req)
	review.Status.Phase = reviewv1alpha2.PhaseFailed
	meta.SetStatusCondition(&review.Status.Conditions, metav1.Condition{
		Type: "FailurePublication", Status: metav1.ConditionFalse, Reason: "WorkerContractMismatch",
		ObservedGeneration: review.Generation, LastTransitionTime: metav1.NewTime(r.Now()),
	})
	if err := kube.Status().Update(ctx, review); err != nil {
		t.Fatal(err)
	}
	worker := storedWorker(t, kube, req)
	worker.Spec.Template.Spec.Containers[0].Image = "ghcr.io/review-yeti-ai/tampered@sha256:" + strings.Repeat("0", 64)
	if err := kube.Update(ctx, worker); err != nil {
		t.Fatal(err)
	}
	worker = storedWorker(t, kube, req)
	worker.Status.Succeeded = 1
	worker.Status.Conditions = []batchv1.JobCondition{{Type: batchv1.JobComplete, Status: corev1.ConditionTrue}}
	if err := kube.Status().Update(ctx, worker); err != nil {
		t.Fatal(err)
	}

	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	stored := storedReview(t, kube, req)
	if stored.Status.Phase == reviewv1alpha2.PhaseSucceeded {
		t.Fatal("contract-mismatched worker self-reported an authoritative success")
	}
	assertFailureDelegated(t, stored)
	assertFailurePublisherAbsent(t, kube, req)
}

func TestCompletedWorkerObservedAfterDeadlinePreservesAuthoritativeSuccess(t *testing.T) {
	ctx := context.Background()
	r, kube, req := missingJobFixture(t, "app-gate", interceptor.Funcs{})
	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	review := storedReview(t, kube, req)
	worker := storedWorker(t, kube, req)
	completed := review.Spec.TerminalDeadline.Add(-time.Second)
	worker.Status.Succeeded = 1
	worker.Status.Conditions = []batchv1.JobCondition{{
		Type: batchv1.JobComplete, Status: corev1.ConditionTrue, LastTransitionTime: metav1.NewTime(completed),
	}}
	if err := kube.Status().Update(ctx, worker); err != nil {
		t.Fatal(err)
	}
	r.Now = func() time.Time { return review.Spec.TerminalDeadline.Add(time.Second) }

	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	completedReview := storedReview(t, kube, req)
	if completedReview.Status.Phase != reviewv1alpha2.PhaseSucceeded || completedReview.Status.CompletionTime == nil ||
		!completedReview.Status.CompletionTime.Time.Equal(completed) {
		t.Fatalf("post-deadline observation = %#v, want authoritative pre-deadline success", completedReview.Status)
	}
}

func TestMissingPublishingWorkerAfterDeadlineStartsFailurePublication(t *testing.T) {
	ctx := context.Background()
	r, kube, req := missingJobFixture(t, "app-gate", interceptor.Funcs{})
	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	review := storedReview(t, kube, req)
	deleteLegacyWorker(t, kube, req)
	r.Now = func() time.Time { return review.Spec.TerminalDeadline.Add(time.Second) }

	result, err := r.Reconcile(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	failed := storedReview(t, kube, req)
	publication := meta.FindStatusCondition(failed.Status.Conditions, "FailurePublication")
	if result.RequeueAfter <= 0 || failed.Status.Phase != reviewv1alpha2.PhaseFailed || publication == nil ||
		publication.Status != metav1.ConditionFalse || publication.Reason != "WorkerJobMissing" {
		t.Fatalf("post-deadline missing worker outcome = %#v, result = %#v", failed.Status, result)
	}
	assertFailurePublisherAbsent(t, kube, req)
	assertWorkerAbsent(t, kube, req)
}

func TestAbandonedPublishingWorkerWaitsForPodExitBeforeDelegatingFailure(t *testing.T) {
	ctx := context.Background()
	r, kube, req := missingJobFixture(t, "app-gate", interceptor.Funcs{})
	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	review := storedReview(t, kube, req)
	worker := storedWorker(t, kube, req)
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "abandoned-worker", Namespace: req.Namespace, Labels: worker.Spec.Template.Labels},
		Spec:       *worker.Spec.Template.Spec.DeepCopy(),
		Status:     corev1.PodStatus{Phase: corev1.PodRunning},
	}
	if err := kube.Create(ctx, pod); err != nil {
		t.Fatal(err)
	}
	r.Now = func() time.Time { return review.Spec.TerminalDeadline.Add(time.Second) }

	result, err := r.Reconcile(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	if result.RequeueAfter <= 0 || !failurePublicationIsPending(storedReview(t, kube, req)) {
		t.Fatal("abandoned publishing worker did not enter durable failure publication")
	}
	assertFailurePublisherAbsent(t, kube, req)
	deletingWorker := storedWorker(t, kube, req)
	if deletingWorker.DeletionTimestamp == nil || !containsString(deletingWorker.Finalizers, "review-yeti.ai/terminal-outcome") {
		t.Fatal("abandoned worker was not stopped with its evidence guard retained")
	}
	if err := kube.Delete(ctx, pod); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	assertFailureDelegated(t, storedReview(t, kube, req))
	assertFailurePublisherAbsent(t, kube, req)
}

func TestRunningWorkerFromOlderOperatorAcquiresTerminalOutcomeFinalizer(t *testing.T) {
	ctx := context.Background()
	r, kube, req := missingJobFixture(t, "app-gate", interceptor.Funcs{})
	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	worker := storedWorker(t, kube, req)
	worker.Finalizers = nil
	if err := kube.Update(ctx, worker); err != nil {
		t.Fatal(err)
	}

	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	worker = storedWorker(t, kube, req)
	if !containsString(worker.Finalizers, "review-yeti.ai/terminal-outcome") {
		t.Fatalf("adopted worker finalizers = %v, want terminal-outcome protection", worker.Finalizers)
	}
}

func TestTerminalWorkerFromOlderOperatorIsGuardedBeforeParentStatusWrite(t *testing.T) {
	ctx := context.Background()
	failTerminalStatus := true
	hooks := interceptor.Funcs{SubResourceUpdate: func(ctx context.Context, c client.Client, sub string, obj client.Object, opts ...client.SubResourceUpdateOption) error {
		if review, ok := obj.(*reviewv1alpha2.PRReviewJob); ok && review.Status.Phase == reviewv1alpha2.PhaseSucceeded && failTerminalStatus {
			return errors.New("injected terminal parent status failure")
		}
		return c.SubResource(sub).Update(ctx, obj, opts...)
	}}
	r, kube, req := missingJobFixture(t, "app-gate", hooks)
	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	worker := storedWorker(t, kube, req)
	worker.Finalizers = nil
	if err := kube.Update(ctx, worker); err != nil {
		t.Fatal(err)
	}
	worker = storedWorker(t, kube, req)
	worker.Status.Succeeded = 1
	worker.Status.Conditions = []batchv1.JobCondition{{Type: batchv1.JobComplete, Status: corev1.ConditionTrue}}
	if err := kube.Status().Update(ctx, worker); err != nil {
		t.Fatal(err)
	}

	if _, err := r.Reconcile(ctx, req); err == nil {
		t.Fatal("expected injected terminal parent status failure")
	}
	if storedReview(t, kube, req).Status.Phase == reviewv1alpha2.PhaseSucceeded {
		t.Fatal("terminal parent status unexpectedly persisted")
	}
	worker = storedWorker(t, kube, req)
	if !containsString(worker.Finalizers, "review-yeti.ai/terminal-outcome") {
		t.Fatalf("terminal legacy worker finalizers = %v, want guard before parent status write", worker.Finalizers)
	}

	failTerminalStatus = false
	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	if storedReview(t, kube, req).Status.Phase != reviewv1alpha2.PhaseSucceeded {
		t.Fatal("terminal result was not persisted after status recovery")
	}
}

func TestDeletedReviewDoesNotStrandWorkerObservationFinalizer(t *testing.T) {
	ctx := context.Background()
	r, kube, req := missingJobFixture(t, "app-gate", interceptor.Funcs{})
	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	review := storedReview(t, kube, req)
	if err := kube.Delete(ctx, review); err != nil {
		t.Fatal(err)
	}

	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	worker := storedWorker(t, kube, req)
	if containsString(worker.Finalizers, "review-yeti.ai/terminal-outcome") {
		t.Fatalf("deleted owner stranded worker finalizers: %v", worker.Finalizers)
	}
}

func TestDeletedReviewDoesNotReleaseForeignWorkerObservationFinalizer(t *testing.T) {
	ctx := context.Background()
	r, kube, req := missingJobFixture(t, "app-gate", interceptor.Funcs{})
	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	worker := storedWorker(t, kube, req)
	worker.OwnerReferences[0].Name = "foreign-review"
	worker.OwnerReferences[0].UID = types.UID("foreign-review")
	if err := kube.Update(ctx, worker); err != nil {
		t.Fatal(err)
	}
	if err := kube.Delete(ctx, storedReview(t, kube, req)); err != nil {
		t.Fatal(err)
	}

	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	worker = storedWorker(t, kube, req)
	if !containsString(worker.Finalizers, "review-yeti.ai/terminal-outcome") {
		t.Fatal("owner-absent cleanup released a foreign worker's observation guard")
	}
}

func TestTerminalReviewDoesNotReleaseForeignWorkerObservationFinalizer(t *testing.T) {
	ctx := context.Background()
	r, kube, req := missingJobFixture(t, "app-gate", interceptor.Funcs{})
	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	worker := storedWorker(t, kube, req)
	worker.OwnerReferences[0].UID = types.UID("foreign-review")
	if err := kube.Update(ctx, worker); err != nil {
		t.Fatal(err)
	}
	review := storedReview(t, kube, req)
	review.Status.Phase = reviewv1alpha2.PhaseFailed
	if err := kube.Status().Update(ctx, review); err != nil {
		t.Fatal(err)
	}

	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	worker = storedWorker(t, kube, req)
	if !containsString(worker.Finalizers, "review-yeti.ai/terminal-outcome") {
		t.Fatal("terminal cleanup released a foreign worker's observation guard")
	}
}

func TestFailurePublicationRefusesToStopForeignWorker(t *testing.T) {
	ctx := context.Background()
	r, kube, req := missingJobFixture(t, "app-gate", interceptor.Funcs{})
	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	worker := storedWorker(t, kube, req)
	worker.OwnerReferences[0].UID = types.UID("foreign-review")
	if err := kube.Update(ctx, worker); err != nil {
		t.Fatal(err)
	}
	review := storedReview(t, kube, req)
	review.Status.Phase = reviewv1alpha2.PhaseFailed
	meta.SetStatusCondition(&review.Status.Conditions, metav1.Condition{
		Type: "FailurePublication", Status: metav1.ConditionFalse, Reason: "WorkerContractMismatch",
		ObservedGeneration: review.Generation, LastTransitionTime: metav1.NewTime(r.Now()),
	})
	if err := kube.Status().Update(ctx, review); err != nil {
		t.Fatal(err)
	}

	if _, err := r.Reconcile(ctx, req); err == nil || !strings.Contains(err.Error(), "not controlled by the failed review") {
		t.Fatalf("foreign worker stop error = %v", err)
	}
	worker = storedWorker(t, kube, req)
	if worker.DeletionTimestamp != nil || !containsString(worker.Finalizers, "review-yeti.ai/terminal-outcome") {
		t.Fatalf("foreign worker was mutated during failure recovery: deletion=%v finalizers=%v", worker.DeletionTimestamp, worker.Finalizers)
	}
}

func TestStaleReviewCacheMissCannotReleaseWorkerObservationFinalizer(t *testing.T) {
	ctx := context.Background()
	r, kube, req := missingJobFixture(t, "app-gate", interceptor.Funcs{})
	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	r.APIReader = kube
	r.Client = interceptor.NewClient(kube.(client.WithWatch), interceptor.Funcs{
		Get: func(ctx context.Context, c client.WithWatch, key client.ObjectKey, obj client.Object, opts ...client.GetOption) error {
			if _, ok := obj.(*reviewv1alpha2.PRReviewJob); ok {
				return apierrors.NewNotFound(schema.GroupResource{Group: "review-yeti.ai", Resource: "prreviewjobs"}, key.Name)
			}
			return c.Get(ctx, key, obj, opts...)
		},
	})

	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	worker := storedWorker(t, kube, req)
	if !containsString(worker.Finalizers, "review-yeti.ai/terminal-outcome") {
		t.Fatal("stale parent cache miss released worker observation guard")
	}
}

func TestFailedWorkerDelegatesFailClosedPublicationBeforeTerminalEvidenceIsReleased(t *testing.T) {
	ctx := context.Background()
	r, kube, req := missingJobFixture(t, "app-gate", interceptor.Funcs{})
	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	worker := storedWorker(t, kube, req)
	failedAt := r.Now().Add(time.Minute)
	r.Now = func() time.Time { return failedAt }
	worker.Status.Failed = 1
	worker.Status.Conditions = []batchv1.JobCondition{{
		Type: batchv1.JobFailed, Status: corev1.ConditionTrue,
		Reason: "BackoffLimitExceeded", LastTransitionTime: metav1.NewTime(failedAt),
	}}
	if err := kube.Status().Update(ctx, worker); err != nil {
		t.Fatal(err)
	}
	if err := kube.Delete(ctx, worker); err != nil {
		t.Fatal(err)
	}

	result, err := r.Reconcile(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	if result.RequeueAfter <= 0 {
		t.Fatal("pending failure delegation must requeue")
	}
	failedReview := storedReview(t, kube, req)
	publication := meta.FindStatusCondition(failedReview.Status.Conditions, "FailurePublication")
	if failedReview.Status.Phase != reviewv1alpha2.PhaseFailed || publication == nil || publication.Status != metav1.ConditionFalse {
		t.Fatalf("failed review status = %#v, want durable fail-closed delegation pending", failedReview.Status)
	}
	if !containsString(storedWorker(t, kube, req).Finalizers, "review-yeti.ai/terminal-outcome") {
		t.Fatal("terminal worker evidence was released before failure delegation")
	}
	assertFailurePublisherAbsent(t, kube, req)

	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	assertFailureDelegated(t, storedReview(t, kube, req))
	assertFailurePublisherAbsent(t, kube, req)
	if !containsString(storedWorker(t, kube, req).Finalizers, "review-yeti.ai/terminal-outcome") {
		t.Fatal("delegation status was not durable before terminal worker evidence was released")
	}
	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	assertWorkerAbsent(t, kube, req)
}

func TestMissingAppGateWorkerDelegatesFailureWithoutReplayingOrPublishing(t *testing.T) {
	ctx := context.Background()
	r, kube, req := missingJobFixture(t, "app-gate", interceptor.Funcs{})
	review := storedReview(t, kube, req)
	review.Status.Phase = reviewv1alpha2.PhaseRunning
	review.Status.JobName = req.Name + "-worker"
	if err := kube.Status().Update(ctx, review); err != nil {
		t.Fatal(err)
	}

	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	failed := storedReview(t, kube, req)
	publication := meta.FindStatusCondition(failed.Status.Conditions, "FailurePublication")
	if failed.Status.Phase != reviewv1alpha2.PhaseFailed || publication == nil || publication.Status != metav1.ConditionFalse || publication.Reason != "WorkerJobMissing" {
		t.Fatalf("missing worker outcome = %#v, want durable pending failure delegation", failed.Status)
	}
	assertFailurePublisherAbsent(t, kube, req)
	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	assertFailureDelegated(t, storedReview(t, kube, req))
	assertFailurePublisherAbsent(t, kube, req)
	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	assertWorkerAbsent(t, kube, req)
}

func TestAppGateWorkerContractMismatchEntersDurableFailureDelegation(t *testing.T) {
	ctx := context.Background()
	r, kube, req := missingJobFixture(t, "app-gate", interceptor.Funcs{})
	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	worker := storedWorker(t, kube, req)
	assignFakeWorkerUID(t, kube, worker)
	worker.Spec.Template.Spec.Containers[0].Image = "ghcr.io/review-yeti-ai/tampered@sha256:" + strings.Repeat("0", 64)
	worker.Labels["review-yeti.ai/run-id"] = "run_ffffffffffffffffffffffffffffffff"
	worker.Spec.Template.Labels["review-yeti.ai/run-id"] = "run_ffffffffffffffffffffffffffffffff"
	worker.Spec.Template.Labels["review-yeti.ai/component"] = "tampered-component"
	if err := kube.Update(ctx, worker); err != nil {
		t.Fatal(err)
	}
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name: "tampered-worker-pod", Namespace: req.Namespace,
			Labels: map[string]string{
				"batch.kubernetes.io/job-name":    worker.Name,
				"review-yeti.ai/run-id":           "run_ffffffffffffffffffffffffffffffff",
				"review-yeti.ai/component":        "tampered-component",
				"review-yeti.ai/publication-mode": job.PublicationModeAppGate,
			},
		},
		Spec: *worker.Spec.Template.Spec.DeepCopy(), Status: corev1.PodStatus{Phase: corev1.PodRunning},
	}
	bindTestPodToWorker(pod, worker)
	if err := kube.Create(ctx, pod); err != nil {
		t.Fatal(err)
	}

	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	pending := storedReview(t, kube, req)
	condition := meta.FindStatusCondition(pending.Status.Conditions, "FailurePublication")
	if pending.Status.Phase != reviewv1alpha2.PhaseFailed || condition == nil ||
		condition.Status != metav1.ConditionFalse || condition.Reason != "WorkerContractMismatch" {
		t.Fatalf("contract mismatch bypassed durable failure delegation: %#v", pending.Status)
	}
	assertFailurePublisherAbsent(t, kube, req)

	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	if !failurePublicationIsPending(storedReview(t, kube, req)) {
		t.Fatal("tampered active worker was bypassed before Pod exit")
	}
	if storedWorker(t, kube, req).DeletionTimestamp == nil {
		t.Fatal("exact owned mismatched worker was not stopped after durable failure state")
	}
	assertFailurePublisherAbsent(t, kube, req)
	if err := kube.Delete(ctx, pod); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	assertFailureDelegated(t, storedReview(t, kube, req))
	assertFailurePublisherAbsent(t, kube, req)
	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	assertWorkerAbsent(t, kube, req)
}

func TestFailurePublicationIgnoresForeignPodWithOwnedWorkerLabel(t *testing.T) {
	ctx := context.Background()
	r, kube, req := missingJobFixture(t, "app-gate", interceptor.Funcs{})
	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	worker := storedWorker(t, kube, req)
	worker.UID = types.UID("owned-worker")
	worker.Spec.Template.Spec.Containers[0].Image = "ghcr.io/review-yeti-ai/tampered@sha256:" + strings.Repeat("0", 64)
	if err := kube.Update(ctx, worker); err != nil {
		t.Fatal(err)
	}
	controller := true
	foreignPod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name: "foreign-pod", Namespace: req.Namespace,
			Labels: map[string]string{"batch.kubernetes.io/job-name": worker.Name},
			OwnerReferences: []metav1.OwnerReference{{
				APIVersion: batchv1.SchemeGroupVersion.String(), Kind: "Job", Name: worker.Name,
				UID: types.UID("foreign-worker"), Controller: &controller,
			}},
		},
		Status: corev1.PodStatus{Phase: corev1.PodRunning},
	}
	if err := kube.Create(ctx, foreignPod); err != nil {
		t.Fatal(err)
	}
	boundedPodLookup := false
	workerGets := 0
	podLists := 0
	r.Client = interceptor.NewClient(kube.(client.WithWatch), interceptor.Funcs{
		Get: func(ctx context.Context, c client.WithWatch, key client.ObjectKey, object client.Object, opts ...client.GetOption) error {
			if _, ok := object.(*batchv1.Job); ok && key.Name == worker.Name {
				workerGets++
			}
			return c.Get(ctx, key, object, opts...)
		},
		List: func(ctx context.Context, c client.WithWatch, list client.ObjectList, opts ...client.ListOption) error {
			options := &client.ListOptions{}
			for _, option := range opts {
				option.ApplyToList(options)
			}
			if _, ok := list.(*corev1.PodList); ok {
				podLists++
				if options.LabelSelector != nil && options.LabelSelector.String() == "batch.kubernetes.io/job-name="+worker.Name {
					boundedPodLookup = true
				}
			}
			return c.List(ctx, list, opts...)
		},
	})

	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	if !failurePublicationIsPending(storedReview(t, kube, req)) {
		t.Fatal("contract mismatch did not persist failure recovery")
	}
	workerGets = 0
	podLists = 0
	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	assertFailureDelegated(t, storedReview(t, kube, req))
	if workerGets != 1 || podLists != 1 {
		t.Fatalf("pending reconcile performed %d worker Gets and %d Pod Lists, want one each", workerGets, podLists)
	}
	if !boundedPodLookup {
		t.Fatal("failure recovery performed no Job-scoped Pod lookup")
	}
	if err := kube.Get(ctx, client.ObjectKeyFromObject(foreignPod), &corev1.Pod{}); err != nil {
		t.Fatalf("failure recovery mutated a foreign Pod: %v", err)
	}
}

func TestFailurePublicationStatusPrecedesTrustedServiceDelegation(t *testing.T) {
	ctx := context.Background()
	failPendingStatus := true
	hooks := interceptor.Funcs{SubResourceUpdate: func(ctx context.Context, c client.Client, sub string, obj client.Object, opts ...client.SubResourceUpdateOption) error {
		if review, ok := obj.(*reviewv1alpha2.PRReviewJob); ok && failurePublicationIsPending(review) && failPendingStatus {
			return errors.New("injected failure-publication status write failure")
		}
		return c.SubResource(sub).Update(ctx, obj, opts...)
	}}
	r, kube, req := missingJobFixture(t, "app-gate", hooks)
	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	worker := storedWorker(t, kube, req)
	worker.Status.Failed = 1
	worker.Status.Conditions = []batchv1.JobCondition{{Type: batchv1.JobFailed, Status: corev1.ConditionTrue}}
	if err := kube.Status().Update(ctx, worker); err != nil {
		t.Fatal(err)
	}

	if _, err := r.Reconcile(ctx, req); err == nil {
		t.Fatal("expected injected pending-status failure")
	}
	assertFailurePublisherAbsent(t, kube, req)
	if storedReview(t, kube, req).Status.Phase == reviewv1alpha2.PhaseFailed {
		t.Fatal("injected failure status unexpectedly persisted")
	}
	if !containsString(storedWorker(t, kube, req).Finalizers, "review-yeti.ai/terminal-outcome") {
		t.Fatal("status failure released terminal worker evidence")
	}

	failPendingStatus = false
	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	if !failurePublicationIsPending(storedReview(t, kube, req)) {
		t.Fatal("publication obligation was not persisted on retry")
	}
	assertFailurePublisherAbsent(t, kube, req)
	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	assertFailureDelegated(t, storedReview(t, kube, req))
	assertFailurePublisherAbsent(t, kube, req)
}

func failurePublicationIsPending(review *reviewv1alpha2.PRReviewJob) bool {
	condition := meta.FindStatusCondition(review.Status.Conditions, "FailurePublication")
	return condition != nil && condition.Status == metav1.ConditionFalse
}

func assertFailureDelegated(t *testing.T, review *reviewv1alpha2.PRReviewJob) {
	t.Helper()
	condition := meta.FindStatusCondition(review.Status.Conditions, "FailurePublication")
	if condition == nil || condition.Status != metav1.ConditionUnknown || condition.Reason != "DelegatedToTrustedService" {
		t.Fatalf("failure publication condition = %#v, want durable trusted-service delegation", condition)
	}
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func TestMissingWorkerJobNeverReplaysAnAdmittedExecution(t *testing.T) {
	for _, mode := range []string{"disabled", "app-gate"} {
		for _, observed := range []bool{false, true} {
			name := mode + "/GC-before-terminal-observation"
			if observed {
				name = mode + "/terminal-observed-control"
			}
			t.Run(name, func(t *testing.T) {
				ctx := context.Background()
				r, kube, req := missingJobFixture(t, mode, interceptor.Funcs{})
				originalSpec := storedReview(t, kube, req).DeepCopy().Spec
				if _, err := r.Reconcile(ctx, req); err != nil {
					t.Fatal(err)
				}
				worker := storedWorker(t, kube, req)
				if worker.Spec.TTLSecondsAfterFinished == nil || *worker.Spec.TTLSecondsAfterFinished != 0 {
					t.Fatal("expected immediate-GC fixture")
				}
				completed := r.Now().Add(time.Minute)
				r.Now = func() time.Time { return completed }
				worker.Status.Failed = 1
				worker.Status.Conditions = []batchv1.JobCondition{{Type: batchv1.JobFailed, Status: corev1.ConditionTrue, LastTransitionTime: metav1.NewTime(completed)}}
				if err := kube.Status().Update(ctx, worker); err != nil {
					t.Fatal(err)
				}
				if observed {
					if _, err := r.Reconcile(ctx, req); err != nil {
						t.Fatal(err)
					}
				}
				deleteLegacyWorker(t, kube, req)
				for retry := 0; retry < 2; retry++ {
					if _, err := r.Reconcile(ctx, req); err != nil {
						t.Fatal(err)
					}
					assertWorkerAbsent(t, kube, req)
				}
				final := storedReview(t, kube, req)
				if final.Status.Phase != reviewv1alpha2.PhaseFailed || !reflect.DeepEqual(final.Spec, originalSpec) {
					t.Fatalf("outcome must remain failed with the original run/attempt/secret: phase=%s", final.Status.Phase)
				}
			})
		}
	}
}

func TestMissingWorkerJobNeverStartedControlCanCreate(t *testing.T) {
	for _, mode := range []string{"disabled", "app-gate"} {
		t.Run(mode, func(t *testing.T) {
			r, kube, req := missingJobFixture(t, mode, interceptor.Funcs{})
			assertWorkerAbsent(t, kube, req)
			if _, err := r.Reconcile(context.Background(), req); err != nil {
				t.Fatal(err)
			}
			worker := storedWorker(t, kube, req)
			attempt := ""
			for _, variable := range worker.Spec.Template.Spec.Containers[0].Env {
				if variable.Name == job.ExecutionAttemptEnv {
					attempt = variable.Value
				}
			}
			if attempt != "2" || storedReview(t, kube, req).Status.Phase != reviewv1alpha2.PhaseRunning {
				t.Fatalf("never-started admitted execution did not launch correctly: attempt=%q", attempt)
			}
		})
	}
}

func TestMissingWorkerJobRecognizesLegacyExecutionEvidence(t *testing.T) {
	for _, evidence := range []string{"phase", "job-name", "start-time", "timing"} {
		t.Run(evidence, func(t *testing.T) {
			r, kube, req := missingJobFixture(t, "app-gate", interceptor.Funcs{})
			review := storedReview(t, kube, req)
			now := metav1.NewTime(r.Now())
			switch evidence {
			case "phase":
				review.Status.Phase = reviewv1alpha2.PhaseRunning
			case "job-name":
				review.Status.JobName = req.Name + "-worker"
			case "start-time":
				review.Status.StartTime = &now
			case "timing":
				review.Status.Timing = &reviewv1alpha2.DispatchTimingStatus{JobCreatedAt: &now}
			}
			if err := kube.Status().Update(context.Background(), review); err != nil {
				t.Fatal(err)
			}
			if _, err := r.Reconcile(context.Background(), req); err != nil {
				t.Fatal(err)
			}
			assertWorkerAbsent(t, kube, req)
			if storedReview(t, kube, req).Status.Phase != reviewv1alpha2.PhaseFailed {
				t.Fatal("lost legacy execution must fail closed")
			}
		})
	}
}

func TestMissingWorkerJobAfterLostPostCreateStatusIsNotRecreated(t *testing.T) {
	for _, gc := range []bool{false, true} {
		name := "existing-job-is-reobserved"
		if gc {
			name = "GC-before-status-retry"
		}
		t.Run(name, func(t *testing.T) {
			failStatus := true
			hooks := interceptor.Funcs{SubResourceUpdate: func(ctx context.Context, c client.Client, sub string, obj client.Object, opts ...client.SubResourceUpdateOption) error {
				if review, ok := obj.(*reviewv1alpha2.PRReviewJob); ok && review.Status.Phase == reviewv1alpha2.PhaseRunning && failStatus {
					return errors.New("injected post-Create status response failure")
				}
				return c.SubResource(sub).Update(ctx, obj, opts...)
			}}
			r, kube, req := missingJobFixture(t, "app-gate", hooks)
			if _, err := r.Reconcile(context.Background(), req); err == nil {
				t.Fatal("expected injected post-Create status failure")
			}
			worker := storedWorker(t, kube, req)
			if storedReview(t, kube, req).Status.Phase == reviewv1alpha2.PhaseRunning {
				t.Fatal("fixture unexpectedly persisted post-Create status")
			}
			failStatus = false
			if gc {
				worker.Status.Failed = 1
				if err := kube.Status().Update(context.Background(), worker); err != nil {
					t.Fatal(err)
				}
				deleteLegacyWorker(t, kube, req)
			}
			if _, err := r.Reconcile(context.Background(), req); err != nil {
				t.Fatal(err)
			}
			if gc {
				assertWorkerAbsent(t, kube, req)
				if storedReview(t, kube, req).Status.Phase != reviewv1alpha2.PhaseFailed {
					t.Fatal("unknown lost execution must fail closed")
				}
			} else {
				if storedWorker(t, kube, req).ResourceVersion != worker.ResourceVersion || storedReview(t, kube, req).Status.Phase != reviewv1alpha2.PhaseRunning {
					t.Fatal("existing exact Job must be reobserved without recreation")
				}
			}
		})
	}
}

func TestMissingWorkerJobCreationUncertaintyDoesNotRetryCreate(t *testing.T) {
	for _, serverCreated := range []bool{false, true} {
		name := "reservation-before-rejected-create"
		if serverCreated {
			name = "Create-accepted-response-lost-then-GC"
		}
		t.Run(name, func(t *testing.T) {
			failCreate := true
			hooks := interceptor.Funcs{Create: func(ctx context.Context, c client.WithWatch, obj client.Object, opts ...client.CreateOption) error {
				if _, ok := obj.(*batchv1.Job); ok && failCreate {
					if serverCreated {
						if err := c.Create(ctx, obj, opts...); err != nil {
							return err
						}
						obj.SetFinalizers(nil)
						if err := c.Update(ctx, obj); err != nil {
							return err
						}
						if err := c.Delete(ctx, obj); err != nil {
							return err
						}
					}
					return errors.New("injected uncertain Job Create response")
				}
				return c.Create(ctx, obj, opts...)
			}}
			r, kube, req := missingJobFixture(t, "app-gate", hooks)
			if _, err := r.Reconcile(context.Background(), req); err == nil {
				t.Fatal("expected uncertain Create response")
			}
			reservation := storedReview(t, kube, req)
			if reservation.Status.StartTime != nil || (reservation.Status.Timing != nil && reservation.Status.Timing.JobCreatedAt != nil) {
				t.Fatal("creation reservation must not fabricate a started/created receipt")
			}
			failCreate = false
			if _, err := r.Reconcile(context.Background(), req); err != nil {
				t.Fatal(err)
			}
			assertWorkerAbsent(t, kube, req)
			if storedReview(t, kube, req).Status.Phase != reviewv1alpha2.PhaseFailed {
				t.Fatal("unknown creation outcome must fail closed")
			}
		})
	}
}

func TestMissingWorkerJobCannotCreateWithoutDurableReservation(t *testing.T) {
	hooks := interceptor.Funcs{SubResourceUpdate: func(ctx context.Context, c client.Client, sub string, obj client.Object, opts ...client.SubResourceUpdateOption) error {
		if review, ok := obj.(*reviewv1alpha2.PRReviewJob); ok && meta.IsStatusConditionTrue(review.Status.Conditions, "WorkerCreationReserved") {
			return errors.New("injected reservation persistence failure")
		}
		return c.SubResource(sub).Update(ctx, obj, opts...)
	}}
	r, kube, req := missingJobFixture(t, "app-gate", hooks)
	if _, err := r.Reconcile(context.Background(), req); err == nil {
		t.Fatal("Job creation proceeded without a durable reservation")
	}
	assertWorkerAbsent(t, kube, req)
}

func TestMissingWorkerJobUsesFreshReadBeforeFailing(t *testing.T) {
	r, kube, req := missingJobFixture(t, "app-gate", interceptor.Funcs{})
	if _, err := r.Reconcile(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	original := storedWorker(t, kube, req)
	r.APIReader = kube
	r.Client = interceptor.NewClient(kube.(client.WithWatch), interceptor.Funcs{
		Get: func(ctx context.Context, c client.WithWatch, key client.ObjectKey, obj client.Object, opts ...client.GetOption) error {
			if _, ok := obj.(*batchv1.Job); ok {
				return apierrors.NewNotFound(schema.GroupResource{Group: "batch", Resource: "jobs"}, key.Name)
			}
			return c.Get(ctx, key, obj, opts...)
		},
	})
	if _, err := r.Reconcile(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	if storedReview(t, kube, req).Status.Phase != reviewv1alpha2.PhaseRunning || storedWorker(t, kube, req).ResourceVersion != original.ResourceVersion {
		t.Fatal("a stale cache miss must not terminalize or replace the existing Job")
	}
}

func TestMissingWorkerJobCleanupPreservesActivePodAndForeignLease(t *testing.T) {
	for _, mode := range []string{"disabled", "app-gate"} {
		for _, active := range []string{"own-pod", "foreign-lease"} {
			t.Run(mode+"/"+active, func(t *testing.T) {
				ctx := context.Background()
				r, kube, req := missingJobFixture(t, mode, interceptor.Funcs{})
				if _, err := r.Reconcile(ctx, req); err != nil {
					t.Fatal(err)
				}
				worker := storedWorker(t, kube, req)
				review := storedReview(t, kube, req)
				deleteLegacyWorker(t, kube, req)
				leaseKey := types.NamespacedName{Namespace: req.Namespace, Name: workspace.LeaseName(review.Spec.RepositoryID, review.Spec.PRNumber)}
				var lease coordinationv1.Lease
				if err := kube.Get(ctx, leaseKey, &lease); err != nil {
					t.Fatal(err)
				}
				if active == "own-pod" {
					pod := &corev1.Pod{ObjectMeta: *worker.Spec.Template.ObjectMeta.DeepCopy(), Spec: *worker.Spec.Template.Spec.DeepCopy(), Status: corev1.PodStatus{Phase: corev1.PodRunning}}
					pod.Name, pod.Namespace = "active-worker", req.Namespace
					if err := kube.Create(ctx, pod); err != nil {
						t.Fatal(err)
					}
				} else {
					foreign := "run_22222222222222222222222222222222"
					lease.Spec.HolderIdentity = &foreign
					if err := kube.Update(ctx, &lease); err != nil {
						t.Fatal(err)
					}
				}
				originalLease := lease.DeepCopy()
				for retry := 0; retry < 2; retry++ {
					result, err := r.Reconcile(ctx, req)
					if err != nil {
						t.Fatal(err)
					}
					assertWorkerAbsent(t, kube, req)
					if result.RequeueAfter <= 0 {
						t.Fatal("cleanup must continue with a bounded requeue")
					}
				}
				if storedReview(t, kube, req).Status.Phase != reviewv1alpha2.PhaseFailed {
					t.Fatal("missing prior execution must remain failed during cleanup")
				}
				if err := kube.Get(ctx, leaseKey, &lease); err != nil || !reflect.DeepEqual(lease.Spec, originalLease.Spec) {
					t.Fatalf("active lease was released or changed: %v", err)
				}
				var pvc corev1.PersistentVolumeClaim
				if err := kube.Get(ctx, types.NamespacedName{Namespace: req.Namespace, Name: review.Status.PVCName}, &pvc); err != nil || pvc.DeletionTimestamp != nil {
					t.Fatalf("active workspace was removed or marked for deletion: %v", err)
				}
			})
		}
	}
}
