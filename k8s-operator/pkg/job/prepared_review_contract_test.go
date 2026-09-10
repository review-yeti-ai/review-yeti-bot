package job_test

import (
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/job"
)

// TypeScript's preparedReviewExecutionContract.test.ts reads this same corpus.
// Go guarantees envelope/transport safety, not config digest/provider integrity
// or agreement with the worker's actual injected transport. Divergent expected
// results must be explicitly marked as that intentional integrity boundary.
func TestSharedPreparedReviewExecutionContract(t *testing.T) {
	contents, err := os.ReadFile("testdata/prepared-review-execution.json")
	if err != nil {
		t.Fatal(err)
	}
	var corpus struct {
		Version    string `json:"version"`
		ConfigJSON string `json:"configJson"`
		Cases      []struct {
			Name               string `json:"name"`
			JSON               string `json:"json"`
			PadToBytes         int    `json:"padToBytes"`
			EnvelopeAccepted   bool   `json:"envelopeAccepted"`
			TypescriptAccepted bool   `json:"typescriptAccepted"`
			IntegrityOnly      string `json:"integrityOnly"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(contents, &corpus); err != nil {
		t.Fatal(err)
	}
	if corpus.Version != "prepared-review-execution-contract.v1" || len(corpus.Cases) == 0 || corpus.ConfigJSON == "" {
		t.Fatal("missing or unsupported shared corpus")
	}
	seen := map[string]bool{}
	for _, fixture := range corpus.Cases {
		if seen[fixture.Name] || fixture.Name == "" {
			t.Fatal("fixture names must be nonempty and unique")
		}
		seen[fixture.Name] = true
		t.Run(fixture.Name, func(t *testing.T) {
			if fixture.EnvelopeAccepted != fixture.TypescriptAccepted {
				if !fixture.EnvelopeAccepted || fixture.TypescriptAccepted || fixture.IntegrityOnly == "" {
					t.Fatal("unexplained cross-language drift")
				}
			} else if fixture.IntegrityOnly != "" {
				t.Fatal("integrity-only fixture must demonstrate the intended boundary")
			}
			raw := strings.ReplaceAll(fixture.JSON, "$CONFIG", corpus.ConfigJSON)
			if fixture.PadToBytes != 0 {
				if fixture.PadToBytes < len(raw) {
					t.Fatal("fixture padding cannot truncate the envelope")
				}
				raw += strings.Repeat(" ", fixture.PadToBytes-len(raw))
			}
			now := time.Date(2026, 9, 9, 19, 0, 0, 0, time.UTC)
			review := reviewFixture(now)
			review.Spec.PublicationMode = "app-gate"
			review.Spec.RunnerMode = "prebaked"
			review.Spec.PreparedReview = &raw
			input := buildInput(review, now)
			input.Publishing = publishingFixture()
			built, err := job.BuildWorkerJob(input)
			if fixture.EnvelopeAccepted {
				if err != nil {
					t.Fatal(err)
				}
				container := built.Spec.Template.Spec.Containers[0]
				if envValue(container, job.PreparedConfigEnv) != raw || envValue(container, job.AuthoritativeGateEnv) != "true" {
					t.Fatal("shared envelope must pass through unchanged with explicit gate opt-in")
				}
			} else {
				if built != nil || !errors.Is(err, job.ErrJobConfiguration) {
					t.Fatalf("expected envelope configuration rejection, got %v", err)
				}
				if strings.Contains(err.Error(), "synthetic-private-marker") {
					t.Fatal("error exposed fixture diagnostics")
				}
			}
		})
	}
}
