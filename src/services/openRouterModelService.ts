import { logger } from '../utils/logger';

export type Modality = 'text' | 'image' | 'audio' | 'video';

export interface OpenRouterModelSpec {
  id: string;
  name: string;
  description?: string;
  contextLength: number;
  maxCompletionTokens?: number;
  promptCostPer1M: number;     // USD per 1,000,000 tokens
  completionCostPer1M: number; // USD per 1,000,000 tokens
  modalities: Modality[];
  isFallback: boolean;
  fetchedAt: number;
}

export interface RawOpenRouterModel {
  id: string;
  name: string;
  description?: string;
  context_length?: number;
  architecture?: {
    modality?: string;
    tokenizer?: string;
    instruct_type?: string | null;
  };
  pricing?: {
    prompt?: string | number;
    completion?: string | number;
    image?: string | number;
    request?: string | number;
  };
  top_provider?: {
    context_length?: number;
    max_completion_tokens?: number;
    is_moderated?: boolean;
  };
}

export interface RawOpenRouterModelsResponse {
  data: RawOpenRouterModel[];
}

export interface ServiceOptions {
  apiKey?: string;
  baseUrl?: string;
  cacheTTLMs?: number;
}

export function parsePriceToPer1M(rawPrice: string | number | undefined): number {
  if (rawPrice === undefined || rawPrice === null) return 0;
  const num = typeof rawPrice === 'number' ? rawPrice : parseFloat(String(rawPrice));
  if (!Number.isFinite(num) || num < 0) return 0;
  const per1M = num * 1_000_000;
  return Math.round(per1M * 1_000_000) / 1_000_000;
}

export function parseModalities(rawModality?: string): Modality[] {
  if (!rawModality || typeof rawModality !== 'string') return ['text'];
  const inputPart = rawModality.split('->')[0].toLowerCase();
  const modalities: Modality[] = [];
  if (inputPart.includes('text')) modalities.push('text');
  if (inputPart.includes('image')) modalities.push('image');
  if (inputPart.includes('audio')) modalities.push('audio');
  if (inputPart.includes('video')) modalities.push('video');
  return modalities.length > 0 ? modalities : ['text'];
}

export const FALLBACK_OPENROUTER_MODELS: OpenRouterModelSpec[] = [
  {
    id: 'openrouter/auto',
    name: 'OpenRouter Auto Router',
    description: 'Automatic model selection based on query complexity and cost',
    contextLength: 128000,
    maxCompletionTokens: 4096,
    promptCostPer1M: 1.00,
    completionCostPer1M: 3.00,
    modalities: ['text'],
    isFallback: true,
    fetchedAt: 0,
  },
  {
    id: 'openrouter/anthropic/claude-3.7-sonnet',
    name: 'Anthropic: Claude 3.7 Sonnet (OpenRouter)',
    description: 'Hybrid reasoning model with extended context and vision capabilities',
    contextLength: 200000,
    maxCompletionTokens: 8192,
    promptCostPer1M: 3.00,
    completionCostPer1M: 15.00,
    modalities: ['text', 'image'],
    isFallback: true,
    fetchedAt: 0,
  },
  {
    id: 'openrouter/deepseek/deepseek-r1',
    name: 'DeepSeek: R1 (OpenRouter)',
    description: 'Open-weights reasoning model with high performance on code and math',
    contextLength: 163840,
    maxCompletionTokens: 8192,
    promptCostPer1M: 0.55,
    completionCostPer1M: 2.19,
    modalities: ['text'],
    isFallback: true,
    fetchedAt: 0,
  },
  {
    id: 'openrouter/google/gemini-2.5-pro',
    name: 'Google: Gemini 2.5 Pro (OpenRouter)',
    description: 'Large multimodal model with 1M context window',
    contextLength: 1000000,
    maxCompletionTokens: 8192,
    promptCostPer1M: 1.25,
    completionCostPer1M: 5.00,
    modalities: ['text', 'image', 'audio', 'video'],
    isFallback: true,
    fetchedAt: 0,
  },
  {
    id: 'openrouter/qwen/qwen-2.5-72b-instruct',
    name: 'Qwen: Qwen 2.5 72B Instruct (OpenRouter)',
    description: 'High performance open-weights instruction model',
    contextLength: 131072,
    maxCompletionTokens: 4096,
    promptCostPer1M: 0.35,
    completionCostPer1M: 0.40,
    modalities: ['text'],
    isFallback: true,
    fetchedAt: 0,
  },
  {
    id: 'gpt-4o',
    name: 'OpenAI: GPT-4o',
    description: 'Flagship multimodal model from OpenAI',
    contextLength: 128000,
    maxCompletionTokens: 4096,
    promptCostPer1M: 2.50,
    completionCostPer1M: 10.00,
    modalities: ['text', 'image'],
    isFallback: true,
    fetchedAt: 0,
  },
  {
    id: 'openrouter/openai/gpt-4o',
    name: 'OpenAI: GPT-4o (OpenRouter)',
    description: 'Flagship multimodal model from OpenAI via OpenRouter',
    contextLength: 128000,
    maxCompletionTokens: 4096,
    promptCostPer1M: 2.50,
    completionCostPer1M: 10.00,
    modalities: ['text', 'image'],
    isFallback: true,
    fetchedAt: 0,
  },
  {
    id: 'gpt-4o-mini',
    name: 'OpenAI: GPT-4o Mini',
    description: 'Fast, affordable multimodal small model',
    contextLength: 128000,
    maxCompletionTokens: 4096,
    promptCostPer1M: 0.15,
    completionCostPer1M: 0.60,
    modalities: ['text', 'image'],
    isFallback: true,
    fetchedAt: 0,
  },
  {
    id: 'openrouter/openai/gpt-4o-mini',
    name: 'OpenAI: GPT-4o Mini (OpenRouter)',
    description: 'Fast, affordable multimodal small model via OpenRouter',
    contextLength: 128000,
    maxCompletionTokens: 4096,
    promptCostPer1M: 0.15,
    completionCostPer1M: 0.60,
    modalities: ['text', 'image'],
    isFallback: true,
    fetchedAt: 0,
  },
  {
    id: 'claude-3-5-sonnet',
    name: 'Anthropic: Claude 3.5 Sonnet',
    description: 'High intelligence model for coding and analysis',
    contextLength: 200000,
    maxCompletionTokens: 8192,
    promptCostPer1M: 3.00,
    completionCostPer1M: 15.00,
    modalities: ['text', 'image'],
    isFallback: true,
    fetchedAt: 0,
  },
  {
    id: 'openrouter/anthropic/claude-3.5-sonnet',
    name: 'Anthropic: Claude 3.5 Sonnet (OpenRouter)',
    description: 'High intelligence model for coding and analysis via OpenRouter',
    contextLength: 200000,
    maxCompletionTokens: 8192,
    promptCostPer1M: 3.00,
    completionCostPer1M: 15.00,
    modalities: ['text', 'image'],
    isFallback: true,
    fetchedAt: 0,
  },
  {
    id: 'deepseek-v3',
    name: 'DeepSeek: V3',
    description: '671B parameter Mixture-of-Experts language model',
    contextLength: 64000,
    maxCompletionTokens: 8192,
    promptCostPer1M: 0.14,
    completionCostPer1M: 0.28,
    modalities: ['text'],
    isFallback: true,
    fetchedAt: 0,
  },
  {
    id: 'openrouter/deepseek/deepseek-v3',
    name: 'DeepSeek: V3 (OpenRouter)',
    description: '671B parameter Mixture-of-Experts language model via OpenRouter',
    contextLength: 64000,
    maxCompletionTokens: 8192,
    promptCostPer1M: 0.14,
    completionCostPer1M: 0.28,
    modalities: ['text'],
    isFallback: true,
    fetchedAt: 0,
  },
];

export class OpenRouterModelService {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly cacheTTLMs: number;
  private cacheMap = new Map<string, OpenRouterModelSpec>();
  private lastFetchTime: number | null = null;
  private isUsingFallback = false;

  constructor(options?: ServiceOptions) {
    this.baseUrl = (options?.baseUrl || process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
    this.apiKey = options?.apiKey || process.env.OPENROUTER_API_KEY;
    this.cacheTTLMs = options?.cacheTTLMs ?? 3_600_000; // Default 1 hour
  }

  public async getModels(options?: { forceRefresh?: boolean }): Promise<OpenRouterModelSpec[]> {
    const now = Date.now();
    const isCacheValid = this.lastFetchTime !== null && (now - this.lastFetchTime) < this.cacheTTLMs && this.cacheMap.size > 0;

    if (!options?.forceRefresh && isCacheValid) {
      return Array.from(this.cacheMap.values());
    }

    try {
      const liveModels = await this.fetchLiveModels();
      this.cacheMap.clear();
      for (const m of liveModels) {
        this.cacheMap.set(m.id, m);
      }
      this.lastFetchTime = now;
      this.isUsingFallback = false;
      return liveModels;
    } catch (err: any) {
      logger.warn(`Failed to fetch OpenRouter live models; defaulting to offline fallback models. Error: ${err?.message || err}`);
      if (this.cacheMap.size === 0 || options?.forceRefresh) {
        this.populateFallbacks(now);
      }
      return Array.from(this.cacheMap.values());
    }
  }

  private async fetchLiveModels(): Promise<OpenRouterModelSpec[]> {
    const headers: Record<string, string> = { 'Accept': 'application/json' };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const response = await fetch(`${this.baseUrl}/models`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`OpenRouter HTTP ${response.status}: ${response.statusText}`);
    }

    const body = await response.json() as RawOpenRouterModelsResponse;
    if (!body || !Array.isArray(body.data)) {
      throw new Error('Invalid OpenRouter response format: data property is not an array');
    }

    const now = Date.now();
    return body.data.map((raw): OpenRouterModelSpec => ({
      id: raw.id,
      name: raw.name || raw.id,
      description: raw.description,
      contextLength: raw.context_length || raw.top_provider?.context_length || 4096,
      maxCompletionTokens: raw.top_provider?.max_completion_tokens,
      promptCostPer1M: parsePriceToPer1M(raw.pricing?.prompt),
      completionCostPer1M: parsePriceToPer1M(raw.pricing?.completion),
      modalities: parseModalities(raw.architecture?.modality),
      isFallback: false,
      fetchedAt: now,
    }));
  }

  private populateFallbacks(now: number): void {
    this.cacheMap.clear();
    for (const fb of FALLBACK_OPENROUTER_MODELS) {
      const spec = { ...fb, fetchedAt: now };
      this.cacheMap.set(spec.id, spec);
    }
    this.lastFetchTime = now;
    this.isUsingFallback = true;
  }

  public async getModel(modelId: string): Promise<OpenRouterModelSpec | null> {
    const models = await this.getModels();
    if (this.cacheMap.has(modelId)) {
      return this.cacheMap.get(modelId)!;
    }
    // Attempt matching without prefix or suffix
    for (const spec of models) {
      if (spec.id === modelId || spec.id.endsWith(`/${modelId}`) || modelId.endsWith(`/${spec.id}`)) {
        return spec;
      }
    }
    return null;
  }

  public async calculateCost(modelId: string, promptTokens: number, completionTokens: number): Promise<number> {
    const spec = await this.getModel(modelId);
    if (!spec) {
      // Standard baseline estimate if model unknown ($1.00 / $3.00 per 1M)
      const promptCost = (promptTokens / 1_000_000) * 1.00;
      const completionCost = (completionTokens / 1_000_000) * 3.00;
      return Math.round((promptCost + completionCost) * 1_000_000) / 1_000_000;
    }

    const promptCost = (promptTokens / 1_000_000) * spec.promptCostPer1M;
    const completionCost = (completionTokens / 1_000_000) * spec.completionCostPer1M;
    return Math.round((promptCost + completionCost) * 1_000_000) / 1_000_000;
  }

  public async isModalitySupported(modelId: string, modality: Modality): Promise<boolean> {
    const spec = await this.getModel(modelId);
    if (!spec) return modality === 'text';
    return spec.modalities.includes(modality);
  }

  public getFallbackModels(): OpenRouterModelSpec[] {
    return FALLBACK_OPENROUTER_MODELS.map((m) => ({ ...m, fetchedAt: Date.now() }));
  }

  public clearCache(): void {
    this.cacheMap.clear();
    this.lastFetchTime = null;
    this.isUsingFallback = false;
  }

  public getCacheStatus(): { cachedCount: number; lastFetchTime: number | null; isUsingFallback: boolean; ttlMs: number } {
    return {
      cachedCount: this.cacheMap.size,
      lastFetchTime: this.lastFetchTime,
      isUsingFallback: this.isUsingFallback,
      ttlMs: this.cacheTTLMs,
    };
  }
}

export const openRouterModelService = new OpenRouterModelService();
