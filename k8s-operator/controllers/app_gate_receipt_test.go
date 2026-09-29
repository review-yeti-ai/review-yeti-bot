package controllers_test

import (
	"context"
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

	reviewv1alpha2 "github.com/calltelemetry/ct-review-bot/k8s-operator/api/v1alpha2"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/controllers"
)

const testPublishToken = "test-publish-token-exact-attempt"

func validAppGateRunStatus(review *reviewv1alpha2.PRReviewJob) map[string]any {
	owner, repo, _ := strings.Cut(review.Spec.Repo, "/")
	attempt := int32(1)
	if review.Spec.ExecutionAttempt != nil {
		attempt = *review.Spec.ExecutionAttempt
	}
	return map[string]any{
		"status": "succeeded", "cancelRequested": false, "isCurrentHead": true,
		"receipt": map[string]any{
			"runId": review.Spec.RunID, "executionAttempt": attempt,
			"repositoryId": review.Spec.RepositoryID, "owner": owner, "repo": repo,
			"prNumber": review.Spec.PRNumber, "headSha": review.Spec.HeadSHA,
			"baseSha": review.Spec.BaseSHA, "policyDigest": review.Spec.PolicyDigest,
			"configDigest": review.Spec.ConfigDigest,
			"digest":       "sha256:" + strings.Repeat("1", 64),
			"evidenceRef":  fmt.Sprintf("audit://review-yeti/%s/attempts/%d/completion", review.Spec.RunID, attempt),
		},
	}
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
		_ = json.NewEncoder(w).Encode(validAppGateRunStatus(review))
	})
}

func TestAppGateReceiptRequiresTrustedExactCoordinates(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(map[string]any)
	}{
		{"no receipt", func(status map[string]any) { delete(status, "receipt") }},
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
				status := validAppGateRunStatus(review)
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
		_ = json.NewEncoder(w).Encode(validAppGateRunStatus(review))
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
		_ = json.NewEncoder(w).Encode(validAppGateRunStatus(review))
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
				_ = json.NewEncoder(w).Encode(validAppGateRunStatus(review))
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
