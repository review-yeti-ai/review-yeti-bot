package v1alpha2_test

import (
	"encoding/json"
	"reflect"
	"sort"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"

	v1alpha2 "github.com/calltelemetry/ct-review-bot/k8s-operator/api/v1alpha2"
)

func contractFixture() *v1alpha2.PRReviewJob {
	receivedAt := metav1.NewTime(time.Date(2026, 8, 30, 20, 0, 0, 0, time.UTC))
	terminalDeadline := metav1.NewTime(receivedAt.Add(15 * time.Minute))
	return &v1alpha2.PRReviewJob{
		TypeMeta: metav1.TypeMeta{APIVersion: "review-yeti.ai/v1alpha2", Kind: "PRReviewJob"},
		ObjectMeta: metav1.ObjectMeta{
			Name:      "ct-review-11111111111111111111111111111111",
			Namespace: "ct-review-system",
			Labels:    map[string]string{"review-yeti.ai/publication-mode": "disabled"},
		},
		Spec: v1alpha2.PRReviewJobSpec{
			RunID:            "run_11111111111111111111111111111111",
			DeliveryID:       "actions:98765:2:123:42:head",
			RepositoryID:     123,
			Repo:             "calltelemetry/cisco-cdr",
			PRNumber:         42,
			HeadSHA:          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			BaseSHA:          "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			ReceivedAt:       receivedAt,
			TerminalDeadline: terminalDeadline,
			PolicyDigest:     "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
			ConfigDigest:     "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
			PublicationMode:  "disabled",
			WorkerImage:      "registry.digitalocean.com/calltelemetry/review-yeti-worker@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
			RunSecretName:    "ct-review-run-11111111111111111111111111111111",
		},
		Status: v1alpha2.PRReviewJobStatus{
			Phase:      v1alpha2.PhaseQueued,
			Conditions: []metav1.Condition{{Type: "Admitted", Status: metav1.ConditionTrue, Reason: "Authenticated", Message: "accepted", LastTransitionTime: receivedAt}},
		},
	}
}

func TestPRReviewJobV1Alpha2ExactProjectionShape(t *testing.T) {
	encoded, err := json.Marshal(contractFixture().Spec)
	if err != nil {
		t.Fatalf("marshal spec: %v", err)
	}
	var projected map[string]any
	if err := json.Unmarshal(encoded, &projected); err != nil {
		t.Fatalf("unmarshal spec: %v", err)
	}
	got := make([]string, 0, len(projected))
	for key := range projected {
		got = append(got, key)
	}
	sort.Strings(got)
	want := []string{
		"baseSha", "configDigest", "deliveryId", "headSha", "policyDigest", "prNumber",
		"publicationMode", "receivedAt", "repo", "repositoryId", "runId", "runSecretName",
		"terminalDeadline", "workerImage",
	}
	sort.Strings(want)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("projection fields mismatch\n got: %v\nwant: %v", got, want)
	}
	if projected["publicationMode"] != "disabled" {
		t.Fatalf("publication mode = %v, want disabled", projected["publicationMode"])
	}
}

func TestPRReviewJobV1Alpha2SchemeAndDeepCopy(t *testing.T) {
	scheme := runtime.NewScheme()
	if err := v1alpha2.AddToScheme(scheme); err != nil {
		t.Fatalf("register v1alpha2: %v", err)
	}
	gvks, _, err := scheme.ObjectKinds(contractFixture())
	if err != nil {
		t.Fatalf("object kinds: %v", err)
	}
	if len(gvks) != 1 || gvks[0].Group != "review-yeti.ai" || gvks[0].Version != "v1alpha2" {
		t.Fatalf("unexpected GVKs: %#v", gvks)
	}

	original := contractFixture()
	copy := original.DeepCopy()
	copy.Labels["review-yeti.ai/publication-mode"] = "changed"
	copy.Status.Conditions[0].Reason = "Changed"
	if original.Labels["review-yeti.ai/publication-mode"] != "disabled" {
		t.Fatal("metadata labels were not deep copied")
	}
	if original.Status.Conditions[0].Reason != "Authenticated" {
		t.Fatal("status conditions were not deep copied")
	}
}
