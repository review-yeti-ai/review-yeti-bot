import { describe, expect, it } from 'vitest';
import { resolveWorkerConfig } from '../../src/config/publishingWorkerConfig';
import { executeComposedReview } from '../../src/panel/composedEngine';
import { executePersonaPanel } from '../../src/panel/panelEngine';
import type { ReviewModelClient } from '../../src/gateway/openRouterClient';
import { parseChangedFiles } from '../../src/review/changedFiles';
import {
  resolveReviewApplicability,
  scopeFilesForPersona,
  routeOrphanedReviewFiles,
} from '../../src/review/personaApplicability';
import { isDocumentationOrAssetPath } from '../../src/review/reviewableContent';

/**
 * REL-1058 (a concrete case of REL-972): two diff shapes failed every review
 * deterministically with "no enabled persona applies to the changed paths".
 *
 *  (a) calltelemetry/vitepress#238 -- a docs-only `.mdx` change against the
 *      roster [arch-lane, sec-lane]; no persona covered `.mdx`.
 *  (b) calltelemetry/ai-workspace#3097/#3103 -- a change whose only path is the
 *      `ct-dashboard` submodule gitlink.
 */

const transport = { baseUrl: 'https://gateway.example.invalid/v1', apiKey: 'k', model: 'review-model' };
const roster = (personas: string) => resolveWorkerConfig({ REVIEW_PERSONAS: personas }, transport);
const enabled = (personas: string) => roster(personas).personas.filter((persona) => persona.enabled);

const MDX_PATH = 'docusaurus/docs/deployment/appliance-firewall-requirements.mdx';
const GITLINK_DIFF = 'diff --git a/ct-dashboard b/ct-dashboard\n'
  + 'index 6c3f36d89d..f84610fbbf 160000\n--- a/ct-dashboard\n+++ b/ct-dashboard\n'
  + '@@ -1 +1 @@\n-Subproject commit 6c3f36d89d675d27c0a8b88f684d57c6185a7e6b\n'
  + '+Subproject commit f84610fbbf478540b07861fa7a18174126ffe5bb\n';

// A panel run that reaches a model is a failure for these cases: they must be
// decided deterministically from the paths alone.
const unreachableClient = new Proxy({}, {
  get() { throw new Error('the model client must not be consulted'); },
}) as unknown as ReviewModelClient;

describe('REL-1058: documentation extensions', () => {
  it.each([
    'manual/install.asciidoc',
    'assets/diagram.webp',
    'assets/hero.avif',
  ])('classifies %s as documentation or an asset', (path) => {
    expect(isDocumentationOrAssetPath(path)).toBe(true);
  });

  it.each([
    MDX_PATH, // compiles to a component module: routed to a lane, never exempt
    'docs/guide/intro.MDX',
    'content/reference.mdoc', // likewise
    '.cursor/rules/review.mdc', // agent operating policy, not prose
    'src/components/Callout.jsx',
    'docusaurus/docusaurus.config.ts',
    'docs/mdx-plugin.js',
  ])('keeps %s analyzable', (path) => {
    expect(isDocumentationOrAssetPath(path)).toBe(false);
  });
});

describe('REL-1058: .mdx policy', () => {
  const mdx = { path: MDX_PATH, patch: '@@ -1 +1 @@\n-Old firewall table\n+New firewall table\n' };

  it('routes an uncovered .mdx page to the required lane (vitepress#238 roster)', () => {
    const personas = enabled('architecture,security');
    expect(personas.map((persona) => persona.id)).toEqual(['arch-lane', 'sec-lane']);

    const result = resolveReviewApplicability(personas, [mdx]);

    expect(result.applicable.map((persona) => persona.id)).toEqual(['sec-lane']);
    expect(result.noReviewableContent).toBe(false);
    expect(result.unmatchedPaths).toEqual([]);
    expect(scopeFilesForPersona(result.applicable[0], result.effectiveFiles).map((file) => file.path))
      .toEqual([MDX_PATH]);
  });

  it('routes an uncovered .mdoc page the same way', () => {
    const result = resolveReviewApplicability(enabled('architecture,security'), [
      { path: 'content/reference.mdoc', patch: mdx.patch },
    ]);
    expect(result.applicable.map((persona) => persona.id)).toEqual(['sec-lane']);
  });

  it('does not let a routed .mdx or gitlink mask uncovered source in an otherwise unreviewed diff', () => {
    const [link] = parseChangedFiles(GITLINK_DIFF).files;
    const lua = { path: 'vendor/generated/client.lua', patch: '@@ -1 +1 @@\n-a\n+b\n' };
    for (const orphan of [mdx, link]) {
      const result = resolveReviewApplicability(enabled('security'), [orphan, lua]);
      expect(result.applicable).toEqual([]);
      expect(result.noReviewableContent).toBe(false);
      expect(result.unmatchedPaths).toEqual(['vendor/generated/client.lua']);
    }
  });

  it('leaves .mdx with the documentation persona when the roster has one', () => {
    const result = resolveReviewApplicability(enabled('architecture,security,documentation'), [mdx]);
    expect(result.applicable.map((persona) => persona.id)).toEqual(['documentation']);
    expect(result.applicable[0]).not.toHaveProperty('routedPaths');
  });

  it('routes case-insensitively and keeps non-owner lanes on a mixed diff', () => {
    const [link] = parseChangedFiles(GITLINK_DIFF).files;
    const upper = { path: 'docs/guide/intro.MDX', patch: mdx.patch };

    const result = resolveReviewApplicability(enabled('architecture,security'), [link, upper]);

    expect(result.applicable.map((persona) => persona.id)).toEqual(['arch-lane', 'sec-lane']);
    const scoped = Object.fromEntries(result.applicable.map((persona) => [
      persona.id, scopeFilesForPersona(persona, result.effectiveFiles).map((file) => file.path),
    ]));
    expect(scoped).toEqual({ 'arch-lane': ['ct-dashboard'], 'sec-lane': ['docs/guide/intro.MDX'] });
    expect(result.unmatchedPaths).toEqual([]);
  });

  it('reaches a real lane for a docs-only .mdx panel run instead of failing or auto-approving', async () => {
    let caught: unknown;
    try {
      await executePersonaPanel({
        config: roster('architecture,security'),
        changedFiles: [mdx],
        repository: 'calltelemetry/vitepress',
        headSha: '0cd93c2f56e26926c4708e8d9b06a5baf0493799',
        client: unreachableClient,
        deterministicRoster: true,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toMatch(/no enabled persona applies/);
    expect((caught as Error).message).toMatch(/persona sec-lane failed closed: .*must not be consulted/);
  }, 60_000);
});

describe('REL-1058: submodule gitlink policy', () => {
  const [gitlink] = parseChangedFiles(GITLINK_DIFF).files;

  it('routes a pointer bump to the architecture lane when the roster has one (ai-workspace roster)', () => {
    const result = resolveReviewApplicability(enabled('architecture,security,documentation'), [gitlink]);
    expect(result.applicable.map((persona) => persona.id)).toEqual(['arch-lane']);
    expect(result.unmatchedPaths).toEqual([]);
  });

  it('routes a pointer bump to the required lane when the roster has no architecture persona', () => {
    const result = resolveReviewApplicability(enabled('security,documentation'), [gitlink]);

    expect(result.applicable.map((persona) => persona.id)).toEqual(['sec-lane']);
    expect(result.noReviewableContent).toBe(false);
    expect(result.unmatchedPaths).toEqual([]);
    // The routed lane actually receives the gitlink (old -> new SHA) to review.
    expect(scopeFilesForPersona(result.applicable[0], result.effectiveFiles).map((file) => file.path))
      .toEqual(['ct-dashboard']);
  });

  it('falls back to the first enabled persona when none is required', () => {
    const personas = enabled('testing,performance');
    expect(personas.some((persona) => persona.required)).toBe(false);
    const result = resolveReviewApplicability(personas, [gitlink]);
    expect(result.applicable.map((persona) => persona.id)).toEqual(['qual-lane']);
  });

  it('does not reroute ordinary files or widen a roster that has an architecture persona', () => {
    const withArch = enabled('architecture,security');
    const [link] = parseChangedFiles(GITLINK_DIFF).files;
    expect(routeOrphanedReviewFiles(withArch, [link])).toEqual(withArch);

    const result = resolveReviewApplicability(enabled('security,documentation'), [
      { path: 'inventory/lab.lua', patch: '@@ -1 +1 @@\n-a\n+b\n' },
    ]);
    expect(result.applicable).toEqual([]);
    expect(result.unmatchedPaths).toEqual(['inventory/lab.lua']);
  });

  it('does not throw the coverage error for a gitlink-only diff without an architecture persona', async () => {
    let caught: unknown;
    try {
      await executePersonaPanel({
        config: roster('security,documentation'),
        changedFiles: [gitlink],
        repository: 'calltelemetry/ai-workspace',
        headSha: '7b95e18b067796d94e44c238fcd99fb783a13631',
        client: unreachableClient,
        deterministicRoster: true,
      });
    } catch (error) {
      caught = error;
    }
    // The routed sec-lane is reached (and here fails on the unreachable
    // client); the deterministic "no enabled persona applies" contract failure
    // is gone.
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toMatch(/no enabled persona applies/);
    expect((caught as Error).message).toMatch(/persona sec-lane failed closed: .*must not be consulted/);
  }, 60_000);
});

describe('REL-1058: one applicability decision for worker and service', () => {
  it('keeps gitlink metadata that the hunk filter would otherwise drop', () => {
    // A gitlink identified only by its mode (as GitHub's files API reports it),
    // with no "Subproject commit" text in the patch.
    const file = { path: 'ct-dashboard', patch: '@@ -1 +1 @@\n-6c3f36d\n+f84610f\n', mode: '160000' };
    const result = resolveReviewApplicability(enabled('architecture,security'), [file]);
    expect(result.applicable.map((persona) => persona.id)).toEqual(['arch-lane']);
    expect(result.effectiveFiles[0]).toMatchObject({ path: 'ct-dashboard', mode: '160000' });
  });

  it('applies the repository path_filters', () => {
    const files = [
      { path: 'vendor/generated/client.lua', patch: '@@ -1 +1 @@\n-a\n+b\n' },
      { path: 'docs/readme.md', patch: '@@ -1 +1 @@\n-a\n+b\n' },
    ];
    const unfiltered = resolveReviewApplicability(enabled('architecture,security'), files);
    expect(unfiltered.noReviewableContent).toBe(false);
    expect(unfiltered.unmatchedPaths).toEqual(['vendor/generated/client.lua']);

    const filtered = resolveReviewApplicability(enabled('architecture,security'), files, { pathFilters: ['vendor/**'] });
    expect(filtered.effectiveFiles.map((file) => file.path)).toEqual(['docs/readme.md']);
    // REL-972 (changed deliberately): this used to be the documentation-only
    // exemption, because only the post-filter files were judged. The service
    // refused that pass at completion (vendor/generated/client.lua is not
    // documentation), and on security grounds it was wrong: a path_filters
    // exclusion is read by no lane, so it must not ride along unreviewed under
    // a docs-only pass. The filter is still applied -- the .lua file is now
    // reported as excluded, not as uncovered source.
    expect(filtered.noReviewableContent).toBe(false);
    expect(filtered.excludedPaths).toEqual(['vendor/generated/client.lua']);
    expect(unfiltered.excludedPaths).toEqual([]);
  });

  it('the composed engine narrows by the same repository path_filters', async () => {
    const changedFiles = [
      { path: 'vendor/generated/client.lua', patch: '@@ -1 +1 @@\n-a\n+b\n' },
      { path: 'docs/readme.md', patch: '@@ -1 +1 @@\n-a\n+b\n' },
    ];
    const base = roster('architecture,security');
    const run = (config: typeof base) => executeComposedReview({
      config,
      changedFiles,
      repository: 'calltelemetry/vitepress',
      headSha: 'c'.repeat(40),
      client: unreachableClient,
      // Past the zero-lane decision, a stale head aborts before any provider call.
      isCurrentHead: () => false,
    });

    // Unfiltered, the uncovered .lua path is the same coverage failure the
    // panel engine and the service report -- one decision, one outcome.
    await expect(run(base)).rejects.toThrow(/no enabled persona applies.*vendor\/generated\/client\.lua/);

    // Filtered out, the .lua file is excluded rather than uncovered. REL-972
    // (changed deliberately): this was a documentation-only SHIP the service
    // then refused at completion; docs plus a path_filters exclusion is not
    // documentation-only, so every side now fails it closed, naming the
    // exclusion.
    await expect(run({ ...base, path_filters: ['vendor/**'] }))
      .rejects.toThrow(/Excluded from review by the generated-file filter or path_filters.*vendor\/generated\/client\.lua/);
  });

  it('the composed engine proceeds exactly when the shared decision applies a lane', async () => {
    const config = roster('architecture,security');
    const covered = [{ path: 'src/auth/login.ts', patch: '@@ -1 +1 @@\n-a\n+b\n' }];
    expect(resolveReviewApplicability(config.personas, covered).applicable.length).toBeGreaterThan(0);
    await expect(executeComposedReview({
      config, changedFiles: covered, repository: 'r/r', headSha: 'f'.repeat(40),
      client: unreachableClient, isCurrentHead: () => false,
    })).rejects.toThrow(/stale run aborted/);

    // Build-output-only: nothing survives the shared filter and the path alone
    // does not prove the file is generated, so every side fails it closed.
    // (A lockfile-only diff is the audited exemption instead -- REL-972.)
    await expect(executeComposedReview({
      config, changedFiles: [{ path: 'dist/bundle.js', patch: '@@ -1 +1 @@\n-a\n+b\n' }],
      repository: 'r/r', headSha: 'f'.repeat(40), client: unreachableClient,
    })).rejects.toThrow(/no enabled persona applies/);
  });

  it('handles an empty enabled roster without routing or crashing', () => {
    const [gitlink] = parseChangedFiles(GITLINK_DIFF).files;
    expect(routeOrphanedReviewFiles([], [gitlink])).toEqual([]);
    const result = resolveReviewApplicability([], [gitlink]);
    expect(result.applicable).toEqual([]);
    expect(result.noReviewableContent).toBe(false);
    expect(result.unmatchedPaths).toEqual(['ct-dashboard']);
  });

  it('ignores malformed path_filters entries rather than widening what is excluded', () => {
    const files = [{ path: 'inventory/lab.lua', patch: '@@ -1 +1 @@\n-a\n+b\n' }];
    for (const pathFilters of [[''], [42, null, {}], 'inventory/**', { rules: [] }] as unknown[]) {
      const result = resolveReviewApplicability(enabled('architecture,security'), files, { pathFilters: pathFilters as string[] });
      expect(result.effectiveFiles.map((file) => file.path)).toEqual(['inventory/lab.lua']);
      expect(result.unmatchedPaths).toEqual(['inventory/lab.lua']);
    }
    // Valid entries alongside malformed ones still apply.
    const mixed = resolveReviewApplicability(enabled('architecture,security'), files, {
      pathFilters: ['', 7, 'inventory/**'] as unknown as string[],
    });
    expect(mixed.effectiveFiles).toEqual([]);
  });

  it('the panel engine narrows by the same repository path_filters', async () => {
    const changedFiles = [
      { path: 'vendor/generated/client.lua', patch: '@@ -1 +1 @@\n-a\n+b\n' },
      { path: 'docs/readme.md', patch: '@@ -1 +1 @@\n-a\n+b\n' },
    ];
    const base = roster('architecture,security');
    const run = (config: typeof base) => executePersonaPanel({
      config,
      changedFiles,
      repository: 'calltelemetry/vitepress',
      headSha: 'd'.repeat(40),
      client: unreachableClient,
      deterministicRoster: true,
    });

    await expect(run(base)).rejects.toThrow(/no enabled persona applies.*vendor\/generated\/client\.lua/);

    // REL-972 (changed deliberately, as for the composed engine above): the
    // filter still applies, and the exclusion now fails closed instead of
    // passing as documentation-only.
    await expect(run({ ...base, path_filters: ['vendor/**'] }))
      .rejects.toThrow(/Excluded from review by the generated-file filter or path_filters.*vendor\/generated\/client\.lua/);
  });

  it('routes an orphan to every required persona', () => {
    const personas = enabled('security,testing,performance')
      .map((persona) => (persona.id === 'qual-lane' ? { ...persona, required: true } : persona));
    const [link] = parseChangedFiles(GITLINK_DIFF).files;

    const result = resolveReviewApplicability(personas, [link]);

    expect(result.applicable.map((persona) => persona.id)).toEqual(['sec-lane', 'qual-lane']);
    for (const persona of result.applicable) {
      expect(scopeFilesForPersona(persona, result.effectiveFiles).map((file) => file.path)).toEqual(['ct-dashboard']);
    }
  });

  it.each([
    ['a gitlink-only pointer bump', GITLINK_DIFF],
    ['an .mdx-only page', 'diff --git a/docs/a.mdx b/docs/a.mdx\n--- a/docs/a.mdx\n+++ b/docs/a.mdx\n@@ -1 +1 @@\n-a\n+b\n'],
  ])('the composed engine reviews %s instead of exempting or failing it', async (_label, diff) => {
    await expect(executeComposedReview({
      config: roster('architecture,security'),
      changedFiles: parseChangedFiles(diff).files,
      repository: 'calltelemetry/ai-workspace',
      headSha: 'e'.repeat(40),
      client: unreachableClient,
      // Past the zero-lane decision, a stale head aborts before any provider call:
      // reaching it proves the composed reviewer would run on this diff.
      isCurrentHead: () => false,
    })).rejects.toThrow(/stale run aborted/);
  });
});
