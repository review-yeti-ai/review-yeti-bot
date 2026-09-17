import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MAX_DELEGATED_FAILURE_CANDIDATES,
  DelegatedFailureReader,
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
  const listNamespacedCustomObject = vi.fn(async () => ({ items }));
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
  it('lists prreviewjobs in the exact group/version/namespace/plural', async () => {
    const { reader, listNamespacedCustomObject } = readerWith([]);
    await reader.listCandidates();
    expect(listNamespacedCustomObject).toHaveBeenCalledWith({
      group: 'review-yeti.ai', version: 'v1alpha2', namespace: 'ct-review-system', plural: 'prreviewjobs',
    });
  });

  it.each([
    ['WorkerFailed', 'worker_failed'],
    ['DeadlineExpired', 'worker_deadline_exceeded'],
    ['WorkerJobMissing', 'worker_job_missing'],
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
