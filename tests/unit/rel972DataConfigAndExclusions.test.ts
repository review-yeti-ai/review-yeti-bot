import { describe, expect, it } from 'vitest';
import { resolveWorkerConfig } from '../../src/config/publishingWorkerConfig';
import { executeComposedReview } from '../../src/panel/composedEngine';
import { executePersonaPanel, personaCoverageError } from '../../src/panel/panelEngine';
import type { ReviewModelClient } from '../../src/gateway/openRouterClient';
import { resolveReviewApplicability, scopeFilesForPersona } from '../../src/review/personaApplicability';
import { isDataOrConfigPath, isNoReviewableContentFile } from '../../src/review/reviewableContent';

/**
 * REL-972, the two cases #993 left open.
 *
 * (1) calltelemetry/ct-meta: a PR whose only change was one line in
 *     plugins/ct-lab/skills/lab-inventory/inventory/lab-assets.json failed
 *     every review with "no enabled persona applies to the changed paths",
 *     because no enabled persona's paths named that data file. Data and config
 *     change behaviour, so an uncovered data/config file is now routed to the
 *     roster's required lane (as .mdx pages and gitlinks already are), not
 *     exempted. Uncovered SOURCE still fails closed.
 *
 * (2) Docs + a generated file, or docs + a path_filters exclusion: the worker
 *     judged the post-filter files, saw only docs and passed the diff as
 *     documentation-only; the trusted completion side judged the raw files and
 *     refused that result, so a finished review could not be acknowledged
 *     (REL-1056). The generated/excluded file is read by no lane, so the correct
 *     answer is the refusal: such a diff is not documentation-only.
 */

const transport = { baseUrl: 'https://gateway.example.invalid/v1', apiKey: 'k', model: 'review-model' };
const roster = (personas: string) => resolveWorkerConfig({ REVIEW_PERSONAS: personas }, transport);
const enabled = (personas: string) => roster(personas).personas.filter((persona) => persona.enabled);
const patch = '@@ -1 +1 @@\n-a\n+b\n';
const files = (...paths: string[]) => paths.map((path) => ({ path, patch }));

const LAB_ASSETS = 'plugins/ct-lab/skills/lab-inventory/inventory/lab-assets.json';

/**
 * A roster shaped like ct-meta's: security (required) and architecture lanes
 * whose paths name source only, so no persona covers the inventory JSON.
 */
function sourceOnlyRoster() {
  return enabled('architecture,security').map((persona) => ({
    ...persona,
    paths: persona.id === 'sec-lane' ? ['**/*.ts', '**/*.ex', '**/*.exs'] : ['src/**', 'lib/**'],
  }));
}

const unreachableClient = new Proxy({}, {
  get() { throw new Error('the model client must not be consulted'); },
}) as unknown as ReviewModelClient;

describe('REL-972 (1): uncovered data/config files are routed to a lane', () => {
  it('routes the one-line lab-assets.json change to the required lane instead of failing', () => {
    const personas = sourceOnlyRoster();
    const result = resolveReviewApplicability(personas, files(LAB_ASSETS));

    expect(result.applicable.map((persona) => persona.id)).toEqual(['sec-lane']);
    expect(result.noReviewableContent).toBe(false);
    expect(result.unmatchedPaths).toEqual([]);
    // The routed lane actually receives the file to review.
    expect(scopeFilesForPersona(result.applicable[0], result.effectiveFiles).map((file) => file.path))
      .toEqual([LAB_ASSETS]);
  });

  it.each([
    'config/app.toml',
    'data/assets.csv',
    'inventory/hosts.yaml',
    'deploy/values.yml',
    'schema/review.xml',
    'etc/service.ini',
    'app/settings.properties',
    'fixtures/rows.ndjson',
  ])('routes an uncovered %s to the required lane', (path) => {
    const result = resolveReviewApplicability(sourceOnlyRoster(), files(path));
    expect(result.applicable.map((persona) => persona.id)).toEqual(['sec-lane']);
    expect(result.unmatchedPaths).toEqual([]);
  });

  it('keeps the exact ct-meta roster case covered natively and routes formats the index lacks', () => {
    // Since REL-967 (#863) the builtin architecture + security paths name
    // **/*.json, so the reported file is covered without routing. TOML and CSV
    // are in no builtin path list: before this change they failed closed.
    const native = resolveReviewApplicability(enabled('architecture,security'), files(LAB_ASSETS));
    expect(native.applicable.map((persona) => persona.id)).toEqual(['arch-lane', 'sec-lane']);
    expect(native.applicable.some((persona) => 'routedPaths' in persona)).toBe(false);

    const routed = resolveReviewApplicability(enabled('architecture,security'), files('inventory/lab.toml', 'inventory/hosts.csv'));
    expect(routed.applicable.map((persona) => [persona.id, persona.routedPaths])).toEqual([
      ['sec-lane', ['inventory/lab.toml', 'inventory/hosts.csv']],
    ]);
    expect(routed.unmatchedPaths).toEqual([]);
  });

  it('routes to the first enabled persona when none is required', () => {
    const personas = sourceOnlyRoster().map((persona) => ({ ...persona, required: false }));
    const result = resolveReviewApplicability(personas, files(LAB_ASSETS));
    expect(result.applicable.map((persona) => persona.id)).toEqual(['arch-lane']);
  });

  it('keeps uncovered source a coverage failure, alone or beside routed data', () => {
    for (const changed of [files('tools/inventory.lua'), files(LAB_ASSETS, 'tools/inventory.lua')]) {
      const result = resolveReviewApplicability(sourceOnlyRoster(), changed);
      expect(result.applicable).toEqual([]);
      expect(result.noReviewableContent).toBe(false);
      expect(result.unmatchedPaths).toEqual(['tools/inventory.lua']);
    }
  });

  it('does not widen a roster whose persona already covers the data file', () => {
    const personas = sourceOnlyRoster().map((persona) => (persona.id === 'arch-lane'
      ? { ...persona, paths: [...persona.paths, 'plugins/**'] } : persona));
    const result = resolveReviewApplicability(personas, files(LAB_ASSETS));
    expect(result.applicable.map((persona) => persona.id)).toEqual(['arch-lane']);
    expect(result.applicable[0]).not.toHaveProperty('routedPaths');
  });

  it('leaves run artifacts, lockfiles and prose on their existing exemptions', () => {
    expect(resolveReviewApplicability(sourceOnlyRoster(), files('runs/2026-09-23/result.json')).noReviewableContentKind)
      .toBe('documentation');
    expect(resolveReviewApplicability(sourceOnlyRoster(), files('docs/guide.md')).noReviewableContentKind)
      .toBe('documentation');
    const lockBump = [{ path: 'package-lock.json', patch: [
      '@@ -1,3 +1,3 @@',
      '     "node_modules/lodash": {',
      '-      "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz",',
      '+      "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",',
    ].join('\n') }];
    const lock = resolveReviewApplicability(sourceOnlyRoster(), lockBump);
    expect(lock.noReviewableContentKind).toBe('lockfile-only');
    expect(lock.unverifiedLockfiles).toEqual([]);
  });

  it('classifies data/config formats without touching documentation or source', () => {
    expect(isDataOrConfigPath(LAB_ASSETS)).toBe(true);
    expect(isDataOrConfigPath('docs/guide.md')).toBe(false);
    expect(isDataOrConfigPath('src/main.ts')).toBe(false);
    expect(isDataOrConfigPath('tools/inventory.lua')).toBe(false);
  });

  it('the panel engine reaches the routed lane for a data-only diff instead of the coverage error', async () => {
    const config = { ...roster('architecture,security'), personas: sourceOnlyRoster() };
    const run = executePersonaPanel({
      config,
      changedFiles: files(LAB_ASSETS),
      repository: 'calltelemetry/ct-meta',
      headSha: 'aba144b4aaae7fabfd0600d862f95bce35e08808',
      client: unreachableClient,
      deterministicRoster: true,
    });
    await expect(run).rejects.toThrow(/persona sec-lane failed closed: .*must not be consulted/);
    await expect(run).rejects.not.toThrow(/no enabled persona applies/);
  }, 60_000);

  it('the composed engine reaches its reviewer for a data-only diff', async () => {
    const config = { ...roster('architecture,security'), personas: sourceOnlyRoster() };
    await expect(executeComposedReview({
      config,
      changedFiles: files(LAB_ASSETS),
      repository: 'calltelemetry/ct-meta',
      headSha: 'aba144b4aaae7fabfd0600d862f95bce35e08808',
      client: unreachableClient,
      // Past the zero-lane decision, a stale head aborts before any provider call.
      isCurrentHead: () => false,
    })).rejects.toThrow(/stale run aborted/);
  });
});

describe('REL-972 (2): generated and path_filters-excluded files never ride along under a docs-only pass', () => {
  it.each([
    ['a generated bundle', files('docs/guide.md', 'dist/bundle.js'), {}, 'dist/bundle.js'],
    ['a minified asset', files('README.md', 'assets/app.min.js'), {}, 'assets/app.min.js'],
    ['a path_filters exclusion', files('docs/guide.md', 'vendor/client.lua'), { pathFilters: ['vendor/**'] }, 'vendor/client.lua'],
  ])('does not exempt docs plus %s', (_label, changed, options, excluded) => {
    const result = resolveReviewApplicability(enabled('architecture,security'), changed, options);

    expect(result.applicable).toEqual([]);
    expect(result.noReviewableContent).toBe(false);
    expect(result.noReviewableContentKind).toBeNull();
    expect(result.excludedPaths).toEqual([excluded]);
    expect(result.unmatchedPaths).toEqual([excluded]);
  });

  it('both engines fail docs plus a generated file closed, naming the excluded file', async () => {
    const config = roster('architecture,security');
    const changedFiles = files('docs/guide.md', 'dist/bundle.js');
    const message = /no enabled persona applies.*Excluded from review by the generated-file filter or path_filters.*dist\/bundle\.js/;
    await expect(executePersonaPanel({
      config, changedFiles, repository: 'r/r', headSha: 'd'.repeat(40), client: unreachableClient, deterministicRoster: true,
    })).rejects.toThrow(message);
    await expect(executeComposedReview({
      config, changedFiles, repository: 'r/r', headSha: 'd'.repeat(40), client: unreachableClient,
    })).rejects.toThrow(message);
  });

  it('bounds the excluded-file list in the coverage error and counts the rest', () => {
    const excluded = Array.from({ length: 11 }, (_, index) => `dist/chunk${index}.js`);
    const message = personaCoverageError('r/r', 'e'.repeat(40), excluded, [{ id: 'sec-lane' }], [], excluded).message;
    const note = message.slice(message.indexOf('Excluded from review'));
    expect(note).toContain('dist/chunk9.js, +1 more;');
    expect(note).not.toContain('dist/chunk10.js');

    const exact = personaCoverageError('r/r', 'e'.repeat(40), excluded.slice(0, 10), [{ id: 'sec-lane' }], [], excluded.slice(0, 10)).message;
    expect(exact).toContain('dist/chunk9.js; a diff carrying them');
    expect(exact).not.toMatch(/more;/);
  });

  it('still reviews the covered files and drops the generated one when a lane applies', () => {
    const result = resolveReviewApplicability(enabled('architecture,security'), files('src/auth/login.ts', 'dist/bundle.js'));
    expect(result.applicable.length).toBeGreaterThan(0);
    expect(result.effectiveFiles.map((file) => file.path)).toEqual(['src/auth/login.ts']);
    expect(result.excludedPaths).toEqual([]);
  });

  it('exempts documentation that path_filters excludes, since every changed file is prose', () => {
    const result = resolveReviewApplicability(enabled('architecture,security'), files('docs/guide.md'), { pathFilters: ['docs/**'] });
    expect(result.effectiveFiles).toEqual([]);
    expect(result.noReviewableContentKind).toBe('documentation');
  });

  // The worker (resolveReviewApplicability) and the service's per-file
  // admission check (isNoReviewableContentFile over the raw files) must reach
  // the same answer for every zero-lane diff, or a completion is produced that
  // the service refuses to acknowledge.
  it.each([
    ['docs only', files('docs/guide.md'), {}],
    ['docs + generated', files('docs/guide.md', 'dist/bundle.js'), {}],
    ['docs + minified', files('docs/guide.md', 'web/app.min.css'), {}],
    ['docs + path_filters exclusion', files('docs/guide.md', 'vendor/x.lua'), { pathFilters: ['vendor/**'] }],
    ['generated only', files('dist/bundle.js'), {}],
    ['docs excluded by path_filters', files('docs/guide.md'), { pathFilters: ['docs/**'] }],
    ['run artifacts', files('runs/1/out.json', 'evidence/log.txt'), {}],
    ['docs + unverifiable lockfile', files('docs/guide.md', 'yarn.lock'), {}],
  ])('worker and service agree on %s', (_label, changed, options) => {
    const decision = resolveReviewApplicability(sourceOnlyRoster(), changed, options);
    expect(decision.applicable).toEqual([]);
    expect(decision.noReviewableContent).toBe(changed.every((file) => isNoReviewableContentFile(file)));
  });
});
