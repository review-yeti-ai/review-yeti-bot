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

        CREATE TABLE IF NOT EXISTS memory_graph (
          id VARCHAR(255) PRIMARY KEY,
          repo VARCHAR(255),
          pr_number INT,
          entity_type VARCHAR(50),
          data JSONB NOT NULL,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
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

  public async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this.initialized = false;
    }
  }
}

export const postgresStore = new PostgresStore();
