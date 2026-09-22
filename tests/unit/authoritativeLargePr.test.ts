import { createHash } from 'node:crypto';
import { applyPatch, structuredPatch } from 'diff';
import { describe, expect, it, vi } from 'vitest';
import {
  AuthoritativeReviewReader, MAX_AUTHORITATIVE_CHANGED_FILES_BYTES,
} from '../../src/github/authoritativeReviewReader';
import { MAX_CHANGED_FILE_PATCH_BYTES } from '../../src/review/reviewEvidenceLimits';
import { validateReviewFindings } from '../../src/review/reviewCore';

vi.mock('diff', async (importOriginal) => {
  const actual = await importOriginal<typeof import('diff')>();
  return { ...actual, structuredPatch: vi.fn(actual.structuredPatch) };
});

const target = { repositoryId: 321, owner: 'example', repo: 'candidate', prNumber: 5136,
  headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) };
const mergeBaseSha = 'd'.repeat(40);
const token = 'ghs_large-pr.header.signature';
const patch = '@@ -1 +1 @@\n-old\n+new';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const pull = (count = 130, overrides = {}) => json({ number: target.prNumber, state: 'open', merged: false,
  draft: false, head: { sha: target.headSha }, base: { sha: target.baseSha,
    repo: { id: target.repositoryId, full_name: 'example/candidate' } }, changed_files: count, ...overrides });
const oversized = () => json({ message: 'Sorry, the diff exceeded the maximum number of lines (20000)',
  errors: [{ resource: 'PullRequest', field: 'diff', code: 'too_large' }] }, 406);
const comparisonBody = (mergeSha = target.baseSha, overrides: Record<string, unknown> = {}) => ({
  url: `https://api.github.com/repos/example/candidate/compare/${target.baseSha}...${target.headSha}`,
  base_commit: { sha: target.baseSha }, merge_base_commit: { sha: mergeSha },
  status: 'ahead', ahead_by: 1, behind_by: 0, total_commits: 1, ...overrides,
});
const comparison = (mergeSha = target.baseSha, overrides: Record<string, unknown> = {}) =>
  json(comparisonBody(mergeSha, overrides));
const files = (count = 130) => Array.from({ length: count }, (_, i) => ({ sha: 'c'.repeat(40),
  filename: `src/file-${i}.ts`, status: 'modified', additions: 1, deletions: 1, changes: 2, patch }));
const immutableComparison = (entries: unknown[], mergeSha = target.baseSha,
  overrides: Record<string, unknown> = {}) => comparison(mergeSha, { files: entries, ...overrides });
const blobSha = (content: string) => createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex');
const contentBody = (path: string, content: string) => ({ type: 'file', path, sha: blobSha(content),
  size: Buffer.byteLength(content), encoding: 'base64', content: Buffer.from(content).toString('base64') });
function largeVersions(size: number, changedLines: number, seed: number): { base: string; head: string } {
  const lines: string[] = []; let bytes = 0;
  while (bytes < size) {
    const line = `line-${String(seed).padStart(2, '0')}-${String(lines.length).padStart(6, '0')}-xxxxxxxx`;
    bytes += Buffer.byteLength(line) + (lines.length === 0 ? 0 : 1); lines.push(line);
  }
  const base = lines.join('\n').slice(0, size); const headLines = base.split('\n');
  for (let index = 0; index < Math.min(changedLines, headLines.length); index++) {
    headLines[index] = headLines[index].replace('line-', 'next-');
  }
  return { base, head: headLines.join('\n') };
}
function fixture(responses: Response[]) {
  const fetcher = vi.fn<typeof fetch>();
  for (const response of responses) fetcher.mockResolvedValueOnce(response);
  fetcher.mockRejectedValue(new Error('unexpected request'));
  return { fetcher, reader: new AuthoritativeReviewReader({ token, fetchImplementation: fetcher }) };
}
const run = (f: ReturnType<typeof fixture>) => f.reader.exactCurrentDiff(target);
function reconstructFixture(file: ReturnType<typeof files>[number], base: Response, head: Response,
  final = pull(1)) {
  return fixture([pull(1), oversized(), immutableComparison([file]), base, head, final]);
}

describe('authoritative oversized PR fallback', () => {
  it('uses only immutable SHA compare files and never mutable PR-number file pages', async () => {
    const entries = files(2); let pullReads = 0;
    const requests: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input)); requests.push(`${url.pathname}${url.search}`);
      if (url.pathname.endsWith('/pulls/5136')) {
        if (init?.headers && (init.headers as Record<string, string>).Accept === 'application/vnd.github.v3.diff') return oversized();
        pullReads++; return pull(2);
      }
      if (url.pathname.endsWith('/pulls/5136/files')) throw new Error('mutable file pages must not be read');
      if (url.pathname.endsWith(`/compare/${target.baseSha}...${target.headSha}`)) {
        expect(url.search).toBe('?per_page=1&page=1');
        return immutableComparison(entries);
      }
      throw new Error(`unexpected request ${url}`);
    });
    const result = await new AuthoritativeReviewReader({ token, fetchImplementation: fetcher }).exactCurrentDiff(target);
    expect(result.changedFiles).toEqual(entries.map((entry) => ({ path: entry.filename, patch: entry.patch })));
    expect(pullReads).toBe(2);
    expect(requests.some((request) => request.includes('/pulls/5136/files'))).toBe(false);
  });

  it('uses divergent three-dot compare paths and excludes base-only paths', async () => {
    const entry = { ...files(1)[0], filename: 'src/pr-only.ts' };
    const f = fixture([pull(1), oversized(), immutableComparison([entry], mergeBaseSha, {
      status: 'diverged', ahead_by: 1, behind_by: 1,
    }), pull(1)]);
    const result = await run(f);
    expect(result.changedFiles).toEqual([{ path: 'src/pr-only.ts', patch }]);
    expect(result.changedFiles?.some((file) => file.path === 'release/base-only.ts')).toBe(false);
    expect(f.fetcher.mock.calls.map(([url]) => String(url))).not.toContain(
      'https://api.github.com/repos/example/candidate/pulls/5136/files?per_page=100&page=1');
  });

  it('fails before immutable comparison when GitHub reports more than its 300-file compare cap', async () => {
    const f = fixture([pull(301), oversized()]);
    await expect(run(f)).rejects.toThrow('Review reader file count unavailable');
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  it('discards immutable comparison evidence when the final candidate changed', async () => {
    const changed = pull(1, { head: { sha: 'e'.repeat(40) } });
    const f = fixture([pull(1), oversized(), immutableComparison(files(1)), changed]);
    const result = await run(f);
    expect(result).toEqual({ current: { ...target, headSha: 'e'.repeat(40), open: true, draft: false }, diff: '' });
  });

  it.each([
    ['renamed', 'src/old-name.ts', 'same\n', 'same\n'],
    ['copied', 'src/source.ts', 'same\n', 'same\n'],
    ['mode-only modified', undefined, 'same\n', 'same\n'],
    ['empty added', undefined, undefined, ''],
    ['empty removed', undefined, '', undefined],
  ] as const)('fails closed for %s when exact pinned text has no reviewable diff',
    async (status, previous_filename, base, head) => {
      const githubStatus = status === 'mode-only modified' ? 'modified'
        : status === 'empty added' ? 'added' : status === 'empty removed' ? 'removed' : status;
      const path = 'src/no-text-change.ts'; const content = head ?? base ?? '';
      const file = { ...files(1)[0], filename: path, status: githubStatus, sha: blobSha(content), patch: null as never,
        additions: 0, deletions: 0, changes: 0, ...(previous_filename ? { previous_filename } : {}) };
      const oldPath = previous_filename ?? path;
      const f = fixture([pull(1), oversized(), immutableComparison([file], mergeBaseSha),
        base === undefined ? json({}, 404) : json(contentBody(oldPath, base)),
        head === undefined ? json({}, 404) : json(contentBody(path, head)), pull(1)]);
      await expect(run(f)).rejects.toThrow('Review reader reconstructed diff unavailable');
      expect(f.fetcher).toHaveBeenCalledTimes(5);
    });

  it('anchors PR-only lines against the exact comparison merge base when the base tip advanced independently', async () => {
    const path = 'src/advanced.ts'; const atMergeBase = 'root\n'; const atHead = 'root\npr-added\n';
    const entry = { ...files(1)[0], filename: path, sha: blobSha(atHead), patch: null as never };
    let pullReads = 0;
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/repos/example/candidate/pulls/5136' && url.search === '') {
        pullReads++;
        return pullReads === 2 ? oversized() : pull(1);
      }
      if (url.pathname === `/repos/example/candidate/compare/${target.baseSha}...${target.headSha}`) {
        expect(url.search).toBe('?per_page=1&page=1');
        return immutableComparison([entry], mergeBaseSha, { status: 'diverged', ahead_by: 1, behind_by: 1 });
      }
      if (url.pathname.endsWith(`/contents/${path}`)) {
        const ref = url.searchParams.get('ref');
        // The independently advanced base tip already has the same line. Diffing
        // against it would erase the PR's only reviewable line.
        const content = ref === mergeBaseSha ? atMergeBase : atHead;
        return json(contentBody(path, content));
      }
      throw new Error(`unexpected request ${url}`);
    });
    const reader = new AuthoritativeReviewReader({ token, fetchImplementation: fetcher });
    const result = await reader.exactCurrentDiff(target);
    expect(result.changedFiles).toHaveLength(1);
    expect(applyPatch(atMergeBase, result.changedFiles![0].patch)).toBe(atHead);
    expect(validateReviewFindings([{ severity: 'P1', path, line: 2, title: 'Unsafe default',
      body: 'The PR-added line enables the unsafe behavior.' }], result.changedFiles)).toMatchObject({ valid: true });
    expect(validateReviewFindings([{ severity: 'P1', path, line: 1, title: 'Unchanged line',
      body: 'This line existed before the PR.' }], result.changedFiles)).toMatchObject({ valid: false });
  });

  it.each([
    ['modified', '\uFEFFold\n', '\uFEFFnew\n'],
    ['added', undefined, '\uFEFFnew\n'],
  ] as const)('preserves a leading UTF-8 BOM byte-for-byte for %s reconstruction', async (status, base, head) => {
    const file = { ...files(1)[0], status, sha: blobSha(head), patch: null as never };
    const f = reconstructFixture(file,
      base === undefined ? json({}, 404) : json(contentBody(file.filename, base)),
      json(contentBody(file.filename, head)));
    const result = await run(f);
    expect(applyPatch(base ?? '', result.changedFiles![0].patch)).toBe(head);
    expect(Buffer.from(applyPatch(base ?? '', result.changedFiles![0].patch) as string)).toEqual(Buffer.from(head));
  });

  it('accepts GitHub Contents API base64 with 60-character newline wrapping', async () => {
    const base = 'first line from GitHub contents API\nsecond line keeps the fixture realistic\nthird line\n';
    const head = 'first line from GitHub contents API\nsecond line keeps the fixture realistic\nupdated third line\n';
    const file = { ...files(1)[0], sha: blobSha(head), patch: null as never };
    const baseBody = { ...contentBody(file.filename, base),
      content: 'Zmlyc3QgbGluZSBmcm9tIEdpdEh1YiBjb250ZW50cyBBUEkKc2Vjb25kIGxp\nbmUga2VlcHMgdGhlIGZpeHR1cmUgcmVhbGlzdGljCnRoaXJkIGxpbmUK\n' };
    const headBody = { ...contentBody(file.filename, head),
      content: 'Zmlyc3QgbGluZSBmcm9tIEdpdEh1YiBjb250ZW50cyBBUEkKc2Vjb25kIGxp\nbmUga2VlcHMgdGhlIGZpeHR1cmUgcmVhbGlzdGljCnVwZGF0ZWQgdGhpcmQg\nbGluZQo=\n' };
    const reconstructed = (await run(reconstructFixture(file, json(baseBody), json(headBody)))).changedFiles![0].patch;
    expect(applyPatch(base, reconstructed)).toBe(head);
  });

  it('passes deterministic edit-work and synchronous timeout bounds to diff', async () => {
    const actual = await vi.importActual<typeof import('diff')>('diff');
    const diffSpy = vi.mocked(structuredPatch);
    diffSpy.mockClear();
    diffSpy.mockImplementationOnce(actual.structuredPatch);
    const base = 'old\n'; const head = 'new\n';
    const file = { ...files(1)[0], sha: blobSha(head), patch: null as never };
    await run(reconstructFixture(file, json(contentBody(file.filename, base)), json(contentBody(file.filename, head))));
    expect(diffSpy).toHaveBeenCalledOnce();
    expect(diffSpy.mock.calls[0]?.[6]).toEqual({ context: 3, timeout: 100, maxEditLength: 500 });
  });

  it('round-trips a greater-than-500-edit disjoint change through the full-replacement fallback', async () => {
    const actual = await vi.importActual<typeof import('diff')>('diff');
    const diffSpy = vi.mocked(structuredPatch);
    diffSpy.mockClear();
    diffSpy.mockImplementationOnce(actual.structuredPatch);
    const base = Array.from({ length: 501 }, (_, index) => `old-${index}`).join('\n') + '\n';
    const head = Array.from({ length: 501 }, (_, index) => `new-${index}`).join('\n') + '\n';
    const file = { ...files(1)[0], sha: blobSha(head), patch: null as never };
    const reconstructed = (await run(reconstructFixture(file,
      json(contentBody(file.filename, base)), json(contentBody(file.filename, head))))).changedFiles![0].patch;
    expect(diffSpy.mock.results[0]?.value).toBeUndefined();
    expect(reconstructed).toMatch(/^@@ -1,501 \+1,501 @@\n/u);
    expect(applyPatch(base, reconstructed)).toBe(head);
  });

  it.each([
    ['undefined', undefined],
    ['no hunks', { hunks: [] }],
  ] as const)('round-trips no-newline content through the full-replacement fallback when diff returns %s', async (_, result) => {
    vi.mocked(structuredPatch).mockReturnValueOnce(result as unknown as ReturnType<typeof structuredPatch>);
    const base = 'old first\nold last'; const head = 'new first\nnew last';
    const file = { ...files(1)[0], sha: blobSha(head), patch: null as never };
    const reconstructed = (await run(reconstructFixture(file,
      json(contentBody(file.filename, base)), json(contentBody(file.filename, head))))).changedFiles![0].patch;
    expect(reconstructed.match(/\\ No newline at end of file/gu)).toHaveLength(2);
    expect(applyPatch(base, reconstructed)).toBe(head);
  });

  it('applies the shared patch bound to full-replacement producer output', async () => {
    vi.mocked(structuredPatch).mockReturnValueOnce(undefined as unknown as ReturnType<typeof structuredPatch>);
    const lines = Math.floor(MAX_CHANGED_FILE_PATCH_BYTES / 6) + 1;
    const base = 'a\n'.repeat(lines); const head = 'b\n'.repeat(lines);
    const file = { ...files(1)[0], sha: blobSha(head), patch: null as never };
    await expect(run(reconstructFixture(file,
      json(contentBody(file.filename, base)), json(contentBody(file.filename, head)))))
      .rejects.toThrow('Review reader reconstructed diff unavailable');
  });

  it.each([
    ['malformed body', json({})],
    ['wrong comparison URL', immutableComparison(files(1), target.baseSha,
      { url: `https://api.github.com/repos/other/repo/compare/${target.baseSha}...${target.headSha}` })],
    ['wrong base identity', immutableComparison(files(1), target.baseSha, { base_commit: { sha: 'e'.repeat(40) } })],
    ['malformed merge base', immutableComparison(files(1), 'not-a-sha')],
    ['missing bounded metadata', json({ url: comparisonBody().url, base_commit: { sha: target.baseSha },
      merge_base_commit: { sha: target.baseSha }, files: files(1) })],
    ['non-success response', json({}, 500)],
  ] as const)('fails closed on %s comparison evidence before reading content', async (_, compareResponse) => {
    const f = fixture([pull(1), oversized(), compareResponse]);
    await expect(run(f)).rejects.toThrow(/comparison/u);
    expect(f.fetcher).toHaveBeenCalledTimes(3);
  });

  it('fails closed when bounded comparison evidence exceeds its response limit', async () => {
    const oversizedComparison = json({ ...comparisonBody(), files: files(1), padding: 'x'.repeat(8_000_000) });
    const f = fixture([pull(1), oversized(), oversizedComparison]);
    await expect(run(f)).rejects.toThrow('Review reader comparison evidence unavailable');
    expect(f.fetcher).toHaveBeenCalledTimes(3);
  });

  it('reconstructs all 40 missing patches from exact merge-base/head content in the real 130-file shape', async () => {
    const largeSizes = [175_000, 225_000, 300_000, 378_000];
    const addedSizes = [2_500, 4_000, 6_000, 8_000, 12_000, 16_000];
    const content = new Map<string, { base?: string; head?: string }>();
    const entries = files(130);
    for (let index = 0; index < 4; index++) {
      const path = `generated/large-${index}.json`;
      const { base, head } = largeVersions(largeSizes[index], [2_000, 4_000, 8_000, 14_000][index], index);
      content.set(path, { base, head });
      entries[index] = { ...entries[index], filename: path, sha: blobSha(head), patch: null as never,
        additions: [2_000, 4_000, 8_000, 14_000][index], deletions: [2_000, 4_000, 8_000, 14_000][index],
        changes: [4_000, 8_000, 16_000, 28_000][index] };
    }
    for (let offset = 0; offset < 6; offset++) {
      const index = offset + 4; const path = `test/generated-${offset}.exs`;
      const head = (`test ${offset}\n`).repeat(Math.ceil(addedSizes[offset] / 7)).slice(0, addedSizes[offset]);
      content.set(path, { head });
      entries[index] = { ...entries[index], filename: path, status: 'added', sha: blobSha(head),
        patch: null as never, additions: 0, deletions: 0, changes: 0 };
    }
    for (let index = 10; index < 40; index++) {
      const path = `src/missing-${index}.ts`; const base = `old ${index}\n`; const head = `new ${index}\n`;
      content.set(path, { base, head });
      entries[index] = { ...entries[index], filename: path, sha: blobSha(head), patch: null as never };
    }
    const requests: string[] = []; let pullReads = 0;
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input)); requests.push(`${url.pathname}${url.search}`);
      if (url.pathname === '/repos/example/candidate/pulls/5136' && url.search === '') {
        pullReads++;
        return pullReads === 2 ? oversized() : pull();
      }
      if (url.pathname === `/repos/example/candidate/compare/${target.baseSha}...${target.headSha}`) {
        expect(url.search).toBe('?per_page=1&page=1');
        return immutableComparison(entries);
      }
      const marker = '/repos/example/candidate/contents/';
      if (url.pathname.startsWith(marker)) {
        const path = url.pathname.slice(marker.length).split('/').map(decodeURIComponent).join('/');
        const revision = url.searchParams.get('ref'); const versions = content.get(path);
        const value = revision === target.baseSha ? versions?.base : revision === target.headSha ? versions?.head : undefined;
        return value === undefined ? json({ message: 'Not Found' }, 404) : json(contentBody(path, value));
      }
      return pull();
    });
    const reader = new AuthoritativeReviewReader({ token, fetchImplementation: fetcher });
    const result = await reader.exactCurrentDiff(target);
    expect(result.changedFiles).toHaveLength(130);
    expect(new Set(result.changedFiles?.map((file) => file.path))).toHaveProperty('size', 130);
    for (const path of content.keys()) {
      const reconstructed = result.changedFiles?.find((file) => file.path === path);
      expect(reconstructed?.patch).toMatch(/^@@ /u);
      expect(reconstructed?.patch).not.toContain('truncated');
      expect(applyPatch(content.get(path)?.base ?? '', reconstructed!.patch)).toBe(content.get(path)?.head);
      expect(requests).toContain(`/repos/example/candidate/contents/${path}?ref=${target.baseSha}`);
      expect(requests).toContain(`/repos/example/candidate/contents/${path}?ref=${target.headSha}`);
    }
  });

  it('reconstructs exactly 64 files within the bounded contents-read budget', async () => {
    const heads = new Map<string, string>();
    const entries = files(64).map((entry, index) => {
      const head = `added file ${index}\n`; heads.set(entry.filename, head);
      return { ...entry, status: 'added', sha: blobSha(head), additions: 1, deletions: 0, changes: 1, patch: null as never };
    });
    let pullReads = 0; let contentReads = 0;
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/repos/example/candidate/pulls/5136' && url.search === '') {
        pullReads++;
        return pullReads === 2 ? oversized() : pull(64);
      }
      if (url.pathname === `/repos/example/candidate/compare/${target.baseSha}...${target.headSha}`) {
        return immutableComparison(entries);
      }
      const marker = '/repos/example/candidate/contents/';
      if (url.pathname.startsWith(marker)) {
        contentReads++;
        const path = url.pathname.slice(marker.length).split('/').map(decodeURIComponent).join('/');
        return url.searchParams.get('ref') === target.baseSha
          ? json({ message: 'Not Found' }, 404) : json(contentBody(path, heads.get(path)!));
      }
      throw new Error(`unexpected request ${url}`);
    });
    const result = await new AuthoritativeReviewReader({ token, fetchImplementation: fetcher }).exactCurrentDiff(target);
    expect(result.changedFiles).toHaveLength(64);
    expect(contentReads).toBe(128);
  });

  it('rejects 65 reconstruction candidates before any contents reads', async () => {
    const entries = files(65).map((entry) => ({ ...entry, patch: null as never }));
    const f = fixture([pull(65), oversized(), immutableComparison(entries)]);
    await expect(run(f)).rejects.toThrow('Review reader reconstructed file count exceeds bound');
    expect(f.fetcher).toHaveBeenCalledTimes(3);
    expect(f.fetcher.mock.calls.some(([url]) => String(url).includes('/contents/'))).toBe(false);
  });

  it('reads all 130 immutable comparison files and binds both PR snapshots', async () => {
    const entries = files().map((entry) => ({ ...entry, additions: 100, deletions: 100, changes: 200,
      patch: '@@ -1,100 +1,100 @@\n' + Array(100).fill('-old').join('\n') + '\n' + Array(100).fill('+new').join('\n') }));
    expect(entries.reduce((sum, entry) => sum + entry.patch.split('\n').length, 0)).toBeGreaterThan(20_000);
    const f = fixture([pull(), oversized(), immutableComparison(entries), pull()]);
    const result = await run(f);
    expect(result).toEqual({ current: { ...target, open: true, draft: false }, diff: '', expectedFileCount: 130,
      changedFiles: entries.map((entry) => ({ path: entry.filename, patch: entry.patch })) });
    expect(f.fetcher.mock.calls.map(([url]) => url)).toEqual([
      'https://api.github.com/repos/example/candidate/pulls/5136',
      'https://api.github.com/repos/example/candidate/pulls/5136',
      `https://api.github.com/repos/example/candidate/compare/${target.baseSha}...${target.headSha}?per_page=1&page=1`,
      'https://api.github.com/repos/example/candidate/pulls/5136',
    ]);
  });

  it.each([
    ['added', undefined, 'new\n', undefined],
    ['removed', 'old\n', undefined, undefined],
    ['modified', 'old\n', 'new\n', undefined],
    ['changed', 'old\n', 'new\n', undefined],
    ['renamed', 'old\n', 'new\n', 'src/old-name.ts'],
    ['copied', 'old\n', 'new\n', 'src/source.ts'],
  ] as const)('reconstructs %s using its exact status paths', async (status, base, head, previous_filename) => {
    const path = 'src/new-name.ts'; const expected = head ?? base!;
    const file = { ...files(1)[0], filename: path, status, sha: blobSha(expected), patch: null as never,
      ...(previous_filename ? { previous_filename } : {}) };
    const oldPath = previous_filename ?? path;
    const f = reconstructFixture(file,
      base === undefined ? json({}, 404) : json(contentBody(oldPath, base)),
      head === undefined ? json({}, 404) : json(contentBody(path, head)));
    const result = await run(f);
    expect(result.changedFiles).toEqual([{ path, patch: expect.stringMatching(/^@@ /u) }]);
    expect(f.fetcher.mock.calls.slice(3, 5).map(([url]) => url)).toEqual([
      `https://api.github.com/repos/example/candidate/contents/${oldPath}?ref=${target.baseSha}`,
      `https://api.github.com/repos/example/candidate/contents/${path}?ref=${target.headSha}`,
    ]);
  });

  it('reconstructs a present but incomplete patch instead of trusting its counters', async () => {
    const base = 'old\n'; const head = 'new\n';
    const file = { ...files(1)[0], sha: blobSha(head), additions: 0, deletions: 0, changes: 0,
      patch: '@@ -1 +1 @@\n-old' };
    const result = await run(reconstructFixture(file,
      json(contentBody(file.filename, base)), json(contentBody(file.filename, head))));
    expect(result.changedFiles).toEqual([{ path: file.filename, patch: '@@ -1,1 +1,1 @@\n-old\n+new\n' }]);
  });

  it.each([
    ['added base unexpectedly exists', 'added', 'old\n', 'new\n'],
    ['removed head unexpectedly exists', 'removed', 'old\n', 'new\n'],
    ['modified base is missing', 'modified', undefined, 'new\n'],
    ['modified head is missing', 'modified', 'old\n', undefined],
  ] as const)('rejects %s', async (_, status, base, head) => {
    const expected = status === 'removed' ? base! : (head ?? base)!;
    const file = { ...files(1)[0], status, sha: blobSha(expected), patch: null as never };
    const f = reconstructFixture(file,
      base === undefined ? json({}, 404) : json(contentBody(file.filename, base)),
      head === undefined ? json({}, 404) : json(contentBody(file.filename, head)));
    await expect(run(f)).rejects.toThrow('Review reader pinned object status mismatch');
  });

  it.each([
    ['wrong blob identity', (body: Record<string, unknown>) => ({ ...body, sha: 'e'.repeat(40) })],
    ['wrong path', (body: Record<string, unknown>) => ({ ...body, path: 'src/other.ts' })],
    ['directory object', (body: Record<string, unknown>) => ({ ...body, type: 'dir' })],
    ['wrong size', (body: Record<string, unknown>) => ({ ...body, size: Number(body.size) + 1 })],
    ['wrong encoding', (body: Record<string, unknown>) => ({ ...body, encoding: 'utf-8' })],
    ['noncanonical base64 padding', (body: Record<string, unknown>) => ({ ...body,
      content: String(body.content).replace(/=+$/u, '') })],
    ['malformed base64', (body: Record<string, unknown>) => ({ ...body, content: '%%%not-base64%%%' })],
  ] as const)('rejects %s in a pinned content response', async (_, mutate) => {
    const base = 'old\n'; const head = 'new\n'; const file = { ...files(1)[0], sha: blobSha(head), patch: null as never };
    const bad = mutate(contentBody(file.filename, base));
    await expect(run(reconstructFixture(file, json(bad), json(contentBody(file.filename, head)))))
      .rejects.toThrow(/pinned object/u);
  });

  it.each([
    ['invalid UTF-8', new Uint8Array([0xff, 0xfe])],
    ['NUL-containing binary', Buffer.from('valid\0binary')],
  ] as const)('rejects %s content', async (_, bytes) => {
    const base = 'old\n'; const file = { ...files(1)[0], sha: blobSha(base), patch: null as never };
    const body = { type: 'file', path: file.filename,
      sha: createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex'),
      size: bytes.byteLength, encoding: 'base64', content: Buffer.from(bytes).toString('base64') };
    await expect(run(reconstructFixture(file, json(body), json(contentBody(file.filename, base)))))
      .rejects.toThrow(/not text/u);
  });

  it('rejects individual and aggregate reconstructed content bounds', async () => {
    const tooLarge = 'x'.repeat(512_001); const path = files(1)[0].filename;
    const file = { ...files(1)[0], sha: blobSha('new\n'), patch: null as never };
    await expect(run(reconstructFixture(file, json(contentBody(path, tooLarge)), json(contentBody(path, 'new\n')))))
      .rejects.toThrow();

    const entries = files(4).map((entry, index) => ({ ...entry, filename: `large-${index}.txt`, patch: null as never }));
    const contents = entries.flatMap((entry, index) => {
      const base = `${index}\n${'x'.repeat(510_000)}`; const head = `${index + 4}\n${'x'.repeat(510_000)}`;
      entry.sha = blobSha(head);
      return [json(contentBody(entry.filename, base)), json(contentBody(entry.filename, head))];
    });
    const f = fixture([pull(4), oversized(), immutableComparison(entries), ...contents]);
    await expect(run(f)).rejects.toThrow('Review reader reconstructed evidence exceeds bound');
  });

  it('combines GitHub and reconstructed patch bytes when enforcing the aggregate bound', async () => {
    const largePatch = '@@ -1 +1 @@\n-old\n+' + 'a'.repeat(479_980);
    const entries = files(201);
    for (const index of [0, 1, 2, 3, 100, 101, 102, 103]) entries[index] = { ...entries[index], patch: largePatch };
    const base = 'a\n'.repeat(30_000); const head = 'b\n'.repeat(30_000);
    entries[200] = { ...entries[200], sha: blobSha(head), patch: null as never };
    const providedPatchBytes = entries.slice(0, 200)
      .reduce((bytes, entry) => bytes + Buffer.byteLength(entry.patch, 'utf8'), 0);
    expect(providedPatchBytes).toBe(3_844_016);
    expect(providedPatchBytes).toBeLessThan(MAX_AUTHORITATIVE_CHANGED_FILES_BYTES);
    expect(Buffer.byteLength(base) + Buffer.byteLength(head)).toBe(120_000);
    vi.mocked(structuredPatch).mockReturnValueOnce(undefined as unknown as ReturnType<typeof structuredPatch>);
    const f = fixture([pull(201), oversized(), immutableComparison(entries), json(contentBody(entries[200].filename, base)),
      json(contentBody(entries[200].filename, head)), pull(201)]);
    await expect(run(f)).rejects.toThrow('Review reader reconstructed evidence exceeds bound');
    expect(f.fetcher).toHaveBeenCalledTimes(5);
  });

  it('discards reconstructed evidence when the candidate changes after pinned reads', async () => {
    const base = 'old\n'; const head = 'new\n';
    const file = { ...files(1)[0], sha: blobSha(head), patch: null as never };
    const changed = pull(1, { head: { sha: 'd'.repeat(40) } });
    const result = await run(reconstructFixture(file, json(contentBody(file.filename, base)),
      json(contentBody(file.filename, head)), changed));
    expect(result).toEqual({ current: { ...target, headSha: 'd'.repeat(40), open: true, draft: false }, diff: '' });
  });

  it.each([1, 100, 101, 300])('accepts immutable comparison evidence for %i files', async (count) => {
    const entries = files(count);
    const f = fixture([pull(count), oversized(), immutableComparison(entries), pull(count)]);
    expect((await run(f)).changedFiles).toHaveLength(count);
    expect(f.fetcher).toHaveBeenCalledTimes(4);
  });

  it.each([
    { filename: 'src/café space.ts', patch: '@@ -1 +1 @@\n-old\n+new\n' },
    { status: 'added', additions: 1, deletions: 0, changes: 1, patch: '@@ -0,0 +1 @@\n+new' },
    { status: 'removed', additions: 0, deletions: 1, changes: 1, patch: '@@ -1 +0,0 @@\n-old' },
    { status: 'renamed', previous_filename: 'src/old.ts' },
    { patch: '@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file' },
    { additions: 2, deletions: 2, changes: 4,
      patch: '@@ -1,2 +1,2 @@ function\n-old\n+new\n context\n@@ -8 +8 @@\n-old\n+new' },
  ])('retains complete supported file evidence %j', async (override) => {
    const file = { ...files(1)[0], ...override };
    const f = fixture([pull(1), oversized(), immutableComparison([file]), pull(1)]);
    expect((await run(f)).changedFiles).toEqual([{ path: file.filename, patch: file.patch }]);
  });

  it.each([
    ['count mismatch', immutableComparison(files(129))],
    ['duplicate path', immutableComparison([...files().slice(0, 129), files()[0]])],
    ['malformed file collection', comparison(target.baseSha, { files: { entries: files() } })],
  ] as const)('rejects immutable comparison %s', async (_, compareResponse) => {
    await expect(run(fixture([pull(), oversized(), compareResponse, pull()]))).rejects.toThrow();
  });

  it.each([
    { filename: '' }, { filename: '../escape.ts' }, { filename: '/abs.ts' }, { filename: 'a\n.ts' },
    { filename: 'a//b' }, { filename: 'a/./b' }, { filename: 'a'.repeat(4097) },
    { sha: 'main' }, { status: 'mystery' }, { additions: -1 }, { changes: 3 },
    { status: 'renamed' }, { additions: 1.5 }, { deletions: '1' },
    { patch: undefined }, { patch: null }, { patch: '' }, { patch: '@@ -1 +1 @@\n-old' },
    { patch: '@@ -1,2 +1,2 @@\n-old\n+new' },
    { patch: '@@ -1 +1 @@\n-old\n+new\n@@ -5 +5 @@\n-omitted' },
    { patch: '@@ -1 +1 @@\n-old\n+new\n... truncated ...' },
    { patch: '@@ -1 +1 @@\n-old\n+new\n@@ -1 +1 @@\n-old\n+new', additions: 2, deletions: 2, changes: 4 },
    { patch: '@@ -1 +1 @@\n-old\n+new', additions: 2, changes: 3 },
    { patch: 'diff --git a/spoof b/spoof\n@@ -1 +1 @@\n-old\n+new' },
    { patch: '@@ -9007199254740992 +1 @@\n-old\n+new' },
    { patch: '@@ -0 +1 @@\n-old\n+new' },
    { patch: '@@ -1 +1 @@\n\\ No newline at end of file\n-old\n+new' },
    { patch: '@@ -1 +1 @@\n-old\n+new\n+extra' },
  ])('fails closed for malformed or incomplete file %j', async (override) => {
    const f = fixture([pull(1), oversized(), immutableComparison([{ ...files(1)[0], ...override }]), pull(1)]);
    await expect(run(f)).rejects.toThrow();
  });

  it('does not request evidence for an already changed candidate', async () => {
    const f = fixture([pull(130, { head: { sha: 'd'.repeat(40) } })]);
    expect(await run(f)).not.toHaveProperty('changedFiles');
    expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it.each(['oversize-error', 'comparison'])('bounds and redacts oversized %s response bodies', async (stage) => {
    const privateText = 'private-content';
    const response = new Response(privateText.repeat(stage === 'oversize-error' ? 150_000 : 600_000),
      { status: stage === 'oversize-error' ? 406 : 200 });
    const f = fixture(stage === 'oversize-error' ? [pull(), response] : [pull(), oversized(), response]);
    await expect(run(f)).rejects.toThrow(stage === 'oversize-error'
      ? 'Review reader request unavailable' : 'Review reader comparison evidence unavailable');
    expect(f.fetcher).toHaveBeenCalledTimes(stage === 'oversize-error' ? 2 : 3);
  });

  it('bounds individual and aggregate patches without truncating evidence', async () => {
    const largeFile = { ...files(1)[0], patch: '@@ -1 +1 @@\n-old\n+' + 'a'.repeat(512_001) };
    await expect(run(fixture([pull(1), oversized(), immutableComparison([largeFile])]))).rejects
      .toThrow('Review reader comparison evidence unavailable');
    const entries = files(201).map((file, i) => ({ ...file,
      patch: '@@ -1 +1 @@\n-old\n+' + 'a'.repeat(i === 200 ? 200_000 : 19_500) }));
    const f = fixture([pull(201), oversized(), immutableComparison(entries)]);
    await expect(run(f)).rejects.toThrow('Review reader file evidence unavailable');
    expect(f.fetcher).toHaveBeenCalledTimes(3);
  });

  it('bounds aggregate JSON response bytes even when patches are small', async () => {
    const entries = files(300).map((file) => ({ ...file, ignored_metadata: 'x'.repeat(27_000) }));
    const f = fixture([pull(300), oversized(), immutableComparison(entries)]);
    await expect(run(f)).rejects.toThrow('Review reader comparison evidence unavailable');
    expect(f.fetcher).toHaveBeenCalledTimes(3);
  });

  it.each(['fetch', 'body'])('aborts a stalled immutable comparison %s', async (stage) => {
    vi.useFakeTimers();
    try {
      const f = fixture([pull(), oversized()]);
      const cancel = vi.fn();
      if (stage === 'fetch') f.fetcher.mockImplementationOnce(() => new Promise<Response>(() => undefined));
      else f.fetcher.mockResolvedValueOnce(new Response(new ReadableStream({ cancel })));
      const pending = expect(run(f)).rejects.toThrow('Review reader comparison evidence unavailable');
      await vi.advanceTimersByTimeAsync(5000); await pending;
      expect(f.fetcher).toHaveBeenCalledTimes(3);
      expect(f.fetcher.mock.calls[2][1]?.signal?.aborted).toBe(true);
      if (stage === 'body') expect(cancel).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('honors caller cancellation during immutable comparison', async () => {
    const abort = new AbortController(); const cancel = vi.fn();
    const f = fixture([pull(), oversized()]);
    f.fetcher.mockImplementationOnce(async () => { abort.abort(); return new Response(new ReadableStream({ cancel })); });
    await expect(f.reader.exactCurrentDiff(target, abort.signal)).rejects.toThrow();
    expect(f.fetcher).toHaveBeenCalledTimes(3);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([
    { head: { sha: 'd'.repeat(40) } },
    { base: { sha: 'e'.repeat(40), repo: { id: 321, full_name: 'example/candidate' } } },
    { state: 'closed' }, { state: 'closed', merged: true },
  ])('discards all evidence when the final candidate changed %j', async (override) => {
    const f = fixture([pull(1), oversized(), immutableComparison(files(1)), pull(1, override)]);
    const result = await run(f);
    expect(result.diff).toBe('');
    expect(result).not.toHaveProperty('changedFiles');
    expect(result).not.toHaveProperty('expectedFileCount');
  });

  it.each([
    { changed_files: 2 }, { changed_files: undefined },
    { base: { sha: target.baseSha, repo: { id: 999, full_name: 'example/candidate' } } },
    { number: 999 },
  ])('rejects unstable counts or repository/PR identity %j', async (override) => {
    await expect(run(fixture([pull(1), oversized(), immutableComparison(files(1)), pull(1, override)]))).rejects.toThrow();
  });

  it.each([undefined, 0, 301])('rejects missing or out-of-bound file count %s', async (count) => {
    const f = fixture([pull(1, { changed_files: count }), oversized()]);
    await expect(run(f)).rejects.toThrow();
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    [406, { errors: [{ resource: 'PullRequest', field: 'diff', code: 'invalid' }] }],
    [406, { errors: [{ resource: 'Other', field: 'diff', code: 'too_large' }] }],
    [406, { message: 'too_large' }], [403, { errors: [{ resource: 'PullRequest', field: 'diff', code: 'too_large' }] }],
    [500, {}], [206, {}],
  ])('does not fall back for non-oversize error %s %j', async (status, body) => {
    const f = fixture([pull(), json(body, status)]);
    await expect(run(f)).rejects.toThrow(); expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
});
