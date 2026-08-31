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

// Package job builds the receipt-only v1alpha2 worker contract.  It is pure:
// callers must acquire the workspace Lease and create the returned Job
// themselves, which keeps ordering and API errors observable to the controller.
package job

import (
	"errors"
	"math"
	"regexp"
	"strconv"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/validation"

	v1alpha2 "github.com/calltelemetry/ct-review-bot/k8s-operator/api/v1alpha2"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/workspace"
)

const (
	Namespace                  = "ct-review-system"
	ReceiptOnlyEnv             = "REVIEW_RECEIPT_ONLY"
	PublicationModeEnv         = "REVIEW_PUBLICATION_MODE"
	ReceiptPathEnv             = "REVIEW_RECEIPT_PATH"
	ReceiptPath                = "/workspace/.review-yeti/receipt.json"
	ReceiptOnlyWorkerComponent = "receipt-only-worker"
	// Jobs are disposable execution records. The reusable PR workspace has a
	// separate, exact 1,800-second idle reclamation policy.
	JobTTLSeconds = int32(300)
	// Keep a one-minute publication/failure-conclusion reserve inside the
	// original 15-minute run deadline. The worker itself may never consume the
	// full admission window.
	MaxActiveDeadlineSeconds = int64(840)
	DeadlineReserveSeconds   = int64(60)
	MinRemainingSeconds      = int64(120)
)

var (
	ErrJobConfiguration = errors.New("receipt-only Job configuration mismatch")
	ErrJobDeadline      = errors.New("receipt-only Job deadline is invalid")

	runIDPattern       = regexp.MustCompile(`^run_[a-f0-9]{32}$`)
	repoPattern        = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?/[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$`)
	shaPattern         = regexp.MustCompile(`^[a-f0-9]{40}$`)
	digestPattern      = regexp.MustCompile(`^[a-f0-9]{64}$`)
	workerImagePattern = regexp.MustCompile(`^registry\.digitalocean\.com/calltelemetry/review-yeti-worker@sha256:[a-f0-9]{64}$`)
	secretNamePattern  = regexp.MustCompile(`^ct-review-run-[a-f0-9]{32}$`)
)

// Input is the immutable review projection plus fresh workspace ownership
// evidence.  No Secret object or credential is accepted by this builder.
type Input struct {
	Review           *v1alpha2.PRReviewJob
	WorkspacePVCName string
	WorkspaceLease   workspace.LeaseAcquireResult
	Now              time.Time
}

// BuildWorkerJob builds one non-retrying, receipt-only worker Job. It refuses
// to build unless the review is still inside its original 15-minute terminal
// window and the caller proves a currently-held PR workspace Lease.
func BuildWorkerJob(input Input) (*batchv1.Job, error) {
	if err := validateInput(input); err != nil {
		return nil, err
	}
	review := input.Review
	spec := review.Spec
	activeDeadlineSeconds, err := remainingDeadlineSeconds(spec.TerminalDeadline.Time, input.Now)
	if err != nil {
		return nil, err
	}
	labels, annotations := workspace.Metadata(spec.RepositoryID, spec.PRNumber)
	labels["review-yeti.ai/component"] = ReceiptOnlyWorkerComponent
	labels["review-yeti.ai/run-id"] = spec.RunID
	labels["review-yeti.ai/publication-mode"] = spec.PublicationMode
	annotations["review-yeti.ai/run-id"] = spec.RunID

	templateLabels := copyStringMap(labels)
	templateAnnotations := copyStringMap(annotations)
	one := int32(1)
	zero := int32(0)
	ttl := JobTTLSeconds
	active := activeDeadlineSeconds
	automountToken := false
	allowPrivilegeEscalation := false
	readOnlyRootFilesystem := true
	runAsNonRoot := true
	runAsUser := int64(1000)
	runAsGroup := int64(1000)
	fsGroup := int64(1000)
	fsGroupChangePolicy := corev1.FSGroupChangeOnRootMismatch
	container := corev1.Container{
		Name:            "reviewer-worker",
		Image:           spec.WorkerImage,
		ImagePullPolicy: corev1.PullIfNotPresent,
		Resources: corev1.ResourceRequirements{
			Requests: corev1.ResourceList{
				corev1.ResourceCPU:    resource.MustParse("500m"),
				corev1.ResourceMemory: resource.MustParse("768Mi"),
			},
			Limits: corev1.ResourceList{
				corev1.ResourceCPU:    resource.MustParse("1"),
				corev1.ResourceMemory: resource.MustParse("1536Mi"),
			},
		},
		SecurityContext: &corev1.SecurityContext{
			AllowPrivilegeEscalation: &allowPrivilegeEscalation,
			Capabilities:             &corev1.Capabilities{Drop: []corev1.Capability{corev1.Capability("ALL")}},
			ReadOnlyRootFilesystem:   &readOnlyRootFilesystem,
			RunAsNonRoot:             &runAsNonRoot,
			RunAsUser:                &runAsUser,
			RunAsGroup:               &runAsGroup,
		},
		Env: []corev1.EnvVar{
			{Name: "REVIEW_RUN_ID", Value: spec.RunID},
			{Name: "REVIEW_DELIVERY_ID", Value: spec.DeliveryID},
			{Name: "REVIEW_REPOSITORY_ID", Value: strconv.FormatInt(spec.RepositoryID, 10)},
			{Name: "REVIEW_REPO", Value: spec.Repo},
			{Name: "REVIEW_PR_NUMBER", Value: strconv.Itoa(int(spec.PRNumber))},
			{Name: "REVIEW_HEAD_SHA", Value: spec.HeadSHA},
			{Name: "REVIEW_BASE_SHA", Value: spec.BaseSHA},
			{Name: "REVIEW_POLICY_DIGEST", Value: spec.PolicyDigest},
			{Name: "REVIEW_CONFIG_DIGEST", Value: spec.ConfigDigest},
			{Name: PublicationModeEnv, Value: spec.PublicationMode},
			{Name: ReceiptOnlyEnv, Value: "true"},
			{Name: ReceiptPathEnv, Value: ReceiptPath},
		},
		VolumeMounts: []corev1.VolumeMount{
			{Name: "workspace", MountPath: "/workspace"},
			{Name: "tmp", MountPath: "/tmp"},
		},
	}
	return &batchv1.Job{
		TypeMeta: metav1.TypeMeta{APIVersion: batchv1.SchemeGroupVersion.String(), Kind: "Job"},
		ObjectMeta: metav1.ObjectMeta{
			Name:        review.Name + "-worker",
			Namespace:   review.Namespace,
			Labels:      labels,
			Annotations: annotations,
		},
		Spec: batchv1.JobSpec{
			Completions:             &one,
			Parallelism:             &one,
			BackoffLimit:            &zero,
			ActiveDeadlineSeconds:   &active,
			TTLSecondsAfterFinished: &ttl,
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: templateLabels, Annotations: templateAnnotations},
				Spec: corev1.PodSpec{
					RestartPolicy:                corev1.RestartPolicyNever,
					AutomountServiceAccountToken: &automountToken,
					SecurityContext: &corev1.PodSecurityContext{
						RunAsNonRoot:        &runAsNonRoot,
						RunAsUser:           &runAsUser,
						RunAsGroup:          &runAsGroup,
						FSGroup:             &fsGroup,
						FSGroupChangePolicy: &fsGroupChangePolicy,
						SeccompProfile:      &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault},
					},
					Containers: []corev1.Container{container},
					Volumes: []corev1.Volume{
						{Name: "workspace", VolumeSource: corev1.VolumeSource{PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: input.WorkspacePVCName, ReadOnly: false}}},
						{Name: "tmp", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{}}},
					},
				},
			},
		},
	}, nil
}

func validateInput(input Input) error {
	if input.Review == nil || input.Now.IsZero() || input.Review.Namespace != Namespace {
		return ErrJobConfiguration
	}
	review := input.Review
	spec := review.Spec
	if len(validation.IsDNS1123Subdomain(review.Name)) != 0 || len(review.Name)+len("-worker") > 63 {
		return ErrJobConfiguration
	}
	if !runIDPattern.MatchString(spec.RunID) || len(spec.DeliveryID) == 0 || len(spec.DeliveryID) > 512 || spec.RepositoryID <= 0 ||
		!repoPattern.MatchString(spec.Repo) || spec.PRNumber <= 0 || !shaPattern.MatchString(spec.HeadSHA) || !shaPattern.MatchString(spec.BaseSHA) ||
		!digestPattern.MatchString(spec.PolicyDigest) || !digestPattern.MatchString(spec.ConfigDigest) || spec.PublicationMode != "disabled" ||
		!workerImagePattern.MatchString(spec.WorkerImage) || !secretNamePattern.MatchString(spec.RunSecretName) {
		return ErrJobConfiguration
	}
	if spec.TerminalDeadline.Sub(spec.ReceivedAt.Time) != 15*time.Minute || input.Now.Before(spec.ReceivedAt.Time) {
		return ErrJobDeadline
	}
	if input.WorkspacePVCName != workspace.PVCName(spec.RepositoryID, spec.PRNumber) {
		return ErrJobConfiguration
	}
	lease := input.WorkspaceLease
	if !lease.Acquired || lease.Lease == nil || lease.HolderIdentity != spec.RunID {
		return workspace.ErrLeaseHeld
	}
	return workspace.ValidateLeaseForUse(lease.Lease, review.Namespace, spec.RepositoryID, spec.PRNumber, spec.RunID, input.Now)
}

func remainingDeadlineSeconds(deadline, now time.Time) (int64, error) {
	remaining := deadline.Sub(now)
	if remaining < time.Duration(MinRemainingSeconds)*time.Second {
		return 0, workspace.ErrInsufficientDeadline
	}
	// Floor rather than ceil: an integer Kubernetes deadline must not extend
	// past the authenticated terminal deadline when `now` includes fractions
	// of a second.
	seconds := int64(math.Floor(remaining.Seconds())) - DeadlineReserveSeconds
	if seconds <= 0 || seconds > MaxActiveDeadlineSeconds {
		if seconds > MaxActiveDeadlineSeconds {
			seconds = MaxActiveDeadlineSeconds
		} else {
			return 0, ErrJobDeadline
		}
	}
	return seconds, nil
}

func copyStringMap(input map[string]string) map[string]string {
	output := make(map[string]string, len(input))
	for key, value := range input {
		output[key] = value
	}
	return output
}
