"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.JsonFileDiffStateStorage = exports.SqliteDiffStateStorage = void 0;
exports.createDiffStateStorage = createDiffStateStorage;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const logger_1 = require("../utils/logger");
class SqliteDiffStateStorage {
    db;
    dbPath;
    constructor(dbPath = ':memory:') {
        this.dbPath = dbPath;
    }
    async init() {
        let Database;
        try {
            Database = require('better-sqlite3');
        }
        catch (err) {
            throw new Error(`better-sqlite3 native module unavailable: ${err.message}`);
        }
        if (this.dbPath !== ':memory:') {
            const dir = path_1.default.dirname(this.dbPath);
            if (!fs_1.default.existsSync(dir)) {
                fs_1.default.mkdirSync(dir, { recursive: true });
            }
        }
        try {
            this.db = new Database(this.dbPath);
        }
        catch (err) {
            throw new Error(`better-sqlite3 initialization failed: ${err.message}`);
        }
        this.db.pragma('foreign_keys = ON');
        this.db.exec(`
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
    }
    async getPRState(owner, repo, prNumber) {
        const prRow = this.db
            .prepare('SELECT * FROM pr_states WHERE repo_owner = ? AND repo_name = ? AND pr_number = ?')
            .get(owner, repo, prNumber);
        if (!prRow)
            return null;
        const hunksRows = this.db
            .prepare('SELECT * FROM diff_hunks WHERE pr_state_id = ?')
            .all(prRow.id);
        const findingsRows = this.db
            .prepare('SELECT * FROM tracked_findings WHERE pr_state_id = ?')
            .all(prRow.id);
        return {
            id: prRow.id,
            repoOwner: prRow.repo_owner,
            repoName: prRow.repo_name,
            prNumber: prRow.pr_number,
            headSha: prRow.head_sha,
            baseSha: prRow.base_sha,
            updatedAt: prRow.updated_at,
            hunks: hunksRows.map((h) => ({
                id: h.id,
                prStateId: h.pr_state_id,
                filePath: h.file_path,
                hunkHash: h.hunk_hash,
                oldStart: h.old_start,
                oldLines: h.old_lines,
                newStart: h.new_start,
                newLines: h.new_lines,
                commitSha: h.commit_sha,
                createdAt: h.created_at,
            })),
            findings: findingsRows.map((f) => ({
                id: f.id,
                prStateId: f.pr_state_id,
                fingerprintHash: f.fingerprint_hash,
                filePath: f.file_path,
                startLine: f.start_line,
                endLine: f.end_line,
                persona: f.persona,
                severity: f.severity,
                comment: f.comment,
                status: f.status,
                firstSeenCommit: f.first_seen_commit,
                lastSeenCommit: f.last_seen_commit,
                resolvedAtCommit: f.resolved_at_commit,
                createdAt: f.created_at,
                updatedAt: f.updated_at,
            })),
        };
    }
    async savePRState(state) {
        const saveTransaction = this.db.transaction(() => {
            const now = new Date().toISOString();
            const upsertStmt = this.db.prepare(`
        INSERT INTO pr_states (repo_owner, repo_name, pr_number, head_sha, base_sha, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(repo_owner, repo_name, pr_number) DO UPDATE SET
          head_sha = excluded.head_sha,
          base_sha = excluded.base_sha,
          updated_at = excluded.updated_at
        RETURNING id
      `);
            const res = upsertStmt.get(state.repoOwner, state.repoName, state.prNumber, state.headSha, state.baseSha, now);
            const prStateId = res.id;
            // Clear existing hunks and findings for this state to rebuild clean state
            this.db.prepare('DELETE FROM diff_hunks WHERE pr_state_id = ?').run(prStateId);
            this.db.prepare('DELETE FROM tracked_findings WHERE pr_state_id = ?').run(prStateId);
            const insertHunk = this.db.prepare(`
        INSERT INTO diff_hunks (pr_state_id, file_path, hunk_hash, old_start, old_lines, new_start, new_lines, commit_sha, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
            for (const h of state.hunks) {
                insertHunk.run(prStateId, h.filePath, h.hunkHash, h.oldStart, h.oldLines, h.newStart, h.newLines, h.commitSha || state.headSha, h.createdAt || now);
            }
            const insertFinding = this.db.prepare(`
        INSERT INTO tracked_findings (
          pr_state_id, fingerprint_hash, file_path, start_line, end_line,
          persona, severity, comment, status, first_seen_commit, last_seen_commit,
          resolved_at_commit, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
            for (const f of state.findings) {
                insertFinding.run(prStateId, f.fingerprintHash, f.filePath, f.startLine, f.endLine, f.persona, f.severity, f.comment, f.status, f.firstSeenCommit || state.headSha, f.lastSeenCommit || state.headSha, f.resolvedAtCommit || null, f.createdAt || now, now);
            }
        });
        saveTransaction();
    }
    async getFindings(owner, repo, prNumber) {
        const prState = await this.getPRState(owner, repo, prNumber);
        return prState ? prState.findings : [];
    }
    async updateFindingStatus(owner, repo, prNumber, fingerprintHash, status, commitSha) {
        const prRow = this.db
            .prepare('SELECT id FROM pr_states WHERE repo_owner = ? AND repo_name = ? AND pr_number = ?')
            .get(owner, repo, prNumber);
        if (!prRow)
            return;
        const now = new Date().toISOString();
        const resolvedAt = status === 'RESOLVED' ? commitSha : null;
        this.db.prepare(`
      UPDATE tracked_findings
      SET status = ?, last_seen_commit = ?, resolved_at_commit = ?, updated_at = ?
      WHERE pr_state_id = ? AND fingerprint_hash = ?
    `).run(status, commitSha, resolvedAt, now, prRow.id, fingerprintHash);
    }
    async close() {
        if (this.db) {
            this.db.close();
        }
    }
}
exports.SqliteDiffStateStorage = SqliteDiffStateStorage;
class JsonFileDiffStateStorage {
    jsonPath;
    data = {};
    lastMtimeMs = 0;
    constructor(jsonPath = './data/pr_states.json') {
        this.jsonPath = jsonPath;
    }
    reloadIfDiskModified() {
        if (fs_1.default.existsSync(this.jsonPath)) {
            try {
                const stat = fs_1.default.statSync(this.jsonPath);
                if (stat.mtimeMs > this.lastMtimeMs) {
                    const raw = fs_1.default.readFileSync(this.jsonPath, 'utf8');
                    this.data = JSON.parse(raw);
                    this.lastMtimeMs = stat.mtimeMs;
                }
            }
            catch (err) {
                logger_1.logger.warn('Failed to reload JSON db file from disk', { err });
            }
        }
    }
    async init() {
        const dir = path_1.default.dirname(this.jsonPath);
        if (!fs_1.default.existsSync(dir)) {
            fs_1.default.mkdirSync(dir, { recursive: true });
        }
        if (fs_1.default.existsSync(this.jsonPath)) {
            try {
                const stat = fs_1.default.statSync(this.jsonPath);
                const raw = fs_1.default.readFileSync(this.jsonPath, 'utf8');
                this.data = JSON.parse(raw);
                this.lastMtimeMs = stat.mtimeMs;
            }
            catch (err) {
                logger_1.logger.warn('Failed to parse JSON db file, initializing empty state store', { err });
                this.data = {};
            }
        }
        else {
            this.data = {};
        }
    }
    getKey(owner, repo, prNumber) {
        return `${owner}/${repo}#${prNumber}`;
    }
    async flushToDisk() {
        const dir = path_1.default.dirname(this.jsonPath);
        if (!fs_1.default.existsSync(dir)) {
            fs_1.default.mkdirSync(dir, { recursive: true });
        }
        const tempPath = `${this.jsonPath}.tmp.${Date.now()}_${process.pid}`;
        const raw = JSON.stringify(this.data, null, 2);
        fs_1.default.writeFileSync(tempPath, raw, 'utf8');
        const fd = fs_1.default.openSync(tempPath, 'r+');
        fs_1.default.fsyncSync(fd);
        fs_1.default.closeSync(fd);
        fs_1.default.renameSync(tempPath, this.jsonPath);
        try {
            this.lastMtimeMs = fs_1.default.statSync(this.jsonPath).mtimeMs;
        }
        catch {
            // Ignore stat error
        }
    }
    async getPRState(owner, repo, prNumber) {
        this.reloadIfDiskModified();
        const key = this.getKey(owner, repo, prNumber);
        const state = this.data[key];
        return state ? JSON.parse(JSON.stringify(state)) : null;
    }
    async savePRState(state) {
        this.reloadIfDiskModified();
        const key = this.getKey(state.repoOwner, state.repoName, state.prNumber);
        state.updatedAt = new Date().toISOString();
        this.data[key] = JSON.parse(JSON.stringify(state));
        await this.flushToDisk();
    }
    async getFindings(owner, repo, prNumber) {
        const state = await this.getPRState(owner, repo, prNumber);
        return state ? state.findings : [];
    }
    async updateFindingStatus(owner, repo, prNumber, fingerprintHash, status, commitSha) {
        const state = await this.getPRState(owner, repo, prNumber);
        if (!state)
            return;
        const finding = state.findings.find(f => f.fingerprintHash === fingerprintHash);
        if (finding) {
            finding.status = status;
            finding.lastSeenCommit = commitSha;
            finding.resolvedAtCommit = status === 'RESOLVED' ? commitSha : null;
            finding.updatedAt = new Date().toISOString();
            await this.savePRState(state);
        }
    }
    async close() {
        await this.flushToDisk();
    }
}
exports.JsonFileDiffStateStorage = JsonFileDiffStateStorage;
async function createDiffStateStorage(dbPath = ':memory:', jsonPath = './data/pr_states.json') {
    try {
        const sqliteStorage = new SqliteDiffStateStorage(dbPath);
        await sqliteStorage.init();
        logger_1.logger.info('Initialized SQLite storage engine for PR diff states', { dbPath });
        return sqliteStorage;
    }
    catch (err) {
        logger_1.logger.warn('SQLite storage engine unavailable, failing over to JSON File Storage engine', { error: err.message });
        const jsonStorage = new JsonFileDiffStateStorage(jsonPath);
        await jsonStorage.init();
        return jsonStorage;
    }
}
//# sourceMappingURL=db.js.map