'use strict';

const { boundedInteger, scopedIdentity, exactHead, sanitizeEvents, chunkArray, boundedContext, resolveProfile, hydrateProfile, requestJson, healthMethod } = require('./providerCommon.js');

function createMem0MemoryProvider({ profile = {}, env = process.env, fetchImplementation = globalThis.fetch } = {}) {
  const runtime = resolveProfile({ profile, env, defaultBaseUrl: 'https://api.mem0.ai' });
  const headers = { Authorization: `Token ${runtime.apiKey}` };
  return {
    id: 'mem0', contractVersion: 'memory-provider-v1', adapterVersion: 'mem0-rest-v1',
    capabilities: { queryContext: true, appendEvents: true, health: true, readiness: true, supportsIdempotency: false, deliverySemantics: 'at_least_once', scopes: ['repository', 'pull_request'], transports: ['rest'], domains: { recall: ['decision_feedback', 'session_recap', 'code_signals', 'rule_signals'], persist: ['processing', 'decision_feedback', 'session_recap', 'code_signals', 'rule_signals'] } },
    async queryContext({ identity, purpose = 'review-history-v1', maxEntries = 40, maxContextChars = 4000 } = {}) {
      await hydrateProfile(runtime);
      headers.Authorization = `Token ${runtime.apiKey}`;
      if (!runtime.enabled || !runtime.apiKey) return { status: 'unavailable', source: 'rest', protocol: 'mem0-rest-v3', text: '', reason: 'missing Mem0 credential' };
      const payload = await requestJson(fetchImplementation, runtime, 'POST', `${runtime.baseUrl}/v3/memories/search/`, { query: purpose, top_k: boundedInteger(maxEntries, 40, 1, 100), filters: { user_id: scopedIdentity(identity), AND: [{ key: 'head_sha', value: exactHead(identity) }] } }, headers);
      const text = boundedContext(payload.results || payload.memories, exactHead(identity), maxEntries, maxContextChars);
      return { status: text ? 'available' : 'empty', source: 'rest', protocol: 'mem0-rest-v3', text, latencyMs: 0 };
    },
    async appendEvents({ identity, events = [] } = {}) {
      await hydrateProfile(runtime);
      headers.Authorization = `Token ${runtime.apiKey}`;
      if (!runtime.enabled || !runtime.apiKey) return { status: 'unavailable', source: 'rest', protocol: 'mem0-rest-v3', accepted: 0, eventIds: [], reason: 'missing Mem0 credential' };
      const { accepted, rejected } = sanitizeEvents(events);
      if (!accepted.length) return { status: 'accepted', available: true, accepted: 0, rejected: rejected.length, pending: 0, eventIds: [] };
      let pending = 0;
      for (const chunk of chunkArray(accepted, 100)) {
        const payload = await requestJson(fetchImplementation, runtime, 'POST', `${runtime.baseUrl}/v3/memories/`, { messages: chunk.map((event) => ({ role: 'user', content: JSON.stringify(event) })), metadata: { user_id: scopedIdentity(identity), head_sha: exactHead(identity), event_ids: chunk.map((event) => event.event_id || event.eventId) } }, headers);
        if (String(payload.status || '').toLowerCase() === 'pending') pending += chunk.length;
      }
      return { status: 'accepted', available: true, accepted: accepted.length, rejected: rejected.length, pending, chunks: Math.ceil(accepted.length / 100), eventIds: accepted.map((event) => event.event_id || event.eventId), deliverySemantics: 'at_least_once', supportsIdempotency: false };
    },
    healthCheck: healthMethod({ fetchImplementation, runtime, url: `${runtime.baseUrl}/health`, headers }),
    readiness: async () => ({ available: Boolean(runtime.enabled && runtime.apiKey), reason: runtime.apiKey ? undefined : 'missing Mem0 credential' }),
  };
}

module.exports = { createMem0MemoryProvider };
