// Package operatorconfig contains immutable, startup-only operator settings.
package operatorconfig

import (
	"fmt"
	"strings"

	"k8s.io/apimachinery/pkg/util/validation"
)

const (
	DefaultNamespace       = "ct-review-system"
	QualificationNamespace = "ct-review-qualification"

	QualificationInstanceEnv = "REVIEW_YETI_QUALIFICATION_INSTANCE"
	NamespaceEnv             = "REVIEW_YETI_OPERATOR_NAMESPACE"
	PodNamespaceEnv          = "POD_NAMESPACE"
)

// NamespaceConfig is a validated, immutable operator instance namespace.
// Its zero value selects the production namespace so existing direct builders
// and unit callers retain their production behavior.
type NamespaceConfig struct {
	namespace             string
	qualificationInstance bool
}

// Namespace returns the one namespace this operator instance may read or write.
func (c NamespaceConfig) Namespace() string {
	if c.namespace == "" {
		return DefaultNamespace
	}
	return c.namespace
}

// IsQualificationInstance reports whether this configuration was explicitly
// admitted as the isolated qualification operator.
func (c NamespaceConfig) IsQualificationInstance() bool { return c.qualificationInstance }

// NamespaceConfigFromEnv validates the exact qualification opt-in and binds it
// to the pod's trusted Downward API identity. Production defaults to one
// namespace; no wildcard or multi-namespace mode exists.
func NamespaceConfigFromEnv(lookupEnv func(string) (string, bool)) (NamespaceConfig, error) {
	if lookupEnv == nil {
		return NamespaceConfig{}, nil
	}
	marker, markerSet := lookupEnv(QualificationInstanceEnv)
	namespace, namespaceSet := lookupEnv(NamespaceEnv)
	podNamespace, podNamespaceSet := lookupEnv(PodNamespaceEnv)

	if markerSet && marker != "true" {
		return NamespaceConfig{}, fmt.Errorf("%s must be exactly true when set", QualificationInstanceEnv)
	}
	if namespaceSet && (namespace == "" || strings.TrimSpace(namespace) != namespace) {
		return NamespaceConfig{}, fmt.Errorf("%s must be a non-empty exact namespace when set", NamespaceEnv)
	}
	if podNamespaceSet && (podNamespace == "" || strings.TrimSpace(podNamespace) != podNamespace) {
		return NamespaceConfig{}, fmt.Errorf("%s must be a non-empty exact namespace when set", PodNamespaceEnv)
	}
	if namespaceSet && len(validation.IsDNS1123Label(namespace)) != 0 {
		return NamespaceConfig{}, fmt.Errorf("%s is not a valid Kubernetes namespace", NamespaceEnv)
	}
	if podNamespaceSet && len(validation.IsDNS1123Label(podNamespace)) != 0 {
		return NamespaceConfig{}, fmt.Errorf("%s is not a valid Kubernetes namespace", PodNamespaceEnv)
	}

	if markerSet {
		if !namespaceSet || namespace != QualificationNamespace {
			return NamespaceConfig{}, fmt.Errorf("%s=true requires %s=%s", QualificationInstanceEnv, NamespaceEnv, QualificationNamespace)
		}
		if !podNamespaceSet || podNamespace != namespace {
			return NamespaceConfig{}, fmt.Errorf("%s must match the qualified operator namespace %s", PodNamespaceEnv, namespace)
		}
		return NamespaceConfig{namespace: QualificationNamespace, qualificationInstance: true}, nil
	}

	selected := DefaultNamespace
	if namespaceSet {
		if namespace != DefaultNamespace {
			return NamespaceConfig{}, fmt.Errorf("%s may select only %s without qualification opt-in", NamespaceEnv, DefaultNamespace)
		}
		selected = namespace
	}
	if podNamespaceSet && podNamespace != selected {
		return NamespaceConfig{}, fmt.Errorf("%s must match the default operator namespace %s", PodNamespaceEnv, selected)
	}
	return NamespaceConfig{namespace: selected}, nil
}
