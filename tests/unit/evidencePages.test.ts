import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, createHash: vi.fn(actual.createHash) };
});
import { runReadOnlyTool } from '../../src/panel/toolRuntime';
import { createRepoFileProvider } from '../../src/panel/repoFileProvider';
import type { GitHubInstallationClient } from '../../src/github/installationClient';

const HEAD = 'a'.repeat(40), BASE = 'b'.repeat(40), OLD = 'c'.repeat(40);
const parse = (value: { toolOutput: string }) => JSON.parse(value.toolOutput);

describe('original evidence pages', () => {
  it('reports stale offsets and failed source lookups without claiming completion', async () => {
    const context = { changedFiles: [{ path: 'x', patch: 'abc' }], repoFileProvider: {
      readFile: async () => null, findFiles: async () => [], readFileAt: async () => { throw new Error('lookup failed'); },
    } };
    expect(parse(await runReadOnlyTool('get_diff_page', { path: 'x', startOffset: 4 }, context)))
      .toMatchObject({ status: 'invalid', reason: 'offset_out_of_range' });
    expect(parse(await runReadOnlyTool('read_file_page', { path: 'x', side: 'head' }, context)))
      .toMatchObject({ status: 'unavailable', reason: 'source_lookup_failed' });
  });

  it('uses separate original evidence while legacy tools retain reduced patches', async () => {
    const context = { changedFiles: [{ path: 'x', patch: 'cut', originalPatchLength: 10 }],
      originalChangedFiles: [{ path: 'x', patch: 'full patch' }] };
    expect(parse(await runReadOnlyTool('get_diff_page', { path: 'x' }, context)).content).toBe('full patch');
    expect((await runReadOnlyTool('get_diff', { path: 'x' }, context)).toolOutput).not.toContain('full patch');
  });

  it('hashes a stable source once across pages and invalidates changed content', async () => {
    let content = 'x'.repeat(160_000);
    const context = { changedFiles: [], repoFileProvider: { readFile: async () => null, findFiles: async () => [],
      readFileAt: async () => ({ sha: HEAD, content }) } };
    vi.mocked(createHash).mockClear();
    const first = parse(await runReadOnlyTool('read_file_page', { path: 'x', side: 'head', maxChars: 16_000 }, context));
    for (let startOffset = 16_000; startOffset < content.length; startOffset += 16_000) {
      expect(parse(await runReadOnlyTool('read_file_page', { path: 'x', side: 'head', startOffset, digest: first.digest }, context)).status).toBe('ok');
    }
    expect(createHash).toHaveBeenCalledTimes(1);
    content += 'changed';
    expect(parse(await runReadOnlyTool('read_file_page', { path: 'x', side: 'head', digest: first.digest }, context)).reason)
      .toBe('evidence_digest_mismatch');
    expect(createHash).toHaveBeenCalledTimes(2);
  });

  it('recovers a late contract from a >100KB single deletion hunk despite a reduced tool patch', async () => {
    const patch = 'diff --git a/old.sh b/old.sh\n@@ -1 +0,0 @@\n-' + 'x'.repeat(160_000) + 'guard_tenant_id';
    const context = { changedFiles: [{ path: 'old.sh', patch: '[REDUCED]', originalPatchLength: patch.length }],
      repoFileProvider: { findFiles: async () => [], readFile: async () => null,
        readDiff: (path: string) => path === 'old.sh' ? { patch } : null } };
    let offset = 0, digest: string | undefined, recovered = '';
    do {
      const value = await runReadOnlyTool('get_diff_page', { path: 'old.sh', startOffset: offset, maxChars: 16_000,
        ...(digest ? { digest } : {}) }, context);
      expect(value.isExhaustive).toBe(false);
      const page = parse(value);
      expect(page.status).toBe('ok'); expect(page.content.length).toBeLessThanOrEqual(16_000);
      recovered += page.content; digest = page.digest; offset = page.nextOffset;
    } while (offset !== null);
    expect(recovered).toBe(patch);
    expect(recovered.endsWith('guard_tenant_id')).toBe(true);
    expect(parse(await runReadOnlyTool('get_diff_page', { path: 'old.sh', digest: 'd'.repeat(64) }, context)))
      .toMatchObject({ status: 'invalid', reason: 'evidence_digest_mismatch' });
  });

  it('reads removed source at the verified merge-base, never the branch tip, and memoizes it', async () => {
    const github = { getMergeBase: vi.fn(async () => OLD), getFileContent: vi.fn(async (_o, _r, _p, sha) => sha === OLD ? 'old contract' : null) };
    const provider = createRepoFileProvider(github as unknown as GitHubInstallationClient, 'o', 'r', HEAD,
      { baseSha: BASE, changedFiles: [] });
    const context = { changedFiles: [], repoFileProvider: provider };
    for (let i = 0; i < 2; i++) expect(parse(await runReadOnlyTool('read_file_page', { path: 'old.sh', side: 'merge-base' }, context)))
      .toMatchObject({ status: 'ok', sha: OLD, side: 'merge-base', content: 'old contract' });
    expect(github.getMergeBase).toHaveBeenCalledExactlyOnceWith('o', 'r', BASE, HEAD);
    expect(github.getFileContent).toHaveBeenCalledExactlyOnceWith('o', 'r', 'old.sh', OLD, { notFoundIsEmpty: true });
    expect(parse(await runReadOnlyTool('read_file_page', { path: 'old.sh', side: 'head' }, context)))
      .toMatchObject({ status: 'unavailable' });
  });

  it('binds continuation digests to snapshot, path and source side even for equal content', async () => {
    const provider = { readFile: async () => null, findFiles: async () => [],
      readDiff: () => ({ patch: 'same patch', identity: { repository: 'o/r', baseSha: BASE, headSha: HEAD } }),
      readFileAt: async (_path: string, side: string) => ({ content: 'same source', sha: side === 'head' ? HEAD : OLD }) };
    const context = { changedFiles: [], repoFileProvider: provider };
    const first = parse(await runReadOnlyTool('get_diff_page', { path: 'one.ts', maxChars: 4 }, context));
    expect(first.identity).toEqual({ repository: 'o/r', baseSha: BASE, headSha: HEAD });
    expect(parse(await runReadOnlyTool('get_diff_page', { path: 'two.ts', digest: first.digest }, context)))
      .toMatchObject({ status: 'invalid', reason: 'evidence_digest_mismatch' });
    provider.readDiff = () => ({ patch: 'same patch', identity: { repository: 'o/r', baseSha: BASE, headSha: OLD } });
    expect(parse(await runReadOnlyTool('get_diff_page', { path: 'one.ts', digest: first.digest }, context)))
      .toMatchObject({ status: 'invalid', reason: 'evidence_digest_mismatch' });
    const source = parse(await runReadOnlyTool('read_file_page', { path: 'one.ts', side: 'head' }, context));
    expect(parse(await runReadOnlyTool('read_file_page', { path: 'one.ts', side: 'merge-base', digest: source.digest }, context)))
      .toMatchObject({ status: 'invalid', reason: 'evidence_digest_mismatch' });
  });

  it.each([{ path: 'old.sh', side: 'base' }, { path: '../secret', side: 'head' },
    { path: 'old.sh', side: 'head', maxChars: 32_001 }, { path: 'old.sh', side: 'head', startOffset: -1 },
    { path: 'old.sh', side: 'head', command: 'execute' }])('rejects arbitrary revisions, paths and page bounds', async (args) => {
    const readFileAt = vi.fn();
    const value = await runReadOnlyTool('read_file_page', args, { changedFiles: [],
      repoFileProvider: { readFile: async () => null, findFiles: async () => [], readFileAt } });
    expect(parse(value).status).toBe('invalid'); expect(readFileAt).not.toHaveBeenCalled();
  });

  it('keeps unavailable, previously truncated and canceled evidence unresolved', async () => {
    const context = { changedFiles: [{ path: 'x', patch: 'cut', originalPatchLength: 99 }] };
    expect(parse(await runReadOnlyTool('get_diff_page', { path: 'x' }, context))).toMatchObject({ status: 'unavailable' });
    expect(parse(await runReadOnlyTool('get_diff_page', { path: 'missing' }, context))).toMatchObject({ status: 'unavailable' });
    const abort = new AbortController(); abort.abort();
    await expect(runReadOnlyTool('get_diff_page', { path: 'x' }, { ...context, signal: abort.signal })).rejects.toThrow();
  });
});
