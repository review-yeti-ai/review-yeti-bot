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
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/log"

	reviewv1alpha2 "github.com/calltelemetry/ct-review-bot/k8s-operator/api/v1alpha2"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/job"
)

const (
	// maxTerminationMessageBytes bounds status.workerTermination.message well
	// inside the CRD's 1024-character limit. The field is a pointer into the
	// log store, not a transcript.
	maxTerminationMessageBytes = 512
	maxTerminationReasonBytes  = 128

	// Condition and Reason constants for UNKNOWN effect safety guard
	ConditionUnknownEffectPending = reviewv1alpha2.ConditionUnknownEffectPending

	ReasonPodEvictedWithInFlightEffect   = "PodEvictedWithInFlightEffect"
	ReasonPodPreemptedWithInFlightEffect = "PodPreemptedWithInFlightEffect"
	ReasonPodTimeoutWithInFlightEffect   = "PodTimeoutWithInFlightEffect"
	ReasonPodFailedWithInFlightEffect    = "PodFailedWithInFlightEffect"
	ReasonUnknownEffectPreserved         = "UnknownEffectPreserved"
	ReasonUnresolvedEffect               = "UnresolvedEffect"
	ReasonAllEffectsResolved             = "AllEffectsResolved"

	// External Effect States
	EffectStateIntended    = "INTENDED"
	EffectStateInFlight    = "IN_FLIGHT"
	EffectStateSucceeded   = "SUCCEEDED"
	EffectStateFailed      = "FAILED"
	EffectStateUnknown     = "UNKNOWN"
	EffectStateReconciling = "RECONCILING"
	EffectStateManual      = "MANUAL"
)

var (
	ErrInvalidEffectTransition = errors.New("invalid effect state transition")
	ErrUnknownEffectPending    = errors.New("cannot promote to succeeded while unknown effect is pending")
	ErrMissingReceiptAudit     = errors.New("cannot finalize worker without receipt digest and evidence ref")
)

// credentialPatterns redacts credential-shaped tokens a worker could print on
// its last line. The termination message is written into a CR that more
// principals can read than the worker's log stream, so it is scrubbed even
// though the worker's own logger already redacts.
var credentialPatterns = []*regexp.Regexp{
	regexp.MustCompile(`\b(?:gh[opsur]|github_pat)_[A-Za-z0-9_]{16,}`),
	regexp.MustCompile(`\bsk-[A-Za-z0-9_-]{16,}`),
	regexp.MustCompile(`(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{8,}`),
	regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`),
	regexp.MustCompile(`\b(?:AKIA|ASIA)[A-Z0-9]{16}\b`),
	regexp.MustCompile(`\bAIza[0-9A-Za-z_-]{35}`),
	// A keyword, a separator, an optional HTTP auth scheme, then the value:
	// "Authorization: Basic <base64>" must lose the credential, not stop at
	// the short scheme word.
	regexp.MustCompile(`(?i)\b(api[_-]?key|access[_-]?key|token|secret|password|passwd|authorization|cookie)(["']?\s*[:=]\s*["']?(?:(?:basic|bearer|digest|negotiate|token)\s+)?)[^\s"',}]{6,}`),
	regexp.MustCompile(`-----BEGIN [A-Z ]*PRIVATE KEY-----`),
}

// observeWorkerTermination copies the finished worker Pod's termination state
// into review.Status.WorkerTermination. It returns true only when it set the
// record in memory; the caller persists it. The record is written once: a
// later observation (a replacement Pod, a Pod already being collected) never
// overwrites the first forensic record.
func (r *PRReviewJobV1Alpha2Reconciler) observeWorkerTermination(
	ctx context.Context,
	review *reviewv1alpha2.PRReviewJob,
	worker *batchv1.Job,
	now time.Time,
) (bool, error) {
	if review.Status.WorkerTermination != nil || worker == nil {
		return false, nil
	}
	var pods corev1.PodList
	if err := r.List(ctx, &pods, client.InNamespace(worker.Namespace), client.MatchingLabels{
		"batch.kubernetes.io/job-name": worker.Name,
	}); err != nil {
		return false, err
	}
	record := workerTerminationFromPods(pods.Items, worker, now)
	if record == nil {
		return false, nil
	}
	review.Status.WorkerTermination = record
	return true, nil
}

// workerTerminationFromPods selects the most recently finished Pod that the
// worker Job controls and projects its bounded termination record. A Pod that
// is still running contributes nothing.
func workerTerminationFromPods(pods []corev1.Pod, worker *batchv1.Job, now time.Time) *reviewv1alpha2.WorkerTerminationStatus {
	var best *reviewv1alpha2.WorkerTerminationStatus
	for index := range pods {
		pod := &pods[index]
		if !podBelongsToWorkerJob(pod, worker) {
			continue
		}
		record := podTermination(pod, now)
		if record == nil {
			continue
		}
		if best == nil || finishedAfter(record, best) {
			best = record
		}
	}
	return best
}

func finishedAfter(candidate, current *reviewv1alpha2.WorkerTerminationStatus) bool {
	if candidate.FinishedAt == nil {
		return false
	}
	if current.FinishedAt == nil {
		return true
	}
	return candidate.FinishedAt.After(current.FinishedAt.Time)
}

func podTermination(pod *corev1.Pod, now time.Time) *reviewv1alpha2.WorkerTerminationStatus {
	var terminated *corev1.ContainerStateTerminated
	for _, status := range pod.Status.ContainerStatuses {
		if status.Name != job.WorkerContainerName {
			continue
		}
		if status.State.Terminated != nil {
			terminated = status.State.Terminated
		} else if status.LastTerminationState.Terminated != nil && pod.Status.Phase == corev1.PodFailed {
			terminated = status.LastTerminationState.Terminated
		}
		break
	}
	podFinished := pod.Status.Phase == corev1.PodSucceeded || pod.Status.Phase == corev1.PodFailed
	if terminated == nil && !podFinished {
		return nil
	}
	record := &reviewv1alpha2.WorkerTerminationStatus{
		PodName:    pod.Name,
		NodeName:   pod.Spec.NodeName,
		PodReason:  boundedToken(pod.Status.Reason, maxTerminationReasonBytes),
		ObservedAt: metav1.NewTime(now),
	}
	message := ""
	if terminated != nil {
		exitCode := terminated.ExitCode
		record.ContainerName = job.WorkerContainerName
		record.ExitCode = &exitCode
		if terminated.Signal != 0 {
			signal := terminated.Signal
			record.Signal = &signal
		}
		record.Reason = boundedToken(terminated.Reason, maxTerminationReasonBytes)
		if !terminated.StartedAt.IsZero() {
			started := terminated.StartedAt
			record.StartedAt = &started
		}
		if !terminated.FinishedAt.IsZero() {
			finished := terminated.FinishedAt
			record.FinishedAt = &finished
		}
		message = terminated.Message
	}
	if strings.TrimSpace(message) == "" {
		// Pod-level failures (Evicted, DeadlineExceeded) explain themselves in
		// the Pod status, not the container's.
		message = pod.Status.Message
	}
	record.Message = lastErrorLine(message)
	return record
}

// lastErrorLine keeps the last non-empty line of a termination message,
// strips control characters, redacts credential-shaped tokens, and truncates
// on a rune boundary.
func lastErrorLine(message string) string {
	lines := strings.Split(strings.ReplaceAll(message, "\r\n", "\n"), "\n")
	line := ""
	for index := len(lines) - 1; index >= 0; index-- {
		if candidate := strings.TrimSpace(lines[index]); candidate != "" {
			line = candidate
			break
		}
	}
	if line == "" {
		return ""
	}
	line = strings.Map(func(r rune) rune {
		if r == utf8.RuneError || (unicode.IsControl(r) && r != '\t') {
			return -1
		}
		return r
	}, line)
	for _, pattern := range credentialPatterns {
		line = pattern.ReplaceAllStringFunc(line, func(match string) string {
			if groups := pattern.FindStringSubmatch(match); len(groups) == 3 {
				return groups[1] + groups[2] + "[REDACTED]"
			}
			return "[REDACTED]"
		})
	}
	return truncateRunes(line, maxTerminationMessageBytes)
}

func boundedToken(value string, limit int) string {
	return truncateRunes(strings.TrimSpace(value), limit)
}

func truncateRunes(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	cut := limit
	for cut > 0 && !utf8.RuneStart(value[cut]) {
		cut--
	}
	return value[:cut]
}

// ReconcileUnknownEffectGuard enforces that when a pod fails, gets evicted,
// preempted, or times out, any in-flight external effect states are NOT promoted
// to SUCCEEDED or overwritten. UNKNOWN remains UNKNOWN, UnknownEffectPending is
// surfaced as True, and transition to EXECUTING or SUCCEEDED is blocked.
func (r *PRReviewJobV1Alpha2Reconciler) ReconcileUnknownEffectGuard(
	ctx context.Context,
	review *reviewv1alpha2.PRReviewJob,
	worker *batchv1.Job,
	now time.Time,
) error {
	logger := log.FromContext(ctx)

	// If UnknownEffectPending is already True, preserve it monotonically.
	isUnknownPending := meta.IsStatusConditionTrue(review.Status.Conditions, ConditionUnknownEffectPending)
	termination := review.Status.WorkerTermination

	// Check if the pod terminated abnormally
	abnormalTermination := false
	reason := ReasonPodFailedWithInFlightEffect
	message := "worker terminated abnormally with unresolved in-flight effects"

	if termination != nil {
		if termination.ExitCode != nil && *termination.ExitCode != 0 {
			abnormalTermination = true
			if termination.Reason == "OOMKilled" || *termination.ExitCode == 137 {
				reason = ReasonPodFailedWithInFlightEffect
				message = fmt.Sprintf("worker pod was OOMKilled (exit %d); external effect state marked UNKNOWN", *termination.ExitCode)
			} else {
				message = fmt.Sprintf("worker pod failed with exit code %d; external effect state marked UNKNOWN", *termination.ExitCode)
			}
		} else if termination.ExitCode == nil {
			// Pod-level failure (Evicted, Preempted, DeadlineExceeded)
			abnormalTermination = true
			switch strings.ToLower(termination.PodReason) {
			case "evicted":
				reason = ReasonPodEvictedWithInFlightEffect
				message = "worker pod was evicted by kubelet (resource pressure); external effect state marked UNKNOWN"
			case "preempting", "preempted":
				reason = ReasonPodPreemptedWithInFlightEffect
				message = "worker pod was preempted by scheduler; external effect state marked UNKNOWN"
			case "deadlineexceeded":
				reason = ReasonPodTimeoutWithInFlightEffect
				message = "worker pod exceeded deadline; external effect state marked UNKNOWN"
			default:
				reason = ReasonPodFailedWithInFlightEffect
				message = fmt.Sprintf("worker pod terminated with pod reason %q; external effect state marked UNKNOWN", termination.PodReason)
			}
		}
	} else if worker != nil && worker.Status.Failed > 0 {
		abnormalTermination = true
		message = "worker Job failed without readable container exit; external effect state marked UNKNOWN"
	}

	if abnormalTermination || isUnknownPending {
		if !abnormalTermination && isUnknownPending {
			// If already set, preserve existing reason unless we have an update
			existingCond := meta.FindStatusCondition(review.Status.Conditions, ConditionUnknownEffectPending)
			if existingCond != nil && existingCond.Reason != "" {
				reason = existingCond.Reason
				message = existingCond.Message
			}
		}
		logger.Info("enforcing UNKNOWN effect guard", "review", review.Name, "reason", reason, "message", message)
		meta.SetStatusCondition(&review.Status.Conditions, metav1.Condition{
			Type:               ConditionUnknownEffectPending,
			Status:             metav1.ConditionTrue,
			Reason:             reason,
			Message:            message,
			ObservedGeneration: review.Generation,
			LastTransitionTime: metav1.NewTime(now),
		})
	}

	return nil
}

// ValidateEffectTransition validates allowed state transitions:
// INTENT -> EXECUTING -> SUCCEEDED | FAILED | UNKNOWN
// UNKNOWN -> RECONCILING -> SUCCEEDED | FAILED | UNKNOWN | MANUAL
// FORBIDDEN: UNKNOWN -> EXECUTING, UNKNOWN -> SUCCEEDED
func ValidateEffectTransition(from, to string) error {
	switch from {
	case EffectStateIntended:
		if to == EffectStateInFlight {
			return nil
		}
	case EffectStateInFlight:
		if to == EffectStateSucceeded || to == EffectStateFailed || to == EffectStateUnknown {
			return nil
		}
	case EffectStateUnknown:
		if to == EffectStateReconciling {
			return nil
		}
		// Explicitly forbidden transitions from UNKNOWN
		if to == EffectStateInFlight || to == EffectStateSucceeded {
			return fmt.Errorf("%w: cannot transition from %s to %s without authoritative reconciliation",
				ErrInvalidEffectTransition, from, to)
		}
	case EffectStateReconciling:
		if to == EffectStateSucceeded || to == EffectStateFailed || to == EffectStateUnknown || to == EffectStateManual {
			return nil
		}
	}
	if from == to {
		return nil
	}
	return fmt.Errorf("%w: invalid transition from %s to %s", ErrInvalidEffectTransition, from, to)
}

// AssertCanPromoteToSucceeded ensures a worker outcome can only be promoted to
// Succeeded if no unknown effects are pending and receipt auditability is satisfied.
func AssertCanPromoteToSucceeded(review *reviewv1alpha2.PRReviewJob) error {
	if meta.IsStatusConditionTrue(review.Status.Conditions, ConditionUnknownEffectPending) {
		return fmt.Errorf("%w: condition %s is True", ErrUnknownEffectPending, ConditionUnknownEffectPending)
	}
	if review.Status.ReceiptDigest == "" || review.Status.ReceiptEvidenceRef == "" {
		return fmt.Errorf("%w: receiptDigest and receiptEvidenceRef must be non-empty", ErrMissingReceiptAudit)
	}
	return nil
}

// ensureReceiptAuditability ensures status.ReceiptDigest and status.ReceiptEvidenceRef
// are populated and committed prior to resource finalization or secret deletion.
func (r *PRReviewJobV1Alpha2Reconciler) ensureReceiptAuditability(
	ctx context.Context,
	review *reviewv1alpha2.PRReviewJob,
	worker *batchv1.Job,
	now time.Time,
) (bool, error) {
	if review.Status.ReceiptDigest != "" && review.Status.ReceiptEvidenceRef != "" {
		return false, nil
	}

	// 1. If worker job or pod annotations contain genuine receipt evidence, adopt them
	if worker != nil {
		if d, ok := worker.Annotations["review-yeti.ai/receipt-digest"]; ok && d != "" {
			review.Status.ReceiptDigest = d
		} else if d, ok := worker.Annotations["ct.calltelemetry.com/receipt-digest"]; ok && d != "" {
			review.Status.ReceiptDigest = d
		}
		if ev, ok := worker.Annotations["review-yeti.ai/receipt-evidence-ref"]; ok && ev != "" {
			review.Status.ReceiptEvidenceRef = ev
		} else if ev, ok := worker.Annotations["ct.calltelemetry.com/receipt-evidence-ref"]; ok && ev != "" {
			review.Status.ReceiptEvidenceRef = ev
		}
		if review.Status.ReceiptDigest != "" && review.Status.ReceiptEvidenceRef != "" {
			return true, nil
		}
	}

	// Never synthesize a fake ReceiptDigest for successful jobs or when phase is Succeeded.
	// Genuine receipt annotations are strictly required; missing annotations must leave
	// ReceiptDigest empty so AssertCanPromoteToSucceeded catches ErrMissingReceiptAudit and fails closed.
	if (worker != nil && worker.Status.Succeeded > 0) || review.Status.Phase == reviewv1alpha2.PhaseSucceeded {
		return false, nil
	}

	// 2. Synthesize durable deterministic receipt evidence for terminal non-successful deletions
	// from the work request digest or the pod termination record.
	h := sha256.New()
	seed := fmt.Sprintf("%s:%s:%s:%d", review.Spec.RunID, review.Spec.Repo, review.Spec.HeadSHA, review.Spec.RepositoryID)
	h.Write([]byte(seed))
	digest := "sha256:" + hex.EncodeToString(h.Sum(nil))

	evidenceRef := fmt.Sprintf("audit://%s/%s/receipt", review.Namespace, review.Spec.RunID)
	if review.Status.WorkerTermination != nil && review.Status.WorkerTermination.PodName != "" {
		evidenceRef = fmt.Sprintf("audit://%s/%s/pod/%s", review.Namespace, review.Spec.RunID, review.Status.WorkerTermination.PodName)
	}

	review.Status.ReceiptDigest = digest
	review.Status.ReceiptEvidenceRef = evidenceRef

	log.FromContext(ctx).Info("persisting receipt audit fields prior to finalization",
		"review", review.Name, "digest", digest, "evidenceRef", evidenceRef)
	return true, nil
}

// prepareFinishedWorkerRelease runs immediately before this controller
// releases terminalOutcomeFinalizer on a worker Job. It gives the forensic
// record one more chance to land (the Pod cache can trail the Job's terminal
// event) and persists it, and only then lowers the in-memory Job's TTL from
// the build-time forensic hold to the outcome's configured TTL. The caller
// writes the Job.
//
// It returns ready=false, and changes nothing on the Job, while a worker Pod
// still exists but its exit is not yet readable and the forensic hold has not
// elapsed since the Job finished: releasing then would let a failed TTL of 0
// collect the Pod before it was ever recorded. The caller keeps the finalizer
// and requeues. Once no Pod is left, or the hold has elapsed, release proceeds
// without a record rather than wedging the Job. A Job that has not finished is
// left untouched and is ready.
func (r *PRReviewJobV1Alpha2Reconciler) prepareFinishedWorkerRelease(
	ctx context.Context,
	review *reviewv1alpha2.PRReviewJob,
	worker *batchv1.Job,
) (bool, error) {
	if !workerJobFinished(worker) && worker.Status.Succeeded == 0 {
		return true, nil
	}
	now := r.clock()
	recorded, err := r.observeWorkerTermination(ctx, review, worker, now)
	if err != nil {
		return false, err
	}

	if err := r.ReconcileUnknownEffectGuard(ctx, review, worker, now); err != nil {
		return false, err
	}

	auditRecorded, err := r.ensureReceiptAuditability(ctx, review, worker, now)
	if err != nil {
		return false, err
	}

	if recorded || auditRecorded {
		if err := r.Status().Update(ctx, review); err != nil {
			return false, err
		}
	}
	if review.Status.WorkerTermination == nil {
		podPresent, err := r.workerJobHasPod(ctx, worker)
		if err != nil {
			return false, err
		}
		holdEndsAt := terminalWorkerTime(worker, now).Add(time.Duration(job.WorkerForensicHoldSeconds()) * time.Second)
		if podPresent && now.Before(holdEndsAt) {
			return false, nil
		}
	}
	ttl := job.WorkerFinishedTTLSeconds(worker.Status.Succeeded > 0)
	worker.Spec.TTLSecondsAfterFinished = &ttl
	return true, nil
}

// workerJobHasPod reports whether any Pod the worker Job controls still exists.
func (r *PRReviewJobV1Alpha2Reconciler) workerJobHasPod(ctx context.Context, worker *batchv1.Job) (bool, error) {
	var pods corev1.PodList
	if err := r.List(ctx, &pods, client.InNamespace(worker.Namespace), client.MatchingLabels{
		"batch.kubernetes.io/job-name": worker.Name,
	}); err != nil {
		return false, err
	}
	for index := range pods.Items {
		if podBelongsToWorkerJob(&pods.Items[index], worker) {
			return true, nil
		}
	}
	return false, nil
}
