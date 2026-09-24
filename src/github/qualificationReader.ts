import { createHash } from 'node:crypto';
import { Octokit } from '@octokit/core';
import {
  GitDiffSourceError, mergeBaseFromComparison, verifyGitDerivedDiff,
  type GitDiffFailureReason, type GitDiffSource,
} from './gitDiffSource';

const PR_ROUTE = 'GET /repos/{owner}/{repo}/pulls/{pull_number}';
const FILES_ROUTE = 'GET /repos/{owner}/{repo}/pulls/{pull_number}/files';
const COMPARE_ROUTE = 'GET /repos/{owner}/{repo}/compare/{basehead}';
const DIFF_ACCEPT = 'application/vnd.github.v3.diff';
// Raised from 2 MB to 8 MB so a single review can admit diffs up to roughly
// 80k changed lines. Diffs above GitHub's diff-render contract (~20k lines)
// are assembled from the paginated pull-files API instead of the diff media
// type, which returns HTTP 406 for changes that are too large to render.
const MAX_QUALIFICATION_DIFF_BYTES = 8_000_000;
const FILES_PAGE_SIZE = 100;
const MAX_FILES_PAGES = 100;

export interface SameHeadQualificationInput {
  token: string;
  repo: string;
  prNumber: number;
  expectedBaseSha: string;
  expectedHeadSha: string;
}

export interface SameHeadReviewSource {
  baseSha: string;
  headSha: string;
  diff: string;
  diffDigest: string;
  githubReads: number;
}

/**
 * REL-1080: optional git-derived source for diffs GitHub will not render (406).
 * Absent means the pre-REL-1080 behaviour exactly.
 */
export interface SameHeadReviewSourceOptions {
  gitDiffSource?: GitDiffSource;
  /** Observability only: which source served a 406 diff, and why git did not. */
  onLargeDiffSource?: (outcome: { source: 'git' | 'pull-files'; reason?: GitDiffFailureReason; files?: number }) => void;
}

type PullRequestResponse = {
  data: unknown;
  status?: number;
};

export type GitHubQualificationRequest = (
  route: string,
  parameters: Record<string, unknown>,
) => Promise<PullRequestResponse>;

export class GitHubQualificationReadError extends Error {
  /**
   * The HTTP status GitHub returned for the failed read, when one was
   * observed. This is the single source of the status a
   * GitHubQualificationReadError carries: every consumer that needs to
   * branch on it (worker failure classification, diff-too-large detection)
   * reads this field instead of parsing the human-readable `message`. The
   * message text remains free to change without breaking a consumer.
   */
  constructor(message: string, readonly githubReads: number, readonly httpStatus?: number) {
    super(message);
    this.name = 'GitHubQualificationReadError';
  }
}

/**
 * REL-1057: the pull request GitHub projects no longer matches the admitted
 * run's base/head identity. It stays a `GitHubQualificationReadError` (same
 * message, so existing classifiers are unchanged) and additionally carries the
 * identity GitHub reported, so a caller can tell "a newer head superseded this
 * run" (`headMoved`) from a base-only move, which is not a supersession.
 */
export class GitHubPullRequestIdentityMovedError extends GitHubQualificationReadError {
  constructor(
    message: string,
    githubReads: number,
    readonly expectedHeadSha: string,
    readonly currentHeadSha: string,
    readonly currentBaseSha: string,
  ) {
    super(message, githubReads);
    this.name = 'GitHubPullRequestIdentityMovedError';
  }

  /** True when the admitted head is no longer the pull request head. */
  get headMoved(): boolean {
    return this.currentHeadSha !== this.expectedHeadSha;
  }
}

function validateInput(input: SameHeadQualificationInput): { owner: string; repo: string } {
  if (!input.token.startsWith('ghs_')) {
    throw new Error('GitHub qualification token is not an installation token');
  }
  const repository = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u.exec(input.repo);
  if (!repository) throw new Error('GitHub qualification repository is invalid');
  if (!Number.isSafeInteger(input.prNumber) || input.prNumber <= 0) {
    throw new Error('GitHub qualification pull request number is invalid');
  }
  const shaPattern = /^[0-9a-f]{40}$/u;
  if (!shaPattern.test(input.expectedBaseSha) || !shaPattern.test(input.expectedHeadSha)) {
    throw new Error('GitHub qualification commit identity is invalid');
  }
  return { owner: repository[1], repo: repository[2] };
}

function pullRequestIdentity(data: unknown, githubReads: number): { baseSha: string; headSha: string } {
  const candidate = data as { base?: { sha?: unknown }; head?: { sha?: unknown } };
  const baseSha = typeof candidate?.base?.sha === 'string' ? candidate.base.sha : '';
  const headSha = typeof candidate?.head?.sha === 'string' ? candidate.head.sha : '';
  if (!/^[0-9a-f]{40}$/u.test(baseSha) || !/^[0-9a-f]{40}$/u.test(headSha)) {
    throw new GitHubQualificationReadError('GitHub qualification pull request identity is invalid', githubReads);
  }
  return { baseSha, headSha };
}

function changedFileCount(data: unknown): number | undefined {
  const count = (data as { changed_files?: unknown } | null)?.changed_files;
  return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : undefined;
}

async function safeRequest(
  request: GitHubQualificationRequest,
  parameters: Record<string, unknown>,
  githubReads: number,
  route: string = PR_ROUTE,
): Promise<PullRequestResponse> {
  try {
    return await request(route, parameters);
  } catch (error) {
    const status = Number((error as { status?: unknown })?.status);
    if (Number.isInteger(status) && status >= 100 && status <= 599) {
      throw new GitHubQualificationReadError(`GitHub qualification read failed HTTP ${status}`, githubReads, status);
    }
    throw new GitHubQualificationReadError('GitHub qualification read failed', githubReads);
  }
}

type PullFileEntry = {
  filename?: unknown;
  previous_filename?: unknown;
  status?: unknown;
  patch?: unknown;
};

function renderFilePatch(file: PullFileEntry): string {
  const filename = typeof file.filename === 'string' ? file.filename : '';
  const patch = typeof file.patch === 'string' ? file.patch : '';
  if (!filename || !patch) return '';
  const previous =
    file.status === 'renamed' && typeof file.previous_filename === 'string'
      ? file.previous_filename
      : filename;
  return `diff --git a/${previous} b/${filename}\n${patch}\n`;
}

/**
 * Reads the pull request diff. GitHub returns HTTP 406 from the diff media type
 * when a change is too large to render (~20k changed lines); for those diffs the
 * patch is assembled from the paginated pull-files API, which keeps working, so
 * large-but-legitimate reviews can still qualify.
 */
async function readQualificationDiff(
  request: GitHubQualificationRequest,
  parameters: Record<string, unknown>,
  githubReads: number,
  git?: { options: SameHeadReviewSourceOptions; token: string; owner: string; repo: string;
    baseSha: string; headSha: string; expectedFileCount: number | undefined },
): Promise<{ diff: string; githubReads: number; gitDerived?: boolean }> {
  try {
    const diffResponse = await safeRequest(request, {
      ...parameters,
      headers: { accept: DIFF_ACCEPT },
    }, githubReads + 1);
    if (typeof diffResponse.data !== 'string') {
      throw new GitHubQualificationReadError('GitHub qualification diff response is invalid', githubReads + 1);
    }
    return { diff: diffResponse.data, githubReads: githubReads + 1 };
  } catch (error) {
    if (!(error instanceof GitHubQualificationReadError) || error.httpStatus !== 406) throw error;
  }

  let reads = githubReads + 1;
  if (git?.options.gitDiffSource) {
    // REL-1080: the same git-derived three-dot diff the trusted completion side
    // computes for a 406, from the exact merge base GitHub reports for the
    // admitted base/head. Any failure keeps the pre-REL-1080 pull-files path.
    try {
      reads += 1;
      const comparison = await safeRequest(request, {
        owner: git.owner, repo: git.repo, basehead: `${git.baseSha}...${git.headSha}`, per_page: 1, page: 1,
      }, reads, COMPARE_ROUTE);
      const mergeBaseSha = mergeBaseFromComparison(comparison.data, git.baseSha);
      const diff = await git.options.gitDiffSource({
        owner: git.owner, repo: git.repo, token: git.token, mergeBaseSha, headSha: git.headSha,
      });
      const files = verifyGitDerivedDiff(diff, { expectedFileCount: git.expectedFileCount });
      git.options.onLargeDiffSource?.({ source: 'git', files: files.length });
      return { diff, githubReads: reads, gitDerived: true };
    } catch (error) {
      const reason = error instanceof GitDiffSourceError ? error.reason : 'unavailable';
      git.options.onLargeDiffSource?.({ source: 'pull-files', reason });
    }
  }
  const parts: string[] = [];
  for (let page = 1; page <= MAX_FILES_PAGES; page += 1) {
    const response = await safeRequest(request, {
      ...parameters,
      per_page: FILES_PAGE_SIZE,
      page,
    }, reads + 1, FILES_ROUTE);
    reads += 1;
    const files = Array.isArray(response.data) ? (response.data as PullFileEntry[]) : [];
    for (const file of files) parts.push(renderFilePatch(file));
    if (files.length < FILES_PAGE_SIZE) return { diff: parts.join(''), githubReads: reads };
  }
  throw new GitHubQualificationReadError(
    'GitHub qualification diff fallback exceeded page bound',
    reads,
  );
}

/**
 * Reads an immutable PR diff under a repository-scoped read token and verifies
 * the projected base/head identity before and after retrieval.
 */
export async function loadSameHeadReviewSource(
  input: SameHeadQualificationInput,
  requestFn?: GitHubQualificationRequest,
  options: SameHeadReviewSourceOptions = {},
): Promise<SameHeadReviewSource> {
  const { owner, repo } = validateInput(input);
  const octokit = requestFn ? undefined : new Octokit({ auth: input.token });
  const request = requestFn ?? (octokit!.request.bind(octokit) as unknown as GitHubQualificationRequest);
  const parameters = { owner, repo, pull_number: input.prNumber };

  const initialData = (await safeRequest(request, parameters, 1)).data;
  const initial = pullRequestIdentity(initialData, 1);
  if (initial.baseSha !== input.expectedBaseSha || initial.headSha !== input.expectedHeadSha) {
    throw new GitHubPullRequestIdentityMovedError('GitHub projected pull request identity mismatch', 1,
      input.expectedHeadSha, initial.headSha, initial.baseSha);
  }

  const expectedFileCount = changedFileCount(initialData);
  const { diff, githubReads, gitDerived } = await readQualificationDiff(request, parameters, 1, options.gitDiffSource ? {
    options, token: input.token, owner, repo, baseSha: initial.baseSha, headSha: initial.headSha, expectedFileCount,
  } : undefined);
  const diffBytes = Buffer.byteLength(diff, 'utf8');
  if (diffBytes < 1 || diffBytes > MAX_QUALIFICATION_DIFF_BYTES) {
    throw new GitHubQualificationReadError('GitHub qualification diff size is outside qualification bounds', githubReads);
  }

  const finalData = (await safeRequest(request, parameters, githubReads + 1)).data;
  const final = pullRequestIdentity(finalData, githubReads + 1);
  if (final.baseSha !== input.expectedBaseSha || final.headSha !== input.expectedHeadSha) {
    throw new GitHubPullRequestIdentityMovedError('GitHub pull request moved during qualification read', githubReads + 1,
      input.expectedHeadSha, final.headSha, final.baseSha);
  }
  // REL-1080: a git-derived diff was accepted against GitHub's file count; that
  // count must not have changed across the bracketing reads.
  if (gitDerived && changedFileCount(finalData) !== expectedFileCount) {
    throw new GitHubQualificationReadError('GitHub pull request file count changed during qualification read',
      githubReads + 1);
  }

  return {
    baseSha: initial.baseSha,
    headSha: initial.headSha,
    diff,
    diffDigest: createHash('sha256').update(diff, 'utf8').digest('hex'),
    githubReads: githubReads + 1,
  };
}

export interface PullRequestIdentityInput {
  token: string;
  repo: string;
  prNumber: number;
}

/**
 * REL-1057: one read of the pull request's current base/head, under the run's
 * repository-scoped read token. Used to decide whether a late completion
 * rejection (HTTP 409) came from a head that has since moved.
 */
export async function readPullRequestIdentity(
  input: PullRequestIdentityInput,
  requestFn?: GitHubQualificationRequest,
): Promise<{ baseSha: string; headSha: string }> {
  const { owner, repo } = validateInput({
    ...input,
    expectedBaseSha: '0'.repeat(40),
    expectedHeadSha: '0'.repeat(40),
  });
  const octokit = requestFn ? undefined : new Octokit({ auth: input.token });
  const request = requestFn ?? (octokit!.request.bind(octokit) as unknown as GitHubQualificationRequest);
  return pullRequestIdentity((await safeRequest(request, { owner, repo, pull_number: input.prNumber }, 1)).data, 1);
}
