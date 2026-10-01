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
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	coordinationv1 "k8s.io/api/coordination/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/selection"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/record"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/log"

	reviewv1alpha2 "github.com/calltelemetry/ct-review-bot/k8s-operator/api/v1alpha2"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/job"
	operatorMetrics "github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/metrics"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/workspace"
)

const (
	DefaultV1Alpha2MaxConcurrentJobs       = 1
	DefaultV1Alpha2MaxConcurrentReconciles = 4
	MaxV1Alpha2ReconcileConcurrencyCap     = 64
	v1Alpha2RequeueAfter                   = 5 * time.Second
	v1Alpha2PVCCreateRequeue               = 1 * time.Second
	workerCreationReserved           = "WorkerCreationReserved"
	terminalOutcomeFinalizer         = "review-yeti.ai/terminal-outcome"
	failurePublicationCondition      = "FailurePublication"

	ConditionFencingEpochMismatch = reviewv1alpha2.ConditionFencingEpochMismatch
	ConditionStaleWorkerLease     = reviewv1alpha2.ConditionStaleWorkerLease
	// runSecretCleanupFinalizer guards the per-run Secret named by
	// spec.runSecretName. The TypeScript dispatcher creates that Secret before
	// this resource exists (so it can never carry an ownerReference back to a
	// PRReviewJob that isn't admitted yet), and its own RBAC intentionally
	// stops at get/create on Secrets: a patch verb would let a compromised
	// dispatcher process (it already holds the GitHub App key) overwrite any
	// credential Secret in the namespace, not just its own run Secret. The
	// operator has get/delete (not list/watch/patch) on Secrets: delete cleans
	// up the exact named run Secret, while an uncached get reads that same
	// Secret's publish token to verify its durable completion receipt. RBAC
	// alone cannot constrain dynamic Secret names, so the exact-name check is
	// load-bearing; a compromised operator identity could read other named
	// Secrets in the namespace.
	runSecretCleanupFinalizer = "review-yeti.ai/run-secret-cleanup"
)

// PRReviewJobV1Alpha2Reconciler is the disabled-by-default receipt-only
// execution controller. It owns only Jobs; PR-scoped workspace PVCs are
// deliberately ownerless so they can be reused by later heads of the same PR.
// PostgreSQL remains the lifecycle and publication authority.
type PRReviewJobV1Alpha2Reconciler struct {
	client.Client
	// Confirm cached Job misses before treating an execution as lost.
	APIReader client.Reader
	// SecretReader must be the manager's uncached APIReader. The operator Role
	// deliberately has get/delete but no list/watch on Secrets, so an
	// informer-backed client must never be used for the publish credential.
	SecretReader      client.Reader
	Scheme            *runtime.Scheme
	Now               func() time.Time
	MaxConcurrentJobs int
	// MaxConcurrentReconciles allows parallel worker reconciliation (default 1).
	MaxConcurrentReconciles int
	// Publishing configures the app-gate lane. Left zero, BuildWorkerJob refuses
	// every app-gate review -- deliberately, since this lane fails closed and a
	// half-configured transport must not reach a running worker.
	Publishing job.PublishingConfig
	// ReceiptHTTPClient permits a verified test CA for the trusted dispatch
	// status lookup. A nil value uses Go's system-root TLS transport. Redirects
	// and the request deadline are constrained by the lookup itself.
	ReceiptHTTPClient *http.Client
	// ReceiptCoordinator manages non-blocking, asynchronous receipt retrieval and caching.
	ReceiptCoordinator *AppGateReceiptCoordinator
	coordinatorOnce    sync.Once
	// Recorder is optional. When set, a Forbidden run-Secret delete surfaces as
	// a warning Event on the PRReviewJob in addition to the log line; nil is
	// tolerated so unit tests do not need to wire a fake recorder.
	Recorder record.EventRecorder

	// CapacityLedger manages declarative, atomic CAS worker admission via
	// coordination.k8s.io/v1 Lease in ct-review-system, eliminating in-memory mutexes.
	CapacityLedger *CapacityLedger
}

// +kubebuilder:rbac:groups=review-yeti.ai,resources=prreviewjobs,verbs=get;list;watch;update;patch;delete
// +kubebuilder:rbac:groups=review-yeti.ai,resources=prreviewjobs/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=batch,resources=jobs,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=pods,verbs=get;list;watch
// +kubebuilder:rbac:groups="",resources=persistentvolumeclaims,verbs=get;list;watch;create;update;patch
// +kubebuilder:rbac:groups=coordination.k8s.io,resources=leases,verbs=get;list;watch;create;update;patch
// +kubebuilder:rbac:groups="",resources=secrets,verbs=get;delete
// Reconcile converts optimistic-concurrency write conflicts into a quiet,
// metric-counted requeue (REL-903). The single shared policy lives in
// conflictRequeue.go so the v1alpha1 and v1alpha2 reconcilers cannot diverge.
func (r *PRReviewJobV1Alpha2Reconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	result, err := r.reconcile(ctx, req)
	return conflictRequeue(result, err)
}

func (r *PRReviewJobV1Alpha2Reconciler) getCapacityLedger() *CapacityLedger {
	if r.CapacityLedger != nil {
		if r.CapacityLedger.Now == nil {
			r.CapacityLedger.Now = r.clock
		}
		if r.CapacityLedger.Reader == nil {
			r.CapacityLedger.Reader = r.admissionReader()
		}
		return r.CapacityLedger
	}
	ledger := NewCapacityLedger(r.Client, DefaultCapacityLedgerNamespace)
	ledger.Reader = r.admissionReader()
	ledger.Now = r.clock
	return ledger
}

func (r *PRReviewJobV1Alpha2Reconciler) getReceiptCoordinator() *AppGateReceiptCoordinator {
	r.coordinatorOnce.Do(func() {
		if r.ReceiptCoordinator == nil {
			r.ReceiptCoordinator = NewAppGateReceiptCoordinator(r)
		}
	})
	return r.ReceiptCoordinator
}

func (r *PRReviewJobV1Alpha2Reconciler) forgetReceipt(namespace, name string) {
	if coord := r.getReceiptCoordinator(); coord != nil {
		coord.ForgetReview(namespace, name)
	}
}

func (r *PRReviewJobV1Alpha2Reconciler) reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	var review reviewv1alpha2.PRReviewJob
	err := r.getCachedThenLive(ctx, req.NamespacedName, &review)
	if err != nil {
		if apierrors.IsNotFound(err) {
			_ = r.getCapacityLedger().ReleaseSlotByName(ctx, req.Namespace, req.Name)
			r.forgetReceipt(req.Namespace, req.Name)
			return ctrl.Result{}, r.releaseOrphanedWorkerObservation(ctx, req)
		}
		return ctrl.Result{}, err
	}

	// A terminating PRReviewJob (deleted by this controller's own
	// reconcileTerminalDeletion, or by anything else -- kubectl, a namespace
	// teardown) must not re-enter the normal admission/execution machinery
	// below. Route it to the run-Secret cleanup path and return; every other
	// branch in this function assumes a review that is not being deleted.
	if review.DeletionTimestamp != nil {
		_ = r.getCapacityLedger().ReleaseSlot(ctx, &review)
		r.forgetReceipt(review.Namespace, review.Name)
		return r.reconcileRunSecretDeletion(ctx, &review)
	}
	// Attach the cleanup guard as early as possible so no admission window
	// exists where a review could be deleted (by anyone) before the finalizer
	// is recorded. This mirrors -- but is independent of -- how the worker Job
	// below acquires terminalOutcomeFinalizer: added inline, no early return,
	// because reconcile must still make forward progress in the same pass.
	//
	// This must be a metadata-only merge patch (client.MergeFrom), never a
	// full Update: the CRD enforces `self == oldSelf` on spec, and a full
	// Update round-trips the stored spec through the current Go types, which
	// can change its serialized shape (fields without omitempty gain zero
	// values, unknown fields are dropped) even when nothing in spec logically
	// changed. That exact round-trip drift made a full Update here fail in
	// production against a legacy-shaped resource with "PRReviewJob spec is
	// immutable". A MergeFrom patch body is the JSON diff between the pre-
	// and post-mutation object; since only metadata.finalizers changed here,
	// spec is entirely absent from the diff and the API server never
	// evaluates the immutability rule against it.
	if review.Spec.RunSecretName != "" && !controllerutil.ContainsFinalizer(&review, runSecretCleanupFinalizer) {
		base := review.DeepCopy()
		controllerutil.AddFinalizer(&review, runSecretCleanupFinalizer)
		if err := r.Patch(ctx, &review, client.MergeFrom(base)); err != nil {
			// A failure to attach this guard must not block the review: the
			// run Secret it protects only leaks until the out-of-band
			// retention sweep reclaims it (bounded), whereas returning an
			// error here would stall admission -- and the worker Job with it
			// -- indefinitely. Log it, emit a warning Event when a recorder
			// is wired, and keep reconciling. The in-memory finalizer is
			// deliberately left alone: nothing later in this pass reads it
			// (the only readers are in the deletion path, which returns
			// before this branch), and every later write to the review goes
			// through the status subresource, which ignores metadata, so it
			// can never be persisted by accident. The next reconcile re-reads
			// the stored object and retries the patch.
			log.FromContext(ctx).Error(err, "failed to attach run-secret cleanup finalizer; continuing reconciliation without it",
				"review", review.Name, "namespace", review.Namespace)
			if r.Recorder != nil {
				r.Recorder.Eventf(&review, corev1.EventTypeWarning, "RunSecretFinalizerAttachFailed",
					"failed to attach the run-secret cleanup finalizer; the run Secret will not be cleaned up by this controller unless a later reconcile succeeds: %v", err)
			}
		}
	}

	if failurePublicationPending(&review) {
		return r.reconcileFailurePublication(ctx, &review)
	}
	if isTerminalPhase(review.Status.Phase) {
		_ = r.getCapacityLedger().ReleaseSlot(ctx, &review)
		r.forgetReceipt(review.Namespace, review.Name)
		return r.reconcileTerminalWorkspace(ctx, &review)
	}
	if review.Spec.CancelRequested != nil && *review.Spec.CancelRequested {
		return r.reconcileCancellation(ctx, &review)
	}
	now := r.clock()
	if err := validateProjectionWindow(&review); err != nil {
		// Same class as WorkerContractRejected below: the projection is rejected
		// before any worker Job is ever built, so an app-gate review must still be
		// delegated rather than left for the 30-minute deadline reaper to notice.
		if review.Spec.PublicationMode == job.PublicationModeAppGate {
			return r.startFailurePublication(ctx, &review, "InvalidProjection", err.Error())
		}
		return ctrl.Result{}, r.fail(ctx, &review, "InvalidProjection", err.Error())
	}
	if _, err := observeTiming(&review, reviewv1alpha2.DispatchStageReceived, review.Spec.ReceivedAt); err != nil {
		return ctrl.Result{}, r.fail(ctx, &review, "TimingContractViolation", err.Error())
	}
	if !now.Before(review.Spec.TerminalDeadline.Time) {
		return r.reconcileElapsedDeadline(ctx, &review, now)
	}

	// =========================================================================
	// FENCING & LEASE FAIL-CLOSED RECONCILIATION (API-3330 / Requirement R2)
	// =========================================================================
	if terminal, result, err := r.reconcileFencingAndLease(ctx, &review, now); terminal {
		return result, err
	}

	if isAwaitingResumption(&review) {
		if !isContinuationRequested(&review) {
			// Prep pod finished cleanly and was collected to reclaim quota; review is awaiting model inference resumption.
			return ctrl.Result{}, nil
		}

		continuationJobName := review.Name + "-continuation"
		var existing batchv1.Job
		existingErr := r.getCachedThenLive(ctx, types.NamespacedName{Namespace: review.Namespace, Name: continuationJobName}, &existing)
		if existingErr == nil {
			meta.SetStatusCondition(&review.Status.Conditions, metav1.Condition{
				Type:               reviewv1alpha2.ConditionAwaitingResumption,
				Status:             metav1.ConditionFalse,
				Reason:             "Resumed",
				Message:            "continuation phase resumed",
				ObservedGeneration: review.Generation,
				LastTransitionTime: metav1.NewTime(now),
			})
			review.Status.Phase = reviewv1alpha2.PhaseRunning
			review.Status.JobName = continuationJobName
			return r.reconcileExistingJob(ctx, &review, &existing, now)
		}

		return r.admitAndResumeContinuationWorker(ctx, &review, now)
	}

	workerName := resolveWorkerJobName(&review)
	var existing batchv1.Job
	existingErr := r.getCachedThenLive(ctx, types.NamespacedName{Namespace: review.Namespace, Name: workerName}, &existing)
	if existingErr != nil && !apierrors.IsNotFound(existingErr) {
		return ctrl.Result{}, existingErr
	}
	if existingErr == nil {
		if !managedWorkerJobMatches(&review, &existing) {
			return r.failWorkerContractMismatch(ctx, &review, &existing, workerContractMessage(&review, "existing"))
		}
		// Adopt Jobs created by an older operator before observing their state.
		// Terminal Jobs need the guard too: a parent status conflict must not let
		// immediate TTL collection erase the authoritative outcome between retries.
		if existing.DeletionTimestamp == nil && !controllerutil.ContainsFinalizer(&existing, terminalOutcomeFinalizer) {
			controllerutil.AddFinalizer(&existing, terminalOutcomeFinalizer)
			// NotFound here means the Job (already read live above, moments
			// earlier) raced a delete before this guard could attach. There is
			// nothing left to protect, and `existing` still carries the
			// terminal Status observed by that read, so fall through to
			// reconcileExistingJob instead of discarding it behind an error
			// that would otherwise misreport a completed run as
			// WorkerJobMissing on the next reconcile.
			if err := r.Update(ctx, &existing); err != nil && !apierrors.IsNotFound(err) {
				return ctrl.Result{}, err
			}
		}
		return r.reconcileExistingJob(ctx, &review, &existing, now)
	}
	if workerCreationWasAttempted(&review) {
		cond := meta.FindStatusCondition(review.Status.Conditions, workerCreationReserved)
		if cond != nil && cond.Status == metav1.ConditionTrue && !cond.LastTransitionTime.IsZero() &&
			review.Status.JobName == "" && review.Status.Phase != reviewv1alpha2.PhaseRunning &&
			now.Sub(cond.LastTransitionTime.Time) < 30*time.Second {
			return ctrl.Result{RequeueAfter: 2 * time.Second}, nil
		}
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

	return r.admitAndCreateWorker(ctx, &review, now)
}

func (r *PRReviewJobV1Alpha2Reconciler) queueForCapacity(
	ctx context.Context,
	review *reviewv1alpha2.PRReviewJob,
	now time.Time,
	message string,
) (ctrl.Result, error) {
	meta.SetStatusCondition(&review.Status.Conditions, metav1.Condition{
		Type:               "CapacityExceeded",
		Status:             metav1.ConditionTrue,
		Reason:             "CapacityExceeded",
		Message:            message,
		ObservedGeneration: review.Generation,
		LastTransitionTime: metav1.NewTime(now),
	})
	if err := r.setPhase(ctx, review, reviewv1alpha2.PhaseQueued, "CapacityExceeded", message); err != nil {
		return ctrl.Result{}, err
	}
	return ctrl.Result{RequeueAfter: v1Alpha2RequeueAfter}, nil
}

func (r *PRReviewJobV1Alpha2Reconciler) admitAndResumeContinuationWorker(
	ctx context.Context,
	review *reviewv1alpha2.PRReviewJob,
	now time.Time,
) (ctrl.Result, error) {
	limit := r.MaxConcurrentJobs
	if limit <= 0 {
		limit = DefaultV1Alpha2MaxConcurrentJobs
	}
	admission, err := r.admissionSnapshot(ctx, review, now, limit)
	if err != nil {
		return ctrl.Result{}, err
	}
	if admission.activeWorkers >= limit {
		if !meta.IsStatusConditionTrue(review.Status.Conditions, reviewv1alpha2.ConditionAwaitingResumption) {
			meta.SetStatusCondition(&review.Status.Conditions, metav1.Condition{
				Type:               reviewv1alpha2.ConditionAwaitingResumption,
				Status:             metav1.ConditionTrue,
				Reason:             "PrepCompleted",
				Message:            "prep phase completed, awaiting model resumption",
				ObservedGeneration: review.Generation,
				LastTransitionTime: metav1.NewTime(now),
			})
		}
		return r.queueForCapacity(ctx, review, now, fmt.Sprintf("waiting for one of %d worker slots", limit))
	}
	if admission.olderWaiting {
		if !meta.IsStatusConditionTrue(review.Status.Conditions, reviewv1alpha2.ConditionAwaitingResumption) {
			meta.SetStatusCondition(&review.Status.Conditions, metav1.Condition{
				Type:               reviewv1alpha2.ConditionAwaitingResumption,
				Status:             metav1.ConditionTrue,
				Reason:             "PrepCompleted",
				Message:            "prep phase completed, awaiting model resumption",
				ObservedGeneration: review.Generation,
				LastTransitionTime: metav1.NewTime(now),
			})
		}
		return r.queueForCapacity(ctx, review, now, "waiting for an older worker admission candidate")
	}

	acquired, err := r.getCapacityLedger().AcquireSlot(ctx, review, limit)
	if err != nil {
		return ctrl.Result{}, err
	}
	if !acquired {
		if !meta.IsStatusConditionTrue(review.Status.Conditions, reviewv1alpha2.ConditionAwaitingResumption) {
			meta.SetStatusCondition(&review.Status.Conditions, metav1.Condition{
				Type:               reviewv1alpha2.ConditionAwaitingResumption,
				Status:             metav1.ConditionTrue,
				Reason:             "PrepCompleted",
				Message:            "prep phase completed, awaiting model resumption",
				ObservedGeneration: review.Generation,
				LastTransitionTime: metav1.NewTime(now),
			})
		}
		return r.queueForCapacity(ctx, review, now, fmt.Sprintf("waiting for one of %d worker slots", limit))
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
		_ = r.getCapacityLedger().ReleaseSlot(ctx, review)
		if errors.Is(err, workspace.ErrLeaseHeld) || errors.Is(err, workspace.ErrLeaseTakeoverNotAuthorized) {
			if !meta.IsStatusConditionTrue(review.Status.Conditions, reviewv1alpha2.ConditionAwaitingResumption) {
				meta.SetStatusCondition(&review.Status.Conditions, metav1.Condition{
					Type:               reviewv1alpha2.ConditionAwaitingResumption,
					Status:             metav1.ConditionTrue,
					Reason:             "PrepCompleted",
					Message:            "prep phase completed, awaiting model resumption",
					ObservedGeneration: review.Generation,
					LastTransitionTime: metav1.NewTime(now),
				})
			}
			if statusErr := r.setPhase(ctx, review, reviewv1alpha2.PhaseQueued, "WorkspaceBusy", "waiting for the previous PR worker to release its workspace lease"); statusErr != nil {
				return ctrl.Result{}, statusErr
			}
			return ctrl.Result{RequeueAfter: v1Alpha2RequeueAfter}, nil
		}
		return ctrl.Result{}, r.fail(ctx, review, "WorkspaceLeaseRejected", err.Error())
	}

	if review.Spec.WorkerLeaseToken != "" {
		review.Status.ActiveWorkerLeaseToken = review.Spec.WorkerLeaseToken
	} else if leaseResult.Lease != nil && leaseResult.Lease.Spec.LeaseTransitions != nil {
		review.Status.ActiveWorkerLeaseToken = fmt.Sprintf("%d", *leaseResult.Lease.Spec.LeaseTransitions)
	}

	worker, err := job.BuildWorkerJob(job.Input{
		Review:           review,
		WorkspacePVCName: "",
		WorkspaceLease:   leaseResult,
		Now:              now,
		Publishing:       r.Publishing,
		Phase:            job.JobPhaseContinuation,
	})
	if err == nil && len(worker.Spec.Template.Spec.Containers) > 0 {
		container := &worker.Spec.Template.Spec.Containers[0]
		if review.Spec.LogicalChildID != "" {
			container.Env = append(container.Env, corev1.EnvVar{Name: "CT_LOGICAL_CHILD_ID", Value: review.Spec.LogicalChildID})
		}
		if review.Spec.FencingEpoch > 0 {
			container.Env = append(container.Env, corev1.EnvVar{Name: "CT_FENCING_EPOCH", Value: strconv.FormatInt(review.Spec.FencingEpoch, 10)})
		}
		if review.Spec.WorkerLeaseToken != "" {
			container.Env = append(container.Env, corev1.EnvVar{Name: "CT_WORKER_LEASE_TOKEN", Value: review.Spec.WorkerLeaseToken})
		}
	}
	if err != nil {
		_ = r.getCapacityLedger().ReleaseSlot(ctx, review)
		if releaseErr := workspace.NewLeaseManager(r.Client).Release(ctx, review.Namespace, review.Spec.RepositoryID, review.Spec.PRNumber, review.Spec.RunID, now); releaseErr != nil {
			return ctrl.Result{}, releaseErr
		}
		if review.Spec.PublicationMode == job.PublicationModeAppGate {
			return r.startFailurePublication(ctx, review, "WorkerContractRejected", err.Error())
		}
		return ctrl.Result{}, r.fail(ctx, review, "WorkerContractRejected", err.Error())
	}
	if r.Scheme != nil {
		if err := controllerutil.SetControllerReference(review, worker, r.Scheme); err != nil {
			_ = r.getCapacityLedger().ReleaseSlot(ctx, review)
			if releaseErr := workspace.NewLeaseManager(r.Client).Release(ctx, review.Namespace, review.Spec.RepositoryID, review.Spec.PRNumber, review.Spec.RunID, now); releaseErr != nil {
				return ctrl.Result{}, releaseErr
			}
			return ctrl.Result{}, err
		}
	}
	controllerutil.AddFinalizer(worker, terminalOutcomeFinalizer)
	meta.SetStatusCondition(&review.Status.Conditions, metav1.Condition{
		Type:               reviewv1alpha2.ConditionAwaitingResumption,
		Status:             metav1.ConditionFalse,
		Reason:             "Resumed",
		Message:            "continuation phase resumed",
		ObservedGeneration: review.Generation,
		LastTransitionTime: metav1.NewTime(now),
	})
	meta.SetStatusCondition(&review.Status.Conditions, metav1.Condition{
		Type:               workerCreationReserved,
		Status:             metav1.ConditionTrue,
		Reason:             "CreateAttemptReserved",
		Message:            "worker Job creation is reserved; outcome has not yet been observed",
		ObservedGeneration: review.Generation,
		LastTransitionTime: metav1.NewTime(now),
	})
	if err := r.Status().Update(ctx, review); err != nil {
		return ctrl.Result{}, err
	}
	if err := ctx.Err(); err != nil {
		return ctrl.Result{}, err
	}
	if err := r.Create(ctx, worker); err != nil {
		if !apierrors.IsAlreadyExists(err) {
			return ctrl.Result{}, err
		}
		var existingJob batchv1.Job
		if getErr := r.Get(ctx, types.NamespacedName{Namespace: worker.Namespace, Name: worker.Name}, &existingJob); getErr != nil {
			return ctrl.Result{}, getErr
		}
		return r.reconcileExistingJob(ctx, review, &existingJob, now)
	}

	review.Status.JobName = worker.Name
	review.Status.PVCName = ""
	review.Status.LeaseName = workspace.LeaseName(review.Spec.RepositoryID, review.Spec.PRNumber)
	review.Status.StartTime = timePtr(metav1.NewTime(now))
	if _, err := observeTiming(review, reviewv1alpha2.DispatchStageJobCreated, metav1.NewTime(now)); err != nil {
		return ctrl.Result{}, r.fail(ctx, review, "TimingContractViolation", err.Error())
	}
	if err := r.setPhase(ctx, review, reviewv1alpha2.PhaseRunning, "WorkerCreated", workerMessage(review, "created")); err != nil {
		return ctrl.Result{}, err
	}
	return ctrl.Result{}, nil
}

func (r *PRReviewJobV1Alpha2Reconciler) admitAndCreateWorker(
	ctx context.Context,
	review *reviewv1alpha2.PRReviewJob,
	now time.Time,
) (ctrl.Result, error) {
	limit := r.MaxConcurrentJobs
	if limit <= 0 {
		limit = DefaultV1Alpha2MaxConcurrentJobs
	}
	admission, err := r.admissionSnapshot(ctx, review, now, limit)
	if err != nil {
		return ctrl.Result{}, err
	}
	if admission.activeWorkers >= limit {
		return r.queueForCapacity(ctx, review, now, fmt.Sprintf("waiting for one of %d worker slots", limit))
	}
	if admission.olderWaiting {
		return r.queueForCapacity(ctx, review, now, "waiting for an older worker admission candidate")
	}

	acquired, err := r.getCapacityLedger().AcquireSlot(ctx, review, limit)
	if err != nil {
		return ctrl.Result{}, err
	}
	if !acquired {
		return r.queueForCapacity(ctx, review, now, fmt.Sprintf("waiting for one of %d worker slots", limit))
	}

	pvcName := ""

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
		_ = r.getCapacityLedger().ReleaseSlot(ctx, review)
		if errors.Is(err, workspace.ErrLeaseHeld) || errors.Is(err, workspace.ErrLeaseTakeoverNotAuthorized) {
			if statusErr := r.setPhase(ctx, review, reviewv1alpha2.PhaseQueued, "WorkspaceBusy", "waiting for the previous PR worker to release its workspace lease"); statusErr != nil {
				return ctrl.Result{}, statusErr
			}
			return ctrl.Result{RequeueAfter: v1Alpha2RequeueAfter}, nil
		}
		return ctrl.Result{}, r.fail(ctx, review, "WorkspaceLeaseRejected", err.Error())
	}

	if review.Spec.WorkerLeaseToken != "" {
		review.Status.ActiveWorkerLeaseToken = review.Spec.WorkerLeaseToken
	} else if leaseResult.Lease != nil && leaseResult.Lease.Spec.LeaseTransitions != nil {
		review.Status.ActiveWorkerLeaseToken = fmt.Sprintf("%d", *leaseResult.Lease.Spec.LeaseTransitions)
	}

	worker, err := job.BuildWorkerJob(job.Input{
		Review:           review,
		WorkspacePVCName: pvcName,
		WorkspaceLease:   leaseResult,
		Now:              now,
		Publishing:       r.Publishing,
	})
	if err == nil && len(worker.Spec.Template.Spec.Containers) > 0 {
		container := &worker.Spec.Template.Spec.Containers[0]
		if review.Spec.LogicalChildID != "" {
			container.Env = append(container.Env, corev1.EnvVar{Name: "CT_LOGICAL_CHILD_ID", Value: review.Spec.LogicalChildID})
		}
		if review.Spec.FencingEpoch > 0 {
			container.Env = append(container.Env, corev1.EnvVar{Name: "CT_FENCING_EPOCH", Value: strconv.FormatInt(review.Spec.FencingEpoch, 10)})
		}
		if review.Spec.WorkerLeaseToken != "" {
			container.Env = append(container.Env, corev1.EnvVar{Name: "CT_WORKER_LEASE_TOKEN", Value: review.Spec.WorkerLeaseToken})
		}
	}
	if err != nil {
		_ = r.getCapacityLedger().ReleaseSlot(ctx, review)
		// The lease was acquired for this attempt, but no Job exists. Release it
		// before recording a terminal contract failure so a later run is not
		// stranded behind an invalid projection.
		if releaseErr := workspace.NewLeaseManager(r.Client).Release(ctx, review.Namespace, review.Spec.RepositoryID, review.Spec.PRNumber, review.Spec.RunID, now); releaseErr != nil {
			return ctrl.Result{}, releaseErr
		}
		// An app-gate review that will never have a worker still owes the
		// dispatcher a verdict. Route it through the same delegation as
		// WorkerJobMissing above instead of a plain fail, or the terminal
		// deadline reaper is the only thing left to notice it, 30 minutes later.
		if review.Spec.PublicationMode == job.PublicationModeAppGate {
			return r.startFailurePublication(ctx, review, "WorkerContractRejected", err.Error())
		}
		return ctrl.Result{}, r.fail(ctx, review, "WorkerContractRejected", err.Error())
	}
	if r.Scheme != nil {
		if err := controllerutil.SetControllerReference(review, worker, r.Scheme); err != nil {
			_ = r.getCapacityLedger().ReleaseSlot(ctx, review)
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
	if err := r.Status().Update(ctx, review); err != nil {
		return ctrl.Result{}, err
	}
	if err := ctx.Err(); err != nil {
		return ctrl.Result{}, err
	}
	var existing batchv1.Job
	if err := r.Create(ctx, worker); err != nil {
		if !apierrors.IsAlreadyExists(err) {
			return ctrl.Result{}, err
		}
		if getErr := r.Get(ctx, types.NamespacedName{Namespace: worker.Namespace, Name: worker.Name}, &existing); getErr != nil {
			return ctrl.Result{}, getErr
		}
		return r.reconcileExistingJob(ctx, review, &existing, now)
	}

	review.Status.JobName = worker.Name
	review.Status.PVCName = pvcName
	review.Status.LeaseName = workspace.LeaseName(review.Spec.RepositoryID, review.Spec.PRNumber)
	review.Status.StartTime = timePtr(metav1.NewTime(now))
	if _, err := observeTiming(review, reviewv1alpha2.DispatchStageJobCreated, metav1.NewTime(now)); err != nil {
		return ctrl.Result{}, r.fail(ctx, review, "TimingContractViolation", err.Error())
	}
	if err := r.setPhase(ctx, review, reviewv1alpha2.PhaseRunning, "WorkerCreated", workerMessage(review, "created")); err != nil {
		return ctrl.Result{}, err
	}
	return ctrl.Result{}, nil
}

// A finalizer on an owned child cannot delay deletion of its owner. If a
// PRReviewJob is explicitly removed, release only this controller's guard from
// its exact child so garbage collection cannot strand a terminating Job. The
// uncached read above is required before entering this owner-absent path.
func (r *PRReviewJobV1Alpha2Reconciler) releaseOrphanedWorkerObservation(ctx context.Context, req ctrl.Request) error {
	for _, jobSuffix := range []string{"-worker", "-continuation"} {
		var worker batchv1.Job
		err := r.getCachedThenLive(ctx, types.NamespacedName{Namespace: req.Namespace, Name: req.Name + jobSuffix}, &worker)
		if err != nil {
			if apierrors.IsNotFound(err) {
				continue
			}
			return err
		}
		if !controllerutil.ContainsFinalizer(&worker, terminalOutcomeFinalizer) || !controlledByDeletedReviewName(&worker, req.Name) {
			continue
		}
		controllerutil.RemoveFinalizer(&worker, terminalOutcomeFinalizer)
		// A prior reconcile (or a concurrent one) may already have released this
		// same finalizer and the Job's own zero success TTL then let Kubernetes
		// delete it before this Update lands: the cached-then-live read above is
		// not atomic with this write. The Job being gone means there is nothing
		// left to release, so NotFound here is success, not a failure to report.
		if err := client.IgnoreNotFound(r.Update(ctx, &worker)); err != nil {
			return err
		}
	}
	return nil
}

func controlledByDeletedReviewName(worker *batchv1.Job, name string) bool {
	// The authoritative live read already proved that no owner object exists, so
	// there is no owner UID to pass to metav1.IsControlledBy. Match the persisted
	// controller tombstone by exact GVK/name; if a review with the same name was
	// recreated, getCachedThenLive would find it before entering this path.
	owner := metav1.GetControllerOf(worker)
	return owner != nil && owner.APIVersion == reviewv1alpha2.GroupVersion.String() &&
		owner.Kind == "PRReviewJob" && owner.Name == name
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
	workerKey := types.NamespacedName{Namespace: review.Namespace, Name: resolveWorkerJobName(review)}
	var worker batchv1.Job
	err := r.getCachedThenLive(ctx, workerKey, &worker)
	if err == nil {
		if !managedWorkerJobMatches(review, &worker) {
			return r.failWorkerContractMismatch(ctx, review, &worker, workerContractMessage(review, "existing"))
		}
		if worker.DeletionTimestamp == nil && !controllerutil.ContainsFinalizer(&worker, terminalOutcomeFinalizer) {
			controllerutil.AddFinalizer(&worker, terminalOutcomeFinalizer)
			// Same reasoning as the finalizer-add above in Reconcile's existing-Job
			// branch: NotFound means the Job already vanished, so there is nothing
			// left to guard, and the in-memory `worker` still holds the terminal
			// Status from the live read above for the branches below to use.
			if err := r.Update(ctx, &worker); err != nil && !apierrors.IsNotFound(err) {
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
	// Expiry has no worker Job to source a timestamp from (or the worker is
	// intentionally stopped above), unlike the Succeeded/Failed paths in
	// reconcileExistingJob which already set CompletionTime from the Job's own
	// terminal timestamp. Setting it here too means reconcileTerminalDeletion
	// never needs the metadata.creationTimestamp fallback for an Expired
	// review created after this change.
	completed := metav1.NewTime(now)
	review.Status.CompletionTime = &completed
	return ctrl.Result{}, r.setPhase(ctx, review, reviewv1alpha2.PhaseExpired, "DeadlineExpired", "review terminal deadline has elapsed")
}

func (r *PRReviewJobV1Alpha2Reconciler) reconcileCancellation(
	ctx context.Context,
	review *reviewv1alpha2.PRReviewJob,
) (ctrl.Result, error) {
	now := r.clock()
	nowMeta := metav1.NewTime(now)
	if review.Status.CancelObservedAt == nil {
		review.Status.CancelObservedAt = &nowMeta
	}
	if review.Status.CompletionTime == nil {
		review.Status.CompletionTime = &nowMeta
	}

	reason := "Cancelled"
	message := "review run cancelled"
	if review.Spec.CancelReason != nil && *review.Spec.CancelReason != "" {
		message = fmt.Sprintf("review run cancelled: %s", *review.Spec.CancelReason)
	}

	review.Status.Phase = reviewv1alpha2.PhaseCancelled
	review.Status.ObservedGeneration = review.Generation
	review.Status.Message = message
	meta.SetStatusCondition(&review.Status.Conditions, metav1.Condition{
		Type:               "Ready",
		Status:             metav1.ConditionFalse,
		Reason:             reason,
		Message:            message,
		ObservedGeneration: review.Generation,
		LastTransitionTime: metav1.Now(),
	})

	// Commit PhaseCancelled before deleting worker Job to avoid WorkerJobMissing.
	if err := r.Status().Update(ctx, review); err != nil {
		return ctrl.Result{}, err
	}

	workerName := resolveWorkerJobName(review)
	var existing batchv1.Job
	existingErr := r.getCachedThenLive(ctx, types.NamespacedName{Namespace: review.Namespace, Name: workerName}, &existing)
	if existingErr != nil && !apierrors.IsNotFound(existingErr) {
		return ctrl.Result{}, existingErr
	}
	if existingErr == nil {
		if controllerutil.ContainsFinalizer(&existing, terminalOutcomeFinalizer) {
			controllerutil.RemoveFinalizer(&existing, terminalOutcomeFinalizer)
			if err := r.Update(ctx, &existing); err != nil && !apierrors.IsNotFound(err) {
				return ctrl.Result{}, err
			}
		}
		if existing.DeletionTimestamp == nil {
			deleteOpts := client.PropagationPolicy(metav1.DeletePropagationForeground)
			if err := r.Delete(ctx, &existing, deleteOpts); err != nil && !apierrors.IsNotFound(err) {
				return ctrl.Result{}, err
			}
		}
		return ctrl.Result{RequeueAfter: v1Alpha2RequeueAfter}, nil
	}

	// No worker Job exists yet (queued): delete the CR without creating a worker pod
	if !workerCreationWasAttempted(review) {
		if err := r.Delete(ctx, review); err != nil && !apierrors.IsNotFound(err) {
			return ctrl.Result{}, err
		}
	}
	return ctrl.Result{}, nil
}

func isContinuationRequested(review *reviewv1alpha2.PRReviewJob) bool {
	if review == nil {
		return false
	}
	if review.Annotations != nil {
		if review.Annotations[job.JobPhaseLabel] == job.JobPhaseContinuation || review.Annotations["review-yeti.ai/resumed"] == "true" {
			return true
		}
	}
	if review.Labels != nil && review.Labels[job.JobPhaseLabel] == job.JobPhaseContinuation {
		return true
	}
	if strings.HasSuffix(review.Status.JobName, "-continuation") {
		return true
	}
	return false
}

func isAwaitingResumption(review *reviewv1alpha2.PRReviewJob) bool {
	if review == nil {
		return false
	}
	if meta.IsStatusConditionTrue(review.Status.Conditions, reviewv1alpha2.ConditionAwaitingResumption) ||
		review.Status.Phase == reviewv1alpha2.PhaseAwaitingResumption ||
		review.Status.Phase == reviewv1alpha2.PhaseSuspended {
		return true
	}
	// A review queued while awaiting continuation capacity or lease is also awaiting resumption
	if review.Status.Phase == reviewv1alpha2.PhaseQueued && isContinuationRequested(review) &&
		review.Status.JobName != "" && !strings.HasSuffix(review.Status.JobName, "-continuation") {
		return true
	}
	return false
}

func resolveWorkerJobName(review *reviewv1alpha2.PRReviewJob) string {
	if review == nil {
		return ""
	}
	if review.Status.JobName == review.Name+"-continuation" {
		return review.Name + "-continuation"
	}
	// If review is currently running prep, continue tracking its prep worker job even if continuation was annotated prematurely
	if review.Status.JobName != "" && !isAwaitingResumption(review) && review.Status.Phase == reviewv1alpha2.PhaseRunning {
		return review.Status.JobName
	}
	if isContinuationRequested(review) {
		return review.Name + "-continuation"
	}
	if review.Status.JobName != "" {
		return review.Status.JobName
	}
	return review.Name + "-worker"
}

func workerCreationWasAttempted(review *reviewv1alpha2.PRReviewJob) bool {
	// Also recognize status written by older operators that had no reservation.
	return meta.IsStatusConditionTrue(review.Status.Conditions, workerCreationReserved) ||
		review.Status.Phase == reviewv1alpha2.PhaseRunning || review.Status.JobName != "" ||
		review.Status.StartTime != nil ||
		(review.Status.Timing != nil && review.Status.Timing.JobCreatedAt != nil)
}

func workerMessage(review *reviewv1alpha2.PRReviewJob, action string) string {
	mode := "receipt-only"
	if review != nil && review.Spec.PublicationMode == job.PublicationModeAppGate {
		mode = "app-gate publishing"
	}
	return fmt.Sprintf("%s worker Job %s", mode, action)
}

func workerContractMessage(review *reviewv1alpha2.PRReviewJob, prefix string) string {
	mode := "receipt-only"
	if review != nil && review.Spec.PublicationMode == job.PublicationModeAppGate {
		mode = "app-gate publishing"
	}
	return fmt.Sprintf("%s worker Job does not match the immutable %s contract", prefix, mode)
}

func receiptLookupRequeue(err error) (ctrl.Result, error) {
	if errors.Is(err, ErrReceiptLookupPending) {
		return ctrl.Result{RequeueAfter: 500 * time.Millisecond}, nil
	}
	if errors.Is(err, errTemporaryReceiptLookup) {
		return ctrl.Result{RequeueAfter: 500 * time.Millisecond}, err
	}
	return ctrl.Result{}, err
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
		_ = r.getCapacityLedger().RenewSlot(ctx, review)
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
			if err := r.setPhase(ctx, review, reviewv1alpha2.PhaseRunning, "WorkerObserved", workerMessage(review, "is running")); err != nil {
				return ctrl.Result{}, err
			}
		} else if timingChanged {
			if err := r.Status().Update(ctx, review); err != nil {
				return ctrl.Result{}, err
			}
		}
		return ctrl.Result{}, nil
	}

	if worker.Status.Succeeded > 0 {
		// Safeguard: Never promote to Succeeded if fencing epoch regressed or lease expired.
		// Verify worker lease token BEFORE releasing the workspace lease.
		if review.Spec.FencingEpoch > 0 && review.Status.AuthoritativeFencingEpoch > 0 &&
			review.Spec.FencingEpoch < review.Status.AuthoritativeFencingEpoch {
			return r.failClosedFencing(ctx, review, reviewv1alpha2.ConditionFencingEpochMismatch, "EpochMismatch",
				fmt.Sprintf("spec.fencingEpoch (%d) < authoritative (%d)", review.Spec.FencingEpoch, review.Status.AuthoritativeFencingEpoch), now)
		}
		if review.Spec.WorkerLeaseToken != "" {
			stale, reason, msg, err := r.verifyWorkerLeaseToken(ctx, review, now)
			if err != nil {
				return ctrl.Result{}, err
			}
			if stale {
				return r.failClosedFencing(ctx, review, reviewv1alpha2.ConditionStaleWorkerLease, reason, msg, now)
			}
		}
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
	// Copy the worker Pod's exit record into the parent before anything below
	// can shorten the Job's TTL. The failure paths persist it in their own
	// terminal status write; the success path persists it here, ahead of
	// patchWorkerSuccessTTL, because a success TTL of 0 lets the TTL
	// controller collect the Pod the moment that patch lands.
	terminationRecorded, err := r.observeWorkerTermination(ctx, review, worker, now)
	if err != nil {
		return ctrl.Result{}, err
	}

	// Reconcile UNKNOWN effect guard based on pod outcome
	if err := r.ReconcileUnknownEffectGuard(ctx, review, worker, now); err != nil {
		return ctrl.Result{}, err
	}

	// Ensure ReceiptDigest and ReceiptEvidenceRef are populated
	auditRecorded, err := r.ensureReceiptAuditability(ctx, review, worker, now)
	if err != nil {
		if terminationRecorded || auditRecorded {
			_ = r.Status().Update(ctx, review)
		}
		return receiptLookupRequeue(err)
	}

	if terminationRecorded || auditRecorded {
		if err := r.Status().Update(ctx, review); err != nil {
			return ctrl.Result{}, err
		}
	}

	if worker.Status.Succeeded > 0 {
		if job.IsPrepWorkerJob(worker) {
			meta.SetStatusCondition(&review.Status.Conditions, metav1.Condition{
				Type:               reviewv1alpha2.ConditionAwaitingResumption,
				Status:             metav1.ConditionTrue,
				Reason:             "PrepCompleted",
				Message:            "prep phase completed, awaiting model resumption",
				LastTransitionTime: metav1.NewTime(now),
			})
			review.Status.Phase = reviewv1alpha2.PhaseAwaitingResumption
			if err := r.Status().Update(ctx, review); err != nil {
				return ctrl.Result{}, err
			}
			if err := r.patchWorkerSuccessTTL(ctx, worker); err != nil {
				return ctrl.Result{}, err
			}
			if controllerutil.ContainsFinalizer(worker, terminalOutcomeFinalizer) {
				controllerutil.RemoveFinalizer(worker, terminalOutcomeFinalizer)
				if err := r.Update(ctx, worker); err != nil && !apierrors.IsNotFound(err) {
					return ctrl.Result{}, err
				}
			}
			return ctrl.Result{}, nil
		}

		if workerEndedSuperseded(review) {
			if err := r.patchWorkerSuccessTTL(ctx, worker); err != nil {
				return ctrl.Result{}, err
			}
			return ctrl.Result{}, r.recordSuperseded(ctx, review)
		}

		// GUARD: Check if UnknownEffectPending or missing receipt blocks promotion
		if err := AssertCanPromoteToSucceeded(review); err != nil {
			return ctrl.Result{}, r.setPhase(ctx, review, reviewv1alpha2.PhaseFailed, ReasonUnresolvedEffect,
				"worker completed with unconfirmed external effects; fail-closed")
		}

		if err := r.patchWorkerSuccessTTL(ctx, worker); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{}, r.setPhase(ctx, review, reviewv1alpha2.PhaseSucceeded, "WorkerSucceeded", workerMessage(review, "completed"))
	}
	if review.Spec.PublicationMode == job.PublicationModeAppGate {
		return r.startFailurePublication(ctx, review, "WorkerFailed", workerMessage(review, "failed"))
	}
	return ctrl.Result{}, r.setPhase(ctx, review, reviewv1alpha2.PhaseFailed, "WorkerFailed", workerMessage(review, "failed"))
}

// patchWorkerSuccessTTL lowers a succeeded worker Job's TTL from the fail-safe
// value job.BuildWorkerJob built it with (job.WorkerFailedTTLSeconds, so a
// failed Job's Pod and logs would still survive) down to the success TTL
// (job.WorkerSuccessTTLSeconds, default 0). batch/v1 exposes exactly one
// ttlSecondsAfterFinished field and the outcome is unknown at build time, so
// this patch is how a successful run reclaims immediately without changing
// how long a failed one is kept. ttlSecondsAfterFinished is mutable on an
// already-finished Job -- the TTL-after-finished controller re-reads it
// continuously rather than treating it as immutable Job-spec identity like
// selector/template -- so patching it here, after Succeeded is observed, is
// safe. It does not race the terminal-outcome finalizer: that finalizer is
// only removed once the parent review reaches a terminal phase
// (releaseTerminalWorkerObservation), which runs strictly after this patch on
// a later reconcile, so a delete triggered by a just-shortened TTL still
// blocks on the finalizer until this controller is ready to let it go.
func (r *PRReviewJobV1Alpha2Reconciler) patchWorkerSuccessTTL(ctx context.Context, worker *batchv1.Job) error {
	successTTL := job.WorkerSuccessTTLSeconds()
	if worker.Spec.TTLSecondsAfterFinished != nil && *worker.Spec.TTLSecondsAfterFinished == successTTL {
		return nil
	}
	patch := client.MergeFrom(worker.DeepCopy())
	worker.Spec.TTLSecondsAfterFinished = &successTTL
	if err := r.Patch(ctx, worker, patch); err != nil && !apierrors.IsNotFound(err) {
		return err
	}
	return nil
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
	err := r.getCachedThenLive(ctx, types.NamespacedName{Namespace: review.Namespace, Name: resolveWorkerJobName(review)}, &observed)
	var worker *batchv1.Job
	if err == nil {
		worker = &observed
		if managedWorkerJobMatches(review, worker) && worker.Status.Succeeded > 0 {
			// Keep the pending condition during receipt verification: it is the
			// narrow exception that lets a pre-deadline success observed after
			// failure delegation prove itself even though phase is Failed. Clear
			// it only after the exact outcome has been durably reconciled.
			result, reconcileErr := r.reconcileExistingJob(ctx, review, worker, r.clock())
			if reconcileErr != nil {
				return result, reconcileErr
			}
			meta.RemoveStatusCondition(&review.Status.Conditions, failurePublicationCondition)
			if err := r.Status().Update(ctx, review); err != nil {
				return ctrl.Result{}, err
			}
			return result, nil
		}
	}
	if err != nil && !apierrors.IsNotFound(err) {
		return ctrl.Result{}, err
	}

	// A contract mismatch or a still-running worker past its deadline may leave
	// an untrusted or stuck Job running. Stop only the exact child after the
	// pending obligation is durable; if deletion is lost, this reconcile
	// retries it without ever recreating the worker. A Job that has already
	// finished (WorkerFailed's BackoffLimitExceeded, most commonly) has
	// nothing left running to stop, and its Pod/exit-status logs are the only
	// surviving evidence of the failure this review reports -- deleting it
	// would destroy that evidence roughly a minute later instead of letting
	// its own ttlSecondsAfterFinished (REVIEW_YETI_WORKER_FAILED_TTL_AFTER_
	// FINISHED) collect it on schedule.
	if worker != nil {
		if !metav1.IsControlledBy(worker, review) {
			return ctrl.Result{}, errors.New("refusing to stop a worker Job not controlled by the failed review")
		}
		if !workerJobFinished(worker) {
			if worker.DeletionTimestamp == nil {
				if err := r.Delete(ctx, worker, client.PropagationPolicy(metav1.DeletePropagationForeground)); err != nil && !apierrors.IsNotFound(err) {
					return ctrl.Result{}, err
				}
			}
		} else if controllerutil.ContainsFinalizer(worker, terminalOutcomeFinalizer) {
			// This finalizer only ever existed to hold the Job open long enough
			// for its terminal result to be durably copied into the parent
			// status -- which has already happened by the time a review reaches
			// failure publication. Retaining the Job instead of deleting it
			// must not also retain the finalizer: nothing else in this operator
			// will ever release it for a review that stays terminal, and the
			// TTL controller's own delete would otherwise hang on it forever.
			// The patch also lowers the build-time forensic hold to the failed
			// TTL, once the Pod's exit record is durable in this review.
			// Not ready means the Pod's exit is not readable yet; the finalizer
			// then stays for the terminal path (releaseTerminalWorkerObservation)
			// to release, and delegation below is not delayed by it.
			base := worker.DeepCopy()
			ready, err := r.prepareFinishedWorkerRelease(ctx, review, worker)
			if err != nil {
				return receiptLookupRequeue(err)
			}
			if ready {
				controllerutil.RemoveFinalizer(worker, terminalOutcomeFinalizer)
				if err := r.Patch(ctx, worker, client.MergeFrom(base)); err != nil && !apierrors.IsNotFound(err) {
					return ctrl.Result{}, err
				}
			}
		}
	}
	var activeWorker bool
	if worker == nil {
		activeWorker, err = r.hasActiveReviewWorkerPod(ctx, review)
	} else {
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
	if pod == nil || worker == nil || worker.UID == "" {
		return false
	}
	return metav1.IsControlledBy(pod, worker)
}

func observeTiming(review *reviewv1alpha2.PRReviewJob, stage reviewv1alpha2.DispatchTimingStage, at metav1.Time) (bool, error) {
	if review.Status.Timing == nil {
		review.Status.Timing = &reviewv1alpha2.DispatchTimingStatus{}
	}
	return review.Status.Timing.Observe(stage, at)
}

// workerJobFinished reports whether a Job has reached a terminal outcome and
// therefore has nothing left running to stop. This path also handles a
// WorkerContractMismatch, where the child's spec cannot be trusted, so the
// failed-Pod counter alone proves nothing: it counts Pods, and a Job that was
// altered to allow retries can have a failed Pod while another attempt is
// running or about to start. Only the Job controller's own terminal condition
// is accepted outright; the counter is accepted only when no Pod is active and
// the Job cannot retry (backoffLimit 0, the only value this operator creates).
func workerJobFinished(worker *batchv1.Job) bool {
	for _, condition := range worker.Status.Conditions {
		if (condition.Type == batchv1.JobComplete || condition.Type == batchv1.JobFailed) && condition.Status == corev1.ConditionTrue {
			return true
		}
	}
	if worker.Status.Active > 0 || worker.Status.Failed == 0 {
		return false
	}
	return worker.Spec.BackoffLimit != nil && *worker.Spec.BackoffLimit == 0
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
		if candidate.Name == review.Name {
			continue
		}
		if !validWorkerAdmissionCandidate(candidate, now) {
			continue
		}
		if isAwaitingResumption(candidate) {
			if admissionPrecedes(candidate, review) {
				olderWaiting = true
			}
		} else if workerCreationWasAttempted(candidate) {
			expectedName := resolveWorkerJobName(candidate)
			if _, visible := visibleWorkers[expectedName]; !visible {
				active++
			}
		} else if admissionPrecedes(candidate, review) {
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
	if isAwaitingResumption(review) {
		if isContinuationRequested(review) {
			return true
		}
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
	// If the review failed closed due to fencing or stale lease, preserve pod state without active mutation
	if meta.IsStatusConditionTrue(review.Status.Conditions, reviewv1alpha2.ConditionFencingEpochMismatch) ||
		meta.IsStatusConditionTrue(review.Status.Conditions, reviewv1alpha2.ConditionStaleWorkerLease) {
		return r.reconcileTerminalDeletion(ctx, review)
	}

	released, err := r.releaseTerminalWorkerObservation(ctx, review)
	if err != nil {
		return ctrl.Result{}, err
	}
	if !released {
		// The worker Pod's exit is not readable yet; keep the Job (and its
		// forensic-hold TTL) until it is recorded or the hold elapses.
		return ctrl.Result{RequeueAfter: v1Alpha2RequeueAfter}, nil
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
		return r.reconcileTerminalDeletion(ctx, review)
	}

	pvcName := workspace.PVCName(review.Spec.RepositoryID, review.Spec.PRNumber)
	if pvcName == "" {
		return r.reconcileTerminalDeletion(ctx, review)
	}
	var pvc corev1.PersistentVolumeClaim
	if err := r.Get(ctx, types.NamespacedName{Namespace: review.Namespace, Name: pvcName}, &pvc); err != nil {
		if apierrors.IsNotFound(err) {
			return r.reconcileTerminalDeletion(ctx, review)
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
	return r.reconcileTerminalDeletion(ctx, review)
}

// reconcileTerminalDeletion runs only once reconcileTerminalWorkspace has
// nothing left to reclaim (idle Pod/lease, PVC already gone or reclaimed).
// It deletes the terminal PRReviewJob after REVIEW_YETI_TERMINAL_RETENTION_SECONDS
// has elapsed since the review became terminal (job.TerminalRetentionSeconds,
// default 3600s); this controller owns the worker Job via a controller
// reference, so ordinary Kubernetes garbage collection cascades the delete to
// it (and, transitively, to its Pod) without any extra client call here.
//
// A pending failure-publication delegation is a deliberate exception. Once
// reconcileFailurePublication sets FailurePublication to Unknown with reason
// DelegatedToTrustedService, responsibility for publishing the GitHub check
// has moved to the dispatcher's abandoned-run reaper
// (src/review/abandonedRunReaper.ts), which reconciles the check entirely
// against PostgreSQL and GitHub using its own fresh App token -- it never
// reads or patches this Kubernetes object. Nothing in this repository ever
// transitions FailurePublication away from Unknown once it is set, so relying
// on that condition to resolve before deleting would leak this review (and
// the run Secret its spec.RunSecretName names, which the reaper may still
// need to read) forever. REVIEW_YETI_TERMINAL_MAX_RETENTION_SECONDS
// (job.TerminalMaxRetentionSeconds, default 86400s) is the hard cap: past it,
// deletion proceeds even though delegation is still outstanding, so this gate
// can bound but never permanently prevent cleanup.
func (r *PRReviewJobV1Alpha2Reconciler) reconcileTerminalDeletion(
	ctx context.Context,
	review *reviewv1alpha2.PRReviewJob,
) (ctrl.Result, error) {
	now := r.clock()
	terminalAt := terminalObservedAt(review)
	deleteAt := terminalAt.Add(time.Duration(job.TerminalRetentionSeconds()) * time.Second)

	if failurePublicationDelegated(review) {
		hardCapAt := terminalAt.Add(time.Duration(job.TerminalMaxRetentionSeconds()) * time.Second)
		if now.Before(hardCapAt) {
			remaining := hardCapAt.Sub(now)
			if now.Before(deleteAt) {
				if untilRetention := deleteAt.Sub(now); untilRetention < remaining {
					remaining = untilRetention
				}
			}
			return ctrl.Result{RequeueAfter: remaining}, nil
		}
		return r.deleteTerminalReview(ctx, review)
	}

	if now.Before(deleteAt) {
		return ctrl.Result{RequeueAfter: deleteAt.Sub(now)}, nil
	}
	return r.deleteTerminalReview(ctx, review)
}

// deleteTerminalReview tolerates NotFound: a prior reconcile's Delete call may
// already have removed the review, and a repeated attempt (retry, requeue
// race) must not surface that as an error.
func (r *PRReviewJobV1Alpha2Reconciler) deleteTerminalReview(ctx context.Context, review *reviewv1alpha2.PRReviewJob) (ctrl.Result, error) {
	_ = r.getCapacityLedger().ReleaseSlot(ctx, review)
	if review != nil {
		r.forgetReceipt(review.Namespace, review.Name)
	}
	if review.Status.ReceiptDigest == "" || review.Status.ReceiptEvidenceRef == "" {
		if _, err := r.ensureReceiptAuditability(ctx, review, nil, r.clock()); err != nil {
			return ctrl.Result{}, err
		}
		if err := r.Status().Update(ctx, review); err != nil {
			return ctrl.Result{}, err
		}
	}
	if err := r.Delete(ctx, review); err != nil && !apierrors.IsNotFound(err) {
		return ctrl.Result{}, err
	}
	return ctrl.Result{}, nil
}

// reconcileRunSecretDeletion runs once metadata.deletionTimestamp is set on a
// PRReviewJob, whether that deletion was initiated by deleteTerminalReview
// above or by anything else (kubectl delete, a namespace teardown, a future
// operator path). It is the only place in this controller that deletes a
// Secret, and it only ever does so by the exact name spec.runSecretName
// declares -- never by label selector or List -- and only when that name
// matches the run-secret naming contract (job.IsValidRunSecretName, the same
// check BuildWorkerJob's validateInput already enforces before ever wiring
// the name into a worker Pod spec). A PRReviewJob admitted before this
// contract existed, or one an operator build let through with an invalid
// name, must not cause any Secret deletion; it only loses its finalizer.
//
// A real Kubernetes API server keeps this object present-but-terminating
// (DeletionTimestamp set, finalizers non-empty) until every finalizer is
// removed, so this function's own Update -- once it removes the finalizer --
// is what actually lets deletion complete. Delete errors other than NotFound
// and Forbidden are returned so the object retries and is never orphaned
// mid-cleanup. Forbidden is a deliberate exception: the deployed Role may not
// yet grant `delete` on secrets (chart rollout ordering, a stale binding), and
// a stuck finalizer would wedge this PRReviewJob -- and eventually block
// namespace deletion -- forever. One leaked short-lived run Secret is judged
// strictly cheaper than that, so Forbidden is logged and (when a Recorder is
// configured) surfaced as a warning Event, and cleanup proceeds as if the
// Secret were already gone.
func (r *PRReviewJobV1Alpha2Reconciler) reconcileRunSecretDeletion(
	ctx context.Context,
	review *reviewv1alpha2.PRReviewJob,
) (ctrl.Result, error) {
	_ = r.getCapacityLedger().ReleaseSlot(ctx, review)
	if review != nil {
		r.forgetReceipt(review.Namespace, review.Name)
	}
	if !controllerutil.ContainsFinalizer(review, runSecretCleanupFinalizer) {
		return ctrl.Result{}, nil
	}
	if review.Status.ReceiptDigest == "" || review.Status.ReceiptEvidenceRef == "" {
		if _, err := r.ensureReceiptAuditability(ctx, review, nil, r.clock()); err != nil {
			return ctrl.Result{}, err
		}
		if err := r.Status().Update(ctx, review); err != nil {
			return ctrl.Result{}, err
		}
	}
	if job.IsValidRunSecretName(review.Spec.RunSecretName) {
		secret := &corev1.Secret{
			ObjectMeta: metav1.ObjectMeta{Name: review.Spec.RunSecretName, Namespace: review.Namespace},
		}
		switch err := r.Delete(ctx, secret); {
		case err == nil, apierrors.IsNotFound(err):
			// Deleted, or a prior reconcile (or the reaper, or an operator) already
			// removed it -- either way there is nothing left to clean up.
		case apierrors.IsForbidden(err):
			log.FromContext(ctx).Error(err, "operator lacks delete permission on the run Secret; removing the cleanup finalizer without deleting it",
				"secret", review.Spec.RunSecretName, "namespace", review.Namespace, "review", review.Name)
			if r.Recorder != nil {
				r.Recorder.Eventf(review, corev1.EventTypeWarning, "RunSecretDeleteForbidden",
					"operator RBAC does not grant delete on Secret %s; the run-secret cleanup finalizer was removed without deleting it", review.Spec.RunSecretName)
			}
		default:
			return ctrl.Result{}, err
		}
	} else {
		// The TS dispatcher (buildRunSecretName, src/k8s/reviewJobProjection.ts)
		// and this package's regex (job.IsValidRunSecretName) are two independent
		// implementations of the same naming contract; ciOperatorTestEnforcement
		// and the golden fixture in pkg/job/testdata/run_secret_names.json exist
		// to keep them in lockstep, but a name that predates the contract, or a
		// future drift neither test catches before rollout, must not disappear
		// silently -- it means this review's run Secret is never deleted by
		// anyone. Surface it the same way as the Forbidden branch above (log +
		// warning Event) instead of leaking it quietly, then still release the
		// finalizer: a permanently non-terminable PRReviewJob is worse than one
		// leaked Secret.
		err := fmt.Errorf("run Secret name %q does not match the run-secret naming contract", review.Spec.RunSecretName)
		log.FromContext(ctx).Error(err, "run Secret name failed the naming contract; removing the cleanup finalizer without deleting it",
			"secret", review.Spec.RunSecretName, "namespace", review.Namespace, "review", review.Name)
		if r.Recorder != nil {
			r.Recorder.Eventf(review, corev1.EventTypeWarning, "RunSecretNameInvalid",
				"spec.runSecretName %q does not match the run-secret naming contract; the run-secret cleanup finalizer was removed without deleting a Secret", review.Spec.RunSecretName)
		}
	}
	// Metadata-only merge patch, not a full Update -- see the matching
	// comment where this finalizer is added in Reconcile for why a full
	// Update on this resource can fail closed against the CRD's spec
	// immutability rule even when the request never intended to touch spec.
	base := review.DeepCopy()
	controllerutil.RemoveFinalizer(review, runSecretCleanupFinalizer)
	if err := r.Patch(ctx, review, client.MergeFrom(base)); err != nil {
		return ctrl.Result{}, err
	}
	return ctrl.Result{}, nil
}

// failurePublicationDelegated reports whether responsibility for this
// review's fail-closed GitHub check has been handed to the dispatcher's
// trusted reaper. failurePublicationPending (checked earlier in Reconcile)
// only recognizes the ConditionFalse "not yet delegated" state and routes
// those reviews into reconcileFailurePublication instead of here; by the time
// a review reaches reconcileTerminalDeletion, this condition -- if present at
// all -- can only be ConditionUnknown (see reconcileFailurePublication, the
// only writer that ever sets it after creation, and the DelegatedToTrusted
// Service comment on why it never resolves further).
func failurePublicationDelegated(review *reviewv1alpha2.PRReviewJob) bool {
	condition := meta.FindStatusCondition(review.Status.Conditions, failurePublicationCondition)
	return condition != nil && condition.Status == metav1.ConditionUnknown
}

// terminalObservedAt is the time retention windows are measured from. The
// Succeeded/Failed paths in reconcileExistingJob and the Expired path in
// reconcileElapsedDeadline all set status.completionTime, so this is the
// normal case; metadata.creationTimestamp is the fallback for a terminal
// resource that somehow never got one (a legacy object persisted by an
// operator build older than this change, or one of the narrow
// startFailurePublication call sites that fail closed before any worker
// terminal timestamp is observable).
func terminalObservedAt(review *reviewv1alpha2.PRReviewJob) time.Time {
	if review.Status.CompletionTime != nil && !review.Status.CompletionTime.Time.IsZero() {
		return review.Status.CompletionTime.Time
	}
	return review.CreationTimestamp.Time
}

// releaseTerminalWorkerObservation runs only after the parent CR already has a
// terminal phase. Removing the guard in a later reconcile keeps the ordering
// durable across status-update conflicts, operator crashes, and TTL deletion.
func (r *PRReviewJobV1Alpha2Reconciler) releaseTerminalWorkerObservation(
	ctx context.Context,
	review *reviewv1alpha2.PRReviewJob,
) (bool, error) {
	var worker batchv1.Job
	err := r.getCachedThenLive(ctx, types.NamespacedName{Namespace: review.Namespace, Name: resolveWorkerJobName(review)}, &worker)
	if apierrors.IsNotFound(err) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	if !controllerutil.ContainsFinalizer(&worker, terminalOutcomeFinalizer) {
		return true, nil
	}
	if !metav1.IsControlledBy(&worker, review) {
		return true, nil
	}
	// Last chance to record the Pod's exit before the TTL may collect it, and
	// the point where the build-time forensic hold is lowered to the outcome's
	// configured TTL (both written with the finalizer release below).
	ready, err := r.prepareFinishedWorkerRelease(ctx, review, &worker)
	if err != nil || !ready {
		return false, err
	}
	controllerutil.RemoveFinalizer(&worker, terminalOutcomeFinalizer)
	// Same race as releaseOrphanedWorkerObservation: the Job's own shortened
	// success TTL (patchWorkerSuccessTTL) can let Kubernetes delete it between
	// the read above and this write. The Job being gone means there is
	// nothing left to release, so NotFound here is success, not a failure.
	return true, client.IgnoreNotFound(r.Update(ctx, &worker))
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
// been established, query the Job controller's stable Pod label and verify the
// controller UID so a tampered review label cannot hide a running process.
func (r *PRReviewJobV1Alpha2Reconciler) hasActiveWorkerJobPod(ctx context.Context, worker *batchv1.Job) (bool, error) {
	var pods corev1.PodList
	if err := r.List(ctx, &pods, client.InNamespace(worker.Namespace), client.MatchingLabels{
		"batch.kubernetes.io/job-name": worker.Name,
	}); err != nil {
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
	if phase == reviewv1alpha2.PhaseRunning {
		meta.RemoveStatusCondition(&review.Status.Conditions, "CapacityExceeded")
		meta.SetStatusCondition(&review.Status.Conditions, metav1.Condition{
			Type:               "Admitted",
			Status:             metav1.ConditionTrue,
			Reason:             "WorkerSlotAcquired",
			Message:            "worker slot acquired from capacity ledger",
			ObservedGeneration: review.Generation,
			LastTransitionTime: metav1.Now(),
		})
	}
	if isTerminalPhase(phase) {
		_ = r.getCapacityLedger().ReleaseSlot(ctx, review)
		if review != nil {
			r.forgetReceipt(review.Namespace, review.Name)
		}
	}
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
	return phase == reviewv1alpha2.PhaseSucceeded || phase == reviewv1alpha2.PhaseFailed || phase == reviewv1alpha2.PhaseExpired || phase == reviewv1alpha2.PhaseCancelled
}

func managedWorkerJobMatches(review *reviewv1alpha2.PRReviewJob, worker *batchv1.Job) bool {
	if worker == nil || worker.Namespace != review.Namespace {
		return false
	}
	expectedName := resolveWorkerJobName(review)
	if worker.Name != expectedName && worker.Name != review.Name+"-worker" && worker.Name != review.Name+"-continuation" {
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
	if review.Spec.LogicalChildID != "" && envValue(env, "CT_LOGICAL_CHILD_ID") != review.Spec.LogicalChildID {
		return false
	}
	if review.Spec.FencingEpoch > 0 && envValue(env, "CT_FENCING_EPOCH") != strconv.FormatInt(review.Spec.FencingEpoch, 10) {
		return false
	}
	if review.Spec.WorkerLeaseToken != "" && envValue(env, "CT_WORKER_LEASE_TOKEN") != review.Spec.WorkerLeaseToken {
		return false
	}
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
			// REL-1069: the builder emits the standard OPENAI_API_KEY name. This
			// validator compares the env the builder produces, so the two must move
			// together -- a mismatch makes the reconciler reject (and DELETE) the
			// Job it just created. The ref is optional because no per-run secret
			// carries a gateway key.
			if variable.Name != job.QualificationGatewayKeyEnv {
				continue
			}
			secretRefs++
			if variable.ValueFrom == nil || variable.ValueFrom.SecretKeyRef == nil ||
				variable.ValueFrom.SecretKeyRef.Name != review.Spec.RunSecretName || variable.ValueFrom.SecretKeyRef.Key != job.QualificationGatewayKeyEnv {
				return false
			}
		}
		return secretRefs == 1
	}
	if review.Spec.QualificationProfile == job.SameHeadQualificationProfile {
		if receiptOnly != "" || fullPanel != "" || sameHead != "true" || model != review.Spec.QualificationModel {
			return false
		}
		gatewayRefs := 0
		githubRefs := 0
		for _, variable := range env {
			switch variable.Name {
			// REL-1069: standard gateway name; must match what the builder emits.
			case job.QualificationGatewayKeyEnv:
				gatewayRefs++
				if variable.ValueFrom == nil || variable.ValueFrom.SecretKeyRef == nil ||
					variable.ValueFrom.SecretKeyRef.Name != review.Spec.RunSecretName || variable.ValueFrom.SecretKeyRef.Key != job.QualificationGatewayKeyEnv {
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
		return gatewayRefs == 1 && githubRefs == 1
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
		if variable.Name == "OPENROUTER_API_KEY" {
			return false
		}
		if variable.Name == "GH_TOKEN" && !isContinuationRequested(review) {
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

// reconcileFencingAndLease verifies the mission fencing epoch and worker lease token.
// If an epoch regression, epoch mismatch, or stale/expired worker lease token is detected,
// it fails closed: sets the failure conditions and phase without mutating pod state.
func (r *PRReviewJobV1Alpha2Reconciler) reconcileFencingAndLease(
	ctx context.Context,
	review *reviewv1alpha2.PRReviewJob,
	now time.Time,
) (bool, ctrl.Result, error) {
	// If already failed due to fencing or lease, stay terminal
	if meta.IsStatusConditionTrue(review.Status.Conditions, ConditionFencingEpochMismatch) ||
		meta.IsStatusConditionTrue(review.Status.Conditions, ConditionStaleWorkerLease) {
		return true, ctrl.Result{}, nil
	}

	// 1. VERIFY MISSION FENCING EPOCH
	if review.Spec.FencingEpoch > 0 || review.Status.AuthoritativeFencingEpoch > 0 {
		authoritativeEpoch, err := r.resolveAuthoritativeFencingEpoch(ctx, review)
		if err != nil {
			return true, ctrl.Result{}, err
		}

		if review.Spec.FencingEpoch > 0 && authoritativeEpoch > 0 && review.Spec.FencingEpoch < authoritativeEpoch {
			message := fmt.Sprintf("spec.fencingEpoch (%d) is stale compared to authoritative fencing epoch (%d)",
				review.Spec.FencingEpoch, authoritativeEpoch)
			res, failErr := r.failClosedFencing(ctx, review, ConditionFencingEpochMismatch, "EpochMismatch", message, now)
			return true, res, failErr
		}

		// Initialize authoritative fencing epoch in status if not yet set
		if review.Status.AuthoritativeFencingEpoch == 0 && review.Spec.FencingEpoch > 0 {
			review.Status.AuthoritativeFencingEpoch = review.Spec.FencingEpoch
		}
	}

	// 2. VERIFY WORKER LEASE TOKEN
	if review.Spec.WorkerLeaseToken != "" {
		stale, reason, msg, err := r.verifyWorkerLeaseToken(ctx, review, now)
		if err != nil {
			return true, ctrl.Result{}, err
		}
		if stale {
			res, failErr := r.failClosedFencing(ctx, review, ConditionStaleWorkerLease, reason, msg, now)
			return true, res, failErr
		}
	}

	return false, ctrl.Result{}, nil
}

// resolveAuthoritativeFencingEpoch determines the authoritative mission epoch.
// Once established in status, it returns it immediately in O(1) time without querying siblings.
// When uninitialized (== 0), it checks sibling PRReviewJobs using the cached informer client.
func (r *PRReviewJobV1Alpha2Reconciler) resolveAuthoritativeFencingEpoch(
	ctx context.Context,
	review *reviewv1alpha2.PRReviewJob,
) (int64, error) {
	if review.Status.AuthoritativeFencingEpoch > 0 {
		return review.Status.AuthoritativeFencingEpoch, nil
	}

	var maxObservedEpoch int64 = review.Spec.FencingEpoch

	reader := r.Client
	var reviews reviewv1alpha2.PRReviewJobList
	if err := reader.List(ctx, &reviews, client.InNamespace(review.Namespace)); err != nil {
		return 0, err
	}

	for i := range reviews.Items {
		item := &reviews.Items[i]
		if item.Spec.RepositoryID == review.Spec.RepositoryID && item.Spec.PRNumber == review.Spec.PRNumber {
			if item.Status.AuthoritativeFencingEpoch > maxObservedEpoch {
				maxObservedEpoch = item.Status.AuthoritativeFencingEpoch
			}
			if item.Spec.FencingEpoch > maxObservedEpoch {
				maxObservedEpoch = item.Spec.FencingEpoch
			}
		}
	}

	if maxObservedEpoch > 0 {
		return maxObservedEpoch, nil
	}

	return 1, nil
}

// verifyWorkerLeaseToken checks spec.WorkerLeaseToken against active lease state in ct-review-system.
func (r *PRReviewJobV1Alpha2Reconciler) verifyWorkerLeaseToken(
	ctx context.Context,
	review *reviewv1alpha2.PRReviewJob,
	now time.Time,
) (bool, string, string, error) {
	// 1. Direct status comparison if active token was already recorded and differs
	if review.Status.ActiveWorkerLeaseToken != "" && review.Spec.WorkerLeaseToken != review.Status.ActiveWorkerLeaseToken {
		msg := fmt.Sprintf("spec.workerLeaseToken %q does not match active worker lease token %q",
			review.Spec.WorkerLeaseToken, review.Status.ActiveWorkerLeaseToken)
		return true, "LeaseExpired", msg, nil
	}

	// 2. Inspect active coordinationv1.Lease
	leaseName := workspace.LeaseName(review.Spec.RepositoryID, review.Spec.PRNumber)
	var lease coordinationv1.Lease
	err := r.Get(ctx, types.NamespacedName{Namespace: review.Namespace, Name: leaseName}, &lease)
	if err != nil {
		if apierrors.IsNotFound(err) {
			// If worker creation was already reserved or running, missing lease is terminal
			if workerCreationWasAttempted(review) {
				msg := fmt.Sprintf("active workspace lease %q not found for running or reserved worker", leaseName)
				return true, "LeaseExpired", msg, nil
			}
			return false, "", "", nil
		}
		return false, "", "", err
	}

	if lease.DeletionTimestamp != nil {
		msg := fmt.Sprintf("active workspace lease %q is terminating", leaseName)
		return true, "LeaseExpired", msg, nil
	}

	// Check lease holder identity
	if lease.Spec.HolderIdentity != nil && *lease.Spec.HolderIdentity != "" && *lease.Spec.HolderIdentity != review.Spec.RunID {
		msg := fmt.Sprintf("workspace lease %q is held by another run %q", leaseName, *lease.Spec.HolderIdentity)
		return true, "LeaseExpired", msg, nil
	}

	// Check lease expiry
	expiresAt, err := leaseExpires(&lease)
	if err != nil {
		msg := fmt.Sprintf("failed to parse workspace lease expiration: %v", err)
		return true, "LeaseExpired", msg, nil
	}
	if !now.Before(expiresAt) {
		msg := fmt.Sprintf("workspace lease %q expired at %s (current time: %s)", leaseName, expiresAt.Format(time.RFC3339), now.Format(time.RFC3339))
		return true, "LeaseExpired", msg, nil
	}

	// Compare token against transition representation or annotation if present
	if lease.Spec.LeaseTransitions != nil {
		transitionToken := fmt.Sprintf("%d", *lease.Spec.LeaseTransitions)
		tokenPrefixed := fmt.Sprintf("token-%d", *lease.Spec.LeaseTransitions)
		annotatedToken := ""
		if lease.Annotations != nil {
			annotatedToken = lease.Annotations["review-yeti.ai/lease-token"]
		}
		if annotatedToken != "" && review.Spec.WorkerLeaseToken != annotatedToken {
			msg := fmt.Sprintf("spec.workerLeaseToken %q does not match lease annotation token %q", review.Spec.WorkerLeaseToken, annotatedToken)
			return true, "LeaseExpired", msg, nil
		}
		if annotatedToken == "" && review.Status.ActiveWorkerLeaseToken != "" && review.Spec.WorkerLeaseToken != transitionToken && review.Spec.WorkerLeaseToken != tokenPrefixed {
			msg := fmt.Sprintf("spec.workerLeaseToken %q does not match active lease transitions (%s/%s)", review.Spec.WorkerLeaseToken, transitionToken, tokenPrefixed)
			return true, "LeaseExpired", msg, nil
		}
	}

	return false, "", "", nil
}

func leaseExpires(lease *coordinationv1.Lease) (time.Time, error) {
	if lease.Spec.LeaseDurationSeconds == nil || *lease.Spec.LeaseDurationSeconds <= 0 {
		return time.Time{}, errors.New("lease duration invalid")
	}
	var base time.Time
	if lease.Spec.RenewTime != nil {
		base = lease.Spec.RenewTime.Time
	} else if lease.Spec.AcquireTime != nil {
		base = lease.Spec.AcquireTime.Time
	}
	if base.IsZero() {
		return time.Time{}, errors.New("lease missing acquire and renew time")
	}
	return base.Add(time.Duration(*lease.Spec.LeaseDurationSeconds) * time.Second), nil
}

// failClosedFencing transitions the review to PhaseFailed with the specified condition,
// strictly avoiding any mutation of worker Jobs or Pods.
func (r *PRReviewJobV1Alpha2Reconciler) failClosedFencing(
	ctx context.Context,
	review *reviewv1alpha2.PRReviewJob,
	conditionType string,
	reason string,
	message string,
	now time.Time,
) (ctrl.Result, error) {
	review.Status.Phase = reviewv1alpha2.PhaseFailed
	review.Status.ObservedGeneration = review.Generation
	review.Status.Message = message

	// Surface the fencing or lease condition
	meta.SetStatusCondition(&review.Status.Conditions, metav1.Condition{
		Type:               conditionType,
		Status:             metav1.ConditionTrue,
		Reason:             reason,
		Message:            message,
		ObservedGeneration: review.Generation,
		LastTransitionTime: metav1.NewTime(now),
	})

	// Surface Ready = False
	meta.SetStatusCondition(&review.Status.Conditions, metav1.Condition{
		Type:               "Ready",
		Status:             metav1.ConditionFalse,
		Reason:             reason,
		Message:            message,
		ObservedGeneration: review.Generation,
		LastTransitionTime: metav1.NewTime(now),
	})

	// Persist the status update without touching any Pods or Jobs
	if err := r.Status().Update(ctx, review); err != nil {
		return ctrl.Result{}, err
	}

	// Fail closed: no requeue, no worker dispatch, no pod mutation
	return ctrl.Result{}, nil
}

// ClampedMaxConcurrentReconciles returns the configured reconcile concurrency clamped to [1, MaxV1Alpha2ReconcileConcurrencyCap].
func (r *PRReviewJobV1Alpha2Reconciler) ClampedMaxConcurrentReconciles() int {
	maxConcurrentReconciles := r.MaxConcurrentReconciles
	if maxConcurrentReconciles < 1 {
		return 1
	}
	if maxConcurrentReconciles > MaxV1Alpha2ReconcileConcurrencyCap {
		return MaxV1Alpha2ReconcileConcurrencyCap
	}
	return maxConcurrentReconciles
}

// SetupWithManager registers only the v1alpha2 projection and its owned Jobs.
// PVCs are intentionally not owned because their lifecycle is PR-scoped.
func (r *PRReviewJobV1Alpha2Reconciler) SetupWithManager(mgr ctrl.Manager) error {
	if err := mgr.GetFieldIndexer().IndexField(context.Background(), &reviewv1alpha2.PRReviewJob{}, queueMetricsCandidateField, queueMetricsCandidateValues); err != nil {
		return fmt.Errorf("index queue metric candidates: %w", err)
	}
	if err := mgr.Add(&workerMetricsCollector{reader: mgr.GetClient()}); err != nil {
		return err
	}
	if r.APIReader == nil {
		r.APIReader = mgr.GetAPIReader()
	}
	maxConcurrentReconciles := r.ClampedMaxConcurrentReconciles()
	return ctrl.NewControllerManagedBy(mgr).
		For(&reviewv1alpha2.PRReviewJob{}).
		Owns(&batchv1.Job{}).
		// MaxConcurrentReconciles allows parallel reconciliation (pod reaping,
		// status updates, terminal cleanup, receipt handling) across reviews.
		// Workload admission is coordinated declaratively via CapacityLedger
		// using atomic Compare-And-Swap (CAS) optimistic locking on the
		// singleton coordination.k8s.io/v1 Lease in ct-review-system, eliminating
		// intra-instance mutex lock convoys and providing multi-replica admission safety.
		WithOptions(controller.Options{MaxConcurrentReconciles: maxConcurrentReconciles}).
		Complete(r)
}
