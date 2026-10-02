/*
Copyright 2026 exampleorg.

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

package controllers_test

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-logr/logr"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	meta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"

	reviewv1alpha2 "github.com/review-yeti-ai/review-yeti-bot/k8s-operator/api/v1alpha2"
	"github.com/review-yeti-ai/review-yeti-bot/k8s-operator/controllers"
	"github.com/review-yeti-ai/review-yeti-bot/k8s-operator/pkg/job"
)

// ConcurrencyMonitor tracks active unsuspended worker Jobs created in real-time,
// recording any instant where the active count exceeds the configured limit.
type ConcurrencyMonitor struct {
	workerMu      sync.Mutex
	activeWorkers map[client.ObjectKey]bool
	mu            sync.Mutex
	activeJobs    int32
	maxObserved   int32
	violations    []string
	limit         int32
}

func NewConcurrencyMonitor(limit int32) *ConcurrencyMonitor {
	return &ConcurrencyMonitor{limit: limit, activeWorkers: make(map[client.ObjectKey]bool)}
}

func (m *ConcurrencyMonitor) MaxObservedActive() int32 {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.maxObserved
}

func (m *ConcurrencyMonitor) Violations() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	copied := make([]string, len(m.violations))
	copy(copied, m.violations)
	return copied
}

// Pod counters and precursor conditions do not establish Job completion.
// This is a test oracle, deliberately separate from controller admission code.
func committedWorkerConsumesCapacity(stored *batchv1.Job) bool {
	if stored.Spec.Suspend != nil && *stored.Spec.Suspend {
		return false
	}
	for _, condition := range stored.Status.Conditions {
		if condition.Status == corev1.ConditionTrue &&
			(condition.Type == batchv1.JobComplete || condition.Type == batchv1.JobFailed) {
			return false
		}
	}
	return true
}

// Serialize Job mutation plus readback so each successful committed key
// transition is observed once. Non-Job operations remain unconstrained.
func (m *ConcurrencyMonitor) observeMutation(ctx context.Context, c client.Client, obj client.Object, mutate func() error) error {
	if _, ok := obj.(*batchv1.Job); !ok {
		return mutate()
	}
	m.workerMu.Lock()
	defer m.workerMu.Unlock()
	if err := mutate(); err != nil {
		return err
	}
	key := client.ObjectKeyFromObject(obj)
	var stored batchv1.Job
	err := c.Get(ctx, key, &stored)
	if err != nil && !apierrors.IsNotFound(err) {
		return err
	}
	active := err == nil && committedWorkerConsumesCapacity(&stored)
	if active == m.activeWorkers[key] {
		return nil
	}
	var delta int32 = -1
	if active {
		delta = 1
		m.activeWorkers[key] = true
	} else {
		delete(m.activeWorkers, key)
	}
	curr := atomic.AddInt32(&m.activeJobs, delta)
	m.mu.Lock()
	defer m.mu.Unlock()
	if curr > m.maxObserved {
		m.maxObserved = curr
	}
	if delta > 0 && curr > m.limit {
		m.violations = append(m.violations,
			fmt.Sprintf("Limit %d exceeded: %d active after committed mutation of %s", m.limit, curr, key.Name))
	}
	return nil
}

func (m *ConcurrencyMonitor) InterceptorFuncs() interceptor.Funcs {
	return interceptor.Funcs{
		Create: func(ctx context.Context, c client.WithWatch, obj client.Object, opts ...client.CreateOption) error {
			return m.observeMutation(ctx, c, obj, func() error { return c.Create(ctx, obj, opts...) })
		},
		Update: func(ctx context.Context, c client.WithWatch, obj client.Object, opts ...client.UpdateOption) error {
			return m.observeMutation(ctx, c, obj, func() error { return c.Update(ctx, obj, opts...) })
		},
		Delete: func(ctx context.Context, c client.WithWatch, obj client.Object, opts ...client.DeleteOption) error {
			return m.observeMutation(ctx, c, obj, func() error { return c.Delete(ctx, obj, opts...) })
		},
		Patch: func(ctx context.Context, c client.WithWatch, obj client.Object, patch client.Patch, opts ...client.PatchOption) error {
			return m.observeMutation(ctx, c, obj, func() error { return c.Patch(ctx, obj, patch, opts...) })
		},
		SubResourceUpdate: func(ctx context.Context, c client.Client, subresource string, obj client.Object, opts ...client.SubResourceUpdateOption) error {
			return m.observeMutation(ctx, c, obj, func() error { return c.SubResource(subresource).Update(ctx, obj, opts...) })
		},
		SubResourcePatch: func(ctx context.Context, c client.Client, subresource string, obj client.Object, patch client.Patch, opts ...client.SubResourcePatchOption) error {
			return m.observeMutation(ctx, c, obj, func() error { return c.SubResource(subresource).Patch(ctx, obj, patch, opts...) })
		},
	}
}

func makeBurstReviews(now time.Time, count int, prefix string) []*reviewv1alpha2.PRReviewJob {
	reviews := make([]*reviewv1alpha2.PRReviewJob, count)
	for i := 0; i < count; i++ {
		rev := v1alpha2Review(now)
		runHex := fmt.Sprintf("%032x", i+1)
		rev.Name = fmt.Sprintf("ct-review-%s-%02d", prefix, i)
		rev.Spec.RunID = "run_" + runHex
		rev.Spec.PRNumber = int32(100 + i)
		rev.Spec.DeliveryID = fmt.Sprintf("del-%s-%02d", prefix, i)
		rev.Spec.RunSecretName = "ct-review-run-" + runHex
		receivedAt := now.Add(-time.Duration(count-i) * time.Second)
		rev.Spec.ReceivedAt = metav1.NewTime(receivedAt)
		rev.Spec.TerminalDeadline = metav1.NewTime(receivedAt.Add(15 * time.Minute))
		rev.CreationTimestamp = metav1.NewTime(receivedAt)
		reviews[i] = rev
	}
	return reviews
}

func reconcileUntilSettled(
	ctx context.Context,
	reconciler *controllers.PRReviewJobV1Alpha2Reconciler,
	reviews []*reviewv1alpha2.PRReviewJob,
	threads int,
) error {
	logger := logr.FromContextOrDiscard(ctx)
	retryable := func(err error) bool {
		return apierrors.IsConflict(err) || apierrors.IsTimeout(err) ||
			apierrors.IsServerTimeout(err) || apierrors.IsTooManyRequests(err) ||
			apierrors.IsServiceUnavailable(err) || apierrors.IsInternalError(err)
	}
	limit := reconciler.MaxConcurrentJobs
	if limit <= 0 {
		limit = 4
	}

	for round := 0; round < len(reviews); round++ {
		if err := ctx.Err(); err != nil {
			logger.Error(err, "fixture convergence cancelled", "round", round+1)
			return err
		}
		retryErrors := false
		for _, outcome := range reconcileM4Batch(ctx, reconciler, reviews, threads) {
			if outcome.err != nil {
				if !retryable(outcome.err) {
					return fmt.Errorf("reconcile %s: %w", outcome.request, outcome.err)
				}
				retryErrors = true
			}
		}

		snapshot := make([]*reviewv1alpha2.PRReviewJob, 0, len(reviews))
		for _, review := range reviews {
			key := client.ObjectKeyFromObject(review)
			stored := &reviewv1alpha2.PRReviewJob{}
			if err := reconciler.Client.Get(ctx, key, stored); err != nil {
				logger.Error(err, "fixture review observation failed", "request", key)
				if !retryable(err) {
					return fmt.Errorf("observe %s: %w", key, err)
				}
				retryErrors = true
				continue
			}
			snapshot = append(snapshot, stored)
		}
		if len(snapshot) != len(reviews) {
			continue
		}

		var jobs batchv1.JobList
		if err := reconciler.Client.List(ctx, &jobs); err != nil {
			logger.Error(err, "fixture worker observation failed", "round", round+1)
			if !retryable(err) {
				return fmt.Errorf("observe workers: %w", err)
			}
			continue
		}
		workers := make(map[types.NamespacedName]*batchv1.Job, len(jobs.Items))
		active := make(map[types.NamespacedName]bool)
		for i := range jobs.Items {
			worker := &jobs.Items[i]
			key := client.ObjectKeyFromObject(worker)
			workers[key] = worker
			if committedWorkerConsumesCapacity(worker) {
				active[key] = true
			}
		}

		converged := !retryErrors
		eligible := make([]*reviewv1alpha2.PRReviewJob, 0, len(snapshot))
		for _, review := range snapshot {
			key := types.NamespacedName{Namespace: review.Namespace, Name: review.Status.JobName}
			terminal := reviewv1alpha2.PRReviewJobPhase("")
			if worker := workers[key]; worker != nil {
				for _, condition := range worker.Status.Conditions {
					if condition.Status == corev1.ConditionTrue {
						switch condition.Type {
						case batchv1.JobComplete:
							terminal = reviewv1alpha2.PhaseSucceeded
						case batchv1.JobFailed:
							terminal = reviewv1alpha2.PhaseFailed
						}
					}
				}
			}
			if terminal != "" && review.Status.Phase != terminal {
				converged = false
			}
			switch review.Status.Phase {
			case reviewv1alpha2.PhaseSucceeded, reviewv1alpha2.PhaseFailed:
				if terminal != review.Status.Phase || active[key] {
					err := fmt.Errorf("review %s has an unexpected terminal phase %s", review.Name, review.Status.Phase)
					logger.Error(err, "fixture terminal observation failed", "request", client.ObjectKeyFromObject(review))
					return err
				}
			case "", reviewv1alpha2.PhaseQueued, reviewv1alpha2.PhaseRunning:
				eligible = append(eligible, review)
			default:
				err := fmt.Errorf("review %s has an unexpected phase %s", review.Name, review.Status.Phase)
				logger.Error(err, "fixture phase observation failed", "request", client.ObjectKeyFromObject(review))
				return err
			}
		}
		sort.Slice(eligible, func(i, j int) bool {
			left, right := eligible[i], eligible[j]
			if !left.Spec.ReceivedAt.Equal(&right.Spec.ReceivedAt) {
				return left.Spec.ReceivedAt.Before(&right.Spec.ReceivedAt)
			}
			if !left.CreationTimestamp.Equal(&right.CreationTimestamp) {
				return left.CreationTimestamp.Before(&right.CreationTimestamp)
			}
			return left.Name < right.Name
		})
		wantRunning := limit
		if len(eligible) < wantRunning {
			wantRunning = len(eligible)
		}
		associated := make(map[types.NamespacedName]bool)
		for i, review := range eligible {
			want := reviewv1alpha2.PhaseQueued
			if i < wantRunning {
				want = reviewv1alpha2.PhaseRunning
				key := types.NamespacedName{Namespace: review.Namespace, Name: review.Status.JobName}
				if review.Status.JobName == "" || associated[key] || !active[key] {
					converged = false
				}
				associated[key] = true
			}
			if review.Status.Phase != want {
				converged = false
			}
		}
		if len(active) != wantRunning || len(associated) != wantRunning {
			converged = false
		}
		if converged {
			return nil
		}
	}
	if len(reviews) == 0 {
		return nil
	}
	err := fmt.Errorf("fixture convergence exhausted after %d rounds", len(reviews))
	logger.Error(err, "fixture convergence exhausted", "rounds", len(reviews))
	return err
}

// -----------------------------------------------------------------------------
// Test a: 1-Thread Serialized Baseline Burst
// -----------------------------------------------------------------------------
func TestEmpirical_V1Alpha2_BurstArrival_ReconcileConcurrency_1Thread(t *testing.T) {
	now := time.Date(2026, 9, 30, 10, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)

	const totalReviews = 24
	const maxJobs = 4

	reviews := makeBurstReviews(now, totalReviews, "rev-burst1")
	clientObjs := make([]client.Object, len(reviews))
	for i, r := range reviews {
		clientObjs[i] = r
	}

	monitor := NewConcurrencyMonitor(maxJobs)
	kube := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(clientObjs...).
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}, &batchv1.Job{}).
		WithInterceptorFuncs(monitor.InterceptorFuncs()).
		Build()

	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client:                  kube,
		Scheme:                  scheme,
		Now:                     func() time.Time { return now },
		MaxConcurrentJobs:       maxJobs,
		MaxConcurrentReconciles: 1,
	}

	ctx := context.Background()
	for _, rev := range reviews {
		req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: rev.Namespace, Name: rev.Name}}
		if _, err := reconciler.Reconcile(ctx, req); err != nil {
			t.Fatalf("reconcile %s: %v", rev.Name, err)
		}
	}

	runningCount := 0
	queuedCount := 0
	for _, rev := range reviews {
		var cur reviewv1alpha2.PRReviewJob
		if err := kube.Get(ctx, types.NamespacedName{Namespace: rev.Namespace, Name: rev.Name}, &cur); err != nil {
			t.Fatalf("get %s: %v", rev.Name, err)
		}
		if cur.Status.Phase == reviewv1alpha2.PhaseRunning {
			runningCount++
		} else if cur.Status.Phase == reviewv1alpha2.PhaseQueued {
			queuedCount++
			cond := meta.FindStatusCondition(cur.Status.Conditions, "CapacityExceeded")
			if cond == nil && meta.FindStatusCondition(cur.Status.Conditions, "Ready").Reason != "CapacityExceeded" {
				t.Fatalf("queued review %s missing CapacityExceeded condition", cur.Name)
			}
		}
	}

	if runningCount != maxJobs {
		t.Fatalf("expected exactly %d Running reviews, got %d", maxJobs, runningCount)
	}
	if queuedCount != totalReviews-maxJobs {
		t.Fatalf("expected %d Queued reviews, got %d", totalReviews-maxJobs, queuedCount)
	}

	// Verify exactly 4 active worker jobs exist in the cluster
	var jobList batchv1.JobList
	if err := kube.List(ctx, &jobList, client.InNamespace(job.Namespace)); err != nil {
		t.Fatalf("list jobs: %v", err)
	}
	activeJobs := 0
	for _, j := range jobList.Items {
		if j.Status.Succeeded == 0 && j.Status.Failed == 0 {
			activeJobs++
		}
	}
	if activeJobs != maxJobs {
		t.Fatalf("expected %d active worker jobs, got %d", maxJobs, activeJobs)
	}

	// Complete the 4 running worker jobs and re-reconcile to verify FIFO admission
	for _, rev := range reviews[:maxJobs] {
		var w batchv1.Job
		workerName := rev.Name + "-worker"
		if err := kube.Get(ctx, types.NamespacedName{Namespace: rev.Namespace, Name: workerName}, &w); err != nil {
			t.Fatalf("get worker %s: %v", workerName, err)
		}
		attachReceiptAnnotations(&w)
		if err := kube.Update(ctx, &w); err != nil {
			t.Fatalf("update worker annotations %s: %v", workerName, err)
		}
		w.Status.Succeeded = 1
		w.Status.Conditions = []batchv1.JobCondition{{Type: batchv1.JobComplete, Status: corev1.ConditionTrue}}
		if err := kube.Status().Update(ctx, &w); err != nil {
			t.Fatalf("update worker %s: %v", workerName, err)
		}

		// Reconcile terminal review so it transitions to PhaseSucceeded and releases its slot
		req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: rev.Namespace, Name: rev.Name}}
		if _, err := reconciler.Reconcile(ctx, req); err != nil {
			t.Fatalf("reconcile terminal %s: %v", rev.Name, err)
		}
	}

	// Re-reconcile queued reviews: the next 4 must be admitted
	for _, rev := range reviews[maxJobs:] {
		req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: rev.Namespace, Name: rev.Name}}
		_, _ = reconciler.Reconcile(ctx, req)
	}

	newRunning := 0
	for _, rev := range reviews[maxJobs : maxJobs*2] {
		var cur reviewv1alpha2.PRReviewJob
		if err := kube.Get(ctx, types.NamespacedName{Namespace: rev.Namespace, Name: rev.Name}, &cur); err != nil {
			t.Fatalf("get %s: %v", rev.Name, err)
		}
		if cur.Status.Phase == reviewv1alpha2.PhaseRunning {
			newRunning++
		}
	}
	if newRunning != maxJobs {
		t.Fatalf("expected next %d queued reviews to be admitted into PhaseRunning, got %d", maxJobs, newRunning)
	}
}

// -----------------------------------------------------------------------------
// Test b: 4-Thread Production Concurrency Burst
// -----------------------------------------------------------------------------
func TestEmpirical_V1Alpha2_BurstArrival_ReconcileConcurrency_4Threads(t *testing.T) {
	now := time.Date(2026, 9, 30, 10, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)

	const totalReviews = 24
	const maxJobs = 4
	const threads = 4

	reviews := makeBurstReviews(now, totalReviews, "rev-burst4")
	clientObjs := make([]client.Object, len(reviews))
	for i, r := range reviews {
		clientObjs[i] = r
	}

	monitor := NewConcurrencyMonitor(maxJobs)
	kube := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(clientObjs...).
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}, &batchv1.Job{}).
		WithInterceptorFuncs(monitor.InterceptorFuncs()).
		Build()

	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client:                  kube,
		Scheme:                  scheme,
		Now:                     func() time.Time { return now },
		MaxConcurrentJobs:       maxJobs,
		MaxConcurrentReconciles: threads,
	}

	ctx := context.Background()
	if err := reconcileUntilSettled(ctx, reconciler, reviews, threads); err != nil {
		t.Fatalf("settle fixture: %v", err)
	}

	if monitor.MaxObservedActive() > maxJobs {
		t.Fatalf("concurrency monitor observed %d active jobs, exceeding limit %d. Violations: %v",
			monitor.MaxObservedActive(), maxJobs, monitor.Violations())
	}

	runningCount := 0
	queuedCount := 0
	for _, rev := range reviews {
		var cur reviewv1alpha2.PRReviewJob
		if err := kube.Get(ctx, types.NamespacedName{Namespace: rev.Namespace, Name: rev.Name}, &cur); err != nil {
			t.Fatalf("get %s: %v", rev.Name, err)
		}
		if cur.Status.Phase == reviewv1alpha2.PhaseRunning {
			runningCount++
		} else if cur.Status.Phase == reviewv1alpha2.PhaseQueued {
			queuedCount++
		}
	}

	if runningCount != maxJobs {
		t.Fatalf("expected exactly %d Running reviews, got %d", maxJobs, runningCount)
	}
	if queuedCount != totalReviews-maxJobs {
		t.Fatalf("expected %d Queued reviews, got %d", totalReviews-maxJobs, queuedCount)
	}
}

// -----------------------------------------------------------------------------
// Test c: 16-Thread High-Stress Concurrency Burst (32 Reviews, Limit 4)
// -----------------------------------------------------------------------------
func TestEmpirical_V1Alpha2_BurstArrival_ReconcileConcurrency_16Threads(t *testing.T) {
	now := time.Date(2026, 9, 30, 10, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)

	const totalReviews = 32
	const maxJobs = 4
	const threads = 16

	reviews := makeBurstReviews(now, totalReviews, "rev-burst16")
	clientObjs := make([]client.Object, len(reviews))
	for i, r := range reviews {
		clientObjs[i] = r
	}

	monitor := NewConcurrencyMonitor(maxJobs)
	kube := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(clientObjs...).
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}, &batchv1.Job{}).
		WithInterceptorFuncs(monitor.InterceptorFuncs()).
		Build()

	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client:                  kube,
		Scheme:                  scheme,
		Now:                     func() time.Time { return now },
		MaxConcurrentJobs:       maxJobs,
		MaxConcurrentReconciles: threads,
	}

	ctx := context.Background()
	if err := reconcileUntilSettled(ctx, reconciler, reviews, threads); err != nil {
		t.Fatalf("settle fixture: %v", err)
	}

	if monitor.MaxObservedActive() > maxJobs {
		t.Fatalf("concurrency monitor observed %d active jobs, exceeding limit %d. Violations: %v",
			monitor.MaxObservedActive(), maxJobs, monitor.Violations())
	}

	runningCount := 0
	queuedCount := 0
	for _, rev := range reviews {
		var cur reviewv1alpha2.PRReviewJob
		if err := kube.Get(ctx, types.NamespacedName{Namespace: rev.Namespace, Name: rev.Name}, &cur); err != nil {
			t.Fatalf("get %s: %v", rev.Name, err)
		}
		if cur.Status.Phase == reviewv1alpha2.PhaseRunning {
			runningCount++
		} else if cur.Status.Phase == reviewv1alpha2.PhaseQueued {
			queuedCount++
		}
	}

	if runningCount != maxJobs {
		t.Fatalf("expected exactly %d Running reviews under 16-thread contention, got %d", maxJobs, runningCount)
	}
	if queuedCount != totalReviews-maxJobs {
		t.Fatalf("expected %d Queued reviews under 16-thread contention, got %d", totalReviews-maxJobs, queuedCount)
	}
}

// -----------------------------------------------------------------------------
// Test d: Standard Limit 10 under 16-Thread Contention (30 Reviews, Limit 10)
// -----------------------------------------------------------------------------
func TestEmpirical_V1Alpha2_BurstArrival_StandardLimit10_16Threads(t *testing.T) {
	now := time.Date(2026, 9, 30, 10, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)

	const totalReviews = 30
	const maxJobs = 10
	const threads = 16

	reviews := makeBurstReviews(now, totalReviews, "rev-std10")
	clientObjs := make([]client.Object, len(reviews))
	for i, r := range reviews {
		clientObjs[i] = r
	}

	monitor := NewConcurrencyMonitor(maxJobs)
	kube := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(clientObjs...).
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}, &batchv1.Job{}).
		WithInterceptorFuncs(monitor.InterceptorFuncs()).
		Build()

	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client:                  kube,
		Scheme:                  scheme,
		Now:                     func() time.Time { return now },
		MaxConcurrentJobs:       maxJobs,
		MaxConcurrentReconciles: threads,
	}

	ctx := context.Background()
	if err := reconcileUntilSettled(ctx, reconciler, reviews, threads); err != nil {
		t.Fatalf("settle fixture: %v", err)
	}

	if monitor.MaxObservedActive() > maxJobs {
		t.Fatalf("concurrency monitor observed %d active jobs, exceeding limit %d. Violations: %v",
			monitor.MaxObservedActive(), maxJobs, monitor.Violations())
	}

	runningCount := 0
	queuedCount := 0
	for _, rev := range reviews {
		var cur reviewv1alpha2.PRReviewJob
		if err := kube.Get(ctx, types.NamespacedName{Namespace: rev.Namespace, Name: rev.Name}, &cur); err != nil {
			t.Fatalf("get %s: %v", rev.Name, err)
		}
		if cur.Status.Phase == reviewv1alpha2.PhaseRunning {
			runningCount++
		} else if cur.Status.Phase == reviewv1alpha2.PhaseQueued {
			queuedCount++
		}
	}

	if runningCount != maxJobs {
		t.Fatalf("expected exactly %d Running reviews, got %d", maxJobs, runningCount)
	}
	if queuedCount != totalReviews-maxJobs {
		t.Fatalf("expected %d Queued reviews, got %d", totalReviews-maxJobs, queuedCount)
	}
}

// -----------------------------------------------------------------------------
// Test e: FIFO Ordering Under Contended Reverse-Order Dispatch
// -----------------------------------------------------------------------------
func TestEmpirical_V1Alpha2_BurstArrival_FIFOOrdering_ContendedThreads(t *testing.T) {
	now := time.Date(2026, 9, 30, 10, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)

	const totalReviews = 20
	const maxJobs = 4
	const threads = 16

	reviews := makeBurstReviews(now, totalReviews, "rev-fifo")
	clientObjs := make([]client.Object, len(reviews))
	for i, r := range reviews {
		clientObjs[i] = r
	}

	kube := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(clientObjs...).
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}, &batchv1.Job{}).
		Build()

	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client:                  kube,
		Scheme:                  scheme,
		Now:                     func() time.Time { return now },
		MaxConcurrentJobs:       maxJobs,
		MaxConcurrentReconciles: threads,
	}

	ctx := context.Background()

	// Dispatch in REVERSE chronological order (youngest/newest first)
	reverseReviews := make([]*reviewv1alpha2.PRReviewJob, totalReviews)
	for i := 0; i < totalReviews; i++ {
		reverseReviews[i] = reviews[totalReviews-1-i]
	}

	if err := reconcileUntilSettled(ctx, reconciler, reverseReviews, threads); err != nil {
		t.Fatalf("settle fixture: %v", err)
	}

	// The 4 oldest reviews (rev-fifo-00, rev-fifo-01, rev-fifo-02, rev-fifo-03) MUST be Running
	for i := 0; i < maxJobs; i++ {
		var cur reviewv1alpha2.PRReviewJob
		if err := kube.Get(ctx, types.NamespacedName{Namespace: reviews[i].Namespace, Name: reviews[i].Name}, &cur); err != nil {
			t.Fatalf("get %s: %v", reviews[i].Name, err)
		}
		if cur.Status.Phase != reviewv1alpha2.PhaseRunning {
			t.Fatalf("FIFO violation: oldest review %s expected to be Running, got phase %s", cur.Name, cur.Status.Phase)
		}
	}

	// All younger reviews (rev-fifo-04 through rev-fifo-19) must be Queued
	for i := maxJobs; i < totalReviews; i++ {
		var cur reviewv1alpha2.PRReviewJob
		if err := kube.Get(ctx, types.NamespacedName{Namespace: reviews[i].Namespace, Name: reviews[i].Name}, &cur); err != nil {
			t.Fatalf("get %s: %v", reviews[i].Name, err)
		}
		if cur.Status.Phase != reviewv1alpha2.PhaseQueued {
			t.Fatalf("FIFO violation: younger review %s expected to be Queued, got phase %s", cur.Name, cur.Status.Phase)
		}
	}
}

// -----------------------------------------------------------------------------
// Test f: Continuation Burst Competes Fairly Against Fresh Admissions
// -----------------------------------------------------------------------------
func TestEmpirical_V1Alpha2_ContinuationBurst_RespectsCapacity_WithoutMutex(t *testing.T) {
	now := time.Date(2026, 9, 30, 10, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)

	const prepCount = 10
	const freshCount = 10
	const maxJobs = 4
	const threads = 16

	// Create 10 continuation reviews (prep finished, awaiting resumption)
	continuationReviews := make([]*reviewv1alpha2.PRReviewJob, prepCount)
	for i := 0; i < prepCount; i++ {
		rev := v1alpha2Review(now)
		runHex := fmt.Sprintf("%032x", i+200)
		rev.Name = fmt.Sprintf("ct-review-cont-%02d", i)
		rev.Spec.RunID = "run_" + runHex
		rev.Spec.PRNumber = int32(200 + i)
		rev.Spec.DeliveryID = fmt.Sprintf("del-cont-%02d", i)
		rev.Spec.RunSecretName = "ct-review-run-" + runHex
		receivedAt := now.Add(-time.Duration(prepCount*2-i) * time.Second)
		rev.Spec.ReceivedAt = metav1.NewTime(receivedAt)
		rev.Spec.TerminalDeadline = metav1.NewTime(receivedAt.Add(15 * time.Minute))
		rev.CreationTimestamp = metav1.NewTime(receivedAt)
		if rev.Annotations == nil {
			rev.Annotations = make(map[string]string)
		}
		rev.Annotations["review-yeti.ai/resumed"] = "true"
		meta.SetStatusCondition(&rev.Status.Conditions, metav1.Condition{
			Type:               reviewv1alpha2.ConditionAwaitingResumption,
			Status:             metav1.ConditionTrue,
			Reason:             "PrepCompleted",
			Message:            "prep phase completed",
			ObservedGeneration: rev.Generation,
			LastTransitionTime: metav1.NewTime(now),
		})
		continuationReviews[i] = rev
	}

	// Create 10 fresh reviews
	freshReviews := makeBurstReviews(now, freshCount, "rev-fresh")

	allReviews := append(continuationReviews, freshReviews...)
	clientObjs := make([]client.Object, len(allReviews))
	for i, r := range allReviews {
		clientObjs[i] = r
	}

	monitor := NewConcurrencyMonitor(maxJobs)
	kube := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(clientObjs...).
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}, &batchv1.Job{}).
		WithInterceptorFuncs(monitor.InterceptorFuncs()).
		Build()

	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client:                  kube,
		Scheme:                  scheme,
		Now:                     func() time.Time { return now },
		MaxConcurrentJobs:       maxJobs,
		MaxConcurrentReconciles: threads,
	}

	ctx := context.Background()
	if err := reconcileUntilSettled(ctx, reconciler, allReviews, threads); err != nil {
		t.Fatalf("settle fixture: %v", err)
	}

	if monitor.MaxObservedActive() > maxJobs {
		t.Fatalf("concurrency monitor observed %d active jobs, exceeding limit %d. Violations: %v",
			monitor.MaxObservedActive(), maxJobs, monitor.Violations())
	}

	runningCount := 0
	queuedCount := 0
	for _, rev := range allReviews {
		var cur reviewv1alpha2.PRReviewJob
		if err := kube.Get(ctx, types.NamespacedName{Namespace: rev.Namespace, Name: rev.Name}, &cur); err != nil {
			t.Fatalf("get %s: %v", rev.Name, err)
		}
		if cur.Status.Phase == reviewv1alpha2.PhaseRunning {
			runningCount++
		} else if cur.Status.Phase == reviewv1alpha2.PhaseQueued {
			queuedCount++
		}
	}

	if runningCount != maxJobs {
		t.Fatalf("expected exactly %d Running reviews, got %d", maxJobs, runningCount)
	}
	if queuedCount != len(allReviews)-maxJobs {
		t.Fatalf("expected %d Queued reviews, got %d", len(allReviews)-maxJobs, queuedCount)
	}
}

// -----------------------------------------------------------------------------
// Test g: Multi-Replica Active-Active Admission Race (No Shared Mutexes)
// -----------------------------------------------------------------------------
func TestEmpirical_V1Alpha2_MultiReplica_ActiveActiveAdmissionRace(t *testing.T) {
	now := time.Date(2026, 9, 30, 10, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)

	const totalReviews = 16
	const maxJobs = 3

	reviews := makeBurstReviews(now, totalReviews, "rev-replica")
	clientObjs := make([]client.Object, len(reviews))
	for i, r := range reviews {
		clientObjs[i] = r
	}

	monitor := NewConcurrencyMonitor(maxJobs)
	sharedClient := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(clientObjs...).
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}, &batchv1.Job{}).
		WithInterceptorFuncs(monitor.InterceptorFuncs()).
		Build()

	// Instantiate two independent reconciler instances sharing ONLY the API client
	replicaA := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client:                  sharedClient,
		Scheme:                  scheme,
		Now:                     func() time.Time { return now },
		MaxConcurrentJobs:       maxJobs,
		MaxConcurrentReconciles: 4,
	}

	replicaB := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client:                  sharedClient,
		Scheme:                  scheme,
		Now:                     func() time.Time { return now },
		MaxConcurrentJobs:       maxJobs,
		MaxConcurrentReconciles: 4,
	}

	ctx := context.Background()

	// 4 goroutines running Replica A on even reviews
	evenReviews := []*reviewv1alpha2.PRReviewJob{}
	oddReviews := []*reviewv1alpha2.PRReviewJob{}
	for i, r := range reviews {
		if i%2 == 0 {
			evenReviews = append(evenReviews, r)
		} else {
			oddReviews = append(oddReviews, r)
		}
	}

	prevRunning := -1
	for round := 0; round < totalReviews; round++ {
		var wg sync.WaitGroup
		start := make(chan struct{})

		evenChan := make(chan *reviewv1alpha2.PRReviewJob, len(evenReviews))
		for _, r := range evenReviews {
			evenChan <- r
		}
		close(evenChan)

		oddChan := make(chan *reviewv1alpha2.PRReviewJob, len(oddReviews))
		for _, r := range oddReviews {
			oddChan <- r
		}
		close(oddChan)

		for i := 0; i < 4; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				<-start
				for rev := range evenChan {
					req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: rev.Namespace, Name: rev.Name}}
					_, _ = replicaA.Reconcile(ctx, req)
				}
			}()
		}

		for i := 0; i < 4; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				<-start
				for rev := range oddChan {
					req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: rev.Namespace, Name: rev.Name}}
					_, _ = replicaB.Reconcile(ctx, req)
				}
			}()
		}

		close(start)
		wg.Wait()

		runningCount := 0
		for _, rev := range reviews {
			var cur reviewv1alpha2.PRReviewJob
			if err := sharedClient.Get(ctx, types.NamespacedName{Namespace: rev.Namespace, Name: rev.Name}, &cur); err == nil {
				if cur.Status.Phase == reviewv1alpha2.PhaseRunning {
					runningCount++
				}
			}
		}
		if runningCount >= maxJobs || runningCount == prevRunning {
			break
		}
		prevRunning = runningCount
	}

	if monitor.MaxObservedActive() > maxJobs {
		t.Fatalf("multi-replica race exceeded capacity ceiling: observed %d active, limit %d",
			monitor.MaxObservedActive(), maxJobs)
	}

	runningCount := 0
	queuedCount := 0
	for _, rev := range reviews {
		var cur reviewv1alpha2.PRReviewJob
		if err := sharedClient.Get(ctx, types.NamespacedName{Namespace: rev.Namespace, Name: rev.Name}, &cur); err != nil {
			t.Fatalf("get %s: %v", rev.Name, err)
		}
		if cur.Status.Phase == reviewv1alpha2.PhaseRunning {
			runningCount++
		} else if cur.Status.Phase == reviewv1alpha2.PhaseQueued {
			queuedCount++
		}
	}

	if runningCount != maxJobs {
		t.Fatalf("expected exactly %d Running reviews across replicas, got %d", maxJobs, runningCount)
	}
	if queuedCount != totalReviews-maxJobs {
		t.Fatalf("expected %d Queued reviews across replicas, got %d", totalReviews-maxJobs, queuedCount)
	}
}

// -----------------------------------------------------------------------------
// Test h: Leader Failover Mid-Burst Preserves Slot Ceiling Integrity
// -----------------------------------------------------------------------------
func TestEmpirical_V1Alpha2_LeaderFailover_MidBurst_SlotCeilingIntegrity(t *testing.T) {
	now := time.Date(2026, 9, 30, 10, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)

	const totalReviews = 12
	const maxJobs = 4

	reviews := makeBurstReviews(now, totalReviews, "rev-failover")
	clientObjs := make([]client.Object, len(reviews))
	for i, r := range reviews {
		clientObjs[i] = r
	}

	monitor := NewConcurrencyMonitor(maxJobs)
	sharedClient := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(clientObjs...).
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}, &batchv1.Job{}).
		WithInterceptorFuncs(monitor.InterceptorFuncs()).
		Build()

	replicaA := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client:                  sharedClient,
		Scheme:                  scheme,
		Now:                     func() time.Time { return now },
		MaxConcurrentJobs:       maxJobs,
		MaxConcurrentReconciles: 4,
	}

	ctx := context.Background()

	// Replica A reconciles the first 6 reviews, admitting 4 and queueing 2
	for _, rev := range reviews[:6] {
		req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: rev.Namespace, Name: rev.Name}}
		_, _ = replicaA.Reconcile(ctx, req)
	}

	// Replica A crashes / stops. Replica B takes over with cold caches.
	replicaB := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client:                  sharedClient,
		Scheme:                  scheme,
		Now:                     func() time.Time { return now },
		MaxConcurrentJobs:       maxJobs,
		MaxConcurrentReconciles: 4,
	}

	// Replica B reconciles all 12 reviews
	for _, rev := range reviews {
		req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: rev.Namespace, Name: rev.Name}}
		_, _ = replicaB.Reconcile(ctx, req)
	}

	// Active workers must not exceed 4
	if monitor.MaxObservedActive() > maxJobs {
		t.Fatalf("failover caused over-admission: observed %d, limit %d",
			monitor.MaxObservedActive(), maxJobs)
	}

	// Settle 2 active workers as succeeded
	var jobList batchv1.JobList
	if err := sharedClient.List(ctx, &jobList, client.InNamespace(job.Namespace)); err != nil {
		t.Fatalf("list jobs: %v", err)
	}
	freed := 0
	for i := range jobList.Items {
		w := &jobList.Items[i]
		if w.Status.Succeeded == 0 && w.Status.Failed == 0 {
			w.Status.Succeeded = 1
			w.Status.Conditions = []batchv1.JobCondition{{Type: batchv1.JobComplete, Status: corev1.ConditionTrue}}
			if err := sharedClient.Update(ctx, w); err != nil {
				t.Fatalf("update worker: %v", err)
			}
			// Trigger terminal reconcile to release slot
			parentName := strings.TrimSuffix(w.Name, "-worker")
			req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: w.Namespace, Name: parentName}}
			_, _ = replicaB.Reconcile(ctx, req)
			freed++
			if freed >= 2 {
				break
			}
		}
	}

	// Replica B reconciles queued reviews to admit exactly 2 more
	for _, rev := range reviews[4:] {
		req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: rev.Namespace, Name: rev.Name}}
		_, _ = replicaB.Reconcile(ctx, req)
	}

	if monitor.MaxObservedActive() > maxJobs {
		t.Fatalf("failover resumption exceeded ceiling: observed %d active, limit %d",
			monitor.MaxObservedActive(), maxJobs)
	}
}

// -----------------------------------------------------------------------------
// Test i: Same-Review Concurrent Dispatch Race Produces Exactly 1 Worker Job
// -----------------------------------------------------------------------------
func TestEmpirical_V1Alpha2_MultiReplica_SameReviewRace_SingleWorkerJobCreated(t *testing.T) {
	now := time.Date(2026, 9, 30, 10, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)

	rev := v1alpha2Review(now)
	runHex := "99999999999999999999999999999999"
	rev.Name = "ct-review-" + runHex
	rev.Spec.RunID = "run_" + runHex
	rev.Spec.PRNumber = 301
	rev.Spec.RunSecretName = "ct-review-run-" + runHex
	rev.Spec.ReceivedAt = metav1.NewTime(now.Add(-10 * time.Second))
	rev.Spec.TerminalDeadline = metav1.NewTime(rev.Spec.ReceivedAt.Add(15 * time.Minute))
	rev.CreationTimestamp = metav1.NewTime(now.Add(-10 * time.Second))

	sharedClient := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(rev).
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}, &batchv1.Job{}).
		Build()

	replicaA := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client:                  sharedClient,
		Scheme:                  scheme,
		Now:                     func() time.Time { return now },
		MaxConcurrentJobs:       4,
		MaxConcurrentReconciles: 1,
	}

	replicaB := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client:                  sharedClient,
		Scheme:                  scheme,
		Now:                     func() time.Time { return now },
		MaxConcurrentJobs:       4,
		MaxConcurrentReconciles: 1,
	}

	ctx := context.Background()
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: rev.Namespace, Name: rev.Name}}

	var wg sync.WaitGroup
	start := make(chan struct{})
	wg.Add(2)

	go func() {
		defer wg.Done()
		<-start
		_, _ = replicaA.Reconcile(ctx, req)
	}()

	go func() {
		defer wg.Done()
		<-start
		_, _ = replicaB.Reconcile(ctx, req)
	}()

	close(start)
	wg.Wait()

	// Verify exactly 1 worker Job exists
	var jobList batchv1.JobList
	if err := sharedClient.List(ctx, &jobList, client.InNamespace(rev.Namespace)); err != nil {
		t.Fatalf("list jobs: %v", err)
	}
	if len(jobList.Items) != 1 {
		t.Fatalf("expected exactly 1 worker Job created, got %d", len(jobList.Items))
	}
	if jobList.Items[0].Name != rev.Name+"-worker" {
		t.Fatalf("worker job name = %s, want %s-worker", jobList.Items[0].Name, rev.Name)
	}

	// Verify review is Running
	var updated reviewv1alpha2.PRReviewJob
	if err := sharedClient.Get(ctx, req.NamespacedName, &updated); err != nil {
		t.Fatalf("get review: %v", err)
	}
	if updated.Status.Phase != reviewv1alpha2.PhaseRunning {
		t.Fatalf("review phase = %s, want Running", updated.Status.Phase)
	}
}

// Fixture-driver regressions call the original void helpers as statements.
// Their OLD oracle is stored state or a real keyed outcome, never a new API.
func TestM2FixtureSettleRetriesTransientAdmissionErrors(t *testing.T) {
	for _, threads := range []int{1, 4, 16} {
		t.Run(fmt.Sprintf("%dThreads", threads), func(t *testing.T) {
			var calls atomic.Int32
			ctx, r, reviews, monitor, _ := newConvergenceFixture(t, threads, 8, "transient", func(f interceptor.Funcs, _ []*reviewv1alpha2.PRReviewJob) interceptor.Funcs {
				f.List = func(ctx context.Context, c client.WithWatch, list client.ObjectList, opts ...client.ListOption) error {
					if fixtureAdmissionList(list, opts) && calls.Add(1) <= 16 {
						return apierrors.NewTimeoutError("fixture admission timeout", 0)
					}
					return c.List(ctx, list, opts...)
				}
				return f
			})
			reconcileUntilSettled(ctx, r, reviews, threads)
			assertFixtureAdmission(t, ctx, r.Client, reviews, monitor, 0, 0, 0)
		})
	}
}

func TestM2FixtureSettleRetriesQuietConflictRequeues(t *testing.T) {
	for _, threads := range []int{1, 4, 16} {
		t.Run(fmt.Sprintf("%dThreads", threads), func(t *testing.T) {
			var calls atomic.Int32
			ctx, r, reviews, monitor, _ := newConvergenceFixture(t, threads, 8, "conflict", func(f interceptor.Funcs, _ []*reviewv1alpha2.PRReviewJob) interceptor.Funcs {
				f.List = func(ctx context.Context, c client.WithWatch, list client.ObjectList, opts ...client.ListOption) error {
					if fixtureAdmissionList(list, opts) && calls.Add(1) <= 16 {
						return apierrors.NewConflict(batchv1.SchemeGroupVersion.WithResource("jobs").GroupResource(), "fixture-admission", fmt.Errorf("fixture conflict"))
					}
					return c.List(ctx, list, opts...)
				}
				return f
			})
			reconcileUntilSettled(ctx, r, reviews, threads)
			assertFixtureAdmission(t, ctx, r.Client, reviews, monitor, 0, 0, 0)
		})
	}
}

func TestM2FixtureSettleContinuesBelowCapacityPlateau(t *testing.T) {
	for _, threads := range []int{1, 4, 16} {
		t.Run(fmt.Sprintf("%dThreads", threads), func(t *testing.T) {
			var reads atomic.Int32
			ctx, r, reviews, monitor, _ := newConvergenceFixture(t, threads, 8, "plateau", func(f interceptor.Funcs, reviews []*reviewv1alpha2.PRReviewJob) interceptor.Funcs {
				target := client.ObjectKeyFromObject(reviews[3])
				f.Get = func(ctx context.Context, c client.WithWatch, key client.ObjectKey, obj client.Object, opts ...client.GetOption) error {
					if _, ok := obj.(*reviewv1alpha2.PRReviewJob); ok && key == target && reads.Add(1) <= 4 {
						return apierrors.NewTimeoutError("fixture target observation timeout", 0)
					}
					return c.Get(ctx, key, obj, opts...)
				}
				return f
			})
			reconcileUntilSettled(ctx, r, reviews, threads)
			assertFixtureAdmission(t, ctx, r.Client, reviews, monitor, 0, 0, 0)
		})
	}
}

func TestM2FixtureSettleStopsOnPermanentError(t *testing.T) {
	for _, threads := range []int{1, 4, 16} {
		t.Run(fmt.Sprintf("%dThreads", threads), func(t *testing.T) {
			var calls atomic.Int32
			sentinel := apierrors.NewForbidden(batchv1.SchemeGroupVersion.WithResource("jobs").GroupResource(), "fixture-admission", fmt.Errorf("fixture admission denied"))
			ctx, r, reviews, _, sink := newConvergenceFixture(t, threads, 8, "forbidden", func(f interceptor.Funcs, _ []*reviewv1alpha2.PRReviewJob) interceptor.Funcs {
				f.List = func(ctx context.Context, c client.WithWatch, list client.ObjectList, opts ...client.ListOption) error {
					if fixtureAdmissionList(list, opts) {
						calls.Add(1)
						return sentinel
					}
					return c.List(ctx, list, opts...)
				}
				return f
			})
			reconcileUntilSettled(ctx, r, reviews, threads)
			if got := calls.Load(); got != 8 {
				t.Errorf("permanent error must stop after one closed batch: got %d admission calls, want 8", got)
			}
			assertFixtureKeyedErrors(t, sink, reviews, sentinel)
		})
	}
}

func TestM2FixtureSettleReportsBoundedExhaustion(t *testing.T) {
	for _, threads := range []int{1, 4, 16} {
		t.Run(fmt.Sprintf("%dThreads", threads), func(t *testing.T) {
			var calls atomic.Int32
			ctx, r, reviews, _, sink := newConvergenceFixture(t, threads, 8, "exhaust", func(f interceptor.Funcs, _ []*reviewv1alpha2.PRReviewJob) interceptor.Funcs {
				f.List = func(ctx context.Context, c client.WithWatch, list client.ObjectList, opts ...client.ListOption) error {
					if fixtureAdmissionList(list, opts) {
						calls.Add(1)
						return apierrors.NewConflict(batchv1.SchemeGroupVersion.WithResource("jobs").GroupResource(), "fixture-admission", fmt.Errorf("fixture conflict"))
					}
					return c.List(ctx, list, opts...)
				}
				return f
			})
			reconcileUntilSettled(ctx, r, reviews, threads)
			if got := calls.Load(); got != 64 {
				t.Errorf("exhaustion must consume exactly the existing eight-round bound: got %d admission calls, want 64", got)
			}
			observed := false
			for _, entry := range sink.snapshot() {
				observed = observed || entry.err != nil
			}
			if !observed {
				t.Error("exhausted convergence returned without a failure diagnostic")
			}
			var jobs batchv1.JobList
			if err := r.Client.List(ctx, &jobs); err != nil {
				t.Fatal(err)
			}
			if len(jobs.Items) != 0 {
				t.Fatalf("exhausted admission created %d workers", len(jobs.Items))
			}
		})
	}
}

func TestM2FixtureSettleHealthyControlPreservesFIFOAndMatrix(t *testing.T) {
	for _, threads := range []int{1, 4, 16} {
		t.Run(fmt.Sprintf("%dThreads", threads), func(t *testing.T) {
			ctx, r, reviews, monitor, _ := newConvergenceFixture(t, threads, 8, "healthy", nil)
			reversed := append([]*reviewv1alpha2.PRReviewJob(nil), reviews...)
			for left, right := 0, len(reversed)-1; left < right; left, right = left+1, right-1 {
				reversed[left], reversed[right] = reversed[right], reversed[left]
			}
			reconcileUntilSettled(ctx, r, reversed, threads)
			assertFixtureAdmission(t, ctx, r.Client, reviews, monitor, 0, 0, 0)
		})
	}
}
