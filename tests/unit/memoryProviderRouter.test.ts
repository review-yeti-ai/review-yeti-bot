import { describe, expect, it, vi } from 'vitest';

const { MemoryProviderRouter } = require('../../src/mcp/memoryProviderRouter.js');

function provider(overrides: Record<string, unknown> = {}) {
  return {
    id: 'test',
    contractVersion: 'memory-provider-v1',
    adapterVersion: 'test-adapter-1',
    capabilities: {
      queryContext: true,
      appendEvents: true,
      transports: ['mcp', 'rest'],
      domains: { recall: ['session_recap'], persist: ['processing'] },
    },
    queryContext: vi.fn(async () => ({ status: 'available', source: 'mcp', protocol: 'mcp-compatible-local', text: 'bounded' })),
    appendEvents: vi.fn(async () => ({ status: 'accepted', available: true, accepted: 1, eventIds: ['e1'] })),
    ...overrides,
  };
}

describe('MemoryProviderRouter', () => {
  it('loads in the plain Node Action runtime and dispatches by capability', async () => {
    const p = provider();
    const router = new MemoryProviderRouter({ providers: [p], defaultProviderId: 'test' });
    const result = await router.queryContext({ identity: { repository: 'acme/app', prNumber: '7', headSha: 'abc' } });
    expect(result).toMatchObject({ status: 'available', provider: 'test', source: 'mcp', text: 'bounded', contractVersion: 'memory-provider-v1', adapterVersion: 'test-adapter-1' });
    expect(p.queryContext).toHaveBeenCalledOnce();
  });

  it('returns structured unavailable output without throwing', async () => {
    const router = new MemoryProviderRouter({ providers: [provider({ queryContext: vi.fn(async () => { throw new Error('offline'); }) })], defaultProviderId: 'test' });
    await expect(router.queryContext({ identity: { repository: 'acme/app', prNumber: 7, headSha: 'abc' } })).resolves.toMatchObject({ status: 'unavailable', reason: 'offline', text: '' });
  });

  it('rejects incomplete exact-head identities before provider dispatch', async () => {
    const p = provider();
    const router = new MemoryProviderRouter({ providers: [p], defaultProviderId: 'test' });
    await expect(router.queryContext({ identity: { repository: 'acme/app', prNumber: 7 } }))
      .resolves.toMatchObject({ status: 'unavailable', reason: 'invalid or incomplete memory identity' });
    expect(p.queryContext).not.toHaveBeenCalled();
  });

  it('keeps provider transport selection out of pipeline fallback logic', async () => {
    const p = provider();
    const router = new MemoryProviderRouter({ providers: [p], defaultProviderId: 'test', transport: 'rest' });
    await router.queryContext({ transport: 'rest', identity: { repository: 'acme/app', prNumber: 7, headSha: 'abc' } });
    expect(p.queryContext).toHaveBeenCalledWith(expect.objectContaining({ transport: 'rest' }));
  });

  it('reports unavailable providers and never dispatches unknown ids', async () => {
    const router = new MemoryProviderRouter({ providers: [provider()] });
    await expect(router.queryContext({ providerId: 'missing' })).resolves.toMatchObject({ status: 'unavailable', provider: 'missing' });
  });

  it('rejects fan-out mode so production has one selected provider', () => {
    expect(() => new MemoryProviderRouter({ mode: 'fanout' as any })).toThrow('memory mode must be single');
  });

  it('reports capability metadata and delivery semantics in receipts', async () => {
    const p = provider({ capabilities: {
      queryContext: true,
      appendEvents: true,
      supportsIdempotency: false,
      deliverySemantics: 'at_least_once',
      transports: ['rest'],
      domains: { recall: ['session_recap'], persist: ['processing'] },
    } });
    const router = new MemoryProviderRouter({ providers: [p], defaultProviderId: 'test', transport: 'rest' });
    await expect(router.appendEvents({ transport: 'rest', identity: { repository: 'acme/app', prNumber: 7, headSha: 'abc' }, persistDomains: ['processing'], events: [{ eventId: 'e1' }] }))
      .resolves.toMatchObject({ contractVersion: 'memory-provider-v1', adapterVersion: 'test-adapter-1', deliverySemantics: 'at_least_once', supportsIdempotency: false });
  });

  it('preserves omitted persist domains in the provider receipt', async () => {
    const p = provider({ appendEvents: vi.fn(async () => ({ status: 'accepted', accepted: 1, eventIds: ['e1'], omittedDomains: ['future_domain'] })) });
    const router = new MemoryProviderRouter({ providers: [p], defaultProviderId: 'test' });
    await expect(router.appendEvents({ identity: { repository: 'acme/app', prNumber: 7, headSha: 'abc' }, persistDomains: ['processing', 'future_domain'], events: [{ eventId: 'e1' }] }))
      .resolves.toMatchObject({ status: 'accepted', omittedDomains: ['future_domain'] });
  });

  it('health-checks only the selected provider instead of fanning out', async () => {
    const first = provider({ id: 'first', healthCheck: vi.fn(async () => ({ available: true })) });
    const second = provider({ id: 'second', healthCheck: vi.fn(async () => ({ available: true })) });
    const router = new MemoryProviderRouter({ providers: [first, second], defaultProviderId: 'first' });
    await expect(router.health()).resolves.toEqual({ first: { available: true } });
    expect(second.healthCheck).not.toHaveBeenCalled();
  });
});
