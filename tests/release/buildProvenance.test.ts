import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {
  BUILD_PROVENANCE_SCHEMA_VERSION,
  DIRECT_PI_RUNTIME_PACKAGES,
  createBuildProvenance,
  loadBuildProvenance,
  runtimeGraphFromInstall,
  verifyBuildProvenance,
  writeBuildProvenance,
} = require('../../src/provenance/buildProvenance.js');

const rootRepoDir = path.resolve(__dirname, '../..');
const exactPackages = {
  '@quintinshaw/pi-dynamic-workflows': ['3.7.0', 'sha512-zouAO72IlCHplCNdY+M3LgdcftDD5AbW3QakCpsbSU5oDRNZSlW+es9hBILXegRlFDHW0VgmfaYSdLCtWgMoJQ=='],
  '@earendil-works/pi-ai': ['0.84.1', 'sha512-wMsAdJMxuNri08vLqTyYVI201DQQezGhPSTkzYsHdw5dYX3rCNwEmSvpaAwhi7ELKI/2tE/CEgSWg/6iRxSgdQ=='],
  '@earendil-works/pi-coding-agent': ['0.84.1', 'sha512-ncAqFrG+iybuPGOhMiZoEHkEzTpJgz3guYD32pD+M7ucc0WeHmauP6wa7qwP8V/KWvsZDVNa5XGsdZ7fkC7w7A=='],
  '@earendil-works/pi-tui': ['0.84.1', 'sha512-udeXFbgEhJ6JiB0uguwNVNkDy2FENfmtQwPcY+/iJ8GWeq18wkal1tKqa5YyeH0IqtX1vG0cGh8zfSYzyzVuLA=='],
  typebox: ['1.3.7', 'sha512-meKuifc33Pccx0O6PdIzYMq3Og8zvP4TIi/a+Bw3AEMZMxOD0+RHGQvpglEe6Zdy3wZ8nqn/j95h8LUZLk/6Hg=='],
} as const;

describe('Pi runtime build provenance', () => {
  it('derives the exact bounded dependency closure and reviewed integrities from the lock-valid install', () => {
    const lock = JSON.parse(fs.readFileSync(path.join(rootRepoDir, 'package-lock.json'), 'utf8'));
    expect(DIRECT_PI_RUNTIME_PACKAGES).toEqual(Object.keys(exactPackages));
    for (const [name, [version, integrity]] of Object.entries(exactPackages)) {
      expect(lock.packages[`node_modules/${name}`]).toMatchObject({ version, integrity });
    }

    const graph = runtimeGraphFromInstall({ packageRoot: rootRepoDir, requireNested: false });
    expect(graph.roots).toEqual(Object.keys(exactPackages));
    expect(graph.packages.map((entry: any) => entry.name)).toEqual(expect.arrayContaining(Object.keys(exactPackages)));
    expect(graph.packages.some((entry: any) => entry.name === 'acorn')).toBe(true);
    expect(graph.digest).toMatch(/^[a-f0-9]{64}$/u);
  }, 30_000);

  it('writes and verifies untracked source-revision-bound provenance without embedding its own digest', () => {
    const revision = 'c'.repeat(40);
    const provenance = createBuildProvenance({ packageRoot: rootRepoDir, runtimeSourceRevision: revision, requireNested: false });
    expect(provenance.schema).toBe(BUILD_PROVENANCE_SCHEMA_VERSION);
    expect(provenance.runtimeSourceRevision).toBe(revision);
    expect(provenance.runtimeGraphDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(provenance).not.toHaveProperty('provenanceDigest');

    const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'review-yeti-provenance-')), 'build-provenance.json');
    writeBuildProvenance(target, provenance);
    expect(loadBuildProvenance(target)).toEqual(provenance);
    expect(verifyBuildProvenance({ packageRoot: rootRepoDir, provenance: loadBuildProvenance(target), requireNested: false }))
      .toEqual(expect.objectContaining({ runtimeGraphDigest: provenance.runtimeGraphDigest }));
  }, 30_000);

  it('requires an exact Action SHA and rejects a substituted runtime package before review', () => {
    expect(() => createBuildProvenance({ packageRoot: rootRepoDir, runtimeSourceRevision: 'main', requireNested: false }))
      .toThrow(/40-hex/i);
    const provenance = createBuildProvenance({ packageRoot: rootRepoDir, runtimeSourceRevision: 'd'.repeat(40), requireNested: false });
    const substituted = {
      ...provenance,
      packages: provenance.packages.map((entry: any) => entry.name === 'typebox' ? { ...entry, version: '1.3.6' } : entry),
    };
    expect(() => verifyBuildProvenance({ packageRoot: rootRepoDir, provenance: substituted, requireNested: false }))
      .toThrow(/runtime graph|provenance/i);
  }, 30_000);
});
