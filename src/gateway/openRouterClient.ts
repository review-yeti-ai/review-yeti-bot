import { LiveStreamBus } from '../live/liveStreamBus';
import { logger } from '../utils/logger';

export class OpenRouterConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenRouterConnectionError';
  }
}

export class OpenRouterResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenRouterResponseError';
  }
}

export class OpenRouterTimeoutError extends OpenRouterConnectionError {
  constructor(message: string) {
    super(message);
    this.name = 'OpenRouterTimeoutError';
  }
}

export type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface OpenRouterMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OpenRouterRequest {
  model: string;
  messages: OpenRouterMessage[];
  timeoutMs: number;
  jobId?: string;
  persona?: string;
  providerId?: string;
  ttftTimeoutMs?: number;
  stream?: boolean;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export interface TokensUsed {
  prompt: number;
  completion: number;
  total: number;
}

export interface OpenRouterResponse {
  model: string;
  content: string;
  usage: TokensUsed | null;
  costUSD: number | null;
  raw: unknown;
}

export interface ReviewModelClient {
  complete(request: OpenRouterRequest): Promise<OpenRouterResponse>;
}

export interface OpenRouterClientOptions {
  baseUrl?: string;
  apiKey?: string;
  fetchImplementation?: FetchImplementation;
  /** @deprecated Use fetchImplementation. */
  fetchImpl?: FetchImplementation;
  now?: () => number;
}

/**
 * Convert legacy provider-router names into real OpenRouter model ids. This keeps existing
 * repository policies readable while ensuring the network request never targets OmniRoute.
 */
export function normalizeOpenRouterModel(model: string): string {
  const normalized = model.trim();
  const aliases: Record<string, string> = {
    'claude-opus-4-8': 'anthropic/claude-opus-4.8',
    'claude/claude-opus-4-8': 'anthropic/claude-opus-4.8',
    'agy/claude-opus-4-6-thinking': 'anthropic/claude-opus-4.8',
    'grok-cli/grok-4.5': 'x-ai/grok-4.5',
    'codex/gpt-5.6-sol-high': 'openai/gpt-5.6-sol',
    'codex-gateway/gpt-5.6-sol-high': 'openai/gpt-5.6-sol',
    'opencode-go/glm-5.2': 'z-ai/glm-5.2',
    'synthetic/glm-5.2': 'z-ai/glm-5.2',
    'synthetic-new/glm-5.2-high': 'z-ai/glm-5.2',
    'glm-5.2': 'z-ai/glm-5.2',
    'openrouter/5.6-luna-high': 'openai/gpt-5.6-luna',
    '5.6-luna-high': 'openai/gpt-5.6-luna',
  };
  if (aliases[normalized]) return aliases[normalized];
  if (normalized.startsWith('synthetic/')) return 'z-ai/glm-5.2';
  if (normalized.startsWith('openrouter/')) {
    const route = normalized.slice('openrouter/'.length);
    return route === 'auto' ? normalized : route;
  }
  return normalized;
}

export interface ModelMetadata {
  id: string;
  name: string;
  contextLength: number;
  contextTokens?: number;
  maxCompletionTokens?: number;
  promptCostPer1M: number;
  completionCostPer1M: number;
  promptCostPer1k?: number;
  completionCostPer1k?: number;
  supportsTools: boolean;
  supportsReasoning?: boolean;
}

export interface SafeDiffCapacityResult {
  contextTokens: number;
  usableDiffTokens: number;
  safeDiffChars: number;
  systemPromptTokens: number;
  toolReserveTokens: number;
  charsPerToken: number;
  valueOf(): number;
  [Symbol.toPrimitive](hint?: string): number | string;
  toString(): string;
}

export interface ResolveModelMetadataOptions {
  baseUrl?: string;
  fetchImplementation?: FetchImplementation;
  ttlMs?: number;
  timeoutMs?: number;
}

const metadataCache = new Map<string, { metadata: ModelMetadata; cachedAt: number }>();
let inFlightModelsFetch: Promise<Map<string, ModelMetadata>> | null = null;
const inFlightResolutions = new Map<string, Promise<ModelMetadata>>();

export function clearModelMetadataCache(): void {
  metadataCache.clear();
  inFlightModelsFetch = null;
  inFlightResolutions.clear();
}

export function getStaticModelMetadata(modelId: string): ModelMetadata {
  const normalized = normalizeOpenRouterModel(modelId || '');
  const lower = normalized.toLowerCase();

  const build = (meta: {
    id: string;
    name: string;
    contextLength: number;
    maxCompletionTokens?: number;
    promptCostPer1M: number;
    completionCostPer1M: number;
    supportsTools: boolean;
    supportsReasoning?: boolean;
  }): ModelMetadata => ({
    ...meta,
    contextTokens: meta.contextLength,
    promptCostPer1k: meta.promptCostPer1M / 1000,
    completionCostPer1k: meta.completionCostPer1M / 1000,
  });

  // 1. Google Gemini 2.5 Pro / 1.5 Pro (2M context = 2,097,152)
  if (
    lower.includes('gemini-2.5-pro') ||
    lower.includes('gemini-1.5-pro') ||
    lower.includes('gemini-pro')
  ) {
    return build({
      id: normalized,
      name: 'Google Gemini Pro',
      contextLength: 2_097_152,
      maxCompletionTokens: 65_536,
      promptCostPer1M: 1.25,
      completionCostPer1M: 5.0,
      supportsTools: true,
      supportsReasoning: true,
    });
  }

  // 2. Google Gemini 3.7 Flash / 2.5 Flash / 3.5 Flash Lite (1M context = 1,048,576)
  if (
    lower.includes('gemini-3.7-flash') ||
    lower.includes('gemini-2.5-flash') ||
    lower.includes('gemini-3.5-flash') ||
    lower.includes('gemini-flash')
  ) {
    return build({
      id: normalized,
      name: 'Google Gemini Flash',
      contextLength: 1_048_576,
      maxCompletionTokens: 65_536,
      promptCostPer1M: 0.15,
      completionCostPer1M: 0.6,
      supportsTools: true,
      supportsReasoning: true,
    });
  }

  // 3. Anthropic Claude 3.7 Sonnet / Opus 4.8 / 3.5 Sonnet / Haiku (200,000)
  if (
    lower.includes('claude') ||
    lower.includes('opus') ||
    lower.includes('sonnet') ||
    lower.includes('haiku')
  ) {
    const isHaiku = lower.includes('haiku');
    return build({
      id: normalized,
      name: isHaiku ? 'Anthropic Claude Haiku' : 'Anthropic Claude Sonnet / Opus',
      contextLength: 200_000,
      maxCompletionTokens: isHaiku ? 8_192 : 16_384,
      promptCostPer1M: isHaiku ? 0.8 : 3.0,
      completionCostPer1M: isHaiku ? 4.0 : 15.0,
      supportsTools: true,
      supportsReasoning: true,
    });
  }

  // 4. Kimi K2.6 / K3 (200,000)
  if (lower.includes('kimi')) {
    return build({
      id: normalized,
      name: 'Moonshot Kimi',
      contextLength: 200_000,
      maxCompletionTokens: 8_192,
      promptCostPer1M: 1.0,
      completionCostPer1M: 3.0,
      supportsTools: true,
      supportsReasoning: true,
    });
  }

  // 5. DeepSeek V4 Flash / V3 / R1 (128,000)
  if (lower.includes('deepseek')) {
    const isFlash = lower.includes('flash');
    return build({
      id: normalized,
      name: isFlash ? 'DeepSeek V4 Flash' : 'DeepSeek V3 / R1',
      contextLength: 128_000,
      maxCompletionTokens: 8_192,
      promptCostPer1M: isFlash ? 0.14 : 0.55,
      completionCostPer1M: isFlash ? 0.28 : 2.19,
      supportsTools: true,
      supportsReasoning: true,
    });
  }

  // 6. OpenRouter 5.6-Luna (128,000)
  if (lower.includes('luna')) {
    return build({
      id: normalized,
      name: 'OpenRouter 5.6 Luna',
      contextLength: 128_000,
      maxCompletionTokens: 16_384,
      promptCostPer1M: 2.0,
      completionCostPer1M: 6.0,
      supportsTools: true,
      supportsReasoning: true,
    });
  }

  // 7. Qwen 3.8 / 2.5 (128,000)
  if (lower.includes('qwen')) {
    return build({
      id: normalized,
      name: 'Qwen 3.8 / 2.5',
      contextLength: 128_000,
      maxCompletionTokens: 8_192,
      promptCostPer1M: 0.35,
      completionCostPer1M: 0.8,
      supportsTools: true,
      supportsReasoning: true,
    });
  }

  // 8. OpenAI GPT-4o / GPT-4o-mini / GPT-5.6-sol (128,000)
  if (lower.includes('gpt-4o') || lower.includes('gpt-5.6-sol') || lower.includes('codex')) {
    const isMini = lower.includes('mini');
    return build({
      id: normalized,
      name: isMini ? 'OpenAI GPT-4o Mini' : 'OpenAI GPT-4o',
      contextLength: 128_000,
      maxCompletionTokens: 16_384,
      promptCostPer1M: isMini ? 0.15 : 2.5,
      completionCostPer1M: isMini ? 0.6 : 10.0,
      supportsTools: true,
      supportsReasoning: lower.includes('gpt-5.6-sol'),
    });
  }

  // 9. GLM / Grok / HY3 / Fireworks DeepSeek
  if (lower.includes('glm') || lower.includes('grok') || lower.includes('hy3') || lower.includes('fireworks')) {
    return build({
      id: normalized,
      name: normalized,
      contextLength: 128_000,
      maxCompletionTokens: 8_192,
      promptCostPer1M: 1.0,
      completionCostPer1M: 2.0,
      supportsTools: true,
      supportsReasoning: false,
    });
  }

  // 10. Universal Default Fallback (128,000)
  return build({
    id: normalized || 'openrouter/auto',
    name: normalized || 'Universal Fallback',
    contextLength: 128_000,
    maxCompletionTokens: 8_192,
    promptCostPer1M: 0.5,
    completionCostPer1M: 1.5,
    supportsTools: true,
    supportsReasoning: false,
  });
}

export async function resolveModelMetadata(
  modelId: string,
  apiKey?: string,
  options?: ResolveModelMetadataOptions
): Promise<ModelMetadata> {
  const effectiveModel = normalizeOpenRouterModel(modelId || '');
  const ttlMs = options?.ttlMs ?? 60 * 60 * 1000; // 1 hour TTL
  const now = Date.now();

  const cached = metadataCache.get(effectiveModel) ?? metadataCache.get(modelId);
  if (cached && now - cached.cachedAt < ttlMs) {
    return cached.metadata;
  }

  const existingInFlight = inFlightResolutions.get(effectiveModel);
  if (existingInFlight) {
    return existingInFlight;
  }

  const resolutionPromise = (async () => {
    const key = apiKey || process.env.OPENROUTER_API_KEY || '';
    const baseUrl = (options?.baseUrl || process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
    const fetchImpl = options?.fetchImplementation || ((input, init) => globalThis.fetch(input, init));
    const timeoutMs = options?.timeoutMs ?? 5000;

    if (!key.trim()) {
      const staticMeta = getStaticModelMetadata(modelId);
      metadataCache.set(effectiveModel, { metadata: staticMeta, cachedAt: Date.now() });
      return staticMeta;
    }

    try {
      if (!inFlightModelsFetch) {
        inFlightModelsFetch = (async () => {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), timeoutMs);
          try {
            const headers: Record<string, string> = {
              Accept: 'application/json',
              Authorization: `Bearer ${key}`,
            };
            const response = await fetchImpl(`${baseUrl}/models`, {
              method: 'GET',
              headers,
              signal: controller.signal,
            });

            if (!response.ok) {
              return new Map<string, ModelMetadata>();
            }

            const body: any = await response.json();
            const modelsMap = new Map<string, ModelMetadata>();
            if (Array.isArray(body?.data)) {
              for (const item of body.data) {
                if (item?.id) {
                  const id = String(item.id);
                  const name = String(item.name || id);
                  const contextLength = Number(
                    item.context_length ||
                    item.top_provider?.context_length ||
                    item.per_request_limits?.prompt_tokens ||
                    128_000
                  );
                  const maxCompletionTokens = Number(
                    item.top_provider?.max_completion_tokens ||
                    item.per_request_limits?.completion_tokens ||
                    8192
                  );
                  const promptCostPer1M = item.pricing?.prompt
                    ? parseFloat(String(item.pricing.prompt)) * 1_000_000
                    : 0.5;
                  const completionCostPer1M = item.pricing?.completion
                    ? parseFloat(String(item.pricing.completion)) * 1_000_000
                    : 1.5;

                  const meta: ModelMetadata = {
                    id,
                    name,
                    contextLength,
                    contextTokens: contextLength,
                    maxCompletionTokens,
                    promptCostPer1M,
                    completionCostPer1M,
                    promptCostPer1k: promptCostPer1M / 1000,
                    completionCostPer1k: completionCostPer1M / 1000,
                    supportsTools: true,
                    supportsReasoning: Boolean(item.architecture?.instruct_type || item.supports_reasoning),
                  };
                  modelsMap.set(id.toLowerCase(), meta);
                }
              }
            }
            return modelsMap;
          } finally {
            clearTimeout(timeout);
          }
        })();
      }

      const modelsMap = await inFlightModelsFetch;
      const fetchTime = Date.now();
      for (const [idLower, meta] of modelsMap.entries()) {
        metadataCache.set(idLower, { metadata: meta, cachedAt: fetchTime });
        metadataCache.set(meta.id, { metadata: meta, cachedAt: fetchTime });
      }

      const baseId = effectiveModel.split(':')[0];
      const matchedMeta =
        modelsMap.get(effectiveModel.toLowerCase()) ||
        modelsMap.get(modelId.toLowerCase()) ||
        modelsMap.get(baseId.toLowerCase()) ||
        metadataCache.get(effectiveModel.toLowerCase())?.metadata;

      if (matchedMeta) {
        const resultMeta: ModelMetadata = {
          ...matchedMeta,
          id: effectiveModel,
        };
        metadataCache.set(effectiveModel, { metadata: resultMeta, cachedAt: fetchTime });
        return resultMeta;
      }

      const staticMeta = getStaticModelMetadata(modelId);
      metadataCache.set(effectiveModel, { metadata: staticMeta, cachedAt: fetchTime });
      return staticMeta;
    } catch (err) {
      logger.warn('Failed to resolve dynamic model metadata from OpenRouter, falling back to static metadata', {
        modelId,
        error: err instanceof Error ? err.message : String(err),
      });
      const staticMeta = getStaticModelMetadata(modelId);
      metadataCache.set(effectiveModel, { metadata: staticMeta, cachedAt: Date.now() });
      return staticMeta;
    } finally {
      inFlightModelsFetch = null;
      inFlightResolutions.delete(effectiveModel);
    }
  })();

  inFlightResolutions.set(effectiveModel, resolutionPromise);
  return resolutionPromise;
}

export function calculateSafeDiffCapacity(
  modelOrTokens: string | number,
  options?: { systemPromptTokens?: number; toolReserveTokens?: number; charsPerToken?: number }
): SafeDiffCapacityResult {
  const contextTokens = typeof modelOrTokens === 'number'
    ? modelOrTokens
    : getStaticModelMetadata(modelOrTokens).contextLength;
  const systemPromptTokens = options?.systemPromptTokens ?? 4000;
  const toolReserveTokens = options?.toolReserveTokens ?? 16000;
  const charsPerToken = options?.charsPerToken ?? 3.8;
  const usableDiffTokens = Math.max(0, contextTokens - systemPromptTokens - toolReserveTokens);
  const safeDiffChars = Math.floor(usableDiffTokens * charsPerToken);

  return {
    contextTokens,
    usableDiffTokens,
    safeDiffChars,
    systemPromptTokens,
    toolReserveTokens,
    charsPerToken,
    valueOf() {
      return this.safeDiffChars;
    },
    [Symbol.toPrimitive](_hint?: string) {
      return this.safeDiffChars;
    },
    toString() {
      return String(this.safeDiffChars);
    },
  };
}

function estimateTokenCost(model: string, promptTokens: number, completionTokens: number): number {
  const meta = getStaticModelMetadata(model);
  const promptRate = meta.promptCostPer1k ?? (meta.promptCostPer1M / 1000);
  const completionRate = meta.completionCostPer1k ?? (meta.completionCostPer1M / 1000);
  return Math.round(((promptTokens / 1000) * promptRate + (completionTokens / 1000) * completionRate) * 1_000_000) / 1_000_000;
}

interface StreamState {
  model: string;
  content: string;
  reasoning: string;
  usage: any;
  cost: number;
  lastChunkTime: number;
}

function collectChunk(data: any, state: StreamState): void {
  if (typeof data?.model === 'string' && data.model) state.model = data.model;
  const choice = data?.choices?.[0];
  const content = choice?.delta?.content ?? choice?.message?.content;
  if (typeof content === 'string') state.content += content;
  const reasoning = choice?.delta?.reasoning ?? choice?.delta?.reasoning_content;
  if (typeof reasoning === 'string') state.reasoning += reasoning;
  if (data?.usage) state.usage = data.usage;
  if (Number.isFinite(Number(data?.cost))) state.cost = Number(data.cost);
  if (Number.isFinite(Number(data?.cost_usd))) state.cost = Number(data.cost_usd);
  state.lastChunkTime = Date.now();
}

export { isExplicitUpstreamRejection, UpstreamCapacityRejectionError } from './providerCapacityManager';
import { isExplicitUpstreamRejection, UpstreamCapacityRejectionError } from './providerCapacityManager';

async function readWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeoutError: () => Error
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(onTimeoutError());
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readStreamingResponse(
  response: Response,
  requestedModel: string,
  options?: { inactivityTimeoutMs?: number; persona?: string; providerId?: string }
): Promise<any> {
  const reader = response.body?.getReader();
  if (!reader) return response.json();

  const decoder = new TextDecoder();
  let buffer = '';
  const state: StreamState = {
    model: requestedModel,
    content: '',
    reasoning: '',
    usage: null as any,
    cost: 0,
    lastChunkTime: Date.now(),
  };

  const inactivityTimeoutMs = options?.inactivityTimeoutMs ?? 45_000;
  const personaLabel = options?.persona ? `[Persona: ${options.persona}] ` : '';
  let lastHeartbeatLog = Date.now();

  const consume = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed === 'data: [DONE]') return;
    // SSE comment lines are keep-alives and are not JSON events.
    if (trimmed.startsWith(':')) {
      state.lastChunkTime = Date.now();
      return;
    }
    const json = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
    if (!json || json === '[DONE]') return;
    try {
      collectChunk(JSON.parse(json), state);
    } catch {
      throw new OpenRouterResponseError('OpenRouter returned malformed streaming JSON');
    }

    // Periodic heartbeat log in CI if active reasoning or streaming
    if (Date.now() - lastHeartbeatLog > 15_000) {
      lastHeartbeatLog = Date.now();
      const reasoningLen = state.reasoning.length;
      const contentLen = state.content.length;
      if (reasoningLen > 0 && contentLen === 0) {
        logger.info(`${personaLabel}Thinking in progress (${Math.round(reasoningLen / 4)} tokens generated)...`);
      }
    }
  };

  try {
    while (true) {
      const readPromise = reader.read();
      const { done, value } = await readWithTimeout(
        readPromise,
        inactivityTimeoutMs,
        () => new OpenRouterConnectionError(
          `Streaming stalled: no data or heartbeat received from provider for ${Math.round(inactivityTimeoutMs / 1000)}s`
        )
      );
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      lines.forEach(consume);
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer);
  } catch (error) {
    if (typeof reader.cancel === 'function') {
      await reader.cancel().catch(() => undefined);
    }
    throw error;
  }

  return {
    model: state.model,
    choices: [{ message: { role: 'assistant', content: state.content, reasoning: state.reasoning || undefined } }],
    usage: state.usage,
    cost: state.cost,
  };
}

/** OpenAI-compatible model boundary pinned to OpenRouter for review execution. */
export class OpenRouterClient implements ReviewModelClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImplementation: FetchImplementation;
  private readonly now: () => number;

  constructor(options: OpenRouterClientOptions = {}) {
    this.baseUrl = (options.baseUrl || process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
    this.apiKey = options.apiKey || process.env.OPENROUTER_API_KEY || '';
    this.fetchImplementation = options.fetchImplementation || options.fetchImpl || ((input, init) => globalThis.fetch(input, init));
    this.now = options.now || Date.now;
  }

  async complete(request: OpenRouterRequest): Promise<OpenRouterResponse> {
    if (!this.apiKey.trim()) {
      throw new OpenRouterConnectionError('OPENROUTER_API_KEY is required; review execution has no offline model fallback');
    }
    if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) {
      throw new TypeError(`OpenRouter request requires a positive timeoutMs; received ${String(request.timeoutMs)}`);
    }

    const effectiveModel = normalizeOpenRouterModel(request.model);
    const started = this.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
    const headers = new Headers({
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    });

    try {
      const response = await this.fetchImplementation(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: effectiveModel,
          messages: request.messages,
          stream: request.stream ?? true,
          ...(request.reasoningEffort ? { reasoning_effort: request.reasoningEffort } : {}),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new OpenRouterResponseError(`OpenRouter HTTP ${response.status}: ${text.slice(0, 2_000)}`);
      }

      const data = await readStreamingResponse(response, effectiveModel, {
        persona: request.persona,
        providerId: request.providerId,
        ttftTimeoutMs: request.ttftTimeoutMs,
        inactivityTimeoutMs: Math.min(45_000, request.timeoutMs),
      });
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.trim() === '') {
        throw new OpenRouterResponseError('OpenRouter returned empty completion content');
      }

      const rawUsage = data.usage;
      const usage = rawUsage && [rawUsage.prompt_tokens, rawUsage.completion_tokens, rawUsage.total_tokens].every(Number.isFinite)
        ? {
            prompt: Number(rawUsage.prompt_tokens),
            completion: Number(rawUsage.completion_tokens),
            total: Number(rawUsage.total_tokens),
          }
        : null;
      const rawCost = Number(data.cost ?? data.cost_usd ?? rawUsage?.cost);
      const costUSD = Number.isFinite(rawCost) && rawCost > 0
        ? rawCost
        : usage ? estimateTokenCost(effectiveModel, usage.prompt, usage.completion) : null;
      const model = String(data.model || effectiveModel);

      if (request.jobId) {
        LiveStreamBus.getInstance().publishEvent({
          jobId: request.jobId,
          timestamp: new Date(this.now()).toISOString(),
          type: 'openrouter:metric',
          persona: request.persona || 'openrouter',
          data: {
            requestedModel: effectiveModel,
            resolvedModel: model,
            provider: 'openrouter',
            latencyMs: this.now() - started,
            promptTokens: usage?.prompt || 0,
            completionTokens: usage?.completion || 0,
            totalTokens: usage?.total || 0,
            costUSD,
          },
        });
      }

      return { model, content, usage, costUSD, raw: data };
    } catch (error: any) {
      if (error instanceof OpenRouterResponseError || error instanceof OpenRouterConnectionError || error instanceof ProviderQueueStallError) throw error;
      if (error?.name === 'AbortError' || controller.signal.aborted) {
        throw new OpenRouterTimeoutError(`OpenRouter request for model ${request.model} exceeded ${request.timeoutMs}ms`);
      }
      logger.error('OpenRouter network failure or timeout', { error: error?.message || String(error), model: request.model });
      throw new OpenRouterConnectionError(`OpenRouter connection failure for model ${request.model}: ${error?.message || String(error)}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}
