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
)

// CapacityLedger coordinates declarative worker admission across threads and replicas
// using native metadata.ResourceVersion optimistic concurrency control (Compare-And-Swap)
// on a singleton coordination.k8s.io/v1 Lease in ct-review-system.
type CapacityLedger struct {
	client    client.Client
	namespace string
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

// AcquireSlot attempts to acquire an active admission slot for the given PRReviewJob
// using atomic Compare-And-Swap (CAS) on the singleton Lease resourceVersion.
//
// Returns:
//   - (true, nil): slot was successfully acquired (or was already held by this review).
//   - (false, nil): capacity limit reached (active slots >= maxSlots).
//   - (false, err): an error occurred (e.g. apierrors.IsConflict if a concurrent update raced).
func slotKey(namespace, name string) string {
	if namespace == "" {
		return name
	}
	return fmt.Sprintf("%s/%s", namespace, name)
}

func (c *CapacityLedger) AcquireSlot(ctx context.Context, review *reviewv1alpha2.PRReviewJob, maxSlots int, currentActive ...int) (bool, error) {
	if review == nil || review.Name == "" {
		return false, errors.New("cannot acquire capacity slot for nil or unnamed review")
	}
	if maxSlots <= 0 {
		return false, nil
	}
	for _, active := range currentActive {
		if active >= maxSlots {
			return false, nil
		}
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

	// Retry on conflict up to 5 times. If another thread won the slot and capacity
	// is now reached, the subsequent attempt immediately observes len(activeSlots) >= maxSlots
	// and returns (false, nil). If conflict persists across all retries, the conflict error
	// is returned to trigger a quiet requeue via conflictRequeue.
	const maxRetries = 5
	var lastErr error

	for attempt := 0; attempt < maxRetries; attempt++ {
		lease := &coordinationv1.Lease{}
		err := c.client.Get(ctx, leaseKey, lease)
		if apierrors.IsNotFound(err) {
			// Initialize the singleton Lease with this review claimed
			initialSlots := []string{targetKey}
			data, err := json.Marshal(initialSlots)
			if err != nil {
				return false, fmt.Errorf("marshal initial slots: %w", err)
			}
			nowMicro := metav1.NewMicroTime(time.Now().UTC())
			duration := int32(600)
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
					// Another worker created it concurrently; retry Get and continue loop
					continue
				}
				return false, createErr
			}
			return true, nil
		} else if err != nil {
			return false, err
		}

		// Lease exists. Parse active slots.
		activeSlots := c.parseActiveSlots(lease)

		// Idempotency: check if this review already holds a slot
		for _, s := range activeSlots {
			if s == targetKey || s == review.Name {
				return true, nil
			}
		}

		// Capacity check: if active slots already at or above limit, deny admission
		if len(activeSlots) >= maxSlots {
			return false, nil
		}

		// Add this review to active slots
		activeSlots = append(activeSlots, targetKey)
		data, err := json.Marshal(activeSlots)
		if err != nil {
			return false, fmt.Errorf("marshal active slots: %w", err)
		}

		if lease.Annotations == nil {
			lease.Annotations = make(map[string]string)
		}
		lease.Annotations[CapacityLedgerActiveSlotsAnnotation] = string(data)
		nowMicro := metav1.NewMicroTime(time.Now().UTC())
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

		activeSlots := c.parseActiveSlots(lease)
		found := false
		newSlots := make([]string, 0, len(activeSlots))
		for _, s := range activeSlots {
			if s == targetKey || s == reviewName {
				found = true
			} else {
				newSlots = append(newSlots, s)
			}
		}

		if !found {
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
		nowMicro := metav1.NewMicroTime(time.Now().UTC())
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

	return c.parseActiveSlots(lease), nil
}

func (c *CapacityLedger) parseActiveSlots(lease *coordinationv1.Lease) []string {
	if lease == nil || lease.Annotations == nil {
		return nil
	}
	raw, ok := lease.Annotations[CapacityLedgerActiveSlotsAnnotation]
	if !ok || strings.TrimSpace(raw) == "" {
		return nil
	}
	var slots []string
	if err := json.Unmarshal([]byte(raw), &slots); err != nil {
		return nil
	}
	return slots
}

func stringPointer(s string) *string {
	return &s
}
