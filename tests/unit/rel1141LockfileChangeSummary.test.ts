import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { summarizeLockfileChange } from '../../src/review/lockfileChangeSummary';
import { oversizedLockfileSummary } from '../../src/review/newPackageLockfileReview';

/**
 * REL-1141: the deterministic package-change summary a lane receives in place
 * of an oversized lockfile patch. Complete (every added, removed or
 * re-versioned entry) or refused -- never a guess.
 */

const PR30_LOCK = readFileSync(path.resolve(__dirname, '../fixtures/rel1141/openclaw-linear-plugin-30.package-lock.json.patch'), 'utf8');

function ok(result: ReturnType<typeof summarizeLockfileChange>): string {
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.text;
}

describe('REL-1141: npm (package-lock.json)', () => {
  it('lists all four new packages and every version bump of openclaw-linear-plugin#30', () => {
    const result = summarizeLockfileChange('package-lock.json', PR30_LOCK);
    expect(result.ok).toBe(true);
    const text = ok(result);
    expect(text).toContain([
      'Added packages (4):',
      '  @koromix/koffi-android-arm64@3.2.1',
      '  @koromix/koffi-android-x64@3.2.1',
      '  @koromix/koffi-linux-arm@3.2.1',
      '  import-meta-resolve@4.2.0',
    ].join('\n'));
    expect(text).toContain('Changed versions (50):');
    expect(text).toContain('  openclaw: 2026.9.4 -> 2026.9.5');
    expect(text).toContain('  tslog: 4.11.0 -> 5.1.0');
    expect(text).not.toContain('Removed packages');
    // Every added "version" line of the patch is accounted for: 50 bumps + 4 new entries.
    expect(PR30_LOCK.split('\n').filter((line) => /^\+\s*"version":/u.test(line))).toHaveLength(54);
    expect(result.ok && result.packageChanges).toBe(54);
    // The root project's devDependencies range change is outside any visible entry and is counted, not dropped.
    expect(text).toContain('Changed lines outside any entry header the patch shows (dependency ranges or lockfile metadata): 2.');
    expect(summarizeLockfileChange('package-lock.json', PR30_LOCK)).toEqual(result);
  });

  it('reports removals and nested node_modules entries by package name', () => {
    const text = ok(summarizeLockfileChange('package-lock.json', [
      '@@ -40,11 +40,6 @@',
      '       "license": "MIT"',
      '     },',
      '-    "node_modules/a/node_modules/old-dep": {',
      '-      "version": "0.1.0",',
      '-      "resolved": "https://registry.npmjs.org/old-dep/-/old-dep-0.1.0.tgz",',
      '-      "license": "MIT"',
      '-    },',
      '     "node_modules/b": {',
      '       "version": "1.0.0",',
    ].join('\n')));
    expect(text).toContain('Removed packages (1):\n  old-dep@0.1.0');
  });

  it('attributes a dependency literally named "version" inside a range map, without refusing', () => {
    const text = ok(summarizeLockfileChange('package-lock.json', [
      '@@ -1,8 +1,8 @@',
      '     "node_modules/x": {',
      '       "version": "1.0.0",',
      '       "peerDependencies": {',
      '-        "version": "^1.0.0"',
      '+        "version": "^2.0.0"',
      '       }',
    ].join('\n')));
    expect(text).toContain('Entries with other field changes only');
    expect(text).toMatch(/\n {2}x\n/u);
    expect(text).toContain('No package entry was added, removed or re-versioned.');
  });

  it('refuses a version change whose entry header the patch does not show', () => {
    expect(summarizeLockfileChange('package-lock.json', [
      '@@ -100,4 +100,4 @@',
      '-      "version": "1.0.0",',
      '+      "version": "6.6.6",',
      '       "license": "MIT"',
    ].join('\n'))).toEqual({ ok: false, reason: 'changes a package version whose entry the patch does not show' });
  });
});

describe('REL-1141: yarn.lock', () => {
  it('reads berry: a bump, a new transitive package and a re-key (ct-quasar#847 shape)', () => {
    const text = ok(summarizeLockfileChange('yarn.lock', [
      '@@ -12462,11 +12462,12 @@ __metadata:',
      '   linkType: hard',
      ' ',
      ' "qs@npm:~6.15.1":',
      '-  version: 6.15.2',
      '-  resolution: "qs@npm:6.15.2"',
      '+  version: 6.15.3',
      '+  resolution: "qs@npm:6.15.3"',
      '   dependencies:',
      '@@ -13568,7 +13569,7 @@ __metadata:',
      '   linkType: hard',
      ' ',
      '-"side-channel-list@npm:^1.0.0":',
      '+"side-channel-list@npm:^1.0.0, side-channel-list@npm:^1.0.1":',
      '   version: 1.0.1',
      '   resolution: "side-channel-list@npm:1.0.1"',
      '@@ -13616,6 +13617,9 @@ __metadata:',
      '   linkType: hard',
      ' ',
      '+"side-channel@npm:^1.1.1":',
      '+  version: 1.1.1',
      '+  resolution: "side-channel@npm:1.1.1"',
      ' "siginfo@npm:^2.0.0":',
    ].join('\n')));
    expect(text).toContain('Added packages (1):\n  side-channel@1.1.1');
    expect(text).toContain('Changed versions (1):\n  qs: 6.15.2 -> 6.15.3');
    expect(text).toContain('  side-channel-list@1.0.1');
  });

  it('reads v1', () => {
    const text = ok(summarizeLockfileChange('yarn.lock', [
      '@@ -10,4 +10,4 @@',
      ' left-pad@^1.3.0:',
      '-  version "1.3.0"',
      '+  version "1.3.1"',
      '   resolved "https://registry.yarnpkg.com/left-pad/-/left-pad-1.3.1.tgz#abc"',
    ].join('\n')));
    expect(text).toContain('left-pad: 1.3.0 -> 1.3.1');
  });

  it('refuses a version change with no entry header in its hunk', () => {
    expect(summarizeLockfileChange('yarn.lock', '@@ -1,2 +1,2 @@\n-  version "1.0.0"\n+  version "6.6.6"\n').ok).toBe(false);
  });
});

describe('REL-1141: formats and inputs it refuses', () => {
  it.each([
    ['pnpm-lock.yaml', '@@ -1 +1 @@\n-  /a@1.0.0:\n+  /a@1.0.1:\n'],
    ['go.sum', '@@ -1 +1 @@\n-x v1 h1:a\n+x v2 h1:b\n'],
    ['package-lock.json', ''],
    ['package-lock.json', 'no hunks at all'],
  ])('%s %#', (file, patch) => {
    expect(summarizeLockfileChange(file, patch).ok).toBe(false);
  });

  it('oversizedLockfileSummary requires the registry check to pass over the whole patch', () => {
    const evil = `${PR30_LOCK}\n@@ -9000,3 +9000,6 @@\n     },\n+    "node_modules/evil": {\n+      "version": "1.0.0",\n`
      + '+      "resolved": "git+ssh://git@github.com/evil/evil.git#abc",\n';
    const result = oversizedLockfileSummary({ path: 'package-lock.json', patch: evil, mode: '100644' });
    expect(result.ok).toBe(false);
    expect(oversizedLockfileSummary({ path: 'package-lock.json', patch: PR30_LOCK, mode: '100644' }).ok).toBe(true);
    expect(oversizedLockfileSummary({ path: 'package-lock.json', patch: PR30_LOCK, mode: '120000' }).ok).toBe(false);
  });
});
