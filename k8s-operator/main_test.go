package main

import (
	"os"
	"os/exec"
	"strings"
	"testing"

	ctrl "sigs.k8s.io/controller-runtime"
)

func TestMainInitializesControllerRuntimeLogger(t *testing.T) {
	const (
		helperEnv = "REVIEW_YETI_TEST_MAIN_LOGGER_HELPER"
		probe     = "controller-runtime logger probe"
	)
	if os.Getenv(helperEnv) == "1" {
		t.Setenv("REVIEW_YETI_OPERATOR_ENABLED", "false")
		main()
		ctrl.Log.Info(probe)
		return
	}

	cmd := exec.Command(os.Args[0], "-test.run=^TestMainInitializesControllerRuntimeLogger$")
	cmd.Env = append(os.Environ(), helperEnv+"=1")
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("logger helper failed: %v\n%s", err, output)
	}
	if !strings.Contains(string(output), probe) {
		t.Fatalf("controller-runtime logger did not emit probe:\n%s", output)
	}
}

func TestOperatorMaxConcurrentJobsFromEnv(t *testing.T) {
	for _, test := range []struct {
		name    string
		value   string
		want    int
		wantErr bool
	}{
		{name: "safe account default", value: "", want: 1},
		{name: "explicit capacity", value: "3", want: 3},
		{name: "zero", value: "0", wantErr: true},
		{name: "negative", value: "-1", wantErr: true},
		{name: "malformed", value: "many", wantErr: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := operatorMaxConcurrentJobsFromEnv(func(name string) string {
				if name != "REVIEW_YETI_OPERATOR_MAX_CONCURRENT_JOBS" {
					t.Fatalf("unexpected environment key %q", name)
				}
				return test.value
			})
			if (err != nil) != test.wantErr {
				t.Fatalf("operatorMaxConcurrentJobsFromEnv() error = %v, wantErr %v", err, test.wantErr)
			}
			if got != test.want {
				t.Fatalf("operatorMaxConcurrentJobsFromEnv() = %d, want %d", got, test.want)
			}
		})
	}
}

func TestOperatorDisabledUnlessExplicitlyEnabled(t *testing.T) {
	for _, test := range []struct {
		value string
		want  bool
	}{
		{value: "", want: false},
		{value: "false", want: false},
		{value: "1", want: false},
		{value: "yes", want: false},
		{value: "TRUE ", want: true},
		{value: " true\n", want: true},
	} {
		t.Run(test.value, func(t *testing.T) {
			if got := operatorEnabled(func(string) string { return test.value }); got != test.want {
				t.Fatalf("operatorEnabled(%q) = %v, want %v", test.value, got, test.want)
			}
		})
	}
}

func TestPublishingConfigFromEnvDefaultsRefuseAppGate(t *testing.T) {
	t.Setenv("REVIEW_YETI_GATEWAY_BASE_URL", "")
	t.Setenv("REVIEW_YETI_REVIEW_MODEL", "")
	config := publishingConfigFromEnv()
	// Unset transport settings must leave the config incomplete so BuildWorkerJob
	// refuses app-gate. Defaulting a gateway URL or model here is how a lane
	// silently reviews against something nobody chose.
	if config.GatewayBaseURL != "" || config.Model != "" {
		t.Fatalf("unset transport must not be defaulted: %+v", config)
	}
	// Secret *location* may default; a Secret name is not a transport choice.
	if config.GatewaySecretName == "" || config.GatewaySecretKey == "" {
		t.Fatalf("secret reference should default: %+v", config)
	}
}

func TestPublishingConfigFromEnvReadsTransport(t *testing.T) {
	t.Setenv("REVIEW_YETI_GATEWAY_BASE_URL", "https://gateway.example.invalid/v1")
	t.Setenv("REVIEW_YETI_REVIEW_MODEL", "ollama/glm-5.3-flash")
	t.Setenv("REVIEW_YETI_COMPLETION_URL", "https://dispatch.example.invalid/api/dispatch/completion")
	config := publishingConfigFromEnv()
	if config.GatewayBaseURL != "https://gateway.example.invalid/v1" || config.Model != "ollama/glm-5.3-flash" {
		t.Fatalf("transport not read: %+v", config)
	}
	if config.CompletionURL == "" {
		t.Fatal("completion URL not read")
	}
}
