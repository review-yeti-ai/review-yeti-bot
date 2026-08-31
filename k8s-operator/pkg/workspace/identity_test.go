package workspace_test

import (
	"regexp"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/workspace"
)

func TestWorkspaceKeySameRepositoryAndPRAcrossHeads(t *testing.T) {
	first := workspace.Key(123, 42)
	second := workspace.Key(123, 42)
	if first != second || !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(first) {
		t.Fatalf("unexpected deterministic key: first=%q second=%q", first, second)
	}
}

func TestWorkspaceKeyDiffersForRepositoryOrPR(t *testing.T) {
	base := workspace.Key(123, 42)
	if base == workspace.Key(124, 42) || base == workspace.Key(123, 43) {
		t.Fatal("workspace key must isolate repository and pull request identity")
	}
	if workspace.Key(0, 42) != "" || workspace.Key(123, 0) != "" {
		t.Fatal("invalid identity must not produce a reusable key")
	}
}

func TestWorkspaceNamesAndMetadataFitKubernetesContracts(t *testing.T) {
	key := workspace.Key(9223372036854775807, 2147483647)
	for _, name := range []string{
		workspace.PVCName(9223372036854775807, 2147483647),
		workspace.LeaseName(9223372036854775807, 2147483647),
	} {
		if len(name) > 63 || !regexp.MustCompile(`^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$`).MatchString(name) {
			t.Fatalf("invalid Kubernetes name %q", name)
		}
	}
	labels, annotations := workspace.Metadata(9223372036854775807, 2147483647)
	if labels[workspace.WorkspaceHashLabel] != key[:63] {
		t.Fatalf("hash label = %q, want first 63 characters", labels[workspace.WorkspaceHashLabel])
	}
	if annotations[workspace.WorkspaceKeyAnnotation] != key {
		t.Fatalf("full workspace key annotation = %q, want %q", annotations[workspace.WorkspaceKeyAnnotation], key)
	}
	if len(labels[workspace.WorkspaceHashLabel]) > 63 {
		t.Fatal("workspace hash label exceeds Kubernetes label-value limit")
	}
}

func TestValidateMetadataRejectsCrossPRAndTamperedIdentity(t *testing.T) {
	labels, annotations := workspace.Metadata(123, 42)
	metadata := metav1.ObjectMeta{
		Name:        workspace.PVCName(123, 42),
		Namespace:   "ct-review-system",
		Labels:      labels,
		Annotations: annotations,
	}
	if err := workspace.ValidateMetadata(metadata, "ct-review-system", workspace.PVCName(123, 42), 123, 42); err != nil {
		t.Fatalf("valid metadata rejected: %v", err)
	}
	metadata.Annotations[workspace.WorkspaceKeyAnnotation] = workspace.Key(123, 43)
	if err := workspace.ValidateMetadata(metadata, "ct-review-system", workspace.PVCName(123, 42), 123, 42); err == nil {
		t.Fatal("tampered full workspace identity must be rejected")
	}
}
