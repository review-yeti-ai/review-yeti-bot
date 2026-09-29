package job_test

import (
	"os"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"

	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/job"
)

func TestChallengerResourceConstants(t *testing.T) {
	if job.WorkerCPURequest != "50m" {
		t.Fatalf("expected WorkerCPURequest = 50m, got %s", job.WorkerCPURequest)
	}
	if job.WorkerMemoryRequest != "96Mi" {
		t.Fatalf("expected WorkerMemoryRequest = 96Mi, got %s", job.WorkerMemoryRequest)
	}
	if job.WorkerMemoryLimit != "256Mi" {
		t.Fatalf("expected WorkerMemoryLimit = 256Mi, got %s", job.WorkerMemoryLimit)
	}

	// Verify exact quantity parsing
	cpuReq := resource.MustParse(job.WorkerCPURequest)
	if cpuReq.MilliValue() != 50 {
		t.Fatalf("expected 50 millicores, got %d", cpuReq.MilliValue())
	}

	memReq := resource.MustParse(job.WorkerMemoryRequest)
	expectedMemReq := int64(96 * 1024 * 1024)
	if memReq.Value() != expectedMemReq {
		t.Fatalf("expected %d bytes for 96Mi, got %d", expectedMemReq, memReq.Value())
	}

	memLim := resource.MustParse(job.WorkerMemoryLimit)
	expectedMemLim := int64(256 * 1024 * 1024)
	if memLim.Value() != expectedMemLim {
		t.Fatalf("expected %d bytes for 256Mi, got %d", expectedMemLim, memLim.Value())
	}
}

func TestChallengerWorkerCPULimitQuantityEdgeCases(t *testing.T) {
	origVal, wasSet := os.LookupEnv(job.WorkerCPULimitEnv)
	defer func() {
		if wasSet {
			os.Setenv(job.WorkerCPULimitEnv, origVal)
		} else {
			os.Unsetenv(job.WorkerCPULimitEnv)
		}
	}()

	testCases := []struct {
		envValue    *string
		expectLimit bool
		expectedVal string
	}{
		{envValue: strPtr("none"), expectLimit: false},
		{envValue: strPtr("NONE"), expectLimit: false},
		{envValue: strPtr("None"), expectLimit: false},
		{envValue: strPtr(""), expectLimit: false},
		{envValue: strPtr("   none   "), expectLimit: false},
		{envValue: strPtr("   "), expectLimit: false},
		{envValue: nil, expectLimit: true, expectedVal: "1"}, // Unset falls back to 1 CPU default
		{envValue: strPtr("500m"), expectLimit: true, expectedVal: "500m"},
		{envValue: strPtr("2"), expectLimit: true, expectedVal: "2"},
		{envValue: strPtr("invalid-quantity"), expectLimit: true, expectedVal: "1"}, // Invalid falls back to default
	}

	for _, tc := range testCases {
		if tc.envValue == nil {
			os.Unsetenv(job.WorkerCPULimitEnv)
		} else {
			os.Setenv(job.WorkerCPULimitEnv, *tc.envValue)
		}

		qty, limited := job.WorkerCPULimitQuantity()
		if limited != tc.expectLimit {
			envStr := "<unset>"
			if tc.envValue != nil {
				envStr = *tc.envValue
			}
			t.Errorf("WorkerCPULimitQuantity() for env=%q: expected limited=%v, got %v", envStr, tc.expectLimit, limited)
			continue
		}

		if tc.expectLimit {
			expectedQty := resource.MustParse(tc.expectedVal)
			if qty.Cmp(expectedQty) != 0 {
				t.Errorf("WorkerCPULimitQuantity() quantity mismatch: expected %s, got %s", tc.expectedVal, qty.String())
			}
		}
	}
}

func TestChallengerBuildWorkerJobOmitsCPULimitUnderNone(t *testing.T) {
	origCPU, wasCPUSet := os.LookupEnv(job.WorkerCPULimitEnv)
	defer func() {
		if wasCPUSet {
			os.Setenv(job.WorkerCPULimitEnv, origCPU)
		} else {
			os.Unsetenv(job.WorkerCPULimitEnv)
		}
	}()

	os.Setenv(job.WorkerCPULimitEnv, "none")

	now := time.Date(2026, 8, 30, 20, 0, 0, 0, time.UTC)
	review := reviewFixture(now)
	input := buildInput(review, now)

	workerJob, err := job.BuildWorkerJob(input)
	if err != nil {
		t.Fatalf("BuildWorkerJob failed: %v", err)
	}

	containers := workerJob.Spec.Template.Spec.Containers
	if len(containers) != 1 {
		t.Fatalf("expected 1 container, got %d", len(containers))
	}

	c := containers[0]
	// Assert requests
	reqCPU := c.Resources.Requests[corev1.ResourceCPU]
	if reqCPU.String() != "50m" {
		t.Errorf("expected CPU request 50m, got %s", reqCPU.String())
	}
	reqMem := c.Resources.Requests[corev1.ResourceMemory]
	if reqMem.String() != "96Mi" {
		t.Errorf("expected Memory request 96Mi, got %s", reqMem.String())
	}

	// Assert limits
	limMem := c.Resources.Limits[corev1.ResourceMemory]
	if limMem.String() != "256Mi" {
		t.Errorf("expected Memory limit 256Mi, got %s", limMem.String())
	}

	// Strictly assert limits.cpu is absent
	if _, hasCPU := c.Resources.Limits[corev1.ResourceCPU]; hasCPU {
		t.Errorf("CRITICAL VIOLATION: limits.cpu must be absent when REVIEW_YETI_WORKER_CPU_LIMIT=none, found %v", c.Resources.Limits[corev1.ResourceCPU])
	}
}

func strPtr(s string) *string {
	return &s
}
