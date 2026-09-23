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
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"

	reviewv1alpha2 "github.com/calltelemetry/ct-review-bot/k8s-operator/api/v1alpha2"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/job"
)

const (
	// maxTerminationMessageBytes bounds status.workerTermination.message well
	// inside the CRD's 1024-character limit. The field is a pointer into the
	// log store, not a transcript.
	maxTerminationMessageBytes = 512
	maxTerminationReasonBytes  = 128
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
	regexp.MustCompile(`(?i)\b(api[_-]?key|token|secret|password|authorization)(["']?\s*[:=]\s*["']?)[^\s"',}]{6,}`),
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

// prepareFinishedWorkerRelease runs immediately before this controller
// releases terminalOutcomeFinalizer on a worker Job. It gives the forensic
// record one more chance to land (the Pod cache can trail the Job's terminal
// event) and persists it, and only then lowers the in-memory Job's TTL from
// the build-time forensic hold to the outcome's configured TTL. The caller
// writes the Job. A Job that has not finished is left untouched.
func (r *PRReviewJobV1Alpha2Reconciler) prepareFinishedWorkerRelease(
	ctx context.Context,
	review *reviewv1alpha2.PRReviewJob,
	worker *batchv1.Job,
) error {
	if !workerJobFinished(worker) && worker.Status.Succeeded == 0 {
		return nil
	}
	recorded, err := r.observeWorkerTermination(ctx, review, worker, r.clock())
	if err != nil {
		return err
	}
	if recorded {
		if err := r.Status().Update(ctx, review); err != nil {
			return err
		}
	}
	ttl := job.WorkerFinishedTTLSeconds(worker.Status.Succeeded > 0)
	worker.Spec.TTLSecondsAfterFinished = &ttl
	return nil
}
