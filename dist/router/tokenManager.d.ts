import { Persona, EffortLevel } from '../config/schema';
export interface EncryptedPayload {
    iv: string;
    authTag: string;
    ciphertext: string;
    algorithm: 'aes-256-gcm';
    updatedAt: string;
}
export interface OAuthTokenData {
    accessToken: string;
    refreshToken?: string;
    tokenType?: string;
    expiresAt: number;
    scope?: string;
}
export interface TokenRefreshConfig {
    providerId: string;
    tokenUrl?: string;
    clientId?: string;
    clientSecret?: string;
    refreshToken?: string;
    preemptiveRefreshWindowMs?: number;
    customRefreshHandler?: (refreshToken: string) => Promise<OAuthTokenData>;
}
export interface TokenUsageRecord {
    requestId: string;
    repoOwner?: string;
    repoName?: string;
    prNumber?: number;
    persona: Persona;
    effortLevel: EffortLevel;
    provider: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    reasoningTokens?: number;
    totalTokens: number;
    durationMs: number;
    timestamp: string;
}
export interface PersonaMetricsSummary {
    persona: Persona;
    totalRequests: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    averageTokensPerRequest: number;
    averageDurationMs: number;
}
export interface GlobalMetricsSummary {
    totalRequests: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalTokens: number;
    byPersona: Record<Persona, PersonaMetricsSummary>;
    byProvider: Record<string, {
        totalRequests: number;
        totalTokens: number;
    }>;
}
export interface EffortConfig {
    effortLevel: EffortLevel;
    maxOutputTokens: number;
    promptTokenBudget: number;
    temperature: number;
    reasoningEffort: 'none' | 'low' | 'medium' | 'high';
    timeoutMs: number;
    providerExtraParams: Record<string, any>;
}
/**
 * SecureSecretStore: AES-256-GCM authenticated encryption store using native node:crypto.
 */
export declare class SecureSecretStore {
    private masterKey;
    private legacyMasterKey?;
    private salt;
    private store;
    constructor(masterKeyHex?: string, saltInput?: string | Buffer);
    setSecret(key: string, value: string): void;
    getSecret(key: string): string | null;
    deleteSecret(key: string): boolean;
    hasSecret(key: string): boolean;
    exportEncryptedStore(): Record<string, EncryptedPayload>;
    importEncryptedStore(serialized: Record<string, EncryptedPayload>): void;
}
/**
 * TokenMetricsTracker: Tracks prompt, completion, and reasoning token usage metrics per persona and provider.
 */
export declare class TokenMetricsTracker {
    private records;
    recordUsage(record: TokenUsageRecord): void;
    getPersonaMetrics(persona: Persona): PersonaMetricsSummary;
    getGlobalMetrics(): GlobalMetricsSummary;
    resetMetrics(): void;
    getRecords(): TokenUsageRecord[];
}
/**
 * EffortScaler: Maps effort levels ('low', 'medium', 'high', 'reasoning') to max output tokens, temperature, reasoning parameters, etc.
 */
export declare class EffortScaler {
    private static baseMatrix;
    static resolveEffortLevel(requestedEffort?: EffortLevel, persona?: Persona, diffLineCount?: number): EffortLevel;
    static getEffortConfig(requestedEffort?: EffortLevel, persona?: Persona, diffLineCount?: number, provider?: string): EffortConfig;
}
/**
 * TokenRefreshManager: Async single-flight mutex lock for token refresh, preemptive expiry window, reactive 401 retry handling.
 */
export declare class TokenRefreshManager {
    private secretStore;
    private refreshConfigs;
    private tokenDataCache;
    private inFlightRefreshes;
    constructor(secretStore: SecureSecretStore);
    registerRefreshConfig(config: TokenRefreshConfig): void;
    setOAuthTokenData(providerId: string, data: OAuthTokenData): void;
    getOAuthTokenData(providerId: string): OAuthTokenData | undefined;
    getValidAccessToken(providerId: string, fetchFn?: typeof fetch): Promise<string>;
    refreshAccessToken(providerId: string, fetchFn?: typeof fetch): Promise<string>;
}
/**
 * Main TokenManager class aggregating secret store, metrics tracker, effort scaler, and refresh manager.
 */
export declare class TokenManager {
    private secretStore;
    private metricsTracker;
    private refreshManager;
    constructor(masterKeyHex?: string);
    getSecretStore(): SecureSecretStore;
    setSecretKey(key: string, secret: string): void;
    getSecretKey(key: string): string | null;
    deleteSecretKey(key: string): boolean;
    registerRefreshConfig(config: TokenRefreshConfig): void;
    setOAuthTokenData(providerId: string, data: OAuthTokenData): void;
    getValidAccessToken(providerId: string, fetchFn?: typeof fetch): Promise<string>;
    refreshAccessToken(providerId: string, fetchFn?: typeof fetch): Promise<string>;
    recordUsage(record: TokenUsageRecord): void;
    getPersonaMetrics(persona: Persona): PersonaMetricsSummary;
    getGlobalMetrics(): GlobalMetricsSummary;
    resetMetrics(): void;
    getEffortConfig(requestedEffort?: EffortLevel, persona?: Persona, diffLineCount?: number, provider?: string): EffortConfig;
}
