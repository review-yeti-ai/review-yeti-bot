import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preparePublishingPolicy } from '../../src/review/preparedPublishingPolicy';
import { GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION } from '../../src/review/groundedEvidenceV2';
import { OpenRouterClient, type FetchImplementation, type GroundedVerifierRequestContextV1,
  type ReviewModelClient } from '../../src/gateway/openRouterClient';
import { ComposedRuntimeResourceObserver, completeComposedRuntimeResources } from '../../src/panel/composedResourceReceipt';
import { runIndependentGroundedVerification } from '../../src/review/groundedReviewEngine';
import { GROUNDED_VERIFICATION_VERSION } from '../../src/review/groundedReviewEngine';
import { REVIEW_SEVERITY_POLICY_V2 } from '../../src/review/reviewDecision';
import { parseChangedFiles } from '../../src/review/changedFiles';
import { findingFingerprint } from '../../src/review/findingConvergence';
import { createDisputedBlockerAdjudicatorClient } from '../../src/review/disputedBlockerAdjudicator';
import { createPublishingProgress } from '../../src/telemetry/publishingProgress';
import { meterModelClient, TokenLedger } from '../../src/telemetry/tokenLedger';
import { withProviderConcurrencyLimit } from '../../src/gateway/concurrencyLimitedModelClient';
import {
  createNormalEngineQualificationRepoFileProvider,
  parseNormalEngineQualificationPlanDescriptor,
  runNormalEngineQualificationCase,
  runNormalEngineQualificationPlan,
  waitForNormalEngineQualificationCapture,
  persistNormalEngineQualificationProviderCapture,
  type NormalEngineQualificationWorkerDependencies,
} from '../../src/qualification/normalEngineQualificationWorker';
import { buildNormalEngineQualificationSourceInput, isNormalEngineQualificationWorker,
  assertNormalEngineQualificationPlanReceipt, assertNormalEngineQualificationReceipt,
  parseNormalEngineQualificationPlanRequest, parseNormalEngineQualificationRequest,
  normalEngineQualificationComposedResourcesRelativePath,
  type NormalEngineProviderCaptureBinding } from '../../src/qualification/normalEngineQualification';
import { NormalEngineQualificationProviderAttestor,
  normalEngineQualificationProviderCaptureRelativePath } from '../../src/qualification/normalEngineQualificationProvider';

const VALID_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  REVIEW_NORMAL_ENGINE_QUALIFICATION_ONLY: 'true',
  REVIEW_NORMAL_ENGINE_QUALIFICATION_RUN_ID: 'nq_0123456789abcdef0123456789abcdef',
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

function providerCapturePersistenceStub() {
  return vi.fn(async (_capture: unknown, binding: NormalEngineProviderCaptureBinding) => ({
    path: normalEngineQualificationProviderCaptureRelativePath(binding),
    sha256: '8'.repeat(64),
    idempotent: false,
  }));
}

function noCaptureWaitResult() {
  return { requested: false as const, status: 'not_requested' as const, readySha256: null, ackSha256: null,
    artifactSetSha256: null, artifactCount: 0, reason: 'hold-disabled' as const };
}

function captureOutcomePersistenceStub(onPersist?: (input: unknown) => void) {
  return vi.fn(async (input: unknown) => {
    onPersist?.(input);
    return { path: 'private/capture-outcome.json', sha256Path: 'private/capture-outcome.sha256',
      sha256: '7'.repeat(64), idempotent: false };
  });
}

function receiptForPlanCase(env: NodeJS.ProcessEnv, profile: string) {
  const request = parseNormalEngineQualificationRequest(env);
  const completeHistory = Boolean(request.historyRunId)
    && request.arm !== 'repair-head-history-unavailable';
  const emptyHistory = ['p2-only', 'large-crossfile', 'provider-failure', 'resource-exhaustion',
    'repair-head-empty-history'].includes(request.arm);
  const control = request.arm === 'repair-head-empty-history' ? 'empty-history-ablation'
    : request.arm === 'repair-head-history-unavailable' ? 'history-unavailable'
      : request.arm === 'repair-head-verifier-unavailable' ? 'grounded-verifier-unavailable'
        : request.arm === 'adjudicator-recheck' ? 'authenticated-adjudicator-recheck'
        : request.arm === 'provider-failure' ? 'bifrost-auth-rejection-invalid-inference-key'
          : request.arm === 'resource-exhaustion' ? 'worker-deadline-test-60s-one-physical-request' : 'none';
  const panelBudgetSeconds = profile === 'normal-canary-120s' ? 120
    : profile === 'large-crossfile-canary-300s' ? 300
      : profile === 'bifrost-auth-rejection-30s-one-request' ? 30
        : profile === 'resource-exhaustion-60s-one-request' ? 60 : null;
  const configuredAdjudicator = request.configurationVariant === 'configured-disputed-blocker-adjudicator-v1';
  const selectedFingerprint = `fp1_${'a'.repeat(24)}`;
  const selectedPath = 'src/qualification.ts';
  const diagnosticIncomplete = ['provider-failure', 'resource-exhaustion', 'repair-head-verifier-unavailable'].includes(request.arm);
  const selectedRoute = {
    version: 'GroundedVerifierRoute.v1', purpose: 'disputed-blocker-recheck',
    requestedRole: 'disputed-blocker-adjudicator', appliedRole: 'disputed-blocker-adjudicator',
    configuredAlternateModel: 'bifrost/qualification-adjudicator', selectedModel: 'bifrost/qualification-adjudicator',
    responseReportedModel: null, responseModelUnavailableReason: 'unverified test response metadata',
    upstreamIdentity: { providerId: null, model: null, unavailableReason: 'No signed provider attestation in this source test.' },
  };
  return assertNormalEngineQualificationReceipt({
    schemaVersion: 'ReviewYetiNormalQualification.v1',
    purpose: 'normal-engine-qualification',
    runId: request.runId,
    arm: request.arm,
    phase: request.phase,
    target: {
      kind: 'public-synthetic-fixture',
      repositoryId: request.fixture.repository.repositoryId,
      repository: `${request.fixture.repository.owner}/${request.fixture.repository.repo}`,
      prNumber: request.fixture.prNumber,
      caseId: request.fixture.caseId,
      bundleVersion: request.fixture.bundleVersion,
      bundleSha256: request.fixture.bundleSha256,
      inputSha256: request.fixture.inputSha256,
      baseSha: request.fixture.baseSha,
      headSha: request.fixture.headSha,
      diffSha256: 'c'.repeat(64),
    },
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
      groundedEvidenceSemanticsVersion: 'GroundedReviewEvidenceSemantics.v2',
      disputedBlockerAdjudicator: configuredAdjudicator
        ? { state: 'available', modelAlias: 'bifrost/qualification-adjudicator', reasoningEffort: 'high' }
        : { state: 'unconfigured', modelAlias: null, reasoningEffort: null },
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
      snapshotIdSha256: completeHistory || emptyHistory ? 'd'.repeat(64) : null,
      contextDigest: completeHistory || emptyHistory ? 'e'.repeat(64) : null,
      parentRunIdSha256: request.historyRunId ? createHash('sha256').update(request.historyRunId).digest('hex') : null,
      authenticatedDisputeSelection: request.arm === 'adjudicator-recheck' ? {
        findingFingerprint: selectedFingerprint, path: selectedPath,
        priorFindingEventIdSha256: 'f'.repeat(64), priorEvidenceDigest: 'e'.repeat(64),
      } : null,
    },
    outcome: request.arm === 'adjudicator-recheck'
      ? { workerOutcomeClass: 'completed_ineligible', gateOutcomeClass: 'completed_ineligible', agreement: 'agreement',
        workerCompletionSha256: '1'.repeat(64), canonicalEvidenceSha256: '2'.repeat(64), gateDecisionSha256: '3'.repeat(64) }
      : diagnosticIncomplete
        ? { workerOutcomeClass: 'incomplete', gateOutcomeClass: 'incomplete', agreement: 'incomplete',
          workerCompletionSha256: '1'.repeat(64), canonicalEvidenceSha256: null, gateDecisionSha256: '3'.repeat(64) }
        : { workerOutcomeClass: 'completed_ineligible', gateOutcomeClass: 'completed_ineligible', agreement: 'agreement',
      workerCompletionSha256: '1'.repeat(64), canonicalEvidenceSha256: '2'.repeat(64), gateDecisionSha256: '3'.repeat(64) },
    composedResourcesStatus: 'captured',
    composedResourcesPath: normalEngineQualificationComposedResourcesRelativePath(request.runId, request.phase, request.fixture.caseId),
    composedResourcesSha256: '9'.repeat(64),
    composedResourcesUnavailableReason: null,
    groundedVerification: request.arm === 'adjudicator-recheck'
      ? { evidenceSemanticsVersion: 'GroundedReviewEvidenceSemantics.v2', callCount: 1, outcomeCount: 1,
        coverageComplete: true, routeReceipts: [{ findingFingerprint: selectedFingerprint, path: selectedPath,
          severity: 'P1', status: 'confirmed', route: selectedRoute }] }
      : diagnosticIncomplete ? { evidenceSemanticsVersion: null, callCount: null, outcomeCount: null,
        coverageComplete: null, routeReceipts: [] }
        : { evidenceSemanticsVersion: 'GroundedReviewEvidenceSemantics.v2', callCount: 0, outcomeCount: 0,
          coverageComplete: true, routeReceipts: [] },
    qualificationControl: control,
    provider: { identityStatus: 'unknown', upstreamProviderIdentity: 'unknown', exactBifrostLogStatus: 'not_available',
      privateIdentifiersSha256: null, captureStatus: 'captured',
      capturePath: normalEngineQualificationProviderCaptureRelativePath({ runId: request.runId,
        phase: request.phase, caseId: request.fixture.caseId }), captureSha256: '8'.repeat(64),
      captureUnavailableReason: null, calls: [] },
    testBudget: { profile, panelBudgetSeconds, maxPhysicalModelRequests: panelBudgetSeconds === 60 || panelBudgetSeconds === 30 ? 1 : null,
      terminalDeadlineAt: panelBudgetSeconds === null ? null : '2026-10-06T00:07:00.000Z' },
    publication: { mode: 'disabled', githubWrites: 0, appChecks: 0, reviews: 0, comments: 0,
      ordinaryGateTouched: false, promptsPersisted: false, responsesPersisted: false, providerCredentialsPersisted: false },
    terminal: { status: diagnosticIncomplete ? 'incomplete' : 'completed',
      startedAt: '2026-10-06T00:00:00.000Z', completedAt: '2026-10-06T00:01:00.000Z' },
  });
}

function providerFailureEnvironment(): { env: NodeJS.ProcessEnv; baseUrl: string; model: string } {
  const policyContent = JSON.stringify({ schema: 'synthetic.review-policy.v1', review_yeti: {
    personas: 'security,architecture', profile: 'balanced', review_engine: 'composed',
    severity_policy: 'review-yeti-severity.v2', budget: { max_investigation_turns: 12 },
  } });
  const source = { repositoryId: 73099, repository: 'synthetic/policy-target', sha: 'a'.repeat(40),
    path: 'policy/review-yeti.json', contentDigest: createHash('sha256').update(policyContent).digest('hex') };
  const baseUrl = 'https://gateway.example.invalid/v1';
  const model = 'pr-reviewer';
  const prepared = preparePublishingPolicy({ source, content: policyContent }, { baseUrl, model },
    { owner: 'synthetic', repo: 'policy-target' });
  const env: NodeJS.ProcessEnv = {
    ...VALID_ENV,
    REVIEW_NORMAL_ENGINE_QUALIFICATION_RUN_ID: 'nq_abcdef0123456789abcdef0123456789',
    REVIEW_NORMAL_ENGINE_QUALIFICATION_CASE_ID: 'ws5-p2-display-sort-v1',
    REVIEW_NORMAL_ENGINE_QUALIFICATION_ARM: 'provider-failure',
    REVIEW_POLICY_DIGEST: prepared.policy.effectivePolicyDigest,
    REVIEW_CONFIG_DIGEST: prepared.policy.effectiveConfigDigest,
    REVIEW_PREPARED_CONFIG_JSON: JSON.stringify({ version: 'PreparedReviewExecution.v1',
      config: prepared.config, transport: prepared.transport }),
    REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_REPOSITORY_ID: String(source.repositoryId),
    REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_OWNER: 'synthetic',
    REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_REPO: 'policy-target',
    REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_REF: source.sha,
    REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_PATH: source.path,
    REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_SHA256: source.contentDigest,
    REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_TARGET: 'synthetic/policy-target',
    OPENAI_BASE_URL: baseUrl,
    REVIEW_MODEL: model,
  };
  Object.defineProperty(env, 'OPENAI_API_KEY', { configurable: true, enumerable: false,
    get() { throw new Error('provisioned Bifrost key must not be read by provider-failure arm'); } });
  return { env, baseUrl, model };
}

describe('normal engine qualification source and capture', () => {
  it('loads the immutable eleven-arm outcome-blind plan and exact fixture pins', () => {
    const plan = parseNormalEngineQualificationPlanDescriptor();
    expect(plan).toMatchObject({
      planId: 'ws6-normal-canary-v1',
      descriptorSha256: '60f724e4ae3782ec8b5be7705d97d5dace662938570a34ac73bd566749e5dc99',
      maxActiveDurationMs: 1_650_000,
    });
    expect(plan.steps).toHaveLength(11);
    expect(plan.steps.map((step) => [step.descriptorRunId, step.arm, step.caseId])).toEqual([
      ['ws5-sequence-a-v1', 'repair-introduction', 'ws5-sequence-a-v1'],
      ['ws5-p2-display-sort-v1', 'p2-only', 'ws5-p2-display-sort-v1'],
      ['ws5-sequence-b-v1', 'repair-head-history', 'ws5-sequence-b-v1'],
      ['ws5-sequence-b-repeat-v1', 'repair-head-repeat', 'ws5-sequence-b-v1'],
      ['ws5-sequence-b-no-history-v1', 'repair-head-empty-history', 'ws5-sequence-b-v1'],
      ['ws5-sequence-b-history-unavailable-v1', 'repair-head-history-unavailable', 'ws5-sequence-b-v1'],
      ['ws5-sequence-b-verifier-unavailable-v1', 'repair-head-verifier-unavailable', 'ws5-sequence-b-v1'],
      ['ws5-large-crossfile-v1', 'large-crossfile', 'ws5-large-crossfile-v1'],
      ['ws5-provider-failure-v1', 'provider-failure', 'ws5-p2-display-sort-v1'],
      ['ws5-resource-exhaustion-v1', 'resource-exhaustion', 'ws5-p2-display-sort-v1'],
      ['ws5-sequence-a-adjudicator-v1', 'adjudicator-recheck', 'ws5-sequence-a-v1'],
    ]);
    expect(plan.steps[10]).toMatchObject({ phase: 'same-head-recheck', historySourceDescriptorRunId: 'ws5-sequence-a-v1',
      budgetProfile: 'normal-canary-120s' });
  });

  it('accepts only the fixed plan entry with no caller-selected case or arm', () => {
    const planEnv: NodeJS.ProcessEnv = { ...VALID_ENV,
      REVIEW_NORMAL_ENGINE_QUALIFICATION_PLAN: 'ws6-normal-canary-v1',
      REVIEW_NORMAL_ENGINE_QUALIFICATION_CAPTURE_HOLD: 'true',
      REVIEW_NORMAL_ENGINE_QUALIFICATION_CONFIG_VARIANT: 'configured-disputed-blocker-adjudicator-v1',
    };
    delete planEnv.REVIEW_NORMAL_ENGINE_QUALIFICATION_CASE_ID;
    delete planEnv.REVIEW_NORMAL_ENGINE_QUALIFICATION_ARM;
    expect(parseNormalEngineQualificationPlanRequest(planEnv)).toMatchObject({
      planId: 'ws6-normal-canary-v1', runId: 'nq_0123456789abcdef0123456789abcdef', captureHold: true,
    });
    expect(isNormalEngineQualificationWorker(planEnv)).toBe(true);
    expect(() => parseNormalEngineQualificationPlanRequest({ ...planEnv,
      REVIEW_NORMAL_ENGINE_QUALIFICATION_CASE_ID: 'ws5-p2-display-sort-v1',
    })).toThrow();
  });

  it('runs eleven static arms serially with fresh run IDs and an immutable A-history parent', async () => {
    const planEnv: NodeJS.ProcessEnv = { ...VALID_ENV,
      REVIEW_NORMAL_ENGINE_QUALIFICATION_PLAN: 'ws6-normal-canary-v1',
      REVIEW_NORMAL_ENGINE_QUALIFICATION_CAPTURE_HOLD: 'true',
      REVIEW_NORMAL_ENGINE_QUALIFICATION_CONFIG_VARIANT: 'configured-disputed-blocker-adjudicator-v1',
    };
    delete planEnv.REVIEW_NORMAL_ENGINE_QUALIFICATION_CASE_ID;
    delete planEnv.REVIEW_NORMAL_ENGINE_QUALIFICATION_ARM;
    planEnv.UNDECLARED_QUALIFICATION_INPUT = 'must-not-reach-child';
    const calls: Array<{ env: NodeJS.ProcessEnv; budgetProfile: string }> = [];
    let persistedIndex: ReturnType<typeof assertNormalEngineQualificationPlanReceipt> | undefined;
    let captureCalled = false;
    let persistedCaptureOutcome: unknown;
    const persistedCaptureOutcomeMock = captureOutcomePersistenceStub((input) => { persistedCaptureOutcome = input; });
    const planRunId = parseNormalEngineQualificationPlanRequest(planEnv).runId;
    const readyArtifacts = [
      { kind: 'plan-index', path: 'normal-engine-qualification.json', sha256: '3'.repeat(64), byteCount: 300 },
      { kind: 'plan-checksum', path: 'normal-engine-qualification.json.sha256', sha256: '4'.repeat(64), byteCount: 65 },
    ];
    const persistedReady = { path: '/workspace/.review-yeti/normal-engine-qualification-capture.ready.json',
      sha256Path: '/workspace/.review-yeti/normal-engine-qualification-capture.ready.json.sha256',
      sha256: '9'.repeat(64), artifactSetSha256: 'a'.repeat(64), artifactCount: readyArtifacts.length,
      manifest: { schemaVersion: 'NormalEngineQualificationCaptureReady.v1',
        purpose: 'normal-engine-qualification-artifact-capture', planId: 'ws6-normal-canary-v1', runId: planRunId,
        planSha256: '3'.repeat(64), artifacts: readyArtifacts, artifactCount: readyArtifacts.length,
        artifactSetSha256: 'a'.repeat(64) }, idempotent: false };
    const dependencies: NormalEngineQualificationWorkerDependencies = {
      verifyRuntimeManifest: async () => VALID_ENV.REVIEW_NORMAL_ENGINE_QUALIFICATION_RUNTIME_MANIFEST_SHA256!,
      runQualificationCase: async (caseEnv, options) => {
        const budgetProfile = options?.testBudgetProfile;
        if (!budgetProfile) throw new Error('qualification case budget profile is required');
        calls.push({ env: { ...caseEnv }, budgetProfile });
        return receiptForPlanCase(caseEnv, budgetProfile);
      },
      persistCaseReceipt: async (receipt) => ({ receiptPath: 'private/receipt.json', sha256Path: 'private/receipt.sha256',
        receiptSha256: 'f'.repeat(64), idempotent: false }),
      historyArtifacts: async ({ sourceRunId, repairRuns }) => [
        { kind: 'history', runId: sourceRunId, sourceRunId: null, sequenceId: 'ws5-repair-sequence-v1',
          caseId: 'ws5-sequence-a-v1', findingEventId: null,
          recordPath: `${sourceRunId}/ws5-repair-sequence-v1/ws5-sequence-a-v1/history/record.json`,
          recordSha256: '1'.repeat(64), sha256Path: `${sourceRunId}/ws5-repair-sequence-v1/ws5-sequence-a-v1/history/record.json.sha256`,
          sha256FileSha256: '2'.repeat(64) },
        ...repairRuns.map((run) => ({ kind: 'verification-set' as const, runId: run.runId, sourceRunId: run.sourceRunId,
          sequenceId: run.sequenceId, caseId: run.repairCaseId, findingEventId: null,
          recordPath: `${run.runId}/${run.sequenceId}/${run.repairCaseId}/verification-set/record.json`,
          recordSha256: '3'.repeat(64), sha256Path: `${run.runId}/${run.sequenceId}/${run.repairCaseId}/verification-set/record.json.sha256`,
          sha256FileSha256: '4'.repeat(64) })),
      ],
      persistPlanReceipt: async (input) => {
        persistedIndex = assertNormalEngineQualificationPlanReceipt(input);
        return { planPath: '/workspace/.review-yeti/normal-engine-qualification.json',
          sha256Path: '/workspace/.review-yeti/normal-engine-qualification.json.sha256',
          planSha256: '3'.repeat(64), idempotent: false };
      },
      persistCaptureReady: async () => persistedReady as never,
      waitForCapture: async (_env, ready) => {
        captureCalled = true;
        expect(ready?.sha256).toBe('9'.repeat(64));
        return { requested: true, status: 'acknowledged', readySha256: '9'.repeat(64), ackSha256: 'b'.repeat(64),
          artifactSetSha256: 'a'.repeat(64), artifactCount: readyArtifacts.length, reason: null };
      },
      persistCaptureOutcome: persistedCaptureOutcomeMock,
    };

    const result = await runNormalEngineQualificationPlan(planEnv, dependencies).then((value) => value, () => undefined);
    const sourceRunId = parseNormalEngineQualificationRequest(calls[0]!.env).runId;
    const repairCalls = calls.filter(({ env }) => env.REVIEW_NORMAL_ENGINE_QUALIFICATION_CASE_ID === 'ws5-sequence-b-v1');

    expect(calls).toHaveLength(11);
    expect(calls.every(({ env }) => env.UNDECLARED_QUALIFICATION_INPUT === undefined)).toBe(true);
    expect(new Set(calls.map(({ env }) => env.REVIEW_NORMAL_ENGINE_QUALIFICATION_RUN_ID)).size).toBe(11);
    expect(repairCalls).toHaveLength(5);
    expect(repairCalls.map(({ env }) => env.REVIEW_NORMAL_ENGINE_QUALIFICATION_HISTORY_RUN_ID)).toEqual([
      sourceRunId, sourceRunId, undefined, sourceRunId, sourceRunId,
    ]);
    expect(repairCalls[0]!.env.REVIEW_NORMAL_ENGINE_QUALIFICATION_RUN_ID)
      .not.toBe(repairCalls[1]!.env.REVIEW_NORMAL_ENGINE_QUALIFICATION_RUN_ID);
    const adjudicatorCall = calls.find(({ env }) => env.REVIEW_NORMAL_ENGINE_QUALIFICATION_ARM === 'adjudicator-recheck');
    expect(adjudicatorCall).toBeDefined();
    expect(adjudicatorCall?.env.REVIEW_NORMAL_ENGINE_QUALIFICATION_CASE_ID).toBe('ws5-sequence-a-v1');
    expect(adjudicatorCall?.env.REVIEW_NORMAL_ENGINE_QUALIFICATION_HISTORY_RUN_ID).toBe(sourceRunId);
    expect(adjudicatorCall?.env.REVIEW_NORMAL_ENGINE_QUALIFICATION_RUN_ID).not.toBe(sourceRunId);
    expect(result).toMatchObject({ caseCount: 11, expectedReceiptCount: 11, completedReceiptCount: 11,
      receiptSetComplete: true, historyArtifactSetComplete: true, terminal: { status: 'completed' } });
    expect(persistedIndex).toEqual(result);
    expect(captureCalled).toBe(true);
    expect(persistedCaptureOutcome).toMatchObject({ schemaVersion: 'NormalEngineQualificationCaptureOutcome.v1',
      planTerminalStatus: 'completed', captureRequested: true, captureStatus: 'acknowledged',
      readySha256: '9'.repeat(64), ackSha256: 'b'.repeat(64), artifactSetSha256: 'a'.repeat(64) });
    expect(result).toBeDefined();

    calls.length = 0;
    let timeoutOutcome: unknown;
    dependencies.waitForCapture = async () => ({ requested: true, status: 'timed_out', readySha256: '9'.repeat(64),
      ackSha256: null, artifactSetSha256: 'a'.repeat(64), artifactCount: readyArtifacts.length, reason: 'ack-timeout' });
    dependencies.persistCaptureOutcome = captureOutcomePersistenceStub((input) => { timeoutOutcome = input; });
    await expect(runNormalEngineQualificationPlan(planEnv, dependencies))
      .rejects.toThrow(/normal_engine_qualification_capture_failed/u);
    expect(persistedIndex?.terminal.status).toBe('completed');
    expect(timeoutOutcome).toMatchObject({ captureRequested: true, captureStatus: 'timed_out',
      planTerminalStatus: 'completed', captureReason: 'ack-timeout' });
  });

  it('refuses the additional consumer arm before invocation when phase A lost the configured selector pin', async () => {
    const planEnv: NodeJS.ProcessEnv = { ...VALID_ENV,
      REVIEW_NORMAL_ENGINE_QUALIFICATION_PLAN: 'ws6-normal-canary-v1',
      REVIEW_NORMAL_ENGINE_QUALIFICATION_CONFIG_VARIANT: 'configured-disputed-blocker-adjudicator-v1',
    };
    delete planEnv.REVIEW_NORMAL_ENGINE_QUALIFICATION_CASE_ID;
    delete planEnv.REVIEW_NORMAL_ENGINE_QUALIFICATION_ARM;
    const observedArms: string[] = [];
    let persistedIndex: ReturnType<typeof assertNormalEngineQualificationPlanReceipt> | undefined;
    const dependencies: NormalEngineQualificationWorkerDependencies = {
      verifyRuntimeManifest: async () => VALID_ENV.REVIEW_NORMAL_ENGINE_QUALIFICATION_RUNTIME_MANIFEST_SHA256!,
      runQualificationCase: async (caseEnv, options) => {
        const profile = options?.testBudgetProfile;
        if (!profile) throw new Error('qualification case budget profile is required');
        observedArms.push(caseEnv.REVIEW_NORMAL_ENGINE_QUALIFICATION_ARM!);
        const receipt = receiptForPlanCase(caseEnv, profile);
        return receipt.arm === 'repair-introduction'
          ? assertNormalEngineQualificationReceipt({ ...receipt, policy: { ...receipt.policy,
            disputedBlockerAdjudicator: { state: 'unconfigured', modelAlias: null, reasoningEffort: null } } })
          : receipt;
      },
      persistCaseReceipt: async () => ({ receiptPath: 'private/receipt.json', sha256Path: 'private/receipt.sha256',
        receiptSha256: 'f'.repeat(64), idempotent: false }),
      historyArtifacts: async ({ sourceRunId, repairRuns }) => [
        { kind: 'history', runId: sourceRunId, sourceRunId: null, sequenceId: 'ws5-repair-sequence-v1',
          caseId: 'ws5-sequence-a-v1', findingEventId: null,
          recordPath: `${sourceRunId}/ws5-repair-sequence-v1/ws5-sequence-a-v1/history/record.json`,
          recordSha256: '1'.repeat(64), sha256Path: `${sourceRunId}/ws5-repair-sequence-v1/ws5-sequence-a-v1/history/record.json.sha256`,
          sha256FileSha256: '2'.repeat(64) },
        ...repairRuns.filter((run) => run.repairCaseId === 'ws5-sequence-b-v1').map((run) => ({
          kind: 'verification-set' as const, runId: run.runId, sourceRunId: run.sourceRunId,
          sequenceId: run.sequenceId, caseId: run.repairCaseId, findingEventId: null,
          recordPath: `${run.runId}/${run.sequenceId}/${run.repairCaseId}/verification-set/record.json`,
          recordSha256: '3'.repeat(64), sha256Path: `${run.runId}/${run.sequenceId}/${run.repairCaseId}/verification-set/record.json.sha256`,
          sha256FileSha256: '4'.repeat(64),
        })),
      ],
      persistPlanReceipt: async (input) => {
        persistedIndex = assertNormalEngineQualificationPlanReceipt(input);
        return { planPath: '/workspace/.review-yeti/normal-engine-qualification.json',
          sha256Path: '/workspace/.review-yeti/normal-engine-qualification.json.sha256',
          planSha256: '3'.repeat(64), idempotent: false };
      },
      waitForCapture: async () => noCaptureWaitResult(),
      persistCaptureOutcome: captureOutcomePersistenceStub(),
    };

    await expect(runNormalEngineQualificationPlan(planEnv, dependencies))
      .rejects.toThrow(/normal_engine_qualification_plan_incomplete/u);
    expect(observedArms).toHaveLength(10);
    expect(observedArms).not.toContain('adjudicator-recheck');
    expect(persistedIndex).toMatchObject({ expectedReceiptCount: 11, completedReceiptCount: 10,
      receiptSetComplete: false, terminal: { status: 'failed' } });
  });

  it('persists a typed partial index and exits failed when a case cannot produce a receipt', async () => {
    const planEnv: NodeJS.ProcessEnv = { ...VALID_ENV, REVIEW_NORMAL_ENGINE_QUALIFICATION_PLAN: 'ws6-normal-canary-v1',
      REVIEW_NORMAL_ENGINE_QUALIFICATION_CONFIG_VARIANT: 'configured-disputed-blocker-adjudicator-v1' };
    delete planEnv.REVIEW_NORMAL_ENGINE_QUALIFICATION_CASE_ID;
    delete planEnv.REVIEW_NORMAL_ENGINE_QUALIFICATION_ARM;
    const rootRunIds: string[] = [];
    let persistedIndex: ReturnType<typeof assertNormalEngineQualificationPlanReceipt> | undefined;
    let capturedAfterIndex = false;
    const dependencies: NormalEngineQualificationWorkerDependencies = {
      verifyRuntimeManifest: async () => VALID_ENV.REVIEW_NORMAL_ENGINE_QUALIFICATION_RUNTIME_MANIFEST_SHA256!,
      runQualificationCase: async (caseEnv, options) => {
        rootRunIds.push(caseEnv.REVIEW_NORMAL_ENGINE_QUALIFICATION_RUN_ID!);
        if (rootRunIds.length === 2) throw new Error('fixture execution fault');
        const budgetProfile = options?.testBudgetProfile;
        if (!budgetProfile) throw new Error('qualification case budget profile is required');
        return receiptForPlanCase(caseEnv, budgetProfile);
      },
      persistCaseReceipt: async () => ({ receiptPath: 'private/receipt.json', sha256Path: 'private/receipt.sha256',
        receiptSha256: 'f'.repeat(64), idempotent: false }),
      historyArtifacts: async ({ sourceRunId, repairRuns }) => [
        { kind: 'history', runId: sourceRunId, sourceRunId: null, sequenceId: 'ws5-repair-sequence-v1',
          caseId: 'ws5-sequence-a-v1', findingEventId: null,
          recordPath: `${sourceRunId}/ws5-repair-sequence-v1/ws5-sequence-a-v1/history/record.json`,
          recordSha256: '1'.repeat(64), sha256Path: `${sourceRunId}/ws5-repair-sequence-v1/ws5-sequence-a-v1/history/record.json.sha256`,
          sha256FileSha256: '2'.repeat(64) },
        ...repairRuns.map((run) => ({ kind: 'verification-set' as const, runId: run.runId, sourceRunId: run.sourceRunId,
          sequenceId: run.sequenceId, caseId: run.repairCaseId, findingEventId: null,
          recordPath: `${run.runId}/${run.sequenceId}/${run.repairCaseId}/verification-set/record.json`,
          recordSha256: '3'.repeat(64), sha256Path: `${run.runId}/${run.sequenceId}/${run.repairCaseId}/verification-set/record.json.sha256`,
          sha256FileSha256: '4'.repeat(64) })),
      ],
      persistPlanReceipt: async (input) => {
        persistedIndex = assertNormalEngineQualificationPlanReceipt(input);
        return { planPath: '/workspace/.review-yeti/normal-engine-qualification.json',
          sha256Path: '/workspace/.review-yeti/normal-engine-qualification.json.sha256',
          planSha256: '3'.repeat(64), idempotent: false };
      },
      waitForCapture: async () => { capturedAfterIndex = Boolean(persistedIndex); return noCaptureWaitResult(); },
      persistCaptureOutcome: captureOutcomePersistenceStub(),
    };

    await expect(runNormalEngineQualificationPlan(planEnv, dependencies))
      .rejects.toThrow(/normal_engine_qualification_plan_incomplete/u);
    expect(persistedIndex).toMatchObject({ caseCount: 1, expectedReceiptCount: 11, completedReceiptCount: 1,
      receiptSetComplete: false, historyArtifactSetComplete: false, terminal: { status: 'failed' } });
    expect(capturedAfterIndex).toBe(true);
  });

  it('persists the typed worker-completion composed resource evidence for each qualification case', async () => {
    const policyContent = JSON.stringify({ schema: 'exampleorg.review-policy.v1', review_yeti: {
      personas: 'security', profile: 'balanced', review_engine: 'composed', severity_policy: 'review-yeti-severity.v2',
      budget: { max_investigation_turns: 1 },
    } });
    const source = { repositoryId: 73099, repository: 'synthetic/policy-target', sha: 'a'.repeat(40),
      path: 'policy/review-yeti.json', contentDigest: createHash('sha256').update(policyContent).digest('hex') };
    const transport = { baseUrl: 'https://gateway.example.invalid/v1', model: 'qualification-primary' };
    const prepared = preparePublishingPolicy({ source, content: policyContent }, transport,
      { owner: 'synthetic', repo: 'policy-target' });
    const caseEnv: NodeJS.ProcessEnv = { ...VALID_ENV,
      REVIEW_NORMAL_ENGINE_QUALIFICATION_RUN_ID: 'nq_abcdef0123456789abcdef0123456789',
      REVIEW_NORMAL_ENGINE_QUALIFICATION_CASE_ID: 'ws5-p2-display-sort-v1',
      REVIEW_NORMAL_ENGINE_QUALIFICATION_ARM: 'p2-only',
      REVIEW_POLICY_DIGEST: prepared.policy.effectivePolicyDigest,
      REVIEW_CONFIG_DIGEST: prepared.policy.effectiveConfigDigest,
      REVIEW_PREPARED_CONFIG_JSON: JSON.stringify({ version: 'PreparedReviewExecution.v1',
        config: prepared.config, transport }),
      REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_REPOSITORY_ID: String(source.repositoryId),
      REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_OWNER: 'synthetic',
      REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_REPO: 'policy-target',
      REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_REF: source.sha,
      REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_PATH: source.path,
      REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_SHA256: source.contentDigest,
      REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_TARGET: 'synthetic/policy-target',
      OPENAI_BASE_URL: transport.baseUrl, OPENAI_API_KEY: 'qualification-test-key', REVIEW_MODEL: transport.model,
    };
    const request = parseNormalEngineQualificationRequest(caseEnv);
    const sourceInput = buildNormalEngineQualificationSourceInput(request);
    const sourcePath = sourceInput.source.changedPaths[0]!;
    const patch = sourceInput.source.patches.find((row) => row.path === sourcePath)!.patch;
    const task = { id: 'security', dimension: 'security' as const, paths: [sourcePath],
      question: 'Review the display behavior.', rationale: 'The task owns the changed UI behavior.' };
    const sourceDelivery = { version: 'TaskSourceDelivery.v1' as const, taskId: task.id,
      headSha: request.fixture.headSha, baseSha: request.fixture.baseSha, contextDigests: ['f'.repeat(64)], complete: true,
      files: [{ path: sourcePath, patchDigest: createHash('sha256').update(patch).digest('hex'), totalChars: patch.length,
        ranges: [[0, patch.length] as [number, number]], inline: true }] };
    const observer = new ComposedRuntimeResourceObserver({ configDigest: request.policy.configDigest,
      configuration: prepared.config.review_configuration_receipt });
    observer.configureBudget({ configuredTotalTurns: 1, investigationTurns: 1, verificationReserveTurns: 0 });
    observer.setPlan([task]);
    observer.markTaskStarted(task.id);
    observer.markTaskOutcome(task.id, 'completed', sourceDelivery);
    const observation = observer.snapshot('terminal');
    if (!observation) throw new Error('expected a qualification composed resource snapshot');
    const resources = completeComposedRuntimeResources({ observation,
      configDigest: request.policy.configDigest, verifierCalls: 0 });
    if (!resources) throw new Error('expected worker-stage composed resources');
    const persistedResources = vi.fn(async () => ({
      path: normalEngineQualificationComposedResourcesRelativePath(request.runId, request.phase, request.fixture.caseId),
      sha256: '9'.repeat(64), idempotent: false,
    }));
    const persistedCapture = providerCapturePersistenceStub();
    const completion = {
      version: 'WorkerReviewCompletion.v1', runId: `run_${request.runId.slice(3)}`,
      repositoryId: request.fixture.repository.repositoryId, owner: request.fixture.repository.owner,
      repo: request.fixture.repository.repo, prNumber: request.fixture.prNumber,
      headSha: request.fixture.headSha, baseSha: request.fixture.baseSha,
      policyDigest: request.policy.policyDigest, configDigest: request.policy.configDigest, executionAttempt: 1,
      result: { version: 'WorkerReviewResult.v1', completedAt: '2026-10-06T00:00:10.000Z',
        personas: [{ id: task.id, decision: 'APPROVE', findings: [], sourceDelivery }], taskPlan: [task],
        coverageComplete: true, quorumSatisfied: true, composedResources: resources },
    };
    const result = await runNormalEngineQualificationCase(caseEnv, {
      verifyRuntimeManifest: async () => VALID_ENV.REVIEW_NORMAL_ENGINE_QUALIFICATION_RUNTIME_MANIFEST_SHA256!,
      runPublishingWorker: async (_workerEnv, workerDeps) => {
        await workerDeps.normalEngineQualification!.onWorkerCompletion(completion as never);
        return { verdict: 'SHIP', conclusion: 'success', coverage: { fullPanelComplete: true, groundedReviewComplete: true } } as never;
      },
      persistProviderCapture: persistedCapture,
      persistComposedResources: persistedResources,
      persistCaseReceipt: async () => ({ receiptPath: 'private/receipt.json', sha256Path: 'private/receipt.sha256',
        receiptSha256: 'e'.repeat(64), idempotent: false }),
    });

    expect(persistedResources).toHaveBeenCalledOnce();
    expect(persistedResources).toHaveBeenCalledWith(resources, request.runId, request.phase, request.fixture.caseId);
    expect(persistedCapture).toHaveBeenCalledOnce();
    expect(persistedCapture.mock.calls[0]?.[0]).toMatchObject({ schemaVersion: 'NormalEngineProviderCapture.v1',
      runId: request.runId, phase: request.phase, caseId: request.fixture.caseId, requests: [] });
    expect(result).toMatchObject({ composedResourcesStatus: 'captured',
      composedResourcesPath: normalEngineQualificationComposedResourcesRelativePath(request.runId, request.phase, request.fixture.caseId),
      composedResourcesSha256: '9'.repeat(64), composedResourcesUnavailableReason: null });
    expect(result.provider).toMatchObject({ captureStatus: 'captured',
      capturePath: normalEngineQualificationProviderCaptureRelativePath({ runId: request.runId,
        phase: request.phase, caseId: request.fixture.caseId }), captureSha256: '8'.repeat(64), captureUnavailableReason: null });
  });

  it('persists the pre-dispatch-bound metadata-only provider capture with a private checksum', async () => {
    const root = await mkdtemp(join(tmpdir(), 'review-yeti-provider-capture-record-'));
    try {
      const request = parseNormalEngineQualificationRequest(VALID_ENV);
      const input = buildNormalEngineQualificationSourceInput(request);
      const sourceDiff = input.source.patches.map((patch) => patch.patch).join('\n');
      const binding: NormalEngineProviderCaptureBinding = {
        runId: request.runId, phase: request.phase, caseId: request.fixture.caseId,
        runtime: request.runtime,
        target: { kind: 'public-synthetic-fixture', repositoryId: input.source.repository.repositoryId,
          repository: `${input.source.repository.owner}/${input.source.repository.repo}`,
          prNumber: input.source.prNumber, caseId: request.fixture.caseId,
          bundleVersion: request.fixture.bundleVersion, bundleSha256: request.fixture.bundleSha256,
          inputSha256: request.fixture.inputSha256, baseSha: input.source.baseSha, headSha: input.source.headSha,
          diffSha256: createHash('sha256').update(sourceDiff).digest('hex') },
        policy: { targetRepository: request.policy.targetRepository, selectionPurpose: request.policy.selectionPurpose,
          configurationVariant: request.configurationVariant,
          source: { repositoryId: request.policy.sourceRepositoryId, owner: request.policy.sourceOwner,
            repo: request.policy.sourceRepo, ref: request.policy.sourceRef, path: request.policy.sourcePath,
            contentSha256: request.policy.sourceContentSha256 },
          effectivePolicyDigest: request.policy.policyDigest, effectiveConfigDigest: request.policy.configDigest },
        groundedEvidenceSemanticsVersion: GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION,
      };
      const attestor = new NormalEngineQualificationProviderAttestor(async () => new Response('', { status: 200 }));
      attestor.bindCaptureContext(binding);
      const capture = attestor.getCapture();

      const first = await persistNormalEngineQualificationProviderCapture(capture, binding, root);
      const capturePath = join(root, request.runId, request.phase, request.fixture.caseId,
        'provider-capture.record', 'provider-capture.json');
      const checksumPath = join(root, request.runId, request.phase, request.fixture.caseId,
        'provider-capture.record', 'provider-capture.sha256');
      const [body, checksum] = await Promise.all([readFile(capturePath, 'utf8'), readFile(checksumPath, 'utf8')]);
      const fileStat = await stat(capturePath);
      const replay = await persistNormalEngineQualificationProviderCapture(capture, binding, root);

      expect(first).toMatchObject({ path: normalEngineQualificationProviderCaptureRelativePath(binding),
        sha256: createHash('sha256').update(body).digest('hex'), idempotent: false });
      expect(checksum).toBe(`${first.sha256}\n`);
      expect(fileStat.mode & 0o777).toBe(0o600);
      expect(JSON.parse(body)).toMatchObject({ schemaVersion: 'NormalEngineProviderCapture.v1',
        runId: request.runId, phase: request.phase, caseId: request.fixture.caseId, requests: [] });
      expect(body).not.toMatch(/OPENAI_API_KEY|authorization|prompt|responseBody|hidden.reasoning/iu);
      expect(replay).toMatchObject({ sha256: first.sha256, idempotent: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps actual disputed verifier contexts bound to concurrent physical calls without changing wire JSON', async () => {
    const request = parseNormalEngineQualificationRequest(VALID_ENV);
    const fixtureInput = buildNormalEngineQualificationSourceInput(request);
    const fixtureProvider = createNormalEngineQualificationRepoFileProvider(request);
    expect(fixtureInput.source.changedPaths).toEqual(['download-policy.ts', 'download-route.ts']);
    const findings = [
      { severity: 'P1', path: 'download-policy.ts', line: 5, title: 'Unsafe path remains within the download root check' },
      { severity: 'P1', path: 'download-route.ts', line: 5, title: 'Sibling directory bypasses the download root check' },
    ];
    const authenticatedDisputes = findings.map((finding, index) => ({
      findingFingerprint: findingFingerprint(finding),
      priorFindingEventId: index === 0 ? '123e4567-e89b-42d3-a456-426614174000' : '223e4567-e89b-42d3-a456-426614174000',
      priorEvidenceDigest: index === 0 ? 'a'.repeat(64) : 'b'.repeat(64),
    }));
    const binding: NormalEngineProviderCaptureBinding = {
      runId: request.runId, phase: request.phase, caseId: request.fixture.caseId,
      runtime: request.runtime,
      target: { kind: 'public-synthetic-fixture', repositoryId: request.fixture.repository.repositoryId,
        repository: `${request.fixture.repository.owner}/${request.fixture.repository.repo}`,
        prNumber: request.fixture.prNumber, caseId: request.fixture.caseId,
        bundleVersion: request.fixture.bundleVersion, bundleSha256: request.fixture.bundleSha256,
        inputSha256: request.fixture.inputSha256, baseSha: request.fixture.baseSha, headSha: request.fixture.headSha,
        diffSha256: createHash('sha256').update(fixtureInput.source.patches.map((row) => row.patch).join('\n')).digest('hex') },
      policy: { targetRepository: request.policy.targetRepository, selectionPurpose: request.policy.selectionPurpose,
        configurationVariant: request.configurationVariant,
        source: { repositoryId: request.policy.sourceRepositoryId, owner: request.policy.sourceOwner,
          repo: request.policy.sourceRepo, ref: request.policy.sourceRef, path: request.policy.sourcePath,
          contentSha256: request.policy.sourceContentSha256 },
        effectivePolicyDigest: request.policy.policyDigest, effectiveConfigDigest: request.policy.configDigest },
      groundedEvidenceSemanticsVersion: GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION,
    };
    const wireRequests: Array<{ callerRequestId: string; body: string }> = [];
    let releaseResponses!: () => void;
    let signalConcurrentStarts!: () => void;
    const responseGate = new Promise<void>((resolve) => { releaseResponses = resolve; });
    const bothRequestsStarted = new Promise<void>((resolve) => { signalConcurrentStarts = resolve; });
    const attestor = new NormalEngineQualificationProviderAttestor(async (_input, init) => {
      const callerRequestId = new Headers(init?.headers).get('x-request-id') || '';
      const body = String(init?.body ?? '');
      wireRequests.push({ callerRequestId, body });
      if (wireRequests.length === 2) signalConcurrentStarts();
      await responseGate;
      return new Response(JSON.stringify({ id: `synthetic-${wireRequests.length}`, model: 'body-reported-untrusted',
        choices: [{ message: { role: 'assistant', content: JSON.stringify({ status: 'insufficient', citations: [] }) },
          finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    });
    attestor.bindCaptureContext(binding);
    const rawProvider = new OpenRouterClient({ baseUrl: 'https://gateway.example.invalid/v1',
      apiKey: 'unit-test-provider-key', maxRetries: 0, fetchImplementation: attestor.fetch });
    const attestedClient: ReviewModelClient = {
      complete: (modelRequest, context?: GroundedVerifierRequestContextV1) => {
        const routeBinding = context ? { findingFingerprint: context.findingFingerprint, severity: context.severity,
          purpose: context.purpose, requestedRole: context.requestedRole, appliedRole: context.appliedRole,
          configuredAlternateModel: context.configuredAlternateModel, selectedModel: context.selectedModel } : undefined;
        return attestor.run(modelRequest, () => rawProvider.complete(modelRequest), routeBinding ? { routeBinding } : {});
      },
    };
    const limitedClient = withProviderConcurrencyLimit(attestedClient, { localConcurrency: 2 });
    const progress = createPublishingProgress({ runId: `run_${request.runId.slice(3)}`, executionAttempt: 1 });
    const meteredClient = meterModelClient(progress.instrument(limitedClient), new TokenLedger());
    const selection = { version: 'DisputedBlockerAdjudicator.v1' as const,
      model: 'qualified-adjudicator-alias', reasoning_effort: 'high' as const };
    const adjudicator = createDisputedBlockerAdjudicatorClient(meteredClient, selection);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let verificationPromise: ReturnType<typeof runIndependentGroundedVerification> | undefined;
    try {
      const changedFiles = parseChangedFiles(fixtureInput.source.patches.map((row) => row.patch).join('\n'), {
        repository: `${request.fixture.repository.owner}/${request.fixture.repository.repo}`,
        headSha: request.fixture.headSha, baseSha: request.fixture.baseSha,
      }).files;
      verificationPromise = runIndependentGroundedVerification({ findings, changedFiles,
        provider: fixtureProvider, repository: `${request.fixture.repository.owner}/${request.fixture.repository.repo}`,
        headSha: request.fixture.headSha, baseSha: request.fixture.baseSha, model: 'primary-review-alias',
        severityPolicyVersion: REVIEW_SEVERITY_POLICY_V2, verificationVersion: GROUNDED_VERIFICATION_VERSION,
        authenticatedDisputes, disputedBlockerAdjudicator: adjudicator,
        client: meteredClient, budget: { callsPerTask: 2, totalCalls: 2, concurrency: 2,
          callTimeoutMs: 5_000, stageBudgetMs: 30_000 } });
      const dispatchesConcurrent = await Promise.race([
        bothRequestsStarted.then(() => true),
        new Promise<boolean>((resolve) => { timeout = setTimeout(() => resolve(false), 7_000); }),
      ]);
      releaseResponses();
      const completed = await verificationPromise;
      expect(dispatchesConcurrent).toBe(true);
      expect(completed.calls).toBe(2);
      expect(completed.outcomes).toHaveLength(2);
      expect(completed.outcomes.every((row) => row.status === 'insufficient')).toBe(true);
      expect(wireRequests).toHaveLength(2);

      const capture = attestor.getCapture(binding);
      expect(capture.requests.map((row) => row.physicalOrdinal)).toEqual([1, 2]);
      expect(new Set(capture.requests.map((row) => row.cidSha256)).size).toBe(2);
      expect(capture.requests.map((row) => row.routeBinding.findingFingerprint.value).sort())
        .toEqual(authenticatedDisputes.map((row) => row.findingFingerprint).sort());
      for (const row of capture.requests) {
        expect(row.routeBinding).toMatchObject({
          severity: { availability: 'available', value: 'P1' },
          purpose: { availability: 'available', value: 'disputed-blocker-recheck' },
          requestedRole: { availability: 'available', value: 'disputed-blocker-adjudicator' },
          appliedRole: { availability: 'available', value: 'disputed-blocker-adjudicator' },
          configuredAlternateModel: { availability: 'available', value: selection.model },
          selectedModel: { availability: 'available', value: selection.model },
        });
        expect(row.logicalCallIdSha256).toMatchObject({ availability: 'unavailable', value: null });
        const wire = wireRequests.find((item) => createHash('sha256').update(item.callerRequestId).digest('hex') === row.cidSha256);
        expect(wire).toBeDefined();
        expect(row.body).toMatchObject({ status: 'captured',
          sha256: createHash('sha256').update(wire!.body, 'utf8').digest('hex'), byteCount: Buffer.byteLength(wire!.body, 'utf8') });
        const parsedWire = JSON.parse(wire!.body);
        expect(parsedWire.model).toBe(selection.model);
        expect(parsedWire).not.toHaveProperty('routeBinding');
        expect(wire!.body).not.toContain('GroundedVerifierRequestContext.v1');
      }
    } finally {
      clearTimeout(timeout);
      releaseResponses();
      await verificationPromise?.catch(() => undefined);
    }
  }, 15_000);

  it('sends only the in-memory invalid sentinel for the Bifrost authentication control', async () => {
    const { env, model } = providerFailureEnvironment();
    const authorizationHeaders: string[] = [];
    let physicalRequests = 0;
    const fetchImplementation: FetchImplementation = async (_input, init) => {
      physicalRequests += 1;
      authorizationHeaders.push(new Headers(init?.headers).get('authorization') || '');
      return new Response(JSON.stringify({ error: { message: 'unauthorized' } }), {
        status: 401, headers: { 'content-type': 'application/json' },
      });
    };
    let privateIdentifierRows: unknown;
    const persistedCapture = providerCapturePersistenceStub();
    const result = await runNormalEngineQualificationCase(env, {
      verifyRuntimeManifest: async () => VALID_ENV.REVIEW_NORMAL_ENGINE_QUALIFICATION_RUNTIME_MANIFEST_SHA256!,
      providerFetchImplementation: fetchImplementation,
      runPublishingWorker: async (_workerEnv, workerDeps) => {
        expect(_workerEnv.OPENAI_API_KEY).toBe('qualification-invalid-bifrost-inference-key');
        await workerDeps.client!.complete({ model, messages: [{ role: 'user', content: 'synthetic fixture probe' }],
          timeoutMs: 1_000, maxRetries: 0 });
        throw new Error('expected Bifrost authentication rejection');
      },
      persistProviderIdentifiers: async (rows) => {
        privateIdentifierRows = rows;
        return { identifiersPath: 'private/provider-identifiers.json', sha256Path: 'private/provider-identifiers.sha256',
          privateIdentifiersSha256: 'f'.repeat(64), idempotent: false };
      },
      persistProviderCapture: persistedCapture,
      persistCaseReceipt: async () => ({ receiptPath: 'private/receipt.json', sha256Path: 'private/receipt.sha256',
        receiptSha256: 'e'.repeat(64), idempotent: false }),
    } as NormalEngineQualificationWorkerDependencies);

    expect(physicalRequests).toBe(1);
    expect(authorizationHeaders).toEqual(['Bearer qualification-invalid-bifrost-inference-key']);
    expect(privateIdentifierRows).toEqual([expect.objectContaining({
      callerRequestId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      bifrostLogRequestId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    })]);
    expect(persistedCapture).toHaveBeenCalledOnce();
    const unauthorizedCapture = persistedCapture.mock.calls[0]?.[0] as { requests: Array<Record<string, any>> };
    expect(unauthorizedCapture.requests).toHaveLength(1);
    expect(unauthorizedCapture.requests[0]).toMatchObject({ physicalOrdinal: 1, status: 'response_received' });
    expect(unauthorizedCapture.requests[0]?.httpStatus.value).toBe(401);
    expect(result).toMatchObject({ arm: 'provider-failure', terminal: { status: 'incomplete' },
      provider: { calls: [{ httpStatus: 401, fetchFailureClass: 'http_error', contentPersisted: false }] } });
    expect(JSON.stringify(result)).not.toContain('qualification-invalid-bifrost-inference-key');
  });

  it('fails the provider-failure arm when the sentinel is unexpectedly accepted', async () => {
    const { env, model } = providerFailureEnvironment();
    let physicalRequests = 0;
    let authorization = '';
    const fetchImplementation: FetchImplementation = async (_input, init) => {
      physicalRequests += 1;
      authorization = new Headers(init?.headers).get('authorization') || '';
      return new Response(JSON.stringify({ id: 'synthetic', model,
        choices: [{ message: { role: 'assistant', content: '{}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    };
    const persistedCapture = providerCapturePersistenceStub();
    const result = await runNormalEngineQualificationCase(env, {
      verifyRuntimeManifest: async () => VALID_ENV.REVIEW_NORMAL_ENGINE_QUALIFICATION_RUNTIME_MANIFEST_SHA256!,
      providerFetchImplementation: fetchImplementation,
      runPublishingWorker: async (_workerEnv, workerDeps) => {
        await workerDeps.client!.complete({ model, messages: [{ role: 'user', content: 'synthetic fixture probe' }],
          timeoutMs: 1_000, maxRetries: 0 });
        return { conclusion: 'success', verdict: 'SHIP', coverage: {
          fullPanelComplete: true, groundedReviewComplete: true,
        } } as never;
      },
      persistProviderIdentifiers: async () => ({ identifiersPath: 'private/provider-identifiers.json',
        sha256Path: 'private/provider-identifiers.sha256', privateIdentifiersSha256: 'f'.repeat(64), idempotent: false }),
      persistProviderCapture: persistedCapture,
      persistCaseReceipt: async () => ({ receiptPath: 'private/receipt.json', sha256Path: 'private/receipt.sha256',
        receiptSha256: 'e'.repeat(64), idempotent: false }),
    } as NormalEngineQualificationWorkerDependencies);

    expect(physicalRequests).toBe(1);
    expect(authorization).toBe('Bearer qualification-invalid-bifrost-inference-key');
    const acceptedCapture = persistedCapture.mock.calls[0]?.[0] as { requests: Array<Record<string, any>> };
    expect(acceptedCapture.requests).toHaveLength(1);
    expect(acceptedCapture.requests[0]).toMatchObject({ physicalOrdinal: 1, status: 'response_received' });
    expect(acceptedCapture.requests[0]?.httpStatus.value).toBe(200);
    expect(result).toMatchObject({ terminal: { status: 'failed' }, provider: { calls: [{ httpStatus: 200 }] } });
  });

  it('refuses the adjudicator arm before a worker invocation when prepared config lacks the selected alias', async () => {
    const { env } = providerFailureEnvironment();
    env.REVIEW_NORMAL_ENGINE_QUALIFICATION_RUN_ID = 'nq_abcdef0123456789abcdef0123456789';
    env.REVIEW_NORMAL_ENGINE_QUALIFICATION_CASE_ID = 'ws5-sequence-a-v1';
    env.REVIEW_NORMAL_ENGINE_QUALIFICATION_ARM = 'adjudicator-recheck';
    env.REVIEW_NORMAL_ENGINE_QUALIFICATION_CONFIG_VARIANT = 'configured-disputed-blocker-adjudicator-v1';
    env.REVIEW_NORMAL_ENGINE_QUALIFICATION_HISTORY_RUN_ID = 'nq_0123456789abcdef0123456789abcdef';
    delete env.OPENAI_API_KEY;
    env.OPENAI_API_KEY = 'unit-test-no-call';
    const runPublishingWorker = vi.fn();
    const result = await runNormalEngineQualificationCase(env, {
      verifyRuntimeManifest: async () => VALID_ENV.REVIEW_NORMAL_ENGINE_QUALIFICATION_RUNTIME_MANIFEST_SHA256!,
      runPublishingWorker: runPublishingWorker as never,
    }).then((value) => value, (error) => error);

    expect(result).toMatchObject({ message: 'normal_engine_qualification_configuration_variant_mismatch' });
    expect(runPublishingWorker).not.toHaveBeenCalled();
  });

  it('blocks concurrent provider-failure completions before a second physical request', async () => {
    const { env, model } = providerFailureEnvironment();
    let physicalRequests = 0;
    const fetchImplementation: FetchImplementation = async () => {
      physicalRequests += 1;
      return new Response(JSON.stringify({ error: { message: 'unauthorized' } }), {
        status: 401, headers: { 'content-type': 'application/json' },
      });
    };
    const persistedCapture = providerCapturePersistenceStub();
    const result = await runNormalEngineQualificationCase(env, {
      verifyRuntimeManifest: async () => VALID_ENV.REVIEW_NORMAL_ENGINE_QUALIFICATION_RUNTIME_MANIFEST_SHA256!,
      providerFetchImplementation: fetchImplementation,
      runPublishingWorker: async (_workerEnv, workerDeps) => {
        const request = { model, messages: [{ role: 'user' as const, content: 'synthetic fixture probe' }],
          timeoutMs: 1_000, maxRetries: 0 };
        await Promise.allSettled([workerDeps.client!.complete(request), workerDeps.client!.complete(request)]);
        throw new Error('second provider completion was rejected by the fixed fault-arm cap');
      },
      persistProviderIdentifiers: async () => ({ identifiersPath: 'private/provider-identifiers.json',
        sha256Path: 'private/provider-identifiers.sha256', privateIdentifiersSha256: 'f'.repeat(64), idempotent: false }),
      persistProviderCapture: persistedCapture,
      persistCaseReceipt: async () => ({ receiptPath: 'private/receipt.json', sha256Path: 'private/receipt.sha256',
        receiptSha256: 'e'.repeat(64), idempotent: false }),
    } as NormalEngineQualificationWorkerDependencies);

    expect(physicalRequests).toBe(1);
    expect(result.provider.calls).toHaveLength(1);
    expect(persistedCapture.mock.calls[0]?.[0]).toMatchObject({ requests: [expect.objectContaining({ physicalOrdinal: 1 })] });
    expect(result.terminal.status).toBe('failed');
  });

  it('serves pinned head/base content and exact diff from immutable fixture snapshots', async () => {
    const request = parseNormalEngineQualificationRequest(VALID_ENV);
    const input = buildNormalEngineQualificationSourceInput(request);
    const provider = createNormalEngineQualificationRepoFileProvider(request);
    const path = input.source.changedPaths[0]!;
    const expectedHead = (input.source.revisions.find((revision) => revision.commitSha === input.source.headSha)!
      .files as Array<Record<string, unknown>>).find((file) => file.path === path)!;
    const read = await provider.readFileAt!(path, 'head');
    const missing = await provider.readFileAt!('not-in-fixture.ts', 'base');
    const diff = provider.readDiff!(path);

    expect(read).toMatchObject({
      content: expectedHead.content,
      sha: input.source.headSha,
      presence: 'present',
      source: { repository: 'synthetic/fixture-project', path, side: 'head' },
      contentSha256: expectedHead.sha256,
    });
    expect(missing).toMatchObject({ content: null, sha: input.source.baseSha, presence: 'absent',
      source: { repository: 'synthetic/fixture-project', path: 'not-in-fixture.ts', side: 'base' } });
    expect(diff?.patch.trimEnd()).toBe(input.source.patches.find((patch) => patch.path === path)!.patch.trimEnd());
    expect(diff).toMatchObject({
      identity: { repository: 'synthetic/fixture-project', baseSha: input.source.baseSha, headSha: input.source.headSha } });
  });

  it('exports the typed no-hold result from the plan worker entrypoint', async () => {
    await expect(waitForNormalEngineQualificationCapture({ NODE_ENV: 'test' }, null))
      .resolves.toEqual(noCaptureWaitResult());
  });
});
