// @ts-ignore
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { logger } from '../utils/logger';

export interface ReviewerLearning {
  id?: string;
  repo: string;
  prNumber: number;
  category: 'convention' | 'architecture' | 'security' | 'performance' | 'style' | 'adr';
  title: string;
  description: string;
  filePath?: string;
  confidence?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface ResolvedNitPattern {
  id?: string;
  repo: string;
  prNumber: number;
  pattern: string;
  filePath: string;
  reason: string;
  headSha?: string;
  resolvedAt?: string;
  suppressionCount?: number;
}

export interface ADRConstraint {
  id?: string;
  repo: string;
  adrNumber: number;
  title: string;
  status: 'accepted' | 'deprecated' | 'superseded' | 'draft';
  rule: string;
  targetPaths: string[];
  createdAt?: string;
}

export interface MemoryQueryResult {
  learnings: ReviewerLearning[];
  resolvedNits: ResolvedNitPattern[];
  adrConstraints: ADRConstraint[];
}

export class PRMemoryStore {
  private db: DatabaseSync;
  private dbPath: string;

  constructor(dbPath: string = '.ct-memory/pr_memory.db') {
    this.dbPath = dbPath;
    if (dbPath !== ':memory:') {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    this.db = new DatabaseSync(dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    try {
      this.db.exec('PRAGMA busy_timeout = 5000;');
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec('PRAGMA synchronous = NORMAL;');
      this.db.exec('PRAGMA temp_store = MEMORY;');
    } catch (err: any) {
      logger.warn('Failed setting PRAGMAs on PRMemoryStore', { error: err.message });
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS learnings (
        id TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        category TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        file_path TEXT,
        confidence REAL NOT NULL DEFAULT 1.0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_learnings_repo ON learnings(repo);
      CREATE INDEX IF NOT EXISTS idx_learnings_category ON learnings(category);
      CREATE INDEX IF NOT EXISTS idx_learnings_file_path ON learnings(file_path);

      CREATE TABLE IF NOT EXISTS resolved_nits (
        id TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        pattern TEXT NOT NULL,
        file_path TEXT NOT NULL,
        reason TEXT NOT NULL,
        head_sha TEXT,
        resolved_at TEXT DEFAULT CURRENT_TIMESTAMP,
        suppression_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_nits_repo ON resolved_nits(repo);
      CREATE INDEX IF NOT EXISTS idx_nits_file_path ON resolved_nits(file_path);

      CREATE TABLE IF NOT EXISTS adr_constraints (
        id TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        adr_number INTEGER NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        rule TEXT NOT NULL,
        target_paths TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_adr_repo ON adr_constraints(repo);
    `);
  }

  public async recordLearning(
    repo: string,
    prNumber: number,
    learning: Omit<ReviewerLearning, 'repo' | 'prNumber'>
  ): Promise<ReviewerLearning> {
    const id = learning.id || `lrn_${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const createdAt = learning.createdAt || now;
    const updatedAt = learning.updatedAt || now;
    const stmt = this.db.prepare(`
      INSERT INTO learnings (id, repo, pr_number, category, title, description, file_path, confidence, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      repo,
      prNumber,
      learning.category,
      learning.title,
      learning.description,
      learning.filePath || null,
      learning.confidence ?? 1.0,
      createdAt,
      updatedAt
    );
    return { id, repo, prNumber, ...learning, createdAt, updatedAt };
  }

  public async recordResolvedNit(
    repo: string,
    prNumber: number,
    nit: Omit<ResolvedNitPattern, 'repo' | 'prNumber'>
  ): Promise<ResolvedNitPattern> {
    const id = nit.id || `nit_${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const resolvedAt = nit.resolvedAt || now;
    const suppressionCount = nit.suppressionCount ?? 0;
    const stmt = this.db.prepare(`
      INSERT INTO resolved_nits (id, repo, pr_number, pattern, file_path, reason, head_sha, resolved_at, suppression_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      repo,
      prNumber,
      nit.pattern,
      nit.filePath,
      nit.reason,
      nit.headSha || null,
      resolvedAt,
      suppressionCount
    );
    return { id, repo, prNumber, ...nit, resolvedAt, suppressionCount };
  }

  public async recordADRConstraint(
    repo: string,
    constraint: Omit<ADRConstraint, 'repo'>
  ): Promise<ADRConstraint> {
    const id = constraint.id || `adr_${constraint.adrNumber}`;
    const now = new Date().toISOString();
    const createdAt = constraint.createdAt || now;
    const stmt = this.db.prepare(`
      INSERT INTO adr_constraints (id, repo, adr_number, title, status, rule, target_paths, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      repo,
      constraint.adrNumber,
      constraint.title,
      constraint.status,
      constraint.rule,
      JSON.stringify(constraint.targetPaths),
      createdAt
    );
    return { id, repo, ...constraint, createdAt };
  }

  public async queryLearnings(
    repo: string,
    context?: { filePath?: string; category?: string; query?: string }
  ): Promise<MemoryQueryResult> {
    // 1. Query Learnings
    let lSql = 'SELECT * FROM learnings WHERE repo = ?';
    const lParams: any[] = [repo];
    if (context?.category) {
      lSql += ' AND category = ?';
      lParams.push(context.category);
    }
    if (context?.filePath) {
      lSql += " AND (file_path IS NULL OR file_path = ? OR ? LIKE file_path || '%')";
      lParams.push(context.filePath, context.filePath);
    }
    if (context?.query) {
      lSql += ' AND (title LIKE ? OR description LIKE ?)';
      const q = `%${context.query}%`;
      lParams.push(q, q);
    }
    const lRows = this.db.prepare(lSql).all(...lParams) as any[];
    const learnings: ReviewerLearning[] = lRows.map((r) => ({
      id: r.id,
      repo: r.repo,
      prNumber: r.pr_number,
      category: r.category,
      title: r.title,
      description: r.description,
      filePath: r.file_path || undefined,
      confidence: r.confidence,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));

    // 2. Query Resolved Nits
    let nSql = 'SELECT * FROM resolved_nits WHERE repo = ?';
    const nParams: any[] = [repo];
    if (context?.filePath) {
      nSql += ' AND (file_path = ? OR file_path = \'\')';
      nParams.push(context.filePath);
    }
    const nRows = this.db.prepare(nSql).all(...nParams) as any[];
    const resolvedNits: ResolvedNitPattern[] = nRows.map((r) => ({
      id: r.id,
      repo: r.repo,
      prNumber: r.pr_number,
      pattern: r.pattern,
      filePath: r.file_path,
      reason: r.reason,
      headSha: r.head_sha || undefined,
      resolvedAt: r.resolved_at,
      suppressionCount: r.suppression_count,
    }));

    // 3. Query ADR Constraints
    const aRows = this.db.prepare("SELECT * FROM adr_constraints WHERE repo = ? AND status = 'accepted'").all(repo) as any[];
    const adrConstraints: ADRConstraint[] = aRows.map((r) => ({
      id: r.id,
      repo: r.repo,
      adrNumber: r.adr_number,
      title: r.title,
      status: r.status,
      rule: r.rule,
      targetPaths: JSON.parse(r.target_paths || '[]'),
      createdAt: r.created_at,
    }));

    return { learnings, resolvedNits, adrConstraints };
  }

  public async incrementNitSuppression(id: string): Promise<void> {
    const stmt = this.db.prepare('UPDATE resolved_nits SET suppression_count = suppression_count + 1 WHERE id = ?');
    stmt.run(id);
  }

  public async clearRepoMemory(repo: string): Promise<void> {
    this.db.prepare('DELETE FROM learnings WHERE repo = ?').run(repo);
    this.db.prepare('DELETE FROM resolved_nits WHERE repo = ?').run(repo);
    this.db.prepare('DELETE FROM adr_constraints WHERE repo = ?').run(repo);
  }

  public getCounts(): { learningsCount: number; suppressedNitsCount: number; adrConstraintsCount: number } {
    try {
      const l = this.db.prepare('SELECT COUNT(*) as cnt FROM learnings').get() as { cnt: number } | undefined;
      const n = this.db.prepare('SELECT COUNT(*) as cnt FROM resolved_nits').get() as { cnt: number } | undefined;
      const a = this.db.prepare('SELECT COUNT(*) as cnt FROM adr_constraints').get() as { cnt: number } | undefined;
      return {
        learningsCount: l?.cnt || 0,
        suppressedNitsCount: n?.cnt || 0,
        adrConstraintsCount: a?.cnt || 0,
      };
    } catch {
      return { learningsCount: 0, suppressedNitsCount: 0, adrConstraintsCount: 0 };
    }
  }

  public close(): void {
    try {
      this.db.close();
    } catch {}
  }
}
