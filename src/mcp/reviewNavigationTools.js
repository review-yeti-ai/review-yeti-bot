'use strict';

const { createLibraryDocsClient } = require('./libraryDocsTool');

const DEFAULTS = Object.freeze({
  enabled: false,
  maxCalls: 12,
  maxReadBytes: 32 * 1024,
  maxResultBytes: 8 * 1024,
  maxFindResults: 50,
  // REL: repo-wide code_search no longer requires the caller to name explicit paths (see
  // resolveCandidatePaths below), so this ceiling now bounds how many files a single unscoped
  // search may fan out to, not just how many an already-narrowed caller could name. Raised well
  // above the old 20-file requirement. The production caller (review-pipeline.js
  // makeEvidenceRegistry) currently pins this at 20 via an explicit config override; see the PR
  // description for the one-line follow-up to raise it there too.
  maxScanFiles: 60,
  timeoutMs: 1_500,
  // Coarse wall-clock circuit breaker for a single code_search call's file-scan loop (blob
  // fetch + line scan per file). Independent of the per-blob-fetch timeoutMs above; this bounds
  // the *whole* fan-out, so raising maxScanFiles or accepting a regex query cannot turn one tool
  // call into an unbounded stall.
  codeSearchWallClockMs: 2_000,
  // library_docs (Context7) tuning. Deliberately smaller/shorter than the file-tool defaults:
  // this is one outbound network call per invocation, must fail soft fast, and only needs to
  // return a handful of short doc snippets.
  context7TimeoutMs: 3_000,
  context7MaxResultBytes: 4_000,
  context7MaxSnippets: 3,
});
const MAX_LIMITS = Object.freeze({
  maxCalls: 40,
  maxReadBytes: 64 * 1024,
  maxResultBytes: 64 * 1024,
  maxFindResults: 50,
  maxScanFiles: 200,
  timeoutMs: 5_000,
  codeSearchWallClockMs: 4_000,
  context7TimeoutMs: 5_000,
  context7MaxResultBytes: 16 * 1024,
  context7MaxSnippets: 5,
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
    codeSearchWallClockMs: boundedInteger(config.codeSearchWallClockMs, DEFAULTS.codeSearchWallClockMs, MAX_LIMITS.codeSearchWallClockMs),
    context7TimeoutMs: boundedInteger(config.context7TimeoutMs, DEFAULTS.context7TimeoutMs, MAX_LIMITS.context7TimeoutMs),
    context7MaxResultBytes: boundedInteger(config.context7MaxResultBytes, DEFAULTS.context7MaxResultBytes, MAX_LIMITS.context7MaxResultBytes),
    context7MaxSnippets: boundedInteger(config.context7MaxSnippets, DEFAULTS.context7MaxSnippets, MAX_LIMITS.context7MaxSnippets),
  };
}

function isAbort(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

function navigationError(code, status) {
  const error = new Error(code);
  error.reviewNavigationCode = code;
  if (Number.isInteger(status) && status >= 100 && status <= 599) error.httpStatus = status;
  return error;
}

function readResponseBodyBounded(response, maxBytes) {
  const header = response?.headers?.get?.('content-length');
  const declaredLength = header === null || header === undefined || header === '' ? null : Number(header);
  if (declaredLength !== null && (!Number.isFinite(declaredLength) || declaredLength < 0 || declaredLength > maxBytes)) {
    return Promise.reject(navigationError('blob_response_too_large'));
  }
  const chunks = [];
  let total = 0;
  const append = (value) => {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    total += chunk.length;
    if (total > maxBytes) throw navigationError('blob_response_too_large');
    chunks.push(chunk);
  };
  const collect = async () => {
    if (response?.body?.getReader) {
      const reader = response.body.getReader();
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          append(next.value);
        }
      } finally {
        try { await reader.cancel(); } catch (_) { /* already closed */ }
      }
      return Buffer.concat(chunks).toString('utf8');
    }
    if (response?.body && typeof response.body[Symbol.asyncIterator] === 'function') {
      for await (const chunk of response.body) append(chunk);
      return Buffer.concat(chunks).toString('utf8');
    }
    // A test double or legacy fetch shim can use text(), but only after a verified wire bound.
    if (declaredLength !== null && typeof response?.text === 'function') {
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > maxBytes) throw navigationError('blob_response_too_large');
      return text;
    }
    throw navigationError('blob_fetch_failed');
  };
  return collect();
}

function base64Value(code) {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  if (code === 43) return 62;
  if (code === 47) return 63;
  return -1;
}

// Decode only enough Base64 to satisfy the caller's decoded byte ceiling. This deliberately
// never constructs a full decoded buffer just to return a truncated prefix.
function decodeBase64Bounded(value, maxBytes) {
  const encoded = String(value || '');
  const output = Buffer.allocUnsafe(maxBytes);
  let written = 0;
  let accumulator = 0;
  let bits = 0;
  let padded = false;
  for (let index = 0; index < encoded.length; index += 1) {
    const code = encoded.charCodeAt(index);
    if (code === 9 || code === 10 || code === 13 || code === 32) continue;
    if (code === 61) {
      padded = true;
      continue;
    }
    if (padded) throw navigationError('blob_fetch_failed');
    const value6 = base64Value(code);
    if (value6 < 0) throw navigationError('blob_fetch_failed');
    accumulator = (accumulator << 6) | value6;
    bits += 6;
    while (bits >= 8) {
      bits -= 8;
      if (written >= maxBytes) return { buffer: output, truncated: true };
      output[written] = (accumulator >> bits) & 0xff;
      written += 1;
    }
    accumulator = bits === 0 ? 0 : accumulator & ((1 << bits) - 1);
  }
  return { buffer: output.subarray(0, written), truncated: false };
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
  // A malformed individual record (an overlong or unusual path, an unexpected ref, a duplicate
  // key -- all realistic in a large real-world monorepo tree: generated assets, deeply nested
  // vendored dependencies, build output) used to throw and disable navigation tooling for the
  // *entire* review, for every other otherwise-valid file in the snapshot. That is strictly worse
  // than just excluding the one bad record: it silently drops evidence tooling repo-wide, which
  // (via reviewInvestigation.js candidateFindings) can turn a real defect into a manufactured
  // APPROVE. Skip the bad record and keep going; the file is simply unreachable via file_read /
  // file_find, same as any other file that was never in the snapshot to begin with.
  const files = new Map();
  for (const file of snapshot.files) {
    const ref = String(file?.ref || 'head').toLowerCase();
    if (!['base', 'head'].includes(ref) || !validPath(file?.path) || !SHA.test(String(file?.blobSha || ''))) continue;
    const key = `${ref}:${file.path}`;
    if (files.has(key)) continue;
    files.set(key, Object.freeze({
      ref,
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

// --- code_search regex safety -------------------------------------------------------------
//
// code_search accepts an optional regex mode (args.regex === true). The pattern is
// model-authored, therefore attacker-influenced, and is run against untrusted repository text
// -- the classic setup for a ReDoS denial of service against the reviewer process itself. There
// is no linear-time regex engine in this codebase's dependency tree (no RE2; adding a native
// dependency is out of scope for this change), so instead of a formal guarantee this applies
// layered, conservative mitigations:
//   1. A hard pattern-length cap (matches the existing 200-char query cap).
//   2. Static rejection of backreferences and lookaround, and of the classic nested-quantifier
//      shape ((a+)+, (a|a)*, (.*)+, ...) that causes catastrophic exponential backtracking.
//   3. A cap on the total number of quantifiers in one pattern, bounding worst-case polynomial
//      blowup for patterns the nested-quantifier check does not flag (e.g. long chains of
//      unrelated `.*`).
//   4. Each tested line is truncated before matching, bounding the input size a pattern that
//      slips past the above can ever run against.
//   5. A coarse wall-clock circuit breaker around the whole multi-file scan (see
//      codeSearchWallClockMs) stops the fan-out between files/lines; it cannot interrupt a
//      single pathological regex().test() call already in flight (JS regex execution cannot be
//      preempted without a worker thread), which is why 1-4 exist first.
const MAX_REGEX_PATTERN_LENGTH = 200;
const MAX_REGEX_LINE_CHARS = 4_000;
const MAX_REGEX_QUANTIFIERS = 10;
const REGEX_BACKREFERENCE_PATTERN = /\\[1-9]/u;
const REGEX_LOOKAROUND_PATTERN = /\(\?[=!<]/u;
const REGEX_QUANTIFIER_COUNT_PATTERN = /(?<!\\)[*+]|(?<!\\)\{\d+(?:,\d*)?\}/gu;

// Rejects a repetition quantifier applied to a group whose own body also contains a repetition
// quantifier or alternation -- the shape behind (a+)+, (a|a)*, (.*)+, and similar catastrophic
// patterns. This is a conservative static heuristic: it can reject some pathological-looking
// but actually-safe patterns (acceptable -- code_search has a substring mode for those), and it
// is not a formal proof of linear-time behavior, which is why it is paired with 1, 3, and 4
// above rather than trusted alone.
function hasNestedQuantifier(source) {
  const stack = [];
  const groups = [];
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '\\') { index += 1; continue; }
    if (char === '(') { stack.push(index); continue; }
    if (char === ')') {
      const start = stack.pop();
      if (start === undefined) continue;
      groups.push([start, index]);
    }
  }
  if (stack.length > 0) return true; // unbalanced parens -- treat conservatively as unsafe
  for (const [start, end] of groups) {
    const body = source.slice(start + 1, end);
    const bodyHasQuantifier = /(?<!\\)[*+]/u.test(body) || /(?<!\\)\{\d/u.test(body) || /(?<!\\)\|/u.test(body);
    const groupIsQuantified = end + 1 < source.length && /[*+?{]/u.test(source[end + 1]);
    if (groupIsQuantified && bodyHasQuantifier) return true;
  }
  return false;
}

function validateSafeRegexSource(source) {
  const text = String(source || '');
  if (!text || text.length > MAX_REGEX_PATTERN_LENGTH) return { ok: false };
  if (REGEX_BACKREFERENCE_PATTERN.test(text)) return { ok: false };
  if (REGEX_LOOKAROUND_PATTERN.test(text)) return { ok: false };
  if ((text.match(REGEX_QUANTIFIER_COUNT_PATTERN) || []).length > MAX_REGEX_QUANTIFIERS) return { ok: false };
  if (hasNestedQuantifier(text)) return { ok: false };
  return { ok: true, value: text };
}

function regexSafeSlice(line) {
  return line.length > MAX_REGEX_LINE_CHARS ? line.slice(0, MAX_REGEX_LINE_CHARS) : line;
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
        const maxWireBytes = Math.min(256 * 1024, (boundedInteger(maxBytes, MAX_LIMITS.maxReadBytes, MAX_LIMITS.maxReadBytes) * 4) + 4096);
        if (!response.ok) throw navigationError('blob_fetch_failed', response.status);
        const raw = await readResponseBodyBounded(response, maxWireBytes);
        const payload = JSON.parse(raw);
        if (String(payload?.sha || '').toLowerCase() !== String(blobSha).toLowerCase() || payload?.encoding !== 'base64') {
          throw navigationError('blob_sha_mismatch');
        }
        const decoded = decodeBase64Bounded(payload.content, boundedInteger(maxBytes, MAX_LIMITS.maxReadBytes, MAX_LIMITS.maxReadBytes));
        return { sha: String(payload.sha).toLowerCase(), content: decoded.buffer.toString('utf8'), truncated: decoded.truncated, byteCount: decoded.buffer.length };
      } catch (error) {
        if (operation.timedOut()) throw navigationError('request_timeout');
        if (isAbort(error) || signal?.aborted) throw navigationError('cancelled');
        if (error?.reviewNavigationCode) throw error;
        throw navigationError('blob_fetch_failed');
      } finally {
        operation.dispose();
      }
    },
  };
}

function createReviewNavigationToolRegistry({ identity, snapshot, blobClient, config = {}, context7Client, fetchImplementation } = {}) {
  if (!validIdentity(identity)) throw new Error('review navigation requires a valid immutable review identity');
  if (!blobClient || typeof blobClient.getBlob !== 'function') throw new Error('review navigation requires a read-only GitHub blob client');
  const effectiveConfig = resolveConfig(config);
  const files = normalizeSnapshot(snapshot, identity);
  // library_docs (Context7). Unlike blobClient, this is optional and fails soft: with no
  // CONTEXT7_API_KEY configured (the common case -- most repos/runs never set it), docsClient
  // is simply disabled and every library_docs call returns 'unavailable' / 'context7_disabled',
  // exactly like the other tools do when the whole registry is disabled. Constructed once, at
  // registry build time, from operator-controlled configuration only -- the model never reaches
  // this constructor and cannot influence the key, base URL, or transport.
  const docsClient = context7Client || createLibraryDocsClient({
    apiKey: process.env.CONTEXT7_API_KEY,
    baseUrl: process.env.CONTEXT7_BASE_URL,
    fetchImplementation: fetchImplementation || globalThis.fetch,
    timeoutMs: effectiveConfig.context7TimeoutMs,
    maxResultBytes: effectiveConfig.context7MaxResultBytes,
    maxSnippets: effectiveConfig.context7MaxSnippets,
  });
  let calls = 0;
  const receipt = (tool, extra = {}) => ({ identity: { ...identity }, tool, ...extra });
  const disabled = (tool, reason) => ({ status: 'unavailable', ...receipt(tool, { reason }) });
  const takeCall = (tool, options) => {
    if (!effectiveConfig.enabled) return disabled(tool, 'disabled');
    if (options?.signal?.aborted) return { status: 'cancelled', ...receipt(tool, { reason: 'cancelled' }) };
    if (calls >= effectiveConfig.maxCalls) return disabled(tool, 'call_budget_exhausted');
    calls += 1;
    return null;
  };
  const target = (tool, args) => {
    const path = args?.path;
    const ref = String(args?.ref || 'head').toLowerCase();
    if (!validPath(path)) return { result: { status: 'invalid', ...receipt(tool, { reason: 'invalid file path' }) } };
    if (!['base', 'head'].includes(ref)) return { result: { status: 'invalid', ...receipt(tool, { reason: 'invalid ref' }) } };
    const file = files.get(`${ref}:${path}`);
    if (!file) return { result: disabled(tool, 'file_not_in_snapshot') };
    return { file };
  };
  const fetchFile = async (file, options) => {
    const response = await blobClient.getBlob({ repository: identity.repository, blobSha: file.blobSha, headSha: file.ref === 'base' ? identity.baseSha : identity.headSha, signal: options?.signal, maxBytes: effectiveConfig.maxReadBytes });
    if (String(response?.sha || '').toLowerCase() !== file.blobSha) throw navigationError('blob_sha_mismatch');
    return boundedText(response.content, effectiveConfig.maxReadBytes);
  };
  const call = async (tool, args = {}, options = {}) => {
    if (!['file_read', 'file_find', 'code_search', 'file_read_diff', 'library_docs'].includes(tool)) return { status: 'unavailable', ...receipt(tool, { reason: 'tool_not_registered' }) };
    const guard = takeCall(tool, options);
    if (guard) return guard;
    try {
      if (tool === 'file_find') {
        const query = String(args.query || '').trim().toLowerCase();
        const ref = String(args.ref || 'head').toLowerCase();
        if (!query || query.length > 200) return { status: 'invalid', ...receipt(tool, { reason: 'invalid path query' }) };
        if (!['base', 'head'].includes(ref)) return { status: 'invalid', ...receipt(tool, { reason: 'invalid ref' }) };
        const paths = [...files.values()].filter((file) => file.ref === ref && file.path.toLowerCase().includes(query)).map((file) => file.path).slice(0, effectiveConfig.maxFindResults);
        return { status: 'ok', ...receipt(tool, { ref, paths, truncated: paths.length === effectiveConfig.maxFindResults }) };
      }
      if (tool === 'library_docs') {
        const result = await docsClient.fetchDocs({ library: args.library, topic: args.topic, signal: options?.signal });
        if (result.status === 'ok') {
          return { status: 'ok', ...receipt(tool, { library: result.library, topic: result.topic, snippets: result.snippets, truncated: result.truncated, byteCount: result.byteCount }) };
        }
        return { status: result.status, ...receipt(tool, { reason: result.reason, ...(result.httpStatus ? { httpStatus: result.httpStatus } : {}) }) };
      }
      if (tool === 'code_search') {
        const ref = String(args.ref || 'head').toLowerCase();
        if (!['base', 'head'].includes(ref)) return { status: 'invalid', ...receipt(tool, { reason: 'invalid ref' }) };
        const useRegex = args.regex === true;
        const rawQuery = String(args.query || '').trim();
        let matchesLine;
        if (useRegex) {
          const validated = validateSafeRegexSource(rawQuery);
          if (!validated.ok) return { status: 'invalid', ...receipt(tool, { reason: 'invalid code query' }) };
          let compiled;
          try {
            compiled = new RegExp(validated.value, args.caseInsensitive === true ? 'iu' : 'u');
          } catch (_) {
            return { status: 'invalid', ...receipt(tool, { reason: 'invalid code query' }) };
          }
          matchesLine = (line) => compiled.test(regexSafeSlice(line));
        } else {
          if (!rawQuery || rawQuery.length > 200) return { status: 'invalid', ...receipt(tool, { reason: 'invalid code query' }) };
          matchesLine = (line) => line.includes(rawQuery);
        }
        // REL: an explicit `paths` list still narrows the search exactly as before. Omitting it
        // no longer fails with 'paths_required' -- it now searches every file in the snapshot
        // for the given ref, bounded by maxScanFiles below, so a repo-wide query works without
        // the caller first having to discover exact paths via file_find.
        const explicitPaths = Array.isArray(args.paths) ? [...new Set(args.paths.map((path) => String(path).trim()))] : null;
        const candidatePaths = explicitPaths ?? [...files.values()].filter((file) => file.ref === ref).map((file) => file.path).sort();
        const paths = candidatePaths.slice(0, effectiveConfig.maxScanFiles);
        const matches = [];
        let usedBytes = 0;
        let timedOut = false;
        const requested = paths.map((path) => files.get(`${ref}:${path}`)).filter(Boolean);
        const scanDeadline = Date.now() + effectiveConfig.codeSearchWallClockMs;
        for (const file of requested) {
          if (Date.now() >= scanDeadline) { timedOut = true; break; }
          const loaded = await fetchFile(file, options);
          const lines = loaded.text.split(/\r?\n/u);
          for (let index = 0; index < lines.length; index += 1) {
            if (!matchesLine(lines[index])) continue;
            const text = boundedText(lines[index], Math.min(500, effectiveConfig.maxResultBytes - usedBytes));
            if (!text.text) break;
            matches.push({ path: file.path, line: index + 1, text: text.text });
            usedBytes += Buffer.byteLength(text.text, 'utf8');
            if (matches.length >= effectiveConfig.maxFindResults || usedBytes >= effectiveConfig.maxResultBytes) break;
          }
          if (matches.length >= effectiveConfig.maxFindResults || usedBytes >= effectiveConfig.maxResultBytes) break;
        }
        const truncated = timedOut || requested.length < candidatePaths.length || matches.length >= effectiveConfig.maxFindResults || usedBytes >= effectiveConfig.maxResultBytes;
        return { status: 'ok', ...receipt(tool, { ref, query: rawQuery, regex: useRegex, requestedFiles: paths.length, scannedFiles: requested.length, matches, truncated, byteCount: usedBytes }) };
      }
      const resolved = target(tool, args);
      if (resolved.result) return resolved.result;
      if (tool === 'file_read_diff') {
        const rendered = boundedText(resolved.file.patch, effectiveConfig.maxResultBytes);
        return { status: 'ok', ...receipt(tool, { ref: resolved.file.ref, path: resolved.file.path, blobSha: resolved.file.blobSha, baseSha: identity.baseSha, headSha: identity.headSha, patch: rendered.text, truncated: rendered.truncated, byteCount: rendered.byteCount }) };
      }
      if (tool === 'file_read') {
        const loaded = await fetchFile(resolved.file, options);
        const selected = lineRange(loaded.text, args.startLine, args.endLine);
        if (selected === null) return { status: 'invalid', ...receipt(tool, { reason: 'invalid line range' }) };
        const rendered = boundedText(selected, effectiveConfig.maxResultBytes);
        return { status: 'ok', ...receipt(tool, { ref: resolved.file.ref, path: resolved.file.path, blobSha: resolved.file.blobSha, content: rendered.text, truncated: loaded.truncated || rendered.truncated, byteCount: rendered.byteCount }) };
      }
    } catch (error) {
      if (isAbort(error) || error?.reviewNavigationCode === 'cancelled' || options?.signal?.aborted) return { status: 'cancelled', ...receipt(tool, { reason: 'cancelled' }) };
      const reason = ['blob_fetch_failed', 'blob_sha_mismatch', 'blob_response_too_large', 'request_timeout'].includes(error?.reviewNavigationCode)
        ? error.reviewNavigationCode
        : 'blob_fetch_failed';
      return { status: 'unavailable', ...receipt(tool, { reason, ...(Number.isInteger(error?.httpStatus) ? { httpStatus: error.httpStatus } : {}) }) };
    }
  };
  return Object.freeze({
    capabilities: Object.freeze({ enabled: effectiveConfig.enabled, readOnly: true, transport: 'github-rest-immutable-blob', tools: ['file_read', 'file_find', 'code_search', 'file_read_diff', 'library_docs'] }),
    call,
  });
}

module.exports = { createGitHubBlobClient, createReviewNavigationToolRegistry, resolveReviewNavigationConfig: resolveConfig };
