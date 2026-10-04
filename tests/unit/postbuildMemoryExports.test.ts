import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  it('keeps regeneration in the production frontend build', () => {
    const manifest = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'));
    expect(manifest.scripts['build:frontend']).toContain('next build && node scripts/postbuild.js');
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
      const rootPage = `<!doctype html><html><body>memory-${revision}</body></html>`;
      const dashboardPage = `<!doctype html><html><body>dashboard-memory-${revision}</body></html>`;
      writeFixture(fixture, `${source}/memory.html`, rootPage);
      writeFixture(fixture, `${source}/dashboard/memory.html`, dashboardPage);
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
    }
  });
});
