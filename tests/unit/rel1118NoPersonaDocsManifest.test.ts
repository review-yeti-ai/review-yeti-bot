import { describe, expect, it } from 'vitest';
import { resolveWorkerConfig } from '../../src/config/publishingWorkerConfig';
import { executeComposedReview } from '../../src/panel/composedEngine';
import { executePersonaPanel } from '../../src/panel/panelEngine';
import type { ReviewModelClient } from '../../src/gateway/openRouterClient';
import { resolveReviewApplicability, scopeFilesForPersona } from '../../src/review/personaApplicability';
import { verifyLockfileOnlyChange } from '../../src/review/lockfileChangeVerification';
import { isNoReviewableContentFile } from '../../src/review/reviewableContent';

/**
 * REL-1118: three PRs failed Review Yeti on 2026-09-25 with
 * "no enabled persona applies to the changed paths", on the roster
 * [arch-lane, sec-lane, documentation]:
 *
 * - calltelemetry/ct-uat#1512 and #1515 each change one HTML benchmark report
 *   under docs/. HTML was not documentation (it can carry script), not
 *   data/config and not fallback-routed, and no persona's paths named it.
 *   An uncovered HTML page is now routed to the roster's required lane, as an
 *   .mdx page is -- reviewed, never exempted.
 * - calltelemetry/ct-ai-mcp#76 is a Dependabot yarn.lock-only bump. Every added
 *   source stays on the npm registry, but vite-plugin-dts pins unplugin-dts
 *   exactly, so the entry header is re-keyed ("unplugin-dts@npm:1.1.0" ->
 *   "unplugin-dts@npm:1.1.1") and verbatim header matching refused it as "adds
 *   a new package entry". A header now replaces a removed header binding the
 *   same package names; a genuinely new package is still refused.
 *
 * Both are decided in the shared resolveReviewApplicability, so the panel
 * engine, the composed engine and the trusted completion context agree.
 */

const transport = { baseUrl: 'https://gateway.example.invalid/v1', apiKey: 'k', model: 'review-model' };
const roster = () => resolveWorkerConfig({ REVIEW_PERSONAS: 'architecture,security,documentation' }, transport);
const enabled = () => roster().personas.filter((persona) => persona.enabled);

const unreachableClient = new Proxy({}, {
  get() { throw new Error('the model client must not be consulted'); },
}) as unknown as ReviewModelClient;

const HTML_PATCH = '@@ -0,0 +1,3 @@\n+<!doctype html>\n+<html><body><h1>Capacity</h1>\n+<script>render()</script></body></html>\n';
const CT_UAT_1512 = 'docs/uat/benchmarks/2026-09-23-curri-sizing-0.8.6.25/capacity-and-knee-analysis.html';
const CT_UAT_1515 = 'docs/uat/benchmarks/2026-09-23-curri-sizing-0.8.6.25/uc-admin-sizing-guide.html';

/** The exact yarn.lock patch of calltelemetry/ct-ai-mcp#76 (head e1dfeb92). */
const CT_AI_MCP_76_YARN_LOCK = [
  '@@ -2593,8 +2593,8 @@ __metadata:',
  '   linkType: hard',
  ' ',
  ' "tsx@npm:^4.23.13":',
  '-  version: 4.23.13',
  '-  resolution: "tsx@npm:4.23.13"',
  '+  version: 4.23.15',
  '+  resolution: "tsx@npm:4.23.15"',
  '   dependencies:',
  '     esbuild: "npm:~0.28.0"',
  '     fsevents: "npm:~2.3.3"',
  '@@ -2603,7 +2603,7 @@ __metadata:',
  '       optional: true',
  '   bin:',
  '     tsx: dist/cli.mjs',
  '-  checksum: 10c0/dc99c8988b42ec2443963a0b9051f42d068bc7e2a44e82f3b94b40539a991c5c01ea3ee049cf317d1040b2245711dd4c64ace9ac875f3b07edee29f610702e3c',
  '+  checksum: 10c0/3c5fc53e578da87d3a63565286b1ecbb0e01b9bb646daec1957294ef890d14f22cc67bb4b09b5daffab0e7ce0217b1e7645393feb0f524b1ddf26ae9595d7e75',
  '   languageName: node',
  '   linkType: hard',
  ' ',
  '@@ -2666,9 +2666,9 @@ __metadata:',
  '   languageName: node',
  '   linkType: hard',
  ' ',
  '-"unplugin-dts@npm:1.1.0":',
  '-  version: 1.1.0',
  '-  resolution: "unplugin-dts@npm:1.1.0"',
  '+"unplugin-dts@npm:1.1.1":',
  '+  version: 1.1.1',
  '+  resolution: "unplugin-dts@npm:1.1.1"',
  '   dependencies:',
  '     "@rollup/pluginutils": "npm:^5.1.4"',
  '     "@volar/typescript": "npm:^2.4.26"',
  '@@ -2706,7 +2706,7 @@ __metadata:',
  '       optional: true',
  '     webpack:',
  '       optional: true',
  '-  checksum: 10c0/ec84d6832d0eee1d99db9c31d8da9aff0bb693836d055c0415f07d00c04006bbcccaeb3904ec0256a036303b83c8c5cd4f7bcd090904ee44288f3c8511b78314',
  '+  checksum: 10c0/21759ef53f4dd99b2d87af672509ae2c791454cb136bf843d890c7773a9e5a5a13af15c62caaa1020f622da07c23de94ee2a0e0bd23539a9fedb9b461158f975',
  '   languageName: node',
  '   linkType: hard',
  ' ',
  '@@ -2730,10 +2730,10 @@ __metadata:',
  '   linkType: hard',
  ' ',
  ' "vite-plugin-dts@npm:^5.1.0":',
  '-  version: 5.1.0',
  '-  resolution: "vite-plugin-dts@npm:5.1.0"',
  '+  version: 5.1.1',
  '+  resolution: "vite-plugin-dts@npm:5.1.1"',
  '   dependencies:',
  '-    unplugin-dts: "npm:1.1.0"',
  '+    unplugin-dts: "npm:1.1.1"',
  '   peerDependencies:',
  '     "@microsoft/api-extractor": ">=7"',
  '     rollup: ">=3"',
  '@@ -2745,7 +2745,7 @@ __metadata:',
  '       optional: true',
  '     vite:',
  '       optional: true',
  '-  checksum: 10c0/14c4d734c9d5f7c9ebb3c5c39cc0b8ba177c699e6a240be75aa302aca85b1468368f52d74a436cfaccbc2fdf05b3c46dccd3a9a50daea1f4dda5f012a863321f',
  '+  checksum: 10c0/50ca9256dd86f646eb88d5f67b1658944e03b0056974d4f7c9940ca48e7caad18cd175a2f19c6ff3374267c4a5681ec053634cbcdd43b4b472a53b4b43cec202',
  '   languageName: node',
  '   linkType: hard',
  ' ',
].join('\n');

describe('REL-1118: the exact roster and paths of the three failing PRs', () => {
  it('pins the roster the failure named', () => {
    expect(enabled().map((persona) => persona.id)).toEqual(['arch-lane', 'sec-lane', 'documentation']);
  });

  it.each([['ct-uat#1512', CT_UAT_1512], ['ct-uat#1515', CT_UAT_1515]])(
    '%s: routes the uncovered HTML report to the required lane instead of failing',
    (_label, path) => {
      const result = resolveReviewApplicability(enabled(), [{ path, patch: HTML_PATCH }]);
      expect(result.unmatchedPaths).toEqual([]);
      expect(result.noReviewableContent).toBe(false);
      expect(result.applicable.length).toBeGreaterThan(0);
      for (const persona of result.applicable) expect(persona.required).toBe(true);
      expect(result.routedFiles).toEqual([
        { path, laneIds: result.applicable.map((persona) => persona.id), reason: 'fallback' },
      ]);
      // The routed lane actually receives the page, script included.
      expect(scopeFilesForPersona(result.applicable[0], result.effectiveFiles).map((file) => file.patch))
        .toEqual([HTML_PATCH]);
      // Never the documentation exemption: HTML can execute.
      expect(isNoReviewableContentFile({ path, patch: HTML_PATCH })).toBe(false);
    },
  );

  it('ct-ai-mcp#76: verifies the re-keyed yarn.lock bump and takes the lockfile-only exemption', () => {
    expect(verifyLockfileOnlyChange('yarn.lock', CT_AI_MCP_76_YARN_LOCK)).toEqual({ ok: true });
    const result = resolveReviewApplicability(enabled(), [{ path: 'yarn.lock', patch: CT_AI_MCP_76_YARN_LOCK, mode: '100644' }]);
    expect(result.unmatchedPaths).toEqual([]);
    expect(result.unverifiedLockfiles).toEqual([]);
    expect(result.noReviewableContent).toBe(true);
    expect(result.noReviewableContentKind).toBe('lockfile-only');
  });

  it('both engines take the same outcome for all three PRs without a model call for the lockfile', async () => {
    const headSha = 'e'.repeat(40);
    for (const run of [
      () => executePersonaPanel({ config: roster(), changedFiles: [{ path: 'yarn.lock', patch: CT_AI_MCP_76_YARN_LOCK }], repository: 'calltelemetry/ct-ai-mcp', headSha, client: unreachableClient, deterministicRoster: true }),
      () => executeComposedReview({ config: roster(), changedFiles: [{ path: 'yarn.lock', patch: CT_AI_MCP_76_YARN_LOCK }], repository: 'calltelemetry/ct-ai-mcp', headSha, client: unreachableClient }),
    ]) {
      await expect(run()).resolves.toBeTruthy();
    }
    for (const path of [CT_UAT_1512, CT_UAT_1515]) {
      // The HTML diffs reach a lane (the unreachable client), never the coverage failure.
      for (const run of [
        () => executePersonaPanel({ config: roster(), changedFiles: [{ path, patch: HTML_PATCH }], repository: 'calltelemetry/ct-uat', headSha, client: unreachableClient, deterministicRoster: true }),
        () => executeComposedReview({ config: roster(), changedFiles: [{ path, patch: HTML_PATCH }], repository: 'calltelemetry/ct-uat', headSha, client: unreachableClient }),
      ]) {
        const outcome = await run().then(() => null, (error: unknown) => error);
        if (outcome) expect((outcome as Error).message).not.toMatch(/no enabled persona applies/);
      }
    }
  });
});

describe('REL-1118: re-keyed lockfile entries, and what stays refused', () => {
  it.each([
    ['a yarn berry exact-pin re-key', 'yarn.lock', [
      '@@ -1,3 +1,3 @@',
      '-"unplugin-dts@npm:1.1.0":',
      '-  version: 1.1.0',
      '-  resolution: "unplugin-dts@npm:1.1.0"',
      '+"unplugin-dts@npm:1.1.1":',
      '+  version: 1.1.1',
      '+  resolution: "unplugin-dts@npm:1.1.1"',
    ].join('\n')],
    ['a yarn v1 range re-key', 'yarn.lock', [
      '@@ -1,3 +1,3 @@',
      '-"@types/node@^20.0.0":',
      '+"@types/node@^20.2.0":',
      '   version "20.2.0"',
      '   resolved "https://registry.yarnpkg.com/@types/node/-/node-20.2.0.tgz#def"',
    ].join('\n')],
    ['an npm entry hoisted to the top level', 'package-lock.json', [
      '@@ -1,4 +1,4 @@',
      '-    "node_modules/a/node_modules/lodash": {',
      '+    "node_modules/lodash": {',
      '       "version": "4.17.21",',
      '       "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",',
    ].join('\n')],
  ])('verifies %s', (_label, path, body) => {
    expect(verifyLockfileOnlyChange(path, body)).toEqual({ ok: true });
  });

  it.each([
    ['a re-key to a different package', 'yarn.lock', [
      '@@ -1,2 +1,2 @@',
      '-"unplugin-dts@npm:1.1.0":',
      '+"evil-pkg@npm:1.1.1":',
      '+  resolution: "evil-pkg@npm:1.1.1"',
    ].join('\n'), 'adds a new package entry'],
    ['a second entry for a package whose one entry was re-keyed', 'yarn.lock', [
      '@@ -1,2 +1,4 @@',
      '-"unplugin-dts@npm:1.1.0":',
      '+"unplugin-dts@npm:1.1.1":',
      '+  resolution: "unplugin-dts@npm:1.1.1"',
      '+"unplugin-dts@npm:2.0.0":',
      '+  resolution: "unplugin-dts@npm:2.0.0"',
    ].join('\n'), 'adds a new package entry'],
    ['a header that widens the names it binds', 'yarn.lock', [
      '@@ -1,2 +1,2 @@',
      '-"victim@npm:^1.0.0":',
      '+"victim@npm:^1.0.0, evil-pkg@npm:^1.0.0":',
    ].join('\n'), 'adds a new package entry'],
    ['a new entry replacing the unnamed metadata header', 'yarn.lock', [
      '@@ -1,2 +1,2 @@',
      '-__metadata:',
      '+__evil:',
    ].join('\n'), 'adds a new package entry'],
    ['an npm entry re-keyed to another package', 'package-lock.json', [
      '@@ -1,3 +1,3 @@',
      '-    "node_modules/lodash": {',
      '+    "node_modules/evil-pkg": {',
      '+      "resolved": "https://registry.npmjs.org/evil-pkg/-/evil-pkg-1.0.0.tgz",',
    ].join('\n'), 'adds a new package entry'],
    ['a re-keyed entry resolved to another package', 'yarn.lock', [
      '@@ -1,2 +1,2 @@',
      '-"unplugin-dts@npm:1.1.0":',
      '+"unplugin-dts@npm:1.1.1":',
      '+  resolution: "evil-pkg@npm:1.1.1"',
    ].join('\n'), 'resolves an entry to a different package'],
  ])('refuses %s', (_label, path, body, reason) => {
    expect(verifyLockfileOnlyChange(path, body)).toEqual({ ok: false, reason });
  });

  it.each(['site/index.htm', 'reports/run.xhtml', 'docs/REPORT.HTML'])('routes an uncovered %s like .html', (path) => {
    const result = resolveReviewApplicability(enabled(), [{ path, patch: HTML_PATCH }]);
    expect(result.unmatchedPaths).toEqual([]);
    expect(result.routedFiles.map((file) => [file.path, file.reason])).toEqual([[path, 'fallback']]);
  });

  it.each(['docs/page.hta', 'docs/page.shtml', 'docs/page.htmlx'])('does not route %s as an HTML page', (path) => {
    const result = resolveReviewApplicability(enabled(), [{ path, patch: HTML_PATCH }]);
    expect(result.routedFiles).toEqual([]);
    expect(result.unmatchedPaths).toEqual([path]);
  });

  it('keeps an uncovered HTML page beside uncovered source a coverage failure', () => {
    const result = resolveReviewApplicability(enabled(), [
      { path: CT_UAT_1512, patch: HTML_PATCH },
      { path: 'tools/load.lua', patch: HTML_PATCH },
    ]);
    expect(result.applicable).toEqual([]);
    expect(result.unmatchedPaths).toEqual(['tools/load.lua']);
  });
});
