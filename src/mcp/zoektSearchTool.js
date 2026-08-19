'use strict';

const { spawn: defaultSpawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const readline = require('readline');

// ADR: knowledge/adr/0329-adopt-zoekt-as-a-bounded-review-time-search-pilot-for-review-yeti.md
//
// Read-only, repo-scoped, commit-pinned full-repository substring/regex
// search over a Zoekt index built earlier in the same review run by
// zoektIndexBuilder.js. This tool grants no capability, permission, DAG,
// review, or merge authority -- it returns bounded text matches, nothing
// else. It composes with (does not replace) the existing `code_search` tool
// in reviewNavigationTools.js: `code_search` still works against the
// explicit-paths GitHub-blob snapshot; `code_search_zoekt` reaches the full
// checked-out tree at head, which the 5,000-entry navigation snapshot cap
// cannot.
//
// The model supplies ONLY a query string. No path, no host, no flag. The
// query is always passed to the zoekt binary after a literal `--`
// end-of-options marker so it can never be reinterpreted as a flag (e.g. a
// query of `-index_dir /etc` cannot redirect the search elsewhere) --
// verified against the real zoekt CLI, see PR description. Every other argv
// element (binary path, -index_dir, -jsonl) is fixed, operator-controlled
// configuration, never derived from model input.
//
// Fail-soft by construction: a missing binary, a missing/unbuilt index, a
// timeout, or a non-zero exit all resolve to `status: 'unavailable'` with a
// receipt reason, exactly like the other evidence tools in
// reviewNavigationTools.js. Callers already treat `unavailable` as "this
// tool had nothing to offer this call," not a review failure -- the caller
// falls back to code_search/file_find/rg-backed tooling, which remain fully
// intact and unmodified by this change.

const DEFAULTS = Object.freeze({
  enabled: false,
  maxCalls: 12,
  maxFindResults: 50,
  maxResultBytes: 8 * 1024,
  maxQueryLength: 200,
  timeoutMs: 2_000,
});
const MAX_LIMITS = Object.freeze({
  maxCalls: 40,
  maxFindResults: 100,
  maxResultBytes: 64 * 1024,
  maxQueryLength: 200,
  timeoutMs: 5_000,
});
const TOOL_NAME = 'code_search_zoekt';
const MAX_LINE_BYTES = 500;
// zoekt's stdout line format for -jsonl; see zoekt cmd/zoekt help. Kept
// narrow to only the fields this tool consumes.
const MAX_STDOUT_LINE_BYTES = 4 * 1024 * 1024; // one JSONL record (one file's matches)

function boundedInteger(value, fallback, maximum) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? Math.min(number, maximum) : fallback;
}

function resolveZoektSearchConfig(config = {}) {
  return {
    enabled: config.enabled === true,
    maxCalls: boundedInteger(config.maxCalls, DEFAULTS.maxCalls, MAX_LIMITS.maxCalls),
    maxFindResults: boundedInteger(config.maxFindResults, DEFAULTS.maxFindResults, MAX_LIMITS.maxFindResults),
    maxResultBytes: boundedInteger(config.maxResultBytes, DEFAULTS.maxResultBytes, MAX_LIMITS.maxResultBytes),
    timeoutMs: boundedInteger(config.timeoutMs, DEFAULTS.timeoutMs, MAX_LIMITS.timeoutMs),
    zoektBinaryPath: typeof config.zoektBinaryPath === 'string' && config.zoektBinaryPath.trim()
      ? config.zoektBinaryPath.trim()
      : 'zoekt',
  };
}

function validQuery(value, maxLength) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return false;
  if (trimmed.includes('\0')) return false;
  // Defense in depth on top of the `--` end-of-options marker below: a query
  // that merely *looks* like a CLI flag never reaches the child process argv
  // in a position where it could be misread, but we reject it outright too
  // so this tool's behavior does not depend on a single guard holding.
  if (trimmed.startsWith('-')) return false;
  return true;
}

function boundedText(value, limit) {
  const buffer = Buffer.from(String(value || ''), 'utf8');
  if (buffer.length <= limit) return { text: buffer.toString('utf8'), truncated: false };
  return { text: buffer.subarray(0, limit).toString('utf8'), truncated: true };
}

function decodeBase64Utf8(value) {
  try {
    return Buffer.from(String(value || ''), 'base64').toString('utf8');
  } catch (_error) {
    return '';
  }
}

/**
 * Run one bounded zoekt query and resolve matches, respecting maxFindResults
 * and maxResultBytes by killing the child process as soon as either bound is
 * reached rather than buffering the full (potentially tens-of-MB) result set.
 */
function runZoektQuery({ zoektBinaryPath, indexDir, query, maxFindResults, maxResultBytes, timeoutMs, signal, spawnImpl = defaultSpawn }) {
  return new Promise((resolve) => {
    let settled = false;
    let child;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    try {
      child = spawnImpl(zoektBinaryPath, ['-index_dir', indexDir, '-jsonl', '--', query], {
        cwd: os.tmpdir(),
        env: { PATH: process.env.PATH || '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({ ok: false, reason: error?.code === 'ENOENT' ? 'zoekt_binary_missing' : 'zoekt_spawn_failed' });
      return;
    }

    const matches = [];
    let usedBytes = 0;
    let timedOut = false;
    let killedForBounds = false;
    let stderrTail = '';

    const cleanupAndKill = () => {
      try { child.kill('SIGKILL'); } catch (_) { /* already exited */ }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      cleanupAndKill();
    }, timeoutMs);

    const onAbort = () => {
      cleanupAndKill();
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line || matches.length >= maxFindResults || usedBytes >= maxResultBytes) return;
      if (Buffer.byteLength(line, 'utf8') > MAX_STDOUT_LINE_BYTES) return;
      let record;
      try {
        record = JSON.parse(line);
      } catch (_error) {
        return;
      }
      const path = typeof record?.FileName === 'string' ? record.FileName : null;
      const lineMatches = Array.isArray(record?.LineMatches) ? record.LineMatches : [];
      if (!path) return;
      for (const lineMatch of lineMatches) {
        if (matches.length >= maxFindResults || usedBytes >= maxResultBytes) break;
        if (lineMatch?.FileName === true) continue; // filename-only match, not a text line
        const decoded = decodeBase64Utf8(lineMatch?.Line);
        const bounded = boundedText(decoded, Math.min(MAX_LINE_BYTES, Math.max(0, maxResultBytes - usedBytes)));
        if (!bounded.text) continue;
        matches.push({
          path,
          line: Number.isInteger(lineMatch?.LineNumber) ? lineMatch.LineNumber : null,
          text: bounded.text,
        });
        usedBytes += Buffer.byteLength(bounded.text, 'utf8');
      }
      if (matches.length >= maxFindResults || usedBytes >= maxResultBytes) {
        killedForBounds = true;
        cleanupAndKill();
      }
    });

    child.stderr?.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000);
    });

    child.once('error', (error) => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      finish({ ok: false, reason: error?.code === 'ENOENT' ? 'zoekt_binary_missing' : 'zoekt_spawn_failed' });
    });

    child.once('exit', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      if (settled) return;
      if (timedOut) {
        finish({ ok: false, reason: 'request_timeout' });
        return;
      }
      if (signal?.aborted) {
        finish({ ok: false, reason: 'cancelled' });
        return;
      }
      // A non-zero exit we forced ourselves (killedForBounds) is a successful,
      // deliberately truncated result -- not a failure.
      if (code !== 0 && !killedForBounds) {
        finish({ ok: false, reason: 'zoekt_query_failed', exitCode: code, stderrTail });
        return;
      }
      finish({
        ok: true,
        matches,
        truncated: killedForBounds || matches.length >= maxFindResults || usedBytes >= maxResultBytes,
        byteCount: usedBytes,
      });
    });
  });
}

/**
 * @param {object} params
 * @param {object} params.identity - immutable review identity (repository, prNumber, headSha), same shape reviewNavigationTools.js uses; carried only into receipts.
 * @param {string} params.indexDir - path to a Zoekt index already built by zoektIndexBuilder.js for this review's head SHA. Operator/pipeline-controlled, never model input.
 * @param {object} [params.config]
 */
function createZoektSearchTool({ identity, indexDir, config = {}, spawnImpl = defaultSpawn, fsImpl = fs } = {}) {
  const effectiveConfig = resolveZoektSearchConfig(config);
  let calls = 0;
  const receipt = (extra = {}) => ({ identity: identity ? { ...identity } : undefined, tool: TOOL_NAME, ...extra });

  const indexAvailable = () => {
    if (typeof indexDir !== 'string' || !indexDir) return false;
    try {
      return fsImpl.existsSync(indexDir) && fsImpl.readdirSync(indexDir).some((entry) => entry.endsWith('.zoekt'));
    } catch (_error) {
      return false;
    }
  };

  const call = async (tool, args = {}, options = {}) => {
    if (tool !== TOOL_NAME) return { status: 'unavailable', ...receipt({ reason: 'tool_not_registered' }) };
    if (!effectiveConfig.enabled) return { status: 'unavailable', ...receipt({ reason: 'disabled' }) };
    if (options?.signal?.aborted) return { status: 'cancelled', ...receipt({ reason: 'cancelled' }) };
    if (calls >= effectiveConfig.maxCalls) return { status: 'unavailable', ...receipt({ reason: 'call_budget_exhausted' }) };
    calls += 1;

    const query = typeof args?.query === 'string' ? args.query.trim() : '';
    if (!validQuery(query, effectiveConfig.maxQueryLength ?? DEFAULTS.maxQueryLength)) {
      return { status: 'invalid', ...receipt({ reason: 'invalid_query' }) };
    }
    if (!indexAvailable()) {
      return { status: 'unavailable', ...receipt({ reason: 'zoekt_index_unavailable' }) };
    }

    const result = await runZoektQuery({
      zoektBinaryPath: effectiveConfig.zoektBinaryPath,
      indexDir,
      query,
      maxFindResults: effectiveConfig.maxFindResults,
      maxResultBytes: effectiveConfig.maxResultBytes,
      timeoutMs: effectiveConfig.timeoutMs,
      signal: options?.signal,
      spawnImpl,
    });

    if (!result.ok) {
      return { status: result.reason === 'cancelled' ? 'cancelled' : 'unavailable', ...receipt({ reason: result.reason }) };
    }
    return {
      status: 'ok',
      ...receipt({
        query,
        matches: result.matches,
        matchCount: result.matches.length,
        truncated: result.truncated,
        byteCount: result.byteCount,
      }),
    };
  };

  return Object.freeze({
    capabilities: Object.freeze({
      enabled: effectiveConfig.enabled,
      readOnly: true,
      transport: 'local-zoekt-index',
      tools: [TOOL_NAME],
    }),
    call,
  });
}

module.exports = { createZoektSearchTool, resolveZoektSearchConfig, ZOEKT_SEARCH_TOOL_NAME: TOOL_NAME };
