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

  it('fences an expired lease so an old owner cannot persist after lease loss', () => {
    const { store, created, advance } = fixture();
    const first = store.acquireLease(created.filePath, { owner: 'runner-a', ttlMs: 1000 });
    advance(2000);
    const second = store.acquireLease(created.filePath, { owner: 'runner-b', ttlMs: 1000 });

    expect(second.fence).toBe(first.fence + 1);
    expect(() => store.update(created.filePath, first, () => ({ state: 'accepted' }))).toThrow('resume lease lost');
  });

  it('tracks bounded batches, retries retryable failures with backoff, and dead-letters exhausted chunks', async () => {
    const { options, publishChunk, store, created } = fixture();
    publishChunk
      .mockRejectedValueOnce(new Error('temporary provider failure'))
      .mockResolvedValueOnce({ publicationId: 'first' })
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

  it('requires explicit replay authorization before acquiring a lease or publishing', async () => {
    const { options, publishChunk } = fixture();
    await expect(replayDurableReviewPublication({ ...options, authorizeReplay: async () => false })).rejects.toThrow('replay is not authorized');
    expect(publishChunk).not.toHaveBeenCalled();
  });
});
