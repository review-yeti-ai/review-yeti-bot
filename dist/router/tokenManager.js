"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TokenManager = exports.TokenRefreshManager = exports.EffortScaler = exports.TokenMetricsTracker = exports.SecureSecretStore = void 0;
const node_crypto_1 = __importDefault(require("node:crypto"));
const logger_1 = require("../utils/logger");
/**
 * SecureSecretStore: AES-256-GCM authenticated encryption store using native node:crypto.
 */
class SecureSecretStore {
    masterKey;
    legacyMasterKey;
    salt;
    store = new Map();
    constructor(masterKeyHex, saltInput) {
        const rawSalt = saltInput || process.env.CT_SECRET_SALT || 'ct-review-bot-master-salt';
        this.salt = Buffer.isBuffer(rawSalt) ? rawSalt : Buffer.from(rawSalt, 'utf8');
        if (masterKeyHex) {
            this.legacyMasterKey = node_crypto_1.default.createHash('sha256').update(masterKeyHex).digest();
            if (masterKeyHex.length === 64 && /^[0-9a-fA-F]+$/.test(masterKeyHex)) {
                this.masterKey = Buffer.from(masterKeyHex, 'hex');
            }
            else {
                this.masterKey = node_crypto_1.default.pbkdf2Sync(masterKeyHex, this.salt, 100000, 32, 'sha256');
            }
        }
        else if (process.env.CT_SECRET_MASTER_KEY) {
            const envKey = process.env.CT_SECRET_MASTER_KEY;
            this.legacyMasterKey = node_crypto_1.default.createHash('sha256').update(envKey).digest();
            if (envKey.length === 64 && /^[0-9a-fA-F]+$/.test(envKey)) {
                this.masterKey = Buffer.from(envKey, 'hex');
            }
            else {
                this.masterKey = node_crypto_1.default.pbkdf2Sync(envKey, this.salt, 100000, 32, 'sha256');
            }
        }
        else {
            this.masterKey = node_crypto_1.default.randomBytes(32);
        }
    }
    setSecret(key, value) {
        const iv = node_crypto_1.default.randomBytes(12);
        const cipher = node_crypto_1.default.createCipheriv('aes-256-gcm', this.masterKey, iv);
        let ciphertext = cipher.update(value, 'utf8', 'hex');
        ciphertext += cipher.final('hex');
        const authTag = cipher.getAuthTag().toString('hex');
        const payload = {
            iv: iv.toString('hex'),
            authTag,
            ciphertext,
            algorithm: 'aes-256-gcm',
            updatedAt: new Date().toISOString(),
        };
        this.store.set(key, payload);
    }
    getSecret(key) {
        const payload = this.store.get(key);
        if (!payload)
            return null;
        try {
            const decipher = node_crypto_1.default.createDecipheriv('aes-256-gcm', this.masterKey, Buffer.from(payload.iv, 'hex'));
            decipher.setAuthTag(Buffer.from(payload.authTag, 'hex'));
            let decrypted = decipher.update(payload.ciphertext, 'hex', 'utf8');
            decrypted += decipher.final('utf8');
            return decrypted;
        }
        catch (err) {
            if (this.legacyMasterKey) {
                try {
                    const legacyDecipher = node_crypto_1.default.createDecipheriv('aes-256-gcm', this.legacyMasterKey, Buffer.from(payload.iv, 'hex'));
                    legacyDecipher.setAuthTag(Buffer.from(payload.authTag, 'hex'));
                    let decrypted = legacyDecipher.update(payload.ciphertext, 'hex', 'utf8');
                    decrypted += legacyDecipher.final('utf8');
                    this.setSecret(key, decrypted);
                    logger_1.logger.info(`Migrated legacy secret key '${key}' to PBKDF2 master key.`);
                    return decrypted;
                }
                catch {
                    // Fallback failed as well
                }
            }
            logger_1.logger.error(`Failed to decrypt secret for key: ${key}`, { error: err?.message || err });
            return null;
        }
    }
    deleteSecret(key) {
        return this.store.delete(key);
    }
    hasSecret(key) {
        return this.store.has(key);
    }
    exportEncryptedStore() {
        const result = {};
        for (const [k, v] of this.store.entries()) {
            result[k] = { ...v };
        }
        return result;
    }
    importEncryptedStore(serialized) {
        for (const [k, v] of Object.entries(serialized)) {
            if (v && v.algorithm === 'aes-256-gcm' && v.iv && v.authTag && v.ciphertext) {
                this.store.set(k, v);
            }
        }
    }
}
exports.SecureSecretStore = SecureSecretStore;
/**
 * TokenMetricsTracker: Tracks prompt, completion, and reasoning token usage metrics per persona and provider.
 */
class TokenMetricsTracker {
    records = [];
    recordUsage(record) {
        this.records.push({ ...record });
    }
    getPersonaMetrics(persona) {
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
    getGlobalMetrics() {
        const personas = ['security', 'architecture', 'performance', 'quality'];
        const byPersona = {};
        for (const p of personas) {
            byPersona[p] = this.getPersonaMetrics(p);
        }
        const byProvider = {};
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
    resetMetrics() {
        this.records = [];
    }
    getRecords() {
        return [...this.records];
    }
}
exports.TokenMetricsTracker = TokenMetricsTracker;
/**
 * EffortScaler: Maps effort levels ('low', 'medium', 'high', 'reasoning') to max output tokens, temperature, reasoning parameters, etc.
 */
class EffortScaler {
    static baseMatrix = {
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
    static resolveEffortLevel(requestedEffort, persona, diffLineCount) {
        let effort = requestedEffort || 'medium';
        if (persona === 'security' && effort === 'medium') {
            effort = 'high';
        }
        if (diffLineCount && diffLineCount > 500) {
            if (effort === 'low')
                effort = 'medium';
            else if (effort === 'medium')
                effort = 'high';
            else if (effort === 'high')
                effort = 'reasoning';
        }
        return effort;
    }
    static getEffortConfig(requestedEffort, persona, diffLineCount, provider) {
        const finalEffort = this.resolveEffortLevel(requestedEffort, persona, diffLineCount);
        const base = this.baseMatrix[finalEffort];
        const providerExtraParams = {};
        if (provider === 'openai') {
            if (base.reasoningEffort !== 'none') {
                providerExtraParams['reasoning_effort'] = base.reasoningEffort;
            }
        }
        else if (provider === 'anthropic') {
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
exports.EffortScaler = EffortScaler;
/**
 * TokenRefreshManager: Async single-flight mutex lock for token refresh, preemptive expiry window, reactive 401 retry handling.
 */
class TokenRefreshManager {
    secretStore;
    refreshConfigs = new Map();
    tokenDataCache = new Map();
    inFlightRefreshes = new Map();
    constructor(secretStore) {
        this.secretStore = secretStore;
    }
    registerRefreshConfig(config) {
        this.refreshConfigs.set(config.providerId, config);
    }
    setOAuthTokenData(providerId, data) {
        this.tokenDataCache.set(providerId, data);
        this.secretStore.setSecret(`oauth_access_${providerId}`, data.accessToken);
        if (data.refreshToken) {
            this.secretStore.setSecret(`oauth_refresh_${providerId}`, data.refreshToken);
        }
    }
    getOAuthTokenData(providerId) {
        return this.tokenDataCache.get(providerId);
    }
    async getValidAccessToken(providerId, fetchFn) {
        const staticKey = this.secretStore.getSecret(`api_key_${providerId}`);
        if (staticKey)
            return staticKey;
        const tokenData = this.tokenDataCache.get(providerId);
        const config = this.refreshConfigs.get(providerId);
        if (!tokenData) {
            const hasRefreshToken = Boolean(this.secretStore.getSecret(`oauth_refresh_${providerId}`) || config?.refreshToken);
            if (config && (config.customRefreshHandler || config.tokenUrl || hasRefreshToken)) {
                return this.refreshAccessToken(providerId, fetchFn);
            }
            const storedToken = this.secretStore.getSecret(`oauth_access_${providerId}`);
            if (storedToken)
                return storedToken;
            throw new Error(`No credentials or refresh config registered for provider: ${providerId}`);
        }
        const windowMs = config?.preemptiveRefreshWindowMs ?? 60000;
        const now = Date.now();
        if (tokenData.expiresAt > now && (tokenData.expiresAt - now > windowMs)) {
            return tokenData.accessToken;
        }
        return this.refreshAccessToken(providerId, fetchFn);
    }
    async refreshAccessToken(providerId, fetchFn) {
        if (this.inFlightRefreshes.has(providerId)) {
            const refreshed = await this.inFlightRefreshes.get(providerId);
            return refreshed.accessToken;
        }
        const config = this.refreshConfigs.get(providerId);
        if (!config) {
            throw new Error(`No refresh configuration found for provider: ${providerId}`);
        }
        const refreshToken = this.secretStore.getSecret(`oauth_refresh_${providerId}`) ||
            config.refreshToken;
        if (!refreshToken && !config.customRefreshHandler) {
            throw new Error(`No refresh token available to refresh access token for: ${providerId}`);
        }
        const effectiveFetch = fetchFn || globalThis.fetch;
        const refreshPromise = (async () => {
            try {
                let newData;
                if (config.customRefreshHandler) {
                    newData = await config.customRefreshHandler(refreshToken || '');
                }
                else if (config.tokenUrl) {
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
                    const json = (await res.json());
                    newData = {
                        accessToken: json.access_token,
                        refreshToken: json.refresh_token || refreshToken,
                        tokenType: json.token_type || 'Bearer',
                        expiresAt: Date.now() + (json.expires_in || 3600) * 1000,
                    };
                }
                else {
                    throw new Error(`Neither customRefreshHandler nor tokenUrl provided for provider: ${providerId}`);
                }
                this.setOAuthTokenData(providerId, newData);
                logger_1.logger.info(`Successfully refreshed token for provider: ${providerId}`);
                return newData;
            }
            finally {
                this.inFlightRefreshes.delete(providerId);
            }
        })();
        this.inFlightRefreshes.set(providerId, refreshPromise);
        const result = await refreshPromise;
        return result.accessToken;
    }
}
exports.TokenRefreshManager = TokenRefreshManager;
/**
 * Main TokenManager class aggregating secret store, metrics tracker, effort scaler, and refresh manager.
 */
class TokenManager {
    secretStore;
    metricsTracker;
    refreshManager;
    constructor(masterKeyHex) {
        this.secretStore = new SecureSecretStore(masterKeyHex);
        this.metricsTracker = new TokenMetricsTracker();
        this.refreshManager = new TokenRefreshManager(this.secretStore);
    }
    getSecretStore() {
        return this.secretStore;
    }
    setSecretKey(key, secret) {
        this.secretStore.setSecret(key, secret);
    }
    getSecretKey(key) {
        return this.secretStore.getSecret(key);
    }
    deleteSecretKey(key) {
        return this.secretStore.deleteSecret(key);
    }
    registerRefreshConfig(config) {
        this.refreshManager.registerRefreshConfig(config);
    }
    setOAuthTokenData(providerId, data) {
        this.refreshManager.setOAuthTokenData(providerId, data);
    }
    getValidAccessToken(providerId, fetchFn) {
        return this.refreshManager.getValidAccessToken(providerId, fetchFn);
    }
    refreshAccessToken(providerId, fetchFn) {
        return this.refreshManager.refreshAccessToken(providerId, fetchFn);
    }
    recordUsage(record) {
        this.metricsTracker.recordUsage(record);
    }
    getPersonaMetrics(persona) {
        return this.metricsTracker.getPersonaMetrics(persona);
    }
    getGlobalMetrics() {
        return this.metricsTracker.getGlobalMetrics();
    }
    resetMetrics() {
        this.metricsTracker.resetMetrics();
    }
    getEffortConfig(requestedEffort, persona, diffLineCount, provider) {
        return EffortScaler.getEffortConfig(requestedEffort, persona, diffLineCount, provider);
    }
}
exports.TokenManager = TokenManager;
//# sourceMappingURL=tokenManager.js.map