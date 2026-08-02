import { Pool, PoolClient } from 'pg';
import {
  DashboardData,
  PlatformSettings,
  RepoDashboardSetting,
  PersonaSetting,
  ProviderConfigRecord,
  ReviewLogEntry,
  ApiKeyRecord,
  IntegrationConfig,
  CustomMcpServerConfig,
} from './dashboardStore';
import { logger } from '../utils/logger';

export const ADVISORY_LOCK_ID = 1029384;

export class PostgresStore {
  private pool: Pool | null = null;
  private initialized = false;

  public isConfigured(): boolean {
    return Boolean(process.env.DATABASE_URL || process.env.POSTGRES_URL);
  }

  public getConnectionString(): string | undefined {
    return process.env.DATABASE_URL || process.env.POSTGRES_URL;
  }

  public getPool(): Pool {
    if (!this.pool) {
      const connectionString = this.getConnectionString();
      if (!connectionString) {
        throw new Error('DATABASE_URL or POSTGRES_URL environment variable is not configured');
      }
      this.pool = new Pool({
        connectionString,
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      });
    }
    return this.pool;
  }

  public async initialize(fallbackSeedData?: DashboardData): Promise<void> {
    if (!this.isConfigured()) {
      return;
    }

    const pool = this.getPool();
    let client: PoolClient | null = null;

    try {
      client = await pool.connect();
      await client.query('BEGIN');
      
      // Acquire multi-pod advisory lock for schema migration and initialization
      await client.query('SELECT pg_advisory_xact_lock($1)', [ADVISORY_LOCK_ID]);

      // 1. Initialize Tables
      await client.query(`
        CREATE TABLE IF NOT EXISTS dashboard_settings (
          key VARCHAR(255) PRIMARY KEY,
          data JSONB NOT NULL,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS repositories (
          id VARCHAR(255) PRIMARY KEY,
          owner VARCHAR(255) NOT NULL,
          repo VARCHAR(255) NOT NULL,
          full_name VARCHAR(255),
          data JSONB NOT NULL,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS personas (
          id VARCHAR(255) PRIMARY KEY,
          display_name VARCHAR(255),
          enabled BOOLEAN DEFAULT true,
          model VARCHAR(255),
          data JSONB NOT NULL,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS providers (
          id VARCHAR(255) PRIMARY KEY,
          display_name VARCHAR(255),
          enabled BOOLEAN DEFAULT true,
          data JSONB NOT NULL,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS review_logs (
          id VARCHAR(255) PRIMARY KEY,
          pr_run VARCHAR(255),
          repo VARCHAR(255),
          pr_number INT,
          head_sha VARCHAR(255),
          verdict VARCHAR(50),
          timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          data JSONB NOT NULL
        );

        CREATE TABLE IF NOT EXISTS review_runs (
          run_id VARCHAR(255) PRIMARY KEY,
          identity_digest VARCHAR(64) UNIQUE NOT NULL,
          owner VARCHAR(255) NOT NULL,
          repo VARCHAR(255) NOT NULL,
          pr_number INT NOT NULL,
          head_sha VARCHAR(255) NOT NULL,
          base_sha VARCHAR(255) NOT NULL,
          snapshot_digest VARCHAR(64) NOT NULL,
          config_digest VARCHAR(64) NOT NULL,
          identity JSONB NOT NULL,
          status VARCHAR(32) NOT NULL,
          stage VARCHAR(32) NOT NULL,
          attempt INT NOT NULL DEFAULT 0,
          lease_owner VARCHAR(255),
          lease_expires_at TIMESTAMP WITH TIME ZONE,
          result_digest VARCHAR(64),
          error_text TEXT,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS review_runs_claim_idx ON review_runs (status, lease_expires_at);

        CREATE TABLE IF NOT EXISTS memory_graph (
          id VARCHAR(255) PRIMARY KEY,
          repo VARCHAR(255),
          pr_number INT,
          entity_type VARCHAR(50),
          data JSONB NOT NULL,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS learned_rules (
          id TEXT PRIMARY KEY,
          repo TEXT,
          rule TEXT,
          category TEXT,
          score REAL,
          context TEXT,
          created_at TIMESTAMPTZ,
          updated_at TIMESTAMPTZ
        );

        CREATE TABLE IF NOT EXISTS suppressed_nits (
          id TEXT PRIMARY KEY,
          repo TEXT,
          pattern TEXT,
          reason TEXT,
          category TEXT,
          file_glob TEXT,
          status TEXT,
          hit_count INT DEFAULT 0,
          created_at TIMESTAMPTZ,
          updated_at TIMESTAMPTZ
        );

        CREATE TABLE IF NOT EXISTS adr_constraints (
          id TEXT PRIMARY KEY,
          repo TEXT,
          adr_id TEXT,
          title TEXT,
          rule TEXT,
          severity TEXT,
          created_at TIMESTAMPTZ,
          updated_at TIMESTAMPTZ
        );

        CREATE TABLE IF NOT EXISTS developer_feedback (
          id TEXT PRIMARY KEY,
          repo TEXT,
          pr_number INT,
          feedback_type TEXT,
          comment TEXT,
          action_taken TEXT,
          created_at TIMESTAMPTZ,
          updated_at TIMESTAMPTZ
        );

        CREATE TABLE IF NOT EXISTS platform_patterns (
          id TEXT PRIMARY KEY,
          repo TEXT,
          pattern_type TEXT,
          content JSONB,
          frequency INT DEFAULT 1,
          created_at TIMESTAMPTZ,
          updated_at TIMESTAMPTZ
        );
      `);

      // 2. Check if database tables are empty and seed if initial startup
      const checkRes = await client.query('SELECT COUNT(*)::int as count FROM dashboard_settings');
      const count = checkRes.rows[0]?.count || 0;

      if (count === 0 && fallbackSeedData) {
        logger.info('[PostgresStore] Database tables empty on initial startup. Seeding from dashboard.json...');
        
        // Seed Platform Settings
        if (fallbackSeedData.settings) {
          await client.query(
            `INSERT INTO dashboard_settings (key, data, updated_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT (key) DO UPDATE SET data = $2, updated_at = NOW()`,
            ['platform_settings', JSON.stringify(fallbackSeedData.settings)]
          );
        }

        // Seed Repositories
        if (fallbackSeedData.repositories && fallbackSeedData.repositories.length > 0) {
          for (const repoItem of fallbackSeedData.repositories) {
            const repoId = repoItem.id || `repo-${repoItem.owner}-${repoItem.repo}`;
            await client.query(
              `INSERT INTO repositories (id, owner, repo, full_name, data, updated_at)
               VALUES ($1, $2, $3, $4, $5, NOW())
               ON CONFLICT (id) DO UPDATE SET owner = $2, repo = $3, full_name = $4, data = $5, updated_at = NOW()`,
              [
                repoId,
                repoItem.owner,
                repoItem.repo,
                repoItem.full_name || `${repoItem.owner}/${repoItem.repo}`,
                JSON.stringify(repoItem),
              ]
            );
          }
        }

        // Seed Personas
        if (fallbackSeedData.settings?.personaSettings) {
          for (const [pId, pSetting] of Object.entries(fallbackSeedData.settings.personaSettings)) {
            await client.query(
              `INSERT INTO personas (id, display_name, enabled, model, data, updated_at)
               VALUES ($1, $2, $3, $4, $5, NOW())
               ON CONFLICT (id) DO UPDATE SET display_name = $2, enabled = $3, model = $4, data = $5, updated_at = NOW()`,
              [
                pId,
                pSetting.displayName || pId,
                pSetting.enabled ?? true,
                pSetting.model || '',
                JSON.stringify(pSetting),
              ]
            );
          }
        }

        // Seed Providers
        if (fallbackSeedData.settings?.providerConfigs) {
          for (const [prId, prConfig] of Object.entries(fallbackSeedData.settings.providerConfigs)) {
            await client.query(
              `INSERT INTO providers (id, display_name, enabled, data, updated_at)
               VALUES ($1, $2, $3, $4, NOW())
               ON CONFLICT (id) DO UPDATE SET display_name = $2, enabled = $3, data = $4, updated_at = NOW()`,
              [
                prId,
                prConfig.displayName || prId,
                prConfig.enabled ?? true,
                JSON.stringify(prConfig),
              ]
            );
          }
        }

        // Seed Review Logs
        if (fallbackSeedData.reviewLogs && fallbackSeedData.reviewLogs.length > 0) {
          for (const log of fallbackSeedData.reviewLogs) {
            await client.query(
              `INSERT INTO review_logs (id, pr_run, repo, pr_number, head_sha, verdict, timestamp, data)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
               ON CONFLICT (id) DO UPDATE SET pr_run = $2, repo = $3, pr_number = $4, head_sha = $5, verdict = $6, timestamp = $7, data = $8`,
              [
                log.id,
                log.prRun || '',
                log.repo || '',
                log.prNumber || null,
                log.headSha || '',
                log.arbiterVerdict || log.verdict || 'SHIP',
                log.timestamp || new Date().toISOString(),
                JSON.stringify(log),
              ]
            );
          }
        }
      }

      await client.query('COMMIT');
      this.initialized = true;
      logger.info('[PostgresStore] PostgreSQL storage adapter initialized successfully with advisory lock.');
    } catch (err) {
      if (client) {
        await client.query('ROLLBACK').catch(() => {});
      }
      logger.error('[PostgresStore] Failed to initialize PostgreSQL database schema', { error: String(err) });
      throw err;
    } finally {
      if (client) {
        client.release();
      }
    }
  }

  public async loadAllData(): Promise<Partial<DashboardData> | null> {
    if (!this.isConfigured()) return null;
    const pool = this.getPool();

    try {
      // 1. Settings
      const settingsRes = await pool.query('SELECT data FROM dashboard_settings WHERE key = $1', ['platform_settings']);
      let settings: PlatformSettings | undefined = settingsRes.rows[0]?.data;
      if (typeof settings === 'string') {
        try { settings = JSON.parse(settings); } catch (_) {}
      }

      // 2. Repositories
      const reposRes = await pool.query('SELECT data FROM repositories ORDER BY updated_at DESC');
      const repositories: RepoDashboardSetting[] = reposRes.rows.map((r) =>
        typeof r.data === 'string' ? JSON.parse(r.data) : r.data
      );

      // 3. Personas
      const personasRes = await pool.query('SELECT id, data FROM personas');
      const personaMap: Record<string, PersonaSetting> = {};
      personasRes.rows.forEach((r) => {
        const data = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
        const pId = r.id || data?.id;
        if (pId && data) {
          personaMap[pId] = data;
        }
      });

      // 4. Providers
      const providersRes = await pool.query('SELECT id, data FROM providers');
      const providerMap: Record<string, ProviderConfigRecord> = {};
      providersRes.rows.forEach((r) => {
        const data = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
        const prId = r.id || data?.id;
        if (prId && data) {
          providerMap[prId] = data;
        }
      });

      // 5. Review Logs
      const logsRes = await pool.query('SELECT data FROM review_logs ORDER BY timestamp DESC LIMIT 100');
      const reviewLogs: ReviewLogEntry[] = logsRes.rows.map((r) =>
        typeof r.data === 'string' ? JSON.parse(r.data) : r.data
      );

      if (settings) {
        if (Object.keys(personaMap).length > 0) {
          settings.personaSettings = {
            ...(settings.personaSettings || {}),
            ...personaMap,
          };
        }
        if (Object.keys(providerMap).length > 0) {
          settings.providerConfigs = {
            ...(settings.providerConfigs || {}),
            ...providerMap,
          };
        }
      } else if (Object.keys(personaMap).length > 0 || Object.keys(providerMap).length > 0) {
        settings = {
          personaSettings: personaMap,
          providerConfigs: providerMap,
        } as PlatformSettings;
      }

      return {
        repositories: repositories.length > 0 ? repositories : undefined,
        settings: settings || undefined,
        reviewLogs: reviewLogs.length > 0 ? reviewLogs : undefined,
      };
    } catch (err) {
      logger.error('[PostgresStore] Error loading data from PostgreSQL', { error: String(err) });
      return null;
    }
  }

  public async saveSettings(settings: PlatformSettings): Promise<void> {
    if (!this.isConfigured()) return;
    const pool = this.getPool();
    await pool.query(
      `INSERT INTO dashboard_settings (key, data, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET data = $2, updated_at = NOW()`,
      ['platform_settings', JSON.stringify(settings)]
    );
  }

  public async saveRepository(repo: RepoDashboardSetting): Promise<void> {
    if (!this.isConfigured()) return;
    const pool = this.getPool();
    const repoId = repo.id || `repo-${repo.owner}-${repo.repo}`;
    await pool.query(
      `INSERT INTO repositories (id, owner, repo, full_name, data, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (id) DO UPDATE SET owner = $2, repo = $3, full_name = $4, data = $5, updated_at = NOW()`,
      [
        repoId,
        repo.owner,
        repo.repo,
        repo.full_name || `${repo.owner}/${repo.repo}`,
        JSON.stringify(repo),
      ]
    );
  }

  public async deleteRepository(id: string): Promise<void> {
    if (!this.isConfigured()) return;
    const pool = this.getPool();
    await pool.query('DELETE FROM repositories WHERE id = $1', [id]);
  }

  public async savePersona(persona: PersonaSetting): Promise<void> {
    if (!this.isConfigured()) return;
    const pool = this.getPool();
    await pool.query(
      `INSERT INTO personas (id, display_name, enabled, model, data, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (id) DO UPDATE SET display_name = $2, enabled = $3, model = $4, data = $5, updated_at = NOW()`,
      [
        persona.id,
        persona.displayName || persona.id,
        persona.enabled ?? true,
        persona.model || '',
        JSON.stringify(persona),
      ]
    );
  }

  public async saveProvider(provider: ProviderConfigRecord): Promise<void> {
    if (!this.isConfigured()) return;
    const pool = this.getPool();
    await pool.query(
      `INSERT INTO providers (id, display_name, enabled, data, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (id) DO UPDATE SET display_name = $2, enabled = $3, data = $4, updated_at = NOW()`,
      [
        provider.id,
        provider.displayName || provider.id,
        provider.enabled ?? true,
        JSON.stringify(provider),
      ]
    );
  }

  public async saveReviewLog(log: ReviewLogEntry): Promise<void> {
    if (!this.isConfigured()) return;
    const pool = this.getPool();
    await pool.query(
      `INSERT INTO review_logs (id, pr_run, repo, pr_number, head_sha, verdict, timestamp, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET pr_run = $2, repo = $3, pr_number = $4, head_sha = $5, verdict = $6, timestamp = $7, data = $8`,
      [
        log.id,
        log.prRun || '',
        log.repo || '',
        log.prNumber || null,
        log.headSha || '',
        log.arbiterVerdict || log.verdict || 'SHIP',
        log.timestamp || new Date().toISOString(),
        JSON.stringify(log),
      ]
    );
  }

  public async getReviewLogs(limit = 100): Promise<ReviewLogEntry[]> {
    if (!this.isConfigured()) return [];
    const pool = this.getPool();
    const res = await pool.query('SELECT data FROM review_logs ORDER BY timestamp DESC LIMIT $1', [limit]);
    return res.rows.map((r) => r.data);
  }

  public async saveMemoryEntity(id: string, repo: string, prNumber: number, entityType: string, data: any): Promise<void> {
    if (!this.isConfigured()) return;
    const pool = this.getPool();
    await pool.query(
      `INSERT INTO memory_graph (id, repo, pr_number, entity_type, data, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (id) DO UPDATE SET repo = $2, pr_number = $3, entity_type = $4, data = $5, updated_at = NOW()`,
      [id, repo, prNumber, entityType, JSON.stringify(data)]
    );
  }

  // --- Learned Rules ---
  public async saveLearnedRule(learning: {
    id: string;
    repo: string;
    prNumber?: number;
    category?: string;
    title?: string;
    description?: string;
    filePath?: string;
    confidence?: number;
    createdAt?: string;
    updatedAt?: string;
  }): Promise<void> {
    if (!this.isConfigured()) return;
    const pool = this.getPool();
    const now = new Date().toISOString();
    const context = JSON.stringify({
      prNumber: learning.prNumber || 0,
      description: learning.description || learning.title || '',
      filePath: learning.filePath || null,
    });
    await pool.query(
      `INSERT INTO learned_rules (id, repo, rule, category, score, context, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET
         repo = $2, rule = $3, category = $4, score = $5, context = $6, updated_at = $8`,
      [
        learning.id,
        learning.repo,
        learning.title || learning.description || 'Learned Rule',
        learning.category || 'convention',
        learning.confidence ?? 1.0,
        context,
        learning.createdAt || now,
        learning.updatedAt || now,
      ]
    );
  }

  // --- Suppressed Nits ---
  public async saveSuppressedNit(nit: {
    id: string;
    repo: string;
    prNumber?: number;
    pattern: string;
    filePath: string;
    reason: string;
    headSha?: string;
    resolvedAt?: string;
    suppressionCount?: number;
    category?: string;
  }): Promise<void> {
    if (!this.isConfigured()) return;
    const pool = this.getPool();
    const now = nit.resolvedAt || new Date().toISOString();
    const status = JSON.stringify({
      prNumber: nit.prNumber || 0,
      headSha: nit.headSha || null,
    });
    await pool.query(
      `INSERT INTO suppressed_nits (id, repo, pattern, reason, category, file_glob, status, hit_count, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id) DO UPDATE SET
         repo = $2, pattern = $3, reason = $4, category = $5, file_glob = $6, status = $7, hit_count = $8, updated_at = $10`,
      [
        nit.id,
        nit.repo,
        nit.pattern,
        nit.reason,
        nit.category || 'nit',
        nit.filePath,
        status,
        nit.suppressionCount || 0,
        now,
        now,
      ]
    );
  }

  public async incrementNitSuppression(id: string): Promise<void> {
    if (!this.isConfigured()) return;
    const pool = this.getPool();
    await pool.query(
      `UPDATE suppressed_nits SET hit_count = hit_count + 1, updated_at = NOW() WHERE id = $1`,
      [id]
    );
  }

  public async incrementNitSuppressionBatch(ids: string[]): Promise<void> {
    if (!this.isConfigured() || ids.length === 0) return;
    const pool = this.getPool();
    await pool.query(
      `UPDATE suppressed_nits SET hit_count = hit_count + 1, updated_at = NOW() WHERE id = ANY($1::text[])`,
      [ids]
    );
  }

  // --- ADR Constraints ---
  public async saveADRConstraint(adr: {
    id: string;
    repo: string;
    adrNumber?: number;
    title: string;
    status: string;
    rule: string;
    targetPaths?: string[];
    createdAt?: string;
  }): Promise<void> {
    if (!this.isConfigured()) return;
    const pool = this.getPool();
    const now = adr.createdAt || new Date().toISOString();
    const severity = JSON.stringify({
      status: adr.status,
      targetPaths: adr.targetPaths || [],
    });
    await pool.query(
      `INSERT INTO adr_constraints (id, repo, adr_id, title, rule, severity, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (id) DO UPDATE SET
         repo = $2, adr_id = $3, title = $4, rule = $5, severity = $6, updated_at = NOW()`,
      [
        adr.id,
        adr.repo,
        String(adr.adrNumber ?? 0),
        adr.title,
        adr.rule,
        severity,
        now,
      ]
    );
  }

  // --- Developer Feedback ---
  public async saveDeveloperFeedback(feedback: {
    id: string;
    repo: string;
    prNumber?: number;
    feedbackType: string;
    comment?: string;
    actionTaken?: string;
    createdAt?: string;
  }): Promise<void> {
    if (!this.isConfigured()) return;
    const pool = this.getPool();
    const now = feedback.createdAt || new Date().toISOString();
    await pool.query(
      `INSERT INTO developer_feedback (id, repo, pr_number, feedback_type, comment, action_taken, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (id) DO UPDATE SET
         repo = $2, pr_number = $3, feedback_type = $4, comment = $5, action_taken = $6, updated_at = NOW()`,
      [
        feedback.id,
        feedback.repo,
        feedback.prNumber || null,
        feedback.feedbackType,
        feedback.comment || null,
        feedback.actionTaken || null,
        now,
      ]
    );
  }

  // --- Platform Patterns ---
  public async savePlatformPattern(pattern: {
    id?: string | number;
    repo?: string;
    category: string;
    pattern: string;
    sanitizedDescription: string;
    sourceRepoCount?: number;
    occurrenceCount?: number;
    confidenceScore?: number;
    createdAt?: string;
    updatedAt?: string;
  }): Promise<void> {
    if (!this.isConfigured()) return;
    const pool = this.getPool();
    const patternId = String(pattern.id || `pat_${pattern.pattern}`);
    const now = new Date().toISOString();
    const content = JSON.stringify(pattern);
    await pool.query(
      `INSERT INTO platform_patterns (id, repo, pattern_type, content, frequency, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         repo = $2, pattern_type = $3, content = $4, frequency = $5, updated_at = $7`,
      [
        patternId,
        pattern.repo || 'global',
        pattern.category,
        content,
        pattern.occurrenceCount || 1,
        pattern.createdAt || now,
        pattern.updatedAt || now,
      ]
    );
  }

  // --- Query Methods for Dual-Store Fallback ---

  public async queryLearnings(
    repo: string,
    options: { category?: string; filePath?: string; query?: string } = {}
  ): Promise<{ learnings: any[]; resolvedNits: any[]; adrConstraints: any[] }> {
    if (!this.isConfigured()) {
      throw new Error('PostgreSQL not configured');
    }
    const pool = this.getPool();

    // 1. Query learned_rules
    let lSql = 'SELECT * FROM learned_rules WHERE repo = $1';
    const lParams: any[] = [repo];
    if (options.category) {
      lSql += ' AND category = $' + (lParams.length + 1);
      lParams.push(options.category);
    }
    if (options.query) {
      const q = `%${options.query.toLowerCase()}%`;
      lSql += ` AND (LOWER(rule) LIKE $${lParams.length + 1} OR LOWER(context) LIKE $${lParams.length + 2})`;
      lParams.push(q, q);
    }

    const lRes = await pool.query(lSql, lParams);
    let learnings = lRes.rows.map((r) => {
      let prNumber = 0;
      let description = r.rule || '';
      let filePath: string | undefined = undefined;

      if (r.context) {
        try {
          const ctx = JSON.parse(r.context);
          if (ctx && typeof ctx === 'object') {
            prNumber = ctx.prNumber || 0;
            description = ctx.description || r.rule;
            filePath = ctx.filePath || undefined;
          } else {
            description = r.context;
          }
        } catch (_) {
          description = r.context;
        }
      }

      return {
        id: r.id,
        repo: r.repo,
        prNumber,
        category: r.category,
        title: r.rule,
        description,
        filePath,
        confidence: r.score != null ? Number(r.score) : 1.0,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : new Date().toISOString(),
      };
    });

    if (options.filePath) {
      learnings = learnings.filter(
        (l) => !l.filePath || l.filePath === '' || l.filePath === options.filePath || l.filePath === '**'
      );
    }

    // 2. Query suppressed_nits
    let nSql = 'SELECT * FROM suppressed_nits WHERE repo = $1';
    const nRes = await pool.query(nSql, [repo]);
    let resolvedNits = nRes.rows.map((r) => {
      let prNumber = 0;
      let headSha: string | undefined = undefined;

      if (r.status) {
        try {
          const st = JSON.parse(r.status);
          if (st && typeof st === 'object') {
            prNumber = st.prNumber || 0;
            headSha = st.headSha || undefined;
          }
        } catch (_) {}
      }

      return {
        id: r.id,
        repo: r.repo,
        prNumber,
        pattern: r.pattern,
        filePath: r.file_glob,
        reason: r.reason,
        headSha,
        resolvedAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
        suppressionCount: r.hit_count != null ? Number(r.hit_count) : 0,
      };
    });

    if (options.filePath) {
      resolvedNits = resolvedNits.filter(
        (n) => !n.filePath || n.filePath === '' || n.filePath === options.filePath || n.filePath === '**'
      );
    }

    // 3. Query adr_constraints
    const aSql = 'SELECT * FROM adr_constraints WHERE repo = $1';
    const aRes = await pool.query(aSql, [repo]);
    const adrConstraints = aRes.rows
      .map((r) => {
        let status = 'accepted';
        let targetPaths: string[] = [];

        if (r.severity) {
          try {
            const sev = JSON.parse(r.severity);
            if (sev && typeof sev === 'object') {
              status = sev.status || 'accepted';
              targetPaths = Array.isArray(sev.targetPaths) ? sev.targetPaths : [];
            } else {
              status = r.severity;
            }
          } catch (_) {
            status = r.severity;
          }
        }

        return {
          id: r.id,
          repo: r.repo,
          adrNumber: Number(r.adr_id) || 0,
          title: r.title,
          status,
          rule: r.rule,
          targetPaths,
          createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
        };
      })
      .filter((a) => a.status === 'accepted');

    return { learnings, resolvedNits, adrConstraints };
  }

  public async getFeedbackCounts(repo?: string): Promise<{ positiveFeedbackCount: number; negativeFeedbackCount: number }> {
    if (!this.isConfigured()) {
      throw new Error('PostgreSQL not configured');
    }
    const pool = this.getPool();
    let sql = 'SELECT feedback_type, COUNT(*)::int as cnt FROM developer_feedback';
    const params: any[] = [];
    if (repo) {
      sql += ' WHERE repo = $1';
      params.push(repo);
    }
    sql += ' GROUP BY feedback_type';

    const res = await pool.query(sql, params);
    let positiveFeedbackCount = 0;
    let negativeFeedbackCount = 0;

    for (const row of res.rows) {
      if (row.feedback_type === 'positive') {
        positiveFeedbackCount = row.cnt;
      } else if (row.feedback_type === 'negative') {
        negativeFeedbackCount = row.cnt;
      }
    }

    return { positiveFeedbackCount, negativeFeedbackCount };
  }

  public async getMemoryCounts(): Promise<{ learningsCount: number; suppressedNitsCount: number; adrConstraintsCount: number }> {
    if (!this.isConfigured()) {
      throw new Error('PostgreSQL not configured');
    }
    const pool = this.getPool();
    const lRes = await pool.query('SELECT COUNT(*)::int as cnt FROM learned_rules');
    const nRes = await pool.query('SELECT COUNT(*)::int as cnt FROM suppressed_nits');
    const aRes = await pool.query('SELECT COUNT(*)::int as cnt FROM adr_constraints');

    return {
      learningsCount: lRes.rows[0]?.cnt || 0,
      suppressedNitsCount: nRes.rows[0]?.cnt || 0,
      adrConstraintsCount: aRes.rows[0]?.cnt || 0,
    };
  }

  public async queryPlatformPatterns(category?: string, minConfidence: number = 75): Promise<any[]> {
    if (!this.isConfigured()) {
      throw new Error('PostgreSQL not configured');
    }
    const pool = this.getPool();
    let sql = 'SELECT content FROM platform_patterns';
    const params: any[] = [];
    if (category) {
      sql += ' WHERE pattern_type = $1';
      params.push(category);
    }

    const res = await pool.query(sql, params);
    const patterns: any[] = [];

    for (const row of res.rows) {
      let data = row.content;
      if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch (_) {}
      }
      if (data && (data.confidenceScore == null || data.confidenceScore >= minConfidence)) {
        patterns.push(data);
      }
    }

    patterns.sort((a, b) => {
      const confDiff = (b.confidenceScore ?? 80) - (a.confidenceScore ?? 80);
      if (confDiff !== 0) return confDiff;
      return (b.occurrenceCount ?? 1) - (a.occurrenceCount ?? 1);
    });

    return patterns;
  }

  public async clearRepoMemory(repo: string): Promise<void> {
    if (!this.isConfigured()) return;
    const pool = this.getPool();
    await pool.query('DELETE FROM learned_rules WHERE repo = $1', [repo]);
    await pool.query('DELETE FROM suppressed_nits WHERE repo = $1', [repo]);
    await pool.query('DELETE FROM adr_constraints WHERE repo = $1', [repo]);
    await pool.query('DELETE FROM developer_feedback WHERE repo = $1', [repo]);
  }

  public async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this.initialized = false;
    }
  }
}

export const postgresStore = new PostgresStore();
