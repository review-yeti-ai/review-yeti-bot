import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { nextLaneStep, unreportedLaneFailure } from '../../src/panel/composedEngine';
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

describe('unreported composed lanes', () => {
  it('records a no-verdict lane as a budget failure and keeps walking', () => {
    for (const reason of ['exhausted', 'no_budget'] as const) {
      expect(nextLaneStep(reason)).toEqual({
        record: 'failure',
        continueRemaining: true,
        failureClass: 'budget_exhausted',
      });
    }
    expect(unreportedLaneFailure(task('task-5'))).toMatchObject({
      id: 'task-5',
      failureClass: 'budget_exhausted',
    });
  });

  it('does not abort the task loop on a no-verdict lane', () => {
    const source = readFileSync(new URL('../../src/panel/composedEngine.ts', import.meta.url), 'utf8');
    const start = source.indexOf('for (let i = 0; i < planOutcome.tasks.length');
    const end = source.indexOf('return {\n      headSha,', start);
    const loop = source.slice(start, end);
    expect(loop).toContain("nextLaneStep('exhausted')");
    expect(loop).toContain("nextLaneStep('no_budget')");
    expect(loop).toContain('if (!step.continueRemaining) break;');
    expect(loop).not.toContain('unreported.push');
  });

  it('still visits every later task after an exhausted lane', () => {
    const outcomes = ['complete', 'exhausted', 'complete'] as const;
    const recorded: string[] = [];
    for (const outcome of outcomes) {
      if (outcome === 'exhausted') {
        const step = nextLaneStep('exhausted');
        recorded.push(`failure:${step.failureClass}`);
        if (!step.continueRemaining) break;
        continue;
      }
      recorded.push(outcome);
    }
    expect(recorded).toEqual(['complete', 'failure:budget_exhausted', 'complete']);
  });
});
