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
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
)

const (
	failureScriptHead       = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	failureScriptRunID      = "run_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	failureScriptExternalID = failureScriptRunID + ":a2"
)

func TestFailurePublisherScriptIsIdempotentAndPreservesCompletedVerdicts(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node is required to exercise the worker-image publication script")
	}

	tests := []struct {
		name           string
		checks         []map[string]any
		detail         map[string]any
		wantMethod     string
		wantConclusion string
	}{
		{
			name: "completed success is authoritative",
			checks: []map[string]any{{
				"id": 41, "name": "Review Yeti", "head_sha": failureScriptHead,
				"external_id": failureScriptExternalID, "status": "completed", "conclusion": "success",
			}},
			detail: map[string]any{
				"id": 41, "name": "Review Yeti", "head_sha": failureScriptHead,
				"external_id": failureScriptExternalID, "status": "completed", "conclusion": "success",
			},
		},
		{
			name: "exact unfinished check is failed",
			checks: []map[string]any{{
				"id": 42, "name": "Review Yeti", "head_sha": failureScriptHead,
				"external_id": failureScriptExternalID, "status": "in_progress",
			}},
			detail: map[string]any{
				"id": 42, "name": "Review Yeti", "head_sha": failureScriptHead,
				"external_id": failureScriptExternalID, "status": "in_progress",
			},
			wantMethod: "PATCH", wantConclusion: "failure",
		},
		{
			name:       "absent exact check gets bound failure",
			checks:     []map[string]any{},
			wantMethod: "POST", wantConclusion: "failure",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var mu sync.Mutex
			var writes []capturedCheckWrite
			server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				response.Header().Set("Content-Type", "application/json")
				switch {
				case request.Method == http.MethodGet && strings.Contains(request.URL.Path, "/commits/"):
					_ = json.NewEncoder(response).Encode(map[string]any{"check_runs": test.checks})
				case request.Method == http.MethodGet && strings.Contains(request.URL.Path, "/check-runs/"):
					_ = json.NewEncoder(response).Encode(test.detail)
				case request.Method == http.MethodPatch || request.Method == http.MethodPost:
					var body map[string]any
					if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
						t.Errorf("decode publication body: %v", err)
						response.WriteHeader(http.StatusBadRequest)
						return
					}
					mu.Lock()
					writes = append(writes, capturedCheckWrite{method: request.Method, body: body})
					mu.Unlock()
					_ = json.NewEncoder(response).Encode(map[string]any{"id": 43})
				default:
					http.Error(response, "unexpected request", http.StatusBadRequest)
				}
			}))
			defer server.Close()

			if output, err := runFailurePublisherScript(server.URL); err != nil {
				t.Fatalf("script failed: %v: %s", err, output)
			}
			mu.Lock()
			defer mu.Unlock()
			if test.wantMethod == "" {
				if len(writes) != 0 {
					t.Fatalf("completed verdict was overwritten: %#v", writes)
				}
				return
			}
			if len(writes) != 1 || writes[0].method != test.wantMethod || writes[0].body["conclusion"] != test.wantConclusion {
				t.Fatalf("writes = %#v, want one %s failure", writes, test.wantMethod)
			}
			if test.wantMethod == http.MethodPost && writes[0].body["external_id"] != failureScriptExternalID {
				t.Fatalf("created check external_id = %v", writes[0].body["external_id"])
			}
		})
	}
}

func TestFailurePublisherScriptRecoversLostCreateResponse(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node is required to exercise the worker-image publication script")
	}
	var mu sync.Mutex
	created := false
	posts := 0
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		mu.Lock()
		defer mu.Unlock()
		if request.Method == http.MethodGet && strings.Contains(request.URL.Path, "/commits/") {
			checks := []map[string]any{}
			if created {
				checks = append(checks, map[string]any{
					"id": 44, "name": "Review Yeti", "head_sha": failureScriptHead,
					"external_id": failureScriptExternalID, "status": "completed", "conclusion": "failure",
				})
			}
			_ = json.NewEncoder(response).Encode(map[string]any{"check_runs": checks})
			return
		}
		if request.Method == http.MethodGet && strings.Contains(request.URL.Path, "/check-runs/") {
			_ = json.NewEncoder(response).Encode(map[string]any{
				"id": 44, "name": "Review Yeti", "head_sha": failureScriptHead,
				"external_id": failureScriptExternalID, "status": "completed", "conclusion": "failure",
			})
			return
		}
		if request.Method == http.MethodPost {
			posts++
			created = true
			http.Error(response, "response lost", http.StatusBadGateway)
			return
		}
		http.Error(response, "unexpected request", http.StatusBadRequest)
	}))
	defer server.Close()

	if _, err := runFailurePublisherScript(server.URL); err == nil {
		t.Fatal("first run unexpectedly observed the lost create response")
	}
	if output, err := runFailurePublisherScript(server.URL); err != nil {
		t.Fatalf("retry did not recover exact completed check: %v: %s", err, output)
	}
	mu.Lock()
	defer mu.Unlock()
	if posts != 1 {
		t.Fatalf("lost response created %d checks, want exactly one", posts)
	}
}

type capturedCheckWrite struct {
	method string
	body   map[string]any
}

func runFailurePublisherScript(apiURL string) ([]byte, error) {
	script := strings.Replace(failurePublisherScript, "https://api.github.com", apiURL, 1)
	command := exec.Command("node", "--input-type=module", "--eval", script)
	command.Env = []string{
		"PATH=" + os.Getenv("PATH"),
		"GITHUB_PUBLISH_TOKEN=ghs_test",
		"REVIEW_REPOSITORY=calltelemetry/cisco-cdr",
		"REVIEW_HEAD_SHA=" + failureScriptHead,
		"REVIEW_RUN_ID=" + failureScriptRunID,
		"REVIEW_EXECUTION_ATTEMPT=2",
	}
	return command.CombinedOutput()
}
