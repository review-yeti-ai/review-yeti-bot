import { createHash } from 'node:crypto';
import { Octokit } from '@octokit/core';

const PR_ROUTE = 'GET /repos/{owner}/{repo}/pulls/{pull_number}';
const DIFF_ACCEPT = 'application/vnd.github.v3.diff';
const MAX_QUALIFICATION_DIFF_BYTES = 2_000_000;

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
  githubReads: 3;
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
  constructor(message: string, readonly githubReads: number) {
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
): Promise<PullRequestResponse> {
  try {
    return await request(PR_ROUTE, parameters);
  } catch (error) {
    const status = Number((error as { status?: unknown })?.status);
    if (Number.isInteger(status) && status >= 100 && status <= 599) {
      throw new GitHubQualificationReadError(`GitHub qualification read failed HTTP ${status}`, githubReads);
    }
    throw new GitHubQualificationReadError('GitHub qualification read failed', githubReads);
  }
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

  const diffResponse = await safeRequest(request, {
    ...parameters,
    headers: { accept: DIFF_ACCEPT },
  }, 2);
  if (typeof diffResponse.data !== 'string') {
    throw new GitHubQualificationReadError('GitHub qualification diff response is invalid', 2);
  }
  const diffBytes = Buffer.byteLength(diffResponse.data, 'utf8');
  if (diffBytes < 1 || diffBytes > MAX_QUALIFICATION_DIFF_BYTES) {
    throw new GitHubQualificationReadError('GitHub qualification diff size is outside qualification bounds', 2);
  }

  const final = pullRequestIdentity((await safeRequest(request, parameters, 3)).data, 3);
  if (final.baseSha !== input.expectedBaseSha || final.headSha !== input.expectedHeadSha) {
    throw new GitHubQualificationReadError('GitHub pull request moved during qualification read', 3);
  }

  return {
    baseSha: initial.baseSha,
    headSha: initial.headSha,
    diff: diffResponse.data,
    diffDigest: createHash('sha256').update(diffResponse.data, 'utf8').digest('hex'),
    githubReads: 3,
  };
}
