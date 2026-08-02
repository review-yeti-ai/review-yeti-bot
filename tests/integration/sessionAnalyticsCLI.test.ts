import fs from 'fs';
import path from 'path';
import os from 'os';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { runCLI } from '../../src/analytics/cliParser';

describe('sessionAnalyticsCLI Integration Tests', () => {
  let tempDir: string;
  let sessionsDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-int-test-'));
    sessionsDir = path.join(tempDir, 'sessions');

    // Create session 1: owner-a/repo-a#10
    const s1Dir = path.join(sessionsDir, 'owner-a', 'repo-a', 'pr-10');
    fs.mkdirSync(s1Dir, { recursive: true });
    fs.writeFileSync(
      path.join(s1Dir, 'metadata.json'),
      JSON.stringify({
        owner: 'owner-a',
        repo: 'repo-a',
        prNumber: '10',
        title: 'Add JWT Middleware',
        branch: 'feat/jwt',
        initialHeadSha: 'sha1',
        currentHeadSha: 'sha2',
        totalTurns: 2,
        maxTurns: 10,
        createdAt: '2026-07-30T10:00:00Z',
        updatedAt: '2026-07-30T11:00:00Z',
        lastVerdict: 'SHIP',
      })
    );
    fs.writeFileSync(
      path.join(s1Dir, 'turn-1.json'),
      JSON.stringify({
        owner: 'owner-a',
        repo: 'repo-a',
        prNumber: 10,
        headSha: 'sha1',
        currentTurn: 1,
        maxTurns: 10,
        arbitration: { verdict: 'NACK', rationale: 'Missing check', metrics: { p0Count: 1, p1Count: 0, p2Count: 0 } },
        personaResults: [
          {
            id: 'sec',
            displayName: 'Security',
            decision: 'NACK',
            findings: [{ severity: 'P0', title: 'Hardcoded secret', path: 'src/jwt.ts', line: 15 }],
          },
        ],
        costUSD: 0.05,
        durationMs: 1200,
        tokens: { prompt: 200, completion: 100, total: 300 },
      })
    );
    fs.writeFileSync(
      path.join(s1Dir, 'turn-2.json'),
      JSON.stringify({
        owner: 'owner-a',
        repo: 'repo-a',
        prNumber: 10,
        headSha: 'sha2',
        currentTurn: 2,
        maxTurns: 10,
        arbitration: { verdict: 'SHIP', rationale: 'All clear', metrics: { p0Count: 0, p1Count: 0, p2Count: 0 } },
        personaResults: [
          {
            id: 'sec',
            displayName: 'Security',
            decision: 'SHIP',
            findings: [],
          },
        ],
        costUSD: 0.04,
        durationMs: 900,
        tokens: { prompt: 180, completion: 80, total: 260 },
      })
    );

    // Create session 2: owner-b/repo-b#20
    const s2Dir = path.join(sessionsDir, 'owner-b', 'repo-b', 'pr-20');
    fs.mkdirSync(s2Dir, { recursive: true });
    fs.writeFileSync(
      path.join(s2Dir, 'metadata.json'),
      JSON.stringify({
        owner: 'owner-b',
        repo: 'repo-b',
        prNumber: '20',
        title: 'Fix Database Connection Pool',
        branch: 'fix/db-pool',
        initialHeadSha: 'sha3',
        currentHeadSha: 'sha3',
        totalTurns: 1,
        maxTurns: 10,
        createdAt: '2026-07-31T08:00:00Z',
        updatedAt: '2026-07-31T08:30:00Z',
        lastVerdict: 'NACK',
      })
    );
    fs.writeFileSync(
      path.join(s2Dir, 'turn-1.json'),
      JSON.stringify({
        owner: 'owner-b',
        repo: 'repo-b',
        prNumber: 20,
        headSha: 'sha3',
        currentTurn: 1,
        maxTurns: 10,
        arbitration: { verdict: 'NACK', rationale: 'Pool leak', metrics: { p0Count: 0, p1Count: 1, p2Count: 0 } },
        personaResults: [
          {
            id: 'arch',
            displayName: 'Architect',
            decision: 'NACK',
            findings: [{ severity: 'P1', title: 'Connection leak', path: 'src/db.ts', line: 40 }],
          },
        ],
        costUSD: 0.08,
        durationMs: 2000,
        tokens: { prompt: 400, completion: 200, total: 600 },
      })
    );
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('runs stats command with OKF format and verifies aggregate calculation', async () => {
    const res = await runCLI(['stats', '--dir', sessionsDir, '--format', 'okf']);
    expect(res.exitCode).toBe(0);
    expect(res.output).toContain('=== OKF: SESSION KEY PERFORMANCE INDICATORS ===');
    expect(res.output).toContain('kpi.total_sessions: 2');
    expect(res.output).toContain('kpi.total_turns: 3');
    expect(res.output).toContain('kpi.pass_rate_percent: 50%');
    expect(res.output).toContain('kpi.total_cost_usd: $0.1700');
  });

  it('runs list command with filters and output file writing', async () => {
    const outFile = path.join(tempDir, 'list_output.json');
    const res = await runCLI([
      'list',
      '--dir',
      sessionsDir,
      '--verdict',
      'SHIP',
      '--format',
      'json',
      '--out',
      outFile,
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.outPath).toBe(outFile);
    expect(fs.existsSync(outFile)).toBe(true);

    const writtenContent = JSON.parse(fs.readFileSync(outFile, 'utf-8'));
    expect(writtenContent.sessions.length).toBe(1);
    expect(writtenContent.sessions[0].id).toBe('owner-a/repo-a#10');
  });

  it('runs inspect command for specific session ID with Markdown output', async () => {
    const res = await runCLI(['inspect', 'owner-a/repo-a#10', '--dir', sessionsDir, '--format', 'markdown']);
    expect(res.exitCode).toBe(0);
    expect(res.output).toContain('# 🔍 Session Detail: `owner-a/repo-a#10`');
    expect(res.output).toContain('Add JWT Middleware');
    expect(res.output).toContain('Initial Findings');
    expect(res.output).toContain('Resolved Findings');
  });

  it('runs search command to filter sessions by title query', async () => {
    const res = await runCLI(['search', 'Database', '--dir', sessionsDir, '--format', 'table']);
    expect(res.exitCode).toBe(0);
    expect(res.output).toContain('owner-b/repo-b#20');
    expect(res.output).not.toContain('owner-a/repo-a#10');
  });
});
