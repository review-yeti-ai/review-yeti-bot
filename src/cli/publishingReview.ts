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
import { executePersonaPanel } from '../panel/panelEngine';
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
import { createDefaultV3Config } from '../config/configLoader';
import type { ProviderId } from '../config/schema';
import { resolveWorkerConfig } from '../config/publishingWorkerConfig';
import { loadSameHeadReviewSource } from '../github/qualificationReader';
import { computeArbitration } from '../review/reviewCore';
import { validateWorkerCompletionEndpoint, type WorkerCompletionAdapter, type WorkerTerminalFailure } from '../review/workerCompletion';
import { logger } from '../utils/logger';
import { loadCompiledIndex, defaultDomainsDir, type CompiledDomainIndex } from '../pipeline/domainIndex';
import { parsePreparedReviewExecution } from '../review/preparedPublishingPolicy';
import { parseWorkerReviewCompletion, type WorkerReviewResult } from '../review/workerReviewCompletion';
import type { WorkerReviewCompletionAdapter } from '../review/workerReviewCompletionHttp';

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
export function bifrostTransport(env: NodeJS.ProcessEnv): { baseUrl: string; apiKey: string; model: string } {
  const baseUrl = value(env, 'BIFROST_BASE_URL');
  const apiKey = value(env, 'BIFROST_PR_REVIEW_API_KEY');
  const model = value(env, 'REVIEW_MODEL');
  if (!baseUrl || !apiKey || !model) throw invalidPublishingReviewContract();
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw invalidPublishingReviewContract();
  }
  // A plaintext or non-gateway base URL would ship diffs off the intended path.
  if (parsed.protocol !== 'https:') throw invalidPublishingReviewContract();
  return { baseUrl, apiKey, model };
}

/**
 * The publishing worker is admitted with a single Bifrost transport. It must
 * not fall back to the legacy default config, whose synthetic/claude providers
 * are unavailable in the production gateway. Keep every persona, moderator,
 * and arbiter call on the operator-injected model and fail closed on provider
 * errors instead of attempting an undeclared route.
 */
export function createBifrostPublishingConfig(model: string): ReturnType<typeof createDefaultV3Config> {
  const providerId = 'bifrost';
  const config = createDefaultV3Config();
  return {
    ...config,
    personas: config.personas.map((persona) => ({ ...persona, providers: [providerId] })),
    reviewers: {
      ...config.reviewers,
      fallback: 'none',
      providers: [{
        id: providerId,
        enabled: true,
        model,
        effort: 'medium',
        review_timeout_s: 90,
        arbiter_timeout_s: 90,
      }],
      arbiter: { order: [providerId] },
    },
  };
}

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
  if (/timeout|timed out|ETIMEDOUT|exceeded (?:the )?(?:total )?deadline/iu.test(message)) return 'timeout';
  if (/budget exhausted|incomplete/iu.test(message)) return 'budget_exhausted';
  if (/401|403|unauthor|virtual key/iu.test(message)) return 'auth';
  if (/429|rate limit/iu.test(message)) return 'rate_limit';
  if (/ENOTFOUND|ECONNREFUSED|EAI_AGAIN|fetch failed/iu.test(message)) return 'transport';
  if (/invalid (?:native )?JSON|invalid findings contract|invalid .*response contract|cannot contain findings|requires at least one finding|nonce-fenced structured output/iu.test(message)) {
    return 'malformed_output';
  }
  if (/provider|gateway|model/iu.test(message)) return 'provider_error';
  return 'internal_error';
}

export interface PublishingReviewDeps {
  checkClient: PublishingCheckClient;
  /** Reports a terminal worker failure without carrying provider error text. */
  completion?: WorkerCompletionAdapter;
  reviewCompletion?: WorkerReviewCompletionAdapter;
  sourceLoader?: typeof loadSameHeadReviewSource;
  /** Resolves the repository's visibility with the run's own read token. Injectable for tests. */
  visibilityLookup?: (input: { owner: string; repo: string; token: string }) => Promise<RepositoryVisibility>;
  panelRunner?: typeof executePersonaPanel;
  client?: ReviewModelClient;
  now?: () => number;
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

export async function runPublishingReviewWorker(
  env: NodeJS.ProcessEnv,
  deps: PublishingReviewDeps,
): Promise<PublishingReviewReceipt> {
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

  const reportTerminalFailure = async (error: unknown, failedCheckId?: number): Promise<void> => {
    const failureClass = classifyFailure(error);
    if (authoritative && !authoritativeCompletionAttempted) {
      try {
        await reportReviewResult({ version: 'WorkerReviewResult.v1', completedAt: new Date(now()).toISOString(),
          personas: preparedPersonaIds.map((id) => ({ id, decision: 'ERROR', status: 'ERROR', errorClass: failureClass, findings: [] })),
          coverageComplete: false, quorumSatisfied: false });
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
          summary: `Failure class \`${failureClass}\` at \`${identity.headSha}\`. This is a failed review, not an approval.`,
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
    const transport = bifrostTransport(env);
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
    const panelResult = await panelRunner({
      config: workerConfig,
      changedFiles,
      repository: identity.repo,
      headSha: identity.headSha,
      baseSha: identity.baseSha,
      prNumber: identity.prNumber,
      repositoryVisibility,
      client,
      jobId: identity.runId,
    } as Parameters<typeof executePersonaPanel>[0]);

    const rawFindings = (panelResult.personas || []).flatMap((persona: { findings?: unknown[] }) => persona.findings || []);
    // The model arbiter is evidence, not the policy boundary. The canonical
    // review policy treats P2 findings as advisory; trusting a raw FIX_FIRST
    // from the model made the DOKS app gate reject a clean (P0/P1-free) review.
    // Recompute from the exact persona findings and quorum so this lane shares
    // the same fail-closed severity contract as the hosted review path.
    const canonical = computeArbitration(panelResult.personas, panelResult.personas.length, {
      changedFiles,
      coverageComplete: panelResult?.quorum ? panelResult.quorum.satisfied : true,
    });
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
      };
    });

    const totalPromptTokens = personaMetrics.reduce((sum, p) => sum + p.promptTokens, 0);
    const totalCompletionTokens = personaMetrics.reduce((sum, p) => sum + p.completionTokens, 0);
    const totalTokens = personaMetrics.reduce((sum, p) => sum + p.totalTokens, 0);
    const totalTurns = personaMetrics.reduce((sum, p) => sum + p.turnsCount, 0);
    const totalToolCalls = personaMetrics.reduce((sum, p) => sum + p.toolCallsCount, 0);
    const totalDurationMs = personaMetrics.reduce((sum, p) => sum + p.durationMs, 0);

    // A count with nothing attached is not reviewable. Until now the check
    // published only a title and a summary, so a run could report four blocking
    // findings while the pull request carried no comment, no review and no
    // annotation -- nothing an author could act on. Both fields below need only
    // `checks: write`, so the findings become visible without widening the
    const changedPaths = new Set(changedFiles.map((file) => file.path));
    const isFastShip = isFastShipPanelResult(panelResult);

    const title = isFastShip
      ? 'Review Yeti: SHIP (fast-ship)'
      : `Review Yeti: ${verdict}`;

    const safeClassifierRationale = isFastShip && panelResult.classifierRationale
      ? panelResult.classifierRationale.replace(/[`<>\r\n]/gu, ' ').trim().slice(0, 500)
      : 'Approved via fast-ship triage classifier.';

    const summaryParts = isFastShip
      ? [
          `### Review Yeti: SHIP (fast-ship)`,
          `- **Verdict**: \`SHIP\` at \`${identity.headSha}\` (fast-ship auto-approved without multi-persona panel).`,
          `- **Classifier Rationale**: \`${safeClassifierRationale}\``,
          `- **Token Savings**: Estimated ~${panelResult.tokensSaved.toLocaleString()} tokens saved by bypassing full panel evaluation.`,
          `Transport: bifrost \`${transport.model}\`.`,
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
          `Transport: bifrost \`${transport.model}\`.`,
          `Repository visibility: ${repositoryVisibility}.`,
          `Telemetry: ${totalTurns} turns, ${totalToolCalls} tool calls, ${totalTokens} tokens across ${personaMetrics.length} lanes (${totalDurationMs}ms).`,
        ];

    await deps.checkClient.completeCheck({
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
    if (authoritative) {
      const findingKeys = new Set(['severity', 'path', 'line', 'startLine', 'title', 'body', 'suggestion',
        'replacementCode', 'confidence', 'recommendation', 'fixOptions', 'isArchitectural']);
      const personas = panelResult.personas.map((persona) => ({ id: persona.id, decision: persona.decision,
        status: 'COMPLETE' as const,
        findings: persona.findings.map((finding) => Object.fromEntries(
          Object.entries(finding).filter(([key, value]) => findingKeys.has(key) && value !== undefined))),
      }));
      const errors = (panelResult.optionalFailures || []).map((failure) => ({ id: failure.id,
        decision: 'ERROR' as const, status: 'ERROR' as const, findings: [], errorClass: classifyFailure(failure.error) }));
      const result = parseWorkerReviewCompletion({ version: 'WorkerReviewCompletion.v1',
        runId: identity.runId, repositoryId: identity.repositoryId, owner: identity.owner, repo: identity.repoName,
        prNumber: identity.prNumber, headSha: identity.headSha, baseSha: identity.baseSha,
        policyDigest: value(env, 'REVIEW_POLICY_DIGEST'), configDigest: value(env, 'REVIEW_CONFIG_DIGEST'),
        executionAttempt: identity.executionAttempt,
        result: { version: 'WorkerReviewResult.v1', completedAt, personas: [...personas, ...errors],
          coverageComplete: unreadable.length === 0, quorumSatisfied: panelResult.quorum?.satisfied === true },
      }).result;
      await reportReviewResult(result);
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
      failureClass: null,
      startedAt,
      completedAt,
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
  } catch (error) {
    await reportTerminalFailure(error, checkId);
    throw error;
  }
}
