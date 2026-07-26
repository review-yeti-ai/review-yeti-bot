import { LiveStreamBus } from '../live/liveStreamBus';

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
    throw new Error(`OmniRoute silently substituted model ${responseModel} for ${requestedRoute}`);
  }
  if (headerModel && headerModel !== requestedRoute && headerModel !== requestedModel) {
    throw new Error(`OmniRoute silently substituted model ${headerModel} for ${requestedRoute}`);
  }
  if (responseModel !== requestedRoute && !headerProvider && requestedProvider) {
    throw new Error(`OmniRoute did not provide provider provenance for ${requestedRoute}`);
  }
  if (headerProvider && requestedProvider && OMNIROUTE_PROVIDER_PROVENANCE[requestedProvider] &&
      !OMNIROUTE_PROVIDER_PROVENANCE[requestedProvider].includes(headerProvider)) {
    throw new Error(`OmniRoute silently substituted provider ${headerProvider} for ${requestedProvider}`);
  }
}

export class OmniRouteClient {
  private readonly baseUrl: string;
  private readonly accessToken?: string;

  constructor(config: OmniRouteClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.accessToken = config.accessToken;
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

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: request.model, messages: request.messages, stream: false }),
      signal: AbortSignal.timeout(request.timeoutMs),
    });
    const data = await response.json().catch(() => ({})) as any;
    if (!response.ok) {
      throw new Error(`OmniRoute HTTP ${response.status}: ${JSON.stringify(data)}`);
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
    const authoritativeCost = data.cost_usd ?? data.accounting?.cost_usd;
    const headerCostValue = getHeader(response?.headers, 'x-omniroute-response-cost');
    const headerCost = headerCostValue === null ? Number.NaN : Number(headerCostValue);
    const costUSD = Number.isFinite(authoritativeCost)
      ? Number(authoritativeCost)
      : Number.isFinite(headerCost) && headerCost >= 0
        ? headerCost
        : null;

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
