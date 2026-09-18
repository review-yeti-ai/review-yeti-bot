import { logger } from '../utils/logger';

export interface DispatchCircuitBreakerOptions {
  windowMs?: number;
  minSamples?: number;
  failureRateThreshold?: number;
  now?: () => number;
}

export interface DispatchCircuitBreakerStats {
  total: number;
  total5xx: number;
  failureRate: number;
  isOpen: boolean;
  isPaused: boolean;
}

/**
 * DispatchCircuitBreaker (Milestone 5 / R5)
 *
 * Tracks provider 5xx failures across a rolling 5-minute sliding window.
 * When the cluster provider 5xx error rate crosses `failureRateThreshold` (default 50%
 * with at least 3 samples), `isOpen()` trips to true, instructing the dispatch engine
 * to pause claiming new outbox rows.
 *
 * Mirrors the `authoritative_admission_paused` control plane switch for dispatching.
 */
export class DispatchCircuitBreaker {
  private readonly windowMs: number;
  private readonly minSamples: number;
  private readonly failureRateThreshold: number;
  private readonly now: () => number;
  private readonly events: Array<{ timestamp: number; is5xx: boolean }> = [];
  private manuallyPaused = false;

  constructor(options?: DispatchCircuitBreakerOptions) {
    this.windowMs = options?.windowMs ?? 5 * 60_000;
    this.minSamples = options?.minSamples ?? 3;
    this.failureRateThreshold = options?.failureRateThreshold ?? 0.5;
    this.now = options?.now || Date.now;
  }

  recordSuccess(now: number = this.now()): void {
    this.prune(now);
    this.events.push({ timestamp: now, is5xx: false });
  }

  recordFailure(reasonOrError: unknown, now: number = this.now()): void {
    this.prune(now);
    const is5xx = this.is5xxReason(reasonOrError);
    this.events.push({ timestamp: now, is5xx });
    if (is5xx) {
      const stats = this.getStats(now);
      if (stats.isOpen) {
        logger.warn('Dispatch circuit breaker tripped open due to elevated provider 5xx rate', {
          total5xx: stats.total5xx,
          total: stats.total,
          failureRate: stats.failureRate,
          threshold: this.failureRateThreshold,
        });
      }
    }
  }

  isOpen(now: number = this.now()): boolean {
    if (this.manuallyPaused) return true;
    this.prune(now);
    if (this.events.length < this.minSamples) return false;
    const total5xx = this.events.filter((e) => e.is5xx).length;
    const rate = total5xx / this.events.length;
    return rate >= this.failureRateThreshold;
  }

  pause(): void {
    this.manuallyPaused = true;
    logger.warn('Dispatch manually paused via circuit breaker switch');
  }

  resume(): void {
    this.manuallyPaused = false;
    logger.info('Dispatch resumed via circuit breaker switch');
  }

  isPaused(): boolean {
    return this.manuallyPaused;
  }

  reset(): void {
    this.events.length = 0;
    this.manuallyPaused = false;
  }

  getStats(now: number = this.now()): DispatchCircuitBreakerStats {
    this.prune(now);
    const total5xx = this.events.filter((e) => e.is5xx).length;
    const total = this.events.length;
    const rate = total > 0 ? total5xx / total : 0;
    return {
      total,
      total5xx,
      failureRate: rate,
      isOpen: this.isOpen(now),
      isPaused: this.manuallyPaused,
    };
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.events.length > 0 && this.events[0].timestamp < cutoff) {
      this.events.shift();
    }
  }

  private is5xxReason(reasonOrError: unknown): boolean {
    if (typeof reasonOrError === 'string') {
      return reasonOrError === 'provider_5xx' || /\b(?:502|503)\b/i.test(reasonOrError);
    }
    if (reasonOrError && typeof reasonOrError === 'object') {
      const status = (reasonOrError as any).status;
      if (status === 502 || status === 503) return true;
      const failureReason = (reasonOrError as any).failureReason;
      if (failureReason === 'provider_5xx') return true;
      const message = (reasonOrError as any).message;
      if (typeof message === 'string' && (/\b(?:502|503)\b|provider_5xx|Bad Gateway|Service Unavailable/i.test(message))) {
        return true;
      }
    }
    return false;
  }
}
