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
	"os"
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
	ZoektGroundingEnabledEnv      = "ZOEKT_GROUNDING_ENABLED"
	ZoektGroundingDisabledEnv     = "ZOEKT_GROUNDING_DISABLED"
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
	// Jobs are disposable execution records. TTL 0 makes kube delete a
	// *succeeded* Job as soon as it reaches Complete (see
	// WorkerSuccessTTLSeconds). A failed Job is built with the longer
	// WorkerFailedTTLSeconds instead (REL-896) so its Pod and logs survive
	// long enough to be read; the controller patches the TTL down to this
	// value once it observes the worker succeeded.
	JobTTLSeconds = int32(0)
	// DefaultWorkerFailedTTLAfterFinished keeps a failed worker's Job (and
	// therefore its Pod/logs) alive for one hour by default instead of the
	// instant collection every outcome previously got from JobTTLSeconds=0.
	DefaultWorkerFailedTTLAfterFinished = int32(3600)
	WorkerTTLAfterFinishedEnv           = "REVIEW_YETI_WORKER_TTL_AFTER_FINISHED"
	WorkerFailedTTLAfterFinishedEnv     = "REVIEW_YETI_WORKER_FAILED_TTL_AFTER_FINISHED"
	// DefaultWorkerForensicHoldSeconds is the floor on the TTL a worker Job is
	// built with. The operator copies the worker Pod's termination record into
	// PRReviewJob status.workerTermination and only then lowers the Job's TTL
	// to the outcome's configured value, so a failed TTL of 0 no longer lets
	// the TTL controller collect the Pod before the operator has read it. The
	// hold only matters if the operator is down or stalled for this long; it
	// is never the retention an observed Job actually gets.
	DefaultWorkerForensicHoldSeconds = int32(300)
	WorkerForensicHoldEnv            = "REVIEW_YETI_WORKER_FORENSIC_HOLD_SECONDS"
	// WorkerCPULimitEnv set to an empty string (or "none") removes the worker
	// container's CPU limit so a review can burst onto idle node CPU without
	// CFS throttling; the memory limit always stays. Leaving the variable
	// unset keeps the historical WorkerCPULimit default.
	WorkerCPULimitEnv = "REVIEW_YETI_WORKER_CPU_LIMIT"
	// WorkerPodNameEnv and WorkerPodNamespaceEnv are downward-API projections of
	// the worker Pod's own identity. The worker prints them as a log-store
	// locator in its check output; they carry no credential.
	WorkerPodNameEnv      = "REVIEW_WORKER_POD_NAME"
	WorkerPodNamespaceEnv = "REVIEW_WORKER_POD_NAMESPACE"
	// QualificationGatewayKeyEnv / QualificationGatewayURLEnv are the admitted
	// gateway settings on the QUALIFICATION path (REL-1069).
	//
	// Exported because the builder and the reconciler's validator must agree on
	// them: a mismatch makes the controller reject and DELETE the Job it just
	// created, and that coupling is what the review flagged as unpinned. Naming
	// them once makes a rename a compile-visible change instead of a silent
	// literal drift across two files.
	QualificationGatewayKeyEnv = "OPENAI_API_KEY"
	QualificationGatewayURLEnv = "OPENAI_BASE_URL"
	// WorkerContainerName is the single worker container's name. The
	// controller reads that container's termination state by this name.
	WorkerContainerName = "reviewer-worker"
	// HostnameTopologyKey spreads worker Pods across nodes.
	HostnameTopologyKey = "kubernetes.io/hostname"
	// DefaultTerminalRetentionSeconds is how long a terminal PRReviewJob (see
	// isTerminalPhase in the controller) is kept before the operator deletes
	// it, letting Kubernetes garbage collection cascade to the worker Job it
	// owns. One hour gives an operator time to `kubectl describe`/`get -o
	// yaml` a finished review before it disappears.
	DefaultTerminalRetentionSeconds = int64(3600)
	TerminalRetentionSecondsEnv     = "REVIEW_YETI_TERMINAL_RETENTION_SECONDS"
	// DefaultTerminalMaxRetentionSeconds bounds how long a terminal review may
	// be held even while its FailurePublication condition is still Unknown
	// (DelegatedToTrustedService; see reconcileFailurePublication in the
	// controller). Nothing in this repository ever resolves that condition
	// away from Unknown once it is set -- the dispatcher's abandoned-run
	// reaper (src/review/abandonedRunReaper.ts) reconciles the GitHub check
	// entirely against PostgreSQL and a fresh App token, and never touches
	// this Kubernetes object. Without a hard cap, a review whose delegation
	// never resolves would retain its run Secret forever.
	DefaultTerminalMaxRetentionSeconds = int64(86400)
	TerminalMaxRetentionSecondsEnv     = "REVIEW_YETI_TERMINAL_MAX_RETENTION_SECONDS"
	WorkerCPURequest                   = "250m"
	WorkerMemoryRequest                = "512Mi"
	WorkerCPULimit                     = "1"
	WorkerMemoryLimit                  = "1536Mi"
	// The CRD's CEL rule bounds terminalDeadline - receivedAt to [900s, 3600s]
	// (see charts/review-yeti/templates/crd.yaml and
	// k8s-operator/config/crd/bases/review-yeti.ai_prreviewjobs.yaml). Keep
	// these two in lockstep with that rule and with the TypeScript dispatch
	// side's src/config/terminalDeadline.ts MIN/MAX.
	MinTerminalDeadlineSeconds = int64(900)
	MaxTerminalDeadlineSeconds = int64(3600)
	// Keep a one-minute publication/failure-conclusion reserve inside the
	// admitted run deadline. The worker itself may never consume the full
	// admission window.
	DeadlineReserveSeconds = int64(60)
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
	// Single source of truth in v1alpha2: the CRD marker and this runtime
	// validator must describe ONE control. A private copy here silently diverged
	// when the contract moved to digest pinning, rejecting values the CRD admits.
	workerImagePattern = regexp.MustCompile(v1alpha2.WorkerImagePattern)
	secretNamePattern  = regexp.MustCompile(`^ct-review-run-[a-f0-9]{32}(-a[1-9][0-9]*)?$`)
)

// Input is the immutable review projection plus fresh workspace ownership
// evidence.  No Secret object or credential is accepted by this builder.
type Input struct {
	Review *v1alpha2.PRReviewJob
	// WorkspacePVCName is required only when Review.Spec.RunnerMode == "generic".
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
	// REL-677: optional zoekt grounding passthrough. Empty means "leave the
	// worker's default (off)"; the operator only forwards what deployment
	// configuration explicitly set, so review runs without grounding stay
	// byte-identical until ct-infrastructure opts in.
	ZoektGroundingEnabled  string
	ZoektGroundingDisabled string
	// REL-1086: optional Jev (TypeSafe AI) transport. JevSecretName names a
	// Secret holding exactly the JevTransportEnvKeys; empty means Jev is not
	// provisioned and the worker receives none of them. JevShadow is forwarded
	// verbatim as JevShadowEnv when non-empty.
	JevSecretName string
	JevShadow     string
	// REL-1079: deterministic diff shrinking. Forwarded verbatim as
	// DiffShrinkEnv when non-empty; the worker owns its interpretation (a
	// comma-separated owner/repo allowlist, or an on/off switch). Empty keeps
	// shrinking off, byte-identical to before this field existed.
	DiffShrink string
	// REL-1084: incremental re-review on synchronize. Forwarded verbatim as
	// IncrementalEnv when non-empty; the worker owns its interpretation (a
	// comma-separated owner/repo allowlist, or an on/off switch). Empty keeps
	// every review full, byte-identical to before this field existed.
	Incremental string
	// REL-1082: risk-ordered review budget per lane. Forwarded verbatim as
	// BudgetEnv when non-empty; the worker owns its interpretation (a
	// comma- or space-separated owner/repo allowlist, or an on/off switch).
	// Empty keeps the budget off, byte-identical to before this field existed.
	Budget string
}

// BudgetEnv is the worker's risk-ordered review-budget flag (REL-1082,
// src/review/reviewBudget.ts REVIEW_BUDGET_FLAG). The operator forwards the
// deployment value verbatim; the worker owns its interpretation.
const BudgetEnv = "REVIEW_YETI_BUDGET"

// IncrementalEnv is the worker's incremental re-review flag (REL-1084,
// src/review/incrementalReview.ts INCREMENTAL_FLAG). The operator forwards the
// deployment value verbatim; the worker owns its interpretation.
const IncrementalEnv = "REVIEW_YETI_INCREMENTAL"

// DiffShrinkEnv is the worker's deterministic diff-shrinking flag (REL-1079,
// src/review/diffShrink.ts DIFF_SHRINK_FLAG). The operator forwards the
// deployment value verbatim; the worker owns its interpretation.
const DiffShrinkEnv = "REVIEW_YETI_DIFF_SHRINK"

// JevShadowEnv is the worker's Jev (TypeSafe AI) shadow-triage flag
// (REL-1081). The operator forwards the deployment value verbatim; the worker
// owns its interpretation.
const JevShadowEnv = "REVIEW_YETI_JEV_SHADOW"

// JevTransportEnvKeys are the worker's Jev transport variables
// (src/review/jevTransport.ts). The worker treats all-absent as "Jev disabled"
// and SOME-present as a misconfiguration that fails the review, so the operator
// projects all four together or none of them -- never a subset.
var JevTransportEnvKeys = []string{"TYPESAFE_BASE_URL", "TYPESAFE_MODEL", "TYPESAFE_API_KEY", "TYPESAFE_MODEL_PIN"}

// jevTransportEnv projects the four Jev variables from one Secret, same key
// name as env name. Each reference is OPTIONAL on purpose: if the Secret has
// not synced yet (or its Doppler sync broke) all four are absent together and
// the worker falls back to today's review, instead of the pod failing
// admission and taking every review down with it. A Secret carrying only some
// of the keys is prevented upstream by the DopplerSecret contract in
// ct-infrastructure, which pins the exact four-key mapping.
func jevTransportEnv(secretName string) []corev1.EnvVar {
	if secretName == "" {
		return nil
	}
	optional := true
	env := make([]corev1.EnvVar, 0, len(JevTransportEnvKeys))
	for _, key := range JevTransportEnvKeys {
		env = append(env, corev1.EnvVar{
			Name: key,
			ValueFrom: &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{
				LocalObjectReference: corev1.LocalObjectReference{Name: secretName},
				Key:                  key,
				Optional:             &optional,
			}},
		})
	}
	return env
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
	activeDeadlineSeconds, err := remainingDeadlineSeconds(spec.ReceivedAt.Time, spec.TerminalDeadline.Time, input.Now)
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
	// Build with the fail-safe (longer) TTL. batch/v1 has exactly one
	// ttlSecondsAfterFinished field and the outcome is not known yet at build
	// time, so this Job is built as if it will fail; the controller patches
	// this down to WorkerSuccessTTLSeconds() once it observes Succeeded
	// (see reconcileExistingJob). If that patch is ever missed -- crash,
	// conflict, operator restart -- the Job is still collected after this
	// longer TTL instead of leaking forever.
	//
	// The build TTL is additionally floored at WorkerForensicHoldSeconds: the
	// controller lowers it to the outcome's configured TTL only after the Pod's
	// termination record is durable in the parent status.
	ttl := WorkerBuildTTLSeconds()
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
		{Name: "CT_REVIEW_DATA_DIR", Value: "/tmp/.ct-memory"},
		{Name: WorkerPodNameEnv, ValueFrom: &corev1.EnvVarSource{FieldRef: &corev1.ObjectFieldSelector{FieldPath: "metadata.name"}}},
		{Name: WorkerPodNamespaceEnv, ValueFrom: &corev1.EnvVarSource{FieldRef: &corev1.ObjectFieldSelector{FieldPath: "metadata.namespace"}}},
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
			// REL-1069: these were the only OPENROUTER_* vars left in the
			// qualification path, and no per-run secret carries either key --
			// the key was NON-optional, so a qualification profile would have
			// failed at pod admission with a missing-secret error. The transport
			// is the admitted OpenAI-compatible gateway, so use the standard
			// names and keep them OPTIONAL: a qualification worker that lacks a
			// gateway key must fail on its own contract check (which names the
			// missing variable) rather than on an opaque secret resolution.
			corev1.EnvVar{
				Name: QualificationGatewayKeyEnv,
				ValueFrom: &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{
					LocalObjectReference: corev1.LocalObjectReference{Name: spec.RunSecretName},
					Key:                  QualificationGatewayKeyEnv,
					Optional:             &[]bool{true}[0],
				}},
			},
			corev1.EnvVar{
				Name: QualificationGatewayURLEnv,
				ValueFrom: &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{
					LocalObjectReference: corev1.LocalObjectReference{Name: spec.RunSecretName},
					Key:                  QualificationGatewayURLEnv,
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
		// OpenAI-compatible gateway is the only admitted transport. The worker requires the base URL,
		// model and key with no defaults, so an incomplete configuration must refuse
		// the Job here rather than emit one that fails at runtime: a fail-closed lane
		// turns a misconfiguration into a failed check on every pull request.
		if err := validatePublishing(input.Publishing); err != nil {
			return nil, err
		}
		gatewayURL := input.Publishing.GatewayBaseURL
		reviewModel := input.Publishing.Model
		// The prepared envelope's transport is what the config digest was
		// computed from. A separately configured operator URL must not be
		// injected instead: the worker then rejects the job as an identity
		// mismatch before it calls the model.
		if spec.PreparedReview != nil {
			admittedURL, admittedModel, err := admittedPreparedTransport(*spec.PreparedReview)
			if err != nil {
				return nil, err
			}
			gatewayURL = admittedURL
			reviewModel = admittedModel
		}
		env = append(env,
			corev1.EnvVar{Name: "OPENAI_BASE_URL", Value: gatewayURL},
			corev1.EnvVar{Name: "REVIEW_MODEL", Value: reviewModel},
			corev1.EnvVar{
				Name: "OPENAI_API_KEY",
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
		if input.Publishing.ZoektGroundingEnabled != "" {
			env = append(env, corev1.EnvVar{Name: ZoektGroundingEnabledEnv, Value: input.Publishing.ZoektGroundingEnabled})
		}
		if input.Publishing.ZoektGroundingDisabled != "" {
			env = append(env, corev1.EnvVar{Name: ZoektGroundingDisabledEnv, Value: input.Publishing.ZoektGroundingDisabled})
		}
		env = append(env, jevTransportEnv(input.Publishing.JevSecretName)...)
		if input.Publishing.JevShadow != "" {
			env = append(env, corev1.EnvVar{Name: JevShadowEnv, Value: input.Publishing.JevShadow})
		}
		if input.Publishing.DiffShrink != "" {
			env = append(env, corev1.EnvVar{Name: DiffShrinkEnv, Value: input.Publishing.DiffShrink})
		}
		if input.Publishing.Incremental != "" {
			env = append(env, corev1.EnvVar{Name: IncrementalEnv, Value: input.Publishing.Incremental})
		}
		if input.Publishing.Budget != "" {
			env = append(env, corev1.EnvVar{Name: BudgetEnv, Value: input.Publishing.Budget})
		}
	} else {
		env = append(env, corev1.EnvVar{Name: ReceiptOnlyEnv, Value: "true"})
	}
	container := corev1.Container{
		Name:            WorkerContainerName,
		Image:           spec.WorkerImage,
		ImagePullPolicy: corev1.PullIfNotPresent,
		Resources: corev1.ResourceRequirements{
			Requests: corev1.ResourceList{
				corev1.ResourceCPU:    quantityFromEnv("REVIEW_YETI_WORKER_CPU_REQUEST", WorkerCPURequest),
				corev1.ResourceMemory: quantityFromEnv("REVIEW_YETI_WORKER_MEMORY_REQUEST", WorkerMemoryRequest),
			},
			Limits: workerLimits(),
		},
		// On a failed exit with no explicit termination message, the kubelet
		// copies the tail of the container log into the termination state. The
		// controller keeps the last line of it in status.workerTermination, so
		// the parent record names the error even after the Pod is collected.
		TerminationMessagePolicy: corev1.TerminationMessageFallbackToLogsOnError,
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
	var workspaceVolume corev1.VolumeSource
	if spec.RunnerMode == "generic" {
		workspaceVolume = corev1.VolumeSource{
			PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{
				ClaimName: input.WorkspacePVCName,
				ReadOnly:  false,
			},
		}
	} else {
		sizeLimit := WorkerStorageSize()
		workspaceVolume = corev1.VolumeSource{
			EmptyDir: &corev1.EmptyDirVolumeSource{
				SizeLimit: &sizeLimit,
			},
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
					// Soft spread: never blocks scheduling, but stops concurrent
					// workers from packing onto one node while another is idle.
					TopologySpreadConstraints: workerTopologySpread(),
					Volumes: []corev1.Volume{
						{Name: "workspace", VolumeSource: workspaceVolume},
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

// IsValidRunSecretName reports whether name matches the run-Secret naming
// contract this package already enforces on every worker build
// (secretNamePattern, checked by validateInput below) -- and which the
// TypeScript dispatcher defines canonically in buildRunSecretName
// (src/k8s/reviewJobProjection.ts): "ct-review-run-" followed by the run ID's
// 32 lowercase hex characters, with an optional "-a<N>" execution-attempt
// suffix. Callers outside this package that need to act on a Secret purely by
// its declared name -- and must never fall back to a label selector or List
// to find it -- use this exact check first. The v1alpha2 operator's
// run-Secret cleanup finalizer (prreviewjob_v1alpha2_controller.go) is the
// first such caller: it must not delete a Secret whose name it cannot prove
// is this review's own run Secret.
func IsValidRunSecretName(name string) bool {
	return secretNamePattern.MatchString(name)
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
		!workerImagePattern.MatchString(spec.WorkerImage) || !IsValidRunSecretName(spec.RunSecretName) {
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
	window := spec.TerminalDeadline.Sub(spec.ReceivedAt.Time)
	if window < time.Duration(MinTerminalDeadlineSeconds)*time.Second || window > time.Duration(MaxTerminalDeadlineSeconds)*time.Second ||
		input.Now.Before(spec.ReceivedAt.Time) {
		return ErrJobDeadline
	}
	if spec.RunnerMode == "generic" {
		if input.WorkspacePVCName != workspace.PVCName(spec.RepositoryID, spec.PRNumber) {
			return configErr("workspace PVC name does not match the repository and PR it claims")
		}
	}
	lease := input.WorkspaceLease
	if !lease.Acquired || lease.Lease == nil || lease.HolderIdentity != spec.RunID {
		return workspace.ErrLeaseHeld
	}
	return workspace.ValidateLeaseForUse(lease.Lease, review.Namespace, spec.RepositoryID, spec.PRNumber, spec.RunID, input.Now)
}

// validatePreparedReview bounds the opaque transport and checks its envelope.
// The job's provider URL and model are copied from this admitted transport so
// they cannot drift from the config digest. Both languages exercise
// testdata/prepared-review-execution.json.
func validatePreparedReview(raw string) error {
	_, _, err := admittedPreparedTransport(raw)
	return err
}

func admittedPreparedTransport(raw string) (string, string, error) {
	rejected := configErr("prepared review envelope is invalid")
	if len(raw) == 0 || len(raw) > MaxPreparedReviewBytes || !utf8.ValidString(raw) {
		return "", "", rejected
	}
	var envelope map[string]json.RawMessage
	if json.Unmarshal([]byte(raw), &envelope) != nil || len(envelope) != 3 {
		return "", "", rejected
	}
	var version string
	var config map[string]json.RawMessage
	var transport map[string]json.RawMessage
	if json.Unmarshal(envelope["version"], &version) != nil || version != "PreparedReviewExecution.v1" ||
		json.Unmarshal(envelope["config"], &config) != nil || config == nil ||
		json.Unmarshal(envelope["transport"], &transport) != nil || len(transport) != 2 {
		return "", "", rejected
	}
	var baseURL, model string
	if json.Unmarshal(transport["baseUrl"], &baseURL) != nil || utf16CodeUnits(baseURL) > 2000 ||
		json.Unmarshal(transport["model"], &model) != nil || len(model) == 0 || utf16CodeUnits(model) > 256 ||
		strings.ContainsFunc(model, func(r rune) bool { return r < 32 || r == 127 }) {
		return "", "", rejected
	}
	// Reject raw spelling that URL parsers normalize differently, including
	// empty query/fragment delimiters. Escaped path characters remain valid.
	if strings.ContainsAny(baseURL, "\\?#") || strings.ContainsFunc(baseURL, func(r rune) bool { return r <= 32 || r == 127 }) {
		return "", "", rejected
	}
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", "", rejected
	}
	if port := parsed.Port(); port != "" {
		if _, err := strconv.ParseUint(port, 10, 16); err != nil {
			return "", "", rejected
		}
	}
	return baseURL, model, nil
}

// Match TypeScript/Zod string limits, which count UTF-16 units rather than
// Unicode code points. Astral characters consume two units in both validators.
func utf16CodeUnits(value string) int {
	units := 0
	for _, r := range value {
		units++
		if r > 0xffff {
			units++
		}
	}
	return units
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
	if config.JevSecretName != "" && len(validation.IsDNS1123Subdomain(config.JevSecretName)) != 0 {
		return configErr("jev transport secret name is not a valid Kubernetes object name")
	}
	if strings.ContainsAny(config.JevShadow, "\r\n\t ") {
		return configErr("jev shadow flag contains whitespace")
	}
	// The worker accepts a comma- OR space-separated allowlist, so spaces are
	// legitimate here (unlike the on/off Jev flag); only a line break, which
	// no allowlist needs and a pasted value can smuggle in, is refused.
	if strings.ContainsAny(config.DiffShrink, "\r\n") {
		return configErr("diff shrink flag contains a line break")
	}
	// Same allowlist grammar as the diff shrink flag.
	if strings.ContainsAny(config.Incremental, "\r\n") {
		return configErr("incremental flag contains a line break")
	}
	// Same allowlist grammar as the diff shrink flag: spaces are legitimate,
	// a line break is not.
	if strings.ContainsAny(config.Budget, "\r\n") {
		return configErr("review budget flag contains a line break")
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

func remainingDeadlineSeconds(receivedAt, deadline, now time.Time) (int64, error) {
	remaining := deadline.Sub(now)
	if remaining < time.Duration(MinRemainingSeconds)*time.Second {
		return 0, workspace.ErrInsufficientDeadline
	}
	// The worker's own budget must never exceed this run's admitted window
	// (validateInput already bounds that window to [900s, 3600s]) minus the
	// publication/failure-conclusion reserve, even when more of the terminal
	// deadline happens to remain.
	windowCapSeconds := int64(math.Round(deadline.Sub(receivedAt).Seconds())) - DeadlineReserveSeconds
	// Floor rather than ceil: an integer Kubernetes deadline must not extend
	// past the authenticated terminal deadline when `now` includes fractions
	// of a second.
	seconds := int64(math.Floor(remaining.Seconds())) - DeadlineReserveSeconds
	if seconds <= 0 || windowCapSeconds <= 0 {
		return 0, ErrJobDeadline
	}
	if seconds > windowCapSeconds {
		seconds = windowCapSeconds
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

func int32FromEnv(name string, fallback int32) int32 {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}
	parsed, err := strconv.ParseInt(raw, 10, 32)
	if err != nil || parsed < 0 {
		return fallback
	}
	return int32(parsed)
}

// Int64FromEnv keeps the same invalid/negative-falls-back-to-default
// semantics as int32FromEnv, for the wider retention windows (up to 86400s
// and beyond) that would not always fit an int32 boundary check cleanly.
func Int64FromEnv(name string, fallback int64) int64 {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}
	parsed, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || parsed < 0 {
		return fallback
	}
	return parsed
}

// WorkerSuccessTTLSeconds is the TTL a succeeded worker Job is patched down
// to once the controller observes its success (default 0: collect
// immediately, matching the pre-REL-896 behavior for successful runs).
func WorkerSuccessTTLSeconds() int32 {
	return int32FromEnv(WorkerTTLAfterFinishedEnv, JobTTLSeconds)
}

// WorkerFailedTTLSeconds is the TTL a failed worker Job keeps once the
// controller has recorded its termination. It is also the TTL a worker Job is
// built with (floored by WorkerForensicHoldSeconds), so a failed worker's Pod
// and logs survive for this long even if the controller never observes and
// patches the outcome.
func WorkerFailedTTLSeconds() int32 {
	return int32FromEnv(WorkerFailedTTLAfterFinishedEnv, DefaultWorkerFailedTTLAfterFinished)
}

// WorkerForensicHoldSeconds is the minimum TTL a worker Job is built with, so
// the controller can read the worker Pod's termination state before the TTL
// controller collects the Pod.
func WorkerForensicHoldSeconds() int32 {
	return int32FromEnv(WorkerForensicHoldEnv, DefaultWorkerForensicHoldSeconds)
}

// WorkerBuildTTLSeconds is the ttlSecondsAfterFinished a worker Job is created
// with: the failed-outcome TTL, never lower than the forensic hold.
func WorkerBuildTTLSeconds() int32 {
	return max(WorkerFailedTTLSeconds(), WorkerForensicHoldSeconds())
}

// WorkerFinishedTTLSeconds is the TTL a finished worker Job is lowered to once
// its termination record is durable in the parent status.
func WorkerFinishedTTLSeconds(succeeded bool) int32 {
	if succeeded {
		return WorkerSuccessTTLSeconds()
	}
	return WorkerFailedTTLSeconds()
}

// workerLimits keeps the memory limit unconditionally and the CPU limit
// unless REVIEW_YETI_WORKER_CPU_LIMIT is explicitly set to "" or "none".
func workerLimits() corev1.ResourceList {
	limits := corev1.ResourceList{
		corev1.ResourceMemory: quantityFromEnv("REVIEW_YETI_WORKER_MEMORY_LIMIT", WorkerMemoryLimit),
	}
	if cpu, limited := WorkerCPULimitQuantity(); limited {
		limits[corev1.ResourceCPU] = cpu
	}
	return limits
}

// WorkerCPULimitQuantity reports the worker CPU limit and whether one applies.
// Unset keeps the WorkerCPULimit default; an explicit "" or "none" means no
// CPU limit; an unparseable value falls back to the default rather than
// silently lifting the limit.
func WorkerCPULimitQuantity() (resource.Quantity, bool) {
	raw, set := os.LookupEnv(WorkerCPULimitEnv)
	if !set {
		return resource.MustParse(WorkerCPULimit), true
	}
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || strings.EqualFold(trimmed, "none") {
		return resource.Quantity{}, false
	}
	quantity, err := resource.ParseQuantity(trimmed)
	if err != nil {
		return resource.MustParse(WorkerCPULimit), true
	}
	return quantity, true
}

// workerTopologySpread spreads every worker lane together across nodes. It is
// ScheduleAnyway, so a single schedulable node still runs every worker.
func workerTopologySpread() []corev1.TopologySpreadConstraint {
	return []corev1.TopologySpreadConstraint{{
		MaxSkew:           1,
		TopologyKey:       HostnameTopologyKey,
		WhenUnsatisfiable: corev1.ScheduleAnyway,
		LabelSelector: &metav1.LabelSelector{MatchExpressions: []metav1.LabelSelectorRequirement{{
			Key:      "review-yeti.ai/component",
			Operator: metav1.LabelSelectorOpIn,
			Values:   []string{ReceiptOnlyWorkerComponent, PublishingWorkerComponent},
		}}},
	}}
}

// TerminalRetentionSeconds is the delay after a PRReviewJob becomes terminal
// before the operator deletes it (see reconcileTerminalDeletion).
func TerminalRetentionSeconds() int64 {
	return Int64FromEnv(TerminalRetentionSecondsEnv, DefaultTerminalRetentionSeconds)
}

// TerminalMaxRetentionSeconds is the hard cap applied even when a terminal
// review's FailurePublication condition is still Unknown (see
// reconcileTerminalDeletion and reconcileFailurePublication).
func TerminalMaxRetentionSeconds() int64 {
	return Int64FromEnv(TerminalMaxRetentionSecondsEnv, DefaultTerminalMaxRetentionSeconds)
}

func WorkerStorageSize() resource.Quantity {
	return quantityFromEnv("REVIEW_YETI_WORKER_STORAGE_SIZE", "1Gi")
}

func quantityFromEnv(name, fallback string) resource.Quantity {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		raw = fallback
	}
	quantity, err := resource.ParseQuantity(raw)
	if err != nil {
		return resource.MustParse(fallback)
	}
	return quantity
}
