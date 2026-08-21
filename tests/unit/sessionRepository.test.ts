import fs from 'fs';
import path from 'path';
import os from 'os';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { SessionRepository } from '../../src/analytics/sessionRepository';
import { dashboardStore } from '../../src/persistence/dashboardStore';

describe('sessionRepository Unit Tests', () => {
  let tempDir: string;

  beforeEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.POSTGRES_URL;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-test-'));
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.POSTGRES_URL;
    vi.restoreAllMocks();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('loads sessions from disk session directory structure and index.json', () => {
    const sessionPath = path.join(tempDir, 'cisco-cdr', 'ct-review-bot', 'pr-101');
    fs.mkdirSync(sessionPath, { recursive: true });

    const metadata = {
      owner: 'cisco-cdr',
      repo: 'ct-review-bot',
      prNumber: '101',
      branch: 'feature/analytics',
      title: 'Add Session Analytics CLI',
      initialHeadSha: 'sha111',
      currentHeadSha: 'sha222',
      totalTurns: 2,
      maxTurns: 10,
      createdAt: '2026-07-31T10:00:00Z',
      updatedAt: '2026-07-31T11:00:00Z',
      lastVerdict: 'SHIP',
    };
    fs.writeFileSync(path.join(sessionPath, 'metadata.json'), JSON.stringify(metadata, null, 2));

    const turn1 = {
      owner: 'cisco-cdr',
      repo: 'ct-review-bot',
      prNumber: 101,
      headSha: 'sha111',
      currentTurn: 1,
      maxTurns: 10,
      arbitration: { verdict: 'NACK', rationale: 'Issues found', metrics: { p0Count: 1, p1Count: 0, p2Count: 0 } },
      personaResults: [
        { id: 'sec', displayName: 'Security', decision: 'NACK', findings: [{ severity: 'P0', title: 'Token leak', path: 'src/secret.ts', line: 12 }] },
      ],
      costUSD: 0.02,
      durationMs: 500,
    };
    fs.writeFileSync(path.join(sessionPath, 'turn-1.json'), JSON.stringify(turn1, null, 2));

    const turn2 = {
      owner: 'cisco-cdr',
      repo: 'ct-review-bot',
      prNumber: 101,
      headSha: 'sha222',
      currentTurn: 2,
      maxTurns: 10,
      arbitration: { verdict: 'SHIP', rationale: 'Resolved', metrics: { p0Count: 0, p1Count: 0, p2Count: 0 } },
      personaResults: [
        { id: 'sec', displayName: 'Security', decision: 'SHIP', findings: [] },
      ],
      costUSD: 0.03,
      durationMs: 400,
    };
    fs.writeFileSync(path.join(sessionPath, 'turn-2.json'), JSON.stringify(turn2, null, 2));

    const repo = new SessionRepository(tempDir);
    const sessions = repo.getSessions();

    expect(sessions.length).toBe(1);
    expect(sessions[0].id).toBe('cisco-cdr/ct-review-bot#101');
    expect(sessions[0].lastVerdict).toBe('SHIP');
    expect(sessions[0].totalTurns).toBe(2);
    expect(sessions[0].costUSD).toBe(0.05);
    expect(sessions[0].latencyMs).toBe(900);
    expect(sessions[0].findingsDelta?.resolvedFindings).toBe(1);

    const detail = repo.getSessionById('cisco-cdr/ct-review-bot#101');
    expect(detail).not.toBeNull();
    expect(detail?.turns.length).toBe(2);
    expect(detail?.history.length).toBe(2);
  });

  it('filters sessions by owner, repo, prNumber, verdict, and query', () => {
    const s1Path = path.join(tempDir, 'org-a', 'repo-x', 'pr-1');
    const s2Path = path.join(tempDir, 'org-b', 'repo-y', 'pr-2');
    fs.mkdirSync(s1Path, { recursive: true });
    fs.mkdirSync(s2Path, { recursive: true });

    fs.writeFileSync(
      path.join(s1Path, 'metadata.json'),
      JSON.stringify({
        owner: 'org-a',
        repo: 'repo-x',
        prNumber: '1',
        title: 'Fix authentication bug',
        branch: 'fix/auth',
        totalTurns: 1,
        maxTurns: 10,
        lastVerdict: 'SHIP',
        createdAt: '2026-07-01T10:00:00Z',
      })
    );

    fs.writeFileSync(
      path.join(s2Path, 'metadata.json'),
      JSON.stringify({
        owner: 'org-b',
        repo: 'repo-y',
        prNumber: '2',
        title: 'Refactor database models',
        branch: 'refactor/db',
        totalTurns: 3,
        maxTurns: 10,
        lastVerdict: 'NACK',
        createdAt: '2026-07-02T10:00:00Z',
      })
    );

    const repo = new SessionRepository(tempDir);

    expect(repo.getSessions({ owner: 'org-a' }).length).toBe(1);
    expect(repo.getSessions({ repo: 'repo-y' }).length).toBe(1);
    expect(repo.getSessions({ prNumber: 1 }).length).toBe(1);
    expect(repo.getSessions({ verdict: 'SHIP' }).length).toBe(1);
    expect(repo.getSessions({ minTurns: 2 }).length).toBe(1);
    expect(repo.getSessions({ maxTurns: 2 }).length).toBe(1);
    expect(repo.getSessions({ query: 'authentication' }).length).toBe(1);
    expect(repo.getSessions({ query: 'nonexistent' }).length).toBe(0);
  });

  it('falls back to dashboardStore when disk sessions directory is empty', () => {
    const mockStore = {
      getReviewLogs: () => [
        {
          id: 'fallback-owner/fallback-repo#99',
          prRun: 'fallback-owner/fallback-repo #99',
          repo: 'fallback-owner/fallback-repo',
          prNumber: 99,
          title: 'Fallback PR',
          status: 'completed',
          personas: ['Security'],
          verdict: 'SHIP',
          arbiterVerdict: 'SHIP',
          tokens: { prompt: 10, completion: 5, total: 15 },
          cost: 0.01,
          costUSD: 0.01,
          latencyMs: 500,
          timestamp: '2026-07-31T12:00:00Z',
          headSha: 'sha99',
          quorum: '1/1',
        },
      ],
    };

    const nonexistentDir = path.join(tempDir, 'nonexistent-sessions-dir');
    const repo = new SessionRepository(nonexistentDir, mockStore as any);
    const sessions = repo.getSessions();

    expect(sessions.length).toBe(1);
    expect(sessions[0].repo).toBe('fallback-repo');
  });
});
