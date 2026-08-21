import { logger } from '../utils/logger';

export interface ProviderCapacity {
  maxConcurrentLanes: number;
  ttftTimeoutMs: number;
  totalTimeoutMs: number;
}

export class ProviderQueueStallError extends Error {
  readonly providerId: string;
  readonly elapsedMs: number;
  readonly isRetryableFailover = true;

  constructor(providerId: string, elapsedMs: number, message?: string) {
    super(message || `Upstream provider '${providerId}' queued/stalled request: no tokens received within TTFT threshold of ${elapsedMs}ms`);
    this.name = 'ProviderQueueStallError';
    this.providerId = providerId;
    this.elapsedMs = elapsedMs;
  }
}

export const DEFAULT_PROVIDER_CAPACITIES: Record<string, ProviderCapacity> = {
  fireworks: {
    maxConcurrentLanes: 2,
    ttftTimeoutMs: 15_000,
    totalTimeoutMs: 120_000,
  },
  ollama: {
    maxConcurrentLanes: 2,
    ttftTimeoutMs: 20_000,
    totalTimeoutMs: 90_000,
  },
  openrouter: {
    maxConcurrentLanes: 10,
    ttftTimeoutMs: 30_000,
    totalTimeoutMs: 90_000,
  },
  gemini: {
    maxConcurrentLanes: 20,
    ttftTimeoutMs: 15_000,
    totalTimeoutMs: 60_000,
  },
  codex: {
    maxConcurrentLanes: 4,
    ttftTimeoutMs: 20_000,
    totalTimeoutMs: 90_000,
  },
  claude: {
    maxConcurrentLanes: 4,
    ttftTimeoutMs: 20_000,
    totalTimeoutMs: 90_000,
  },
  synthetic: {
    maxConcurrentLanes: 4,
    ttftTimeoutMs: 20_000,
    totalTimeoutMs: 90_000,
  },
  default: {
    maxConcurrentLanes: 4,
    ttftTimeoutMs: 20_000,
    totalTimeoutMs: 90_000,
  },
};

export function resolveProviderCapacity(providerNameOrUrl: string): ProviderCapacity {
  const normalized = (providerNameOrUrl || '').toLowerCase().trim();
  if (normalized.includes('fireworks')) return DEFAULT_PROVIDER_CAPACITIES.fireworks;
  if (normalized.includes('ollama')) return DEFAULT_PROVIDER_CAPACITIES.ollama;
  if (normalized.includes('gemini') || normalized.includes('google')) return DEFAULT_PROVIDER_CAPACITIES.gemini;
  if (normalized.includes('openrouter')) return DEFAULT_PROVIDER_CAPACITIES.openrouter;
  if (normalized.includes('codex')) return DEFAULT_PROVIDER_CAPACITIES.codex;
  if (normalized.includes('claude') || normalized.includes('anthropic')) return DEFAULT_PROVIDER_CAPACITIES.claude;
  if (normalized.includes('synthetic') || normalized.includes('glm')) return DEFAULT_PROVIDER_CAPACITIES.synthetic;
  return DEFAULT_PROVIDER_CAPACITIES.default;
}

export class ProviderCapacityLimiter {
  private static instance: ProviderCapacityLimiter;
  private readonly inFlight = new Map<string, number>();
  private readonly customCapacities = new Map<string, ProviderCapacity>();

  static getInstance(): ProviderCapacityLimiter {
    if (!ProviderCapacityLimiter.instance) {
      ProviderCapacityLimiter.instance = new ProviderCapacityLimiter();
    }
    return ProviderCapacityLimiter.instance;
  }

  setCapacity(providerId: string, capacity: Partial<ProviderCapacity>): void {
    const base = resolveProviderCapacity(providerId);
    this.customCapacities.set(providerId.toLowerCase(), { ...base, ...capacity });
  }

  getCapacity(providerId: string): ProviderCapacity {
    const key = (providerId || '').toLowerCase().trim();
    return this.customCapacities.get(key) || resolveProviderCapacity(key);
  }

  getActiveCount(providerId: string): number {
    const key = (providerId || '').toLowerCase().trim();
    return this.inFlight.get(key) || 0;
  }

  canAccept(providerId: string): boolean {
    const key = (providerId || '').toLowerCase().trim();
    const active = this.getActiveCount(key);
    const capacity = this.getCapacity(key);
    return active < capacity.maxConcurrentLanes;
  }

  tryAcquire(providerId: string): boolean {
    const key = (providerId || '').toLowerCase().trim();
    if (!this.canAccept(key)) {
      logger.info(`Provider capacity saturated for '${key}': active=${this.getActiveCount(key)}/${this.getCapacity(key).maxConcurrentLanes}`);
      return false;
    }
    const current = this.inFlight.get(key) || 0;
    this.inFlight.set(key, current + 1);
    return true;
  }

  release(providerId: string): void {
    const key = (providerId || '').toLowerCase().trim();
    const current = this.inFlight.get(key) || 0;
    if (current <= 1) {
      this.inFlight.delete(key);
    } else {
      this.inFlight.set(key, current - 1);
    }
  }

  reset(): void {
    this.inFlight.clear();
    this.customCapacities.clear();
  }
}
