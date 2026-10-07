import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as acceptance from '../../scripts/ws5-acceptance.mjs';
import * as alibaba from '../../scripts/ws5-alibaba.mjs';
import * as matrixRunner from '../../scripts/ws5-matrix-runner.mjs';
import { createWs5PublicTestFixture } from './ws5PublicTestFixtures';

let fixture: ReturnType<typeof createWs5PublicTestFixture>;
let bundle: any;
const temporaryRoots: string[] = [];

beforeAll(() => {
  fixture = createWs5PublicTestFixture(process.cwd());
  bundle = fixture.bundle;
});

afterAll(() => {
  fixture?.cleanup();
  for (const root of temporaryRoots) fs.rmSync(root, { recursive: true, force: true });
});

const sha256 = (value: Buffer | string) => crypto.createHash('sha256').update(value).digest('hex');

function temporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(directory);
  return directory;
}

function writePrivateJson(filePath: string, value: unknown): string {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.writeFileSync(filePath, bytes, { flag: 'wx', mode: 0o600 });
  return sha256(bytes);
}

function executionBindings(testBundle: any) {
  const runnerSourceCommit = '1'.repeat(40);
  const runnerSourceTree = '2'.repeat(40);
  const engineCommit = '3'.repeat(40);
  const engineTree = '4'.repeat(40);
  const imageDigest = `sha256:${'5'.repeat(64)}`;
  const hostExecution = {
    executionMode: 'host_node',
    runnerSourceCommit,
    runnerSourceTree,
    runnerSourceClean: true,
    workerImageExecution: 'provenance_reference_only_not_executed_by_ws5_host_runner',
  };
  const transportProfile = {
    status: 'ready',
    modelCalls: 0,
    requestedModel: 'pr-reviewer',
    transportName: 'unit_transport',
    productionPublishingTransport: false,
    loopbackOnly: true,
    modelConfigDefaults: { stream: true, maxTokens: 24_576, timeoutMs: 240_000 },
    runtime: { commit: engineCommit, tree: engineTree, worktreeClean: true, hostExecution },
  };
  return {
    runnerSourceRootGit: testBundle.externalDataContract?.sourceRootGit || 'unit-source-root',
    externalDataContractSha256: testBundle.externalDataContract?.sha256 || '6'.repeat(64),
    sourceFreeze: {
      pathSha256: '7'.repeat(64), headCommitSha: runnerSourceCommit, gitTreeOid: runnerSourceTree,
      sourceTreeSha256: '8'.repeat(64), allowlistDigest: '8'.repeat(64), allowlistedFileCount: 4,
    },
    revisedRuntime: { commit: engineCommit, tree: engineTree, worktreeClean: true },
    hostExecutionByArm: { baseline: hostExecution, revised: hostExecution, repeated: hostExecution },
    transportProfilesByArm: {
      baseline: transportProfile, revised: transportProfile, repeated: transportProfile,
    },
    workerImageProvenanceReference: {
      receiptSha256: '9'.repeat(64), sourceCommit: engineCommit, imageDigest,
      buildRunId: 'unit-run', provenanceSha256: 'a'.repeat(64), platform: 'linux/amd64',
      platformDigest: `sha256:${'b'.repeat(64)}`,
    },
    workerImageExecution: 'provenance_reference_only_not_executed_by_ws5_host_runner',
    hostOrchestratorSource: { commit: 'c'.repeat(40), tree: 'd'.repeat(40), worktreeClean: true },
  };
}

function priorModelReceipt(cell: any, attemptCount: number, status: 'completed' | 'incomplete') {
  const attempts = Array.from({ length: attemptCount }, (_, index) => {
    const requestIdDigest = sha256(`request-${cell.ordinal}-${index + 1}`).slice(0, 16);
    return {
      localAttemptOrdinal: index + 1,
      logicalDispatchOrdinal: index + 1,
      gatewayRequestIdDigests: [requestIdDigest],
    };
  });
  const complete = status === 'completed';
  const evidenceDigest = sha256(`provider-evidence-${cell.ordinal}`);
  return {
    armId: cell.armId,
    caseId: cell.caseId,
    status,
    outcome: { terminalState: complete ? 'failure' : 'capped_or_cancelled',
      ...(complete ? {} : { failureCode: 'ws5_cell_wall_time_cap_exceeded' }) },
    source: { sourceOmissions: [], sourceReadOmissions: [], sourceCachePreflight: { status: 'verified' } },
    coverage: { rosterValid: true, quorumSatisfied: true, fullPanelComplete: true },
    metrics: { totalTokens: 0, totalDurationMs: 20 },
    model: {
      httpAttempts: attempts,
      callAccounting: {
        localHttpRequestAttempts: attemptCount,
        logicalCompletionDispatches: complete ? attemptCount : null,
        requestProfileAttemptCount: attemptCount,
        requestAttemptAccountingMatches: complete,
        dispatchAttemptAccountingMatches: complete,
        dispatches: complete ? attempts.map((attempt) => ({
          logicalDispatchOrdinal: attempt.logicalDispatchOrdinal,
          localAttemptOrdinals: [attempt.localAttemptOrdinal],
          localHttpRequestAttempts: 1,
        })) : [],
      },
    },
    providerAttestation: complete ? {
      status: 'verified', evidenceSource: 'parent_broker_independent_telemetry', evidenceDigest,
      requests: attempts.map((attempt) => ({
        localAttemptOrdinal: attempt.localAttemptOrdinal,
        requestIdDigest: attempt.gatewayRequestIdDigests[0],
        disposition: 'provider_completed', provider: 'unit-provider', servedModel: 'unit-model',
        servedEffort: null, evidenceDigest: sha256(`request-evidence-${cell.ordinal}-${attempt.localAttemptOrdinal}`),
      })),
    } : null,
    qualityScore: null,
  };
}

function neverDispatchedReceipt(cell: any) {
  return {
    armId: cell.armId,
    caseId: cell.caseId,
    status: 'incomplete',
    outcome: { terminalState: 'capped_or_cancelled', failureCode: 'ws5_parent_cancelled' },
    model: {
      httpAttempts: [],
      callAccounting: {
        localHttpRequestAttempts: 0,
        logicalCompletionDispatches: null,
        requestProfileAttemptCount: 0,
        requestAttemptAccountingMatches: false,
        dispatchAttemptAccountingMatches: false,
        dispatches: [],
      },
    },
    noAutomaticRetry: true,
    noModelDispatch: false,
    providerAttestation: null,
    qualityScore: null,
  };
}

function readyPreflight(testBundle: any) {
  const alibabaArm = testBundle.plan.publicRunMatrix.arms.find((entry: any) => entry.id === 'alibaba-open-code-review');
  const sourceCases = testBundle.plan.publicPanel.caseIds.map((caseId: string) => {
    const sourceCase = testBundle.preparedDiscovery.cases.find((entry: any) => entry.caseId === caseId);
    const limitations = alibabaArm.nativeSourceLimitations?.[caseId] || [];
    return limitations.length > 0
      ? { caseId, status: 'source_scope_unsupported', changedFileCount: sourceCase.changedFiles.length,
        sourceCachePreflight: { status: 'verified' }, preview: { changedPathsSha256: 'e'.repeat(64),
          unsupportedExclusions: limitations, unreviewedPaths: limitations } }
      : { caseId, status: 'ready', changedFileCount: sourceCase.changedFiles.length,
        sourceCachePreflight: { status: 'verified' }, preview: { changedPathsSha256: 'e'.repeat(64) } };
  });
  return {
    status: 'ready_for_root_dispatch',
    planSha256: testBundle.panelSha256,
    manifestSha256: testBundle.manifestSha256,
    preparedInputSha256: testBundle.plan.publicPanel.preparedInputSha256,
    sourceCases: testBundle.plan.publicPanel.caseIds.map((caseId: string) => ({
      caseId, status: 'verified', sourceOmissions: [],
    })),
    alibaba: {
      status: 'READY_FOR_PROVIDER_PREFLIGHT_WITH_DECLARED_COMPARATOR_SCOPE_LIMITATION',
      providerCalls: 0,
      panelCaseIds: [...testBundle.plan.publicPanel.caseIds],
      sourceCompleteCaseCount: testBundle.plan.publicPanel.caseIds.length,
      comparatorScopeUnsupportedCaseCount: 1,
      cases: sourceCases,
    },
    provider: { status: 'ready', modelAlias: 'pr-reviewer', providerCalls: 0 },
  };
}

async function createPriorRun(testBundle: any) {
  const priorOutputDirectory = temporaryDirectory('ws5-partial-resume-prior-');
  const schedule = acceptance.createPublicRunCellPlan(testBundle.plan);
  const priorResult = await acceptance.runPublicRunCells(testBundle, {
    outputDirectory: priorOutputDirectory,
    authorizeModelDispatch: true,
    preflightPanel: async () => readyPreflight(testBundle),
    dispatchCell: async (cell: any) => {
      if (cell.ordinal === 1) return priorModelReceipt(cell, 2, 'completed');
      if (cell.ordinal === 2) return priorModelReceipt(cell, 3, 'completed');
      if (cell.ordinal === 3) return priorModelReceipt(cell, 5, 'incomplete');
      return neverDispatchedReceipt(cell);
    },
    preflightAbstention: async (cell: any) => ({
      armId: cell.armId, caseId: cell.caseId, status: 'incomplete', noModelDispatch: true,
      outcome: { terminalState: 'runner_error', failureCode: 'unit_prior_abstention_placeholder' },
      providerAttestation: null, qualityScore: null,
    }),
  });

  const bindings = executionBindings(testBundle);
  const envelope = {
    schemaVersion: 'ReviewYetiWS5MatrixExecutionEnvelope.v1',
    status: 'incomplete_global_wall_or_operator_abort',
    noAutomaticRetries: true,
    expectedCells: 28,
    modelRunCells: 27,
    maxConcurrentCells: 1,
    maxForwardedModelRequestsPerCell: 100,
    maxPreflightWallMs: 1_200_000,
    maxCellWallMs: 1_200_000,
    maxFinalizationWallMs: 300_000,
    maxPanelWallMs: 33_900_000,
    panelWallMs: 2_650_456,
    globalWallCapExceeded: false,
    interrupted: true,
    runnerSourceRootGit: bindings.runnerSourceRootGit,
    externalDataContractSha256: bindings.externalDataContractSha256,
    retainedPrivateInputCount: 7,
    scorerOracleCount: 0,
    modelChildOraclePathsExposed: false,
    sourceFreeze: bindings.sourceFreeze,
    revisedRuntime: bindings.revisedRuntime,
    hostExecutionByArm: bindings.hostExecutionByArm,
    transportProfilesByArm: bindings.transportProfilesByArm,
    workerImageProvenanceReference: bindings.workerImageProvenanceReference,
    workerImageExecution: bindings.workerImageExecution,
    runManifestSha256: priorResult.manifestSha256,
    qualityScore: null,
    providerServingEffort: 'unknown_until_per_request_attestation',
    billedRequestCount: null,
    actualCostUsd: null,
  };
  const executionEnvelopeSha256 = writePrivateJson(path.join(priorOutputDirectory, 'execution-envelope.json'), envelope);
  const records = schedule.slice(0, 3).flatMap((cell, index) => {
    const count = [2, 3, 5][index];
    return Array.from({ length: count }, (_, attemptIndex) => {
      const physicalOrdinal = [0, 2, 5][index] + attemptIndex + 1;
      return {
        armId: cell.armId,
        caseId: cell.caseId,
        physicalOrdinal,
        localAttemptOrdinal: attemptIndex + 1,
        callerRequestIdSha256: sha256(`caller-${physicalOrdinal}`),
        providerResponseRequestIdSha256: sha256(`response-${physicalOrdinal}`),
        providerResponseRequestIdDigest: sha256(`response-id-${physicalOrdinal}`).slice(0, 16),
        requestBodySha256: sha256(`body-${physicalOrdinal}`),
        requestState: 'response_received',
        gatewayHttpStatus: 200,
        exactLogStatus: physicalOrdinal <= 5 ? 'exact_row_matched' : physicalOrdinal === 6 ? 'query_failed' : 'not_attested',
        captureJoinStatus: physicalOrdinal <= 5 ? 'exact_log_linked' : 'attestation_callback_interrupted',
        provider: physicalOrdinal <= 5 ? 'unit-provider' : null,
        servedModel: physicalOrdinal <= 5 ? 'unit-model' : null,
        servedEffort: null,
        evidenceDigest: sha256(`broker-evidence-${physicalOrdinal}`),
      };
    });
  });
  const brokerEvidenceSha256 = writePrivateJson(path.join(priorOutputDirectory, 'parent-broker-attestation.json'), {
    schemaVersion: 'ReviewYetiWS5ParentBrokerEvidence.v1',
    visibility: 'private_receipt',
    source: 'parent_broker_independent_telemetry',
    capturedUpstreamAttemptCount: 10,
    preflightRequests: [{ status: 'ready', providerCalls: 0 }],
    failedExactLogQueryCount: 1,
    successfulResponseMissingRouteIdentityCount: 0,
    requests: records.slice(0, 5),
    unlinkedUpstreamAttempts: records.slice(5),
    billedCostUsd: null,
    servedEffort: 'unknown_until_per_request_attestation',
  });

  const markerDirectory = temporaryDirectory('ws5-partial-resume-marker-');
  const onceMarkerPath = path.join(markerDirectory, 'once-marker.json');
  const onceMarkerSha256 = writePrivateJson(onceMarkerPath, {
    schemaVersion: 'ReviewYetiWS5PrimaryDiscoveryOneShot.unit.v1',
    createdAt: new Date(Date.now() - 1_000).toISOString(),
    authorization: 'unit-test-approval-marker',
    hostRunnerCommit: bindings.hostExecutionByArm.revised.runnerSourceCommit,
    engineRuntimeCommit: bindings.revisedRuntime.commit,
    workerImageDigest: bindings.workerImageProvenanceReference.imageDigest,
    workerImagePlatform: bindings.workerImageProvenanceReference.platform,
    launcherSha256: 'f'.repeat(64),
    mockTestSha256: '0'.repeat(64),
    readinessSha256: '1'.repeat(64),
  });
  return {
    priorOutputDirectory, priorResult, envelope, executionEnvelopeSha256,
    brokerEvidenceSha256, onceMarkerPath, onceMarkerSha256, bindings,
  };
}

function resumeOptions(parent: any, outputDirectory: string) {
  return {
    outputDirectory,
    priorOutputDirectory: parent.priorOutputDirectory,
    expectedPriorRun: {
      runManifestSha256: parent.priorResult.manifestSha256,
      executionEnvelopeSha256: parent.executionEnvelopeSha256,
      brokerEvidenceSha256: parent.brokerEvidenceSha256,
    },
    onceMarkerPath: parent.onceMarkerPath,
    expectedOnceMarkerSha256: parent.onceMarkerSha256,
    currentExecutionBindings: parent.bindings,
    expectedConsumedOrdinals: [1, 2, 3],
    expectedNeverDispatchedOrdinals: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
      16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28],
    expectedPriorPhysicalRequestAttempts: 10,
    maxPanelWallMs: 33_900_000,
    maxPreflightWallMs: 1_200_000,
    maxCellWallMs: 1_200_000,
    maxFinalizationWallMs: 300_000,
    maxForwardedModelRequestsPerCell: 100,
    authorizeModelDispatch: true,
  };
}

describe('WS5 partial-resume contract', () => {
  it('keeps prior receipts immutable, skips consumed cells, and runs only never-dispatched cells plus the no-model abstention', async () => {
    const parent = await createPriorRun(bundle);
    const outputParent = temporaryDirectory('ws5-partial-resume-child-');
    const outputDirectory = path.join(outputParent, 'child');
    const priorManifestBytes = fs.readFileSync(path.join(parent.priorOutputDirectory, 'run-manifest.json'));
    const dispatchOrdinals: number[] = [];
    const abstentionOrdinals: number[] = [];
    let preflightCalls = 0;

    const { outputDirectory: resumeOutputDirectory, authorizeModelDispatch, ...resumeDescriptor } = resumeOptions(parent, outputDirectory);
    const resumeApi = (matrixRunner as any).runWs5PublicRunCells;
    expect(typeof resumeApi).toBe('function');
    const result = await resumeApi(bundle, {
      outputDirectory: resumeOutputDirectory,
      authorizeModelDispatch,
      preflightPanel: async () => {
        preflightCalls += 1;
        return readyPreflight(bundle);
      },
      dispatchCell: async (cell: any) => {
        dispatchOrdinals.push(cell.ordinal);
        return {
          armId: cell.armId, caseId: cell.caseId, status: 'incomplete',
          outcome: { terminalState: 'capped_or_cancelled', failureCode: 'unit_resume_cell_incomplete' },
          model: {
            httpAttempts: [{ localAttemptOrdinal: 1, logicalDispatchOrdinal: 1,
              gatewayRequestIdDigests: [sha256(`resume-${cell.ordinal}`).slice(0, 16)] }],
            callAccounting: {
              localHttpRequestAttempts: 1, logicalCompletionDispatches: 1, requestProfileAttemptCount: 1,
              requestAttemptAccountingMatches: true, dispatchAttemptAccountingMatches: true,
              dispatches: [{ logicalDispatchOrdinal: 1, localAttemptOrdinals: [1], localHttpRequestAttempts: 1 }],
            },
          },
          providerAttestation: null, qualityScore: null,
        };
      },
      preflightAbstention: async (cell: any, preflight: any) => {
        abstentionOrdinals.push(cell.ordinal);
        return alibaba.buildAlibabaSourceScopeAbstention(bundle, preflight, cell.caseId);
      },
      resume: resumeDescriptor,
    });

    expect(dispatchOrdinals).toEqual([
      4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
      16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28,
    ]);
    expect(abstentionOrdinals).toEqual([15]);
    expect(preflightCalls).toBe(1);
    expect(fs.readFileSync(path.join(parent.priorOutputDirectory, 'run-manifest.json'))).toEqual(priorManifestBytes);
    expect(result.manifest.qualityScore).toBeNull();
    expect(result.manifest.localHttpRequestAttempts).toBeNull();
    expect(result.resumeManifest).toMatchObject({
      schemaVersion: 'ReviewYetiWS5PartialResumeManifest.v1',
      qualityScore: null,
    });
    expect(result.resumeManifest.selection).toMatchObject({
      consumedOrdinals: [1, 2, 3],
      candidateOrdinals: [
        4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
        16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28,
      ],
      newlyDispatchedOrdinals: [
        4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
        16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28,
      ],
      zeroAttemptCandidateOrdinals: [],
      adapterInvokedOrdinals: [
        4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
        16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28,
      ],
      abstentionOrdinals: [15],
    });
    expect(result.resumeManifest.physicalAccounting).toMatchObject({
      priorPhysicalRequestAttempts: 10,
      newPhysicalRequestAttempts: 24,
      cumulativePhysicalRequestAttempts: 34,
      maximumCombinedPhysicalRequestAttempts: 2_700,
      remainingGlobalAttemptCeiling: 2_690,
      maximumNewAttemptsFromCellLimits: 2_400,
    });
    const marker = JSON.parse(fs.readFileSync(parent.onceMarkerPath, 'utf8'));
    expect(result.resumeManifest.resourceCaps).toMatchObject({
      originalStartedAt: marker.createdAt,
      absoluteDeadlineAt: new Date(Date.parse(marker.createdAt) + 33_900_000).toISOString(),
      maxPanelWallMs: 33_900_000,
      maxCellWallMs: 1_200_000,
    });
    expect(result.resumeManifest.sourceRoles).toMatchObject({
      hostOrchestrator: { role: 'host_orchestrator', sourceClean: true },
      frozenBenchmarkSource: { role: 'frozen_benchmark_source' },
      engineRuntime: { role: 'engine_runtime', commit: parent.bindings.revisedRuntime.commit },
      workerImage: { role: 'worker_image_provenance_reference_only', digest: parent.bindings.workerImageProvenanceReference.imageDigest,
        executedByHostRunner: false },
    });
    expect(result.resumeManifest.parent.artifactFiles).toHaveLength(31);
    expect(result.resumeManifest.parent.brokerEvidenceSummary).toEqual({
      capturedUpstreamAttemptCount: 10,
      matchedExactLogRows: 5,
      failedExactLogQueryCount: 1,
      unlinkedAttemptCount: 5,
      responseReceivedCount: 10,
      http200ResponseCount: 10,
      providerIdentityUnknownCount: 5,
      successfulResponseMissingRouteIdentityCount: 0,
    });
    for (const artifact of result.resumeManifest.parent.artifactFiles) {
      expect(sha256(fs.readFileSync(path.join(outputDirectory, 'prior', artifact.name)))).toBe(artifact.sha256);
      expect(fs.statSync(path.join(outputDirectory, 'prior', artifact.name)).mode & 0o077).toBe(0);
    }
    expect(result.manifest.cells).toHaveLength(28);
    expect(result.manifest.cells[0].receiptSha256).toBe(parent.priorResult.manifest.cells[0].receiptSha256);
    expect(result.manifest.cells[2].receiptSha256).toBe(parent.priorResult.manifest.cells[2].receiptSha256);
    expect(result.cells[14].runnerFailureCode).toBeUndefined();
    expect(result.manifest.cells[14]).toMatchObject({ status: 'source_scope_unsupported', noModelDispatch: true });
    expect(result.cells[14].model.httpAttempts).toEqual([]);
    expect(result.cells[14].model.callAccounting).toMatchObject({
      logicalCompletionDispatches: 0,
      localHttpRequestAttempts: 0,
      requestAttemptAccountingMatches: true,
      dispatchAttemptAccountingMatches: true,
    });
    expect(result.cells[14].providerAttestation).toBeNull();
    expect(fs.statSync(outputDirectory).mode & 0o777).toBe(0o700);
    expect(fs.readFileSync(path.join(outputDirectory, 'resume-manifest.json'), 'utf8'))
      .not.toContain('unit-test-approval-marker');
  });

  it('rejects a changed prior receipt before preflight or any resumed dispatch', async () => {
    const parent = await createPriorRun(bundle);
    const firstCell = parent.priorResult.manifest.cells[0];
    fs.appendFileSync(path.join(parent.priorOutputDirectory, firstCell.receiptFile), ' ');
    const outputParent = temporaryDirectory('ws5-partial-resume-tamper-');
    let preflightCalls = 0;
    let dispatchCalls = 0;

    const resumeApi = (acceptance as any).resumePublicRunCells;
    expect(typeof resumeApi).toBe('function');
    await expect(resumeApi(bundle, {
      ...resumeOptions(parent, path.join(outputParent, 'child')),
      preflightPanel: async () => { preflightCalls += 1; return {}; },
      dispatchCell: async () => { dispatchCalls += 1; return {}; },
      preflightAbstention: async () => ({}),
    })).rejects.toThrow('ws5_resume_prior_receipt_digest_mismatch');
    expect(preflightCalls).toBe(0);
    expect(dispatchCalls).toBe(0);
  });

  it('rejects duplicate broker request ids and incompatible runtime bindings before preflight', async () => {
    const parent = await createPriorRun(bundle);
    const brokerPath = path.join(parent.priorOutputDirectory, 'parent-broker-attestation.json');
    const evidence = JSON.parse(fs.readFileSync(brokerPath, 'utf8'));
    evidence.requests[1].callerRequestIdSha256 = evidence.requests[0].callerRequestIdSha256;
    const duplicateBytes = Buffer.from(JSON.stringify(evidence, null, 2) + '\n', 'utf8');
    fs.writeFileSync(brokerPath, duplicateBytes);
    parent.brokerEvidenceSha256 = sha256(duplicateBytes);
    const outputParent = temporaryDirectory('ws5-partial-resume-duplicate-');
    let preflightCalls = 0;
    let dispatchCalls = 0;
    const resumeApi = (acceptance as any).resumePublicRunCells;

    await expect(resumeApi(bundle, {
      ...resumeOptions(parent, path.join(outputParent, 'child')),
      preflightPanel: async () => { preflightCalls += 1; return readyPreflight(bundle); },
      dispatchCell: async () => { dispatchCalls += 1; return {}; },
      preflightAbstention: async () => ({}),
    })).rejects.toThrow('ws5_resume_parent_broker_duplicate_request_id');
    expect(preflightCalls).toBe(0);
    expect(dispatchCalls).toBe(0);

    const incompatibleParent = await createPriorRun(bundle);
    const incompatibleBindings = {
      ...incompatibleParent.bindings,
      transportProfilesByArm: {
        ...incompatibleParent.bindings.transportProfilesByArm,
        revised: { ...incompatibleParent.bindings.transportProfilesByArm.revised, requestedModel: 'other-model' },
      },
    };
    const incompatibleOutput = temporaryDirectory('ws5-partial-resume-profile-');
    await expect(resumeApi(bundle, {
      ...resumeOptions(incompatibleParent, path.join(incompatibleOutput, 'child')),
      currentExecutionBindings: incompatibleBindings,
      preflightPanel: async () => { preflightCalls += 1; return readyPreflight(bundle); },
      dispatchCell: async () => { dispatchCalls += 1; return {}; },
      preflightAbstention: async () => ({}),
    })).rejects.toThrow('ws5_resume_execution_binding_mismatch');
    expect(preflightCalls).toBe(0);
    expect(dispatchCalls).toBe(0);
  });

  it('rejects a changed current source-case snapshot before resumed dispatch', async () => {
    const parent = await createPriorRun(bundle);
    const outputParent = temporaryDirectory('ws5-partial-resume-source-change-');
    let preflightCalls = 0;
    let dispatchCalls = 0;
    await expect((acceptance as any).resumePublicRunCells(bundle, {
      ...resumeOptions(parent, path.join(outputParent, 'child')),
      preflightPanel: async () => {
        preflightCalls += 1;
        const changed = readyPreflight(bundle);
        changed.alibaba.cases[0].preview.changedPathsSha256 = 'f'.repeat(64);
        return changed;
      },
      dispatchCell: async () => { dispatchCalls += 1; return {}; },
      preflightAbstention: async () => ({}),
    })).rejects.toThrow('ws5_resume_preflight_binding_mismatch');
    expect(preflightCalls).toBe(1);
    expect(dispatchCalls).toBe(0);
  });

  it('uses the once-marker deadline and refuses an expired continuation before preflight', async () => {
    const parent = await createPriorRun(bundle);
    const expiredMarkerDirectory = temporaryDirectory('ws5-partial-resume-expired-marker-');
    const expiredMarkerPath = path.join(expiredMarkerDirectory, 'once-marker.json');
    const expiredMarkerSha256 = writePrivateJson(expiredMarkerPath, {
      schemaVersion: 'ReviewYetiWS5PrimaryDiscoveryOneShot.unit.v1',
      createdAt: new Date(Date.now() - 33_900_001).toISOString(),
      authorization: 'unit-test-expired-marker',
      hostRunnerCommit: parent.bindings.hostExecutionByArm.revised.runnerSourceCommit,
      engineRuntimeCommit: parent.bindings.revisedRuntime.commit,
      workerImageDigest: parent.bindings.workerImageProvenanceReference.imageDigest,
      workerImagePlatform: parent.bindings.workerImageProvenanceReference.platform,
      launcherSha256: 'f'.repeat(64), mockTestSha256: '0'.repeat(64), readinessSha256: '1'.repeat(64),
    });
    let preflightCalls = 0;
    let dispatchCalls = 0;
    const outputParent = temporaryDirectory('ws5-partial-resume-expired-');
    await expect((acceptance as any).resumePublicRunCells(bundle, {
      ...resumeOptions(parent, path.join(outputParent, 'child')),
      onceMarkerPath: expiredMarkerPath,
      expectedOnceMarkerSha256: expiredMarkerSha256,
      preflightPanel: async () => { preflightCalls += 1; return readyPreflight(bundle); },
      dispatchCell: async () => { dispatchCalls += 1; return {}; },
      preflightAbstention: async () => ({}),
    })).rejects.toThrow('ws5_resume_absolute_deadline_exceeded');
    expect(preflightCalls).toBe(0);
    expect(dispatchCalls).toBe(0);
  });

  it('refuses parent receipts with group or world permissions', async () => {
    const parent = await createPriorRun(bundle);
    const receiptFile = parent.priorResult.manifest.cells[0].receiptFile;
    fs.chmodSync(path.join(parent.priorOutputDirectory, receiptFile), 0o644);
    const outputParent = temporaryDirectory('ws5-partial-resume-public-file-');
    let preflightCalls = 0;
    let dispatchCalls = 0;
    await expect((acceptance as any).resumePublicRunCells(bundle, {
      ...resumeOptions(parent, path.join(outputParent, 'child')),
      preflightPanel: async () => { preflightCalls += 1; return readyPreflight(bundle); },
      dispatchCell: async () => { dispatchCalls += 1; return {}; },
      preflightAbstention: async () => ({}),
    })).rejects.toThrow('ws5_resume_prior_receipt_invalid');
    expect(preflightCalls).toBe(0);
    expect(dispatchCalls).toBe(0);
  });

  it('rejects a prior run reached through an ancestor symlink into protected data', async () => {
    const parent = await createPriorRun(bundle);
    const protectedTree = path.join(bundle.dataRootPath, `ws5-resume-symlink-${crypto.randomUUID()}`);
    const protectedPrior = path.join(protectedTree, 'prior');
    fs.mkdirSync(protectedTree, { recursive: true, mode: 0o700 });
    fs.cpSync(parent.priorOutputDirectory, protectedPrior, { recursive: true });
    fs.chmodSync(protectedTree, 0o700);
    fs.chmodSync(protectedPrior, 0o700);
    for (const fileName of fs.readdirSync(protectedPrior)) {
      fs.chmodSync(path.join(protectedPrior, fileName), 0o600);
    }

    const symlinkParent = temporaryDirectory('ws5-partial-resume-symlink-');
    const outsideAlias = path.join(symlinkParent, 'alias');
    fs.symlinkSync(protectedTree, outsideAlias, 'dir');
    const outputParent = temporaryDirectory('ws5-partial-resume-symlink-output-');
    let preflightCalls = 0;
    let dispatchCalls = 0;

    await expect((acceptance as any).resumePublicRunCells(bundle, {
      ...resumeOptions(parent, path.join(outputParent, 'child')),
      priorOutputDirectory: path.join(outsideAlias, 'prior'),
      preflightPanel: async () => { preflightCalls += 1; return readyPreflight(bundle); },
      dispatchCell: async (cell: any) => { dispatchCalls += 1; return neverDispatchedReceipt(cell); },
      preflightAbstention: async () => ({}),
    })).rejects.toThrow('ws5_resume_prior_directory_inside_protected_root');
    expect(preflightCalls).toBe(0);
    expect(dispatchCalls).toBe(0);
  });
});
