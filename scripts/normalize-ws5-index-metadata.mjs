#!/usr/bin/env node

/** Freeze Git full-index metadata without changing any source/hunk/context bytes. */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = 'eval-baselines/competitive-review-benchmark/aacr-ws5-heldout-v1.json';
const INPUT_ROOT = 'eval-baselines/competitive-review-benchmark/ws5-acceptance-inputs';
const PROFILE_V1 = 'eval-baselines/competitive-review-benchmark/aacr-ws5-source-profile-v1.json';
const SAFE_ENV_FILTER = /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|GATEWAY|ENDPOINT|BASE_URL|AUTH_TOKEN|AUTHORIZATION)/iu;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(filePath) {
  return sha256(fs.readFileSync(filePath));
}

function safeGitEnv() {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !SAFE_ENV_FILTER.test(name))),
    GIT_NO_LAZY_FETCH: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
}

function git(repoPath, args) {
  return execFileSync('git', args, {
    cwd: repoPath,
    encoding: 'utf8',
    env: safeGitEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function canonicalizeIndexLine(patch) {
  return String(patch).replace(/^index [a-f0-9]+\.\.[a-f0-9]+(?: \d+)?$/gimu, (line) => {
    const match = /^index ([a-f0-9]+)\.\.([a-f0-9]+)(?: (\d+))?$/iu.exec(line);
    return match ? `index <blob-id>..<blob-id>${match[3] ? ' ' + match[3] : ''}` : line;
  });
}

function expectedCasePin(caseRecord, manifestCase) {
  const repository = caseRecord.repository || caseRecord.sourceIdentity?.repository;
  const datasetBaseSha = caseRecord.datasetBaseSha || caseRecord.sourceIdentity?.datasetBaseSha;
  const diffBaseSha = caseRecord.diffBaseSha || caseRecord.sourceIdentity?.diffBaseSha || caseRecord.baseSha
    || caseRecord.sourceIdentity?.baseSha;
  const headSha = caseRecord.headSha || caseRecord.sourceIdentity?.headSha;
  if (repository !== manifestCase.repository || datasetBaseSha !== manifestCase.datasetBaseSha
    || diffBaseSha !== manifestCase.diffBaseSha || headSha !== manifestCase.headSha) {
    throw new Error('case_pins_disagree_with_frozen_manifest');
  }
  return { repository, datasetBaseSha, diffBaseSha, headSha };
}

function normalizeCases(input, manifestCases, sourceCacheRoot) {
  const manifestById = new Map(manifestCases.map((entry) => [entry.id, entry]));
  const caseReceipts = [];
  for (const inputCase of input.cases) {
    const caseId = inputCase.caseId;
    const manifestCase = manifestById.get(caseId)
      || manifestCases.find((entry) => entry.repository === inputCase.sourceIdentity?.repository
        && entry.diffBaseSha === (inputCase.diffBaseSha || inputCase.sourceIdentity?.diffBaseSha || inputCase.sourceIdentity?.baseSha)
        && entry.headSha === (inputCase.headSha || inputCase.sourceIdentity?.headSha));
    if (!manifestCase) throw new Error('input_case_not_in_frozen_manifest');
    const pin = expectedCasePin(inputCase, manifestCase);
    if (!Array.isArray(inputCase.changedFiles) || inputCase.changedFiles.length === 0) throw new Error('input_changed_files_missing');
    const repoPath = path.resolve(sourceCacheRoot, pin.repository.replace(/[^A-Za-z0-9._-]+/gu, '__'));
    const rootDiffBaseSha = git(repoPath, ['rev-parse', '--verify', `${pin.diffBaseSha}^{commit}`]).trim();
    const rootHeadSha = git(repoPath, ['rev-parse', '--verify', `${pin.headSha}^{commit}`]).trim();
    if (rootDiffBaseSha !== pin.diffBaseSha || rootHeadSha !== pin.headSha) throw new Error('exact_source_commit_missing');
    const treeBySha = {
      [pin.diffBaseSha]: git(repoPath, ['rev-parse', `${pin.diffBaseSha}^{tree}`]).trim(),
      [pin.headSha]: git(repoPath, ['rev-parse', `${pin.headSha}^{tree}`]).trim(),
    };
    const changedPaths = git(repoPath, ['diff', '--name-only', '-z', pin.diffBaseSha, pin.headSha])
      .split('\0').filter(Boolean).sort();
    const inputPaths = inputCase.changedFiles.map((entry) => entry.path).sort();
    if (JSON.stringify(changedPaths) !== JSON.stringify(inputPaths)) throw new Error('exact_changed_paths_mismatch');

    const fileReceipts = [];
    for (const file of inputCase.changedFiles) {
      const fullPatch = git(repoPath, ['-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--full-index',
        '--unified=5', pin.diffBaseSha, pin.headSha, '--', file.path]);
      const oldCanonical = canonicalizeIndexLine(file.patch);
      const newCanonical = canonicalizeIndexLine(fullPatch);
      if (oldCanonical !== newCanonical) throw new Error('source_hunk_or_context_bytes_changed');
      const indexLine = /^index ([a-f0-9]{40})\.\.([a-f0-9]{40})(?: (\d+))?$/imu.exec(
        fullPatch.split('\n').find((line) => line.startsWith('index ')) || '',
      );
      if (!indexLine) throw new Error('full_index_blob_identity_missing');
      file.patch = fullPatch;
      fileReceipts.push({
        path: file.path,
        oldPatchSha256: sha256(oldCanonical),
        normalizedPatchSha256: sha256(newCanonical),
        acceptedPatchSha256: sha256(fullPatch),
        patchByteLength: Buffer.byteLength(fullPatch),
        baseBlobSha: indexLine[1],
        headBlobSha: indexLine[2],
        fileMode: indexLine[3] || null,
        pathAndHunkTextContextExact: true,
      });
    }
    const patchRows = fileReceipts.map((entry) => [entry.path, entry.acceptedPatchSha256])
      .sort(([left], [right]) => left.localeCompare(right));
    caseReceipts.push({
      caseId,
      repository: pin.repository,
      prNumber: manifestCase.prNumber,
      datasetBaseSha: pin.datasetBaseSha,
      diffBaseSha: pin.diffBaseSha,
      headSha: pin.headSha,
      baseTreeSha: treeBySha[pin.diffBaseSha],
      headTreeSha: treeBySha[pin.headSha],
      changedPathCount: changedPaths.length,
      patchSetSha256: sha256(JSON.stringify(patchRows)),
      changedPathsSha256: sha256(JSON.stringify(changedPaths)),
      allPathAndHunkTextContextExact: fileReceipts.every((entry) => entry.pathAndHunkTextContextExact),
      indexMetadataChangedPaths: fileReceipts.filter((entry) => entry.oldPatchSha256 !== entry.acceptedPatchSha256)
        .map((entry) => entry.path),
      files: fileReceipts,
    });
  }
  if (input.cases.length !== (input.schemaVersion === 'review-yeti-discovery-cases-v1' ? 7 : 28)) {
    throw new Error('unexpected_input_case_count');
  }
  return { input, caseReceipts };
}

function writeArtifact(relativePath, value) {
  const filePath = path.resolve(ROOT, relativePath);
  if (fs.existsSync(filePath)) throw new Error('normalization_output_already_exists');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  fs.writeFileSync(filePath, bytes, { mode: 0o644, flag: 'wx' });
  return sha256(bytes);
}

export function normalizeWs5IndexMetadata({ sourceCacheRoot } = {}) {
  if (!sourceCacheRoot) throw new Error('source_cache_root_required');
  const manifest = JSON.parse(fs.readFileSync(path.resolve(ROOT, MANIFEST), 'utf8'));
  const discoveryPathV1 = path.join(INPUT_ROOT, 'discovery-v1.json');
  const verificationPathV1 = path.join(INPUT_ROOT, 'verification-v1.json');
  const discoveryBytesV1 = fs.readFileSync(path.resolve(ROOT, discoveryPathV1));
  const verificationBytesV1 = fs.readFileSync(path.resolve(ROOT, verificationPathV1));
  const discovery = JSON.parse(discoveryBytesV1.toString('utf8'));
  const verification = JSON.parse(verificationBytesV1.toString('utf8'));
  const discoveryNormalized = normalizeCases(discovery, manifest.cases, sourceCacheRoot);
  const verificationNormalized = normalizeCases(verification, manifest.cases, sourceCacheRoot);
  const discoveryPath = path.join(INPUT_ROOT, 'discovery-v2-full-index.json');
  const verificationPath = path.join(INPUT_ROOT, 'verification-v2-full-index.json');
  const discoverySha = writeArtifact(discoveryPath, discoveryNormalized.input);
  const verificationSha = writeArtifact(verificationPath, verificationNormalized.input);
  const report = {
    schemaVersion: 'WS5GitFullIndexNormalization.v1',
    reason: 'Git index blob-ID abbreviation width varied with isolated object-database contents; canonical full blob IDs make exact source identity stable across adapters.',
    normalizationRule: 'Git --full-index; only index old..new blob-ID metadata changes; all changed paths and all remaining patch bytes are exact',
    sourceRevision: manifest.sourceRevision,
    manifestSha256: sha256(fs.readFileSync(path.resolve(ROOT, MANIFEST))),
    originalInputs: {
      discovery: { path: discoveryPathV1, sha256: sha256(discoveryBytesV1) },
      verification: { path: verificationPathV1, sha256: sha256(verificationBytesV1) },
    },
    normalizedInputs: {
      discovery: { path: discoveryPath, sha256: discoverySha },
      verification: { path: verificationPath, sha256: verificationSha },
    },
    discoveryCases: discoveryNormalized.caseReceipts,
    verificationCases: verificationNormalized.caseReceipts,
    exactSourceTreeContentMutated: false,
    sourceOrHunkTextMutated: false,
    oracleLabelsReadOrChanged: false,
  };
  const reportPath = 'eval-baselines/competitive-review-benchmark/aacr-ws5-index-normalization-v1.json';
  const reportSha = writeArtifact(reportPath, report);

  const sourceProfile = JSON.parse(fs.readFileSync(path.resolve(ROOT, PROFILE_V1), 'utf8'));
  sourceProfile.schemaVersion = 'WS5SourceProfile.v2';
  sourceProfile.preparedInputSha256 = discoverySha;
  sourceProfile.preparedInputPath = discoveryPath;
  sourceProfile.indexNormalization = { path: reportPath, sha256: reportSha, mode: 'full_index_blob_ids' };
  const discoveryById = new Map(discoveryNormalized.input.cases.map((entry) => [entry.caseId, entry]));
  for (const profileCase of sourceProfile.cases) {
    const inputCase = discoveryById.get(profileCase.caseId);
    const reportCase = discoveryNormalized.caseReceipts.find((entry) => entry.caseId === profileCase.caseId);
    if (!inputCase || !reportCase) throw new Error('source_profile_case_not_in_normalized_input');
    profileCase.preparedCaseSha256 = sha256(Buffer.from(JSON.stringify(inputCase)));
    profileCase.patchSetSha256 = reportCase.patchSetSha256;
    profileCase.patchBytes = inputCase.changedFiles.reduce((sum, entry) => sum + Buffer.byteLength(entry.patch), 0);
    if (profileCase.sourceCachePreflight) {
      profileCase.sourceCachePreflight.patchSetSha256 = reportCase.patchSetSha256;
    }
  }
  const sourceProfilePath = 'eval-baselines/competitive-review-benchmark/aacr-ws5-source-profile-v2.json';
  const sourceProfileSha = writeArtifact(sourceProfilePath, sourceProfile);
  return {
    reportPath,
    reportSha,
    discoveryPath,
    discoverySha,
    verificationPath,
    verificationSha,
    sourceProfilePath,
    sourceProfileSha,
    changedCaseCount: discoveryNormalized.caseReceipts.length,
    verificationCaseCount: verificationNormalized.caseReceipts.length,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const index = process.argv.indexOf('--source-cache');
    if (index < 0 || !process.argv[index + 1]) throw new Error('source_cache_root_required');
    const receipt = normalizeWs5IndexMetadata({ sourceCacheRoot: path.resolve(process.argv[index + 1]) });
    process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
  } catch (error) {
    const code = String(error?.message || 'ws5_index_normalization_failed');
    process.stderr.write('WS5 index normalization failed closed: '
      + (/^[a-z0-9_-]{1,100}$/iu.test(code) ? code : 'normalization_failed') + '\n');
    process.exitCode = 2;
  }
}
