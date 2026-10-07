import { createHash } from 'node:crypto';
import { createBoundedGitHubJsonClient } from './boundedGitHubJson';
import { isGitHubInstallationToken } from './githubTransportPolicy';
import { canonicalJson } from '../review/reviewCore';

export const MAX_TRUSTED_CONVENTION_COMMENT_PAGES = 10;
export const MAX_TRUSTED_CONVENTION_COMMENT_BODY_CHARACTERS = 2_048;
export const TRUSTED_CONVENTION_COMMAND_SYNTAX = '/review-yeti accept-convention repo=OWNER/REPO pr=N'
  + ' head=<40-hex> finding=lf1_<32-hex> evidence=<64-hex> convention=lower-kebab-id';
const COMMENT_PAGE_SIZE = 100;
const MAX_CURRENT_FINDINGS = 5_000;
const MAX_CONSUMED_SOURCE_DIGESTS = 10_000;
const DURABLE_FINDING_ID = /^lf1_[a-f0-9]{32}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const SHA = /^[a-f0-9]{40}$/u;
const GITHUB_PERMISSION = /^(?:admin|maintain|write|triage|read|none)$/u;

export type TrustedConventionWritePermission = 'admin' | 'maintain';

export interface TrustedConventionCurrentFinding {
  findingId: string;
  evidenceDigest: string;
}

export interface TrustedConventionAdjudicationReadInput {
  /** Requested repository; GitHub's pull response must independently confirm it. */
  repository: string;
  /** Requested PR; GitHub's pull response must independently confirm it. */
  prNumber: number;
  /** Current admitted head; it must equal the independently read GitHub PR head. */
  expectedHeadSha: string;
  /** Existing durable findings and their current evidence digests from trusted service context. */
  currentFindings: readonly TrustedConventionCurrentFinding[];
  /** Source digests already recorded by lifecycle history, used to prevent replay. */
  consumedCommentSourceIdDigests?: readonly string[];
}

export interface TrustedConventionAdjudicationReaderOptions {
  /** GitHub installation token with permission to read the PR and collaborator access. */
  token?: string;
  /** Injection point for deterministic offline tests. Requests remain pinned to GitHub.com. */
  fetchImplementation?: typeof fetch;
}

export interface AcceptedTrustedConventionAdjudication {
  version: 'TrustedConventionAdjudication.v1';
  repository: string;
  prNumber: number;
  headSha: string;
  findingId: string;
  evidenceDigest: string;
  conventionId: string;
  /** All source metadata below is taken from authenticated GitHub API responses. */
  commentId: number;
  createdAt: string;
  actorDigest: string;
  permission: TrustedConventionWritePermission;
  sourceIdDigest: string;
  receiptDigest: string;
}

export type TrustedConventionAdjudicationReadResult =
  | {
    status: 'available';
    adjudications: AcceptedTrustedConventionAdjudication[];
  }
  | {
    status: 'stale';
    reason: 'head-moved' | 'repository-or-pr-mismatch';
    adjudications: [];
  }
  | {
    status: 'unavailable';
    reason: 'github-capability-unavailable' | 'github-read-failed' | 'comment-pagination-limit'
      | 'comment-body-limit' | 'invalid-current-context';
    adjudications: [];
  };

interface RepositoryParts {
  owner: string;
  repo: string;
}

interface ParsedCommand {
  repository: string;
  prNumber: number;
  headSha: string;
  findingId: string;
  evidenceDigest: string;
  conventionId: string;
}

interface PullRequestIdentity {
  number: number;
  head: { sha: string };
  base: { repo: { full_name: string } };
}

interface CommentCandidate {
  id: number;
  createdAt: string;
  user: { id: number; login: string };
}

interface PermissionIdentity {
  user: { id: number; login: string };
  permission: string;
  authorizedRole?: TrustedConventionWritePermission;
}

function validRepository(value: unknown): RepositoryParts | null {
  if (typeof value !== 'string') return null;
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u.exec(value);
  if (!match || match[1] === '.' || match[1] === '..' || match[2] === '.' || match[2] === '..') return null;
  return { owner: match[1]!, repo: match[2]! };
}

function validPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function githubLogin(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 39
    && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(value);
}

function parsePullRequestIdentity(value: unknown): PullRequestIdentity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const pull = value as Record<string, unknown>;
  const head = pull.head && typeof pull.head === 'object' && !Array.isArray(pull.head)
    ? pull.head as Record<string, unknown> : null;
  const base = pull.base && typeof pull.base === 'object' && !Array.isArray(pull.base)
    ? pull.base as Record<string, unknown> : null;
  const repo = base?.repo && typeof base.repo === 'object' && !Array.isArray(base.repo)
    ? base.repo as Record<string, unknown> : null;
  if (!validPositiveInteger(pull.number) || typeof head?.sha !== 'string' || !SHA.test(head.sha)
    || typeof repo?.full_name !== 'string' || !validRepository(repo.full_name)) return null;
  return {
    number: pull.number,
    head: { sha: head.sha },
    base: { repo: { full_name: repo.full_name } },
  };
}

/** Parses only the exact whole-body form declared by {@link TRUSTED_CONVENTION_COMMAND_SYNTAX}. */
function parseCommand(body: string): ParsedCommand | null {
  if (body.length > MAX_TRUSTED_CONVENTION_COMMENT_BODY_CHARACTERS) return null;
  const match = /^\/review-yeti accept-convention repo=([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+) pr=([1-9][0-9]*) head=([a-f0-9]{40}) finding=(lf1_[a-f0-9]{32}) evidence=([a-f0-9]{64}) convention=([a-z0-9]+(?:-[a-z0-9]+)*)$/u.exec(body);
  // JavaScript's `$` may match before a final newline; requiring the full match
  // to equal the entire body keeps this an exact, one-line command.
  if (!match || match[0] !== body || match[6]!.length > 200) return null;
  const prNumber = Number(match[2]);
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0 || !validRepository(match[1])) return null;
  return {
    repository: match[1]!, prNumber, headSha: match[3]!, findingId: match[4]!,
    evidenceDigest: match[5]!, conventionId: match[6]!,
  };
}

function parseComment(value: unknown): { id: number; body: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const comment = value as Record<string, unknown>;
  if (!validPositiveInteger(comment.id) || typeof comment.body !== 'string') return null;
  if (comment.body.length > MAX_TRUSTED_CONVENTION_COMMENT_BODY_CHARACTERS) {
    throw new Error('comment-body-limit');
  }
  return { id: comment.id, body: comment.body };
}

function parseCandidateMetadata(value: unknown): CommentCandidate | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const comment = value as Record<string, unknown>;
  const user = comment.user && typeof comment.user === 'object' && !Array.isArray(comment.user)
    ? comment.user as Record<string, unknown> : null;
  if (!validPositiveInteger(comment.id) || typeof comment.body !== 'string'
    || typeof comment.created_at !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(comment.created_at)
    || Number.isNaN(Date.parse(comment.created_at)) || !validPositiveInteger(user?.id)
    || !githubLogin(user?.login)) return null;
  return { id: comment.id, createdAt: comment.created_at,
    user: { id: user.id, login: user.login } };
}

function parsePermissionIdentity(value: unknown): PermissionIdentity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const user = data.user && typeof data.user === 'object' && !Array.isArray(data.user)
    ? data.user as Record<string, unknown> : null;
  if (!validPositiveInteger(user?.id) || !githubLogin(user?.login)
    || typeof data.permission !== 'string' || !GITHUB_PERMISSION.test(data.permission)
    || (data.role_name !== undefined && (typeof data.role_name !== 'string' || !GITHUB_PERMISSION.test(data.role_name)))) return null;
  const roleName = typeof data.role_name === 'string' ? data.role_name : undefined;
  const authorizedRole: TrustedConventionWritePermission | undefined = roleName === 'admin' && data.permission === 'admin'
    ? 'admin' : roleName === 'maintain' && (data.permission === 'write' || data.permission === 'maintain') ? 'maintain'
    : roleName === undefined && data.permission === 'admin' ? 'admin'
    : roleName === undefined && data.permission === 'maintain' ? 'maintain' : undefined;
  return { user: { id: user.id, login: user.login }, permission: data.permission, ...(authorizedRole ? { authorizedRole } : {}) };
}

function sameRepository(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function commandMatchesCurrentContext(command: ParsedCommand, actual: PullRequestIdentity,
  requestedRepository: string, requestedPrNumber: number, currentFindings: ReadonlyMap<string, string>): boolean {
  return sameRepository(command.repository, requestedRepository)
    && sameRepository(command.repository, actual.base.repo.full_name)
    && command.prNumber === requestedPrNumber && command.prNumber === actual.number
    && command.headSha === actual.head.sha
    && currentFindings.get(command.findingId) === command.evidenceDigest;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Stable lifecycle key for an issue-comment source; accepts only API comment IDs. */
export function trustedConventionCommentSourceIdDigest(commentId: number): string {
  if (!validPositiveInteger(commentId)) throw new Error('GitHub comment ID is invalid');
  return sha256(`github-issue-comment.v1\0${commentId}`);
}

function unavailable(reason: Extract<TrustedConventionAdjudicationReadResult, { status: 'unavailable' }>['reason']):
  TrustedConventionAdjudicationReadResult {
  return { status: 'unavailable', reason, adjudications: [] };
}

function validInput(input: TrustedConventionAdjudicationReadInput): {
  repository: RepositoryParts;
  currentFindings: Map<string, string>;
  consumedDigests: Set<string>;
} | null {
  const repository = validRepository(input.repository);
  if (!repository || !validPositiveInteger(input.prNumber) || typeof input.expectedHeadSha !== 'string'
    || !SHA.test(input.expectedHeadSha) || !Array.isArray(input.currentFindings)
    || input.currentFindings.length > MAX_CURRENT_FINDINGS) return null;
  const currentFindings = new Map<string, string>();
  for (const row of input.currentFindings) {
    if (!row || typeof row !== 'object' || typeof row.findingId !== 'string'
      || !DURABLE_FINDING_ID.test(row.findingId) || typeof row.evidenceDigest !== 'string'
      || !DIGEST.test(row.evidenceDigest) || currentFindings.has(row.findingId)) return null;
    currentFindings.set(row.findingId, row.evidenceDigest);
  }
  const consumed = input.consumedCommentSourceIdDigests ?? [];
  if (!Array.isArray(consumed) || consumed.length > MAX_CONSUMED_SOURCE_DIGESTS
    || consumed.some((digest) => typeof digest !== 'string' || !DIGEST.test(digest))) return null;
  return { repository, currentFindings, consumedDigests: new Set(consumed) };
}

/**
 * Reads exact PR issue comments and independently authorizes each matching command through
 * GitHub's repository collaborator-permission endpoint. Command metadata selects current trusted
 * context but never supplies the receipt's actor, source ID, time, permission, repo, PR, head, or
 * evidence digest. Those fields come from GitHub's PR/comment/permission responses or the trusted
 * current-finding context; only the convention ID is retained from the command body.
 */
export async function readTrustedConventionAdjudications(
  input: TrustedConventionAdjudicationReadInput,
  options: TrustedConventionAdjudicationReaderOptions = {},
): Promise<TrustedConventionAdjudicationReadResult> {
  const validated = validInput(input);
  if (!validated) return unavailable('invalid-current-context');
  if (!isGitHubInstallationToken(options.token)) return unavailable('github-capability-unavailable');

  let github;
  try {
    github = createBoundedGitHubJsonClient({
      token: options.token,
      ...(options.fetchImplementation ? { fetchImplementation: options.fetchImplementation } : {}),
    });
  } catch {
    return unavailable('github-capability-unavailable');
  }

  const ownerPath = encodeURIComponent(validated.repository.owner);
  const repoPath = encodeURIComponent(validated.repository.repo);
  const basePath = `/repos/${ownerPath}/${repoPath}`;
  let actual: PullRequestIdentity | null;
  try {
    actual = parsePullRequestIdentity(await github.request(`${basePath}/pulls/${input.prNumber}`));
  } catch {
    return unavailable('github-read-failed');
  }
  if (!actual) return unavailable('github-read-failed');
  if (actual.number !== input.prNumber || !sameRepository(actual.base.repo.full_name, input.repository)) {
    return { status: 'stale', reason: 'repository-or-pr-mismatch', adjudications: [] };
  }
  if (actual.head.sha !== input.expectedHeadSha) {
    return { status: 'stale', reason: 'head-moved', adjudications: [] };
  }

  const comments: unknown[] = [];
  const commentIds = new Set<number>();
  const duplicateCommentIds = new Set<number>();
  try {
    for (let page = 1; page <= MAX_TRUSTED_CONVENTION_COMMENT_PAGES; page += 1) {
      const query = new URLSearchParams({ per_page: String(COMMENT_PAGE_SIZE), page: String(page) });
      const rows: unknown = await github.request(`${basePath}/issues/${actual.number}/comments?${query}`);
      if (!Array.isArray(rows) || rows.length > COMMENT_PAGE_SIZE) return unavailable('github-read-failed');
      for (const row of rows) {
        const parsed = parseComment(row);
        if (!parsed) return unavailable('github-read-failed');
        if (commentIds.has(parsed.id)) duplicateCommentIds.add(parsed.id);
        commentIds.add(parsed.id);
        comments.push(row);
      }
      if (rows.length < COMMENT_PAGE_SIZE) break;
      if (page === MAX_TRUSTED_CONVENTION_COMMENT_PAGES) return unavailable('comment-pagination-limit');
    }
  } catch (error) {
    return unavailable(error instanceof Error && error.message === 'comment-body-limit'
      ? 'comment-body-limit' : 'github-read-failed');
  }

  const candidates: Array<{ comment: CommentCandidate; command: ParsedCommand; sourceIdDigest: string }> = [];
  for (const raw of comments) {
    const metadata = raw as Record<string, unknown>;
    const body = metadata.body;
    if (typeof body !== 'string') return unavailable('github-read-failed');
    const command = parseCommand(body);
    if (!command || !commandMatchesCurrentContext(command, actual, input.repository, input.prNumber,
      validated.currentFindings)) continue;
    const candidate = parseCandidateMetadata(raw);
    if (!candidate) return unavailable('github-read-failed');
    if (duplicateCommentIds.has(candidate.id)) continue;
    const sourceIdDigest = trustedConventionCommentSourceIdDigest(candidate.id);
    if (validated.consumedDigests.has(sourceIdDigest)) continue;
    candidates.push({ comment: candidate, command, sourceIdDigest });
  }

  const permissionCache = new Map<number, PermissionIdentity>();
  const authorized: Array<{ comment: CommentCandidate; command: ParsedCommand; sourceIdDigest: string;
    permission: TrustedConventionWritePermission }> = [];
  for (const candidate of candidates) {
    let permissionIdentity = permissionCache.get(candidate.comment.user.id);
    if (!permissionIdentity) {
      const loginPath = encodeURIComponent(candidate.comment.user.login);
      let response: unknown;
      try {
        response = await github.request(`${basePath}/collaborators/${loginPath}/permission`);
      } catch {
        return unavailable('github-read-failed');
      }
      permissionIdentity = parsePermissionIdentity(response) ?? undefined;
      if (!permissionIdentity || permissionIdentity.user.id !== candidate.comment.user.id
        || permissionIdentity.user.login.toLowerCase() !== candidate.comment.user.login.toLowerCase()) {
        return unavailable('github-read-failed');
      }
      permissionCache.set(candidate.comment.user.id, permissionIdentity);
    }
    if (permissionIdentity.user.id !== candidate.comment.user.id
      || permissionIdentity.user.login.toLowerCase() !== candidate.comment.user.login.toLowerCase()) {
      return unavailable('github-read-failed');
    }
    if (permissionIdentity.authorizedRole) {
      authorized.push({ ...candidate, permission: permissionIdentity.authorizedRole });
    }
  }

  const byFinding = new Map<string, typeof authorized>();
  for (const row of authorized) {
    const group = byFinding.get(row.command.findingId) ?? [];
    group.push(row);
    byFinding.set(row.command.findingId, group);
  }

  const adjudications: AcceptedTrustedConventionAdjudication[] = [];
  for (const [findingId, group] of byFinding) {
    // Multiple authorized comments for one current finding leave operator intent ambiguous.
    if (group.length !== 1) continue;
    const accepted = group[0]!;
    const actorDigest = sha256(`github-user.v1\0${accepted.comment.user.id}`);
    const fields = {
      version: 'TrustedConventionAdjudication.v1' as const,
      repository: actual.base.repo.full_name,
      prNumber: actual.number,
      headSha: actual.head.sha,
      findingId,
      evidenceDigest: validated.currentFindings.get(findingId)!,
      conventionId: accepted.command.conventionId,
      commentId: accepted.comment.id,
      createdAt: accepted.comment.createdAt,
      actorDigest,
      permission: accepted.permission,
      sourceIdDigest: accepted.sourceIdDigest,
    };
    adjudications.push({ ...fields, receiptDigest: sha256(canonicalJson(fields)) });
  }
  adjudications.sort((left, right) => left.findingId.localeCompare(right.findingId));
  return { status: 'available', adjudications };
}
