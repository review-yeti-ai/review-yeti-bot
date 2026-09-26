package main

import "testing"

// REL-1139: the empty-moderation skip has no default -- unset forwards nothing.
func TestPublishingConfigFromEnvReadsSkipEmptyModeration(t *testing.T) {
	t.Setenv("REVIEW_YETI_SKIP_EMPTY_MODERATION", "")
	if config := publishingConfigFromEnv(); config.SkipEmptyModeration != "" {
		t.Fatalf("unset skip empty moderation flag must stay empty: %+v", config)
	}
	t.Setenv("REVIEW_YETI_SKIP_EMPTY_MODERATION", " review-yeti-ai/review-yeti-bot,calltelemetry/ct-meta ")
	if config := publishingConfigFromEnv(); config.SkipEmptyModeration != "review-yeti-ai/review-yeti-bot,calltelemetry/ct-meta" {
		t.Fatalf("skip empty moderation flag not read: %+v", config)
	}
}
