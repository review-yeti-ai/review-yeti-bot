import { describe, expect, it, vi } from 'vitest';
import { GitHubInstallationClient } from '../../src/github/installationClient';
import { renderIncompleteInfrastructureTitle } from '../../src/review/publicationFailurePolicy';
import { validateReviewGenerationRecoveryEvidence } from '../../src/review/reviewGenerationRecovery';

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

function request(overrides: Record<string, unknown> = {}) {
  return {
    owner: 'calltelemetry', repo: 'cisco-cdr', headSha, runId,
    expectedGeneration: 2, expectedAppId: 4_385_771,
    ...overrides,
  };
}

function clientForPages(pages: Array<{ total_count: number; check_runs: unknown[] }>) {
  const fetchImplementation = vi.fn(async () => {
    const page = pages.shift();
    if (!page) throw new Error('unexpected recovery-ledger page');
    return new Response(JSON.stringify(page), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return {
    client: new GitHubInstallationClient({ token: 'ghs_test', fetchImplementation }),
    fetchImplementation,
  };
}

describe('Review Yeti worker-generation recovery ledger', () => {
  it('accepts only a contiguous recoverable App-owned ledger for the exact run and head', async () => {
    const { client, fetchImplementation } = clientFor([workerCheck(1)]);

    await expect(client.readReviewGenerationRecovery(request())).resolves.toEqual([{
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
    await expect(client.readReviewGenerationRecovery(request()))
      .rejects.toThrow(/generation recovery ledger/u);
  });

  // REL-1113: an infrastructure-incomplete worker check is recoverable on the generation-recovery
  // path too, so the admission path and the ledger never disagree about it.
  const exhaustedIncomplete = renderIncompleteInfrastructureTitle([{ id: 'arch-lane', failureClass: 'provider_error', providerStatus: 502 }]);
  const retryingIncomplete = renderIncompleteInfrastructureTitle([{ id: 'arch-lane', failureClass: 'transport' }], { nextAttempt: 2, maxAttempts: 3 });
  const lookalike = 'Review Yeti: INCOMPLETE — infrastructure (lane arch-lane failed: 502); retrying soon';

  it.each([exhaustedIncomplete, retryingIncomplete])('accepts an infrastructure-incomplete ledger row titled %s', async (title) => {
    const { client } = clientFor([workerCheck(1, { output: { title, summary: 'infra', text: null } })]);
    await expect(client.readReviewGenerationRecovery(request())).resolves.toEqual([{
      generation: 1, checkId: 1_001, externalId: `${runId}:a1`, conclusion: 'failure', title,
    }]);
    expect(validateReviewGenerationRecoveryEvidence(
      { ...request(), expectedGeneration: 2 } as never,
      [{ generation: 1, checkId: 1_001, externalId: `${runId}:a1`, conclusion: 'failure', title }],
    )).toHaveLength(1);
  });

  it('refuses a lookalike INCOMPLETE title on both generation-recovery validators', async () => {
    const { client } = clientFor([workerCheck(1, { output: { title: lookalike, summary: 'infra', text: null } })]);
    await expect(client.readReviewGenerationRecovery(request())).rejects.toThrow(/generation recovery ledger/u);
    expect(() => validateReviewGenerationRecoveryEvidence(
      { ...request(), expectedGeneration: 2 } as never,
      [{ generation: 1, checkId: 1_001, externalId: `${runId}:a1`, conclusion: 'failure', title: lookalike }],
    )).toThrow(/generation recovery ledger/u);
  });

  it('rejects a missing, duplicate, or non-contiguous prior generation', async () => {
    for (const checks of [[], [workerCheck(1), workerCheck(1, { id: 2_001 })]]) {
      const { client } = clientFor(checks);
      await expect(client.readReviewGenerationRecovery(request()))
        .rejects.toThrow(/generation recovery ledger/u);
    }
  });

  it('accepts an exact merge-group row without treating it as worker evidence', async () => {
    const mergeGroup = workerCheck(99, {
      id: 9_999,
      external_id: `merge-group:${headSha}`,
    });
    const { client } = clientFor([workerCheck(1), mergeGroup]);

    await expect(client.readReviewGenerationRecovery(request())).resolves.toEqual([
      expect.objectContaining({ generation: 1, checkId: 1_001 }),
    ]);

    const { client: malformed } = clientFor([
      workerCheck(1),
      { ...mergeGroup, head_sha: 'c'.repeat(40) },
    ]);
    await expect(malformed.readReviewGenerationRecovery(request()))
      .rejects.toThrow(/generation recovery ledger/u);
  });

  it('reads a complete stable two-page ledger', async () => {
    const mergeGroups = Array.from({ length: 100 }, (_, index) => workerCheck(99, {
      id: 10_000 + index,
      external_id: `merge-group:${headSha}`,
    }));
    const { client, fetchImplementation } = clientForPages([
      { total_count: 101, check_runs: mergeGroups },
      { total_count: 101, check_runs: [workerCheck(1)] },
    ]);

    await expect(client.readReviewGenerationRecovery(request())).resolves.toEqual([
      expect.objectContaining({ generation: 1, checkId: 1_001 }),
    ]);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    const [firstPageUrl] = fetchImplementation.mock.calls[0] as unknown as [string];
    const [secondPageUrl] = fetchImplementation.mock.calls[1] as unknown as [string];
    expect(new URL(firstPageUrl).searchParams.get('page')).toBe('1');
    expect(new URL(secondPageUrl).searchParams.get('page')).toBe('2');
  });

  it('sorts and validates both prior generations for an a3 recovery', async () => {
    const { client } = clientFor([workerCheck(2), workerCheck(1)]);

    await expect(client.readReviewGenerationRecovery(request({ expectedGeneration: 3 })))
      .resolves.toEqual([
        expect.objectContaining({ generation: 1, checkId: 1_001, externalId: `${runId}:a1` }),
        expect.objectContaining({ generation: 2, checkId: 1_002, externalId: `${runId}:a2` }),
      ]);
  });

  it('refuses recovery beyond the bounded a3 generation without calling GitHub', async () => {
    const fetchImplementation = vi.fn();
    const client = new GitHubInstallationClient({ token: 'ghs_test', fetchImplementation });

    await expect(client.readReviewGenerationRecovery(request({ expectedGeneration: 4 })))
      .rejects.toThrow(/generation recovery ledger/u);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it.each([
    ['a changing total count', [
      { total_count: 101, check_runs: Array.from({ length: 100 }, (_, index) => workerCheck(99, {
        id: 20_000 + index, external_id: `merge-group:${headSha}`,
      })) },
      { total_count: 102, check_runs: [workerCheck(1)] },
    ]],
    ['an id repeated across pages', [
      { total_count: 101, check_runs: Array.from({ length: 100 }, (_, index) => workerCheck(99, {
        id: 30_000 + index, external_id: `merge-group:${headSha}`,
      })) },
      { total_count: 101, check_runs: [workerCheck(1, { id: 30_000 })] },
    ]],
    ['an incomplete short page', [
      { total_count: 2, check_runs: [workerCheck(1)] },
    ]],
    ['an unbounded ledger', [
      { total_count: 1_000, check_runs: [] },
    ]],
  ] as const)('rejects %s', async (_label, pages) => {
    const { client } = clientForPages(pages.map((page) => ({
      total_count: page.total_count,
      check_runs: [...page.check_runs],
    })));
    await expect(client.readReviewGenerationRecovery(request()))
      .rejects.toThrow(/generation recovery ledger/u);
  });

  it('rejects malformed immutable identity before issuing a GitHub request', async () => {
    const fetchImplementation = vi.fn();
    const client = new GitHubInstallationClient({ token: 'ghs_test', fetchImplementation });

    await expect(client.readReviewGenerationRecovery(request({ headSha: '../check-runs?app_id=1' }) as any))
      .rejects.toThrow(/generation recovery ledger/u);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});
