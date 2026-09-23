import { describe, expect, it } from 'vitest';
import { resolveWorkerConfig } from '../../src/config/publishingWorkerConfig';
import { executeComposedReview } from '../../src/panel/composedEngine';
import { executePersonaPanel } from '../../src/panel/panelEngine';
import type { ReviewModelClient } from '../../src/gateway/openRouterClient';
import { filterDiffHunks } from '../../src/pipeline/hunkFilter';
import { parseChangedFiles } from '../../src/review/changedFiles';
import { resolveReviewApplicability } from '../../src/review/personaApplicability';

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
 * (authoritativeCompletionContext.test.ts covers the service side).
 */

const transport = { baseUrl: 'https://gateway.example.invalid/v1', apiKey: 'k', model: 'review-model' };
const roster = (personas = 'architecture,security') => resolveWorkerConfig({ REVIEW_PERSONAS: personas }, transport);
const enabled = (personas?: string) => roster(personas).personas.filter((persona) => persona.enabled);
const patch = '@@ -1 +1 @@\n-a\n+b\n';
const files = (...paths: string[]) => paths.map((path) => ({ path, patch }));

// The exemption is decided from paths alone; reaching a model is a failure.
const unreachableClient = new Proxy({}, {
  get() { throw new Error('the model client must not be consulted'); },
}) as unknown as ReviewModelClient;

describe('REL-972: shared decision for lockfile/generated-only diffs', () => {
  it.each([
    [['yarn.lock']],
    [['package-lock.json']],
    [['mix.lock']],
    [['services/api/Cargo.lock', 'web/pnpm-lock.yaml']],
    [['assets/app.min.js', 'assets/app.min.js.map']],
    [['proto/review.pb.go', 'yarn.lock']],
  ])('exempts %j as no reviewable content', (paths) => {
    const result = resolveReviewApplicability(enabled(), files(...paths));

    expect(result.applicable).toEqual([]);
    expect(result.effectiveFiles).toEqual([]);
    expect(result.noReviewableContent).toBe(true);
    expect(result.noReviewableContentKind).toBe('lockfile-or-generated');
    expect(result.unmatchedPaths).toEqual([]);
    for (const path of paths) expect(result.noReviewableContentRationale).toContain(path);
  });

  it('lists each excluded file with why it was excluded', () => {
    const result = resolveReviewApplicability(enabled(), files('yarn.lock', 'assets/app.min.js'));

    expect(result.noReviewableContentRationale).toBe(
      'No reviewable content: every changed file is a dependency lockfile or generated artifact, '
      + 'which the review filter excludes from every lane. '
      + 'Excluded: yarn.lock (dependency lockfile), assets/app.min.js (generated artifact). '
      + 'A manifest or source change in the same diff would be reviewed.',
    );
    // Published as one line through the check-summary sanitizer.
    expect(result.noReviewableContentRationale).not.toMatch(/[\r\n]/u);
  });

  it('bounds the listed files for a very large generated diff', () => {
    const paths = Array.from({ length: 30 }, (_, index) => `pkg${index}/package-lock.json`);
    const result = resolveReviewApplicability(enabled(), files(...paths));

    expect(result.noReviewableContent).toBe(true);
    expect(result.noReviewableContentRationale).toContain('pkg7/package-lock.json');
    expect(result.noReviewableContentRationale).not.toContain('pkg8/package-lock.json');
    expect(result.noReviewableContentRationale).toContain('+22 more');
  });

  it('keeps the documentation exemption and names it', () => {
    const result = resolveReviewApplicability(enabled(), files('docs/guide.md', 'yarn.lock'));

    expect(result.noReviewableContent).toBe(true);
    expect(result.noReviewableContentKind).toBe('documentation');
  });

  // Security posture: each of these must be reviewed or fail closed exactly as
  // before. Pinning the new `noReviewableContentKind` (null) alongside keeps
  // every case asserting the decision, not merely the absence of a flag.
  it('reviews a manifest changed beside its lockfile -- that is not lockfile-only', () => {
    const result = resolveReviewApplicability(enabled(), files('package.json', 'package-lock.json'));

    expect(result.noReviewableContent).toBe(false);
    expect(result.noReviewableContentKind).toBeNull();
    expect(result.applicable.map((persona) => persona.id)).toEqual(['arch-lane', 'sec-lane']);
    expect(result.effectiveFiles.map((file) => file.path)).toEqual(['package.json']);
  });

  it.each([
    ['uncovered source beside a lockfile', ['src/main.lua', 'yarn.lock'], ['src/main.lua']],
    ['a file only located under a build output directory', ['dist/bundle.js'], []],
    ['a build-output file beside a lockfile', ['build/deploy.sh', 'yarn.lock'], []],
  ])('fails %s closed', (_label, paths, unmatched) => {
    const result = resolveReviewApplicability(enabled(), files(...paths));

    expect(result.applicable).toEqual([]);
    expect(result.noReviewableContent).toBe(false);
    expect(result.noReviewableContentKind).toBeNull();
    expect(result.noReviewableContentRationale).toBeNull();
    expect(result.unmatchedPaths).toEqual(unmatched);
  });

  it('does not exempt a lockfile diff that also carries a path_filters-excluded source file', () => {
    const result = resolveReviewApplicability(enabled(), files('vendor/client.lua', 'yarn.lock'), {
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
    expect(result.noReviewableContentKind).toBeNull();
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
      changedFiles: files('yarn.lock'),
      repository: 'calltelemetry/ct-quasar',
      headSha: 'a'.repeat(40),
      client: unreachableClient,
      deterministicRoster: true,
    });

    expect(result.arbiter.verdict).toBe('SHIP');
    expect(result.documentationOnly).toBe(true);
    expect(result.noReviewableContentKind).toBe('lockfile-or-generated');
    expect(result.applicablePersonaIds).toEqual([]);
    expect(result.personas.map((lane) => [lane.id, lane.decision])).toEqual([['documentation-only', 'APPROVE']]);
    expect(result.arbiter.rationale).toContain('yarn.lock (dependency lockfile)');
  });

  it('the composed engine takes the identical outcome', async () => {
    const result = await executeComposedReview({
      config: roster(),
      changedFiles: files('mix.lock'),
      repository: 'calltelemetry/cisco-cdr',
      headSha: 'b'.repeat(40),
      client: unreachableClient,
    });

    expect(result.arbiter.verdict).toBe('SHIP');
    expect(result.documentationOnly).toBe(true);
    expect(result.noReviewableContentKind).toBe('lockfile-or-generated');
    expect(result.arbiter.rationale).toContain('mix.lock (dependency lockfile)');
  });

  it('both engines still fail a manifest-bearing diff they cannot cover closed', async () => {
    const config = roster('testing');
    const changedFiles = files('package.json', 'package-lock.json');
    expect(resolveReviewApplicability(config.personas.filter((p) => p.enabled), changedFiles).applicable).toEqual([]);

    await expect(executePersonaPanel({
      config, changedFiles, repository: 'r/r', headSha: 'c'.repeat(40), client: unreachableClient, deterministicRoster: true,
    })).rejects.toThrow(/no enabled persona applies.*package\.json/);
    await expect(executeComposedReview({
      config, changedFiles, repository: 'r/r', headSha: 'c'.repeat(40), client: unreachableClient,
    })).rejects.toThrow(/no enabled persona applies.*package\.json/);
  });
});
