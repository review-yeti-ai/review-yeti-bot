package controllers

import (
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	reviewv1alpha2 "github.com/review-yeti-ai/review-yeti-bot/k8s-operator/api/v1alpha2"
	"github.com/review-yeti-ai/review-yeti-bot/k8s-operator/pkg/operatorconfig"
)

func TestOperatorNamespaceConfigKeepsReviewAndCapacityScopesSeparate(t *testing.T) {
	production, err := operatorconfig.NamespaceConfigFromEnv(func(string) (string, bool) { return "", false })
	if err != nil {
		t.Fatal(err)
	}
	qualification, err := operatorconfig.NamespaceConfigFromEnv(func(name string) (string, bool) {
		values := map[string]string{
			operatorconfig.QualificationInstanceEnv: "true",
			operatorconfig.NamespaceEnv:             operatorconfig.QualificationNamespace,
			operatorconfig.PodNamespaceEnv:          operatorconfig.QualificationNamespace,
		}
		value, ok := values[name]
		return value, ok
	})
	if err != nil {
		t.Fatal(err)
	}
	if production.Namespace() == qualification.Namespace() {
		t.Fatalf("production and qualification namespaces overlap: %q", production.Namespace())
	}

	now := time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)
	review := &reviewv1alpha2.PRReviewJob{
		ObjectMeta: metav1.ObjectMeta{Name: "qualification-review", Namespace: qualification.Namespace()},
		Spec: reviewv1alpha2.PRReviewJobSpec{
			ReceivedAt:       metav1.NewTime(now),
			TerminalDeadline: metav1.NewTime(now.Add(15 * time.Minute)),
		},
		Status: reviewv1alpha2.PRReviewJobStatus{Phase: reviewv1alpha2.PhaseQueued},
	}
	if err := validateProjectionWindow(review, qualification.Namespace()); err != nil {
		t.Fatalf("qualified review rejected in its configured namespace: %v", err)
	}
	if err := validateProjectionWindow(review, production.Namespace()); err == nil {
		t.Fatal("production instance accepted a qualification-namespace review")
	}
	if !validWorkerAdmissionCandidate(review, now, qualification.Namespace()) {
		t.Fatal("qualified review was not admitted by the matching instance")
	}
	if validWorkerAdmissionCandidate(review, now, production.Namespace()) {
		t.Fatal("production instance admitted a qualification-namespace review")
	}

	productionLedger := (&PRReviewJobV1Alpha2Reconciler{OperatorNamespace: production}).getCapacityLedger()
	qualificationLedger := (&PRReviewJobV1Alpha2Reconciler{OperatorNamespace: qualification}).getCapacityLedger()
	if productionLedger.Namespace() != production.Namespace() || qualificationLedger.Namespace() != qualification.Namespace() {
		t.Fatalf("capacity ledger namespaces = (%q,%q), want (%q,%q)",
			productionLedger.Namespace(), qualificationLedger.Namespace(), production.Namespace(), qualification.Namespace())
	}
}
