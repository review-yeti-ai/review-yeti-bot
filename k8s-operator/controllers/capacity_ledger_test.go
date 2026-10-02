/*
Copyright 2026 Exampleorg.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package controllers

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	coordinationv1 "k8s.io/api/coordination/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	reviewv1alpha2 "github.com/calltelemetry/ct-review-bot/k8s-operator/api/v1alpha2"
)

func newCapacityLedgerScheme(t *testing.T) *runtime.Scheme {
	s := runtime.NewScheme()
	if err := coordinationv1.AddToScheme(s); err != nil {
		t.Fatalf("add coordinationv1: %v", err)
	}
	if err := batchv1.AddToScheme(s); err != nil {
		t.Fatalf("add batchv1: %v", err)
	}
	if err := reviewv1alpha2.AddToScheme(s); err != nil {
		t.Fatalf("add reviewv1alpha2: %v", err)
	}
	return s
}

func TestCapacityLedger_BasicAcquireAndRelease(t *testing.T) {
	scheme := newCapacityLedgerScheme(t)
	now := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)

	rev := &reviewv1alpha2.PRReviewJob{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "review-1",
			Namespace: "ct-review-system",
		},
		Status: reviewv1alpha2.PRReviewJobStatus{
			Phase: reviewv1alpha2.PhaseRunning,
		},
	}
	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(rev).Build()

	ledger := NewCapacityLedger(kube, "ct-review-system")
	ledger.Now = func() time.Time { return now }

	ctx := context.Background()

	acquired, err := ledger.AcquireSlot(ctx, rev, 2)
	if err != nil {
		t.Fatalf("AcquireSlot failed: %v", err)
	}
	if !acquired {
		t.Fatalf("expected acquired=true")
	}

	// Idempotent re-acquisition
	acquired2, err := ledger.AcquireSlot(ctx, rev, 2)
	if err != nil {
		t.Fatalf("re-acquire failed: %v", err)
	}
	if !acquired2 {
		t.Fatalf("expected re-acquire to succeed")
	}

	slots, err := ledger.GetActiveSlots(ctx)
	if err != nil {
		t.Fatalf("GetActiveSlots failed: %v", err)
	}
	if len(slots) != 1 || slots[0] != "ct-review-system/review-1" {
		t.Fatalf("expected slots [ct-review-system/review-1], got %v", slots)
	}

	// Release
	if err := ledger.ReleaseSlot(ctx, rev); err != nil {
		t.Fatalf("ReleaseSlot failed: %v", err)
	}

	slotsAfter, err := ledger.GetActiveSlots(ctx)
	if err != nil {
		t.Fatalf("GetActiveSlots failed: %v", err)
	}
	if len(slotsAfter) != 0 {
		t.Fatalf("expected 0 slots after release, got %v", slotsAfter)
	}
}

func TestCapacityLedger_CapacitySaturation(t *testing.T) {
	scheme := newCapacityLedgerScheme(t)
	now := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)

	rev1 := &reviewv1alpha2.PRReviewJob{ObjectMeta: metav1.ObjectMeta{Name: "r1", Namespace: "ct-review-system"}, Status: reviewv1alpha2.PRReviewJobStatus{Phase: reviewv1alpha2.PhaseRunning}}
	rev2 := &reviewv1alpha2.PRReviewJob{ObjectMeta: metav1.ObjectMeta{Name: "r2", Namespace: "ct-review-system"}, Status: reviewv1alpha2.PRReviewJobStatus{Phase: reviewv1alpha2.PhaseRunning}}
	rev3 := &reviewv1alpha2.PRReviewJob{ObjectMeta: metav1.ObjectMeta{Name: "r3", Namespace: "ct-review-system"}, Status: reviewv1alpha2.PRReviewJobStatus{Phase: reviewv1alpha2.PhaseQueued}}
	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(rev1, rev2, rev3).Build()

	ledger := NewCapacityLedger(kube, "ct-review-system")
	ledger.Now = func() time.Time { return now }
	ctx := context.Background()

	const limit = 2
	if ok, _ := ledger.AcquireSlot(ctx, rev1, limit); !ok {
		t.Fatalf("expected r1 acquired")
	}
	if ok, _ := ledger.AcquireSlot(ctx, rev2, limit); !ok {
		t.Fatalf("expected r2 acquired")
	}
	// Limit is 2; rev3 should be denied admission
	if ok, err := ledger.AcquireSlot(ctx, rev3, limit); err != nil || ok {
		t.Fatalf("expected r3 denied, got ok=%v, err=%v", ok, err)
	}
}

func TestCapacityLedger_SelfHealing_TTLExpiration(t *testing.T) {
	scheme := newCapacityLedgerScheme(t)
	t0 := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)

	// Pre-seed a lease with a slot acquired 700 seconds ago (duration is 600s)
	duration := int32(600)
	tOld := t0.Add(-700 * time.Second)
	tOldMicro := metav1.NewMicroTime(tOld)
	slots := []CapacitySlot{
		{
			Key:        "ct-review-system/stale-review",
			AcquiredAt: tOld,
			RenewedAt:  tOld,
		},
	}
	data, _ := json.Marshal(slots)

	lease := &coordinationv1.Lease{
		ObjectMeta: metav1.ObjectMeta{
			Name:      CapacityLedgerLeaseName,
			Namespace: "ct-review-system",
			Annotations: map[string]string{
				CapacityLedgerActiveSlotsAnnotation: string(data),
			},
		},
		Spec: coordinationv1.LeaseSpec{
			LeaseDurationSeconds: &duration,
			RenewTime:            &tOldMicro,
		},
	}

	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(lease).Build()
	ledger := NewCapacityLedger(kube, "ct-review-system")
	ledger.Now = func() time.Time { return t0 }
	ctx := context.Background()

	// Active slots should filter out the expired slot
	active, err := ledger.GetActiveSlots(ctx)
	if err != nil {
		t.Fatalf("GetActiveSlots failed: %v", err)
	}
	if len(active) != 0 {
		t.Fatalf("expected 0 active slots after TTL expiry, got %v", active)
	}

	// Saturated limit of 1: new review should successfully acquire since stale slot was expired
	newRev := &reviewv1alpha2.PRReviewJob{ObjectMeta: metav1.ObjectMeta{Name: "new-review", Namespace: "ct-review-system"}}
	acquired, err := ledger.AcquireSlot(ctx, newRev, 1)
	if err != nil {
		t.Fatalf("AcquireSlot failed: %v", err)
	}
	if !acquired {
		t.Fatalf("expected new-review to acquire slot vacated by expired slot")
	}
}

func TestCapacityLedger_SelfHealing_TerminalPRReviewJob(t *testing.T) {
	scheme := newCapacityLedgerScheme(t)
	now := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)

	// Completed review that still has a slot entry in the lease
	completedRev := &reviewv1alpha2.PRReviewJob{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "completed-review",
			Namespace: "ct-review-system",
		},
		Status: reviewv1alpha2.PRReviewJobStatus{
			Phase: reviewv1alpha2.PhaseSucceeded,
		},
	}

	duration := int32(600)
	slots := []CapacitySlot{
		{
			Key:        "ct-review-system/completed-review",
			AcquiredAt: now,
			RenewedAt:  now,
		},
	}
	data, _ := json.Marshal(slots)

	lease := &coordinationv1.Lease{
		ObjectMeta: metav1.ObjectMeta{
			Name:      CapacityLedgerLeaseName,
			Namespace: "ct-review-system",
			Annotations: map[string]string{
				CapacityLedgerActiveSlotsAnnotation: string(data),
			},
		},
		Spec: coordinationv1.LeaseSpec{
			LeaseDurationSeconds: &duration,
		},
	}

	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(completedRev, lease).Build()
	ledger := NewCapacityLedger(kube, "ct-review-system")
	ledger.Now = func() time.Time { return now }
	ctx := context.Background()

	// Liveness filter detects review is PhaseCompleted and self-heals slot
	active, err := ledger.GetActiveSlots(ctx)
	if err != nil {
		t.Fatalf("GetActiveSlots failed: %v", err)
	}
	if len(active) != 0 {
		t.Fatalf("expected 0 active slots because review is completed, got %v", active)
	}
}

func TestCapacityLedger_SelfHealing_DeletedPRReviewJob(t *testing.T) {
	scheme := newCapacityLedgerScheme(t)
	now := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)

	// Slot exists in lease but PRReviewJob does not exist in cluster (NotFound)
	duration := int32(600)
	slots := []CapacitySlot{
		{
			Key:        "ct-review-system/ghost-review",
			AcquiredAt: now,
			RenewedAt:  now,
		},
	}
	data, _ := json.Marshal(slots)

	lease := &coordinationv1.Lease{
		ObjectMeta: metav1.ObjectMeta{
			Name:      CapacityLedgerLeaseName,
			Namespace: "ct-review-system",
			Annotations: map[string]string{
				CapacityLedgerActiveSlotsAnnotation: string(data),
			},
		},
		Spec: coordinationv1.LeaseSpec{
			LeaseDurationSeconds: &duration,
		},
	}

	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(lease).Build()
	ledger := NewCapacityLedger(kube, "ct-review-system")
	ledger.Now = func() time.Time { return now }
	ctx := context.Background()

	active, err := ledger.GetActiveSlots(ctx)
	if err != nil {
		t.Fatalf("GetActiveSlots failed: %v", err)
	}
	if len(active) != 0 {
		t.Fatalf("expected 0 active slots because ghost-review was deleted, got %v", active)
	}
}

func TestCapacityLedger_LegacyStringArrayCompat(t *testing.T) {
	scheme := newCapacityLedgerScheme(t)
	now := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)

	// Active review exists in cluster
	liveRev := &reviewv1alpha2.PRReviewJob{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "legacy-review",
			Namespace: "ct-review-system",
		},
		Status: reviewv1alpha2.PRReviewJobStatus{
			Phase: reviewv1alpha2.PhaseRunning,
		},
	}

	// Legacy annotation format: ["ct-review-system/legacy-review"]
	legacyJSON := `["ct-review-system/legacy-review"]`
	lease := &coordinationv1.Lease{
		ObjectMeta: metav1.ObjectMeta{
			Name:      CapacityLedgerLeaseName,
			Namespace: "ct-review-system",
			Annotations: map[string]string{
				CapacityLedgerActiveSlotsAnnotation: legacyJSON,
			},
		},
	}

	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(liveRev, lease).Build()
	ledger := NewCapacityLedger(kube, "ct-review-system")
	ledger.Now = func() time.Time { return now }
	ctx := context.Background()

	active, err := ledger.GetActiveSlots(ctx)
	if err != nil {
		t.Fatalf("GetActiveSlots failed: %v", err)
	}
	if len(active) != 1 || active[0] != "ct-review-system/legacy-review" {
		t.Fatalf("expected [ct-review-system/legacy-review], got %v", active)
	}
}

func TestCapacityLedger_RenewSlot(t *testing.T) {
	scheme := newCapacityLedgerScheme(t)
	t0 := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)

	rev := &reviewv1alpha2.PRReviewJob{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "long-running",
			Namespace: "ct-review-system",
		},
		Status: reviewv1alpha2.PRReviewJobStatus{
			Phase: reviewv1alpha2.PhaseRunning,
		},
	}

	kube := fake.NewClientBuilder().WithScheme(scheme).WithObjects(rev).Build()
	currentTime := t0
	ledger := NewCapacityLedger(kube, "ct-review-system")
	ledger.Now = func() time.Time { return currentTime }
	ctx := context.Background()

	if ok, _ := ledger.AcquireSlot(ctx, rev, 1); !ok {
		t.Fatalf("failed to acquire initial slot")
	}

	// Advance time by 400 seconds (greater than duration/3 = 200s)
	currentTime = t0.Add(400 * time.Second)
	if err := ledger.RenewSlot(ctx, rev); err != nil {
		t.Fatalf("RenewSlot failed: %v", err)
	}

	var updatedLease coordinationv1.Lease
	if err := kube.Get(ctx, types.NamespacedName{Namespace: "ct-review-system", Name: CapacityLedgerLeaseName}, &updatedLease); err != nil {
		t.Fatalf("get updated lease: %v", err)
	}

	slots := ledger.parseActiveSlots(&updatedLease)
	if len(slots) != 1 {
		t.Fatalf("expected 1 slot, got %d", len(slots))
	}
	if !slots[0].RenewedAt.Equal(currentTime) {
		t.Fatalf("expected RenewedAt=%v, got %v", currentTime, slots[0].RenewedAt)
	}
}
