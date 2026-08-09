import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { createCassetteFetch } from '../support/cassetteFetch';

const { createMem0MemoryProvider } = require('../../src/memory/providers/mem0MemoryProvider.js');
const { createHindsightMemoryProvider } = require('../../src/memory/providers/hindsightMemoryProvider.js');
const { createSupermemoryMemoryProvider } = require('../../src/memory/providers/supermemoryMemoryProvider.js');
const { createRetainDbMemoryProvider } = require('../../src/memory/providers/retaindbMemoryProvider.js');

const root = path.resolve(__dirname, '../..');
const headSha = 'a'.repeat(40);
const identity = { repository: 'acme/app', prNumber: 42, headSha };
const event = {
  schema_version: 'memory-event-v1',
  event_id: 'evt-42',
  domain: 'feedback',
  event_type: 'finding_resolved',
  repository: 'acme/app',
  pr_number: '42',
  head_sha: headSha,
  occurred_at: '2026-08-09T12:00:00.000Z',
};

const cases = [
  ['mem0', createMem0MemoryProvider, 'mem0.fixture.test'],
  ['hindsight', createHindsightMemoryProvider, 'hindsight.fixture.test'],
  ['supermemory', createSupermemoryMemoryProvider, 'supermemory.fixture.test'],
  ['retaindb', createRetainDbMemoryProvider, 'retaindb.fixture.test'],
] as const;

describe('native provider cassette replay', () => {
  it.each(cases)('%s consumes query, append, and health interactions', async (providerId, factory, host) => {
    const cassette = createCassetteFetch({
      cassettePath: path.join(root, 'tests/fixtures/cassettes/memory', `${providerId}.json`),
    });
    const provider = factory({
      profile: { enabled: true, baseUrl: `https://${host}`, credentialEnv: 'TEST_MEMORY_API_KEY', workspaceEnv: 'TEST_MEMORY_WORKSPACE' },
      env: { TEST_MEMORY_API_KEY: 'fixture-key', TEST_MEMORY_WORKSPACE: 'review-yeti-project' },
      fetchImplementation: cassette.fetchImplementation,
    });

    const recalled = await provider.queryContext({ identity, purpose: 'prior decisions', maxEntries: 2, maxContextChars: 1000 });
    const written = await provider.appendEvents({ identity, events: [event] });
    const health = await provider.healthCheck();
    cassette.assertComplete();

    expect(recalled).toMatchObject({ status: 'available', source: 'rest' });
    expect(recalled.text).toContain('evt-42');
    expect(written).toMatchObject({ status: 'accepted', accepted: 1, eventIds: ['evt-42'] });
    expect(health).toMatchObject({ configured: true, available: true });
    expect(provider.capabilities.domains.recall).toContain('decision_feedback');
    expect(provider.capabilities.domains.persist).toContain('processing');
  });
});
