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

// REL-896: patchWorkerSuccessTTL only had happy-path coverage (the succeeded
// worker's TTL patch always landing). These tests use interceptor.Funcs to
// inject a Patch failure on the worker Job, exercising the two outcomes the
// production code already has to handle: a transient error must block the
// review from advancing to Succeeded, and a NotFound (the worker Job raced a
// delete after the controller observed Succeeded) must not.
package controllers_test

import (
	"context"
	"errors"
	"testing"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"

	reviewv1alpha2 "github.com/calltelemetry/ct-review-bot/k8s-operator/api/v1alpha2"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/job"
)

// markWorkerSucceeded flips a fixture's worker Job to Succeeded=1 with a
// JobComplete condition, the same shape missingJobFixture callers use to
// drive the controller into the patchWorkerSuccessTTL branch.
func markWorkerSucceeded(t *testing.T, kube client.Client, worker *batchv1.Job, at metav1.Time) {
	t.Helper()
	worker.Status.Succeeded = 1
	worker.Status.Conditions = []batchv1.JobCondition{{
		Type: batchv1.JobComplete, Status: corev1.ConditionTrue, LastTransitionTime: at,
	}}
	if err := kube.Status().Update(context.Background(), worker); err != nil {
		t.Fatalf("mark worker succeeded: %v", err)
	}
}

func TestPatchWorkerSuccessTTLTransientErrorBlocksSuccessPhase(t *testing.T) {
	ctx := context.Background()
	r, kube, req := missingJobFixture(t, "app-gate", interceptor.Funcs{})
	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}

	review := storedReview(t, kube, req)
	if review.Status.Phase != reviewv1alpha2.PhaseRunning {
		t.Fatalf("baseline phase = %s, want Running before the worker succeeds", review.Status.Phase)
	}
	worker := storedWorker(t, kube, req)
	originalTTL := worker.Spec.TTLSecondsAfterFinished
	if originalTTL == nil || *originalTTL != job.WorkerFailedTTLSeconds() {
		t.Fatalf("worker built with TTL %v, want the fail-safe %d", originalTTL, job.WorkerFailedTTLSeconds())
	}
	markWorkerSucceeded(t, kube, worker, metav1.NewTime(r.Now()))

	transient := errors.New("injected transient TTL patch failure")
	r.Client = interceptor.NewClient(kube.(client.WithWatch), interceptor.Funcs{
		Patch: func(ctx context.Context, c client.WithWatch, obj client.Object, patch client.Patch, opts ...client.PatchOption) error {
			if _, ok := obj.(*batchv1.Job); ok {
				return transient
			}
			return c.Patch(ctx, obj, patch, opts...)
		},
	})

	if _, err := r.Reconcile(ctx, req); !errors.Is(err, transient) {
		t.Fatalf("Reconcile error = %v, want the injected transient error surfaced", err)
	}

	afterReview := storedReview(t, kube, req)
	if afterReview.Status.Phase == reviewv1alpha2.PhaseSucceeded {
		t.Fatal("a transient TTL patch failure must not advance the review to Succeeded")
	}
	afterWorker := storedWorker(t, kube, req)
	if afterWorker.Spec.TTLSecondsAfterFinished == nil || *afterWorker.Spec.TTLSecondsAfterFinished != *originalTTL {
		t.Fatalf("worker TTL = %v, want unchanged fail-safe %d after a failed patch", afterWorker.Spec.TTLSecondsAfterFinished, *originalTTL)
	}
}

func TestPatchWorkerSuccessTTLNotFoundStillSucceeds(t *testing.T) {
	ctx := context.Background()
	r, kube, req := missingJobFixture(t, "app-gate", interceptor.Funcs{})
	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatal(err)
	}

	worker := storedWorker(t, kube, req)
	markWorkerSucceeded(t, kube, worker, metav1.NewTime(r.Now()))

	r.Client = interceptor.NewClient(kube.(client.WithWatch), interceptor.Funcs{
		Patch: func(ctx context.Context, c client.WithWatch, obj client.Object, patch client.Patch, opts ...client.PatchOption) error {
			if job, ok := obj.(*batchv1.Job); ok {
				return apierrors.NewNotFound(schema.GroupResource{Group: "batch", Resource: "jobs"}, job.Name)
			}
			return c.Patch(ctx, obj, patch, opts...)
		},
	})

	if _, err := r.Reconcile(ctx, req); err != nil {
		t.Fatalf("Reconcile returned %v, want the TTL patch NotFound swallowed", err)
	}
	after := storedReview(t, kube, req)
	if after.Status.Phase != reviewv1alpha2.PhaseSucceeded {
		t.Fatalf("phase = %s, want Succeeded even though the worker Job's TTL patch raced a delete", after.Status.Phase)
	}
}
