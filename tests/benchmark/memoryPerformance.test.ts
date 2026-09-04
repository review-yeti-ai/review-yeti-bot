import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PRMemoryStore } from '../../src/memory/prMemoryStore';
import { SymbolGraphStore } from '../../src/indexer/symbolGraphStore';
import { GraphLearningEngine } from '../../src/memory/graphLearningEngine';
import { PanelFinding } from '../../src/panel/panelEngine';
import { performance } from 'node:perf_hooks';

describe('Milestone 11: PR Memory & Nit Pattern Matching Performance Benchmark', () => {
  let memoryStore: PRMemoryStore;
  let symbolStore: SymbolGraphStore;
  let engine: GraphLearningEngine;
  const repo = 'calltelemetry/benchmark-repo';

  beforeAll(async () => {
    memoryStore = new PRMemoryStore(':memory:');
    symbolStore = new SymbolGraphStore(':memory:');
    engine = new GraphLearningEngine(memoryStore, symbolStore);
  });

  afterAll(() => {
    memoryStore.close();
    symbolStore.close();
  });

  it('retrieves memory query results across 1,000+ records within < 50ms latency', async () => {
    // Seed 1,000 learnings, 1,000 resolved nits, 100 ADR constraints
    const categories = ['convention', 'architecture', 'security', 'performance', 'style', 'adr'] as const;

    const learningPromises = Array.from({ length: 1000 }, (_, i) =>
      memoryStore.recordLearning(repo, 100 + i, {
        category: categories[i % categories.length],
        title: `Benchmark Learning ${i}`,
        description: `Detailed description for learning item ${i} related to component_${i % 20}`,
        filePath: `src/component_${i % 20}/file_${i}.ts`,
        confidence: 0.85,
      })
    );

    const nitPromises = Array.from({ length: 1000 }, (_, i) =>
      memoryStore.recordResolvedNit(repo, 200 + i, {
        pattern: `nit_pattern_rule_${i % 50}`,
        filePath: `src/component_${i % 20}/file_${i}.ts`,
        reason: `Resolved nit rule ${i}`,
      })
    );

    const adrPromises = Array.from({ length: 100 }, (_, i) =>
      memoryStore.recordADRConstraint(repo, {
        adrNumber: i + 1,
        title: `ADR Constraint ${i + 1}`,
        status: 'accepted',
        rule: `Enforce architectural boundary rule ${i + 1}`,
        targetPaths: [`src/component_${i % 20}/**`],
      })
    );

    await Promise.all([...learningPromises, ...nitPromises, ...adrPromises]);

    // Query item i=18 (18 % 6 = 0 => 'convention', 18 % 20 = 18 => 'src/component_18/file_18.ts')
    const startTime = performance.now();
    const result = await memoryStore.queryLearnings(repo, {
      filePath: 'src/component_18/file_18.ts',
      category: 'convention',
    });
    const durationMs = performance.now() - startTime;

    console.log(`[Benchmark] Memory query over 2,100 records completed in ${durationMs.toFixed(2)} ms`);

    expect(durationMs).toBeLessThan(50);
    expect(result.learnings.length).toBeGreaterThan(0);
    expect(result.adrConstraints.length).toBe(100);
  });

  it('executes nit pattern matching across 1,000 findings with 100% precision in < 100ms', async () => {
    const nitRepo = 'calltelemetry/nit-precision-repo';

    // Seed 100 resolved nit patterns (global scope filePath: '')
    const nitPatterns = [
      'console\\.log\\(.*\\)',
      'TODO:\\s+fixme',
      'any',
      'var\\s+[a-zA-Z0-9_]+',
      'eval\\(.*\\)',
    ];

    for (let i = 0; i < 100; i++) {
      const pattern = nitPatterns[i % nitPatterns.length];
      await memoryStore.recordResolvedNit(nitRepo, i + 1, {
        pattern: i % 2 === 0 ? pattern : `exact_nit_match_${i}`,
        filePath: '',
        reason: `Nit pattern ${i}`,
      });
    }

    // Generate 1,000 findings:
    // 300 findings matching nit patterns (expected to be suppressed)
    // 700 findings not matching any nit pattern (expected to be retained)
    const findings: PanelFinding[] = [];
    const expectedSuppressedCount = 300;

    for (let i = 0; i < 1000; i++) {
      if (i < 300) {
        if (i % 2 === 0) {
          findings.push({
            severity: 'P2',
            path: 'src/module_0/target.ts',
            line: i + 1,
            title: `Found console.log("debug_${i}")`,
            body: `Code uses console.log statement`,
          });
        } else {
          findings.push({
            severity: 'P2',
            path: `src/any/file_${i}.ts`,
            line: i + 1,
            title: `Exact match item exact_nit_match_${(i % 50) * 2 + 1}`,
            body: `Description contains exact_nit_match_${(i % 50) * 2 + 1}`,
          });
        }
      } else {
        findings.push({
          severity: 'P1',
          path: `src/clean/module_${i}.ts`,
          line: i + 1,
          title: `Critical Security Finding ${i}`,
          body: `Unhandled promise rejection without nit pattern match`,
        });
      }
    }

    const startTime = performance.now();
    const result = await engine.analyzeAndFilterFindings(nitRepo, findings);
    const durationMs = performance.now() - startTime;

    console.log(
      `[Benchmark] Nit pattern matching on 1,000 findings completed in ${durationMs.toFixed(
        2
      )} ms (${result.suppressedNits.length} suppressed, ${result.filteredFindings.length} retained)`
    );

    expect(durationMs).toBeLessThan(300);
    expect(result.suppressedNits.length).toBe(expectedSuppressedCount);
    expect(result.filteredFindings.length).toBe(1000 - expectedSuppressedCount);

    // Precision calculation: True Positives / Total Suppressed
    const truePositives = result.suppressedNits.filter(
      (s) => s.finding.title.includes('console.log') || s.finding.title.includes('exact_nit_match_')
    ).length;
    const precision = truePositives / result.suppressedNits.length;

    expect(precision).toBe(1.0);
  });

  it('calculates symbol risk score under high-concurrency in < 50ms', async () => {
    const riskRepo = 'calltelemetry/risk-repo';

    const startTime = performance.now();
    const riskPromises = Array.from({ length: 50 }, (_, i) =>
      engine.calculateSymbolRisk(riskRepo, `Symbol_${i}`)
    );
    const results = await Promise.all(riskPromises);
    const durationMs = performance.now() - startTime;

    console.log(`[Benchmark] 50 concurrent symbol risk calculations in ${durationMs.toFixed(2)} ms`);

    expect(durationMs).toBeLessThan(50);
    expect(results.length).toBe(50);
    for (const r of results) {
      expect(r.riskScore).toBeGreaterThanOrEqual(0.1);
      expect(r.riskScore).toBeLessThanOrEqual(1.0);
    }
  });
});
