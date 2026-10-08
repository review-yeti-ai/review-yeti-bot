import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { ensureFrontendArtifacts, inspectFrontendArtifacts } = require('../../scripts/verify-frontend-artifacts');

const temporaryDirectories: string[] = [];

function createPublicDirectory(): string {
  const publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-yeti-frontend-artifacts-'));
  temporaryDirectories.push(publicDir);
  return publicDir;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('verify-frontend-artifacts', () => {
  it('marks an existing but stale chunk cache incoherent when current HTML references a missing chunk', () => {
    const publicDir = createPublicDirectory();
    fs.mkdirSync(path.join(publicDir, '_next/static/chunks'), { recursive: true });
    fs.mkdirSync(path.join(publicDir, 'dashboard'), { recursive: true });
    fs.writeFileSync(
      path.join(publicDir, 'dashboard/live.html'),
      '<!doctype html><html><main></main><script src="/_next/static/chunks/main-app-current.js"></script></html>',
    );

    const result = inspectFrontendArtifacts({ publicDir });

    expect(fs.existsSync(path.join(publicDir, '_next/static/chunks'))).toBe(true);
    expect(result.coherent).toBe(false);
    expect(result.missing).toEqual([
      { htmlFile: 'dashboard/live.html', asset: '/_next/static/chunks/main-app-current.js' },
    ]);
  });

  it('marks a cache coherent only when each current HTML reference resolves to a nonempty asset', () => {
    const publicDir = createPublicDirectory();
    const script = '/_next/static/chunks/main-app-current.js';
    const stylesheet = '/_next/static/css/current.css';
    fs.mkdirSync(path.join(publicDir, '_next/static/chunks'), { recursive: true });
    fs.mkdirSync(path.join(publicDir, '_next/static/css'), { recursive: true });
    fs.mkdirSync(path.join(publicDir, 'dashboard'), { recursive: true });
    fs.writeFileSync(path.join(publicDir, script.slice(1)), 'export default true;');
    fs.writeFileSync(path.join(publicDir, stylesheet.slice(1)), 'body { color: white; }');
    fs.writeFileSync(
      path.join(publicDir, 'dashboard/live.html'),
      `<!doctype html><html><main></main><script src="${script}"></script><link href="${stylesheet}" rel="stylesheet"></html>`,
    );

    const result = inspectFrontendArtifacts({ publicDir });

    expect(result.coherent).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('rebuilds a nonempty chunk directory when current HTML references a missing chunk', () => {
    const publicDir = createPublicDirectory();
    const asset = '/_next/static/chunks/main-app-current.js';
    const assetPath = path.join(publicDir, asset.slice(1));
    fs.mkdirSync(path.dirname(assetPath), { recursive: true });
    fs.mkdirSync(path.join(publicDir, '_next/static/chunks'), { recursive: true });
    fs.writeFileSync(path.join(publicDir, 'live.html'), `<script src="${asset}"></script>`);
    const buildFrontend = vi.fn(() => fs.writeFileSync(assetPath, 'export default true;'));

    const result = ensureFrontendArtifacts({ publicDir, buildFrontend });

    expect(fs.existsSync(path.join(publicDir, '_next/static/chunks'))).toBe(true);
    expect(buildFrontend).toHaveBeenCalledOnce();
    expect(result.rebuilt).toBe(true);
    expect(result.coherent).toBe(true);
  });

  it('reuses a coherent cache without running another frontend build', () => {
    const publicDir = createPublicDirectory();
    const asset = '/_next/static/chunks/main-app-current.js';
    const assetPath = path.join(publicDir, asset.slice(1));
    fs.mkdirSync(path.dirname(assetPath), { recursive: true });
    fs.writeFileSync(assetPath, 'export default true;');
    fs.writeFileSync(path.join(publicDir, 'live.html'), `<script src="${asset}"></script>`);
    const buildFrontend = vi.fn();

    const result = ensureFrontendArtifacts({ publicDir, buildFrontend });

    expect(buildFrontend).not.toHaveBeenCalled();
    expect(result.rebuilt).toBe(false);
    expect(result.coherent).toBe(true);
  });
});
