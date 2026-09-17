import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MAX_DELEGATED_FAILURE_CANDIDATES,
  DELEGATED_FAILURE_LIST_PAGE_SIZE,
  DelegatedFailureReader,
  MAX_DELEGATED_FAILURE_LIST_PAGES,
  MIN_DELEGATED_FAILURE_POLL_MS,
  resolveDelegatedFailurePollMs,
} from '../../src/k8s/delegatedFailureReader';
import { logger } from '../../src/utils/logger';

const RUN_ID = `run_${'1'.repeat(32)}`;

function prReviewJob(overrides: {
  runId?: unknown;
  executionAttempt?: unknown;
  runSecretName?: unknown;
  failurePublication?: Partial<{ status: string; reason: string; message: string; lastTransitionTime: string }>;
  ready?: Partial<{ status: string; reason: string; message: string; lastTransitionTime: string }> | null;
} = {}) {
  const conditions: Record<string, unknown>[] = [{
    type: 'FailurePublication',
    status: 'Unknown',
    reason: 'DelegatedToTrustedService',
    message: 'fail-closed publication delegated to the trusted dispatcher deadline reaper',
    lastTransitionTime: '2026-09-17T00:00:00.000Z',
    ...overrides.failurePublication,
  }];
  if (overrides.ready !== null) {
    conditions.push({
      type: 'Ready',
      status: 'True',
      reason: 'WorkerFailed',
      message: 'the publishing worker failed',
      lastTransitionTime: '2026-09-17T00:00:00.000Z',
      ...overrides.ready,
    });
  }
  return {
    apiVersion: 'review-yeti.ai/v1alpha2',
    kind: 'PRReviewJob',
    metadata: { name: 'ct-review-run-1111111111111111111111111111111111', namespace: 'ct-review-system' },
    spec: {
      runId: 'runId' in overrides ? overrides.runId : RUN_ID,
      executionAttempt: 'executionAttempt' in overrides ? overrides.executionAttempt : 2,
      runSecretName: 'runSecretName' in overrides
        ? overrides.runSecretName : `ct-review-run-${RUN_ID.slice(4)}-a2`,
    },
    status: { phase: 'Failed', conditions },
  };
}

function readerWith(items: unknown[], options: { now?: () => number; pollIntervalMs?: number; maxCandidates?: number } = {}) {
  const listNamespacedCustomObject = vi.fn(async (_request: Record<string, unknown>) => ({ items }));
  const reader = new DelegatedFailureReader({
    client: { listNamespacedCustomObject },
    namespace: 'ct-review-system',
    now: options.now,
    pollIntervalMs: options.pollIntervalMs,
    maxCandidates: options.maxCandidates,
  });
  return { reader, listNamespacedCustomObject };
}

describe('resolveDelegatedFailurePollMs', () => {
  it('defaults and clamps below the floor', () => {
    expect(resolveDelegatedFailurePollMs(undefined)).toBe(15_000);
    expect(resolveDelegatedFailurePollMs(1_000)).toBe(15_000);
    expect(resolveDelegatedFailurePollMs(Number.NaN)).toBe(15_000);
    expect(resolveDelegatedFailurePollMs(MIN_DELEGATED_FAILURE_POLL_MS)).toBe(MIN_DELEGATED_FAILURE_POLL_MS);
    expect(resolveDelegatedFailurePollMs(20_000)).toBe(20_000);
  });
});

describe('DelegatedFailureReader condition matching', () => {
  it('lists prreviewjobs in the exact group/version/namespace/plural, with a bounded page size and no selector', async () => {
    const { reader, listNamespacedCustomObject } = readerWith([]);
    await reader.listCandidates();
    expect(listNamespacedCustomObject).toHaveBeenCalledWith({
      group: 'review-yeti.ai', version: 'v1alpha2', namespace: 'ct-review-system', plural: 'prreviewjobs',
      limit: DELEGATED_FAILURE_LIST_PAGE_SIZE,
    });
    const [request] = listNamespacedCustomObject.mock.calls[0];
    expect(request).not.toHaveProperty('labelSelector');
    expect(request).not.toHaveProperty('fieldSelector');
  });

  it.each([
    ['WorkerFailed', 'worker_failed'],
    ['DeadlineExpired', 'worker_deadline_exceeded'],
    ['WorkerJobMissing', 'worker_job_missing'],
    ['WorkerContractRejected', 'worker_contract_rejected'],
  ] as const)('maps the Ready condition reason %s to %s', async (readyReason, expected) => {
    const { reader } = readerWith([prReviewJob({ ready: { reason: readyReason } })]);
    const candidates = await reader.listCandidates();
    expect(candidates).toEqual([{
      runId: RUN_ID,
      executionAttempt: 2,
      reason: expected,
      message: 'fail-closed publication delegated to the trusted dispatcher deadline reaper',
      observedAt: Date.parse('2026-09-17T00:00:00.000Z'),
    }]);
  });

  it('ignores a resource whose FailurePublication condition is not Unknown/DelegatedToTrustedService', async () => {
    const stillPending = prReviewJob({ failurePublication: { status: 'False', reason: 'WorkerFailed' } });
    const wrongReason = prReviewJob({ failurePublication: { reason: 'SomethingElse' } });
    const { reader } = readerWith([stillPending, wrongReason]);
    await expect(reader.listCandidates()).resolves.toEqual([]);
  });

  it('ignores an unrecognized Ready reason rather than guessing a classification', async () => {
    const { reader } = readerWith([prReviewJob({ ready: { reason: 'WorkerContractMismatch' } })]);
    await expect(reader.listCandidates()).resolves.toEqual([]);
  });

  it('ignores a resource missing the Ready condition entirely', async () => {
    const { reader } = readerWith([prReviewJob({ ready: null })]);
    await expect(reader.listCandidates()).resolves.toEqual([]);
  });

  it('ignores a malformed run id rather than admitting an unbounded string', async () => {
    const { reader } = readerWith([prReviewJob({ runId: 'not-a-run-id' })]);
    await expect(reader.listCandidates()).resolves.toEqual([]);
  });

  it('recovers a missing spec.executionAttempt from the run-secret name, like the projector does', async () => {
    const { reader } = readerWith([prReviewJob({ executionAttempt: undefined })]);
    const candidates = await reader.listCandidates();
    expect(candidates).toEqual([expect.objectContaining({ runId: RUN_ID, executionAttempt: 2 })]);
  });

  it('prefers spec.executionAttempt over the attempt implied by the run-secret name when they disagree', async () => {
    // The resource's own spec.executionAttempt is the operator's exact observed
    // attempt and is what the exact-attempt claim gate depends on; a name-derived
    // value must never override it. The default fixture secret name implies 2.
    const { reader } = readerWith([prReviewJob({ executionAttempt: 3 })]);
    const candidates = await reader.listCandidates();
    expect(candidates).toEqual([expect.objectContaining({ runId: RUN_ID, executionAttempt: 3 })]);
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 2.5],
    ['a numeric string', '3'],
  ])('falls back to the name-derived attempt when spec.executionAttempt is %s', async (_label, executionAttempt) => {
    const { reader } = readerWith([prReviewJob({ executionAttempt })]);
    const candidates = await reader.listCandidates();
    expect(candidates).toEqual([expect.objectContaining({ runId: RUN_ID, executionAttempt: 2 })]);
  });

  it('falls back to the Ready condition\'s lastTransitionTime when FailurePublication has none', async () => {
    const { reader } = readerWith([prReviewJob({
      failurePublication: { lastTransitionTime: undefined as unknown as string },
      ready: { lastTransitionTime: '2026-09-17T01:02:03.000Z' },
    })]);
    const candidates = await reader.listCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0].observedAt).toBe(Date.parse('2026-09-17T01:02:03.000Z'));
  });

  it('drops a candidate that has no usable observation time on either condition', async () => {
    const { reader } = readerWith([prReviewJob({
      failurePublication: { lastTransitionTime: undefined as unknown as string },
      ready: { lastTransitionTime: 'not-a-date' },
    })]);
    await expect(reader.listCandidates()).resolves.toEqual([]);
  });

  it('falls back to the Ready condition\'s message when the FailurePublication message is empty', async () => {
    const { reader } = readerWith([prReviewJob({
      failurePublication: { message: '' },
      ready: { message: 'worker pod was OOMKilled' },
    })]);
    const candidates = await reader.listCandidates();
    expect(candidates).toEqual([expect.objectContaining({ message: 'worker pod was OOMKilled' })]);
  });

  it('ignores a resource whose execution attempt cannot be resolved at all', async () => {
    const { reader } = readerWith([prReviewJob({ executionAttempt: undefined, runSecretName: 'garbage' })]);
    await expect(reader.listCandidates()).resolves.toEqual([]);
  });

  it('tolerates a non-array items field and a missing status/spec without throwing', async () => {
    const { reader } = readerWith([{ spec: {} }, { status: {} }, null, 'not-an-object']);
    await expect(reader.listCandidates()).resolves.toEqual([]);
  });
});

describe('DelegatedFailureReader poll interval', () => {
  it('honours the poll interval and only lists again once it elapses', async () => {
    let now = 0;
    const { reader, listNamespacedCustomObject } = readerWith([prReviewJob()], {
      now: () => now, pollIntervalMs: 20_000,
    });
    const first = await reader.listCandidates();
    expect(first).toHaveLength(1);
    expect(listNamespacedCustomObject).toHaveBeenCalledOnce();

    now = 5_000;
    await reader.listCandidates();
    expect(listNamespacedCustomObject).toHaveBeenCalledOnce();

    now = 20_001;
    await reader.listCandidates();
    expect(listNamespacedCustomObject).toHaveBeenCalledTimes(2);
  });
});

describe('DelegatedFailureReader candidate cap', () => {
  it('bounds the number of candidates returned per poll', async () => {
    const items = Array.from({ length: 5 }, (_, index) => prReviewJob({
      runId: `run_${String(index).padStart(32, '0')}`,
    }));
    const { reader } = readerWith(items, { maxCandidates: 2 });
    const candidates = await reader.listCandidates();
    expect(candidates).toHaveLength(2);
  });

  it('defaults the cap when none is configured', async () => {
    const items = Array.from({ length: DEFAULT_MAX_DELEGATED_FAILURE_CANDIDATES + 10 }, (_, index) => prReviewJob({
      runId: `run_${String(index).padStart(32, '0')}`,
    }));
    const { reader } = readerWith(items);
    const candidates = await reader.listCandidates();
    expect(candidates).toHaveLength(DEFAULT_MAX_DELEGATED_FAILURE_CANDIDATES);
  });
});

describe('DelegatedFailureReader fail-soft behavior', () => {
  it('returns no candidates and logs one rate-limited warning when list fails (e.g. a 403 before RBAC rollout)', async () => {
    const error = Object.assign(new Error('Forbidden'), { statusCode: 403 });
    const listNamespacedCustomObject = vi.fn(async () => { throw error; });
    const reader = new DelegatedFailureReader({
      client: { listNamespacedCustomObject }, namespace: 'ct-review-system', now: () => 0,
    });
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      await expect(reader.listCandidates()).resolves.toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        'Failed to list delegated PRReviewJob failure signals; deadline-based reaping is unaffected',
        { status: 403 },
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('rate-limits the warning to once per poll interval', async () => {
    let now = 0;
    const listNamespacedCustomObject = vi.fn(async () => { throw new Error('boom'); });
    const reader = new DelegatedFailureReader({
      client: { listNamespacedCustomObject }, namespace: 'ct-review-system',
      now: () => now, pollIntervalMs: 20_000,
    });
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      await reader.listCandidates();
      now = 20_001;
      await reader.listCandidates();
      expect(warn).toHaveBeenCalledTimes(2);
      expect(listNamespacedCustomObject).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('DelegatedFailureReader construction', () => {
  it('requires a namespace', () => {
    expect(() => new DelegatedFailureReader({
      client: { listNamespacedCustomObject: vi.fn() }, namespace: '  ',
    })).toThrow('namespace is required');
  });
});

describe('DelegatedFailureReader list response shape (REL-896)', () => {
  it('accepts a list wrapped in { body } as well as the bare list object', async () => {
    const listNamespacedCustomObject = vi.fn(async () => ({ body: { items: [prReviewJob({})] } }));
    const reader = new DelegatedFailureReader({ client: { listNamespacedCustomObject }, namespace: 'ct-review-system' });
    const candidates = await reader.listCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ runId: RUN_ID });
  });

  it.each([
    ['a non-object', 'nope'],
    ['an object without items', { kind: 'Status', code: 200 }],
    ['items that is not an array', { items: { 0: 'x' } }],
  ])('treats %s as a failure to log, never as a silently empty list', async (_label, response) => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const listNamespacedCustomObject = vi.fn(async () => response);
    const reader = new DelegatedFailureReader({ client: { listNamespacedCustomObject }, namespace: 'ct-review-system' });
    await expect(reader.listCandidates()).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('DelegatedFailureReader server-side pagination (REL-896)', () => {
  function page(items: unknown[], continueToken?: string) {
    return { items, metadata: continueToken ? { continue: continueToken } : {} };
  }

  it('stops after a single page when the response carries no continue token', async () => {
    const listNamespacedCustomObject = vi.fn(async (_request: Record<string, unknown>) => page([prReviewJob({})]));
    const reader = new DelegatedFailureReader({ client: { listNamespacedCustomObject }, namespace: 'ct-review-system' });
    const candidates = await reader.listCandidates();
    expect(candidates).toHaveLength(1);
    expect(listNamespacedCustomObject).toHaveBeenCalledTimes(1);
    expect(listNamespacedCustomObject.mock.calls[0][0]).not.toHaveProperty('_continue');
  });

  it('follows multiple pages in order, passing the continue token back on the next request', async () => {
    const first = prReviewJob({ runId: `run_${'1'.repeat(32)}` });
    const second = prReviewJob({ runId: `run_${'2'.repeat(32)}` });
    const listNamespacedCustomObject = vi.fn()
      .mockResolvedValueOnce(page([first], 'cursor-1'))
      .mockResolvedValueOnce(page([second]));
    const reader = new DelegatedFailureReader({ client: { listNamespacedCustomObject }, namespace: 'ct-review-system' });
    const candidates = await reader.listCandidates();
    expect(candidates.map((candidate) => candidate.runId)).toEqual([
      (first.spec as { runId: string }).runId,
      (second.spec as { runId: string }).runId,
    ]);
    expect(listNamespacedCustomObject).toHaveBeenCalledTimes(2);
    expect(listNamespacedCustomObject.mock.calls[0][0]).not.toHaveProperty('_continue');
    expect(listNamespacedCustomObject.mock.calls[1][0]).toMatchObject({ _continue: 'cursor-1' });
  });

  it('stops at the page cap, warns once, and returns the candidates paged in so far', async () => {
    const items = Array.from({ length: MAX_DELEGATED_FAILURE_LIST_PAGES }, (_, index) =>
      prReviewJob({ runId: `run_${String(index).padStart(32, '0')}` }));
    // Never returns an empty continue token, so only the page cap can stop this.
    const listNamespacedCustomObject = vi.fn(async (request: { _continue?: string }) => {
      const pageIndex = request._continue ? Number(request._continue) : 0;
      return page([items[pageIndex]], String(pageIndex + 1));
    });
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const reader = new DelegatedFailureReader({ client: { listNamespacedCustomObject }, namespace: 'ct-review-system' });
      const candidates = await reader.listCandidates();
      expect(listNamespacedCustomObject).toHaveBeenCalledTimes(MAX_DELEGATED_FAILURE_LIST_PAGES);
      expect(candidates).toHaveLength(MAX_DELEGATED_FAILURE_LIST_PAGES);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        'Delegated PRReviewJob failure signal list exceeded the page cap; using the candidates paged in so far',
        { pages: MAX_DELEGATED_FAILURE_LIST_PAGES },
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('paginates a { body: { items, metadata } } wrapped response too', async () => {
    const first = prReviewJob({ runId: `run_${'3'.repeat(32)}` });
    const second = prReviewJob({ runId: `run_${'4'.repeat(32)}` });
    const listNamespacedCustomObject = vi.fn()
      .mockResolvedValueOnce({ body: page([first], 'cursor-body-1') })
      .mockResolvedValueOnce({ body: page([second]) });
    const reader = new DelegatedFailureReader({ client: { listNamespacedCustomObject }, namespace: 'ct-review-system' });
    const candidates = await reader.listCandidates();
    expect(candidates.map((candidate) => candidate.runId)).toEqual([
      (first.spec as { runId: string }).runId,
      (second.spec as { runId: string }).runId,
    ]);
    expect(listNamespacedCustomObject).toHaveBeenCalledTimes(2);
    expect(listNamespacedCustomObject.mock.calls[1][0]).toMatchObject({ _continue: 'cursor-body-1' });
  });

  it('still honours the candidate cap across multiple pages', async () => {
    const firstPageItems = [
      prReviewJob({ runId: `run_${'5'.repeat(32)}` }),
      prReviewJob({ runId: `run_${'6'.repeat(32)}` }),
    ];
    const secondPageItems = [prReviewJob({ runId: `run_${'7'.repeat(32)}` })];
    const listNamespacedCustomObject = vi.fn()
      .mockResolvedValueOnce(page(firstPageItems, 'cursor-cap-1'))
      .mockResolvedValueOnce(page(secondPageItems));
    const reader = new DelegatedFailureReader({
      client: { listNamespacedCustomObject }, namespace: 'ct-review-system', maxCandidates: 2,
    });
    const candidates = await reader.listCandidates();
    expect(candidates).toHaveLength(2);
    expect(candidates.map((candidate) => candidate.runId)).toEqual([
      (firstPageItems[0].spec as { runId: string }).runId,
      (firstPageItems[1].spec as { runId: string }).runId,
    ]);
    // The cap was already satisfied by page one, so page two is never requested.
    expect(listNamespacedCustomObject).toHaveBeenCalledTimes(1);
  });

  it('stops paging on the page where the cap is reached and never requests the rest', async () => {
    const run = (digit: string) => prReviewJob({ runId: `run_${digit.repeat(32)}` });
    const listNamespacedCustomObject = vi.fn()
      .mockResolvedValueOnce(page([run('1'), run('2')], 'cursor-a'))
      .mockResolvedValueOnce(page([run('3'), run('4')], 'cursor-b'))
      .mockResolvedValueOnce(page([run('5')]));
    const reader = new DelegatedFailureReader({
      client: { listNamespacedCustomObject }, namespace: 'ct-review-system', maxCandidates: 3,
    });
    const candidates = await reader.listCandidates();
    expect(candidates.map((candidate) => candidate.runId)).toEqual([
      `run_${'1'.repeat(32)}`, `run_${'2'.repeat(32)}`, `run_${'3'.repeat(32)}`,
    ]);
    expect(listNamespacedCustomObject).toHaveBeenCalledTimes(2);
  });

  it('keeps paging past a page of non-delegated resources, which do not count toward the cap', async () => {
    const notDelegated = prReviewJob({ failurePublication: { reason: 'SomethingElse' } });
    const delegated = prReviewJob({ runId: `run_${'9'.repeat(32)}` });
    const listNamespacedCustomObject = vi.fn()
      .mockResolvedValueOnce(page([notDelegated, notDelegated], 'cursor-n'))
      .mockResolvedValueOnce(page([delegated]));
    const reader = new DelegatedFailureReader({
      client: { listNamespacedCustomObject }, namespace: 'ct-review-system', maxCandidates: 1,
    });
    const candidates = await reader.listCandidates();
    expect(candidates.map((candidate) => candidate.runId)).toEqual([`run_${'9'.repeat(32)}`]);
    expect(listNamespacedCustomObject).toHaveBeenCalledTimes(2);
  });
});

describe('DelegatedFailureReader remaining input and lifecycle branches (REL-896)', () => {
  it.each([
    ['status has no conditions', { status: { phase: 'Failed' } }],
    ['conditions is not an array', { status: { phase: 'Failed', conditions: { type: 'FailurePublication' } } }],
    ['status is missing entirely', { status: undefined }],
  ])('ignores a resource when %s', async (_label, patch) => {
    const { reader } = readerWith([{ ...prReviewJob({}), ...patch }]);
    await expect(reader.listCandidates()).resolves.toEqual([]);
  });

  it.each([
    ['a number', 12345],
    ['missing', undefined],
    ['not the run_<32 hex> shape', 'run_NOT-HEX'],
  ])('ignores a resource whose spec.runId is %s', async (_label, runId) => {
    const { reader } = readerWith([prReviewJob({ runId })]);
    await expect(reader.listCandidates()).resolves.toEqual([]);
  });

  it('yields an empty message when neither condition carries one', async () => {
    const { reader } = readerWith([prReviewJob({
      failurePublication: { message: undefined as unknown as string },
      ready: { message: undefined as unknown as string },
    })]);
    const candidates = await reader.listCandidates();
    expect(candidates).toEqual([expect.objectContaining({ runId: RUN_ID, message: '' })]);
  });

  it.each([
    ['zero', 0],
    ['negative', -5],
    ['fractional', 2.5],
    ['NaN', Number.NaN],
  ])('falls back to the default candidate cap when maxCandidates is %s, never to a cap that disables the signal', async (_label, maxCandidates) => {
    const many = Array.from({ length: DEFAULT_MAX_DELEGATED_FAILURE_CANDIDATES + 10 }, (_unused, index) =>
      prReviewJob({ runId: `run_${index.toString(16).padStart(32, '0')}` }));
    const { reader } = readerWith(many, { maxCandidates });
    const candidates = await reader.listCandidates();
    expect(candidates).toHaveLength(DEFAULT_MAX_DELEGATED_FAILURE_CANDIDATES);
  });

  it('warns once per failed poll and again on the next poll, never more than once per interval', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    let clock = 1_000_000;
    const listNamespacedCustomObject = vi.fn(async () => { throw Object.assign(new Error('Forbidden'), { statusCode: 403 }); });
    const reader = new DelegatedFailureReader({
      client: { listNamespacedCustomObject }, namespace: 'ct-review-system', now: () => clock, pollIntervalMs: 15_000,
    });
    await reader.listCandidates();
    await reader.listCandidates(); // inside the interval: served from cache, no list, no warning
    expect(listNamespacedCustomObject).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    clock += 15_000;
    await reader.listCandidates();
    expect(listNamespacedCustomObject).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
