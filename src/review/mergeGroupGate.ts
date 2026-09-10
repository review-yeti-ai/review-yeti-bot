import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AUTHORITATIVE_REVIEW_APP_ID, AUTHORITATIVE_REVIEW_APP_SLUG, AUTHORITATIVE_REVIEW_CHECK_NAME,
} from '../auth/authoritativeServiceConfig';
import type { GitHubWebhookConfig } from '../auth/githubWebhookConfig';
import type { MergeGroupGateRepository, MergeGroupGateState } from '../persistence/mergeGroupGateRepository';
import { createBoundedGitHubJsonClient, type GitHubJsonClient } from '../github/boundedGitHubJson';
import {
  githubWebhookRepositorySchema, requireEnrolledGitHubWebhookRepository, UnenrolledGitHubWebhookIdentityError,
} from '../auth/githubWebhookIdentity';

const sha = z.string().regex(/^[a-f0-9]{40}$/u);
const positiveInteger = z.number().int().positive().safe();
const mergeGroupWebhook = z.object({
  action: z.literal('checks_requested'),
  installation: z.object({ id: positiveInteger }).passthrough(),
  repository: githubWebhookRepositorySchema,
  merge_group: z.object({
    head_sha: sha, head_ref: z.string().min(1).max(512),
    base_sha: sha, base_ref: z.string().min(1).max(512),
  }).passthrough(),
}).passthrough();

const QUEUE_QUERY = 'query($owner:String!,$name:String!,$branch:String!){repository(owner:$owner,name:$name){mergeQueue(branch:$branch){id entries(first:100){totalCount nodes{position state baseCommit{oid} headCommit{oid} pullRequest{number state baseRefName headRefOid repository{nameWithOwner}}} pageInfo{hasNextPage}}}}}';
const QUALIFYING_STATES = new Set(['QUEUED', 'AWAITING_CHECKS', 'LOCKED', 'MERGEABLE']);
const CHECK_LOOKUP_CONCURRENCY = 5;

interface QueueEntry {
  position: number;
  state: string;
  pullRequest: {
    number: number;
    state: string;
    baseRefName: string;
    headRefOid: string;
    repository: { nameWithOwner: string };
  };
}

interface QueueEvidence { id: string; entries: QueueEntry[]; }

export interface MergeGroupGateOptions {
  config: GitHubWebhookConfig;
  repository: MergeGroupGateRepository;
  tokenFor(owner: string, repo: string): Promise<string>;
  fetchImplementation?: typeof fetch;
  baseUrl?: string;
  githubClientFor?(token: string): GitHubJsonClient;
}

async function mapConcurrent<T, U>(items: readonly T[], concurrency: number, operation: (item: T) => Promise<U>): Promise<U[]> {
  const results = new Array<U>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await operation(items[index]);
    }
  }));
  return results;
}

function branchName(ref: string): string { return ref.replace(/^refs\/heads\//u, ''); }

function validatePayload(value: unknown, config: GitHubWebhookConfig) {
  const parsed = mergeGroupWebhook.parse(value);
  const { owner, repo } = requireEnrolledGitHubWebhookRepository(parsed.repository, config);
  const branch = branchName(parsed.merge_group.base_ref);
  const prefix = `refs/heads/gh-readonly-queue/${branch}/`;
  const match = parsed.merge_group.head_ref.startsWith(prefix)
    ? /^pr-([1-9][0-9]*)-[0-9a-f]{7,40}$/u.exec(parsed.merge_group.head_ref.slice(prefix.length)) : null;
  if (!branch || !match) {
    throw new UnenrolledGitHubWebhookIdentityError();
  }
  return { ...parsed, owner, repo, branch, currentNumber: Number(match[1]) };
}

function selectEntries(response: any, identity: ReturnType<typeof validatePayload>): QueueEvidence {
  if (Array.isArray(response?.errors) && response.errors.length > 0) throw new Error('Merge queue lookup returned errors');
  const queue = response?.data?.repository?.mergeQueue;
  if (!queue || typeof queue.id !== 'string' || !Array.isArray(queue.entries?.nodes)
    || queue.entries.pageInfo?.hasNextPage !== false
    || !Number.isSafeInteger(queue.entries.totalCount)
    || queue.entries.totalCount !== queue.entries.nodes.length
    || queue.entries.totalCount < 1 || queue.entries.totalCount > 100) {
    throw new Error('Merge queue evidence is incomplete');
  }
  const numbers = new Set<number>();
  const positions = new Set<number>();
  for (const entry of queue.entries.nodes) {
    const number = entry?.pullRequest?.number;
    if (!Number.isSafeInteger(number) || number < 1 || numbers.has(number)
      || !Number.isSafeInteger(entry?.position) || entry.position < 1 || positions.has(entry.position)) {
      throw new Error('Merge queue entries are malformed');
    }
    numbers.add(number); positions.add(entry.position);
  }
  const current = queue.entries.nodes.find((entry: any) => entry.pullRequest.number === identity.currentNumber);
  if (!current || current.headCommit?.oid !== identity.merge_group.head_sha
    || current.baseCommit?.oid !== identity.merge_group.base_sha) throw new Error('Merge queue no longer matches the webhook');
  const entries = queue.entries.nodes.filter((entry: any) => entry.position <= current.position)
    .sort((left: any, right: any) => left.position - right.position);
  for (const entry of entries) {
    const pull = entry.pullRequest;
    if (!sha.safeParse(pull?.headRefOid).success || !QUALIFYING_STATES.has(entry.state)
      || pull.state !== 'OPEN' || pull.baseRefName !== identity.branch
      || pull.repository?.nameWithOwner !== identity.repository.full_name) {
      throw new Error('Merge queue contains an ineligible constituent');
    }
  }
  return { id: queue.id, entries: entries as QueueEntry[] };
}

function isOfficialReviewCheck(run: any): boolean {
  return run?.name === AUTHORITATIVE_REVIEW_CHECK_NAME
    && Number(run?.app?.id) === AUTHORITATIVE_REVIEW_APP_ID
    && run?.app?.slug === AUTHORITATIVE_REVIEW_APP_SLUG;
}

function exactReviewFailure(checks: any, expectedHead: string): string | undefined {
  if (!Number.isSafeInteger(checks?.total_count) || !Array.isArray(checks?.check_runs)
    || checks.total_count !== checks.check_runs.length || checks.total_count > 100) return 'check-run evidence is incomplete';
  const runs = checks.check_runs.filter(isOfficialReviewCheck);
  if (runs.length === 0) return 'has no Review Yeti check from the official App';
  if (runs.some((run: any) => run.head_sha !== expectedHead || !Number.isSafeInteger(Number(run.id)) || Number(run.id) < 1)) {
    return 'contains malformed or stale Review Yeti evidence';
  }
  const latest = [...runs].sort((left, right) => Number(left.id) - Number(right.id)).at(-1);
  return latest?.status === 'completed' && latest?.conclusion === 'success'
    ? undefined : 'latest exact-head Review Yeti check is not successful';
}

function externalId(repositoryId: number, headSha: string): string {
  return `review-yeti-merge-group:${repositoryId}:${headSha}`;
}

export class MergeGroupGateInProgressError extends Error {
  constructor() { super('Merge-group gate verification is already in progress'); }
}

export function createMergeGroupGate(options: MergeGroupGateOptions) {
  return async (payload: unknown): Promise<MergeGroupGateState & { constituents: number }> => {
    const identity = validatePayload(payload, options.config);
    const repositoryName = identity.repository.full_name;
    const repositoryId = identity.repository.id;
    const headSha = identity.merge_group.head_sha;
    const claimToken = randomUUID();
    const claim = await options.repository.claim(repositoryId, headSha, claimToken);
    if (claim.status === 'terminal') return { ...claim.result, constituents: 0 };
    if (claim.status === 'busy') throw new MergeGroupGateInProgressError();
    try {
      const token = await options.tokenFor(identity.owner, identity.repo);
      if (!token.startsWith('ghs_')) throw new Error('Merge-group App token is unavailable');
      const client = options.githubClientFor?.(token) || createBoundedGitHubJsonClient({
        token, baseUrl: options.baseUrl, fetchImplementation: options.fetchImplementation,
      });
      const api = `/repos/${repositoryName}`;
      const existing = await client.request(`${api}/commits/${identity.merge_group.head_sha}/check-runs?filter=all&per_page=100`);
      if (!Number.isSafeInteger(existing?.total_count) || !Array.isArray(existing?.check_runs)
        || existing.total_count !== existing.check_runs.length || existing.total_count > 100) {
        throw new Error('Merge-group check reconciliation is incomplete');
      }
      const stableId = externalId(identity.repository.id, identity.merge_group.head_sha);
      const candidates = existing.check_runs.filter((run: any) => isOfficialReviewCheck(run)
        && run?.head_sha === identity.merge_group.head_sha && run?.external_id === stableId);
      let check = [...candidates].sort((left, right) => Number(left.id) - Number(right.id)).at(-1);
      if (check?.status === 'completed' && (check.conclusion === 'success' || check.conclusion === 'failure')) {
        const result = { checkId: Number(check.id), conclusion: check.conclusion } as MergeGroupGateState;
        await options.repository.complete(repositoryId, headSha, claimToken, result);
        return { ...result, constituents: 0 };
      }
      if (!check) {
        check = await client.request(`${api}/check-runs`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
            name: AUTHORITATIVE_REVIEW_CHECK_NAME, head_sha: identity.merge_group.head_sha, external_id: stableId,
            status: 'in_progress', output: {
              title: 'Review Yeti merge-group verification running',
              summary: 'Validating every queued pull request against its latest exact-head Review Yeti verdict.',
            },
          }),
        });
      }
      if (!Number.isSafeInteger(Number(check?.id)) || Number(check.id) < 1) {
        throw new Error('Review Yeti merge-group check creation returned no id');
      }
      const queueRead = async () => selectEntries(await client.request('/graphql', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: QUEUE_QUERY, variables: { owner: identity.owner, name: identity.repo, branch: identity.branch } }),
      }), identity);
      const failures: string[] = [];
      let constituentCount = 0;
      try {
        const queue = await queueRead();
        constituentCount = queue.entries.length;
        const constituentFailures = await mapConcurrent(queue.entries, CHECK_LOOKUP_CONCURRENCY, async (entry) => {
          const head = entry.pullRequest.headRefOid;
          const result = await client.request(`${api}/commits/${head}/check-runs?filter=all&per_page=100`);
          const failure = exactReviewFailure(result, head);
          return failure ? `PR #${entry.pullRequest.number}: ${failure}` : undefined;
        });
        failures.push(...constituentFailures.filter((failure): failure is string => Boolean(failure)));
        const fresh = await queueRead();
        const signature = (value: typeof queue) => JSON.stringify(value.entries.map((entry: any) => ({
          number: entry.pullRequest.number, head: entry.pullRequest.headRefOid, position: entry.position,
        })));
        if (signature(queue) !== signature(fresh)) failures.push('merge queue changed during exact-head qualification');
      } catch {
        failures.push('merge-group evidence could not be verified');
      }
      const conclusion: 'success' | 'failure' = failures.length === 0 ? 'success' : 'failure';
      await client.request(`${api}/check-runs/${Number(check.id)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
          status: 'completed', conclusion, completed_at: new Date().toISOString(), output: {
            title: conclusion === 'success' ? 'Review Yeti merge group approved' : 'Review Yeti merge group rejected',
            summary: conclusion === 'success'
              ? `Every constituent has a successful exact-head Review Yeti check from the official App. Verified ${constituentCount} constituent(s).`
              : failures.slice(0, 12).map((failure) => `- ${failure.slice(0, 500)}`).join('\n').slice(0, 6_000),
          },
        }),
      });
      const result = { checkId: Number(check.id), conclusion };
      await options.repository.complete(repositoryId, headSha, claimToken, result);
      return { ...result, constituents: constituentCount };
    } catch (error) {
      try { await options.repository.release(repositoryId, headSha, claimToken); } catch { /* retry can reclaim the lease */ }
      throw error;
    }
  };
}
