import { describe, expect, it } from 'vitest';
import { getFormatter, JSONFormatter, OKFFormatter, MarkdownFormatter, TableFormatter, formatOutput } from '../../src/analytics/formatters';
import { SessionRecord, SessionKPIs, SessionDetail } from '../../src/analytics/types';

describe('formatters Unit Tests', () => {
  const sampleSessions: SessionRecord[] = [
    {
      id: 'owner/repo#1',
      owner: 'owner',
      repo: 'repo',
      prNumber: 1,
      title: 'Fix issue',
      branch: 'main',
      totalTurns: 2,
      maxTurns: 10,
      createdAt: '2026-07-31T10:00:00Z',
      updatedAt: '2026-07-31T11:00:00Z',
      lastVerdict: 'SHIP',
      costUSD: 0.04,
      latencyMs: 1200,
      tokens: { prompt: 100, completion: 50, total: 150 },
      findings: [],
    },
  ];

  const sampleKPIs: SessionKPIs = {
    totalSessions: 1,
    totalTurns: 2,
    avgTurnsPerSession: 2,
    verdictCounts: { SHIP: 1 },
    passRatePercent: 100,
    totalFindings: { p0: 0, p1: 0, p2: 0, total: 0 },
    totalCostUSD: 0.04,
    totalTokens: { prompt: 100, completion: 50, total: 150 },
    avgDurationMs: 1200,
    turnBudgetUtilizationPercent: 20,
    findingsResolutionRatePercent: 100,
  };

  const sampleDetail: SessionDetail = {
    ...sampleSessions[0],
    history: [
      {
        turn: 1,
        headSha: 'abc',
        timestamp: '2026-07-31T10:00:00Z',
        verdict: 'SHIP',
        findingsCount: 0,
      },
    ],
    turns: [],
  };

  it('getFormatter returns the correct formatter instance', () => {
    expect(getFormatter('json')).toBeInstanceOf(JSONFormatter);
    expect(getFormatter('okf')).toBeInstanceOf(OKFFormatter);
    expect(getFormatter('markdown')).toBeInstanceOf(MarkdownFormatter);
    expect(getFormatter('table')).toBeInstanceOf(TableFormatter);
  });

  it('JSONFormatter formats sessions, kpis, and detail as pretty JSON', () => {
    const formatter = new JSONFormatter();

    const jsonSessions = formatter.formatSessions(sampleSessions);
    expect(JSON.parse(jsonSessions)).toHaveProperty('sessions');

    const jsonKPIs = formatter.formatKPIs(sampleKPIs);
    expect(JSON.parse(jsonKPIs)).toHaveProperty('kpis');

    const jsonDetail = formatter.formatDetail(sampleDetail);
    expect(JSON.parse(jsonDetail)).toHaveProperty('session');
  });

  it('OKFFormatter formats outputs in Open Knowledge Format with OKF banners', () => {
    const formatter = new OKFFormatter();

    const okfSessions = formatter.formatSessions(sampleSessions);
    expect(okfSessions).toContain('=== OKF: SESSION ANALYTICS LIST ===');
    expect(okfSessions).toContain('meta.total_records: 1');

    const okfKPIs = formatter.formatKPIs(sampleKPIs);
    expect(okfKPIs).toContain('=== OKF: SESSION KEY PERFORMANCE INDICATORS ===');
    expect(okfKPIs).toContain('kpi.pass_rate_percent: 100%');

    const okfDetail = formatter.formatDetail(sampleDetail);
    expect(okfDetail).toContain('=== OKF: SESSION DETAIL ===');
    expect(okfDetail).toContain('session.id: "owner/repo#1"');
  });

  it('MarkdownFormatter renders GFM markdown tables and sections', () => {
    const formatter = new MarkdownFormatter();

    const mdSessions = formatter.formatSessions(sampleSessions);
    expect(mdSessions).toContain('# 📋 Review Sessions (1)');
    expect(mdSessions).toContain('| Session ID | Title | Verdict |');

    const mdKPIs = formatter.formatKPIs(sampleKPIs);
    expect(mdKPIs).toContain('# 📊 Session Analytics KPIs');
    expect(mdKPIs).toContain('| **Total Sessions** | 1 |');

    const mdDetail = formatter.formatDetail(sampleDetail);
    expect(mdDetail).toContain('# 🔍 Session Detail: `owner/repo#1`');
  });

  it('TableFormatter renders ASCII tables', () => {
    const formatter = new TableFormatter();

    const tableSessions = formatter.formatSessions(sampleSessions);
    expect(tableSessions).toContain('ID');
    expect(tableSessions).toContain('VERDICT');
    expect(tableSessions).toContain('TURNS');
    expect(tableSessions).toContain('owner/repo#1');

    const tableKPIs = formatter.formatKPIs(sampleKPIs);
    expect(tableKPIs).toContain('=== SESSION ANALYTICS KPI SUMMARY ===');
    expect(tableKPIs).toContain('Total Sessions');
  });

  it('formatOutput helper invokes selected format correctly', () => {
    const out = formatOutput({ sessions: sampleSessions }, { format: 'json' });
    expect(JSON.parse(out)).toHaveProperty('sessions');
  });
});
