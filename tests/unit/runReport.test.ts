import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const rootRepoDir = fs.existsSync(path.join(path.resolve(__dirname, '../..'), 'src/telemetry/runReport.js'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');
const {
  RUN_REPORT_VERSION,
  buildRunReport,
  renderRunReportLine,
  writeRunReport,
  aggregateRunReports,
} = require(path.join(rootRepoDir, 'src/telemetry/runReport.js'));

const completedLane = {
  personaId: 'security',
  decision: 'FINDINGS',
  provider: 'fireworks-direct',
  model: 'accounts/fireworks/models/deepseek-v4-flash-0731',
  turnCount: 2,
  usage: { promptTokens: 1000, completionTokens: 200, costUSD: 0.0021 },
  findings: [
    { severity: 'P1', file: 'lib/auth.ex', title: 'Token check bypass' },
    { severity: 'P2', file: 'lib/util.ex', title: 'Nit' },
  ],
};

const failedLane = {
  personaId: 'testing',
  decision: 'ERROR',
  error: 'incomplete_unit_plan',
  findings: [],
};

function report(overrides: Record<string, unknown> = {}) {
  return buildRunReport({
    repository: 'calltelemetry/cisco-cdr',
    prNumber: 4337,
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    diffText: 'diff --git a/lib/auth.ex b/lib/auth.ex\n+guard',
    verdict: 'FIX_FIRST',
    coverageStatus: 'complete',
    personaResults: [completedLane, failedLane],
    transports: [{ name: 'fireworks' }, { name: 'ollama' }],
    investigation: { enabled: true, complete: true },
    startedAt: 1000,
    finishedAt: 61000,
    ...overrides,
  });
}

describe('buildRunReport', () => {
  it('captures per-lane outcome, failure class, severity, and identity', () => {
    const built = report();
    expect(built.schemaVersion).toBe(RUN_REPORT_VERSION);
    expect(built.verdict).toBe('FIX_FIRST');
    expect(built.laneCount).toBe(2);
    expect(built.failedLaneCount).toBe(1);
    expect(built.durationMs).toBe(60000);
    expect(built.transports).toEqual(['fireworks', 'ollama']);
    const security = built.lanes.find((lane: any) => lane.persona === 'security');
    expect(security.severity).toEqual({ P0: 0, P1: 1, P2: 1 });
    expect(security.usage).toEqual({ promptTokens: 1000, completionTokens: 200, costUSD: 0.0021 });
    expect(security.failureClass).toBeUndefined();
    const testing = built.lanes.find((lane: any) => lane.persona === 'testing');
    expect(testing.failureClass).toBe('incomplete_unit_plan');
    expect(testing.findingCount).toBe(0);
  });

  it('produces a stable diff digest so re-rolls of the same diff group together', () => {
    const first = report({ headSha: 'c'.repeat(40) });
    const second = report({ headSha: 'd'.repeat(40) });
    expect(first.diffDigest).toBe(second.diffDigest);
    expect(report({ diffText: 'different' }).diffDigest).not.toBe(first.diffDigest);
  });

  it('counts cross-persona overlap only when distinct personas cite one file', () => {
    const overlapping = report({
      personaResults: [
        { personaId: 'security', decision: 'FINDINGS', findings: [{ severity: 'P1', file: 'lib/a.ex', title: 'x' }] },
        { personaId: 'performance', decision: 'FINDINGS', findings: [{ severity: 'P2', file: 'lib/a.ex', title: 'y' }] },
        { personaId: 'testing', decision: 'FINDINGS', findings: [{ severity: 'P2', file: 'lib/b.ex', title: 'z' }] },
      ],
    });
    expect(overlapping.flaggedFileCount).toBe(2);
    expect(overlapping.overlapFileCount).toBe(1);
  });

  it('tolerates empty and malformed inputs without throwing', () => {
    const empty = buildRunReport({});
    expect(empty.schemaVersion).toBe(RUN_REPORT_VERSION);
    expect(empty.laneCount).toBe(0);
    expect(empty.investigation).toEqual({ enabled: false, complete: false });
  });
});

describe('renderRunReportLine', () => {
  it('emits a harvestable prefixed single line', () => {
    const line = renderRunReportLine(report());
    expect(line.startsWith('[RunReport] {')).toBe(true);
    expect(line.includes('\n')).toBe(false);
    expect(JSON.parse(line.slice('[RunReport] '.length)).verdict).toBe('FIX_FIRST');
  });

  it('drops lane findings rather than exceeding the log-line cap', () => {
    const noisy = report({
      personaResults: Array.from({ length: 12 }, (_, index) => ({
        personaId: `persona-${index}`,
        decision: 'FINDINGS',
        findings: Array.from({ length: 50 }, (_, findingIndex) => ({
          severity: 'P2',
          file: `lib/${'x'.repeat(280)}-${findingIndex}.ex`,
          title: 't'.repeat(200),
        })),
      })),
    });
    const line = renderRunReportLine(noisy);
    expect(line.length).toBeLessThanOrEqual(60_000);
    const parsed = JSON.parse(line.slice('[RunReport] '.length));
    expect(parsed.lanes.every((lane: any) => lane.findings.length === 0)).toBe(true);
    expect(parsed.lanes[0].findingCount).toBe(50);
  });
});

describe('writeRunReport', () => {
  it('writes pretty JSON to the requested path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-report-'));
    const target = path.join(dir, 'report.json');
    expect(writeRunReport(report(), target)).toBe(target);
    const parsed = JSON.parse(fs.readFileSync(target, 'utf-8'));
    expect(parsed.schemaVersion).toBe(RUN_REPORT_VERSION);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('aggregateRunReports', () => {
  it('computes flake rate, failure classes, and re-roll variance', () => {
    const ship = report({ verdict: 'SHIP', personaResults: [completedLane, { ...failedLane, decision: 'FINDINGS', error: undefined }] });
    const block = report({ verdict: 'BLOCK' });
    const summary = aggregateRunReports([ship, block, { schemaVersion: 'other' }]);
    expect(summary.reportCount).toBe(2);
    const testing = summary.personas.find((persona: any) => persona.persona === 'testing');
    expect(testing.runs).toBe(2);
    expect(testing.failed).toBe(1);
    expect(testing.failureRate).toBe(0.5);
    expect(testing.failureClasses).toEqual({ incomplete_unit_plan: 1 });
    expect(summary.verdicts).toEqual({ SHIP: 1, BLOCK: 1 });
    // Same diffDigest with SHIP vs BLOCK — the exact noise signal we track.
    expect(summary.rerolls.groups).toBe(1);
    expect(summary.rerolls.inconsistentVerdictGroups).toBe(1);
  });

  it('returns an empty summary for no valid reports', () => {
    const summary = aggregateRunReports([]);
    expect(summary.reportCount).toBe(0);
    expect(summary.personas).toEqual([]);
    expect(summary.rerolls).toEqual({ groups: 0, inconsistentVerdictGroups: 0 });
  });
});
