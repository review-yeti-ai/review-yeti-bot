import { describe, expect, it, vi } from 'vitest';

const { createHonchoMemoryMcpAdapter } = require('../../src/mcp/honchoMemoryMcpAdapter.js');

describe('Honcho MCP-compatible provider', () => {
  it('exposes bounded context and reports protocol/source', async () => {
    const provider = createHonchoMemoryMcpAdapter({
      honchoProvider: {
        resolveContext: vi.fn(async () => ({ available: true, text: 'context' })),
        appendEvents: vi.fn(async () => ({ available: true, accepted: 1 })),
        healthCheck: vi.fn(async () => ({ configured: true, available: true })),
      },
    });
    const result = await provider.queryContext({ identity: { repository: 'acme/app', prNumber: 7, headSha: 'abc' } });
    expect(result).toMatchObject({ status: 'available', source: 'mcp', protocol: 'mcp-compatible-local', text: 'context' });
    expect(provider.capabilities.domains.recall).toContain('session_recap');
  });

  it('reports unsupported recall domains instead of claiming full memory', async () => {
    const provider = createHonchoMemoryMcpAdapter({
      honchoProvider: {
        resolveContext: vi.fn(async () => ({ available: false, text: '', reason: 'empty' })),
        appendEvents: vi.fn(async () => ({ available: true, accepted: 0 })),
      },
    });
    const result = await provider.queryContext({
      identity: { repository: 'acme/app', prNumber: 7, headSha: 'abc' },
      recallDomains: ['session_recap', 'future_domain'],
    });
    expect(result.omittedDomains).toEqual(['future_domain']);
  });

  it('does not expose append semantics through the read result', async () => {
    const provider = createHonchoMemoryMcpAdapter({
      honchoProvider: {
        resolveContext: vi.fn(async () => ({ available: true, text: 'context' })),
        appendEvents: vi.fn(async () => ({ available: true, accepted: 1 })),
      },
    });
    const result = await provider.queryContext({ identity: { repository: 'acme/app', prNumber: 7, headSha: 'abc' } });
    expect(result).not.toHaveProperty('events');
  });

  it('filters writes to the trusted persist matrix and registers health internally', async () => {
    const appendEvents = vi.fn(async () => ({ available: true, accepted: 1, eventIds: ['processing-1'] }));
    const healthCheck = vi.fn(async () => ({ configured: true, available: true }));
    const provider = createHonchoMemoryMcpAdapter({
      persistDomains: ['processing'],
      honchoProvider: { appendEvents, healthCheck },
    });
    const result = await provider.appendEvents({
      identity: { repository: 'acme/app', prNumber: 7, headSha: 'abc' },
      persistDomains: ['processing'],
      events: [
        { eventType: 'review_completed', domain: 'processing', eventId: 'processing-1' },
        { eventType: 'finding_observed', domain: 'code', eventId: 'code-1' },
      ],
    });
    expect(result).toMatchObject({ status: 'accepted', accepted: 1, skippedEvents: 1 });
    expect(appendEvents).toHaveBeenCalledWith(expect.objectContaining({ events: [{ eventType: 'review_completed', domain: 'processing', eventId: 'processing-1' }] }));
    expect((await provider.listInternalTools()).tools.map((tool: any) => tool.name)).toEqual([
      'honcho_memory_query', 'honcho_memory_append_events', 'honcho_memory_health',
    ]);
    expect(provider).not.toHaveProperty('listTools');
    await expect(provider.healthCheck()).resolves.toMatchObject({ available: true });
  });
});
