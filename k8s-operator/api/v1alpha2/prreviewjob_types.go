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
// +kubebuilder:validation:Enum=Queued;Running;Succeeded;Failed;Expired
type PRReviewJobPhase string

const (
	PhaseQueued    PRReviewJobPhase = "Queued"
	PhaseRunning   PRReviewJobPhase = "Running"
	PhaseSucceeded PRReviewJobPhase = "Succeeded"
	PhaseFailed    PRReviewJobPhase = "Failed"
	PhaseExpired   PRReviewJobPhase = "Expired"
)

// PRReviewJobSpec is an immutable, non-secret projection of an authenticated review run.
// The CRD schema rejects updates and all fields not declared here.
// +kubebuilder:validation:XValidation:rule="self == oldSelf",message="PRReviewJob spec is immutable"
// +kubebuilder:validation:XValidation:rule="timestamp(self.terminalDeadline) - timestamp(self.receivedAt) == duration('900s')",message="terminalDeadline must be exactly 15 minutes after receivedAt"
type PRReviewJobSpec struct {
	// +kubebuilder:validation:Pattern=`^run_[a-f0-9]{32}$`
	RunID string `json:"runId"`
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=512
	DeliveryID string `json:"deliveryId"`
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
	// +kubebuilder:validation:Pattern=`^(?:(?:ghcr\.io/review-yeti-ai/review-yeti-worker|registry\.digitalocean\.com/calltelemetry/review-yeti-worker)@sha256:[a-f0-9]{64}|node:[a-zA-Z0-9_.-]+|ghcr\.io/review-yeti-ai/[a-zA-Z0-9_.-]+:[a-zA-Z0-9_.-]+)$`
	WorkerImage string `json:"workerImage"`
	// RunnerMode defines whether the worker image is an immutable prebaked container
	// or a generic runner image that executes runtime install steps. Defaults to prebaked.
	// +kubebuilder:validation:Enum=prebaked;generic
	// +optional
	RunnerMode string `json:"runnerMode,omitempty"`
	// +kubebuilder:validation:Pattern=`^ct-review-run-[a-f0-9]{32}$`
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
}

// DispatchTimingStage identifies one observable boundary in the receipt-only
// worker lifecycle. These values are deliberately bounded so status cannot
// become an unstructured event log.
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
	Timing             *DispatchTimingStatus `json:"timing,omitempty"`
	Message            string                `json:"message,omitempty"`
	Conditions         []metav1.Condition    `json:"conditions,omitempty"`
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
