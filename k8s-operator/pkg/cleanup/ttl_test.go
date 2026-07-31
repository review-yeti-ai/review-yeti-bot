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

package cleanup_test

import (
	"context"
	"testing"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	reviewv1alpha1 "github.com/calltelemetry/ct-review-bot/k8s-operator/api/v1alpha1"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/cleanup"
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

func TestIsTTLExpired(t *testing.T) {
	mgr := cleanup.NewTTLManager()
	now := time.Now()
	completion := metav1.NewTime(now.Add(-10 * time.Minute))

	tests := []struct {
		name              string
		job               *reviewv1alpha1.PRReviewJob
		now               time.Time
		expectedExpired   bool
		expectedRemaining time.Duration
	}{
		{
			name:              "Nil job -> not expired, 0 remaining",
			job:               nil,
			now:               now,
			expectedExpired:   false,
			expectedRemaining: 0,
		},
		{
			name: "Non-terminal phase -> not expired, 0 remaining",
			job: &reviewv1alpha1.PRReviewJob{
				Status: reviewv1alpha1.PRReviewJobStatus{
					Phase: reviewv1alpha1.PhaseRunning,
				},
			},
			now:               now,
			expectedExpired:   false,
			expectedRemaining: 0,
		},
		{
			name: "Terminal phase with nil CompletionTime -> not expired, 0 remaining",
			job: &reviewv1alpha1.PRReviewJob{
				Status: reviewv1alpha1.PRReviewJobStatus{
					Phase:          reviewv1alpha1.PhaseSucceeded,
					CompletionTime: nil,
				},
			},
			now:               now,
			expectedExpired:   false,
			expectedRemaining: 0,
		},
		{
			name: "Terminal phase with TTL=0 -> expired immediately",
			job: &reviewv1alpha1.PRReviewJob{
				Spec: reviewv1alpha1.PRReviewJobSpec{
					TTLSecondsAfterFinished: int32Ptr(0),
				},
				Status: reviewv1alpha1.PRReviewJobStatus{
					Phase:          reviewv1alpha1.PhaseSucceeded,
					CompletionTime: &completion,
				},
			},
			now:               now,
			expectedExpired:   true,
			expectedRemaining: 0,
		},
		{
			name: "Terminal phase completed 10m ago with 30m TTL -> not expired, ~20m remaining",
			job: &reviewv1alpha1.PRReviewJob{
				Spec: reviewv1alpha1.PRReviewJobSpec{
					TTLSecondsAfterFinished: int32Ptr(1800),
				},
				Status: reviewv1alpha1.PRReviewJobStatus{
					Phase:          reviewv1alpha1.PhaseSucceeded,
					CompletionTime: &completion,
				},
			},
			now:               now,
			expectedExpired:   false,
			expectedRemaining: 20 * time.Minute,
		},
		{
			name: "Terminal phase completed 40m ago with 30m TTL -> expired, 0 remaining",
			job: &reviewv1alpha1.PRReviewJob{
				Spec: reviewv1alpha1.PRReviewJobSpec{
					TTLSecondsAfterFinished: int32Ptr(1800),
				},
				Status: reviewv1alpha1.PRReviewJobStatus{
					Phase:          reviewv1alpha1.PhaseFailed,
					CompletionTime: &metav1.Time{Time: now.Add(-40 * time.Minute)},
				},
			},
			now:               now,
			expectedExpired:   true,
			expectedRemaining: 0,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			expired, remaining := mgr.IsTTLExpired(tt.job, tt.now)
			if expired != tt.expectedExpired {
				t.Errorf("IsTTLExpired() expired = %v, want %v", expired, tt.expectedExpired)
			}
			if tt.expectedRemaining > 0 {
				// Allow small tolerance for time calculations (e.g. within 1 second)
				diff := remaining - tt.expectedRemaining
				if diff < -time.Second || diff > time.Second {
					t.Errorf("IsTTLExpired() remaining = %v, want ~%v", remaining, tt.expectedRemaining)
				}
			} else if remaining != 0 {
				t.Errorf("IsTTLExpired() remaining = %v, want 0", remaining)
			}
		})
	}
}

func TestCleanupResources(t *testing.T) {
	scheme := setupTestScheme(t)
	mgr := cleanup.NewTTLManager()
	ctx := context.Background()

	jobCR := &reviewv1alpha1.PRReviewJob{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "test-cleanup-job",
			Namespace: "default",
		},
		Spec: reviewv1alpha1.PRReviewJobSpec{
			Repo:     "calltelemetry/cisco-cdr",
			PRNumber: 1,
		},
	}

	childJob := &batchv1.Job{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "test-cleanup-job-job",
			Namespace: "default",
		},
	}

	childPVC := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "test-cleanup-job-pvc",
			Namespace: "default",
		},
	}

	fakeClient := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(jobCR, childJob, childPVC).
		Build()

	// Perform cleanup
	err := mgr.CleanupResources(ctx, fakeClient, jobCR)
	if err != nil {
		t.Fatalf("CleanupResources unexpected error: %v", err)
	}

	// Verify childJob deleted
	var fetchedJob batchv1.Job
	err = fakeClient.Get(ctx, types.NamespacedName{Namespace: "default", Name: "test-cleanup-job-job"}, &fetchedJob)
	if err == nil {
		t.Errorf("Expected batch/v1 Job to be deleted, but it still exists")
	}

	// Verify childPVC deleted
	var fetchedPVC corev1.PersistentVolumeClaim
	err = fakeClient.Get(ctx, types.NamespacedName{Namespace: "default", Name: "test-cleanup-job-pvc"}, &fetchedPVC)
	if err == nil {
		t.Errorf("Expected PVC to be deleted, but it still exists")
	}

	// Verify PRReviewJob CR deleted
	var fetchedCR reviewv1alpha1.PRReviewJob
	err = fakeClient.Get(ctx, types.NamespacedName{Namespace: "default", Name: "test-cleanup-job"}, &fetchedCR)
	if err == nil {
		t.Errorf("Expected PRReviewJob CR to be deleted, but it still exists")
	}

	// Clean up already deleted resources should be idempotent and return no error
	err = mgr.CleanupResources(ctx, fakeClient, jobCR)
	if err != nil {
		t.Errorf("CleanupResources on non-existent resources returned error: %v", err)
	}

	// Nil job should return no error
	err = mgr.CleanupResources(ctx, fakeClient, nil)
	if err != nil {
		t.Errorf("CleanupResources on nil job returned error: %v", err)
	}
}

func int32Ptr(i int32) *int32 {
	return &i
}
