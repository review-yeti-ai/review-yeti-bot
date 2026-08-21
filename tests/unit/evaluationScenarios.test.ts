import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  EVALUATION_SCENARIOS,
  DEFAULT_EVALUATION_SCENARIOS,
  getAllScenarios,
  listEvaluationScenarios,
  getScenarioById,
  getEvaluationScenario,
  getScenariosByCategory,
  filterScenariosByCategory,
  getScenarioCategories,
  getScenariosByPersona,
  formatUnifiedDiff,
  validateScenario,
  ScenarioCategory,
  EvaluationScenario,
} from '../../src/evaluation/scenarios';
const { changedLineNumbers, sanitizeFindings, computeArbitration } = require('../../src/review/reviewCore.js');

describe('Evaluation Scenarios & Matrices Registry', () => {
  const fixturesDir = path.resolve(__dirname, '../fixtures/scenarios');

  it('contains 190 comprehensive evaluation scenarios (≥188)', () => {
    const scenarios = getAllScenarios();
    expect(scenarios.length).toBeGreaterThanOrEqual(188);
    expect(scenarios.length).toBe(190);
    expect(DEFAULT_EVALUATION_SCENARIOS.length).toBe(190);
    expect(listEvaluationScenarios().length).toBe(190);
  });

  it('guarantees unique scenario IDs across all entries', () => {
    const scenarios = getAllScenarios();
    const ids = scenarios.map((s) => s.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(scenarios.length);
  });

  it('covers all core evaluation categories', () => {
    const requiredCategories: ScenarioCategory[] = [
      'security',
      'performance',
      'architecture',
      'testing',
      'database',
      'dependencies',
      'multi_file',
      'multi_turn',
      'evidence',
    ];
    const categories = getScenarioCategories();
    for (const required of requiredCategories) {
      expect(categories).toContain(required);
      const matching = getScenariosByCategory(required);
      expect(matching.length).toBeGreaterThan(0);
    }
  });

  it('validates all scenario records with validateScenario helper', () => {
    const scenarios = getAllScenarios();
    for (const scenario of scenarios) {
      const validation = validateScenario(scenario);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);
    }
  });

  it('detects structural errors in invalid scenarios', () => {
    const invalidScenario = {
      id: '',
      name: '',
      category: 'invalid' as any,
      description: '',
      diffFiles: [],
      prContext: {} as any,
      expectedFindings: [{ personaId: 'security', severity: 'INVALID' as any, path: 'unknown.ts' }],
      expectedVerdict: 'INVALID_VERDICT' as any,
    };
    const validation = validateScenario(invalidScenario);
    expect(validation.valid).toBe(false);
    expect(validation.errors.length).toBeGreaterThan(0);
  });

  it('allows lookups by ID and category', () => {
    const secScenario = getScenarioById('sec-multi-tenant-isolation');
    expect(secScenario).toBeDefined();
    expect(secScenario?.category).toBe('security');
    expect(secScenario?.expectedVerdict).toBe('BLOCK');

    const nonExistent = getScenarioById('non-existent-id');
    expect(nonExistent).toBeUndefined();

    const perfScenarios = getScenariosByCategory('performance');
    expect(perfScenarios.length).toBeGreaterThanOrEqual(3);
    for (const s of perfScenarios) {
      expect(s.category).toBe('performance');
    }
  });

  it('allows lookups by persona ID', () => {
    const securityScenarios = getScenariosByPersona('security');
    expect(securityScenarios.length).toBeGreaterThan(0);
    for (const s of securityScenarios) {
      expect(s.expectedFindings.some((f) => f.personaId === 'security')).toBe(true);
    }
  });

  it('verifies all expected finding line numbers are present in diff changedLineNumbers', () => {
    const scenarios = getAllScenarios();
    for (const scenario of scenarios) {
      for (const finding of scenario.expectedFindings) {
        const file = scenario.diffFiles.find((f) => f.path === finding.path);
        expect(file).toBeDefined();
        if (file && typeof finding.line === 'number') {
          const changedLines = changedLineNumbers(file.patch);
          expect(changedLines).not.toBeNull();
          expect(changedLines!.has(finding.line)).toBe(true);
        }
      }
    }
  });

  it('verifies sanitizeFindings retains all ground truth findings without out-of-diff dropping', () => {
    const scenarios = getAllScenarios();
    for (const scenario of scenarios) {
      const rawFindings = scenario.expectedFindings.map((ef) => ({
        severity: ef.severity,
        path: ef.path,
        line: ef.line || 1,
        title: ef.title || 'Ground truth finding',
        body: ef.description || 'Ground truth description',
      }));

      const sanitized = sanitizeFindings(rawFindings, scenario.diffFiles);
      expect(sanitized.length).toBe(scenario.expectedFindings.length);
    }
  });

  it('verifies ground truth findings compute to the expected arbitration verdict', () => {
    const scenarios = getAllScenarios();
    for (const scenario of scenarios) {
      const sanitizedFindings = scenario.expectedFindings.map((ef) => ({
        severity: ef.severity,
        path: ef.path,
        line: ef.line || 1,
        title: ef.title || 'Ground truth finding',
        body: ef.description || 'Ground truth description',
      }));

      // Simulate a completed reviewer lane
      const personaResults = [
        {
          persona: 'synthetic-reviewer',
          status: 'SUCCESS',
          findings: sanitizedFindings,
        },
      ];

      const arbitration = computeArbitration(personaResults, 1, { changedFiles: scenario.diffFiles });
      expect(arbitration.verdict).toBe(scenario.expectedVerdict);
    }
  });

  it('synchronizes all scenario definitions with on-disk .diff fixtures', () => {
    const scenarios = getAllScenarios();
    expect(fs.existsSync(fixturesDir)).toBe(true);

    for (const scenario of scenarios) {
      const fixturePath = path.join(fixturesDir, `${scenario.id}.diff`);
      expect(fs.existsSync(fixturePath)).toBe(true);

      const content = fs.readFileSync(fixturePath, 'utf-8');
      const expectedUnified = formatUnifiedDiff(scenario.diffFiles).trimEnd() + '\n';
      expect(content).toBe(expectedUnified);
    }
  });

  it('verifies multi-turn scenario sessionContext structure and nit suppression feedback', () => {
    const multiTurnScenarios = getScenariosByCategory('multi_turn');
    expect(multiTurnScenarios.length).toBeGreaterThanOrEqual(1);

    for (const scenario of multiTurnScenarios) {
      expect(scenario.sessionContext).toBeDefined();
      expect(scenario.sessionContext?.turn).toBeGreaterThanOrEqual(2);
      expect(scenario.sessionContext?.augmentedHeader).toContain('Prior review context for this PR');
      expect(scenario.sessionContext?.authorFeedback).toBeDefined();
      expect(scenario.sessionContext?.authorFeedback!.length).toBeGreaterThan(0);
      expect(scenario.expectedFindings.length).toBe(0);
      expect(scenario.expectedVerdict).toBe('SHIP');
    }
  });

  it('verifies evidence requirement scenario structure and deterministic commands', () => {
    const evidenceScenarios = getScenariosByCategory('evidence');
    expect(evidenceScenarios.length).toBeGreaterThanOrEqual(1);

    for (const scenario of evidenceScenarios) {
      expect(scenario.evidenceRequirement).toBeDefined();
      expect(scenario.evidenceRequirement?.requireReceipt).toBe(true);
      expect(scenario.evidenceRequirement?.tool).toBeDefined();
      expect(scenario.evidenceRequirement?.operation).toBeDefined();
      expect(scenario.evidenceRequirement?.command).toBeDefined();
    }
  });

  it('verifies complex multi-file scenarios contain 3 or more changed files', () => {
    const multiFileScenarios = getScenariosByCategory('multi_file');
    expect(multiFileScenarios.length).toBeGreaterThanOrEqual(2);

    const refactorScenario = getScenarioById('multifile-auth-refactor');
    expect(refactorScenario).toBeDefined();
    expect(refactorScenario?.diffFiles.length).toBe(5);
  });

  it('verifies alias functions operate identically to primary accessors', () => {
    const s1 = getScenarioById('elixir-ecto-unscoped-tenant-query');
    const s2 = getEvaluationScenario('elixir-ecto-unscoped-tenant-query');
    expect(s1).toEqual(s2);

    const cat1 = getScenariosByCategory('database');
    const cat2 = filterScenariosByCategory('database');
    expect(cat1).toEqual(cat2);

    const list1 = getAllScenarios();
    const list2 = listEvaluationScenarios();
    expect(list1).toEqual(list2);
  });

  it('verifies domain coverage across all target technical domains', () => {
    const all = getAllScenarios();

    // Domain 1: Elixir & Phoenix / OTP (10 scenarios)
    const elixir = all.filter((s) => s.id.startsWith('elixir-'));
    expect(elixir.length).toBe(10);

    // Domain 2: Go Concurrency & Systems (10 scenarios)
    const go = all.filter((s) => s.id.startsWith('go-'));
    expect(go.length).toBe(10);

    // Domain 3: TypeScript & Node.js (9 scenarios)
    const ts = all.filter((s) => s.id.startsWith('ts-'));
    expect(ts.length).toBe(9);

    // Domain 4: PostgreSQL & Database (≥6 scenarios)
    const pg = all.filter((s) => s.id.startsWith('db-'));
    expect(pg.length).toBeGreaterThanOrEqual(6);

    // Domain 5: Architecture & Supply Chain (≥6 scenarios)
    const archSupply = all.filter((s) => s.id.startsWith('arch-') || s.id.startsWith('dep-'));
    expect(archSupply.length).toBeGreaterThanOrEqual(6);

    // Domain 6: Adversarial & Tool-Calling (14 scenarios)
    const adv = all.filter((s) => s.id.startsWith('adv-'));
    expect(adv.length).toBe(14);

    // Domain 7: Distributed Concurrency (3 scenarios)
    const conc = all.filter((s) => s.id.startsWith('conc-'));
    expect(conc.length).toBe(3);

    // Domain 8: Security & Guard Isolation (11 scenarios)
    const sec = all.filter((s) => s.id.startsWith('sec-'));
    expect(sec.length).toBe(11);

    // Domain 9: Multi-Turn Evidence Chaining (8 scenarios)
    const chain = all.filter((s) => s.id.startsWith('chain-'));
    expect(chain.length).toBe(8);

    // Domain 10: Generic Telecom Call Engine Benchmark Expansion (96 scenarios)
    const telecom = all.filter((s) => s.id.startsWith('telecom-'));
    expect(telecom.length).toBe(96);

    // Archetype 1: Needle-in-a-Haystack Refactor Diffs (24 scenarios)
    const haystack = all.filter((s) => s.id.startsWith('telecom-haystack-'));
    expect(haystack.length).toBe(24);

    // Archetype 2: Cross-Module Architectural Breakages (24 scenarios)
    const cross = all.filter((s) => s.id.startsWith('telecom-cross-'));
    expect(cross.length).toBe(24);

    // Archetype 3: High-Concurrency Distributed Race Conditions (24 scenarios)
    const races = all.filter((s) => s.id.startsWith('telecom-race-'));
    expect(races.length).toBe(24);

    // Archetype 4: False Positive & Hallucination Trap PRs (24 scenarios)
    const traps = all.filter((s) => s.id.startsWith('telecom-trap-'));
    expect(traps.length).toBe(24);
    for (const trap of traps) {
      expect(trap.expectedVerdict).toBe('SHIP');
      expect(trap.expectedFindings.length).toBe(0);
    }

    // Verify all telecom scenarios mount the telecom workspaceRoot
    for (const ts of telecom) {
      expect(ts.workspaceRoot).toBe('tests/fixtures/workspaces/telecom-call-engine');
      expect(ts.prContext.prNumber).toBeGreaterThanOrEqual(2101);
      expect(ts.prContext.prNumber).toBeLessThanOrEqual(2196);
    }
  });

  it('allows lookups by PR number string', () => {
    const pr2101 = getScenarioById('2101');
    expect(pr2101).toBeDefined();
    expect(pr2101?.id).toBe('telecom-haystack-sip-dropped-tenant');

    const pr2196 = getScenarioById('2196');
    expect(pr2196).toBeDefined();
    expect(pr2196?.id).toBe('telecom-trap-sip-dialog-route-set-inversion-ship');
  });
});


