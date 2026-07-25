import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../utils/logger';

const execFileAsync = promisify(execFile);

export interface DopplerConfig {
  project?: string;
  config?: string;
  fallbackEnv?: boolean;
  cacheTtlMs?: number; // default 300,000ms (5 minutes)
  cliPath?: string; // default 'doppler'
  dopplerToken?: string;
  timeoutMs?: number; // default 3,000ms
}

interface CachedSecret {
  value: string;
  expiresAt: number;
}

export class DopplerSecretManager {
  private readonly project: string;
  private readonly configName: string;
  private readonly fallbackEnv: boolean;
  private readonly cacheTtlMs: number;
  private readonly cliPath: string;
  private readonly dopplerToken: string | undefined;
  private readonly timeoutMs: number;
  private readonly cache: Map<string, CachedSecret>;

  constructor(config: DopplerConfig = {}) {
    this.project = config.project || process.env.DOPPLER_PROJECT || 'ct-review-bot';
    this.configName = config.config || process.env.DOPPLER_CONFIG || 'dev';
    this.fallbackEnv = config.fallbackEnv ?? true;
    this.cacheTtlMs = config.cacheTtlMs ?? 300_000; // 5 minutes
    this.cliPath = config.cliPath || 'doppler';
    this.dopplerToken = config.dopplerToken || process.env.DOPPLER_TOKEN;
    this.timeoutMs = config.timeoutMs ?? (process.env.NODE_ENV === 'test' ? 300 : 3_000);
    this.cache = new Map();
  }

  /**
   * Returns cached secret if present and valid without external calls.
   */
  public getCachedSecret(keyName: string): string | undefined {
    const cached = this.cache.get(keyName);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
    return undefined;
  }

  /**
   * Resolves a secret across 4 tiers: Process Env -> Cache -> Doppler CLI -> Doppler API.
   */
  public async getSecret(keyName: string): Promise<string | null> {
    // Tier 1: Process Environment
    if (this.fallbackEnv && process.env[keyName] && process.env[keyName]!.trim().length > 0) {
      const val = process.env[keyName]!;
      this.cache.set(keyName, { value: val, expiresAt: Date.now() + this.cacheTtlMs });
      return val;
    }

    // Tier 2: In-Memory TTL Cache
    const cached = this.getCachedSecret(keyName);
    if (cached !== undefined) {
      return cached;
    }

    // Tier 3: Doppler CLI
    const cliResult = await this.fetchFromCli(keyName);
    if (cliResult) {
      this.cache.set(keyName, { value: cliResult, expiresAt: Date.now() + this.cacheTtlMs });
      return cliResult;
    }

    // Tier 4: Doppler REST API
    const apiResult = await this.fetchFromApi(keyName);
    if (apiResult) {
      this.cache.set(keyName, { value: apiResult, expiresAt: Date.now() + this.cacheTtlMs });
      return apiResult;
    }

    return null;
  }

  /**
   * Resolves multiple secrets in parallel.
   */
  public async getSecrets(keyNames: string[]): Promise<Record<string, string | null>> {
    const results: Record<string, string | null> = {};
    await Promise.all(
      keyNames.map(async (key) => {
        results[key] = await this.getSecret(key);
      })
    );
    return results;
  }

  /**
   * Checks if Doppler CLI or API is operational.
   */
  public async isDopplerAvailable(): Promise<boolean> {
    try {
      await execFileAsync(this.cliPath, ['--version'], { timeout: 1000 });
      return true;
    } catch {
      return !!this.dopplerToken;
    }
  }

  /**
   * Clears in-memory secret cache.
   */
  public clearCache(): void {
    this.cache.clear();
  }

  private async fetchFromCli(keyName: string): Promise<string | null> {
    // Sanitize parameter to avoid shell injection
    if (!/^[A-Za-z0-9_]+$/.test(keyName)) {
      return null;
    }

    try {
      const { stdout } = await execFileAsync(
        this.cliPath,
        ['secrets', 'get', keyName, '--plain', '--project', this.project, '--config', this.configName],
        { timeout: this.timeoutMs }
      );
      const secret = stdout.trim();
      return secret.length > 0 ? secret : null;
    } catch {
      return null;
    }
  }

  private async fetchFromApi(keyName: string): Promise<string | null> {
    if (!this.dopplerToken) return null;

    try {
      const url = `https://api.doppler.com/v3/configs/config/secret?project=${encodeURIComponent(this.project)}&config=${encodeURIComponent(this.configName)}&name=${encodeURIComponent(keyName)}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

      const res = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${this.dopplerToken}`,
          'Accept': 'application/json',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!res.ok) return null;

      const data: any = await res.json();
      return data?.value?.raw || data?.value?.computed || null;
    } catch (err: any) {
      logger.debug('Doppler API request failed', { error: err.message });
      return null;
    }
  }
}
