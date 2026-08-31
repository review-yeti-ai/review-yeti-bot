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

package workspace

import (
	"context"
	"errors"
	"math"
	"regexp"
	"time"

	coordinationv1 "k8s.io/api/coordination/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/validation"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

var (
	ErrLeaseHeld                  = errors.New("workspace lease is held by another run")
	ErrInsufficientDeadline       = errors.New("less than 120 seconds remain before terminal deadline")
	ErrLeaseState                 = errors.New("workspace lease state is invalid")
	ErrLeaseTakeoverNotAuthorized = errors.New("expired workspace lease takeover requires terminal pod evidence")
)

var runIDPattern = regexp.MustCompile(`^run_[a-f0-9]{32}$`)

type LeaseAcquireResult struct {
	Acquired       bool
	Lease          *coordinationv1.Lease
	HolderIdentity string
	HeldUntil      time.Time
}

// ValidateLeaseForUse proves that a worker is still holding the exact
// repository/PR lease immediately before its Job is created.  Callers must
// fetch the Lease close to creation time; an old successful acquisition is not
// sufficient evidence because the lease may have expired or been reclaimed.
func ValidateLeaseForUse(
	lease *coordinationv1.Lease,
	namespace string,
	repositoryID int64,
	prNumber int32,
	runID string,
	now time.Time,
) error {
	if lease == nil || now.IsZero() || len(validation.IsDNS1123Label(namespace)) != 0 ||
		Key(repositoryID, prNumber) == "" || !runIDPattern.MatchString(runID) {
		return ErrLeaseState
	}
	if lease.DeletionTimestamp != nil {
		return ErrWorkspaceTerminating
	}
	if err := ValidateMetadata(lease.ObjectMeta, namespace, LeaseName(repositoryID, prNumber), repositoryID, prNumber); err != nil {
		return err
	}
	if pointerString(lease.Spec.HolderIdentity) != runID {
		return ErrLeaseHeld
	}
	expiresAt, err := expires(lease)
	if err != nil {
		return err
	}
	if !now.Before(expiresAt) {
		return ErrLeaseHeld
	}
	return nil
}

type TakeoverEvidence struct {
	PreviousRunID   string
	AllPodsTerminal bool
}

type LeaseManager struct {
	client client.Client
}

func NewLeaseManager(kubernetesClient client.Client) *LeaseManager {
	return &LeaseManager{client: kubernetesClient}
}

func leaseDuration(terminalDeadline, now time.Time) (int32, error) {
	remaining := terminalDeadline.Sub(now)
	if remaining < 120*time.Second {
		return 0, ErrInsufficientDeadline
	}
	seconds := math.Ceil(remaining.Seconds()) + 60
	if seconds > math.MaxInt32 {
		return 0, ErrLeaseState
	}
	return int32(seconds), nil
}

func (m *LeaseManager) Acquire(
	ctx context.Context,
	namespace string,
	repositoryID int64,
	prNumber int32,
	runID string,
	terminalDeadline time.Time,
	now time.Time,
	takeoverEvidence ...TakeoverEvidence,
) (LeaseAcquireResult, error) {
	if m == nil || m.client == nil || len(validation.IsDNS1123Label(namespace)) != 0 ||
		Key(repositoryID, prNumber) == "" || !runIDPattern.MatchString(runID) || now.IsZero() || len(takeoverEvidence) > 1 {
		return LeaseAcquireResult{}, ErrLeaseState
	}
	duration, err := leaseDuration(terminalDeadline, now)
	if err != nil {
		return LeaseAcquireResult{}, err
	}
	name := LeaseName(repositoryID, prNumber)
	lease := &coordinationv1.Lease{}
	err = m.client.Get(ctx, types.NamespacedName{Namespace: namespace, Name: name}, lease)
	if apierrors.IsNotFound(err) {
		labels, annotations := Metadata(repositoryID, prNumber)
		acquiredAt := metav1.NewMicroTime(now.UTC())
		transitions := int32(0)
		created := &coordinationv1.Lease{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace, Labels: labels, Annotations: annotations},
			Spec: coordinationv1.LeaseSpec{
				HolderIdentity:       stringPointer(runID),
				LeaseDurationSeconds: int32Pointer(duration),
				AcquireTime:          &acquiredAt,
				RenewTime:            &acquiredAt,
				LeaseTransitions:     &transitions,
			},
		}
		if createErr := m.client.Create(ctx, created); createErr != nil {
			return LeaseAcquireResult{}, createErr
		}
		return LeaseAcquireResult{Acquired: true, Lease: created.DeepCopy(), HolderIdentity: runID}, nil
	}
	if err != nil {
		return LeaseAcquireResult{}, err
	}
	if lease.DeletionTimestamp != nil {
		return LeaseAcquireResult{}, ErrWorkspaceTerminating
	}
	if err := ValidateMetadata(lease.ObjectMeta, namespace, name, repositoryID, prNumber); err != nil {
		return LeaseAcquireResult{}, err
	}

	holder := pointerString(lease.Spec.HolderIdentity)
	expiresAt, stateErr := expires(lease)
	if holder != "" && stateErr != nil {
		return LeaseAcquireResult{}, stateErr
	}
	if holder != "" && holder != runID && now.Before(expiresAt) {
		return LeaseAcquireResult{
			Acquired: false, Lease: lease.DeepCopy(), HolderIdentity: holder, HeldUntil: expiresAt,
		}, ErrLeaseHeld
	}
	if holder != "" && holder != runID {
		if len(takeoverEvidence) != 1 || !takeoverEvidence[0].AllPodsTerminal || takeoverEvidence[0].PreviousRunID != holder {
			return LeaseAcquireResult{Acquired: false, Lease: lease.DeepCopy(), HolderIdentity: holder, HeldUntil: expiresAt}, ErrLeaseTakeoverNotAuthorized
		}
	}

	acquiredAt := metav1.NewMicroTime(now.UTC())
	if holder != runID {
		transitions := int32(1)
		if lease.Spec.LeaseTransitions != nil {
			transitions = *lease.Spec.LeaseTransitions + 1
		}
		lease.Spec.LeaseTransitions = &transitions
		lease.Spec.AcquireTime = &acquiredAt
	}
	lease.Spec.HolderIdentity = stringPointer(runID)
	lease.Spec.LeaseDurationSeconds = int32Pointer(duration)
	lease.Spec.RenewTime = &acquiredAt
	if updateErr := m.client.Update(ctx, lease); updateErr != nil {
		return LeaseAcquireResult{}, updateErr
	}
	return LeaseAcquireResult{Acquired: true, Lease: lease.DeepCopy(), HolderIdentity: runID}, nil
}

// Release clears a lease only when the caller still owns it. A release is
// intentionally an optimistic update: a newer run that has already taken the
// lease wins the race and the old worker cannot clear that ownership.
func (m *LeaseManager) Release(
	ctx context.Context,
	namespace string,
	repositoryID int64,
	prNumber int32,
	runID string,
	now time.Time,
) error {
	if m == nil || m.client == nil || now.IsZero() || !runIDPattern.MatchString(runID) {
		return ErrLeaseState
	}
	name := LeaseName(repositoryID, prNumber)
	if name == "" || len(validation.IsDNS1123Label(namespace)) != 0 {
		return ErrLeaseState
	}
	lease := &coordinationv1.Lease{}
	if err := m.client.Get(ctx, types.NamespacedName{Namespace: namespace, Name: name}, lease); err != nil {
		if apierrors.IsNotFound(err) {
			return nil
		}
		return err
	}
	if lease.DeletionTimestamp != nil {
		return ErrWorkspaceTerminating
	}
	if err := ValidateMetadata(lease.ObjectMeta, namespace, name, repositoryID, prNumber); err != nil {
		return err
	}
	if pointerString(lease.Spec.HolderIdentity) == "" {
		return nil
	}
	if pointerString(lease.Spec.HolderIdentity) != runID {
		return ErrLeaseHeld
	}
	lease.Spec.HolderIdentity = nil
	lease.Spec.LeaseDurationSeconds = nil
	lease.Spec.AcquireTime = nil
	releasedAt := metav1.NewMicroTime(now.UTC())
	lease.Spec.RenewTime = &releasedAt
	return m.client.Update(ctx, lease)
}

func expires(lease *coordinationv1.Lease) (time.Time, error) {
	if lease.Spec.LeaseDurationSeconds == nil || *lease.Spec.LeaseDurationSeconds <= 0 {
		return time.Time{}, ErrLeaseState
	}
	var base time.Time
	if lease.Spec.RenewTime != nil {
		base = lease.Spec.RenewTime.Time
	} else if lease.Spec.AcquireTime != nil {
		base = lease.Spec.AcquireTime.Time
	}
	if base.IsZero() {
		return time.Time{}, ErrLeaseState
	}
	return base.Add(time.Duration(*lease.Spec.LeaseDurationSeconds) * time.Second), nil
}

func stringPointer(value string) *string { return &value }
func int32Pointer(value int32) *int32    { return &value }
func pointerString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
