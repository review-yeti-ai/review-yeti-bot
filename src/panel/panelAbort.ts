import { PanelCancellationError } from './panelErrors';

export function panelAbortError(signal?: AbortSignal): PanelCancellationError {
  const reason = signal?.reason;
  return reason instanceof PanelCancellationError
    ? reason
    : new PanelCancellationError();
}

/** Fail closed at every model-loop boundary without exposing an arbitrary abort reason. */
export function throwIfPanelAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw panelAbortError(signal);
}

/** Race a model/tool operation against cancellation and consume a late rejection. */
export function raceWithPanelAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) {
    void operation.catch(() => undefined);
    return Promise.reject(panelAbortError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      void operation.catch(() => undefined);
      reject(panelAbortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

