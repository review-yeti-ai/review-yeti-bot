#!/usr/bin/env node

/**
 * Binds AACR's immutable source/head pins to the exact PR comparison that supplied
 * changed regions. GitHub Compare uses merge_base_commit; this prevents a two-dot
 * base-to-head diff from including unrelated commits after the PR branch diverged.
 *
 * The verifier is read-only. It reads the prepared public source bundle and uses the
 * authenticated GitHub CLI only for bounded GET requests. It never checks out or
 * executes a target repository.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  AACR_BENCHMARK,
  assertCanonicalHeldoutManifestBytes,
  preflightPinnedGitSnapshot,
} from './competitive-review-benchmark.mjs';

const MAX_CASES = 7;
const MAX_COMPARE_FILES = 600;
const MAX_GH_RESPONSE_BYTES = 12 * 1024 * 1024;
const GH_TIMEOUT_MS = 20_000;
const HASH_RE = /^[a-f0-9]{40}$/iu;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseDiffPatch(patch) {
  const additions = [];
  const deletions = [];
  let oldLine = null;
  let newLine = null;
  for (const line of String(patch || '').replace(/\r\n/gu, '\n').split('\n')) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      continue;
    }
    if (oldLine === null || newLine === null || line.startsWith('\\')) continue;
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) {
      additions.push({ line: newLine, text: line.slice(1) });
      newLine += 1;
      continue;
    }
    if (line.startsWith('-')) {
      deletions.push({ line: oldLine, text: line.slice(1) });
      oldLine += 1;
      continue;
    }
    if (line.startsWith(' ')) {
      oldLine += 1;
      newLine += 1;
    }
  }
  return { additions, deletions };
}

function patchSummary(file, pathKey) {
  const changes = parseDiffPatch(file.patch);
  return {
    path: pathKey,
    additions: changes.additions,
    deletions: changes.deletions,
  };
}

function sortedPathDigest(paths) {
  return sha256(JSON.stringify([...paths].sort()));
}

function changeSetDigest(rows) {
  return sha256(JSON.stringify([...rows].sort((a, b) => a.path.localeCompare(b.path))));
}

/** Verify changed paths, line coordinates, and changed text from the exact merge-base comparison. */
export function verifyPinnedComparison({ manifestCase, compare, preparedCase } = {}) {
  const datasetBaseSha = String(manifestCase?.datasetBaseSha || '');
  const diffBaseSha = String(manifestCase?.diffBaseSha || manifestCase?.baseSha || '');
  const headSha = String(manifestCase?.headSha || '');
  const mergeBaseSha = String(compare?.mergeBaseSha || compare?.merge_base_commit?.sha || '');
  if (![datasetBaseSha, diffBaseSha, headSha, mergeBaseSha].every((sha) => HASH_RE.test(sha))) {
    throw new Error('pinned_comparison_identity_invalid');
  }
  if (mergeBaseSha !== diffBaseSha || manifestCase?.baseSha !== diffBaseSha
    || manifestCase?.mergeBaseSha !== diffBaseSha) {
    throw new Error('github_compare_merge_base_mismatch');
  }
  const githubFiles = Array.isArray(compare.files) ? compare.files : [];
  const localFiles = Array.isArray(preparedCase?.changedFiles) ? preparedCase.changedFiles : [];
  const sourceOmissions = Array.isArray(preparedCase?.sourceOmissions) ? preparedCase.sourceOmissions : [];
  if (sourceOmissions.length > 0 || localFiles.length === 0 || githubFiles.length === 0) {
    return {
      status: 'incomplete',
      reason: sourceOmissions[0] || 'source_or_compare_files_missing',
      datasetBaseSha,
      diffBaseSha,
      headSha,
      mergeBaseSha,
      sourceOmissions,
    };
  }
  if (localFiles.length > MAX_COMPARE_FILES || githubFiles.length > MAX_COMPARE_FILES) {
    throw new Error('pinned_comparison_file_budget_exceeded');
  }

  const localPaths = localFiles.map((file) => String(file.path || ''));
  const githubPaths = githubFiles.map((file) => String(file.filename || ''));
  const sortedLocalPaths = [...localPaths].sort();
  const sortedGithubPaths = [...githubPaths].sort();
  const pathSetsMatch = localPaths.length === githubPaths.length
    && new Set(localPaths).size === localPaths.length
    && new Set(githubPaths).size === githubPaths.length
    && sortedLocalPaths.every((entry, index) => entry === sortedGithubPaths[index]);

  const localChanges = localFiles.map((file) => patchSummary(file, String(file.path || '')));
  const githubChanges = githubFiles.map((file) => {
    if (typeof file.patch !== 'string' && ((Number(file.additions) || 0) > 0 || (Number(file.deletions) || 0) > 0)) {
      return null;
    }
    return patchSummary({ patch: file.patch }, String(file.filename || ''));
  });
  const unavailablePatchTextFiles = githubFiles.filter((file) => typeof file.patch !== 'string'
    && ((Number(file.additions) || 0) > 0 || (Number(file.deletions) || 0) > 0)).map((file) => file.filename);
  const localChangeCount = localChanges.reduce((sum, file) => sum + file.additions.length + file.deletions.length, 0);
  const githubChangedLineCount = githubFiles.reduce((sum, file) => sum
    + Math.max(0, Number(file.additions) || 0) + Math.max(0, Number(file.deletions) || 0), 0);
  const changedLinesMatch = unavailablePatchTextFiles.length === 0
    && localChangeCount === githubChangedLineCount
    && changeSetDigest(localChanges) === changeSetDigest(githubChanges);

  return {
    status: pathSetsMatch && changedLinesMatch ? 'verified' : 'mismatch',
    datasetBaseSha,
    diffBaseSha,
    headSha,
    mergeBaseSha,
    mergeBaseMatchesDiffBase: mergeBaseSha === diffBaseSha,
    compareStatus: typeof compare.status === 'string' ? compare.status : 'unknown',
    aheadBy: Number.isSafeInteger(compare.ahead_by) ? compare.ahead_by : null,
    behindBy: Number.isSafeInteger(compare.behind_by) ? compare.behind_by : null,
    changedFileCount: localFiles.length,
    githubCompareFileCount: githubFiles.length,
    pathSetsMatch,
    githubChangedPathsSha256: sortedPathDigest(githubPaths),
    localChangedPathsSha256: sortedPathDigest(localPaths),
    githubChangedLineCount,
    localChangedLineCount: localChangeCount,
    changedLinesMatch,
    githubChangedLinesSha256: changeSetDigest(githubChanges.filter(Boolean)),
    localChangedLinesSha256: changeSetDigest(localChanges),
    unavailablePatchTextFiles,
    sourceOmissions,
  };
}

function runGhJson(endpoint) {
  const bytes = execFileSync('gh', ['api', endpoint], {
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: GH_TIMEOUT_MS,
    maxBuffer: MAX_GH_RESPONSE_BYTES,
    env: { ...process.env, GH_PAGER: 'cat', PAGER: 'cat' },
  });
  if (bytes.byteLength > MAX_GH_RESPONSE_BYTES) throw new Error('github_compare_response_budget_exceeded');
  return JSON.parse(bytes.toString('utf8'));
}

function repoCacheDirectory(repository, cacheRoot) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) throw new Error('invalid_public_repository');
  return path.resolve(cacheRoot, repository.replace(/[^A-Za-z0-9._-]+/gu, '__'));
}

/** Build a sanitized pre-run source profile. Each request is a bounded exact-pin GET. */
export function buildSourceProfile({ manifest, preparedInput, cacheRoot, observedPullRequests = {} } = {}) {
  if (!manifest || manifest.datasetSha256 !== AACR_BENCHMARK.sha256 || !Array.isArray(manifest.cases)) {
    throw new Error('source_profile_manifest_not_pinned');
  }
  if (!preparedInput || preparedInput.datasetSha256 !== AACR_BENCHMARK.sha256
    || !Array.isArray(preparedInput.cases) || typeof preparedInput.heldoutManifestSha256 !== 'string') {
    throw new Error('source_profile_prepared_input_not_pinned');
  }
  if (manifest.cases.length !== MAX_CASES || preparedInput.cases.length !== MAX_CASES) {
    throw new Error('source_profile_case_count_mismatch');
  }
  const byId = new Map(preparedInput.cases.map((entry) => [entry.caseId, entry]));
  const cases = manifest.cases.map((manifestCase) => {
    const preparedCase = byId.get(manifestCase.id);
    if (!preparedCase || preparedCase.baseSha !== manifestCase.diffBaseSha
      || preparedCase.headSha !== manifestCase.headSha
      || preparedCase.datasetBaseSha !== manifestCase.datasetBaseSha
      || preparedCase.diffBaseSha !== manifestCase.diffBaseSha) {
      throw new Error('source_profile_prepared_case_identity_mismatch');
    }
    const compare = runGhJson('repos/' + manifestCase.repository + '/compare/'
      + manifestCase.datasetBaseSha + '...' + manifestCase.headSha);
    const evidence = verifyPinnedComparison({
      manifestCase,
      compare: { ...compare, mergeBaseSha: compare.merge_base_commit?.sha },
      preparedCase,
    });
    if (evidence.status !== 'verified') throw new Error('github_compare_source_evidence_mismatch');
    const localSourceCache = preparedCase.sourceAdapter === 'pinned_git_objects'
      ? preflightPinnedGitSnapshot({
        repository: manifestCase.repository,
        baseSha: manifestCase.diffBaseSha,
        headSha: manifestCase.headSha,
        changedFiles: preparedCase.changedFiles,
      }, repoCacheDirectory(manifestCase.repository, cacheRoot))
      : null;
    if (localSourceCache?.status && localSourceCache.status !== 'verified') {
      throw new Error('local_source_cache_preflight_failed');
    }
    const observed = observedPullRequests[manifestCase.id]
      || runGhJson('repos/' + manifestCase.repository + '/pulls/' + manifestCase.prNumber);
    const observedBaseSha = observed?.baseSha || observed?.base?.sha || null;
    const observedHeadSha = observed?.headSha || observed?.head?.sha || null;
    return {
      caseId: manifestCase.id,
      repository: manifestCase.repository,
      prNumber: manifestCase.prNumber,
      language: manifestCase.language,
      datasetBaseSha: manifestCase.datasetBaseSha,
      diffBaseSha: manifestCase.diffBaseSha,
      mergeBaseSha: evidence.mergeBaseSha,
      headSha: manifestCase.headSha,
      currentPrBaseSha: observedBaseSha,
      currentPrHeadSha: observedHeadSha,
      currentPrState: observed?.state || null,
      currentPrChangedFileCount: Number.isSafeInteger(observed?.changedFiles)
        ? observed.changedFiles : Number.isSafeInteger(observed?.changed_files) ? observed.changed_files : null,
      currentPrBaseMatchesDatasetBase: observedBaseSha === manifestCase.datasetBaseSha,
      currentPrHeadMatchesDatasetPin: observedHeadSha === manifestCase.headSha,
      sourceAdapter: preparedCase.sourceAdapter || 'unknown',
      changedFileCount: evidence.changedFileCount,
      patchLines: preparedCase.changedFiles.reduce((sum, file) => sum + String(file.patch || '').split(/\r?\n/u).length, 0),
      patchBytes: preparedCase.changedFiles.reduce((sum, file) => sum + Buffer.byteLength(String(file.patch || ''), 'utf8'), 0),
      patchSetSha256: localSourceCache?.patchSetSha256 || evidence.localChangedLinesSha256,
      preparedCaseSha256: sha256(JSON.stringify(preparedCase)),
      preparedCaseSourceOmissions: preparedCase.sourceOmissions || [],
      compare: evidence,
      sourceCachePreflight: localSourceCache || {
        status: 'prepared_input_only',
        immutableSourceRechecked: false,
      },
    };
  });
  if (new Set(cases.map((entry) => entry.caseId)).size !== cases.length) {
    throw new Error('source_profile_contains_duplicate_case_id');
  }
  return {
    schemaVersion: 'WS5SourceProfile.v1',
    benchmark: 'AACR-Bench',
    datasetRevision: '47be1d6df1e7faf222cf531587772d92f79fe6b2',
    datasetSha256: AACR_BENCHMARK.sha256,
    heldoutManifestSha256: preparedInput.heldoutManifestSha256,
    preparedInputSha256: preparedInput.preparedInputSha256 || null,
    capturedAt: new Date().toISOString(),
    comparisonAuthority: 'GitHub Compare exact AACR dataset base/head pins; runtime diff base is the returned merge-base commit',
    comparisonIdentity: 'datasetBaseSha and headSha remain immutable AACR identity; diffBaseSha separately records GitHub merge-base',
    caseCount: cases.length,
    cases,
  };
}

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

export async function main(argv = process.argv) {
  if (argv[2] !== 'verify') {
    process.stderr.write('usage: ws5-source-provenance.mjs verify --manifest <path> --cases <path> --cache <path> --out <path>\n');
    return 2;
  }
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const manifestPath = path.resolve(arg('--manifest', path.join(repoRoot,
    'eval-baselines/competitive-review-benchmark/aacr-ws5-heldout-v1.json')));
  const manifestBytes = fs.readFileSync(manifestPath);
  const { manifest, sha256: manifestSha256 } = assertCanonicalHeldoutManifestBytes(manifestBytes);
  const preparedPath = path.resolve(arg('--cases', path.join(os.tmpdir(), 'review-yeti-ws5-discovery-input.json')));
  const preparedBytes = fs.readFileSync(preparedPath);
  const preparedInputSha256 = sha256(preparedBytes);
  const preparedInput = JSON.parse(preparedBytes.toString('utf8'));
  if (preparedInput.heldoutManifestSha256 !== manifestSha256) throw new Error('prepared_input_manifest_digest_mismatch');
  preparedInput.preparedInputSha256 = preparedInputSha256;
  const cacheRoot = path.resolve(arg('--cache', path.join(os.tmpdir(), 'review-yeti-ws5-public-repos')));
  const profile = buildSourceProfile({ manifest, preparedInput, cacheRoot });
  const outputPath = path.resolve(arg('--out', path.join(repoRoot,
    'eval-baselines/competitive-review-benchmark/aacr-ws5-source-profile-v1.json')));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(profile, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write(JSON.stringify({ status: 'verified', cases: profile.cases.length,
    completeSources: profile.cases.filter((entry) => entry.preparedCaseSourceOmissions.length === 0).length,
    profileSha256: sha256(fs.readFileSync(outputPath)) }) + '\n');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(process.argv); }
  catch (error) {
    const code = String(error?.message || error);
    const safeCode = /^[A-Za-z0-9_-]{1,120}$/u.test(code) ? code : 'source_provenance_error';
    process.stderr.write('source provenance failed closed: ' + safeCode + '\n');
    process.exitCode = 2;
  }
}
