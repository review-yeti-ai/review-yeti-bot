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

// REL-896: the TypeScript dispatcher creates each run Secret before its
// PRReviewJob exists, so it can never carry an ownerReference back to the
// review. The dispatcher's own RBAC is also fixed at get/create on Secrets --
// granting it patch would let a compromised dispatcher process (it already
// holds the GitHub App key) overwrite any credential Secret in the namespace,
// not just its own run Secret. The accepted alternative is a finalizer on the
// PRReviewJob (review-yeti.ai/run-secret-cleanup) plus a delete-only operator
// RBAC grant on Secrets: delete-only cannot itself be used to plant or read a
// credential. These tests exercise that finalizer's full lifecycle.
package controllers_test

import (
	"context"
	"errors"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/record"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

	reviewv1alpha2 "github.com/calltelemetry/ct-review-bot/k8s-operator/api/v1alpha2"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/controllers"
)

const runSecretCleanupFinalizer = "review-yeti.ai/run-secret-cleanup"

func secretFixture(name, namespace string) *corev1.Secret {
	return &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace},
		Data:       map[string][]byte{"OPENROUTER_API_KEY": []byte("not-a-real-key")},
	}
}

func TestPRReviewJobV1Alpha2ReconcilerAddsRunSecretFinalizerWhenRunSecretNameIsSet(t *testing.T) {
	now := time.Date(2026, 9, 17, 12, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	review := v1alpha2Review(now)
	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(review).WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: kube, Scheme: scheme, Now: func() time.Time { return now }}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("reconcile review with a run secret name: %v", err)
	}
	stored := storedReview(t, kube, req)
	if !controllerutil.ContainsFinalizer(stored, runSecretCleanupFinalizer) {
		t.Fatalf("finalizers = %v, want %s attached on first reconcile", stored.Finalizers, runSecretCleanupFinalizer)
	}
}

func TestPRReviewJobV1Alpha2ReconcilerDoesNotAddRunSecretFinalizerWhenRunSecretNameIsEmpty(t *testing.T) {
	now := time.Date(2026, 9, 17, 12, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	// Recent completion with the default (3600s) retention window so this
	// single reconcile stays inside reconcileTerminalWorkspace and never
	// reaches deleteTerminalReview -- keeping this test purely about whether
	// the finalizer is attached, independent of the deletion path.
	completed := metav1.NewTime(now)
	review := terminalReviewFixture(now, reviewv1alpha2.PhaseSucceeded, &completed)
	review.Spec.RunSecretName = ""
	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(review).WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: kube, Scheme: scheme, Now: func() time.Time { return now }}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("reconcile review with no run secret name: %v", err)
	}
	stored := storedReview(t, kube, req)
	if len(stored.Finalizers) != 0 {
		t.Fatalf("finalizers = %v, want none attached when spec.runSecretName is empty", stored.Finalizers)
	}
}

// deletingReviewFixture builds a kube client containing review (already
// carrying the run-secret cleanup finalizer) with metadata.deletionTimestamp
// set, exactly as a live cluster would present it after either
// deleteTerminalReview's own Delete call or an external `kubectl delete`. The
// fake client refuses to Create an object with deletionTimestamp set unless
// finalizers are already non-empty, so the finalizer must be attached first
// and deletion applied as a second step against the same tracker.
func deletingReviewFixture(t *testing.T, scheme *runtime.Scheme, review *reviewv1alpha2.PRReviewJob, extraObjects ...client.Object) client.WithWatch {
	t.Helper()
	controllerutil.AddFinalizer(review, runSecretCleanupFinalizer)
	objs := append([]client.Object{review}, extraObjects...)
	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(objs...).WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
	if err := kube.Delete(context.Background(), review); err != nil {
		t.Fatalf("mark review for deletion: %v", err)
	}
	return kube
}

func TestPRReviewJobV1Alpha2ReconcilerDeletesMatchingRunSecretAndRemovesFinalizer(t *testing.T) {
	now := time.Date(2026, 9, 17, 12, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	review := terminalReviewFixture(now, reviewv1alpha2.PhaseSucceeded, ptrTime(metav1.NewTime(now)))
	secret := secretFixture(review.Spec.RunSecretName, review.Namespace)
	kube := deletingReviewFixture(t, scheme, review, secret)
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: kube, Scheme: scheme, Now: func() time.Time { return now }}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("reconcile a terminating review with a matching run secret: %v", err)
	}
	if err := kube.Get(context.Background(), req.NamespacedName, &reviewv1alpha2.PRReviewJob{}); !apierrors.IsNotFound(err) {
		t.Fatalf("review must be fully deleted once its run-secret cleanup finalizer clears, got err=%v", err)
	}
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: secret.Name}, &corev1.Secret{}); !apierrors.IsNotFound(err) {
		t.Fatalf("run secret %s must be deleted, got err=%v", secret.Name, err)
	}
}

func TestPRReviewJobV1Alpha2ReconcilerToleratesAlreadyMissingRunSecret(t *testing.T) {
	now := time.Date(2026, 9, 17, 12, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	review := terminalReviewFixture(now, reviewv1alpha2.PhaseSucceeded, ptrTime(metav1.NewTime(now)))
	// No Secret object created: the run secret is already gone (a prior
	// reconcile, the reaper, or an operator already removed it).
	kube := deletingReviewFixture(t, scheme, review)
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: kube, Scheme: scheme, Now: func() time.Time { return now }}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("reconcile a terminating review whose run secret is already gone: %v", err)
	}
	if err := kube.Get(context.Background(), req.NamespacedName, &reviewv1alpha2.PRReviewJob{}); !apierrors.IsNotFound(err) {
		t.Fatalf("review must be fully deleted even though its run secret was already missing, got err=%v", err)
	}
}

func TestPRReviewJobV1Alpha2ReconcilerKeepsFinalizerAndReturnsErrorOnTransientSecretDeleteFailure(t *testing.T) {
	now := time.Date(2026, 9, 17, 12, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	review := terminalReviewFixture(now, reviewv1alpha2.PhaseSucceeded, ptrTime(metav1.NewTime(now)))
	secret := secretFixture(review.Spec.RunSecretName, review.Namespace)
	kube := deletingReviewFixture(t, scheme, review, secret)
	failure := errors.New("etcd unavailable")
	wrapped := interceptor.NewClient(kube, interceptor.Funcs{
		Delete: func(ctx context.Context, c client.WithWatch, obj client.Object, opts ...client.DeleteOption) error {
			if _, ok := obj.(*corev1.Secret); ok {
				return failure
			}
			return c.Delete(ctx, obj, opts...)
		},
	})
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: wrapped, Scheme: scheme, Now: func() time.Time { return now }}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	if _, err := reconciler.Reconcile(context.Background(), req); err == nil {
		t.Fatal("reconcile must return the transient run-secret delete error so the object retries")
	}
	stored := storedReview(t, kube, req)
	if !controllerutil.ContainsFinalizer(stored, runSecretCleanupFinalizer) {
		t.Fatal("a transient run-secret delete failure must not remove the cleanup finalizer -- the object would be orphaned mid-cleanup")
	}
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: secret.Name}, &corev1.Secret{}); err != nil {
		t.Fatalf("run secret must still exist after a failed delete attempt: %v", err)
	}
}

func TestPRReviewJobV1Alpha2ReconcilerForbiddenSecretDeleteRemovesFinalizerWithoutError(t *testing.T) {
	now := time.Date(2026, 9, 17, 12, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	review := terminalReviewFixture(now, reviewv1alpha2.PhaseSucceeded, ptrTime(metav1.NewTime(now)))
	secret := secretFixture(review.Spec.RunSecretName, review.Namespace)
	kube := deletingReviewFixture(t, scheme, review, secret)
	forbidden := apierrors.NewForbidden(schema.GroupResource{Group: "", Resource: "secrets"}, secret.Name, errors.New("RBAC denies delete"))
	wrapped := interceptor.NewClient(kube, interceptor.Funcs{
		Delete: func(ctx context.Context, c client.WithWatch, obj client.Object, opts ...client.DeleteOption) error {
			if _, ok := obj.(*corev1.Secret); ok {
				return forbidden
			}
			return c.Delete(ctx, obj, opts...)
		},
	})
	recorder := record.NewFakeRecorder(10)
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: wrapped, Scheme: scheme, Now: func() time.Time { return now }, Recorder: recorder}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("a Forbidden run-secret delete must not be returned as a reconcile error (it would wedge the object forever): %v", err)
	}
	// Deletion is not attempted through the wrapped client for the Secret --
	// the fake tracker underneath still has it -- but the finalizer must be
	// gone and, with deletionTimestamp already set, that lets the review
	// itself disappear even though the Secret it named leaks.
	if err := kube.Get(context.Background(), req.NamespacedName, &reviewv1alpha2.PRReviewJob{}); !apierrors.IsNotFound(err) {
		t.Fatalf("review must still be deleted despite the Forbidden run-secret delete, got err=%v", err)
	}
	select {
	case event := <-recorder.Events:
		if event == "" {
			t.Fatal("a Forbidden run-secret delete recorded an empty warning Event")
		}
	default:
		t.Fatal("a Forbidden run-secret delete must be surfaced as a warning Event")
	}
}

func TestPRReviewJobV1Alpha2ReconcilerNonMatchingRunSecretNameDeletesNothing(t *testing.T) {
	now := time.Date(2026, 9, 17, 12, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	review := terminalReviewFixture(now, reviewv1alpha2.PhaseSucceeded, ptrTime(metav1.NewTime(now)))
	review.Spec.RunSecretName = "not-a-contract-shaped-name"
	// A Secret happens to exist under that exact (invalid) name; it must
	// survive, and no Delete call for any Secret may be issued at all.
	secret := secretFixture(review.Spec.RunSecretName, review.Namespace)
	kube := deletingReviewFixture(t, scheme, review, secret)
	secretDeleteAttempts := 0
	wrapped := interceptor.NewClient(kube, interceptor.Funcs{
		Delete: func(ctx context.Context, c client.WithWatch, obj client.Object, opts ...client.DeleteOption) error {
			if _, ok := obj.(*corev1.Secret); ok {
				secretDeleteAttempts++
			}
			return c.Delete(ctx, obj, opts...)
		},
	})
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: wrapped, Scheme: scheme, Now: func() time.Time { return now }}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("reconcile a terminating review whose run secret name fails the naming contract: %v", err)
	}
	if secretDeleteAttempts != 0 {
		t.Fatalf("secret delete attempts = %d, want 0: a non-contract-shaped runSecretName must never trigger a Secret delete", secretDeleteAttempts)
	}
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: secret.Name}, &corev1.Secret{}); err != nil {
		t.Fatalf("the Secret under the non-matching name must be untouched: %v", err)
	}
	if err := kube.Get(context.Background(), req.NamespacedName, &reviewv1alpha2.PRReviewJob{}); !apierrors.IsNotFound(err) {
		t.Fatalf("review must still lose its finalizer and be deleted even when no secret delete happens, got err=%v", err)
	}
}

func TestPRReviewJobV1Alpha2ReconcilerNeverTouchesAnUnrelatedSecretInTheNamespace(t *testing.T) {
	now := time.Date(2026, 9, 17, 12, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	review := terminalReviewFixture(now, reviewv1alpha2.PhaseSucceeded, ptrTime(metav1.NewTime(now)))
	ownSecret := secretFixture(review.Spec.RunSecretName, review.Namespace)
	// A different run's secret, and an unrelated credential Secret entirely --
	// neither must be affected by cleanup scoped to this review's own name.
	otherRunSecret := secretFixture("ct-review-run-22222222222222222222222222222222", review.Namespace)
	unrelatedSecret := secretFixture("review-yeti-gateway-credentials", review.Namespace)
	kube := deletingReviewFixture(t, scheme, review, ownSecret, otherRunSecret, unrelatedSecret)
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: kube, Scheme: scheme, Now: func() time.Time { return now }}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("reconcile a terminating review alongside unrelated secrets: %v", err)
	}
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: ownSecret.Name}, &corev1.Secret{}); !apierrors.IsNotFound(err) {
		t.Fatalf("this review's own run secret must be deleted, got err=%v", err)
	}
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: otherRunSecret.Name}, &corev1.Secret{}); err != nil {
		t.Fatalf("a different review's run secret must never be touched by this cleanup: %v", err)
	}
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: unrelatedSecret.Name}, &corev1.Secret{}); err != nil {
		t.Fatalf("an unrelated credential secret must never be touched by this cleanup: %v", err)
	}
}

// TestPRReviewJobV1Alpha2ReconcilerOperatorInitiatedRetentionDeletionRemovesBothReviewAndSecret
// exercises the end-to-end path this feature exists for: the operator's own
// reconcileTerminalDeletion (not an external kubectl delete) issues the
// retention Delete, and once the run-secret cleanup finalizer that the very
// same first reconcile attached is processed, both the PRReviewJob and its
// run Secret are gone. As documented on reconcileRunSecretDeletion, the fake
// client -- like a real API server -- only stamps deletionTimestamp on the
// first Delete against a finalized object, so this requires two reconciles.
func TestPRReviewJobV1Alpha2ReconcilerOperatorInitiatedRetentionDeletionRemovesBothReviewAndSecret(t *testing.T) {
	scoped := "REVIEW_YETI_TERMINAL_RETENTION_SECONDS"
	t.Setenv(scoped, "60")
	now := time.Date(2026, 9, 17, 12, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	completed := metav1.NewTime(now.Add(-61 * time.Second))
	review := terminalReviewFixture(now.Add(-61*time.Second), reviewv1alpha2.PhaseSucceeded, &completed)
	secret := secretFixture(review.Spec.RunSecretName, review.Namespace)
	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(review, secret).WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: kube, Scheme: scheme, Now: func() time.Time { return now }}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("first reconcile: attach the run-secret finalizer and issue the retention Delete: %v", err)
	}
	if err := kube.Get(context.Background(), req.NamespacedName, &reviewv1alpha2.PRReviewJob{}); err != nil {
		t.Fatalf("review must survive the first (deletionTimestamp-only) Delete call: %v", err)
	}
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: secret.Name}, &corev1.Secret{}); err != nil {
		t.Fatalf("secret must still exist before the finalizer is processed: %v", err)
	}

	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("second reconcile: process the run-secret cleanup finalizer: %v", err)
	}
	if err := kube.Get(context.Background(), req.NamespacedName, &reviewv1alpha2.PRReviewJob{}); !apierrors.IsNotFound(err) {
		t.Fatalf("review must be fully deleted once the finalizer clears, got err=%v", err)
	}
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: secret.Name}, &corev1.Secret{}); !apierrors.IsNotFound(err) {
		t.Fatalf("secret must be deleted alongside the review, got err=%v", err)
	}
}

func ptrTime(t metav1.Time) *metav1.Time { return &t }
