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
	"errors"
	"fmt"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/selection"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

	reviewv1alpha2 "github.com/calltelemetry/ct-review-bot/k8s-operator/api/v1alpha2"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/job"
	operatorMetrics "github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/metrics"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/workspace"
)

const (
	DefaultV1Alpha2MaxConcurrentJobs = 1
	v1Alpha2RequeueAfter             = 5 * time.Second
	v1Alpha2PVCCreateRequeue         = 1 * time.Second
	workerCreationReserved           = "WorkerCreationReserved"
	terminalOutcomeFinalizer         = "review-yeti.ai/terminal-outcome"
	failurePublicationCondition      = "FailurePublication"
)

// PRReviewJobV1Alpha2Reconciler is the disabled-by-default receipt-only
// execution controller. It owns only Jobs; PR-scoped workspace PVCs are
// deliberately ownerless so they can be reused by later heads of the same PR.
// PostgreSQL remains the lifecycle and publication authority.
type PRReviewJobV1Alpha2Reconciler struct {
	client.Client
	// Confirm cached Job misses before treating an execution as lost.
	APIReader         client.Reader
	Scheme            *runtime.Scheme
	Now               func() time.Time
	MaxConcurrentJobs int
	// Publishing configures the app-gate lane. Left zero, BuildWorkerJob refuses
	// every app-gate review -- deliberately, since this lane fails closed and a
	// half-configured transport must not reach a running worker.
	Publishing job.PublishingConfig
}

// +kubebuilder:rbac:groups=review-yeti.ai,resources=prreviewjobs,verbs=get;list;watch;update;patch
// +kubebuilder:rbac:groups=review-yeti.ai,resources=prreviewjobs/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=batch,resources=jobs,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=pods,verbs=get;list;watch
// +kubebuilder:rbac:groups="",resources=persistentvolumeclaims,verbs=get;list;watch;create;update;patch
// +kubebuilder:rbac:groups=coordination.k8s.io,resources=leases,verbs=get;list;watch;create;update;patch
func (r *PRReviewJobV1Alpha2Reconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	var review reviewv1alpha2.PRReviewJob
	err := r.getCachedThenLive(ctx, req.NamespacedName, &review)
	if err != nil {
		if apierrors.IsNotFound(err) {
			return ctrl.Result{}, r.releaseOrphanedWorkerObservation(ctx, req)
		}
		return ctrl.Result{}, err
	}

	if failurePublicationPending(&review) {
		return r.reconcileFailurePublication(ctx, &review)
	}
	if isTerminalPhase(review.Status.Phase) {
		return r.reconcileTerminalWorkspace(ctx, &review)
	}
	now := r.clock()
	if err := validateProjectionWindow(&review); err != nil {
		return ctrl.Result{}, r.fail(ctx, &review, "InvalidProjection", err.Error())
	}
	if _, err := observeTiming(&review, reviewv1alpha2.DispatchStageReceived, review.Spec.ReceivedAt); err != nil {
		return ctrl.Result{}, r.fail(ctx, &review, "TimingContractViolation", err.Error())
	}
	if !now.Before(review.Spec.TerminalDeadline.Time) {
		return r.reconcileElapsedDeadline(ctx, &review, now)
	}

	workerName := review.Name + "-worker"
	var existing batchv1.Job
	existingErr := r.getCachedThenLive(ctx, types.NamespacedName{Namespace: review.Namespace, Name: workerName}, &existing)
	if existingErr != nil && !apierrors.IsNotFound(existingErr) {
		return ctrl.Result{}, existingErr
	}
	if existingErr == nil {
		if !managedWorkerJobMatches(&review, &existing) {
			return r.failWorkerContractMismatch(ctx, &review, &existing, "existing worker Job does not match the immutable receipt-only contract")
		}
		// Adopt Jobs created by an older operator before observing their state.
		// Terminal Jobs need the guard too: a parent status conflict must not let
		// immediate TTL collection erase the authoritative outcome between retries.
		if existing.DeletionTimestamp == nil && !controllerutil.ContainsFinalizer(&existing, terminalOutcomeFinalizer) {
			controllerutil.AddFinalizer(&existing, terminalOutcomeFinalizer)
			if err := r.Update(ctx, &existing); err != nil {
				return ctrl.Result{}, err
			}
		}
		return r.reconcileExistingJob(ctx, &review, &existing, now)
	}
	if workerCreationWasAttempted(&review) {
		// A Job can finish and be garbage-collected before we observe its
		// terminal state. Missing execution evidence is not a fresh admission.
		// Do not release its workspace here: surviving Pods or a newer Lease
		// must still pass the normal guarded terminal cleanup path.
		message := "previous worker creation was reserved or observed but its Job is missing; execution outcome is unknown and fresh admission is required"
		if review.Spec.PublicationMode == job.PublicationModeAppGate {
			return r.startFailurePublication(ctx, &review, "WorkerJobMissing", message)
		}
		return ctrl.Result{RequeueAfter: v1Alpha2RequeueAfter}, r.fail(ctx, &review, "WorkerJobMissing", message)
	}

	limit := r.MaxConcurrentJobs
	if limit <= 0 {
		limit = DefaultV1Alpha2MaxConcurrentJobs
	}
	admission, err := r.admissionSnapshot(ctx, &review, now, limit)
	if err != nil {
		return ctrl.Result{}, err
	}
	if admission.activeWorkers >= limit {
		if err := r.setPhase(ctx, &review, reviewv1alpha2.PhaseQueued, "CapacityExceeded", fmt.Sprintf("waiting for one of %d worker slots", limit)); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{RequeueAfter: v1Alpha2RequeueAfter}, nil
	}
	if admission.olderWaiting {
		if err := r.setPhase(ctx, &review, reviewv1alpha2.PhaseQueued, "CapacityExceeded", "waiting for an older worker admission candidate"); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{RequeueAfter: v1Alpha2RequeueAfter}, nil
	}

	pvcName := ""
	if review.Spec.RunnerMode == "generic" {
		pvcName = workspace.PVCName(review.Spec.RepositoryID, review.Spec.PRNumber)
		var pvc corev1.PersistentVolumeClaim
		if err := r.Get(ctx, types.NamespacedName{Namespace: review.Namespace, Name: pvcName}, &pvc); err != nil {
			if !apierrors.IsNotFound(err) {
				return ctrl.Result{}, err
			}
			created, buildErr := workspace.BuildPVC(review.Namespace, review.Spec.RepositoryID, review.Spec.PRNumber, now)
			if buildErr != nil {
				return ctrl.Result{}, r.fail(ctx, &review, "WorkspaceRejected", buildErr.Error())
			}
			if createErr := r.Create(ctx, created); createErr != nil && !apierrors.IsAlreadyExists(createErr) {
				return ctrl.Result{}, createErr
			}
			if statusErr := r.setPhase(ctx, &review, reviewv1alpha2.PhaseQueued, "WorkspaceProvisioning", "workspace PVC created; waiting for it to become available"); statusErr != nil {
				return ctrl.Result{}, statusErr
			}
			return ctrl.Result{RequeueAfter: v1Alpha2PVCCreateRequeue}, nil
		}
		if err := workspace.ValidatePVC(&pvc, review.Namespace, review.Spec.RepositoryID, review.Spec.PRNumber); err != nil {
			if errors.Is(err, workspace.ErrWorkspaceTerminating) {
				if statusErr := r.setPhase(ctx, &review, reviewv1alpha2.PhaseQueued, "WorkspaceTerminating", err.Error()); statusErr != nil {
					return ctrl.Result{}, statusErr
				}
				return ctrl.Result{RequeueAfter: v1Alpha2RequeueAfter}, nil
			}
			return ctrl.Result{}, r.fail(ctx, &review, "WorkspaceIdentityMismatch", err.Error())
		}
	}

	leaseResult, err := workspace.NewLeaseManager(r.Client).Acquire(
		ctx,
		review.Namespace,
		review.Spec.RepositoryID,
		review.Spec.PRNumber,
		review.Spec.RunID,
		review.Spec.TerminalDeadline.Time,
		now,
	)
	if err != nil {
		if errors.Is(err, workspace.ErrLeaseHeld) || errors.Is(err, workspace.ErrLeaseTakeoverNotAuthorized) {
			if statusErr := r.setPhase(ctx, &review, reviewv1alpha2.PhaseQueued, "WorkspaceBusy", "waiting for the previous PR worker to release its workspace lease"); statusErr != nil {
				return ctrl.Result{}, statusErr
			}
			return ctrl.Result{RequeueAfter: v1Alpha2RequeueAfter}, nil
		}
		return ctrl.Result{}, r.fail(ctx, &review, "WorkspaceLeaseRejected", err.Error())
	}

	worker, err := job.BuildWorkerJob(job.Input{
		Review:           &review,
		WorkspacePVCName: pvcName,
		WorkspaceLease:   leaseResult,
		Now:              now,
		Publishing:       r.Publishing,
	})
	if err != nil {
		// The lease was acquired for this attempt, but no Job exists. Release it
		// before recording a terminal contract failure so a later run is not
		// stranded behind an invalid projection.
		if releaseErr := workspace.NewLeaseManager(r.Client).Release(ctx, review.Namespace, review.Spec.RepositoryID, review.Spec.PRNumber, review.Spec.RunID, now); releaseErr != nil {
			return ctrl.Result{}, releaseErr
		}
		return ctrl.Result{}, r.fail(ctx, &review, "WorkerContractRejected", err.Error())
	}
	if r.Scheme != nil {
		if err := controllerutil.SetControllerReference(&review, worker, r.Scheme); err != nil {
			if releaseErr := workspace.NewLeaseManager(r.Client).Release(ctx, review.Namespace, review.Spec.RepositoryID, review.Spec.PRNumber, review.Spec.RunID, now); releaseErr != nil {
				return ctrl.Result{}, releaseErr
			}
			return ctrl.Result{}, err
		}
	}
	// TTL-after-finished may request deletion immediately. Hold the Job until
	// its terminal result has been durably copied into the parent status; the
	// next terminal reconcile releases this observation guard.
	controllerutil.AddFinalizer(worker, terminalOutcomeFinalizer)
	// Persist intent before Create, whose response or following status update
	// can be lost. This condition reserves at most one creation attempt, not a
	// claim that a Job started. Even an uncertain/unsent Create cannot be
	// retried under the same admitted identity once this write succeeds.
	meta.SetStatusCondition(&review.Status.Conditions, metav1.Condition{
		Type: workerCreationReserved, Status: metav1.ConditionTrue,
		Reason: "CreateAttemptReserved", Message: "worker Job creation is reserved; outcome has not yet been observed",
		ObservedGeneration: review.Generation, LastTransitionTime: metav1.NewTime(now),
	})
	if err := r.Status().Update(ctx, &review); err != nil {
		return ctrl.Result{}, err
	}
	if err := ctx.Err(); err != nil {
		return ctrl.Result{}, err
	}
	if err := r.Create(ctx, worker); err != nil {
		if !apierrors.IsAlreadyExists(err) {
			return ctrl.Result{}, err
		}
		if getErr := r.Get(ctx, types.NamespacedName{Namespace: worker.Namespace, Name: worker.Name}, &existing); getErr != nil {
			return ctrl.Result{}, getErr
		}
		if !managedWorkerJobMatches(&review, &existing) {
			return r.failWorkerContractMismatch(ctx, &review, &existing, "racing worker Job does not match the immutable receipt-only contract")
		}
		return r.reconcileExistingJob(ctx, &review, &existing, now)
	}

	review.Status.JobName = worker.Name
	review.Status.PVCName = pvcName
	review.Status.LeaseName = workspace.LeaseName(review.Spec.RepositoryID, review.Spec.PRNumber)
	review.Status.StartTime = timePtr(metav1.NewTime(now))
	if _, err := observeTiming(&review, reviewv1alpha2.DispatchStageJobCreated, metav1.NewTime(now)); err != nil {
		return ctrl.Result{}, r.fail(ctx, &review, "TimingContractViolation", err.Error())
	}
	if err := r.setPhase(ctx, &review, reviewv1alpha2.PhaseRunning, "WorkerCreated", "receipt-only worker Job created"); err != nil {
		return ctrl.Result{}, err
	}
	return ctrl.Result{}, nil
}

// A finalizer on an owned child cannot delay deletion of its owner. If a
// PRReviewJob is explicitly removed, release only this controller's guard from
// its exact child so garbage collection cannot strand a terminating Job. The
// uncached read above is required before entering this owner-absent path.
func (r *PRReviewJobV1Alpha2Reconciler) releaseOrphanedWorkerObservation(ctx context.Context, req ctrl.Request) error {
	var worker batchv1.Job
	err := r.getCachedThenLive(ctx, types.NamespacedName{Namespace: req.Namespace, Name: req.Name + "-worker"}, &worker)
	if apierrors.IsNotFound(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if !controllerutil.ContainsFinalizer(&worker, terminalOutcomeFinalizer) || !controlledByReviewName(&worker, req.Name) {
		return nil
	}
	controllerutil.RemoveFinalizer(&worker, terminalOutcomeFinalizer)
	return r.Update(ctx, &worker)
}

func controlledByReviewName(worker *batchv1.Job, name string) bool {
	for _, owner := range worker.OwnerReferences {
		if owner.Controller != nil && *owner.Controller && owner.APIVersion == reviewv1alpha2.GroupVersion.String() &&
			owner.Kind == "PRReviewJob" && owner.Name == name {
			return true
		}
	}
	return false
}

// reconcileElapsedDeadline checks an already-admitted worker before recording
// expiry. Kubernetes may deliver a terminal Job event after the wall-clock
// deadline, and that Job's terminal condition remains the authoritative result.
// An app-gate worker that is still active or has disappeared is stopped and
// routed into durable failure publication instead of silently expiring.
func (r *PRReviewJobV1Alpha2Reconciler) reconcileElapsedDeadline(
	ctx context.Context,
	review *reviewv1alpha2.PRReviewJob,
	now time.Time,
) (ctrl.Result, error) {
	workerKey := types.NamespacedName{Namespace: review.Namespace, Name: review.Name + "-worker"}
	var worker batchv1.Job
	err := r.getCachedThenLive(ctx, workerKey, &worker)
	if err == nil {
		if !managedWorkerJobMatches(review, &worker) {
			return r.failWorkerContractMismatch(ctx, review, &worker, "existing worker Job does not match the immutable receipt-only contract")
		}
		if worker.DeletionTimestamp == nil && !controllerutil.ContainsFinalizer(&worker, terminalOutcomeFinalizer) {
			controllerutil.AddFinalizer(&worker, terminalOutcomeFinalizer)
			if err := r.Update(ctx, &worker); err != nil {
				return ctrl.Result{}, err
			}
		}
		if worker.Status.Succeeded > 0 || worker.Status.Failed > 0 {
			return r.reconcileExistingJob(ctx, review, &worker, now)
		}
		if review.Spec.PublicationMode == job.PublicationModeAppGate && workerCreationWasAttempted(review) {
			if worker.DeletionTimestamp == nil {
				if err := r.Delete(ctx, &worker, client.PropagationPolicy(metav1.DeletePropagationForeground)); err != nil && !apierrors.IsNotFound(err) {
					return ctrl.Result{}, err
				}
			}
			return r.startFailurePublication(ctx, review, "DeadlineExpired", "publishing worker did not produce a durable verdict before its terminal deadline")
		}
	} else if !apierrors.IsNotFound(err) {
		return ctrl.Result{}, err
	} else if review.Spec.PublicationMode == job.PublicationModeAppGate && workerCreationWasAttempted(review) {
		return r.startFailurePublication(ctx, review, "WorkerJobMissing", "publishing worker disappeared without a durable verdict before terminal observation")
	}

	if _, err := observeTiming(review, reviewv1alpha2.DispatchStageCompleted, metav1.NewTime(now)); err != nil {
		return ctrl.Result{}, r.fail(ctx, review, "TimingContractViolation", err.Error())
	}
	r.recordDispatchTiming(review, now)
	return ctrl.Result{}, r.setPhase(ctx, review, reviewv1alpha2.PhaseExpired, "DeadlineExpired", "review terminal deadline has elapsed")
}

func workerCreationWasAttempted(review *reviewv1alpha2.PRReviewJob) bool {
	// Also recognize status written by older operators that had no reservation.
	return meta.IsStatusConditionTrue(review.Status.Conditions, workerCreationReserved) ||
		review.Status.Phase == reviewv1alpha2.PhaseRunning || review.Status.JobName != "" ||
		review.Status.StartTime != nil ||
		(review.Status.Timing != nil && review.Status.Timing.JobCreatedAt != nil)
}

func (r *PRReviewJobV1Alpha2Reconciler) reconcileExistingJob(ctx context.Context, review *reviewv1alpha2.PRReviewJob, worker *batchv1.Job, now time.Time) (ctrl.Result, error) {
	jobCreatedAt := metav1.NewTime(now)
	if !worker.CreationTimestamp.Time.IsZero() {
		jobCreatedAt = worker.CreationTimestamp
	}
	timingChanged, err := observeTiming(review, reviewv1alpha2.DispatchStageJobCreated, jobCreatedAt)
	if err != nil {
		return ctrl.Result{}, err
	}
	podTimingChanged, err := r.observeWorkerPod(ctx, review, worker, now)
	if err != nil {
		return ctrl.Result{}, err
	}
	timingChanged = timingChanged || podTimingChanged
	if worker.Status.Succeeded == 0 && worker.Status.Failed == 0 {
		if review.Status.Phase != reviewv1alpha2.PhaseRunning || review.Status.JobName != worker.Name {
			review.Status.JobName = worker.Name
			if review.Spec.RunnerMode == "generic" {
				review.Status.PVCName = workspace.PVCName(review.Spec.RepositoryID, review.Spec.PRNumber)
			} else {
				review.Status.PVCName = ""
			}
			review.Status.LeaseName = workspace.LeaseName(review.Spec.RepositoryID, review.Spec.PRNumber)
			if review.Status.StartTime == nil {
				review.Status.StartTime = timePtr(jobCreatedAt)
			}
			if err := r.setPhase(ctx, review, reviewv1alpha2.PhaseRunning, "WorkerObserved", "receipt-only worker Job is running"); err != nil {
				return ctrl.Result{}, err
			}
		} else if timingChanged {
			if err := r.Status().Update(ctx, review); err != nil {
				return ctrl.Result{}, err
			}
		}
		return ctrl.Result{}, nil
	}

	if err := workspace.NewLeaseManager(r.Client).Release(ctx, review.Namespace, review.Spec.RepositoryID, review.Spec.PRNumber, review.Spec.RunID, now); err != nil && !errors.Is(err, workspace.ErrLeaseHeld) {
		return ctrl.Result{}, err
	}
	if err := r.markWorkspaceUsed(ctx, review, now); err != nil {
		return ctrl.Result{}, err
	}
	completed := terminalWorkerTime(worker, now)
	review.Status.CompletionTime = &completed
	if _, err := observeTiming(review, reviewv1alpha2.DispatchStageCompleted, completed); err != nil {
		return ctrl.Result{}, r.fail(ctx, review, "TimingContractViolation", err.Error())
	}
	r.recordDispatchTiming(review, completed.Time)
	if worker.Status.Succeeded > 0 {
		return ctrl.Result{}, r.setPhase(ctx, review, reviewv1alpha2.PhaseSucceeded, "WorkerSucceeded", "receipt-only worker Job completed")
	}
	if review.Spec.PublicationMode == job.PublicationModeAppGate {
		return r.startFailurePublication(ctx, review, "WorkerFailed", "publishing worker Job failed")
	}
	return ctrl.Result{}, r.setPhase(ctx, review, reviewv1alpha2.PhaseFailed, "WorkerFailed", "receipt-only worker Job failed")
}

func failurePublicationPending(review *reviewv1alpha2.PRReviewJob) bool {
	condition := meta.FindStatusCondition(review.Status.Conditions, failurePublicationCondition)
	return condition != nil && condition.Status == metav1.ConditionFalse
}

// startFailurePublication first records the fail-closed parent outcome and the
// publication obligation in one status write. A crash after this point is safe:
// the next reconcile sees the pending condition before terminal cleanup and
// delegates the exact admitted identity to the dispatcher-owned deadline reaper.
// The operator never retries GitHub with the worker's expiring installation
// token and never receives App private-key material.
func (r *PRReviewJobV1Alpha2Reconciler) startFailurePublication(
	ctx context.Context,
	review *reviewv1alpha2.PRReviewJob,
	reason string,
	message string,
) (ctrl.Result, error) {
	now := metav1.NewTime(r.clock())
	review.Status.Phase = reviewv1alpha2.PhaseFailed
	review.Status.ObservedGeneration = review.Generation
	review.Status.Message = message
	meta.SetStatusCondition(&review.Status.Conditions, metav1.Condition{
		Type:               "Ready",
		Status:             metav1.ConditionTrue,
		Reason:             reason,
		Message:            message,
		ObservedGeneration: review.Generation,
		LastTransitionTime: now,
	})
	meta.SetStatusCondition(&review.Status.Conditions, metav1.Condition{
		Type:               failurePublicationCondition,
		Status:             metav1.ConditionFalse,
		Reason:             reason,
		Message:            "fail-closed App check publication is pending",
		ObservedGeneration: review.Generation,
		LastTransitionTime: now,
	})
	if err := r.Status().Update(ctx, review); err != nil {
		return ctrl.Result{}, err
	}
	return ctrl.Result{RequeueAfter: v1Alpha2RequeueAfter}, nil
}

func (r *PRReviewJobV1Alpha2Reconciler) reconcileFailurePublication(
	ctx context.Context,
	review *reviewv1alpha2.PRReviewJob,
) (ctrl.Result, error) {
	// A worker can cross its deadline or enter deletion between the observation
	// that started failure recovery and this reconcile. Its finalizer keeps a
	// terminal success available; preserve that authoritative result instead of
	// allowing a stale pending condition to manufacture a failure over SHIP.
	var observed batchv1.Job
	err := r.getCachedThenLive(ctx, types.NamespacedName{Namespace: review.Namespace, Name: review.Name + "-worker"}, &observed)
	if err == nil && managedWorkerJobMatches(review, &observed) && observed.Status.Succeeded > 0 {
		meta.RemoveStatusCondition(&review.Status.Conditions, failurePublicationCondition)
		return r.reconcileExistingJob(ctx, review, &observed, r.clock())
	}
	if err != nil && !apierrors.IsNotFound(err) {
		return ctrl.Result{}, err
	}

	// A contract mismatch may leave an untrusted owned Job running. Stop only the
	// exact child after the pending obligation is durable; if deletion is lost,
	// this reconcile retries it without ever recreating the worker.
	worker, err := r.stopOwnedReviewWorker(ctx, review)
	if err != nil {
		return ctrl.Result{}, err
	}
	activeWorker, err := r.hasActiveReviewWorkerPod(ctx, review)
	if worker != nil {
		activeWorker, err = r.hasActiveWorkerJobPod(ctx, worker)
	}
	if err != nil {
		return ctrl.Result{}, err
	}
	if activeWorker {
		return ctrl.Result{RequeueAfter: v1Alpha2RequeueAfter}, nil
	}
	// Unknown is deliberate: the operator records only that responsibility moved
	// to the durable service. It must never claim a GitHub check was published or
	// accept a completed success/neutral/foreign check without the service's App
	// identity and row lock. The dispatcher reaper reconciles exact identity with
	// bounded pagination and a fresh repository-scoped App token.
	meta.SetStatusCondition(&review.Status.Conditions, metav1.Condition{
		Type:               failurePublicationCondition,
		Status:             metav1.ConditionUnknown,
		Reason:             "DelegatedToTrustedService",
		Message:            "fail-closed publication delegated to the trusted dispatcher deadline reaper for exact-identity reconciliation with a fresh App token",
		ObservedGeneration: review.Generation,
		LastTransitionTime: metav1.NewTime(r.clock()),
	})
	if err := r.Status().Update(ctx, review); err != nil {
		return ctrl.Result{}, err
	}
	return ctrl.Result{RequeueAfter: v1Alpha2RequeueAfter}, nil
}

func (r *PRReviewJobV1Alpha2Reconciler) stopOwnedReviewWorker(
	ctx context.Context,
	review *reviewv1alpha2.PRReviewJob,
) (*batchv1.Job, error) {
	var worker batchv1.Job
	err := r.getCachedThenLive(ctx, types.NamespacedName{Namespace: review.Namespace, Name: review.Name + "-worker"}, &worker)
	if apierrors.IsNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !metav1.IsControlledBy(&worker, review) {
		return nil, errors.New("refusing to stop a worker Job not controlled by the failed review")
	}
	if worker.DeletionTimestamp == nil {
		if err := r.Delete(ctx, &worker, client.PropagationPolicy(metav1.DeletePropagationForeground)); err != nil && !apierrors.IsNotFound(err) {
			return nil, err
		}
	}
	return &worker, nil
}

// observeWorkerPod records the stage timestamps that Kubernetes exposes on the
// worker Pod. ImageObservedAt is intentionally named as an observation: the
// Kubernetes API exposes an ImageID but not a durable image-pull timestamp.
// When the process start is already visible, that timestamp is the safe upper
// bound for image readiness and keeps the lifecycle receipt monotonic.
func (r *PRReviewJobV1Alpha2Reconciler) observeWorkerPod(ctx context.Context, review *reviewv1alpha2.PRReviewJob, worker *batchv1.Job, now time.Time) (bool, error) {
	var pods corev1.PodList
	// The component label follows the lane: publishing workers carry
	// PublishingWorkerComponent, so a hardcoded receipt-only filter would observe no
	// pod at all for them and leave the lifecycle receipt permanently empty.
	if err := r.List(ctx, &pods, client.InNamespace(review.Namespace), client.MatchingLabels{
		"review-yeti.ai/run-id":    review.Spec.RunID,
		"review-yeti.ai/component": job.WorkerComponentFor(review.Spec.PublicationMode, review.Spec.QualificationProfile),
	}); err != nil {
		return false, err
	}
	changed := false
	for index := range pods.Items {
		pod := &pods.Items[index]
		if !podBelongsToWorkerJob(pod, worker) {
			continue
		}
		var scheduledAt *metav1.Time
		for _, condition := range pod.Status.Conditions {
			if condition.Type == corev1.PodScheduled && condition.Status == corev1.ConditionTrue && !condition.LastTransitionTime.Time.IsZero() {
				value := condition.LastTransitionTime
				scheduledAt = &value
				break
			}
		}
		if scheduledAt != nil {
			if observed, err := observeTiming(review, reviewv1alpha2.DispatchStagePodScheduled, *scheduledAt); err == nil {
				changed = changed || observed
			}
		}

		var processStartedAt *metav1.Time
		imageReady := false
		for _, status := range pod.Status.ContainerStatuses {
			if status.Name != "reviewer-worker" {
				continue
			}
			imageReady = status.ImageID != ""
			if status.State.Running != nil && !status.State.Running.StartedAt.Time.IsZero() {
				value := status.State.Running.StartedAt
				processStartedAt = &value
			} else if status.State.Terminated != nil && !status.State.Terminated.StartedAt.Time.IsZero() {
				// A fast receipt-only worker can finish before the next reconcile,
				// so Kubernetes may expose only its terminal state. Its immutable
				// StartedAt still provides the process-start boundary.
				value := status.State.Terminated.StartedAt
				processStartedAt = &value
			}
			break
		}
		if imageReady {
			imageObservedAt := metav1.NewTime(now)
			if processStartedAt != nil && imageObservedAt.After(processStartedAt.Time) {
				imageObservedAt = *processStartedAt
			}
			if observed, err := observeTiming(review, reviewv1alpha2.DispatchStageImageObserved, imageObservedAt); err == nil {
				changed = changed || observed
			}
		}
		if processStartedAt != nil {
			if observed, err := observeTiming(review, reviewv1alpha2.DispatchStageProcessStarted, *processStartedAt); err == nil {
				changed = changed || observed
			}
		}
	}
	return changed, nil
}

func podBelongsToWorkerJob(pod *corev1.Pod, worker *batchv1.Job) bool {
	if pod == nil || worker == nil {
		return false
	}
	if pod.Labels["job-name"] == worker.Name || pod.Labels["batch.kubernetes.io/job-name"] == worker.Name {
		return true
	}
	if worker.UID == "" {
		return false
	}
	for _, owner := range pod.OwnerReferences {
		if owner.UID == worker.UID && owner.Kind == "Job" {
			return true
		}
	}
	return false
}

func observeTiming(review *reviewv1alpha2.PRReviewJob, stage reviewv1alpha2.DispatchTimingStage, at metav1.Time) (bool, error) {
	if review.Status.Timing == nil {
		review.Status.Timing = &reviewv1alpha2.DispatchTimingStatus{}
	}
	return review.Status.Timing.Observe(stage, at)
}

func terminalWorkerTime(worker *batchv1.Job, fallback time.Time) metav1.Time {
	if worker.Status.CompletionTime != nil && !worker.Status.CompletionTime.Time.IsZero() {
		return *worker.Status.CompletionTime
	}
	for _, condition := range worker.Status.Conditions {
		if (condition.Type == batchv1.JobComplete || condition.Type == batchv1.JobFailed) && condition.Status == corev1.ConditionTrue && !condition.LastTransitionTime.IsZero() {
			return condition.LastTransitionTime
		}
	}
	return metav1.NewTime(fallback)
}

func (r *PRReviewJobV1Alpha2Reconciler) recordDispatchTiming(review *reviewv1alpha2.PRReviewJob, completedAt time.Time) {
	timing := operatorMetrics.DispatchTiming{
		ReceivedAt:       review.Spec.ReceivedAt.Time,
		CompletedAt:      completedAt,
		TerminalDeadline: review.Spec.TerminalDeadline.Time,
	}
	if review.Status.Timing != nil {
		if review.Status.Timing.ReceivedAt != nil {
			timing.ReceivedAt = review.Status.Timing.ReceivedAt.Time
		}
		if review.Status.Timing.JobCreatedAt != nil {
			timing.JobCreatedAt = review.Status.Timing.JobCreatedAt.Time
		}
		if review.Status.Timing.CompletedAt != nil {
			timing.CompletedAt = review.Status.Timing.CompletedAt.Time
		}
	}
	if review.Status.StartTime != nil {
		timing.JobCreatedAt = review.Status.StartTime.Time
	}
	operatorMetrics.RecordDispatchTiming(timing)
}

type workerAdmissionSnapshot struct {
	activeWorkers int
	olderWaiting  bool
}

// admissionSnapshot reads Jobs and, only when Job capacity remains, one
// authoritative PRReviewJobList. The same snapshot scan accounts for durable
// worker-creation reservations and FIFO waiting candidates; using the
// APIReader here is required because the manager cache can lag a persisted
// reservation or an older receipt.
// The CRD has no selectable phase field or active-state label. Keep this
// single authoritative read rather than sending an unsupported server-side
// selector or making a capacity decision from the stale informer cache.
func (r *PRReviewJobV1Alpha2Reconciler) admissionSnapshot(
	ctx context.Context,
	review *reviewv1alpha2.PRReviewJob,
	now time.Time,
	limit int,
) (workerAdmissionSnapshot, error) {
	reader := r.admissionReader()
	var jobs batchv1.JobList
	component, err := labels.NewRequirement("review-yeti.ai/component", selection.In, []string{
		job.ReceiptOnlyWorkerComponent,
		job.PublishingWorkerComponent,
	})
	if err != nil {
		return workerAdmissionSnapshot{}, fmt.Errorf("build Review Yeti worker selector: %w", err)
	}
	selector := labels.NewSelector().Add(*component)
	if err := reader.List(ctx, &jobs, client.InNamespace(review.Namespace), client.MatchingLabelsSelector{Selector: selector}); err != nil {
		return workerAdmissionSnapshot{}, err
	}
	active := 0
	visibleWorkers := make(map[string]struct{}, len(jobs.Items))
	for i := range jobs.Items {
		visibleWorkers[jobs.Items[i].Name] = struct{}{}
		if jobs.Items[i].Status.Succeeded == 0 && jobs.Items[i].Status.Failed == 0 {
			active++
		}
	}
	if active >= limit {
		return workerAdmissionSnapshot{activeWorkers: active}, nil
	}

	// WorkerCreationReserved is persisted before Job Create. If the response
	// or the cache observation is lost, the Job may still exist even though it
	// is absent from this list. Count valid nonterminal execution evidence as a
	// slot until the review's own reconcile observes its expected Job or makes
	// the guarded terminal missing-Job attempt. This is deliberately read-only;
	// sibling reconciliation must not repair the candidate's status. The same
	// authoritative list supplies FIFO evidence, so this admission performs only
	// one PRReviewJobList read and one candidate scan.
	var reviews reviewv1alpha2.PRReviewJobList
	if err := reader.List(ctx, &reviews, client.InNamespace(review.Namespace)); err != nil {
		return workerAdmissionSnapshot{}, err
	}
	olderWaiting := false
	for i := range reviews.Items {
		candidate := &reviews.Items[i]
		if !validWorkerAdmissionCandidate(candidate, now) {
			continue
		}
		if workerCreationWasAttempted(candidate) {
			if _, visible := visibleWorkers[candidate.Name+"-worker"]; !visible {
				active++
			}
		} else if candidate.Name != review.Name && admissionPrecedes(candidate, review) {
			olderWaiting = true
		}
		if active >= limit {
			break
		}
	}
	return workerAdmissionSnapshot{activeWorkers: active, olderWaiting: olderWaiting}, nil
}

func (r *PRReviewJobV1Alpha2Reconciler) admissionReader() client.Reader {
	if r.APIReader != nil {
		return r.APIReader
	}
	return r.Client
}

// getCachedThenLive centralizes the stale-cache boundary used for exact parent
// and worker identity reads. Only a cached NotFound may fall through to the
// uncached reader; all other errors retain their original semantics.
func (r *PRReviewJobV1Alpha2Reconciler) getCachedThenLive(
	ctx context.Context,
	key client.ObjectKey,
	object client.Object,
) error {
	err := r.Get(ctx, key, object)
	if apierrors.IsNotFound(err) && r.APIReader != nil {
		return r.APIReader.Get(ctx, key, object)
	}
	return err
}

func validWorkerAdmissionCandidate(review *reviewv1alpha2.PRReviewJob, now time.Time) bool {
	if review == nil || isTerminalPhase(review.Status.Phase) {
		return false
	}
	// Empty status is the initial, unmarked state of a newly projected review;
	// every other nonterminal state must be an explicitly supported waiting phase.
	if review.Status.Phase != "" && review.Status.Phase != reviewv1alpha2.PhaseQueued && review.Status.Phase != reviewv1alpha2.PhaseRunning {
		return false
	}
	// A sibling reconcile must never mutate an invalid or expired object, but it
	// must not let either one strand newer, otherwise valid admission candidates.
	if validateProjectionWindow(review) != nil || !now.Before(review.Spec.TerminalDeadline.Time) {
		return false
	}
	return true
}

// admissionPrecedes supplies a stable FIFO order even when two receipts share
// the same receivedAt value. ReceivedAt is immutable admission evidence;
// creation timestamp and name are only deterministic tie-breakers.
func admissionPrecedes(candidate, review *reviewv1alpha2.PRReviewJob) bool {
	if candidate.Spec.ReceivedAt.Time.Before(review.Spec.ReceivedAt.Time) {
		return true
	}
	if review.Spec.ReceivedAt.Time.Before(candidate.Spec.ReceivedAt.Time) {
		return false
	}
	if candidate.CreationTimestamp.Time.Before(review.CreationTimestamp.Time) {
		return true
	}
	if review.CreationTimestamp.Time.Before(candidate.CreationTimestamp.Time) {
		return false
	}
	return candidate.Name < review.Name
}

func (r *PRReviewJobV1Alpha2Reconciler) markWorkspaceUsed(ctx context.Context, review *reviewv1alpha2.PRReviewJob, now time.Time) error {
	pvcName := workspace.PVCName(review.Spec.RepositoryID, review.Spec.PRNumber)
	var pvc corev1.PersistentVolumeClaim
	if err := r.Get(ctx, types.NamespacedName{Namespace: review.Namespace, Name: pvcName}, &pvc); err != nil {
		if apierrors.IsNotFound(err) {
			return nil
		}
		return err
	}
	if pvc.Annotations == nil {
		pvc.Annotations = map[string]string{}
	}
	pvc.Annotations[workspace.LastUsedAtAnnotation] = now.UTC().Format(time.RFC3339Nano)
	return r.Update(ctx, &pvc)
}

// reconcileTerminalWorkspace keeps the PR-scoped PVC lifecycle moving after
// the worker Job has reached a terminal phase. The PVC is intentionally not
// owned by the review CR, so it must be reclaimed through the guarded
// workspace collector rather than Kubernetes owner-reference garbage
// collection. Idle workspaces are immediately eligible; bounded requeues keep
// cleanup moving while active Pods or Leases still protect the workspace.
func (r *PRReviewJobV1Alpha2Reconciler) reconcileTerminalWorkspace(
	ctx context.Context,
	review *reviewv1alpha2.PRReviewJob,
) (ctrl.Result, error) {
	if err := r.releaseTerminalWorkerObservation(ctx, review); err != nil {
		return ctrl.Result{}, err
	}
	activePod, err := r.hasActiveReviewWorkerPod(ctx, review)
	if err != nil {
		return ctrl.Result{}, err
	}
	if activePod {
		return ctrl.Result{RequeueAfter: v1Alpha2RequeueAfter}, nil
	}
	if err := workspace.NewLeaseManager(r.Client).Release(
		ctx,
		review.Namespace,
		review.Spec.RepositoryID,
		review.Spec.PRNumber,
		review.Spec.RunID,
		r.clock(),
	); err != nil && !errors.Is(err, workspace.ErrLeaseHeld) {
		return ctrl.Result{}, err
	}

	if review.Spec.RunnerMode != "generic" {
		return ctrl.Result{}, nil
	}

	pvcName := workspace.PVCName(review.Spec.RepositoryID, review.Spec.PRNumber)
	if pvcName == "" {
		return ctrl.Result{}, nil
	}
	var pvc corev1.PersistentVolumeClaim
	if err := r.Get(ctx, types.NamespacedName{Namespace: review.Namespace, Name: pvcName}, &pvc); err != nil {
		if apierrors.IsNotFound(err) {
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, err
	}
	result, err := workspace.NewCollector(r.Client).Reclaim(
		ctx,
		&pvc,
		review.Namespace,
		review.Spec.RepositoryID,
		review.Spec.PRNumber,
		r.clock(),
	)
	if err != nil {
		return ctrl.Result{}, err
	}
	if result.RequeueAfter > 0 {
		return ctrl.Result{RequeueAfter: result.RequeueAfter}, nil
	}
	if result.Reason == workspace.RetainedActivePod {
		return ctrl.Result{RequeueAfter: v1Alpha2RequeueAfter}, nil
	}
	if result.Reason == workspace.RetainedActiveLease {
		if err := workspace.NewLeaseManager(r.Client).Release(
			ctx,
			review.Namespace,
			review.Spec.RepositoryID,
			review.Spec.PRNumber,
			review.Spec.RunID,
			r.clock(),
		); err != nil && !errors.Is(err, workspace.ErrLeaseHeld) {
			return ctrl.Result{}, err
		}
		return ctrl.Result{RequeueAfter: v1Alpha2RequeueAfter}, nil
	}
	return ctrl.Result{}, nil
}

// releaseTerminalWorkerObservation runs only after the parent CR already has a
// terminal phase. Removing the guard in a later reconcile keeps the ordering
// durable across status-update conflicts, operator crashes, and TTL deletion.
func (r *PRReviewJobV1Alpha2Reconciler) releaseTerminalWorkerObservation(
	ctx context.Context,
	review *reviewv1alpha2.PRReviewJob,
) error {
	var worker batchv1.Job
	err := r.getCachedThenLive(ctx, types.NamespacedName{Namespace: review.Namespace, Name: review.Name + "-worker"}, &worker)
	if apierrors.IsNotFound(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if !controllerutil.ContainsFinalizer(&worker, terminalOutcomeFinalizer) {
		return nil
	}
	if !metav1.IsControlledBy(&worker, review) {
		return nil
	}
	controllerutil.RemoveFinalizer(&worker, terminalOutcomeFinalizer)
	return r.Update(ctx, &worker)
}

func (r *PRReviewJobV1Alpha2Reconciler) hasActiveReviewWorkerPod(ctx context.Context, review *reviewv1alpha2.PRReviewJob) (bool, error) {
	var pods corev1.PodList
	if err := r.List(ctx, &pods, client.InNamespace(review.Namespace), client.MatchingLabels{
		"review-yeti.ai/run-id":    review.Spec.RunID,
		"review-yeti.ai/component": job.WorkerComponentFor(review.Spec.PublicationMode, review.Spec.QualificationProfile),
	}); err != nil {
		return false, err
	}
	for index := range pods.Items {
		phase := pods.Items[index].Status.Phase
		if phase != corev1.PodSucceeded && phase != corev1.PodFailed {
			return true, nil
		}
	}
	return false, nil
}

// Contract-mismatched Jobs cannot be trusted to retain the admitted run or
// component labels used by the normal indexed lookup. Once exact ownership has
// been established, scan the namespace and bind Pods to the Job name/UID so a
// tampered label cannot make terminal cleanup race a still-running process.
func (r *PRReviewJobV1Alpha2Reconciler) hasActiveWorkerJobPod(ctx context.Context, worker *batchv1.Job) (bool, error) {
	var pods corev1.PodList
	if err := r.List(ctx, &pods, client.InNamespace(worker.Namespace)); err != nil {
		return false, err
	}
	for index := range pods.Items {
		pod := &pods.Items[index]
		if !podBelongsToWorkerJob(pod, worker) {
			continue
		}
		if pod.Status.Phase != corev1.PodSucceeded && pod.Status.Phase != corev1.PodFailed {
			return true, nil
		}
	}
	return false, nil
}

func (r *PRReviewJobV1Alpha2Reconciler) setPhase(ctx context.Context, review *reviewv1alpha2.PRReviewJob, phase reviewv1alpha2.PRReviewJobPhase, reason, message string) error {
	review.Status.Phase = phase
	review.Status.ObservedGeneration = review.Generation
	review.Status.Message = message
	meta.SetStatusCondition(&review.Status.Conditions, metav1.Condition{
		Type:               "Ready",
		Status:             metav1.ConditionTrue,
		Reason:             reason,
		Message:            message,
		ObservedGeneration: review.Generation,
		LastTransitionTime: metav1.Now(),
	})
	return r.Status().Update(ctx, review)
}

func (r *PRReviewJobV1Alpha2Reconciler) fail(ctx context.Context, review *reviewv1alpha2.PRReviewJob, reason, message string) error {
	return r.setPhase(ctx, review, reviewv1alpha2.PhaseFailed, reason, message)
}

func (r *PRReviewJobV1Alpha2Reconciler) failWorkerContractMismatch(
	ctx context.Context,
	review *reviewv1alpha2.PRReviewJob,
	worker *batchv1.Job,
	message string,
) (ctrl.Result, error) {
	if review.Spec.PublicationMode == job.PublicationModeAppGate {
		// Persist the publication obligation before stopping a tampered child. A
		// later pending-state reconcile owns deletion, Pod drain, and delegation;
		// a failed status write therefore cannot erase the only execution evidence.
		return r.startFailurePublication(ctx, review, "WorkerContractMismatch", message)
	}
	if worker != nil && worker.Labels["review-yeti.ai/run-id"] == review.Spec.RunID && metav1.IsControlledBy(worker, review) {
		if err := r.Delete(ctx, worker, client.PropagationPolicy(metav1.DeletePropagationBackground)); err != nil && !apierrors.IsNotFound(err) {
			return ctrl.Result{}, err
		}
		message += "; stopped the owned worker Job"
	}
	return ctrl.Result{}, r.fail(ctx, review, "WorkerContractMismatch", message)
}

func (r *PRReviewJobV1Alpha2Reconciler) clock() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	return time.Now().UTC()
}

func validateProjectionWindow(review *reviewv1alpha2.PRReviewJob) error {
	window := review.Spec.TerminalDeadline.Sub(review.Spec.ReceivedAt.Time)
	if window < time.Duration(job.MinTerminalDeadlineSeconds)*time.Second || window > time.Duration(job.MaxTerminalDeadlineSeconds)*time.Second {
		return errors.New("terminal deadline must be between 15 and 60 minutes after receivedAt")
	}
	if review.Namespace != job.Namespace {
		return fmt.Errorf("review must run in namespace %q", job.Namespace)
	}
	return nil
}

func isTerminalPhase(phase reviewv1alpha2.PRReviewJobPhase) bool {
	return phase == reviewv1alpha2.PhaseSucceeded || phase == reviewv1alpha2.PhaseFailed || phase == reviewv1alpha2.PhaseExpired
}

func managedWorkerJobMatches(review *reviewv1alpha2.PRReviewJob, worker *batchv1.Job) bool {
	if worker == nil || worker.Namespace != review.Namespace || worker.Name != review.Name+"-worker" {
		return false
	}
	// The label must track the review's own publication mode. Hardcoding "disabled"
	// predates the app-gate lane and would reject every publishing Job the builder
	// produces -- and a rejected Job is DELETED by failWorkerContractMismatch, so the
	// operator would destroy each publishing worker it had just created.
	if worker.Labels["review-yeti.ai/run-id"] != review.Spec.RunID ||
		worker.Labels["review-yeti.ai/publication-mode"] != review.Spec.PublicationMode {
		return false
	}
	if worker.Spec.BackoffLimit == nil || *worker.Spec.BackoffLimit != 0 || worker.Spec.Parallelism == nil || *worker.Spec.Parallelism != 1 || worker.Spec.Completions == nil || *worker.Spec.Completions != 1 {
		return false
	}
	if len(worker.Spec.Template.Spec.Containers) != 1 {
		return false
	}
	container := worker.Spec.Template.Spec.Containers[0]
	if container.Image != review.Spec.WorkerImage || container.ImagePullPolicy != corev1.PullIfNotPresent {
		return false
	}
	if !managedWorkerEnvMatches(review, container.Env) {
		return false
	}
	if worker.Spec.Template.Spec.AutomountServiceAccountToken == nil || *worker.Spec.Template.Spec.AutomountServiceAccountToken {
		return false
	}
	if review.Spec.RunnerMode == "generic" {
		for _, volume := range worker.Spec.Template.Spec.Volumes {
			if volume.Name == "workspace" && volume.PersistentVolumeClaim != nil {
				return volume.PersistentVolumeClaim.ClaimName == workspace.PVCName(review.Spec.RepositoryID, review.Spec.PRNumber)
			}
		}
		return false
	}
	expectedLimit := job.WorkerStorageSize()
	for _, volume := range worker.Spec.Template.Spec.Volumes {
		if volume.Name == "workspace" && volume.EmptyDir != nil {
			if volume.EmptyDir.SizeLimit != nil && volume.EmptyDir.SizeLimit.Equal(expectedLimit) {
				return true
			}
		}
	}
	return false
}

func managedWorkerEnvMatches(review *reviewv1alpha2.PRReviewJob, env []corev1.EnvVar) bool {
	receiptOnly := envValue(env, job.ReceiptOnlyEnv)
	fullPanel := envValue(env, job.FullPanelQualificationEnv)
	sameHead := envValue(env, job.SameHeadQualificationEnv)
	model := envValue(env, job.QualificationModelEnv)
	if review.Spec.QualificationProfile == job.FullPanelQualificationProfile {
		if receiptOnly != "" || fullPanel != "true" || sameHead != "" || model != review.Spec.QualificationModel {
			return false
		}
		secretRefs := 0
		for _, variable := range env {
			if variable.Name != "OPENROUTER_API_KEY" {
				continue
			}
			secretRefs++
			if variable.ValueFrom == nil || variable.ValueFrom.SecretKeyRef == nil ||
				variable.ValueFrom.SecretKeyRef.Name != review.Spec.RunSecretName || variable.ValueFrom.SecretKeyRef.Key != "OPENROUTER_API_KEY" {
				return false
			}
		}
		return secretRefs == 1
	}
	if review.Spec.QualificationProfile == job.SameHeadQualificationProfile {
		if receiptOnly != "" || fullPanel != "" || sameHead != "true" || model != review.Spec.QualificationModel {
			return false
		}
		openRouterRefs := 0
		githubRefs := 0
		for _, variable := range env {
			switch variable.Name {
			case "OPENROUTER_API_KEY":
				openRouterRefs++
				if variable.ValueFrom == nil || variable.ValueFrom.SecretKeyRef == nil ||
					variable.ValueFrom.SecretKeyRef.Name != review.Spec.RunSecretName || variable.ValueFrom.SecretKeyRef.Key != "OPENROUTER_API_KEY" {
					return false
				}
			case "GH_TOKEN":
				githubRefs++
				if variable.ValueFrom == nil || variable.ValueFrom.SecretKeyRef == nil ||
					variable.ValueFrom.SecretKeyRef.Name != review.Spec.RunSecretName || variable.ValueFrom.SecretKeyRef.Key != "GITHUB_READ_TOKEN" {
					return false
				}
			case "GITHUB_TOKEN", "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_INSTALLATION_ID":
				return false
			}
		}
		return openRouterRefs == 1 && githubRefs == 1
	}
	if review.Spec.PublicationMode == job.PublicationModeAppGate {
		// The publishing lane is not receipt-only and carries no qualification
		// markers. It reads its gateway key and a repository-scoped publish token,
		// and -- as with the same-head lane -- must never be handed App credentials:
		// this pod parses untrusted pull-request diffs and executes model output.
		if receiptOnly != "" || fullPanel != "" || sameHead != "" || model != "" {
			return false
		}
		publishRefs := 0
		githubRefs := 0
		for _, variable := range env {
			switch variable.Name {
			case "GITHUB_PUBLISH_TOKEN":
				publishRefs++
				if variable.ValueFrom == nil || variable.ValueFrom.SecretKeyRef == nil ||
					variable.ValueFrom.SecretKeyRef.Name != review.Spec.RunSecretName ||
					variable.ValueFrom.SecretKeyRef.Key != "GITHUB_PUBLISH_TOKEN" {
					return false
				}
			case "GH_TOKEN":
				githubRefs++
				if variable.ValueFrom == nil || variable.ValueFrom.SecretKeyRef == nil ||
					variable.ValueFrom.SecretKeyRef.Name != review.Spec.RunSecretName ||
					variable.ValueFrom.SecretKeyRef.Key != "GITHUB_READ_TOKEN" {
					return false
				}
			case "GITHUB_TOKEN", "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_INSTALLATION_ID", "OPENROUTER_API_KEY":
				return false
			}
		}
		return publishRefs == 1 && githubRefs == 1
	}
	if receiptOnly != "true" || fullPanel != "" || sameHead != "" || model != "" {
		return false
	}
	for _, variable := range env {
		if variable.Name == "OPENROUTER_API_KEY" || variable.Name == "GH_TOKEN" {
			return false
		}
	}
	return true
}

func envValue(env []corev1.EnvVar, name string) string {
	for _, variable := range env {
		if variable.Name == name {
			return variable.Value
		}
	}
	return ""
}

func timePtr(value metav1.Time) *metav1.Time { return &value }

// SetupWithManager registers only the v1alpha2 projection and its owned Jobs.
// PVCs are intentionally not owned because their lifecycle is PR-scoped.
func (r *PRReviewJobV1Alpha2Reconciler) SetupWithManager(mgr ctrl.Manager) error {
	if r.APIReader == nil {
		r.APIReader = mgr.GetAPIReader()
	}
	return ctrl.NewControllerManagedBy(mgr).
		For(&reviewv1alpha2.PRReviewJob{}).
		Owns(&batchv1.Job{}).
		// Serializing admission makes the API-backed active-job count an
		// effective account-wide worker gate. Leader election in main.go ensures
		// only one operator instance performs this admission at a time.
		WithOptions(controller.Options{MaxConcurrentReconciles: 1}).
		Complete(r)
}
