import crypto from 'node:crypto';
import { Persona, EffortLevel } from '../config/schema';
import { logger } from '../utils/logger';

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

/**
 * SecureSecretStore: AES-256-GCM authenticated encryption store using native node:crypto.
 */
export class SecureSecretStore {
  private masterKey: Buffer;
  private legacyMasterKey?: Buffer;
  private salt: Buffer;
  private store: Map<string, EncryptedPayload> = new Map();

  constructor(masterKeyHex?: string, saltInput?: string | Buffer) {
    const rawSalt = saltInput || process.env.CT_SECRET_SALT || 'ct-review-bot-master-salt';
    this.salt = Buffer.isBuffer(rawSalt) ? rawSalt : Buffer.from(rawSalt, 'utf8');

    if (masterKeyHex) {
      this.legacyMasterKey = crypto.createHash('sha256').update(masterKeyHex).digest();
      if (masterKeyHex.length === 64 && /^[0-9a-fA-F]+$/.test(masterKeyHex)) {
        this.masterKey = Buffer.from(masterKeyHex, 'hex');
      } else {
        this.masterKey = crypto.pbkdf2Sync(masterKeyHex, this.salt, 100000, 32, 'sha256');
      }
    } else if (process.env.CT_SECRET_MASTER_KEY) {
      const envKey = process.env.CT_SECRET_MASTER_KEY;
      this.legacyMasterKey = crypto.createHash('sha256').update(envKey).digest();
      if (envKey.length === 64 && /^[0-9a-fA-F]+$/.test(envKey)) {
        this.masterKey = Buffer.from(envKey, 'hex');
      } else {
        this.masterKey = crypto.pbkdf2Sync(envKey, this.salt, 100000, 32, 'sha256');
      }
    } else {
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

          this.setSecret(key, decrypted);
          logger.info(`Migrated legacy secret key '${key}' to PBKDF2 master key.`);
          return decrypted;
        } catch {
          // Fallback failed as well
        }
      }
      logger.error(`Failed to decrypt secret for key: ${key}`, { error: err?.message || err });
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
      if (v && v.algorithm === 'aes-256-gcm' && v.iv && v.authTag && v.ciphertext) {
        this.store.set(k, v);
      }
    }
  }
}

/**
 * TokenMetricsTracker: Tracks prompt, completion, and reasoning token usage metrics per persona and provider.
 */
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

  public getRecords(): TokenUsageRecord[] {
    return [...this.records];
  }
}

/**
 * EffortScaler: Maps effort levels ('low', 'medium', 'high', 'reasoning') to max output tokens, temperature, reasoning parameters, etc.
 */
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

    if (persona === 'security' && effort === 'medium') {
      effort = 'high';
    }

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

/**
 * TokenRefreshManager: Async single-flight mutex lock for token refresh, preemptive expiry window, reactive 401 retry handling.
 */
export class TokenRefreshManager {
  private secretStore: SecureSecretStore;
  private refreshConfigs: Map<string, TokenRefreshConfig> = new Map();
  private tokenDataCache: Map<string, OAuthTokenData> = new Map();
  private inFlightRefreshes: Map<string, Promise<OAuthTokenData>> = new Map();

  constructor(secretStore: SecureSecretStore) {
    this.secretStore = secretStore;
  }

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

  public getOAuthTokenData(providerId: string): OAuthTokenData | undefined {
    return this.tokenDataCache.get(providerId);
  }

  public async getValidAccessToken(providerId: string, fetchFn?: typeof fetch): Promise<string> {
    const staticKey = this.secretStore.getSecret(`api_key_${providerId}`);
    if (staticKey) return staticKey;

    const tokenData = this.tokenDataCache.get(providerId);
    const config = this.refreshConfigs.get(providerId);

    if (!tokenData) {
      const hasRefreshToken = Boolean(
        this.secretStore.getSecret(`oauth_refresh_${providerId}`) || config?.refreshToken
      );

      if (config && (config.customRefreshHandler || config.tokenUrl || hasRefreshToken)) {
        return this.refreshAccessToken(providerId, fetchFn);
      }

      const storedToken = this.secretStore.getSecret(`oauth_access_${providerId}`);
      if (storedToken) return storedToken;

      throw new Error(`No credentials or refresh config registered for provider: ${providerId}`);
    }

    const windowMs = config?.preemptiveRefreshWindowMs ?? 60000;
    const now = Date.now();

    if (tokenData.expiresAt > now && (tokenData.expiresAt - now > windowMs)) {
      return tokenData.accessToken;
    }

    return this.refreshAccessToken(providerId, fetchFn);
  }

  public async refreshAccessToken(providerId: string, fetchFn?: typeof fetch): Promise<string> {
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

    if (!refreshToken && !config.customRefreshHandler) {
      throw new Error(`No refresh token available to refresh access token for: ${providerId}`);
    }

    const effectiveFetch = fetchFn || globalThis.fetch;

    const refreshPromise = (async (): Promise<OAuthTokenData> => {
      try {
        let newData: OAuthTokenData;

        if (config.customRefreshHandler) {
          newData = await config.customRefreshHandler(refreshToken || '');
        } else if (config.tokenUrl) {
          const res = await effectiveFetch(config.tokenUrl, {
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
}

/**
 * Main TokenManager class aggregating secret store, metrics tracker, effort scaler, and refresh manager.
 */
export class TokenManager {
  private secretStore: SecureSecretStore;
  private metricsTracker: TokenMetricsTracker;
  private refreshManager: TokenRefreshManager;

  constructor(masterKeyHex?: string) {
    this.secretStore = new SecureSecretStore(masterKeyHex);
    this.metricsTracker = new TokenMetricsTracker();
    this.refreshManager = new TokenRefreshManager(this.secretStore);
  }

  public getSecretStore(): SecureSecretStore {
    return this.secretStore;
  }

  public setSecretKey(key: string, secret: string): void {
    this.secretStore.setSecret(key, secret);
  }

  public getSecretKey(key: string): string | null {
    return this.secretStore.getSecret(key);
  }

  public deleteSecretKey(key: string): boolean {
    return this.secretStore.deleteSecret(key);
  }

  public registerRefreshConfig(config: TokenRefreshConfig): void {
    this.refreshManager.registerRefreshConfig(config);
  }

  public setOAuthTokenData(providerId: string, data: OAuthTokenData): void {
    this.refreshManager.setOAuthTokenData(providerId, data);
  }

  public getValidAccessToken(providerId: string, fetchFn?: typeof fetch): Promise<string> {
    return this.refreshManager.getValidAccessToken(providerId, fetchFn);
  }

  public refreshAccessToken(providerId: string, fetchFn?: typeof fetch): Promise<string> {
    return this.refreshManager.refreshAccessToken(providerId, fetchFn);
  }

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

  public getEffortConfig(
    requestedEffort?: EffortLevel,
    persona?: Persona,
    diffLineCount?: number,
    provider?: string
  ): EffortConfig {
    return EffortScaler.getEffortConfig(requestedEffort, persona, diffLineCount, provider);
  }
}
