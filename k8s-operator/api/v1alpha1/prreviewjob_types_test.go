package v1alpha1_test

import (
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"sigs.k8s.io/yaml"

	v1alpha1 "github.com/calltelemetry/ct-review-bot/k8s-operator/api/v1alpha1"
)

func TestPRReviewJob_SetDefaults(t *testing.T) {
	tests := []struct {
		name                string
		inputSpec           v1alpha1.PRReviewJobSpec
		expectedStorageSize string
		expectedTTLSeconds  int32
	}{
		{
			name: "All optional fields unset - should populate defaults",
			inputSpec: v1alpha1.PRReviewJobSpec{
				Repo:          "calltelemetry/cisco-cdr",
				PRNumber:      42,
				HeadSHA:       "abc1234",
				BaseSHA:       "def5678",
				PersonaRoster: []string{"reviewer", "security_auditor"},
			},
			expectedStorageSize: "1Gi",
			expectedTTLSeconds:  1800,
		},
		{
			name: "Custom storage size and custom TTL - should preserve values",
			inputSpec: v1alpha1.PRReviewJobSpec{
				Repo:                    "calltelemetry/cisco-cdr",
				PRNumber:                42,
				HeadSHA:                 "abc1234",
				BaseSHA:                 "def5678",
				PersonaRoster:           []string{"reviewer"},
				PVCStorageSize:          "5Gi",
				TTLSecondsAfterFinished: int32Ptr(3600),
			},
			expectedStorageSize: "5Gi",
			expectedTTLSeconds:  3600,
		},
		{
			name: "Partial defaults - custom storage size only",
			inputSpec: v1alpha1.PRReviewJobSpec{
				Repo:           "calltelemetry/cisco-cdr",
				PRNumber:       10,
				HeadSHA:        "1111111",
				BaseSHA:        "2222222",
				PersonaRoster:  []string{"reviewer"},
				PVCStorageSize: "2Gi",
			},
			expectedStorageSize: "2Gi",
			expectedTTLSeconds:  1800,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			job := &v1alpha1.PRReviewJob{
				Spec: tt.inputSpec,
			}

			// Apply defaults
			job.SetDefaults()

			if job.Spec.PVCStorageSize != tt.expectedStorageSize {
				t.Errorf("PVCStorageSize mismatch: got %s, want %s", job.Spec.PVCStorageSize, tt.expectedStorageSize)
			}

			if job.Spec.TTLSecondsAfterFinished == nil {
				t.Fatalf("TTLSecondsAfterFinished is nil, expected %d", tt.expectedTTLSeconds)
			}

			if *job.Spec.TTLSecondsAfterFinished != tt.expectedTTLSeconds {
				t.Errorf("TTLSecondsAfterFinished mismatch: got %d, want %d", *job.Spec.TTLSecondsAfterFinished, tt.expectedTTLSeconds)
			}

			// Test helper accessor methods
			if job.Spec.GetPVCStorageSize() != tt.expectedStorageSize {
				t.Errorf("GetPVCStorageSize mismatch: got %s, want %s", job.Spec.GetPVCStorageSize(), tt.expectedStorageSize)
			}
			if job.Spec.GetTTLSeconds() != tt.expectedTTLSeconds {
				t.Errorf("GetTTLSeconds mismatch: got %d, want %d", job.Spec.GetTTLSeconds(), tt.expectedTTLSeconds)
			}
			if job.GetPVCStorageSize() != tt.expectedStorageSize {
				t.Errorf("job.GetPVCStorageSize mismatch: got %s, want %s", job.GetPVCStorageSize(), tt.expectedStorageSize)
			}
			if job.GetTTLSeconds() != tt.expectedTTLSeconds {
				t.Errorf("job.GetTTLSeconds mismatch: got %d, want %d", job.GetTTLSeconds(), tt.expectedTTLSeconds)
			}
		})
	}
}

func TestPRReviewJob_DeepCopy(t *testing.T) {
	t.Run("Nil PRReviewJob receiver", func(t *testing.T) {
		var job *v1alpha1.PRReviewJob = nil
		if job.DeepCopy() != nil {
			t.Errorf("Expected nil when DeepCopying nil *PRReviewJob")
		}
		if job.DeepCopyObject() != nil {
			t.Errorf("Expected nil when DeepCopyObjecting nil *PRReviewJob")
		}
	})

	t.Run("Full PRReviewJob object deep copy independence", func(t *testing.T) {
		ttl := int32(1800)
		now := metav1.Now()
		orig := &v1alpha1.PRReviewJob{
			TypeMeta: metav1.TypeMeta{
				APIVersion: "review.calltelemetry.com/v1alpha1",
				Kind:       "PRReviewJob",
			},
			ObjectMeta: metav1.ObjectMeta{
				Name:      "test-job-1",
				Namespace: "ct-review-system",
				Labels: map[string]string{
					"app": "ct-review-bot",
				},
			},
			Spec: v1alpha1.PRReviewJobSpec{
				Repo:                    "calltelemetry/cisco-cdr",
				PRNumber:                101,
				HeadSHA:                 "sha-head-123",
				BaseSHA:                 "sha-base-456",
				PersonaRoster:           []string{"worker", "reviewer", "auditor"},
				PVCStorageSize:          "2Gi",
				TTLSecondsAfterFinished: &ttl,
			},
			Status: v1alpha1.PRReviewJobStatus{
				Phase:     v1alpha1.PhaseRunning,
				Verdict:   "Approved",
				JobName:   "pr-101-job",
				PVCName:   "pr-101-pvc",
				StartTime: &now,
				PersonaProgress: []v1alpha1.PersonaProgress{
					{Persona: "worker", Status: "Completed", Message: "Done"},
					{Persona: "reviewer", Status: "Running"},
				},
				Conditions: []metav1.Condition{
					{
						Type:               "JobDispatched",
						Status:             metav1.ConditionTrue,
						Reason:             "PodCreated",
						Message:            "Worker pod spawned",
						LastTransitionTime: now,
					},
				},
			},
		}

		// Perform DeepCopy
		copied := orig.DeepCopy()

		if copied == nil {
			t.Fatalf("DeepCopy returned nil")
		}
		if copied.Name != orig.Name || copied.Spec.PRNumber != orig.Spec.PRNumber {
			t.Errorf("Copied struct fields do not match original")
		}

		// Verify copy independence (mutations on copied struct must not affect orig)
		copied.Spec.PersonaRoster[0] = "MUTATED"
		if orig.Spec.PersonaRoster[0] == "MUTATED" {
			t.Errorf("Mutating copied PersonaRoster affected original!")
		}

		copied.Status.PersonaProgress[0].Status = "MUTATED"
		if orig.Status.PersonaProgress[0].Status == "MUTATED" {
			t.Errorf("Mutating copied PersonaProgress affected original!")
		}

		*copied.Spec.TTLSecondsAfterFinished = 9999
		if *orig.Spec.TTLSecondsAfterFinished == 9999 {
			t.Errorf("Mutating copied TTL pointer value affected original!")
		}

		copied.ObjectMeta.Labels["app"] = "MUTATED"
		if orig.ObjectMeta.Labels["app"] == "MUTATED" {
			t.Errorf("Mutating copied Labels map affected original!")
		}

		// Verify DeepCopyObject returns a valid runtime.Object
		runtimeObj := orig.DeepCopyObject()
		if runtimeObj == nil {
			t.Fatalf("DeepCopyObject returned nil")
		}
		if _, ok := runtimeObj.(*v1alpha1.PRReviewJob); !ok {
			t.Errorf("DeepCopyObject result is not *v1alpha1.PRReviewJob")
		}
	})

	t.Run("PRReviewJobList deep copy", func(t *testing.T) {
		var nilList *v1alpha1.PRReviewJobList = nil
		if nilList.DeepCopy() != nil || nilList.DeepCopyObject() != nil {
			t.Errorf("Expected nil when DeepCopying nil *PRReviewJobList")
		}

		list := &v1alpha1.PRReviewJobList{
			Items: []v1alpha1.PRReviewJob{
				{
					ObjectMeta: metav1.ObjectMeta{Name: "job-1"},
					Spec:       v1alpha1.PRReviewJobSpec{Repo: "repo/a", PRNumber: 1},
				},
				{
					ObjectMeta: metav1.ObjectMeta{Name: "job-2"},
					Spec:       v1alpha1.PRReviewJobSpec{Repo: "repo/b", PRNumber: 2},
				},
			},
		}

		copiedList := list.DeepCopy()
		if len(copiedList.Items) != 2 {
			t.Fatalf("Expected 2 items in copied list, got %d", len(copiedList.Items))
		}

		copiedList.Items[0].Spec.Repo = "MUTATED"
		if list.Items[0].Spec.Repo == "MUTATED" {
			t.Errorf("Mutating copied list item affected original list!")
		}

		obj := list.DeepCopyObject()
		if _, ok := obj.(*v1alpha1.PRReviewJobList); !ok {
			t.Errorf("DeepCopyObject of PRReviewJobList did not return *PRReviewJobList")
		}
	})
}

func TestPRReviewJob_SchemeRegistration(t *testing.T) {
	sch := runtime.NewScheme()
	err := v1alpha1.AddToScheme(sch)
	if err != nil {
		t.Fatalf("Failed to add v1alpha1 to scheme: %v", err)
	}

	expectedGVK := schema.GroupVersionKind{
		Group:   "review.calltelemetry.com",
		Version: "v1alpha1",
		Kind:    "PRReviewJob",
	}

	expectedListGVK := schema.GroupVersionKind{
		Group:   "review.calltelemetry.com",
		Version: "v1alpha1",
		Kind:    "PRReviewJobList",
	}

	// Verify creation by GVK from Scheme
	obj, err := sch.New(expectedGVK)
	if err != nil {
		t.Fatalf("Scheme failed to instantiate %v: %v", expectedGVK, err)
	}

	if _, ok := obj.(*v1alpha1.PRReviewJob); !ok {
		t.Fatalf("Object created from GVK is not *v1alpha1.PRReviewJob")
	}

	listObj, err := sch.New(expectedListGVK)
	if err != nil {
		t.Fatalf("Scheme failed to instantiate %v: %v", expectedListGVK, err)
	}
	if _, ok := listObj.(*v1alpha1.PRReviewJobList); !ok {
		t.Fatalf("Object created from List GVK is not *v1alpha1.PRReviewJobList")
	}

	// Verify ObjectKinds resolution
	kinds, _, err := sch.ObjectKinds(&v1alpha1.PRReviewJob{})
	if err != nil {
		t.Fatalf("Failed to get object kinds for PRReviewJob: %v", err)
	}
	if len(kinds) == 0 || kinds[0] != expectedGVK {
		t.Errorf("Expected GVK %v, got %v", expectedGVK, kinds)
	}
}

func TestPRReviewJob_YAMLUnmarshaling(t *testing.T) {
	yamlManifest := []byte(`
apiVersion: review.calltelemetry.com/v1alpha1
kind: PRReviewJob
metadata:
  name: test-pr-job
  namespace: ct-review-system
  labels:
    tier: worker
spec:
  repo: "calltelemetry/cisco-cdr"
  prNumber: 42
  headSha: "9f8e7d6c5b4a"
  baseSha: "1a2b3c4d5e6f"
  personaRoster:
    - reviewer
    - security_auditor
  pvcStorageSize: "2Gi"
  ttlSecondsAfterFinished: 1800
status:
  phase: "Queued"
`)

	var job v1alpha1.PRReviewJob
	err := yaml.Unmarshal(yamlManifest, &job)
	if err != nil {
		t.Fatalf("Failed to unmarshal YAML manifest: %v", err)
	}

	// Validate metadata
	if job.APIVersion != "review.calltelemetry.com/v1alpha1" {
		t.Errorf("APIVersion mismatch: got %s", job.APIVersion)
	}
	if job.Kind != "PRReviewJob" {
		t.Errorf("Kind mismatch: got %s", job.Kind)
	}
	if job.Name != "test-pr-job" || job.Namespace != "ct-review-system" {
		t.Errorf("Metadata name/namespace mismatch: name=%s, ns=%s", job.Name, job.Namespace)
	}

	// Validate spec fields
	if job.Spec.Repo != "calltelemetry/cisco-cdr" {
		t.Errorf("Spec.Repo mismatch: got %s", job.Spec.Repo)
	}
	if job.Spec.PRNumber != 42 {
		t.Errorf("Spec.PRNumber mismatch: got %d", job.Spec.PRNumber)
	}
	if job.Spec.HeadSHA != "9f8e7d6c5b4a" {
		t.Errorf("Spec.HeadSHA mismatch: got %s", job.Spec.HeadSHA)
	}
	if job.Spec.BaseSHA != "1a2b3c4d5e6f" {
		t.Errorf("Spec.BaseSHA mismatch: got %s", job.Spec.BaseSHA)
	}
	if len(job.Spec.PersonaRoster) != 2 || job.Spec.PersonaRoster[0] != "reviewer" || job.Spec.PersonaRoster[1] != "security_auditor" {
		t.Errorf("Spec.PersonaRoster mismatch: got %v", job.Spec.PersonaRoster)
	}
	if job.Spec.PVCStorageSize != "2Gi" {
		t.Errorf("Spec.PVCStorageSize mismatch: got %s", job.Spec.PVCStorageSize)
	}
	if job.Spec.TTLSecondsAfterFinished == nil || *job.Spec.TTLSecondsAfterFinished != 1800 {
		t.Errorf("Spec.TTLSecondsAfterFinished mismatch")
	}

	// Validate status
	if job.Status.Phase != v1alpha1.PhaseQueued {
		t.Errorf("Status.Phase mismatch: got %s, want Queued", job.Status.Phase)
	}
}

func TestPRReviewJobPhase_Constants(t *testing.T) {
	phases := map[v1alpha1.PRReviewJobPhase]string{
		v1alpha1.PhaseQueued:    "Queued",
		v1alpha1.PhaseRunning:   "Running",
		v1alpha1.PhaseSucceeded: "Succeeded",
		v1alpha1.PhaseFailed:    "Failed",
	}

	for phase, expectedStr := range phases {
		if string(phase) != expectedStr {
			t.Errorf("Phase constant mismatch: got %s, want %s", phase, expectedStr)
		}
	}
}

func int32Ptr(i int32) *int32 {
	return &i
}
