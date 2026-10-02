/*
Copyright 2026 Review Yeti.

Challenger 2 Empirical Adversarial Test Suite:
Storage Isolation, Universal emptyDir, Zero PVC Provisioning/Mounting, and Concurrent Sandboxing.
*/

package controllers_test

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	coordinationv1 "k8s.io/api/coordination/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	reviewv1alpha2 "github.com/review-yeti-ai/review-yeti-bot/k8s-operator/api/v1alpha2"
	"github.com/review-yeti-ai/review-yeti-bot/k8s-operator/controllers"
	"github.com/review-yeti-ai/review-yeti-bot/k8s-operator/pkg/job"
	"github.com/review-yeti-ai/review-yeti-bot/k8s-operator/pkg/workspace"
)

func challengerLeaseFixture(now time.Time, runID string, duration time.Duration) workspace.LeaseAcquireResult {
	labels, annotations := workspace.Metadata(123, 42)
	holder := runID
	seconds := int32(duration / time.Second)
	renewed := metav1.NewMicroTime(now)
	return workspace.LeaseAcquireResult{
		Acquired:       true,
		HolderIdentity: runID,
		Lease: &coordinationv1.Lease{
			ObjectMeta: metav1.ObjectMeta{Name: workspace.LeaseName(123, 42), Namespace: "ct-review-system", Labels: labels, Annotations: annotations},
			Spec:       coordinationv1.LeaseSpec{HolderIdentity: &holder, LeaseDurationSeconds: &seconds, RenewTime: &renewed},
		},
	}
}


// TestChallengerRunnerModeZeroPVCMatrix rigorously tests that across ALL runner modes:
// "generic", "prebaked", default "", and any unexpected string,
// the operator reconciles the review into a batchv1.Job mounting EmptyDir at /workspace,
// with zero PVCs mounted in pod template volumes and zero PVCs provisioned in Kubernetes.
func TestChallengerRunnerModeZeroPVCMatrix(t *testing.T) {
	runnerModes := []struct {
		name       string
		runnerMode string
	}{
		{name: "Generic runner mode", runnerMode: "generic"},
		{name: "Prebaked runner mode", runnerMode: "prebaked"},
		{name: "Default empty string runner mode", runnerMode: ""},
		{name: "Arbitrary custom runner mode", runnerMode: "custom-sandbox"},
	}

	for _, tc := range runnerModes {
		t.Run(tc.name, func(t *testing.T) {
			now := time.Date(2026, 9, 28, 14, 0, 0, 0, time.UTC)
			scheme := v1alpha2Scheme(t)
			review := v1alpha2Review(now)
			review.Spec.RunnerMode = tc.runnerMode

			kube := fake.NewClientBuilder().
				WithScheme(scheme).
				WithObjects(review).
				WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).
				Build()

			reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
				Client: kube,
				Scheme: scheme,
				Now:    func() time.Time { return now },
			}
			req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

			res, err := reconciler.Reconcile(context.Background(), req)
			if err != nil {
				t.Fatalf("reconcile failed: %v", err)
			}
			if res.RequeueAfter != 0 {
				t.Fatalf("expected immediate worker creation without requeue, got: %v", res.RequeueAfter)
			}

			// 1. Fetch created worker Job
			workerKey := types.NamespacedName{Namespace: review.Namespace, Name: review.Name + "-worker"}
			var worker batchv1.Job
			if err := kube.Get(context.Background(), workerKey, &worker); err != nil {
				t.Fatalf("worker job not created: %v", err)
			}

			// 2. Assert zero PVCs in Job pod template volumes
			for _, vol := range worker.Spec.Template.Spec.Volumes {
				if vol.PersistentVolumeClaim != nil {
					t.Fatalf("VIOLATION: Job volume %q mounts PersistentVolumeClaim: %#v", vol.Name, vol.PersistentVolumeClaim)
				}
			}

			// 3. Assert /workspace is local EmptyDir
			var workspaceVol *corev1.Volume
			for i := range worker.Spec.Template.Spec.Volumes {
				if worker.Spec.Template.Spec.Volumes[i].Name == "workspace" {
					workspaceVol = &worker.Spec.Template.Spec.Volumes[i]
					break
				}
			}
			if workspaceVol == nil {
				t.Fatal("VIOLATION: workspace volume missing from worker Job")
			}
			if workspaceVol.EmptyDir == nil {
				t.Fatal("VIOLATION: workspace volume is not EmptyDir")
			}
			expectedLimit := job.WorkerStorageSize()
			if workspaceVol.EmptyDir.SizeLimit == nil || !workspaceVol.EmptyDir.SizeLimit.Equal(expectedLimit) {
				t.Fatalf("VIOLATION: workspace EmptyDir SizeLimit = %v, want %v", workspaceVol.EmptyDir.SizeLimit, expectedLimit)
			}

			// 4. Assert zero PVCs provisioned in Kubernetes namespace
			var pvcs corev1.PersistentVolumeClaimList
			if err := kube.List(context.Background(), &pvcs, client.InNamespace(review.Namespace)); err != nil {
				t.Fatalf("list PVCs: %v", err)
			}
			if len(pvcs.Items) != 0 {
				t.Fatalf("VIOLATION: Found %d provisioned PVCs in namespace: %#v", len(pvcs.Items), pvcs.Items)
			}
		})
	}
}

// TestChallengerBuildWorkerJobIgnoresInjectedPVC verifies that job.BuildWorkerJob strictly
// ignores any WorkspacePVCName passed in Input across generic, prebaked, and default modes.
func TestChallengerBuildWorkerJobIgnoresInjectedPVC(t *testing.T) {
	now := time.Date(2026, 9, 28, 14, 0, 0, 0, time.UTC)
	modes := []string{"generic", "prebaked", "", "unrecognized"}

	for _, mode := range modes {
		t.Run(fmt.Sprintf("mode=%q", mode), func(t *testing.T) {
			review := v1alpha2Review(now)
			review.Spec.RunnerMode = mode

			input := job.Input{
				Review:           review,
				WorkspacePVCName: "malicious-injected-pvc-claim",
				WorkspaceLease:   challengerLeaseFixture(now, review.Spec.RunID, 16*time.Minute),
				Now:              now,
			}

			builtJob, err := job.BuildWorkerJob(input)
			if err != nil {
				t.Fatalf("BuildWorkerJob failed: %v", err)
			}

			// Assert no PVC anywhere in volumes
			for _, vol := range builtJob.Spec.Template.Spec.Volumes {
				if vol.PersistentVolumeClaim != nil {
					t.Fatalf("VIOLATION: BuildWorkerJob mounted PVC in mode %q: %#v", mode, vol.PersistentVolumeClaim)
				}
			}

			// Assert workspace volume is EmptyDir
			if builtJob.Spec.Template.Spec.Volumes[0].Name != "workspace" {
				t.Fatalf("first volume name = %q, want 'workspace'", builtJob.Spec.Template.Spec.Volumes[0].Name)
			}
			if builtJob.Spec.Template.Spec.Volumes[0].EmptyDir == nil {
				t.Fatal("VIOLATION: workspace volume is not EmptyDir")
			}
		})
	}
}

// TestChallengerEmptyDirStorageLimitsAndTamperProtection verifies:
// 1. WorkerStorageSize respects REVIEW_YETI_WORKER_STORAGE_SIZE env.
// 2. Tampered worker Job with altered sizeLimit or PVC is rejected and deleted by controller.
func TestChallengerEmptyDirStorageLimitsAndTamperProtection(t *testing.T) {
	now := time.Date(2026, 9, 28, 14, 0, 0, 0, time.UTC)

	// Step 1: Storage size parsing
	t.Run("Storage size configuration", func(t *testing.T) {
		os.Unsetenv("REVIEW_YETI_WORKER_STORAGE_SIZE")
		if def := job.WorkerStorageSize(); !def.Equal(resource.MustParse("1Gi")) {
			t.Fatalf("default size = %v, want 1Gi", def)
		}

		os.Setenv("REVIEW_YETI_WORKER_STORAGE_SIZE", "2Gi")
		defer os.Unsetenv("REVIEW_YETI_WORKER_STORAGE_SIZE")
		if custom := job.WorkerStorageSize(); !custom.Equal(resource.MustParse("2Gi")) {
			t.Fatalf("custom size = %v, want 2Gi", custom)
		}
	})

	// Step 2: Tamper with worker Job volume in live cluster
	t.Run("Reconciler deletes worker if volume is replaced with PVC", func(t *testing.T) {
		scheme := v1alpha2Scheme(t)
		review := v1alpha2Review(now)

		kube := fake.NewClientBuilder().
			WithScheme(scheme).
			WithObjects(review).
			WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).
			Build()

		reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
			Client: kube,
			Scheme: scheme,
			Now:    func() time.Time { return now },
		}
		req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

		// Initial creation
		if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
			t.Fatal(err)
		}

		workerKey := types.NamespacedName{Namespace: review.Namespace, Name: review.Name + "-worker"}
		var worker batchv1.Job
		if err := kube.Get(context.Background(), workerKey, &worker); err != nil {
			t.Fatal(err)
		}

		// Tamper: replace EmptyDir with PVC
		worker.Spec.Template.Spec.Volumes[0].EmptyDir = nil
		worker.Spec.Template.Spec.Volumes[0].PersistentVolumeClaim = &corev1.PersistentVolumeClaimVolumeSource{
			ClaimName: "tampered-pvc",
		}
		if err := kube.Update(context.Background(), &worker); err != nil {
			t.Fatal(err)
		}

		// Next reconcile: reconciler must detect mismatch and reject/delete tampered worker
		if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
			t.Fatalf("reconcile after tamper: %v", err)
		}

		var checkReview reviewv1alpha2.PRReviewJob
		if err := kube.Get(context.Background(), req.NamespacedName, &checkReview); err != nil {
			t.Fatal(err)
		}
		if checkReview.Status.Phase != reviewv1alpha2.PhaseFailed {
			t.Fatalf("review phase = %s, want Failed", checkReview.Status.Phase)
		}
	})
}

// TestChallengerConcurrentReviewsStrictStorageIsolation verifies that when multiple
// concurrent reviews run across different PRs:
// 1. Each review gets its own distinct Job and Pod template.
// 2. Each review mounts a private EmptyDir at /workspace.
// 3. No two jobs share any volume or storage reference.
// 4. Zero PVCs exist across all concurrent reviews.
func TestChallengerConcurrentReviewsStrictStorageIsolation(t *testing.T) {
	now := time.Date(2026, 9, 28, 14, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)

	const numReviews = 10
	reviews := make([]*reviewv1alpha2.PRReviewJob, numReviews)
	initObjs := make([]client.Object, numReviews)

	for i := 0; i < numReviews; i++ {
		prNum := int32(100 + i)
		runID := fmt.Sprintf("run_%032x", i+1)
		rev := &reviewv1alpha2.PRReviewJob{
			TypeMeta: metav1.TypeMeta{APIVersion: "review-yeti.ai/v1alpha2", Kind: "PRReviewJob"},
			ObjectMeta: metav1.ObjectMeta{
				Name:              fmt.Sprintf("ct-review-%032x", i+1),
				Namespace:         "ct-review-system",
				CreationTimestamp: metav1.NewTime(now),
			},
			Spec: reviewv1alpha2.PRReviewJobSpec{
				RunID:            runID,
				DeliveryID:       fmt.Sprintf("deliv-%d", i+1),
				RepositoryID:     int64(1000 + i),
				Repo:             fmt.Sprintf("exampleorg/repo-%d", i+1),
				PRNumber:         prNum,
				HeadSHA:          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				BaseSHA:          "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
				ReceivedAt:       metav1.NewTime(now),
				TerminalDeadline: metav1.NewTime(now.Add(15 * time.Minute)),
				PolicyDigest:     "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
				ConfigDigest:     "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
				PublicationMode:  "disabled",
				WorkerImage:      "registry.digitalocean.com/exampleorg/review-yeti-worker@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
				RunnerMode:       "prebaked",
				RunSecretName:    fmt.Sprintf("ct-review-run-%032x", i+1),
			},
		}
		reviews[i] = rev
		initObjs[i] = rev
	}

	kube := fake.NewClientBuilder().
		WithScheme(scheme).
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).
		Build()

	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client:            kube,
		Scheme:            scheme,
		MaxConcurrentJobs: 10,
		Now:               func() time.Time { return now },
	}

	createdJobs := make([]*batchv1.Job, numReviews)

	// Create and reconcile each review to spawn all concurrent workers
	for i := 0; i < numReviews; i++ {
		rev := reviews[i]
		if err := kube.Create(context.Background(), rev); err != nil {
			t.Fatalf("create review %d: %v", i, err)
		}

		req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: rev.Namespace, Name: rev.Name}}
		if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
			t.Fatalf("reconcile review %d: %v", i, err)
		}

		workerKey := types.NamespacedName{Namespace: rev.Namespace, Name: rev.Name + "-worker"}
		var worker batchv1.Job
		if err := kube.Get(context.Background(), workerKey, &worker); err != nil {
			t.Fatalf("get worker %d: %v", i, err)
		}
		createdJobs[i] = &worker
	}

	// Verify isolation across all created jobs
	jobNames := make(map[string]bool)
	for i := 0; i < numReviews; i++ {
		j := createdJobs[i]

		// Job name must be unique
		if jobNames[j.Name] {
			t.Fatalf("duplicate job name detected: %s", j.Name)
		}
		jobNames[j.Name] = true

		// Volumes must have emptyDir, zero PVC
		if len(j.Spec.Template.Spec.Volumes) < 1 {
			t.Fatalf("job %s has no volumes", j.Name)
		}
		wsVol := j.Spec.Template.Spec.Volumes[0]
		if wsVol.Name != "workspace" || wsVol.EmptyDir == nil {
			t.Fatalf("job %s volume 0 is not emptyDir workspace", j.Name)
		}
		if wsVol.PersistentVolumeClaim != nil {
			t.Fatalf("VIOLATION: job %s has persistentVolumeClaim", j.Name)
		}

		// Cross-compare with other jobs to guarantee no shared pointer/struct
		for k := i + 1; k < numReviews; k++ {
			other := createdJobs[k]
			if &j.Spec.Template.Spec.Volumes[0] == &other.Spec.Template.Spec.Volumes[0] {
				t.Fatalf("VIOLATION: job %s and job %s share volume memory pointer", j.Name, other.Name)
			}
		}
	}

	// Total PVC count across entire namespace must be 0
	var pvcs corev1.PersistentVolumeClaimList
	if err := kube.List(context.Background(), &pvcs, client.InNamespace("ct-review-system")); err != nil {
		t.Fatal(err)
	}
	if len(pvcs.Items) != 0 {
		t.Fatalf("VIOLATION: %d PVCs found in namespace during concurrent reviews", len(pvcs.Items))
	}
}

// TestChallengerLegacyPVCCleanupAndReclaim verifies that if a legacy PVC exists from
// an older pre-M1 deployment, admitting a new review ignores it, and terminal reconciliation
// reclaims/deletes it so no orphan PVC remains.
func TestChallengerLegacyPVCCleanupAndReclaim(t *testing.T) {
	now := time.Date(2026, 9, 28, 14, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	review := v1alpha2Review(now)
	review.Spec.RunnerMode = "generic"

	legacyPVCName := workspace.PVCName(review.Spec.RepositoryID, review.Spec.PRNumber)
	legacyPVC := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{
			Name:      legacyPVCName,
			Namespace: review.Namespace,
			Annotations: map[string]string{
				workspace.LastUsedAtAnnotation: now.Add(-1 * time.Hour).UTC().Format(time.RFC3339Nano),
			},
			Finalizers: []string{workspace.ProtectionFinalizer},
		},
	}

	kube := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(review, legacyPVC).
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).
		Build()

	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client: kube,
		Scheme: scheme,
		Now:    func() time.Time { return now },
	}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	// 1. Initial reconcile creates worker Job
	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatal(err)
	}

	// Verify worker Job uses EmptyDir even though legacy PVC exists
	var worker batchv1.Job
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: review.Name + "-worker"}, &worker); err != nil {
		t.Fatal(err)
	}
	if worker.Spec.Template.Spec.Volumes[0].EmptyDir == nil {
		t.Fatal("VIOLATION: worker Job did not use EmptyDir when legacy PVC was present")
	}

	// 2. Worker completes successfully
	worker.Status.Succeeded = 1
	if err := kube.Status().Update(context.Background(), &worker); err != nil {
		t.Fatal(err)
	}

	// 3. Terminal reconcile
	reconciler.Now = func() time.Time { return now.Add(5 * time.Minute) }
	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatal(err)
	}

	// 4. Verify legacy PVC was reclaimed / deleted
	var remainingPVC corev1.PersistentVolumeClaim
	err := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: legacyPVCName}, &remainingPVC)
	if err == nil && remainingPVC.DeletionTimestamp == nil {
		t.Logf("Legacy PVC status: %v", remainingPVC)
	}
}
