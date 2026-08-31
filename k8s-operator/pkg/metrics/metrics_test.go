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

package metrics_test

import (
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
	dto "github.com/prometheus/client_model/go"
	crmetrics "sigs.k8s.io/controller-runtime/pkg/metrics"

	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/metrics"
)

func TestRecordDispatchTimingRecordsAvailableLifecycleDurations(t *testing.T) {
	received := time.Unix(1_700_000_000, 0).UTC()
	jobCreated := received.Add(3 * time.Second)
	completed := jobCreated.Add(7 * time.Second)
	deadline := received.Add(15 * time.Minute)

	beforeJob := histogramSampleCount(t, "ct_operator_webhook_to_job_duration_seconds")
	beforeTotal := histogramSampleCount(t, "ct_operator_webhook_to_completion_duration_seconds")
	beforeDeadline := testutil.ToFloat64(metrics.DeadlineMisses)

	metrics.RecordDispatchTiming(metrics.DispatchTiming{
		ReceivedAt:       received,
		JobCreatedAt:     jobCreated,
		CompletedAt:      completed,
		TerminalDeadline: deadline,
	})

	if got := histogramSampleCount(t, "ct_operator_webhook_to_job_duration_seconds"); got != beforeJob+1 {
		t.Fatalf("webhook-to-job histogram count = %d, want %d", got, beforeJob+1)
	}
	if got := histogramSampleCount(t, "ct_operator_webhook_to_completion_duration_seconds"); got != beforeTotal+1 {
		t.Fatalf("webhook-to-completion histogram count = %d, want %d", got, beforeTotal+1)
	}
	if got := testutil.ToFloat64(metrics.DeadlineMisses); got != beforeDeadline {
		t.Fatalf("deadline misses = %f, want %f", got, beforeDeadline)
	}
}

func TestRecordDispatchTimingRejectsNonMonotonicLifecycle(t *testing.T) {
	received := time.Unix(1_700_000_000, 0).UTC()
	beforeJob := histogramSampleCount(t, "ct_operator_webhook_to_job_duration_seconds")
	beforeTotal := histogramSampleCount(t, "ct_operator_webhook_to_completion_duration_seconds")

	metrics.RecordDispatchTiming(metrics.DispatchTiming{
		ReceivedAt:       received,
		JobCreatedAt:     received.Add(-time.Second),
		CompletedAt:      received.Add(time.Second),
		TerminalDeadline: received.Add(15 * time.Minute),
	})

	if got := histogramSampleCount(t, "ct_operator_webhook_to_job_duration_seconds"); got != beforeJob {
		t.Fatalf("invalid timing changed webhook-to-job histogram count to %d", got)
	}
	if got := histogramSampleCount(t, "ct_operator_webhook_to_completion_duration_seconds"); got != beforeTotal {
		t.Fatalf("invalid timing changed webhook-to-completion histogram count to %d", got)
	}
}

func TestRecordDispatchTimingCountsDeadlineMiss(t *testing.T) {
	received := time.Unix(1_700_000_000, 0).UTC()
	before := testutil.ToFloat64(metrics.DeadlineMisses)

	metrics.RecordDispatchTiming(metrics.DispatchTiming{
		ReceivedAt:       received,
		CompletedAt:      received.Add(16 * time.Minute),
		TerminalDeadline: received.Add(15 * time.Minute),
	})

	if got := testutil.ToFloat64(metrics.DeadlineMisses); got != before+1 {
		t.Fatalf("deadline misses = %f, want %f", got, before+1)
	}
}

func histogramSampleCount(t *testing.T, name string) uint64 {
	t.Helper()
	metrics.RegisterMetrics()
	metricFamilies, err := crmetrics.Registry.Gather()
	if err != nil {
		t.Fatalf("gather metrics: %v", err)
	}
	for _, family := range metricFamilies {
		if family.GetName() != name {
			continue
		}
		if len(family.GetMetric()) == 0 || family.GetMetric()[0].GetHistogram() == nil {
			return 0
		}
		return family.GetMetric()[0].GetHistogram().GetSampleCount()
	}
	return 0
}

func TestRegisterMetrics(t *testing.T) {
	// Call RegisterMetrics multiple times to verify idempotency and no panics
	metrics.RegisterMetrics()
	metrics.RegisterMetrics()
}

func TestUpdateQueueMetrics(t *testing.T) {
	metrics.RegisterMetrics()

	activeVal := 3
	queuedVal := 7

	metrics.UpdateQueueMetrics(activeVal, queuedVal)

	metricFamilies, err := crmetrics.Registry.Gather()
	if err != nil {
		t.Fatalf("Failed to gather metrics: %v", err)
	}

	activeFound := false
	queuedFound := false

	for _, mf := range metricFamilies {
		if mf.GetName() == "ct_operator_active_jobs" {
			activeFound = true
			if len(mf.GetMetric()) > 0 {
				val := mf.GetMetric()[0].GetGauge().GetValue()
				if val != float64(activeVal) {
					t.Errorf("ct_operator_active_jobs expected %d, got %f", activeVal, val)
				}
			}
		}
		if mf.GetName() == "ct_operator_queued_jobs" {
			queuedFound = true
			if len(mf.GetMetric()) > 0 {
				val := mf.GetMetric()[0].GetGauge().GetValue()
				if val != float64(queuedVal) {
					t.Errorf("ct_operator_queued_jobs expected %d, got %f", queuedVal, val)
				}
			}
		}
	}

	if !activeFound {
		t.Errorf("ct_operator_active_jobs metric not found in registry")
	}
	if !queuedFound {
		t.Errorf("ct_operator_queued_jobs metric not found in registry")
	}
}

func TestRecordJobDuration(t *testing.T) {
	metrics.RegisterMetrics()

	// Record valid positive duration
	metrics.RecordJobDuration(45.5)

	// Record negative duration (should be ignored)
	metrics.RecordJobDuration(-10.0)

	metricFamilies, err := crmetrics.Registry.Gather()
	if err != nil {
		t.Fatalf("Failed to gather metrics: %v", err)
	}

	found := false
	for _, mf := range metricFamilies {
		if mf.GetName() == "ct_operator_job_duration_seconds" {
			found = true
			if len(mf.GetMetric()) > 0 {
				h := mf.GetMetric()[0].GetHistogram()
				if h.GetSampleCount() == 0 {
					t.Errorf("Expected sample count > 0 for ct_operator_job_duration_seconds")
				}
				if h.GetSampleSum() < 45.5 {
					t.Errorf("Expected sample sum >= 45.5, got %f", h.GetSampleSum())
				}
			}
		}
	}

	if !found {
		t.Errorf("ct_operator_job_duration_seconds metric not found in registry")
	}
}

func findMetricByName(families []*dto.MetricFamily, name string) *dto.MetricFamily {
	for _, mf := range families {
		if mf.GetName() == name {
			return mf
		}
	}
	return nil
}
