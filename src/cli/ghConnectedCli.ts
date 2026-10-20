import { execFileSync } from 'node:child_process';
import { runLocalReview, LocalReviewOptions, LocalReviewResult } from './localReview';
import type { CheckRunAgentEvaluation } from '../github/checkRunAgentExecutor';
import type { ApprovabilityDecision } from '../review/approvabilityEngine';

export interface GhPrTarget {
  owner: string;
  repo: string;
  prNumber: number;
  headSha?: string;
  title?: string;
  htmlUrl?: string;
}

export interface GhPrCheckRunItem {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  title?: string;
  summary?: string;
}

export interface GhPrReviewCommentItem {
  id: number;
  path: string;
  line?: number;
  body: string;
  author: string;
  createdAt: string;
}

export interface GhPrStatusOptions {
  repo?: string;
  prNumber?: number;
  cwd?: string;
  token?: string;
  json?: boolean;
  raw?: boolean;
  quiet?: boolean;
  fetchFn?: typeof fetch;
  execGhFn?: (args: string[], cwd?: string) => string;
}

export interface GhPrStatusResult {
  exitCode: number;
  target: GhPrTarget;
  approvable: boolean;
  approvabilityStatus: 'Approved' | 'Needs Human Approval' | 'Pending';
  checkRuns: GhPrCheckRunItem[];
  inlineComments: GhPrReviewCommentItem[];
}

export interface GhPrRemoteReviewOptions extends LocalReviewOptions {
  repo?: string;
  prNumber?: number;
  publish?: boolean;
  token?: string;
  fetchFn?: typeof fetch;
  execGhFn?: (args: string[], cwd?: string) => string;
}

export interface GhPrRemoteReviewResult extends LocalReviewResult {
  target: GhPrTarget;
  published: boolean;
  publishedReviewId?: number;
  publishedCheckIds?: number[];
}

function defaultExecGh(args: string[], cwd?: string): string {
  return execFileSync('gh', args, {
    cwd: cwd || process.cwd(),
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Resolves a GitHub token from `options.token`, `GITHUB_TOKEN`, `GH_TOKEN`, or `gh auth token`.
 */
export function resolveGhToken(
  options: { token?: string; cwd?: string; execGhFn?: (args: string[], cwd?: string) => string } = {}
): string | undefined {
  if (options.token && options.token.trim()) {
    return options.token.trim();
  }
  const envToken = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim();
  if (envToken) {
    return envToken;
  }
  const execGh = options.execGhFn || defaultExecGh;
  try {
    const token = execGh(['auth', 'token'], options.cwd);
    if (token) return token;
  } catch {
    // gh not authenticated or not installed
  }
  return undefined;
}

/**
 * Parses `owner/repo` from a git remote URL or `owner/repo` slug.
 */
export function parseRepoSlug(input: string): { owner: string; repo: string } | null {
  const trimmed = input.trim().replace(/\.git$/u, '');
  const slugMatch = trimmed.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u);
  if (slugMatch) {
    return { owner: slugMatch[1], repo: slugMatch[2] };
  }
  const urlMatch = trimmed.match(/github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u);
  if (urlMatch) {
    return { owner: urlMatch[1], repo: urlMatch[2] };
  }
  return null;
}

/**
 * Resolves `{ owner, repo, prNumber }` from CLI flags, git remote, or `gh pr view`.
 */
export function resolveGhPrTarget(options: {
  repo?: string;
  prNumber?: number;
  cwd?: string;
  execGhFn?: (args: string[], cwd?: string) => string;
}): GhPrTarget {
  const cwd = options.cwd || process.cwd();
  const execGh = options.execGhFn || defaultExecGh;

  let owner = '';
  let repo = '';

  if (options.repo) {
    const parsed = parseRepoSlug(options.repo);
    if (parsed) {
      owner = parsed.owner;
      repo = parsed.repo;
    }
  }

  if (!owner || !repo) {
    try {
      const originUrl = execFileSync('git', ['remote', 'get-url', 'origin'], {
        cwd,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      const parsed = parseRepoSlug(originUrl);
      if (parsed) {
        owner = parsed.owner;
        repo = parsed.repo;
      }
    } catch {
      // Fallback to gh repo view
    }
  }

  if (!owner || !repo) {
    try {
      const nameWithOwner = execGh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], cwd);
      const parsed = parseRepoSlug(nameWithOwner);
      if (parsed) {
        owner = parsed.owner;
        repo = parsed.repo;
      }
    } catch {
      // Handled below
    }
  }

  let prNumber = options.prNumber || 0;
  let headSha: string | undefined;
  let title: string | undefined;
  let htmlUrl: string | undefined;

  if (!prNumber) {
    try {
      const prJsonRaw = execGh(['pr', 'view', '--json', 'number,headRefOid,title,url'], cwd);
      const prJson = JSON.parse(prJsonRaw);
      if (typeof prJson.number === 'number') {
        prNumber = prJson.number;
        headSha = prJson.headRefOid;
        title = prJson.title;
        htmlUrl = prJson.url;
      }
    } catch {
      // Handled below
    }
  }

  if (!owner || !repo) {
    throw new Error('Could not resolve GitHub repository (pass --repo owner/repo or run inside a git repository).');
  }
  if (!prNumber || Number.isNaN(prNumber)) {
    throw new Error('Could not resolve Pull Request number (pass --pr <number> or check out an open PR branch).');
  }

  return {
    owner,
    repo,
    prNumber,
    headSha,
    title,
    htmlUrl,
  };
}

/**
 * Fetches live PR status, Review Yeti Check Runs (`Review Yeti / *`), Approvability state,
 * and inline review comments via GitHub API (or `gh`).
 */
export async function runGhPrStatus(options: GhPrStatusOptions = {}): Promise<GhPrStatusResult> {
  const fetchFn = options.fetchFn || globalThis.fetch;
  const target = resolveGhPrTarget(options);
  const token = resolveGhToken(options);

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'review-yeti-cli',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const baseUrl = `https://api.github.com/repos/${target.owner}/${target.repo}`;

  // 1. Fetch PR metadata if headSha not already populated
  if (!target.headSha || !target.title) {
    const prResp = await fetchFn(`${baseUrl}/pulls/${target.prNumber}`, { headers });
    if (!prResp.ok) {
      throw new Error(`GitHub API error fetching PR #${target.prNumber}: HTTP ${prResp.status}`);
    }
    const prData = (await prResp.json()) as any;
    target.headSha = prData.head?.sha || target.headSha;
    target.title = prData.title || target.title;
    target.htmlUrl = prData.html_url || target.htmlUrl;
  }

  // 2. Fetch Check Runs for headSha
  let checkRuns: GhPrCheckRunItem[] = [];
  if (target.headSha) {
    const checksResp = await fetchFn(`${baseUrl}/commits/${target.headSha}/check-runs`, { headers });
    if (checksResp.ok) {
      const checksData = (await checksResp.json()) as any;
      const rawRuns = Array.isArray(checksData?.check_runs) ? checksData.check_runs : [];
      checkRuns = rawRuns
        .filter((r: any) => typeof r.name === 'string' && /review\s*yeti/i.test(r.name))
        .map((r: any) => ({
          id: Number(r.id),
          name: String(r.name),
          status: String(r.status || 'completed'),
          conclusion: r.conclusion ? String(r.conclusion) : null,
          title: r.output?.title ? String(r.output.title) : undefined,
          summary: r.output?.summary ? String(r.output.summary) : undefined,
        }));
    }
  }

  // 3. Fetch inline PR review comments
  let inlineComments: GhPrReviewCommentItem[] = [];
  const commentsResp = await fetchFn(`${baseUrl}/pulls/${target.prNumber}/comments`, { headers });
  if (commentsResp.ok) {
    const rawComments = (await commentsResp.json()) as any[];
    if (Array.isArray(rawComments)) {
      inlineComments = rawComments.map((c: any) => ({
        id: Number(c.id),
        path: String(c.path || ''),
        line: typeof c.line === 'number' ? c.line : typeof c.original_line === 'number' ? c.original_line : undefined,
        body: String(c.body || ''),
        author: String(c.user?.login || 'review-yeti[bot]'),
        createdAt: String(c.created_at || ''),
      }));
    }
  }

  const hasFailure = checkRuns.some((c) => c.conclusion === 'failure' || c.conclusion === 'action_required');
  const hasPending = checkRuns.some((c) => c.status !== 'completed');
  const approvable = !hasFailure && !hasPending && inlineComments.length === 0;
  const approvabilityStatus: 'Approved' | 'Needs Human Approval' | 'Pending' = hasFailure || inlineComments.length > 0
    ? 'Needs Human Approval'
    : hasPending
      ? 'Pending'
      : 'Approved';
  const exitCode = hasFailure ? 1 : 0;

  if (options.raw) {
    for (const c of inlineComments) {
      console.log(
        JSON.stringify({
          type: 'pr_comment',
          prNumber: target.prNumber,
          path: c.path,
          line: c.line,
          author: c.author,
          body: c.body,
        })
      );
    }
    console.log(
      JSON.stringify({
        type: 'pr_status',
        repo: `${target.owner}/${target.repo}`,
        prNumber: target.prNumber,
        headSha: target.headSha,
        approvable,
        approvabilityStatus,
        checkRunsCount: checkRuns.length,
        inlineCommentsCount: inlineComments.length,
      })
    );
  } else if (options.json) {
    console.log(
      JSON.stringify(
        {
          exitCode,
          target,
          approvable,
          approvabilityStatus,
          checkRuns,
          inlineComments,
        },
        null,
        2
      )
    );
  } else if (!options.quiet) {
    console.log(
      `\n🐙 Review Yeti PR Status — ${target.owner}/${target.repo} #${target.prNumber}${target.title ? ` (${target.title})` : ''}`
    );
    console.log(`   Approvability: ${approvabilityStatus} | Check Runs: ${checkRuns.length} | Inline Findings: ${inlineComments.length}`);
    for (const check of checkRuns) {
      const icon = check.conclusion === 'success' ? '✅' : check.conclusion === 'failure' ? '❌' : '⏳';
      console.log(`   ${icon} ${check.name}: ${check.title || check.conclusion || check.status}`);
    }
    for (const comment of inlineComments) {
      const loc = `${comment.path}${comment.line ? `:${comment.line}` : ''}`;
      console.log(`   💬 ${loc} — ${comment.body.split('\n')[0]}`);
    }
  }

  return {
    exitCode,
    target,
    approvable,
    approvabilityStatus,
    checkRuns,
    inlineComments,
  };
}

/**
 * Fetches a remote GitHub Pull Request diff, evaluates it locally with `.reviewyeti/` rules,
 * custom Check Run Agents (`.reviewyeti/checks/*.md`), and Approvability engine, and optionally
 * publishes the review and check runs back to GitHub (`--publish`).
 */
export async function runGhPrReview(options: GhPrRemoteReviewOptions = {}): Promise<GhPrRemoteReviewResult> {
  const fetchFn = options.fetchFn || globalThis.fetch;
  const execGh = options.execGhFn || defaultExecGh;
  const target = resolveGhPrTarget(options);
  const token = resolveGhToken(options);

  const headers: Record<string, string> = {
    'User-Agent': 'review-yeti-cli',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const baseUrl = `https://api.github.com/repos/${target.owner}/${target.repo}`;

  // Fetch PR metadata for headSha if needed
  if (!target.headSha) {
    try {
      const prResp = await fetchFn(`${baseUrl}/pulls/${target.prNumber}`, {
        headers: { ...headers, Accept: 'application/vnd.github+json' },
      });
      if (prResp.ok) {
        const prData = (await prResp.json()) as any;
        target.headSha = prData.head?.sha;
        target.title = prData.title;
      }
    } catch {
      // Ignore metadata error if diff succeeds
    }
  }

  // Fetch PR diff via GitHub API or `gh pr diff`
  let diffText = options.diff || '';
  if (!diffText) {
    try {
      const diffResp = await fetchFn(`${baseUrl}/pulls/${target.prNumber}`, {
        headers: { ...headers, Accept: 'application/vnd.github.v3.diff' },
      });
      if (diffResp.ok) {
        diffText = await diffResp.text();
      }
    } catch {
      // Fallback to `gh pr diff`
    }
  }
  if (!diffText) {
    try {
      diffText = execGh(['pr', 'diff', String(target.prNumber)], options.cwd);
    } catch (err: any) {
      throw new Error(`Failed to fetch diff for PR #${target.prNumber}: ${err?.message || err}`);
    }
  }

  const localResult = await runLocalReview({
    ...options,
    diff: diffText,
  });

  let published = false;
  let publishedReviewId: number | undefined;
  const publishedCheckIds: number[] = [];

  if (options.publish) {
    if (!token) {
      throw new Error('Cannot publish PR review without a GitHub token (run `gh auth login` or set GITHUB_TOKEN).');
    }
    const jsonHeaders = {
      ...headers,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    };

    const approvability: ApprovabilityDecision | undefined = localResult.approvability;
    const reviewBody = approvability
      ? `### ${approvability.title}\n\n${approvability.summary}`
      : localResult.clean
        ? '### Approved — 0 blocking findings\n\nAll correctness and security checks passed.'
        : `### Needs Human Approval\n\nDetected ${localResult.findings.length} finding(s).`;

    const reviewResp = await fetchFn(`${baseUrl}/pulls/${target.prNumber}/reviews`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        ...(target.headSha ? { commit_id: target.headSha } : {}),
        event: 'COMMENT',
        body: reviewBody,
      }),
    });

    if (reviewResp.ok) {
      const reviewJson = (await reviewResp.json()) as any;
      publishedReviewId = typeof reviewJson?.id === 'number' ? reviewJson.id : undefined;
      published = true;
    }

    if (target.headSha && Array.isArray(localResult.checkEvaluations)) {
      for (const ev of localResult.checkEvaluations as CheckRunAgentEvaluation[]) {
        if (ev.matchedFiles.length === 0) continue;
        const checkResp = await fetchFn(`${baseUrl}/check-runs`, {
          method: 'POST',
          headers: jsonHeaders,
          body: JSON.stringify({
            name: ev.checkName,
            head_sha: target.headSha,
            status: 'completed',
            conclusion: ev.conclusion,
            output: {
              title: ev.title,
              summary: ev.summary,
            },
          }),
        });
        if (checkResp.ok) {
          const checkJson = (await checkResp.json()) as any;
          if (typeof checkJson?.id === 'number') {
            publishedCheckIds.push(checkJson.id);
          }
        }
      }
    }
  }

  return {
    ...localResult,
    target,
    published,
    publishedReviewId,
    publishedCheckIds,
  };
}
