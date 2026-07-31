package v1alpha1_test

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/yaml"

	v1alpha1 "github.com/calltelemetry/ct-review-bot/k8s-operator/api/v1alpha1"
)

// TestPRReviewJob_DeepCopy_MutatedNestedObjects stress-tests deepcopy cloning under
// heavy mutation of nested slices, maps, pointers, and time structs.
func TestPRReviewJob_DeepCopy_MutatedNestedObjects(t *testing.T) {
	now := metav1.Now()
	t1 := metav1.NewTime(now.Add(-1 * time.Hour))
	t2 := metav1.NewTime(now.Add(-2 * time.Hour))
	ttlVal := int32(1800)

	orig := &v1alpha1.PRReviewJob{
		TypeMeta: metav1.TypeMeta{
			APIVersion: "review.calltelemetry.com/v1alpha1",
			Kind:       "PRReviewJob",
		},
		ObjectMeta: metav1.ObjectMeta{
			Name:      "stress-job",
			Namespace: "default",
			Labels: map[string]string{
				"env": "production",
			},
			Annotations: map[string]string{
				"annot": "orig-val",
			},
			Finalizers: []string{"finalizer.review.calltelemetry.com"},
		},
		Spec: v1alpha1.PRReviewJobSpec{
			Repo:                    "calltelemetry/cisco-cdr",
			PRNumber:                99,
			HeadSHA:                 "1234567890abcdef",
			BaseSHA:                 "fedcba0987654321",
			PersonaRoster:           []string{"security", "qa", "performance"},
			PVCStorageSize:          "10Gi",
			TTLSecondsAfterFinished: &ttlVal,
		},
		Status: v1alpha1.PRReviewJobStatus{
			Phase:          v1alpha1.PhaseRunning,
			Verdict:        "COMMENT",
			JobName:        "job-stress-99",
			PVCName:        "pvc-stress-99",
			StartTime:      &t1,
			CompletionTime: &t2,
			Message:        "Job running",
			PersonaProgress: []v1alpha1.PersonaProgress{
				{
					Persona:    "security",
					Status:     "Completed",
					Message:    "No security flaws found",
					FinishedAt: &t1,
				},
				{
					Persona:    "qa",
					Status:     "Running",
					Message:    "Running tests",
					FinishedAt: nil,
				},
			},
			PersonaProgressMap: map[string]string{
				"security": "Completed",
				"qa":       "Running",
			},
			Conditions: []metav1.Condition{
				{
					Type:               "Ready",
					Status:             metav1.ConditionTrue,
					Reason:             "AllSet",
					Message:            "Initial state",
					LastTransitionTime: t1,
				},
			},
		},
	}

	// Perform deep copy
	copied := orig.DeepCopy()
	if copied == nil {
		t.Fatalf("DeepCopy returned nil")
	}

	// Mutate nested slice elements and append new elements
	copied.Spec.PersonaRoster[0] = "MUTATED_PERSONA"
	copied.Spec.PersonaRoster = append(copied.Spec.PersonaRoster, "NEW_PERSONA")

	// Mutate spec TTL pointer value
	*copied.Spec.TTLSecondsAfterFinished = 99999

	// Mutate status top-level time pointers
	copied.Status.StartTime.Time = now.Add(24 * time.Hour)
	copied.Status.CompletionTime.Time = now.Add(48 * time.Hour)

	// Mutate status persona progress slice and nested FinishedAt pointer
	copied.Status.PersonaProgress[0].Persona = "MUTATED_SECURITY"
	copied.Status.PersonaProgress[0].Status = "MUTATED_STATUS"
	copied.Status.PersonaProgress[0].FinishedAt.Time = now.Add(72 * time.Hour)
	copied.Status.PersonaProgress = append(copied.Status.PersonaProgress, v1alpha1.PersonaProgress{
		Persona: "extra_persona",
		Status:  "Pending",
	})

	// Mutate status persona progress map (modify, insert, delete)
	copied.Status.PersonaProgressMap["security"] = "MUTATED_MAP_VAL"
	copied.Status.PersonaProgressMap["new_key"] = "inserted_val"
	delete(copied.Status.PersonaProgressMap, "qa")

	// Mutate conditions slice
	copied.Status.Conditions[0].Type = "MUTATED_CONDITION_TYPE"
	copied.Status.Conditions[0].Message = "MUTATED_CONDITION_MSG"
	copied.Status.Conditions = append(copied.Status.Conditions, metav1.Condition{
		Type:   "ExtraCondition",
		Status: metav1.ConditionFalse,
	})

	// Mutate ObjectMeta maps and slices
	copied.ObjectMeta.Labels["env"] = "MUTATED_ENV"
	copied.ObjectMeta.Labels["new_label"] = "added"
	copied.ObjectMeta.Annotations["annot"] = "MUTATED_ANNOT"
	copied.ObjectMeta.Finalizers[0] = "MUTATED_FINALIZER"
	copied.ObjectMeta.Finalizers = append(copied.ObjectMeta.Finalizers, "extra.finalizer")

	// --- ASSERTIONS: Verify original object remains pristine ---

	// Spec assertions
	if orig.Spec.PersonaRoster[0] != "security" || len(orig.Spec.PersonaRoster) != 3 {
		t.Errorf("Violation: Mutating copied PersonaRoster altered original! got %v", orig.Spec.PersonaRoster)
	}
	if *orig.Spec.TTLSecondsAfterFinished != 1800 {
		t.Errorf("Violation: Mutating copied TTL pointer altered original! got %d", *orig.Spec.TTLSecondsAfterFinished)
	}

	// Status time assertions
	if !orig.Status.StartTime.Equal(&t1) {
		t.Errorf("Violation: Mutating copied StartTime altered original! got %v, want %v", orig.Status.StartTime, t1)
	}
	if !orig.Status.CompletionTime.Equal(&t2) {
		t.Errorf("Violation: Mutating copied CompletionTime altered original! got %v, want %v", orig.Status.CompletionTime, t2)
	}

	// Status PersonaProgress assertions
	if orig.Status.PersonaProgress[0].Persona != "security" || orig.Status.PersonaProgress[0].Status != "Completed" {
		t.Errorf("Violation: Mutating copied PersonaProgress altered original! got %v", orig.Status.PersonaProgress[0])
	}
	if !orig.Status.PersonaProgress[0].FinishedAt.Equal(&t1) {
		t.Errorf("Violation: Mutating copied PersonaProgress.FinishedAt altered original! got %v, want %v", orig.Status.PersonaProgress[0].FinishedAt, t1)
	}
	if len(orig.Status.PersonaProgress) != 2 {
		t.Errorf("Violation: Appending to copied PersonaProgress slice altered original length! got %d", len(orig.Status.PersonaProgress))
	}

	// Status PersonaProgressMap assertions
	if orig.Status.PersonaProgressMap["security"] != "Completed" {
		t.Errorf("Violation: Mutating copied PersonaProgressMap entry altered original! got %s", orig.Status.PersonaProgressMap["security"])
	}
	if _, exists := orig.Status.PersonaProgressMap["new_key"]; exists {
		t.Errorf("Violation: Adding key to copied PersonaProgressMap altered original!")
	}
	if orig.Status.PersonaProgressMap["qa"] != "Running" {
		t.Errorf("Violation: Deleting key from copied PersonaProgressMap altered original!")
	}

	// Status Conditions assertions
	if orig.Status.Conditions[0].Type != "Ready" || orig.Status.Conditions[0].Message != "Initial state" {
		t.Errorf("Violation: Mutating copied Conditions altered original! got %v", orig.Status.Conditions[0])
	}
	if len(orig.Status.Conditions) != 1 {
		t.Errorf("Violation: Appending to copied Conditions slice altered original length! got %d", len(orig.Status.Conditions))
	}

	// ObjectMeta assertions
	if orig.ObjectMeta.Labels["env"] != "production" || len(orig.ObjectMeta.Labels) != 1 {
		t.Errorf("Violation: Mutating copied Labels altered original! got %v", orig.ObjectMeta.Labels)
	}
	if orig.ObjectMeta.Annotations["annot"] != "orig-val" {
		t.Errorf("Violation: Mutating copied Annotations altered original! got %v", orig.ObjectMeta.Annotations)
	}
	if orig.ObjectMeta.Finalizers[0] != "finalizer.review.calltelemetry.com" || len(orig.ObjectMeta.Finalizers) != 1 {
		t.Errorf("Violation: Mutating copied Finalizers altered original! got %v", orig.ObjectMeta.Finalizers)
	}
}

// TestPRReviewJob_NilHandling_Stress tests nil safety on DeepCopy and helper methods.
func TestPRReviewJob_NilHandling_Stress(t *testing.T) {
	t.Run("Nil receiver DeepCopy safety", func(t *testing.T) {
		var job *v1alpha1.PRReviewJob = nil
		if job.DeepCopy() != nil {
			t.Errorf("Expected nil when DeepCopying nil *PRReviewJob")
		}
		if job.DeepCopyObject() != nil {
			t.Errorf("Expected nil when DeepCopyObjecting nil *PRReviewJob")
		}

		var jobList *v1alpha1.PRReviewJobList = nil
		if jobList.DeepCopy() != nil {
			t.Errorf("Expected nil when DeepCopying nil *PRReviewJobList")
		}

		var spec *v1alpha1.PRReviewJobSpec = nil
		if spec.DeepCopy() != nil {
			t.Errorf("Expected nil when DeepCopying nil *PRReviewJobSpec")
		}

		var status *v1alpha1.PRReviewJobStatus = nil
		if status.DeepCopy() != nil {
			t.Errorf("Expected nil when DeepCopying nil *PRReviewJobStatus")
		}

		var persona *v1alpha1.PersonaProgress = nil
		if persona.DeepCopy() != nil {
			t.Errorf("Expected nil when DeepCopying nil *PersonaProgress")
		}
	})

	t.Run("Structs with all nil inner fields DeepCopy safely", func(t *testing.T) {
		job := &v1alpha1.PRReviewJob{
			Spec: v1alpha1.PRReviewJobSpec{
				PersonaRoster:           nil,
				TTLSecondsAfterFinished: nil,
			},
			Status: v1alpha1.PRReviewJobStatus{
				StartTime:          nil,
				CompletionTime:     nil,
				PersonaProgress:    nil,
				PersonaProgressMap: nil,
				Conditions:         nil,
			},
		}

		copied := job.DeepCopy()
		if copied == nil {
			t.Fatalf("DeepCopy returned nil for non-nil struct with nil inner fields")
		}
		if copied.Spec.PersonaRoster != nil {
			t.Errorf("Expected nil PersonaRoster in copy")
		}
		if copied.Spec.TTLSecondsAfterFinished != nil {
			t.Errorf("Expected nil TTLSecondsAfterFinished in copy")
		}
		if copied.Status.StartTime != nil || copied.Status.CompletionTime != nil {
			t.Errorf("Expected nil StartTime/CompletionTime in copy")
		}
		if copied.Status.PersonaProgress != nil || copied.Status.PersonaProgressMap != nil || copied.Status.Conditions != nil {
			t.Errorf("Expected nil PersonaProgress/PersonaProgressMap/Conditions in copy")
		}
	})

	t.Run("Helper methods on empty structs return sensible defaults", func(t *testing.T) {
		emptySpec := &v1alpha1.PRReviewJobSpec{}
		if emptySpec.GetPVCStorageSize() != "1Gi" {
			t.Errorf("Expected default 1Gi for empty Spec PVCStorageSize, got %s", emptySpec.GetPVCStorageSize())
		}
		if emptySpec.GetTTLSeconds() != 1800 {
			t.Errorf("Expected default 1800 for empty Spec TTLSeconds, got %d", emptySpec.GetTTLSeconds())
		}

		emptyJob := &v1alpha1.PRReviewJob{}
		if emptyJob.GetPVCStorageSize() != "1Gi" {
			t.Errorf("Expected default 1Gi for empty Job PVCStorageSize, got %s", emptyJob.GetPVCStorageSize())
		}
		if emptyJob.GetTTLSeconds() != 1800 {
			t.Errorf("Expected default 1800 for empty Job TTLSeconds, got %d", emptyJob.GetTTLSeconds())
		}

		emptyJob.SetDefaults()
		if emptyJob.Spec.PVCStorageSize != "1Gi" {
			t.Errorf("SetDefaults failed for PVCStorageSize: got %s", emptyJob.Spec.PVCStorageSize)
		}
		if emptyJob.Spec.TTLSecondsAfterFinished == nil || *emptyJob.Spec.TTLSecondsAfterFinished != 1800 {
			t.Errorf("SetDefaults failed for TTLSecondsAfterFinished")
		}
		if emptyJob.Status.Phase != v1alpha1.PhaseQueued {
			t.Errorf("SetDefaults failed for Phase: got %s", emptyJob.Status.Phase)
		}
	})

	t.Run("Check receiver nil safety for helper methods", func(t *testing.T) {
		var nilSpec *v1alpha1.PRReviewJobSpec = nil

		if pvc := nilSpec.GetPVCStorageSize(); pvc != "1Gi" {
			t.Errorf("Expected nilSpec.GetPVCStorageSize() to return '1Gi', got %s", pvc)
		}

		if ttl := nilSpec.GetTTLSeconds(); ttl != 1800 {
			t.Errorf("Expected nilSpec.GetTTLSeconds() to return 1800, got %d", ttl)
		}

		var nilJob *v1alpha1.PRReviewJob = nil

		if pvc := nilJob.GetPVCStorageSize(); pvc != "1Gi" {
			t.Errorf("Expected nilJob.GetPVCStorageSize() to return '1Gi', got %s", pvc)
		}

		if ttl := nilJob.GetTTLSeconds(); ttl != 1800 {
			t.Errorf("Expected nilJob.GetTTLSeconds() to return 1800, got %d", ttl)
		}

		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("nilJob.SetDefaults() panicked: %v", r)
				}
			}()
			nilJob.SetDefaults()
		}()
	})
}

// TestCRD_YAML_ParsingAndSchemaValidation parses the CRD YAML manifest and checks schema rules.
func TestCRD_YAML_ParsingAndSchemaValidation(t *testing.T) {
	// Locate CRD file relative to project root
	crdPath := filepath.Join("..", "..", "config", "crd", "bases", "review.calltelemetry.com_prreviewjobs.yaml")
	data, err := os.ReadFile(crdPath)
	if err != nil {
		t.Fatalf("Failed to read CRD file at %s: %v", crdPath, err)
	}

	var rawCRD map[string]interface{}
	err = yaml.Unmarshal(data, &rawCRD)
	if err != nil {
		t.Fatalf("Failed to unmarshal CRD YAML: %v", err)
	}

	// Verify CRD metadata
	kind, _ := rawCRD["kind"].(string)
	if kind != "CustomResourceDefinition" {
		t.Errorf("CRD kind mismatch: got %s, want CustomResourceDefinition", kind)
	}

	metadata, ok := rawCRD["metadata"].(map[string]interface{})
	if !ok {
		t.Fatalf("CRD metadata field missing or invalid")
	}
	crdName, _ := metadata["name"].(string)
	if crdName != "prreviewjobs.review.calltelemetry.com" {
		t.Errorf("CRD name mismatch: got %s, want prreviewjobs.review.calltelemetry.com", crdName)
	}

	// Extract spec.versions[0].schema.openAPIV3Schema
	specMap, ok := rawCRD["spec"].(map[string]interface{})
	if !ok {
		t.Fatalf("CRD spec field missing")
	}
	versions, ok := specMap["versions"].([]interface{})
	if !ok || len(versions) == 0 {
		t.Fatalf("CRD spec.versions missing or empty")
	}

	v1alpha1Ver, ok := versions[0].(map[string]interface{})
	if !ok {
		t.Fatalf("CRD version[0] invalid format")
	}
	if v1alpha1Ver["name"] != "v1alpha1" {
		t.Errorf("Version[0] name mismatch: got %s, want v1alpha1", v1alpha1Ver["name"])
	}

	schemaMap, ok := v1alpha1Ver["schema"].(map[string]interface{})
	if !ok {
		t.Fatalf("Schema missing from CRD version")
	}

	openAPI, ok := schemaMap["openAPIV3Schema"].(map[string]interface{})
	if !ok {
		t.Fatalf("openAPIV3Schema missing from CRD schema")
	}

	props, ok := openAPI["properties"].(map[string]interface{})
	if !ok {
		t.Fatalf("openAPIV3Schema properties missing")
	}

	specProp, ok := props["spec"].(map[string]interface{})
	if !ok {
		t.Fatalf("openAPIV3Schema spec property missing")
	}

	// Validate required spec fields in schema
	reqFields, ok := specProp["required"].([]interface{})
	if !ok {
		t.Fatalf("spec.required missing in OpenAPI schema")
	}

	reqMap := make(map[string]bool)
	for _, rf := range reqFields {
		if s, ok := rf.(string); ok {
			reqMap[s] = true
		}
	}

	expectedRequired := []string{"repo", "prNumber", "headSha", "baseSha", "personaRoster"}
	for _, req := range expectedRequired {
		if !reqMap[req] {
			t.Errorf("Schema violation: required spec field '%s' missing from CRD schema required list", req)
		}
	}

	// Test repo regex pattern constraint defined in CRD
	specProperties, ok := specProp["properties"].(map[string]interface{})
	if !ok {
		t.Fatalf("spec.properties missing")
	}

	repoProp, ok := specProperties["repo"].(map[string]interface{})
	if !ok {
		t.Fatalf("spec.properties.repo missing")
	}
	repoPatternStr, ok := repoProp["pattern"].(string)
	if !ok {
		t.Fatalf("spec.properties.repo pattern missing")
	}

	repoRegex, err := regexp.Compile(repoPatternStr)
	if err != nil {
		t.Fatalf("Failed to compile repo pattern regex '%s': %v", repoPatternStr, err)
	}

	// Test repo regex against edge case test vectors
	validRepos := []string{
		"calltelemetry/cisco-cdr",
		"kubernetes/kubernetes",
		"owner-name_12/repo.name-99",
	}
	for _, r := range validRepos {
		if !repoRegex.MatchString(r) {
			t.Errorf("Repo pattern '%s' rejected valid repo '%s'", repoPatternStr, r)
		}
	}

	invalidRepos := []string{
		"invalidrepo",
		"owner/repo/extra",
		"owner/repo#1",
		"/owner/repo",
		"owner/repo/",
	}
	for _, r := range invalidRepos {
		if repoRegex.MatchString(r) {
			t.Errorf("Repo pattern '%s' mistakenly matched invalid repo '%s'", repoPatternStr, r)
		}
	}

	// Test phase enum in status schema
	statusProp, ok := props["status"].(map[string]interface{})
	if !ok {
		t.Fatalf("openAPIV3Schema status property missing")
	}
	statusProperties, ok := statusProp["properties"].(map[string]interface{})
	if !ok {
		t.Fatalf("status.properties missing")
	}
	phaseProp, ok := statusProperties["phase"].(map[string]interface{})
	if !ok {
		t.Fatalf("status.properties.phase missing")
	}
	enumRaw, ok := phaseProp["enum"].([]interface{})
	if !ok {
		t.Fatalf("status.properties.phase enum missing")
	}

	enumSet := make(map[string]bool)
	for _, e := range enumRaw {
		if s, ok := e.(string); ok {
			enumSet[s] = true
		}
	}

	expectedPhases := []string{"Queued", "Running", "Succeeded", "Failed"}
	for _, p := range expectedPhases {
		if !enumSet[p] {
			t.Errorf("Phase enum missing expected phase '%s'", p)
		}
	}
}

// TestPRReviewJob_Stress_LargePayload verifies DeepCopy performance and concurrency safety
// with large payloads (1000s of nested entries).
func TestPRReviewJob_Stress_LargePayload(t *testing.T) {
	now := metav1.Now()
	ttlVal := int32(3600)

	// Build large payload
	numPersonas := 500
	numConditions := 200

	progressList := make([]v1alpha1.PersonaProgress, numPersonas)
	progressMap := make(map[string]string, numPersonas)
	personaRoster := make([]string, numPersonas)

	for i := 0; i < numPersonas; i++ {
		pName := fmt.Sprintf("persona_%d", i)
		personaRoster[i] = pName
		progressList[i] = v1alpha1.PersonaProgress{
			Persona:    pName,
			Status:     "Completed",
			Message:    fmt.Sprintf("Result for persona %d", i),
			FinishedAt: &now,
		}
		progressMap[pName] = "Completed"
	}

	conditionsList := make([]metav1.Condition, numConditions)
	for i := 0; i < numConditions; i++ {
		conditionsList[i] = metav1.Condition{
			Type:               fmt.Sprintf("ConditionType_%d", i),
			Status:             metav1.ConditionTrue,
			Reason:             "ReasonCode",
			Message:            "Condition message",
			LastTransitionTime: now,
		}
	}

	largeJob := &v1alpha1.PRReviewJob{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "large-stress-job",
			Namespace: "stress-test",
		},
		Spec: v1alpha1.PRReviewJobSpec{
			Repo:                    "calltelemetry/cisco-cdr",
			PRNumber:                5000,
			HeadSHA:                 "abcdef1234567890",
			BaseSHA:                 "0987654321fedcba",
			PersonaRoster:           personaRoster,
			PVCStorageSize:          "100Gi",
			TTLSecondsAfterFinished: &ttlVal,
		},
		Status: v1alpha1.PRReviewJobStatus{
			Phase:              v1alpha1.PhaseSucceeded,
			Verdict:            "APPROVED",
			PersonaProgress:    progressList,
			PersonaProgressMap: progressMap,
			Conditions:         conditionsList,
			StartTime:          &now,
			CompletionTime:     &now,
		},
	}

	// Concurrently deepcopy and mutate from 20 parallel goroutines
	concurrency := 20
	var wg sync.WaitGroup
	wg.Add(concurrency)

	errChan := make(chan error, concurrency)

	for g := 0; g < concurrency; g++ {
		go func(goroutineID int) {
			defer wg.Done()

			copyJob := largeJob.DeepCopy()
			if copyJob == nil {
				errChan <- fmt.Errorf("[goroutine %d] DeepCopy returned nil", goroutineID)
				return
			}

			// Perform mutations on copyJob
			copyJob.Spec.PersonaRoster[0] = fmt.Sprintf("goroutine_%d_mutated", goroutineID)
			copyJob.Status.PersonaProgress[0].Status = fmt.Sprintf("mutated_%d", goroutineID)
			copyJob.Status.PersonaProgressMap["persona_0"] = fmt.Sprintf("mutated_%d", goroutineID)
			copyJob.Status.Conditions[0].Message = fmt.Sprintf("goroutine_%d_msg", goroutineID)

			// Verify mutation did not corrupt size
			if len(copyJob.Status.PersonaProgress) != numPersonas {
				errChan <- fmt.Errorf("[goroutine %d] PersonaProgress length changed unexpectedly", goroutineID)
				return
			}
		}(g)
	}

	wg.Wait()
	close(errChan)

	for err := range errChan {
		t.Errorf("Concurrent stress error: %v", err)
	}

	// Verify original largeJob remains untouched
	if largeJob.Spec.PersonaRoster[0] != "persona_0" {
		t.Errorf("Original PersonaRoster[0] mutated during concurrent stress!")
	}
	if largeJob.Status.PersonaProgress[0].Status != "Completed" {
		t.Errorf("Original PersonaProgress[0] status mutated during concurrent stress!")
	}
	if largeJob.Status.PersonaProgressMap["persona_0"] != "Completed" {
		t.Errorf("Original PersonaProgressMap mutated during concurrent stress!")
	}
}
