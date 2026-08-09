const crypto = require('node:crypto');

const DEFAULT_BASE_URL = 'https://api.honcho.dev';
const DEFAULT_TIMEOUT_MS = 1_500;
const DEFAULT_MAX_CONTEXT_CHARS = 4_000;
const HARD_MAX_CONTEXT_CHARS = 8_000;

function asBoundedInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function cleanIdentifier(value, fallback, lower = false) {
  const cleaned = String(value ?? fallback)
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
  const result = cleaned || fallback;
  return lower ? result.toLowerCase() : result;
}

function stableWorkspaceId(value) {
  return cleanIdentifier(value, 'review-yeti');
}

function stablePeerId(repo) {
  return `review-yeti-${cleanIdentifier(repo, 'unknown-repo', true)}`.slice(0, 100);
}

function stableSessionId(repo, prNumber) {
  return `review-yeti-${cleanIdentifier(repo, 'unknown-repo', true)}-pr-${cleanIdentifier(prNumber, 'unknown', true)}`.slice(0, 100);
}

function stripControlCharacters(value) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '');
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function normalizedPrNumber(value) {
  const text = String(value ?? '').trim();
  return /^\d+$/u.test(text) ? String(Number(text)) : text || 'unknown';
}

function safeField(value, max = 500) {
  return stripControlCharacters(value).slice(0, max);
}

function eventDomain(event) {
  const domain = String(event.domain || '').toLowerCase();
  return ['processing', 'code', 'rule', 'feedback'].includes(domain) ? domain : 'processing';
}

function workspaceFromToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return typeof payload?.w === 'string' && payload.w.trim() ? payload.w.trim() : null;
  } catch (_) {
    return null;
  }
}

function normalizeReviewEvent(event = {}, now = () => new Date()) {
  const domain = eventDomain(event);
  const repository = safeField(event.repository || event.repo, 300);
  const prNumber = normalizedPrNumber(event.prNumber || event.pr_number);
  const headSha = safeField(event.headSha || event.head_sha, 128) || 'unknown';
  const claimId = safeField(event.claimId || event.claim_id, 200) || 'none';
  const anchor = safeField(event.anchor || `${event.path || 'unknown'}:${event.side || 'file'}:${Number.isInteger(event.line) ? event.line : 'file'}`, 300);
  const domainPolicyDigest = domain === 'rule' ? safeField(event.policyDigest || event.policy_digest, 128) : (event.policyDigest || event.policy_digest ? safeField(event.policyDigest || event.policy_digest, 128) : undefined);
  const normalized = {
    schema_version: safeField(event.schemaVersion || event.schema_version, 40) || 'memory-event-v1',
    domain,
    event_type: cleanIdentifier(event.eventType || event.event_type, 'review-event', true),
    claim_id: cleanIdentifier(claimId, 'none', true),
    repository: cleanIdentifier(repository, 'unknown-repo', true),
    pr_number: prNumber,
    severity: cleanIdentifier(event.severity, 'unknown', true).toUpperCase(),
    path: safeField(event.path, 500),
    language: cleanIdentifier(event.language, 'unknown', true),
    line: Number.isInteger(event.line) ? event.line : undefined,
    side: event.side === 'LEFT' || event.side === 'RIGHT' ? event.side : undefined,
    anchor,
    state: cleanIdentifier(event.state, 'unknown', true),
    verdict: cleanIdentifier(event.verdict, 'unknown', true),
    source: cleanIdentifier(event.source, 'review-yeti', true),
    head_sha: cleanIdentifier(headSha, 'unknown', true),
    base_sha: safeField(event.baseSha || event.base_sha, 128) || undefined,
    policy_digest: domainPolicyDigest,
    rule_id: cleanIdentifier(event.ruleId || event.rule_id, 'unknown', true),
    rule_category: cleanIdentifier(event.ruleCategory || event.rule_category, 'unknown', true),
    rule_effect: cleanIdentifier(event.ruleEffect || event.rule_effect, 'unknown', true),
    rule_scope: cleanIdentifier(event.ruleScope || event.rule_scope, 'unknown', true),
    rule_origin: cleanIdentifier(event.ruleOrigin || event.rule_origin, 'unknown', true),
    permission_class: cleanIdentifier(event.permissionClass || event.permission_class, 'unknown', true),
    command_kind: cleanIdentifier(event.commandKind || event.command_kind, 'unknown', true),
    reason_taxonomy: Array.isArray(event.reasonTaxonomy || event.reason_taxonomy)
      ? (event.reasonTaxonomy || event.reason_taxonomy).map((value) => cleanIdentifier(value, 'unknown', true)).slice(0, 8)
      : undefined,
    reason_hash: safeField(event.reasonHash || event.reason_hash, 128) || undefined,
    thread_id: safeField(event.threadId || event.thread_id, 128) || undefined,
    transition_id: safeField(event.transitionId || event.transition_id, 128) || undefined,
    delivery_state: cleanIdentifier(event.deliveryState || event.delivery_state, 'pending', true),
    turn: Number.isInteger(event.turn) ? event.turn : undefined,
    previous_head_sha: safeField(event.previousHeadSha || event.previous_head_sha, 128) || undefined,
    current_head_sha: safeField(event.currentHeadSha || event.current_head_sha, 128) || undefined,
    coverage_status: cleanIdentifier(event.coverageStatus || event.coverage_status, 'unknown', true),
    findings_count: Number.isInteger(event.findingsCount) ? event.findingsCount : undefined,
    publication_count: Number.isInteger(event.count) ? event.count : undefined,
    comment_id: Number.isInteger(event.commentId) ? event.commentId : undefined,
    occurred_at: event.occurredAt || event.occurred_at || now().toISOString(),
  };
  const compact = Object.fromEntries(Object.entries(normalized).filter(([, value]) => value !== undefined && value !== ''));
  compact.event_id = event.eventId || event.event_id || digest(canonicalJson({
    schemaVersion: compact.schema_version,
    domain: compact.domain,
    eventType: compact.event_type,
    repository: compact.repository,
    prNumber: compact.pr_number,
    headSha: compact.head_sha,
    claimId: compact.claim_id,
    anchor: compact.anchor,
    domainPolicyDigest: compact.policy_digest || null,
  }));
  return compact;
}

async function resolveHonchoConfig({ config = {}, env = process.env, secretManager } = {}) {
  if (config.enabled === false || String(env.HONCHO_ENABLED || '').toLowerCase() === 'false') {
    return { enabled: false, reason: 'disabled' };
  }

  const getSecret = async (name, configuredValue, environmentValue) => {
    if (configuredValue) return configuredValue;
    if (environmentValue) return environmentValue;
    return secretManager?.getSecret ? secretManager.getSecret(name) : null;
  };

  const configuredBaseUrl = await getSecret('HONCHO_URL', config.baseUrl, env.HONCHO_URL)
    || await getSecret('HONCHO_BASE_URL', undefined, env.HONCHO_BASE_URL);
  const baseUrl = String(configuredBaseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const apiKey = String(
    await getSecret('HONCHO_API_KEY', config.apiKey, env.HONCHO_API_KEY)
      || await getSecret('HONCHO_WORKSPACE_JWT', undefined, env.HONCHO_WORKSPACE_JWT)
      || '',
  ).trim();
  const workspaceValue = await getSecret('HONCHO_WORKSPACE_ID', config.workspaceId, env.HONCHO_WORKSPACE_ID)
    || await getSecret('HONCHO_WORKSPACE', undefined, env.HONCHO_WORKSPACE)
    || workspaceFromToken(apiKey);
  const workspaceId = stableWorkspaceId(workspaceValue || 'review-yeti');
  const enabled = Boolean(apiKey && baseUrl && workspaceValue);
  return {
    enabled,
    baseUrl,
    apiKey,
    workspaceId,
    timeoutMs: asBoundedInteger(config.timeoutMs ?? env.HONCHO_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 250, 5_000),
    maxContextChars: asBoundedInteger(config.maxContextChars ?? env.HONCHO_MAX_CONTEXT_CHARS, DEFAULT_MAX_CONTEXT_CHARS, 1, HARD_MAX_CONTEXT_CHARS),
    reason: enabled ? undefined : 'missing HONCHO_URL, HONCHO_API_KEY, or HONCHO_WORKSPACE_ID',
  };
}

function createHonchoMemoryProvider({
  config = {},
  env = process.env,
  secretManager,
  fetchImplementation = globalThis.fetch,
  now = () => new Date(),
} = {}) {
  let resolvedConfig;
  const resolveConfig = async () => {
    if (!resolvedConfig) resolvedConfig = await resolveHonchoConfig({ config, env, secretManager });
    return resolvedConfig;
  };

  const request = async (method, url, body, runtimeConfig) => {
    if (typeof fetchImplementation !== 'function') throw new Error('fetch is unavailable');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), runtimeConfig.timeoutMs);
    try {
      const response = await fetchImplementation(url, {
        method,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${runtimeConfig.apiKey}`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const raw = typeof response.text === 'function' ? await response.text() : '';
      const bounded = raw.slice(0, HARD_MAX_CONTEXT_CHARS * 2);
      let parsed = null;
      if (bounded) {
        try { parsed = JSON.parse(bounded); } catch (_) { parsed = null; }
      }
      if (!response.ok) throw new Error(`Honcho API status ${response.status}`);
      return parsed;
    } finally {
      clearTimeout(timer);
    }
  };

  const ensureResources = async (identity, runtimeConfig) => {
    const peerId = stablePeerId(identity.repo);
    const sessionId = stableSessionId(identity.repo, identity.prNumber);
    const workspacePath = `${runtimeConfig.baseUrl}/v3/workspaces`;
    await request('POST', workspacePath, { id: runtimeConfig.workspaceId, metadata: { source: 'review-yeti' } }, runtimeConfig);
    await request('POST', `${workspacePath}/${encodeURIComponent(runtimeConfig.workspaceId)}/peers`, {
      id: peerId,
      metadata: { repository: identity.repo },
    }, runtimeConfig);
    await request('POST', `${workspacePath}/${encodeURIComponent(runtimeConfig.workspaceId)}/sessions`, {
      id: sessionId,
      metadata: { repository: identity.repo, pr_number: String(identity.prNumber) },
    }, runtimeConfig);
    return { peerId, sessionId };
  };

  return {
    get enabled() {
      return Boolean(resolvedConfig?.enabled);
    },

    async healthCheck() {
      const runtimeConfig = await resolveConfig();
      if (!runtimeConfig.enabled) return { configured: false, available: false, reason: runtimeConfig.reason };
      try {
        const response = await fetchImplementation(`${runtimeConfig.baseUrl}/health`, {
          headers: { Accept: 'application/json', Authorization: `Bearer ${runtimeConfig.apiKey}` },
          signal: AbortSignal.timeout(runtimeConfig.timeoutMs),
        });
        return { configured: true, available: response.ok, status: response.status };
      } catch (error) {
        return { configured: true, available: false, reason: error?.message || 'health check failed' };
      }
    },

    async resolveContext({ repo, prNumber, headSha, query = 'prior review decisions and recurring claims' }) {
      const runtimeConfig = await resolveConfig();
      if (!runtimeConfig.enabled) return { available: false, text: '', reason: runtimeConfig.reason };
      try {
        const { peerId, sessionId } = await ensureResources({ repo, prNumber, headSha }, runtimeConfig);
        const payload = await request(
          'POST',
          `${runtimeConfig.baseUrl}/v3/workspaces/${encodeURIComponent(runtimeConfig.workspaceId)}/peers/${encodeURIComponent(peerId)}/representation`,
          { session_id: sessionId, search_query: stripControlCharacters(query).slice(0, 2_000), search_top_k: 10, max_conclusions: 20 },
          runtimeConfig,
        );
        const text = stripControlCharacters(payload?.representation).slice(0, runtimeConfig.maxContextChars);
        return text ? { available: true, text } : { available: false, text: '', reason: 'Honcho returned no representation' };
      } catch (error) {
        return { available: false, text: '', reason: error?.message || 'Honcho context unavailable' };
      }
    },

    async appendEvents({ repo, prNumber, headSha, events = [] }) {
      const runtimeConfig = await resolveConfig();
      if (!runtimeConfig.enabled) return { accepted: 0, available: false, reason: runtimeConfig.reason };
      if (!Array.isArray(events) || events.length === 0) return { accepted: 0, available: true };
      try {
        const { peerId, sessionId } = await ensureResources({ repo, prNumber, headSha }, runtimeConfig);
        const normalizedEvents = events.map((event) => normalizeReviewEvent({ ...event, repo, prNumber, headSha }, now));
        const messageUrl = `${runtimeConfig.baseUrl}/v3/workspaces/${encodeURIComponent(runtimeConfig.workspaceId)}/sessions/${encodeURIComponent(sessionId)}/messages`;
        let accepted = 0;
        for (let offset = 0; offset < normalizedEvents.length; offset += 100) {
          const messages = normalizedEvents.slice(offset, offset + 100).map((normalized) => ({
            peer_id: peerId,
            content: `Review event ${normalized.event_type}; domain=${normalized.domain}; claim=${normalized.claim_id}; severity=${normalized.severity}; state=${normalized.state}; verdict=${normalized.verdict}; path=${normalized.path || 'none'}; line=${normalized.line ?? 'none'}`,
            metadata: normalized,
            created_at: normalized.occurred_at,
          }));
          await request('POST', messageUrl, { messages }, runtimeConfig);
          accepted += messages.length;
        }
        return { accepted, available: true, eventIds: normalizedEvents.map((event) => event.event_id), chunks: Math.ceil(normalizedEvents.length / 100) };
      } catch (error) {
        return { accepted: 0, available: false, reason: error?.message || 'Honcho event write failed' };
      }
    },
  };
}

module.exports = {
  createHonchoMemoryProvider,
  normalizeReviewEvent,
  resolveHonchoConfig,
  stablePeerId,
  stableSessionId,
  stableWorkspaceId,
  canonicalJson,
};
