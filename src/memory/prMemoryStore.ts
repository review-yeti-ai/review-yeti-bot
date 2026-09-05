// @ts-ignore
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
const { DatabaseSync: DatabaseSyncImpl } = (() => {
  try {
    return require('node:sqlite');
  } catch {
    return { DatabaseSync: class {} };
  }
})();
const DatabaseSync: any = DatabaseSyncImpl;
type DatabaseSync = DatabaseSyncType;
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger';
import { postgresStore } from '../persistence/postgresStore';
import {
  MemoryAdapter,
  MemoryAdapterConfig,
  createMemoryAdapter,
} from './adapters';

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
  ruleId?: string;
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

export interface PathInstructionRule {
  id?: string;
  repo: string;
  pathPattern: string;
  instructions: string;
  createdAt?: string;
}

export interface RepoMemoryState {
  learnings: ReviewerLearning[];
  resolvedNits: ResolvedNitPattern[];
  adrConstraints: ADRConstraint[];
}

export const DEFAULT_TEAM_MEMORY_PATH = path.join(process.cwd(), '.ct-memory', 'team_memory.db');

export function getDefaultTeamMemoryPath(): string {
  return process.env.CT_TEAM_MEMORY_DB || DEFAULT_TEAM_MEMORY_PATH;
}

export function matchesFilePath(pattern: string | null | undefined, filePath: string): boolean {
  if (!pattern || pattern === '' || pattern === '**' || pattern === '*') {
    return true;
  }
  if (!filePath) {
    return false;
  }
  if (pattern === filePath) {
    return true;
  }
  let regStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\?/g, '__QUESTION__')
    .replace(/\/\*\*\//g, '__SLASH_GLOBSTAR_SLASH__')
    .replace(/\*\*/g, '__GLOBSTAR__')
    .replace(/\*/g, '__STAR__')
    .replace(/__SLASH_GLOBSTAR_SLASH__/g, '(?:/|/.+/)?')
    .replace(/__GLOBSTAR__/g, '.*')
    .replace(/__STAR__/g, '[^/]*')
    .replace(/__QUESTION__/g, '.');

  return new RegExp(`^${regStr}$`).test(filePath);
}

export class PRMemoryStore {
  private db: DatabaseSync;
  private dbPath: string;
  private adapter?: MemoryAdapter;

  constructor(dbPathOrConfigOrAdapter?: string | MemoryAdapterConfig | MemoryAdapter) {
    if (dbPathOrConfigOrAdapter && typeof dbPathOrConfigOrAdapter === 'object' && 'providerName' in dbPathOrConfigOrAdapter) {
      this.adapter = dbPathOrConfigOrAdapter as MemoryAdapter;
      this.dbPath = ':memory:';
      this.db = new DatabaseSync(':memory:');
      this.initDatabase();
      return;
    }

    const defaultPath = process.env.NODE_ENV === 'test'
      ? ':memory:'
      : (process.env.CT_REVIEW_DATA_DIR
        ? path.join(process.env.CT_REVIEW_DATA_DIR, 'team_memory.db')
        : DEFAULT_TEAM_MEMORY_PATH);
    this.dbPath = typeof dbPathOrConfigOrAdapter === 'string'
      ? dbPathOrConfigOrAdapter
      : (process.env.CT_TEAM_MEMORY_DB || process.env.CT_REVIEW_MEMORY_DB || defaultPath);

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

    const shouldEnableHoncho = typeof dbPathOrConfigOrAdapter !== 'string' && (
      process.env.NODE_ENV === 'test'
        ? (process.env.MEMORY_PROVIDER === 'honcho' || process.env.MEMORY_PROVIDER === 'composite')
        : Boolean(process.env.HONCHO_API_KEY || process.env.MEMORY_PROVIDER === 'honcho' || process.env.MEMORY_PROVIDER === 'composite')
    );

    if (shouldEnableHoncho) {
      try {
        this.adapter = createMemoryAdapter({
          provider: (process.env.MEMORY_PROVIDER as any) || 'composite',
          sqlite: { dbPath: this.dbPath },
        });
      } catch (err: any) {
        logger.warn('Failed to initialize Honcho memory adapter in PRMemoryStore', { error: err?.message });
      }
    }
  }

  public getAdapter(): MemoryAdapter | undefined {
    return this.adapter;
  }

  public getDbPath(): string {
    return this.dbPath;
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
        suppression_count INTEGER DEFAULT 0,
        rule_id TEXT
      );

      CREATE TABLE IF NOT EXISTS team_rules (
        id TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        rule_id TEXT,
        pattern TEXT NOT NULL,
        file_path TEXT,
        reason TEXT,
        category TEXT,
        created_at TEXT NOT NULL
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

      CREATE TABLE IF NOT EXISTS path_instructions (
        id TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        path_pattern TEXT NOT NULL,
        instructions TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_learnings_repo ON learnings(repo);
      CREATE INDEX IF NOT EXISTS idx_learnings_repo_cat_file ON learnings(repo, category, file_path);
      CREATE INDEX IF NOT EXISTS idx_nits_repo ON resolved_nits(repo);
      CREATE INDEX IF NOT EXISTS idx_nits_repo_file ON resolved_nits(repo, file_path);
      CREATE INDEX IF NOT EXISTS idx_nits_rule_id ON resolved_nits(repo, rule_id);
      CREATE INDEX IF NOT EXISTS idx_team_rules_repo ON team_rules(repo);
      CREATE INDEX IF NOT EXISTS idx_adr_repo ON adr_constraints(repo);
      CREATE INDEX IF NOT EXISTS idx_adr_repo_status ON adr_constraints(repo, status);
      CREATE INDEX IF NOT EXISTS idx_feedback_repo ON feedback_events(repo);
      CREATE INDEX IF NOT EXISTS idx_path_inst_repo ON path_instructions(repo);
    `);

    try {
      this.db.exec('ALTER TABLE resolved_nits ADD COLUMN rule_id TEXT;');
    } catch (_) {}
  }

  public async recordLearning(
    repo: string,
    prNumber: number,
    learning: Omit<ReviewerLearning, 'repo' | 'prNumber'>
  ): Promise<ReviewerLearning> {
    if (this.adapter) {
      const record = await this.adapter.recordLearning(repo, prNumber, learning);
      if (postgresStore.isConfigured()) {
        try {
          await postgresStore.saveLearnedRule(record as any);
        } catch (err: any) {
          logger.warn('Failed dual-write learned rule to PostgreSQL', { error: err?.message });
        }
      }
      return record;
    }

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

    const record = { id, repo, prNumber, ...learning, category, title, description, createdAt, updatedAt };

    if (postgresStore.isConfigured()) {
      try {
        await postgresStore.saveLearnedRule(record);
      } catch (err: any) {
        logger.warn('Failed dual-write learned rule to PostgreSQL', { error: err?.message });
      }
    }

    return record;
  }

  public async recordResolvedNit(
    repo: string,
    prNumber: number,
    nit: Omit<ResolvedNitPattern, 'repo' | 'prNumber'> & { ruleId?: string }
  ): Promise<ResolvedNitPattern> {
    if (this.adapter) {
      const record = await this.adapter.recordResolvedNit(repo, prNumber, nit);
      if (postgresStore.isConfigured()) {
        try {
          await postgresStore.saveSuppressedNit(record as any);
        } catch (err: any) {
          logger.warn('Failed dual-write suppressed nit to PostgreSQL', { error: err?.message });
        }
      }
      return record;
    }

    const id = nit.id || `nit_${crypto.randomUUID().slice(0, 8)}`;
    const resolvedAt = nit.resolvedAt || new Date().toISOString();
    const suppressionCount = nit.suppressionCount || 0;
    const ruleId = nit.ruleId || null;
    const stmt = this.db.prepare(`
      INSERT INTO resolved_nits (id, repo, pr_number, pattern, file_path, reason, head_sha, resolved_at, suppression_count, rule_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      repo,
      prNumber,
      nit.pattern,
      nit.filePath !== undefined && nit.filePath !== null ? nit.filePath : '',
      nit.reason !== undefined && nit.reason !== null ? nit.reason : '',
      nit.headSha || null,
      resolvedAt,
      suppressionCount,
      ruleId
    );

    const record: ResolvedNitPattern = {
      id,
      repo,
      prNumber,
      suppressionCount,
      ...nit,
      ruleId: ruleId || undefined,
      resolvedAt,
    };

    if (postgresStore.isConfigured()) {
      try {
        await postgresStore.saveSuppressedNit(record as any);
      } catch (err: any) {
        logger.warn('Failed dual-write suppressed nit to PostgreSQL', { error: err?.message });
      }
    }

    return record;
  }

  public async recordTeamRule(
    repo: string,
    rule: { ruleId?: string; pattern: string; filePath?: string; reason?: string; prNumber?: number; category?: string }
  ): Promise<ResolvedNitPattern> {
    const id = `rule_${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    try {
      this.db.prepare(`
        INSERT INTO team_rules (id, repo, rule_id, pattern, file_path, reason, category, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        repo,
        rule.ruleId || null,
        rule.pattern,
        rule.filePath || '**',
        rule.reason || 'Team-accepted rule',
        rule.category || 'convention',
        now
      );
    } catch (_) {}

    return this.recordResolvedNit(repo, rule.prNumber || 0, {
      id,
      ruleId: rule.ruleId,
      pattern: rule.pattern,
      filePath: rule.filePath || '**',
      reason: rule.reason || 'Team-accepted rule',
    });
  }

  public async recordADRConstraint(
    repo: string,
    adr: Omit<ADRConstraint, 'repo'>
  ): Promise<ADRConstraint> {
    if (this.adapter) {
      const record = await this.adapter.recordAdrConstraint(repo, adr);
      if (postgresStore.isConfigured()) {
        try {
          await postgresStore.saveADRConstraint(record as any);
        } catch (err: any) {
          logger.warn('Failed dual-write ADR constraint to PostgreSQL', { error: err?.message });
        }
      }
      return record;
    }

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
      JSON.stringify(adr.targetPaths || []),
      createdAt
    );

    const record = { id, repo, ...adr, createdAt };

    if (postgresStore.isConfigured()) {
      try {
        await postgresStore.saveADRConstraint(record);
      } catch (err: any) {
        logger.warn('Failed dual-write ADR constraint to PostgreSQL', { error: err?.message });
      }
    }

    return record;
  }

  public async recordPathInstruction(
    repo: string,
    rule: Omit<PathInstructionRule, 'repo'>
  ): Promise<PathInstructionRule> {
    if (this.adapter && this.adapter.recordPathInstruction) {
      return this.adapter.recordPathInstruction(repo, rule);
    }
    const id = rule.id || `inst_${crypto.randomUUID().slice(0, 8)}`;
    const createdAt = rule.createdAt || new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO path_instructions (id, repo, path_pattern, instructions, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(id, repo, rule.pathPattern, rule.instructions, createdAt);
    return { id, repo, ...rule, createdAt };
  }

  public queryPathInstructions(repo: string): PathInstructionRule[] {
    try {
      const stmt = this.db.prepare('SELECT * FROM path_instructions WHERE repo = ?');
      const rows = stmt.all(repo) as any[];
      return rows.map((r) => ({
        id: r.id,
        repo: r.repo,
        pathPattern: r.path_pattern,
        instructions: r.instructions,
        createdAt: r.created_at,
      }));
    } catch {
      return [];
    }
  }

  private incrementNitStmt?: any;

  public async incrementNitSuppression(id: string): Promise<void> {
    if (this.adapter) {
      await this.adapter.incrementNitSuppression(id);
      if (postgresStore.isConfigured()) {
        try {
          await postgresStore.incrementNitSuppression(id);
        } catch (err: any) {
          logger.warn('Failed dual-write incrementNitSuppression to PostgreSQL', { error: err?.message });
        }
      }
      return;
    }

    if (!this.incrementNitStmt) {
      this.incrementNitStmt = this.db.prepare('UPDATE resolved_nits SET suppression_count = suppression_count + 1 WHERE id = ?');
    }
    this.incrementNitStmt.run(id);

    if (postgresStore.isConfigured()) {
      try {
        await postgresStore.incrementNitSuppression(id);
      } catch (err: any) {
        logger.warn('Failed dual-write incrementNitSuppression to PostgreSQL', { error: err?.message });
      }
    }
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

    if (postgresStore.isConfigured()) {
      try {
        await postgresStore.incrementNitSuppressionBatch(ids);
      } catch (err: any) {
        logger.warn('Failed dual-write incrementNitSuppressionBatch to PostgreSQL', { error: err?.message });
      }
    }
  }

  public async queryLearnings(
    repo: string,
    options: { category?: string; filePath?: string; query?: string; ruleId?: string } = {}
  ): Promise<RepoMemoryState> {
    if (postgresStore.isConfigured()) {
      try {
        const pgState = await postgresStore.queryLearnings(repo, options);
        return pgState as RepoMemoryState;
      } catch (err: any) {
        logger.warn('PostgreSQL queryLearnings failed, seamlessly falling back to local SQLite', { error: err?.message });
      }
    }

    if (this.adapter) {
      let learnings = await this.adapter.getLearnings(repo, options);
      if (options.query) {
        const q = options.query.toLowerCase();
        learnings = learnings.filter((l) =>
          l.title.toLowerCase().includes(q) || l.description.toLowerCase().includes(q)
        );
      }
      let resolvedNits = await this.adapter.getResolvedNits(repo, options.filePath);
      if (options.ruleId) {
        resolvedNits = resolvedNits.filter((n) => n.ruleId === options.ruleId || n.id === options.ruleId || n.pattern === options.ruleId);
      }
      const adrConstraints = await this.adapter.getAdrConstraints(repo, 'accepted');
      return { learnings, resolvedNits, adrConstraints };
    }

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
    if (options.ruleId) {
      nSql += ' AND (rule_id = ? OR id = ? OR pattern = ?)';
      nParams.push(options.ruleId, options.ruleId, options.ruleId);
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
      ruleId: r.rule_id || undefined,
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

  public async queryResolvedNits(
    repo: string,
    filter: { filePath?: string; ruleId?: string; pattern?: string } = {}
  ): Promise<ResolvedNitPattern[]> {
    const memory = await this.queryLearnings(repo, { ruleId: filter.ruleId });
    let nits = memory.resolvedNits;
    if (filter.filePath) {
      nits = nits.filter((n) => !n.filePath || n.filePath === '**' || matchesFilePath(n.filePath, filter.filePath!));
    }
    if (filter.pattern) {
      const p = filter.pattern.toLowerCase();
      nits = nits.filter((n) => n.pattern.toLowerCase().includes(p));
    }
    return nits;
  }

  public async getLearnings(
    repo: string,
    options?: { category?: string; filePath?: string; limit?: number }
  ): Promise<ReviewerLearning[]> {
    if (this.adapter) {
      return this.adapter.getLearnings(repo, options);
    }
    const state = await this.queryLearnings(repo, options as any);
    return state.learnings;
  }

  public async getResolvedNits(repo: string, filePath?: string): Promise<ResolvedNitPattern[]> {
    if (this.adapter) {
      return this.adapter.getResolvedNits(repo, filePath);
    }
    return this.queryResolvedNits(repo, { filePath });
  }

  public async recordFeedback(repo: string, reaction: string, feedbackType: 'positive' | 'negative' = 'positive'): Promise<void> {
    const id = `fb_${crypto.randomUUID().slice(0, 8)}`;
    const stmt = this.db.prepare(`
      INSERT INTO feedback_events (id, repo, reaction, feedback_type)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(id, repo, reaction, feedbackType);

    if (postgresStore.isConfigured()) {
      try {
        await postgresStore.saveDeveloperFeedback({
          id,
          repo,
          feedbackType,
          comment: reaction,
        });
      } catch (err: any) {
        logger.warn('Failed dual-write feedback to PostgreSQL', { error: err?.message });
      }
    }
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
    if (this.adapter && this.adapter.clear) {
      await this.adapter.clear(repo);
    }
    this.db.prepare('DELETE FROM learnings WHERE repo = ?').run(repo);
    this.db.prepare('DELETE FROM resolved_nits WHERE repo = ?').run(repo);
    this.db.prepare('DELETE FROM adr_constraints WHERE repo = ?').run(repo);
    this.db.prepare('DELETE FROM feedback_events WHERE repo = ?').run(repo);

    if (postgresStore.isConfigured()) {
      try {
        await postgresStore.clearRepoMemory(repo);
      } catch (err: any) {
        logger.warn('Failed clearRepoMemory on PostgreSQL', { error: err?.message });
      }
    }
  }

  public async forgetPattern(repo: string, pattern: string): Promise<boolean> {
    const trimmed = pattern.trim();
    let localDeleted = false;
    try {
      const like = `%${trimmed}%`;
      const d1 = this.db.prepare('DELETE FROM resolved_nits WHERE repo = ? AND (pattern = ? OR pattern LIKE ?)').run(repo, trimmed, like);
      const d2 = this.db.prepare('DELETE FROM learnings WHERE repo = ? AND (title LIKE ? OR description LIKE ?)').run(repo, like, like);
      localDeleted = (Number(d1.changes) + Number(d2.changes)) > 0;
    } catch (_) {}

    if (this.adapter && this.adapter.forgetPattern) {
      const adapterDeleted = await this.adapter.forgetPattern(repo, pattern).catch(() => false);
      return localDeleted || adapterDeleted;
    }
    return localDeleted;
  }

  public async degradePatternConfidence(repo: string, pattern: string, penalty: number = 0.2): Promise<void> {
    const trimmed = pattern.trim();
    try {
      const like = `%${trimmed}%`;
      this.db.prepare('UPDATE learnings SET confidence = MAX(0.0, confidence - ?) WHERE repo = ? AND (title LIKE ? OR description LIKE ?)').run(penalty, repo, like, like);
      this.db.prepare('UPDATE resolved_nits SET suppression_count = suppression_count + 1 WHERE repo = ? AND (pattern = ? OR pattern LIKE ?)').run(repo, trimmed, like);
    } catch (_) {}

    if (this.adapter && this.adapter.degradePatternConfidence) {
      await this.adapter.degradePatternConfidence(repo, pattern, penalty).catch(() => {});
    }
  }

  public async deleteConclusion(id: string): Promise<boolean> {
    let localDeleted = false;
    try {
      const d1 = this.db.prepare('DELETE FROM learnings WHERE id = ?').run(id);
      const d2 = this.db.prepare('DELETE FROM resolved_nits WHERE id = ?').run(id);
      const d3 = this.db.prepare('DELETE FROM adr_constraints WHERE id = ?').run(id);
      localDeleted = (Number(d1.changes) + Number(d2.changes) + Number(d3.changes)) > 0;
    } catch (_) {}

    if (this.adapter && this.adapter.deleteConclusion) {
      const adapterDeleted = await this.adapter.deleteConclusion(id).catch(() => false);
      return localDeleted || adapterDeleted;
    }
    return localDeleted;
  }

  public getCounts(): { learningsCount: number; suppressedNitsCount: number; adrConstraintsCount: number } {
    if (this.adapter && typeof (this.adapter as any).getCounts === 'function') {
      return (this.adapter as any).getCounts();
    }
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
    if (this.adapter && this.adapter.close) {
      this.adapter.close().catch(() => {});
    }
    if (this.db && typeof this.db.close === 'function') {
      try {
        this.db.close();
      } catch {
        // Ignore double close
      }
    }
  }
}
