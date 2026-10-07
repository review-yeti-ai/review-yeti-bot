#!/usr/bin/env node

/** Rebuild the pinned OpenCodeReview comparator in an isolated output/cache directory. */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { ALIBABA_OPEN_CODE_REVIEW_PIN, assertPinnedAlibabaBinary } from './ws5-alibaba.mjs';

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function buildPinnedAlibaba({ sourceDirectory, outputPath, goModCacheDirectory, goCacheDirectory } = {}) {
  const sourceRoot = path.resolve(sourceDirectory || '');
  const target = path.resolve(outputPath || '');
  if (!sourceDirectory || !outputPath || !goModCacheDirectory || !goCacheDirectory) {
    throw new Error('build_paths_required');
  }
  const commit = execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10_000 }).trim();
  const status = execFileSync('git', ['-C', sourceRoot, 'status', '--porcelain'], { encoding: 'utf8', timeout: 10_000 }).trim();
  if (commit !== ALIBABA_OPEN_CODE_REVIEW_PIN.sourceCommit || status !== '') throw new Error('alibaba_source_checkout_not_pinned_clean');
  if (fs.existsSync(target)) throw new Error('build_output_already_exists');
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.mkdirSync(goModCacheDirectory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(goCacheDirectory, { recursive: true, mode: 0o700 });
  const ldflags = `-s -w -X main.Version=${ALIBABA_OPEN_CODE_REVIEW_PIN.version} -X main.GitCommit=${ALIBABA_OPEN_CODE_REVIEW_PIN.sourceCommit}`;
  const env = {
    ...process.env,
    GOMODCACHE: path.resolve(goModCacheDirectory),
    GOCACHE: path.resolve(goCacheDirectory),
    GOFLAGS: '',
    GOTOOLCHAIN: 'local',
  };
  execFileSync('go', ['build', '-mod=readonly', '-trimpath', '-ldflags', ldflags, '-o', target, './cmd/opencodereview'], {
    cwd: sourceRoot, env, stdio: ['ignore', 'ignore', 'pipe'], timeout: 300_000, maxBuffer: 2 * 1024 * 1024,
  });
  fs.chmodSync(target, 0o700);
  const binary = assertPinnedAlibabaBinary(target);
  if (binary.sha256 !== ALIBABA_OPEN_CODE_REVIEW_PIN.binarySha256) throw new Error('alibaba_rebuilt_binary_digest_mismatch');
  const goVersion = execFileSync('go', ['version'], { encoding: 'utf8', timeout: 10_000 }).trim();
  return { ...binary, goVersion, platform: `${process.platform}/${process.arch}`, buildFlagsDigest: sha256(Buffer.from(ldflags)) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const value = (flag) => {
      const index = args.indexOf(flag);
      if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('required_build_flag_missing');
      return args[index + 1];
    };
    const receipt = buildPinnedAlibaba({
      sourceDirectory: value('--source'),
      outputPath: value('--out'),
      goModCacheDirectory: value('--gomodcache'),
      goCacheDirectory: value('--gocache'),
    });
    process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
  } catch (error) {
    const code = String(error?.message || 'alibaba_build_failed');
    process.stderr.write('Pinned Alibaba build failed closed: '
      + (/^[a-z0-9_-]{1,100}$/iu.test(code) ? code : 'build_failed') + '\n');
    process.exitCode = 2;
  }
}
