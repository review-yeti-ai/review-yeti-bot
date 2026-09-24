package v1alpha2_test

import (
	v1alpha2 "github.com/calltelemetry/ct-review-bot/k8s-operator/api/v1alpha2"
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

// REL-1073: the spec is immutable except that cancelRequested may go from
// absent/false to true once. A companion rule pins every other field; see
// crd_cel_test.go for the evaluated behaviour.
const cancelTransitionRule = "self == oldSelf || (has(self.cancelRequested) && self.cancelRequested && !(has(oldSelf.cancelRequested) && oldSelf.cancelRequested))"

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
	wantProperties = append(wantProperties, "cancelReason", "cancelRequested", "executionAttempt", "preparedReview", "qualificationModel", "qualificationProfile", "runnerMode")
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
	if !rules[cancelTransitionRule] {
		t.Fatal("spec immutability rule (one-way cancelRequested transition) is missing")
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
		// workerImage pins DIGEST, not registry. The previous pattern named two
		// CallTelemetry registries, which blocked self-hosted installs outright
		// while still permitting a mutable tag inside the vendor namespace
		// (`ghcr.io/review-yeti-ai/<any>:<tag>`). Requiring a sha256 digest on
		// every non-node image is strictly stronger and tenant-neutral.
		"workerImage":   `^(?:[a-z0-9](?:[a-z0-9._/-]*[a-z0-9])?(?::[0-9]{1,5})?(?:/[a-zA-Z0-9._/-]+)?@sha256:[a-f0-9]{64}|node:[a-zA-Z0-9_.-]+@sha256:[a-f0-9]{64}|node:[a-zA-Z0-9_.-]+)$`,
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
	if !rules[cancelTransitionRule] ||
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
// The chart ships a byte-identical copy of the generated CRD, and
// TestHelmChartCRDMatchesGeneratedWorkerTermination guards ONE property
// (status.workerTermination). That narrow scope is exactly how a stale
// workerImage pattern could ship: the chart copy is what Helm installs, so a
// divergence there keeps enforcing an old control while every test stays green.
//
// This compares spec.workerImage specifically — the field that carried the
// registry allowlist and is duplicated across five artifacts. It is named for
// what it asserts rather than claiming full-spec parity it does not check.
func TestHelmChartCRDWorkerImageMatchesGenerated(t *testing.T) {
	path := filepath.Join("..", "..", "..", "charts", "review-yeti", "files", "review-yeti.ai_prreviewjobs.yaml")
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
	var chartSpec *apiextensionsv1.JSONSchemaProps
	for index := range chart.Spec.Versions {
		if chart.Spec.Versions[index].Name == "v1alpha2" {
			spec := chart.Spec.Versions[index].Schema.OpenAPIV3Schema.Properties["spec"]
			chartSpec = &spec
		}
	}
	if chartSpec == nil {
		t.Fatal("chart CRD has no v1alpha2 version")
	}
	generatedSpec := loadV1Alpha2CRD(t).Spec.Versions[0].Schema.OpenAPIV3Schema.Properties["spec"]

	// Compare the workerImage contract specifically, which is the field that
	// carried the registry allowlist and is duplicated across four artifacts.
	chartImage, ok := chartSpec.Properties["workerImage"]
	if !ok {
		t.Fatal("chart CRD lacks spec.workerImage")
	}
	generatedImage := generatedSpec.Properties["workerImage"]
	if chartImage.Pattern != generatedImage.Pattern {
		t.Fatalf("chart CRD workerImage pattern diverged from the generated CRD\n"+
			"  chart:     %s\n  generated: %s", chartImage.Pattern, generatedImage.Pattern)
	}
	if chartImage.Pattern != v1alpha2.WorkerImagePattern {
		t.Fatalf("chart CRD workerImage pattern does not match v1alpha2.WorkerImagePattern\n"+
			"  chart:    %s\n  exported: %s", chartImage.Pattern, v1alpha2.WorkerImagePattern)
	}
}

func TestHelmChartCRDMatchesGeneratedWorkerTermination(t *testing.T) {
	// REL-1097: the chart installs files/review-yeti.ai_prreviewjobs.yaml, a
	// byte-identical copy of the generated CRD; templates/crd.yaml only loads it.
	path := filepath.Join("..", "..", "..", "charts", "review-yeti", "files", "review-yeti.ai_prreviewjobs.yaml")
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

// The pattern assertions above compare pattern STRINGS, which cannot tell a
// working control from a decorative one: a pattern that permits everything
// would still match its own expected string. These cases EXECUTE the shipped
// pattern against real inputs, so weakening it fails here (ADR 0641).
func TestV1Alpha2WorkerImagePatternIsExecutable(t *testing.T) {
	spec := loadV1Alpha2CRD(t).Spec.Versions[0].Schema.OpenAPIV3Schema.Properties["spec"]
	pattern, err := regexp.Compile(spec.Properties["workerImage"].Pattern)
	if err != nil {
		t.Fatalf("workerImage pattern does not compile: %v", err)
	}
	digest := "sha256:" + strings.Repeat("a", 64)
	cases := []struct {
		name  string
		image string
		want  bool
	}{
		// Legitimate, including a self-hoster's own registry — the whole point.
		{"vendor digest", "ghcr.io/review-yeti-ai/review-yeti-worker@" + digest, true},
		{"self-host registry digest", "registry.partner.example/rev/worker@" + digest, true},
		{"registry with port", "registry.partner.example:5000/rev/worker@" + digest, true},
		{"docker hub library image, digest-pinned", "alpine@sha256:" + strings.Repeat("a", 64), true},
		{"single-segment name, digest-pinned", "busybox@sha256:" + strings.Repeat("a", 64), true},
		{"docker hub library image, mutable tag", "alpine:latest", false},
		{"generic runner, tag", "node:20-alpine", true},
		{"generic runner, digest-pinned", "node:20-alpine@sha256:" + strings.Repeat("a", 64), true},

		// Attacks the OLD pattern permitted. These are the regressions that
		// matter: a mutable tag inside the vendor namespace was accepted before.
		{"mutable tag in vendor namespace", "ghcr.io/review-yeti-ai/evil:latest", false},
		{"vendor worker without digest", "ghcr.io/review-yeti-ai/review-yeti-worker:latest", false},
		{"untagged foreign image", "evil.example/backdoor", false},
		{"mutable tag foreign", "evil.example/backdoor:latest", false},
		{"digest too short", "ghcr.io/review-yeti-ai/review-yeti-worker@sha256:" + strings.Repeat("a", 63), false},
		{"digest not hex", "ghcr.io/review-yeti-ai/review-yeti-worker@sha256:" + strings.Repeat("z", 64), false},
		{"empty", "", false},
	}
	for _, tc := range cases {
		if got := pattern.MatchString(tc.image); got != tc.want {
			t.Errorf("%s: pattern.MatchString(%q) = %v, want %v", tc.name, tc.image, got, tc.want)
		}
	}
}

// The runtime validator in pkg/job must describe the SAME control as this CRD.
//
// The worker image pattern is necessarily duplicated: the kubebuilder marker is
// a compile-time literal controller-gen reads, and the chart freezes the
// generated CRD. The runtime copy is the one with execution authority, so a
// broadening that updates only the marker fails at reconciliation rather than
// admission — silently ineffective. Review Yeti caught exactly that. This test
// makes a one-sided edit fail here instead of shipping.
func TestWorkerImagePatternMatchesCRD(t *testing.T) {
	spec := loadV1Alpha2CRD(t).Spec.Versions[0].Schema.OpenAPIV3Schema.Properties["spec"]
	if spec.Properties["workerImage"].Pattern != v1alpha2.WorkerImagePattern {
		t.Fatalf("CRD workerImage pattern diverged from v1alpha2.WorkerImagePattern\n"+
			"  crd:      %s\n  exported: %s", spec.Properties["workerImage"].Pattern, v1alpha2.WorkerImagePattern)
	}
}

// The workerImage contract constrains integrity (immutable reference) but not
// provenance (who published it), so the trust boundary moved from the schema to
// the deployment. This asserts the schema's own documentation states that, so a
// future relaxation cannot silently drop the warning a multi-tenant operator
// needs in order to add RBAC or publisher verification.
func TestWorkerImageDocumentsTheProvenanceAssumption(t *testing.T) {
	spec := loadV1Alpha2CRD(t).Spec.Versions[0].Schema.OpenAPIV3Schema.Properties["spec"]
	description := spec.Properties["workerImage"].Description
	for _, want := range []string{"PROVENANCE", "multi-tenant", "RBAC"} {
		if !strings.Contains(description, want) {
			t.Errorf("workerImage description must state the provenance assumption; "+
				"missing %q.\nThis matters because the pattern accepts any registry, so a "+
				"less-trusted principal who can write PRReviewJobs chooses executed code.", want)
		}
	}
}
