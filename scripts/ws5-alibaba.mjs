#!/usr/bin/env node

/** Bounded OpenCodeReview adapter for the frozen WS5 public panel. */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadPinnedAcceptancePlan } from './ws5-acceptance.mjs';
import { preflightPinnedGitSnapshot } from './competitive-review-benchmark.mjs';
import { WS5_ALIBABA_BUILD_ARTIFACT_PIN, verifyWs5AlibabaDerivedBuildBinding } from './ws5-alibaba-build-provenance.mjs';

export const ALIBABA_OPEN_CODE_REVIEW_PIN = Object.freeze({
  repository: 'https://github.com/alibaba/open-code-review',
  sourceCommit: '182898cf522da3d04157b422752d028417974e19',
  version: 'v1.12.12',
  binarySha256: WS5_ALIBABA_BUILD_ARTIFACT_PIN.binarySha256,
  platform: 'darwin/arm64',
});

const DEFAULT_CACHE_ROOT = '/tmp/yeti-get-well-20261005/ws5-mergebase-source-cache';
const MAX_CASE_WALL_MS = 1_200_000;
const MAX_TEST_CONTROL_WALL_MS = 60_000;
const MAX_COMPLETION_ATTEMPTS = 100;
const MAX_INBOUND_ATTEMPTS = 600;
const MAX_OUTPUT_TOKENS = 65_536;
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES_PER_REQUEST = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES_PER_CASE = 64 * 1024 * 1024;
const UPSTREAM_REQUEST_TIMEOUT_MS = 240_000;
const MAX_CASES = 7;
const HASH_RE = /^[a-f0-9]{40}$/iu;
const SHA256_RE = /^[a-f0-9]{64}$/iu;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function safePath(root, input) {
  const resolved = path.resolve(root, input);
  const relative = path.relative(path.resolve(root), resolved);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep)) throw new Error('artifact_path_escape');
  return resolved;
}

function parseJson(bytes, errorCode) {
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw new Error(errorCode); }
}

function safeModelId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:/@+-]{1,160}$/u.test(value) ? value : null;
}

function safeFailureClass(error) {
  const code = String(error?.cause?.code || error?.code || '').toUpperCase();
  if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE'].includes(code)) return code;
  if (error?.name === 'AbortError') return 'ABORTED';
  if (error?.name === 'TimeoutError') return 'TIMEOUT';
  return 'UPSTREAM_ERROR';
}

function readJsonFile(filePath, code) {
  return parseJson(fs.readFileSync(filePath), code);
}

function sourceCachePath(root, repository) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) throw new Error('invalid_public_repository');
  return path.resolve(root, repository.replace(/[^A-Za-z0-9._-]+/gu, '__'));
}

function runGitRaw(repoPath, args, { env = process.env, timeout = 30_000, maxBuffer = 12 * 1024 * 1024 } = {}) {
  return execFileSync('git', args, {
    cwd: repoPath,
    encoding: 'utf8',
    env: safeGitEnvironment(env),
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
    maxBuffer,
  });
}

function safeGitEnvironment(overrides = {}) {
  const merged = { ...process.env, ...overrides };
  const safe = Object.fromEntries(Object.entries(merged)
    .filter(([name]) => !/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|GATEWAY|ENDPOINT|BASE_URL|AUTH_TOKEN|AUTHORIZATION)/iu.test(name)));
  return {
    ...safe,
    GIT_NO_LAZY_FETCH: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_LFS_SKIP_SMUDGE: '1',
  };
}

function runGit(repoPath, args, options = {}) {
  return runGitRaw(repoPath, args, options).trimEnd();
}

function gitOutput(repoPath, args, options = {}) {
  return runGit(repoPath, args, options).trim();
}

function canonicalizeIndexAbbreviation(patch) {
  return String(patch).replace(/^index [a-f0-9]+\.\.[a-f0-9]+(?: \d+)?$/gimu, 'index <object-id>..<object-id>');
}

function verifyCaseDiffBytes(repoPath, sourceCase, baseSha, headSha) {
  const changedPaths = gitOutput(repoPath, ['diff', '--name-only', '-z', baseSha, headSha])
    .split('\0').filter(Boolean).sort();
  const expected = [...sourceCase.changedFiles].map((entry) => entry.path).sort();
  if (JSON.stringify(changedPaths) !== JSON.stringify(expected)) throw new Error('alibaba_projection_changed_path_mismatch');
  const patchRows = [];
  const indexMetadataVariancePaths = [];
  for (const entry of sourceCase.changedFiles) {
    const patch = runGitRaw(repoPath, ['-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--full-index', '--unified=5',
      baseSha, headSha, '--', entry.path], { maxBuffer: 16 * 1024 * 1024 });
    if (patch !== entry.patch) throw new Error(`alibaba_projection_patch_mismatch_${sha256(entry.patch).slice(0,12)}_${sha256(patch).slice(0,12)}`);
    patchRows.push([entry.path, sha256(patch)]);
  }
  patchRows.sort(([left], [right]) => left.localeCompare(right));
  return {
    changedPaths,
    fullIndexPatchSetSha256: sha256(JSON.stringify(patchRows)),
    acceptedInputPatchSetSha256: sha256(JSON.stringify([...sourceCase.changedFiles]
      .map((entry) => [entry.path, sha256(entry.patch)])
      .sort(([left], [right]) => left.localeCompare(right)))),
    indexMetadataVariancePaths,
    sourceLineContentAndHunksExact: true,
  };
}

/** Clone one source cache in isolation, hydrate exact pins with bounded history, or make a tree-exact projection. */
export function createCliSourceRepository(sourceCase, cacheRoot, tempRoot = os.tmpdir(), { hydrationMode = 'bounded' } = {}) {
  if (!['bounded', 'projection_only'].includes(hydrationMode)) throw new Error('alibaba_history_hydration_mode_invalid');
  const sourceCache = sourceCachePath(cacheRoot, sourceCase.repository);
  const tempDirectory = fs.mkdtempSync(path.join(tempRoot, 'ws5-ocr-source-'));
  const repoPath = path.join(tempDirectory, 'repo');
  try {
    fs.mkdirSync(repoPath, { recursive: true });
    execFileSync('git', ['init', '--quiet', repoPath], {
      encoding: 'utf8',
      env: safeGitEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    runGit(repoPath, ['config', 'core.abbrev', '40']);
    const sourceObjects = path.join(sourceCache, '.git', 'objects');
    const localGitDirectory = path.join(repoPath, '.git');
    const alternatePath = path.join(localGitDirectory, 'objects', 'info', 'alternates');
    fs.mkdirSync(path.dirname(alternatePath), { recursive: true });
    fs.writeFileSync(alternatePath, sourceObjects + '\n', { mode: 0o600 });
    const sourceShallow = path.join(sourceCache, '.git', 'shallow');
    if (fs.existsSync(sourceShallow)) fs.copyFileSync(sourceShallow, path.join(localGitDirectory, 'shallow'));
    const datasetBaseSha = sourceCase.datasetBaseSha;
    const diffBaseSha = sourceCase.diffBaseSha;
    const headSha = sourceCase.headSha;
    if (![datasetBaseSha, diffBaseSha, headSha].every((sha) => HASH_RE.test(String(sha || '')))) {
      throw new Error('alibaba_cli_source_pin_invalid');
    }
    const publicUrl = `https://github.com/${sourceCase.repository}.git`;
    runGit(repoPath, ['remote', 'add', 'origin', publicUrl]);
    runGit(repoPath, ['update-ref', 'refs/heads/ws5-pinned-source-head', headSha]);
    runGit(repoPath, ['symbolic-ref', 'HEAD', 'refs/heads/ws5-pinned-source-head']);
    let ancestryHydration = 'local_history_sufficient';
    let hydrationFailureClass = null;
    let actualMergeBase = null;
    try {
      actualMergeBase = gitOutput(repoPath, ['merge-base', datasetBaseSha, headSha], { timeout: 15_000 });
    } catch {
      actualMergeBase = null;
    }
    if (actualMergeBase === null && hydrationMode === 'bounded') {
      ancestryHydration = 'bounded_exact_pin_hydration_attempted';
      try {
        runGit(repoPath, ['-c', 'protocol.version=2', 'fetch', '--quiet', '--no-tags', '--deepen=1024',
          '--filter=blob:none', 'origin', datasetBaseSha, headSha], { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
        actualMergeBase = gitOutput(repoPath, ['merge-base', datasetBaseSha, headSha], { timeout: 15_000 });
        ancestryHydration = 'exact_pin_history_hydrated_max_1024_commits';
      } catch (error) {
        actualMergeBase = null;
        hydrationFailureClass = safeFailureClass(error);
      }
    }
    const diffBaseTreeSha = gitOutput(repoPath, ['rev-parse', `${diffBaseSha}^{tree}`]);
    const headTreeSha = gitOutput(repoPath, ['rev-parse', `${headSha}^{tree}`]);
    if (!HASH_RE.test(diffBaseTreeSha) || !HASH_RE.test(headTreeSha)) throw new Error('alibaba_cli_source_tree_unavailable');
    let cliFromSha = datasetBaseSha;
    let cliToSha = headSha;
    let projectionCommitSha = null;
    let projectionTreeSha = null;
    let projectionMode = 'native_aacr_dataset_base_to_pinned_head';
    if (actualMergeBase !== null) {
      if (actualMergeBase !== diffBaseSha) throw new Error('alibaba_cli_merge_base_differs_from_pinned_compare');
    } else {
      ancestryHydration = hydrationMode === 'projection_only'
        ? 'projection_only_test_mode_no_network' : 'bounded_hydration_unavailable_projection_fallback';
      projectionTreeSha = headTreeSha;
      const date = '2026-10-06T13:40:00+00:00';
      const projectionEnv = {
        ...process.env,
        GIT_NO_LAZY_FETCH: '1',
        GIT_AUTHOR_NAME: 'WS5 neutral ancestry projection',
        GIT_AUTHOR_EMAIL: 'ws5-projection@example.invalid',
        GIT_COMMITTER_NAME: 'WS5 neutral ancestry projection',
        GIT_COMMITTER_EMAIL: 'ws5-projection@example.invalid',
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
      };
      projectionCommitSha = runGit(repoPath, ['commit-tree', headTreeSha, '-p', diffBaseSha,
        '-m', 'WS5 source-tree ancestry projection'], { env: projectionEnv });
      if (!HASH_RE.test(projectionCommitSha)
        || gitOutput(repoPath, ['rev-parse', `${projectionCommitSha}^{tree}`]) !== headTreeSha
        || gitOutput(repoPath, ['merge-base', diffBaseSha, projectionCommitSha]) !== diffBaseSha) {
        throw new Error('alibaba_tree_projection_identity_mismatch');
      }
      runGit(repoPath, ['update-ref', 'refs/heads/ws5-source-tree-projection', projectionCommitSha]);
      runGit(repoPath, ['symbolic-ref', 'HEAD', 'refs/heads/ws5-source-tree-projection']);
      cliFromSha = diffBaseSha;
      cliToSha = projectionCommitSha;
      actualMergeBase = diffBaseSha;
      projectionMode = 'synthetic_parent_only_tree_identical_to_aacr_pinned_head';
    }
    const diffEvidence = verifyCaseDiffBytes(repoPath, sourceCase, diffBaseSha, cliToSha);
    if (actualMergeBase !== diffBaseSha) throw new Error('alibaba_cli_merge_base_differs_from_pinned_compare');
    return {
      tempDirectory,
      repoPath,
      datasetBaseSha,
      diffBaseSha,
      pinnedHeadSha: headSha,
      pinnedHeadTreeSha: headTreeSha,
      diffBaseTreeSha,
      cliFromSha,
      cliToSha,
      actualMergeBaseSha: actualMergeBase,
      projectionCommitSha,
      projectionTreeSha,
      projectionMode,
      ancestryHydration,
      hydrationFailureClass,
      diffEvidence,
    };
  } catch (error) {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
    throw error;
  }
}

/** @param {{home: string, modelAlias: string, localUrl?: string, localToken?: string|null}} options
 * @returns {Record<string, string>} */
function makeChildEnvironment({ home, modelAlias, localUrl = '', localToken = null }) {
  const childEnv = {
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    OCR_ENABLE_TELEMETRY: '0',
    OCR_CONTENT_LOGGING: '0',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  };
  if (localUrl) {
    let endpoint;
    try { endpoint = new URL(localUrl); } catch { throw new Error('alibaba_child_broker_configuration_invalid'); }
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port
      || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      || typeof localToken !== 'string' || localToken.length < 32) {
      throw new Error('alibaba_child_broker_configuration_invalid');
    }
    Object.assign(childEnv, {
      OCR_LLM_URL: localUrl,
      OCR_LLM_TOKEN: localToken,
      OCR_LLM_MODEL: modelAlias,
      OCR_LLM_PROTOCOL: 'openai',
      OCR_LLM_TIMEOUT: String(Math.floor(UPSTREAM_REQUEST_TIMEOUT_MS / 1000)),
    });
  }
  return childEnv;
}

/** @param {{home: string, modelAlias: string, localUrl?: string, localToken?: string|null}} options
 * @returns {Record<string, string>} */
export function createAlibabaChildEnvironment(options) {
  return makeChildEnvironment(options);
}

export function assertPinnedAlibabaBinary(binaryPath) {
  const resolved = path.resolve(binaryPath);
  let binaryStat;
  try { binaryStat = fs.lstatSync(resolved); } catch { throw new Error('alibaba_binary_missing'); }
  if (!binaryStat.isFile() || binaryStat.isSymbolicLink()) throw new Error('alibaba_binary_missing');
  const binarySha256 = sha256(fs.readFileSync(resolved));
  if (binarySha256 !== ALIBABA_OPEN_CODE_REVIEW_PIN.binarySha256) throw new Error('alibaba_binary_digest_mismatch');
  if ((binaryStat.mode & 0o777) !== 0o700 || binaryStat.size !== WS5_ALIBABA_BUILD_ARTIFACT_PIN.sizeBytes) {
    throw new Error('alibaba_binary_metadata_mismatch');
  }
  const versionOutput = execFileSync(resolved, ['--version'], { encoding: 'utf8', timeout: 10_000, maxBuffer: 16_384 }).trim();
  const versionLines = versionOutput.split(/\r?\n/u);
  const expected = `open-code-review ${ALIBABA_OPEN_CODE_REVIEW_PIN.version} (${ALIBABA_OPEN_CODE_REVIEW_PIN.sourceCommit}) ${ALIBABA_OPEN_CODE_REVIEW_PIN.platform}`;
  if (versionLines.length !== 2 || versionLines[0] !== expected || versionLines[1] !== ALIBABA_OPEN_CODE_REVIEW_PIN.repository) {
    throw new Error('alibaba_binary_version_mismatch');
  }
  const help = execFileSync(resolved, ['review', '--help'], { encoding: 'utf8', timeout: 10_000, maxBuffer: 64_000 });
  for (const flag of ['--from', '--to', '--repo', '--format', '--output', '--model', '--effort', '--concurrency', '--timeout']) {
    if (!help.includes(flag)) throw new Error('alibaba_cli_contract_missing_flag');
  }
  return { path: resolved, sha256: binarySha256, version: versionLines[0], sourceCommit: ALIBABA_OPEN_CODE_REVIEW_PIN.sourceCommit,
    mode: '0o700', sizeBytes: binaryStat.size, buildArtifactPinSchema: WS5_ALIBABA_BUILD_ARTIFACT_PIN.schemaVersion };
}

function verifyPrivateAlibabaBuildBinding({ bundle, binaryPath, buildBindingPath, buildBindingSha256 }) {
  return verifyWs5AlibabaDerivedBuildBinding({
    bindingPath: buildBindingPath,
    bindingSha256: buildBindingSha256,
    binaryPath,
    sourceRoot: ROOT,
    dataRoot: bundle?.dataRootPath,
    bundle,
  });
}

function runPreview(binaryPath, sourceCase, cliSource, tempRoot, rulePath = null) {
  const home = fs.mkdtempSync(path.join(tempRoot, 'ocr-preview-home-'));
  const outputPath = path.join(home, 'preview.json');
  try {
    const env = makeChildEnvironment({ home, modelAlias: 'ws5-preview-no-provider' });
    const args = [
      '--color', 'never', 'review', '--repo', cliSource.repoPath,
      '--from', cliSource.cliFromSha, '--to', cliSource.cliToSha,
      '--format', 'json', '--audience', 'agent', '--preview', '--output', outputPath,
    ];
    if (rulePath) args.push('--rule', rulePath);
    execFileSync(binaryPath, args, { cwd: cliSource.repoPath, env, stdio: ['ignore', 'ignore', 'ignore'], timeout: 60_000, maxBuffer: 16_384 });
    const preview = readJsonFile(outputPath, 'alibaba_preview_json_invalid');
    if (!Array.isArray(preview.files)) throw new Error('alibaba_preview_file_list_missing');
    return preview;
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

export function previewAlibabaSource(binaryPath, sourceCase, cliSource, tempRoot = os.tmpdir()) {
  return runPreview(binaryPath, sourceCase, cliSource, tempRoot);
}

function escapeGlobLiteral(value) {
  return String(value).replace(/[\\*?\[\]]/gu, (character) => '\\' + character);
}

export function prepareAlibabaSourceScope(binaryPath, sourceCase, cliSource, tempRoot = os.tmpdir()) {
  const initialPreview = runPreview(binaryPath, sourceCase, cliSource, tempRoot);
  const expectedPaths = sourceCase.changedFiles.map((entry) => entry.path).sort();
  const initialPaths = initialPreview.files.map((entry) => entry.path).sort();
  if (JSON.stringify(initialPaths) !== JSON.stringify(expectedPaths)) throw new Error('alibaba_initial_preview_path_mismatch');
  const defaultPathExclusions = initialPreview.files.filter((entry) => entry.will_review !== true
    && entry.exclude_reason === 'default_path').map((entry) => entry.path).sort();
  const unsupportedExclusions = initialPreview.files.filter((entry) => entry.will_review !== true
    && entry.exclude_reason !== 'default_path').map((entry) => ({ path: entry.path,
      reason: /^[a-z0-9_]{1,80}$/u.test(entry.exclude_reason || '') ? entry.exclude_reason : 'unknown' }))
    .sort((left, right) => left.path.localeCompare(right.path));
  let rulePath = null;
  let ruleSha256 = null;
  if (defaultPathExclusions.length > 0) {
    rulePath = path.join(cliSource.tempDirectory, 'ws5-exact-source-include.json');
    const ruleBytes = Buffer.from(JSON.stringify({ rules: [], include: defaultPathExclusions.map(escapeGlobLiteral) }, null, 2) + '\n');
    fs.writeFileSync(rulePath, ruleBytes, { mode: 0o600, flag: 'wx' });
    ruleSha256 = sha256(ruleBytes);
  }
  const effectivePreview = rulePath
    ? runPreview(binaryPath, sourceCase, cliSource, tempRoot, rulePath)
    : initialPreview;
  const effectivePaths = effectivePreview.files.map((entry) => entry.path).sort();
  const unreviewedPaths = effectivePreview.files.filter((entry) => entry.will_review !== true)
    .map((entry) => ({ path: entry.path, reason: /^[a-z0-9_]{1,80}$/u.test(entry.exclude_reason || '')
      ? entry.exclude_reason : 'unknown' }));
  if (JSON.stringify(effectivePaths) !== JSON.stringify(expectedPaths)) {
    throw new Error('alibaba_source_coverage_not_complete_after_exact_include_override');
  }
  return {
    initialPreview,
    effectivePreview,
    expectedPaths,
    defaultPathExclusions,
    unsupportedExclusions,
    unreviewedPaths,
    rulePath,
    ruleSha256,
    runEligible: unsupportedExclusions.length === 0 && unreviewedPaths.length === 0,
    status: unsupportedExclusions.length || unreviewedPaths.length ? 'unsupported_source_scope' : 'ready',
    scopeOverride: defaultPathExclusions.length ? 'exact_include_only_for_native_default_path_exclusions' : 'none',
  };
}

/** Verify the exact pinned public panel, local repo cache, and OCR preview before any model request. */
export function preflightAlibabaPanel({
  binaryPath,
  buildBindingPath,
  buildBindingSha256,
  cacheRoot = DEFAULT_CACHE_ROOT,
  root = ROOT,
  dataRoot,
  planPath,
  externalDataContractPath,
  externalDataContractSha256,
  tempRoot = os.tmpdir(),
} = {}) {
  const bundle = loadPinnedAcceptancePlan({ repoRoot: root, dataRoot, planPath,
    externalDataContractPath, externalDataContractSha256 });
  const buildArtifactBinding = verifyPrivateAlibabaBuildBinding({
    bundle, binaryPath, buildBindingPath, buildBindingSha256,
  });
  const binary = assertPinnedAlibabaBinary(binaryPath);
  const planArm = bundle.plan.publicRunMatrix.arms.find((entry) => entry.id === 'alibaba-open-code-review');
  if (!planArm || planArm.sourceCommit !== ALIBABA_OPEN_CODE_REVIEW_PIN.sourceCommit
    || planArm.sourceVersion !== ALIBABA_OPEN_CODE_REVIEW_PIN.version
    || planArm.build?.binarySha256 !== WS5_ALIBABA_BUILD_ARTIFACT_PIN.originalDeclaredBinarySha256
    || bundle.preparedDiscovery.cases.length !== MAX_CASES) throw new Error('alibaba_frozen_arm_mismatch');

  const caseReceipts = [];
  const caseById = new Map(bundle.preparedDiscovery.cases.map((entry) => [entry.caseId, entry]));
  for (const caseId of planArm.caseIds) {
    const sourceCase = caseById.get(caseId);
    if (!sourceCase || sourceCase.sourceOmissions?.length !== 0) throw new Error('alibaba_panel_case_source_incomplete');
    const repoPath = sourceCachePath(cacheRoot, sourceCase.repository);
    const sourceCachePreflight = preflightPinnedGitSnapshot(sourceCase, repoPath);
    if (sourceCachePreflight.status !== 'verified' || sourceCachePreflight.changedFileCount !== sourceCase.changedFiles.length) {
      throw new Error('alibaba_panel_exact_source_preflight_failed');
    }
    const cliSource = createCliSourceRepository(sourceCase, cacheRoot, tempRoot);
    let sourceScope;
    try { sourceScope = prepareAlibabaSourceScope(binary.path, sourceCase, cliSource, tempRoot); }
    finally { fs.rmSync(cliSource.tempDirectory, { recursive: true, force: true }); }
    const preview = sourceScope.effectivePreview;
    const expectedPaths = sourceScope.expectedPaths;
    const declaredLimitations = planArm.nativeSourceLimitations?.[caseId] || [];
    if (sourceScope.unsupportedExclusions.length
      && JSON.stringify(sourceScope.unsupportedExclusions) !== JSON.stringify(declaredLimitations)) {
      throw new Error('alibaba_source_scope_limitation_not_frozen');
    }
    caseReceipts.push({
      caseId,
      repository: sourceCase.repository,
      prNumber: sourceCase.prNumber,
      datasetBaseSha: sourceCase.datasetBaseSha,
      diffBaseSha: sourceCase.diffBaseSha,
      headSha: sourceCase.headSha,
      changedFileCount: expectedPaths.length,
      sourceCachePreflight,
      cliComparison: {
        requestedFromSha: cliSource.cliFromSha,
        requestedToSha: cliSource.cliToSha,
        actualMergeBaseSha: cliSource.actualMergeBaseSha,
        acceptedDiffBaseSha: cliSource.diffBaseSha,
        acceptedDatasetHeadSha: cliSource.pinnedHeadSha,
        acceptedHeadTreeSha: cliSource.pinnedHeadTreeSha,
        projectionCommitSha: cliSource.projectionCommitSha,
        projectionTreeSha: cliSource.projectionTreeSha,
        projectionMode: cliSource.projectionMode,
        ancestryHydration: cliSource.ancestryHydration,
        hydrationFailureClass: cliSource.hydrationFailureClass,
        sourceDiffEvidence: cliSource.diffEvidence,
      },
      preview: {
        totalFiles: preview.total_files,
        reviewableCount: preview.reviewable_count,
        excludedCount: preview.excluded_count,
        changedPathsSha256: sha256(JSON.stringify(sourceScope.expectedPaths)),
        initialDefaultPathExclusions: sourceScope.defaultPathExclusions,
        exactIncludeOverrideSha256: sourceScope.ruleSha256,
        scopeOverride: sourceScope.scopeOverride,
        unsupportedExclusions: sourceScope.unsupportedExclusions,
        unreviewedPaths: sourceScope.unreviewedPaths,
      },
      status: sourceScope.runEligible ? 'ready' : 'source_scope_unsupported',
    });
  }
  const allSourceComplete = caseReceipts.length === MAX_CASES && caseReceipts.every((entry) =>
    ['ready', 'source_scope_unsupported'].includes(entry.status)
      && entry.sourceCachePreflight.changedFileCount === entry.changedFileCount);
  const sourceScopeLimited = caseReceipts.some((entry) => entry.status === 'source_scope_unsupported');
  return {
    schemaVersion: 'WS5AlibabaPreflight.v1',
    status: !allSourceComplete ? 'ABSTAIN' : sourceScopeLimited
      ? 'READY_FOR_PROVIDER_PREFLIGHT_WITH_DECLARED_COMPARATOR_SCOPE_LIMITATION'
      : 'READY_FOR_PROVIDER_PREFLIGHT_AND_ROOT_AUTHORIZATION',
    datasetSha256: bundle.manifestSha256,
    preparedInputSha256: bundle.plan.publicPanel.preparedInputs.discovery.sha256,
    binary,
    buildArtifactBinding: {
      status: buildArtifactBinding.status,
      bindingSha256: buildArtifactBinding.bindingSha256,
      selectedBinarySha256: buildArtifactBinding.binarySha256,
      supersededPlanBinarySha256: buildArtifactBinding.supersededBinarySha256,
      sourceCommit: buildArtifactBinding.sourceCommit,
      sourceTree: buildArtifactBinding.sourceTree,
      sourceVersion: buildArtifactBinding.sourceVersion,
      toolchain: buildArtifactBinding.toolchain,
      buildReceiptCount: buildArtifactBinding.buildReceiptCount,
    },
    panelCaseIds: planArm.caseIds,
    caseCount: caseReceipts.length,
    sourceCompleteCaseCount: caseReceipts.filter((entry) => entry.sourceCachePreflight.status === 'verified').length,
    comparatorReviewableCaseCount: caseReceipts.filter((entry) => entry.status === 'ready').length,
    comparatorScopeUnsupportedCaseCount: caseReceipts.filter((entry) => entry.status === 'source_scope_unsupported').length,
    cases: caseReceipts,
    providerCalls: 0,
    providerPreflight: 'not_performed',
  };
}

function readRequestBody(request, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    request.on('data', (chunk) => {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        reject(new Error('request_body_too_large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function httpError(response, status, code) {
  const body = Buffer.from(JSON.stringify({
    error: { message: code, type: 'ws5_qualification_control', code },
  }), 'utf8');
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': String(body.length) });
  response.end(body);
}

function cleanUpstreamHeaders(headers) {
  const selected = {};
  for (const name of ['content-type', 'cache-control', 'x-request-id', 'x-bifrost-request-id',
    'x-gateway-request-id', 'x-provider', 'x-provider-name', 'x-bifrost-provider', 'x-model', 'x-bifrost-model',
    'retry-after', 'x-should-retry']) {
    const value = headers.get(name);
    if (value) selected[name] = value;
  }
  return selected;
}

function requestIdDigest(headers) {
  for (const name of ['x-bifrost-request-id', 'x-gateway-request-id', 'x-request-id']) {
    const value = headers.get(name);
    if (value) return sha256(value).slice(0, 16);
  }
  return null;
}

function makeUpstreamTarget(baseUrl) {
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw new Error('bifrost_endpoint_must_be_https_without_userinfo_or_query');
  }
  const normalized = base.pathname.replace(/\/+$/u, '');
  const apiRoot = normalized.endsWith('/v1') ? normalized : normalized + '/v1';
  return { origin: base.origin, apiRoot };
}

/** Create a request meter and bounded local forwarder. It never records request or response bodies. */
/** @param {{upstreamBaseUrl?: string, apiKey?: string, modelAlias?: string, maxForwardedAttempts?: number,
 * maxInboundAttempts?: number, maxOutputTokensPerRequest?: number|null,
 * requestAccountingMode?: 'alibaba_sdk'|'review_yeti', localBearerToken?: string|null,
 * localTls?: {key: Buffer, cert: Buffer}|null,
 * mode?: 'normal'|'provider_failure'|'resource_exhaustion', authHeader?: 'authorization'|'x-api-key'}} options */
export function createBifrostMeterProxy({
  upstreamBaseUrl,
  apiKey,
  modelAlias,
  maxForwardedAttempts = MAX_COMPLETION_ATTEMPTS,
  maxInboundAttempts = MAX_INBOUND_ATTEMPTS,
  maxOutputTokensPerRequest = MAX_OUTPUT_TOKENS,
  requestAccountingMode = 'alibaba_sdk',
  localBearerToken = null,
  localTls = null,
  mode = 'normal',
  authHeader = 'authorization',
} = {}) {
  const unboundedOutputAllowed = maxOutputTokensPerRequest === null && requestAccountingMode === 'review_yeti';
  if (typeof apiKey !== 'string' || apiKey.length < 1 || typeof modelAlias !== 'string' || !modelAlias
    || !Number.isSafeInteger(maxForwardedAttempts) || maxForwardedAttempts < 0
    || maxForwardedAttempts > MAX_COMPLETION_ATTEMPTS
    || !Number.isSafeInteger(maxInboundAttempts) || maxInboundAttempts < maxForwardedAttempts
    || maxInboundAttempts > MAX_INBOUND_ATTEMPTS
    || (!unboundedOutputAllowed && (!Number.isSafeInteger(maxOutputTokensPerRequest) || maxOutputTokensPerRequest < 1
      || maxOutputTokensPerRequest > MAX_OUTPUT_TOKENS))
    || !['alibaba_sdk', 'review_yeti'].includes(requestAccountingMode)
    || (localBearerToken !== null && (typeof localBearerToken !== 'string' || localBearerToken.length < 32))
    || (localTls !== null && (!Buffer.isBuffer(localTls?.key) || localTls.key.length === 0
      || !Buffer.isBuffer(localTls?.cert) || localTls.cert.length === 0))
    || !['authorization', 'x-api-key'].includes(String(authHeader).toLowerCase())
    || !['normal', 'provider_failure', 'resource_exhaustion'].includes(mode)) {
    throw new Error('alibaba_proxy_configuration_invalid');
  }
  const target = makeUpstreamTarget(upstreamBaseUrl);
  const secret = apiKey;
  const stats = {
    receivedCompletionAttempts: 0,
    logicalCompletionDispatchStarts: 0,
    forwardedCompletionAttempts: 0,
    localInjectedFailureCount: 0,
    resourceCapRejectionCount: 0,
    requestProfileRejectedCount: 0,
    totalResponseBytes: 0,
    gateway2xxResponses: 0,
    requests: [],
  };
  const retryChainsByRequestDigest = new Map();

  const handleRequest = async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (request.method !== 'POST' || url.pathname !== '/v1/chat/completions' || url.search) {
      httpError(response, 404, 'ws5_route_not_allowlisted');
      return;
    }
    if (localBearerToken !== null && request.headers.authorization !== `Bearer ${localBearerToken}`) {
      httpError(response, 401, 'ws5_loopback_auth_rejected');
      return;
    }
    const requestBytes = await readRequestBody(request, MAX_REQUEST_BYTES).catch((error) => {
      httpError(response, error.message === 'request_body_too_large' ? 413 : 400, 'ws5_request_body_rejected');
      return null;
    });
    if (!requestBytes) return;
    stats.receivedCompletionAttempts += 1;
    if (stats.receivedCompletionAttempts > maxInboundAttempts) {
      stats.resourceCapRejectionCount += 1;
      httpError(response, 429, 'ws5_inbound_attempt_cap_reached');
      return;
    }
    let requestJson;
    try { requestJson = JSON.parse(requestBytes.toString('utf8')); } catch {
      stats.requestProfileRejectedCount += 1;
      httpError(response, 400, 'ws5_request_json_invalid');
      return;
    }
    const requestedModel = safeModelId(requestJson.model);
    const retryHeader = request.headers['x-stainless-retry-count'];
    const retryOrdinal = typeof retryHeader === 'string' && /^\d{1,4}$/u.test(retryHeader) ? Number(retryHeader) : null;
    const requestFingerprint = sha256(requestBytes);
    const localOrdinalHeader = request.headers['x-ws5-local-attempt-ordinal'];
    const logicalOrdinalHeader = request.headers['x-ws5-logical-dispatch-ordinal'];
    const sourceLocalOrdinal = typeof localOrdinalHeader === 'string' && /^\d{1,6}$/u.test(localOrdinalHeader)
      ? Number(localOrdinalHeader) : null;
    const sourceLogicalOrdinal = typeof logicalOrdinalHeader === 'string' && /^\d{1,6}$/u.test(logicalOrdinalHeader)
      ? Number(logicalOrdinalHeader) : null;
    let logicalDispatchOrdinal = null;
    let logicalMappingStatus = 'unclassified';
    if (requestAccountingMode === 'review_yeti') {
      const localOrdinalAvailable = sourceLocalOrdinal !== null && sourceLocalOrdinal > 0
        && sourceLocalOrdinal <= maxInboundAttempts
        && !stats.requests.some((entry) => entry.localAttemptOrdinal === sourceLocalOrdinal);
      if (localOrdinalAvailable && sourceLogicalOrdinal !== null && sourceLogicalOrdinal > 0) {
        logicalDispatchOrdinal = sourceLogicalOrdinal;
        logicalMappingStatus = 'source_instrumented_completion_scope';
      } else {
        logicalMappingStatus = 'invalid_source_completion_ordinals';
      }
    } else if (retryOrdinal === 0) {
      logicalDispatchOrdinal = ++stats.logicalCompletionDispatchStarts;
      logicalMappingStatus = 'new_completion';
      const chain = { logicalDispatchOrdinal, nextRetryOrdinal: 1, retryEligible: false };
      const chains = retryChainsByRequestDigest.get(requestFingerprint) || [];
      chains.push(chain);
      retryChainsByRequestDigest.set(requestFingerprint, chains);
    } else if (retryOrdinal !== null) {
      const chains = retryChainsByRequestDigest.get(requestFingerprint) || [];
      const candidates = chains.filter((entry) => entry.nextRetryOrdinal === retryOrdinal && entry.retryEligible);
      if (candidates.length === 1) {
        logicalDispatchOrdinal = candidates[0].logicalDispatchOrdinal;
        candidates[0].nextRetryOrdinal += 1;
        candidates[0].retryEligible = false;
        logicalMappingStatus = 'sdk_retry_linked_by_body_digest_and_retry_ordinal';
      } else {
        logicalMappingStatus = candidates.length > 1 ? 'ambiguous_retry_link' : 'unmatched_retry_ordinal';
      }
    }
    const requestedMaxOutputTokens = Number.isSafeInteger(requestJson.max_tokens)
      ? requestJson.max_tokens : Number.isSafeInteger(requestJson.max_completion_tokens) ? requestJson.max_completion_tokens : null;
    const localAttemptOrdinal = stats.receivedCompletionAttempts;
    const record = {
      localAttemptOrdinal: requestAccountingMode === 'review_yeti' ? (sourceLocalOrdinal ?? localAttemptOrdinal) : localAttemptOrdinal,
      logicalDispatchStart: requestAccountingMode === 'review_yeti'
        ? logicalDispatchOrdinal !== null && !stats.requests.some((entry) => entry.logicalDispatchOrdinal === logicalDispatchOrdinal)
        : retryOrdinal === 0,
      logicalDispatchOrdinal,
      logicalMappingStatus,
      sdkRetryOrdinal: retryOrdinal,
      requestedModel,
      reasoningEffort: safeModelId(requestJson.reasoning_effort || requestJson.reasoning?.effort),
      maxOutputTokens: requestedMaxOutputTokens,
      stream: requestJson.stream === true,
      requestBytes: requestBytes.byteLength,
      outcome: 'not_forwarded',
      httpStatus: null,
      responseBytes: 0,
      gatewayRequestIdDigest: null,
      responseReportedProvider: null,
      responseReportedModel: null,
      failureClass: null,
    };
    stats.requests.push(record);
    const accountingHeaderInvalid = requestAccountingMode === 'review_yeti'
      ? logicalMappingStatus !== 'source_instrumented_completion_scope'
      : retryOrdinal === null;
    const outputProfileInvalid = requestAccountingMode === 'alibaba_sdk'
      ? requestedMaxOutputTokens === null || requestedMaxOutputTokens < 1
      : requestedMaxOutputTokens !== null && requestedMaxOutputTokens < 1;
    const outputCapExceeded = maxOutputTokensPerRequest !== null && requestedMaxOutputTokens !== null
      && requestedMaxOutputTokens > maxOutputTokensPerRequest;
    if (requestedModel !== modelAlias || accountingHeaderInvalid || outputProfileInvalid || outputCapExceeded) {
      record.failureClass = 'request_profile_rejected';
      stats.requestProfileRejectedCount += 1;
      httpError(response, 400, 'ws5_request_profile_rejected');
      return;
    }
    if (stats.forwardedCompletionAttempts >= maxForwardedAttempts) {
      record.outcome = 'locally_rejected_resource_cap';
      record.httpStatus = 429;
      record.failureClass = 'RESOURCE_CAP';
      stats.resourceCapRejectionCount += 1;
      httpError(response, 429, 'ws5_completion_attempt_cap_reached');
      const chain = (retryChainsByRequestDigest.get(requestFingerprint) || [])
        .find((entry) => entry.logicalDispatchOrdinal === logicalDispatchOrdinal);
      if (chain) chain.retryEligible = true;
      return;
    }
    stats.forwardedCompletionAttempts += 1;
    record.outcome = 'forwarded';
    const headers = new Headers({
      'content-type': 'application/json',
      accept: request.headers.accept || (requestJson.stream ? 'text/event-stream' : 'application/json'),
      'user-agent': 'WS5-OpenCodeReview-Adapter/1',
      [String(authHeader).toLowerCase()]: String(authHeader).toLowerCase() === 'authorization' ? `Bearer ${secret}` : secret,
    });
    const targetUrl = target.origin + target.apiRoot + '/chat/completions';
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(new Error('ws5_upstream_request_timeout')),
      UPSTREAM_REQUEST_TIMEOUT_MS);
    request.on('aborted', () => controller.abort(new Error('ws5_cli_request_aborted')));
    let upstream;
    try {
      upstream = await fetch(targetUrl, {
        method: 'POST',
        headers,
        body: requestBytes,
        signal: controller.signal,
        redirect: 'manual',
        duplex: 'half',
      });
    } catch (error) {
      clearTimeout(timeoutId);
      record.outcome = 'upstream_transport_error';
      record.failureClass = safeFailureClass(error);
      record.httpStatus = 502;
      const chain = (retryChainsByRequestDigest.get(requestFingerprint) || [])
        .find((entry) => entry.logicalDispatchOrdinal === logicalDispatchOrdinal);
      if (chain) chain.retryEligible = true;
      httpError(response, 502, 'ws5_upstream_transport_error');
      return;
    }
    record.httpStatus = upstream.status;
    record.gatewayRequestIdDigest = requestIdDigest(upstream.headers);
    record.responseReportedProvider = safeModelId(upstream.headers.get('x-bifrost-provider')
      || upstream.headers.get('x-provider') || upstream.headers.get('x-provider-name'));
    record.responseReportedModel = safeModelId(upstream.headers.get('x-bifrost-model') || upstream.headers.get('x-model'));
    const shouldRetryHeader = String(upstream.headers.get('x-should-retry') || '').toLowerCase();
    const retryableStatus = [408, 409, 429].includes(upstream.status) || upstream.status >= 500;
    const chain = (retryChainsByRequestDigest.get(requestFingerprint) || [])
      .find((entry) => entry.logicalDispatchOrdinal === logicalDispatchOrdinal);
    if (chain) chain.retryEligible = shouldRetryHeader === 'true' || (shouldRetryHeader !== 'false' && retryableStatus);
    if (upstream.status >= 200 && upstream.status < 300) stats.gateway2xxResponses += 1;
    response.writeHead(upstream.status, cleanUpstreamHeaders(upstream.headers));
    try {
      if (upstream.body) {
        for await (const chunkValue of upstream.body) {
          const chunk = Buffer.from(chunkValue);
          record.responseBytes += chunk.byteLength;
          stats.totalResponseBytes += chunk.byteLength;
          if (record.responseBytes > MAX_RESPONSE_BYTES_PER_REQUEST
            || stats.totalResponseBytes > MAX_RESPONSE_BYTES_PER_CASE) {
            controller.abort(new Error('ws5_response_byte_cap_reached'));
            record.outcome = 'response_byte_cap';
            record.failureClass = 'RESPONSE_BYTE_CAP';
            response.destroy();
            return;
          }
          if (!response.write(chunk)) await new Promise((resolve) => response.once('drain', resolve));
        }
      }
      record.outcome = 'upstream_response_complete';
      response.end();
    } catch (error) {
      record.outcome = 'upstream_response_stream_error';
      record.failureClass = safeFailureClass(error);
      response.destroy();
    } finally {
      clearTimeout(timeoutId);
    }
  };
  const server = localTls
    ? https.createServer({ key: localTls.key, cert: localTls.cert }, handleRequest)
    : http.createServer(handleRequest);

  return {
    server,
    stats,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('ws5_local_proxy_bind_failed');
      return `${localTls ? 'https' : 'http'}://127.0.0.1:${address.port}/v1`;
    },
    async close() {
      if (!server.listening) return;
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    },
    snapshot() {
      const requests = stats.requests.map((entry) => ({ ...entry }));
      const invalidRetryHeaders = requests.filter((entry) => entry.sdkRetryOrdinal === null).length;
      const logicalGroups = new Map();
      for (const request of requests) {
        if (!Number.isSafeInteger(request.logicalDispatchOrdinal)) continue;
        const localAttemptOrdinals = logicalGroups.get(request.logicalDispatchOrdinal) || [];
        localAttemptOrdinals.push(request.localAttemptOrdinal);
        logicalGroups.set(request.logicalDispatchOrdinal, localAttemptOrdinals);
      }
      const dispatches = [...logicalGroups].map(([logicalDispatchOrdinal, localAttemptOrdinals]) => ({
        logicalDispatchOrdinal,
        localAttemptOrdinals,
        localHttpRequestAttempts: localAttemptOrdinals.length,
        stage: 'alibaba',
        classification: 'http_attempted',
      })).sort((a, b) => a.logicalDispatchOrdinal - b.logicalDispatchOrdinal);
      const unknownAttemptCount = requests.filter((entry) => !Number.isSafeInteger(entry.logicalDispatchOrdinal)).length;
      return {
        receivedCompletionAttempts: stats.receivedCompletionAttempts,
        logicalCompletionDispatchStarts: stats.logicalCompletionDispatchStarts,
        logicalCompletionDispatches: dispatches.length,
        dispatches,
        unknownAttemptCount,
        dispatchAttemptAccountingMatches: unknownAttemptCount === 0
          && dispatches.reduce((sum, entry) => sum + entry.localHttpRequestAttempts, 0) === stats.receivedCompletionAttempts,
        sdkRetryAttemptCount: requests.filter((entry) => Number.isSafeInteger(entry.sdkRetryOrdinal) && entry.sdkRetryOrdinal > 0).length,
        forwardedCompletionAttempts: stats.forwardedCompletionAttempts,
        localInjectedFailureCount: stats.localInjectedFailureCount,
        resourceCapRejectionCount: stats.resourceCapRejectionCount,
        requestProfileRejectedCount: stats.requestProfileRejectedCount,
        invalidRetryHeaderCount: invalidRetryHeaders,
        totalResponseBytes: stats.totalResponseBytes,
        gateway2xxResponses: stats.gateway2xxResponses,
        credentialMode: mode === 'provider_failure' ? 'invalid_sentinel_only' : 'bifrost_credential_in_memory',
        requests,
      };
    },
  };
}

/** Pair a per-run random child token with the local broker that enforces that exact token. */
/** @param {{upstreamBaseUrl?: string, apiKey?: string, modelAlias?: string,
 * maxForwardedAttempts?: number, maxInboundAttempts?: number, mode?: 'normal'|'provider_failure'|'resource_exhaustion'}} options */
export function createAlibabaLocalBroker({
  upstreamBaseUrl,
  apiKey,
  modelAlias,
  maxForwardedAttempts = MAX_COMPLETION_ATTEMPTS,
  maxInboundAttempts = MAX_INBOUND_ATTEMPTS,
  mode = 'normal',
} = {}) {
  const localToken = crypto.randomBytes(32).toString('hex');
  const proxy = createBifrostMeterProxy({
    upstreamBaseUrl,
    apiKey,
    modelAlias,
    maxForwardedAttempts,
    maxInboundAttempts,
    mode,
    localBearerToken: localToken,
  });
  return { proxy, localToken };
}

function normalizeCoverage(manifest, expectedPaths) {
  const coverage = manifest?.coverage;
  if (!coverage || !Array.isArray(coverage.selected) || !Array.isArray(coverage.completed)
    || !Array.isArray(coverage.reused) || !Array.isArray(coverage.failed) || !Array.isArray(coverage.waived)) {
    return { complete: false, selected: [], completed: [], reused: [], failed: [], waived: [] };
  }
  const selected = coverage.selected.map((entry) => entry.path).sort();
  const completed = coverage.completed.map((entry) => entry.path).sort();
  const reused = coverage.reused.map((entry) => entry.path).sort();
  const failed = coverage.failed.map((entry) => entry.path).sort();
  const waived = coverage.waived.map((entry) => entry.path).sort();
  const expected = [...expectedPaths].sort();
  const selectedSet = new Set(selected);
  const completedSet = new Set(completed);
  const reusedSet = new Set(reused);
  const sourceExact = selected.length === expected.length
    && selected.every((entry) => typeof entry === 'string')
    && selectedSet.size === selected.length
    && new Set(expected).size === expected.length
    && JSON.stringify(selected) === JSON.stringify(expected);
  const completedAndReusedAreExactPartition = completed.every((entry) => typeof entry === 'string')
    && reused.every((entry) => typeof entry === 'string')
    && completedSet.size === completed.length
    && reusedSet.size === reused.length
    && completed.every((entry) => selectedSet.has(entry))
    && reused.every((entry) => selectedSet.has(entry))
    && completed.every((entry) => !reusedSet.has(entry))
    && completedSet.size + reusedSet.size === selectedSet.size
    && [...selectedSet].every((entry) => completedSet.has(entry) || reusedSet.has(entry));
  const fullyCovered = sourceExact && completedAndReusedAreExactPartition
    && failed.length === 0 && waived.length === 0;
  return {
    complete: manifest.terminal_state === 'complete' && fullyCovered,
    sourceExact,
    completedAndReusedAreExactPartition,
    expectedFileCount: expectedPaths.length,
    selectedFileCount: selected.length,
    completedFileCount: completed.length,
    reusedFileCount: reused.length,
    failedFileCount: failed.length,
    waivedFileCount: waived.length,
    selectedPathsSha256: sha256(JSON.stringify(selected)),
    completedPathsSha256: sha256(JSON.stringify(completed)),
    reusedPathsSha256: sha256(JSON.stringify(reused)),
    failedPathsSha256: sha256(JSON.stringify(failed)),
    waivedPathsSha256: sha256(JSON.stringify(waived)),
    selected,
    completed,
    reused,
    failed,
    waived,
  };
}

/** Normalize without preserving CLI thinking, raw errors, session data, or telemetry text. */
export function normalizeAlibabaRun(output, {
  caseId,
  sourceCase,
  elapsedMs,
  binarySha256,
  modelAlias,
  proxyReceipt,
  expectedChangedPaths,
  sourceCachePreflight,
  cliSource,
  sourceScope,
} = {}) {
  const manifest = output?.manifest;
  const coverage = normalizeCoverage(manifest, [...expectedChangedPaths].sort());
  const summary = output?.summary || {};
  const requestedModel = safeModelId(modelAlias);
  const requests = proxyReceipt?.requests || [];
  const logicalStarts = proxyReceipt?.logicalCompletionDispatches ?? 0;
  const attemptRecordsComplete = proxyReceipt?.invalidRetryHeaderCount === 0
    && proxyReceipt?.unknownAttemptCount === 0 && proxyReceipt?.dispatchAttemptAccountingMatches === true
    && requests.every((entry) => Number.isSafeInteger(entry.sdkRetryOrdinal)
      && Number.isSafeInteger(entry.localAttemptOrdinal) && Number.isSafeInteger(entry.logicalDispatchOrdinal));
  const tokenCount = Number.isSafeInteger(summary.total_tokens) && summary.total_tokens >= 0 ? summary.total_tokens : null;
  const promptTokens = Number.isSafeInteger(summary.input_tokens) && summary.input_tokens >= 0 ? summary.input_tokens : null;
  const completionTokens = Number.isSafeInteger(summary.output_tokens) && summary.output_tokens >= 0 ? summary.output_tokens : null;
  const comments = Array.isArray(output?.comments) ? output.comments.map((entry, index) => ({
    findingId: `${caseId}:ocr:${index + 1}`,
    path: typeof entry.path === 'string' ? entry.path : null,
    startLine: Number.isSafeInteger(entry.start_line) ? entry.start_line : null,
    endLine: Number.isSafeInteger(entry.end_line) ? entry.end_line : null,
    category: safeModelId(entry.category),
    severity: safeModelId(entry.severity),
    content: typeof entry.content === 'string' ? entry.content : '',
    suggestionCode: typeof entry.suggestion_code === 'string' ? entry.suggestion_code : null,
  })) : [];
  const completed = coverage.complete && output.status === 'complete' && tokenCount !== null
    && Number.isSafeInteger(elapsedMs) && elapsedMs >= 0 && proxyReceipt?.resourceCapRejectionCount === 0;
  return {
    armId: 'alibaba-open-code-review',
    caseId,
    status: completed ? 'completed' : 'incomplete',
    source: {
      repository: sourceCase.repository,
      prNumber: sourceCase.prNumber,
      datasetBaseSha: sourceCase.datasetBaseSha,
      diffBaseSha: sourceCase.diffBaseSha,
      mergeBaseSha: sourceCase.mergeBaseSha,
      baseSha: sourceCase.baseSha,
      headSha: sourceCase.headSha,
      changedFiles: expectedChangedPaths.length,
      sourceOmissions: [],
      sourceReadOmissions: [],
      sourceCachePreflight,
      changedDiffSha256: sha256(sourceCase.changedFiles.map((entry) => entry.patch).join('')),
      previewCoverage: 'preflight_exact_changed_path_set',
      initialDefaultPathExclusions: sourceScope?.defaultPathExclusions || [],
      sourceScopeOverride: sourceScope?.scopeOverride || 'unknown',
      exactIncludeOverrideSha256: sourceScope?.ruleSha256 || null,
      cliComparison: {
        requestedFromSha: cliSource.cliFromSha,
        requestedToSha: cliSource.cliToSha,
        actualMergeBaseSha: cliSource.actualMergeBaseSha,
        acceptedDiffBaseSha: cliSource.diffBaseSha,
        acceptedDatasetHeadSha: cliSource.pinnedHeadSha,
        acceptedHeadTreeSha: cliSource.pinnedHeadTreeSha,
        projectionCommitSha: cliSource.projectionCommitSha,
        projectionTreeSha: cliSource.projectionTreeSha,
        projectionMode: cliSource.projectionMode,
        ancestryHydration: cliSource.ancestryHydration,
        hydrationFailureClass: cliSource.hydrationFailureClass,
        sourceDiffEvidence: cliSource.diffEvidence,
      },
    },
    coverage: {
      rosterValid: coverage.sourceExact === true,
      quorumSatisfied: null,
      quorumComparable: false,
      quorumSemantics: 'single-agent-native-file-coverage-manifest-no-persona-quorum',
      fullPanelComplete: coverage.complete,
      ...coverage,
    },
    metrics: {
      totalPromptTokens: promptTokens,
      totalCompletionTokens: completionTokens,
      totalTokens: tokenCount,
      totalTurns: logicalStarts,
      totalDurationMs: elapsedMs,
    },
    model: {
      transport: 'Bifrost via local WS5 request meter',
      requestedAlias: requestedModel,
      responseReportedModel: safeModelId(output?.llm?.model),
      responseReportedProvider: safeModelId(output?.llm?.provider),
      httpAttempts: requests.map((entry) => ({
        localAttemptOrdinal: entry.localAttemptOrdinal,
        logicalDispatchOrdinal: entry.logicalDispatchOrdinal,
        logicalMappingStatus: entry.logicalMappingStatus,
        sdkRetryOrdinal: entry.sdkRetryOrdinal,
        gatewayRequestIdDigests: entry.gatewayRequestIdDigest ? [entry.gatewayRequestIdDigest] : [],
        httpStatus: entry.httpStatus,
        status: entry.outcome,
        responseReportedProvider: entry.responseReportedProvider,
        responseReportedModel: entry.responseReportedModel,
        reasoningEffort: entry.reasoningEffort,
        maxOutputTokens: entry.maxOutputTokens,
        stream: entry.stream,
      })),
      callAccounting: {
        logicalCompletionDispatches: logicalStarts,
        localHttpRequestAttempts: proxyReceipt?.receivedCompletionAttempts ?? null,
        forwardedCompletionAttempts: proxyReceipt?.forwardedCompletionAttempts ?? null,
        proxyIngressAttemptCount: proxyReceipt?.receivedCompletionAttempts ?? null,
        proxyForwardedCompletionAttemptCount: proxyReceipt?.forwardedCompletionAttempts ?? null,
        requestProfileAttemptCount: proxyReceipt?.receivedCompletionAttempts ?? null,
        requestAttemptAccountingMatches: attemptRecordsComplete,
        dispatchAttemptAccountingMatches: proxyReceipt?.dispatchAttemptAccountingMatches === true,
        dispatches: proxyReceipt?.dispatches || [],
        gatewayRelayCount: null,
        providerCompletionCount: null,
        billedRequestCount: null,
        costUsd: null,
        identitySource: 'per-request Bifrost attestation join required; response metadata is untrusted',
      },
    },
    providerAttestation: null,
    qualityScore: null,
    runtime: {
      version: ALIBABA_OPEN_CODE_REVIEW_PIN.version,
      sourceCommit: ALIBABA_OPEN_CODE_REVIEW_PIN.sourceCommit,
      binarySha256,
      modelAlias: requestedModel,
      resourceParity: 'not_matched',
      maxCompletionAttempts: MAX_COMPLETION_ATTEMPTS,
        observedCompletionAttempts: proxyReceipt?.receivedCompletionAttempts ?? null,
        logicalCompletionDispatches: logicalStarts,
      forwardedCompletionAttempts: proxyReceipt?.forwardedCompletionAttempts ?? null,
      wallTimeCapMs: MAX_CASE_WALL_MS,
      actualWallTimeMs: elapsedMs,
      maxOutputTokensPerRequest: MAX_OUTPUT_TOKENS,
      resourceCapRejectionCount: proxyReceipt?.resourceCapRejectionCount ?? null,
      ancestryHydration: cliSource.ancestryHydration,
      projectionMode: cliSource.projectionMode,
      projectionCommitSha: cliSource.projectionCommitSha,
      projectionTreeMatchesAcceptedHead: cliSource.projectionTreeSha === null
        ? true : cliSource.projectionTreeSha === cliSource.pinnedHeadTreeSha,
    },
    outcome: {
      terminalState: manifest?.terminal_state || 'missing',
      cliStatus: typeof output?.status === 'string' ? output.status : 'missing',
      selectedFileCount: coverage.selectedFileCount,
      completedFileCount: coverage.completedFileCount,
      reusedFileCount: coverage.reusedFileCount,
      failedFileCount: coverage.failedFileCount,
      waivedFileCount: coverage.waivedFileCount,
      findings: comments,
    },
  };
}

/** Incomplete receipt that keeps every bounded local attempt when CLI output cannot be trusted. */
export function createAlibabaFailureReceipt({
  caseId,
  modelAlias,
  elapsedMs = null,
  sourceCachePreflight = null,
  proxyReceipt = null,
  failureCode = 'alibaba_result_normalization_failed',
} = {}) {
  const code = /^[a-z0-9_]{1,100}$/u.test(String(failureCode || ''))
    ? String(failureCode) : 'alibaba_result_normalization_failed';
  const requests = Array.isArray(proxyReceipt?.requests) ? proxyReceipt.requests : [];
  const httpAttempts = requests.map((entry) => ({
    localAttemptOrdinal: Number.isSafeInteger(entry?.localAttemptOrdinal) ? entry.localAttemptOrdinal : null,
    logicalDispatchOrdinal: Number.isSafeInteger(entry?.logicalDispatchOrdinal) ? entry.logicalDispatchOrdinal : null,
    logicalMappingStatus: /^[a-z0-9_]{1,80}$/u.test(String(entry?.logicalMappingStatus || ''))
      ? entry.logicalMappingStatus : 'unknown',
    sdkRetryOrdinal: Number.isSafeInteger(entry?.sdkRetryOrdinal) ? entry.sdkRetryOrdinal : null,
    gatewayRequestIdDigests: /^[a-f0-9]{16}$/u.test(String(entry?.gatewayRequestIdDigest || ''))
      ? [entry.gatewayRequestIdDigest] : [],
    httpStatus: Number.isSafeInteger(entry?.httpStatus) ? entry.httpStatus : null,
    status: /^[a-z0-9_]{1,80}$/u.test(String(entry?.outcome || '')) ? entry.outcome : 'unknown',
  }));
  const ingressAttempts = Number.isSafeInteger(proxyReceipt?.receivedCompletionAttempts)
    ? proxyReceipt.receivedCompletionAttempts : httpAttempts.length;
  const forwardedAttempts = Number.isSafeInteger(proxyReceipt?.forwardedCompletionAttempts)
    ? proxyReceipt.forwardedCompletionAttempts : null;
  const logicalDispatches = Number.isSafeInteger(proxyReceipt?.logicalCompletionDispatches)
    ? proxyReceipt.logicalCompletionDispatches : null;
  const dispatches = Array.isArray(proxyReceipt?.dispatches) ? proxyReceipt.dispatches.map((entry) => ({
    logicalDispatchOrdinal: Number.isSafeInteger(entry?.logicalDispatchOrdinal) ? entry.logicalDispatchOrdinal : null,
    localAttemptOrdinals: Array.isArray(entry?.localAttemptOrdinals)
      ? entry.localAttemptOrdinals.filter((ordinal) => Number.isSafeInteger(ordinal) && ordinal > 0) : [],
    localHttpRequestAttempts: Number.isSafeInteger(entry?.localHttpRequestAttempts)
      ? entry.localHttpRequestAttempts : null,
    stage: 'alibaba',
    classification: 'http_attempted',
  })) : [];
  const attemptsAccounted = ingressAttempts === httpAttempts.length
    && proxyReceipt?.invalidRetryHeaderCount === 0 && proxyReceipt?.unknownAttemptCount === 0
    && proxyReceipt?.dispatchAttemptAccountingMatches === true
    && httpAttempts.every((entry) => Number.isSafeInteger(entry.localAttemptOrdinal)
      && Number.isSafeInteger(entry.logicalDispatchOrdinal) && Number.isSafeInteger(entry.sdkRetryOrdinal));
  return {
    armId: 'alibaba-open-code-review',
    caseId,
    status: 'incomplete',
    sourceCachePreflight: sourceCachePreflight || { status: 'not_verified' },
    coverage: { rosterValid: false, quorumSatisfied: null, quorumComparable: false, fullPanelComplete: false },
    metrics: { totalPromptTokens: null, totalCompletionTokens: null, totalTokens: null,
      totalTurns: logicalDispatches, totalDurationMs: Number.isSafeInteger(elapsedMs) ? elapsedMs : null },
    model: {
      transport: 'Bifrost via local WS5 request meter',
      requestedAlias: safeModelId(modelAlias),
      httpAttempts,
      callAccounting: {
        logicalCompletionDispatches: logicalDispatches,
        localHttpRequestAttempts: ingressAttempts,
        forwardedCompletionAttempts: forwardedAttempts,
        proxyIngressAttemptCount: ingressAttempts,
        proxyForwardedCompletionAttemptCount: forwardedAttempts,
        requestProfileAttemptCount: ingressAttempts,
        requestAttemptAccountingMatches: attemptsAccounted,
        dispatchAttemptAccountingMatches: proxyReceipt?.dispatchAttemptAccountingMatches === true,
        dispatches,
        gatewayRelayCount: null,
        providerCompletionCount: null,
        billedRequestCount: null,
        costUsd: null,
      },
    },
    providerAttestation: null,
    qualityScore: null,
    outcome: { terminalState: 'incomplete', failureCode: code, findings: [] },
    noAutomaticRetry: true,
  };
}

/** Convert malformed or unnormalizable CLI output into an incomplete receipt with proxy accounting. */
export function normalizeAlibabaOutputOrFailure(outputBytes, { normalizeOptions = {}, failureOptions = {} } = {}) {
  let output;
  try { output = JSON.parse(Buffer.from(outputBytes).toString('utf8')); }
  catch {
    return createAlibabaFailureReceipt({ ...failureOptions, failureCode: 'alibaba_result_json_invalid' });
  }
  try { return normalizeAlibabaRun(output, normalizeOptions); }
  catch (error) {
    const failureCode = /^[a-z0-9_]{1,100}$/u.test(String(error?.message || ''))
      ? error.message : 'alibaba_result_normalization_failed';
    return createAlibabaFailureReceipt({ ...failureOptions, failureCode });
  }
}

/** Terminal zero-dispatch receipt for a limitation frozen before any model request. */
export function buildAlibabaSourceScopeAbstention(bundle, preflightReceipt, caseId) {
  const arm = bundle?.plan?.publicRunMatrix?.arms?.find((entry) => entry.id === 'alibaba-open-code-review');
  const sourceCase = bundle?.preparedDiscovery?.cases?.find((entry) => entry.caseId === caseId);
  const preflightCase = preflightReceipt?.cases?.find((entry) => entry.caseId === caseId);
  const expected = arm?.nativeSourceLimitations?.[caseId];
  if (!arm || !sourceCase || !preflightCase || !Array.isArray(expected) || expected.length === 0
    || preflightCase.status !== 'source_scope_unsupported'
    || JSON.stringify(preflightCase.preview.unsupportedExclusions) !== JSON.stringify(expected)
    || preflightCase.preview.unreviewedPaths.length !== expected.length) {
    throw new Error('alibaba_source_scope_abstention_not_frozen');
  }
  const patchBytes = sourceCase.changedFiles.reduce((sum, entry) => sum + Buffer.byteLength(entry.patch, 'utf8'), 0);
  return {
    armId: 'alibaba-open-code-review',
    caseId,
    status: 'source_scope_unsupported',
    preflightAbstention: {
      reason: 'unsupported_ext',
      unsupportedPaths: expected.map((entry) => ({ ...entry })),
      noModelDispatch: true,
    },
    source: {
      repository: sourceCase.repository,
      prNumber: sourceCase.prNumber,
      datasetBaseSha: sourceCase.datasetBaseSha,
      diffBaseSha: sourceCase.diffBaseSha,
      mergeBaseSha: sourceCase.mergeBaseSha,
      baseSha: sourceCase.baseSha,
      headSha: sourceCase.headSha,
      changedFiles: sourceCase.changedFiles.length,
      changedPatchChars: patchBytes,
      sourceOmissions: [],
      sourceReadOmissions: [],
      sourceCachePreflight: preflightCase.sourceCachePreflight,
      changedDiffSha256: sha256(sourceCase.changedFiles.map((entry) => entry.patch).join('')),
      nativeReviewableFileCount: preflightCase.preview.reviewableCount,
      nativeUnsupportedPaths: expected.map((entry) => entry.path),
    },
    coverage: {
      rosterValid: true,
      quorumSatisfied: null,
      quorumComparable: false,
      quorumSemantics: 'single-agent-native-file-coverage-manifest-no-persona-quorum',
      fullPanelComplete: false,
      sourceExact: true,
      expectedFileCount: sourceCase.changedFiles.length,
      selectedFileCount: preflightCase.preview.reviewableCount,
      unsupportedFileCount: expected.length,
    },
    metrics: { totalPromptTokens: 0, totalCompletionTokens: 0, totalTokens: 0, totalTurns: 0, totalDurationMs: 0 },
    model: {
      transport: 'Bifrost via local WS5 request meter',
      requestedAlias: arm.modelAlias,
      httpAttempts: [],
      callAccounting: {
        logicalCompletionDispatches: 0,
        localHttpRequestAttempts: 0,
        forwardedCompletionAttempts: 0,
        requestProfileAttemptCount: 0,
        requestAttemptAccountingMatches: true,
        dispatchAttemptAccountingMatches: true,
        dispatches: [],
        gatewayRelayCount: null,
        providerCompletionCount: null,
        billedRequestCount: null,
        costUsd: null,
      },
    },
    providerAttestation: null,
    qualityScore: null,
  };
}

function waitForClose(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve({ code: child.exitCode, signal: child.signalCode });
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

function writeJsonPrivate(filePath, value) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(filePath, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); } finally { fs.closeSync(fd); }
  return sha256(bytes);
}

/** Run exactly one accepted Alibaba case. Requires an explicit root-dispatch token; never retries cases. */
export async function runAlibabaCase({
  bundle,
  caseId,
  binaryPath,
  buildBindingPath,
  buildBindingSha256,
  cacheRoot = DEFAULT_CACHE_ROOT,
  outputDirectory,
  modelAlias,
  bifrostBaseUrl = process.env.WS5_BIFROST_BASE_URL,
  bifrostApiKey,
  rootAuthorization = process.env.WS5_ACCEPTANCE_RUN_AUTHORIZED,
  mode = 'normal',
  maxForwardedAttempts = mode === 'normal' ? MAX_COMPLETION_ATTEMPTS : 1,
  maxWallMs = mode === 'normal' ? MAX_CASE_WALL_MS : MAX_TEST_CONTROL_WALL_MS,
  signal = null,
} = {}) {
  if (rootAuthorization !== '1') throw new Error('root_public_model_run_authorization_required');
  if (!bundle || !bundle.plan || !bundle.preparedDiscovery) throw new Error('ws5_panel_bundle_missing');
  const buildArtifactBinding = verifyPrivateAlibabaBuildBinding({
    bundle, binaryPath, buildBindingPath, buildBindingSha256,
  });
  const gatewayCredential = mode === 'provider_failure'
    ? 'ws5-invalid-qualification-inference-credential'
    : bifrostApiKey ?? process.env.WS5_BIFROST_API_KEY;
  if (!safeModelId(modelAlias) || typeof gatewayCredential !== 'string' || gatewayCredential.length < 1
    || typeof bifrostBaseUrl !== 'string') throw new Error('alibaba_private_gateway_inputs_missing');
  if (maxWallMs > MAX_CASE_WALL_MS || maxWallMs < 1000) throw new Error('alibaba_wall_time_cap_invalid');
  if (mode !== 'normal' && maxWallMs > MAX_TEST_CONTROL_WALL_MS) throw new Error('alibaba_test_control_wall_cap_invalid');
  if (mode !== 'normal' && maxForwardedAttempts > 1) throw new Error('alibaba_test_control_request_cap_invalid');
  if (maxForwardedAttempts > MAX_COMPLETION_ATTEMPTS) throw new Error('alibaba_completion_cap_invalid');
  if (mode === 'provider_failure' && maxForwardedAttempts !== 1) throw new Error('provider_failure_control_must_be_bounded');
  if (signal?.aborted) throw new Error('ws5_cell_cancelled');

  const arm = bundle.plan.publicRunMatrix.arms.find((entry) => entry.id === 'alibaba-open-code-review');
  const sourceCase = bundle.preparedDiscovery.cases.find((entry) => entry.caseId === caseId);
  if (!arm?.caseIds.includes(caseId) || !sourceCase || arm.modelAlias !== modelAlias) {
    throw new Error('alibaba_case_or_model_alias_not_in_frozen_panel');
  }
  const binary = assertPinnedAlibabaBinary(binaryPath);
  const repoPath = sourceCachePath(cacheRoot, sourceCase.repository);
  const sourceCachePreflight = preflightPinnedGitSnapshot(sourceCase, repoPath);
  if (sourceCachePreflight.status !== 'verified' || sourceCase.sourceOmissions?.length !== 0) {
    throw new Error('alibaba_run_source_preflight_failed');
  }
  let cliSource = null;
  let proxy = null;
  let outputRoot = null;
  let child = null;
  let killTimer = null;
  let wallTimer = null;
  let timedOut = false;
  let sourceScope = null;
  const abortChild = () => {
    timedOut = true;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      if (!killTimer) killTimer = setTimeout(() => child.kill('SIGKILL'), 1500);
    }
  };
  try {
    cliSource = createCliSourceRepository(sourceCase, cacheRoot, os.tmpdir());
    if (signal?.aborted) throw new Error('ws5_cell_cancelled');
    sourceScope = prepareAlibabaSourceScope(binary.path, sourceCase, cliSource, os.tmpdir());
    if (signal?.aborted) throw new Error('ws5_cell_cancelled');
    const expectedChangedPaths = sourceScope.expectedPaths;
    const localBroker = createAlibabaLocalBroker({
      upstreamBaseUrl: bifrostBaseUrl,
      apiKey: gatewayCredential,
      modelAlias,
      maxForwardedAttempts,
      maxInboundAttempts: mode === 'normal' ? MAX_INBOUND_ATTEMPTS : 6,
      mode,
    });
    proxy = localBroker.proxy;
    outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ws5-alibaba-run-'));
    const localUrl = await proxy.listen();
    const isolatedHome = path.join(outputRoot, 'home');
    fs.mkdirSync(isolatedHome, { recursive: true, mode: 0o700 });
    const rawOutputPath = path.join(outputRoot, 'raw-ocr-result.json');
    const env = createAlibabaChildEnvironment({
      home: isolatedHome, modelAlias, localUrl, localToken: localBroker.localToken,
    });
    const args = [
      '--color', 'never', 'review', '--repo', cliSource.repoPath,
      '--from', cliSource.cliFromSha, '--to', cliSource.cliToSha,
      '--format', 'json', '--audience', 'agent', '--output', rawOutputPath,
      '--model', modelAlias, '--effort', 'medium', '--concurrency', '3', '--timeout', '15',
    ];
    if (sourceScope.rulePath) args.push('--rule', sourceScope.rulePath);
    if (signal?.aborted) throw new Error('ws5_cell_cancelled');
    signal?.addEventListener('abort', abortChild, { once: true });
    const startedAt = Date.now();
    child = spawn(binary.path, args, { cwd: cliSource.repoPath, env, stdio: ['ignore', 'ignore', 'ignore'] });
    wallTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1500);
    }, maxWallMs);
    const exit = await waitForClose(child);
    if (signal?.aborted) timedOut = true;
    const elapsedMs = Date.now() - startedAt;
    const proxyReceipt = proxy.snapshot();
    const normalized = fs.existsSync(rawOutputPath)
      ? normalizeAlibabaOutputOrFailure(fs.readFileSync(rawOutputPath), {
        normalizeOptions: {
          caseId, sourceCase, elapsedMs, binarySha256: binary.sha256, modelAlias, proxyReceipt,
          expectedChangedPaths, sourceCachePreflight, cliSource, sourceScope,
        },
        failureOptions: { caseId, modelAlias, elapsedMs, sourceCachePreflight, proxyReceipt },
      })
      : createAlibabaFailureReceipt({
        caseId, modelAlias, elapsedMs, sourceCachePreflight, proxyReceipt,
        failureCode: 'alibaba_result_json_missing',
      });
    normalized.process = {
      exitCode: exit?.code ?? null,
      signal: exit?.signal || null,
      timedOut,
      stdoutCaptured: false,
      stderrCaptured: false,
      noAutomaticRetry: true,
    };
    if (timedOut) {
      normalized.status = 'incomplete';
      normalized.outcome = { ...(normalized.outcome || {}), terminalState: 'capped_or_cancelled',
        failureCode: signal?.aborted ? 'ws5_cell_cancelled' : 'ws5_cell_wall_time_cap_exceeded' };
      normalized.qualityScore = null;
    }
    normalized.proxy = proxyReceipt;
    normalized.buildArtifactBinding = {
      schemaVersion: WS5_ALIBABA_BUILD_ARTIFACT_PIN.schemaVersion,
      status: buildArtifactBinding.status,
      bindingSha256: buildArtifactBinding.bindingSha256,
      selectedBinarySha256: buildArtifactBinding.binarySha256,
      supersededDeclaredBinarySha256: buildArtifactBinding.supersededBinarySha256,
    };
    normalized.responseReportedModelIsUntrusted = true;
    const targetOutputPath = path.resolve(outputDirectory || os.tmpdir(), `ws5-alibaba-${caseId}-${Date.now()}.json`);
    normalized.outputSha256 = writeJsonPrivate(targetOutputPath, normalized);
    return { receiptPath: targetOutputPath, receipt: normalized };
  } finally {
    signal?.removeEventListener('abort', abortChild);
    if (wallTimer) clearTimeout(wallTimer);
    if (killTimer) clearTimeout(killTimer);
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await waitForClose(child);
    }
    if (proxy) await proxy.close();
    if (outputRoot) fs.rmSync(outputRoot, { recursive: true, force: true });
    if (cliSource) fs.rmSync(cliSource.tempDirectory, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) throw new Error('invalid_argument');
    if (key === '--preflight') { result.preflight = true; continue; }
    if (key === '--run-one') { result.runOne = true; continue; }
    const value = argv[index + 1];
    if (typeof value !== 'string' || value.startsWith('--')) throw new Error('missing_argument_value');
    result[key.slice(2)] = value;
    index += 1;
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const binaryPath = args.binary || process.env.WS5_ALIBABA_BINARY;
    if (!binaryPath) throw new Error('alibaba_binary_path_required');
    const root = args.root || ROOT;
    const privateBundle = {
      repoRoot: root,
      dataRoot: args['data-root'],
      planPath: args.plan,
      externalDataContractPath: args.contract,
      externalDataContractSha256: args['contract-sha256'],
      buildBindingPath: args['build-binding'],
      buildBindingSha256: args['build-binding-sha256'],
    };
    if (args.preflight) {
      const receipt = preflightAlibabaPanel({ ...privateBundle,
        binaryPath, cacheRoot: args['cache-root'] || DEFAULT_CACHE_ROOT });
      process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
      process.exitCode = receipt.status === 'ABSTAIN' ? 2 : 0;
    } else if (args.runOne) {
      if (!args['case-id'] || !args.out) throw new Error('run_one_requires_case_and_output');
      const bundle = loadPinnedAcceptancePlan(privateBundle);
      runAlibabaCase({
        bundle,
        caseId: args['case-id'],
        binaryPath,
        buildBindingPath: args['build-binding'],
        buildBindingSha256: args['build-binding-sha256'],
        cacheRoot: args['cache-root'] || DEFAULT_CACHE_ROOT,
        outputDirectory: path.dirname(path.resolve(args.out)),
        modelAlias: process.env.WS5_MODEL_ALIAS,
        mode: args.mode || 'normal',
        maxForwardedAttempts: Number(args['max-forwarded-attempts'] || MAX_COMPLETION_ATTEMPTS),
        maxWallMs: Number(args['max-wall-ms'] || MAX_CASE_WALL_MS),
      }).then(({ receiptPath, receipt }) => {
        if (path.resolve(args.out) !== receiptPath) fs.copyFileSync(receiptPath, args.out);
        process.stdout.write(JSON.stringify({ status: receipt.status, caseId: receipt.caseId, receiptPath: args.out }) + '\n');
        process.exitCode = receipt.status === 'completed' ? 0 : 2;
      }).catch((error) => {
        const code = String(error?.message || 'alibaba_run_failed');
        process.stderr.write('WS5 Alibaba run stopped: ' + (/^[a-z0-9_-]{1,100}$/iu.test(code) ? code : 'run_failed') + '\n');
        process.exitCode = 2;
      });
    } else {
      throw new Error('choose_preflight_or_run_one');
    }
  } catch (error) {
    const code = String(error?.message || 'alibaba_adapter_failed');
    process.stderr.write('WS5 Alibaba adapter failed closed: '
      + (/^[a-z0-9_-]{1,100}$/iu.test(code) ? code : 'adapter_failed') + '\n');
    process.exitCode = 2;
  }
}
