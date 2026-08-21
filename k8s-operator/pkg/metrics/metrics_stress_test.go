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
	"math/rand"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	dto "github.com/prometheus/client_model/go"
	crmetrics "sigs.k8s.io/controller-runtime/pkg/metrics"

	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/metrics"
)

// TestEmpirical_MetricRegistration_100Goroutines_Concurrency stress tests RegisterMetrics
// with 100 parallel goroutines calling RegisterMetrics simultaneously at the exact same moment.
func TestEmpirical_MetricRegistration_100Goroutines_Concurrency(t *testing.T) {
	const numGoroutines = 100

	var wg sync.WaitGroup
	startSignal := make(chan struct{})
	errorsCount := int64(0)

	wg.Add(numGoroutines)
	for i := 0; i < numGoroutines; i++ {
		go func(id int) {
			defer wg.Done()
			<-startSignal // Wait for synchronized start signal

			defer func() {
				if r := recover(); r != nil {
					t.Errorf("Goroutine %d panicked during RegisterMetrics: %v", id, r)
					atomic.AddInt64(&errorsCount, 1)
				}
			}()

			metrics.RegisterMetrics()
		}(i)
	}

	// Release all 100 goroutines simultaneously
	close(startSignal)
	wg.Wait()

	if errorsCount > 0 {
		t.Fatalf("%d goroutines encountered errors/panics during registration", errorsCount)
	}

	// Verify metrics are properly registered in controller-runtime Registry
	metricFamilies, err := crmetrics.Registry.Gather()
	if err != nil {
		t.Fatalf("Failed to gather metrics from crmetrics.Registry: %v", err)
	}

	expectedMetrics := map[string]bool{
		"ct_operator_active_jobs":          false,
		"ct_operator_queued_jobs":          false,
		"ct_operator_job_duration_seconds": false,
	}

	for _, mf := range metricFamilies {
		if _, exists := expectedMetrics[mf.GetName()]; exists {
			expectedMetrics[mf.GetName()] = true
		}
	}

	for metricName, found := range expectedMetrics {
		if !found {
			t.Errorf("Expected metric %s was not found in crmetrics.Registry after concurrent registration", metricName)
		}
	}

	t.Logf("100 Goroutines concurrent metric registration verified successfully.")
}

// TestEmpirical_MetricsGathering_And_ConcurrentUpdates tests concurrent metric mutations and Gather calls
// across 100 goroutines to test thread-safety, race conditions, and metric gathering accuracy.
func TestEmpirical_MetricsGathering_And_ConcurrentUpdates(t *testing.T) {
	metrics.RegisterMetrics()

	const numGoroutines = 100
	const iterations = 50

	var wg sync.WaitGroup
	startSignal := make(chan struct{})
	var gatherFailures int64

	wg.Add(numGoroutines)

	for g := 0; g < numGoroutines; g++ {
		go func(gid int) {
			defer wg.Done()
			<-startSignal

			rnd := rand.New(rand.NewSource(time.Now().UnixNano() + int64(gid)))

			for i := 0; i < iterations; i++ {
				// Concurrent registration call (should be idempotent)
				metrics.RegisterMetrics()

				// Concurrent metric updates
				active := rnd.Intn(50)
				queued := rnd.Intn(100)
				metrics.UpdateQueueMetrics(active, queued)

				duration := float64(rnd.Intn(300)) + rnd.Float64()
				metrics.RecordJobDuration(duration)

				// Every 10 iterations, attempt metric gathering
				if i%10 == 0 {
					mfs, err := crmetrics.Registry.Gather()
					if err != nil {
						atomic.AddInt64(&gatherFailures, 1)
					} else {
						// Verify expected metric families are returned
						if findMetricByName(mfs, "ct_operator_active_jobs") == nil {
							atomic.AddInt64(&gatherFailures, 1)
						}
					}
				}
			}
		}(g)
	}

	close(startSignal)
	wg.Wait()

	if gatherFailures > 0 {
		t.Errorf("Encountered %d failures during concurrent metric gathering", gatherFailures)
	}

	// Final verification of registry state after high concurrency work
	mfs, err := crmetrics.Registry.Gather()
	if err != nil {
		t.Fatalf("Failed to gather metrics after concurrent stress test: %v", err)
	}

	activeMf := findMetricByName(mfs, "ct_operator_active_jobs")
	queuedMf := findMetricByName(mfs, "ct_operator_queued_jobs")
	durationMf := findMetricByName(mfs, "ct_operator_job_duration_seconds")

	if activeMf == nil || queuedMf == nil || durationMf == nil {
		t.Fatalf("One or more metric families missing from crmetrics.Registry")
	}

	t.Logf("Concurrent update & gather stress test passed. Active metric count: %d, Queued metric count: %d, Duration sample count: %d",
		len(activeMf.GetMetric()), len(queuedMf.GetMetric()), durationMf.GetMetric()[0].GetHistogram().GetSampleCount())
}

// TestEmpirical_MetricGathering_ValuesAndNames_Validation detailed check of metric names, types, and values.
func TestEmpirical_MetricGathering_ValuesAndNames_Validation(t *testing.T) {
	metrics.RegisterMetrics()

	// Set deterministic values
	testActive := 42
	testQueued := 17
	metrics.UpdateQueueMetrics(testActive, testQueued)

	testDurations := []float64{0.5, 2.3, 15.0, 45.8, 120.0}
	for _, d := range testDurations {
		metrics.RecordJobDuration(d)
	}

	// Gather metrics from crmetrics.Registry
	metricFamilies, err := crmetrics.Registry.Gather()
	if err != nil {
		t.Fatalf("crmetrics.Registry.Gather() returned error: %v", err)
	}

	// 1. Verify ct_operator_active_jobs
	activeMf := findMetricByName(metricFamilies, "ct_operator_active_jobs")
	if activeMf == nil {
		t.Fatalf("ct_operator_active_jobs metric family missing")
	}
	if activeMf.GetType() != dto.MetricType_GAUGE {
		t.Errorf("ct_operator_active_jobs expected type GAUGE, got %v", activeMf.GetType())
	}
	if len(activeMf.GetMetric()) == 0 {
		t.Fatalf("ct_operator_active_jobs has no metrics")
	}
	if val := activeMf.GetMetric()[0].GetGauge().GetValue(); val != float64(testActive) {
		t.Errorf("ct_operator_active_jobs expected value %f, got %f", float64(testActive), val)
	}

	// 2. Verify ct_operator_queued_jobs
	queuedMf := findMetricByName(metricFamilies, "ct_operator_queued_jobs")
	if queuedMf == nil {
		t.Fatalf("ct_operator_queued_jobs metric family missing")
	}
	if queuedMf.GetType() != dto.MetricType_GAUGE {
		t.Errorf("ct_operator_queued_jobs expected type GAUGE, got %v", queuedMf.GetType())
	}
	if len(queuedMf.GetMetric()) == 0 {
		t.Fatalf("ct_operator_queued_jobs has no metrics")
	}
	if val := queuedMf.GetMetric()[0].GetGauge().GetValue(); val != float64(testQueued) {
		t.Errorf("ct_operator_queued_jobs expected value %f, got %f", float64(testQueued), val)
	}

	// 3. Verify ct_operator_job_duration_seconds
	durationMf := findMetricByName(metricFamilies, "ct_operator_job_duration_seconds")
	if durationMf == nil {
		t.Fatalf("ct_operator_job_duration_seconds metric family missing")
	}
	if durationMf.GetType() != dto.MetricType_HISTOGRAM {
		t.Errorf("ct_operator_job_duration_seconds expected type HISTOGRAM, got %v", durationMf.GetType())
	}
	if len(durationMf.GetMetric()) == 0 {
		t.Fatalf("ct_operator_job_duration_seconds has no metrics")
	}
	hist := durationMf.GetMetric()[0].GetHistogram()
	if hist.GetSampleCount() < uint64(len(testDurations)) {
		t.Errorf("ct_operator_job_duration_seconds expected sample count >= %d, got %d", len(testDurations), hist.GetSampleCount())
	}

	t.Logf("Metric names, types, and values validated successfully via crmetrics.Registry.Gather()")
}
