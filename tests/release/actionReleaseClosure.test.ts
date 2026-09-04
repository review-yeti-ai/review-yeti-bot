/**
 * Release-contract closure tests (REL-559).
 *
 * These two cases are the real end-to-end packaging proof: they `npm ci` a clean fixture repo,
 * `npm pack` it (a ~41 MB tarball, ~36k files), `npm install` that tarball into an empty consumer
 * prefix, and run the action runtime installer against the result. On a measured full run they
 * cost 105.8s and 14.5s -- 120 of the 181 seconds of the entire unit suite's file time, for 2 of
 * its 4,114 tests -- and they reach the public npm registry, so a registry hiccup reds a required
 * check on an unrelated pull request (it did, on #447, with an electron-to-chromium 404).
 *
 * They are not per-pull-request signal: nothing they assert can break without a change to
 * package.json, the lockfile, action.yml, or scripts/, and every one of those is re-proven at
 * release time. They run in the release-contract lane instead -- `npm run test:release-contract`
 * -- which release.yml executes before publishing and update-major-tag.yml executes before moving
 * the rolling v1 consumer channel. Nothing reaches a consumer without passing them.
 *
 * The cheap assertions that were their neighbours (action.yml shape, bundled-dependency
 * declarations, node-version guards) stay in tests/unit/reviewActionPackaging.test.ts and still
 * run on every pull request; they cost about 100ms combined.
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execFileSync } from 'child_process';
import yaml from 'js-yaml';

const rootRepoDir = fs.existsSync(path.join(path.resolve(__dirname, '../..'), '.github/workflows/pipelines/review-pipeline.js'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');
const pipeline = require(path.join(rootRepoDir, '.github/workflows/pipelines/review-pipeline.js'));
const actionPath = path.join(rootRepoDir, 'action.yml');
const nodeVersionGuard = require(path.join(rootRepoDir, 'scripts/nodeVersionGuard.js'));
const { isBoundedDirectory } = require(path.join(rootRepoDir, 'scripts/boundedDirectoryGuard.js'));


describe('Pi runtime packaging closure (release contract)', () => {
  it('packs from a clean exact commit and an empty consumer resolves and attests the nested Pi closure', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-yeti-clean-pack-'));
    const releaseDir = path.join(tempDir, 'release');
    const packDir = path.join(tempDir, 'pack');
    const consumerDir = path.join(tempDir, 'consumer');
    fs.cpSync(rootRepoDir, releaseDir, {
      recursive: true,
      filter(source) {
        const relative = path.relative(rootRepoDir, source);
        const top = relative.split(path.sep)[0];
        return !['.git', 'node_modules', 'dist'].includes(top);
      },
    });
    fs.mkdirSync(packDir, { recursive: true });
    fs.mkdirSync(consumerDir, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: releaseDir });
    execFileSync('git', ['config', 'user.name', 'Review Yeti Test'], { cwd: releaseDir });
    execFileSync('git', ['config', 'user.email', 'review-yeti-test@example.invalid'], { cwd: releaseDir });
    execFileSync('git', ['add', '--all'], { cwd: releaseDir });
    execFileSync('git', ['commit', '-q', '-m', 'clean release fixture'], { cwd: releaseDir });

    const npmEnvironment = { ...process.env, NPM_CONFIG_USERCONFIG: os.devNull } as Record<string, string | undefined>;
    for (const key of Object.keys(npmEnvironment)) {
      if (/^npm_config_allow_scripts(?:_pin)?$/iu.test(key)) delete npmEnvironment[key];
    }
    execFileSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: releaseDir,
      env: npmEnvironment,
      stdio: 'pipe',
      timeout: 360_000,
    });
    expect(execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: releaseDir, encoding: 'utf8' })).toBe('');
    fs.writeFileSync(path.join(releaseDir, 'dirty-release-marker'), 'must reject');
    expect(() => execFileSync(process.execPath, ['scripts/stage-publish-package.mjs', '--prepare-current'], {
      cwd: releaseDir,
      env: npmEnvironment,
      stdio: 'pipe',
    })).toThrow(/exact clean release commit/i);
    fs.rmSync(path.join(releaseDir, 'dirty-release-marker'));
    execFileSync('git', ['checkout', '--detach', '--quiet', 'HEAD'], { cwd: releaseDir });
    expect(() => execFileSync(process.execPath, ['scripts/stage-publish-package.mjs', '--prepare-current'], {
      cwd: releaseDir,
      env: npmEnvironment,
      stdio: 'pipe',
    })).toThrow(/attached release branch/i);
    execFileSync('git', ['switch', '--quiet', '-c', 'release-fixture'], { cwd: releaseDir });
    const packed = execFileSync('npm', ['pack', '--pack-destination', packDir], {
      cwd: releaseDir,
      env: npmEnvironment,
      encoding: 'utf8',
      timeout: 360_000,
    }).trim().split('\n').at(-1);
    expect(packed).toMatch(/\.tgz$/u);
    const tarball = path.join(packDir, String(packed));
    fs.writeFileSync(path.join(consumerDir, 'package.json'), JSON.stringify({ name: 'ordinary-consumer', private: true }, null, 2));
    execFileSync('npm', ['install', '--prefix', '.', tarball, '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: consumerDir,
      env: npmEnvironment,
      stdio: 'pipe',
      timeout: 360_000,
    });

    const packageName = JSON.parse(fs.readFileSync(path.join(rootRepoDir, 'package.json'), 'utf8')).name;
    const installedRoot = path.join(consumerDir, 'node_modules', packageName);
    const nestedRuntime = path.join(installedRoot, 'node_modules', '@quintinshaw', 'pi-dynamic-workflows');
    expect(fs.existsSync(path.join(nestedRuntime, 'package.json'))).toBe(true);
    const provenanceApi = require(path.join(installedRoot, 'src/provenance/buildProvenance.js'));
    const provenancePath = path.join(installedRoot, 'src/provenance/generated-build-provenance.json');
    const consumerProvenance = provenanceApi.loadBuildProvenance(provenancePath);
    expect(consumerProvenance).toEqual(expect.objectContaining({
      schema: 'review-yeti-build-provenance.v1',
      runtimeGraphDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    }));

    const actionPrefix = path.join(tempDir, 'action-prefix');
    execFileSync(process.execPath, [path.join(releaseDir, 'scripts/install-action-runtime.mjs')], {
      cwd: releaseDir,
      env: {
        ...npmEnvironment,
        GITHUB_ACTION_PATH: releaseDir,
        NPM_PREFIX: actionPrefix,
        REVIEW_YETI_ACTION_SHA: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: releaseDir, encoding: 'utf8' }).trim(),
      },
      stdio: 'pipe',
      timeout: 180_000,
    });
    const hostedProvenance = provenanceApi.loadBuildProvenance(path.join(releaseDir, 'src/provenance/generated-build-provenance.json'));
    const installedPiProvenance = provenanceApi.createBuildProvenance({
      packageRoot: actionPrefix,
      runtimeSourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: releaseDir, encoding: 'utf8' }).trim(),
      requireNested: true,
    });
    // The application package has its own dependency graph (and may legally hoist optional
    // peers), while the Action's Pi engine is deliberately installed from pi-runtime's exact
    // lockfile. Compare the hosted receipt to that bounded runtime graph, not the consumer's
    // ambient application graph.
    expect(hostedProvenance.runtimeGraphDigest).toBe(installedPiProvenance.runtimeGraphDigest);

  }, 360_000);

  it('installs the lock-backed Pi runtime from an empty bounded prefix', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-yeti-pi-action-install-'));
    const actionDir = path.join(tempDir, 'action');
    const prefixDir = path.join(tempDir, 'prefix');
    fs.mkdirSync(actionDir, { recursive: true });
    for (const directory of ['src/review', 'src/pi', 'src/provenance']) {
      fs.cpSync(path.join(rootRepoDir, directory), path.join(actionDir, directory), { recursive: true });
    }
    for (const relative of [
      'pi-runtime/package.json',
      'pi-runtime/package-lock.json',
      'scripts/boundedDirectoryGuard.js',
      'scripts/install-action-runtime.mjs',
      'scripts/generate-build-provenance.mjs',
      'scripts/nodeVersionGuard.js',
    ]) {
      const destination = path.join(actionDir, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(rootRepoDir, relative), destination);
    }
    const output = execFileSync(process.execPath, [path.join(actionDir, 'scripts/install-action-runtime.mjs')], {
      cwd: tempDir,
      env: { ...process.env, GITHUB_ACTION_PATH: actionDir, NPM_PREFIX: prefixDir, REVIEW_YETI_ACTION_SHA: 'e'.repeat(40) },
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(output).toContain('Pi workflow runtime ok 3.7.0');
    expect(fs.existsSync(path.join(actionDir, 'src/provenance/generated-build-provenance.json'))).toBe(true);
  }, 130_000);
});
