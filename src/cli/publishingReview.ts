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
import { OpenRouterClient } from '../gateway/openRouterClient';
import type { ReviewModelClient } from '../gateway/openRouterClient';
import { createDefaultV3Config } from '../config/configLoader';
import { loadSameHeadReviewSource } from '../github/qualificationReader';
import { logger } from '../utils/logger';

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
}

export interface PublishingCheckClient {
  createCheck(owner: string, repo: string, headSha: string): Promise<number>;
  completeCheck(options: {
    owner: string;
    repo: string;
    checkId: number;
    conclusion: 'success' | 'failure' | 'cancelled';
    title: string;
    summary: string;
  }): Promise<void>;
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

export function publishingReviewIdentity(env: NodeJS.ProcessEnv): PublishingReviewIdentity {
  const runId = value(env, 'REVIEW_RUN_ID');
  const repo = value(env, 'REVIEW_REPO');
  const headSha = value(env, 'REVIEW_HEAD_SHA');
  const baseSha = value(env, 'REVIEW_BASE_SHA');
  const repositoryId = Number(value(env, 'REVIEW_REPOSITORY_ID'));
  const prNumber = Number(value(env, 'REVIEW_PR_NUMBER'));
  if (!RUN_ID.test(runId) || !REPO.test(repo) || !SHA.test(headSha) || !SHA.test(baseSha)
    || !Number.isSafeInteger(repositoryId) || repositoryId <= 0
    || !Number.isSafeInteger(prNumber) || prNumber <= 0) {
    throw invalidPublishingReviewContract();
  }
  const [owner, repoName] = repo.split('/');
  return { runId, repositoryId, repo, owner, repoName, prNumber, headSha, baseSha };
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

export function classifyFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/contract is invalid/iu.test(message)) return 'contract';
  if (/timeout|timed out|ETIMEDOUT/iu.test(message)) return 'timeout';
  if (/401|403|unauthor|virtual key/iu.test(message)) return 'auth';
  if (/429|rate limit/iu.test(message)) return 'rate_limit';
  if (/ENOTFOUND|ECONNREFUSED|EAI_AGAIN|fetch failed/iu.test(message)) return 'transport';
  return 'provider_error';
}

export interface PublishingReviewDeps {
  checkClient: PublishingCheckClient;
  sourceLoader?: typeof loadSameHeadReviewSource;
  panelRunner?: typeof executePersonaPanel;
  client?: ReviewModelClient;
  now?: () => number;
}

export async function runPublishingReviewWorker(
  env: NodeJS.ProcessEnv,
  deps: PublishingReviewDeps,
): Promise<PublishingReviewReceipt> {
  if (!isPublishingReviewWorker(env)) throw invalidPublishingReviewContract();
  const identity = publishingReviewIdentity(env);
  const transport = bifrostTransport(env);
  const now = deps.now || Date.now;
  const startedAt = new Date(now()).toISOString();
  const sourceLoader = deps.sourceLoader || loadSameHeadReviewSource;
  const panelRunner = deps.panelRunner || executePersonaPanel;

  // Created before any provider work so an in-flight run is visible on the head,
  // and so a crash leaves a check this lane owns rather than nothing at all.
  const checkId = await deps.checkClient.createCheck(identity.owner, identity.repoName, identity.headSha);

  try {
    const source = await sourceLoader({
      owner: identity.owner,
      repo: identity.repoName,
      prNumber: identity.prNumber,
      expectedBaseSha: identity.baseSha,
      expectedHeadSha: identity.headSha,
      token: value(env, 'GH_TOKEN'),
    } as Parameters<typeof loadSameHeadReviewSource>[0]);

    const changedFiles = Array.from(
      String(source.diff).matchAll(/diff --git a\/(.*?) b\/(.*?)(?=\ndiff --git|\n$|$)/gs),
    )
      .map((match) => ({ path: (match[2] || match[1] || '').trim(), patch: match[0] }))
      .filter((file) => file.path.length > 0 && file.path !== '/dev/null');
    // An empty changed-file set must not be read as "nothing to review, ship".
    if (changedFiles.length === 0) throw new Error('admitted head produced no reviewable diff');

    const client = deps.client || new OpenRouterClient({ baseUrl: transport.baseUrl, apiKey: transport.apiKey });
    const panelResult = await panelRunner({
      config: createDefaultV3Config(),
      changedFiles,
      repository: identity.repo,
      headSha: identity.headSha,
      client,
      jobId: identity.runId,
    } as Parameters<typeof executePersonaPanel>[0]);

    const findings = (panelResult.personas || []).flatMap((persona: { findings?: unknown[] }) => persona.findings || []);
    const blocking = findings.filter(
      (finding) => BLOCKING_SEVERITIES.has(String((finding as { severity?: unknown })?.severity || 'P2').toUpperCase()),
    );
    const verdict = String(panelResult.arbiter?.verdict || 'BLOCK');
    const conclusion = publishingConclusion(verdict, blocking.length);

    await deps.checkClient.completeCheck({
      owner: identity.owner,
      repo: identity.repoName,
      checkId,
      conclusion,
      title: `Review Yeti: ${verdict}`,
      summary: [
        `Verdict \`${verdict}\` at \`${identity.headSha}\`.`,
        `Findings: ${findings.length} (blocking P0/P1: ${blocking.length}).`,
        `Transport: bifrost \`${transport.model}\`.`,
      ].join('\n\n'),
    });

    const completedAt = new Date(now()).toISOString();
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
    };
  } catch (error) {
    const failureClass = classifyFailure(error);
    // Fail closed: an outage concludes `failure`, never `neutral` or `success`.
    // Publication is best-effort because the check may be unreachable; the
    // rethrow below still fails the Job so the admission deadline can reap it.
    try {
      await deps.checkClient.completeCheck({
        owner: identity.owner,
        repo: identity.repoName,
        checkId,
        conclusion: 'failure',
        title: 'Review Yeti: review did not complete',
        summary: `Failure class \`${failureClass}\` at \`${identity.headSha}\`. This is a failed review, not an approval.`,
      });
    } catch (publishError) {
      logger.error('Failed to publish the fail-closed conclusion', {
        runId: identity.runId,
        failureClass,
        error: publishError instanceof Error ? publishError.message : String(publishError),
      });
    }
    throw error;
  }
}
