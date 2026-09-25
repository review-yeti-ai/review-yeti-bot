import { describe, expect, it, vi } from 'vitest';
import { resolveWorkerConfig } from '../../src/config/publishingWorkerConfig';
import { executeComposedReview } from '../../src/panel/composedEngine';
import { executePersonaPanel } from '../../src/panel/panelEngine';
import type { ReviewModelClient } from '../../src/gateway/openRouterClient';
import { renderRoutedFiles } from '../../src/cli/publishingReview';
import type { StoredReviewGate } from '../../src/persistence/reviewGateRepository';
import type { AuthoritativeReviewReader } from '../../src/github/authoritativeReviewReader';
import { createAuthoritativeCompletionContext, type AuthoritativeCompletionContextOptions } from '../../src/review/authoritativeCompletionContext';
import { buildAuthoritativeReviewIdentity } from '../../src/review/authoritativeReviewIdentity';
import { preparePublishingPolicy } from '../../src/review/preparedPublishingPolicy';
import { sha256 } from '../../src/review/reviewCore';
import { TrustedCompletionResolutionError } from '../../src/review/workerCompletionPersistenceError';
import { resolveReviewApplicability, scopeFilesForPersona } from '../../src/review/personaApplicability';
import { NEW_PACKAGE_ENTRY_REFUSAL, verifyLockfileOnlyChange } from '../../src/review/lockfileChangeVerification';
import { isDocumentationOrAssetPath, isNoReviewableContentFile } from '../../src/review/reviewableContent';
import { isDependencyPersona, isNewPackageLockfileChange, routeNewPackageLockfiles } from '../../src/review/newPackageLockfileReview';
import { isToolchainPinOrDependencyManifestPath } from '../../src/review/toolchainPinPaths';
import { MAX_FILE_PATCH_CHARS } from '../../src/pipeline/hunkFilter';
import { OMITTED_LOCKFILE_PATCH_REASON } from '../../src/review/omittedLockfilePatch';

/**
 * REL-1136 (operator report 2026-09-25, section 6 #2): the last two
 * no-persona failure classes on 1.92.4, on the roster [arch-lane, sec-lane,
 * documentation]:
 *
 * - calltelemetry/cisco-cdr#4625 (run_f976b65b) changes only `.tool-versions`.
 *   Nothing classified toolchain pin files, so the diff matched no persona and
 *   failed. Toolchain pins and extension-less dependency manifests are now
 *   routed to the required lane -- reviewed, never exempted.
 * - calltelemetry/ct-quasar#847 (run_73b61efc) is a Dependabot yarn.lock-only
 *   bump (qs 6.15.2 -> 6.15.3) that adds the entry `side-channel@npm:^1.1.1`.
 *   Every lockfile is hidden from every lane and the exemption refuses a new
 *   package, so it failed. A lockfile whose ONLY problem is a new registry
 *   package is now put back for the lanes and routed to the dependency lane
 *   (when enabled) and every required lane. Anything else it could hide keeps
 *   failing closed.
 *
 * The other four ct-quasar PRs of that batch (#887, #1476, #1552, #890) are
 * re-keys REL-1118 already verifies; they keep the lockfile-only exemption.
 */

const transport = { baseUrl: 'https://gateway.example.invalid/v1', apiKey: 'k', model: 'review-model' };
const roster = (personas = 'architecture,security,documentation') => resolveWorkerConfig({ REVIEW_PERSONAS: personas }, transport);
const enabled = (personas?: string) => roster(personas).personas.filter((persona) => persona.enabled);

const unreachableClient = new Proxy({}, {
  get() { throw new Error('the model client must not be consulted'); },
}) as unknown as ReviewModelClient;

/** The exact .tool-versions patch of calltelemetry/cisco-cdr#4625 (head 01647357). */
const CISCO_CDR_4625_TOOL_VERSIONS = [
  '@@ -1,5 +1,5 @@',
  ' erlang 26.2.5.15',
  '-elixir 1.18.4',
  '+elixir 1.18.4-otp-26',
  ' nodejs 24.8.0',
  ' rust stable',
  ' java openjdk-11',
].join('\n');

/** The exact yarn.lock patch of calltelemetry/ct-quasar#847 (head 3286ac68). */
const CT_QUASAR_847_YARN_LOCK = [
  '@@ -12462,11 +12462,12 @@ __metadata:',
  '   linkType: hard',
  ' ',
  ' "qs@npm:~6.15.1":',
  '-  version: 6.15.2',
  '-  resolution: "qs@npm:6.15.2"',
  '+  version: 6.15.3',
  '+  resolution: "qs@npm:6.15.3"',
  '   dependencies:',
  '-    side-channel: "npm:^1.1.0"',
  '-  checksum: 10c0/e6fd5f6f0aab06d480fe9ab15cebfc4ce4235303e2f91dc69a8f7f4df1e668a61c11d1cfbabacf4295cbbeb7b670ed23db45307480726259761f98e5695e93a7',
  '+    es-define-property: "npm:^1.0.1"',
  '+    side-channel: "npm:^1.1.1"',
  '+  checksum: 10c0/8f3f6e45ece255347d57696628401cde29e9ec649fff698b53bd3150dea7cefdf33036e1bc1826b9f110bfa7cb0ec4ab9f5297eca628ce216c55af82c304e08e',
  '   languageName: node',
  '   linkType: hard',
  ' ',
  '@@ -13568,7 +13569,7 @@ __metadata:',
  '   languageName: node',
  '   linkType: hard',
  ' ',
  '-"side-channel-list@npm:^1.0.0":',
  '+"side-channel-list@npm:^1.0.0, side-channel-list@npm:^1.0.1":',
  '   version: 1.0.1',
  '   resolution: "side-channel-list@npm:1.0.1"',
  '   dependencies:',
  '@@ -13616,6 +13617,19 @@ __metadata:',
  '   languageName: node',
  '   linkType: hard',
  ' ',
  '+"side-channel@npm:^1.1.1":',
  '+  version: 1.1.1',
  '+  resolution: "side-channel@npm:1.1.1"',
  '+  dependencies:',
  '+    es-errors: "npm:^1.3.0"',
  '+    object-inspect: "npm:^1.13.4"',
  '+    side-channel-list: "npm:^1.0.1"',
  '+    side-channel-map: "npm:^1.0.1"',
  '+    side-channel-weakmap: "npm:^1.0.2"',
  '+  checksum: 10c0/dc0ab81d67f61bda9247d053ce93f41c3fd8ad2bdcb9cf9d8d2f8540d488f26d87a5e99ebfc07eea49ec025867b2452b705442d974b1478f0395e69f6bfb3270',
  '+  languageName: node',
  '+  linkType: hard',
  '+',
  ' "siginfo@npm:^2.0.0":',
  '   version: 2.0.0',
  '   resolution: "siginfo@npm:2.0.0"',
].join('\n');

/** ct-quasar#887 (head 3a775021): two js-yaml entries merged into one -- a re-key. */
const CT_QUASAR_887_YARN_LOCK = [
  '@@ -10120,7 +10120,7 @@ __metadata:',
  '   languageName: node',
  '   linkType: hard',
  ' ',
  '-"js-yaml@npm:4.3.2":',
  '+"js-yaml@npm:4.3.2, js-yaml@npm:^4.1.0, js-yaml@npm:^4.1.1":',
  '   version: 4.3.2',
  '   resolution: "js-yaml@npm:4.3.2"',
  '   dependencies:',
  '@@ -10131,17 +10131,6 @@ __metadata:',
  '   languageName: node',
  '   linkType: hard',
  ' ',
  '-"js-yaml@npm:^4.1.0, js-yaml@npm:^4.1.1":',
  '-  version: 4.1.1',
  '-  resolution: "js-yaml@npm:4.1.1"',
  '-  dependencies:',
  '-    argparse: "npm:^2.0.1"',
  '-  languageName: node',
  '-  linkType: hard',
  '-',
].join('\n');

const NEW_PACKAGE = [
  '@@ -1,0 +1,4 @@',
  '+"left-pad@npm:^1.3.0":',
  '+  version: 1.3.0',
  '+  resolution: "left-pad@npm:1.3.0"',
  '+  languageName: node',
].join('\n');

const lock = (patch: string, extra: Record<string, unknown> = {}) => ({ path: 'yarn.lock', patch, mode: '100644', ...extra });

describe('REL-1136: calltelemetry/cisco-cdr#4625 (.tool-versions)', () => {
  it('pins the roster the failure named', () => {
    expect(enabled().map((persona) => persona.id)).toEqual(['arch-lane', 'sec-lane', 'documentation']);
  });

  it('routes the .tool-versions change to the required lane, which receives the patch', () => {
    const result = resolveReviewApplicability(enabled(), [{ path: '.tool-versions', patch: CISCO_CDR_4625_TOOL_VERSIONS }]);
    expect(result.unmatchedPaths).toEqual([]);
    expect(result.noReviewableContent).toBe(false);
    expect(result.applicable.map((persona) => persona.id)).toEqual(['sec-lane']);
    expect(result.routedFiles).toEqual([{ path: '.tool-versions', laneIds: ['sec-lane'], reason: 'fallback' }]);
    expect(scopeFilesForPersona(result.applicable[0], result.effectiveFiles).map((file) => file.patch))
      .toEqual([CISCO_CDR_4625_TOOL_VERSIONS]);
    expect(isNoReviewableContentFile({ path: '.tool-versions', patch: CISCO_CDR_4625_TOOL_VERSIONS })).toBe(false);
  });

  it.each([
    '.tool-versions', 'apps/web/.nvmrc', '.node-version', '.python-version', '.ruby-version', '.java-version',
    '.go-version', '.bun-version', '.terraform-version', '.sdkmanrc', 'rust-toolchain', 'rust-toolchain.toml',
    'go.mod', 'k8s-operator/go.mod', 'go.work', 'Gemfile', 'Pipfile', 'infra/.terraform.lock.hcl',
    'requirements.txt', 'requirements-dev.txt', 'svc/requirements.in', 'constraints.txt',
  ])('reviews %s by the required lane, never exempts it', (path) => {
    expect(isToolchainPinOrDependencyManifestPath(path)).toBe(true);
    const patch = '@@ -1 +1 @@\n-a 1\n+a 2\n';
    const result = resolveReviewApplicability(enabled(), [{ path, patch }]);
    expect(result.unmatchedPaths).toEqual([]);
    expect(result.noReviewableContent).toBe(false);
    // sec-lane either covers it by its own paths (go.mod, Gemfile, ...) or it is routed there.
    expect(result.applicable.map((persona) => persona.id)).toEqual(['sec-lane']);
    expect(scopeFilesForPersona(result.applicable[0], result.effectiveFiles).map((file) => file.path)).toEqual([path]);
    // With no persona covering it by paths, it is routed -- not failed.
    const narrow = resolveReviewApplicability(enabled('architecture,documentation'), [{ path, patch }]);
    expect(narrow.unmatchedPaths).toEqual([]);
    expect(narrow.applicable.length).toBeGreaterThan(0);
  });

  it('never treats a requirements file as documentation (it used to be exempt as .txt prose)', () => {
    expect(isDocumentationOrAssetPath('requirements.txt')).toBe(false);
    expect(isNoReviewableContentFile({ path: 'requirements.txt', patch: '@@ -1 +1 @@\n-x==1\n+x==2\n' })).toBe(false);
    const result = resolveReviewApplicability(enabled(), [
      { path: 'README.md', patch: '@@ -1 +1 @@\n-a\n+b\n' },
      { path: 'requirements.txt', patch: '@@ -1 +1 @@\n-x==1\n+evil==2\n' },
    ]);
    expect(result.noReviewableContent).toBe(false);
    expect(result.applicable.map((persona) => persona.id)).toContain('sec-lane');
    const sec = result.applicable.find((persona) => persona.id === 'sec-lane')!;
    expect(scopeFilesForPersona(sec, result.effectiveFiles).map((file) => file.path)).toEqual(['requirements.txt']);
    // On a roster with no persona covering it, the README used to carry it through the documentation exemption.
    const narrow = resolveReviewApplicability(enabled('documentation'), [
      { path: 'README.md', patch: '@@ -1 +1 @@\n-a\n+b\n' },
      { path: 'requirements.txt', patch: '@@ -1 +1 @@\n-x==1\n+evil==2\n' },
    ]);
    expect(narrow.noReviewableContent).toBe(false);
    expect(narrow.routedFiles.map((file) => file.path)).toEqual(['requirements.txt']);
  });

  it.each(['notes.txt', 'docs/requirements-overview.md', 'tool-versions.md', 'my.nvmrc.txt', 'go.mod.md'])(
    'leaves %s as it was (documentation)',
    (path) => {
      expect(isToolchainPinOrDependencyManifestPath(path)).toBe(false);
      expect(isDocumentationOrAssetPath(path)).toBe(true);
    },
  );

  it('keeps a toolchain pin beside uncovered source a coverage failure on the source', () => {
    const result = resolveReviewApplicability(enabled(), [
      { path: '.tool-versions', patch: CISCO_CDR_4625_TOOL_VERSIONS },
      { path: 'tools/load.lua', patch: '@@ -1 +1 @@\n-a\n+b\n' },
    ]);
    expect(result.applicable).toEqual([]);
    expect(result.unmatchedPaths).toEqual(['tools/load.lua']);
  });
});

describe('REL-1136: calltelemetry/ct-quasar#847 (yarn.lock adds a new package)', () => {
  it('is refused by the strict check only for the new entry', () => {
    expect(NEW_PACKAGE_ENTRY_REFUSAL).toBe('adds a new package entry');
    expect(verifyLockfileOnlyChange('yarn.lock', CT_QUASAR_847_YARN_LOCK)).toEqual({ ok: false, reason: NEW_PACKAGE_ENTRY_REFUSAL });
    expect(verifyLockfileOnlyChange('yarn.lock', CT_QUASAR_847_YARN_LOCK, { allowNewEntries: true })).toEqual({ ok: true });
    expect(isNewPackageLockfileChange(lock(CT_QUASAR_847_YARN_LOCK))).toBe(true);
  });

  it('routes the lockfile to the required lane with its patch, never the exemption', () => {
    const result = resolveReviewApplicability(enabled(), [lock(CT_QUASAR_847_YARN_LOCK)]);
    expect(result.unmatchedPaths).toEqual([]);
    expect(result.unverifiedLockfiles).toEqual([]);
    expect(result.noReviewableContent).toBe(false);
    expect(result.noReviewableContentKind).toBeNull();
    expect(result.applicable.map((persona) => persona.id)).toEqual(['sec-lane']);
    expect(result.routedFiles).toEqual([{ path: 'yarn.lock', laneIds: ['sec-lane'], reason: 'new-package-lockfile' }]);
    const scoped = scopeFilesForPersona(result.applicable[0], result.effectiveFiles);
    expect(scoped.map((file) => file.patch)).toEqual([CT_QUASAR_847_YARN_LOCK]);
    expect(scoped[0].patch).toContain('+"side-channel@npm:^1.1.1":');
  });

  it('routes it to the dependency lane as well when the roster enables one', () => {
    const result = resolveReviewApplicability(enabled('architecture,security,dependencies'), [lock(CT_QUASAR_847_YARN_LOCK)]);
    expect(result.applicable.map((persona) => persona.id).sort()).toEqual(['dep-lane', 'sec-lane']);
    const routed = result.routedFiles.find((file) => file.path === 'yarn.lock');
    expect(routed?.laneIds.sort()).toEqual(['dep-lane', 'sec-lane']);
    expect(routed?.reason).toBe('new-package-lockfile');
    for (const persona of result.applicable) {
      expect(scopeFilesForPersona(persona, result.effectiveFiles).map((file) => file.path)).toEqual(['yarn.lock']);
    }
  });

  it('routes it to a dependency-chartered persona whatever its id', () => {
    const base = enabled('architecture,documentation');
    const custom = [...base, { ...base[0], id: 'supply-chain', charter: 'builtin:dependency-health', paths: ['nothing/**'], required: false }];
    expect(isDependencyPersona({ id: 'supply-chain', charter: 'builtin:dependency-health' })).toBe(true);
    expect(isDependencyPersona({ id: 'arch-lane', charter: 'builtin:architecture' })).toBe(false);
    const result = resolveReviewApplicability(custom, [lock(CT_QUASAR_847_YARN_LOCK)]);
    // Without the charter match this falls back to the first persona (arch-lane).
    expect(result.applicable.map((persona) => persona.id)).toEqual(['supply-chain']);
    expect(routeNewPackageLockfiles(custom, ['yarn.lock']).find((persona) => persona.id === 'supply-chain')?.routedPaths)
      .toEqual(['yarn.lock']);
  });

  it('labels the lockfile new-package-lockfile beside uncovered source a configured lane widens to', () => {
    // sec-lane's own paths name yarn.lock, so a configured lane applies and
    // REL-1088 routes the uncovered source to it too; both reasons are kept apart.
    const result = resolveReviewApplicability(enabled(), [
      lock(CT_QUASAR_847_YARN_LOCK),
      { path: 'tools/load.lua', patch: '@@ -1 +1 @@\n-a\n+b\n' },
    ]);
    expect(result.unmatchedPaths).toEqual([]);
    expect(result.routedFiles.map((file) => [file.path, file.reason]).sort()).toEqual([
      ['tools/load.lua', 'uncovered-source'],
      ['yarn.lock', 'new-package-lockfile'],
    ]);
  });

  it('routes it to the first enabled persona when the roster has no required or dependency lane', () => {
    const result = resolveReviewApplicability(enabled('architecture,documentation'), [lock(CT_QUASAR_847_YARN_LOCK)]);
    expect(result.applicable.map((persona) => persona.id)).toEqual(['arch-lane']);
  });

  it('keeps a docs file beside it out of the exemption and reviews the lockfile', () => {
    const result = resolveReviewApplicability(enabled(), [
      { path: 'CHANGELOG.md', patch: '@@ -1 +1 @@\n-a\n+b\n' },
      lock(CT_QUASAR_847_YARN_LOCK),
    ]);
    expect(result.noReviewableContent).toBe(false);
    expect(result.routedFiles.map((file) => [file.path, file.reason])).toEqual([['yarn.lock', 'new-package-lockfile']]);
  });

  it('discloses the routed lockfile in the check summary', () => {
    const result = resolveReviewApplicability(enabled(), [lock(CT_QUASAR_847_YARN_LOCK)]);
    expect(renderRoutedFiles({ routedFiles: result.routedFiles })).toContain('`yarn.lock` -> `sec-lane` (lockfile adds a new package)');
  });

  it('keeps the re-keyed ct-quasar#887 bump on the lockfile-only exemption (nothing routed, no lane)', () => {
    const result = resolveReviewApplicability(enabled(), [lock(CT_QUASAR_887_YARN_LOCK)]);
    expect(result.noReviewableContentKind).toBe('lockfile-only');
    expect(result.applicable).toEqual([]);
    expect(result.effectiveFiles).toEqual([]);
  });

  it('both engines reach a lane for #847 and #4625 instead of the coverage failure', async () => {
    const headSha = 'f'.repeat(40);
    for (const changedFiles of [[lock(CT_QUASAR_847_YARN_LOCK)], [{ path: '.tool-versions', patch: CISCO_CDR_4625_TOOL_VERSIONS }]]) {
      for (const run of [
        () => executePersonaPanel({ config: roster(), changedFiles, repository: 'calltelemetry/ct-quasar', headSha, client: unreachableClient, deterministicRoster: true }),
        () => executeComposedReview({ config: roster(), changedFiles, repository: 'calltelemetry/ct-quasar', headSha, client: unreachableClient }),
      ]) {
        const outcome = await run().then(() => null, (error: unknown) => error);
        if (outcome) expect((outcome as Error).message).not.toMatch(/no enabled persona applies/);
      }
    }
  });
});

describe('REL-1136: what a new-package lockfile may NOT hide (still fails closed for a human)', () => {
  it.each([
    ['a new package from a git source', [
      '@@ -1,0 +1,3 @@',
      '+"left-pad@npm:^1.3.0":',
      '+  version: 1.3.0',
      '+  resolution: "left-pad@git+ssh://git@github.com/evil/left-pad.git#abc"',
    ].join('\n')],
    ['a new package resolved to a different package', [
      '@@ -1,0 +1,3 @@',
      '+"left-pad@npm:^1.3.0":',
      '+  version: 1.3.0',
      '+  resolution: "evil-pkg@npm:1.3.0"',
    ].join('\n')],
    ['a new package with a tarball URL off the registry', [
      '@@ -1,0 +1,3 @@',
      '+"left-pad@^1.3.0":',
      '+  version "1.3.0"',
      '+  resolved "https://evil.example.com/left-pad-1.3.0.tgz"',
    ].join('\n')],
    ['a new package with an escape sequence', [
      '@@ -1,0 +1,2 @@',
      '+"left-pad@npm:^1.3.0":',
      '+  resolution: "left-pad@npm:1.3.0\\u0022"',
    ].join('\n')],
  ])('%s', (_label, patch) => {
    expect(isNewPackageLockfileChange(lock(patch))).toBe(false);
    const result = resolveReviewApplicability(enabled(), [lock(patch)]);
    expect(result.applicable).toEqual([]);
    expect(result.unmatchedPaths).toEqual(['yarn.lock']);
    expect(result.unverifiedLockfiles.map((file) => file.path)).toEqual(['yarn.lock']);
    expect(result.effectiveFiles).toEqual([]);
  });

  it('a new-package patch larger than one lane reads whole', () => {
    const filler = Array.from({ length: Math.ceil(MAX_FILE_PATCH_CHARS / 20) }, (_, i) => `+    dep-${i}: "npm:^1.0.0"`).join('\n');
    const big = `${NEW_PACKAGE}\n+  dependencies:\n${filler}`;
    expect(big.length).toBeGreaterThan(MAX_FILE_PATCH_CHARS);
    expect(verifyLockfileOnlyChange('yarn.lock', big, { allowNewEntries: true })).toEqual({ ok: true });
    const result = resolveReviewApplicability(enabled(), [lock(big)]);
    expect(result.applicable).toEqual([]);
    expect(result.unmatchedPaths).toEqual(['yarn.lock']);
  });

  it.each([
    ['a symlink', { mode: '120000' }],
    ['a gitlink', { isSubmodule: true }],
  ])('a new-package lockfile that is %s', (_label, extra) => {
    const result = resolveReviewApplicability(enabled(), [lock(NEW_PACKAGE, extra)]);
    expect(result.applicable).toEqual([]);
    expect(result.unmatchedPaths).toEqual(['yarn.lock']);
  });

  it('a lockfile whose patch GitHub omitted', () => {
    expect(isNewPackageLockfileChange(lock(''))).toBe(false);
    const result = resolveReviewApplicability(enabled(), [lock('')]);
    expect(result.applicable).toEqual([]);
    expect(result.unverifiedLockfiles.map((file) => file.reason).join(' ')).not.toBe('');
    expect(OMITTED_LOCKFILE_PATCH_REASON.length).toBeGreaterThan(0);
  });

  it('a new-package lockfile a path_filters pattern excluded stays excluded', () => {
    const result = resolveReviewApplicability(enabled(), [lock(NEW_PACKAGE)], { pathFilters: ['yarn.lock'] });
    expect(result.applicable).toEqual([]);
    expect(result.effectiveFiles).toEqual([]);
    expect(result.unmatchedPaths).toEqual(['yarn.lock']);
  });

  it('a new-package lockfile cannot launder uncovered source into a review', () => {
    // A roster none of whose personas covers yarn.lock by its own paths. (On the
    // default roster sec-lane's own paths name yarn.lock, so a configured lane
    // applies and REL-1088 routes the source to it; that is unchanged.)
    const result = resolveReviewApplicability(enabled('architecture,documentation'), [
      lock(NEW_PACKAGE),
      { path: 'tools/load.lua', patch: '@@ -1 +1 @@\n-a\n+b\n' },
    ]);
    expect(result.applicable).toEqual([]);
    expect(result.unmatchedPaths).toEqual(['tools/load.lua']);
  });
});

describe('REL-1136: the trusted completion side derives the same lanes', () => {
  const target = { repositoryId: 123, owner: 'calltelemetry', repo: 'ct-quasar', prNumber: 847,
    headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) };
  const current = { ...target, open: true, draft: false };
  function prepared(personas: string) {
    const content = JSON.stringify({ schema: 'calltelemetry.review-policy.v1', review_yeti: {
      personas, budget: { max_investigation_turns: 3 },
    } });
    return preparePublishingPolicy({ content, source: { repositoryId: 456, repository: 'example/central-policy',
      sha: 'c'.repeat(40), path: 'policy/review.json', contentDigest: sha256(content) } },
    { baseUrl: 'https://gateway.example.invalid/v1', model: 'review-model' });
  }
  function context(personas: string, changedFiles: Array<{ path: string; patch: string }>) {
    const stored = prepared(personas);
    const gate: StoredReviewGate = {
      coordinates: { ...target, runId: `run_${'1'.repeat(32)}`, policyDigest: stored.policy.effectivePolicyDigest,
        attemptId: `run_${'1'.repeat(32)}-g0-e2`, executionAttempt: 2 },
      reviewGeneration: 0, expectedAppId: 1234, externalId: 'service-gate', checkId: 456,
      creationState: 'bound', desiredState: 'in_progress', desiredVersion: 1, publishedVersion: 1, current: true,
    };
    const exactCurrentDiff = vi.fn<AuthoritativeReviewReader['exactCurrentDiff']>(async () => (
      { current: { ...current }, diff: '', expectedFileCount: changedFiles.length, changedFiles }));
    const options: AuthoritativeCompletionContextOptions = {
      getStoredPrepared: async () => stored,
      readerFactory: async () => ({ currentCandidate: async () => ({ ...current }), exactCurrentDiff }) as never,
      publishingResolver: { resolve: async () => ({ current: { ...current }, prepared: structuredClone(stored),
        identity: buildAuthoritativeReviewIdentity({ requested: target, current, policy: stored.policy }) }) },
    };
    return createAuthoritativeCompletionContext(options)(gate);
  }

  it.each([
    ['ct-quasar#847 yarn.lock', [{ path: 'yarn.lock', patch: CT_QUASAR_847_YARN_LOCK }]],
    ['cisco-cdr#4625 .tool-versions', [{ path: '.tool-versions', patch: CISCO_CDR_4625_TOOL_VERSIONS }]],
  ])('requires the routed lane for %s instead of refusing coverage-no-persona', async (_label, files) => {
    const resolved = await context('security,testing', files);
    expect(resolved.coverage.expectedPersonaIds).toEqual(['sec-lane']);
  });

  it('still refuses a new package from a git source as coverage-no-persona', async () => {
    const gitSource = ['@@ -1,0 +1,2 @@', '+"left-pad@npm:^1.3.0":',
      '+  resolution: "left-pad@git+ssh://git@github.com/evil/left-pad.git#abc"'].join('\n');
    const error = await context('security,testing', [{ path: 'yarn.lock', patch: gitSource }])
      .then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(TrustedCompletionResolutionError);
    expect((error as TrustedCompletionResolutionError).reason).toBe('coverage-no-persona');
  });
});
