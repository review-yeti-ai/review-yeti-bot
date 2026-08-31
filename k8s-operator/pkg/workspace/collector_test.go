package workspace_test

import (
	"context"
	"errors"
	"testing"
	"time"

	coordinationv1 "k8s.io/api/coordination/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/workspace"
)

const collectorNamespace = "ct-review-system"

func TestTouchPVCResetsIdleWindowOnlyForSamePR(t *testing.T) {
	ctx := context.Background()
	lastUsed := time.Date(2026, 8, 30, 20, 0, 0, 0, time.UTC)
	now := lastUsed.Add(25 * time.Minute)
	pvc := mustPVC(t, 123, 42, lastUsed)
	pvc.ResourceVersion = "7"
	kube := fakeClient(t, pvc)
	collector := workspace.NewCollector(kube)

	if err := collector.Touch(ctx, pvc.DeepCopy(), collectorNamespace, 123, 42, now); err != nil {
		t.Fatalf("touch same PR workspace: %v", err)
	}
	stored := &corev1.PersistentVolumeClaim{}
	if err := kube.Get(ctx, types.NamespacedName{Namespace: collectorNamespace, Name: pvc.Name}, stored); err != nil {
		t.Fatalf("get touched PVC: %v", err)
	}
	if got := stored.Annotations[workspace.LastUsedAtAnnotation]; got != now.Format(time.RFC3339Nano) {
		t.Fatalf("last-used-at = %q, want %q", got, now.Format(time.RFC3339Nano))
	}

	foreign := stored.DeepCopy()
	if err := collector.Touch(ctx, foreign, collectorNamespace, 123, 43, now.Add(time.Minute)); !errors.Is(err, workspace.ErrWorkspaceIdentity) {
		t.Fatalf("cross-PR touch error = %v, want ErrWorkspaceIdentity", err)
	}
	unchanged := &corev1.PersistentVolumeClaim{}
	if err := kube.Get(ctx, client.ObjectKeyFromObject(stored), unchanged); err != nil {
		t.Fatal(err)
	}
	if got := unchanged.Annotations[workspace.LastUsedAtAnnotation]; got != now.Format(time.RFC3339Nano) {
		t.Fatalf("cross-PR touch mutated last-used-at to %q", got)
	}
}

func TestTouchPVCRejectsClockRollbackAndStaleResourceVersion(t *testing.T) {
	ctx := context.Background()
	lastUsed := time.Date(2026, 8, 30, 20, 0, 0, 0, time.UTC)
	pvc := mustPVC(t, 123, 42, lastUsed)
	pvc.ResourceVersion = "7"
	kube := fakeClient(t, pvc)
	collector := workspace.NewCollector(kube)

	if err := collector.Touch(ctx, pvc.DeepCopy(), collectorNamespace, 123, 42, lastUsed.Add(-time.Nanosecond)); !errors.Is(err, workspace.ErrWorkspaceClock) {
		t.Fatalf("clock rollback error = %v, want ErrWorkspaceClock", err)
	}
	stale := pvc.DeepCopy()
	stale.ResourceVersion = "6"
	if err := collector.Touch(ctx, stale, collectorNamespace, 123, 42, lastUsed.Add(time.Minute)); !apierrors.IsConflict(err) {
		t.Fatalf("stale touch error = %v, want conflict", err)
	}
}

func TestReclaimRetainsAt1799SecondsAndDeletesAt1800(t *testing.T) {
	lastUsed := time.Date(2026, 8, 30, 20, 0, 0, 0, time.UTC)

	t.Run("closed PR trigger at 1799 seconds remains retained", func(t *testing.T) {
		pvc := mustPVC(t, 123, 42, lastUsed)
		kube := fakeClient(t, pvc)
		result, err := workspace.NewCollector(kube).Reclaim(context.Background(), pvc.DeepCopy(), collectorNamespace, 123, 42, lastUsed.Add(1799*time.Second))
		if err != nil {
			t.Fatal(err)
		}
		if result.Reclaimed || result.RequeueAfter != time.Second || result.Reason != workspace.RetainedIdleWindow {
			t.Fatalf("result = %#v, want retained for one second", result)
		}
		assertPVCExists(t, kube, pvc.Name)
	})

	t.Run("idle workspace is deleted at exactly 1800 seconds", func(t *testing.T) {
		pvc := mustPVC(t, 123, 42, lastUsed)
		pvc.ResourceVersion = "11"
		originalResourceVersion := pvc.ResourceVersion
		base := fakeClient(t, pvc)
		capturing := &deleteCaptureClient{Client: base}
		result, err := workspace.NewCollector(capturing).Reclaim(context.Background(), pvc.DeepCopy(), collectorNamespace, 123, 42, lastUsed.Add(1800*time.Second))
		if err != nil {
			t.Fatal(err)
		}
		if !result.Reclaimed || result.Reason != workspace.ReclaimedIdleWorkspace {
			t.Fatalf("result = %#v, want reclaimed", result)
		}
		if capturing.pvcResourceVersion != originalResourceVersion || capturing.pvcObjectResourceVersion != originalResourceVersion {
			t.Fatalf("PVC delete precondition = %q, object resourceVersion = %q, original observation = %q", capturing.pvcResourceVersion, capturing.pvcObjectResourceVersion, originalResourceVersion)
		}
		if capturing.leaseResourceVersion == "" || capturing.leaseResourceVersion != capturing.leaseObjectResourceVersion {
			t.Fatalf("Lease delete precondition = %q, object resourceVersion = %q", capturing.leaseResourceVersion, capturing.leaseObjectResourceVersion)
		}
		stored := &corev1.PersistentVolumeClaim{}
		err = base.Get(context.Background(), client.ObjectKeyFromObject(pvc), stored)
		if !apierrors.IsNotFound(err) {
			t.Fatalf("deleted PVC lookup error = %v, want not found", err)
		}
	})
}

func TestReclaimRejectsStalePVCObservation(t *testing.T) {
	lastUsed := time.Date(2026, 8, 30, 20, 0, 0, 0, time.UTC)
	now := lastUsed.Add(30 * time.Minute)
	pvc := mustPVC(t, 123, 42, lastUsed)
	pvc.ResourceVersion = "7"
	kube := fakeClient(t, pvc)
	stale := pvc.DeepCopy()
	fresh := &corev1.PersistentVolumeClaim{}
	if err := kube.Get(context.Background(), client.ObjectKeyFromObject(pvc), fresh); err != nil {
		t.Fatal(err)
	}
	fresh.Annotations[workspace.LastUsedAtAnnotation] = lastUsed.Add(time.Minute).Format(time.RFC3339Nano)
	if err := kube.Update(context.Background(), fresh); err != nil {
		t.Fatal(err)
	}

	if _, err := workspace.NewCollector(kube).Reclaim(context.Background(), stale, collectorNamespace, 123, 42, now); !apierrors.IsConflict(err) {
		t.Fatalf("stale reclaim error = %v, want conflict", err)
	}
	stored := assertPVCExists(t, kube, pvc.Name)
	if stored.DeletionTimestamp != nil || !contains(stored.Finalizers, workspace.ProtectionFinalizer) {
		t.Fatal("stale observation must not start PVC deletion")
	}
}

func TestReclaimIsBlockedByActiveLeaseOrNonterminalPod(t *testing.T) {
	lastUsed := time.Date(2026, 8, 30, 20, 0, 0, 0, time.UTC)
	now := lastUsed.Add(30 * time.Minute)

	tests := []struct {
		name   string
		object client.Object
		reason workspace.ReclaimReason
	}{
		{name: "active lease", object: activeLease(t, 123, 42, now), reason: workspace.RetainedActiveLease},
		{name: "pending pod", object: workspacePod(123, 42, corev1.PodPending), reason: workspace.RetainedActivePod},
		{name: "running pod", object: workspacePod(123, 42, corev1.PodRunning), reason: workspace.RetainedActivePod},
		{name: "unknown pod", object: workspacePod(123, 42, corev1.PodUnknown), reason: workspace.RetainedActivePod},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			pvc := mustPVC(t, 123, 42, lastUsed)
			kube := fakeClient(t, pvc, test.object)
			result, err := workspace.NewCollector(kube).Reclaim(context.Background(), pvc.DeepCopy(), collectorNamespace, 123, 42, now)
			if err != nil {
				t.Fatal(err)
			}
			if result.Reclaimed || result.Reason != test.reason {
				t.Fatalf("result = %#v, want retained for %s", result, test.reason)
			}
			stored := assertPVCExists(t, kube, pvc.Name)
			if !contains(stored.Finalizers, workspace.ProtectionFinalizer) {
				t.Fatal("protection finalizer removed while workspace was active")
			}
		})
	}
}

func TestReclaimAllowsExpiredLeaseAndTerminalPods(t *testing.T) {
	lastUsed := time.Date(2026, 8, 30, 20, 0, 0, 0, time.UTC)
	now := lastUsed.Add(30 * time.Minute)
	pvc := mustPVC(t, 123, 42, lastUsed)
	lease := activeLease(t, 123, 42, lastUsed)
	*lease.Spec.LeaseDurationSeconds = 60
	succeeded := workspacePod(123, 42, corev1.PodSucceeded)
	succeeded.Name = "succeeded"
	failed := workspacePod(123, 42, corev1.PodFailed)
	failed.Name = "failed"
	kube := fakeClient(t, pvc, lease, succeeded, failed)

	result, err := workspace.NewCollector(kube).Reclaim(context.Background(), pvc.DeepCopy(), collectorNamespace, 123, 42, now)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Reclaimed {
		t.Fatalf("result = %#v, want reclaimed", result)
	}
}

func TestReclaimPaginatesPodSearchUntilActive(t *testing.T) {
	lastUsed := time.Date(2026, 8, 30, 20, 0, 0, 0, time.UTC)
	pvc := mustPVC(t, 123, 42, lastUsed)
	base := fakeClient(t, pvc)
	kube := &paginatedPodClient{
		Client:   base,
		terminal: workspacePod(123, 42, corev1.PodSucceeded),
		active:   workspacePod(123, 42, corev1.PodRunning),
	}

	result, err := workspace.NewCollector(kube).Reclaim(context.Background(), pvc.DeepCopy(), collectorNamespace, 123, 42, lastUsed.Add(30*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if result.Reclaimed || result.Reason != workspace.RetainedActivePod {
		t.Fatalf("result = %#v, want active Pod from second page", result)
	}
	if kube.calls != 2 || kube.limits[0] != 100 || kube.limits[1] != 100 || kube.continues[1] != "next-page" {
		t.Fatalf("pagination calls = %d, limits = %v, continues = %v", kube.calls, kube.limits, kube.continues)
	}
}

func TestReclaimRejectsRepeatedPodContinuationToken(t *testing.T) {
	lastUsed := time.Date(2026, 8, 30, 20, 0, 0, 0, time.UTC)
	pvc := mustPVC(t, 123, 42, lastUsed)
	base := fakeClient(t, pvc)
	kube := &paginatedPodClient{
		Client:         base,
		terminal:       workspacePod(123, 42, corev1.PodSucceeded),
		active:         workspacePod(123, 42, corev1.PodSucceeded),
		repeatContinue: true,
	}

	if _, err := workspace.NewCollector(kube).Reclaim(context.Background(), pvc.DeepCopy(), collectorNamespace, 123, 42, lastUsed.Add(30*time.Minute)); !errors.Is(err, workspace.ErrWorkspaceConfiguration) {
		t.Fatalf("repeated continuation error = %v, want ErrWorkspaceConfiguration", err)
	}
	assertPVCExists(t, base, pvc.Name)
}

func TestReclaimCapsTerminalPodHistoryPages(t *testing.T) {
	lastUsed := time.Date(2026, 8, 30, 20, 0, 0, 0, time.UTC)
	pvc := mustPVC(t, 123, 42, lastUsed)
	base := fakeClient(t, pvc)
	kube := &unboundedTerminalPodPagesClient{Client: base, terminal: workspacePod(123, 42, corev1.PodSucceeded)}

	if _, err := workspace.NewCollector(kube).Reclaim(context.Background(), pvc.DeepCopy(), collectorNamespace, 123, 42, lastUsed.Add(30*time.Minute)); !errors.Is(err, workspace.ErrWorkspacePodHistoryLimit) {
		t.Fatalf("Pod history limit error = %v, want ErrWorkspacePodHistoryLimit", err)
	}
	if kube.calls != 10 {
		t.Fatalf("Pod history API calls = %d, want exactly 10", kube.calls)
	}
	stored := assertPVCExists(t, base, pvc.Name)
	if stored.DeletionTimestamp == nil || !contains(stored.Finalizers, workspace.ProtectionFinalizer) {
		t.Fatal("history ceiling must leave the terminating PVC protected")
	}
}

func TestReclaimCannotRaceALeaseAcquiredDuringFinalPodCheck(t *testing.T) {
	lastUsed := time.Date(2026, 8, 30, 20, 0, 0, 0, time.UTC)
	now := lastUsed.Add(30 * time.Minute)
	pvc := mustPVC(t, 123, 42, lastUsed)
	base := fakeClient(t, pvc)
	racing := &podListHookClient{
		Client: base,
		hook: func(ctx context.Context) error {
			return base.Create(ctx, activeLease(t, 123, 42, now))
		},
	}

	if _, err := workspace.NewCollector(racing).Reclaim(context.Background(), pvc.DeepCopy(), collectorNamespace, 123, 42, now); !apierrors.IsAlreadyExists(err) {
		t.Fatalf("lease race error = %v, want AlreadyExists", err)
	}
	stored := assertPVCExists(t, base, pvc.Name)
	if stored.DeletionTimestamp == nil || !contains(stored.Finalizers, workspace.ProtectionFinalizer) {
		t.Fatal("lease race must leave the terminating PVC protected")
	}
}

func TestReclaimRechecksPodsAfterClaimingLease(t *testing.T) {
	lastUsed := time.Date(2026, 8, 30, 20, 0, 0, 0, time.UTC)
	now := lastUsed.Add(30 * time.Minute)
	pvc := mustPVC(t, 123, 42, lastUsed)
	base := fakeClient(t, pvc)
	racing := &leaseCreateHookClient{
		Client: base,
		hook: func(ctx context.Context) error {
			return base.Create(ctx, workspacePod(123, 42, corev1.PodRunning))
		},
	}

	result, err := workspace.NewCollector(racing).Reclaim(context.Background(), pvc.DeepCopy(), collectorNamespace, 123, 42, now)
	if err != nil {
		t.Fatal(err)
	}
	if result.Reclaimed || result.Reason != workspace.RetainedActivePod {
		t.Fatalf("result = %#v, want active pod retention", result)
	}
	stored := assertPVCExists(t, base, pvc.Name)
	if stored.DeletionTimestamp == nil || !contains(stored.Finalizers, workspace.ProtectionFinalizer) {
		t.Fatal("pod race must leave a terminating PVC protected")
	}
}

func TestReclaimCatchesPodCreatedAsPVCBecomesTerminating(t *testing.T) {
	lastUsed := time.Date(2026, 8, 30, 20, 0, 0, 0, time.UTC)
	now := lastUsed.Add(30 * time.Minute)
	pvc := mustPVC(t, 123, 42, lastUsed)
	base := fakeClient(t, pvc)
	racing := &pvcDeleteHookClient{
		Client: base,
		hook: func(ctx context.Context) error {
			return base.Create(ctx, workspacePod(123, 42, corev1.PodRunning))
		},
	}

	result, err := workspace.NewCollector(racing).Reclaim(context.Background(), pvc.DeepCopy(), collectorNamespace, 123, 42, now)
	if err != nil {
		t.Fatal(err)
	}
	if result.Reclaimed || result.Reason != workspace.RetainedActivePod {
		t.Fatalf("result = %#v, want active Pod retention", result)
	}
	stored := assertPVCExists(t, base, pvc.Name)
	if stored.DeletionTimestamp == nil || !contains(stored.Finalizers, workspace.ProtectionFinalizer) {
		t.Fatal("PVC must remain terminating and protected after the final-check race")
	}
}

func TestReclaimFailsClosedBeforeRemovingFinalizer(t *testing.T) {
	lastUsed := time.Date(2026, 8, 30, 20, 0, 0, 0, time.UTC)
	now := lastUsed.Add(30 * time.Minute)

	tests := []struct {
		name   string
		mutate func(*corev1.PersistentVolumeClaim) client.Object
	}{
		{
			name: "future last-used timestamp",
			mutate: func(pvc *corev1.PersistentVolumeClaim) client.Object {
				pvc.Annotations[workspace.LastUsedAtAnnotation] = now.Add(time.Second).Format(time.RFC3339Nano)
				return nil
			},
		},
		{
			name: "malformed last-used timestamp",
			mutate: func(pvc *corev1.PersistentVolumeClaim) client.Object {
				pvc.Annotations[workspace.LastUsedAtAnnotation] = "not-a-timestamp"
				return nil
			},
		},
		{
			name: "missing last-used timestamp",
			mutate: func(pvc *corev1.PersistentVolumeClaim) client.Object {
				delete(pvc.Annotations, workspace.LastUsedAtAnnotation)
				return nil
			},
		},
		{
			name: "tampered active pod metadata",
			mutate: func(_ *corev1.PersistentVolumeClaim) client.Object {
				pod := workspacePod(123, 42, corev1.PodRunning)
				pod.Annotations[workspace.WorkspaceKeyAnnotation] = workspace.Key(123, 43)
				return pod
			},
		},
		{
			name: "tampered active pod label",
			mutate: func(_ *corev1.PersistentVolumeClaim) client.Object {
				pod := workspacePod(123, 42, corev1.PodRunning)
				pod.Labels[workspace.RepositoryIDLabel] = "999"
				return pod
			},
		},
		{
			name: "malformed lease",
			mutate: func(_ *corev1.PersistentVolumeClaim) client.Object {
				lease := activeLease(t, 123, 42, now)
				lease.Spec.RenewTime = nil
				lease.Spec.AcquireTime = nil
				return lease
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			pvc := mustPVC(t, 123, 42, lastUsed)
			extra := test.mutate(pvc)
			objects := []client.Object{pvc}
			if extra != nil {
				objects = append(objects, extra)
			}
			kube := fakeClient(t, objects...)
			if _, err := workspace.NewCollector(kube).Reclaim(context.Background(), pvc.DeepCopy(), collectorNamespace, 123, 42, now); err == nil {
				t.Fatal("unsafe state must fail closed")
			}
			stored := assertPVCExists(t, kube, pvc.Name)
			if !contains(stored.Finalizers, workspace.ProtectionFinalizer) {
				t.Fatal("protection finalizer removed before safety checks passed")
			}
		})
	}
}

func TestCollectorRejectsInvalidInvocation(t *testing.T) {
	now := time.Date(2026, 8, 30, 20, 0, 0, 0, time.UTC)
	pvc := mustPVC(t, 123, 42, now)
	var nilCollector *workspace.Collector

	touchTests := []struct {
		name      string
		collector *workspace.Collector
		pvc       *corev1.PersistentVolumeClaim
		now       time.Time
	}{
		{name: "nil collector", collector: nilCollector, pvc: pvc, now: now},
		{name: "nil client", collector: workspace.NewCollector(nil), pvc: pvc, now: now},
		{name: "zero time", collector: workspace.NewCollector(fakeClient(t, pvc)), pvc: pvc, now: time.Time{}},
		{name: "nil PVC", collector: workspace.NewCollector(fakeClient(t, pvc)), pvc: nil, now: now},
	}
	for _, test := range touchTests {
		t.Run("touch "+test.name, func(t *testing.T) {
			if err := test.collector.Touch(context.Background(), test.pvc, collectorNamespace, 123, 42, test.now); err == nil {
				t.Fatal("invalid touch must fail")
			}
		})
	}

	reclaimTests := []struct {
		name      string
		collector *workspace.Collector
		pvc       *corev1.PersistentVolumeClaim
		namespace string
		now       time.Time
	}{
		{name: "nil collector", collector: nilCollector, pvc: pvc, namespace: collectorNamespace, now: now},
		{name: "nil client", collector: workspace.NewCollector(nil), pvc: pvc, namespace: collectorNamespace, now: now},
		{name: "zero time", collector: workspace.NewCollector(fakeClient(t, pvc)), pvc: pvc, namespace: collectorNamespace},
		{name: "invalid namespace", collector: workspace.NewCollector(fakeClient(t, pvc)), pvc: pvc, namespace: "INVALID_NAMESPACE", now: now},
		{name: "nil PVC", collector: workspace.NewCollector(fakeClient(t, pvc)), pvc: nil, namespace: collectorNamespace, now: now},
	}
	for _, test := range reclaimTests {
		t.Run("reclaim "+test.name, func(t *testing.T) {
			if _, err := test.collector.Reclaim(context.Background(), test.pvc, test.namespace, 123, 42, test.now); err == nil {
				t.Fatal("invalid reclaim must fail")
			}
		})
	}
}

func TestReclaimPreservesForeignFinalizers(t *testing.T) {
	lastUsed := time.Date(2026, 8, 30, 20, 0, 0, 0, time.UTC)
	pvc := mustPVC(t, 123, 42, lastUsed)
	pvc.Finalizers = append(pvc.Finalizers, "kubernetes.io/pvc-protection")
	kube := fakeClient(t, pvc)

	result, err := workspace.NewCollector(kube).Reclaim(context.Background(), pvc.DeepCopy(), collectorNamespace, 123, 42, lastUsed.Add(30*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if !result.Reclaimed {
		t.Fatalf("result = %#v, want accepted reclamation", result)
	}
	terminating := assertPVCExists(t, kube, pvc.Name)
	if terminating.DeletionTimestamp == nil || contains(terminating.Finalizers, workspace.ProtectionFinalizer) || !contains(terminating.Finalizers, "kubernetes.io/pvc-protection") {
		t.Fatalf("foreign finalizer handling = timestamp %v, finalizers %v", terminating.DeletionTimestamp, terminating.Finalizers)
	}
}

func TestReclaimPropagatesKubernetesFailures(t *testing.T) {
	lastUsed := time.Date(2026, 8, 30, 20, 0, 0, 0, time.UTC)
	now := lastUsed.Add(30 * time.Minute)
	injected := errors.New("injected kubernetes failure")

	tests := []struct {
		name          string
		existingLease func(*testing.T) *coordinationv1.Lease
		configure     func(*operationErrorClient)
		wantReclaimed bool
	}{
		{name: "pod list", configure: func(c *operationErrorClient) { c.listPodsErr = injected }},
		{name: "lease get", configure: func(c *operationErrorClient) { c.getLeaseErr = injected }},
		{name: "lease create", configure: func(c *operationErrorClient) { c.createLeaseErr = injected }},
		{
			name: "lease update",
			existingLease: func(t *testing.T) *coordinationv1.Lease {
				lease := activeLease(t, 123, 42, lastUsed)
				*lease.Spec.LeaseDurationSeconds = 60
				return lease
			},
			configure: func(c *operationErrorClient) { c.updateLeaseErr = injected },
		},
		{name: "PVC update", configure: func(c *operationErrorClient) { c.updatePVCErr = injected }},
		{name: "PVC update loses resourceVersion", configure: func(c *operationErrorClient) { c.clearPVCUpdateResourceVersion = true }},
		{name: "PVC delete", configure: func(c *operationErrorClient) { c.deletePVCErr = injected }},
		{name: "PVC terminating reread", configure: func(c *operationErrorClient) { c.getPVCErr = injected }},
		{name: "PVC delete not visible", configure: func(c *operationErrorClient) { c.clearPVCTerminationOnGet = true }},
		{name: "lease renewal loses resourceVersion", configure: func(c *operationErrorClient) { c.clearLeaseUpdateResourceVersion = true }, wantReclaimed: true},
		{name: "lease cleanup", configure: func(c *operationErrorClient) { c.deleteLeaseErr = injected }, wantReclaimed: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			pvc := mustPVC(t, 123, 42, lastUsed)
			objects := []client.Object{pvc}
			if test.existingLease != nil {
				objects = append(objects, test.existingLease(t))
			}
			base := fakeClient(t, objects...)
			failing := &operationErrorClient{Client: base}
			test.configure(failing)
			result, err := workspace.NewCollector(failing).Reclaim(context.Background(), pvc.DeepCopy(), collectorNamespace, 123, 42, now)
			if err == nil {
				t.Fatal("injected failure must be returned")
			}
			if result.Reclaimed != test.wantReclaimed {
				t.Fatalf("reclaimed = %v, want %v", result.Reclaimed, test.wantReclaimed)
			}
		})
	}
}

func TestReclaimRejectsMissingObservedPVCResourceVersion(t *testing.T) {
	lastUsed := time.Date(2026, 8, 30, 20, 0, 0, 0, time.UTC)
	pvc := mustPVC(t, 123, 42, lastUsed)
	kube := fakeClient(t, pvc)
	staleObservation := pvc.DeepCopy()
	staleObservation.ResourceVersion = ""

	if _, err := workspace.NewCollector(kube).Reclaim(context.Background(), staleObservation, collectorNamespace, 123, 42, lastUsed.Add(30*time.Minute)); !errors.Is(err, workspace.ErrWorkspaceConfiguration) {
		t.Fatalf("missing resourceVersion error = %v, want ErrWorkspaceConfiguration", err)
	}
	assertPVCExists(t, kube, pvc.Name)
}

func TestReclaimTreatsMissingLeaseDuringCleanupAsComplete(t *testing.T) {
	lastUsed := time.Date(2026, 8, 30, 20, 0, 0, 0, time.UTC)
	pvc := mustPVC(t, 123, 42, lastUsed)
	base := fakeClient(t, pvc)
	kube := &operationErrorClient{Client: base, deleteLeaseErr: apierrors.NewNotFound(coordinationv1.Resource("leases"), "gone")}

	result, err := workspace.NewCollector(kube).Reclaim(context.Background(), pvc.DeepCopy(), collectorNamespace, 123, 42, lastUsed.Add(30*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if !result.Reclaimed {
		t.Fatalf("result = %#v, want reclaimed", result)
	}
}

func TestReclaimFailsClosedWhenPostClaimPodCheckFails(t *testing.T) {
	lastUsed := time.Date(2026, 8, 30, 20, 0, 0, 0, time.UTC)
	pvc := mustPVC(t, 123, 42, lastUsed)
	base := fakeClient(t, pvc)
	kube := &postClaimPodListErrorClient{Client: base, err: errors.New("post-claim pod list failed")}

	if _, err := workspace.NewCollector(kube).Reclaim(context.Background(), pvc.DeepCopy(), collectorNamespace, 123, 42, lastUsed.Add(30*time.Minute)); err == nil {
		t.Fatal("post-claim Pod list failure must fail closed")
	}
	stored := assertPVCExists(t, base, pvc.Name)
	if !contains(stored.Finalizers, workspace.ProtectionFinalizer) {
		t.Fatal("post-claim Pod list failure removed workspace protection")
	}
}

func TestReclaimRejectsPodReturnedOutsideRequestedNamespace(t *testing.T) {
	lastUsed := time.Date(2026, 8, 30, 20, 0, 0, 0, time.UTC)
	pvc := mustPVC(t, 123, 42, lastUsed)
	base := fakeClient(t, pvc)
	kube := &wrongNamespacePodClient{Client: base, pod: workspacePod(123, 42, corev1.PodRunning)}
	kube.pod.Namespace = "other-namespace"

	if _, err := workspace.NewCollector(kube).Reclaim(context.Background(), pvc.DeepCopy(), collectorNamespace, 123, 42, lastUsed.Add(30*time.Minute)); !errors.Is(err, workspace.ErrWorkspaceIdentity) {
		t.Fatalf("wrong-namespace Pod error = %v, want ErrWorkspaceIdentity", err)
	}
}

func TestReclaimRejectsTerminatingOrMismatchedLease(t *testing.T) {
	lastUsed := time.Date(2026, 8, 30, 20, 0, 0, 0, time.UTC)
	now := lastUsed.Add(30 * time.Minute)
	tests := map[string]func(*coordinationv1.Lease){
		"terminating": func(lease *coordinationv1.Lease) {
			deleted := metav1.NewTime(now)
			lease.DeletionTimestamp = &deleted
			lease.Finalizers = []string{"test-protection"}
		},
		"mismatched identity": func(lease *coordinationv1.Lease) {
			lease.Labels[workspace.RepositoryIDLabel] = "999"
		},
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			pvc := mustPVC(t, 123, 42, lastUsed)
			lease := activeLease(t, 123, 42, lastUsed)
			*lease.Spec.LeaseDurationSeconds = 60
			mutate(lease)
			kube := fakeClient(t, pvc, lease)
			if _, err := workspace.NewCollector(kube).Reclaim(context.Background(), pvc.DeepCopy(), collectorNamespace, 123, 42, now); err == nil {
				t.Fatal("unsafe lease must fail closed")
			}
			stored := assertPVCExists(t, kube, pvc.Name)
			if !contains(stored.Finalizers, workspace.ProtectionFinalizer) {
				t.Fatal("unsafe lease removed workspace protection")
			}
		})
	}
}

func TestConcurrentReclaimersAndWorkersCannotShareReclamationLease(t *testing.T) {
	lastUsed := time.Date(2026, 8, 30, 20, 0, 0, 0, time.UTC)
	now := lastUsed.Add(30 * time.Minute)
	pvc := mustPVC(t, 123, 42, lastUsed)
	base := fakeClient(t, pvc)
	racing := &leaseCreateHookClient{
		Client: base,
		hook: func(ctx context.Context) error {
			return base.Create(ctx, workspacePod(123, 42, corev1.PodRunning))
		},
	}
	if _, err := workspace.NewCollector(racing).Reclaim(context.Background(), pvc.DeepCopy(), collectorNamespace, 123, 42, now); err != nil {
		t.Fatal(err)
	}
	if err := base.Delete(context.Background(), workspacePod(123, 42, corev1.PodRunning)); err != nil {
		t.Fatal(err)
	}
	second, err := workspace.NewCollector(base).Reclaim(context.Background(), pvc.DeepCopy(), collectorNamespace, 123, 42, now.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if second.Reclaimed || second.Reason != workspace.RetainedActiveLease {
		t.Fatalf("second reclaimer result = %#v, want active Lease retention", second)
	}
	_, err = workspace.NewLeaseManager(base).Acquire(
		context.Background(), collectorNamespace, 123, 42,
		"run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", now.Add(15*time.Minute), now.Add(time.Second),
	)
	if !errors.Is(err, workspace.ErrLeaseHeld) {
		t.Fatalf("worker acquisition error = %v, want ErrLeaseHeld", err)
	}
	assertPVCExists(t, base, pvc.Name)

	// An expired ordinary worker Lease is still taken over with an incremented
	// transition count after terminal Pod evidence has been established.

	pvc2 := mustPVC(t, 123, 43, lastUsed)
	lease2 := activeLease(t, 123, 43, lastUsed)
	transitions := int32(4)
	lease2.Spec.LeaseTransitions = &transitions
	*lease2.Spec.LeaseDurationSeconds = 60
	kube2 := fakeClient(t, pvc2, lease2)
	if _, err := workspace.NewCollector(kube2).Reclaim(context.Background(), pvc2.DeepCopy(), collectorNamespace, 123, 43, now); err != nil {
		t.Fatal(err)
	}
}

func TestReclaimRevalidatesLeaseAfterFinalPodCheck(t *testing.T) {
	lastUsed := time.Date(2026, 8, 30, 20, 0, 0, 0, time.UTC)
	now := lastUsed.Add(30 * time.Minute)
	pvc := mustPVC(t, 123, 42, lastUsed)
	base := fakeClient(t, pvc)
	kube := &leaseTakeoverAfterFinalPodCheckClient{Client: base, now: now}

	if _, err := workspace.NewCollector(kube).Reclaim(context.Background(), pvc.DeepCopy(), collectorNamespace, 123, 42, now); !errors.Is(err, workspace.ErrLeaseHeld) {
		t.Fatalf("lease takeover error = %v, want ErrLeaseHeld", err)
	}
	stored := assertPVCExists(t, base, pvc.Name)
	if stored.DeletionTimestamp == nil || !contains(stored.Finalizers, workspace.ProtectionFinalizer) {
		t.Fatal("lease takeover must leave the terminating PVC protected")
	}
}

func TestFinalizerRemovalHasDeadlineShorterThanReclamationLease(t *testing.T) {
	lastUsed := time.Date(2026, 8, 30, 20, 0, 0, 0, time.UTC)
	now := lastUsed.Add(30 * time.Minute)
	pvc := mustPVC(t, 123, 42, lastUsed)
	base := fakeClient(t, pvc)
	injected := errors.New("stop after inspecting finalizer deadline")
	kube := &finalizerDeadlineClient{Client: base, err: injected}

	if _, err := workspace.NewCollector(kube).Reclaim(context.Background(), pvc.DeepCopy(), collectorNamespace, 123, 42, now); !errors.Is(err, injected) {
		t.Fatalf("finalizer update error = %v, want injected error", err)
	}
	if !kube.hasDeadline || kube.remaining <= 0 || kube.remaining > 30*time.Second {
		t.Fatalf("finalizer deadline present = %v, remaining = %s", kube.hasDeadline, kube.remaining)
	}
	stored := assertPVCExists(t, base, pvc.Name)
	if !contains(stored.Finalizers, workspace.ProtectionFinalizer) {
		t.Fatal("bounded finalizer update failure removed workspace protection")
	}
}

func TestReclaimAbortsIfLeaseExpiresBeforeFinalizerRemoval(t *testing.T) {
	lastUsed := time.Date(2026, 8, 30, 20, 0, 0, 0, time.UTC)
	now := lastUsed.Add(30 * time.Minute)
	pvc := mustPVC(t, 123, 42, lastUsed)
	base := fakeClient(t, pvc)
	kube := &leaseExpiryAfterFinalPodCheckClient{Client: base, expiredAt: now.Add(-time.Second)}

	if _, err := workspace.NewCollector(kube).Reclaim(context.Background(), pvc.DeepCopy(), collectorNamespace, 123, 42, now); !errors.Is(err, workspace.ErrLeaseHeld) {
		t.Fatalf("expired reclamation Lease error = %v, want ErrLeaseHeld", err)
	}
	stored := assertPVCExists(t, base, pvc.Name)
	if stored.DeletionTimestamp == nil || !contains(stored.Finalizers, workspace.ProtectionFinalizer) {
		t.Fatal("expired reclamation Lease must leave the terminating PVC protected")
	}
}

type deleteCaptureClient struct {
	client.Client
	pvcResourceVersion         string
	pvcObjectResourceVersion   string
	leaseResourceVersion       string
	leaseObjectResourceVersion string
}

type podListHookClient struct {
	client.Client
	hook func(context.Context) error
	once bool
}

func (c *podListHookClient) List(ctx context.Context, list client.ObjectList, options ...client.ListOption) error {
	if _, ok := list.(*corev1.PodList); ok && !c.once {
		c.once = true
		if err := c.hook(ctx); err != nil {
			return err
		}
	}
	return c.Client.List(ctx, list, options...)
}

type leaseCreateHookClient struct {
	client.Client
	hook func(context.Context) error
}

func (c *leaseCreateHookClient) Create(ctx context.Context, object client.Object, options ...client.CreateOption) error {
	if err := c.Client.Create(ctx, object, options...); err != nil {
		return err
	}
	if _, ok := object.(*coordinationv1.Lease); ok {
		return c.hook(ctx)
	}
	return nil
}

type pvcDeleteHookClient struct {
	client.Client
	hook func(context.Context) error
	once bool
}

func (c *pvcDeleteHookClient) Delete(ctx context.Context, object client.Object, options ...client.DeleteOption) error {
	if err := c.Client.Delete(ctx, object, options...); err != nil {
		return err
	}
	if _, ok := object.(*corev1.PersistentVolumeClaim); ok && !c.once {
		c.once = true
		return c.hook(ctx)
	}
	return nil
}

type operationErrorClient struct {
	client.Client
	getLeaseErr                     error
	getPVCErr                       error
	listPodsErr                     error
	createLeaseErr                  error
	updateLeaseErr                  error
	updatePVCErr                    error
	deletePVCErr                    error
	deleteLeaseErr                  error
	clearPVCUpdateResourceVersion   bool
	clearLeaseUpdateResourceVersion bool
	clearPVCTerminationOnGet        bool
}

type leaseTakeoverAfterFinalPodCheckClient struct {
	client.Client
	now      time.Time
	podLists int
}

func (c *leaseTakeoverAfterFinalPodCheckClient) List(ctx context.Context, list client.ObjectList, options ...client.ListOption) error {
	if err := c.Client.List(ctx, list, options...); err != nil {
		return err
	}
	if _, ok := list.(*corev1.PodList); ok {
		c.podLists++
		if c.podLists == 1 {
			lease := &coordinationv1.Lease{}
			key := types.NamespacedName{Namespace: collectorNamespace, Name: workspace.LeaseName(123, 42)}
			if err := c.Client.Get(ctx, key, lease); err != nil {
				return err
			}
			holder := "run_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
			duration := int32(900)
			renewed := metav1.NewMicroTime(c.now)
			lease.Spec.HolderIdentity = &holder
			lease.Spec.LeaseDurationSeconds = &duration
			lease.Spec.RenewTime = &renewed
			return c.Client.Update(ctx, lease)
		}
	}
	return nil
}

type finalizerDeadlineClient struct {
	client.Client
	err         error
	hasDeadline bool
	remaining   time.Duration
}

func (c *finalizerDeadlineClient) Update(ctx context.Context, object client.Object, options ...client.UpdateOption) error {
	if pvc, ok := object.(*corev1.PersistentVolumeClaim); ok && pvc.DeletionTimestamp != nil && !contains(pvc.Finalizers, workspace.ProtectionFinalizer) {
		deadline, hasDeadline := ctx.Deadline()
		c.hasDeadline = hasDeadline
		if hasDeadline {
			c.remaining = time.Until(deadline)
		}
		return c.err
	}
	return c.Client.Update(ctx, object, options...)
}

type leaseExpiryAfterFinalPodCheckClient struct {
	client.Client
	expiredAt time.Time
	podLists  int
}

func (c *leaseExpiryAfterFinalPodCheckClient) List(ctx context.Context, list client.ObjectList, options ...client.ListOption) error {
	if err := c.Client.List(ctx, list, options...); err != nil {
		return err
	}
	if _, ok := list.(*corev1.PodList); ok {
		c.podLists++
		if c.podLists == 1 {
			lease := &coordinationv1.Lease{}
			key := types.NamespacedName{Namespace: collectorNamespace, Name: workspace.LeaseName(123, 42)}
			if err := c.Client.Get(ctx, key, lease); err != nil {
				return err
			}
			duration := int32(120)
			renewedAt := metav1.NewMicroTime(c.expiredAt.Add(-time.Duration(duration) * time.Second))
			lease.Spec.LeaseDurationSeconds = &duration
			lease.Spec.RenewTime = &renewedAt
			return c.Client.Update(ctx, lease)
		}
	}
	return nil
}

type postClaimPodListErrorClient struct {
	client.Client
	err error
}

func (c *postClaimPodListErrorClient) List(ctx context.Context, list client.ObjectList, options ...client.ListOption) error {
	if _, ok := list.(*corev1.PodList); ok {
		return c.err
	}
	return c.Client.List(ctx, list, options...)
}

type wrongNamespacePodClient struct {
	client.Client
	pod *corev1.Pod
}

func (c *wrongNamespacePodClient) List(_ context.Context, list client.ObjectList, _ ...client.ListOption) error {
	if pods, ok := list.(*corev1.PodList); ok {
		pods.Items = []corev1.Pod{*c.pod.DeepCopy()}
		return nil
	}
	return errors.New("unexpected list type")
}

type paginatedPodClient struct {
	client.Client
	terminal       *corev1.Pod
	active         *corev1.Pod
	calls          int
	limits         []int64
	continues      []string
	repeatContinue bool
}

type unboundedTerminalPodPagesClient struct {
	client.Client
	terminal *corev1.Pod
	calls    int
}

func (c *unboundedTerminalPodPagesClient) List(_ context.Context, list client.ObjectList, _ ...client.ListOption) error {
	pods, ok := list.(*corev1.PodList)
	if !ok {
		return errors.New("unexpected list type")
	}
	c.calls++
	pods.Items = []corev1.Pod{*c.terminal.DeepCopy()}
	pods.Continue = string(rune('a' + c.calls))
	return nil
}

func (c *paginatedPodClient) List(_ context.Context, list client.ObjectList, options ...client.ListOption) error {
	pods, ok := list.(*corev1.PodList)
	if !ok {
		return errors.New("unexpected list type")
	}
	listOptions := (&client.ListOptions{}).ApplyOptions(options)
	c.calls++
	c.limits = append(c.limits, listOptions.Limit)
	c.continues = append(c.continues, listOptions.Continue)
	if listOptions.Continue == "" {
		pods.Items = []corev1.Pod{*c.terminal.DeepCopy()}
		pods.Continue = "next-page"
		return nil
	}
	if listOptions.Continue == "next-page" {
		pods.Items = []corev1.Pod{*c.active.DeepCopy()}
		if c.repeatContinue {
			pods.Continue = "next-page"
		} else {
			pods.Continue = ""
		}
		return nil
	}
	return errors.New("unexpected continuation token")
}

func (c *operationErrorClient) Get(ctx context.Context, key client.ObjectKey, object client.Object, options ...client.GetOption) error {
	if _, ok := object.(*coordinationv1.Lease); ok && c.getLeaseErr != nil {
		return c.getLeaseErr
	}
	if _, ok := object.(*corev1.PersistentVolumeClaim); ok && c.getPVCErr != nil {
		return c.getPVCErr
	}
	if err := c.Client.Get(ctx, key, object, options...); err != nil {
		return err
	}
	if _, ok := object.(*corev1.PersistentVolumeClaim); ok && c.clearPVCTerminationOnGet {
		object.SetDeletionTimestamp(nil)
	}
	return nil
}

func (c *operationErrorClient) List(ctx context.Context, list client.ObjectList, options ...client.ListOption) error {
	if _, ok := list.(*corev1.PodList); ok && c.listPodsErr != nil {
		return c.listPodsErr
	}
	return c.Client.List(ctx, list, options...)
}

func (c *operationErrorClient) Create(ctx context.Context, object client.Object, options ...client.CreateOption) error {
	if _, ok := object.(*coordinationv1.Lease); ok {
		if c.createLeaseErr != nil {
			return c.createLeaseErr
		}
		if err := c.Client.Create(ctx, object, options...); err != nil {
			return err
		}
		return nil
	}
	return c.Client.Create(ctx, object, options...)
}

func (c *operationErrorClient) Update(ctx context.Context, object client.Object, options ...client.UpdateOption) error {
	switch object.(type) {
	case *coordinationv1.Lease:
		if c.updateLeaseErr != nil {
			return c.updateLeaseErr
		}
		if err := c.Client.Update(ctx, object, options...); err != nil {
			return err
		}
		if c.clearLeaseUpdateResourceVersion {
			object.SetResourceVersion("")
		}
		return nil
	case *corev1.PersistentVolumeClaim:
		if c.updatePVCErr != nil {
			return c.updatePVCErr
		}
		if c.clearPVCUpdateResourceVersion {
			object.SetResourceVersion("")
			return nil
		}
	}
	return c.Client.Update(ctx, object, options...)
}

func (c *operationErrorClient) Delete(ctx context.Context, object client.Object, options ...client.DeleteOption) error {
	switch object.(type) {
	case *coordinationv1.Lease:
		if c.deleteLeaseErr != nil {
			return c.deleteLeaseErr
		}
	case *corev1.PersistentVolumeClaim:
		if c.deletePVCErr != nil {
			return c.deletePVCErr
		}
	}
	return c.Client.Delete(ctx, object, options...)
}

func (c *deleteCaptureClient) Delete(ctx context.Context, object client.Object, options ...client.DeleteOption) error {
	deleteOptions := (&client.DeleteOptions{}).ApplyOptions(options)
	if deleteOptions.Preconditions != nil && deleteOptions.Preconditions.ResourceVersion != nil {
		switch object.(type) {
		case *corev1.PersistentVolumeClaim:
			c.pvcResourceVersion = *deleteOptions.Preconditions.ResourceVersion
			c.pvcObjectResourceVersion = object.GetResourceVersion()
		case *coordinationv1.Lease:
			c.leaseResourceVersion = *deleteOptions.Preconditions.ResourceVersion
			c.leaseObjectResourceVersion = object.GetResourceVersion()
		}
	}
	return c.Client.Delete(ctx, object, options...)
}

func fakeClient(t *testing.T, objects ...client.Object) client.Client {
	t.Helper()
	scheme := runtime.NewScheme()
	if err := corev1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	if err := coordinationv1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	return fake.NewClientBuilder().WithScheme(scheme).WithObjects(objects...).Build()
}

func mustPVC(t *testing.T, repositoryID int64, prNumber int32, lastUsed time.Time) *corev1.PersistentVolumeClaim {
	t.Helper()
	pvc, err := workspace.BuildPVC(collectorNamespace, repositoryID, prNumber, lastUsed)
	if err != nil {
		t.Fatal(err)
	}
	return pvc
}

func activeLease(t *testing.T, repositoryID int64, prNumber int32, now time.Time) *coordinationv1.Lease {
	t.Helper()
	labels, annotations := workspace.Metadata(repositoryID, prNumber)
	holder := "run_0123456789abcdef0123456789abcdef"
	duration := int32(120)
	renewed := metav1.NewMicroTime(now)
	return &coordinationv1.Lease{
		ObjectMeta: metav1.ObjectMeta{
			Name: workspace.LeaseName(repositoryID, prNumber), Namespace: collectorNamespace,
			Labels: labels, Annotations: annotations,
		},
		Spec: coordinationv1.LeaseSpec{HolderIdentity: &holder, LeaseDurationSeconds: &duration, RenewTime: &renewed},
	}
}

func workspacePod(repositoryID int64, prNumber int32, phase corev1.PodPhase) *corev1.Pod {
	labels, annotations := workspace.Metadata(repositoryID, prNumber)
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "review-pod", Namespace: collectorNamespace, Labels: labels, Annotations: annotations},
		Status:     corev1.PodStatus{Phase: phase},
	}
}

func assertPVCExists(t *testing.T, kube client.Client, name string) *corev1.PersistentVolumeClaim {
	t.Helper()
	pvc := &corev1.PersistentVolumeClaim{}
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: collectorNamespace, Name: name}, pvc); err != nil {
		t.Fatalf("PVC %s must exist: %v", name, err)
	}
	return pvc
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
