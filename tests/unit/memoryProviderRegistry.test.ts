import { describe, expect, it } from 'vitest';

const { createMemoryProvider, listMemoryProviderIds } = require('../../src/memory/providers/index.js');

describe('memory provider registry', () => {
  it('registers the four native providers behind the common contract', () => {
    expect(listMemoryProviderIds()).toEqual(['mem0', 'hindsight', 'supermemory', 'retaindb']);
    for (const id of listMemoryProviderIds()) {
      const provider = createMemoryProvider({ id, profile: { enabled: false } });
      expect(provider).toMatchObject({ id, contractVersion: 'memory-provider-v1' });
      expect(provider.capabilities).toMatchObject({ queryContext: true, appendEvents: true, transports: ['rest'] });
    }
  });

  it('rejects unregistered provider ids instead of accepting arbitrary runtime targets', () => {
    expect(() => createMemoryProvider({ id: 'arbitrary-server' })).toThrow('unknown native memory provider');
  });
});
