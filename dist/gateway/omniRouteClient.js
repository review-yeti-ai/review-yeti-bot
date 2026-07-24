"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OmniRouteClient = void 0;
class OmniRouteClient {
    baseUrl;
    accessToken;
    refreshTokenValue;
    fallbackProviders;
    constructor(config) {
        this.baseUrl = config.baseUrl.replace(/\/+$/, '');
        this.accessToken = config.accessToken || 'valid-access-token-123';
        this.refreshTokenValue = config.refreshToken || 'valid-refresh-token';
        this.fallbackProviders = config.fallbackProviders || ['anthropic', 'google'];
    }
    getAccessToken() {
        return this.accessToken;
    }
    setAccessToken(token) {
        this.accessToken = token;
    }
    async refreshOAuthToken() {
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
        const data = (await res.json());
        if (data.access_token) {
            this.accessToken = data.access_token;
        }
        return data;
    }
    async completion(params, autoRetry = true) {
        const makeRequest = async (token, providerOverride) => {
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
            const data = (await res.json().catch(() => ({})));
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
    async configureAdmin(config) {
        const res = await fetch(`${this.baseUrl}/__admin/configure`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config),
        });
        return res.json();
    }
    async resetAdmin() {
        const res = await fetch(`${this.baseUrl}/__admin/reset`, {
            method: 'POST',
        });
        return res.json();
    }
}
exports.OmniRouteClient = OmniRouteClient;
//# sourceMappingURL=omniRouteClient.js.map