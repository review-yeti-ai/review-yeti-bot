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

// REL-1038: worker placement, CPU limit opt-out, forensic hold and the
// Pod-identity projection the worker prints as its log-store locator.
package job_test

import (
	"os"
	"testing"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/job"
)

func buildPlacementJob(t *testing.T) *batchv1.Job {
	t.Helper()
	now := time.Date(2026, 9, 23, 13, 0, 0, 0, time.UTC)
	built, err := job.BuildWorkerJob(buildInput(reviewFixture(now), now))
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	return built
}

// unsetEnv removes a variable for one test and restores it afterwards;
// t.Setenv alone cannot express "unset".
func unsetEnv(t *testing.T, name string) {
	t.Helper()
	t.Setenv(name, "")
	if err := os.Unsetenv(name); err != nil {
		t.Fatal(err)
	}
}

func TestWorkerPodsSpreadAcrossNodesWithoutBlockingScheduling(t *testing.T) {
	spread := buildPlacementJob(t).Spec.Template.Spec.TopologySpreadConstraints
	if len(spread) != 1 {
		t.Fatalf("topologySpreadConstraints = %#v, want exactly one hostname spread", spread)
	}
	constraint := spread[0]
	if constraint.TopologyKey != "kubernetes.io/hostname" || constraint.MaxSkew != 1 || constraint.WhenUnsatisfiable != corev1.ScheduleAnyway {
		t.Fatalf("constraint = %#v, want kubernetes.io/hostname maxSkew 1 ScheduleAnyway", constraint)
	}
	selector, err := metav1.LabelSelectorAsSelector(constraint.LabelSelector)
	if err != nil {
		t.Fatal(err)
	}
	for _, component := range []string{job.ReceiptOnlyWorkerComponent, job.PublishingWorkerComponent} {
		if !selector.Matches(labelSet{"review-yeti.ai/component": component}) {
			t.Fatalf("spread selector %s does not count %s workers", selector, component)
		}
	}
	if selector.Matches(labelSet{"review-yeti.ai/component": "operator"}) {
		t.Fatalf("spread selector %s must count only worker Pods", selector)
	}
}

type labelSet map[string]string

func (l labelSet) Has(key string) bool   { _, ok := l[key]; return ok }
func (l labelSet) Get(key string) string { return l[key] }

func TestWorkerCPULimitCanBeExplicitlyRemoved(t *testing.T) {
	for _, value := range []string{"", "  ", "none", "NONE"} {
		t.Run("value_"+value, func(t *testing.T) {
			t.Setenv(job.WorkerCPULimitEnv, value)
			t.Setenv("REVIEW_YETI_WORKER_MEMORY_LIMIT", "1024Mi")
			limits := buildPlacementJob(t).Spec.Template.Spec.Containers[0].Resources.Limits
			if _, ok := limits[corev1.ResourceCPU]; ok {
				t.Fatalf("limits = %v, want no CPU limit for %q", limits, value)
			}
			memory := limits[corev1.ResourceMemory]
			if memory.String() != "1Gi" {
				t.Fatalf("memory limit = %s, want the configured 1024Mi kept", memory.String())
			}
		})
	}
}

func TestWorkerCPULimitKeepsExistingValuesAndDefault(t *testing.T) {
	cases := map[string]string{"1": "1", "500m": "500m", "2": "2", "banana": "1"}
	for value, want := range cases {
		t.Run(value, func(t *testing.T) {
			t.Setenv(job.WorkerCPULimitEnv, value)
			cpu := buildPlacementJob(t).Spec.Template.Spec.Containers[0].Resources.Limits[corev1.ResourceCPU]
			if cpu.String() != want {
				t.Fatalf("cpu limit for %q = %s, want %s", value, cpu.String(), want)
			}
		})
	}
	t.Run("unset", func(t *testing.T) {
		unsetEnv(t, job.WorkerCPULimitEnv)
		cpu, ok := buildPlacementJob(t).Spec.Template.Spec.Containers[0].Resources.Limits[corev1.ResourceCPU]
		if !ok || cpu.String() != job.WorkerCPULimit {
			t.Fatalf("unset cpu limit = %v (present=%v), want the historical default %s", cpu.String(), ok, job.WorkerCPULimit)
		}
	})
}

func TestWorkerJobIsBuiltWithTheForensicHoldAsItsTTLFloor(t *testing.T) {
	cases := []struct {
		failed, hold string
		want         int32
	}{
		{failed: "0", hold: "", want: job.DefaultWorkerForensicHoldSeconds},
		{failed: "30", hold: "120", want: 120},
		{failed: "3600", hold: "", want: 3600},
		{failed: "0", hold: "0", want: 0},
	}
	for _, tc := range cases {
		t.Run("failed_"+tc.failed+"_hold_"+tc.hold, func(t *testing.T) {
			t.Setenv(job.WorkerFailedTTLAfterFinishedEnv, tc.failed)
			t.Setenv(job.WorkerForensicHoldEnv, tc.hold)
			ttl := buildPlacementJob(t).Spec.TTLSecondsAfterFinished
			if ttl == nil || *ttl != tc.want {
				t.Fatalf("build TTL = %v, want %d", ttl, tc.want)
			}
			if got := job.WorkerFinishedTTLSeconds(false); got != job.WorkerFailedTTLSeconds() {
				t.Fatalf("finished failed TTL = %d, want the configured failed TTL %d", got, job.WorkerFailedTTLSeconds())
			}
		})
	}
}

func TestWorkerContainerExposesTerminationTailAndPodIdentity(t *testing.T) {
	container := buildPlacementJob(t).Spec.Template.Spec.Containers[0]
	if container.Name != job.WorkerContainerName {
		t.Fatalf("container name = %q", container.Name)
	}
	if container.TerminationMessagePolicy != corev1.TerminationMessageFallbackToLogsOnError {
		t.Fatalf("terminationMessagePolicy = %q, want FallbackToLogsOnError so a failed exit carries its last log line", container.TerminationMessagePolicy)
	}
	fields := map[string]string{}
	for _, variable := range container.Env {
		if variable.ValueFrom != nil && variable.ValueFrom.FieldRef != nil {
			fields[variable.Name] = variable.ValueFrom.FieldRef.FieldPath
		}
	}
	if fields[job.WorkerPodNameEnv] != "metadata.name" || fields[job.WorkerPodNamespaceEnv] != "metadata.namespace" {
		t.Fatalf("downward API env = %v, want pod name and namespace", fields)
	}
}
