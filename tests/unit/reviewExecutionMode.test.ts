import { describe, expect, it } from 'vitest';
import { assertSupportedReviewExecution } from '../../src/app';

describe('review execution mode', () => {
  it('rejects the unfinished Kubernetes worker path instead of running the review twice', () => {
    expect(() => assertSupportedReviewExecution({ KUBERNETES_WORKER_DISPATCH: 'true' } as unknown as NodeJS.ProcessEnv))
      .toThrow(/worker dispatch is disabled/i);
  });

  it('allows the canonical in-process execution path by default', () => {
    expect(() => assertSupportedReviewExecution({} as unknown as NodeJS.ProcessEnv)).not.toThrow();
  });
});
