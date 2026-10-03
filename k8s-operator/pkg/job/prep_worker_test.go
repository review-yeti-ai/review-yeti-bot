/*
Copyright 2026 Review Yeti.

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
	"testing"
	"time"

	"github.com/review-yeti-ai/review-yeti-bot/k8s-operator/pkg/job"
)

func TestBuildWorkerJobWithPrepPhase(t *testing.T) {
	now := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)
	review := reviewFixture(now)
	input := buildInput(review, now)
	input.Phase = job.JobPhasePrep

	built, err := job.BuildWorkerJob(input)
	if err != nil {
		t.Fatalf("BuildWorkerJob failed: %v", err)
	}

	// 1. Verify label review-yeti.ai/job-phase: prep
	if built.Labels[job.JobPhaseLabel] != job.JobPhasePrep {
		t.Errorf("job label %s = %q, want %q", job.JobPhaseLabel, built.Labels[job.JobPhaseLabel], job.JobPhasePrep)
	}
	if built.Spec.Template.Labels[job.JobPhaseLabel] != job.JobPhasePrep {
		t.Errorf("pod template label %s = %q, want %q", job.JobPhaseLabel, built.Spec.Template.Labels[job.JobPhaseLabel], job.JobPhasePrep)
	}

	// 2. Verify env var CT_PHASE=prep
	var foundPhaseEnv bool
	for _, env := range built.Spec.Template.Spec.Containers[0].Env {
		if env.Name == job.PhaseEnvVar {
			foundPhaseEnv = true
			if env.Value != job.JobPhasePrep {
				t.Errorf("env %s = %q, want %q", job.PhaseEnvVar, env.Value, job.JobPhasePrep)
			}
		}
	}
	if !foundPhaseEnv {
		t.Errorf("expected container to have env %s=%q", job.PhaseEnvVar, job.JobPhasePrep)
	}

	// 3. Verify IsPrepWorkerJob helper
	if !job.IsPrepWorkerJob(built) {
		t.Errorf("IsPrepWorkerJob(built) = false, want true")
	}

	// 4. Verify PriorityClassName
	if built.Spec.Template.Spec.PriorityClassName != job.WorkerPriorityClassName {
		t.Errorf("pod template priorityClassName = %q, want %q", built.Spec.Template.Spec.PriorityClassName, job.WorkerPriorityClassName)
	}
}
