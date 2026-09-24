import { describe, it, expect, vi } from 'vitest';
import { createPathMatcher, isGlobQuery, normalizeRepoPath, FIND_FILES_TOOL_GUIDE, MAX_PATH_QUERY_CHARS } from '../../src/panel/pathMatch';
import { createRepoFileProvider } from '../../src/panel/repoFileProvider';
import { runReadOnlyTool } from '../../src/panel/toolRuntime';
import type { GitHubInstallationClient } from '../../src/github/installationClient';

/**
 * REL-1102. On #1030 a reviewer model called find_files with `tests/fixtures/jev/*` and
 * `**\/*.json`. The tool matched those queries as literal substrings, found nothing, and the
 * model filed a BLOCKING "fixture file missing" finding for a JSON fixture that was committed
 * and read by CI. These tests go through the real matcher, the real provider (over a stub
 * GitHub tree), and the real tool runtime.
 *
 * Negative proof: if `createPathMatcher` goes back to substring-only matching
 * (`path.toLowerCase().includes(needle)`), every "glob" test below fails, while the
 * "substring still works" tests still pass.
 */

const TREE = [
  'package.json',
  '.github/workflows/ci.yml',
  'config/app.yaml',
  'src/gateway/jevClient.ts',
  'src/gateway/__tests__/jevClient.test.ts',
  'tests/fixtures/jev/live-score.json',
  'tests/fixtures/jev/legend-object.json',
  'tests/fixtures/jev/README.md',
  'tests/fixtures/jev/nested/deep.json',
  'tests/fixtures/other/x.json',
  'app/[id]/page.tsx',
];

function stubGitHub(tree: string[], truncated = false, content: Record<string, string> = {}) {
  return {
    getFileTree: vi.fn(async () => ({ paths: tree, truncated })),
    getFileContent: vi.fn(async (_o: string, _r: string, path: string) => content[path] ?? null),
  } as unknown as GitHubInstallationClient;
}

const match = (query: string) => TREE.filter((p) => createPathMatcher(query)(p));

describe('createPathMatcher (REL-1102)', () => {
  it('#1030: tests/fixtures/jev/*.json finds the committed JSON fixtures', () => {
    expect(match('tests/fixtures/jev/*.json')).toEqual([
      'tests/fixtures/jev/live-score.json',
      'tests/fixtures/jev/legend-object.json',
    ]);
  });

  it('#1030: tests/fixtures/jev/* lists that directory, and * does not cross /', () => {
    expect(match('tests/fixtures/jev/*')).toEqual([
      'tests/fixtures/jev/live-score.json',
      'tests/fixtures/jev/legend-object.json',
      'tests/fixtures/jev/README.md',
    ]);
  });

  it('** crosses directories', () => {
    expect(match('**/*.json')).toEqual([
      'package.json',
      'tests/fixtures/jev/live-score.json',
      'tests/fixtures/jev/legend-object.json',
      'tests/fixtures/jev/nested/deep.json',
      'tests/fixtures/other/x.json',
    ]);
    expect(match('tests/fixtures/**/*.json')).toContain('tests/fixtures/jev/nested/deep.json');
    expect(match('tests/**/deep.json')).toEqual(['tests/fixtures/jev/nested/deep.json']);
  });

  it('{a,b} braces are alternatives', () => {
    expect(match('**/*.{yml,yaml}')).toEqual(['.github/workflows/ci.yml', 'config/app.yaml']);
    expect(match('tests/fixtures/{jev,other}/*.json')).toEqual([
      'tests/fixtures/jev/live-score.json',
      'tests/fixtures/jev/legend-object.json',
      'tests/fixtures/other/x.json',
    ]);
  });

  it('? matches exactly one character', () => {
    expect(match('tests/fixtures/other/?.json')).toEqual(['tests/fixtures/other/x.json']);
    expect(match('tests/fixtures/other/??.json')).toEqual([]);
  });

  it('a glob without / matches file names at any depth, and dotfiles are included', () => {
    expect(match('*.yml')).toEqual(['.github/workflows/ci.yml']);
    expect(match('live-*.json')).toEqual(['tests/fixtures/jev/live-score.json']);
  });

  it('a glob with / also matches as a suffix at any depth', () => {
    expect(match('fixtures/jev/*.json')).toEqual([
      'tests/fixtures/jev/live-score.json',
      'tests/fixtures/jev/legend-object.json',
    ]);
  });

  it('globs are case-insensitive and ignore a leading ./ or /', () => {
    expect(match('./TESTS/fixtures/jev/*.JSON')).toHaveLength(2);
    expect(match('/tests/fixtures/jev/*.json')).toHaveLength(2);
  });

  it('plain substring search still works (case-insensitive)', () => {
    expect(match('jevclient')).toEqual(['src/gateway/jevClient.ts', 'src/gateway/__tests__/jevClient.test.ts']);
    expect(match('fixtures/jev')).toHaveLength(4);
    expect(createPathMatcher('jev').mode).toBe('substring');
  });

  it('a literal path with glob characters still matches itself (Next.js dynamic routes)', () => {
    expect(match('app/[id]/page.tsx')).toEqual(['app/[id]/page.tsx']);
  });

  it('a glob that matches nothing returns nothing', () => {
    expect(match('tests/fixtures/jev/*.yaml')).toEqual([]);
  });

  it('never throws on malformed or oversized patterns', () => {
    for (const q of ['[', '{', '{a,', '***', '\\', '!(', 'a'.repeat(MAX_PATH_QUERY_CHARS * 4) + '*']) {
      expect(() => TREE.filter((p) => createPathMatcher(q)(p))).not.toThrow();
    }
  });

  it('isGlobQuery and normalizeRepoPath', () => {
    expect(isGlobQuery('a/*.json')).toBe(true);
    expect(isGlobQuery('a/{b,c}')).toBe(true);
    expect(isGlobQuery('a/b.json')).toBe(false);
    expect(normalizeRepoPath('./a/b')).toBe('a/b');
    expect(normalizeRepoPath('/a/b')).toBe('a/b');
  });
});

describe('find_files through the real provider and tool runtime (REL-1102)', () => {
  const changedFiles = [{ path: 'src/gateway/jevClient.ts', patch: '+x' }];

  it('#1030: finds the committed fixture that is not in the diff, marked exhaustive', async () => {
    const repoFileProvider = createRepoFileProvider(stubGitHub(TREE), 'o', 'r', 'sha');
    const res = await runReadOnlyTool('find_files', { query: 'tests/fixtures/jev/*.json' }, { changedFiles, repoFileProvider });
    expect(res.toolOutput).toContain('tests/fixtures/jev/live-score.json');
    expect(res.toolOutput).toContain('glob match');
    expect(res.toolOutput).not.toMatch(/no files matching/i);
    expect(res.toolScope).toBe('full-repository');
    expect(res.isExhaustive).toBe(true);
  });

  it('a diff hit no longer hides matching files outside the diff', async () => {
    const repoFileProvider = createRepoFileProvider(stubGitHub(TREE), 'o', 'r', 'sha');
    const res = await runReadOnlyTool('find_files', { query: 'jev' }, { changedFiles, repoFileProvider });
    expect(res.toolOutput).toContain('src/gateway/jevClient.ts');
    expect(res.toolOutput).toContain('tests/fixtures/jev/live-score.json');
  });

  it('substring search through the tool still works', async () => {
    const repoFileProvider = createRepoFileProvider(stubGitHub(TREE), 'o', 'r', 'sha');
    const res = await runReadOnlyTool('find_files', { query: 'legend-object' }, { changedFiles, repoFileProvider });
    expect(res.toolOutput).toContain('Found 1 path(s)');
    expect(res.toolOutput).toContain('tests/fixtures/jev/legend-object.json');
    expect(res.toolOutput).toContain('substring match');
  });

  it('a zero-hit search over a truncated tree says so and is not exhaustive', async () => {
    const repoFileProvider = createRepoFileProvider(stubGitHub(['src/a.ts'], true), 'o', 'r', 'sha');
    const res = await runReadOnlyTool('find_files', { query: 'tests/fixtures/jev/*.json' }, { changedFiles, repoFileProvider });
    expect(res.isExhaustive).toBe(false);
    expect(res.toolOutput).toContain('truncated by GitHub');
    expect(res.toolOutput).toContain('may still exist');
    expect(res.toolOutput).toContain('Do not report it as missing');
    expect(res.toolOutput).not.toContain('found anywhere in the repository');
  });

  it('hits over a truncated tree carry the incomplete-list warning', async () => {
    const repoFileProvider = createRepoFileProvider(stubGitHub(TREE, true), 'o', 'r', 'sha');
    const res = await runReadOnlyTool('find_files', { query: '**/*.json' }, { changedFiles, repoFileProvider });
    expect(res.isExhaustive).toBe(false);
    expect(res.toolOutput).toContain('TRUNCATED');
  });

  it('a complete tree with no match still reports a genuine absence', async () => {
    const repoFileProvider = createRepoFileProvider(stubGitHub(TREE), 'o', 'r', 'sha');
    const res = await runReadOnlyTool('find_files', { query: 'tests/fixtures/jev/*.yaml' }, { changedFiles, repoFileProvider });
    expect(res.isExhaustive).toBe(true);
    expect(res.toolOutput).toContain('found anywhere in the repository at the reviewed head');
  });

  it('without a provider, a diff-only glob hit says other files may exist elsewhere', async () => {
    const res = await runReadOnlyTool('find_files', { query: 'src/**/*.ts' }, { changedFiles });
    expect(res.toolOutput).toContain('Files found in diff: src/gateway/jevClient.ts');
    expect(res.toolOutput).toContain('may still exist elsewhere');
    expect(res.isExhaustive).toBe(false);
  });
});

describe('read_file on the fixture path class (REL-1102)', () => {
  const changedFiles = [{ path: 'src/gateway/jevClient.ts', patch: '+x' }];
  const fixture = 'tests/fixtures/jev/live-score.json';

  it('reads a committed JSON fixture outside the diff, including with a ./ prefix', async () => {
    const github = stubGitHub(TREE, false, { [fixture]: '{"score": 1.4}' });
    const repoFileProvider = createRepoFileProvider(github, 'o', 'r', 'sha');
    for (const path of [fixture, `./${fixture}`, `/${fixture}`]) {
      const res = await runReadOnlyTool('read_file', { path }, { changedFiles, repoFileProvider });
      expect(res.toolOutput).toContain('{"score": 1.4}');
      expect(res.isExhaustive).toBe(true);
    }
  });

  it('a glob passed to read_file lists the matches instead of claiming absence', async () => {
    const repoFileProvider = createRepoFileProvider(stubGitHub(TREE), 'o', 'r', 'sha');
    const res = await runReadOnlyTool('read_file', { path: 'tests/fixtures/jev/*.json' }, { changedFiles, repoFileProvider });
    expect(res.toolOutput).not.toContain('does not exist');
    expect(res.toolOutput).toContain('is a pattern');
    expect(res.toolOutput).toContain(fixture);
  });

  it('a directory passed to read_file lists its files instead of claiming absence', async () => {
    const repoFileProvider = createRepoFileProvider(stubGitHub(TREE), 'o', 'r', 'sha');
    const res = await runReadOnlyTool('read_file', { path: 'tests/fixtures/jev' }, { changedFiles, repoFileProvider });
    expect(res.toolOutput).not.toContain('does not exist');
    expect(res.toolOutput).toContain('is a directory');
    expect(res.toolOutput).toContain(fixture);
  });

  it('a file in the tree whose content the API did not inline is reported as existing', async () => {
    const repoFileProvider = createRepoFileProvider(stubGitHub(TREE), 'o', 'r', 'sha');
    const res = await runReadOnlyTool('read_file', { path: fixture }, { changedFiles, repoFileProvider });
    expect(res.toolOutput).toContain('EXISTS in the repository tree');
    expect(res.toolOutput).not.toContain('does not exist');
    expect(res.isExhaustive).toBe(false);
  });

  it('a path missing from a truncated tree is not reported as proven absent', async () => {
    const repoFileProvider = createRepoFileProvider(stubGitHub(['src/a.ts'], true), 'o', 'r', 'sha');
    const res = await runReadOnlyTool('read_file', { path: fixture }, { changedFiles, repoFileProvider });
    expect(res.isExhaustive).toBe(false);
    expect(res.toolOutput).toContain('truncated');
    expect(res.toolOutput).not.toContain('does not exist');
  });

  it('a path missing from a complete tree is still reported as absent', async () => {
    const repoFileProvider = createRepoFileProvider(stubGitHub(TREE), 'o', 'r', 'sha');
    const res = await runReadOnlyTool('read_file', { path: 'tests/fixtures/jev/gone.json' }, { changedFiles, repoFileProvider });
    expect(res.isExhaustive).toBe(true);
    expect(res.toolOutput).toContain('does not exist in the repository at the reviewed head');
  });
});

describe('find_files tool guidance (REL-1102)', () => {
  it('tells the model about globs and that a truncated or diff-scoped zero-hit is not absence', () => {
    expect(FIND_FILES_TOOL_GUIDE).toContain('**');
    expect(FIND_FILES_TOOL_GUIDE).toContain('{a,b}');
    expect(FIND_FILES_TOOL_GUIDE).toMatch(/truncated/);
    expect(FIND_FILES_TOOL_GUIDE).toMatch(/do not report it as missing/i);
    expect(FIND_FILES_TOOL_GUIDE).toMatch(/JSON\/YAML fixtures/);
  });
});
