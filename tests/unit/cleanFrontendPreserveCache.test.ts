import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repositoryRoot = resolve(__dirname, '../..');
const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function write(root: string, path: string, content: string) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function runClean(preserve: string | undefined) {
  const fixture = mkdtempSync(join(tmpdir(), 'yeti-clean-frontend-'));
  fixtures.push(fixture);
  mkdirSync(join(fixture, 'scripts'), { recursive: true });
  for (const script of ['clean-frontend.js', 'ensure-static-assets.js']) {
    copyFileSync(join(repositoryRoot, 'scripts', script), join(fixture, 'scripts', script));
  }
  const bin = join(fixture, 'bin');
  // Do not consult unrelated workstation build processes in this fixture.
  write(fixture, 'bin/pgrep', '#!/bin/sh\nexit 1\n');
  chmodSync(join(bin, 'pgrep'), 0o700);

  write(fixture, '.next/cache/webpack/entry', 'cached');
  write(fixture, '.next/server/page.js', 'stale server');
  write(fixture, '.next/BUILD_ID', 'stale');
  write(fixture, 'out/index.html', 'stale export');
  write(fixture, 'public/_next/static/chunk.js', 'stale chunk');
  write(fixture, 'public/dashboard/live.html', 'stale dashboard');
  write(fixture, 'pages/old.js', 'stale pages');
  write(fixture, 'tsconfig.tsbuildinfo', 'stale');

  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', PATH: [bin, dirname(process.execPath), '/usr/bin', '/bin'].join(':') };
  if (preserve !== undefined) env.PRESERVE_NEXT_CACHE = preserve;
  const result = spawnSync(process.execPath, ['scripts/clean-frontend.js'], { cwd: fixture, env, encoding: 'utf8', timeout: 10_000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return fixture;
}

describe('clean-frontend PRESERVE_NEXT_CACHE', () => {
  it('keeps only .next/cache and purges every other generated output when set to 1', () => {
    const fixture = runClean('1');
    expect(readFileSync(join(fixture, '.next/cache/webpack/entry'), 'utf8')).toBe('cached');
    for (const gone of ['.next/server', '.next/BUILD_ID', 'out', 'public/_next', 'public/dashboard', 'pages', 'tsconfig.tsbuildinfo']) {
      expect(existsSync(join(fixture, gone)), gone).toBe(false);
    }
    expect(existsSync(join(fixture, 'public/index.html'))).toBe(true);
  });

  it.each([undefined, '', '0', 'true'])('purges .next/cache entirely when PRESERVE_NEXT_CACHE=%s', (value) => {
    const fixture = runClean(value);
    expect(existsSync(join(fixture, '.next'))).toBe(false);
    expect(existsSync(join(fixture, 'out'))).toBe(false);
    expect(existsSync(join(fixture, 'public/_next'))).toBe(false);
  });
});
