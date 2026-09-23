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
	"testing"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"

	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/job"
)

func selectionWorker() *batchv1.Job {
	return &batchv1.Job{ObjectMeta: metav1.ObjectMeta{Name: "review-worker", Namespace: "ct-review-system", UID: types.UID("worker-uid")}}
}

func selectionPod(worker *batchv1.Job, name string, phase corev1.PodPhase, status corev1.ContainerStatus) corev1.Pod {
	controller := true
	return corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name: name, Namespace: worker.Namespace,
			OwnerReferences: []metav1.OwnerReference{{
				APIVersion: batchv1.SchemeGroupVersion.String(), Kind: "Job", Name: worker.Name,
				UID: worker.UID, Controller: &controller,
			}},
		},
		Status: corev1.PodStatus{Phase: phase, ContainerStatuses: []corev1.ContainerStatus{status}},
	}
}

func terminatedAt(exitCode int32, reason string, finishedAt time.Time) corev1.ContainerStatus {
	return corev1.ContainerStatus{
		Name: job.WorkerContainerName,
		State: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{
			ExitCode: exitCode, Reason: reason, FinishedAt: metav1.NewTime(finishedAt),
		}},
	}
}

// A retried worker Job leaves several finished Pods under one job-name label,
// and List order is not guaranteed. The record must name the attempt that
// finished last (the one that produced the outcome), whichever order the Pods
// arrive in.
func TestWorkerTerminationSelectsTheMostRecentlyFinishedPod(t *testing.T) {
	worker := selectionWorker()
	base := time.Date(2026, 9, 23, 13, 0, 0, 0, time.UTC)
	evicted := selectionPod(worker, "review-worker-first", corev1.PodFailed, terminatedAt(137, "OOMKilled", base))
	final := selectionPod(worker, "review-worker-final", corev1.PodFailed, terminatedAt(1, "Error", base.Add(2*time.Minute)))
	// A Pod with no container finish time (Pod-level failure) must not
	// displace an attempt with a known finish time.
	podLevel := selectionPod(worker, "review-worker-podlevel", corev1.PodFailed, corev1.ContainerStatus{Name: job.WorkerContainerName})
	// A Pod another Job controls never contributes.
	foreign := selectionPod(&batchv1.Job{ObjectMeta: metav1.ObjectMeta{Name: "other", Namespace: worker.Namespace, UID: "other-uid"}},
		"review-worker-foreign", corev1.PodFailed, terminatedAt(2, "Error", base.Add(time.Hour)))

	for _, order := range [][]corev1.Pod{
		{evicted, final, podLevel, foreign},
		{final, evicted, podLevel, foreign},
		{podLevel, foreign, evicted, final},
		{foreign, podLevel, final, evicted},
	} {
		record := workerTerminationFromPods(order, worker, base.Add(3*time.Minute))
		if record == nil || record.PodName != "review-worker-final" || record.ExitCode == nil || *record.ExitCode != 1 {
			names := make([]string, 0, len(order))
			for _, pod := range order {
				names = append(names, pod.Name)
			}
			t.Fatalf("order %v selected %+v, want the most recently finished attempt review-worker-final", names, record)
		}
	}
}

// A container that terminated, was restarted (resetting State), and whose Pod
// then failed keeps its exit only in LastTerminationState.
func TestWorkerTerminationReadsLastTerminationStateOfAFailedPod(t *testing.T) {
	worker := selectionWorker()
	finished := time.Date(2026, 9, 23, 13, 1, 0, 0, time.UTC)
	status := corev1.ContainerStatus{
		Name:  job.WorkerContainerName,
		State: corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: "CrashLoopBackOff"}},
		LastTerminationState: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{
			ExitCode: 137, Reason: "OOMKilled", FinishedAt: metav1.NewTime(finished),
			Message: "heap out of memory\n",
		}},
	}
	failed := selectionPod(worker, "review-worker-restarted", corev1.PodFailed, status)
	record := podTermination(&failed, finished.Add(time.Minute))
	if record == nil || record.ExitCode == nil || *record.ExitCode != 137 || record.Reason != "OOMKilled" ||
		record.Message != "heap out of memory" || record.FinishedAt == nil || !record.FinishedAt.Time.Equal(finished) {
		t.Fatalf("record = %+v, want the LastTerminationState exit (137 OOMKilled)", record)
	}

	// While the Pod is still running, a previous attempt's exit is not the
	// outcome and must not be recorded.
	running := selectionPod(worker, "review-worker-running", corev1.PodRunning, status)
	if record := podTermination(&running, finished.Add(time.Minute)); record != nil {
		t.Fatalf("running Pod produced record %+v, want none", record)
	}
}
