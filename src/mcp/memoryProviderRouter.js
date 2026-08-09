'use strict';

/**
 * Runtime-safe memory provider router used by the composite Action.
 * Providers expose one contract; the review pipeline never knows whether the selected
 * provider uses MCP JSON-RPC, a local MCP-compatible adapter, or an explicitly selected REST mode.
 */
class MemoryProviderRouter {
  constructor({ providers = [], defaultProviderId = 'honcho', transport = 'mcp' } = {}) {
    this.providers = new Map();
    this.defaultProviderId = defaultProviderId;
    this.transport = transport;
    for (const provider of providers) this.register(provider);
  }

  register(provider) {
    if (!provider || typeof provider.id !== 'string' || !provider.id.trim()) {
      throw new Error('Memory provider requires a stable id');
    }
    if (typeof provider.queryContext !== 'function' || typeof provider.appendEvents !== 'function') {
      throw new Error(`Memory provider ${provider.id} must implement queryContext and appendEvents`);
    }
    this.providers.set(provider.id, provider);
    return provider;
  }

  get(id = this.defaultProviderId) {
    return this.providers.get(id);
  }

  list() {
    return [...this.providers.values()].map((provider) => ({
      id: provider.id,
      contractVersion: provider.contractVersion,
      capabilities: provider.capabilities,
    }));
  }

  normalizeIdentity(identity) {
    const repository = String(identity?.repository || '').trim().toLowerCase();
    const prNumberText = String(identity?.prNumber ?? '').trim();
    const prNumber = /^\d+$/u.test(prNumberText)
      ? String(Number(prNumberText))
      : prNumberText;
    const headSha = String(identity?.headSha || '').trim().toLowerCase();
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository) || repository.includes('..')) return null;
    if (!headSha || headSha.includes('..') || /[^A-Za-z0-9_-]/u.test(headSha)) return null;
    if (!prNumber || prNumber === 'unknown') return null;
    return { ...identity, repository, prNumber, headSha };
  }

  domainSelection(provider, request, kind) {
    const requestedKey = kind === 'recall' ? 'recallDomains' : 'persistDomains';
    const requested = request && Array.isArray(request[requestedKey])
      ? [...new Set(request[requestedKey].map((value) => String(value).trim()).filter(Boolean))]
      : null;
    if (requested === null) return { requested: null, selected: undefined, omitted: [] };
    const supported = new Set(provider.capabilities?.domains?.[kind] || []);
    return {
      requested,
      selected: requested.filter((domain) => supported.has(domain)),
      omitted: requested.filter((domain) => !supported.has(domain)),
    };
  }

  async queryContext(request = {}) {
    const startedAt = Date.now();
    const provider = this.get(request.providerId);
    if (!provider) {
      return {
        status: 'unavailable',
        source: 'none',
        provider: request.providerId || this.defaultProviderId,
        text: '',
        latencyMs: Date.now() - startedAt,
        reason: 'memory provider unavailable',
      };
    }
    const identity = this.normalizeIdentity(request.identity);
    if (!identity) {
      return {
        status: 'unavailable',
        source: 'none',
        provider: provider.id,
        text: '',
        latencyMs: Date.now() - startedAt,
        reason: 'invalid or incomplete memory identity',
      };
    }
    const requestedTransport = request.transport || this.transport;
    const transport = requestedTransport === 'auto'
      ? (provider.capabilities?.transports?.includes('mcp') ? 'mcp' : 'rest')
      : requestedTransport;
    if (transport === 'auto') {
      // Auto is an explicit diagnostic mode. The pipeline still makes one logical query;
      // only the provider/router owns any transport retry semantics.
      request = { ...request, transport: provider.capabilities?.transports?.includes('mcp') ? 'mcp' : 'rest' };
    } else {
      request = { ...request, transport };
    }
    if (Array.isArray(provider.capabilities?.transports)
      && !provider.capabilities.transports.includes(request.transport)) {
      return {
        status: 'unavailable',
        source: request.transport,
        provider: provider.id,
        text: '',
        latencyMs: Date.now() - startedAt,
        reason: `provider does not support ${request.transport} transport`,
      };
    }
    if (!provider.capabilities?.queryContext) {
      return {
        status: 'unavailable',
        source: request.transport || 'none',
        provider: provider.id,
        text: '',
        latencyMs: Date.now() - startedAt,
        reason: 'provider does not support queryContext',
      };
    }
    const domains = this.domainSelection(provider, request, 'recall');
    if (domains.requested && domains.selected.length === 0) {
      return {
        status: 'empty',
        source: request.transport || 'none',
        provider: provider.id,
        text: '',
        latencyMs: Date.now() - startedAt,
        omittedDomains: domains.omitted,
        reason: 'requested memory recall domains are unsupported',
      };
    }
    try {
      const result = await provider.queryContext({ ...request, identity, ...(domains.requested ? { recallDomains: domains.selected } : {}) });
      return {
        status: result?.status || (result?.available ? 'available' : 'empty'),
        source: result?.source || request.transport || 'none',
        provider: provider.id,
        text: typeof result?.text === 'string' ? result.text : '',
        latencyMs: Number.isFinite(result?.latencyMs) ? result.latencyMs : Date.now() - startedAt,
        omittedDomains: [...new Set([...(result?.omittedDomains || []), ...domains.omitted])],
        protocol: result?.protocol,
        reason: result?.reason,
      };
    } catch (error) {
      return {
        status: 'unavailable',
        source: request.transport || 'none',
        provider: provider.id,
        text: '',
        latencyMs: Date.now() - startedAt,
        reason: error?.message || 'memory provider query failed',
      };
    }
  }

  async appendEvents(request = {}) {
    const startedAt = Date.now();
    const provider = this.get(request.providerId);
    if (!provider) {
      return { status: 'unavailable', provider: request.providerId || this.defaultProviderId, accepted: 0, latencyMs: Date.now() - startedAt, reason: 'memory provider unavailable' };
    }
    const identity = this.normalizeIdentity(request.identity);
    if (!identity) {
      return { status: 'unavailable', provider: request.providerId || this.defaultProviderId, accepted: 0, latencyMs: Date.now() - startedAt, reason: 'invalid or incomplete memory identity' };
    }
    if (!provider.capabilities?.appendEvents) {
      return { status: 'unavailable', provider: provider.id, accepted: 0, latencyMs: Date.now() - startedAt, reason: 'provider does not support appendEvents' };
    }
    const requestedTransport = request.transport || this.transport;
    const transport = requestedTransport === 'auto'
      ? (provider.capabilities?.transports?.includes('mcp') ? 'mcp' : 'rest')
      : requestedTransport;
    if (Array.isArray(provider.capabilities?.transports) && !provider.capabilities.transports.includes(transport)) {
      return { status: 'unavailable', provider: provider.id, accepted: 0, latencyMs: Date.now() - startedAt, reason: `provider does not support ${transport} transport` };
    }
    const domains = this.domainSelection(provider, request, 'persist');
    if (domains.requested && domains.selected.length === 0) {
      return {
        status: 'accepted',
        provider: provider.id,
        accepted: 0,
        rejected: 0,
        pending: 0,
        latencyMs: Date.now() - startedAt,
        eventIds: [],
        omittedDomains: domains.omitted,
        deliverySemantics: provider.capabilities?.deliverySemantics || 'at_least_once',
        supportsIdempotency: Boolean(provider.capabilities?.supportsIdempotency),
        reason: 'requested memory persist domains are unsupported',
      };
    }
    try {
      const result = await provider.appendEvents({
        ...request,
        identity,
        transport,
        ...(domains.requested ? { persistDomains: domains.selected } : {}),
      });
      return {
        status: result?.status || (result?.available ? 'accepted' : 'unavailable'),
        provider: provider.id,
        accepted: Number(result?.accepted || 0),
        rejected: Number(result?.rejected || 0),
        pending: Number(result?.pending || 0),
        latencyMs: Number.isFinite(result?.latencyMs) ? result.latencyMs : Date.now() - startedAt,
        eventIds: Array.isArray(result?.eventIds) ? result.eventIds : [],
        omittedDomains: [...new Set([...(result?.omittedDomains || []), ...domains.omitted])],
        deliverySemantics: provider.capabilities?.deliverySemantics || 'at_least_once',
        supportsIdempotency: Boolean(provider.capabilities?.supportsIdempotency),
        protocol: result?.protocol,
        reason: result?.reason,
      };
    } catch (error) {
      return {
        status: 'unavailable',
        provider: provider.id,
        accepted: 0,
        latencyMs: Date.now() - startedAt,
        deliverySemantics: provider.capabilities?.deliverySemantics || 'at_least_once',
        supportsIdempotency: Boolean(provider.capabilities?.supportsIdempotency),
        reason: error?.message || 'memory provider append failed',
      };
    }
  }

  async health() {
    const result = {};
    for (const provider of this.providers.values()) {
      try {
        result[provider.id] = typeof provider.healthCheck === 'function'
          ? await provider.healthCheck()
          : { available: false, reason: 'healthCheck unsupported' };
      } catch (error) {
        result[provider.id] = { available: false, reason: error?.message || 'health check failed' };
      }
    }
    return result;
  }
}

function createMemoryProviderRouter(options = {}) {
  return new MemoryProviderRouter(options);
}

module.exports = { MemoryProviderRouter, createMemoryProviderRouter };
