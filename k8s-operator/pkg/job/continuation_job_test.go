package job_test

import (
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"

	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/job"
)

func TestBuildWorkerJob_ContinuationPhase(t *testing.T) {
	now := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)
	review := reviewFixture(now)
	input := buildInput(review, now)
	input.Phase = job.JobPhaseContinuation

	worker, err := job.BuildWorkerJob(input)
	if err != nil {
		t.Fatalf("BuildWorkerJob for continuation phase failed: %v", err)
	}

	// 1. Worker Job Name
	expectedName := review.Name + "-continuation"
	if worker.Name != expectedName {
		t.Fatalf("expected Job name %q, got %q", expectedName, worker.Name)
	}

	// 2. Labels
	if worker.Labels[job.JobPhaseLabel] != job.JobPhaseContinuation {
		t.Fatalf("expected label %q = %q, got %q", job.JobPhaseLabel, job.JobPhaseContinuation, worker.Labels[job.JobPhaseLabel])
	}
	if worker.Spec.Template.Labels[job.JobPhaseLabel] != job.JobPhaseContinuation {
		t.Fatalf("expected pod template label %q = %q, got %q", job.JobPhaseLabel, job.JobPhaseContinuation, worker.Spec.Template.Labels[job.JobPhaseLabel])
	}

	// 3. Helper checks
	if !job.IsContinuationWorkerJob(worker) {
		t.Fatal("expected IsContinuationWorkerJob(worker) = true, got false")
	}
	if job.IsPrepWorkerJob(worker) {
		t.Fatal("expected IsPrepWorkerJob(worker) = false, got true")
	}

	// 4. Container Environment Variables
	if len(worker.Spec.Template.Spec.Containers) == 0 {
		t.Fatal("expected at least one container in pod template")
	}
	container := worker.Spec.Template.Spec.Containers[0]

	phaseVal := envValue(container, job.PhaseEnvVar)
	if phaseVal != job.JobPhaseContinuation {
		t.Fatalf("expected env %q = %q, got %q", job.PhaseEnvVar, job.JobPhaseContinuation, phaseVal)
	}

	gitHeadShaVal := envValue(container, "GIT_HEAD_SHA")
	if gitHeadShaVal != review.Spec.HeadSHA {
		t.Fatalf("expected env GIT_HEAD_SHA = %q, got %q", review.Spec.HeadSHA, gitHeadShaVal)
	}

	runIDVal := envValue(container, "REVIEW_RUN_ID")
	if runIDVal != review.Spec.RunID {
		t.Fatalf("expected env REVIEW_RUN_ID = %q, got %q", review.Spec.RunID, runIDVal)
	}

	// 5. Rightsized Resources (96Mi req, 256Mi limit, 50m CPU req, no CPU limit)
	memReq := container.Resources.Requests[corev1.ResourceMemory]
	if memReq.String() != "96Mi" {
		t.Fatalf("expected memory request 96Mi, got %s", memReq.String())
	}

	memLimit := container.Resources.Limits[corev1.ResourceMemory]
	if memLimit.String() != "256Mi" {
		t.Fatalf("expected memory limit 256Mi, got %s", memLimit.String())
	}

	cpuReq := container.Resources.Requests[corev1.ResourceCPU]
	if cpuReq.String() != "50m" {
		t.Fatalf("expected CPU request 50m, got %s", cpuReq.String())
	}

	// 6. Volume: local SSD emptyDir: {} mounted at /workspace with 1Gi limit
	var workspaceVol *corev1.Volume
	for i := range worker.Spec.Template.Spec.Volumes {
		v := &worker.Spec.Template.Spec.Volumes[i]
		if v.Name == "workspace" {
			workspaceVol = v
			break
		}
	}
	if workspaceVol == nil || workspaceVol.EmptyDir == nil {
		t.Fatal("expected emptyDir volume named 'workspace'")
	}
	expectedSize := resource.MustParse("1Gi")
	if workspaceVol.EmptyDir.SizeLimit == nil || !workspaceVol.EmptyDir.SizeLimit.Equal(expectedSize) {
		t.Fatalf("expected workspace size limit 1Gi, got %v", workspaceVol.EmptyDir.SizeLimit)
	}
}

func TestBuildWorkerJob_ContinuationNameLengthValidation(t *testing.T) {
	now := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)

	// Valid length: 50 characters + 13 characters ("-continuation") = 63 characters (exact limit)
	review := reviewFixture(now)
	review.Name = strings.Repeat("a", 50)
	input := buildInput(review, now)
	input.Phase = job.JobPhaseContinuation

	worker, err := job.BuildWorkerJob(input)
	if err != nil {
		t.Fatalf("expected 50-char name with -continuation (len 63) to pass, got: %v", err)
	}
	if len(worker.Name) != 63 {
		t.Fatalf("expected worker name length 63, got %d", len(worker.Name))
	}

	// Invalid length: 51 characters + 13 characters = 64 characters (> 63 limit)
	reviewTooLong := reviewFixture(now)
	reviewTooLong.Name = strings.Repeat("a", 51)
	inputTooLong := buildInput(reviewTooLong, now)
	inputTooLong.Phase = job.JobPhaseContinuation

	_, errTooLong := job.BuildWorkerJob(inputTooLong)
	if errTooLong == nil {
		t.Fatal("expected 51-char name with -continuation to fail validation, but succeeded")
	}
	if !strings.Contains(errTooLong.Error(), "-continuation suffix") {
		t.Fatalf("expected error mentioning -continuation suffix, got: %v", errTooLong)
	}
}
