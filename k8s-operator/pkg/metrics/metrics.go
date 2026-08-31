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

package metrics

import (
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	crmetrics "sigs.k8s.io/controller-runtime/pkg/metrics"
)

var (
	// ActiveJobs tracks the number of currently active PR review jobs.
	ActiveJobs = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "ct_operator_active_jobs",
		Help: "Number of currently active PR review jobs.",
	})

	// QueuedJobs tracks the number of currently queued PR review jobs.
	QueuedJobs = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "ct_operator_queued_jobs",
		Help: "Number of currently queued PR review jobs waiting for concurrency slots.",
	})

	// JobDurationSeconds tracks the total duration of PR review jobs in seconds.
	JobDurationSeconds = prometheus.NewHistogram(prometheus.HistogramOpts{
		Name:    "ct_operator_job_duration_seconds",
		Help:    "Duration of PR review jobs in seconds from start to completion.",
		Buckets: []float64{1, 5, 10, 30, 60, 120, 300, 600, 1800, 3600},
	})

	// WebhookToJobDurationSeconds tracks the time from durable review receipt
	// to creation of the receipt-only worker Job.
	WebhookToJobDurationSeconds = prometheus.NewHistogram(prometheus.HistogramOpts{
		Name:    "ct_operator_webhook_to_job_duration_seconds",
		Help:    "Duration from review receipt to worker Job creation in seconds.",
		Buckets: []float64{0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 900},
	})

	// WebhookToCompletionDurationSeconds tracks the time from durable review
	// receipt to a terminal worker outcome.
	WebhookToCompletionDurationSeconds = prometheus.NewHistogram(prometheus.HistogramOpts{
		Name:    "ct_operator_webhook_to_completion_duration_seconds",
		Help:    "Duration from review receipt to terminal outcome in seconds.",
		Buckets: []float64{1, 5, 10, 30, 60, 120, 300, 600, 900, 1800},
	})

	// DeadlineMisses counts terminal outcomes recorded after the immutable
	// fifteen-minute review deadline.
	DeadlineMisses = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "ct_operator_deadline_misses_total",
		Help: "Number of review outcomes recorded after the fifteen-minute deadline.",
	})

	registerOnce sync.Once
)

// RegisterMetrics registers custom Prometheus metrics with controller-runtime's metrics Registry.
// Safe for repeated invocation.
func RegisterMetrics() {
	registerOnce.Do(func() {
		crmetrics.Registry.MustRegister(
			ActiveJobs,
			QueuedJobs,
			JobDurationSeconds,
			WebhookToJobDurationSeconds,
			WebhookToCompletionDurationSeconds,
			DeadlineMisses,
		)
	})
}

// UpdateQueueMetrics sets gauge values based on current QueueManager counts.
func UpdateQueueMetrics(activeCount, queuedCount int) {
	ActiveJobs.Set(float64(activeCount))
	QueuedJobs.Set(float64(queuedCount))
}

// RecordJobDuration records job execution duration in seconds.
func RecordJobDuration(seconds float64) {
	if seconds >= 0 {
		JobDurationSeconds.Observe(seconds)
	}
}

// DispatchTiming contains the lifecycle timestamps the operator can observe
// without receiving provider credentials, prompts, or review contents.
// Zero timestamps are allowed for stages that have not happened yet.
type DispatchTiming struct {
	ReceivedAt       time.Time
	JobCreatedAt     time.Time
	CompletedAt      time.Time
	TerminalDeadline time.Time
}

// RecordDispatchTiming records every valid lifecycle span available in timing.
// A non-monotonic record is ignored in full so a malformed receipt cannot
// create a misleading partial histogram sample.
func RecordDispatchTiming(timing DispatchTiming) {
	if timing.ReceivedAt.IsZero() {
		return
	}
	if !timing.JobCreatedAt.IsZero() && timing.JobCreatedAt.Before(timing.ReceivedAt) {
		return
	}
	if !timing.CompletedAt.IsZero() && timing.CompletedAt.Before(timing.ReceivedAt) {
		return
	}
	if !timing.JobCreatedAt.IsZero() && !timing.CompletedAt.IsZero() && timing.CompletedAt.Before(timing.JobCreatedAt) {
		return
	}
	if !timing.TerminalDeadline.IsZero() && timing.TerminalDeadline.Before(timing.ReceivedAt) {
		return
	}

	if !timing.JobCreatedAt.IsZero() {
		WebhookToJobDurationSeconds.Observe(timing.JobCreatedAt.Sub(timing.ReceivedAt).Seconds())
	}
	if !timing.CompletedAt.IsZero() {
		WebhookToCompletionDurationSeconds.Observe(timing.CompletedAt.Sub(timing.ReceivedAt).Seconds())
		if !timing.TerminalDeadline.IsZero() && timing.CompletedAt.After(timing.TerminalDeadline) {
			DeadlineMisses.Inc()
		}
	}
	if !timing.JobCreatedAt.IsZero() && !timing.CompletedAt.IsZero() {
		RecordJobDuration(timing.CompletedAt.Sub(timing.JobCreatedAt).Seconds())
	}
}
