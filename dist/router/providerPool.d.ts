export type ProviderId = 'openai' | 'anthropic' | 'google' | 'gemini' | 'deepseek' | string;
export type ProviderHealthState = 'healthy' | 'degraded' | 'cooling_down' | 'offline';
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';
export type LoadBalancingStrategy = 'priority_fallback' | 'round_robin' | 'least_loaded';
export interface ProviderNodeConfig {
    id: ProviderId;
    name: string;
    priority: number;
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
export declare class ProviderPoolExhaustedError extends Error {
    readonly attemptedProviders: ProviderId[];
    constructor(message: string, attemptedProviders: ProviderId[]);
}
export declare class ProviderNode {
    readonly id: ProviderId;
    readonly name: string;
    readonly priority: number;
    healthState: ProviderHealthState;
    circuitState: CircuitState;
    coolingDownUntil: number | null;
    metrics: ProviderMetrics;
    private consecutiveCoolDownTrips;
    private isProbing;
    private probeStartTime;
    constructor(config: ProviderNodeConfig);
    isAvailable(): boolean;
    recordStart(): void;
    recordSuccess(durationMs: number): void;
    recordFailure(status: number, errorMsg: string, retryAfterHeader?: string | number): void;
    private tripCircuit;
    getSnapshot(): ProviderStatusSnapshot;
}
export declare class ProviderPool {
    private providers;
    private strategy;
    private roundRobinIndex;
    constructor(strategy?: LoadBalancingStrategy);
    registerProvider(config: ProviderNodeConfig): void;
    setStrategy(strategy: LoadBalancingStrategy): void;
    getStrategy(): LoadBalancingStrategy;
    getProvider(id: ProviderId): ProviderNode | undefined;
    getAvailableProviders(): ProviderNode[];
    private selectProviderFromList;
    selectProvider(preferredProviderId?: ProviderId, excludeIds?: ProviderId[]): ProviderNode;
    getStatusSnapshot(): RouterPoolStatusSnapshot;
    executeWithFailover<T>(operation: (provider: ProviderNode) => Promise<T>, preferredProviderId?: ProviderId): Promise<{
        result: T;
        providerUsed: ProviderId;
    }>;
}
