import { logger } from '../utils/logger';

export type ProviderId = 'openai' | 'anthropic' | 'google' | 'gemini' | 'deepseek' | string;
export type ProviderHealthState = 'healthy' | 'degraded' | 'cooling_down' | 'offline';
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';
export type LoadBalancingStrategy = 'priority_fallback' | 'round_robin' | 'least_loaded';

export interface ProviderNodeConfig {
  id: ProviderId;
  name: string;
  priority: number; // Lower number = higher priority
  weight?: number;
  maxInFlight?: number;
}

export interface ProviderMetrics {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  rateLimitHits: number;
  serverErrors: number;
  activeInFlightRequests: number;
  consecutiveFailures: number;
  lastUsedTimestamp?: number;
  lastSuccessTimestamp?: number;
  lastErrorTimestamp?: number;
  lastErrorStatus?: number;
  avgLatencyMs: number;
}

export interface ProviderStatusSnapshot {
  id: ProviderId;
  name: string;
  priority: number;
  healthState: ProviderHealthState;
  circuitState: CircuitState;
  coolingDownUntil: string | null;
  metrics: ProviderMetrics;
}

export interface RouterPoolStatusSnapshot {
  status: 'ok' | 'degraded' | 'exhausted';
  timestamp: string;
  strategy: LoadBalancingStrategy;
  activeProvidersCount: number;
  totalProvidersCount: number;
  providers: Record<ProviderId, ProviderStatusSnapshot>;
}

export class ProviderPoolExhaustedError extends Error {
  constructor(message: string, public readonly attemptedProviders: ProviderId[]) {
    super(message);
    this.name = 'ProviderPoolExhaustedError';
  }
}

export class ProviderNode {
  public readonly id: ProviderId;
  public readonly name: string;
  public readonly priority: number;
  public healthState: ProviderHealthState = 'healthy';
  public circuitState: CircuitState = 'CLOSED';
  public coolingDownUntil: number | null = null;

  public metrics: ProviderMetrics = {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    rateLimitHits: 0,
    serverErrors: 0,
    activeInFlightRequests: 0,
    consecutiveFailures: 0,
    avgLatencyMs: 0,
  };

  private consecutiveCoolDownTrips = 0;
  private isProbing = false;
  private probeStartTime: number | null = null;

  constructor(config: ProviderNodeConfig) {
    this.id = config.id;
    this.name = config.name;
    this.priority = config.priority;
  }

  public isAvailable(): boolean {
    const now = Date.now();

    if (this.circuitState === 'OPEN') {
      if (this.coolingDownUntil && now >= this.coolingDownUntil) {
        this.circuitState = 'HALF_OPEN';
        this.isProbing = true;
        this.probeStartTime = now;
        return true;
      }
      return false;
    }

    if (this.circuitState === 'HALF_OPEN') {
      if (!this.isProbing) {
        this.isProbing = true;
        this.probeStartTime = now;
        return true;
      }
      if (this.probeStartTime && now - this.probeStartTime > 30000) {
        this.probeStartTime = now;
        return true;
      }
      return false;
    }

    return this.healthState === 'healthy' || this.healthState === 'degraded';
  }

  public recordStart(): void {
    this.metrics.totalRequests++;
    this.metrics.activeInFlightRequests++;
    this.metrics.lastUsedTimestamp = Date.now();
  }

  public recordSuccess(durationMs: number): void {
    this.metrics.activeInFlightRequests = Math.max(0, this.metrics.activeInFlightRequests - 1);
    this.metrics.successfulRequests++;
    this.metrics.consecutiveFailures = 0;
    this.metrics.lastSuccessTimestamp = Date.now();

    if (this.metrics.avgLatencyMs === 0) {
      this.metrics.avgLatencyMs = durationMs;
    } else {
      this.metrics.avgLatencyMs = Math.round(this.metrics.avgLatencyMs * 0.8 + durationMs * 0.2);
    }

    if (this.circuitState === 'HALF_OPEN' || this.healthState === 'cooling_down') {
      this.circuitState = 'CLOSED';
      this.healthState = 'healthy';
      this.coolingDownUntil = null;
      this.consecutiveCoolDownTrips = 0;
      this.isProbing = false;
      this.probeStartTime = null;
      logger.info(`Provider '${this.id}' recovered to HEALTHY state.`);
    }
  }

  public recordFailure(status: number, errorMsg: string, retryAfterHeader?: string | number): void {
    this.metrics.activeInFlightRequests = Math.max(0, this.metrics.activeInFlightRequests - 1);
    this.metrics.failedRequests++;
    this.metrics.consecutiveFailures++;
    this.metrics.lastErrorTimestamp = Date.now();
    this.metrics.lastErrorStatus = status;

    const now = Date.now();
    this.consecutiveCoolDownTrips++;
    this.isProbing = false;
    this.probeStartTime = null;

    if (status === 429) {
      this.metrics.rateLimitHits++;
      let coolDownMs = 10_000 * Math.pow(2, this.consecutiveCoolDownTrips - 1);
      if (retryAfterHeader !== undefined && retryAfterHeader !== null) {
        const parsedSeconds = typeof retryAfterHeader === 'number' ? retryAfterHeader : parseInt(retryAfterHeader, 10);
        if (!isNaN(parsedSeconds)) {
          coolDownMs = parsedSeconds * 1000;
        }
      }
      coolDownMs = Math.min(coolDownMs, 300_000);
      this.tripCircuit(now + coolDownMs, '429 Rate Limit Exceeded');
    } else if (status === 401 || status === 403) {
      const coolDownMs = Math.min(60_000 * Math.pow(2, this.consecutiveCoolDownTrips - 1), 300_000);
      this.tripCircuit(now + coolDownMs, `HTTP ${status} Auth Error: ${errorMsg}`);
    } else if (status >= 500) {
      this.metrics.serverErrors++;
      if (this.metrics.consecutiveFailures >= 3 || this.circuitState === 'HALF_OPEN') {
        const coolDownMs = Math.min(15_000 * Math.pow(2, this.consecutiveCoolDownTrips - 1), 300_000);
        this.tripCircuit(now + coolDownMs, `5xx Server Error (${status}): ${errorMsg}`);
      } else {
        this.healthState = 'degraded';
      }
    }
  }

  private tripCircuit(coolingDownUntilMs: number, reason: string): void {
    this.circuitState = 'OPEN';
    this.healthState = 'cooling_down';
    this.coolingDownUntil = coolingDownUntilMs;
    logger.warn(
      `Provider '${this.id}' Circuit Breaker TRIPPED: ${reason}. Cooling down for ${Math.round(
        (coolingDownUntilMs - Date.now()) / 1000
      )}s.`
    );
  }

  public getSnapshot(): ProviderStatusSnapshot {
    return {
      id: this.id,
      name: this.name,
      priority: this.priority,
      healthState: this.healthState,
      circuitState: this.circuitState,
      coolingDownUntil: this.coolingDownUntil ? new Date(this.coolingDownUntil).toISOString() : null,
      metrics: { ...this.metrics },
    };
  }
}

export class ProviderPool {
  private providers: Map<ProviderId, ProviderNode> = new Map();
  private strategy: LoadBalancingStrategy = 'priority_fallback';
  private roundRobinIndex = 0;

  constructor(strategy: LoadBalancingStrategy = 'priority_fallback') {
    this.strategy = strategy;
  }

  public registerProvider(config: ProviderNodeConfig): void {
    const node = new ProviderNode(config);
    this.providers.set(config.id, node);
  }

  public setStrategy(strategy: LoadBalancingStrategy): void {
    this.strategy = strategy;
  }

  public getStrategy(): LoadBalancingStrategy {
    return this.strategy;
  }

  public getProvider(id: ProviderId): ProviderNode | undefined {
    return this.providers.get(id);
  }

  public getAvailableProviders(): ProviderNode[] {
    const available: ProviderNode[] = [];
    for (const node of this.providers.values()) {
      if (node.isAvailable()) {
        available.push(node);
      }
    }
    return available.sort((a, b) => a.priority - b.priority);
  }

  private selectProviderFromList(candidates: ProviderNode[]): ProviderNode {
    if (candidates.length === 0) {
      throw new ProviderPoolExhaustedError('No candidate providers available.', []);
    }

    if (this.strategy === 'round_robin') {
      const node = candidates[this.roundRobinIndex % candidates.length];
      this.roundRobinIndex = (this.roundRobinIndex + 1) % candidates.length;
      return node;
    }

    if (this.strategy === 'least_loaded') {
      return candidates.reduce(
        (min, node) =>
          node.metrics.activeInFlightRequests < min.metrics.activeInFlightRequests ? node : min,
        candidates[0]
      );
    }

    return candidates[0];
  }

  public selectProvider(preferredProviderId?: ProviderId, excludeIds: ProviderId[] = []): ProviderNode {
    const available = this.getAvailableProviders().filter((p) => !excludeIds.includes(p.id));

    if (available.length === 0) {
      throw new ProviderPoolExhaustedError(
        'All AI providers in pool are offline or cooling down.',
        Array.from(this.providers.keys())
      );
    }

    if (preferredProviderId && !excludeIds.includes(preferredProviderId)) {
      const preferredNode = available.find((p) => p.id === preferredProviderId);
      if (preferredNode) {
        return preferredNode;
      }
      logger.warn(
        `Preferred provider '${preferredProviderId}' unavailable. Falling back to pool strategy '${this.strategy}'.`
      );
    }

    return this.selectProviderFromList(available);
  }

  public getStatusSnapshot(): RouterPoolStatusSnapshot {
    const available = this.getAvailableProviders();
    const total = this.providers.size;
    const providerSnapshots: Record<ProviderId, ProviderStatusSnapshot> = {};

    for (const [id, node] of this.providers.entries()) {
      providerSnapshots[id] = node.getSnapshot();
    }

    let status: 'ok' | 'degraded' | 'exhausted' = 'ok';
    if (total === 0 || available.length === 0) {
      status = 'exhausted';
    } else if (available.length < total) {
      status = 'degraded';
    }

    return {
      status,
      timestamp: new Date().toISOString(),
      strategy: this.strategy,
      activeProvidersCount: available.length,
      totalProvidersCount: total,
      providers: providerSnapshots,
    };
  }

  public async executeWithFailover<T>(
    operation: (provider: ProviderNode) => Promise<T>,
    preferredProviderId?: ProviderId
  ): Promise<{ result: T; providerUsed: ProviderId }> {
    const attempted: ProviderId[] = [];
    const maxAttempts = this.providers.size;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let node: ProviderNode;
      try {
        node = this.selectProvider(attempt === 0 ? preferredProviderId : undefined, attempted);
      } catch (err) {
        if (err instanceof ProviderPoolExhaustedError) {
          if (attempted.length > 0) {
            throw new ProviderPoolExhaustedError(
              `Execution failed. All providers exhausted after attempting: ${attempted.join(', ')}`,
              attempted
            );
          }
        }
        throw err;
      }

      attempted.push(node.id);
      node.recordStart();
      const startTime = Date.now();

      try {
        const result = await operation(node);
        node.recordSuccess(Date.now() - startTime);
        return { result, providerUsed: node.id };
      } catch (error: any) {
        const status = error?.status || error?.statusCode || 500;
        const msg = error?.message || 'Unknown provider error';
        const retryAfter = error?.headers?.['retry-after'] || error?.retryAfter;

        node.recordFailure(status, msg, retryAfter);
        logger.warn(
          `Provider '${node.id}' failed (HTTP ${status}). Initiating failover attempt ${
            attempt + 1
          }/${maxAttempts}.`
        );
      }
    }

    throw new ProviderPoolExhaustedError(
      `All available providers failed during operation. Attempted: ${attempted.join(', ')}`,
      attempted
    );
  }
}
