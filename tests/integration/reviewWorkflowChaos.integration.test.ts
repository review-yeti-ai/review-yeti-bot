import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { createMemoryOutbox } = require('../../src/memory/memoryOutbox.js');
const { createMemoryProviderRouter } = require('../../src/mcp/memoryProviderRouter.js');

const identity = { repository: 'acme/review-yeti', prNumber: 42, headSha: 'a'.repeat(40), policyDigest: 'policy-1' };

describe('review workflow chaos and concurrency contracts', () => {
  it('allows only one replay worker to own a same-head outbox lease', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-yeti-chaos-'));
    const outbox = createMemoryOutbox({ baseDir, now: () => new Date('2026-08-09T00:00:00.000Z') });
    const filePath = outbox.create({ identity, providerId: 'mem0', events: [{ eventId: 'evt-1' }] }).filePath;
    outbox.acquireLease(filePath, { owner: 'worker-a' });
    expect(() => outbox.acquireLease(filePath, { owner: 'worker-b' })).toThrow('lease is held');
  });

  it('keeps one provider selection and reports duplicate event rejection explicitly', async () => {
    const calls: unknown[] = [];
    const router = createMemoryProviderRouter({
      providers: [{
        id: 'mem0',
        contractVersion: 'memory-provider-v1',
        adapterVersion: 'fixture-v1',
        capabilities: { queryContext: true, appendEvents: true, transports: ['rest'], domains: { recall: ['decision_feedback'], persist: ['processing'] } },
        queryContext: async () => ({ status: 'empty', source: 'rest', text: '' }),
        appendEvents: async ({ events }: { events: unknown[] }) => { calls.push(events); return { status: 'accepted', accepted: 1, rejected: 1, eventIds: ['evt-1'] }; },
      }],
      defaultProviderId: 'mem0',
      transport: 'rest',
      mode: 'single',
      now: () => 1_754_752_800_000,
    });
    const result = await router.appendEvents({ identity, events: [{ eventId: 'evt-1' }, { eventId: 'evt-1' }], persistDomains: ['processing'] });
    expect(result.provider).toBe('mem0');
    expect(result.accepted).toBe(1);
    expect(calls).toHaveLength(1);
  });
});
