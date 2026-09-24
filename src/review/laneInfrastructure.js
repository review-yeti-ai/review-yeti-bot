'use strict';

/**
 * REL-1113: the ONE implementation of "a reviewer lane failed on the path to the model, not on
 * anything the model said" -- the lane failure classifier, the lane transport-retry schedule, the
 * shared infrastructure-incomplete decision, and the INCOMPLETE title format.
 *
 * Plain CommonJS with a sibling `.d.ts` (the same pattern as `reviewCore.js` and
 * `findingPublication.js`) so that BOTH review runtimes read the same code:
 * - the TypeScript worker/panel (`publicationFailurePolicy.ts`, `reviewCheckIdentity.ts`,
 *   `workerCompletion.ts` and `panelEngine.ts` re-export from here), and
 * - the composite GitHub Action's legacy pipeline
 *   (`.github/workflows/pipelines/review-pipeline.js`), which runs under plain Node with only the
 *   lock-backed legacy-runtime graph and cannot load TypeScript.
 *
 * Deliberately dependency-free: no imports at all, so the Action can `require` it from a bare
 * checkout. Never fork any of these decisions into either runtime.
 */

/**
 * Message/status-pattern failure classifier shared by the panel's `classifyPersonaAttemptFailure`
 * (`../panel/panelEngine`, after its typed `instanceof` checks), the publisher's `classifyFailure`
 * (`../cli/publishingReview`), and the Action pipeline's lane classifier (`classifyLaneFailure`
 * below). It lives in exactly one place (REL-892) so the published failure class and the retry
 * predicate can never drift.
 */
function classifyWorkerFailureMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/turn budget exhausted|budget exhausted|exceeded total retry\/execution budget/iu.test(message)) return 'budget_exhausted';
  if (/timeout|timed out|ETIMEDOUT|exceeded (?:the )?(?:total )?deadline/iu.test(message)) return 'timeout';
  if (/401|403|unauthor|virtual key/iu.test(message)) return 'auth';
  if (/429|rate limit/iu.test(message)) return 'rate_limit';
  // REL-1113: the path to the model failing -- refused/reset/unreachable connections, an
  // interrupted stream ("terminated") -- is transport. This is the single source the lane
  // retry predicate (`isTransientLaneTransportError`) and the published class both read.
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ECONNABORTED|EPIPE|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|UND_ERR_SOCKET|UND_ERR_CLOSED|fetch failed|socket hang up|other side closed|\bterminated\b/iu.test(message)) return 'transport';
  if (/invalid (?:or missing )?(?:native )?JSON|native JSON response must be an object|invalid findings contract|invalid .*response contract|cannot contain findings|requires at least one finding|nonce-fenced structured output|reported INCOMPLETE without a completed review|optional reviewer did not complete/iu.test(message)) {
    return 'malformed_output';
  }
  if (/provider|gateway|model/iu.test(message)) return 'provider_error';
  return 'internal_error';
}

/**
 * The class a provider HTTP error response publishes: 401/403 are credentials, 429 is an explicit
 * "slow down", and every other error status is the provider failing the request. Shared by the
 * panel's typed `OpenRouterResponseError` branch and the Action pipeline, which only has the
 * lane's last response status. `undefined` for anything that is not an HTTP error status.
 */
function classifyProviderResponseStatus(status) {
  const code = Number(status);
  if (!Number.isInteger(code) || code < 400 || code > 599) return undefined;
  if (code === 401 || code === 403) return 'auth';
  if (code === 429) return 'rate_limit';
  return 'provider_error';
}

/**
 * The coded class of a lane that failed with only an HTTP status and a free-form error (the
 * Action pipeline's lane shape): the provider status when the lane ended on an HTTP error
 * response, otherwise the shared message ladder.
 */
function classifyLaneFailure({ status, error } = {}) {
  return classifyProviderResponseStatus(status) ?? classifyWorkerFailureMessage(error ?? '');
}

/**
 * REL-1113: lane failure classes that describe the path to the model, not an
 * answer from it. A lane that failed with one of these produced no review of
 * the diff; the run is incomplete for an infrastructure reason. `malformed_output`,
 * `budget_exhausted`, `auth`, `contract` and `internal_error` are deliberately
 * excluded: a fresh attempt is not expected to clear them.
 */
const INFRASTRUCTURE_LANE_FAILURE_CLASSES = Object.freeze(['transport', 'provider_error', 'rate_limit', 'timeout']);

/** REL-1113: the bounded diagnostic reason (and log/metric reason class) for a
 * run that is incomplete because lanes failed on infrastructure. */
const INCOMPLETE_INFRASTRUCTURE_REASON = 'lane_infrastructure_incomplete';

/**
 * REL-1113: the ONE decision, shared by the publishing worker, the trusted
 * completion service and the GitHub Action pipeline, that a review result is
 * "incomplete for an infrastructure reason" rather than a review verdict.
 *
 * True only when ALL of these hold:
 * - the caller explicitly marked the result (`failureDiagnostics.reason` is
 *   `INCOMPLETE_INFRASTRUCTURE_REASON` and `recoverableIncompletePanel`);
 * - coverage was complete (a file no lane could read is deterministic and a
 *   retry reads the same diff) and quorum was NOT satisfied;
 * - no gating lane reported any finding (a finding is evidence about the code:
 *   a findings BLOCK stays a BLOCK and is never re-rolled);
 * - at least one gating lane failed, and every failed gating lane failed with
 *   an infrastructure class.
 * Shadow lanes (`evidenceSource: 'shadow'`) are non-gating and ignored.
 */
function isInfrastructureIncompleteResult(result) {
  if (!result || !Array.isArray(result.personas)) return false;
  const diagnostics = result.failureDiagnostics;
  if (diagnostics?.reason !== INCOMPLETE_INFRASTRUCTURE_REASON || diagnostics.recoverableIncompletePanel !== true) return false;
  if (result.coverageComplete !== true || result.quorumSatisfied !== false) return false;
  const gating = result.personas.filter((persona) => persona.evidenceSource !== 'shadow');
  if (gating.length === 0) return false;
  if (gating.some((persona) => !Array.isArray(persona.findings) || persona.findings.length > 0)) return false;
  const failed = gating.filter((persona) => persona.decision === 'ERROR' || persona.status === 'ERROR');
  if (failed.length === 0) return false;
  return failed.every((persona) => INFRASTRUCTURE_LANE_FAILURE_CLASSES.includes(String(persona.errorClass)));
}

/** REL-1113: extract a provider HTTP status (e.g. the nginx `HTTP 502`) from a
 * lane's free-form error without publishing any of that text. */
function laneProviderStatus(error) {
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  const matches = [...message.matchAll(/\bHTTP (\d{3})\b/gu)];
  const last = matches.length > 0 ? Number(matches[matches.length - 1][1]) : Number.NaN;
  return Number.isInteger(last) && last >= 400 && last <= 599 ? last : undefined;
}

/** GitHub's hard maximum for the output.title field on a Check Run. */
const MAX_CHECK_RUN_TITLE_CHARACTERS = 140;
/** REL-1113: every infrastructure-incomplete title starts with this. */
const INCOMPLETE_INFRASTRUCTURE_TITLE_PREFIX = 'Review Yeti: INCOMPLETE — infrastructure (';
/** REL-1113: the longest lane detail an infrastructure-incomplete title may carry. */
const MAX_INCOMPLETE_INFRASTRUCTURE_DETAIL_CHARACTERS = 120;

/**
 * REL-1113: the ONE owner of the infrastructure-incomplete title format. The renderer
 * (`renderIncompleteInfrastructureTitle`) supplies only the lane detail; this function frames it,
 * and `isRecoverableFailureTitle` (`reviewCheckIdentity.ts`) recognizes exactly what it produces.
 */
function formatIncompleteInfrastructureTitle(detail, retry) {
  const suffix = retry ? `; retrying as attempt ${retry.nextAttempt} of ${retry.maxAttempts}` : '';
  const room = Math.min(MAX_INCOMPLETE_INFRASTRUCTURE_DETAIL_CHARACTERS,
    MAX_CHECK_RUN_TITLE_CHARACTERS - INCOMPLETE_INFRASTRUCTURE_TITLE_PREFIX.length - 1 - suffix.length);
  const bounded = detail.length > room ? `${detail.slice(0, Math.max(1, room - 1))}…` : detail;
  return `${INCOMPLETE_INFRASTRUCTURE_TITLE_PREFIX}${bounded})${suffix}`;
}

function laneReason(lane) {
  return lane.providerStatus !== undefined ? String(lane.providerStatus) : lane.failureClass;
}

/**
 * REL-1113: the title for an infrastructure-incomplete run. Always "INCOMPLETE", never a verdict
 * word, e.g. `Review Yeti: INCOMPLETE — infrastructure (lane arch-lane failed: 502)`.
 */
function renderIncompleteInfrastructureTitle(lanes, retry) {
  const shown = lanes.slice(0, 3);
  const detail = shown.length === 0
    ? 'lane failed'
    : shown.length === 1
      ? `lane ${shown[0].id} failed: ${laneReason(shown[0])}`
      : `lanes ${shown.map((lane) => `${lane.id} ${laneReason(lane)}`).join(', ')}${lanes.length > shown.length ? ', …' : ''} failed`;
  return formatIncompleteInfrastructureTitle(detail, retry);
}

/** REL-940: RETRIES allotted to a lane for a provider TRANSPORT failure. See `panelEngine.ts`
 * for the history; the schedule itself is owned here so the Action pipeline uses the same one. */
const TRANSPORT_MAX_RETRIES = 5;
/** Base of the full-jitter transport backoff: the ceiling for retry n is
 * `min(TRANSPORT_RETRY_MAX_DELAY_MS, BASE * FACTOR^(n-1))` = 5s, 10s, 20s, 40s, 60s. */
const TRANSPORT_RETRY_BASE_DELAY_MS = 5_000;
/** Growth factor per transport retry. */
const TRANSPORT_RETRY_FACTOR = 2;
/** Ceiling for any single transport backoff, so the schedule stays bounded. */
const TRANSPORT_RETRY_MAX_DELAY_MS = 60_000;
/** REL-1113: total wall-clock window a lane may spend riding out one transport outage. */
const TRANSPORT_RETRY_WINDOW_MS = 180_000;
/** REL-1113: never start a transport retry that would end inside this margin of the run's
 * terminal deadline: the run still has to record and publish the outcome after the lane gives up. */
const TRANSPORT_RETRY_TERMINAL_MARGIN_MS = 60_000;

/**
 * Full-jitter exponential backoff for transport retries: exponential because the failure is an
 * upstream outage that needs wall-clock time to clear; full jitter because every lane runs
 * concurrently against the same gateway and must not retry in one synchronised burst.
 */
function transportRetryDelayMs(attempt, random = Math.random) {
  const ceiling = Math.min(
    TRANSPORT_RETRY_BASE_DELAY_MS * Math.pow(TRANSPORT_RETRY_FACTOR, Math.max(0, attempt - 1)),
    TRANSPORT_RETRY_MAX_DELAY_MS,
  );
  const unit = Math.min(Math.max(random(), 0), 1);
  return Math.floor(unit * ceiling);
}

/** Gateway/proxy statuses that describe the path to the model, not an answer from it. */
const TRANSIENT_GATEWAY_STATUSES = Object.freeze(new Set([429, 502, 503, 504]));
const TRANSIENT_GATEWAY_MESSAGE = /\bHTTP (?:429|502|503|504)\b|\bBad Gateway\b|\bService Unavailable\b|\bGateway Time-?out\b/iu;
const NON_RETRYABLE_CLIENT_STATUS_MESSAGE = /\bHTTP 4(?!29)\d\d\b/u;

/** A gateway/proxy 429/502/503/504 named in a free-form error. */
function isTransientGatewayMessage(message) {
  return TRANSIENT_GATEWAY_MESSAGE.test(String(message ?? ''));
}

/** A 4xx other than 429 (auth, contract, payload size): the same request fails the same way,
 * so it is never retried -- by the panel's transport loop or by the Action's lane re-attempt. */
function isNonRetryableClientStatus(statusOrMessage) {
  if (typeof statusOrMessage === 'number') {
    return Number.isInteger(statusOrMessage) && statusOrMessage >= 400 && statusOrMessage <= 499 && statusOrMessage !== 429;
  }
  return NON_RETRYABLE_CLIENT_STATUS_MESSAGE.test(String(statusOrMessage ?? ''));
}

module.exports = {
  classifyWorkerFailureMessage,
  classifyProviderResponseStatus,
  classifyLaneFailure,
  INFRASTRUCTURE_LANE_FAILURE_CLASSES,
  INCOMPLETE_INFRASTRUCTURE_REASON,
  isInfrastructureIncompleteResult,
  laneProviderStatus,
  MAX_CHECK_RUN_TITLE_CHARACTERS,
  INCOMPLETE_INFRASTRUCTURE_TITLE_PREFIX,
  MAX_INCOMPLETE_INFRASTRUCTURE_DETAIL_CHARACTERS,
  formatIncompleteInfrastructureTitle,
  renderIncompleteInfrastructureTitle,
  TRANSPORT_MAX_RETRIES,
  TRANSPORT_RETRY_BASE_DELAY_MS,
  TRANSPORT_RETRY_FACTOR,
  TRANSPORT_RETRY_MAX_DELAY_MS,
  TRANSPORT_RETRY_WINDOW_MS,
  TRANSPORT_RETRY_TERMINAL_MARGIN_MS,
  transportRetryDelayMs,
  TRANSIENT_GATEWAY_STATUSES,
  isTransientGatewayMessage,
  isNonRetryableClientStatus,
};
