import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AUTHORITATIVE_REVIEW_APP_ID, AUTHORITATIVE_REVIEW_APP_SLUG, AUTHORITATIVE_REVIEW_CHECK_NAME,
} from '../auth/authoritativeServiceIdentity';
import {
  deriveOperatorPassthroughExternalId,
  isLegacyOperatorMaintenanceReviewExternalId,
  isOperatorPassthroughReviewExternalId,
  REVIEW_GATE_CHECK_NAME,
  REVIEW_WORKER_CHECK_NAME,
} from './reviewCheckIdentity';
import type { GitHubWebhookConfig } from '../auth/githubWebhookConfig';
import type { MergeGroupGateRepository, MergeGroupGateState } from '../persistence/mergeGroupGateRepository';
import { createBoundedGitHubJsonClient, type GitHubJsonClient } from '../github/boundedGitHubJson';
import {
  githubWebhookRepositorySchema, requireEnrolledGitHubWebhookRepository, UnenrolledGitHubWebhookIdentityError,
} from '../auth/githubWebhookIdentity';
import { canonicalJson, sha256 } from './reviewCore';
import {
  isOperatorPassthroughCheckOutput,
  type OperatorPassthroughAdmissionReceipt,
} from './operatorPassthrough';

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
const OPERATOR_PASSTHROUGH_PUBLICATION_WAIT_MS = 30_000;
const OPERATOR_PASSTHROUGH_PUBLICATION_RECHECK_MS = 1_000;

type MergeGroupOperatorReceipt = Pick<OperatorPassthroughAdmissionReceipt,
  'publicationId' | 'auditDigest' | 'mergeEligible' | 'publicationState' | 'publicationReceiptAvailable'>;

interface QueueEntry {
  position: number;
  state: string;
  baseCommit: { oid: string };
  headCommit: { oid: string };
  pullRequest: {
    number: number;
    state: string;
    baseRefName: string;
    headRefOid: string;
    repository: { nameWithOwner: string };
  };
}

interface QueueEvidence { id: string; entries: QueueEntry[]; snapshot: Record<string, unknown>; }

export interface MergeGroupOperatorAdmission {
  repositoryId: number;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  deliveryId: string;
  deliveryDigest: string;
  queueSnapshotDigest: string;
}

export interface MergeGroupGateOptions {
  config: GitHubWebhookConfig;
  repository: MergeGroupGateRepository;
  tokenFor(owner: string, repo: string): Promise<string>;
  fetchImplementation?: typeof fetch;
  baseUrl?: string;
  githubClientFor?(token: string): GitHubJsonClient;
  ensureOperatorPassthrough?(input: MergeGroupOperatorAdmission): Promise<MergeGroupOperatorReceipt | null>;
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

/** Pure shape and local-enrollment check for pause responses before storage bootstrap. */
export function parseEnrolledMergeGroupWebhookIdentity(value: unknown, config: GitHubWebhookConfig): {
  repositoryId: number; owner: string; repo: string; prNumber: number;
} {
  const identity = validatePayload(value, config);
  return { repositoryId: identity.repository.id, owner: identity.owner, repo: identity.repo,
    prNumber: identity.currentNumber };
}

function selectEntries(response: any, identity: ReturnType<typeof validatePayload>): QueueEvidence {
  if (Array.isArray(response?.errors) && response.errors.length > 0) throw new Error('Merge queue lookup returned errors');
  const queue = response?.data?.repository?.mergeQueue;
  if (!queue || typeof queue.id !== 'string' || queue.id.length < 1 || queue.id.length > 512 || !Array.isArray(queue.entries?.nodes)
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
      || !Number.isSafeInteger(entry?.position) || entry.position < 1 || positions.has(entry.position)
      || !sha.safeParse(entry?.baseCommit?.oid).success || !sha.safeParse(entry?.headCommit?.oid).success) {
      throw new Error('Merge queue entries are malformed');
    }
    numbers.add(number); positions.add(entry.position);
  }
  const orderedPositions = [...positions].sort((left, right) => left - right);
  if (orderedPositions.some((position, index) => position !== index + 1)) {
    throw new Error('Merge queue positions are not contiguous');
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
  const selected = entries as QueueEntry[];
  // Group-scoped snapshot. The group head SHA already pins the exact content of
  // every constituent, and GitHub rebuilds the group (new SHA, new webhook) if a
  // constituent changes. Entries behind the current one, and the position/state
  // of entries ahead, change without any webhook, so binding them made the
  // published receipt go stale with nothing to republish it. Constituents at or
  // ahead of the current entry are still fully verified above and again at
  // completion; the consumer recomputes this exact shape.
  return {
    id: queue.id,
    entries: selected,
    snapshot: {
      version: 'ReviewYetiMergeQueueSnapshot.v1.group',
      repositoryId: identity.repository.id,
      repository: identity.repository.full_name,
      owner: identity.owner,
      repo: identity.repo,
      queueId: queue.id,
      branch: identity.branch,
      headRef: identity.merge_group.head_ref,
      baseRef: identity.merge_group.base_ref,
      groupHeadSha: identity.merge_group.head_sha,
      groupBaseSha: identity.merge_group.base_sha,
      currentPullRequest: identity.currentNumber,
      currentPullRequestHeadRefOid: current.pullRequest.headRefOid,
    },
  };
}

function isOfficialReviewCheck(run: any): boolean {
  return run?.name === AUTHORITATIVE_REVIEW_CHECK_NAME
    && Number(run?.app?.id) === AUTHORITATIVE_REVIEW_APP_ID
    && run?.app?.slug === AUTHORITATIVE_REVIEW_APP_SLUG;
}

function hasDurableOperatorReceiptIdentity(receipt: MergeGroupOperatorReceipt | null | undefined): receipt is MergeGroupOperatorReceipt & {
  publicationId: string; auditDigest: string;
} {
  return receipt?.publicationReceiptAvailable === true
    && typeof receipt.publicationId === 'string' && /^[a-f0-9]{64}$/u.test(receipt.publicationId)
    && typeof receipt.auditDigest === 'string' && /^[a-f0-9]{64}$/u.test(receipt.auditDigest);
}

function isDurableOperatorReceipt(receipt: MergeGroupOperatorReceipt | null | undefined): receipt is MergeGroupOperatorReceipt & {
  publicationId: string; auditDigest: string; mergeEligible: true;
} {
  return receipt?.mergeEligible === true && receipt.publicationState === 'published'
    && hasDurableOperatorReceiptIdentity(receipt);
}

function isPendingDurableOperatorReceipt(receipt: MergeGroupOperatorReceipt | null | undefined): receipt is MergeGroupOperatorReceipt & {
  publicationId: string; auditDigest: string; mergeEligible: false; publicationState: 'pending';
} {
  return receipt?.mergeEligible === false && receipt.publicationState === 'pending'
    && hasDurableOperatorReceiptIdentity(receipt);
}

function terminalOperatorPassthroughFailure(prNumber: number, receipt: MergeGroupOperatorReceipt | null): string {
  if (!receipt) return `PR #${prNumber}: operator SHIP publication is unavailable`;
  if (receipt.publicationState === 'pending') {
    return `PR #${prNumber}: pending operator SHIP publication has no durable receipt`;
  }
  return `PR #${prNumber}: operator SHIP publication reached terminal state ${receipt.publicationState}`;
}

function exactReviewFailure(checks: any, expectedHead: string,
  operatorReceipt?: MergeGroupOperatorReceipt): string | undefined {
  if (!Number.isSafeInteger(checks?.total_count) || !Array.isArray(checks?.check_runs)
    || checks.total_count !== checks.check_runs.length || checks.total_count > 100) return 'check-run evidence is incomplete';
  const runs = checks.check_runs.filter(isOfficialReviewCheck);
  if (runs.length === 0) return 'has no Review Yeti check from the official App';
  if (runs.some((run: any) => run.head_sha !== expectedHead || !Number.isSafeInteger(Number(run.id)) || Number(run.id) < 1)) {
    return 'contains malformed or stale Review Yeti evidence';
  }
  const latest = [...runs].sort((left, right) => Number(left.id) - Number(right.id)).at(-1);
  if (latest?.status !== 'completed' || latest?.conclusion !== 'success') {
    return 'latest exact-head Review Yeti check is not successful';
  }
  if (isLegacyOperatorMaintenanceReviewExternalId(latest.external_id)) {
    return 'legacy operator maintenance SHIP is not current merge-group evidence';
  }
  const latestIsOperatorPassthrough = isOperatorPassthroughReviewExternalId(latest.external_id);
  const allowOperatorPassthrough = operatorReceipt !== undefined;
  const durableOperatorReceipt = isDurableOperatorReceipt(operatorReceipt) ? operatorReceipt : undefined;
  if (allowOperatorPassthrough && !durableOperatorReceipt) {
    return 'current operator SHIP publication is not durably ready';
  }
  const expectedReviewExternalId = durableOperatorReceipt
    ? deriveOperatorPassthroughExternalId(durableOperatorReceipt.publicationId,
      durableOperatorReceipt.auditDigest, REVIEW_WORKER_CHECK_NAME)
    : undefined;
  if (allowOperatorPassthrough && (!latestIsOperatorPassthrough || latest.external_id !== expectedReviewExternalId)) {
    return 'latest exact-head Review Yeti check does not match the current durable operator SHIP publication';
  }
  if (!allowOperatorPassthrough && latestIsOperatorPassthrough) {
    return 'latest exact-head Review Yeti check is not the current operator-passthrough SHIP';
  }
  if (latestIsOperatorPassthrough) {
    const output = latest.output && typeof latest.output === 'object' ? latest.output : {};
    if (!durableOperatorReceipt || latest.external_id !== expectedReviewExternalId
      || !isOperatorPassthroughCheckOutput(output, 'review')) {
      return 'latest Review Yeti check is not an active, exact operator-passthrough SHIP';
    }
    const gates = checks.check_runs.filter((run: any) => run?.name === REVIEW_GATE_CHECK_NAME
      && Number(run?.app?.id) === AUTHORITATIVE_REVIEW_APP_ID && run?.app?.slug === AUTHORITATIVE_REVIEW_APP_SLUG
      && run?.head_sha === expectedHead);
    const gate = [...gates].sort((left: any, right: any) => Number(left.id) - Number(right.id)).at(-1);
    const gateOutput = gate?.output && typeof gate.output === 'object' ? gate.output : {};
    return gate?.status === 'completed' && gate?.conclusion === 'success'
      && gate?.external_id === deriveOperatorPassthroughExternalId(durableOperatorReceipt.publicationId,
        durableOperatorReceipt.auditDigest, REVIEW_GATE_CHECK_NAME)
      && isOperatorPassthroughCheckOutput(gateOutput, 'gate')
      ? undefined : 'paired exact-head Review Yeti Gate passthrough check is not successful';
  }
  return undefined;
}

function snapshotDigest(snapshot: Record<string, unknown>): string {
  return sha256(canonicalJson(snapshot));
}

function externalId(repositoryId: number, headSha: string, queueSnapshotDigest: string): string {
  return `review-yeti-merge-group:v2:${repositoryId}:${headSha}:${queueSnapshotDigest}`;
}

export class MergeGroupGateInProgressError extends Error {
  constructor() { super('Merge-group gate verification is already in progress'); }
}

interface MergeGroupGateDelivery {
  deliveryId: string;
  deliveryDigest: string;
}

function exactMergeGroupCheck(value: any, identity: ReturnType<typeof validatePayload>, external: string): boolean {
  const app = value?.app;
  return Number.isSafeInteger(Number(value?.id)) && Number(value.id) > 0
    && value?.name === AUTHORITATIVE_REVIEW_CHECK_NAME
    && Number(app?.id) === AUTHORITATIVE_REVIEW_APP_ID && app?.slug === AUTHORITATIVE_REVIEW_APP_SLUG
    && value?.head_sha === identity.merge_group.head_sha && value?.external_id === external;
}

export function createMergeGroupGate(options: MergeGroupGateOptions) {
  return async (payload: unknown, delivery?: MergeGroupGateDelivery): Promise<MergeGroupGateState & { constituents: number }> => {
    const identity = validatePayload(payload, options.config);
    const repositoryName = identity.repository.full_name;
    const repositoryId = identity.repository.id;
    const headSha = identity.merge_group.head_sha;
    const token = await options.tokenFor(identity.owner, identity.repo);
    if (!token.startsWith('ghs_')) throw new Error('Merge-group App token is unavailable');
    const client = options.githubClientFor?.(token) || createBoundedGitHubJsonClient({
      token, baseUrl: options.baseUrl, fetchImplementation: options.fetchImplementation,
    });
    const api = `/repos/${repositoryName}`;
    const queueRead = async () => selectEntries(await client.request('/graphql', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: QUEUE_QUERY, variables: { owner: identity.owner, name: identity.repo, branch: identity.branch } }),
    }), identity);

    const bindMode = (snapshot: Record<string, unknown>) => ({
      ...snapshot,
      operatorPassthroughEnabled: options.config.passthroughEnabled === true,
    });
    const boundSnapshotDigest = (snapshot: Record<string, unknown>) => snapshotDigest(bindMode(snapshot));
    let queue = await queueRead();
    let digest = snapshotDigest(bindMode(queue.snapshot));
    let claimToken = randomUUID();
    let claim: Awaited<ReturnType<MergeGroupGateRepository['claim']>> | undefined;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      claimToken = randomUUID();
      claim = await options.repository.claim(repositoryId, headSha, digest, claimToken);
      if (claim.status === 'busy') throw new MergeGroupGateInProgressError();
      if (claim.status === 'acquired') break;
    }
    if (!claim || claim.status !== 'acquired') throw new MergeGroupGateInProgressError();
    try {
      const existing = await client.request(`${api}/commits/${identity.merge_group.head_sha}/check-runs?filter=all&per_page=100`);
      if (!Number.isSafeInteger(existing?.total_count) || !Array.isArray(existing?.check_runs)
        || existing.total_count !== existing.check_runs.length || existing.total_count > 100) {
        throw new Error('Merge-group check reconciliation is incomplete');
      }
      const stableId = externalId(identity.repository.id, identity.merge_group.head_sha, digest);
      // Earlier queue/mode snapshots share this merge-group SHA. Resolve and
      // retire their exact App checks before a newer check may be created, so
      // an uncertain older POST cannot appear later with a higher GitHub ID
      // and leave the current snapshot permanently hidden behind it.
      const priorPublications = await options.repository.listPriorPublications(
        repositoryId, headSha, digest, claimToken);
      for (const prior of priorPublications) {
        const priorExternalId = externalId(repositoryId, headSha, prior.snapshotDigest);
        const matches = existing.check_runs.filter((run: any) => isOfficialReviewCheck(run)
          && run?.head_sha === headSha && run?.external_id === priorExternalId);
        if (matches.length !== 1) {
          throw new Error('An earlier merge-group check is unresolved; current snapshot publication is held');
        }
        const previous = matches[0];
        if (!Number.isSafeInteger(Number(previous.id)) || Number(previous.id) < 1
          || (prior.checkId !== null && Number(previous.id) !== prior.checkId)) {
          throw new Error('An earlier merge-group check identity conflicts with its durable reservation');
        }
        let retired = previous;
        if (previous.status !== 'completed' || previous.conclusion !== 'failure') {
          retired = await client.request(`${api}/check-runs/${Number(previous.id)}`, {
            method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
              status: 'completed', conclusion: 'failure', completed_at: new Date().toISOString(), output: {
                title: 'Review Yeti merge-group snapshot superseded',
                summary: 'This exact queue snapshot was superseded and no longer authorizes a merge.',
              },
            }),
          });
        }
        if (!exactMergeGroupCheck(retired, identity, priorExternalId)
          || retired.status !== 'completed' || retired.conclusion !== 'failure') {
          throw new Error('An earlier merge-group check could not be safely retired');
        }
        await options.repository.settlePriorPublication(repositoryId, headSha, digest, claimToken,
          prior.snapshotDigest, Number(retired.id));
      }
      const candidates = existing.check_runs.filter((run: any) => isOfficialReviewCheck(run)
        && run?.head_sha === identity.merge_group.head_sha && run?.external_id === stableId);
      if (candidates.length > 1) throw new Error('Review Yeti merge-group check identity is duplicated');
      let check = [...candidates].sort((left, right) => Number(left.id) - Number(right.id)).at(-1);
      if (!check) {
        const mayCreate = await options.repository.reserveCheckCreation(repositoryId, headSha, digest, claimToken);
        if (!mayCreate) {
          throw new Error('Review Yeti merge-group check creation is uncertain and awaits exact reconciliation');
        }
        check = await client.request(`${api}/check-runs`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
            name: AUTHORITATIVE_REVIEW_CHECK_NAME, head_sha: identity.merge_group.head_sha, external_id: stableId,
            status: 'in_progress', output: {
              title: 'Review Yeti merge-group verification running',
              summary: 'Validating every queued pull request against its latest exact-head Review Yeti verdict.',
            },
          }),
        });
        if (!exactMergeGroupCheck(check, identity, stableId) || check.status !== 'in_progress' || check.conclusion !== null) {
          throw new Error('Review Yeti merge-group check creation identity did not match the current queue snapshot');
        }
      } else {
        await options.repository.bindCheck(repositoryId, headSha, digest, claimToken, Number(check.id));
        // A prior terminal success for this snapshot is not fresh evidence:
        // constituent checks or their paired Gate may have changed since the
        // previous queue event. Reopen this exact durable identity before
        // qualification so its old success cannot authorize a merge in flight.
        check = await client.request(`${api}/check-runs/${Number(check.id)}`, {
          method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
            status: 'in_progress', conclusion: null, output: { title: 'Review Yeti merge-group verification running',
              summary: 'Binding required checks to the exact current ordered merge-queue snapshot.' },
          }),
        });
      }
      if (!exactMergeGroupCheck(check, identity, stableId)) throw new Error('Review Yeti merge-group check identity did not match the current queue snapshot');
      if (check.status !== 'in_progress' || check.conclusion !== null) {
        throw new Error('Review Yeti merge-group check could not be invalidated before requalification');
      }
      if (candidates.length === 0) {
        await options.repository.bindCheck(repositoryId, headSha, digest, claimToken, Number(check.id));
      }
      const failures: string[] = [];
      const constituentCount = queue.entries.length;
      try {
        const constituentFailures = await mapConcurrent(queue.entries, CHECK_LOOKUP_CONCURRENCY, async (entry) => {
          const head = entry.pullRequest.headRefOid;
          if (options.config.passthroughEnabled === true) {
            if (!delivery || !options.ensureOperatorPassthrough) {
              return `PR #${entry.pullRequest.number}: operator SHIP publication is unavailable`;
            }
            const itemDigest = sha256(canonicalJson({ version: 'MergeGroupOperatorAdmission.v1',
              deliveryDigest: delivery.deliveryDigest, queueSnapshotDigest: digest,
              repositoryId, prNumber: entry.pullRequest.number, headSha: head }));
            const operatorAdmission = { repositoryId, owner: identity.owner, repo: identity.repo,
              prNumber: entry.pullRequest.number, headSha: head, queueSnapshotDigest: digest,
              deliveryId: `github-app:merge-group:${delivery.deliveryId}:${entry.pullRequest.number}:${head}`,
              deliveryDigest: itemDigest };
            const deadlineAt = performance.now() + OPERATOR_PASSTHROUGH_PUBLICATION_WAIT_MS;
            let operatorReceipt = await options.ensureOperatorPassthrough(operatorAdmission);
            const timeoutMessage = `PR #${entry.pullRequest.number}: operator SHIP publication did not become durable within ${OPERATOR_PASSTHROUGH_PUBLICATION_WAIT_MS}ms`;
            if (performance.now() >= deadlineAt) return timeoutMessage;
            while (!isDurableOperatorReceipt(operatorReceipt) && isPendingDurableOperatorReceipt(operatorReceipt)) {
              const remainingMs = deadlineAt - performance.now();
              if (remainingMs <= 0) return timeoutMessage;
              await new Promise<void>((resolve) => setTimeout(resolve,
                Math.min(OPERATOR_PASSTHROUGH_PUBLICATION_RECHECK_MS, remainingMs)));
              if (performance.now() >= deadlineAt) return timeoutMessage;
              const pendingSnapshot = await queueRead();
              if (boundSnapshotDigest(pendingSnapshot.snapshot) !== digest) {
                return `PR #${entry.pullRequest.number}: merge queue changed during operator SHIP publication wait`;
              }
              if (performance.now() >= deadlineAt) return timeoutMessage;
              operatorReceipt = await options.ensureOperatorPassthrough(operatorAdmission);
              if (performance.now() >= deadlineAt) return timeoutMessage;
            }
            if (!isDurableOperatorReceipt(operatorReceipt)) {
              return terminalOperatorPassthroughFailure(entry.pullRequest.number, operatorReceipt);
            }
            const result = await client.request(`${api}/commits/${head}/check-runs?filter=all&per_page=100`);
            const failure = exactReviewFailure(result, head, operatorReceipt);
            return failure ? `PR #${entry.pullRequest.number}: ${failure}` : undefined;
          }
          const result = await client.request(`${api}/commits/${head}/check-runs?filter=all&per_page=100`);
          const failure = exactReviewFailure(result, head);
          return failure ? `PR #${entry.pullRequest.number}: ${failure}` : undefined;
        });
        failures.push(...constituentFailures.filter((failure): failure is string => Boolean(failure)));
        const fresh = await queueRead();
        if (boundSnapshotDigest(fresh.snapshot) !== digest) failures.push('merge queue changed during exact-head qualification');
      } catch {
        failures.push('merge-group evidence could not be verified');
      }
      const conclusion: 'success' | 'failure' = failures.length === 0 ? 'success' : 'failure';
      const output = options.config.passthroughEnabled === true && conclusion === 'success'
        ? { title: 'Review Yeti merge group: SHIP (passthrough: no review performed)',
          summary: `review-mode=passthrough\nZero review lanes ran for the ${constituentCount} exact current queue constituent(s). `
            + `Queue snapshot digest: ${digest}. Every constituent's paired official Review Yeti checks succeeded.` }
        : { title: conclusion === 'success' ? 'Review Yeti merge group approved' : 'Review Yeti merge group rejected',
          summary: conclusion === 'success'
            ? `Every constituent has a successful exact-head Review Yeti check from the official App. Verified ${constituentCount} constituent(s).`
            : failures.slice(0, 12).map((failure) => `- ${failure.slice(0, 500)}`).join('\n').slice(0, 6_000) };
      const updatedCheck = await client.request(`${api}/check-runs/${Number(check.id)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
          status: 'completed', conclusion, completed_at: new Date().toISOString(), output,
        }),
      });
      if (!exactMergeGroupCheck(updatedCheck, identity, stableId)
        || updatedCheck.status !== 'completed' || updatedCheck.conclusion !== conclusion) {
        throw new Error('Review Yeti merge-group check update did not match the requested snapshot result');
      }
      const result = { checkId: Number(check.id), conclusion, snapshotDigest: digest };
      await options.repository.complete(repositoryId, headSha, digest, claimToken, result);
      return { ...result, constituents: constituentCount };
    } catch (error) {
      try { await options.repository.release(repositoryId, headSha, digest, claimToken); } catch { /* retry can reclaim the lease */ }
      throw error;
    }
  };
}
