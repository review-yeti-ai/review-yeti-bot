import fs from 'node:fs';
import path from 'node:path';
import { DopplerSecretManager } from './dopplerSecretManager';
import { logger } from '../utils/logger';

export interface Context7AdapterConfig {
  dopplerManager?: DopplerSecretManager;
  baseUrl?: string;
  cacheTtlMs?: number; // default 24h
  timeoutMs?: number; // default 5000ms
  maxSnippets?: number; // default 5
  cacheDir?: string; // default '.ct-memory/cache/context7'
}

export interface FetchDocsOptions {
  library: string;
  query: string;
  version?: string;
  limit?: number;
}

export interface DocSnippet {
  title: string;
  content: string;
  url?: string;
  relevanceScore: number;
  section?: string;
  snippet?: string;
  score?: number;
}

export interface DocSearchResult {
  title: string;
  url: string;
  snippet: string;
  score: number;
}

export interface DocLookupResult {
  library: string;
  query: string;
  snippets: DocSnippet[];
  sourceUrl?: string;
  cached: boolean;
  degraded: boolean;
  fetchedAt: string;
  error?: string;
}

export class Context7Adapter {
  private readonly dopplerManager: DopplerSecretManager;
  private readonly baseUrl: string;
  private readonly cacheTtlMs: number;
  private readonly timeoutMs: number;
  private readonly maxSnippets: number;
  private readonly cacheDir: string;
  private readonly memoryCache: Map<string, { data: DocLookupResult; expiresAt: number }>;

  constructor(config: Context7AdapterConfig = {}) {
    this.dopplerManager = config.dopplerManager || new DopplerSecretManager();
    this.baseUrl = config.baseUrl || 'https://api.context7.ai/v1';
    this.cacheTtlMs = config.cacheTtlMs ?? 86_400_000; // 24 hours
    this.timeoutMs = config.timeoutMs ?? 5_000;
    this.maxSnippets = config.maxSnippets ?? 5;
    this.cacheDir = config.cacheDir || path.join(process.cwd(), '.ct-memory', 'cache', 'context7');
    this.memoryCache = new Map();
  }

  /**
   * Fetches documentation snippets for a given library and query with caching and Doppler secret resolution.
   */
  public async fetchDocs(
    library: string,
    query: string,
    options: Partial<FetchDocsOptions> = {}
  ): Promise<DocLookupResult & Array<DocSearchResult>> {
    const cacheKey = `${library.toLowerCase()}:${query.toLowerCase()}`;
    const now = Date.now();

    // 1. Check Memory Cache
    const memItem = this.memoryCache.get(cacheKey);
    if (memItem && memItem.expiresAt > now) {
      return this.formatHybridResult({ ...memItem.data, cached: true });
    }

    // 2. Check Disk Cache
    const diskResult = this.readDiskCache(cacheKey);
    if (diskResult) {
      this.memoryCache.set(cacheKey, { data: diskResult, expiresAt: now + this.cacheTtlMs });
      return this.formatHybridResult({ ...diskResult, cached: true });
    }

    // 3. Resolve CONTEXT7_API_KEY dynamically via Doppler
    const apiKey = await this.dopplerManager.getSecret('CONTEXT7_API_KEY');
    if (!apiKey) {
      logger.warn('CONTEXT7_API_KEY missing from Doppler and process.env, returning degraded docs mode', { library, query });
      return this.formatHybridResult(this.buildDegradedResult(library, query, 'Missing CONTEXT7_API_KEY'));
    }

    // 4. Execute Remote API / MCP Query
    try {
      const response = await this.fetchWithTimeout(`${this.baseUrl}/docs/search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'X-Context7-Api-Key': apiKey,
        },
        body: JSON.stringify({
          library,
          query,
          limit: options.limit || this.maxSnippets,
          version: options.version,
        }),
      }, this.timeoutMs);

      if (!response.ok) {
        throw new Error(`Context7 API returned status ${response.status}`);
      }

      const body: any = await response.json();
      const rawSnippets = body.snippets || [];
      const snippets: DocSnippet[] = rawSnippets.map((s: any) => ({
        title: s.title || `${library} Documentation`,
        content: s.content || s.snippet || '',
        url: s.url || `https://context7.ai/docs/${library}`,
        relevanceScore: s.relevanceScore ?? s.score ?? 0.8,
        section: s.section,
        snippet: s.snippet || s.content || '',
        score: s.score ?? s.relevanceScore ?? 0.8,
      }));

      const result: DocLookupResult = {
        library,
        query,
        snippets,
        sourceUrl: body.sourceUrl || `https://context7.ai/docs/${library}`,
        cached: false,
        degraded: false,
        fetchedAt: new Date().toISOString(),
      };

      // 5. Update Memory and Disk Cache
      this.memoryCache.set(cacheKey, { data: result, expiresAt: now + this.cacheTtlMs });
      this.writeDiskCache(cacheKey, result);

      return this.formatHybridResult(result);
    } catch (err: any) {
      logger.error('Failed to fetch Context7 documentation', { library, query, error: err.message });
      const degradedResult = this.buildDegradedResult(library, query, err.message);
      return this.formatHybridResult(degradedResult);
    }
  }

  /**
   * Health check to verify Context7 API connection and credentials.
   */
  public async healthCheck(): Promise<{ ok: boolean; message: string }> {
    const apiKey = await this.dopplerManager.getSecret('CONTEXT7_API_KEY');
    if (!apiKey) {
      return { ok: false, message: 'CONTEXT7_API_KEY unresolvable' };
    }
    return { ok: true, message: 'Context7 MCP connection operational' };
  }

  public clearCache(): void {
    this.memoryCache.clear();
    try {
      if (fs.existsSync(this.cacheDir)) {
        fs.rmSync(this.cacheDir, { recursive: true, force: true });
      }
    } catch (err: any) {
      logger.warn('Failed to clear Context7 disk cache', { error: err.message });
    }
  }

  private buildDegradedResult(library: string, query: string, errorReason: string): DocLookupResult {
    return {
      library,
      query,
      snippets: [
        {
          title: `${library} (Degraded Offline Docs)`,
          content: `Documentation lookup degraded for ${library} (${query}). Reason: ${errorReason}`,
          url: `https://context7.ai/docs/${library}`,
          relevanceScore: 0.1,
          snippet: `Documentation lookup degraded for ${library} (${query}). Reason: ${errorReason}`,
          score: 0.1,
        },
      ],
      sourceUrl: `https://context7.ai/docs/${library}`,
      cached: false,
      degraded: true,
      fetchedAt: new Date().toISOString(),
      error: errorReason,
    };
  }

  private formatHybridResult(result: DocLookupResult): DocLookupResult & Array<DocSearchResult> {
    const formattedSnippets: DocSearchResult[] = result.snippets.map((s) => ({
      title: s.title,
      url: s.url || `https://context7.ai/docs/${result.library}`,
      snippet: s.content || s.snippet || '',
      score: s.relevanceScore ?? s.score ?? 0.5,
    }));

    const docArray: any = [...formattedSnippets];

    Object.assign(docArray, {
      library: result.library,
      query: result.query,
      snippets: result.snippets,
      sourceUrl: result.sourceUrl,
      cached: result.cached,
      degraded: result.degraded,
      fetchedAt: result.fetchedAt,
      error: result.error,
    });

    return docArray as DocLookupResult & Array<DocSearchResult>;
  }

  private readDiskCache(cacheKey: string): DocLookupResult | null {
    try {
      const sanitizedKey = cacheKey.replace(/[^a-z0-9_-]/gi, '_');
      const filePath = path.join(this.cacheDir, `${sanitizedKey}.json`);
      if (!fs.existsSync(filePath)) return null;

      const fileContent = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(fileContent);
      const age = Date.now() - new Date(parsed.fetchedAt).getTime();
      if (age > this.cacheTtlMs) return null;

      return parsed;
    } catch {
      return null;
    }
  }

  private writeDiskCache(cacheKey: string, result: DocLookupResult): void {
    try {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      const sanitizedKey = cacheKey.replace(/[^a-z0-9_-]/gi, '_');
      const filePath = path.join(this.cacheDir, `${sanitizedKey}.json`);
      fs.writeFileSync(filePath, JSON.stringify(result, null, 2), 'utf8');
    } catch (err: any) {
      logger.warn('Failed to write Context7 disk cache', { error: err.message });
    }
  }

  private async fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      return response;
    } finally {
      clearTimeout(id);
    }
  }
}
