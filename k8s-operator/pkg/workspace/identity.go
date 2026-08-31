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
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

const (
	WorkspaceKeyVersion    = "review-yeti-workspace-v1"
	WorkspaceHashLabel     = "review-yeti.ai/workspace-hash"
	RepositoryIDLabel      = "review-yeti.ai/repository-id"
	PRNumberLabel          = "review-yeti.ai/pr-number"
	WorkspaceKeyAnnotation = "review-yeti.ai/workspace-key"
	LastUsedAtAnnotation   = "review-yeti.ai/last-used-at"
	ProtectionFinalizer    = "review-yeti.ai/workspace-protection"
	StorageClassName       = "do-block-storage"
)

var (
	ErrWorkspaceIdentity    = errors.New("workspace identity mismatch")
	ErrWorkspaceTerminating = errors.New("workspace resource is terminating")
)

// Key identifies a reusable workspace by repository and pull request, not by head SHA.
func Key(repositoryID int64, prNumber int32) string {
	if repositoryID <= 0 || prNumber <= 0 {
		return ""
	}
	payload := fmt.Sprintf("%s\n%d\n%d", WorkspaceKeyVersion, repositoryID, prNumber)
	digest := sha256.Sum256([]byte(payload))
	return hex.EncodeToString(digest[:])
}

func PVCName(repositoryID int64, prNumber int32) string {
	key := Key(repositoryID, prNumber)
	if key == "" {
		return ""
	}
	return fmt.Sprintf("ct-review-ws-%d-%s", prNumber, key[:20])
}

func LeaseName(repositoryID int64, prNumber int32) string {
	key := Key(repositoryID, prNumber)
	if key == "" {
		return ""
	}
	return fmt.Sprintf("ct-review-lease-%d-%s", prNumber, key[:20])
}

// Metadata stores the full 64-character identity in an annotation because a
// Kubernetes label value is limited to 63 characters.
func Metadata(repositoryID int64, prNumber int32) (map[string]string, map[string]string) {
	key := Key(repositoryID, prNumber)
	if key == "" {
		return nil, nil
	}
	return map[string]string{
		"app.kubernetes.io/name": "review-yeti-workspace",
		WorkspaceHashLabel:       key[:63],
		RepositoryIDLabel:        strconv.FormatInt(repositoryID, 10),
		PRNumberLabel:            strconv.FormatInt(int64(prNumber), 10),
	}, map[string]string{
		WorkspaceKeyAnnotation: key,
	}
}

func ValidateMetadata(metadata metav1.ObjectMeta, namespace, name string, repositoryID int64, prNumber int32) error {
	key := Key(repositoryID, prNumber)
	if key == "" || metadata.Namespace != namespace || metadata.Name != name {
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
