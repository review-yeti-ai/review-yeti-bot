import { logger } from '../utils/logger';

export interface WorkerStatusPollerOptions {
  statusUrl: string;
  bearerToken: string;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  onSuperseded?: (reason?: string) => void;
  fetch?: typeof fetch;
}

export interface WorkerStatusResponse {
  current: boolean;
  status: string;
  cancelRequested: boolean;
  cancelReason?: string;
  currentHeadSha?: string;
  isCurrentHead: boolean;
}

export class WorkerStatusPoller {
  private readonly statusUrl: string;
  private readonly bearerToken: string;
  private readonly pollIntervalMs: number;
  private readonly signal?: AbortSignal;
  private readonly onSuperseded?: (reason?: string) => void;
  private readonly fetchImpl: typeof fetch;

  private timer?: NodeJS.Timeout;
  private stopped = false;
  private _isCurrentHead = true;
  private _cancelRequested = false;
  private _cancelReason?: string;

  constructor(options: WorkerStatusPollerOptions) {
    this.statusUrl = options.statusUrl;
    this.bearerToken = options.bearerToken;
    this.pollIntervalMs = options.pollIntervalMs ?? 25_000;
    this.signal = options.signal;
    this.onSuperseded = options.onSuperseded;
    this.fetchImpl = options.fetch ?? globalThis.fetch;

    if (this.signal) {
      if (this.signal.aborted) {
        this.stopped = true;
      } else {
        this.signal.addEventListener('abort', () => this.stop(), { once: true });
      }
    }
  }

  isCurrentHead(): boolean {
    return this._isCurrentHead && !this._cancelRequested;
  }

  get cancelReason(): string | undefined {
    return this._cancelReason;
  }

  start(): void {
    if (this.stopped || this.timer) return;
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, this.pollIntervalMs);
    // Unref timer so it does not keep process alive
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async pollOnce(): Promise<WorkerStatusResponse | null> {
    if (this.stopped) return null;
    try {
      const response = await this.fetchImpl(this.statusUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.bearerToken}`,
          Accept: 'application/json',
        },
      });

      if (response.status === 404) {
        logger.warn('Review status polling returned 404: run deleted or not found');
        this._isCurrentHead = false;
        this._cancelRequested = true;
        this._cancelReason = 'run_not_found';
        this.onSuperseded?.('run_not_found');
        return null;
      }

      if (!response.ok) {
        logger.warn('Review status polling received non-200 response', { status: response.status });
        return null;
      }

      const body = (await response.json()) as WorkerStatusResponse;
      this._isCurrentHead = body.isCurrentHead;
      this._cancelRequested = body.cancelRequested;
      if (body.cancelReason) {
        this._cancelReason = body.cancelReason;
      }

      if (body.cancelRequested || !body.isCurrentHead || !body.current) {
        this.onSuperseded?.(body.cancelReason || 'superseded_by_new_head');
      }
      return body;
    } catch (err) {
      // Fail-soft on network errors: log warning and continue polling
      logger.warn('Review status polling encountered transient error', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}
