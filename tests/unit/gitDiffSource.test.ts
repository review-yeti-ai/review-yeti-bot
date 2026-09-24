import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createGitDiffSource, GIT_DIFF_ARGS, GIT_DIFF_MAX_BYTES, GitDiffSourceError, gitRemoteBaseFromApi, hunksClosed,
  isGitDiffFallbackEnabled, mergeBaseFromComparison, verifyGitDerivedDiff, type GitDiffSource,
} from '../../src/github/gitDiffSource';
import {
  trustedGitDiffSource, workerLargeDiffSourceOptions,
} from '../../src/github/largeDiffSourceWiring';
import {
  AuthoritativeReviewReader, MAX_AUTHORITATIVE_CHANGED_FILES_BYTES,
} from '../../src/github/authoritativeReviewReader';
import {
  GitHubPullRequestIdentityMovedError, GitHubQualificationReadError, loadSameHeadReviewSource,
  type GitHubQualificationRequest,
} from '../../src/github/qualificationReader';
import { parseChangedFiles } from '../../src/review/changedFiles';
import { validateReviewFindings } from '../../src/review/reviewCore';
import { createAuthoritativeCompletionContext, type AuthoritativeCompletionContextOptions } from '../../src/review/authoritativeCompletionContext';
import { buildAuthoritativeReviewIdentity } from '../../src/review/authoritativeReviewIdentity';
import { preparePublishingPolicy } from '../../src/review/preparedPublishingPolicy';
import { sha256 } from '../../src/review/reviewCore';
import { deriveCanonicalWorkerReviewEvidence } from '../../src/review/workerReviewCompletion';
import { evaluateReviewGate } from '../../src/review/reviewGatePolicy';
import type { StoredReviewGate } from '../../src/persistence/reviewGateRepository';

// ---------------------------------------------------------------------------
// A synthetic large pull request in a real git repository:
//   merge base M: 300 modifiable files, plus files to rename and delete.
//   head H (branch from M): 300 files each gain 70 lines (21,000 added lines),
//     15 files added, 1 renamed with an edit, 1 deleted => 317 changed files.
//   base tip B (main after M): an unrelated base-only file. A three-dot diff
//     must exclude it; a two-dot diff would not.
// ---------------------------------------------------------------------------
const MODIFIED = 300; const ADDED = 15; const LINES_PER_FILE = 70;
const EXPECTED_FILES = MODIFIED + ADDED + 2;
let root: string; let remote: string; let work: string;
let mergeBaseSha: string; let headSha: string; let baseTipSha: string;
const token = 'ghs_large-pr.header.signature';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: {
    PATH: process.env.PATH ?? '', HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_AUTHOR_DATE: '2026-09-23T00:00:00Z',
    GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_DATE: '2026-09-23T00:00:00Z',
  } as Record<string, string> as NodeJS.ProcessEnv, maxBuffer: 64 * 1024 * 1024 }).trim();
}
function write(path: string, content: string) {
  mkdirSync(dirname(join(work, path)), { recursive: true });
  writeFileSync(join(work, path), content);
}
const fileLines = (seed: string, count: number) => Array.from({ length: count }, (_, i) => `export const ${seed}_${i} = ${i};`).join('\n') + '\n';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'rel1080-fixture-'));
  work = join(root, 'work'); remote = join(root, 'remote.git');
  mkdirSync(work);
  git(work, 'init', '-q', '-b', 'main');
  for (let i = 0; i < MODIFIED; i++) write(`src/mod-${i}.ts`, fileLines(`m${i}`, 5));
  write('src/rename-me.ts', fileLines('renamed', 20));
  write('src/delete-me.ts', fileLines('deleted', 3));
  git(work, 'add', '-A'); git(work, 'commit', '-q', '-m', 'merge base');
  mergeBaseSha = git(work, 'rev-parse', 'HEAD');
  git(work, 'checkout', '-q', '-b', 'feature');
  for (let i = 0; i < MODIFIED; i++) write(`src/mod-${i}.ts`, fileLines(`m${i}`, 5) + fileLines(`n${i}`, LINES_PER_FILE));
  for (let i = 0; i < ADDED; i++) write(`src/new/added-${i}.ts`, fileLines(`a${i}`, 10));
  git(work, 'mv', 'src/rename-me.ts', 'src/renamed.ts');
  write('src/renamed.ts', fileLines('renamed', 20) + 'export const extra = 1;\n');
  git(work, 'rm', '-q', 'src/delete-me.ts');
  git(work, 'add', '-A'); git(work, 'commit', '-q', '-m', 'large change');
  headSha = git(work, 'rev-parse', 'HEAD');
  git(work, 'checkout', '-q', 'main');
  write('release/base-only.ts', fileLines('base', 4));
  git(work, 'add', '-A'); git(work, 'commit', '-q', '-m', 'base advanced independently');
  baseTipSha = git(work, 'rev-parse', 'HEAD');
  git(root, 'clone', '-q', '--bare', work, remote);
  git(remote, 'config', 'uploadpack.allowFilter', 'true');
  git(remote, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
}, 120_000);
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

const localSource = (overrides: Partial<Parameters<typeof createGitDiffSource>[0]> = {}): GitDiffSource => createGitDiffSource({
  remoteUrlFor: () => `file://${remote}`, allowLocalRemote: true, timeoutMs: 60_000,
  maxScratchBytes: 256 * 1024 * 1024, ...overrides,
});
const request = (overrides: Partial<Parameters<GitDiffSource>[0]> = {}) => ({
  owner: 'example', repo: 'candidate', token, mergeBaseSha, headSha, ...overrides,
});
async function reason(pending: Promise<unknown>): Promise<string> {
  try { await pending; } catch (error) {
    expect(error).toBeInstanceOf(GitDiffSourceError);
    return (error as GitDiffSourceError).reason;
  }
  throw new Error('expected rejection');
}
const addedLines = (diff: string) => diff.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).length;

describe('REL-1080 acceptance rule (shared by worker and trusted side)', () => {
  const one = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n ctx\n-old\n+new\n';

  it('accepts closed hunks whose file count equals GitHub changed_files', () => {
    expect(verifyGitDerivedDiff(one, { expectedFileCount: 1 })).toEqual([{ path: 'src/a.ts', patch: one }]);
  });

  it.each([
    ['a hunk shorter than its header (planted truncation)', one.replace(' ctx\n', ''), 1, 'unclosed-hunk'],
    ['a hunk longer than its header', one.replace('+new\n', '+new\n+more\n'), 1, 'unclosed-hunk'],
    ['a stray line inside a hunk', one.replace('+new\n', 'garbage\n'), 1, 'unclosed-hunk'],
    ['a misplaced no-newline marker', one.replace('@@ -1,2 +1,2 @@\n', '@@ -1,2 +1,2 @@\n\\ No newline at end of file\n'), 1, 'unclosed-hunk'],
    ['fewer files than GitHub reports', one, 2, 'file-count'],
    ['more files than GitHub reports', `${one}${one.replaceAll('src/a.ts', 'src/b.ts')}`, 1, 'file-count'],
    ['a duplicated path', `${one}${one}`, 2, 'file-count'],
    ['no GitHub file count', one, undefined, 'file-count'],
    ['an empty diff', '', 1, 'file-count'],
    ['an unreadable chunk', 'diff --git \n@@ -1 +1 @@\n-a\n+b\n', 1, 'unreadable'],
  ] as const)('rejects %s', (_label, diff, expectedFileCount, expected) => {
    try { verifyGitDerivedDiff(diff, { expectedFileCount }); } catch (error) {
      expect((error as GitDiffSourceError).reason).toBe(expected);
      return;
    }
    throw new Error('expected rejection');
  });

  it('rejects output over the byte bound instead of truncating it', () => {
    expect(() => verifyGitDerivedDiff(one, { expectedFileCount: 1, maxBytes: one.length - 1 })).toThrow(GitDiffSourceError);
    expect(GIT_DIFF_MAX_BYTES).toBe(MAX_AUTHORITATIVE_CHANGED_FILES_BYTES);
  });

  it('leaves hunk-less chunks (binary, pure rename) to the existing no-hunk handling', () => {
    expect(hunksClosed('diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\n')).toBe(true);
    expect(hunksClosed('diff --git a/a b/b\nsimilarity index 100%\nrename from a\nrename to b\n')).toBe(true);
  });

  it('takes the merge base only from a compare response for the exact base', () => {
    const base = 'b'.repeat(40); const merge = 'd'.repeat(40);
    expect(mergeBaseFromComparison({ base_commit: { sha: base }, merge_base_commit: { sha: merge } }, base)).toBe(merge);
    expect(() => mergeBaseFromComparison({ base_commit: { sha: 'e'.repeat(40) }, merge_base_commit: { sha: merge } }, base))
      .toThrow(GitDiffSourceError);
    expect(() => mergeBaseFromComparison({ base_commit: { sha: base }, merge_base_commit: { sha: 'main' } }, base))
      .toThrow(GitDiffSourceError);
  });

  it('is on by default and switched off only by an explicit false-like value', () => {
    expect(isGitDiffFallbackEnabled({})).toBe(true);
    expect(isGitDiffFallbackEnabled({ REVIEW_YETI_GIT_DIFF_FALLBACK: 'true' })).toBe(true);
    for (const off of ['0', 'false', 'OFF', 'no', 'disabled']) {
      expect(isGitDiffFallbackEnabled({ REVIEW_YETI_GIT_DIFF_FALLBACK: off })).toBe(false);
      expect(workerLargeDiffSourceOptions({ REVIEW_YETI_GIT_DIFF_FALLBACK: off })).toEqual({});
      expect(trustedGitDiffSource({ REVIEW_YETI_GIT_DIFF_FALLBACK: off }, 'https://api.github.com')).toBeUndefined();
    }
    expect(workerLargeDiffSourceOptions({}).gitDiffSource).toBeTypeOf('function');
    expect(trustedGitDiffSource({}, '')).toBeTypeOf('function');
  });

  it('derives the git host from the REST API base and refuses non-HTTPS bases', () => {
    expect(gitRemoteBaseFromApi()).toBe('https://github.com');
    expect(gitRemoteBaseFromApi('https://api.github.com/')).toBe('https://github.com');
    expect(gitRemoteBaseFromApi('https://ghe.example.com/api/v3')).toBe('https://ghe.example.com');
    expect(() => gitRemoteBaseFromApi('http://ghe.example.com/api/v3')).toThrow(GitDiffSourceError);
    expect(trustedGitDiffSource({}, 'http://insecure.example')).toBeUndefined();
  });
});

describe('REL-1080 git diff source against a real repository', () => {
  it('computes the exact three-dot diff of a >300-file, >20k-line pull request', async () => {
    const diff = await localSource()(request());
    const expected = execFileSync('git', ['--git-dir', remote, ...GIT_DIFF_ARGS, mergeBaseSha, headSha, '--'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { PATH: process.env.PATH ?? '', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } as Record<string, string> as NodeJS.ProcessEnv });
    expect(diff).toBe(expected);
    const files = verifyGitDerivedDiff(diff, { expectedFileCount: EXPECTED_FILES });
    expect(files).toHaveLength(EXPECTED_FILES);
    expect(files.length).toBeGreaterThan(300);
    expect(addedLines(diff)).toBeGreaterThan(20_000);
    expect(files.map((file) => file.path)).toContain('src/renamed.ts');
    expect(files.map((file) => file.path)).toContain('src/delete-me.ts');
    // Three-dot: the independently advanced base-only file is not part of the PR.
    expect(files.map((file) => file.path)).not.toContain('release/base-only.ts');
  }, 60_000);

  it('removes its scratch repository and never puts the token in argv', async () => {
    const scratchRoot = mkdtempSync(join(tmpdir(), 'rel1080-scratch-'));
    const argvLog = join(scratchRoot, '..', `${scratchRoot.split('/').pop()}-argv.log`);
    const wrapper = join(tmpdir(), `rel1080-git-wrapper-${process.pid}.sh`);
    writeFileSync(wrapper, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${argvLog}'\nexec git "$@"\n`);
    chmodSync(wrapper, 0o755);
    try {
      await localSource({ scratchRoot, gitBinary: wrapper })(request());
      expect(readdirSync(scratchRoot)).toEqual([]);
      const argv = readFileSync(argvLog, 'utf8');
      expect(argv).toContain(headSha);
      expect(argv).not.toContain(token);
      expect(argv).not.toContain(Buffer.from(`x-access-token:${token}`).toString('base64'));
    } finally {
      rmSync(scratchRoot, { recursive: true, force: true }); rmSync(argvLog, { force: true }); rmSync(wrapper, { force: true });
    }
  }, 60_000);

  it.each([
    ['an unknown head commit', () => localSource()(request({ headSha: 'f'.repeat(40) })), 'unavailable'],
    ['a malformed SHA', () => localSource()(request({ headSha: 'HEAD' })), 'identity'],
    ['a path-like repository name', () => localSource()(request({ repo: '..' })), 'identity'],
    ['a token that could inject a header line', () => localSource()(request({ token: 'ghs_x\r\nX-Evil: 1' })), 'identity'],
    ['a non-HTTPS remote in production mode', () => createGitDiffSource({ remoteUrlFor: () => `file://${remote}`,
      timeoutMs: 60_000, maxScratchBytes: 1 << 28 })(request()), 'unavailable'],
    ['a missing git binary', () => localSource({ gitBinary: '/nonexistent/git' })(request()), 'unavailable'],
    ['output over the byte bound', () => localSource({ maxOutputBytes: 10_000 })(request()), 'bounds'],
    ['a scratch repository over its disk budget', () => localSource({ maxScratchBytes: 1024 })(request()), 'bounds'],
  ] as const)('fails closed with a fixed reason for %s', async (_label, run, expected) => {
    expect(await reason(run())).toBe(expected);
  }, 60_000);

  it('honours the caller abort signal', async () => {
    const abort = new AbortController(); abort.abort();
    expect(await reason(localSource()(request({ signal: abort.signal })))).toBe('timeout');
  });
});

// ---------------------------------------------------------------------------
// Worker side: loadSameHeadReviewSource with a mocked GitHub API.
// ---------------------------------------------------------------------------
function workerApi(options: { finalHead?: string; finalFiles?: number; changedFiles?: number;
  compareBase?: string } = {}) {
  let pullReads = 0; const routes: string[] = [];
  const request = vi.fn<GitHubQualificationRequest>(async (route, parameters) => {
    routes.push(route);
    if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
      if ((parameters.headers as { accept?: string } | undefined)?.accept === 'application/vnd.github.v3.diff') {
        throw Object.assign(new Error('too large'), { status: 406 });
      }
      pullReads++;
      const final = pullReads > 1;
      return { data: { base: { sha: baseTipSha }, head: { sha: final && options.finalHead ? options.finalHead : headSha },
        changed_files: final && options.finalFiles !== undefined ? options.finalFiles : (options.changedFiles ?? EXPECTED_FILES) } };
    }
    if (route === 'GET /repos/{owner}/{repo}/compare/{basehead}') {
      expect(parameters.basehead).toBe(`${baseTipSha}...${headSha}`);
      return { data: { base_commit: { sha: options.compareBase ?? baseTipSha }, merge_base_commit: { sha: mergeBaseSha } } };
    }
    if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}/files') {
      return { data: [{ filename: 'src/from-pull-files.ts', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' }] };
    }
    throw new Error(`unexpected route ${route}`);
  });
  return { request, routes };
}
const workerInput = { token, repo: 'example/candidate', prNumber: 7, expectedBaseSha: '', expectedHeadSha: '' };
const worker = () => ({ ...workerInput, expectedBaseSha: baseTipSha, expectedHeadSha: headSha });

describe('REL-1080 worker: a 406 diff is computed from git, not failed', () => {
  it('reviews the >300-file, >20k-line pull request from the git-derived diff', async () => {
    const api = workerApi(); const outcomes: unknown[] = [];
    const source = await loadSameHeadReviewSource(worker(), api.request, {
      gitDiffSource: localSource(), onLargeDiffSource: (outcome) => outcomes.push(outcome) });
    const { files, unreadable } = parseChangedFiles(source.diff);
    expect(unreadable).toEqual([]);
    expect(files).toHaveLength(EXPECTED_FILES);
    expect(addedLines(source.diff)).toBeGreaterThan(20_000);
    expect(source.headSha).toBe(headSha);
    expect(api.routes).not.toContain('GET /repos/{owner}/{repo}/pulls/{pull_number}/files');
    expect(outcomes).toEqual([{ source: 'git', files: EXPECTED_FILES }]);
  }, 60_000);

  it('still rejects a head that moved during the read', async () => {
    const api = workerApi({ finalHead: 'e'.repeat(40) });
    await expect(loadSameHeadReviewSource(worker(), api.request, { gitDiffSource: localSource() }))
      .rejects.toBeInstanceOf(GitHubPullRequestIdentityMovedError);
  }, 60_000);

  it('rejects a file count that changed across the bracketing reads', async () => {
    const api = workerApi({ finalFiles: EXPECTED_FILES + 1 });
    await expect(loadSameHeadReviewSource(worker(), api.request, { gitDiffSource: localSource() }))
      .rejects.toThrow('GitHub pull request file count changed during qualification read');
  }, 60_000);

  it.each([
    ['GitHub reports a different file count', { changedFiles: EXPECTED_FILES - 1 }, 'file-count'],
    ['the compare response names another base', { compareBase: 'e'.repeat(40) }, 'identity'],
  ] as const)('falls back to the pre-REL-1080 pull-files path when %s', async (_label, options, expected) => {
    const api = workerApi(options); const outcomes: unknown[] = [];
    const source = await loadSameHeadReviewSource(worker(), api.request, {
      gitDiffSource: localSource(), onLargeDiffSource: (outcome) => outcomes.push(outcome) });
    expect(parseChangedFiles(source.diff).files.map((file) => file.path)).toEqual(['src/from-pull-files.ts']);
    expect(outcomes).toEqual([{ source: 'pull-files', reason: expected }]);
  }, 60_000);

  it('keeps the pre-REL-1080 behaviour exactly when no git source is wired', async () => {
    const api = workerApi();
    const source = await loadSameHeadReviewSource(worker(), api.request);
    expect(parseChangedFiles(source.diff).files.map((file) => file.path)).toEqual(['src/from-pull-files.ts']);
    expect(api.routes).not.toContain('GET /repos/{owner}/{repo}/compare/{basehead}');
  });

  it('never touches git when GitHub renders the diff', async () => {
    const gitDiffSource = vi.fn<GitDiffSource>();
    const request = vi.fn<GitHubQualificationRequest>(async (_route, parameters) => (
      (parameters.headers as { accept?: string } | undefined)?.accept
        ? { data: 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n' }
        : { data: { base: { sha: baseTipSha }, head: { sha: headSha }, changed_files: 1 } }));
    await loadSameHeadReviewSource(worker(), request, { gitDiffSource });
    expect(gitDiffSource).not.toHaveBeenCalled();
  });

  it('does not reclassify non-406 diff failures', async () => {
    const gitDiffSource = vi.fn<GitDiffSource>();
    const request = vi.fn<GitHubQualificationRequest>(async (_route, parameters) => {
      if ((parameters.headers as { accept?: string } | undefined)?.accept) throw Object.assign(new Error('x'), { status: 502 });
      return { data: { base: { sha: baseTipSha }, head: { sha: headSha }, changed_files: 1 } };
    });
    await expect(loadSameHeadReviewSource(worker(), request, { gitDiffSource }))
      .rejects.toBeInstanceOf(GitHubQualificationReadError);
    expect(gitDiffSource).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Trusted side: the real AuthoritativeReviewReader and completion context.
// ---------------------------------------------------------------------------
const target = () => ({ repositoryId: 321, owner: 'example', repo: 'candidate', prNumber: 7, headSha, baseSha: baseTipSha });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function trustedFetcher(options: { finalHead?: string; movesOnPullRead?: number; changedFiles?: number;
  compareFiles?: unknown[] } = {}) {
  let pullReads = 0; const paths: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input)); paths.push(`${url.pathname}${url.search}`);
    const t = target();
    if (url.pathname === `/repos/example/candidate/pulls/${t.prNumber}`) {
      if ((init?.headers as Record<string, string>).Accept === 'application/vnd.github.v3.diff') {
        return json({ errors: [{ resource: 'PullRequest', field: 'diff', code: 'too_large' }] }, 406);
      }
      pullReads++;
      const head = options.finalHead && pullReads >= (options.movesOnPullRead ?? 2) ? options.finalHead : t.headSha;
      return json({ number: t.prNumber, state: 'open', merged: false, draft: false, head: { sha: head },
        base: { sha: t.baseSha, repo: { id: t.repositoryId, full_name: 'example/candidate' } },
        changed_files: options.changedFiles ?? EXPECTED_FILES });
    }
    if (url.pathname === `/repos/example/candidate/compare/${t.baseSha}...${t.headSha}`) {
      return json({ url: `https://api.github.com/repos/example/candidate/compare/${t.baseSha}...${t.headSha}`,
        base_commit: { sha: t.baseSha }, merge_base_commit: { sha: mergeBaseSha }, status: 'diverged',
        ahead_by: 1, behind_by: 1, total_commits: 1, files: options.compareFiles ?? [] });
    }
    throw new Error(`unexpected request ${url}`);
  });
  return { fetcher, paths };
}
const readerWith = (fetcher: typeof fetch, gitDiffSource?: GitDiffSource) => new AuthoritativeReviewReader({
  token, fetchImplementation: fetcher, ...(gitDiffSource ? { gitDiffSource } : {}) });

describe('REL-1080 trusted side accepts the git-derived diff with the same identity guarantees', () => {
  it('produces exactly the per-file evidence the worker reviewed', async () => {
    const { fetcher } = trustedFetcher();
    const trusted = await readerWith(fetcher, localSource()).exactCurrentDiff(target());
    const workerSource = await loadSameHeadReviewSource(worker(), workerApi().request, { gitDiffSource: localSource() });
    expect(trusted.diff).toBe('');
    expect(trusted.expectedFileCount).toBe(EXPECTED_FILES);
    expect(trusted.changedFiles).toEqual(parseChangedFiles(workerSource.diff).files);
    // A finding on a line the PR added anchors on both sides; one on an unchanged line does not.
    const finding = (line: number) => [{ severity: 'P1', path: 'src/mod-299.ts', line, title: 'Unsafe export',
      body: 'The exported value is wrong.' }];
    expect(validateReviewFindings(finding(6), trusted.changedFiles)).toMatchObject({ valid: true });
    expect(validateReviewFindings(finding(1), trusted.changedFiles)).toMatchObject({ valid: false });
  }, 60_000);

  it('discards git evidence when the head moved before the closing read', async () => {
    const { fetcher } = trustedFetcher({ finalHead: 'e'.repeat(40) });
    const result = await readerWith(fetcher, localSource()).exactCurrentDiff(target());
    expect(result).toEqual({ current: { ...target(), headSha: 'e'.repeat(40), open: true, draft: false }, diff: '' });
  }, 60_000);

  it('negative proof: without the git source a >300-file 406 still fails exactly as before', async () => {
    const { fetcher } = trustedFetcher();
    await expect(readerWith(fetcher).exactCurrentDiff(target())).rejects.toThrow('Review reader file count unavailable');
  });

  it('falls back to the compare path when git evidence is refused', async () => {
    const entry = { sha: 'c'.repeat(40), filename: 'src/compare.ts', status: 'modified', additions: 1, deletions: 1,
      changes: 2, patch: '@@ -1 +1 @@\n-old\n+new' };
    const { fetcher } = trustedFetcher({ changedFiles: 1, compareFiles: [entry] });
    // GitHub says one file; git computes 317. The git evidence is refused, never trusted.
    const result = await readerWith(fetcher, localSource()).exactCurrentDiff(target());
    expect(result.changedFiles).toEqual([{ path: 'src/compare.ts', patch: entry.patch }]);
  }, 60_000);

  it('never calls git when the diff API renders the diff', async () => {
    const gitDiffSource = vi.fn<GitDiffSource>();
    const t = target();
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => (
      (init?.headers as Record<string, string>).Accept === 'application/vnd.github.v3.diff'
        ? new Response('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n')
        : json({ number: t.prNumber, state: 'open', merged: false, draft: false, head: { sha: t.headSha },
          base: { sha: t.baseSha, repo: { id: t.repositoryId, full_name: 'example/candidate' } }, changed_files: 1 })));
    await readerWith(fetcher, gitDiffSource).exactCurrentDiff(target());
    expect(gitDiffSource).not.toHaveBeenCalled();
  });
});

function policyFile() {
  const content = JSON.stringify({ schema: 'calltelemetry.review-policy.v1', review_yeti: {
    personas: 'security,testing', budget: { max_investigation_turns: 3 } } });
  return { content, source: { repositoryId: 456, repository: 'example/central-policy',
    sha: 'c'.repeat(40), path: 'policy/review.json', contentDigest: sha256(content) } };
}

describe('REL-1080 end to end: a >300-file, >20k-line PR completes through the trusted gate', () => {
  it('derives complete coverage and a SHIP from the worker lanes, and still rejects a mismatched head', async () => {
    const stored = preparePublishingPolicy(policyFile(), { baseUrl: 'https://gateway.example.invalid/v1', model: 'review-model' });
    const t = target();
    const current = { ...t, open: true, draft: false };
    const gate: StoredReviewGate = {
      coordinates: { ...t, runId: `run_${'1'.repeat(32)}`, policyDigest: stored.policy.effectivePolicyDigest,
        attemptId: `run_${'1'.repeat(32)}-g0-e2`, executionAttempt: 2 },
      reviewGeneration: 0, expectedAppId: 1234, externalId: 'service-gate', checkId: 456,
      creationState: 'bound', desiredState: 'in_progress', desiredVersion: 1, publishedVersion: 1, current: true,
    };
    const resolve = vi.fn<AuthoritativeCompletionContextOptions['publishingResolver']['resolve']>(async () => ({
      current: { ...current }, prepared: structuredClone(stored),
      identity: buildAuthoritativeReviewIdentity({ requested: t, current, policy: stored.policy }) }));
    const contextFor = (fetcher: typeof fetch) => createAuthoritativeCompletionContext({
      getStoredPrepared: async () => stored, publishingResolver: { resolve },
      readerFactory: async () => readerWith(fetcher, localSource()),
    });

    // The worker reviewed the git-derived diff.
    const workerSource = await loadSameHeadReviewSource(worker(), workerApi().request, { gitDiffSource: localSource() });
    const workerFiles = parseChangedFiles(workerSource.diff).files;

    const context = await contextFor(trustedFetcher().fetcher)(gate);
    expect(context.coverage.coverageComplete).toBe(true);
    expect(context.coverage.changedFiles).toHaveLength(EXPECTED_FILES);
    expect(context.coverage.changedFiles).toEqual(workerFiles);

    const { attemptId: _, ...coordinates } = gate.coordinates;
    const expectedCoordinates = { ...coordinates, configDigest: stored.policy.effectiveConfigDigest };
    const lanes = context.coverage.expectedPersonaIds;
    expect(lanes.length).toBeGreaterThan(0);
    const completion = (findings: unknown[]) => ({ version: 'WorkerReviewCompletion.v1', ...expectedCoordinates,
      result: { version: 'WorkerReviewResult.v1', completedAt: '2026-09-23T18:00:00Z', coverageComplete: true,
        quorumSatisfied: true, personas: lanes.map((id) => ({ id, decision: findings.length ? 'FINDINGS' : 'APPROVE', findings })) } });
    const approved = deriveCanonicalWorkerReviewEvidence(completion([]), { ...context.coverage, expectedCoordinates });
    expect(approved.valid).toBe(true);
    expect(evaluateReviewGate({ candidate: gate.coordinates, current: context.current, evidence: approved.evidence }).status)
      .toBe('success');
    // A P2 on a line only the worker's git diff adds is accepted by the trusted side.
    const anchored = deriveCanonicalWorkerReviewEvidence(completion([{ severity: 'P2', path: 'src/new/added-14.ts',
      line: 10, title: 'Naming', body: 'The constant name is unclear.' }]), { ...context.coverage, expectedCoordinates });
    expect(anchored.valid).toBe(true);
    // A finding on the base-only file (a two-dot diff artifact) is refused.
    const baseOnly = deriveCanonicalWorkerReviewEvidence(completion([{ severity: 'P2', path: 'release/base-only.ts',
      line: 1, title: 'Naming', body: 'The constant name is unclear.' }]), { ...context.coverage, expectedCoordinates });
    expect(baseOnly.valid).toBe(false);

    // Mismatched head: the trusted side cancels instead of accepting the evidence.
    // Pull read 1 is currentCandidate; reads 2 and 3 bracket the git-derived diff.
    const moved = await contextFor(trustedFetcher({ finalHead: 'e'.repeat(40), movesOnPullRead: 3 }).fetcher)(gate);
    expect(moved.coverage).toMatchObject({ changedFiles: [], coverageComplete: false, quorumSatisfied: false });
    expect(moved.current.headSha).toBe('e'.repeat(40));
    expect(evaluateReviewGate({ candidate: gate.coordinates, current: moved.current }).status).not.toBe('success');
  }, 120_000);
});

it('fixture sanity: the synthetic repository exists', () => {
  expect(existsSync(remote)).toBe(true);
});
