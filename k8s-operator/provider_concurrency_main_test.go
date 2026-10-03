package main

import "testing"

func TestPublishingConfigFromEnvReadsProviderConcurrency(t *testing.T) {
	t.Setenv("REVIEW_YETI_PROVIDER_LEASES", "")
	t.Setenv("REVIEW_YETI_PROVIDER_LEASE_KEY", "")
	t.Setenv("REVIEW_YETI_PROVIDER_LOCAL_CONCURRENCY", "")
	if config := publishingConfigFromEnv(); config.ProviderLeases != "" || config.ProviderLeaseKey != "" || config.ProviderLocalConcurrency != "" {
		t.Fatalf("unset provider concurrency settings must stay empty: %+v", config)
	}
	t.Setenv("REVIEW_YETI_PROVIDER_LEASES", " true ")
	t.Setenv("REVIEW_YETI_PROVIDER_LEASE_KEY", "pr-reviewer")
	t.Setenv("REVIEW_YETI_PROVIDER_LOCAL_CONCURRENCY", "6")
	config := publishingConfigFromEnv()
	if config.ProviderLeases != "true" || config.ProviderLeaseKey != "pr-reviewer" || config.ProviderLocalConcurrency != "6" {
		t.Fatalf("provider concurrency settings not read: %+v", config)
	}
}
