package controllers

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	reviewv1alpha2 "github.com/review-yeti-ai/review-yeti-bot/k8s-operator/api/v1alpha2"
	"github.com/review-yeti-ai/review-yeti-bot/k8s-operator/pkg/job"
	operatorMetrics "github.com/review-yeti-ai/review-yeti-bot/k8s-operator/pkg/metrics"
)

func TestWorkerMetricsSnapshotCountsFullQueueAndRecentFailures(t *testing.T) {
	now := time.Unix(1_790_000_000, 0)
	scheme := runtime.NewScheme()
	if err := batchv1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	if err := reviewv1alpha2.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	worker := func(name, component string, failedAt time.Time) *batchv1.Job {
		w := &batchv1.Job{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: job.Namespace,
			Labels: map[string]string{"review-yeti.ai/component": component}}}
		if !failedAt.IsZero() {
			w.Status.Failed = 1
			w.Status.Conditions = []batchv1.JobCondition{{Type: batchv1.JobFailed, Status: corev1.ConditionTrue, LastTransitionTime: metav1.NewTime(failedAt)}}
		}
		return w
	}
	review := func(name string, deadline time.Time) *reviewv1alpha2.PRReviewJob {
		return &reviewv1alpha2.PRReviewJob{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: job.Namespace},
			Spec:   reviewv1alpha2.PRReviewJobSpec{ReceivedAt: metav1.NewTime(deadline.Add(-30 * time.Minute)), TerminalDeadline: metav1.NewTime(deadline)},
			Status: reviewv1alpha2.PRReviewJobStatus{Phase: reviewv1alpha2.PhaseQueued}}
	}
	active := worker("active", job.PublishingWorkerComponent, time.Time{})
	recent := worker("recent", job.ReceiptOnlyWorkerComponent, now.Add(-time.Minute))
	old := worker("old", job.PublishingWorkerComponent, now.Add(-time.Hour))
	foreign := worker("foreign", "unrelated", now.Add(-time.Minute))
	future := worker("future", job.PublishingWorkerComponent, now.Add(time.Minute))
	falseFailure := worker("false-failure", job.PublishingWorkerComponent, now.Add(-time.Minute))
	falseFailure.Status.Conditions[0].Status = corev1.ConditionFalse
	succeeded := worker("succeeded", job.PublishingWorkerComponent, time.Time{})
	succeeded.Status.Succeeded = 1
	foreignNamespace := worker("foreign-namespace", job.PublishingWorkerComponent, now.Add(-time.Minute))
	foreignNamespace.Namespace = "unrelated"
	resuming := review("resuming", now.Add(time.Minute))
	resuming.Status.Phase = reviewv1alpha2.PhaseAwaitingResumption
	resuming.Status.JobName = "resuming-worker"
	resuming.Annotations = map[string]string{"review-yeti.ai/resumed": "true"}
	running := review("running", now.Add(time.Minute))
	running.Status.Phase = reviewv1alpha2.PhaseRunning
	running.Status.JobName = "running-worker"
	unrequested := review("unrequested-resumption", now.Add(time.Minute))
	unrequested.Status.Phase = reviewv1alpha2.PhaseAwaitingResumption
	unrequested.Status.JobName = "unrequested-worker"
	kube := fake.NewClientBuilder().WithScheme(scheme).WithIndex(&reviewv1alpha2.PRReviewJob{}, queueMetricsCandidateField, queueMetricsCandidateValues).WithObjects(active, recent, old, foreign, future, falseFailure, succeeded, foreignNamespace,
		resuming, running, unrequested, review("queued", now.Add(time.Minute)), review("expired", now.Add(-time.Minute))).Build()
	c := &workerMetricsCollector{reader: kube}
	for i := 0; i < 2; i++ {
		if err := c.collect(context.Background(), now); err != nil {
			t.Fatal(err)
		}
		if got := testutil.ToFloat64(operatorMetrics.ActiveJobs); got != 1 {
			t.Fatalf("active=%v", got)
		}
		if got := testutil.ToFloat64(operatorMetrics.QueuedJobs); got != 2 {
			t.Fatalf("queued=%v", got)
		}
		if got := testutil.ToFloat64(operatorMetrics.RecentFailedJobs); got != 1 {
			t.Fatalf("recent failures=%v", got)
		}
		if got := testutil.ToFloat64(operatorMetrics.SnapshotTimestamp); got != float64(now.Unix()) {
			t.Fatalf("snapshot timestamp=%v", got)
		}
	}
	if err := kube.Delete(context.Background(), active); err != nil {
		t.Fatal(err)
	}
	if err := kube.Delete(context.Background(), resuming); err != nil {
		t.Fatal(err)
	}
	if err := c.collect(context.Background(), now.Add(11*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if got := testutil.ToFloat64(operatorMetrics.SnapshotTimestamp); got != float64(now.Add(11*time.Minute).Unix()) {
		t.Fatalf("updated snapshot timestamp=%v", got)
	}
	if got := testutil.ToFloat64(operatorMetrics.ActiveJobs); got != 0 {
		t.Fatalf("active after deletion=%v", got)
	}
	if got := testutil.ToFloat64(operatorMetrics.QueuedJobs); got != 0 {
		t.Fatalf("queued after expiry=%v", got)
	}
	if got := testutil.ToFloat64(operatorMetrics.RecentFailedJobs); got != 0 {
		t.Fatalf("expired failures=%v", got)
	}
}

type failedMetricsReader struct {
	client.Reader
	failReviewsOnly bool
}

func (r failedMetricsReader) List(_ context.Context, list client.ObjectList, _ ...client.ListOption) error {
	if _, jobs := list.(*batchv1.JobList); jobs && r.failReviewsOnly {
		return nil
	}
	return errors.New("cache unavailable")
}

func TestWorkerMetricsReadFailureDoesNotReportAnEmptyQueue(t *testing.T) {
	for _, failReviewsOnly := range []bool{false, true} {
		operatorMetrics.UpdateQueueMetrics(10, 2)
		operatorMetrics.RecentFailedJobs.Set(3)
		operatorMetrics.SnapshotTimestamp.Set(123)
		c := &workerMetricsCollector{reader: failedMetricsReader{failReviewsOnly: failReviewsOnly}}
		if err := c.collect(context.Background(), time.Now()); err == nil {
			t.Fatal("expected failure")
		}
		if got := testutil.ToFloat64(operatorMetrics.ActiveJobs); got != 10 {
			t.Fatalf("active=%v", got)
		}
		if got := testutil.ToFloat64(operatorMetrics.QueuedJobs); got != 2 {
			t.Fatalf("queued=%v", got)
		}
		if got := testutil.ToFloat64(operatorMetrics.RecentFailedJobs); got != 3 {
			t.Fatalf("recent failures=%v", got)
		}
		if got := testutil.ToFloat64(operatorMetrics.SnapshotTimestamp); got != 123 {
			t.Fatalf("timestamp=%v", got)
		}
	}
}

func TestQueueMetricsIndexExcludesRetainedAndRunningReviews(t *testing.T) {
	scheme := runtime.NewScheme()
	if err := reviewv1alpha2.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	kube := fake.NewClientBuilder().WithScheme(scheme).WithIndex(&reviewv1alpha2.PRReviewJob{}, queueMetricsCandidateField, queueMetricsCandidateValues).Build()
	for i := 0; i < 100; i++ {
		review := &reviewv1alpha2.PRReviewJob{ObjectMeta: metav1.ObjectMeta{Name: fmt.Sprintf("terminal-%d", i), Namespace: job.Namespace}, Status: reviewv1alpha2.PRReviewJobStatus{Phase: reviewv1alpha2.PhaseFailed}}
		if err := kube.Create(context.Background(), review); err != nil {
			t.Fatal(err)
		}
	}
	queued := &reviewv1alpha2.PRReviewJob{ObjectMeta: metav1.ObjectMeta{Name: "queued", Namespace: job.Namespace}, Status: reviewv1alpha2.PRReviewJobStatus{Phase: reviewv1alpha2.PhaseQueued}}
	running := &reviewv1alpha2.PRReviewJob{ObjectMeta: metav1.ObjectMeta{Name: "running", Namespace: job.Namespace}, Status: reviewv1alpha2.PRReviewJobStatus{Phase: reviewv1alpha2.PhaseRunning, JobName: "running-worker"}}
	for _, review := range []*reviewv1alpha2.PRReviewJob{queued, running} {
		if err := kube.Create(context.Background(), review); err != nil {
			t.Fatal(err)
		}
	}
	var candidates reviewv1alpha2.PRReviewJobList
	if err := kube.List(context.Background(), &candidates, client.InNamespace(job.Namespace), client.MatchingFields{queueMetricsCandidateField: "true"}); err != nil {
		t.Fatal(err)
	}
	if len(candidates.Items) != 1 || candidates.Items[0].Name != "queued" {
		t.Fatalf("expected only queued candidate, got %d", len(candidates.Items))
	}
}
