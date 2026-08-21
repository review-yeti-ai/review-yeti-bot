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

package queue_test

import (
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/types"

	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/queue"
)

// TestEmpirical_100Goroutines_HighLoad_Contention stress-tests QueueManager with 100 goroutines
// continuously acquiring and releasing slots under heavy lock contention and verifies active count invariant.
func TestEmpirical_100Goroutines_HighLoad_Contention(t *testing.T) {
	maxCapacity := 5
	qm := queue.NewQueueManager(maxCapacity)
	numGoroutines := 100
	iterationsPerGoroutine := 100

	var wg sync.WaitGroup
	wg.Add(numGoroutines)

	var invariantViolations int64
	stopDrain := make(chan struct{})

	// Background worker draining events to prevent event channel overflow deadlock
	go func() {
		for {
			select {
			case <-stopDrain:
				return
			case <-qm.EventChannel():
			}
		}
	}()

	for g := 0; g < numGoroutines; g++ {
		go func(gid int) {
			defer wg.Done()

			for i := 0; i < iterationsPerGoroutine; i++ {
				jKey := types.NamespacedName{
					Namespace: "stress-ns",
					Name:      fmt.Sprintf("job-g%d-i%d", gid, i),
				}

				allowed, queued := qm.AcquireSlot(jKey)
				activeCount := qm.GetActiveCount()

				if activeCount > maxCapacity {
					atomic.AddInt64(&invariantViolations, 1)
				}

				if allowed {
					if queued {
						t.Errorf("Goroutine %d: job %s returned allowed=true AND queued=true", gid, jKey.Name)
					}
					// Simulate brief work
					time.Sleep(10 * time.Microsecond)
					qm.ReleaseSlot(jKey)
				} else {
					if !queued {
						t.Errorf("Goroutine %d: job %s returned allowed=false AND queued=false", gid, jKey.Name)
					}
					// Randomly remove or leave in queue
					if i%2 == 0 {
						qm.RemoveJob(jKey)
					}
				}

				// Exercise read methods concurrently
				_ = qm.GetActiveJobs()
				_ = qm.GetQueuedJobs()
				_ = qm.GetQueuedCount()
				_ = qm.IsActive(jKey)
				_ = qm.IsQueued(jKey)
			}
		}(g)
	}

	wg.Wait()
	close(stopDrain)

	if invariantViolations > 0 {
		t.Errorf("INVARIANT VIOLATION: GetActiveCount exceeded maxCapacity (%d) %d times!", maxCapacity, invariantViolations)
	}

	t.Logf("100 Goroutines high-load test completed successfully. Active: %d, Queued: %d", qm.GetActiveCount(), qm.GetQueuedCount())
}

// TestEmpirical_DuplicateReleaseSlot_CapacityLeak checks if calling ReleaseSlot on an inactive job
// improperly pops a queued job and exceeds max concurrency.
func TestEmpirical_DuplicateReleaseSlot_CapacityLeak(t *testing.T) {
	qm := queue.NewQueueManager(2)

	j1 := types.NamespacedName{Namespace: "default", Name: "active-1"}
	j2 := types.NamespacedName{Namespace: "default", Name: "active-2"}
	jQueued := types.NamespacedName{Namespace: "default", Name: "queued-3"}
	jInactive := types.NamespacedName{Namespace: "default", Name: "already-completed"}

	qm.AcquireSlot(j1)
	qm.AcquireSlot(j2)
	qm.AcquireSlot(jQueued) // queued

	if qm.GetActiveCount() != 2 {
		t.Fatalf("Expected active count 2, got %d", qm.GetActiveCount())
	}
	if qm.GetQueuedCount() != 1 {
		t.Fatalf("Expected queued count 1, got %d", qm.GetQueuedCount())
	}

	// Call ReleaseSlot on a job that is NOT currently active (e.g. duplicate reconcile of a completed job)
	qm.ReleaseSlot(jInactive)

	// Check active count!
	activeCount := qm.GetActiveCount()
	if activeCount > 2 {
		t.Errorf("BUG DISCOVERED: Calling ReleaseSlot on inactive job popped queued job and inflated active count to %d (max: 2)!", activeCount)
	}
}

// TestEmpirical_DuplicateReconcile_ReleaseSlot_DoubleRelease checks repeated ReleaseSlot calls on same active job.
func TestEmpirical_DuplicateReleaseSlot_SameJobTwice(t *testing.T) {
	qm := queue.NewQueueManager(2)

	j1 := types.NamespacedName{Namespace: "default", Name: "active-1"}
	j2 := types.NamespacedName{Namespace: "default", Name: "active-2"}
	jQueued := types.NamespacedName{Namespace: "default", Name: "queued-3"}

	qm.AcquireSlot(j1)
	qm.AcquireSlot(j2)
	qm.AcquireSlot(jQueued)

	// First release of j1 -> pops jQueued into active
	qm.ReleaseSlot(j1)

	if qm.GetActiveCount() != 2 {
		t.Errorf("After first release, expected active count 2, got %d", qm.GetActiveCount())
	}
	if qm.IsActive(jQueued) != true {
		t.Errorf("jQueued should be promoted to active")
	}

	// Second release of j1 (duplicate event) -> j1 is no longer active!
	qm.ReleaseSlot(j1)

	if qm.GetActiveCount() > 2 {
		t.Errorf("BUG DISCOVERED: Duplicate ReleaseSlot on j1 inflated active count to %d!", qm.GetActiveCount())
	}
}

// TestEmpirical_200Goroutines_QueueManager_HighConcurrency_RaceStress stress tests QueueManager
// with 200 concurrent goroutines executing 20,000 random queue state transitions under heavy contention.
func TestEmpirical_200Goroutines_QueueManager_HighConcurrency_RaceStress(t *testing.T) {
	maxCapacity := 10
	qm := queue.NewQueueManager(maxCapacity)
	numGoroutines := 200
	iterationsPerGoroutine := 100

	var wg sync.WaitGroup
	wg.Add(numGoroutines)

	var invariantViolations int64
	stopDrain := make(chan struct{})

	go func() {
		for {
			select {
			case <-stopDrain:
				return
			case <-qm.EventChannel():
			}
		}
	}()

	for g := 0; g < numGoroutines; g++ {
		go func(gid int) {
			defer wg.Done()

			for i := 0; i < iterationsPerGoroutine; i++ {
				jKey := types.NamespacedName{
					Namespace: "stress-200-ns",
					Name:      fmt.Sprintf("job-g%d-i%d", gid, i),
				}

				allowed, queued := qm.AcquireSlot(jKey)
				activeCount := qm.GetActiveCount()

				if activeCount > maxCapacity {
					atomic.AddInt64(&invariantViolations, 1)
				}

				if allowed {
					if queued {
						t.Errorf("Goroutine %d: job %s allowed=true AND queued=true", gid, jKey.Name)
					}
					time.Sleep(5 * time.Microsecond)
					qm.ReleaseSlot(jKey)
				} else {
					if !queued {
						t.Errorf("Goroutine %d: job %s allowed=false AND queued=false", gid, jKey.Name)
					}
					if i%3 == 0 {
						qm.RemoveJob(jKey)
					}
				}

				// Concurrent inspection methods
				_ = qm.GetActiveJobs()
				_ = qm.GetQueuedJobs()
				_ = qm.GetQueuedCount()
				_ = qm.IsActive(jKey)
				_ = qm.IsQueued(jKey)
			}
		}(g)
	}

	wg.Wait()
	close(stopDrain)

	if invariantViolations > 0 {
		t.Errorf("INVARIANT VIOLATION: GetActiveCount exceeded maxCapacity (%d) %d times!", maxCapacity, invariantViolations)
	}

	t.Logf("200 Goroutines stress test passed. Active: %d, Queued: %d", qm.GetActiveCount(), qm.GetQueuedCount())
}

// TestEmpirical_QueueManager_EventChannel_OverflowStress tests non-blocking event channel writes under saturation.
func TestEmpirical_QueueManager_EventChannel_OverflowStress(t *testing.T) {
	qm := queue.NewQueueManager(1)
	// Fill active capacity
	j0 := types.NamespacedName{Namespace: "default", Name: "active-0"}
	qm.AcquireSlot(j0)

	// Queue 150 jobs (exceeds channel capacity of 100)
	for i := 1; i <= 150; i++ {
		jKey := types.NamespacedName{Namespace: "default", Name: fmt.Sprintf("queued-%d", i)}
		qm.AcquireSlot(jKey)
	}

	if qm.GetQueuedCount() != 150 {
		t.Fatalf("Expected 150 queued jobs, got %d", qm.GetQueuedCount())
	}

	// Release jobs without draining event channel immediately to saturate event buffer
	// ReleaseSlot should perform non-blocking send without deadlocking or panicking
	done := make(chan struct{})
	go func() {
		for i := 0; i < 150; i++ {
			activeJobs := qm.GetActiveJobs()
			if len(activeJobs) > 0 {
				qm.ReleaseSlot(activeJobs[0])
			}
		}
		close(done)
	}()

	select {
	case <-done:
		t.Log("Event channel overflow test finished without deadlock.")
	case <-time.After(5 * time.Second):
		t.Fatal("DEADLOCK DETECTED during event channel overflow!")
	}
}
