export interface OmniRouteClientConfig {
  baseUrl: string;
  accessToken?: string;
  refreshToken?: string;
  fallbackProviders?: string[];
}

export interface ChatCompletionRequest {
  provider?: string;
  persona?: string;
  effortLevel?: 'low' | 'medium' | 'high' | 'reasoning';
  prompt?: string;
}

export interface TokensUsed {
  prompt: number;
  completion: number;
  total: number;
}

export interface ChatCompletionResponse {
  providerUsed: string;
  modelUsed: string;
  tokensUsed: TokensUsed;
  reasoningTrace?: string;
  content?: string;
  status: number;
  data: any;
}

export class OmniRouteClient {
  private baseUrl: string;
  private accessToken: string;
  private refreshTokenValue: string;
  private fallbackProviders: string[];

  constructor(config: OmniRouteClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.accessToken = config.accessToken || 'valid-access-token-123';
    this.refreshTokenValue = config.refreshToken || 'valid-refresh-token';
    this.fallbackProviders = config.fallbackProviders || ['anthropic', 'google'];
  }

  public getAccessToken(): string {
    return this.accessToken;
  }

  public setAccessToken(token: string): void {
    this.accessToken = token;
  }

  public async refreshOAuthToken(): Promise<{ access_token: string; token_type: string; expires_in: number }> {
    const res = await fetch(`${this.baseUrl}/v1/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: this.refreshTokenValue,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Token refresh failed with status ${res.status}: ${JSON.stringify(err)}`);
    }

    const data = (await res.json()) as any;
    if (data.access_token) {
      this.accessToken = data.access_token;
    }
    return data;
  }

  public async completion(
    params: ChatCompletionRequest,
    autoRetry: boolean = true
  ): Promise<ChatCompletionResponse> {
    const makeRequest = async (token: string, providerOverride?: string) => {
      const bodyPayload = {
        ...params,
        ...(providerOverride ? { provider: providerOverride } : {}),
      };

      const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(bodyPayload),
      });

      const data = (await res.json().catch(() => ({}))) as any;
      return { status: res.status, data };
    };

    let { status, data } = await makeRequest(this.accessToken);

    // OAuth 401 token refresh retry
    if (status === 401 && data?.error?.code === 'token_expired' && autoRetry) {
      const tokenData = await this.refreshOAuthToken();
      const retryResult = await makeRequest(tokenData.access_token);
      status = retryResult.status;
      data = retryResult.data;
    }

    // 5xx Failover handling
    if (status >= 500 && autoRetry && this.fallbackProviders.length > 0) {
      for (const fallbackProvider of this.fallbackProviders) {
        if (fallbackProvider !== params.provider) {
          const fallbackResult = await makeRequest(this.accessToken, fallbackProvider);
          if (fallbackResult.status < 500) {
            status = fallbackResult.status;
            data = fallbackResult.data;
            break;
          }
        }
      }
    }

    return {
      status,
      data,
      providerUsed: data?.providerUsed,
      modelUsed: data?.modelUsed,
      tokensUsed: data?.tokensUsed,
      reasoningTrace: data?.reasoningTrace,
      content: data?.content,
    };
  }

  public async configureAdmin(config: any): Promise<any> {
    const res = await fetch(`${this.baseUrl}/__admin/configure`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    return res.json();
  }

  public async resetAdmin(): Promise<any> {
    const res = await fetch(`${this.baseUrl}/__admin/reset`, {
      method: 'POST',
    });
    return res.json();
  }
}
