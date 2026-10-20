import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createDefaultCliModelClient,
  runLocalReview,
  parseRepoSlug,
  resolveGhToken,
  resolveGhPrTarget,
  runGhPrStatus,
  runGhPrReview,
  runCli,
} from '../../src/cli';

describe('GitHub-Connected CLI (review-yeti pr / status / review --pr)', () => {
  it('createDefaultCliModelClient constructs a working HTTP LLM client when an API key is provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify([
                {
                  severity: 'P1',
                  rule: 'SQL Injection',
                  filePath: 'src/db.ts',
                  lineNumber: 14,
                  message: 'Unsanitized query interpolation',
                },
              ]),
            },
          },
        ],
      }),
    });

    const client = createDefaultCliModelClient({
      apiKey: 'test-gateway-key',
      baseUrl: 'https://gateway.example.com/v1',
      fetchFn: fetchMock as unknown as typeof fetch,
      allowInTest: true,
    });

    expect(client).toBeDefined();
    const res = await client!.complete({
      model: 'deepseek/deepseek-chat',
      messages: [{ role: 'user', content: 'Review diff' }],
    } as any);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://gateway.example.com/v1/chat/completions');
    expect((res as any).content).toContain('SQL Injection');
  });

  it('runLocalReview evaluates .reviewyeti/checks/*.md Check Run Agents and Approvability locally', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ry-local-checks-'));
    try {
      const checksDir = path.join(tmpDir, '.reviewyeti', 'checks');
      fs.mkdirSync(checksDir, { recursive: true });
      fs.writeFileSync(
        path.join(checksDir, 'auth-guard.md'),
        [
          '---',
          'name: Auth Guard',
          'severity: high',
          'paths:',
          '  - src/auth/**',
          '---',
          'Ensure no hardcoded secrets in auth modules.',
        ].join('\n'),
        'utf-8'
      );

      const diff = [
        'diff --git a/src/auth/token.ts b/src/auth/token.ts',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/src/auth/token.ts',
        '@@ -0,0 +1,2 @@',
        '+export const token = "AKIA1234567890ABCDEF";',
      ].join('\n');

      const result = await runLocalReview({
        cwd: tmpDir,
        diff,
        quiet: true,
      });

      expect(result.exitCode).toBe(1);
      expect(result.checkEvaluations).toHaveLength(1);
      expect(result.checkEvaluations[0].checkName).toBe('Review Yeti / Auth Guard');
      expect(result.checkEvaluations[0].conclusion).toBe('failure');
      expect(result.approvability.approved).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('parseRepoSlug and resolveGhToken resolve GitHub repo and auth token via gh', () => {
    expect(parseRepoSlug('git@github.com:review-yeti-ai/review-yeti-bot.git')).toEqual({
      owner: 'review-yeti-ai',
      repo: 'review-yeti-bot',
    });
    expect(parseRepoSlug('https://github.com/review-yeti-ai/review-yeti-bot.git')).toEqual({
      owner: 'review-yeti-ai',
      repo: 'review-yeti-bot',
    });

    const token = resolveGhToken({
      execGhFn: (args) => (args[0] === 'auth' ? 'gho_mock_cli_token_123' : ''),
    });
    expect(token).toBe('gho_mock_cli_token_123');

    const target = resolveGhPrTarget({
      repo: 'review-yeti-ai/review-yeti-bot',
      execGhFn: (args) => {
        if (args[0] === 'pr' && args[1] === 'view') {
          return JSON.stringify({
            number: 1516,
            headRefOid: '337f3a42deadbeef',
            title: 'feat(ux): wire real APIs',
            url: 'https://github.com/review-yeti-ai/review-yeti-bot/pull/1516',
          });
        }
        return '';
      },
    });
    expect(target.owner).toBe('review-yeti-ai');
    expect(target.repo).toBe('review-yeti-bot');
    expect(target.prNumber).toBe(1516);
    expect(target.headSha).toBe('337f3a42deadbeef');
  });

  it('runGhPrStatus fetches live Check Runs and inline comments and computes Approvability', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/commits/abc12345/check-runs')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            check_runs: [
              {
                id: 901,
                name: 'Review Yeti / Auth Boundary Guard',
                status: 'completed',
                conclusion: 'success',
                output: { title: 'Passed (2 files checked)' },
              },
            ],
          }),
        };
      }
      if (url.endsWith('/pulls/1516/comments')) {
        return {
          ok: true,
          status: 200,
          json: async () => [],
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          head: { sha: 'abc12345' },
          title: 'feat: clean PR',
          html_url: 'https://github.com/review-yeti-ai/review-yeti-bot/pull/1516',
        }),
      };
    });

    const status = await runGhPrStatus({
      repo: 'review-yeti-ai/review-yeti-bot',
      prNumber: 1516,
      token: 'gho_test',
      quiet: true,
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    expect(status.exitCode).toBe(0);
    expect(status.approvable).toBe(true);
    expect(status.approvabilityStatus).toBe('Approved');
    expect(status.checkRuns).toHaveLength(1);
    expect(status.checkRuns[0].name).toBe('Review Yeti / Auth Boundary Guard');
  });

  it('runGhPrReview fetches remote PR diff, evaluates .reviewyeti/checks/*.md, and publishes review + check runs with --publish', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ry-remote-pr-'));
    try {
      const checksDir = path.join(tmpDir, '.reviewyeti', 'checks');
      fs.mkdirSync(checksDir, { recursive: true });
      fs.writeFileSync(
        path.join(checksDir, 'migration-safety.md'),
        [
          '---',
          'name: Migration Safety',
          'severity: high',
          'paths:',
          '  - src/**',
          '---',
          'Verify safe schema migrations.',
        ].join('\n'),
        'utf-8'
      );

      const postedUrls: string[] = [];
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          postedUrls.push(url);
          return {
            ok: true,
            status: 201,
            json: async () => ({ id: postedUrls.length * 100 }),
          };
        }
        const accept = (init?.headers as Record<string, string>)?.Accept || '';
        if (accept.includes('diff')) {
          return {
            ok: true,
            status: 200,
            text: async () =>
              [
                'diff --git a/src/index.ts b/src/index.ts',
                '--- a/src/index.ts',
                '+++ b/src/index.ts',
                '@@ -1,1 +1,2 @@',
                '+export const ready = true;',
              ].join('\n'),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            head: { sha: 'deadbeef99' },
            title: 'feat: safe migration',
          }),
        };
      });

      const res = await runGhPrReview({
        cwd: tmpDir,
        repo: 'review-yeti-ai/review-yeti-bot',
        prNumber: 1516,
        publish: true,
        token: 'gho_publish_token',
        quiet: true,
        fetchFn: fetchMock as unknown as typeof fetch,
      });

      expect(res.exitCode).toBe(0);
      expect(res.clean).toBe(true);
      expect(res.published).toBe(true);
      expect(res.publishedReviewId).toBe(100);
      expect(res.publishedCheckIds).toEqual([200]);
      expect(postedUrls).toEqual([
        'https://api.github.com/repos/review-yeti-ai/review-yeti-bot/pulls/1516/reviews',
        'https://api.github.com/repos/review-yeti-ai/review-yeti-bot/check-runs',
      ]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('runCli help text advertises pr and status commands and --pr / --publish flags', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const code = await runCli(['--help']);
      expect(code).toBe(0);
      const helpOutput = spy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(helpOutput).toContain('pr [number]');
      expect(helpOutput).toContain('status [number]');
      expect(helpOutput).toContain('--publish');
    } finally {
      spy.mockRestore();
    }
  });
});
