import { describe, expect, it } from 'vitest';
import { settleUnreportedComposedTasks } from '../../src/panel/composedEngine';
import type { ReviewTask } from '../../src/panel/reviewTask';

function task(id: string): ReviewTask {
  return {
    id,
    dimension: 'testing',
    paths: ['src/a.ts'],
    question: 'Is the change covered?',
    rationale: 'The diff touches this file.',
  };
}

describe('settleUnreportedComposedTasks', () => {
  it('turns unreported tasks into empty approvals once any lane completed', () => {
    const settled = settleUnreportedComposedTasks(4, [task('task-5')]);
    expect(settled.approvals.map((item) => item.id)).toEqual(['task-5']);
    expect(settled.failures).toEqual([]);
  });

  it('fails closed when every planned task is unreported', () => {
    const settled = settleUnreportedComposedTasks(0, [task('task-1'), task('task-2')]);
    expect(settled.approvals).toEqual([]);
    expect(settled.failures.map((failure) => failure.id)).toEqual(['task-1', 'task-2']);
    expect(settled.failures.every((failure) => failure.failureClass === 'budget_exhausted')).toBe(true);
  });

  it('leaves a complete roster unchanged', () => {
    expect(settleUnreportedComposedTasks(5, [])).toEqual({ approvals: [], failures: [] });
  });
});
