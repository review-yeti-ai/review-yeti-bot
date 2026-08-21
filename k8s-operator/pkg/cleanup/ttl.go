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

package cleanup

import (
	"context"
	"fmt"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"

	reviewv1alpha1 "github.com/calltelemetry/ct-review-bot/k8s-operator/api/v1alpha1"
)

// TTLManager defines methods for evaluating TTL expiration and executing garbage collection.
type TTLManager interface {
	IsTTLExpired(job *reviewv1alpha1.PRReviewJob, now time.Time) (expired bool, remaining time.Duration)
	CleanupResources(ctx context.Context, c client.Client, job *reviewv1alpha1.PRReviewJob) error
}

type DefaultTTLManager struct{}

func NewTTLManager() TTLManager {
	return &DefaultTTLManager{}
}

// IsTTLExpired evaluates whether a completed job's TTL has elapsed.
func (m *DefaultTTLManager) IsTTLExpired(job *reviewv1alpha1.PRReviewJob, now time.Time) (bool, time.Duration) {
	if job == nil || (job.Status.Phase != reviewv1alpha1.PhaseSucceeded && job.Status.Phase != reviewv1alpha1.PhaseFailed) {
		return false, 0
	}
	if job.Status.CompletionTime == nil {
		return false, 0
	}

	ttlSec := job.GetTTLSeconds()
	if ttlSec <= 0 {
		return true, 0
	}

	ttlDuration := time.Duration(ttlSec) * time.Second
	expirationTime := job.Status.CompletionTime.Add(ttlDuration)

	if !now.Before(expirationTime) {
		return true, 0
	}

	return false, expirationTime.Sub(now)
}

// CleanupResources deletes child batch/v1 Job, PVC, and the PRReviewJob CR.
func (m *DefaultTTLManager) CleanupResources(ctx context.Context, c client.Client, job *reviewv1alpha1.PRReviewJob) error {
	if job == nil {
		return nil
	}

	namespace := job.Namespace
	jobName := fmt.Sprintf("%s-job", job.Name)
	pvcName := fmt.Sprintf("%s-pvc", job.Name)

	// 1. Delete batch/v1 Job (DeletePropagationBackground ensures Pods are GC'd)
	var k8sJob batchv1.Job
	err := c.Get(ctx, types.NamespacedName{Namespace: namespace, Name: jobName}, &k8sJob)
	if err == nil {
		propagation := metav1.DeletePropagationBackground
		if err := c.Delete(ctx, &k8sJob, &client.DeleteOptions{PropagationPolicy: &propagation}); err != nil && !errors.IsNotFound(err) {
			return fmt.Errorf("failed to delete batch/v1 job %s: %w", jobName, err)
		}
	} else if !errors.IsNotFound(err) {
		return fmt.Errorf("failed to fetch batch/v1 job %s: %w", jobName, err)
	}

	// 2. Delete PersistentVolumeClaim
	var pvc corev1.PersistentVolumeClaim
	err = c.Get(ctx, types.NamespacedName{Namespace: namespace, Name: pvcName}, &pvc)
	if err == nil {
		if err := c.Delete(ctx, &pvc); err != nil && !errors.IsNotFound(err) {
			return fmt.Errorf("failed to delete pvc %s: %w", pvcName, err)
		}
	} else if !errors.IsNotFound(err) {
		return fmt.Errorf("failed to fetch pvc %s: %w", pvcName, err)
	}

	// 3. Delete PRReviewJob custom resource
	if err := c.Delete(ctx, job); err != nil && !errors.IsNotFound(err) {
		return fmt.Errorf("failed to delete PRReviewJob %s: %w", job.Name, err)
	}

	return nil
}
