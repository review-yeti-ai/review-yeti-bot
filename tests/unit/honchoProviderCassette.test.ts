import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { createCassetteFetch } from '../support/cassetteFetch';

const { createHonchoMemoryProvider } = require('../../src/memory/honchoMemory.js');

describe('Honcho provider cassette replay', () => {
  it('replays exact-head context, normalized append, and health without network access', async () => {
    const cassette = createCassetteFetch({
      cassettePath: path.resolve(__dirname, '../fixtures/cassettes/memory/honcho.json'),
      requireVersion: 2,
    });
    const provider = createHonchoMemoryProvider({
      config: { baseUrl: 'https://honcho.fixture.test', apiKey: 'fixture-key', workspaceId: 'review-yeti' },
      fetchImplementation: cassette.fetchImplementation,
      now: () => new Date('2026-08-09T12:00:00.000Z'),
    });
    const identity = { repo: 'acme/app', prNumber: 42, headSha: 'a'.repeat(40) };

    const context = await provider.resolveContext({ ...identity, query: 'prior decisions' });
    const write = await provider.appendEvents({
      ...identity,
      events: [{ eventType: 'finding_resolved', eventId: 'evt-42', domain: 'feedback', claimId: 'claim-42', severity: 'P1', state: 'resolved', occurredAt: '2026-08-09T12:00:00.000Z' }],
    });
    const health = await provider.healthCheck();

    expect(context).toMatchObject({ available: true, text: 'prior review context for exact head' });
    expect(write).toMatchObject({ available: true, accepted: 1, chunks: 1, eventIds: ['evt-42'] });
    expect(health).toMatchObject({ configured: true, available: true, status: 200 });
    cassette.assertComplete();
  });
});
