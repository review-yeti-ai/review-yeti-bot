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
	DefaultV1Alpha2MaxConcurrentJobs = 4
	v1Alpha2RequeueAfter             = 5 * time.Second
	v1Alpha2PVCCreateRequeue         = 1 * time.Second
)

// PRReviewJobV1Alpha2Reconciler is the disabled-by-default receipt-only
// execution controller. It owns only Jobs; PR-scoped workspace PVCs are
// deliberately ownerless so they can be reused by later heads of the same PR.
// PostgreSQL remains the lifecycle and publication authority.
type PRReviewJobV1Alpha2Reconciler struct {
	client.Client
	Scheme            *runtime.Scheme
	Now               func() time.Time
	MaxConcurrentJobs int
}

// +kubebuilder:rbac:groups=review-yeti.ai,resources=prreviewjobs,verbs=get;list;watch;update;patch
// +kubebuilder:rbac:groups=review-yeti.ai,resources=prreviewjobs/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=batch,resources=jobs,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=pods,verbs=get;list;watch
// +kubebuilder:rbac:groups="",resources=persistentvolumeclaims,verbs=get;list;watch;create;update;patch
// +kubebuilder:rbac:groups=coordination.k8s.io,resources=leases,verbs=get;list;watch;create;update;patch
func (r *PRReviewJobV1Alpha2Reconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	var review reviewv1alpha2.PRReviewJob
	if err := r.Get(ctx, req.NamespacedName, &review); err != nil {
		if apierrors.IsNotFound(err) {
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, err
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
		if _, err := observeTiming(&review, reviewv1alpha2.DispatchStageCompleted, metav1.NewTime(now)); err != nil {
			return ctrl.Result{}, r.fail(ctx, &review, "TimingContractViolation", err.Error())
		}
		r.recordDispatchTiming(&review, now)
		return ctrl.Result{}, r.setPhase(ctx, &review, reviewv1alpha2.PhaseExpired, "DeadlineExpired", "review terminal deadline has elapsed")
	}

	workerName := review.Name + "-worker"
	var existing batchv1.Job
	existingErr := r.Get(ctx, types.NamespacedName{Namespace: review.Namespace, Name: workerName}, &existing)
	if existingErr != nil && !apierrors.IsNotFound(existingErr) {
		return ctrl.Result{}, existingErr
	}
	if existingErr == nil {
		if !managedWorkerJobMatches(&review, &existing) {
			return ctrl.Result{}, r.fail(ctx, &review, "WorkerContractMismatch", "existing worker Job does not match the immutable receipt-only contract")
		}
		return r.reconcileExistingJob(ctx, &review, &existing, now)
	}

	limit := r.MaxConcurrentJobs
	if limit <= 0 {
		limit = DefaultV1Alpha2MaxConcurrentJobs
	}
	active, err := r.activeWorkerJobs(ctx, review.Namespace)
	if err != nil {
		return ctrl.Result{}, err
	}
	if active >= limit {
		if err := r.setPhase(ctx, &review, reviewv1alpha2.PhaseQueued, "CapacityExceeded", fmt.Sprintf("waiting for one of %d worker slots", limit)); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{RequeueAfter: v1Alpha2RequeueAfter}, nil
	}

	pvcName := workspace.PVCName(review.Spec.RepositoryID, review.Spec.PRNumber)
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
		return ctrl.Result{}, r.fail(ctx, &review, "WorkspaceIdentityMismatch", err.Error())
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
	if err := r.Create(ctx, worker); err != nil {
		if !apierrors.IsAlreadyExists(err) {
			return ctrl.Result{}, err
		}
		if getErr := r.Get(ctx, types.NamespacedName{Namespace: worker.Namespace, Name: worker.Name}, &existing); getErr != nil {
			return ctrl.Result{}, getErr
		}
		if !managedWorkerJobMatches(&review, &existing) {
			return ctrl.Result{}, r.fail(ctx, &review, "WorkerContractMismatch", "racing worker Job does not match the immutable receipt-only contract")
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
			review.Status.PVCName = workspace.PVCName(review.Spec.RepositoryID, review.Spec.PRNumber)
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
	return ctrl.Result{}, r.setPhase(ctx, review, reviewv1alpha2.PhaseFailed, "WorkerFailed", "receipt-only worker Job failed")
}

// observeWorkerPod records the stage timestamps that Kubernetes exposes on the
// worker Pod. ImageObservedAt is intentionally named as an observation: the
// Kubernetes API exposes an ImageID but not a durable image-pull timestamp.
// When the process start is already visible, that timestamp is the safe upper
// bound for image readiness and keeps the lifecycle receipt monotonic.
func (r *PRReviewJobV1Alpha2Reconciler) observeWorkerPod(ctx context.Context, review *reviewv1alpha2.PRReviewJob, worker *batchv1.Job, now time.Time) (bool, error) {
	var pods corev1.PodList
	if err := r.List(ctx, &pods, client.InNamespace(review.Namespace), client.MatchingLabels{
		"review-yeti.ai/run-id":    review.Spec.RunID,
		"review-yeti.ai/component": job.ReceiptOnlyWorkerComponent,
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

func (r *PRReviewJobV1Alpha2Reconciler) activeWorkerJobs(ctx context.Context, namespace string) (int, error) {
	var jobs batchv1.JobList
	selector := labels.SelectorFromSet(labels.Set{"review-yeti.ai/component": job.ReceiptOnlyWorkerComponent})
	if err := r.List(ctx, &jobs, client.InNamespace(namespace), client.MatchingLabelsSelector{Selector: selector}); err != nil {
		return 0, err
	}
	active := 0
	for i := range jobs.Items {
		if jobs.Items[i].Status.Succeeded == 0 && jobs.Items[i].Status.Failed == 0 {
			active++
		}
	}
	return active, nil
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
// collection. Returning the collector's bounded requeue allows the exact
// 30-minute idle boundary to be observed even when no further Kubernetes
// event arrives for the terminal review.
func (r *PRReviewJobV1Alpha2Reconciler) reconcileTerminalWorkspace(
	ctx context.Context,
	review *reviewv1alpha2.PRReviewJob,
) (ctrl.Result, error) {
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
	if result.Reason == workspace.RetainedActiveLease || result.Reason == workspace.RetainedActivePod {
		return ctrl.Result{RequeueAfter: v1Alpha2RequeueAfter}, nil
	}
	return ctrl.Result{}, nil
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

func (r *PRReviewJobV1Alpha2Reconciler) clock() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	return time.Now().UTC()
}

func validateProjectionWindow(review *reviewv1alpha2.PRReviewJob) error {
	if review.Spec.TerminalDeadline.Sub(review.Spec.ReceivedAt.Time) != 15*time.Minute {
		return errors.New("terminal deadline must be exactly 15 minutes after receivedAt")
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
	if worker.Labels["review-yeti.ai/run-id"] != review.Spec.RunID || worker.Labels["review-yeti.ai/publication-mode"] != "disabled" {
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
	for _, volume := range worker.Spec.Template.Spec.Volumes {
		if volume.Name == "workspace" && volume.PersistentVolumeClaim != nil {
			return volume.PersistentVolumeClaim.ClaimName == workspace.PVCName(review.Spec.RepositoryID, review.Spec.PRNumber)
		}
	}
	return false
}

func managedWorkerEnvMatches(review *reviewv1alpha2.PRReviewJob, env []corev1.EnvVar) bool {
	receiptOnly := envValue(env, job.ReceiptOnlyEnv)
	fullPanel := envValue(env, job.FullPanelQualificationEnv)
	model := envValue(env, job.QualificationModelEnv)
	if review.Spec.QualificationProfile == job.FullPanelQualificationProfile {
		if receiptOnly != "" || fullPanel != "true" || model != review.Spec.QualificationModel {
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
	if receiptOnly != "true" || fullPanel != "" || model != "" {
		return false
	}
	for _, variable := range env {
		if variable.Name == "OPENROUTER_API_KEY" {
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
	return ctrl.NewControllerManagedBy(mgr).
		For(&reviewv1alpha2.PRReviewJob{}).
		Owns(&batchv1.Job{}).
		// Serializing admission makes the API-backed active-job count an
		// effective four-slot gate. Leader election in main.go ensures only one
		// operator instance performs this admission at a time.
		WithOptions(controller.Options{MaxConcurrentReconciles: 1}).
		Complete(r)
}
