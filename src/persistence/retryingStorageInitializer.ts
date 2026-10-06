export interface RetryingStorageInitializerOptions {
  retryInitialMs?: number;
  retryMaxMs?: number;
  onInitialized?: () => void;
  onFailure?: () => void;
  onCallbackError?: () => void;
}

/**
 * Tracks one storage initialization at a time and retries failed attempts with
 * bounded backoff. `stop()` cancels future retries and awaits an active schema
 * operation before its owner closes the pool; it never races or abandons DDL.
 */
export class RetryingStorageInitializer {
  private activeAttempt: Promise<void> | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  private initializedValue = false;
  private nextRetryMs: number;
  private readonly retryMaxMs: number;

  constructor(private readonly initialize: () => Promise<void>,
    private readonly options: RetryingStorageInitializerOptions = {}) {
    const retryInitialMs = options.retryInitialMs ?? 1_000;
    this.retryMaxMs = options.retryMaxMs ?? 60_000;
    if (!Number.isSafeInteger(retryInitialMs) || retryInitialMs < 1
      || !Number.isSafeInteger(this.retryMaxMs) || this.retryMaxMs < retryInitialMs) {
      throw new Error('Invalid storage initialization retry bounds');
    }
    this.nextRetryMs = retryInitialMs;
  }

  get initialized(): boolean { return this.initializedValue; }

  initializeOnce(): Promise<boolean> {
    if (this.initializedValue) return Promise.resolve(true);
    if (this.stopped) return Promise.resolve(false);
    if (this.activeAttempt) return this.activeAttempt.then(() => this.initializedValue);

    const attempt = Promise.resolve().then(() => this.initialize()).then(() => {
      if (this.stopped) return;
      this.initializedValue = true;
      this.notify(this.options.onInitialized);
    }).catch(() => {
      if (!this.stopped) this.notify(this.options.onFailure);
    });
    let tracked: Promise<void>;
    tracked = attempt.finally(() => {
      if (this.activeAttempt === tracked) this.activeAttempt = undefined;
      this.scheduleRetry();
    });
    this.activeAttempt = tracked;
    return tracked.then(() => this.initializedValue);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    await this.activeAttempt;
  }

  private scheduleRetry(): void {
    if (this.stopped || this.initializedValue || this.retryTimer) return;
    const delayMs = this.nextRetryMs;
    this.nextRetryMs = Math.min(this.retryMaxMs, delayMs * 2);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.initializeOnce();
    }, delayMs);
    this.retryTimer.unref?.();
  }

  private notify(callback: (() => void) | undefined): void {
    if (!callback) return;
    try {
      callback();
    } catch {
      try { this.options.onCallbackError?.(); } catch { /* Lifecycle hooks cannot break retry tracking. */ }
    }
  }
}
