# Comprehensive Remediation Strategy: Router & Token Management Security & Resilience (Milestone 2)

**Author**: Explorer 4  
**Target Project Root**: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot`  
**Target Files**:
1. `src/router/tokenManager.ts`
2. `src/router/omniRouteAdapter.ts`
3. `src/router/providerPool.ts`

---

## Executive Summary

Reviewer 2 identified 5 critical security, resilience, and concurrency flaws across the router subsystem of `ct-review-bot`. This document provides Worker 2 with an exact line-by-line remediation specification, complete code replacements, architectural rationales, edge-case considerations, and verification procedures.

---

## 1. Single-Round SHA-256 Key Derivation in `SecureSecretStore`

### Target File
`src/router/tokenManager.ts` (Lines 80–160)

### Current Problem
In `SecureSecretStore`, when `masterKeyHex` is a passphrase (or derived from `process.env.CT_SECRET_MASTER_KEY` when not a 64-character hex string), the master encryption key is derived using a single pass of SHA-256:
```ts
this.masterKey = crypto.createHash('sha256').update(masterKeyHex).digest();
```
Single-round SHA-256 key derivation is vulnerable to high-speed GPU dictionary/brute-force attacks. Modern key derivation functions (KDF) like PBKDF2 or scrypt are required for passphrase-derived master keys. Furthermore, existing encrypted secret stores created with single-round SHA-256 must be cleanly decrypted and migrated without breaking backward compatibility.

### Remediation Strategy
1. **PBKDF2/scrypt Integration**:
   - For 64-character hex strings matching `/^[0-9a-fA-F]{64}$/`, retain direct binary decoding (`Buffer.from(masterKeyHex, 'hex')`) because a 256-bit hex key is already cryptographically strong.
   - For non-64-character passphrases, derive `this.masterKey` using `crypto.pbkdf2Sync(passphrase, salt, iterations, 32, 'sha256')` (or `crypto.scryptSync(passphrase, salt, 32)`).
   - Support custom salt parameters via constructor: `constructor(masterKeyHex?: string, salt?: string | Buffer)`.
   - Default salt fallback: `salt || process.env.CT_SECRET_SALT || 'ct-review-bot-master-salt'`.
2. **Backward Compatibility & Automatic Migration**:
   - For passphrases, also store `private legacyMasterKey?: Buffer` computed via single-round SHA-256.
   - In `getSecret(key)`:
     1. Attempt decryption using `this.masterKey` (PBKDF2/scrypt).
     2. If deciphering fails (e.g. `authTag` mismatch) AND `this.legacyMasterKey` is available, attempt decryption using `this.legacyMasterKey`.
     3. If legacy decryption succeeds, transparently re-encrypt the value using `this.masterKey` and update the store (`this.setSecret(key, value)`), providing seamless key migration.

### Detailed Code Changes for `src/router/tokenManager.ts`

```ts
export class SecureSecretStore {
  private masterKey: Buffer;
  private legacyMasterKey?: Buffer;
  private salt: Buffer;
  private store: Map<string, EncryptedPayload> = new Map();

  constructor(masterKeyHex?: string, saltInput?: string | Buffer) {
    // Standardize salt input or default to process.env / static salt string
    const rawSalt = saltInput || process.env.CT_SECRET_SALT || 'ct-review-bot-master-salt';
    this.salt = Buffer.isBuffer(rawSalt) ? rawSalt : Buffer.from(rawSalt, 'utf8');

    if (masterKeyHex) {
      if (masterKeyHex.length === 64 && /^[0-9a-fA-F]+$/.test(masterKeyHex)) {
        // Direct 256-bit binary key
        this.masterKey = Buffer.from(masterKeyHex, 'hex');
      } else {
        // Passphrase: derive masterKey with PBKDF2 (100,000 iterations)
        this.masterKey = crypto.pbkdf2Sync(masterKeyHex, this.salt, 100000, 32, 'sha256');
        // Legacy fallback key for backward compatibility
        this.legacyMasterKey = crypto.createHash('sha256').update(masterKeyHex).digest();
      }
    } else if (process.env.CT_SECRET_MASTER_KEY) {
      const envKey = process.env.CT_SECRET_MASTER_KEY;
      if (envKey.length === 64 && /^[0-9a-fA-F]+$/.test(envKey)) {
        this.masterKey = Buffer.from(envKey, 'hex');
      } else {
        this.masterKey = crypto.pbkdf2Sync(envKey, this.salt, 100000, 32, 'sha256');
        this.legacyMasterKey = crypto.createHash('sha256').update(envKey).digest();
      }
    } else {
      this.masterKey = crypto.randomBytes(32);
    }
  }

  public getSecret(key: string): string | null {
    const payload = this.store.get(key);
    if (!payload) return null;

    // 1. Try primary PBKDF2/scrypt derived master key
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
    } catch (err) {
      // 2. If primary decryption fails, check legacy single-round SHA-256 key
      if (this.legacyMasterKey) {
        try {
          const legacyDecipher = crypto.createDecipheriv(
            'aes-256-gcm',
            this.legacyMasterKey,
            Buffer.from(payload.iv, 'hex')
          );
          legacyDecipher.setAuthTag(Buffer.from(payload.authTag, 'hex'));
          let decrypted = legacyDecipher.update(payload.ciphertext, 'hex', 'utf8');
          decrypted += legacyDecipher.final('utf8');

          // Seamless auto-migration: re-encrypt payload with new master key
          this.setSecret(key, decrypted);
          logger.info(`Migrated legacy secret key '${key}' to PBKDF2 master key.`);
          return decrypted;
        } catch {
          // Both key attempts failed
        }
      }
      logger.error(`Failed to decrypt secret for key: ${key}`);
      return null;
    }
  }
```

---

## 2. Monthly Quota Pre-check & Spend Accumulation in `OmniRouteAdapter`

### Target File
`src/router/omniRouteAdapter.ts` (Lines 167–196, 254–281, 341–368, 422–449, 503–530)

### Current Problem
1. **No Pre-execution Quota Enforcement**: `OmniRouteAdapter` executes `fetchFn` before evaluating `extraUsageTier.monthlyLimitUSD`. If the quota is already exhausted, expensive API calls are still dispatched to LLM providers before throwing `QuotaExhaustedError`.
2. **Missing Spend Accumulation**: `this.config.extraUsageTier.currentSpendUSD` is NEVER incremented after calculating `costEstimateUSD`. As a result, `currentSpendUSD` remains constant and monthly quota limits are never reached in practice.

### Remediation Strategy
1. **Quota Pre-check**: Before calling `fetchFn`, inspect `config.extraUsageTier`. If `enabled` is true, `monthlyLimitUSD` is set, and `(currentSpendUSD || 0) >= monthlyLimitUSD`, immediately throw `QuotaExhaustedError`.
2. **Spend Accumulation**: After calculating `costEstimateUSD` from response tokens, increment `config.extraUsageTier.currentSpendUSD = (currentSpendUSD || 0) + costEstimateUSD`.
3. **Post-execution Quota Enforcement**: If the updated `currentSpendUSD` exceeds `monthlyLimitUSD`, throw `QuotaExhaustedError`.
4. **Reusable Helpers**: Introduce `checkPreExecutionQuota(config: ProviderConfig)` and `recordPostExecutionSpend(config: ProviderConfig, tokensUsed: LLMTokensUsed): number | undefined` in `omniRouteAdapter.ts` to keep provider adapter classes clean and DRY.

### Detailed Code Changes for `src/router/omniRouteAdapter.ts`

```ts
export function checkPreExecutionQuota(config: ProviderConfig): void {
  if (
    config.extraUsageTier?.enabled &&
    config.extraUsageTier.monthlyLimitUSD !== undefined
  ) {
    const current = config.extraUsageTier.currentSpendUSD || 0;
    if (current >= config.extraUsageTier.monthlyLimitUSD) {
      throw new QuotaExhaustedError(
        `Extra usage monthly spend limit ($${config.extraUsageTier.monthlyLimitUSD}) already reached for provider: ${config.id}`,
        config.id
      );
    }
  }
}

export function recordPostExecutionSpend(
  config: ProviderConfig,
  tokensUsed: LLMTokensUsed
): number | undefined {
  if (
    config.billingTier === 'usage_based' ||
    (config.billingTier === 'extra_usage_tier' && config.extraUsageTier?.enabled)
  ) {
    const promptCost = config.extraUsageTier?.costPer1kPromptTokens ?? 0.0015;
    const completionCost = config.extraUsageTier?.costPer1kCompletionTokens ?? 0.002;
    const costEstimateUSD = calculateTokenCost(tokensUsed, promptCost, completionCost);

    if (config.extraUsageTier?.enabled) {
      const current = config.extraUsageTier.currentSpendUSD || 0;
      const newSpend = Number((current + costEstimateUSD).toFixed(6));
      config.extraUsageTier.currentSpendUSD = newSpend;

      if (
        config.extraUsageTier.monthlyLimitUSD !== undefined &&
        newSpend > config.extraUsageTier.monthlyLimitUSD
      ) {
        throw new QuotaExhaustedError(
          `Extra usage monthly spend limit ($${config.extraUsageTier.monthlyLimitUSD}) exceeded for ${config.id}`,
          config.id
        );
      }
    }
    return costEstimateUSD;
  }
  return undefined;
}
```

#### Application in Adapters (Example for `OpenAIAdapter`):
```ts
export class OpenAIAdapter implements IProviderAdapter {
  public providerType: ProviderType = 'openai';
  constructor(public config: ProviderConfig) {}

  async execute(request: LLMRequest, fetchFn: typeof fetch): Promise<LLMResponse> {
    // 1. Pre-check monthly quota spend before LLM execution
    checkPreExecutionQuota(this.config);

    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`;
    // ... assemble body & headers ...

    const res = await fetchFn(url, { method: 'POST', headers, body: JSON.stringify(body) });

    if (!res.ok) {
      const errorText = await res.text().catch(() => '');
      const err: any = new Error(`OpenAI request failed with status ${res.status}: ${errorText}`);
      err.status = res.status;
      err.statusCode = res.status;
      throw err;
    }

    const data: any = await res.json();
    const choice = data.choices?.[0];
    const content = choice?.message?.content || (typeof data.content === 'string' ? data.content : '');
    const tokensUsed: LLMTokensUsed = {
      prompt: data.usage?.prompt_tokens || data.tokensUsed?.prompt || 0,
      completion: data.usage?.completion_tokens || data.tokensUsed?.completion || 0,
      total: data.usage?.total_tokens || data.tokensUsed?.total || 0,
      reasoning: data.usage?.completion_tokens_details?.reasoning_tokens || data.tokensUsed?.reasoning,
    };

    // 2. Accumulate spend & verify post-execution quota limit
    const costEstimateUSD = recordPostExecutionSpend(this.config, tokensUsed);

    return {
      content,
      providerUsed: 'openai',
      modelUsed: data.model || request.model || this.config.defaultModel,
      tokensUsed,
      reasoningTrace: choice?.message?.reasoning_content || data.reasoningTrace,
      rawResponse: data,
      billingTierUsed: this.config.billingTier,
      costEstimateUSD,
    };
  }
}
```
*(Apply identical `checkPreExecutionQuota(this.config)` and `recordPostExecutionSpend(this.config, tokensUsed)` calls to `OmniRouteGatewayAdapter`, `AnthropicAdapter`, `GeminiAdapter`, and `DeepSeekAdapter`)*.

---

## 3. `HALF_OPEN` Probing Race Condition in `ProviderPool`

### Target File
`src/router/providerPool.ts` (Lines 57–177)

### Current Problem
In `ProviderNode`:
```ts
  public isAvailable(): boolean {
    const now = Date.now();
    if (this.circuitState === 'OPEN') {
      if (this.coolingDownUntil && now >= this.coolingDownUntil) {
        this.circuitState = 'HALF_OPEN';
        return true;
      }
      return false;
    }
    return this.healthState === 'healthy' || this.healthState === 'degraded' || this.circuitState === 'HALF_OPEN';
  }
```
When `coolingDownUntil` expires, `isAvailable()` sets `circuitState = 'HALF_OPEN'`. However, any concurrent requests calling `isAvailable()` while `circuitState === 'HALF_OPEN'` receive `true`. As a result, tens or hundreds of concurrent requests simultaneously flood the recovering provider instead of allowing only 1 probe request through.

### Remediation Strategy
1. **Probe Mutual Exclusion**: Add `private isProbing: boolean = false;` and `private probeStartTime?: number;` to `ProviderNode`.
2. **Atomic Transition**:
   - When `circuitState === 'OPEN'` and `now >= coolingDownUntil`:
     Transition `circuitState = 'HALF_OPEN'`, set `this.isProbing = true`, record `this.probeStartTime = now`, and return `true` to the FIRST request.
   - When `circuitState === 'HALF_OPEN'`:
     If `!this.isProbing`, set `this.isProbing = true`, record `this.probeStartTime = now`, and return `true`.
     If `this.isProbing === true`, check if `now - this.probeStartTime > 30_000` (deadlock timeout guard). If expired, reset probe start time and return `true`. Otherwise, return `false` so concurrent requests bypass this node.
3. **State Cleanup**:
   - In `recordSuccess()`: reset `this.isProbing = false`, set `circuitState = 'CLOSED'`, `healthState = 'healthy'`, `coolingDownUntil = null`.
   - In `recordFailure()`: reset `this.isProbing = false`, trip circuit back to `'OPEN'`.

### Detailed Code Changes for `src/router/providerPool.ts`

```ts
export class ProviderNode {
  // ... existing fields ...
  private isProbing = false;
  private probeStartTime: number | null = null;

  public isAvailable(): boolean {
    const now = Date.now();

    if (this.circuitState === 'OPEN') {
      if (this.coolingDownUntil && now >= this.coolingDownUntil) {
        // Cooldown elapsed: transition to HALF_OPEN and acquire probe lock for first caller
        this.circuitState = 'HALF_OPEN';
        this.isProbing = true;
        this.probeStartTime = now;
        return true;
      }
      return false;
    }

    if (this.circuitState === 'HALF_OPEN') {
      if (!this.isProbing) {
        // Acquire probe lock
        this.isProbing = true;
        this.probeStartTime = now;
        return true;
      }
      // Deadlock guard: if probe request hangs for > 30s, allow new probe attempt
      if (this.probeStartTime && now - this.probeStartTime > 30000) {
        this.probeStartTime = now;
        return true;
      }
      // Reject concurrent requests while single probe is in flight
      return false;
    }

    return this.healthState === 'healthy' || this.healthState === 'degraded';
  }

  public recordSuccess(durationMs: number): void {
    this.metrics.activeInFlightRequests = Math.max(0, this.metrics.activeInFlightRequests - 1);
    this.metrics.successfulRequests++;
    this.metrics.consecutiveFailures = 0;
    this.metrics.lastSuccessTimestamp = Date.now();

    if (this.metrics.avgLatencyMs === 0) {
      this.metrics.avgLatencyMs = durationMs;
    } else {
      this.metrics.avgLatencyMs = Math.round(this.metrics.avgLatencyMs * 0.8 + durationMs * 0.2);
    }

    if (this.circuitState === 'HALF_OPEN' || this.healthState === 'cooling_down') {
      this.circuitState = 'CLOSED';
      this.healthState = 'healthy';
      this.coolingDownUntil = null;
      this.consecutiveCoolDownTrips = 0;
      this.isProbing = false;
      this.probeStartTime = null;
      logger.info(`Provider '${this.id}' recovered to HEALTHY state.`);
    }
  }

  public recordFailure(status: number, errorMsg: string, retryAfterHeader?: string | number): void {
    this.metrics.activeInFlightRequests = Math.max(0, this.metrics.activeInFlightRequests - 1);
    this.metrics.failedRequests++;
    this.metrics.consecutiveFailures++;
    this.metrics.lastErrorTimestamp = Date.now();
    this.metrics.lastErrorStatus = status;

    const now = Date.now();
    this.consecutiveCoolDownTrips++;
    this.isProbing = false;
    this.probeStartTime = null;

    if (status === 429) {
      // ... trip circuit ...
    } else if (status >= 500) {
      // ... trip circuit or degrade ...
    }
  }
}
```

---

## 4. Uncached Token Refresh Handling in `TokenRefreshManager`

### Target File
`src/router/tokenManager.ts` (Lines 362–383)

### Current Problem
In `TokenRefreshManager.getValidAccessToken()`:
```ts
    if (!tokenData) {
      const storedToken = this.secretStore.getSecret(`oauth_access_${providerId}`);
      if (storedToken) return storedToken;
      throw new Error(`No credentials or refresh config registered for provider: ${providerId}`);
    }
```
If `tokenDataCache` is unpopulated (e.g. after service restart or before explicit token seeding), `getValidAccessToken()` immediately throws an error, even if a `TokenRefreshConfig` has been registered with `refreshToken`, `tokenUrl`, or `customRefreshHandler`.

### Remediation Strategy
When `tokenData` is missing and no stored access token exists in `secretStore`:
1. Check if `config` is registered for `providerId`.
2. Check if a refresh mechanism is available (`config.customRefreshHandler`, `config.tokenUrl`, or `oauth_refresh_${providerId}` in secretStore, or `config.refreshToken`).
3. If available, invoke `return this.refreshAccessToken(providerId, fetchFn)` directly instead of throwing an error.
4. Only throw `Error` if neither credentials nor refresh configs exist.

### Detailed Code Changes for `src/router/tokenManager.ts`

```ts
  public async getValidAccessToken(providerId: string, fetchFn?: typeof fetch): Promise<string> {
    const staticKey = this.secretStore.getSecret(`api_key_${providerId}`);
    if (staticKey) return staticKey;

    const tokenData = this.tokenDataCache.get(providerId);
    const config = this.refreshConfigs.get(providerId);

    if (!tokenData) {
      const storedToken = this.secretStore.getSecret(`oauth_access_${providerId}`);
      if (storedToken) return storedToken;

      // Auto-trigger token refresh if refresh config or refresh token is available
      const hasRefreshToken = Boolean(
        this.secretStore.getSecret(`oauth_refresh_${providerId}`) || config?.refreshToken
      );

      if (config && (config.customRefreshHandler || config.tokenUrl || hasRefreshToken)) {
        return this.refreshAccessToken(providerId, fetchFn);
      }

      throw new Error(`No credentials or refresh config registered for provider: ${providerId}`);
    }

    const windowMs = config?.preemptiveRefreshWindowMs ?? 60000;
    const now = Date.now();

    if (tokenData.expiresAt - now > windowMs) {
      return tokenData.accessToken;
    }

    return this.refreshAccessToken(providerId, fetchFn);
  }
```

---

## 5. Load Balancing Strategy Bypass in `executeWithFailover`

### Target File
`src/router/providerPool.ts` (Lines 215–250, 278–335)

### Current Problem
In `executeWithFailover`:
```ts
      if (attempted.includes(node.id)) {
        const unattempted = this.getAvailableProviders().filter((p) => !attempted.includes(p.id));
        if (unattempted.length > 0) {
          node = unattempted[0];
        } else {
          break;
        }
      }
```
When a provider attempt fails, `executeWithFailover` selects the next provider by sorting `unattempted` strictly by priority (`a.priority - b.priority`) and picking `unattempted[0]`. This hardcoded fallback bypasses the configured pool strategy (`round_robin` or `least_loaded`).

### Remediation Strategy
1. **Refactor `selectProvider` Signature**: Accept an optional `excludeIds: ProviderId[] = []` parameter.
2. **Filter Excluded Candidates**: In `selectProvider`, filter available providers to exclude `excludeIds`.
3. **Extract Selection Helper**: Create `private selectProviderFromList(candidates: ProviderNode[]): ProviderNode` that evaluates `round_robin`, `least_loaded`, or `priority_fallback` on candidate pools.
4. **Delegate Failover Selection**: In `executeWithFailover`, call `node = this.selectProvider(attempt === 0 ? preferredProviderId : undefined, attempted)` on every attempt. This ensures all failover retries strictly respect the configured load balancing strategy.

### Detailed Code Changes for `src/router/providerPool.ts`

```ts
  private selectProviderFromList(candidates: ProviderNode[]): ProviderNode {
    if (candidates.length === 0) {
      throw new ProviderPoolExhaustedError('No candidate providers available.', []);
    }

    if (this.strategy === 'round_robin') {
      const node = candidates[this.roundRobinIndex % candidates.length];
      this.roundRobinIndex = (this.roundRobinIndex + 1) % candidates.length;
      return node;
    }

    if (this.strategy === 'least_loaded') {
      return candidates.reduce(
        (min, node) =>
          node.metrics.activeInFlightRequests < min.metrics.activeInFlightRequests ? node : min,
        candidates[0]
      );
    }

    // Default: priority_fallback (candidates pre-sorted by priority ascending)
    return candidates[0];
  }

  public selectProvider(preferredProviderId?: ProviderId, excludeIds: ProviderId[] = []): ProviderNode {
    const available = this.getAvailableProviders().filter((p) => !excludeIds.includes(p.id));

    if (available.length === 0) {
      throw new ProviderPoolExhaustedError(
        'All AI providers in pool are offline or cooling down.',
        Array.from(this.providers.keys())
      );
    }

    if (preferredProviderId) {
      const preferredNode = available.find((p) => p.id === preferredProviderId);
      if (preferredNode) {
        return preferredNode;
      }
      logger.warn(
        `Preferred provider '${preferredProviderId}' unavailable. Falling back to pool strategy '${this.strategy}'.`
      );
    }

    return this.selectProviderFromList(available);
  }

  public async executeWithFailover<T>(
    operation: (provider: ProviderNode) => Promise<T>,
    preferredProviderId?: ProviderId
  ): Promise<{ result: T; providerUsed: ProviderId }> {
    const attempted: ProviderId[] = [];
    const maxAttempts = this.providers.size;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let node: ProviderNode;
      try {
        node = this.selectProvider(attempt === 0 ? preferredProviderId : undefined, attempted);
      } catch (err) {
        if (err instanceof ProviderPoolExhaustedError) {
          if (attempted.length > 0) {
            throw new ProviderPoolExhaustedError(
              `Execution failed. All providers exhausted after attempting: ${attempted.join(', ')}`,
              attempted
            );
          }
        }
        throw err;
      }

      attempted.push(node.id);
      node.recordStart();
      const startTime = Date.now();

      try {
        const result = await operation(node);
        node.recordSuccess(Date.now() - startTime);
        return { result, providerUsed: node.id };
      } catch (error: any) {
        const status = error?.status || error?.statusCode || 500;
        const msg = error?.message || 'Unknown provider error';
        const retryAfter = error?.headers?.['retry-after'] || error?.retryAfter;

        node.recordFailure(status, msg, retryAfter);
        logger.warn(
          `Provider '${node.id}' failed (HTTP ${status}). Initiating failover attempt ${
            attempt + 1
          }/${maxAttempts}.`
        );
      }
    }

    throw new ProviderPoolExhaustedError(
      `All available providers failed during operation. Attempted: ${attempted.join(', ')}`,
      attempted
    );
  }
```

---

## 6. Verification & Test Plan

Worker 2 can independently verify all remediations by executing the following commands:

```bash
# 1. Run unit tests for token manager and secret store
npx vitest run tests/unit/tokenManager.test.ts

# 2. Run unit tests for omni route adapter and quota checks
npx vitest run tests/unit/omniRoute.test.ts

# 3. Run unit tests for provider pool, failover, and HALF_OPEN circuit breaker
npx vitest run tests/unit/providerPool.test.ts

# 4. Run empirical stress test suite covering M2 router behavior
npx vitest run tests/unit/m2_challenger_empirical_stress.test.ts

# 5. Run full M2 router integration test suite
npx vitest run tests/integration/m2_router.test.ts
```
