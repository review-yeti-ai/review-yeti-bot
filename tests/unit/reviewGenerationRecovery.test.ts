import { describe, expect, it, vi } from 'vitest';
import { GitHubInstallationClient } from '../../src/github/installationClient';

const headSha = 'a'.repeat(40);
const runId = `run_${'b'.repeat(32)}`;

function workerCheck(generation: number, overrides: Record<string, unknown> = {}) {
  return {
    id: 1_000 + generation,
    name: 'Review Yeti',
    head_sha: headSha,
    external_id: `${runId}:a${generation}`,
    status: 'completed',
    conclusion: 'failure',
    app: { id: 4_385_771, slug: 'ct-review-bot' },
    output: {
      title: 'Review Yeti: review did not complete',
      summary: 'No durable verdict was recorded.',
      text: null,
    },
    ...overrides,
  };
}

function clientFor(checks: unknown[]) {
  const fetchImplementation = vi.fn(async () => new Response(JSON.stringify({
    total_count: checks.length,
    check_runs: checks,
  }), { status: 200, headers: { 'content-type': 'application/json' } }));
  return {
    client: new GitHubInstallationClient({ token: 'ghs_test', fetchImplementation }),
    fetchImplementation,
  };
}

describe('Review Yeti worker-generation recovery ledger', () => {
  it('accepts only a contiguous recoverable App-owned ledger for the exact run and head', async () => {
    const { client, fetchImplementation } = clientFor([workerCheck(1)]);

    await expect(client.readReviewGenerationRecovery({
      owner: 'calltelemetry', repo: 'cisco-cdr', headSha, runId,
      expectedGeneration: 2, expectedAppId: 4_385_771,
    })).resolves.toEqual([{
      generation: 1,
      checkId: 1_001,
      externalId: `${runId}:a1`,
      conclusion: 'failure',
      title: 'Review Yeti: review did not complete',
    }]);
    const [requestUrl] = fetchImplementation.mock.calls[0] as unknown as [string];
    expect(new URL(requestUrl).searchParams.get('check_name')).toBe('Review Yeti');
  });

  it.each([
    ['a code-review verdict', workerCheck(1, { output: { title: 'Review Yeti: FIX_FIRST', summary: 'finding', text: null } })],
    ['a successful verdict', workerCheck(1, { conclusion: 'success' })],
    ['another App', workerCheck(1, { app: { id: 99, slug: 'attacker' } })],
    ['another durable run', workerCheck(1, { external_id: `run_${'c'.repeat(32)}:a1` })],
    ['a later generation', workerCheck(2)],
  ])('rejects %s instead of reconstructing service state', async (_label, check) => {
    const { client } = clientFor([check]);
    await expect(client.readReviewGenerationRecovery({
      owner: 'calltelemetry', repo: 'cisco-cdr', headSha, runId,
      expectedGeneration: 2, expectedAppId: 4_385_771,
    })).rejects.toThrow(/generation recovery ledger/u);
  });

  it('rejects a missing, duplicate, or non-contiguous prior generation', async () => {
    for (const checks of [[], [workerCheck(1), workerCheck(1, { id: 2_001 })]]) {
      const { client } = clientFor(checks);
      await expect(client.readReviewGenerationRecovery({
        owner: 'calltelemetry', repo: 'cisco-cdr', headSha, runId,
        expectedGeneration: 2, expectedAppId: 4_385_771,
      })).rejects.toThrow(/generation recovery ledger/u);
    }
  });
});
