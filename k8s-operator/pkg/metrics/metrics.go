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
