import { describe, expect, it } from 'vitest';
import { WorkerCompletionPersistenceError, isDeterministicCompletionFailure }
  from '../../src/review/workerCompletionPersistenceError';
describe('REL-1056 422 mapping contract', () => {
  it('carries the reason through the persistence error and marks it deterministic', () => {
    const e = new WorkerCompletionPersistenceError('trusted-completion-resolution', 'exact-diff', 'coverage-no-persona');
    expect(e.reason).toBe('coverage-no-persona');
    expect(isDeterministicCompletionFailure(e.reason)).toBe(true);
  });
  it('keeps an unknown reason transient so a real outage still retries', () => {
    const e = new WorkerCompletionPersistenceError('trusted-completion-resolution', 'exact-diff', 'unknown');
    expect(isDeterministicCompletionFailure(e.reason)).toBe(false);
    expect(isDeterministicCompletionFailure(undefined)).toBe(false);
  });
  it('ignores a reason on an unrelated stage', () => {
    const e = new WorkerCompletionPersistenceError('commit', undefined, 'bounds');
    expect(e.reason).toBeUndefined();
  });
});
