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
	"fmt"
	"strconv"
	"strings"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/record"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	"sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/source"

	reviewv1alpha1 "github.com/calltelemetry/ct-review-bot/k8s-operator/api/v1alpha1"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/cleanup"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/metrics"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/queue"
)

// PRReviewJobReconciler reconciles a PRReviewJob object
type PRReviewJobReconciler struct {
	client.Client
	Scheme       *runtime.Scheme
	QueueManager queue.QueueManager
	Recorder     record.EventRecorder
	TTLManager   cleanup.TTLManager
}

// +kubebuilder:rbac:groups=review.calltelemetry.com,resources=prreviewjobs,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=review.calltelemetry.com,resources=prreviewjobs/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=review.calltelemetry.com,resources=prreviewjobs/finalizers,verbs=update
// +kubebuilder:rbac:groups=batch,resources=jobs,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=persistentvolumeclaims,verbs=get;list;watch;create;update;patch;delete

func (r *PRReviewJobReconciler) syncMetrics() {
	if r.QueueManager != nil {
		metrics.UpdateQueueMetrics(r.QueueManager.GetActiveCount(), r.QueueManager.GetQueuedCount())
	}
}

func (r *PRReviewJobReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	logger := log.FromContext(ctx)

	var job reviewv1alpha1.PRReviewJob
	if err := r.Get(ctx, req.NamespacedName, &job); err != nil {
		if errors.IsNotFound(err) {
			if r.QueueManager != nil {
				r.QueueManager.RemoveJob(req.NamespacedName)
			}
			r.syncMetrics()
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, err
	}

	initialPhase := job.Status.Phase
	// Apply API Defaults
	job.SetDefaults()

	// Handle completed terminal phases
	if job.Status.Phase == reviewv1alpha1.PhaseSucceeded || job.Status.Phase == reviewv1alpha1.PhaseFailed {
		ttlMgr := r.TTLManager
		if ttlMgr == nil {
			ttlMgr = cleanup.NewTTLManager()
		}

		expired, remaining := ttlMgr.IsTTLExpired(&job, time.Now())
		if expired {
			logger.Info("TTL expired for completed PRReviewJob, executing garbage collection", "job", job.Name, "ttlSeconds", job.GetTTLSeconds())
			if err := ttlMgr.CleanupResources(ctx, r.Client, &job); err != nil {
				logger.Error(err, "Failed to garbage collect resources for completed PRReviewJob", "job", job.Name)
				return ctrl.Result{}, err
			}
			if r.QueueManager != nil {
				r.QueueManager.RemoveJob(req.NamespacedName)
			}
			r.syncMetrics()
			return ctrl.Result{}, nil
		}

		if remaining > 0 {
			logger.Info("PRReviewJob completed, scheduling TTL cleanup requeue", "job", job.Name, "requeueAfter", remaining)
			r.syncMetrics()
			return ctrl.Result{RequeueAfter: remaining}, nil
		}

		r.syncMetrics()
		return ctrl.Result{}, nil
	}

	// Concurrency slot acquisition
	if r.QueueManager != nil {
		allowed, _ := r.QueueManager.AcquireSlot(req.NamespacedName)
		if !allowed {
			if initialPhase != reviewv1alpha1.PhaseQueued {
				job.Status.Phase = reviewv1alpha1.PhaseQueued
				job.Status.Message = "Job queued waiting for available concurrency slot"
				meta.SetStatusCondition(&job.Status.Conditions, metav1.Condition{
					Type:               "Queued",
					Status:             metav1.ConditionTrue,
					Reason:             "QuotaExceeded",
					Message:            "Job queued waiting for available concurrency slot",
					LastTransitionTime: metav1.Now(),
				})
				if err := r.Status().Update(ctx, &job); err != nil {
					return ctrl.Result{}, err
				}
			}
			r.syncMetrics()
			return ctrl.Result{}, nil
		}
	}

	// Ensure PVC exists
	pvcName := fmt.Sprintf("%s-pvc", job.Name)
	var pvc corev1.PersistentVolumeClaim
	err := r.Get(ctx, types.NamespacedName{Name: pvcName, Namespace: job.Namespace}, &pvc)
	if errors.IsNotFound(err) {
		pvcObj := r.buildPVC(&job, pvcName)
		if err := r.Create(ctx, pvcObj); err != nil {
			logger.Error(err, "Failed to create PVC", "pvc", pvcName)
			return ctrl.Result{}, err
		}
		logger.Info("Created PersistentVolumeClaim", "pvc", pvcName)
	} else if err != nil {
		return ctrl.Result{}, err
	}

	// Ensure batch/v1 Job exists
	jobName := fmt.Sprintf("%s-job", job.Name)
	var k8sJob batchv1.Job
	err = r.Get(ctx, types.NamespacedName{Name: jobName, Namespace: job.Namespace}, &k8sJob)
	if errors.IsNotFound(err) {
		k8sJobObj := r.buildJob(&job, jobName, pvcName)
		if err := r.Create(ctx, k8sJobObj); err != nil {
			logger.Error(err, "Failed to create batch/v1 Job", "job", jobName)
			return ctrl.Result{}, err
		}
		logger.Info("Created batch/v1 Job", "job", jobName)

		// Update CR status to Running
		now := metav1.Now()
		job.Status.Phase = reviewv1alpha1.PhaseRunning
		job.Status.JobName = jobName
		job.Status.PVCName = pvcName
		job.Status.StartTime = &now
		job.Status.Message = "Worker Job created and running"

		// Initialize Persona Progress
		job.Status.PersonaProgress = make([]reviewv1alpha1.PersonaProgress, len(job.Spec.PersonaRoster))
		job.Status.PersonaProgressMap = make(map[string]string, len(job.Spec.PersonaRoster))
		for i, persona := range job.Spec.PersonaRoster {
			job.Status.PersonaProgress[i] = reviewv1alpha1.PersonaProgress{
				Persona: persona,
				Status:  "Running",
			}
			job.Status.PersonaProgressMap[persona] = "Running"
		}

		meta.SetStatusCondition(&job.Status.Conditions, metav1.Condition{
			Type:               "JobDispatched",
			Status:             metav1.ConditionTrue,
			Reason:             "PodCreated",
			Message:            "Worker Job spawned successfully",
			LastTransitionTime: now,
		})

		if err := r.Status().Update(ctx, &job); err != nil {
			return ctrl.Result{}, err
		}
		r.syncMetrics()
		return ctrl.Result{}, nil
	} else if err != nil {
		return ctrl.Result{}, err
	}

	// Check underlying batch/v1 Job execution status
	if k8sJob.Status.Succeeded > 0 {
		now := metav1.Now()
		job.Status.Phase = reviewv1alpha1.PhaseSucceeded
		job.Status.CompletionTime = &now
		job.Status.Verdict = CalculateVerdict(&job, false)
		job.Status.Message = "All persona reviews completed successfully"

		for i := range job.Status.PersonaProgress {
			job.Status.PersonaProgress[i].Status = "Completed"
			job.Status.PersonaProgress[i].FinishedAt = &now
		}
		if job.Status.PersonaProgressMap == nil {
			job.Status.PersonaProgressMap = make(map[string]string)
		}
		for _, persona := range job.Spec.PersonaRoster {
			job.Status.PersonaProgressMap[persona] = "Completed"
		}

		meta.SetStatusCondition(&job.Status.Conditions, metav1.Condition{
			Type:               "Succeeded",
			Status:             metav1.ConditionTrue,
			Reason:             "JobCompletedSuccessfully",
			Message:            "Worker Job completed with success",
			LastTransitionTime: now,
		})

		if r.QueueManager != nil {
			r.QueueManager.ReleaseSlot(req.NamespacedName)
		}
		if err := r.Status().Update(ctx, &job); err != nil {
			return ctrl.Result{}, err
		}

		if job.Status.StartTime != nil {
			duration := job.Status.CompletionTime.Sub(job.Status.StartTime.Time).Seconds()
			metrics.RecordJobDuration(duration)
		}
		r.syncMetrics()

		ttlMgr := r.TTLManager
		if ttlMgr == nil {
			ttlMgr = cleanup.NewTTLManager()
		}
		expired, remaining := ttlMgr.IsTTLExpired(&job, time.Now())
		if expired {
			logger.Info("TTL expired for completed PRReviewJob, executing garbage collection", "job", job.Name, "ttlSeconds", job.GetTTLSeconds())
			if err := ttlMgr.CleanupResources(ctx, r.Client, &job); err != nil {
				logger.Error(err, "Failed to garbage collect resources for completed PRReviewJob", "job", job.Name)
				return ctrl.Result{}, err
			}
			if r.QueueManager != nil {
				r.QueueManager.RemoveJob(req.NamespacedName)
			}
			r.syncMetrics()
			return ctrl.Result{}, nil
		}

		if remaining > 0 {
			logger.Info("PRReviewJob completed, scheduling TTL cleanup requeue", "job", job.Name, "requeueAfter", remaining)
			return ctrl.Result{RequeueAfter: remaining}, nil
		}

		return ctrl.Result{}, nil
	}

	if k8sJob.Status.Failed > 0 {
		now := metav1.Now()
		job.Status.Phase = reviewv1alpha1.PhaseFailed
		job.Status.CompletionTime = &now
		job.Status.Verdict = CalculateVerdict(&job, true)
		job.Status.Message = "Worker Job execution failed"

		for i := range job.Status.PersonaProgress {
			if job.Status.PersonaProgress[i].Status != "Completed" {
				job.Status.PersonaProgress[i].Status = "Failed"
				job.Status.PersonaProgress[i].FinishedAt = &now
			}
		}
		if job.Status.PersonaProgressMap == nil {
			job.Status.PersonaProgressMap = make(map[string]string)
		}
		for _, persona := range job.Spec.PersonaRoster {
			if job.Status.PersonaProgressMap[persona] != "Completed" {
				job.Status.PersonaProgressMap[persona] = "Failed"
			}
		}

		meta.SetStatusCondition(&job.Status.Conditions, metav1.Condition{
			Type:               "Failed",
			Status:             metav1.ConditionTrue,
			Reason:             "JobExecutionFailed",
			Message:            "Worker Job encountered failure",
			LastTransitionTime: now,
		})

		if r.QueueManager != nil {
			r.QueueManager.ReleaseSlot(req.NamespacedName)
		}
		if err := r.Status().Update(ctx, &job); err != nil {
			return ctrl.Result{}, err
		}

		if job.Status.StartTime != nil {
			duration := job.Status.CompletionTime.Sub(job.Status.StartTime.Time).Seconds()
			metrics.RecordJobDuration(duration)
		}
		r.syncMetrics()

		ttlMgr := r.TTLManager
		if ttlMgr == nil {
			ttlMgr = cleanup.NewTTLManager()
		}
		expired, remaining := ttlMgr.IsTTLExpired(&job, time.Now())
		if expired {
			logger.Info("TTL expired for completed PRReviewJob, executing garbage collection", "job", job.Name, "ttlSeconds", job.GetTTLSeconds())
			if err := ttlMgr.CleanupResources(ctx, r.Client, &job); err != nil {
				logger.Error(err, "Failed to garbage collect resources for completed PRReviewJob", "job", job.Name)
				return ctrl.Result{}, err
			}
			if r.QueueManager != nil {
				r.QueueManager.RemoveJob(req.NamespacedName)
			}
			r.syncMetrics()
			return ctrl.Result{}, nil
		}

		if remaining > 0 {
			logger.Info("PRReviewJob completed, scheduling TTL cleanup requeue", "job", job.Name, "requeueAfter", remaining)
			return ctrl.Result{RequeueAfter: remaining}, nil
		}

		return ctrl.Result{}, nil
	}

	r.syncMetrics()
	return ctrl.Result{}, nil
}

func (r *PRReviewJobReconciler) buildPVC(job *reviewv1alpha1.PRReviewJob, pvcName string) *corev1.PersistentVolumeClaim {
	storageSize := job.GetPVCStorageSize()
	pvc := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{
			Name:      pvcName,
			Namespace: job.Namespace,
			Labels: map[string]string{
				"app.kubernetes.io/name":       "prreviewjob",
				"app.kubernetes.io/instance":   job.Name,
				"app.kubernetes.io/managed-by": "k8s-operator",
			},
		},
		Spec: corev1.PersistentVolumeClaimSpec{
			AccessModes: []corev1.PersistentVolumeAccessMode{
				corev1.ReadWriteOnce,
			},
			Resources: corev1.VolumeResourceRequirements{
				Requests: corev1.ResourceList{
					corev1.ResourceStorage: resource.MustParse(storageSize),
				},
			},
		},
	}
	if r.Scheme != nil {
		_ = controllerutil.SetControllerReference(job, pvc, r.Scheme)
	}
	return pvc
}

func (r *PRReviewJobReconciler) buildJob(job *reviewv1alpha1.PRReviewJob, jobName, pvcName string) *batchv1.Job {
	backoffLimit := int32(1)
	ttl := job.GetTTLSeconds()

	k8sJob := &batchv1.Job{
		ObjectMeta: metav1.ObjectMeta{
			Name:      jobName,
			Namespace: job.Namespace,
			Labels: map[string]string{
				"app.kubernetes.io/name":       "prreviewjob",
				"app.kubernetes.io/instance":   job.Name,
				"app.kubernetes.io/managed-by": "k8s-operator",
			},
		},
		Spec: batchv1.JobSpec{
			TTLSecondsAfterFinished: &ttl,
			BackoffLimit:            &backoffLimit,
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{
					Labels: map[string]string{
						"app.kubernetes.io/name":     "prreviewjob-worker",
						"app.kubernetes.io/instance": job.Name,
					},
				},
				Spec: corev1.PodSpec{
					RestartPolicy: corev1.RestartPolicyNever,
					Volumes: []corev1.Volume{
						{
							Name: "workspace",
							VolumeSource: corev1.VolumeSource{
								PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{
									ClaimName: pvcName,
								},
							},
						},
					},
					Containers: []corev1.Container{
						{
							Name:            "reviewer-worker",
							Image:           "ghcr.io/calltelemetry/ct-review-worker:latest",
							ImagePullPolicy: corev1.PullIfNotPresent,
							VolumeMounts: []corev1.VolumeMount{
								{
									Name:      "workspace",
									MountPath: "/workspace",
								},
							},
							Env: []corev1.EnvVar{
								{Name: "REPO", Value: job.Spec.Repo},
								{Name: "PR_NUMBER", Value: strconv.Itoa(int(job.Spec.PRNumber))},
								{Name: "HEAD_SHA", Value: job.Spec.HeadSHA},
								{Name: "BASE_SHA", Value: job.Spec.BaseSHA},
								{Name: "PERSONA_ROSTER", Value: strings.Join(job.Spec.PersonaRoster, ",")},
							},
						},
					},
				},
			},
		},
	}
	if r.Scheme != nil {
		_ = controllerutil.SetControllerReference(job, k8sJob, r.Scheme)
	}
	return k8sJob
}

func (r *PRReviewJobReconciler) SetupWithManager(mgr ctrl.Manager) error {
	builder := ctrl.NewControllerManagedBy(mgr).
		For(&reviewv1alpha1.PRReviewJob{}).
		Owns(&corev1.PersistentVolumeClaim{}).
		Owns(&batchv1.Job{})

	if r.QueueManager != nil && r.QueueManager.EventChannel() != nil {
		builder = builder.WatchesRawSource(
			source.Channel(r.QueueManager.EventChannel(), &handler.EnqueueRequestForObject{}),
		)
	}

	return builder.Complete(r)
}

// CalculateVerdict inspects job.Status.PersonaProgress and job.Status.PersonaProgressMap
// to determine the overall review verdict (precedence: FAILED > CHANGES_REQUESTED > COMMENT > APPROVED).
func CalculateVerdict(job *reviewv1alpha1.PRReviewJob, jobFailed bool) string {
	if jobFailed {
		return reviewv1alpha1.VerdictFailed
	}
	if job == nil {
		return reviewv1alpha1.VerdictApproved
	}

	hasFailed := false
	hasChangesRequested := false
	hasComment := false

	checkString := func(s string) {
		if s == "" {
			return
		}
		upper := strings.ToUpper(strings.TrimSpace(s))
		if upper == reviewv1alpha1.VerdictFailed || upper == "FAILED" || upper == "FAIL" || strings.Contains(upper, "FAILED") {
			hasFailed = true
		} else if upper == reviewv1alpha1.VerdictChangesRequested || upper == "CHANGES_REQUESTED" || strings.Contains(upper, "CHANGES_REQUESTED") || strings.Contains(upper, "CHANGES REQUESTED") {
			hasChangesRequested = true
		} else if upper == reviewv1alpha1.VerdictComment || upper == "COMMENT" || strings.Contains(upper, "COMMENT") {
			hasComment = true
		}
	}

	for _, p := range job.Status.PersonaProgress {
		checkString(p.Status)
		checkString(p.Message)
	}
	for _, s := range job.Status.PersonaProgressMap {
		checkString(s)
	}

	if hasFailed {
		return reviewv1alpha1.VerdictFailed
	}
	if hasChangesRequested {
		return reviewv1alpha1.VerdictChangesRequested
	}
	if hasComment {
		return reviewv1alpha1.VerdictComment
	}

	return reviewv1alpha1.VerdictApproved
}
