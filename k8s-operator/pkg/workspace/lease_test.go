package workspace_test

import (
	"context"
	"errors"
	"testing"
	"time"

	coordinationv1 "k8s.io/api/coordination/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/workspace"
)

func leaseClient(t *testing.T, objects ...runtime.Object) *workspace.LeaseManager {
	t.Helper()
	scheme := runtime.NewScheme()
	if err := coordinationv1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	client := fake.NewClientBuilder().WithScheme(scheme).WithRuntimeObjects(objects...).Build()
	return workspace.NewLeaseManager(client)
}

type resourceVersionRecordingClient struct {
	client.Client
	updatedResourceVersion string
}

var errKubernetesOperation = errors.New("synthetic Kubernetes operation failure")

type operationFailingClient struct {
	client.Client
	failGet    bool
	failCreate bool
	failUpdate bool
}

func (c *operationFailingClient) Get(ctx context.Context, key client.ObjectKey, object client.Object, options ...client.GetOption) error {
	if c.failGet {
		return errKubernetesOperation
	}
	return c.Client.Get(ctx, key, object, options...)
}

func (c *operationFailingClient) Create(ctx context.Context, object client.Object, options ...client.CreateOption) error {
	if c.failCreate {
		return errKubernetesOperation
	}
	return c.Client.Create(ctx, object, options...)
}

func (c *operationFailingClient) Update(ctx context.Context, object client.Object, options ...client.UpdateOption) error {
	if c.failUpdate {
		return errKubernetesOperation
	}
	return c.Client.Update(ctx, object, options...)
}

func (c *resourceVersionRecordingClient) Update(ctx context.Context, object client.Object, options ...client.UpdateOption) error {
	c.updatedResourceVersion = object.GetResourceVersion()
	return c.Client.Update(ctx, object, options...)
}

func TestAcquireLeaseCreatesAndRenewsSameRun(t *testing.T) {
	now := time.Date(2026, 8, 30, 20, 0, 0, 0, time.UTC)
	manager := leaseClient(t)
	first, err := manager.Acquire(context.Background(), "ct-review-system", 123, 42, "run_11111111111111111111111111111111", now.Add(15*time.Minute), now)
	if err != nil || !first.Acquired {
		t.Fatalf("first acquire = %#v, %v", first, err)
	}
	if first.Lease.Spec.LeaseDurationSeconds == nil || *first.Lease.Spec.LeaseDurationSeconds != 960 {
		t.Fatalf("lease duration = %v, want 960", first.Lease.Spec.LeaseDurationSeconds)
	}
	renewAt := now.Add(time.Minute)
	second, err := manager.Acquire(context.Background(), "ct-review-system", 123, 42, "run_11111111111111111111111111111111", now.Add(15*time.Minute), renewAt)
	if err != nil || !second.Acquired {
		t.Fatalf("same-run renewal = %#v, %v", second, err)
	}
	if second.Lease.Spec.RenewTime == nil || !second.Lease.Spec.RenewTime.Time.Equal(renewAt) {
		t.Fatalf("renew time = %v, want %v", second.Lease.Spec.RenewTime, renewAt)
	}
}

func TestAcquireLeaseRejectsDifferentActiveRun(t *testing.T) {
	now := time.Date(2026, 8, 30, 20, 0, 0, 0, time.UTC)
	manager := leaseClient(t)
	if _, err := manager.Acquire(context.Background(), "ct-review-system", 123, 42, "run_11111111111111111111111111111111", now.Add(15*time.Minute), now); err != nil {
		t.Fatal(err)
	}
	result, err := manager.Acquire(context.Background(), "ct-review-system", 123, 42, "run_22222222222222222222222222222222", now.Add(15*time.Minute), now.Add(time.Minute))
	if !errors.Is(err, workspace.ErrLeaseHeld) || result.Acquired {
		t.Fatalf("different-run acquire = %#v, %v", result, err)
	}
	if result.HolderIdentity != "run_11111111111111111111111111111111" || !result.HeldUntil.After(now) {
		t.Fatalf("missing bounded holder evidence: %#v", result)
	}
}

func TestReleaseLeaseOnlyClearsCurrentOwner(t *testing.T) {
	now := time.Date(2026, 8, 30, 20, 0, 0, 0, time.UTC)
	runID := "run_11111111111111111111111111111111"
	manager := leaseClient(t)
	if _, err := manager.Acquire(context.Background(), "ct-review-system", 123, 42, runID, now.Add(15*time.Minute), now); err != nil {
		t.Fatal(err)
	}
	if err := manager.Release(context.Background(), "ct-review-system", 123, 42, runID, now.Add(time.Minute)); err != nil {
		t.Fatalf("release: %v", err)
	}
	if _, err := manager.Acquire(context.Background(), "ct-review-system", 123, 42, "run_22222222222222222222222222222222", now.Add(15*time.Minute), now.Add(2*time.Minute)); err != nil {
		t.Fatalf("released lease should be reusable: %v", err)
	}
}

func TestReleaseLeaseRejectsDifferentOwner(t *testing.T) {
	now := time.Date(2026, 8, 30, 20, 0, 0, 0, time.UTC)
	manager := leaseClient(t)
	owner := "run_11111111111111111111111111111111"
	other := "run_22222222222222222222222222222222"
	if _, err := manager.Acquire(context.Background(), "ct-review-system", 123, 42, owner, now.Add(15*time.Minute), now); err != nil {
		t.Fatal(err)
	}
	if err := manager.Release(context.Background(), "ct-review-system", 123, 42, other, now.Add(time.Minute)); !errors.Is(err, workspace.ErrLeaseHeld) {
		t.Fatalf("different owner release = %v, want ErrLeaseHeld", err)
	}
}

func TestAcquireLeaseTakesExpiredLeaseWithResourceVersion(t *testing.T) {
	now := time.Date(2026, 8, 30, 20, 20, 0, 0, time.UTC)
	labels, annotations := workspace.Metadata(123, 42)
	oldRun := "run_11111111111111111111111111111111"
	renewed := metav1.NewMicroTime(now.Add(-2 * time.Minute))
	duration := int32(60)
	transitions := int32(2)
	existing := &coordinationv1.Lease{
		ObjectMeta: metav1.ObjectMeta{
			Name: workspace.LeaseName(123, 42), Namespace: "ct-review-system", ResourceVersion: "7",
			Labels: labels, Annotations: annotations,
		},
		Spec: coordinationv1.LeaseSpec{
			HolderIdentity: &oldRun, RenewTime: &renewed, LeaseDurationSeconds: &duration, LeaseTransitions: &transitions,
		},
	}
	scheme := runtime.NewScheme()
	if err := coordinationv1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	recording := &resourceVersionRecordingClient{Client: fake.NewClientBuilder().WithScheme(scheme).WithObjects(existing).Build()}
	manager := workspace.NewLeaseManager(recording)
	result, err := manager.Acquire(
		context.Background(), "ct-review-system", 123, 42,
		"run_22222222222222222222222222222222", now.Add(15*time.Minute), now,
		workspace.TakeoverEvidence{PreviousRunID: oldRun, AllPodsTerminal: true},
	)
	if err != nil || !result.Acquired {
		t.Fatalf("expired takeover = %#v, %v", result, err)
	}
	if result.Lease.Spec.HolderIdentity == nil || *result.Lease.Spec.HolderIdentity != "run_22222222222222222222222222222222" {
		t.Fatalf("holder = %v", result.Lease.Spec.HolderIdentity)
	}
	if result.Lease.Spec.LeaseTransitions == nil || *result.Lease.Spec.LeaseTransitions != 3 {
		t.Fatalf("transitions = %v, want 3", result.Lease.Spec.LeaseTransitions)
	}
	if recording.updatedResourceVersion != "7" {
		t.Fatalf("takeover update used resourceVersion %q, want the fetched value 7", recording.updatedResourceVersion)
	}
}

func TestAcquireLeaseRefusesExpiredTakeoverWithoutTerminalPodEvidence(t *testing.T) {
	now := time.Date(2026, 8, 30, 20, 20, 0, 0, time.UTC)
	labels, annotations := workspace.Metadata(123, 42)
	oldRun := "run_11111111111111111111111111111111"
	renewed := metav1.NewMicroTime(now.Add(-2 * time.Minute))
	duration := int32(60)
	existing := &coordinationv1.Lease{
		ObjectMeta: metav1.ObjectMeta{Name: workspace.LeaseName(123, 42), Namespace: "ct-review-system", Labels: labels, Annotations: annotations},
		Spec:       coordinationv1.LeaseSpec{HolderIdentity: &oldRun, RenewTime: &renewed, LeaseDurationSeconds: &duration},
	}
	manager := leaseClient(t, existing)
	for _, evidence := range []workspace.TakeoverEvidence{
		{},
		{PreviousRunID: oldRun, AllPodsTerminal: false},
		{PreviousRunID: "run_33333333333333333333333333333333", AllPodsTerminal: true},
	} {
		result, err := manager.Acquire(
			context.Background(), "ct-review-system", 123, 42,
			"run_22222222222222222222222222222222", now.Add(15*time.Minute), now, evidence,
		)
		if !errors.Is(err, workspace.ErrLeaseTakeoverNotAuthorized) || result.Acquired {
			t.Fatalf("unsafe takeover evidence %#v returned %#v, %v", evidence, result, err)
		}
	}
}

func TestAcquireLeaseFailsClosedForLateOrInvalidIdentity(t *testing.T) {
	now := time.Date(2026, 8, 30, 20, 0, 0, 0, time.UTC)
	manager := leaseClient(t)
	for _, test := range []struct {
		runID    string
		deadline time.Time
	}{
		{"run_invalid", now.Add(15 * time.Minute)},
		{"run_11111111111111111111111111111111", now.Add(119*time.Second + 999*time.Millisecond)},
	} {
		if _, err := manager.Acquire(context.Background(), "ct-review-system", 123, 42, test.runID, test.deadline, now); err == nil {
			t.Fatalf("invalid acquire must fail: %#v", test)
		}
	}
}

func TestAcquireLeaseFailsClosedForUnboundedDuration(t *testing.T) {
	now := time.Date(2026, 8, 30, 20, 0, 0, 0, time.UTC)
	manager := leaseClient(t)
	if _, err := manager.Acquire(
		context.Background(), "ct-review-system", 123, 42,
		"run_11111111111111111111111111111111", now.Add(70*365*24*time.Hour), now,
	); !errors.Is(err, workspace.ErrLeaseState) {
		t.Fatalf("unbounded deadline error = %v, want ErrLeaseState", err)
	}
}

func TestAcquireLeaseRejectsMalformedHeldLeaseState(t *testing.T) {
	now := time.Date(2026, 8, 30, 20, 0, 0, 0, time.UTC)
	labels, annotations := workspace.Metadata(123, 42)
	holder := "run_11111111111111111111111111111111"
	duration := int32(60)
	for name, spec := range map[string]coordinationv1.LeaseSpec{
		"missing duration":    {HolderIdentity: &holder},
		"missing lease times": {HolderIdentity: &holder, LeaseDurationSeconds: &duration},
	} {
		t.Run(name, func(t *testing.T) {
			lease := &coordinationv1.Lease{
				ObjectMeta: metav1.ObjectMeta{Name: workspace.LeaseName(123, 42), Namespace: "ct-review-system", Labels: labels, Annotations: annotations},
				Spec:       spec,
			}
			manager := leaseClient(t, lease)
			if _, err := manager.Acquire(
				context.Background(), "ct-review-system", 123, 42,
				holder, now.Add(15*time.Minute), now,
			); !errors.Is(err, workspace.ErrLeaseState) {
				t.Fatalf("malformed held lease error = %v, want ErrLeaseState", err)
			}
		})
	}
}

func TestValidateLeaseForUseRequiresCurrentHolderAndUnexpiredLease(t *testing.T) {
	now := time.Date(2026, 8, 30, 20, 0, 0, 0, time.UTC)
	runID := "run_11111111111111111111111111111111"
	labels, annotations := workspace.Metadata(123, 42)
	duration := int32(120)
	holder := runID
	renewed := metav1.NewMicroTime(now)
	lease := &coordinationv1.Lease{
		ObjectMeta: metav1.ObjectMeta{Name: workspace.LeaseName(123, 42), Namespace: "ct-review-system", Labels: labels, Annotations: annotations},
		Spec:       coordinationv1.LeaseSpec{HolderIdentity: &holder, LeaseDurationSeconds: &duration, RenewTime: &renewed},
	}
	if err := workspace.ValidateLeaseForUse(lease, "ct-review-system", 123, 42, runID, now); err != nil {
		t.Fatalf("current unexpired lease rejected: %v", err)
	}
	if err := workspace.ValidateLeaseForUse(lease, "ct-review-system", 123, 42, "run_22222222222222222222222222222222", now); !errors.Is(err, workspace.ErrLeaseHeld) {
		t.Fatalf("wrong holder error = %v, want ErrLeaseHeld", err)
	}
	if err := workspace.ValidateLeaseForUse(lease, "ct-review-system", 123, 42, runID, now.Add(120*time.Second)); !errors.Is(err, workspace.ErrLeaseHeld) {
		t.Fatalf("expired lease error = %v, want ErrLeaseHeld", err)
	}
	terminating := lease.DeepCopy()
	deletionTimestamp := metav1.NewTime(now)
	terminating.DeletionTimestamp = &deletionTimestamp
	if err := workspace.ValidateLeaseForUse(terminating, "ct-review-system", 123, 42, runID, now); !errors.Is(err, workspace.ErrWorkspaceTerminating) {
		t.Fatalf("terminating lease error = %v, want ErrWorkspaceTerminating", err)
	}
}

func TestValidateLeaseForUseRejectsInvalidInputs(t *testing.T) {
	now := time.Date(2026, 8, 30, 20, 0, 0, 0, time.UTC)
	runID := "run_11111111111111111111111111111111"
	labels, annotations := workspace.Metadata(123, 42)
	duration := int32(120)
	holder := runID
	renewed := metav1.NewMicroTime(now)
	validLease := &coordinationv1.Lease{
		ObjectMeta: metav1.ObjectMeta{Name: workspace.LeaseName(123, 42), Namespace: "ct-review-system", Labels: labels, Annotations: annotations},
		Spec:       coordinationv1.LeaseSpec{HolderIdentity: &holder, LeaseDurationSeconds: &duration, RenewTime: &renewed},
	}
	tests := []struct {
		name         string
		lease        *coordinationv1.Lease
		namespace    string
		repositoryID int64
		prNumber     int32
		candidateRun string
		at           time.Time
	}{
		{name: "nil lease", lease: nil, namespace: "ct-review-system", repositoryID: 123, prNumber: 42, candidateRun: runID, at: now},
		{name: "zero timestamp", lease: validLease, namespace: "ct-review-system", repositoryID: 123, prNumber: 42, candidateRun: runID, at: time.Time{}},
		{name: "invalid namespace", lease: validLease, namespace: "not a namespace", repositoryID: 123, prNumber: 42, candidateRun: runID, at: now},
		{name: "invalid repository", lease: validLease, namespace: "ct-review-system", repositoryID: 0, prNumber: 42, candidateRun: runID, at: now},
		{name: "invalid pull request", lease: validLease, namespace: "ct-review-system", repositoryID: 123, prNumber: 0, candidateRun: runID, at: now},
		{name: "malformed run id", lease: validLease, namespace: "ct-review-system", repositoryID: 123, prNumber: 42, candidateRun: "not-a-run-id", at: now},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if err := workspace.ValidateLeaseForUse(test.lease, test.namespace, test.repositoryID, test.prNumber, test.candidateRun, test.at); !errors.Is(err, workspace.ErrLeaseState) {
				t.Fatalf("invalid input error = %v, want ErrLeaseState", err)
			}
		})
	}
}

func TestAcquireLeaseUsesAcquireTimeWhenRenewTimeIsAbsent(t *testing.T) {
	now := time.Date(2026, 8, 30, 20, 0, 0, 0, time.UTC)
	labels, annotations := workspace.Metadata(123, 42)
	holder := "run_11111111111111111111111111111111"
	acquiredAt := metav1.NewMicroTime(now)
	duration := int32(60)
	lease := &coordinationv1.Lease{
		ObjectMeta: metav1.ObjectMeta{Name: workspace.LeaseName(123, 42), Namespace: "ct-review-system", Labels: labels, Annotations: annotations},
		Spec:       coordinationv1.LeaseSpec{HolderIdentity: &holder, AcquireTime: &acquiredAt, LeaseDurationSeconds: &duration},
	}
	manager := leaseClient(t, lease)
	result, err := manager.Acquire(
		context.Background(), "ct-review-system", 123, 42,
		"run_22222222222222222222222222222222", now.Add(15*time.Minute), now.Add(30*time.Second),
	)
	if !errors.Is(err, workspace.ErrLeaseHeld) || !result.HeldUntil.Equal(now.Add(time.Minute)) {
		t.Fatalf("AcquireTime fallback = %#v, %v", result, err)
	}
}

func TestAcquireLeaseClaimsAnExistingUnheldLease(t *testing.T) {
	now := time.Date(2026, 8, 30, 20, 0, 0, 0, time.UTC)
	labels, annotations := workspace.Metadata(123, 42)
	lease := &coordinationv1.Lease{ObjectMeta: metav1.ObjectMeta{
		Name: workspace.LeaseName(123, 42), Namespace: "ct-review-system", Labels: labels, Annotations: annotations,
	}}
	manager := leaseClient(t, lease)
	result, err := manager.Acquire(
		context.Background(), "ct-review-system", 123, 42,
		"run_11111111111111111111111111111111", now.Add(15*time.Minute), now,
	)
	if err != nil || !result.Acquired {
		t.Fatalf("unheld lease acquisition = %#v, %v", result, err)
	}
}

func TestAcquireLeasePropagatesKubernetesClientFailures(t *testing.T) {
	now := time.Date(2026, 8, 30, 20, 0, 0, 0, time.UTC)
	scheme := runtime.NewScheme()
	if err := coordinationv1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	labels, annotations := workspace.Metadata(123, 42)
	holder := "run_11111111111111111111111111111111"
	renewed := metav1.NewMicroTime(now)
	duration := int32(960)
	existing := &coordinationv1.Lease{
		ObjectMeta: metav1.ObjectMeta{Name: workspace.LeaseName(123, 42), Namespace: "ct-review-system", Labels: labels, Annotations: annotations},
		Spec:       coordinationv1.LeaseSpec{HolderIdentity: &holder, RenewTime: &renewed, LeaseDurationSeconds: &duration},
	}
	tests := map[string]*operationFailingClient{
		"get": {
			Client: fake.NewClientBuilder().WithScheme(scheme).Build(), failGet: true,
		},
		"create": {
			Client: fake.NewClientBuilder().WithScheme(scheme).Build(), failCreate: true,
		},
		"update": {
			Client: fake.NewClientBuilder().WithScheme(scheme).WithObjects(existing.DeepCopy()).Build(), failUpdate: true,
		},
	}
	for name, failingClient := range tests {
		t.Run(name, func(t *testing.T) {
			manager := workspace.NewLeaseManager(failingClient)
			if _, err := manager.Acquire(
				context.Background(), "ct-review-system", 123, 42,
				holder, now.Add(15*time.Minute), now,
			); !errors.Is(err, errKubernetesOperation) {
				t.Fatalf("%s failure = %v, want synthetic Kubernetes error", name, err)
			}
		})
	}
}

func TestAcquireLeaseRejectsTamperedOrTerminatingLease(t *testing.T) {
	now := time.Date(2026, 8, 30, 20, 0, 0, 0, time.UTC)
	for name, mutate := range map[string]func(*coordinationv1.Lease){
		"tampered": func(lease *coordinationv1.Lease) {
			lease.Annotations[workspace.WorkspaceKeyAnnotation] = workspace.Key(123, 43)
		},
		"terminating": func(lease *coordinationv1.Lease) {
			timestamp := metav1.Now()
			lease.DeletionTimestamp = &timestamp
			lease.Finalizers = []string{"test"}
		},
	} {
		t.Run(name, func(t *testing.T) {
			labels, annotations := workspace.Metadata(123, 42)
			lease := &coordinationv1.Lease{ObjectMeta: metav1.ObjectMeta{
				Name: workspace.LeaseName(123, 42), Namespace: "ct-review-system", Labels: labels, Annotations: annotations,
			}}
			mutate(lease)
			manager := leaseClient(t, lease)
			if _, err := manager.Acquire(context.Background(), "ct-review-system", 123, 42, "run_11111111111111111111111111111111", now.Add(15*time.Minute), now); err == nil {
				t.Fatal("unsafe existing Lease must be rejected")
			}
		})
	}
}
