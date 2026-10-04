import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultV3Config } from '../../src/config/configLoader';
import { ctReviewConfigV3Schema } from '../../src/config/schema';
import {
  COMPOSED_TASK_MAX_EXTRA_ATTEMPTS,
  COMPOSED_TASK_RETRY_MIN_WINDOW_MS,
  decideComposedTaskRetry,
  executeComposedReview,
  isComposedTaskStall,
  isRetryableComposedTaskFailure,
} from '../../src/panel/composedEngine';
import { extractMessageContentText } from '../../src/panel/panelEngine';
import { OpenRouterTimeoutError, type ReviewModelClient } from '../../src/gateway/openRouterClient';
import { parseChangedFiles } from '../../src/review/changedFiles';

// One composed task that stalls or returns an unusable final result must cost that task one
// fresh attempt, not the whole review. These tests drive the real engine; the only double is the
// model client, which keys its behaviour on the task id and on the per-attempt nonce the engine
// mints, so they do not depend on how many times `callTurn` itself retries one request.

const changedFiles = parseChangedFiles([
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1 +1,2 @@',
  '-export const value = 1;',
  '+export const value = 2;',
  '+export const other = 3;',
  '',
].join('\n')).files;

const TASKS = ['task-1', 'task-2', 'task-3'].map((id, index) => ({
  id,
  dimension: (['security', 'contract', 'architecture'] as const)[index],
  paths: ['src/app.ts'],
  question: `Review change ${index + 1}.`,
  rationale: 'Check the changed behaviour.',
}));

const FINDING = {
  severity: 'P2', path: 'src/app.ts', line: 2, title: 'Unused export',
  body: 'The new export is never imported.', confidence: 80,
};

function configFor(overallTimeoutS = 1_200, maxTurnsPerTask = 4) {
  return ctReviewConfigV3Schema.parse({
    ...createDefaultV3Config(),
    quorum: 1,
    personas: [{ id: 'architecture', enabled: true, required: true, charter: 'builtin:architecture', paths: ['**/*'], providers: ['bifrost'] }],
    reviewers: {
      execution: 'personas', fallback: 'none', overall_timeout_s: overallTimeoutS,
      providers: [{ id: 'bifrost', enabled: true, model: 'pr-reviewer', effort: 'medium', review_timeout_s: 15, arbiter_timeout_s: 15 }],
      arbiter: { order: ['bifrost'] },
    },
    review_engine: 'composed',
    composed: { max_tasks: 3, max_turns_per_task: maxTurnsPerTask },
  });
}

function requestText(request: any): string {
  return request.messages.map((message: any) => extractMessageContentText(message.content)).join('\n');
}

function nonceIn(text: string): string {
  const nonce = [...text.matchAll(/CT_REVIEW_NONCE:([a-f0-9-]+)/gu)].at(-1)?.[1];
  if (!nonce) throw new Error('composed request did not contain its nonce');
  return nonce;
}

function taskIdIn(text: string): string {
  const id = [...text.matchAll(/^Task id: ([a-z0-9_-]+)/gmu)].at(-1)?.[1];
  if (!id) throw new Error('composed work request did not contain its task id');
  return id;
}

function response(content: unknown) {
  return { model: 'pr-reviewer', content: typeof content === 'string' ? content : JSON.stringify(content),
    usage: { prompt: 1, completion: 1, total: 2 }, costUSD: 0, raw: {} };
}

type Behaviour = (input: { taskId: string; nonce: string; attempt: number; callInAttempt: number }) => unknown;

/** A client that records provider calls and distinct attempts (nonces) per task. */
function recordingClient(behaviour: Behaviour, onCall?: () => void) {
  const callsByTask = new Map<string, number>();
  const noncesByTask = new Map<string, string[]>();
  const callsByNonce = new Map<string, number>();
  let planCalls = 0;
  const complete = vi.fn(async (request: any) => {
    onCall?.();
    const text = requestText(request);
    const nonce = nonceIn(text);
    if (!text.includes('=== WORK TURN: TASK')) {
      planCalls += 1;
      return response({ nonce, tasks: TASKS });
    }
    const taskId = taskIdIn(text);
    callsByTask.set(taskId, (callsByTask.get(taskId) ?? 0) + 1);
    const nonces = noncesByTask.get(taskId) ?? [];
    if (!nonces.includes(nonce)) nonces.push(nonce);
    noncesByTask.set(taskId, nonces);
    callsByNonce.set(nonce, (callsByNonce.get(nonce) ?? 0) + 1);
    const outcome = behaviour({ taskId, nonce, attempt: nonces.indexOf(nonce) + 1, callInAttempt: callsByNonce.get(nonce)! });
    if (outcome instanceof Error) throw outcome;
    return response(outcome);
  });
  return {
    client: { complete } as unknown as ReviewModelClient,
    complete,
    callsByTask,
    attempts: (taskId: string) => noncesByTask.get(taskId)?.length ?? 0,
    planCalls: () => planCalls,
  };
}

const clean = (taskId: string, nonce: string) => ({ nonce, task: taskId, status: 'COMPLETE', findings: [] });

const malformedVariants = {
  invalid_findings: (taskId: string, nonce: string) => ({ nonce, task: taskId, status: 'COMPLETE', findings: 'not-a-list' }),
  nonce_mismatch: (taskId: string) => ({ nonce: '00000000-0000-4000-8000-000000000000', task: taskId, status: 'COMPLETE', findings: [] }),
  non_json_task_result: () => 'this is not json',
} as const;

function stall() {
  return new OpenRouterTimeoutError('Streaming stalled: no meaningful data received from provider for 120s', 'inactivity');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('composed task-level retry', () => {
  it.each(Object.keys(malformedVariants) as Array<keyof typeof malformedVariants>)(
    'reruns only the task whose first attempt ended in %s and completes the review in one run',
    async (variant) => {
      const harness = recordingClient(({ taskId, nonce, attempt }) => {
        if (taskId === 'task-2' && attempt === 1) return malformedVariants[variant](taskId, nonce);
        if (taskId === 'task-2') return { nonce, task: taskId, status: 'COMPLETE', findings: [FINDING] };
        return clean(taskId, nonce);
      });
      const saved: any[] = [];
      const result = await executeComposedReview({
        config: configFor(), changedFiles, repository: 'acme/app', headSha: 'a'.repeat(40), client: harness.client,
        checkpoint: { save: async (snapshot: any) => { saved.push(structuredClone(snapshot)); } } as never,
      });

      expect(result.unreportedLanes).toEqual([]);
      expect(result.optionalFailures).toEqual([]);
      expect(result.personas.map((lane) => lane.id)).toEqual(['task-1', 'task-2', 'task-3']);
      expect(result.personas.find((lane) => lane.id === 'task-2')).toMatchObject({
        decision: 'FINDINGS', findings: [expect.objectContaining({ path: 'src/app.ts', line: 2, title: 'Unused export' })],
      });
      expect(result.quorum.satisfied).toBe(true);
      // The defective task ran a second, fresh attempt; its siblings ran exactly one call each.
      expect(harness.attempts('task-2')).toBe(2);
      expect(harness.callsByTask.get('task-1')).toBe(1);
      expect(harness.callsByTask.get('task-3')).toBe(1);
      expect(harness.planCalls()).toBe(1);
      // The retried task is recorded once in the exact-head checkpoint.
      const latest = saved.at(-1);
      expect(latest.completedTasks.map((task: any) => task.id).sort()).toEqual(['task-1', 'task-2', 'task-3']);
      expect(new Set(latest.completedTasks.map((task: any) => task.id)).size).toBe(latest.completedTasks.length);
    },
  );

  it('reruns a stalled task alone and never re-runs completed siblings', async () => {
    const harness = recordingClient(({ taskId, nonce, attempt }) => {
      if (taskId === 'task-2' && attempt === 1) return stall();
      return clean(taskId, nonce);
    });
    const result = await executeComposedReview({
      config: configFor(), changedFiles, repository: 'acme/app', headSha: 'b'.repeat(40), client: harness.client,
    });

    expect(result.personas.map((lane) => lane.id)).toEqual(['task-1', 'task-2', 'task-3']);
    expect(result.optionalFailures).toEqual([]);
    expect(result.unreportedLanes).toEqual([]);
    expect(harness.attempts('task-2')).toBe(2);
    expect(harness.callsByTask.get('task-1')).toBe(1);
    expect(harness.callsByTask.get('task-3')).toBe(1);
  }, 20_000);

  it('keeps a non-timeout task error fatal: it is neither retried nor recorded as a timeout lane', async () => {
    const harness = recordingClient(({ taskId, nonce }) => (
      taskId === 'task-2' ? new Error('provider exploded') : clean(taskId, nonce)));
    await expect(executeComposedReview({
      config: configFor(), changedFiles, repository: 'acme/app', headSha: '4'.repeat(40), client: harness.client,
    })).rejects.toThrow('provider exploded');
    expect(harness.attempts('task-2')).toBe(1);
  });

  it('resumes an exact-head checkpoint, retries only the pending task, and records it once', async () => {
    const priorSnapshots: any[] = [];
    const priorClient = recordingClient(({ taskId, nonce }) => clean(taskId, nonce));
    await executeComposedReview({ config: configFor(), changedFiles, repository: 'acme/app',
      headSha: 'c'.repeat(40), client: priorClient.client,
      checkpoint: { save: async (snapshot: any) => { priorSnapshots.push(structuredClone(snapshot)); } } as never });
    const deliveredTasks = priorSnapshots.at(-1).completedTasks.filter((task: any) => task.id !== 'task-3');
    const harness = recordingClient(({ taskId, nonce, attempt }) => (
      taskId === 'task-3' && attempt === 1 ? malformedVariants.nonce_mismatch(taskId) : clean(taskId, nonce)));
    const saved: any[] = [];
    const result = await executeComposedReview({
      config: configFor(), changedFiles, repository: 'acme/app', headSha: 'c'.repeat(40), client: harness.client,
      checkpoint: {
        resumed: { revision: 3, plan: TASKS, completedTasks: deliveredTasks },
        save: async (snapshot: any) => { saved.push(structuredClone(snapshot)); },
      } as never,
    });

    expect(harness.planCalls()).toBe(0);
    expect(harness.callsByTask.has('task-1')).toBe(false);
    expect(harness.callsByTask.has('task-2')).toBe(false);
    expect(harness.attempts('task-3')).toBe(2);
    expect(result.personas.map((lane) => lane.id)).toEqual(['task-1', 'task-2', 'task-3']);
    const latest = saved.at(-1);
    expect(latest.revision).toBeGreaterThan(3);
    expect(latest.completedTasks.map((task: any) => task.id)).toEqual(['task-1', 'task-2', 'task-3']);
  });

  it('names the task, reason and attempt count when every fresh attempt is malformed', async () => {
    const harness = recordingClient(({ taskId, nonce }) => (
      taskId === 'task-2' ? malformedVariants.invalid_findings(taskId, nonce) : clean(taskId, nonce)));
    const result = await executeComposedReview({
      config: configFor(), changedFiles, repository: 'acme/app', headSha: 'd'.repeat(40), client: harness.client,
    });

    expect(harness.attempts('task-2')).toBe(1 + COMPOSED_TASK_MAX_EXTRA_ATTEMPTS);
    expect(harness.callsByTask.get('task-1')).toBe(1);
    expect(harness.callsByTask.get('task-3')).toBe(1);
    expect(result.personas.map((lane) => lane.id)).toEqual(['task-1', 'task-3']);
    expect(result.unreportedLanes).toHaveLength(1);
    const [lane] = result.unreportedLanes!;
    expect(lane).toMatchObject({ id: 'task-2', failureClass: 'malformed_output', diagnostics: { reason: 'invalid_findings' } });
    expect(lane.error).toContain('Task task-2 (contract) ran and produced no verdict after 3 fresh attempts');
    expect(lane.error).toContain('reason=invalid_findings');
    expect(lane.error).toContain('[src/app.ts]');
    expect(lane.error).toMatch(/exact-head rerun/u);
    // Diagnostics describe the final attempt only (max_turns_per_task=4), not the cumulative spend.
    expect(lane.diagnostics!.turnsUsed).toBeLessThanOrEqual(4);
    // The roster gap is the task's own; the review did not abort or fabricate a verdict lane.
    expect(result.applicablePersonaIds).toEqual(['task-1', 'task-2', 'task-3']);
  });

  it('records a task that stalls on every attempt as a named timeout lane without aborting its siblings', async () => {
    const harness = recordingClient(({ taskId, nonce }) => (taskId === 'task-2' ? stall() : clean(taskId, nonce)));
    const result = await executeComposedReview({
      config: configFor(), changedFiles, repository: 'acme/app', headSha: 'e'.repeat(40), client: harness.client,
    });

    expect(harness.attempts('task-2')).toBe(1 + COMPOSED_TASK_MAX_EXTRA_ATTEMPTS);
    expect(result.personas.map((lane) => lane.id)).toEqual(['task-1', 'task-3']);
    expect(result.unreportedLanes).toEqual([]);
    expect(result.optionalFailures).toEqual([expect.objectContaining({ id: 'task-2', failureClass: 'timeout' })]);
    expect(result.optionalFailures[0].error).toContain('stalled on a provider timeout in 3 fresh attempt(s) (retries exhausted)');
    expect(result.optionalFailures[0].error).toContain('[src/app.ts]');
    expect(result.quorum.satisfied).toBe(false);
  }, 30_000);

  it('names the evidence cutoff when a stalled task cannot fit another attempt', async () => {
    // The first stalled call jumps the injected clock to 15 minutes in, so the failed attempt
    // (at least 15 minutes) cannot be repeated in the 5 minutes left before the 20-minute cutoff.
    const startMs = 1_700_000_000_000;
    let nowMs = startMs;
    const harness = recordingClient(({ taskId, nonce }) => {
      if (taskId !== 'task-2') return clean(taskId, nonce);
      nowMs = Math.max(nowMs, startMs + 15 * 60_000);
      return stall();
    });
    const result = await executeComposedReview({
      config: configFor(), changedFiles, repository: 'acme/app', headSha: '2'.repeat(40), client: harness.client,
      deadlineBudget: { deadlineAtMs: startMs + 20 * 60_000, timeoutMs: 20 * 60_000, terminalBound: true },
      deadlineNow: () => nowMs,
    });

    expect(harness.attempts('task-2')).toBe(1);
    expect(result.optionalFailures).toEqual([expect.objectContaining({ id: 'task-2', failureClass: 'timeout' })]);
    expect(result.optionalFailures[0].error)
      .toContain('stalled on a provider timeout in 1 fresh attempt(s) (no time left before the evidence cutoff for another attempt)');
  }, 20_000);

  it('names the turn budget when a stalled task cannot be funded for another attempt', async () => {
    // A 7-turn review: plan (1) + task-1 (1) leaves task-2 a partial 5-turn tail. It spends two
    // read-only turns and then stalls; the 3 turns left cannot fund a bound retry (4).
    vi.stubEnv('COMPOSED_ENGINE_MAX_TURNS', '7');
    const harness = recordingClient(({ taskId, nonce, callInAttempt }) => {
      if (taskId !== 'task-2') return clean(taskId, nonce);
      return callInAttempt <= 2 ? { tool: 'read_file', args: { path: 'src/app.ts' } } : stall();
    });
    const result = await executeComposedReview({
      config: configFor(1_200, 6), changedFiles, repository: 'acme/app', headSha: '3'.repeat(40), client: harness.client,
    });

    expect(harness.attempts('task-2')).toBe(1);
    expect(result.optionalFailures).toEqual([expect.objectContaining({ id: 'task-2', failureClass: 'timeout' })]);
    expect(result.optionalFailures[0].error)
      .toContain('stalled on a provider timeout in 1 fresh attempt(s) (no review turn budget left for another attempt)');
    expect(result.personas.map((lane) => lane.id)).toEqual(['task-1', 'task-3']);
  }, 20_000);

  it('starts no retry that cannot finish before the evidence cutoff', async () => {
    // The injected clock advances four minutes per task-2 call. One attempt (a final turn, one
    // correction and one fresh recovery turn) takes twelve minutes, so another one is expected to
    // take twelve too; only eight minutes remain when the first attempt fails.
    let nowMs = 1_700_000_000_000;
    const harness = recordingClient(({ taskId, nonce }) => {
      if (taskId !== 'task-2') return clean(taskId, nonce);
      nowMs += 4 * 60_000;
      return malformedVariants.invalid_findings(taskId, nonce);
    });
    const result = await executeComposedReview({
      config: configFor(), changedFiles, repository: 'acme/app', headSha: 'f'.repeat(40), client: harness.client,
      deadlineBudget: { deadlineAtMs: nowMs + 20 * 60_000, timeoutMs: 20 * 60_000, terminalBound: true },
      deadlineNow: () => nowMs,
    });

    expect(harness.attempts('task-2')).toBe(1);
    expect(result.unreportedLanes).toEqual([expect.objectContaining({ id: 'task-2', failureClass: 'malformed_output' })]);
    expect(result.unreportedLanes![0].error).not.toContain('fresh attempts');
  });

  it('starts no retry under a short admitted window and leaves existing single-attempt evidence unchanged', async () => {
    const harness = recordingClient(({ taskId, nonce }) => (
      taskId === 'task-2' ? malformedVariants.nonce_mismatch(taskId) : clean(taskId, nonce)));
    const result = await executeComposedReview({
      config: configFor(30), changedFiles, repository: 'acme/app', headSha: '1'.repeat(40), client: harness.client,
    });
    expect(harness.attempts('task-2')).toBe(1);
    expect(result.unreportedLanes).toEqual([expect.objectContaining({ id: 'task-2',
      diagnostics: expect.objectContaining({ reason: 'nonce_mismatch' }) })]);
  });
});

describe('decideComposedTaskRetry', () => {
  const base = {
    attemptsUsed: 1, nowMs: 0, deadlineAtMs: 20 * 60_000, failedAttemptDurationMs: 90_000,
    settledTaskDurationsMs: [], availableTurns: 40, taskTurnCeiling: 12,
  };

  it('allows up to the bounded number of extra attempts', () => {
    expect(decideComposedTaskRetry({ ...base, attemptsUsed: 1 })).toMatchObject({ retry: true, turns: 12 });
    expect(decideComposedTaskRetry({ ...base, attemptsUsed: 1 + COMPOSED_TASK_MAX_EXTRA_ATTEMPTS - 1 })).toMatchObject({ retry: true });
    expect(decideComposedTaskRetry({ ...base, attemptsUsed: 1 + COMPOSED_TASK_MAX_EXTRA_ATTEMPTS }))
      .toMatchObject({ retry: false, reason: 'attempts_exhausted' });
  });

  it('requires the longest of the floor, the failed attempt and the settled mean before the cutoff', () => {
    expect(decideComposedTaskRetry({ ...base, failedAttemptDurationMs: 1_000 }).requiredWindowMs)
      .toBe(COMPOSED_TASK_RETRY_MIN_WINDOW_MS);
    expect(decideComposedTaskRetry({ ...base, settledTaskDurationsMs: [300_000, 500_000] }).requiredWindowMs).toBe(400_000);
    expect(decideComposedTaskRetry({ ...base, nowMs: base.deadlineAtMs - 89_999 }))
      .toMatchObject({ retry: false, reason: 'deadline', requiredWindowMs: 90_000 });
    expect(decideComposedTaskRetry({ ...base, nowMs: base.deadlineAtMs - 90_000 })).toMatchObject({ retry: true });
    expect(decideComposedTaskRetry({ ...base, deadlineAtMs: undefined, nowMs: 1e15 })).toMatchObject({ retry: true });
  });

  it('draws only unreserved turns and keeps a bound finalization window', () => {
    expect(decideComposedTaskRetry({ ...base, availableTurns: 7 })).toMatchObject({ retry: true, turns: 7 });
    expect(decideComposedTaskRetry({ ...base, availableTurns: 3 })).toMatchObject({ retry: false, reason: 'turn_budget' });
    expect(decideComposedTaskRetry({ ...base, availableTurns: 1, taskTurnCeiling: 1 })).toMatchObject({ retry: true, turns: 1 });
    expect(decideComposedTaskRetry({ ...base, availableTurns: 0, taskTurnCeiling: 1 })).toMatchObject({ retry: false, reason: 'turn_budget' });
  });

  it('classifies only final-result defects and provider timeouts as retryable', () => {
    expect(isRetryableComposedTaskFailure('nonce_mismatch')).toBe(true);
    expect(isRetryableComposedTaskFailure('invalid_findings')).toBe(true);
    expect(isRetryableComposedTaskFailure('total_turn_budget_exhausted')).toBe(false);
    expect(isRetryableComposedTaskFailure('task_turn_budget_exhausted')).toBe(false);
    expect(isComposedTaskStall(stall())).toBe(true);
    expect(isComposedTaskStall(new Error('fatal composed task failure'))).toBe(false);
  });
});
