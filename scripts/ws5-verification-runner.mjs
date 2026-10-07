#!/usr/bin/env node

/** Serial parent-broker runner for the separately scored ten-row verification panel. */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildVerificationCases,
  loadPinnedAacrDataset,
  scoreVerificationCases,
} from './competitive-review-benchmark.mjs';
import {
  joinGatewayRequestAttestation,
  loadPinnedAcceptancePlan,
} from './ws5-acceptance.mjs';
import { createBifrostMeterProxy } from './ws5-alibaba.mjs';
import {
  assertMatchedPrimaryTransportProfiles,
  assertLocalProxyAgainstRuntime,
  assertRuntimeIdentity,
  awaitParentOperation,
  createSanitizedPreflightEnvironment,
  createSanitizedYetiChildEnvironment,
  createEphemeralLoopbackTls,
  readRuntimeIdentity,
  runBoundedChildProcess,
  runPinnedTransportPreflight,
  verifyImagePinReceipt,
  verifyPublicSourceFreeze,
} from './ws5-matrix-runner.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODEL_ALIAS = 'pr-reviewer';
const MAX_CASE_WALL_MS = 1_200_000;
const MAX_PREFLIGHT_WALL_MS = 1_200_000;
const MAX_FINALIZATION_WALL_MS = 300_000;
const MAX_CELL_COUNT = 10;
const MAX_PANEL_WALL_MS = MAX_PREFLIGHT_WALL_MS + MAX_CELL_COUNT * MAX_CASE_WALL_MS + MAX_FINALIZATION_WALL_MS;
const MAX_PREFLIGHT_STDOUT_BYTES = 4 * 1024 * 1024;
const EXPECTED_REFERENCE_COUNTS = Object.freeze({ positive: 7, negative: 3, total: 10 });
const GIT_SHA_RE = /^[a-f0-9]{40}$/u;

export const WS5_VERIFICATION_BOUNDS = Object.freeze({
  expectedCells: MAX_CELL_COUNT,
  maxConcurrentCells: 1,
  maxForwardedModelRequestsPerCell: 1,
  maxCellWallMs: MAX_CASE_WALL_MS,
  maxPreflightWallMs: MAX_PREFLIGHT_WALL_MS,
  maxFinalizationWallMs: MAX_FINALIZATION_WALL_MS,
  maxPanelWallMs: MAX_PANEL_WALL_MS,
  maxForwardedModelRequests: MAX_CELL_COUNT,
  maxOutputTokens: 4_096,
  automaticRetries: 0,
});

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function safeCode(error, fallback = 'verification_cell_failed') {
  const value = String(error?.message || '');
  return /^[a-z0-9_]{1,100}$/u.test(value) ? value : fallback;
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

function assertPrivateOutput(repoRoot, outputDirectory) {
  if (typeof outputDirectory !== 'string' || outputDirectory.length === 0) throw new Error('ws5_verification_output_required');
  const root = fs.realpathSync(repoRoot);
  const destination = path.resolve(outputDirectory);
  const relative = path.relative(root, destination);
  if (!relative || (relative !== '..' && !relative.startsWith('..' + path.sep))) {
    throw new Error('ws5_verification_output_must_be_outside_source');
  }
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  const info = fs.lstatSync(destination);
  const actual = fs.realpathSync(destination);
  const actualRelative = path.relative(root, actual);
  if (!info.isDirectory() || info.isSymbolicLink() || !actualRelative
    || (actualRelative !== '..' && !actualRelative.startsWith('..' + path.sep))) {
    throw new Error('ws5_verification_output_must_be_outside_source');
  }
  if (fs.readdirSync(destination).length !== 0) throw new Error('ws5_verification_output_not_empty');
  return destination;
}

function writePrivateJson(filePath, value) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
  const descriptor = fs.openSync(filePath, 'wx', 0o600);
  try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
  return sha256(bytes);
}

/** Build the exact 10-row selection without loading the dataset labels into a worker input. */
export function createVerificationCellPlan(bundle) {
  const acceptance = bundle?.plan ? bundle : null;
  const panel = acceptance?.plan?.verificationPanel;
  const rows = acceptance?.preparedVerification?.cases;
  const ids = panel?.diffLevelCaseIds;
  if (!acceptance || !Array.isArray(ids) || ids.length !== MAX_CELL_COUNT
    || new Set(ids).size !== ids.length || !Array.isArray(rows) || rows.length !== 28
    || panel.labelCounts?.positive !== EXPECTED_REFERENCE_COUNTS.positive
    || panel.labelCounts?.negative !== EXPECTED_REFERENCE_COUNTS.negative
    || panel.labelCounts?.total !== EXPECTED_REFERENCE_COUNTS.total
    || panel.preparedInputSha256 !== acceptance.plan.publicPanel.preparedInputs?.verification?.sha256) {
    throw new Error('ws5_verification_panel_shape_mismatch');
  }
  const byId = new Map(rows.map((row) => [row.caseId, row]));
  return ids.map((caseId, index) => {
    const row = byId.get(caseId);
    if (!row || row.context !== 'Diff Level' || (row.sourceOmissions || []).length > 0
      || !Array.isArray(row.changedFiles)) throw new Error('ws5_verification_case_source_mismatch');
    return {
      ordinal: index + 1,
      caseId,
      context: 'Diff Level',
      execution: 'model_run',
      maxForwardedRequests: 1,
      maxOutputTokens: WS5_VERIFICATION_BOUNDS.maxOutputTokens,
      qualityScore: null,
    };
  });
}

/** Validate one exact case emitted by run-verification against the frozen 10-row panel and runtime. */
export function assertVerificationRunIdentity(bundle, cell, run, {
  expectedRuntimeSha,
  expectedRuntimeTreeOid,
  expectedHostExecution,
  expectedTransportName,
} = {}) {
  const plan = bundle?.plan;
  const panelIds = bundle?.preparedVerification?.cases?.map((entry) => entry.caseId);
  if (!plan || !Array.isArray(panelIds) || run?.task !== 'comment-verification'
    || run?.datasetSha256 !== plan.publicPanel.datasetSha256
    || run?.heldoutManifestSha256 !== plan.publicPanel.manifestSha256
    || run?.preparedInputSha256 !== plan.verificationPanel.preparedInputSha256) {
    throw new Error('ws5_verification_run_pin_mismatch');
  }
  if (JSON.stringify(run.panelCaseIds) !== JSON.stringify(panelIds) || run.panelSize !== panelIds.length
    || JSON.stringify(run.selectedCaseIds) !== JSON.stringify([cell.caseId]) || run.selectedCaseCount !== 1
    || !Array.isArray(run.cases) || run.cases.length !== 1 || run.cases[0].caseId !== cell.caseId) {
    throw new Error('ws5_verification_selected_case_mismatch');
  }
  if (!GIT_SHA_RE.test(String(expectedRuntimeSha || '')) || !GIT_SHA_RE.test(String(expectedRuntimeTreeOid || ''))
    || run.runtime?.commit !== expectedRuntimeSha || run.runtime?.tree !== expectedRuntimeTreeOid
    || run.runtime?.worktreeClean !== true) throw new Error('ws5_verification_runtime_pin_mismatch');
  if (!expectedHostExecution || JSON.stringify(run.runtime?.hostExecution) !== JSON.stringify(expectedHostExecution)
    || run.runtime?.hostExecution?.workerImageExecution !== 'provenance_reference_only_not_executed_by_ws5_host_runner') {
    throw new Error('ws5_verification_host_execution_identity_mismatch');
  }
  if (typeof expectedTransportName !== 'string' || !expectedTransportName
    || run.requestedConfiguration?.transport?.name !== expectedTransportName
    || run.requestedConfiguration?.transport?.requestedModel !== MODEL_ALIAS) {
    throw new Error('ws5_verification_transport_profile_mismatch');
  }
  const row = run.cases[0];
  if (row.context !== 'Diff Level' || !['completed', 'incomplete'].includes(row.status)
    || !['CONFIRM', 'REFUTE', 'ABSTAIN'].includes(row.verdict)
    || !Array.isArray(row.sourceOmissions) || row.sourceOmissions.length > 0) {
    throw new Error('ws5_verification_result_shape_invalid');
  }
  return row;
}

function assertBifrostEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('ws5_bifrost_endpoint_invalid'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('ws5_bifrost_endpoint_invalid');
  }
}

function safeEvidence(value) {
  return {
    status: value?.status,
    source: value?.source,
    evidenceDigest: value?.evidenceDigest,
    requests: Array.isArray(value?.requests) ? value.requests.map((entry) => ({
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

async function joinCellEvidence(parentBroker, cell, attempts, timeoutMs, signal) {
  if (attempts.length === 0) return null;
  const evidence = await awaitParentOperation((abortSignal) => parentBroker.attestRequests({
    armId: 'yeti-primary-comment-verification',
    caseId: cell.caseId,
    signal: abortSignal,
    localAttempts: attempts.map((attempt) => ({
      localAttemptOrdinal: attempt.localAttemptOrdinal,
      requestIdDigest: attempt.gatewayRequestIdDigests?.[0] || null,
    })),
  }), timeoutMs, signal, 'ws5_verification_gateway_attestation_timeout');
  return joinGatewayRequestAttestation(attempts, safeEvidence(evidence));
}

function failedVerificationCell(cell, code, localAttempts = [], providerAttestation = null, elapsedMs = 0, noModelDispatch = null) {
  return {
    ordinal: cell.ordinal,
    armId: 'yeti-primary-comment-verification',
    caseId: cell.caseId,
    status: 'incomplete',
    context: 'Diff Level',
    contextQualification: 'aligned_diff_only',
    verdict: 'ABSTAIN',
    reason: code,
    sourceOmissions: [],
    usage: null,
    patchChars: null,
    selectedTransport: { name: 'bifrost', requestedModel: MODEL_ALIAS },
    httpAttempts: localAttempts,
    callAccounting: {
      logicalCompletionDispatches: null,
      localHttpRequestAttempts: localAttempts.length,
      proxyIngressAttemptCount: localAttempts.length,
      proxyForwardedCompletionAttemptCount: noModelDispatch === true && localAttempts.length === 0 ? 0 : null,
      requestProfileAttemptCount: null,
      requestAttemptAccountingMatches: false,
      dispatchAttemptAccountingMatches: false,
      dispatches: [],
      gatewayRelayCount: null,
      providerCompletionCount: null,
      billedRequestCount: null,
      costUsd: null,
    },
    providerAttestation,
    metrics: { totalDurationMs: elapsedMs },
    outcome: { terminalState: 'capped_or_cancelled', failureCode: code },
    noAutomaticRetry: true,
    noModelDispatch,
    qualityScore: null,
  };
}

export function writeUndispatchedVerificationCell(outputDirectory, cell, failureCode, elapsedMs = 0) {
  const row = failedVerificationCell(cell, failureCode, [], null, elapsedMs, true);
  return writeVerificationCellReceipt(outputDirectory, cell, row);
}

function writeVerificationCellReceipt(outputDirectory, cell, row) {
  const receiptName = 'verification-cell-' + String(cell.ordinal).padStart(2, '0') + '-' + cell.caseId + '.json';
  const receiptSha256 = writePrivateJson(path.join(outputDirectory, receiptName), row);
  row.receiptFile = receiptName;
  row.receiptSha256 = receiptSha256;
  return row;
}

function sourcePreflightEnv(home, temporaryDirectory) {
  return createSanitizedPreflightEnvironment({ home, temporaryDirectory });
}

async function runBoundedPublicPreflight({ root, sourceCacheRoot, alibabaBinaryPath, deadline, signal }) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ws5-verification-preflight-'));
  const home = path.join(scratch, 'home');
  const temporaryDirectory = path.join(scratch, 'tmp');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(temporaryDirectory, { recursive: true, mode: 0o700 });
  try {
    const child = await runBoundedChildProcess({
      command: process.execPath,
      args: [path.join(root, 'scripts/ws5-matrix-runner.mjs'), '--ws5-public-preflight',
        '--root', root, '--cache-root', sourceCacheRoot, '--binary', alibabaBinaryPath],
      cwd: root,
      env: sourcePreflightEnv(home, temporaryDirectory),
      maxWallMs: Math.max(1, deadline - Date.now()),
      captureStdoutMaxBytes: MAX_PREFLIGHT_STDOUT_BYTES,
      signal,
    });
    if (child.terminal !== 'exited' || child.exitCode !== 0 || child.reaped !== true || child.stdoutOverflow) {
      throw new Error(child.terminal === 'timed_out' ? 'ws5_preflight_wall_time_cap_exceeded'
        : child.terminal === 'aborted' ? 'ws5_parent_cancelled'
          : child.stdoutOverflow ? 'ws5_preflight_receipt_too_large' : 'ws5_source_preflight_child_failed');
    }
    try { return JSON.parse(child.stdout); } catch { throw new Error('ws5_source_preflight_receipt_invalid'); }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function validatePreflight(bundle, input) {
  const caseIds = bundle.plan.publicPanel.caseIds;
  if (!Array.isArray(input?.sourceCases)
    || JSON.stringify(input.sourceCases.map((entry) => entry.caseId)) !== JSON.stringify(caseIds)
    || input.sourceCases.some((entry, index) => entry.status !== 'verified' || entry.sourceOmissions?.length !== 0
      || entry.changedFileCount !== bundle.preparedDiscovery.cases[index]?.changedFiles?.length)) {
    throw new Error('ws5_verification_source_preflight_failed');
  }
  const alibaba = input.alibaba;
  if (alibaba?.providerCalls !== 0 || alibaba?.sourceCompleteCaseCount !== 7
    || alibaba?.comparatorScopeUnsupportedCaseCount !== 1
    || alibaba.cases?.find((entry) => entry.caseId === 'aacr-cpp-85873')?.status !== 'source_scope_unsupported') {
    throw new Error('ws5_verification_shared_preflight_failed');
  }
  return input.sourceCases;
}

function verifyPins(bundle, root, pins) {
  if (!pins || typeof pins !== 'object') throw new Error('ws5_verification_final_pins_required');
  const sourceFreeze = verifyPublicSourceFreeze(root, pins.sourceFreezePath, pins.sourceFreezeSha256);
  const baselineArm = bundle.plan.publicRunMatrix.arms.find((entry) => entry.id === 'yeti-v1-native-baseline');
  const baseline = readRuntimeIdentity(pins.baselineRuntimeRoot);
  const revised = readRuntimeIdentity(pins.revisedRuntimeRoot);
  const repeated = readRuntimeIdentity(pins.repeatRuntimeRoot || pins.revisedRuntimeRoot);
  assertRuntimeIdentity({ armId: baselineArm.id, expectedRuntimeSha: baselineArm.runtimeSha,
    actualRuntimeSha: baseline.commit, worktreeClean: baseline.worktreeClean });
  if (baseline.tree !== pins.baselineRuntimeTreeOid) throw new Error('ws5_baseline_runtime_tree_pin_mismatch');
  assertRuntimeIdentity({ armId: 'yeti-revised-medium', expectedRuntimeSha: pins.revisedRuntimeSha,
    actualRuntimeSha: revised.commit, worktreeClean: revised.worktreeClean });
  assertRuntimeIdentity({ armId: 'yeti-revised-medium-repeat', expectedRuntimeSha: pins.repeatRuntimeSha,
    actualRuntimeSha: repeated.commit, revisedRuntimeSha: pins.revisedRuntimeSha,
    worktreeClean: repeated.worktreeClean });
  if (revised.tree !== pins.revisedRuntimeTreeOid || repeated.tree !== revised.tree) {
    throw new Error('ws5_revised_runtime_tree_pin_mismatch');
  }
  const image = verifyImagePinReceipt(pins.imageProvenancePath, {
    expectedReceiptSha256: pins.imageProvenanceSha256,
    expectedSourceCommit: pins.revisedRuntimeSha,
    expectedImageDigest: pins.workerImageDigest,
    requiredPlatform: pins.workerImagePlatform,
  });
  return { sourceFreeze, baselineRuntime: baseline, revisedRuntime: revised, repeatRuntime: repeated, image };
}

function verificationOutputDirectory(root, value) {
  if (typeof value !== 'string' || !value) throw new Error('ws5_verification_output_required');
  const destination = path.resolve(value);
  const relative = path.relative(root, destination);
  if (!relative || (relative !== '..' && !relative.startsWith('..' + path.sep))) {
    throw new Error('ws5_verification_output_must_be_outside_source');
  }
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  const info = fs.lstatSync(destination);
  const real = fs.realpathSync(destination);
  const actualRelative = path.relative(root, real);
  if (!info.isDirectory() || info.isSymbolicLink() || !actualRelative
    || (actualRelative !== '..' && !actualRelative.startsWith('..' + path.sep))) {
    throw new Error('ws5_verification_output_must_be_outside_source');
  }
  if (fs.readdirSync(destination).length !== 0) throw new Error('ws5_verification_output_not_empty');
  return destination;
}

export async function runWs5VerificationPanel({
  authorizeModelDispatch = false,
  repoRoot = ROOT,
  outputDirectory,
  sourceCacheRoot,
  alibabaBinaryPath,
  datasetPath,
  pins,
  parentBroker,
  signal: parentSignal,
} = {}) {
  if (authorizeModelDispatch !== true) throw new Error('ws5_verification_dispatch_not_authorized_by_root');
  const root = fs.realpathSync(path.resolve(repoRoot));
  const bundle = loadPinnedAcceptancePlan(root);
  const cells = createVerificationCellPlan(bundle);
  const output = verificationOutputDirectory(root, outputDirectory);
  if (typeof sourceCacheRoot !== 'string' || !path.isAbsolute(sourceCacheRoot)
    || typeof alibabaBinaryPath !== 'string' || !path.isAbsolute(alibabaBinaryPath)) {
    throw new Error('ws5_verification_pinned_inputs_required');
  }
  const cacheRoot = assertExternalExistingPath(root, sourceCacheRoot, 'directory', 'ws5_source_cache_path_invalid');
  const binaryPath = assertExternalExistingPath(root, alibabaBinaryPath, 'file', 'ws5_alibaba_binary_path_invalid');
  if (!parentBroker || typeof parentBroker.preflightAlias !== 'function'
    || typeof parentBroker.readApiKeyInMemory !== 'function' || typeof parentBroker.attestRequests !== 'function'
    || typeof parentBroker.bifrostBaseUrl !== 'string') throw new Error('ws5_parent_broker_contract_missing');
  const start = Date.now();
  const preflightDeadline = start + MAX_PREFLIGHT_WALL_MS;
  const dispatchDeadline = preflightDeadline + MAX_CELL_COUNT * MAX_CASE_WALL_MS;
  const panelAbort = new AbortController();
  const panelTimer = setTimeout(() => panelAbort.abort(), MAX_PANEL_WALL_MS);
  const relayAbort = () => panelAbort.abort();
  parentSignal?.addEventListener('abort', relayAbort, { once: true });
  if (parentSignal?.aborted) relayAbort();
  const signal = panelAbort.signal;
  const rows = [];
  let pinEvidence = null;
  let credential = null;
  let stopCode = null;
  let sourceEvidence = null;
  let scoringCases = null;
  let preflightFailure = null;

  try {
    if (signal.aborted) preflightFailure = 'ws5_parent_cancelled';
    else if (!pins || typeof pins !== 'object') preflightFailure = 'ws5_verification_final_pins_required';
    else {
      try {
        pinEvidence = verifyPins(bundle, root, pins);
        const repeatRoot = pins.repeatRuntimeRoot || pins.revisedRuntimeRoot;
        const transportProfilesByArm = {
          baseline: await runPinnedTransportPreflight({
            repoRoot: root, runtimeRoot: pins.baselineRuntimeRoot,
            expectedRuntimeSha: pinEvidence.baselineRuntime.commit,
            expectedRuntimeTreeOid: pinEvidence.baselineRuntime.tree,
            expectedHostExecution: pinEvidence.baselineRuntime.hostExecution,
            deadline: preflightDeadline, signal,
          }),
          revised: await runPinnedTransportPreflight({
            repoRoot: root, runtimeRoot: pins.revisedRuntimeRoot,
            expectedRuntimeSha: pinEvidence.revisedRuntime.commit,
            expectedRuntimeTreeOid: pinEvidence.revisedRuntime.tree,
            expectedHostExecution: pinEvidence.revisedRuntime.hostExecution,
            deadline: preflightDeadline, signal,
          }),
          repeated: await runPinnedTransportPreflight({
            repoRoot: root, runtimeRoot: repeatRoot,
            expectedRuntimeSha: pinEvidence.repeatRuntime.commit,
            expectedRuntimeTreeOid: pinEvidence.repeatRuntime.tree,
            expectedHostExecution: pinEvidence.repeatRuntime.hostExecution,
            deadline: preflightDeadline, signal,
          }),
        };
        assertMatchedPrimaryTransportProfiles(Object.values(transportProfilesByArm));
        pinEvidence = { ...pinEvidence, transportProfilesByArm };
        assertBifrostEndpoint(parentBroker.bifrostBaseUrl);
        const dataset = loadPinnedAacrDataset(datasetPath);
        const candidateCases = buildVerificationCases(dataset, bundle.manifest, { perLabelPerPr: 1 });
        const scorerCasesById = new Map(candidateCases.map((entry) => [entry.id, entry]));
        scoringCases = cells.map((cell) => scorerCasesById.get(cell.caseId));
        if (scoringCases.some((entry) => !entry)) throw new Error('ws5_verification_scorer_case_set_mismatch');
        const publicPreflight = await runBoundedPublicPreflight({
          root,
          sourceCacheRoot: cacheRoot,
          alibabaBinaryPath: binaryPath,
          deadline: preflightDeadline,
          signal,
        });
        sourceEvidence = validatePreflight(bundle, publicPreflight);
        if (Date.now() > preflightDeadline) throw new Error('ws5_preflight_wall_time_cap_exceeded');
        const route = await awaitParentOperation(
          (abortSignal) => parentBroker.preflightAlias({ modelAlias: MODEL_ALIAS, noModelCalls: true, signal: abortSignal }),
          Math.max(1, preflightDeadline - Date.now()), signal, 'ws5_provider_route_preflight_timeout');
        if (route?.status !== 'ready' || route.modelAlias !== MODEL_ALIAS || route.providerCalls !== 0
          || (route.modelCalls !== undefined && route.modelCalls !== 0)) throw new Error('ws5_provider_route_preflight_failed');
      } catch (error) { preflightFailure = safeCode(error, 'ws5_verification_preflight_failed'); }
    }

    if (preflightFailure) {
      for (const cell of cells) {
        rows.push(writeUndispatchedVerificationCell(output, cell, preflightFailure));
      }
    } else {
      for (const cell of cells) {
        const cellStart = Date.now();
        const remainingGlobal = dispatchDeadline - cellStart;
        if (signal.aborted) {
          rows.push(writeUndispatchedVerificationCell(output, cell, 'ws5_parent_cancelled', Date.now() - cellStart));
          continue;
        }
        if (remainingGlobal < 1_000) {
          rows.push(writeUndispatchedVerificationCell(output, cell,
            'ws5_global_panel_wall_time_cap_exceeded', Date.now() - cellStart));
          continue;
        }
        if (stopCode) {
          rows.push(writeUndispatchedVerificationCell(output, cell, stopCode, Date.now() - cellStart));
          continue;
        }
        const cellDeadline = cellStart + Math.min(MAX_CASE_WALL_MS, remainingGlobal);
        if (!credential) {
          try {
            credential = await awaitParentOperation(
              (abortSignal) => parentBroker.readApiKeyInMemory({ signal: abortSignal }),
              Math.max(1, cellDeadline - Date.now()), signal, 'ws5_parent_broker_credential_timeout');
          } catch { stopCode = 'ws5_parent_broker_credential_unavailable'; }
          if (typeof credential !== 'string' || credential.length < 1) {
            stopCode ||= 'ws5_parent_broker_credential_unavailable';
            rows.push(writeUndispatchedVerificationCell(output, cell, stopCode, Date.now() - cellStart));
            continue;
          }
        }

        const scratch = fs.mkdtempSync(path.join(output, '.ws5-verification-cell-'));
        const home = path.join(scratch, 'home');
        const tmp = path.join(scratch, 'tmp');
        fs.mkdirSync(home, { recursive: true, mode: 0o700 });
        fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
        const localToken = crypto.randomBytes(32).toString('hex');
        let proxy = null;
        let tlsMaterial = null;
        let localTlsBoundary = null;
        let attestationAttempted = false;
        let row;
        const rawPath = path.join(scratch, 'verification-run.json');
        try {
          tlsMaterial = createEphemeralLoopbackTls(scratch);
          proxy = createBifrostMeterProxy({
            upstreamBaseUrl: parentBroker.bifrostBaseUrl,
            apiKey: credential,
            modelAlias: MODEL_ALIAS,
            maxForwardedAttempts: 1,
            maxInboundAttempts: 1,
            maxOutputTokensPerRequest: 4_096,
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
            home, temporaryDirectory: tmp, localBaseUrl, localToken,
            localCaCertificatePath: tlsMaterial.publicCaPath,
          });
          const args = [
            path.join(root, 'scripts/competitive-review-benchmark.mjs'), 'run-verification',
            '--manifest', path.join(root, bundle.plan.publicPanel.manifestPath),
            '--cases', path.join(root, bundle.plan.publicPanel.preparedInputs.verification.path),
            '--runtime-root', path.resolve(pins.revisedRuntimeRoot),
            '--transport', pinEvidence.transportProfilesByArm.revised.transportName,
            '--max-output-tokens', '4096',
            '--case-id', cell.caseId,
            '--out', rawPath,
          ];
          const child = await runBoundedChildProcess({
            command: process.execPath,
            args,
            cwd: root,
            env: environment,
            maxWallMs: Math.max(1, cellDeadline - Date.now()),
            signal,
          });
          const proxySnapshot = proxy.snapshot();
          if (child.terminal !== 'exited' || child.reaped !== true || !fs.existsSync(rawPath)) {
            const attempts = proxySnapshot.requests.map((entry) => ({
              localAttemptOrdinal: entry.localAttemptOrdinal,
              logicalDispatchOrdinal: entry.logicalDispatchOrdinal,
              gatewayRequestIdDigests: entry.gatewayRequestIdDigest ? [entry.gatewayRequestIdDigest] : [],
            }));
            let providerAttestation = null;
            if (attempts.length) {
              attestationAttempted = true;
              try {
                const evidence = await awaitParentOperation((abortSignal) => parentBroker.attestRequests({
                  armId: 'yeti-primary-comment-verification', caseId: cell.caseId, signal: abortSignal,
                  localAttempts: attempts.map((attempt) => ({ localAttemptOrdinal: attempt.localAttemptOrdinal,
                    requestIdDigest: attempt.gatewayRequestIdDigests[0] || null })),
                }), Math.max(1, cellDeadline - Date.now()), signal, 'ws5_verification_gateway_attestation_timeout');
                providerAttestation = joinGatewayRequestAttestation(attempts, safeEvidence(evidence));
              } catch {}
            }
            row = failedVerificationCell(cell, child.terminal === 'timed_out'
              ? 'ws5_verification_cell_wall_time_cap_exceeded'
              : child.terminal === 'aborted' ? 'ws5_parent_cancelled'
                : 'ws5_verification_runtime_child_failed', attempts, providerAttestation, Date.now() - cellStart, null);
            row.callAccounting = { ...row.callAccounting,
              localHttpRequestAttempts: attempts.length,
              dispatches: proxySnapshot.dispatches || [],
              dispatchAttemptAccountingMatches: proxySnapshot.dispatchAttemptAccountingMatches === true };
          } else {
            const run = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
            const raw = assertVerificationRunIdentity(bundle, cell, run, {
              expectedRuntimeSha: pins.revisedRuntimeSha,
              expectedRuntimeTreeOid: pins.revisedRuntimeTreeOid,
              expectedHostExecution: pinEvidence.revisedRuntime.hostExecution,
              expectedTransportName: pinEvidence.transportProfilesByArm.revised.transportName,
            });
            assertLocalProxyAgainstRuntime(proxySnapshot, raw.httpAttempts || []);
            let providerAttestation = null;
            if ((raw.httpAttempts || []).length) {
              attestationAttempted = true;
              const evidence = await awaitParentOperation((abortSignal) => parentBroker.attestRequests({
                armId: 'yeti-primary-comment-verification', caseId: cell.caseId, signal: abortSignal,
                localAttempts: raw.httpAttempts.map((attempt) => ({
                  localAttemptOrdinal: attempt.localAttemptOrdinal,
                  requestIdDigest: attempt.gatewayRequestIdDigests?.[0] || null,
                })),
              }), Math.max(1, cellDeadline - Date.now()), signal, 'ws5_verification_gateway_attestation_timeout');
              providerAttestation = joinGatewayRequestAttestation(raw.httpAttempts, safeEvidence(evidence));
            }
            row = {
              ordinal: cell.ordinal,
              armId: 'yeti-primary-comment-verification',
              caseId: cell.caseId,
              status: raw.status,
              context: raw.context,
              contextQualification: raw.contextQualification,
              verdict: raw.verdict,
              reason: raw.reason,
              sourceOmissions: raw.sourceOmissions,
              adapterLimitations: raw.adapterLimitations,
              selectedTransport: raw.selectedTransport,
              usage: raw.usage,
              patchChars: raw.patchChars,
              httpAttempts: raw.httpAttempts,
              callAccounting: raw.callAccounting,
              providerAttestation,
              metrics: { totalDurationMs: raw.callAccounting?.totalDurationMs ?? null,
                groundedVerifierReceiptCalls: raw.callAccounting?.logicalCompletionDispatches ?? null },
              outcome: { terminalState: raw.status, verdict: raw.verdict },
              noAutomaticRetry: true,
              qualityScore: null,
            };
          }
        } catch (error) {
          const failureSnapshot = proxy?.snapshot() || null;
          const attempts = failureSnapshot?.requests?.map((entry) => ({
            localAttemptOrdinal: entry.localAttemptOrdinal,
            logicalDispatchOrdinal: entry.logicalDispatchOrdinal,
            gatewayRequestIdDigests: entry.gatewayRequestIdDigest ? [entry.gatewayRequestIdDigest] : [],
          })) || [];
          let providerAttestation = null;
          if (attempts.length > 0 && !attestationAttempted) {
            attestationAttempted = true;
            try {
              const evidence = await awaitParentOperation((abortSignal) => parentBroker.attestRequests({
                armId: 'yeti-primary-comment-verification', caseId: cell.caseId, signal: abortSignal,
                localAttempts: attempts.map((attempt) => ({
                  localAttemptOrdinal: attempt.localAttemptOrdinal,
                  requestIdDigest: attempt.gatewayRequestIdDigests[0] || null,
                })),
              }), Math.max(1, cellDeadline - Date.now()), signal, 'ws5_verification_gateway_attestation_timeout');
              providerAttestation = joinGatewayRequestAttestation(attempts, safeEvidence(evidence));
            } catch {}
          }
          row = failedVerificationCell(cell, safeCode(error), attempts, providerAttestation,
            Date.now() - cellStart, null);
        } finally {
          if (proxy) await proxy.close();
          tlsMaterial?.cleanup();
          fs.rmSync(scratch, { recursive: true, force: true });
        }
        const finalProxySnapshot = proxy?.snapshot();
        if (finalProxySnapshot) {
          row.callAccounting = {
            ...(row.callAccounting || {}),
            localHttpRequestAttempts: finalProxySnapshot.receivedCompletionAttempts,
            proxyIngressAttemptCount: finalProxySnapshot.receivedCompletionAttempts,
            proxyForwardedCompletionAttemptCount: finalProxySnapshot.forwardedCompletionAttempts,
            dispatches: finalProxySnapshot.dispatches || [],
            dispatchAttemptAccountingMatches: finalProxySnapshot.dispatchAttemptAccountingMatches === true,
          };
        }
        if (localTlsBoundary) row.localTransportBoundary = localTlsBoundary;
        rows.push(row);
        writeVerificationCellReceipt(output, cell, row);
      }
    }

    const allCellsCompleted = rows.length === MAX_CELL_COUNT && rows.every((row) => row.status === 'completed');
    const attemptsAccounted = rows.length === MAX_CELL_COUNT && rows.every((row) => {
      const attempts = row.httpAttempts || [];
      return attempts.length === 0 || row.providerAttestation?.status === 'verified';
    });
    let verificationAgreement = null;
    let status = 'incomplete';
    if (!preflightFailure && attemptsAccounted && allCellsCompleted && !signal.aborted
      && Date.now() - start <= MAX_PANEL_WALL_MS) {
      verificationAgreement = scoreVerificationCases(scoringCases, rows.map((row) => ({
        caseId: row.caseId,
        status: row.status,
        verdict: row.verdict,
        contextQualification: row.contextQualification,
      })));
      status = 'verification_reference_rows_scored';
    } else {
      status = preflightFailure || rows.some((row) => row.noModelDispatch === true)
        ? 'incomplete' : signal.aborted || Date.now() - start > MAX_PANEL_WALL_MS
          ? 'incomplete_interrupted_or_capped' : 'ABSTAIN_unattested';
    }
    const manifest = {
      schemaVersion: 'ReviewYetiWS5VerificationRunManifest.v1',
      status,
      planSha256: bundle.panelSha256,
      manifestSha256: bundle.manifestSha256,
      preparedInputSha256: bundle.plan.verificationPanel.preparedInputSha256,
      selectedCaseIds: cells.map((cell) => cell.caseId),
      expectedCells: cells.length,
      modelRunCells: rows.filter((row) => row.noModelDispatch !== true).length,
      providerCalls: rows.every((row) => row.noModelDispatch === true) ? 0 : null,
      incompleteCells: rows.filter((row) => row.status !== 'completed').length,
      noAutomaticRetries: true,
      maxConcurrentCells: 1,
      maxForwardedModelRequestsPerCell: 1,
      maxOutputTokensPerRequest: 4_096,
      maxCellWallMs: MAX_CASE_WALL_MS,
      maxPanelWallMs: MAX_PANEL_WALL_MS,
      panelWallMs: Date.now() - start,
      globalWallCapExceeded: Date.now() - start > MAX_PANEL_WALL_MS,
      interrupted: signal.aborted && Date.now() - start <= MAX_PANEL_WALL_MS,
      sourcePreflight: sourceEvidence ? 'verified_all_seven_public_cases' : 'not_ready',
      providerAttestation: attemptsAccounted ? 'verified_for_all_observed_local_attempts' : 'incomplete_or_unattested',
      logicalCompletionDispatches: rows.reduce((sum, row) => sum + (Number(row.callAccounting?.logicalCompletionDispatches) || 0), 0),
      localHttpRequestAttempts: rows.reduce((sum, row) => sum + (Number(row.callAccounting?.localHttpRequestAttempts) || 0), 0),
      proxyIngressAttemptCount: rows.reduce((sum, row) => sum + (Number(row.callAccounting?.proxyIngressAttemptCount) || 0), 0),
      proxyForwardedCompletionAttemptCount: rows.every((row) =>
        Number.isSafeInteger(row.callAccounting?.proxyForwardedCompletionAttemptCount))
        ? rows.reduce((sum, row) => sum + row.callAccounting.proxyForwardedCompletionAttemptCount, 0) : null,
      gatewayRelayCount: null,
      providerCompletionCount: null,
      billedRequestCount: null,
      actualCostUsd: null,
      runtimeExecutionHost: pinEvidence?.revisedRuntime?.hostExecution || null,
      transportProfilesByArm: pinEvidence?.transportProfilesByArm || null,
      verificationAgreement,
      qualityScore: null,
      cells: rows.map((row) => ({ordinal:row.ordinal,caseId:row.caseId,status:row.status,
        receiptFile:row.receiptFile,receiptSha256:row.receiptSha256,noAutomaticRetry:true})),
      ...(preflightFailure ? { preflightFailureCode: preflightFailure } : {}),
    };
    const manifestSha256 = writePrivateJson(path.join(output, 'verification-run-manifest.json'), manifest);
    const globalWallCapExceeded = Date.now() - start > MAX_PANEL_WALL_MS;
    const envelope = {
      schemaVersion: 'ReviewYetiWS5VerificationExecutionEnvelope.v1',
      status: globalWallCapExceeded ? 'incomplete_global_wall_time_cap' : manifest.status,
      maxPanelWallMs: MAX_PANEL_WALL_MS,
      panelWallMs: Date.now() - start,
      globalWallCapExceeded,
      sourceFreeze: pinEvidence?.sourceFreeze || null,
      revisedRuntime: pinEvidence?.revisedRuntime
        ? { commit: pinEvidence.revisedRuntime.commit, tree: pinEvidence.revisedRuntime.tree,
          worktreeClean: pinEvidence.revisedRuntime.worktreeClean } : null,
      runtimeExecutionHost: pinEvidence?.revisedRuntime?.hostExecution || null,
      transportProfilesByArm: pinEvidence?.transportProfilesByArm || null,
      workerImageProvenanceReference: pinEvidence?.image || null,
      workerImageExecution: 'provenance_reference_only_not_executed_by_ws5_host_runner',
      manifestSha256,
      qualityScore: null,
      actualCostUsd: null,
    };
    const envelopeSha256 = writePrivateJson(path.join(output, 'verification-execution-envelope.json'), envelope);
    return { manifest, manifestSha256, cells: rows, envelope, envelopeSha256, outputDirectory: output };
  } finally {
    clearTimeout(panelTimer);
    parentSignal?.removeEventListener('abort', relayAbort);
    credential = null;
  }
}
