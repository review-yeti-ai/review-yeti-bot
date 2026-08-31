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
	"errors"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/validation"
)

var ErrWorkspaceConfiguration = errors.New("workspace configuration mismatch")

func BuildPVC(namespace string, repositoryID int64, prNumber int32, now time.Time) (*corev1.PersistentVolumeClaim, error) {
	if len(validation.IsDNS1123Label(namespace)) != 0 || Key(repositoryID, prNumber) == "" || now.IsZero() {
		return nil, ErrWorkspaceConfiguration
	}
	labels, annotations := Metadata(repositoryID, prNumber)
	annotations[LastUsedAtAnnotation] = now.UTC().Format(time.RFC3339Nano)
	storageClass := StorageClassName
	return &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{
			Name:        PVCName(repositoryID, prNumber),
			Namespace:   namespace,
			Labels:      labels,
			Annotations: annotations,
			Finalizers:  []string{ProtectionFinalizer},
		},
		Spec: corev1.PersistentVolumeClaimSpec{
			AccessModes:      []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce},
			StorageClassName: &storageClass,
			Resources: corev1.VolumeResourceRequirements{
				Requests: corev1.ResourceList{corev1.ResourceStorage: resource.MustParse("1Gi")},
			},
		},
	}, nil
}

func ValidatePVC(pvc *corev1.PersistentVolumeClaim, namespace string, repositoryID int64, prNumber int32) error {
	if pvc == nil {
		return ErrWorkspaceConfiguration
	}
	if pvc.DeletionTimestamp != nil {
		return ErrWorkspaceTerminating
	}
	if err := ValidateMetadata(pvc.ObjectMeta, namespace, PVCName(repositoryID, prNumber), repositoryID, prNumber); err != nil {
		return err
	}
	if len(pvc.OwnerReferences) != 0 || pvc.Spec.StorageClassName == nil || *pvc.Spec.StorageClassName != StorageClassName {
		return ErrWorkspaceConfiguration
	}
	if len(pvc.Spec.AccessModes) != 1 || pvc.Spec.AccessModes[0] != corev1.ReadWriteOnce {
		return ErrWorkspaceConfiguration
	}
	storage, ok := pvc.Spec.Resources.Requests[corev1.ResourceStorage]
	if !ok || storage.Cmp(resource.MustParse("1Gi")) != 0 {
		return ErrWorkspaceConfiguration
	}
	protected := false
	for _, finalizer := range pvc.Finalizers {
		if finalizer == ProtectionFinalizer {
			protected = true
			break
		}
	}
	if !protected {
		return ErrWorkspaceConfiguration
	}
	if _, err := time.Parse(time.RFC3339Nano, pvc.Annotations[LastUsedAtAnnotation]); err != nil {
		return ErrWorkspaceConfiguration
	}
	return nil
}
