package job_test

import (
	"strings"
	"testing"
	"time"

	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/job"
)

// REL-1139: REVIEW_YETI_SKIP_EMPTY_MODERATION must reach the app-gate worker
// verbatim when configured, stay absent when not, never reach the receipt-only
// lane, and never set any other flag.
func TestBuildWorkerJobForwardsSkipEmptyModerationOnlyWhenSet(t *testing.T) {
	now := time.Date(2026, 9, 25, 18, 0, 0, 0, time.UTC)
	review := reviewFixture(now)
	review.Spec.PublicationMode = "app-gate"
	input := buildInput(review, now)
	input.Publishing = publishingFixture()

	if job.SkipEmptyModerationEnv != "REVIEW_YETI_SKIP_EMPTY_MODERATION" {
		t.Fatalf("skip empty moderation env drifted from the worker's SKIP_EMPTY_MODERATION_FLAG: %s", job.SkipEmptyModerationEnv)
	}

	baseline, err := job.BuildWorkerJob(input)
	if err != nil {
		t.Fatalf("build baseline app-gate job: %v", err)
	}
	if hasEnv(baseline.Spec.Template.Spec.Containers[0], job.SkipEmptyModerationEnv) {
		t.Fatalf("unset operator config must not reach the worker as %s", job.SkipEmptyModerationEnv)
	}

	pilots := "review-yeti-ai/review-yeti-bot,calltelemetry/ct-meta"
	input.Publishing.SkipEmptyModeration = pilots
	forwarded, err := job.BuildWorkerJob(input)
	if err != nil {
		t.Fatalf("build app-gate job with skip empty moderation: %v", err)
	}
	container := forwarded.Spec.Template.Spec.Containers[0]
	if envValue(container, job.SkipEmptyModerationEnv) != pilots {
		t.Fatalf("operator must forward the %s allowlist verbatim, got %q", job.SkipEmptyModerationEnv, envValue(container, job.SkipEmptyModerationEnv))
	}
	count := 0
	for _, env := range container.Env {
		if env.Name == job.SkipEmptyModerationEnv {
			count++
			if env.ValueFrom != nil {
				t.Fatalf("%s must be a literal value, not a reference", job.SkipEmptyModerationEnv)
			}
		}
	}
	if count != 1 {
		t.Fatalf("%s projected %d times, want exactly once", job.SkipEmptyModerationEnv, count)
	}
	// Adding this flag adds exactly one env entry and changes nothing else.
	if got, want := len(container.Env), len(baseline.Spec.Template.Spec.Containers[0].Env)+1; got != want {
		t.Fatalf("setting the flag must add exactly one env entry: got %d, want %d", got, want)
	}

	for _, value := range []string{"off", "all", "calltelemetry/ct-meta review-yeti-ai/review-yeti-bot"} {
		input.Publishing.SkipEmptyModeration = value
		verbatim, err := job.BuildWorkerJob(input)
		if err != nil {
			t.Fatalf("build app-gate job with skip empty moderation %q: %v", value, err)
		}
		if got := envValue(verbatim.Spec.Template.Spec.Containers[0], job.SkipEmptyModerationEnv); got != value {
			t.Fatalf("operator must forward %q verbatim, got %q", value, got)
		}
	}

	input.Publishing.SkipEmptyModeration = pilots
	input.Review.Spec.PublicationMode = "disabled"
	receipt, err := job.BuildWorkerJob(input)
	if err != nil {
		t.Fatalf("build receipt-only job: %v", err)
	}
	if hasEnv(receipt.Spec.Template.Spec.Containers[0], job.SkipEmptyModerationEnv) {
		t.Fatalf("disabled lane must not receive %s", job.SkipEmptyModerationEnv)
	}
}

func TestBuildWorkerJobRefusesSkipEmptyModerationWithLineBreak(t *testing.T) {
	now := time.Date(2026, 9, 25, 18, 0, 0, 0, time.UTC)
	review := reviewFixture(now)
	review.Spec.PublicationMode = "app-gate"
	input := buildInput(review, now)
	input.Publishing = publishingFixture()
	for _, value := range []string{"calltelemetry/ct-meta\n", "a/b\r\nc/d"} {
		input.Publishing.SkipEmptyModeration = value
		if _, err := job.BuildWorkerJob(input); err == nil || !strings.Contains(err.Error(), "skip empty moderation flag") {
			t.Fatalf("a line break in the skip empty moderation flag must refuse the Job, got %v", err)
		}
	}
}
