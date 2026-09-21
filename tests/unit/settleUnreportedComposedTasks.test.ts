import { describe, expect, it } from 'vitest';
import { nextLaneStep, unreportedLaneFailure } from '../../src/panel/composedEngine';
import type { ReviewTask } from '../../src/panel/reviewTask';

function task(id: string): ReviewTask {
  return {
    id,
    dimension: 'security',
    paths: ['src/auth/guard.ts'],
    question: 'Is the change safe?',
    rationale: 'The diff touches an auth file.',
  };
}

describe('unreported composed lane reasons', () => {
  it('names a spent budget separately from a lane that ran and produced no verdict', () => {
    expect(nextLaneStep('no_budget')).toMatchObject({
      record: 'failure',
      continueRemaining: true,
      failureClass: 'budget_exhausted',
    });
    expect(nextLaneStep('exhausted')).toMatchObject({
      record: 'failure',
      continueRemaining: true,
      failureClass: 'malformed_output',
    });

    const neverStarted = unreportedLaneFailure(task('task-budget'), 'no_budget');
    const noVerdict = unreportedLaneFailure(task('task-output'), 'exhausted');
    expect(neverStarted.failureClass).toBe('budget_exhausted');
    expect(neverStarted.error).toContain('did not start');
    expect(neverStarted.error).not.toContain('produced no verdict');
    expect(noVerdict.failureClass).toBe('malformed_output');
    expect(noVerdict.error).toContain('ran and produced no verdict');
    expect(noVerdict.error).not.toContain('did not start');
  });
});
