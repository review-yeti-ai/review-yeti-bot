import { CommentPublisher, PublishReviewRequest, PublishResult } from './commentPublisher';

export interface PullRequestSnapshot {
  headSha: string;
  baseSha: string;
  title: string;
  body: string;
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
}
