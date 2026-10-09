#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const NORMAL_ENGINE_QUALIFICATION_FIXTURE_ALLOWLIST = Object.freeze([
  { path: 'eval-baselines/competitive-review-benchmark/ws5-live-arms-v1.json',
    sha256: 'e698444b060e6cfb6c601fe5f20ccf2ac2788c58c19184b9e3e9aaf77240980b' },
  { path: 'eval-baselines/competitive-review-benchmark/ws6-normal-canary-v1.json',
    sha256: '60f724e4ae3782ec8b5be7705d97d5dace662938570a34ac73bd566749e5dc99' },
  { path: 'eval-baselines/competitive-review-benchmark/ws5-p2-display-sort-v1/descriptor.json',
    sha256: 'ff43921f3c8188d6a0efd8a257c310f1ac1d8cefcc32fd1f8fba242c1ecb26af' },
  { path: 'eval-baselines/competitive-review-benchmark/ws5-p2-display-sort-v1/inputs/ws5-p2-display-sort-v1.json',
    sha256: 'c71cd3b3cdf2efd6d83705be5aef8eaa8fe3bb8418e24dfbc0b0a565bf660b2e' },
  { path: 'eval-baselines/competitive-review-benchmark/ws5-repair-sequence-v1/descriptor.json',
    sha256: 'e6b6e359d6c6676c8ab3461b7e576b2d14a77ed92fb7178b0ba0b6cc69d14329' },
  { path: 'eval-baselines/competitive-review-benchmark/ws5-repair-sequence-v1/inputs/ws5-sequence-a-v1.json',
    sha256: '31feff802596e9e8b52aa45b64a1a00fc2af5e221158815c007188b3b11877a5' },
  { path: 'eval-baselines/competitive-review-benchmark/ws5-repair-sequence-v1/inputs/ws5-sequence-b-v1.json',
    sha256: '4023515cfc0daef0b1c00089924ca12d5071080da4e97d6e964c03c8596bbceb' },
  { path: 'eval-baselines/competitive-review-benchmark/ws5-large-crossfile-v1/descriptor.json',
    sha256: '1e929cc12ef523e523dc67e1ee7c3d7ef83268f1e2c4734615c219523e4813c9' },
  { path: 'eval-baselines/competitive-review-benchmark/ws5-large-crossfile-v1/inputs/ws5-large-crossfile-v1.json',
    sha256: 'ad360475a095d194b933f2323b7226f057cc617f8cbb605d5473bd00f00b62f5' },
  { path: 'eval-baselines/competitive-review-benchmark/ws5-external-normal-v2/source-bundle.json',
    sha256: '99b707383ec16eea3ef81994c623e956f551a1e9d0b6acf2dd503afc5d41cfe1' },
  { path: 'eval-baselines/competitive-review-benchmark/ws5-external-normal-v2/phase-plan.json',
    sha256: '2cf0c2455969df0e1a6cdfa4b97ba4c400cad7e1a2da6f52ebb2bd07e159ffc9' },
  { path: 'eval-baselines/competitive-review-benchmark/ws5-external-normal-v2/inputs/p2.json',
    sha256: '4f476e36aa78b6788bb37c02ba5b2fae899c99eeba7d43dae399507cd93ed216' },
  { path: 'eval-baselines/competitive-review-benchmark/ws5-external-normal-v2/inputs/seq_a.json',
    sha256: '0e3bade3d6d7a148a2a36515ed1b40b9c1ab3f4cc2b2d92343176f2069ca0da9' },
  { path: 'eval-baselines/competitive-review-benchmark/ws5-external-normal-v2/inputs/seq_b.json',
    sha256: '52cdd6d19fc5dd042412a85df5b4effe8c9793c43cea3104ab5b35d036b1d1aa' },
  { path: 'eval-baselines/competitive-review-benchmark/ws5-external-normal-v2/inputs/coverage_hole.json',
    sha256: '6cf9a5f6c493f1db2f91f8abc907e9d4f9f9ad1d3c62296298326cb18f78897c' },
  { path: 'eval-baselines/competitive-review-benchmark/ws5-external-normal-v2/inputs/provider_failure.json',
    sha256: '76278ffbbb439e4e4d7b77dabe6022c01cf2c33d61753127cc82c542a9d1e2bd' },
  { path: 'eval-baselines/competitive-review-benchmark/ws5-external-normal-v2/inputs/resource_exhaustion.json',
    sha256: '015efdfc7c5253cb52e4ec99f22bfc354ea51ae54667f161993a98b1566cd1bc' },
  { path: 'eval-baselines/competitive-review-benchmark/ws5-external-normal-v3/source-bundle.json',
    sha256: 'd83b08f04890604fd1bfe98105e6db7ad70945afb1e5471218ca62d2204cc3bc' },
  { path: 'eval-baselines/competitive-review-benchmark/ws5-external-normal-v3/inputs/input-001.json',
    sha256: '54bb996bbd1caee73b313bc25676253469bdc9f40496ed937a0cfad32c29b162' },
  { path: 'eval-baselines/competitive-review-benchmark/ws5-external-normal-v3/inputs/input-002.json',
    sha256: 'f1b5a2f7b838cacd039972da5de7cb066ca838882e31e840190850591ae5c37f' },
  { path: 'eval-baselines/competitive-review-benchmark/ws5-external-normal-v3/inputs/input-003.json',
    sha256: '6fcfa7a254eb960ae3a2ef79358e06205e6812c748e353679ead1578b11a1e84' },
  { path: 'eval-baselines/competitive-review-benchmark/ws5-external-normal-v3/inputs/input-004.json',
    sha256: 'e3cfadf9e9937c66d4c8fdfd90d97668fc691a185bba6960cb8379b276b9cb97' },
]);

export async function verifyQualificationFixtureAllowlist(root = process.cwd(), excludedPaths = []) {
  const excluded = new Set(excludedPaths);
  const verified = [];
  for (const fixture of NORMAL_ENGINE_QUALIFICATION_FIXTURE_ALLOWLIST) {
    if (excluded.has(fixture.path)) continue;
    if (fixture.path.split('/').some((part) => part.toLowerCase() === 'oracle')) {
      throw new Error('qualification fixture allowlist includes an oracle path');
    }
    const absolutePath = path.resolve(root, fixture.path);
    if (!absolutePath.startsWith(`${path.resolve(root)}${path.sep}`)) {
      throw new Error('qualification fixture path escapes repository root');
    }
    const bytes = await fs.readFile(absolutePath);
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== fixture.sha256) throw new Error(`qualification fixture digest mismatch: ${fixture.path}`);
    verified.push({ ...fixture, actualSha256: actual });
  }
  return verified;
}

if (process.argv.includes('--check')) {
  verifyQualificationFixtureAllowlist().then((verified) => {
    process.stdout.write(`${JSON.stringify(verified)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
