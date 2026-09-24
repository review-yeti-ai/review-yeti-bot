package controllers

import (
	"testing"

	reviewv1alpha2 "github.com/calltelemetry/ct-review-bot/k8s-operator/api/v1alpha2"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/job"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/types"
)

// REL-1069 review: the validator half of the builder/validator coupling had no
// visible test. It lives in this package, so it is tested here directly rather
// than through a reconcile, where the receipt-only check fires first and masks
// the gateway-env comparison entirely (observed: an external test asserted the
// mismatch reason and passed with the validator drift PLANTED, because the
// reason came from a different contract).
func TestManagedWorkerEnvMatchesBindsTheBuilderGatewayEnvName(t *testing.T) {
	review := &reviewv1alpha2.PRReviewJob{}
	review.Spec.QualificationProfile = job.SameHeadQualificationProfile
	review.Spec.QualificationModel = "pr-reviewer"
	review.Spec.RunSecretName = "ct-review-run-abc"
	review.UID = types.UID("env-contract")

	secretRef := func(name, key string, optional bool) corev1.EnvVar {
		return corev1.EnvVar{
			Name: name,
			ValueFrom: &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{
				LocalObjectReference: corev1.LocalObjectReference{Name: "ct-review-run-abc"},
				Key:                  key, Optional: &optional,
			}},
		}
	}
	base := func(gatewayName string) []corev1.EnvVar {
		return []corev1.EnvVar{
			{Name: job.SameHeadQualificationEnv, Value: "true"},
			{Name: job.QualificationModelEnv, Value: "pr-reviewer"},
			secretRef(gatewayName, gatewayName, true),
			secretRef("GH_TOKEN", "GITHUB_READ_TOKEN", false),
		}
	}

	if !managedWorkerEnvMatches(review, base(job.QualificationGatewayKeyEnv)) {
		t.Fatalf("the validator rejected the env the builder emits (%s); the two halves have drifted apart", job.QualificationGatewayKeyEnv)
	}

	// The counterfactual: a validator still expecting the LEGACY name must reject
	// the standard-name env. If it accepts, the coupling is no longer pinned.
	if managedWorkerEnvMatches(review, base("OPENROUTER_API_KEY")) {
		t.Fatalf("the validator accepted the LEGACY gateway env name; it no longer pins the builder contract")
	}

	// A drifted secret KEY (right env name, wrong key) must also be rejected.
	driftedKey := base(job.QualificationGatewayKeyEnv)
	driftedKey[2].ValueFrom.SecretKeyRef.Key = "OPENROUTER_API_KEY"
	if managedWorkerEnvMatches(review, driftedKey) {
		t.Fatalf("the validator accepted a drifted gateway secret key")
	}

}
