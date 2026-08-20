'use strict';

// ADR: knowledge/adr/0329-adopt-zoekt-as-a-bounded-review-time-search-pilot-for-review-yeti.md
//
// zoektWorkdirMaterializer.js + zoektIndexBuilder.js build a Zoekt index fresh, inside every
// review's own request path. Measured live against cisco-cdr (14.2k files): 7,865ms materialize
// + 4,692ms index build = 12,557ms flat, paid on every review, structurally BEFORE any persona
// lane's own laneDeadline clock starts. Operator direction: the repo tree and its index are
// deployment/provisioning assets, not request-path work -- "there should be a tarball, this is
// not part of the prompt, or tokens, ... though they are assets for the deployment."
//
// This module is the consumption side of that: a best-effort GitHub Actions cache lookup for a
// Zoekt index some SEPARATE, deliberately-triggered workflow already built and saved (a scheduled
// or push-to-default-branch refresh run, not shipped in this change -- see saveWarmZoektIndex's
// doc comment). It never builds or fetches anything itself; a miss falls through to exactly
// today's materializeReviewWorkdir + buildZoektIndex behavior, unchanged. This can only ever be a
// strict superset of what already worked.
//
// Why the reviewed repo's own GitHub Actions cache and not a review-yeti-ai-hosted index:
// README.md states this product's architecture explicitly -- "no Review Yeti managed server or
// database is required" and "no Review Yeti-managed codebase index." A cache entry owned by the
// reviewed repo keeps that promise; nothing here is stored on any server review-yeti-ai operates.
//
// Why not the `actions/cache` marketplace action: action.yml's "Install pipeline dependencies"
// step already documents why nested marketplace actions are unusable here -- consumer repos with
// sha_pinning_required reject a nested `uses:` inside this composite action. `@actions/cache` is
// the underlying npm toolkit the marketplace action itself is built on; calling it directly from
// this Node pipeline, installed the same way js-yaml already is, has no such restriction.
//
// Restore-only in the review request path, by design: a review run must never WRITE to this
// cache. An untrusted PR that could poison a future review's warm index would defeat the entire
// point of having one. Only restoreWarmZoektIndex is wired into review-pipeline.js;
// saveWarmZoektIndex is implemented and tested here but deliberately not called from anywhere in
// the request path -- it is for a future, separate provisioning entry point.

const CACHE_KEY_PREFIX = 'zoekt-index-v1';
const SHA = /^[a-f0-9]{40}$/iu;

function validRepository(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value) && !value.includes('..');
}

/**
 * Repository-scoped prefix every real cache key for this repository starts with. `/` is not a
 * safe cache-key separator (some backing stores treat it as a path component), and a bare `-`
 * join would let "owner/repo-a" collide with "owner/repo"'s own prefix -- `__` is deliberately
 * not a character `validRepository` permits in an owner or repo name, so it can never appear in
 * either half and is always unambiguous as the separator.
 */
function cacheKeyPrefix(repository) {
  return `${CACHE_KEY_PREFIX}-${repository.replace('/', '__')}-`;
}

function cacheKeyFor(repository, sha) {
  return `${cacheKeyPrefix(repository)}${String(sha).toLowerCase()}`;
}

/**
 * Recovers the exact commit a restored cache key's index reflects. Returns null (never throws)
 * for anything that is not unambiguously a real key for `repository` carrying a real SHA -- a
 * cache service returning a key from a different scheme, a different repository's prefix, or
 * anything malformed is treated as "we don't actually know what this index reflects," which
 * restoreWarmZoektIndex turns into a plain miss rather than a guess.
 */
function parseIndexedSha(matchedKey, repository) {
  if (typeof matchedKey !== 'string' || !validRepository(repository)) return null;
  const prefix = cacheKeyPrefix(repository);
  if (!matchedKey.startsWith(prefix)) return null;
  const candidate = matchedKey.slice(prefix.length);
  return SHA.test(candidate) ? candidate.toLowerCase() : null;
}

function loadCacheModule() {
  try {
    // eslint-disable-next-line global-require
    return require('@actions/cache');
  } catch (_error) {
    return null;
  }
}

/**
 * Best-effort restore of a previously provisioned Zoekt index for `repository` into `indexDir`.
 * Matches on the repository's key prefix (not an exact SHA) because the index that was last
 * refreshed is very unlikely to be pinned to this exact review's headSha -- restoreCache's
 * restoreKeys prefix fallback returns whichever matching key is most recent, and the actual
 * indexed commit is recovered from that key, never assumed to equal `headSha`. Callers must treat
 * `indexedSha` as potentially older than the review's own head -- see the caller in
 * review-pipeline.js for how staleness is then handled.
 *
 * Never throws. Any failure -- @actions/cache not installed (this module is only present after
 * the Action's dependency-install step runs, or in a caller that injects `cacheImpl` directly),
 * no cache service configured, a network failure, or a real miss -- resolves to
 * `{status:'unavailable', reason}`, identical in shape to zoektWorkdirMaterializer.js's and
 * zoektIndexBuilder.js's own fail-soft contract. A review must never fail, or even change
 * behavior beyond "build fresh instead," because a cache lookup did not work.
 */
async function restoreWarmZoektIndex({ repository, indexDir, cacheImpl } = {}) {
  const started = Date.now();
  if (!validRepository(repository)) {
    return { status: 'unavailable', reason: 'invalid_identity', elapsedMs: Date.now() - started };
  }
  if (typeof indexDir !== 'string' || !indexDir) {
    return { status: 'unavailable', reason: 'index_dir_invalid', elapsedMs: Date.now() - started };
  }
  const cache = cacheImpl || loadCacheModule();
  if (!cache || typeof cache.restoreCache !== 'function') {
    return { status: 'unavailable', reason: 'cache_module_unavailable', elapsedMs: Date.now() - started };
  }
  // isFeatureAvailable() (the module's own precondition check) reads the runner-provided
  // ACTIONS_CACHE_URL/ACTIONS_RESULTS_URL env vars synchronously -- checking it first means a
  // runner with no cache service configured (local dev, `node bin/reviewyeti.js`, a self-hosted
  // runner without the cache service enabled) fails in a microsecond instead of waiting out
  // restoreCache's real network retry/backoff only to arrive at the same answer. A caller that
  // injects `cacheImpl` for testing is exempt -- it is not the real module and has no such check.
  if (!cacheImpl && typeof cache.isFeatureAvailable === 'function' && !cache.isFeatureAvailable()) {
    return { status: 'unavailable', reason: 'cache_service_unavailable', elapsedMs: Date.now() - started };
  }
  const prefix = cacheKeyPrefix(repository);
  let matchedKey;
  try {
    // The primary key deliberately never matches a real entry (no index is ever saved under a
    // bare prefix) -- every real hit comes through the restoreKeys prefix fallback, which is the
    // only way to find "whatever was last refreshed" without already knowing its SHA.
    matchedKey = await cache.restoreCache([indexDir], `${prefix}none`, [prefix]);
  } catch (_error) {
    return { status: 'unavailable', reason: 'cache_restore_failed', elapsedMs: Date.now() - started };
  }
  if (!matchedKey) {
    return { status: 'unavailable', reason: 'cache_miss', elapsedMs: Date.now() - started };
  }
  const indexedSha = parseIndexedSha(matchedKey, repository);
  if (!indexedSha) {
    return { status: 'unavailable', reason: 'cache_key_unparseable', elapsedMs: Date.now() - started };
  }
  return { status: 'ok', indexDir, indexedSha, matchedKey, elapsedMs: Date.now() - started };
}

/**
 * Best-effort save of a freshly built Zoekt index for `repository`@`indexedSha` from `indexDir`,
 * for a future review run to restore. NOT called anywhere in this change -- see the module
 * comment above for why a review request must never write this cache. This exists, fully
 * implemented and tested, so the follow-up that adds a deliberate provisioning entry point (a
 * scheduled or push-to-default-branch workflow) has an exact, already-verified key format to
 * write under -- restoreWarmZoektIndex above expects to parse a key produced by exactly this
 * function.
 *
 * Never throws. A failed save (including the ordinary race of two refreshes attempting to save
 * the same key) degrades to "no warm index available next time," never blocks or fails the
 * caller.
 */
async function saveWarmZoektIndex({ repository, indexedSha, indexDir, cacheImpl } = {}) {
  const started = Date.now();
  if (!validRepository(repository)) {
    return { status: 'unavailable', reason: 'invalid_identity', elapsedMs: Date.now() - started };
  }
  if (!SHA.test(String(indexedSha || ''))) {
    return { status: 'unavailable', reason: 'invalid_sha', elapsedMs: Date.now() - started };
  }
  if (typeof indexDir !== 'string' || !indexDir) {
    return { status: 'unavailable', reason: 'index_dir_invalid', elapsedMs: Date.now() - started };
  }
  const cache = cacheImpl || loadCacheModule();
  if (!cache || typeof cache.saveCache !== 'function') {
    return { status: 'unavailable', reason: 'cache_module_unavailable', elapsedMs: Date.now() - started };
  }
  if (!cacheImpl && typeof cache.isFeatureAvailable === 'function' && !cache.isFeatureAvailable()) {
    return { status: 'unavailable', reason: 'cache_service_unavailable', elapsedMs: Date.now() - started };
  }
  const key = cacheKeyFor(repository, indexedSha);
  try {
    await cache.saveCache([indexDir], key);
  } catch (_error) {
    return { status: 'unavailable', reason: 'cache_save_failed', elapsedMs: Date.now() - started };
  }
  return { status: 'ok', key, elapsedMs: Date.now() - started };
}

module.exports = {
  CACHE_KEY_PREFIX,
  cacheKeyFor,
  cacheKeyPrefix,
  parseIndexedSha,
  restoreWarmZoektIndex,
  saveWarmZoektIndex,
};
