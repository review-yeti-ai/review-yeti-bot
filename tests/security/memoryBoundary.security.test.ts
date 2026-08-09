import { describe, expect, it } from 'vitest';

const { createMemoryProvider } = require('../../src/memory/providers/index.js');
const { MemoryProviderRouter } = require('../../src/mcp/memoryProviderRouter.js');
const { identityDigest } = require('../../src/memory/memoryOutbox.js');

describe('memory boundary security contract', () => {
  it('rejects arbitrary provider IDs and fan-out mode', () => {
    expect(() => createMemoryProvider({ id: 'attacker-controlled' })).toThrow('unknown native memory provider');
    expect(() => new MemoryProviderRouter({ mode: 'fanout' })).toThrow('memory mode must be single');
  });

  it('requires a path-safe repository identity before producing an outbox digest', () => {
    expect(() => identityDigest({ repository: '../escape', prNumber: 42, headSha: 'a'.repeat(40) })).toThrow('invalid repository identity');
    expect(identityDigest({ repository: 'acme/review-yeti', prNumber: 42, headSha: 'a'.repeat(40) })).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('fails closed without credentials instead of making unauthenticated provider calls', async () => {
    const fetchImplementation = async () => { throw new Error('network must not be called'); };
    const provider = createMemoryProvider({ id: 'mem0', profile: { enabled: true }, env: {}, fetchImplementation });
    await expect(provider.queryContext({ identity: { repository: 'acme/review-yeti', prNumber: 42, headSha: 'a'.repeat(40) } })).resolves.toMatchObject({ status: 'unavailable' });
  });
});
