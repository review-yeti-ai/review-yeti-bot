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
