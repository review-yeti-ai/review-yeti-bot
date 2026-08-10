'use strict';

const DEFAULTS = Object.freeze({
  enabled: false,
  maxCalls: 12,
  maxReadBytes: 32 * 1024,
  maxResultBytes: 32 * 1024,
  maxFindResults: 20,
  maxScanFiles: 40,
  timeoutMs: 1_500,
});
const MAX_LIMITS = Object.freeze({
  maxCalls: 40,
  maxReadBytes: 64 * 1024,
  maxResultBytes: 64 * 1024,
  maxFindResults: 50,
  maxScanFiles: 100,
  timeoutMs: 5_000,
});
const SHA = /^[a-f0-9]{40,64}$/iu;

function boundedInteger(value, fallback, maximum) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? Math.min(number, maximum) : fallback;
}

function resolveConfig(config = {}) {
  return {
    enabled: config.enabled === true,
    maxCalls: boundedInteger(config.maxCalls, DEFAULTS.maxCalls, MAX_LIMITS.maxCalls),
    maxReadBytes: boundedInteger(config.maxReadBytes, DEFAULTS.maxReadBytes, MAX_LIMITS.maxReadBytes),
    maxResultBytes: boundedInteger(config.maxResultBytes, DEFAULTS.maxResultBytes, MAX_LIMITS.maxResultBytes),
    maxFindResults: boundedInteger(config.maxFindResults, DEFAULTS.maxFindResults, MAX_LIMITS.maxFindResults),
    maxScanFiles: boundedInteger(config.maxScanFiles, DEFAULTS.maxScanFiles, MAX_LIMITS.maxScanFiles),
    timeoutMs: boundedInteger(config.timeoutMs, DEFAULTS.timeoutMs, MAX_LIMITS.timeoutMs),
  };
}

function isAbort(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

function validRepository(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value) && !value.includes('..');
}

function validPath(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 500
    && !value.startsWith('/')
    && !value.includes('\\')
    && !value.includes('\0')
    && value.split('/').every((part) => part && part !== '.' && part !== '..');
}

function validIdentity(identity) {
  return validRepository(identity?.repository)
    && String(identity?.prNumber ?? '').trim() !== ''
    && SHA.test(String(identity?.headSha || ''))
    && (!identity?.baseSha || SHA.test(String(identity.baseSha)));
}

function normalizeSnapshot(snapshot, identity) {
  if (!snapshot || snapshot.repository !== identity.repository || snapshot.headSha !== identity.headSha) {
    throw new Error('review navigation snapshot must match the immutable review identity');
  }
  if (identity.baseSha && snapshot.baseSha !== identity.baseSha) {
    throw new Error('review navigation snapshot base SHA must match the immutable review identity');
  }
  if (!Array.isArray(snapshot.files) || snapshot.files.length > 5_000) {
    throw new Error('review navigation snapshot must contain a bounded file list');
  }
  const files = new Map();
  for (const file of snapshot.files) {
    if (!validPath(file?.path) || !SHA.test(String(file?.blobSha || '')) || files.has(file.path)) {
      throw new Error('review navigation snapshot contains an invalid file record');
    }
    files.set(file.path, Object.freeze({
      path: file.path,
      blobSha: String(file.blobSha).toLowerCase(),
      patch: typeof file.patch === 'string' ? file.patch : '',
    }));
  }
  return files;
}

function boundedText(value, limit) {
  const buffer = Buffer.from(String(value || ''), 'utf8');
  if (buffer.length <= limit) return { text: buffer.toString('utf8'), truncated: false, byteCount: buffer.length };
  return { text: buffer.subarray(0, limit).toString('utf8'), truncated: true, byteCount: limit };
}

function parsePositive(value, fallback, maximum) {
  if (value === undefined) return fallback;
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? Math.min(number, maximum) : null;
}

function lineRange(content, startLine, endLine) {
  const lines = String(content).split(/(?<=\n)/u);
  const start = parsePositive(startLine, 1, 100_000);
  const end = parsePositive(endLine, Math.min(lines.length, 500), 100_000);
  if (start === null || end === null || end < start || end - start >= 500) return null;
  return lines.slice(start - 1, end).join('');
}

function createAbortSignal(signal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener?.('abort', abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', abort);
    },
  };
}

/**
 * A minimal authenticated GitHub blob boundary. It deliberately accepts only a known immutable
 * blob SHA; callers cannot request paths, refs, arbitrary URLs, writes, or GitHub search APIs.
 */
function createGitHubBlobClient({ token, fetchImplementation = globalThis.fetch, apiBaseUrl = 'https://api.github.com', timeoutMs = DEFAULTS.timeoutMs } = {}) {
  if (!token || typeof token !== 'string') throw new Error('GitHub blob client requires an authentication token');
  if (typeof fetchImplementation !== 'function') throw new Error('GitHub blob client requires fetch');
  let base;
  try { base = new URL(apiBaseUrl); } catch (_) { throw new Error('GitHub API base URL is invalid'); }
  if (base.protocol !== 'https:') throw new Error('GitHub API base URL must use HTTPS');
  if (base.username || base.password || base.port || base.hostname !== 'api.github.com') {
    throw new Error('GitHub API base URL host is not allowlisted');
  }
  const normalizedBase = base.origin;
  const effectiveTimeout = boundedInteger(timeoutMs, DEFAULTS.timeoutMs, MAX_LIMITS.timeoutMs);
  return {
    async getBlob({ repository, blobSha, headSha, signal, maxBytes = MAX_LIMITS.maxReadBytes } = {}) {
      if (!validRepository(repository) || !SHA.test(String(blobSha || '')) || !SHA.test(String(headSha || ''))) {
        throw new Error('GitHub blob request requires immutable repository and SHA values');
      }
      if (signal?.aborted) throw Object.assign(new Error('request cancelled'), { name: 'AbortError' });
      const operation = createAbortSignal(signal, effectiveTimeout);
      try {
        const response = await fetchImplementation(`${normalizedBase}/repos/${repository}/git/blobs/${blobSha}`, {
          method: 'GET',
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
          },
          signal: operation.signal,
        });
        const raw = await response.text();
        if (!response.ok) throw new Error(`GitHub blob API status ${response.status}`);
        const payload = JSON.parse(raw);
        if (String(payload?.sha || '').toLowerCase() !== String(blobSha).toLowerCase() || payload?.encoding !== 'base64') {
          throw new Error('GitHub blob response did not match the requested immutable SHA');
        }
        const decoded = Buffer.from(String(payload.content || '').replace(/\s/g, ''), 'base64');
        const bounded = decoded.subarray(0, boundedInteger(maxBytes, MAX_LIMITS.maxReadBytes, MAX_LIMITS.maxReadBytes));
        return { sha: String(payload.sha).toLowerCase(), content: bounded.toString('utf8'), truncated: decoded.length > bounded.length, byteCount: bounded.length };
      } finally {
        operation.dispose();
      }
    },
  };
}

function createReviewNavigationToolRegistry({ identity, snapshot, blobClient, config = {} } = {}) {
  if (!validIdentity(identity)) throw new Error('review navigation requires a valid immutable review identity');
  if (!blobClient || typeof blobClient.getBlob !== 'function') throw new Error('review navigation requires a read-only GitHub blob client');
  const effectiveConfig = resolveConfig(config);
  const files = normalizeSnapshot(snapshot, identity);
  let calls = 0;
  const receipt = (tool, extra = {}) => ({ identity: { ...identity }, tool, ...extra });
  const disabled = (tool, reason) => ({ status: 'unavailable', ...receipt(tool, { reason }) });
  const takeCall = (tool, options) => {
    if (!effectiveConfig.enabled) return disabled(tool, 'review navigation tools are disabled');
    if (options?.signal?.aborted) return { status: 'cancelled', ...receipt(tool, { reason: 'review navigation request cancelled' }) };
    if (calls >= effectiveConfig.maxCalls) return disabled(tool, 'review navigation tool call budget exhausted');
    calls += 1;
    return null;
  };
  const target = (tool, args) => {
    const path = args?.path;
    if (!validPath(path)) return { result: { status: 'invalid', ...receipt(tool, { reason: 'invalid file path' }) } };
    const file = files.get(path);
    if (!file) return { result: disabled(tool, 'file is not in the immutable review snapshot') };
    return { file };
  };
  const fetchFile = async (file, options) => {
    const response = await blobClient.getBlob({ repository: identity.repository, blobSha: file.blobSha, headSha: identity.headSha, signal: options?.signal, maxBytes: effectiveConfig.maxReadBytes });
    if (String(response?.sha || '').toLowerCase() !== file.blobSha) throw new Error('immutable blob SHA mismatch');
    return boundedText(response.content, effectiveConfig.maxReadBytes);
  };
  const call = async (tool, args = {}, options = {}) => {
    if (!['file_read', 'file_find', 'code_search', 'file_read_diff'].includes(tool)) return { status: 'unavailable', ...receipt(tool, { reason: 'review navigation tool is not registered' }) };
    const guard = takeCall(tool, options);
    if (guard) return guard;
    try {
      if (tool === 'file_find') {
        const query = String(args.query || '').trim().toLowerCase();
        if (!query || query.length > 200) return { status: 'invalid', ...receipt(tool, { reason: 'invalid path query' }) };
        const paths = [...files.keys()].filter((path) => path.toLowerCase().includes(query)).slice(0, effectiveConfig.maxFindResults);
        return { status: 'ok', ...receipt(tool, { paths, truncated: paths.length === effectiveConfig.maxFindResults }) };
      }
      if (tool === 'code_search') {
        const query = String(args.query || '').trim();
        if (!query || query.length > 200) return { status: 'invalid', ...receipt(tool, { reason: 'invalid code query' }) };
        const matches = [];
        let usedBytes = 0;
        for (const file of [...files.values()].slice(0, effectiveConfig.maxScanFiles)) {
          const loaded = await fetchFile(file, options);
          const lines = loaded.text.split(/\r?\n/u);
          for (let index = 0; index < lines.length; index += 1) {
            if (!lines[index].includes(query)) continue;
            const text = boundedText(lines[index], Math.min(500, effectiveConfig.maxResultBytes - usedBytes));
            if (!text.text) break;
            matches.push({ path: file.path, line: index + 1, text: text.text });
            usedBytes += Buffer.byteLength(text.text, 'utf8');
            if (matches.length >= effectiveConfig.maxFindResults || usedBytes >= effectiveConfig.maxResultBytes) break;
          }
          if (matches.length >= effectiveConfig.maxFindResults || usedBytes >= effectiveConfig.maxResultBytes) break;
        }
        return { status: 'ok', ...receipt(tool, { query, matches, truncated: matches.length >= effectiveConfig.maxFindResults || usedBytes >= effectiveConfig.maxResultBytes, byteCount: usedBytes }) };
      }
      const resolved = target(tool, args);
      if (resolved.result) return resolved.result;
      if (tool === 'file_read_diff') {
        const rendered = boundedText(resolved.file.patch, effectiveConfig.maxResultBytes);
        return { status: 'ok', ...receipt(tool, { path: resolved.file.path, blobSha: resolved.file.blobSha, baseSha: identity.baseSha, headSha: identity.headSha, patch: rendered.text, truncated: rendered.truncated, byteCount: rendered.byteCount }) };
      }
      if (tool === 'file_read') {
        const loaded = await fetchFile(resolved.file, options);
        const selected = lineRange(loaded.text, args.startLine, args.endLine);
        if (selected === null) return { status: 'invalid', ...receipt(tool, { reason: 'invalid line range' }) };
        const rendered = boundedText(selected, effectiveConfig.maxResultBytes);
        return { status: 'ok', ...receipt(tool, { path: resolved.file.path, blobSha: resolved.file.blobSha, content: rendered.text, truncated: loaded.truncated || rendered.truncated, byteCount: rendered.byteCount }) };
      }
    } catch (error) {
      if (isAbort(error) || options?.signal?.aborted) return { status: 'cancelled', ...receipt(tool, { reason: 'review navigation request cancelled' }) };
      return { status: 'unavailable', ...receipt(tool, { reason: error?.message || 'review navigation request failed' }) };
    }
  };
  return Object.freeze({
    capabilities: Object.freeze({ enabled: effectiveConfig.enabled, readOnly: true, transport: 'github-rest-immutable-blob', tools: ['file_read', 'file_find', 'code_search', 'file_read_diff'] }),
    call,
  });
}

module.exports = { createGitHubBlobClient, createReviewNavigationToolRegistry, resolveReviewNavigationConfig: resolveConfig };
