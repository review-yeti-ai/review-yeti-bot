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
export declare class OmniRouteClient {
    private baseUrl;
    private accessToken;
    private refreshTokenValue;
    private fallbackProviders;
    constructor(config: OmniRouteClientConfig);
    getAccessToken(): string;
    setAccessToken(token: string): void;
    refreshOAuthToken(): Promise<{
        access_token: string;
        token_type: string;
        expires_in: number;
    }>;
    completion(params: ChatCompletionRequest, autoRetry?: boolean): Promise<ChatCompletionResponse>;
    configureAdmin(config: any): Promise<any>;
    resetAdmin(): Promise<any>;
}
