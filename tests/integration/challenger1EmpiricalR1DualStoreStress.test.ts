import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import fs from 'fs';
import { PostgresStore, ADVISORY_LOCK_ID, postgresStore } from '../../src/persistence/postgresStore';
import { DashboardStore, DashboardData } from '../../src/persistence/dashboardStore';

describe('Empirical Stress Test: R1 Managed PostgreSQL Adapter & Dual-Store Architecture', () => {
  const tempTestDir = path.join(process.cwd(), 'data', 'test-challenger-r1-dualstore');
  const tempStorePath = path.join(tempTestDir, 'test-dashboard.json');

  beforeEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.POSTGRES_URL;

    if (!fs.existsSync(tempTestDir)) {
      fs.mkdirSync(tempTestDir, { recursive: true });
    }
  });

  afterEach(async () => {
    delete process.env.DATABASE_URL;
    delete process.env.POSTGRES_URL;
    vi.restoreAllMocks();
    await postgresStore.close();

    if (fs.existsSync(tempTestDir)) {
      try {
        fs.rmSync(tempTestDir, { recursive: true, force: true });
      } catch {}
    }
  });

  describe('1. Mode Switches & Connection String Resolution', () => {
    it('returns false for isConfigured() when neither DATABASE_URL nor POSTGRES_URL is set', () => {
      delete process.env.DATABASE_URL;
      delete process.env.POSTGRES_URL;
      const store = new PostgresStore();
      expect(store.isConfigured()).toBe(false);
      expect(store.getConnectionString()).toBeUndefined();
    });

    it('returns true when DATABASE_URL is set', () => {
      process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/testdb';
      delete process.env.POSTGRES_URL;
      const store = new PostgresStore();
      expect(store.isConfigured()).toBe(true);
      expect(store.getConnectionString()).toBe('postgresql://user:pass@localhost:5432/testdb');
    });

    it('returns true when POSTGRES_URL is set', () => {
      delete process.env.DATABASE_URL;
      process.env.POSTGRES_URL = 'postgresql://user:pass@localhost:5432/postgres_url_db';
      const store = new PostgresStore();
      expect(store.isConfigured()).toBe(true);
      expect(store.getConnectionString()).toBe('postgresql://user:pass@localhost:5432/postgres_url_db');
    });

    it('prefers DATABASE_URL over POSTGRES_URL when both are present', () => {
      process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db_url';
      process.env.POSTGRES_URL = 'postgresql://user:pass@localhost:5432/pg_url';
      const store = new PostgresStore();
      expect(store.isConfigured()).toBe(true);
      expect(store.getConnectionString()).toBe('postgresql://user:pass@localhost:5432/db_url');
    });

    it('throws explicit error when getPool() is called without DATABASE_URL/POSTGRES_URL', () => {
      delete process.env.DATABASE_URL;
      delete process.env.POSTGRES_URL;
      const store = new PostgresStore();
      expect(() => store.getPool()).toThrow('DATABASE_URL or POSTGRES_URL environment variable is not configured');
    });

    it('all CRUD methods return gracefully when unconfigured without throwing or querying', async () => {
      delete process.env.DATABASE_URL;
      delete process.env.POSTGRES_URL;
      const store = new PostgresStore();

      await expect(store.initialize()).resolves.toBeUndefined();
      await expect(store.loadAllData()).resolves.toBeNull();
      await expect(store.saveSettings({} as any)).resolves.toBeUndefined();
      await expect(store.saveRepository({} as any)).resolves.toBeUndefined();
      await expect(store.deleteRepository('test-id')).resolves.toBeUndefined();
      await expect(store.savePersona({} as any)).resolves.toBeUndefined();
      await expect(store.saveProvider({} as any)).resolves.toBeUndefined();
      await expect(store.saveReviewLog({} as any)).resolves.toBeUndefined();
      await expect(store.getReviewLogs()).resolves.toEqual([]);
      await expect(store.saveMemoryEntity('1', 'repo', 1, 'type', {})).resolves.toBeUndefined();
    });
  });

  describe('2. PVC File Store Fallback Behavior', () => {
    it('operates seamlessly with JSON file store when DATABASE_URL is absent', () => {
      delete process.env.DATABASE_URL;
      delete process.env.POSTGRES_URL;

      const store = new DashboardStore(tempStorePath);
      expect(store.getFilePath()).toBe(tempStorePath);

      // Create a repository update
      const updated = store.updateRepository('test-owner', 'test-repo', {
        automationEnabled: true,
        strictnessProfile: 'assertive',
      });

      expect(updated.owner).toBe('test-owner');
      expect(updated.repo).toBe('test-repo');
      expect(fs.existsSync(tempStorePath)).toBe(true);

      const fileContent = JSON.parse(fs.readFileSync(tempStorePath, 'utf8'));
      expect(fileContent.repositories).toBeDefined();
      const found = fileContent.repositories.find((r: any) => r.owner === 'test-owner' && r.repo === 'test-repo');
      expect(found).toBeDefined();
      expect(found.strictnessProfile).toBe('assertive');
    });

    it('retains default initial dataset on PVC file creation', () => {
      delete process.env.DATABASE_URL;
      delete process.env.POSTGRES_URL;

      const store = new DashboardStore(tempStorePath);
      const repos = store.getRepositories();
      expect(repos.length).toBeGreaterThanOrEqual(3);
      expect(repos.some((r) => r.repo === 'cisco-cdr')).toBe(true);
      expect(repos.some((r) => r.repo === 'ct-meta')).toBe(true);
      expect(repos.some((r) => r.repo === 'ct-review-bot')).toBe(true);
    });
  });

  describe('3. Advisory Lock & Concurrent Startup Initialization Stress', () => {
    it('uses exact advisory lock ID constant 1029384', () => {
      expect(ADVISORY_LOCK_ID).toBe(1029384);
    });

    it('executes pg_advisory_xact_lock inside transaction block during initialize()', async () => {
      process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/mockdb';
      const store = new PostgresStore();

      const executedQueries: Array<{ query: string; params?: any[] }> = [];

      const mockClient = {
        query: vi.fn(async (text: string, params?: any[]) => {
          executedQueries.push({ query: text, params });
          if (text.includes('COUNT(*)')) {
            return { rows: [{ count: 1 }] };
          }
          return { rows: [] };
        }),
        release: vi.fn(),
      };

      const mockPool = {
        connect: vi.fn(async () => mockClient),
      };

      vi.spyOn(store, 'getPool').mockReturnValue(mockPool as any);

      await store.initialize();

      expect(mockClient.query).toHaveBeenCalled();
      const queryTexts = executedQueries.map((q) => q.query);

      // Verify BEGIN comes first
      expect(queryTexts[0]).toBe('BEGIN');

      // Verify advisory lock is requested with ADVISORY_LOCK_ID
      const lockQuery = executedQueries.find((q) => q.query.includes('pg_advisory_xact_lock'));
      expect(lockQuery).toBeDefined();
      expect(lockQuery?.params).toEqual([1029384]);

      // Verify table creation queries execute
      expect(queryTexts.some((q) => q.includes('CREATE TABLE IF NOT EXISTS dashboard_settings'))).toBe(true);
      expect(queryTexts.some((q) => q.includes('CREATE TABLE IF NOT EXISTS repositories'))).toBe(true);
      expect(queryTexts.some((q) => q.includes('CREATE TABLE IF NOT EXISTS personas'))).toBe(true);
      expect(queryTexts.some((q) => q.includes('CREATE TABLE IF NOT EXISTS providers'))).toBe(true);
      expect(queryTexts.some((q) => q.includes('CREATE TABLE IF NOT EXISTS review_logs'))).toBe(true);
      expect(queryTexts.some((q) => q.includes('CREATE TABLE IF NOT EXISTS memory_graph'))).toBe(true);

      // Verify COMMIT is sent at end
      expect(queryTexts[queryTexts.length - 1]).toBe('COMMIT');
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('simulates 10 concurrent pod startups executing initialize() simultaneously', async () => {
      process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/mockdb';
      const store = new PostgresStore();

      let lockAcquiredCount = 0;

      const createMockClient = () => {
        const executed: string[] = [];
        return {
          query: vi.fn(async (text: string, params?: any[]) => {
            executed.push(text);
            if (text.includes('pg_advisory_xact_lock')) {
              lockAcquiredCount++;
            }
            if (text.includes('COUNT(*)')) {
              return { rows: [{ count: 0 }] }; // trigger seed path
            }
            return { rows: [] };
          }),
          release: vi.fn(),
          executed,
        };
      };

      const clients: ReturnType<typeof createMockClient>[] = [];

      const mockPool = {
        connect: vi.fn(async () => {
          const client = createMockClient();
          clients.push(client);
          return client;
        }),
      };

      vi.spyOn(store, 'getPool').mockReturnValue(mockPool as any);

      const seedData: DashboardData = {
        repositories: [{ owner: 'test', repo: 'concurrent-repo', automationEnabled: true, updatedAt: new Date().toISOString() }],
        settings: {
          defaultModelOverrides: {},
          memoryEngineSettings: { autoSuppressNits: true, learningConfidenceThreshold: 80, maxLearningsPerRepo: 100 },
          providerCostCaps: { monthlyBudgetUSD: 100, dailyBudgetUSD: 10, alertThresholdPercent: 80, actionOnCapBreach: 'fail_closed' },
        },
        apiKeys: [],
        reviewCounter: 0,
        totalCostUSD: 0,
      };

      // Concurrent startup initialization
      const initPromises = Array.from({ length: 10 }, () => store.initialize(seedData));

      await Promise.all(initPromises);

      expect(clients.length).toBe(10);
      expect(lockAcquiredCount).toBe(10);
      clients.forEach((client) => {
        expect(client.executed[0]).toBe('BEGIN');
        expect(client.executed.some((q) => q.includes('pg_advisory_xact_lock'))).toBe(true);
        expect(client.executed[client.executed.length - 1]).toBe('COMMIT');
        expect(client.release).toHaveBeenCalled();
      });
    });

    it('executes ROLLBACK and releases client when an error occurs during initialize()', async () => {
      process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/mockdb';
      const store = new PostgresStore();

      const executed: string[] = [];
      const mockClient = {
        query: vi.fn(async (text: string) => {
          executed.push(text);
          if (text.includes('CREATE TABLE')) {
            throw new Error('Database disk full or migration deadlock error');
          }
          return { rows: [] };
        }),
        release: vi.fn(),
      };

      const mockPool = {
        connect: vi.fn(async () => mockClient),
      };

      vi.spyOn(store, 'getPool').mockReturnValue(mockPool as any);

      await expect(store.initialize()).rejects.toThrow('Database disk full or migration deadlock error');

      expect(executed).toContain('BEGIN');
      expect(executed).toContain('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  describe('4. Automatic Disk Seeding Behavior', () => {
    it('seeds all tables from fallbackSeedData when database is empty (count === 0)', async () => {
      process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/mockdb';
      const store = new PostgresStore();

      const insertedQueries: Array<{ text: string; params: any[] }> = [];

      const mockClient = {
        query: vi.fn(async (text: string, params?: any[]) => {
          if (text.startsWith('INSERT INTO')) {
            insertedQueries.push({ text, params: params || [] });
          }
          if (text.includes('COUNT(*)')) {
            return { rows: [{ count: 0 }] };
          }
          return { rows: [] };
        }),
        release: vi.fn(),
      };

      vi.spyOn(store, 'getPool').mockReturnValue({ connect: async () => mockClient } as any);

      const seedData: DashboardData = {
        repositories: [
          { id: 'repo-1', owner: 'seed-org', repo: 'seed-repo-1', full_name: 'seed-org/seed-repo-1', automationEnabled: true, updatedAt: '2026-01-01T00:00:00Z' },
        ],
        settings: {
          defaultModelOverrides: { security: 'gpt-4o' },
          personaSettings: {
            security: { id: 'security', displayName: 'Security', description: 'sec', enabled: true, model: 'gpt-4o', effort: 'high', confidenceThreshold: 80 },
          },
          providerConfigs: {
            openai: { id: 'openai', displayName: 'OpenAI', enabled: true, activeModels: ['gpt-4o'], updatedAt: '2026-01-01T00:00:00Z' },
          },
          memoryEngineSettings: { autoSuppressNits: true, learningConfidenceThreshold: 80, maxLearningsPerRepo: 100 },
          providerCostCaps: { monthlyBudgetUSD: 100, dailyBudgetUSD: 10, alertThresholdPercent: 80, actionOnCapBreach: 'fail_closed' },
        },
        reviewLogs: [
          {
            id: 'log-1',
            prRun: 'seed-org/seed-repo-1 #1',
            repo: 'seed-org/seed-repo-1',
            prNumber: 1,
            headSha: 'abc1234',
            personas: ['security'],
            quorum: '1/1',
            arbiterVerdict: 'SHIP',
            timestamp: '2026-01-01T00:00:00Z',
          },
        ],
        apiKeys: [],
        reviewCounter: 1,
        totalCostUSD: 0,
      };

      await store.initialize(seedData);

      // Verify seeding inserts happened for settings, repos, personas, providers, review_logs
      expect(insertedQueries.some((q) => q.text.includes('INSERT INTO dashboard_settings'))).toBe(true);
      expect(insertedQueries.some((q) => q.text.includes('INSERT INTO repositories'))).toBe(true);
      expect(insertedQueries.some((q) => q.text.includes('INSERT INTO personas'))).toBe(true);
      expect(insertedQueries.some((q) => q.text.includes('INSERT INTO providers'))).toBe(true);
      expect(insertedQueries.some((q) => q.text.includes('INSERT INTO review_logs'))).toBe(true);

      const repoInsert = insertedQueries.find((q) => q.text.includes('INSERT INTO repositories'));
      expect(repoInsert?.params[0]).toBe('repo-1');
      expect(repoInsert?.params[1]).toBe('seed-org');
      expect(repoInsert?.params[2]).toBe('seed-repo-1');

      const logInsert = insertedQueries.find((q) => q.text.includes('INSERT INTO review_logs'));
      expect(logInsert?.params[0]).toBe('log-1');
      expect(logInsert?.params[5]).toBe('SHIP');
    });

    it('skips seeding when database tables already contain entries (count > 0)', async () => {
      process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/mockdb';
      const store = new PostgresStore();

      const insertedQueries: string[] = [];

      const mockClient = {
        query: vi.fn(async (text: string) => {
          if (text.startsWith('INSERT INTO')) {
            insertedQueries.push(text);
          }
          if (text.includes('COUNT(*)')) {
            return { rows: [{ count: 5 }] }; // Existing data present
          }
          return { rows: [] };
        }),
        release: vi.fn(),
      };

      vi.spyOn(store, 'getPool').mockReturnValue({ connect: async () => mockClient } as any);

      const seedData: DashboardData = {
        repositories: [{ owner: 'seed-org', repo: 'seed-repo-1', automationEnabled: true, updatedAt: '2026-01-01T00:00:00Z' }],
        settings: {
          defaultModelOverrides: {},
          memoryEngineSettings: { autoSuppressNits: true, learningConfidenceThreshold: 80, maxLearningsPerRepo: 100 },
          providerCostCaps: { monthlyBudgetUSD: 100, dailyBudgetUSD: 10, alertThresholdPercent: 80, actionOnCapBreach: 'fail_closed' },
        },
        apiKeys: [],
        reviewCounter: 0,
        totalCostUSD: 0,
      };

      await store.initialize(seedData);

      // Verify no INSERT queries were performed during seeding
      expect(insertedQueries.length).toBe(0);
    });
  });

  describe('5. DashboardStore Dual-Store Synchronization & Resiliency', () => {
    it('initPostgres overlays PostgreSQL data into DashboardStore when configured', async () => {
      process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/mockdb';

      vi.spyOn(postgresStore, 'initialize').mockResolvedValue(undefined);
      vi.spyOn(postgresStore, 'loadAllData').mockResolvedValue({
        repositories: [
          {
            id: 'repo-pg-1',
            owner: 'pg-org',
            repo: 'pg-repo',
            full_name: 'pg-org/pg-repo',
            automationEnabled: true,
            strictnessProfile: 'assertive',
            updatedAt: new Date().toISOString(),
          },
        ],
        settings: {
          defaultModelOverrides: { security: 'claude-3-5-sonnet' },
          memoryEngineSettings: { autoSuppressNits: false, learningConfidenceThreshold: 90, maxLearningsPerRepo: 200 },
          providerCostCaps: { monthlyBudgetUSD: 500, dailyBudgetUSD: 50, alertThresholdPercent: 90, actionOnCapBreach: 'fail_closed' },
        },
        reviewLogs: [
          {
            id: 'pg-log-1',
            prRun: 'pg-org/pg-repo #10',
            repo: 'pg-org/pg-repo',
            prNumber: 10,
            headSha: 'sha999',
            personas: ['security'],
            quorum: '1/1',
            arbiterVerdict: 'SHIP',
            timestamp: new Date().toISOString(),
          },
        ],
      });

      const store = new DashboardStore(tempStorePath);
      await store.initPostgres();

      const repos = store.getRepositories();
      expect(repos.some((r) => r.owner === 'pg-org' && r.repo === 'pg-repo')).toBe(true);

      const logs = store.getReviewLogs();
      expect(logs.some((l) => l.id === 'pg-log-1')).toBe(true);
    });

    it('asynchronously syncs updates to PostgreSQL on save without throwing on PG failure', async () => {
      process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/mockdb';

      vi.spyOn(postgresStore, 'initialize').mockResolvedValue(undefined);
      const saveRepoSpy = vi.spyOn(postgresStore, 'saveRepository').mockRejectedValue(new Error('PG Write Error'));
      const saveSettingsSpy = vi.spyOn(postgresStore, 'saveSettings').mockRejectedValue(new Error('PG Write Error'));

      const store = new DashboardStore(tempStorePath);

      expect(() => {
        store.updateRepository('org-sync', 'repo-sync', { automationEnabled: false });
      }).not.toThrow();

      expect(saveRepoSpy).toHaveBeenCalled();
      expect(saveSettingsSpy).toHaveBeenCalled();
    });

    it('asynchronously syncs review logs to PostgreSQL when recordReviewRun is called', async () => {
      process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/mockdb';

      vi.spyOn(postgresStore, 'initialize').mockResolvedValue(undefined);
      const saveLogSpy = vi.spyOn(postgresStore, 'saveReviewLog').mockResolvedValue(undefined);

      const store = new DashboardStore(tempStorePath);
      store.recordReviewRun({
        repo: 'calltelemetry/cisco-cdr',
        prNumber: 99,
        headSha: 'head99',
        personas: ['security'],
        arbiterVerdict: 'SHIP',
        timestamp: new Date().toISOString(),
      });

      expect(saveLogSpy).toHaveBeenCalled();
      const passedLog = saveLogSpy.mock.calls[0][0];
      expect(passedLog.repo).toBe('calltelemetry/cisco-cdr');
      expect(passedLog.prNumber).toBe(99);
      expect(passedLog.arbiterVerdict).toBe('SHIP');
    });
  });

  describe('6. PostgreSQL Pool Lifecycle & Clean Shutdown', () => {
    it('resets pool and initialized flag on close()', async () => {
      process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/mockdb';
      const store = new PostgresStore();

      const mockEnd = vi.fn(async () => {});
      (store as any).pool = { end: mockEnd };
      (store as any).initialized = true;

      await store.close();

      expect(mockEnd).toHaveBeenCalled();
      expect((store as any).pool).toBeNull();
      expect((store as any).initialized).toBe(false);
    });
  });
});
