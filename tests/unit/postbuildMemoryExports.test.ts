import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const fixtures: string[] = [];
const repositoryRoot = resolve(__dirname, '../..');
const aliases = ['memory.html', 'memory.txt', 'dashboard/memory', 'dashboard/memory.html', 'dashboard/memory.txt'];

function writeFixture(root: string, path: string, content: string) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

describe('memory static export regeneration', () => {
  it.each([false, true])('executes production frontend wiring and propagates postbuild failure=%s', (failPostbuild) => {
    const manifest = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'));
    const fixture = mkdtempSync(join(tmpdir(), 'yeti-frontend-wiring-'));
    fixtures.push(fixture);
    mkdirSync(join(fixture, 'scripts'), { recursive: true });
    for (const script of ['clean-frontend.js', 'postbuild.js', 'ensure-static-assets.js']) {
      copyFileSync(join(repositoryRoot, 'scripts', script), join(fixture, 'scripts', script));
    }
    const bin = join(fixture, 'bin');
    // Substitute only Next's compiler with a deterministic output producer.
    // The actual manifest shell command, cleanup and postbuild scripts execute.
    writeFixture(fixture, 'bin/next', `#!${process.execPath}\n
const fs = require('node:fs');
if (process.argv[2] !== 'build') process.exit(2);
fs.mkdirSync('out/dashboard', { recursive: true });
fs.writeFileSync('out/memory.html', 'fresh production wiring');
fs.writeFileSync('out/dashboard/memory.html', 'fresh production wiring');
if (process.env.FAIL_POSTBUILD === 'yes') fs.writeFileSync('dist', 'not a directory');
`);
    // Do not consult unrelated workstation build processes in this fixture.
    writeFixture(fixture, 'bin/pgrep', '#!/bin/sh\nexit 1\n');
    chmodSync(join(bin, 'next'), 0o700);
    chmodSync(join(bin, 'pgrep'), 0o700);
    const result = spawnSync('/bin/sh', ['-c', manifest.scripts['build:frontend']], {
      cwd: fixture,
      env: { NODE_ENV: 'test', PATH: [bin, dirname(process.execPath), '/usr/bin', '/bin'].join(':'), FAIL_POSTBUILD: failPostbuild ? 'yes' : 'no' },
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    if (failPostbuild) {
      expect(result.status).toBe(1);
    } else {
      expect(result.status, result.stderr).toBe(0);
      for (const alias of aliases) {
        expect(readFileSync(join(fixture, 'public', alias), 'utf8')).toBe('fresh production wiring');
        expect(readFileSync(join(fixture, 'dist/public', alias), 'utf8')).toBe('fresh production wiring');
      }
    }
  });

  it.each(['out', '.next/server/app'])('replaces stale public aliases and packaged assets with fresh %s output', (source) => {
    const fixture = mkdtempSync(join(tmpdir(), 'yeti-memory-export-'));
    fixtures.push(fixture);
    mkdirSync(join(fixture, 'scripts'), { recursive: true });
    for (const script of ['postbuild.js', 'ensure-static-assets.js']) {
      copyFileSync(join(repositoryRoot, 'scripts', script), join(fixture, 'scripts', script));
    }
    for (const alias of aliases) writeFixture(fixture, `public/${alias}`, 'stale fixture snapshot');

    // Exercise the actual production postbuild twice: later component output
    // must replace every prior alias without manually editing served HTML.
    for (const revision of ['first', 'second']) {
      const script = `_next/static/chunks/memory-${revision}.js`;
      const style = `_next/static/css/memory-${revision}.css`;
      const assets = `<link rel="stylesheet" href="/${style}"><script src="/${script}"></script>`;
      const rootPage = `<!doctype html><html><body>memory-${revision}${assets}</body></html>`;
      const dashboardPage = `<!doctype html><html><body>dashboard-memory-${revision}${assets}</body></html>`;
      writeFixture(fixture, `${source}/memory.html`, rootPage);
      writeFixture(fixture, `${source}/dashboard/memory.html`, dashboardPage);
      const assetRoot = source === 'out' ? 'out/_next/static' : '.next/static';
      writeFixture(fixture, `${assetRoot}/chunks/memory-${revision}.js`, `script-${revision}`);
      writeFixture(fixture, `${assetRoot}/css/memory-${revision}.css`, `style-${revision}`);
      execFileSync(process.execPath, [join(fixture, 'scripts/postbuild.js')], {
        cwd: fixture,
        env: { NODE_ENV: 'test' },
        stdio: 'pipe',
      });
      for (const alias of aliases) {
        const expected = alias.startsWith('dashboard/') ? dashboardPage : rootPage;
        expect(readFileSync(join(fixture, 'public', alias), 'utf8')).toBe(expected);
        expect(readFileSync(join(fixture, 'dist/public', alias), 'utf8')).toBe(expected);
      }
      for (const destination of ['public', 'dist/public']) {
        expect(readFileSync(join(fixture, destination, script), 'utf8')).toBe(`script-${revision}`);
        expect(readFileSync(join(fixture, destination, style), 'utf8')).toBe(`style-${revision}`);
      }
    }
  });
});
