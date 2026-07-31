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
	"os"
	"sync"
	"testing"

	"k8s.io/apimachinery/pkg/types"

	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/queue"
)

func TestQueueManager_MaxConcurrencySlotAcquisition(t *testing.T) {
	qm := queue.NewQueueManager(3)
	if qm.MaxConcurrent() != 3 {
		t.Fatalf("Expected MaxConcurrent 3, got %d", qm.MaxConcurrent())
	}

	job1 := types.NamespacedName{Namespace: "default", Name: "job-1"}
	job2 := types.NamespacedName{Namespace: "default", Name: "job-2"}
	job3 := types.NamespacedName{Namespace: "default", Name: "job-3"}
	job4 := types.NamespacedName{Namespace: "default", Name: "job-4"}
	job5 := types.NamespacedName{Namespace: "default", Name: "job-5"}

	// Acquire 1-3: should be allowed
	for _, j := range []types.NamespacedName{job1, job2, job3} {
		allowed, queued := qm.AcquireSlot(j)
		if !allowed || queued {
			t.Errorf("Expected job %s to be allowed=true, queued=false, got allowed=%v, queued=%v", j.Name, allowed, queued)
		}
	}

	if qm.GetActiveCount() != 3 {
		t.Errorf("Expected ActiveCount=3, got %d", qm.GetActiveCount())
	}
	if qm.GetQueuedCount() != 0 {
		t.Errorf("Expected QueuedCount=0, got %d", qm.GetQueuedCount())
	}

	// Re-acquiring job1 when active should remain allowed=true, queued=false
	allowed, queued := qm.AcquireSlot(job1)
	if !allowed || queued {
		t.Errorf("Re-acquiring active job1 failed")
	}

	// Acquire 4-5: should be queued
	for _, j := range []types.NamespacedName{job4, job5} {
		allowed, queued := qm.AcquireSlot(j)
		if allowed || !queued {
			t.Errorf("Expected job %s to be allowed=false, queued=true, got allowed=%v, queued=%v", j.Name, allowed, queued)
		}
	}

	if qm.GetActiveCount() != 3 {
		t.Errorf("Expected ActiveCount=3, got %d", qm.GetActiveCount())
	}
	if qm.GetQueuedCount() != 2 {
		t.Errorf("Expected QueuedCount=2, got %d", qm.GetQueuedCount())
	}

	// Re-acquiring job4 when queued should remain allowed=false, queued=true without duplicating in queue
	allowed, queued = qm.AcquireSlot(job4)
	if allowed || !queued {
		t.Errorf("Re-acquiring queued job4 failed")
	}
	if qm.GetQueuedCount() != 2 {
		t.Errorf("Duplicate job added to queue! QueuedCount=%d", qm.GetQueuedCount())
	}

	// Verify IsActive & IsQueued
	if !qm.IsActive(job1) || !qm.IsActive(job2) || !qm.IsActive(job3) {
		t.Errorf("Expected jobs 1-3 to be active")
	}
	if !qm.IsQueued(job4) || !qm.IsQueued(job5) {
		t.Errorf("Expected jobs 4-5 to be queued")
	}
}

func TestQueueManager_FIFOAutoDispatchOnRelease(t *testing.T) {
	qm := queue.NewQueueManager(3)

	job1 := types.NamespacedName{Namespace: "default", Name: "job-1"}
	job2 := types.NamespacedName{Namespace: "default", Name: "job-2"}
	job3 := types.NamespacedName{Namespace: "default", Name: "job-3"}
	job4 := types.NamespacedName{Namespace: "default", Name: "job-4"}
	job5 := types.NamespacedName{Namespace: "default", Name: "job-5"}

	qm.AcquireSlot(job1)
	qm.AcquireSlot(job2)
	qm.AcquireSlot(job3)
	qm.AcquireSlot(job4)
	qm.AcquireSlot(job5)

	// Release job1 -> job4 should be popped from FIFO queue to active
	next := qm.ReleaseSlot(job1)
	if next == nil || *next != job4 {
		t.Fatalf("Expected next dispatched job to be job4, got %v", next)
	}

	if qm.GetActiveCount() != 3 || qm.GetQueuedCount() != 1 {
		t.Errorf("Expected ActiveCount=3, QueuedCount=1, got Active=%d, Queued=%d", qm.GetActiveCount(), qm.GetQueuedCount())
	}

	if !qm.IsActive(job4) {
		t.Errorf("Expected job4 to now be active")
	}
	if qm.IsQueued(job4) {
		t.Errorf("Expected job4 to no longer be queued")
	}

	// Read event channel to verify event was emitted for job4
	select {
	case evt := <-qm.EventChannel():
		if evt.Object == nil || evt.Object.GetName() != "job-4" {
			t.Errorf("Expected event for job-4, got %v", evt.Object)
		}
	default:
		t.Errorf("Expected GenericEvent on event channel, but channel was empty")
	}

	// Release remaining jobs until queue empty
	next2 := qm.ReleaseSlot(job2)
	if next2 == nil || *next2 != job5 {
		t.Fatalf("Expected next dispatched job to be job5, got %v", next2)
	}

	next3 := qm.ReleaseSlot(job3)
	if next3 != nil {
		t.Errorf("Expected nil when queue empty, got %v", next3)
	}
}

func TestQueueManager_RemoveJob(t *testing.T) {
	qm := queue.NewQueueManager(2)

	job1 := types.NamespacedName{Namespace: "default", Name: "job-1"}
	job2 := types.NamespacedName{Namespace: "default", Name: "job-2"}
	job3 := types.NamespacedName{Namespace: "default", Name: "job-3"}

	qm.AcquireSlot(job1)
	qm.AcquireSlot(job2)
	qm.AcquireSlot(job3) // queued

	// Remove job3 from queue
	qm.RemoveJob(job3)
	if qm.IsQueued(job3) {
		t.Errorf("Job3 should have been removed from queue")
	}
	if qm.GetQueuedCount() != 0 {
		t.Errorf("Expected QueuedCount=0, got %d", qm.GetQueuedCount())
	}

	// Remove job1 from active
	qm.RemoveJob(job1)
	if qm.IsActive(job1) {
		t.Errorf("Job1 should have been removed from active")
	}
	if qm.GetActiveCount() != 1 {
		t.Errorf("Expected ActiveCount=1, got %d", qm.GetActiveCount())
	}
}

func TestQueueManager_EnvVarFallback(t *testing.T) {
	t.Run("Env var MAX_CONCURRENT_REVIEW_JOBS configured", func(t *testing.T) {
		_ = os.Setenv("MAX_CONCURRENT_REVIEW_JOBS", "5")
		defer os.Unsetenv("MAX_CONCURRENT_REVIEW_JOBS")

		qm := queue.NewQueueManager(0)
		if qm.MaxConcurrent() != 5 {
			t.Errorf("Expected MaxConcurrent=5 from env, got %d", qm.MaxConcurrent())
		}
	})

	t.Run("Default fallback when env var unset/invalid", func(t *testing.T) {
		_ = os.Setenv("MAX_CONCURRENT_REVIEW_JOBS", "invalid")
		defer os.Unsetenv("MAX_CONCURRENT_REVIEW_JOBS")

		qm := queue.NewQueueManager(0)
		if qm.MaxConcurrent() != queue.DefaultMaxConcurrentJobs {
			t.Errorf("Expected MaxConcurrent=%d default, got %d", queue.DefaultMaxConcurrentJobs, qm.MaxConcurrent())
		}
	})
}

func TestQueueManager_Getters(t *testing.T) {
	qm := queue.NewQueueManager(2)
	j1 := types.NamespacedName{Namespace: "ns", Name: "j1"}
	j2 := types.NamespacedName{Namespace: "ns", Name: "j2"}
	j3 := types.NamespacedName{Namespace: "ns", Name: "j3"}

	qm.AcquireSlot(j1)
	qm.AcquireSlot(j2)
	qm.AcquireSlot(j3)

	active := qm.GetActiveJobs()
	if len(active) != 2 {
		t.Errorf("Expected 2 active jobs, got %d", len(active))
	}

	queued := qm.GetQueuedJobs()
	if len(queued) != 1 || queued[0] != j3 {
		t.Errorf("Expected queued jobs [j3], got %v", queued)
	}
}

func TestQueueManager_ThreadSafety(t *testing.T) {
	qm := queue.NewQueueManager(3)
	var wg sync.WaitGroup
	numGoroutines := 30
	wg.Add(numGoroutines)

	for i := 0; i < numGoroutines; i++ {
		go func(id int) {
			defer wg.Done()
			jKey := types.NamespacedName{Namespace: "default", Name: fmt.Sprintf("job-%d", id)}

			allowed, _ := qm.AcquireSlot(jKey)
			if allowed {
				_ = qm.GetActiveCount()
				_ = qm.GetActiveJobs()
				qm.ReleaseSlot(jKey)
			} else {
				_ = qm.GetQueuedCount()
				_ = qm.GetQueuedJobs()
				qm.RemoveJob(jKey)
			}
		}(i)
	}

	wg.Wait()
}

func TestQueueManager_ReleaseInactiveSlot_NoOp(t *testing.T) {
	qm := queue.NewQueueManager(1)

	job1 := types.NamespacedName{Namespace: "default", Name: "job-1"}
	job2 := types.NamespacedName{Namespace: "default", Name: "job-2"}

	// Acquire job1 -> active
	qm.AcquireSlot(job1)
	// Acquire job2 -> queued
	qm.AcquireSlot(job2)

	if qm.GetActiveCount() != 1 || qm.GetQueuedCount() != 1 {
		t.Fatalf("Setup state mismatch: active=%d, queued=%d", qm.GetActiveCount(), qm.GetQueuedCount())
	}

	// Release non-active job (un-acquired job3)
	job3 := types.NamespacedName{Namespace: "default", Name: "job-3"}
	res := qm.ReleaseSlot(job3)
	if res != nil {
		t.Errorf("Expected ReleaseSlot on unacquired job3 to return nil, got %v", res)
	}

	// Active count should still be 1 (job1), queued count should still be 1 (job2)
	if !qm.IsActive(job1) {
		t.Errorf("Expected job1 to remain active")
	}
	if !qm.IsQueued(job2) {
		t.Errorf("Expected job2 to remain queued")
	}

	// Release job1 (active) -> should pop job2 to active
	res1 := qm.ReleaseSlot(job1)
	if res1 == nil || *res1 != job2 {
		t.Fatalf("Expected job1 release to dispatch queued job2, got %v", res1)
	}

	// Duplicate ReleaseSlot on job1 after it was already released must return nil and preserve job2 active status
	res2 := qm.ReleaseSlot(job1)
	if res2 != nil {
		t.Errorf("Expected duplicate ReleaseSlot on job1 to return nil, got %v", res2)
	}
	if !qm.IsActive(job2) {
		t.Errorf("Expected job2 to remain active after duplicate release of job1")
	}
}
