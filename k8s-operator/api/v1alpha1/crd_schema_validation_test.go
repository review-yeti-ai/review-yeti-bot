package v1alpha1_test

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"testing"

	"sigs.k8s.io/yaml"
)

// CRDValidator validates YAML manifests against rules parsed directly from the CRD OpenAPI schema.
type CRDValidator struct {
	RequiredSpecFields []string
	RepoRegex          *regexp.Regexp
	MinPRNumber        int
	MinSHALength       int
	MinTTL             *int
	AllowedPhases      map[string]bool
}

func loadCRDValidator(t *testing.T) *CRDValidator {
	crdPath := filepath.Join("..", "..", "config", "crd", "bases", "review.calltelemetry.com_prreviewjobs.yaml")
	crdBytes, err := os.ReadFile(crdPath)
	if err != nil {
		t.Fatalf("Failed to read CRD file at %s: %v", crdPath, err)
	}

	var rawCRD map[string]interface{}
	err = yaml.Unmarshal(crdBytes, &rawCRD)
	if err != nil {
		t.Fatalf("Failed to unmarshal CRD YAML: %v", err)
	}

	specMap, ok := rawCRD["spec"].(map[string]interface{})
	if !ok {
		t.Fatalf("CRD missing spec map")
	}
	versions, ok := specMap["versions"].([]interface{})
	if !ok || len(versions) == 0 {
		t.Fatalf("CRD missing versions")
	}

	ver0, ok := versions[0].(map[string]interface{})
	if !ok {
		t.Fatalf("CRD version[0] invalid")
	}
	schema, ok := ver0["schema"].(map[string]interface{})
	if !ok {
		t.Fatalf("CRD schema missing")
	}
	openAPI, ok := schema["openAPIV3Schema"].(map[string]interface{})
	if !ok {
		t.Fatalf("CRD openAPIV3Schema missing")
	}

	props, _ := openAPI["properties"].(map[string]interface{})
	specProp, _ := props["spec"].(map[string]interface{})
	reqFieldsRaw, _ := specProp["required"].([]interface{})

	var reqFields []string
	for _, rf := range reqFieldsRaw {
		if s, ok := rf.(string); ok {
			reqFields = append(reqFields, s)
		}
	}

	specProps, _ := specProp["properties"].(map[string]interface{})
	repoProp, _ := specProps["repo"].(map[string]interface{})
	repoPattern, _ := repoProp["pattern"].(string)
	repoRegex, err := regexp.Compile(repoPattern)
	if err != nil {
		t.Fatalf("Failed to compile repo pattern %s: %v", repoPattern, err)
	}

	prProp, _ := specProps["prNumber"].(map[string]interface{})
	minPR := 1
	if minVal, ok := prProp["minimum"].(float64); ok {
		minPR = int(minVal)
	}

	headShaProp, _ := specProps["headSha"].(map[string]interface{})
	minSHA := 7
	if minL, ok := headShaProp["minLength"].(float64); ok {
		minSHA = int(minL)
	}

	ttlProp, _ := specProps["ttlSecondsAfterFinished"].(map[string]interface{})
	var minTTL *int
	if minVal, ok := ttlProp["minimum"].(float64); ok {
		v := int(minVal)
		minTTL = &v
	}

	statusProp, _ := props["status"].(map[string]interface{})
	statusProps, _ := statusProp["properties"].(map[string]interface{})
	phaseProp, _ := statusProps["phase"].(map[string]interface{})
	enumRaw, _ := phaseProp["enum"].([]interface{})

	allowedPhases := make(map[string]bool)
	for _, e := range enumRaw {
		if s, ok := e.(string); ok {
			allowedPhases[s] = true
		}
	}

	return &CRDValidator{
		RequiredSpecFields: reqFields,
		RepoRegex:          repoRegex,
		MinPRNumber:        minPR,
		MinSHALength:       minSHA,
		MinTTL:             minTTL,
		AllowedPhases:      allowedPhases,
	}
}

func (v *CRDValidator) ValidateManifest(yamlStr string) []string {
	var obj map[string]interface{}
	err := yaml.Unmarshal([]byte(yamlStr), &obj)
	if err != nil {
		return []string{fmt.Sprintf("manifest unmarshal error: %v", err)}
	}

	var errs []string
	spec, ok := obj["spec"].(map[string]interface{})
	if !ok {
		return []string{"spec missing"}
	}

	// Validate required fields
	for _, req := range v.RequiredSpecFields {
		val, exists := spec[req]
		if !exists || val == nil {
			errs = append(errs, fmt.Sprintf("spec.%s required", req))
		} else if slice, ok := val.([]interface{}); ok && len(slice) == 0 {
			errs = append(errs, fmt.Sprintf("spec.%s required", req))
		}
	}

	// Validate repo pattern
	if repo, ok := spec["repo"].(string); ok {
		if !v.RepoRegex.MatchString(repo) {
			errs = append(errs, fmt.Sprintf("spec.repo invalid pattern: %s", repo))
		}
	}

	// Validate prNumber
	if pr, ok := spec["prNumber"].(float64); ok {
		if int(pr) < v.MinPRNumber {
			errs = append(errs, fmt.Sprintf("spec.prNumber minimum error: %d", int(pr)))
		}
	}

	// Validate headSha / baseSha minLength
	if headSha, ok := spec["headSha"].(string); ok {
		if len(headSha) < v.MinSHALength {
			errs = append(errs, fmt.Sprintf("spec.headSha length error: %s", headSha))
		}
	}
	if baseSha, ok := spec["baseSha"].(string); ok {
		if len(baseSha) < v.MinSHALength {
			errs = append(errs, fmt.Sprintf("spec.baseSha length error: %s", baseSha))
		}
	}

	// Validate ttlSecondsAfterFinished
	if ttl, ok := spec["ttlSecondsAfterFinished"].(float64); ok && v.MinTTL != nil {
		if int(ttl) < *v.MinTTL {
			errs = append(errs, fmt.Sprintf("spec.ttlSecondsAfterFinished minimum error: %d", int(ttl)))
		}
	}

	// Validate phase if present in status
	if status, ok := obj["status"].(map[string]interface{}); ok {
		if phase, ok := status["phase"].(string); ok {
			if !v.AllowedPhases[phase] {
				errs = append(errs, fmt.Sprintf("status.phase invalid enum: %s", phase))
			}
		}
	}

	return errs
}

func TestCRDSchemaValidation_ValidManifest(t *testing.T) {
	validator := loadCRDValidator(t)

	validYAML := `
apiVersion: review.calltelemetry.com/v1alpha1
kind: PRReviewJob
metadata:
  name: valid-job
  namespace: default
spec:
  repo: "calltelemetry/cisco-cdr"
  prNumber: 42
  headSha: "1234567"
  baseSha: "7654321"
  personaRoster:
    - "security"
  pvcStorageSize: "2Gi"
  ttlSecondsAfterFinished: 1800
`

	errs := validator.ValidateManifest(validYAML)
	if len(errs) > 0 {
		t.Errorf("Expected valid YAML manifest to pass CRD schema validation, got errors: %v", errs)
	}
}

func TestCRDSchemaValidation_MissingFields(t *testing.T) {
	validator := loadCRDValidator(t)

	tests := []struct {
		name         string
		yamlStr      string
		expectedPath string
	}{
		{
			name: "Missing repo",
			yamlStr: `
apiVersion: review.calltelemetry.com/v1alpha1
kind: PRReviewJob
metadata:
  name: missing-repo
spec:
  prNumber: 42
  headSha: "1234567"
  baseSha: "7654321"
  personaRoster: ["security"]
`,
			expectedPath: "spec.repo",
		},
		{
			name: "Missing prNumber",
			yamlStr: `
apiVersion: review.calltelemetry.com/v1alpha1
kind: PRReviewJob
metadata:
  name: missing-prnumber
spec:
  repo: "owner/repo"
  headSha: "1234567"
  baseSha: "7654321"
  personaRoster: ["security"]
`,
			expectedPath: "spec.prNumber",
		},
		{
			name: "Missing headSha",
			yamlStr: `
apiVersion: review.calltelemetry.com/v1alpha1
kind: PRReviewJob
metadata:
  name: missing-headsha
spec:
  repo: "owner/repo"
  prNumber: 42
  baseSha: "7654321"
  personaRoster: ["security"]
`,
			expectedPath: "spec.headSha",
		},
		{
			name: "Missing baseSha",
			yamlStr: `
apiVersion: review.calltelemetry.com/v1alpha1
kind: PRReviewJob
metadata:
  name: missing-basesha
spec:
  repo: "owner/repo"
  prNumber: 42
  headSha: "1234567"
  personaRoster: ["security"]
`,
			expectedPath: "spec.baseSha",
		},
		{
			name: "Missing personaRoster",
			yamlStr: `
apiVersion: review.calltelemetry.com/v1alpha1
kind: PRReviewJob
metadata:
  name: missing-roster
spec:
  repo: "owner/repo"
  prNumber: 42
  headSha: "1234567"
  baseSha: "7654321"
`,
			expectedPath: "spec.personaRoster",
		},
		{
			name: "Empty personaRoster array",
			yamlStr: `
apiVersion: review.calltelemetry.com/v1alpha1
kind: PRReviewJob
metadata:
  name: empty-roster
spec:
  repo: "owner/repo"
  prNumber: 42
  headSha: "1234567"
  baseSha: "7654321"
  personaRoster: []
`,
			expectedPath: "spec.personaRoster",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			errs := validator.ValidateManifest(tt.yamlStr)
			if len(errs) == 0 {
				t.Fatalf("Expected validation error for %s, but got NONE", tt.name)
			}
			t.Logf("Validated expected rejection for %s: %v", tt.name, errs)
		})
	}
}

func TestCRDSchemaValidation_InvalidPRNumber(t *testing.T) {
	validator := loadCRDValidator(t)

	tests := []struct {
		name  string
		prVal int
	}{
		{name: "prNumber zero", prVal: 0},
		{name: "prNumber negative", prVal: -5},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			yamlStr := fmt.Sprintf(`
apiVersion: review.calltelemetry.com/v1alpha1
kind: PRReviewJob
metadata:
  name: test-invalid-pr
spec:
  repo: "owner/repo"
  prNumber: %d
  headSha: "1234567"
  baseSha: "7654321"
  personaRoster: ["security"]
`, tt.prVal)

			errs := validator.ValidateManifest(yamlStr)
			if len(errs) == 0 {
				t.Fatalf("Expected validation error for prNumber=%d, but got NONE", tt.prVal)
			}
		})
	}
}

func TestCRDSchemaValidation_InvalidRepoStringFormat(t *testing.T) {
	validator := loadCRDValidator(t)

	tests := []struct {
		name string
		repo string
	}{
		{name: "No slash", repo: "justarepo"},
		{name: "Multiple slashes", repo: "owner/repo/extra"},
		{name: "Spaces in repo", repo: "owner / repo"},
		{name: "Trailing slash", repo: "owner/"},
		{name: "Leading slash", repo: "/repo"},
		{name: "Special characters", repo: "owner/repo#123"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			yamlStr := fmt.Sprintf(`
apiVersion: review.calltelemetry.com/v1alpha1
kind: PRReviewJob
metadata:
  name: test-invalid-repo
spec:
  repo: "%s"
  prNumber: 42
  headSha: "1234567"
  baseSha: "7654321"
  personaRoster: ["security"]
`, tt.repo)

			errs := validator.ValidateManifest(yamlStr)
			if len(errs) == 0 {
				t.Fatalf("Expected validation error for repo string %q, but got NONE", tt.repo)
			}
		})
	}
}

func TestCRDSchemaValidation_InvalidSHALength(t *testing.T) {
	validator := loadCRDValidator(t)

	tests := []struct {
		name      string
		headSha   string
		baseSha   string
		expectErr string
	}{
		{
			name:      "headSha shorter than 7 chars",
			headSha:   "123456",
			baseSha:   "1234567",
			expectErr: "spec.headSha",
		},
		{
			name:      "baseSha shorter than 7 chars",
			headSha:   "1234567",
			baseSha:   "abc",
			expectErr: "spec.baseSha",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			yamlStr := fmt.Sprintf(`
apiVersion: review.calltelemetry.com/v1alpha1
kind: PRReviewJob
metadata:
  name: test-invalid-sha
spec:
  repo: "owner/repo"
  prNumber: 42
  headSha: "%s"
  baseSha: "%s"
  personaRoster: ["security"]
`, tt.headSha, tt.baseSha)

			errs := validator.ValidateManifest(yamlStr)
			if len(errs) == 0 {
				t.Fatalf("Expected validation error for sha head=%s base=%s, but got NONE", tt.headSha, tt.baseSha)
			}
		})
	}
}

func TestCRDSchemaValidation_NegativeTTLSeconds(t *testing.T) {
	validator := loadCRDValidator(t)

	tests := []struct {
		name string
		ttl  int
	}{
		{name: "ttlSecondsAfterFinished negative -1", ttl: -1},
		{name: "ttlSecondsAfterFinished negative -1800", ttl: -1800},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			yamlStr := fmt.Sprintf(`
apiVersion: review.calltelemetry.com/v1alpha1
kind: PRReviewJob
metadata:
  name: test-negative-ttl
spec:
  repo: "owner/repo"
  prNumber: 42
  headSha: "1234567"
  baseSha: "7654321"
  personaRoster: ["security"]
  ttlSecondsAfterFinished: %d
`, tt.ttl)

			errs := validator.ValidateManifest(yamlStr)
			if len(errs) == 0 {
				t.Fatalf("Expected validation error for ttlSecondsAfterFinished=%d, but got NONE", tt.ttl)
			}
			t.Logf("Validated expected rejection for negative ttlSecondsAfterFinished=%d: %v", tt.ttl, errs)
		})
	}
}
