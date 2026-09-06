package main

import "testing"

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
	config := publishingConfigFromEnv()
	if config.GatewayBaseURL != "https://gateway.example.invalid/v1" || config.Model != "ollama/glm-5.3-flash" {
		t.Fatalf("transport not read: %+v", config)
	}
}
