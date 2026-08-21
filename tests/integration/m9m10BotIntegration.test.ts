import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { PRMemoryStore } from '../../src/memory/prMemoryStore';
import { GraphLearningEngine } from '../../src/memory/graphLearningEngine';

describe('Milestone 9 & 10 Bot Integration Tests', () => {
  beforeEach(() => {
    process.env.WEBHOOK_SECRET = 'test-secret-key';
  });

  it('GET /health returns memoryEngineReady: true', async () => {
    const app = createApp();
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('ct-review-bot');
    expect(res.body.memoryEngineReady).toBe(true);
  });

  it('end-to-end nit pattern recording and suppression integration', async () => {
    const memoryStore = new PRMemoryStore(':memory:');
    const learningEngine = new GraphLearningEngine(memoryStore);

    const repo = 'calltelemetry/cisco-cdr';

    // Record resolved nit pattern
    await memoryStore.recordResolvedNit(repo, 77, {
      pattern: 'magic numbers',
      filePath: 'src/panel/panelEngine.ts',
      reason: 'Use named constants.',
    });

    const findings = [
      {
        severity: 'P2' as const,
        path: 'src/panel/panelEngine.ts',
        line: 15,
        title: 'Magic numbers detected in timeout calculation',
        body: 'Replace 1000 with ONE_SECOND_MS constant.',
      },
      {
        severity: 'P0' as const,
        path: 'src/panel/panelEngine.ts',
        line: 50,
        title: 'Uncaught Exception',
        body: 'Unhandled rejection vulnerability.',
      },
    ];

    const filterRes = await learningEngine.analyzeAndFilterFindings(repo, findings);

    expect(filterRes.suppressedNits.length).toBe(1);
    expect(filterRes.suppressedNits[0].finding.title).toContain('Magic numbers');
    expect(filterRes.filteredFindings.length).toBe(1);
    expect(filterRes.filteredFindings[0].title).toBe('Uncaught Exception');

    memoryStore.close();
  });
});
