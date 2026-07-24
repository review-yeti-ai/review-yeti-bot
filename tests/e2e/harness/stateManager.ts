import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let SqliteDatabase: any;
try {
  SqliteDatabase = require('better-sqlite3');
} catch {
  SqliteDatabase = null;
}

export interface TestEnvironmentContext {
  testRunId: string;
  rootDir: string;
  repoDir: string;
  stateDir: string;
  dbPath: string;
  configPath: string;
  constitutionPath: string;
  env: Record<string, string>;
  db: any;
  isJsonFallback: boolean;
}

export interface TrackedFindingRecord {
  id: string;
  pr_id: number;
  finding_hash: string;
  persona: string;
  severity: string;
  file_path: string;
  line_number: number;
  status: string;
  comment_id?: string;
  created_at?: string;
  resolved_at?: string;
}

export interface PrDiffStateRecord {
  pr_id: number;
  repo_full_name: string;
  last_commit_sha: string;
  updated_at?: string;
}

class JsonDatabaseFallback {
  private jsonPath: string;
  private data: {
    pr_states: Record<number, any>;
    diff_hunks: any[];
    tracked_findings: Record<string, any>;
  };

  constructor(jsonPath: string) {
    this.jsonPath = jsonPath;
    this.data = {
      pr_states: {},
      diff_hunks: [],
      tracked_findings: {},
    };
    this.persist();
  }

  private persist(): void {
    fs.writeFileSync(this.jsonPath, JSON.stringify(this.data, null, 2), 'utf-8');
  }

  public exec(_sql: string): void {
    // No-op for DDL creation in JSON mode
  }

  public prepare(sql: string) {
    const trimmed = sql.trim();

    if (trimmed.includes('FROM tracked_findings')) {
      return {
        all: (prId: number) => {
          return Object.values(this.data.tracked_findings)
            .filter((f: any) => f.pr_id === prId || f.pr_state_id === prId)
            .map((f: any) => ({
              id: f.id,
              pr_id: prId,
              finding_hash: f.fingerprint_hash || f.finding_hash || f.id,
              persona: f.persona,
              severity: f.severity,
              file_path: f.file_path,
              line_number: f.start_line || f.line_number || 1,
              status: f.status,
              comment_id: f.comment_id,
              created_at: f.created_at,
              resolved_at: f.resolved_at_commit || f.resolved_at,
            }))
            .sort((a, b) => a.line_number - b.line_number);
        },
      };
    }

    if (trimmed.includes('FROM pr_states')) {
      return {
        get: (prId: number) => {
          const state = this.data.pr_states[prId];
          if (!state) return undefined;
          return {
            pr_id: state.pr_number || state.pr_id || prId,
            repo_full_name: state.repo_full_name || `${state.repo_owner}/${state.repo_name}`,
            last_commit_sha: state.head_sha || state.last_commit_sha,
            updated_at: state.updated_at,
          };
        },
      };
    }

    if (trimmed.startsWith('INSERT INTO pr_states')) {
      return {
        run: (...args: any[]) => {
          const prId = typeof args[2] === 'number' ? args[2] : args[0];
          this.data.pr_states[prId] = {
            id: 1,
            repo_owner: args[0],
            repo_name: args[1],
            pr_number: prId,
            head_sha: args[3],
            base_sha: args[4],
            updated_at: new Date().toISOString(),
          };
          this.persist();
          return { lastInsertRowid: 1, id: 1, changes: 1 };
        },
      };
    }

    if (trimmed.startsWith('INSERT INTO tracked_findings')) {
      return {
        run: (...args: any[]) => {
          if (typeof args[0] === 'number') {
            // (pr_state_id, fingerprint_hash, file_path, start_line, end_line, persona, severity, comment, status, ...)
            const id = String(args[1] || Date.now());
            this.data.tracked_findings[id] = {
              id,
              pr_state_id: args[0],
              pr_id: args[0],
              fingerprint_hash: args[1],
              file_path: args[2],
              start_line: args[3],
              line_number: args[3],
              end_line: args[4],
              persona: args[5],
              severity: args[6],
              comment: args[7] || '',
              status: args[8] || 'IDENTIFIED',
              created_at: new Date().toISOString(),
            };
          } else {
            // (id, pr_id, finding_hash, persona, severity, file_path, line_number, status)
            const id = String(args[0] || 'f1');
            this.data.tracked_findings[id] = {
              id,
              pr_id: args[1],
              pr_state_id: args[1],
              fingerprint_hash: args[2],
              persona: args[3],
              severity: args[4],
              file_path: args[5],
              start_line: args[6],
              line_number: args[6],
              status: args[7],
              created_at: new Date().toISOString(),
            };
          }
          this.persist();
          return { changes: 1 };
        },
      };
    }

    return {
      all: () => [],
      get: () => undefined,
      run: () => ({ lastInsertRowid: 1, id: 1, changes: 0 }),
    };
  }

  public close(): void {
    this.persist();
  }
}

export class StateManager {
  private activeContexts: Map<string, TestEnvironmentContext> = new Map();

  /**
   * Initializes an isolated filesystem sandbox and database context for a test run.
   */
  public async createEnvironment(testRunId: string): Promise<TestEnvironmentContext> {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), `ct-e2e-${testRunId}-`));
    const repoDir = path.join(rootDir, 'repo');
    const stateDir = path.join(rootDir, 'state');
    const dbPath = path.join(stateDir, 'review_state.sqlite');
    const jsonPath = path.join(stateDir, 'review_state.json');
    const configPath = path.join(repoDir, '.ct-review.yaml');
    const constitutionDir = path.join(repoDir, '.github');
    const constitutionPath = path.join(constitutionDir, 'constitution.md');

    fs.mkdirSync(repoDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(constitutionDir, { recursive: true });

    let db: any;
    let isJsonFallback = false;

    if (SqliteDatabase) {
      try {
        db = new SqliteDatabase(dbPath);
        db.exec(`
          CREATE TABLE IF NOT EXISTS pr_states (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            repo_owner TEXT NOT NULL,
            repo_name TEXT NOT NULL,
            pr_number INTEGER NOT NULL,
            head_sha TEXT NOT NULL,
            base_sha TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(repo_owner, repo_name, pr_number)
          );

          CREATE TABLE IF NOT EXISTS diff_hunks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pr_state_id INTEGER NOT NULL REFERENCES pr_states(id) ON DELETE CASCADE,
            file_path TEXT NOT NULL,
            hunk_hash TEXT NOT NULL,
            old_start INTEGER NOT NULL,
            old_lines INTEGER NOT NULL,
            new_start INTEGER NOT NULL,
            new_lines INTEGER NOT NULL,
            commit_sha TEXT NOT NULL,
            created_at TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS tracked_findings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pr_state_id INTEGER NOT NULL REFERENCES pr_states(id) ON DELETE CASCADE,
            fingerprint_hash TEXT NOT NULL,
            file_path TEXT NOT NULL,
            start_line INTEGER NOT NULL,
            end_line INTEGER NOT NULL,
            persona TEXT NOT NULL,
            severity TEXT NOT NULL,
            comment TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('IDENTIFIED', 'RESOLVED', 'SUPPRESSED')),
            first_seen_commit TEXT NOT NULL,
            last_seen_commit TEXT NOT NULL,
            resolved_at_commit TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(pr_state_id, fingerprint_hash)
          );

          CREATE INDEX IF NOT EXISTS idx_pr_states_lookup ON pr_states(repo_owner, repo_name, pr_number);
          CREATE INDEX IF NOT EXISTS idx_findings_lookup ON tracked_findings(pr_state_id, fingerprint_hash);
          CREATE INDEX IF NOT EXISTS idx_hunks_lookup ON diff_hunks(pr_state_id, file_path);
        `);
      } catch {
        db = new JsonDatabaseFallback(jsonPath);
        isJsonFallback = true;
      }
    } else {
      db = new JsonDatabaseFallback(jsonPath);
      isJsonFallback = true;
    }

    const env = {
      NODE_ENV: 'test',
      CT_REVIEW_DB_PATH: isJsonFallback ? jsonPath : dbPath,
      CT_REVIEW_CONFIG_PATH: configPath,
      CT_REVIEW_CONSTITUTION_PATH: constitutionPath,
      CT_REVIEW_STATE_DIR: stateDir,
    };

    const ctx: TestEnvironmentContext = {
      testRunId,
      rootDir,
      repoDir,
      stateDir,
      dbPath: isJsonFallback ? jsonPath : dbPath,
      configPath,
      constitutionPath,
      env,
      db,
      isJsonFallback,
    };

    this.activeContexts.set(testRunId, ctx);
    return ctx;
  }

  /**
   * Writes fixture files (.ct-review.yaml, constitution.md) into the isolated sandbox repo.
   */
  public setupFixtures(ctx: TestEnvironmentContext, configYaml: string, constitutionMd?: string): void {
    fs.writeFileSync(ctx.configPath, configYaml, 'utf-8');
    if (constitutionMd) {
      fs.writeFileSync(ctx.constitutionPath, constitutionMd, 'utf-8');
    }
  }

  /**
   * DB State Inspection Helper: Query tracked findings stored in the isolated database.
   */
  public getTrackedFindings(ctx: TestEnvironmentContext, prId: number): TrackedFindingRecord[] {
    const jsonPath = path.join(ctx.stateDir, 'review_state.json');

    try {
      let dbInstance = ctx.db;
      let freshDb: any = null;
      if (SqliteDatabase && ctx.dbPath && fs.existsSync(ctx.dbPath) && !ctx.isJsonFallback) {
        freshDb = new SqliteDatabase(ctx.dbPath, { readonly: true });
        dbInstance = freshDb;
      }
      const stmt = dbInstance.prepare(
        `SELECT
           tf.id,
           ps.pr_number as pr_id,
           tf.fingerprint_hash as finding_hash,
           tf.persona,
           tf.severity,
           tf.file_path,
           tf.start_line as line_number,
           tf.status,
           tf.created_at,
           tf.resolved_at_commit as resolved_at
         FROM tracked_findings tf
         JOIN pr_states ps ON tf.pr_state_id = ps.id
         WHERE ps.pr_number = ?
         ORDER BY tf.start_line ASC`
      );
      const result = stmt.all(prId) as TrackedFindingRecord[];
      if (freshDb) {
        freshDb.close();
      }
      if (result.length > 0) {
        return result;
      }
    } catch {
      // Fall through to JSON inspect
    }

    if (fs.existsSync(jsonPath)) {
      try {
        const raw = fs.readFileSync(jsonPath, 'utf-8');
        const data = JSON.parse(raw);
        for (const key of Object.keys(data)) {
          const prState = data[key];
          if (prState && (prState.prNumber === prId || key.endsWith(`#${prId}`))) {
            return (prState.findings || []).map((f: any, idx: number) => ({
              id: String(f.id || idx + 1),
              pr_id: prId,
              finding_hash: f.fingerprintHash || f.id || `hash-${idx}`,
              persona: f.persona,
              severity: f.severity,
              file_path: f.filePath,
              line_number: f.startLine || f.lineNumber || 1,
              status: f.status,
              created_at: f.createdAt,
              resolved_at: f.resolvedAtCommit || f.resolvedAt,
            }));
          }
        }
      } catch {
        // Ignore JSON read error
      }
    }

    return [];
  }

  /**
   * DB State Inspection Helper: Query PR commit state.
   */
  public getPrState(ctx: TestEnvironmentContext, prId: number): PrDiffStateRecord | undefined {
    const jsonPath = path.join(ctx.stateDir, 'review_state.json');

    try {
      let dbInstance = ctx.db;
      let freshDb: any = null;
      if (SqliteDatabase && ctx.dbPath && fs.existsSync(ctx.dbPath) && !ctx.isJsonFallback) {
        freshDb = new SqliteDatabase(ctx.dbPath, { readonly: true });
        dbInstance = freshDb;
      }
      const stmt = dbInstance.prepare(
        `SELECT
           pr_number as pr_id,
           repo_owner || '/' || repo_name as repo_full_name,
           head_sha as last_commit_sha,
           updated_at
         FROM pr_states
         WHERE pr_number = ?`
      );
      const result = stmt.get(prId) as PrDiffStateRecord | undefined;
      if (freshDb) {
        freshDb.close();
      }
      if (result) {
        return result;
      }
    } catch {
      // Fall through to JSON inspect
    }

    if (fs.existsSync(jsonPath)) {
      try {
        const raw = fs.readFileSync(jsonPath, 'utf-8');
        const data = JSON.parse(raw);
        for (const key of Object.keys(data)) {
          const prState = data[key];
          if (prState && (prState.prNumber === prId || key.endsWith(`#${prId}`))) {
            return {
              pr_id: prId,
              repo_full_name: `${prState.repoOwner}/${prState.repoName}`,
              last_commit_sha: prState.headSha,
              updated_at: prState.updatedAt,
            };
          }
        }
      } catch {
        // Ignore JSON read error
      }
    }

    return undefined;
  }

  /**
   * Cleanly closes DB connections and removes temporary directories.
   */
  public async teardownEnvironment(testRunId: string): Promise<void> {
    const ctx = this.activeContexts.get(testRunId);
    if (!ctx) return;

    try {
      if (ctx.db && typeof ctx.db.close === 'function') {
        ctx.db.close();
      }
    } catch {
      // Ignore database close errors
    }

    try {
      fs.rmSync(ctx.rootDir, { recursive: true, force: true });
    } catch {
      // Directory cleanup warning
    }

    this.activeContexts.delete(testRunId);
  }
}
