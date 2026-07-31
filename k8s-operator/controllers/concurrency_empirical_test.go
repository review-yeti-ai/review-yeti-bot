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
	"fmt"
	"os"
	"testing"

	batchv1 "k8s.io/api/batch/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	reviewv1alpha1 "github.com/calltelemetry/ct-review-bot/k8s-operator/api/v1alpha1"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/controllers"
	opmetrics "github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/metrics"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/queue"
	"github.com/prometheus/client_golang/prometheus/testutil"
)

// TestEmpirical_5ConcurrentJobs_QueueManager_Promotion tests Task 1, 2, 3:
// 1. Submit 5 concurrent PRReviewJob CRs with MAX_CONCURRENT_REVIEW_JOBS=3.
// 2. Verify 3 jobs reach Running phase (slots acquired) and 2 jobs reach Queued phase.
// 3. Verify completing 1 running job automatically releases slot & promotes the next queued job to Running.
func TestEmpirical_5ConcurrentJobs_QueueManager_Promotion(t *testing.T) {
	os.Setenv("MAX_CONCURRENT_REVIEW_JOBS", "3")
	defer os.Unsetenv("MAX_CONCURRENT_REVIEW_JOBS")

	scheme := setupTestScheme(t)
	qm := queue.NewQueueManager(0) // tests env var fallback to 3

	if qm.MaxConcurrent() != 3 {
		t.Fatalf("Expected QueueManager MaxConcurrent = 3, got %d", qm.MaxConcurrent())
	}

	ctx := context.Background()

	// 1. Prepare 5 PRReviewJobs
	var initialObjects []client.Object
	jobNames := []string{"job-1", "job-2", "job-3", "job-4", "job-5"}

	for i, name := range jobNames {
		j := &reviewv1alpha1.PRReviewJob{
			ObjectMeta: metav1.ObjectMeta{
				Name:      name,
				Namespace: "default",
			},
			Spec: reviewv1alpha1.PRReviewJobSpec{
				Repo:          "calltelemetry/cisco-cdr",
				PRNumber:      int32(100 + i),
				HeadSHA:       fmt.Sprintf("headsha%d", i),
				BaseSHA:       fmt.Sprintf("basesha%d", i),
				PersonaRoster: []string{"security", "qa"},
			},
		}
		initialObjects = append(initialObjects, j)
	}

	fakeClient := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(initialObjects...).
		WithStatusSubresource(&reviewv1alpha1.PRReviewJob{}, &batchv1.Job{}).
		Build()

	reconciler := &controllers.PRReviewJobReconciler{
		Client:       fakeClient,
		Scheme:       scheme,
		QueueManager: qm,
	}

	// Reconcile all 5 jobs sequentially
	for _, name := range jobNames {
		req := ctrl.Request{
			NamespacedName: types.NamespacedName{Namespace: "default", Name: name},
		}
		_, err := reconciler.Reconcile(ctx, req)
		if err != nil {
			t.Fatalf("Failed initial reconcile for %s: %v", name, err)
		}
	}

	// 2. Empirical Verification of Task 2:
	// Verify 3 Running, 2 Queued
	if qm.GetActiveCount() != 3 {
		t.Errorf("Empirical check failed: Expected 3 active jobs in QueueManager, got %d", qm.GetActiveCount())
	}
	if qm.GetQueuedCount() != 2 {
		t.Errorf("Empirical check failed: Expected 2 queued jobs in QueueManager, got %d", qm.GetQueuedCount())
	}

	for _, name := range []string{"job-1", "job-2", "job-3"} {
		var cr reviewv1alpha1.PRReviewJob
		err := fakeClient.Get(ctx, types.NamespacedName{Namespace: "default", Name: name}, &cr)
		if err != nil {
			t.Fatalf("Failed to fetch %s: %v", name, err)
		}
		if cr.Status.Phase != reviewv1alpha1.PhaseRunning {
			t.Errorf("Expected %s phase to be Running, got %s", name, cr.Status.Phase)
		}

		// Check batch/v1 Job created for active jobs
		var k8sJob batchv1.Job
		err = fakeClient.Get(ctx, types.NamespacedName{Namespace: "default", Name: name + "-job"}, &k8sJob)
		if err != nil {
			t.Errorf("Expected batch/v1 Job for %s to be created, got error: %v", name, err)
		}
	}

	for _, name := range []string{"job-4", "job-5"} {
		var cr reviewv1alpha1.PRReviewJob
		err := fakeClient.Get(ctx, types.NamespacedName{Namespace: "default", Name: name}, &cr)
		if err != nil {
			t.Fatalf("Failed to fetch %s: %v", name, err)
		}
		if cr.Status.Phase != reviewv1alpha1.PhaseQueued {
			t.Errorf("Expected %s phase to be Queued, got %s", name, cr.Status.Phase)
		}

		// Check batch/v1 Job NOT created for queued jobs
		var k8sJob batchv1.Job
		err = fakeClient.Get(ctx, types.NamespacedName{Namespace: "default", Name: name + "-job"}, &k8sJob)
		if err == nil {
			t.Errorf("batch/v1 Job for queued %s should NOT exist", name)
		}
	}

	// 3. Empirical Verification of Task 3:
	// Complete job-1, verify job-4 is automatically promoted to Running upon release
	var job1K8sJob batchv1.Job
	err := fakeClient.Get(ctx, types.NamespacedName{Namespace: "default", Name: "job-1-job"}, &job1K8sJob)
	if err != nil {
		t.Fatalf("Failed to get job-1 batch/v1 Job: %v", err)
	}
	job1K8sJob.Status.Succeeded = 1
	if err := fakeClient.Status().Update(ctx, &job1K8sJob); err != nil {
		t.Fatalf("Failed to update job-1 k8sJob status: %v", err)
	}

	// Reconcile job-1 to process completion
	req1 := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: "default", Name: "job-1"}}
	_, err = reconciler.Reconcile(ctx, req1)
	if err != nil {
		t.Fatalf("Failed to reconcile job-1 completion: %v", err)
	}

	// Verify job-1 is Succeeded
	var job1CR reviewv1alpha1.PRReviewJob
	_ = fakeClient.Get(ctx, req1.NamespacedName, &job1CR)
	if job1CR.Status.Phase != reviewv1alpha1.PhaseSucceeded {
		t.Errorf("Expected job-1 phase Succeeded, got %s", job1CR.Status.Phase)
	}

	// Verify QueueManager state immediately after job-1 release:
	// QueueManager should have moved job-4 to active, leaving job-5 in queue
	if qm.IsActive(types.NamespacedName{Namespace: "default", Name: "job-1"}) {
		t.Errorf("job-1 should no longer be active in QueueManager")
	}
	if !qm.IsActive(types.NamespacedName{Namespace: "default", Name: "job-4"}) {
		t.Errorf("job-4 should have been promoted to active in QueueManager upon job-1 release")
	}
	if qm.GetActiveCount() != 3 {
		t.Errorf("Expected ActiveCount=3 after promotion, got %d", qm.GetActiveCount())
	}
	if qm.GetQueuedCount() != 1 {
		t.Errorf("Expected QueuedCount=1 after promotion, got %d", qm.GetQueuedCount())
	}

	// Read event channel to verify QueueManager signaled controller for job-4
	select {
	case evt := <-qm.EventChannel():
		if evt.Object == nil || evt.Object.GetName() != "job-4" {
			t.Errorf("Expected GenericEvent for job-4, got %v", evt.Object)
		}
	default:
		t.Errorf("Expected GenericEvent on EventChannel after slot release, but channel was empty")
	}

	// Now reconcile job-4 as triggered by controller event
	req4 := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: "default", Name: "job-4"}}
	_, err = reconciler.Reconcile(ctx, req4)
	if err != nil {
		t.Fatalf("Failed to reconcile job-4: %v", err)
	}

	// Verify job-4 CR status updated to Running and batch/v1 Job created
	var job4CR reviewv1alpha1.PRReviewJob
	_ = fakeClient.Get(ctx, req4.NamespacedName, &job4CR)
	if job4CR.Status.Phase != reviewv1alpha1.PhaseRunning {
		t.Errorf("Expected promoted job-4 phase to be Running, got %s", job4CR.Status.Phase)
	}

	var job4K8sJob batchv1.Job
	err = fakeClient.Get(ctx, types.NamespacedName{Namespace: "default", Name: "job-4-job"}, &job4K8sJob)
	if err != nil {
		t.Errorf("Expected batch/v1 Job to be created for promoted job-4, got error: %v", err)
	}

	// Continue completing job-2 to promote job-5
	var job2K8sJob batchv1.Job
	_ = fakeClient.Get(ctx, types.NamespacedName{Namespace: "default", Name: "job-2-job"}, &job2K8sJob)
	job2K8sJob.Status.Succeeded = 1
	_ = fakeClient.Status().Update(ctx, &job2K8sJob)

	req2 := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: "default", Name: "job-2"}}
	_, _ = reconciler.Reconcile(ctx, req2)

	if !qm.IsActive(types.NamespacedName{Namespace: "default", Name: "job-5"}) {
		t.Errorf("job-5 should have been promoted to active in QueueManager upon job-2 release")
	}

	req5 := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: "default", Name: "job-5"}}
	_, _ = reconciler.Reconcile(ctx, req5)

	var job5CR reviewv1alpha1.PRReviewJob
	_ = fakeClient.Get(ctx, req5.NamespacedName, &job5CR)
	if job5CR.Status.Phase != reviewv1alpha1.PhaseRunning {
		t.Errorf("Expected promoted job-5 phase to be Running, got %s", job5CR.Status.Phase)
	}

	if qm.GetActiveCount() != 3 || qm.GetQueuedCount() != 0 {
		t.Errorf("Expected 3 active (job-3, job-4, job-5), 0 queued. Got active=%d, queued=%d", qm.GetActiveCount(), qm.GetQueuedCount())
	}
}

func TestEmpirical_5ConcurrentJobs_FullLifecycle_DrainAndVerdicts(t *testing.T) {
	os.Setenv("MAX_CONCURRENT_REVIEW_JOBS", "3")
	defer os.Unsetenv("MAX_CONCURRENT_REVIEW_JOBS")

	scheme := setupTestScheme(t)
	qm := queue.NewQueueManager(3)
	ctx := context.Background()

	// 1. Prepare 5 PRReviewJobs
	var initialObjects []client.Object
	jobNames := []string{"job-drain-1", "job-drain-2", "job-drain-3", "job-drain-4", "job-drain-5"}

	for i, name := range jobNames {
		j := &reviewv1alpha1.PRReviewJob{
			ObjectMeta: metav1.ObjectMeta{
				Name:      name,
				Namespace: "default",
			},
			Spec: reviewv1alpha1.PRReviewJobSpec{
				Repo:          "calltelemetry/cisco-cdr",
				PRNumber:      int32(200 + i),
				HeadSHA:       fmt.Sprintf("headsha%d", i),
				BaseSHA:       fmt.Sprintf("basesha%d", i),
				PersonaRoster: []string{"security", "qa"},
			},
		}
		initialObjects = append(initialObjects, j)
	}

	fakeClient := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(initialObjects...).
		WithStatusSubresource(&reviewv1alpha1.PRReviewJob{}, &batchv1.Job{}).
		Build()

	reconciler := &controllers.PRReviewJobReconciler{
		Client:       fakeClient,
		Scheme:       scheme,
		QueueManager: qm,
	}

	// Reconcile initial 5 jobs: jobs 1..3 running, jobs 4..5 queued
	for _, name := range jobNames {
		req := ctrl.Request{
			NamespacedName: types.NamespacedName{Namespace: "default", Name: name},
		}
		_, err := reconciler.Reconcile(ctx, req)
		if err != nil {
			t.Fatalf("Failed initial reconcile for %s: %v", name, err)
		}
	}

	if qm.GetActiveCount() != 3 || qm.GetQueuedCount() != 2 {
		t.Fatalf("Expected 3 active, 2 queued. Got active=%d, queued=%d", qm.GetActiveCount(), qm.GetQueuedCount())
	}

	// Dynamic verdict setup and completion transitions:
	// Job 1: Succeeded with APPROVED (all personas default completed)
	var k8sJob1 batchv1.Job
	_ = fakeClient.Get(ctx, types.NamespacedName{Namespace: "default", Name: "job-drain-1-job"}, &k8sJob1)
	k8sJob1.Status.Succeeded = 1
	_ = fakeClient.Status().Update(ctx, &k8sJob1)
	req1 := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: "default", Name: "job-drain-1"}}
	_, _ = reconciler.Reconcile(ctx, req1)

	// Verify Job 1 promoted Job 4
	<-qm.EventChannel()
	req4 := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: "default", Name: "job-drain-4"}}
	_, _ = reconciler.Reconcile(ctx, req4)

	// Job 2: Succeeded with CHANGES_REQUESTED
	var cr2 reviewv1alpha1.PRReviewJob
	req2 := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: "default", Name: "job-drain-2"}}
	_ = fakeClient.Get(ctx, req2.NamespacedName, &cr2)
	cr2.Status.PersonaProgressMap = map[string]string{"security": "CHANGES_REQUESTED", "qa": "Completed"}
	_ = fakeClient.Status().Update(ctx, &cr2)

	var k8sJob2 batchv1.Job
	_ = fakeClient.Get(ctx, types.NamespacedName{Namespace: "default", Name: "job-drain-2-job"}, &k8sJob2)
	k8sJob2.Status.Succeeded = 1
	_ = fakeClient.Status().Update(ctx, &k8sJob2)
	_, _ = reconciler.Reconcile(ctx, req2)

	// Verify Job 2 promoted Job 5
	<-qm.EventChannel()
	req5 := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: "default", Name: "job-drain-5"}}
	_, _ = reconciler.Reconcile(ctx, req5)

	// Job 3: Failed with FAILED verdict (underlying batch Job failed)
	var k8sJob3 batchv1.Job
	_ = fakeClient.Get(ctx, types.NamespacedName{Namespace: "default", Name: "job-drain-3-job"}, &k8sJob3)
	k8sJob3.Status.Failed = 1
	_ = fakeClient.Status().Update(ctx, &k8sJob3)
	req3 := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: "default", Name: "job-drain-3"}}
	_, _ = reconciler.Reconcile(ctx, req3)

	// Job 4: Succeeded with COMMENT verdict
	var cr4 reviewv1alpha1.PRReviewJob
	_ = fakeClient.Get(ctx, req4.NamespacedName, &cr4)
	cr4.Status.PersonaProgressMap = map[string]string{"security": "COMMENT", "qa": "Completed"}
	_ = fakeClient.Status().Update(ctx, &cr4)

	var k8sJob4 batchv1.Job
	_ = fakeClient.Get(ctx, types.NamespacedName{Namespace: "default", Name: "job-drain-4-job"}, &k8sJob4)
	k8sJob4.Status.Succeeded = 1
	_ = fakeClient.Status().Update(ctx, &k8sJob4)
	_, _ = reconciler.Reconcile(ctx, req4)

	// Job 5: Succeeded with APPROVED verdict
	var k8sJob5 batchv1.Job
	_ = fakeClient.Get(ctx, types.NamespacedName{Namespace: "default", Name: "job-drain-5-job"}, &k8sJob5)
	k8sJob5.Status.Succeeded = 1
	_ = fakeClient.Status().Update(ctx, &k8sJob5)
	_, _ = reconciler.Reconcile(ctx, req5)

	// Assert Complete Queue Drain
	if qm.GetActiveCount() != 0 {
		t.Errorf("Expected active count = 0 after full drain, got %d", qm.GetActiveCount())
	}
	if qm.GetQueuedCount() != 0 {
		t.Errorf("Expected queued count = 0 after full drain, got %d", qm.GetQueuedCount())
	}

	// Verify final verdicts and phases
	verdictChecks := map[string]struct {
		expectedPhase   reviewv1alpha1.PRReviewJobPhase
		expectedVerdict string
	}{
		"job-drain-1": {reviewv1alpha1.PhaseSucceeded, reviewv1alpha1.VerdictApproved},
		"job-drain-2": {reviewv1alpha1.PhaseSucceeded, reviewv1alpha1.VerdictChangesRequested},
		"job-drain-3": {reviewv1alpha1.PhaseFailed, reviewv1alpha1.VerdictFailed},
		"job-drain-4": {reviewv1alpha1.PhaseSucceeded, reviewv1alpha1.VerdictComment},
		"job-drain-5": {reviewv1alpha1.PhaseSucceeded, reviewv1alpha1.VerdictApproved},
	}

	for name, check := range verdictChecks {
		var cr reviewv1alpha1.PRReviewJob
		err := fakeClient.Get(ctx, types.NamespacedName{Namespace: "default", Name: name}, &cr)
		if err != nil {
			t.Fatalf("Failed to fetch %s: %v", name, err)
		}
		if cr.Status.Phase != check.expectedPhase {
			t.Errorf("Expected %s phase %s, got %s", name, check.expectedPhase, cr.Status.Phase)
		}
		if cr.Status.Verdict != check.expectedVerdict {
			t.Errorf("Expected %s verdict %s, got %s", name, check.expectedVerdict, cr.Status.Verdict)
		}
	}
}

func TestEmpirical_QueuedJobDeletion_DoesNotBlockQueue(t *testing.T) {
	scheme := setupTestScheme(t)
	qm := queue.NewQueueManager(3)
	ctx := context.Background()

	jobNames := []string{"qdel-1", "qdel-2", "qdel-3", "qdel-4", "qdel-5"}
	var initialObjects []client.Object
	for i, name := range jobNames {
		j := &reviewv1alpha1.PRReviewJob{
			ObjectMeta: metav1.ObjectMeta{
				Name:      name,
				Namespace: "default",
			},
			Spec: reviewv1alpha1.PRReviewJobSpec{
				Repo:          "calltelemetry/cisco-cdr",
				PRNumber:      int32(300 + i),
				HeadSHA:       fmt.Sprintf("headsha%d", i),
				BaseSHA:       fmt.Sprintf("basesha%d", i),
				PersonaRoster: []string{"security"},
			},
		}
		initialObjects = append(initialObjects, j)
	}

	fakeClient := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(initialObjects...).
		WithStatusSubresource(&reviewv1alpha1.PRReviewJob{}, &batchv1.Job{}).
		Build()

	reconciler := &controllers.PRReviewJobReconciler{
		Client:       fakeClient,
		Scheme:       scheme,
		QueueManager: qm,
	}

	// Reconcile 5 jobs: 1, 2, 3 active; 4, 5 queued
	for _, name := range jobNames {
		req := ctrl.Request{
			NamespacedName: types.NamespacedName{Namespace: "default", Name: name},
		}
		_, _ = reconciler.Reconcile(ctx, req)
	}

	job4Key := types.NamespacedName{Namespace: "default", Name: "qdel-4"}
	if !qm.IsQueued(job4Key) {
		t.Fatalf("Expected qdel-4 to be queued initially")
	}

	// Delete qdel-4 CR from fake API server
	var qdel4CR reviewv1alpha1.PRReviewJob
	_ = fakeClient.Get(ctx, job4Key, &qdel4CR)
	_ = fakeClient.Delete(ctx, &qdel4CR)

	// Reconcile qdel-4 delete event
	_, err := reconciler.Reconcile(ctx, ctrl.Request{NamespacedName: job4Key})
	if err != nil {
		t.Fatalf("Reconcile returned error on deleted queued CR: %v", err)
	}

	// Verify qdel-4 removed from queue
	if qm.IsQueued(job4Key) {
		t.Errorf("Expected qdel-4 to be removed from queue upon CR deletion")
	}

	// Complete qdel-1
	req1 := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: "default", Name: "qdel-1"}}
	var k8sJob1 batchv1.Job
	_ = fakeClient.Get(ctx, types.NamespacedName{Namespace: "default", Name: "qdel-1-job"}, &k8sJob1)
	k8sJob1.Status.Succeeded = 1
	_ = fakeClient.Status().Update(ctx, &k8sJob1)
	_, _ = reconciler.Reconcile(ctx, req1)

	// Verify qdel-5 (remaining in queue behind deleted qdel-4) was promoted automatically
	job5Key := types.NamespacedName{Namespace: "default", Name: "qdel-5"}
	if !qm.IsActive(job5Key) {
		t.Errorf("Expected qdel-5 to be promoted to active after qdel-1 completed")
	}

	// Drain event channel for qdel-5
	select {
	case evt := <-qm.EventChannel():
		if evt.Object == nil || evt.Object.GetName() != "qdel-5" {
			t.Errorf("Expected GenericEvent for qdel-5, got %v", evt.Object)
		}
	default:
		t.Errorf("Expected GenericEvent on EventChannel for qdel-5, but channel was empty")
	}

	// Reconcile qdel-5 to promote to Running
	req5 := ctrl.Request{NamespacedName: job5Key}
	_, _ = reconciler.Reconcile(ctx, req5)

	var cr5 reviewv1alpha1.PRReviewJob
	_ = fakeClient.Get(ctx, job5Key, &cr5)
	if cr5.Status.Phase != reviewv1alpha1.PhaseRunning {
		t.Errorf("Expected qdel-5 phase Running, got %s", cr5.Status.Phase)
	}
}

func TestEmpirical_ConcurrencyMetricsAndConditions(t *testing.T) {
	opmetrics.RegisterMetrics()
	scheme := setupTestScheme(t)
	qm := queue.NewQueueManager(3)
	ctx := context.Background()

	jobNames := []string{"metric-1", "metric-2", "metric-3", "metric-4", "metric-5"}
	var initialObjects []client.Object
	for i, name := range jobNames {
		j := &reviewv1alpha1.PRReviewJob{
			ObjectMeta: metav1.ObjectMeta{
				Name:      name,
				Namespace: "default",
			},
			Spec: reviewv1alpha1.PRReviewJobSpec{
				Repo:          "calltelemetry/cisco-cdr",
				PRNumber:      int32(400 + i),
				HeadSHA:       fmt.Sprintf("headsha%d", i),
				BaseSHA:       fmt.Sprintf("basesha%d", i),
				PersonaRoster: []string{"security"},
			},
		}
		initialObjects = append(initialObjects, j)
	}

	fakeClient := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(initialObjects...).
		WithStatusSubresource(&reviewv1alpha1.PRReviewJob{}, &batchv1.Job{}).
		Build()

	reconciler := &controllers.PRReviewJobReconciler{
		Client:       fakeClient,
		Scheme:       scheme,
		QueueManager: qm,
	}

	// Reconcile all 5 jobs sequentially
	for _, name := range jobNames {
		req := ctrl.Request{
			NamespacedName: types.NamespacedName{Namespace: "default", Name: name},
		}
		_, _ = reconciler.Reconcile(ctx, req)
	}

	// Verify Prometheus ActiveJobs & QueuedJobs metrics
	if active := testutil.ToFloat64(opmetrics.ActiveJobs); active != 3.0 {
		t.Errorf("Expected Prometheus ActiveJobs gauge 3.0, got %f", active)
	}
	if queued := testutil.ToFloat64(opmetrics.QueuedJobs); queued != 2.0 {
		t.Errorf("Expected Prometheus QueuedJobs gauge 2.0, got %f", queued)
	}

	// Verify Status Conditions on Queued jobs (metric-4 and metric-5)
	for _, name := range []string{"metric-4", "metric-5"} {
		var cr reviewv1alpha1.PRReviewJob
		err := fakeClient.Get(ctx, types.NamespacedName{Namespace: "default", Name: name}, &cr)
		if err != nil {
			t.Fatalf("Failed to fetch %s: %v", name, err)
		}
		if cr.Status.Phase != reviewv1alpha1.PhaseQueued {
			t.Errorf("Expected %s phase to be Queued, got %s", name, cr.Status.Phase)
		}

		foundQueuedCond := false
		for _, cond := range cr.Status.Conditions {
			if cond.Type == "Queued" {
				foundQueuedCond = true
				if cond.Status != metav1.ConditionTrue {
					t.Errorf("Expected condition Queued Status True for %s, got %s", name, cond.Status)
				}
				if cond.Reason != "QuotaExceeded" {
					t.Errorf("Expected condition Queued Reason QuotaExceeded for %s, got %s", name, cond.Reason)
				}
			}
		}
		if !foundQueuedCond {
			t.Errorf("Condition Type Queued not found on %s status conditions", name)
		}
	}

	// Complete job metric-1
	req1 := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: "default", Name: "metric-1"}}
	var k8sJob1 batchv1.Job
	_ = fakeClient.Get(ctx, types.NamespacedName{Namespace: "default", Name: "metric-1-job"}, &k8sJob1)
	k8sJob1.Status.Succeeded = 1
	_ = fakeClient.Status().Update(ctx, &k8sJob1)
	_, _ = reconciler.Reconcile(ctx, req1)

	// Reconcile promoted metric-4
	<-qm.EventChannel()
	req4 := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: "default", Name: "metric-4"}}
	_, _ = reconciler.Reconcile(ctx, req4)

	// Verify Prometheus metrics after promotion (3 active, 1 queued)
	if active := testutil.ToFloat64(opmetrics.ActiveJobs); active != 3.0 {
		t.Errorf("Expected Prometheus ActiveJobs gauge 3.0, got %f", active)
	}
	if queued := testutil.ToFloat64(opmetrics.QueuedJobs); queued != 1.0 {
		t.Errorf("Expected Prometheus QueuedJobs gauge 1.0, got %f", queued)
	}

	// Complete remaining jobs metric-2, metric-3, metric-4, metric-5
	for _, name := range []string{"metric-2", "metric-3", "metric-4", "metric-5"} {
		req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: "default", Name: name}}
		var k8sJob batchv1.Job
		err := fakeClient.Get(ctx, types.NamespacedName{Namespace: "default", Name: name + "-job"}, &k8sJob)
		if err == nil {
			k8sJob.Status.Succeeded = 1
			_ = fakeClient.Status().Update(ctx, &k8sJob)
		}
		_, _ = reconciler.Reconcile(ctx, req)
		select {
		case evt := <-qm.EventChannel():
			if evt.Object != nil {
				promotedReq := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: evt.Object.GetNamespace(), Name: evt.Object.GetName()}}
				_, _ = reconciler.Reconcile(ctx, promotedReq)
			}
		default:
		}
	}

	// Verify Prometheus metrics after all jobs completed (0 active, 0 queued)
	if active := testutil.ToFloat64(opmetrics.ActiveJobs); active != 0.0 {
		t.Errorf("Expected Prometheus ActiveJobs gauge 0.0 at completion, got %f", active)
	}
	if queued := testutil.ToFloat64(opmetrics.QueuedJobs); queued != 0.0 {
		t.Errorf("Expected Prometheus QueuedJobs gauge 0.0 at completion, got %f", queued)
	}
}
