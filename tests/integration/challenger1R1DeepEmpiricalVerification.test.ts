import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { PostgresStore, ADVISORY_LOCK_ID, postgresStore } from '../../src/persistence/postgresStore';
import { PRMemoryStore } from '../../src/memory/prMemoryStore';
import { PlatformMemoryStore } from '../../src/memory/platformMemoryStore';
import { SymbolGraphStore } from '../../src/indexer/symbolGraphStore';

describe('Empirical Verification: R1 PostgreSQL Memory Storage & Dual-Store Fallback Logic', () => {
  const tempTestDir = path.join(process.cwd(), 'data', 'test-challenger-r1-verification');

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

  describe('1. Schema Auto-Migration Under Advisory Lock 1029384', () => {
    it('uses exact advisory lock ID constant 1029384', () => {
      expect(ADVISORY_LOCK_ID).toBe(1029384);
    });

    it('requests pg_advisory_xact_lock(1029384) inside a single transaction during initialize()', async () => {
      process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/test_advisory_db';
      const store = new PostgresStore();

      const executedQueries: Array<{ text: string; params?: any[] }> = [];

      const mockClient = {
        query: vi.fn(async (text: string, params?: any[]) => {
          executedQueries.push({ text, params });
          if (text.includes('COUNT(*)')) {
            return { rows: [{ count: 0 }] };
          }
          return { rows: [] };
        }),
        release: vi.fn(),
      };

      vi.spyOn(store, 'getPool').mockReturnValue({ connect: async () => mockClient } as any);

      await store.initialize();

      const texts = executedQueries.map((q) => q.text);
      expect(texts[0]).toBe('BEGIN');

      const lockQuery = executedQueries.find((q) => q.text.includes('pg_advisory_xact_lock'));
      expect(lockQuery).toBeDefined();
      expect(lockQuery?.params).toEqual([1029384]);

      // Confirm schema table DDL calls
      expect(texts.some((t) => t.includes('CREATE TABLE IF NOT EXISTS dashboard_settings'))).toBe(true);
      expect(texts.some((t) => t.includes('CREATE TABLE IF NOT EXISTS learned_rules'))).toBe(true);
      expect(texts.some((t) => t.includes('CREATE TABLE IF NOT EXISTS suppressed_nits'))).toBe(true);
      expect(texts.some((t) => t.includes('CREATE TABLE IF NOT EXISTS adr_constraints'))).toBe(true);
      expect(texts.some((t) => t.includes('CREATE TABLE IF NOT EXISTS developer_feedback'))).toBe(true);
      expect(texts.some((t) => t.includes('CREATE TABLE IF NOT EXISTS platform_patterns'))).toBe(true);

      expect(texts[texts.length - 1]).toBe('COMMIT');
      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  describe('2. Dual-Write Behavior when DATABASE_URL is Configured', () => {
    it('PRMemoryStore dual-writes learnings, nits, ADRs, feedback, and batch increments to PG', async () => {
      process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/test_dualwrite';
      vi.spyOn(postgresStore, 'isConfigured').mockReturnValue(true);

      const saveRuleSpy = vi.spyOn(postgresStore, 'saveLearnedRule').mockResolvedValue(undefined);
      const saveNitSpy = vi.spyOn(postgresStore, 'saveSuppressedNit').mockResolvedValue(undefined);
      const saveAdrSpy = vi.spyOn(postgresStore, 'saveADRConstraint').mockResolvedValue(undefined);
      const saveFbSpy = vi.spyOn(postgresStore, 'saveDeveloperFeedback').mockResolvedValue(undefined);
      const incBatchSpy = vi.spyOn(postgresStore, 'incrementNitSuppressionBatch').mockResolvedValue(undefined);

      const prStore = new PRMemoryStore(':memory:');

      // Record learning
      await prStore.recordLearning('repo/dual', 10, {
        category: 'security',
        title: 'Rule 1',
        description: 'Desc 1',
      });
      expect(saveRuleSpy).toHaveBeenCalledWith(expect.objectContaining({ repo: 'repo/dual', title: 'Rule 1' }));

      // Record nit
      await prStore.recordResolvedNit('repo/dual', 10, {
        pattern: 'pattern-1',
        filePath: 'src/file.ts',
        reason: 'Reason 1',
      });
      expect(saveNitSpy).toHaveBeenCalledWith(expect.objectContaining({ pattern: 'pattern-1' }));

      // Record ADR
      await prStore.recordADRConstraint('repo/dual', {
        adrNumber: 1,
        title: 'ADR 1',
        status: 'accepted',
        rule: 'Rule ADR',
        targetPaths: ['src/*'],
      });
      expect(saveAdrSpy).toHaveBeenCalledWith(expect.objectContaining({ title: 'ADR 1' }));

      // Record Feedback
      await prStore.recordFeedback('repo/dual', 'good job', 'positive');
      expect(saveFbSpy).toHaveBeenCalledWith(expect.objectContaining({ comment: 'good job', feedbackType: 'positive' }));

      // Batch Increment
      await prStore.incrementNitSuppressionBatch(['nit_1', 'nit_2']);
      expect(incBatchSpy).toHaveBeenCalledWith(['nit_1', 'nit_2']);

      prStore.close();
    });

    it('PlatformMemoryStore dual-writes new patterns and elevated pattern updates to PG', async () => {
      process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/test_dualwrite';
      vi.spyOn(postgresStore, 'isConfigured').mockReturnValue(true);

      const savePatternSpy = vi.spyOn(postgresStore, 'savePlatformPattern').mockResolvedValue(undefined);

      const platformDbPath = path.join(tempTestDir, 'platform_test.db');
      const platformStore = new PlatformMemoryStore(platformDbPath);

      // Record pattern 1st time
      await platformStore.recordPlatformPattern('security', 'raw-pattern-1', 'desc-1', 'repo-a');
      expect(savePatternSpy).toHaveBeenCalledTimes(1);
      expect(savePatternSpy).toHaveBeenLastCalledWith(expect.objectContaining({
        category: 'security',
        pattern: 'raw-pattern-1',
        occurrenceCount: 1,
        confidenceScore: 80,
      }));

      // Record pattern 2nd time (triggers elevation update)
      await platformStore.recordPlatformPattern('security', 'raw-pattern-1', 'desc-1', 'repo-b');
      expect(savePatternSpy).toHaveBeenCalledTimes(2);
      expect(savePatternSpy).toHaveBeenLastCalledWith(expect.objectContaining({
        category: 'security',
        pattern: 'raw-pattern-1',
        occurrenceCount: 2,
        confidenceScore: 85,
      }));

      platformStore.close();
    });

    it('continues successfully in SQLite even if PostgreSQL dual-write throws an error', async () => {
      process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/test_dualwrite_err';
      vi.spyOn(postgresStore, 'isConfigured').mockReturnValue(true);
      vi.spyOn(postgresStore, 'saveLearnedRule').mockRejectedValue(new Error('PG Connection Refused'));

      const prStore = new PRMemoryStore(':memory:');

      // Should NOT throw even though PG fails
      const learning = await prStore.recordLearning('repo/resilient', 1, {
        category: 'architecture',
        title: 'Resilient Learning',
        description: 'Should persist to SQLite',
      });

      expect(learning.title).toBe('Resilient Learning');

      // Verify SQLite received data
      vi.spyOn(postgresStore, 'isConfigured').mockReturnValue(false); // force sqlite read
      const res = await prStore.queryLearnings('repo/resilient');
      expect(res.learnings.length).toBe(1);
      expect(res.learnings[0].title).toBe('Resilient Learning');

      prStore.close();
    });
  });

  describe('3. Primary PostgreSQL Query with Seamless SQLite Fallback', () => {
    it('queries PostgreSQL when available, falls back to SQLite on PG error', async () => {
      const prStore = new PRMemoryStore(':memory:');

      // Seed local SQLite
      await prStore.recordLearning('repo/fallback', 100, {
        category: 'convention',
        title: 'Local SQLite Concept',
        description: 'Local fallback data',
      });

      // PG configured and returning PG data
      vi.spyOn(postgresStore, 'isConfigured').mockReturnValue(true);
      vi.spyOn(postgresStore, 'queryLearnings').mockResolvedValue({
        learnings: [{ id: 'pg_1', repo: 'repo/fallback', prNumber: 100, category: 'convention', title: 'PG Concept', description: 'From PG', confidence: 1, createdAt: '', updatedAt: '' }],
        resolvedNits: [],
        adrConstraints: [],
      });

      const pgRes = await prStore.queryLearnings('repo/fallback');
      expect(pgRes.learnings[0].title).toBe('PG Concept');

      // PG throws error -> seamless fallback to SQLite
      vi.spyOn(postgresStore, 'queryLearnings').mockRejectedValue(new Error('Postgres Deadlock / Connection Lost'));

      const fallbackRes = await prStore.queryLearnings('repo/fallback');
      expect(fallbackRes.learnings.length).toBe(1);
      expect(fallbackRes.learnings[0].title).toBe('Local SQLite Concept');

      prStore.close();
    });

    it('PlatformMemoryStore queries PostgreSQL when available, falls back to SQLite on PG error', async () => {
      const platformDbPath = path.join(tempTestDir, 'platform_fallback.db');
      const platformStore = new PlatformMemoryStore(platformDbPath);

      // Seed local SQLite
      await platformStore.recordPlatformPattern('performance', 'use-cache', 'Cache expensive calls', 'repo-1');

      // PG configured & throwing error
      vi.spyOn(postgresStore, 'isConfigured').mockReturnValue(true);
      vi.spyOn(postgresStore, 'queryPlatformPatterns').mockRejectedValue(new Error('PG Query Timeout'));

      const patterns = await platformStore.queryPlatformPatterns('performance', 70);
      expect(patterns.length).toBe(1);
      expect(patterns[0].pattern).toBe('use-cache');

      platformStore.close();
    });
  });

  describe('4. Transparent SQLite Operation when DATABASE_URL is Unconfigured', () => {
    it('operates 100% locally on SQLite without PG calls when DATABASE_URL is absent', async () => {
      delete process.env.DATABASE_URL;
      delete process.env.POSTGRES_URL;

      expect(postgresStore.isConfigured()).toBe(false);

      const prStore = new PRMemoryStore(':memory:');
      const saveRuleSpy = vi.spyOn(postgresStore, 'saveLearnedRule');
      const queryLearningsSpy = vi.spyOn(postgresStore, 'queryLearnings');

      await prStore.recordLearning('repo/sqlite_only', 1, {
        category: 'style',
        title: 'SQLite Only Rule',
        description: 'No PG invoked',
      });

      const result = await prStore.queryLearnings('repo/sqlite_only');

      expect(saveRuleSpy).not.toHaveBeenCalled();
      expect(queryLearningsSpy).not.toHaveBeenCalled();
      expect(result.learnings.length).toBe(1);
      expect(result.learnings[0].title).toBe('SQLite Only Rule');

      prStore.close();
    });
  });

  describe('5. Symbol Graph Complete Isolation on Local SQLite symbol_graph.db', () => {
    it('operates completely on local SQLite symbol_graph.db without any Postgres dependency', async () => {
      process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/some_db';

      const symbolDbPath = path.join(tempTestDir, 'symbol_graph.db');
      const store = new SymbolGraphStore(symbolDbPath);

      expect(fs.existsSync(symbolDbPath)).toBe(true);

      // Verify indexing operates locally
      const mockRepoDir = path.join(tempTestDir, 'mock_repo');
      fs.mkdirSync(mockRepoDir, { recursive: true });
      fs.writeFileSync(
        path.join(mockRepoDir, 'index.ts'),
        `export function processOrder(orderId: string): void {\n  validateOrder(orderId);\n}\nfunction validateOrder(id: string): boolean {\n  return id.length > 0;\n}`
      );

      const stats = await store.indexRepository(mockRepoDir);
      expect(stats.filesIndexed).toBe(1);
      expect(stats.symbolsExtracted).toBeGreaterThanOrEqual(2);

      const queryRes = await store.querySymbols('processOrder');
      expect(queryRes.symbolName).toBe('processOrder');
      expect(queryRes.definitions.length).toBe(1);

      const counts = store.getCounts();
      expect(counts.nodes).toBeGreaterThan(0);

      await store.close();
    });
  });
});
