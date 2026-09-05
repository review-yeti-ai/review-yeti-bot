// @ts-ignore
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
const { DatabaseSync: DatabaseSyncImpl } = (() => {
  try {
    return require("node:sqlite");
  } catch {
    return { DatabaseSync: class {} };
  }
})();
const DatabaseSync: any = DatabaseSyncImpl;
type DatabaseSync = DatabaseSyncType;

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { logger } from "../../utils/logger";
import {
  MemoryAdapter,
  ReviewerLearning,
  ResolvedNitPattern,
  ADRConstraint,
  PathInstructionRule,
  LearningQueryOptions,
  SQLiteAdapterConfig,
} from "./types";

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

export class SQLiteMemoryAdapter implements MemoryAdapter {
  public readonly providerName = "sqlite";
  private db: DatabaseSync;
  private dbPath: string;

  constructor(config?: SQLiteAdapterConfig) {
    const defaultPath = process.env.NODE_ENV === "test"
      ? ":memory:"
      : (process.env.CT_REVIEW_DATA_DIR
        ? path.join(process.env.CT_REVIEW_DATA_DIR, "team_memory.db")
        : path.join(process.cwd(), ".ct-memory", "team_memory.db"));

    this.dbPath = config?.dbPath || process.env.CT_TEAM_MEMORY_DB || process.env.CT_REVIEW_MEMORY_DB || defaultPath;

    if (this.dbPath === ":memory:" || this.dbPath.startsWith(":memory:")) {
      this.db = new DatabaseSync(":memory:");
    } else {
      const dir = path.dirname(this.dbPath);
      if (dir && dir !== "." && !fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      this.db = new DatabaseSync(this.dbPath);
    }
    this.initDatabaseSync();
  }

  public getDbPath(): string {
    return this.dbPath;
  }

  public async initialize(): Promise<void> {
    this.initDatabaseSync();
  }

  public initDatabaseSync(): void {
    try {
      this.db.exec("PRAGMA journal_mode = WAL;");
    } catch (_) {}
    try {
      this.db.exec("PRAGMA synchronous = NORMAL;");
    } catch (_) {}
    try {
      this.db.exec("PRAGMA busy_timeout = 5000;");
    } catch (_) {}
    try {
      this.db.exec("PRAGMA temp_store = MEMORY;");
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
      this.db.exec("ALTER TABLE resolved_nits ADD COLUMN rule_id TEXT;");
    } catch (_) {}
  }

  public async recordLearning(
    repo: string,
    prNumber: number,
    learning: Omit<ReviewerLearning, "repo" | "prNumber">
  ): Promise<ReviewerLearning> {
    const id = learning.id || `lrn_${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const createdAt = learning.createdAt || now;
    const updatedAt = learning.updatedAt || now;
    const title = learning.title || (learning as any).rule || "Learned Rule";
    const description = learning.description || (learning as any).rule || "Learned from PR review feedback";
    const category = learning.category || "convention";

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

  public async getLearnings(repo: string, options?: LearningQueryOptions): Promise<ReviewerLearning[]> {
    let query = "SELECT * FROM learnings WHERE repo = ?";
    const params: any[] = [repo];

    if (options?.category) {
      query += " AND category = ?";
      params.push(options.category);
    }

    query += " ORDER BY created_at DESC";

    if (options?.limit) {
      query += " LIMIT ?";
      params.push(options.limit);
    }

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as any[];

    const results = rows.map((r) => ({
      id: r.id,
      repo: r.repo,
      prNumber: r.pr_number,
      category: r.category,
      title: r.title,
      description: r.description,
      filePath: r.file_path,
      confidence: r.confidence,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));

    if (options?.filePath) {
      return results.filter((l) => !l.filePath || matchesFilePath(l.filePath, options.filePath!));
    }

    return results;
  }

  public async recordResolvedNit(
    repo: string,
    prNumber: number,
    nit: Omit<ResolvedNitPattern, "repo" | "prNumber">
  ): Promise<ResolvedNitPattern> {
    const id = nit.id || `nit_${crypto.randomUUID().slice(0, 8)}`;
    const resolvedAt = nit.resolvedAt || new Date().toISOString();
    const pattern = nit.pattern.trim();
    const filePath = nit.filePath || "**";
    const reason = nit.reason || "Marked as resolved by developer";
    const suppressionCount = nit.suppressionCount ?? 0;
    const ruleId = nit.ruleId || null;

    const stmt = this.db.prepare(`
      INSERT INTO resolved_nits (id, repo, pr_number, pattern, file_path, reason, head_sha, resolved_at, suppression_count, rule_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      repo,
      prNumber,
      pattern,
      filePath,
      reason,
      nit.headSha || null,
      resolvedAt,
      suppressionCount,
      ruleId
    );

    return {
      id,
      repo,
      prNumber,
      pattern,
      filePath,
      reason,
      headSha: nit.headSha,
      resolvedAt,
      suppressionCount,
      ruleId: ruleId || undefined,
    };
  }

  public async getResolvedNits(repo: string, filePath?: string): Promise<ResolvedNitPattern[]> {
    const stmt = this.db.prepare("SELECT * FROM resolved_nits WHERE repo = ? ORDER BY resolved_at DESC");
    const rows = stmt.all(repo) as any[];

    const nits: ResolvedNitPattern[] = rows.map((r) => ({
      id: r.id,
      ruleId: r.rule_id || undefined,
      repo: r.repo,
      prNumber: r.pr_number,
      pattern: r.pattern,
      filePath: r.file_path,
      reason: r.reason,
      headSha: r.head_sha,
      resolvedAt: r.resolved_at,
      suppressionCount: r.suppression_count,
    }));

    if (filePath) {
      return nits.filter((n) => matchesFilePath(n.filePath, filePath));
    }

    return nits;
  }

  public async incrementNitSuppression(id: string): Promise<void> {
    try {
      const stmt = this.db.prepare("UPDATE resolved_nits SET suppression_count = suppression_count + 1 WHERE id = ?");
      stmt.run(id);
    } catch (err: any) {
      logger.warn("Failed to increment nit suppression count", { id, error: err?.message });
    }
  }

  public async recordAdrConstraint(
    repo: string,
    constraint: Omit<ADRConstraint, "repo">
  ): Promise<ADRConstraint> {
    const id = constraint.id || `adr_${constraint.adrNumber}_${crypto.randomUUID().slice(0, 4)}`;
    const createdAt = constraint.createdAt || new Date().toISOString();
    const targetPathsStr = JSON.stringify(constraint.targetPaths || []);

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
      targetPathsStr,
      createdAt
    );

    return { id, repo, ...constraint, createdAt };
  }

  public async getAdrConstraints(
    repo: string,
    status?: "draft" | "accepted" | "deprecated"
  ): Promise<ADRConstraint[]> {
    let query = "SELECT * FROM adr_constraints WHERE repo = ?";
    const params: any[] = [repo];

    if (status) {
      query += " AND status = ?";
      params.push(status);
    }

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as any[];

    return rows.map((r) => {
      let targetPaths: string[] = [];
      try {
        targetPaths = JSON.parse(r.target_paths);
      } catch {
        targetPaths = [r.target_paths];
      }
      return {
        id: r.id,
        repo: r.repo,
        adrNumber: r.adr_number,
        title: r.title,
        status: r.status,
        rule: r.rule,
        targetPaths,
        createdAt: r.created_at,
      };
    });
  }

  public async recordPathInstruction(
    repo: string,
    rule: Omit<PathInstructionRule, "repo">
  ): Promise<PathInstructionRule> {
    const id = rule.id || `pi_${crypto.randomUUID().slice(0, 8)}`;
    const createdAt = rule.createdAt || new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO path_instructions (id, repo, path_pattern, instructions, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(id, repo, rule.pathPattern, rule.instructions, createdAt);

    return { id, repo, pathPattern: rule.pathPattern, instructions: rule.instructions, createdAt };
  }

  public async getPathInstructions(repo: string, filePath?: string): Promise<PathInstructionRule[]> {
    const stmt = this.db.prepare("SELECT * FROM path_instructions WHERE repo = ? ORDER BY created_at DESC");
    const rows = stmt.all(repo) as any[];

    const instructions: PathInstructionRule[] = rows.map((r) => ({
      id: r.id,
      repo: r.repo,
      pathPattern: r.path_pattern,
      instructions: r.instructions,
      createdAt: r.created_at,
    }));

    if (filePath) {
      return instructions.filter((i) => matchesFilePath(i.pathPattern, filePath));
    }

    return instructions;
  }

  public async deleteConclusion(id: string): Promise<boolean> {
    const d1 = this.db.prepare("DELETE FROM learnings WHERE id = ?").run(id);
    const d2 = this.db.prepare("DELETE FROM resolved_nits WHERE id = ?").run(id);
    const d3 = this.db.prepare("DELETE FROM adr_constraints WHERE id = ?").run(id);
    return (Number(d1.changes) + Number(d2.changes) + Number(d3.changes)) > 0;
  }

  public async forgetPattern(repo: string, pattern: string): Promise<boolean> {
    const trimmed = pattern.trim();
    const likePattern = `%${trimmed}%`;
    const d1 = this.db.prepare("DELETE FROM resolved_nits WHERE repo = ? AND (pattern = ? OR pattern LIKE ?)").run(repo, trimmed, likePattern);
    const d2 = this.db.prepare("DELETE FROM learnings WHERE repo = ? AND (title LIKE ? OR description LIKE ?)").run(repo, likePattern, likePattern);
    const totalDeleted = Number(d1.changes) + Number(d2.changes);
    logger.info("Forgot pattern from SQLite memory", { repo, pattern: trimmed, deletedCount: totalDeleted });
    return totalDeleted > 0;
  }

  public async degradePatternConfidence(repo: string, pattern: string, penalty: number = 0.2): Promise<void> {
    const trimmed = pattern.trim();
    const likePattern = `%${trimmed}%`;
    this.db.prepare("UPDATE learnings SET confidence = MAX(0.0, confidence - ?) WHERE repo = ? AND (title LIKE ? OR description LIKE ?)").run(penalty, repo, likePattern, likePattern);
    this.db.prepare("UPDATE resolved_nits SET suppression_count = suppression_count + 1 WHERE repo = ? AND (pattern = ? OR pattern LIKE ?)").run(repo, trimmed, likePattern);
    logger.info("Degraded pattern confidence in SQLite memory", { repo, pattern: trimmed, penalty });
  }

  public async clear(repo?: string): Promise<void> {
    if (repo) {
      this.db.prepare("DELETE FROM learnings WHERE repo = ?").run(repo);
      this.db.prepare("DELETE FROM resolved_nits WHERE repo = ?").run(repo);
      this.db.prepare("DELETE FROM adr_constraints WHERE repo = ?").run(repo);
      this.db.prepare("DELETE FROM team_rules WHERE repo = ?").run(repo);
      this.db.prepare("DELETE FROM path_instructions WHERE repo = ?").run(repo);
    } else {
      this.db.exec("DELETE FROM learnings; DELETE FROM resolved_nits; DELETE FROM adr_constraints; DELETE FROM team_rules; DELETE FROM path_instructions;");
    }
  }

  public getCounts(): { learningsCount: number; suppressedNitsCount: number; adrConstraintsCount: number } {
    try {
      const l = this.db.prepare("SELECT COUNT(*) as cnt FROM learnings").get() as { cnt: number } | undefined;
      const n = this.db.prepare("SELECT COUNT(*) as cnt FROM resolved_nits").get() as { cnt: number } | undefined;
      const a = this.db.prepare("SELECT COUNT(*) as cnt FROM adr_constraints").get() as { cnt: number } | undefined;
      return {
        learningsCount: l?.cnt || 0,
        suppressedNitsCount: n?.cnt || 0,
        adrConstraintsCount: a?.cnt || 0,
      };
    } catch {
      return { learningsCount: 0, suppressedNitsCount: 0, adrConstraintsCount: 0 };
    }
  }

  public async close(): Promise<void> {
    try {
      (this.db as any).close?.();
    } catch (_) {}
  }
}
