import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execFileSync } from 'child_process';

const rootRepoDir = fs.existsSync(path.join(path.resolve(__dirname, '../..'), 'legacy-runtime', 'package.json'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');

describe('legacy-runtime lock graph', () => {
  it('pins only the two panel packages and matches the Action contract', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(rootRepoDir, 'legacy-runtime/package.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(rootRepoDir, 'legacy-runtime/package-lock.json'), 'utf8'));
    expect(manifest.dependencies).toEqual({
      '@openrouter/sdk': '1.2.80',
      'js-yaml': '4.1.1',
    });
    expect(lock.packages['node_modules/@openrouter/sdk'].version).toBe('1.2.80');
    expect(lock.packages['node_modules/js-yaml'].version).toBe('4.1.1');
  });

  it('rejects the application graph and accepts a lock-backed npm ci prefix', () => {
    const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'review-yeti-legacy-runtime-'));
    fs.copyFileSync(
      path.join(rootRepoDir, 'legacy-runtime/package.json'),
      path.join(prefix, 'package.json'),
    );
    fs.copyFileSync(
      path.join(rootRepoDir, 'legacy-runtime/package-lock.json'),
      path.join(prefix, 'package-lock.json'),
    );
    execFileSync('npm', ['ci', '--prefix', '.', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: prefix,
      stdio: 'pipe',
    });
    // cwd is the lock directory; --prefix . avoids npm 11 treating the folder name as a package.
    execFileSync('node', [path.join(rootRepoDir, 'scripts/verify-legacy-runtime-graph.mjs'), prefix], {
      stdio: 'pipe',
    });
    expect(fs.existsSync(path.join(prefix, 'node_modules/next'))).toBe(false);
    expect(fs.existsSync(path.join(prefix, 'node_modules/react'))).toBe(false);
    expect(fs.existsSync(path.join(prefix, 'node_modules/@openrouter/sdk'))).toBe(true);
    fs.rmSync(prefix, { recursive: true, force: true });
  });
});
