/*
Copyright 2026 exampleorg.

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
	"regexp"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// Well-known condition types for PRReviewJob status.
const (
	// ConditionFencingEpochMismatch indicates that spec.fencingEpoch does not
	// match or has been superseded by the authoritative mission fencing epoch.
	// This condition triggers fail-closed reconciliation.
	ConditionFencingEpochMismatch = "FencingEpochMismatch"

	// ConditionStaleWorkerLease indicates that spec.workerLeaseToken does not
	// match the active fencing token of the coordination Lease, indicating
	// the worker was superseded or evicted. Triggers fail-closed reconciliation.
	ConditionStaleWorkerLease = "StaleWorkerLease"

	// ConditionUnknownEffectPending indicates that an external side effect is in
	// an UNKNOWN state, preventing the job from transitioning to Succeeded.
	ConditionUnknownEffectPending = "UnknownEffectPending"
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
// +kubebuilder:validation:XValidation:rule="self.runId == oldSelf.runId && self.deliveryId == oldSelf.deliveryId && self.repositoryId == oldSelf.repositoryId && self.repo == oldSelf.repo && self.prNumber == oldSelf.prNumber && self.headSha == oldSelf.headSha && self.baseSha == oldSelf.baseSha && self.receivedAt == oldSelf.receivedAt && self.terminalDeadline == oldSelf.terminalDeadline && self.policyDigest == oldSelf.policyDigest && self.configDigest == oldSelf.configDigest && self.publicationMode == oldSelf.publicationMode && self.workerImage == oldSelf.workerImage && self.runSecretName == oldSelf.runSecretName && has(self.executionAttempt) == has(oldSelf.executionAttempt) && (!has(self.executionAttempt) || self.executionAttempt == oldSelf.executionAttempt) && has(self.preparedReview) == has(oldSelf.preparedReview) && (!has(self.preparedReview) || self.preparedReview == oldSelf.preparedReview) && has(self.runnerMode) == has(oldSelf.runnerMode) && (!has(self.runnerMode) || self.runnerMode == oldSelf.runnerMode) && has(self.qualificationProfile) == has(oldSelf.qualificationProfile) && (!has(self.qualificationProfile) || self.qualificationProfile == oldSelf.qualificationProfile) && has(self.qualificationModel) == has(oldSelf.qualificationModel) && (!has(self.qualificationModel) || self.qualificationModel == oldSelf.qualificationModel) && has(self.logicalChildId) == has(oldSelf.logicalChildId) && (!has(self.logicalChildId) || self.logicalChildId == oldSelf.logicalChildId) && has(self.fencingEpoch) == has(oldSelf.fencingEpoch) && (!has(self.fencingEpoch) || self.fencingEpoch == oldSelf.fencingEpoch) && has(self.workerLeaseToken) == has(oldSelf.workerLeaseToken) && (!has(self.workerLeaseToken) || self.workerLeaseToken == oldSelf.workerLeaseToken)",message="PRReviewJob spec fields other than cancelRequested and cancelReason are immutable"
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
	//   too narrow — it hardcoded two exampleorg-controlled registries, so a
	//               self-hosted install could not pull from its own registry at
	//               all. Self-hosting was impossible by construction.
	//
	// This accepts any registry, and requires every non-node image to be pinned to
	// a sha256 digest. `node:<tag>` remains allowed because the generic-runner mode
	// executes runtime install steps and is not the review worker.
	// TRUST ASSUMPTION, load-bearing: this constrains INTEGRITY (an image
	// reference is immutable), not PROVENANCE (who published it). Any registry is
	// accepted, so whoever can create or patch a PRReviewJob chooses the code the
	// worker executes. Correct for a self-hosted install where the submitter owns
	// the cluster; NOT sufficient for a multi-tenant deployment where a
	// less-trusted principal can write these resources. Multi-tenant installs
	// MUST restrict PRReviewJob create/patch via RBAC and SHOULD add publisher
	// verification or an admission-time registry policy.
	// Bounded like its siblings: the pattern's host group and its optional path
	// group both match '/' and '-', so a long adversarial reference makes the
	// matcher backtrack quadratically (measured: 25 KB -> ~240 ms, and the
	// operator validates on every reconcile). A real image reference is far below
	// this, so the bound costs nothing legitimate and removes the blowup.
	// +kubebuilder:validation:MaxLength=512
	// +kubebuilder:validation:Pattern=`^(?:[a-z0-9](?:[a-z0-9._/-]*[a-z0-9])?(?::[0-9]{1,5})?(?:/[a-zA-Z0-9._/-]+)?@sha256:[a-f0-9]{64}|node:[a-zA-Z0-9_.-]+@sha256:[a-f0-9]{64}|node:[a-zA-Z0-9_.-]+)$`
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
	// LogicalChildID identifies the logical child execution within the mission.
	// Must conform to RFC 1123 / ID pattern (1 to 128 alphanumeric characters, dots, dashes, underscores, starting with alphanumeric).
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=128
	// +kubebuilder:validation:Pattern=`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`
	// +optional
	LogicalChildID string `json:"logicalChildId,omitempty"`
	// FencingEpoch is the authoritative mission fencing epoch boundary.
	// Must be a positive integer >= 1.
	// +kubebuilder:validation:Minimum=1
	// +kubebuilder:validation:Maximum=9007199254740991
	// +optional
	FencingEpoch int64 `json:"fencingEpoch,omitempty"`
	// WorkerLeaseToken is the expected fencing token for the active worker lease.
	// Stale tokens trigger fail-closed reconciliation.
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=128
	// +kubebuilder:validation:Pattern=`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`
	// +optional
	WorkerLeaseToken string `json:"workerLeaseToken,omitempty"`
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

type DispatchTimingStage string

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
//
// TRUST ASSUMPTION, and it is load-bearing. This pattern constrains INTEGRITY
// (an image reference is immutable) but NOT PROVENANCE (who published it). Any
// registry is accepted, so whoever can create or patch a PRReviewJob chooses
// the code the worker executes.
//
// That is correct and intended for a self-hosted install, where the submitter
// owns the cluster. It is NOT sufficient for a multi-tenant deployment in which
// a less-trusted principal can write these resources: such a principal could
// direct the worker pod to run their own image with the per-run Secret and the
// pod's identity. Multi-tenant installs MUST therefore restrict PRReviewJob
// create/patch via RBAC (today only the control-plane dispatcher creates them)
// and SHOULD add publisher verification (for example cosign identity bound to
// the vendor) or an admission-time registry policy.
//
// The previous pattern carried a weaker version of this restriction by naming
// two vendor registries. Removing that was necessary for self-hosting, and it
// moved the provenance decision from the schema to the deployment — which is
// why it is written down here rather than left implicit.
const WorkerImagePattern = `^(?:[a-z0-9](?:[a-z0-9._/-]*[a-z0-9])?(?::[0-9]{1,5})?(?:/[a-zA-Z0-9._/-]+)?@sha256:[a-f0-9]{64}|node:[a-zA-Z0-9_.-]+@sha256:[a-f0-9]{64}|node:[a-zA-Z0-9_.-]+)$`

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
	// AuthoritativeFencingEpoch records the authoritative mission fencing epoch
	// recognized by the operator.
	// +kubebuilder:validation:Minimum=1
	// +kubebuilder:validation:Maximum=9007199254740991
	// +optional
	AuthoritativeFencingEpoch int64 `json:"authoritativeFencingEpoch,omitempty"`
	// ActiveWorkerLeaseToken records the active fencing token bound to the worker's coordination Lease.
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=128
	// +kubebuilder:validation:Pattern=`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`
	// +optional
	ActiveWorkerLeaseToken string `json:"activeWorkerLeaseToken,omitempty"`
	// ReceiptDigest records the sha256 digest of the canonical JSON execution receipt (ct-agent-execution-receipt.v1).
	// +kubebuilder:validation:Pattern=`^sha256:[a-f0-9]{64}$`
	// +kubebuilder:validation:MaxLength=71
	// +optional
	ReceiptDigest string `json:"receiptDigest,omitempty"`
	// ReceiptEvidenceRef records the URI or digest of the stored evidence bundle containing the execution receipt artifacts.
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=512
	// +optional
	ReceiptEvidenceRef string `json:"receiptEvidenceRef,omitempty"`
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

var (
	logicalChildIDPattern   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)
	workerLeaseTokenPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)
	receiptDigestPattern    = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
)

// ValidateFencing verifies that fencing identity fields comply with schema bounds.
func (s *PRReviewJobSpec) ValidateFencing() error {
	if s == nil {
		return errors.New("nil PRReviewJobSpec")
	}
	if s.LogicalChildID != "" {
		if len(s.LogicalChildID) > 128 {
			return fmt.Errorf("logicalChildId length %d exceeds max 128", len(s.LogicalChildID))
		}
		if !logicalChildIDPattern.MatchString(s.LogicalChildID) {
			return fmt.Errorf("logicalChildId %q does not match RFC 1123 / ID pattern", s.LogicalChildID)
		}
	}
	if s.FencingEpoch != 0 {
		if s.FencingEpoch < 1 {
			return fmt.Errorf("fencingEpoch must be >= 1, got %d", s.FencingEpoch)
		}
		if s.FencingEpoch > 9007199254740991 {
			return fmt.Errorf("fencingEpoch %d exceeds maximum safe integer", s.FencingEpoch)
		}
	}
	if s.WorkerLeaseToken != "" {
		if len(s.WorkerLeaseToken) > 128 {
			return fmt.Errorf("workerLeaseToken length %d exceeds max 128", len(s.WorkerLeaseToken))
		}
		if !workerLeaseTokenPattern.MatchString(s.WorkerLeaseToken) {
			return fmt.Errorf("workerLeaseToken %q does not match token pattern", s.WorkerLeaseToken)
		}
	}
	return nil
}

// HasFencingEpochMismatch checks if ConditionFencingEpochMismatch is True.
func (s *PRReviewJobStatus) HasFencingEpochMismatch() bool {
	if s == nil {
		return false
	}
	for _, c := range s.Conditions {
		if c.Type == ConditionFencingEpochMismatch && c.Status == metav1.ConditionTrue {
			return true
		}
	}
	return false
}

// HasStaleWorkerLease checks if ConditionStaleWorkerLease is True.
func (s *PRReviewJobStatus) HasStaleWorkerLease() bool {
	if s == nil {
		return false
	}
	for _, c := range s.Conditions {
		if c.Type == ConditionStaleWorkerLease && c.Status == metav1.ConditionTrue {
			return true
		}
	}
	return false
}

// HasUnknownEffectPending checks if ConditionUnknownEffectPending is True.
func (s *PRReviewJobStatus) HasUnknownEffectPending() bool {
	if s == nil {
		return false
	}
	for _, c := range s.Conditions {
		if c.Type == ConditionUnknownEffectPending && c.Status == metav1.ConditionTrue {
			return true
		}
	}
	return false
}

// ReceiptIsAuditable returns true if execution receipt references are committed.
func (s *PRReviewJobStatus) ReceiptIsAuditable() bool {
	if s == nil {
		return false
	}
	return s.ReceiptDigest != "" || s.ReceiptEvidenceRef != "" || s.WorkerTermination != nil
}
