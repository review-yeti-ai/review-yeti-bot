import { describe, expect, it } from 'vitest';
import { resolveWorkerConfig } from '../../src/config/publishingWorkerConfig';
import { executeComposedReview } from '../../src/panel/composedEngine';
import { executePersonaPanel } from '../../src/panel/panelEngine';
import { renderRoutedFiles } from '../../src/cli/publishingReview';
import type { ReviewModelClient } from '../../src/gateway/openRouterClient';
import { resolveReviewApplicability, scopeFilesForPersona } from '../../src/review/personaApplicability';

/**
 * REL-1088 (found by #998, REL-972): when at least one configured persona
 * applied to a diff, a DIFFERENT changed source file no persona covers was
 * neither reviewed nor reported -- `computeUnmatchedPaths` only ran when no lane
 * applied. It rode along unreviewed next to the covered files.
 *
 * Policy: nothing is dropped silently. Beside a lane that applies on its own
 * paths, the uncovered file is routed to the roster's required lane (or the
 * first enabled persona), the same owner as .mdx / gitlink / data routing, and
 * disclosed. Alone, or beside only routed files, it still fails closed.
 */

const transport = { baseUrl: 'https://gateway.example.invalid/v1', apiKey: 'k', model: 'review-model' };
const roster = (personas: string) => resolveWorkerConfig({ REVIEW_PERSONAS: personas }, transport);
const enabled = (personas: string) => roster(personas).personas.filter((persona) => persona.enabled);
const patch = '@@ -1 +1 @@\n-a\n+b\n';
const files = (...paths: string[]) => paths.map((path) => ({ path, patch }));

const UNCOVERED = 'tools/inventory.lua';
const LAB_ASSETS = 'plugins/ct-lab/skills/lab-inventory/inventory/lab-assets.json';

/** security (required) covers TypeScript/Elixir; architecture covers src/ and lib/. */
function sourceOnlyRoster() {
  return enabled('architecture,security').map((persona) => ({
    ...persona,
    paths: persona.id === 'sec-lane' ? ['**/*.ts', '**/*.ex', '**/*.exs'] : ['src/**', 'lib/**'],
  }));
}

/** Only architecture applies to a Python source file; the required lane does not. */
function narrowRequiredRoster() {
  return enabled('architecture,security').map((persona) => ({
    ...persona,
    paths: persona.id === 'sec-lane' ? ['**/*.ex'] : ['src/**'],
  }));
}

const routedOf = (persona: object) => (persona as { routedPaths?: readonly string[] }).routedPaths;

const unreachableClient = new Proxy({}, {
  get() { throw new Error('the model client must not be consulted'); },
}) as unknown as ReviewModelClient;

describe('REL-1088: uncovered source beside an applying lane is routed, never dropped', () => {
  it('routes the uncovered file to the required lane, which then reviews it', () => {
    const result = resolveReviewApplicability(sourceOnlyRoster(), files('src/auth/login.ts', UNCOVERED));

    expect(result.applicable.map((persona) => persona.id)).toEqual(['arch-lane', 'sec-lane']);
    expect(result.unmatchedPaths).toEqual([]);
    expect(result.noReviewableContent).toBe(false);
    const sec = result.applicable.find((persona) => persona.id === 'sec-lane')!;
    expect(scopeFilesForPersona(sec, result.effectiveFiles).map((file) => file.path))
      .toEqual(['src/auth/login.ts', UNCOVERED]);
    const arch = result.applicable.find((persona) => persona.id === 'arch-lane')!;
    expect(arch).not.toHaveProperty('routedPaths');
    expect(result.routedFiles).toEqual([{ path: UNCOVERED, laneIds: ['sec-lane'], reason: 'uncovered-source' }]);
  });

  it('adds the required lane when only another lane applied on its own paths', () => {
    const result = resolveReviewApplicability(narrowRequiredRoster(), files('src/app.py', UNCOVERED));
    expect(result.applicable.map((persona) => [persona.id, routedOf(persona)])).toEqual([
      ['arch-lane', undefined],
      ['sec-lane', [UNCOVERED]],
    ]);
    expect(result.routedFiles).toEqual([{ path: UNCOVERED, laneIds: ['sec-lane'], reason: 'uncovered-source' }]);
  });

  it('routes to the first enabled persona when none is required', () => {
    const personas = narrowRequiredRoster().map((persona) => ({ ...persona, required: false }));
    const result = resolveReviewApplicability(personas, files('src/app.py', UNCOVERED));
    expect(result.applicable.map((persona) => [persona.id, routedOf(persona)])).toEqual([
      ['arch-lane', [UNCOVERED]],
    ]);
  });

  it('labels fallback-routed and uncovered-source files separately on the same lane', () => {
    const result = resolveReviewApplicability(sourceOnlyRoster(), files('src/auth/login.ts', 'config/app.toml', UNCOVERED));
    expect(result.routedFiles).toEqual([
      { path: 'config/app.toml', laneIds: ['sec-lane'], reason: 'fallback' },
      { path: UNCOVERED, laneIds: ['sec-lane'], reason: 'uncovered-source' },
    ]);
    expect(result.unmatchedPaths).toEqual([]);
  });

  it('keeps uncovered source a coverage failure when no configured lane applies', () => {
    for (const changed of [files(UNCOVERED), files(LAB_ASSETS, UNCOVERED)]) {
      const result = resolveReviewApplicability(sourceOnlyRoster(), changed);
      expect(result.applicable).toEqual([]);
      expect(result.unmatchedPaths).toEqual([UNCOVERED]);
      expect(result.routedFiles).toEqual([]);
    }
  });

  it('routes nothing when every file is covered, or the rest is prose or a filtered generated file', () => {
    for (const changed of [
      files('src/auth/login.ts'),
      files('src/auth/login.ts', 'docs/guide.md'),
      files('src/auth/login.ts', 'dist/bundle.js'),
    ]) {
      const result = resolveReviewApplicability(sourceOnlyRoster(), changed);
      expect(result.applicable.map((persona) => persona.id)).toEqual(['arch-lane', 'sec-lane']);
      expect(result.applicable.some((persona) => 'routedPaths' in persona)).toBe(false);
      expect(result.routedFiles).toEqual([]);
    }
  });

  it('does not route a file the repository path_filters exclude', () => {
    const result = resolveReviewApplicability(sourceOnlyRoster(), files('src/auth/login.ts', UNCOVERED), { pathFilters: ['tools/**'] });
    expect(result.routedFiles).toEqual([]);
    expect(result.effectiveFiles.map((file) => file.path)).toEqual(['src/auth/login.ts']);
  });

  it('the panel engine runs the routed required lane', async () => {
    // Before REL-1088 only arch-lane ran here and the uncovered file was
    // dropped; the required lane now runs and fails closed on the unreachable
    // client, proving it was scheduled.
    const config = { ...roster('architecture,security'), personas: narrowRequiredRoster() };
    await expect(executePersonaPanel({
      config,
      changedFiles: files('src/app.py', UNCOVERED),
      repository: 'r/r',
      headSha: 'f'.repeat(40),
      client: unreachableClient,
      deterministicRoster: true,
    })).rejects.toThrow(/persona sec-lane failed closed/);
  }, 60_000);

  it('the composed engine reaches its reviewer for the same diff', async () => {
    const config = { ...roster('architecture,security'), personas: narrowRequiredRoster() };
    await expect(executeComposedReview({
      config,
      changedFiles: files('src/app.py', UNCOVERED),
      repository: 'r/r',
      headSha: 'f'.repeat(40),
      client: unreachableClient,
      isCurrentHead: () => false,
    })).rejects.toThrow(/stale run aborted/);
  });
});

describe('REL-1088: routed files are disclosed in the check summary', () => {
  it('names each routed file, its lane and whether it is uncovered source', () => {
    const text = renderRoutedFiles({ routedFiles: [
      { path: 'config/app.toml', laneIds: ['sec-lane'], reason: 'fallback' },
      { path: UNCOVERED, laneIds: ['sec-lane'], reason: 'uncovered-source' },
    ] })!;
    expect(text).toContain("Routed files (no persona's paths cover them");
    expect(text).toContain('- `config/app.toml` -> `sec-lane`\n');
    expect(text).toContain(`- \`${UNCOVERED}\` -> \`sec-lane\` (source no persona covers)`);
  });

  it('renders nothing when nothing was routed', () => {
    expect(renderRoutedFiles({})).toBeNull();
    expect(renderRoutedFiles({ routedFiles: [] })).toBeNull();
  });

  it('neutralizes markdown in untrusted paths and bounds the list', () => {
    const routed = Array.from({ length: 22 }, (_, index) => ({
      path: index === 0 ? 'a`b<c>\nd.lua' : `tools/f${index}.lua`, laneIds: ['sec-lane'], reason: 'uncovered-source' as const,
    }));
    const text = renderRoutedFiles({ routedFiles: routed })!;
    expect(text).toContain('`a b c  d.lua`');
    expect(text).toContain('tools/f19.lua');
    expect(text).not.toContain('tools/f20.lua');
    expect(text).toContain('- +2 more');
  });
});
