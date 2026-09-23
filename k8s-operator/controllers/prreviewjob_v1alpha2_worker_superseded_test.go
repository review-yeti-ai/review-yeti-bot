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

// REL-1057: a worker whose run was superseded by a newer pull request head
// ends with exit 0 and a termination-message marker. The PRReviewJob records
// that as Cancelled/Superseded, never as Failed (which delegates fail-closed
// publication for a head nobody will merge) and never as a plain Succeeded.
package controllers_test

import (
	"context"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	reviewv1alpha2 "github.com/calltelemetry/ct-review-bot/k8s-operator/api/v1alpha2"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/controllers"
)

const supersededTerminationMessage = "review-yeti-worker-superseded stage=pre_review head=" +
	"060d833f0000000000000000000000000000000a current=28ed30b50000000000000000000000000000000b\n"

func terminated(exitCode int32, reason, message string, now time.Time) corev1.ContainerStateTerminated {
	return corev1.ContainerStateTerminated{
		ExitCode: exitCode, Reason: reason, Message: message,
		StartedAt: metav1.NewTime(now.Add(5 * time.Second)), FinishedAt: metav1.NewTime(now.Add(20 * time.Second)),
	}
}

func TestSupersededWorkerIsRecordedAsCancelledSuperseded(t *testing.T) {
	f := newTerminationFixture(t)
	f.finishWorker(t, true, terminated(0, "Completed", supersededTerminationMessage, f.now), "")
	if _, err := f.reconciler.Reconcile(context.Background(), f.req); err != nil {
		t.Fatalf("observe superseded worker: %v", err)
	}
	review := storedReview(t, f.kube, f.req)
	if review.Status.Phase != reviewv1alpha2.PhaseCancelled {
		t.Fatalf("phase = %s, want Cancelled for a superseded run", review.Status.Phase)
	}
	ready := meta.FindStatusCondition(review.Status.Conditions, "Ready")
	if ready == nil || ready.Reason != controllers.SupersededReason || ready.Status != metav1.ConditionFalse {
		t.Fatalf("Ready condition = %+v, want False/Superseded", ready)
	}
	if meta.FindStatusCondition(review.Status.Conditions, "FailurePublication") != nil {
		t.Fatal("a superseded run must not delegate fail-closed publication")
	}
	if review.Status.WorkerTermination == nil || review.Status.WorkerTermination.ExitCode == nil ||
		*review.Status.WorkerTermination.ExitCode != 0 {
		t.Fatalf("workerTermination = %+v, want the exit-0 forensic record kept", review.Status.WorkerTermination)
	}
	// The terminal path must accept the new phase like any other Cancelled run.
	if _, err := f.reconciler.Reconcile(context.Background(), f.req); err != nil {
		t.Fatalf("terminal reconcile of superseded run: %v", err)
	}
	if got := storedReview(t, f.kube, f.req).Status.Phase; got != reviewv1alpha2.PhaseCancelled {
		t.Fatalf("phase after terminal reconcile = %s, want Cancelled to stay", got)
	}
}

func TestSuccessfulWorkerWithoutMarkerStillSucceeds(t *testing.T) {
	f := newTerminationFixture(t)
	f.finishWorker(t, true, terminated(0, "Completed", "", f.now), "")
	if _, err := f.reconciler.Reconcile(context.Background(), f.req); err != nil {
		t.Fatalf("observe worker success: %v", err)
	}
	if got := storedReview(t, f.kube, f.req).Status.Phase; got != reviewv1alpha2.PhaseSucceeded {
		t.Fatalf("phase = %s, want Succeeded", got)
	}
}

// A failing worker cannot relabel its failure by printing the marker: only an
// exit-0 worker is eligible, so fail-closed handling is unchanged.
func TestFailedWorkerPrintingTheMarkerStillFails(t *testing.T) {
	f := newTerminationFixture(t)
	f.finishWorker(t, false, terminated(1, "Error", supersededTerminationMessage, f.now), "")
	if _, err := f.reconciler.Reconcile(context.Background(), f.req); err != nil {
		t.Fatalf("observe worker failure: %v", err)
	}
	if got := storedReview(t, f.kube, f.req).Status.Phase; got != reviewv1alpha2.PhaseFailed {
		t.Fatalf("phase = %s, want Failed", got)
	}
}

func TestMarkerMustBeTheLeadingToken(t *testing.T) {
	f := newTerminationFixture(t)
	f.finishWorker(t, true, terminated(0, "Completed", "note: review-yeti-worker-superseded appears mid-line", f.now), "")
	if _, err := f.reconciler.Reconcile(context.Background(), f.req); err != nil {
		t.Fatalf("observe worker success: %v", err)
	}
	if got := storedReview(t, f.kube, f.req).Status.Phase; got != reviewv1alpha2.PhaseSucceeded {
		t.Fatalf("phase = %s, want Succeeded", got)
	}
}
