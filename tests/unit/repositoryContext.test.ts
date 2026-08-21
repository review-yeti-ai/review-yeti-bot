import { describe, expect, it } from 'vitest';
import { ContextRetriever } from '../../src/indexer/contextRetriever';
import { RepositoryIndex, StaleRepositoryIndexError } from '../../src/indexer/repositoryIndex';
import { RepositoryContext } from '../../src/review/repositoryContext';
import { createPRSnapshot } from '../../src/review/prSnapshot';

const snapshot = createPRSnapshot({
  owner: 'calltelemetry', repo: 'ct-review-bot', prNumber: 42, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40),
  configRef: 'main:.review.yml', configDigest: 'c'.repeat(64), engineVersion: 'test', changedFiles: [{ path: 'packages/api/src/handler.ts', patch: '@@ -1 +1 @@' }],
});

const files = [{ path: 'packages/api/src/handler.ts', content: 'export function handler() {\n  return 1;\n}\n' }, { path: 'packages/api/src/other.ts', content: 'export function helper() { return 2; }\n' }];

describe('immutable repository context', () => {
  it('creates stable epochs and rejects stale commit retrieval', () => {
    const index = new RepositoryIndex();
    const first = index.build({ owner: snapshot.owner, repo: snapshot.repo, commitSha: snapshot.headSha, files });
    expect(index.build({ owner: snapshot.owner, repo: snapshot.repo, commitSha: snapshot.headSha, files }).epoch).toBe(first.epoch);
    expect(() => new ContextRetriever(index).retrieve({ owner: snapshot.owner, repo: snapshot.repo, commitSha: 'd'.repeat(40), indexEpoch: first.epoch, text: 'handler' })).toThrow(StaleRepositoryIndexError);
  });

  it('returns exact commit-bound citation ranges and package ownership', () => {
    const index = new RepositoryIndex();
    const context = new RepositoryContext(index).resolve({ snapshot, files, policy: { mode: 'metadata_only', require_pinned_commit: true, packageRoots: ['packages'], codeowners: 'packages/api/** @api-team' } });
    expect(context.changedSymbols[0]).toMatchObject({ path: 'packages/api/src/handler.ts', startLine: 1, endLine: 3, commitSha: snapshot.headSha, indexEpoch: context.index.epoch });
    expect(context.packageOwners['packages']).toEqual(['@api-team']);
  });

  it('matches CODEOWNERS leading slashes and zero-depth double-star globs', () => {
    const index = new RepositoryIndex();
    const context = new RepositoryContext(index).resolve({
      snapshot: createPRSnapshot({ ...snapshot, changedFiles: [{ path: 'src/main.ts', patch: '@@ -1 +1 @@' }] }),
      files,
      policy: { mode: 'metadata_only', require_pinned_commit: true, packageRoots: ['packages'], codeowners: '/src/**/*.ts @src-team' },
    });
    expect(context.packageOwners['src']).toEqual(['@src-team']);
  });

  it('fails closed for recursive submodule content that is not resolved', () => {
    const index = new RepositoryIndex();
    const result = new RepositoryContext(index).resolve({ snapshot: createPRSnapshot({ ...snapshot, changedFiles: [{ path: 'vendor/lib', mode: '160000', oldSha: 'd'.repeat(40), newSha: 'e'.repeat(40), isSubmodule: true }] }), files: [], policy: { mode: 'recursive', require_pinned_commit: true } });
    expect(result.submodules[0].decision).toBe('INCOMPLETE_REVIEW');
    expect(result.incompleteReasons.length).toBeGreaterThan(0);
  });
});
