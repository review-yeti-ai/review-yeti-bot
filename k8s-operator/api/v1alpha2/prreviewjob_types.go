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

package v1alpha2

import (
	"errors"
	"fmt"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// PRReviewJobPhase is the bounded Kubernetes execution phase.
// +kubebuilder:validation:Enum=Queued;Running;Succeeded;Failed;Expired;Cancelled
type PRReviewJobPhase string

const (
	PhaseQueued    PRReviewJobPhase = "Queued"
	PhaseRunning   PRReviewJobPhase = "Running"
	PhaseSucceeded PRReviewJobPhase = "Succeeded"
	PhaseFailed    PRReviewJobPhase = "Failed"
	PhaseExpired   PRReviewJobPhase = "Expired"
	PhaseCancelled PRReviewJobPhase = "Cancelled"
)

// PRReviewJobSpec is an immutable, non-secret projection of an authenticated review run.
// The CRD schema rejects all fields not declared here and every spec update
// except the one-way cancelRequested transition (REL-1073).
// +kubebuilder:validation:XValidation:rule="self == oldSelf || (has(self.cancelRequested) && self.cancelRequested && !(has(oldSelf.cancelRequested) && oldSelf.cancelRequested))",message="PRReviewJob spec is immutable except for a one-way cancelRequested false-to-true transition"
// +kubebuilder:validation:XValidation:rule="self.runId == oldSelf.runId && self.deliveryId == oldSelf.deliveryId && self.repositoryId == oldSelf.repositoryId && self.repo == oldSelf.repo && self.prNumber == oldSelf.prNumber && self.headSha == oldSelf.headSha && self.baseSha == oldSelf.baseSha && self.receivedAt == oldSelf.receivedAt && self.terminalDeadline == oldSelf.terminalDeadline && self.policyDigest == oldSelf.policyDigest && self.configDigest == oldSelf.configDigest && self.publicationMode == oldSelf.publicationMode && self.workerImage == oldSelf.workerImage && self.runSecretName == oldSelf.runSecretName && has(self.executionAttempt) == has(oldSelf.executionAttempt) && (!has(self.executionAttempt) || self.executionAttempt == oldSelf.executionAttempt) && has(self.preparedReview) == has(oldSelf.preparedReview) && (!has(self.preparedReview) || self.preparedReview == oldSelf.preparedReview) && has(self.runnerMode) == has(oldSelf.runnerMode) && (!has(self.runnerMode) || self.runnerMode == oldSelf.runnerMode) && has(self.qualificationProfile) == has(oldSelf.qualificationProfile) && (!has(self.qualificationProfile) || self.qualificationProfile == oldSelf.qualificationProfile) && has(self.qualificationModel) == has(oldSelf.qualificationModel) && (!has(self.qualificationModel) || self.qualificationModel == oldSelf.qualificationModel)",message="PRReviewJob spec fields other than cancelRequested and cancelReason are immutable"
// +kubebuilder:validation:XValidation:rule="duration('900s') <= (timestamp(self.terminalDeadline) - timestamp(self.receivedAt)) && (timestamp(self.terminalDeadline) - timestamp(self.receivedAt)) <= duration('3600s')",message="terminalDeadline must be between 15 and 60 minutes after receivedAt"
// +kubebuilder:validation:XValidation:rule="(!has(self.qualificationProfile) && !has(self.qualificationModel)) || (self.qualificationProfile in ['full-panel', 'same-head'] && has(self.qualificationModel) && self.qualificationModel != 'auto' && self.qualificationModel != 'openrouter/auto')",message="qualificationProfile and qualificationModel must both be omitted for receipt-only workers or use an explicit qualification profile with a non-auto model"
// +kubebuilder:validation:XValidation:rule="!has(self.preparedReview) || (self.publicationMode == 'app-gate' && (!has(self.runnerMode) || self.runnerMode == 'prebaked'))",message="preparedReview requires the prebaked app-gate lane"
type PRReviewJobSpec struct {
	// +kubebuilder:validation:Pattern=`^run_[a-f0-9]{32}$`
	RunID string `json:"runId"`
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=512
	DeliveryID string `json:"deliveryId"`
	// ExecutionAttempt is the explicit execution identity for this run. It is
	// optional so the upgraded operator can continue processing CRs persisted by
	// older dispatchers, which recover the value from the validated Secret name.
	// +kubebuilder:validation:Minimum=1
	// +kubebuilder:validation:Maximum=2147483647
	// +optional
	ExecutionAttempt *int32 `json:"executionAttempt,omitempty"`
	// +kubebuilder:validation:Minimum=1
	RepositoryID int64 `json:"repositoryId"`
	// +kubebuilder:validation:Pattern=`^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?/[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$`
	Repo string `json:"repo"`
	// +kubebuilder:validation:Minimum=1
	PRNumber int32 `json:"prNumber"`
	// +kubebuilder:validation:Pattern=`^[a-f0-9]{40}$`
	HeadSHA string `json:"headSha"`
	// +kubebuilder:validation:Pattern=`^[a-f0-9]{40}$`
	BaseSHA          string      `json:"baseSha"`
	ReceivedAt       metav1.Time `json:"receivedAt"`
	TerminalDeadline metav1.Time `json:"terminalDeadline"`
	// +kubebuilder:validation:Pattern=`^[a-f0-9]{64}$`
	PolicyDigest string `json:"policyDigest"`
	// +kubebuilder:validation:Pattern=`^[a-f0-9]{64}$`
	ConfigDigest string `json:"configDigest"`
	// +kubebuilder:validation:Enum=disabled;app-gate
	PublicationMode string `json:"publicationMode"`
	// PreparedReview is an immutable, non-secret PreparedReviewExecution.v1 JSON
	// envelope containing config and transport. Presence opts into authoritative
	// result reporting in addition to the worker's existing raw review check.
	// The dispatcher and worker verify the config digest; the operator transports
	// the exact envelope without selecting providers or changing credentials.
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=262144
	// +optional
	PreparedReview *string `json:"preparedReview,omitempty"`
	// The real control here is DIGEST PINNING, not a registry allowlist.
//
// The previous pattern named exactly two registries. That is both too narrow
// and too weak, and the weakness is the more serious half:
//   too weak  — `ghcr.io/review-yeti-ai/<anything>:<anytag>` was permitted, so a
//               mutable tag on the vendor registry passed while a digest-pinned
//               image from any other registry was rejected. A tenant could not
//               pin from their own registry, and the vendor namespace allowed
//               tags. That inverts the control.
//   too narrow — it hardcoded two CallTelemetry-controlled registries, so a
//               self-hosted install could not pull from its own registry at
//               all. Self-hosting was impossible by construction.
//
// This accepts any registry, and requires every non-node image to be pinned to
// a sha256 digest. `node:<tag>` remains allowed because the generic-runner mode
// executes runtime install steps and is not the review worker.
// +kubebuilder:validation:Pattern=`^(?:[a-z0-9](?:[a-z0-9._/-]*[a-z0-9])?(?::[0-9]{1,5})?/[a-zA-Z0-9._/-]+@sha256:[a-f0-9]{64}|node:[a-zA-Z0-9_.-]+)$`
	WorkerImage string `json:"workerImage"`
	// RunnerMode defines whether the worker image is an immutable prebaked container
	// or a generic runner image that executes runtime install steps. Defaults to prebaked.
	// +kubebuilder:validation:Enum=prebaked;generic
	// +optional
	RunnerMode string `json:"runnerMode,omitempty"`
	// +kubebuilder:validation:Pattern=`^ct-review-run-[a-f0-9]{32}(-a[1-9][0-9]*)?$`
	RunSecretName string `json:"runSecretName"`
	// QualificationProfile is optional. An omitted profile preserves the
	// production-safe receipt-only worker contract. The only admitted
	// non-default profiles are the manual, non-publishing full-panel and
	// read-only same-head lanes.
	// +kubebuilder:validation:Enum=full-panel;same-head
	// +optional
	QualificationProfile string `json:"qualificationProfile,omitempty"`
	// QualificationModel is required by explicit qualification profiles and is
	// never accepted for the default receipt-only worker.
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=256
	// +optional
	QualificationModel string `json:"qualificationModel,omitempty"`
	// CancelRequested indicates that the review run was superseded or explicitly cancelled.
	// It is the only spec field that may change after creation, and only from
	// absent/false to true (REL-1073).
	// +optional
	CancelRequested *bool `json:"cancelRequested,omitempty"`
	// CancelReason records the reason why cancellation was requested. It may be
	// set only in the same update that sets cancelRequested to true.
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=256
	// +optional
	CancelReason *string `json:"cancelReason,omitempty"`
}

// DispatchTimingStage identifies one observable boundary in the receipt-only
// worker lifecycle. These values are deliberately bounded so status cannot
// become an unstructured event log.
// WorkerImagePattern is the single source of truth for the worker image
// contract. It is duplicated by necessity — the kubebuilder marker on
// PRReviewJobSpec.WorkerImage must be a compile-time literal so controller-gen
// can read it, and the chart freezes the generated CRD — but the RUNTIME
// validator in pkg/job must not carry its own copy.
//
// That runtime copy is the one with execution authority: a value the CRD admits
// but this pattern rejects fails at reconciliation, not admission, so a
// broadening that updates only the marker is silently ineffective. Review Yeti
// caught exactly that on the change that introduced digest pinning.
//
// If this pattern changes, update the kubebuilder marker below to match, and
// re-run `make generate`. TestWorkerImagePatternMatchesCRD fails otherwise.
const WorkerImagePattern = `^(?:[a-z0-9](?:[a-z0-9._/-]*[a-z0-9])?(?::[0-9]{1,5})?/[a-zA-Z0-9._/-]+@sha256:[a-f0-9]{64}|node:[a-zA-Z0-9_.-]+)$`

type DispatchTimingStage string

const (
	DispatchStageReceived       DispatchTimingStage = "received"
	DispatchStageJobCreated     DispatchTimingStage = "jobCreated"
	DispatchStagePodScheduled   DispatchTimingStage = "podScheduled"
	DispatchStageImageObserved  DispatchTimingStage = "imageObserved"
	DispatchStageProcessStarted DispatchTimingStage = "processStarted"
	DispatchStageCompleted      DispatchTimingStage = "completed"
)

// DispatchTimingStatus is a durable, bounded lifecycle receipt. It contains
// timestamps only; prompts, provider responses, credentials, and review
// contents must never be written to the CR status.
type DispatchTimingStatus struct {
	ReceivedAt       *metav1.Time `json:"receivedAt,omitempty"`
	JobCreatedAt     *metav1.Time `json:"jobCreatedAt,omitempty"`
	PodScheduledAt   *metav1.Time `json:"podScheduledAt,omitempty"`
	ImageObservedAt  *metav1.Time `json:"imageObservedAt,omitempty"`
	ProcessStartedAt *metav1.Time `json:"processStartedAt,omitempty"`
	CompletedAt      *metav1.Time `json:"completedAt,omitempty"`
}

// Observe records the first observation for a lifecycle stage. Repeated
// observations are idempotent and never replace the original timestamp.
// Every new observation is validated against the already-known stages.
func (t *DispatchTimingStatus) Observe(stage DispatchTimingStage, at metav1.Time) (bool, error) {
	if t == nil {
		return false, errors.New("nil dispatch timing status")
	}
	if at.Time.IsZero() {
		return false, errors.New("dispatch timing timestamp must be non-zero")
	}
	if !isKnownDispatchStage(stage) {
		return false, fmt.Errorf("unknown dispatch timing stage %q", stage)
	}
	if stage != DispatchStageReceived && t.ReceivedAt == nil {
		return false, errors.New("dispatch timing receipt must be observed before lifecycle stages")
	}
	if current := t.timestamp(stage); current != nil {
		return false, nil
	}

	copy := at.DeepCopy()
	switch stage {
	case DispatchStageReceived:
		t.ReceivedAt = copy
	case DispatchStageJobCreated:
		t.JobCreatedAt = copy
	case DispatchStagePodScheduled:
		t.PodScheduledAt = copy
	case DispatchStageImageObserved:
		t.ImageObservedAt = copy
	case DispatchStageProcessStarted:
		t.ProcessStartedAt = copy
	case DispatchStageCompleted:
		t.CompletedAt = copy
	}
	if err := t.Validate(); err != nil {
		// Keep the status unchanged when a malformed or backward observation is
		// presented. This is a fail-closed API boundary.
		switch stage {
		case DispatchStageReceived:
			t.ReceivedAt = nil
		case DispatchStageJobCreated:
			t.JobCreatedAt = nil
		case DispatchStagePodScheduled:
			t.PodScheduledAt = nil
		case DispatchStageImageObserved:
			t.ImageObservedAt = nil
		case DispatchStageProcessStarted:
			t.ProcessStartedAt = nil
		case DispatchStageCompleted:
			t.CompletedAt = nil
		}
		return false, err
	}
	return true, nil
}

// Validate rejects zero timestamps and any backward lifecycle transition.
func (t *DispatchTimingStatus) Validate() error {
	if t == nil {
		return errors.New("nil dispatch timing status")
	}
	ordered := []struct {
		name string
		at   *metav1.Time
	}{
		{"receivedAt", t.ReceivedAt},
		{"jobCreatedAt", t.JobCreatedAt},
		{"podScheduledAt", t.PodScheduledAt},
		{"imageObservedAt", t.ImageObservedAt},
		{"processStartedAt", t.ProcessStartedAt},
		{"completedAt", t.CompletedAt},
	}
	var previous *metav1.Time
	previousName := ""
	for _, stage := range ordered {
		if stage.at == nil {
			continue
		}
		if stage.at.Time.IsZero() {
			return fmt.Errorf("%s timestamp must be non-zero", stage.name)
		}
		if previous != nil && stage.at.Before(previous) {
			return fmt.Errorf("%s precedes %s", stage.name, previousName)
		}
		previous = stage.at
		previousName = stage.name
	}
	return nil
}

func (t *DispatchTimingStatus) timestamp(stage DispatchTimingStage) *metav1.Time {
	switch stage {
	case DispatchStageReceived:
		return t.ReceivedAt
	case DispatchStageJobCreated:
		return t.JobCreatedAt
	case DispatchStagePodScheduled:
		return t.PodScheduledAt
	case DispatchStageImageObserved:
		return t.ImageObservedAt
	case DispatchStageProcessStarted:
		return t.ProcessStartedAt
	case DispatchStageCompleted:
		return t.CompletedAt
	default:
		return nil
	}
}

func isKnownDispatchStage(stage DispatchTimingStage) bool {
	return stage == DispatchStageReceived || stage == DispatchStageJobCreated || stage == DispatchStagePodScheduled || stage == DispatchStageImageObserved || stage == DispatchStageProcessStarted || stage == DispatchStageCompleted
}

// WorkerTerminationStatus is the bounded forensic record of how the worker Pod
// ended, copied from the Pod before the operator lets its worker Job's
// ttlSecondsAfterFinished collect it. It lets the PRReviewJob, not the
// short-lived Pod, answer "why did this worker die" (exit code, OOMKilled,
// DeadlineExceeded, Evicted, last error line), so a failed worker no longer has
// to be retained for inspection. It is written once and never replaced.
//
// Message is the last non-empty line of the container's termination message
// (the worker's own /dev/termination-log, or, because the worker container uses
// FallbackToLogsOnError, the tail of its log on failure). The operator redacts
// credential-shaped tokens and truncates it; it is a pointer into the full log
// in the log store, never a transcript.
type WorkerTerminationStatus struct {
	// +kubebuilder:validation:MaxLength=253
	PodName string `json:"podName"`
	// +kubebuilder:validation:MaxLength=253
	// +optional
	NodeName string `json:"nodeName,omitempty"`
	// +kubebuilder:validation:MaxLength=63
	// +optional
	ContainerName string `json:"containerName,omitempty"`
	// ExitCode is absent when the Pod ended before its container ever ran
	// (for example an eviction or a deadline hit while the image was pulling).
	// +optional
	ExitCode *int32 `json:"exitCode,omitempty"`
	// +optional
	Signal *int32 `json:"signal,omitempty"`
	// Reason is the container termination reason (Completed, Error, OOMKilled,
	// ContainerCannotRun, ...).
	// +kubebuilder:validation:MaxLength=128
	// +optional
	Reason string `json:"reason,omitempty"`
	// +kubebuilder:validation:MaxLength=1024
	// +optional
	Message string `json:"message,omitempty"`
	// PodReason is the Pod-level reason (Evicted, DeadlineExceeded, ...).
	// +kubebuilder:validation:MaxLength=128
	// +optional
	PodReason string `json:"podReason,omitempty"`
	// +optional
	StartedAt *metav1.Time `json:"startedAt,omitempty"`
	// +optional
	FinishedAt *metav1.Time `json:"finishedAt,omitempty"`
	ObservedAt metav1.Time  `json:"observedAt"`
}

// PRReviewJobStatus contains execution references and a bounded timing receipt;
// PostgreSQL remains lifecycle authority.
type PRReviewJobStatus struct {
	Phase              PRReviewJobPhase      `json:"phase,omitempty"`
	ObservedGeneration int64                 `json:"observedGeneration,omitempty"`
	JobName            string                `json:"jobName,omitempty"`
	PVCName            string                `json:"pvcName,omitempty"`
	LeaseName          string                `json:"leaseName,omitempty"`
	StartTime          *metav1.Time          `json:"startTime,omitempty"`
	CompletionTime     *metav1.Time          `json:"completionTime,omitempty"`
	CancelRequestedAt  *metav1.Time          `json:"cancelRequestedAt,omitempty"`
	CancelObservedAt   *metav1.Time          `json:"cancelObservedAt,omitempty"`
	Timing             *DispatchTimingStatus `json:"timing,omitempty"`
	// WorkerTermination is the forensic record of the worker Pod's exit,
	// captured before the worker Job's TTL is allowed to collect the Pod.
	// +optional
	WorkerTermination *WorkerTerminationStatus `json:"workerTermination,omitempty"`
	Message           string                   `json:"message,omitempty"`
	Conditions        []metav1.Condition       `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:path=prreviewjobs,scope=Namespaced,shortName=prj
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase`
// +kubebuilder:printcolumn:name="Repo",type=string,JSONPath=`.spec.repo`
// +kubebuilder:printcolumn:name="PR",type=integer,JSONPath=`.spec.prNumber`
// +kubebuilder:printcolumn:name="Deadline",type=date,JSONPath=`.spec.terminalDeadline`
type PRReviewJob struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   PRReviewJobSpec   `json:"spec"`
	Status PRReviewJobStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true
type PRReviewJobList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []PRReviewJob `json:"items"`
}
