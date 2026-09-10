import { CommentPublisher, FetchImplementation, PublishReviewRequest, PublishResult } from './commentPublisher';
import { logger } from '../utils/logger';
import { repositoryVisibilityFrom, RepositoryVisibility } from '../review/repositoryVisibility';
import { ConfigResolver } from '../config/configResolver';
import {
  EVENT_TYPE_CI_REQUEST,
  ReviewCIRequestPayload,
  validateReviewCIRequestPayload,
} from './reviewCIRequest';

export interface PullRequestSnapshot {
  headSha: string;
  baseSha: string;
  title: string;
  body: string;
}

export interface ReviewComment {
  id: number;
  body: string;
  user?: { login: string };
  diff_hunk?: string;
  path?: string;
  in_reply_to_id?: number;
}

export interface ChangedFile {
  path: string;
  patch?: string;
  status?: string;
  mode?: string;
  previousPath?: string;
  oldSha?: string;
  newSha?: string;
  isSubmodule?: boolean;
  submoduleCandidate?: boolean;
  parentRepository?: string;
  oldSubmoduleUrl?: string;
  newSubmoduleUrl?: string;
  submoduleUrlChanged?: boolean;
}

function parseGitlinkPatch(patch: unknown): { oldSha?: string; newSha?: string; candidate: boolean } {
  if (typeof patch !== 'string') return { candidate: false };
  const result: { oldSha?: string; newSha?: string; candidate: boolean } = { candidate: false };
  const meaningfulLines = patch.split(/\r?\n/).filter((line) => line.trim() && !line.startsWith('diff --git') && !line.startsWith('index ') && !line.startsWith('old mode ') && !line.startsWith('new mode ') && !line.startsWith('new file mode ') && !line.startsWith('deleted file mode ') && !line.startsWith('--- ') && !line.startsWith('+++ ') && !line.startsWith(' ') && !/^@@ /u.test(line) && !/^\\ No newline/u.test(line));
  for (const line of patch.split(/\r?\n/)) {
    const match = line.match(/^([+-])Subproject commit ([0-9a-f]{40})$/i);
    if (!match) continue;
    result.candidate = true;
    if (match[1] === '-') result.oldSha = match[2];
    if (match[1] === '+') result.newSha = match[2];
  }
  if (result.candidate && meaningfulLines.some((line) => !/^([+-])Subproject commit [0-9a-f]{40}$/i.test(line))) return { candidate: false };
  return result;
}

function parseGitmodules(content: string, owner: string, repo: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  let current: { path?: string; url?: string } | undefined;
  const flush = () => {
    if (!current?.path || !current.url) return;
    const rawUrl = current.url;
    try {
      result[current.path] = rawUrl.startsWith('./') || rawUrl.startsWith('../')
        ? new URL(rawUrl, `https://github.com/${owner}/${repo}/`).toString()
        : rawUrl;
    } catch {
      result[current.path] = rawUrl;
    }
  };
  for (const line of content.split(/\r?\n/)) {
    const withoutComment = line.replace(/\s+[#;].*$/u, '');
    const section = withoutComment.match(/^\s*\[([^\]]+)\]\s*$/);
    if (section) {
      flush();
      current = /^submodule\s+(?:"[^"]+"|'[^']+'|[^\s]+)$/u.test(section[1].trim()) ? {} : undefined;
      continue;
    }
    if (!current) continue;
    const pathMatch = withoutComment.match(/^\s*path\s*=\s*(.+?)\s*$/);
    if (pathMatch) {
      current.path = pathMatch[1].trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/u, (_, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted);
      continue;
    }
    const urlMatch = withoutComment.match(/^\s*url\s*=\s*(.+?)\s*$/);
    if (urlMatch) current.url = urlMatch[1].trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/u, (_, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted);
  }
  flush();
  return result;
}

export const BASE_POLICY_CANDIDATE_FILES = ConfigResolver.CONFIG_FILES;

export const CHECK_CONTEXT_RAW_REVIEW = 'Review Yeti';
export const CHECK_CONTEXT_GATE = 'Review Yeti Gate';
export const CHECK_CONTEXT_CI = 'Review Yeti CI';

export interface GateCheckOptions {
  conclusion: 'success' | 'failure';
  title: string;
  summary: string;
  text?: string;
  detailsUrl?: string;
}

export interface ValidationCheckOptions {
  conclusion: 'success' | 'failure';
  title: string;
  summary: string;
  text?: string;
  detailsUrl?: string;
}

export class GitHubInstallationClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly publisher: CommentPublisher;
  private readonly now: () => number;
  private readonly fetchImplementation: FetchImplementation;
  private readonly repositoryVisibilityCache = new Map<string, Promise<RepositoryVisibility>>();

  constructor(options: {
    token: string;
    publisherLogin?: string;
    baseUrl?: string;
    fetchImplementation?: FetchImplementation;
    /** @deprecated Use fetchImplementation. */
    fetchImpl?: FetchImplementation;
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
    random?: () => number;
    currentHeadSha?: () => Promise<string>;
  }) {
    if (!options.token.startsWith('ghs_')) {
      throw new Error('GitHubInstallationClient requires a ghs_ installation token');
    }
    this.token = options.token;
    this.baseUrl = (options.baseUrl || 'https://api.github.com').replace(/\/+$/, '');
    this.now = options.now || Date.now;
    this.fetchImplementation = options.fetchImplementation || options.fetchImpl || ((input, init) => globalThis.fetch(input, init));
    this.publisher = new CommentPublisher({
      githubToken: options.token,
      publisherLogin: options.publisherLogin,
      baseUrl: this.baseUrl,
      fetchImplementation: options.fetchImplementation || options.fetchImpl,
      now: this.now,
      sleep: options.sleep,
      random: options.random,
      currentHeadSha: options.currentHeadSha,
    });
  }

  private async request(path: string, init: RequestInit = {}): Promise<any> {
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/vnd.github+json');
    headers.set('Authorization', `Bearer ${this.token}`);
    headers.set('User-Agent', 'ct-review-bot[bot]');
    headers.set('X-GitHub-Api-Version', '2022-11-28');
    if (init.body) headers.set('Content-Type', 'application/json');
    const response = await this.fetchImplementation(`${this.baseUrl}${path}`, { ...init, headers });
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok) throw new Error(`GitHub API ${response.status} ${path}: ${text}`);
    return data;
  }

  async getPullRequest(owner: string, repo: string, prNumber: number): Promise<PullRequestSnapshot> {
    const data = await this.request(`/repos/${owner}/${repo}/pulls/${prNumber}`);
    return {
      headSha: String(data.head?.sha || ''),
      baseSha: String(data.base?.sha || ''),
      title: String(data.title || ''),
      body: String(data.body || ''),
    };
  }

  /**
   * Fallback source of repository visibility for run modes whose webhook payload
   * did not carry `repository.private`/`repository.visibility` (ct-meta#2884). A
   * lookup failure of any kind -- 404, rate limit, network error, malformed body --
   * must never fail or block the review it was requested for, so every error path
   * resolves to 'UNKNOWN' rather than rejecting. Memoised per client instance per
   * `owner/repo` since a single review run may ask more than once (persona +
   * moderator + arbiter) and visibility does not change mid-run.
   */
  async getRepositoryVisibility(owner: string, repo: string): Promise<RepositoryVisibility> {
    const key = `${owner}/${repo}`;
    const cached = this.repositoryVisibilityCache.get(key);
    if (cached) return cached;
    const lookup = (async (): Promise<RepositoryVisibility> => {
      try {
        const data = await this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
        return repositoryVisibilityFrom(data);
      } catch (error: any) {
        logger.warn(`Repository visibility lookup failed for ${key}; falling back to UNKNOWN`, {
          error: error?.message || error,
        });
        return 'UNKNOWN';
      }
    })();
    this.repositoryVisibilityCache.set(key, lookup);
    return lookup;
  }

  async getBasePolicy(owner: string, repo: string, baseSha: string): Promise<string> {
    let first404Error: Error | undefined;

    for (const configFile of BASE_POLICY_CANDIDATE_FILES) {
      try {
        const data = await this.request(`/repos/${owner}/${repo}/contents/${configFile}?ref=${encodeURIComponent(baseSha)}`);
        if (!data || data.encoding !== 'base64' || typeof data.content !== 'string') {
          throw new Error('base policy response is not base64 file content');
        }
        return Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8');
      } catch (err: any) {
        const message = err instanceof Error ? err.message : String(err);
        if (/^GitHub API 404\b/u.test(message)) {
          if (!first404Error) {
            first404Error = err instanceof Error ? err : new Error(message);
          }
          continue;
        }
        throw err;
      }
    }

    if (first404Error) {
      throw first404Error;
    }
    throw new Error('base policy response is not base64 file content');
  }

  async getChangedFiles(owner: string, repo: string, prNumber: number): Promise<ChangedFile[]> {
    const files: ChangedFile[] = [];
    for (let page = 1; page <= 30; page++) {
      const data = await this.request(`/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`);
      if (!Array.isArray(data)) throw new Error('pull files response is not an array');
      files.push(...data.map((file: any) => {
        const mode = typeof file.mode === 'string' ? file.mode : undefined;
        const isSubmodule = mode === '160000';
        const gitlink = parseGitlinkPatch(file.patch);
        return {
          path: String(file.filename || ''),
          ...(typeof file.patch === 'string' ? { patch: file.patch } : {}),
          ...(typeof file.status === 'string' ? { status: file.status } : {}),
          ...(mode ? { mode } : {}),
          ...(typeof file.previous_filename === 'string' ? { previousPath: file.previous_filename } : {}),
          ...(isSubmodule && (typeof file.previous_sha === 'string' || gitlink.oldSha) ? { oldSha: typeof file.previous_sha === 'string' ? file.previous_sha : gitlink.oldSha } : {}),
          ...(isSubmodule && (typeof file.sha === 'string' || gitlink.newSha) ? { newSha: typeof file.sha === 'string' ? file.sha : gitlink.newSha } : {}),
          ...(isSubmodule && typeof file.previous_submodule_url === 'string' ? { oldSubmoduleUrl: file.previous_submodule_url } : {}),
          ...(isSubmodule && typeof file.submodule_url === 'string' ? { newSubmoduleUrl: file.submodule_url } : {}),
          ...(isSubmodule && file.submodule_url_changed === true ? { submoduleUrlChanged: true } : {}),
          ...(gitlink.oldSha && !isSubmodule ? { oldSha: gitlink.oldSha } : {}),
          ...(gitlink.newSha && !isSubmodule ? { newSha: gitlink.newSha } : {}),
          ...(isSubmodule ? { isSubmodule: true } : {}),
          ...(gitlink.candidate && !isSubmodule ? { submoduleCandidate: true } : {}),
          ...((isSubmodule || gitlink.candidate) ? { parentRepository: `${owner}/${repo}` } : {}),
        };
      }));
      if (data.length < 100) break;
    }
    return files;
  }

  async getSubmoduleUrls(owner: string, repo: string, ref: string): Promise<Record<string, string>> {
    const content = await this.getFileContent(owner, repo, '.gitmodules', ref, { notFoundIsEmpty: true });
    return content ? parseGitmodules(content, owner, repo) : {};
  }

  publishReview(request: PublishReviewRequest): Promise<PublishResult> {
    return this.publisher.publishReview(request);
  }

  async createCheck(
    owner: string,
    repo: string,
    headSha: string,
    name: string = CHECK_CONTEXT_RAW_REVIEW,
    output?: { title?: string; summary?: string },
  ): Promise<number> {
    const defaultOutput = name === CHECK_CONTEXT_RAW_REVIEW
      ? {
          title: 'Configurable persona panel running',
          summary: 'Loading base-SHA policy and executing enabled persona lanes.',
        }
      : {
          title: `${name} in progress`,
          summary: `Executing ${name} validation.`,
        };
    const data = await this.request(`/repos/${owner}/${repo}/check-runs`, {
      method: 'POST',
      body: JSON.stringify({
        // REL-586: must match the check name the central lane (ct-review-actions
        // review-yeti.yml) publishes as `in_progress` when it dispatches to DOKS.
        // GitHub supersedes check runs by name+app, so a mismatched name (formerly
        // `Review Yeti / Gate`) left the central check stuck in_progress forever
        // because this App's own check never completed the one the central lane
        // created. Do not rename this without updating the central publisher too.
        name,
        head_sha: headSha,
        status: 'in_progress',
        output: output || defaultOutput,
      }),
    });
    return Number(data.id);
  }

  async publishGateCheck(
    owner: string,
    repo: string,
    headSha: string,
    options: GateCheckOptions,
  ): Promise<number> {
    const data = await this.request(`/repos/${owner}/${repo}/check-runs`, {
      method: 'POST',
      body: JSON.stringify({
        name: CHECK_CONTEXT_GATE,
        head_sha: headSha,
        status: 'completed',
        conclusion: options.conclusion,
        completed_at: new Date(this.now()).toISOString(),
        output: {
          title: options.title,
          summary: options.summary.slice(0, 65_000),
          ...(options.text ? { text: options.text.slice(0, 65_000) } : {}),
        },
        ...(options.detailsUrl ? { details_url: options.detailsUrl } : {}),
      }),
    });
    return Number(data.id);
  }

  async publishValidationCheck(
    owner: string,
    repo: string,
    headSha: string,
    options: ValidationCheckOptions,
  ): Promise<number> {
    const data = await this.request(`/repos/${owner}/${repo}/check-runs`, {
      method: 'POST',
      body: JSON.stringify({
        name: CHECK_CONTEXT_CI,
        head_sha: headSha,
        status: 'completed',
        conclusion: options.conclusion,
        completed_at: new Date(this.now()).toISOString(),
        output: {
          title: options.title,
          summary: options.summary.slice(0, 65_000),
          ...(options.text ? { text: options.text.slice(0, 65_000) } : {}),
        },
        ...(options.detailsUrl ? { details_url: options.detailsUrl } : {}),
      }),
    });
    return Number(data.id);
  }

  /**
   * Emits an authenticated repository_dispatch event to a target repository.
   * Requires `contents: write` permission on the target repository.
   */
  async emitRepositoryDispatch(
    owner: string,
    repo: string,
    eventType: string,
    clientPayload: Record<string, unknown>,
  ): Promise<void> {
    await this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/dispatches`, {
      method: 'POST',
      body: JSON.stringify({
        event_type: eventType,
        client_payload: clientPayload,
      }),
    });
  }

  /**
   * Emits the authoritative `review-yeti-ci-request` completion event.
   * Validates the payload against `review-yeti-ci-request.v1` before network transmission.
   */
  async emitCIRequest(
    owner: string,
    repo: string,
    payload: ReviewCIRequestPayload,
  ): Promise<void> {
    const validation = validateReviewCIRequestPayload(payload);
    if (!validation.valid) {
      throw new Error(`Invalid review-yeti-ci-request payload: ${validation.error}`);
    }
    await this.emitRepositoryDispatch(owner, repo, EVENT_TYPE_CI_REQUEST, validation.value as unknown as Record<string, unknown>);
  }

  /**
   * `text` and `annotations` are part of the check-run output and need only
   * `checks: write` -- the permission this token already holds. Publishing
   * findings here rather than as a pull-request review is what keeps the
   * app-gate worker inside its ADR 0541 boundary: it never needs
   * `pull_requests: write`.
   *
   * GitHub accepts at most 50 annotations per request, so callers must batch.
   */
  async completeCheck(options: {
    owner: string;
    repo: string;
    checkId: number;
    conclusion: 'success' | 'failure' | 'cancelled';
    title: string;
    summary: string;
    text?: string;
    annotations?: Array<{
      path: string;
      start_line: number;
      end_line: number;
      annotation_level: 'notice' | 'warning' | 'failure';
      message: string;
      title?: string;
    }>;
  }): Promise<void> {
    const output: Record<string, unknown> = {
      title: options.title,
      summary: options.summary.slice(0, 65_000),
    };
    if (options.text) output.text = options.text.slice(0, 65_000);
    if (options.annotations && options.annotations.length > 0) {
      output.annotations = options.annotations.slice(0, 50);
    }
    await this.request(`/repos/${options.owner}/${options.repo}/check-runs/${options.checkId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'completed',
        conclusion: options.conclusion,
        completed_at: new Date(this.now()).toISOString(),
        output,
      }),
    });
  }

  async postIssueComment(owner: string, repo: string, prNumber: number, body: string): Promise<void> {
    await this.request(`/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
  }

  async getReviewCommentThread(owner: string, repo: string, prNumber: number, commentId: number): Promise<ReviewComment[]> {
    try {
      const allComments = await this.request(`/repos/${owner}/${repo}/pulls/${prNumber}/comments`);
      if (!Array.isArray(allComments)) return [];
      const root = allComments.find((c: any) => c.id === commentId);
      const replies = allComments.filter((c: any) => c.in_reply_to_id === commentId);
      if (root) {
        return [root, ...replies];
      }
    } catch {
      // Fall through to single comment endpoint fallback
    }

    try {
      const data = await this.request(`/repos/${owner}/${repo}/pulls/comments/${commentId}`);
      if (data && typeof data === 'object' && typeof data.id === 'number') {
        return [data];
      }
      return [];
    } catch {
      return [];
    }
  }

  async getReviewComment(owner: string, repo: string, commentId: number): Promise<ReviewComment | null> {
    try {
      const data = await this.request(`/repos/${owner}/${repo}/pulls/comments/${commentId}`);
      if (data && typeof data === 'object' && typeof data.id === 'number') {
        return data as ReviewComment;
      }
      return null;
    } catch {
      return null;
    }
  }

  async replyToReviewComment(owner: string, repo: string, prNumber: number, commentId: number, body: string): Promise<void> {
    await this.request(`/repos/${owner}/${repo}/pulls/${prNumber}/comments/${commentId}/replies`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
  }

  async getIncrementalDiff(owner: string, repo: string, baseSha: string, headSha: string): Promise<any> {
    const encBase = encodeURIComponent(baseSha);
    const encHead = encodeURIComponent(headSha);
    const data = await this.request(`/repos/${owner}/${repo}/compare/${encBase}...${encHead}`);
    const rawFiles = Array.isArray(data) ? data : Array.isArray(data.files) ? data.files : [];
    const files = rawFiles.map((file: any) => ({
      path: String(file.filename || file.path || ''),
      ...(typeof file.patch === 'string' ? { patch: file.patch } : {}),
    }));
    Object.assign(files, {
      status: data.status,
      ahead_by: data.ahead_by,
      behind_by: data.behind_by,
      total_commits: data.total_commits,
      files,
    });
    return files;
  }

  async getFileContent(owner: string, repo: string, path: string, ref?: string, options: { notFoundIsEmpty?: boolean } = {}): Promise<string | null> {
    try {
      const url = `/repos/${owner}/${repo}/contents/${path}` + (ref ? `?ref=${encodeURIComponent(ref)}` : '');
      const data = await this.request(url);
      if (data.encoding === 'base64' && typeof data.content === 'string') {
        return Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8');
      }
      if (typeof data.content === 'string') {
        return data.content;
      }
      return null;
    } catch (error) {
      if (options.notFoundIsEmpty && !/^GitHub API 404\b/u.test(error instanceof Error ? error.message : String(error))) {
        throw error;
      }
      return null;
    }
  }

  /**
   * List every file path in the repository at `ref` (recursive git tree), not just files changed
   * in a PR. Backs the panel engine's full-repository `find_files`/`read_file` persona tools (see
   * `RepoFileProvider` in `src/panel/panelEngine.ts`) so a persona can confirm whether a file the
   * diff references, but does not itself change, actually exists.
   *
   * GitHub truncates this response (`truncated: true`) past ~100k entries / ~7MB for very large
   * trees; callers should treat a truncated result as a best-effort partial index, not proof of
   * absence, rather than paginating further (the Git Trees API has no pagination parameter).
   */
  async getFileTree(owner: string, repo: string, ref: string): Promise<{ paths: string[]; truncated: boolean }> {
    const data = await this.request(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
    if (!Array.isArray(data.tree)) throw new Error('git tree response is not an array');
    const paths = data.tree
      .filter((entry: any) => entry && entry.type === 'blob' && typeof entry.path === 'string')
      .map((entry: any) => String(entry.path));
    return { paths, truncated: data.truncated === true };
  }

  /** Get reference SHA for a branch */
  async getBranchRef(owner: string, repo: string, branch: string): Promise<string> {
    const data = await this.request(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
    return data.object?.sha || data.sha;
  }

  /** Create a new Git branch ref */
  async createBranch(owner: string, repo: string, newBranch: string, sha: string): Promise<void> {
    await this.request(`/repos/${owner}/${repo}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({
        ref: `refs/heads/${newBranch}`,
        sha,
      }),
    });
  }

  /** Create or update a file in a branch */
  async createOrUpdateFile(options: {
    owner: string;
    repo: string;
    path: string;
    message: string;
    content: string;
    branch: string;
    sha?: string;
  }): Promise<{ sha: string }> {
    const base64Content = Buffer.from(options.content, 'utf8').toString('base64');
    const body: Record<string, any> = {
      message: options.message,
      content: base64Content,
      branch: options.branch,
    };
    if (options.sha) body.sha = options.sha;

    const data = await this.request(`/repos/${options.owner}/${options.repo}/contents/${options.path}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    return { sha: data.content?.sha || 'sha-updated' };
  }

  /** Create a Pull Request */
  async createPullRequest(options: {
    owner: string;
    repo: string;
    title: string;
    body: string;
    head: string;
    base: string;
  }): Promise<{ number: number; html_url: string }> {
    const data = await this.request(`/repos/${options.owner}/${options.repo}/pulls`, {
      method: 'POST',
      body: JSON.stringify(options),
    });
    return { number: data.number, html_url: data.html_url || `https://github.com/${options.owner}/${options.repo}/pull/${data.number}` };
  }
}
