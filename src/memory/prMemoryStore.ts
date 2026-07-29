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
  status: 'draft' | 'accepted' | 'deprecated';
  rule: string;
  targetPaths: string[];
  createdAt?: string;
}

export interface RepoMemoryState {
  learnings: ReviewerLearning[];
  resolvedNits: ResolvedNitPattern[];
  adrConstraints: ADRConstraint[];
}

export class PRMemoryStore {
  private db: DatabaseSync;
  private dbPath: string;

  constructor(dbPath?: string) {
    const defaultPath = process.env.NODE_ENV === 'test' ? ':memory:' : path.join(process.env.CT_REVIEW_DATA_DIR || '/tmp/ct-review-bot', 'pr_memory.db');
    this.dbPath = dbPath || process.env.CT_REVIEW_MEMORY_DB || defaultPath;
    if (this.dbPath === ':memory:' || this.dbPath.startsWith(':memory:')) {
      this.db = new DatabaseSync(':memory:');
    } else {
      const dir = path.dirname(this.dbPath);
      if (dir && dir !== '.' && !fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      this.db = new DatabaseSync(this.dbPath);
    }
    this.initDatabase();
  }

  private initDatabase(): void {
    try {
      this.db.exec('PRAGMA journal_mode = WAL;');
    } catch (_) {}
    try {
      this.db.exec('PRAGMA synchronous = NORMAL;');
    } catch (_) {}
    try {
      this.db.exec('PRAGMA busy_timeout = 5000;');
    } catch (_) {}
    try {
      this.db.exec('PRAGMA temp_store = MEMORY;');
    } catch (_) {}
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS learnings (
        id TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        category TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        file_path TEXT,
        confidence REAL DEFAULT 1.0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS resolved_nits (
        id TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        pattern TEXT NOT NULL,
        file_path TEXT NOT NULL,
        reason TEXT NOT NULL,
        head_sha TEXT,
        resolved_at TEXT NOT NULL,
        suppression_count INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS adr_constraints (
        id TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        adr_number INTEGER NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        rule TEXT NOT NULL,
        target_paths TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS feedback_events (
        id TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        reaction TEXT NOT NULL,
        feedback_type TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_learnings_repo ON learnings(repo);
      CREATE INDEX IF NOT EXISTS idx_learnings_repo_cat_file ON learnings(repo, category, file_path);
      CREATE INDEX IF NOT EXISTS idx_nits_repo ON resolved_nits(repo);
      CREATE INDEX IF NOT EXISTS idx_nits_repo_file ON resolved_nits(repo, file_path);
      CREATE INDEX IF NOT EXISTS idx_adr_repo ON adr_constraints(repo);
      CREATE INDEX IF NOT EXISTS idx_adr_repo_status ON adr_constraints(repo, status);
      CREATE INDEX IF NOT EXISTS idx_feedback_repo ON feedback_events(repo);
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
    const title = learning.title || (learning as any).rule || 'Learned Rule';
    const description = learning.description || (learning as any).rule || 'Learned from PR review feedback';
    const category = learning.category || 'convention';

    const stmt = this.db.prepare(`
      INSERT INTO learnings (id, repo, pr_number, category, title, description, file_path, confidence, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      repo,
      prNumber,
      category,
      title,
      description,
      learning.filePath || null,
      learning.confidence ?? 1.0,
      createdAt,
      updatedAt
    );
    return { id, repo, prNumber, ...learning, category, title, description, createdAt, updatedAt };
  }

  public async recordResolvedNit(
    repo: string,
    prNumber: number,
    nit: Omit<ResolvedNitPattern, 'repo' | 'prNumber'>
  ): Promise<ResolvedNitPattern> {
    const id = nit.id || `nit_${crypto.randomUUID().slice(0, 8)}`;
    const resolvedAt = nit.resolvedAt || new Date().toISOString();
    const suppressionCount = nit.suppressionCount || 0;
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
    return { id, repo, prNumber, suppressionCount, ...nit, resolvedAt };
  }

  public async recordADRConstraint(
    repo: string,
    adr: Omit<ADRConstraint, 'repo'>
  ): Promise<ADRConstraint> {
    const id = adr.id || `adr_${crypto.randomUUID().slice(0, 8)}`;
    const createdAt = adr.createdAt || new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO adr_constraints (id, repo, adr_number, title, status, rule, target_paths, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      repo,
      adr.adrNumber,
      adr.title,
      adr.status,
      adr.rule,
      JSON.stringify(adr.targetPaths),
      createdAt
    );
    return { id, repo, ...adr, createdAt };
  }

  private incrementNitStmt?: any;

  public async incrementNitSuppression(id: string): Promise<void> {
    if (!this.incrementNitStmt) {
      this.incrementNitStmt = this.db.prepare('UPDATE resolved_nits SET suppression_count = suppression_count + 1 WHERE id = ?');
    }
    this.incrementNitStmt.run(id);
  }

  public async incrementNitSuppressionBatch(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    this.db.exec('BEGIN TRANSACTION;');
    try {
      if (!this.incrementNitStmt) {
        this.incrementNitStmt = this.db.prepare('UPDATE resolved_nits SET suppression_count = suppression_count + 1 WHERE id = ?');
      }
      for (const id of ids) {
        this.incrementNitStmt.run(id);
      }
      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
  }

  public async queryLearnings(
    repo: string,
    options: { category?: string; filePath?: string; query?: string } = {}
  ): Promise<RepoMemoryState> {
    let lSql = 'SELECT * FROM learnings WHERE repo = ?';
    const lParams: any[] = [repo];
    if (options.category) {
      lSql += ' AND category = ?';
      lParams.push(options.category);
    }
    if (options.filePath) {
      lSql += " AND (file_path IS NULL OR file_path = '' OR file_path = ? OR file_path = '**')";
      lParams.push(options.filePath);
    }
    if (options.query) {
      lSql += ' AND (LOWER(title) LIKE ? OR LOWER(description) LIKE ?)';
      const q = `%${options.query.toLowerCase()}%`;
      lParams.push(q, q);
    }
    const lRows = this.db.prepare(lSql).all(...lParams) as any[];

    let nSql = 'SELECT * FROM resolved_nits WHERE repo = ?';
    const nParams: any[] = [repo];
    if (options.filePath) {
      nSql += " AND (file_path IS NULL OR file_path = '' OR file_path = ? OR file_path = '**')";
      nParams.push(options.filePath);
    }
    const nRows = this.db.prepare(nSql).all(...nParams) as any[];

    const aSql = "SELECT * FROM adr_constraints WHERE repo = ? AND status = 'accepted'";
    const aRows = this.db.prepare(aSql).all(repo) as any[];

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

  public async recordFeedback(repo: string, reaction: string, feedbackType: 'positive' | 'negative' = 'positive'): Promise<void> {
    const id = `fb_${crypto.randomUUID().slice(0, 8)}`;
    const stmt = this.db.prepare(`
      INSERT INTO feedback_events (id, repo, reaction, feedback_type)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(id, repo, reaction, feedbackType);
  }

  /**
   * Exports repo memory to formatted JSON string for committing back to repository (.ct-memory/learning.json).
   */
  public async exportToGitFile(repo: string): Promise<string> {
    const state = await this.queryLearnings(repo);
    return JSON.stringify(
      {
        version: '1.0',
        repo,
        exportedAt: new Date().toISOString(),
        memory: state,
      },
      null,
      2
    );
  }

  /**
   * Imports repo memory from committed repository file (.ct-memory/learning.json).
   */
  public async importFromGitFile(repo: string, jsonContent: string): Promise<void> {
    try {
      const parsed = JSON.parse(jsonContent);
      if (parsed && parsed.memory) {
        if (Array.isArray(parsed.memory.learnings)) {
          for (const l of parsed.memory.learnings) {
            await this.recordLearning(repo, l.prNumber || 0, l);
          }
        }
        if (Array.isArray(parsed.memory.resolvedNits)) {
          for (const n of parsed.memory.resolvedNits) {
            await this.recordResolvedNit(repo, n.prNumber || 0, n);
          }
        }
        if (Array.isArray(parsed.memory.adrConstraints)) {
          for (const a of parsed.memory.adrConstraints) {
            await this.recordADRConstraint(repo, a);
          }
        }
      }
    } catch (err: any) {
      logger.error('Failed to import repo memory from git file', { repo, error: err.message });
    }
  }

  public getFeedbackCounts(repo?: string): { positiveFeedbackCount: number; negativeFeedbackCount: number } {
    try {
      let posSql = "SELECT COUNT(*) as cnt FROM feedback_events WHERE feedback_type = 'positive'";
      let negSql = "SELECT COUNT(*) as cnt FROM feedback_events WHERE feedback_type = 'negative'";
      const params: any[] = [];
      if (repo) {
        posSql += ' AND repo = ?';
        negSql += ' AND repo = ?';
        params.push(repo);
      }
      const pos = this.db.prepare(posSql).get(...params) as { cnt: number } | undefined;
      const neg = this.db.prepare(negSql).get(...params) as { cnt: number } | undefined;
      return {
        positiveFeedbackCount: pos?.cnt || 0,
        negativeFeedbackCount: neg?.cnt || 0,
      };
    } catch {
      return { positiveFeedbackCount: 0, negativeFeedbackCount: 0 };
    }
  }

  public async clearRepoMemory(repo: string): Promise<void> {
    this.db.prepare('DELETE FROM learnings WHERE repo = ?').run(repo);
    this.db.prepare('DELETE FROM resolved_nits WHERE repo = ?').run(repo);
    this.db.prepare('DELETE FROM adr_constraints WHERE repo = ?').run(repo);
    this.db.prepare('DELETE FROM feedback_events WHERE repo = ?').run(repo);
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
    if (this.db && typeof this.db.close === 'function') {
      try {
        this.db.close();
      } catch {
        // Ignore double close
      }
    }
  }
}
