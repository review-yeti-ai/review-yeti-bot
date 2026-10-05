import { AUTHORITATIVE_REVIEW_CHECK_NAME } from '../auth/authoritativeServiceIdentity';
import { expectedReviewAppIdFor } from '../auth/repositoryReviewAuthority';
import { createBoundedGitHubJsonClient, type GitHubJsonClient } from '../github/boundedGitHubJson';
import { logger } from '../utils/logger';
import type { AuthoritativeReviewAdmission } from './authoritativeServiceContracts';
import { deriveReviewRunId } from './reviewAdmission';
import { deriveReviewGateExternalId, REVIEW_GATE_CHECK_NAME } from './reviewCheckIdentity';

/** Machine-readable marker carried by every passthrough check, in the external id and the summary. */
export const PASSTHROUGH_REVIEW_MODE_MARKER = 'review-mode=passthrough';
const PASSTHROUGH_EXTERNAL_ID_PREFIX = 'review-yeti-passthrough:v1:';
const PASSTHROUGH_NOTICE = 'passthrough: no review performed';
const MAX_CHECK_PAGES = 5;
const CHECK_PAGE_SIZE = 100;

export interface PassthroughShipRequest {
  owner: string;
  repo: string;
  repositoryId: number;
  prNumber: number;
  headSha: string;
  baseSha?: string;
}

export type PassthroughShipResult =
  | { status: 'published'; checkId: number; gateCheckId?: number; reviewMode: 'passthrough' }
  | { status: 'already_published'; checkId: number; gateCheckId?: number; reviewMode: 'passthrough' }
  | { status: 'skipped'; reason: 'pull_request_not_open' | 'pull_request_draft' | 'stale_head'
    | 'repository_mismatch' | 'existing_review_evidence' };

export interface PassthroughMergeGroupRequest {
  owner: string;
  repo: string;
  repositoryId: number;
  /** The merge-queue commit the required check is read from. */
  headSha: string;
}

export type PassthroughMergeGroupResult =
  | { status: 'published' | 'already_published'; checkId: number; reviewMode: 'passthrough' }
  | { status: 'skipped'; reason: 'existing_review_evidence' };

export interface PassthroughShipPublisher {
  publish(request: PassthroughShipRequest): Promise<PassthroughShipResult>;
  /** Merge-queue commit: the queue's required check must exist there too, or a passthrough PR stalls in the queue. */
  publishMergeGroup(request: PassthroughMergeGroupRequest): Promise<PassthroughMergeGroupResult>;
}

export interface PassthroughShipPublisherOptions {
  /** Repository-scoped installation token: `read` (pull requests) or `publish` (checks:write). */
  tokenFor(owner: string, repo: string, mode: 'read' | 'publish'): Promise<string>;
  /** When the repository is authoritative, the paired service-owned Gate is posted too. */
  authoritativePublishing?: AuthoritativeReviewAdmission;
  /** App id that owns the raw check when no authoritative admission applies. */
  appId: number;
  baseUrl?: string;
  fetchImplementation?: typeof fetch;
  githubClientFor?(token: string): GitHubJsonClient;
  now?: () => number;
}

function rawExternalId(repositoryId: number, headSha: string): string {
  return `${PASSTHROUGH_EXTERNAL_ID_PREFIX}${repositoryId}:${headSha}`;
}

function isOfficialCheck(run: any, name: string, appId: number): boolean {
  return run?.name === name && Number(run?.app?.id) === appId;
}

async function listHeadChecks(client: GitHubJsonClient, owner: string, repo: string, headSha: string): Promise<any[]> {
  const runs: any[] = [];
  for (let page = 1; page <= MAX_CHECK_PAGES; page += 1) {
    const result = await client.request(
      `/repos/${owner}/${repo}/commits/${encodeURIComponent(headSha)}/check-runs?filter=all&per_page=${CHECK_PAGE_SIZE}&page=${page}`);
    if (!Array.isArray(result?.check_runs)) throw new Error('check-run lookup response is not a list');
    runs.push(...result.check_runs);
    if (result.check_runs.length < CHECK_PAGE_SIZE) return runs;
  }
  throw new Error('check-run lookup exceeded bounded pagination');
}

function outputFor(kind: 'raw' | 'gate', headSha: string) {
  const subject = kind === 'raw' ? 'Review Yeti' : 'Review Yeti Gate';
  return {
    title: kind === 'raw'
      ? `Review Yeti: SHIP (${PASSTHROUGH_NOTICE})`
      : `Review Yeti Gate: Approved (${PASSTHROUGH_NOTICE})`,
    summary: [
      `### ${subject}: SHIP (${PASSTHROUGH_NOTICE})`,
      `- **Verdict**: \`SHIP\` at \`${headSha}\` (${PASSTHROUGH_NOTICE}).`,
      `- **Mode**: \`${PASSTHROUGH_REVIEW_MODE_MARKER}\``,
      'The operator enabled global passthrough, so no persona panel, provider call or finding analysis ran for this head. '
        + 'This check is a service-owned pass-through acknowledgement, not review evidence. '
        + 'It never overrides existing review evidence on the same head.',
    ].join('\n'),
  };
}

/**
 * Operator-owned passthrough keeps the pull-request flow moving while reviews
 * are paused: the service itself posts the official check as SHIP and says so.
 * It is idempotent per head, never runs for draft or stale pull requests, and
 * never supersedes a genuine review that already exists on the head.
 */
export function createPassthroughShipPublisher(options: PassthroughShipPublisherOptions): PassthroughShipPublisher {
  const now = options.now ?? Date.now;
  return {
    async publishMergeGroup(request: PassthroughMergeGroupRequest): Promise<PassthroughMergeGroupResult> {
      const { owner, repo, repositoryId, headSha } = request;
      const authoritative = options.authoritativePublishing;
      const appId = authoritative?.repositoryIds.includes(repositoryId)
        ? expectedReviewAppIdFor(authoritative, { repositoryId, owner, repo }) : options.appId;
      const token = await options.tokenFor(owner, repo, 'publish');
      const client = options.githubClientFor?.(token) ?? createBoundedGitHubJsonClient({
        token, baseUrl: options.baseUrl, fetchImplementation: options.fetchImplementation,
      });
      // Same canonical identity the merge-group gate itself publishes, so the queue's reader accepts it.
      const externalId = `review-yeti-merge-group:${repositoryId}:${headSha}`;
      const runs = (await listHeadChecks(client, owner, repo, headSha))
        .filter((run) => isOfficialCheck(run, AUTHORITATIVE_REVIEW_CHECK_NAME, appId) && run.head_sha === headSha);
      if (runs.some((run) => run.external_id !== externalId)) {
        return { status: 'skipped', reason: 'existing_review_evidence' };
      }
      const done = runs.find((run) => run.status === 'completed' && run.conclusion === 'success');
      if (done) return { status: 'already_published', checkId: Number(done.id), reviewMode: 'passthrough' };
      const body = {
        status: 'completed', conclusion: 'success', completed_at: new Date(now()).toISOString(),
        output: outputFor('raw', headSha),
      };
      const open = runs.find((run) => run.status !== 'completed');
      if (open) {
        await client.request(`/repos/${owner}/${repo}/check-runs/${Number(open.id)}`, {
          method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        });
        return { status: 'published', checkId: Number(open.id), reviewMode: 'passthrough' };
      }
      const created = await client.request(`/repos/${owner}/${repo}/check-runs`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
          name: AUTHORITATIVE_REVIEW_CHECK_NAME, head_sha: headSha, external_id: externalId, ...body,
        }),
      });
      if (!Number.isSafeInteger(Number(created?.id)) || Number(created.id) < 1) {
        throw new Error('passthrough merge-group check creation returned no id');
      }
      logger.info('Review Yeti passthrough posted service-owned SHIP merge-group check', {
        reviewMode: 'passthrough', repositoryId, headSha, checkId: Number(created.id),
      });
      return { status: 'published', checkId: Number(created.id), reviewMode: 'passthrough' };
    },

    async publish(request: PassthroughShipRequest): Promise<PassthroughShipResult> {
      const { owner, repo, repositoryId, prNumber, headSha } = request;
      const clientFor = async (mode: 'read' | 'publish'): Promise<GitHubJsonClient> => {
        const token = await options.tokenFor(owner, repo, mode);
        return options.githubClientFor?.(token) ?? createBoundedGitHubJsonClient({
          token, baseUrl: options.baseUrl, fetchImplementation: options.fetchImplementation,
        });
      };

      // Draft rule and freshness come from GitHub, not from the trigger payload.
      const pull = await (await clientFor('read')).request(`/repos/${owner}/${repo}/pulls/${prNumber}`);
      if (pull?.state !== 'open') return { status: 'skipped', reason: 'pull_request_not_open' };
      if (pull?.draft !== false) return { status: 'skipped', reason: 'pull_request_draft' };
      if (String(pull?.head?.sha ?? '').toLowerCase() !== headSha) return { status: 'skipped', reason: 'stale_head' };
      if (Number(pull?.base?.repo?.id) !== repositoryId) return { status: 'skipped', reason: 'repository_mismatch' };
      const baseSha = String(pull?.base?.sha ?? request.baseSha ?? '');

      const authoritative = options.authoritativePublishing;
      const authoritativeRepository = authoritative !== undefined
        && authoritative.repositoryIds.includes(repositoryId);
      const requested = { repositoryId, owner, repo, prNumber, headSha, baseSha };
      const appId = authoritativeRepository ? expectedReviewAppIdFor(authoritative!, requested) : options.appId;
      // Read-only resolution first: nothing is posted when the Gate cannot be bound.
      const resolved = authoritativeRepository ? await authoritative!.resolver.resolve(requested) : undefined;
      const runId = resolved ? deriveReviewRunId(resolved.identity) : undefined;
      const gateCoordinates = resolved && runId ? {
        owner, repo, repositoryId, prNumber, headSha, baseSha,
        policyDigest: resolved.prepared.policy.effectivePolicyDigest,
        runId,
        // Distinct from every real attempt id so a later genuine review never reuses this Gate identity.
        attemptId: `${runId}-passthrough`,
        executionAttempt: 1,
      } : undefined;

      const client = await clientFor('publish');
      const existing = await listHeadChecks(client, owner, repo, headSha);
      const rawRuns = existing.filter((run) => isOfficialCheck(run, AUTHORITATIVE_REVIEW_CHECK_NAME, appId)
        && run.head_sha === headSha);
      const rawId = rawExternalId(repositoryId, headSha);
      if (rawRuns.some((run) => run.external_id !== rawId)) {
        return { status: 'skipped', reason: 'existing_review_evidence' };
      }
      const gateRuns = gateCoordinates
        ? existing.filter((run) => isOfficialCheck(run, REVIEW_GATE_CHECK_NAME, appId) && run.head_sha === headSha)
        : [];
      const gateId = gateCoordinates ? deriveReviewGateExternalId(gateCoordinates) : undefined;
      if (gateRuns.some((run) => run.external_id !== gateId)) {
        return { status: 'skipped', reason: 'existing_review_evidence' };
      }

      const ensure = async (kind: 'raw' | 'gate', runs: any[], externalId: string): Promise<{ id: number; created: boolean }> => {
        const done = runs.find((run) => run.status === 'completed' && run.conclusion === 'success');
        if (done) return { id: Number(done.id), created: false };
        const body = {
          status: 'completed', conclusion: 'success', completed_at: new Date(now()).toISOString(),
          output: outputFor(kind, headSha),
        };
        const open = runs.find((run) => run.status !== 'completed');
        if (open) {
          await client.request(`/repos/${owner}/${repo}/check-runs/${Number(open.id)}`, {
            method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
          });
          return { id: Number(open.id), created: true };
        }
        const created = await client.request(`/repos/${owner}/${repo}/check-runs`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
            name: kind === 'raw' ? AUTHORITATIVE_REVIEW_CHECK_NAME : REVIEW_GATE_CHECK_NAME,
            head_sha: headSha, external_id: externalId, ...body,
          }),
        });
        if (!Number.isSafeInteger(Number(created?.id)) || Number(created.id) < 1) {
          throw new Error('passthrough check creation returned no id');
        }
        return { id: Number(created.id), created: true };
      };

      const raw = await ensure('raw', rawRuns, rawId);
      const gate = gateId ? await ensure('gate', gateRuns, gateId) : undefined;
      const created = raw.created || gate?.created === true;
      logger.info('Review Yeti passthrough posted service-owned SHIP check', {
        reviewMode: 'passthrough', repositoryId, prNumber, headSha, checkId: raw.id,
        ...(gate ? { gateCheckId: gate.id } : {}), created,
      });
      return {
        status: created ? 'published' : 'already_published', checkId: raw.id,
        ...(gate ? { gateCheckId: gate.id } : {}), reviewMode: 'passthrough',
      };
    },
  };
}
