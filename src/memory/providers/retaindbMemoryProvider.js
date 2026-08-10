'use strict';

const { boundedInteger, scopedIdentity, exactHead, sanitizeEvents, boundedContext, resolveProfile, hydrateProfile, requestJson, healthMethod } = require('./providerCommon.js');

function createRetainDbMemoryProvider({ profile = {}, env = process.env, fetchImplementation = globalThis.fetch } = {}) {
  const runtime = resolveProfile({ profile, env, defaultBaseUrl: 'https://api.retaindb.ai' });
  const headers = { Authorization: `Bearer ${runtime.apiKey}` };
  return {
    id: 'retaindb', contractVersion: 'memory-provider-v1', adapterVersion: 'retaindb-rest-v1', experimental: true,
    capabilities: { queryContext: true, appendEvents: true, health: true, readiness: true, supportsIdempotency: false, deliverySemantics: 'at_least_once', scopes: ['repository', 'pull_request'], transports: ['rest'], domains: { recall: ['decision_feedback', 'session_recap', 'code_signals', 'rule_signals'], persist: ['processing', 'decision_feedback', 'session_recap', 'code_signals', 'rule_signals'] } },
    async queryContext({ identity, purpose = 'review-history-v1', maxEntries = 40, maxContextChars = 4000 } = {}) {
      await hydrateProfile(runtime);
      headers.Authorization = `Bearer ${runtime.apiKey}`;
      if (!runtime.enabled || !runtime.apiKey) return { status: 'unavailable', source: 'rest', protocol: 'retaindb-rest-v1', text: '', experimental: true, reason: 'missing RetainDB credential' };
      const payload = await requestJson(fetchImplementation, runtime, 'POST', `${runtime.baseUrl}/v1/memories/search`, { project: runtime.workspace, user_id: scopedIdentity(identity), session_id: exactHead(identity), query: purpose, include_pending: true, top_k: boundedInteger(maxEntries, 40, 1, 100) }, headers);
      const text = boundedContext(payload.results || payload.memories, exactHead(identity), maxEntries, maxContextChars);
      return { status: text ? 'available' : 'empty', source: 'rest', protocol: 'retaindb-rest-v1', text, experimental: true, latencyMs: 0 };
    },
    async appendEvents({ identity, events = [] } = {}) {
      await hydrateProfile(runtime);
      headers.Authorization = `Bearer ${runtime.apiKey}`;
      if (!runtime.enabled || !runtime.apiKey) return { status: 'unavailable', source: 'rest', protocol: 'retaindb-rest-v1', accepted: 0, eventIds: [], experimental: true, reason: 'missing RetainDB credential' };
      const { accepted, rejected } = sanitizeEvents(events);
      if (!accepted.length) return { status: 'accepted', available: true, accepted: 0, rejected: rejected.length, pending: 0, eventIds: [], experimental: true };
      for (const event of accepted) {
        await requestJson(fetchImplementation, runtime, 'POST', `${runtime.baseUrl}/v1/memories`, { project: runtime.workspace, user_id: scopedIdentity(identity), session_id: exactHead(identity), content: JSON.stringify(event), write_mode: 'async', metadata: { head_sha: exactHead(identity), event_id: event.event_id || event.eventId } }, headers);
      }
      return { status: 'accepted', available: true, accepted: accepted.length, rejected: rejected.length, pending: accepted.length, eventIds: accepted.map((event) => event.event_id || event.eventId), deliverySemantics: 'at_least_once', supportsIdempotency: false, experimental: true };
    },
    healthCheck: healthMethod({ fetchImplementation, runtime, url: `${runtime.baseUrl}/health`, headers }),
    readiness: async () => ({ available: false, experimental: true, reason: 'RetainDB adapter requires live ingestion/readiness evidence' }),
  };
}

module.exports = { createRetainDbMemoryProvider };
