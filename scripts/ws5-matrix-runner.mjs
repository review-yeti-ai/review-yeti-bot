#!/usr/bin/env node

/** Parent-owned, serial and fail-closed runner for the frozen WS5 public matrix. */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  AACR_BENCHMARK,
  V1_BASELINE_RUNTIME_SHA,
  preflightPinnedGitSnapshot,
  runtimeGitIdentity,
} from './competitive-review-benchmark.mjs';
import {
  createPublicRunCellPlan,
  joinGatewayRequestAttestation,
  loadPinnedAcceptancePlan,
  normalizeDiscoveryRunEnvelope,
  runPublicRunCells,
} from './ws5-acceptance.mjs';
import {
  buildAlibabaSourceScopeAbstention,
  createBifrostMeterProxy,
  preflightAlibabaPanel,
  runAlibabaCase,
} from './ws5-alibaba.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHA256_RE = /^[a-f0-9]{64}$/u;
const GIT_SHA_RE = /^[a-f0-9]{40}$/u;
const IMAGE_DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;
const MODEL_ALIAS = 'pr-reviewer';
const CASE_LIMIT = 100;
const CELL_WALL_MS = 1_200_000;
const PREFLIGHT_WALL_MS = 1_200_000;
const FINALIZATION_WALL_MS = 300_000;
const MODEL_CELLS = 27;
const MAX_PANEL_WALL_MS = PREFLIGHT_WALL_MS + MODEL_CELLS * CELL_WALL_MS + FINALIZATION_WALL_MS;
const MAX_PREFLIGHT_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_TRANSPORT_PREFLIGHT_WALL_MS = 60_000;
const MAX_TRANSPORT_PREFLIGHT_STDOUT_BYTES = 128 * 1024;
const POSIX_PATH = '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin';

export const WS5_MATRIX_BOUNDS = Object.freeze({
  expectedCells: 28,
  modelRunCells: MODEL_CELLS,
  preflightAbstentionCells: 1,
  maxConcurrentCells: 1,
  automaticRetries: 0,
  maxForwardedModelRequestsPerCell: CASE_LIMIT,
  maxCellWallMs: CELL_WALL_MS,
  maxPreflightWallMs: PREFLIGHT_WALL_MS,
  maxFinalizationWallMs: FINALIZATION_WALL_MS,
  maxPanelWallMs: MAX_PANEL_WALL_MS,
});

export const WS5_PRIMARY_MODEL_CONFIG_PROFILE = Object.freeze({
  requestedModel: MODEL_ALIAS,
  compat: 'openrouter',
  stream: true,
  maxTokens: 24_576,
  timeoutMs: 240_000,
  reasoningEffort: null,
});

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function safeCode(error, fallback = 'cell_dispatch_failed') {
  const value = String(error?.message || '');
  return /^[a-z0-9_]{1,100}$/u.test(value) ? value : fallback;
}

function runGit(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 10_000,
    env: {
      PATH: POSIX_PATH,
      HOME: os.tmpdir(),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_NO_LAZY_FETCH: '1',
      GIT_LFS_SKIP_SMUDGE: '1',
    },
  }).trim();
}

export function readRuntimeIdentity(runtimeRoot) {
  const root = fs.realpathSync(path.resolve(runtimeRoot));
  const identity = runtimeGitIdentity(root);
  if (!GIT_SHA_RE.test(String(identity.commit || '')) || !GIT_SHA_RE.test(String(identity.tree || ''))
    || !identity.hostExecution || identity.hostExecution.executionMode !== 'host_node'
    || identity.hostExecution.workerImageExecution !== 'provenance_reference_only_not_executed_by_ws5_host_runner') {
    throw new Error('ws5_host_execution_identity_missing');
  }
  return identity;
}

/** Check the actual arm identity; a caller-supplied "finalized" flag is never consulted. */
export function assertRuntimeIdentity({
  armId,
  expectedRuntimeSha,
  actualRuntimeSha,
  worktreeClean,
  revisedRuntimeSha,
} = {}) {
  if (!GIT_SHA_RE.test(String(expectedRuntimeSha || ''))
    || !GIT_SHA_RE.test(String(actualRuntimeSha || ''))
    || worktreeClean !== true) {
    if (worktreeClean !== true) throw new Error('ws5_runtime_worktree_dirty');
    throw new Error('ws5_runtime_identity_invalid');
  }
  if (armId === 'yeti-v1-native-baseline') {
    if (expectedRuntimeSha !== V1_BASELINE_RUNTIME_SHA) throw new Error('ws5_baseline_runtime_pin_mismatch');
  } else if (armId === 'yeti-revised-medium') {
    if (expectedRuntimeSha === V1_BASELINE_RUNTIME_SHA) throw new Error('ws5_revised_runtime_pin_is_stale');
  } else if (armId === 'yeti-revised-medium-repeat') {
    if (!GIT_SHA_RE.test(String(revisedRuntimeSha || '')) || revisedRuntimeSha === V1_BASELINE_RUNTIME_SHA
      || expectedRuntimeSha !== revisedRuntimeSha) throw new Error('ws5_repeat_runtime_pin_mismatch');
  } else {
    throw new Error('ws5_runtime_arm_invalid');
  }
  if (actualRuntimeSha !== expectedRuntimeSha) throw new Error('ws5_runtime_actual_pin_mismatch');
  return true;
}

/** Bind each planned arm to the same runtime root, commit, and host fingerprint recorded in preflight. */
export function selectYetiRuntimeForCell(cell, pins, identities) {
  let runtimeRoot;
  let expectedRuntimeSha;
  let identity;
  if (cell?.armId === 'yeti-v1-native-baseline') {
    runtimeRoot = pins?.baselineRuntimeRoot;
    expectedRuntimeSha = cell.runtimeSha;
    identity = identities?.baseline;
  } else if (cell?.armId === 'yeti-revised-medium') {
    runtimeRoot = pins?.revisedRuntimeRoot;
    expectedRuntimeSha = pins?.revisedRuntimeSha;
    identity = identities?.revised;
  } else if (cell?.armId === 'yeti-revised-medium-repeat') {
    runtimeRoot = pins?.repeatRuntimeRoot || pins?.revisedRuntimeRoot;
    expectedRuntimeSha = pins?.repeatRuntimeSha;
    identity = identities?.repeat;
  } else {
    throw new Error('ws5_runtime_arm_invalid');
  }
  if (typeof runtimeRoot !== 'string' || !path.isAbsolute(runtimeRoot)
    || !GIT_SHA_RE.test(String(expectedRuntimeSha || '')) || identity?.commit !== expectedRuntimeSha
    || identity?.worktreeClean !== true || !identity?.hostExecution) {
    throw new Error('ws5_runtime_identity_invalid');
  }
  return {
    runtimeRoot: path.resolve(runtimeRoot),
    expectedRuntimeSha,
    expectedRuntimeTreeOid: identity.tree,
    hostExecution: identity.hostExecution,
  };
}

/** Verify pinned public-source bytes against both a freeze receipt and its committed Git blobs. */
export function verifyPublicSourceFreeze(repoRoot, freezePath, expectedFreezeSha256) {
  const root = fs.realpathSync(path.resolve(repoRoot));
  const bytes = fs.readFileSync(path.resolve(freezePath));
  const freezeSha256 = sha256(bytes);
  if (!SHA256_RE.test(String(expectedFreezeSha256 || '')) || freezeSha256 !== expectedFreezeSha256) {
    throw new Error('ws5_source_freeze_digest_mismatch');
  }
  let freeze;
  try { freeze = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('ws5_source_freeze_invalid_json'); }
  if (freeze.schemaVersion !== 'ReviewYetiPublicSourceFreeze.v2'
    || !Array.isArray(freeze.publicAllowlist) || !GIT_SHA_RE.test(freeze.localGitCommitSnapshot?.headCommitSha || '')) {
    throw new Error('ws5_source_freeze_schema_invalid');
  }
  const head = freeze.localGitCommitSnapshot.headCommitSha;
  if (runGit(['rev-parse', 'HEAD'], root) !== head) throw new Error('ws5_source_freeze_head_mismatch');
  const actualTreeOid = runGit(['rev-parse', 'HEAD^{tree}'], root);
  if (actualTreeOid !== freeze.localGitCommitSnapshot.gitTreeOid) throw new Error('ws5_source_freeze_tree_mismatch');
  const requiredFiles = [
    'scripts/competitive-review-benchmark.mjs',
    'scripts/ws5-acceptance.mjs',
    'scripts/ws5-alibaba.mjs',
    'scripts/ws5-matrix-runner.mjs',
    'scripts/ws5-verification-runner.mjs',
    'tests/unit/competitiveReviewBenchmark.test.ts',
    'tests/unit/ws5Acceptance.test.ts',
    'tests/unit/ws5MatrixRunner.test.ts',
    'tests/unit/ws5VerificationRunner.test.ts',
  ];
  const entries = new Map();
  for (const entry of freeze.publicAllowlist) {
    const relative = entry?.path;
    if (typeof relative !== 'string' || path.isAbsolute(relative)
      || relative.split('/').some((part) => part === '' || part === '.' || part === '..')
      || !SHA256_RE.test(entry.sha256 || '') || entries.has(relative)) {
      throw new Error('ws5_source_freeze_entry_invalid');
    }
    const filePath = path.join(root, relative);
    const info = fs.lstatSync(filePath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('ws5_source_freeze_file_not_regular');
    const realFilePath = fs.realpathSync(filePath);
    const realRelative = path.relative(root, realFilePath);
    if (!realRelative || realRelative === '..' || realRelative.startsWith('..' + path.sep)) {
      throw new Error('ws5_source_freeze_file_escape');
    }
    const fileBytes = fs.readFileSync(filePath);
    if (sha256(fileBytes) !== entry.sha256) throw new Error('ws5_source_freeze_file_digest_mismatch');
    const committedBytes = execFileSync('git', ['show', `${head}:${relative}`], {
      cwd: root, encoding: 'buffer', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000,
      env: { PATH: POSIX_PATH, HOME: os.tmpdir(), GIT_NO_LAZY_FETCH: '1', GIT_CONFIG_NOSYSTEM: '1' },
    });
    if (sha256(committedBytes) !== entry.sha256) throw new Error('ws5_source_freeze_blob_mismatch');
    entries.set(relative, entry.sha256);
  }
  if (requiredFiles.some((file) => !entries.has(file))) throw new Error('ws5_source_freeze_allowlist_incomplete');
  const descriptor = freeze.publicAllowlist.map(({ path: relative, sha256: digest }) => ({ path: relative, sha256: digest }));
  if (freeze.allowlistDigest !== sha256(JSON.stringify(descriptor))) throw new Error('ws5_source_freeze_allowlist_digest_mismatch');
  return {
    pathSha256: freezeSha256,
    headCommitSha: head,
    gitTreeOid: actualTreeOid,
    sourceTreeSha256: freeze.sourceTreeSha256,
    allowlistDigest: freeze.allowlistDigest,
    allowlistedFileCount: entries.size,
  };
}

/** Read the accepted image receipt and verify immutable image, source, and platform pins. */
export function verifyImagePinReceipt(receiptPath, {
  expectedReceiptSha256,
  expectedSourceCommit,
  expectedImageDigest,
  requiredPlatform,
} = {}) {
  const bytes = fs.readFileSync(path.resolve(receiptPath));
  if (!SHA256_RE.test(String(expectedReceiptSha256 || '')) || sha256(bytes) !== expectedReceiptSha256) {
    throw new Error('ws5_image_provenance_digest_mismatch');
  }
  let receipt;
  try { receipt = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('ws5_image_provenance_schema_invalid'); }
  if (receipt?.schemaVersion !== 'ReviewYetiWS5ImageProvenance.v1'
    || !GIT_SHA_RE.test(receipt.source?.commitSha || '')
    || !IMAGE_DIGEST_RE.test(receipt.subject?.digest || '')
    || typeof receipt.build?.runId !== 'string' || !/^\d{5,}$/u.test(receipt.build.runId)
    || !SHA256_RE.test(receipt.build?.provenanceSha256 || '')
    || !Array.isArray(receipt.platformManifests)) throw new Error('ws5_image_provenance_schema_invalid');
  if (receipt.source.commitSha !== expectedSourceCommit || receipt.subject.digest !== expectedImageDigest) {
    throw new Error('ws5_image_provenance_pin_mismatch');
  }
  const platform = receipt.platformManifests.find((entry) => entry.platform === requiredPlatform);
  if (!platform || !IMAGE_DIGEST_RE.test(platform.digest || '')) throw new Error('ws5_image_platform_pin_missing');
  return {
    receiptSha256: expectedReceiptSha256,
    sourceCommit: receipt.source.commitSha,
    imageDigest: receipt.subject.digest,
    buildRunId: receipt.build.runId,
    provenanceSha256: receipt.build.provenanceSha256,
    platform: requiredPlatform,
    platformDigest: platform.digest,
  };
}

function signalGroup(child, signal) {
  if (!child || !Number.isSafeInteger(child.pid)) return false;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
    return true;
  } catch {
    try { child.kill(signal); return true; } catch { return false; }
  }
}

/** Run a child without a shell; deadlines and parent cancellation kill its whole process group. */
export async function runBoundedChildProcess({
  command,
  args = [],
  cwd,
  env,
  maxWallMs,
  killGraceMs = 1_500,
  captureStdoutMaxBytes = 0,
  signal,
} = {}) {
  if (typeof command !== 'string' || !path.isAbsolute(command) || !Array.isArray(args)
    || args.some((entry) => typeof entry !== 'string') || typeof cwd !== 'string'
    || !Number.isSafeInteger(maxWallMs) || maxWallMs < 1
    || !Number.isSafeInteger(killGraceMs) || killGraceMs < 1
    || !Number.isSafeInteger(captureStdoutMaxBytes) || captureStdoutMaxBytes < 0
    || !env || typeof env !== 'object') throw new Error('ws5_child_execution_profile_invalid');
  if (signal?.aborted) return { terminal: 'aborted', exitCode: null, signal: null,
    terminationRequested: false, reaped: true, durationMs: 0 };
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let child;
    let terminal = 'exited';
    let terminationRequested = false;
    let reaped = false;
    let stdoutBytes = 0;
    let stdoutChunks = [];
    let stdoutOverflow = false;
    let deadlineTimer;
    let killTimer;
    let reapTimer;
    const finish = (exitCode, exitSignal, failureClass = null) => {
      if (reaped) return;
      reaped = true;
      clearTimeout(deadlineTimer);
      clearTimeout(killTimer);
      clearTimeout(reapTimer);
      signal?.removeEventListener('abort', abortHandler);
      resolve({ terminal, exitCode, signal: exitSignal || null, terminationRequested,
        reaped: true, durationMs: Date.now() - startedAt, failureClass,
        ...(captureStdoutMaxBytes > 0 ? { stdout: Buffer.concat(stdoutChunks).toString('utf8'), stdoutOverflow } : {}) });
    };
    const requestTermination = (reason) => {
      if (terminationRequested || reaped) return;
      terminal = reason;
      terminationRequested = true;
      signalGroup(child, 'SIGTERM');
      killTimer = setTimeout(() => {
        signalGroup(child, 'SIGKILL');
        reapTimer = setTimeout(() => {
          if (!reaped) {
            reaped = true;
            signal?.removeEventListener('abort', abortHandler);
      resolve({ terminal, exitCode: null, signal: 'SIGKILL', terminationRequested: true,
              reaped: false, durationMs: Date.now() - startedAt, failureClass: 'process_group_not_reaped',
              ...(captureStdoutMaxBytes > 0 ? { stdout: Buffer.concat(stdoutChunks).toString('utf8'), stdoutOverflow } : {}) });
          }
        }, Math.max(killGraceMs, 250));
      }, killGraceMs);
    };
    const abortHandler = () => requestTermination('aborted');
    try {
      child = spawn(command, args, {
        cwd,
        env,
        stdio: ['ignore', captureStdoutMaxBytes > 0 ? 'pipe' : 'ignore', 'ignore'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch {
      terminal = 'spawn_error';
      finish(null, null, 'spawn_error');
      return;
    }
    child.once('error', () => {
      terminal = 'spawn_error';
      finish(null, null, 'spawn_error');
    });
    if (captureStdoutMaxBytes > 0) child.stdout?.on('data', (chunk) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > captureStdoutMaxBytes) {
        stdoutOverflow = true;
        requestTermination('output_capped');
        return;
      }
      stdoutChunks.push(Buffer.from(chunk));
    });
    child.once('close', (code, exitSignal) => finish(Number.isSafeInteger(code) ? code : null, exitSignal));
    deadlineTimer = setTimeout(() => requestTermination('timed_out'), maxWallMs);
    signal?.addEventListener('abort', abortHandler, { once: true });
    if (signal?.aborted) abortHandler();
  });
}

export function createSanitizedPreflightEnvironment({ home, temporaryDirectory } = {}) {
  if (![home, temporaryDirectory].every((value) => typeof value === 'string' && path.isAbsolute(value))) {
    throw new Error('ws5_preflight_child_environment_invalid');
  }
  const homePath = path.resolve(home);
  return {
    PATH: POSIX_PATH,
    LANG: 'C',
    HOME: homePath,
    TMPDIR: path.resolve(temporaryDirectory),
    XDG_CONFIG_HOME: path.join(homePath, '.config'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_LFS_SKIP_SMUDGE: '1',
  };
}

/** Generate an ephemeral loopback server certificate; keep its key only in the parent process. */
export function createEphemeralLoopbackTls(parentDirectory) {
  if (typeof parentDirectory !== 'string' || !path.isAbsolute(parentDirectory)
    || !fs.statSync(parentDirectory).isDirectory()) throw new Error('ws5_loopback_tls_directory_invalid');
  const scratch = fs.mkdtempSync(path.join(parentDirectory, '.ws5-loopback-tls-'));
  const privateKeyPath = path.join(scratch, 'loopback-key.pem');
  const publicCaPath = path.join(scratch, 'loopback-ca.pem');
  const opensslPath = POSIX_PATH.split(path.delimiter).map((directory) => path.join(directory, 'openssl'))
    .find((candidate) => {
      try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; }
    });
  if (!opensslPath) {
    fs.rmSync(scratch, { recursive: true, force: true });
    throw new Error('ws5_loopback_tls_openssl_unavailable');
  }
  const environment = { PATH: POSIX_PATH, HOME: scratch, TMPDIR: scratch, LANG: 'C' };
  let privateKey;
  let certificate;
  try {
    execFileSync(opensslPath, [
      'req', '-x509', '-newkey', 'rsa:2048', '-keyout', privateKeyPath, '-out', publicCaPath,
      '-days', '1', '-nodes', '-subj', '/CN=ReviewYeti WS5 loopback',
      '-addext', 'subjectAltName=IP:127.0.0.1',
      '-addext', 'basicConstraints=critical,CA:TRUE',
      '-addext', 'keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign',
      '-addext', 'extendedKeyUsage=serverAuth',
    ], { cwd: scratch, env: environment, encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], timeout: 30_000, maxBuffer: 64 * 1024 });
    fs.chmodSync(privateKeyPath, 0o600);
    fs.chmodSync(publicCaPath, 0o600);
    privateKey = fs.readFileSync(privateKeyPath);
    certificate = fs.readFileSync(publicCaPath);
    fs.rmSync(privateKeyPath, { force: true });
    const opensslVersion = execFileSync(opensslPath, ['version'], {
      cwd: scratch, env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000, maxBuffer: 4_096,
    }).trim();
    let cleaned = false;
    return {
      key: privateKey,
      cert: certificate,
      publicCaPath,
      certificateSha256: sha256(certificate),
      opensslVersion: String(opensslVersion).replace(/[^A-Za-z0-9.()+_ -]/gu, '').slice(0, 120),
      opensslExecutableSha256: sha256(fs.readFileSync(opensslPath)),
      cleanup() {
        if (cleaned) return;
        cleaned = true;
        privateKey?.fill(0);
        certificate?.fill(0);
        fs.rmSync(scratch, { recursive: true, force: true });
      },
    };
  } catch {
    privateKey?.fill(0);
    certificate?.fill(0);
    fs.rmSync(scratch, { recursive: true, force: true });
    throw new Error('ws5_loopback_tls_certificate_generation_failed');
  }
}

export async function awaitParentOperation(operation, timeoutMs, parentSignal, timeoutCode) {
  if (typeof operation !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error(timeoutCode);
  }
  const controller = new AbortController();
  let timer;
  let abortHandler;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error(timeoutCode)); }, timeoutMs);
  });
  const cancelled = new Promise((_, reject) => {
    abortHandler = () => { controller.abort(); reject(new Error('ws5_parent_cancelled')); };
    if (parentSignal?.aborted) abortHandler();
    else parentSignal?.addEventListener('abort', abortHandler, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), timeout, cancelled]);
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', abortHandler);
    controller.abort();
  }
}

export function createSanitizedYetiChildEnvironment({
  home, temporaryDirectory, localBaseUrl, localToken, localCaCertificatePath,
} = {}) {
  let endpoint;
  try { endpoint = new URL(localBaseUrl); } catch { throw new Error('ws5_yeti_child_environment_invalid'); }
  let caPath;
  try { caPath = fs.realpathSync(path.resolve(localCaCertificatePath)); }
  catch { throw new Error('ws5_yeti_child_environment_invalid'); }
  const caInfo = fs.lstatSync(caPath);
  const caBytes = fs.readFileSync(caPath);
  const caText = caBytes.toString('ascii');
  const caRelative = path.relative(ROOT, caPath);
  if (![home, temporaryDirectory].every((value) => typeof value === 'string' && path.isAbsolute(value))
    || endpoint.protocol !== 'https:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || endpoint.pathname.replace(/\/+$/u, '') !== '/v1'
    || typeof localToken !== 'string' || localToken.length < 32
    || caInfo.isSymbolicLink() || !caInfo.isFile() || caRelative === '' || (!caRelative.startsWith('..' + path.sep) && caRelative !== '..')
    || !caText.includes('-----BEGIN CERTIFICATE-----') || !caText.includes('-----END CERTIFICATE-----')
    || caText.includes('PRIVATE KEY')) {
    throw new Error('ws5_yeti_child_environment_invalid');
  }
  const homePath = path.resolve(home);
  const tmpPath = path.resolve(temporaryDirectory);
  return {
    PATH: POSIX_PATH,
    LANG: 'C',
    HOME: homePath,
    TMPDIR: tmpPath,
    XDG_CONFIG_HOME: path.join(homePath, '.config'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_LFS_SKIP_SMUDGE: '1',
    NODE_EXTRA_CA_CERTS: caPath,
    OPENROUTER_BASE_URL: localBaseUrl,
    OPENROUTER_API_KEY: localToken,
    OPENROUTER_MODEL: MODEL_ALIAS,
    REVIEW_TRANSPORT_DESTINATION: 'gateway',
    REVIEW_YETI_GATEWAY_BASE_URL: localBaseUrl,
    REVIEW_YETI_BIFROST_API_KEY: localToken,
    REVIEW_MODEL: MODEL_ALIAS,
    WS5_LOOPBACK_BROKER: '1',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  };
}

function transportResourceFingerprint(profile) {
  return JSON.stringify({
    transportName: profile?.transportName,
    requestedModel: profile?.requestedModel,
    modelConfigDefaults: profile?.modelConfigDefaults,
    productionPublishingTransport: profile?.productionPublishingTransport,
  });
}

export function assertMatchedPrimaryTransportProfiles(profiles) {
  if (!Array.isArray(profiles) || profiles.length < 2 || profiles.some((entry) =>
    entry?.status !== 'ready_without_model_call' || entry.modelCalls !== 0 || entry.requestedModel !== MODEL_ALIAS
      || entry.modelConfigDefaults?.source !== 'pipeline.resolveModelConfig'
      || entry.modelConfigDefaults?.requestedModel !== MODEL_ALIAS
      || !SHA256_RE.test(String(entry.localTlsBoundary?.certificateSha256 || ''))
      || !SHA256_RE.test(String(entry.localTlsBoundary?.opensslExecutableSha256 || ''))
      || entry.localTlsBoundary?.childTrust !== 'NODE_EXTRA_CA_CERTS_public_certificate_only'
      || entry.localTlsBoundary?.privateKeySentToChild !== false
      || entry.loopbackOnly !== true || entry.inactiveProviderCredentialCount !== 0)) {
    throw new Error('ws5_transport_preflight_not_ready');
  }
  if (profiles.some((entry) => entry.productionPublishingTransport?.resolver !== 'runtime.publishing.openaiTransport'
    || entry.productionPublishingTransport?.protocol !== 'https:'
    || entry.productionPublishingTransport?.endpointHost !== '127.0.0.1'
    || entry.productionPublishingTransport?.requestedModel !== MODEL_ALIAS
    || entry.productionPublishingTransport?.resourceLimits !== 'not_exposed_by_publishing_transport_resolver')
    || profiles.some((entry) => JSON.stringify(entry.productionPublishingTransport)
      !== JSON.stringify(profiles[0].productionPublishingTransport))) {
    throw new Error('ws5_production_publishing_transport_mismatch');
  }
  const expected = transportResourceFingerprint(profiles[0]);
  if (profiles.some((entry) => transportResourceFingerprint(entry) !== expected))
    throw new Error('ws5_primary_transport_resource_profile_mismatch');
  if (profiles.some((entry) => entry.modelConfigDefaults?.compat !== WS5_PRIMARY_MODEL_CONFIG_PROFILE.compat
    || entry.modelConfigDefaults?.stream !== WS5_PRIMARY_MODEL_CONFIG_PROFILE.stream
    || entry.modelConfigDefaults?.maxTokens !== WS5_PRIMARY_MODEL_CONFIG_PROFILE.maxTokens
    || entry.modelConfigDefaults?.timeoutMs !== WS5_PRIMARY_MODEL_CONFIG_PROFILE.timeoutMs
    || entry.modelConfigDefaults?.reasoningEffort !== WS5_PRIMARY_MODEL_CONFIG_PROFILE.reasoningEffort)) {
    throw new Error('ws5_primary_transport_resource_profile_mismatch');
  }
  return true;
}

/** Resolve the pinned runtime's default gateway route in a sanitized no-call child. */
export async function runPinnedTransportPreflight({
  repoRoot = ROOT,
  runtimeRoot,
  expectedRuntimeSha,
  expectedRuntimeTreeOid,
  expectedHostExecution,
  deadline,
  signal,
} = {}) {
  if (typeof runtimeRoot !== 'string' || !path.isAbsolute(runtimeRoot)
    || !GIT_SHA_RE.test(String(expectedRuntimeSha || ''))
    || !GIT_SHA_RE.test(String(expectedRuntimeTreeOid || ''))
    || !expectedHostExecution || !Number.isSafeInteger(deadline)) {
    throw new Error('ws5_transport_preflight_binding_invalid');
  }
  const root = fs.realpathSync(path.resolve(repoRoot));
  const runtime = assertExternalExistingPath(root, runtimeRoot, 'directory', 'ws5_transport_preflight_runtime_path_invalid');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ws5-transport-preflight-'));
  const home = path.join(scratch, 'home');
  const temporaryDirectory = path.join(scratch, 'tmp');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(temporaryDirectory, { recursive: true, mode: 0o700 });
  const localToken = crypto.randomBytes(32).toString('hex');
  let tlsMaterial = null;
  try {
    tlsMaterial = createEphemeralLoopbackTls(scratch);
    const localBaseUrl = 'https://127.0.0.1:1/v1';
    const child = await runBoundedChildProcess({
      command: process.execPath,
      args: [path.join(root, 'scripts/competitive-review-benchmark.mjs'), 'preflight-transport',
        '--runtime-root', runtime, '--expected-model', MODEL_ALIAS],
      cwd: root,
      env: createSanitizedYetiChildEnvironment({ home, temporaryDirectory, localBaseUrl, localToken,
        localCaCertificatePath: tlsMaterial.publicCaPath }),
      maxWallMs: Math.max(1, Math.min(MAX_TRANSPORT_PREFLIGHT_WALL_MS, deadline - Date.now())),
      captureStdoutMaxBytes: MAX_TRANSPORT_PREFLIGHT_STDOUT_BYTES,
      signal,
    });
    if (child.terminal !== 'exited' || child.exitCode !== 0 || child.reaped !== true || child.stdoutOverflow) {
      throw new Error(child.terminal === 'timed_out' ? 'ws5_transport_preflight_timeout'
        : child.terminal === 'aborted' ? 'ws5_parent_cancelled'
          : child.stdoutOverflow ? 'ws5_transport_preflight_receipt_too_large' : 'ws5_transport_preflight_child_failed');
    }
    let receipt;
    try { receipt = JSON.parse(child.stdout); } catch { throw new Error('ws5_transport_preflight_receipt_invalid'); }
    if (receipt?.status !== 'ready_without_model_call' || receipt.modelCalls !== 0
      || receipt.requestedModel !== MODEL_ALIAS || receipt.loopbackOnly !== true
      || receipt.modelConfigDefaults?.source !== 'pipeline.resolveModelConfig'
      || receipt.modelConfigDefaults?.requestedModel !== MODEL_ALIAS
      || receipt.productionPublishingTransport?.protocol !== 'https:'
      || receipt.productionPublishingTransport?.endpointHost !== '127.0.0.1'
      || receipt.productionPublishingTransport?.requestedModel !== MODEL_ALIAS
      || receipt.productionPublishingTransport?.resourceLimits !== 'not_exposed_by_publishing_transport_resolver'
      || receipt.inactiveProviderCredentialCount !== 0
      || receipt.runtime?.commit !== expectedRuntimeSha || receipt.runtime?.tree !== expectedRuntimeTreeOid
      || receipt.runtime?.worktreeClean !== true
      || JSON.stringify(receipt.runtime?.hostExecution) !== JSON.stringify(expectedHostExecution)) {
      throw new Error('ws5_transport_preflight_runtime_binding_mismatch');
    }
    return {
      status: receipt.status,
      modelCalls: 0,
      transportName: receipt.transportName,
      requestedModel: receipt.requestedModel,
      modelConfigDefaults: receipt.modelConfigDefaults,
      productionPublishingTransport: receipt.productionPublishingTransport,
      loopbackOnly: true,
      inactiveProviderCredentialCount: 0,
      localTlsBoundary: {
        certificateSha256: tlsMaterial.certificateSha256,
        opensslVersion: tlsMaterial.opensslVersion,
        opensslExecutableSha256: tlsMaterial.opensslExecutableSha256,
        childTrust: 'NODE_EXTRA_CA_CERTS_public_certificate_only',
        privateKeySentToChild: false,
      },
      runtime: {
        commit: receipt.runtime.commit,
        tree: receipt.runtime.tree,
        hostExecution: receipt.runtime.hostExecution,
      },
    };
  } finally {
    tlsMaterial?.cleanup();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function cacheRepositoryPath(cacheRoot, repository) {
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error('ws5_public_repository_invalid');
  }
  return path.resolve(cacheRoot, repository.replace(/[^A-Za-z0-9._-]+/gu, '__'));
}

function performPublicNoCallPreflight({ root, cacheRoot, binaryPath }) {
  const bundle = loadPinnedAcceptancePlan(root);
  const sourceCases = bundle.preparedDiscovery.cases.map((sourceCase) => {
    const repoPath = cacheRepositoryPath(cacheRoot, sourceCase.repository);
    const proof = preflightPinnedGitSnapshot(sourceCase, repoPath);
    if (proof.status !== 'verified' || proof.changedFileCount !== sourceCase.changedFiles.length
      || sourceCase.sourceOmissions?.length !== 0) throw new Error('ws5_source_cache_preflight_failed');
    return { caseId: sourceCase.caseId, status: 'verified', sourceOmissions: [],
      changedFileCount: proof.changedFileCount, patchSetSha256: proof.patchSetSha256 };
  });
  const alibaba = preflightAlibabaPanel({ binaryPath, cacheRoot, root });
  return { sourceCases, alibaba };
}

function parsePreflightArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!['--root', '--cache-root', '--binary'].includes(key)) throw new Error('ws5_preflight_argument_invalid');
    const value = argv[index + 1];
    if (typeof value !== 'string' || value.startsWith('--')) throw new Error('ws5_preflight_argument_missing');
    values[key] = value;
    index += 1;
  }
  if (!values['--root'] || !values['--cache-root'] || !values['--binary']) {
    throw new Error('ws5_preflight_argument_missing');
  }
  return { root: values['--root'], cacheRoot: values['--cache-root'], binaryPath: values['--binary'] };
}

function modelCellFailureReceipt(bundle, cell, sourcePreflight, failureCode, durationMs, proxySnapshot = null, providerAttestation = null) {
  const input = bundle.preparedDiscovery.cases.find((entry) => entry.caseId === cell.caseId);
  const profile = bundle.sourceProfile.cases.find((entry) => entry.caseId === cell.caseId);
  const attempts = proxySnapshot?.requests?.map((entry) => ({
    localAttemptOrdinal: entry.localAttemptOrdinal,
    logicalDispatchOrdinal: entry.logicalDispatchOrdinal,
    gatewayRequestIdDigests: entry.gatewayRequestIdDigest ? [entry.gatewayRequestIdDigest] : [],
    status: entry.outcome,
    httpStatus: entry.httpStatus,
  })) || [];
  return {
    ordinal: cell.ordinal,
    armId: cell.armId,
    caseId: cell.caseId,
    status: 'incomplete',
    source: {
      repository: input.repository,
      prNumber: input.prNumber,
      datasetBaseSha: input.datasetBaseSha,
      diffBaseSha: input.diffBaseSha,
      mergeBaseSha: input.mergeBaseSha,
      baseSha: input.baseSha,
      headSha: input.headSha,
      changedFiles: profile.changedFileCount,
      sourceOmissions: [],
      sourceReadOmissions: [],
      sourceCachePreflight: sourcePreflight || { status: 'not_verified' },
    },
    coverage: { rosterValid: false, quorumSatisfied: false, fullPanelComplete: false },
    metrics: { totalTokens: null, totalDurationMs: durationMs },
    model: {
      requestedAlias: MODEL_ALIAS,
      responseReportedIdentity: 'untrusted_hints_only',
      httpAttempts: attempts,
      callAccounting: {
        logicalCompletionDispatches: null,
        localHttpRequestAttempts: attempts.length,
        proxyIngressAttemptCount: Number.isSafeInteger(proxySnapshot?.receivedCompletionAttempts)
          ? proxySnapshot.receivedCompletionAttempts : null,
        proxyForwardedCompletionAttemptCount: Number.isSafeInteger(proxySnapshot?.forwardedCompletionAttempts)
          ? proxySnapshot.forwardedCompletionAttempts : null,
        requestProfileAttemptCount: null,
        requestAttemptAccountingMatches: false,
        dispatchAttemptAccountingMatches: false,
        dispatches: proxySnapshot?.dispatches || [],
        gatewayRelayCount: null,
        providerCompletionCount: null,
        billedRequestCount: null,
        costUsd: null,
      },
    },
    providerAttestation,
    outcome: { terminalState: 'capped_or_cancelled', failureCode },
    noAutomaticRetry: true,
    qualityScore: null,
  };
}

function safeBrokerEvidence(value) {
  if (!value || typeof value !== 'object') return value;
  return {
    status: value.status,
    source: value.source,
    evidenceDigest: value.evidenceDigest,
    requests: Array.isArray(value.requests) ? value.requests.map((entry) => ({
      localAttemptOrdinal: entry.localAttemptOrdinal,
      requestIdDigest: entry.requestIdDigest,
      disposition: entry.disposition,
      ...(entry.provider ? { provider: entry.provider } : {}),
      ...(entry.servedModel ? { servedModel: entry.servedModel } : {}),
      ...(entry.servedEffort !== undefined ? { servedEffort: entry.servedEffort } : {}),
      ...(entry.reasonCode ? { reasonCode: entry.reasonCode } : {}),
      evidenceDigest: entry.evidenceDigest,
    })) : null,
  };
}

export function assertLocalProxyAgainstRuntime(proxySnapshot, runtimeAttempts) {
  const proxyRequests = proxySnapshot?.requests;
  if (!Array.isArray(runtimeAttempts) || !Array.isArray(proxyRequests)
    || proxyRequests.length !== runtimeAttempts.length) {
    throw new Error('ws5_local_runtime_attempt_count_mismatch');
  }
  const proxyByOrdinal = new Map();
  const runtimeByOrdinal = new Map();
  for (const [rows, target] of [[proxyRequests, proxyByOrdinal], [runtimeAttempts, runtimeByOrdinal]]) {
    for (const entry of rows) {
      const ordinal = entry?.localAttemptOrdinal;
      if (!Number.isSafeInteger(ordinal) || ordinal < 1 || target.has(ordinal)) {
        throw new Error('ws5_local_runtime_attempt_identity_mismatch');
      }
      target.set(ordinal, entry);
    }
    // Local attempt ordinals are assigned before concurrent requests complete. Require the
    // exact gap-free set, but never infer ordering from the arrays' completion/arrival order.
    if (target.size !== rows.length || [...target.keys()].some((ordinal) => ordinal > rows.length)) {
      throw new Error('ws5_local_runtime_attempt_identity_mismatch');
    }
  }
  for (let ordinal = 1; ordinal <= runtimeAttempts.length; ordinal += 1) {
    const observed = runtimeByOrdinal.get(ordinal);
    const received = proxyByOrdinal.get(ordinal);
    if (!observed || !received) throw new Error('ws5_local_runtime_attempt_identity_mismatch');
    const digests = [...new Set(Array.isArray(observed.gatewayRequestIdDigests) ? observed.gatewayRequestIdDigests : [])];
    const receivedDigest = received.gatewayRequestIdDigest ? [received.gatewayRequestIdDigest] : [];
    if (!Number.isSafeInteger(observed.logicalDispatchOrdinal) || observed.logicalDispatchOrdinal < 1
      || !Number.isSafeInteger(received.logicalDispatchOrdinal) || received.logicalDispatchOrdinal < 1
      || observed.logicalDispatchOrdinal !== received.logicalDispatchOrdinal
      || JSON.stringify(digests) !== JSON.stringify(receivedDigest)) {
      throw new Error('ws5_local_runtime_attempt_identity_mismatch');
    }
  }
  return true;
}

async function attestAttempts(parentBroker, cell, attempts, { timeoutMs, signal } = {}) {
  const evidence = await awaitParentOperation((abortSignal) => parentBroker.attestRequests({
    armId: cell.armId,
    caseId: cell.caseId,
    signal: abortSignal,
    localAttempts: attempts.map((entry) => ({
      localAttemptOrdinal: entry.localAttemptOrdinal,
      requestIdDigest: entry.gatewayRequestIdDigests?.[0] || null,
    })),
  }), timeoutMs, signal, 'ws5_gateway_attestation_timeout');
  return joinGatewayRequestAttestation(attempts, safeBrokerEvidence(evidence));
}

function writePrivateJson(filePath, value) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
  const descriptor = fs.openSync(filePath, 'wx', 0o600);
  try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
  return sha256(bytes);
}

function assertPrivateOutputDirectory(repoRoot, outputDirectory) {
  if (typeof outputDirectory !== 'string' || outputDirectory.length === 0) throw new Error('ws5_run_output_directory_required');
  const root = fs.realpathSync(repoRoot);
  const destination = path.resolve(outputDirectory);
  const relative = path.relative(root, destination);
  if (!relative || (relative !== '..' && !relative.startsWith('..' + path.sep))) {
    throw new Error('ws5_run_output_must_be_outside_source_tree');
  }
}

function assertExternalExistingPath(repoRoot, value, type, failureCode) {
  const root = fs.realpathSync(repoRoot);
  const resolved = fs.realpathSync(path.resolve(value));
  const relative = path.relative(root, resolved);
  if (!relative || (relative !== '..' && !relative.startsWith('..' + path.sep))) throw new Error(failureCode);
  const info = fs.statSync(resolved);
  if ((type === 'directory' && !info.isDirectory()) || (type === 'file' && !info.isFile())) throw new Error(failureCode);
  return resolved;
}

function assertBifrostEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('ws5_bifrost_endpoint_invalid'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('ws5_bifrost_endpoint_invalid');
  }
  return true;
}

/**
 * Execute the plan without per-cell callbacks from the caller. The only injected boundary is
 * the trusted, in-memory parent broker that owns Bifrost credentials and independent telemetry.
 */
export async function runWs5Matrix({
  authorizeModelDispatch = false,
  repoRoot = ROOT,
  outputDirectory,
  sourceCacheRoot,
  alibabaBinaryPath,
  pins,
  parentBroker,
  signal: parentSignal,
} = {}) {
  if (authorizeModelDispatch !== true) throw new Error('ws5_model_dispatch_not_authorized_by_root');
  const root = fs.realpathSync(path.resolve(repoRoot));
  const bundle = loadPinnedAcceptancePlan(root);
  const schedule = createPublicRunCellPlan(bundle.plan);
  if (schedule.length !== WS5_MATRIX_BOUNDS.expectedCells
    || schedule.filter((entry) => entry.execution === 'model_run').length !== MODEL_CELLS) {
    throw new Error('ws5_frozen_matrix_shape_mismatch');
  }
  assertPrivateOutputDirectory(root, outputDirectory);
  if (typeof sourceCacheRoot !== 'string' || !path.isAbsolute(sourceCacheRoot)
    || typeof alibabaBinaryPath !== 'string' || !path.isAbsolute(alibabaBinaryPath)) {
    throw new Error('ws5_local_pinned_inputs_required');
  }
  sourceCacheRoot = assertExternalExistingPath(root, sourceCacheRoot, 'directory', 'ws5_source_cache_path_invalid');
  alibabaBinaryPath = assertExternalExistingPath(root, alibabaBinaryPath, 'file', 'ws5_alibaba_binary_path_invalid');
  if (!parentBroker || typeof parentBroker.preflightAlias !== 'function'
    || typeof parentBroker.readApiKeyInMemory !== 'function' || typeof parentBroker.attestRequests !== 'function'
    || typeof parentBroker.bifrostBaseUrl !== 'string') throw new Error('ws5_parent_broker_contract_missing');
  const startedAt = Date.now();
  const preflightDeadline = startedAt + PREFLIGHT_WALL_MS;
  const dispatchDeadline = preflightDeadline + MODEL_CELLS * CELL_WALL_MS;
  const panelAbortController = new AbortController();
  const globalPanelTimer = setTimeout(() => panelAbortController.abort(), MAX_PANEL_WALL_MS);
  const relayParentAbort = () => panelAbortController.abort();
  parentSignal?.addEventListener('abort', relayParentAbort, { once: true });
  const runSignal = panelAbortController.signal;
  if (parentSignal?.aborted) relayParentAbort();
  const verifiedSourceCases = new Map();
  let sourceFreezeIdentity = null;
  let baselineRuntimeIdentity = null;
  let revisedRuntimeIdentity = null;
  let repeatRuntimeIdentity = null;
  let imageIdentity = null;
  let transportProfilesByArm = null;
  let privateCredential = null;
  let dispatchStopCode = null;
  let abortedByParent = runSignal.aborted;

  const preflightPanel = async (input) => {
    if (runSignal.aborted) throw new Error('ws5_parent_cancelled');
    if (Date.now() > preflightDeadline) throw new Error('ws5_preflight_wall_time_cap_exceeded');
    if (!pins || typeof pins !== 'object') throw new Error('ws5_final_pins_required');
    sourceFreezeIdentity = verifyPublicSourceFreeze(root, pins.sourceFreezePath, pins.sourceFreezeSha256);
    const baselineArm = bundle.plan.publicRunMatrix.arms.find((entry) => entry.id === 'yeti-v1-native-baseline');
    const revisedArm = bundle.plan.publicRunMatrix.arms.find((entry) => entry.id === 'yeti-revised-medium');
    const repeatArm = bundle.plan.publicRunMatrix.arms.find((entry) => entry.id === 'yeti-revised-medium-repeat');
    baselineRuntimeIdentity = readRuntimeIdentity(pins.baselineRuntimeRoot);
    revisedRuntimeIdentity = readRuntimeIdentity(pins.revisedRuntimeRoot);
    const repeatRoot = pins.repeatRuntimeRoot || pins.revisedRuntimeRoot;
    repeatRuntimeIdentity = readRuntimeIdentity(repeatRoot);
    assertRuntimeIdentity({ armId: baselineArm.id, expectedRuntimeSha: baselineArm.runtimeSha,
      actualRuntimeSha: baselineRuntimeIdentity.commit, worktreeClean: baselineRuntimeIdentity.worktreeClean });
    if (!GIT_SHA_RE.test(String(pins.baselineRuntimeTreeOid || ''))
      || baselineRuntimeIdentity.tree !== pins.baselineRuntimeTreeOid) throw new Error('ws5_baseline_runtime_tree_pin_mismatch');
    assertRuntimeIdentity({ armId: revisedArm.id, expectedRuntimeSha: pins.revisedRuntimeSha,
      actualRuntimeSha: revisedRuntimeIdentity.commit, worktreeClean: revisedRuntimeIdentity.worktreeClean });
    assertRuntimeIdentity({ armId: repeatArm.id, expectedRuntimeSha: pins.repeatRuntimeSha,
      actualRuntimeSha: repeatRuntimeIdentity.commit, worktreeClean: repeatRuntimeIdentity.worktreeClean,
      revisedRuntimeSha: pins.revisedRuntimeSha });
    if (revisedRuntimeIdentity.tree !== pins.revisedRuntimeTreeOid
      || repeatRuntimeIdentity.tree !== revisedRuntimeIdentity.tree) throw new Error('ws5_revised_runtime_tree_pin_mismatch');
    imageIdentity = verifyImagePinReceipt(pins.imageProvenancePath, {
      expectedReceiptSha256: pins.imageProvenanceSha256,
      expectedSourceCommit: pins.revisedRuntimeSha,
      expectedImageDigest: pins.workerImageDigest,
      requiredPlatform: pins.workerImagePlatform,
    });
    transportProfilesByArm = {
      baseline: await runPinnedTransportPreflight({
        repoRoot: root, runtimeRoot: pins.baselineRuntimeRoot,
        expectedRuntimeSha: baselineRuntimeIdentity.commit,
        expectedRuntimeTreeOid: baselineRuntimeIdentity.tree,
        expectedHostExecution: baselineRuntimeIdentity.hostExecution,
        deadline: preflightDeadline, signal: runSignal,
      }),
      revised: await runPinnedTransportPreflight({
        repoRoot: root, runtimeRoot: pins.revisedRuntimeRoot,
        expectedRuntimeSha: revisedRuntimeIdentity.commit,
        expectedRuntimeTreeOid: revisedRuntimeIdentity.tree,
        expectedHostExecution: revisedRuntimeIdentity.hostExecution,
        deadline: preflightDeadline, signal: runSignal,
      }),
      repeated: await runPinnedTransportPreflight({
        repoRoot: root, runtimeRoot: repeatRoot,
        expectedRuntimeSha: repeatRuntimeIdentity.commit,
        expectedRuntimeTreeOid: repeatRuntimeIdentity.tree,
        expectedHostExecution: repeatRuntimeIdentity.hostExecution,
        deadline: preflightDeadline, signal: runSignal,
      }),
    };
    assertMatchedPrimaryTransportProfiles(Object.values(transportProfilesByArm));
    assertBifrostEndpoint(parentBroker.bifrostBaseUrl);
    if (Date.now() > preflightDeadline) throw new Error('ws5_preflight_wall_time_cap_exceeded');
    const preflightScratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ws5-no-call-preflight-'));
    const preflightHome = path.join(preflightScratch, 'home');
    const preflightTemp = path.join(preflightScratch, 'tmp');
    fs.mkdirSync(preflightHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(preflightTemp, { recursive: true, mode: 0o700 });
    let publicPreflight;
    try {
      const child = await runBoundedChildProcess({
        command: process.execPath,
        args: [path.join(root, 'scripts/ws5-matrix-runner.mjs'), '--ws5-public-preflight',
          '--root', root, '--cache-root', path.resolve(sourceCacheRoot), '--binary', path.resolve(alibabaBinaryPath)],
        cwd: root,
        env: createSanitizedPreflightEnvironment({ home: preflightHome, temporaryDirectory: preflightTemp }),
        maxWallMs: Math.max(1, preflightDeadline - Date.now()),
        captureStdoutMaxBytes: MAX_PREFLIGHT_STDOUT_BYTES,
        signal: runSignal,
      });
      if (child.terminal !== 'exited' || child.exitCode !== 0 || child.reaped !== true || child.stdoutOverflow) {
        throw new Error(child.terminal === 'timed_out' ? 'ws5_preflight_wall_time_cap_exceeded'
          : child.terminal === 'aborted' ? 'ws5_parent_cancelled'
            : child.stdoutOverflow ? 'ws5_preflight_receipt_too_large' : 'ws5_source_preflight_child_failed');
      }
      try { publicPreflight = JSON.parse(child.stdout); }
      catch { throw new Error('ws5_source_preflight_receipt_invalid'); }
    } finally {
      fs.rmSync(preflightScratch, { recursive: true, force: true });
    }
    const expectedCaseIds = bundle.plan.publicPanel.caseIds;
    if (!Array.isArray(publicPreflight?.sourceCases)
      || JSON.stringify(publicPreflight.sourceCases.map((entry) => entry.caseId)) !== JSON.stringify(expectedCaseIds)
      || publicPreflight.sourceCases.some((entry, index) => entry.status !== 'verified'
        || entry.sourceOmissions?.length !== 0
        || entry.changedFileCount !== input.preparedDiscovery.cases[index]?.changedFiles?.length)) {
      throw new Error('ws5_source_cache_preflight_failed');
    }
    for (const entry of publicPreflight.sourceCases) {
      verifiedSourceCases.set(entry.caseId, { status: entry.status, changedFileCount: entry.changedFileCount,
        patchSetSha256: entry.patchSetSha256 });
    }
    const alibaba = publicPreflight.alibaba;
    if (Date.now() > preflightDeadline) throw new Error('ws5_preflight_wall_time_cap_exceeded');
    const route = await awaitParentOperation(
      (abortSignal) => parentBroker.preflightAlias({ modelAlias: MODEL_ALIAS, noModelCalls: true, signal: abortSignal }),
      Math.max(1, preflightDeadline - Date.now()), runSignal, 'ws5_provider_route_preflight_timeout');
    if (route?.status !== 'ready' || route.modelAlias !== MODEL_ALIAS || route.providerCalls !== 0
      || (route.modelCalls !== undefined && route.modelCalls !== 0)) {
      throw new Error('ws5_provider_route_preflight_failed');
    }
    if (Date.now() > preflightDeadline) throw new Error('ws5_preflight_wall_time_cap_exceeded');
    return {
      status: 'ready_for_root_dispatch',
      planSha256: bundle.panelSha256,
      manifestSha256: bundle.manifestSha256,
      preparedInputSha256: bundle.plan.publicPanel.preparedInputSha256,
      sourceCases: publicPreflight.sourceCases,
      alibaba: {
        ...alibaba,
        sourceCompleteCaseCount: 7,
        comparatorScopeUnsupportedCaseCount: 1,
        providerCalls: 0,
      },
      transportProfilesByArm,
      provider: { status: 'ready', modelAlias: MODEL_ALIAS, providerCalls: 0 },
    };
  };

  const dispatchCell = async (cell) => {
    const remaining = dispatchDeadline - Date.now();
    if (abortedByParent || runSignal.aborted) abortedByParent = true;
    if (dispatchStopCode) return modelCellFailureReceipt(bundle, cell, verifiedSourceCases.get(cell.caseId),
      dispatchStopCode, 0);
    if (abortedByParent) return modelCellFailureReceipt(bundle, cell, verifiedSourceCases.get(cell.caseId),
      'ws5_parent_cancelled', 0);
    if (remaining < 1_000) return modelCellFailureReceipt(bundle, cell, verifiedSourceCases.get(cell.caseId),
      'ws5_global_panel_wall_time_cap_exceeded', 0);
    const cellWallMs = Math.min(CELL_WALL_MS, remaining);
    const cellStartedAt = Date.now();
    const cellDeadline = cellStartedAt + cellWallMs;
    const runtimeBinding = selectYetiRuntimeForCell(cell, pins, {
      baseline: baselineRuntimeIdentity,
      revised: revisedRuntimeIdentity,
      repeat: repeatRuntimeIdentity,
    });
    const expectedRuntimeSha = runtimeBinding.expectedRuntimeSha;
    const runtimeRoot = runtimeBinding.runtimeRoot;
    if (runSignal.aborted) {
      abortedByParent = true;
      return modelCellFailureReceipt(bundle, cell, verifiedSourceCases.get(cell.caseId), 'ws5_parent_cancelled', 0);
    }
    if (!privateCredential) {
      try {
        privateCredential = await awaitParentOperation(
          (abortSignal) => parentBroker.readApiKeyInMemory({ signal: abortSignal }),
          Math.max(1, cellDeadline - Date.now()), runSignal, 'ws5_parent_broker_credential_timeout');
      }
      catch { dispatchStopCode = 'ws5_parent_broker_credential_unavailable'; }
      if (typeof privateCredential !== 'string' || privateCredential.length < 1) {
        dispatchStopCode ||= 'ws5_parent_broker_credential_unavailable';
        return modelCellFailureReceipt(bundle, cell, verifiedSourceCases.get(cell.caseId), dispatchStopCode, 0);
      }
    }
    if (cell.armId === 'alibaba-open-code-review') {
      const scratch = fs.mkdtempSync(path.join(outputDirectory, '.ws5-alibaba-cell-'));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1, cellDeadline - Date.now()));
      const forwardAbort = () => controller.abort();
      parentSignal?.addEventListener('abort', forwardAbort, { once: true });
      try {
        const { receiptPath } = await runAlibabaCase({
          bundle,
          caseId: cell.caseId,
          binaryPath: alibabaBinaryPath,
          cacheRoot: sourceCacheRoot,
          outputDirectory: scratch,
          modelAlias: MODEL_ALIAS,
          bifrostBaseUrl: parentBroker.bifrostBaseUrl,
          bifrostApiKey: privateCredential,
          rootAuthorization: '1',
          mode: 'normal',
          maxForwardedAttempts: CASE_LIMIT,
          maxWallMs: Math.max(1, cellDeadline - Date.now()),
          signal: controller.signal,
        });
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        const attempts = receipt.model?.httpAttempts || [];
        try {
          receipt.providerAttestation = await attestAttempts(parentBroker, cell, attempts, {
            timeoutMs: Math.max(1, cellDeadline - Date.now()), signal: controller.signal,
          });
        } catch (error) {
          receipt.status = 'incomplete';
          receipt.outcome = { ...(receipt.outcome || {}), terminalState: 'provider_attestation_missing',
            failureCode: safeCode(error, 'ws5_provider_attestation_missing') };
          receipt.providerAttestation = null;
        }
        receipt.qualityScore = null;
        return receipt;
      } catch (error) {
        return modelCellFailureReceipt(bundle, cell, verifiedSourceCases.get(cell.caseId),
          safeCode(error), Date.now() - startedAt);
      } finally {
        clearTimeout(timer);
        parentSignal?.removeEventListener('abort', forwardAbort);
        fs.rmSync(scratch, { recursive: true, force: true });
      }
    }

    const scratch = fs.mkdtempSync(path.join(outputDirectory, '.ws5-yeti-cell-'));
    const home = path.join(scratch, 'home');
    const temporaryDirectory = path.join(scratch, 'tmp');
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.mkdirSync(temporaryDirectory, { recursive: true, mode: 0o700 });
    const localToken = crypto.randomBytes(32).toString('hex');
    let proxy = null;
    let tlsMaterial = null;
    let localTlsBoundary = null;
    let attestationAttempted = false;
    const rawRunPath = path.join(scratch, 'runtime-run.json');
    const purpose = cell.armId === 'yeti-v1-native-baseline' ? 'baseline' : 'qualification';
    const effortProfile = arm.effortProfile;
    const verifierMode = arm.verifierMode;
    const policyPath = path.join(root, 'eval-baselines/competitive-review-benchmark/policy-projections',
      effortProfile === 'native_omitted' ? 'yeti-v1-native-omitted.json' : 'yeti-v1-medium.json');
    const args = [
      path.join(root, 'scripts/competitive-review-benchmark.mjs'), 'run-discovery',
      '--manifest', path.join(root, bundle.plan.publicPanel.manifestPath),
      '--cases', path.join(root, bundle.plan.publicPanel.preparedInputs.discovery.path),
      '--runtime-root', path.resolve(runtimeRoot),
      '--cache', path.resolve(sourceCacheRoot),
      '--expected-runtime-sha', expectedRuntimeSha,
      '--purpose', purpose,
      '--policy-file', policyPath,
      '--effort-profile', effortProfile,
      '--verifier-mode', verifierMode,
      '--case-id', cell.caseId,
      '--out', rawRunPath,
    ];
    const withLocalTlsBoundary = (receipt) => {
      if (localTlsBoundary) receipt.localTransportBoundary = localTlsBoundary;
      return receipt;
    };
    try {
      tlsMaterial = createEphemeralLoopbackTls(scratch);
      proxy = createBifrostMeterProxy({
        upstreamBaseUrl: parentBroker.bifrostBaseUrl,
        apiKey: privateCredential,
        modelAlias: MODEL_ALIAS,
        maxForwardedAttempts: CASE_LIMIT,
        maxInboundAttempts: CASE_LIMIT,
        maxOutputTokensPerRequest: null,
        requestAccountingMode: 'review_yeti',
        localBearerToken: localToken,
        localTls: { key: tlsMaterial.key, cert: tlsMaterial.cert },
      });
      const localBaseUrl = await proxy.listen();
      localTlsBoundary = {
        protocol: 'https',
        endpointHost: '127.0.0.1',
        certificateSha256: tlsMaterial.certificateSha256,
        opensslVersion: tlsMaterial.opensslVersion,
        opensslExecutableSha256: tlsMaterial.opensslExecutableSha256,
        childTrust: 'NODE_EXTRA_CA_CERTS_public_certificate_only',
        privateKeySentToChild: false,
      };
      const environment = createSanitizedYetiChildEnvironment({
        home, temporaryDirectory, localBaseUrl, localToken,
        localCaCertificatePath: tlsMaterial.publicCaPath,
      });
      const child = await runBoundedChildProcess({
        command: process.execPath,
        args,
        cwd: root,
        env: environment,
        maxWallMs: Math.max(1, cellDeadline - Date.now()),
        signal: runSignal,
      });
      const proxySnapshot = proxy.snapshot();
      if (child.terminal !== 'exited' || child.exitCode !== 0 || child.reaped !== true) {
        const attempts = proxySnapshot.requests.map((entry) => ({
          localAttemptOrdinal: entry.localAttemptOrdinal,
          logicalDispatchOrdinal: entry.logicalDispatchOrdinal,
          gatewayRequestIdDigests: entry.gatewayRequestIdDigest ? [entry.gatewayRequestIdDigest] : [],
        }));
        let attestation = null;
        if (attempts.length > 0) {
          attestationAttempted = true;
          try { attestation = await attestAttempts(parentBroker, cell, attempts, {
            timeoutMs: Math.max(1, cellDeadline - Date.now()), signal: runSignal,
          }); } catch {}
        }
        if (child.reaped !== true) abortedByParent = true;
        return withLocalTlsBoundary(modelCellFailureReceipt(bundle, cell, verifiedSourceCases.get(cell.caseId),
          child.terminal === 'timed_out' ? 'ws5_cell_wall_time_cap_exceeded'
            : child.terminal === 'aborted' ? 'ws5_parent_cancelled' : 'ws5_runtime_child_failed',
          Date.now() - cellStartedAt, proxySnapshot, attestation));
      }
      if (!fs.existsSync(rawRunPath)) {
        const attempts = proxySnapshot.requests.map((entry) => ({
          localAttemptOrdinal: entry.localAttemptOrdinal,
          logicalDispatchOrdinal: entry.logicalDispatchOrdinal,
          gatewayRequestIdDigests: entry.gatewayRequestIdDigest ? [entry.gatewayRequestIdDigest] : [],
        }));
        let attestation = null;
        if (attempts.length > 0) {
          attestationAttempted = true;
          try { attestation = await attestAttempts(parentBroker, cell, attempts, {
            timeoutMs: Math.max(1, cellDeadline - Date.now()), signal: runSignal,
          }); } catch {}
        }
        return withLocalTlsBoundary(modelCellFailureReceipt(bundle, cell, verifiedSourceCases.get(cell.caseId),
          'ws5_runtime_receipt_missing', Date.now() - cellStartedAt, proxySnapshot, attestation));
      }
      const run = JSON.parse(fs.readFileSync(rawRunPath, 'utf8'));
      const rawCase = run.cases?.find((entry) => entry.caseId === cell.caseId);
      if (!rawCase || !Array.isArray(rawCase.model?.httpAttempts)) throw new Error('ws5_runtime_case_attempts_missing');
      assertLocalProxyAgainstRuntime(proxySnapshot, rawCase.model.httpAttempts);
      attestationAttempted = true;
      const providerAttestation = await attestAttempts(parentBroker, cell, rawCase.model.httpAttempts, {
        timeoutMs: Math.max(1, cellDeadline - Date.now()), signal: runSignal,
      });
      const normalized = normalizeDiscoveryRunEnvelope(bundle, cell.armId, run,
        new Map([[cell.caseId, providerAttestation]]), {
          expectedRuntimeSha,
          expectedHostExecution: runtimeBinding.hostExecution,
          selectedCaseId: cell.caseId,
        });
      if (normalized.length !== 1) throw new Error('ws5_serial_runtime_cell_count_mismatch');
      const receipt = normalized[0];
      receipt.model.callAccounting = {
        ...(receipt.model.callAccounting || {}),
        proxyIngressAttemptCount: proxySnapshot.receivedCompletionAttempts,
        proxyForwardedCompletionAttemptCount: proxySnapshot.forwardedCompletionAttempts,
      };
      receipt.localTransportBoundary = localTlsBoundary;
      receipt.outcome = {
        terminalState: rawCase.receipt?.conclusion || rawCase.receipt?.verdict || rawCase.status,
        reviewDecision: rawCase.receipt?.reviewDecision || null,
        findings: receipt.runtimeReceipt?.findings || [],
      };
      receipt.qualityScore = null;
      return receipt;
    } catch (error) {
      const snapshot = proxy?.snapshot() || null;
      let providerAttestation = null;
      const attempts = snapshot?.requests?.map((entry) => ({
        localAttemptOrdinal: entry.localAttemptOrdinal,
        logicalDispatchOrdinal: entry.logicalDispatchOrdinal,
        gatewayRequestIdDigests: entry.gatewayRequestIdDigest ? [entry.gatewayRequestIdDigest] : [],
      })) || [];
      if (attempts.length > 0 && !attestationAttempted) {
        attestationAttempted = true;
        try { providerAttestation = await attestAttempts(parentBroker, cell, attempts, {
          timeoutMs: Math.max(1, cellDeadline - Date.now()), signal: runSignal,
        }); } catch {}
      }
      return withLocalTlsBoundary(modelCellFailureReceipt(bundle, cell, verifiedSourceCases.get(cell.caseId), safeCode(error),
        Date.now() - cellStartedAt, snapshot, providerAttestation));
    } finally {
      if (proxy) await proxy.close();
      tlsMaterial?.cleanup();
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  };

  const preflightAbstention = async (cell, preflight) =>
    buildAlibabaSourceScopeAbstention(bundle, preflight.alibaba, cell.caseId);

  try {
    const result = await runPublicRunCells(bundle, {
      outputDirectory,
      authorizeModelDispatch: true,
      preflightPanel,
      dispatchCell,
      preflightAbstention,
    });
    const globalWallCapExceeded = Date.now() - startedAt > MAX_PANEL_WALL_MS;
    const envelope = {
      schemaVersion: 'ReviewYetiWS5MatrixExecutionEnvelope.v1',
      status: globalWallCapExceeded || runSignal.aborted ? 'incomplete_global_wall_or_operator_abort' : result.manifest.status,
      noAutomaticRetries: true,
      expectedCells: WS5_MATRIX_BOUNDS.expectedCells,
      modelRunCells: WS5_MATRIX_BOUNDS.modelRunCells,
      maxConcurrentCells: 1,
      maxForwardedModelRequestsPerCell: CASE_LIMIT,
      maxPreflightWallMs: PREFLIGHT_WALL_MS,
      maxCellWallMs: CELL_WALL_MS,
      maxFinalizationWallMs: FINALIZATION_WALL_MS,
      maxPanelWallMs: MAX_PANEL_WALL_MS,
      panelWallMs: Date.now() - startedAt,
      globalWallCapExceeded,
      interrupted: runSignal.aborted && !globalWallCapExceeded,
      sourceFreeze: sourceFreezeIdentity,
      revisedRuntime: revisedRuntimeIdentity ? {
        commit: revisedRuntimeIdentity.commit, tree: revisedRuntimeIdentity.tree, worktreeClean: revisedRuntimeIdentity.worktreeClean,
      } : null,
      hostExecutionByArm: {
        baseline: baselineRuntimeIdentity?.hostExecution || null,
        revised: revisedRuntimeIdentity?.hostExecution || null,
        repeated: repeatRuntimeIdentity?.hostExecution || null,
      },
      transportProfilesByArm,
      workerImageProvenanceReference: imageIdentity,
      workerImageExecution: 'provenance_reference_only_not_executed_by_ws5_host_runner',
      runManifestSha256: result.manifestSha256,
      qualityScore: null,
      providerServingEffort: 'unknown_until_per_request_attestation',
      billedRequestCount: null,
      actualCostUsd: null,
    };
    const envelopeSha256 = writePrivateJson(path.join(outputDirectory, 'execution-envelope.json'), envelope);
    return { ...result, executionEnvelope: envelope, executionEnvelopeSha256: envelopeSha256 };
  } finally {
    clearTimeout(globalPanelTimer);
    parentSignal?.removeEventListener('abort', relayParentAbort);
    privateCredential = null;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  && process.argv[2] === '--ws5-public-preflight') {
  try {
    const args = parsePreflightArgs(process.argv.slice(3));
    process.stdout.write(JSON.stringify(performPublicNoCallPreflight(args)) + '\n');
  } catch (error) {
    process.stderr.write(`${safeCode(error, 'ws5_public_preflight_failed')}\n`);
    process.exitCode = 2;
  }
}
