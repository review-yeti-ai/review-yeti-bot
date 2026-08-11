import { describe, expect, it } from 'vitest';

const {
  buildDependencyEvidence,
  classifyDependencyPath,
  renderDependencyEvidence,
} = require('../../src/review/dependencyEvidence');

describe('dependency evidence extraction', () => {
  it('classifies common manifests and lockfiles without treating source files as dependency evidence', () => {
    expect(classifyDependencyPath('package.json')).toBe('manifest');
    expect(classifyDependencyPath('packages/api/package-lock.json')).toBe('lockfile');
    expect(classifyDependencyPath('mix.exs')).toBe('manifest');
    expect(classifyDependencyPath('lib/accounts/user.ex')).toBe(null);
  });

  it('extracts bounded changed dependency and provenance signals', () => {
    const result = buildDependencyEvidence([
      {
        path: 'package.json',
        patch: [
          '@@ -1,2 +1,5 @@',
          ' {',
          '+  "dependencies": {',
          '+    "example": "git+https://github.com/example/example.git#abc123",',
          '+    "integrity": "sha512-abc",',
          ' }',
        ].join('\n'),
      },
    ], [{ path: 'package.json', kind: 'manifest', reason: 'inspect the new source and integrity' }], { maxChars: 120 });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ path: 'package.json', kind: 'manifest', availability: 'available' });
    expect(result.entries[0].excerpt).toContain('git+https://github.com/example/example.git');
    expect(result.provenanceSignals).toEqual(expect.arrayContaining([
      expect.stringContaining('git+https://github.com/example/example.git'),
      expect.stringContaining('integrity'),
    ]));
    expect(result.totalChars).toBeLessThanOrEqual(120);
  });

  it('auto-classifies changed dependency files when no explicit request is supplied', () => {
    const result = buildDependencyEvidence([
      { path: 'package.json', patch: '@@ -1 +1 @@\n+{"dependencies":{"example":"1.0.0"}}' },
      { path: 'package-lock.json', patch: '@@ -1 +1 @@\n+{"lockfileVersion":3}' },
      { path: 'src/index.ts', patch: '@@ -1 +1 @@\n+export const value = 1;' },
    ]);

    expect(result.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'package.json', kind: 'manifest', availability: 'available' }),
      expect.objectContaining({ path: 'package-lock.json', kind: 'lockfile', availability: 'available' }),
    ]));
    expect(result.entries).toHaveLength(2);
  });

  it('uses only changed files and reports requested evidence that is unavailable', () => {
    const result = buildDependencyEvidence([
      { path: 'README.md', patch: '@@ -1 +1 @@\n+dependency docs' },
      { path: 'package.json', patch: '' },
    ], [
      { path: 'package-lock.json', kind: 'lockfile', reason: 'check the resolved version' },
      { path: '../secrets.txt', kind: 'other', reason: 'must not escape the change' },
    ]);

    expect(result.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'package-lock.json', availability: 'unavailable' }),
    ]));
    expect(result.unresolvedRequests.map((request: any) => request.path)).toContain('package-lock.json');
    expect(result.unresolvedRequests.map((request: any) => request.path)).not.toContain('../secrets.txt');
  });

  it('fails closed when a reviewer requests a rejected dependency evidence path', () => {
    const result = buildDependencyEvidence([
      { path: 'package.json', patch: '@@ -1 +1 @@\n+{"dependencies":{}}' },
    ], [{ path: 'README.md', kind: 'provenance', reason: 'inspect the dependency source' }]);

    expect(result.entries[0]).toMatchObject({
      path: 'README.md',
      availability: 'rejected',
    });
    expect(result.unresolvedRequests).toEqual([
      expect.objectContaining({ path: 'README.md' }),
    ]);
    expect(result.complete).toBe(false);
  });

  it('does not treat arbitrary changed source files as dependency provenance evidence', () => {
    const result = buildDependencyEvidence([
      { path: 'src/index.ts', patch: '@@ -1 +1 @@\n+const source = "https://example.invalid";' },
    ], [{ path: 'src/index.ts', kind: 'provenance', reason: 'inspect dependency provenance' }]);

    expect(result.entries[0].availability).toBe('rejected');
    expect(result.complete).toBe(false);
  });

  it('normalizes a bare string evidence request against the changed-file allowlist', () => {
    const result = buildDependencyEvidence([
      { path: 'package-lock.json', patch: '@@ -1 +1 @@\n+"lockfileVersion": 3' },
    ], ['package-lock.json']);

    expect(result.entries[0]).toMatchObject({ path: 'package-lock.json', kind: 'lockfile', availability: 'available' });
    expect(result.complete).toBe(true);
  });

  it('marks policy-excluded dependency files while exposing only a bounded excerpt', () => {
    const result = buildDependencyEvidence([
      { path: 'mix.lock', patch: '@@ -1 +1,4 @@\n+  "plug": {:hex, :plug, "1.15.0", "sha256-abc"}' },
    ], [{ path: 'mix.lock', kind: 'lockfile', reason: 'verify the resolved checksum' }], {
      excludedPaths: ['mix.lock'],
      maxChars: 200,
    });

    expect(result.entries[0]).toMatchObject({
      path: 'mix.lock',
      availability: 'available',
      policyExcluded: true,
    });
    expect(result.entries[0].excerpt).toContain('sha256-abc');
    expect(result.entries[0].excerpt.length).toBeLessThanOrEqual(200);
  });

  it('renders evidence and unresolved requests as bounded reviewer context', () => {
    const result = buildDependencyEvidence([
      { path: 'package.json', patch: '@@ -1 +1 @@\n+"example":"git+https://github.com/example/example.git#abc123"' },
    ], [{ path: 'package.json', kind: 'manifest', reason: 'inspect provenance' }, { path: 'package-lock.json', kind: 'lockfile', reason: 'inspect resolution' }], { maxChars: 120 });

    const rendered = renderDependencyEvidence(result, 240);
    expect(rendered).toContain('package.json');
    expect(rendered).toContain('unavailable');
    expect(rendered.length).toBeLessThanOrEqual(240);
  });
});
