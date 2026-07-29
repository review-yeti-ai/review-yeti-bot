import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Context7Adapter } from '../../src/mcp/context7Adapter';
import fs from 'node:fs';
import path from 'node:path';

describe('Context7Adapter', () => {
  let adapter: Context7Adapter;
  let testCacheDir: string;

  beforeEach(() => {
    testCacheDir = path.join(process.cwd(), '.tmp_context7_cache_' + Math.random().toString(36).substring(7));
    const mockDoppler = { getSecret: async (name: string) => process.env[name] || null } as any;
    adapter = new Context7Adapter({
      dopplerManager: mockDoppler,
      cacheDir: testCacheDir,
      cacheTtlMs: 5000,
    });
  });

  afterEach(() => {
    adapter.clearCache();
    if (fs.existsSync(testCacheDir)) {
      fs.rmSync(testCacheDir, { recursive: true, force: true });
    }
    vi.unstubAllGlobals();
  });

  it('returns degraded documentation result when CONTEXT7_API_KEY is missing', async () => {
    delete process.env.CONTEXT7_API_KEY;

    const result = await adapter.fetchDocs('express', 'middleware error handling');

    expect(result.degraded).toBe(true);
    expect(result.snippets.length).toBeGreaterThan(0);
    expect(result.snippets[0].title).toContain('express');
    expect(result.snippets[0].content.toLowerCase()).toContain('degraded');
  });

  it('does NOT cache degraded fallback results on disk or memory', async () => {
    delete process.env.CONTEXT7_API_KEY;

    const result1 = await adapter.fetchDocs('express', 'middleware error handling');
    expect(result1.degraded).toBe(true);

    // Disk cache should remain empty
    expect(fs.existsSync(testCacheDir)).toBe(false);

    // Subsequent call should attempt fetch again rather than returning cached degraded result
    const result2 = await adapter.fetchDocs('express', 'middleware error handling');
    expect(result2.cached).toBe(false);
  });

  it('successfully fetches and caches Context7 documentation from HTTP API', async () => {
    process.env.CONTEXT7_API_KEY = 'valid_mock_api_key_123';

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        sourceUrl: 'https://context7.ai/docs/react',
        snippets: [
          {
            title: 'useEffect Hook',
            content: 'useEffect(() => {}, []) runs once on mount.',
            url: 'https://react.dev/reference/react/useEffect',
            score: 0.92,
          },
          {
            title: 'useState Hook',
            content: 'const [state, setState] = useState(initialState)',
            url: 'https://react.dev/reference/react/useState',
            score: 0.85,
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    // 1. Initial live fetch
    const res1 = await adapter.fetchDocs('react', 'useEffect dependency array');

    expect(res1.degraded).toBe(false);
    expect(res1.cached).toBe(false);
    expect(res1.library).toBe('react');
    expect(res1.snippets.length).toBe(2);

    // 2. Second fetch hits cache
    const res2 = await adapter.fetchDocs('react', 'useEffect dependency array');
    expect(res2.cached).toBe(true);
    expect(res2.degraded).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    delete process.env.CONTEXT7_API_KEY;
  });

  it('satisfies runtime Array contract (.map, .forEach, .filter, for..of, Array.isArray)', async () => {
    process.env.CONTEXT7_API_KEY = 'valid_mock_api_key_123';

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        sourceUrl: 'https://context7.ai/docs/express',
        snippets: [
          {
            title: 'Error Handling',
            content: 'app.use((err, req, res, next) => {})',
            url: 'https://expressjs.com/guide/error-handling',
            score: 0.95,
          },
          {
            title: 'Routing Guide',
            content: 'app.get("/users", handler)',
            url: 'https://expressjs.com/guide/routing',
            score: 0.8,
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await adapter.fetchDocs('express', 'error handling');

    // Array contract assertions
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(2);

    // 1. .map()
    const titles = result.map((item) => item.title);
    expect(titles).toEqual(['Error Handling', 'Routing Guide']);

    // 2. .forEach()
    const collected: string[] = [];
    result.forEach((item) => collected.push(item.title));
    expect(collected).toEqual(['Error Handling', 'Routing Guide']);

    // 3. .filter()
    const highScoring = result.filter((item) => item.score > 0.9);
    expect(highScoring.length).toBe(1);
    expect(highScoring[0].title).toBe('Error Handling');

    // 4. for..of loop iteration
    const iterated: string[] = [];
    for (const item of result) {
      iterated.push(item.title);
    }
    expect(iterated).toEqual(['Error Handling', 'Routing Guide']);

    // Metadata properties are accessible alongside array methods
    expect(result.library).toBe('express');
    expect(result.query).toBe('error handling');
    expect(result.degraded).toBe(false);

    delete process.env.CONTEXT7_API_KEY;
  });

  it('clears memory and disk cache cleanly', async () => {
    process.env.CONTEXT7_API_KEY = 'mock_key_123';

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        snippets: [{ title: 'Zod Validation', content: 'z.string().parse("val")', score: 0.9 }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await adapter.fetchDocs('zod', 'schema validation');
    expect(fs.existsSync(testCacheDir)).toBe(true);

    adapter.clearCache();
    expect(fs.existsSync(testCacheDir)).toBe(false);

    delete process.env.CONTEXT7_API_KEY;
  });

  it('healthCheck reports false when API key is missing and true when present', async () => {
    delete process.env.CONTEXT7_API_KEY;
    const mockDoppler = { getSecret: async () => null } as any;
    const testAdapter = new Context7Adapter({ dopplerManager: mockDoppler });

    const health1 = await testAdapter.healthCheck();
    expect(health1.ok).toBe(false);

    process.env.CONTEXT7_API_KEY = 'valid_key_123';
    const health2 = await adapter.healthCheck();
    expect(health2.ok).toBe(true);
    expect(health2.message).toContain('operational');

    delete process.env.CONTEXT7_API_KEY;
  });
});
