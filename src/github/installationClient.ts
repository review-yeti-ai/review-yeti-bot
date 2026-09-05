import { CommentPublisher, FetchImplementation, PublishReviewRequest, PublishResult } from './commentPublisher';

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

export class GitHubInstallationClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly publisher: CommentPublisher;
  private readonly now: () => number;
  private readonly fetchImplementation: FetchImplementation;

  constructor(options: {
    token: string;
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

  async getBasePolicy(owner: string, repo: string, baseSha: string): Promise<string> {
    const data = await this.request(`/repos/${owner}/${repo}/contents/.ct-review.yaml?ref=${encodeURIComponent(baseSha)}`);
    if (data.encoding !== 'base64' || typeof data.content !== 'string') {
      throw new Error('base policy response is not base64 file content');
    }
    return Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8');
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

  async createCheck(owner: string, repo: string, headSha: string): Promise<number> {
    const data = await this.request(`/repos/${owner}/${repo}/check-runs`, {
      method: 'POST',
      body: JSON.stringify({
        // REL-586: must match the check name the central lane (ct-review-actions
        // review-yeti.yml) publishes as `in_progress` when it dispatches to DOKS.
        // GitHub supersedes check runs by name+app, so a mismatched name (formerly
        // `Review Yeti / Gate`) left the central check stuck in_progress forever
        // because this App's own check never completed the one the central lane
        // created. Do not rename this without updating the central publisher too.
        name: 'Review Yeti',
        head_sha: headSha,
        status: 'in_progress',
        output: {
          title: 'Configurable persona panel running',
          summary: 'Loading base-SHA policy and executing enabled persona lanes.',
        },
      }),
    });
    return Number(data.id);
  }

  async completeCheck(options: {
    owner: string;
    repo: string;
    checkId: number;
    conclusion: 'success' | 'failure' | 'cancelled';
    title: string;
    summary: string;
  }): Promise<void> {
    await this.request(`/repos/${options.owner}/${options.repo}/check-runs/${options.checkId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'completed',
        conclusion: options.conclusion,
        completed_at: new Date(this.now()).toISOString(),
        output: { title: options.title, summary: options.summary.slice(0, 65_000) },
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
