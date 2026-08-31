package workspace_test

import (
	"errors"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/workspace"
)

func TestBuildPVCIsPRScopedReusableAndUnowned(t *testing.T) {
	now := time.Date(2026, 8, 30, 20, 0, 0, 123, time.UTC)
	pvc, err := workspace.BuildPVC("ct-review-system", 123, 42, now)
	if err != nil {
		t.Fatalf("build PVC: %v", err)
	}
	if pvc.Name != workspace.PVCName(123, 42) || pvc.Namespace != "ct-review-system" {
		t.Fatalf("unexpected PVC identity: %s/%s", pvc.Namespace, pvc.Name)
	}
	if len(pvc.OwnerReferences) != 0 {
		t.Fatal("reusable workspace PVC must not have a per-run owner reference")
	}
	if len(pvc.Finalizers) != 1 || pvc.Finalizers[0] != workspace.ProtectionFinalizer {
		t.Fatalf("workspace protection finalizer missing: %v", pvc.Finalizers)
	}
	if pvc.Spec.StorageClassName == nil || *pvc.Spec.StorageClassName != workspace.StorageClassName {
		t.Fatalf("storage class = %v", pvc.Spec.StorageClassName)
	}
	if len(pvc.Spec.AccessModes) != 1 || pvc.Spec.AccessModes[0] != corev1.ReadWriteOnce {
		t.Fatalf("access modes = %v, want ReadWriteOnce", pvc.Spec.AccessModes)
	}
	if pvc.Spec.Resources.Requests.Storage().Cmp(resource.MustParse("1Gi")) != 0 {
		t.Fatalf("storage request = %s, want 1Gi", pvc.Spec.Resources.Requests.Storage().String())
	}
	if pvc.Annotations[workspace.LastUsedAtAnnotation] != now.Format(time.RFC3339Nano) {
		t.Fatalf("last-used-at = %q", pvc.Annotations[workspace.LastUsedAtAnnotation])
	}
	if err := workspace.ValidatePVC(pvc, "ct-review-system", 123, 42); err != nil {
		t.Fatalf("valid PVC rejected: %v", err)
	}
}

func TestTerminatingPVCIsNeverAcquired(t *testing.T) {
	pvc, err := workspace.BuildPVC("ct-review-system", 123, 42, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	now := metav1.Now()
	pvc.DeletionTimestamp = &now
	if err := workspace.ValidatePVC(pvc, "ct-review-system", 123, 42); !errors.Is(err, workspace.ErrWorkspaceTerminating) {
		t.Fatalf("terminating PVC error = %v, want ErrWorkspaceTerminating", err)
	}
}

func TestValidatePVCRejectsIdentityStorageAndOwnershipExpansion(t *testing.T) {
	base, err := workspace.BuildPVC("ct-review-system", 123, 42, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	tests := map[string]func(*corev1.PersistentVolumeClaim){
		"cross-pr annotation": func(pvc *corev1.PersistentVolumeClaim) {
			pvc.Annotations[workspace.WorkspaceKeyAnnotation] = workspace.Key(123, 43)
		},
		"wrong storage class": func(pvc *corev1.PersistentVolumeClaim) {
			other := "attacker-storage"
			pvc.Spec.StorageClassName = &other
		},
		"wrong access mode": func(pvc *corev1.PersistentVolumeClaim) {
			pvc.Spec.AccessModes = []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany}
		},
		"wrong size": func(pvc *corev1.PersistentVolumeClaim) {
			pvc.Spec.Resources.Requests[corev1.ResourceStorage] = resource.MustParse("2Gi")
		},
		"per-run owner":      func(pvc *corev1.PersistentVolumeClaim) { pvc.OwnerReferences = []metav1.OwnerReference{{Name: "run"}} },
		"missing protection": func(pvc *corev1.PersistentVolumeClaim) { pvc.Finalizers = nil },
		"invalid last-used timestamp": func(pvc *corev1.PersistentVolumeClaim) {
			pvc.Annotations[workspace.LastUsedAtAnnotation] = "not-a-timestamp"
		},
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			pvc := base.DeepCopy()
			mutate(pvc)
			if err := workspace.ValidatePVC(pvc, "ct-review-system", 123, 42); err == nil {
				t.Fatal("expanded or mismatched PVC must be rejected")
			}
		})
	}
}
