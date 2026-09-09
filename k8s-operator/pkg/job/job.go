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

// Package job builds the receipt-only and explicitly opted-in qualification
// v1alpha2 worker contracts. It is pure:
// callers must acquire the workspace Lease and create the returned Job
// themselves, which keeps ordering and API errors observable to the controller.
package job

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/validation"

	v1alpha2 "github.com/calltelemetry/ct-review-bot/k8s-operator/api/v1alpha2"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/workspace"
)

const (
	Namespace                     = "ct-review-system"
	ReceiptOnlyEnv                = "REVIEW_RECEIPT_ONLY"
	FullPanelQualificationEnv     = "REVIEW_FULL_PANEL_QUALIFICATION_ONLY"
	SameHeadQualificationEnv      = "REVIEW_SAME_HEAD_QUALIFICATION_ONLY"
	EngineRevisionEnv             = "REVIEW_ENGINE_REVISION"
	QualificationModelEnv         = "REVIEW_QUALIFICATION_MODEL"
	QualificationTimeoutEnv       = "REVIEW_QUALIFICATION_TIMEOUT_MS"
	PublicationModeEnv            = "REVIEW_PUBLICATION_MODE"
	CompletionURLEnv              = "REVIEW_COMPLETION_URL"
	ExecutionAttemptEnv           = "REVIEW_EXECUTION_ATTEMPT"
	AuthoritativeGateEnv          = "REVIEW_AUTHORITATIVE_GATE"
	PreparedConfigEnv             = "REVIEW_PREPARED_CONFIG_JSON"
	MaxPreparedReviewBytes        = 256 * 1024
	ReceiptPathEnv                = "REVIEW_RECEIPT_PATH"
	ReceiptPath                   = "/workspace/.review-yeti/receipt.json"
	PublicationModeAppGate        = "app-gate"
	PublicationModeDisabled       = "disabled"
	PublishingWorkerComponent     = "publishing-worker"
	FullPanelQualificationProfile = "full-panel"
	SameHeadQualificationProfile  = "same-head"
	ReceiptOnlyWorkerComponent    = "receipt-only-worker"
	// Jobs are disposable execution records. The reusable PR workspace has a
	// separate, exact 1,800-second idle reclamation policy.
	JobTTLSeconds = int32(300)
	// Keep a one-minute publication/failure-conclusion reserve inside the
	// original 15-minute run deadline. The worker itself may never consume the
	// full admission window.
	MaxActiveDeadlineSeconds = int64(840)
	DeadlineReserveSeconds   = int64(60)
	// The panel deadline stays inside the Kubernetes Job deadline so a failed
	// qualification still has time to persist its bounded diagnostic receipt.
	WorkerReceiptReserveSeconds = int64(60)
	MinRemainingSeconds         = int64(120)
)

var (
	ErrJobConfiguration = errors.New("Job configuration rejected")
	ErrJobDeadline      = errors.New("receipt-only Job deadline is invalid")

	runIDPattern       = regexp.MustCompile(`^run_[a-f0-9]{32}$`)
	repoPattern        = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?/[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$`)
	shaPattern         = regexp.MustCompile(`^[a-f0-9]{40}$`)
	digestPattern      = regexp.MustCompile(`^[a-f0-9]{64}$`)
	workerImagePattern = regexp.MustCompile(`^(?:(?:ghcr\.io/review-yeti-ai/review-yeti-worker|registry\.digitalocean\.com/calltelemetry/review-yeti-worker)@sha256:[a-f0-9]{64}|node:[a-zA-Z0-9_.-]+|ghcr\.io/review-yeti-ai/[a-zA-Z0-9_.-]+:[a-zA-Z0-9_.-]+)$`)
	secretNamePattern  = regexp.MustCompile(`^ct-review-run-[a-f0-9]{32}(-a[1-9][0-9]*)?$`)
)

// Input is the immutable review projection plus fresh workspace ownership
// evidence.  No Secret object or credential is accepted by this builder.
type Input struct {
	Review           *v1alpha2.PRReviewJob
	WorkspacePVCName string
	WorkspaceLease   workspace.LeaseAcquireResult
	Now              time.Time
	// Publishing carries the non-secret settings the app-gate lane needs. It is
	// required only for PublicationModeAppGate and, consistent with this builder's
	// contract, holds Secret *names and keys* -- never a credential value.
	Publishing PublishingConfig
}

// PublishingConfig configures the app-gate publishing lane. Bifrost is the only
// admitted transport (ADR 0527): there is no second provider and no default, so a
// missing or malformed field refuses the Job rather than silently reviewing
// against something else.
type PublishingConfig struct {
	GatewayBaseURL    string
	Model             string
	GatewaySecretName string
	GatewaySecretKey  string
	CompletionURL     string
}

// WorkerComponentFor returns the component label for a review's lane. The builder
// stamps it and the controller selects pods by it, so the two must agree; deriving
// both from this one function is what keeps them from drifting apart.
func WorkerComponentFor(publicationMode, qualificationProfile string) string {
	if publicationMode == PublicationModeAppGate && qualificationProfile == "" {
		return PublishingWorkerComponent
	}
	return ReceiptOnlyWorkerComponent
}

// BuildWorkerJob builds one non-retrying worker Job. The default projection is
// receipt-only; qualification is admitted only when the immutable profile/model
// pair is explicit and publication is disabled. It refuses to
// build unless the review is still inside its original 15-minute terminal
// window and the caller proves a currently-held PR workspace Lease.
func BuildWorkerJob(input Input) (*batchv1.Job, error) {
	if err := validateInput(input); err != nil {
		return nil, err
	}
	review := input.Review
	spec := review.Spec
	activeDeadlineSeconds, err := remainingDeadlineSeconds(spec.TerminalDeadline.Time, input.Now)
	if err != nil {
		return nil, err
	}
	labels, annotations := workspace.Metadata(spec.RepositoryID, spec.PRNumber)
	labels["review-yeti.ai/component"] = WorkerComponentFor(spec.PublicationMode, spec.QualificationProfile)
	labels["review-yeti.ai/run-id"] = spec.RunID
	labels["review-yeti.ai/publication-mode"] = spec.PublicationMode
	annotations["review-yeti.ai/run-id"] = spec.RunID

	templateLabels := copyStringMap(labels)
	templateAnnotations := copyStringMap(annotations)
	one := int32(1)
	zero := int32(0)
	ttl := JobTTLSeconds
	active := activeDeadlineSeconds
	automountToken := false
	allowPrivilegeEscalation := false
	readOnlyRootFilesystem := true
	runAsNonRoot := true
	runAsUser := int64(1000)
	runAsGroup := int64(1000)
	fsGroup := int64(1000)
	fsGroupChangePolicy := corev1.FSGroupChangeOnRootMismatch
	executionAttempt, err := executionAttemptForSpec(spec)
	if err != nil {
		return nil, err
	}
	env := []corev1.EnvVar{
		{Name: "REVIEW_RUN_ID", Value: spec.RunID},
		{Name: "REVIEW_DELIVERY_ID", Value: spec.DeliveryID},
		{Name: "REVIEW_REPOSITORY_ID", Value: strconv.FormatInt(spec.RepositoryID, 10)},
		{Name: "REVIEW_REPO", Value: spec.Repo},
		{Name: "REVIEW_PR_NUMBER", Value: strconv.Itoa(int(spec.PRNumber))},
		{Name: "REVIEW_HEAD_SHA", Value: spec.HeadSHA},
		{Name: "REVIEW_BASE_SHA", Value: spec.BaseSHA},
		{Name: "REVIEW_POLICY_DIGEST", Value: spec.PolicyDigest},
		{Name: "REVIEW_CONFIG_DIGEST", Value: spec.ConfigDigest},
		{Name: ExecutionAttemptEnv, Value: strconv.FormatInt(int64(executionAttempt), 10)},
		{Name: PublicationModeEnv, Value: spec.PublicationMode},
		{Name: ReceiptPathEnv, Value: ReceiptPath},
	}
	if spec.QualificationProfile == FullPanelQualificationProfile || spec.QualificationProfile == SameHeadQualificationProfile {
		qualificationTimeoutMillis := max(int64(1_000),
			(activeDeadlineSeconds-WorkerReceiptReserveSeconds)*1_000)
		engineRevision := ""
		if strings.Contains(spec.WorkerImage, "@sha256:") {
			engineRevision = spec.WorkerImage[strings.LastIndex(spec.WorkerImage, "@sha256:")+len("@sha256:"):]
		} else if strings.Contains(spec.WorkerImage, ":") {
			engineRevision = spec.WorkerImage[strings.LastIndex(spec.WorkerImage, ":")+1:]
		}
		env = append(env,
			corev1.EnvVar{Name: EngineRevisionEnv, Value: engineRevision},
			corev1.EnvVar{Name: QualificationModelEnv, Value: spec.QualificationModel},
			corev1.EnvVar{Name: QualificationTimeoutEnv, Value: strconv.FormatInt(qualificationTimeoutMillis, 10)},
			corev1.EnvVar{
				Name: "OPENROUTER_API_KEY",
				ValueFrom: &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{
					LocalObjectReference: corev1.LocalObjectReference{Name: spec.RunSecretName},
					Key:                  "OPENROUTER_API_KEY",
				}},
			},
			corev1.EnvVar{
				Name: "OPENROUTER_BASE_URL",
				ValueFrom: &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{
					LocalObjectReference: corev1.LocalObjectReference{Name: spec.RunSecretName},
					Key:                  "OPENROUTER_BASE_URL",
					Optional:             &[]bool{true}[0],
				}},
			},
		)
		if spec.QualificationProfile == FullPanelQualificationProfile {
			env = append(env, corev1.EnvVar{Name: FullPanelQualificationEnv, Value: "true"})
		} else {
			env = append(env,
				corev1.EnvVar{Name: SameHeadQualificationEnv, Value: "true"},
				corev1.EnvVar{
					Name: "GH_TOKEN",
					ValueFrom: &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{
						LocalObjectReference: corev1.LocalObjectReference{Name: spec.RunSecretName},
						Key:                  "GITHUB_READ_TOKEN",
					}},
				},
			)
		}
	} else if spec.PublicationMode == PublicationModeAppGate {
		// REL-586 / ADR 0527: the app-gate publishing lane. Deliberately does NOT set
		// ReceiptOnlyEnv -- that is the single reason every real dispatch previously
		// produced a receipt-only pod that made no provider or GitHub call.
		//
		// Bifrost is the only admitted transport. The worker requires the base URL,
		// model and key with no defaults, so an incomplete configuration must refuse
		// the Job here rather than emit one that fails at runtime: a fail-closed lane
		// turns a misconfiguration into a failed check on every pull request.
		if err := validatePublishing(input.Publishing); err != nil {
			return nil, err
		}
		env = append(env,
			corev1.EnvVar{Name: "BIFROST_BASE_URL", Value: input.Publishing.GatewayBaseURL},
			corev1.EnvVar{Name: "REVIEW_MODEL", Value: input.Publishing.Model},
			corev1.EnvVar{
				Name: "BIFROST_PR_REVIEW_API_KEY",
				ValueFrom: &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{
					LocalObjectReference: corev1.LocalObjectReference{Name: input.Publishing.GatewaySecretName},
					Key:                  input.Publishing.GatewaySecretKey,
				}},
			},
			// The lane resolves its own installation from these two plus the admitted
			// repository; the CRD carries no installation id to project.
			// The worker never holds the App private key. TestBuildWorkerJobAcceptsApp
			// GatePublicationMode asserts that invariant deliberately: this pod parses
			// untrusted pull-request diffs and executes model output, so an App key
			// here would let a compromised worker mint tokens for every installation.
			// The dispatcher mints a short-lived token scoped to this one repository
			// with checks: write, and the worker only ever sees that.
			corev1.EnvVar{
				Name: "GITHUB_PUBLISH_TOKEN",
				ValueFrom: &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{
					LocalObjectReference: corev1.LocalObjectReference{Name: spec.RunSecretName},
					Key:                  "GITHUB_PUBLISH_TOKEN",
				}},
			},
			corev1.EnvVar{
				Name: "GH_TOKEN",
				ValueFrom: &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{
					LocalObjectReference: corev1.LocalObjectReference{Name: spec.RunSecretName},
					Key:                  "GITHUB_READ_TOKEN",
				}},
			},
		)
		if input.Publishing.CompletionURL != "" {
			env = append(env, corev1.EnvVar{Name: CompletionURLEnv, Value: input.Publishing.CompletionURL})
		}
		if spec.PreparedReview != nil {
			env = append(env,
				corev1.EnvVar{Name: AuthoritativeGateEnv, Value: "true"},
				corev1.EnvVar{Name: PreparedConfigEnv, Value: *spec.PreparedReview},
			)
		}
	} else {
		env = append(env, corev1.EnvVar{Name: ReceiptOnlyEnv, Value: "true"})
	}
	container := corev1.Container{
		Name:            "reviewer-worker",
		Image:           spec.WorkerImage,
		ImagePullPolicy: corev1.PullIfNotPresent,
		Resources: corev1.ResourceRequirements{
			Requests: corev1.ResourceList{
				corev1.ResourceCPU:    resource.MustParse("500m"),
				corev1.ResourceMemory: resource.MustParse("768Mi"),
			},
			Limits: corev1.ResourceList{
				corev1.ResourceCPU:    resource.MustParse("1"),
				corev1.ResourceMemory: resource.MustParse("1536Mi"),
			},
		},
		SecurityContext: &corev1.SecurityContext{
			AllowPrivilegeEscalation: &allowPrivilegeEscalation,
			Capabilities:             &corev1.Capabilities{Drop: []corev1.Capability{corev1.Capability("ALL")}},
			ReadOnlyRootFilesystem:   &readOnlyRootFilesystem,
			RunAsNonRoot:             &runAsNonRoot,
			RunAsUser:                &runAsUser,
			RunAsGroup:               &runAsGroup,
		},
		Env: env,
		VolumeMounts: []corev1.VolumeMount{
			{Name: "workspace", MountPath: "/workspace"},
			{Name: "tmp", MountPath: "/tmp"},
		},
	}
	if spec.RunnerMode == "generic" {
		container.Command = []string{"/bin/sh", "-c"}
		container.Args = []string{
			`set -e; ` +
				`if [ "$REVIEW_RECEIPT_ONLY" = "true" ]; then ` +
				`  if [ -f /app/dist/cli/runLiveReview.js ]; then ` +
				`    node /app/dist/cli/runLiveReview.js; ` +
				`  elif [ -f /workspace/dist/cli/runLiveReview.js ]; then ` +
				`    node /workspace/dist/cli/runLiveReview.js; ` +
				`  else ` +
				`    printf '{"timestamp":"%s","level":"INFO","message":"Receipt-only generic runner completed without provider or GitHub calls","runId":"%s","repositoryId":%s,"prNumber":%s}\n' ` +
				`      "$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')" "$REVIEW_RUN_ID" "$REVIEW_REPOSITORY_ID" "$REVIEW_PR_NUMBER"; ` +
				`    printf '{"ok":true,"runId":"%s","profile":"receipt-only","runnerMode":"generic"}\n' "$REVIEW_RUN_ID" > "$REVIEW_RECEIPT_PATH"; ` +
				`  fi; ` +
				`else ` +
				`  if [ -f /workspace/package.json ] && [ ! -d /workspace/node_modules ]; then ` +
				`    (cd /workspace && npm ci --omit=dev --ignore-scripts --no-audit --no-fund); ` +
				`  fi; ` +
				`  if [ -f /workspace/dist/cli/runLiveReview.js ]; then ` +
				`    node /workspace/dist/cli/runLiveReview.js; ` +
				`  else ` +
				`    node /app/dist/cli/runLiveReview.js; ` +
				`  fi; ` +
				`fi`,
		}
	}
	return &batchv1.Job{
		TypeMeta: metav1.TypeMeta{APIVersion: batchv1.SchemeGroupVersion.String(), Kind: "Job"},
		ObjectMeta: metav1.ObjectMeta{
			Name:        review.Name + "-worker",
			Namespace:   review.Namespace,
			Labels:      labels,
			Annotations: annotations,
		},
		Spec: batchv1.JobSpec{
			Completions:             &one,
			Parallelism:             &one,
			BackoffLimit:            &zero,
			ActiveDeadlineSeconds:   &active,
			TTLSecondsAfterFinished: &ttl,
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: templateLabels, Annotations: templateAnnotations},
				Spec: corev1.PodSpec{
					RestartPolicy:                corev1.RestartPolicyNever,
					AutomountServiceAccountToken: &automountToken,
					SecurityContext: &corev1.PodSecurityContext{
						RunAsNonRoot:        &runAsNonRoot,
						RunAsUser:           &runAsUser,
						RunAsGroup:          &runAsGroup,
						FSGroup:             &fsGroup,
						FSGroupChangePolicy: &fsGroupChangePolicy,
						SeccompProfile:      &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault},
					},
					Containers: []corev1.Container{container},
					Volumes: []corev1.Volume{
						{Name: "workspace", VolumeSource: corev1.VolumeSource{PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: input.WorkspacePVCName, ReadOnly: false}}},
						{Name: "tmp", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{}}},
					},
				},
			},
		},
	}, nil
}

// configErr names which check rejected the Job. The controller copies err.Error()
// straight into the PRReviewJob condition, so this text is what an operator sees
// in `kubectl describe`. One undifferentiated error across eleven distinct causes
// sent a real investigation down the wrong path: an app-gate transport that was
// never configured reported itself as a "receipt-only mismatch".
//
// The reasons name configuration fields, never their values -- the gateway
// credential and run secret contents must not reach a CR status message.
func configErr(reason string) error {
	return fmt.Errorf("%w: %s", ErrJobConfiguration, reason)
}

func validateInput(input Input) error {
	if input.Review == nil || input.Now.IsZero() || input.Review.Namespace != Namespace {
		return configErr("review is nil, clock is zero, or namespace is not " + Namespace)
	}
	review := input.Review
	spec := review.Spec
	if len(validation.IsDNS1123Subdomain(review.Name)) != 0 || len(review.Name)+len("-worker") > 63 {
		return configErr("review name is not a valid Kubernetes object name, or is too long for the -worker suffix")
	}
	if !runIDPattern.MatchString(spec.RunID) || len(spec.DeliveryID) == 0 || len(spec.DeliveryID) > 512 || spec.RepositoryID <= 0 ||
		!repoPattern.MatchString(spec.Repo) || spec.PRNumber <= 0 || !shaPattern.MatchString(spec.HeadSHA) || !shaPattern.MatchString(spec.BaseSHA) ||
		!digestPattern.MatchString(spec.PolicyDigest) || !digestPattern.MatchString(spec.ConfigDigest) || (spec.PublicationMode != "disabled" && spec.PublicationMode != "app-gate") ||
		!workerImagePattern.MatchString(spec.WorkerImage) || !secretNamePattern.MatchString(spec.RunSecretName) {
		return configErr("PRReviewJob spec failed identity validation (run/delivery/repo/PR/sha/digest/publication-mode/image/run-secret)")
	}
	if _, err := executionAttemptForSpec(spec); err != nil {
		return err
	}
	if spec.PreparedReview != nil {
		if spec.PublicationMode != PublicationModeAppGate || (spec.RunnerMode != "" && spec.RunnerMode != "prebaked") {
			return configErr("prepared review requires the prebaked app-gate lane")
		}
		if err := validatePreparedReview(*spec.PreparedReview); err != nil {
			return err
		}
	}
	if err := validateQualification(spec.QualificationProfile, spec.QualificationModel); err != nil {
		return err
	}
	// Both qualification lanes assert REVIEW_PUBLICATION_MODE == "disabled" in the
	// worker and hardcode githubWrites: 0. Admitting a profile alongside app-gate
	// would build a Job whose two halves disagree about whether it may publish, so
	// refuse the combination here rather than letting the worker discover it.
	if spec.QualificationProfile != "" && spec.PublicationMode != PublicationModeDisabled {
		return configErr("a qualification profile cannot be combined with publication mode " + spec.PublicationMode)
	}
	if spec.TerminalDeadline.Sub(spec.ReceivedAt.Time) != 15*time.Minute || input.Now.Before(spec.ReceivedAt.Time) {
		return ErrJobDeadline
	}
	if input.WorkspacePVCName != workspace.PVCName(spec.RepositoryID, spec.PRNumber) {
		return configErr("workspace PVC name does not match the repository and PR it claims")
	}
	lease := input.WorkspaceLease
	if !lease.Acquired || lease.Lease == nil || lease.HolderIdentity != spec.RunID {
		return workspace.ErrLeaseHeld
	}
	return workspace.ValidateLeaseForUse(lease.Lease, review.Namespace, spec.RepositoryID, spec.PRNumber, spec.RunID, input.Now)
}

// validatePreparedReview bounds the opaque transport and checks its envelope.
// Config semantics/digest and agreement with the actual injected provider
// transport remain with the shared TypeScript verifier, not this Go builder.
func validatePreparedReview(raw string) error {
	rejected := configErr("prepared review envelope is invalid")
	if len(raw) == 0 || len(raw) > MaxPreparedReviewBytes || !utf8.ValidString(raw) {
		return rejected
	}
	var envelope map[string]json.RawMessage
	if json.Unmarshal([]byte(raw), &envelope) != nil || len(envelope) != 3 {
		return rejected
	}
	var version string
	var config map[string]json.RawMessage
	var transport map[string]json.RawMessage
	if json.Unmarshal(envelope["version"], &version) != nil || version != "PreparedReviewExecution.v1" ||
		json.Unmarshal(envelope["config"], &config) != nil || config == nil ||
		json.Unmarshal(envelope["transport"], &transport) != nil || len(transport) != 2 {
		return rejected
	}
	var baseURL, model string
	if json.Unmarshal(transport["baseUrl"], &baseURL) != nil || utf8.RuneCountInString(baseURL) > 2000 ||
		json.Unmarshal(transport["model"], &model) != nil || len(model) == 0 || utf8.RuneCountInString(model) > 256 ||
		strings.ContainsFunc(model, func(r rune) bool { return r < 32 || r == 127 }) {
		return rejected
	}
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return rejected
	}
	return nil
}

// executionAttemptForSpec uses the explicit CRD field whenever present. The
// suffix path is retained only for CRs persisted before executionAttempt was
// added; it is deliberately bounded and tied back to the run ID instead of
// treating an arbitrary Secret suffix as trusted identity.
func executionAttemptForSpec(spec v1alpha2.PRReviewJobSpec) (int32, error) {
	baseSecretName := "ct-review-run-" + strings.TrimPrefix(spec.RunID, "run_")
	if spec.ExecutionAttempt != nil {
		attempt := *spec.ExecutionAttempt
		if attempt <= 0 {
			return 0, configErr("executionAttempt must be a positive int32")
		}
		expected := baseSecretName
		if attempt > 1 {
			expected = fmt.Sprintf("%s-a%d", baseSecretName, attempt)
		}
		if spec.RunSecretName != expected {
			return 0, configErr("executionAttempt does not match the expected run Secret name")
		}
		return attempt, nil
	}

	// Legacy CRs may omit executionAttempt. Keep the historical -aN form
	// readable, including an explicitly suffixed -a1, but require the Secret
	// prefix to belong to this run and parse the suffix as a bounded int32.
	if spec.RunSecretName == baseSecretName {
		return 1, nil
	}
	index := strings.LastIndex(spec.RunSecretName, "-a")
	if index < 0 || spec.RunSecretName[:index] != baseSecretName {
		return 0, configErr("legacy run Secret name does not match the run ID")
	}
	parsed, err := strconv.ParseInt(spec.RunSecretName[index+2:], 10, 32)
	if err != nil || parsed <= 0 {
		return 0, configErr("legacy run Secret execution suffix is not a positive int32")
	}
	return int32(parsed), nil
}

// validatePublishing refuses an app-gate Job whose required transport is not
// safely specified. Completion reporting is additive: an empty URL preserves
// the legacy check-only worker until the operator enables the callback lane.
func validatePublishing(config PublishingConfig) error {
	var missing []string
	if config.GatewayBaseURL == "" {
		missing = append(missing, "REVIEW_YETI_GATEWAY_BASE_URL")
	}
	if config.Model == "" {
		missing = append(missing, "REVIEW_YETI_REVIEW_MODEL")
	}
	if config.GatewaySecretName == "" {
		missing = append(missing, "REVIEW_YETI_GATEWAY_SECRET_NAME")
	}
	if config.GatewaySecretKey == "" {
		missing = append(missing, "REVIEW_YETI_GATEWAY_SECRET_KEY")
	}
	if len(missing) > 0 {
		return configErr("app-gate publishing transport is not configured on the operator; unset: " + strings.Join(missing, ", "))
	}
	if strings.ContainsAny(config.GatewayBaseURL+config.Model+config.CompletionURL, "\r\n\t ") {
		return configErr("publishing gateway URL or model contains whitespace")
	}
	parsed, err := url.Parse(config.GatewayBaseURL)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" {
		return configErr("publishing gateway URL must be an absolute https URL")
	}
	if config.CompletionURL != "" {
		completion, err := url.Parse(config.CompletionURL)
		if err != nil || completion.Scheme != "https" || completion.Host == "" || completion.User != nil || completion.Fragment != "" {
			return configErr("worker completion URL must be an absolute https URL without userinfo or fragments")
		}
	}
	if len(validation.IsDNS1123Subdomain(config.GatewaySecretName)) != 0 {
		return configErr("publishing gateway secret name is not a valid Kubernetes object name")
	}
	return nil
}

func validateQualification(profile, model string) error {
	if profile == "" {
		if model != "" {
			return configErr("a qualification model was set without a qualification profile")
		}
		return nil
	}
	if (profile != FullPanelQualificationProfile && profile != SameHeadQualificationProfile) || model == "" || len(model) > 256 || model != strings.TrimSpace(model) ||
		strings.EqualFold(model, "auto") || strings.EqualFold(model, "openrouter/auto") || strings.ContainsAny(model, "\r\n\t") {
		return configErr("qualification profile or model is unknown, empty, whitespace-bearing, or an auto-routing alias")
	}
	return nil
}

func remainingDeadlineSeconds(deadline, now time.Time) (int64, error) {
	remaining := deadline.Sub(now)
	if remaining < time.Duration(MinRemainingSeconds)*time.Second {
		return 0, workspace.ErrInsufficientDeadline
	}
	// Floor rather than ceil: an integer Kubernetes deadline must not extend
	// past the authenticated terminal deadline when `now` includes fractions
	// of a second.
	seconds := int64(math.Floor(remaining.Seconds())) - DeadlineReserveSeconds
	if seconds <= 0 || seconds > MaxActiveDeadlineSeconds {
		if seconds > MaxActiveDeadlineSeconds {
			seconds = MaxActiveDeadlineSeconds
		} else {
			return 0, ErrJobDeadline
		}
	}
	return seconds, nil
}

func copyStringMap(input map[string]string) map[string]string {
	output := make(map[string]string, len(input))
	for key, value := range input {
		output[key] = value
	}
	return output
}
