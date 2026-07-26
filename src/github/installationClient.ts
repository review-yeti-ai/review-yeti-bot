import { CommentPublisher, PublishReviewRequest, PublishResult } from './commentPublisher';

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
}

export class GitHubInstallationClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly publisher: CommentPublisher;

  constructor(options: { token: string; baseUrl?: string }) {
    if (!options.token.startsWith('ghs_')) {
      throw new Error('GitHubInstallationClient requires a ghs_ installation token');
    }
    this.token = options.token;
    this.baseUrl = (options.baseUrl || 'https://api.github.com').replace(/\/+$/, '');
    this.publisher = new CommentPublisher({ githubToken: options.token, baseUrl: this.baseUrl });
  }

  private async request(path: string, init: RequestInit = {}): Promise<any> {
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/vnd.github+json');
    headers.set('Authorization', `Bearer ${this.token}`);
    headers.set('User-Agent', 'ct-review-bot[bot]');
    headers.set('X-GitHub-Api-Version', '2022-11-28');
    if (init.body) headers.set('Content-Type', 'application/json');
    const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
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
    for (let page = 1; ; page++) {
      const data = await this.request(`/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`);
      if (!Array.isArray(data)) throw new Error('pull files response is not an array');
      files.push(...data.map((file: any) => ({
        path: String(file.filename || ''),
        ...(typeof file.patch === 'string' ? { patch: file.patch } : {}),
      })));
      if (data.length < 100) break;
    }
    return files;
  }

  publishReview(request: PublishReviewRequest): Promise<PublishResult> {
    return this.publisher.publishReview(request);
  }

  async createCheck(owner: string, repo: string, headSha: string): Promise<number> {
    const data = await this.request(`/repos/${owner}/${repo}/check-runs`, {
      method: 'POST',
      body: JSON.stringify({
        name: 'PR Review Evidence Gate',
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
        completed_at: new Date().toISOString(),
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

  async getFileContent(owner: string, repo: string, path: string, ref?: string): Promise<string | null> {
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
    } catch {
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
