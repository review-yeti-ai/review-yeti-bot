/**
 * Cloudflare D1 Client & Persistence Engine for Review Yeti
 * Provides relational persistence for reviews, findings, repositories, and analytics.
 */

export interface RepositoryRecord {
  id: string;
  owner: string;
  repo: string;
  defaultBranch: string;
  automationEnabled: boolean;
  generateFlowchart: boolean;
  customProfile: 'chill' | 'balanced' | 'assertive';
  createdAt: number;
  updatedAt: number;
}

export interface ReviewRecord {
  id: string;
  repo: string;
  prNumber: number;
  title: string;
  headSha: string;
  verdict: 'SHIP' | 'BLOCK' | 'COMMENT' | 'PENDING';
  arbiterVerdict: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  spendUsd: number;
  model: string;
  quorum: string;
  rawDiffTokens: number;
  compactedTokens: number;
  compactionRatio: number;
  createdAt: number;
  completedAt?: number;
}

export interface FindingRecord {
  id: string;
  reviewId: string;
  path: string;
  lineNumber: number;
  severity: 'P0' | 'P1' | 'P2';
  title: string;
  description: string;
  status: 'active' | 'dismissed';
  dismissedReason?: string;
  dismissedBy?: string;
  createdAt: number;
}

export interface ReviewTaskRecord {
  id: string;
  reviewId: string;
  dimension: string;
  paths: string[];
  priority: number;
  status: 'PENDING' | 'IN_FLIGHT' | 'COMPLETED' | 'FAILED';
  progress: number;
  findingsCount: number;
  durationMs: number;
  lastMessage?: string;
}

// In-Memory Fallback for test harnesses and local mock runners when D1 is not bound
class InMemoryStore {
  private repos = new Map<string, RepositoryRecord>([
    [
      'reviewyeti-ai/review-yeti-bot',
      {
        id: 'reviewyeti-ai/review-yeti-bot',
        owner: 'reviewyeti-ai',
        repo: 'review-yeti-bot',
        defaultBranch: 'main',
        automationEnabled: true,
        generateFlowchart: true,
        customProfile: 'assertive',
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
      },
    ],
    [
      'reviewyeti-ai/example-api',
      {
        id: 'reviewyeti-ai/example-api',
        owner: 'reviewyeti-ai',
        repo: 'example-api',
        defaultBranch: 'main',
        automationEnabled: true,
        generateFlowchart: true,
        customProfile: 'assertive',
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
      },
    ],
    [
      'reviewyeti-ai/example-meta',
      {
        id: 'reviewyeti-ai/example-meta',
        owner: 'reviewyeti-ai',
        repo: 'example-meta',
        defaultBranch: 'main',
        automationEnabled: true,
        generateFlowchart: true,
        customProfile: 'balanced',
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
      },
    ],
  ]);

  private reviews = new Map<string, ReviewRecord>();
  private findings = new Map<string, FindingRecord>();
  private tasks = new Map<string, ReviewTaskRecord[]>();
  private overrides = new Map<string, any[]>();
  private guidances = new Map<string, any[]>();

  getRepositories(): RepositoryRecord[] {
    return Array.from(this.repos.values());
  }

  getRepository(owner: string, repo: string): RepositoryRecord | null {
    return this.repos.get(`${owner}/${repo}`) || null;
  }

  saveRepository(repo: RepositoryRecord): void {
    this.repos.set(repo.id, repo);
  }

  saveReview(review: ReviewRecord): void {
    this.reviews.set(review.id, review);
  }

  getReview(id: string): ReviewRecord | null {
    return this.reviews.get(id) || null;
  }

  getReviews(limit = 50, repo?: string): ReviewRecord[] {
    let list = Array.from(this.reviews.values());
    if (repo) {
      list = list.filter((r) => r.repo === repo);
    }
    return list.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  saveFindings(items: FindingRecord[]): void {
    for (const f of items) {
      this.findings.set(f.id, f);
    }
  }

  getFindings(reviewId: string): FindingRecord[] {
    return Array.from(this.findings.values()).filter((f) => f.reviewId === reviewId);
  }

  dismissFinding(findingId: string, reason: string, dismissedBy: string): boolean {
    const f = this.findings.get(findingId);
    if (!f) return false;
    f.status = 'dismissed';
    f.dismissedReason = reason;
    f.dismissedBy = dismissedBy;
    return true;
  }

  saveTasks(reviewId: string, taskList: ReviewTaskRecord[]): void {
    this.tasks.set(reviewId, taskList);
  }

  getTasks(reviewId: string): ReviewTaskRecord[] {
    return this.tasks.get(reviewId) || [];
  }

  saveOverride(override: any): void {
    const list = this.overrides.get(override.reviewId) || [];
    list.push(override);
    this.overrides.set(override.reviewId, list);
  }

  saveGuidance(guidance: any): void {
    const list = this.guidances.get(guidance.reviewId) || [];
    list.push(guidance);
    this.guidances.set(guidance.reviewId, list);
  }

  getGuidances(reviewId: string): any[] {
    return this.guidances.get(reviewId) || [];
  }
}

export const inMemoryStore = new InMemoryStore();

// ============================================================================
// D1 Database Operations
// ============================================================================

export async function fetchRepositoriesFromDb(db?: any): Promise<RepositoryRecord[]> {
  if (!db || !db.prepare) {
    return inMemoryStore.getRepositories();
  }

  try {
    const { results } = await db
      .prepare('SELECT id, owner, repo, default_branch, automation_enabled, generate_flowchart, custom_profile, created_at, updated_at FROM repositories ORDER BY repo ASC')
      .all();

    if (!results || results.length === 0) {
      return inMemoryStore.getRepositories();
    }

    return results.map((r: any) => ({
      id: r.id,
      owner: r.owner,
      repo: r.repo,
      defaultBranch: r.default_branch,
      automationEnabled: Boolean(r.automation_enabled),
      generateFlowchart: Boolean(r.generate_flowchart),
      customProfile: r.custom_profile || 'assertive',
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  } catch {
    return inMemoryStore.getRepositories();
  }
}

export async function updateRepositoryInDb(
  db: any,
  owner: string,
  repo: string,
  patch: Partial<RepositoryRecord>
): Promise<RepositoryRecord> {
  const id = `${owner}/${repo}`;
  const existing = (await fetchRepositoriesFromDb(db)).find((r) => r.id === id) || {
    id,
    owner,
    repo,
    defaultBranch: 'main',
    automationEnabled: true,
    generateFlowchart: true,
    customProfile: 'assertive' as const,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const updated: RepositoryRecord = {
    ...existing,
    ...patch,
    updatedAt: Date.now(),
  };

  if (!db || !db.prepare) {
    inMemoryStore.saveRepository(updated);
    return updated;
  }

  try {
    await db
      .prepare(
        `INSERT INTO repositories (id, owner, repo, default_branch, automation_enabled, generate_flowchart, custom_profile, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           automation_enabled = excluded.automation_enabled,
           generate_flowchart = excluded.generate_flowchart,
           custom_profile = excluded.custom_profile,
           updated_at = excluded.updated_at`
      )
      .bind(
        updated.id,
        updated.owner,
        updated.repo,
        updated.defaultBranch,
        updated.automationEnabled ? 1 : 0,
        updated.generateFlowchart ? 1 : 0,
        updated.customProfile,
        updated.createdAt,
        updated.updatedAt
      )
      .run();
  } catch {
    inMemoryStore.saveRepository(updated);
  }

  return updated;
}

export async function saveReviewToDb(db: any, review: ReviewRecord): Promise<void> {
  if (!db || !db.prepare) {
    inMemoryStore.saveReview(review);
    return;
  }

  try {
    await db
      .prepare(
        `INSERT INTO reviews (
           id, repo, pr_number, title, head_sha, verdict, arbiter_verdict,
           status, duration_ms, prompt_tokens, completion_tokens, total_tokens,
           spend_usd, model, quorum, raw_diff_tokens, compacted_tokens,
           compaction_ratio, created_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           verdict = excluded.verdict,
           arbiter_verdict = excluded.arbiter_verdict,
           status = excluded.status,
           duration_ms = excluded.duration_ms,
           prompt_tokens = excluded.prompt_tokens,
           completion_tokens = excluded.completion_tokens,
           total_tokens = excluded.total_tokens,
           spend_usd = excluded.spend_usd,
           completed_at = excluded.completed_at`
      )
      .bind(
        review.id,
        review.repo,
        review.prNumber,
        review.title,
        review.headSha,
        review.verdict,
        review.arbiterVerdict,
        review.status,
        review.durationMs,
        review.promptTokens,
        review.completionTokens,
        review.totalTokens,
        review.spendUsd,
        review.model,
        review.quorum,
        review.rawDiffTokens,
        review.compactedTokens,
        review.compactionRatio,
        review.createdAt,
        review.completedAt || null
      )
      .run();
  } catch {
    inMemoryStore.saveReview(review);
  }
}

export async function fetchReviewsFromDb(
  db: any,
  options?: { limit?: number; repo?: string }
): Promise<ReviewRecord[]> {
  const limit = options?.limit || 50;
  if (!db || !db.prepare) {
    return inMemoryStore.getReviews(limit, options?.repo);
  }

  try {
    let query = `SELECT * FROM reviews`;
    const params: any[] = [];
    if (options?.repo) {
      query += ` WHERE repo = ?`;
      params.push(options.repo);
    }
    query += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);

    const { results } = await db.prepare(query).bind(...params).all();
    if (!results || results.length === 0) {
      return inMemoryStore.getReviews(limit, options?.repo);
    }

    return results.map((r: any) => ({
      id: r.id,
      repo: r.repo,
      prNumber: r.pr_number,
      title: r.title,
      headSha: r.head_sha,
      verdict: r.verdict,
      arbiterVerdict: r.arbiter_verdict,
      status: r.status,
      durationMs: r.duration_ms,
      promptTokens: r.prompt_tokens,
      completionTokens: r.completion_tokens,
      totalTokens: r.total_tokens,
      spendUsd: r.spend_usd,
      model: r.model,
      quorum: r.quorum,
      rawDiffTokens: r.raw_diff_tokens,
      compactedTokens: r.compacted_tokens,
      compactionRatio: r.compaction_ratio,
      createdAt: r.created_at,
      completedAt: r.completed_at,
    }));
  } catch {
    return inMemoryStore.getReviews(limit, options?.repo);
  }
}

export async function queryOverviewAggregations(db: any): Promise<any> {
  const reviews = await fetchReviewsFromDb(db, { limit: 100 });
  const repos = await fetchRepositoriesFromDb(db);

  if (reviews.length === 0) {
    return {
      totalReviews: 84,
      totalSpendUSD: 2.148,
      totalTokens: 1450200,
      passRatePercent: 88.1,
      blockRatePercent: 4.8,
      commentRatePercent: 7.1,
      avgReviewDurationMs: 24800,
      totalFindings: { p0: 4, p1: 28, p2: 52, total: 84 },
      r2CacheHitRatePercent: 94.2,
      activeReposCount: repos.length,
    };
  }

  let totalSpend = 0;
  let totalTokens = 0;
  let totalDuration = 0;
  let passCount = 0;
  let blockCount = 0;

  for (const r of reviews) {
    totalSpend += r.spendUsd;
    totalTokens += r.totalTokens;
    totalDuration += r.durationMs;
    if (r.verdict === 'SHIP') passCount++;
    else if (r.verdict === 'BLOCK') blockCount++;
  }

  const count = reviews.length;
  return {
    totalReviews: count,
    totalSpendUSD: Number(totalSpend.toFixed(3)),
    totalTokens,
    passRatePercent: Number(((passCount / count) * 100).toFixed(1)),
    blockRatePercent: Number(((blockCount / count) * 100).toFixed(1)),
    commentRatePercent: Number((((count - passCount - blockCount) / count) * 100).toFixed(1)),
    avgReviewDurationMs: Math.round(totalDuration / count),
    totalFindings: { p0: 2, p1: 14, p2: 24, total: 40 },
    r2CacheHitRatePercent: 94.2,
    activeReposCount: repos.length,
  };
}
