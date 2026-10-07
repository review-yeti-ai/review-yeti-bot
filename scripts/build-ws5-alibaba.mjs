#!/usr/bin/env node

/** Rebuild the pinned OpenCodeReview comparator in an isolated output/cache directory. */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { ALIBABA_OPEN_CODE_REVIEW_PIN, assertPinnedAlibabaBinary } from './ws5-alibaba.mjs';
import { WS5_ALIBABA_BUILD_ARTIFACT_PIN } from './ws5-alibaba-build-provenance.mjs';

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
  const tree = execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8', timeout: 10_000 }).trim();
  const status = execFileSync('git', ['-C', sourceRoot, 'status', '--porcelain'], { encoding: 'utf8', timeout: 10_000 }).trim();
  if (commit !== ALIBABA_OPEN_CODE_REVIEW_PIN.sourceCommit || tree !== WS5_ALIBABA_BUILD_ARTIFACT_PIN.source.tree
    || status !== '') throw new Error('alibaba_source_checkout_not_pinned_clean');
  if (`${process.platform}/${process.arch}` !== WS5_ALIBABA_BUILD_ARTIFACT_PIN.platform) {
    throw new Error('alibaba_build_platform_unsupported');
  }
  const goVersion = execFileSync('go', ['version'], { encoding: 'utf8', timeout: 10_000 }).trim();
  if (goVersion !== `go version ${WS5_ALIBABA_BUILD_ARTIFACT_PIN.buildWitness.toolchain}`) {
    throw new Error('alibaba_build_toolchain_unsupported');
  }
  const goModPath = path.join(sourceRoot, 'go.mod');
  const goSumPath = path.join(sourceRoot, 'go.sum');
  const sourceGoModSha256 = sha256(fs.readFileSync(goModPath));
  const sourceGoSumSha256 = sha256(fs.readFileSync(goSumPath));
  if (sourceGoModSha256 !== WS5_ALIBABA_BUILD_ARTIFACT_PIN.buildWitness.goModSha256
    || sourceGoSumSha256 !== WS5_ALIBABA_BUILD_ARTIFACT_PIN.buildWitness.goSumSha256) {
    throw new Error('alibaba_build_module_pins_mismatch');
  }
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
    GOPROXY: 'off',
    GOSUMDB: 'sum.golang.org',
    GOPRIVATE: '',
    GONOPROXY: '',
    GONOSUMDB: '',
    GOTOOLCHAIN: 'local',
  };
  execFileSync('go', ['build', '-mod=readonly', '-trimpath', '-ldflags', ldflags, '-o', target, './cmd/opencodereview'], {
    cwd: sourceRoot, env, stdio: ['ignore', 'ignore', 'pipe'], timeout: 300_000, maxBuffer: 2 * 1024 * 1024,
  });
  fs.chmodSync(target, 0o700);
  const binary = assertPinnedAlibabaBinary(target);
  if (binary.sha256 !== ALIBABA_OPEN_CODE_REVIEW_PIN.binarySha256) throw new Error('alibaba_rebuilt_binary_digest_mismatch');
  if (sha256(fs.readFileSync(goModPath)) !== sourceGoModSha256 || sha256(fs.readFileSync(goSumPath)) !== sourceGoSumSha256) {
    throw new Error('alibaba_build_modified_module_files');
  }
  const builderDirectory = path.dirname(fileURLToPath(import.meta.url));
  const adapterSourceSha256 = sha256(fs.readFileSync(path.join(builderDirectory, 'ws5-alibaba.mjs')));
  const buildScriptSha256 = sha256(fs.readFileSync(fileURLToPath(import.meta.url)));
  const buildFlagsDigest = sha256(Buffer.from(ldflags));
  if (buildFlagsDigest !== WS5_ALIBABA_BUILD_ARTIFACT_PIN.buildWitness.buildFlagsSha256) {
    throw new Error('alibaba_build_flags_pin_mismatch');
  }
  return {
    ...binary,
    goVersion,
    platform: `${process.platform}/${process.arch}`,
    source: {
      repository: ALIBABA_OPEN_CODE_REVIEW_PIN.repository,
      commit,
      tree,
      version: ALIBABA_OPEN_CODE_REVIEW_PIN.version,
    },
    currentBuilderSource: {
      adapterSourceSha256,
      buildScriptSha256,
      sourceFreezePatchSha256: WS5_ALIBABA_BUILD_ARTIFACT_PIN.buildWitness.sourceFreezePatchSha256,
    },
    moduleInputs: { goModSha256: sourceGoModSha256, goSumSha256: sourceGoSumSha256, unchangedAfterBuild: true },
    buildFlagsDigest,
    buildArtifactPinSchema: WS5_ALIBABA_BUILD_ARTIFACT_PIN.schemaVersion,
    reproducibilityWitnessReference: {
      binarySha256: WS5_ALIBABA_BUILD_ARTIFACT_PIN.binarySha256,
      sourceFreezePatchSha256: WS5_ALIBABA_BUILD_ARTIFACT_PIN.buildWitness.sourceFreezePatchSha256,
      runReceipts: WS5_ALIBABA_BUILD_ARTIFACT_PIN.buildWitness.runReceipts,
      dependencyFetchReceiptSha256: WS5_ALIBABA_BUILD_ARTIFACT_PIN.buildWitness.dependencyFetchReceiptSha256,
    },
  };
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
