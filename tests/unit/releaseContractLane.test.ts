import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import baseConfig from '../../vitest.config';
import releaseConfig from '../../vitest.release.config';

const root = process.cwd();
const base = baseConfig as any;
const release = releaseConfig as any;

/**
 * REL-559. Two tests -- the pack/install/attest closure -- cost 120 of the unit suite's 181
 * seconds of file time and reached the public npm registry on every pull request. They moved to
 * tests/release/, run only via `npm run test:release-contract`, and gate publishing instead.
 *
 * That trade is only sound while the lane actually runs before anything ships. These assertions
 * are the thing standing between "moved to a slower lane" and "quietly deleted".
 */
describe('release-contract lane (REL-559)', () => {
  it('runs exactly the release directory, and the default suite does not', () => {
    expect(release.test?.include).toEqual(['tests/release/**/*.test.ts']);
    // mergeConfig concatenates arrays; if someone reintroduces it here the lane silently runs the
    // whole suite (369 files instead of 2) and the speedup evaporates without a failing test.
    expect(release.test?.include).toHaveLength(1);
    for (const pattern of base.test?.include ?? []) {
      expect(pattern).not.toContain('tests/release');
    }
  });

  it('keeps the expensive closure out of the per-pull-request suite', () => {
    const unitPackaging = fs.readFileSync(path.join(root, 'tests/unit/reviewActionPackaging.test.ts'), 'utf8');
    expect(unitPackaging).not.toContain('packs from a clean exact commit');
    expect(unitPackaging).not.toContain('installs the lock-backed Pi runtime from an empty bounded prefix');
    // The cheap action.yml contract assertions must stay on every pull request.
    expect(unitPackaging).toContain('exists at the repository root');
    expect(unitPackaging).toContain('declares a name, description and branding for Marketplace listing');
  });

  it('still proves the closure somewhere', () => {
    const closure = fs.readFileSync(path.join(root, 'tests/release/actionReleaseClosure.test.ts'), 'utf8');
    expect(closure).toContain('packs from a clean exact commit');
    expect(closure).toContain('installs the lock-backed Pi runtime from an empty bounded prefix');
    expect(fs.existsSync(path.join(root, 'tests/release/buildProvenance.test.ts'))).toBe(true);
  });

  it('is wired into every path that can reach a consumer', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(pkg.scripts['test:release-contract']).toContain('vitest.release.config.ts');

    // Publishing a release, and moving the rolling v1 channel consumers resolve, are the two ways
    // this repository reaches a consumer. Both must run the lane first.
    const releaseWorkflow = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
    const majorTagWorkflow = fs.readFileSync(path.join(root, '.github/workflows/update-major-tag.yml'), 'utf8');
    expect(releaseWorkflow).toContain('npm run test:release-contract');
    expect(majorTagWorkflow).toContain('npm run test:release-contract');
  });
});
