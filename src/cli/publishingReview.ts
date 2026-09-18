/**
 * DOKS publishing review lane (REL-586, ADR 0527).
 *
 * The DOKS worker had no production path: the operator forced every real dispatch
 * down the receipt-only branch, and the only two non-receipt profiles are manual
 * qualification lanes that *assert* `REVIEW_PUBLICATION_MODE === 'disabled'` and
 * hardcode `githubWrites: 0`. This module is the missing lane -- it reads the real
 * pull request at the admitted head, runs the persona panel through the Bifrost
 * gateway, and publishes a fail-closed App check.
 *
 * Two invariants this file exists to enforce:
 *
 * 1. **Bifrost only.** The legacy `runLiveReviewMain` defaults its base URL to
 *    `openrouter.ai` and its repository to a hardcoded fallback. Reaching it from a
 *    DOKS dispatch would review the wrong repository against the wrong provider.
 *    Here the gateway base URL and key are *required*; there is no default and no
 *    second transport.
 *
 * 2. **Fail closed.** Only a clean panel verdict produces `success`. Provider
 *    failure, panel failure, a non-shipping verdict, or any unexpected error all
 *    conclude `failure`. `completeCheck` cannot express `neutral`, which is
 *    deliberate: a `neutral` check does not block a merge, so an outage that
 *    published `neutral` would silently stop enforcing.
 */
import { createPanelDeadlineSignal, executePersonaPanel, raceWithPanelAbort, throwIfPanelAborted } from '../panel/panelEngine';
import { defaultZoektGrounding, removeScratchTree } from '../mcp/zoektGrounding';
import { isFastShipPanelResult } from '../panel/fastShipResult';
import { normalizeRepositoryVisibility, repositoryVisibilityFrom, type RepositoryVisibility } from '../review/repositoryVisibility';
import { resolveRepositoryVisibility } from '../github/repositoryVisibility';
import { Octokit } from '@octokit/core';
import {
  OpenRouterClient,
  OpenRouterConnectionError,
  OpenRouterResponseError,
  OpenRouterTimeoutError,
} from '../gateway/openRouterClient';
import type { ReviewModelClient } from '../gateway/openRouterClient';
import { UpstreamCapacityRejectionError } from '../gateway/providerCapacityManager';
import { resolveWorkerConfig } from '../config/publishingWorkerConfig';
import {
  openaiTransport,
  bifrostTransport,
  createOpenAIPublishingConfig,
  createBifrostPublishingConfig,
  type OpenAITransportConfig,
} from '../review/openaiTransport';
import { GitHubQualificationReadError, loadSameHeadReviewSource } from '../github/qualificationReader';
import { computeArbitration } from '../review/reviewCore';
import { isRecoverableIncompletePanel, isRecoverablePanelRetryEligible, RECOVERABLE_PANEL_AUTO_RETRY_CAP } from '../review/publicationFailurePolicy';
import {
  buildWorkerFailureDiagnostics, classifyWorkerFailureMessage, GITHUB_DIFF_NOT_RENDERABLE_EXPLANATION,
  validateWorkerCompletionEndpoint,
  type WorkerCompletionAdapter, type WorkerTerminalFailure, type WorkerTerminalSuccess,
} from '../review/workerCompletion';
import { logger } from '../utils/logger';
import { loadCompiledIndex, defaultDomainsDir, type CompiledDomainIndex } from '../pipeline/domainIndex';
import { parsePreparedReviewExecution } from '../review/preparedPublishingPolicy';
import { MAX_PERSONAS, parseWorkerReviewCompletion, type WorkerReviewResult } from '../review/workerReviewCompletion';
import type { WorkerReviewCompletionAdapter } from '../review/workerReviewCompletionHttp';
import type { PanelResult, LaneTokenUsage } from '../panel/types';

import { parseChangedFiles } from '../review/changedFiles';
export { parseChangedFiles, type ChangedFile } from '../review/changedFiles';
export { resolveWorkerConfig, getCompiledDomainIndex, getPersonaEcosystemPaths } from '../config/publishingWorkerConfig';

export const PUBLICATION_MODE_APP_GATE = 'app-gate';

/** Terminal states this lane can publish. `neutral` is intentionally absent. */
export type PublishingConclusion = 'success' | 'failure';

export interface PublishingReviewIdentity {
  runId: string;
  repositoryId: number;
  repo: string;
  owner: string;
  repoName: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  executionAttempt: number;
}

/** One canonical finding, as arbitration emits it. */
export interface ReviewFinding {
  severity?: string;
  path?: string;
  line?: number;
  title?: string;
  body?: string;
}

export interface CheckAnnotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: 'notice' | 'warning' | 'failure';
  message: string;
  title?: string;
}

export interface PublishingCheckClient {
  createCheck(owner: string, repo: string, headSha: string, externalId?: string): Promise<number>;
  completeCheck(options: {
    owner: string;
    repo: string;
    checkId: number;
    conclusion: 'success' | 'failure' | 'cancelled';
    title: string;
    summary: string;
    text?: string;
    annotations?: CheckAnnotation[];
  }): Promise<void>;
  publishGateCheck?(
    owner: string,
    repo: string,
    headSha: string,
    options: {
      conclusion: 'success' | 'failure';
      title: string;
      summary: string;
      text?: string;
    },
  ): Promise<number>;
}

export interface PublishingReviewPersonaMetrics {
  id: string;
  decision: string;
  findingsCount: number;
  blockingCount: number;
  turnsCount: number;
  toolCallsCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  durationMs: number;
  /** The concrete model the provider actually reported for this lane's call, which may differ
   * from the requested `transport.model` when that value is an alias. */
  model?: string;
}

/** Per-lane identity and bounded telemetry for a failed lane, safe to publish on a fail-closed
 * check: an identifier and a classification, plus numeric usage from the lane's last provider
 * response when one was received. Never the lane's free-form error text. */
export interface PublishingReviewFailedLane {
  id: string;
  failureClass: WorkerTerminalFailure['failureClass'];
  usage?: LaneTokenUsage;
  model?: string;
}

export type PublishingCoverageMode = 'panel' | 'fast_ship' | 'zero_lane';

export interface PublishingCoverageProjection {
  mode: PublishingCoverageMode;
  expectedLaneCount: number | null;
  completedLaneCount: number;
  failedLaneCount: number;
  rosterValid: boolean;
  quorumSatisfied: boolean;
  fullPanelComplete: boolean;
}

export interface PublishingReviewReceipt {
  version: 'ReviewYetiPublishingReview.v1';
  runId: string;
  repositoryId: number;
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  publicationMode: typeof PUBLICATION_MODE_APP_GATE;
  transport: 'bifrost';
  model: string;
  verdict: string;
  conclusion: PublishingConclusion;
  findingCount: number;
  blockingFindingCount: number;
  failureClass: string | null;
  startedAt: string;
  completedAt: string;
  coverage: PublishingCoverageProjection;
  personas?: PublishingReviewPersonaMetrics[];
  metrics?: {
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalTokens: number;
    totalTurns: number;
    totalToolCalls: number;
    totalDurationMs: number;
  };
}

function value(env: NodeJS.ProcessEnv, name: string): string {
  return String(env[name] || '').trim();
}

export function invalidPublishingReviewContract(): Error {
  return new Error('publishing review worker contract is invalid');
}

/**
 * True only for a real, admitted, publishing dispatch. Every qualification lane
 * and the receipt-only lane are excluded explicitly rather than by omission, so
 * adding a future lane cannot silently fall into publishing.
 */
export function isPublishingReviewWorker(env: NodeJS.ProcessEnv = process.env): boolean {
  return value(env, 'REVIEW_PUBLICATION_MODE') === PUBLICATION_MODE_APP_GATE
    && value(env, 'REVIEW_RECEIPT_ONLY') !== 'true'
    && value(env, 'REVIEW_FULL_PANEL_QUALIFICATION_ONLY') !== 'true'
    && value(env, 'REVIEW_SAME_HEAD_QUALIFICATION_ONLY') !== 'true'
    && value(env, 'REVIEW_PANEL_QUALIFICATION_ONLY') !== 'true'
    && value(env, 'REVIEW_PROVIDER_QUALIFICATION_ONLY') !== 'true';
}

const RUN_ID = /^run_[a-f0-9]{32}$/u;
const SHA = /^[a-f0-9]{40}$/u;
const REPO = /^[^/\s]+\/[^/\s]+$/u;

export function publishingReviewIdentity(
  env: NodeJS.ProcessEnv,
  options: { callbackEnabled?: boolean } = {},
): PublishingReviewIdentity {
  const runId = value(env, 'REVIEW_RUN_ID');
  const repo = value(env, 'REVIEW_REPO');
  const headSha = value(env, 'REVIEW_HEAD_SHA');
  const baseSha = value(env, 'REVIEW_BASE_SHA');
  const repositoryId = Number(value(env, 'REVIEW_REPOSITORY_ID'));
  const prNumber = Number(value(env, 'REVIEW_PR_NUMBER'));
  const rawExecutionAttempt = value(env, 'REVIEW_EXECUTION_ATTEMPT');
  const executionAttempt = rawExecutionAttempt ? Number(rawExecutionAttempt) : 1;
  const callbackEnabled = options.callbackEnabled ?? Boolean(value(env, 'REVIEW_COMPLETION_URL'));
  const invalidExecutionAttempt = !Number.isSafeInteger(executionAttempt) || executionAttempt <= 0;
  const missingExecutionAttempt = !rawExecutionAttempt;
  if (!RUN_ID.test(runId) || !REPO.test(repo) || !SHA.test(headSha) || !SHA.test(baseSha)
    || !Number.isSafeInteger(repositoryId) || repositoryId <= 0
    || !Number.isSafeInteger(prNumber) || prNumber <= 0
    || invalidExecutionAttempt || (callbackEnabled && missingExecutionAttempt)) {
    throw invalidPublishingReviewContract();
  }
  const [owner, repoName] = repo.split('/');
  return { runId, repositoryId, repo, owner, repoName, prNumber, headSha, baseSha, executionAttempt };
}

function validateConfiguredCompletionEndpoint(endpoint: string): void {
  try {
    validateWorkerCompletionEndpoint(endpoint);
  } catch {
    throw invalidPublishingReviewContract();
  }
}

/**
 * Bifrost is the only admitted transport. Both the base URL and the key are
 * required: defaulting either one is how a misconfigured worker silently reviews
 * against the wrong provider.
 */
export {
  openaiTransport,
  bifrostTransport,
  createOpenAIPublishingConfig,
  createBifrostPublishingConfig,
};
export type { OpenAITransportConfig };

const BLOCKING_SEVERITIES = new Set(['P0', 'P1']);

/**
 * Fail closed. `SHIP` with no blocking finding is the only success. Everything
 * else -- BLOCK, FIX_FIRST, an unrecognised verdict, or a SHIP that still carries
 * a P0/P1 -- concludes `failure`.
 */
export function publishingConclusion(verdict: string, blockingFindingCount: number): PublishingConclusion {
  if (blockingFindingCount > 0) return 'failure';
  return String(verdict).toUpperCase() === 'SHIP' ? 'success' : 'failure';
}

type RawPublicationLane = Parameters<typeof computeArbitration>[0][number];

interface RawPublicationRoster {
  mode: PublishingCoverageMode;
  lanes: RawPublicationLane[];
  expectedLaneCount: number | null;
  arbitrationExpectedCount: number;
  completedLaneCount: number;
  failedLaneCount: number;
  rosterValid: boolean;
}

function hasDuplicate(values: string[]): boolean {
  return new Set(values).size !== values.length;
}

function boundedLaneCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) return 0;
  return Math.min(value, MAX_PERSONAS);
}

function isRosterId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9_-]{0,127}$/u.test(value);
}

function validConfiguredRoster(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length <= MAX_PERSONAS
    && value.every(isRosterId)
    && !hasDuplicate(value);
}

/**
 * Convert the panel's existing selection result into raw-publication evidence.
 * The panel engine owns path matching and classifier narrowing; this publisher
 * only validates the returned roster and adds failed optional lanes to the
 * arbitration input. Fast-ship remains its explicit classifier-owned bypass.
 */
function rawPublicationRoster(panelResult: PanelResult, isFastShip: boolean): RawPublicationRoster {
  const completed = Array.isArray(panelResult.personas) ? panelResult.personas : [];
  const failures = Array.isArray(panelResult.optionalFailures) ? panelResult.optionalFailures : [];
  const failedLanes: RawPublicationLane[] = failures.map((failure) => ({
    id: failure.id,
    decision: 'ERROR',
    status: 'ERROR',
    error: failure.error,
    findings: [],
  }));
  const allLanes: RawPublicationLane[] = [...completed, ...failedLanes];
  // Keep the arbitration input bounded even if an injected result bypasses the
  // panel/completion contracts. The projection below reports the bounded count,
  // while the roster validity bit carries the fail-closed reason.
  const lanes = allLanes.slice(0, MAX_PERSONAS);
  const completedLaneCount = boundedLaneCount(completed.length);
  const failedLaneCount = boundedLaneCount(failures.length);

  if (isFastShip) {
    return {
      mode: 'fast_ship',
      lanes,
      expectedLaneCount: null,
      arbitrationExpectedCount: boundedLaneCount(completed.length),
      completedLaneCount: 0,
      failedLaneCount,
      rosterValid: allLanes.length <= MAX_PERSONAS,
    };
  }

  const configuredIds = panelResult.applicablePersonaIds;
  const configuredRosterValid = validConfiguredRoster(configuredIds);
  const expectedLaneCount = configuredRosterValid ? configuredIds.length : null;
  const arbitrationExpectedCount = configuredRosterValid ? configuredIds.length : 0;
  const returnedIds = allLanes.map((lane) => lane.id || '');
  const configuredSet = new Set(configuredRosterValid ? configuredIds : []);
  const returnedSet = new Set(returnedIds);
  const rosterValid = configuredRosterValid
    && allLanes.length <= MAX_PERSONAS
    && returnedIds.every((id) => isRosterId(id) && configuredSet.has(id))
    && !hasDuplicate(returnedIds)
    && configuredIds.every((id) => returnedSet.has(id));

  return {
    mode: panelResult.zeroLaneNonEvidence ? 'zero_lane' : 'panel',
    lanes,
    expectedLaneCount,
    arbitrationExpectedCount,
    completedLaneCount,
    failedLaneCount,
    rosterValid,
  };
}

function renderCoverageSummary(coverage: PublishingCoverageProjection): string {
  const expected = coverage.expectedLaneCount === null ? 'unknown' : String(coverage.expectedLaneCount);
  return `Coverage: mode=${coverage.mode}; expected lanes=${expected}; completed lanes=${coverage.completedLaneCount}; failed lanes=${coverage.failedLaneCount}; roster valid=${coverage.rosterValid}; quorum satisfied=${coverage.quorumSatisfied}; full panel complete=${coverage.fullPanelComplete}.`;
}

/**
 * `transport.model` is the exact `REVIEW_MODEL` string the deployment configured -- an alias in
 * some deployments, already-concrete in others. `resolvedModel` is what the provider actually
 * reported back on a real call (`response.model` from the gateway), which can differ from the
 * alias. Publish both whenever they differ instead of only the requested value, so a reader is
 * never left assuming the alias and the served model are the same thing.
 */
function renderTransportSummary(requestedModel: string, resolvedModel?: string): string {
  return resolvedModel && resolvedModel !== requestedModel
    ? `Transport: bifrost \`${requestedModel}\` (resolved \`${resolvedModel}\`).`
    : `Transport: bifrost \`${requestedModel}\`.`;
}

function renderTelemetrySummary(telemetry: {
  totalTurns: number; totalToolCalls: number; totalTokens: number; laneCount: number; totalDurationMs: number;
}): string {
  return `Telemetry: ${telemetry.totalTurns} turns, ${telemetry.totalToolCalls} tool calls, `
    + `${telemetry.totalTokens} tokens across ${telemetry.laneCount} lanes (${telemetry.totalDurationMs}ms).`;
}

/**
 * Identify which lane(s) failed and how, plus bounded numeric usage when a provider response was
 * received before the lane failed closed. Deliberately identifiers and counts only -- never the
 * lane's free-form error text, which may carry provider prompt/response content.
 */
function renderFailedLanesSummary(failedLanes: PublishingReviewFailedLane[]): string {
  const lines = failedLanes.map((lane) => {
    const usage = lane.usage
      ? ` usage=${lane.usage.promptTokens}+${lane.usage.completionTokens}=${lane.usage.totalTokens} tokens`
      : ' usage=unavailable (no provider response was received before this lane failed closed)';
    const model = lane.model ? ` model=\`${lane.model}\`` : '';
    return `- \`${lane.id}\`: failure class \`${lane.failureClass}\`;${usage};${model}`;
  });
  return ['Failed lane(s):', ...lines].join('\n');
}

// GitHub returns 406 Not Acceptable when a pull request's diff cannot be
// rendered in the requested representation (most commonly because it is too
// large -- roughly over 20,000 lines or 300 files). That is a permanent
// property of the pull request head, i.e. an invalid review input, not an
// infrastructure failure. The status comes from the structured `httpStatus`
// field, never from parsing the message. This is the single predicate both
// the failure class and the diagnostics flag derive from, so they cannot drift.
export function isGithubDiffNotRenderableError(error: unknown): boolean {
  return error instanceof GitHubQualificationReadError && error.httpStatus === 406;
}

/**
 * Publisher-layer classification. The typed OpenRouter/Upstream-capacity `instanceof` checks and
 * the `contract`-class branches below are specific to this layer (a persona attempt inside the
 * panel never throws a `GitHubQualificationReadError` or a "worker contract is invalid" config
 * error), so they stay local. Everything else -- the message/status-pattern remainder -- delegates
 * to `classifyWorkerFailureMessage` in `../review/workerCompletion`, the single shared
 * implementation `classifyPersonaAttemptFailure` (`../panel/panelEngine`) also delegates to, so
 * that regex ladder exists in exactly one place instead of two that can drift (REL-892 finding).
 *
 * The typed `OpenRouterTimeoutError`/`UpstreamCapacityRejectionError`/`OpenRouterConnectionError`/
 * `OpenRouterResponseError` branches below duplicate `classifyPersonaAttemptFailure`'s
 * (`../panel/panelEngine`) verbatim. That duplication is intentional and has been raised and
 * re-affirmed across two review rounds (REL-892 finding 4) -- see the matching note on
 * `classifyPersonaAttemptFailure` for the full reasoning: `instanceof`/status checks against a
 * concrete gateway error class cannot drift the way a regex ladder can, and consolidating this
 * typed mapping into `../review/workerCompletion` would force that boundary module to import
 * gateway error classes it documents itself as deliberately free of. Do not move this typed ladder
 * into `workerCompletion.ts`.
 */
export function classifyFailure(error: unknown): WorkerTerminalFailure['failureClass'] {
  if (error instanceof OpenRouterTimeoutError) return 'timeout';
  if (error instanceof UpstreamCapacityRejectionError) return 'rate_limit';
  if (error instanceof OpenRouterConnectionError) return 'transport';
  if (error instanceof OpenRouterResponseError) {
    if (error.status === 401 || error.status === 403) return 'auth';
    if (error.status === 429) return 'rate_limit';
    return 'provider_error';
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/contract is invalid/iu.test(message)) return 'contract';
  // A non-renderable diff is a contract violation, not the internal_error catch-all.
  if (isGithubDiffNotRenderableError(error)) return 'contract';
  return classifyWorkerFailureMessage(error);
}

/**
 * Renders the fail-closed check summary. The delivered body must name the
 * failure point (which budget/stage/lane died and how far it got), not just a
 * class token, so an operator knows whether to retry, wait, or fix inputs.
 */
export function renderFailureSummary(
  failureClass: WorkerTerminalFailure['failureClass'],
  headSha: string,
  diagnostics?: { reason?: string; providerStatus?: number; logTail?: string },
  /**
   * Present only once the bounded automatic retry (REL-620) has exhausted its
   * cap for a recoverable-incomplete-panel failure. `attempts` is this exact
   * execution's attempt number, so the operator reads a real count, not a
   * repeated constant.
   */
  recoverablePanelExhaustion?: { attempts: number; cap: number },
): string {
  const guidance: Record<WorkerTerminalFailure['failureClass'], string> = {
    budget_exhausted:
      'a review budget was exhausted before a verdict (persona investigation turns or lane call budget). '
      + 'Retry the review; if it recurs, the lane budget or turn ceiling needs raising for this repository.',
    timeout: 'a transport or persona call exceeded its deadline. Retry the review.',
    auth: 'the review gateway rejected the credential. Fix the key/secret binding, then re-run.',
    rate_limit: 'the upstream provider rate-limited the review. Retry after the provider cools down.',
    transport: 'the review worker could not reach the gateway. Check network/gateway health, then retry.',
    provider_error: 'the upstream provider returned an error. Retry; if it persists, check provider status.',
    malformed_output: 'a persona returned output that violated the review contract. Retry the review.',
    contract: 'the review contract/configuration was invalid. Fix the repository review policy, then re-run.',
    internal_error: 'the review worker hit an internal error. Retry; if it persists, inspect worker logs.',
  };
  const detail: string[] = [];
  if (diagnostics?.reason) detail.push(`reason=\`${diagnostics.reason}\``);
  if (diagnostics?.providerStatus !== undefined) detail.push(`provider_status=${diagnostics.providerStatus}`);
  const tail = (diagnostics?.logTail || '').trim();
  // GitHub HTTP 406 on the diff read is a permanent, too-large-to-render
  // property of this pull request head, not an outage -- say so explicitly so
  // an operator does not read the generic contract guidance as infrastructure
  // flakiness and retry a review that can never succeed as-is.
  const isGithubDiffNotRenderable = failureClass === 'contract' && diagnostics?.reason === 'github_diff_not_renderable';
  const whatFailed = isGithubDiffNotRenderable
    ? `${GITHUB_DIFF_NOT_RENDERABLE_EXPLANATION} Retrying will not help -- split the pull request into smaller `
      + 'changes to get it reviewed.'
    : guidance[failureClass];
  const lines = [
    `Review Yeti could not complete a binding review at \`${headSha}\` (failure class \`${failureClass}\`).`,
    '',
    `**What failed:** ${whatFailed}`,
    '',
    'This is a failed review, not an approval. The unchanged head is not merge-eligible until a review completes.',
  ];
  if (detail.length > 0) lines.push('', `Failure detail: ${detail.join(' ')}`);
  if (tail) lines.push('', `Diagnostic: \`${tail.slice(0, 500)}\``);
  if (recoverablePanelExhaustion) {
    lines.push('', `This optional review lane failed ${recoverablePanelExhaustion.attempts} time(s) `
      + `(automatic retry cap of ${recoverablePanelExhaustion.cap} additional attempt(s) reached); `
      + 'no further automatic retry will occur.');
  }
  return lines.join('\n');
}

export interface PublishingReviewDeps {
  checkClient: PublishingCheckClient;
  /** Reports a terminal worker failure with bounded, redacted diagnostics. */
  completion?: WorkerCompletionAdapter;
  reviewCompletion?: WorkerReviewCompletionAdapter;
  sourceLoader?: typeof loadSameHeadReviewSource;
  /** Resolves the repository's visibility with the run's own read token. Injectable for tests. */
  visibilityLookup?: (input: { owner: string; repo: string; token: string }) => Promise<RepositoryVisibility>;
  panelRunner?: typeof executePersonaPanel;
  client?: ReviewModelClient;
  now?: () => number;
  /** Worker/runtime shutdown signal; linked to the panel's configured deadline. */
  signal?: AbortSignal;
  /**
   * REL-677 / ADR 0329: index-at-review-time zoekt grounding. Injectable for tests; the default
   * implementation materializes a read-only tarball of the head SHA and builds a throwaway index.
   */
  zoektGrounding?: (input: {
    repository: string;
    headSha: string;
    token: string | undefined;
    enabled: boolean;
    signal?: AbortSignal;
    zoektIndexBinaryPath?: string;
  }) => Promise<{ indexDir?: string; scratchDir?: string; reason?: string }>;
}

/**
 * Renders the canonical findings into the check's `text` body. Ordered by
 * severity so the blocking ones are read first, and every entry carries its
 * file and line so a reader can navigate without the annotation view.
 */
export function renderFindingsMarkdown(findings: ReviewFinding[], blockingCount: number): string {
  if (findings.length === 0) {
    return 'No findings survived canonical arbitration for this head.';
  }
  const order = (severity: string): number => (severity === 'P0' ? 0 : severity === 'P1' ? 1 : 2);
  const lines = [...findings]
    .sort((a, b) => order(String(a?.severity || 'P2').toUpperCase()) - order(String(b?.severity || 'P2').toUpperCase()))
    .map((finding) => {
      const severity = String(finding?.severity || 'P2').toUpperCase();
      const where = finding?.path ? `\`${String(finding.path)}${finding?.line ? `:${finding.line}` : ''}\`` : '_no file_';
      const title = String(finding?.title || 'finding');
      const body = String(finding?.body || '').trim();
      const reporters = Number((finding as { reporters?: number })?.reporters || 1);
      const adjusted = (finding as { severityAdjusted?: { from: string; reason: string } })?.severityAdjusted;
      const unverified = finding as { downgradedFrom?: string; downgrade_reason?: string };
      // A severity-downgrade marker renders immediately after the bold severity token itself
      // (`**P2** (was P1 — unverified premise)`), not folded into the trailing `_(...)_` marks --
      // it changes what the severity IS, not an incidental annotation about the finding.
      //
      // Keyed on the presence of `downgradedFrom`, not on the reason's literal value:
      // the domain owns that vocabulary, and matching a copy of it here would go
      // quietly stale if it were renamed or a second reason were added -- the marker
      // would just stop rendering, with nothing red. The reason is rendered from the
      // finding itself for the same reason.
      const downgradeMarker = unverified.downgradedFrom
        ? ` (was ${unverified.downgradedFrom} — ${String(unverified.downgrade_reason || 'downgraded').replace(/_/gu, ' ')})`
        : '';
      const marks = [
        reporters > 1 ? `reported by ${reporters} lanes` : '',
        adjusted ? `filed ${adjusted.from}, re-filed ${severity}: ${adjusted.reason}` : '',
      ].filter(Boolean);
      return `- **${severity}**${downgradeMarker} ${where} — ${title}${marks.length ? ` _(${marks.join('; ')})_` : ''}${body ? `\n  ${body.replace(/\n/gu, '\n  ')}` : ''}`;
    });
  return [
    `${findings.length} finding(s), ${blockingCount} blocking (P0/P1).`,
    '',
    ...lines,
  ].join('\n');
}

async function lookupRepositoryVisibility(input: { owner: string; repo: string; token: string }): Promise<RepositoryVisibility> {
  const octokit = new Octokit({ auth: input.token });
  const { data } = await octokit.request('GET /repos/{owner}/{repo}', { owner: input.owner, repo: input.repo });
  return repositoryVisibilityFrom(data);
}

/** REL-677: the three-conjunct zoekt grounding gate, extracted so every kill path is unit-testable. */
export function zoektGroundingEnabledFor(
  env: NodeJS.ProcessEnv,
  config: unknown,
): boolean {
  return value(env, 'ZOEKT_GROUNDING_ENABLED') === 'true'
    && value(env, 'ZOEKT_GROUNDING_DISABLED') !== 'true'
    && (config as { pre_checks?: { zoekt?: { enabled?: boolean } } })?.pre_checks?.zoekt?.enabled !== false;
}

export async function runPublishingReviewWorker(
  env: NodeJS.ProcessEnv,
  deps: PublishingReviewDeps,
): Promise<PublishingReviewReceipt> {
  throwIfPanelAborted(deps.signal);
  if (!isPublishingReviewWorker(env)) throw invalidPublishingReviewContract();
  const authoritative = value(env, 'REVIEW_AUTHORITATIVE_GATE') === 'true';
  if ((value(env, 'REVIEW_AUTHORITATIVE_GATE') && !authoritative)
    || (value(env, 'REVIEW_PREPARED_CONFIG_JSON') && !authoritative)
    || (deps.reviewCompletion && !authoritative)) throw invalidPublishingReviewContract();
  const completionEndpoint = value(env, 'REVIEW_COMPLETION_URL');
  if (completionEndpoint) validateConfiguredCompletionEndpoint(completionEndpoint);
  if (authoritative && (!completionEndpoint || !deps.reviewCompletion || deps.completion
    || value(env, 'REVIEW_CHECK_ID'))) throw invalidPublishingReviewContract();
  if (completionEndpoint && !deps.completion && !deps.reviewCompletion) throw invalidPublishingReviewContract();
  const identity = publishingReviewIdentity(env, {
    callbackEnabled: Boolean(completionEndpoint) || Boolean(deps.completion) || Boolean(deps.reviewCompletion),
  });
  const now = deps.now || Date.now;
  const startedAt = new Date(now()).toISOString();
  const sourceLoader = deps.sourceLoader || loadSameHeadReviewSource;
  const panelRunner = deps.panelRunner || executePersonaPanel;
  let preparedPersonaIds: string[] = [];
  let authoritativeCompletionAttempted = false;
  let legacySuccessCompletionAttempted = false;
  const reportReviewResult = async (result: WorkerReviewResult): Promise<void> => {
    if (!authoritative || !deps.reviewCompletion) return;
    const event = parseWorkerReviewCompletion({ version: 'WorkerReviewCompletion.v1',
      runId: identity.runId, repositoryId: identity.repositoryId, owner: identity.owner, repo: identity.repoName,
      prNumber: identity.prNumber, headSha: identity.headSha, baseSha: identity.baseSha,
      policyDigest: value(env, 'REVIEW_POLICY_DIGEST'), configDigest: value(env, 'REVIEW_CONFIG_DIGEST'),
      executionAttempt: identity.executionAttempt, result });
    // Once a terminal body may have reached the service, never replace it with
    // a different failure body merely because its acknowledgement was lost.
    authoritativeCompletionAttempted = true;
    await deps.reviewCompletion.reportReviewResult(event);
  };

  const reportTerminalFailure = async (
    error: unknown,
    failedCheckId?: number,
    panelFailure?: {
      failureClass: WorkerTerminalFailure['failureClass'];
      coverage: PublishingCoverageProjection;
      /** Structured, bounded evidence available only when a panel actually ran (as opposed to an
       * earlier setup failure, e.g. an invalid provider contract, where none of this exists yet).
       * Additive to the existing fail-closed contract: every field here is safe to publish
       * alongside the redacted `renderFailureSummary` because it carries no free-form provider
       * text -- only the requested/resolved model, aggregate counters, and per-lane identity. */
      panelEvidence?: {
        requestedModel: string;
        resolvedModel?: string;
        telemetry: { totalTurns: number; totalToolCalls: number; totalTokens: number; laneCount: number; totalDurationMs: number };
        failedLanes: PublishingReviewFailedLane[];
      };
    },
  ): Promise<void> => {
    // A success callback may have committed even when its acknowledgement was
    // lost. Never replace that immutable body or its already-green check with a
    // contradictory terminal failure.
    if (legacySuccessCompletionAttempted) return;
    const failureClass = panelFailure?.failureClass ?? classifyFailure(error);
    const githubDiffNotRenderable = isGithubDiffNotRenderableError(error);
    // The recoverable marker is the one bit the dispatcher's bounded
    // automatic retry (REL-620) reads off this event; it is set exactly when
    // this call came from the `isRecoverableIncompletePanel` branch below,
    // never inferred from `failureClass` alone.
    const diagnostics = buildWorkerFailureDiagnostics(error, failureClass, {
      githubDiffNotRenderable,
      recoverableIncompletePanel: panelFailure !== undefined,
    });
    // The dispatcher retries attempts 1..CAP; the attempt that fails as
    // CAP+1 is the exhausted one this exact worker execution is running as
    // (`identity.executionAttempt`), so no cross-process coordination is
    // needed to know whether this is the final word.
    const recoverablePanelExhaustion = panelFailure !== undefined
      && !isRecoverablePanelRetryEligible(identity.executionAttempt)
      ? { attempts: identity.executionAttempt, cap: RECOVERABLE_PANEL_AUTO_RETRY_CAP }
      : undefined;
    if (authoritative && !authoritativeCompletionAttempted) {
      try {
        await reportReviewResult({ version: 'WorkerReviewResult.v1', completedAt: new Date(now()).toISOString(),
          personas: preparedPersonaIds.map((id) => ({ id, decision: 'ERROR', status: 'ERROR', errorClass: failureClass, findings: [] })),
          coverageComplete: false, quorumSatisfied: false, failureDiagnostics: diagnostics });
      } catch {
        logger.error('Authoritative worker failure could not be acknowledged', {
          runId: identity.runId, reason: 'completion_callback_failed', failureClass,
        });
      }
    }
    if (failedCheckId !== undefined) {
      try {
        await deps.checkClient.completeCheck({
          owner: identity.owner,
          repo: identity.repoName,
          checkId: failedCheckId,
          conclusion: 'failure',
          title: 'Review Yeti: review did not complete',
          summary: [
            renderFailureSummary(failureClass, identity.headSha, diagnostics, recoverablePanelExhaustion),
            ...(panelFailure ? [renderCoverageSummary(panelFailure.coverage)] : []),
            ...(panelFailure?.panelEvidence
              ? [
                  renderTransportSummary(panelFailure.panelEvidence.requestedModel, panelFailure.panelEvidence.resolvedModel),
                  renderTelemetrySummary(panelFailure.panelEvidence.telemetry),
                  ...(panelFailure.panelEvidence.failedLanes.length > 0
                    ? [renderFailedLanesSummary(panelFailure.panelEvidence.failedLanes)]
                    : []),
                ]
              : []),
          ].join('\n\n'),
        });
      } catch {
        logger.error('Failed to publish the fail-closed conclusion', {
          runId: identity.runId,
          failureClass,
          reason: 'check_publication_failed',
        });
      }
    }
    if (deps.completion) {
      const event: WorkerTerminalFailure = {
        version: 'WorkerTerminalFailure.v1',
        runId: identity.runId,
        repositoryId: identity.repositoryId,
        owner: identity.owner,
        repo: identity.repoName,
        prNumber: identity.prNumber,
        headSha: identity.headSha,
        baseSha: identity.baseSha,
        policyDigest: value(env, 'REVIEW_POLICY_DIGEST'),
        configDigest: value(env, 'REVIEW_CONFIG_DIGEST'),
        executionAttempt: identity.executionAttempt,
        ...(failedCheckId === undefined ? {} : { checkId: failedCheckId }),
        failureClass,
        diagnostics,
      };
      try {
        await deps.completion.reportTerminalFailure(event);
      } catch {
        // The original failure remains authoritative. The callback is a durable
        // recovery aid, never a reason to swallow or rewrite that failure.
        logger.error('Failed to persist worker terminal failure', {
          runId: identity.runId,
          failureClass,
          reason: 'completion_callback_failed',
        });
      }
    }
  };

  let checkId: number | undefined;
  try {
    // A check is useful evidence, but it is not a prerequisite for durable
    // failure recovery: createCheck itself can fail before a check id exists.
    checkId = value(env, 'REVIEW_CHECK_ID')
      ? Number(value(env, 'REVIEW_CHECK_ID'))
      : await deps.checkClient.createCheck(identity.owner, identity.repoName, identity.headSha,
        `${identity.runId}:a${identity.executionAttempt}`);
  } catch (error) {
    await reportTerminalFailure(error);
    throw error;
  }

  // The dispatching workflow may tell this lane the repository's visibility. In
  // production nothing does yet, and the first live run after the visibility
  // change published "Repository visibility: UNKNOWN" for a private repository
  // (ct-meta#2884). This lane already holds a repository-scoped read token for
  // the diff, so it can ask GitHub itself. A failed lookup settles to UNKNOWN
  // and never blocks the run; it is never allowed to become a guess.
  try {
    // Validate the provider contract after check creation so a validly identified
    // worker can still persist a durable terminal failure for a configuration
    // error. The check id remains optional only for createCheck failures.
    const transport = openaiTransport(env);
    const workerConfig = authoritative
      ? parsePreparedReviewExecution(value(env, 'REVIEW_PREPARED_CONFIG_JSON'), value(env, 'REVIEW_CONFIG_DIGEST'),
        { baseUrl: transport.baseUrl, model: transport.model }).config
      : resolveWorkerConfig(env, transport);
    if (authoritative) preparedPersonaIds = workerConfig.personas.filter((persona) => persona.enabled).map((persona) => persona.id);
    const repositoryVisibility = await resolveRepositoryVisibility(
      normalizeRepositoryVisibility(value(env, 'REVIEW_REPOSITORY_VISIBILITY')),
      {
        lookup: () => (deps.visibilityLookup || lookupRepositoryVisibility)({
          owner: identity.owner,
          repo: identity.repoName,
          token: value(env, 'GH_TOKEN'),
        }),
      },
    );
    // `repo` is the full `owner/repo`: the loader parses the slash itself and has
    // no `owner` field. Passing the bare name made every app-gate run die on
    // "GitHub qualification repository is invalid". The `as Parameters<...>` cast
    // that used to sit here is deliberately gone -- it silenced both the unknown
    // `owner` property and the shape mismatch, which is the only reason this
    // shipped.
    const source = await sourceLoader({
      repo: identity.repo,
      prNumber: identity.prNumber,
      expectedBaseSha: identity.baseSha,
      expectedHeadSha: identity.headSha,
      token: value(env, 'GH_TOKEN'),
    });

    const { files: changedFiles, unreadable } = parseChangedFiles(String(source.diff));
    // An empty changed-file set must not be read as "nothing to review, ship".
    if (changedFiles.length === 0) throw new Error('admitted head produced no reviewable diff');

    const client = deps.client || new OpenRouterClient({ baseUrl: transport.baseUrl, apiKey: transport.apiKey });
    // REL-677 / ADR 0329: index-at-review-time zoekt grounding. Strictly fail-soft: any
    // failure leaves the panel byte-identical to a run without zoekt. The scratch tree is
    // removed in the finally below; the index never outlives this review run. Grounding
    // runs BEFORE the panel deadline starts — its own stage budgets bound the tarball
    // fetch and index build, so grounding never eats the panel's timeout.
    const zoektGrounding = deps.zoektGrounding || defaultZoektGrounding;
    const zoektGroundingEnabled = zoektGroundingEnabledFor(env, workerConfig);
    const panelDeadline = createPanelDeadlineSignal(workerConfig.reviewers.overall_timeout_s, deps.signal);
    let zoektScratchRoot: { indexDir?: string; scratchDir?: string; reason?: string } = {};
    try {
      // A throwing grounding dep still fails soft: grounding is evidence
      // enrichment, never a precondition of the review.
      try {
        zoektScratchRoot = await zoektGrounding({
          repository: identity.repo,
          headSha: identity.headSha,
          token: value(env, 'GH_TOKEN'),
          enabled: zoektGroundingEnabled,
          signal: deps.signal,
          zoektIndexBinaryPath: value(env, 'ZOEKT_INDEX_BIN') || undefined,
        });
      } catch (groundingError: any) {
        zoektScratchRoot = { reason: groundingError?.message || 'zoekt_grounding_error' };
      }
      // Single-surface injection: the panel (panelEngine) owns the zoekt
      // lookup policy and propagates evidence.zoekt.indexDir to every internal
      // consumer (symbol pre-check + on-demand code_search_zoekt tool). The
      // worker never needs to know that policy.
      const zoektIndexDir = zoektGroundingEnabled ? zoektScratchRoot.indexDir : undefined;
      const zoektBinaryOverride = value(env, 'ZOEKT_BIN') ? { zoektBinaryPath: value(env, 'ZOEKT_BIN') } : {};
      const groundedConfig = zoektIndexDir
        ? {
            ...workerConfig,
            evidence: {
              ...(workerConfig as { evidence?: Record<string, unknown> }).evidence,
              zoekt: {
                ...((workerConfig as { evidence?: { zoekt?: Record<string, unknown> } }).evidence?.zoekt ?? {}),
                indexDir: zoektIndexDir,
                ...zoektBinaryOverride,
              },
            },
          }
        : workerConfig;
      const panelResult = await raceWithPanelAbort(
        Promise.resolve().then(() => panelRunner({
          config: groundedConfig,
          changedFiles,
          repository: identity.repo,
          headSha: identity.headSha,
          baseSha: identity.baseSha,
          prNumber: identity.prNumber,
          repositoryVisibility,
          client,
          jobId: identity.runId,
          signal: panelDeadline.signal,
          // Keep the upstream production Bifrost native JSON contract while
          // enforcing the worker's overall cancellation boundary.
          requestPolicy: { responseFormat: { type: 'json_object' } },
        } as Parameters<typeof executePersonaPanel>[0])),
        panelDeadline.signal,
      );
      throwIfPanelAborted(panelDeadline.signal);

      const isFastShip = isFastShipPanelResult(panelResult);
      const rawRoster = rawPublicationRoster(panelResult, isFastShip);
      const rawFindings = (Array.isArray(panelResult.personas) ? panelResult.personas : [])
        .flatMap((persona: { findings?: unknown[] }) => persona.findings || []);
      const panelQuorumSatisfied = panelResult?.quorum?.satisfied === true;
      // The model arbiter is evidence, not the policy boundary. The canonical
      // review policy treats P2 findings as advisory; trusting a raw FIX_FIRST
      // from the model made the DOKS app gate reject a clean (P0/P1-free) review.
      // Recompute from the exact persona findings and quorum so this lane shares
      // the same fail-closed severity contract as the hosted review path.
      const canonical = computeArbitration(rawRoster.lanes, rawRoster.arbitrationExpectedCount, {
        changedFiles,
        coverageComplete: rawRoster.rosterValid && panelQuorumSatisfied && unreadable.length === 0,
        ...(unreadable.length > 0 ? { coverageGaps: ['unreadable diff header(s)'] } : {}),
      });
      const coverage: PublishingCoverageProjection = {
        mode: rawRoster.mode,
        expectedLaneCount: rawRoster.expectedLaneCount,
        completedLaneCount: rawRoster.completedLaneCount,
        failedLaneCount: rawRoster.failedLaneCount,
        rosterValid: rawRoster.rosterValid,
        quorumSatisfied: canonical.quorumSatisfied,
        fullPanelComplete: rawRoster.mode === 'panel' && canonical.quorumSatisfied,
      };
      const fastShipApproved = isFastShip && canonical.quorumSatisfied;
      const verdict = canonical.verdict;
      // Count blocking findings from the canonical set, not the raw persona
      // output. The two disagreed: the check reported a blocking count derived
      // from unsanitized findings next to a verdict derived from the sanitized
      // ones, so a run could read `SHIP` and `blocking P0/P1: 13` at once. The
      // canonical set is the one the verdict is computed from, so it is the only
      // set the conclusion may be computed from.
      const findings = (canonical.findings || []) as ReviewFinding[];
      const discardedFindingCount = Math.max(0, rawFindings.length - findings.length);
      const blocking = findings.filter(
        (finding) => BLOCKING_SEVERITIES.has(String(finding?.severity || 'P2').toUpperCase()),
      );
      // A file whose header could not be read was never sent to the panel, so no
      // finding can exist for it and the verdict describes less than the diff. That
      // is the "absent capability, green check" shape: fail closed and name the
      // headers, rather than publish a verdict over a partial review.
      const conclusion = unreadable.length > 0
        ? ('failure' as const)
        : publishingConclusion(verdict, blocking.length);
      // A valid roster with failed reviewer calls and no findings is not a
      // code verdict. Preserve failure, but use the existing exact-head
      // recovery protocol instead of publishing an unrepeatable BLOCK while
      // leaving the durable run queued. Never relabel findings, malformed
      // rosters, missing diff coverage, or authoritative service results.
      const firstFailedLane = panelResult.optionalFailures?.[0];
      const recoverablePanelFailure = firstFailedLane !== undefined && isRecoverableIncompletePanel({
        authoritative,
        unreadableDiffCount: unreadable.length,
        mode: rawRoster.mode,
        rosterValid: rawRoster.rosterValid,
        failedLaneCount: rawRoster.failedLaneCount,
        quorumSatisfied: canonical.quorumSatisfied,
        rawFindingCount: rawFindings.length,
        canonicalFindingCount: findings.length,
      })
        // `runPersona` assigns a coded `failureClass` at the exact point it observed the lane's
        // terminal error (REL-892 finding 2); prefer that over re-deriving one from the free-form
        // `error` string here. `classifyFailure` remains the fallback for a lane that failed
        // before this classification existed in the code path.
        ? (firstFailedLane.failureClass ?? classifyFailure(firstFailedLane.error))
        : undefined;

    const personaMetrics: PublishingReviewPersonaMetrics[] = (panelResult.personas || []).map((p: any) => {
      const pFindings = p.findings || [];
      const pBlocking = pFindings.filter((f: any) =>
        BLOCKING_SEVERITIES.has(String(f?.severity || 'P2').toUpperCase())
      );
      return {
        id: p.id,
        decision: p.decision || 'UNKNOWN',
        findingsCount: pFindings.length,
        blockingCount: pBlocking.length,
        turnsCount: p.turnsCount || 1,
        toolCallsCount: (p.toolCalls || []).length,
        promptTokens: p.promptTokens || p.usage?.prompt || 0,
        completionTokens: p.completionTokens || p.usage?.completion || 0,
        totalTokens: p.totalTokens || p.usage?.total || 0,
        durationMs: p.durationMs || 0,
        ...(p.model ? { model: p.model } : {}),
      };
    });

    const totalPromptTokens = personaMetrics.reduce((sum, p) => sum + p.promptTokens, 0);
    const totalCompletionTokens = personaMetrics.reduce((sum, p) => sum + p.completionTokens, 0);
    const totalTokens = personaMetrics.reduce((sum, p) => sum + p.totalTokens, 0);
    const totalTurns = personaMetrics.reduce((sum, p) => sum + p.turnsCount, 0);
    const totalToolCalls = personaMetrics.reduce((sum, p) => sum + p.toolCallsCount, 0);
    const totalDurationMs = personaMetrics.reduce((sum, p) => sum + p.durationMs, 0);
    // `transport.model` is the exact configured `REVIEW_MODEL` (alias or concrete, depending on
    // deployment). The resolved concrete model is whatever the provider actually reported on a
    // real call: prefer a completed lane's, and fall back to a failed lane's last-known model so a
    // fully-failed panel can still report it.
    const resolvedTransportModel = personaMetrics.find((p) => p.model)?.model
      ?? (panelResult.optionalFailures || []).find((failure) => failure.lastKnownModel)?.lastKnownModel;
    // Every failed lane, identified and classified -- never their free-form error text -- plus
    // bounded numeric usage from the lane's last provider response when one was received.
    // `failure.failureClass` is the panel's own coded reason (REL-892 finding 2); `classifyFailure`
    // is only a fallback for a lane that failed before that classification existed.
    const failedLanes: PublishingReviewFailedLane[] = (panelResult.optionalFailures || []).map((failure) => ({
      id: failure.id,
      failureClass: failure.failureClass ?? classifyFailure(failure.error),
      ...(failure.lastKnownUsage ? { usage: failure.lastKnownUsage } : {}),
      ...(failure.lastKnownModel ? { model: failure.lastKnownModel } : {}),
    }));

    // A count with nothing attached is not reviewable. Until now the check
    // published only a title and a summary, so a run could report four blocking
    // findings while the pull request carried no comment, no review and no
    // annotation -- nothing an author could act on. Both fields below need only
    // `checks: write`, so the findings become visible without widening the
    const changedPaths = new Set(changedFiles.map((file) => file.path));

    const title = fastShipApproved
      ? 'Review Yeti: SHIP (fast-ship)'
      : `Review Yeti: ${verdict}`;

    const safeClassifierRationale = fastShipApproved && panelResult.classifierRationale
      ? panelResult.classifierRationale.replace(/[`<>\r\n]/gu, ' ').trim().slice(0, 500)
      : 'Approved via fast-ship triage classifier.';

    const summaryParts = fastShipApproved
      ? [
          `### Review Yeti: SHIP (fast-ship)`,
          `- **Verdict**: \`SHIP\` at \`${identity.headSha}\` (fast-ship auto-approved without multi-persona panel).`,
          `- **Classifier Rationale**: \`${safeClassifierRationale}\``,
          `- **Token Savings**: Estimated ~${panelResult.tokensSaved.toLocaleString()} tokens saved by bypassing full panel evaluation.`,
          renderCoverageSummary(coverage),
          renderTransportSummary(transport.model, resolvedTransportModel),
          `Repository visibility: ${repositoryVisibility}.`,
        ]
      : [
          `Verdict \`${verdict}\` at \`${identity.headSha}\`.`,
          (panelResult as any).zeroLaneNonEvidence
            ? 'No persona paths matched changed files; zero-lane run is not review evidence.'
            : `Findings: ${findings.length} (blocking P0/P1: ${blocking.length}; ${rawFindings.length} raw persona finding(s) before clustering).`,
          ...(discardedFindingCount > 0
            ? [`${discardedFindingCount} raw finding(s) were discarded as unanchorable and are not counted above.`]
            : []),
          ...(unreadable.length > 0
            ? [`Reviewed ${changedFiles.length} file(s); ${unreadable.length} diff header(s) could not be read, so those files were NOT reviewed:\n${unreadable.map((header) => `- \`${header}\``).join('\n')}`]
            : []),
          renderCoverageSummary(coverage),
          renderTransportSummary(transport.model, resolvedTransportModel),
          `Repository visibility: ${repositoryVisibility}.`,
          renderTelemetrySummary({ totalTurns, totalToolCalls, totalTokens, laneCount: personaMetrics.length, totalDurationMs }),
        ];

    if (recoverablePanelFailure) {
      // Failed-lane error strings may contain provider payloads. Keep their
      // classification and bounded counts, not their free-form text. Everything else here --
      // transport/resolved model, aggregate telemetry, and per-lane identity/classification/usage
      // -- carries no provider payload and is safe to publish on the fail-closed check.
      await reportTerminalFailure(new Error('An optional reviewer did not complete.'), checkId, {
        failureClass: recoverablePanelFailure,
        coverage,
        panelEvidence: {
          requestedModel: transport.model,
          resolvedModel: resolvedTransportModel,
          telemetry: { totalTurns, totalToolCalls, totalTokens, laneCount: personaMetrics.length, totalDurationMs },
          failedLanes,
        },
      });
    } else await deps.checkClient.completeCheck({
      owner: identity.owner,
      repo: identity.repoName,
      checkId,
      conclusion,
      title,
      summary: summaryParts.join('\n\n'),
      text: renderFindingsMarkdown(findings, blocking.length),
      // Redundant today and deliberately kept: `sanitizeFinding` already drops
      // any finding whose path is not in `changedFiles`, so this filter removes
      // nothing. It stays because GitHub rejects an annotation whose path is not
      // in the diff and fails the whole PATCH -- which would take the verdict
      // with it -- so a future change to arbitration must not be able to turn a
      // stray path into a lost verdict. It is a guard, not a behaviour: do not
      // write a test that claims it moves a finding to the text body.
      annotations: findings
        .filter((finding) => changedPaths.has(String(finding?.path || '')))
        .slice(0, 50)
        .map((finding) => {
          const line = Number.isSafeInteger(Number(finding?.line)) && Number(finding?.line) > 0
            ? Number(finding.line)
            : 1;
          const severity = String(finding?.severity || 'P2').toUpperCase();
          return {
            path: String(finding.path),
            start_line: line,
            end_line: line,
            annotation_level: BLOCKING_SEVERITIES.has(severity) ? 'failure' as const : 'warning' as const,
            title: `${severity}: ${String(finding?.title || 'finding').slice(0, 120)}`,
            message: String(finding?.body || finding?.title || 'No detail provided.').slice(0, 4_000),
          };
        }),
    });

    const completedAt = new Date(now()).toISOString();
    // The persona lanes and findings behind the published check, in the shape
    // the service's completion contract accepts. Built once and reported on
    // both paths: the authoritative gate re-arbitrates from it; the legacy
    // terminal success carries it as evidence so the service can keep it.
    const buildReviewResult = () => {
      const findingKeys = new Set(['severity', 'path', 'line', 'startLine', 'title', 'body', 'suggestion',
        'replacementCode', 'confidence', 'recommendation', 'fixOptions', 'isArchitectural']);
      const personas = panelResult.personas.map((persona) => ({ id: persona.id,
        // A lane that completed without stating a decision is read from its
        // findings: evidence must not be dropped for a missing label.
        decision: persona.decision ?? (persona.findings.length > 0 ? 'FINDINGS' : 'APPROVE'),
        status: 'COMPLETE' as const,
        findings: persona.findings.map((finding) => Object.fromEntries(
          Object.entries(finding).filter(([key, value]) => findingKeys.has(key) && value !== undefined))),
      }));
      // Same coded-reason-first precedence as the published check's `failedLanes` above: this is
      // the authoritative service's own record of why each lane failed and must not independently
      // drift from it by re-deriving a class from prose here.
      const errors = (panelResult.optionalFailures || []).map((failure) => ({ id: failure.id,
        decision: 'ERROR' as const, status: 'ERROR' as const, findings: [],
        errorClass: failure.failureClass ?? classifyFailure(failure.error) }));
      return parseWorkerReviewCompletion({ version: 'WorkerReviewCompletion.v1',
        runId: identity.runId, repositoryId: identity.repositoryId, owner: identity.owner, repo: identity.repoName,
        prNumber: identity.prNumber, headSha: identity.headSha, baseSha: identity.baseSha,
        policyDigest: value(env, 'REVIEW_POLICY_DIGEST'), configDigest: value(env, 'REVIEW_CONFIG_DIGEST'),
        executionAttempt: identity.executionAttempt,
        result: { version: 'WorkerReviewResult.v1', completedAt, personas: [...personas, ...errors],
          coverageComplete: unreadable.length === 0, quorumSatisfied: panelResult.quorum?.satisfied === true },
      }).result;
    };
    if (authoritative) {
      await reportReviewResult(buildReviewResult());
    }
    if (!authoritative && !recoverablePanelFailure && deps.completion?.reportReviewEvidence) {
      // The findings behind the check just published, for either conclusion: a
      // failing check carries the P0/P1 findings that made it fail. Evidence is
      // never allowed to be the reason a published check goes unreported: a
      // result that fails the contract, or a callback that fails, is logged
      // and the lifecycle callbacks below proceed unchanged.
      try {
        await deps.completion.reportReviewEvidence({
          version: 'WorkerReviewEvidence.v1',
          runId: identity.runId, repositoryId: identity.repositoryId, owner: identity.owner, repo: identity.repoName,
          prNumber: identity.prNumber, headSha: identity.headSha, baseSha: identity.baseSha,
          policyDigest: value(env, 'REVIEW_POLICY_DIGEST'), configDigest: value(env, 'REVIEW_CONFIG_DIGEST'),
          executionAttempt: identity.executionAttempt,
          checkId, conclusion, result: buildReviewResult(),
        });
      } catch (error) {
        logger.warn('Review evidence was not reported', {
          runId: identity.runId, executionAttempt: identity.executionAttempt, conclusion,
          reason: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
        });
      }
    }
    if (!authoritative && conclusion === 'success' && deps.completion) {
      const event: WorkerTerminalSuccess = {
        version: 'WorkerTerminalSuccess.v1',
        runId: identity.runId,
        repositoryId: identity.repositoryId,
        owner: identity.owner,
        repo: identity.repoName,
        prNumber: identity.prNumber,
        headSha: identity.headSha,
        baseSha: identity.baseSha,
        policyDigest: value(env, 'REVIEW_POLICY_DIGEST'),
        configDigest: value(env, 'REVIEW_CONFIG_DIGEST'),
        executionAttempt: identity.executionAttempt,
        checkId,
      };
      // Set before awaiting: an HTTP timeout cannot prove the service failed to
      // commit, so the catch path must not emit a different terminal body.
      legacySuccessCompletionAttempted = true;
      await deps.completion.reportTerminalSuccess(event);
    }
    return {
      version: 'ReviewYetiPublishingReview.v1',
      runId: identity.runId,
      repositoryId: identity.repositoryId,
      repo: identity.repo,
      prNumber: identity.prNumber,
      headSha: identity.headSha,
      baseSha: identity.baseSha,
      publicationMode: PUBLICATION_MODE_APP_GATE,
      transport: 'bifrost',
      model: transport.model,
      verdict,
      conclusion,
      findingCount: findings.length,
      blockingFindingCount: blocking.length,
      failureClass: recoverablePanelFailure ?? null,
      startedAt,
      completedAt,
      coverage,
      personas: personaMetrics,
      metrics: {
        totalPromptTokens,
        totalCompletionTokens,
        totalTokens,
        totalTurns,
        totalToolCalls,
        totalDurationMs,
      },
    };
    } finally {
      panelDeadline.cleanup();
      // One shared deletion contract (async, fail-soft) — the worker must not
      // hand-roll its own rm for the scratch tree.
      await removeScratchTree(zoektScratchRoot.scratchDir);
    }
  } catch (error) {
    await reportTerminalFailure(error, checkId);
    throw error;
  }
}
