import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {
  artifactNameForReviewAttempt,
  createDurableReviewResumeStore,
  replayDurableReviewPublication,
} = require('../../src/review/durableReviewResume.js');

const identity = { repository: 'acme/widgets', prNumber: '17', headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), policyDigest: 'policy-v1' };
const chunks = [{ kind: 'review', body: 'exact-head review' }, { kind: 'comment', body: 'finding comment' }];

function fixture(overrides: Record<string, unknown> = {}) {
  let current = new Date('2026-08-09T12:00:00.000Z');
  const store = createDurableReviewResumeStore({ baseDir: fs.mkdtempSync(path.join(os.tmpdir(), 'review-yeti-resume-')), now: () => current });
  const created = store.create({ identity, attempt: 3, planDigest: 'plan-abc', chunks });
  const published = new Set<string>();
  const ledger = { getPublishedChunkIds: vi.fn(async () => [...published]) };
  const publishChunk = vi.fn(async ({ chunk }: any) => { published.add(chunk.id); return { publicationId: `pub-${chunk.id}` }; });
  return {
    store, created, ledger, publishChunk, published,
    advance(ms: number) { current = new Date(current.getTime() + ms); },
    options: { store, filePath: created.filePath, expectedIdentity: identity, owner: 'runner-a', authorizeReplay: async () => true, ledger, publishChunk, sleep: vi.fn(async () => undefined), ...overrides },
  };
}

describe('durable review publication resume', () => {
  it('uses a hashed identity-and-attempt artifact name and verifies exact identity on read', () => {
    const { store, created } = fixture();
    expect(created.manifest.artifactName).toBe(artifactNameForReviewAttempt(identity, 3));
    expect(created.manifest.artifactName).toMatch(/^review-yeti-resume-[a-f0-9]{32}$/u);
    expect(store.read(created.filePath, identity)).toMatchObject({ identityDigest: created.manifest.identityDigest, manifestDigest: created.manifest.manifestDigest });
    expect(() => store.read(created.filePath, { ...identity, headSha: 'c'.repeat(40) })).toThrow('resume identity digest mismatch');
  });

  it('does not publish when cancellation arrives before publication', async () => {
    const { options, publishChunk, store, created } = fixture();
    const controller = new AbortController();
    controller.abort();

    await expect(replayDurableReviewPublication({ ...options, signal: controller.signal })).resolves.toMatchObject({ status: 'cancelled', published: 0 });
    expect(publishChunk).not.toHaveBeenCalled();
    expect(store.read(created.filePath, identity).delivery.chunks.every((chunk: any) => chunk.status === 'pending')).toBe(true);
  });

  it('checks the GitHub ledger after cancellation following a publication and never duplicates that chunk', async () => {
    const { options, publishChunk, ledger, published, store, created } = fixture();
    const controller = new AbortController();
    publishChunk.mockImplementationOnce(async ({ chunk }: any) => { published.add(chunk.id); controller.abort(); return { publicationId: 'pub-one' }; });

    await expect(replayDurableReviewPublication({ ...options, signal: controller.signal, batchSize: 1 })).resolves.toMatchObject({ status: 'cancelled', published: 1 });
    await expect(replayDurableReviewPublication({ ...options, owner: 'runner-b', batchSize: 1 })).resolves.toMatchObject({ status: 'accepted', published: 1 });
    expect(publishChunk).toHaveBeenCalledTimes(2);
    expect(ledger.getPublishedChunkIds).toHaveBeenCalled();
    expect(store.read(created.filePath, identity).delivery.chunks.map((chunk: any) => chunk.status)).toEqual(['published', 'published']);
  });

  it('rejects a tampered artifact manifest before requesting a ledger or publisher', async () => {
    const { options, created, ledger, publishChunk } = fixture();
    const payload = JSON.parse(fs.readFileSync(created.filePath, 'utf8'));
    payload.manifest.chunks[0].payload.body = 'tampered';
    fs.writeFileSync(created.filePath, JSON.stringify(payload));

    await expect(replayDurableReviewPublication(options)).rejects.toThrow('resume manifest digest mismatch');
    expect(ledger.getPublishedChunkIds).not.toHaveBeenCalled();
    expect(publishChunk).not.toHaveBeenCalled();
  });

  it('rejects missing, duplicate, or extraneous delivery chunks before replay', () => {
    const { store, created } = fixture();
    const payload = JSON.parse(fs.readFileSync(created.filePath, 'utf8'));
    payload.delivery.chunks.pop();
    fs.writeFileSync(created.filePath, JSON.stringify(payload));
    expect(() => store.read(created.filePath, identity)).toThrow('invalid resume delivery chunks');

    const replacement = fixture();
    const duplicate = JSON.parse(fs.readFileSync(replacement.created.filePath, 'utf8'));
    duplicate.delivery.chunks.push({ ...duplicate.delivery.chunks[0] });
    fs.writeFileSync(replacement.created.filePath, JSON.stringify(duplicate));
    expect(() => replacement.store.read(replacement.created.filePath, identity)).toThrow('invalid resume delivery chunks');
  });

  it('fences an expired lease so an old owner cannot persist after lease loss', () => {
    const { store, created, advance } = fixture();
    const first = store.acquireLease(created.filePath, { owner: 'runner-a', ttlMs: 1000 });
    advance(2000);
    const second = store.acquireLease(created.filePath, { owner: 'runner-b', ttlMs: 1000 });

    expect(second.fence).toBe(first.fence + 1);
    expect(() => store.update(created.filePath, first, () => ({ state: 'accepted' }))).toThrow('resume lease lost');
  });

  it('serializes competing lease acquisition so only one worker can claim a generation', () => {
    const { store, created, advance } = fixture();
    store.acquireLease(created.filePath, { owner: 'expired-owner', ttlMs: 1000 });
    advance(2000);

    const attempts = ['runner-a', 'runner-b'].map((owner) => {
      try { return { owner, lease: store.acquireLease(created.filePath, { owner, ttlMs: 1000 }) }; } catch (error) { return { owner, error }; }
    });
    const acquired = attempts.filter((attempt) => 'lease' in attempt);
    const rejected = attempts.filter((attempt) => 'error' in attempt);

    expect(acquired).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String((rejected[0] as any).error)).toContain('resume lease is held');
    expect(store.read(created.filePath, identity).generation).toBe((acquired[0] as any).lease.generation);
  });

  it('tracks bounded batches, retries retryable failures with backoff, and dead-letters exhausted chunks', async () => {
    const { options, publishChunk, published, store, created } = fixture();
    publishChunk
      .mockRejectedValueOnce(new Error('temporary provider failure'))
      .mockImplementationOnce(async ({ chunk }: any) => { published.add(chunk.id); return { publicationId: 'first' }; })
      .mockRejectedValueOnce(new Error('permanent provider failure'));

    const result = await replayDurableReviewPublication({ ...options, batchSize: 2, maxAttempts: 2 });

    expect(result).toMatchObject({ status: 'dead_letter', published: 1, deadLettered: 1 });
    expect(options.sleep).toHaveBeenCalledWith(250);
    expect(store.read(created.filePath, identity).delivery.chunks.map((chunk: any) => ({ status: chunk.status, attempts: chunk.attempts }))).toEqual([
      { status: 'published', attempts: 2 }, { status: 'dead_letter', attempts: 1 },
    ]);
  });

  it('uses the GitHub ledger as authority and skips a chunk already published on the exact identity', async () => {
    const { options, created, published, publishChunk, store } = fixture();
    published.add(created.manifest.chunks[0].id);

    const result = await replayDurableReviewPublication({ ...options, batchSize: 2 });

    expect(result).toMatchObject({ status: 'accepted', published: 1, skipped: 1 });
    expect(publishChunk).toHaveBeenCalledTimes(1);
    expect(store.read(created.filePath, identity).delivery.chunks[0]).toMatchObject({ status: 'published', source: 'github_ledger' });
  });

  it('reconciles locally published chunks against the ledger before terminal acceptance', async () => {
    const { options, created, publishChunk, store } = fixture();
    const payload = JSON.parse(fs.readFileSync(created.filePath, 'utf8'));
    payload.delivery.chunks[0] = { ...payload.delivery.chunks[0], status: 'published', source: 'publisher' };
    fs.writeFileSync(created.filePath, JSON.stringify(payload));

    await expect(replayDurableReviewPublication(options)).resolves.toMatchObject({ status: 'accepted', published: 2, skipped: 0 });
    expect(publishChunk).toHaveBeenCalledTimes(2);
    expect(options.ledger.getPublishedChunkIds).toHaveBeenCalledTimes(2);
    expect(store.read(created.filePath, identity).delivery.chunks.every((chunk: any) => chunk.source === 'github_ledger')).toBe(true);
  });

  it('cancels during retry backoff without attempting another ledger or publication write', async () => {
    const { options, publishChunk, ledger, store, created } = fixture();
    const controller = new AbortController();
    publishChunk.mockRejectedValueOnce(new Error('temporary provider failure'));
    options.sleep.mockImplementationOnce(async () => { controller.abort(); });

    await expect(replayDurableReviewPublication({ ...options, signal: controller.signal, maxAttempts: 2 })).resolves.toMatchObject({ status: 'cancelled', published: 0 });
    expect(publishChunk).toHaveBeenCalledTimes(1);
    expect(ledger.getPublishedChunkIds).toHaveBeenCalledTimes(1);
    expect(publishChunk.mock.calls[0][0].signal).toBe(controller.signal);
    expect(ledger.getPublishedChunkIds.mock.calls[0][0].signal).toBe(controller.signal);
    expect(store.read(created.filePath, identity).delivery.chunks[0]).toMatchObject({ status: 'pending', attempts: 1 });
  });

  it('requires explicit replay authorization before acquiring a lease or publishing', async () => {
    const { options, publishChunk } = fixture();
    await expect(replayDurableReviewPublication({ ...options, authorizeReplay: async () => false })).rejects.toThrow('replay is not authorized');
    expect(publishChunk).not.toHaveBeenCalled();
  });
});
