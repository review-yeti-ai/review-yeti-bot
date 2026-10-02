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
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-logr/logr"
	batchv1 "k8s.io/api/batch/v1"
	coordinationv1 "k8s.io/api/coordination/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	meta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/record"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/cache"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"
	"sigs.k8s.io/controller-runtime/pkg/config"
	"sigs.k8s.io/controller-runtime/pkg/healthz"
	"sigs.k8s.io/controller-runtime/pkg/manager"
	"sigs.k8s.io/controller-runtime/pkg/webhook"

	reviewv1alpha2 "github.com/review-yeti-ai/review-yeti-bot/k8s-operator/api/v1alpha2"
	"github.com/review-yeti-ai/review-yeti-bot/k8s-operator/controllers"
	"github.com/review-yeti-ai/review-yeti-bot/k8s-operator/pkg/job"
)

// makeM4OCCConcurrencyInterceptor wraps ConcurrencyMonitor and serializes Lease updates
// to mimic atomic etcd CAS transactions in the in-memory fake client.
func makeM4OCCConcurrencyInterceptor(monitor *ConcurrencyMonitor) interceptor.Funcs {
	var leaseMu sync.Mutex
	funcs := monitor.InterceptorFuncs()
	update := funcs.Update
	funcs.Update = func(ctx context.Context, c client.WithWatch, obj client.Object, opts ...client.UpdateOption) error {
		if _, ok := obj.(*coordinationv1.Lease); ok {
			leaseMu.Lock()
			defer leaseMu.Unlock()
		}
		return update(ctx, c, obj, opts...)
	}
	return funcs
}

type fixtureReconcileOutcome struct {
	request types.NamespacedName
	result  ctrl.Result
	err     error
}

// reconcileM4Batch executes one concurrent round of Reconcile across all provided reviews
// using exactly the specified number of worker goroutines.
func reconcileM4Batch(
	ctx context.Context,
	reconciler *controllers.PRReviewJobV1Alpha2Reconciler,
	reviews []*reviewv1alpha2.PRReviewJob,
	threads int,
) []fixtureReconcileOutcome {
	outcomes := make([]fixtureReconcileOutcome, len(reviews))
	var wg sync.WaitGroup
	start := make(chan struct{})
	ch := make(chan int, len(reviews))
	for i := range reviews {
		ch <- i
	}
	close(ch)

	for i := 0; i < threads; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			for index := range ch {
				rev := reviews[index]
				req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: rev.Namespace, Name: rev.Name}}
				result, err := reconciler.Reconcile(ctx, req)
				outcomes[index] = fixtureReconcileOutcome{request: req.NamespacedName, result: result, err: err}
			}
		}()
	}
	close(start)
	wg.Wait()
	logger := logr.FromContextOrDiscard(ctx)
	for _, outcome := range outcomes {
		if outcome.err != nil {
			logger.Error(outcome.err, "fixture reconcile failed", "request", outcome.request, "result", outcome.result)
		} else if outcome.result.Requeue || outcome.result.RequeueAfter > 0 {
			logger.Info("fixture reconcile requeued", "request", outcome.request, "result", outcome.result)
		}
	}
	return outcomes
}

// -----------------------------------------------------------------------------
// Suite 1: Parameterized Matrix Burst Admission
// -----------------------------------------------------------------------------

// TestM4_Integration_ConcurrencyMatrix_BurstAdmission evaluates burst admission safety
// across the full concurrency matrix: threads in {1, 4, 16} and capacity limits in {4, 10}.
func TestM4_Integration_ConcurrencyMatrix_BurstAdmission(t *testing.T) {
	now := time.Date(2026, 9, 30, 15, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)

	testCases := []struct {
		threads      int
		limit        int
		burstReviews int
	}{
		{threads: 1, limit: 4, burstReviews: 24},
		{threads: 4, limit: 4, burstReviews: 24},
		{threads: 16, limit: 4, burstReviews: 32},
		{threads: 1, limit: 10, burstReviews: 30},
		{threads: 4, limit: 10, burstReviews: 30},
		{threads: 16, limit: 10, burstReviews: 50},
	}

	for _, tc := range testCases {
		name := fmt.Sprintf("%dThreads_Limit%d_Burst%d", tc.threads, tc.limit, tc.burstReviews)
		t.Run(name, func(t *testing.T) {
			reviews := makeBurstReviews(now, tc.burstReviews, fmt.Sprintf("m4-bm-%d-%d", tc.threads, tc.limit))
			clientObjs := make([]client.Object, len(reviews))
			for i, r := range reviews {
				clientObjs[i] = r
			}

			monitor := NewConcurrencyMonitor(int32(tc.limit))
			kube := fake.NewClientBuilder().
				WithScheme(scheme).
				WithObjects(clientObjs...).
				WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}, &batchv1.Job{}).
				WithInterceptorFuncs(makeM4OCCConcurrencyInterceptor(monitor)).
				Build()

			reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
				Client:                  kube,
				Scheme:                  scheme,
				Now:                     func() time.Time { return now },
				MaxConcurrentJobs:       tc.limit,
				MaxConcurrentReconciles: tc.threads,
			}

			ctx := context.Background()
			t0 := time.Now()
			if err := reconcileUntilSettled(ctx, reconciler, reviews, tc.threads); err != nil {
				t.Fatalf("settle fixture: %v", err)
			}
			elapsed := time.Since(t0)

			if elapsed > 30*time.Second {
				t.Fatalf("Burst reconciliation exceeded time bound: %v (expected < 30s)", elapsed)
			}

			if monitor.MaxObservedActive() > int32(tc.limit) {
				t.Fatalf("Active worker jobs %d exceeded limit %d. Violations: %v",
					monitor.MaxObservedActive(), tc.limit, monitor.Violations())
			}

			running := 0
			queued := 0
			for _, r := range reviews {
				var cur reviewv1alpha2.PRReviewJob
				if err := kube.Get(ctx, types.NamespacedName{Namespace: r.Namespace, Name: r.Name}, &cur); err != nil {
					t.Fatalf("get %s: %v", r.Name, err)
				}
				if cur.Status.Phase == reviewv1alpha2.PhaseRunning {
					running++
				} else if cur.Status.Phase == reviewv1alpha2.PhaseQueued {
					queued++
				}
			}

			if running != tc.limit {
				t.Fatalf("expected %d running reviews, got %d", tc.limit, running)
			}
			if queued != tc.burstReviews-tc.limit {
				t.Fatalf("expected %d queued reviews, got %d", tc.burstReviews-tc.limit, queued)
			}

			// Invariant: FIFO ordering guarantees oldest received reviews are admitted first
			for i := 0; i < tc.limit; i++ {
				var cur reviewv1alpha2.PRReviewJob
				if err := kube.Get(ctx, types.NamespacedName{Namespace: reviews[i].Namespace, Name: reviews[i].Name}, &cur); err != nil {
					t.Fatalf("get %s: %v", reviews[i].Name, err)
				}
				if cur.Status.Phase != reviewv1alpha2.PhaseRunning {
					t.Fatalf("expected oldest review %s (index %d) to be Running, got %s", reviews[i].Name, i, cur.Status.Phase)
				}
			}
		})
	}
}

// -----------------------------------------------------------------------------
// Suite 2: Dynamic Lifecycle Turnover & Slot Recycling Across Threads
// -----------------------------------------------------------------------------

// TestM4_Integration_DynamicLifecycle_SlotRecycling_AcrossThreads verifies continuous
// slot recycling when workers complete and fail under 1, 4, and 16 concurrent threads.
func TestM4_Integration_DynamicLifecycle_SlotRecycling_AcrossThreads(t *testing.T) {
	now := time.Date(2026, 9, 30, 15, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)

	threadCounts := []int{1, 4, 16}

	for _, threads := range threadCounts {
		name := fmt.Sprintf("%dThreads", threads)
		t.Run(name, func(t *testing.T) {
			const limit = 4
			const totalReviews = 16
			reviews := makeBurstReviews(now, totalReviews, fmt.Sprintf("m4-dyn-%d", threads))
			clientObjs := make([]client.Object, len(reviews))
			for i, r := range reviews {
				clientObjs[i] = r
			}

			monitor := NewConcurrencyMonitor(limit)
			kube := fake.NewClientBuilder().
				WithScheme(scheme).
				WithObjects(clientObjs...).
				WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}, &batchv1.Job{}).
				WithInterceptorFuncs(makeM4OCCConcurrencyInterceptor(monitor)).
				Build()

			reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
				Client:                  kube,
				Scheme:                  scheme,
				Now:                     func() time.Time { return now },
				MaxConcurrentJobs:       limit,
				MaxConcurrentReconciles: threads,
			}

			ctx := context.Background()

			// Step 1: Initial burst admission. Exactly 4 must be Running, 12 Queued.
			if err := reconcileUntilSettled(ctx, reconciler, reviews, threads); err != nil {
				t.Fatalf("settle fixture: %v", err)
			}

			var runningReviews []*reviewv1alpha2.PRReviewJob
			for _, r := range reviews {
				var cur reviewv1alpha2.PRReviewJob
				if err := kube.Get(ctx, types.NamespacedName{Namespace: r.Namespace, Name: r.Name}, &cur); err != nil {
					t.Fatalf("get %s: %v", r.Name, err)
				}
				if cur.Status.Phase == reviewv1alpha2.PhaseRunning {
					runningReviews = append(runningReviews, r)
				}
			}
			if len(runningReviews) != limit {
				t.Fatalf("expected initial %d running reviews, got %d", limit, len(runningReviews))
			}

			// Step 2: Complete Review 0 & 1, fail Review 2. Review 3 stays Running.
			// Mark Review 0 succeeded
			{
				var w0 batchv1.Job
				wName0 := runningReviews[0].Name + "-worker"
				if err := kube.Get(ctx, types.NamespacedName{Namespace: runningReviews[0].Namespace, Name: wName0}, &w0); err != nil {
					t.Fatalf("get worker 0: %v", err)
				}
				attachReceiptAnnotations(&w0)
				if err := kube.Update(ctx, &w0); err != nil {
					t.Fatalf("update worker 0 annotations: %v", err)
				}
				w0.Status.Succeeded = 1
				w0.Status.Conditions = []batchv1.JobCondition{{Type: batchv1.JobComplete, Status: corev1.ConditionTrue}}
				if err := kube.Status().Update(ctx, &w0); err != nil {
					t.Fatalf("update worker 0 status: %v", err)
				}
			}

			// Mark Review 1 succeeded
			{
				var w1 batchv1.Job
				wName1 := runningReviews[1].Name + "-worker"
				if err := kube.Get(ctx, types.NamespacedName{Namespace: runningReviews[1].Namespace, Name: wName1}, &w1); err != nil {
					t.Fatalf("get worker 1: %v", err)
				}
				attachReceiptAnnotations(&w1)
				if err := kube.Update(ctx, &w1); err != nil {
					t.Fatalf("update worker 1 annotations: %v", err)
				}
				w1.Status.Succeeded = 1
				w1.Status.Conditions = []batchv1.JobCondition{{Type: batchv1.JobComplete, Status: corev1.ConditionTrue}}
				if err := kube.Status().Update(ctx, &w1); err != nil {
					t.Fatalf("update worker 1 status: %v", err)
				}
			}

			// Mark Review 2 failed
			{
				var w2 batchv1.Job
				wName2 := runningReviews[2].Name + "-worker"
				if err := kube.Get(ctx, types.NamespacedName{Namespace: runningReviews[2].Namespace, Name: wName2}, &w2); err != nil {
					t.Fatalf("get worker 2: %v", err)
				}
				w2.Status.Failed = 1
				w2.Status.Conditions = []batchv1.JobCondition{{Type: batchv1.JobFailed, Status: corev1.ConditionTrue}}
				if err := kube.Status().Update(ctx, &w2); err != nil {
					t.Fatalf("update worker 2 status: %v", err)
				}
			}

			// Step 3: Reconcile terminal reviews across parallel threads to transition and release slots
			terminalBatch := []*reviewv1alpha2.PRReviewJob{runningReviews[0], runningReviews[1], runningReviews[2]}
			for _, outcome := range reconcileM4Batch(ctx, reconciler, terminalBatch, threads) {
				if outcome.err != nil {
					t.Fatalf("reconcile %s: %v", outcome.request, outcome.err)
				}
			}

			// Step 4: Reconcile all reviews to promote the next queued reviews into the 3 freed slots
			if err := reconcileUntilSettled(ctx, reconciler, reviews, threads); err != nil {
				t.Fatalf("recycle fixture: %v", err)
			}

			// Step 5: Assert invariants
			var cur0, cur1, cur2 reviewv1alpha2.PRReviewJob
			_ = kube.Get(ctx, types.NamespacedName{Namespace: runningReviews[0].Namespace, Name: runningReviews[0].Name}, &cur0)
			_ = kube.Get(ctx, types.NamespacedName{Namespace: runningReviews[1].Namespace, Name: runningReviews[1].Name}, &cur1)
			_ = kube.Get(ctx, types.NamespacedName{Namespace: runningReviews[2].Namespace, Name: runningReviews[2].Name}, &cur2)

			if cur0.Status.Phase != reviewv1alpha2.PhaseSucceeded {
				t.Fatalf("expected Review 0 Succeeded, got %s", cur0.Status.Phase)
			}
			if cur1.Status.Phase != reviewv1alpha2.PhaseSucceeded {
				t.Fatalf("expected Review 1 Succeeded, got %s", cur1.Status.Phase)
			}
			if cur2.Status.Phase != reviewv1alpha2.PhaseFailed {
				t.Fatalf("expected Review 2 Failed, got %s", cur2.Status.Phase)
			}

			// Count currently running reviews: must be exactly limit (4)
			runningCount := 0
			succeededCount := 0
			failedCount := 0
			queuedCount := 0
			for _, r := range reviews {
				var cur reviewv1alpha2.PRReviewJob
				if err := kube.Get(ctx, types.NamespacedName{Namespace: r.Namespace, Name: r.Name}, &cur); err != nil {
					t.Fatalf("get %s: %v", r.Name, err)
				}
				switch cur.Status.Phase {
				case reviewv1alpha2.PhaseRunning:
					runningCount++
				case reviewv1alpha2.PhaseSucceeded:
					succeededCount++
				case reviewv1alpha2.PhaseFailed:
					failedCount++
				case reviewv1alpha2.PhaseQueued:
					queuedCount++
				}
			}

			if runningCount != limit {
				t.Fatalf("expected %d running reviews after slot turnover, got %d", limit, runningCount)
			}
			if succeededCount != 2 {
				t.Fatalf("expected 2 succeeded reviews, got %d", succeededCount)
			}
			if failedCount != 1 {
				t.Fatalf("expected 1 failed review, got %d", failedCount)
			}
			if queuedCount != totalReviews-limit-succeededCount-failedCount {
				t.Fatalf("expected %d queued reviews, got %d", totalReviews-limit-succeededCount-failedCount, queuedCount)
			}

			if monitor.MaxObservedActive() > limit {
				t.Fatalf("limit exceeded during turnover: max %d", monitor.MaxObservedActive())
			}
		})
	}
}

// -----------------------------------------------------------------------------
// Suite 3: Error Handling & Requeue Backoff Under High Concurrency
// -----------------------------------------------------------------------------

// TestM4_Integration_ErrorHandling_OCCConflictBackoff_16Threads verifies that when Lease
// updates exhaust retries due to extreme contention, conflictRequeue converts the conflict
// into a quiet requeue after 2 seconds with error = nil.
func TestM4_Integration_ErrorHandling_OCCConflictBackoff_16Threads(t *testing.T) {
	now := time.Date(2026, 9, 30, 15, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)

	const totalReviews = 8
	const maxJobs = 4
	reviews := makeBurstReviews(now, totalReviews, "m4-occ")
	clientObjs := make([]client.Object, len(reviews))
	for i, r := range reviews {
		clientObjs[i] = r
	}

	// Pre-seed the singleton Lease so AcquireSlot hits the Update branch rather than Create
	lease := &coordinationv1.Lease{
		ObjectMeta: metav1.ObjectMeta{
			Name:      controllers.CapacityLedgerLeaseName,
			Namespace: "ct-review-system",
		},
	}
	clientObjs = append(clientObjs, lease)

	var conflictInjected int32
	kube := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(clientObjs...).
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}, &batchv1.Job{}).
		WithInterceptorFuncs(interceptor.Funcs{
			Update: func(ctx context.Context, c client.WithWatch, obj client.Object, opts ...client.UpdateOption) error {
				if l, ok := obj.(*coordinationv1.Lease); ok && l.Name == controllers.CapacityLedgerLeaseName {
					atomic.AddInt32(&conflictInjected, 1)
					return apierrors.NewConflict(
						schema.GroupResource{Group: "coordination.k8s.io", Resource: "leases"},
						l.Name,
						errors.New("simulated OCC conflict"),
					)
				}
				return c.Update(ctx, obj, opts...)
			},
		}).
		Build()

	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client:                  kube,
		Scheme:                  scheme,
		Now:                     func() time.Time { return now },
		MaxConcurrentJobs:       maxJobs,
		MaxConcurrentReconciles: 16,
	}

	ctx := context.Background()
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: reviews[0].Namespace, Name: reviews[0].Name}}
	result, err := reconciler.Reconcile(ctx, req)

	// Invariant: conflictRequeue converts conflict error to nil and returns RequeueAfter: 2s
	if err != nil {
		t.Fatalf("expected nil error after conflictRequeue conversion, got: %v", err)
	}
	if result.RequeueAfter != 2*time.Second {
		t.Fatalf("expected RequeueAfter: 2s, got: %v", result.RequeueAfter)
	}
	if atomic.LoadInt32(&conflictInjected) == 0 {
		t.Fatalf("expected conflict interceptor to be invoked")
	}
}

// TestM4_Integration_ErrorHandling_CapacityExceededBackoff_16Threads verifies that
// when capacity is saturated, reconciler returns RequeueAfter: 5s with err == nil
// and marks status CapacityExceeded: True.
func TestM4_Integration_ErrorHandling_CapacityExceededBackoff_16Threads(t *testing.T) {
	now := time.Date(2026, 9, 30, 15, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)

	// Limit 1: Review 0 gets admitted, Review 1 gets CapacityExceeded
	reviews := makeBurstReviews(now, 2, "m4-capex")
	clientObjs := []client.Object{reviews[0], reviews[1]}

	kube := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(clientObjs...).
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}, &batchv1.Job{}).
		Build()

	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client:                  kube,
		Scheme:                  scheme,
		Now:                     func() time.Time { return now },
		MaxConcurrentJobs:       1,
		MaxConcurrentReconciles: 16,
	}

	ctx := context.Background()

	// Admit Review 0
	req0 := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: reviews[0].Namespace, Name: reviews[0].Name}}
	_, err := reconciler.Reconcile(ctx, req0)
	if err != nil {
		t.Fatalf("reconcile 0: %v", err)
	}

	// Reconcile Review 1: capacity is saturated
	req1 := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: reviews[1].Namespace, Name: reviews[1].Name}}
	result, err := reconciler.Reconcile(ctx, req1)
	if err != nil {
		t.Fatalf("expected nil error on capacity exceeded, got: %v", err)
	}
	if result.RequeueAfter != 5*time.Second {
		t.Fatalf("expected RequeueAfter: 5s, got: %v", result.RequeueAfter)
	}

	var cur1 reviewv1alpha2.PRReviewJob
	if err := kube.Get(ctx, req1.NamespacedName, &cur1); err != nil {
		t.Fatalf("get review 1: %v", err)
	}
	if cur1.Status.Phase != reviewv1alpha2.PhaseQueued {
		t.Fatalf("expected PhaseQueued, got %s", cur1.Status.Phase)
	}
	if !meta.IsStatusConditionTrue(cur1.Status.Conditions, "CapacityExceeded") {
		t.Fatalf("expected condition CapacityExceeded: True")
	}
}

// TestM4_Integration_ErrorHandling_TransientAPI500_SlotRelease verifies that when
// worker admission encounters an unexpected API error after acquiring a capacity slot,
// the capacity slot is immediately released to prevent slot leaks.
func TestM4_Integration_ErrorHandling_TransientAPI500_SlotRelease(t *testing.T) {
	now := time.Date(2026, 9, 30, 15, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)

	review := v1alpha2Review(now)
	review.Name = "ct-review-transient-500"

	kube := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(review).
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}, &batchv1.Job{}).
		WithInterceptorFuncs(interceptor.Funcs{
			Get: func(ctx context.Context, c client.WithWatch, key client.ObjectKey, obj client.Object, opts ...client.GetOption) error {
				// Inject transient 500 error when workspace LeaseManager attempts to check the PR workspace lease
				if _, ok := obj.(*coordinationv1.Lease); ok && key.Name != controllers.CapacityLedgerLeaseName {
					return apierrors.NewInternalError(errors.New("etcd connection timeout"))
				}
				return c.Get(ctx, key, obj, opts...)
			},
		}).
		Build()

	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client:                  kube,
		Scheme:                  scheme,
		Now:                     func() time.Time { return now },
		MaxConcurrentJobs:       4,
		MaxConcurrentReconciles: 16,
	}

	ctx := context.Background()
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}
	_, err := reconciler.Reconcile(ctx, req)
	if err != nil {
		t.Fatalf("reconcile returned unexpected error: %v", err)
	}

	// Verify review was transitioned to PhaseFailed due to lease rejection
	var cur reviewv1alpha2.PRReviewJob
	if err := kube.Get(ctx, req.NamespacedName, &cur); err != nil {
		t.Fatalf("get review: %v", err)
	}
	if cur.Status.Phase != reviewv1alpha2.PhaseFailed {
		t.Fatalf("expected PhaseFailed, got %s", cur.Status.Phase)
	}

	// Verify slot was released: Lease active slots should be empty
	var lease coordinationv1.Lease
	if err := kube.Get(ctx, types.NamespacedName{Namespace: review.Namespace, Name: controllers.CapacityLedgerLeaseName}, &lease); err == nil {
		slotsJson := lease.Annotations["ct.review.example.com/active-slots"]
		if slotsJson != "" && slotsJson != "[]" {
			t.Fatalf("expected active slots to be released after API failure, got: %s", slotsJson)
		}
	}
}

// TestM4_Integration_ErrorHandling_CorruptedLeaseRecovery_16Threads verifies that
// if the capacity ledger Lease annotation is corrupted with invalid JSON, the reconciler
// recovers gracefully without panic and enforces capacity safely.
func TestM4_Integration_ErrorHandling_CorruptedLeaseRecovery_16Threads(t *testing.T) {
	now := time.Date(2026, 9, 30, 15, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)

	const limit = 4
	const totalReviews = 10
	reviews := makeBurstReviews(now, totalReviews, "m4-corrupt")
	clientObjs := make([]client.Object, len(reviews))
	for i, r := range reviews {
		clientObjs[i] = r
	}

	// Pre-seed corrupted Lease
	corruptedLease := &coordinationv1.Lease{
		ObjectMeta: metav1.ObjectMeta{
			Name:      controllers.CapacityLedgerLeaseName,
			Namespace: "ct-review-system",
			Annotations: map[string]string{
				"ct.review.example.com/active-slots": "{corrupted-json-payload",
			},
		},
	}
	clientObjs = append(clientObjs, corruptedLease)

	monitor := NewConcurrencyMonitor(limit)
	kube := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(clientObjs...).
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}, &batchv1.Job{}).
		WithInterceptorFuncs(makeM4OCCConcurrencyInterceptor(monitor)).
		Build()

	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client:                  kube,
		Scheme:                  scheme,
		Now:                     func() time.Time { return now },
		MaxConcurrentJobs:       limit,
		MaxConcurrentReconciles: 16,
	}

	ctx := context.Background()

	// Should not panic under 16 concurrent threads
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("reconciler panicked on corrupted lease: %v", r)
		}
	}()

	if err := reconcileUntilSettled(ctx, reconciler, reviews, 16); err != nil {
		t.Fatalf("settle fixture: %v", err)
	}

	running := 0
	for _, r := range reviews {
		var cur reviewv1alpha2.PRReviewJob
		if err := kube.Get(ctx, types.NamespacedName{Namespace: r.Namespace, Name: r.Name}, &cur); err == nil {
			if cur.Status.Phase == reviewv1alpha2.PhaseRunning {
				running++
			}
		}
	}

	if running != limit {
		t.Fatalf("expected %d running reviews after recovering corrupted lease, got %d", limit, running)
	}
}

// -----------------------------------------------------------------------------
// Suite 4: Decoupled External Receipt Isolation Across Threads
// -----------------------------------------------------------------------------

// TestM4_Integration_DecoupledReceipt_ZeroWorkerContention verifies that when an external
// receipt HTTP endpoint hangs (3000ms delay), reconciler loops across 1, 4, and 16 threads
// are never blocked.
func TestM4_Integration_DecoupledReceipt_ZeroWorkerContention(t *testing.T) {
	now := time.Date(2026, 9, 30, 15, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)

	threadCounts := []int{1, 4, 16}

	for _, threads := range threadCounts {
		name := fmt.Sprintf("%dThreads", threads)
		t.Run(name, func(t *testing.T) {
			slowServer := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				time.Sleep(3 * time.Second)
				w.WriteHeader(http.StatusGatewayTimeout)
			}))
			defer slowServer.Close()

			runHex := fmt.Sprintf("%032x", 900+threads)
			slowReview := v1alpha2Review(now)
			slowReview.Name = fmt.Sprintf("ct-review-slow-%d", threads)
			slowReview.Spec.RunID = "run_" + runHex
			slowReview.Spec.RunSecretName = "ct-review-run-" + runHex
			slowReview.Spec.PublicationMode = job.PublicationModeAppGate
			slowReview.Status.Phase = reviewv1alpha2.PhaseRunning
			slowReview.Status.JobName = slowReview.Name + "-worker"

			publishingConfig := job.PublishingConfig{
				GatewayBaseURL:    "https://gateway.example.invalid/v1",
				Model:             "ollama/glm-5.3-flash",
				GatewaySecretName: "review-yeti-gateway-credentials",
				GatewaySecretKey:  "REVIEW_YETI_BIFROST_API_KEY",
				CompletionURL:     slowServer.URL + "/api/dispatch/completion",
			}

			workerJob, err := job.BuildWorkerJob(job.Input{
				Review:         slowReview,
				WorkspaceLease: testLeaseFixture(now, slowReview.Spec.RepositoryID, slowReview.Spec.PRNumber, slowReview.Spec.RunID),
				Now:            now,
				Publishing:     publishingConfig,
			})
			if err != nil {
				t.Fatalf("build worker: %v", err)
			}
			workerJob.Status.Succeeded = 1
			workerJob.Status.Conditions = []batchv1.JobCondition{{Type: batchv1.JobComplete, Status: corev1.ConditionTrue}}

			secret := &corev1.Secret{
				ObjectMeta: metav1.ObjectMeta{Name: slowReview.Spec.RunSecretName, Namespace: slowReview.Namespace},
				Data:       map[string][]byte{"GITHUB_PUBLISH_TOKEN": []byte("test-token")},
			}

			fastReviews := makeBurstReviews(now, 8, fmt.Sprintf("m4-fast-%d", threads))
			clientObjs := []client.Object{slowReview, workerJob, secret}
			for _, r := range fastReviews {
				clientObjs = append(clientObjs, r)
			}

			kube := fake.NewClientBuilder().
				WithScheme(scheme).
				WithObjects(clientObjs...).
				WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}, &batchv1.Job{}).
				Build()

			reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
				Client:                  kube,
				SecretReader:            kube,
				Scheme:                  scheme,
				Now:                     func() time.Time { return now },
				ReceiptHTTPClient:       slowServer.Client(),
				Publishing:              publishingConfig,
				MaxConcurrentJobs:       4,
				MaxConcurrentReconciles: threads,
			}
			coordinator := controllers.NewAppGateReceiptCoordinator(reconciler)
			coordinator.WaitTimeout = 10 * time.Millisecond
			reconciler.ReceiptCoordinator = coordinator

			ctx := context.Background()
			t0 := time.Now()

			allReviews := append([]*reviewv1alpha2.PRReviewJob{slowReview}, fastReviews...)
			for _, outcome := range reconcileM4Batch(ctx, reconciler, allReviews, threads) {
				if outcome.err != nil {
					t.Fatalf("reconcile %s: %v", outcome.request, outcome.err)
				}
			}
			elapsed := time.Since(t0)

			// Invariant: Entire burst settles in < 500ms despite the 3000ms slow server
			if elapsed > 500*time.Millisecond {
				t.Fatalf("Parallel reconciles blocked by slow endpoint: elapsed %v (expected < 500ms)", elapsed)
			}
		})
	}
}

// -----------------------------------------------------------------------------
// Suite 5: Concurrent In-Flight Cancellation & Atomic Slot Reclamation
// -----------------------------------------------------------------------------

// TestM4_Integration_ConcurrentCancellation_AtomicSlotReclamation tests simultaneous
// cancellation of running and queued reviews under 16-thread pressure.
func TestM4_Integration_ConcurrentCancellation_AtomicSlotReclamation(t *testing.T) {
	t.Setenv("REVIEW_YETI_TERMINAL_RETENTION_SECONDS", "3600")

	now := time.Date(2026, 9, 30, 15, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)

	const limit = 4
	const totalReviews = 16
	reviews := makeBurstReviews(now, totalReviews, "m4-cancel")
	clientObjs := make([]client.Object, len(reviews))
	for i, r := range reviews {
		clientObjs[i] = r
	}

	monitor := NewConcurrencyMonitor(limit)
	kube := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(clientObjs...).
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}, &batchv1.Job{}).
		WithInterceptorFuncs(makeM4OCCConcurrencyInterceptor(monitor)).
		Build()

	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client:                  kube,
		Scheme:                  scheme,
		Now:                     func() time.Time { return now },
		MaxConcurrentJobs:       limit,
		MaxConcurrentReconciles: 16,
	}

	ctx := context.Background()

	// Initial admission: 4 running, 12 queued
	if err := reconcileUntilSettled(ctx, reconciler, reviews, 16); err != nil {
		t.Fatalf("settle fixture: %v", err)
	}

	// Identify running reviews vs queued reviews
	var runningIndices []int
	var queuedIndices []int
	for i, r := range reviews {
		var rev reviewv1alpha2.PRReviewJob
		if err := kube.Get(ctx, types.NamespacedName{Namespace: r.Namespace, Name: r.Name}, &rev); err == nil {
			if rev.Status.Phase == reviewv1alpha2.PhaseRunning {
				runningIndices = append(runningIndices, i)
			} else if rev.Status.Phase == reviewv1alpha2.PhaseQueued {
				queuedIndices = append(queuedIndices, i)
			}
		}
	}
	if len(runningIndices) != limit {
		t.Fatalf("expected %d running reviews initially, got %d", limit, len(runningIndices))
	}
	if len(queuedIndices) < 2 {
		t.Fatalf("expected at least 2 queued reviews initially, got %d", len(queuedIndices))
	}

	// Mark 2 running reviews and 2 queued reviews as cancelled
	cancelReason := "superseded by new push"
	cancelledRunning := runningIndices[:2]
	cancelledQueued := queuedIndices[:2]
	for _, idx := range append(cancelledRunning, cancelledQueued...) {
		var rev reviewv1alpha2.PRReviewJob
		if err := kube.Get(ctx, types.NamespacedName{Namespace: reviews[idx].Namespace, Name: reviews[idx].Name}, &rev); err != nil {
			t.Fatalf("get %s: %v", reviews[idx].Name, err)
		}
		rev.Spec.CancelRequested = testBoolPtr(true)
		rev.Spec.CancelReason = &cancelReason
		if err := kube.Update(ctx, &rev); err != nil {
			t.Fatalf("update cancel %s: %v", reviews[idx].Name, err)
		}
	}

	// Reconcile across 16 threads until freed slots are reclaimed and saturated
	for round := 0; round < 10; round++ {
		for _, outcome := range reconcileM4Batch(ctx, reconciler, reviews, 16) {
			if outcome.err != nil {
				t.Fatalf("reconcile %s: %v", outcome.request, outcome.err)
			}
		}
		runningCount := 0
		for _, r := range reviews {
			var rev reviewv1alpha2.PRReviewJob
			if err := kube.Get(ctx, types.NamespacedName{Namespace: r.Namespace, Name: r.Name}, &rev); err == nil {
				if rev.Status.Phase == reviewv1alpha2.PhaseRunning {
					runningCount++
				}
			}
		}
		if runningCount == limit {
			break
		}
	}

	// For running reviews that were cancelled: must transition to PhaseCancelled and worker job deleted
	for _, idx := range cancelledRunning {
		var rev reviewv1alpha2.PRReviewJob
		if err := kube.Get(ctx, types.NamespacedName{Namespace: reviews[idx].Namespace, Name: reviews[idx].Name}, &rev); err != nil {
			t.Fatalf("get running review %s: %v", reviews[idx].Name, err)
		}
		if rev.Status.Phase != reviewv1alpha2.PhaseCancelled {
			t.Fatalf("expected running review %s in PhaseCancelled, got %s", rev.Name, rev.Status.Phase)
		}
		var w batchv1.Job
		wErr := kube.Get(ctx, types.NamespacedName{Namespace: reviews[idx].Namespace, Name: rev.Name + "-worker"}, &w)
		if !apierrors.IsNotFound(wErr) {
			t.Fatalf("expected worker job to be deleted for cancelled review %s, got: %v", rev.Name, wErr)
		}
	}

	// For queued reviews that were cancelled: either deleted without pod or marked PhaseCancelled
	for _, idx := range cancelledQueued {
		var rev reviewv1alpha2.PRReviewJob
		err := kube.Get(ctx, types.NamespacedName{Namespace: reviews[idx].Namespace, Name: reviews[idx].Name}, &rev)
		if err != nil && !apierrors.IsNotFound(err) {
			t.Fatalf("unexpected error getting queued review %s: %v", reviews[idx].Name, err)
		}
		if err == nil && rev.Status.Phase != reviewv1alpha2.PhaseCancelled {
			t.Fatalf("expected queued review %s to be deleted or PhaseCancelled, got phase %s", rev.Name, rev.Status.Phase)
		}
	}

	// Running reviews count should remain exactly limit (4) as queued reviews took vacated slots
	runningCount := 0
	for _, r := range reviews {
		var rev reviewv1alpha2.PRReviewJob
		if err := kube.Get(ctx, types.NamespacedName{Namespace: r.Namespace, Name: r.Name}, &rev); err == nil {
			if rev.Status.Phase == reviewv1alpha2.PhaseRunning {
				runningCount++
			}
		}
	}

	if runningCount != limit {
		t.Fatalf("expected %d running reviews after cancellation reclamation, got %d", limit, runningCount)
	}
	if monitor.MaxObservedActive() > limit {
		t.Fatalf("over-admission during cancellation: %d > %d", monitor.MaxObservedActive(), limit)
	}
}

// -----------------------------------------------------------------------------
// Suite 6: SetupWithManager Concurrency Wiring Qualification
// -----------------------------------------------------------------------------

type mockManagerV1Alpha2 struct {
	scheme *runtime.Scheme
	client client.Client
}

func (m *mockManagerV1Alpha2) SetFields(interface{}) error                              { return nil }
func (m *mockManagerV1Alpha2) Add(manager.Runnable) error                               { return nil }
func (m *mockManagerV1Alpha2) AddHealthzCheck(name string, check healthz.Checker) error { return nil }
func (m *mockManagerV1Alpha2) AddReadyzCheck(name string, check healthz.Checker) error  { return nil }
func (m *mockManagerV1Alpha2) AddMetricsServerExtraHandler(path string, handler http.Handler) error {
	return nil
}
func (m *mockManagerV1Alpha2) GetHTTPClient() *http.Client      { return &http.Client{} }
func (m *mockManagerV1Alpha2) GetWebhookServer() webhook.Server { return nil }
func (m *mockManagerV1Alpha2) Elected() <-chan struct{} {
	ch := make(chan struct{})
	close(ch)
	return ch
}
func (m *mockManagerV1Alpha2) Start(ctx context.Context) error      { return nil }
func (m *mockManagerV1Alpha2) GetConfig() *rest.Config              { return &rest.Config{} }
func (m *mockManagerV1Alpha2) GetScheme() *runtime.Scheme           { return m.scheme }
func (m *mockManagerV1Alpha2) GetClient() client.Client             { return m.client }
func (m *mockManagerV1Alpha2) GetFieldIndexer() client.FieldIndexer { return nil }
func (m *mockManagerV1Alpha2) GetCache() cache.Cache                { return nil }
func (m *mockManagerV1Alpha2) GetEventRecorderFor(name string) record.EventRecorder {
	return record.NewFakeRecorder(10)
}
func (m *mockManagerV1Alpha2) GetRESTMapper() meta.RESTMapper {
	rm := meta.NewDefaultRESTMapper([]schema.GroupVersion{
		reviewv1alpha2.GroupVersion,
		batchv1.SchemeGroupVersion,
		corev1.SchemeGroupVersion,
	})
	rm.Add(reviewv1alpha2.GroupVersion.WithKind("PRReviewJob"), meta.RESTScopeNamespace)
	rm.Add(batchv1.SchemeGroupVersion.WithKind("Job"), meta.RESTScopeNamespace)
	return rm
}
func (m *mockManagerV1Alpha2) GetAPIReader() client.Reader { return m.client }
func (m *mockManagerV1Alpha2) GetLogger() logr.Logger      { return logr.Discard() }
func (m *mockManagerV1Alpha2) GetControllerOptions() config.Controller {
	return config.Controller{}
}

// TestM4_Integration_SetupWithManager_ConcurrencyWiring tests that ClampedMaxConcurrentReconciles
// gracefully accepts and clamps MaxConcurrentReconciles configurations.
func TestM4_Integration_SetupWithManager_ConcurrencyWiring(t *testing.T) {
	testCases := []struct {
		name       string
		configured int
		expected   int
	}{
		{name: "zero defaults to 1", configured: 0, expected: 1},
		{name: "negative clamps to 1", configured: -5, expected: 1},
		{name: "standard 1", configured: 1, expected: 1},
		{name: "standard 4", configured: 4, expected: 4},
		{name: "standard 16", configured: 16, expected: 16},
		{name: "large clamps to 64", configured: 1000, expected: controllers.MaxV1Alpha2ReconcileConcurrencyCap},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
				MaxConcurrentReconciles: tc.configured,
			}
			got := reconciler.ClampedMaxConcurrentReconciles()
			if got != tc.expected {
				t.Fatalf("ClampedMaxConcurrentReconciles() = %d, want %d", got, tc.expected)
			}
		})
	}
}

// This context logger observes real returned outcomes after a closed batch.
// It does not call the controller or manufacture success, errors, or requeues.
type fixtureLogEntry struct {
	err    error
	values map[string]any
}

type fixtureLogState struct {
	mu      sync.Mutex
	entries []fixtureLogEntry
}

type fixtureLogSink struct {
	state  *fixtureLogState
	values []any
}

func (s *fixtureLogSink) Init(logr.RuntimeInfo) {}
func (s *fixtureLogSink) Enabled(int) bool     { return true }
func (s *fixtureLogSink) WithName(string) logr.LogSink {
	return &fixtureLogSink{state: s.state, values: append([]any(nil), s.values...)}
}
func (s *fixtureLogSink) WithValues(values ...any) logr.LogSink {
	return &fixtureLogSink{state: s.state, values: append(append([]any(nil), s.values...), values...)}
}
func (s *fixtureLogSink) Info(_ int, _ string, values ...any) { s.record(nil, values) }
func (s *fixtureLogSink) Error(err error, _ string, values ...any) {
	s.record(err, values)
}
func (s *fixtureLogSink) record(err error, values []any) {
	all := append(append([]any(nil), s.values...), values...)
	entry := fixtureLogEntry{err: err, values: make(map[string]any)}
	for i := 0; i+1 < len(all); i += 2 {
		if key, ok := all[i].(string); ok {
			entry.values[key] = all[i+1]
		}
	}
	s.state.mu.Lock()
	defer s.state.mu.Unlock()
	s.state.entries = append(s.state.entries, entry)
}
func (s *fixtureLogSink) snapshot() []fixtureLogEntry {
	s.state.mu.Lock()
	defer s.state.mu.Unlock()
	return append([]fixtureLogEntry(nil), s.state.entries...)
}

func newConvergenceFixture(t *testing.T, threads, count int, prefix string, configure func(interceptor.Funcs, []*reviewv1alpha2.PRReviewJob) interceptor.Funcs) (context.Context, *controllers.PRReviewJobV1Alpha2Reconciler, []*reviewv1alpha2.PRReviewJob, *ConcurrencyMonitor, *fixtureLogSink) {
	t.Helper()
	now := time.Date(2026, 10, 2, 5, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	reviews := makeBurstReviews(now, count, prefix)
	objects := make([]client.Object, len(reviews))
	for i, review := range reviews {
		objects[i] = review
	}
	monitor := NewConcurrencyMonitor(4)
	funcs := makeM4OCCConcurrencyInterceptor(monitor)
	if configure != nil {
		funcs = configure(funcs, reviews)
	}
	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(objects...).
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}, &batchv1.Job{}).
		WithInterceptorFuncs(funcs).Build()
	r := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client: kube, Scheme: scheme, Now: func() time.Time { return now },
		MaxConcurrentJobs: 4, MaxConcurrentReconciles: threads,
	}
	sink := &fixtureLogSink{state: &fixtureLogState{}}
	return logr.NewContext(context.Background(), logr.New(sink)), r, reviews, monitor, sink
}

func assertFixtureAdmission(t *testing.T, ctx context.Context, kube client.Client, reviews []*reviewv1alpha2.PRReviewJob, monitor *ConcurrencyMonitor, succeeded, failed, firstRunning int) {
	t.Helper()
	var jobs batchv1.JobList
	if err := kube.List(ctx, &jobs); err != nil {
		t.Fatal(err)
	}
	active := make(map[types.NamespacedName]bool)
	for i := range jobs.Items {
		if committedWorkerConsumesCapacity(&jobs.Items[i]) {
			active[client.ObjectKeyFromObject(&jobs.Items[i])] = true
		}
	}
	seen := make(map[types.NamespacedName]bool)
	for i, review := range reviews {
		var stored reviewv1alpha2.PRReviewJob
		if err := kube.Get(ctx, client.ObjectKeyFromObject(review), &stored); err != nil {
			t.Fatal(err)
		}
		want := reviewv1alpha2.PhaseQueued
		switch {
		case i < succeeded:
			want = reviewv1alpha2.PhaseSucceeded
		case i < succeeded+failed:
			want = reviewv1alpha2.PhaseFailed
		case i >= firstRunning && i < firstRunning+4:
			want = reviewv1alpha2.PhaseRunning
		}
		if stored.Status.Phase != want {
			t.Fatalf("FIFO review %d (%s) phase: got %s, want %s", i, review.Name, stored.Status.Phase, want)
		}
		if want == reviewv1alpha2.PhaseRunning {
			key := types.NamespacedName{Namespace: stored.Namespace, Name: stored.Status.JobName}
			if stored.Status.JobName == "" || seen[key] || !active[key] {
				t.Fatalf("running review %s lacks a distinct active stored worker: %v", stored.Name, key)
			}
			seen[key] = true
		}
	}
	if len(active) != 4 || len(seen) != 4 {
		t.Fatalf("active worker identity count: got %d active/%d associated, want 4/4", len(active), len(seen))
	}
	if monitor.MaxObservedActive() > 4 || len(monitor.Violations()) != 0 {
		t.Fatalf("hard capacity invariant: maximum %d, violations %v", monitor.MaxObservedActive(), monitor.Violations())
	}
}

func assertFixtureKeyedErrors(t *testing.T, sink *fixtureLogSink, reviews []*reviewv1alpha2.PRReviewJob, sentinel error) {
	t.Helper()
	observed := make(map[types.NamespacedName]bool)
	for _, entry := range sink.snapshot() {
		if key, ok := entry.values["request"].(types.NamespacedName); ok && errors.Is(entry.err, sentinel) {
			observed[key] = true
		}
	}
	for _, review := range reviews {
		if !observed[client.ObjectKeyFromObject(review)] {
			t.Errorf("closed batch lost the actual error identity/request key for %s", review.Name)
		}
	}
}

func TestM4FixtureBatchSurfacesReconcileErrors(t *testing.T) {
	for _, threads := range []int{1, 4, 16} {
		t.Run(fmt.Sprintf("%dThreads", threads), func(t *testing.T) {
			var calls atomic.Int32
			sentinel := errors.New("fixture initial review read failed")
			ctx, r, reviews, _, sink := newConvergenceFixture(t, threads, 8, "batch-error", func(f interceptor.Funcs, _ []*reviewv1alpha2.PRReviewJob) interceptor.Funcs {
				f.Get = func(ctx context.Context, c client.WithWatch, key client.ObjectKey, obj client.Object, opts ...client.GetOption) error {
					if _, ok := obj.(*reviewv1alpha2.PRReviewJob); ok {
						calls.Add(1)
						return sentinel
					}
					return c.Get(ctx, key, obj, opts...)
				}
				return f
			})
			reconcileM4Batch(ctx, r, reviews, threads)
			if got := calls.Load(); got != 8 {
				t.Fatalf("batch must visit each request once: got %d calls, want 8", got)
			}
			assertFixtureKeyedErrors(t, sink, reviews, sentinel)
		})
	}
}

func TestM4FixtureBatchRetainsQuietRequeueOutcomes(t *testing.T) {
	for _, threads := range []int{1, 4, 16} {
		t.Run(fmt.Sprintf("%dThreads", threads), func(t *testing.T) {
			var calls atomic.Int32
			ctx, r, reviews, _, sink := newConvergenceFixture(t, threads, 8, "batch-requeue", func(f interceptor.Funcs, _ []*reviewv1alpha2.PRReviewJob) interceptor.Funcs {
				f.Get = func(ctx context.Context, c client.WithWatch, key client.ObjectKey, obj client.Object, opts ...client.GetOption) error {
					if _, ok := obj.(*reviewv1alpha2.PRReviewJob); ok {
						calls.Add(1)
						return apierrors.NewConflict(schema.GroupResource{Group: "review-yeti.ai", Resource: "prreviewjobs"}, key.Name, fmt.Errorf("fixture conflict"))
					}
					return c.Get(ctx, key, obj, opts...)
				}
				return f
			})
			reconcileM4Batch(ctx, r, reviews, threads)
			if got := calls.Load(); got != 8 {
				t.Fatalf("batch implicitly retried: got %d reads, want 8", got)
			}
			observed := make(map[types.NamespacedName]int)
			for _, entry := range sink.snapshot() {
				key, keyed := entry.values["request"].(types.NamespacedName)
				result, actual := entry.values["result"].(ctrl.Result)
				if keyed && actual && entry.err == nil && result == (ctrl.Result{RequeueAfter: 2 * time.Second}) {
					observed[key]++
				}
			}
			for _, review := range reviews {
				if got := observed[client.ObjectKeyFromObject(review)]; got != 1 {
					t.Errorf("actual quiet2s result for %s: observed %d times, want 1", review.Name, got)
				}
			}
		})
	}
}

func TestM4FixtureSettleWaitsForTerminalProjectionBeforeRecycledCapacity(t *testing.T) {
	for _, threads := range []int{1, 4, 16} {
		t.Run(fmt.Sprintf("%dThreads", threads), func(t *testing.T) {
			var enabled atomic.Bool
			var conflicts atomic.Int32
			ctx, r, reviews, monitor, _ := newConvergenceFixture(t, threads, 16, "recycle", func(f interceptor.Funcs, reviews []*reviewv1alpha2.PRReviewJob) interceptor.Funcs {
				next := f.SubResourceUpdate
				f.SubResourceUpdate = func(ctx context.Context, c client.Client, subresource string, obj client.Object, opts ...client.SubResourceUpdateOption) error {
					if review, ok := obj.(*reviewv1alpha2.PRReviewJob); ok && enabled.Load() && review.Name == reviews[0].Name && review.Status.Phase == reviewv1alpha2.PhaseSucceeded && conflicts.Add(1) <= 5 {
						return apierrors.NewConflict(schema.GroupResource{Group: "review-yeti.ai", Resource: "prreviewjobs"}, review.Name, fmt.Errorf("fixture terminal projection conflict"))
					}
					return next(ctx, c, subresource, obj, opts...)
				}
				return f
			})
			reconcileUntilSettled(ctx, r, reviews, threads)
			assertFixtureAdmission(t, ctx, r.Client, reviews, monitor, 0, 0, 0)
			for i := 0; i < 3; i++ {
				var worker batchv1.Job
				if err := r.Client.Get(ctx, types.NamespacedName{Namespace: reviews[i].Namespace, Name: reviews[i].Name + "-worker"}, &worker); err != nil {
					t.Fatal(err)
				}
				if i < 2 {
					attachReceiptAnnotations(&worker)
					if err := r.Client.Update(ctx, &worker); err != nil {
						t.Fatal(err)
					}
					worker.Status.Succeeded = 1
					worker.Status.Conditions = []batchv1.JobCondition{{Type: batchv1.JobComplete, Status: corev1.ConditionTrue}}
				} else {
					worker.Status.Failed = 1
					worker.Status.Conditions = []batchv1.JobCondition{{Type: batchv1.JobFailed, Status: corev1.ConditionTrue}}
				}
				if err := r.Client.Status().Update(ctx, &worker); err != nil {
					t.Fatal(err)
				}
			}
			enabled.Store(true)
			reconcileUntilSettled(ctx, r, reviews, threads)
			assertFixtureAdmission(t, ctx, r.Client, reviews, monitor, 2, 1, 3)
		})
	}
}

// Select the real admission list seam; an unfiltered oracle inventory read
// must not consume an injected admission failure or inflate its count.
func fixtureAdmissionList(list client.ObjectList, opts []client.ListOption) bool {
	if _, ok := list.(*batchv1.JobList); !ok {
		return false
	}
	return (&client.ListOptions{}).ApplyOptions(opts).LabelSelector != nil
}
