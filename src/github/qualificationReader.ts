import { createHash } from 'node:crypto';
import { Octokit } from '@octokit/core';

const PR_ROUTE = 'GET /repos/{owner}/{repo}/pulls/{pull_number}';
const FILES_ROUTE = 'GET /repos/{owner}/{repo}/pulls/{pull_number}/files';
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
): Promise<{ diff: string; githubReads: number }> {
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
): Promise<SameHeadReviewSource> {
  const { owner, repo } = validateInput(input);
  const octokit = requestFn ? undefined : new Octokit({ auth: input.token });
  const request = requestFn ?? (octokit!.request.bind(octokit) as unknown as GitHubQualificationRequest);
  const parameters = { owner, repo, pull_number: input.prNumber };

  const initial = pullRequestIdentity((await safeRequest(request, parameters, 1)).data, 1);
  if (initial.baseSha !== input.expectedBaseSha || initial.headSha !== input.expectedHeadSha) {
    throw new GitHubQualificationReadError('GitHub projected pull request identity mismatch', 1);
  }

  const { diff, githubReads } = await readQualificationDiff(request, parameters, 1);
  const diffBytes = Buffer.byteLength(diff, 'utf8');
  if (diffBytes < 1 || diffBytes > MAX_QUALIFICATION_DIFF_BYTES) {
    throw new GitHubQualificationReadError('GitHub qualification diff size is outside qualification bounds', githubReads);
  }

  const final = pullRequestIdentity((await safeRequest(request, parameters, githubReads + 1)).data, githubReads + 1);
  if (final.baseSha !== input.expectedBaseSha || final.headSha !== input.expectedHeadSha) {
    throw new GitHubQualificationReadError('GitHub pull request moved during qualification read', githubReads + 1);
  }

  return {
    baseSha: initial.baseSha,
    headSha: initial.headSha,
    diff,
    diffDigest: createHash('sha256').update(diff, 'utf8').digest('hex'),
    githubReads: githubReads + 1,
  };
}
