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
	"fmt"
	"math"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	reviewv1alpha1 "github.com/calltelemetry/ct-review-bot/k8s-operator/api/v1alpha1"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/cleanup"
)

// TestEmpirical_TTLExpirationCalculations_Stress tests high-concurrency evaluation of IsTTLExpired
// across boundary conditions, nano-second precision thresholds, and extreme value inputs.
func TestEmpirical_TTLExpirationCalculations_Stress(t *testing.T) {
	mgr := cleanup.NewTTLManager()
	now := time.Now()
	completionPast := metav1.NewTime(now.Add(-10 * time.Minute))
	completionFarPast := metav1.NewTime(now.Add(-100 * 24 * time.Hour))
	completionFuture := metav1.NewTime(now.Add(10 * time.Minute))

	jobs := []*reviewv1alpha1.PRReviewJob{
		nil,
		{
			Status: reviewv1alpha1.PRReviewJobStatus{
				Phase: reviewv1alpha1.PhaseRunning,
			},
		},
		{
			Status: reviewv1alpha1.PRReviewJobStatus{
				Phase:          reviewv1alpha1.PhaseSucceeded,
				CompletionTime: nil,
			},
		},
		{
			Spec: reviewv1alpha1.PRReviewJobSpec{
				TTLSecondsAfterFinished: int32Ptr(0),
			},
			Status: reviewv1alpha1.PRReviewJobStatus{
				Phase:          reviewv1alpha1.PhaseSucceeded,
				CompletionTime: &completionPast,
			},
		},
		{
			Spec: reviewv1alpha1.PRReviewJobSpec{
				TTLSecondsAfterFinished: int32Ptr(1800),
			},
			Status: reviewv1alpha1.PRReviewJobStatus{
				Phase:          reviewv1alpha1.PhaseSucceeded,
				CompletionTime: &completionPast,
			},
		},
		{
			Spec: reviewv1alpha1.PRReviewJobSpec{
				TTLSecondsAfterFinished: int32Ptr(1800),
			},
			Status: reviewv1alpha1.PRReviewJobStatus{
				Phase:          reviewv1alpha1.PhaseFailed,
				CompletionTime: &completionFarPast,
			},
		},
		{
			Spec: reviewv1alpha1.PRReviewJobSpec{
				TTLSecondsAfterFinished: int32Ptr(1800),
			},
			Status: reviewv1alpha1.PRReviewJobStatus{
				Phase:          reviewv1alpha1.PhaseSucceeded,
				CompletionTime: &completionFuture,
			},
		},
		{
			Spec: reviewv1alpha1.PRReviewJobSpec{
				TTLSecondsAfterFinished: int32Ptr(math.MaxInt32),
			},
			Status: reviewv1alpha1.PRReviewJobStatus{
				Phase:          reviewv1alpha1.PhaseSucceeded,
				CompletionTime: &completionPast,
			},
		},
		{
			Spec: reviewv1alpha1.PRReviewJobSpec{
				TTLSecondsAfterFinished: int32Ptr(-1),
			},
			Status: reviewv1alpha1.PRReviewJobStatus{
				Phase:          reviewv1alpha1.PhaseSucceeded,
				CompletionTime: &completionPast,
			},
		},
		{
			Spec: reviewv1alpha1.PRReviewJobSpec{
				TTLSecondsAfterFinished: int32Ptr(math.MinInt32),
			},
			Status: reviewv1alpha1.PRReviewJobStatus{
				Phase:          reviewv1alpha1.PhaseFailed,
				CompletionTime: &completionPast,
			},
		},
	}

	const goroutines = 100
	const iterationsPerGoroutine = 500
	var totalEvaluations uint64

	var wg sync.WaitGroup
	startChan := make(chan struct{})

	for g := 0; g < goroutines; g++ {
		wg.Add(1)
		go func(gID int) {
			defer wg.Done()
			<-startChan

			for i := 0; i < iterationsPerGoroutine; i++ {
				jobIdx := (gID + i) % len(jobs)
				job := jobs[jobIdx]
				evalTime := now.Add(time.Duration((i%21)-10) * time.Second)

				expired, remaining := mgr.IsTTLExpired(job, evalTime)
				atomic.AddUint64(&totalEvaluations, 1)

				// Sanity assertions per case
				if job == nil || job.Status.Phase == reviewv1alpha1.PhaseRunning || job.Status.CompletionTime == nil {
					if expired || remaining != 0 {
						t.Errorf("Unexpected expiration output for non-terminal/nil job: expired=%v, remaining=%v", expired, remaining)
					}
				} else {
					ttlSec := job.GetTTLSeconds()
					if ttlSec <= 0 {
						if !expired || remaining != 0 {
							t.Errorf("Expected non-positive TTL job to be immediately expired: got expired=%v, remaining=%v", expired, remaining)
						}
					}
				}
			}
		}(g)
	}

	close(startChan)
	wg.Wait()

	expectedEvaluations := uint64(goroutines * iterationsPerGoroutine)
	if totalEvaluations != expectedEvaluations {
		t.Fatalf("Stress evaluation count mismatch: got %d, expected %d", totalEvaluations, expectedEvaluations)
	}
}

// TestEmpirical_TTLExpiration_BoundaryPrecision stress tests nanosecond-exact boundary time transitions.
func TestEmpirical_TTLExpiration_BoundaryPrecision(t *testing.T) {
	mgr := cleanup.NewTTLManager()
	completionTime := time.Date(2026, 7, 29, 12, 0, 0, 0, time.UTC)
	metaCompletion := metav1.NewTime(completionTime)

	ttlSeconds := int32(60) // 1 minute
	job := &reviewv1alpha1.PRReviewJob{
		Spec: reviewv1alpha1.PRReviewJobSpec{
			TTLSecondsAfterFinished: &ttlSeconds,
		},
		Status: reviewv1alpha1.PRReviewJobStatus{
			Phase:          reviewv1alpha1.PhaseSucceeded,
			CompletionTime: &metaCompletion,
		},
	}

	exactExpiration := completionTime.Add(60 * time.Second)

	// 1 ns before expiration -> Not expired, remaining = 1ns
	beforeNow := exactExpiration.Add(-1 * time.Nanosecond)
	expired, remaining := mgr.IsTTLExpired(job, beforeNow)
	if expired {
		t.Errorf("Boundary test (before expiration): expected expired=false, got true")
	}
	if remaining != 1*time.Nanosecond {
		t.Errorf("Boundary test (before expiration): expected remaining=1ns, got %v", remaining)
	}

	// Exact expiration time -> Expired, remaining = 0
	expired, remaining = mgr.IsTTLExpired(job, exactExpiration)
	if !expired {
		t.Errorf("Boundary test (exact expiration): expected expired=true, got false")
	}
	if remaining != 0 {
		t.Errorf("Boundary test (exact expiration): expected remaining=0, got %v", remaining)
	}

	// 1 ns after expiration -> Expired, remaining = 0
	afterNow := exactExpiration.Add(1 * time.Nanosecond)
	expired, remaining = mgr.IsTTLExpired(job, afterNow)
	if !expired {
		t.Errorf("Boundary test (after expiration): expected expired=true, got false")
	}
	if remaining != 0 {
		t.Errorf("Boundary test (after expiration): expected remaining=0, got %v", remaining)
	}
}

// TestEmpirical_ZeroTTL_Stress verifies immediate expiration behavior for zero TTL across concurrent invocations.
func TestEmpirical_ZeroTTL_Stress(t *testing.T) {
	mgr := cleanup.NewTTLManager()
	now := time.Now()

	zeroTTLJob := &reviewv1alpha1.PRReviewJob{
		Spec: reviewv1alpha1.PRReviewJobSpec{
			TTLSecondsAfterFinished: int32Ptr(0),
		},
		Status: reviewv1alpha1.PRReviewJobStatus{
			Phase:          reviewv1alpha1.PhaseSucceeded,
			CompletionTime: &metav1.Time{Time: now},
		},
	}

	const goroutines = 50
	var wg sync.WaitGroup
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func(offset int) {
			defer wg.Done()
			evalTime := now.Add(time.Duration(offset) * time.Millisecond)
			expired, remaining := mgr.IsTTLExpired(zeroTTLJob, evalTime)
			if !expired || remaining != 0 {
				t.Errorf("Zero TTL job check failed: expired=%v, remaining=%v", expired, remaining)
			}
		}(i)
	}
	wg.Wait()
}

// TestEmpirical_NegativeTTL_Stress verifies that negative TTL values are clamped and treated as expired.
func TestEmpirical_NegativeTTL_Stress(t *testing.T) {
	mgr := cleanup.NewTTLManager()
	now := time.Now()
	completion := metav1.NewTime(now.Add(-5 * time.Second))

	negativeValues := []int32{-1, -10, -1800, -99999, math.MinInt32}

	for _, val := range negativeValues {
		valCopy := val
		job := &reviewv1alpha1.PRReviewJob{
			Spec: reviewv1alpha1.PRReviewJobSpec{
				TTLSecondsAfterFinished: &valCopy,
			},
			Status: reviewv1alpha1.PRReviewJobStatus{
				Phase:          reviewv1alpha1.PhaseFailed,
				CompletionTime: &completion,
			},
		}

		// Verify GetTTLSeconds returns 0
		if ttlSec := job.GetTTLSeconds(); ttlSec != 0 {
			t.Errorf("Negative TTL %d: GetTTLSeconds() expected 0, got %d", valCopy, ttlSec)
		}

		// Verify IsTTLExpired returns true, 0
		expired, remaining := mgr.IsTTLExpired(job, now)
		if !expired || remaining != 0 {
			t.Errorf("Negative TTL %d: IsTTLExpired() expected (true, 0), got (%v, %v)", valCopy, expired, remaining)
		}
	}
}

// TestEmpirical_ResourceDeletion_ConcurrentStress tests concurrent resource deletion on the same resources,
// ensuring idempotency, lack of data races, and proper error handling.
func TestEmpirical_ResourceDeletion_ConcurrentStress(t *testing.T) {
	scheme := setupTestScheme(t)
	mgr := cleanup.NewTTLManager()
	ctx := context.Background()

	const jobCount = 10
	const goroutinesPerJob = 10

	fakeObjects := make([]client.Object, 0, jobCount*3)
	jobs := make([]*reviewv1alpha1.PRReviewJob, jobCount)

	for i := 0; i < jobCount; i++ {
		name := fmt.Sprintf("stress-job-%d", i)
		prNum := int32(i + 1)
		cr := &reviewv1alpha1.PRReviewJob{
			ObjectMeta: metav1.ObjectMeta{
				Name:      name,
				Namespace: "default",
			},
			Spec: reviewv1alpha1.PRReviewJobSpec{
				Repo:     "calltelemetry/cisco-cdr",
				PRNumber: prNum,
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

		jobs[i] = cr
		fakeObjects = append(fakeObjects, cr, childJob, childPVC)
	}

	fakeClient := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(fakeObjects...).
		Build()

	var wg sync.WaitGroup
	startChan := make(chan struct{})
	var errorCount uint64

	for i := 0; i < jobCount; i++ {
		for g := 0; g < goroutinesPerJob; g++ {
			wg.Add(1)
			go func(jobObj *reviewv1alpha1.PRReviewJob) {
				defer wg.Done()
				<-startChan

				err := mgr.CleanupResources(ctx, fakeClient, jobObj)
				if err != nil {
					atomic.AddUint64(&errorCount, 1)
					t.Errorf("CleanupResources returned unexpected error during concurrent stress: %v", err)
				}
			}(jobs[i])
		}
	}

	close(startChan)
	wg.Wait()

	if errorCount > 0 {
		t.Fatalf("Concurrent resource deletion produced %d errors", errorCount)
	}

	// Verify all resources were deleted cleanly
	for i := 0; i < jobCount; i++ {
		name := fmt.Sprintf("stress-job-%d", i)

		var fetchedJob batchv1.Job
		err := fakeClient.Get(ctx, types.NamespacedName{Namespace: "default", Name: fmt.Sprintf("%s-job", name)}, &fetchedJob)
		if err == nil {
			t.Errorf("Job %s-job was not deleted", name)
		}

		var fetchedPVC corev1.PersistentVolumeClaim
		err = fakeClient.Get(ctx, types.NamespacedName{Namespace: "default", Name: fmt.Sprintf("%s-pvc", name)}, &fetchedPVC)
		if err == nil {
			t.Errorf("PVC %s-pvc was not deleted", name)
		}

		var fetchedCR reviewv1alpha1.PRReviewJob
		err = fakeClient.Get(ctx, types.NamespacedName{Namespace: "default", Name: name}, &fetchedCR)
		if err == nil {
			t.Errorf("CR %s was not deleted", name)
		}
	}
}

// TestEmpirical_ResourceDeletion_PartialMissingMatrix verifies deletion behavior when parts of the target resource tree are missing.
func TestEmpirical_ResourceDeletion_PartialMissingMatrix(t *testing.T) {
	scheme := setupTestScheme(t)
	mgr := cleanup.NewTTLManager()
	ctx := context.Background()

	tests := []struct {
		name   string
		hasJob bool
		hasPVC bool
		hasCR  bool
	}{
		{name: "Only Job present", hasJob: true, hasPVC: false, hasCR: false},
		{name: "Only PVC present", hasJob: false, hasPVC: true, hasCR: false},
		{name: "Only CR present", hasJob: false, hasPVC: false, hasCR: true},
		{name: "Job and CR present", hasJob: true, hasPVC: false, hasCR: true},
		{name: "PVC and CR present", hasJob: false, hasPVC: true, hasCR: true},
		{name: "None present", hasJob: false, hasPVC: false, hasCR: false},
	}

	for idx, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			jobName := fmt.Sprintf("partial-job-%d", idx)
			cr := &reviewv1alpha1.PRReviewJob{
				ObjectMeta: metav1.ObjectMeta{
					Name:      jobName,
					Namespace: "default",
				},
			}

			var objs []client.Object
			if tt.hasCR {
				objs = append(objs, cr)
			}
			if tt.hasJob {
				objs = append(objs, &batchv1.Job{
					ObjectMeta: metav1.ObjectMeta{
						Name:      fmt.Sprintf("%s-job", jobName),
						Namespace: "default",
					},
				})
			}
			if tt.hasPVC {
				objs = append(objs, &corev1.PersistentVolumeClaim{
					ObjectMeta: metav1.ObjectMeta{
						Name:      fmt.Sprintf("%s-pvc", jobName),
						Namespace: "default",
					},
				})
			}

			fakeClient := fake.NewClientBuilder().WithScheme(scheme).WithObjects(objs...).Build()

			err := mgr.CleanupResources(ctx, fakeClient, cr)
			if err != nil {
				t.Fatalf("CleanupResources failed for partial state '%s': %v", tt.name, err)
			}

			// Confirm everything is deleted
			var k8sJob batchv1.Job
			if err := fakeClient.Get(ctx, types.NamespacedName{Namespace: "default", Name: fmt.Sprintf("%s-job", jobName)}, &k8sJob); err == nil {
				t.Errorf("Expected batch/v1 job to be gone for '%s'", tt.name)
			}
			var pvc corev1.PersistentVolumeClaim
			if err := fakeClient.Get(ctx, types.NamespacedName{Namespace: "default", Name: fmt.Sprintf("%s-pvc", jobName)}, &pvc); err == nil {
				t.Errorf("Expected PVC to be gone for '%s'", tt.name)
			}
			var fetchedCR reviewv1alpha1.PRReviewJob
			if err := fakeClient.Get(ctx, types.NamespacedName{Namespace: "default", Name: jobName}, &fetchedCR); err == nil {
				t.Errorf("Expected CR to be gone for '%s'", tt.name)
			}
		})
	}
}
