import { Persona, EffortLevel } from '../config/schema';
export type ProviderType = 'openai' | 'anthropic' | 'gemini' | 'deepseek' | 'omniroute_gateway' | string;
export type BillingTier = 'subscription_flat' | 'usage_based' | 'extra_usage_tier';
export interface ExtraUsageTierConfig {
    enabled: boolean;
    monthlyLimitUSD?: number;
    currentSpendUSD?: number;
    reservedSpendUSD?: number;
    costPer1kPromptTokens: number;
    costPer1kCompletionTokens: number;
}
export interface RateLimitConfig {
    requestsPerMinute?: number;
    tokensPerMinute?: number;
    concurrentRequests?: number;
}
export interface ProviderConfig {
    id: string;
    providerType: ProviderType;
    displayName: string;
    baseUrl: string;
    apiKey?: string;
    oauthRefreshToken?: string;
    billingTier: BillingTier;
    extraUsageTier?: ExtraUsageTierConfig;
    defaultModel: string;
    supportedModels: string[];
    priority: number;
    enabled: boolean;
    rateLimit?: RateLimitConfig;
    customHeaders?: Record<string, string>;
    timeoutMs?: number;
}
export interface LLMRequest {
    prompt: string;
    systemPrompt?: string;
    persona: Persona;
    effortLevel: EffortLevel;
    temperature?: number;
    provider?: ProviderType;
    model?: string;
    maxTokens?: number;
    metadata?: Record<string, unknown>;
}
export interface LLMTokensUsed {
    prompt: number;
    completion: number;
    total: number;
    reasoning?: number;
}
export interface LLMResponse {
    content: string;
    providerUsed: ProviderType;
    modelUsed: string;
    tokensUsed: LLMTokensUsed;
    reasoningTrace?: string;
    rawResponse?: unknown;
    billingTierUsed?: BillingTier;
    costEstimateUSD?: number;
}
export interface OmniRouteAdapterOptions {
    providers: ProviderConfig[];
    defaultProviderId?: string;
    httpFetch?: typeof fetch;
}
export interface IProviderAdapter {
    providerType: ProviderType;
    config: ProviderConfig;
    execute(request: LLMRequest, fetchFn: typeof fetch): Promise<LLMResponse>;
}
export declare class QuotaExhaustedError extends Error {
    readonly providerId: string;
    constructor(message: string, providerId: string);
}
export declare function synthesizeSystemPrompt(persona: Persona, customSystemPrompt?: string): string;
export declare function calculateTokenCost(tokens: LLMTokensUsed, promptCostPer1k: number, completionCostPer1k: number): number;
export declare function checkPreExecutionQuota(config: ProviderConfig): void;
export declare function reservePreExecutionSpend(config: ProviderConfig, estimatedUSD?: number): void;
export declare function releasePreExecutionReservation(config: ProviderConfig, estimatedUSD?: number): void;
export declare function recordPostExecutionSpend(config: ProviderConfig, tokensUsed: LLMTokensUsed): number | undefined;
/**
 * Concrete Provider: OmniRoute Gateway Adapter
 */
export declare class OmniRouteGatewayAdapter implements IProviderAdapter {
    config: ProviderConfig;
    providerType: ProviderType;
    constructor(config: ProviderConfig);
    execute(request: LLMRequest, fetchFn: typeof fetch): Promise<LLMResponse>;
}
/**
 * Concrete Provider: OpenAI Adapter
 */
export declare class OpenAIAdapter implements IProviderAdapter {
    config: ProviderConfig;
    providerType: ProviderType;
    constructor(config: ProviderConfig);
    execute(request: LLMRequest, fetchFn: typeof fetch): Promise<LLMResponse>;
}
/**
 * Concrete Provider: Anthropic Adapter
 */
export declare class AnthropicAdapter implements IProviderAdapter {
    config: ProviderConfig;
    providerType: ProviderType;
    constructor(config: ProviderConfig);
    execute(request: LLMRequest, fetchFn: typeof fetch): Promise<LLMResponse>;
}
/**
 * Concrete Provider: Gemini Adapter
 */
export declare class GeminiAdapter implements IProviderAdapter {
    config: ProviderConfig;
    providerType: ProviderType;
    constructor(config: ProviderConfig);
    execute(request: LLMRequest, fetchFn: typeof fetch): Promise<LLMResponse>;
}
/**
 * Concrete Provider: DeepSeek Adapter
 */
export declare class DeepSeekAdapter implements IProviderAdapter {
    config: ProviderConfig;
    providerType: ProviderType;
    constructor(config: ProviderConfig);
    execute(request: LLMRequest, fetchFn: typeof fetch): Promise<LLMResponse>;
}
/**
 * OmniRouteAdapter: Multi-provider router interfacing across active provider subscriptions
 */
export declare class OmniRouteAdapter {
    private providers;
    private defaultProviderId?;
    private httpFetch;
    constructor(options: OmniRouteAdapterOptions);
    registerProvider(provider: ProviderConfig): void;
    getProviders(): ProviderConfig[];
    complete(request: LLMRequest): Promise<LLMResponse>;
    private resolveProviderConfig;
    private createAdapter;
}
