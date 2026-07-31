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

package queue

import (
	"os"
	"strconv"
	"sync"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/event"

	reviewv1alpha1 "github.com/calltelemetry/ct-review-bot/k8s-operator/api/v1alpha1"
)

const DefaultMaxConcurrentJobs = 3

// QueueManager defines the interface for platform concurrency management.
type QueueManager interface {
	AcquireSlot(jobKey types.NamespacedName) (allowed bool, queued bool)
	ReleaseSlot(jobKey types.NamespacedName) *types.NamespacedName
	RemoveJob(jobKey types.NamespacedName)
	GetActiveCount() int
	GetQueuedCount() int
	GetActiveJobs() []types.NamespacedName
	GetQueuedJobs() []types.NamespacedName
	IsActive(jobKey types.NamespacedName) bool
	IsQueued(jobKey types.NamespacedName) bool
	EventChannel() <-chan event.GenericEvent
	MaxConcurrent() int
}

type memoryQueueManager struct {
	mu            sync.RWMutex
	maxConcurrent int
	active        map[types.NamespacedName]struct{}
	queue         []types.NamespacedName
	events        chan event.GenericEvent
}

// NewQueueManager creates a new QueueManager instance.
// If maxConcurrent is <= 0, it inspects MAX_CONCURRENT_REVIEW_JOBS env var, falling back to DefaultMaxConcurrentJobs (3).
func NewQueueManager(maxConcurrent int) QueueManager {
	if maxConcurrent <= 0 {
		if envVal := os.Getenv("MAX_CONCURRENT_REVIEW_JOBS"); envVal != "" {
			if parsed, err := strconv.Atoi(envVal); err == nil && parsed > 0 {
				maxConcurrent = parsed
			}
		}
	}
	if maxConcurrent <= 0 {
		maxConcurrent = DefaultMaxConcurrentJobs
	}

	return &memoryQueueManager{
		maxConcurrent: maxConcurrent,
		active:        make(map[types.NamespacedName]struct{}),
		queue:         make([]types.NamespacedName, 0),
		events:        make(chan event.GenericEvent, 100),
	}
}

func (q *memoryQueueManager) AcquireSlot(jobKey types.NamespacedName) (bool, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()

	// If already active
	if _, ok := q.active[jobKey]; ok {
		return true, false
	}

	// Check if capacity available
	if len(q.active) < q.maxConcurrent {
		q.removeFromQueueLocked(jobKey)
		q.active[jobKey] = struct{}{}
		return true, false
	}

	// Place in FIFO queue if not present
	if !q.isQueuedLocked(jobKey) {
		q.queue = append(q.queue, jobKey)
	}

	return false, true
}

func (q *memoryQueueManager) ReleaseSlot(jobKey types.NamespacedName) *types.NamespacedName {
	q.mu.Lock()
	defer q.mu.Unlock()

	if _, wasActive := q.active[jobKey]; !wasActive {
		q.removeFromQueueLocked(jobKey)
		return nil
	}

	delete(q.active, jobKey)
	q.removeFromQueueLocked(jobKey)

	if len(q.queue) == 0 {
		return nil
	}

	// Pop next FIFO job
	nextJob := q.queue[0]
	q.queue = q.queue[1:]
	q.active[nextJob] = struct{}{}

	// Trigger event channel for controller workqueue
	obj := &reviewv1alpha1.PRReviewJob{
		ObjectMeta: metav1.ObjectMeta{
			Name:      nextJob.Name,
			Namespace: nextJob.Namespace,
		},
	}
	select {
	case q.events <- event.GenericEvent{Object: obj}:
	default:
		// Non-blocking channel push
	}

	return &nextJob
}

func (q *memoryQueueManager) RemoveJob(jobKey types.NamespacedName) {
	q.mu.Lock()
	defer q.mu.Unlock()
	delete(q.active, jobKey)
	q.removeFromQueueLocked(jobKey)
}

func (q *memoryQueueManager) GetActiveCount() int {
	q.mu.RLock()
	defer q.mu.RUnlock()
	return len(q.active)
}

func (q *memoryQueueManager) GetQueuedCount() int {
	q.mu.RLock()
	defer q.mu.RUnlock()
	return len(q.queue)
}

func (q *memoryQueueManager) GetActiveJobs() []types.NamespacedName {
	q.mu.RLock()
	defer q.mu.RUnlock()
	jobs := make([]types.NamespacedName, 0, len(q.active))
	for k := range q.active {
		jobs = append(jobs, k)
	}
	return jobs
}

func (q *memoryQueueManager) GetQueuedJobs() []types.NamespacedName {
	q.mu.RLock()
	defer q.mu.RUnlock()
	jobs := make([]types.NamespacedName, len(q.queue))
	copy(jobs, q.queue)
	return jobs
}

func (q *memoryQueueManager) IsActive(jobKey types.NamespacedName) bool {
	q.mu.RLock()
	defer q.mu.RUnlock()
	_, ok := q.active[jobKey]
	return ok
}

func (q *memoryQueueManager) IsQueued(jobKey types.NamespacedName) bool {
	q.mu.RLock()
	defer q.mu.RUnlock()
	return q.isQueuedLocked(jobKey)
}

func (q *memoryQueueManager) EventChannel() <-chan event.GenericEvent {
	return q.events
}

func (q *memoryQueueManager) MaxConcurrent() int {
	return q.maxConcurrent
}

func (q *memoryQueueManager) isQueuedLocked(jobKey types.NamespacedName) bool {
	for _, item := range q.queue {
		if item == jobKey {
			return true
		}
	}
	return false
}

func (q *memoryQueueManager) removeFromQueueLocked(jobKey types.NamespacedName) {
	for i, item := range q.queue {
		if item == jobKey {
			q.queue = append(q.queue[:i], q.queue[i+1:]...)
			return
		}
	}
}
