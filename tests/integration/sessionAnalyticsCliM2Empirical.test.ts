import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { runCLI, parseCLIArgs, generateHelpText } from '../../src/analytics/cliParser';
import { SessionRepository } from '../../src/analytics/sessionRepository';
import { calculateKPIs, computeFindingsDelta } from '../../src/analytics/kpiCalculator';
import { JSONFormatter } from '../../src/analytics/formatters/jsonFormatter';
import { OKFFormatter } from '../../src/analytics/formatters/okfFormatter';
import { MarkdownFormatter } from '../../src/analytics/formatters/markdownFormatter';
import { TableFormatter } from '../../src/analytics/formatters/tableFormatter';
import { SessionRecord, SessionDetail, SessionKPIs } from '../../src/analytics/types';

describe('M2: R1 Session Analytics CLI Formatters & Metrics Empirical Harness', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-m2-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // Helper to construct disk session with multi-turn history
  function createDiskSession(
    owner: string,
    repo: string,
    prNumber: number,
    metadata: any,
    turnsData: any[]
  ) {
    const sessionDir = path.join(tempDir, owner.toLowerCase(), repo.toLowerCase(), `pr-${prNumber}`);
    fs.mkdirSync(sessionDir, { recursive: true });

    fs.writeFileSync(path.join(sessionDir, 'metadata.json'), JSON.stringify(metadata, null, 2));

    turnsData.forEach((turn, idx) => {
      const turnNum = turn.currentTurn || idx + 1;
      fs.writeFileSync(
        path.join(sessionDir, `turn-${turnNum}.json`),
        JSON.stringify(turn, null, 2)
      );
    });
  }

  describe('1. Findings Delta & KPI Calculation Empirical Ground Truth', () => {
    it('computes computeFindingsDelta accurately with key deduplication and tracking', () => {
      const initial = [
        { severity: 'P0', title: 'SQL Injection', path: 'src/db.ts', line: 10, persona: 'security' },
        { severity: 'P1', title: 'Unused Var', path: 'src/util.ts', line: 20, persona: 'linter' },
        { severity: 'P2', title: 'Missing Comment', path: 'src/util.ts', line: 1, persona: 'docs' },
      ];

      const latest = [
        { severity: 'P1', title: 'Unused Var', path: 'src/util.ts', line: 20, persona: 'linter' }, // persistent
        { severity: 'P0', title: 'Buffer Overflow', path: 'src/net.ts', line: 55, persona: 'security' }, // new
      ];

      const delta = computeFindingsDelta(initial, latest);

      expect(delta.initialFindings).toBe(3);
      expect(delta.latestFindings).toBe(2);
      expect(delta.persistentFindings).toBe(1);
      expect(delta.resolvedFindings).toBe(2); // SQL Injection & Missing Comment resolved
      expect(delta.newFindings).toBe(1); // Buffer Overflow new
      expect(delta.netChange).toBe(-1); // 2 - 3 = -1
    });

    it('calculates aggregate SessionKPIs accurately across multi-turn session dataset', () => {
      // Create Session 1: SHIP, 3 turns
      createDiskSession(
        'cisco-cdr',
        'ct-review-bot',
        101,
        {
          title: 'Add feature "auth"',
          branch: 'feat/auth',
          lastVerdict: 'SHIP',
          totalTurns: 3,
          maxTurns: 10,
          createdAt: '2026-07-01T10:00:00Z',
          updatedAt: '2026-07-01T10:30:00Z',
        },
        [
          {
            currentTurn: 1,
            headSha: 'sha111',
            recordedAt: '2026-07-01T10:00:00Z',
            costUSD: 0.005,
            durationMs: 500,
            tokens: { prompt: 500, completion: 200, total: 700 },
            arbitration: { verdict: 'NACK', rationale: 'Issues found', metrics: { p0Count: 1, p1Count: 1, p2Count: 0 } },
            personaResults: [
              {
                id: 'p1',
                displayName: 'Security',
                decision: 'NACK',
                findings: [
                  { severity: 'P0', title: 'SQL Injection', path: 'src/db.ts', line: 10 },
                  { severity: 'P1', title: 'Unused Var', path: 'src/util.ts', line: 20 },
                ],
              },
            ],
          },
          {
            currentTurn: 2,
            headSha: 'sha222',
            recordedAt: '2026-07-01T10:15:00Z',
            costUSD: 0.005,
            durationMs: 500,
            tokens: { prompt: 500, completion: 200, total: 700 },
            arbitration: { verdict: 'COMMENT', rationale: 'Progress made', metrics: { p0Count: 0, p1Count: 1, p2Count: 0 } },
            personaResults: [
              {
                id: 'p1',
                displayName: 'Security',
                decision: 'COMMENT',
                findings: [{ severity: 'P1', title: 'Unused Var', path: 'src/util.ts', line: 20 }],
              },
            ],
          },
          {
            currentTurn: 3,
            headSha: 'sha333',
            recordedAt: '2026-07-01T10:30:00Z',
            costUSD: 0.005,
            durationMs: 500,
            tokens: { prompt: 500, completion: 200, total: 700 },
            arbitration: { verdict: 'SHIP', rationale: 'All clear', metrics: { p0Count: 0, p1Count: 0, p2Count: 0 } },
            personaResults: [
              {
                id: 'p1',
                displayName: 'Security',
                decision: 'SHIP',
                findings: [],
              },
            ],
          },
        ]
      );

      // Create Session 2: NACK, 2 turns
      createDiskSession(
        'cisco-cdr',
        'ct-review-bot',
        102,
        {
          title: 'Fix issue | table pipe',
          branch: 'fix/pipe',
          lastVerdict: 'NACK',
          totalTurns: 2,
          maxTurns: 20,
          createdAt: '2026-07-02T10:00:00Z',
          updatedAt: '2026-07-02T10:20:00Z',
        },
        [
          {
            currentTurn: 1,
            headSha: 'sha444',
            costUSD: 0.01,
            durationMs: 1000,
            tokens: { prompt: 1000, completion: 500, total: 1500 },
            arbitration: { verdict: 'NACK', rationale: 'P0', metrics: { p0Count: 1, p1Count: 0, p2Count: 0 } },
            personaResults: [
              {
                id: 'p1',
                displayName: 'Sec',
                decision: 'NACK',
                findings: [{ severity: 'P0', title: 'Hardcoded Secret', path: 'config.ts', line: 5 }],
              },
            ],
          },
          {
            currentTurn: 2,
            headSha: 'sha555',
            costUSD: 0.015,
            durationMs: 1500,
            tokens: { prompt: 1000, completion: 500, total: 1500 },
            arbitration: { verdict: 'NACK', rationale: 'Still P0', metrics: { p0Count: 1, p1Count: 1, p2Count: 0 } },
            personaResults: [
              {
                id: 'p1',
                displayName: 'Sec',
                decision: 'NACK',
                findings: [
                  { severity: 'P0', title: 'Hardcoded Secret', path: 'config.ts', line: 5 },
                  { severity: 'P1', title: 'Missing check', path: 'api.ts', line: 99 },
                ],
              },
            ],
          },
        ]
      );

      // Create Session 3: APPROVE (counts as pass), 1 turn
      createDiskSession(
        'cisco-cdr',
        'other-repo',
        5,
        {
          title: 'Clean docs',
          branch: 'docs/clean',
          lastVerdict: 'APPROVE',
          totalTurns: 1,
          maxTurns: 5,
          createdAt: '2026-07-03T10:00:00Z',
          updatedAt: '2026-07-03T10:05:00Z',
        },
        [
          {
            currentTurn: 1,
            headSha: 'sha666',
            costUSD: 0.005,
            durationMs: 500,
            tokens: { prompt: 500, completion: 100, total: 600 },
            arbitration: { verdict: 'APPROVE', rationale: 'Looks good', metrics: { p0Count: 0, p1Count: 0, p2Count: 1 } },
            personaResults: [
              {
                id: 'p2',
                displayName: 'Docs',
                decision: 'APPROVE',
                findings: [{ severity: 'P2', title: 'Typo in readme', path: 'README.md', line: 12 }],
              },
            ],
          },
        ]
      );

      const repo = new SessionRepository(tempDir);
      const sessions = repo.getSessions();
      expect(sessions.length).toBe(3);

      const kpis = calculateKPIs(sessions);

      expect(kpis.totalSessions).toBe(3);
      expect(kpis.totalTurns).toBe(6); // 3 + 2 + 1 = 6
      expect(kpis.avgTurnsPerSession).toBe(2.00);

      // Verdict counts: SHIP=1, NACK=1, APPROVE=1
      expect(kpis.verdictCounts.SHIP).toBe(1);
      expect(kpis.verdictCounts.NACK).toBe(1);
      expect(kpis.verdictCounts.APPROVE).toBe(1);

      // Pass rate: SHIP + APPROVE = 2 of 3 = 66.67%
      expect(kpis.passRatePercent).toBe(66.67);

      // Active Findings in latest turns:
      // Session 1: 0
      // Session 2: 1 P0, 1 P1
      // Session 3: 1 P2
      expect(kpis.totalFindings.p0).toBe(1);
      expect(kpis.totalFindings.p1).toBe(1);
      expect(kpis.totalFindings.p2).toBe(1);
      expect(kpis.totalFindings.total).toBe(3);

      // Total Cost USD: (0.005*3) + (0.01+0.015) + 0.005 = 0.015 + 0.025 + 0.005 = 0.045
      expect(kpis.totalCostUSD).toBe(0.045);

      // Total Tokens:
      // S1: 700*3 = 2100 (prompt=1500, completion=600)
      // S2: 1500+1500 = 3000 (prompt=2000, completion=1000)
      // S3: 600 (prompt=500, completion=100)
      // Sum: prompt=4000, completion=1700, total=5700
      expect(kpis.totalTokens.prompt).toBe(4000);
      expect(kpis.totalTokens.completion).toBe(1700);
      expect(kpis.totalTokens.total).toBe(5700);

      // Avg Duration Ms: (1500 + 2500 + 500) / 3 = 4500 / 3 = 1500 ms
      expect(kpis.avgDurationMs).toBe(1500);

      // Turn Budget Utilization:
      // S1: 3 / 10 = 30%
      // S2: 2 / 20 = 10%
      // S3: 1 / 5 = 20%
      // Avg: (30 + 10 + 20) / 3 = 20.00%
      expect(kpis.turnBudgetUtilizationPercent).toBe(20.00);

      // Findings Resolution Rate:
      // S1 initial: 2 findings, resolved: 2
      // S2 initial: 1 finding, resolved: 0
      // S3 initial: 1 finding, resolved: 0
      // Total initial: 4, Total resolved: 2 -> (2 / 4) * 100 = 50.00%
      expect(kpis.findingsResolutionRatePercent).toBe(50.00);
    });
  });

  describe('2. Formatter Validation (JSON, OKF, Markdown, Table)', () => {
    let sampleSessions: SessionRecord[];
    let sampleKPIs: SessionKPIs;
    let sampleDetail: SessionDetail;

    beforeEach(() => {
      createDiskSession(
        'cisco-cdr',
        'ct-review-bot',
        42,
        {
          title: 'Review "Fix | issue"',
          branch: 'feat/test',
          lastVerdict: 'SHIP',
          totalTurns: 2,
          maxTurns: 10,
          createdAt: '2026-07-01T10:00:00Z',
          updatedAt: '2026-07-01T10:30:00Z',
        },
        [
          {
            currentTurn: 1,
            headSha: 'abc1234567',
            costUSD: 0.01,
            durationMs: 1000,
            tokens: { prompt: 1000, completion: 500, total: 1500 },
            arbitration: { verdict: 'NACK', rationale: 'Bug', metrics: { p0Count: 1, p1Count: 0, p2Count: 0 } },
            personaResults: [
              {
                id: 'sec',
                displayName: 'Security Arbiter',
                decision: 'NACK',
                findings: [{ severity: 'P0', title: 'Crit bug', path: 'src/app.ts', line: 42 }],
              },
            ],
          },
          {
            currentTurn: 2,
            headSha: 'def9876543',
            costUSD: 0.01,
            durationMs: 1000,
            tokens: { prompt: 1000, completion: 500, total: 1500 },
            arbitration: { verdict: 'SHIP', rationale: 'Fixed', metrics: { p0Count: 0, p1Count: 0, p2Count: 0 } },
            personaResults: [
              {
                id: 'sec',
                displayName: 'Security Arbiter',
                decision: 'SHIP',
                findings: [],
              },
            ],
          },
        ]
      );

      const repo = new SessionRepository(tempDir);
      sampleSessions = repo.getSessions();
      sampleKPIs = calculateKPIs(sampleSessions);
      sampleDetail = repo.getSessionById('cisco-cdr/ct-review-bot#42')!;
    });

    it('JSONFormatter produces valid JSON for sessions, kpis, and detail', () => {
      const formatter = new JSONFormatter();

      const sessionsJson = formatter.formatSessions(sampleSessions);
      const parsedSessions = JSON.parse(sessionsJson);
      expect(parsedSessions).toHaveProperty('sessions');
      expect(Array.isArray(parsedSessions.sessions)).toBe(true);
      expect(parsedSessions.sessions[0].id).toBe('cisco-cdr/ct-review-bot#42');

      const kpisJson = formatter.formatKPIs(sampleKPIs);
      const parsedKPIs = JSON.parse(kpisJson);
      expect(parsedKPIs).toHaveProperty('kpis');
      expect(parsedKPIs.kpis.totalSessions).toBe(1);
      expect(parsedKPIs.kpis.passRatePercent).toBe(100);

      const detailJson = formatter.formatDetail(sampleDetail);
      const parsedDetail = JSON.parse(detailJson);
      expect(parsedDetail).toHaveProperty('session');
      expect(parsedDetail.session.id).toBe('cisco-cdr/ct-review-bot#42');
      expect(parsedDetail.session.history.length).toBe(2);
    });

    it('OKFFormatter produces structured OKF blocks with meta boundaries', () => {
      const formatter = new OKFFormatter();

      const sessionsOkf = formatter.formatSessions(sampleSessions);
      expect(sessionsOkf).toContain('=== OKF: SESSION ANALYTICS LIST ===');
      expect(sessionsOkf).toContain('=== END OKF ===');
      expect(sessionsOkf).toContain('meta.total_records: 1');
      expect(sessionsOkf).toContain('id: "cisco-cdr/ct-review-bot#42"');

      const kpisOkf = formatter.formatKPIs(sampleKPIs);
      expect(kpisOkf).toContain('=== OKF: SESSION KEY PERFORMANCE INDICATORS ===');
      expect(kpisOkf).toContain('=== END OKF ===');
      expect(kpisOkf).toContain('kpi.total_sessions: 1');
      expect(kpisOkf).toContain('kpi.pass_rate_percent: 100%');

      const detailOkf = formatter.formatDetail(sampleDetail);
      expect(detailOkf).toContain('=== OKF: SESSION DETAIL ===');
      expect(detailOkf).toContain('=== END OKF ===');
      expect(detailOkf).toContain('session.id: "cisco-cdr/ct-review-bot#42"');
      expect(detailOkf).toContain('session.findings_delta:');
      expect(detailOkf).toContain('resolved: 1');
    });

    it('MarkdownFormatter produces clean tables and escapes pipe characters', () => {
      const formatter = new MarkdownFormatter();

      const sessionsMd = formatter.formatSessions(sampleSessions);
      expect(sessionsMd).toContain('# 📋 Review Sessions (1)');
      expect(sessionsMd).toContain('| Session ID | Title | Verdict | Turns | Cost (USD) | Tokens | Updated |');
      expect(sessionsMd).toContain('| --- | --- | --- | --- | --- | --- | --- |');
      // Title "Review \"Fix | issue\"" should escape pipe to \|
      expect(sessionsMd).toContain('Review "Fix \\| issue"');

      const kpisMd = formatter.formatKPIs(sampleKPIs);
      expect(kpisMd).toContain('# 📊 Session Analytics KPIs');
      expect(kpisMd).toContain('### 📈 Summary Metrics');
      expect(kpisMd).toContain('| **Pass Rate** | 100% |');

      const detailMd = formatter.formatDetail(sampleDetail);
      expect(detailMd).toContain('# 🔍 Session Detail: `cisco-cdr/ct-review-bot#42`');
      expect(detailMd).toContain('### 📉 Findings Delta Summary');
      expect(detailMd).toContain('### 🔄 Turn Execution Timeline');
    });

    it('TableFormatter produces aligned ASCII tables with uniform line widths', () => {
      const formatter = new TableFormatter();

      const sessionsTable = formatter.formatSessions(sampleSessions);
      const lines = sessionsTable.split('\n');
      expect(lines[0]).toContain('ID');
      expect(lines[0]).toContain('VERDICT');

      // Verify line width alignment across header, separator, and data rows
      const headerLen = lines[0].length;
      const separatorLen = lines[1].length;
      const dataRowLen = lines[2].length;

      expect(separatorLen).toBe(headerLen);
      expect(dataRowLen).toBe(headerLen);

      const kpisTable = formatter.formatKPIs(sampleKPIs);
      expect(kpisTable).toContain('=== SESSION ANALYTICS KPI SUMMARY ===');
      const kpiLines = kpisTable.split('\n').filter((l) => l.includes('|'));
      const kpiWidths = new Set(kpiLines.map((l) => l.length));
      expect(kpiWidths.size).toBe(1); // All table lines in KPI summary have identical length

      const detailTable = formatter.formatDetail(sampleDetail);
      expect(detailTable).toContain('=== SESSION DETAIL: cisco-cdr/ct-review-bot#42 ===');
      const detailTableLines = detailTable
        .slice(detailTable.indexOf('--- TURN TIMELINE ---'))
        .split('\n')
        .filter((l) => l.includes('|'));
      const detailWidths = new Set(detailTableLines.map((l) => l.length));
      expect(detailWidths.size).toBe(1);
    });
  });

  describe('3. CLI Parsing & Output File Execution', () => {
    it('executes runCLI for stats, list, inspect, search, help, and writes file output', () => {
      createDiskSession(
        'cisco-cdr',
        'ct-review-bot',
        1,
        { title: 'Feature PR', branch: 'feat', lastVerdict: 'SHIP', totalTurns: 1, maxTurns: 10 },
        [{ currentTurn: 1, headSha: 'sha1' }]
      );

      // Help command
      const helpResult = runCLI(['help']);
      expect(helpResult.exitCode).toBe(0);
      expect(helpResult.output).toContain('USAGE:');

      // Stats command with JSON format
      const statsResult = runCLI(['stats', '--dir', tempDir, '-f', 'json']);
      expect(statsResult.exitCode).toBe(0);
      const parsedStats = JSON.parse(statsResult.output);
      expect(parsedStats.kpis.totalSessions).toBe(1);

      // List command with Table format
      const listResult = runCLI(['list', '--dir', tempDir, '-f', 'table']);
      expect(listResult.exitCode).toBe(0);
      expect(listResult.output).toContain('cisco-cdr/ct-review-bot#1');

      // Inspect command with Markdown format
      const inspectResult = runCLI(['inspect', 'cisco-cdr/ct-review-bot#1', '--dir', tempDir, '-f', 'markdown']);
      expect(inspectResult.exitCode).toBe(0);
      expect(inspectResult.output).toContain('# 🔍 Session Detail: `cisco-cdr/ct-review-bot#1`');

      // Search command
      const searchResult = runCLI(['search', 'Feature', '--dir', tempDir, '-f', 'okf']);
      expect(searchResult.exitCode).toBe(0);
      expect(searchResult.output).toContain('=== OKF: SESSION ANALYTICS LIST ===');

      // File output flag (-o)
      const outFile = path.join(tempDir, 'output', 'report.okf');
      const outResult = runCLI(['stats', '--dir', tempDir, '-f', 'okf', '-o', outFile]);
      expect(outResult.exitCode).toBe(0);
      expect(outResult.outPath).toBe(outFile);
      expect(fs.existsSync(outFile)).toBe(true);
      expect(fs.readFileSync(outFile, 'utf-8')).toContain('=== OKF: SESSION KEY PERFORMANCE INDICATORS ===');

      // Error case: inspect without targetId
      const errInspect = runCLI(['inspect']);
      expect(errInspect.exitCode).toBe(1);
      expect(errInspect.output).toContain('Error: Session ID required for inspect command.');

      // Error case: inspect non-existent ID
      const missingInspect = runCLI(['inspect', 'non-existent-id', '--dir', tempDir]);
      expect(missingInspect.exitCode).toBe(1);
      expect(missingInspect.output).toContain('Error: Session not found for ID: non-existent-id');
    });
  });

  describe('4. Adversarial Edge Cases & Stress Tests', () => {
    it('handles empty session repository gracefully without NaN or division by zero', () => {
      const emptyDir = path.join(tempDir, 'empty');
      fs.mkdirSync(emptyDir);

      const repo = new SessionRepository(emptyDir);
      const sessions = repo.getSessions();
      expect(sessions.length).toBe(0);

      const kpis = calculateKPIs(sessions);
      expect(kpis.totalSessions).toBe(0);
      expect(kpis.totalTurns).toBe(0);
      expect(kpis.avgTurnsPerSession).toBe(0);
      expect(kpis.passRatePercent).toBe(0);
      expect(kpis.findingsResolutionRatePercent).toBe(100);

      const statsRes = runCLI(['stats', '--dir', emptyDir, '-f', 'json']);
      expect(statsRes.exitCode).toBe(0);
      const parsed = JSON.parse(statsRes.output);
      expect(parsed.kpis.totalSessions).toBe(0);

      const listRes = runCLI(['list', '--dir', emptyDir, '-f', 'table']);
      expect(listRes.exitCode).toBe(0);
      expect(listRes.output).toBe('No sessions found.');
    });

    it('correctly filters sessions by owner, repo, pr, verdict, minTurns, maxTurns, and query', () => {
      createDiskSession('ownerA', 'repoA', 1, { lastVerdict: 'SHIP', totalTurns: 2 }, [{ currentTurn: 1 }]);
      createDiskSession('ownerA', 'repoB', 2, { lastVerdict: 'NACK', totalTurns: 5 }, [{ currentTurn: 1 }]);
      createDiskSession('ownerB', 'repoC', 3, { lastVerdict: 'FIX_FIRST', totalTurns: 10 }, [{ currentTurn: 1 }]);

      const repo = new SessionRepository(tempDir);

      expect(repo.getSessions({ owner: 'ownerA' }).length).toBe(2);
      expect(repo.getSessions({ repo: 'repoB' }).length).toBe(1);
      expect(repo.getSessions({ prNumber: 3 }).length).toBe(1);
      expect(repo.getSessions({ verdict: 'SHIP' }).length).toBe(1);
      expect(repo.getSessions({ minTurns: 3 }).length).toBe(2);
      expect(repo.getSessions({ maxTurns: 4 }).length).toBe(1);
    });
  });
});
