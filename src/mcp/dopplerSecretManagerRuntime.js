/**
 * Small CommonJS Doppler client for the GitHub Action runtime.
 * The TypeScript manager remains the server-side implementation; this file keeps the composite
 * Action dependency-free while providing the same env/cache/REST resolution contract.
 */
class DopplerSecretManagerRuntime {
  constructor(config = {}) {
    this.project = config.project || process.env.DOPPLER_PROJECT || 'review-yeti-bot';
    this.configName = config.config || process.env.DOPPLER_CONFIG || 'dev';
    this.fallbackEnv = config.fallbackEnv ?? true;
    this.dopplerToken = config.dopplerToken || process.env.DOPPLER_TOKEN;
    this.timeoutMs = config.timeoutMs ?? 3_000;
    this.fetchImplementation = config.fetchImplementation || globalThis.fetch;
    this.cache = new Map();
  }

  async getSecret(name) {
    if (this.fallbackEnv && process.env[name]?.trim()) {
      const value = process.env[name];
      this.cache.set(name, value);
      return value;
    }
    if (this.cache.has(name)) return this.cache.get(name);
    if (!this.dopplerToken || typeof this.fetchImplementation !== 'function') return null;
    const url = `https://api.doppler.com/v3/configs/config/secret?project=${encodeURIComponent(this.project)}&config=${encodeURIComponent(this.configName)}&name=${encodeURIComponent(name)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImplementation(url, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${this.dopplerToken}` },
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const payload = await response.json();
      const value = payload?.value?.raw || payload?.value?.computed || null;
      if (value) this.cache.set(name, value);
      return value;
    } catch (_) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { DopplerSecretManagerRuntime };
