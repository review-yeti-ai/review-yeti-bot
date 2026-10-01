import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultV3Config } from '../../src/config/configLoader';
import { ctReviewConfigV3Schema } from '../../src/config/schema';
import { executeComposedReview, resolveComposedTaskConcurrency } from '../../src/panel/composedEngine';
import { extractMessageContentText } from '../../src/panel/panelEngine';
import type { ReviewModelClient } from '../../src/gateway/openRouterClient';
import { parseChangedFiles } from '../../src/review/changedFiles';
import type { PublishingProgressEvent } from '../../src/telemetry/publishingProgress';

const changedFiles = parseChangedFiles([
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1 +1 @@',
  '-export const value = 1;',
  '+export const value = 2;',
  '',
].join('\n')).files;

function taskPlan(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `task-${index + 1}`,
    dimension: 'architecture',
    paths: ['src/app.ts'],
    question: `Review change ${index + 1}.`,
    rationale: 'Check the changed behavior and its callers.',
  }));
}

function configFor(taskCount: number, totalTurns = 100, taskTurns = 12) {
  return ctReviewConfigV3Schema.parse({
    ...createDefaultV3Config(),
    quorum: 1,
    personas: [{ id: 'architecture', enabled: true, required: true, charter: 'builtin:architecture', paths: ['**/*'], providers: ['bifrost'] }],
    reviewers: {
      execution: 'personas', fallback: 'none', overall_timeout_s: 30,
      providers: [{ id: 'bifrost', enabled: true, model: 'pr-reviewer', effort: 'medium', review_timeout_s: 15, arbiter_timeout_s: 15 }],
      arbiter: { order: ['bifrost'] },
    },
    review_engine: 'composed',
    composed: { max_tasks: taskCount, max_turns_total: totalTurns, max_turns_per_task: taskTurns },
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
  return {
    model: 'pr-reviewer',
    content: JSON.stringify(content),
    usage: { prompt: 1, completion: 1, total: 2 },
    costUSD: 0,
    raw: {},
  };
}

function planResponse(request: any, taskCount: number) {
  const text = requestText(request);
  return response({ nonce: nonceIn(text), tasks: taskPlan(taskCount) });
}

function taskResponse(request: any, status: 'COMPLETE' | 'BLOCKED' = 'COMPLETE') {
  const text = requestText(request);
  return response({ nonce: nonceIn(text), task: taskIdIn(text), status, findings: [] });
}

function isWorkRequest(request: any): boolean {
  return requestText(request).includes('=== WORK TURN: TASK');
}

async function runReview(
  taskCount: number,
  totalTurns: number,
  complete: ReviewModelClient['complete'],
  options: Record<string, unknown> = {},
) {
  vi.stubEnv('COMPOSED_ENGINE_MAX_TURNS', String(totalTurns));
  return executeComposedReview({
    config: configFor(taskCount, totalTurns),
    changedFiles,
    repository: 'acme/app',
    headSha: 'c'.repeat(40),
    client: { complete } as ReviewModelClient,
    ...options,
  });
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function waitForStarted(promise: Promise<void>): Promise<void> {
  await Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out waiting for composed task')), 2_000)),
  ]);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('work-conserving composed task scheduling', () => {
  it('dispatches later tasks as slots free while preserving isolated context and plan-order results', async () => {
    const taskOneGate = deferred<void>();
    const taskThreeGate = deferred<void>();
    const taskFourGate = deferred<void>();
    const taskThreeStarted = deferred<void>();
    const taskFourStarted = deferred<void>();
    const taskFiveStarted = deferred<void>();
    const taskFourPrompt = deferred<string>();
    const taskFivePrompt = deferred<string>();
    const complete = vi.fn(async (request: any) => {
      if (!isWorkRequest(request)) return planResponse(request, 5);
      const text = requestText(request);
      const id = taskIdIn(text);
      if (id === 'task-1') await taskOneGate.promise;
      if (id === 'task-3') { taskThreeStarted.resolve(); await taskThreeGate.promise; }
      if (id === 'task-4') { taskFourPrompt.resolve(text); taskFourStarted.resolve(); await taskFourGate.promise; }
      if (id === 'task-5') { taskFivePrompt.resolve(text); taskFiveStarted.resolve(); }
      return taskResponse(request);
    });

    const run = runReview(5, 100, complete);
    await waitForStarted(taskThreeStarted.promise);
    // Task 2 settles, freeing a slot while tasks 1 and 3 remain active. Task 4 gets its own
    // scoped branch, without raw completion receipts from task 2 or a summary outside the
    // contiguous settled prefix.
    await waitForStarted(taskFourStarted.promise);
    const taskFourContext = await taskFourPrompt.promise;
    expect(taskFourContext.split('\n').filter((line) => /^- Task task-\d+ \(/u.test(line))).toEqual([]);
    expect(taskFourContext).not.toContain('[TASK task-2 COMPLETE');
    expect(taskFourContext).not.toContain('Task task-2 (architecture, paths [src/app.ts])');
    expect(taskFourContext).not.toContain('=== SWARM CONTEXT: PRIOR SETTLED TASKS');
    expect(taskFourContext).toContain('Task id: task-4');
    expect(taskFourContext).toContain('Question: Review change 4.');
    expect(taskFourContext).toContain('+export const value = 2;');
    expect(taskThreeGate.promise).toBeDefined();

    // Once task 1 settles, the plan-ordered summary includes tasks 1 and 2. Task 3 is still
    // pending and task 4 remains blocked, so neither later task appears in task 5's context.
    taskOneGate.resolve();
    await waitForStarted(taskFiveStarted.promise);
    const taskFiveContext = await taskFivePrompt.promise;
    expect(taskFiveContext).toContain('=== PR CHANGED FILES & DIFF SCOPE (ALL FILES -- UNSCOPED) ===');
    expect(taskFiveContext).toContain('+export const value = 2;');
    expect(taskFiveContext).toContain('=== SWARM CONTEXT: PRIOR SETTLED TASKS (2 completed) ===');
    expect(taskFiveContext).toContain('- Task task-1 (architecture, paths [src/app.ts]): CLEAN (0 findings)');
    expect(taskFiveContext).toContain('- Task task-2 (architecture, paths [src/app.ts]): CLEAN (0 findings)');
    expect(taskFiveContext.split('\n').filter((line) => /^- Task task-\d+ \(/u.test(line))).toEqual([
      '- Task task-1 (architecture, paths [src/app.ts]): CLEAN (0 findings)',
      '- Task task-2 (architecture, paths [src/app.ts]): CLEAN (0 findings)',
    ]);
    for (let taskNumber = 1; taskNumber < 5; taskNumber += 1) {
      expect(taskFiveContext).not.toContain(`[TASK task-${taskNumber} COMPLETE`);
    }
    expect(taskFiveContext).not.toContain('Task task-3 (architecture, paths [src/app.ts])');
    expect(taskFiveContext).not.toContain('Task task-4 (architecture, paths [src/app.ts])');
    expect(taskFiveContext).toContain('=== WORK TURN: TASK 5 OF 5 ===');
    expect(taskFiveContext).toContain('Task id: task-5');
    expect(taskFiveContext).toContain('Question: Review change 5.');

    taskFourGate.resolve();
    taskThreeGate.resolve();
    const result = await run;
    expect(result.personas.map((persona) => persona.id)).toEqual(taskPlan(5).map((task) => task.id));
    expect(result.unreportedLanes).toEqual([]);
  });

  it('defers a partial tail while reservations are active, then admits the full ceiling after refund', async () => {
    const taskOneGate = deferred<void>();
    const taskOneStarted = deferred<void>();
    const taskTwoStarted = deferred<void>();
    const taskCalls: string[] = [];
    const complete = vi.fn(async (request: any) => {
      if (!isWorkRequest(request)) return planResponse(request, 2);
      const id = taskIdIn(requestText(request));
      taskCalls.push(id);
      if (id === 'task-1') { taskOneStarted.resolve(); await taskOneGate.promise; }
      if (id === 'task-2') taskTwoStarted.resolve();
      return taskResponse(request);
    });

    const run = runReview(2, 21, complete);
    await waitForStarted(taskOneStarted.promise);
    await Promise.resolve();
    expect(taskCalls).toEqual(['task-1']);
    taskOneGate.resolve();
    await waitForStarted(taskTwoStarted.promise);
    const result = await run;
    expect(result.personas.map((persona) => persona.id)).toEqual(['task-1', 'task-2']);
    expect(taskCalls).toContain('task-2');
  });

  it('uses a partial final reservation only after active work settles and refunds its unused turns', async () => {
    const taskCalls = new Map<string, number>();
    const complete = vi.fn(async (request: any) => {
      if (!isWorkRequest(request)) return planResponse(request, 2);
      const id = taskIdIn(requestText(request));
      const count = (taskCalls.get(id) ?? 0) + 1;
      taskCalls.set(id, count);
      if (id === 'task-1' && count === 9) return taskResponse(request);
      return response({ tool: 'read_file', args: { path: 'src/app.ts' } });
    });

    const result = await runReview(2, 21, complete);
    expect(taskCalls.get('task-1')).toBe(9);
    // The plan uses one turn; task 1 refunds three of its 12 reserved turns, leaving an 11-turn
    // serial tail. Task 2 receives that tail only after task 1 has settled.
    expect(taskCalls.get('task-2')).toBe(11);
    expect(complete).toHaveBeenCalledTimes(21);
    expect(result.personas.map((persona) => persona.id)).toEqual(['task-1']);
    expect(result.unreportedLanes).toMatchObject([{ id: 'task-2', diagnostics: { turnsUsed: 11 } }]);
  });

  it('keeps completed usage plus full in-flight reservations within the total cap', async () => {
    const taskCalls = new Map<string, number>();
    const started = new Set<string>();
    let activeCalls = 0;
    let maximumActiveCalls = 0;
    const complete = vi.fn(async (request: any) => {
      if (!isWorkRequest(request)) return planResponse(request, 5);
      const id = taskIdIn(requestText(request));
      started.add(id);
      taskCalls.set(id, (taskCalls.get(id) ?? 0) + 1);
      activeCalls += 1;
      maximumActiveCalls = Math.max(maximumActiveCalls, activeCalls);
      await Promise.resolve();
      activeCalls -= 1;
      // Keep asking for read-only evidence through the finalization window. The task must
      // exhaust exactly its reserved 12-turn slice; no third task can overspend the 24 turns
      // left after the one-turn plan.
      return response({ tool: 'read_file', args: { path: 'src/app.ts' } });
    });

    const result = await runReview(5, 25, complete);
    expect(complete).toHaveBeenCalledTimes(25);
    expect(started).toEqual(new Set(['task-1', 'task-2']));
    expect([...taskCalls.values()]).toEqual([12, 12]);
    expect(maximumActiveCalls).toBeLessThanOrEqual(2);
    expect(result.unreportedLanes).toHaveLength(5);
    expect(result.unreportedLanes?.slice(0, 2).every((lane) => lane.diagnostics?.turnsUsed === 12)).toBe(true);
    expect(result.unreportedLanes?.slice(2).every((lane) => lane.error.includes('did not start'))).toBe(true);
  });

  it('stops dispatching after a fatal task, aborts active siblings, and waits for them to settle', async () => {
    const allInitialTasksStarted = deferred<void>();
    const failTaskOne = deferred<void>();
    const fatal = new Error('fatal composed task failure');
    const startedTasks = new Set<string>();
    const abortedTasks = new Set<string>();
    let activeCalls = 0;
    const complete = vi.fn(async (request: any) => {
      if (!isWorkRequest(request)) return planResponse(request, 4);
      const id = taskIdIn(requestText(request));
      startedTasks.add(id);
      if (startedTasks.size === 3) allInitialTasksStarted.resolve();
      activeCalls += 1;
      if (id === 'task-1') {
        await failTaskOne.promise;
        activeCalls -= 1;
        throw fatal;
      }
      return new Promise<any>((_, reject) => {
        const signal = request.signal as AbortSignal;
        const onAbort = () => {
          activeCalls -= 1;
          abortedTasks.add(id);
          reject(signal.reason);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      });
    });

    const run = runReview(4, 100, complete);
    const rejectedRun = expect(run).rejects.toThrow('fatal composed task failure');
    await waitForStarted(allInitialTasksStarted.promise);
    failTaskOne.resolve();
    await rejectedRun;
    expect(startedTasks).toEqual(new Set(['task-1', 'task-2', 'task-3']));
    expect(abortedTasks).toEqual(new Set(['task-2', 'task-3']));
    expect(activeCalls).toBe(0);
  });

  it('does not dispatch queued work when a fatal rejection races a sibling success', async () => {
    const allInitialTasksStarted = deferred<void>();
    const taskOneSuccess = deferred<void>();
    const taskTwoFailure = deferred<void>();
    const fatal = new Error('fatal task two');
    const startedTasks = new Set<string>();
    const abortedTasks = new Set<string>();
    const taskProgress: string[] = [];
    let activeCalls = 0;
    const progress = {
      emit(event: PublishingProgressEvent) {
        if (event.role !== 'composed_task' || !event.lane) return;
        taskProgress.push(`${event.lane}:${event.status}`);
      },
      instrument(client: ReviewModelClient) { return client; },
    };
    const complete = vi.fn(async (request: any) => {
      if (!isWorkRequest(request)) return planResponse(request, 4);
      const id = taskIdIn(requestText(request));
      startedTasks.add(id);
      if (startedTasks.size === 3) allInitialTasksStarted.resolve();
      activeCalls += 1;
      if (id === 'task-1') {
        await taskOneSuccess.promise;
        activeCalls -= 1;
        return taskResponse(request);
      }
      if (id === 'task-2') {
        await taskTwoFailure.promise;
        activeCalls -= 1;
        throw fatal;
      }
      return new Promise<any>((_, reject) => {
        const signal = request.signal as AbortSignal;
        const onAbort = () => {
          activeCalls -= 1;
          abortedTasks.add(id);
          reject(signal.reason);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      });
    });

    const run = runReview(4, 100, complete, { progress });
    const rejectedRun = expect(run).rejects.toThrow('fatal task two');
    await waitForStarted(allInitialTasksStarted.promise);
    // Settle a successful sibling and a fatal sibling in the same turn. The recorded progress
    // order makes the observed outcomes explicit; the fatal task must be noticed before the
    // queued task is dispatched, and all active wrappers must settle before the run rejects.
    taskOneSuccess.resolve();
    taskTwoFailure.resolve();
    await rejectedRun;
    expect(startedTasks).toEqual(new Set(['task-1', 'task-2', 'task-3']));
    expect(abortedTasks).toEqual(new Set(['task-3']));
    const successfulSiblingIndex = taskProgress.indexOf('composed-task-1:completed');
    const fatalSiblingIndex = taskProgress.indexOf('composed-task-2:failed');
    const queuedTaskIndex = taskProgress.indexOf('composed-task-4:skipped');
    expect(successfulSiblingIndex).toBeGreaterThanOrEqual(0);
    expect(fatalSiblingIndex).toBeGreaterThan(successfulSiblingIndex);
    expect(queuedTaskIndex).toBeGreaterThan(fatalSiblingIndex);
    expect(activeCalls).toBe(0);
  });

  it('aborts active siblings at the admitted absolute deadline and starts no queued task', async () => {
    vi.useFakeTimers();
    const startedTasks = new Set<string>();
    const abortedTasks = new Set<string>();
    const allInitialTasksStarted = deferred<void>();
    const planStarted = deferred<void>();
    const planGate = deferred<void>();
    const deadlineAtMs = Date.now() + 1_000;
    let activeCalls = 0;
    const complete = vi.fn(async (request: any) => {
      if (!isWorkRequest(request)) {
        const planned = planResponse(request, 4);
        planStarted.resolve();
        await planGate.promise;
        return planned;
      }
      const id = taskIdIn(requestText(request));
      startedTasks.add(id);
      if (startedTasks.size === 3) allInitialTasksStarted.resolve();
      activeCalls += 1;
      return new Promise<any>((_, reject) => {
        const signal = request.signal as AbortSignal;
        const onAbort = () => {
          activeCalls -= 1;
          abortedTasks.add(id);
          reject(signal.reason);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      });
    });
    const run = runReview(4, 100, complete, {
      deadlineBudget: { deadlineAtMs, timeoutMs: 1_000, terminalBound: true },
      deadlineNow: () => Date.now(),
    });
    await planStarted.promise;
    // The admitted deadline keeps running during planning; task calls must abort at the original
    // one-second cutoff rather than receive a fresh window after planning completes.
    await vi.advanceTimersByTimeAsync(600);
    planGate.resolve();
    await allInitialTasksStarted.promise;
    await vi.advanceTimersByTimeAsync(400);
    const result = await run;
    expect(startedTasks).toEqual(new Set(['task-1', 'task-2', 'task-3']));
    expect(abortedTasks).toEqual(startedTasks);
    expect(activeCalls).toBe(0);
    expect(result.gracefulExit).toEqual({
      reason: 'evidence_deadline',
      completedTaskIds: [],
      pendingTaskIds: ['task-1', 'task-2', 'task-3', 'task-4'],
    });
    expect(result.quorum.satisfied).toBe(false);
    expect(result.optionalFailures).toEqual([]);
    expect(result.unreportedLanes?.map((lane) => [lane.id, lane.failureClass])).toEqual([
      ['task-1', 'timeout'],
      ['task-2', 'timeout'],
      ['task-3', 'timeout'],
      ['task-4', 'timeout'],
    ]);
  });

  it('keeps composed concurrency capped by the operator and publisher shadow at one', () => {
    expect(resolveComposedTaskConcurrency({ REVIEW_YETI_MAX_CONCURRENT_LANES: '1' })).toBe(1);
    expect(resolveComposedTaskConcurrency({ REVIEW_YETI_MAX_CONCURRENT_LANES: '2' })).toBe(2);
    expect(resolveComposedTaskConcurrency({ REVIEW_YETI_MAX_CONCURRENT_LANES: '16' })).toBe(3);
    expect(resolveComposedTaskConcurrency({ REVIEW_YETI_MAX_CONCURRENT_LANES: '16' }, true)).toBe(1);
  });
});
