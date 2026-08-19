'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

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

const DEFAULTS = Object.freeze({
  timeoutMs: 90_000,
  parallelism: 2,
  fileLimitBytes: 2 * 1024 * 1024,
  shardLimitBytes: 100 * 1024 * 1024,
});
const MAX_LIMITS = Object.freeze({
  timeoutMs: 180_000,
  parallelism: 4,
  fileLimitBytes: 8 * 1024 * 1024,
  shardLimitBytes: 512 * 1024 * 1024,
});
// Directories that are never source evidence and routinely dominate a fresh
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
async function buildZoektIndex({ workdir, indexDir, config = {} } = {}) {
  const started = Date.now();
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
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve({ ...result, elapsedMs: Date.now() - started });
    };
    let child;
    try {
      child = spawn(resolved.zoektIndexBinaryPath, args, {
        cwd: indexDir,
        env: { PATH: process.env.PATH || '' },
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
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) { /* already exited */ }
      finish({ status: 'unavailable', reason: 'index_build_timeout' });
    }, resolved.timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      finish({ status: 'unavailable', reason: error?.code === 'ENOENT' ? 'zoekt_index_binary_missing' : 'zoekt_index_spawn_failed' });
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (settled) return;
      if (code !== 0) {
        finish({ status: 'unavailable', reason: 'zoekt_index_build_failed', exitCode: code, stderrTail });
        return;
      }
      let shardCount = 0;
      try {
        shardCount = fs.readdirSync(indexDir).filter((entry) => entry.endsWith('.zoekt')).length;
      } catch (_) { /* leave shardCount at 0, still report ok */ }
      finish({ status: 'ok', indexDir, shardCount });
    });
  });
}

module.exports = { buildZoektIndex, resolveBuildConfig, DEFAULT_IGNORE_DIRS };
