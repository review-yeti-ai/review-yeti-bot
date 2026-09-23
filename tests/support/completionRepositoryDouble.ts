import { vi } from 'vitest';
import type { ReviewCompletionFencedDispatchResult } from '../../src/persistence/reviewCompletionRepository';

/**
 * REL-1053: the delivery engine sends through `dispatchFenced`, which holds the
 * row lock around the send in Postgres. Engine-level test doubles only model
 * the outcome, so this adapter runs the send and then defers to the double's
 * own `markDispatched` to decide `dispatched` versus `lease-lost`. The real
 * locking behavior is covered in
 * tests/integration/reviewCompletionFencedDispatch.postgres.test.ts.
 */
export function withFencedDispatch<T extends {
  markDispatched: (completionId: string, workerId: string, now: number) => Promise<boolean>;
}>(repository: T) {
  return Object.assign(repository, {
    dispatchFenced: vi.fn(async (
      completionId: string,
      workerId: string,
      _claimAttempt: number,
      now: number,
      send: (signal: AbortSignal) => Promise<void>,
    ): Promise<ReviewCompletionFencedDispatchResult> => {
      await send(new AbortController().signal);
      return (await repository.markDispatched(completionId, workerId, now)) ? 'dispatched' : 'lease-lost';
    }),
  });
}
