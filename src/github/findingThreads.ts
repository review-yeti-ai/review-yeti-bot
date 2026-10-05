/**
 * Finding review threads (ADR 0002): the bot publishes each required finding as a pull-request
 * review thread carrying a hidden fingerprint marker, and every later head reads those threads
 * back to decide which findings are already known and which P2s the author resolved with a
 * stated reason.
 *
 * Reading needs only `pull_requests: read` (the worker's repository read token). Publishing and
 * resolving need `pull_requests: write` and run only in the dispatch service, never in the worker
 * pod that parses untrusted diffs.
 */
import {
  FINDING_MARKER_PREFIX,
  isFindingFingerprint,
  isResolutionSatisfiable,
  parseFindingMarker,
  renderFindingMarker,
  statedResolutionReason,
  type FindingSeverity,
  type PriorFindingThread,
} from '../review/findingConvergence';
import { PUBLIC_GITHUB_API_BASE_URL } from './githubTransportPolicy';
import { MAX_FINDING_THREADS_PER_REQUEST } from '../review/findingThreadsContract';

export const MAX_FINDING_THREAD_PAGES = 5;
/** One bound for the worker request, the service schema and publication (ADR 0002). */
export const MAX_FINDING_THREADS_PUBLISHED_PER_RUN = MAX_FINDING_THREADS_PER_REQUEST;
export const MAX_FINDING_THREAD_BODY_CHARS = 4_000;

export interface FindingThreadTransport {
  token: string;
  /**
   * The review App's bot login. When set, only threads that login opened are finding threads, and
   * only those can carry a resolution. When unknown, threads are still recognised for identity
   * (carried / dropped) but never satisfy a P2: an unverified author cannot clear a finding.
   */
  botLogin?: string;
  baseUrl?: string;
  fetchImplementation?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface PullRequestRef {
  owner: string;
  repo: string;
  prNumber: number;
}

/** Current-head fence used immediately before the service mutates PR review threads. */
export async function readCurrentPullRequestHead(transport: FindingThreadTransport,
  pr: PullRequestRef): Promise<string> {
  const base = (transport.baseUrl ?? PUBLIC_GITHUB_API_BASE_URL).replace(/\/+$/u, '');
  const url = `${base}/repos/${encodeURIComponent(pr.owner)}/${encodeURIComponent(pr.repo)}/pulls/${pr.prNumber}`;
  const body = await request(transport, url, { method: 'GET' });
  const head = body?.head?.sha;
  if (typeof head !== 'string' || !/^[a-f0-9]{40}$/u.test(head)) {
    throw new Error('GitHub pull request head is unavailable');
  }
  return head;
}

export interface PublishableFinding {
  fingerprint: string;
  severity: FindingSeverity;
  path: string;
  line: number;
  title: string;
  body: string;
}

function graphqlEndpoint(baseUrl: string): string {
  const api = baseUrl.replace(/\/+$/u, '');
  // GitHub Enterprise Server serves REST at /api/v3 and GraphQL at /api/graphql.
  return /\/api\/v3$/u.test(api) ? api.replace(/\/api\/v3$/u, '/api/graphql') : `${api}/graphql`;
}

async function request(transport: FindingThreadTransport, url: string, init: RequestInit): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), transport.timeoutMs ?? 10_000);
  timer.unref?.();
  const onAbort = () => controller.abort();
  transport.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await (transport.fetchImplementation ?? globalThis.fetch)(url, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${transport.token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'review-yeti-finding-threads',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      redirect: 'error',
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`GitHub finding-thread request failed with HTTP ${response.status}`) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
    transport.signal?.removeEventListener('abort', onAbort);
  }
}

async function graphql(transport: FindingThreadTransport, query: string, variables: Record<string, unknown>): Promise<any> {
  const body = await request(transport, graphqlEndpoint(transport.baseUrl ?? PUBLIC_GITHUB_API_BASE_URL), {
    method: 'POST', body: JSON.stringify({ query, variables }),
  });
  if (Array.isArray(body?.errors) && body.errors.length > 0) {
    throw new Error('GitHub finding-thread GraphQL request returned errors');
  }
  return body?.data;
}

const THREADS_QUERY = `query FindingThreads($owner: String!, $repo: String!, $pr: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path line originalLine
          comments(first: 30) { nodes { author { login __typename } body createdAt } }
        }
      }
    }
  }
}`;

function stripPresentation(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/<sub>[\s\S]*?<\/sub>/gu, ' ')
    .replace(/\*\*\[(?:P0|P1|P2)[^\]]*\]\*\*/gu, ' ')
    .trim()
    .slice(0, 400);
}

/** GraphQL reports an App bot's login as its slug; REST appends `[bot]`. Compare both forms. */
function normalizedLogin(login: unknown): string {
  return typeof login === 'string' ? login.trim().toLowerCase().replace(/\[bot\]$/u, '') : '';
}

/** Parses one GraphQL review-thread node into a prior finding thread, or null when the thread is
 * not a bot-published finding thread. Exported for tests. */
export function parseFindingThreadNode(node: any, botLogin?: string): PriorFindingThread | null {
  const comments: any[] = Array.isArray(node?.comments?.nodes) ? node.comments.nodes : [];
  const first = comments[0];
  // Only a thread the review App opened is a finding thread; a human (or another bot) pasting the
  // marker is not.
  if (!first || first.author?.__typename !== 'Bot') return null;
  const expected = normalizedLogin(botLogin);
  if (expected && normalizedLogin(first.author?.login) !== expected) return null;
  const marker = parseFindingMarker(first.body);
  if (!marker || !isFindingFingerprint(marker.fingerprint)) return null;
  const path = typeof node.path === 'string' ? node.path : '';
  if (!path) return null;
  const resolved = node.isResolved === true;
  let resolution: PriorFindingThread['resolution'];
  if (resolved && expected) {
    for (const comment of comments.slice(1)) {
      if (comment?.author?.__typename === 'Bot') continue;
      const reason = statedResolutionReason(comment?.body);
      const author = typeof comment?.author?.login === 'string' ? comment.author.login : '';
      if (reason && author) {
        resolution = { author, reason, ...(typeof comment.createdAt === 'string' ? { at: comment.createdAt } : {}) };
        break;
      }
    }
  }
  const line = Number(node.line ?? node.originalLine);
  return {
    ...(typeof node.id === 'string' ? { threadId: node.id } : {}),
    fingerprint: marker.fingerprint,
    severity: marker.severity,
    path,
    ...(Number.isSafeInteger(line) && line > 0 ? { line } : {}),
    title: marker.title,
    body: stripPresentation(String(first.body || '')),
    resolved,
    outdated: node.isOutdated === true,
    ...(resolution ? { resolution } : {}),
  };
}

/** Reads the bot's finding threads on a pull request (bounded pagination). */
export async function readFindingThreads(transport: FindingThreadTransport, pr: PullRequestRef): Promise<PriorFindingThread[]> {
  const threads: PriorFindingThread[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_FINDING_THREAD_PAGES; page += 1) {
    const data = await graphql(transport, THREADS_QUERY, { owner: pr.owner, repo: pr.repo, pr: pr.prNumber, after });
    const connection = data?.repository?.pullRequest?.reviewThreads;
    if (!connection || !Array.isArray(connection.nodes)) throw new Error('GitHub finding-thread response was malformed');
    for (const node of connection.nodes) {
      const parsed = parseFindingThreadNode(node, transport.botLogin);
      if (parsed) threads.push(parsed);
    }
    if (connection.pageInfo?.hasNextPage !== true || typeof connection.pageInfo?.endCursor !== 'string') break;
    after = connection.pageInfo.endCursor;
  }
  return threads;
}

/** The thread body a required finding is published with. */
export function renderFindingThreadBody(finding: PublishableFinding): string {
  // The published rule is derived from the same predicate the convergence
  // decision enforces, so the guidance authors follow cannot drift from what
  // actually satisfies a finding on the next head.
  const guidance = isResolutionSatisfiable(finding.severity)
    ? 'Required before merge. Fix it, or reply here with the reason it does not apply and resolve this conversation; the next review records the resolution.'
    : 'Required before merge. Fix it; a resolved conversation does not clear a P0 or P1.';
  // Model-derived text is neutralised so it cannot carry an HTML comment (and so a marker) into
  // the thread; the one authoritative marker is appended last.
  const neutral = (value: string) => value.replace(/<!--/gu, '&lt;!--').replace(/-->/gu, '--&gt;');
  const title = neutral(finding.title.replace(/[\r\n]+/gu, ' ')).slice(0, 300);
  const text = neutral(finding.body).slice(0, MAX_FINDING_THREAD_BODY_CHARS - 900);
  return [
    `**[${finding.severity} · required]** **${title}**`,
    '',
    text,
    '',
    `<sub>${guidance}</sub>`,
    '',
    renderFindingMarker({ fingerprint: finding.fingerprint, severity: finding.severity, title: finding.title.replace(/[\r\n]+/gu, ' ').slice(0, 300) }),
  ].join('\n');
}

/**
 * Publishes one review thread per finding that has no thread yet (matched by fingerprint against
 * a fresh read, so a retry never duplicates). Falls back to a file-level thread when GitHub rejects
 * the line anchor. Returns how many threads were created and skipped.
 */
export async function publishFindingThreads(transport: FindingThreadTransport, pr: PullRequestRef & { headSha: string },
  findings: readonly PublishableFinding[], existing?: readonly PriorFindingThread[],
  maxFindings = MAX_FINDING_THREADS_PUBLISHED_PER_RUN): Promise<{ created: number; skipped: number }> {
  const known = new Map((existing ?? await readFindingThreads(transport, pr))
    .map((thread) => [thread.fingerprint, thread] as const));
  const base = (transport.baseUrl ?? PUBLIC_GITHUB_API_BASE_URL).replace(/\/+$/u, '');
  const url = `${base}/repos/${encodeURIComponent(pr.owner)}/${encodeURIComponent(pr.repo)}/pulls/${pr.prNumber}/comments`;
  let created = 0;
  let skipped = 0;
  for (const finding of findings.slice(0, maxFindings)) {
    const prior = known.get(finding.fingerprint);
    // A fresh P0/P1 must reopen as a required conversation after someone resolved an older thread.
    // A resolved P2 remains satisfied under the legacy v1 contract.
    if (prior && (!prior.resolved || finding.severity === 'P2')) { skipped += 1; continue; }
    const body = renderFindingThreadBody(finding);
    try {
      await request(transport, url, { method: 'POST', body: JSON.stringify({
        body, commit_id: pr.headSha, path: finding.path, line: finding.line, side: 'RIGHT',
      }) });
    } catch (error) {
      if ((error as { status?: number }).status !== 422) throw error;
      await request(transport, url, { method: 'POST', body: JSON.stringify({
        body, commit_id: pr.headSha, path: finding.path, subject_type: 'file',
      }) });
    }
    known.set(finding.fingerprint, { ...finding, resolved: false, outdated: false });
    created += 1;
  }
  return { created, skipped: skipped + Math.max(0, findings.length - maxFindings) };
}

const RESOLVE_MUTATION = `mutation ResolveFindingThread($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } }
}`;

/** Resolves a bot finding thread (used for outdated threads whose finding was not reported again). */
export async function resolveFindingThread(transport: FindingThreadTransport, threadId: string): Promise<void> {
  await graphql(transport, RESOLVE_MUTATION, { threadId });
}

export { FINDING_MARKER_PREFIX };
