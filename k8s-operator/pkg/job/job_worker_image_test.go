package job

import (
	"strings"
	"testing"
)

// The runtime validator is the copy with EXECUTION authority: a value the CRD
// admits but this pattern rejects fails at reconciliation, not admission, so a
// one-sided contract change is silently ineffective. Review Yeti found exactly
// that on the change that moved the contract to digest pinning.
//
// This drives real inputs through the runtime matcher (not the CRD's), so a
// future divergence fails here rather than in production.
func TestWorkerImagePatternPinsDigestNotRegistry(t *testing.T) {
	digest := "sha256:" + strings.Repeat("a", 64)
	cases := []struct {
		name  string
		image string
		want  bool
	}{
		// A self-hoster's own registry is the whole point of the change.
		{"self-host registry, digest-pinned", "registry.partner.example/rev/worker@" + digest, true},
		{"registry with port", "registry.partner.example:5000/rev/worker@" + digest, true},
		{"vendor digest", "ghcr.io/review-yeti-ai/review-yeti-worker@" + digest, true},
		{"generic runner mode", "node:20-alpine", true},

		// The regression this guards: a mutable tag must not pass anywhere,
		// including inside the vendor namespace where the old pattern allowed it.
		{"mutable tag in vendor namespace", "ghcr.io/review-yeti-ai/evil:latest", false},
		{"vendor worker without digest", "ghcr.io/review-yeti-ai/review-yeti-worker:latest", false},
		{"foreign mutable tag", "evil.example/backdoor:latest", false},
		{"untagged", "evil.example/backdoor", false},
	}
	for _, tc := range cases {
		if got := workerImagePattern.MatchString(tc.image); got != tc.want {
			t.Errorf("%s: workerImagePattern.MatchString(%q) = %v, want %v",
				tc.name, tc.image, got, tc.want)
		}
	}
}
