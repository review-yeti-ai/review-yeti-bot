/*
Copyright 2026 CallTelemetry.

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
	"errors"
	"fmt"
	"strings"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	coordinationv1 "k8s.io/api/coordination/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/util/retry"
	"sigs.k8s.io/controller-runtime/pkg/client"

	reviewv1alpha2 "github.com/calltelemetry/ct-review-bot/k8s-operator/api/v1alpha2"
)

const (
	// DefaultCapacityLedgerNamespace is the default Kubernetes namespace hosting the singleton Lease.
	DefaultCapacityLedgerNamespace = "ct-review-system"
	// CapacityLedgerLeaseName is the singleton Lease resource coordinating cluster-wide worker capacity.
	CapacityLedgerLeaseName = "review-yeti-capacity-ledger"
	// CapacityLedgerActiveSlotsAnnotation is the Lease annotation key storing the active review names JSON array.
	CapacityLedgerActiveSlotsAnnotation = "ct.review.calltelemetry.com/active-slots"
	// DefaultCapacityLedgerDurationSeconds is the default TTL duration for active worker capacity slots.
	DefaultCapacityLedgerDurationSeconds = int32(600)
)

// CapacitySlot represents a single leased admission slot in the CapacityLedger.
type CapacitySlot struct {
	Key        string    `json:"key"`
	AcquiredAt time.Time `json:"acquired_at,omitempty"`
	RenewedAt  time.Time `json:"renewed_at,omitempty"`
}

// UnmarshalJSON supports parsing both structured CapacitySlot objects and legacy string keys.
func (s *CapacitySlot) UnmarshalJSON(data []byte) error {
	var str string
	if err := json.Unmarshal(data, &str); err == nil {
		s.Key = str
		return nil
	}
	type alias CapacitySlot
	var a alias
	if err := json.Unmarshal(data, &a); err != nil {
		return err
	}
	*s = CapacitySlot(a)
	return nil
}

// CapacityLedger coordinates declarative worker admission across threads and replicas
// using native metadata.ResourceVersion optimistic concurrency control (Compare-And-Swap)
// on a singleton coordination.k8s.io/v1 Lease in ct-review-system.
type CapacityLedger struct {
	client    client.Client
	Reader    client.Reader
	namespace string
	Now       func() time.Time
}

func (c *CapacityLedger) reader() client.Reader {
	if c.Reader != nil {
		return c.Reader
	}
	return c.client
}

// NewCapacityLedger instantiates a new CapacityLedger manager for the given client and optional namespace.
func NewCapacityLedger(c client.Client, namespace ...string) *CapacityLedger {
	ns := DefaultCapacityLedgerNamespace
	if len(namespace) > 0 && namespace[0] != "" {
		ns = namespace[0]
	}
	return &CapacityLedger{
		client:    c,
		namespace: ns,
	}
}

// Namespace returns the configured namespace for the capacity ledger Lease.
func (c *CapacityLedger) Namespace() string {
	return c.namespace
}

// Client returns the underlying Kubernetes client.
func (c *CapacityLedger) Client() client.Client {
	return c.client
}

func (c *CapacityLedger) clock() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now().UTC()
}

func slotKey(namespace, name string) string {
	if namespace == "" {
		return name
	}
	return fmt.Sprintf("%s/%s", namespace, name)
}

func parseSlotKey(key string) (string, string) {
	parts := strings.Split(key, "/")
	if len(parts) == 2 {
		return parts[0], parts[1]
	}
	return "", key
}

// AcquireSlot attempts to acquire an active admission slot for the given PRReviewJob
// using atomic Compare-And-Swap (CAS) on the singleton Lease resourceVersion.
// The CapacityLedger Lease acts as the single declarative authority for worker capacity.
//
// Returns:
//   - (true, nil): slot was successfully acquired (or was already held by this review).
//   - (false, nil): capacity limit reached (active slots >= maxSlots).
//   - (false, err): an error occurred (e.g. apierrors.IsConflict if a concurrent update raced).
func (c *CapacityLedger) AcquireSlot(ctx context.Context, review *reviewv1alpha2.PRReviewJob, maxSlots int) (bool, error) {
	if review == nil || review.Name == "" {
		return false, errors.New("cannot acquire capacity slot for nil or unnamed review")
	}
	if maxSlots <= 0 {
		return false, nil
	}

	leaseNs := c.namespace
	if leaseNs == "" {
		leaseNs = DefaultCapacityLedgerNamespace
	}

	leaseKey := types.NamespacedName{
		Namespace: leaseNs,
		Name:      CapacityLedgerLeaseName,
	}

	targetKey := slotKey(review.Namespace, review.Name)

	const maxRetries = 5
	var lastErr error

	for attempt := 0; attempt < maxRetries; attempt++ {
		lease := &coordinationv1.Lease{}
		err := c.client.Get(ctx, leaseKey, lease)
		now := c.clock()
		nowMicro := metav1.NewMicroTime(now)

		if apierrors.IsNotFound(err) {
			duration := DefaultCapacityLedgerDurationSeconds
			initialSlots := []CapacitySlot{
				{
					Key:        targetKey,
					AcquiredAt: now,
					RenewedAt:  now,
				},
			}
			data, err := json.Marshal(initialSlots)
			if err != nil {
				return false, fmt.Errorf("marshal initial slots: %w", err)
			}
			created := &coordinationv1.Lease{
				ObjectMeta: metav1.ObjectMeta{
					Name:      CapacityLedgerLeaseName,
					Namespace: leaseNs,
					Annotations: map[string]string{
						CapacityLedgerActiveSlotsAnnotation: string(data),
					},
				},
				Spec: coordinationv1.LeaseSpec{
					HolderIdentity:       stringPointer("review-yeti-capacity-manager"),
					LeaseDurationSeconds: &duration,
					RenewTime:            &nowMicro,
				},
			}
			if createErr := c.client.Create(ctx, created); createErr != nil {
				if apierrors.IsAlreadyExists(createErr) {
					continue
				}
				return false, createErr
			}
			return true, nil
		} else if err != nil {
			return false, err
		}

		// Lease exists. Prune stale slots and evaluate active capacity.
		activeSlots := c.filterLiveSlots(ctx, lease, now)

		// Idempotency: check if this review already holds a slot
		for i, s := range activeSlots {
			if s.Key == targetKey || s.Key == review.Name {
				activeSlots[i].RenewedAt = now
				data, err := json.Marshal(activeSlots)
				if err != nil {
					return false, fmt.Errorf("marshal renewed slots: %w", err)
				}
				if lease.Annotations == nil {
					lease.Annotations = make(map[string]string)
				}
				lease.Annotations[CapacityLedgerActiveSlotsAnnotation] = string(data)
				lease.Spec.RenewTime = &nowMicro

				if updateErr := c.client.Update(ctx, lease); updateErr != nil {
					if apierrors.IsConflict(updateErr) {
						lastErr = updateErr
						continue
					}
					return false, updateErr
				}
				return true, nil
			}
		}

		// Capacity check: if active slots already at or above limit, deny admission
		if len(activeSlots) >= maxSlots {
			// If stale slots were pruned, write the pruned state back to self-heal the lease
			rawSlots := c.parseActiveSlots(lease)
			if len(rawSlots) != len(activeSlots) {
				data, err := json.Marshal(activeSlots)
				if err == nil {
					if lease.Annotations == nil {
						lease.Annotations = make(map[string]string)
					}
					lease.Annotations[CapacityLedgerActiveSlotsAnnotation] = string(data)
					lease.Spec.RenewTime = &nowMicro
					_ = c.client.Update(ctx, lease)
				}
			}
			return false, nil
		}

		// Add this review to active slots
		activeSlots = append(activeSlots, CapacitySlot{
			Key:        targetKey,
			AcquiredAt: now,
			RenewedAt:  now,
		})
		data, err := json.Marshal(activeSlots)
		if err != nil {
			return false, fmt.Errorf("marshal active slots: %w", err)
		}

		if lease.Annotations == nil {
			lease.Annotations = make(map[string]string)
		}
		lease.Annotations[CapacityLedgerActiveSlotsAnnotation] = string(data)
		lease.Spec.RenewTime = &nowMicro

		if updateErr := c.client.Update(ctx, lease); updateErr != nil {
			if apierrors.IsConflict(updateErr) {
				lastErr = updateErr
				continue
			}
			return false, updateErr
		}

		return true, nil
	}

	return false, lastErr
}

// ReleaseSlot atomically removes a PRReviewJob's claim from the ledger upon completion, failure, cancellation, or deletion.
func (c *CapacityLedger) ReleaseSlot(ctx context.Context, review *reviewv1alpha2.PRReviewJob) error {
	if review == nil {
		return nil
	}
	return c.ReleaseSlotByName(ctx, review.Namespace, review.Name)
}

// ReleaseSlotByName atomically removes the named review in the given namespace from the active slots ledger.
func (c *CapacityLedger) ReleaseSlotByName(ctx context.Context, namespace, reviewName string) error {
	if reviewName == "" {
		return nil
	}

	leaseNs := c.namespace
	if leaseNs == "" {
		leaseNs = DefaultCapacityLedgerNamespace
	}

	leaseKey := types.NamespacedName{
		Namespace: leaseNs,
		Name:      CapacityLedgerLeaseName,
	}

	targetKey := slotKey(namespace, reviewName)

	return retry.RetryOnConflict(retry.DefaultBackoff, func() error {
		lease := &coordinationv1.Lease{}
		err := c.client.Get(ctx, leaseKey, lease)
		if apierrors.IsNotFound(err) {
			return nil
		}
		if err != nil {
			return err
		}

		now := c.clock()
		nowMicro := metav1.NewMicroTime(now)
		activeSlots := c.filterLiveSlots(ctx, lease, now)
		found := false
		newSlots := make([]CapacitySlot, 0, len(activeSlots))
		for _, s := range activeSlots {
			if s.Key == targetKey || s.Key == reviewName {
				found = true
			} else {
				newSlots = append(newSlots, s)
			}
		}

		rawCount := len(c.parseActiveSlots(lease))
		if !found && rawCount == len(newSlots) {
			return nil
		}

		data, err := json.Marshal(newSlots)
		if err != nil {
			return fmt.Errorf("marshal slots on release: %w", err)
		}

		if lease.Annotations == nil {
			lease.Annotations = make(map[string]string)
		}
		lease.Annotations[CapacityLedgerActiveSlotsAnnotation] = string(data)
		lease.Spec.RenewTime = &nowMicro

		return c.client.Update(ctx, lease)
	})
}

// RenewSlot renews a PRReviewJob's slot claim in the capacity ledger if held.
func (c *CapacityLedger) RenewSlot(ctx context.Context, review *reviewv1alpha2.PRReviewJob) error {
	if review == nil {
		return nil
	}
	return c.RenewSlotByName(ctx, review.Namespace, review.Name)
}

// RenewSlotByName renews the named review's slot claim in the capacity ledger.
func (c *CapacityLedger) RenewSlotByName(ctx context.Context, namespace, reviewName string) error {
	if reviewName == "" {
		return nil
	}

	leaseNs := c.namespace
	if leaseNs == "" {
		leaseNs = DefaultCapacityLedgerNamespace
	}

	leaseKey := types.NamespacedName{
		Namespace: leaseNs,
		Name:      CapacityLedgerLeaseName,
	}

	targetKey := slotKey(namespace, reviewName)

	return retry.RetryOnConflict(retry.DefaultBackoff, func() error {
		lease := &coordinationv1.Lease{}
		err := c.client.Get(ctx, leaseKey, lease)
		if apierrors.IsNotFound(err) {
			return nil
		}
		if err != nil {
			return err
		}

		now := c.clock()
		activeSlots := c.filterLiveSlots(ctx, lease, now)
		found := false
		duration := time.Duration(DefaultCapacityLedgerDurationSeconds) * time.Second
		if lease.Spec.LeaseDurationSeconds != nil && *lease.Spec.LeaseDurationSeconds > 0 {
			duration = time.Duration(*lease.Spec.LeaseDurationSeconds) * time.Second
		}

		needsUpdate := false
		for i, s := range activeSlots {
			if s.Key == targetKey || s.Key == reviewName {
				found = true
				if s.RenewedAt.IsZero() || now.Sub(s.RenewedAt) > duration/3 {
					activeSlots[i].RenewedAt = now
					needsUpdate = true
				}
				break
			}
		}

		if !found || !needsUpdate {
			return nil
		}

		data, err := json.Marshal(activeSlots)
		if err != nil {
			return fmt.Errorf("marshal slots on renew: %w", err)
		}

		if lease.Annotations == nil {
			lease.Annotations = make(map[string]string)
		}
		lease.Annotations[CapacityLedgerActiveSlotsAnnotation] = string(data)
		nowMicro := metav1.NewMicroTime(now)
		lease.Spec.RenewTime = &nowMicro

		return c.client.Update(ctx, lease)
	})
}

// CountActiveSlots returns the current number of active slots claimed in the Lease.
func (c *CapacityLedger) CountActiveSlots(ctx context.Context) (int, error) {
	slots, err := c.GetActiveSlots(ctx)
	if err != nil {
		return 0, err
	}
	return len(slots), nil
}

// GetActiveSlots returns the list of active review names currently claimed in the Lease.
func (c *CapacityLedger) GetActiveSlots(ctx context.Context) ([]string, error) {
	leaseNs := c.namespace
	if leaseNs == "" {
		leaseNs = DefaultCapacityLedgerNamespace
	}

	leaseKey := types.NamespacedName{
		Namespace: leaseNs,
		Name:      CapacityLedgerLeaseName,
	}

	lease := &coordinationv1.Lease{}
	err := c.client.Get(ctx, leaseKey, lease)
	if apierrors.IsNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	liveSlots := c.filterLiveSlots(ctx, lease, c.clock())
	keys := make([]string, 0, len(liveSlots))
	for _, s := range liveSlots {
		keys = append(keys, s.Key)
	}
	return keys, nil
}

func (c *CapacityLedger) parseActiveSlots(lease *coordinationv1.Lease) []CapacitySlot {
	if lease == nil || lease.Annotations == nil {
		return nil
	}
	raw, ok := lease.Annotations[CapacityLedgerActiveSlotsAnnotation]
	if !ok || strings.TrimSpace(raw) == "" {
		return nil
	}
	var slots []CapacitySlot
	if err := json.Unmarshal([]byte(raw), &slots); err != nil {
		return nil
	}
	return slots
}

// filterLiveSlots prunes expired or orphaned slots and synchronizes active cluster workloads.
// Slots are self-healed when:
// 1. Slot age exceeds LeaseDurationSeconds without renewal.
// 2. The referenced PRReviewJob no longer exists in the cluster (NotFound).
// 3. The referenced PRReviewJob is undergoing deletion (DeletionTimestamp != nil)
//    or has entered a terminal phase (Succeeded, Failed, Expired, Cancelled).
// Active batchv1.Job workers and active candidate reservations in the cluster are
// authoritatively projected into the ledger slots.
func (c *CapacityLedger) filterLiveSlots(ctx context.Context, lease *coordinationv1.Lease, now time.Time) []CapacitySlot {
	rawSlots := c.parseActiveSlots(lease)

	duration := time.Duration(DefaultCapacityLedgerDurationSeconds) * time.Second
	if lease != nil && lease.Spec.LeaseDurationSeconds != nil && *lease.Spec.LeaseDurationSeconds > 0 {
		duration = time.Duration(*lease.Spec.LeaseDurationSeconds) * time.Second
	}

	liveSlots := make([]CapacitySlot, 0, len(rawSlots))

	for _, slot := range rawSlots {
		if slot.Key == "" {
			continue
		}

		// 1. Time-to-Live / Expiration check
		lastActive := slot.RenewedAt
		if lastActive.IsZero() {
			lastActive = slot.AcquiredAt
		}
		if lastActive.IsZero() && lease != nil && lease.Spec.RenewTime != nil {
			lastActive = lease.Spec.RenewTime.Time
		}
		if !lastActive.IsZero() && now.Sub(lastActive) > duration {
			continue
		}

		// 2. Resource Liveness check against cluster state
		if r := c.reader(); r != nil {
			ns, name := parseSlotKey(slot.Key)
			if ns == "" && lease != nil {
				ns = lease.Namespace
			}
			var review reviewv1alpha2.PRReviewJob
			err := r.Get(ctx, types.NamespacedName{Namespace: ns, Name: name}, &review)
			if apierrors.IsNotFound(err) {
				// PRReviewJob not found. Check if an active worker Job with this name exists.
				var worker batchv1.Job
				wErr := r.Get(ctx, types.NamespacedName{Namespace: ns, Name: name}, &worker)
				if apierrors.IsNotFound(wErr) {
					continue
				}
				if worker.DeletionTimestamp != nil || worker.Status.Succeeded > 0 || worker.Status.Failed > 0 {
					continue
				}
			} else if err == nil {
				if review.DeletionTimestamp != nil || isTerminalPhase(review.Status.Phase) || isAwaitingResumption(&review) {
					continue
				}
				workerName := review.Status.JobName
				if workerName == "" {
					workerName = review.Name + "-worker"
				}
				var worker batchv1.Job
				if wErr := r.Get(ctx, types.NamespacedName{Namespace: ns, Name: workerName}, &worker); wErr == nil {
					if worker.DeletionTimestamp != nil || worker.Status.Succeeded > 0 || worker.Status.Failed > 0 {
						continue
					}
				}
			}
		}

		liveSlots = append(liveSlots, slot)
	}

	return liveSlots
}

func stringPointer(s string) *string {
	return &s
}
