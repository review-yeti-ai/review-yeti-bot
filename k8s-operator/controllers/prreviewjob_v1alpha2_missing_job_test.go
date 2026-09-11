package controllers_test

import (
	"context"
	"errors"
	"reflect"
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

func storedFailurePublisher(t *testing.T, kube client.Client, req ctrl.Request) *batchv1.Job {
	t.Helper()
	publisher := &batchv1.Job{}
	if err := kube.Get(context.Background(), types.NamespacedName{
		Namespace: req.Namespace,
		Name:      req.Name + "-fail",
	}, publisher); err != nil {
		t.Fatal(err)
	}
	return publisher
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
	storedFailurePublisher(t, kube, req)
	assertWorkerAbsent(t, kube, req)
}

func TestAbandonedPublishingWorkerWaitsForPodExitBeforeFailurePublisher(t *testing.T) {
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
	if err := kube.Get(ctx, types.NamespacedName{Namespace: req.Namespace, Name: req.Name + "-fail"}, &batchv1.Job{}); !apierrors.IsNotFound(err) {
		t.Fatalf("failure publisher started while the abandoned worker Pod was active: %v", err)
	}
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
	storedFailurePublisher(t, kube, req)
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

func TestFailedWorkerPublishesFailClosedCheckBeforeTerminalEvidenceIsReleased(t *testing.T) {
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
		t.Fatal("pending failure publication must requeue")
	}
	failedReview := storedReview(t, kube, req)
	publication := meta.FindStatusCondition(failedReview.Status.Conditions, "FailurePublication")
	if failedReview.Status.Phase != reviewv1alpha2.PhaseFailed || publication == nil || publication.Status != metav1.ConditionFalse {
		t.Fatalf("failed review status = %#v, want durable fail-closed publication pending", failedReview.Status)
	}
	retained := storedWorker(t, kube, req)
	if !containsString(retained.Finalizers, "review-yeti.ai/terminal-outcome") {
		t.Fatal("terminal worker evidence was released before fail-closed publication")
	}

	publisher := storedFailurePublisher(t, kube, req)
	if publisher.Spec.BackoffLimit == nil || *publisher.Spec.BackoffLimit < 1 || publisher.Spec.ActiveDeadlineSeconds == nil {
		t.Fatalf("failure publisher retry bounds = backoff %v deadline %v", publisher.Spec.BackoffLimit, publisher.Spec.ActiveDeadlineSeconds)
	}
	container := publisher.Spec.Template.Spec.Containers[0]
	if len(container.Env) != 5 || !hasExactSecretEnv(container.Env, "GITHUB_PUBLISH_TOKEN", failedReview.Spec.RunSecretName, "GITHUB_PUBLISH_TOKEN") {
		t.Fatalf("failure publisher env = %#v, want exact App token plus bounded identity", container.Env)
	}
	for _, forbidden := range []string{"GH_TOKEN", "BIFROST_PR_REVIEW_API_KEY", "GITHUB_APP_PRIVATE_KEY"} {
		if envNamed(container.Env, forbidden) {
			t.Fatalf("failure publisher received forbidden credential %s", forbidden)
		}
	}
	if container.Image != failedReview.Spec.WorkerImage || len(container.Command) != 1 || container.Command[0] != "node" {
		t.Fatalf("failure publisher runtime = image %q command %v", container.Image, container.Command)
	}
	if publisher.Spec.Template.Spec.AutomountServiceAccountToken == nil || *publisher.Spec.Template.Spec.AutomountServiceAccountToken {
		t.Fatal("failure publisher must not receive a Kubernetes API token")
	}

	publisher.Status.Succeeded = 1
	publisher.Status.CompletionTime = &metav1.Time{Time: failedAt.Add(time.Second)}
	if err := kube.Status().Update(ctx, publisher); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	publishedReview := storedReview(t, kube, req)
	publication = meta.FindStatusCondition(publishedReview.Status.Conditions, "FailurePublication")
	if publication == nil || publication.Status != metav1.ConditionTrue || publication.Reason != "Published" {
		t.Fatalf("failure publication condition = %#v, want durable success", publication)
	}
	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	assertWorkerAbsent(t, kube, req)
}

func TestMissingAppGateWorkerStartsDurableFailurePublicationWithoutReplay(t *testing.T) {
	ctx := context.Background()
	r, kube, req := missingJobFixture(t, "app-gate", interceptor.Funcs{})
	review := storedReview(t, kube, req)
	review.Status.Phase = reviewv1alpha2.PhaseRunning
	review.Status.JobName = req.Name + "-worker"
	if err := kube.Status().Update(ctx, review); err != nil {
		t.Fatal(err)
	}

	result, err := r.Reconcile(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	if result.RequeueAfter <= 0 {
		t.Fatal("missing App worker publication must keep retrying")
	}
	failed := storedReview(t, kube, req)
	publication := meta.FindStatusCondition(failed.Status.Conditions, "FailurePublication")
	if failed.Status.Phase != reviewv1alpha2.PhaseFailed || publication == nil || publication.Status != metav1.ConditionFalse || publication.Reason != "WorkerJobMissing" {
		t.Fatalf("missing worker outcome = %#v, want durable pending failure publication", failed.Status)
	}
	storedFailurePublisher(t, kube, req)
	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	assertWorkerAbsent(t, kube, req)
}

func TestFailedWorkerPublicationJobRetriesAfterTerminalPublisherFailure(t *testing.T) {
	ctx := context.Background()
	r, kube, req := failedPublisherFixture(t)
	publisher := storedFailurePublisher(t, kube, req)
	publisher.Status.Failed = 1
	publisher.Status.Conditions = []batchv1.JobCondition{{
		Type: batchv1.JobFailed, Status: corev1.ConditionTrue, Reason: "BackoffLimitExceeded",
	}}
	if err := kube.Status().Update(ctx, publisher); err != nil {
		t.Fatal(err)
	}

	result, err := r.Reconcile(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	if result.RequeueAfter <= 0 {
		t.Fatal("terminal publisher failure must remain retryable")
	}
	err = kube.Get(ctx, client.ObjectKeyFromObject(publisher), &batchv1.Job{})
	if !apierrors.IsNotFound(err) {
		t.Fatalf("terminal publisher was not cleared for deterministic retry: %v", err)
	}
	failed := storedReview(t, kube, req)
	if !failurePublicationIsPending(failed) {
		t.Fatalf("publisher failure cleared the durable obligation: %#v", failed.Status.Conditions)
	}
	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	retried := storedFailurePublisher(t, kube, req)
	if retried.Status.Succeeded != 0 || retried.Status.Failed != 0 {
		t.Fatalf("recreated publisher inherited terminal status: %#v", retried.Status)
	}
	if !containsString(storedWorker(t, kube, req).Finalizers, "review-yeti.ai/terminal-outcome") {
		t.Fatal("publisher retry released terminal worker evidence")
	}
}

func TestFailurePublisherContractTamperFailsClosed(t *testing.T) {
	ctx := context.Background()
	r, kube, req := failedPublisherFixture(t)
	publisher := storedFailurePublisher(t, kube, req)
	container := &publisher.Spec.Template.Spec.Containers[0]
	container.Env = append(container.Env, corev1.EnvVar{Name: "GH_TOKEN", Value: "unexpected"})
	container.Args = []string{"--input-type=module", "--eval", "console.log(process.env)"}
	if err := kube.Update(ctx, publisher); err != nil {
		t.Fatal(err)
	}

	if _, err := r.Reconcile(ctx, req); err == nil {
		t.Fatal("tampered failure publisher was accepted")
	}
	if !failurePublicationIsPending(storedReview(t, kube, req)) {
		t.Fatal("tampered publisher cleared the durable publication obligation")
	}
	if !containsString(storedWorker(t, kube, req).Finalizers, "review-yeti.ai/terminal-outcome") {
		t.Fatal("tampered publisher released terminal worker evidence")
	}
}

func TestFailurePublicationStatusPrecedesPublisherCreation(t *testing.T) {
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
	if err := kube.Get(ctx, types.NamespacedName{Namespace: req.Namespace, Name: req.Name + "-fail"}, &batchv1.Job{}); !apierrors.IsNotFound(err) {
		t.Fatalf("publisher was created before its durable obligation: %v", err)
	}
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
	storedFailurePublisher(t, kube, req)
}

func TestPublisherSuccessStatusPrecedesTerminalEvidenceRelease(t *testing.T) {
	ctx := context.Background()
	failPublishedStatus := true
	hooks := interceptor.Funcs{SubResourceUpdate: func(ctx context.Context, c client.Client, sub string, obj client.Object, opts ...client.SubResourceUpdateOption) error {
		if review, ok := obj.(*reviewv1alpha2.PRReviewJob); ok {
			condition := meta.FindStatusCondition(review.Status.Conditions, "FailurePublication")
			if condition != nil && condition.Status == metav1.ConditionTrue && failPublishedStatus {
				return errors.New("injected publication receipt status write failure")
			}
		}
		return c.SubResource(sub).Update(ctx, obj, opts...)
	}}
	r, kube, req := failedPublisherFixtureWithHooks(t, hooks)
	publisher := storedFailurePublisher(t, kube, req)
	publisher.Status.Succeeded = 1
	if err := kube.Status().Update(ctx, publisher); err != nil {
		t.Fatal(err)
	}

	if _, err := r.Reconcile(ctx, req); err == nil {
		t.Fatal("expected injected publication receipt failure")
	}
	if !failurePublicationIsPending(storedReview(t, kube, req)) {
		t.Fatal("publisher completion was treated as durable before status write")
	}
	if !containsString(storedWorker(t, kube, req).Finalizers, "review-yeti.ai/terminal-outcome") {
		t.Fatal("publication receipt failure released terminal worker evidence")
	}

	failPublishedStatus = false
	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	condition := meta.FindStatusCondition(storedReview(t, kube, req).Status.Conditions, "FailurePublication")
	if condition == nil || condition.Status != metav1.ConditionTrue {
		t.Fatalf("publication success was not durably recorded on retry: %#v", condition)
	}
}

func TestRunningFailurePublisherPodDoesNotBlockItsOwnCompletionObservation(t *testing.T) {
	ctx := context.Background()
	r, kube, req := failedPublisherFixture(t)
	publisher := storedFailurePublisher(t, kube, req)
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "failure-publisher", Namespace: req.Namespace, Labels: publisher.Spec.Template.Labels},
		Spec:       *publisher.Spec.Template.Spec.DeepCopy(),
		Status:     corev1.PodStatus{Phase: corev1.PodRunning},
	}
	if err := kube.Create(ctx, pod); err != nil {
		t.Fatal(err)
	}
	publisher.Status.Succeeded = 1
	if err := kube.Status().Update(ctx, publisher); err != nil {
		t.Fatal(err)
	}

	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	condition := meta.FindStatusCondition(storedReview(t, kube, req).Status.Conditions, "FailurePublication")
	if condition == nil || condition.Status != metav1.ConditionTrue {
		t.Fatalf("publisher Pod blocked its own completion receipt: %#v", condition)
	}
}

func failedPublisherFixture(t *testing.T) (*controllers.PRReviewJobV1Alpha2Reconciler, client.Client, ctrl.Request) {
	t.Helper()
	return failedPublisherFixtureWithHooks(t, interceptor.Funcs{})
}

func failedPublisherFixtureWithHooks(t *testing.T, hooks interceptor.Funcs) (*controllers.PRReviewJobV1Alpha2Reconciler, client.Client, ctrl.Request) {
	t.Helper()
	ctx := context.Background()
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
	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}
	return r, kube, req
}

func failurePublicationIsPending(review *reviewv1alpha2.PRReviewJob) bool {
	condition := meta.FindStatusCondition(review.Status.Conditions, "FailurePublication")
	return condition != nil && condition.Status == metav1.ConditionFalse
}

func hasExactSecretEnv(env []corev1.EnvVar, name, secret, key string) bool {
	for _, variable := range env {
		if variable.Name == name && variable.ValueFrom != nil && variable.ValueFrom.SecretKeyRef != nil {
			return variable.ValueFrom.SecretKeyRef.Name == secret && variable.ValueFrom.SecretKeyRef.Key == key
		}
	}
	return false
}

func envNamed(env []corev1.EnvVar, name string) bool {
	for _, variable := range env {
		if variable.Name == name {
			return true
		}
	}
	return false
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
