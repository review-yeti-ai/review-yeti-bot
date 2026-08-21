import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PRMemoryStore } from '../../src/memory/prMemoryStore';
import { SymbolGraphStore } from '../../src/indexer/symbolGraphStore';
import { GraphLearningEngine } from '../../src/memory/graphLearningEngine';
import { PanelFinding } from '../../src/panel/panelEngine';

describe('GraphLearningEngine Unit Tests', () => {
  let memoryStore: PRMemoryStore;
  let symbolStore: SymbolGraphStore;
  let engine: GraphLearningEngine;

  beforeEach(() => {
    memoryStore = new PRMemoryStore(':memory:');
    symbolStore = new SymbolGraphStore(':memory:');
    engine = new GraphLearningEngine(memoryStore, symbolStore);
  });

  afterEach(() => {
    memoryStore.close();
    symbolStore.close();
  });

  it('suppresses nit findings matching recorded resolved nit regex patterns', async () => {
    const repo = 'calltelemetry/cisco-cdr';

    // Record a resolved nit pattern
    await memoryStore.recordResolvedNit(repo, 12, {
      pattern: 'avoid console\\.log',
      filePath: 'src/app.ts',
      reason: 'Use structured logger instead.',
    });

    const findings: PanelFinding[] = [
      {
        severity: 'P2',
        path: 'src/app.ts',
        line: 45,
        title: 'Avoid console.log usage',
        body: 'Please replace console.log with logger.info.',
      },
      {
        severity: 'P0',
        path: 'src/app.ts',
        line: 100,
        title: 'Unchecked null pointer',
        body: 'Critical crash vector.',
      },
    ];

    const result = await engine.analyzeAndFilterFindings(repo, findings);

    expect(result.suppressedNits.length).toBe(1);
    expect(result.suppressedNits[0].finding.title).toBe('Avoid console.log usage');
    expect(result.filteredFindings.length).toBe(1);
    expect(result.filteredFindings[0].title).toBe('Unchecked null pointer');

    // Verify suppression count was incremented
    const memQuery = await memoryStore.queryLearnings(repo, { filePath: 'src/app.ts' });
    expect(memQuery.resolvedNits[0].suppressionCount).toBe(1);
  });

  it('matches ADR constraints based on changed file target path globs', async () => {
    const repo = 'calltelemetry/cisco-cdr';

    await memoryStore.recordADRConstraint(repo, {
      adrNumber: 5,
      title: 'Fail-Closed Webhook Handling',
      status: 'accepted',
      rule: 'All webhooks must reject invalid signatures with 401.',
      targetPaths: ['src/github/**', 'src/api/**'],
    });

    const findings: PanelFinding[] = [
      {
        severity: 'P1',
        path: 'src/github/webhookServer.ts',
        line: 20,
        title: 'Missing signature validation check',
        body: 'Ensure HMAC check passes before processing.',
      },
    ];

    const result = await engine.analyzeAndFilterFindings(repo, findings);

    expect(result.appliedADRs.length).toBe(1);
    expect(result.appliedADRs[0].adrNumber).toBe(5);
    expect(result.appliedADRs[0].title).toBe('Fail-Closed Webhook Handling');
  });

  it('calculates symbol risk score based on symbol callers and past learnings', async () => {
    const repo = 'calltelemetry/cisco-cdr';
    const symbolName = 'PRMemoryStore';

    // Record past learnings referencing symbol
    await memoryStore.recordLearning(repo, 50, {
      category: 'architecture',
      title: 'PRMemoryStore concurrency',
      description: 'Ensure PRMemoryStore uses WAL mode for SQLite.',
    });

    const risk = await engine.calculateSymbolRisk(repo, symbolName);

    expect(risk.symbolName).toBe('PRMemoryStore');
    expect(risk.pastLearningsCount).toBe(1);
    expect(risk.callersCount).toBe(0);
    // Base 0.1 + (0 * 0.05) + (1 * 0.15) = 0.25
    expect(risk.riskScore).toBe(0.25);
  });
});
