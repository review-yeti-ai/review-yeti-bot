package controllers_test

import (
	"context"
	"sync/atomic"
	"testing"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"
)

func newM4MonitorFixture(t *testing.T, limit int32) (client.WithWatch, *ConcurrencyMonitor) {
	return newConcurrencyMonitorFixture(t, limit, makeM4OCCConcurrencyInterceptor)
}

func newConcurrencyMonitorFixture(t *testing.T, limit int32, intercept func(*ConcurrencyMonitor) interceptor.Funcs) (client.WithWatch, *ConcurrencyMonitor) {
	t.Helper()
	monitor := NewConcurrencyMonitor(limit)
	kube := fake.NewClientBuilder().WithScheme(v1alpha2Scheme(t)).
		WithStatusSubresource(&batchv1.Job{}).
		WithInterceptorFuncs(intercept(monitor)).Build()
	return kube, monitor
}

func m4MonitorWorker(name string) *batchv1.Job {
	return &batchv1.Job{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "ct-review-system"}}
}

func assertM4MonitorActive(t *testing.T, kube client.Client, monitor *ConcurrencyMonitor, want int32) {
	t.Helper()
	var workers batchv1.JobList
	if err := kube.List(context.Background(), &workers); err != nil {
		t.Fatal(err)
	}
	var actual int32
	for _, worker := range workers.Items {
		terminal := false
		for _, condition := range worker.Status.Conditions {
			if condition.Status == corev1.ConditionTrue {
				switch condition.Type {
				case batchv1.JobComplete, batchv1.JobFailed:
					terminal = true
				}
			}
		}
		if !terminal && (worker.Spec.Suspend == nil || !*worker.Spec.Suspend) {
			actual++
		}
	}
	if actual != want {
		t.Fatalf("stored active Jobs = %d, want %d", actual, want)
	}
	if observed := atomic.LoadInt32(&monitor.activeJobs); observed != want {
		t.Fatalf("monitor active Jobs = %d, want stored count %d", observed, want)
	}
}

// The Job status write frees real capacity before any later controller metadata
// write. Force that ordering rather than depending on goroutine scheduling.
func TestM4MonitorStatusSubresourceRecyclesBeforeMetadataCleanup(t *testing.T) {
	for _, method := range []string{"update", "patch"} {
		t.Run(method, func(t *testing.T) {
			ctx := context.Background()
			kube, monitor := newM4MonitorFixture(t, 4)
			workers := []*batchv1.Job{m4MonitorWorker("first"), m4MonitorWorker("second"), m4MonitorWorker("third"), m4MonitorWorker("fourth")}
			for _, worker := range workers {
				if err := kube.Create(ctx, worker); err != nil {
					t.Fatal(err)
				}
			}
			assertM4MonitorActive(t, kube, monitor, 4)
			for i, worker := range workers[:3] {
				before := worker.DeepCopy()
				if i < 2 {
					worker.Status.Succeeded = 1
					worker.Status.Conditions = []batchv1.JobCondition{{Type: batchv1.JobComplete, Status: corev1.ConditionTrue}}
				} else {
					worker.Status.Failed = 1
					worker.Status.Conditions = []batchv1.JobCondition{{Type: batchv1.JobFailed, Status: corev1.ConditionTrue}}
				}
				var err error
				if method == "update" {
					err = kube.Status().Update(ctx, worker)
				} else {
					err = kube.Status().Patch(ctx, worker, client.MergeFrom(before))
				}
				if err != nil {
					t.Fatal(err)
				}
			}
			assertM4MonitorActive(t, kube, monitor, 1)
			// Admission may now run before terminal-outcome finalizers are removed.
			for _, name := range []string{"replacement-one", "replacement-two", "replacement-three"} {
				if err := kube.Create(ctx, m4MonitorWorker(name)); err != nil {
					t.Fatal(err)
				}
			}
			assertM4MonitorActive(t, kube, monitor, 4)
			for _, worker := range workers[:3] {
				if err := kube.Get(ctx, client.ObjectKeyFromObject(worker), worker); err != nil {
					t.Fatal(err)
				}
				worker.Annotations = map[string]string{"observed": "terminal"}
				if err := kube.Update(ctx, worker); err != nil {
					t.Fatal(err)
				}
				if err := kube.Status().Update(ctx, worker); err != nil {
					t.Fatal(err)
				}
				if err := kube.Delete(ctx, worker); err != nil {
					t.Fatal(err)
				}
			}
			assertM4MonitorActive(t, kube, monitor, 4)
			if monitor.MaxObservedActive() != 4 || len(monitor.Violations()) != 0 {
				t.Fatalf("legitimate recycling recorded a false breach: max=%d violations=%v", monitor.MaxObservedActive(), monitor.Violations())
			}
		})
	}
}

func TestM4MonitorFailedMutationsDoNotChangeObservedCapacity(t *testing.T) {
	ctx := context.Background()
	kube, monitor := newM4MonitorFixture(t, 1)
	worker := m4MonitorWorker("owned")
	if err := kube.Create(ctx, worker); err != nil {
		t.Fatal(err)
	}
	if err := kube.Create(ctx, m4MonitorWorker("owned")); !apierrors.IsAlreadyExists(err) {
		t.Fatalf("duplicate Create = %v, want AlreadyExists", err)
	}
	assertM4MonitorActive(t, kube, monitor, 1)
	stale := worker.DeepCopy()
	worker.Annotations = map[string]string{"revision": "new"}
	if err := kube.Update(ctx, worker); err != nil {
		t.Fatal(err)
	}
	stale.Status.Succeeded = 1
	if err := kube.Update(ctx, stale); !apierrors.IsConflict(err) {
		t.Fatalf("stale Update = %v, want Conflict", err)
	}
	assertM4MonitorActive(t, kube, monitor, 1)
	if err := kube.Delete(ctx, m4MonitorWorker("absent")); !apierrors.IsNotFound(err) {
		t.Fatalf("absent Delete = %v, want NotFound", err)
	}
	assertM4MonitorActive(t, kube, monitor, 1)
	if monitor.MaxObservedActive() != 1 || len(monitor.Violations()) != 0 {
		t.Fatal("failed operations manufactured a capacity breach")
	}
}

func TestM4MonitorMetadataCannotPretendToCompleteStatusSubresource(t *testing.T) {
	ctx := context.Background()
	kube, monitor := newM4MonitorFixture(t, 1)
	worker := m4MonitorWorker("active")
	if err := kube.Create(ctx, worker); err != nil {
		t.Fatal(err)
	}
	worker.Status.Succeeded = 1
	worker.Status.Conditions = []batchv1.JobCondition{{Type: batchv1.JobComplete, Status: corev1.ConditionTrue}}
	worker.Annotations = map[string]string{"metadata-only": "true"}
	if err := kube.Update(ctx, worker); err != nil {
		t.Fatal(err)
	}
	var stored batchv1.Job
	if err := kube.Get(ctx, client.ObjectKeyFromObject(worker), &stored); err != nil {
		t.Fatal(err)
	}
	if stored.Status.Succeeded != 0 || len(stored.Status.Conditions) != 0 {
		t.Fatalf("metadata Update persisted staged terminal status: %+v", stored.Status)
	}
	if stored.Annotations["metadata-only"] != "true" {
		t.Fatal("metadata Update did not persist the annotation")
	}
	assertM4MonitorActive(t, kube, monitor, 1)
}

// Fixed expected counts and an intentional over-admission are independent of
// the monitor's predicate. Exercise both public test adapters, not just M4.
func TestConcurrencyMonitorCommittedTransitionsBothAdapters(t *testing.T) {
	for _, adapter := range []struct {
		name  string
		funcs func(*ConcurrencyMonitor) interceptor.Funcs
	}{
		{"shared", (*ConcurrencyMonitor).InterceptorFuncs},
		{"m4-lease-cas", makeM4OCCConcurrencyInterceptor},
	} {
		t.Run(adapter.name, func(t *testing.T) {
			ctx := context.Background()
			kube, monitor := newConcurrencyMonitorFixture(t, 1, adapter.funcs)
			worker := m4MonitorWorker("reused-key")
			if err := kube.Create(ctx, worker); err != nil {
				t.Fatal(err)
			}
			assertM4MonitorActive(t, kube, monitor, 1)
			if err := kube.Create(ctx, m4MonitorWorker(worker.Name)); !apierrors.IsAlreadyExists(err) {
				t.Fatalf("duplicate Create = %v", err)
			}
			assertM4MonitorActive(t, kube, monitor, 1)
			stale := worker.DeepCopy()
			worker.Status = batchv1.JobStatus{Succeeded: 1, Failed: 1, Conditions: []batchv1.JobCondition{{Type: batchv1.JobSuccessCriteriaMet, Status: corev1.ConditionTrue}, {Type: batchv1.JobFailureTarget, Status: corev1.ConditionTrue}}}
			if err := kube.Status().Update(ctx, worker); err != nil {
				t.Fatal(err)
			}
			assertM4MonitorActive(t, kube, monitor, 1)
			worker.Status.Conditions = []batchv1.JobCondition{{Type: batchv1.JobComplete, Status: corev1.ConditionTrue}}
			worker.Annotations = map[string]string{"metadata-only": "true"}
			if err := kube.Update(ctx, worker); err != nil {
				t.Fatal(err)
			}
			assertM4MonitorActive(t, kube, monitor, 1)
			if err := kube.Update(ctx, stale); !apierrors.IsConflict(err) {
				t.Fatalf("stale Update = %v", err)
			}
			if err := kube.Status().Update(ctx, stale); !apierrors.IsConflict(err) {
				t.Fatalf("stale status Update = %v", err)
			}
			assertM4MonitorActive(t, kube, monitor, 1)
			for i := 0; i < 2; i++ {
				worker.Status = batchv1.JobStatus{Conditions: []batchv1.JobCondition{{Type: batchv1.JobComplete, Status: corev1.ConditionTrue}}}
				if err := kube.Status().Update(ctx, worker); err != nil {
					t.Fatal(err)
				}
				assertM4MonitorActive(t, kube, monitor, 0)
			}
			if err := kube.Delete(ctx, worker); err != nil {
				t.Fatal(err)
			}
			if err := kube.Delete(ctx, worker); !apierrors.IsNotFound(err) {
				t.Fatalf("repeated Delete = %v", err)
			}
			assertM4MonitorActive(t, kube, monitor, 0)
			worker = m4MonitorWorker("reused-key")
			if err := kube.Create(ctx, worker); err != nil {
				t.Fatal(err)
			}
			assertM4MonitorActive(t, kube, monitor, 1)
			for _, suspended := range []bool{true, true, false, false} {
				before := worker.DeepCopy()
				worker.Spec.Suspend = &suspended
				if err := kube.Patch(ctx, worker, client.MergeFrom(before)); err != nil {
					t.Fatal(err)
				}
				want := int32(1)
				if suspended {
					want = 0
				}
				assertM4MonitorActive(t, kube, monitor, want)
			}
			for i := 0; i < 2; i++ {
				before := worker.DeepCopy()
				worker.Status.Conditions = []batchv1.JobCondition{{Type: batchv1.JobFailed, Status: corev1.ConditionTrue}}
				if err := kube.Status().Patch(ctx, worker, client.MergeFrom(before)); err != nil {
					t.Fatal(err)
				}
				assertM4MonitorActive(t, kube, monitor, 0)
			}
			if err := kube.Status().Patch(ctx, m4MonitorWorker("missing"), client.RawPatch(types.MergePatchType, []byte(`{"status":{"succeeded":1}}`))); !apierrors.IsNotFound(err) {
				t.Fatalf("missing status Patch = %v", err)
			}
			assertM4MonitorActive(t, kube, monitor, 0)
			if monitor.MaxObservedActive() != 1 || len(monitor.Violations()) != 0 {
				t.Fatal("replays or failed mutations manufactured a capacity breach")
			}
			for _, name := range []string{"first", "second"} {
				if err := kube.Create(ctx, m4MonitorWorker(name)); err != nil {
					t.Fatal(err)
				}
			}
			assertM4MonitorActive(t, kube, monitor, 2)
			if monitor.MaxObservedActive() != 2 || len(monitor.Violations()) != 1 {
				t.Fatal("actual over-admission was not detected")
			}
		})
	}
}

func TestM4MonitorPodCountersDoNotCompleteJob(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status batchv1.JobStatus
	}{
		{"partial-completion", batchv1.JobStatus{Succeeded: 1, Conditions: []batchv1.JobCondition{{Type: batchv1.JobComplete, Status: corev1.ConditionFalse}}}},
		{"retrying-failure", batchv1.JobStatus{Failed: 1, Conditions: []batchv1.JobCondition{{Type: batchv1.JobFailed, Status: corev1.ConditionFalse}}}},
		{"success-criteria-met-not-complete", batchv1.JobStatus{Succeeded: 1, Conditions: []batchv1.JobCondition{{Type: batchv1.JobSuccessCriteriaMet, Status: corev1.ConditionTrue}}}},
		{"failure-target-not-failed", batchv1.JobStatus{Failed: 1, Conditions: []batchv1.JobCondition{{Type: batchv1.JobFailureTarget, Status: corev1.ConditionTrue}}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			kube, monitor := newM4MonitorFixture(t, 1)
			worker := m4MonitorWorker("nonterminal")
			completions := int32(3)
			worker.Spec.Completions = &completions
			if err := kube.Create(ctx, worker); err != nil {
				t.Fatal(err)
			}
			worker.Status = tc.status
			if err := kube.Status().Update(ctx, worker); err != nil {
				t.Fatal(err)
			}
			// These Pod counters/precursor conditions leave the Job nonterminal.
			// A second worker must still constitute a real capacity violation.
			if got := atomic.LoadInt32(&monitor.activeJobs); got != 1 {
				t.Fatalf("nonterminal Job disappeared from active count: %d", got)
			}
			if err := kube.Create(ctx, m4MonitorWorker("over-admitted")); err != nil {
				t.Fatal(err)
			}
			if monitor.MaxObservedActive() != 2 || len(monitor.Violations()) != 1 {
				t.Fatal("nonterminal Job masked actual over-admission")
			}
		})
	}
}

func TestM4MonitorTerminalConditionsFreeCapacityWithoutPodCounters(t *testing.T) {
	for _, terminal := range []batchv1.JobConditionType{batchv1.JobComplete, batchv1.JobFailed} {
		t.Run(string(terminal), func(t *testing.T) {
			ctx := context.Background()
			kube, monitor := newM4MonitorFixture(t, 1)
			worker := m4MonitorWorker("terminal")
			if err := kube.Create(ctx, worker); err != nil {
				t.Fatal(err)
			}
			worker.Status.Conditions = []batchv1.JobCondition{{Type: terminal, Status: corev1.ConditionTrue}}
			if err := kube.Status().Update(ctx, worker); err != nil {
				t.Fatal(err)
			}
			if got := atomic.LoadInt32(&monitor.activeJobs); got != 0 {
				t.Fatalf("terminal Job retained active capacity: %d", got)
			}
			if err := kube.Create(ctx, m4MonitorWorker("replacement")); err != nil {
				t.Fatal(err)
			}
			if monitor.MaxObservedActive() != 1 || len(monitor.Violations()) != 0 {
				t.Fatal("terminal condition manufactured a replacement capacity violation")
			}
		})
	}
}

func TestM4MonitorSuspendResumeTransitionsUpdateCapacity(t *testing.T) {
	for _, method := range []string{"update", "patch"} {
		t.Run(method, func(t *testing.T) {
			ctx := context.Background()
			kube, monitor := newM4MonitorFixture(t, 1)
			worker := m4MonitorWorker("suspended")
			suspended := true
			worker.Spec.Suspend = &suspended
			if err := kube.Create(ctx, worker); err != nil {
				t.Fatal(err)
			}
			assertM4MonitorActive(t, kube, monitor, 0)
			setSuspended := func(value bool) {
				t.Helper()
				before := worker.DeepCopy()
				worker.Spec.Suspend = &value
				var err error
				if method == "update" {
					err = kube.Update(ctx, worker)
				} else {
					err = kube.Patch(ctx, worker, client.MergeFrom(before))
				}
				if err != nil {
					t.Fatal(err)
				}
			}
			for _, value := range []bool{false, false, true, true, false} {
				setSuspended(value)
				want := int32(1)
				if value {
					want = 0
				}
				assertM4MonitorActive(t, kube, monitor, want)
			}
			worker.Status.Conditions = []batchv1.JobCondition{{Type: batchv1.JobComplete, Status: corev1.ConditionTrue}}
			if err := kube.Status().Update(ctx, worker); err != nil {
				t.Fatal(err)
			}
			setSuspended(true)
			setSuspended(false)
			assertM4MonitorActive(t, kube, monitor, 0)
			if err := kube.Create(ctx, m4MonitorWorker("replacement")); err != nil {
				t.Fatal(err)
			}
			assertM4MonitorActive(t, kube, monitor, 1)
			if monitor.MaxObservedActive() != 1 || len(monitor.Violations()) != 0 {
				t.Fatal("suspension replay or terminal resume manufactured a capacity violation")
			}
		})
	}
}

func TestM4MonitorStillDetectsActualOverAdmission(t *testing.T) {
	ctx := context.Background()
	kube, monitor := newM4MonitorFixture(t, 1)
	for _, name := range []string{"first", "second"} {
		if err := kube.Create(ctx, m4MonitorWorker(name)); err != nil {
			t.Fatal(err)
		}
	}
	assertM4MonitorActive(t, kube, monitor, 2)
	if monitor.MaxObservedActive() != 2 || len(monitor.Violations()) != 1 {
		t.Fatal("monitor failed to detect two genuinely active Jobs at capacity one")
	}
}
