# Scope: Milestone 2 — OmniRoute Multi-LLM Router & Token Management

## Objectives
1. **OmniRoute Adapter** (`src/router/omniRouteAdapter.ts`):
   - Interfacing across active provider subscriptions (OpenAI, Anthropic, Gemini, DeepSeek, custom/usage-based providers).
   - Support for API key, usage-based, and extra-usage tier subscriptions.
   - Standardized `LLMRequest` and `LLMResponse` structures.
2. **Token Manager** (`src/router/tokenManager.ts`):
   - Automatic token refresh logic for OAuth/subscription tokens.
   - Encrypted/secure secret storage management (AES-256-GCM or secret store wrapper).
   - Token consumption metrics per request and per persona.
   - Dynamic effort scaling (`low`, `medium`, `high`, `reasoning`) influencing max tokens, temperature, and routing rules.
3. **Provider Pool & Failover Engine** (`src/router/providerPool.ts`):
   - Dynamic provider failover pool maintaining active providers and subscription priorities.
   - Health checks per provider (active/degraded/offline).
   - Circuit breaker handling rate limits (429) and server errors (5xx) with backoff/cooldown.
   - Load balancing strategies (round-robin, least-loaded, priority-fallback) across active subscriptions.
4. **App & Entry Point Integration**:
   - Integrate router initialization into `src/app.ts` and `src/index.ts`.
   - Provide status/health endpoints if applicable (`/health` or `/api/router/status`).
5. **Test Coverage**:
   - Unit tests: `tests/unit/omniRoute.test.ts`, `tests/unit/tokenManager.test.ts`.
   - Integration tests: `tests/integration/m2_router.test.ts`.
   - Ensure all existing unit/integration tests (`npm test`) and build (`npm run build`) pass cleanly.

## Interface Contracts
```typescript
export interface LLMRequest {
  prompt: string;
  systemPrompt?: string;
  persona: string;
  effortLevel: 'low' | 'medium' | 'high' | 'reasoning';
  temperature?: number;
  provider?: string;
  model?: string;
}

export interface LLMResponse {
  content: string;
  providerUsed: string;
  modelUsed: string;
  tokensUsed: { prompt: number; completion: number; total: number };
}
```

## Milestone Status
| Component | Scope | Status |
|---|---|:---:|
| OmniRoute Adapter | Multi-provider router interfacing | DONE |
| Token Manager | Refresh, encrypted secrets, metrics, effort scaling | DONE |
| Provider Pool & Failover | Circuit breaker, health check, load balancing | DONE |
| App Integration | Integration with src/index.ts & src/app.ts | DONE |
| Tests & Build | Unit/Integration tests & zero compilation errors | DONE |
