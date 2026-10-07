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
]);

export async function verifyQualificationFixtureAllowlist(root = process.cwd()) {
  const verified = [];
  for (const fixture of NORMAL_ENGINE_QUALIFICATION_FIXTURE_ALLOWLIST) {
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
