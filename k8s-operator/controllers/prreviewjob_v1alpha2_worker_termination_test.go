/*
Copyright 2026 CallTelemetry.

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

// REL-1038: the PRReviewJob, not the short-lived worker Pod, is the forensic
// handle for how a worker ended. These tests pin the ordering that makes
// REVIEW_YETI_WORKER_FAILED_TTL_AFTER_FINISHED=0 safe: the Pod's termination
// record is durable in the parent status before this controller lets the
// worker Job's TTL shrink below the build-time forensic hold.
package controllers_test

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"testing"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"

	reviewv1alpha2 "github.com/calltelemetry/ct-review-bot/k8s-operator/api/v1alpha2"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/controllers"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/job"
)

type terminationFixture struct {
	reconciler *controllers.PRReviewJobV1Alpha2Reconciler
	kube       client.Client
	req        ctrl.Request
	review     *reviewv1alpha2.PRReviewJob
	now        time.Time
}

func ttlString(ttl *int32) string {
	if ttl == nil {
		return "<nil>"
	}
	return strconv.Itoa(int(*ttl))
}

func newTerminationFixture(t *testing.T) *terminationFixture {
	t.Helper()
	now := time.Date(2026, 9, 23, 13, 0, 0, 0, time.UTC)
	builder, review := workerJobLifecycleFixture(t, now)
	kube := builder.WithStatusSubresource(&batchv1.Job{}).Build()
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: kube, Scheme: v1alpha2Scheme(t), Now: func() time.Time { return now }}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}
	for _, step := range []string{"create workspace", "create worker"} {
		if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
			t.Fatalf("%s: %v", step, err)
		}
	}
	return &terminationFixture{reconciler: reconciler, kube: kube, req: req, review: review, now: now}
}

func (f *terminationFixture) worker(t *testing.T) *batchv1.Job {
	t.Helper()
	return storedWorker(t, f.kube, f.req)
}

// finishWorker creates the worker's terminated Pod and then marks the Job
// finished, the order Kubernetes produces them in.
func (f *terminationFixture) finishWorker(t *testing.T, succeeded bool, terminated corev1.ContainerStateTerminated, podReason string) *batchv1.Job {
	t.Helper()
	worker := f.worker(t)
	assignFakeWorkerUID(t, f.kube, worker)
	phase := corev1.PodFailed
	if succeeded {
		phase = corev1.PodSucceeded
	}
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      worker.Name + "-x7k2p",
			Namespace: f.review.Namespace,
			Labels: map[string]string{
				"review-yeti.ai/run-id":        f.review.Spec.RunID,
				"review-yeti.ai/component":     "receipt-only-worker",
				"batch.kubernetes.io/job-name": worker.Name,
			},
		},
		Spec: corev1.PodSpec{NodeName: "workers-memory-16gb-abc12"},
		Status: corev1.PodStatus{
			Phase:  phase,
			Reason: podReason,
			ContainerStatuses: []corev1.ContainerStatus{{
				Name:  job.WorkerContainerName,
				State: corev1.ContainerState{Terminated: &terminated},
			}},
		},
	}
	bindTestPodToWorker(pod, worker)
	if err := f.kube.Create(context.Background(), pod); err != nil {
		t.Fatalf("create worker pod: %v", err)
	}
	finishedAt := metav1.NewTime(f.now.Add(time.Minute))
	condition := batchv1.JobFailed
	if succeeded {
		worker.Status.Succeeded = 1
		condition = batchv1.JobComplete
	} else {
		worker.Status.Failed = 1
	}
	worker.Status.Conditions = []batchv1.JobCondition{{Type: condition, Status: corev1.ConditionTrue, LastTransitionTime: finishedAt}}
	if err := f.kube.Status().Update(context.Background(), worker); err != nil {
		t.Fatalf("mark worker finished: %v", err)
	}
	return worker
}

func oomTermination(now time.Time) corev1.ContainerStateTerminated {
	return corev1.ContainerStateTerminated{
		ExitCode:   137,
		Reason:     "OOMKilled",
		StartedAt:  metav1.NewTime(now.Add(5 * time.Second)),
		FinishedAt: metav1.NewTime(now.Add(55 * time.Second)),
		Message: "review panel started\n" +
			"FATAL persona lane crashed Authorization: Bearer ghs_abcdefghijklmnopqrstuvwxyz0123456789 heap limit\n\n",
	}
}

func TestWorkerTerminationIsRecordedBeforeFailedTTLZeroCanCollectThePod(t *testing.T) {
	t.Setenv(job.WorkerFailedTTLAfterFinishedEnv, "0")
	t.Setenv(job.WorkerTTLAfterFinishedEnv, "0")
	f := newTerminationFixture(t)

	built := f.worker(t)
	if built.Spec.TTLSecondsAfterFinished == nil || *built.Spec.TTLSecondsAfterFinished != job.DefaultWorkerForensicHoldSeconds {
		t.Fatalf("built worker TTL = %v, want the %ds forensic hold, not the failed TTL of 0 that would let kube collect the Pod before it is read",
			ttlString(built.Spec.TTLSecondsAfterFinished), job.DefaultWorkerForensicHoldSeconds)
	}

	f.finishWorker(t, false, oomTermination(f.now), "")
	if _, err := f.reconciler.Reconcile(context.Background(), f.req); err != nil {
		t.Fatalf("observe worker failure: %v", err)
	}
	review := storedReview(t, f.kube, f.req)
	if review.Status.Phase != reviewv1alpha2.PhaseFailed {
		t.Fatalf("phase = %s, want Failed", review.Status.Phase)
	}
	record := review.Status.WorkerTermination
	if record == nil {
		t.Fatal("status.workerTermination is missing: the failed worker's exit is lost once the TTL collects its Pod")
	}
	if record.PodName != built.Name+"-x7k2p" || record.NodeName != "workers-memory-16gb-abc12" || record.ContainerName != job.WorkerContainerName {
		t.Fatalf("termination identity = %+v", record)
	}
	if record.ExitCode == nil || *record.ExitCode != 137 || record.Reason != "OOMKilled" {
		t.Fatalf("termination exit = %v reason=%q, want 137 OOMKilled", record.ExitCode, record.Reason)
	}
	if record.FinishedAt == nil || !record.FinishedAt.Time.Equal(f.now.Add(55*time.Second)) || record.StartedAt == nil {
		t.Fatalf("termination times = started %v finished %v", record.StartedAt, record.FinishedAt)
	}
	if !strings.HasPrefix(record.Message, "FATAL persona lane crashed") || !strings.Contains(record.Message, "[REDACTED]") ||
		strings.Contains(record.Message, "ghs_") || strings.Contains(record.Message, "review panel started") {
		t.Fatalf("termination message = %q, want the redacted last error line only", record.Message)
	}
	held := f.worker(t)
	if held.Spec.TTLSecondsAfterFinished == nil || *held.Spec.TTLSecondsAfterFinished != job.DefaultWorkerForensicHoldSeconds {
		t.Fatalf("worker TTL right after failure = %v, want the forensic hold until the terminal release", ttlString(held.Spec.TTLSecondsAfterFinished))
	}

	if _, err := f.reconciler.Reconcile(context.Background(), f.req); err != nil {
		t.Fatalf("terminal release: %v", err)
	}
	released := f.worker(t)
	if released.Spec.TTLSecondsAfterFinished == nil || *released.Spec.TTLSecondsAfterFinished != 0 {
		t.Fatalf("released worker TTL = %v, want the configured failed TTL 0 once the record is durable", ttlString(released.Spec.TTLSecondsAfterFinished))
	}
	for _, finalizer := range released.Finalizers {
		if finalizer == "review-yeti.ai/terminal-outcome" {
			t.Fatal("terminal-outcome finalizer should be released after the record is durable")
		}
	}
}

func TestWorkerTerminationPersistsBeforeTheSuccessTTLPatch(t *testing.T) {
	f := newTerminationFixture(t)
	f.finishWorker(t, true, corev1.ContainerStateTerminated{
		ExitCode: 0, Reason: "Completed",
		StartedAt: metav1.NewTime(f.now.Add(5 * time.Second)), FinishedAt: metav1.NewTime(f.now.Add(40 * time.Second)),
	}, "")

	patchFailure := errors.New("injected success TTL patch failure")
	f.reconciler.Client = interceptor.NewClient(f.kube.(client.WithWatch), interceptor.Funcs{
		Patch: func(ctx context.Context, c client.WithWatch, obj client.Object, patch client.Patch, opts ...client.PatchOption) error {
			if _, ok := obj.(*batchv1.Job); ok {
				return patchFailure
			}
			return c.Patch(ctx, obj, patch, opts...)
		},
	})
	if _, err := f.reconciler.Reconcile(context.Background(), f.req); !errors.Is(err, patchFailure) {
		t.Fatalf("Reconcile error = %v, want the injected patch failure", err)
	}
	review := storedReview(t, f.kube, f.req)
	if review.Status.Phase == reviewv1alpha2.PhaseSucceeded {
		t.Fatal("a failed TTL patch must still block Succeeded")
	}
	if review.Status.WorkerTermination == nil || review.Status.WorkerTermination.ExitCode == nil ||
		*review.Status.WorkerTermination.ExitCode != 0 || review.Status.WorkerTermination.Reason != "Completed" {
		t.Fatalf("workerTermination = %+v, want the exit record durable before any TTL patch is attempted", review.Status.WorkerTermination)
	}
}

func TestWorkerTerminationRecordsPodLevelFailureWithoutContainerExit(t *testing.T) {
	f := newTerminationFixture(t)
	worker := f.worker(t)
	assignFakeWorkerUID(t, f.kube, worker)
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name: worker.Name + "-evict", Namespace: f.review.Namespace,
			Labels: map[string]string{"batch.kubernetes.io/job-name": worker.Name},
		},
		Status: corev1.PodStatus{
			Phase:   corev1.PodFailed,
			Reason:  "Evicted",
			Message: "The node was low on resource: memory. Container reviewer-worker was using 1100Mi.",
		},
	}
	bindTestPodToWorker(pod, worker)
	if err := f.kube.Create(context.Background(), pod); err != nil {
		t.Fatal(err)
	}
	worker.Status.Failed = 1
	worker.Status.Conditions = []batchv1.JobCondition{{Type: batchv1.JobFailed, Status: corev1.ConditionTrue, LastTransitionTime: metav1.NewTime(f.now.Add(time.Minute))}}
	if err := f.kube.Status().Update(context.Background(), worker); err != nil {
		t.Fatal(err)
	}
	if _, err := f.reconciler.Reconcile(context.Background(), f.req); err != nil {
		t.Fatal(err)
	}
	record := storedReview(t, f.kube, f.req).Status.WorkerTermination
	if record == nil || record.PodReason != "Evicted" || record.ExitCode != nil || !strings.Contains(record.Message, "low on resource: memory") {
		t.Fatalf("workerTermination = %+v, want the Pod-level eviction with no container exit code", record)
	}
}

func TestWorkerTerminationIsWrittenOnceAndNeverReplaced(t *testing.T) {
	f := newTerminationFixture(t)
	f.finishWorker(t, false, oomTermination(f.now), "")
	if _, err := f.reconciler.Reconcile(context.Background(), f.req); err != nil {
		t.Fatal(err)
	}
	first := storedReview(t, f.kube, f.req).Status.WorkerTermination
	if first == nil {
		t.Fatal("first record missing")
	}
	// A later Pod observation (clock moved, message changed) must not rewrite
	// the forensic record during the terminal release.
	pod := &corev1.Pod{}
	if err := f.kube.Get(context.Background(), types.NamespacedName{Namespace: f.review.Namespace, Name: first.PodName}, pod); err != nil {
		t.Fatal(err)
	}
	pod.Status.ContainerStatuses[0].State.Terminated.Message = "rewritten"
	if err := f.kube.Status().Update(context.Background(), pod); err != nil {
		t.Fatal(err)
	}
	f.reconciler.Now = func() time.Time { return f.now.Add(10 * time.Minute) }
	if _, err := f.reconciler.Reconcile(context.Background(), f.req); err != nil {
		t.Fatal(err)
	}
	second := storedReview(t, f.kube, f.req).Status.WorkerTermination
	if second == nil || second.Message != first.Message || !second.ObservedAt.Equal(&first.ObservedAt) {
		t.Fatalf("record changed from %+v to %+v", first, second)
	}
}

func hasTerminalOutcomeFinalizer(worker *batchv1.Job) bool {
	for _, finalizer := range worker.Finalizers {
		if finalizer == "review-yeti.ai/terminal-outcome" {
			return true
		}
	}
	return false
}

// The Pod cache can trail the Job's terminal event: the Job says Failed while
// the cached Pod still shows a running container. Release must then keep the
// finalizer and the forensic-hold TTL until the exit is readable, instead of
// dropping the TTL to 0 and letting kube collect an unrecorded Pod.
func TestWorkerReleaseWaitsForAReadablePodExitBeforeLoweringTheHold(t *testing.T) {
	t.Setenv(job.WorkerFailedTTLAfterFinishedEnv, "0")
	f := newTerminationFixture(t)
	worker := f.worker(t)
	assignFakeWorkerUID(t, f.kube, worker)
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name: worker.Name + "-lag", Namespace: f.review.Namespace,
			Labels: map[string]string{"batch.kubernetes.io/job-name": worker.Name},
		},
		Status: corev1.PodStatus{
			Phase: corev1.PodRunning,
			ContainerStatuses: []corev1.ContainerStatus{{
				Name:  job.WorkerContainerName,
				State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{StartedAt: metav1.NewTime(f.now.Add(5 * time.Second))}},
			}},
		},
	}
	bindTestPodToWorker(pod, worker)
	if err := f.kube.Create(context.Background(), pod); err != nil {
		t.Fatal(err)
	}
	worker.Status.Failed = 1
	worker.Status.Conditions = []batchv1.JobCondition{{Type: batchv1.JobFailed, Status: corev1.ConditionTrue, LastTransitionTime: metav1.NewTime(f.now)}}
	if err := f.kube.Status().Update(context.Background(), worker); err != nil {
		t.Fatal(err)
	}
	for _, step := range []string{"observe failure", "terminal release attempt"} {
		if _, err := f.reconciler.Reconcile(context.Background(), f.req); err != nil {
			t.Fatalf("%s: %v", step, err)
		}
	}
	if storedReview(t, f.kube, f.req).Status.WorkerTermination != nil {
		t.Fatal("no record expected while the Pod exit is unreadable")
	}
	held := f.worker(t)
	if !hasTerminalOutcomeFinalizer(held) || held.Spec.TTLSecondsAfterFinished == nil || *held.Spec.TTLSecondsAfterFinished != job.DefaultWorkerForensicHoldSeconds {
		t.Fatalf("worker released with TTL %s finalizer=%v before its Pod exit was recorded",
			ttlString(held.Spec.TTLSecondsAfterFinished), hasTerminalOutcomeFinalizer(held))
	}

	// The cache catches up: the exit is recorded, then the hold is lowered.
	pod.Status.Phase = corev1.PodFailed
	pod.Status.ContainerStatuses[0].State = corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{
		ExitCode: 1, Reason: "Error", Message: "Error: review worker contract is invalid",
		FinishedAt: metav1.NewTime(f.now),
	}}
	if err := f.kube.Status().Update(context.Background(), pod); err != nil {
		t.Fatal(err)
	}
	if _, err := f.reconciler.Reconcile(context.Background(), f.req); err != nil {
		t.Fatal(err)
	}
	record := storedReview(t, f.kube, f.req).Status.WorkerTermination
	if record == nil || record.ExitCode == nil || *record.ExitCode != 1 || record.Message != "Error: review worker contract is invalid" {
		t.Fatalf("workerTermination = %+v, want the late-visible exit", record)
	}
	released := f.worker(t)
	if hasTerminalOutcomeFinalizer(released) || released.Spec.TTLSecondsAfterFinished == nil || *released.Spec.TTLSecondsAfterFinished != 0 {
		t.Fatalf("worker after record: TTL %s finalizer=%v, want released at the failed TTL 0",
			ttlString(released.Spec.TTLSecondsAfterFinished), hasTerminalOutcomeFinalizer(released))
	}
}

// Release never wedges: once the forensic hold has elapsed since the Job
// finished, an unreadable Pod no longer blocks it.
func TestWorkerReleaseProceedsWithoutARecordOnceTheHoldElapses(t *testing.T) {
	t.Setenv(job.WorkerFailedTTLAfterFinishedEnv, "0")
	f := newTerminationFixture(t)
	worker := f.worker(t)
	assignFakeWorkerUID(t, f.kube, worker)
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: worker.Name + "-stuck", Namespace: f.review.Namespace,
			Labels: map[string]string{"batch.kubernetes.io/job-name": worker.Name}},
		Status: corev1.PodStatus{Phase: corev1.PodRunning},
	}
	bindTestPodToWorker(pod, worker)
	if err := f.kube.Create(context.Background(), pod); err != nil {
		t.Fatal(err)
	}
	worker.Status.Failed = 1
	worker.Status.Conditions = []batchv1.JobCondition{{Type: batchv1.JobFailed, Status: corev1.ConditionTrue, LastTransitionTime: metav1.NewTime(f.now)}}
	if err := f.kube.Status().Update(context.Background(), worker); err != nil {
		t.Fatal(err)
	}
	if _, err := f.reconciler.Reconcile(context.Background(), f.req); err != nil {
		t.Fatal(err)
	}
	f.reconciler.Now = func() time.Time {
		return f.now.Add(time.Duration(job.DefaultWorkerForensicHoldSeconds+1) * time.Second)
	}
	if _, err := f.reconciler.Reconcile(context.Background(), f.req); err != nil {
		t.Fatal(err)
	}
	released := f.worker(t)
	if hasTerminalOutcomeFinalizer(released) || released.Spec.TTLSecondsAfterFinished == nil || *released.Spec.TTLSecondsAfterFinished != 0 {
		t.Fatalf("worker past the hold: TTL %s finalizer=%v, want released", ttlString(released.Spec.TTLSecondsAfterFinished), hasTerminalOutcomeFinalizer(released))
	}
}

// The terminal release is the last chance to record an exit the Pod cache only
// showed late. The record must be durable before the Job's TTL leaves the
// forensic hold: if persisting it fails, the Job keeps its hold and finalizer.
func TestWorkerReleasePersistsALateRecordBeforeLoweringTheHold(t *testing.T) {
	t.Setenv(job.WorkerFailedTTLAfterFinishedEnv, "0")
	f := newTerminationFixture(t)
	worker := f.worker(t)
	assignFakeWorkerUID(t, f.kube, worker)
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name: worker.Name + "-late", Namespace: f.review.Namespace,
			Labels: map[string]string{"batch.kubernetes.io/job-name": worker.Name},
		},
		Status: corev1.PodStatus{
			Phase: corev1.PodRunning,
			ContainerStatuses: []corev1.ContainerStatus{{
				Name:  job.WorkerContainerName,
				State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{StartedAt: metav1.NewTime(f.now)}},
			}},
		},
	}
	bindTestPodToWorker(pod, worker)
	if err := f.kube.Create(context.Background(), pod); err != nil {
		t.Fatal(err)
	}
	worker.Status.Failed = 1
	worker.Status.Conditions = []batchv1.JobCondition{{Type: batchv1.JobFailed, Status: corev1.ConditionTrue, LastTransitionTime: metav1.NewTime(f.now)}}
	if err := f.kube.Status().Update(context.Background(), worker); err != nil {
		t.Fatal(err)
	}
	if _, err := f.reconciler.Reconcile(context.Background(), f.req); err != nil {
		t.Fatalf("observe failure: %v", err)
	}
	if storedReview(t, f.kube, f.req).Status.WorkerTermination != nil {
		t.Fatal("no record expected while the Pod exit is unreadable")
	}

	pod.Status.Phase = corev1.PodFailed
	pod.Status.ContainerStatuses[0].State = corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{
		ExitCode: 1, Reason: "Error", Message: "Error: late exit", FinishedAt: metav1.NewTime(f.now),
	}}
	if err := f.kube.Status().Update(context.Background(), pod); err != nil {
		t.Fatal(err)
	}

	statusFailure := errors.New("injected review status write failure")
	f.reconciler.Client = interceptor.NewClient(f.kube.(client.WithWatch), interceptor.Funcs{
		SubResourceUpdate: func(ctx context.Context, c client.Client, subResourceName string, obj client.Object, opts ...client.SubResourceUpdateOption) error {
			if _, ok := obj.(*reviewv1alpha2.PRReviewJob); ok {
				return statusFailure
			}
			return c.SubResource(subResourceName).Update(ctx, obj, opts...)
		},
	})
	if _, err := f.reconciler.Reconcile(context.Background(), f.req); !errors.Is(err, statusFailure) {
		t.Fatalf("release with a failing status write: err = %v, want the injected failure", err)
	}
	held := f.worker(t)
	if !hasTerminalOutcomeFinalizer(held) || held.Spec.TTLSecondsAfterFinished == nil || *held.Spec.TTLSecondsAfterFinished != job.DefaultWorkerForensicHoldSeconds {
		t.Fatalf("worker after a failed record write: TTL %s finalizer=%v, want the forensic hold kept",
			ttlString(held.Spec.TTLSecondsAfterFinished), hasTerminalOutcomeFinalizer(held))
	}

	f.reconciler.Client = f.kube
	if _, err := f.reconciler.Reconcile(context.Background(), f.req); err != nil {
		t.Fatalf("release: %v", err)
	}
	record := storedReview(t, f.kube, f.req).Status.WorkerTermination
	if record == nil || record.Message != "Error: late exit" {
		t.Fatalf("workerTermination = %+v, want the late exit recorded by the release", record)
	}
	released := f.worker(t)
	if hasTerminalOutcomeFinalizer(released) || released.Spec.TTLSecondsAfterFinished == nil || *released.Spec.TTLSecondsAfterFinished != 0 {
		t.Fatalf("worker after record: TTL %s finalizer=%v, want released at the failed TTL 0",
			ttlString(released.Spec.TTLSecondsAfterFinished), hasTerminalOutcomeFinalizer(released))
	}
}
