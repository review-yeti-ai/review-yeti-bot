import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { createMemoryOutbox, identityDigest } = require('../../src/memory/memoryOutbox.js');

describe('memory outbox', () => {
  it('writes atomically to a hashed identity path and validates replay scope', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-yeti-outbox-'));
    const outbox = createMemoryOutbox({ baseDir, now: () => new Date('2026-08-09T00:00:00.000Z') });
    const identity = { repository: 'acme/app', prNumber: 7, headSha: 'ABC123', policyDigest: 'policy' };
    const created = outbox.create({ providerId: 'honcho', identity, persistDomains: ['processing', 'session_recap'], events: [{ eventId: 'event-1', domain: 'processing' }] });
    expect(path.basename(created.filePath)).toMatch(/^[a-f0-9]{64}\.memory-outbox\.json$/u);
    expect(outbox.read(created.filePath)).toMatchObject({ schemaVersion: 'memory-outbox-v1', providerId: 'honcho', identityDigest: identityDigest(identity), persistDomains: ['processing', 'session_recap'] });
  });

  it('rejects path traversal and invalid repository identities', () => {
    const outbox = createMemoryOutbox({ baseDir: os.tmpdir() });
    expect(() => outbox.create({ identity: { repository: '../escape', prNumber: 1, headSha: 'abc' }, events: [] })).toThrow(/invalid repository/);
  });

  it('leases replay work and rejects a concurrent unexpired owner', () => {
    let current = new Date('2026-08-09T00:00:00.000Z');
    const outbox = createMemoryOutbox({ baseDir: fs.mkdtempSync(path.join(os.tmpdir(), 'review-yeti-lease-')), now: () => current });
    const created = outbox.create({ identity: { repository: 'acme/app', prNumber: 7, headSha: 'ABC123' }, events: [] });
    const leased = outbox.acquireLease(created.filePath, { owner: 'worker-a', ttlMs: 60000 });
    expect(leased).toMatchObject({ state: 'replaying', lease: { owner: 'worker-a' } });
    expect(() => outbox.acquireLease(created.filePath, { owner: 'worker-b', ttlMs: 60000 })).toThrow(/lease is held/);
    current = new Date('2026-08-09T00:02:00.000Z');
    expect(outbox.acquireLease(created.filePath, { owner: 'worker-b', ttlMs: 60000 }).lease.owner).toBe('worker-b');
  });
});
