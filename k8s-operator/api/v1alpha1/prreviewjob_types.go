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

package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// PRReviewJobPhase represents the current phase of a PRReviewJob execution.
// +kubebuilder:validation:Enum=Queued;Running;Succeeded;Failed
type PRReviewJobPhase string

const (
	// PRReviewJobPhaseQueued indicates the job is waiting in the concurrency queue.
	PRReviewJobPhaseQueued PRReviewJobPhase = "Queued"

	// PRReviewJobPhaseRunning indicates the job and worker pods are currently executing.
	PRReviewJobPhaseRunning PRReviewJobPhase = "Running"

	// PRReviewJobPhaseSucceeded indicates the review job completed successfully.
	PRReviewJobPhaseSucceeded PRReviewJobPhase = "Succeeded"

	// PRReviewJobPhaseFailed indicates the review job encountered an error or failed.
	PRReviewJobPhaseFailed PRReviewJobPhase = "Failed"

	// Convenient aliases matching phase constants
	PhaseQueued    = PRReviewJobPhaseQueued
	PhaseRunning   = PRReviewJobPhaseRunning
	PhaseSucceeded = PRReviewJobPhaseSucceeded
	PhaseFailed    = PRReviewJobPhaseFailed
)

const (
	// Review verdict constants
	VerdictApproved         = "APPROVED"
	VerdictChangesRequested = "CHANGES_REQUESTED"
	VerdictComment          = "COMMENT"
	VerdictFailed           = "FAILED"
)

// PersonaProgress tracks progress state for an individual review persona.
type PersonaProgress struct {
	// Persona is the name of the review persona (e.g., "security", "performance", "qa").
	// +kubebuilder:validation:Required
	Persona string `json:"persona"`

	// Status is the current status of the persona review (e.g. "Pending", "Running", "Completed", "Failed").
	// +kubebuilder:validation:Required
	Status string `json:"status"`

	// Message contains optional progress details or error output.
	// +optional
	Message string `json:"message,omitempty"`

	// FinishedAt records when the persona completed its review.
	// +optional
	FinishedAt *metav1.Time `json:"finishedAt,omitempty"`
}

// PRReviewJobSpec defines the desired state of PRReviewJob
type PRReviewJobSpec struct {
	// Repo specifies the GitHub target repository (e.g. "owner/repo").
	// +kubebuilder:validation:Required
	// +kubebuilder:validation:Pattern=`^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$`
	Repo string `json:"repo"`

	// PRNumber is the pull request number to review.
	// +kubebuilder:validation:Required
	// +kubebuilder:validation:Minimum=1
	PRNumber int32 `json:"prNumber"`

	// HeadSHA is the git commit SHA for the head of the pull request.
	// +kubebuilder:validation:Required
	// +kubebuilder:validation:MinLength=7
	HeadSHA string `json:"headSha"`

	// BaseSHA is the git commit SHA for the base target branch of the pull request.
	// +kubebuilder:validation:Required
	// +kubebuilder:validation:MinLength=7
	BaseSHA string `json:"baseSha"`

	// PersonaRoster defines the list of persona reviewers to run (e.g. ["security", "performance", "code_style"]).
	// +kubebuilder:validation:Required
	// +kubebuilder:validation:MinItems=1
	PersonaRoster []string `json:"personaRoster"`

	// PVCStorageSize specifies the storage capacity requested for the job's ephemeral PVC.
	// Defaults to "1Gi".
	// +kubebuilder:default="1Gi"
	// +optional
	PVCStorageSize string `json:"pvcStorageSize,omitempty"`

	// TTLSecondsAfterFinished defines the duration (in seconds) to retain the job, pods, and PVC after completion before garbage collection.
	// Defaults to 1800 (30 minutes).
	// +kubebuilder:default=1800
	// +kubebuilder:validation:Minimum=0
	// +optional
	TTLSecondsAfterFinished *int32 `json:"ttlSecondsAfterFinished,omitempty"`
}

// PRReviewJobStatus defines the observed state of PRReviewJob
type PRReviewJobStatus struct {
	// Phase is the current execution phase of the PR review job.
	// +kubebuilder:validation:Enum=Queued;Running;Succeeded;Failed
	// +kubebuilder:default="Queued"
	// +optional
	Phase PRReviewJobPhase `json:"phase,omitempty"`

	// Verdict is the overall review outcome (e.g., "APPROVED", "CHANGES_REQUESTED", "COMMENT").
	// +optional
	Verdict string `json:"verdict,omitempty"`

	// PersonaProgress records the detailed progress state per persona.
	// +optional
	PersonaProgress []PersonaProgress `json:"personaProgress,omitempty"`

	// PersonaProgressMap records the progress state per persona as key-value map.
	// +optional
	PersonaProgressMap map[string]string `json:"personaProgressMap,omitempty"`

	// JobName is the name of the Kubernetes batch/v1 Job created to run this review task.
	// +optional
	JobName string `json:"jobName,omitempty"`

	// PVCName is the name of the PersistentVolumeClaim created for workspace storage.
	// +optional
	PVCName string `json:"pvcName,omitempty"`

	// StartTime records when the review job started execution (transitioned to Running).
	// +optional
	StartTime *metav1.Time `json:"startTime,omitempty"`

	// CompletionTime records when the review job finished execution (transitioned to Succeeded or Failed).
	// +optional
	CompletionTime *metav1.Time `json:"completionTime,omitempty"`

	// Message provides human-readable context regarding current phase or execution errors.
	// +optional
	Message string `json:"message,omitempty"`

	// Conditions represents the standard Kubernetes condition history for this custom resource.
	// +optional
	// +listType=map
	// +listMapKey=type
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// SetDefaults populates unconfigured optional fields with default values.
func (j *PRReviewJob) SetDefaults() {
	if j == nil {
		return
	}
	if j.Spec.PVCStorageSize == "" {
		j.Spec.PVCStorageSize = "1Gi"
	}
	if j.Spec.TTLSecondsAfterFinished == nil {
		ttl := int32(1800)
		j.Spec.TTLSecondsAfterFinished = &ttl
	}
	if j.Status.Phase == "" {
		j.Status.Phase = PRReviewJobPhaseQueued
	}
}

// GetPVCStorageSize returns the PVC storage size or the default "1Gi" if unset or receiver is nil.
func (j *PRReviewJob) GetPVCStorageSize() string {
	if j == nil {
		return "1Gi"
	}
	return j.Spec.GetPVCStorageSize()
}

// GetTTLSeconds returns the TTL in seconds or the default 1800 if unset or receiver is nil.
func (j *PRReviewJob) GetTTLSeconds() int32 {
	if j == nil {
		return 1800
	}
	return j.Spec.GetTTLSeconds()
}

// GetPVCStorageSize returns the PVC storage size or the default "1Gi" if unset or receiver is nil.
func (s *PRReviewJobSpec) GetPVCStorageSize() string {
	if s == nil || s.PVCStorageSize == "" {
		return "1Gi"
	}
	return s.PVCStorageSize
}

// GetTTLSeconds returns the TTL in seconds or the default 1800 if unset or receiver is nil.
func (s *PRReviewJobSpec) GetTTLSeconds() int32 {
	if s == nil || s.TTLSecondsAfterFinished == nil {
		return 1800
	}
	if *s.TTLSecondsAfterFinished < 0 {
		return 0
	}
	return *s.TTLSecondsAfterFinished
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:path=prreviewjobs,singular=prreviewjob,shortName=prj;prreview,scope=Namespaced
// +kubebuilder:printcolumn:name="Phase",type="string",JSONPath=".status.phase",description="Job execution phase"
// +kubebuilder:printcolumn:name="Repo",type="string",JSONPath=".spec.repo",description="Target repository"
// +kubebuilder:printcolumn:name="PR",type="integer",JSONPath=".spec.prNumber",description="Target PR Number"
// +kubebuilder:printcolumn:name="Verdict",type="string",JSONPath=".status.verdict",description="Review Verdict"
// +kubebuilder:printcolumn:name="Age",type="date",JSONPath=".metadata.creationTimestamp"

// PRReviewJob is the Schema for the prreviewjobs API
type PRReviewJob struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   PRReviewJobSpec   `json:"spec,omitempty"`
	Status PRReviewJobStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// PRReviewJobList contains a list of PRReviewJob
type PRReviewJobList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []PRReviewJob `json:"items"`
}
