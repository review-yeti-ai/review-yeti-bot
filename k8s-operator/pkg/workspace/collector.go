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
	"time"

	coordinationv1 "k8s.io/api/coordination/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/uuid"
	"k8s.io/apimachinery/pkg/util/validation"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

const (
	IdleWorkspaceTTL               = 30 * time.Minute
	ReclamationLeaseDuration int32 = 120
	PodListPageSize          int64 = 100
	MaxPodListPages                = 10
	FinalizerUpdateTimeout         = 30 * time.Second
)

var (
	ErrWorkspaceClock           = errors.New("workspace timestamp is in the future")
	ErrWorkspacePodHistoryLimit = errors.New("workspace Pod history exceeds the bounded page limit")
)

type ReclaimReason string

const (
	RetainedIdleWindow     ReclaimReason = "idle-window"
	RetainedActiveLease    ReclaimReason = "active-lease"
	RetainedActivePod      ReclaimReason = "active-pod"
	ReclaimedIdleWorkspace ReclaimReason = "reclaimed-idle-workspace"
)

type ReclaimResult struct {
	Reclaimed    bool
	Reason       ReclaimReason
	RequeueAfter time.Duration
}

type Collector struct {
	client client.Client
}

func NewCollector(kubernetesClient client.Client) *Collector {
	return &Collector{client: kubernetesClient}
}

// Touch starts a new idle window for the exact repository and pull request.
// The update uses the caller's resourceVersion so a stale observation fails
// with a Kubernetes conflict instead of extending the wrong idle window.
func (c *Collector) Touch(
	ctx context.Context,
	pvc *corev1.PersistentVolumeClaim,
	namespace string,
	repositoryID int64,
	prNumber int32,
	now time.Time,
) error {
	if c == nil || c.client == nil || now.IsZero() {
		return ErrWorkspaceConfiguration
	}
	if err := ValidatePVC(pvc, namespace, repositoryID, prNumber); err != nil {
		return err
	}
	lastUsed, err := time.Parse(time.RFC3339Nano, pvc.Annotations[LastUsedAtAnnotation])
	if err != nil {
		return ErrWorkspaceConfiguration
	}
	if now.Before(lastUsed) {
		return ErrWorkspaceClock
	}

	updated := pvc.DeepCopy()
	updated.Annotations[LastUsedAtAnnotation] = now.UTC().Format(time.RFC3339Nano)
	return c.client.Update(ctx, updated)
}

// Reclaim removes an exact PR workspace only after its 30-minute idle window
// has elapsed and both Lease and Pod evidence prove it is unused. Every
// workspace Pod creator must acquire the same Lease through LeaseManager before
// creating or using a Pod. Reclamation holds a unique Lease, issues a
// resourceVersion-guarded delete while ProtectionFinalizer still protects the
// PVC, rechecks Pods, and only then removes that finalizer.
func (c *Collector) Reclaim(
	ctx context.Context,
	pvc *corev1.PersistentVolumeClaim,
	namespace string,
	repositoryID int64,
	prNumber int32,
	now time.Time,
) (ReclaimResult, error) {
	operationStartedAt := time.Now()
	if c == nil || c.client == nil || now.IsZero() || len(validation.IsDNS1123Label(namespace)) != 0 {
		return ReclaimResult{}, ErrWorkspaceConfiguration
	}
	if err := ValidatePVC(pvc, namespace, repositoryID, prNumber); err != nil {
		return ReclaimResult{}, err
	}
	lastUsed, err := time.Parse(time.RFC3339Nano, pvc.Annotations[LastUsedAtAnnotation])
	if err != nil {
		return ReclaimResult{}, ErrWorkspaceConfiguration
	}
	if now.Before(lastUsed) {
		return ReclaimResult{}, ErrWorkspaceClock
	}
	if remaining := IdleWorkspaceTTL - now.Sub(lastUsed); remaining > 0 {
		return ReclaimResult{Reason: RetainedIdleWindow, RequeueAfter: remaining}, nil
	}

	reclamationLease, claimed, err := c.claimReclamationLease(ctx, namespace, repositoryID, prNumber, now)
	if err != nil {
		return ReclaimResult{}, err
	}
	if !claimed {
		return ReclaimResult{Reason: RetainedActiveLease}, nil
	}
	if pvc.ResourceVersion == "" {
		return ReclaimResult{}, ErrWorkspaceConfiguration
	}
	observedResourceVersion := pvc.ResourceVersion
	if err := c.client.Delete(ctx, pvc.DeepCopy(), client.Preconditions{ResourceVersion: &observedResourceVersion}); err != nil {
		return ReclaimResult{}, err
	}
	terminating := &corev1.PersistentVolumeClaim{}
	if err := c.client.Get(ctx, client.ObjectKeyFromObject(pvc), terminating); err != nil {
		return ReclaimResult{}, err
	}
	if err := validateProtectedTerminatingPVC(terminating, namespace, repositoryID, prNumber); err != nil {
		return ReclaimResult{}, err
	}
	activePod, err := c.hasActivePod(ctx, namespace, repositoryID, prNumber)
	if err != nil {
		return ReclaimResult{}, err
	}
	if activePod {
		return ReclaimResult{Reason: RetainedActivePod}, nil
	}
	reclamationLease, err = c.renewReclamationLease(
		ctx, reclamationLease, namespace, repositoryID, prNumber,
		now.Add(time.Since(operationStartedAt)),
	)
	if err != nil {
		return ReclaimResult{}, err
	}

	updated := terminating.DeepCopy()
	updated.Finalizers = removeString(updated.Finalizers, ProtectionFinalizer)
	finalizerContext, cancelFinalizerUpdate := context.WithTimeout(ctx, FinalizerUpdateTimeout)
	defer cancelFinalizerUpdate()
	if err := c.client.Update(finalizerContext, updated); err != nil {
		return ReclaimResult{}, err
	}
	if updated.ResourceVersion == "" {
		return ReclaimResult{}, ErrWorkspaceConfiguration
	}
	leaseResourceVersion := reclamationLease.ResourceVersion
	if leaseResourceVersion == "" {
		return ReclaimResult{Reclaimed: true, Reason: ReclaimedIdleWorkspace}, ErrLeaseState
	}
	if err := c.client.Delete(ctx, reclamationLease, client.Preconditions{ResourceVersion: &leaseResourceVersion}); err != nil && !apierrors.IsNotFound(err) {
		return ReclaimResult{Reclaimed: true, Reason: ReclaimedIdleWorkspace}, err
	}
	return ReclaimResult{Reclaimed: true, Reason: ReclaimedIdleWorkspace}, nil
}

func (c *Collector) claimReclamationLease(
	ctx context.Context,
	namespace string,
	repositoryID int64,
	prNumber int32,
	now time.Time,
) (*coordinationv1.Lease, bool, error) {
	holderIdentity := "reclaimer_" + string(uuid.NewUUID())
	leaseName := LeaseName(repositoryID, prNumber)
	lease := &coordinationv1.Lease{}
	err := c.client.Get(ctx, types.NamespacedName{Namespace: namespace, Name: leaseName}, lease)
	if apierrors.IsNotFound(err) {
		labels, annotations := Metadata(repositoryID, prNumber)
		timestamp := metav1.NewMicroTime(now.UTC())
		transitions := int32(0)
		created := &coordinationv1.Lease{
			ObjectMeta: metav1.ObjectMeta{Name: leaseName, Namespace: namespace, Labels: labels, Annotations: annotations},
			Spec: coordinationv1.LeaseSpec{
				HolderIdentity:       &holderIdentity,
				LeaseDurationSeconds: int32Pointer(ReclamationLeaseDuration),
				AcquireTime:          &timestamp,
				RenewTime:            &timestamp,
				LeaseTransitions:     &transitions,
			},
		}
		if createErr := c.client.Create(ctx, created); createErr != nil {
			return nil, false, createErr
		}
		return created.DeepCopy(), true, nil
	}
	if err != nil {
		return nil, false, err
	}
	if lease.DeletionTimestamp != nil {
		return nil, false, ErrWorkspaceTerminating
	}
	if err := ValidateMetadata(lease.ObjectMeta, namespace, leaseName, repositoryID, prNumber); err != nil {
		return nil, false, err
	}
	previousHolder := pointerString(lease.Spec.HolderIdentity)
	if previousHolder != "" {
		expiresAt, expiresErr := expires(lease)
		if expiresErr != nil {
			return nil, false, expiresErr
		}
		if now.Before(expiresAt) {
			return lease.DeepCopy(), false, nil
		}
	}
	timestamp := metav1.NewMicroTime(now.UTC())
	if previousHolder != holderIdentity {
		transitions := int32(1)
		if lease.Spec.LeaseTransitions != nil {
			transitions = *lease.Spec.LeaseTransitions + 1
		}
		lease.Spec.LeaseTransitions = &transitions
		lease.Spec.AcquireTime = &timestamp
	}
	lease.Spec.HolderIdentity = &holderIdentity
	lease.Spec.LeaseDurationSeconds = int32Pointer(ReclamationLeaseDuration)
	lease.Spec.RenewTime = &timestamp
	if updateErr := c.client.Update(ctx, lease); updateErr != nil {
		return nil, false, updateErr
	}
	return lease.DeepCopy(), true, nil
}

func (c *Collector) renewReclamationLease(
	ctx context.Context,
	claimed *coordinationv1.Lease,
	namespace string,
	repositoryID int64,
	prNumber int32,
	now time.Time,
) (*coordinationv1.Lease, error) {
	if claimed == nil || claimed.Spec.HolderIdentity == nil || *claimed.Spec.HolderIdentity == "" {
		return nil, ErrLeaseState
	}
	leaseName := LeaseName(repositoryID, prNumber)
	fresh := &coordinationv1.Lease{}
	if err := c.client.Get(ctx, types.NamespacedName{Namespace: namespace, Name: leaseName}, fresh); err != nil {
		return nil, err
	}
	if fresh.DeletionTimestamp != nil {
		return nil, ErrWorkspaceTerminating
	}
	if err := ValidateMetadata(fresh.ObjectMeta, namespace, leaseName, repositoryID, prNumber); err != nil {
		return nil, err
	}
	if pointerString(fresh.Spec.HolderIdentity) != *claimed.Spec.HolderIdentity {
		return nil, ErrLeaseHeld
	}
	expiresAt, err := expires(fresh)
	if err != nil {
		return nil, err
	}
	if !now.Before(expiresAt) {
		return nil, ErrLeaseHeld
	}
	renewedAt := metav1.NewMicroTime(now.UTC())
	fresh.Spec.LeaseDurationSeconds = int32Pointer(ReclamationLeaseDuration)
	fresh.Spec.RenewTime = &renewedAt
	if err := c.client.Update(ctx, fresh); err != nil {
		return nil, err
	}
	return fresh.DeepCopy(), nil
}

func validateProtectedTerminatingPVC(
	pvc *corev1.PersistentVolumeClaim,
	namespace string,
	repositoryID int64,
	prNumber int32,
) error {
	if pvc == nil || pvc.DeletionTimestamp == nil {
		return ErrWorkspaceConfiguration
	}
	validationCopy := pvc.DeepCopy()
	validationCopy.DeletionTimestamp = nil
	return ValidatePVC(validationCopy, namespace, repositoryID, prNumber)
}

func (c *Collector) hasActivePod(
	ctx context.Context,
	namespace string,
	repositoryID int64,
	prNumber int32,
) (bool, error) {
	key := Key(repositoryID, prNumber)
	continueToken := ""
	for page := 0; page < MaxPodListPages; page++ {
		pods := &corev1.PodList{}
		options := []client.ListOption{
			client.InNamespace(namespace),
			client.MatchingLabels{WorkspaceHashLabel: key[:63]},
			client.Limit(PodListPageSize),
		}
		if continueToken != "" {
			options = append(options, client.Continue(continueToken))
		}
		if err := c.client.List(ctx, pods, options...); err != nil {
			return false, err
		}
		for index := range pods.Items {
			pod := &pods.Items[index]
			if err := validatePodIdentity(pod.ObjectMeta, namespace, repositoryID, prNumber); err != nil {
				return false, err
			}
			if pod.Status.Phase != corev1.PodSucceeded && pod.Status.Phase != corev1.PodFailed {
				return true, nil
			}
		}
		if pods.Continue == "" {
			return false, nil
		}
		if pods.Continue == continueToken {
			return false, ErrWorkspaceConfiguration
		}
		continueToken = pods.Continue
	}
	return false, ErrWorkspacePodHistoryLimit
}

func validatePodIdentity(metadata metav1.ObjectMeta, namespace string, repositoryID int64, prNumber int32) error {
	if metadata.Namespace != namespace {
		return ErrWorkspaceIdentity
	}
	wantLabels, wantAnnotations := Metadata(repositoryID, prNumber)
	for label, value := range wantLabels {
		if metadata.Labels[label] != value {
			return ErrWorkspaceIdentity
		}
	}
	if metadata.Annotations[WorkspaceKeyAnnotation] != wantAnnotations[WorkspaceKeyAnnotation] {
		return ErrWorkspaceIdentity
	}
	return nil
}

func removeString(values []string, remove string) []string {
	kept := make([]string, 0, len(values))
	for _, value := range values {
		if value != remove {
			kept = append(kept, value)
		}
	}
	return kept
}
