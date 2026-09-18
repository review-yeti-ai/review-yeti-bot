/**
 * Reject promptly when a caller cancels even if a test double or a compatible transport
 * fails to observe AbortSignal. Shared between OpenRouterClient and JevClient so their
 * abort-racing semantics (settled-flag bookkeeping, listener cleanup, orphaned-promise
 * swallowing) cannot silently drift apart between two private copies.
 *
 * `makeCancellationError` lets each caller keep its own cancellation error type/message
 * (e.g. OpenRouterTimeoutError vs a plain Error) without this shared implementation caring.
 * `onLateValue` is an optional hook for cleaning up a value that resolves after cancellation
 * has already been decided (e.g. releasing a late HTTP response body); its own failures are
 * swallowed because late cleanup must never replace the already-classified cancellation.
 */
export function raceWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  makeCancellationError: () => Error,
  onLateValue?: (value: T) => void,
): Promise<T> {
  const consumeLateValue = (value: T) => {
    try {
      onLateValue?.(value);
    } catch (_) {
      // Late cleanup must never replace the already-classified cancellation.
    }
  };
  if (!signal) return operation;
  if (signal.aborted) {
    void operation.then(consumeLateValue, () => undefined);
    return Promise.reject(makeCancellationError());
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let onAbort: () => void;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      void operation.then(consumeLateValue, () => undefined);
      reject(makeCancellationError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}
