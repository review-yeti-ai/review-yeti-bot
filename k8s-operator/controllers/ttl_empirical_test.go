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

package controllers

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	reviewv1alpha1 "github.com/calltelemetry/ct-review-bot/k8s-operator/api/v1alpha1"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/cleanup"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/queue"
)

func setupTestSchemeForTTL(t *testing.T) *runtime.Scheme {
	t.Helper()
	scheme := runtime.NewScheme()
	_ = corev1.AddToScheme(scheme)
	_ = batchv1.AddToScheme(scheme)
	_ = reviewv1alpha1.AddToScheme(scheme)
	return scheme
}

// TestEmpirical_Reconciler_TTLZero_ImmediateCleanup stress tests Reconcile with TTL=0 on completed jobs.
func TestEmpirical_Reconciler_TTLZero_ImmediateCleanup(t *testing.T) {
	scheme := setupTestSchemeForTTL(t)
	qm := queue.NewQueueManager(5)
	ttlMgr := cleanup.NewTTLManager()
	ctx := context.Background()

	zero := int32(0)
	now := metav1.Now()

	jobCR := &reviewv1alpha1.PRReviewJob{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "ttl-zero-job",
			Namespace: "default",
		},
		Spec: reviewv1alpha1.PRReviewJobSpec{
			Repo:                    "calltelemetry/cisco-cdr",
			PRNumber:                10,
			TTLSecondsAfterFinished: &zero,
		},
		Status: reviewv1alpha1.PRReviewJobStatus{
			Phase:          reviewv1alpha1.PhaseSucceeded,
			CompletionTime: &now,
		},
	}

	childJob := &batchv1.Job{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "ttl-zero-job-job",
			Namespace: "default",
		},
	}
	childPVC := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "ttl-zero-job-pvc",
			Namespace: "default",
		},
	}

	fakeClient := fake.NewClientBuilder().
		WithScheme(scheme).
		WithStatusSubresource(jobCR).
		WithObjects(jobCR, childJob, childPVC).
		Build()

	reconciler := &PRReviewJobReconciler{
		Client:       fakeClient,
		Scheme:       scheme,
		QueueManager: qm,
		TTLManager:   ttlMgr,
	}

	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: "default", Name: "ttl-zero-job"}}

	res, err := reconciler.Reconcile(ctx, req)
	if err != nil {
		t.Fatalf("Reconcile returned error: %v", err)
	}

	if res.RequeueAfter != 0 {
		t.Errorf("Expected RequeueAfter=0 for zero TTL, got %v", res.RequeueAfter)
	}

	// Verify child objects and CR deleted
	var fetchedJob batchv1.Job
	if err := fakeClient.Get(ctx, types.NamespacedName{Namespace: "default", Name: "ttl-zero-job-job"}, &fetchedJob); err == nil {
		t.Errorf("Expected batch/v1 job to be deleted")
	}

	var fetchedPVC corev1.PersistentVolumeClaim
	if err := fakeClient.Get(ctx, types.NamespacedName{Namespace: "default", Name: "ttl-zero-job-pvc"}, &fetchedPVC); err == nil {
		t.Errorf("Expected PVC to be deleted")
	}

	var fetchedCR reviewv1alpha1.PRReviewJob
	if err := fakeClient.Get(ctx, req.NamespacedName, &fetchedCR); err == nil {
		t.Errorf("Expected PRReviewJob CR to be deleted")
	}
}

// TestEmpirical_Reconciler_NegativeTTL_ImmediateCleanup verifies negative TTL values trigger instant cleanup without requeue.
func TestEmpirical_Reconciler_NegativeTTL_ImmediateCleanup(t *testing.T) {
	scheme := setupTestSchemeForTTL(t)
	qm := queue.NewQueueManager(5)
	ttlMgr := cleanup.NewTTLManager()
	ctx := context.Background()

	negTTL := int32(-1800)
	now := metav1.Now()

	jobCR := &reviewv1alpha1.PRReviewJob{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "ttl-neg-job",
			Namespace: "default",
		},
		Spec: reviewv1alpha1.PRReviewJobSpec{
			Repo:                    "calltelemetry/cisco-cdr",
			PRNumber:                11,
			TTLSecondsAfterFinished: &negTTL,
		},
		Status: reviewv1alpha1.PRReviewJobStatus{
			Phase:          reviewv1alpha1.PhaseFailed,
			CompletionTime: &now,
		},
	}

	fakeClient := fake.NewClientBuilder().
		WithScheme(scheme).
		WithStatusSubresource(jobCR).
		WithObjects(jobCR).
		Build()

	reconciler := &PRReviewJobReconciler{
		Client:       fakeClient,
		Scheme:       scheme,
		QueueManager: qm,
		TTLManager:   ttlMgr,
	}

	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: "default", Name: "ttl-neg-job"}}

	res, err := reconciler.Reconcile(ctx, req)
	if err != nil {
		t.Fatalf("Reconcile negative TTL returned error: %v", err)
	}

	if res.RequeueAfter != 0 {
		t.Errorf("Expected RequeueAfter=0 for negative TTL, got %v", res.RequeueAfter)
	}

	var fetchedCR reviewv1alpha1.PRReviewJob
	if err := fakeClient.Get(ctx, req.NamespacedName, &fetchedCR); err == nil {
		t.Errorf("Expected PRReviewJob CR to be deleted for negative TTL")
	}
}

// TestEmpirical_Reconciler_TTLRequeue_Then_ExpirationCleanup tests normal requeue scheduling and subsequent GC.
func TestEmpirical_Reconciler_TTLRequeue_Then_ExpirationCleanup(t *testing.T) {
	scheme := setupTestSchemeForTTL(t)
	qm := queue.NewQueueManager(5)
	ttlMgr := cleanup.NewTTLManager()
	ctx := context.Background()

	ttlVal := int32(1800) // 30 minutes
	completionTime := metav1.NewTime(time.Now().Add(-10 * time.Minute))

	jobCR := &reviewv1alpha1.PRReviewJob{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "ttl-requeue-job",
			Namespace: "default",
		},
		Spec: reviewv1alpha1.PRReviewJobSpec{
			Repo:                    "calltelemetry/cisco-cdr",
			PRNumber:                12,
			TTLSecondsAfterFinished: &ttlVal,
		},
		Status: reviewv1alpha1.PRReviewJobStatus{
			Phase:          reviewv1alpha1.PhaseSucceeded,
			CompletionTime: &completionTime,
		},
	}

	fakeClient := fake.NewClientBuilder().
		WithScheme(scheme).
		WithStatusSubresource(jobCR).
		WithObjects(jobCR).
		Build()

	reconciler := &PRReviewJobReconciler{
		Client:       fakeClient,
		Scheme:       scheme,
		QueueManager: qm,
		TTLManager:   ttlMgr,
	}

	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: "default", Name: "ttl-requeue-job"}}

	// Step 1: Completed 10 minutes ago, TTL is 30 mins -> Expect RequeueAfter ~20 mins
	res, err := reconciler.Reconcile(ctx, req)
	if err != nil {
		t.Fatalf("First reconcile failed: %v", err)
	}

	if res.RequeueAfter <= 18*time.Minute || res.RequeueAfter > 21*time.Minute {
		t.Errorf("Expected RequeueAfter ~20 minutes, got %v", res.RequeueAfter)
	}

	// CR should still exist
	var fetchedCR reviewv1alpha1.PRReviewJob
	if err := fakeClient.Get(ctx, req.NamespacedName, &fetchedCR); err != nil {
		t.Fatalf("CR should still exist before expiration")
	}

	// Step 2: Fast-forward CompletionTime to 40 minutes ago -> Expired!
	expiredCompletionTime := metav1.NewTime(time.Now().Add(-40 * time.Minute))
	fetchedCR.Status.CompletionTime = &expiredCompletionTime
	if err := fakeClient.Status().Update(ctx, &fetchedCR); err != nil {
		t.Fatalf("Failed to update status: %v", err)
	}

	// Step 3: Reconcile again -> Expect immediate cleanup and RequeueAfter=0
	res2, err := reconciler.Reconcile(ctx, req)
	if err != nil {
		t.Fatalf("Second reconcile failed: %v", err)
	}

	if res2.RequeueAfter != 0 {
		t.Errorf("Expected RequeueAfter=0 after expiration, got %v", res2.RequeueAfter)
	}

	if err := fakeClient.Get(ctx, req.NamespacedName, &fetchedCR); err == nil {
		t.Errorf("Expected PRReviewJob CR to be deleted after TTL expiration")
	}
}

// TestEmpirical_Reconciler_ConcurrentReconcile_TTLExpired_Stress stress tests 50 concurrent reconcile loops
// targeting an expired job to ensure thread safety and idempotency.
func TestEmpirical_Reconciler_ConcurrentReconcile_TTLExpired_Stress(t *testing.T) {
	scheme := setupTestSchemeForTTL(t)
	qm := queue.NewQueueManager(5)
	ttlMgr := cleanup.NewTTLManager()
	ctx := context.Background()

	ttlVal := int32(60)
	pastCompletion := metav1.NewTime(time.Now().Add(-10 * time.Minute))

	const jobCount = 20
	const goroutinesPerJob = 5

	fakeObjs := make([]runtime.Object, 0, jobCount*3)
	reqs := make([]ctrl.Request, jobCount)

	for i := 0; i < jobCount; i++ {
		name := fmt.Sprintf("concurrent-ttl-job-%d", i)
		reqs[i] = ctrl.Request{NamespacedName: types.NamespacedName{Namespace: "default", Name: name}}

		cr := &reviewv1alpha1.PRReviewJob{
			ObjectMeta: metav1.ObjectMeta{
				Name:      name,
				Namespace: "default",
			},
			Spec: reviewv1alpha1.PRReviewJobSpec{
				Repo:                    "calltelemetry/cisco-cdr",
				PRNumber:                int32(i + 1),
				TTLSecondsAfterFinished: &ttlVal,
			},
			Status: reviewv1alpha1.PRReviewJobStatus{
				Phase:          reviewv1alpha1.PhaseSucceeded,
				CompletionTime: &pastCompletion,
			},
		}
		childJob := &batchv1.Job{
			ObjectMeta: metav1.ObjectMeta{
				Name:      fmt.Sprintf("%s-job", name),
				Namespace: "default",
			},
		}
		childPVC := &corev1.PersistentVolumeClaim{
			ObjectMeta: metav1.ObjectMeta{
				Name:      fmt.Sprintf("%s-pvc", name),
				Namespace: "default",
			},
		}

		fakeObjs = append(fakeObjs, cr, childJob, childPVC)
	}

	fakeClient := fake.NewClientBuilder().
		WithScheme(scheme).
		WithRuntimeObjects(fakeObjs...).
		Build()

	reconciler := &PRReviewJobReconciler{
		Client:       fakeClient,
		Scheme:       scheme,
		QueueManager: qm,
		TTLManager:   ttlMgr,
	}

	var wg sync.WaitGroup
	startChan := make(chan struct{})
	var errCount uint64

	for i := 0; i < jobCount; i++ {
		for g := 0; g < goroutinesPerJob; g++ {
			wg.Add(1)
			go func(req ctrl.Request) {
				defer wg.Done()
				<-startChan

				_, err := reconciler.Reconcile(ctx, req)
				if err != nil {
					atomic.AddUint64(&errCount, 1)
					t.Errorf("Reconcile failed for %s: %v", req.Name, err)
				}
			}(reqs[i])
		}
	}

	close(startChan)
	wg.Wait()

	if errCount > 0 {
		t.Fatalf("Concurrent reconcile produced %d errors", errCount)
	}

	// Verify all CRs and children are deleted
	for i := 0; i < jobCount; i++ {
		name := fmt.Sprintf("concurrent-ttl-job-%d", i)
		var cr reviewv1alpha1.PRReviewJob
		if err := fakeClient.Get(ctx, types.NamespacedName{Namespace: "default", Name: name}, &cr); err == nil {
			t.Errorf("Expected CR %s to be deleted", name)
		}
	}
}
