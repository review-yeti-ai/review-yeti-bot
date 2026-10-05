import { z } from 'zod';
import type { GitHubWebhookConfig } from '../auth/githubWebhookConfig';
import { OperatorMaintenanceTargetChangedError, operatorMaintenanceIdentitySchema,
  type OperatorMaintenanceIdentity, type OperatorMaintenancePolicyResolution } from './operatorMaintenanceContracts';
import { createBoundedGitHubJsonClient, type GitHubJsonClient } from '../github/boundedGitHubJson';

const QUEUE_QUERY = 'query($owner:String!,$name:String!,$branch:String!){repository(owner:$owner,name:$name){mergeQueue(branch:$branch){id entries(first:100){totalCount nodes{position state baseCommit{oid} headCommit{oid} pullRequest{number state baseRefName headRefOid repository{nameWithOwner}}} pageInfo{hasNextPage}}}}}';
const SHA = z.string().regex(/^[a-f0-9]{40}$/u);
const QUALIFYING_STATES = new Set(['QUEUED', 'AWAITING_CHECKS', 'LOCKED', 'MERGEABLE']);

export interface MergeGroupMaintenanceQueueOptions {
  config: GitHubWebhookConfig;
  tokenFor(owner: string, repo: string): Promise<string>;
  fetchImplementation?: typeof fetch;
  baseUrl?: string;
  githubClientFor?(token: string): GitHubJsonClient;
}

export interface MergeGroupPolicyPullRequest {
  repositoryId: number;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
}

export interface MergeGroupMaintenanceQueue {
  currentPolicyPullRequest(identity: OperatorMaintenanceIdentity): Promise<MergeGroupPolicyPullRequest>;
  verifyCurrent(identity: OperatorMaintenanceIdentity,
    policyResolution: Pick<OperatorMaintenancePolicyResolution, 'repositoryId' | 'owner' | 'repo' | 'prNumber' | 'headSha'>): Promise<void>;
}

interface QueuePullRequest {
  number: number;
  state: string;
  baseRefName: string;
  headRefOid: string;
  repository: { nameWithOwner: string };
}

interface QueueEntry {
  position: number;
  state: string;
  pullRequest: QueuePullRequest;
  baseCommit?: { oid?: string };
  headCommit?: { oid?: string };
}

interface QueueEvidence { id: string; entries: QueueEntry[]; current: QueueEntry; }

function branchName(ref: string): string { return ref.replace(/^refs\/heads\//u, ''); }

/** Rebuilds live authenticated queue evidence for original signed maintenance
 * intents and before each synchronous publication side effect. */
export function createMergeGroupMaintenanceQueue(options: MergeGroupMaintenanceQueueOptions) {
  const readStable = async (input: OperatorMaintenanceIdentity): Promise<QueueEvidence> => {
    const identity = operatorMaintenanceIdentitySchema.parse(input);
    if (identity.subject.kind !== 'merge_group' || !options.config.passthroughEnabled
      || !options.config.repositoryIds.has(String(identity.repositoryId))) {
      throw new OperatorMaintenanceTargetChangedError();
    }
    const branch = branchName(identity.subject.baseRef);
    const prefix = `refs/heads/gh-readonly-queue/${branch}/`;
    const group = identity.subject.headRef.startsWith(prefix)
      ? /^pr-([1-9][0-9]*)-[0-9a-f]{7,40}$/u.exec(identity.subject.headRef.slice(prefix.length)) : null;
    const branchMatch = /^refs\/heads\/([^\u0000-\u001f\u007f]+)$/u.exec(identity.subject.baseRef);
    if (!branch || !branchMatch || branchMatch[1] !== branch || !group) {
      throw new OperatorMaintenanceTargetChangedError();
    }
    const currentNumber = Number(group[1]);
    const token = await options.tokenFor(identity.owner, identity.repo);
    if (!token.startsWith('ghs_')) throw new Error('Merge-group App token is unavailable');
    const client = options.githubClientFor?.(token) || createBoundedGitHubJsonClient({
      token, baseUrl: options.baseUrl, fetchImplementation: options.fetchImplementation,
    });
    const repository = await client.request(`/repos/${identity.owner}/${identity.repo}`);
    if (repository?.id !== identity.repositoryId || repository?.name !== identity.repo
      || repository?.full_name !== `${identity.owner}/${identity.repo}`
      || repository?.owner?.login !== identity.owner || !Number.isSafeInteger(repository?.owner?.id)
      || !options.config.ownerIds.has(String(repository.owner.id))) {
      throw new OperatorMaintenanceTargetChangedError();
    }
    const readQueue = async (): Promise<QueueEvidence> => {
      const response = await client.request('/graphql', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: QUEUE_QUERY, variables: { owner: identity.owner, name: identity.repo, branch } }),
      });
      if (Array.isArray(response?.errors) && response.errors.length > 0) throw new Error('Merge queue lookup returned errors');
      const queue = response?.data?.repository?.mergeQueue;
      const nodes = queue?.entries?.nodes;
      if (typeof queue?.id !== 'string' || !queue.id || !Array.isArray(nodes)
        || queue.entries.pageInfo?.hasNextPage !== false
        || !Number.isSafeInteger(queue.entries.totalCount) || queue.entries.totalCount !== nodes.length
        || nodes.length < 1 || nodes.length > 100) throw new Error('Merge queue evidence is incomplete');
      const numbers = new Set<number>();
      const positions = new Set<number>();
      for (const entry of nodes) {
        const number = entry?.pullRequest?.number;
        if (!Number.isSafeInteger(number) || number < 1 || numbers.has(number)
          || !Number.isSafeInteger(entry?.position) || entry.position < 1 || positions.has(entry.position)) {
          throw new Error('Merge queue entries are malformed');
        }
        numbers.add(number); positions.add(entry.position);
      }
      const current = nodes.find((entry: QueueEntry) => entry.pullRequest.number === currentNumber);
      if (!current || current.headCommit?.oid !== identity.headSha || current.baseCommit?.oid !== identity.baseSha) {
        throw new OperatorMaintenanceTargetChangedError();
      }
      const entries = nodes.filter((entry: QueueEntry) => entry.position <= current.position)
        .sort((left: QueueEntry, right: QueueEntry) => left.position - right.position) as QueueEntry[];
      for (const entry of entries) {
        const pull = entry.pullRequest;
        if (!SHA.safeParse(pull?.headRefOid).success || !QUALIFYING_STATES.has(entry.state)
          || pull.state !== 'OPEN' || pull.baseRefName !== branch
          || pull.repository?.nameWithOwner !== `${identity.owner}/${identity.repo}`) {
          throw new Error('Merge queue contains an ineligible constituent');
        }
      }
      return { id: queue.id, entries, current: current as QueueEntry };
    };
    const first = await readQueue();
    const second = await readQueue();
    const signature = (evidence: QueueEvidence) => JSON.stringify(evidence.entries.map((entry) => ({
      position: entry.position, state: entry.state, number: entry.pullRequest.number,
      pullState: entry.pullRequest.state, baseRef: entry.pullRequest.baseRefName,
      head: entry.pullRequest.headRefOid, repository: entry.pullRequest.repository.nameWithOwner,
    })));
    if (first.id !== second.id || signature(first) !== signature(second)) {
      throw new Error('Merge-group queue changed during maintenance validation');
    }
    return second;
  };

  return {
    async currentPolicyPullRequest(identity: OperatorMaintenanceIdentity): Promise<MergeGroupPolicyPullRequest> {
      const current = await readStable(identity);
      return { repositoryId: identity.repositoryId, owner: identity.owner, repo: identity.repo,
        prNumber: current.current.pullRequest.number, headSha: current.current.pullRequest.headRefOid };
    },
    async verifyCurrent(identity: OperatorMaintenanceIdentity,
      policyResolution: Pick<OperatorMaintenancePolicyResolution, 'repositoryId' | 'owner' | 'repo' | 'prNumber' | 'headSha'>): Promise<void> {
      const current = await readStable(identity);
      if (policyResolution.repositoryId !== identity.repositoryId || policyResolution.owner !== identity.owner
        || policyResolution.repo !== identity.repo || policyResolution.prNumber !== current.current.pullRequest.number
        || policyResolution.headSha !== current.current.pullRequest.headRefOid) {
        throw new OperatorMaintenanceTargetChangedError();
      }
    },
  };
}
