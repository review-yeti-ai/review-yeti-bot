import { LiveStreamBus } from '../live/liveStreamBus';
import { logger } from '../utils/logger';
import { redactWorkerFailureLogTail } from '../utils/workerFailureLogRedaction';
import { raceWithAbort as sharedRaceWithAbort } from './raceWithAbort';

export class OpenRouterConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenRouterConnectionError';
  }
}

export class OpenRouterResponseError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'OpenRouterResponseError';
    this.status = Number.isInteger(status) ? status : undefined;
  }
}

export type OpenRouterTimeoutKind = 'request' | 'ttft' | 'inactivity' | 'total';

export class OpenRouterTimeoutError extends OpenRouterConnectionError {
  readonly kind: OpenRouterTimeoutKind;

  constructor(message: string, kind: OpenRouterTimeoutKind = 'request') {
    super(message);
    this.name = 'OpenRouterTimeoutError';
    this.kind = kind;
  }
}

function timeoutErrorForSignal(signal: AbortSignal): OpenRouterTimeoutError {
  const reason = signal.reason;
  return reason instanceof OpenRouterTimeoutError
    ? reason
    : new OpenRouterTimeoutError('OpenRouter request was cancelled', 'request');
}

export type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type OpenRouterContentBlock =
  | {
      type: 'text';
      text: string;
      cache_control?: { type: 'ephemeral' };
      [key: string]: unknown;
    }
  | {
      type: string;
      [key: string]: unknown;
    };

export interface OpenRouterMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | OpenRouterContentBlock[];
}

export interface OpenRouterRequest {
  model: string;
  /** Ordered OpenRouter model fallbacks after the primary `model`. */
  models?: string[];
  messages: OpenRouterMessage[];
  /** Maximum time without a streamed data chunk after the first token. */
  inactivityTimeoutMs?: number;
  timeoutMs: number;
  jobId?: string;
  persona?: string;
  providerId?: string;
  ttftTimeoutMs?: number;
  stream?: boolean;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  reasoning?: Record<string, unknown>;
  maxTokens?: number;
  /**
   * Flatten `OpenRouterContentBlock[]` message content to a plain string before sending.
   * Opt-in per request: only a transport that cannot parse the block array should set it, because
   * flattening drops the `cache_control` prefix breakpoint. See `flattenMessageContent`.
   */
  flattenContentBlocks?: boolean;
  temperature?: number;
  responseFormat?: Record<string, unknown>;
  provider?: Record<string, unknown>;
  plugins?: Array<Record<string, unknown>>;
  metadata?: Record<string, string>;
  onFirstToken?: () => void;
  /** Caller-owned cancellation for the whole request, including streamed bodies. */
  signal?: AbortSignal;
  maxRetries?: number;
  initialRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface TokensUsed {
  prompt: number;
  completion: number;
  total: number;
  cached?: number;
  cached_tokens?: number;
  cache_read_input_tokens?: number;
  prompt_cache_hit_tokens?: number;
}

/**
 * Canonical helper to resolve the cached token count from any usage structure.
 * Standardizes precedence: cached -> cached_tokens -> prompt_cache_hit_tokens -> cache_read_input_tokens.
 */
export function resolveCachedTokens(usage: TokensUsed | Record<string, unknown> | null | undefined): number {
  if (!usage) return 0;
  const raw = usage as Record<string, unknown>;
  const val = raw.cached ??
    raw.cached_tokens ??
    raw.cachedTokens ??
    raw.prompt_cache_hit_tokens ??
    raw.promptCacheHitTokens ??
    raw.cache_read_input_tokens ??
    raw.cacheReadInputTokens ??
    raw.cacheReadTokens ??
    (raw.prompt_tokens_details as any)?.cached_tokens ??
    (raw.prompt_tokens_details as any)?.cachedTokens ??
    (raw.promptTokensDetails as any)?.cachedTokens ??
    (raw.promptTokensDetails as any)?.cached_tokens ??
    0;
  const num = typeof val === 'number' ? val : Number(val);
  return Number.isFinite(num) && num > 0 ? num : 0;
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
  maxRetries?: number;
  initialRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/**
 * Reject promptly when a caller cancels even if a test double or a compatible
 * transport fails to observe AbortSignal. The underlying request is still
 * given the signal by OpenRouterClient, so real fetch/SDK requests are aborted
 * rather than merely detached from the caller.
 *
 * Delegates to the shared implementation in raceWithAbort.ts (also used by
 * JevClient) so the two do not maintain diverging private copies; this wrapper
 * exists only to pin OpenRouterTimeoutError as the cancellation error and keep
 * every call site in this file unchanged.
 */
function raceWithAbort<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
  onLateValue?: (value: T) => void,
): Promise<T> {
  return sharedRaceWithAbort(
    operation,
    signal,
    () => new OpenRouterTimeoutError('OpenRouter request was cancelled', 'request'),
    onLateValue,
  );
}

/**
 * Build the single OpenRouter chat-completions request shape used by the typed client.
 * Optional fields are omitted rather than sent as `undefined`, which keeps request fingerprints
 * stable across smoke, replay, and live qualification callers.
 */
/**
 * Collapse `OpenRouterContentBlock[]` message content into a plain string.
 *
 * Not every OpenAI-compatible gateway accepts the array form. opencode rejects it outright:
 * `Input should be a valid string, field: 'messages[1].content.str'`. The panel uses the array
 * form because it carries the `cache_control` prefix breakpoint, so a transport that cannot read
 * it needs the content flattened rather than every caller rebuilding its prompts.
 *
 * LOSSY in exactly one direction, deliberately: `cache_control` markers are dropped, because a
 * gateway that cannot parse the block array cannot honour the breakpoint either. Text blocks are
 * joined with a blank line, matching how a block-capable provider renders consecutive text
 * blocks. A non-text block is replaced by an explicit marker naming its type, so a silently
 * vanished image can never be mistaken for one that was never sent.
 *
 * Returns the SAME array by reference when nothing needs flattening, so a transport that accepts
 * blocks is byte-identical to not calling this at all.
 */
export function flattenMessageContent(messages: OpenRouterMessage[]): OpenRouterMessage[] {
  let changed = false;
  const out = messages.map((message) => {
    if (typeof message.content === 'string' || !Array.isArray(message.content)) return message;
    changed = true;
    const parts: string[] = [];
    for (const block of message.content as any[]) {
      if (typeof block === 'string') { parts.push(block); continue; }
      if (block && block.type === 'text' && typeof block.text === 'string') { parts.push(block.text); continue; }
      parts.push(`[unsupported content block omitted: ${String(block?.type ?? 'unknown')}]`);
    }
    return { ...message, content: parts.join('\n\n') };
  });
  return changed ? out : messages;
}

export function buildOpenRouterChatRequest(request: OpenRouterRequest): Record<string, unknown> {
  const stream = request.stream ?? true;
  return {
    model: normalizeOpenRouterModel(request.model),
    ...(request.models !== undefined ? { models: request.models.map(normalizeOpenRouterModel) } : {}),
    messages: request.flattenContentBlocks ? flattenMessageContent(request.messages) : request.messages,
    stream,
    // REL-1105: OpenAI-spec gateways (the LiteLLM optimizer in front of Bifrost) put `usage` on a
    // streamed completion only when the client asks for it. Without this every review reports 0
    // tokens. Never sent on non-streaming requests, where OpenAI rejects it.
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.reasoning ? { reasoning: request.reasoning } : {}),
    ...(request.reasoningEffort ? { reasoning_effort: request.reasoningEffort } : {}),
    ...(request.responseFormat ? { response_format: request.responseFormat } : {}),
    ...(request.provider ? { provider: request.provider } : {}),
    ...(request.plugins ? { plugins: request.plugins } : {}),
    ...(request.metadata ? { metadata: request.metadata } : {}),
  };
}

type OpenRouterSdkClient = {
  chat: {
    send(request: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
  };
  getRawUsage?: () => any;
  getRawJson?: () => Promise<any>;
  /** A one-shot buffered response used only for explicitly supported compatible envelopes. */
  getRawResponse?: () => Promise<Response | null>;
};

type OpenRouterSdkModule = {
  OpenRouter: new (options?: Record<string, unknown>) => OpenRouterSdkClient;
  HTTPClient: new (options?: Record<string, unknown>) => {
    addHook(type: string, hook: (...args: any[]) => void | Promise<void>): unknown;
  };
};

let openRouterSdkModulePromise: Promise<OpenRouterSdkModule> | null = null;

/**
 * The application is emitted as CommonJS, while @openrouter/sdk publishes ESM. Node 24+'s
 * synchronous ESM bridge can load this dependency without lowering the application to ESM, which
 * keeps the existing action artifact/module contract intact.
 */
function loadOpenRouterSdk(): Promise<OpenRouterSdkModule> {
  if (!openRouterSdkModulePromise) {
    openRouterSdkModulePromise = Promise.resolve(require('@openrouter/sdk') as OpenRouterSdkModule);
  }
  return openRouterSdkModulePromise;
}

function mapSdkKeys(value: unknown, keys: Record<string, string>): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const mapped: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    mapped[keys[key] || key] = item;
  }
  return mapped;
}

function toSdkProviderPreferences(provider?: Record<string, unknown>): Record<string, unknown> | undefined {
  return mapSdkKeys(provider, {
    allow_fallbacks: 'allowFallbacks',
    data_collection: 'dataCollection',
    enforce_distillable_text: 'enforceDistillableText',
    max_price: 'maxPrice',
    preferred_max_latency: 'preferredMaxLatency',
    preferred_min_throughput: 'preferredMinThroughput',
    require_parameters: 'requireParameters',
  });
}

function toSdkPlugin(plugin: Record<string, unknown>): Record<string, unknown> {
  return mapSdkKeys(plugin, {
    allowed_models: 'allowedModels',
    cost_quality_tradeoff: 'costQualityTradeoff',
    cost_tier: 'costTier',
    excluded_models: 'excludedModels',
    pin_model: 'pinModel',
  }) || plugin;
}

function toSdkResponseFormat(responseFormat?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!responseFormat) return undefined;
  const mapped = { ...responseFormat };
  if (mapped.json_schema && !mapped.jsonSchema) {
    mapped.jsonSchema = mapSdkKeys(mapped.json_schema, {}) || mapped.json_schema;
    delete mapped.json_schema;
  }
  return mapped;
}

/** Convert the repository's wire-shaped request into the SDK's typed camelCase request model. */
export function buildOpenRouterSdkChatRequest(request: OpenRouterRequest): Record<string, unknown> {
  const stream = request.stream ?? true;
  return {
    model: normalizeOpenRouterModel(request.model),
    ...(request.models !== undefined ? { models: request.models.map(normalizeOpenRouterModel) } : {}),
    messages: request.flattenContentBlocks ? flattenMessageContent(request.messages) : request.messages,
    stream,
    // REL-1105: see buildOpenRouterChatRequest -- streamed usage must be requested explicitly.
    ...(stream ? { streamOptions: { includeUsage: true } } : {}),
    ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.reasoning ? { reasoning: mapSdkKeys(request.reasoning, { effort: 'effort' }) } : {}),
    ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
    ...(toSdkResponseFormat(request.responseFormat) ? { responseFormat: toSdkResponseFormat(request.responseFormat) } : {}),
    ...(toSdkProviderPreferences(request.provider) ? { provider: toSdkProviderPreferences(request.provider) } : {}),
    ...(request.plugins ? { plugins: request.plugins.map(toSdkPlugin) } : {}),
    ...(request.metadata ? { metadata: request.metadata } : {}),
  };
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
    'opencode-go/glm-5.3-flash': 'z-ai/glm-5.3-flash',
    'claude/claude-haiku-4-5': 'anthropic/claude-haiku-4.5',
    // Deliberately NO bare 'glm-5.3-flash' entry. This table is applied to every request
    // regardless of which gateway the client points at, so a bare id mapped here is rewritten
    // for non-OpenRouter transports too. `glm-5.3-flash` is now the default synthetic model and
    // is the literal id opencode and bifrost expect; aliasing it to `z-ai/glm-5.3-flash` made
    // those transports answer `HTTP 401: Model z-ai/glm-5.3-flash is not supported`. Namespaced
    // ids are safe to map because they are never what a non-OpenRouter gateway is asked for.
    // (The pre-existing bare 'glm-5.2' entry below has the same hazard; it is left as-is because
    // nothing defaults to it any more, but it should not be copied.)
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
  cost: number | null;
  routerMetadata: unknown;
  finishReason: string | null;
  lastChunkTime: number;
}

function reasoningText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.flatMap((part) => {
    if (typeof part === 'string') return [part];
    if (!part || typeof part !== 'object') return [];
    const candidate = part as Record<string, unknown>;
    if (typeof candidate.text === 'string') return [candidate.text];
    if (typeof candidate.reasoning === 'string') return [candidate.reasoning];
    if (typeof candidate.content === 'string') return [candidate.content];
    if (typeof candidate.reasoning_content === 'string') return [candidate.reasoning_content];
    if (typeof candidate.reasoningContent === 'string') return [candidate.reasoningContent];
    return [];
  }).join('');
}

function hasNonEmptyText(value: unknown): boolean {
  if (typeof value === 'string') return value.length > 0;
  if (!Array.isArray(value)) return false;
  return value.some((part) => {
    if (typeof part === 'string') return part.length > 0;
    if (!part || typeof part !== 'object') return false;
    const candidate = part as Record<string, unknown>;
    return ['text', 'content', 'reasoning', 'arguments', 'input'].some((key) => hasNonEmptyText(candidate[key]));
  });
}

function hasReasoningProgress(value: unknown): boolean {
  if (typeof value === 'string') return value.length > 0;
  // Reasoning details may contain encrypted/provider-specific objects without a text field. A
  // non-empty detail still proves that the provider has begun producing reasoning output.
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value && typeof value === 'object' && Object.keys(value).length > 0);
}

function hasToolProgress(value: unknown): boolean {
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value && typeof value === 'object' && Object.keys(value).length > 0);
}

/**
 * Return true only for provider output that advances the generated answer. Role-only, empty
 * deltas, usage/metadata, and finish frames must not satisfy TTFT or reset inactivity.
 */
function hasMeaningfulChunk(data: any): boolean {
  const choices = Array.isArray(data?.choices) ? data.choices : [];
  return choices.some((choice: any) => {
    const delta = choice?.delta || {};
    const message = choice?.message || {};
    const content = delta.content ?? message.content;
    const reasoning = delta.reasoning_details
      ?? delta.reasoningDetails
      ?? delta.reasoning
      ?? delta.reasoning_content
      ?? delta.reasoningContent
      ?? message.reasoning_details
      ?? message.reasoningDetails
      ?? message.reasoning
      ?? message.reasoning_content
      ?? message.reasoningContent;
    const toolCalls = delta.tool_calls
      ?? delta.toolCalls
      ?? message.tool_calls
      ?? message.toolCalls;
    return hasNonEmptyText(content)
      || hasReasoningProgress(reasoning)
      || hasToolProgress(toolCalls);
  });
}

function collectChunk(data: any, state: StreamState): boolean {
  const meaningful = hasMeaningfulChunk(data);
  if (typeof data?.model === 'string' && data.model) state.model = data.model;
  const choice = data?.choices?.[0];
  const content = choice?.delta?.content ?? choice?.message?.content;
  if (typeof content === 'string') state.content += content;
  const reasoning = choice?.delta?.reasoning_details
    ?? choice?.delta?.reasoningDetails
    ?? choice?.delta?.reasoning
    ?? choice?.delta?.reasoning_content
    ?? choice?.delta?.reasoningContent
    ?? choice?.message?.reasoning_details
    ?? choice?.message?.reasoningDetails
    ?? choice?.message?.reasoning
    ?? choice?.message?.reasoning_content
    ?? choice?.message?.reasoningContent;
  state.reasoning += reasoningText(reasoning);
  if (choice?.finishReason !== undefined || choice?.finish_reason !== undefined) {
    state.finishReason = choice.finishReason ?? choice.finish_reason ?? null;
  }
  if (data?.usage) {
    // Providers may emit token usage and cost details in separate terminal SSE frames. Merge
    // them instead of letting a later cost-only frame erase prompt/completion token counts.
    state.usage = {
      ...(state.usage && typeof state.usage === 'object' ? state.usage : {}),
      ...data.usage,
      ...(data.usage.cost_details && typeof data.usage.cost_details === 'object'
        ? {
            cost_details: {
              ...(state.usage?.cost_details && typeof state.usage.cost_details === 'object' ? state.usage.cost_details : {}),
              ...data.usage.cost_details,
            },
          }
        : {}),
    };
  }
  const reportedCost = data?.cost
    ?? data?.cost_usd
    ?? data?.usage?.cost
    ?? data?.usage?.total_cost
    ?? data?.usage?.cost_details?.upstream_inference_cost;
  if (Number.isFinite(Number(reportedCost))) state.cost = Number(reportedCost);
  state.lastChunkTime = Date.now();
  return meaningful;
}

export { isExplicitUpstreamRejection, UpstreamCapacityRejectionError } from './providerCapacityManager';
import { isExplicitUpstreamRejection, UpstreamCapacityRejectionError } from './providerCapacityManager';

async function readWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeoutError: () => Error,
  abortPromise?: Promise<never>,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(onTimeoutError());
    }, timeoutMs);
  });

  try {
    const racers: Array<Promise<T> | Promise<never>> = [promise, timeoutPromise];
    if (abortPromise) racers.push(abortPromise);
    return await Promise.race(racers);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// A provider can ignore AbortSignal and return a never-settling reader.cancel() promise. Never
// make the review wait on cleanup after we have already classified the provider failure.
const STREAM_CANCEL_WAIT_MS = 100;

async function cancelReader<T>(reader: ReadableStreamDefaultReader<T>, reason: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    // Invoke cancellation synchronously so an active provider stream is detached immediately;
    // only the potentially unbounded completion of the provider's promise is raced below.
    if (typeof reader.cancel === 'function') {
      let cancellation: Promise<void>;
      try {
        cancellation = Promise.resolve(reader.cancel(reason)).then(() => undefined, () => undefined);
      } catch (_) {
        cancellation = Promise.resolve();
      }
      await Promise.race([
        cancellation,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, STREAM_CANCEL_WAIT_MS);
        }),
      ]);
    }
  } finally {
    if (timer) clearTimeout(timer);
    try {
      // Releasing our lock prevents a cancelled direct reader from retaining the response body.
      // A provider that leaves a read permanently pending may reject this operation; cancellation
      // itself has already been issued and the failure is intentionally ignored.
      reader.releaseLock?.();
    } catch (_) {}
  }
}

function cancelLateBody(value: unknown, reason: string): void {
  const body = value && typeof value === 'object' && 'body' in value
    ? (value as { body?: unknown }).body
    : value;
  if (!body || typeof body !== 'object') return;
  try {
    const getReader = (body as { getReader?: () => ReadableStreamDefaultReader<unknown> }).getReader;
    if (typeof getReader === 'function') {
      const reader = getReader.call(body);
      void cancelReader(reader, reason).catch(() => undefined);
      return;
    }
  } catch (_) {}
  try {
    const cancel = (body as { cancel?: (reason?: unknown) => unknown }).cancel;
    if (typeof cancel === 'function') {
      void Promise.resolve(cancel.call(body, reason)).catch(() => undefined);
    }
  } catch (_) {}
}

/** Own the body reader so abort cancels an active read, not just its waiting caller. */
async function readResponseText(response: Response, signal?: AbortSignal): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return raceWithAbort(response.text(), signal);
  const decoder = new TextDecoder();
  let text = '';
  let cancellation: Promise<void> | undefined;
  const cancel = () => {
    cancellation ??= cancelReader(reader, 'response body cancellation');
    return cancellation;
  };
  const onAbort = () => { void cancel(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw timeoutErrorForSignal(signal);
      const { done, value } = await raceWithAbort(reader.read(), signal);
      // Cancelling a reader can resolve its pending read with done:true. Never turn that
      // into a successful truncated body when cancellation and completion coincide.
      if (signal?.aborted) throw timeoutErrorForSignal(signal);
      if (done) return text + decoder.decode();
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    await cancel();
    throw signal?.aborted ? timeoutErrorForSignal(signal) : error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    try { reader.releaseLock(); } catch (_) {}
  }
}

async function readStreamingResponse(
  response: Response,
  requestedModel: string,
  options?: {
    inactivityTimeoutMs?: number;
    ttftTimeoutMs?: number;
    totalTimeoutMs?: number;
    signal?: AbortSignal;
    onTotalTimeout?: () => void;
    onCancel?: (reason: string) => void;
    persona?: string;
    providerId?: string;
    onFirstToken?: () => void;
  }
): Promise<any> {
  const contentType = response.headers?.get('content-type') || '';
  if (!contentType.includes('text/event-stream')) {
    return JSON.parse(await readResponseText(response, options?.signal));
  }

  const reader = response.body?.getReader();
  if (!reader) {
    return raceWithAbort(
      response.json(),
      options?.signal,
      () => cancelLateBody(response, 'request cancellation'),
    );
  }

  const decoder = new TextDecoder();
  let buffer = '';
  const state: StreamState = {
    model: requestedModel,
    content: '',
    reasoning: '',
    usage: null as any,
    cost: null,
    routerMetadata: null,
    finishReason: null,
    lastChunkTime: Date.now(),
  };

  const rawInactivityTimeoutMs = options?.inactivityTimeoutMs;
  const inactivityTimeoutMs = typeof rawInactivityTimeoutMs === 'number'
    && Number.isFinite(rawInactivityTimeoutMs)
    && rawInactivityTimeoutMs > 0
    ? rawInactivityTimeoutMs
    : 45_000;
  const ttftTimeoutMs = options?.ttftTimeoutMs && options.ttftTimeoutMs > 0
    ? options.ttftTimeoutMs
    : inactivityTimeoutMs;
  const personaLabel = options?.persona ? `[Persona: ${options.persona}] ` : '';
  let lastHeartbeatLog = Date.now();
  // SSE comments/keepalives prove the connection is alive, but they are not a
  // first-data event. Keep TTFT tied to an actual provider payload so a stream
  // cannot evade the first-token budget with heartbeats alone.
  let receivedFirstData = false;
  let lastMeaningfulDataAt = Date.now();
  const totalDeadlineAt = options?.totalTimeoutMs && options.totalTimeoutMs > 0
    ? Date.now() + options.totalTimeoutMs
    : 0;
  // Timer callbacks can run a few milliseconds before their requested deadline. Treat a read
  // timeout that is already inside this small scheduling window as a total deadline so the same
  // request cannot nondeterministically report either "stalled" or "total deadline".
  const totalDeadlineClassificationGraceMs = 10;
  const totalDeadlineReached = () => totalDeadlineAt > 0 && Date.now() >= totalDeadlineAt;
  const totalDeadlineNear = () => totalDeadlineAt > 0 && Date.now() + totalDeadlineClassificationGraceMs >= totalDeadlineAt;
  const totalDeadlineError = () => new OpenRouterTimeoutError(
    `OpenRouter streaming response exceeded total deadline of ${options?.totalTimeoutMs}ms`,
    'total',
  );
  const inactivityTimeoutError = () => receivedFirstData
    ? new OpenRouterTimeoutError(
        `Streaming stalled: no meaningful data received from provider for ${Math.round(inactivityTimeoutMs / 1000)}s`,
        'inactivity',
      )
    : new OpenRouterTimeoutError(
        `Time to first streamed chunk exceeded ${Math.round(ttftTimeoutMs / 1000)}s`,
        'ttft',
      );
  let totalDeadlineTriggered = false;
  let cancellationPromise: Promise<void> | undefined;
  const cancel = (reason: string): Promise<void> => {
    cancellationPromise ??= cancelReader(reader, reason);
    return cancellationPromise;
  };
  const streamSignal = options?.signal;
  let signalAborted = false;
  let signalAbortError: OpenRouterTimeoutError | undefined;
  let onSignalAbort: (() => void) | undefined;
  const signalAbortPromise = streamSignal
    ? new Promise<never>((_, reject) => {
        onSignalAbort = () => {
          if (signalAborted) return;
          signalAborted = true;
          signalAbortError = timeoutErrorForSignal(streamSignal);
          void cancel('request cancellation');
          reject(signalAbortError);
        };
        streamSignal.addEventListener('abort', onSignalAbort, { once: true });
        if (streamSignal.aborted) onSignalAbort();
      })
    : undefined;
  // If the signal was already aborted, the loop below may throw before it races this promise.
  // Attach a sink so that pre-aborted cleanup never creates an unhandled rejection.
  void signalAbortPromise?.catch(() => undefined);
  const triggerTotalDeadline = () => {
    if (totalDeadlineTriggered) return;
    totalDeadlineTriggered = true;
    options?.onTotalTimeout?.();
    options?.onCancel?.('stream total deadline');
    void cancel('stream total deadline');
  };
  // Keep an independent wall-clock timer for active streams. A provider can ignore the fetch
  // AbortSignal, and an active reader can keep resolving before each inactivity timeout; in both
  // cases expiry must still abort the request and detach the reader at the total deadline.
  const totalDeadlineTimer = totalDeadlineAt
    ? setTimeout(triggerTotalDeadline, Math.max(0, totalDeadlineAt - Date.now()))
    : undefined;

  const consume = (line: string): boolean => {
    const trimmed = line.trim();
    if (!trimmed || trimmed === 'data: [DONE]') return false;
    // SSE comment lines are keep-alives and are not JSON events.
    if (trimmed.startsWith(':')) {
      state.lastChunkTime = Date.now();
      return false;
    }
    const json = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
    if (!json || json === '[DONE]') return false;
    let meaningful = false;
    try {
      meaningful = collectChunk(JSON.parse(json), state);
    } catch {
      throw new OpenRouterResponseError('OpenRouter returned malformed response: malformed streaming JSON');
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
    return meaningful;
  };

  try {
    while (true) {
      if (signalAborted) throw signalAbortError || new OpenRouterTimeoutError('OpenRouter request was cancelled', 'request');
      const readPromise = reader.read();
      const remainingTotalMs = totalDeadlineAt ? totalDeadlineAt - Date.now() : Infinity;
      if (remainingTotalMs <= 0) {
        throw totalDeadlineError();
      }
      const inactivityDeadlineAt = receivedFirstData
        ? lastMeaningfulDataAt + inactivityTimeoutMs
        : lastMeaningfulDataAt + ttftTimeoutMs;
      const remainingInactivityMs = inactivityDeadlineAt - Date.now();
      if (remainingInactivityMs <= 0) {
        throw totalDeadlineNear() ? totalDeadlineError() : inactivityTimeoutError();
      }
      const readTimeoutMs = Math.min(Math.max(0, remainingInactivityMs), remainingTotalMs);
      const { done, value } = await readWithTimeout(
        readPromise,
        readTimeoutMs,
        () => totalDeadlineNear()
          ? totalDeadlineError()
          : inactivityTimeoutError(),
        signalAbortPromise,
      );
      // Reader cancellation can settle the active read as `{done:true}` before the abort
      // rejection wins Promise.race. Never accept that cancellation EOF as a partial success.
      if (signalAborted) {
        throw signalAbortError || new OpenRouterTimeoutError('OpenRouter request was cancelled', 'request');
      }
      if (totalDeadlineTriggered || totalDeadlineReached()) {
        throw totalDeadlineError();
      }
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (consume(line)) {
          lastMeaningfulDataAt = Date.now();
          if (!receivedFirstData) {
            receivedFirstData = true;
            options?.onFirstToken?.();
          }
        }
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      if (consume(buffer)) {
        lastMeaningfulDataAt = Date.now();
        if (!receivedFirstData) {
          receivedFirstData = true;
          options?.onFirstToken?.();
        }
      }
    }
  } catch (error) {
    // The read timer can win a same-deadline race a few milliseconds early (the classification
    // grace above still marks it as total). Trigger the abort/cancel path for that case too.
    const totalDeadlineExpired = totalDeadlineTriggered
      || (error instanceof OpenRouterTimeoutError && error.kind === 'total')
      || (signalAborted && signalAbortError?.kind === 'total');
    if (signalAborted) {
      if (totalDeadlineExpired) {
        triggerTotalDeadline();
        await cancel('stream total deadline');
        throw totalDeadlineError();
      }
      await cancel('request cancellation');
      throw signalAbortError || new OpenRouterTimeoutError('OpenRouter request was cancelled', 'request');
    }
    if (totalDeadlineExpired) {
      triggerTotalDeadline();
      await cancel('stream total deadline');
      throw totalDeadlineError();
    }
    if (error instanceof OpenRouterTimeoutError) options?.onCancel?.('stream timeout');
    else options?.onCancel?.('stream error');
    await cancel(error instanceof OpenRouterTimeoutError ? 'stream timeout' : 'stream error');
    throw error;
  } finally {
    if (totalDeadlineTimer) clearTimeout(totalDeadlineTimer);
    if (streamSignal && onSignalAbort) streamSignal.removeEventListener('abort', onSignalAbort);
    try { reader.releaseLock(); } catch (_) {}
  }

  // Deliberately do NOT fold `state.reasoning` into `content` here. The single extraction
  // block in `executeSingleAttempt` is the one place that decides content-vs-reasoning
  // precedence and the `finish_reason: "length"` truncated-reasoning guard; merging here would
  // make that block see a non-empty `content` and skip the guard for every streamed response.
  return {
    model: state.model,
    choices: [{
      finish_reason: state.finishReason,
      message: { role: 'assistant', content: state.content, reasoning: state.reasoning || undefined },
    }],
    usage: state.usage,
    cost: state.cost,
  };
}

function sdkUsageToWire(usage: any, rawUsage?: any): Record<string, unknown> | null {
  if ((!usage || typeof usage !== 'object') && (!rawUsage || typeof rawUsage !== 'object')) return null;
  const costDetails = usage?.costDetails ?? usage?.cost_details ?? rawUsage?.costDetails ?? rawUsage?.cost_details;
  const cachedTokens = resolveCachedTokens(usage) || resolveCachedTokens(rawUsage);
  const cacheReadTokens = usage?.cacheReadTokens ?? usage?.cacheReadInputTokens ?? usage?.cache_read_input_tokens
    ?? rawUsage?.cacheReadTokens ?? rawUsage?.cacheReadInputTokens ?? rawUsage?.cache_read_input_tokens;
  const promptCacheHitTokens = usage?.promptCacheHitTokens ?? usage?.prompt_cache_hit_tokens
    ?? rawUsage?.promptCacheHitTokens ?? rawUsage?.prompt_cache_hit_tokens;
  return {
    prompt_tokens: usage?.promptTokens ?? usage?.prompt_tokens ?? rawUsage?.promptTokens ?? rawUsage?.prompt_tokens,
    completion_tokens: usage?.completionTokens ?? usage?.completion_tokens ?? rawUsage?.completionTokens ?? rawUsage?.completion_tokens,
    total_tokens: usage?.totalTokens ?? usage?.total_tokens ?? rawUsage?.totalTokens ?? rawUsage?.total_tokens,
    ...(cachedTokens > 0 ? { cached_tokens: cachedTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cache_read_input_tokens: Number(cacheReadTokens) } : {}),
    ...(promptCacheHitTokens !== undefined ? { prompt_cache_hit_tokens: Number(promptCacheHitTokens) } : {}),
    ...(usage?.cost !== undefined ? { cost: usage.cost } : rawUsage?.cost !== undefined ? { cost: rawUsage.cost } : {}),
    ...(costDetails && typeof costDetails === 'object' ? {
      cost_details: {
        ...(costDetails.upstreamInferenceCompletionsCost !== undefined || costDetails.upstream_inference_completions_cost !== undefined
          ? { upstream_inference_completions_cost: costDetails.upstreamInferenceCompletionsCost ?? costDetails.upstream_inference_completions_cost }
          : {}),
        ...(costDetails.upstreamInferenceCost !== undefined || costDetails.upstream_inference_cost !== undefined
          ? { upstream_inference_cost: costDetails.upstreamInferenceCost ?? costDetails.upstream_inference_cost }
          : {}),
        ...(costDetails.upstreamInferencePromptCost !== undefined || costDetails.upstream_inference_prompt_cost !== undefined
          ? { upstream_inference_prompt_cost: costDetails.upstreamInferencePromptCost ?? costDetails.upstream_inference_prompt_cost }
          : {}),
      },
    } : {}),
  };
}

function collectSdkChunk(data: any, state: StreamState): boolean {
  if (data?.error) {
    const message = data.error.message || data.error.code || 'OpenRouter emitted a streaming error';
    const status = Number.isInteger(Number(data.error.code)) ? Number(data.error.code) : undefined;
    throw new OpenRouterResponseError(`OpenRouter streaming error: ${String(message).slice(0, 2_000)}`, status);
  }
  const meaningful = hasMeaningfulChunk(data);
  if (typeof data?.model === 'string' && data.model) state.model = data.model;
  const choice = data?.choices?.[0];
  const content = choice?.delta?.content ?? choice?.message?.content;
  if (typeof content === 'string') state.content += content;
  const reasoning = choice?.delta?.reasoningDetails
    ?? choice?.delta?.reasoning_details
    ?? choice?.delta?.reasoning
    ?? choice?.delta?.reasoning_content
    ?? choice?.delta?.reasoningContent
    ?? choice?.message?.reasoningDetails
    ?? choice?.message?.reasoning_details
    ?? choice?.message?.reasoning
    ?? choice?.message?.reasoning_content
    ?? choice?.message?.reasoningContent;
  state.reasoning += reasoningText(reasoning);
  if (choice?.finishReason !== undefined || choice?.finish_reason !== undefined) {
    state.finishReason = choice.finishReason ?? choice.finish_reason ?? null;
  }
  if (data?.usage) {
    const usage = sdkUsageToWire(data.usage);
    state.usage = {
      ...(state.usage && typeof state.usage === 'object' ? state.usage : {}),
      ...(usage || {}),
    };
  }
  const reportedCost = data?.cost
    ?? data?.costUSD
    ?? data?.cost_usd
    ?? data?.usage?.cost
    ?? data?.usage?.totalCost
    ?? data?.usage?.total_cost
    ?? data?.usage?.costDetails?.upstreamInferenceCost
    ?? data?.usage?.cost_details?.upstream_inference_cost;
  if (Number.isFinite(Number(reportedCost))) state.cost = Number(reportedCost);
  if (data?.openrouterMetadata && typeof data.openrouterMetadata === 'object') {
    state.routerMetadata = data.openrouterMetadata;
  } else if (data?.openrouter_metadata && typeof data.openrouter_metadata === 'object') {
    state.routerMetadata = data.openrouter_metadata;
  }
  state.lastChunkTime = Date.now();
  return meaningful;
}

async function readSdkStreamingResponse(
  stream: ReadableStream<unknown>,
  requestedModel: string,
  options?: {
    inactivityTimeoutMs?: number;
    ttftTimeoutMs?: number;
    totalTimeoutMs?: number;
    signal?: AbortSignal;
    onTotalTimeout?: () => void;
    onCancel?: (reason: string) => void;
    onFirstToken?: () => void;
  },
): Promise<any> {
  const reader = stream.getReader();
  const state: StreamState = {
    model: requestedModel,
    content: '',
    reasoning: '',
    usage: null,
    cost: null,
    routerMetadata: null,
    finishReason: null,
    lastChunkTime: Date.now(),
  };
  const rawInactivityTimeoutMs = options?.inactivityTimeoutMs;
  const inactivityTimeoutMs = typeof rawInactivityTimeoutMs === 'number'
    && Number.isFinite(rawInactivityTimeoutMs)
    && rawInactivityTimeoutMs > 0
    ? rawInactivityTimeoutMs
    : 45_000;
  const ttftTimeoutMs = options?.ttftTimeoutMs && options.ttftTimeoutMs > 0
    ? options.ttftTimeoutMs
    : inactivityTimeoutMs;
  const totalDeadlineAt = options?.totalTimeoutMs && options.totalTimeoutMs > 0
    ? Date.now() + options.totalTimeoutMs
    : 0;
  let receivedFirstData = false;
  let lastMeaningfulDataAt = Date.now();
  const totalDeadlineError = () => new OpenRouterTimeoutError(
    `OpenRouter streaming response exceeded total deadline of ${options?.totalTimeoutMs}ms`,
    'total',
  );
  const inactivityTimeoutError = () => receivedFirstData
    ? new OpenRouterTimeoutError(
        `Streaming stalled: no meaningful data received from OpenRouter for ${Math.round(inactivityTimeoutMs / 1000)}s`,
        'inactivity',
      )
    : new OpenRouterTimeoutError(
        `Time to first streamed chunk from OpenRouter exceeded ${Math.round(ttftTimeoutMs / 1000)}s`,
        'ttft',
      );
  const totalDeadlineNear = () => totalDeadlineAt > 0 && Date.now() + 10 >= totalDeadlineAt;
  let totalDeadlineTriggered = false;
  let cancellationPromise: Promise<void> | undefined;
  const cancel = (reason: string): Promise<void> => {
    cancellationPromise ??= cancelReader(reader, reason);
    return cancellationPromise;
  };
  const streamSignal = options?.signal;
  let signalAborted = false;
  let signalAbortError: OpenRouterTimeoutError | undefined;
  let onSignalAbort: (() => void) | undefined;
  const signalAbortPromise = streamSignal
    ? new Promise<never>((_, reject) => {
        onSignalAbort = () => {
          if (signalAborted) return;
          signalAborted = true;
          signalAbortError = timeoutErrorForSignal(streamSignal);
          void cancel('request cancellation');
          reject(signalAbortError);
        };
        streamSignal.addEventListener('abort', onSignalAbort, { once: true });
        if (streamSignal.aborted) onSignalAbort();
      })
    : undefined;
  void signalAbortPromise?.catch(() => undefined);
  const triggerTotalDeadline = () => {
    if (totalDeadlineTriggered) return;
    totalDeadlineTriggered = true;
    options?.onTotalTimeout?.();
    options?.onCancel?.('stream total deadline');
    void cancel('stream total deadline');
  };
  const totalTimer = totalDeadlineAt
    ? setTimeout(triggerTotalDeadline, Math.max(0, totalDeadlineAt - Date.now()))
    : undefined;
  try {
    while (true) {
      if (signalAborted) throw signalAbortError || new OpenRouterTimeoutError('OpenRouter request was cancelled', 'request');
      const remainingTotalMs = totalDeadlineAt ? totalDeadlineAt - Date.now() : Infinity;
      if (remainingTotalMs <= 0 || totalDeadlineTriggered) throw totalDeadlineError();
      const inactivityDeadlineAt = receivedFirstData
        ? lastMeaningfulDataAt + inactivityTimeoutMs
        : lastMeaningfulDataAt + ttftTimeoutMs;
      const remainingInactivityMs = inactivityDeadlineAt - Date.now();
      if (remainingInactivityMs <= 0) {
        throw totalDeadlineNear() ? totalDeadlineError() : inactivityTimeoutError();
      }
      const readTimeoutMs = Math.min(Math.max(0, remainingInactivityMs), remainingTotalMs);
      const { done, value } = await readWithTimeout(
        reader.read(),
        readTimeoutMs,
        () => totalDeadlineNear() ? totalDeadlineError() : inactivityTimeoutError(),
        signalAbortPromise,
      );
      // Cancellation may surface as terminal EOF before the abort promise wins the race.
      if (signalAborted) {
        throw signalAbortError || new OpenRouterTimeoutError('OpenRouter request was cancelled', 'request');
      }
      if (done) break;
      if (value !== undefined) {
        if (collectSdkChunk(value, state)) {
          lastMeaningfulDataAt = Date.now();
          if (!receivedFirstData) {
            receivedFirstData = true;
            options?.onFirstToken?.();
          }
        }
      }
    }
    // The deadline timer cancels the SDK EventStream so a pending read can settle. Cancellation
    // reports `{done:true}` to the downstream reader, therefore classify that terminal read as a
    // timeout instead of returning a partial successful completion.
    if (totalDeadlineTriggered || (totalDeadlineAt > 0 && Date.now() >= totalDeadlineAt)) {
      throw totalDeadlineError();
    }
  } catch (error) {
    const totalExpired = totalDeadlineTriggered
      || (error instanceof OpenRouterTimeoutError && error.kind === 'total')
      || (signalAborted && signalAbortError?.kind === 'total');
    if (signalAborted) {
      if (totalExpired) {
        triggerTotalDeadline();
        await cancel('stream total deadline');
        throw totalDeadlineError();
      }
      await cancel('request cancellation');
      throw signalAbortError || new OpenRouterTimeoutError('OpenRouter request was cancelled', 'request');
    }
    if (totalExpired) {
      triggerTotalDeadline();
      await cancel('stream total deadline');
      throw totalDeadlineError();
    }
    if (error instanceof OpenRouterTimeoutError) options?.onCancel?.('stream timeout');
    else options?.onCancel?.('stream error');
    await cancel(error instanceof OpenRouterTimeoutError ? 'stream timeout' : 'stream error');
    throw error;
  } finally {
    if (totalTimer) clearTimeout(totalTimer);
    if (streamSignal && onSignalAbort) streamSignal.removeEventListener('abort', onSignalAbort);
    try { reader.releaseLock(); } catch (_) {}
  }

  // Deliberately do NOT fold `state.reasoning` into `content` here -- see the matching note in
  // `readStreamingResponse` above. The shared extraction block owns the fallback decision.
  return {
    model: state.model,
    choices: [{
      index: 0,
      finish_reason: state.finishReason,
      message: {
        role: 'assistant',
        content: state.content,
        ...(state.reasoning ? { reasoning: state.reasoning } : {}),
      },
    }],
    ...(state.usage ? { usage: state.usage } : {}),
    ...(state.cost !== null ? { cost: state.cost } : {}),
    ...(state.routerMetadata ? { openrouter_metadata: state.routerMetadata } : {}),
  };
}

function normalizeSdkResponse(response: any, rawUsage?: any): any {
  const usage = sdkUsageToWire(response?.usage, rawUsage);
  const choice = response?.choices?.[0];
  const message = choice?.message || {};
  const content = typeof message.content === 'string'
    ? message.content
    : Array.isArray(message.content)
      ? message.content.map((part: any) => typeof part === 'string' ? part : part?.text || '').join('')
      : '';
  const cost = response?.cost
    ?? response?.costUSD
    ?? response?.usage?.cost
    ?? response?.usage?.costDetails?.upstreamInferenceCost;
  return {
    model: response?.model,
    choices: [{
      index: choice?.index ?? 0,
      finish_reason: choice?.finishReason ?? choice?.finish_reason ?? null,
      message: {
        role: message.role || 'assistant',
        content,
        ...(message.reasoning ? { reasoning: message.reasoning } : {}),
        ...(message.reasoningDetails ? { reasoning_details: message.reasoningDetails } : {}),
        ...(message.reasoning_details ? { reasoning_details: message.reasoning_details } : {}),
        ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
        ...(message.reasoningContent ? { reasoningContent: message.reasoningContent } : {}),
      },
    }],
    ...(usage ? { usage } : {}),
    ...(cost !== undefined ? { cost } : {}),
    ...(response?.openrouterMetadata ? { openrouter_metadata: response.openrouterMetadata } : {}),
  };
}

/**
 * REL-1115: Review Yeti takes no MCP tools from the gateway.
 *
 * Bifrost injects every MCP tool the calling virtual key is granted into each
 * completion. Through the litellm optimizer, Review Yeti's calls briefly ran
 * under a shared key with 880 tools: a median of ~208k prompt tokens per call,
 * against 16k before. The review-yeti key itself holds four MCP grants, and in
 * 1,202 pre-optimizer calls no MCP tool was ever called. An EMPTY
 * `x-bf-mcp-include-tools` narrows the key's grant to no tool (Bifrost
 * governance can only narrow a grant, never widen it). On the live gateway the
 * same tiny prompt cost 37 prompt tokens with it and ~197k without. The review
 * lane's own function tools travel in the request body and are unaffected.
 *
 * It is set after caller metadata, so metadata cannot re-open injection. Other
 * gateways ignore an unknown x- header.
 */
export const GATEWAY_MCP_INCLUDE_TOOLS_HEADER = 'x-bf-mcp-include-tools';
export const GATEWAY_MCP_INCLUDE_TOOLS_NONE = '';

/**
 * REL-1134: Review Yeti bypasses the gateway response cache.
 *
 * Bifrost's semantic cache runs with a global default cache key and a 15m
 * TTL, so every request is looked up and stored. A re-review of the same
 * prompt could get a stale completion back instead of a fresh verdict. The
 * cache plugin has no per-key config, but it honors two documented
 * per-request headers:
 * - `x-bf-cache-no-store: true` means this response is never written.
 * - `x-bf-cache-key` moves the lookup into its own bucket. Review Yeti is the
 *   only writer to this bucket, and it never writes, so a lookup can never hit.
 *
 * Headroom and Laya prompt rewriting are turned off for the `review-yeti`
 * virtual key in the gateway config (`skip_virtual_keys`), not here.
 *
 * These are set after caller metadata, so metadata cannot opt back into the
 * cache. Other gateways ignore unknown x- headers.
 */
export const GATEWAY_CACHE_KEY_HEADER = 'x-bf-cache-key';
export const GATEWAY_CACHE_KEY_UNCACHED = 'review-yeti-uncached';
export const GATEWAY_CACHE_NO_STORE_HEADER = 'x-bf-cache-no-store';

/** Gateway request-policy headers Review Yeti pins on every model call. */
export const GATEWAY_POLICY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  [GATEWAY_MCP_INCLUDE_TOOLS_HEADER]: GATEWAY_MCP_INCLUDE_TOOLS_NONE,
  [GATEWAY_CACHE_KEY_HEADER]: GATEWAY_CACHE_KEY_UNCACHED,
  [GATEWAY_CACHE_NO_STORE_HEADER]: 'true',
});

/** Pin the policy headers on a plain header record, first removing any case variant set by the caller. */
function applyGatewayPolicyHeaders(headers: Record<string, string>): void {
  const policy = new Set(Object.keys(GATEWAY_POLICY_HEADERS));
  for (const name of Object.keys(headers)) {
    if (policy.has(name.toLowerCase())) delete headers[name];
  }
  Object.assign(headers, GATEWAY_POLICY_HEADERS);
}

async function createOpenRouterSdkClient(options: {
  baseUrl: string;
  apiKey: string;
  fetchImplementation: FetchImplementation;
  onGenerationId?: (value: string) => void;
}): Promise<OpenRouterSdkClient> {
  const { OpenRouter, HTTPClient } = await loadOpenRouterSdk();
  const httpClient = new HTTPClient({
    fetcher: async (sdkRequest: Request) => {
      const body = sdkRequest.body ? await sdkRequest.clone().text() : undefined;
      const headers = new Headers(sdkRequest.headers);
      for (const [name, value] of Object.entries(GATEWAY_POLICY_HEADERS)) headers.set(name, value);
      let response = await options.fetchImplementation(sdkRequest.url, {
        method: sdkRequest.method,
        headers,
        ...(body !== undefined ? { body } : {}),
        signal: sdkRequest.signal,
      });
      if (!(response instanceof Response)) {
        // Keep injected OpenAI-compatible test/replay transports usable while production fetch
        // remains a native WHATWG Response. The official SDK receives the adapted response;
        // response validation and parsing still happen through the same path.
        const compatibilityResponse: any = response as any;
        let compatibilityBody = compatibilityResponse?.body || '';
        if (!compatibilityBody && typeof compatibilityResponse?.json === 'function') {
          try {
            compatibilityBody = JSON.stringify(await raceWithAbort(
              Promise.resolve(compatibilityResponse.json()),
              sdkRequest.signal,
              () => cancelLateBody(compatibilityResponse, 'request deadline'),
            ));
          } catch (error) {
            if (error instanceof OpenRouterTimeoutError) throw error;
            // Fall through to text for malformed/non-JSON doubles.
          }
        }
        if (!compatibilityBody && typeof compatibilityResponse?.text === 'function') {
          compatibilityBody = await raceWithAbort(
            Promise.resolve(compatibilityResponse.text()),
            sdkRequest.signal,
            () => cancelLateBody(compatibilityResponse, 'request deadline'),
          );
        }
        response = new Response(compatibilityBody, {
          status: Number(compatibilityResponse?.status) || 200,
          statusText: compatibilityResponse?.statusText,
          headers: compatibilityResponse?.headers || { 'content-type': 'application/json' },
        });
      }
      const contentType = response.headers?.get?.('content-type') || '';
      const isSse = contentType.includes('text/event-stream');
      if (!isSse) {
        try {
          const text = await readResponseText(response, sdkRequest.signal);
          let json: any = null;
          try {
            json = JSON.parse(text);
            if (json && json.usage) {
              capturedJsonUsage = json.usage;
            }
          } catch (_) {
            json = null;
          }
          rawJsonCapture = {
            getJson: async () => json,
            status: response.status,
            statusText: response.statusText,
            headers: new Headers(response.headers),
          };
          response = new Response(text, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        } catch (error) {
          if (error instanceof OpenRouterTimeoutError) throw error;
          rawJsonCapture = null;
        }
      }
      return response;
    },
  });
  let rawJsonCapture: { getJson: () => Promise<any>; status: number; statusText: string; headers: Headers } | null = null;
  let capturedJsonUsage: any = null;
  httpClient.addHook('response', (response: Response) => {
    const generationId = response?.headers?.get?.('x-generation-id');
    if (generationId) options.onGenerationId?.(generationId);
  });
  const client = new OpenRouter({
    apiKey: options.apiKey,
    serverURL: options.baseUrl,
    httpClient,
    // Retry policy belongs to the review pipeline, where it is bounded and telemetry-aware.
    // Disable the SDK's default one-hour 5xx retry loop so it cannot violate the 15-minute CI cap.
    retryConfig: { strategy: 'none' },
  });
  client.getRawResponse = async () => {
    if (!rawJsonCapture) return null;
    const json = await rawJsonCapture.getJson();
    if (!json) return null;
    return new Response(JSON.stringify(json), {
      status: rawJsonCapture.status,
      statusText: rawJsonCapture.statusText,
      headers: rawJsonCapture.headers,
    });
  };
  client.getRawJson = async () => (rawJsonCapture ? rawJsonCapture.getJson() : null);
  client.getRawUsage = () => capturedJsonUsage;
  return client;
}

function sdkErrorStatus(error: any): number | undefined {
  const status = Number(error?.statusCode ?? error?.status);
  return Number.isInteger(status) && status > 0 ? status : undefined;
}

function sdkErrorMessage(error: any): string {
  const detail = error?.error?.message
    ?? error?.data$?.error?.message
    ?? error?.message
    ?? String(error);
  return String(detail).slice(0, 2_000);
}

function isSdkResponseValidationFailure(error: any): boolean {
  const name = String(error?.name || '');
  const message = sdkErrorMessage(error);
  return name === 'ResponseValidationError'
    || name === 'SDKValidationError'
    || name === 'ZodError'
    || /response validation failed|invalid input|invalid_(?:union|type|value)|expected .* received|malformed json|unexpected status or content-type/i.test(message);
}

export function calculateFullJitterDelay(
  attempt: number,
  initialDelayMs: number = 500,
  maxDelayMs: number = 5000,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(maxDelayMs, initialDelayMs * Math.pow(2, attempt));
  return Math.floor(random() * ceiling);
}

export function isTransientGatewayError(error: unknown): boolean {
  if (error instanceof OpenRouterResponseError) {
    if (error.status === 502 || error.status === 503 || error.status === 504) {
      return true;
    }
    if (typeof error.message === 'string') {
      if (/HTTP (502|503|504)\b/i.test(error.message)) {
        return true;
      }
      if (/empty completion content/i.test(error.message)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Name the upstream that actually answered.
 *
 * This client is OpenAI-compatible and is pointed at both OpenRouter and the
 * Bifrost gateway; Bifrost in turn routes to whatever provider its virtual key
 * resolves to (ollama, gemini, ...). Hardcoding "OpenRouter" into every failure
 * message is actively misleading: on 2026-09-17 it sent an outage investigation
 * at an OpenRouter balance while the real blocker was Ollama out of credits.
 *
 * Prefer the provider Bifrost reports in `extra_fields.routing_info`, then fall
 * back to the configured host.
 */
function extractRoutingInfo(candidate: any): any {
  return candidate?.extra_fields?.routing_info
    ?? candidate?.data$?.extra_fields?.routing_info
    ?? candidate?.error?.extra_fields?.routing_info
    ?? candidate?.body?.extra_fields?.routing_info
    ?? null;
}

export function upstreamLabel(baseUrl: string, parsedBody?: unknown): string {
  const routing = extractRoutingInfo(parsedBody);
  const provider = typeof routing?.provider === 'string' ? routing.provider : null;
  if (provider) {
    const model = typeof routing?.model === 'string' ? routing.model : null;
    const key = typeof routing?.key === 'string' ? routing.key : null;
    const detail = [model, key ? `key=${key}` : null].filter(Boolean).join(', ');
    return detail ? `${provider} (${detail})` : provider;
  }
  try {
    const host = new URL(baseUrl).hostname;
    return host === 'openrouter.ai' ? 'OpenRouter' : host;
  } catch {
    return 'upstream';
  }
}

/** OpenAI-compatible model boundary pinned to OpenRouter for review execution. */
export class OpenRouterClient implements ReviewModelClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImplementation: FetchImplementation;
  private readonly now: () => number;
  readonly maxRetries: number;
  readonly initialRetryDelayMs: number;
  readonly maxRetryDelayMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly random: () => number;

  constructor(options: OpenRouterClientOptions = {}) {
    this.baseUrl = (options.baseUrl || process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
    this.apiKey = options.apiKey || process.env.OPENROUTER_API_KEY || '';
    this.fetchImplementation = options.fetchImplementation || options.fetchImpl || ((input, init) => globalThis.fetch(input, init));
    this.now = options.now || Date.now;
    this.maxRetries = options.maxRetries !== undefined
      ? options.maxRetries
      : (process.env.REVIEW_YETI_GATEWAY_RETRIES ? Number(process.env.REVIEW_YETI_GATEWAY_RETRIES) : 0);
    this.initialRetryDelayMs = options.initialRetryDelayMs !== undefined ? options.initialRetryDelayMs : 500;
    this.maxRetryDelayMs = options.maxRetryDelayMs !== undefined ? options.maxRetryDelayMs : 5000;
    this.sleep = options.sleep || ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.random = options.random || Math.random;
  }

  async complete(request: OpenRouterRequest): Promise<OpenRouterResponse> {
    return raceWithAbort(this.completeInternal(request), request.signal);
  }

  private async completeInternal(request: OpenRouterRequest): Promise<OpenRouterResponse> {
    if (!this.apiKey.trim()) {
      throw new OpenRouterConnectionError('OPENROUTER_API_KEY is required; review execution has no offline model fallback');
    }
    if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) {
      throw new TypeError(`OpenRouter request requires a positive timeoutMs; received ${String(request.timeoutMs)}`);
    }
    if (request.signal?.aborted) {
      throw new OpenRouterTimeoutError('OpenRouter request was cancelled', 'request');
    }

    const maxRetries = request.maxRetries !== undefined ? request.maxRetries : this.maxRetries;
    const initialRetryDelayMs = request.initialRetryDelayMs !== undefined ? request.initialRetryDelayMs : this.initialRetryDelayMs;
    const maxRetryDelayMs = request.maxRetryDelayMs !== undefined ? request.maxRetryDelayMs : this.maxRetryDelayMs;
    const sleep = request.sleep || this.sleep;
    const random = request.random || this.random;

    const started = this.now();
    const overallDeadline = started + request.timeoutMs;
    const effectiveModel = normalizeOpenRouterModel(request.model);

    for (let attempt = 0; ; attempt++) {
      if (request.signal?.aborted) {
        throw new OpenRouterTimeoutError('OpenRouter request was cancelled', 'request');
      }
      const remainingTimeoutMs = overallDeadline - this.now();
      if (remainingTimeoutMs <= 0) {
        const timeoutError = new OpenRouterTimeoutError(
          `OpenRouter request for model ${request.model} exceeded ${request.timeoutMs}ms`,
          'request',
        );
        if (request.jobId) {
          LiveStreamBus.getInstance().publishEvent({
            jobId: request.jobId,
            timestamp: new Date(this.now()).toISOString(),
            type: 'openrouter:metric',
            persona: request.persona || 'openrouter',
            data: {
              outcome: 'failed',
              failureClass: 'timeout',
              requestedModel: effectiveModel,
              provider: request.providerId || 'openrouter',
              latencyMs: this.now() - started,
              timeoutKind: 'request',
            },
          });
        }
        throw timeoutError;
      }

      try {
        return await this.executeSingleAttempt(request, remainingTimeoutMs, started, attempt, maxRetries);
      } catch (error: any) {
        if (request.signal?.aborted || (error instanceof OpenRouterTimeoutError && error.message.includes('cancelled'))) {
          throw error;
        }
        if (isTransientGatewayError(error) && attempt < maxRetries) {
          const delay = calculateFullJitterDelay(attempt, initialRetryDelayMs, maxRetryDelayMs, random);
          logger.warn(`OpenRouter transient failure, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})...`, {
            error: redactWorkerFailureLogTail(error.message),
          });
          await raceWithAbort(sleep(delay), request.signal);
          continue;
        }
        throw error;
      }
    }
  }

  private async executeSingleAttempt(
    request: OpenRouterRequest,
    attemptTimeoutMs: number,
    overallStarted: number,
    attempt: number,
    maxRetries: number,
  ): Promise<OpenRouterResponse> {
    const effectiveModel = normalizeOpenRouterModel(request.model);
    let generationId: string | null = null;
    const started = this.now();
    const startedAt = Date.now();
    const controller = new AbortController();
    // Keep transport cancellation separate from the signals used to race startup and active
    // readers. Stream inactivity is a transport cleanup event, not a request-deadline event.
    const requestAbortController = new AbortController();
    const streamAbortController = new AbortController();
    let requestDeadlineExpired = false;
    let callerCancelled = false;
    let streamTransportFailure = false;
    const onCallerAbort = () => {
      callerCancelled = true;
      const cancellation = new OpenRouterTimeoutError('OpenRouter request was cancelled', 'request');
      controller.abort(cancellation);
      requestAbortController.abort(cancellation);
      streamAbortController.abort(cancellation);
    };
    request.signal?.addEventListener('abort', onCallerAbort, { once: true });
    const timeout = setTimeout(() => {
      requestDeadlineExpired = true;
      const requestTimeout = new OpenRouterTimeoutError(
        `OpenRouter request for model ${request.model} exceeded ${request.timeoutMs}ms`,
        'request',
      );
      const totalTimeout = new OpenRouterTimeoutError(
        `OpenRouter streaming response exceeded total deadline of ${request.timeoutMs}ms`,
        'total',
      );
      controller.abort(requestTimeout);
      requestAbortController.abort(requestTimeout);
      streamAbortController.abort(totalTimeout);
    }, attemptTimeoutMs);

    try {
      let data: any;
      const isStreaming = request.stream ?? true;
      if (isStreaming) {
        if (callerCancelled || request.signal?.aborted) {
          throw new OpenRouterTimeoutError('OpenRouter request was cancelled', 'request');
        }
        const headers: Record<string, string> = {
          'authorization': `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
          'accept': 'text/event-stream',
          'user-agent': 'speakeasy-sdk/typescript 1.2.80 2.914.0 1.0.0 @openrouter/sdk',
          'x-openrouter-metadata': 'enabled',
        };
        if (request.metadata && typeof request.metadata === 'object') {
          for (const [k, v] of Object.entries(request.metadata)) {
            if (typeof v === 'string') headers[k] = v;
          }
        }
        applyGatewayPolicyHeaders(headers);
        const body = JSON.stringify(buildOpenRouterChatRequest({ ...request, stream: true }));
        let response = await raceWithAbort(
          this.fetchImplementation(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers,
            body,
            signal: controller.signal,
          }),
          requestAbortController.signal,
          (lateResponse) => cancelLateBody(lateResponse, 'request deadline'),
        );

        if (!(response instanceof Response)) {
          const compatibilityResponse: any = response as any;
          let compatibilityBody = compatibilityResponse?.body || '';
          let isJsonBody = false;
          if (!compatibilityBody && typeof compatibilityResponse?.json === 'function') {
            try {
              compatibilityBody = JSON.stringify(await raceWithAbort(
                Promise.resolve(compatibilityResponse.json()),
                requestAbortController.signal,
                () => cancelLateBody(compatibilityResponse, 'request deadline'),
              ));
              isJsonBody = true;
            } catch (error) {
              if (error instanceof OpenRouterTimeoutError) throw error;
              // Fall through to text for malformed/non-JSON doubles.
            }
          }
          if (!compatibilityBody && typeof compatibilityResponse?.text === 'function') {
            compatibilityBody = await raceWithAbort(
              Promise.resolve(compatibilityResponse.text()),
              requestAbortController.signal,
              () => cancelLateBody(compatibilityResponse, 'request deadline'),
            );
          }
          if (!isJsonBody && typeof compatibilityBody === 'string' && /^\s*[\{\[]/.test(compatibilityBody)) {
            isJsonBody = true;
          }
          const defaultContentType = isJsonBody ? 'application/json' : 'text/event-stream';
          const headers = compatibilityResponse?.headers
            ? new Headers(compatibilityResponse.headers)
            : new Headers({ 'content-type': defaultContentType });
          if (!headers.has('content-type')) {
            headers.set('content-type', defaultContentType);
          }
          response = new Response(compatibilityBody, {
            status: Number(compatibilityResponse?.status) || 200,
            statusText: compatibilityResponse?.statusText,
            headers,
          });
        }

        const responseGenerationId = response.headers?.get?.('x-generation-id');
        if (responseGenerationId) generationId = responseGenerationId;

        if (!response.ok) {
          let errorBody = '';
          try {
            errorBody = await readResponseText(response, requestAbortController.signal);
          } catch (error) {
            if (error instanceof OpenRouterTimeoutError) throw error;
          }
          const status = response.status;
          let parsedMsg = errorBody;
          let parsedBody: unknown = null;
          try {
            const parsed = JSON.parse(errorBody);
            parsedBody = parsed;
            parsedMsg = parsed?.error?.message || parsed?.message || errorBody;
          } catch (_) {}
          throw new OpenRouterResponseError(
            `${upstreamLabel(this.baseUrl, parsedBody)} HTTP ${status}: ${parsedMsg}`,
            status,
          );
        }

        const contentType = response.headers?.get?.('content-type') || '';
        if (contentType.includes('application/json')) {
          let text = '';
          try {
            text = await readResponseText(response, requestAbortController.signal);
          } catch (error) {
            if (error instanceof OpenRouterTimeoutError) throw error;
          }
          try {
            data = JSON.parse(text);
          } catch (err: any) {
            throw new OpenRouterResponseError(`OpenRouter returned malformed response: ${err.message}`);
          }
        } else {
          data = await readStreamingResponse(response, effectiveModel, {
            ttftTimeoutMs: request.ttftTimeoutMs,
            inactivityTimeoutMs: request.inactivityTimeoutMs ?? Math.min(45_000, request.timeoutMs),
            totalTimeoutMs: Math.max(1, request.timeoutMs - (Date.now() - startedAt)),
            signal: streamAbortController.signal,
            onTotalTimeout: () => {
              requestDeadlineExpired = true;
              const totalTimeout = new OpenRouterTimeoutError(
                `OpenRouter streaming response exceeded total deadline of ${request.timeoutMs}ms`,
                'total',
              );
              controller.abort(totalTimeout);
              requestAbortController.abort(totalTimeout);
              streamAbortController.abort(totalTimeout);
            },
            onCancel: (reason) => {
              if (reason === 'stream error') streamTransportFailure = true;
              controller.abort();
            },
            onFirstToken: request.onFirstToken,
          });
        }
      } else {
        const sdkClient = await raceWithAbort(
          createOpenRouterSdkClient({
            baseUrl: this.baseUrl,
            apiKey: this.apiKey,
            fetchImplementation: this.fetchImplementation,
            onGenerationId: (value) => { generationId = value; },
          }),
          requestAbortController.signal,
        );
        try {
          if (callerCancelled || request.signal?.aborted) {
            throw new OpenRouterTimeoutError('OpenRouter request was cancelled', 'request');
          }
          const sdkResponse = await raceWithAbort(
            sdkClient.chat.send(
              {
                xOpenRouterMetadata: 'enabled',
                chatRequest: buildOpenRouterSdkChatRequest(request),
              },
              {
                signal: controller.signal,
                retries: { strategy: 'none' },
              },
            ),
            requestAbortController.signal,
            (lateResponse) => cancelLateBody(lateResponse, 'request deadline'),
          );
          if (sdkResponse && typeof (sdkResponse as any).getReader === 'function') {
            data = await readSdkStreamingResponse(sdkResponse as ReadableStream<unknown>, effectiveModel, {
              ttftTimeoutMs: request.ttftTimeoutMs,
              inactivityTimeoutMs: request.inactivityTimeoutMs ?? Math.min(45_000, request.timeoutMs),
              totalTimeoutMs: Math.max(1, request.timeoutMs - (Date.now() - startedAt)),
              signal: streamAbortController.signal,
              onTotalTimeout: () => {
                requestDeadlineExpired = true;
                const totalTimeout = new OpenRouterTimeoutError(
                  `OpenRouter streaming response exceeded total deadline of ${request.timeoutMs}ms`,
                  'total',
                );
                controller.abort(totalTimeout);
                requestAbortController.abort(totalTimeout);
                streamAbortController.abort(totalTimeout);
              },
              onCancel: (reason) => {
                if (reason === 'stream error') streamTransportFailure = true;
                controller.abort();
              },
              onFirstToken: request.onFirstToken,
            });
          } else {
            data = normalizeSdkResponse(sdkResponse, sdkClient.getRawUsage?.());
          }
        } catch (sdkError: any) {
          if (isSdkResponseValidationFailure(sdkError)) {
            const rawJson = await sdkClient.getRawJson?.();
            if (rawJson && typeof rawJson === 'object' && Array.isArray(rawJson.choices) && rawJson.choices.length > 0) {
              data = rawJson;
            } else {
              throw sdkError;
            }
          } else {
            throw sdkError;
          }
        }
      }
      const rawChoice = data?.choices?.[0];
      const rawMsg = rawChoice?.message;
      const finishReason = rawChoice?.finishReason ?? rawChoice?.finish_reason ?? null;
      let extractedContent = '';
      if (typeof rawMsg?.content === 'string' && rawMsg.content.trim() !== '') {
        extractedContent = rawMsg.content;
      } else if (Array.isArray(rawMsg?.content)) {
        extractedContent = rawMsg.content.map((part: any) => (typeof part === 'string' ? part : part?.text || '')).join('').trim();
      }
      const rawReasoning = (typeof rawMsg?.reasoning === 'string' && rawMsg.reasoning.trim() !== '')
        ? rawMsg.reasoning
        : (typeof rawMsg?.reasoning_content === 'string' && rawMsg.reasoning_content.trim() !== '')
          ? rawMsg.reasoning_content
          : (typeof rawMsg?.reasoningContent === 'string' && rawMsg.reasoningContent.trim() !== '')
            ? rawMsg.reasoningContent
            : (typeof rawMsg?.reasoning_details === 'string' && rawMsg.reasoning_details.trim() !== '')
              ? rawMsg.reasoning_details
              : (typeof rawMsg?.reasoningDetails === 'string' && rawMsg.reasoningDetails.trim() !== '')
                ? rawMsg.reasoningDetails
                : reasoningText(rawMsg?.reasoning ?? rawMsg?.reasoning_content ?? rawMsg?.reasoningContent ?? rawMsg?.reasoning_details ?? rawMsg?.reasoningDetails).trim();
      const content = extractedContent !== '' ? extractedContent : rawReasoning;
      if (typeof content !== 'string' || content.trim() === '') {
        // Tag the error so panel retry/failover can classify it as transient.
        throw new OpenRouterResponseError('OpenRouter returned empty completion content', 502);
      }
      // A reasoning-shaped model (e.g. GLM served via an OpenAI-compatible endpoint) can put its
      // entire answer in `reasoning`/`reasoning_content` and leave `content` null or empty --
      // that is a legitimate completion and `content` above already falls back to it. But when
      // the provider also reports `finish_reason: "length"` alongside an empty `content`, the
      // generation was cut off by the token budget before it ever reached an answer: `reasoning`
      // is an unfinished scratchpad, not a verdict. Publishing that as the review's output would
      // be worse than failing loudly, so this is treated as a real, retryable failure instead of
      // an accepted (if truncated) completion -- deliberately narrower than "content" being
      // spooled, since a `finish_reason: "length"` on a *populated* content field is a separate,
      // pre-existing, out-of-scope truncation shape this fix does not change.
      if (extractedContent === '' && finishReason === 'length') {
        // Tag the error so panel retry/failover can classify it as transient (502), same as the
        // empty-completion signature above -- but with a distinct message so it takes the
        // generic retry budget rather than the empty-completion-specific one: real (if
        // truncated) reasoning was produced here, so there is no signal that a different
        // backend is needed the way a totally blank completion suggests.
        throw new OpenRouterResponseError(
          'OpenRouter returned truncated reasoning with no completion content (finish_reason=length)',
          502,
        );
      }

      const rawUsage = data.usage;
      const cached = resolveCachedTokens(rawUsage);
      const usage: TokensUsed | null = rawUsage && [rawUsage.prompt_tokens, rawUsage.completion_tokens, rawUsage.total_tokens].every(Number.isFinite)
        ? {
            prompt: Number(rawUsage.prompt_tokens),
            completion: Number(rawUsage.completion_tokens),
            total: Number(rawUsage.total_tokens),
            ...(cached > 0 ? { cached } : {}),
            ...(rawUsage.cached_tokens !== undefined ? { cached_tokens: Number(rawUsage.cached_tokens) } : {}),
            ...(rawUsage.cache_read_input_tokens !== undefined ? { cache_read_input_tokens: Number(rawUsage.cache_read_input_tokens) } : {}),
            ...(rawUsage.prompt_cache_hit_tokens !== undefined ? { prompt_cache_hit_tokens: Number(rawUsage.prompt_cache_hit_tokens) } : {}),
          }
        : null;
      const rawCost = Number(
        data.cost
        ?? data.cost_usd
        ?? rawUsage?.cost
        ?? rawUsage?.total_cost
        ?? rawUsage?.cost_details?.upstream_inference_cost,
      );
      const costUSD = Number.isFinite(rawCost) && rawCost > 0
        ? rawCost
        : usage ? estimateTokenCost(effectiveModel, usage.prompt, usage.completion) : null;
      const model = String(data.model || effectiveModel);

      // A transport that resolves after cancellation must never be allowed to
      // publish a successful metric or return a successful review response.
      if (callerCancelled || request.signal?.aborted) {
        throw new OpenRouterTimeoutError('OpenRouter request was cancelled', 'request');
      }

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
            latencyMs: this.now() - overallStarted,
            promptTokens: usage?.prompt || 0,
            completionTokens: usage?.completion || 0,
            totalTokens: usage?.total || 0,
            costUSD,
            ...(generationId ? { generationId } : {}),
            ...(data?.openrouter_metadata ? { routerMetadata: data.openrouter_metadata } : {}),
          },
        });
      }

      return { model, content, usage, costUSD, raw: data };
    } catch (error: any) {
      let classifiedError: Error;
      if (callerCancelled || request.signal?.aborted) {
        classifiedError = new OpenRouterTimeoutError('OpenRouter request was cancelled', 'request');
      } else if (error instanceof OpenRouterResponseError
          || error instanceof OpenRouterConnectionError
          || error instanceof UpstreamCapacityRejectionError
          || error instanceof OpenRouterTimeoutError) {
        classifiedError = error;
      } else {
        const status = sdkErrorStatus(error);
        const sdkMessage = sdkErrorMessage(error);
        if (status && status >= 400) {
          classifiedError = new OpenRouterResponseError(`${upstreamLabel(this.baseUrl, error)} HTTP ${status}: ${sdkMessage}`, status);
        } else if (request.stream !== false && /malformed json|response validation failed/i.test(sdkMessage)) {
          classifiedError = new OpenRouterResponseError(`OpenRouter returned malformed response: ${sdkMessage}`);
        } else if (error?.name === 'ResponseValidationError') {
          classifiedError = new OpenRouterResponseError(`OpenRouter returned malformed response: ${sdkMessage}`);
        } else if (requestDeadlineExpired
          || requestAbortController.signal.aborted
          || streamAbortController.signal.aborted) {
          classifiedError = new OpenRouterTimeoutError(`OpenRouter request for model ${request.model} exceeded ${request.timeoutMs}ms`, 'request');
        } else {
          logger.error('OpenRouter SDK network failure or timeout', { error: redactWorkerFailureLogTail(sdkMessage), model: request.model });
          classifiedError = new OpenRouterConnectionError(`OpenRouter SDK connection failure for model ${request.model}: ${sdkMessage}`);
        }
      }

      const willRetry = isTransientGatewayError(classifiedError) && attempt < maxRetries && !callerCancelled && !request.signal?.aborted;
      if (!willRetry && request.jobId) {
        const responseStatus = classifiedError instanceof OpenRouterResponseError
          ? classifiedError.status
          : undefined;
        const failureClass = classifiedError instanceof OpenRouterTimeoutError
          ? 'timeout'
          : responseStatus === 429
            ? 'rate_limit'
            : responseStatus !== undefined && responseStatus >= 500
              ? 'provider_5xx'
              : classifiedError instanceof UpstreamCapacityRejectionError
                ? 'provider_capacity'
                : classifiedError instanceof OpenRouterConnectionError
                  ? 'connection'
                  : 'response';
        LiveStreamBus.getInstance().publishEvent({
          jobId: request.jobId,
          timestamp: new Date(this.now()).toISOString(),
          type: 'openrouter:metric',
          persona: request.persona || 'openrouter',
          data: {
            outcome: 'failed',
            failureClass,
            requestedModel: effectiveModel,
            provider: request.providerId || 'openrouter',
            latencyMs: this.now() - overallStarted,
            ...(responseStatus !== undefined ? { responseStatus } : {}),
            ...(classifiedError instanceof OpenRouterTimeoutError ? { timeoutKind: classifiedError.kind } : {}),
            ...(generationId ? { generationId } : {}),
          },
        });
      }
      throw classifiedError;
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener('abort', onCallerAbort);
      if (!controller.signal.aborted) {
        controller.abort();
      }
      if (!requestAbortController.signal.aborted) requestAbortController.abort();
      if (!streamAbortController.signal.aborted) streamAbortController.abort();
    }
  }
}
