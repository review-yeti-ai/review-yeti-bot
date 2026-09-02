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

package job_test

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	coordinationv1 "k8s.io/api/coordination/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	v1alpha2 "github.com/calltelemetry/ct-review-bot/k8s-operator/api/v1alpha2"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/job"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/workspace"
)

const jobNamespace = "ct-review-system"

func reviewFixture(now time.Time) *v1alpha2.PRReviewJob {
	receivedAt := metav1.NewTime(now)
	return &v1alpha2.PRReviewJob{
		ObjectMeta: metav1.ObjectMeta{Name: "ct-review-11111111111111111111111111111111", Namespace: jobNamespace},
		Spec: v1alpha2.PRReviewJobSpec{
			RunID:            "run_11111111111111111111111111111111",
			DeliveryID:       "actions:98765:2:123:42:head",
			RepositoryID:     123,
			Repo:             "calltelemetry/cisco-cdr",
			PRNumber:         42,
			HeadSHA:          strings.Repeat("a", 40),
			BaseSHA:          strings.Repeat("b", 40),
			ReceivedAt:       receivedAt,
			TerminalDeadline: metav1.NewTime(now.Add(15 * time.Minute)),
			PolicyDigest:     strings.Repeat("c", 64),
			ConfigDigest:     strings.Repeat("d", 64),
			PublicationMode:  "disabled",
			WorkerImage:      "registry.digitalocean.com/calltelemetry/review-yeti-worker@sha256:" + strings.Repeat("e", 64),
			RunSecretName:    "ct-review-run-11111111111111111111111111111111",
		},
	}
}

func leaseFixture(now time.Time, runID string, duration time.Duration) workspace.LeaseAcquireResult {
	labels, annotations := workspace.Metadata(123, 42)
	holder := runID
	seconds := int32(duration / time.Second)
	renewed := metav1.NewMicroTime(now)
	return workspace.LeaseAcquireResult{
		Acquired:       true,
		HolderIdentity: runID,
		Lease: &coordinationv1.Lease{
			ObjectMeta: metav1.ObjectMeta{Name: workspace.LeaseName(123, 42), Namespace: jobNamespace, Labels: labels, Annotations: annotations},
			Spec:       coordinationv1.LeaseSpec{HolderIdentity: &holder, LeaseDurationSeconds: &seconds, RenewTime: &renewed},
		},
	}
}

func buildInput(review *v1alpha2.PRReviewJob, now time.Time) job.Input {
	return job.Input{
		Review:           review,
		WorkspacePVCName: workspace.PVCName(review.Spec.RepositoryID, review.Spec.PRNumber),
		WorkspaceLease:   leaseFixture(now, review.Spec.RunID, 16*time.Minute),
		Now:              now,
	}
}

func envValue(container corev1.Container, name string) string {
	for _, env := range container.Env {
		if env.Name == name {
			return env.Value
		}
	}
	return ""
}

func hasEnv(container corev1.Container, name string) bool {
	for _, env := range container.Env {
		if env.Name == name {
			return true
		}
	}
	return false
}

func TestBuildWorkerJobCreatesBoundedReceiptOnlyPod(t *testing.T) {
	now := time.Date(2026, 8, 30, 20, 0, 0, 0, time.UTC)
	review := reviewFixture(now)
	result, err := job.BuildWorkerJob(buildInput(review, now))
	if err != nil {
		t.Fatalf("build receipt-only job: %v", err)
	}
	if result.Name != review.Name+"-worker" || result.Namespace != jobNamespace {
		t.Fatalf("job identity = %s/%s", result.Namespace, result.Name)
	}
	if result.Spec.ActiveDeadlineSeconds == nil || *result.Spec.ActiveDeadlineSeconds != 840 {
		t.Fatalf("active deadline = %v, want 840", result.Spec.ActiveDeadlineSeconds)
	}
	if result.Spec.BackoffLimit == nil || *result.Spec.BackoffLimit != 0 {
		t.Fatalf("backoff limit = %v, want 0", result.Spec.BackoffLimit)
	}
	if result.Spec.Completions == nil || *result.Spec.Completions != 1 || result.Spec.Parallelism == nil || *result.Spec.Parallelism != 1 {
		t.Fatalf("job cardinality = completions %v parallelism %v, want one", result.Spec.Completions, result.Spec.Parallelism)
	}
	if result.Spec.TTLSecondsAfterFinished == nil || *result.Spec.TTLSecondsAfterFinished != 300 {
		t.Fatalf("job TTL = %v, want 300", result.Spec.TTLSecondsAfterFinished)
	}
	if len(result.Spec.Template.Spec.Containers) != 1 {
		t.Fatalf("containers = %d, want one", len(result.Spec.Template.Spec.Containers))
	}
	container := result.Spec.Template.Spec.Containers[0]
	if container.Image != review.Spec.WorkerImage || container.ImagePullPolicy != corev1.PullIfNotPresent {
		t.Fatalf("worker image = %q/%q", container.Image, container.ImagePullPolicy)
	}
	requestCPU := container.Resources.Requests[corev1.ResourceCPU]
	requestMemory := container.Resources.Requests[corev1.ResourceMemory]
	if got := requestCPU.String(); got != "500m" || requestMemory.String() != "768Mi" {
		t.Fatalf("resource requests = %v, want 500m/768Mi", container.Resources.Requests)
	}
	limitCPU := container.Resources.Limits[corev1.ResourceCPU]
	limitMemory := container.Resources.Limits[corev1.ResourceMemory]
	if got := limitCPU.String(); got != "1" || limitMemory.String() != "1536Mi" {
		t.Fatalf("resource limits = %v, want 1/1536Mi", container.Resources.Limits)
	}
	if envValue(container, "REVIEW_RECEIPT_ONLY") != "true" || envValue(container, "REVIEW_PUBLICATION_MODE") != "disabled" {
		t.Fatalf("receipt-only env missing: %#v", container.Env)
	}
	if hasEnv(container, "REVIEW_FULL_PANEL_QUALIFICATION_ONLY") || hasEnv(container, "REVIEW_SAME_HEAD_QUALIFICATION_ONLY") ||
		hasEnv(container, "OPENROUTER_API_KEY") || hasEnv(container, "GH_TOKEN") {
		t.Fatalf("receipt-only worker unexpectedly exposes qualification env: %#v", container.Env)
	}
	if envValue(container, "REVIEW_RUN_ID") != review.Spec.RunID || envValue(container, "REVIEW_RECEIPT_PATH") != "/workspace/.review-yeti/receipt.json" {
		t.Fatalf("immutable run env missing: %#v", container.Env)
	}
	if result.Spec.Template.Spec.RestartPolicy != corev1.RestartPolicyNever || result.Spec.Template.Spec.AutomountServiceAccountToken == nil || *result.Spec.Template.Spec.AutomountServiceAccountToken {
		t.Fatalf("pod restart/token policy = %s/%v", result.Spec.Template.Spec.RestartPolicy, result.Spec.Template.Spec.AutomountServiceAccountToken)
	}
	if result.Spec.Template.Spec.ServiceAccountName != "" {
		t.Fatalf("service account = %q, want empty", result.Spec.Template.Spec.ServiceAccountName)
	}
	if result.Spec.Template.Spec.SecurityContext == nil || result.Spec.Template.Spec.SecurityContext.RunAsNonRoot == nil || !*result.Spec.Template.Spec.SecurityContext.RunAsNonRoot {
		t.Fatalf("pod security context is not non-root: %#v", result.Spec.Template.Spec.SecurityContext)
	}
	if result.Spec.Template.Spec.SecurityContext.RunAsUser == nil || *result.Spec.Template.Spec.SecurityContext.RunAsUser != 1000 ||
		result.Spec.Template.Spec.SecurityContext.RunAsGroup == nil || *result.Spec.Template.Spec.SecurityContext.RunAsGroup != 1000 {
		t.Fatalf("pod numeric identity = user %v/group %v, want 1000/1000", result.Spec.Template.Spec.SecurityContext.RunAsUser, result.Spec.Template.Spec.SecurityContext.RunAsGroup)
	}
	if result.Spec.Template.Spec.SecurityContext.FSGroup == nil || *result.Spec.Template.Spec.SecurityContext.FSGroup != 1000 {
		t.Fatalf("pod fsGroup = %v, want 1000", result.Spec.Template.Spec.SecurityContext.FSGroup)
	}
	if result.Spec.Template.Spec.SecurityContext.FSGroupChangePolicy == nil || *result.Spec.Template.Spec.SecurityContext.FSGroupChangePolicy != corev1.FSGroupChangeOnRootMismatch {
		t.Fatalf("pod fsGroupChangePolicy = %v, want OnRootMismatch", result.Spec.Template.Spec.SecurityContext.FSGroupChangePolicy)
	}
	if result.Spec.Template.Spec.SecurityContext.SeccompProfile == nil || result.Spec.Template.Spec.SecurityContext.SeccompProfile.Type != corev1.SeccompProfileTypeRuntimeDefault {
		t.Fatalf("pod seccomp profile = %#v", result.Spec.Template.Spec.SecurityContext.SeccompProfile)
	}
	if container.SecurityContext == nil || container.SecurityContext.AllowPrivilegeEscalation == nil || *container.SecurityContext.AllowPrivilegeEscalation {
		t.Fatalf("container privilege policy = %#v", container.SecurityContext)
	}
	if container.SecurityContext.ReadOnlyRootFilesystem == nil || !*container.SecurityContext.ReadOnlyRootFilesystem {
		t.Fatalf("container root filesystem is not read-only: %#v", container.SecurityContext)
	}
	if result.Labels[workspace.WorkspaceHashLabel] == "" || result.Annotations[workspace.WorkspaceKeyAnnotation] == "" {
		t.Fatalf("job workspace identity missing: labels=%v annotations=%v", result.Labels, result.Annotations)
	}
	if result.Spec.Template.Labels[workspace.WorkspaceHashLabel] == "" || result.Spec.Template.Annotations[workspace.WorkspaceKeyAnnotation] == "" {
		t.Fatalf("pod workspace identity missing: labels=%v annotations=%v", result.Spec.Template.Labels, result.Spec.Template.Annotations)
	}
	if len(result.Spec.Template.Spec.Volumes) != 2 || len(container.VolumeMounts) != 2 {
		t.Fatalf("workspace/tmp mounts = volumes %d mounts %d, want two each", len(result.Spec.Template.Spec.Volumes), len(container.VolumeMounts))
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	lower := strings.ToLower(string(encoded))
	for _, forbidden := range []string{"secret", "provider", "github_app", "private_key"} {
		if strings.Contains(lower, forbidden) {
			t.Fatalf("receipt-only job contains forbidden credential marker %q: %s", forbidden, encoded)
		}
	}
}

func TestBuildWorkerJobCreatesExplicitFullPanelQualificationPod(t *testing.T) {
	now := time.Date(2026, 8, 30, 20, 0, 0, 0, time.UTC)
	review := reviewFixture(now)
	review.Spec.QualificationProfile = job.FullPanelQualificationProfile
	review.Spec.QualificationModel = "deepseek/deepseek-v4-flash-0731"
	result, err := job.BuildWorkerJob(buildInput(review, now))
	if err != nil {
		t.Fatalf("build full-panel qualification job: %v", err)
	}
	container := result.Spec.Template.Spec.Containers[0]
	if envValue(container, "REVIEW_RECEIPT_ONLY") != "" {
		t.Fatalf("full-panel worker must not be receipt-only: %#v", container.Env)
	}
	if envValue(container, "REVIEW_FULL_PANEL_QUALIFICATION_ONLY") != "true" ||
		envValue(container, "REVIEW_QUALIFICATION_MODEL") != review.Spec.QualificationModel ||
		envValue(container, "REVIEW_PUBLICATION_MODE") != "disabled" ||
		envValue(container, "REVIEW_RECEIPT_PATH") != job.ReceiptPath {
		t.Fatalf("full-panel qualification env missing: %#v", container.Env)
	}
	var apiKey *corev1.EnvVar
	for index := range container.Env {
		if container.Env[index].Name == "OPENROUTER_API_KEY" {
			apiKey = &container.Env[index]
			break
		}
	}
	if apiKey == nil || apiKey.ValueFrom == nil || apiKey.ValueFrom.SecretKeyRef == nil ||
		apiKey.ValueFrom.SecretKeyRef.Name != review.Spec.RunSecretName || apiKey.ValueFrom.SecretKeyRef.Key != "OPENROUTER_API_KEY" {
		t.Fatalf("full-panel qualification secret reference = %#v", apiKey)
	}
	if hasEnv(container, "GH_TOKEN") {
		t.Fatal("full-panel qualification must not receive the GitHub read token")
	}
}

func TestBuildFullPanelQualificationKeepsWorkerDeadlineInsideJobDeadline(t *testing.T) {
	received := time.Date(2026, 8, 30, 20, 0, 0, 0, time.UTC)
	for _, test := range []struct {
		name          string
		now           time.Time
		wantTimeoutMs string
	}{
		{name: "fresh admission", now: received, wantTimeoutMs: "780000"},
		{name: "mid-run admission", now: received.Add(8 * time.Minute), wantTimeoutMs: "300000"},
		{name: "fractional admission", now: received.Add(12*time.Minute + 30*time.Second + 500*time.Millisecond), wantTimeoutMs: "29000"},
		{name: "last permitted window", now: received.Add(13 * time.Minute), wantTimeoutMs: "1000"},
	} {
		t.Run(test.name, func(t *testing.T) {
			review := reviewFixture(received)
			review.Spec.QualificationProfile = job.FullPanelQualificationProfile
			review.Spec.QualificationModel = "deepseek/deepseek-v4-flash-0731"
			result, err := job.BuildWorkerJob(buildInput(review, test.now))
			if err != nil {
				t.Fatal(err)
			}
			container := result.Spec.Template.Spec.Containers[0]
			if got := envValue(container, "REVIEW_QUALIFICATION_TIMEOUT_MS"); got != test.wantTimeoutMs {
				t.Fatalf("worker qualification timeout = %q, want %q", got, test.wantTimeoutMs)
			}
		})
	}
}

func TestBuildWorkerJobCreatesExplicitSameHeadQualificationPod(t *testing.T) {
	now := time.Date(2026, 8, 30, 20, 0, 0, 0, time.UTC)
	review := reviewFixture(now)
	review.Spec.QualificationProfile = "same-head"
	review.Spec.QualificationModel = "deepseek/deepseek-v4-flash-0731"
	result, err := job.BuildWorkerJob(buildInput(review, now))
	if err != nil {
		t.Fatalf("build same-head qualification job: %v", err)
	}
	if result.Spec.ActiveDeadlineSeconds == nil || *result.Spec.ActiveDeadlineSeconds != 840 ||
		result.Spec.BackoffLimit == nil || *result.Spec.BackoffLimit != 0 {
		t.Fatalf("same-head deadline/backoff = %v/%v, want 840/0", result.Spec.ActiveDeadlineSeconds, result.Spec.BackoffLimit)
	}
	if result.Spec.Template.Spec.AutomountServiceAccountToken == nil || *result.Spec.Template.Spec.AutomountServiceAccountToken {
		t.Fatalf("same-head worker must not mount a service account token: %v", result.Spec.Template.Spec.AutomountServiceAccountToken)
	}
	container := result.Spec.Template.Spec.Containers[0]
	if envValue(container, "REVIEW_SAME_HEAD_QUALIFICATION_ONLY") != "true" ||
		envValue(container, "REVIEW_FULL_PANEL_QUALIFICATION_ONLY") != "" ||
		envValue(container, "REVIEW_RECEIPT_ONLY") != "" ||
		envValue(container, "REVIEW_QUALIFICATION_MODEL") != review.Spec.QualificationModel ||
		envValue(container, "REVIEW_QUALIFICATION_TIMEOUT_MS") != "780000" ||
		envValue(container, "REVIEW_PUBLICATION_MODE") != "disabled" {
		t.Fatalf("same-head qualification env mismatch: %#v", container.Env)
	}
	wantSecretKeys := map[string]string{
		"OPENROUTER_API_KEY": "OPENROUTER_API_KEY",
		"GH_TOKEN":           "GITHUB_READ_TOKEN",
	}
	for envName, secretKey := range wantSecretKeys {
		var found *corev1.EnvVar
		for index := range container.Env {
			if container.Env[index].Name == envName {
				found = &container.Env[index]
				break
			}
		}
		if found == nil || found.ValueFrom == nil || found.ValueFrom.SecretKeyRef == nil ||
			found.ValueFrom.SecretKeyRef.Name != review.Spec.RunSecretName || found.ValueFrom.SecretKeyRef.Key != secretKey {
			t.Fatalf("same-head %s secret reference = %#v", envName, found)
		}
	}
	for _, forbidden := range []string{"GITHUB_TOKEN", "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_INSTALLATION_ID"} {
		if hasEnv(container, forbidden) {
			t.Fatalf("same-head worker exposes forbidden credential %s", forbidden)
		}
	}
}

func TestBuildWorkerJobNeverExtendsTerminalDeadline(t *testing.T) {
	received := time.Date(2026, 8, 30, 20, 0, 0, 0, time.UTC)
	for _, test := range []struct {
		name     string
		now      time.Time
		wantSecs int64
	}{
		{name: "mid-run", now: received.Add(8 * time.Minute), wantSecs: 360},
		{name: "fractional floor", now: received.Add(12*time.Minute + 30*time.Second + 500*time.Millisecond), wantSecs: 89},
		{name: "last permitted window", now: received.Add(13 * time.Minute), wantSecs: 60},
	} {
		t.Run(test.name, func(t *testing.T) {
			review := reviewFixture(received)
			result, err := job.BuildWorkerJob(buildInput(review, test.now))
			if err != nil {
				t.Fatal(err)
			}
			if result.Spec.ActiveDeadlineSeconds == nil || *result.Spec.ActiveDeadlineSeconds != test.wantSecs {
				t.Fatalf("active deadline = %v, want %d", result.Spec.ActiveDeadlineSeconds, test.wantSecs)
			}
		})
	}
	if _, err := job.BuildWorkerJob(buildInput(reviewFixture(received), received.Add(14*time.Minute))); !errors.Is(err, workspace.ErrInsufficientDeadline) {
		t.Fatalf("late build error = %v, want ErrInsufficientDeadline", err)
	}
}

func TestBuildWorkerJobRequiresCurrentRunLeaseAndExactPVC(t *testing.T) {
	now := time.Date(2026, 8, 30, 20, 0, 0, 0, time.UTC)
	review := reviewFixture(now)
	tests := []struct {
		name   string
		mutate func(*job.Input)
	}{
		{name: "not acquired", mutate: func(input *job.Input) { input.WorkspaceLease.Acquired = false }},
		{name: "wrong holder", mutate: func(input *job.Input) { input.WorkspaceLease.HolderIdentity = "run_22222222222222222222222222222222" }},
		{name: "expired lease", mutate: func(input *job.Input) {
			past := metav1.NewMicroTime(now.Add(-17 * time.Minute))
			input.WorkspaceLease.Lease.Spec.RenewTime = &past
		}},
		{name: "wrong pvc", mutate: func(input *job.Input) { input.WorkspacePVCName = "ct-review-ws-wrong" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			input := buildInput(review, now)
			test.mutate(&input)
			if _, err := job.BuildWorkerJob(input); err == nil {
				t.Fatal("unsafe workspace evidence unexpectedly built a Job")
			}
		})
	}
}

func TestBuildWorkerJobRejectsUnsafeProjection(t *testing.T) {
	now := time.Date(2026, 8, 30, 20, 0, 0, 0, time.UTC)
	tests := []struct {
		name   string
		mutate func(*v1alpha2.PRReviewJob)
	}{
		{name: "wrong namespace", mutate: func(review *v1alpha2.PRReviewJob) { review.Namespace = "default" }},
		{name: "publication enabled", mutate: func(review *v1alpha2.PRReviewJob) { review.Spec.PublicationMode = "enabled" }},
		{name: "latest image", mutate: func(review *v1alpha2.PRReviewJob) {
			review.Spec.WorkerImage = "registry.digitalocean.com/calltelemetry/review-yeti-worker:latest"
		}},
		{name: "deadline not fifteen minutes", mutate: func(review *v1alpha2.PRReviewJob) {
			review.Spec.TerminalDeadline = metav1.NewTime(now.Add(10 * time.Minute))
		}},
		{name: "missing review name", mutate: func(review *v1alpha2.PRReviewJob) { review.Name = "" }},
		{name: "model without qualification profile", mutate: func(review *v1alpha2.PRReviewJob) {
			review.Spec.QualificationModel = "deepseek/deepseek-v4-flash-0731"
		}},
		{name: "qualification profile without model", mutate: func(review *v1alpha2.PRReviewJob) {
			review.Spec.QualificationProfile = job.FullPanelQualificationProfile
		}},
		{name: "auto router qualification model", mutate: func(review *v1alpha2.PRReviewJob) {
			review.Spec.QualificationProfile = job.FullPanelQualificationProfile
			review.Spec.QualificationModel = "openrouter/auto"
		}},
		{name: "unknown qualification profile", mutate: func(review *v1alpha2.PRReviewJob) {
			review.Spec.QualificationProfile = "provider-qualification"
			review.Spec.QualificationModel = "deepseek/deepseek-v4-flash-0731"
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			review := reviewFixture(now)
			test.mutate(review)
			if _, err := job.BuildWorkerJob(buildInput(review, now)); err == nil {
				t.Fatal("unsafe projection unexpectedly built a Job")
			}
		})
	}
}

var _ = batchv1.Job{}
