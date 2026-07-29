import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('node:child_process', () => {
  const execFile = vi.fn((file: string, args: string[], options: any, callback: any) => {
    const cb = typeof options === 'function' ? options : callback;
    if (typeof file === 'string' && file.includes('non_existent_doppler_binary')) {
      return cb(new Error('ENOENT: no such file or directory'), { stdout: '', stderr: '' });
    }
    if (args && args.includes('--version')) {
      return cb(null, { stdout: 'doppler v3.60.0\n', stderr: '' });
    }
    if (args && args.includes('CLI_MOCK_KEY')) {
      return cb(null, { stdout: 'cli_mock_value_123\n', stderr: '' });
    }
    if (args && args.includes('CLI_FAIL_KEY')) {
      return cb(new Error('Secret CLI_FAIL_KEY not found'), { stdout: '', stderr: 'Error: secret not found' });
    }
    return cb(new Error('Command failed'), { stdout: '', stderr: 'Execution error' });
  });
  return {
    execFile,
    default: { execFile },
  };
});

import { DopplerSecretManager } from '../../src/mcp/dopplerSecretManager';
import { Context7Adapter } from '../../src/mcp/context7Adapter';

describe('Milestone 8 Challenger: Doppler Secret Routing & Context7 MCP', () => {
  const originalEnvKey = process.env.CONTEXT7_API_KEY;
  const originalDopplerToken = process.env.DOPPLER_TOKEN;

  beforeEach(() => {
    delete process.env.CONTEXT7_API_KEY;
    delete process.env.DOPPLER_TOKEN;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    if (originalEnvKey !== undefined) {
      process.env.CONTEXT7_API_KEY = originalEnvKey;
    } else {
      delete process.env.CONTEXT7_API_KEY;
    }

    if (originalDopplerToken !== undefined) {
      process.env.DOPPLER_TOKEN = originalDopplerToken;
    } else {
      delete process.env.DOPPLER_TOKEN;
    }

    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('Doppler Secret Resolution Fallbacks', () => {
    it('handles missing Doppler CLI binary gracefully without crashing', async () => {
      const doppler = new DopplerSecretManager({
        cliPath: 'non_existent_doppler_binary_12345',
        fallbackEnv: false,
        timeoutMs: 100,
      });

      const secret = await doppler.getSecret('CONTEXT7_API_KEY');
      expect(secret).toBeNull();

      const available = await doppler.isDopplerAvailable();
      expect(available).toBe(false);
    });

    it('falls back to Doppler REST API when CLI is unavailable or fails', async () => {
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ value: { raw: 'api_secret_token_999' } }),
      });
      vi.stubGlobal('fetch', fetchSpy);

      const doppler = new DopplerSecretManager({
        cliPath: 'non_existent_doppler_binary_12345',
        dopplerToken: 'mock_doppler_token_xyz',
        fallbackEnv: false,
      });

      const secret = await doppler.getSecret('CONTEXT7_API_KEY');
      expect(secret).toBe('api_secret_token_999');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('handles Doppler API network timeout gracefully', async () => {
      const fetchSpy = vi.fn().mockImplementation(() => {
        return new Promise((_, reject) => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          setTimeout(() => reject(err), 50);
        });
      });
      vi.stubGlobal('fetch', fetchSpy);

      const doppler = new DopplerSecretManager({
        cliPath: 'non_existent_doppler_binary',
        dopplerToken: 'mock_doppler_token_xyz',
        fallbackEnv: false,
        timeoutMs: 10,
      });

      const secret = await doppler.getSecret('TIMEOUT_KEY');
      expect(secret).toBeNull();
    });

    it('handles corrupt/malformed API response payload gracefully', async () => {
      // 1. Non-200 HTTP status
      const fetchSpy1 = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ error: 'Internal Doppler Error' }),
      });
      vi.stubGlobal('fetch', fetchSpy1);

      const doppler = new DopplerSecretManager({
        cliPath: 'non_existent_doppler_binary',
        dopplerToken: 'mock_token',
        fallbackEnv: false,
      });

      const res1 = await doppler.getSecret('CORRUPT_KEY_1');
      expect(res1).toBeNull();

      // 2. 200 OK but invalid/missing value structure
      const fetchSpy2 = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ unexpected_schema: true }),
      });
      vi.stubGlobal('fetch', fetchSpy2);

      const res2 = await doppler.getSecret('CORRUPT_KEY_2');
      expect(res2).toBeNull();

      // 3. 200 OK but JSON parse throws
      const fetchSpy3 = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON at position 0');
        },
      });
      vi.stubGlobal('fetch', fetchSpy3);

      const res3 = await doppler.getSecret('CORRUPT_KEY_3');
      expect(res3).toBeNull();
    });

    it('respects 4-tier fallback precedence (Env -> Cache -> CLI -> API)', async () => {
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ value: { raw: 'tier_4_api_val' } }),
      });
      vi.stubGlobal('fetch', fetchSpy);

      const doppler = new DopplerSecretManager({
        cliPath: 'non_existent_doppler_binary',
        dopplerToken: 'mock_token',
        fallbackEnv: true,
      });

      // Tier 1: Process Env
      process.env.TIER_TEST_KEY = 'tier_1_env_val';
      const t1 = await doppler.getSecret('TIER_TEST_KEY');
      expect(t1).toBe('tier_1_env_val');

      // Tier 2: Cache (remove process env, should return cached)
      delete process.env.TIER_TEST_KEY;
      const t2 = await doppler.getSecret('TIER_TEST_KEY');
      expect(t2).toBe('tier_1_env_val');

      // Clear cache and test Tier 4 API fallback
      doppler.clearCache();
      const t4 = await doppler.getSecret('TIER_TEST_KEY');
      expect(t4).toBe('tier_4_api_val');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('Context7 MCP Client Retry & Error Handling', () => {
    let testCacheDir: string;

    beforeEach(() => {
      testCacheDir = path.join(process.cwd(), '.tmp_m8_challenger_cache_' + Math.random().toString(36).substring(7));
    });

    afterEach(() => {
      if (fs.existsSync(testCacheDir)) {
        fs.rmSync(testCacheDir, { recursive: true, force: true });
      }
    });

    it('falls back to degraded mode when Context7 API fails and allows recovery after cache clear', async () => {
      process.env.CONTEXT7_API_KEY = 'valid_mock_api_key';

      // 1. Initial call fails (503 Service Unavailable)
      const fetchSpy = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
      });
      vi.stubGlobal('fetch', fetchSpy);

      const mockDoppler = new DopplerSecretManager({ fallbackEnv: true });
      const adapter = new Context7Adapter({
        dopplerManager: mockDoppler,
        cacheDir: testCacheDir,
        timeoutMs: 1000,
      });

      const res1 = await adapter.fetchDocs('express', 'error-handling');
      expect(res1.degraded).toBe(true);
      expect(res1.error).toContain('Context7 API returned status 503');

      // 2. Service recovers: clear cache and retry
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          snippets: [
            { title: 'Express Error Handling', content: 'app.use((err, req, res, next) => {...})', score: 0.95 },
          ],
          sourceUrl: 'https://context7.ai/docs/express',
        }),
      });

      adapter.clearCache();

      const res2 = await adapter.fetchDocs('express', 'error-handling');
      expect(res2.degraded).toBe(false);
      expect(res2.cached).toBe(false);
      expect(res2.snippets.length).toBe(1);
      expect(res2.snippets[0].title).toBe('Express Error Handling');
    });

    it('handles malformed API response without throwing runtime exception', async () => {
      process.env.CONTEXT7_API_KEY = 'valid_mock_api_key';

      const fetchSpy = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          snippets: null, // missing array
        }),
      });
      vi.stubGlobal('fetch', fetchSpy);

      const adapter = new Context7Adapter({
        cacheDir: testCacheDir,
      });

      const res = await adapter.fetchDocs('lodash', 'debounce');
      expect(res.degraded).toBe(false);
      expect(res.snippets).toEqual([]);
      expect(res.length).toBe(0);
    });
  });

  describe('24h Cache Eviction & Expiry', () => {
    let testCacheDir: string;

    beforeEach(() => {
      testCacheDir = path.join(process.cwd(), '.tmp_m8_cache_evict_' + Math.random().toString(36).substring(7));
    });

    afterEach(() => {
      if (fs.existsSync(testCacheDir)) {
        fs.rmSync(testCacheDir, { recursive: true, force: true });
      }
    });

    it('evicts memory cache item when cacheTtlMs expires', async () => {
      process.env.CONTEXT7_API_KEY = 'valid_mock_api_key';

      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          snippets: [{ title: 'Doc Sample', content: 'Content', score: 0.9 }],
        }),
      });
      vi.stubGlobal('fetch', fetchSpy);

      const adapter = new Context7Adapter({
        cacheDir: testCacheDir,
        cacheTtlMs: 200, // 200ms TTL for testing
      });

      // 1. Initial fetch -> cached: false
      const res1 = await adapter.fetchDocs('react', 'state');
      expect(res1.cached).toBe(false);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // 2. Immediate fetch -> cached: true
      const res2 = await adapter.fetchDocs('react', 'state');
      expect(res2.cached).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // 3. Wait 220ms for cache eviction
      await new Promise((r) => setTimeout(r, 220));

      // 4. Fetch after TTL expiry -> cached: false, triggers fresh fetch
      const res3 = await adapter.fetchDocs('react', 'state');
      expect(res3.cached).toBe(false);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('ignores disk cache file if older than 24h (cacheTtlMs)', async () => {
      process.env.CONTEXT7_API_KEY = 'valid_mock_api_key';

      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          snippets: [{ title: 'Fresh Doc', content: 'Fresh Content', score: 0.99 }],
        }),
      });
      vi.stubGlobal('fetch', fetchSpy);

      const adapter = new Context7Adapter({
        cacheDir: testCacheDir,
        cacheTtlMs: 86_400_000, // 24 hours
      });

      // Write stale disk cache file (25 hours old)
      fs.mkdirSync(testCacheDir, { recursive: true });
      const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      const staleData = {
        library: 'vue',
        query: 'reactivity',
        snippets: [{ title: 'Stale Doc', content: 'Stale Content', relevanceScore: 0.5 }],
        sourceUrl: 'https://context7.ai/docs/vue',
        cached: false,
        degraded: false,
        fetchedAt: staleDate,
      };

      const cacheKeyPath = path.join(testCacheDir, 'vue_reactivity.json');
      fs.writeFileSync(cacheKeyPath, JSON.stringify(staleData, null, 2), 'utf8');

      // Fetch docs for vue reactivity -> should bypass stale disk cache and fetch fresh
      const res = await adapter.fetchDocs('vue', 'reactivity');
      expect(res.cached).toBe(false);
      expect(res.snippets[0].title).toBe('Fresh Doc');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('uses valid disk cache file if younger than 24h', async () => {
      process.env.CONTEXT7_API_KEY = 'valid_mock_api_key';

      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const adapter = new Context7Adapter({
        cacheDir: testCacheDir,
        cacheTtlMs: 86_400_000, // 24 hours
      });

      // Write valid disk cache file (1 hour old)
      fs.mkdirSync(testCacheDir, { recursive: true });
      const validDate = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
      const validData = {
        library: 'vue',
        query: 'reactivity',
        snippets: [{ title: 'Valid Cached Doc', content: 'Cached Content', relevanceScore: 0.9 }],
        sourceUrl: 'https://context7.ai/docs/vue',
        cached: false,
        degraded: false,
        fetchedAt: validDate,
      };

      const cacheKeyPath = path.join(testCacheDir, 'vue_reactivity.json');
      fs.writeFileSync(cacheKeyPath, JSON.stringify(validData, null, 2), 'utf8');

      const res = await adapter.fetchDocs('vue', 'reactivity');
      expect(res.cached).toBe(true);
      expect(res.snippets[0].title).toBe('Valid Cached Doc');
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('Degraded Mode Behavior', () => {
    let testCacheDir: string;

    beforeEach(() => {
      testCacheDir = path.join(process.cwd(), '.tmp_m8_degraded_' + Math.random().toString(36).substring(7));
    });

    afterEach(() => {
      if (fs.existsSync(testCacheDir)) {
        fs.rmSync(testCacheDir, { recursive: true, force: true });
      }
    });

    it('returns degraded documentation mode when CONTEXT7_API_KEY is unresolvable', async () => {
      delete process.env.CONTEXT7_API_KEY;

      const doppler = new DopplerSecretManager({
        cliPath: 'non_existent_doppler_cli',
        fallbackEnv: true,
      });

      const adapter = new Context7Adapter({
        dopplerManager: doppler,
        cacheDir: testCacheDir,
      });

      const result = await adapter.fetchDocs('nextjs', 'app router');

      expect(result.degraded).toBe(true);
      expect(result.error).toBe('Missing CONTEXT7_API_KEY');
      expect(result.snippets.length).toBe(1);
      expect(result.snippets[0].title).toContain('nextjs');
      expect(result.snippets[0].content).toContain('Missing CONTEXT7_API_KEY');
      // Hybrid array verification
      expect(result[0].title).toContain('nextjs');
      expect(result.length).toBe(1);
    });

    it('returns degraded documentation mode on network error during fetch', async () => {
      process.env.CONTEXT7_API_KEY = 'mock_key_xyz';

      const fetchSpy = vi.fn().mockRejectedValue(new TypeError('fetch failed: ECONNREFUSED'));
      vi.stubGlobal('fetch', fetchSpy);

      const adapter = new Context7Adapter({
        cacheDir: testCacheDir,
      });

      const result = await adapter.fetchDocs('prisma', 'orm migration');

      expect(result.degraded).toBe(true);
      expect(result.error).toContain('fetch failed: ECONNREFUSED');
      expect(result.snippets[0].content).toContain('fetch failed: ECONNREFUSED');
    });

    it('healthCheck correctly reflects CONTEXT7_API_KEY availability', async () => {
      const doppler = new DopplerSecretManager({
        cliPath: 'non_existent_cli',
        fallbackEnv: true,
      });
      const adapter = new Context7Adapter({ dopplerManager: doppler });

      // Missing key -> healthCheck false
      delete process.env.CONTEXT7_API_KEY;
      const h1 = await adapter.healthCheck();
      expect(h1.ok).toBe(false);
      expect(h1.message).toContain('unresolvable');

      // Key present -> healthCheck true
      process.env.CONTEXT7_API_KEY = 'mock_active_key';
      const h2 = await adapter.healthCheck();
      expect(h2.ok).toBe(true);
      expect(h2.message).toContain('operational');
    });
  });

  describe('Array Contract Methods & Hybrid Object Verification', () => {
    let testCacheDir: string;

    beforeEach(() => {
      testCacheDir = path.join(process.cwd(), '.tmp_m8_array_contract_' + Math.random().toString(36).substring(7));
      process.env.CONTEXT7_API_KEY = 'valid_mock_api_key';
    });

    afterEach(() => {
      if (fs.existsSync(testCacheDir)) {
        fs.rmSync(testCacheDir, { recursive: true, force: true });
      }
    });

    it('satisfies Array contract (.map, .filter, .forEach, for..of) on valid API response', async () => {
      const fetchSpy = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          snippets: [
            { title: 'Doc 1', content: 'Content 1', score: 0.9, url: 'https://context7.ai/doc1' },
            { title: 'Doc 2', content: 'Content 2', score: 0.7, url: 'https://context7.ai/doc2' },
            { title: 'Doc 3', content: 'Content 3', score: 0.5, url: 'https://context7.ai/doc3' },
          ],
          sourceUrl: 'https://context7.ai/docs/test',
        }),
      });
      vi.stubGlobal('fetch', fetchSpy);

      const adapter = new Context7Adapter({ cacheDir: testCacheDir });
      const res = await adapter.fetchDocs('test-lib', 'query');

      // Array.isArray & length
      expect(Array.isArray(res)).toBe(true);
      expect(res.length).toBe(3);

      // Indexing
      expect(res[0].title).toBe('Doc 1');
      expect(res[1].title).toBe('Doc 2');
      expect(res[2].title).toBe('Doc 3');

      // .map()
      const titles = res.map((item) => item.title);
      expect(titles).toEqual(['Doc 1', 'Doc 2', 'Doc 3']);
      expect(Array.isArray(titles)).toBe(true);

      // .filter()
      const highScoring = res.filter((item) => item.score > 0.6);
      expect(highScoring.length).toBe(2);
      expect(highScoring[0].title).toBe('Doc 1');
      expect(highScoring[1].title).toBe('Doc 2');

      // .forEach()
      const iterated: string[] = [];
      res.forEach((item, index, arr) => {
        expect(arr).toBe(res);
        iterated.push(`${index}:${item.title}`);
      });
      expect(iterated).toEqual(['0:Doc 1', '1:Doc 2', '2:Doc 3']);

      // for..of loop
      const collected: string[] = [];
      for (const item of res) {
        collected.push(item.title);
      }
      expect(collected).toEqual(['Doc 1', 'Doc 2', 'Doc 3']);

      // Additional array methods (.reduce, .slice, .find, .some, .every)
      const totalScore = res.reduce((sum, item) => sum + item.score, 0);
      expect(totalScore).toBeCloseTo(2.1);

      const sliced = res.slice(1, 3);
      expect(sliced.length).toBe(2);
      expect(sliced[0].title).toBe('Doc 2');

      const found = res.find((item) => item.score === 0.7);
      expect(found?.title).toBe('Doc 2');

      expect(res.some((item) => item.score > 0.8)).toBe(true);
      expect(res.every((item) => item.score > 0.1)).toBe(true);

      // Verify metadata properties attached to hybrid result
      expect(res.library).toBe('test-lib');
      expect(res.query).toBe('query');
      expect(res.degraded).toBe(false);
      expect(res.cached).toBe(false);
      expect(res.sourceUrl).toBe('https://context7.ai/docs/test');
      expect(res.snippets.length).toBe(3);
    });

    it('satisfies Array contract (.map, .filter, .forEach, for..of) on degraded result', async () => {
      delete process.env.CONTEXT7_API_KEY;

      const doppler = new DopplerSecretManager({ cliPath: 'non_existent_doppler_binary_123', fallbackEnv: true });
      const adapter = new Context7Adapter({ dopplerManager: doppler, cacheDir: testCacheDir });

      const res = await adapter.fetchDocs('degraded-lib', 'query');

      expect(Array.isArray(res)).toBe(true);
      expect(res.length).toBe(1);
      expect(res.degraded).toBe(true);

      // .map()
      const mapped = res.map((s) => s.title);
      expect(mapped.length).toBe(1);
      expect(mapped[0]).toContain('degraded-lib');

      // .filter()
      const filtered = res.filter((s) => s.score > 0.05);
      expect(filtered.length).toBe(1);

      // .forEach()
      let count = 0;
      res.forEach((s) => count++);
      expect(count).toBe(1);

      // for..of
      let loopCount = 0;
      for (const s of res) {
        loopCount++;
        expect(s.snippet).toContain('Missing CONTEXT7_API_KEY');
      }
      expect(loopCount).toBe(1);
    });
  });

  describe('Cache Non-Poisoning on Degraded Errors', () => {
    let testCacheDir: string;

    beforeEach(() => {
      testCacheDir = path.join(process.cwd(), '.tmp_m8_cache_poison_' + Math.random().toString(36).substring(7));
      process.env.CONTEXT7_API_KEY = 'valid_mock_api_key';
    });

    afterEach(() => {
      if (fs.existsSync(testCacheDir)) {
        fs.rmSync(testCacheDir, { recursive: true, force: true });
      }
    });

    it('does NOT poison cache when network error occurs, recovering automatically on next request without clearCache', async () => {
      // Step 1: Request fails due to network error
      const fetchSpy = vi.fn().mockRejectedValueOnce(new TypeError('Network unreachable'));
      vi.stubGlobal('fetch', fetchSpy);

      const adapter = new Context7Adapter({ cacheDir: testCacheDir });

      const degradedRes = await adapter.fetchDocs('react', 'hooks');
      expect(degradedRes.degraded).toBe(true);
      expect(degradedRes.error).toContain('Network unreachable');

      // Step 2: Network recovers. DO NOT call clearCache().
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          snippets: [{ title: 'React Hooks Guide', content: 'useState and useEffect', score: 0.95 }],
          sourceUrl: 'https://context7.ai/docs/react',
        }),
      });

      const recoveredRes = await adapter.fetchDocs('react', 'hooks');
      expect(recoveredRes.degraded).toBe(false);
      expect(recoveredRes.cached).toBe(false); // Proves it was not served from a poisoned cache!
      expect(recoveredRes.snippets[0].title).toBe('React Hooks Guide');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('does NOT poison cache when API key is missing initially, recovering automatically when key becomes available', async () => {
      delete process.env.CONTEXT7_API_KEY;

      const doppler = new DopplerSecretManager({ cliPath: 'non_existent_doppler_binary_123', fallbackEnv: true });
      const adapter = new Context7Adapter({ dopplerManager: doppler, cacheDir: testCacheDir });

      // Step 1: Missing API key returns degraded result
      const res1 = await adapter.fetchDocs('vue', 'pinia');
      expect(res1.degraded).toBe(true);

      // Step 2: API key is now provided in process.env. DO NOT call adapter.clearCache().
      process.env.CONTEXT7_API_KEY = 'newly_provided_key';

      const fetchSpy = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          snippets: [{ title: 'Pinia Store', content: 'defineStore(...)', score: 0.9 }],
        }),
      });
      vi.stubGlobal('fetch', fetchSpy);

      const res2 = await adapter.fetchDocs('vue', 'pinia');
      expect(res2.degraded).toBe(false);
      expect(res2.cached).toBe(false);
      expect(res2.snippets[0].title).toBe('Pinia Store');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('does NOT poison cache on HTTP 500 error responses', async () => {
      const fetchSpy = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });
      vi.stubGlobal('fetch', fetchSpy);

      const adapter = new Context7Adapter({ cacheDir: testCacheDir });

      const res1 = await adapter.fetchDocs('express', 'middleware');
      expect(res1.degraded).toBe(true);

      // Recovery without clearCache
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          snippets: [{ title: 'Express Middleware', content: 'app.use(...)', score: 0.88 }],
        }),
      });

      const res2 = await adapter.fetchDocs('express', 'middleware');
      expect(res2.degraded).toBe(false);
      expect(res2.cached).toBe(false);
      expect(res2.snippets[0].title).toBe('Express Middleware');
    });
  });

  describe('Doppler CLI & API Mock Path Stress Tests', () => {
    it('successfully resolves secret via Doppler CLI when CLI is operational', async () => {
      const doppler = new DopplerSecretManager({
        cliPath: 'doppler',
        fallbackEnv: false,
      });

      const secret = await doppler.getSecret('CLI_MOCK_KEY');
      expect(secret).toBe('cli_mock_value_123');
    });

    it('falls back to API when CLI fails with execution error', async () => {
      const fetchSpy = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ value: { raw: 'api_fallback_val_777' } }),
      });
      vi.stubGlobal('fetch', fetchSpy);

      const doppler = new DopplerSecretManager({
        cliPath: 'doppler',
        dopplerToken: 'valid_doppler_token',
        fallbackEnv: false,
      });

      const secret = await doppler.getSecret('CLI_FAIL_KEY');
      expect(secret).toBe('api_fallback_val_777');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('sanitizes input and bypasses CLI execution for secret keys containing invalid characters', async () => {
      const fetchSpy = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ value: { raw: 'sanitized_api_val' } }),
      });
      vi.stubGlobal('fetch', fetchSpy);

      const doppler = new DopplerSecretManager({
        cliPath: 'doppler',
        dopplerToken: 'valid_token',
        fallbackEnv: false,
      });

      // Key containing semicolon or space should bypass CLI regex check /^[A-Za-z0-9_]+$/
      const secret = await doppler.getSecret('INVALID;KEY_NAME');
      expect(secret).toBe('sanitized_api_val');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('batch resolves multiple secrets in parallel across Env, CLI, API, and Missing', async () => {
      process.env.ENV_KEY = 'env_value';

      const fetchSpy = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('API_ONLY_KEY')) {
          return {
            ok: true,
            json: async () => ({ value: { raw: 'api_value' } }),
          };
        }
        return { ok: false };
      });
      vi.stubGlobal('fetch', fetchSpy);

      const doppler = new DopplerSecretManager({
        cliPath: 'doppler',
        dopplerToken: 'token_123',
        fallbackEnv: true,
      });

      const results = await doppler.getSecrets([
        'ENV_KEY',
        'CLI_MOCK_KEY',
        'API_ONLY_KEY',
        'NON_EXISTENT_KEY',
      ]);

      expect(results.ENV_KEY).toBe('env_value');
      expect(results.CLI_MOCK_KEY).toBe('cli_mock_value_123');
      expect(results.API_ONLY_KEY).toBe('api_value');
      expect(results.NON_EXISTENT_KEY).toBeNull();
    });

    it('correctly reports Doppler availability based on CLI or token fallback', async () => {
      // 1. CLI version check succeeds
      const d1 = new DopplerSecretManager({ cliPath: 'doppler' });
      expect(await d1.isDopplerAvailable()).toBe(true);

      // 2. CLI version check fails, but dopplerToken is present
      const d2 = new DopplerSecretManager({
        cliPath: 'non_existent_doppler_binary',
        dopplerToken: 'token_abc',
      });
      expect(await d2.isDopplerAvailable()).toBe(true);

      // 3. CLI version check fails and no dopplerToken
      const d3 = new DopplerSecretManager({
        cliPath: 'non_existent_doppler_binary',
      });
      expect(await d3.isDopplerAvailable()).toBe(false);
    });
  });
});
