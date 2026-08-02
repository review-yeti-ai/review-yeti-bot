import fs from 'fs';
import path from 'path';
import os from 'os';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { runCLI, parseCLIArgs } from '../../src/analytics/cliParser';
import { execSync } from 'child_process';

describe('Adversarial Stress Test Suite for Session Analytics CLI', () => {
  let tempDir: string;
  let sessionsDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-stress-test-'));
    sessionsDir = path.join(tempDir, 'sessions');

    const s1Dir = path.join(sessionsDir, 'cisco-cdr', 'ct-review-bot', 'pr-42');
    fs.mkdirSync(s1Dir, { recursive: true });
    fs.writeFileSync(
      path.join(s1Dir, 'metadata.json'),
      JSON.stringify({
        owner: 'cisco-cdr',
        repo: 'ct-review-bot',
        prNumber: 42,
        title: 'Refactor Session Ledger',
        branch: 'feat/ledger-refactor',
        createdAt: '2026-07-25T10:00:00Z',
        updatedAt: '2026-07-26T12:00:00Z',
        lastVerdict: 'SHIP',
        totalTurns: 3,
        maxTurns: 10,
      })
    );
    fs.writeFileSync(
      path.join(s1Dir, 'turn-1.json'),
      JSON.stringify({
        currentTurn: 1,
        headSha: 'sha111',
        arbitration: { verdict: 'NACK' },
        personaResults: [
          { displayName: 'Security', findings: [{ severity: 'P0', title: 'Injection flaw', path: 'src/cli.ts' }] },
        ],
        costUSD: 0.1,
        durationMs: 1500,
        tokens: { prompt: 500, completion: 200, total: 700 },
      })
    );
    fs.writeFileSync(
      path.join(s1Dir, 'turn-3.json'),
      JSON.stringify({
        currentTurn: 3,
        headSha: 'sha333',
        arbitration: { verdict: 'SHIP' },
        personaResults: [{ displayName: 'Security', findings: [] }],
        costUSD: 0.05,
        durationMs: 900,
        tokens: { prompt: 400, completion: 150, total: 550 },
      })
    );
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('Dimension 1: Invalid & Unrecognized Flags', () => {
    it('silently ignores unrecognized flags without error or warning', async () => {
      const res = await runCLI(['--invalid-flag', '--unknown-option', 'foo', '--dir', sessionsDir]);
      // Expectation: res.exitCode is 0, no error message displayed
      expect(res.exitCode).toBe(0);
      expect(res.output).toContain('cisco-cdr/ct-review-bot#42');
    });

    it('handles flag without value at the end of arguments', async () => {
      const res = await runCLI(['list', '--dir', sessionsDir, '--owner']);
      expect(res.exitCode).toBe(0);
      // --owner was undefined because ++i went out of bounds
    });

    it('silently ignores invalid format option and falls back to table', async () => {
      const res = await runCLI(['list', '--dir', sessionsDir, '--format', 'invalid_fmt_xyz']);
      expect(res.exitCode).toBe(0);
      expect(res.output).toContain('cisco-cdr/ct-review-bot#42');
    });
  });

  describe('Dimension 2: Non-Existent Directories', () => {
    it('returns empty session list (or fallback) when baseDir does not exist', async () => {
      const nonExistent = path.join(tempDir, 'does_not_exist_123');
      const res = await runCLI(['list', '--dir', nonExistent]);
      expect(res.exitCode).toBe(0);
      expect(res.output).toBe('No sessions found.');
    });

    it('returns error exitCode 1 when inspecting non-existent dir/session', async () => {
      const nonExistent = path.join(tempDir, 'does_not_exist_123');
      const res = await runCLI(['inspect', 'cisco-cdr/ct-review-bot#42', '--dir', nonExistent]);
      expect(res.exitCode).toBe(1);
      expect(res.output).toContain('Error: Session not found for ID: cisco-cdr/ct-review-bot#42');
    });
  });

  describe('Dimension 3: Empty Search Queries', () => {
    it('handles bare search command (no query string)', async () => {
      const res = await runCLI(['search', '--dir', sessionsDir]);
      expect(res.exitCode).toBe(0);
      // Returns all sessions when query is missing
      expect(res.output).toContain('cisco-cdr/ct-review-bot#42');
    });

    it('handles empty query string search ""', async () => {
      const res = await runCLI(['search', '', '--dir', sessionsDir]);
      expect(res.exitCode).toBe(0);
      expect(res.output).toContain('cisco-cdr/ct-review-bot#42');
    });

    it('handles -q "" flag', async () => {
      const res = await runCLI(['search', '-q', '', '--dir', sessionsDir]);
      expect(res.exitCode).toBe(0);
      expect(res.output).toContain('cisco-cdr/ct-review-bot#42');
    });

    it('returns No sessions found for non-matching search query', async () => {
      const res = await runCLI(['search', 'nonexistent_xyz_query', '--dir', sessionsDir]);
      expect(res.exitCode).toBe(0);
      expect(res.output).toBe('No sessions found.');
    });
  });

  describe('Dimension 4: Extreme & Invalid Turn Filters', () => {
    it('filters out sessions when min-turns is extremely high', async () => {
      const res = await runCLI(['list', '--dir', sessionsDir, '--min-turns', '999999']);
      expect(res.exitCode).toBe(0);
      expect(res.output).toBe('No sessions found.');
    });

    it('filters out sessions when max-turns is negative', async () => {
      const res = await runCLI(['list', '--dir', sessionsDir, '--max-turns', '-5']);
      expect(res.exitCode).toBe(0);
      expect(res.output).toBe('No sessions found.');
    });

    it('returns empty list for contradictory min > max turns', async () => {
      const res = await runCLI(['list', '--dir', sessionsDir, '--min-turns', '10', '--max-turns', '2']);
      expect(res.exitCode).toBe(0);
      expect(res.output).toBe('No sessions found.');
    });

    it('silently ignores non-numeric min-turns (--min-turns abc)', async () => {
      const res = await runCLI(['list', '--dir', sessionsDir, '--min-turns', 'abc']);
      // parseInt('abc', 10) is NaN; session.totalTurns < NaN evaluates to false
      expect(res.exitCode).toBe(0);
      expect(res.output).toContain('cisco-cdr/ct-review-bot#42');
    });
  });

  describe('Dimension 5: Missing Arguments & Invalid Session IDs', () => {
    it('returns error exitCode 1 when inspect command has no targetId', async () => {
      const res = await runCLI(['inspect']);
      expect(res.exitCode).toBe(1);
      expect(res.output).toBe('Error: Session ID required for inspect command.');
    });

    it('returns error exitCode 1 when inspect command targetId is not found', async () => {
      const res = await runCLI(['inspect', 'nonexistent/session#999', '--dir', sessionsDir]);
      expect(res.exitCode).toBe(1);
      expect(res.output).toBe('Error: Session not found for ID: nonexistent/session#999');
    });

    it('throws file system error when --out path is unwritable', async () => {
      await expect(
        runCLI(['list', '--dir', sessionsDir, '--out', '/sys/read_only_test/output.json'])
      ).rejects.toThrow();
    });
  });

  describe('Dimension 6: Entrypoint Execution via ts-node', () => {
    const execOpts = {
      cwd: path.resolve(__dirname, '../../'),
      stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8' as const,
      timeout: 10000,
      env: { ...process.env, TS_NODE_TRANSPILE_ONLY: 'true' },
    };

    it('executes via ts-node and returns non-zero exit code on inspect failure', () => {
      try {
        execSync('./node_modules/.bin/ts-node --transpile-only src/cli/sessionAnalytics.ts inspect', execOpts);
        expect.fail('Should have exited with non-zero exit code');
      } catch (err: any) {
        expect(err.status).toBe(1);
        expect(err.stderr.toString()).toContain('Error: Session ID required for inspect command.');
      }
    }, 15000);

    it('outputs error messages to STDERR when CLI command fails', () => {
      try {
        execSync('./node_modules/.bin/ts-node --transpile-only src/cli/sessionAnalytics.ts inspect', execOpts);
        expect.fail('Should have exited with non-zero exit code');
      } catch (err: any) {
        expect(err.status).toBe(1);
        expect(err.stderr.toString()).toContain('Error: Session ID required');
      }
    }, 15000);
  });
});
