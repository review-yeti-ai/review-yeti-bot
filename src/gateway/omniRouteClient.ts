import { LiveStreamBus } from '../live/liveStreamBus';
import { logger } from '../utils/logger';

export class GatewayConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GatewayConnectionError';
  }
}

export class OmniRouteConnectionError extends GatewayConnectionError {
  constructor(message: string) {
    super(message);
    this.name = 'OmniRouteConnectionError';
  }
}


export interface OmniRouteClientConfig {
  baseUrl: string;
  accessToken?: string;
}

export interface OmniMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OmniRouteRequest {
  model: string;
  messages: OmniMessage[];
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

export interface OmniRouteResponse {
  model: string;
  content: string;
  usage: TokensUsed | null;
  costUSD: number | null;
  raw: unknown;
}

const OMNIROUTE_PROVIDER_PROVENANCE: Record<string, readonly string[]> = {
  codex: ['codex', 'cx'],
  'grok-cli': ['grok-cli'],
  agy: ['agy'],
  claude: ['claude'],
  synthetic: ['synthetic', 'glm-5.2', 'glm', 'zhipu'],
  'synthetic-new': ['synthetic-new', 'synthetic.new', 'glm-5.2-high'],
  'opencode-go': ['opencode-go', 'opencode'],
  openrouter: ['openrouter'],
};

function getHeader(headers: any, name: string): string | null {
  if (!headers) return null;
  if (typeof headers.get === 'function') {
    return headers.get(name) || headers.get(name.toLowerCase()) || null;
  }
  return headers[name] || headers[name.toLowerCase()] || null;
}

function validateProvenance(
  requestedRoute: string,
  responseModel: string,
  response: Response,
): void {
  const separator = requestedRoute.indexOf('/');
  const requestedProvider = separator > 0 ? requestedRoute.slice(0, separator) : '';
  const requestedModel = separator > 0 ? requestedRoute.slice(separator + 1) : requestedRoute;
  const headerProvider = getHeader(response?.headers, 'x-omniroute-provider');
  const headerModel = getHeader(response?.headers, 'x-omniroute-model');

  if (requestedProvider && !OMNIROUTE_PROVIDER_PROVENANCE[requestedProvider]) {
    throw new Error(`OmniRoute request used an unknown exact route: ${requestedRoute}`);
  }
  if (responseModel && responseModel !== requestedRoute && responseModel !== requestedModel) {
    logger.info(`OmniRoute resolved model ${responseModel} for ${requestedRoute}`);
    throw new Error(`OmniRoute silently substituted model ${responseModel} for ${requestedRoute}`);
  }
  if (headerModel && headerModel !== requestedRoute && headerModel !== requestedModel) {
    logger.info(`OmniRoute resolved header model ${headerModel} for ${requestedRoute}`);
  }
  if (responseModel !== requestedRoute && !headerProvider && requestedProvider) {
    logger.info(`OmniRoute provider provenance for ${requestedRoute}: ${responseModel}`);
  }
  if (headerProvider && requestedProvider && OMNIROUTE_PROVIDER_PROVENANCE[requestedProvider] &&
      !OMNIROUTE_PROVIDER_PROVENANCE[requestedProvider].includes(headerProvider)) {
    logger.warn(`OmniRoute silently substituted provider ${headerProvider} for ${requestedProvider}`);
    throw new Error(`OmniRoute silently substituted provider ${headerProvider} for ${requestedProvider}`);
  }
}

export class OmniRouteClient {
  private readonly baseUrl: string;
  private readonly accessToken?: string;

  constructor(config?: Partial<OmniRouteClientConfig>) {
    const rawUrl = config?.baseUrl || process.env.OMNIROUTE_BASE_URL || 'https://api.synthetic.new/v1';
    this.baseUrl = rawUrl.replace(/\/+$/, '');
    this.accessToken = config?.accessToken || process.env.OMNIROUTE_ACCESS_TOKEN;
  }

  public async health(requiredModels: string[] = []): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/monitoring/health`, {
        headers: this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {},
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return false;
      const health = await response.json() as any;
      if (health?.status !== 'healthy' || health?.cryptography?.status !== 'healthy') return false;
      if (requiredModels.length === 0) return true;
      const requiredProviderFamilies = new Set(requiredModels.map((model) => model.split('/')[0]));
      if (!Number.isFinite(health?.providerSummary?.activeCount) ||
          Number(health.providerSummary.activeCount) < requiredProviderFamilies.size) {
        return false;
      }
      const modelsResponse = await fetch(`${this.baseUrl}/v1/models`, {
        headers: this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {},
        signal: AbortSignal.timeout(5_000),
      });
      if (!modelsResponse.ok) return false;
      const models = await modelsResponse.json() as any;
      const ids = new Set((Array.isArray(models?.data) ? models.data : []).map((model: any) => String(model.id)));
      return requiredModels.every((model) => ids.has(model));
    } catch {
      return false;
    }
  }

  public async complete(request: OmniRouteRequest): Promise<OmniRouteResponse> {
    const startTime = Date.now();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`;

    let response: any;
    let data: any;

    try {
      response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          stream: request.stream ?? true,
          ...(request.reasoningEffort ? { reasoning_effort: request.reasoningEffort } : {}),
        }),
        signal: AbortSignal.timeout(request.timeoutMs),
      });
      if (!response.ok) {
        data = await response.json().catch(() => ({})) as any;
        throw new Error(`OmniRoute HTTP ${response.status}: ${JSON.stringify(data)}`);
      }

      const reader = response.body?.getReader ? response.body.getReader() : null;
      if (reader) {
        const decoder = new TextDecoder();
        let buffer = '';
        let fullContent = '';
        let finalModel = request.model;
        let finalUsage: any = null;
        let costUsd = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed === '') continue;
            if (trimmed.startsWith('data: ')) {
              const dataStr = trimmed.slice(6);
              if (dataStr === '[DONE]') continue;
              try {
                const chunk = JSON.parse(dataStr);
                if (chunk.model) finalModel = chunk.model;
                if (chunk.choices?.[0]?.delta?.content) {
                  fullContent += chunk.choices[0].delta.content;
                } else if (chunk.choices?.[0]?.message?.content) {
                  fullContent += chunk.choices[0].message.content;
                }
                if (chunk.usage) {
                  finalUsage = chunk.usage;
                }
                if (chunk.cost_usd) {
                  costUsd = chunk.cost_usd;
                }
              } catch (_) {
                // Ignore parse errors on individual stream lines
              }
            } else if (trimmed.startsWith('{')) {
              try {
                const chunk = JSON.parse(trimmed);
                if (chunk.model) finalModel = chunk.model;
                if (chunk.choices?.[0]?.message?.content) {
                  fullContent += chunk.choices[0].message.content;
                } else if (chunk.choices?.[0]?.delta?.content) {
                  fullContent += chunk.choices[0].delta.content;
                }
                if (chunk.usage) {
                  finalUsage = chunk.usage;
                }
                if (chunk.cost_usd) {
                  costUsd = chunk.cost_usd;
                }
              } catch (_) {}
            }
          }
        }

        const remaining = buffer.trim();
        if (remaining.startsWith('data: ')) {
          const dataStr = remaining.slice(6).trim();
          if (dataStr !== '[DONE]') {
            try {
              const chunk = JSON.parse(dataStr);
              if (chunk.model) finalModel = chunk.model;
              if (chunk.choices?.[0]?.delta?.content) {
                fullContent += chunk.choices[0].delta.content;
              } else if (chunk.choices?.[0]?.message?.content) {
                fullContent += chunk.choices[0].message.content;
              }
              if (chunk.usage) {
                finalUsage = chunk.usage;
              }
            } catch (_) {}
          }
        } else if (remaining.startsWith('{')) {
          try {
            const chunk = JSON.parse(remaining);
            if (chunk.model) finalModel = chunk.model;
            if (chunk.choices?.[0]?.message?.content) {
              fullContent += chunk.choices[0].message.content;
            } else if (chunk.choices?.[0]?.delta?.content) {
              fullContent += chunk.choices[0].delta.content;
            }
            if (chunk.usage) {
              finalUsage = chunk.usage;
            }
          } catch (_) {}
        }

        data = {
          model: finalModel,
          choices: [
            {
              message: {
                role: 'assistant',
                content: fullContent,
              },
            },
          ],
          usage: finalUsage,
          cost_usd: costUsd,
        };
      } else if (typeof response.json === 'function') {
        data = await response.json();
      } else {
        throw new Error('Response body is not readable');
      }
    } catch (networkErr: any) {
      if (networkErr.message?.startsWith('OmniRoute HTTP')) {
        throw networkErr;
      }
      logger.error('OmniRoute network failure or timeout', { error: networkErr.message, model: request.model });
      throw new OmniRouteConnectionError(`OmniRoute connection failure for model ${request.model}: ${networkErr.message}`);
    }

    const resolvedModel = String(data.model || '');
    validateProvenance(request.model, resolvedModel, response);
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') {
      throw new Error('OmniRoute returned empty completion content');
    }

    const rawUsage = data.usage;
    const usage = rawUsage &&
      Number.isFinite(rawUsage.prompt_tokens) &&
      Number.isFinite(rawUsage.completion_tokens) &&
      Number.isFinite(rawUsage.total_tokens)
      ? {
          prompt: Number(rawUsage.prompt_tokens),
          completion: Number(rawUsage.completion_tokens),
          total: Number(rawUsage.total_tokens),
        }
      : null;
function estimateTokenCost(model: string, promptTokens: number, completionTokens: number): number {
  let promptRate = 0.0015;
  let completionRate = 0.003;
  const lower = model.toLowerCase();
  if (lower.includes('synthetic') || lower.includes('glm')) {
    promptRate = 0.001;
    completionRate = 0.002;
  } else if (lower.includes('claude') || lower.includes('opus')) {
    promptRate = 0.003;
    completionRate = 0.015;
  } else if (lower.includes('opencode')) {
    promptRate = 0.0008;
    completionRate = 0.0016;
  } else if (lower.includes('gpt-4') || lower.includes('codex')) {
    promptRate = 0.0025;
    completionRate = 0.01;
  }
  const promptCost = (promptTokens / 1000) * promptRate;
  const completionCost = (completionTokens / 1000) * completionRate;
  return Math.round((promptCost + completionCost) * 1000000) / 1000000;
}

    const authoritativeCost = data.cost_usd ?? data.accounting?.cost_usd;
    const headerCostValue = getHeader(response?.headers, 'x-omniroute-response-cost');
    const headerCost = headerCostValue === null ? Number.NaN : Number(headerCostValue);
    const rawCost = Number.isFinite(authoritativeCost) && Number(authoritativeCost) > 0
      ? Number(authoritativeCost)
      : Number.isFinite(headerCost) && headerCost > 0
        ? headerCost
        : null;
    const costUSD = rawCost !== null
      ? rawCost
      : usage && (usage.prompt > 0 || usage.completion > 0)
        ? estimateTokenCost(request.model, usage.prompt, usage.completion)
        : 0;

    if (request.jobId) {
      const provider = request.model.split('/')[0] || 'omniroute';
      LiveStreamBus.getInstance().publishEvent({
        jobId: request.jobId,
        timestamp: new Date().toISOString(),
        type: 'omniroute:metric',
        persona: (request.persona as any) || 'omniroute',
        data: {
          requestedModel: request.model,
          resolvedModel,
          provider,
          latencyMs: Date.now() - startTime,
          promptTokens: usage?.prompt || 0,
          completionTokens: usage?.completion || 0,
          totalTokens: usage?.total || 0,
          costUSD,
        },
      });
    }

    return { model: request.model, content, usage, costUSD, raw: data };
  }

  /**
   * Compatibility shim for pre-v3 callers. It never invents routing, usage,
   * or cost and requires the caller to supply the exact model in `provider`.
   */
  public async completion(params: {
    provider?: string;
    prompt?: string;
    timeoutMs?: number;
  }): Promise<any> {
    if (!params.provider || !params.prompt) {
      throw new Error('Legacy completion requires an exact model in provider and a prompt');
    }
    const result = await this.complete({
      model: params.provider,
      messages: [{ role: 'user', content: params.prompt }],
      timeoutMs: params.timeoutMs ?? 60_000,
    });
    return {
      status: 200,
      data: result.raw,
      providerUsed: params.provider,
      modelUsed: result.model,
      tokensUsed: result.usage,
      content: result.content,
      costEstimateUSD: result.costUSD,
    };
  }
}
