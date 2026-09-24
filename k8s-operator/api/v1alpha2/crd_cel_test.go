package v1alpha2_test

import (
	"context"
	"reflect"
	"strings"
	"testing"

	"k8s.io/apiextensions-apiserver/pkg/apis/apiextensions"
	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	apiextensionsvalidation "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/validation"
	structuralschema "k8s.io/apiextensions-apiserver/pkg/apiserver/schema"
	"k8s.io/apiextensions-apiserver/pkg/apiserver/schema/cel"
	"k8s.io/apiextensions-apiserver/pkg/apiserver/schema/pruning"
	utiljson "k8s.io/apimachinery/pkg/util/json"
	"k8s.io/apimachinery/pkg/util/validation/field"
	celconfig "k8s.io/apiserver/pkg/apis/cel"

	"github.com/calltelemetry/ct-review-bot/k8s-operator/api/v1alpha2"
)

// REL-1073: these tests run the committed CRD through the same apiextensions
// code the API server uses (CRD admission validation, structural pruning and
// CEL rule evaluation), so a CRD that silently prunes spec.cancelRequested or
// rejects the cancel flip fails here instead of in production.

func structuralV1Alpha2(t *testing.T) *structuralschema.Structural {
	t.Helper()
	crd := loadV1Alpha2CRD(t)
	var internal apiextensions.JSONSchemaProps
	if err := apiextensionsv1.Convert_v1_JSONSchemaProps_To_apiextensions_JSONSchemaProps(
		crd.Spec.Versions[0].Schema.OpenAPIV3Schema, &internal, nil); err != nil {
		t.Fatalf("convert schema: %v", err)
	}
	structural, err := structuralschema.NewStructural(&internal)
	if err != nil {
		t.Fatalf("structural schema: %v", err)
	}
	return structural
}

func TestV1Alpha2CRDPassesAPIServerAdmissionValidation(t *testing.T) {
	crd := loadV1Alpha2CRD(t)
	var internal apiextensions.CustomResourceDefinition
	if err := apiextensionsv1.Convert_v1_CustomResourceDefinition_To_apiextensions_CustomResourceDefinition(crd, &internal, nil); err != nil {
		t.Fatalf("convert CRD: %v", err)
	}
	// A served CRD always records its storage version; the generated file does not.
	internal.Status.StoredVersions = []string{"v1alpha2"}
	// Includes CEL compilation and the static cost-budget estimate the API
	// server applies before it will accept the CRD.
	if errs := apiextensionsvalidation.ValidateCustomResourceDefinition(context.Background(), &internal); len(errs) > 0 {
		t.Fatalf("API server would reject the CRD: %v", errs.ToAggregate())
	}
}

func basePRReviewJob() map[string]interface{} {
	return map[string]interface{}{
		"apiVersion": "review-yeti.ai/v1alpha2",
		"kind":       "PRReviewJob",
		"metadata":   map[string]interface{}{"name": "ct-review-0123456789abcdef0123456789abcdef", "namespace": "ct-review-system"},
		"spec": map[string]interface{}{
			"runId":            "run_0123456789abcdef0123456789abcdef",
			"deliveryId":       "delivery-1",
			"executionAttempt": int64(1),
			"repositoryId":     int64(42),
			"repo":             "calltelemetry/ct-release",
			"prNumber":         int64(1720),
			"headSha":          strings.Repeat("a", 40),
			"baseSha":          strings.Repeat("b", 40),
			"receivedAt":       "2026-09-23T13:23:18Z",
			"terminalDeadline": "2026-09-23T13:53:18Z",
			"policyDigest":     strings.Repeat("c", 64),
			"configDigest":     strings.Repeat("d", 64),
			"publicationMode":  "app-gate",
			"workerImage":      "ghcr.io/review-yeti-ai/review-yeti-worker@sha256:" + strings.Repeat("e", 64),
			"runSecretName":    "ct-review-run-0123456789abcdef0123456789abcdef",
		},
	}
}

func deepCopyObject(t *testing.T, obj map[string]interface{}) map[string]interface{} {
	t.Helper()
	raw, err := utiljson.Marshal(obj)
	if err != nil {
		t.Fatal(err)
	}
	// The API server's decoder: integers become int64, not float64.
	var out map[string]interface{}
	if err := utiljson.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func validateUpdate(t *testing.T, oldObj, newObj map[string]interface{}) field.ErrorList {
	t.Helper()
	structural := structuralV1Alpha2(t)
	validator := cel.NewValidator(structural, true, celconfig.PerCallLimit)
	if validator == nil {
		t.Fatal("CRD has no CEL rules")
	}
	errs, _ := validator.Validate(context.Background(), field.NewPath(""), structural,
		deepCopyObject(t, newObj), deepCopyObject(t, oldObj), celconfig.RuntimeCELCostBudget)
	return errs
}

func withSpec(t *testing.T, mutate func(spec map[string]interface{})) map[string]interface{} {
	t.Helper()
	obj := deepCopyObject(t, basePRReviewJob())
	mutate(obj["spec"].(map[string]interface{}))
	return obj
}

func TestV1Alpha2CRDKeepsCancelRequestedThroughPruning(t *testing.T) {
	obj := withSpec(t, func(spec map[string]interface{}) {
		spec["cancelRequested"] = true
		spec["cancelReason"] = "superseded_by_new_head"
		spec["notInSchema"] = "x"
	})
	pruned := pruning.PruneWithOptions(obj, structuralV1Alpha2(t), true, structuralschema.UnknownFieldPathOptions{TrackUnknownFieldPaths: true})
	spec := obj["spec"].(map[string]interface{})
	if spec["cancelRequested"] != true || spec["cancelReason"] != "superseded_by_new_head" {
		t.Fatalf("the API server would prune the cancel fields; pruned paths: %v", pruned)
	}
	if !reflect.DeepEqual(pruned, []string{"spec.notInSchema"}) {
		t.Fatalf("pruned paths = %v, want only spec.notInSchema", pruned)
	}
}

func TestV1Alpha2CRDAcceptsOneWayCancelTransition(t *testing.T) {
	cases := map[string]struct {
		before func(spec map[string]interface{})
		after  func(spec map[string]interface{})
	}{
		"absent to true": {
			before: func(map[string]interface{}) {},
			after:  func(spec map[string]interface{}) { spec["cancelRequested"] = true },
		},
		"absent to true with reason": {
			before: func(map[string]interface{}) {},
			after: func(spec map[string]interface{}) {
				spec["cancelRequested"] = true
				spec["cancelReason"] = "superseded_by_new_head"
			},
		},
		"false to true": {
			before: func(spec map[string]interface{}) { spec["cancelRequested"] = false },
			after:  func(spec map[string]interface{}) { spec["cancelRequested"] = true },
		},
		"idempotent re-apply of the same cancel": {
			before: func(spec map[string]interface{}) {
				spec["cancelRequested"] = true
				spec["cancelReason"] = "superseded_by_new_head"
			},
			after: func(spec map[string]interface{}) {
				spec["cancelRequested"] = true
				spec["cancelReason"] = "superseded_by_new_head"
			},
		},
		"no-op update": {
			before: func(map[string]interface{}) {},
			after:  func(map[string]interface{}) {},
		},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			if errs := validateUpdate(t, withSpec(t, tc.before), withSpec(t, tc.after)); len(errs) > 0 {
				t.Fatalf("update rejected: %v", errs.ToAggregate())
			}
		})
	}
}

func TestV1Alpha2CRDRejectsEveryOtherSpecChange(t *testing.T) {
	cases := map[string]struct {
		before func(spec map[string]interface{})
		after  func(spec map[string]interface{})
	}{
		"true to false": {
			before: func(spec map[string]interface{}) { spec["cancelRequested"] = true },
			after:  func(spec map[string]interface{}) { spec["cancelRequested"] = false },
		},
		"true to absent": {
			before: func(spec map[string]interface{}) { spec["cancelRequested"] = true },
			after:  func(spec map[string]interface{}) { delete(spec, "cancelRequested") },
		},
		"absent to false": {
			before: func(map[string]interface{}) {},
			after:  func(spec map[string]interface{}) { spec["cancelRequested"] = false },
		},
		"reason without cancel": {
			before: func(map[string]interface{}) {},
			after:  func(spec map[string]interface{}) { spec["cancelReason"] = "x" },
		},
		"reason rewritten after cancel": {
			before: func(spec map[string]interface{}) {
				spec["cancelRequested"] = true
				spec["cancelReason"] = "superseded_by_new_head"
			},
			after: func(spec map[string]interface{}) {
				spec["cancelRequested"] = true
				spec["cancelReason"] = "other"
			},
		},
	}
	// Every other spec field, changed both alone and riding along with a valid
	// cancel flip, must be rejected.
	changes := map[string]interface{}{
		"runId":                "run_ffffffffffffffffffffffffffffffff",
		"deliveryId":           "delivery-2",
		"executionAttempt":     int64(2),
		"repositoryId":         int64(43),
		"repo":                 "calltelemetry/other",
		"prNumber":             int64(1721),
		"headSha":              strings.Repeat("f", 40),
		"baseSha":              strings.Repeat("f", 40),
		"receivedAt":           "2026-09-23T13:24:18Z",
		"terminalDeadline":     "2026-09-23T13:54:18Z",
		"policyDigest":         strings.Repeat("f", 64),
		"configDigest":         strings.Repeat("f", 64),
		"publicationMode":      "disabled",
		"workerImage":          "node:24",
		"runSecretName":        "ct-review-run-ffffffffffffffffffffffffffffffff",
		"preparedReview":       "{}",
		"runnerMode":           "prebaked",
		"qualificationProfile": "same-head",
		"qualificationModel":   "openrouter/some-model",
	}
	for fieldName, value := range changes {
		fieldName, value := fieldName, value
		cases[fieldName+" changed"] = struct {
			before func(spec map[string]interface{})
			after  func(spec map[string]interface{})
		}{
			before: func(map[string]interface{}) {},
			after:  func(spec map[string]interface{}) { spec[fieldName] = value },
		}
		cases[fieldName+" changed with cancel flip"] = struct {
			before func(spec map[string]interface{})
			after  func(spec map[string]interface{})
		}{
			before: func(map[string]interface{}) {},
			after: func(spec map[string]interface{}) {
				spec["cancelRequested"] = true
				spec[fieldName] = value
			},
		}
	}
	cases["executionAttempt removed with cancel flip"] = struct {
		before func(spec map[string]interface{})
		after  func(spec map[string]interface{})
	}{
		before: func(map[string]interface{}) {},
		after: func(spec map[string]interface{}) {
			spec["cancelRequested"] = true
			delete(spec, "executionAttempt")
		},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			errs := validateUpdate(t, withSpec(t, tc.before), withSpec(t, tc.after))
			if len(errs) == 0 {
				t.Fatal("update accepted, want rejection")
			}
			if !strings.Contains(errs.ToAggregate().Error(), "PRReviewJob spec") {
				t.Fatalf("rejected only for an unrelated reason: %v", errs.ToAggregate())
			}
		})
	}
}

// The immutability rule enumerates spec fields because CEL cannot express
// "every field except cancelRequested". A spec field added to the Go type but
// not to the rule would become silently mutable, so pin the enumeration to the
// type itself.
func TestV1Alpha2ImmutabilityRuleCoversEverySpecField(t *testing.T) {
	var rule string
	for _, validation := range loadV1Alpha2CRD(t).Spec.Versions[0].Schema.OpenAPIV3Schema.Properties["spec"].XValidations {
		if validation.Message == "PRReviewJob spec fields other than cancelRequested and cancelReason are immutable" {
			rule = validation.Rule
		}
	}
	if rule == "" {
		t.Fatal("field immutability rule is missing")
	}
	specType := reflect.TypeOf(v1alpha2.PRReviewJobSpec{})
	for index := 0; index < specType.NumField(); index++ {
		tag := specType.Field(index).Tag.Get("json")
		name, options, _ := strings.Cut(tag, ",")
		if name == "cancelRequested" || name == "cancelReason" {
			if strings.Contains(rule, "self."+name) {
				t.Fatalf("%s must stay out of the immutability rule", name)
			}
			continue
		}
		var want string
		if strings.Contains(options, "omitempty") {
			want = "has(self." + name + ") == has(oldSelf." + name + ") && (!has(self." + name + ") || self." + name + " == oldSelf." + name + ")"
		} else {
			want = "self." + name + " == oldSelf." + name
		}
		if !strings.Contains(rule, want) {
			t.Errorf("spec.%s is not pinned by the immutability rule (want %q)", name, want)
		}
	}
}
