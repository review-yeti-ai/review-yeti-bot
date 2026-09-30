package controllers

import (
	"context"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/selection"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/log"

	reviewv1alpha2 "github.com/calltelemetry/ct-review-bot/k8s-operator/api/v1alpha2"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/job"
	operatorMetrics "github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/metrics"
)

// Cache-only index; eligibility that depends on the clock is checked at collect
// time, not when indexing. Terminal and already running reviews need no copy.
const queueMetricsCandidateField = "review-yeti.ai/queue-metrics-candidate"

func queueMetricsCandidateValues(object client.Object) []string {
	review, ok := object.(*reviewv1alpha2.PRReviewJob)
	if !ok || isTerminalPhase(review.Status.Phase) || (workerCreationWasAttempted(review) && !isAwaitingResumption(review)) {
		return nil
	}
	return []string{"true"}
}

// Use the manager cache independently of admission. A full queue short-circuits
// admission's review list; terminal-only traffic must also refresh the gauges.
// This process watches the one namespace accepted by the worker contract.
type workerMetricsCollector struct{ reader client.Reader }

func (*workerMetricsCollector) NeedLeaderElection() bool { return true }

func (c *workerMetricsCollector) Start(ctx context.Context) error {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		if err := c.collect(ctx, time.Now()); err != nil {
			log.FromContext(ctx).Error(err, "unable to refresh v1alpha2 worker metrics")
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}

func (c *workerMetricsCollector) collect(ctx context.Context, now time.Time) error {
	component, err := labels.NewRequirement("review-yeti.ai/component", selection.In,
		[]string{job.ReceiptOnlyWorkerComponent, job.PublishingWorkerComponent})
	if err != nil {
		return err
	}
	var jobs batchv1.JobList
	if err := c.reader.List(ctx, &jobs, client.InNamespace(job.Namespace),
		client.MatchingLabelsSelector{Selector: labels.NewSelector().Add(*component)}); err != nil {
		return err
	}
	var reviews reviewv1alpha2.PRReviewJobList
	if err := c.reader.List(ctx, &reviews, client.InNamespace(job.Namespace), client.MatchingFields{queueMetricsCandidateField: "true"}); err != nil {
		return err
	}
	active, queued, failed := 0, 0, 0
	for i := range jobs.Items {
		worker := &jobs.Items[i]
		if worker.Status.Succeeded == 0 && worker.Status.Failed == 0 {
			active++
		}
		for _, condition := range worker.Status.Conditions {
			if condition.Type == batchv1.JobFailed && condition.Status == corev1.ConditionTrue &&
				!condition.LastTransitionTime.IsZero() && !condition.LastTransitionTime.After(now) &&
				condition.LastTransitionTime.Time.After(now.Add(-10*time.Minute)) {
				failed++
				break
			}
		}
	}
	for i := range reviews.Items {
		candidate := &reviews.Items[i]
		if validWorkerAdmissionCandidate(candidate, now) &&
			(!workerCreationWasAttempted(candidate) || isAwaitingResumption(candidate)) {
			queued++
		}
	}
	// A failed read retains the last values and timestamp instead of emitting a
	// false empty queue. Alert on timestamp staleness to distinguish that state.
	operatorMetrics.UpdateQueueMetrics(active, queued)
	operatorMetrics.RecentFailedJobs.Set(float64(failed))
	operatorMetrics.SnapshotTimestamp.Set(float64(now.Unix()))
	return nil
}
