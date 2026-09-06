import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isEntrypoint } from './entrypoint-guard.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const guardModule = path.join(repoRoot, 'scripts/entrypoint-guard.mjs');

// realpath the temp root: on macOS mkdtemp sits under a symlinked /var, which
// would otherwise make even the "direct" control case travel through a link.
function scratch() {
  return realpathSync(mkdtempSync(path.join(tmpdir(), 'ct-entrypoint-')));
}

// --- behaviour of the guard itself -----------------------------------------

test('returns false when there is no argv[1]', () => {
  const probe = `import { isEntrypoint } from ${JSON.stringify(pathToFileURL(guardModule).href)};
    process.stdout.write(String(isEntrypoint(import.meta.url)));`;
  // `node -e` leaves process.argv[1] undefined, which is the real shape of this branch.
  const run = spawnSync('node', ['--input-type=module', '-e', probe], { encoding: 'utf8' });
  assert.equal(run.stdout, 'false');
});

test('returns false rather than throwing when argv[1] cannot be resolved', () => {
  const original = process.argv[1];
  process.argv[1] = path.join(scratch(), 'does', 'not', 'exist.mjs');
  try {
    assert.equal(isEntrypoint(import.meta.url), false);
  } finally {
    process.argv[1] = original;
  }
});

// The claim this whole change exists to make: reached through a symlink, the
// script still runs. Asserted by executing it, not by reading its source.
function runFixture(guardExpression) {
  const root = scratch();
  try {
    const real = path.join(root, 'real');
    mkdirSync(real);
    writeFileSync(path.join(real, 'entry.mjs'), `
      import { fileURLToPath } from 'node:url';
      import { isEntrypoint } from ${JSON.stringify(pathToFileURL(guardModule).href)};
      function main() { process.stdout.write('MAIN RAN'); }
      if (${guardExpression}) main();
    `);
    symlinkSync(real, path.join(root, 'link'));
    return {
      direct: spawnSync('node', [path.join(real, 'entry.mjs')], { encoding: 'utf8' }).stdout,
      linked: spawnSync('node', [path.join(root, 'link', 'entry.mjs')], { encoding: 'utf8' }),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('the shared guard runs main() through a symlinked parent', () => {
  const r = runFixture('isEntrypoint(import.meta.url)');
  assert.equal(r.direct, 'MAIN RAN', 'sanity: must run at its real path');
  assert.equal(r.linked.stdout, 'MAIN RAN');
});

test('the naive guard this replaces silently exits 0 through a symlink', () => {
  // Pins the defect itself, so the fixture proves the difference rather than
  // asserting the fix in isolation.
  const r = runFixture('process.argv[1] === fileURLToPath(import.meta.url)');
  assert.equal(r.linked.stdout, '', 'the bug: no output');
  assert.equal(r.linked.status, 0, 'and exit 0, so nothing surfaces it');
});

// --- the convention, enforced structurally ----------------------------------

// Keyed off "imports the shared helper", not off a textual guard shape. A
// same-line substring scan is evadable by splitting the guard across two lines
// and false-positives on equivalent spellings; example-meta's first attempt at this
// test scanned one directory for one spelling and passed while 46 files were
// still broken.
const SCANNED_ROOTS = ['scripts', '.github'];
const EXEMPT = new Set(['scripts/entrypoint-guard.mjs', 'scripts/entrypoint-guard.test.mjs']);

function* sourceFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(full);
    else if (entry.name.endsWith('.mjs') || entry.name.endsWith('.js')) yield full;
  }
}

test('any script deciding whether it is the entrypoint uses the shared guard', () => {
  const offenders = [];
  for (const root of SCANNED_ROOTS) {
    for (const file of sourceFiles(path.join(repoRoot, root))) {
      const relative = path.relative(repoRoot, file);
      if (EXEMPT.has(relative) || statSync(file).size > 2_000_000) continue;
      const source = readFileSync(file, 'utf8');
      if (!source.includes('process.argv[1]')) continue;
      // Whole-file co-occurrence, so a guard split across lines is still caught.
      if (!/import\.meta\.(url|filename|path)/.test(source)) continue;
      if (source.includes("from './entrypoint-guard.mjs'")) continue;
      offenders.push(relative);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these decide entrypoint-ness without the shared guard:\n${offenders.join('\n')}`,
  );
});
