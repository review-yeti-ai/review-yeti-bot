'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ADR: knowledge/adr/0329-adopt-zoekt-as-a-bounded-review-time-search-pilot-for-review-yeti.md
//
// zoektIndexBuilder.js indexes "an already-checked-out working tree at the
// review's exact head SHA" -- but this pipeline (pull_request_target,
// snapshot-based navigation) never checks the untrusted head SHA out onto
// local disk; reviewNavigationSnapshot.js fetches file contents lazily, one
// GitHub blob at a time, precisely so untrusted code is never present on the
// runner's filesystem in a form that could be executed. This module closes
// that gap for Zoekt specifically: it materializes a READ-ONLY copy of the
// source tree so it can be indexed for search, and nothing else ever touches
// it (no build, no install, no execution).
//
// Every argument here is operator/pipeline-controlled, not model input:
// `repository` and `headSha` come from the review's own immutable identity
// (already validated upstream, same trust boundary reviewNavigationSnapshot.js
// and createGitHubBlobClient use for the identical inputs), `token` is the
// run's existing GitHub token, and `destDir` is a scratch directory the
// pipeline chose. The model never sees this module and cannot influence any
// argument passed to it.
//
// Network surface: exactly one fixed GitHub REST endpoint,
// `GET {apiBaseUrl}/repos/{repository}/tarball/{headSha}`, where apiBaseUrl is
// validated against the same api.github.com-only allowlist
// createGitHubBlobClient uses. GitHub's own API issues a redirect to
// codeload.github.com to serve the archive bytes; `fetch` follows that
// redirect automatically. No other host, path, or header is ever reachable
// from this module -- there is no generic fetch/HTTP surface here, only this
// one call shape.
//
// Fail-soft throughout, exactly like zoektIndexBuilder.js and the other
// evidence tools: a malformed identity, a missing token, a disallowed API
// host, a network failure, a non-2xx response, an oversized archive, a
// missing `tar` binary, or a non-zero `tar` exit all resolve to
// `{status:'unavailable', reason}`. A review must never fail because a
// Zoekt index could not be built -- the composed evidence registry degrades
// to the existing GitHub-blob-backed tools, unaffected.

const DEFAULTS = Object.freeze({ timeoutMs: 60_000, maxBytes: 300 * 1024 * 1024 });
const MAX_LIMITS = Object.freeze({ timeoutMs: 120_000, maxBytes: 768 * 1024 * 1024 });

const SHA = /^[a-f0-9]{40,64}$/iu;

function validRepository(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value) && !value.includes('..');
}

function boundedInteger(value, fallback, maximum) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? Math.min(number, maximum) : fallback;
}

function apiOrigin(apiBaseUrl) {
  let base;
  try {
    base = new URL(apiBaseUrl);
  } catch (_error) {
    return null;
  }
  if (base.protocol !== 'https:' || base.hostname !== 'api.github.com' || base.username || base.password || base.port) {
    return null;
  }
  return base.origin;
}

/**
 * Extract `archivePath` (a real .tar.gz) into `destDir` via the system `tar`
 * binary, stripping the single top-level directory every GitHub tarball
 * wraps its contents in.
 */
function extractTarball({ archivePath, destDir, tarBinaryPath }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child;
    try {
      child = spawn(tarBinaryPath, ['-xzf', archivePath, '-C', destDir, '--strip-components=1'], {
        env: { PATH: process.env.PATH || '' },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (error) {
      finish({ ok: false, reason: error?.code === 'ENOENT' ? 'tar_binary_missing' : 'tar_spawn_failed' });
      return;
    }
    let stderrTail = '';
    child.stderr?.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000);
    });
    child.once('error', (error) => {
      finish({ ok: false, reason: error?.code === 'ENOENT' ? 'tar_binary_missing' : 'tar_spawn_failed' });
    });
    child.once('exit', (code) => {
      if (code !== 0) {
        finish({ ok: false, reason: 'tar_extract_failed', exitCode: code, stderrTail });
        return;
      }
      finish({ ok: true });
    });
  });
}

/**
 * Stream `response.body` to `archivePath`, aborting as soon as `maxBytes` is
 * exceeded rather than buffering an up-to-hundreds-of-MB archive fully in
 * memory before writing it.
 */
async function streamResponseToFile({ response, archivePath, maxBytes, signal }) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, reason: 'archive_too_large' };
  }
  if (!response.body?.getReader) {
    return { ok: false, reason: 'tarball_fetch_failed' };
  }
  const reader = response.body.getReader();
  const fileStream = fs.createWriteStream(archivePath);
  let written = 0;
  try {
    for (;;) {
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      const { done, value } = await reader.read();
      if (done) break;
      written += value.byteLength;
      if (written > maxBytes) {
        try { await reader.cancel(); } catch (_error) { /* already closed */ }
        fileStream.close();
        try { fs.unlinkSync(archivePath); } catch (_error) { /* best effort */ }
        return { ok: false, reason: 'archive_too_large' };
      }
      await new Promise((resolve, reject) => {
        fileStream.write(Buffer.from(value), (error) => (error ? reject(error) : resolve()));
      });
    }
    await new Promise((resolve, reject) => fileStream.end((error) => (error ? reject(error) : resolve())));
    return { ok: true };
  } catch (error) {
    try { fileStream.close(); } catch (_closeError) { /* already closed */ }
    try { fs.unlinkSync(archivePath); } catch (_unlinkError) { /* best effort */ }
    return { ok: false, reason: signal?.aborted ? 'request_timeout' : 'tarball_write_failed' };
  }
}

/**
 * Materialize a read-only working tree for `headSha` of `repository` into
 * `destDir`, so zoektIndexBuilder.js has something to index. See module
 * comment above for the full trust-boundary and fail-soft contract.
 */
async function materializeReviewWorkdir({
  repository,
  headSha,
  token,
  destDir,
  fetchImplementation = globalThis.fetch,
  apiBaseUrl = 'https://api.github.com',
  config = {},
  signal,
  tarBinaryPath = 'tar',
} = {}) {
  const started = Date.now();
  if (!validRepository(repository) || !SHA.test(String(headSha || ''))) {
    return { status: 'unavailable', reason: 'invalid_identity', elapsedMs: Date.now() - started };
  }
  if (!token || typeof token !== 'string') {
    return { status: 'unavailable', reason: 'missing_token', elapsedMs: Date.now() - started };
  }
  if (typeof fetchImplementation !== 'function') {
    return { status: 'unavailable', reason: 'fetch_unavailable', elapsedMs: Date.now() - started };
  }
  const origin = apiOrigin(apiBaseUrl);
  if (!origin) {
    return { status: 'unavailable', reason: 'api_base_url_not_allowlisted', elapsedMs: Date.now() - started };
  }
  if (typeof destDir !== 'string' || !destDir) {
    return { status: 'unavailable', reason: 'dest_dir_invalid', elapsedMs: Date.now() - started };
  }
  const resolved = {
    timeoutMs: boundedInteger(config.timeoutMs, DEFAULTS.timeoutMs, MAX_LIMITS.timeoutMs),
    maxBytes: boundedInteger(config.maxBytes, DEFAULTS.maxBytes, MAX_LIMITS.maxBytes),
  };
  try {
    fs.mkdirSync(destDir, { recursive: true });
  } catch (_error) {
    return { status: 'unavailable', reason: 'dest_dir_uncreatable', elapsedMs: Date.now() - started };
  }

  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener?.('abort', onExternalAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), resolved.timeoutMs);

  let response;
  try {
    response = await fetchImplementation(`${origin}/repos/${repository}/tarball/${headSha}`, {
      method: 'GET',
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
      signal: controller.signal,
      redirect: 'follow',
    });
  } catch (_error) {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onExternalAbort);
    return { status: 'unavailable', reason: controller.signal.aborted ? 'request_timeout' : 'tarball_fetch_failed', elapsedMs: Date.now() - started };
  }
  if (!response?.ok) {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onExternalAbort);
    return { status: 'unavailable', reason: 'tarball_fetch_failed', elapsedMs: Date.now() - started };
  }

  const archivePath = path.join(os.tmpdir(), `zoekt-src-${path.basename(destDir)}.tar.gz`);
  const streamResult = await streamResponseToFile({ response, archivePath, maxBytes: resolved.maxBytes, signal: controller.signal });
  clearTimeout(timer);
  signal?.removeEventListener?.('abort', onExternalAbort);
  if (!streamResult.ok) {
    return { status: 'unavailable', reason: streamResult.reason, elapsedMs: Date.now() - started };
  }

  const extraction = await extractTarball({ archivePath, destDir, tarBinaryPath });
  try { fs.unlinkSync(archivePath); } catch (_error) { /* best effort cleanup */ }
  if (!extraction.ok) {
    return { status: 'unavailable', reason: extraction.reason, elapsedMs: Date.now() - started };
  }
  return { status: 'ok', workdir: destDir, elapsedMs: Date.now() - started };
}

module.exports = { materializeReviewWorkdir };
