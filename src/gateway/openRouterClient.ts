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

function estimateTokenCost(model: string, promptTokens: number, completionTokens: number): number {
  let promptRate = 0.0015;
  let completionRate = 0.003;
  const lower = model.toLowerCase();
  if (lower.includes('claude') || lower.includes('opus')) {
    promptRate = 0.003;
    completionRate = 0.015;
  } else if (lower.includes('luna')) {
    promptRate = 0.002;
    completionRate = 0.006;
  } else if (lower.includes('gpt') || lower.includes('codex')) {
    promptRate = 0.0025;
    completionRate = 0.01;
  }
  return Math.round(((promptTokens / 1000) * promptRate + (completionTokens / 1000) * completionRate) * 1_000_000) / 1_000_000;
}

function collectChunk(data: any, state: { model: string; content: string; usage: any; cost: number }): void {
  if (typeof data?.model === 'string' && data.model) state.model = data.model;
  const choice = data?.choices?.[0];
  const content = choice?.delta?.content ?? choice?.message?.content;
  if (typeof content === 'string') state.content += content;
  if (data?.usage) state.usage = data.usage;
  if (Number.isFinite(Number(data?.cost))) state.cost = Number(data.cost);
  if (Number.isFinite(Number(data?.cost_usd))) state.cost = Number(data.cost_usd);
}

async function readStreamingResponse(response: Response, requestedModel: string): Promise<any> {
  const reader = response.body?.getReader();
  if (!reader) return response.json();

  const decoder = new TextDecoder();
  let buffer = '';
  const state = { model: requestedModel, content: '', usage: null as any, cost: 0 };

  const consume = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed === 'data: [DONE]') return;
    // SSE comment lines are keep-alives and are not JSON events.
    if (trimmed.startsWith(':')) return;
    const json = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
    if (!json || json === '[DONE]') return;
    try {
      collectChunk(JSON.parse(json), state);
    } catch {
      throw new OpenRouterResponseError('OpenRouter returned malformed streaming JSON');
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      lines.forEach(consume);
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer);
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }

  return {
    model: state.model,
    choices: [{ message: { role: 'assistant', content: state.content } }],
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

      const data = await readStreamingResponse(response, effectiveModel);
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
      if (error instanceof OpenRouterResponseError || error instanceof OpenRouterConnectionError) throw error;
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
