# Technical Analysis & Architecture Design: `src/router/tokenManager.ts`

**Author**: Explorer 2 (Milestone 2)  
**Target Path**: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/src/router/tokenManager.ts`  
**Date**: 2026-07-24  

---

## 1. Executive Summary

Milestone 2 introduces the **OmniRoute Multi-LLM Router & Token Management** layer to `ct-review-bot`. As part of this architecture, `src/router/tokenManager.ts` serves as the central manager for credentials, security, token lifecycle, metrics tracking, and LLM effort scaling.

This document provides a comprehensive analysis of existing project assets and presents the end-to-end design for `TokenManager`, covering four core pillars:
1. **Automatic Token Refresh Logic**: Async single-flight preemptive and reactive refresh for OAuth 2.0 and subscription-based tokens.
2. **Encrypted Secret Storage Management**: AES-256-GCM authenticated secret store using native Node.js `node:crypto` for sensitive keys and tokens.
3. **Token Consumption Metrics Tracking**: High-precision token accounting per request, per persona (`security`, `architecture`, `performance`, `quality`), and per provider/model.
4. **Dynamic Effort Scaling Logic**: Dynamic mapping of effort levels (`low`, `medium`, `high`, `reasoning`) to token budgets, temperatures, max output tokens, timeouts, and provider-specific reasoning parameters.

---

## 2. Codebase Inspection & Alignment

### 2.1 Dependencies & Environment
- **Node.js Version**: `>= 20.0.0` (specified in `package.json`). Native `node:crypto` provides full support for `aes-256-gcm` without third-party encryption dependencies.
- **Validation**: `zod` (`^3.23.8`) is available for validating incoming credential schemas and configuration payloads.
- **Existing Gateway**: `src/gateway/omniRouteClient.ts` currently manages simple OAuth token refresh against `/v1/oauth/token`. `TokenManager` will encapsulate and elevate token refresh logic into a reusable router component.
- **Existing Config & Schema**: `src/config/schema.ts` exports `PersonaEnum` (`security`, `architecture`, `performance`, `quality`) and `EffortLevelEnum` (`low`, `medium`, `high`, `reasoning`), which are directly utilized by `TokenManager`.
- **Existing Mock Infrastructure**: `tests/e2e/harness/mockOmniRouteServer.ts` simulates `/v1/oauth/token` (issuing 3600s tokens) and 401 `token_expired` error codes.

---

## 3. Pillar Architecture Designs

### 3.1 Automatic Token Refresh Logic (OAuth & Subscriptions)

#### Architectural Requirements
- **Preemptive Refresh**: Tokens expiring within a configurable window (default: 60 seconds) are automatically refreshed before issuing LLM requests.
- **Reactive 401 Refresh**: If an HTTP 401 response with code `token_expired` occurs, the manager forces an immediate token refresh and returns the new token for request retries.
- **Stampede Prevention (Single-Flight Lock)**: Concurrent requests encountering an expired token share a single active `Promise<OAuthTokenData>`. Only one network request is made to the refresh endpoint.

#### Data Model
```typescript
export interface OAuthTokenData {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string; // 'Bearer'
  expiresAt: number;  // Epoch timestamp in milliseconds
  scope?: string;
}

export interface TokenRefreshConfig {
  providerId: string;
  tokenUrl?: string; // e.g. 'http://127.0.0.1:9090/v1/oauth/token'
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  preemptiveRefreshWindowMs?: number; // default: 60,000ms (1 min)
  customRefreshHandler?: (refreshToken: string) => Promise<OAuthTokenData>;
}
```

#### Refresh Control Flow
```
[ getValidToken(providerId) ]
           │
           ▼
    Is Static API Key? ──YES──► Return Key
           │ NO
           ▼
   Token Expiring Soon? ──NO──► Return Cached Access Token
           │ YES (or Expired)
           ▼
 Is Refresh In-Flight? ──YES──► Await In-Flight Promise
           │ NO
           ▼
  Create In-Flight Promise & Mutex
           │
           ▼
  Execute OAuth / Custom Refresh
           │
           ▼
 Encrypt & Update Secret Store
           │
           ▼
  Clear In-Flight Mutex ──────► Return New Access Token
```

---

### 3.2 Encrypted Secret Storage Management (AES-256-GCM)

#### Architectural Requirements
- **Algorithm**: `aes-256-gcm` (authenticated symmetric encryption).
- **Master Key**: Derived from `process.env.CT_SECRET_MASTER_KEY` or hashed via `crypto.createHash('sha256')` to guarantee a 32-byte key. If no master key is supplied in environment, an in-memory 32-byte key is randomly generated on initialization.
- **IV & Auth Tag**: Unique random 12-byte IV (`crypto.randomBytes(12)`) and 16-byte Auth Tag generated for each encryption operation.
- **Serialization**: Supports exporting and importing encrypted secrets formatted as Hex strings (`{ iv, authTag, ciphertext, algorithm, updatedAt }`) for persistence or safe memory inspection.

#### Encrypted Payload Schema
```typescript
export interface EncryptedPayload {
  iv: string;         // Hex string (12 bytes)
  authTag: string;    // Hex string (16 bytes)
  ciphertext: string; // Hex string
  algorithm: 'aes-256-gcm';
  updatedAt: string;  // ISO timestamp
}
```

---

### 3.3 Token Consumption Metrics Tracking

#### Architectural Requirements
- **Request Granularity**: Records prompt tokens, completion tokens, reasoning tokens (if present), total tokens, duration (ms), persona, effort level, provider, and model for every LLM invocation.
- **Persona Analytics**: Computes rolling metrics per persona (`security`, `architecture`, `performance`, `quality`):
  - Total requests
  - Total prompt, completion, total tokens
  - Average tokens per request
  - Average request latency (ms)
- **Provider & Global Analytics**: Aggregates token usage across all providers (`openai`, `anthropic`, `google`, `deepseek`) to monitor API quotas and cost allocation.

#### Metric Structures
```typescript
export interface TokenUsageRecord {
  requestId: string;
  repoOwner?: string;
  repoName?: string;
  prNumber?: number;
  persona: Persona;
  effortLevel: EffortLevel;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens?: number;
  totalTokens: number;
  durationMs: number;
  timestamp: string;
}

export interface PersonaMetricsSummary {
  persona: Persona;
  totalRequests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  averageTokensPerRequest: number;
  averageDurationMs: number;
}

export interface GlobalMetricsSummary {
  totalRequests: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  byPersona: Record<Persona, PersonaMetricsSummary>;
  byProvider: Record<string, { totalRequests: number; totalTokens: number }>;
}
```

---

### 3.4 Dynamic Effort Scaling Logic

#### Architectural Requirements
- **Effort Matrix Mapping**: Translates abstract effort levels into quantitative request configuration parameters:

| Effort Level | Max Output Tokens | Prompt Budget Limit | Temperature | Reasoning Effort | Timeout (ms) | Typical Use Case |
|---|:---:|:---:|:---:|:---:|:---:|---|
| `low` | 1,000 | 4,000 | 0.10 | `none` | 15,000 | Quick formatting, triage, nit-checks |
| `medium` | 4,000 | 16,000 | 0.20 | `low` | 30,000 | Default PR hunk reviews |
| `high` | 8,000 | 32,000 | 0.30 | `medium` | 60,000 | Complex diffs, multi-file changes |
| `reasoning` | 16,000 | 64,000 | 0.50 | `high` | 120,000 | Deep security audits & architectural analysis |

- **Persona Default & Dynamic Overrides**:
  - `security` defaults to `high` effort if not explicitly set.
  - Diff size scaling: Diffs with line count `> 500` automatically scale effort up by +1 tier (e.g. `medium` -> `high`).
- **Provider-Specific Parameter Formatting**:
  - OpenAI format: `reasoning_effort: 'low' | 'medium' | 'high'`.
  - Anthropic format: `thinking: { type: 'enabled', budget_tokens: number }`.

---

## 4. Proposed `src/router/tokenManager.ts` Implementation Specification

Below is the complete, proposed TypeScript implementation code for `src/router/tokenManager.ts`.

```typescript
import crypto from 'node:crypto';
import { Persona, EffortLevel } from '../config/schema';
import { logger } from '../utils/logger';

// ==========================================
// 1. Interfaces & Types
// ==========================================

export interface EncryptedPayload {
  iv: string;
  authTag: string;
  ciphertext: string;
  algorithm: 'aes-256-gcm';
  updatedAt: string;
}

export interface OAuthTokenData {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  expiresAt: number; // Unix timestamp in ms
  scope?: string;
}

export interface TokenRefreshConfig {
  providerId: string;
  tokenUrl?: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  preemptiveRefreshWindowMs?: number;
  customRefreshHandler?: (refreshToken: string) => Promise<OAuthTokenData>;
}

export interface TokenUsageRecord {
  requestId: string;
  repoOwner?: string;
  repoName?: string;
  prNumber?: number;
  persona: Persona;
  effortLevel: EffortLevel;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens?: number;
  totalTokens: number;
  durationMs: number;
  timestamp: string;
}

export interface PersonaMetricsSummary {
  persona: Persona;
  totalRequests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  averageTokensPerRequest: number;
  averageDurationMs: number;
}

export interface GlobalMetricsSummary {
  totalRequests: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  byPersona: Record<Persona, PersonaMetricsSummary>;
  byProvider: Record<string, { totalRequests: number; totalTokens: number }>;
}

export interface EffortConfig {
  effortLevel: EffortLevel;
  maxOutputTokens: number;
  promptTokenBudget: number;
  temperature: number;
  reasoningEffort: 'none' | 'low' | 'medium' | 'high';
  timeoutMs: number;
  providerExtraParams: Record<string, any>;
}

// ==========================================
// 2. Encrypted Secret Store (AES-256-GCM)
// ==========================================

export class SecureSecretStore {
  private masterKey: Buffer;
  private store: Map<string, EncryptedPayload> = new Map();

  constructor(masterKeyHex?: string) {
    if (masterKeyHex) {
      this.masterKey = Buffer.from(masterKeyHex, 'hex');
      if (this.masterKey.length !== 32) {
        this.masterKey = crypto.createHash('sha256').update(masterKeyHex).digest();
      }
    } else if (process.env.CT_SECRET_MASTER_KEY) {
      const envKey = process.env.CT_SECRET_MASTER_KEY;
      this.masterKey = crypto.createHash('sha256').update(envKey).digest();
    } else {
      // Fallback: Generate random 32-byte key for current process memory
      this.masterKey = crypto.randomBytes(32);
    }
  }

  public setSecret(key: string, value: string): void {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.masterKey, iv);
    let ciphertext = cipher.update(value, 'utf8', 'hex');
    ciphertext += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');

    const payload: EncryptedPayload = {
      iv: iv.toString('hex'),
      authTag,
      ciphertext,
      algorithm: 'aes-256-gcm',
      updatedAt: new Date().toISOString(),
    };

    this.store.set(key, payload);
  }

  public getSecret(key: string): string | null {
    const payload = this.store.get(key);
    if (!payload) return null;

    try {
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        this.masterKey,
        Buffer.from(payload.iv, 'hex')
      );
      decipher.setAuthTag(Buffer.from(payload.authTag, 'hex'));
      let decrypted = decipher.update(payload.ciphertext, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch (err: any) {
      logger.error(`Failed to decrypt secret for key: ${key}`, { error: err.message });
      return null;
    }
  }

  public deleteSecret(key: string): boolean {
    return this.store.delete(key);
  }

  public hasSecret(key: string): boolean {
    return this.store.has(key);
  }

  public exportEncryptedStore(): Record<string, EncryptedPayload> {
    const result: Record<string, EncryptedPayload> = {};
    for (const [k, v] of this.store.entries()) {
      result[k] = { ...v };
    }
    return result;
  }

  public importEncryptedStore(serialized: Record<string, EncryptedPayload>): void {
    for (const [k, v] of Object.entries(serialized)) {
      if (v.algorithm === 'aes-256-gcm' && v.iv && v.authTag && v.ciphertext) {
        this.store.set(k, v);
      }
    }
  }
}

// ==========================================
// 3. Token Metrics Tracker
// ==========================================

export class TokenMetricsTracker {
  private records: TokenUsageRecord[] = [];

  public recordUsage(record: TokenUsageRecord): void {
    this.records.push({ ...record });
  }

  public getPersonaMetrics(persona: Persona): PersonaMetricsSummary {
    const personaRecords = this.records.filter((r) => r.persona === persona);
    const totalRequests = personaRecords.length;

    if (totalRequests === 0) {
      return {
        persona,
        totalRequests: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        averageTokensPerRequest: 0,
        averageDurationMs: 0,
      };
    }

    const promptTokens = personaRecords.reduce((sum, r) => sum + r.promptTokens, 0);
    const completionTokens = personaRecords.reduce((sum, r) => sum + r.completionTokens, 0);
    const totalTokens = personaRecords.reduce((sum, r) => sum + r.totalTokens, 0);
    const totalDuration = personaRecords.reduce((sum, r) => sum + r.durationMs, 0);

    return {
      persona,
      totalRequests,
      promptTokens,
      completionTokens,
      totalTokens,
      averageTokensPerRequest: Math.round(totalTokens / totalRequests),
      averageDurationMs: Math.round(totalDuration / totalRequests),
    };
  }

  public getGlobalMetrics(): GlobalMetricsSummary {
    const personas: Persona[] = ['security', 'architecture', 'performance', 'quality'];
    const byPersona = {} as Record<Persona, PersonaMetricsSummary>;
    for (const p of personas) {
      byPersona[p] = this.getPersonaMetrics(p);
    }

    const byProvider: Record<string, { totalRequests: number; totalTokens: number }> = {};
    let totalPrompt = 0;
    let totalCompletion = 0;
    let totalAll = 0;

    for (const r of this.records) {
      totalPrompt += r.promptTokens;
      totalCompletion += r.completionTokens;
      totalAll += r.totalTokens;

      if (!byProvider[r.provider]) {
        byProvider[r.provider] = { totalRequests: 0, totalTokens: 0 };
      }
      byProvider[r.provider].totalRequests += 1;
      byProvider[r.provider].totalTokens += r.totalTokens;
    }

    return {
      totalRequests: this.records.length,
      totalPromptTokens: totalPrompt,
      totalCompletionTokens: totalCompletion,
      totalTokens: totalAll,
      byPersona,
      byProvider,
    };
  }

  public resetMetrics(): void {
    this.records = [];
  }
}

// ==========================================
// 4. Dynamic Effort Scaler
// ==========================================

export class EffortScaler {
  private static baseMatrix: Record<EffortLevel, Omit<EffortConfig, 'effortLevel' | 'providerExtraParams'>> = {
    low: {
      maxOutputTokens: 1000,
      promptTokenBudget: 4000,
      temperature: 0.1,
      reasoningEffort: 'none',
      timeoutMs: 15000,
    },
    medium: {
      maxOutputTokens: 4000,
      promptTokenBudget: 16000,
      temperature: 0.2,
      reasoningEffort: 'low',
      timeoutMs: 30000,
    },
    high: {
      maxOutputTokens: 8000,
      promptTokenBudget: 32000,
      temperature: 0.3,
      reasoningEffort: 'medium',
      timeoutMs: 60000,
    },
    reasoning: {
      maxOutputTokens: 16000,
      promptTokenBudget: 64000,
      temperature: 0.5,
      reasoningEffort: 'high',
      timeoutMs: 120000,
    },
  };

  public static resolveEffortLevel(
    requestedEffort?: EffortLevel,
    persona?: Persona,
    diffLineCount?: number
  ): EffortLevel {
    let effort: EffortLevel = requestedEffort || 'medium';

    // Persona-based promotion: security persona defaults to high if requested as medium
    if (persona === 'security' && effort === 'medium') {
      effort = 'high';
    }

    // Dynamic diff-size promotion (>500 lines increases effort tier)
    if (diffLineCount && diffLineCount > 500) {
      if (effort === 'low') effort = 'medium';
      else if (effort === 'medium') effort = 'high';
      else if (effort === 'high') effort = 'reasoning';
    }

    return effort;
  }

  public static getEffortConfig(
    requestedEffort?: EffortLevel,
    persona?: Persona,
    diffLineCount?: number,
    provider?: string
  ): EffortConfig {
    const finalEffort = this.resolveEffortLevel(requestedEffort, persona, diffLineCount);
    const base = this.baseMatrix[finalEffort];

    const providerExtraParams: Record<string, any> = {};

    if (provider === 'openai') {
      if (base.reasoningEffort !== 'none') {
        providerExtraParams['reasoning_effort'] = base.reasoningEffort;
      }
    } else if (provider === 'anthropic') {
      if (base.reasoningEffort === 'medium' || base.reasoningEffort === 'high') {
        providerExtraParams['thinking'] = {
          type: 'enabled',
          budget_tokens: base.reasoningEffort === 'high' ? 4096 : 2048,
        };
      }
    }

    return {
      effortLevel: finalEffort,
      ...base,
      providerExtraParams,
    };
  }
}

// ==========================================
// 5. Main TokenManager Class
// ==========================================

export class TokenManager {
  private secretStore: SecureSecretStore;
  private metricsTracker: TokenMetricsTracker;
  private refreshConfigs: Map<string, TokenRefreshConfig> = new Map();
  private tokenDataCache: Map<string, OAuthTokenData> = new Map();
  private inFlightRefreshes: Map<string, Promise<OAuthTokenData>> = new Map();

  constructor(masterKeyHex?: string) {
    this.secretStore = new SecureSecretStore(masterKeyHex);
    this.metricsTracker = new TokenMetricsTracker();
  }

  // --- Secret Storage Wrappers ---

  public setSecretKey(key: string, secret: string): void {
    this.secretStore.setSecret(key, secret);
  }

  public getSecretKey(key: string): string | null {
    return this.secretStore.getSecret(key);
  }

  // --- Token Refresh Management ---

  public registerRefreshConfig(config: TokenRefreshConfig): void {
    this.refreshConfigs.set(config.providerId, config);
  }

  public setOAuthTokenData(providerId: string, data: OAuthTokenData): void {
    this.tokenDataCache.set(providerId, data);
    this.secretStore.setSecret(`oauth_access_${providerId}`, data.accessToken);
    if (data.refreshToken) {
      this.secretStore.setSecret(`oauth_refresh_${providerId}`, data.refreshToken);
    }
  }

  public async getValidAccessToken(providerId: string): Promise<string> {
    // Check if provider uses standard static API key
    const staticKey = this.secretStore.getSecret(`api_key_${providerId}`);
    if (staticKey) return staticKey;

    const tokenData = this.tokenDataCache.get(providerId);
    const config = this.refreshConfigs.get(providerId);

    if (!tokenData) {
      // Check if secret store has raw access token
      const storedToken = this.secretStore.getSecret(`oauth_access_${providerId}`);
      if (storedToken) return storedToken;
      throw new Error(`No credentials or refresh config registered for provider: ${providerId}`);
    }

    const windowMs = config?.preemptiveRefreshWindowMs ?? 60000;
    const now = Date.now();

    // Check if current access token is valid and not expiring within window
    if (tokenData.expiresAt - now > windowMs) {
      return tokenData.accessToken;
    }

    // Token expired or expiring soon -> Refresh required
    return this.refreshAccessToken(providerId);
  }

  public async refreshAccessToken(providerId: string): Promise<string> {
    // Single-flight lock: return in-flight promise if refresh is already in progress
    if (this.inFlightRefreshes.has(providerId)) {
      const refreshed = await this.inFlightRefreshes.get(providerId)!;
      return refreshed.accessToken;
    }

    const config = this.refreshConfigs.get(providerId);
    if (!config) {
      throw new Error(`No refresh configuration found for provider: ${providerId}`);
    }

    const refreshToken =
      this.secretStore.getSecret(`oauth_refresh_${providerId}`) ||
      config.refreshToken;

    if (!refreshToken) {
      throw new Error(`No refresh token available to refresh access token for: ${providerId}`);
    }

    const refreshPromise = (async (): Promise<OAuthTokenData> => {
      try {
        let newData: OAuthTokenData;

        if (config.customRefreshHandler) {
          newData = await config.customRefreshHandler(refreshToken);
        } else if (config.tokenUrl) {
          const res = await fetch(config.tokenUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              grant_type: 'refresh_token',
              refresh_token: refreshToken,
              ...(config.clientId ? { client_id: config.clientId } : {}),
              ...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
            }),
          });

          if (!res.ok) {
            const errText = await res.text().catch(() => '');
            throw new Error(`Token refresh HTTP ${res.status}: ${errText}`);
          }

          const json = (await res.json()) as any;
          newData = {
            accessToken: json.access_token,
            refreshToken: json.refresh_token || refreshToken,
            tokenType: json.token_type || 'Bearer',
            expiresAt: Date.now() + (json.expires_in || 3600) * 1000,
          };
        } else {
          throw new Error(`Neither customRefreshHandler nor tokenUrl provided for provider: ${providerId}`);
        }

        this.setOAuthTokenData(providerId, newData);
        logger.info(`Successfully refreshed token for provider: ${providerId}`);
        return newData;
      } finally {
        this.inFlightRefreshes.delete(providerId);
      }
    })();

    this.inFlightRefreshes.set(providerId, refreshPromise);
    const result = await refreshPromise;
    return result.accessToken;
  }

  // --- Metrics Accounting ---

  public recordUsage(record: TokenUsageRecord): void {
    this.metricsTracker.recordUsage(record);
  }

  public getPersonaMetrics(persona: Persona): PersonaMetricsSummary {
    return this.metricsTracker.getPersonaMetrics(persona);
  }

  public getGlobalMetrics(): GlobalMetricsSummary {
    return this.metricsTracker.getGlobalMetrics();
  }

  public resetMetrics(): void {
    this.metricsTracker.resetMetrics();
  }

  // --- Effort Scaling ---

  public getEffortConfig(
    requestedEffort?: EffortLevel,
    persona?: Persona,
    diffLineCount?: number,
    provider?: string
  ): EffortConfig {
    return EffortScaler.getEffortConfig(requestedEffort, persona, diffLineCount, provider);
  }
}
```

---

## 5. Test Strategy & Verification Plan

### 5.1 Unit Tests (`tests/unit/tokenManager.test.ts`)
1. **SecureSecretStore**:
   - Verify encryption and decryption using AES-256-GCM.
   - Verify invalid authTag or corrupted payload throws decryption error or returns `null`.
   - Test export and import of serialized encrypted store.
2. **TokenRefreshManager**:
   - Test preemptive refresh when token is within `preemptiveRefreshWindowMs`.
   - Test single-flight concurrency: fire 5 simultaneous `getValidAccessToken()` calls for expired token and verify `fetch` or `customRefreshHandler` is called exactly once.
   - Test fallback to reactive refresh when 401 occurs.
3. **TokenMetricsTracker**:
   - Record records across all 4 personas (`security`, `architecture`, `performance`, `quality`).
   - Verify correct total tokens, averages, and provider distributions.
4. **EffortScaler**:
   - Verify mapping of `low`, `medium`, `high`, `reasoning`.
   - Verify persona elevation (e.g. `security` elevated to `high`).
   - Verify diff size dynamic scaling (>500 lines).
   - Verify provider-specific parameter output (OpenAI `reasoning_effort`, Anthropic `thinking`).

---

## 6. Risk Assessment & Recommendations

1. **Memory Security**:
   - *Risk*: Master key stored in process memory could be inspected if heap dumps are exposed.
   - *Mitigation*: Support `CT_SECRET_MASTER_KEY` environment variable. Never log secrets or master key.
2. **Clock Skew**:
   - *Risk*: Client/Server clock divergence might lead to prematurely expired tokens.
   - *Mitigation*: Maintain a generous `preemptiveRefreshWindowMs` default of 60 seconds and support reactive 401 retry in gateway.
3. **Database Integration**:
   - *Recommendation*: While `TokenManager` maintains encrypted payloads in memory, option to back `exportEncryptedStore` into `persistence/db.ts` SQLite table can be easily added for long-term daemon restarts.
