import { describe, it, expect } from 'vitest';
import { handleSearchSessions } from '../../tools/mcp-session-analytics/src/tools/searchSessions.js';
import { handleGetSessionDetails } from '../../tools/mcp-session-analytics/src/tools/getSessionDetails.js';
import { handleGetSessionKpis } from '../../tools/mcp-session-analytics/src/tools/getSessionKpis.js';
import { buildToolRegistry } from '../../tools/mcp-session-analytics/src/server.js';

describe('mcp-session-analytics unit integration test in ct-review-bot', () => {
  const mockSessions = [
    {
      id: 'ct/review-bot#101',
      owner: 'ct',
      repo: 'review-bot',
      prNumber: 101,
      title: 'Add session analytics CLI',
      branch: 'feature/analytics',
      totalTurns: 3,
      maxTurns: 20,
      createdAt: '2026-07-31T00:00:00Z',
      updatedAt: '2026-07-31T01:00:00Z',
      lastVerdict: 'SHIP',
      status: 'completed',
      costUSD: 0.12,
      latencyMs: 1500,
      tokens: { prompt: 2000, completion: 1000, total: 3000 },
      findings: [],
      findingsDelta: {
        initialFindings: 3,
        latestFindings: 0,
        resolvedFindings: 3,
        newFindings: 0,
        persistentFindings: 0,
        netChange: -3,
      },
      history: [
        {
          turn: 1,
          headSha: 'sha1',
          timestamp: '2026-07-31T00:00:00Z',
          verdict: 'NACK',
          findingsCount: 3,
        },
        {
          turn: 3,
          headSha: 'sha3',
          timestamp: '2026-07-31T01:00:00Z',
          verdict: 'SHIP',
          findingsCount: 0,
        },
      ],
      turns: [],
    },
  ];

  const mockRepo = {
    getSessions: (filter?: any) => {
      let res = [...mockSessions];
      if (filter?.owner) res = res.filter((s) => s.owner === filter.owner);
      if (filter?.verdict) res = res.filter((s) => s.lastVerdict === filter.verdict);
      return res;
    },
    getSessionById: (id: string) => mockSessions.find((s) => s.id === id) || null,
  };

  it('verifies tool registry builds all 3 tools', () => {
    const registry = buildToolRegistry();
    expect(registry.size).toBe(3);
    expect(registry.has('search_sessions')).toBe(true);
    expect(registry.has('get_session_details')).toBe(true);
    expect(registry.has('get_session_kpis')).toBe(true);
  });

  it('executes search_sessions handler correctly', async () => {
    // handleSearchSessions is a plain-JS tool whose JSDoc typedef declares
    // getSessions/getSessionById as returning bare `object`, so its own
    // inferred return type loses the mock session shape; recover it here
    // rather than editing the tool's JSDoc (out of scope for this fix).
    const res = (await handleSearchSessions({ owner: 'ct' }, mockRepo)) as {
      total: number;
      sessions: (typeof mockSessions)[number][];
    };
    expect(res.total).toBe(1);
    expect(res.sessions[0].id).toBe('ct/review-bot#101');
  });

  it('executes get_session_details handler correctly', async () => {
    const res = (await handleGetSessionDetails({ sessionId: 'ct/review-bot#101' }, mockRepo)) as (typeof mockSessions)[number] & {
      turnBudgetUtilizationPercent: number;
      turnTimeline: unknown[];
    };
    expect(res.id).toBe('ct/review-bot#101');
    expect(res.turnBudgetUtilizationPercent).toBe(15);
    expect(res.turnTimeline.length).toBe(2);
  });

  it('executes get_session_kpis handler correctly', async () => {
    const res = await handleGetSessionKpis({ owner: 'ct' }, mockRepo);
    expect(res.totalSessions).toBe(1);
    expect(res.passRatePercent).toBe(100);
  });
});
