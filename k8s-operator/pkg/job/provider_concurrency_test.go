package job_test

import (
	"strings"
	"testing"
	"time"

	"github.com/review-yeti-ai/review-yeti-bot/k8s-operator/pkg/job"
)

// Cross-review provider concurrency: the three worker settings reach the
// app-gate worker verbatim when configured, stay absent when not, never reach
// the receipt-only lane, and a malformed value is dropped instead of refusing
// the Job.
func TestBuildWorkerJobForwardsProviderConcurrencyOnlyWhenSet(t *testing.T) {
	now := time.Date(2026, 10, 2, 18, 0, 0, 0, time.UTC)
	review := reviewFixture(now)
	review.Spec.PublicationMode = "app-gate"
	input := buildInput(review, now)
	input.Publishing = publishingFixture()

	names := map[string]string{
		job.ProviderLeasesEnv:           "REVIEW_YETI_PROVIDER_LEASES",
		job.ProviderLeaseKeyEnv:         "REVIEW_YETI_PROVIDER_LEASE_KEY",
		job.ProviderLocalConcurrencyEnv: "REVIEW_YETI_PROVIDER_LOCAL_CONCURRENCY",
	}
	for got, want := range names {
		if got != want {
			t.Fatalf("provider concurrency env drifted from the worker's name: %s != %s", got, want)
		}
	}

	baseline, err := job.BuildWorkerJob(input)
	if err != nil {
		t.Fatalf("build baseline app-gate job: %v", err)
	}
	for name := range names {
		if hasEnv(baseline.Spec.Template.Spec.Containers[0], name) {
			t.Fatalf("unset operator config must not reach the worker as %s", name)
		}
	}

	input.Publishing.ProviderLeases = "true"
	input.Publishing.ProviderLeaseKey = "pr-reviewer"
	input.Publishing.ProviderLocalConcurrency = "6"
	forwarded, err := job.BuildWorkerJob(input)
	if err != nil {
		t.Fatalf("build app-gate job with provider concurrency: %v", err)
	}
	container := forwarded.Spec.Template.Spec.Containers[0]
	for name, value := range map[string]string{
		job.ProviderLeasesEnv: "true", job.ProviderLeaseKeyEnv: "pr-reviewer", job.ProviderLocalConcurrencyEnv: "6",
	} {
		if got := envValue(container, name); got != value {
			t.Fatalf("operator must forward %s verbatim, got %q", name, got)
		}
	}
	if got, want := len(container.Env), len(baseline.Spec.Template.Spec.Containers[0].Env)+3; got != want {
		t.Fatalf("setting the three values must add exactly three env entries: got %d, want %d", got, want)
	}

	input.Publishing.ProviderLeaseKey = "pr reviewer"
	input.Publishing.ProviderLocalConcurrency = "6\n"
	dropped, err := job.BuildWorkerJob(input)
	if err != nil {
		t.Fatalf("a malformed provider concurrency value must not refuse the Job: %v", err)
	}
	droppedContainer := dropped.Spec.Template.Spec.Containers[0]
	if hasEnv(droppedContainer, job.ProviderLeaseKeyEnv) || hasEnv(droppedContainer, job.ProviderLocalConcurrencyEnv) {
		t.Fatalf("malformed provider concurrency values must be dropped at projection time")
	}
	if envValue(droppedContainer, job.ProviderLeasesEnv) != "true" {
		t.Fatalf("a well-formed sibling value must still be forwarded")
	}

	// Every drop condition, each next to a well-formed sibling that must
	// still be forwarded: over-long (257 bytes), a DEL byte, a tab, a NUL.
	// The 256-byte boundary itself is accepted.
	for _, tc := range []struct {
		name, key, local   string
		dropKey, dropLocal bool
	}{
		{name: "257-byte key", key: strings.Repeat("a", 257), local: "6", dropKey: true},
		{name: "256-byte key", key: strings.Repeat("a", 256), local: "6"},
		{name: "DEL in local cap", key: "pr-reviewer", local: "6\x7f", dropLocal: true},
		{name: "tab in key", key: "pr\treviewer", local: "6", dropKey: true},
		{name: "NUL in local cap", key: "pr-reviewer", local: "6\x00", dropLocal: true},
	} {
		input.Publishing.ProviderLeaseKey = tc.key
		input.Publishing.ProviderLocalConcurrency = tc.local
		built, err := job.BuildWorkerJob(input)
		if err != nil {
			t.Fatalf("%s: a malformed provider concurrency value must not refuse the Job: %v", tc.name, err)
		}
		c := built.Spec.Template.Spec.Containers[0]
		if hasEnv(c, job.ProviderLeaseKeyEnv) == tc.dropKey {
			t.Fatalf("%s: key projected=%v, want %v", tc.name, hasEnv(c, job.ProviderLeaseKeyEnv), !tc.dropKey)
		}
		if hasEnv(c, job.ProviderLocalConcurrencyEnv) == tc.dropLocal {
			t.Fatalf("%s: local cap projected=%v, want %v", tc.name, hasEnv(c, job.ProviderLocalConcurrencyEnv), !tc.dropLocal)
		}
		if envValue(c, job.ProviderLeasesEnv) != "true" {
			t.Fatalf("%s: a well-formed sibling value must still be forwarded", tc.name)
		}
	}

	input.Review.Spec.PublicationMode = "disabled"
	receipt, err := job.BuildWorkerJob(input)
	if err != nil {
		t.Fatalf("build receipt-only job: %v", err)
	}
	for name := range names {
		if hasEnv(receipt.Spec.Template.Spec.Containers[0], name) {
			t.Fatalf("disabled lane must not receive %s", name)
		}
	}
}
