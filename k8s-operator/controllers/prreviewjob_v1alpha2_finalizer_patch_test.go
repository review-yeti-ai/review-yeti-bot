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

// REL-896: the CRD enforces `x-kubernetes-validations: self == oldSelf` on
// PRReviewJob.spec (config/crd/bases/review-yeti.ai_prreviewjobs.yaml). A
// full Update on this resource always serializes the entire object -- spec
// included -- and round-tripping a stored spec through the current Go types
// can change its serialized shape (fields without omitempty gain zero
// values, unknown fields are dropped) even when the caller never intended to
// touch spec. That drift made the finalizer add/remove Updates in Reconcile
// and reconcileRunSecretDeletion fail in production against an
// older-shaped resource with "PRReviewJob spec is invalid" / "PRReviewJob
// spec is immutable". controller-runtime's fake client (used by every other
// test in this package) performs no CRD validation at all, so this class of
// bug was completely invisible before this file: every existing test was
// green while the finalizer Updates were broken.
//
// simulateSpecImmutability below reproduces the API server's exact rule with
// an interceptor: any full Update against a *PRReviewJob is rejected outright
// (a full Update always carries spec, so the rule always re-fires), and any
// Patch against a *PRReviewJob is rejected only when its encoded body
// carries a top-level "spec" key. A correct metadata-only merge patch never
// trips the Patch branch and passes straight through.
package controllers_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/validation/field"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

	reviewv1alpha2 "github.com/calltelemetry/ct-review-bot/k8s-operator/api/v1alpha2"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/controllers"
)

// specImmutabilityError mirrors the production API server rejection verbatim
// (see PRReviewJob.review-yeti.ai "<name>" is invalid: spec: Invalid value:
// "object": PRReviewJob spec is immutable, observed against a live cluster)
// so a failure here is unambiguous in test output.
func specImmutabilityError(name string) error {
	return apierrors.NewInvalid(
		schema.GroupKind{Group: "review-yeti.ai", Kind: "PRReviewJob"},
		name,
		field.ErrorList{field.Invalid(field.NewPath("spec"), "object", "PRReviewJob spec is immutable")},
	)
}

// simulateSpecImmutability wraps kube with an interceptor that reproduces the
// CRD's spec-immutability rule for *PRReviewJob objects only; every other
// object type (Jobs, PVCs, Leases, Secrets, status subresource writes) passes
// straight through untouched, exactly as the real rule -- scoped to the
// `spec` schema node -- would. When capturedPatch is non-nil, the last patch
// body observed against a *PRReviewJob is copied into it for the caller to
// assert on.
func simulateSpecImmutability(t *testing.T, kube client.WithWatch, capturedPatch *[]byte) client.WithWatch {
	t.Helper()
	return interceptor.NewClient(kube, interceptor.Funcs{
		Update: func(ctx context.Context, c client.WithWatch, obj client.Object, opts ...client.UpdateOption) error {
			review, ok := obj.(*reviewv1alpha2.PRReviewJob)
			if !ok {
				return c.Update(ctx, obj, opts...)
			}
			// A full Update always serializes the whole object, spec
			// included, so the API server's `self == oldSelf` rule always
			// re-evaluates and always rejects it -- regardless of whether
			// spec actually changed.
			return specImmutabilityError(review.Name)
		},
		Patch: func(ctx context.Context, c client.WithWatch, obj client.Object, patch client.Patch, opts ...client.PatchOption) error {
			review, ok := obj.(*reviewv1alpha2.PRReviewJob)
			if !ok {
				return c.Patch(ctx, obj, patch, opts...)
			}
			data, err := patch.Data(obj)
			if err != nil {
				return err
			}
			if capturedPatch != nil {
				*capturedPatch = append([]byte(nil), data...)
			}
			var body map[string]json.RawMessage
			if err := json.Unmarshal(data, &body); err != nil {
				t.Fatalf("decode intercepted PRReviewJob patch body: %v", err)
			}
			if _, hasSpec := body["spec"]; hasSpec {
				return specImmutabilityError(review.Name)
			}
			return c.Patch(ctx, obj, patch, opts...)
		},
	})
}

// legacyShapedV1Alpha2Review returns a review whose spec carries none of the
// fields the v1alpha2 type marks +optional (ExecutionAttempt, PreparedReview,
// QualificationProfile, QualificationModel, RunnerMode) -- the shape an
// object persisted by an operator/dispatcher build that predates those
// fields would have once decoded into the current Go type. RunnerMode is
// left at its Go zero value rather than "generic" so admission reaches
// worker-Job creation in a single reconcile (BuildWorkerJob and the PVC
// branch in Reconcile both treat "" the same as "prebaked"), keeping this
// test about the finalizer patch rather than the separate PVC-provisioning
// requeue loop.
func legacyShapedV1Alpha2Review(now time.Time) *reviewv1alpha2.PRReviewJob {
	review := v1alpha2Review(now)
	review.Spec.ExecutionAttempt = nil
	review.Spec.PreparedReview = nil
	review.Spec.QualificationProfile = ""
	review.Spec.QualificationModel = ""
	review.Spec.RunnerMode = ""
	return review
}

// TestPRReviewJobV1Alpha2ReconcilerAddsFinalizerViaMetadataOnlyPatchUnderSpecImmutabilityRule
// fails against the pre-fix code: the old `r.Update(ctx, &review)` full
// update at the top of Reconcile always carries spec and is unconditionally
// rejected by simulateSpecImmutability's Update branch, so Reconcile would
// return that error here instead of nil.
func TestPRReviewJobV1Alpha2ReconcilerAddsFinalizerViaMetadataOnlyPatchUnderSpecImmutabilityRule(t *testing.T) {
	now := time.Date(2026, 9, 17, 12, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	review := v1alpha2Review(now)
	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(review).WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
	var capturedPatch []byte
	wrapped := simulateSpecImmutability(t, kube, &capturedPatch)
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: wrapped, Scheme: scheme, Now: func() time.Time { return now }}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("reconcile under the production spec-immutability rule must not fail attaching the finalizer: %v", err)
	}
	stored := storedReview(t, kube, req)
	if !controllerutil.ContainsFinalizer(stored, runSecretCleanupFinalizer) {
		t.Fatalf("finalizers = %v, want %s attached even under the spec-immutability rule", stored.Finalizers, runSecretCleanupFinalizer)
	}
	if len(capturedPatch) == 0 {
		t.Fatal("expected a Patch call against the PRReviewJob to add the finalizer; none was intercepted")
	}
	var body map[string]json.RawMessage
	if err := json.Unmarshal(capturedPatch, &body); err != nil {
		t.Fatalf("decode captured finalizer-add patch body: %v", err)
	}
	if _, hasSpec := body["spec"]; hasSpec {
		t.Fatalf("finalizer-add patch body must never carry a top-level spec key, got %s", capturedPatch)
	}
	if _, hasMetadata := body["metadata"]; !hasMetadata {
		t.Fatalf("finalizer-add patch body must carry a metadata key (the finalizer list), got %s", capturedPatch)
	}
	if len(body) != 1 {
		t.Fatalf("finalizer-add patch body must contain ONLY metadata, got keys %v in %s", mapKeys(body), capturedPatch)
	}
}

// TestPRReviewJobV1Alpha2ReconcilerRemovesFinalizerViaMetadataOnlyPatchUnderSpecImmutabilityRule
// fails against the pre-fix code the same way: the old
// `r.Update(ctx, review)` full update in reconcileRunSecretDeletion always
// carries spec and is unconditionally rejected, so the terminating review
// would never lose its finalizer or be deleted.
func TestPRReviewJobV1Alpha2ReconcilerRemovesFinalizerViaMetadataOnlyPatchUnderSpecImmutabilityRule(t *testing.T) {
	now := time.Date(2026, 9, 17, 12, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	review := terminalReviewFixture(now, reviewv1alpha2.PhaseSucceeded, ptrTime(metav1.NewTime(now)))
	secret := secretFixture(review.Spec.RunSecretName, review.Namespace)
	kube := deletingReviewFixture(t, scheme, review, secret)
	var capturedPatch []byte
	wrapped := simulateSpecImmutability(t, kube, &capturedPatch)
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: wrapped, Scheme: scheme, Now: func() time.Time { return now }}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("reconcile a terminating review under the production spec-immutability rule must not fail removing the finalizer: %v", err)
	}
	if err := kube.Get(context.Background(), req.NamespacedName, &reviewv1alpha2.PRReviewJob{}); !apierrors.IsNotFound(err) {
		t.Fatalf("review must be fully deleted once its finalizer clears, even under the spec-immutability rule, got err=%v", err)
	}
	if len(capturedPatch) == 0 {
		t.Fatal("expected a Patch call against the PRReviewJob to remove the finalizer; none was intercepted")
	}
	var body map[string]json.RawMessage
	if err := json.Unmarshal(capturedPatch, &body); err != nil {
		t.Fatalf("decode captured finalizer-remove patch body: %v", err)
	}
	if _, hasSpec := body["spec"]; hasSpec {
		t.Fatalf("finalizer-remove patch body must never carry a top-level spec key, got %s", capturedPatch)
	}
}

// TestPRReviewJobV1Alpha2ReconcilerReconcilesLegacyShapedResourceUnderSpecImmutabilityRule
// proves the fix does not depend on which optional spec fields a stored
// resource happens to carry: a resource shaped like one persisted before
// ExecutionAttempt/PreparedReview/QualificationProfile/QualificationModel
// existed reconciles cleanly (finalizer attached, worker Job created) under
// the same simulated immutability rule.
func TestPRReviewJobV1Alpha2ReconcilerReconcilesLegacyShapedResourceUnderSpecImmutabilityRule(t *testing.T) {
	now := time.Date(2026, 9, 17, 12, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	review := legacyShapedV1Alpha2Review(now)
	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(review).WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
	wrapped := simulateSpecImmutability(t, kube, nil)
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: wrapped, Scheme: scheme, Now: func() time.Time { return now }}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("reconcile a legacy-shaped review under the production spec-immutability rule: %v", err)
	}
	stored := storedReview(t, kube, req)
	if !controllerutil.ContainsFinalizer(stored, runSecretCleanupFinalizer) {
		t.Fatalf("finalizers = %v, want %s attached for a legacy-shaped review", stored.Finalizers, runSecretCleanupFinalizer)
	}
	var worker batchv1.Job
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: review.Name + "-worker"}, &worker); err != nil {
		t.Fatalf("a legacy-shaped review must still get its worker Job created: %v", err)
	}
}

// TestPRReviewJobV1Alpha2ReconcilerCreatesWorkerJobDespiteFailedFinalizerAdd
// proves the failure-handling half of the fix: a review is much better
// admitted with its run Secret cleanup finalizer missing (that Secret leaks
// only until the bounded out-of-band retention sweep reclaims it) than
// stalled entirely. This fails against a version of the code that returns
// the finalizer-add error instead of logging it and continuing.
func TestPRReviewJobV1Alpha2ReconcilerCreatesWorkerJobDespiteFailedFinalizerAdd(t *testing.T) {
	now := time.Date(2026, 9, 17, 12, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	review := v1alpha2Review(now)
	review.Spec.RunnerMode = "" // skip the PVC-provisioning requeue loop; not what this test is about
	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(review).WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).Build()
	finalizerAddAttempts := 0
	failure := errors.New("etcd unavailable")
	wrapped := interceptor.NewClient(kube, interceptor.Funcs{
		Patch: func(ctx context.Context, c client.WithWatch, obj client.Object, patch client.Patch, opts ...client.PatchOption) error {
			if _, ok := obj.(*reviewv1alpha2.PRReviewJob); ok {
				finalizerAddAttempts++
				return failure
			}
			return c.Patch(ctx, obj, patch, opts...)
		},
	})
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: wrapped, Scheme: scheme, Now: func() time.Time { return now }}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("a failed finalizer-add patch must not fail reconciliation: %v", err)
	}
	if finalizerAddAttempts == 0 {
		t.Fatal("expected the reconciler to attempt the finalizer-add patch")
	}
	var worker batchv1.Job
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: review.Name + "-worker"}, &worker); err != nil {
		t.Fatalf("worker Job must still be created when the finalizer-add patch fails: %v", err)
	}
	stored := storedReview(t, kube, req)
	if controllerutil.ContainsFinalizer(stored, runSecretCleanupFinalizer) {
		t.Fatal("the stored review must not carry the finalizer when the patch that was supposed to add it failed")
	}
}

func mapKeys(m map[string]json.RawMessage) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	return keys
}
