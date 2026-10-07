import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { canonicalJson } from '../../src/review/reviewCore';
import { GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION } from '../../src/review/groundedEvidenceV2';
import {
  NORMAL_ENGINE_QUALIFICATION_CONFIG_VARIANT,
  NORMAL_ENGINE_QUALIFICATION_PLAN_DESCRIPTOR_SHA256,
  NORMAL_ENGINE_QUALIFICATION_PLAN_ID,
  NORMAL_ENGINE_QUALIFICATION_STORE_ROOT,
  assertNormalEngineQualificationPlanReceipt,
  assertNormalEngineQualificationReceipt,
  buildNormalEngineQualificationSourceInput,
  normalEngineQualificationComposedResourcesRelativePath,
  parseNormalEngineQualificationPlanRequest,
  parseNormalEngineQualificationRequest,
  persistNormalEngineQualificationComposedResources,
  persistNormalEngineQualificationProviderIdentifiers,
  persistNormalEngineQualificationReceipt,
  type NormalEngineQualificationPlanReceipt,
  type NormalEngineQualificationReceipt,
} from '../../src/qualification/normalEngineQualification';
import { NormalEngineQualificationHistoryStore, type NormalEngineQualificationHistoryBinding,
  type NormalEngineQualificationHistoryState } from '../../src/qualification/normalEngineQualificationHistory';
import { parseNormalEngineQualificationPlanDescriptor, persistNormalEngineQualificationProviderCapture }
  from '../../src/qualification/normalEngineQualificationWorker';
import { NormalEngineQualificationProviderAttestor, normalEngineQualificationProviderCaptureRelativePath,
  type NormalEngineProviderCaptureBinding }
  from '../../src/qualification/normalEngineQualificationProvider';
import {
  NORMAL_ENGINE_QUALIFICATION_CAPTURE_ACK_PATH,
  normalEngineQualificationCaptureAckV1Schema,
  normalEngineQualificationCaptureReadyV1Schema,
  normalEngineQualificationCaptureOutcomeV1Schema,
  normalEngineQualificationCaptureArtifactSource,
  persistNormalEngineQualificationCaptureOutcome,
  waitForNormalEngineQualificationCapture,
  writeNormalEngineQualificationCaptureReady,
} from '../../src/qualification/normalEngineQualificationCapture';

const digest = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const PLAN_RUN_ID = 'nq_0123456789abcdef0123456789abcdef';
const SOURCE_CASE_ID = 'ws5-sequence-a-v1';
const REPAIR_CASE_ID = 'ws5-sequence-b-v1';
const HISTORY_SEQUENCE_ID = 'ws5-repair-sequence-v1';
const SELECTED_FINGERPRINT = `fp1_${'a'.repeat(24)}`;
const SELECTED_PATH = 'src/qualification.ts';
const HISTORY_EVENT_ID = '223e4567-e89b-12d3-a456-426614174000';
const HISTORY_FINDING_ID = '323e4567-e89b-12d3-a456-426614174000';
const HISTORY_SNAPSHOT_ID = '123e4567-e89b-12d3-a456-426614174000';
const HISTORY_EVIDENCE_DIGEST = 'd'.repeat(64);

const VALID_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  REVIEW_NORMAL_ENGINE_QUALIFICATION_ONLY: 'true',
  REVIEW_NORMAL_ENGINE_QUALIFICATION_RUN_ID: PLAN_RUN_ID,
  REVIEW_NORMAL_ENGINE_QUALIFICATION_CASE_ID: 'lc_0d8f4a7c2b9e41f8',
  REVIEW_NORMAL_ENGINE_QUALIFICATION_ARM: 'single',
  REVIEW_PUBLICATION_MODE: 'disabled',
  REVIEW_RECEIPT_PATH: '/workspace/.review-yeti/normal-engine-qualification.json',
  REVIEW_POLICY_DIGEST: 'a'.repeat(64),
  REVIEW_CONFIG_DIGEST: 'b'.repeat(64),
  REVIEW_PREPARED_CONFIG_JSON: '{"version":"PreparedReviewExecution.v1"}',
  REVIEW_NORMAL_ENGINE_QUALIFICATION_SOURCE_REVISION: 'c'.repeat(40),
  REVIEW_NORMAL_ENGINE_QUALIFICATION_WORKER_IMAGE_DIGEST: `sha256:${'d'.repeat(64)}`,
  REVIEW_NORMAL_ENGINE_QUALIFICATION_RUNTIME_MANIFEST_SHA256: 'e'.repeat(64),
  REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_TARGET: 'synthetic/policy-target',
  REVIEW_NORMAL_ENGINE_QUALIFICATION_SELECTION_PURPOSE: 'qualification-only-target-binding',
  REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_REPOSITORY_ID: '73099',
  REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_OWNER: 'synthetic',
  REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_REPO: 'policy-target',
  REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_REF: 'a'.repeat(40),
  REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_PATH: 'policy/review-yeti.json',
  REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_SHA256: 'b'.repeat(64),
};

function relativeArtifact(root: string, path: string): string {
  return relative(root, path).split(/[\\/]/u).join('/');
}

function checksumSibling(path: string): string {
  return path.replace(/\.json$/u, '.sha256');
}

function requestEnvironment(
  step: ReturnType<typeof parseNormalEngineQualificationPlanDescriptor>['steps'][number],
  runId: string,
  sourceRunId: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...VALID_ENV,
    REVIEW_NORMAL_ENGINE_QUALIFICATION_PLAN: '',
    REVIEW_NORMAL_ENGINE_QUALIFICATION_CAPTURE_HOLD: '',
    REVIEW_NORMAL_ENGINE_QUALIFICATION_CONFIG_VARIANT: NORMAL_ENGINE_QUALIFICATION_CONFIG_VARIANT,
    REVIEW_NORMAL_ENGINE_QUALIFICATION_RUN_ID: runId,
    REVIEW_NORMAL_ENGINE_QUALIFICATION_CASE_ID: step.caseId,
    REVIEW_NORMAL_ENGINE_QUALIFICATION_ARM: step.arm,
  };
  if (['repair-head-history', 'repair-head-repeat', 'repair-head-history-unavailable',
    'repair-head-verifier-unavailable', 'adjudicator-recheck'].includes(step.arm)) {
    env.REVIEW_NORMAL_ENGINE_QUALIFICATION_HISTORY_RUN_ID = sourceRunId;
  } else {
    delete env.REVIEW_NORMAL_ENGINE_QUALIFICATION_HISTORY_RUN_ID;
  }
  return env;
}

function providerCaptureBinding(request: ReturnType<typeof parseNormalEngineQualificationRequest>, diffSha256: string): NormalEngineProviderCaptureBinding {
  return {
    runId: request.runId,
    phase: request.phase,
    caseId: request.fixture.caseId,
    runtime: request.runtime,
    target: {
      kind: 'public-synthetic-fixture' as const,
      repositoryId: request.fixture.repository.repositoryId,
      repository: `${request.fixture.repository.owner}/${request.fixture.repository.repo}`,
      prNumber: request.fixture.prNumber,
      caseId: request.fixture.caseId,
      bundleVersion: request.fixture.bundleVersion,
      bundleSha256: request.fixture.bundleSha256,
      inputSha256: request.fixture.inputSha256,
      baseSha: request.fixture.baseSha,
      headSha: request.fixture.headSha,
      diffSha256,
    },
    policy: {
      targetRepository: request.policy.targetRepository,
      selectionPurpose: request.policy.selectionPurpose,
      configurationVariant: request.configurationVariant,
      source: {
        repositoryId: request.policy.sourceRepositoryId,
        owner: request.policy.sourceOwner,
        repo: request.policy.sourceRepo,
        ref: request.policy.sourceRef,
        path: request.policy.sourcePath,
        contentSha256: request.policy.sourceContentSha256,
      },
      effectivePolicyDigest: request.policy.policyDigest,
      effectiveConfigDigest: request.policy.configDigest,
    },
    groundedEvidenceSemanticsVersion: GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION,
  };
}

function composedResourcesFor(request: ReturnType<typeof parseNormalEngineQualificationRequest>) {
  const emptyDigest = digest(canonicalJson([]));
  return {
    version: 'ComposedRuntimeResources.v1',
    stage: 'worker_completion',
    discoveryScope: 'composed_engine',
    evidenceSemanticsVersion: GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION,
    engineExecutionState: 'complete',
    configDigest: { value: request.policy.configDigest, unavailableReason: null },
    configuration: { value: null, unavailableReason: 'local capture test stores only the effective configuration digest' },
    budget: { configuredTotalTurns: 0, investigationTurns: 0, verificationReserveTurns: 0 },
    usage: {
      totalTurns: 0, planningTurns: 0, discoveryTurns: 0, taskFinalizationTurns: 0,
      taskFinalizationReservedTurns: 0, verifierCalls: { value: 0, unavailableReason: null },
      clientCallsStarted: 0, clientResponsesReceived: 0, settledClientCalls: 0, clientCallsUnsettled: 0,
      settledClientCallElapsedMs: 0, gatewayAcceptedCalls: null,
      gatewayAcceptedCallsUnavailableReason: 'not exposed by the local resource fixture',
      providerCompletions: null, providerCompletionsUnavailableReason: 'not exposed by the local resource fixture',
      engineElapsedMonotonicMs: 0,
    },
    tasks: { planned: [], started: [], completed: [], blocked: [], failed: [], interrupted: [], pending: [], inProgress: [] },
    coverage: {
      assignedPaths: { count: 0, sha256: emptyDigest },
      investigatedPaths: { count: 0, sha256: emptyDigest },
      remainingPaths: { count: 0, sha256: emptyDigest },
      regions: { state: 'unavailable', reason: 'empty synthetic Plan fixture' },
    },
  };
}

function historyStateFor(
  sourceRequest: ReturnType<typeof parseNormalEngineQualificationRequest>,
  repairRequest: ReturnType<typeof parseNormalEngineQualificationRequest>,
): NormalEngineQualificationHistoryState {
  const contextDigest = 'f'.repeat(64);
  const workerRunId = `run_${sourceRequest.runId.slice(3)}`;
  const event = {
    eventId: HISTORY_EVENT_ID,
    eventType: 'finding-observed',
    runId: workerRunId,
    executionAttempt: 1,
    evidenceSemanticsVersion: GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION,
    headSha: sourceRequest.fixture.headSha,
    baseSha: sourceRequest.fixture.baseSha,
    policyDigest: sourceRequest.policy.policyDigest,
    configDigest: sourceRequest.policy.configDigest,
    contextDigest,
    evidenceDigest: HISTORY_EVIDENCE_DIGEST,
    verificationStatus: 'confirmed' as const,
    verification: {
      findingEventId: HISTORY_FINDING_ID,
      fingerprint: SELECTED_FINGERPRINT,
      status: 'confirmed' as const,
      currentAffectedContextDigest: contextDigest,
    },
  };
  const finding = {
    findingEventId: HISTORY_FINDING_ID,
    fingerprint: SELECTED_FINGERPRINT,
    path: SELECTED_PATH,
    regionStart: 3,
    regionEnd: 3,
    firstSeenHead: sourceRequest.fixture.headSha,
    lastSeenHead: sourceRequest.fixture.headSha,
    affectedContextDigest: contextDigest,
    sourceSeverity: 'P1',
    effectiveSeverity: 'P1',
    disposition: 'open',
    blocking: true,
    verificationStatus: 'confirmed' as const,
    evidenceDigest: HISTORY_EVIDENCE_DIGEST,
  };
  const events = [event];
  const findings = [finding];
  return {
    schemaVersion: 'ReviewYetiNormalQualificationHistory.v2',
    purpose: 'normal-engine-qualification-history',
    evidenceSemanticsVersion: GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION,
    configurationVariant: NORMAL_ENGINE_QUALIFICATION_CONFIG_VARIANT,
    executionAttempt: 1,
    disputedBlockerAdjudicator: {
      state: 'available', modelAlias: 'bifrost/qualification-adjudicator', reasoningEffort: 'high',
    },
    adjudicatorRecheckTarget: {
      path: SELECTED_PATH, findingFingerprint: SELECTED_FINGERPRINT,
      priorFindingEventId: HISTORY_FINDING_ID, priorEvidenceDigest: HISTORY_EVIDENCE_DIGEST,
    },
    runId: sourceRequest.runId,
    sequenceId: HISTORY_SEQUENCE_ID,
    caseId: SOURCE_CASE_ID,
    bundleSha256: sourceRequest.fixture.bundleSha256,
    inputSha256: sourceRequest.fixture.inputSha256,
    repairCaseId: REPAIR_CASE_ID,
    repairInputSha256: repairRequest.fixture.inputSha256,
    repairBaseSha: repairRequest.fixture.baseSha,
    repairHeadSha: repairRequest.fixture.headSha,
    repositoryId: sourceRequest.fixture.repository.repositoryId,
    repository: `${sourceRequest.fixture.repository.owner}/${sourceRequest.fixture.repository.repo}`,
    baseSha: sourceRequest.fixture.baseSha,
    headSha: sourceRequest.fixture.headSha,
    policyDigest: sourceRequest.policy.policyDigest,
    configDigest: sourceRequest.policy.configDigest,
    workerCompletionSha256: '6'.repeat(64),
    canonicalEvidenceSha256: '7'.repeat(64),
    gateDecisionSha256: '8'.repeat(64),
    historyLoad: {
      status: 'complete',
      snapshotId: HISTORY_SNAPSHOT_ID,
      contextDigest,
      events,
      findings,
      eventCount: 1,
      findingCount: 1,
      loadedEventCount: 1,
      loadedFindingCount: 1,
      eventOmittedCount: 0,
      findingOmittedCount: 0,
      legacyOmittedCount: 0,
      eventsDigest: digest(canonicalJson(events.map((row) => row.eventId))),
      findingsDigest: digest(canonicalJson(findings.map((row) => row.findingEventId))),
      omissions: [],
    },
  };
}

function historyBindingFor(
  sourceRequest: ReturnType<typeof parseNormalEngineQualificationRequest>,
  repairRequest: ReturnType<typeof parseNormalEngineQualificationRequest>,
): NormalEngineQualificationHistoryBinding {
  const sameHead = repairRequest.arm === 'adjudicator-recheck';
  return {
    runId: sourceRequest.runId,
    repairRunId: repairRequest.runId,
    sequenceId: HISTORY_SEQUENCE_ID,
    sourceCaseId: SOURCE_CASE_ID,
    repairCaseId: sameHead ? SOURCE_CASE_ID : REPAIR_CASE_ID,
    bundleSha256: sourceRequest.fixture.bundleSha256,
    sourceInputSha256: sourceRequest.fixture.inputSha256,
    repairInputSha256: sameHead ? sourceRequest.fixture.inputSha256 : repairRequest.fixture.inputSha256,
    repositoryId: sourceRequest.fixture.repository.repositoryId,
    repository: `${sourceRequest.fixture.repository.owner}/${sourceRequest.fixture.repository.repo}`,
    currentBaseSha: repairRequest.fixture.baseSha,
    currentHeadSha: repairRequest.fixture.headSha,
    policyDigest: repairRequest.policy.policyDigest,
    configDigest: repairRequest.policy.configDigest,
    mode: sameHead ? 'same-head-recheck' : 'repair-head',
    currentInputSha256: repairRequest.fixture.inputSha256,
  };
}

function receiptForPlanCase(input: {
  env: NodeJS.ProcessEnv;
  budgetProfile: ReturnType<typeof parseNormalEngineQualificationPlanDescriptor>['steps'][number]['budgetProfile'];
  request: ReturnType<typeof parseNormalEngineQualificationRequest>;
  diffSha256: string;
  capture: { path: string; sha256: string };
  resources: { path: string; sha256: string };
  privateIdentifiersSha256: string | null;
  calls: NormalEngineQualificationReceipt['provider']['calls'];
}): NormalEngineQualificationReceipt {
  const request = input.request;
  const completeHistory = Boolean(request.historyRunId) && request.arm !== 'repair-head-history-unavailable';
  const emptyHistory = ['p2-only', 'large-crossfile', 'provider-failure', 'resource-exhaustion',
    'repair-head-empty-history'].includes(request.arm);
  const control = request.arm === 'repair-head-empty-history' ? 'empty-history-ablation'
    : request.arm === 'repair-head-history-unavailable' ? 'history-unavailable'
      : request.arm === 'repair-head-verifier-unavailable' ? 'grounded-verifier-unavailable'
        : request.arm === 'adjudicator-recheck' ? 'authenticated-adjudicator-recheck'
          : request.arm === 'provider-failure' ? 'bifrost-auth-rejection-invalid-inference-key'
            : request.arm === 'resource-exhaustion' ? 'worker-deadline-test-60s-one-physical-request' : 'none';
  const panelBudgetSeconds = input.budgetProfile === 'normal-canary-120s' ? 120
    : input.budgetProfile === 'large-crossfile-canary-300s' ? 300
      : input.budgetProfile === 'bifrost-auth-rejection-30s-one-request' ? 30
        : input.budgetProfile === 'resource-exhaustion-60s-one-request' ? 60 : null;
  const historySelection = request.arm === 'adjudicator-recheck' ? {
    findingFingerprint: SELECTED_FINGERPRINT,
    path: SELECTED_PATH,
    priorFindingEventIdSha256: digest(HISTORY_FINDING_ID),
    priorEvidenceDigest: HISTORY_EVIDENCE_DIGEST,
  } : null;
  const disputedBlockerAdjudicator = request.configurationVariant === NORMAL_ENGINE_QUALIFICATION_CONFIG_VARIANT
    ? { state: 'available' as const, modelAlias: 'bifrost/qualification-adjudicator', reasoningEffort: 'high' as const }
    : { state: 'unconfigured' as const, modelAlias: null, reasoningEffort: null };
  const target = {
    kind: 'public-synthetic-fixture' as const,
    repositoryId: request.fixture.repository.repositoryId,
    repository: `${request.fixture.repository.owner}/${request.fixture.repository.repo}`,
    prNumber: request.fixture.prNumber,
    caseId: request.fixture.caseId,
    bundleVersion: request.fixture.bundleVersion,
    bundleSha256: request.fixture.bundleSha256,
    inputSha256: request.fixture.inputSha256,
    baseSha: request.fixture.baseSha,
    headSha: request.fixture.headSha,
    diffSha256: input.diffSha256,
  };
  return assertNormalEngineQualificationReceipt({
    schemaVersion: 'ReviewYetiNormalQualification.v1',
    purpose: 'normal-engine-qualification',
    runId: request.runId,
    arm: request.arm,
    phase: request.phase,
    target,
    runtime: request.runtime,
    policy: {
      targetRepository: request.policy.targetRepository,
      selectionPurpose: request.policy.selectionPurpose,
      configurationVariant: request.configurationVariant,
      source: {
        repositoryId: request.policy.sourceRepositoryId,
        owner: request.policy.sourceOwner,
        repo: request.policy.sourceRepo,
        ref: request.policy.sourceRef,
        path: request.policy.sourcePath,
        contentSha256: request.policy.sourceContentSha256,
      },
      effectivePolicyDigest: request.policy.policyDigest,
      effectiveConfigDigest: request.policy.configDigest,
      groundedEvidenceSemanticsVersion: GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION,
      disputedBlockerAdjudicator,
      engine: 'composed',
      severityPolicy: 'review-yeti-severity.v2',
    },
    history: {
      purpose: 'normal-engine-qualification-history',
      source: completeHistory ? 'isolated-qualification-store'
        : request.arm === 'repair-head-history-unavailable' ? 'unavailable'
          : emptyHistory ? request.arm === 'repair-head-empty-history' ? 'empty-qualification-ablation' : 'empty-qualification-context'
            : 'unavailable',
      loadStatus: completeHistory || emptyHistory ? 'complete' : 'unavailable',
      snapshotIdSha256: completeHistory || emptyHistory ? digest(HISTORY_SNAPSHOT_ID) : null,
      contextDigest: completeHistory || emptyHistory ? 'f'.repeat(64) : null,
      parentRunIdSha256: request.historyRunId ? digest(request.historyRunId) : null,
      authenticatedDisputeSelection: historySelection,
    },
    outcome: {
      workerOutcomeClass: 'incomplete',
      gateOutcomeClass: 'incomplete',
      agreement: 'incomplete',
      workerCompletionSha256: null,
      canonicalEvidenceSha256: null,
      gateDecisionSha256: null,
    },
    composedLimits: { configuredTotalTurns: 200, investigationTurns: 188, verificationReserveTurns: 12,
      maxFindings: 25, maxConcurrentTasks: 3, ambientOverrides: 'absent' },
    composedResourcesStatus: 'captured',
    composedResourcesPath: input.resources.path,
    composedResourcesSha256: input.resources.sha256,
    composedResourcesUnavailableReason: null,
    groundedVerification: {
      evidenceSemanticsVersion: null, callCount: null, outcomeCount: null, coverageComplete: null, routeReceipts: [],
    },
    qualificationControl: control,
    testBudget: {
      profile: input.budgetProfile,
      panelBudgetSeconds,
      maxPhysicalModelRequests: panelBudgetSeconds === 30 || panelBudgetSeconds === 60 ? 1 : null,
      terminalDeadlineAt: panelBudgetSeconds === null ? null : '2026-10-06T00:07:00.000Z',
      resourceExhaustion: request.arm === 'resource-exhaustion' ? { status: 'observed', physicalRequestCap: 1,
        logicalCompletionAttempts: 2, physicalRequests: 1, blockedPhysicalRequestAttempts: 1, firstResponseHttpStatus: 200 } : null,
    },
    provider: {
      identityStatus: 'unknown',
      upstreamProviderIdentity: 'unknown',
      exactBifrostLogStatus: 'not_available',
      privateIdentifiersSha256: input.privateIdentifiersSha256,
      captureStatus: 'captured',
      capturePath: input.capture.path,
      captureSha256: input.capture.sha256,
      captureUnavailableReason: null,
      calls: input.calls,
    },
    publication: {
      mode: 'disabled', githubWrites: 0, appChecks: 0, reviews: 0, comments: 0,
      ordinaryGateTouched: false, promptsPersisted: false, responsesPersisted: false, providerCredentialsPersisted: false,
    },
    terminal: {
      status: 'incomplete',
      startedAt: '2026-10-06T00:00:00.000Z',
      completedAt: '2026-10-06T00:01:00.000Z',
    },
  });
}

async function persistPlanFixture(root: string, planInput: NormalEngineQualificationPlanReceipt) {
  const plan = assertNormalEngineQualificationPlanReceipt(planInput);
  const body = `${JSON.stringify(JSON.parse(canonicalJson(plan)), null, 2)}\n`;
  const planPath = join(root, 'normal-engine-qualification.json');
  const sha256Path = `${planPath}.sha256`;
  const sha256 = digest(body);
  const bodyTemp = `${planPath}.tmp-fixture`;
  const checksumTemp = `${sha256Path}.tmp-fixture`;
  const bodyFile = await open(bodyTemp, 'wx', 0o600);
  try { await bodyFile.writeFile(body, 'utf8'); await bodyFile.sync(); }
  finally { await bodyFile.close(); }
  const checksumFile = await open(checksumTemp, 'wx', 0o600);
  try { await checksumFile.writeFile(`${sha256}\n`, 'utf8'); await checksumFile.sync(); }
  finally { await checksumFile.close(); }
  const directory = await open(root, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
  await rename(bodyTemp, planPath);
  await rename(checksumTemp, sha256Path);
  return { planPath, sha256Path, planSha256: sha256, body };
}

function planCaseRunId(rootRunId: string, descriptorRunId: string): string {
  return `nq_${digest(`${NORMAL_ENGINE_QUALIFICATION_PLAN_ID}:${rootRunId}:${descriptorRunId}`).slice(0, 32)}`;
}

async function readyFixture(root: string) {
  const planEnv: NodeJS.ProcessEnv = {
    ...VALID_ENV,
    REVIEW_NORMAL_ENGINE_QUALIFICATION_PLAN: NORMAL_ENGINE_QUALIFICATION_PLAN_ID,
    REVIEW_NORMAL_ENGINE_QUALIFICATION_CONFIG_VARIANT: NORMAL_ENGINE_QUALIFICATION_CONFIG_VARIANT,
  };
  delete planEnv.REVIEW_NORMAL_ENGINE_QUALIFICATION_CASE_ID;
  delete planEnv.REVIEW_NORMAL_ENGINE_QUALIFICATION_ARM;
  const planRequest = parseNormalEngineQualificationPlanRequest(planEnv);
  const descriptor = parseNormalEngineQualificationPlanDescriptor();
  const steps = descriptor.steps.map((step) => ({ ...step, runId: planCaseRunId(planRequest.runId, step.descriptorRunId) }));
  const sourceStep = steps.find((step) => step.arm === 'repair-introduction')!;
  const sourceEnv = requestEnvironment(sourceStep, sourceStep.runId, sourceStep.runId);
  const sourceRequest = parseNormalEngineQualificationRequest(sourceEnv);
  const repairStep = steps.find((step) => step.arm === 'repair-head-history')!;
  const repairRequest = parseNormalEngineQualificationRequest(requestEnvironment(repairStep, repairStep.runId, sourceStep.runId));
  const storeRoot = join(root, NORMAL_ENGINE_QUALIFICATION_STORE_ROOT.split('/').at(-1)!);
  const historyStore = new NormalEngineQualificationHistoryStore(storeRoot);
  const historyState = historyStateFor(sourceRequest, repairRequest);
  await historyStore.persistInitial(historyState);
  const sourceHistoryRows = await historyStore.historyArtifactsFor({
    runId: sourceStep.runId, sequenceId: HISTORY_SEQUENCE_ID, caseId: SOURCE_CASE_ID,
  });
  const historyArtifacts = sourceHistoryRows.map((row) => ({
    ...row,
    recordPath: relativeArtifact(root, join(storeRoot, row.recordPath)),
    sha256Path: relativeArtifact(root, join(storeRoot, row.sha256Path)),
  }));

  const requestByRunId = new Map<string, ReturnType<typeof parseNormalEngineQualificationRequest>>();
  const caseArtifacts: NormalEngineQualificationPlanReceipt['cases'] = [];
  const artifactPaths = ['normal-engine-qualification.json', 'normal-engine-qualification.json.sha256'];
  for (const row of historyArtifacts) artifactPaths.push(row.recordPath, row.sha256Path);
  const stagingRoot = await mkdtemp(join('/private/tmp', 'normal-qualification-capture-writer-stage-'));
  const stagingStoreRoot = join(stagingRoot, NORMAL_ENGINE_QUALIFICATION_STORE_ROOT.split('/').at(-1)!);
  try {
    for (const step of steps) {
      const env = requestEnvironment(step, step.runId, sourceStep.runId);
      const request = parseNormalEngineQualificationRequest(env);
      const sourceInput = buildNormalEngineQualificationSourceInput(request);
      const sourceDiff = sourceInput.source.patches.map((row) => row.patch).join('\n');
      const diffSha256 = digest(sourceDiff);
      requestByRunId.set(step.runId, request);
      const binding = providerCaptureBinding(request, diffSha256);
      const attestor = new NormalEngineQualificationProviderAttestor(async (_input, _init) =>
        new Response('mocked local provider response', { status: step.arm === 'provider-failure' ? 401 : 200 }),
      () => '123e4567-e89b-42d3-a456-426614174000');
      attestor.bindCaptureContext(binding);
      if (step.arm === 'provider-failure') {
        await attestor.run({ model: 'pr-reviewer', messages: [], timeoutMs: 1_000, stream: false }, async () => {
          const response = await attestor.fetch('https://gateway.example.invalid/v1/chat/completions', {
            method: 'POST', body: '{"model":"pr-reviewer","messages":[]}',
          });
          if (response.status >= 400) throw new Error('mocked provider rejection');
          return response;
        }).catch(() => undefined);
      } else if (step.arm === 'adjudicator-recheck') {
        const routeBinding = {
          findingFingerprint: SELECTED_FINGERPRINT,
          severity: 'P1' as const,
          purpose: 'disputed-blocker-recheck' as const,
          requestedRole: 'disputed-blocker-adjudicator' as const,
          appliedRole: 'disputed-blocker-adjudicator' as const,
          configuredAlternateModel: 'bifrost/qualification-adjudicator',
          selectedModel: 'bifrost/qualification-adjudicator',
        };
        await attestor.run({ model: routeBinding.selectedModel, messages: [], timeoutMs: 1_000, stream: false },
          () => attestor.fetch('https://gateway.example.invalid/v1/chat/completions', {
            method: 'POST', body: '{"model":"bifrost/qualification-adjudicator","messages":[]}',
          }), { routeBinding });
      }
      const captureValue = attestor.getCapture();
      const privateRows = attestor.privateIdentifiers();
      const resourcesValue = composedResourcesFor(request);
      const stagedCapture = await persistNormalEngineQualificationProviderCapture(captureValue, binding, stagingStoreRoot);
      const stagedIdentifiers = privateRows.length > 0
        ? await persistNormalEngineQualificationProviderIdentifiers(privateRows, request.runId, request.phase, request.fixture.caseId, stagingStoreRoot)
        : undefined;
      const stagedResources = await persistNormalEngineQualificationComposedResources(resourcesValue,
        request.runId, request.phase, request.fixture.caseId, stagingStoreRoot);
      const receipt = receiptForPlanCase({
        env,
        budgetProfile: step.budgetProfile,
        request,
        diffSha256,
        capture: stagedCapture,
        resources: stagedResources,
        privateIdentifiersSha256: stagedIdentifiers?.privateIdentifiersSha256 ?? null,
        calls: attestor.snapshot(),
      });
      const persistedReceipt = await persistNormalEngineQualificationReceipt(receipt, storeRoot);
      const capture = await persistNormalEngineQualificationProviderCapture(captureValue, binding, storeRoot);
      const identifiers = privateRows.length > 0
        ? await persistNormalEngineQualificationProviderIdentifiers(privateRows, request.runId, request.phase, request.fixture.caseId, storeRoot)
        : undefined;
      const resources = await persistNormalEngineQualificationComposedResources(resourcesValue,
        request.runId, request.phase, request.fixture.caseId, storeRoot);
      if (capture.sha256 !== stagedCapture.sha256 || resources.sha256 !== stagedResources.sha256
        || identifiers?.privateIdentifiersSha256 !== stagedIdentifiers?.privateIdentifiersSha256) {
        throw new Error('normal_engine_qualification_capture_test_writer_output_changed');
      }
      const receiptPath = relativeArtifact(root, persistedReceipt.receiptPath);
      const providerIdentifiersPath = identifiers ? relativeArtifact(root, identifiers.identifiersPath) : null;
      const providerCapturePath = capture.path;
      const composedResourcesPath = resources.path;
      caseArtifacts.push({
        arm: step.arm,
        caseId: step.caseId,
        runId: step.runId,
        phase: request.phase,
        configurationVariant: request.configurationVariant,
        inputSha256: step.inputSha256,
        bundleSha256: step.bundleSha256,
        receiptPath,
        receiptSha256: persistedReceipt.receiptSha256,
        terminalStatus: receipt.terminal.status,
        budgetProfile: step.budgetProfile,
        providerIdentifiersPath,
        providerIdentifiersSha256: identifiers?.privateIdentifiersSha256 ?? null,
        providerCaptureStatus: 'captured',
        providerCapturePath,
        providerCaptureSha256: capture.sha256,
        providerCaptureUnavailableReason: null,
        composedResourcesPath,
        composedResourcesSha256: resources.sha256,
        composedResourcesStatus: 'captured',
        composedResourcesUnavailableReason: null,
      });
      artifactPaths.push(receiptPath, relativeArtifact(root, persistedReceipt.sha256Path),
        providerCapturePath, providerCapturePath.replace(/provider-capture\.json$/u, 'provider-capture.sha256'),
        composedResourcesPath, composedResourcesPath.replace(/composed-runtime-resources\.json$/u, 'composed-runtime-resources.sha256'));
      if (identifiers && providerIdentifiersPath) {
        artifactPaths.push(providerIdentifiersPath, relativeArtifact(root, identifiers.sha256Path));
      }
    }
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }

  for (const step of steps.filter((row) => ['repair-head-history', 'repair-head-repeat', 'repair-head-empty-history',
    'repair-head-history-unavailable', 'repair-head-verifier-unavailable', 'adjudicator-recheck'].includes(row.arm))) {
    const request = requestByRunId.get(step.runId)!;
    const sameHead = step.arm === 'adjudicator-recheck';
    const identity = {
      runId: step.runId,
      sourceRunId: step.arm === 'repair-head-empty-history' ? null : sourceStep.runId,
      sequenceId: HISTORY_SEQUENCE_ID,
      sourceCaseId: SOURCE_CASE_ID,
      repairCaseId: sameHead ? SOURCE_CASE_ID : REPAIR_CASE_ID,
    };
    const mode = step.arm === 'repair-head-empty-history' ? 'empty-context' as const
      : step.arm === 'repair-head-history-unavailable' ? 'history-unavailable' as const
        : step.arm === 'repair-head-verifier-unavailable' ? 'verifier-unavailable' as const
          : sameHead ? 'adjudicator-recheck' as const : 'history' as const;
    const historyBinding = mode === 'history' || mode === 'verifier-unavailable' || mode === 'adjudicator-recheck'
      ? historyBindingFor(sourceRequest, request) : undefined;
    if (historyBinding && mode !== 'verifier-unavailable') {
      const historySource = mode === 'adjudicator-recheck'
        ? historyStore.sourceForSameHeadAdjudicatorRecheck(historyBinding)
        : historyStore.sourceForRepair(historyBinding);
      await historySource.read();
      await historySource.recordVerification({
        snapshotId: historyState.historyLoad.snapshotId!,
        findingEventId: HISTORY_FINDING_ID,
        status: 'confirmed',
        currentContextDigest: historyState.historyLoad.contextDigest!,
        currentAffectedContextDigest: historyState.historyLoad.findings[0]!.affectedContextDigest,
        evidence: { receipt: 'synthetic-local-capture-handshake-test' },
      });
    }
    await historyStore.finalizeVerificationSet(identity, mode, historyBinding);
    const runArtifacts = await historyStore.artifactsForRepairRun(identity);
    for (const row of runArtifacts) {
      const recordPath = relativeArtifact(root, join(storeRoot, row.recordPath));
      const sha256Path = relativeArtifact(root, join(storeRoot, row.sha256Path));
      historyArtifacts.push({ ...row, recordPath, sha256Path });
      artifactPaths.push(recordPath, sha256Path);
    }
  }

  const plan: NormalEngineQualificationPlanReceipt = {
    schemaVersion: 'ReviewYetiNormalQualificationPlan.v1',
    purpose: 'normal-engine-qualification-plan',
    planId: planRequest.planId,
    runId: planRequest.runId,
    descriptorSha256: NORMAL_ENGINE_QUALIFICATION_PLAN_DESCRIPTOR_SHA256,
    runtime: planRequest.runtime,
    policy: {
      targetRepository: planRequest.policy.targetRepository,
      selectionPurpose: planRequest.policy.selectionPurpose,
      configurationVariant: planRequest.configurationVariant,
      source: {
        repositoryId: planRequest.policy.sourceRepositoryId,
        owner: planRequest.policy.sourceOwner,
        repo: planRequest.policy.sourceRepo,
        ref: planRequest.policy.sourceRef,
        path: planRequest.policy.sourcePath,
        contentSha256: planRequest.policy.sourceContentSha256,
      },
      effectivePolicyDigest: planRequest.policy.policyDigest,
      effectiveConfigDigest: planRequest.policy.configDigest,
    },
    cases: caseArtifacts,
    historyArtifacts,
    historyArtifactSetComplete: true,
    caseCount: caseArtifacts.length,
    expectedReceiptCount: descriptor.steps.length,
    completedReceiptCount: caseArtifacts.length,
    receiptSetComplete: caseArtifacts.length === descriptor.steps.length,
    publication: {
      mode: 'disabled', githubWrites: 0, appChecks: 0, reviews: 0, comments: 0,
      ordinaryGateTouched: false, promptsPersisted: false, responsesPersisted: false, providerCredentialsPersisted: false,
    },
    terminal: {
      status: 'failed',
      startedAt: '2026-10-06T00:00:00.000Z',
      completedAt: '2026-10-06T00:01:00.000Z',
    },
  };
  const persistedPlan = await persistPlanFixture(root, plan);
  const parsedPlan = assertNormalEngineQualificationPlanReceipt(plan);
  const source = normalEngineQualificationCaptureArtifactSource(parsedPlan);
  const ready = await writeNormalEngineQualificationCaptureReady(source, persistedPlan, root);
  return { ready, source, plan: parsedPlan, planBytes: persistedPlan.body,
    recordPaths: artifactPaths.sort() };
}

describe('normal engine qualification capture handshake', () => {
  it('seals exactly the Plan-derived private artifact inventory and verifies every file digest', async () => {
    const root = await mkdtemp(join('/private/tmp', 'normal-qualification-capture-ready-'));
    try {
      const { ready, recordPaths, plan, planBytes } = await readyFixture(root);
      const parsed = normalEngineQualificationCaptureReadyV1Schema.parse(ready.manifest);
      expect(parsed.artifacts.map((row) => row.path)).toEqual(recordPaths);
      expect(parsed.artifactCount).toBe(recordPaths.length);
      expect(parsed.planSha256).toBe(digest(planBytes));
      expect(assertNormalEngineQualificationPlanReceipt(JSON.parse(planBytes))).toEqual(plan);
      expect(plan.cases).toHaveLength(11);
      expect(plan.historyArtifacts.filter((row) => row.kind === 'verification-set')).toHaveLength(6);
      expect(parsed.artifactSetSha256).toBe(digest(canonicalJson(parsed.artifacts)));
      expect(ready.path).toBe(join(root, 'normal-engine-qualification-capture.ready.json'));
      expect(ready.sha256).toBe(digest(await readFile(ready.path, 'utf8')));
      expect((await stat(ready.path)).mode & 0o777).toBe(0o600);
      expect(JSON.stringify(parsed)).not.toContain('private-only');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects an artifact path outside the fixed per-run namespace and a duplicate path', async () => {
    const root = await mkdtemp(join('/private/tmp', 'normal-qualification-capture-path-'));
    try {
      const { source } = await readyFixture(root);
      const escaped = structuredClone(source);
      escaped.cases[0]!.receiptPath = '../outside.json';
      await expect(writeNormalEngineQualificationCaptureReady(escaped, {
        planPath: join(root, 'normal-engine-qualification.json'), planSha256: digest(await readFile(join(root, 'normal-engine-qualification.json'), 'utf8')),
      }, root)).rejects.toThrow('normal_engine_qualification_capture_source_plan_mismatch');
      const duplicate = structuredClone(source);
      duplicate.cases.push(structuredClone(duplicate.cases[0]!));
      await expect(writeNormalEngineQualificationCaptureReady(duplicate, {
        planPath: join(root, 'normal-engine-qualification.json'), planSha256: digest(await readFile(join(root, 'normal-engine-qualification.json'), 'utf8')),
      }, root)).rejects.toThrow('normal_engine_qualification_capture_source_plan_mismatch');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects omitted, relabelled, extra, and wrong-hash source rows before constructing READY', async () => {
    const root = await mkdtemp(join('/private/tmp', 'normal-qualification-capture-source-binding-'));
    try {
      const { source, ready } = await readyFixture(root);
      const mismatches: Array<{ label: string; value: typeof source }> = [];
      const omittedCase = structuredClone(source);
      omittedCase.cases.pop();
      mismatches.push({ label: 'omitted case', value: omittedCase });
      const omittedHistory = structuredClone(source);
      omittedHistory.historyArtifacts.pop();
      mismatches.push({ label: 'omitted history row', value: omittedHistory });
      const relabelled = structuredClone(source);
      relabelled.cases[0]!.receiptPath = 'normal-engine-qualification-store/other/receipt.json';
      mismatches.push({ label: 'relabelled path', value: relabelled });
      const extra = structuredClone(source);
      extra.cases.push(structuredClone(extra.cases[0]!));
      mismatches.push({ label: 'extra case', value: extra });
      const wrongHash = structuredClone(source);
      wrongHash.cases[0]!.receiptSha256 = '0'.repeat(64);
      mismatches.push({ label: 'wrong case digest', value: wrongHash });
      const wrongStatus = structuredClone(source);
      wrongStatus.cases[0]!.providerCaptureStatus = 'unavailable';
      mismatches.push({ label: 'relabelled capture status', value: wrongStatus });

      for (const mismatch of mismatches) {
        await expect(writeNormalEngineQualificationCaptureReady(mismatch.value, {
          planPath: join(root, 'normal-engine-qualification.json'), planSha256: ready.manifest.planSha256,
        }, root), mismatch.label).rejects.toThrow('normal_engine_qualification_capture_source_plan_mismatch');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a different valid Plan with the same planId and runId', async () => {
    const root = await mkdtemp(join('/private/tmp', 'normal-qualification-capture-alternate-plan-'));
    try {
      const { ready, plan } = await readyFixture(root);
      const alternate = structuredClone(plan);
      const row = alternate.cases.find((candidate) => candidate.arm === 'p2-only')!;
      row.runId = `nq_${'e'.repeat(32)}`;
      row.receiptPath = `normal-engine-qualification-store/${row.runId}/${row.phase}/${row.caseId}/receipt.json`;
      row.providerCapturePath = normalEngineQualificationProviderCaptureRelativePath({
        runId: row.runId, phase: row.phase, caseId: row.caseId,
      });
      row.composedResourcesPath = normalEngineQualificationComposedResourcesRelativePath(row.runId, row.phase, row.caseId);
      const parsedAlternate = assertNormalEngineQualificationPlanReceipt(alternate);
      expect(parsedAlternate).toMatchObject({ planId: plan.planId, runId: plan.runId });
      expect(parsedAlternate.cases.find((candidate) => candidate.arm === 'p2-only')?.runId).not.toBe(
        plan.cases.find((candidate) => candidate.arm === 'p2-only')?.runId,
      );

      await expect(writeNormalEngineQualificationCaptureReady(
        normalEngineQualificationCaptureArtifactSource(parsedAlternate),
        { planPath: join(root, 'normal-engine-qualification.json'), planSha256: ready.manifest.planSha256 }, root,
      )).rejects.toThrow('normal_engine_qualification_capture_source_plan_mismatch');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects malformed Plan counts and Plan-bound hashes that do not match the persisted receipt', async () => {
    const root = await mkdtemp(join('/private/tmp', 'normal-qualification-capture-plan-counts-'));
    try {
      const { source, plan, ready } = await readyFixture(root);
      const planPath = join(root, 'normal-engine-qualification.json');
      const checksumPath = `${planPath}.sha256`;
      const minimalPlanBytes = `${JSON.stringify({
        schemaVersion: 'ReviewYetiNormalQualificationPlan.v1',
        planId: plan.planId,
        runId: plan.runId,
      })}\n`;
      const minimalPlanSha = digest(minimalPlanBytes);
      await writeFile(planPath, minimalPlanBytes, { mode: 0o600 });
      await writeFile(checksumPath, `${minimalPlanSha}\n`, { mode: 0o600 });
      await expect(writeNormalEngineQualificationCaptureReady(source,
        { planPath, planSha256: minimalPlanSha }, root))
        .rejects.toThrow('normal_engine_qualification_capture_plan_contract_invalid');

      const malformedPlan = { ...structuredClone(plan), caseCount: plan.caseCount - 1 };
      const malformedBytes = `${JSON.stringify(JSON.parse(canonicalJson(malformedPlan)), null, 2)}\n`;
      const malformedSha = digest(malformedBytes);
      await writeFile(planPath, malformedBytes, { mode: 0o600 });
      await writeFile(checksumPath, `${malformedSha}\n`, { mode: 0o600 });
      await expect(writeNormalEngineQualificationCaptureReady(source,
        { planPath, planSha256: malformedSha }, root))
        .rejects.toThrow('normal_engine_qualification_capture_plan_contract_invalid');

      const wrongReceiptDigestPlan = structuredClone(plan);
      wrongReceiptDigestPlan.cases[0]!.receiptSha256 = '0'.repeat(64);
      const validWrongDigestPlan = assertNormalEngineQualificationPlanReceipt(wrongReceiptDigestPlan);
      const wrongDigestBytes = `${JSON.stringify(JSON.parse(canonicalJson(validWrongDigestPlan)), null, 2)}\n`;
      const wrongDigestSha = digest(wrongDigestBytes);
      await writeFile(planPath, wrongDigestBytes, { mode: 0o600 });
      await writeFile(checksumPath, `${wrongDigestSha}\n`, { mode: 0o600 });
      await expect(writeNormalEngineQualificationCaptureReady(
        normalEngineQualificationCaptureArtifactSource(validWrongDigestPlan),
        { planPath, planSha256: wrongDigestSha }, root,
      )).rejects.toThrow('normal_engine_qualification_capture_artifact_digest_mismatch');
      expect(ready.manifest.planSha256).not.toBe(wrongDigestSha);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects symlinked artifact files instead of hashing their targets', async () => {
    const root = await mkdtemp(join('/private/tmp', 'normal-qualification-capture-symlink-'));
    try {
      const { source } = await readyFixture(root);
      const row = source.cases[0]!;
      const targetPath = join(root, row.receiptPath);
      const target = join(root, 'outside-secret');
      await writeFile(target, 'outside');
      await rm(targetPath);
      await symlink(target, targetPath);
      await expect(writeNormalEngineQualificationCaptureReady(source, {
        planPath: join(root, 'normal-engine-qualification.json'), planSha256: digest(await readFile(join(root, 'normal-engine-qualification.json'), 'utf8')),
      }, root)).rejects.toThrow(/artifact_not_private_regular_file/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts and consumes only an ACK that exactly matches the sealed copied inventory', async () => {
    const root = await mkdtemp(join('/private/tmp', 'normal-qualification-capture-ack-'));
    const markerPath = join(root, 'qualification-capture.complete');
    try {
      const { ready } = await readyFixture(root);
      const ack = {
        schemaVersion: 'NormalEngineQualificationCaptureAck.v1',
        purpose: 'normal-engine-qualification-capture-ack',
        planId: ready.manifest.planId, runId: ready.manifest.runId, planSha256: ready.manifest.planSha256,
        readySha256: ready.sha256, artifactSetSha256: ready.manifest.artifactSetSha256,
        artifactCount: ready.manifest.artifactCount, copiedArtifacts: ready.manifest.artifacts,
        copiedArtifactSetSha256: ready.manifest.artifactSetSha256,
      };
      expect(normalEngineQualificationCaptureAckV1Schema.parse(ack)).toEqual(ack);
      await writeFile(markerPath, `${JSON.stringify(ack)}\n`, { mode: 0o600 });
      const result = await waitForNormalEngineQualificationCapture({
        NODE_ENV: 'test', REVIEW_NORMAL_ENGINE_QUALIFICATION_CAPTURE_HOLD: 'true',
        REVIEW_NORMAL_ENGINE_QUALIFICATION_PLAN: NORMAL_ENGINE_QUALIFICATION_PLAN_ID,
      }, ready, { markerPath, timeoutMs: 100, pollIntervalMs: 1 });
      expect(result).toMatchObject({ requested: true, status: 'acknowledged', readySha256: ready.sha256,
        ackSha256: digest(`${JSON.stringify(ack)}\n`), artifactSetSha256: ready.manifest.artifactSetSha256,
        artifactCount: ready.manifest.artifactCount, reason: null });
      await expect(readFile(markerPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails capture on a mismatched, official-looking, or malformed ACK without changing the plan', async () => {
    const root = await mkdtemp(join('/private/tmp', 'normal-qualification-capture-invalid-ack-'));
    const markerPath = join(root, 'qualification-capture.complete');
    try {
      const { ready } = await readyFixture(root);
      const ack = {
        schemaVersion: 'NormalEngineQualificationCaptureAck.v1', purpose: 'normal-engine-qualification-capture-ack',
        planId: ready.manifest.planId, runId: ready.manifest.runId, planSha256: ready.manifest.planSha256,
        readySha256: ready.sha256, artifactSetSha256: '0'.repeat(64), artifactCount: ready.manifest.artifactCount,
        copiedArtifacts: ready.manifest.artifacts, copiedArtifactSetSha256: '0'.repeat(64), decision: 'SHIP',
      };
      await writeFile(markerPath, `${JSON.stringify(ack)}\n`, { mode: 0o600 });
      const result = await waitForNormalEngineQualificationCapture({
        NODE_ENV: 'test', REVIEW_NORMAL_ENGINE_QUALIFICATION_CAPTURE_HOLD: 'true',
        REVIEW_NORMAL_ENGINE_QUALIFICATION_PLAN: NORMAL_ENGINE_QUALIFICATION_PLAN_ID,
      }, ready, { markerPath, timeoutMs: 100, pollIntervalMs: 1 });
      expect(result).toMatchObject({ requested: true, status: 'invalid_ack', reason: 'ack-invalid' });
      expect(result.ackSha256).toBe(digest(`${JSON.stringify(ack)}\n`));
      expect(result.artifactSetSha256).toBe(ready.manifest.artifactSetSha256);
      await expect(readFile(markerPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(normalEngineQualificationCaptureOutcomeV1Schema.safeParse({ schemaVersion: 'NormalEngineQualificationCaptureOutcome.v1',
        ...result }).success).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects directory and symlink ACK paths without reading their targets', async () => {
    const root = await mkdtemp(join('/private/tmp', 'normal-qualification-capture-ack-path-'));
    try {
      const { ready } = await readyFixture(root);
      const directoryMarker = join(root, 'directory-ack');
      await mkdir(directoryMarker);
      const baseEnv: NodeJS.ProcessEnv = { NODE_ENV: 'test', REVIEW_NORMAL_ENGINE_QUALIFICATION_CAPTURE_HOLD: 'true',
        REVIEW_NORMAL_ENGINE_QUALIFICATION_PLAN: NORMAL_ENGINE_QUALIFICATION_PLAN_ID };
      await expect(waitForNormalEngineQualificationCapture(baseEnv, ready, { markerPath: directoryMarker }))
        .resolves.toMatchObject({ status: 'invalid_ack', reason: 'ack-invalid' });
      const target = join(root, 'ack-target');
      await writeFile(target, '{"private":"must-not-be-read"}', { mode: 0o600 });
      const symlinkMarker = join(root, 'symlink-ack');
      await symlink(target, symlinkMarker);
      await expect(waitForNormalEngineQualificationCapture(baseEnv, ready, { markerPath: symlinkMarker }))
        .resolves.toMatchObject({ status: 'invalid_ack', reason: 'ack-invalid', ackSha256: null });
      await expect(readFile(target, 'utf8')).resolves.toBe('{"private":"must-not-be-read"}');
      await expect(readFile(symlinkMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a modified READY record before accepting any later ACK', async () => {
    const root = await mkdtemp(join('/private/tmp', 'normal-qualification-capture-ready-tamper-'));
    try {
      const { ready } = await readyFixture(root);
      await writeFile(ready.path, '{"schemaVersion":"NormalEngineQualificationCaptureReady.v1"}\n', { mode: 0o600 });
      const result = await waitForNormalEngineQualificationCapture({
        NODE_ENV: 'test', REVIEW_NORMAL_ENGINE_QUALIFICATION_CAPTURE_HOLD: 'true',
        REVIEW_NORMAL_ENGINE_QUALIFICATION_PLAN: NORMAL_ENGINE_QUALIFICATION_PLAN_ID,
      }, ready, { markerPath: join(root, 'ack'), timeoutMs: 10 });
      expect(result).toMatchObject({ status: 'invalid_ack', reason: 'ready-manifest-invalid', ackSha256: null });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('times out distinctly and leaves the original Plan.v1 terminal state unchanged in the outcome', async () => {
    const root = await mkdtemp(join('/private/tmp', 'normal-qualification-capture-outcome-'));
    try {
      const { ready } = await readyFixture(root);
      let now = 0;
      const wait = await waitForNormalEngineQualificationCapture({
        NODE_ENV: 'test', REVIEW_NORMAL_ENGINE_QUALIFICATION_CAPTURE_HOLD: 'true',
        REVIEW_NORMAL_ENGINE_QUALIFICATION_PLAN: NORMAL_ENGINE_QUALIFICATION_PLAN_ID,
      }, ready, { markerPath: join(root, 'missing-ack'), timeoutMs: 50, pollIntervalMs: 25,
        now: () => now, sleep: async (duration) => { now += duration; } });
      const persisted = await persistNormalEngineQualificationCaptureOutcome({ schemaVersion: 'NormalEngineQualificationCaptureOutcome.v1',
        purpose: 'normal-engine-qualification-capture', planId: ready.manifest.planId,
        runId: ready.manifest.runId, planSha256: ready.manifest.planSha256, planTerminalStatus: 'failed',
        captureRequested: wait.requested, captureStatus: wait.status, readySha256: wait.readySha256,
        ackSha256: wait.ackSha256, artifactSetSha256: wait.artifactSetSha256, artifactCount: wait.artifactCount,
        captureReason: wait.reason, completedAt: '2026-10-06T12:00:00.000Z' }, root);
      const body = await readFile(persisted.path, 'utf8');
      const checksum = await readFile(persisted.sha256Path, 'utf8');
      const file = JSON.parse(body);
      expect(file).toMatchObject({ schemaVersion: 'NormalEngineQualificationCaptureOutcome.v1',
        planTerminalStatus: 'failed', captureRequested: true, captureStatus: 'timed_out',
        readySha256: ready.sha256, ackSha256: null, captureReason: 'ack-timeout' });
      expect(checksum).toBe(`${persisted.sha256}\n`);
      expect((await stat(persisted.path)).mode & 0o777).toBe(0o600);
      expect(persisted.path).toBe(join(root, NORMAL_ENGINE_QUALIFICATION_STORE_ROOT.split('/').at(-1)!, ready.manifest.runId,
        'capture-handoff.record', 'capture-outcome.json'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('records hold-off as not requested and rejects an invalid ACK schema', async () => {
    const root = await mkdtemp(join('/private/tmp', 'normal-qualification-capture-off-'));
    try {
      const { ready } = await readyFixture(root);
      const result = await waitForNormalEngineQualificationCapture({ NODE_ENV: 'test' }, null, {
        markerPath: NORMAL_ENGINE_QUALIFICATION_CAPTURE_ACK_PATH,
      });
      expect(result).toMatchObject({ requested: false, status: 'not_requested', reason: 'hold-disabled',
        readySha256: null, ackSha256: null, artifactSetSha256: null, artifactCount: 0 });
      expect(normalEngineQualificationCaptureAckV1Schema.safeParse({ ...ready.manifest, decision: 'SHIP' }).success).toBe(false);
      const outcome = await persistNormalEngineQualificationCaptureOutcome({ schemaVersion: 'NormalEngineQualificationCaptureOutcome.v1',
        purpose: 'normal-engine-qualification-capture', planId: ready.manifest.planId,
        runId: ready.manifest.runId, planSha256: ready.manifest.planSha256, planTerminalStatus: 'completed',
        captureRequested: false, captureStatus: result.status, readySha256: result.readySha256,
        ackSha256: result.ackSha256, artifactSetSha256: result.artifactSetSha256, artifactCount: result.artifactCount,
        captureReason: result.reason, completedAt: '2026-10-06T12:00:00.000Z' }, root);
      expect(normalEngineQualificationCaptureOutcomeV1Schema.parse(JSON.parse(await readFile(outcome.path, 'utf8'))))
        .toMatchObject({ captureStatus: 'not_requested', planTerminalStatus: 'completed' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
