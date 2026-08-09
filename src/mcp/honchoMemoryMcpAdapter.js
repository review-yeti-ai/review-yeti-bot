'use strict';

const { createLocalMcpDispatcher } = require('./memoryMcpJsonRpc.js');

function createHonchoMemoryMcpAdapter({ honchoProvider, transport = 'mcp', protocol = 'mcp-compatible-local', recallDomains = [], persistDomains = null } = {}) {
  if (!honchoProvider) throw new Error('Honcho MCP adapter requires honchoProvider');
  const supportedRecall = new Set(['decision_feedback', 'session_recap', 'code_signals', 'rule_signals']);
  const supportedPersist = new Set(['processing', 'decision_feedback', 'session_recap', 'code_signals', 'rule_signals']);
  const omitted = (requested, supported) => (Array.isArray(requested) ? requested : []).filter((value) => !supported.has(value));
  const eventClass = (event = {}) => {
    const type = String(event.eventType || event.event_type || '').toLowerCase();
    if (type === 'session_recap') return 'session_recap';
    if (['finding_ignored', 'finding_resolved', 'finding_unignored', 'finding_reopened', 'finding_obsolete', 'feedback_recorded', 'maintainer_command'].includes(type)) return 'decision_feedback';
    const domain = String(event.domain || '').toLowerCase();
    if (domain === 'code') return 'code_signals';
    if (domain === 'rule') return 'rule_signals';
    return 'processing';
  };
  const rawQuery = async ({ identity, purpose = 'review-history-v1', maxContextChars, deadlineMs, recallDomains: requestedDomains } = {}) => {
    const startedAt = Date.now();
    const domains = requestedDomains || recallDomains;
    const omittedDomains = omitted(domains, supportedRecall);
    const result = await honchoProvider.resolveContext({
      repo: identity?.repository,
      prNumber: identity?.prNumber,
      headSha: identity?.headSha,
      query: purpose,
      maxContextChars,
      timeoutMs: deadlineMs,
    });
    return {
      status: result.available ? 'available' : (result.reason === 'Honcho returned no representation' ? 'empty' : 'unavailable'),
      source: transport,
      protocol,
      text: result.text || '',
      omittedDomains,
      latencyMs: Date.now() - startedAt,
      reason: result.reason,
    };
  };
  const rawAppend = async ({ identity, events = [], persistDomains: requestedDomains, deliveryKey } = {}) => {
    const startedAt = Date.now();
    const domains = Array.isArray(requestedDomains) ? requestedDomains : (Array.isArray(persistDomains) ? persistDomains : [...supportedPersist]);
    const omittedDomains = omitted(domains, supportedPersist);
    const allowed = new Set(domains.filter((domain) => supportedPersist.has(domain)));
    const selectedEvents = (Array.isArray(events) ? events : []).filter((event) => allowed.has(eventClass(event)));
    const skippedEvents = Math.max(0, (Array.isArray(events) ? events.length : 0) - selectedEvents.length);
    if (selectedEvents.length === 0) {
      return {
        status: 'accepted',
        available: true,
        accepted: 0,
        eventIds: [],
        skippedEvents,
        source: transport,
        protocol,
        omittedDomains,
        latencyMs: Date.now() - startedAt,
      };
    }
    const result = await honchoProvider.appendEvents({ repo: identity?.repository, prNumber: identity?.prNumber, headSha: identity?.headSha, events: selectedEvents, deliveryKey });
    return { ...result, status: result.available ? 'accepted' : 'unavailable', source: transport, protocol, omittedDomains, skippedEvents, latencyMs: Date.now() - startedAt };
  };
  const dispatcher = createLocalMcpDispatcher({
    honcho_memory_query: { inputSchema: { identity: 'object', purpose: 'string', maxContextChars: 'number' }, execute: rawQuery },
    honcho_memory_append_events: { inputSchema: { identity: 'object', events: 'array' }, execute: rawAppend },
    honcho_memory_health: { inputSchema: {}, execute: async () => honchoProvider.healthCheck?.() || { available: false, reason: 'health unsupported' } },
  });
  return {
    id: 'honcho',
    contractVersion: 'memory-provider-v1',
    capabilities: {
      queryContext: true,
      appendEvents: true,
      ingestFacts: false,
      health: true,
      readiness: true,
      supportsIdempotency: false,
      deliverySemantics: 'at_least_once',
      scopes: ['repository', 'pull_request'],
      transports: ['mcp', 'rest'],
      domains: { recall: [...supportedRecall], persist: [...supportedPersist] },
    },
    queryContext: (request) => dispatcher.callTool('honcho_memory_query', request),
    appendEvents: (request) => dispatcher.callTool('honcho_memory_append_events', request),
    healthCheck: () => honchoProvider.healthCheck(),
    readiness: async () => ({ available: false, reason: 'Honcho representation readiness is provider-specific' }),
    // Control-plane discovery is intentionally separate from persona/model tool discovery.
    listInternalTools: () => dispatcher.listTools(),
  };
}

module.exports = { createHonchoMemoryMcpAdapter };
