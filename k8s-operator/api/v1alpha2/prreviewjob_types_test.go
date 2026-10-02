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
	terminalDeadline := metav1.NewTime(receivedAt.Add(25 * time.Minute))
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
			Repo:             "exampleorg/example-api",
			PRNumber:         42,
			HeadSHA:          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			BaseSHA:          "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			ReceivedAt:       receivedAt,
			TerminalDeadline: terminalDeadline,
			PolicyDigest:     "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
			ConfigDigest:     "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
			PublicationMode:  "disabled",
			WorkerImage:      "registry.digitalocean.com/exampleorg/review-yeti-worker@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
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
	attempt := int32(2)
	original.Spec.ExecutionAttempt = &attempt
	copy := original.DeepCopy()
	copy.Labels["review-yeti.ai/publication-mode"] = "changed"
	copy.Status.Conditions[0].Reason = "Changed"
	*copy.Spec.ExecutionAttempt = 3
	if original.Labels["review-yeti.ai/publication-mode"] != "disabled" {
		t.Fatal("metadata labels were not deep copied")
	}
	if original.Status.Conditions[0].Reason != "Authenticated" {
		t.Fatal("status conditions were not deep copied")
	}
	if *original.Spec.ExecutionAttempt != 2 {
		t.Fatal("execution attempt was not deep copied")
	}
}

func TestPRReviewJobV1Alpha2PreparedReviewDeepCopy(t *testing.T) {
	original := contractFixture()
	envelope := `{"version":"PreparedReviewExecution.v1","config":{},"transport":{"baseUrl":"https://gateway.example.invalid/v1","model":"review-model"}}`
	original.Spec.PreparedReview = &envelope
	copy := original.DeepCopy()
	if copy.Spec.PreparedReview == nil || *copy.Spec.PreparedReview != envelope {
		t.Fatal("prepared review envelope was not preserved")
	}
	*copy.Spec.PreparedReview = "changed"
	if *original.Spec.PreparedReview != envelope || original.Spec.PreparedReview == copy.Spec.PreparedReview {
		t.Fatal("prepared review pointer was not deep copied")
	}
	if contractFixture().DeepCopy().Spec.PreparedReview != nil {
		t.Fatal("legacy deepcopy must leave prepared review absent")
	}
}

func TestDispatchTimingStatusRecordsOnlyMonotonicLifecycleStages(t *testing.T) {
	received := metav1.NewTime(time.Date(2026, 8, 31, 12, 0, 0, 0, time.UTC))
	timing := v1alpha2.DispatchTimingStatus{}

	for _, observation := range []struct {
		stage v1alpha2.DispatchTimingStage
		at    metav1.Time
	}{
		{v1alpha2.DispatchStageReceived, received},
		{v1alpha2.DispatchStageJobCreated, metav1.NewTime(received.Add(2 * time.Second))},
		{v1alpha2.DispatchStagePodScheduled, metav1.NewTime(received.Add(4 * time.Second))},
		{v1alpha2.DispatchStageImageObserved, metav1.NewTime(received.Add(6 * time.Second))},
		{v1alpha2.DispatchStageProcessStarted, metav1.NewTime(received.Add(8 * time.Second))},
		{v1alpha2.DispatchStageCompleted, metav1.NewTime(received.Add(10 * time.Second))},
	} {
		changed, err := timing.Observe(observation.stage, observation.at)
		if err != nil {
			t.Fatalf("observe %s: %v", observation.stage, err)
		}
		if !changed {
			t.Fatalf("first observation for %s was not recorded", observation.stage)
		}
	}
	if err := timing.Validate(); err != nil {
		t.Fatalf("valid timing rejected: %v", err)
	}

	changed, err := timing.Observe(v1alpha2.DispatchStageCompleted, metav1.NewTime(received.Add(20*time.Second)))
	if err != nil {
		t.Fatalf("re-observing a stage should be idempotent: %v", err)
	}
	if changed {
		t.Fatal("re-observing a stage must preserve its first durable timestamp")
	}
}

func TestDispatchTimingStatusRejectsBackwardOrUnknownObservations(t *testing.T) {
	received := metav1.NewTime(time.Date(2026, 8, 31, 12, 0, 0, 0, time.UTC))
	timing := v1alpha2.DispatchTimingStatus{}
	if _, err := timing.Observe(v1alpha2.DispatchStageJobCreated, received); err == nil {
		t.Fatal("job-created observation without receipt must fail closed")
	}
	if _, err := timing.Observe(v1alpha2.DispatchStageReceived, received); err != nil {
		t.Fatalf("observe receipt: %v", err)
	}
	if _, err := timing.Observe(v1alpha2.DispatchStageJobCreated, metav1.NewTime(received.Add(-time.Second))); err == nil {
		t.Fatal("backward job-created observation must fail closed")
	}
	if _, err := timing.Observe(v1alpha2.DispatchTimingStage("unknown"), received); err == nil {
		t.Fatal("unknown timing stage must fail closed")
	}
	if err := timing.Validate(); err != nil {
		t.Fatalf("failed observations should not corrupt timing: %v", err)
	}
}

func TestPRReviewJobV1Alpha2FencingProjection(t *testing.T) {
	fixture := contractFixture()
	fixture.Spec.LogicalChildID = "child-review-worker-1"
	fixture.Spec.FencingEpoch = 42
	fixture.Spec.WorkerLeaseToken = "lease-token-alpha"

	encoded, err := json.Marshal(fixture.Spec)
	if err != nil {
		t.Fatalf("marshal spec with fencing: %v", err)
	}
	var projected map[string]any
	if err := json.Unmarshal(encoded, &projected); err != nil {
		t.Fatalf("unmarshal spec with fencing: %v", err)
	}

	if projected["logicalChildId"] != "child-review-worker-1" {
		t.Fatalf("projected logicalChildId = %v, want child-review-worker-1", projected["logicalChildId"])
	}
	if projected["fencingEpoch"] != float64(42) {
		t.Fatalf("projected fencingEpoch = %v, want 42", projected["fencingEpoch"])
	}
	if projected["workerLeaseToken"] != "lease-token-alpha" {
		t.Fatalf("projected workerLeaseToken = %v, want lease-token-alpha", projected["workerLeaseToken"])
	}
}

func TestPRReviewJobV1Alpha2FencingValidation(t *testing.T) {
	validSpec := contractFixture().Spec
	validSpec.LogicalChildID = "child-review-worker-1"
	validSpec.FencingEpoch = 1
	validSpec.WorkerLeaseToken = "lease-token-1"
	if err := validSpec.ValidateFencing(); err != nil {
		t.Fatalf("valid fencing spec rejected: %v", err)
	}

	// Nil spec
	var nilSpec *v1alpha2.PRReviewJobSpec
	if err := nilSpec.ValidateFencing(); err == nil {
		t.Fatal("expected error on nil spec")
	}

	// Invalid logical child ID (invalid characters)
	invalidChildID := validSpec
	invalidChildID.LogicalChildID = "child@bad#id"
	if err := invalidChildID.ValidateFencing(); err == nil {
		t.Fatal("expected error on invalid logicalChildId characters")
	}

	// Invalid fencing epoch (negative or 0)
	invalidEpoch := validSpec
	invalidEpoch.FencingEpoch = -5
	if err := invalidEpoch.ValidateFencing(); err == nil {
		t.Fatal("expected error on negative fencingEpoch")
	}

	// Invalid fencing epoch (exceeds max safe integer)
	exceedsMaxEpoch := validSpec
	exceedsMaxEpoch.FencingEpoch = 9007199254740992
	if err := exceedsMaxEpoch.ValidateFencing(); err == nil {
		t.Fatal("expected error on fencingEpoch exceeding max safe integer")
	}

	// Invalid worker lease token (invalid characters)
	invalidLease := validSpec
	invalidLease.WorkerLeaseToken = "token with spaces!"
	if err := invalidLease.ValidateFencing(); err == nil {
		t.Fatal("expected error on invalid workerLeaseToken")
	}
}

func TestPRReviewJobV1Alpha2StatusHelpers(t *testing.T) {
	status := &v1alpha2.PRReviewJobStatus{}

	if status.HasFencingEpochMismatch() {
		t.Fatal("expected HasFencingEpochMismatch false on empty status")
	}
	if status.HasStaleWorkerLease() {
		t.Fatal("expected HasStaleWorkerLease false on empty status")
	}
	if status.HasUnknownEffectPending() {
		t.Fatal("expected HasUnknownEffectPending false on empty status")
	}
	if status.ReceiptIsAuditable() {
		t.Fatal("expected ReceiptIsAuditable false on empty status")
	}

	now := metav1.NewTime(time.Now())
	status.Conditions = append(status.Conditions, metav1.Condition{
		Type:               v1alpha2.ConditionFencingEpochMismatch,
		Status:             metav1.ConditionTrue,
		Reason:             "EpochMismatch",
		LastTransitionTime: now,
	})
	if !status.HasFencingEpochMismatch() {
		t.Fatal("expected HasFencingEpochMismatch true")
	}

	status.Conditions = append(status.Conditions, metav1.Condition{
		Type:               v1alpha2.ConditionStaleWorkerLease,
		Status:             metav1.ConditionTrue,
		Reason:             "LeaseExpired",
		LastTransitionTime: now,
	})
	if !status.HasStaleWorkerLease() {
		t.Fatal("expected HasStaleWorkerLease true")
	}

	status.Conditions = append(status.Conditions, metav1.Condition{
		Type:               v1alpha2.ConditionUnknownEffectPending,
		Status:             metav1.ConditionTrue,
		Reason:             "UnknownEffectPreserved",
		LastTransitionTime: now,
	})
	if !status.HasUnknownEffectPending() {
		t.Fatal("expected HasUnknownEffectPending true")
	}

	status.ReceiptDigest = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	if !status.ReceiptIsAuditable() {
		t.Fatal("expected ReceiptIsAuditable true when ReceiptDigest is set")
	}
}

func TestPRReviewJobV1Alpha2FencingDeepCopy(t *testing.T) {
	original := contractFixture()
	original.Spec.LogicalChildID = "child-1"
	original.Spec.FencingEpoch = 5
	original.Spec.WorkerLeaseToken = "token-1"
	original.Status.AuthoritativeFencingEpoch = 5
	original.Status.ActiveWorkerLeaseToken = "token-1"
	original.Status.ReceiptDigest = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	original.Status.ReceiptEvidenceRef = "audit://ct-review-system/receipt-1"

	copied := original.DeepCopy()
	if copied.Spec.LogicalChildID != "child-1" || copied.Spec.FencingEpoch != 5 || copied.Spec.WorkerLeaseToken != "token-1" {
		t.Fatalf("spec fencing fields were not deep copied: %#v", copied.Spec)
	}
	if copied.Status.AuthoritativeFencingEpoch != 5 || copied.Status.ActiveWorkerLeaseToken != "token-1" ||
		copied.Status.ReceiptDigest != original.Status.ReceiptDigest || copied.Status.ReceiptEvidenceRef != original.Status.ReceiptEvidenceRef {
		t.Fatalf("status fencing/receipt fields were not deep copied: %#v", copied.Status)
	}
}
