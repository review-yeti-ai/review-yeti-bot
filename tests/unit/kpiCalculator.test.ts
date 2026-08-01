import { describe, expect, it } from 'vitest';
import { calculateKPIs, computeFindingsDelta } from '../../src/analytics/kpiCalculator';
import { SessionRecord, SessionFinding } from '../../src/analytics/types';

describe('kpiCalculator Unit Tests', () => {
  it('calculateKPIs returns 0 defaults when sessions list is empty', () => {
    const kpis = calculateKPIs([]);
    expect(kpis.totalSessions).toBe(0);
    expect(kpis.totalTurns).toBe(0);
    expect(kpis.avgTurnsPerSession).toBe(0);
    expect(kpis.passRatePercent).toBe(0);
    expect(kpis.totalCostUSD).toBe(0);
    expect(kpis.findingsResolutionRatePercent).toBe(100);
  });

  it('calculateKPIs aggregates metrics correctly across multiple sessions', () => {
    const mockSessions: SessionRecord[] = [
      {
        id: 'owner/repo#1',
        owner: 'owner',
        repo: 'repo',
        prNumber: 1,
        title: 'PR 1',
        branch: 'feat/1',
        totalTurns: 2,
        maxTurns: 10,
        createdAt: '2026-07-01T10:00:00Z',
        updatedAt: '2026-07-01T10:30:00Z',
        lastVerdict: 'SHIP',
        costUSD: 0.05,
        latencyMs: 1000,
        tokens: { prompt: 100, completion: 50, total: 150 },
        findings: [
          { severity: 'P0', title: 'Critical Issue', path: 'src/main.ts' },
          { severity: 'P2', title: 'Formatting Nit', path: 'src/util.ts' },
        ],
        findingsDelta: {
          initialFindings: 3,
          latestFindings: 2,
          resolvedFindings: 2,
          newFindings: 1,
          persistentFindings: 1,
          netChange: -1,
        },
      },
      {
        id: 'owner/repo#2',
        owner: 'owner',
        repo: 'repo',
        prNumber: 2,
        title: 'PR 2',
        branch: 'feat/2',
        totalTurns: 4,
        maxTurns: 10,
        createdAt: '2026-07-02T10:00:00Z',
        updatedAt: '2026-07-02T10:30:00Z',
        lastVerdict: 'NACK',
        costUSD: 0.15,
        latencyMs: 3000,
        tokens: { prompt: 300, completion: 150, total: 450 },
        findings: [{ severity: 'P1', title: 'Security Risk', path: 'src/auth.ts' }],
        findingsDelta: {
          initialFindings: 2,
          latestFindings: 1,
          resolvedFindings: 1,
          newFindings: 0,
          persistentFindings: 1,
          netChange: -1,
        },
      },
    ];

    const kpis = calculateKPIs(mockSessions);

    expect(kpis.totalSessions).toBe(2);
    expect(kpis.totalTurns).toBe(6);
    expect(kpis.avgTurnsPerSession).toBe(3);
    expect(kpis.verdictCounts['SHIP']).toBe(1);
    expect(kpis.verdictCounts['NACK']).toBe(1);
    expect(kpis.passRatePercent).toBe(50);
    expect(kpis.totalCostUSD).toBe(0.2);
    expect(kpis.totalTokens.prompt).toBe(400);
    expect(kpis.totalTokens.completion).toBe(200);
    expect(kpis.totalTokens.total).toBe(600);
    expect(kpis.avgDurationMs).toBe(2000);
    expect(kpis.turnBudgetUtilizationPercent).toBe(30); // (20% + 40%)/2 = 30%
    // 3 resolved out of 5 initial findings = 60%
    expect(kpis.findingsResolutionRatePercent).toBe(60);
  });

  it('computeFindingsDelta accurately identifies resolved, new, and persistent findings', () => {
    const initial: SessionFinding[] = [
      { severity: 'P0', title: 'Unused Variable', path: 'src/a.ts', line: 10 },
      { severity: 'P1', title: 'Missing Error Handling', path: 'src/b.ts', line: 20 },
    ];

    const latest: SessionFinding[] = [
      { severity: 'P1', title: 'Missing Error Handling', path: 'src/b.ts', line: 20 }, // persistent
      { severity: 'P2', title: 'Typo in Comment', path: 'src/c.ts', line: 5 }, // new
    ];

    const delta = computeFindingsDelta(initial, latest);

    expect(delta.initialFindings).toBe(2);
    expect(delta.latestFindings).toBe(2);
    expect(delta.resolvedFindings).toBe(1);
    expect(delta.newFindings).toBe(1);
    expect(delta.persistentFindings).toBe(1);
    expect(delta.netChange).toBe(0);
  });
});
