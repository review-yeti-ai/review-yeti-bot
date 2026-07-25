import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PRMemoryStore } from '../../src/memory/prMemoryStore';

describe('PRMemoryStore Unit Tests', () => {
  let store: PRMemoryStore;

  beforeEach(() => {
    store = new PRMemoryStore(':memory:');
  });

  afterEach(() => {
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
    fs.unlinkSync(tmpDbPath);
  });
});
