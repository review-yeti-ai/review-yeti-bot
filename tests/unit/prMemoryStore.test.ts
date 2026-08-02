import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PRMemoryStore } from '../../src/memory/prMemoryStore';
import { postgresStore } from '../../src/persistence/postgresStore';

describe('PRMemoryStore Unit Tests', () => {
  let store: PRMemoryStore;

  beforeEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.POSTGRES_URL;
    store = new PRMemoryStore(':memory:');
  });

  afterEach(async () => {
    delete process.env.DATABASE_URL;
    delete process.env.POSTGRES_URL;
    vi.restoreAllMocks();
    await postgresStore.close();
    store.close();
  });

  it('initializes schema and records reviewer learnings', async () => {
    const learning = await store.recordLearning('calltelemetry/cisco-cdr', 42, {
      category: 'architecture',
      title: 'Use DatabaseSync WAL mode',
      description: 'SQLite instances must set WAL mode for concurrent performance.',
      filePath: 'src/memory/prMemoryStore.ts',
      confidence: 0.95,
    });

    expect(learning.id).toBeDefined();
    expect(learning.repo).toBe('calltelemetry/cisco-cdr');
    expect(learning.prNumber).toBe(42);
    expect(learning.category).toBe('architecture');

    const result = await store.queryLearnings('calltelemetry/cisco-cdr');
    expect(result.learnings.length).toBe(1);
    expect(result.learnings[0].title).toBe('Use DatabaseSync WAL mode');
    expect(result.learnings[0].confidence).toBe(0.95);
  });

  it('records resolved nit patterns and increments suppression count', async () => {
    const nit = await store.recordResolvedNit('calltelemetry/cisco-cdr', 10, {
      pattern: 'avoid console\\.log',
      filePath: 'src/app.ts',
      reason: 'Use logger instead of console.log',
      headSha: 'abc1234',
    });

    expect(nit.id).toBeDefined();
    expect(nit.pattern).toBe('avoid console\\.log');
    expect(nit.suppressionCount).toBe(0);

    await store.incrementNitSuppression(nit.id!);

    const result = await store.queryLearnings('calltelemetry/cisco-cdr', { filePath: 'src/app.ts' });
    expect(result.resolvedNits.length).toBe(1);
    expect(result.resolvedNits[0].suppressionCount).toBe(1);
  });

  it('records and queries accepted ADR constraints', async () => {
    await store.recordADRConstraint('calltelemetry/cisco-cdr', {
      adrNumber: 1,
      title: 'Fail-Closed Architecture',
      status: 'accepted',
      rule: 'Infrastructure failures must mark checks as failure.',
      targetPaths: ['src/**'],
    });

    await store.recordADRConstraint('calltelemetry/cisco-cdr', {
      adrNumber: 2,
      title: 'Draft Proposal',
      status: 'draft',
      rule: 'Draft rule not yet accepted.',
      targetPaths: ['src/**'],
    });

    const result = await store.queryLearnings('calltelemetry/cisco-cdr');
    expect(result.adrConstraints.length).toBe(1);
    expect(result.adrConstraints[0].title).toBe('Fail-Closed Architecture');
    expect(result.adrConstraints[0].targetPaths).toEqual(['src/**']);
  });

  it('filters learnings by category, filePath, and text query', async () => {
    await store.recordLearning('calltelemetry/cisco-cdr', 1, {
      category: 'security',
      title: 'Validate JWT tokens',
      description: 'Always check token signature and expiration.',
      filePath: 'src/api/auth.ts',
    });

    await store.recordLearning('calltelemetry/cisco-cdr', 2, {
      category: 'convention',
      title: 'Use Zod validation',
      description: 'API inputs must be validated with Zod schemas.',
      filePath: 'src/api/memoryApi.ts',
    });

    const secRes = await store.queryLearnings('calltelemetry/cisco-cdr', { category: 'security' });
    expect(secRes.learnings.length).toBe(1);
    expect(secRes.learnings[0].title).toBe('Validate JWT tokens');

    const fileRes = await store.queryLearnings('calltelemetry/cisco-cdr', { filePath: 'src/api/memoryApi.ts' });
    expect(fileRes.learnings.length).toBe(1);
    expect(fileRes.learnings[0].title).toBe('Use Zod validation');

    const queryRes = await store.queryLearnings('calltelemetry/cisco-cdr', { query: 'JWT' });
    expect(queryRes.learnings.length).toBe(1);
    expect(queryRes.learnings[0].title).toBe('Validate JWT tokens');
  });

  it('clears repo memory cleanly without affecting other repositories', async () => {
    await store.recordLearning('repo-a', 1, {
      category: 'style',
      title: 'Formatting',
      description: 'Use 2 spaces.',
    });

    await store.recordLearning('repo-b', 1, {
      category: 'style',
      title: 'Formatting',
      description: 'Use 4 spaces.',
    });

    await store.clearRepoMemory('repo-a');

    const resA = await store.queryLearnings('repo-a');
    expect(resA.learnings.length).toBe(0);

    const resB = await store.queryLearnings('repo-b');
    expect(resB.learnings.length).toBe(1);
  });

  it('creates database file on disk when a file path is provided', () => {
    const tmpDbPath = path.join(process.cwd(), '.ct-memory', 'test_pr_memory.db');
    if (fs.existsSync(tmpDbPath)) {
      fs.unlinkSync(tmpDbPath);
    }

    const diskStore = new PRMemoryStore(tmpDbPath);
    expect(fs.existsSync(tmpDbPath)).toBe(true);

    diskStore.close();
    if (fs.existsSync(tmpDbPath)) {
      fs.unlinkSync(tmpDbPath);
    }
  });

  it('dual-writes memory concepts to both PostgreSQL and SQLite when DATABASE_URL is configured', async () => {
    process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/postgres';
    vi.spyOn(postgresStore, 'isConfigured').mockReturnValue(true);
    const saveRuleSpy = vi.spyOn(postgresStore, 'saveLearnedRule').mockResolvedValue(undefined);
    const saveNitSpy = vi.spyOn(postgresStore, 'saveSuppressedNit').mockResolvedValue(undefined);
    const saveAdrSpy = vi.spyOn(postgresStore, 'saveADRConstraint').mockResolvedValue(undefined);
    const saveFbSpy = vi.spyOn(postgresStore, 'saveDeveloperFeedback').mockResolvedValue(undefined);

    await store.recordLearning('repo-dual', 100, {
      category: 'security',
      title: 'PG Dual Write Test',
      description: 'Dual write verification',
    });
    expect(saveRuleSpy).toHaveBeenCalledWith(expect.objectContaining({ title: 'PG Dual Write Test' }));

    await store.recordResolvedNit('repo-dual', 100, {
      pattern: 'no-eval',
      filePath: 'src/eval.ts',
      reason: 'Eval is dangerous',
    });
    expect(saveNitSpy).toHaveBeenCalledWith(expect.objectContaining({ pattern: 'no-eval' }));

    await store.recordADRConstraint('repo-dual', {
      adrNumber: 5,
      title: 'ADR Dual Write',
      status: 'accepted',
      rule: 'Rule for ADR',
      targetPaths: ['src/**'],
    });
    expect(saveAdrSpy).toHaveBeenCalledWith(expect.objectContaining({ title: 'ADR Dual Write' }));

    await store.recordFeedback('repo-dual', 'looks good', 'positive');
    expect(saveFbSpy).toHaveBeenCalledWith(expect.objectContaining({ comment: 'looks good', feedbackType: 'positive' }));
  });

  it('seamlessly falls back to local SQLite when PostgreSQL query fails or throws', async () => {
    process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/postgres';
    // Populate local SQLite
    await store.recordLearning('repo-fallback', 1, {
      category: 'convention',
      title: 'SQLite Local Learning',
      description: 'Available on fallback',
    });

    vi.spyOn(postgresStore, 'isConfigured').mockReturnValue(true);
    vi.spyOn(postgresStore, 'queryLearnings').mockRejectedValue(new Error('PostgreSQL Query Connection Timeout'));

    const result = await store.queryLearnings('repo-fallback');
    expect(result.learnings.length).toBe(1);
    expect(result.learnings[0].title).toBe('SQLite Local Learning');
  });
});

