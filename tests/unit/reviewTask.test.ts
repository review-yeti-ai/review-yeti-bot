import { describe, it, expect } from 'vitest';
import {
  validateTaskPlan,
  isValidTaskId,
  isTaskDimension,
  TASK_DIMENSIONS,
  DEFAULT_MAX_TASKS,
  MAX_TASKS_HARD_CAP,
  MAX_TASK_TEXT_LENGTH,
  type RawReviewTaskPlan,
  type RawReviewTask,
  type ValidateTaskPlanContext,
} from '../../src/panel/reviewTask';
import { classifyPathByHeuristic } from '../../src/panel/classifierEngine';

// Representative changed-file fixture. Verified against classifyPathByHeuristic
// so the domain-lane assumptions baked into these tests do not silently drift
// from the heuristic classifier's actual behavior.
const AUTH_FILE = 'src/auth/login.ts';
const API_FILE = 'src/api/users.ts';
const UTIL_FILE = 'src/util/format.ts';
const DOC_FILE = 'docs/readme.md';

describe('reviewTask fixture sanity (matches classifierEngine heuristics)', () => {
  it('classifies the fixture paths the way these tests assume', () => {
    expect(classifyPathByHeuristic(AUTH_FILE)).toBe('security_auth');
    expect(classifyPathByHeuristic(API_FILE)).toBe('api_contracts');
    expect(classifyPathByHeuristic(UTIL_FILE)).toBe('system_runtime');
    expect(classifyPathByHeuristic(DOC_FILE)).toBe('docs_assets');
  });
});

function task(overrides: Partial<RawReviewTask> = {}): RawReviewTask {
  return {
    id: 'task-api-review',
    dimension: 'contract',
    paths: [API_FILE],
    question: 'Does this change the public API contract?',
    rationale: 'The diff touches src/api/users.ts.',
    ...overrides,
  };
}

function plan(tasks: RawReviewTask[]): RawReviewTaskPlan {
  return { tasks };
}

function ctx(overrides: Partial<ValidateTaskPlanContext> = {}): ValidateTaskPlanContext {
  return { changedFiles: [API_FILE, UTIL_FILE], ...overrides };
}

describe('validateTaskPlan', () => {
  it('rejects an empty plan', () => {
    const result = validateTaskPlan(plan([]), ctx());
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('empty_plan');
  });

  it('rejects a plan with no tasks array at all', () => {
    const result = validateTaskPlan({}, ctx());
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('empty_plan');
  });

  it('rejects a plan over the max task cap', () => {
    const tasks = Array.from({ length: DEFAULT_MAX_TASKS + 1 }, (_, i) =>
      task({ id: `task-${i}`, paths: [API_FILE] }),
    );
    const result = validateTaskPlan(plan(tasks), ctx());
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('too_many_tasks');
  });

  it('never validates more tasks than the hard cap even with an inflated maxTasks override', () => {
    const tasks = Array.from({ length: MAX_TASKS_HARD_CAP + 1 }, (_, i) =>
      task({ id: `task-${i}`, paths: [API_FILE] }),
    );
    const result = validateTaskPlan(plan(tasks), ctx({ maxTasks: 999 }));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('too_many_tasks');
  });

  it('rejects duplicate task ids', () => {
    const result = validateTaskPlan(
      plan([task({ id: 'dup-id' }), task({ id: 'dup-id', paths: [UTIL_FILE] })]),
      ctx(),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('duplicate_ids');
      expect(result.offendingIds).toContain('dup-id');
    }
  });

  it('rejects malformed task ids', () => {
    const result = validateTaskPlan(
      plan([task({ id: 'Task With Spaces AND Caps' }), task({ id: 'ok-task', paths: [UTIL_FILE] })]),
      ctx(),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('malformed_ids');
      expect(result.offendingIds).toContain('Task With Spaces AND Caps');
    }
  });

  it('rejects an id starting with a digit or underscore (roster id format)', () => {
    const result = validateTaskPlan(plan([task({ id: '1-task' })]), ctx());
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('malformed_ids');
  });

  it('rejects an unknown dimension', () => {
    const result = validateTaskPlan(plan([task({ dimension: 'made-up-dimension' })]), ctx());
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('unknown_dimension');
      expect(result.offendingIds).toContain('task-api-review');
    }
  });

  it('clamps an oversized question or rationale and still accepts the plan', () => {
    const result = validateTaskPlan(
      plan([
        task({ question: `q${'x'.repeat(MAX_TASK_TEXT_LENGTH + 50)}`, paths: [API_FILE] }),
        task({
          id: 'util-task',
          dimension: 'testing',
          paths: [UTIL_FILE],
          rationale: `r${'y'.repeat(MAX_TASK_TEXT_LENGTH + 10)}`,
        }),
      ]),
      ctx(),
    );
    expect(result.valid).toBe(true);
    if (result.valid) {
      const apiTask = result.tasks.find((t) => t.id === 'task-api-review');
      const utilTask = result.tasks.find((t) => t.id === 'util-task');
      expect(apiTask?.question).toHaveLength(MAX_TASK_TEXT_LENGTH);
      expect(apiTask?.question.startsWith('q')).toBe(true);
      expect(utilTask?.rationale).toHaveLength(MAX_TASK_TEXT_LENGTH);
      expect(utilTask?.rationale.startsWith('r')).toBe(true);
    }
  });

  it('rejects a task with a blank question or rationale', () => {
    const result = validateTaskPlan(plan([task({ question: '   ' })]), ctx());
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('invalid_task_fields');
  });

  it('drops phantom paths not present in the diff and keeps a task valid if real paths remain', () => {
    const result = validateTaskPlan(
      plan([
        task({ id: 'api-task', paths: [API_FILE, 'src/does/not/exist.ts'] }),
        task({ id: 'util-task', dimension: 'testing', paths: [UTIL_FILE] }),
      ]),
      ctx(),
    );
    expect(result.valid).toBe(true);
    if (result.valid) {
      const apiTask = result.tasks.find((t) => t.id === 'api-task');
      expect(apiTask?.paths).toEqual([API_FILE]);
      expect(apiTask?.paths).not.toContain('src/does/not/exist.ts');
    }
  });

  it('rejects a task left with zero paths after phantom-path dropping', () => {
    const result = validateTaskPlan(
      plan([
        task({ id: 'phantom-only', paths: ['src/does/not/exist.ts'] }),
        task({ id: 'util-task', dimension: 'testing', paths: [UTIL_FILE] }),
      ]),
      ctx(),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('task_emptied_by_path_drop');
      expect(result.offendingIds).toContain('phantom-only');
    }
  });

  it('reports a coverage gap with the exact uncovered paths', () => {
    const result = validateTaskPlan(plan([task({ paths: [API_FILE] })]), ctx());
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('coverage_gap');
      expect(result.uncoveredPaths).toEqual([UTIL_FILE]);
    }
  });

  it('does not require doc/asset files to be covered', () => {
    const result = validateTaskPlan(
      plan([task({ paths: [API_FILE] }), task({ id: 'util-task', dimension: 'testing', paths: [UTIL_FILE] })]),
      ctx({ changedFiles: [API_FILE, UTIL_FILE, DOC_FILE] }),
    );
    expect(result.valid).toBe(true);
  });

  it('supports the corrective-turn path: a coverage-gap plan re-validates clean once the gap is closed', () => {
    const context = ctx();
    const incomplete = plan([task({ paths: [API_FILE] })]);
    const first = validateTaskPlan(incomplete, context);
    expect(first.valid).toBe(false);
    if (first.valid) throw new Error('unreachable');
    expect(first.reason).toBe('coverage_gap');

    // Caller takes `first.uncoveredPaths` and issues one bounded corrective
    // turn asking the model to add them.
    const corrected = plan([
      task({ paths: [API_FILE, ...(first.uncoveredPaths ?? [])] }),
    ]);
    const second = validateTaskPlan(corrected, context);
    expect(second.valid).toBe(true);
  });

  it('fails closed if the corrective turn still leaves a gap', () => {
    const context = ctx({ changedFiles: [API_FILE, UTIL_FILE, 'src/other/thing.ts'] });
    const stillIncomplete = plan([task({ paths: [API_FILE, UTIL_FILE] })]);
    const result = validateTaskPlan(stillIncomplete, context);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('coverage_gap');
      expect(result.uncoveredPaths).toEqual(['src/other/thing.ts']);
    }
  });

  describe('security floor (injection resistance)', () => {
    it('accepts a plan that covers a security_auth file with a security-dimension task', () => {
      const result = validateTaskPlan(
        plan([
          task({ id: 'sec-task', dimension: 'security', paths: [AUTH_FILE] }),
          task({ id: 'api-task', paths: [API_FILE] }),
        ]),
        ctx({ changedFiles: [AUTH_FILE, API_FILE] }),
      );
      expect(result.valid).toBe(true);
    });

    it('rejects immediately (not as a correctable coverage gap) when no security task covers the auth file', () => {
      const result = validateTaskPlan(
        plan([task({ id: 'api-task', paths: [API_FILE, AUTH_FILE] })]),
        ctx({ changedFiles: [AUTH_FILE, API_FILE] }),
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        // Generic coverage would have passed here -- the auth file IS in a
        // task's paths. The security floor must still fail the plan because
        // no task with dimension "security" covers it.
        expect(result.reason).toBe('security_floor_violation');
        expect(result.offendingPaths).toContain(AUTH_FILE);
        expect(result.uncoveredPaths).toBeUndefined();
      }
    });

    it('injection case: rejects a plan that omits the auth file even though the model labelled a decoy task "security"', () => {
      // Simulates a diff whose content tried to steer the planning model away
      // from the real security-sensitive file: the model labels an unrelated
      // task "security" but never lists the actual auth file anywhere.
      const result = validateTaskPlan(
        plan([
          task({ id: 'decoy-security', dimension: 'security', paths: [UTIL_FILE] }),
          task({ id: 'api-task', paths: [API_FILE] }),
        ]),
        ctx({ changedFiles: [AUTH_FILE, API_FILE, UTIL_FILE] }),
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe('security_floor_violation');
        expect(result.offendingPaths).toEqual([AUTH_FILE]);
      }
    });

    it('security floor is not satisfiable by a second corrective turn the way coverage_gap is', () => {
      const context = ctx({ changedFiles: [AUTH_FILE, API_FILE] });
      const noSecurityTask = plan([task({ id: 'api-task', paths: [API_FILE, AUTH_FILE] })]);
      const first = validateTaskPlan(noSecurityTask, context);
      expect(first.valid).toBe(false);
      if (first.valid) throw new Error('unreachable');
      // Rejection carries offendingPaths, not uncoveredPaths -- callers that
      // only implement the bounded-retry loop for coverage_gap (keyed off
      // uncoveredPaths) get nothing to retry with, by design.
      expect(first.reason).toBe('security_floor_violation');
      expect(first.uncoveredPaths).toBeUndefined();
      expect(first.offendingPaths).toEqual([AUTH_FILE]);
    });

    it('does not require a security task when no file is in the security_auth lane', () => {
      const result = validateTaskPlan(plan([task({ paths: [API_FILE, UTIL_FILE] })]), ctx());
      expect(result.valid).toBe(true);
    });
  });
});

describe('isValidTaskId', () => {
  it('accepts a lowercase, hyphenated id', () => {
    expect(isValidTaskId('review-security-1')).toBe(true);
  });

  it('rejects an empty string, uppercase, and non-string values', () => {
    expect(isValidTaskId('')).toBe(false);
    expect(isValidTaskId('Security')).toBe(false);
    expect(isValidTaskId(42)).toBe(false);
    expect(isValidTaskId(null)).toBe(false);
    expect(isValidTaskId(undefined)).toBe(false);
  });

  it('rejects an id over 128 characters', () => {
    expect(isValidTaskId('a'.repeat(129))).toBe(false);
    expect(isValidTaskId('a'.repeat(128))).toBe(true);
  });
});

describe('isTaskDimension', () => {
  it('accepts every declared dimension', () => {
    for (const d of TASK_DIMENSIONS) {
      expect(isTaskDimension(d)).toBe(true);
    }
  });

  it('rejects lane-id aliases and unknown strings', () => {
    expect(isTaskDimension('sec-lane')).toBe(false);
    expect(isTaskDimension('nonsense')).toBe(false);
    expect(isTaskDimension(123)).toBe(false);
  });
});
