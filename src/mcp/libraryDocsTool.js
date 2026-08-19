'use strict';

// library_docs is a bounded, model-callable evidence tool that looks up third-party library
// documentation from Context7. It closes a real review-quality gap -- today's evidence tools
// (file_read, file_find, code_search, file_read_diff) are all local and read-only, so a reviewer
// can only pattern-match an API call, never check it against current documentation -- while
// staying inside the SAME threat model as the rest of the evidence loop: the model turn that
// decides to call this tool is derived from an attacker-controlled pull request diff (this
// action runs on pull_request_target and holds org secrets). Every design decision below exists
// to prevent that untrusted text from directing an outbound network request that could carry
// secret material.
//
// Non-negotiable rules (do not weaken without a fresh security review):
//   1. The model supplies only a library identifier and a topic string. It never supplies a
//      URL, host, path, header, or the API key -- those are all constructed/resolved here,
//      server-side, from operator-controlled configuration (CONTEXT7_API_KEY /
//      CONTEXT7_BASE_URL env vars) or safe defaults. See createLibraryDocsClient below: the
//      request target is a fixed origin plus a fixed path, never assembled from model input.
//   2. There is no generic fetch/HTTP tool here or anywhere else in the evidence registry. The
//      only network call this module can make is a single, fixed Context7 docs-search request.
//   3. Both model-supplied fields are sanitized before they leave the process: bounded length,
//      a conservative allowed character set, explicit rejection of URL-shaped text, and
//      explicit rejection of secret-shaped text (branded token prefixes and generic long
//      high-entropy runs). See sanitizeLibraryId / sanitizeTopic.
//   4. Every call this client makes -- success, sanitizer rejection, timeout, or provider
//      failure -- is returned as a plain, bounded result object. The caller (reviewNavigationTools
//      .js) wraps it in the same evidence-receipt path as the other four tools (see
//      evidenceRuntime.js); nothing here is exempt from receipting, and the API key is never
//      placed in that result.
//   5. Failure is soft: an outage, non-2xx response, oversized response, or timeout degrades
//      this ONE tool call to `unavailable`. It never throws past fetchDocs() and never blocks
//      the review or disables the other tools.

const MAX_LIBRARY_LENGTH = 64;
const MAX_TOPIC_LENGTH = 200;

// Library identifiers as sent to Context7's /docs/search (see review-pipeline.js
// buildContext7Augmentation, which already uses plain names like "typescript", "react",
// "next.js", "openai-api" against this same endpoint). Letters, digits, and a small punctuation
// set used by real package names; nothing that can carry a scheme, host, or path separator.
const LIBRARY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u;

// Topic is free-text ("useEffect cleanup", "breaking changes in v14"). Conservative allowlist:
// letters, digits, space, and a small set of punctuation that shows up in real documentation
// questions. No '@', '<', '>', '\', '$', '%', '&', ';', backtick, or control characters.
const TOPIC_ALLOWED_PATTERN = /^[A-Za-z0-9 ,.'"()?:_/-]{1,200}$/u;

// Defense in depth: the character allowlist above still permits ':' and '/' individually (for
// things like "GET /users" or "React useEffect: cleanup"), so a URL scheme could in principle be
// spelled with only allowed characters. Reject it explicitly by shape.
const URL_SHAPE_PATTERN = /:\/\/|^(?:https?|ftp|wss?):/iu;

// Branded secret/token prefixes that must never reach an outbound request even if the rest of
// the string is otherwise innocuous-looking.
const SECRET_PREFIX_PATTERN = /(sk-|pk_live_|pk_test_|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|AKIA[0-9A-Z]{12,}|xox[baprs]-|Bearer\s|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/iu;

// Generic secret/hash shape: a contiguous run of 32+ letters/digits with no separators. Real
// documentation topics are natural language and essentially never contain a bare token this
// long; API keys, GitHub tokens, JWT segments, and hex/base64 hashes routinely do.
const LONG_TOKEN_PATTERN = /[A-Za-z0-9]{32,}/u;

function sanitizeLibraryId(value) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (!text || text.length > MAX_LIBRARY_LENGTH) return { ok: false, reason: 'invalid_library' };
  if (!LIBRARY_PATTERN.test(text)) return { ok: false, reason: 'invalid_library' };
  if (URL_SHAPE_PATTERN.test(text)) return { ok: false, reason: 'invalid_library' };
  return { ok: true, value: text };
}

function sanitizeTopic(value) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (!text || text.length > MAX_TOPIC_LENGTH) return { ok: false, reason: 'invalid_topic' };
  if (!TOPIC_ALLOWED_PATTERN.test(text)) return { ok: false, reason: 'invalid_topic' };
  if (URL_SHAPE_PATTERN.test(text)) return { ok: false, reason: 'invalid_topic' };
  if (SECRET_PREFIX_PATTERN.test(text)) return { ok: false, reason: 'invalid_topic' };
  if (LONG_TOKEN_PATTERN.test(text)) return { ok: false, reason: 'invalid_topic' };
  return { ok: true, value: text };
}

function isAbort(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
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

function boundedText(value, limit) {
  const buffer = Buffer.from(String(value === undefined || value === null ? '' : value), 'utf8');
  if (buffer.length <= limit) return { text: buffer.toString('utf8'), truncated: false };
  return { text: buffer.subarray(0, limit).toString('utf8'), truncated: true };
}

// Only the Context7 API is ever contacted from this module. The origin is validated once, at
// client construction, against an explicit host allowlist -- never trusted from model input
// (there is no model input in this path at all) and never trusted blindly from an operator env
// var typo either.
const ALLOWED_HOSTS = new Set(['api.context7.ai']);

function resolveOrigin(baseUrl) {
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null;
    if (!ALLOWED_HOSTS.has(parsed.hostname)) return null;
    // Keep the configured path prefix (e.g. "/v1"), not just protocol+host -- only the origin
    // component is what's being allowlisted here, not the whole base URL string.
    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/u, '');
  } catch (_) {
    return null;
  }
}

async function readJsonBounded(response, maxBytes) {
  const header = response?.headers?.get?.('content-length');
  const declared = header === null || header === undefined || header === '' ? null : Number(header);
  if (declared !== null && (!Number.isFinite(declared) || declared < 0 || declared > maxBytes)) {
    throw Object.assign(new Error('context7_response_too_large'), { context7Code: 'context7_response_too_large' });
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw Object.assign(new Error('context7_response_too_large'), { context7Code: 'context7_response_too_large' });
  }
  return JSON.parse(text);
}

/**
 * A minimal Context7 docs-search boundary. The model never sees this client and never controls
 * its target: `library` and `topic` are the only two fields a caller can influence, both are
 * sanitized before use, and the request URL/headers/API key are fixed at construction time from
 * trusted configuration.
 */
function createLibraryDocsClient({
  apiKey,
  baseUrl = 'https://api.context7.ai/v1',
  fetchImplementation = globalThis.fetch,
  timeoutMs = 3_000,
  wireMaxBytes = 64 * 1024,
  maxResultBytes = 4_000,
  maxSnippets = 3,
} = {}) {
  const key = String(apiKey === undefined || apiKey === null ? '' : apiKey).trim();
  const origin = key ? resolveOrigin(baseUrl) : null;
  const enabled = Boolean(key) && Boolean(origin) && typeof fetchImplementation === 'function';

  async function fetchDocs({ library, topic, signal } = {}) {
    if (!enabled) return { status: 'unavailable', reason: 'context7_disabled' };
    const librarySanitized = sanitizeLibraryId(library);
    if (!librarySanitized.ok) return { status: 'invalid', reason: librarySanitized.reason };
    const topicSanitized = sanitizeTopic(topic);
    if (!topicSanitized.ok) return { status: 'invalid', reason: topicSanitized.reason };
    if (signal?.aborted) return { status: 'cancelled', reason: 'cancelled' };

    const operation = createAbortSignal(signal, timeoutMs);
    try {
      const response = await fetchImplementation(`${origin}/docs/search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // The API key never appears in the tool's argument echo, receipt, or any log line --
          // it exists only on this one outbound request header, built here, never from model
          // input.
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          library: librarySanitized.value,
          query: topicSanitized.value,
          limit: maxSnippets,
        }),
        signal: operation.signal,
      });
      if (!response?.ok) {
        const httpStatus = Number.isInteger(response?.status) ? response.status : undefined;
        return { status: 'unavailable', reason: 'context7_unavailable', ...(httpStatus ? { httpStatus } : {}) };
      }
      const body = await readJsonBounded(response, wireMaxBytes);
      const rawSnippets = Array.isArray(body?.snippets) ? body.snippets : [];
      const kept = rawSnippets.slice(0, maxSnippets);
      let truncated = rawSnippets.length > kept.length;
      let usedBytes = 0;
      const snippets = [];
      for (const entry of kept) {
        const title = boundedText(entry?.title, 200);
        const content = boundedText(entry?.content ?? entry?.snippet, 1_200);
        const remaining = maxResultBytes - usedBytes;
        if (remaining <= 0) { truncated = true; break; }
        const snippet = { title: title.text, content: content.text };
        const snippetBytes = Buffer.byteLength(JSON.stringify(snippet), 'utf8');
        if (snippetBytes > remaining) { truncated = true; break; }
        usedBytes += snippetBytes;
        if (title.truncated || content.truncated) truncated = true;
        snippets.push(snippet);
      }
      return {
        status: 'ok',
        library: librarySanitized.value,
        topic: topicSanitized.value,
        snippets,
        truncated,
        byteCount: usedBytes,
      };
    } catch (error) {
      if (operation.timedOut()) return { status: 'unavailable', reason: 'context7_timeout' };
      if (isAbort(error) || signal?.aborted) return { status: 'cancelled', reason: 'cancelled' };
      if (error?.context7Code === 'context7_response_too_large') return { status: 'unavailable', reason: 'context7_response_too_large' };
      return { status: 'unavailable', reason: 'context7_unavailable' };
    } finally {
      operation.dispose();
    }
  }

  return Object.freeze({ enabled, fetchDocs });
}

module.exports = {
  createLibraryDocsClient,
  sanitizeLibraryId,
  sanitizeTopic,
};
