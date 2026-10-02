/*
Copyright 2026 Review Yeti.

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
	"time"

	batchv1 "k8s.io/api/batch/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	reviewv1alpha2 "github.com/calltelemetry/ct-review-bot/k8s-operator/api/v1alpha2"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/controllers"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/job"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/workspace"
)

func TestPrepWorkerSuccessTransitionsToAwaitingResumption(t *testing.T) {
	now := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	review := v1alpha2Review(now)
	review.Annotations = map[string]string{
		job.JobPhaseLabel: job.JobPhasePrep,
	}

	pvc, err := workspace.BuildPVC(review.Namespace, review.Spec.RepositoryID, review.Spec.PRNumber, now.Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}

	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(review, pvc).WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: kube, Scheme: scheme, Now: func() time.Time { return now }}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	// First reconcile: admits review and builds prep worker Job
	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("first reconcile failed: %v", err)
	}

	var worker batchv1.Job
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: review.Name + "-worker"}, &worker); err != nil {
		t.Fatalf("failed to get created worker job: %v", err)
	}

	// Verify worker was created with prep phase
	if !job.IsPrepWorkerJob(&worker) {
		t.Fatalf("expected created worker job to be a prep worker")
	}

	attachReceiptAnnotations(&worker)
	worker.Status.Succeeded = 1
	if err := kube.Status().Update(context.Background(), &worker); err != nil {
		t.Fatalf("mark prep worker succeeded: %v", err)
	}

	// Second reconcile: observes prep worker succeeded
	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("second reconcile failed: %v", err)
	}

	var updated reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), req.NamespacedName, &updated); err != nil {
		t.Fatalf("failed to get updated review: %v", err)
	}


	// 1. MUST NOT be marked PhaseSucceeded!
	if updated.Status.Phase == reviewv1alpha2.PhaseSucceeded {
		t.Fatalf("VIOLATION: review was prematurely marked PhaseSucceeded after prep pod exit!")
	}

	// 2. MUST have condition AwaitingResumption = True
	cond := meta.FindStatusCondition(updated.Status.Conditions, reviewv1alpha2.ConditionAwaitingResumption)
	if cond == nil || cond.Status != metav1.ConditionTrue {
		t.Fatalf("expected condition %s=True, got %#v", reviewv1alpha2.ConditionAwaitingResumption, cond)
	}

	// 3. Worker Job TTL must be lowered to 0s for immediate cleanup
	var updatedWorker batchv1.Job
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: review.Name + "-worker"}, &updatedWorker); err != nil {
		t.Fatalf("failed to get updated worker: %v", err)
	}
	if updatedWorker.Spec.TTLSecondsAfterFinished == nil || *updatedWorker.Spec.TTLSecondsAfterFinished != 0 {
		t.Fatalf("expected worker TTLSecondsAfterFinished=0, got %#v", updatedWorker.Spec.TTLSecondsAfterFinished)
	}
}

func TestAwaitingResumptionExcludesFromAdmissionSnapshotAndSurvivesJobDeletion(t *testing.T) {
	now := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)

	// Review 1 is awaiting resumption; its prep pod has already finished and been deleted
	review1 := v1alpha2Review(now)
	review1.Name = "review-awaiting"
	meta.SetStatusCondition(&review1.Status.Conditions, metav1.Condition{
		Type:               reviewv1alpha2.ConditionAwaitingResumption,
		Status:             metav1.ConditionTrue,
		Reason:             "PrepCompleted",
		Message:            "awaiting model completion",
		LastTransitionTime: metav1.NewTime(now),
	})
	review1.Status.Phase = reviewv1alpha2.PhaseAwaitingResumption
	review1.Status.JobName = "review-awaiting-worker"

	// Review 2 is newly queued
	review2 := v1alpha2Review(now.Add(time.Second))
	review2.Name = "review-new"
	review2.Spec.PRNumber = 202

	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(review1, review2).WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client:            kube,
		Scheme:            scheme,
		Now:               func() time.Time { return now },
		MaxConcurrentJobs: 1, // concurrency limit of 1
	}

	// 1. Reconciling review1 when its Job is missing (deleted by TTL 0s) must NOT report WorkerJobMissing
	req1 := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review1.Namespace, Name: review1.Name}}
	if _, err := reconciler.Reconcile(context.Background(), req1); err != nil {
		t.Fatalf("reconcile on review-awaiting failed: %v", err)
	}
	var checkReview1 reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), req1.NamespacedName, &checkReview1); err != nil {
		t.Fatal(err)
	}
	if checkReview1.Status.Phase == reviewv1alpha2.PhaseFailed {
		t.Fatalf("review-awaiting failed unexpectedly: %s", checkReview1.Status.Message)
	}

	// 2. Since limit=1 and review1 is awaiting resumption (0 active workers), review2 MUST be admitted!
	req2 := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review2.Namespace, Name: review2.Name}}
	if _, err := reconciler.Reconcile(context.Background(), req2); err != nil {
		t.Fatalf("reconcile on review-new failed: %v", err)
	}
	var checkReview2 reviewv1alpha2.PRReviewJob
	if err := kube.Get(context.Background(), req2.NamespacedName, &checkReview2); err != nil {
		t.Fatal(err)
	}
	// review2 should not be blocked in PhaseQueued due to CapacityExceeded!
	if checkReview2.Status.Phase == reviewv1alpha2.PhaseQueued && checkReview2.Status.Message == "waiting for one of 1 worker slots" {
		t.Fatalf("review2 was blocked by CapacityExceeded even though review1 is awaiting resumption with 0 active workers!")
	}
}
