package workspace_test

import (
	"errors"
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
	mutations := map[string]func(*metav1.ObjectMeta){
		"full key annotation": func(candidate *metav1.ObjectMeta) {
			candidate.Annotations[workspace.WorkspaceKeyAnnotation] = workspace.Key(123, 43)
		},
		"repository label":   func(candidate *metav1.ObjectMeta) { candidate.Labels[workspace.RepositoryIDLabel] = "124" },
		"pull request label": func(candidate *metav1.ObjectMeta) { candidate.Labels[workspace.PRNumberLabel] = "43" },
		"hash label": func(candidate *metav1.ObjectMeta) {
			candidate.Labels[workspace.WorkspaceHashLabel] = workspace.Key(123, 43)[:63]
		},
		"namespace":     func(candidate *metav1.ObjectMeta) { candidate.Namespace = "other-system" },
		"resource name": func(candidate *metav1.ObjectMeta) { candidate.Name = workspace.PVCName(123, 43) },
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			candidate := metadata.DeepCopy()
			mutate(candidate)
			if err := workspace.ValidateMetadata(*candidate, "ct-review-system", workspace.PVCName(123, 42), 123, 42); !errors.Is(err, workspace.ErrWorkspaceIdentity) {
				t.Fatalf("tampered metadata error = %v, want ErrWorkspaceIdentity", err)
			}
		})
	}
}

func TestInvalidIdentityProducesNoResourceMetadata(t *testing.T) {
	for _, identity := range []struct {
		repositoryID int64
		prNumber     int32
	}{
		{repositoryID: 0, prNumber: 42},
		{repositoryID: 123, prNumber: 0},
	} {
		if workspace.PVCName(identity.repositoryID, identity.prNumber) != "" ||
			workspace.LeaseName(identity.repositoryID, identity.prNumber) != "" {
			t.Fatalf("invalid identity produced a Kubernetes resource name: %#v", identity)
		}
		labels, annotations := workspace.Metadata(identity.repositoryID, identity.prNumber)
		if labels != nil || annotations != nil {
			t.Fatalf("invalid identity produced metadata: labels=%v annotations=%v", labels, annotations)
		}
	}
}
