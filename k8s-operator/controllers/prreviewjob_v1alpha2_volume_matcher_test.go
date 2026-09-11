package controllers

import (
	"context"
	"testing"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	reviewv1alpha2 "github.com/calltelemetry/ct-review-bot/k8s-operator/api/v1alpha2"
)

func newTestScheme(t *testing.T) *runtime.Scheme {
	s := runtime.NewScheme()
	if err := clientgoscheme.AddToScheme(s); err != nil {
		t.Fatalf("clientgoscheme: %v", err)
	}
	if err := reviewv1alpha2.AddToScheme(s); err != nil {
		t.Fatalf("reviewv1alpha2: %v", err)
	}
	return s
}

func newTestReview(now time.Time) *reviewv1alpha2.PRReviewJob {
	return &reviewv1alpha2.PRReviewJob{
		TypeMeta: metav1.TypeMeta{APIVersion: "review-yeti.ai/v1alpha2", Kind: "PRReviewJob"},
		ObjectMeta: metav1.ObjectMeta{
			Name:      "ct-review-11111111111111111111111111111111",
			Namespace: "ct-review-system",
		},
		Spec: reviewv1alpha2.PRReviewJobSpec{
			RunID:            "run_11111111111111111111111111111111",
			DeliveryID:       "delivery-1",
			RepositoryID:     123,
			Repo:             "calltelemetry/cisco-cdr",
			PRNumber:         42,
			HeadSHA:          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			BaseSHA:          "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			ReceivedAt:       metav1.NewTime(now),
			TerminalDeadline: metav1.NewTime(now.Add(15 * time.Minute)),
			PolicyDigest:     "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
			ConfigDigest:     "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
			PublicationMode:  "disabled",
			WorkerImage:      "registry.digitalocean.com/calltelemetry/review-yeti-worker@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
			RunnerMode:       "prebaked",
			RunSecretName:    "ct-review-run-11111111111111111111111111111111",
		},
	}
}

func TestManagedWorkerVolumeMatcherEmptyDirSizeLimit(t *testing.T) {
	now := time.Date(2026, 9, 10, 12, 0, 0, 0, time.UTC)
	scheme := newTestScheme(t)
	review := newTestReview(now)

	kube := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(review).
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).
		Build()

	reconciler := &PRReviewJobV1Alpha2Reconciler{
		Client: kube,
		Scheme: scheme,
		Now:    func() time.Time { return now },
	}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	// First Reconcile: creates worker Job with prebaked emptyDir
	_, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("first reconcile failed: %v", err)
	}

	workerKey := types.NamespacedName{Namespace: review.Namespace, Name: review.Name + "-worker"}
	var worker batchv1.Job
	if err := kube.Get(context.Background(), workerKey, &worker); err != nil {
		t.Fatalf("worker job not found: %v", err)
	}

	// Baseline check: clean worker matches
	if !managedWorkerJobMatches(review, &worker) {
		t.Fatal("expected newly created prebaked worker to match")
	}

	// 1. Test case: EmptyDir with nil sizeLimit -> MUST return false
	t.Run("nil sizeLimit", func(t *testing.T) {
		mutated := worker.DeepCopy()
		mutated.Spec.Template.Spec.Volumes[0].EmptyDir.SizeLimit = nil

		matched := managedWorkerJobMatches(review, mutated)
		if matched {
			t.Fatal("managedWorkerJobMatches returned true for nil SizeLimit, expected false")
		}
	})

	// 2. Test case: EmptyDir with wrong sizeLimit (50Gi) -> MUST return false
	t.Run("wrong sizeLimit 50Gi", func(t *testing.T) {
		mutated := worker.DeepCopy()
		wrongLimit := resource.MustParse("50Gi")
		mutated.Spec.Template.Spec.Volumes[0].EmptyDir.SizeLimit = &wrongLimit

		matched := managedWorkerJobMatches(review, mutated)
		if matched {
			t.Fatal("managedWorkerJobMatches returned true for 50Gi SizeLimit, expected false")
		}
	})

	// 3. Test case: EmptyDir with other wrong sizeLimit (500Mi) -> MUST return false
	t.Run("wrong sizeLimit 500Mi", func(t *testing.T) {
		mutated := worker.DeepCopy()
		wrongLimit := resource.MustParse("500Mi")
		mutated.Spec.Template.Spec.Volumes[0].EmptyDir.SizeLimit = &wrongLimit

		matched := managedWorkerJobMatches(review, mutated)
		if matched {
			t.Fatal("managedWorkerJobMatches returned true for 500Mi SizeLimit, expected false")
		}
	})

	// 4. Test case: EmptyDir with correct sizeLimit (1Gi) -> MUST return true
	t.Run("correct sizeLimit 1Gi", func(t *testing.T) {
		mutated := worker.DeepCopy()
		correctLimit := resource.MustParse("1Gi")
		mutated.Spec.Template.Spec.Volumes[0].EmptyDir.SizeLimit = &correctLimit

		matched := managedWorkerJobMatches(review, mutated)
		if !matched {
			t.Fatal("managedWorkerJobMatches returned false for 1Gi SizeLimit, expected true")
		}
	})

	// 5. Test case: EmptyDir is nil -> MUST return false
	t.Run("nil EmptyDir", func(t *testing.T) {
		mutated := worker.DeepCopy()
		mutated.Spec.Template.Spec.Volumes[0].EmptyDir = nil

		matched := managedWorkerJobMatches(review, mutated)
		if matched {
			t.Fatal("managedWorkerJobMatches returned true for nil EmptyDir, expected false")
		}
	})

	// 6. Test reconciler reaction: tamper with 50Gi sizeLimit in kube -> reconciler deletes it
	t.Run("reconciler deletes tampered 50Gi worker", func(t *testing.T) {
		wrongLimit := resource.MustParse("50Gi")
		worker.Spec.Template.Spec.Volumes[0].EmptyDir.SizeLimit = &wrongLimit
		if err := kube.Update(context.Background(), &worker); err != nil {
			t.Fatalf("update worker: %v", err)
		}

		if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
			t.Fatalf("reconcile tampered worker: %v", err)
		}

		var checkWorker batchv1.Job
		err := kube.Get(context.Background(), workerKey, &checkWorker)
		if !apierrors.IsNotFound(err) {
			t.Fatalf("tampered 50Gi worker was NOT deleted by reconciler, err: %v", err)
		}
	})
}
