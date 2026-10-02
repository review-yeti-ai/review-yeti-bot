'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { GROUNDING_INDEXER_HEAP_LIMIT_BYTES } = require('./zoektMemoryBudget');

// ADR: knowledge/adr/0329-adopt-zoekt-as-a-bounded-review-time-search-pilot-for-review-yeti.md
//
// Builds a local Zoekt index over an already-checked-out working tree at the
// review's exact head SHA. This is the entire "index-at-review-time" design:
// no persistent service, no shared state, nothing to secure or operate. The
// index is a throwaway artifact of one review run, scoped to one repository,
// pinned to one commit, and never leaves the runner's local disk.
//
// This module never accepts model input. Every argument here is operator/
// pipeline-controlled configuration (the checkout path the pipeline itself
// produced, a scratch directory it chose). It performs no network I/O.

// Memory-bounded defaults (REL-1282). One builder with 8 MiB shards and a Go heap limit keeps the
// indexer near 190 MiB on a 230 MiB working tree; the former 2 x 100 MiB shards peaked at 270-790 MiB
// and OOMKilled the worker container. See zoektMemoryBudget.js for the measurements.
const DEFAULTS = Object.freeze({
  timeoutMs: 120_000,
  parallelism: 1,
  fileLimitBytes: 2 * 1024 * 1024,
  shardLimitBytes: 8 * 1024 * 1024,
  memoryLimitBytes: GROUNDING_INDEXER_HEAP_LIMIT_BYTES,
});
const MAX_LIMITS = Object.freeze({
  timeoutMs: 180_000,
  parallelism: 4,
  fileLimitBytes: 8 * 1024 * 1024,
  shardLimitBytes: 512 * 1024 * 1024,
  memoryLimitBytes: 512 * 1024 * 1024,
});
const MIN_MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
// Directories omitted from this index because they routinely dominate a fresh
// checkout's disk footprint (dependency trees, compiled build output). Kept
// narrow and additive to zoekt-index's own ".git,.hg,.svn" default.
const DEFAULT_IGNORE_DIRS = ['node_modules', '_build', 'deps', 'dist', 'build', '.elixir_ls'];

function boundedInteger(value, fallback, maximum) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? Math.min(number, maximum) : fallback;
}

function resolveBuildConfig(config = {}) {
  return {
    timeoutMs: boundedInteger(config.timeoutMs, DEFAULTS.timeoutMs, MAX_LIMITS.timeoutMs),
    parallelism: boundedInteger(config.parallelism, DEFAULTS.parallelism, MAX_LIMITS.parallelism),
    fileLimitBytes: boundedInteger(config.fileLimitBytes, DEFAULTS.fileLimitBytes, MAX_LIMITS.fileLimitBytes),
    shardLimitBytes: boundedInteger(config.shardLimitBytes, DEFAULTS.shardLimitBytes, MAX_LIMITS.shardLimitBytes),
    memoryLimitBytes: Math.max(
      MIN_MEMORY_LIMIT_BYTES,
      boundedInteger(config.memoryLimitBytes, DEFAULTS.memoryLimitBytes, MAX_LIMITS.memoryLimitBytes),
    ),
    ignoreDirs: Array.isArray(config.ignoreDirs) && config.ignoreDirs.length > 0
      ? [...new Set(config.ignoreDirs.map((entry) => String(entry)))].slice(0, 32)
      : DEFAULT_IGNORE_DIRS,
    zoektIndexBinaryPath: typeof config.zoektIndexBinaryPath === 'string' && config.zoektIndexBinaryPath.trim()
      ? config.zoektIndexBinaryPath.trim()
      : 'zoekt-index',
  };
}

/**
 * Build a Zoekt index for `workdir` (an already-checked-out working tree,
 * expected to be at a single known commit) into `indexDir`. Read-only: it
 * only reads `workdir` and writes shard files under `indexDir`. Never
 * touches the network, never receives model-controlled arguments.
 */
async function buildZoektIndex({ workdir, indexDir, config = {}, signal } = {}) {
  const started = Date.now();
  if (signal?.aborted) return { status: 'unavailable', reason: 'cancelled', elapsedMs: Date.now() - started };
  if (typeof workdir !== 'string' || !workdir || !fs.existsSync(workdir)) {
    return { status: 'unavailable', reason: 'workdir_missing', elapsedMs: Date.now() - started };
  }
  if (typeof indexDir !== 'string' || !indexDir) {
    return { status: 'unavailable', reason: 'index_dir_invalid', elapsedMs: Date.now() - started };
  }
  const resolved = resolveBuildConfig(config);
  try {
    fs.mkdirSync(indexDir, { recursive: true });
  } catch (_error) {
    return { status: 'unavailable', reason: 'index_dir_uncreatable', elapsedMs: Date.now() - started };
  }
  const args = [
    '-index', indexDir,
    '-parallelism', String(resolved.parallelism),
    '-file_limit', String(resolved.fileLimitBytes),
    '-shard_limit', String(resolved.shardLimitBytes),
    '-ignore_dirs', ['.git', '.hg', '.svn', ...resolved.ignoreDirs].join(','),
    path.resolve(workdir),
  ];
  return await new Promise((resolve) => {
    let settled = false;
    let timer;
    let terminationReason;
    let onAbort = () => {};
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      resolve({ ...result, elapsedMs: Date.now() - started });
    };
    let child;
    try {
      child = spawn(resolved.zoektIndexBinaryPath, args, {
        cwd: indexDir,
        // GOMEMLIMIT is a soft Go heap ceiling: the collector works harder instead of growing past it.
        env: { PATH: process.env.PATH || '', GOMEMLIMIT: `${resolved.memoryLimitBytes}B` },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (error) {
      finish({ status: 'unavailable', reason: error?.code === 'ENOENT' ? 'zoekt_index_binary_missing' : 'zoekt_index_spawn_failed' });
      return;
    }
    let stderrTail = '';
    child.stderr?.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000);
    });
    const terminate = (reason) => {
      if (settled || terminationReason) return;
      terminationReason = reason;
      try { child.kill('SIGKILL'); } catch (_) { /* close event remains the cleanup barrier */ }
    };
    onAbort = () => terminate('cancelled');
    child.once('error', (error) => {
      // Once termination was requested, wait for `close` before allowing the
      // caller to remove indexDir. This prevents a late child write racing cleanup.
      if (terminationReason) return;
      finish({ status: 'unavailable', reason: error?.code === 'ENOENT' ? 'zoekt_index_binary_missing' : 'zoekt_index_spawn_failed' });
    });
    child.once('close', (code) => {
      if (terminationReason) {
        finish({ status: 'unavailable', reason: terminationReason === 'cancelled' ? 'cancelled' : 'index_build_timeout' });
        return;
      }
      if (settled) return;
      if (code !== 0) {
        finish({ status: 'unavailable', reason: 'zoekt_index_build_failed', exitCode: code, stderrTail });
        return;
      }
      let shardCount = 0;
      try {
        shardCount = fs.readdirSync(indexDir).filter((entry) => entry.endsWith('.zoekt')).length;
      } catch (_) { /* leave shardCount at 0, still report ok */ }
      finish({ status: 'ok', indexDir, shardCount, indexScope: {
        complete: false, excludedDirectories: ['.git', '.hg', '.svn', ...resolved.ignoreDirs],
        fileLimitBytes: resolved.fileLimitBytes,
        limitations: ['directory_exclusions', 'file_size_limit', 'indexer_language_and_binary_filters'],
      } });
    });
    timer = setTimeout(() => terminate('index_build_timeout'), resolved.timeoutMs);
    signal?.addEventListener?.('abort', onAbort, { once: true });
    // Close the check/listener race without starting work for an already-aborted caller.
    if (signal?.aborted) onAbort();
  });
}

module.exports = { buildZoektIndex, resolveBuildConfig, DEFAULT_IGNORE_DIRS };
