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
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/go-logr/logr"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
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
	"sigs.k8s.io/controller-runtime/pkg/config"
	"sigs.k8s.io/controller-runtime/pkg/healthz"
	"sigs.k8s.io/controller-runtime/pkg/manager"
	"sigs.k8s.io/controller-runtime/pkg/webhook"

	reviewv1alpha1 "github.com/calltelemetry/ct-review-bot/k8s-operator/api/v1alpha1"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/controllers"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/queue"
)

func setupTestScheme(t *testing.T) *runtime.Scheme {
	t.Helper()
	scheme := runtime.NewScheme()
	if err := corev1.AddToScheme(scheme); err != nil {
		t.Fatalf("Failed to add corev1 to scheme: %v", err)
	}
	if err := batchv1.AddToScheme(scheme); err != nil {
		t.Fatalf("Failed to add batchv1 to scheme: %v", err)
	}
	if err := reviewv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatalf("Failed to add reviewv1alpha1 to scheme: %v", err)
	}
	return scheme
}

func TestPRReviewJobReconciler_QueuedToRunning(t *testing.T) {
	scheme := setupTestScheme(t)

	jobObj := &reviewv1alpha1.PRReviewJob{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "test-job-1",
			Namespace: "default",
		},
		Spec: reviewv1alpha1.PRReviewJobSpec{
			Repo:          "calltelemetry/cisco-cdr",
			PRNumber:      42,
			HeadSHA:       "1234567890",
			BaseSHA:       "0987654321",
			PersonaRoster: []string{"security", "qa"},
		},
	}

	fakeClient := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(jobObj).
		WithStatusSubresource(&reviewv1alpha1.PRReviewJob{}).
		Build()

	qm := queue.NewQueueManager(3)
	reconciler := &controllers.PRReviewJobReconciler{
		Client:       fakeClient,
		Scheme:       scheme,
		QueueManager: qm,
	}

	req := ctrl.Request{
		NamespacedName: types.NamespacedName{
			Namespace: "default",
			Name:      "test-job-1",
		},
	}

	// Reconcile -> Should acquire slot, build PVC & Job, update status to Running
	res, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("Reconcile returned unexpected error: %v", err)
	}
	if res.Requeue {
		t.Errorf("Expected Requeue=false, got true")
	}

	// Verify updated CR status
	var updatedJob reviewv1alpha1.PRReviewJob
	err = fakeClient.Get(context.Background(), req.NamespacedName, &updatedJob)
	if err != nil {
		t.Fatalf("Failed to get updated PRReviewJob: %v", err)
	}

	if updatedJob.Status.Phase != reviewv1alpha1.PhaseRunning {
		t.Errorf("Expected phase %s, got %s", reviewv1alpha1.PhaseRunning, updatedJob.Status.Phase)
	}
	if updatedJob.Status.JobName != "test-job-1-job" {
		t.Errorf("Expected JobName test-job-1-job, got %s", updatedJob.Status.JobName)
	}
	if updatedJob.Status.PVCName != "test-job-1-pvc" {
		t.Errorf("Expected PVCName test-job-1-pvc, got %s", updatedJob.Status.PVCName)
	}
	if updatedJob.Status.StartTime == nil {
		t.Errorf("Expected StartTime to be set")
	}
	if len(updatedJob.Status.PersonaProgress) != 2 {
		t.Fatalf("Expected 2 persona progress items, got %d", len(updatedJob.Status.PersonaProgress))
	}
	if updatedJob.Status.PersonaProgress[0].Status != "Running" {
		t.Errorf("Expected PersonaProgress[0] status Running, got %s", updatedJob.Status.PersonaProgress[0].Status)
	}

	// Verify PVC creation
	var pvc corev1.PersistentVolumeClaim
	err = fakeClient.Get(context.Background(), types.NamespacedName{Namespace: "default", Name: "test-job-1-pvc"}, &pvc)
	if err != nil {
		t.Fatalf("Expected PVC test-job-1-pvc to exist: %v", err)
	}
	if len(pvc.Spec.AccessModes) == 0 || pvc.Spec.AccessModes[0] != corev1.ReadWriteOnce {
		t.Errorf("Expected PVC ReadWriteOnce access mode")
	}

	// Verify Job creation
	var k8sJob batchv1.Job
	err = fakeClient.Get(context.Background(), types.NamespacedName{Namespace: "default", Name: "test-job-1-job"}, &k8sJob)
	if err != nil {
		t.Fatalf("Expected Job test-job-1-job to exist: %v", err)
	}
	if k8sJob.Spec.Template.Spec.Containers[0].Name != "reviewer-worker" {
		t.Errorf("Expected container reviewer-worker, got %s", k8sJob.Spec.Template.Spec.Containers[0].Name)
	}
}

func TestPRReviewJobReconciler_MaxConcurrencyHolding(t *testing.T) {
	scheme := setupTestScheme(t)
	qm := queue.NewQueueManager(3)

	// Fill queue with 3 active jobs
	j1 := types.NamespacedName{Namespace: "default", Name: "job-active-1"}
	j2 := types.NamespacedName{Namespace: "default", Name: "job-active-2"}
	j3 := types.NamespacedName{Namespace: "default", Name: "job-active-3"}
	qm.AcquireSlot(j1)
	qm.AcquireSlot(j2)
	qm.AcquireSlot(j3)

	job4Obj := &reviewv1alpha1.PRReviewJob{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "test-job-4",
			Namespace: "default",
		},
		Spec: reviewv1alpha1.PRReviewJobSpec{
			Repo:          "calltelemetry/cisco-cdr",
			PRNumber:      44,
			HeadSHA:       "1234567890",
			BaseSHA:       "0987654321",
			PersonaRoster: []string{"security"},
		},
	}

	fakeClient := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(job4Obj).
		WithStatusSubresource(&reviewv1alpha1.PRReviewJob{}).
		Build()

	reconciler := &controllers.PRReviewJobReconciler{
		Client:       fakeClient,
		Scheme:       scheme,
		QueueManager: qm,
	}

	req := ctrl.Request{
		NamespacedName: types.NamespacedName{
			Namespace: "default",
			Name:      "test-job-4",
		},
	}

	// Reconcile job4 when max concurrency reached
	_, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("Reconcile returned error: %v", err)
	}

	var updatedJob reviewv1alpha1.PRReviewJob
	err = fakeClient.Get(context.Background(), req.NamespacedName, &updatedJob)
	if err != nil {
		t.Fatalf("Failed to get job4: %v", err)
	}

	if updatedJob.Status.Phase != reviewv1alpha1.PhaseQueued {
		t.Errorf("Expected job phase to be Queued, got %s", updatedJob.Status.Phase)
	}

	// Verify PVC and Job were NOT created
	var pvc corev1.PersistentVolumeClaim
	err = fakeClient.Get(context.Background(), types.NamespacedName{Namespace: "default", Name: "test-job-4-pvc"}, &pvc)
	if err == nil {
		t.Errorf("PVC should NOT have been created for queued job!")
	}

	var k8sJob batchv1.Job
	err = fakeClient.Get(context.Background(), types.NamespacedName{Namespace: "default", Name: "test-job-4-job"}, &k8sJob)
	if err == nil {
		t.Errorf("batch/v1 Job should NOT have been created for queued job!")
	}
}

func TestPRReviewJobReconciler_JobCompletionToSucceeded(t *testing.T) {
	scheme := setupTestScheme(t)
	qm := queue.NewQueueManager(3)

	jobKey := types.NamespacedName{Namespace: "default", Name: "test-job-succ"}
	qm.AcquireSlot(jobKey)

	jobObj := &reviewv1alpha1.PRReviewJob{
		ObjectMeta: metav1.ObjectMeta{
			Name:      jobKey.Name,
			Namespace: jobKey.Namespace,
		},
		Spec: reviewv1alpha1.PRReviewJobSpec{
			Repo:          "calltelemetry/cisco-cdr",
			PRNumber:      50,
			HeadSHA:       "1234567890",
			BaseSHA:       "0987654321",
			PersonaRoster: []string{"security"},
		},
		Status: reviewv1alpha1.PRReviewJobStatus{
			Phase:   reviewv1alpha1.PhaseRunning,
			JobName: "test-job-succ-job",
			PVCName: "test-job-succ-pvc",
			PersonaProgress: []reviewv1alpha1.PersonaProgress{
				{Persona: "security", Status: "Running"},
			},
		},
	}

	pvcObj := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "test-job-succ-pvc",
			Namespace: jobKey.Namespace,
		},
	}

	k8sJobObj := &batchv1.Job{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "test-job-succ-job",
			Namespace: jobKey.Namespace,
		},
		Status: batchv1.JobStatus{
			Succeeded: 1,
		},
	}

	fakeClient := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(jobObj, pvcObj, k8sJobObj).
		WithStatusSubresource(&reviewv1alpha1.PRReviewJob{}).
		Build()

	reconciler := &controllers.PRReviewJobReconciler{
		Client:       fakeClient,
		Scheme:       scheme,
		QueueManager: qm,
	}

	req := ctrl.Request{NamespacedName: jobKey}
	_, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("Reconcile returned error: %v", err)
	}

	var updatedJob reviewv1alpha1.PRReviewJob
	if err := fakeClient.Get(context.Background(), jobKey, &updatedJob); err != nil {
		t.Fatalf("Failed to fetch job: %v", err)
	}

	if updatedJob.Status.Phase != reviewv1alpha1.PhaseSucceeded {
		t.Errorf("Expected phase Succeeded, got %s", updatedJob.Status.Phase)
	}
	if updatedJob.Status.Verdict != "APPROVED" {
		t.Errorf("Expected verdict APPROVED, got %s", updatedJob.Status.Verdict)
	}
	if updatedJob.Status.CompletionTime == nil {
		t.Errorf("Expected CompletionTime to be set")
	}
	if updatedJob.Status.PersonaProgress[0].Status != "Completed" {
		t.Errorf("Expected persona progress Completed, got %s", updatedJob.Status.PersonaProgress[0].Status)
	}

	// Verify slot was released from QueueManager
	if qm.IsActive(jobKey) {
		t.Errorf("Expected slot for job to be released from QueueManager")
	}
}

func TestPRReviewJobReconciler_JobFailureToFailed(t *testing.T) {
	scheme := setupTestScheme(t)
	qm := queue.NewQueueManager(3)

	jobKey := types.NamespacedName{Namespace: "default", Name: "test-job-fail"}
	qm.AcquireSlot(jobKey)

	jobObj := &reviewv1alpha1.PRReviewJob{
		ObjectMeta: metav1.ObjectMeta{
			Name:      jobKey.Name,
			Namespace: jobKey.Namespace,
		},
		Spec: reviewv1alpha1.PRReviewJobSpec{
			Repo:          "calltelemetry/cisco-cdr",
			PRNumber:      51,
			HeadSHA:       "1234567890",
			BaseSHA:       "0987654321",
			PersonaRoster: []string{"security"},
		},
		Status: reviewv1alpha1.PRReviewJobStatus{
			Phase:   reviewv1alpha1.PhaseRunning,
			JobName: "test-job-fail-job",
			PVCName: "test-job-fail-pvc",
			PersonaProgress: []reviewv1alpha1.PersonaProgress{
				{Persona: "security", Status: "Running"},
			},
		},
	}

	pvcObj := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "test-job-fail-pvc",
			Namespace: jobKey.Namespace,
		},
	}

	k8sJobObj := &batchv1.Job{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "test-job-fail-job",
			Namespace: jobKey.Namespace,
		},
		Status: batchv1.JobStatus{
			Failed: 1,
		},
	}

	fakeClient := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(jobObj, pvcObj, k8sJobObj).
		WithStatusSubresource(&reviewv1alpha1.PRReviewJob{}).
		Build()

	reconciler := &controllers.PRReviewJobReconciler{
		Client:       fakeClient,
		Scheme:       scheme,
		QueueManager: qm,
	}

	req := ctrl.Request{NamespacedName: jobKey}
	_, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("Reconcile returned error: %v", err)
	}

	var updatedJob reviewv1alpha1.PRReviewJob
	if err := fakeClient.Get(context.Background(), jobKey, &updatedJob); err != nil {
		t.Fatalf("Failed to fetch job: %v", err)
	}

	if updatedJob.Status.Phase != reviewv1alpha1.PhaseFailed {
		t.Errorf("Expected phase Failed, got %s", updatedJob.Status.Phase)
	}
	if updatedJob.Status.CompletionTime == nil {
		t.Errorf("Expected CompletionTime to be set")
	}
	if updatedJob.Status.PersonaProgress[0].Status != "Failed" {
		t.Errorf("Expected persona progress Failed, got %s", updatedJob.Status.PersonaProgress[0].Status)
	}

	// Verify slot was released from QueueManager
	if qm.IsActive(jobKey) {
		t.Errorf("Expected slot for job to be released from QueueManager")
	}
}

func TestPRReviewJobReconciler_DeletedCR(t *testing.T) {
	scheme := setupTestScheme(t)
	qm := queue.NewQueueManager(3)

	jobKey := types.NamespacedName{Namespace: "default", Name: "test-deleted-job"}
	qm.AcquireSlot(jobKey)

	fakeClient := fake.NewClientBuilder().
		WithScheme(scheme).
		Build()

	reconciler := &controllers.PRReviewJobReconciler{
		Client:       fakeClient,
		Scheme:       scheme,
		QueueManager: qm,
	}

	req := ctrl.Request{NamespacedName: jobKey}
	_, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("Reconcile returned error for deleted CR: %v", err)
	}

	// Verify job was removed from QueueManager
	if qm.IsActive(jobKey) || qm.IsQueued(jobKey) {
		t.Errorf("Expected deleted job to be removed from QueueManager")
	}
}

func TestCalculateVerdict(t *testing.T) {
	tests := []struct {
		name           string
		job            *reviewv1alpha1.PRReviewJob
		jobFailed      bool
		expectedResult string
	}{
		{
			name:           "Job failed flag set -> FAILED",
			job:            &reviewv1alpha1.PRReviewJob{},
			jobFailed:      true,
			expectedResult: reviewv1alpha1.VerdictFailed,
		},
		{
			name: "Persona progress contains FAILED -> FAILED",
			job: &reviewv1alpha1.PRReviewJob{
				Status: reviewv1alpha1.PRReviewJobStatus{
					PersonaProgress: []reviewv1alpha1.PersonaProgress{
						{Persona: "security", Status: "FAILED"},
						{Persona: "qa", Status: "APPROVED"},
					},
				},
			},
			jobFailed:      false,
			expectedResult: reviewv1alpha1.VerdictFailed,
		},
		{
			name: "Persona progress map contains CHANGES_REQUESTED -> CHANGES_REQUESTED",
			job: &reviewv1alpha1.PRReviewJob{
				Status: reviewv1alpha1.PRReviewJobStatus{
					PersonaProgressMap: map[string]string{
						"security": "CHANGES_REQUESTED",
						"qa":       "Completed",
					},
				},
			},
			jobFailed:      false,
			expectedResult: reviewv1alpha1.VerdictChangesRequested,
		},
		{
			name: "Precedence FAILED > CHANGES_REQUESTED",
			job: &reviewv1alpha1.PRReviewJob{
				Status: reviewv1alpha1.PRReviewJobStatus{
					PersonaProgressMap: map[string]string{
						"security": "FAILED",
						"qa":       "CHANGES_REQUESTED",
					},
				},
			},
			jobFailed:      false,
			expectedResult: reviewv1alpha1.VerdictFailed,
		},
		{
			name: "Precedence CHANGES_REQUESTED > COMMENT",
			job: &reviewv1alpha1.PRReviewJob{
				Status: reviewv1alpha1.PRReviewJobStatus{
					PersonaProgressMap: map[string]string{
						"security": "CHANGES_REQUESTED",
						"qa":       "COMMENT",
					},
				},
			},
			jobFailed:      false,
			expectedResult: reviewv1alpha1.VerdictChangesRequested,
		},
		{
			name: "Precedence COMMENT > APPROVED",
			job: &reviewv1alpha1.PRReviewJob{
				Status: reviewv1alpha1.PRReviewJobStatus{
					PersonaProgressMap: map[string]string{
						"security": "COMMENT",
						"qa":       "APPROVED",
					},
				},
			},
			jobFailed:      false,
			expectedResult: reviewv1alpha1.VerdictComment,
		},
		{
			name: "Precedence FAILED > CHANGES_REQUESTED > COMMENT > APPROVED (All combined)",
			job: &reviewv1alpha1.PRReviewJob{
				Status: reviewv1alpha1.PRReviewJobStatus{
					PersonaProgress: []reviewv1alpha1.PersonaProgress{
						{Persona: "sec", Status: "COMMENT"},
						{Persona: "arch", Status: "APPROVED"},
					},
					PersonaProgressMap: map[string]string{
						"qa":       "CHANGES_REQUESTED",
						"ops":      "FAILED",
						"reviewer": "APPROVED",
					},
				},
			},
			jobFailed:      false,
			expectedResult: reviewv1alpha1.VerdictFailed,
		},
		{
			name: "Persona progress map contains COMMENT -> COMMENT",
			job: &reviewv1alpha1.PRReviewJob{
				Status: reviewv1alpha1.PRReviewJobStatus{
					PersonaProgressMap: map[string]string{
						"security": "COMMENT",
						"qa":       "Completed",
					},
				},
			},
			jobFailed:      false,
			expectedResult: reviewv1alpha1.VerdictComment,
		},
		{
			name: "All completed -> APPROVED",
			job: &reviewv1alpha1.PRReviewJob{
				Status: reviewv1alpha1.PRReviewJobStatus{
					PersonaProgressMap: map[string]string{
						"security": "Completed",
						"qa":       "Completed",
					},
				},
			},
			jobFailed:      false,
			expectedResult: reviewv1alpha1.VerdictApproved,
		},
		{
			name: "Case sensitivity and leading/trailing whitespace handling",
			job: &reviewv1alpha1.PRReviewJob{
				Status: reviewv1alpha1.PRReviewJobStatus{
					PersonaProgressMap: map[string]string{
						"security": "  changes_requested  ",
						"qa":       "  comment  ",
					},
				},
			},
			jobFailed:      false,
			expectedResult: reviewv1alpha1.VerdictChangesRequested,
		},
		{
			name: "Message string inspection flags FAILED",
			job: &reviewv1alpha1.PRReviewJob{
				Status: reviewv1alpha1.PRReviewJobStatus{
					PersonaProgress: []reviewv1alpha1.PersonaProgress{
						{Persona: "security", Status: "COMPLETED", Message: "Task execution failed unexpectedly"},
					},
				},
			},
			jobFailed:      false,
			expectedResult: reviewv1alpha1.VerdictFailed,
		},
		{
			name:           "Nil job pointer defaults to APPROVED",
			job:            nil,
			jobFailed:      false,
			expectedResult: reviewv1alpha1.VerdictApproved,
		},
		{
			name:           "Nil job pointer with jobFailed=true returns FAILED",
			job:            nil,
			jobFailed:      true,
			expectedResult: reviewv1alpha1.VerdictFailed,
		},
		{
			name: "Empty status and unrecognized status strings default to APPROVED",
			job: &reviewv1alpha1.PRReviewJob{
				Status: reviewv1alpha1.PRReviewJobStatus{
					PersonaProgressMap: map[string]string{
						"security": "PASSED",
						"qa":       "SUCCESS",
					},
				},
			},
			jobFailed:      false,
			expectedResult: reviewv1alpha1.VerdictApproved,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := controllers.CalculateVerdict(tt.job, tt.jobFailed)
			if result != tt.expectedResult {
				t.Errorf("CalculateVerdict mismatch: got %s, want %s", result, tt.expectedResult)
			}
		})
	}
}

// TestEmpirical_CalculateVerdict_DynamicPrecedence_RaceStress executes 100 concurrent goroutines
// evaluating CalculateVerdict with dynamic inputs under race detection.
func TestEmpirical_CalculateVerdict_DynamicPrecedence_RaceStress(t *testing.T) {
	numGoroutines := 100
	iterations := 500

	var wg sync.WaitGroup
	wg.Add(numGoroutines)

	for g := 0; g < numGoroutines; g++ {
		go func(gid int) {
			defer wg.Done()

			for i := 0; i < iterations; i++ {
				var expected string
				job := &reviewv1alpha1.PRReviewJob{}

				switch (gid + i) % 4 {
				case 0:
					expected = reviewv1alpha1.VerdictFailed
					if i%2 == 0 {
						job.Status.PersonaProgressMap = map[string]string{"p1": "FAILED", "p2": "APPROVED"}
					} else {
						job.Status.PersonaProgress = []reviewv1alpha1.PersonaProgress{{Persona: "p1", Status: "FAILED"}}
					}
				case 1:
					expected = reviewv1alpha1.VerdictChangesRequested
					job.Status.PersonaProgressMap = map[string]string{"p1": "CHANGES_REQUESTED", "p2": "COMMENT"}
				case 2:
					expected = reviewv1alpha1.VerdictComment
					job.Status.PersonaProgressMap = map[string]string{"p1": "COMMENT", "p2": "APPROVED"}
				case 3:
					expected = reviewv1alpha1.VerdictApproved
					job.Status.PersonaProgressMap = map[string]string{"p1": "APPROVED", "p2": "Completed"}
				}

				res := controllers.CalculateVerdict(job, false)
				if res != expected {
					t.Errorf("Goroutine %d iteration %d: expected %s, got %s", gid, i, expected, res)
				}
			}
		}(g)
	}

	wg.Wait()
}

func TestPRReviewJobReconciler_TTLCleanupScheduled(t *testing.T) {
	scheme := setupTestScheme(t)
	qm := queue.NewQueueManager(3)

	jobKey := types.NamespacedName{Namespace: "default", Name: "test-ttl-job"}
	now := metav1.Now()

	ttlVal := int32(1800)
	jobObj := &reviewv1alpha1.PRReviewJob{
		ObjectMeta: metav1.ObjectMeta{
			Name:      jobKey.Name,
			Namespace: jobKey.Namespace,
		},
		Spec: reviewv1alpha1.PRReviewJobSpec{
			Repo:                    "calltelemetry/cisco-cdr",
			PRNumber:                60,
			TTLSecondsAfterFinished: &ttlVal,
		},
		Status: reviewv1alpha1.PRReviewJobStatus{
			Phase:          reviewv1alpha1.PhaseSucceeded,
			CompletionTime: &now,
		},
	}

	fakeClient := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(jobObj).
		WithStatusSubresource(&reviewv1alpha1.PRReviewJob{}).
		Build()

	reconciler := &controllers.PRReviewJobReconciler{
		Client:       fakeClient,
		Scheme:       scheme,
		QueueManager: qm,
	}

	req := ctrl.Request{NamespacedName: jobKey}
	res, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("Reconcile returned error: %v", err)
	}

	if res.RequeueAfter <= 0 {
		t.Errorf("Expected RequeueAfter > 0 for completed job within TTL, got %v", res.RequeueAfter)
	}
}

func TestPRReviewJobReconciler_TTLExpiredGarbageCollected(t *testing.T) {
	scheme := setupTestScheme(t)
	qm := queue.NewQueueManager(3)

	jobKey := types.NamespacedName{Namespace: "default", Name: "test-expired-job"}
	pastTime := metav1.NewTime(time.Now().Add(-40 * time.Minute))

	ttlVal := int32(1800) // 30 minutes
	jobObj := &reviewv1alpha1.PRReviewJob{
		ObjectMeta: metav1.ObjectMeta{
			Name:      jobKey.Name,
			Namespace: jobKey.Namespace,
		},
		Spec: reviewv1alpha1.PRReviewJobSpec{
			Repo:                    "calltelemetry/cisco-cdr",
			PRNumber:                61,
			TTLSecondsAfterFinished: &ttlVal,
		},
		Status: reviewv1alpha1.PRReviewJobStatus{
			Phase:          reviewv1alpha1.PhaseSucceeded,
			CompletionTime: &pastTime,
		},
	}

	pvcObj := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "test-expired-job-pvc",
			Namespace: jobKey.Namespace,
		},
	}

	k8sJobObj := &batchv1.Job{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "test-expired-job-job",
			Namespace: jobKey.Namespace,
		},
	}

	fakeClient := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(jobObj, pvcObj, k8sJobObj).
		WithStatusSubresource(&reviewv1alpha1.PRReviewJob{}).
		Build()

	reconciler := &controllers.PRReviewJobReconciler{
		Client:       fakeClient,
		Scheme:       scheme,
		QueueManager: qm,
	}

	req := ctrl.Request{NamespacedName: jobKey}
	res, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("Reconcile returned error: %v", err)
	}

	if res.RequeueAfter != 0 {
		t.Errorf("Expected RequeueAfter == 0 for expired job, got %v", res.RequeueAfter)
	}

	// Verify PRReviewJob CR was deleted
	var fetchedCR reviewv1alpha1.PRReviewJob
	err = fakeClient.Get(context.Background(), jobKey, &fetchedCR)
	if !errors.IsNotFound(err) {
		t.Errorf("Expected PRReviewJob CR to be garbage collected, err: %v", err)
	}

	// Verify child PVC was deleted
	var fetchedPVC corev1.PersistentVolumeClaim
	err = fakeClient.Get(context.Background(), types.NamespacedName{Namespace: jobKey.Namespace, Name: "test-expired-job-pvc"}, &fetchedPVC)
	if !errors.IsNotFound(err) {
		t.Errorf("Expected PVC to be garbage collected, err: %v", err)
	}

	// Verify child Job was deleted
	var fetchedJob batchv1.Job
	err = fakeClient.Get(context.Background(), types.NamespacedName{Namespace: jobKey.Namespace, Name: "test-expired-job-job"}, &fetchedJob)
	if !errors.IsNotFound(err) {
		t.Errorf("Expected batch/v1 Job to be garbage collected, err: %v", err)
	}
}

func TestPRReviewJobReconciler_TTLZeroImmediateCleanup(t *testing.T) {
	scheme := setupTestScheme(t)
	qm := queue.NewQueueManager(3)

	jobKey := types.NamespacedName{Namespace: "default", Name: "test-ttl0-job"}
	now := metav1.Now()

	ttlVal := int32(0)
	jobObj := &reviewv1alpha1.PRReviewJob{
		ObjectMeta: metav1.ObjectMeta{
			Name:      jobKey.Name,
			Namespace: jobKey.Namespace,
		},
		Spec: reviewv1alpha1.PRReviewJobSpec{
			Repo:                    "calltelemetry/cisco-cdr",
			PRNumber:                62,
			TTLSecondsAfterFinished: &ttlVal,
		},
		Status: reviewv1alpha1.PRReviewJobStatus{
			Phase:          reviewv1alpha1.PhaseSucceeded,
			CompletionTime: &now,
		},
	}

	fakeClient := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(jobObj).
		WithStatusSubresource(&reviewv1alpha1.PRReviewJob{}).
		Build()

	reconciler := &controllers.PRReviewJobReconciler{
		Client:       fakeClient,
		Scheme:       scheme,
		QueueManager: qm,
	}

	req := ctrl.Request{NamespacedName: jobKey}
	res, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("Reconcile returned error: %v", err)
	}

	if res.RequeueAfter != 0 {
		t.Errorf("Expected RequeueAfter == 0 for TTL=0, got %v", res.RequeueAfter)
	}

	// Verify CR deleted
	var fetchedCR reviewv1alpha1.PRReviewJob
	err = fakeClient.Get(context.Background(), jobKey, &fetchedCR)
	if !errors.IsNotFound(err) {
		t.Errorf("Expected PRReviewJob CR to be garbage collected immediately for TTL=0")
	}
}

type mockManager struct {
	scheme *runtime.Scheme
	client client.Client
}

func (m *mockManager) SetFields(interface{}) error                              { return nil }
func (m *mockManager) Add(manager.Runnable) error                               { return nil }
func (m *mockManager) AddHealthzCheck(name string, check healthz.Checker) error { return nil }
func (m *mockManager) AddReadyzCheck(name string, check healthz.Checker) error  { return nil }
func (m *mockManager) AddMetricsServerExtraHandler(path string, handler http.Handler) error {
	return nil
}
func (m *mockManager) GetHTTPClient() *http.Client      { return &http.Client{} }
func (m *mockManager) GetWebhookServer() webhook.Server { return nil }
func (m *mockManager) Elected() <-chan struct{} {
	ch := make(chan struct{})
	close(ch)
	return ch
}
func (m *mockManager) Start(ctx context.Context) error      { return nil }
func (m *mockManager) GetConfig() *rest.Config              { return &rest.Config{} }
func (m *mockManager) GetScheme() *runtime.Scheme           { return m.scheme }
func (m *mockManager) GetClient() client.Client             { return m.client }
func (m *mockManager) GetFieldIndexer() client.FieldIndexer { return nil }
func (m *mockManager) GetCache() cache.Cache                { return nil }
func (m *mockManager) GetEventRecorderFor(name string) record.EventRecorder {
	return record.NewFakeRecorder(10)
}
func (m *mockManager) GetRESTMapper() meta.RESTMapper {
	rm := meta.NewDefaultRESTMapper([]schema.GroupVersion{
		reviewv1alpha1.GroupVersion,
		batchv1.SchemeGroupVersion,
		corev1.SchemeGroupVersion,
	})
	rm.Add(reviewv1alpha1.GroupVersion.WithKind("PRReviewJob"), meta.RESTScopeNamespace)
	rm.Add(corev1.SchemeGroupVersion.WithKind("PersistentVolumeClaim"), meta.RESTScopeNamespace)
	rm.Add(batchv1.SchemeGroupVersion.WithKind("Job"), meta.RESTScopeNamespace)
	return rm
}
func (m *mockManager) GetAPIReader() client.Reader { return m.client }
func (m *mockManager) GetLogger() logr.Logger      { return logr.Discard() }
func (m *mockManager) GetControllerOptions() config.Controller {
	return config.Controller{}
}

func TestPRReviewJobReconciler_SetupWithManager(t *testing.T) {
	scheme := setupTestScheme(t)
	fakeClient := fake.NewClientBuilder().WithScheme(scheme).Build()

	mockMgr := &mockManager{
		scheme: scheme,
		client: fakeClient,
	}

	qm := queue.NewQueueManager(3)
	reconciler := &controllers.PRReviewJobReconciler{
		Client:       fakeClient,
		Scheme:       scheme,
		QueueManager: qm,
	}

	err := reconciler.SetupWithManager(mockMgr)
	if err != nil {
		t.Fatalf("SetupWithManager failed: %v", err)
	}

	// Test without QueueManager as well
	reconcilerNoQM := &controllers.PRReviewJobReconciler{
		Client: fakeClient,
		Scheme: scheme,
	}
	err = reconcilerNoQM.SetupWithManager(mockMgr)
	if err != nil {
		t.Fatalf("SetupWithManager without QueueManager failed: %v", err)
	}
}

func TestPRReviewJobReconciler_PersonaProgressMap_FailureInitialization(t *testing.T) {
	scheme := setupTestScheme(t)
	qm := queue.NewQueueManager(3)

	jobKey := types.NamespacedName{Namespace: "default", Name: "uninit-job-fail"}
	qm.AcquireSlot(jobKey)

	// An uninitialized job has nil or empty PersonaProgressMap
	jobObj := &reviewv1alpha1.PRReviewJob{
		ObjectMeta: metav1.ObjectMeta{
			Name:      jobKey.Name,
			Namespace: jobKey.Namespace,
		},
		Spec: reviewv1alpha1.PRReviewJobSpec{
			Repo:          "calltelemetry/cisco-cdr",
			PRNumber:      70,
			HeadSHA:       "1234567890",
			BaseSHA:       "0987654321",
			PersonaRoster: []string{"security", "qa", "architecture"},
		},
		Status: reviewv1alpha1.PRReviewJobStatus{
			Phase:              reviewv1alpha1.PhaseRunning,
			JobName:            "uninit-job-fail-job",
			PVCName:            "uninit-job-fail-pvc",
			PersonaProgressMap: nil, // explicitly uninitialized / nil
		},
	}

	pvcObj := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "uninit-job-fail-pvc",
			Namespace: jobKey.Namespace,
		},
	}

	k8sJobObj := &batchv1.Job{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "uninit-job-fail-job",
			Namespace: jobKey.Namespace,
		},
		Status: batchv1.JobStatus{
			Failed: 1,
		},
	}

	fakeClient := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(jobObj, pvcObj, k8sJobObj).
		WithStatusSubresource(&reviewv1alpha1.PRReviewJob{}).
		Build()

	reconciler := &controllers.PRReviewJobReconciler{
		Client:       fakeClient,
		Scheme:       scheme,
		QueueManager: qm,
	}

	req := ctrl.Request{NamespacedName: jobKey}
	_, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("Reconcile returned error: %v", err)
	}

	var updatedJob reviewv1alpha1.PRReviewJob
	if err := fakeClient.Get(context.Background(), jobKey, &updatedJob); err != nil {
		t.Fatalf("Failed to fetch job: %v", err)
	}

	if updatedJob.Status.Phase != reviewv1alpha1.PhaseFailed {
		t.Errorf("Expected phase Failed, got %s", updatedJob.Status.Phase)
	}
	if updatedJob.Status.PersonaProgressMap == nil {
		t.Fatalf("Expected PersonaProgressMap to be initialized, got nil")
	}

	for _, persona := range []string{"security", "qa", "architecture"} {
		if status, exists := updatedJob.Status.PersonaProgressMap[persona]; !exists {
			t.Errorf("Expected PersonaProgressMap to contain key %s, but missing", persona)
		} else if status != "Failed" {
			t.Errorf("Expected PersonaProgressMap[%s] to be Failed, got %s", persona, status)
		}
	}
}
