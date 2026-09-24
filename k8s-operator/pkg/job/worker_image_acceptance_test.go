package job_test

import (
	"strings"
	"testing"
	"time"

	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/job"
)

// The headline fix of REL-1025 is that BuildWorkerJob now ACCEPTS a digest-pinned
// image from a non-vendor registry — that acceptance is what makes self-hosting
// possible at all.
//
// Review Yeti caught that this was only asserted at the regexp level. The
// rejection suite exercises two unpinned images, which traverse the same path,
// but nothing proved the BUILD path accepts a partner's own registry. If
// BuildWorkerJob retains any over-rejection beyond the shared matcher — a stale
// host check, a second conditional — every test would still pass while the bug
// silently reproduced in production.
func TestBuildWorkerJobAcceptsDigestPinnedForeignImage(t *testing.T) {
	digest := "sha256:" + strings.Repeat("a", 64)
	now := time.Now()
	for _, image := range []string{
		"registry.partner.example/rev/worker@" + digest, // the self-host case
		"ghcr.io/review-yeti-ai/review-yeti-worker@" + digest,
	} {
		review := reviewFixture(now)
		review.Spec.WorkerImage = image
		if _, err := job.BuildWorkerJob(buildInput(review, now)); err != nil {
			t.Errorf("BuildWorkerJob rejected a digest-pinned image %q: %v", image, err)
		}
	}
}
