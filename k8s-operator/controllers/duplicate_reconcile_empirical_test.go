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

package controllers_test

import (
	"context"
	"testing"

	batchv1 "k8s.io/api/batch/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	reviewv1alpha1 "github.com/calltelemetry/ct-review-bot/k8s-operator/api/v1alpha1"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/controllers"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/queue"
)

// TestEmpirical_DuplicateReconcile_SucceededJob_OverAllocation tests what happens when
// a completed job receives duplicate reconcile events while multiple jobs are queued.
func TestEmpirical_DuplicateReconcile_SucceededJob_OverAllocation(t *testing.T) {
	scheme := setupTestScheme(t)
	qm := queue.NewQueueManager(2) // Max concurrent = 2

	ctx := context.Background()

	// Create 4 jobs: job-1 (active), job-2 (active), job-3 (queued), job-4 (queued)
	j1Key := types.NamespacedName{Namespace: "default", Name: "job-1"}
	j2Key := types.NamespacedName{Namespace: "default", Name: "job-2"}
	j3Key := types.NamespacedName{Namespace: "default", Name: "job-3"}
	j4Key := types.NamespacedName{Namespace: "default", Name: "job-4"}

	job1 := &reviewv1alpha1.PRReviewJob{
		ObjectMeta: metav1.ObjectMeta{Name: "job-1", Namespace: "default"},
		Spec:       reviewv1alpha1.PRReviewJobSpec{Repo: "a/b", PRNumber: 1, HeadSHA: "1111111", BaseSHA: "2222222", PersonaRoster: []string{"sec"}},
	}
	job2 := &reviewv1alpha1.PRReviewJob{
		ObjectMeta: metav1.ObjectMeta{Name: "job-2", Namespace: "default"},
		Spec:       reviewv1alpha1.PRReviewJobSpec{Repo: "a/b", PRNumber: 2, HeadSHA: "1111111", BaseSHA: "2222222", PersonaRoster: []string{"sec"}},
	}
	job3 := &reviewv1alpha1.PRReviewJob{
		ObjectMeta: metav1.ObjectMeta{Name: "job-3", Namespace: "default"},
		Spec:       reviewv1alpha1.PRReviewJobSpec{Repo: "a/b", PRNumber: 3, HeadSHA: "1111111", BaseSHA: "2222222", PersonaRoster: []string{"sec"}},
	}
	job4 := &reviewv1alpha1.PRReviewJob{
		ObjectMeta: metav1.ObjectMeta{Name: "job-4", Namespace: "default"},
		Spec:       reviewv1alpha1.PRReviewJobSpec{Repo: "a/b", PRNumber: 4, HeadSHA: "1111111", BaseSHA: "2222222", PersonaRoster: []string{"sec"}},
	}

	fakeClient := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(job1, job2, job3, job4).
		WithStatusSubresource(&reviewv1alpha1.PRReviewJob{}, &batchv1.Job{}).
		Build()

	reconciler := &controllers.PRReviewJobReconciler{
		Client:       fakeClient,
		Scheme:       scheme,
		QueueManager: qm,
	}

	// 1. Initial reconcile for job-1 and job-2 -> Active (2 slots filled)
	_, _ = reconciler.Reconcile(ctx, ctrl.Request{NamespacedName: j1Key})
	_, _ = reconciler.Reconcile(ctx, ctrl.Request{NamespacedName: j2Key})

	// 2. Initial reconcile for job-3 and job-4 -> Queued
	_, _ = reconciler.Reconcile(ctx, ctrl.Request{NamespacedName: j3Key})
	_, _ = reconciler.Reconcile(ctx, ctrl.Request{NamespacedName: j4Key})

	if qm.GetActiveCount() != 2 || qm.GetQueuedCount() != 2 {
		t.Fatalf("Setup state mismatch: expected 2 active, 2 queued. Got active=%d, queued=%d", qm.GetActiveCount(), qm.GetQueuedCount())
	}

	// 3. Complete job-1 batch/v1 Job
	var k8sJob1 batchv1.Job
	_ = fakeClient.Get(ctx, types.NamespacedName{Namespace: "default", Name: "job-1-job"}, &k8sJob1)
	k8sJob1.Status.Succeeded = 1
	_ = fakeClient.Status().Update(ctx, &k8sJob1)

	// Reconcile job-1 completion (1st release call inside Reconcile)
	_, _ = reconciler.Reconcile(ctx, ctrl.Request{NamespacedName: j1Key})

	// After completion, job-1 phase is Succeeded.
	// Reconcile job-1 AGAIN (simulating duplicate reconcile event triggered by Status Update or Resync)
	_, _ = reconciler.Reconcile(ctx, ctrl.Request{NamespacedName: j1Key})

	// Now check active count in QueueManager!
	// Maximum capacity is 2. If duplicate reconcile popped job-4 AGAIN, active count will be WRONG!
	activeCount := qm.GetActiveCount()
	if activeCount > 2 {
		t.Errorf("EMPIRICAL BUG CONFIRMED: Duplicate reconcile on completed job-1 caused QueueManager active count to inflate to %d (max: 2)!", activeCount)
	}
}

// TestEmpirical_FailedUnderlyingJob_Transition tests failed underlying Job handling.
func TestEmpirical_FailedUnderlyingJob_Transition(t *testing.T) {
	scheme := setupTestScheme(t)
	qm := queue.NewQueueManager(2)

	ctx := context.Background()
	jKey := types.NamespacedName{Namespace: "default", Name: "job-fail-test"}

	jobObj := &reviewv1alpha1.PRReviewJob{
		ObjectMeta: metav1.ObjectMeta{Name: jKey.Name, Namespace: jKey.Namespace},
		Spec: reviewv1alpha1.PRReviewJobSpec{
			Repo:          "calltelemetry/cisco-cdr",
			PRNumber:      77,
			HeadSHA:       "1234567890",
			BaseSHA:       "0987654321",
			PersonaRoster: []string{"security", "qa"},
		},
	}

	fakeClient := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(jobObj).
		WithStatusSubresource(&reviewv1alpha1.PRReviewJob{}, &batchv1.Job{}).
		Build()

	reconciler := &controllers.PRReviewJobReconciler{
		Client:       fakeClient,
		Scheme:       scheme,
		QueueManager: qm,
	}

	// 1. Initial reconcile -> Running
	_, err := reconciler.Reconcile(ctx, ctrl.Request{NamespacedName: jKey})
	if err != nil {
		t.Fatalf("Initial reconcile failed: %v", err)
	}

	var runningCR reviewv1alpha1.PRReviewJob
	_ = fakeClient.Get(ctx, jKey, &runningCR)
	if runningCR.Status.Phase != reviewv1alpha1.PhaseRunning {
		t.Fatalf("Expected phase Running, got %s", runningCR.Status.Phase)
	}

	// 2. Set underlying K8s Job status to Failed = 1
	var k8sJob batchv1.Job
	err = fakeClient.Get(ctx, types.NamespacedName{Namespace: jKey.Namespace, Name: jKey.Name + "-job"}, &k8sJob)
	if err != nil {
		t.Fatalf("Failed to get k8sJob: %v", err)
	}
	k8sJob.Status.Failed = 1
	if err := fakeClient.Status().Update(ctx, &k8sJob); err != nil {
		t.Fatalf("Failed to update k8sJob status: %v", err)
	}

	// 3. Reconcile failure
	_, err = reconciler.Reconcile(ctx, ctrl.Request{NamespacedName: jKey})
	if err != nil {
		t.Fatalf("Reconcile after job failure returned error: %v", err)
	}

	// 4. Verify CR status updated to PhaseFailed
	var failedCR reviewv1alpha1.PRReviewJob
	if err := fakeClient.Get(ctx, jKey, &failedCR); err != nil {
		t.Fatalf("Failed to fetch failed CR: %v", err)
	}

	if failedCR.Status.Phase != reviewv1alpha1.PhaseFailed {
		t.Errorf("Expected phase Failed, got %s", failedCR.Status.Phase)
	}
	if failedCR.Status.CompletionTime == nil {
		t.Errorf("Expected CompletionTime set on failure")
	}
	for _, p := range failedCR.Status.PersonaProgress {
		if p.Status != "Failed" {
			t.Errorf("Expected persona progress Failed, got %s for %s", p.Status, p.Persona)
		}
	}

	// Slot should be released
	if qm.IsActive(jKey) {
		t.Errorf("Expected slot to be released on Job failure")
	}
}

// TestEmpirical_DuplicateReconciliationRequests_RunningJob tests duplicate reconcile on a Running job.
func TestEmpirical_DuplicateReconciliationRequests_RunningJob(t *testing.T) {
	scheme := setupTestScheme(t)
	qm := queue.NewQueueManager(2)

	ctx := context.Background()
	jKey := types.NamespacedName{Namespace: "default", Name: "job-dup-running"}

	jobObj := &reviewv1alpha1.PRReviewJob{
		ObjectMeta: metav1.ObjectMeta{Name: jKey.Name, Namespace: jKey.Namespace},
		Spec: reviewv1alpha1.PRReviewJobSpec{
			Repo:          "calltelemetry/cisco-cdr",
			PRNumber:      88,
			HeadSHA:       "1234567890",
			BaseSHA:       "0987654321",
			PersonaRoster: []string{"security"},
		},
	}

	fakeClient := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(jobObj).
		WithStatusSubresource(&reviewv1alpha1.PRReviewJob{}, &batchv1.Job{}).
		Build()

	reconciler := &controllers.PRReviewJobReconciler{
		Client:       fakeClient,
		Scheme:       scheme,
		QueueManager: qm,
	}

	// First reconcile
	_, err := reconciler.Reconcile(ctx, ctrl.Request{NamespacedName: jKey})
	if err != nil {
		t.Fatalf("First reconcile failed: %v", err)
	}

	// Duplicate reconcile on running job
	_, err = reconciler.Reconcile(ctx, ctrl.Request{NamespacedName: jKey})
	if err != nil {
		t.Fatalf("Duplicate reconcile failed: %v", err)
	}

	// Duplicate reconcile again
	_, err = reconciler.Reconcile(ctx, ctrl.Request{NamespacedName: jKey})
	if err != nil {
		t.Fatalf("Triplicate reconcile failed: %v", err)
	}

	if qm.GetActiveCount() != 1 {
		t.Errorf("Expected ActiveCount=1 after duplicate reconciles, got %d", qm.GetActiveCount())
	}
}
