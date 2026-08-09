'use strict';

const { boundedInteger, scopedIdentity, exactHead, sanitizeEvents, boundedContext, resolveProfile, requestJson, healthMethod } = require('./providerCommon.js');

function createSupermemoryMemoryProvider({ profile = {}, env = process.env, fetchImplementation = globalThis.fetch } = {}) {
  const runtime = resolveProfile({ profile, env, defaultBaseUrl: 'https://api.supermemory.ai' });
  const headers = { Authorization: `Bearer ${runtime.apiKey}` };
  const tag = scopedIdentity;
  return {
    id: 'supermemory', contractVersion: 'memory-provider-v1', adapterVersion: 'supermemory-rest-v1', experimental: true,
    capabilities: { queryContext: true, appendEvents: true, health: true, readiness: true, supportsIdempotency: true, deliverySemantics: 'at_least_once', scopes: ['repository', 'pull_request'], transports: ['rest'], domains: { recall: ['decision_feedback', 'session_recap', 'code_signals', 'rule_signals'], persist: ['processing', 'decision_feedback', 'session_recap', 'code_signals', 'rule_signals'] } },
    async queryContext({ identity, purpose = 'review-history-v1', maxEntries = 40, maxContextChars = 4000 } = {}) {
      const payload = await requestJson(fetchImplementation, runtime, 'POST', `${runtime.baseUrl}/v4/search`, { q: purpose, containerTag: tag(identity), searchMode: 'memories', limit: boundedInteger(maxEntries, 40, 1, 100), filters: { AND: [{ key: 'head_sha', value: exactHead(identity) }] } }, headers);
      const text = boundedContext(payload.results || payload.memories, exactHead(identity), maxEntries, maxContextChars);
      return { status: text ? 'available' : 'empty', source: 'rest', protocol: 'supermemory-rest-v4', text, experimental: true, latencyMs: 0 };
    },
    async appendEvents({ identity, events = [] } = {}) {
      const { accepted, rejected } = sanitizeEvents(events);
      if (!accepted.length) return { status: 'accepted', available: true, accepted: 0, rejected: rejected.length, pending: 0, eventIds: [], experimental: true };
      for (const event of accepted) {
        await requestJson(fetchImplementation, runtime, 'POST', `${runtime.baseUrl}/v3/documents`, { content: JSON.stringify(event), customId: event.event_id || event.eventId, containerTag: tag(identity), metadata: { head_sha: exactHead(identity), event_id: event.event_id || event.eventId } }, headers);
      }
      return { status: 'accepted', available: true, accepted: accepted.length, rejected: rejected.length, pending: accepted.length, eventIds: accepted.map((event) => event.event_id || event.eventId), deliverySemantics: 'at_least_once', supportsIdempotency: true, protocol: 'supermemory-rest-v3', experimental: true };
    },
    healthCheck: healthMethod({ fetchImplementation, runtime, url: `${runtime.baseUrl}/health`, headers }),
    readiness: async () => ({ available: false, experimental: true, reason: 'Supermemory adapter requires live ingestion/readiness evidence' }),
  };
}

module.exports = { createSupermemoryMemoryProvider };
