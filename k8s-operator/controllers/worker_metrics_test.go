package controllers

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	reviewv1alpha2 "github.com/calltelemetry/ct-review-bot/k8s-operator/api/v1alpha2"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/job"
	operatorMetrics "github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/metrics"
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
	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(active, recent, old, foreign,
		review("queued", now.Add(time.Minute)), review("expired", now.Add(-time.Minute))).Build()
	c := &workerMetricsCollector{reader: kube}
	for i := 0; i < 2; i++ {
		if err := c.collect(context.Background(), now); err != nil {
			t.Fatal(err)
		}
		if got := testutil.ToFloat64(operatorMetrics.ActiveJobs); got != 1 {
			t.Fatalf("active=%v", got)
		}
		if got := testutil.ToFloat64(operatorMetrics.QueuedJobs); got != 1 {
			t.Fatalf("queued=%v", got)
		}
		if got := testutil.ToFloat64(operatorMetrics.RecentFailedJobs); got != 1 {
			t.Fatalf("recent failures=%v", got)
		}
	}
	if err := kube.Delete(context.Background(), active); err != nil {
		t.Fatal(err)
	}
	if err := c.collect(context.Background(), now.Add(11*time.Minute)); err != nil {
		t.Fatal(err)
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

type failedMetricsReader struct{ client.Reader }

func (failedMetricsReader) List(context.Context, client.ObjectList, ...client.ListOption) error {
	return errors.New("cache unavailable")
}

func TestWorkerMetricsReadFailureDoesNotReportAnEmptyQueue(t *testing.T) {
	operatorMetrics.UpdateQueueMetrics(10, 2)
	operatorMetrics.SnapshotTimestamp.Set(123)
	c := &workerMetricsCollector{reader: failedMetricsReader{}}
	if err := c.collect(context.Background(), time.Now()); err == nil {
		t.Fatal("expected failure")
	}
	if got := testutil.ToFloat64(operatorMetrics.ActiveJobs); got != 10 {
		t.Fatalf("active=%v", got)
	}
	if got := testutil.ToFloat64(operatorMetrics.QueuedJobs); got != 2 {
		t.Fatalf("queued=%v", got)
	}
	if got := testutil.ToFloat64(operatorMetrics.SnapshotTimestamp); got != 123 {
		t.Fatalf("timestamp=%v", got)
	}
}
