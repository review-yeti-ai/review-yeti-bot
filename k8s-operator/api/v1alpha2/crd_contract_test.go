package v1alpha2_test

import (
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
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
	wantProperties := append([]string(nil), wantRequired...)
	wantProperties = append(wantProperties, "executionAttempt", "preparedReview", "qualificationModel", "qualificationProfile", "runnerMode")
	sort.Strings(wantRequired)
	sort.Strings(wantProperties)
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
	if !reflect.DeepEqual(gotProperties, wantProperties) {
		t.Fatalf("schema exposes fields outside the immutable projection\n got: %v\nwant: %v", gotProperties, wantProperties)
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
	if !rules["duration('900s') <= (timestamp(self.terminalDeadline) - timestamp(self.receivedAt)) && (timestamp(self.terminalDeadline) - timestamp(self.receivedAt)) <= duration('3600s')"] {
		t.Fatal("bounded 15-to-60-minute deadline rule is missing")
	}
	if !rules["(!has(self.qualificationProfile) && !has(self.qualificationModel)) || (self.qualificationProfile in ['full-panel', 'same-head'] && has(self.qualificationModel) && self.qualificationModel != 'auto' && self.qualificationModel != 'openrouter/auto')"] {
		t.Fatal("qualification profile/model rule is missing")
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
		"workerImage":   `^(?:(?:ghcr\.io/review-yeti-ai/review-yeti-worker|registry\.digitalocean\.com/calltelemetry/review-yeti-worker)@sha256:[a-f0-9]{64}|node:[a-zA-Z0-9_.-]+|ghcr\.io/review-yeti-ai/[a-zA-Z0-9_.-]+:[a-zA-Z0-9_.-]+)$`,
		"runSecretName": `^ct-review-run-[a-f0-9]{32}(-a[1-9][0-9]*)?$`,
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
	if len(publication.Enum) != 2 || string(publication.Enum[0].Raw) != `"disabled"` || string(publication.Enum[1].Raw) != `"app-gate"` {
		t.Fatalf("publicationMode enum = %#v, want disabled and app-gate", publication.Enum)
	}
	if spec.Properties["repositoryId"].Minimum == nil || *spec.Properties["repositoryId"].Minimum != 1 {
		t.Fatal("repositoryId minimum must be one")
	}
	if spec.Properties["prNumber"].Minimum == nil || *spec.Properties["prNumber"].Minimum != 1 {
		t.Fatal("prNumber minimum must be one")
	}
	attempt := spec.Properties["executionAttempt"]
	if attempt.Type != "integer" || attempt.Format != "int32" || attempt.Minimum == nil || *attempt.Minimum != 1 ||
		attempt.Maximum == nil || *attempt.Maximum != 2_147_483_647 {
		t.Fatalf("executionAttempt bounds = type %q/format %q/min %v/max %v, want positive int32",
			attempt.Type, attempt.Format, attempt.Minimum, attempt.Maximum)
	}
	profile := spec.Properties["qualificationProfile"]
	if len(profile.Enum) != 2 || string(profile.Enum[0].Raw) != `"full-panel"` || string(profile.Enum[1].Raw) != `"same-head"` {
		t.Fatalf("qualificationProfile enum = %#v, want full-panel and same-head", profile.Enum)
	}
	model := spec.Properties["qualificationModel"]
	if model.MinLength == nil || *model.MinLength != 1 || model.MaxLength == nil || *model.MaxLength != 256 {
		t.Fatalf("qualificationModel bounds = min %v/max %v, want 1/256", model.MinLength, model.MaxLength)
	}
}

func TestV1Alpha2CRDPreparedReviewIsOptionalBoundedAndImmutable(t *testing.T) {
	spec := loadV1Alpha2CRD(t).Spec.Versions[0].Schema.OpenAPIV3Schema.Properties["spec"]
	prepared := spec.Properties["preparedReview"]
	if prepared.Type != "string" || prepared.MinLength == nil || *prepared.MinLength != 1 ||
		prepared.MaxLength == nil || *prepared.MaxLength != 256*1024 || prepared.Default != nil {
		t.Fatal("preparedReview must be a bounded nonempty string without a default")
	}
	for _, required := range spec.Required {
		if required == "preparedReview" {
			t.Fatal("preparedReview must remain optional for legacy CRs")
		}
	}
	rules := map[string]bool{}
	for _, validation := range spec.XValidations {
		rules[validation.Rule] = true
	}
	if !rules["self == oldSelf"] ||
		!rules["!has(self.preparedReview) || (self.publicationMode == 'app-gate' && (!has(self.runnerMode) || self.runnerMode == 'prebaked'))"] {
		t.Fatal("preparedReview must remain immutable and restricted to the prebaked app-gate lane")
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

// REL-1038: status.workerTermination must survive structural pruning (a field
// missing from the schema is silently dropped by the API server) and stay
// bounded so a worker's last log line cannot grow the object without limit.
func TestV1Alpha2CRDExposesBoundedWorkerTermination(t *testing.T) {
	status := loadV1Alpha2CRD(t).Spec.Versions[0].Schema.OpenAPIV3Schema.Properties["status"]
	termination, ok := status.Properties["workerTermination"]
	if !ok {
		t.Fatal("status.workerTermination is missing; the API server would prune the forensic record")
	}
	want := []string{"containerName", "exitCode", "finishedAt", "message", "nodeName", "observedAt", "podName", "podReason", "reason", "signal", "startedAt"}
	got := make([]string, 0, len(termination.Properties))
	for field := range termination.Properties {
		got = append(got, field)
	}
	sort.Strings(got)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("workerTermination fields mismatch\n got: %v\nwant: %v", got, want)
	}
	if termination.XPreserveUnknownFields != nil && *termination.XPreserveUnknownFields {
		t.Fatal("workerTermination must not preserve unknown fields")
	}
	bounds := map[string]int64{"message": 1024, "reason": 128, "podReason": 128, "podName": 253, "nodeName": 253, "containerName": 63}
	for field, limit := range bounds {
		schema := termination.Properties[field]
		if schema.Type != "string" || schema.MaxLength == nil || *schema.MaxLength != limit {
			t.Errorf("workerTermination.%s = type %q maxLength %v, want string bounded at %d", field, schema.Type, schema.MaxLength, limit)
		}
	}
	for _, field := range []string{"exitCode", "signal"} {
		if schema := termination.Properties[field]; schema.Type != "integer" || schema.Format != "int32" {
			t.Errorf("workerTermination.%s = %#v, want int32", field, schema)
		}
	}
	for _, field := range []string{"startedAt", "finishedAt", "observedAt"} {
		if schema := termination.Properties[field]; schema.Type != "string" || schema.Format != "date-time" {
			t.Errorf("workerTermination.%s = %#v, want date-time", field, schema)
		}
	}
}

// The Helm chart ships a hand-maintained copy of the CRD. A status field the
// chart copy lacks is pruned on Helm-installed clusters, so workerTermination
// must match the generated schema field for field (descriptions aside).
func TestHelmChartCRDMatchesGeneratedWorkerTermination(t *testing.T) {
	path := filepath.Join("..", "..", "..", "charts", "review-yeti", "templates", "crd.yaml")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read chart CRD: %v", err)
	}
	lines := strings.Split(string(raw), "\n")
	kept := lines[:0]
	for _, line := range lines {
		if !strings.Contains(line, "{{") {
			kept = append(kept, line)
		}
	}
	var chart apiextensionsv1.CustomResourceDefinition
	if err := yaml.Unmarshal([]byte(strings.Join(kept, "\n")), &chart); err != nil {
		t.Fatalf("parse chart CRD: %v", err)
	}
	var chartStatus *apiextensionsv1.JSONSchemaProps
	for index := range chart.Spec.Versions {
		if chart.Spec.Versions[index].Name == "v1alpha2" {
			status := chart.Spec.Versions[index].Schema.OpenAPIV3Schema.Properties["status"]
			chartStatus = &status
		}
	}
	if chartStatus == nil {
		t.Fatal("chart CRD has no v1alpha2 version")
	}
	generated := loadV1Alpha2CRD(t).Spec.Versions[0].Schema.OpenAPIV3Schema.Properties["status"].Properties["workerTermination"]
	fromChart, ok := chartStatus.Properties["workerTermination"]
	if !ok {
		t.Fatal("chart CRD lacks status.workerTermination (it must sit directly under status.properties)")
	}
	strip := func(schema apiextensionsv1.JSONSchemaProps) apiextensionsv1.JSONSchemaProps {
		schema.Description = ""
		required := append([]string(nil), schema.Required...)
		sort.Strings(required)
		schema.Required = required
		properties := map[string]apiextensionsv1.JSONSchemaProps{}
		for name, property := range schema.Properties {
			property.Description = ""
			properties[name] = property
		}
		schema.Properties = properties
		return schema
	}
	if got, want := strip(fromChart), strip(generated); !reflect.DeepEqual(got, want) {
		t.Fatalf("chart workerTermination schema drifted from config/crd/bases\nchart: %#v\n  gen: %#v", got, want)
	}
}
