import { Persona, EffortLevel } from '../config/schema';
import { logger } from '../utils/logger';

export type ProviderType =
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'deepseek'
  | 'omniroute_gateway'
  | string;

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

export class QuotaExhaustedError extends Error {
  constructor(message: string, public readonly providerId: string) {
    super(message);
    this.name = 'QuotaExhaustedError';
  }
}

export function synthesizeSystemPrompt(persona: Persona, customSystemPrompt?: string): string {
  const basePrompts: Record<Persona, string> = {
    security:
      'You are a Senior Security Engineer reviewing code for vulnerability risks, OWASP Top 10, memory safety, input validation, and auth flaws.',
    architecture:
      'You are a Principal Software Architect reviewing code for design patterns, modularity, scalability, breaking API changes, and maintainability.',
    performance:
      'You are a Performance Optimization Engineer reviewing code for time/space complexity, async bottlenecks, memory leaks, and unnecessary allocations.',
    quality:
      'You are a Senior Code Quality Lead reviewing code for readability, test coverage, code style, error handling, and naming conventions.',
  };
  const personaPrompt = basePrompts[persona] || basePrompts.quality;
  return customSystemPrompt ? `${customSystemPrompt}\n\n${personaPrompt}` : personaPrompt;
}

export function calculateTokenCost(
  tokens: LLMTokensUsed,
  promptCostPer1k: number,
  completionCostPer1k: number
): number {
  const promptCost = (tokens.prompt / 1000) * promptCostPer1k;
  const completionCost = (tokens.completion / 1000) * completionCostPer1k;
  return Number((promptCost + completionCost).toFixed(6));
}

export function checkPreExecutionQuota(config: ProviderConfig): void {
  if (
    config.extraUsageTier?.enabled &&
    config.extraUsageTier.monthlyLimitUSD !== undefined
  ) {
    const current = config.extraUsageTier.currentSpendUSD || 0;
    const reserved = config.extraUsageTier.reservedSpendUSD || 0;
    if (current + reserved >= config.extraUsageTier.monthlyLimitUSD) {
      throw new QuotaExhaustedError(
        `Extra usage monthly spend limit ($${config.extraUsageTier.monthlyLimitUSD}) already reached or reserved for provider: ${config.id}`,
        config.id
      );
    }
  }
}

export function reservePreExecutionSpend(config: ProviderConfig, estimatedUSD: number = 0.005): void {
  checkPreExecutionQuota(config);
  if (config.extraUsageTier?.enabled) {
    config.extraUsageTier.reservedSpendUSD = Number(
      ((config.extraUsageTier.reservedSpendUSD || 0) + estimatedUSD).toFixed(6)
    );
  }
}

export function releasePreExecutionReservation(config: ProviderConfig, estimatedUSD: number = 0.005): void {
  if (config.extraUsageTier?.enabled && config.extraUsageTier.reservedSpendUSD) {
    config.extraUsageTier.reservedSpendUSD = Math.max(
      0,
      Number((config.extraUsageTier.reservedSpendUSD - estimatedUSD).toFixed(6))
    );
  }
}

export function recordPostExecutionSpend(
  config: ProviderConfig,
  tokensUsed: LLMTokensUsed
): number | undefined {
  if (
    config.billingTier === 'usage_based' ||
    (config.billingTier === 'extra_usage_tier' && config.extraUsageTier?.enabled)
  ) {
    const promptCost = config.extraUsageTier?.costPer1kPromptTokens ?? 0.0015;
    const completionCost = config.extraUsageTier?.costPer1kCompletionTokens ?? 0.002;
    const costEstimateUSD = calculateTokenCost(tokensUsed, promptCost, completionCost);

    if (config.extraUsageTier?.enabled) {
      const current = config.extraUsageTier.currentSpendUSD || 0;
      const newSpend = Number((current + costEstimateUSD).toFixed(6));
      config.extraUsageTier.currentSpendUSD = newSpend;

      if (
        config.extraUsageTier.monthlyLimitUSD !== undefined &&
        newSpend >= config.extraUsageTier.monthlyLimitUSD
      ) {
        logger.warn(
          `Extra usage monthly spend limit ($${config.extraUsageTier.monthlyLimitUSD}) reached/exceeded for ${config.id} (current spend: $${newSpend})`
        );
      }
    }
    return costEstimateUSD;
  }
  return undefined;
}

/**
 * Concrete Provider: OmniRoute Gateway Adapter
 */
export class OmniRouteGatewayAdapter implements IProviderAdapter {
  public providerType: ProviderType = 'omniroute_gateway';
  constructor(public config: ProviderConfig) {}

  async execute(request: LLMRequest, fetchFn: typeof fetch): Promise<LLMResponse> {
    const estimatedUSD = 0.005;
    reservePreExecutionSpend(this.config, estimatedUSD);

    try {
      const url = `${this.config.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`;
      const systemPrompt = synthesizeSystemPrompt(request.persona, request.systemPrompt);

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
        ...this.config.customHeaders,
      };

      const res = await fetchFn(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          provider: request.provider || this.config.providerType,
          model: request.model || this.config.defaultModel,
          persona: request.persona,
          effortLevel: request.effortLevel,
          prompt: request.prompt,
          systemPrompt,
          temperature: request.temperature ?? 0.3,
          maxTokens: request.maxTokens,
        }),
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        const err: any = new Error(`OmniRouteGateway failed with status ${res.status}: ${errorText}`);
        err.status = res.status;
        err.statusCode = res.status;
        throw err;
      }

      const data: any = await res.json();
      const tokensUsed: LLMTokensUsed = data.tokensUsed || {
        prompt: data.usage?.prompt_tokens || 100,
        completion: data.usage?.completion_tokens || 100,
        total: data.usage?.total_tokens || 200,
      };

      const costEstimateUSD = recordPostExecutionSpend(this.config, tokensUsed);

      return {
        content: data.content || (typeof data.data === 'string' ? data.data : JSON.stringify(data)),
        providerUsed: data.providerUsed || this.config.providerType,
        modelUsed: data.modelUsed || request.model || this.config.defaultModel,
        tokensUsed,
        reasoningTrace: data.reasoningTrace,
        rawResponse: data,
        billingTierUsed: this.config.billingTier,
        costEstimateUSD,
      };
    } finally {
      releasePreExecutionReservation(this.config, estimatedUSD);
    }
  }
}

/**
 * Concrete Provider: OpenAI Adapter
 */
export class OpenAIAdapter implements IProviderAdapter {
  public providerType: ProviderType = 'openai';
  constructor(public config: ProviderConfig) {}

  async execute(request: LLMRequest, fetchFn: typeof fetch): Promise<LLMResponse> {
    const estimatedUSD = 0.005;
    reservePreExecutionSpend(this.config, estimatedUSD);

    try {
      const url = `${this.config.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`;
      const systemPrompt = synthesizeSystemPrompt(request.persona, request.systemPrompt);

      const body: any = {
        model: request.model || this.config.defaultModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: request.prompt },
        ],
        temperature: request.temperature ?? (request.effortLevel === 'reasoning' ? 1.0 : 0.3),
      };

      if (request.maxTokens) {
        body.max_tokens = request.maxTokens;
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
        ...this.config.customHeaders,
      };

      const res = await fetchFn(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        const err: any = new Error(`OpenAI request failed with status ${res.status}: ${errorText}`);
        err.status = res.status;
        err.statusCode = res.status;
        throw err;
      }

      const data: any = await res.json();
      const choice = data.choices?.[0];
      const content = choice?.message?.content || (typeof data.content === 'string' ? data.content : '');
      const tokensUsed: LLMTokensUsed = {
        prompt: data.usage?.prompt_tokens || data.tokensUsed?.prompt || 0,
        completion: data.usage?.completion_tokens || data.tokensUsed?.completion || 0,
        total: data.usage?.total_tokens || data.tokensUsed?.total || 0,
        reasoning: data.usage?.completion_tokens_details?.reasoning_tokens || data.tokensUsed?.reasoning,
      };

      const costEstimateUSD = recordPostExecutionSpend(this.config, tokensUsed);

      return {
        content,
        providerUsed: 'openai',
        modelUsed: data.model || request.model || this.config.defaultModel,
        tokensUsed,
        reasoningTrace: choice?.message?.reasoning_content || data.reasoningTrace,
        rawResponse: data,
        billingTierUsed: this.config.billingTier,
        costEstimateUSD,
      };
    } finally {
      releasePreExecutionReservation(this.config, estimatedUSD);
    }
  }
}

/**
 * Concrete Provider: Anthropic Adapter
 */
export class AnthropicAdapter implements IProviderAdapter {
  public providerType: ProviderType = 'anthropic';
  constructor(public config: ProviderConfig) {}

  async execute(request: LLMRequest, fetchFn: typeof fetch): Promise<LLMResponse> {
    const estimatedUSD = 0.005;
    reservePreExecutionSpend(this.config, estimatedUSD);

    try {
      const url = `${this.config.baseUrl.replace(/\/+$/, '')}/v1/messages`;
      const systemPrompt = synthesizeSystemPrompt(request.persona, request.systemPrompt);

      const maxTokensMap: Record<EffortLevel, number> = {
        low: 512,
        medium: 2048,
        high: 4096,
        reasoning: 8192,
      };
      const maxTokens = request.maxTokens || maxTokensMap[request.effortLevel] || 2048;

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-api-key': this.config.apiKey || '',
        'anthropic-version': '2023-06-01',
        ...this.config.customHeaders,
      };

      const res = await fetchFn(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: request.model || this.config.defaultModel,
          system: systemPrompt,
          messages: [{ role: 'user', content: request.prompt }],
          max_tokens: maxTokens,
          temperature: request.temperature ?? 0.3,
        }),
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        const err: any = new Error(`Anthropic request failed with status ${res.status}: ${errorText}`);
        err.status = res.status;
        err.statusCode = res.status;
        throw err;
      }

      const data: any = await res.json();
      const content = data.content?.[0]?.text || (typeof data.content === 'string' ? data.content : '');
      const promptTokens = data.usage?.input_tokens || data.tokensUsed?.prompt || 0;
      const completionTokens = data.usage?.output_tokens || data.tokensUsed?.completion || 0;
      const tokensUsed: LLMTokensUsed = {
        prompt: promptTokens,
        completion: completionTokens,
        total: promptTokens + completionTokens,
      };

      const costEstimateUSD = recordPostExecutionSpend(this.config, tokensUsed);

      return {
        content,
        providerUsed: 'anthropic',
        modelUsed: data.model || request.model || this.config.defaultModel,
        tokensUsed,
        rawResponse: data,
        billingTierUsed: this.config.billingTier,
        costEstimateUSD,
      };
    } finally {
      releasePreExecutionReservation(this.config, estimatedUSD);
    }
  }
}

/**
 * Concrete Provider: Gemini Adapter
 */
export class GeminiAdapter implements IProviderAdapter {
  public providerType: ProviderType = 'gemini';
  constructor(public config: ProviderConfig) {}

  async execute(request: LLMRequest, fetchFn: typeof fetch): Promise<LLMResponse> {
    const estimatedUSD = 0.005;
    reservePreExecutionSpend(this.config, estimatedUSD);

    try {
      const model = request.model || this.config.defaultModel;
      const url = `${this.config.baseUrl.replace(/\/+$/, '')}/v1beta/models/${model}:generateContent`;
      const systemPrompt = synthesizeSystemPrompt(request.persona, request.systemPrompt);

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-goog-api-key': this.config.apiKey || '',
        ...this.config.customHeaders,
      };

      const res = await fetchFn(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ parts: [{ text: request.prompt }] }],
          generationConfig: {
            temperature: request.temperature ?? 0.3,
            maxOutputTokens: request.maxTokens,
          },
        }),
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        const err: any = new Error(`Gemini request failed with status ${res.status}: ${errorText}`);
        err.status = res.status;
        err.statusCode = res.status;
        throw err;
      }

      const data: any = await res.json();
      const content =
        data.candidates?.[0]?.content?.parts?.[0]?.text ||
        (typeof data.content === 'string' ? data.content : '');
      const promptTokens = data.usageMetadata?.promptTokenCount || data.tokensUsed?.prompt || 0;
      const completionTokens = data.usageMetadata?.candidatesTokenCount || data.tokensUsed?.completion || 0;
      const tokensUsed: LLMTokensUsed = {
        prompt: promptTokens,
        completion: completionTokens,
        total: promptTokens + completionTokens,
      };

      const costEstimateUSD = recordPostExecutionSpend(this.config, tokensUsed);

      return {
        content,
        providerUsed: 'gemini',
        modelUsed: model,
        tokensUsed,
        rawResponse: data,
        billingTierUsed: this.config.billingTier,
        costEstimateUSD,
      };
    } finally {
      releasePreExecutionReservation(this.config, estimatedUSD);
    }
  }
}

/**
 * Concrete Provider: DeepSeek Adapter
 */
export class DeepSeekAdapter implements IProviderAdapter {
  public providerType: ProviderType = 'deepseek';
  constructor(public config: ProviderConfig) {}

  async execute(request: LLMRequest, fetchFn: typeof fetch): Promise<LLMResponse> {
    const estimatedUSD = 0.005;
    reservePreExecutionSpend(this.config, estimatedUSD);

    try {
      const url = `${this.config.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`;
      const systemPrompt = synthesizeSystemPrompt(request.persona, request.systemPrompt);

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
        ...this.config.customHeaders,
      };

      const res = await fetchFn(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: request.model || this.config.defaultModel,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: request.prompt },
          ],
          temperature: request.temperature ?? 0.3,
          max_tokens: request.maxTokens,
        }),
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        const err: any = new Error(`DeepSeek request failed with status ${res.status}: ${errorText}`);
        err.status = res.status;
        err.statusCode = res.status;
        throw err;
      }

      const data: any = await res.json();
      const choice = data.choices?.[0];
      const content = choice?.message?.content || (typeof data.content === 'string' ? data.content : '');
      const reasoningTrace = choice?.message?.reasoning_content || data.reasoningTrace;

      const tokensUsed: LLMTokensUsed = {
        prompt: data.usage?.prompt_tokens || data.tokensUsed?.prompt || 0,
        completion: data.usage?.completion_tokens || data.tokensUsed?.completion || 0,
        total: data.usage?.total_tokens || data.tokensUsed?.total || 0,
      };

      const costEstimateUSD = recordPostExecutionSpend(this.config, tokensUsed);

      return {
        content,
        providerUsed: 'deepseek',
        modelUsed: data.model || request.model || this.config.defaultModel,
        tokensUsed,
        reasoningTrace,
        rawResponse: data,
        billingTierUsed: this.config.billingTier,
        costEstimateUSD,
      };
    } finally {
      releasePreExecutionReservation(this.config, estimatedUSD);
    }
  }
}

/**
 * OmniRouteAdapter: Multi-provider router interfacing across active provider subscriptions
 */
export class OmniRouteAdapter {
  private providers: Map<string, ProviderConfig> = new Map();
  private defaultProviderId?: string;
  private httpFetch: typeof fetch;

  constructor(options: OmniRouteAdapterOptions) {
    this.httpFetch = options.httpFetch || globalThis.fetch;
    for (const provider of options.providers) {
      if (provider.enabled !== false) {
        this.providers.set(provider.id, provider);
      }
    }
    this.defaultProviderId = options.defaultProviderId || options.providers[0]?.id;
  }

  public registerProvider(provider: ProviderConfig): void {
    if (provider.enabled !== false) {
      this.providers.set(provider.id, provider);
    }
  }

  public getProviders(): ProviderConfig[] {
    return Array.from(this.providers.values());
  }

  public async complete(request: LLMRequest): Promise<LLMResponse> {
    const providerConfig = this.resolveProviderConfig(request.provider);
    const adapter = this.createAdapter(providerConfig);
    return await adapter.execute(request, this.httpFetch);
  }

  private resolveProviderConfig(requestedProvider?: string): ProviderConfig {
    if (requestedProvider && this.providers.has(requestedProvider)) {
      return this.providers.get(requestedProvider)!;
    }
    if (requestedProvider) {
      for (const p of this.providers.values()) {
        if (p.providerType === requestedProvider) {
          return p;
        }
      }
    }
    if (this.defaultProviderId && this.providers.has(this.defaultProviderId)) {
      return this.providers.get(this.defaultProviderId)!;
    }
    const firstAvailable = Array.from(this.providers.values())[0];
    if (!firstAvailable) {
      throw new Error(`No enabled LLM provider configuration available.`);
    }
    return firstAvailable;
  }

  private createAdapter(config: ProviderConfig): IProviderAdapter {
    switch (config.providerType) {
      case 'anthropic':
        return new AnthropicAdapter(config);
      case 'gemini':
      case 'google':
        return new GeminiAdapter(config);
      case 'deepseek':
        return new DeepSeekAdapter(config);
      case 'openai':
        return new OpenAIAdapter(config);
      case 'openrouter':
      case 'openrouter/review':
        return new OpenRouterAdapter(config);
      case 'omniroute_gateway':
      default:
        return new OmniRouteGatewayAdapter(config);
    }
  }
}

/**
 * Concrete Provider: OpenRouter Adapter
 */
export class OpenRouterAdapter implements IProviderAdapter {
  public providerType: ProviderType = 'openrouter';
  constructor(public config: ProviderConfig) {}

  async execute(request: LLMRequest, fetchFn: typeof fetch): Promise<LLMResponse> {
    const estimatedUSD = 0.005;
    reservePreExecutionSpend(this.config, estimatedUSD);

    try {
      const url = `${this.config.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`;
      const systemPrompt = synthesizeSystemPrompt(request.persona, request.systemPrompt);

      // Use requested model directly or defaultModel configured for openrouter/review pool
      const targetModel = request.model || this.config.defaultModel;

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://calltelemetry.com',
        'X-Title': 'CallTelemetry Review Bot',
        ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
        ...this.config.customHeaders,
      };

      const res = await fetchFn(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: targetModel,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: request.prompt },
          ],
          temperature: request.effortLevel === 'low' ? 0.2 : 0.4,
          max_tokens: request.maxTokens || (request.effortLevel === 'low' ? 1024 : 4096),
        }),
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        const err: any = new Error(`OpenRouter request failed with status ${res.status}: ${errorText}`);
        err.status = res.status;
        err.statusCode = res.status;
        throw err;
      }

      const data: any = await res.json();
      const choice = data.choices?.[0];
      const content = choice?.message?.content || (typeof data.content === 'string' ? data.content : '');
      const reasoningTrace = choice?.message?.reasoning_content || data.reasoningTrace;

      const tokensUsed: LLMTokensUsed = {
        prompt: data.usage?.prompt_tokens || data.tokensUsed?.prompt || 0,
        completion: data.usage?.completion_tokens || data.tokensUsed?.completion || 0,
        total: data.usage?.total_tokens || data.tokensUsed?.total || 0,
      };

      const costEstimateUSD = recordPostExecutionSpend(this.config, tokensUsed);

      return {
        content,
        providerUsed: request.provider || this.config.id || 'openrouter',
        modelUsed: targetModel,
        tokensUsed,
        reasoningTrace,
        rawResponse: data,
        billingTierUsed: this.config.billingTier,
        costEstimateUSD,
      };
    } finally {
      releasePreExecutionReservation(this.config, estimatedUSD);
    }
  }
}


