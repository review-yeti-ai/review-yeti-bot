# Milestone 2: Provider Pool, Failover Engine & Test Suite Design Report

**Author**: Explorer 3  
**Target Component**: `src/router/providerPool.ts`, `src/app.ts`, `src/index.ts`, and Milestone 2 Test Suite Layout (`tests/unit/`, `tests/integration/`)  
**Project**: `ct-review-bot`  
**Date**: July 24, 2026  

---

## 1. Executive Summary & Scope

Milestone 2 establishes the **Multi-LLM Routing Engine** for `ct-review-bot`. While Explorer 1 focuses on multi-provider API formatting (`omniRouteAdapter.ts`) and Explorer 2 focuses on secrets/token lifecycle management (`tokenManager.ts`), **Explorer 3** is responsible for the core **Provider Pool, Circuit Breaker & Failover Engine** (`src/router/providerPool.ts`), its **integration into the Express App** (`src/app.ts`, `src/index.ts`), and the **Milestone 2 Test Suite Layout**.

### Primary Objectives
1. **Provider Pool & Failover Engine (`src/router/providerPool.ts`)**:
   - Dynamic management of multi-LLM providers (`openai`, `anthropic`, `google`, `deepseek`, etc.) organized by priority queues.
   - Granular state tracking: `healthy`, `degraded`, `offline`, `cooling_down`.
   - Automated Circuit Breaker handling 429 Rate Limits (respecting `Retry-After` headers or exponential backoff) and 5xx Server Errors (consecutive error thresholds, exponential backoff, and Half-Open recovery probing).
   - Multi-strategy load balancing (`priority_fallback`, `round_robin`, `least_loaded`).
2. **App & Service Integration (`src/app.ts` & `src/index.ts`)**:
   - Expose operational endpoint `GET /api/router/status` returning real-time metrics, provider availability, circuit breaker state, and latency.
   - Enforce lifecycle safety (timer cleanup on service shutdown).
3. **Milestone 2 Test Suite Layout (`tests/`)**:
   - Comprehensive test layout plan covering unit tests (`tests/unit/omniRoute.test.ts`, `tests/unit/tokenManager.test.ts`, `tests/unit/providerPool.test.ts`) and integration tests (`tests/integration/m2_router.test.ts`).

---

## 2. Detailed Architecture: Provider Pool & Failover Engine (`src/router/providerPool.ts`)

```
                          [ Incoming Completion Request ]
                                        │
                                        ▼
                         ┌─────────────────────────────┐
                         │    LoadBalancingEngine      │
                         │ (priority/round_robin/least)│
                         └──────────────┬──────────────┘
                                        │ Select Best Healthy Provider Node
                                        ▼
                         ┌─────────────────────────────┐
                         │      ProviderNode           │
                         │   (Check Circuit Breaker)   │
                         └──────────────┬──────────────┘
                                        │
                    ┌───────────────────┴───────────────────┐
                    ▼                                       ▼
            [ CLOSED / HEALTHY ]                    [ OPEN / COOLING_DOWN ]
                    │                                       │
                    ▼                                       ▼
             Execute Request                        Failover to Next Node
             ┌──────┴──────┐                        in Priority Queue
             ▼             ▼                                │
          Success       Failure (429/5xx)                   ▼
             │             │                       If All Nodes Exhausted
             │             ▼                       ┌────────────────┐
             │       Record Failure                │ Throw Pool     │
             │       Trip Breaker?                 │ Exhausted Error│
             │       ┌─────┴─────┐                 └────────────────┘
             │       YES         NO
             │       │           │
             ▼       ▼           ▼
         Reset Fail  State ->    Increment
         Count       COOLING     Fail Count
                     DOWN
```

### 2.1 Provider State Machine & Health Tracking

Each provider registered in the pool transitions through four primary states:

| Health State | Definition | Traffic Eligibility | Transition Triggers |
| :--- | :--- | :--- | :--- |
| `healthy` | Provider operating normally with low error rates (< 5%) and normal latency. | Primary Traffic | Initial state; Recovery from `half_open` probe success. |
| `degraded` | Provider experiencing elevated latency or sporadic 5xx errors (< threshold), but operational. | Fallback Traffic | High average latency or 1-2 non-critical HTTP errors. |
| `cooling_down` | Circuit Breaker OPEN due to HTTP 429 (Rate Limit) or consecutive 5xx errors. Paused until backoff timer expires. | Excluded from active rotation | 429 response or 3 consecutive 5xx failures. |
| `offline` | Circuit Breaker OPEN continuously across multiple cooldown cycles or persistent network unreachability. | Completely Excluded | Multiple consecutive probe failures or explicit admin disable. |

#### Half-Open / Probing State
When a provider's `coolingDownUntil` timestamp passes, the Circuit Breaker transitions into `HALF_OPEN`. The provider pool permits a single probe request. If successful, state resets to `healthy`. If it fails, cooldown doubles and state returns to `cooling_down` or degrades to `offline`.

### 2.2 Circuit Breaker Subsystem

The Circuit Breaker prevents cascading service failures and avoids sending traffic to rate-limited or failing LLM endpoints.

#### Circuit Breaker Configuration Interface
```typescript
export interface CircuitBreakerConfig {
  /** Maximum consecutive 5xx failures before tripping circuit breaker */
  failureThreshold: number; // default: 3
  /** Base cooldown time for 429 Rate Limits in milliseconds */
  coolDownBase429Ms: number; // default: 10,000 ms (10s)
  /** Base cooldown time for 5xx Server Errors in milliseconds */
  coolDownBase5xxMs: number; // default: 15,000 ms (15s)
  /** Maximum backoff ceiling in milliseconds */
  maxCoolDownMs: number; // default: 300,000 ms (5 mins)
  /** Backoff multiplier for consecutive trips */
  backoffMultiplier: number; // default: 2.0
  /** Success reset window in milliseconds */
  resetTimeoutMs: number; // default: 60,000 ms (1 min)
}
```

#### Handling HTTP 429 vs HTTP 5xx
1. **HTTP 429 (Rate Limit Exceeded)**:
   - Check response headers for `Retry-After` (in seconds or HTTP date).
   - If present, set `coolingDownUntil = Date.now() + retryAfterSeconds * 1000`.
   - If absent, calculate cooldown: `Math.min(coolDownBase429Ms * (backoffMultiplier ^ consecutive429s), maxCoolDownMs)`.
   - Immediately transition provider state to `cooling_down`.
2. **HTTP 5xx (Internal Server Error / Gateway Timeout)**:
   - Increment `consecutiveFailures`.
   - If `consecutiveFailures >= failureThreshold`, trip Circuit Breaker to `OPEN`.
   - Cooldown duration: `Math.min(coolDownBase5xxMs * (backoffMultiplier ^ consecutiveFailures), maxCoolDownMs)`.
   - Transition state to `cooling_down`.

### 2.3 Load Balancing Engine Strategies

The Provider Pool supports three load balancing strategies:

1. **`priority_fallback` (Default)**:
   - Maintains an ordered list of providers by tier (e.g., Primary: `['openai', 'anthropic']`, Secondary: `['google', 'deepseek']`).
   - Always attempts the highest-priority `healthy` provider first.
   - If primary is `cooling_down` or `offline`, fails over to the next healthy provider in priority order.
2. **`round_robin`**:
   - Distributes requests sequentially across all active `healthy` providers using an atomic index counter.
   - Ensures equal workload distribution when multiple API subscriptions are available.
3. **`least_loaded`**:
   - Selects the active `healthy` provider with the lowest current `activeInFlightRequests`.
   - If tied, picks the provider with the lowest `avgLatencyMs`.
   - Optimal for parallel quorum execution across multiple reviewer personas (`security`, `architecture`, `performance`, `quality`).

---

## 3. Class Specifications: `src/router/providerPool.ts`

### 3.1 Type Definitions
```typescript
export type ProviderId = 'openai' | 'anthropic' | 'google' | 'deepseek' | string;
export type ProviderHealthState = 'healthy' | 'degraded' | 'cooling_down' | 'offline';
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';
export type LoadBalancingStrategy = 'priority_fallback' | 'round_robin' | 'least_loaded';

export interface ProviderNodeConfig {
  id: ProviderId;
  name: string;
  priority: number; // Lower index = higher priority (e.g. 1 = primary, 2 = secondary)
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
```

### 3.2 ProviderPool Implementation Blueprint
```typescript
import { logger } from '../utils/logger';

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

  constructor(config: ProviderNodeConfig) {
    this.id = config.id;
    this.name = config.name;
    this.priority = config.priority;
  }

  public isAvailable(): boolean {
    const now = Date.now();
    if (this.circuitState === 'OPEN') {
      if (this.coolingDownUntil && now >= this.coolingDownUntil) {
        // Transition to HALF_OPEN probe state
        this.circuitState = 'HALF_OPEN';
        return true;
      }
      return false;
    }
    return this.healthState === 'healthy' || this.healthState === 'degraded' || this.circuitState === 'HALF_OPEN';
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

    // Update moving average latency
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

    if (status === 429) {
      this.metrics.rateLimitHits++;
      let coolDownMs = 10_000 * Math.pow(2, this.consecutiveCoolDownTrips - 1);
      if (retryAfterHeader) {
        const parsedSeconds = typeof retryAfterHeader === 'number' ? retryAfterHeader : parseInt(retryAfterHeader, 10);
        if (!isNaN(parsedSeconds)) {
          coolDownMs = parsedSeconds * 1000;
        }
      }
      coolDownMs = Math.min(coolDownMs, 300_000); // 5 min cap
      this.tripCircuit(now + coolDownMs, '429 Rate Limit Exceeded');
    } else if (status >= 500) {
      this.metrics.serverErrors++;
      if (this.metrics.consecutiveFailures >= 3 || this.circuitState === 'HALF_OPEN') {
        const coolDownMs = Math.min(15_000 * Math.pow(2, this.consecutiveCoolDownTrips - 1), 300_000);
        this.tripCircuit(now + coolDownMs, `5xx Server Error (${status}): ${errorMsg}`);
      }
    }
  }

  private tripCircuit(coolingDownUntilMs: number, reason: string): void {
    this.circuitState = 'OPEN';
    this.healthState = 'cooling_down';
    this.coolingDownUntil = coolingDownUntilMs;
    logger.warn(`Provider '${this.id}' Circuit Breaker TRIPPED: ${reason}. Cooling down for ${Math.round((coolingDownUntilMs - Date.now()) / 1000)}s.`);
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

  public getAvailableProviders(): ProviderNode[] {
    const available: ProviderNode[] = [];
    for (const node of this.providers.values()) {
      if (node.isAvailable()) {
        available.push(node);
      }
    }
    return available.sort((a, b) => a.priority - b.priority);
  }

  public selectProvider(preferredProviderId?: ProviderId): ProviderNode {
    const available = this.getAvailableProviders();

    if (available.length === 0) {
      throw new ProviderPoolExhaustedError('All AI providers in pool are offline or cooling down.', Array.from(this.providers.keys()));
    }

    // Explicit preference check
    if (preferredProviderId) {
      const preferredNode = available.find((p) => p.id === preferredProviderId);
      if (preferredNode) {
        return preferredNode;
      }
      logger.warn(`Preferred provider '${preferredProviderId}' unavailable. Falling back to pool strategy '${this.strategy}'.`);
    }

    if (this.strategy === 'round_robin') {
      const node = available[this.roundRobinIndex % available.length];
      this.roundRobinIndex = (this.roundRobinIndex + 1) % available.length;
      return node;
    }

    if (this.strategy === 'least_loaded') {
      return available.reduce((min, node) => (node.metrics.activeInFlightRequests < min.metrics.activeInFlightRequests ? node : min), available[0]);
    }

    // Default: priority_fallback
    return available[0];
  }

  public getStatusSnapshot(): RouterPoolStatusSnapshot {
    const available = this.getAvailableProviders();
    const total = this.providers.size;
    const providerSnapshots: Record<ProviderId, ProviderStatusSnapshot> = {};

    for (const [id, node] of this.providers.entries()) {
      providerSnapshots[id] = node.getSnapshot();
    }

    let status: 'ok' | 'degraded' | 'exhausted' = 'ok';
    if (available.length === 0) {
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
        node = this.selectProvider(attempt === 0 ? preferredProviderId : undefined);
      } catch (err) {
        if (err instanceof ProviderPoolExhaustedError) {
          throw new ProviderPoolExhaustedError(
            `Execution failed. All providers exhausted after attempting: ${attempted.join(', ')}`,
            attempted
          );
        }
        throw err;
      }

      if (attempted.includes(node.id)) {
        break; // Prevent infinitely retrying the same node in a single call cycle
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
        logger.warn(`Provider '${node.id}' failed (HTTP ${status}). Initiating failover attempt ${attempt + 1}/${maxAttempts}.`);
      }
    }

    throw new ProviderPoolExhaustedError(
      `All available providers failed during operation. Attempted: ${attempted.join(', ')}`,
      attempted
    );
  }
}
```

---

## 4. App & Service Integration (`src/app.ts` & `src/index.ts`)

### 4.1 Router Status Endpoint: `GET /api/router/status`

To provide operational visibility for cluster health, monitoring dashboards, and E2E integration tests, `src/app.ts` must expose `/api/router/status`.

#### Response Specification (`GET /api/router/status`)
```json
{
  "status": "ok",
  "timestamp": "2026-07-24T14:42:43.000Z",
  "strategy": "priority_fallback",
  "activeProvidersCount": 3,
  "totalProvidersCount": 4,
  "providers": {
    "openai": {
      "id": "openai",
      "name": "OpenAI GPT-4o",
      "priority": 1,
      "healthState": "healthy",
      "circuitState": "CLOSED",
      "coolingDownUntil": null,
      "metrics": {
        "totalRequests": 150,
        "successfulRequests": 148,
        "failedRequests": 2,
        "rateLimitHits": 0,
        "serverErrors": 2,
        "activeInFlightRequests": 1,
        "consecutiveFailures": 0,
        "avgLatencyMs": 310
      }
    },
    "anthropic": {
      "id": "anthropic",
      "name": "Anthropic Claude 3.5",
      "priority": 2,
      "healthState": "healthy",
      "circuitState": "CLOSED",
      "coolingDownUntil": null,
      "metrics": {
        "totalRequests": 40,
        "successfulRequests": 40,
        "failedRequests": 0,
        "rateLimitHits": 0,
        "serverErrors": 0,
        "activeInFlightRequests": 0,
        "consecutiveFailures": 0,
        "avgLatencyMs": 420
      }
    },
    "google": {
      "id": "google",
      "name": "Google Gemini 1.5 Pro",
      "priority": 3,
      "healthState": "cooling_down",
      "circuitState": "OPEN",
      "coolingDownUntil": "2026-07-24T14:45:00.000Z",
      "metrics": {
        "totalRequests": 10,
        "successfulRequests": 7,
        "failedRequests": 3,
        "rateLimitHits": 1,
        "serverErrors": 2,
        "activeInFlightRequests": 0,
        "consecutiveFailures": 3,
        "avgLatencyMs": 850
      }
    }
  }
}
```

### 4.2 Integration in `src/app.ts`
```typescript
import { ProviderPool } from './router/providerPool';

// Instantiate default shared provider pool
let globalProviderPool: ProviderPool | null = null;

export function getProviderPool(): ProviderPool {
  if (!globalProviderPool) {
    globalProviderPool = new ProviderPool('priority_fallback');
    // Register default providers
    globalProviderPool.registerProvider({ id: 'openai', name: 'OpenAI GPT-4o', priority: 1 });
    globalProviderPool.registerProvider({ id: 'anthropic', name: 'Anthropic Claude 3.5', priority: 2 });
    globalProviderPool.registerProvider({ id: 'google', name: 'Google Gemini 1.5 Pro', priority: 3 });
    globalProviderPool.registerProvider({ id: 'deepseek', name: 'DeepSeek V3', priority: 4 });
  }
  return globalProviderPool;
}

// Inside createApp():
export function createApp(): Express {
  const app = express();
  const pool = getProviderPool();

  // Updated /health endpoint with router subsystem check
  app.get('/health', (_req: Request, res: Response) => {
    const poolStatus = pool.getStatusSnapshot();
    res.status(200).json({
      status: poolStatus.status === 'exhausted' ? 'degraded' : 'ok',
      service: 'ct-review-bot',
      timestamp: new Date().toISOString(),
      uptimeSeconds: process.uptime(),
      router: {
        activeProviders: poolStatus.activeProvidersCount,
        totalProviders: poolStatus.totalProvidersCount,
        poolStatus: poolStatus.status,
      },
    });
  });

  // Dedicated router status endpoint
  app.get('/api/router/status', (_req: Request, res: Response) => {
    res.status(200).json(pool.getStatusSnapshot());
  });

  return app;
}
```

---

## 5. Milestone 2 Test Suite Layout Plan

The test layout structures tests logically across unit tests (`tests/unit/`) and full engine integration tests (`tests/integration/`).

```
tests/
├── unit/
│   ├── omniRoute.test.ts        # Explorer 1: OmniRouteAdapter payload formatting & provider translation
│   ├── tokenManager.test.ts      # Explorer 2: Secret storage, OAuth token refresh, effort scaling & consumption
│   └── providerPool.test.ts      # Explorer 3: Provider Pool, Circuit Breaker, failover & load balancing
└── integration/
    └── m2_router.test.ts         # End-to-End Milestone 2 Router Engine integration test
```

### 5.1 `tests/unit/providerPool.test.ts` (Explorer 3 Test Plan)
- **Unit 1: State Machine & Transition**:
  - Verify new provider initializes in `healthy` / `CLOSED` state.
  - Verify state transitions to `cooling_down` / `OPEN` on 429 or 3 consecutive 5xx errors.
  - Verify timer expiration moves node to `HALF_OPEN` probe state.
- **Unit 2: Circuit Breaker Backoff & Header Parsing**:
  - Test parsing `Retry-After: 30` header sets exact 30s cooldown.
  - Test exponential backoff scaling on repeated trips (`10s -> 20s -> 40s`).
- **Unit 3: Load Balancing Strategies**:
  - Test `priority_fallback`: always picks highest priority healthy node.
  - Test `round_robin`: distributes requests evenly across available nodes.
  - Test `least_loaded`: selects node with lowest active in-flight count.
- **Unit 4: Failover Execution & Pool Exhaustion**:
  - Test `executeWithFailover` automatically retries next healthy provider on 503 error.
  - Test throwing `ProviderPoolExhaustedError` when all registered providers fail.

### 5.2 `tests/unit/omniRoute.test.ts` (Explorer 1 Test Plan)
- Test request construction for OpenAI, Anthropic, Gemini, and DeepSeek.
- Test system prompt and reviewer persona injection (`security`, `architecture`, `performance`, `quality`).
- Test completion response normalization into standardized `LLMResponse`.

### 5.3 `tests/unit/tokenManager.test.ts` (Explorer 2 Test Plan)
- Test AES-256-GCM encryption and decryption of provider secrets.
- Test automatic OAuth token refresh on 401 `token_expired` response.
- Test persona token consumption tracking metrics.
- Test effort level parameter mapping (`low`, `medium`, `high`, `reasoning`).

### 5.4 `tests/integration/m2_router.test.ts` (Milestone 2 Integration Test Plan)
- **Integration Test Setup**: Start Express App (`createApp()`) with Mock OmniRoute Server (`MockOmniRouteServer`).
- **Test 1: Full Quorum Completion Routing**: Execute multi-persona completion requests; verify provider pool tracking and status endpoint `/api/router/status` reflecting metrics.
- **Test 2: Live Failover Handling**: Simulate primary provider failure (HTTP 503) on `openai`. Verify engine automatically routes to `anthropic` without client request failure. Check `/api/router/status` showing `openai` as `cooling_down` and `anthropic` as active.
- **Test 3: Rate Limit Circuit Breaker Recovery**: Simulate HTTP 429 response on `anthropic`. Verify circuit breaker trips, routes to `google`, and recovers to `healthy` state after cooldown window.
- **Test 4: OAuth Token Refresh Lifecycle**: Simulate token expiration (HTTP 401). Verify `TokenManager` refreshes access token seamlessly via `/v1/oauth/token` endpoint.

---

## 6. Implementation & Integration Guidelines for Implementers

1. **Keep `providerPool.ts` Zero-Dependency**:
   - Rely only on standard Node.js primitives and local logger (`src/utils/logger.ts`).
2. **Prevent Timer Leaks**:
   - Avoid creating persistent `setInterval` timers for health probes; evaluate `coolingDownUntil` dynamically when `isAvailable()` is called, or track cleanup functions for process shutdown.
3. **Co-locating Unit & Integration Tests**:
   - Ensure `vitest` command (`npm test`) picks up `tests/unit/*.test.ts` and `tests/integration/*.test.ts`.

---

## 7. Verification Method

To verify the Milestone 2 Router implementation:
```bash
# 1. Type-check TypeScript sources
npm run lint

# 2. Run unit test suite
npm run test tests/unit/providerPool.test.ts tests/unit/omniRoute.test.ts tests/unit/tokenManager.test.ts

# 3. Run Milestone 2 Integration Test
npm run test tests/integration/m2_router.test.ts

# 4. Verify existing M1 foundations test suite regression
npm run test tests/integration/m1_foundations.test.ts
```
