import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { createCassetteFetch } from '../support/cassetteFetch';

const { createMem0MemoryProvider } = require('../../src/memory/providers/mem0MemoryProvider.js');

describe('provider failure cassette contract', () => {
  it('turns 503 and 429 responses into explicit unavailable receipts', async () => {
    const cassette = createCassetteFetch({
      cassettePath: path.resolve(__dirname, '../fixtures/cassettes/memory/provider-errors.json'),
      requireVersion: 2,
    });
    const provider = createMem0MemoryProvider({
      profile: { enabled: true, baseUrl: 'https://mem0.fixture.test', credentialEnv: 'TEST_MEMORY_API_KEY' },
      env: { TEST_MEMORY_API_KEY: 'fixture-key' },
      fetchImplementation: cassette.fetchImplementation,
    });
    const identity = { repository: 'acme/app', prNumber: 42, headSha: 'a'.repeat(40) };

    await expect(provider.queryContext({ identity, purpose: 'provider failure', maxEntries: 1 })).rejects.toThrow('memory provider HTTP 503');
    await expect(provider.healthCheck()).resolves.toMatchObject({ configured: true, available: false });
    await expect(provider.queryContext({ identity, purpose: 'malformed' })).resolves.toMatchObject({ status: 'empty', text: '' });
    cassette.assertComplete();
  });
});
