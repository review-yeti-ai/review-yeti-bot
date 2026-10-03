/*
Copyright 2026 Review Yeti.

Adversarial empirical tests for operator emptyDir storage volume builder and input validation.
*/

package job_test

import (
	"os"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"

	"github.com/review-yeti-ai/review-yeti-bot/k8s-operator/pkg/job"
)

func TestAdversarialStorageSizeParsing(t *testing.T) {
	now := time.Date(2026, 9, 10, 12, 0, 0, 0, time.UTC)

	testCases := []struct {
		name          string
		envValue      string
		expectedLimit resource.Quantity
	}{
		{
			name:          "Default when unset",
			envValue:      "",
			expectedLimit: resource.MustParse("1Gi"),
		},
		{
			name:          "Valid 2Gi override",
			envValue:      "2Gi",
			expectedLimit: resource.MustParse("2Gi"),
		},
		{
			name:          "Valid 512Mi override",
			envValue:      "512Mi",
			expectedLimit: resource.MustParse("512Mi"),
		},
		{
			name:          "Valid with surrounding whitespace",
			envValue:      "  1536Mi  ",
			expectedLimit: resource.MustParse("1536Mi"),
		},
		{
			name:          "Adversarial: gibberish string falls back to 1Gi",
			envValue:      "unlimited_storage_bypass",
			expectedLimit: resource.MustParse("1Gi"),
		},
		{
			name:          "Adversarial: negative quantity is parsed without sign check (finding: allows negative)",
			envValue:      "-10Gi",
			expectedLimit: resource.MustParse("-10Gi"),
		},
		{
			name:          "Adversarial: malformed unit falls back to 1Gi",
			envValue:      "1000Gigabytes",
			expectedLimit: resource.MustParse("1Gi"),
		},
		{
			name:          "Adversarial: pure whitespace falls back to 1Gi",
			envValue:      "   \t\n  ",
			expectedLimit: resource.MustParse("1Gi"),
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.envValue == "" {
				os.Unsetenv("REVIEW_YETI_WORKER_STORAGE_SIZE")
			} else {
				os.Setenv("REVIEW_YETI_WORKER_STORAGE_SIZE", tc.envValue)
				defer os.Unsetenv("REVIEW_YETI_WORKER_STORAGE_SIZE")
			}

			review := reviewFixture(now)
			review.Spec.RunnerMode = "prebaked"
			input := buildInput(review, now)

			builtJob, err := job.BuildWorkerJob(input)
			if err != nil {
				t.Fatalf("BuildWorkerJob failed: %v", err)
			}

			var wsVolume *corev1.Volume
			for i := range builtJob.Spec.Template.Spec.Volumes {
				if builtJob.Spec.Template.Spec.Volumes[i].Name == "workspace" {
					wsVolume = &builtJob.Spec.Template.Spec.Volumes[i]
					break
				}
			}

			if wsVolume == nil {
				t.Fatal("workspace volume not found in job template spec")
			}
			if wsVolume.EmptyDir == nil {
				t.Fatal("workspace volume must be EmptyDir for prebaked runner mode")
			}
			if wsVolume.PersistentVolumeClaim != nil {
				t.Fatal("workspace volume must NOT have PersistentVolumeClaim in prebaked mode")
			}
			if wsVolume.EmptyDir.SizeLimit == nil {
				t.Fatal("workspace EmptyDir SizeLimit must not be nil")
			}
			if !wsVolume.EmptyDir.SizeLimit.Equal(tc.expectedLimit) {
				t.Fatalf("SizeLimit = %v, want %v", wsVolume.EmptyDir.SizeLimit, tc.expectedLimit)
			}
		})
	}
}

func TestAdversarialRunnerModeVolumeAllocation(t *testing.T) {
	now := time.Date(2026, 9, 10, 12, 0, 0, 0, time.UTC)

	t.Run("Generic mode unconditionally mounts EmptyDir", func(t *testing.T) {
		review := reviewFixture(now)
		review.Spec.RunnerMode = "generic"

		// 1. Missing PVC name succeeds and mounts EmptyDir
		input := buildInput(review, now)
		input.WorkspacePVCName = ""
		built, err := job.BuildWorkerJob(input)
		if err != nil {
			t.Fatalf("BuildWorkerJob failed on empty WorkspacePVCName in generic mode: %v", err)
		}
		wsVol := built.Spec.Template.Spec.Volumes[0]
		if wsVol.EmptyDir == nil {
			t.Fatal("generic runner mode must use EmptyDir")
		}
		if wsVol.PersistentVolumeClaim != nil {
			t.Fatal("generic runner mode must NOT have PersistentVolumeClaim")
		}

		// 2. Ignores foreign/provided PVC name and mounts EmptyDir
		input.WorkspacePVCName = "malicious-foreign-pvc"
		built, err = job.BuildWorkerJob(input)
		if err != nil {
			t.Fatalf("BuildWorkerJob failed: %v", err)
		}
		wsVol = built.Spec.Template.Spec.Volumes[0]
		if wsVol.EmptyDir == nil {
			t.Fatal("generic runner mode must use EmptyDir")
		}
		if wsVol.PersistentVolumeClaim != nil {
			t.Fatal("generic runner mode must NOT have PersistentVolumeClaim")
		}
	})

	t.Run("Prebaked mode ignores provided PVC name and mounts EmptyDir", func(t *testing.T) {
		review := reviewFixture(now)
		review.Spec.RunnerMode = "prebaked"

		input := buildInput(review, now)
		// Adversarial: inject a bogus PVC name in input; prebaked builder must ignore it
		input.WorkspacePVCName = "malicious-foreign-pvc"

		built, err := job.BuildWorkerJob(input)
		if err != nil {
			t.Fatalf("BuildWorkerJob failed: %v", err)
		}

		wsVol := built.Spec.Template.Spec.Volumes[0]
		if wsVol.EmptyDir == nil {
			t.Fatal("prebaked mode must use EmptyDir")
		}
		if wsVol.PersistentVolumeClaim != nil {
			t.Fatal("prebaked mode must NOT mount PersistentVolumeClaim even if input has PVC name")
		}
	})

	t.Run("Default empty string runner mode defaults to prebaked EmptyDir", func(t *testing.T) {
		review := reviewFixture(now)
		review.Spec.RunnerMode = ""

		input := buildInput(review, now)
		input.WorkspacePVCName = "" // Empty PVC name is allowed in default mode

		built, err := job.BuildWorkerJob(input)
		if err != nil {
			t.Fatalf("BuildWorkerJob failed: %v", err)
		}

		wsVol := built.Spec.Template.Spec.Volumes[0]
		if wsVol.EmptyDir == nil {
			t.Fatal("default runner mode must use EmptyDir")
		}
		if wsVol.PersistentVolumeClaim != nil {
			t.Fatal("default runner mode must NOT use PersistentVolumeClaim")
		}
	})
}
