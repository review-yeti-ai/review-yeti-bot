import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { createMemoryOutbox } = require('../../src/memory/memoryOutbox.js');
const { replayMemoryOutbox } = require('../../src/memory/replayMemoryOutbox.js');

const identity = { repository: 'acme/review-yeti', prNumber: 42, headSha: 'a'.repeat(40), policyDigest: 'policy-1' };

function createFixture() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-yeti-outbox-'));
  const outbox = createMemoryOutbox({ baseDir });
  const created = outbox.create({ providerId: 'mem0', identity, persistDomains: ['processing'], events: [{ eventId: 'evt-1', domain: 'processing' }] });
  return { outbox, filePath: created.filePath };
}

describe('memory outbox replay', () => {
  it('replays an authorized exact-provider outbox and clears the lease', async () => {
    const fixture = createFixture();
    const receipt = await replayMemoryOutbox({
      ...fixture, lease: 'test-worker', providerId: 'mem0', authorize: true,
      appendEvents: async () => ({ status: 'accepted', accepted: 1, eventIds: ['evt-1'] }),
    });
    expect(receipt).toMatchObject({ state: 'accepted', provider: 'mem0', accepted: 1, pending: 0, attempts: 1 });
    expect(fixture.outbox.read(fixture.filePath)).toMatchObject({ state: 'accepted', lease: null, delivery: { accepted: ['evt-1'] } });
  });

  it('retries bounded failures and dead-letters after the configured attempts', async () => {
    const fixture = createFixture();
    const sleeps: number[] = [];
    const receipt = await replayMemoryOutbox({
      ...fixture, lease: 'test-worker', providerId: 'mem0', authorize: true, maxAttempts: 3,
      sleep: async (delay: number) => { sleeps.push(delay); },
      appendEvents: async () => ({ status: 'unavailable', accepted: 0, eventIds: [], reason: 'fixture offline' }),
    });
    expect(receipt).toMatchObject({ state: 'dead_letter', attempts: 3, pending: 1 });
    expect(sleeps).toEqual([250, 500]);
  });

  it('rejects a provider retarget before acquiring a lease', async () => {
    const fixture = createFixture();
    await expect(replayMemoryOutbox({ ...fixture, lease: 'test-worker', providerId: 'hindsight', authorize: true, appendEvents: async () => ({ status: 'accepted' }) })).rejects.toThrow('does not match');
  });
});
