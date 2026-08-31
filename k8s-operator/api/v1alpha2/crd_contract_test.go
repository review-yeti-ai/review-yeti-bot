package v1alpha2_test

import (
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"testing"

	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	"sigs.k8s.io/yaml"
)

func loadV1Alpha2CRD(t *testing.T) *apiextensionsv1.CustomResourceDefinition {
	t.Helper()
	path := filepath.Join("..", "..", "config", "crd", "bases", "review-yeti.ai_prreviewjobs.yaml")
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read CRD: %v", err)
	}
	var crd apiextensionsv1.CustomResourceDefinition
	if err := yaml.Unmarshal(contents, &crd); err != nil {
		t.Fatalf("parse CRD: %v", err)
	}
	return &crd
}

func TestV1Alpha2CRDIdentityAndClosedSpec(t *testing.T) {
	crd := loadV1Alpha2CRD(t)
	if crd.Name != "prreviewjobs.review-yeti.ai" || crd.Spec.Group != "review-yeti.ai" {
		t.Fatalf("unexpected CRD identity: name=%s group=%s", crd.Name, crd.Spec.Group)
	}
	if crd.Spec.Scope != apiextensionsv1.NamespaceScoped {
		t.Fatalf("scope = %s, want Namespaced", crd.Spec.Scope)
	}
	if len(crd.Spec.Versions) != 1 || crd.Spec.Versions[0].Name != "v1alpha2" || !crd.Spec.Versions[0].Served || !crd.Spec.Versions[0].Storage {
		t.Fatalf("unexpected versions: %#v", crd.Spec.Versions)
	}
	spec := crd.Spec.Versions[0].Schema.OpenAPIV3Schema.Properties["spec"]
	wantRequired := []string{
		"runId", "deliveryId", "repositoryId", "repo", "prNumber", "headSha", "baseSha",
		"receivedAt", "terminalDeadline", "policyDigest", "configDigest", "publicationMode",
		"workerImage", "runSecretName",
	}
	sort.Strings(wantRequired)
	gotRequired := append([]string(nil), spec.Required...)
	sort.Strings(gotRequired)
	if !reflect.DeepEqual(gotRequired, wantRequired) {
		t.Fatalf("required fields mismatch\n got: %v\nwant: %v", gotRequired, wantRequired)
	}
	gotProperties := make([]string, 0, len(spec.Properties))
	for field := range spec.Properties {
		gotProperties = append(gotProperties, field)
	}
	sort.Strings(gotProperties)
	if !reflect.DeepEqual(gotProperties, wantRequired) {
		t.Fatalf("schema exposes fields outside the immutable projection\n got: %v\nwant: %v", gotProperties, wantRequired)
	}
	if spec.XPreserveUnknownFields != nil && *spec.XPreserveUnknownFields {
		t.Fatal("spec must not preserve unknown fields")
	}

	rules := map[string]bool{}
	for _, validation := range spec.XValidations {
		rules[validation.Rule] = true
	}
	if !rules["self == oldSelf"] {
		t.Fatal("spec immutability rule is missing")
	}
	if !rules["timestamp(self.terminalDeadline) - timestamp(self.receivedAt) == duration('900s')"] {
		t.Fatal("exact 15-minute deadline rule is missing")
	}
}

func TestV1Alpha2CRDStrictIdentityPatterns(t *testing.T) {
	spec := loadV1Alpha2CRD(t).Spec.Versions[0].Schema.OpenAPIV3Schema.Properties["spec"]
	wants := map[string]string{
		"runId":         `^run_[a-f0-9]{32}$`,
		"repo":          `^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?/[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$`,
		"headSha":       `^[a-f0-9]{40}$`,
		"baseSha":       `^[a-f0-9]{40}$`,
		"policyDigest":  `^[a-f0-9]{64}$`,
		"configDigest":  `^[a-f0-9]{64}$`,
		"workerImage":   `^registry\.digitalocean\.com/calltelemetry/review-yeti-worker@sha256:[a-f0-9]{64}$`,
		"runSecretName": `^ct-review-run-[a-f0-9]{32}$`,
	}
	for field, want := range wants {
		got := spec.Properties[field].Pattern
		if got != want {
			t.Errorf("%s pattern = %q, want %q", field, got, want)
		}
		if _, err := regexp.Compile(got); err != nil {
			t.Errorf("%s pattern does not compile: %v", field, err)
		}
	}
	publication := spec.Properties["publicationMode"]
	if len(publication.Enum) != 1 || string(publication.Enum[0].Raw) != `"disabled"` {
		t.Fatalf("publicationMode enum = %#v, want disabled only", publication.Enum)
	}
	if spec.Properties["repositoryId"].Minimum == nil || *spec.Properties["repositoryId"].Minimum != 1 {
		t.Fatal("repositoryId minimum must be one")
	}
	if spec.Properties["prNumber"].Minimum == nil || *spec.Properties["prNumber"].Minimum != 1 {
		t.Fatal("prNumber minimum must be one")
	}
}

func TestV1Alpha2CRDExposesBoundedTimingReceipt(t *testing.T) {
	status := loadV1Alpha2CRD(t).Spec.Versions[0].Schema.OpenAPIV3Schema.Properties["status"]
	timing, ok := status.Properties["timing"]
	if !ok {
		t.Fatal("status.timing is missing")
	}
	want := []string{"completedAt", "imageObservedAt", "jobCreatedAt", "podScheduledAt", "processStartedAt", "receivedAt"}
	got := make([]string, 0, len(timing.Properties))
	for field := range timing.Properties {
		got = append(got, field)
	}
	sort.Strings(got)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("timing fields mismatch\n got: %v\nwant: %v", got, want)
	}
	if timing.XPreserveUnknownFields != nil && *timing.XPreserveUnknownFields {
		t.Fatal("timing must not preserve unknown fields")
	}
	for field, schema := range timing.Properties {
		if schema.Type != "string" || schema.Format != "date-time" {
			t.Fatalf("timing.%s schema = %#v, want date-time string", field, schema)
		}
	}
}
