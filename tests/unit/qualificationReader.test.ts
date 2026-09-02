import { describe, expect, it, vi } from 'vitest';
import { loadSameHeadReviewSource } from '../../src/github/qualificationReader';

const headSha = 'a'.repeat(40);
const baseSha = 'b'.repeat(40);
const diff = 'diff --git a/a.ts b/a.ts\n+const value = 1;\n';

function input() {
  return {
    token: 'ghs_readOnlyQualificationToken',
    repo: 'calltelemetry/ct-pr-operator-sandbox',
    prNumber: 7,
    expectedBaseSha: baseSha,
    expectedHeadSha: headSha,
  };
}

function metadata(head = headSha, base = baseSha) {
  return { data: { head: { sha: head }, base: { sha: base } }, status: 200 };
}

describe('same-head qualification reader', () => {
  it('reads one exact PR diff and rechecks the projected head', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(metadata())
      .mockResolvedValueOnce({ data: diff, status: 200 })
      .mockResolvedValueOnce(metadata());

    await expect(loadSameHeadReviewSource(input(), request as any)).resolves.toEqual({
      baseSha,
      headSha,
      diff,
      diffDigest: 'd2d751cf5e7f13134f9d967a97ddc4104cc392ac078580ffcd66d76a928a2ef4',
      githubReads: 3,
    });
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls.map(([route]) => route)).toEqual([
      'GET /repos/{owner}/{repo}/pulls/{pull_number}',
      'GET /repos/{owner}/{repo}/pulls/{pull_number}',
      'GET /repos/{owner}/{repo}/pulls/{pull_number}',
    ]);
    expect(request.mock.calls[1][1].headers.accept).toBe('application/vnd.github.v3.diff');
    expect(request.mock.calls.every(([route]) => route.startsWith('GET '))).toBe(true);
  });

  it('fails before reading the diff when the projected base or head does not match', async () => {
    for (const response of [metadata('c'.repeat(40), baseSha), metadata(headSha, 'd'.repeat(40))]) {
      const request = vi.fn().mockResolvedValue(response);
      await expect(loadSameHeadReviewSource(input(), request as any)).rejects.toThrow(/projected pull request identity mismatch/u);
      expect(request).toHaveBeenCalledOnce();
    }
  });

  it('fails closed when the head moves during diff retrieval', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(metadata())
      .mockResolvedValueOnce({ data: diff, status: 200 })
      .mockResolvedValueOnce(metadata('e'.repeat(40), baseSha));

    await expect(loadSameHeadReviewSource(input(), request as any)).rejects.toThrow(/moved during qualification read/u);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('rejects empty and oversized diffs instead of truncating them', async () => {
    for (const candidate of ['', 'x'.repeat(2_000_001)]) {
      const request = vi.fn()
        .mockResolvedValueOnce(metadata())
        .mockResolvedValueOnce({ data: candidate, status: 200 });
      await expect(loadSameHeadReviewSource(input(), request as any)).rejects.toThrow(/diff size is outside qualification bounds/u);
      expect(request).toHaveBeenCalledTimes(2);
    }
  });

  it('classifies GitHub errors without exposing response text', async () => {
    const request = vi.fn().mockRejectedValue(Object.assign(
      new Error('ghs_secret_token raw provider response'),
      { status: 429 },
    ));
    const error = await loadSameHeadReviewSource(input(), request as any).catch((caught) => caught as Error);
    expect(error.message).toBe('GitHub qualification read failed HTTP 429');
    expect(error.message).not.toContain('ghs_secret_token');
  });
});
