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

// REL-896: releaseTerminalWorkerObservation and releaseOrphanedWorkerObservation
// each do a cached-then-live read of the worker Job followed by an Update that
// removes this controller's own terminalOutcomeFinalizer. Those two steps are
// not atomic. A prior reconcile racing the same release, or the Job's own
// success TTL (patchWorkerSuccessTTL shortens ttlSecondsAfterFinished to 0 once
// Succeeded is observed) letting Kubernetes' TTL-after-finished controller
// collect it, can delete the Job in the window between the read and the
// Update. Production logged that race as a bare
// `jobs.batch "ct-review-<id>-worker" not found` Reconcile error roughly once
// per 17 reviews, even though the review itself had already reached
// PhaseSucceeded -- a false alarm in the one log line operators watch. A
// NotFound on that specific Update means "already gone, nothing left to
// release," not a failure.
//
// The two places that ADD the same finalizer (in Reconcile's existing-Job
// branch and in reconcileElapsedDeadline) read the Job live and then Update it
// moments later under the identical race; this file also proves those two
// sites tolerate NotFound and fall through using the in-memory Job state
// already captured by that read, instead of discarding an already-observed
// terminal outcome behind a spurious error.
package controllers_test

import (
	"context"
	"errors"
	"testing"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"

	reviewv1alpha2 "github.com/calltelemetry/ct-review-bot/k8s-operator/api/v1alpha2"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/controllers"
)

// notFoundJobErr mirrors the exact production error shape
// (`jobs.batch "ct-review-<id>-worker" not found`) so a failing assertion in
// this file is unambiguous in test output.
func notFoundJobErr(name string) error {
	return apierrors.NewNotFound(schema.GroupResource{Group: "batch", Resource: "jobs"}, name)
}

// interceptWorkerJobUpdate wraps kube so every Update against a *batchv1.Job
// is replaced by the given failure; every other object and verb (including
// Patch, used by patchWorkerSuccessTTL) passes straight through.
func interceptWorkerJobUpdate(kube client.WithWatch, fail error) client.WithWatch {
	return interceptor.NewClient(kube, interceptor.Funcs{
		Update: func(ctx context.Context, c client.WithWatch, obj client.Object, opts ...client.UpdateOption) error {
			if _, ok := obj.(*batchv1.Job); ok {
				return fail
			}
			return c.Update(ctx, obj, opts...)
		},
	})
}

// runningReviewWithWorker drives a fresh v1alpha2 review through admission and
// worker-Job creation. missingJobFixture's own internal reconcile only reaches
// PhaseQueued while its workspace PVC is provisioned; the explicit Reconcile
// call here is the one that actually admits it and creates the worker.
func runningReviewWithWorker(t *testing.T, mode string) (*controllers.PRReviewJobV1Alpha2Reconciler, client.Client, ctrl.Request) {
	t.Helper()
	r, kube, req := missingJobFixture(t, mode, interceptor.Funcs{})
	if _, err := r.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("admit review and create worker Job: %v", err)
	}
	review := storedReview(t, kube, req)
	if review.Status.Phase != reviewv1alpha2.PhaseRunning {
		t.Fatalf("phase = %s, want Running with a worker Job created", review.Status.Phase)
	}
	return r, kube, req
}

// terminalReviewWithFinalizedWorker gets a review all the way to PhaseSucceeded
// via the normal reconcileExistingJob path (so the worker Job still carries
// terminalOutcomeFinalizer, exactly the precondition releaseTerminalWorkerObservation
// runs under) without yet having released that guard.
func terminalReviewWithFinalizedWorker(t *testing.T) (*controllers.PRReviewJobV1Alpha2Reconciler, client.Client, ctrl.Request) {
	t.Helper()
	ctx := context.Background()
	r, kube, req := runningReviewWithWorker(t, "disabled")
	worker := storedWorker(t, kube, req)
	markWorkerSucceeded(t, kube, worker, metav1.NewTime(r.Now()))
	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatalf("observe worker success: %v", err)
	}
	review := storedReview(t, kube, req)
	if review.Status.Phase != reviewv1alpha2.PhaseSucceeded {
		t.Fatalf("phase = %s, want Succeeded", review.Status.Phase)
	}
	if !containsString(storedWorker(t, kube, req).Finalizers, "review-yeti.ai/terminal-outcome") {
		t.Fatal("expected the succeeded worker Job to still carry the terminal-outcome finalizer before release")
	}
	return r, kube, req
}

// (a) terminal review, worker Job present with the terminal-outcome
// finalizer, the intercepted Job Update returns NotFound: Reconcile returns
// no error.
func TestReleaseTerminalWorkerObservationToleratesNotFoundOnUpdate(t *testing.T) {
	ctx := context.Background()
	r, kube, req := terminalReviewWithFinalizedWorker(t)

	r.Client = interceptWorkerJobUpdate(kube.(client.WithWatch), notFoundJobErr(req.Name+"-worker"))

	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatalf("Reconcile returned %v, want the terminal-outcome finalizer release's NotFound tolerated", err)
	}
}

// (c) a transient non-NotFound error on that same Update is still returned.
func TestReleaseTerminalWorkerObservationSurfacesTransientUpdateError(t *testing.T) {
	ctx := context.Background()
	r, kube, req := terminalReviewWithFinalizedWorker(t)

	transient := errors.New("injected transient finalizer-release update failure")
	r.Client = interceptWorkerJobUpdate(kube.(client.WithWatch), transient)

	if _, err := r.Reconcile(ctx, req); !errors.Is(err, transient) {
		t.Fatalf("Reconcile error = %v, want the injected transient error surfaced", err)
	}
}

// (b) the orphaned-worker path (review already deleted): worker Job present
// with the terminal-outcome finalizer and a controller reference to the now-
// gone review, the intercepted Job Update returns NotFound: Reconcile
// returns no error.
func TestReleaseOrphanedWorkerObservationToleratesNotFoundOnUpdate(t *testing.T) {
	ctx := context.Background()
	r, kube, req := runningReviewWithWorker(t, "disabled")
	deleteReviewLeavingOrphanedWorker(t, kube, req)

	r.Client = interceptWorkerJobUpdate(kube.(client.WithWatch), notFoundJobErr(req.Name+"-worker"))

	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatalf("Reconcile returned %v, want the orphaned-worker finalizer release's NotFound tolerated", err)
	}
}

// (c) a transient non-NotFound error on that same Update is still returned.
func TestReleaseOrphanedWorkerObservationSurfacesTransientUpdateError(t *testing.T) {
	ctx := context.Background()
	r, kube, req := runningReviewWithWorker(t, "disabled")
	deleteReviewLeavingOrphanedWorker(t, kube, req)

	transient := errors.New("injected transient orphaned-worker update failure")
	r.Client = interceptWorkerJobUpdate(kube.(client.WithWatch), transient)

	if _, err := r.Reconcile(ctx, req); !errors.Is(err, transient) {
		t.Fatalf("Reconcile error = %v, want the injected transient error surfaced", err)
	}
}

// deleteReviewLeavingOrphanedWorker removes the review's own run-secret
// cleanup finalizer (a real API server would otherwise leave it as a
// deletionTimestamp-only tombstone) and deletes it outright, exactly as an
// external actor (kubectl, a namespace teardown) can while GC has not yet
// caught up with the owned worker Job -- leaving the worker present, still
// carrying terminalOutcomeFinalizer and a controller reference by name to
// the now-deleted review, which is the precondition
// releaseOrphanedWorkerObservation runs under.
func deleteReviewLeavingOrphanedWorker(t *testing.T, kube client.Client, req ctrl.Request) {
	t.Helper()
	ctx := context.Background()
	review := storedReview(t, kube, req)
	review.Finalizers = nil
	if err := kube.Update(ctx, review); err != nil {
		t.Fatalf("strip review finalizers to model an external delete: %v", err)
	}
	if err := kube.Delete(ctx, review); err != nil {
		t.Fatalf("delete review, leaving its owned worker Job behind: %v", err)
	}
	if err := kube.Get(ctx, req.NamespacedName, &reviewv1alpha2.PRReviewJob{}); !apierrors.IsNotFound(err) {
		t.Fatalf("review must be fully gone before exercising the orphaned-worker path, got err=%v", err)
	}
	if err := kube.Get(ctx, types.NamespacedName{Namespace: req.Namespace, Name: req.Name + "-worker"}, &batchv1.Job{}); err != nil {
		t.Fatalf("worker Job must still exist, orphaned by the deleted review: %v", err)
	}
}

// (d) the finalizer-ADD site in Reconcile's existing-Job branch (adopting a
// Job that predates the terminal-outcome finalizer) runs under the identical
// read-then-write race. NotFound on that Update must not discard the
// terminal Status already captured by the read moments earlier.
func TestReconcileAdoptsExistingWorkerDespiteFinalizerAddNotFound(t *testing.T) {
	ctx := context.Background()
	r, kube, req := runningReviewWithWorker(t, "disabled")

	worker := storedWorker(t, kube, req)
	worker.Finalizers = nil
	if err := kube.Update(ctx, worker); err != nil {
		t.Fatalf("strip finalizer to model a legacy-adopted worker Job: %v", err)
	}
	markWorkerSucceeded(t, kube, storedWorker(t, kube, req), metav1.NewTime(r.Now()))

	r.Client = interceptWorkerJobUpdate(kube.(client.WithWatch), notFoundJobErr(req.Name+"-worker"))

	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatalf("Reconcile returned %v, want the finalizer-add NotFound tolerated and the already-observed Succeeded outcome used", err)
	}
	review := storedReview(t, kube, req)
	if review.Status.Phase != reviewv1alpha2.PhaseSucceeded {
		t.Fatalf("phase = %s, want Succeeded from the Status already captured by the live read before the finalizer-add raced NotFound", review.Status.Phase)
	}
}

// (d) the finalizer-ADD site in reconcileElapsedDeadline runs under the
// identical race once the review's terminal deadline has elapsed but a
// legacy-shaped (finalizer-less) worker Job is still observed live.
func TestReconcileElapsedDeadlineToleratesFinalizerAddNotFound(t *testing.T) {
	ctx := context.Background()
	r, kube, req := runningReviewWithWorker(t, "disabled")

	worker := storedWorker(t, kube, req)
	worker.Finalizers = nil
	if err := kube.Update(ctx, worker); err != nil {
		t.Fatalf("strip finalizer to model a legacy-adopted worker Job: %v", err)
	}
	markWorkerSucceeded(t, kube, storedWorker(t, kube, req), metav1.NewTime(r.Now()))

	review := storedReview(t, kube, req)
	r.Now = func() time.Time { return review.Spec.TerminalDeadline.Add(time.Second) }
	r.Client = interceptWorkerJobUpdate(kube.(client.WithWatch), notFoundJobErr(req.Name+"-worker"))

	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatalf("Reconcile returned %v, want the finalizer-add NotFound tolerated and the already-observed Succeeded outcome used", err)
	}
	after := storedReview(t, kube, req)
	if after.Status.Phase != reviewv1alpha2.PhaseSucceeded {
		t.Fatalf("phase = %s, want Succeeded from the Status already captured by the live read even though the deadline had elapsed", after.Status.Phase)
	}
}

// The finalizer-ADD sites tolerate ONLY NotFound. Any other error (a Conflict,
// an unavailable API server) must still surface, because silently skipping the
// terminal-outcome finalizer would let TTL collection erase a worker's outcome
// before it is copied into the review's status.
func TestReconcileAdoptFinalizerAddSurfacesTransientUpdateError(t *testing.T) {
	ctx := context.Background()
	r, kube, req := runningReviewWithWorker(t, "disabled")

	worker := storedWorker(t, kube, req)
	worker.Finalizers = nil
	if err := kube.Update(ctx, worker); err != nil {
		t.Fatalf("strip finalizer to model a legacy-adopted worker Job: %v", err)
	}
	markWorkerSucceeded(t, kube, storedWorker(t, kube, req), metav1.NewTime(r.Now()))

	transient := errors.New("etcd unavailable")
	r.Client = interceptWorkerJobUpdate(kube.(client.WithWatch), transient)

	if _, err := r.Reconcile(ctx, req); !errors.Is(err, transient) {
		t.Fatalf("Reconcile returned %v, want the transient finalizer-add error surfaced", err)
	}
	if review := storedReview(t, kube, req); review.Status.Phase == reviewv1alpha2.PhaseSucceeded {
		t.Fatal("the review must not reach Succeeded while the terminal-outcome finalizer could not be attached")
	}
}

func TestReconcileElapsedDeadlineFinalizerAddSurfacesTransientUpdateError(t *testing.T) {
	ctx := context.Background()
	r, kube, req := runningReviewWithWorker(t, "disabled")

	worker := storedWorker(t, kube, req)
	worker.Finalizers = nil
	if err := kube.Update(ctx, worker); err != nil {
		t.Fatalf("strip finalizer to model a legacy-adopted worker Job: %v", err)
	}
	markWorkerSucceeded(t, kube, storedWorker(t, kube, req), metav1.NewTime(r.Now()))

	review := storedReview(t, kube, req)
	r.Now = func() time.Time { return review.Spec.TerminalDeadline.Add(time.Second) }
	transient := errors.New("etcd unavailable")
	r.Client = interceptWorkerJobUpdate(kube.(client.WithWatch), transient)

	if _, err := r.Reconcile(ctx, req); !errors.Is(err, transient) {
		t.Fatalf("Reconcile returned %v, want the transient finalizer-add error surfaced after the deadline elapsed", err)
	}
}
