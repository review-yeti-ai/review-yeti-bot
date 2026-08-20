import { describe, expect, it, vi } from 'vitest';

const {
  CACHE_KEY_PREFIX,
  cacheKeyFor,
  cacheKeyPrefix,
  parseIndexedSha,
  restoreWarmZoektIndex,
  saveWarmZoektIndex,
} = require('../../src/mcp/zoektIndexCache.js');

const REPO = 'review-yeti-ai/review-yeti-bot';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

describe('cache key format', () => {
  it('is stable, prefixed, and round-trips the indexed SHA', () => {
    const key = cacheKeyFor(REPO, SHA_A);
    expect(key).toBe(`${CACHE_KEY_PREFIX}-review-yeti-ai__review-yeti-bot-${SHA_A}`);
    expect(key.startsWith(cacheKeyPrefix(REPO))).toBe(true);
    expect(parseIndexedSha(key, REPO)).toBe(SHA_A);
  });

  it('never mixes up two different repositories with a similar prefix', () => {
    // Without an explicit separator this would collide: "owner/repo-a" and "owner/repo".
    const keyA = cacheKeyFor('owner/repo-a', SHA_A);
    expect(parseIndexedSha(keyA, 'owner/repo')).toBeNull();
  });

  it('rejects a key that does not belong to the given repository or does not carry a real SHA', () => {
    expect(parseIndexedSha(`${CACHE_KEY_PREFIX}-someone-else__other-repo-${SHA_A}`, REPO)).toBeNull();
    expect(parseIndexedSha(`${cacheKeyPrefix(REPO)}not-a-sha`, REPO)).toBeNull();
    expect(parseIndexedSha(undefined, REPO)).toBeNull();
  });
});

describe('restoreWarmZoektIndex', () => {
  it('restores a warm index and reports the exact indexed SHA the matched key carries', async () => {
    const restoreCache = vi.fn(async (_paths: string[], _primaryKey: string, restoreKeys?: string[]) => {
      expect(restoreKeys).toEqual([cacheKeyPrefix(REPO)]);
      return cacheKeyFor(REPO, SHA_A);
    });
    const result = await restoreWarmZoektIndex({ repository: REPO, indexDir: '/tmp/whatever', cacheImpl: { restoreCache } });
    expect(result).toMatchObject({ status: 'ok', indexDir: '/tmp/whatever', indexedSha: SHA_A });
    expect(restoreCache).toHaveBeenCalledTimes(1);
  });

  it('falls through to unavailable on a real cache miss, without throwing', async () => {
    const restoreCache = vi.fn(async () => undefined);
    const result = await restoreWarmZoektIndex({ repository: REPO, indexDir: '/tmp/whatever', cacheImpl: { restoreCache } });
    expect(result).toMatchObject({ status: 'unavailable', reason: 'cache_miss' });
  });

  it('fails soft, never throws, when the cache service call itself errors', async () => {
    const restoreCache = vi.fn(async () => { throw new Error('ECONNRESET'); });
    const result = await restoreWarmZoektIndex({ repository: REPO, indexDir: '/tmp/whatever', cacheImpl: { restoreCache } });
    expect(result).toMatchObject({ status: 'unavailable', reason: 'cache_restore_failed' });
  });

  it('fails soft when the matched key cannot be parsed back into a real SHA for this repository', async () => {
    const restoreCache = vi.fn(async () => 'not-our-key-format');
    const result = await restoreWarmZoektIndex({ repository: REPO, indexDir: '/tmp/whatever', cacheImpl: { restoreCache } });
    expect(result).toMatchObject({ status: 'unavailable', reason: 'cache_key_unparseable' });
  });

  it('rejects a malformed repository or missing indexDir before ever calling the cache service', async () => {
    const restoreCache = vi.fn();
    expect(await restoreWarmZoektIndex({ repository: '../not-a-repo', indexDir: '/tmp/x', cacheImpl: { restoreCache } }))
      .toMatchObject({ status: 'unavailable', reason: 'invalid_identity' });
    expect(await restoreWarmZoektIndex({ repository: REPO, indexDir: '', cacheImpl: { restoreCache } }))
      .toMatchObject({ status: 'unavailable', reason: 'index_dir_invalid' });
    expect(restoreCache).not.toHaveBeenCalled();
  });

  it('fails soft and fast when no GitHub Actions cache service is configured for this runtime', async () => {
    // Outside a real GitHub Actions runner (local dev, `node bin/reviewyeti.js`) @actions/cache IS
    // installed (it's a real dependency) but ACTIONS_CACHE_URL/ACTIONS_RESULTS_URL are absent.
    // isFeatureAvailable() must short-circuit this synchronously -- never fall through to a real
    // network retry/backoff, which is what silently made this exact test hang for 5s before the
    // precondition check was added.
    //
    // This must hold regardless of the ambient environment this test itself runs in -- a real
    // GitHub Actions runner (this repo's own CI) DOES have these set for every job by default, and
    // some other test-running environment could too, either of which would otherwise route this
    // test through @actions/cache's real (network-backed) isFeatureAvailable() check instead of
    // the "unset" case this test exists to prove. Clear all three env vars @actions/cache's own
    // getCacheServiceVersion()/isFeatureAvailable() read (ACTIONS_CACHE_SERVICE_V2 selects v1 vs
    // v2; the URL var is version-dependent) and restore them exactly afterward, so this test's
    // result never depends on what happens to be exported around it.
    const ENV_KEYS = ['ACTIONS_CACHE_SERVICE_V2', 'ACTIONS_CACHE_URL', 'ACTIONS_RESULTS_URL'] as const;
    const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of ENV_KEYS) delete process.env[key];
    try {
      const startedAt = Date.now();
      const result = await restoreWarmZoektIndex({ repository: REPO, indexDir: '/tmp/whatever' });
      expect(Date.now() - startedAt).toBeLessThan(500);
      expect(result).toMatchObject({ status: 'unavailable', reason: 'cache_service_unavailable' });
    } finally {
      for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });
});

describe('saveWarmZoektIndex', () => {
  it('saves under the exact key format restoreWarmZoektIndex expects to parse back', async () => {
    const saveCache = vi.fn(async () => 42);
    const result = await saveWarmZoektIndex({ repository: REPO, indexedSha: SHA_B, indexDir: '/tmp/index', cacheImpl: { saveCache } });
    expect(result).toMatchObject({ status: 'ok', key: cacheKeyFor(REPO, SHA_B) });
    expect(saveCache).toHaveBeenCalledWith(['/tmp/index'], cacheKeyFor(REPO, SHA_B));
  });

  it('fails soft, never throws, when the save itself fails (e.g. a duplicate key race)', async () => {
    const saveCache = vi.fn(async () => { throw new Error('cache entry already exists'); });
    const result = await saveWarmZoektIndex({ repository: REPO, indexedSha: SHA_B, indexDir: '/tmp/index', cacheImpl: { saveCache } });
    expect(result).toMatchObject({ status: 'unavailable', reason: 'cache_save_failed' });
  });

  it('rejects an invalid identity before ever calling the cache service', async () => {
    const saveCache = vi.fn();
    expect(await saveWarmZoektIndex({ repository: REPO, indexedSha: 'not-a-sha', indexDir: '/tmp/index', cacheImpl: { saveCache } }))
      .toMatchObject({ status: 'unavailable', reason: 'invalid_sha' });
    expect(saveCache).not.toHaveBeenCalled();
  });
});
