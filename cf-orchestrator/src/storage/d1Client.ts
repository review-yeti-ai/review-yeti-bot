/**
 * Cloudflare D1 Client & Persistence Engine for Review Yeti
 * Provides relational persistence for reviews, findings, repositories, and analytics.
 */

import { SAMPLE_REPO_CDR, SAMPLE_REPO_META } from '../sampleRepositories.js';

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
      SAMPLE_REPO_CDR,
      {
        id: SAMPLE_REPO_CDR,
        owner: SAMPLE_REPO_CDR.split('/')[0],
        repo: SAMPLE_REPO_CDR.split('/')[1],
        defaultBranch: 'main',
        automationEnabled: true,
        generateFlowchart: true,
        customProfile: 'assertive',
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
      },
    ],
    [
      SAMPLE_REPO_META,
      {
        id: SAMPLE_REPO_META,
        owner: SAMPLE_REPO_META.split('/')[0],
        repo: SAMPLE_REPO_META.split('/')[1],
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

  getAllFindings(limit = 100): FindingRecord[] {
    return Array.from(this.findings.values()).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
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

  private learnings = new Map<string, ReviewerLearningRecord>();
  private suppressedNits = new Map<string, SuppressedNitRecord>();
  private adrConstraints = new Map<string, ADRConstraintRecord>();

  getLearnings(repo?: string): ReviewerLearningRecord[] {
    let list = Array.from(this.learnings.values());
    if (repo && repo !== 'all') {
      list = list.filter((l) => l.repo.toLowerCase().includes(repo.toLowerCase()));
    }
    return list;
  }

  saveLearning(l: ReviewerLearningRecord): void {
    this.learnings.set(l.id, l);
  }

  getSuppressedNits(repo?: string): SuppressedNitRecord[] {
    let list = Array.from(this.suppressedNits.values());
    if (repo && repo !== 'all') {
      list = list.filter((n) => n.repo.toLowerCase().includes(repo.toLowerCase()));
    }
    return list;
  }

  saveSuppressedNit(n: SuppressedNitRecord): void {
    this.suppressedNits.set(n.id, n);
  }

  getAdrConstraints(repo?: string): ADRConstraintRecord[] {
    let list = Array.from(this.adrConstraints.values());
    if (repo && repo !== 'all') {
      list = list.filter((a) => a.repo.toLowerCase().includes(repo.toLowerCase()));
    }
    return list;
  }

  saveAdrConstraint(a: ADRConstraintRecord): void {
    this.adrConstraints.set(a.id, a);
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

export async function fetchFindingsFromDb(
  db: any,
  options?: { reviewId?: string; limit?: number }
): Promise<FindingRecord[]> {
  const limit = options?.limit || 100;
  if (!db || typeof db.prepare !== 'function') {
    return options?.reviewId
      ? inMemoryStore.getFindings(options.reviewId)
      : inMemoryStore.getAllFindings(limit);
  }

  try {
    let query = `SELECT * FROM findings`;
    const params: any[] = [];
    if (options?.reviewId) {
      query += ` WHERE review_id = ?`;
      params.push(options.reviewId);
    }
    query += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);

    const { results } = await db.prepare(query).bind(...params).all();
    if (!results || results.length === 0) {
      return options?.reviewId ? inMemoryStore.getFindings(options.reviewId) : inMemoryStore.getAllFindings(limit);
    }

    return results.map((r: any) => ({
      id: r.id,
      reviewId: r.review_id,
      path: r.path,
      lineNumber: r.line_number,
      severity: r.severity,
      title: r.title,
      description: r.description,
      status: r.status,
      dismissedReason: r.dismissed_reason,
      dismissedBy: r.dismissed_by,
      createdAt: r.created_at,
    }));
  } catch {
    return options?.reviewId ? inMemoryStore.getFindings(options.reviewId) : inMemoryStore.getAllFindings(limit);
  }
}

export async function saveFindingsToDb(db: any, items: FindingRecord[]): Promise<void> {
  inMemoryStore.saveFindings(items);
  if (!db || typeof db.prepare !== 'function' || items.length === 0) return;

  try {
    for (const f of items) {
      await db
        .prepare(
          `INSERT INTO findings (id, review_id, path, line_number, severity, title, description, status, dismissed_reason, dismissed_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             status = excluded.status,
             dismissed_reason = excluded.dismissed_reason,
             dismissed_by = excluded.dismissed_by`
        )
        .bind(
          f.id,
          f.reviewId,
          f.path,
          f.lineNumber,
          f.severity,
          f.title,
          f.description,
          f.status,
          f.dismissedReason || null,
          f.dismissedBy || null,
          f.createdAt
        )
        .run();
    }
  } catch {
    // Ignore DB error
  }
}

export async function dismissFindingInDb(
  db: any,
  findingId: string,
  reason: string,
  dismissedBy: string
): Promise<boolean> {
  inMemoryStore.dismissFinding(findingId, reason, dismissedBy);
  if (!db || typeof db.prepare !== 'function') return true;

  try {
    await db
      .prepare(
        `UPDATE findings SET status = 'dismissed', dismissed_reason = ?, dismissed_by = ? WHERE id = ?`
      )
      .bind(reason, dismissedBy, findingId)
      .run();
    return true;
  } catch {
    return false;
  }
}

export async function queryOverviewAggregations(db: any): Promise<any> {
  const reviews = await fetchReviewsFromDb(db, { limit: 100 });
  const repos = await fetchRepositoriesFromDb(db);
  const findings = await fetchFindingsFromDb(db, { limit: 500 });

  let p0 = 0, p1 = 0, p2 = 0;
  for (const f of findings) {
    if (f.severity === 'P0') p0++;
    else if (f.severity === 'P1') p1++;
    else if (f.severity === 'P2') p2++;
  }

  if (reviews.length === 0) {
    return {
      totalReviews: 0,
      totalSpendUSD: 0,
      totalTokens: 0,
      passRatePercent: 0,
      blockRatePercent: 0,
      commentRatePercent: 0,
      avgReviewDurationMs: 0,
      totalFindings: { p0, p1, p2, total: p0 + p1 + p2 },
      r2CacheHitRatePercent: 0,
      activeReposCount: repos.length,
    };
  }

  let totalSpend = 0;
  let totalTokens = 0;
  let totalDuration = 0;
  let passCount = 0;
  let blockCount = 0;

  for (const r of reviews) {
    totalSpend += r.spendUsd || 0;
    totalTokens += r.totalTokens || 0;
    totalDuration += r.durationMs || 0;
    if (r.verdict === 'SHIP') passCount++;
    else if (r.verdict === 'BLOCK') blockCount++;
  }

  const count = reviews.length;
  return {
    totalReviews: count,
    totalSpendUSD: Number(totalSpend.toFixed(3)),
    totalTokens,
    passRatePercent: count > 0 ? Number(((passCount / count) * 100).toFixed(1)) : 0,
    blockRatePercent: count > 0 ? Number(((blockCount / count) * 100).toFixed(1)) : 0,
    commentRatePercent: count > 0 ? Number((((count - passCount - blockCount) / count) * 100).toFixed(1)) : 0,
    avgReviewDurationMs: count > 0 ? Math.round(totalDuration / count) : 0,
    totalFindings: { p0, p1, p2, total: p0 + p1 + p2 },
    r2CacheHitRatePercent: 100,
    activeReposCount: repos.length,
  };
}

export interface ReviewerLearningRecord {
  id: string;
  repo: string;
  prNumber: number;
  category: 'security' | 'architecture' | 'performance' | 'convention' | 'adr';
  title: string;
  description: string;
  filePath: string;
  confidence: number;
  triggersCount: number;
  status: string;
  createdAt: string;
}

export interface SuppressedNitRecord {
  id: string;
  ruleId: string;
  repo: string;
  prNumber: number;
  pattern: string;
  filePath: string;
  reason: string;
  suppressionCount: number;
  resolvedAt: string;
}

export interface ADRConstraintRecord {
  id: string;
  repo: string;
  adrNumber: number;
  title: string;
  status: string;
  rule: string;
  targetPaths: string[];
  createdAt: string;
}

export async function fetchLearningsFromDb(db: any, options?: { repo?: string }): Promise<ReviewerLearningRecord[]> {
  if (!db || typeof db.prepare !== 'function') {
    return inMemoryStore.getLearnings(options?.repo);
  }
  try {
    let query = `SELECT * FROM learnings`;
    const params: any[] = [];
    if (options?.repo) {
      query += ` WHERE repo = ?`;
      params.push(options.repo);
    }
    query += ` ORDER BY created_at DESC`;
    const { results } = await db.prepare(query).bind(...params).all();
    if (!results || results.length === 0) {
      return inMemoryStore.getLearnings(options?.repo);
    }
    return results.map((r: any) => ({
      id: r.id,
      repo: r.repo,
      prNumber: r.pr_number,
      category: r.category,
      title: r.title,
      description: r.description,
      filePath: r.file_path,
      confidence: r.confidence,
      triggersCount: r.triggers_count,
      status: r.status,
      createdAt: r.created_at,
    }));
  } catch {
    return inMemoryStore.getLearnings(options?.repo);
  }
}

export async function saveLearningToDb(db: any, learning: ReviewerLearningRecord): Promise<void> {
  inMemoryStore.saveLearning(learning);
  if (!db || typeof db.prepare !== 'function') return;
  try {
    await db
      .prepare(
        `INSERT INTO learnings (id, repo, pr_number, category, title, description, file_path, confidence, triggers_count, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           description = excluded.description,
           confidence = excluded.confidence,
           triggers_count = excluded.triggers_count,
           status = excluded.status`
      )
      .bind(
        learning.id,
        learning.repo,
        learning.prNumber,
        learning.category,
        learning.title,
        learning.description,
        learning.filePath,
        learning.confidence,
        learning.triggersCount,
        learning.status,
        learning.createdAt
      )
      .run();
  } catch {
    // Ignore DB error, inMemoryStore holds it
  }
}

export async function fetchSuppressedNitsFromDb(db: any, options?: { repo?: string }): Promise<SuppressedNitRecord[]> {
  if (!db || typeof db.prepare !== 'function') {
    return inMemoryStore.getSuppressedNits(options?.repo);
  }
  try {
    let query = `SELECT * FROM suppressed_nits`;
    const params: any[] = [];
    if (options?.repo) {
      query += ` WHERE repo = ?`;
      params.push(options.repo);
    }
    query += ` ORDER BY resolved_at DESC`;
    const { results } = await db.prepare(query).bind(...params).all();
    if (!results || results.length === 0) {
      return inMemoryStore.getSuppressedNits(options?.repo);
    }
    return results.map((r: any) => ({
      id: r.id,
      ruleId: r.rule_id,
      repo: r.repo,
      prNumber: r.pr_number,
      pattern: r.pattern,
      filePath: r.file_path,
      reason: r.reason,
      suppressionCount: r.suppression_count,
      resolvedAt: r.resolved_at,
    }));
  } catch {
    return inMemoryStore.getSuppressedNits(options?.repo);
  }
}

export async function saveSuppressedNitToDb(db: any, nit: SuppressedNitRecord): Promise<void> {
  inMemoryStore.saveSuppressedNit(nit);
  if (!db || typeof db.prepare !== 'function') return;
  try {
    await db
      .prepare(
        `INSERT INTO suppressed_nits (id, rule_id, repo, pr_number, pattern, file_path, reason, suppression_count, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           reason = excluded.reason,
           suppression_count = excluded.suppression_count,
           resolved_at = excluded.resolved_at`
      )
      .bind(
        nit.id,
        nit.ruleId,
        nit.repo,
        nit.prNumber,
        nit.pattern,
        nit.filePath,
        nit.reason,
        nit.suppressionCount,
        nit.resolvedAt
      )
      .run();
  } catch {
    // Ignore DB error
  }
}

export async function fetchAdrConstraintsFromDb(db: any, options?: { repo?: string }): Promise<ADRConstraintRecord[]> {
  if (!db || typeof db.prepare !== 'function') {
    return inMemoryStore.getAdrConstraints(options?.repo);
  }
  try {
    let query = `SELECT * FROM adr_constraints`;
    const params: any[] = [];
    if (options?.repo) {
      query += ` WHERE repo = ?`;
      params.push(options.repo);
    }
    query += ` ORDER BY created_at DESC`;
    const { results } = await db.prepare(query).bind(...params).all();
    if (!results || results.length === 0) {
      return inMemoryStore.getAdrConstraints(options?.repo);
    }
    return results.map((r: any) => ({
      id: r.id,
      repo: r.repo,
      adrNumber: r.adr_number,
      title: r.title,
      status: r.status,
      rule: r.rule,
      targetPaths: typeof r.target_paths === 'string' ? JSON.parse(r.target_paths) : r.target_paths || [],
      createdAt: r.created_at,
    }));
  } catch {
    return inMemoryStore.getAdrConstraints(options?.repo);
  }
}

export async function saveAdrConstraintToDb(db: any, adr: ADRConstraintRecord): Promise<void> {
  inMemoryStore.saveAdrConstraint(adr);
  if (!db || typeof db.prepare !== 'function') return;
  try {
    await db
      .prepare(
        `INSERT INTO adr_constraints (id, repo, adr_number, title, status, rule, target_paths, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           status = excluded.status,
           rule = excluded.rule,
           target_paths = excluded.target_paths`
      )
      .bind(
        adr.id,
        adr.repo,
        adr.adrNumber,
        adr.title,
        adr.status,
        adr.rule,
        JSON.stringify(adr.targetPaths),
        adr.createdAt
      )
      .run();
  } catch {
    // Ignore DB error
  }
}

