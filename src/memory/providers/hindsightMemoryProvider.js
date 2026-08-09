'use strict';

const { boundedInteger, scopedIdentity, exactHead, sanitizeEvents, boundedContext, resolveProfile, hydrateProfile, requestJson, healthMethod } = require('./providerCommon.js');

function createHindsightMemoryProvider({ profile = {}, env = process.env, fetchImplementation = globalThis.fetch } = {}) {
  const runtime = resolveProfile({ profile, env, defaultBaseUrl: 'https://api.hindsight.vectorize.io' });
  const headers = { Authorization: `Bearer ${runtime.apiKey}` };
  const bank = encodeURIComponent(runtime.workspace);
  const base = `${runtime.baseUrl}/v1/default/banks/${bank}`;
  return {
    id: 'hindsight', contractVersion: 'memory-provider-v1', adapterVersion: 'hindsight-rest-v1',
    capabilities: { queryContext: true, appendEvents: true, health: true, readiness: true, supportsIdempotency: false, deliverySemantics: 'at_least_once', scopes: ['repository', 'pull_request'], transports: ['rest'], domains: { recall: ['decision_feedback', 'session_recap', 'code_signals', 'rule_signals'], persist: ['processing', 'decision_feedback', 'session_recap', 'code_signals', 'rule_signals'] } },
    async queryContext({ identity, purpose = 'review-history-v1', maxEntries = 40, maxContextChars = 4000 } = {}) {
      await hydrateProfile(runtime);
      headers.Authorization = `Bearer ${runtime.apiKey}`;
      if (!runtime.enabled || !runtime.apiKey) return { status: 'unavailable', source: 'rest', protocol: 'hindsight-rest-v1', text: '', reason: 'missing Hindsight credential' };
      const payload = await requestJson(fetchImplementation, runtime, 'POST', `${base}/memories/recall`, { query: purpose, max_results: boundedInteger(maxEntries, 40, 1, 100), metadata: { user_id: scopedIdentity(identity), head_sha: exactHead(identity) } }, headers);
      const text = boundedContext(payload.results || payload.memories, exactHead(identity), maxEntries, maxContextChars);
      return { status: text ? 'available' : 'empty', source: 'rest', protocol: 'hindsight-rest-v1', text, latencyMs: 0 };
    },
    async appendEvents({ identity, events = [] } = {}) {
      await hydrateProfile(runtime);
      headers.Authorization = `Bearer ${runtime.apiKey}`;
      if (!runtime.enabled || !runtime.apiKey) return { status: 'unavailable', source: 'rest', protocol: 'hindsight-rest-v1', accepted: 0, eventIds: [], reason: 'missing Hindsight credential' };
      const { accepted, rejected } = sanitizeEvents(events);
      if (!accepted.length) return { status: 'accepted', available: true, accepted: 0, rejected: rejected.length, eventIds: [] };
      await requestJson(fetchImplementation, runtime, 'POST', `${base}/memories/retain`, { items: accepted.map((event) => ({ content: JSON.stringify(event), timestamp: event.occurred_at || new Date().toISOString(), metadata: { head_sha: exactHead(identity), event_id: event.event_id || event.eventId } })), async: false }, headers);
      return { status: 'accepted', available: true, accepted: accepted.length, rejected: rejected.length, pending: 0, eventIds: accepted.map((event) => event.event_id || event.eventId), deliverySemantics: 'at_least_once', supportsIdempotency: false };
    },
    healthCheck: healthMethod({ fetchImplementation, runtime, url: `${runtime.baseUrl}/health`, headers }),
    readiness: async () => ({ available: Boolean(runtime.enabled && runtime.apiKey), reason: runtime.apiKey ? undefined : 'missing Hindsight credential' }),
  };
}

module.exports = { createHindsightMemoryProvider };
