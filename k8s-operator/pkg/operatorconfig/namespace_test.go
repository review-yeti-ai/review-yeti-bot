package operatorconfig

import "testing"

func lookup(values map[string]string) func(string) (string, bool) {
	return func(key string) (string, bool) {
		value, present := values[key]
		return value, present
	}
}

func TestNamespaceConfigFromEnv(t *testing.T) {
	tests := []struct {
		name          string
		env           map[string]string
		wantNamespace string
		wantQual      bool
		wantErr       bool
	}{
		{name: "production default", env: nil, wantNamespace: DefaultNamespace},
		{name: "production downward identity", env: map[string]string{PodNamespaceEnv: DefaultNamespace}, wantNamespace: DefaultNamespace},
		{name: "explicit production namespace", env: map[string]string{NamespaceEnv: DefaultNamespace, PodNamespaceEnv: DefaultNamespace}, wantNamespace: DefaultNamespace},
		{name: "qualified isolated instance", env: map[string]string{QualificationInstanceEnv: "true", NamespaceEnv: QualificationNamespace,
			PodNamespaceEnv: QualificationNamespace}, wantNamespace: QualificationNamespace, wantQual: true},
		{name: "empty namespace override", env: map[string]string{NamespaceEnv: ""}, wantErr: true},
		{name: "empty qualification marker", env: map[string]string{QualificationInstanceEnv: ""}, wantErr: true},
		{name: "qualification namespace without marker", env: map[string]string{NamespaceEnv: QualificationNamespace,
			PodNamespaceEnv: QualificationNamespace}, wantErr: true},
		{name: "wrong marker spelling", env: map[string]string{QualificationInstanceEnv: "TRUE", NamespaceEnv: QualificationNamespace,
			PodNamespaceEnv: QualificationNamespace}, wantErr: true},
		{name: "marker cannot select production namespace", env: map[string]string{QualificationInstanceEnv: "true",
			NamespaceEnv: DefaultNamespace, PodNamespaceEnv: DefaultNamespace}, wantErr: true},
		{name: "qualification requires namespace override", env: map[string]string{QualificationInstanceEnv: "true",
			PodNamespaceEnv: QualificationNamespace}, wantErr: true},
		{name: "qualification requires downward identity", env: map[string]string{QualificationInstanceEnv: "true",
			NamespaceEnv: QualificationNamespace}, wantErr: true},
		{name: "qualification downward identity mismatch", env: map[string]string{QualificationInstanceEnv: "true",
			NamespaceEnv: QualificationNamespace, PodNamespaceEnv: DefaultNamespace}, wantErr: true},
		{name: "production downward identity mismatch", env: map[string]string{PodNamespaceEnv: QualificationNamespace}, wantErr: true},
		{name: "wildcard namespace", env: map[string]string{QualificationInstanceEnv: "true", NamespaceEnv: "*",
			PodNamespaceEnv: "*"}, wantErr: true},
		{name: "multiple namespaces", env: map[string]string{QualificationInstanceEnv: "true",
			NamespaceEnv:    DefaultNamespace + "," + QualificationNamespace,
			PodNamespaceEnv: DefaultNamespace + "," + QualificationNamespace}, wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := NamespaceConfigFromEnv(lookup(tt.env))
			if (err != nil) != tt.wantErr {
				t.Fatalf("NamespaceConfigFromEnv() error = %v, wantErr %v", err, tt.wantErr)
			}
			if tt.wantErr {
				return
			}
			if got.Namespace() != tt.wantNamespace || got.IsQualificationInstance() != tt.wantQual {
				t.Fatalf("NamespaceConfigFromEnv() = (%q, qualification=%v), want (%q, qualification=%v)",
					got.Namespace(), got.IsQualificationInstance(), tt.wantNamespace, tt.wantQual)
			}
		})
	}
}

func TestNamespaceConfigsRemainIsolatedValues(t *testing.T) {
	production, err := NamespaceConfigFromEnv(lookup(nil))
	if err != nil {
		t.Fatal(err)
	}
	qualification, err := NamespaceConfigFromEnv(lookup(map[string]string{
		QualificationInstanceEnv: "true",
		NamespaceEnv:             QualificationNamespace,
		PodNamespaceEnv:          QualificationNamespace,
	}))
	if err != nil {
		t.Fatal(err)
	}
	if production.Namespace() != DefaultNamespace || qualification.Namespace() != QualificationNamespace {
		t.Fatalf("namespace configs overlapped: production=%q qualification=%q", production.Namespace(), qualification.Namespace())
	}
	if production.IsQualificationInstance() || !qualification.IsQualificationInstance() {
		t.Fatalf("qualification markers overlapped: production=%v qualification=%v", production.IsQualificationInstance(), qualification.IsQualificationInstance())
	}
}
