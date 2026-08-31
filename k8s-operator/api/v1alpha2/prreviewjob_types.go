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

import metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

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
	// +kubebuilder:validation:Enum=disabled
	PublicationMode string `json:"publicationMode"`
	// +kubebuilder:validation:Pattern=`^registry\.digitalocean\.com/calltelemetry/review-yeti-worker@sha256:[a-f0-9]{64}$`
	WorkerImage string `json:"workerImage"`
	// +kubebuilder:validation:Pattern=`^ct-review-run-[a-f0-9]{32}$`
	RunSecretName string `json:"runSecretName"`
}

// PRReviewJobStatus contains execution references only; PostgreSQL remains lifecycle authority.
type PRReviewJobStatus struct {
	Phase              PRReviewJobPhase   `json:"phase,omitempty"`
	ObservedGeneration int64              `json:"observedGeneration,omitempty"`
	JobName            string             `json:"jobName,omitempty"`
	PVCName            string             `json:"pvcName,omitempty"`
	LeaseName          string             `json:"leaseName,omitempty"`
	StartTime          *metav1.Time       `json:"startTime,omitempty"`
	CompletionTime     *metav1.Time       `json:"completionTime,omitempty"`
	Message            string             `json:"message,omitempty"`
	Conditions         []metav1.Condition `json:"conditions,omitempty"`
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
