# Architecture & Technical Design: `src/router/omniRouteAdapter.ts`

## 1. Executive Summary

`src/router/omniRouteAdapter.ts` serves as the core LLM abstraction layer for Milestone 2 of `ct-review-bot`. It standardizes requests (`LLMRequest`) and responses (`LLMResponse`) across multiple LLM providers (OpenAI, Anthropic, Google Gemini, DeepSeek, and OmniRoute Gateway proxy), supporting complex enterprise monetization models: API key flat subscriptions, usage-based pay-per-token billing, and extra-usage tier fallback subscriptions.

By utilizing native TypeScript interfaces and dependency-injected HTTP transport (`httpFetch`), `omniRouteAdapter.ts` operates without requiring external LLM SDKs (`openai`, `@anthropic-ai/sdk`), ensuring zero build-time bloat and 100% deterministic testability via mock HTTP adapters or `MockOmniRouteServer`.

---

## 2. Codebase Inspection & Context

### 2.1 Project Structure & Configuration
- **Root Directory**: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot`
- **Compiler Options (`tsconfig.json`)**:
  - Target: `ES2022`, Module: `CommonJS`, Module Resolution: `node`, Strict Mode: `true`.
  - Source Root: `./src`, Output Directory: `./dist`.
- **Dependencies (`package.json`)**:
  - Runtime: `@octokit/core` (^6.1.2), `express` (^4.19.2), `js-yaml` (^4.1.0), `zod` (^3.23.8).
  - Dev/Test: `vitest` (^1.6.0), `supertest` (^7.0.0), `ts-node` (^10.9.2), `typescript` (^5.4.5).
  - **Note**: No vendor LLM SDKs are installed. Standard Node 20 global `fetch` is used for HTTP networking.

### 2.2 Existing Gateway & Mock Infrastructure
1. `src/gateway/omniRouteClient.ts`:
   - Handles basic `/v1/chat/completions` REST API posting, OAuth 2.0 refresh token rotation (`/v1/oauth/token`), and simple 5xx provider failovers.
2. `tests/e2e/harness/mockOmniRouteServer.ts`:
   - Express mock server listening on dynamic/static ports.
   - Validates Bearer authorization tokens, simulates `token_expired` error codes, handles dynamic failure injection (`failProvider`), and generates standard persona/effort responses.

---

## 3. Exact Interface Specifications

The following TypeScript definitions govern `src/router/omniRouteAdapter.ts`:

```typescript
import { Persona, EffortLevel } from '../config/schema';

/**
 * Supported provider types across active LLM subscriptions.
 */
export type ProviderType =
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'deepseek'
  | 'omniroute_gateway'
  | string;

/**
 * Billing models supported per provider subscription.
 */
export type BillingTier = 'subscription_flat' | 'usage_based' | 'extra_usage_tier';

/**
 * Extra-usage tier configuration for overflow consumption.
 */
export interface ExtraUsageTierConfig {
  enabled: boolean;
  monthlyLimitUSD?: number;
  currentSpendUSD?: number;
  costPer1kPromptTokens: number;
  costPer1kCompletionTokens: number;
}

/**
 * Rate limiting & concurrency settings per provider subscription.
 */
export interface RateLimitConfig {
  requestsPerMinute?: number;
  tokensPerMinute?: number;
  concurrentRequests?: number;
}

/**
 * Full configuration contract for an individual provider endpoint.
 */
export interface ProviderConfig {
  id: string; // e.g. 'openai-primary', 'anthropic-extra-tier'
  providerType: ProviderType;
  displayName: string;
  baseUrl: string;
  apiKey?: string;
  oauthRefreshToken?: string;
  billingTier: BillingTier;
  extraUsageTier?: ExtraUsageTierConfig;
  defaultModel: string;
  supportedModels: string[];
  priority: number; // Priority rank (lower number = higher priority)
  enabled: boolean;
  rateLimit?: RateLimitConfig;
  customHeaders?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * Standardized input request payload for code review LLM invocations.
 */
export interface LLMRequest {
  prompt: string;
  systemPrompt?: string;
  persona: Persona; // 'security' | 'architecture' | 'performance' | 'quality'
  effortLevel: EffortLevel; // 'low' | 'medium' | 'high' | 'reasoning'
  temperature?: number;
  provider?: ProviderType;
  model?: string;
  maxTokens?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Token usage metrics breakdown.
 */
export interface LLMTokensUsed {
  prompt: number;
  completion: number;
  total: number;
}

/**
 * Standardized output response payload from code review LLM invocations.
 */
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

/**
 * Options for initializing the OmniRouteAdapter.
 */
export interface OmniRouteAdapterOptions {
  providers: ProviderConfig[];
  defaultProviderId?: string;
  httpFetch?: typeof fetch;
}

/**
 * Abstract interface for concrete provider adapters.
 */
export interface IProviderAdapter {
  providerType: ProviderType;
  config: ProviderConfig;
  execute(request: LLMRequest, fetchFn: typeof fetch): Promise<LLMResponse>;
}
```

---

## 4. Multi-Provider & Subscription Tier Design

### 4.1 Monetization & Billing Tier Handlers
1. **API Key Flat Subscriptions (`subscription_flat`)**:
   - Fixed monthly quota covered by organizational API keys.
   - Header authentication mappings:
     - OpenAI / DeepSeek / OmniRoute: `Authorization: Bearer <apiKey>`
     - Anthropic: `x-api-key: <apiKey>`, `anthropic-version: 2023-06-01`
     - Gemini: `x-goog-api-key: <apiKey>` or `?key=<apiKey>`
2. **Usage-Based Billing (`usage_based`)**:
   - Pay-as-you-go model.
   - Calculates estimated request cost:
     $$\text{Cost} = \left(\frac{\text{Prompt Tokens}}{1000} \times \text{Cost}_{1k\text{Prompt}}\right) + \left(\frac{\text{Completion Tokens}}{1000} \times \text{Cost}_{1k\text{Completion}}\right)$$
   - Attaches `costEstimateUSD` and `billingTierUsed: 'usage_based'` to `LLMResponse`.
3. **Extra-Usage Tier Subscriptions (`extra_usage_tier`)**:
   - Secondary subscription path engaged when primary flat subscription quota is exhausted or rate limited.
   - Enforces `monthlyLimitUSD` cap. If `currentSpendUSD >= monthlyLimitUSD`, the adapter throws a `QuotaExhaustedError` allowing the downstream `ProviderPool` to route to the next configured fallback provider.

---

## 5. Prompt & Metadata Mapping Architecture

### 5.1 Persona System Prompts
When `LLMRequest.systemPrompt` is omitted, the adapter injects the default persona system prompt:
- **`security`**: `"You are a Senior Security Engineer reviewing code for vulnerability risks, OWASP Top 10, memory safety, input validation, and auth flaws."`
- **`architecture`**: `"You are a Principal Software Architect reviewing code for design patterns, modularity, scalability, breaking API changes, and maintainability."`
- **`performance`**: `"You are a Performance Optimization Engineer reviewing code for time/space complexity, async bottlenecks, memory leaks, and unnecessary allocations."`
- **`quality`**: `"You are a Senior Code Quality Lead reviewing code for readability, test coverage, code style, error handling, and naming conventions."`

If a custom `systemPrompt` is provided, it is prepended to the persona baseline prompt.

### 5.2 Effort Level Parameters & Reasoning Extraction
`effortLevel` determines maximum output tokens, default model selection, temperature scaling, and reasoning trace extraction:

| Effort Level | Max Tokens | Default Model Class | Temp Multiplier | Reasoning Trace Extraction |
|---|---|---|---|---|
| `low` | 512 | `gpt-4o-mini`, `claude-3-5-haiku`, `gemini-1.5-flash` | 0.2 | Disabled |
| `medium` | 2048 | `gpt-4o`, `claude-3-5-sonnet`, `gemini-1.5-pro` | 0.3 | Disabled |
| `high` | 4096 | `gpt-4o`, `claude-3-5-sonnet`, `gemini-1.5-pro` | 0.4 | Disabled |
| `reasoning` | 8192 | `o1`, `o3-mini`, `claude-3-5-sonnet` (thinking), `deepseek-reasoner` | Omits temp | Parses `<thinking>...</thinking>` tags or `reasoning_content` field |

---

## 6. Adapter Implementation Blueprint (`src/router/omniRouteAdapter.ts`)

Below is the concrete code structure for `src/router/omniRouteAdapter.ts`:

```typescript
import {
  LLMRequest,
  LLMResponse,
  ProviderConfig,
  OmniRouteAdapterOptions,
  IProviderAdapter,
  ProviderType,
  LLMTokensUsed,
} from './omniRouteAdapterTypes';
import { Persona, EffortLevel } from '../config/schema';

export class OmniRouteAdapter {
  private providers: Map<string, ProviderConfig> = new Map();
  private defaultProviderId?: string;
  private httpFetch: typeof fetch;

  constructor(options: OmniRouteAdapterOptions) {
    this.httpFetch = options.httpFetch || globalThis.fetch;
    for (const provider of options.providers) {
      if (provider.enabled) {
        this.providers.set(provider.id, provider);
      }
    }
    this.defaultProviderId = options.defaultProviderId || options.providers[0]?.id;
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
    // Match by providerType if ID doesn't match directly
    for (const p of this.providers.values()) {
      if (p.providerType === requestedProvider) {
        return p;
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
        return new GeminiAdapter(config);
      case 'deepseek':
        return new DeepSeekAdapter(config);
      case 'openai':
        return new OpenAIAdapter(config);
      case 'omniroute_gateway':
      default:
        return new OmniRouteGatewayAdapter(config);
    }
  }
}

// System prompt synthesis helper
export function synthesizeSystemPrompt(persona: Persona, customSystemPrompt?: string): string {
  const basePrompts: Record<Persona, string> = {
    security: 'You are a Senior Security Engineer reviewing code for vulnerability risks, OWASP Top 10, memory safety, input validation, and auth flaws.',
    architecture: 'You are a Principal Software Architect reviewing code for design patterns, modularity, scalability, breaking API changes, and maintainability.',
    performance: 'You are a Performance Optimization Engineer reviewing code for time/space complexity, async bottlenecks, memory leaks, and unnecessary allocations.',
    quality: 'You are a Senior Code Quality Lead reviewing code for readability, test coverage, code style, error handling, and naming conventions.',
  };
  const personaPrompt = basePrompts[persona] || basePrompts.quality;
  return customSystemPrompt ? `${customSystemPrompt}\n\n${personaPrompt}` : personaPrompt;
}

// Token cost calculation helper
export function calculateTokenCost(
  tokens: LLMTokensUsed,
  promptCostPer1k: number,
  completionCostPer1k: number
): number {
  const promptCost = (tokens.prompt / 1000) * promptCostPer1k;
  const completionCost = (tokens.completion / 1000) * completionCostPer1k;
  return Number((promptCost + completionCost).toFixed(6));
}

/** Concrete Provider Implementation: OmniRoute Gateway Adapter */
export class OmniRouteGatewayAdapter implements IProviderAdapter {
  public providerType: ProviderType = 'omniroute_gateway';
  constructor(public config: ProviderConfig) {}

  async execute(request: LLMRequest, fetchFn: typeof fetch): Promise<LLMResponse> {
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
        provider: this.config.providerType,
        model: request.model || this.config.defaultModel,
        persona: request.persona,
        effortLevel: request.effortLevel,
        prompt: request.prompt,
        systemPrompt,
        temperature: request.temperature ?? 0.3,
      }),
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => '');
      throw new Error(`OmniRouteGateway failed with status ${res.status}: ${errorText}`);
    }

    const data: any = await res.json();
    const tokensUsed: LLMTokensUsed = data.tokensUsed || { prompt: 100, completion: 100, total: 200 };

    let costEstimateUSD: number | undefined;
    if (this.config.extraUsageTier?.enabled) {
      costEstimateUSD = calculateTokenCost(
        tokensUsed,
        this.config.extraUsageTier.costPer1kPromptTokens,
        this.config.extraUsageTier.costPer1kCompletionTokens
      );
    }

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
  }
}

/** Concrete Provider Implementation: OpenAI Adapter */
export class OpenAIAdapter implements IProviderAdapter {
  public providerType: ProviderType = 'openai';
  constructor(public config: ProviderConfig) {}

  async execute(request: LLMRequest, fetchFn: typeof fetch): Promise<LLMResponse> {
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

    const res = await fetchFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey || ''}`,
        ...this.config.customHeaders,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`OpenAI request failed with status ${res.status}`);
    }

    const data: any = await res.json();
    const choice = data.choices?.[0];
    const content = choice?.message?.content || '';
    const tokensUsed: LLMTokensUsed = {
      prompt: data.usage?.prompt_tokens || 0,
      completion: data.usage?.completion_tokens || 0,
      total: data.usage?.total_tokens || 0,
    };

    return {
      content,
      providerUsed: 'openai',
      modelUsed: data.model || this.config.defaultModel,
      tokensUsed,
      reasoningTrace: choice?.message?.reasoning_content,
      rawResponse: data,
      billingTierUsed: this.config.billingTier,
    };
  }
}

/** Concrete Provider Implementation: Anthropic Adapter */
export class AnthropicAdapter implements IProviderAdapter {
  public providerType: ProviderType = 'anthropic';
  constructor(public config: ProviderConfig) {}

  async execute(request: LLMRequest, fetchFn: typeof fetch): Promise<LLMResponse> {
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/v1/messages`;
    const systemPrompt = synthesizeSystemPrompt(request.persona, request.systemPrompt);

    const maxTokensMap: Record<EffortLevel, number> = { low: 512, medium: 2048, high: 4096, reasoning: 8192 };
    const maxTokens = request.maxTokens || maxTokensMap[request.effortLevel] || 2048;

    const res = await fetchFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.apiKey || '',
        'anthropic-version': '2023-06-01',
        ...this.config.customHeaders,
      },
      body: JSON.stringify({
        model: request.model || this.config.defaultModel,
        system: systemPrompt,
        messages: [{ role: 'user', content: request.prompt }],
        max_tokens: maxTokens,
        temperature: request.temperature ?? 0.3,
      }),
    });

    if (!res.ok) {
      throw new Error(`Anthropic request failed with status ${res.status}`);
    }

    const data: any = await res.json();
    const content = data.content?.[0]?.text || '';
    const tokensUsed: LLMTokensUsed = {
      prompt: data.usage?.input_tokens || 0,
      completion: data.usage?.output_tokens || 0,
      total: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
    };

    return {
      content,
      providerUsed: 'anthropic',
      modelUsed: data.model || this.config.defaultModel,
      tokensUsed,
      rawResponse: data,
      billingTierUsed: this.config.billingTier,
    };
  }
}

/** Concrete Provider Implementation: Gemini Adapter */
export class GeminiAdapter implements IProviderAdapter {
  public providerType: ProviderType = 'gemini';
  constructor(public config: ProviderConfig) {}

  async execute(request: LLMRequest, fetchFn: typeof fetch): Promise<LLMResponse> {
    const model = request.model || this.config.defaultModel;
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/v1beta/models/${model}:generateContent`;
    const systemPrompt = synthesizeSystemPrompt(request.persona, request.systemPrompt);

    const res = await fetchFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': this.config.apiKey || '',
        ...this.config.customHeaders,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts: [{ text: request.prompt }] }],
        generationConfig: {
          temperature: request.temperature ?? 0.3,
        },
      }),
    });

    if (!res.ok) {
      throw new Error(`Gemini request failed with status ${res.status}`);
    }

    const data: any = await res.json();
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const promptTokens = data.usageMetadata?.promptTokenCount || 0;
    const completionTokens = data.usageMetadata?.candidatesTokenCount || 0;

    return {
      content,
      providerUsed: 'gemini',
      modelUsed: model,
      tokensUsed: { prompt: promptTokens, completion: completionTokens, total: promptTokens + completionTokens },
      rawResponse: data,
      billingTierUsed: this.config.billingTier,
    };
  }
}

/** Concrete Provider Implementation: DeepSeek Adapter */
export class DeepSeekAdapter implements IProviderAdapter {
  public providerType: ProviderType = 'deepseek';
  constructor(public config: ProviderConfig) {}

  async execute(request: LLMRequest, fetchFn: typeof fetch): Promise<LLMResponse> {
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`;
    const systemPrompt = synthesizeSystemPrompt(request.persona, request.systemPrompt);

    const res = await fetchFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey || ''}`,
        ...this.config.customHeaders,
      },
      body: JSON.stringify({
        model: request.model || this.config.defaultModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: request.prompt },
        ],
        temperature: request.temperature ?? 0.3,
      }),
    });

    if (!res.ok) {
      throw new Error(`DeepSeek request failed with status ${res.status}`);
    }

    const data: any = await res.json();
    const choice = data.choices?.[0];
    const content = choice?.message?.content || '';
    const reasoningTrace = choice?.message?.reasoning_content;

    const tokensUsed: LLMTokensUsed = {
      prompt: data.usage?.prompt_tokens || 0,
      completion: data.usage?.completion_tokens || 0,
      total: data.usage?.total_tokens || 0,
    };

    return {
      content,
      providerUsed: 'deepseek',
      modelUsed: data.model || this.config.defaultModel,
      tokensUsed,
      reasoningTrace,
      rawResponse: data,
      billingTierUsed: this.config.billingTier,
    };
  }
}
```

---

## 7. Verification & Testing Strategy

To independently verify the implementation once written by the implementer agent:
1. **Unit Tests (`tests/unit/omniRouteAdapter.test.ts`)**:
   - Test default persona system prompt injection for all 4 personas (`security`, `architecture`, `performance`, `quality`).
   - Test custom system prompt prepending.
   - Test token cost calculation formulas for usage-based & extra-usage tiers.
   - Test HTTP header generation (`Authorization: Bearer`, `x-api-key`, `x-goog-api-key`).
   - Test HTTP response translation for OpenAI, Anthropic, Gemini, DeepSeek, and OmniRoute Gateway.
2. **Integration Verification (`npm test`)**:
   - Run `npm test` to ensure zero compilation errors and 100% test pass rate across existing unit/integration suites.
