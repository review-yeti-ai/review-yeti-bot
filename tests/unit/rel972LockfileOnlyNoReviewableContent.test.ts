import { describe, expect, it } from 'vitest';
import { resolveWorkerConfig } from '../../src/config/publishingWorkerConfig';
import { executeComposedReview } from '../../src/panel/composedEngine';
import { executePersonaPanel } from '../../src/panel/panelEngine';
import type { ReviewModelClient } from '../../src/gateway/openRouterClient';
import { filterDiffHunks } from '../../src/pipeline/hunkFilter';
import { parseChangedFiles } from '../../src/review/changedFiles';
import { resolveReviewApplicability } from '../../src/review/personaApplicability';
import { verifyLockfileOnlyChange } from '../../src/review/lockfileChangeVerification';

/**
 * REL-972: a pull request whose diff is only lockfiles or generated artifacts
 * (a Dependabot yarn.lock / package-lock.json / mix.lock bump) failed Review
 * Yeti on every attempt. The shared filter excludes those files from every
 * lane, so nothing was left to review and the shared applicability decision
 * failed closed as a persona coverage gap -- a permanently red required check
 * that no retry could fix.
 *
 * It is now the audited no-reviewable-content exemption, decided once in
 * resolveReviewApplicability and therefore identically by the panel engine, the
 * composed engine and the trusted completion context
 * (authoritativeCompletionContext.test.ts covers the service side). Because no
 * lane reads a lockfile, the exemption stands only on lockfile changes whose
 * added lines verifiably stay on the default public registries.
 */

const transport = { baseUrl: 'https://gateway.example.invalid/v1', apiKey: 'k', model: 'review-model' };
const roster = (personas = 'architecture,security') => resolveWorkerConfig({ REVIEW_PERSONAS: personas }, transport);
const enabled = (personas?: string) => roster(personas).personas.filter((persona) => persona.enabled);
const patch = '@@ -1 +1 @@\n-a\n+b\n';
const files = (...paths: string[]) => paths.map((path) => ({ path, patch }));

// Real-shaped Dependabot bumps.
const NPM_BUMP = [
  '@@ -10,9 +10,9 @@',
  '     "node_modules/lodash": {',
  '-      "version": "4.17.20",',
  '-      "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz",',
  '-      "integrity": "sha512-old"',
  '+      "version": "4.17.21",',
  '+      "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",',
  '+      "integrity": "sha512-new"',
  '     },',
  '     "node_modules/@babel/core": {',
  '-      "version": "7.0.0",',
  '+      "version": "7.1.0",',
  '+      "resolved": "https://registry.npmjs.org/@babel/core/-/core-7.1.0.tgz",',
  '+      "funding": { "type": "opencollective", "url": "https://opencollective.com/babel" },',
].join('\n');
const YARN_BUMP = [
  '@@ -1,6 +1,6 @@',
  ' "@types/node@^20.0.0":',
  '-  version "20.1.0"',
  '-  resolved "https://registry.yarnpkg.com/@types/node/-/node-20.1.0.tgz#abc"',
  '+  version "20.2.0"',
  '+  resolved "https://registry.yarnpkg.com/@types/node/-/node-20.2.0.tgz#def"',
  '   integrity sha512-x',
].join('\n');
const MIX_BUMP = [
  '@@ -1,2 +1,2 @@',
  '-  "jason": {:hex, :jason, "1.4.3", "aa", [:mix], [], "hexpm", "bb"},',
  '+  "jason": {:hex, :jason, "1.4.4", "cc", [:mix], [], "hexpm", "dd"},',
].join('\n');
const CARGO_BUMP = [
  '@@ -1,4 +1,4 @@',
  ' name = "serde"',
  '-version = "1.0.1"',
  '+version = "1.0.2"',
  ' source = "registry+https://github.com/rust-lang/crates.io-index"',
  '+checksum = "abc"',
].join('\n');

const lock = (path: string, body: string) => ({ path, patch: body });

// The exemption is decided from paths alone; reaching a model is a failure.
const unreachableClient = new Proxy({}, {
  get() { throw new Error('the model client must not be consulted'); },
}) as unknown as ReviewModelClient;

describe('REL-972: lockfile change verification', () => {
  it.each([
    ['package-lock.json', NPM_BUMP],
    ['web/yarn.lock', YARN_BUMP],
    ['mix.lock', MIX_BUMP],
    ['Cargo.lock', CARGO_BUMP],
  ])('verifies a default-registry bump of %s', (path, body) => {
    expect(verifyLockfileOnlyChange(path, body)).toEqual({ ok: true });
  });

  it.each([
    ['a tarball redirected off the registry', 'package-lock.json',
      NPM_BUMP.replace('https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz', 'https://evil.example/lodash-4.17.21.tgz'),
      'adds a URL outside the default public registries'],
    ['a look-alike registry host', 'package-lock.json',
      NPM_BUMP.replaceAll('https://registry.npmjs.org/lodash/', 'https://registry.npmjs.org.evil.example/lodash/'),
      'adds a URL outside the default public registries'],
    ['an entry pointed at a different package on the registry', 'package-lock.json',
      NPM_BUMP.replace('registry.npmjs.org/lodash/-/lodash-4.17.21.tgz', 'registry.npmjs.org/lodash-evil/-/lodash-evil-4.17.21.tgz'),
      'resolves an entry to a different package'],
    ['a scoped entry pointed at another scope', 'yarn.lock',
      YARN_BUMP.replace('/@types/node/-/node-20.2.0.tgz', '/@evil/node/-/node-20.2.0.tgz'),
      'resolves an entry to a different package'],
    ['a git dependency', 'package-lock.json',
      '@@ -1 +1 @@\n     "node_modules/x": {\n+      "resolved": "git+ssh://git@github.com/evil/x.git#abc",',
      'adds a non-registry dependency source'],
    ['a local file dependency', 'package-lock.json',
      '@@ -1 +1 @@\n     "node_modules/x": {\n+      "resolved": "file:../x",',
      'adds a non-registry dependency source'],
    ['a non-URL resolution', 'package-lock.json',
      '@@ -1 +1 @@\n     "node_modules/x": {\n+      "resolved": "packages/x",',
      'resolves an entry outside a registry'],
    ['a mix git dependency', 'mix.lock',
      '@@ -1 +1 @@\n+  "x": {:git, "https://github.com/evil/x.git", "abc", []},',
      'adds a URL outside the default public registries'],
    ['a cargo git source', 'Cargo.lock',
      '@@ -1 +1 @@\n+source = "git+https://github.com/evil/x#abc"',
      'adds a non-registry dependency source'],
    ['a missing patch (GitHub omits very large diffs)', 'package-lock.json', undefined, 'no patch to verify'],
    ['a submodule gitlink at a lockfile path', 'vendor/yarn.lock',
      'index 6c3f36d89d..f84610fbbf 160000\n@@ -1 +1 @@\n-Subproject commit 6c3f36d89d675d27c0a8b88f684d57c6185a7e6b\n+Subproject commit f84610fbbf478540b07861fa7a18174126ffe5bb\n',
      'is a submodule gitlink'],
    ['a non-lockfile', 'assets/app.min.js', '@@ -1 +1 @@\n+x', 'not a lockfile'],
  ])('refuses %s', (_label, path, body, reason) => {
    expect(verifyLockfileOnlyChange(path, body)).toEqual({ ok: false, reason });
  });
});

describe('REL-972: shared decision for lockfile-only diffs', () => {
  it.each([
    [[lock('package-lock.json', NPM_BUMP)]],
    [[lock('yarn.lock', YARN_BUMP)]],
    [[lock('mix.lock', MIX_BUMP)]],
    [[lock('services/api/Cargo.lock', CARGO_BUMP), lock('web/package-lock.json', NPM_BUMP)]],
  ])('exempts %j as no reviewable content', (changed) => {
    const result = resolveReviewApplicability(enabled(), changed);

    expect(result.applicable).toEqual([]);
    expect(result.effectiveFiles).toEqual([]);
    expect(result.noReviewableContent).toBe(true);
    expect(result.noReviewableContentKind).toBe('lockfile-only');
    expect(result.unmatchedPaths).toEqual([]);
    expect(result.unverifiedLockfiles).toEqual([]);
    for (const file of changed) expect(result.noReviewableContentRationale).toContain(file.path);
  });

  it('lists the excluded files and why in one published line', () => {
    const result = resolveReviewApplicability(enabled(), [lock('yarn.lock', YARN_BUMP), lock('mix.lock', MIX_BUMP)]);

    expect(result.noReviewableContentRationale).toBe(
      'No reviewable content: every changed file is a dependency lockfile, which the review filter '
      + 'excludes from every lane, and every added source resolves to a default public registry. '
      + 'Excluded: yarn.lock, mix.lock. '
      + 'A manifest or source change in the same diff would be reviewed.',
    );
    expect(result.noReviewableContentRationale).not.toMatch(/[\r\n]/u);
  });

  it('bounds the listed files for a very large monorepo bump', () => {
    const changed = Array.from({ length: 30 }, (_, index) => lock(`pkg${index}/mix.lock`, MIX_BUMP));
    const result = resolveReviewApplicability(enabled(), changed);

    expect(result.noReviewableContent).toBe(true);
    expect(result.noReviewableContentRationale).toContain('pkg7/mix.lock');
    expect(result.noReviewableContentRationale).not.toContain('pkg8/mix.lock');
    expect(result.noReviewableContentRationale).toContain('+22 more');
  });

  it('fails an unverifiable lockfile-only diff closed and says why', () => {
    const redirected = NPM_BUMP.replace('https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz', 'https://evil.example/l.tgz');
    const result = resolveReviewApplicability(enabled(), [lock('package-lock.json', redirected), lock('mix.lock', MIX_BUMP)]);

    expect(result.noReviewableContent).toBe(false);
    expect(result.noReviewableContentKind).toBeNull();
    expect(result.unmatchedPaths).toEqual(['package-lock.json']);
    expect(result.unverifiedLockfiles).toEqual([
      { path: 'package-lock.json', reason: 'adds a URL outside the default public registries' },
    ]);
  });

  it('keeps the documentation exemption, but not over an unverifiable lockfile', () => {
    const verified = resolveReviewApplicability(enabled(), [lock('docs/guide.md', patch), lock('yarn.lock', YARN_BUMP)]);
    expect(verified.noReviewableContent).toBe(true);
    expect(verified.noReviewableContentKind).toBe('documentation');

    const unverified = resolveReviewApplicability(enabled(), [lock('docs/guide.md', patch), lock('yarn.lock', patch.replace('+b', '+  resolved "https://evil.example/x.tgz"'))]);
    expect(unverified.noReviewableContent).toBe(false);
    expect(unverified.unmatchedPaths).toEqual(['yarn.lock']);
  });

  // Security posture: each of these must be reviewed or fail closed exactly as
  // before. Pinning the new fields alongside keeps every case asserting the
  // decision, not merely the absence of a flag.
  it('reviews a manifest changed beside its lockfile -- that is not lockfile-only', () => {
    const result = resolveReviewApplicability(enabled(), [lock('package.json', patch), lock('package-lock.json', NPM_BUMP)]);

    expect(result.noReviewableContent).toBe(false);
    expect(result.noReviewableContentKind).toBeNull();
    expect(result.applicable.map((persona) => persona.id)).toEqual(['arch-lane', 'sec-lane']);
    expect(result.effectiveFiles.map((file) => file.path)).toEqual(['package.json']);
  });

  it.each([
    ['uncovered source beside a lockfile', [lock('src/main.lua', patch), lock('yarn.lock', YARN_BUMP)], ['src/main.lua']],
    ['a generated artifact (content no lane reads)', [lock('assets/app.min.js', patch)], []],
    ['a generated artifact beside a lockfile', [lock('proto/review.pb.go', patch), lock('yarn.lock', YARN_BUMP)], []],
    ['a file only located under a build output directory', [lock('dist/bundle.js', patch)], []],
  ])('fails %s closed', (_label, changed, unmatched) => {
    const result = resolveReviewApplicability(enabled(), changed);

    expect(result.applicable).toEqual([]);
    expect(result.noReviewableContent).toBe(false);
    expect(result.noReviewableContentKind).toBeNull();
    expect(result.noReviewableContentRationale).toBeNull();
    expect(result.unmatchedPaths).toEqual(unmatched);
  });

  it('does not exempt a lockfile diff that also carries a path_filters-excluded source file', () => {
    const result = resolveReviewApplicability(enabled(), [lock('vendor/client.lua', patch), lock('yarn.lock', YARN_BUMP)], {
      pathFilters: ['vendor/**'],
    });

    expect(result.effectiveFiles).toEqual([]);
    expect(result.noReviewableContent).toBe(false);
    expect(result.noReviewableContentKind).toBeNull();
  });

  it('does not exempt a submodule gitlink whose path looks like a lockfile', () => {
    const diff = 'diff --git a/vendor/yarn.lock b/vendor/yarn.lock\n'
      + 'index 6c3f36d89d..f84610fbbf 160000\n--- a/vendor/yarn.lock\n+++ b/vendor/yarn.lock\n'
      + '@@ -1 +1 @@\n-Subproject commit 6c3f36d89d675d27c0a8b88f684d57c6185a7e6b\n'
      + '+Subproject commit f84610fbbf478540b07861fa7a18174126ffe5bb\n';
    const result = resolveReviewApplicability(enabled('security,testing'), parseChangedFiles(diff).files);

    expect(result.noReviewableContent).toBe(false);
    expect(result.unverifiedLockfiles.map((file) => file.path)).toEqual(['vendor/yarn.lock']);
  });

  it('leaves the shared hunk filter classification unchanged', () => {
    const result = filterDiffHunks(files('yarn.lock', 'a.min.js', 'dist/x.js', 'src/a.ts'));
    expect(result.files.map((file) => [file.path, file.status, file.ignoreReason ?? null])).toEqual([
      ['yarn.lock', 'ignored', 'Lockfile noise excluded from review context'],
      ['a.min.js', 'ignored', 'Generated / compiled asset excluded'],
      ['dist/x.js', 'ignored', 'Generated / compiled asset excluded'],
      ['src/a.ts', 'included', null],
    ]);
  });
});

describe('REL-972: every engine takes the same outcome', () => {
  it('the panel engine (mode=panel, production) publishes an audited pass without a model call', async () => {
    const result = await executePersonaPanel({
      config: roster(),
      changedFiles: [lock('yarn.lock', YARN_BUMP)],
      repository: 'calltelemetry/ct-quasar',
      headSha: 'a'.repeat(40),
      client: unreachableClient,
      deterministicRoster: true,
    });

    expect(result.arbiter.verdict).toBe('SHIP');
    expect(result.documentationOnly).toBe(true);
    expect(result.noReviewableContentKind).toBe('lockfile-only');
    expect(result.applicablePersonaIds).toEqual([]);
    expect(result.personas.map((lane) => [lane.id, lane.decision])).toEqual([['documentation-only', 'APPROVE']]);
    expect(result.arbiter.rationale).toContain('Excluded: yarn.lock.');
  });

  it('the composed engine takes the identical outcome', async () => {
    const result = await executeComposedReview({
      config: roster(),
      changedFiles: [lock('mix.lock', MIX_BUMP)],
      repository: 'calltelemetry/cisco-cdr',
      headSha: 'b'.repeat(40),
      client: unreachableClient,
    });

    expect(result.arbiter.verdict).toBe('SHIP');
    expect(result.documentationOnly).toBe(true);
    expect(result.noReviewableContentKind).toBe('lockfile-only');
    expect(result.arbiter.rationale).toContain('Excluded: mix.lock.');
  });

  it('both engines still fail a manifest-bearing diff they cannot cover closed', async () => {
    const config = roster('testing');
    const changedFiles = [lock('package.json', patch), lock('package-lock.json', NPM_BUMP)];
    expect(resolveReviewApplicability(config.personas.filter((p) => p.enabled), changedFiles).applicable).toEqual([]);

    await expect(executePersonaPanel({
      config, changedFiles, repository: 'r/r', headSha: 'c'.repeat(40), client: unreachableClient, deterministicRoster: true,
    })).rejects.toThrow(/no enabled persona applies.*package\.json/);
    await expect(executeComposedReview({
      config, changedFiles, repository: 'r/r', headSha: 'c'.repeat(40), client: unreachableClient,
    })).rejects.toThrow(/no enabled persona applies.*package\.json/);
  });

  it('both engines fail an unverifiable lockfile bump closed, naming the reason', async () => {
    const changedFiles = [lock('yarn.lock', YARN_BUMP.replace('https://registry.yarnpkg.com/@types/node/-/node-20.2.0.tgz', 'https://evil.example/n.tgz'))];
    const message = /no enabled persona applies.*yarn\.lock.*not verifiable.*outside the default public registries/;
    await expect(executePersonaPanel({
      config: roster(), changedFiles, repository: 'r/r', headSha: 'd'.repeat(40), client: unreachableClient, deterministicRoster: true,
    })).rejects.toThrow(message);
    await expect(executeComposedReview({
      config: roster(), changedFiles, repository: 'r/r', headSha: 'd'.repeat(40), client: unreachableClient,
    })).rejects.toThrow(message);
  });
});
