package job_test

import (
	"testing"
	"time"

	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/job"
)

func TestWorkerJobSandboxingInvariants(t *testing.T) {
	now := time.Date(2026, 8, 30, 20, 0, 0, 0, time.UTC)

	testCases := []struct {
		name                 string
		publicationMode      string
		qualificationProfile string
		qualificationModel   string
		withPublishing       bool
	}{
		{
			name:            "AppGate publication mode",
			publicationMode: "app-gate",
			withPublishing:  true,
		},
		{
			name:            "Disabled (receipt-only) mode",
			publicationMode: "disabled",
			withPublishing:  false,
		},
		{
			name:                 "FullPanel qualification mode",
			publicationMode:      "disabled",
			qualificationProfile: job.FullPanelQualificationProfile,
			qualificationModel:   "deepseek/deepseek-v4-flash-0731",
			withPublishing:       false,
		},
		{
			name:                 "SameHead qualification mode",
			publicationMode:      "disabled",
			qualificationProfile: job.SameHeadQualificationProfile,
			qualificationModel:   "deepseek/deepseek-v4-flash-0731",
			withPublishing:       false,
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			review := reviewFixture(now)
			review.Spec.PublicationMode = tc.publicationMode
			if tc.qualificationProfile != "" {
				review.Spec.QualificationProfile = tc.qualificationProfile
				review.Spec.QualificationModel = tc.qualificationModel
			}

			input := buildInput(review, now)
			if tc.withPublishing {
				input.Publishing = publishingFixture()
			}

			result, err := job.BuildWorkerJob(input)
			if err != nil {
				t.Fatalf("BuildWorkerJob failed: %v", err)
			}

			podSpec := result.Spec.Template.Spec

			// 1. Invariant: exactly 2 volumes
			if len(podSpec.Volumes) != 2 {
				t.Fatalf("Volumes count = %d, want exactly 2", len(podSpec.Volumes))
			}
			if podSpec.Volumes[0].Name != "workspace" {
				t.Fatalf("Volume 0 must be workspace, got %#v", podSpec.Volumes[0])
			}
			if review.Spec.RunnerMode == "generic" {
				if podSpec.Volumes[0].PersistentVolumeClaim == nil {
					t.Fatalf("Volume 0 must be workspace PVC, got %#v", podSpec.Volumes[0])
				}
			} else {
				if podSpec.Volumes[0].EmptyDir == nil {
					t.Fatalf("Volume 0 must be workspace EmptyDir, got %#v", podSpec.Volumes[0])
				}
			}
			if podSpec.Volumes[1].Name != "tmp" || podSpec.Volumes[1].EmptyDir == nil {
				t.Fatalf("Volume 1 must be tmp EmptyDir, got %#v", podSpec.Volumes[1])
			}

			// 2. Invariant: exactly 1 container with exactly 2 volume mounts
			if len(podSpec.Containers) != 1 {
				t.Fatalf("Containers count = %d, want 1", len(podSpec.Containers))
			}
			container := podSpec.Containers[0]
			if len(container.VolumeMounts) != 2 {
				t.Fatalf("VolumeMounts count = %d, want exactly 2", len(container.VolumeMounts))
			}
			if container.VolumeMounts[0].Name != "workspace" || container.VolumeMounts[0].MountPath != "/workspace" {
				t.Fatalf("VolumeMount 0 must be /workspace, got %#v", container.VolumeMounts[0])
			}
			if container.VolumeMounts[1].Name != "tmp" || container.VolumeMounts[1].MountPath != "/tmp" {
				t.Fatalf("VolumeMount 1 must be /tmp, got %#v", container.VolumeMounts[1])
			}

			// 3. Invariant: CT_REVIEW_DATA_DIR must be /tmp/.ct-memory
			foundDataDir := false
			for _, envVar := range container.Env {
				if envVar.Name == "CT_REVIEW_DATA_DIR" {
					foundDataDir = true
					if envVar.Value != "/tmp/.ct-memory" {
						t.Fatalf("CT_REVIEW_DATA_DIR = %q, want /tmp/.ct-memory", envVar.Value)
					}
				}
			}
			if !foundDataDir {
				t.Fatal("CT_REVIEW_DATA_DIR not found in container env")
			}

			// 4. Invariant: Pod & Container SecurityContext sandboxing
			if container.SecurityContext == nil {
				t.Fatal("container.SecurityContext is nil")
			}
			if container.SecurityContext.ReadOnlyRootFilesystem == nil || !*container.SecurityContext.ReadOnlyRootFilesystem {
				t.Fatalf("container root filesystem must be read-only: %#v", container.SecurityContext)
			}
			if container.SecurityContext.AllowPrivilegeEscalation == nil || *container.SecurityContext.AllowPrivilegeEscalation {
				t.Fatalf("container AllowPrivilegeEscalation must be false: %#v", container.SecurityContext)
			}
			if container.SecurityContext.RunAsNonRoot == nil || !*container.SecurityContext.RunAsNonRoot {
				t.Fatalf("container RunAsNonRoot must be true: %#v", container.SecurityContext)
			}
			if container.SecurityContext.RunAsUser == nil || *container.SecurityContext.RunAsUser != 1000 {
				t.Fatalf("container RunAsUser must be 1000: %#v", container.SecurityContext)
			}
			if container.SecurityContext.RunAsGroup == nil || *container.SecurityContext.RunAsGroup != 1000 {
				t.Fatalf("container RunAsGroup must be 1000: %#v", container.SecurityContext)
			}
			if container.SecurityContext.Capabilities == nil || len(container.SecurityContext.Capabilities.Drop) != 1 || container.SecurityContext.Capabilities.Drop[0] != "ALL" {
				t.Fatalf("container Capabilities.Drop must be [ALL]: %#v", container.SecurityContext)
			}

			// 5. Invariant: Forbidden credentials must never be in worker env
			forbiddenCredentials := []string{
				"GITHUB_TOKEN",
				"GITHUB_APP_ID",
				"GITHUB_APP_PRIVATE_KEY",
				"GITHUB_INSTALLATION_ID",
			}
			for _, forbidden := range forbiddenCredentials {
				for _, e := range container.Env {
					if e.Name == forbidden {
						t.Fatalf("Forbidden credential %s leaked into worker container env", forbidden)
					}
				}
			}
		})
	}
}
