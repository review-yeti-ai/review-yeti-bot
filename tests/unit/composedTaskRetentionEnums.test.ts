import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  COMPOSED_TASK_FAILURE_REASONS,
  COMPOSED_TASK_FINISH_REASONS,
  COMPOSED_TASK_LAST_TOOL_OUTCOMES,
  COMPOSED_TASK_OUTCOME_STATUSES,
  type ComposedTaskFailureDiagnostics,
  type ComposedTaskOutcomeStatus,
} from '../../src/panel/types';
import {
  ComposedTaskRetentionError,
  createComposedTaskOutcomeRetentionRequest,
} from '../../src/panel/composedTaskRetention';

function outcome() {
  return {
    selectors: { repository: 'review-yeti-ai/review-yeti-bot', prNumber: 1, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) },
    planDigest: 'c'.repeat(64), taskIndex: 0, taskId: 'task-one', status: 'exhausted' as const,
    diagnostics: {
      reason: COMPOSED_TASK_FAILURE_REASONS[0], turnsUsed: 1, correctionAttempts: 0, toolTurns: 0,
      finishReason: null, lastToolOutcome: COMPOSED_TASK_LAST_TOOL_OUTCOMES[0],
    } as ComposedTaskFailureDiagnostics,
    usage: { turnsUsed: 1, physicalCalls: null, correctionAttempts: 0, toolTurns: 0,
      promptTokens: 1, completionTokens: 1, totalTokens: 2, cachedTokens: 0, durationMs: 1, costUSD: null },
  };
}

describe('composed retention: retried-attempt accounting', () => {
  // Guards the invariant on the retry path. `composedEngine` keeps ONE shared
  // usage array across a task's attempts ("A task-level retry reuses the shared
  // usage array so every attempt's spend stays accounted") and sets
  // `attemptStartTurn = turnUsages.length` on entry, so:
  //
  //   usage.turnsUsed       = turnUsages.length                    (task TOTAL)
  //   diagnostics.turnsUsed = turnUsages.length - attemptStartTurn (FINAL ATTEMPT)
  //
  // Comparing them for equality throws on every retried attempt. The
  // ComposedTaskRetentionError then propagates out of runReservedTask into
  // Promise.all(cohortPromises), aborting the entire composed review instead of
  // recording the one failed task outcome the retention path exists to record.
  //
  // The pre-existing fixture sets turnsUsed: 1 on both sides -- the NON-retried
  // case -- so it never reached this.
  const retried = (attemptStartTurn: number, totalTurns: number) => ({
    selectors: { repository: 'review-yeti-ai/review-yeti-bot', prNumber: 1, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) },
    planDigest: 'c'.repeat(64), taskIndex: 0, taskId: 'task-one', status: 'exhausted' as const,
    diagnostics: {
      reason: COMPOSED_TASK_FAILURE_REASONS[0],
      turnsUsed: totalTurns - attemptStartTurn,
      correctionAttempts: 0, toolTurns: 0,
      finishReason: null, lastToolOutcome: COMPOSED_TASK_LAST_TOOL_OUTCOMES[0],
    } as ComposedTaskFailureDiagnostics,
    usage: { turnsUsed: totalTurns, physicalCalls: null, correctionAttempts: 0, toolTurns: 0,
      promptTokens: 1, completionTokens: 1, totalTokens: 2, cachedTokens: 0, durationMs: 1, costUSD: null },
  });

  it('accepts a retried attempt, where per-attempt and cumulative turn counts differ', () => {
    // Second attempt: 4 turns consumed before it started, 6 for the task overall.
    expect(() => createComposedTaskOutcomeRetentionRequest(retried(4, 6) as never)).not.toThrow();
  });

  it('still rejects an attempt claiming more turns than the task spent', () => {
    // The replacement invariant must keep biting: 9 per-attempt against 6 total.
    expect(() => createComposedTaskOutcomeRetentionRequest(retried(0, 6) && {
      ...retried(0, 6),
      diagnostics: { ...retried(0, 6).diagnostics, turnsUsed: 9 },
    } as never)).toThrow();
  });
});

describe('composed retention enum authority', () => {
  it('derives public types from immutable runtime tuples', () => {
    expectTypeOf<ComposedTaskFailureDiagnostics['reason']>().toEqualTypeOf<typeof COMPOSED_TASK_FAILURE_REASONS[number]>();
    expectTypeOf<ComposedTaskFailureDiagnostics['finishReason']>().toEqualTypeOf<typeof COMPOSED_TASK_FINISH_REASONS[number] | null>();
    expectTypeOf<ComposedTaskFailureDiagnostics['lastToolOutcome']>().toEqualTypeOf<typeof COMPOSED_TASK_LAST_TOOL_OUTCOMES[number]>();
    expectTypeOf<ComposedTaskOutcomeStatus>().toEqualTypeOf<typeof COMPOSED_TASK_OUTCOME_STATUSES[number]>();
    for (const values of [COMPOSED_TASK_FAILURE_REASONS, COMPOSED_TASK_FINISH_REASONS,
      COMPOSED_TASK_LAST_TOOL_OUTCOMES, COMPOSED_TASK_OUTCOME_STATUSES]) {
      expect(Object.isFrozen(values)).toBe(true);
      expect(values.length).toBeGreaterThan(0);
      expect(new Set(values).size).toBe(values.length);
    }
  });

  it('accepts every authoritative failure reason', () => {
    for (const reason of COMPOSED_TASK_FAILURE_REASONS) {
      const input = outcome(); input.diagnostics.reason = reason;
      expect(createComposedTaskOutcomeRetentionRequest(input).evidence.diagnostics?.reason).toBe(reason);
    }
  });

  it('accepts every authoritative finish reason and null', () => {
    for (const finishReason of [...COMPOSED_TASK_FINISH_REASONS, null]) {
      const input = outcome(); input.diagnostics.finishReason = finishReason;
      expect(createComposedTaskOutcomeRetentionRequest(input).evidence.diagnostics?.finishReason).toBe(finishReason);
    }
  });

  it('accepts every authoritative last-tool outcome', () => {
    for (const lastToolOutcome of COMPOSED_TASK_LAST_TOOL_OUTCOMES) {
      const input = outcome(); input.diagnostics.lastToolOutcome = lastToolOutcome;
      expect(createComposedTaskOutcomeRetentionRequest(input).evidence.diagnostics?.lastToolOutcome).toBe(lastToolOutcome);
    }
  });

  it('accepts every status with its unchanged evidence requirements', () => {
    for (const status of COMPOSED_TASK_OUTCOME_STATUSES) {
      const { diagnostics, ...base } = outcome();
      const input = { ...base, status, ...(status === 'complete' ? { findings: [] }
        : status === 'exhausted' ? { diagnostics } : {}) };
      expect(createComposedTaskOutcomeRetentionRequest(input).evidence.status).toBe(status);
    }
  });

  it('still rejects values outside each authority', () => {
    const outside = '__unknown_enum_value__';
    for (const key of ['reason', 'finishReason', 'lastToolOutcome'] as const) {
      const input = outcome();
      expect(() => createComposedTaskOutcomeRetentionRequest({ ...input,
        diagnostics: { ...input.diagnostics, [key]: outside } } as never)).toThrow(ComposedTaskRetentionError);
    }
    expect(() => createComposedTaskOutcomeRetentionRequest({ ...outcome(), status: outside } as never)).toThrow(ComposedTaskRetentionError);
  });
});
