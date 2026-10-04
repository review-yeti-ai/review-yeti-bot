import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isSummarizableLockfilePath, summarizeLockfileChange } from '../../src/review/lockfileChangeSummary';
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
  it('reads berry: a bump, a new transitive package and a re-key (example-ui#847 shape)', () => {
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

describe('REL-1334: Elixir mix.lock', () => {
  /**
   * A real mix.lock entry, byte-shaped like the file Hex writes (a 64-character
   * inner checksum followed by the outer one), so the collector is pinned
   * against the actual serialization and not a simplification of it.
   */
  const hexEntry = (name: string, version: string) => `  "${name}": {:hex, :${name}, "${version}", `
    + `"${'a'.repeat(64)}", [:mix], [], "hexpm", "${'b'.repeat(64)}"},`;

  it('reads a bump, a new package and a removal', () => {
    const text = ok(summarizeLockfileChange('mix.lock', [
      '@@ -1,6 +1,6 @@',
      ' %{',
      `-${hexEntry('jason', '1.4.1')}`,
      `+${hexEntry('jason', '1.4.2')}`,
      `-${hexEntry('old_dep', '0.1.0')}`,
      `+${hexEntry('oban', '2.18.0')}`,
      ` ${hexEntry('plug', '1.16.0')}`,
      ' }',
    ].join('\n')));
    expect(text).toContain('Added packages (1):\n  oban@2.18.0');
    expect(text).toContain('Removed packages (1):\n  old_dep@0.1.0');
    expect(text).toContain('Changed versions (1):\n  jason: 1.4.1 -> 1.4.2');
    expect(text).toContain('Review Yeti: summarized oversized lockfile mix.lock');
    // The untouched entry is neither listed nor counted as a change.
    expect(text).not.toContain('plug');
    expect(text).not.toContain('outside any entry header');
  });

  it('reads the real serialization Hex writes, dependencies and all', () => {
    // A mix.lock, verbatim shape: a rebar3 build tool and a hexpm-pinned
    // dependency list between the version and the repository.
    const text = ok(summarizeLockfileChange('mix.lock', [
      '@@ -1,2 +1,2 @@',
      '-  "cowboy": {:hex, :cowboy, "2.12.0", "aa", [:make, :rebar3], [{:cowlib, ">= 2.14.0 and < 3.0.0",'
        + ' [hex: :cowlib, repo: "hexpm", optional: false]}], "hexpm", "bb"},',
      '+  "cowboy": {:hex, :cowboy, "2.13.0", "cc", [:make, :rebar3], [{:cowlib, ">= 2.14.0 and < 3.0.0",'
        + ' [hex: :cowlib, repo: "hexpm", optional: false]}], "hexpm", "dd"},',
    ].join('\n')));
    expect(text).toContain('cowboy: 2.12.0 -> 2.13.0');
    // The dependency's own constraint is never read as the entry's version.
    expect(text).not.toContain('2.14.0 -> ');
    expect(text).not.toContain('outside any entry header');
    // A dependency pinned to the default repository stays readable (positive
    // control for the private-repository refusal below).
    expect(ok(summarizeLockfileChange('mix.lock', [
      '@@ -1,2 +1,2 @@',
      `-${hexEntry('plain', '1.0.0')}`,
      `+${hexEntry('plain', '1.0.1')}`,
    ].join('\n')))).toContain('plain: 1.0.0 -> 1.0.1');
  });

  it('is deterministic: the same patch always yields the same text', () => {
    const patch = [
      '@@ -1,2 +1,2 @@',
      `-${hexEntry('jason', '1.4.1')}`,
      `+${hexEntry('jason', '1.4.2')}`,
    ].join('\n');
    const first = summarizeLockfileChange('mix.lock', patch);
    expect(first.ok).toBe(true);
    expect(summarizeLockfileChange('mix.lock', patch)).toEqual(first);
    // A nested path reads the same file; only the disclosure line names it.
    const nested = summarizeLockfileChange('deps/mix.lock', patch);
    expect(nested.ok).toBe(true);
    expect(ok(nested).replace('deps/mix.lock', 'mix.lock')).toBe(ok(first));
  });

  it('counts a changed map literal instead of misreading it as a package', () => {
    const text = ok(summarizeLockfileChange('mix.lock', [
      '@@ -1,2 +1,2 @@',
      '-%{',
      '+%{ ',
      ` ${hexEntry('jason', '1.4.1')}`,
    ].join('\n')));
    expect(text).toContain('Changed lines outside any entry header the patch shows (dependency ranges or lockfile metadata): 2.');
    expect(text).toContain('No package entry was added, removed or re-versioned.');
  });

  it.each([
    ['a git dependency',
      '-  "dep": {:git, "https://github.com/example/dep.git", "abc", []},',
      '+  "dep": {:git, "https://github.com/example/dep.git", "def", []},',
      'changes an entry that is not a Hex package from the default repository'],
    ['a package whose dependencies name a private Hex repository',
      '-  "dep": {:hex, :dep, "1.0.0", "aa", [:mix], [{:other, "~> 1.0", [hex: :other, repo: "acme", optional: false]}], "hexpm", "bb"},',
      '+  "dep": {:hex, :dep, "1.0.1", "cc", [:mix], [{:other, "~> 1.0", [hex: :other, repo: "acme", optional: false]}], "hexpm", "dd"},',
      'changes an entry that is not a Hex package from the default repository'],
    ['an entry whose OWN positional repository is not hexpm',
      '-  "dep": {:hex, :dep, "1.0.0", "aa", [:mix], [], "acme", "bb"},',
      '+  "dep": {:hex, :dep, "1.0.1", "cc", [:mix], [], "acme", "dd"},',
      'changes an entry that is not a Hex package from the default repository'],
    ['a path dependency', '-  "dep": {:hex, :dep, "1.0.0", "aa", [:mix], [], "hexpm", "bb"},',
      '+  "other": {:path, "../other"},',
      'changes an entry that is not a Hex package from the default repository'],
    ['an entry keyed to a different package',
      '-  "dep": {:hex, :dep, "1.0.0", "aa", [:mix], [], "hexpm", "bb"},',
      '+  "dep": {:hex, :other, "1.0.1", "cc", [:mix], [], "hexpm", "dd"},',
      'changes an entry whose package name and declaration disagree'],
  ])('refuses %s rather than guessing', (_label, removed, added, reason) => {
    expect(summarizeLockfileChange('mix.lock', `@@ -1,2 +1,2 @@\n${removed}\n${added}`))
      .toEqual({ ok: false, reason });
  });

  it('tolerates an UNCHANGED entry whose quoted key differs from its Hex atom (legal Hex naming: chatterbox -> ts_chatterbox)', () => {
    // mix.lock keys are the APP name; the Hex atom is the PACKAGE name, and the
    // two may legitimately differ. That divergence on an UNCHANGED context line
    // is not a corruption signal — only a CHANGED entry keying to a different
    // package is. Refusing the whole summary over it blocked a real review
    // (cisco-cdr#5028) whose lock context carried exactly these entries.
    const context = ` "chatterbox": {:hex, :ts_chatterbox, "0.15.1", "aa", [:mix], [], "hexpm", "bb"},
 "hpack": {:hex, :hpack_erl, "0.3.0", "cc", [:rebar3], [], "hexpm", "dd"},`;
    const text = ok(summarizeLockfileChange('mix.lock', [
      '@@ -3,4 +3,4 @@',
      context,
      '-  "grpc": {:hex, :grpc, "0.11.5", "ee", [:mix], [], "hexpm", "ff"},',
      '+  "grpc": {:hex, :grpc, "1.0.5", "gg", [:mix], [], "hexpm", "hh"},',
    ].join('\n')));
    expect(text).toContain('grpc: 0.11.5 -> 1.0.5');
    expect(text).not.toContain('declaration disagree');
  });

  it('reads mix.lock and still refuses every format it cannot read', () => {
    expect(isSummarizableLockfilePath('mix.lock')).toBe(true);
    expect(isSummarizableLockfilePath('deps/MIX.LOCK')).toBe(true);
    expect(isSummarizableLockfilePath('pnpm-lock.yaml')).toBe(false);
    expect(summarizeLockfileChange('mix.lock', 'no hunks at all'))
      .toEqual({ ok: false, reason: 'patch has no hunks to summarize' });
    expect(summarizeLockfileChange('gemfile.lock', '@@ -1 +1 @@\n-a\n+b\n'))
      .toEqual({ ok: false, reason: 'lockfile format cannot be summarized' });
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
