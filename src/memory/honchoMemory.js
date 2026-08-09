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
  const normalized = {
    event_type: cleanIdentifier(event.eventType || event.event_type, 'review-event', true),
    claim_id: cleanIdentifier(event.claimId || event.claim_id, 'none', true),
    severity: cleanIdentifier(event.severity, 'unknown', true).toUpperCase(),
    path: stripControlCharacters(event.path).slice(0, 500),
    line: Number.isInteger(event.line) ? event.line : undefined,
    state: cleanIdentifier(event.state, 'unknown', true),
    verdict: cleanIdentifier(event.verdict, 'unknown', true),
    source: cleanIdentifier(event.source, 'review-yeti', true),
    head_sha: cleanIdentifier(event.headSha || event.head_sha, 'unknown', true),
    occurred_at: event.occurredAt || event.occurred_at || now().toISOString(),
  };
  const compact = Object.fromEntries(Object.entries(normalized).filter(([, value]) => value !== undefined && value !== ''));
  compact.event_id = event.eventId || event.event_id || digest(JSON.stringify(compact));
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
        const messages = events.slice(0, 100).map((event) => {
          const normalized = normalizeReviewEvent({ ...event, headSha }, now);
          return {
            peer_id: peerId,
            content: `Review event ${normalized.event_type}; claim=${normalized.claim_id}; severity=${normalized.severity}; state=${normalized.state}; verdict=${normalized.verdict}; path=${normalized.path || 'none'}; line=${normalized.line ?? 'none'}`,
            metadata: normalized,
            created_at: normalized.occurred_at,
          };
        });
        await request(
          'POST',
          `${runtimeConfig.baseUrl}/v3/workspaces/${encodeURIComponent(runtimeConfig.workspaceId)}/sessions/${encodeURIComponent(sessionId)}/messages`,
          { messages },
          runtimeConfig,
        );
        return { accepted: messages.length, available: true };
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
};
