package controllers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/types"

	reviewv1alpha2 "github.com/calltelemetry/ct-review-bot/k8s-operator/api/v1alpha2"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/job"
)

const (
	appGateReceiptTimeout = 3 * time.Second
	maxRunStatusBytes     = 32 << 10
)

var (
	errTemporaryReceiptLookup = errors.New("temporary app-gate receipt lookup failure")
	errRejectedReceipt        = errors.New("app-gate receipt missing or invalid")
	receiptDigestPattern      = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
)

// Action-dispatch owns the durable completion/gate predicate and authenticates
// the exact run Secret's publish token. This operator only re-verifies the
// versioned wire receipt against immutable PRReviewJob coordinates before
// using its digest. The shared v1 fixture is exercised by both Go and TS tests;
// neither a worker annotation nor HTTP success alone can promote the Job.
type appGateReceipt struct {
	Version          string `json:"version"`
	RunID            string `json:"runId"`
	ExecutionAttempt int32  `json:"executionAttempt"`
	RepositoryID     int64  `json:"repositoryId"`
	Owner            string `json:"owner"`
	Repo             string `json:"repo"`
	PRNumber         int32  `json:"prNumber"`
	HeadSHA          string `json:"headSha"`
	BaseSHA          string `json:"baseSha"`
	PolicyDigest     string `json:"policyDigest"`
	ConfigDigest     string `json:"configDigest"`
	Digest           string `json:"digest"`
	EvidenceRef      string `json:"evidenceRef"`
}

type appGateRunStatus struct {
	Status          string          `json:"status"`
	CancelRequested bool            `json:"cancelRequested"`
	IsCurrentHead   bool            `json:"isCurrentHead"`
	Receipt         *appGateReceipt `json:"receipt"`
}

func appGateStatusURL(completionURL, runID string, attempt int32) (string, error) {
	parsed, err := url.Parse(completionURL)
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" || parsed.User != nil ||
		parsed.Opaque != "" || parsed.RawPath != "" || parsed.RawQuery != "" || parsed.ForceQuery ||
		parsed.Fragment != "" || strings.ContainsAny(completionURL, "\\?#") ||
		!strings.HasSuffix(parsed.Path, "/api/dispatch/completion") {
		return "", errRejectedReceipt
	}
	parsed.Path = strings.TrimSuffix(parsed.Path, "/completion") + "/runs/" + url.PathEscape(runID) +
		"/attempts/" + strconv.FormatInt(int64(attempt), 10) + "/status"
	return parsed.String(), nil
}

func validateAppGateReceipt(receipt *appGateReceipt, review *reviewv1alpha2.PRReviewJob, attempt int32) error {
	if receipt == nil {
		return fmt.Errorf("%w: no durable receipt", errRejectedReceipt)
	}
	owner, repo, ok := strings.Cut(review.Spec.Repo, "/")
	if !ok || owner == "" || repo == "" || strings.Contains(repo, "/") ||
		receipt.Version != "AppGateReceipt.v1" ||
		receipt.RunID != review.Spec.RunID || receipt.ExecutionAttempt != attempt ||
		receipt.RepositoryID != review.Spec.RepositoryID || receipt.Owner != owner || receipt.Repo != repo ||
		receipt.PRNumber != review.Spec.PRNumber || receipt.HeadSHA != review.Spec.HeadSHA ||
		receipt.BaseSHA != review.Spec.BaseSHA || receipt.PolicyDigest != review.Spec.PolicyDigest ||
		receipt.ConfigDigest != review.Spec.ConfigDigest {
		return fmt.Errorf("%w: immutable coordinates differ", errRejectedReceipt)
	}
	expectedEvidenceRef := fmt.Sprintf("audit://review-yeti/%s/attempts/%d/completion", review.Spec.RunID, attempt)
	if !receiptDigestPattern.MatchString(receipt.Digest) || receipt.EvidenceRef != expectedEvidenceRef {
		return fmt.Errorf("%w: invalid digest or evidence reference", errRejectedReceipt)
	}
	return nil
}

func (r *PRReviewJobV1Alpha2Reconciler) fetchAppGateReceipt(
	ctx context.Context, review *reviewv1alpha2.PRReviewJob,
) (*appGateReceipt, error) {
	attempt, err := job.ExecutionAttemptForSpec(review.Spec)
	if err != nil || !job.IsValidRunSecretName(review.Spec.RunSecretName) {
		return nil, fmt.Errorf("%w: invalid run Secret identity", errRejectedReceipt)
	}
	statusURL, err := appGateStatusURL(r.Publishing.CompletionURL, review.Spec.RunID, attempt)
	if err != nil {
		return nil, err
	}

	var secret corev1.Secret
	if r.SecretReader == nil {
		return nil, fmt.Errorf("%w: uncached Secret reader unavailable", errTemporaryReceiptLookup)
	}
	err = r.SecretReader.Get(ctx, types.NamespacedName{Namespace: review.Namespace, Name: review.Spec.RunSecretName}, &secret)
	if err != nil {
		if apierrors.IsNotFound(err) {
			return nil, fmt.Errorf("%w: exact run Secret is absent", errRejectedReceipt)
		}
		return nil, fmt.Errorf("%w: run Secret read failed", errTemporaryReceiptLookup)
	}
	token := secret.Data["GITHUB_PUBLISH_TOKEN"]
	if len(token) == 0 || len(token) > 4096 || strings.ContainsFunc(string(token), func(r rune) bool {
		return r <= 32 || r >= 127
	}) {
		return nil, fmt.Errorf("%w: exact run Secret has no usable publish token", errRejectedReceipt)
	}

	requestCtx, cancel := context.WithTimeout(ctx, appGateReceiptTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, statusURL, nil)
	if err != nil {
		return nil, fmt.Errorf("%w: invalid status request", errRejectedReceipt)
	}
	request.Header.Set("Authorization", "Bearer "+string(token))
	request.Header.Set("Accept", "application/json")

	transport := http.DefaultTransport
	if r.ReceiptHTTPClient != nil && r.ReceiptHTTPClient.Transport != nil {
		transport = r.ReceiptHTTPClient.Transport
	}
	client := &http.Client{
		Transport: transport,
		Timeout:   appGateReceiptTimeout,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("%w: status transport failed", errTemporaryReceiptLookup)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= http.StatusInternalServerError {
		return nil, fmt.Errorf("%w: status service unavailable", errTemporaryReceiptLookup)
	}
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%w: status request rejected", errRejectedReceipt)
	}
	payload, err := io.ReadAll(io.LimitReader(response.Body, maxRunStatusBytes+1))
	if err != nil {
		return nil, fmt.Errorf("%w: status body unreadable", errTemporaryReceiptLookup)
	}
	if len(payload) > maxRunStatusBytes {
		return nil, fmt.Errorf("%w: status body exceeds bound", errRejectedReceipt)
	}
	var status appGateRunStatus
	if err := json.Unmarshal(payload, &status); err != nil ||
		(status.Status != "succeeded" && status.Status != "failed") ||
		status.CancelRequested || !status.IsCurrentHead {
		return nil, fmt.Errorf("%w: status is not current terminal completion", errRejectedReceipt)
	}
	if err := validateAppGateReceipt(status.Receipt, review, attempt); err != nil {
		return nil, err
	}
	return status.Receipt, nil
}
