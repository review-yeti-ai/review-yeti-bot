package controllers_test

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"

	reviewv1alpha2 "github.com/review-yeti-ai/review-yeti-bot/k8s-operator/api/v1alpha2"
	"github.com/review-yeti-ai/review-yeti-bot/k8s-operator/controllers"
)

const testPublishToken = "test-publish-token-exact-attempt"

// The TypeScript repository test reads this same fixture. A changed wire
// shape or evidence reference must pass both languages before it can ship.
//
//go:embed testdata/app_gate_receipt_success.v1.json
var appGateReceiptSuccessFixture []byte

func validAppGateRunStatus(t *testing.T, review *reviewv1alpha2.PRReviewJob) map[string]any {
	t.Helper()
	var status map[string]any
	if err := json.Unmarshal(appGateReceiptSuccessFixture, &status); err != nil {
		t.Errorf("parse shared receipt fixture: %v", err)
		return map[string]any{}
	}
	receipt, ok := status["receipt"].(map[string]any)
	if !ok {
		t.Errorf("shared receipt fixture is missing its receipt")
		return map[string]any{}
	}
	// Most tests use the fixed v1 fixture unchanged. The live-refresh test
	// generates a second run identity; keep the same fixture wire shape while
	// rebinding its immutable coordinates to that test's exact attempt.
	if receipt["runId"] != review.Spec.RunID {
		owner, repo, _ := strings.Cut(review.Spec.Repo, "/")
		attempt := int32(1)
		if review.Spec.ExecutionAttempt != nil {
			attempt = *review.Spec.ExecutionAttempt
		}
		receipt["runId"] = review.Spec.RunID
		receipt["executionAttempt"] = attempt
		receipt["repositoryId"] = review.Spec.RepositoryID
		receipt["owner"] = owner
		receipt["repo"] = repo
		receipt["prNumber"] = review.Spec.PRNumber
		receipt["headSha"] = review.Spec.HeadSHA
		receipt["baseSha"] = review.Spec.BaseSHA
		receipt["policyDigest"] = review.Spec.PolicyDigest
		receipt["configDigest"] = review.Spec.ConfigDigest
		receipt["evidenceRef"] = fmt.Sprintf("audit://review-yeti/%s/attempts/%d/completion", review.Spec.RunID, attempt)
	}
	return status
}

func installAppGateReceiptEndpoint(
	t *testing.T, r *controllers.PRReviewJobV1Alpha2Reconciler, kube client.Client,
	review *reviewv1alpha2.PRReviewJob, handler http.HandlerFunc,
) *httptest.Server {
	t.Helper()
	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: review.Spec.RunSecretName, Namespace: review.Namespace},
		Data:       map[string][]byte{"GITHUB_PUBLISH_TOKEN": []byte(testPublishToken)},
	}
	if err := kube.Create(context.Background(), secret); err != nil {
		t.Fatalf("create exact run Secret: %v", err)
	}
	// The fake client stands in for mgr.GetAPIReader(), never its cache.
	r.SecretReader = kube
	server := httptest.NewTLSServer(handler)
	t.Cleanup(server.Close)
	r.Publishing.CompletionURL = server.URL + "/api/dispatch/completion"
	r.ReceiptHTTPClient = server.Client()
	return server
}

func installValidAppGateReceipt(t *testing.T, r *controllers.PRReviewJobV1Alpha2Reconciler,
	kube client.Client, review *reviewv1alpha2.PRReviewJob) {
	t.Helper()
	installAppGateReceiptEndpoint(t, r, kube, review, func(w http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer "+testPublishToken ||
			request.URL.Path != "/api/dispatch/runs/"+review.Spec.RunID+
				"/attempts/2/status" || request.Method != http.MethodGet {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		_ = json.NewEncoder(w).Encode(validAppGateRunStatus(t, review))
	})
}

func TestAppGateReceiptRequiresTrustedExactCoordinates(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(map[string]any)
	}{
		{"no receipt", func(status map[string]any) { delete(status, "receipt") }},
		{"foreign contract version", func(status map[string]any) {
			status["receipt"].(map[string]any)["version"] = "AppGateReceipt.v2"
		}},
		{"foreign run", func(status map[string]any) {
			status["receipt"].(map[string]any)["runId"] = "run_22222222222222222222222222222222"
		}},
		{"foreign attempt", func(status map[string]any) { status["receipt"].(map[string]any)["executionAttempt"] = 1 }},
		{"foreign repository id", func(status map[string]any) { status["receipt"].(map[string]any)["repositoryId"] = 124 }},
		{"foreign owner", func(status map[string]any) { status["receipt"].(map[string]any)["owner"] = "other" }},
		{"foreign repo", func(status map[string]any) { status["receipt"].(map[string]any)["repo"] = "other" }},
		{"foreign PR", func(status map[string]any) { status["receipt"].(map[string]any)["prNumber"] = 43 }},
		{"foreign head", func(status map[string]any) {
			status["receipt"].(map[string]any)["headSha"] = strings.Repeat("a", 39) + "b"
		}},
		{"foreign base", func(status map[string]any) {
			status["receipt"].(map[string]any)["baseSha"] = strings.Repeat("b", 39) + "a"
		}},
		{"foreign policy", func(status map[string]any) {
			status["receipt"].(map[string]any)["policyDigest"] = strings.Repeat("f", 64)
		}},
		{"foreign config", func(status map[string]any) {
			status["receipt"].(map[string]any)["configDigest"] = strings.Repeat("f", 64)
		}},
		{"forged digest", func(status map[string]any) { status["receipt"].(map[string]any)["digest"] = "sha256:not-a-digest" }},
		{"foreign evidence", func(status map[string]any) {
			status["receipt"].(map[string]any)["evidenceRef"] = "https://example.invalid/receipt"
		}},
		{"cancelled", func(status map[string]any) { status["cancelRequested"] = true }},
		{"stale head", func(status map[string]any) { status["isCurrentHead"] = false }},
		{"failed run", func(status map[string]any) { status["status"] = "failed" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r, kube, req := missingJobFixture(t, "app-gate", interceptor.Funcs{})
			if _, err := r.Reconcile(context.Background(), req); err != nil {
				t.Fatal(err)
			}
			review := storedReview(t, kube, req)
			installAppGateReceiptEndpoint(t, r, kube, review, func(w http.ResponseWriter, request *http.Request) {
				status := validAppGateRunStatus(t, review)
				tc.mutate(status)
				_ = json.NewEncoder(w).Encode(status)
			})
			worker := storedWorker(t, kube, req)
			// Even forged worker-owned annotations must not satisfy app-gate success.
			attachReceiptAnnotations(worker)
			if err := kube.Update(context.Background(), worker); err != nil {
				t.Fatal(err)
			}
			worker.Status.Succeeded = 1
			worker.Status.Conditions = []batchv1.JobCondition{{Type: batchv1.JobComplete, Status: corev1.ConditionTrue}}
			if err := kube.Status().Update(context.Background(), worker); err != nil {
				t.Fatal(err)
			}
			if _, err := r.Reconcile(context.Background(), req); err != nil {
				t.Fatal(err)
			}
			after := storedReview(t, kube, req)
			if after.Status.Phase == reviewv1alpha2.PhaseSucceeded || after.Status.ReceiptDigest != "" {
				t.Fatalf("foreign receipt promoted review: phase=%s digest=%q", after.Status.Phase, after.Status.ReceiptDigest)
			}
		})
	}
}

func TestAppGateReceiptTransportFailureRetriesWithoutSuccess(t *testing.T) {
	r, kube, req := missingJobFixture(t, "app-gate", interceptor.Funcs{})
	if _, err := r.Reconcile(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	review := storedReview(t, kube, req)
	fail := true
	installAppGateReceiptEndpoint(t, r, kube, review, func(w http.ResponseWriter, request *http.Request) {
		if fail {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		_ = json.NewEncoder(w).Encode(validAppGateRunStatus(t, review))
	})
	worker := storedWorker(t, kube, req)
	worker.Status.Succeeded = 1
	worker.Status.Conditions = []batchv1.JobCondition{{Type: batchv1.JobComplete, Status: corev1.ConditionTrue}}
	if err := kube.Status().Update(context.Background(), worker); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Reconcile(context.Background(), req); err == nil {
		t.Fatal("service outage must requeue instead of promoting")
	}
	if after := storedReview(t, kube, req); after.Status.Phase == reviewv1alpha2.PhaseSucceeded || after.Status.ReceiptDigest != "" {
		t.Fatalf("temporary outage promoted review: %+v", after.Status)
	}
	fail = false
	if _, err := r.Reconcile(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	if after := storedReview(t, kube, req); after.Status.Phase != reviewv1alpha2.PhaseSucceeded || after.Status.ReceiptDigest == "" {
		t.Fatalf("verified receipt did not promote on retry: %+v", after.Status)
	}
}

func TestAppGateReceiptNetworkFailureRetriesWithoutSuccess(t *testing.T) {
	r, kube, req := missingJobFixture(t, "app-gate", interceptor.Funcs{})
	if _, err := r.Reconcile(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	review := storedReview(t, kube, req)
	server := installAppGateReceiptEndpoint(t, r, kube, review, func(w http.ResponseWriter, request *http.Request) {
		_ = json.NewEncoder(w).Encode(validAppGateRunStatus(t, review))
	})
	server.Close()
	worker := storedWorker(t, kube, req)
	worker.Status.Succeeded = 1
	if err := kube.Status().Update(context.Background(), worker); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Reconcile(context.Background(), req); err == nil {
		t.Fatal("network error must retry")
	}
	if after := storedReview(t, kube, req); after.Status.Phase == reviewv1alpha2.PhaseSucceeded || after.Status.ReceiptDigest != "" {
		t.Fatalf("network error promoted review: %+v", after.Status)
	}
}

func TestAppGateReceiptUsesUncachedExactRunSecret(t *testing.T) {
	r, kube, req := missingJobFixture(t, "app-gate", interceptor.Funcs{})
	if _, err := r.Reconcile(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	review := storedReview(t, kube, req)
	installValidAppGateReceipt(t, r, kube, review)
	r.Client = interceptor.NewClient(kube.(client.WithWatch), interceptor.Funcs{
		Get: func(ctx context.Context, c client.WithWatch, key client.ObjectKey, obj client.Object, opts ...client.GetOption) error {
			if _, ok := obj.(*corev1.Secret); ok {
				return errors.New("cached Secret read is forbidden")
			}
			return c.Get(ctx, key, obj, opts...)
		},
	})
	worker := storedWorker(t, kube, req)
	worker.Status.Succeeded = 1
	if err := kube.Status().Update(context.Background(), worker); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Reconcile(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	if after := storedReview(t, kube, req); after.Status.Phase != reviewv1alpha2.PhaseSucceeded {
		t.Fatalf("uncached reader did not supply trusted receipt: %+v", after.Status)
	}
}

func TestAppGateReceiptMissingUncachedReaderRetries(t *testing.T) {
	r, kube, req := missingJobFixture(t, "app-gate", interceptor.Funcs{})
	if _, err := r.Reconcile(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	review := storedReview(t, kube, req)
	installValidAppGateReceipt(t, r, kube, review)
	r.SecretReader = nil
	worker := storedWorker(t, kube, req)
	worker.Status.Succeeded = 1
	if err := kube.Status().Update(context.Background(), worker); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Reconcile(context.Background(), req); err == nil {
		t.Fatal("missing uncached Secret reader must not fall back to manager cache")
	}
	if after := storedReview(t, kube, req); after.Status.Phase == reviewv1alpha2.PhaseSucceeded || after.Status.ReceiptDigest != "" {
		t.Fatalf("missing uncached reader promoted review: %+v", after.Status)
	}
}

func TestAppGateReceiptMissingRunSecretFailsClosedAndReleasesWorker(t *testing.T) {
	r, kube, req := missingJobFixture(t, "app-gate", interceptor.Funcs{})
	if _, err := r.Reconcile(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	review := storedReview(t, kube, req)
	installValidAppGateReceipt(t, r, kube, review)
	secret := &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: review.Spec.RunSecretName, Namespace: review.Namespace}}
	if err := kube.Delete(context.Background(), secret); err != nil {
		t.Fatal(err)
	}
	worker := storedWorker(t, kube, req)
	worker.Status.Succeeded = 1
	worker.Status.Conditions = []batchv1.JobCondition{{Type: batchv1.JobComplete, Status: corev1.ConditionTrue}}
	if err := kube.Status().Update(context.Background(), worker); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Reconcile(context.Background(), req); err != nil {
		t.Fatalf("absent exact run Secret must reject, not requeue: %v", err)
	}
	after := storedReview(t, kube, req)
	if after.Status.Phase == reviewv1alpha2.PhaseSucceeded || after.Status.ReceiptDigest != "" {
		t.Fatalf("absent run Secret promoted review: %+v", after.Status)
	}
	// Terminal evidence is retained through the parent status write and released
	// on the next reconcile; a deterministic rejection must not strand it.
	if _, err := r.Reconcile(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	if worker := storedWorker(t, kube, req); containsString(worker.Finalizers, "review-yeti.ai/terminal-outcome") {
		t.Fatal("absent run Secret stranded the worker evidence finalizer")
	}
}

func TestAppGateReceiptTransientRunSecretReadRequeues(t *testing.T) {
	r, kube, req := missingJobFixture(t, "app-gate", interceptor.Funcs{})
	if _, err := r.Reconcile(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	review := storedReview(t, kube, req)
	installValidAppGateReceipt(t, r, kube, review)
	r.SecretReader = interceptor.NewClient(kube.(client.WithWatch), interceptor.Funcs{
		Get: func(ctx context.Context, c client.WithWatch, key client.ObjectKey, obj client.Object, opts ...client.GetOption) error {
			if _, ok := obj.(*corev1.Secret); ok {
				return errors.New("temporary Kubernetes API read failure")
			}
			return c.Get(ctx, key, obj, opts...)
		},
	})
	worker := storedWorker(t, kube, req)
	worker.Status.Succeeded = 1
	worker.Status.Conditions = []batchv1.JobCondition{{Type: batchv1.JobComplete, Status: corev1.ConditionTrue}}
	if err := kube.Status().Update(context.Background(), worker); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Reconcile(context.Background(), req); err == nil {
		t.Fatal("temporary run Secret read error must requeue")
	}
	if after := storedReview(t, kube, req); after.Status.Phase == reviewv1alpha2.PhaseSucceeded || after.Status.ReceiptDigest != "" {
		t.Fatalf("temporary Secret read promoted review: %+v", after.Status)
	}
	// A later successful live read must still be able to promote this attempt.
	r.SecretReader = kube
	if _, err := r.Reconcile(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	if after := storedReview(t, kube, req); after.Status.Phase != reviewv1alpha2.PhaseSucceeded || after.Status.ReceiptDigest == "" {
		t.Fatalf("retry after Secret API recovery failed to promote: %+v", after.Status)
	}
}

func TestAppGateReceiptRejectsRedirectAndWrongToken(t *testing.T) {
	for _, tc := range []struct {
		name  string
		serve func(http.ResponseWriter)
	}{
		{"redirect", func(w http.ResponseWriter) {
			w.Header().Set("Location", "https://elsewhere.example.invalid/api/dispatch/status")
			w.WriteHeader(http.StatusFound)
		}},
		{"unauthorized", func(w http.ResponseWriter) { w.WriteHeader(http.StatusUnauthorized) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r, kube, req := missingJobFixture(t, "app-gate", interceptor.Funcs{})
			if _, err := r.Reconcile(context.Background(), req); err != nil {
				t.Fatal(err)
			}
			review := storedReview(t, kube, req)
			installAppGateReceiptEndpoint(t, r, kube, review, func(w http.ResponseWriter, request *http.Request) {
				tc.serve(w)
			})
			worker := storedWorker(t, kube, req)
			worker.Status.Succeeded = 1
			if err := kube.Status().Update(context.Background(), worker); err != nil {
				t.Fatal(err)
			}
			if _, err := r.Reconcile(context.Background(), req); err != nil {
				t.Fatal(err)
			}
			if after := storedReview(t, kube, req); after.Status.Phase == reviewv1alpha2.PhaseSucceeded {
				t.Fatal("rejected status request promoted review")
			}
		})
	}
}

func TestAppGateReceiptRejectsInsecureStatusURLs(t *testing.T) {
	cases := []struct {
		name string
		url  func(string) string
	}{
		{"cleartext", func(base string) string {
			return strings.Replace(base, "https://", "http://", 1) + "/api/dispatch/completion"
		}},
		{"empty host", func(string) string { return "https:///api/dispatch/completion" }},
		{"userinfo", func(base string) string {
			return strings.Replace(base, "https://", "https://person:password@", 1) + "/api/dispatch/completion"
		}},
		{"query", func(base string) string { return base + "/api/dispatch/completion?token=leak" }},
		{"fragment", func(base string) string { return base + "/api/dispatch/completion#fragment" }},
		{"wrong path", func(base string) string { return base + "/api/dispatch/other" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r, kube, req := missingJobFixture(t, "app-gate", interceptor.Funcs{})
			if _, err := r.Reconcile(context.Background(), req); err != nil {
				t.Fatal(err)
			}
			review := storedReview(t, kube, req)
			server := installAppGateReceiptEndpoint(t, r, kube, review, func(w http.ResponseWriter, request *http.Request) {
				_ = json.NewEncoder(w).Encode(validAppGateRunStatus(t, review))
			})
			r.Publishing.CompletionURL = tc.url(server.URL)
			worker := storedWorker(t, kube, req)
			worker.Status.Succeeded = 1
			worker.Status.Conditions = []batchv1.JobCondition{{Type: batchv1.JobComplete, Status: corev1.ConditionTrue}}
			if err := kube.Status().Update(context.Background(), worker); err != nil {
				t.Fatal(err)
			}
			if _, err := r.Reconcile(context.Background(), req); err != nil {
				t.Fatal(err)
			}
			after := storedReview(t, kube, req)
			if after.Status.Phase == reviewv1alpha2.PhaseSucceeded || after.Status.ReceiptDigest != "" {
				t.Fatalf("insecure receipt URL promoted review: phase=%s digest=%q", after.Status.Phase, after.Status.ReceiptDigest)
			}
		})
	}
}

func TestAppGateReceiptStatusBodyBoundary(t *testing.T) {
	const maxStatusBytes = 32 << 10
	for _, tc := range []struct {
		name    string
		size    int
		accepts bool
	}{
		{"at limit", maxStatusBytes, true},
		{"one byte over limit", maxStatusBytes + 1, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r, kube, req := missingJobFixture(t, "app-gate", interceptor.Funcs{})
			if _, err := r.Reconcile(context.Background(), req); err != nil {
				t.Fatal(err)
			}
			review := storedReview(t, kube, req)
			status := validAppGateRunStatus(t, review)
			status["padding"] = ""
			base, err := json.Marshal(status)
			if err != nil {
				t.Fatal(err)
			}
			if len(base) > tc.size {
				t.Fatalf("base fixture already exceeds target size: %d > %d", len(base), tc.size)
			}
			status["padding"] = strings.Repeat("x", tc.size-len(base))
			payload, err := json.Marshal(status)
			if err != nil || len(payload) != tc.size {
				t.Fatalf("construct exact-size valid JSON: length=%d, target=%d, err=%v", len(payload), tc.size, err)
			}
			installAppGateReceiptEndpoint(t, r, kube, review, func(w http.ResponseWriter, request *http.Request) {
				_, _ = w.Write(payload)
			})
			worker := storedWorker(t, kube, req)
			worker.Status.Succeeded = 1
			worker.Status.Conditions = []batchv1.JobCondition{{Type: batchv1.JobComplete, Status: corev1.ConditionTrue}}
			if err := kube.Status().Update(context.Background(), worker); err != nil {
				t.Fatal(err)
			}
			if _, err := r.Reconcile(context.Background(), req); err != nil {
				t.Fatalf("status body boundary should not requeue: %v", err)
			}
			after := storedReview(t, kube, req)
			promoted := after.Status.Phase == reviewv1alpha2.PhaseSucceeded && after.Status.ReceiptDigest != ""
			if promoted != tc.accepts {
				t.Fatalf("status body size %d: promoted=%t, want %t (phase=%s, digest=%q)",
					tc.size, promoted, tc.accepts, after.Status.Phase, after.Status.ReceiptDigest)
			}
		})
	}
}

func TestAppGateReceiptRejectsUnusableRunSecretToken(t *testing.T) {
	for _, tc := range []struct {
		name  string
		token []byte
	}{
		{"missing", nil},
		{"oversized", []byte(strings.Repeat("x", 4097))},
		{"non-printable", []byte("token\nline")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r, kube, req := missingJobFixture(t, "app-gate", interceptor.Funcs{})
			if _, err := r.Reconcile(context.Background(), req); err != nil {
				t.Fatal(err)
			}
			review := storedReview(t, kube, req)
			installValidAppGateReceipt(t, r, kube, review)
			secret := &corev1.Secret{}
			key := client.ObjectKey{Namespace: review.Namespace, Name: review.Spec.RunSecretName}
			if err := kube.Get(context.Background(), key, secret); err != nil {
				t.Fatal(err)
			}
			secret.Data["GITHUB_PUBLISH_TOKEN"] = tc.token
			if err := kube.Update(context.Background(), secret); err != nil {
				t.Fatal(err)
			}
			worker := storedWorker(t, kube, req)
			worker.Status.Succeeded = 1
			worker.Status.Conditions = []batchv1.JobCondition{{Type: batchv1.JobComplete, Status: corev1.ConditionTrue}}
			if err := kube.Status().Update(context.Background(), worker); err != nil {
				t.Fatal(err)
			}
			if _, err := r.Reconcile(context.Background(), req); err != nil {
				t.Fatalf("unusable token must reject, not requeue: %v", err)
			}
			if after := storedReview(t, kube, req); after.Status.Phase == reviewv1alpha2.PhaseSucceeded || after.Status.ReceiptDigest != "" {
				t.Fatalf("unusable token promoted review: %+v", after.Status)
			}
		})
	}
}
