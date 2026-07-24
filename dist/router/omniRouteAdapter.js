"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OmniRouteAdapter = exports.DeepSeekAdapter = exports.GeminiAdapter = exports.AnthropicAdapter = exports.OpenAIAdapter = exports.OmniRouteGatewayAdapter = exports.QuotaExhaustedError = void 0;
exports.synthesizeSystemPrompt = synthesizeSystemPrompt;
exports.calculateTokenCost = calculateTokenCost;
exports.checkPreExecutionQuota = checkPreExecutionQuota;
exports.reservePreExecutionSpend = reservePreExecutionSpend;
exports.releasePreExecutionReservation = releasePreExecutionReservation;
exports.recordPostExecutionSpend = recordPostExecutionSpend;
const logger_1 = require("../utils/logger");
class QuotaExhaustedError extends Error {
    providerId;
    constructor(message, providerId) {
        super(message);
        this.providerId = providerId;
        this.name = 'QuotaExhaustedError';
    }
}
exports.QuotaExhaustedError = QuotaExhaustedError;
function synthesizeSystemPrompt(persona, customSystemPrompt) {
    const basePrompts = {
        security: 'You are a Senior Security Engineer reviewing code for vulnerability risks, OWASP Top 10, memory safety, input validation, and auth flaws.',
        architecture: 'You are a Principal Software Architect reviewing code for design patterns, modularity, scalability, breaking API changes, and maintainability.',
        performance: 'You are a Performance Optimization Engineer reviewing code for time/space complexity, async bottlenecks, memory leaks, and unnecessary allocations.',
        quality: 'You are a Senior Code Quality Lead reviewing code for readability, test coverage, code style, error handling, and naming conventions.',
    };
    const personaPrompt = basePrompts[persona] || basePrompts.quality;
    return customSystemPrompt ? `${customSystemPrompt}\n\n${personaPrompt}` : personaPrompt;
}
function calculateTokenCost(tokens, promptCostPer1k, completionCostPer1k) {
    const promptCost = (tokens.prompt / 1000) * promptCostPer1k;
    const completionCost = (tokens.completion / 1000) * completionCostPer1k;
    return Number((promptCost + completionCost).toFixed(6));
}
function checkPreExecutionQuota(config) {
    if (config.extraUsageTier?.enabled &&
        config.extraUsageTier.monthlyLimitUSD !== undefined) {
        const current = config.extraUsageTier.currentSpendUSD || 0;
        const reserved = config.extraUsageTier.reservedSpendUSD || 0;
        if (current + reserved >= config.extraUsageTier.monthlyLimitUSD) {
            throw new QuotaExhaustedError(`Extra usage monthly spend limit ($${config.extraUsageTier.monthlyLimitUSD}) already reached or reserved for provider: ${config.id}`, config.id);
        }
    }
}
function reservePreExecutionSpend(config, estimatedUSD = 0.005) {
    checkPreExecutionQuota(config);
    if (config.extraUsageTier?.enabled) {
        config.extraUsageTier.reservedSpendUSD = Number(((config.extraUsageTier.reservedSpendUSD || 0) + estimatedUSD).toFixed(6));
    }
}
function releasePreExecutionReservation(config, estimatedUSD = 0.005) {
    if (config.extraUsageTier?.enabled && config.extraUsageTier.reservedSpendUSD) {
        config.extraUsageTier.reservedSpendUSD = Math.max(0, Number((config.extraUsageTier.reservedSpendUSD - estimatedUSD).toFixed(6)));
    }
}
function recordPostExecutionSpend(config, tokensUsed) {
    if (config.billingTier === 'usage_based' ||
        (config.billingTier === 'extra_usage_tier' && config.extraUsageTier?.enabled)) {
        const promptCost = config.extraUsageTier?.costPer1kPromptTokens ?? 0.0015;
        const completionCost = config.extraUsageTier?.costPer1kCompletionTokens ?? 0.002;
        const costEstimateUSD = calculateTokenCost(tokensUsed, promptCost, completionCost);
        if (config.extraUsageTier?.enabled) {
            const current = config.extraUsageTier.currentSpendUSD || 0;
            const newSpend = Number((current + costEstimateUSD).toFixed(6));
            config.extraUsageTier.currentSpendUSD = newSpend;
            if (config.extraUsageTier.monthlyLimitUSD !== undefined &&
                newSpend >= config.extraUsageTier.monthlyLimitUSD) {
                logger_1.logger.warn(`Extra usage monthly spend limit ($${config.extraUsageTier.monthlyLimitUSD}) reached/exceeded for ${config.id} (current spend: $${newSpend})`);
            }
        }
        return costEstimateUSD;
    }
    return undefined;
}
/**
 * Concrete Provider: OmniRoute Gateway Adapter
 */
class OmniRouteGatewayAdapter {
    config;
    providerType = 'omniroute_gateway';
    constructor(config) {
        this.config = config;
    }
    async execute(request, fetchFn) {
        const estimatedUSD = 0.005;
        reservePreExecutionSpend(this.config, estimatedUSD);
        try {
            const url = `${this.config.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`;
            const systemPrompt = synthesizeSystemPrompt(request.persona, request.systemPrompt);
            const headers = {
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
                const err = new Error(`OmniRouteGateway failed with status ${res.status}: ${errorText}`);
                err.status = res.status;
                err.statusCode = res.status;
                throw err;
            }
            const data = await res.json();
            const tokensUsed = data.tokensUsed || {
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
        }
        finally {
            releasePreExecutionReservation(this.config, estimatedUSD);
        }
    }
}
exports.OmniRouteGatewayAdapter = OmniRouteGatewayAdapter;
/**
 * Concrete Provider: OpenAI Adapter
 */
class OpenAIAdapter {
    config;
    providerType = 'openai';
    constructor(config) {
        this.config = config;
    }
    async execute(request, fetchFn) {
        const estimatedUSD = 0.005;
        reservePreExecutionSpend(this.config, estimatedUSD);
        try {
            const url = `${this.config.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`;
            const systemPrompt = synthesizeSystemPrompt(request.persona, request.systemPrompt);
            const body = {
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
            const headers = {
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
                const err = new Error(`OpenAI request failed with status ${res.status}: ${errorText}`);
                err.status = res.status;
                err.statusCode = res.status;
                throw err;
            }
            const data = await res.json();
            const choice = data.choices?.[0];
            const content = choice?.message?.content || (typeof data.content === 'string' ? data.content : '');
            const tokensUsed = {
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
        }
        finally {
            releasePreExecutionReservation(this.config, estimatedUSD);
        }
    }
}
exports.OpenAIAdapter = OpenAIAdapter;
/**
 * Concrete Provider: Anthropic Adapter
 */
class AnthropicAdapter {
    config;
    providerType = 'anthropic';
    constructor(config) {
        this.config = config;
    }
    async execute(request, fetchFn) {
        const estimatedUSD = 0.005;
        reservePreExecutionSpend(this.config, estimatedUSD);
        try {
            const url = `${this.config.baseUrl.replace(/\/+$/, '')}/v1/messages`;
            const systemPrompt = synthesizeSystemPrompt(request.persona, request.systemPrompt);
            const maxTokensMap = {
                low: 512,
                medium: 2048,
                high: 4096,
                reasoning: 8192,
            };
            const maxTokens = request.maxTokens || maxTokensMap[request.effortLevel] || 2048;
            const headers = {
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
                const err = new Error(`Anthropic request failed with status ${res.status}: ${errorText}`);
                err.status = res.status;
                err.statusCode = res.status;
                throw err;
            }
            const data = await res.json();
            const content = data.content?.[0]?.text || (typeof data.content === 'string' ? data.content : '');
            const promptTokens = data.usage?.input_tokens || data.tokensUsed?.prompt || 0;
            const completionTokens = data.usage?.output_tokens || data.tokensUsed?.completion || 0;
            const tokensUsed = {
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
        }
        finally {
            releasePreExecutionReservation(this.config, estimatedUSD);
        }
    }
}
exports.AnthropicAdapter = AnthropicAdapter;
/**
 * Concrete Provider: Gemini Adapter
 */
class GeminiAdapter {
    config;
    providerType = 'gemini';
    constructor(config) {
        this.config = config;
    }
    async execute(request, fetchFn) {
        const estimatedUSD = 0.005;
        reservePreExecutionSpend(this.config, estimatedUSD);
        try {
            const model = request.model || this.config.defaultModel;
            const url = `${this.config.baseUrl.replace(/\/+$/, '')}/v1beta/models/${model}:generateContent`;
            const systemPrompt = synthesizeSystemPrompt(request.persona, request.systemPrompt);
            const headers = {
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
                const err = new Error(`Gemini request failed with status ${res.status}: ${errorText}`);
                err.status = res.status;
                err.statusCode = res.status;
                throw err;
            }
            const data = await res.json();
            const content = data.candidates?.[0]?.content?.parts?.[0]?.text ||
                (typeof data.content === 'string' ? data.content : '');
            const promptTokens = data.usageMetadata?.promptTokenCount || data.tokensUsed?.prompt || 0;
            const completionTokens = data.usageMetadata?.candidatesTokenCount || data.tokensUsed?.completion || 0;
            const tokensUsed = {
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
        }
        finally {
            releasePreExecutionReservation(this.config, estimatedUSD);
        }
    }
}
exports.GeminiAdapter = GeminiAdapter;
/**
 * Concrete Provider: DeepSeek Adapter
 */
class DeepSeekAdapter {
    config;
    providerType = 'deepseek';
    constructor(config) {
        this.config = config;
    }
    async execute(request, fetchFn) {
        const estimatedUSD = 0.005;
        reservePreExecutionSpend(this.config, estimatedUSD);
        try {
            const url = `${this.config.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`;
            const systemPrompt = synthesizeSystemPrompt(request.persona, request.systemPrompt);
            const headers = {
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
                const err = new Error(`DeepSeek request failed with status ${res.status}: ${errorText}`);
                err.status = res.status;
                err.statusCode = res.status;
                throw err;
            }
            const data = await res.json();
            const choice = data.choices?.[0];
            const content = choice?.message?.content || (typeof data.content === 'string' ? data.content : '');
            const reasoningTrace = choice?.message?.reasoning_content || data.reasoningTrace;
            const tokensUsed = {
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
        }
        finally {
            releasePreExecutionReservation(this.config, estimatedUSD);
        }
    }
}
exports.DeepSeekAdapter = DeepSeekAdapter;
/**
 * OmniRouteAdapter: Multi-provider router interfacing across active provider subscriptions
 */
class OmniRouteAdapter {
    providers = new Map();
    defaultProviderId;
    httpFetch;
    constructor(options) {
        this.httpFetch = options.httpFetch || globalThis.fetch;
        for (const provider of options.providers) {
            if (provider.enabled !== false) {
                this.providers.set(provider.id, provider);
            }
        }
        this.defaultProviderId = options.defaultProviderId || options.providers[0]?.id;
    }
    registerProvider(provider) {
        if (provider.enabled !== false) {
            this.providers.set(provider.id, provider);
        }
    }
    getProviders() {
        return Array.from(this.providers.values());
    }
    async complete(request) {
        const providerConfig = this.resolveProviderConfig(request.provider);
        const adapter = this.createAdapter(providerConfig);
        return await adapter.execute(request, this.httpFetch);
    }
    resolveProviderConfig(requestedProvider) {
        if (requestedProvider && this.providers.has(requestedProvider)) {
            return this.providers.get(requestedProvider);
        }
        if (requestedProvider) {
            for (const p of this.providers.values()) {
                if (p.providerType === requestedProvider) {
                    return p;
                }
            }
        }
        if (this.defaultProviderId && this.providers.has(this.defaultProviderId)) {
            return this.providers.get(this.defaultProviderId);
        }
        const firstAvailable = Array.from(this.providers.values())[0];
        if (!firstAvailable) {
            throw new Error(`No enabled LLM provider configuration available.`);
        }
        return firstAvailable;
    }
    createAdapter(config) {
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
            case 'omniroute_gateway':
            default:
                return new OmniRouteGatewayAdapter(config);
        }
    }
}
exports.OmniRouteAdapter = OmniRouteAdapter;
//# sourceMappingURL=omniRouteAdapter.js.map