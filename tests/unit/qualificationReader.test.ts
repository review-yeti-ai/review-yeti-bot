import { describe, expect, it, vi } from 'vitest';
import { GitHubQualificationReadError, loadSameHeadReviewSource } from '../../src/github/qualificationReader';

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
    for (const candidate of ['', 'x'.repeat(8_000_001)]) {
      const request = vi.fn()
        .mockResolvedValueOnce(metadata())
        .mockResolvedValueOnce({ data: candidate, status: 200 });
      await expect(loadSameHeadReviewSource(input(), request as any)).rejects.toThrow(/diff size is outside qualification bounds/u);
      expect(request).toHaveBeenCalledTimes(2);
    }
  });

  it('assembles the diff from the pull-files API when GitHub 406s the diff media read', async () => {
    const filePatchA = '@@ -1 +1 @@\n-old\n+new\n';
    const filePatchB = '@@ -2 +2 @@\n-before\n+after\n';
    const request = vi.fn()
      .mockResolvedValueOnce(metadata())
      .mockRejectedValueOnce(Object.assign(new Error('diff too large'), { status: 406 }))
      .mockResolvedValueOnce({
        data: [
          { filename: 'a.ts', status: 'modified', patch: filePatchA },
          { filename: 'renamed.ts', previous_filename: 'old.ts', status: 'renamed', patch: filePatchB },
          { filename: 'binary.png', status: 'modified' },
        ],
        status: 200,
      })
      .mockResolvedValueOnce(metadata());

    const source = await loadSameHeadReviewSource(input(), request as any);
    expect(source.diff).toContain('diff --git a/a.ts b/a.ts');
    expect(source.diff).toContain(filePatchA);
    expect(source.diff).toContain('diff --git a/old.ts b/renamed.ts');
    expect(source.diff).toContain(filePatchB);
    // REL-1092: a file without a patch keeps its place, marked, instead of vanishing.
    expect(source.diff).toContain('diff --git a/binary.png b/binary.png\n--- a/binary.png\n+++ b/binary.png\n'
      + '\\ Review Yeti: patch unavailable (omitted by GitHub)\n');
    expect(source.githubReads).toBe(4);
    expect(request).toHaveBeenCalledTimes(4);
    expect(request.mock.calls[2][0]).toBe('GET /repos/{owner}/{repo}/pulls/{pull_number}/files');
    expect(request.mock.calls[3][0]).toBe('GET /repos/{owner}/{repo}/pulls/{pull_number}');
  });

  it('classifies GitHub errors without exposing response text', async () => {
    const request = vi.fn().mockRejectedValue(Object.assign(
      new Error('ghs_secret_token raw provider response'),
      { status: 429 },
    ));
    const error = await loadSameHeadReviewSource(input(), request as any, { retry: { sleep: async () => undefined } })
      .catch((caught) => caught as GitHubQualificationReadError) as GitHubQualificationReadError;
    expect(error).toBeInstanceOf(GitHubQualificationReadError);
    expect(error.message).toBe('GitHub qualification read failed HTTP 429');
    expect(error.httpStatus).toBe(429);
    expect(error.githubReads).toBe(1);
    expect(error.message).not.toContain('ghs_secret_token');
  });

  it.each([406, 404, 401, 403, 429, 500, 502])(
    'sets the structured httpStatus field to %s from the real throw site, not the message',
    async (status) => {
      // Exercise the real throw site here -- not a hand-built error -- so a
      // future change to `safeRequest` that stops setting `httpStatus` fails
      // here instead of silently disabling every downstream status branch.
      // httpStatus is the single source of the status; the message text is
      // for humans only and is free to change independently.
      const request = vi.fn().mockRejectedValue(Object.assign(new Error('raw provider response'), { status }));
      // REL-1103: transient statuses retry first; a no-op sleep keeps this fast.
      const error = await loadSameHeadReviewSource(input(), request as any, { retry: { sleep: async () => undefined } })
        .catch((caught) => caught as GitHubQualificationReadError) as GitHubQualificationReadError;
      expect(error).toBeInstanceOf(GitHubQualificationReadError);
      expect(error.httpStatus).toBe(status);
      expect(error.message).toBe(`GitHub qualification read failed HTTP ${status}`);
    },
  );
});
