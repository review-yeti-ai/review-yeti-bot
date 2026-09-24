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
import { createPanelDeadlineSignal, executePersonaPanel, raceWithPanelAbort, throwIfPanelAborted, type RepoFileProvider } from '../panel/panelEngine';
import { githubRetryDeadlineFromEnv, type GitHubRetryOptions } from '../github/githubRetry';
import { executeComposedReview } from '../panel/composedEngine';
import { createRepoFileProvider } from '../panel/repoFileProvider';
import { GitHubInstallationClient } from '../github/installationClient';
import type { FetchImplementation } from '../github/commentPublisher';
import { defaultZoektGrounding, removeScratchTree } from '../mcp/zoektGrounding';
import { isFastShipPanelResult } from '../panel/fastShipResult';
import { isValidTaskId } from '../panel/reviewTask';
import { normalizeRepositoryVisibility, repositoryVisibilityFrom, type RepositoryVisibility } from '../review/repositoryVisibility';
import { resolveRepositoryVisibility } from '../github/repositoryVisibility';
import { runInSpan, getMetrics } from '../telemetry';
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
  createOpenAIPublishingConfig,
  type OpenAITransportConfig,
} from '../review/openaiTransport';
import {
  GitHubPullRequestIdentityMovedError, GitHubQualificationReadError, loadSameHeadReviewSource, readPullRequestIdentity,
} from '../github/qualificationReader';
import { isReviewSuperseded, ReviewSupersededError } from '../review/reviewSupersession';
import { computeArbitration, sanitizeFinding } from '../review/reviewCore';
import {
  INCOMPLETE_INFRASTRUCTURE_REASON,
  INFRASTRUCTURE_LANE_FAILURE_CLASSES,
  isInfrastructureIncompleteResult,
  isRecoverableIncompletePanel,
  isRecoverablePanelRetryEligible,
  laneProviderStatus,
  RECOVERABLE_PANEL_AUTO_RETRY_CAP,
  renderIncompleteInfrastructureSummary,
  renderIncompleteInfrastructureTitle,
  type IncompleteLaneDescription,
} from '../review/publicationFailurePolicy';
import { redactWorkerFailureLogTail } from '../utils/workerFailureLogRedaction';
import {
  buildWorkerFailureDiagnostics, classifyWorkerFailureMessage, GITHUB_DIFF_NOT_RENDERABLE_EXPLANATION,
  validateWorkerCompletionEndpoint, WorkerCompletionHttpError,
  type WorkerCompletionAdapter, type WorkerTerminalFailure, type WorkerTerminalSuccess,
} from '../review/workerCompletion';
import { logger } from '../utils/logger';
import { loadCompiledIndex, defaultDomainsDir, type CompiledDomainIndex } from '../pipeline/domainIndex';
import { parsePreparedReviewExecution } from '../review/preparedPublishingPolicy';
import {
  MAX_PERSONAS, buildPersonaTelemetryPayload, parseWorkerReviewCompletion,
  type WorkerReviewResult,
} from '../review/workerReviewCompletion';
import type { WorkerReviewCompletionAdapter } from '../review/workerReviewCompletionHttp';
import type { PanelResult, LaneTokenUsage, LaneAggregateUsage } from '../panel/types';

import { parseChangedFiles } from '../review/changedFiles';
import { loadDiffShrinkInput, renderDiffShrinkSummary } from '../review/diffShrink';
import {
  incrementalClaimFrom, planIncrementalReview, renderIncrementalSummary,
  type CommitComparisonReader, type IncrementalBaseSource,
} from '../review/incrementalReview';
import { createIncrementalCompareReader } from '../github/incrementalCompareReader';
import { loadReviewBudgetInput, renderReviewBudgetSummary, reviewBudgetEnabledFor } from '../review/reviewBudget';
import {
  buildVerdictCacheRecord, planVerdictCache, renderVerdictCacheSummary, verdictCacheEnabledFor, verdictCacheLaneKeys,
  type ComparisonContentReader, type VerdictCacheBaseSource,
} from '../review/verdictCache';
import { createVerdictCacheCompareReader } from '../github/verdictCacheCompareReader';
import { incrementalReviewEnabledFor } from '../review/incrementalReview';
import { diffShrinkEnabledFor } from '../review/diffShrink';
import { personaLaneViewIdentity } from '../panel/panelEngine';
import workerPackage from '../../package.json';
import { loadMapReduceInput, renderMapReduceSummary } from '../review/mapReduceReview';
import { matchOne } from '../pipeline/domainIndex';
import { renderWorkerLogLocator } from './workerLogLocator';
import { workerLargeDiffSourceOptions } from '../github/largeDiffSourceWiring';
import { startJevTriageShadow, type JevTriageShadowLimits } from '../review/jevTriageShadow';
import type { JevAsker } from '../gateway/jevClient';
export { parseChangedFiles, type ChangedFile } from '../review/changedFiles';
export { resolveWorkerConfig, getCompiledDomainIndex, getPersonaEcosystemPaths } from '../config/publishingWorkerConfig';

export const PUBLICATION_MODE_APP_GATE = 'app-gate';

/** Terminal states this lane can publish. */
export type PublishingConclusion = 'success' | 'failure' | 'neutral' | 'cancelled';

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
    conclusion: 'success' | 'failure' | 'cancelled' | 'neutral';
    title: string;
    summary: string;
    text?: string;
    annotations?: CheckAnnotation[];
  }): Promise<void>;
  updateCheck?(options: {
    owner: string;
    repo: string;
    checkId: number;
    status?: 'queued' | 'in_progress' | 'completed';
    title?: string;
    summary?: string;
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
  /** Turns in which the lane requested a read-only tool, a strict subset of `turnsCount`. */
  toolTurns?: number;
  /** Turns spent on a bounded structured-output correction, a strict subset of `turnsCount`. */
  correctionTurns?: number;
  toolCallsCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Sum of every real provider call this lane made (see `LaneAggregateUsage`), as opposed to the
   * fields above, which have always reflected only the lane's terminal turn. Optional so a panel
   * result that predates per-turn accumulation still degrades safely. */
  aggregateUsage?: LaneAggregateUsage;
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

export type PublishingCoverageMode = 'panel' | 'fast_ship' | 'documentation_only' | 'zero_lane' | 'not_applicable';

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
    /** SUM of every lane's individual duration -- overstates wall time under concurrent fan-out.
     * See `panelWallClockMs` for the figure that actually reflects how long the run took. */
    totalDurationMs: number;
    /** The panel's own wall-clock measurement. Optional so a panel result that predates this field
     * still produces a receipt. */
    panelWallClockMs?: number;
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
  createOpenAIPublishingConfig,
};
export type { OpenAITransportConfig };

const BLOCKING_SEVERITIES = new Set(['P0', 'P1']);

/**
 * Coverage the conclusion may independently verify. Structural: the caller
 * passes the same projection the check summary renders, so a SHIP verdict and
 * its own published coverage line can never disagree at the conclusion
 * boundary without the conclusion noticing.
 */
export interface PublishingConclusionCoverage {
  mode: string;
  rosterValid: boolean;
  quorumSatisfied: boolean;
  fullPanelComplete: boolean;
}

/**
 * Fail closed. `SHIP` with no blocking finding is the only success. Everything
 * else -- BLOCK, FIX_FIRST, an unrecognised verdict, or a SHIP that still carries
 * a P0/P1 -- concludes `failure`.
 *
 * The run's own coverage projection is a required argument: the worker's single
 * production call site must always pass it, so dropping the argument is a
 * compile error rather than a silent re-enable of the false-approval shape
 * this guard exists to close. When the caller supplies the run's own coverage projection, a SHIP must also
 * survive that projection: a `panel` (or composed, which projects as `panel`)
 * verdict over a roster the run itself reports as invalid or incomplete is
 * fail-closed `failure`, and a `fast_ship`/`documentation_only` verdict without
 * quorum is likewise not approvable. This is the last gate between a verdict
 * string and a green check: production once published a SHIP whose own coverage
 * line denied the quorum it was standing on. Modes without a panel-style quorum
 * contract (`not_applicable`, `zero_lane`) are deliberately unguarded here --
 * `not_applicable` concludes `neutral` before this function runs, and a
 * `zero_lane` SHIP cannot be constructed by arbitration (quorum requires a
 * positive expected lane count), so guarding them would only re-state existing
 * invariants while inviting drift.
 */
export function publishingConclusion(verdict: string, blockingFindingCount: number,
  coverage: PublishingConclusionCoverage): 'success' | 'failure' {
  if (blockingFindingCount > 0) return 'failure';
  if (String(verdict).toUpperCase() !== 'SHIP') return 'failure';
  if (coverage) {
    if (coverage.mode === 'panel'
      && !(coverage.rosterValid === true && coverage.quorumSatisfied === true
        && coverage.fullPanelComplete === true)) {
      return 'failure';
    }
    if ((coverage.mode === 'fast_ship' || coverage.mode === 'documentation_only')
      && coverage.quorumSatisfied !== true) {
      return 'failure';
    }
  }
  return 'success';
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
  missingConfiguredLaneCount: number;
  malformedReturnedLaneCount: number;
}

/**
 * Pure projection of the two independent roster limits enforced before arbitration.
 * Keeping this separate from verdict construction makes the configured-roster guard,
 * returned-lane guard, and bounded arbitration input independently observable without
 * allowing callers to replace the canonical arbiter.
 */
export interface PublishingRosterBoundsProjection {
  lanes: RawPublicationLane[];
  returnedIds: string[];
  configuredRosterValid: boolean;
  returnedLaneCountValid: boolean;
  completedLaneCount: number;
  failedLaneCount: number;
  /** Configured lanes that returned nothing at all (see
   * `IncompletePanelEvidence.missingConfiguredLaneCount`). Zero when the
   * configured roster itself is invalid. */
  missingConfiguredLaneCount: number;
  /** Returned lanes outside the configured roster, duplicates, or any lane
   * at all when the configured roster is invalid (see
   * `IncompletePanelEvidence.malformedReturnedLaneCount`). */
  malformedReturnedLaneCount: number;
}

function hasDuplicate(values: string[]): boolean {
  return new Set(values).size !== values.length;
}

function boundedLaneCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) return 0;
  return Math.min(value, MAX_PERSONAS);
}

// A roster id and a composed-review task id are the SAME format on purpose: that is what makes a
// validated task plan automatically a valid roster and a valid completion payload, with no
// contract change anywhere downstream. Delegating instead of re-declaring the regex means the two
// cannot drift apart silently.
function isRosterId(value: unknown): value is string {
  return isValidTaskId(value);
}

function validConfiguredRoster(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length <= MAX_PERSONAS
    && value.every(isRosterId)
    && !hasDuplicate(value);
}

export function projectPublishingRosterBounds(panelResult: PanelResult): PublishingRosterBoundsProjection {
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

  // Split an invalid roster into its two causal shapes so recovery policy can
  // distinguish a transient silent dropout (every returned lane is clean, some
  // configured lane just never answered) from a broken panel output (ids the
  // configured roster never asked for). Both counts walk the same configured
  // and returned sets the roster validity check walks, so they cannot drift
  // from it. `missingConfiguredLaneCount` is zero when the configured roster
  // itself is invalid because "which lanes are missing" is then unknowable,
  // and every returned lane counts as malformed in that case.
  const configuredSet = new Set(validConfiguredRoster(panelResult.applicablePersonaIds)
    ? (panelResult.applicablePersonaIds as string[]) : []);
  const returnedSet = new Set(allLanes.map((lane) => lane.id || ''));
  const missingConfiguredLaneCount = configuredSet.size > 0
    ? [...configuredSet].filter((id) => !returnedSet.has(id)).length
    : 0;
  const seenReturned = new Set<string>();
  let malformedReturnedLaneCount = 0;
  for (const lane of allLanes) {
    const id = lane.id || '';
    if (configuredSet.size === 0 || !isRosterId(id) || !configuredSet.has(id) || seenReturned.has(id)) {
      malformedReturnedLaneCount += 1;
    } else {
      seenReturned.add(id);
    }
  }

  return {
    lanes: allLanes.slice(0, MAX_PERSONAS),
    returnedIds: allLanes.map((lane) => lane.id || ''),
    configuredRosterValid: validConfiguredRoster(panelResult.applicablePersonaIds),
    returnedLaneCountValid: allLanes.length <= MAX_PERSONAS,
    completedLaneCount: boundedLaneCount(completed.length),
    failedLaneCount: boundedLaneCount(failures.length),
    missingConfiguredLaneCount,
    malformedReturnedLaneCount,
  };
}

/**
 * Convert the panel's existing selection result into raw-publication evidence.
 * The panel engine owns path matching and classifier narrowing; this publisher
 * only validates the returned roster and adds failed optional lanes to the
 * arbitration input. Fast-ship remains its explicit classifier-owned bypass.
 */
function rawPublicationRoster(
  panelResult: PanelResult,
  isFastShip: boolean,
  notApplicable = false,
): RawPublicationRoster {
  const {
    lanes,
    returnedIds,
    configuredRosterValid,
    returnedLaneCountValid,
    completedLaneCount,
    failedLaneCount,
    missingConfiguredLaneCount,
    malformedReturnedLaneCount,
  } = projectPublishingRosterBounds(panelResult);

  if (isFastShip) {
    return {
      mode: panelResult.documentationOnly ? 'documentation_only' : 'fast_ship',
      lanes,
      expectedLaneCount: null,
      arbitrationExpectedCount: completedLaneCount,
      completedLaneCount: 0,
      failedLaneCount,
      rosterValid: returnedLaneCountValid,
      missingConfiguredLaneCount,
      malformedReturnedLaneCount,
    };
  }

  const configuredIds = panelResult.applicablePersonaIds;
  const expectedLaneCount = configuredRosterValid ? configuredIds.length : null;
  const arbitrationExpectedCount = configuredRosterValid ? configuredIds.length : 0;
  const configuredSet = new Set(configuredRosterValid ? configuredIds : []);
  const returnedSet = new Set(returnedIds);
  const rosterValid = configuredRosterValid
    && returnedLaneCountValid
    && returnedIds.every((id) => isRosterId(id) && configuredSet.has(id))
    && !hasDuplicate(returnedIds)
    && configuredIds.every((id) => returnedSet.has(id));

  return {
    mode: notApplicable
      ? 'not_applicable'
      : panelResult.zeroLaneNonEvidence
        ? 'zero_lane'
        : 'panel',
    lanes,
    expectedLaneCount,
    arbitrationExpectedCount,
    completedLaneCount,
    failedLaneCount,
    rosterValid,
    missingConfiguredLaneCount,
    malformedReturnedLaneCount,
  };
}

function renderCoverageSummary(coverage: PublishingCoverageProjection): string {
  const expected = coverage.expectedLaneCount === null ? 'unknown' : String(coverage.expectedLaneCount);
  return `Coverage: mode=${coverage.mode}; expected lanes=${expected}; completed lanes=${coverage.completedLaneCount}; failed lanes=${coverage.failedLaneCount}; roster valid=${coverage.rosterValid}; quorum satisfied=${coverage.quorumSatisfied}; full panel complete=${coverage.fullPanelComplete}.`;
}

const MAX_LISTED_ROUTED_FILES = 20;

/**
 * REL-1088: files a lane reviewed only because the shared applicability
 * decision routed them there -- no persona's paths cover them. Always shown,
 * so an author can see which lane read the file and extend the roster.
 */
export function renderRoutedFiles(panelResult: Pick<PanelResult, 'routedFiles'>): string | null {
  const routed = panelResult.routedFiles;
  if (!Array.isArray(routed) || routed.length === 0) return null;
  const safe = (text: string) => text.replace(/[`<>\r\n]/gu, ' ').slice(0, 300);
  const lines = routed.slice(0, MAX_LISTED_ROUTED_FILES).map((file) => `- \`${safe(file.path)}\` -> `
    + `${file.laneIds.map((id) => `\`${safe(id)}\``).join(', ')}`
    + (file.reason === 'uncovered-source' ? ' (source no persona covers)' : ''));
  const overflow = routed.length - MAX_LISTED_ROUTED_FILES;
  return `Routed files (no persona's paths cover them; reviewed by the routed lane):\n${lines.join('\n')}`
    + (overflow > 0 ? `\n- +${overflow} more` : '');
}

const MAX_LISTED_DEPTH_FILES = 20;

/**
 * REL-1092 (plan section 3.5, nothing dropped silently): files the lanes saw
 * only in part -- a patch cut at the per-file limit -- or not at all -- a patch
 * that is binary or that GitHub omitted. Read from the shared decision the
 * engine attached to its result, sanitized and capped like `renderRoutedFiles`.
 */
export function renderReviewDepthDisclosure(
  panelResult: Pick<PanelResult, 'truncatedFiles' | 'unavailablePatches' | 'omittedSourcePaths'>,
): string[] {
  const safe = (text: string) => String(text).replace(/[`<>\r\n]/gu, ' ').slice(0, 300);
  const count = (value: unknown) => (Number.isSafeInteger(value) ? (value as number).toLocaleString('en-US') : '?');
  const capped = <T>(rows: readonly T[], line: (row: T) => string) => {
    const overflow = rows.length - MAX_LISTED_DEPTH_FILES;
    return rows.slice(0, MAX_LISTED_DEPTH_FILES).map(line).join('\n') + (overflow > 0 ? `\n- +${overflow} more` : '');
  };
  const parts: string[] = [];
  const truncated = Array.isArray(panelResult.truncatedFiles) ? panelResult.truncatedFiles : [];
  if (truncated.length > 0) {
    parts.push('Truncated patches (reviewed in part: lanes saw only the first part of the patch; the rest was not sent):\n'
      + capped(truncated, (file) => `- \`${safe(file.path)}\`: kept ${count(file.keptChars)} of ${count(file.originalChars)} characters`));
  }
  const unavailable = Array.isArray(panelResult.unavailablePatches) ? panelResult.unavailablePatches : [];
  if (unavailable.length > 0) {
    const omitted = new Set(Array.isArray(panelResult.omittedSourcePaths) ? panelResult.omittedSourcePaths : []);
    parts.push('Not reviewed: patch unavailable (binary/omitted):\n'
      + capped(unavailable, (file) => `- \`${safe(file.path)}\` (${file.kind === 'binary' ? 'binary' : 'omitted by GitHub'})`
        + (omitted.has(file.path) ? ' -- source, so coverage is incomplete' : '')));
  }
  return parts;
}

function renderUnreportedLanes(panelResult: PanelResult): string | null {
  const gaps = panelResult.unreportedLanes;
  if (!Array.isArray(gaps) || gaps.length === 0) return null;
  const lines = gaps.map((gap) => `- \`${gap.id}\` \`${gap.failureClass ?? 'unreported'}\`: ${gap.error}`);
  return `Unreported lanes (not on the published roster):\n${lines.join('\n')}`;
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
  /** The panel's own wall-clock measurement. Distinct from `totalDurationMs`, which SUMS every
   * lane's individual duration and overstates wall time under concurrent fan-out. Optional so a
   * panel result that predates this field still renders the base line unchanged. */
  panelWallClockMs?: number;
  /** REL-677: fixed setup cost of materializing the worktree and building the review's throwaway
   * Zoekt index, separate from the lane time above. Absent when grounding was not attempted
   * (disabled) so a run without zoekt renders byte-identical to before this field existed. */
  zoektIndexBuildMs?: number;
}): string {
  const zoektNote = telemetry.zoektIndexBuildMs !== undefined
    ? ` Zoekt index build: ${telemetry.zoektIndexBuildMs}ms.`
    : '';
  const base = `Telemetry: ${telemetry.totalTurns} turns, ${telemetry.totalToolCalls} tool calls, `
    + `${telemetry.totalTokens} tokens across ${telemetry.laneCount} lanes (${telemetry.totalDurationMs}ms).${zoektNote}`;
  return typeof telemetry.panelWallClockMs === 'number'
    ? `${base} Panel wall clock: ${telemetry.panelWallClockMs}ms (the figure above sums lane durations, not wall time).`
    : base;
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

/**
 * REL-1093: the head read after an abort runs inside the pod's termination
 * grace period (30s by default), so it must finish well within it.
 */
export const ABORTED_RUN_HEAD_READ_TIMEOUT_MS = 5_000;

/** Current head sha, or undefined when the read fails or exceeds `timeoutMs`. */
async function readCurrentHeadAfterAbort(
  read: () => Promise<{ headSha: string }>,
  timeoutMs: number,
): Promise<string | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      read().then((current) => current.headSha, () => undefined),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface PublishingReviewDeps {
  checkClient: PublishingCheckClient;
  /** Reports a terminal worker failure with bounded, redacted diagnostics. */
  completion?: WorkerCompletionAdapter;
  reviewCompletion?: WorkerReviewCompletionAdapter;
  sourceLoader?: typeof loadSameHeadReviewSource;
  /**
   * REL-1057: reads the pull request's current head when a legacy completion
   * callback is rejected with HTTP 409, to tell a superseded head from a real
   * conflict. Injectable for tests; defaults to one GitHub read with `GH_TOKEN`.
   */
  pullRequestIdentityReader?: typeof readPullRequestIdentity;
  /**
   * REL-1093: bound on the fresh head read made after the root signal aborted
   * (SIGTERM from a cancelled Job). Injectable for tests.
   */
  abortHeadReadTimeoutMs?: number;
  /** Resolves the repository's visibility with the run's own read token. Injectable for tests. */
  visibilityLookup?: (input: { owner: string; repo: string; token: string }) => Promise<RepositoryVisibility>;
  panelRunner?: typeof executePersonaPanel;
  /** Injectable for tests. Used only when `resolveReviewEngine(workerConfig)` selects `'composed'`. */
  composedReviewRunner?: typeof executeComposedReview;
  client?: ReviewModelClient;
  now?: () => number;
  /** Worker/runtime shutdown signal; linked to the panel's configured deadline. */
  signal?: AbortSignal;
  /** Current head check to detect in-flight supersession and abort early. */
  isCurrentHead?: () => boolean;
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
  /**
   * Full-repository grounding for a persona's `find_files`/`read_file` tools (see
   * `RepoFileProvider` in `../panel/panelEngine` and `createRepoFileProvider` in
   * `../panel/repoFileProvider`). Injectable for tests; the default constructs a
   * `GitHubInstallationClient` from this run's own repository-scoped `GH_TOKEN`
   * (`contents: read`, `pull_requests: read` -- minted by `getGitHubAppRepositoryReadToken`,
   * see `kubernetesRunSecretProvisioner.ts`), the same read token the diff loader and
   * visibility lookup above already use.
   *
   * `deps.checkClient`'s token is `checks: write` only (`getGitHubAppRepositoryPublishToken`)
   * and is asserted to carry no other permission; it cannot serve this and this factory must
   * never mint or require a broader credential than the `GH_TOKEN` already delivered to this
   * pod. Construction is fail-soft: a throwing factory or a missing `GH_TOKEN` leaves this
   * lane running exactly as it did before this dep existed -- diff-scoped tools only, logged
   * once, never a reason the review fails.
   */
  repoFileProviderFactory?: (input: { token: string; owner: string; repo: string; headSha: string }) => RepoFileProvider;
  /**
   * REL-1081: test seam for the shadow-only Jev triage (`../review/jevTriageShadow`). Production
   * leaves it unset; the triage then runs only when `REVIEW_YETI_JEV_SHADOW` and `TYPESAFE_*` are
   * set, and it never changes the review either way.
   */
  jevTriageShadow?: { asker?: JevAsker; limits?: Partial<JevTriageShadowLimits> };
  /**
   * REL-1084: the service's prior review record, for incremental re-review planning
   * (`REVIEW_YETI_INCREMENTAL`). Built by `publishingWorkerAdapters` only when the flag is on
   * for this repository; absent means a full review.
   */
  incrementalBase?: IncrementalBaseSource;
  /** REL-1084 test seam; production compares with this run's `GH_TOKEN`. */
  incrementalCompareReader?: CommitComparisonReader;
  /**
   * REL-1085: the service's verdict-cache source record (`REVIEW_YETI_VERDICT_CACHE`). Built by
   * `publishingWorkerAdapters` only when the flag is on for this repository; absent means nothing
   * is served from cache (entries are still recorded when this run's comparison is readable).
   */
  verdictCacheBase?: VerdictCacheBaseSource;
  /** REL-1085 test seam; production compares with this run's `GH_TOKEN`. */
  verdictCacheCompareReader?: ComparisonContentReader;
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

export type ReviewEngine = 'panel' | 'composed' | 'shadow';

/**
 * Selects between the fan-out persona panel (`panel`, the default), the single-context composed
 * engine (`composed`, `src/panel/composedEngine.ts`), and `shadow` -- run both, gate on the panel
 * (see the `isShadow` block in `runPublishingReviewWorker`: the composed run there is additive,
 * non-gating evidence and can never influence `rawPublicationRoster`/`computeArbitration` or the
 * published conclusion). Fail-inert: any value other than the exact strings `'composed'` or
 * `'shadow'` -- unset, a typo, anything else -- stays `'panel'`.
 *
 * Deliberately reads the resolved worker config's `review_engine` field, never a raw env var: the
 * worker config is projected from base policy (`resolveWorkerConfig` in
 * `../config/publishingWorkerConfig`, or the digest-verified `parsePreparedReviewExecution` on the
 * authoritative path), neither of which a pull request can influence. Reading an env var here
 * instead would let whatever triggered this run pick its own review engine -- e.g. escaping the
 * stricter composed engine an operator enabled for this repository, or opting into an engine that
 * was never enabled at all.
 */
export function resolveReviewEngine(config: { review_engine?: unknown }): ReviewEngine {
  if (config?.review_engine === 'composed') return 'composed';
  if (config?.review_engine === 'shadow') return 'shadow';
  return 'panel';
}

/** REL-1103: GitHub retry policy bounded by the worker's terminal deadline, when forwarded. */
export function githubRetryOptionsFromEnv(env: Readonly<Record<string, string | undefined>>): GitHubRetryOptions {
  const deadlineAtMs = githubRetryDeadlineFromEnv(env);
  return deadlineAtMs === undefined ? {} : { deadlineAtMs };
}

/**
 * REL-1103: the publishing worker's check client. Check create/update retry
 * transient GitHub responses, never past the worker's terminal deadline.
 */
export function createPublishingCheckClient(
  token: string,
  env: Readonly<Record<string, string | undefined>>,
  options: { fetchImplementation?: FetchImplementation; sleep?: (milliseconds: number) => Promise<void> } = {},
): GitHubInstallationClient {
  return new GitHubInstallationClient({ token, ...options, retry: githubRetryOptionsFromEnv(env) });
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
  // REL-1038: where this worker's full log lives once its Pod is collected.
  const workerLogLocator = renderWorkerLogLocator(env);
  const sourceLoader = deps.sourceLoader || loadSameHeadReviewSource;
  // `reviewEngine`/`panelRunner` are resolved below, once `workerConfig` exists -- see
  // `resolveReviewEngine`'s doc comment for why this must read the resolved base-policy config
  // rather than a raw env var this early.
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
        telemetry: { totalTurns: number; totalToolCalls: number; totalTokens: number; laneCount: number; totalDurationMs: number; panelWallClockMs?: number };
        failedLanes: PublishingReviewFailedLane[];
        /** REL-1113: present only when every failed lane failed on infrastructure; the check is
         * then titled INCOMPLETE and names these lanes. */
        incompleteLanes?: IncompleteLaneDescription[];
      };
    },
  ): Promise<void> => {
    // A success callback may have committed even when its acknowledgement was
    // lost. Never replace that immutable body or its already-green check with a
    // contradictory terminal failure.
    if (legacySuccessCompletionAttempted) return;
    const failureClass = panelFailure?.failureClass ?? classifyFailure(error);
    const githubDiffNotRenderable = isGithubDiffNotRenderableError(error);
    const isProvider5xx = Boolean(
      (error as any)?.failureReason === 'provider_5xx' ||
      (error instanceof Error && error.message.includes('provider_5xx'))
    );
    // The recoverable marker is the one bit the dispatcher's bounded
    // automatic retry (REL-620) reads off this event; it is set exactly when
    // this call came from the `isRecoverableIncompletePanel` branch below or
    // from a 502/503 provider outage, never inferred from `failureClass` alone.
    const diagnostics = buildWorkerFailureDiagnostics(error, failureClass, {
      githubDiffNotRenderable,
      recoverableIncompletePanel: panelFailure !== undefined || isProvider5xx,
      ...(isProvider5xx ? { reason: 'provider_5xx' } : {}),
    });
    // The dispatcher retries attempts 1..CAP; the attempt that fails as
    // CAP+1 is the exhausted one this exact worker execution is running as
    // (`identity.executionAttempt`), so no cross-process coordination is
    // needed to know whether this is the final word.
    const recoverablePanelExhaustion = (panelFailure !== undefined || isProvider5xx)
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
        const isSuperseded = Boolean(
          isReviewSuperseded(error) ||
          (deps.isCurrentHead && !deps.isCurrentHead()) ||
          (error instanceof Error && (
            error.message.includes('stale run aborted') ||
            error.message.includes('superseded') ||
            (deps.signal?.aborted && (deps.isCurrentHead ? !deps.isCurrentHead() : false))
          ))
        );

        if (isSuperseded) {
          await deps.checkClient.completeCheck({
            owner: identity.owner,
            repo: identity.repoName,
            checkId: failedCheckId,
            conclusion: 'neutral',
            title: 'Review Yeti: review superseded',
            summary: 'Superseded by a newer pull request head.',
          });
        } else if (isProvider5xx) {
          if (typeof deps.checkClient.updateCheck === 'function') {
            await deps.checkClient.updateCheck({
              owner: identity.owner,
              repo: identity.repoName,
              checkId: failedCheckId,
              status: 'in_progress',
              title: 'Review Yeti: gateway capacity unavailable (requeuing)',
              summary: 'Gateway capacity unavailable (502/503 upstream). Execution will automatically requeue.',
            });
          }
        } else {
          const incompleteLanes = panelFailure?.panelEvidence?.incompleteLanes;
          const infrastructureRetry = isRecoverablePanelRetryEligible(identity.executionAttempt)
            ? { nextAttempt: identity.executionAttempt + 1, maxAttempts: RECOVERABLE_PANEL_AUTO_RETRY_CAP + 1 }
            : undefined;
          await deps.checkClient.completeCheck({
            owner: identity.owner,
            repo: identity.repoName,
            checkId: failedCheckId,
            conclusion: 'failure',
            title: incompleteLanes && incompleteLanes.length > 0
              ? renderIncompleteInfrastructureTitle(incompleteLanes, infrastructureRetry)
              : 'Review Yeti: review did not complete',
            summary: [
              ...(incompleteLanes && incompleteLanes.length > 0
                ? [renderIncompleteInfrastructureSummary(identity.headSha, incompleteLanes, infrastructureRetry, identity.executionAttempt)]
                : []),
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
              ...(workerLogLocator ? [workerLogLocator] : []),
            ].join('\n\n'),
          });
        }
      } catch {
        logger.error('Failed to publish the fail-closed conclusion', {
          runId: identity.runId,
          failureClass,
          reason: 'check_publication_failed',
        });
      }
    }
    // REL-1057: a superseded run is not a failure. The service retires it
    // itself when the newer head is admitted (or its deadline reaper does, if
    // no newer head ever arrives), so a legacy failure callback here would
    // only record a false failure against a head nobody will merge.
    if (deps.completion && !isReviewSuperseded(error)) {
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
    // Base-policy driven (see `resolveReviewEngine`'s doc comment): a PR cannot switch its own
    // review engine by setting an env var, only by what `workerConfig.review_engine` resolved to.
    //
    // The authoritative gate admits a fixed persona roster and later re-derives eligibility from
    // those exact ids. The composed engine invents task ids from the diff at execution time, so its
    // otherwise-clean output cannot satisfy that immutable roster contract. Keep authoritative
    // execution on the admitted persona panel until composed plans have their own service-owned,
    // deterministic admission contract. Shadow mode already gates on the panel and remains safe.
    const configuredReviewEngine = resolveReviewEngine(workerConfig);
    const reviewEngine = authoritative && configuredReviewEngine === 'composed'
      ? 'panel'
      : configuredReviewEngine;
    const panelRunner = reviewEngine === 'composed'
      ? (deps.composedReviewRunner || executeComposedReview)
      : (deps.panelRunner || executePersonaPanel);
    // Shadow mode always gates on the fan-out panel -- `panelRunner` above already resolved to it
    // for any `reviewEngine` other than `'composed'`, `'shadow'` included. `shadowRunner` is the
    // second, non-gating engine invoked alongside it purely to collect comparison evidence.
    const isShadow = reviewEngine === 'shadow';
    const shadowRunner = deps.composedReviewRunner || executeComposedReview;
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
    let source: Awaited<ReturnType<typeof loadSameHeadReviewSource>>;
    try {
      source = await sourceLoader({
        repo: identity.repo,
        prNumber: identity.prNumber,
        expectedBaseSha: identity.baseSha,
        expectedHeadSha: identity.headSha,
        token: value(env, 'GH_TOKEN'),
      }, undefined, {
        ...workerLargeDiffSourceOptions(env, (message, fields) => logger.info(message, {
          runId: identity.runId, repository: identity.repo, ...fields,
        })),
        // REL-1103: transient GitHub failures on these reads retry, bounded by
        // the worker's terminal deadline when the operator forwarded it.
        retry: githubRetryOptionsFromEnv(env),
      });
    } catch (error) {
      // REL-1057: a push between admission and this read means a newer head
      // supersedes this run. Only a moved head qualifies: a base-only move
      // keeps the same head under review and stays a failure.
      if (error instanceof GitHubPullRequestIdentityMovedError && error.headMoved) {
        throw new ReviewSupersededError('pre_review', identity.headSha, error.currentHeadSha);
      }
      throw error;
    }

    const { files: changedFiles, unreadable } = parseChangedFiles(String(source.diff));
    // An empty changed-file set must not be read as "nothing to review, ship".
    if (changedFiles.length === 0) throw new Error('admitted head produced no reviewable diff');

    const client = deps.client || new OpenRouterClient({ baseUrl: transport.baseUrl, apiKey: transport.apiKey });

    // Full-repository grounding for persona find_files/read_file tools (see
    // `createRepoFileProvider`'s doc comment for the defect this fixes: a diff-scoped miss on a
    // file the diff imports but does not itself modify read as an honest "does not exist"). Uses
    // this run's own `GH_TOKEN` -- the repository-scoped `contents: read` token already minted
    // for the diff loader and visibility lookup above -- never `checkClient`'s `checks: write`
    // token, which is asserted to carry no broader permission. Construction is fail-soft: a
    // missing token or a throwing factory leaves `repoFileProvider` undefined, which the panel
    // engine's tool handler already treats as "no full-repository access wired for this run"
    // (diff-scoped tools only), not as a review failure.
    let repoFileProvider: RepoFileProvider | undefined;
    const repoReadToken = value(env, 'GH_TOKEN');
    if (repoReadToken) {
      try {
        const factory = deps.repoFileProviderFactory
          || ((input: { token: string; owner: string; repo: string; headSha: string }) => createRepoFileProvider(
            new GitHubInstallationClient({ token: input.token }), input.owner, input.repo, input.headSha,
          ));
        repoFileProvider = factory({
          token: repoReadToken,
          owner: identity.owner,
          repo: identity.repoName,
          headSha: identity.headSha,
        });
      } catch (error: any) {
        repoFileProvider = undefined;
        logger.warn('Failed to construct full-repository file provider for this run; persona find_files/read_file tools stay scoped to the diff', {
          runId: identity.runId,
          repository: identity.repo,
          error: error?.message || String(error),
        });
      }
    } else {
      logger.warn('No GH_TOKEN available for this run; persona find_files/read_file tools stay scoped to the diff (no full-repository grounding)', {
        runId: identity.runId,
        repository: identity.repo,
      });
    }

    // REL-1079: deterministic diff shrinking, default off (`REVIEW_YETI_DIFF_SHRINK`). Both
    // engines apply it after the shared applicability decision and return what they did as
    // `panelResult.diffShrink`, which the check summary publishes.
    const diffShrink = await loadDiffShrinkInput({
      env,
      repository: identity.repo,
      changedPaths: changedFiles.map((file) => file.path),
      repoFileProvider,
    });
    // REL-1082: risk-ordered review budget per lane, default off (`REVIEW_YETI_BUDGET`). Both
    // engines pack after the shared decision and return what each lane received as
    // `panelResult.reviewBudget`, which the check summary publishes.
    const reviewBudget = loadReviewBudgetInput({ env, repository: identity.repo });
    // REL-1083: map-reduce review for a lane larger than one budget, default off
    // (`REVIEW_YETI_MAP_REDUCE`). Deadline-aware through REVIEW_TERMINAL_DEADLINE when the
    // operator forwards it; the engine returns what it chunked as `panelResult.mapReduce`.
    const mapReduce = loadMapReduceInput({ env, repository: identity.repo });

    // REL-1084: incremental re-review, default off (`REVIEW_YETI_INCREMENTAL`). Null when off;
    // never throws. Both engines apply the scope after the shared applicability decision and
    // return what they carried forward as `panelResult.incremental`.
    const incrementalPlan = await planIncrementalReview({
      env,
      repository: identity.repo,
      current: {
        runId: identity.runId, repositoryId: identity.repositoryId, prNumber: identity.prNumber,
        headSha: identity.headSha, baseSha: identity.baseSha, executionAttempt: identity.executionAttempt,
        policyDigest: value(env, 'REVIEW_POLICY_DIGEST'), configDigest: value(env, 'REVIEW_CONFIG_DIGEST'),
      },
      currentPaths: changedFiles.map((file) => file.path),
      base: deps.incrementalBase,
      reader: deps.incrementalCompareReader ?? (repoReadToken ? createIncrementalCompareReader({
        token: repoReadToken, repositoryId: identity.repositoryId, owner: identity.owner, repo: identity.repoName,
      }) : undefined),
    });
    const incrementalScope = incrementalPlan?.scope ?? undefined;

    // REL-1085: per-file verdict cache, default off (`REVIEW_YETI_VERDICT_CACHE`). Null when off;
    // never throws. Both engines apply the scope after the shared applicability decision (and after
    // shrinking and the incremental scope) and return what they served as `panelResult.verdictCache`.
    const verdictCacheOn = verdictCacheEnabledFor(env, identity.repo);
    const verdictCachePlan = !verdictCacheOn ? null : await planVerdictCache({
      env,
      repository: identity.repo,
      current: {
        runId: identity.runId, repositoryId: identity.repositoryId, prNumber: identity.prNumber,
        headSha: identity.headSha, baseSha: identity.baseSha, executionAttempt: identity.executionAttempt,
        policyDigest: value(env, 'REVIEW_POLICY_DIGEST'), configDigest: value(env, 'REVIEW_CONFIG_DIGEST'),
      },
      laneKeys: verdictCacheLaneKeys({
        personas: workerConfig.personas,
        providers: workerConfig.reviewers.providers,
        // The panel prompts from the configured charter and, off the authoritative roster, dashboard overrides.
        promptOf: (persona) => personaLaneViewIdentity(persona as Parameters<typeof personaLaneViewIdentity>[0], !authoritative),
        policyDigest: value(env, 'REVIEW_POLICY_DIGEST'),
        configDigest: value(env, 'REVIEW_CONFIG_DIGEST'),
        engine: reviewEngine,
        workerVersion: String(workerPackage.version),
        viewFlags: {
          diffShrink: diffShrinkEnabledFor(env, identity.repo),
          incremental: incrementalReviewEnabledFor(env, identity.repo),
          budget: reviewBudgetEnabledFor(env, identity.repo),
          mapReduce: String(env.REVIEW_YETI_MAP_REDUCE ?? '').trim(),
        },
      }),
      base: deps.verdictCacheBase,
      reader: deps.verdictCacheCompareReader ?? (repoReadToken ? createVerdictCacheCompareReader({
        token: repoReadToken, repositoryId: identity.repositoryId, owner: identity.owner, repo: identity.repoName,
      }) : undefined),
    });
    const verdictCacheScope = verdictCachePlan?.scope ?? undefined;
    if (verdictCachePlan) {
      logger.info('Verdict cache planned', {
        runId: identity.runId,
        repository: identity.repo,
        mode: verdictCachePlan.decision.mode,
        ...(verdictCachePlan.decision.mode === 'full'
          ? { reason: verdictCachePlan.decision.reason,
            ...(verdictCachePlan.decision.priorRefusal ? { priorRefusal: verdictCachePlan.decision.priorRefusal } : {}) }
          : { permitted: verdictCachePlan.decision.permitted.length, sourceRunId: verdictCachePlan.decision.source.runId }),
        recording: verdictCacheScope !== undefined,
      });
    }
    if (incrementalPlan) {
      logger.info('Incremental re-review planned', {
        runId: identity.runId,
        repository: identity.repo,
        mode: incrementalPlan.decision.mode,
        ...(incrementalPlan.decision.mode === 'full'
          ? { reason: incrementalPlan.decision.reason,
            ...(incrementalPlan.decision.priorRefusal ? { priorRefusal: incrementalPlan.decision.priorRefusal } : {}) }
          : { carriedForward: incrementalPlan.decision.carriedForwardPaths.length,
            reviewed: incrementalPlan.decision.reviewPaths.length,
            openFindingFiles: incrementalPlan.decision.openFindingPaths.length }),
      });
    }

    // REL-677 / ADR 0329: index-at-review-time zoekt grounding. Strictly fail-soft: any
    // failure leaves the panel byte-identical to a run without zoekt. The scratch tree is
    // removed in the finally below; the index never outlives this review run. Grounding
    // runs BEFORE the panel deadline starts — its own stage budgets bound the tarball
    // fetch and index build, so grounding never eats the panel's timeout.
    const zoektGrounding = deps.zoektGrounding || defaultZoektGrounding;
    const zoektGroundingEnabled = zoektGroundingEnabledFor(env, workerConfig);
    const panelDeadline = createPanelDeadlineSignal(workerConfig.reviewers.overall_timeout_s, deps.signal);
    let zoektScratchRoot: { indexDir?: string; scratchDir?: string; reason?: string } = {};
    // REL-677: index-build duration is fixed setup cost paid on every grounded review, separate
    // from persona lane time -- the trade-off the REL-677 latency claim rests on (setup cost vs.
    // turns saved by grounded lookups) is unfalsifiable without measuring it on its own span.
    // `zoektDuration` (panelEngine.ts) measures query time against an already-built index; this
    // measures materializing the worktree and building that index in the first place.
    let zoektIndexBuildMs = 0;
    type ShadowOutcome =
      | { status: 'skipped' }
      | { status: 'settled'; result: PanelResult }
      | { status: 'error'; error: unknown };
    // Declared here (not `const` inside the `try` below) for the same reason `zoektScratchRoot`
    // and `zoektIndexBuildMs` above are: the `finally` at the bottom of this `try` needs to read
    // them, and a `try`/`finally` pair does not share block scope -- a `const` declared inside the
    // `try` is not visible inside `finally`.
    let shadowDeadline: ReturnType<typeof createPanelDeadlineSignal> | undefined;
    let shadowOutcomePromise: Promise<ShadowOutcome> = Promise.resolve({ status: 'skipped' });
    // REL-1081: shadow-only Jev triage. Total (never throws), inert unless REVIEW_YETI_JEV_SHADOW
    // and TYPESAFE_* are set, runs concurrently with the panel, and receives snapshots only --
    // nothing it produces flows back into this run. Joined after every outcome-visible action.
    const jevShadow = startJevTriageShadow({
      env,
      repository: identity.repo,
      runId: identity.runId,
      prNumber: identity.prNumber,
      headSha: identity.headSha,
      changedFiles,
      personas: workerConfig.personas.filter((persona) => persona.enabled)
        .map((persona) => ({ id: persona.id, charter: persona.charter })),
      ...(deps.jevTriageShadow?.asker ? { asker: deps.jevTriageShadow.asker } : {}),
      ...(deps.jevTriageShadow?.limits ? { limits: deps.jevTriageShadow.limits } : {}),
    });
    try {
      // A throwing grounding dep still fails soft: grounding is evidence
      // enrichment, never a precondition of the review.
      zoektScratchRoot = await runInSpan('review_yeti_zoekt_index_build', async (span) => {
        const buildStart = deps.now ? deps.now() : Date.now();
        let result: { indexDir?: string; scratchDir?: string; reason?: string };
        try {
          result = await zoektGrounding({
            repository: identity.repo,
            headSha: identity.headSha,
            token: value(env, 'GH_TOKEN'),
            enabled: zoektGroundingEnabled,
            signal: deps.signal,
            zoektIndexBinaryPath: value(env, 'ZOEKT_INDEX_BIN') || undefined,
          });
        } catch (groundingError: any) {
          result = { reason: groundingError?.message || 'zoekt_grounding_error' };
        }
        span.setAttribute('review_yeti.zoekt_index_build.enabled', zoektGroundingEnabled);
        // A disabled run performs no materialize/build work, so it has no build cost to
        // report: gate the duration attribute and the histogram sample on `enabled` so a
        // disabled run can never record (or pollute the REL-677 latency measurement with)
        // a build duration for a build that never happened.
        if (zoektGroundingEnabled) {
          zoektIndexBuildMs = (deps.now ? deps.now() : Date.now()) - buildStart;
          const status = result.indexDir ? 'ok' : (result.reason || 'unknown');
          span.setAttribute('review_yeti.zoekt_index_build.status', status);
          span.setAttribute('review_yeti.zoekt_index_build.duration_ms', zoektIndexBuildMs);
          getMetrics().zoektIndexBuildDuration.record(zoektIndexBuildMs / 1000, { repository: identity.repo, status });
        } else {
          span.setAttribute('review_yeti.zoekt_index_build.status', 'disabled');
        }
        return result;
      });
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
      // Shadow evidence: its OWN independent deadline derived from the same `overall_timeout_s`
      // (`createPanelDeadlineSignal` mints a fresh timer each call), so a hung composed run times
      // out on its own schedule and can never extend this job past the panel's deadline below.
      // Started here, before the panel await, so the two engines run CONCURRENTLY -- wall time is
      // max(panel, composed), never the sum. The panel holds up to `MAX_CONCURRENT_PERSONAS` (4)
      // provider slots and the composed run holds 1; both fitting inside the account's ceiling of
      // 10 is what makes running them side by side safe. `shadowOutcomePromise` is awaited only
      // once evidence is built (`buildReviewResult({ includeShadow: true })`), well after the
      // panel's own check publication below, so a slow shadow lane never delays it.
      shadowDeadline = isShadow
        ? createPanelDeadlineSignal(workerConfig.reviewers.overall_timeout_s, deps.signal)
        : undefined;
      // TOTAL, never rejects: a composed-engine throw, timeout, or abort must never propagate out
      // of this run and must never be added to the panel's own `optionalFailures`/`failedLanes` --
      // the panel is the only engine allowed to gate the published verdict. Swallowed and logged
      // here instead, and carried forward as a tagged outcome so a genuine empty/zero-lane composed
      // result ("produces nothing") and an outright failure both resolve to zero shadow evidence
      // entries, without either one ever reaching `panelResult`, `rawPublicationRoster`, or
      // `computeArbitration`.
      // Narrowed to a local `const`: `shadowDeadline` above is a `let` (reassigned once, but still
      // mutable to `tsc`), and its `.signal` is read inside the closures below -- `tsc` cannot
      // narrow a captured `let` across a closure boundary the way it can a `const`.
      const activeShadowDeadline = shadowDeadline;
      shadowOutcomePromise = isShadow && activeShadowDeadline
        ? Promise.resolve()
          .then(() => raceWithPanelAbort(
            Promise.resolve().then(() => shadowRunner({
              config: groundedConfig,
              changedFiles,
              repository: identity.repo,
              headSha: identity.headSha,
              baseSha: identity.baseSha,
              prNumber: identity.prNumber,
              repositoryVisibility,
              client,
              jobId: identity.runId,
              signal: activeShadowDeadline.signal,
              repoFileProvider,
              isCurrentHead: deps.isCurrentHead,
              ...(diffShrink ? { diffShrink } : {}),
              ...(incrementalScope ? { incremental: incrementalScope } : {}),
              ...(reviewBudget ? { reviewBudget } : {}),
              ...(verdictCacheScope ? { verdictCache: verdictCacheScope } : {}),
              ...(mapReduce ? { mapReduce } : {}),
              // Same upstream production Bifrost native JSON contract as the panel call below.
              requestPolicy: { responseFormat: { type: 'json_object' } },
            } as Parameters<typeof executeComposedReview>[0])),
            activeShadowDeadline.signal,
          ))
          .then((result): ShadowOutcome => ({ status: 'settled', result }))
          .catch((error): ShadowOutcome => {
            logger.warn('Shadow composed review lane failed; recorded as non-gating evidence only, panel verdict unaffected', {
              runId: identity.runId,
              repository: identity.repo,
              reason: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
            });
            return { status: 'error', error };
          })
        : Promise.resolve({ status: 'skipped' });
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
          repoFileProvider,
          isCurrentHead: deps.isCurrentHead,
          ...(authoritative ? { deterministicRoster: true } : {}),
          ...(diffShrink ? { diffShrink } : {}),
          ...(incrementalScope ? { incremental: incrementalScope } : {}),
          ...(reviewBudget ? { reviewBudget } : {}),
          ...(verdictCacheScope ? { verdictCache: verdictCacheScope } : {}),
          ...(mapReduce ? { mapReduce } : {}),
          // Keep the upstream production Bifrost native JSON contract while
          // enforcing the worker's overall cancellation boundary.
          requestPolicy: { responseFormat: { type: 'json_object' } },
        } as Parameters<typeof executePersonaPanel>[0])),
        panelDeadline.signal,
      );
      throwIfPanelAborted(panelDeadline.signal);
      const diffShrinkDisclosure = panelResult.diffShrink ?? null;
      if (diffShrinkDisclosure) {
        logger.info('Diff shrinking applied before review', {
          runId: identity.runId,
          repository: identity.repo,
          whitespaceOnlyFiles: diffShrinkDisclosure.whitespaceOnlyFiles.length,
          collapsedWhitespaceHunkFiles: diffShrinkDisclosure.collapsedWhitespaceHunks.length,
          renames: diffShrinkDisclosure.renames.length,
          linguistExcluded: diffShrinkDisclosure.linguistExcluded.length,
          keptFullDepth: diffShrinkDisclosure.keptFullDepth.length,
          estimatedTokensBefore: diffShrinkDisclosure.estimatedTokensBefore,
          estimatedTokensAfter: diffShrinkDisclosure.estimatedTokensAfter,
        });
      }
      if (panelResult.reviewBudget) {
        const lanes = panelResult.reviewBudget.lanes;
        const count = (depth: string) => lanes.reduce((sum, lane) => sum + lane.files.filter((file) => file.depth === depth).length, 0);
        logger.info('Review budget packed lane content', {
          runId: identity.runId,
          repository: identity.repo,
          lanes: lanes.length,
          full: count('full'),
          pastPerFileCut: lanes.reduce((sum, lane) => sum + lane.files.filter((file) => file.pastPerFileCut).length, 0),
          signatures: count('signatures'),
          notDeeplyReviewed: count('not-deeply-reviewed'),
          truncated: count('truncated'),
          packedCharsMax: Math.max(0, ...lanes.map((lane) => lane.packedChars)),
        });
      }
      if (panelResult.mapReduce) {
        const lanes = panelResult.mapReduce.lanes;
        logger.info('Map-reduce review chunked lane content', {
          runId: identity.runId,
          repository: identity.repo,
          lanes: lanes.length,
          chunks: lanes.reduce((sum, lane) => sum + lane.chunks.length, 0),
          collapsedChunks: lanes.reduce((sum, lane) => sum + lane.chunks.filter((chunk) => chunk.collapsed).length, 0),
          concurrency: panelResult.mapReduce.concurrency,
          findingsFromChunks: lanes.reduce((sum, lane) => sum + lane.findings.fromChunks, 0),
          duplicatesMerged: lanes.reduce((sum, lane) => sum + lane.findings.exactDuplicates + lane.findings.reduceMerged, 0),
          crossChunkFindings: lanes.reduce((sum, lane) => sum + lane.findings.crossChunk, 0),
          reduceStatuses: lanes.map((lane) => lane.reduce.status),
          notApplied: panelResult.mapReduce.notApplied?.length ?? 0,
        });
      }

      // REL-1084: set by the engine only when its lanes received carried-forward notes.
      const incrementalDisclosure = panelResult.incremental ?? null;
      const incrementalClaim = incrementalClaimFrom(incrementalDisclosure);
      if (incrementalDisclosure) {
        logger.info('Incremental re-review carried files forward', {
          runId: identity.runId,
          repository: identity.repo,
          previousRunId: incrementalDisclosure.previous.runId,
          previousHeadSha: incrementalDisclosure.previous.headSha,
          carriedForward: incrementalDisclosure.carriedForwardPaths.length,
          reReviewedOpenFindings: incrementalDisclosure.reReviewedOpenFindingPaths.length,
          reviewed: incrementalDisclosure.reviewedPaths.length,
          estimatedTokensBefore: incrementalDisclosure.estimatedTokensBefore,
          estimatedTokensAfter: incrementalDisclosure.estimatedTokensAfter,
        });
      }

      const isFastShip = isFastShipPanelResult(panelResult);
      // REL-1085: what the engine served from cache, and this run's clean per-file lane results
      // for later runs. A fast-ship or zero-lane result reviewed nothing, so it records nothing.
      const verdictCacheDisclosure = panelResult.verdictCache ?? null;
      const verdictCacheRecord = buildVerdictCacheRecord({
        disclosure: verdictCacheDisclosure,
        scope: verdictCacheScope,
        contentIndex: verdictCachePlan?.contentIndex,
        lanes: isFastShip || (panelResult as any).zeroLaneNonEvidence ? [] : panelResult.personas,
        failedLaneIds: (panelResult.optionalFailures || []).map((failure) => failure.id),
        changedPaths: changedFiles.map((file) => file.path),
        // REL-1082: a file some lane got as signatures, truncated or as a listing was not deeply reviewed.
        reducedDepthPaths: (panelResult.reviewBudget?.lanes ?? [])
          .flatMap((lane) => lane.files.filter((file) => file.depth !== 'full').map((file) => file.path)),
      });
      if (verdictCachePlan) {
        logger.info('Verdict cache applied', {
          runId: identity.runId,
          repository: identity.repo,
          served: verdictCacheDisclosure?.cached.length ?? 0,
          ...(verdictCacheDisclosure?.source ? { sourceRunId: verdictCacheDisclosure.source.runId } : {}),
          reviewed: verdictCacheDisclosure?.reviewedPaths.length ?? 0,
          recorded: verdictCacheRecord?.entries.length ?? 0,
          estimatedTokensBefore: verdictCacheDisclosure?.estimatedTokensBefore,
          estimatedTokensAfter: verdictCacheDisclosure?.estimatedTokensAfter,
        });
      }
      // Owner-declared not-applicable: when every changed path matches the
      // repository's `auto_review.ignore_patterns`, no persona can ever match and
      // the honest outcome is a skipped check that claims no verdict -- not the
      // zero-lane non-evidence failure ADR 0333 forbids from counting as evidence,
      // and never a SHIP. A single non-ignored path keeps the normal review.
      // The resolved worker config does not carry `auto_review` through, so read
      // the policy from the config when present and fall back to the app-gate
      // policy JSON (the path DOKS/app-gate runs use). Malformed policy is left
      // to resolveWorkerConfig, which already fails closed on it.
      const ignorePatterns = ((): string[] => {
        const fromConfig = (workerConfig as any)?.auto_review?.ignore_patterns;
        if (Array.isArray(fromConfig)) {
          return (fromConfig as unknown[]).filter((g): g is string => typeof g === 'string' && g.length > 0);
        }
        const raw = env.REVIEW_YETI_POLICY_JSON;
        if (typeof raw === 'string' && raw.length > 0) {
          try {
            const parsed = JSON.parse(raw) as { auto_review?: { ignore_patterns?: unknown } };
            const value = parsed?.auto_review?.ignore_patterns;
            if (Array.isArray(value)) {
              return value.filter((g): g is string => typeof g === 'string' && g.length > 0);
            }
          } catch {
            // Intentionally swallowed: the policy parser above owns fail-closed.
          }
        }
        return [];
      })();
      const notApplicable = Boolean((panelResult as any).zeroLaneNonEvidence)
        && ignorePatterns.length > 0
        && changedFiles.length > 0
        && changedFiles.every((file) => ignorePatterns.some((glob) => matchOne(glob, file.path)));
      const rawRoster = rawPublicationRoster(panelResult, isFastShip, notApplicable);
      const rawFindings = (Array.isArray(panelResult.personas) ? panelResult.personas : [])
        .flatMap((persona: { findings?: unknown[] }) => persona.findings || []);
      const panelQuorumSatisfied = panelResult?.quorum?.satisfied === true;
      // REL-1092: analyzable files whose changed text GitHub omitted (the pull-files
      // fallback of a 406 diff). No lane saw them, so they are never counted as reviewed:
      // coverage is incomplete here, and the service ANDs this into its own coverage, so
      // the canonical derivation reaches the same verdict.
      const omittedSourcePaths = Array.isArray(panelResult.omittedSourcePaths) ? panelResult.omittedSourcePaths : [];
      const coverageGaps = [
        ...(unreadable.length > 0 ? ['unreadable diff header(s)'] : []),
        ...(omittedSourcePaths.length > 0
          ? [`${omittedSourcePaths.length} source file(s) whose patch GitHub omitted were not reviewed`] : []),
      ];
      // The model arbiter is evidence, not the policy boundary. The canonical
      // review policy treats P2 findings as advisory; trusting a raw FIX_FIRST
      // from the model made the DOKS app gate reject a clean (P0/P1-free) review.
      // Recompute from the exact persona findings and quorum so this lane shares
      // the same fail-closed severity contract as the hosted review path.
      const canonical = computeArbitration(rawRoster.lanes, rawRoster.arbitrationExpectedCount, {
        changedFiles,
        coverageComplete: rawRoster.rosterValid && panelQuorumSatisfied && coverageGaps.length === 0,
        ...(coverageGaps.length > 0 ? { coverageGaps } : {}),
        // One composed context is one reviewer: `rawRoster.lanes` there is the planned TASK list,
        // not a count of independent reviewers, so the default `panelSize` derivation (lane count)
        // would let a longer task plan silently raise its own P1 blocking threshold (7 tasks moves
        // it from 3 to 4). See `reviewCore.js`'s `resolvePanelSize` doc comment.
        ...(reviewEngine === 'composed' ? { panelSize: 1 } : {}),
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
        : notApplicable
          ? ('neutral' as const)
          : publishingConclusion(verdict, blocking.length, coverage);
      // A valid roster with failed reviewer calls and no findings is not a
      // code verdict. Preserve failure, but use the existing exact-head
      // recovery protocol instead of publishing an unrepeatable BLOCK while
      // leaving the durable run queued. Never relabel findings, malformed
      // rosters, missing diff coverage, or authoritative service results.
      const firstFailedLane = panelResult.optionalFailures?.[0];
      const recoverablePanelEvidence = {
        // A file no lane could read is a deterministic property of this diff; a
        // fresh attempt reads the same diff, so it is never the retryable shape.
        unreadableDiffCount: unreadable.length + omittedSourcePaths.length,
        mode: rawRoster.mode,
        rosterValid: rawRoster.rosterValid,
        failedLaneCount: rawRoster.failedLaneCount,
        quorumSatisfied: canonical.quorumSatisfied,
        rawFindingCount: rawFindings.length,
        canonicalFindingCount: findings.length,
        missingConfiguredLaneCount: rawRoster.missingConfiguredLaneCount,
        malformedReturnedLaneCount: rawRoster.malformedReturnedLaneCount,
      };
      const recoverablePanelFailure = isRecoverableIncompletePanel({ authoritative, ...recoverablePanelEvidence })
        // `runPersona` assigns a coded `failureClass` at the exact point it observed the lane's
        // terminal error (REL-892 finding 2); prefer that over re-deriving one from the free-form
        // `error` string here. `classifyFailure` remains the fallback for a lane that failed
        // before this classification existed in the code path. A silently missing lane reported
        // nothing at all, so there is no lane-level error to classify: the configured lane never
        // returned, which is a transport-shaped provider dropout, not a worker defect.
        ? (firstFailedLane
          ? (firstFailedLane.failureClass ?? classifyFailure(firstFailedLane.error))
          : 'transport')
        : undefined;
      const silentlyMissingLanes = recoverablePanelFailure !== undefined
        && rawRoster.failedLaneCount === 0 && rawRoster.missingConfiguredLaneCount > 0;
      // REL-1113: the same "a lane died on the way to the model and nothing found anything"
      // shape on the AUTHORITATIVE path. `isRecoverableIncompletePanel` refuses authoritative
      // results (the service owns that verdict), so ct-meta#3446 -- one of two lanes lost to a
      // gateway 502, zero findings -- was published as "Review Yeti: BLOCK" and never re-run.
      // Here it is only a candidate: the shared `isInfrastructureIncompleteResult` decision
      // below, evaluated on the exact payload the service will re-evaluate, is the authority.
      const authoritativeInfrastructureCandidate = authoritative
        && rawRoster.failedLaneCount > 0
        && isRecoverableIncompletePanel({ authoritative: false, ...recoverablePanelEvidence });

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
        ...(typeof p.toolTurns === 'number' ? { toolTurns: p.toolTurns } : {}),
        ...(typeof p.correctionTurns === 'number' ? { correctionTurns: p.correctionTurns } : {}),
        toolCallsCount: (p.toolCalls || []).length,
        promptTokens: p.promptTokens || p.usage?.prompt || 0,
        completionTokens: p.completionTokens || p.usage?.completion || 0,
        totalTokens: p.totalTokens || p.usage?.total || 0,
        ...(p.aggregateUsage ? { aggregateUsage: p.aggregateUsage } : {}),
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
    // The panel's own wall-clock measurement, distinct from `totalDurationMs` above: that figure
    // SUMS every lane's individual duration, which overstates wall time under the panel's
    // concurrent persona fan-out (MAX_CONCURRENT_PERSONAS). Comparing two engines on the sum alone
    // is meaningless; this is the one number that actually reflects how long the run took.
    // Optional so a `panelRunner` that predates this field (e.g. a pre-existing test double) still
    // degrades safely instead of reporting a fabricated `0`.
    const panelWallClockMs = panelResult.panelWallClockMs;
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
    // REL-1113: which lanes did not complete and why -- coded class plus the provider HTTP status
    // when one was observed (the nginx 502), never the lane's free-form error text.
    const incompleteLanes: IncompleteLaneDescription[] = (panelResult.optionalFailures || []).map((failure) => {
      const providerStatus = laneProviderStatus(failure.error);
      return {
        id: failure.id,
        failureClass: failure.failureClass ?? classifyFailure(failure.error),
        ...(providerStatus === undefined ? {} : { providerStatus }),
      };
    });

    // A count with nothing attached is not reviewable. Until now the check
    // published only a title and a summary, so a run could report four blocking
    // findings while the pull request carried no comment, no review and no
    // annotation -- nothing an author could act on. Both fields below need only
    // `checks: write`, so the findings become visible without widening the
    const changedPaths = new Set(changedFiles.map((file) => file.path));

    const documentationOnly = fastShipApproved && Boolean(panelResult.documentationOnly);
    // REL-972: a registry-verified lockfile-only diff takes the same audited
    // exemption; label it for what it is rather than calling a yarn.lock bump
    // documentation.
    const exemptionLabel = panelResult.noReviewableContentKind === 'lockfile-only'
      ? 'lockfile-only'
      : 'documentation-only';
    const title = notApplicable
      ? 'Review Yeti: NO_REVIEW (not applicable)'
      : documentationOnly
        ? `Review Yeti: SHIP (${exemptionLabel})`
        : fastShipApproved
          ? 'Review Yeti: SHIP (fast-ship)'
          : `Review Yeti: ${verdict}`;

    const safeClassifierRationale = fastShipApproved && panelResult.classifierRationale
      ? panelResult.classifierRationale.replace(/[`<>\r\n]/gu, ' ').trim().slice(0, 500)
      : 'Approved via fast-ship triage classifier.';

    const summaryParts = documentationOnly
      ? [
          `### Review Yeti: SHIP (${exemptionLabel})`,
          `- **Verdict**: \`SHIP\` at \`${identity.headSha}\` (no analyzable source changed).`,
          `- **Rationale**: \`${safeClassifierRationale}\``,
          renderCoverageSummary(coverage),
          renderTransportSummary(transport.model, resolvedTransportModel),
          `Repository visibility: ${repositoryVisibility}.`,
        ]
      : fastShipApproved
      ? [
          `### Review Yeti: SHIP (fast-ship)`,
          `- **Verdict**: \`SHIP\` at \`${identity.headSha}\` (fast-ship auto-approved without multi-persona panel).`,
          `- **Classifier Rationale**: \`${safeClassifierRationale}\``,
          `- **Token Savings**: Estimated ~${panelResult.tokensSaved.toLocaleString()} tokens saved by bypassing full panel evaluation.`,
          ...renderDiffShrinkSummary(diffShrinkDisclosure),
          ...renderIncrementalSummary(incrementalDisclosure, incrementalPlan),
          ...renderReviewBudgetSummary(panelResult.reviewBudget),
          // REL-1085: every file served from the verdict cache, or why none was.
          ...renderVerdictCacheSummary(verdictCacheDisclosure, verdictCachePlan, verdictCacheRecord),
          ...renderMapReduceSummary(panelResult.mapReduce),
          renderCoverageSummary(coverage),
          ...(renderRoutedFiles(panelResult) ? [renderRoutedFiles(panelResult)!] : []),
          ...renderReviewDepthDisclosure(panelResult),
          renderTransportSummary(transport.model, resolvedTransportModel),
          `Repository visibility: ${repositoryVisibility}.`,
        ]
      : [
          `Verdict \`${verdict}\` at \`${identity.headSha}\`.`,
          notApplicable
            ? 'Review not required: every changed path matches `auto_review.ignore_patterns` (repository-declared not-applicable). No panel ran; this check claims no verdict and is not review evidence.'
            : (panelResult as any).zeroLaneNonEvidence
              ? 'No persona paths matched changed files; zero-lane run is not review evidence.'
            : `Findings: ${findings.length} (blocking P0/P1: ${blocking.length}; ${rawFindings.length} raw persona finding(s) before clustering).`,
          ...(discardedFindingCount > 0
            ? [`${discardedFindingCount} raw finding(s) were discarded as unanchorable and are not counted above.`]
            : []),
          ...(unreadable.length > 0
            ? [`Reviewed ${changedFiles.length} file(s); ${unreadable.length} diff header(s) could not be read, so those files were NOT reviewed:\n${unreadable.map((header) => `- \`${header}\``).join('\n')}`]
            : []),
          // REL-1079: set by the engine only when its lanes received a shrunk diff.
          ...renderDiffShrinkSummary(diffShrinkDisclosure),
          // REL-1084: every carried-forward file, or why the review stayed full.
          ...renderIncrementalSummary(incrementalDisclosure, incrementalPlan),
          ...renderReviewBudgetSummary(panelResult.reviewBudget),
          // REL-1085: every file served from the verdict cache, or why none was.
          ...renderVerdictCacheSummary(verdictCacheDisclosure, verdictCachePlan, verdictCacheRecord),
          ...renderMapReduceSummary(panelResult.mapReduce),
          renderCoverageSummary(coverage),
          ...(renderRoutedFiles(panelResult) ? [renderRoutedFiles(panelResult)!] : []),
          ...renderReviewDepthDisclosure(panelResult),
          ...(renderUnreportedLanes(panelResult) ? [renderUnreportedLanes(panelResult)!] : []),
          renderTransportSummary(transport.model, resolvedTransportModel),
          `Repository visibility: ${repositoryVisibility}.`,
          renderTelemetrySummary({
            totalTurns, totalToolCalls, totalTokens, laneCount: personaMetrics.length, totalDurationMs,
            panelWallClockMs,
            ...(zoektGroundingEnabled ? { zoektIndexBuildMs } : {}),
          }),
        ];

    const completedAt = new Date(now()).toISOString();
    // Resolved lazily, only where shadow evidence is actually consumed (the non-authoritative
    // evidence branch below) -- never on the authoritative `reportReviewResult` path, which never
    // requests `includeShadow` and so never needs to wait for it. `deriveCanonicalWorkerReviewEvidence`
    // (the authoritative gate's server-side re-arbitration) rejects ANY persona id outside its
    // trusted `expectedPersonaIds` roster as an "unknown persona lane" -- an invalid-evidence,
    // published-failure outcome. A composed-engine task id was never one of the panel's configured
    // persona ids, so a shadow lane reaching that path would not just be inert extra evidence, it
    // would flip the authoritative decision to failure. `buildReviewResult()`'s default
    // (`includeShadow` unset/false) is what keeps the two engines' evidence on separate rails.
    let shadowOutcome: ShadowOutcome = { status: 'skipped' };
    // The persona lanes and findings behind the published check, in the shape
    // the service's completion contract accepts. Built once and reported on
    // both paths: the authoritative gate re-arbitrates from it; the legacy
    // terminal success carries it as evidence so the service can keep it.
    const buildReviewResult = (options: { includeShadow?: boolean; includeRoster?: boolean } = {}) => {
      const findingKeys = new Set(['severity', 'path', 'line', 'startLine', 'title', 'body', 'suggestion',
        'replacementCode', 'confidence', 'recommendation', 'fixOptions', 'isArchitectural']);
      // Additive, OPTIONAL per-persona telemetry: the accumulated per-turn usage this lane's
      // `invoke()` loop actually made, not just its terminal turn. Only emitted when the panel
      // result actually carries it, so a `panelRunner` fixture that predates per-turn accumulation
      // (or a fast-ship/zero-lane result with no completed lanes) omits the field entirely instead
      // of publishing a fabricated zero.
      //
      // The field list itself is NOT hand-mirrored here: `buildPersonaTelemetryPayload` is the one
      // shared builder, co-located with `personaTelemetrySchema` in `workerReviewCompletion.ts`, so
      // an edit to the schema and its builder land in the same file, in the same diff. (An earlier
      // version of this code relied on `z.output<typeof personaTelemetrySchema>` alone as the
      // return type here -- that does NOT actually get enforced by `tsc --noEmit` through the
      // conditional spreads a builder like this needs; renaming a schema field and re-running the
      // typecheck produced no error. The shared builder is the fix, not the type annotation.)
      const personas = panelResult.personas.map((persona) => {
        const telemetry = buildPersonaTelemetryPayload(persona);
        return {
          id: persona.id,
          // A lane that completed without stating a decision is read from its
          // findings: evidence must not be dropped for a missing label.
          decision: persona.decision ?? (persona.findings.length > 0 ? 'FINDINGS' : 'APPROVE'),
          status: 'COMPLETE' as const,
          // Use the same anchored inputs as raw-check arbitration. Keep each
          // contribution on its original lane: copying canonical.findings to
          // every persona would duplicate clusters and erase ownership. The
          // service still performs strict validation and canonical arbitration;
          // unanchorable raw findings must not cross this trusted worker boundary.
          findings: persona.findings.flatMap((finding) => {
            const anchored = sanitizeFinding(finding, changedFiles);
            if (!anchored) return [];
            // These typed advisory fields are not part of arbitration's claim
            // identity, but remain useful callback evidence for the same finding.
            const { recommendation, fixOptions, isArchitectural } = finding;
            return [Object.fromEntries(Object.entries({ ...anchored, recommendation, fixOptions, isArchitectural })
              .filter(([key, value]) => findingKeys.has(key) && value !== undefined))];
          }),
          ...(telemetry ? { telemetry } : {}),
        };
      });
      // Same coded-reason-first precedence as the published check's `failedLanes` above: this is
      // the authoritative service's own record of why each lane failed and must not independently
      // drift from it by re-deriving a class from prose here.
      const errors = (panelResult.optionalFailures || []).map((failure) => ({ id: failure.id,
        decision: 'ERROR' as const, status: 'ERROR' as const, findings: [],
        errorClass: failure.failureClass ?? classifyFailure(failure.error) }));
      // Additive, non-gating shadow evidence (`evidenceSource: 'shadow'`, see
      // `personaSchema.evidenceSource` in `workerReviewCompletion.ts`). ONLY appended when the
      // caller explicitly opts in with `includeShadow` -- the authoritative `reportReviewResult`
      // call below never does, for the reason in the comment above `shadowOutcome`'s declaration.
      // A skipped shadow run (not `'shadow'` mode) or one that produced neither a persona nor a
      // failure yields an empty array, which is what keeps a shadow run whose composed lane
      // produced nothing byte-identical to a plain panel run's evidence.
      const shadowPersonas = options.includeShadow && shadowOutcome.status === 'settled'
        ? (shadowOutcome.result.personas || []).map((persona) => {
          const telemetry = buildPersonaTelemetryPayload(persona);
          return {
            id: persona.id,
            decision: persona.decision ?? (persona.findings.length > 0 ? 'FINDINGS' : 'APPROVE'),
            status: 'COMPLETE' as const,
            findings: persona.findings.map((finding) => Object.fromEntries(
              Object.entries(finding).filter(([key, value]) => findingKeys.has(key) && value !== undefined))),
            evidenceSource: 'shadow' as const,
            ...(telemetry ? { telemetry } : {}),
          };
        })
        : [];
      const shadowErrors = options.includeShadow && shadowOutcome.status === 'settled'
        ? (shadowOutcome.result.optionalFailures || []).map((failure) => ({
          id: failure.id, decision: 'ERROR' as const, status: 'ERROR' as const, findings: [],
          evidenceSource: 'shadow' as const,
          errorClass: failure.failureClass ?? classifyFailure(failure.error),
        }))
        : [];
      // The composed engine itself never started, threw, or timed out (as opposed to running and
      // reporting its own per-task `optionalFailures` above): one synthetic ERROR lane records
      // that the shadow lane failed at all, still tagged `evidenceSource: 'shadow'` and still never
      // touching `panelResult`/`rawPublicationRoster`/`computeArbitration`.
      const shadowRunFailure = options.includeShadow && shadowOutcome.status === 'error'
        ? [{ id: 'shadow_composed_engine', decision: 'ERROR' as const, status: 'ERROR' as const, findings: [],
          evidenceSource: 'shadow' as const, errorClass: classifyFailure(shadowOutcome.error) }]
        : [];
      return parseWorkerReviewCompletion({ version: 'WorkerReviewCompletion.v1',
        runId: identity.runId, repositoryId: identity.repositoryId, owner: identity.owner, repo: identity.repoName,
        prNumber: identity.prNumber, headSha: identity.headSha, baseSha: identity.baseSha,
        policyDigest: value(env, 'REVIEW_POLICY_DIGEST'), configDigest: value(env, 'REVIEW_CONFIG_DIGEST'),
        executionAttempt: identity.executionAttempt,
        result: { version: 'WorkerReviewResult.v1', completedAt,
          // Bounded the same way `rawPublicationRoster` bounds its own lane array: MAX_PERSONAS
          // caps the combined panel + shadow lane count so an oversized composed task plan cannot
          // push this past `resultSchema.personas`'s own bound.
          personas: [...personas, ...errors, ...shadowPersonas, ...shadowErrors, ...shadowRunFailure].slice(0, MAX_PERSONAS),
          coverageComplete: coverageGaps.length === 0, quorumSatisfied: panelResult.quorum?.satisfied === true,
          // See `resultSchema.panelWallClockMs`: the panel's own wall-clock measurement, carried
          // across the completion boundary so downstream comparisons stop relying on a summed
          // per-lane duration that overstates wall time under fan-out. Omitted (not a fabricated
          // `0`) when the panel result predates this field, matching `telemetry` above.
          ...(typeof panelWallClockMs === 'number' ? { panelWallClockMs } : {}),
          // REL-1084: what the lanes did not see, and the prior review it rests on. The trusted
          // completion side verifies it before any carried-forward verdict counts.
          ...(incrementalClaim ? { incremental: incrementalClaim } : {}),
          // REL-1085: the files served from cache (verified by the trusted completion side before
          // they count) and this run's clean per-file results for later runs.
          ...(verdictCacheRecord ? { verdictCache: verdictCacheRecord } : {}),
          // REL-1084: the lane roster this verdict required, so a later non-authoritative run can
          // prove no lane was missing. Evidence path only (the authoritative gate owns its roster),
          // and only for a valid panel roster: a fast-ship, exemption or invalid roster omits it,
          // which makes the record ineligible as a prior.
          ...(options.includeRoster && rawRoster.mode === 'panel' && rawRoster.rosterValid
            ? { roster: [...panelResult.applicablePersonaIds] } : {}) },
      }).result;
    };
    // REL-1113: an automatic fresh attempt is still available for this execution (the same bound
    // the dispatcher and the trusted completion service apply), or this is the last one.
    const infrastructureRetry = isRecoverablePanelRetryEligible(identity.executionAttempt)
      ? { nextAttempt: identity.executionAttempt + 1, maxAttempts: RECOVERABLE_PANEL_AUTO_RETRY_CAP + 1 }
      : undefined;
    // REL-1113: on the authoritative path, the exact result reported to the service, marked as
    // infrastructure-incomplete, when -- and only when -- the shared decision accepts it. The
    // service evaluates the same function on the same payload to re-admit a fresh attempt, so
    // the worker's INCOMPLETE check and the service's retry can never disagree.
    let authoritativeInfrastructureResult: WorkerReviewResult | undefined;
    if (authoritativeInfrastructureCandidate) {
      const primary = incompleteLanes.find((lane) => lane.providerStatus !== undefined) ?? incompleteLanes[0];
      const candidate: WorkerReviewResult = {
        ...buildReviewResult(),
        failureDiagnostics: {
          reason: INCOMPLETE_INFRASTRUCTURE_REASON,
          ...(primary?.providerStatus === undefined ? {} : { providerStatus: primary.providerStatus }),
          logTail: redactWorkerFailureLogTail(`lanes did not complete: ${incompleteLanes
            .map((lane) => `${lane.id}=${lane.failureClass}${lane.providerStatus === undefined ? '' : `/${lane.providerStatus}`}`)
            .join(', ')}`),
          recoverableIncompletePanel: true,
        },
      };
      if (isInfrastructureIncompleteResult(candidate)) authoritativeInfrastructureResult = candidate;
    }
    const infrastructureIncomplete = authoritativeInfrastructureResult !== undefined
      || (recoverablePanelFailure !== undefined && !silentlyMissingLanes && incompleteLanes.length > 0
        && incompleteLanes.every((lane) => (INFRASTRUCTURE_LANE_FAILURE_CLASSES as readonly string[]).includes(lane.failureClass)));
    if (infrastructureIncomplete) {
      // A countable reason class for runs that ended incomplete on infrastructure: a structured
      // log line (VictoriaLogs) and a worker counter (pushed at exit, REL-1104). Never a verdict.
      logger.warn('Review incomplete: reviewer lane(s) failed on infrastructure; not a review verdict', {
        reasonClass: 'incomplete_infra',
        runId: identity.runId,
        repository: identity.repo,
        prNumber: identity.prNumber,
        headSha: identity.headSha,
        executionAttempt: identity.executionAttempt,
        authoritative,
        retryScheduled: infrastructureRetry !== undefined,
        expectedLanes: coverage.expectedLaneCount,
        completedLanes: coverage.completedLaneCount,
        failedLanes: incompleteLanes,
      });
      try {
        getMetrics().reviewIncompleteInfra.add(1, {
          outcome: infrastructureRetry ? 'retrying' : 'exhausted',
          failure_class: incompleteLanes[0]?.failureClass ?? 'unknown',
          authoritative: String(authoritative),
        });
      } catch {
        // Telemetry never changes a review outcome.
      }
    }
    if (recoverablePanelFailure) {
      // Failed-lane error strings may contain provider payloads. Keep their
      // classification and bounded counts, not their free-form text. Everything else here --
      // transport/resolved model, aggregate telemetry, and per-lane identity/classification/usage
      // -- carries no provider payload and is safe to publish on the fail-closed check.
      await reportTerminalFailure(new Error(silentlyMissingLanes
        ? 'A configured reviewer lane did not return a result.'
        : 'An optional reviewer did not complete.'), checkId, {
        failureClass: recoverablePanelFailure,
        coverage,
        panelEvidence: {
          requestedModel: transport.model,
          resolvedModel: resolvedTransportModel,
          telemetry: { totalTurns, totalToolCalls, totalTokens, laneCount: personaMetrics.length, totalDurationMs, panelWallClockMs },
          failedLanes,
          ...(infrastructureIncomplete ? { incompleteLanes } : {}),
        },
      });
    } else if (authoritativeInfrastructureResult) {
      // REL-1113: same publication order as a verdict (durable service record first), but the
      // check is INCOMPLETE -- never "BLOCK" -- and names the lanes that did not complete. The
      // service records `infrastructure-failure` for this result and, while attempts remain,
      // re-admits a fresh execution attempt from the same shared decision.
      await reportReviewResult(authoritativeInfrastructureResult);
      await deps.checkClient.completeCheck({
        owner: identity.owner,
        repo: identity.repoName,
        checkId,
        conclusion: 'failure',
        title: renderIncompleteInfrastructureTitle(incompleteLanes, infrastructureRetry),
        summary: [
          renderIncompleteInfrastructureSummary(identity.headSha, incompleteLanes, infrastructureRetry, identity.executionAttempt),
          renderCoverageSummary(coverage),
          renderTransportSummary(transport.model, resolvedTransportModel),
          renderTelemetrySummary({ totalTurns, totalToolCalls, totalTokens, laneCount: personaMetrics.length, totalDurationMs, panelWallClockMs }),
          renderFailedLanesSummary(failedLanes),
          ...(workerLogLocator ? [workerLogLocator] : []),
        ].join('\n\n'),
      });
    } else {
      // Publication-order invariant: the authoritative completion is durably
      // recorded BEFORE this worker publishes its raw check conclusion. The
      // service's gate publisher replays the durably recorded terminal desired
      // state onto the `Review Yeti Gate` check; a raw check that reaches
      // GitHub first leaves a one-shot gate reader looking at raw success next
      // to a still-pending gate -- the exact-head window where the gate raced
      // the durable verdict. Reporting first also means a lost completion
      // acknowledgement can never leave a green raw check over an unrecorded
      // verdict: the catch path's fail-closed terminal failure is then the
      // only published conclusion.
      if (authoritative) {
        await reportReviewResult(buildReviewResult());
      }
      await deps.checkClient.completeCheck({
      owner: identity.owner,
      repo: identity.repoName,
      checkId,
      conclusion,
      title,
      summary: [...summaryParts, ...(workerLogLocator ? [workerLogLocator] : [])].join('\n\n'),
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
    }

    // A not-applicable run claims no verdict, so there is no evidence to report:
    // reporting it as success would be a false approval and as failure a false
    // rejection. It is omitted, exactly like a skipped check.
    if (!authoritative && !recoverablePanelFailure && conclusion !== 'neutral' && deps.completion?.reportReviewEvidence) {
      // Resolved here, immediately before it is needed, and nowhere earlier: `completeCheck` (or
      // `reportTerminalFailure` on the recoverable branch, which never reaches this guard) has
      // already published above, so waiting on the shadow lane here cannot delay it. `finally`
      // below is the backstop for every path that does NOT reach this line.
      if (isShadow) shadowOutcome = await shadowOutcomePromise;
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
          checkId, conclusion: conclusion as 'success' | 'failure', result: buildReviewResult({ includeShadow: true, includeRoster: true }),
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
      try {
        await deps.completion.reportTerminalSuccess(event);
      } catch (error) {
        // REL-1057: the service answers 409 when this run is no longer the
        // live one, most commonly because a newer head was admitted mid-review.
        // Confirm the head actually moved before calling it superseded; any
        // other 409, or a failed read, keeps the original error.
        if (error instanceof WorkerCompletionHttpError && error.httpStatus === 409) {
          const currentHeadSha = await (deps.pullRequestIdentityReader || readPullRequestIdentity)({
            token: value(env, 'GH_TOKEN'), repo: identity.repo, prNumber: identity.prNumber,
          }).then((current) => current.headSha, () => undefined);
          if (currentHeadSha !== undefined && currentHeadSha !== identity.headSha) {
            throw new ReviewSupersededError('completion', identity.headSha, currentHeadSha);
          }
        }
        throw error;
      }
    }
    // REL-1081: log the shadow triage joined with this run's actual findings. Deliberately the
    // last await before returning: the check, evidence, and completion callbacks above are
    // already published, and `join` is bounded by the triage's hard deadline and never throws.
    await jevShadow.join({
      findings,
      personas: Array.isArray(panelResult.personas) ? panelResult.personas : [],
      applicablePersonaIds: Array.isArray(panelResult.applicablePersonaIds) ? panelResult.applicablePersonaIds : [],
      mode: coverage.mode,
      verdict,
      conclusion,
    });
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
      // REL-1113: an infrastructure-incomplete run has no verdict; never report its canonical
      // BLOCK (derived only from the missing lane) as one.
      verdict: infrastructureIncomplete ? 'INCOMPLETE' : verdict,
      conclusion: authoritativeInfrastructureResult ? 'failure' : conclusion,
      findingCount: findings.length,
      blockingFindingCount: blocking.length,
      failureClass: recoverablePanelFailure
        ?? (authoritativeInfrastructureResult ? (incompleteLanes[0]?.failureClass as WorkerTerminalFailure['failureClass'] | undefined) ?? 'transport' : null),
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
        ...(typeof panelWallClockMs === 'number' ? { panelWallClockMs } : {}),
      },
    };
    } finally {
      jevShadow.abort();
      panelDeadline.cleanup();
      // Bounded by the shadow run's own deadline (already elapsed on every path that reached
      // evidence-building above, where it is awaited explicitly -- this is a no-op there). On an
      // early throw or a `recoverablePanelFailure` return (which skips evidence-building
      // entirely), this is what stops an in-flight composed call from outliving the job with its
      // deadline timer disarmed underneath it: `cleanup()` only clears the timer, it does not
      // abort the run, so the wait must happen before it.
      if (shadowDeadline) {
        await shadowOutcomePromise.catch(() => undefined);
        shadowDeadline.cleanup();
      }
      // One shared deletion contract (async, fail-soft) — the worker must not
      // hand-roll its own rm for the scratch tree.
      await removeScratchTree(zoektScratchRoot.scratchDir);
    }
  } catch (error) {
    // REL-1057: the run-status poller is the service's own verdict that this
    // run is no longer current; whatever the panel threw on the way out, the
    // outcome is a supersession, not a failure.
    let outcome = !isReviewSuperseded(error) && deps.isCurrentHead && !deps.isCurrentHead()
      ? new ReviewSupersededError('during_review', identity.headSha)
      : error;
    // REL-1093: the operator cancels a superseded run by deleting its worker
    // Job, so the pod only sees SIGTERM (the root signal aborts and the panel
    // throws "review panel was cancelled"). The worker cannot read the CR's
    // cancelRequested, and a SIGTERM also comes from deadline expiry or node
    // eviction. Tell them apart the same way the completion stage does: one
    // bounded fresh read of the pull request head. Only a head that moved is a
    // supersession; an unchanged head, or a failed/timed-out read, keeps the
    // original failure.
    if (!isReviewSuperseded(outcome) && deps.signal?.aborted) {
      const currentHeadSha = await readCurrentHeadAfterAbort(
        () => (deps.pullRequestIdentityReader || readPullRequestIdentity)({
          token: value(env, 'GH_TOKEN'), repo: identity.repo, prNumber: identity.prNumber,
        }),
        deps.abortHeadReadTimeoutMs ?? ABORTED_RUN_HEAD_READ_TIMEOUT_MS,
      );
      if (currentHeadSha !== undefined && currentHeadSha !== identity.headSha) {
        outcome = new ReviewSupersededError('during_review', identity.headSha, currentHeadSha);
      }
    }
    await reportTerminalFailure(outcome, checkId);
    throw outcome;
  }
}
