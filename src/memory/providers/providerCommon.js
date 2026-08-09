'use strict';

const DEFAULT_TIMEOUT_MS = 1500;
const HARD_MAX_CONTEXT_CHARS = 8000;
const EVENT_FIELDS = [
  'schema_version', 'schemaVersion', 'event_id', 'eventId', 'domain', 'event_type', 'eventType',
  'repository', 'repo', 'pr_number', 'prNumber', 'head_sha', 'headSha', 'base_sha', 'baseSha',
  'claim_id', 'claimId', 'severity', 'path', 'language', 'line', 'side', 'anchor', 'state', 'verdict',
  'source', 'policy_digest', 'policyDigest', 'rule_id', 'ruleId', 'rule_category', 'ruleCategory',
  'rule_effect', 'ruleEffect', 'rule_scope', 'ruleScope', 'rule_origin', 'ruleOrigin',
  'permission_class', 'permissionClass', 'command_kind', 'commandKind', 'reason_taxonomy',
  'reasonTaxonomy', 'reason_hash', 'reasonHash', 'thread_id', 'threadId', 'transition_id',
  'transitionId', 'turn', 'previous_head_sha', 'previousHeadSha', 'current_head_sha', 'currentHeadSha',
  'coverage_status', 'coverageStatus', 'findings_count', 'findingsCount', 'publication_count',
  'occurred_at', 'occurredAt',
];

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.trunc(number))) : fallback;
}

function scopedIdentity(identity = {}) {
  const repository = String(identity.repository || '').trim().toLowerCase();
  const prNumber = String(identity.prNumber ?? '').trim().replace(/^0+(?=\d)/u, '') || 'unknown';
  const repoSlug = repository.replace(/[^a-z0-9_.-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'unknown-repo';
  return `review-yeti:${repoSlug}:pr-${prNumber}`.slice(0, 180);
}

function exactHead(identity = {}) {
  return String(identity.headSha || '').trim().toLowerCase();
}

function sanitizeEvent(event = {}) {
  const result = {};
  for (const key of EVENT_FIELDS) {
    if (event[key] !== undefined && event[key] !== null && event[key] !== '') result[key] = event[key];
  }
  const eventId = result.event_id || result.eventId;
  const eventType = result.event_type || result.eventType;
  const headSha = result.head_sha || result.headSha;
  if (!eventId || !eventType || !result.domain || !headSha) return null;
  return result;
}

function sanitizeEvents(events = []) {
  const accepted = [];
  const rejected = [];
  for (const event of Array.isArray(events) ? events : []) {
    const sanitized = sanitizeEvent(event);
    if (sanitized) accepted.push(sanitized);
    else rejected.push(event?.eventId || event?.event_id || 'unknown');
  }
  return { accepted, rejected };
}

function parseJsonText(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try { return JSON.parse(value); } catch (_) { return null; }
}

function candidateMatchesHead(candidate, headSha) {
  const metadata = candidate?.metadata || candidate?.meta || {};
  const candidateHead = candidate?.head_sha || candidate?.headSha || metadata.head_sha || metadata.headSha;
  if (candidateHead && String(candidateHead).toLowerCase() !== String(headSha).toLowerCase()) return false;
  const parsed = parseJsonText(candidate?.memory || candidate?.content || candidate?.text || candidate?.value);
  const parsedHead = parsed?.head_sha || parsed?.headSha;
  return !parsedHead || String(parsedHead).toLowerCase() === String(headSha).toLowerCase();
}

function candidateText(candidate) {
  const value = candidate?.memory || candidate?.content || candidate?.text || candidate?.value || candidate;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function boundedContext(results, headSha, maxEntries = 40, maxContextChars = 4000) {
  const lines = [];
  for (const candidate of Array.isArray(results) ? results : []) {
    if (!candidateMatchesHead(candidate, headSha)) continue;
    const text = candidateText(candidate).replace(/[\u0000-\u001f\u007f]/gu, '').trim();
    if (!text) continue;
    lines.push(text);
    if (lines.length >= boundedInteger(maxEntries, 40, 1, 100)) break;
  }
  return lines.join('\n').slice(0, boundedInteger(maxContextChars, 4000, 1000, HARD_MAX_CONTEXT_CHARS));
}

function resolveProfile({ profile = {}, env = process.env, defaultBaseUrl }) {
  const read = (value, fallback) => value ? String(value) : fallback;
  const endpointEnv = profile.endpointEnv || profile.endpoint_env;
  const credentialEnv = profile.credentialEnv || profile.credential_env;
  const namespaceEnv = profile.namespaceEnv || profile.namespace_env;
  const workspaceEnv = profile.workspaceEnv || profile.workspace_env;
  const baseUrl = String(profile.baseUrl || (endpointEnv && env[endpointEnv]) || defaultBaseUrl || '').replace(/\/+$/u, '');
  return {
    enabled: profile.enabled !== false,
    baseUrl,
    apiKey: read(profile.apiKey || (credentialEnv && env[credentialEnv]), ''),
    namespace: read(profile.namespace || (namespaceEnv && env[namespaceEnv]), 'review-yeti'),
    workspace: read(profile.workspace || (workspaceEnv && env[workspaceEnv]), 'review-yeti'),
    timeoutMs: boundedInteger(profile.timeoutMs, DEFAULT_TIMEOUT_MS, 250, 5000),
    endpointEnv,
    credentialEnv,
    namespaceEnv,
    workspaceEnv,
    secretManager: profile.secretManager,
  };
}

async function hydrateProfile(runtime) {
  if (!runtime?.secretManager?.getSecret) return runtime;
  const secret = async (ref, current) => current || (ref ? await runtime.secretManager.getSecret(ref) : null);
  runtime.baseUrl = String(await secret(runtime.endpointEnv, runtime.baseUrl) || runtime.baseUrl).replace(/\/+$/u, '');
  runtime.apiKey = String(await secret(runtime.credentialEnv, runtime.apiKey) || '').trim();
  runtime.namespace = String(await secret(runtime.namespaceEnv, runtime.namespace) || runtime.namespace);
  runtime.workspace = String(await secret(runtime.workspaceEnv, runtime.workspace) || runtime.workspace);
  return runtime;
}

async function requestJson(fetchImplementation, runtime, method, url, body, headers = {}) {
  if (typeof fetchImplementation !== 'function') throw new Error('fetch is unavailable');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), runtime.timeoutMs);
  try {
    const response = await fetchImplementation(url, {
      method,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    const raw = typeof response.text === 'function' ? await response.text() : '';
    let parsed = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch (_) { parsed = null; }
    if (!response.ok) throw new Error(`memory provider HTTP ${response.status}`);
    return parsed || {};
  } finally {
    clearTimeout(timer);
  }
}

function healthMethod({ fetchImplementation, runtime, url, headers }) {
  return async () => {
    try {
      await hydrateProfile(runtime);
      if (!runtime.enabled || !runtime.apiKey) return { configured: false, available: false, reason: 'missing provider credential' };
      if (headers?.Authorization) headers.Authorization = headers.Authorization.replace(/ .*/u, ` ${runtime.apiKey}`);
      await requestJson(fetchImplementation, runtime, 'GET', url, undefined, headers);
      return { configured: Boolean(runtime.apiKey || runtime.baseUrl), available: true };
    } catch (error) {
      return { configured: Boolean(runtime.apiKey || runtime.baseUrl), available: false, reason: error?.message || 'health check failed' };
    }
  };
}

module.exports = {
  boundedInteger,
  scopedIdentity,
  exactHead,
  sanitizeEvent,
  sanitizeEvents,
  boundedContext,
  resolveProfile,
  hydrateProfile,
  requestJson,
  healthMethod,
};
