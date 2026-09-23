import { describe, expect, it } from 'vitest';
import { resolveWorkerConfig } from '../../src/config/publishingWorkerConfig';
import { executeComposedReview } from '../../src/panel/composedEngine';
import { executePersonaPanel } from '../../src/panel/panelEngine';
import type { ReviewModelClient } from '../../src/gateway/openRouterClient';
import { parseChangedFiles } from '../../src/review/changedFiles';
import {
  resolveReviewApplicability,
  scopeFilesForPersona,
  withGitlinkCoverage,
} from '../../src/review/personaApplicability';
import { isDocumentationOrAssetPath } from '../../src/review/reviewableContent';

/**
 * REL-1058 (a concrete case of REL-972): two diff shapes failed every review
 * deterministically with "no enabled persona applies to the changed paths".
 *
 *  (a) calltelemetry/vitepress#238 -- a docs-only `.mdx` change against the
 *      roster [arch-lane, sec-lane]; `.mdx` was not classified as documentation.
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
    MDX_PATH,
    'docs/guide/intro.MDX',
    'content/reference.mdoc',
    'manual/install.asciidoc',
    'assets/diagram.webp',
    'assets/hero.avif',
  ])('classifies %s as documentation or an asset', (path) => {
    expect(isDocumentationOrAssetPath(path)).toBe(true);
  });

  it.each([
    '.cursor/rules/review.mdc', // agent operating policy, not prose
    'src/components/Callout.jsx',
    'docusaurus/docusaurus.config.ts',
    'docs/mdx-plugin.js',
  ])('keeps %s analyzable', (path) => {
    expect(isDocumentationOrAssetPath(path)).toBe(false);
  });

  it('approves a docs-only .mdx change deterministically against the vitepress#238 roster', async () => {
    const config = roster('architecture,security');
    expect(config.personas.map((persona) => persona.id)).toEqual(['arch-lane', 'sec-lane']);

    const result = await executePersonaPanel({
      config,
      changedFiles: [{ path: MDX_PATH, patch: '@@ -1 +1 @@\n-Old firewall table\n+New firewall table\n' }],
      repository: 'calltelemetry/vitepress',
      headSha: '0cd93c2f56e26926c4708e8d9b06a5baf0493799',
      client: unreachableClient,
      deterministicRoster: true,
    });

    expect(result.arbiter.verdict).toBe('SHIP');
    expect((result as { documentationOnly?: boolean }).documentationOnly).toBe(true);
    expect(result.applicablePersonaIds).toEqual([]);
  });

  it('still fails closed for an analyzable path next to the .mdx', async () => {
    await expect(executePersonaPanel({
      config: roster('architecture,security'),
      changedFiles: [
        { path: MDX_PATH, patch: '@@ -1 +1 @@\n-a\n+b\n' },
        { path: 'inventory/lab.lua', patch: '@@ -1 +1 @@\n-a\n+b\n' },
      ],
      repository: 'calltelemetry/vitepress',
      headSha: 'a'.repeat(40),
      client: unreachableClient,
      deterministicRoster: true,
    })).rejects.toThrow(/no enabled persona applies.*inventory\/lab\.lua/);
  });
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
    expect(withGitlinkCoverage(withArch)).toEqual(withArch);

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
      { path: 'docs/readme.mdx', patch: '@@ -1 +1 @@\n-a\n+b\n' },
    ];
    const unfiltered = resolveReviewApplicability(enabled('architecture,security'), files);
    expect(unfiltered.noReviewableContent).toBe(false);
    expect(unfiltered.unmatchedPaths).toEqual(['vendor/generated/client.lua']);

    const filtered = resolveReviewApplicability(enabled('architecture,security'), files, { pathFilters: ['vendor/**'] });
    expect(filtered.effectiveFiles.map((file) => file.path)).toEqual(['docs/readme.mdx']);
    expect(filtered.noReviewableContent).toBe(true);
  });

  it('the composed engine narrows by the same repository path_filters', async () => {
    const changedFiles = [
      { path: 'vendor/generated/client.lua', patch: '@@ -1 +1 @@\n-a\n+b\n' },
      { path: 'docs/readme.mdx', patch: '@@ -1 +1 @@\n-a\n+b\n' },
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

    // Unfiltered, the .lua path is analyzable, so the run proceeds past the
    // zero-lane decision.
    await expect(run(base)).rejects.toThrow(/stale run aborted/);

    // Filtered out, only documentation remains: the deterministic exemption.
    const filtered = await run({ ...base, path_filters: ['vendor/**'] });
    expect(filtered.arbiter.verdict).toBe('SHIP');
    expect((filtered as { documentationOnly?: boolean }).documentationOnly).toBe(true);
  });

  it('handles an empty enabled roster without routing or crashing', () => {
    const [gitlink] = parseChangedFiles(GITLINK_DIFF).files;
    expect(withGitlinkCoverage([])).toEqual([]);
    const result = resolveReviewApplicability([], [gitlink]);
    expect(result.applicable).toEqual([]);
    expect(result.noReviewableContent).toBe(false);
    expect(result.unmatchedPaths).toEqual(['ct-dashboard']);
  });
});
