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

package controllers

import (
	"context"
	"strings"

	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	reviewv1alpha2 "github.com/calltelemetry/ct-review-bot/k8s-operator/api/v1alpha2"
)

const (
	// workerSupersededMarker is the first token of the termination message a
	// publishing worker writes when a newer pull request head superseded its
	// run (REL-1057). Keep in sync with WORKER_SUPERSEDED_TERMINATION_MARKER in
	// src/review/reviewSupersession.ts.
	workerSupersededMarker = "review-yeti-worker-superseded"
	// SupersededReason is the Ready condition reason recorded on a PRReviewJob
	// whose worker ended superseded. The phase is Cancelled: the CRD phase enum
	// is unchanged, so dashboards and failure counts separate it by this reason.
	SupersededReason = "Superseded"
)

// workerEndedSuperseded reports whether the worker exited successfully and
// said, in its termination message, that its run was superseded. Only a
// successful exit qualifies: the marker merely relabels an outcome that would
// otherwise be Succeeded, which publishes nothing either, so a worker cannot
// use it to hide a failure or to skip fail-closed publication.
func workerEndedSuperseded(review *reviewv1alpha2.PRReviewJob) bool {
	termination := review.Status.WorkerTermination
	if termination == nil || termination.ExitCode == nil || *termination.ExitCode != 0 {
		return false
	}
	message := strings.TrimSpace(termination.Message)
	return message == workerSupersededMarker || strings.HasPrefix(message, workerSupersededMarker+" ")
}

// recordSuperseded writes the terminal Cancelled phase with reason Superseded,
// in the same shape reconcileCancellation uses for a cancelled run.
func (r *PRReviewJobV1Alpha2Reconciler) recordSuperseded(ctx context.Context, review *reviewv1alpha2.PRReviewJob) error {
	message := workerMessage(review, "ended superseded by a newer pull request head")
	review.Status.Phase = reviewv1alpha2.PhaseCancelled
	review.Status.ObservedGeneration = review.Generation
	review.Status.Message = message
	meta.SetStatusCondition(&review.Status.Conditions, metav1.Condition{
		Type:               "Ready",
		Status:             metav1.ConditionFalse,
		Reason:             SupersededReason,
		Message:            message,
		ObservedGeneration: review.Generation,
		LastTransitionTime: metav1.Now(),
	})
	return r.Status().Update(ctx, review)
}
