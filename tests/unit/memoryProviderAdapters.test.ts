import { describe, expect, it, vi } from 'vitest';

const { createMem0MemoryProvider } = require('../../src/memory/providers/mem0MemoryProvider.js');
const { createHindsightMemoryProvider } = require('../../src/memory/providers/hindsightMemoryProvider.js');
const { createSupermemoryMemoryProvider } = require('../../src/memory/providers/supermemoryMemoryProvider.js');
const { createRetainDbMemoryProvider } = require('../../src/memory/providers/retaindbMemoryProvider.js');

const identity = { repository: 'acme/app', prNumber: '42', headSha: 'a'.repeat(40) };
const normalizedEvent = {
  schema_version: 'memory-event-v1',
  event_id: 'evt-42',
  domain: 'processing',
  event_type: 'review_completed',
  repository: 'acme/app',
  pr_number: '42',
  head_sha: 'a'.repeat(40),
  occurred_at: '2026-08-09T12:00:00.000Z',
};

function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: vi.fn(async () => JSON.stringify(body)) };
}

function providerOptions(fetchImplementation: typeof fetch) {
  return {
    profile: {
      enabled: true,
      credentialEnv: 'TEST_MEMORY_API_KEY',
      namespaceEnv: 'TEST_MEMORY_NAMESPACE',
      workspaceEnv: 'TEST_MEMORY_WORKSPACE',
    },
    env: {
      TEST_MEMORY_API_KEY: 'test-key',
      TEST_MEMORY_NAMESPACE: 'review-yeti',
      TEST_MEMORY_WORKSPACE: 'review-yeti-project',
    },
    fetchImplementation,
  };
}

describe('native memory provider adapters', () => {
  it('fails open without provider credentials instead of making unauthenticated requests', async () => {
    const fetchImplementation = vi.fn() as unknown as typeof fetch;
    const provider = createMem0MemoryProvider({ profile: { enabled: true }, env: {}, fetchImplementation });
    await expect(provider.queryContext({ identity, purpose: 'prior decisions' })).resolves.toMatchObject({ status: 'unavailable', source: 'rest' });
    await expect(provider.appendEvents({ identity, events: [normalizedEvent] })).resolves.toMatchObject({ status: 'unavailable' });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('uses Mem0 REST with a scoped identity, exact-head metadata filter, and Token auth', async () => {
    const fetchImplementation = vi.fn(async () => response({ results: [
      { memory: JSON.stringify(normalizedEvent), metadata: { head_sha: identity.headSha } },
      { memory: 'must not cross heads', metadata: { head_sha: 'b'.repeat(40) } },
    ] })) as unknown as typeof fetch;
    const provider = createMem0MemoryProvider(providerOptions(fetchImplementation));

    const result = await provider.queryContext({ identity, purpose: 'prior decisions', maxEntries: 3, maxContextChars: 120 });

    expect(result).toMatchObject({ status: 'available', source: 'rest', protocol: 'mem0-rest-v3' });
    expect(result.text).toContain('evt-42');
    expect(result.text).not.toContain('must not cross heads');
    const [url, request] = (fetchImplementation as any).mock.calls[0];
    expect(url).toBe('https://api.mem0.ai/v3/memories/search/');
    expect(request.headers.Authorization).toBe('Token test-key');
    expect(JSON.parse(request.body)).toMatchObject({
      query: 'prior decisions',
      top_k: 3,
      filters: { user_id: 'review-yeti:acme-app:pr-42', 'AND': [{ key: 'head_sha', value: identity.headSha }] },
    });
  });

  it('sends only normalized events to Mem0 and reports asynchronous at-least-once delivery', async () => {
    const fetchImplementation = vi.fn(async () => response({ status: 'PENDING', event_id: 'remote-event' })) as unknown as typeof fetch;
    const provider = createMem0MemoryProvider(providerOptions(fetchImplementation));

    const result = await provider.appendEvents({ identity, events: [normalizedEvent, { event_id: 'raw-untrusted' }] });

    expect(result).toMatchObject({ status: 'accepted', accepted: 1, rejected: 1, pending: 1, eventIds: ['evt-42'], deliverySemantics: 'at_least_once', supportsIdempotency: false });
    const [, request] = (fetchImplementation as any).mock.calls[0];
    const body = JSON.parse(request.body);
    expect(body.messages).toEqual([{ role: 'user', content: JSON.stringify(normalizedEvent) }]);
    expect(body.metadata).toMatchObject({ head_sha: identity.headSha, event_ids: ['evt-42'] });
  });

  it('chunks oversized Mem0 batches and rejects duplicate event IDs explicitly', async () => {
    const fetchImplementation = vi.fn(async () => response({ status: 'PENDING' })) as unknown as typeof fetch;
    const provider = createMem0MemoryProvider(providerOptions(fetchImplementation));
    const events = Array.from({ length: 101 }, (_, index) => ({ ...normalizedEvent, event_id: `evt-${index}` }));
    events.push({ ...normalizedEvent, event_id: 'evt-100' });

    const result = await provider.appendEvents({ identity, events });

    expect(result).toMatchObject({ status: 'accepted', accepted: 101, rejected: 1, chunks: 2, pending: 101 });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse((fetchImplementation as any).mock.calls[0][1].body);
    const secondBody = JSON.parse((fetchImplementation as any).mock.calls[1][1].body);
    expect(firstBody.metadata.event_ids).toHaveLength(100);
    expect(secondBody.metadata.event_ids).toEqual(['evt-100']);
  });

  it('uses the configured Hindsight bank and only returns exact-head normalized events', async () => {
    const fetchImplementation = vi.fn(async () => response({ results: [
      { content: JSON.stringify(normalizedEvent) },
      { content: JSON.stringify({ ...normalizedEvent, event_id: 'old', head_sha: 'c'.repeat(40) }) },
    ] })) as unknown as typeof fetch;
    const provider = createHindsightMemoryProvider({ ...providerOptions(fetchImplementation), profile: { ...providerOptions(fetchImplementation).profile, workspaceEnv: 'TEST_MEMORY_WORKSPACE' } });

    const result = await provider.queryContext({ identity, purpose: 'review history', maxEntries: 2, maxContextChars: 500 });

    expect(result).toMatchObject({ status: 'available', source: 'rest', protocol: 'hindsight-rest-v1' });
    expect(result.text).toContain('evt-42');
    expect(result.text).not.toContain('"old"');
    const [url, request] = (fetchImplementation as any).mock.calls[0];
    expect(url).toBe('https://api.hindsight.vectorize.io/v1/default/banks/review-yeti-project/memories/recall');
    expect(request.headers.Authorization).toBe('Bearer test-key');
    expect(JSON.parse(request.body)).toMatchObject({ query: 'review history', max_results: 2 });
  });

  it('retains Hindsight events in a bounded batch without inventing idempotency', async () => {
    const fetchImplementation = vi.fn(async () => response({ success: true, items_count: 1 })) as unknown as typeof fetch;
    const provider = createHindsightMemoryProvider(providerOptions(fetchImplementation));

    const result = await provider.appendEvents({ identity, events: [normalizedEvent] });

    expect(result).toMatchObject({ status: 'accepted', accepted: 1, deliverySemantics: 'at_least_once', supportsIdempotency: false });
    const [, request] = (fetchImplementation as any).mock.calls[0];
    expect(JSON.parse(request.body)).toMatchObject({ items: [{ content: JSON.stringify(normalizedEvent), timestamp: normalizedEvent.occurred_at }], async: false });
  });

  it('uses Supermemory v4 search and v3 documents with isolated container tags', async () => {
    const fetchImplementation = vi.fn()
      .mockResolvedValueOnce(response({ results: [{ memory: JSON.stringify(normalizedEvent), metadata: { head_sha: identity.headSha } }] }))
      .mockResolvedValueOnce(response({ id: 'doc-42', status: 'queued' })) as unknown as typeof fetch;
    const provider = createSupermemoryMemoryProvider(providerOptions(fetchImplementation));

    const recalled = await provider.queryContext({ identity, purpose: 'prior decisions', maxEntries: 2, maxContextChars: 500 });
    const written = await provider.appendEvents({ identity, events: [normalizedEvent] });

    expect(recalled).toMatchObject({ status: 'available', protocol: 'supermemory-rest-v4', experimental: true });
    expect(written).toMatchObject({ status: 'accepted', accepted: 1, pending: 1, protocol: 'supermemory-rest-v3', experimental: true });
    const [, searchRequest] = (fetchImplementation as any).mock.calls[0];
    expect(JSON.parse(searchRequest.body)).toMatchObject({ containerTag: 'review-yeti:acme-app:pr-42', searchMode: 'memories', filters: { AND: [{ key: 'head_sha', value: identity.headSha }] } });
    const [, writeRequest] = (fetchImplementation as any).mock.calls[1];
    expect(JSON.parse(writeRequest.body)).toMatchObject({ containerTag: 'review-yeti:acme-app:pr-42', customId: 'evt-42', metadata: { head_sha: identity.headSha } });
    await expect(provider.readiness()).resolves.toMatchObject({ available: false, experimental: true });
  });

  it('uses RetainDB project, user, and session scopes and reports async writes as pending', async () => {
    const fetchImplementation = vi.fn()
      .mockResolvedValueOnce(response({ results: [{ memory: { content: JSON.stringify(normalizedEvent) } }] }))
      .mockResolvedValueOnce(response({ success: true, mode: 'async', trace_id: 'trc-1' })) as unknown as typeof fetch;
    const provider = createRetainDbMemoryProvider(providerOptions(fetchImplementation));

    const recalled = await provider.queryContext({ identity, purpose: 'prior decisions', maxEntries: 2, maxContextChars: 500 });
    const written = await provider.appendEvents({ identity, events: [normalizedEvent] });

    expect(recalled).toMatchObject({ status: 'available', protocol: 'retaindb-rest-v1', experimental: true });
    expect(written).toMatchObject({ status: 'accepted', accepted: 1, pending: 1, deliverySemantics: 'at_least_once', experimental: true });
    const [, searchRequest] = (fetchImplementation as any).mock.calls[0];
    expect(JSON.parse(searchRequest.body)).toMatchObject({ project: 'review-yeti-project', user_id: 'review-yeti:acme-app:pr-42', session_id: identity.headSha, include_pending: true, top_k: 2 });
    const [, writeRequest] = (fetchImplementation as any).mock.calls[1];
    expect(JSON.parse(writeRequest.body)).toMatchObject({ project: 'review-yeti-project', user_id: 'review-yeti:acme-app:pr-42', session_id: identity.headSha, content: JSON.stringify(normalizedEvent), write_mode: 'async' });
    await expect(provider.readiness()).resolves.toMatchObject({ available: false, experimental: true });
  });

  it('returns an empty bounded result for malformed JSON and exposes transport failures to the router', async () => {
    const malformedFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: vi.fn(async () => '{not-json'),
    })) as unknown as typeof fetch;
    const malformedProvider = createMem0MemoryProvider(providerOptions(malformedFetch));
    await expect(malformedProvider.queryContext({ identity, purpose: 'malformed' })).resolves.toMatchObject({ status: 'empty', text: '' });

    const timeoutProvider = createMem0MemoryProvider({
      ...providerOptions(vi.fn(async () => { throw new Error('fixture timeout'); }) as unknown as typeof fetch),
    });
    await expect(timeoutProvider.queryContext({ identity, purpose: 'timeout' })).rejects.toThrow('fixture timeout');
  });
});
