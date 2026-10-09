import { describe, expect, it, vi } from 'vitest';
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  buildNormalEngineQualificationSourceInput,
  assertNormalEngineQualificationReceipt,
  assertNormalEngineQualificationPlanReceipt,
  parseNormalEngineQualificationRequest,
  persistNormalEngineQualificationReceipt,
  persistNormalEngineQualificationComposedResources,
  persistNormalEngineQualificationProviderIdentifiers,
  normalEngineQualificationComposedResourcesRelativePath,
  projectNormalEngineQualificationOutcomes,
} from '../../src/qualification/normalEngineQualification';
import { runWorker } from '../../src/cli/runLiveReview';
import { NormalEngineQualificationHistoryStore, selectQualificationAdjudicatorRecheckTarget }
  from '../../src/qualification/normalEngineQualificationHistory';
import {
  NormalEngineQualificationProviderAttestor,
  normalEngineQualificationProviderIdentityStatus,
  normalEngineQualificationProviderCaptureRelativePath,
} from '../../src/qualification/normalEngineQualificationProvider';
import { parseNormalEngineQualificationPlanDescriptor } from '../../src/qualification/normalEngineQualificationWorker';
import * as NormalEngineQualificationWorker from '../../src/qualification/normalEngineQualificationWorker';
import { ComposedRuntimeResourceObserver, completeComposedRuntimeResources,
  composedRuntimeResourcesSchema } from '../../src/panel/composedResourceReceipt';

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

function validQualificationReceipt() {
  return {
    schemaVersion: 'ReviewYetiNormalQualification.v1',
    purpose: 'normal-engine-qualification',
    runId: 'nq_0123456789abcdef0123456789abcdef',
    arm: 'single',
    phase: 'single',
    target: {
      kind: 'public-synthetic-fixture',
      repositoryId: 73001,
      repository: 'synthetic/fixture-project',
      prNumber: 41,
      caseId: 'lc_0d8f4a7c2b9e41f8',
      bundleVersion: 'GroundedLifecycleFixtureBundle.v1',
      bundleSha256: '73c7f949da51b0202d6903f795acf10f58b41fd17403ae267bb7297b150f9373',
      inputSha256: '8bd26520e0b3149e0f3b8fdc637f0e5390b737354ee59f53c63e4b32e27b11ef',
      baseSha: 'b5bf7b68ece2f674d88356749aa4575edc5e510d',
      headSha: 'c9b23312180a753ed222814a7ec4380ae0e850a5',
      diffSha256: 'f'.repeat(64),
    },
    runtime: {
      sourceRevision: 'c'.repeat(40),
      workerImageDigest: `sha256:${'d'.repeat(64)}`,
      runtimeManifestSha256: 'e'.repeat(64),
    },
    policy: {
      targetRepository: 'synthetic/policy-target',
      selectionPurpose: 'qualification-only-target-binding',
      configurationVariant: 'prepared-policy-default-v1',
      source: {
        repositoryId: 73099,
        owner: 'synthetic',
        repo: 'policy-target',
        ref: 'a'.repeat(40),
        path: 'policy/review-yeti.json',
        contentSha256: 'b'.repeat(64),
      },
      effectivePolicyDigest: 'a'.repeat(64),
      effectiveConfigDigest: 'b'.repeat(64),
      groundedEvidenceSemanticsVersion: 'GroundedReviewEvidenceSemantics.v2',
      disputedBlockerAdjudicator: { state: 'unconfigured', modelAlias: null, reasoningEffort: null },
      engine: 'composed',
      severityPolicy: 'review-yeti-severity.v2',
    },
    history: {
      purpose: 'normal-engine-qualification-history',
      source: 'unavailable',
      loadStatus: 'unavailable',
      snapshotIdSha256: null,
      contextDigest: null,
      parentRunIdSha256: null,
      authenticatedDisputeSelection: null,
    },
    outcome: {
      workerOutcomeClass: 'completed_eligible',
      gateOutcomeClass: 'completed_eligible',
      agreement: 'agreement',
      workerCompletionSha256: '1'.repeat(64),
      canonicalEvidenceSha256: '2'.repeat(64),
      gateDecisionSha256: '3'.repeat(64),
    },
    composedLimits: { configuredTotalTurns: 200, investigationTurns: 188, verificationReserveTurns: 12,
      maxFindings: 25, maxConcurrentTasks: 3, ambientOverrides: 'absent' },
    composedResourcesStatus: 'captured',
    composedResourcesPath: normalEngineQualificationComposedResourcesRelativePath(
      'nq_0123456789abcdef0123456789abcdef', 'single', 'lc_0d8f4a7c2b9e41f8'),
    composedResourcesSha256: '9'.repeat(64),
    composedResourcesUnavailableReason: null,
    groundedVerification: { evidenceSemanticsVersion: 'GroundedReviewEvidenceSemantics.v2', callCount: 0, outcomeCount: 0,
      coverageComplete: true, routeReceipts: [] },
    qualificationControl: 'none',
    testBudget: { profile: 'prepared-policy-default', panelBudgetSeconds: null,
      maxPhysicalModelRequests: null, terminalDeadlineAt: null, resourceExhaustion: null },
    provider: {
      identityStatus: 'unknown',
      upstreamProviderIdentity: 'unknown',
      exactBifrostLogStatus: 'not_available',
      privateIdentifiersSha256: null,
      captureStatus: 'captured',
      capturePath: normalEngineQualificationProviderCaptureRelativePath({
        runId: 'nq_0123456789abcdef0123456789abcdef', phase: 'single', caseId: 'lc_0d8f4a7c2b9e41f8',
      }),
      captureSha256: '8'.repeat(64),
      captureUnavailableReason: null,
      calls: [],
    },
    publication: {
      mode: 'disabled',
      githubWrites: 0,
      appChecks: 0,
      reviews: 0,
      comments: 0,
      ordinaryGateTouched: false,
      promptsPersisted: false,
      responsesPersisted: false,
      providerCredentialsPersisted: false,
    },
    terminal: {
      status: 'completed',
      startedAt: '2026-10-06T00:00:00.000Z',
      completedAt: '2026-10-06T00:00:10.000Z',
    },
  };
}

function repairHistoryState() {
  const snapshotId = '123e4567-e89b-12d3-a456-426614174000';
  const eventId = '223e4567-e89b-12d3-a456-426614174000';
  const findingId = '323e4567-e89b-12d3-a456-426614174000';
  const contextDigest = 'f'.repeat(64);
  const events = [{ eventId, eventType: 'finding-observed', runId: 'run_0123456789abcdef0123456789abcdef',
    executionAttempt: 1, evidenceSemanticsVersion: 'GroundedReviewEvidenceSemantics.v2' as const,
    headSha: '1035dc8db9a222447aa774fd9660c224e5d37655',
    baseSha: '1fd9256afcf0250975c69410a766629c4d4225ad', policyDigest: 'a'.repeat(64),
    configDigest: 'b'.repeat(64), contextDigest, evidenceDigest: 'd'.repeat(64), verificationStatus: 'confirmed' as const,
    verification: { findingEventId: findingId, fingerprint: `fp1_${'a'.repeat(24)}`, status: 'confirmed' as const,
      currentAffectedContextDigest: contextDigest } }];
  const findings = [{ findingEventId: findingId, fingerprint: `fp1_${'a'.repeat(24)}`, path: 'src/interval.ts',
    regionStart: 3, regionEnd: 3, firstSeenHead: '1035dc8db9a222447aa774fd9660c224e5d37655',
    lastSeenHead: '1035dc8db9a222447aa774fd9660c224e5d37655', affectedContextDigest: contextDigest,
    sourceSeverity: 'P1', effectiveSeverity: 'P1', disposition: 'open', blocking: true,
    verificationStatus: 'confirmed' as const, evidenceDigest: 'd'.repeat(64) }];
  return {
    schemaVersion: 'ReviewYetiNormalQualificationHistory.v2',
    purpose: 'normal-engine-qualification-history',
    evidenceSemanticsVersion: 'GroundedReviewEvidenceSemantics.v2',
    configurationVariant: 'configured-disputed-blocker-adjudicator-v1',
    executionAttempt: 1,
    disputedBlockerAdjudicator: { state: 'available', modelAlias: 'bifrost/qualification-adjudicator', reasoningEffort: 'high' },
    adjudicatorRecheckTarget: { path: 'src/interval.ts', findingFingerprint: `fp1_${'a'.repeat(24)}`,
      priorFindingEventId: findingId, priorEvidenceDigest: 'd'.repeat(64) },
    runId: 'nq_0123456789abcdef0123456789abcdef',
    sequenceId: 'ws5-repair-sequence-v1',
    caseId: 'ws5-sequence-a-v1',
    bundleSha256: 'e6b6e359d6c6676c8ab3461b7e576b2d14a77ed92fb7178b0ba0b6cc69d14329',
    inputSha256: '31feff802596e9e8b52aa45b64a1a00fc2af5e221158815c007188b3b11877a5',
    repairCaseId: 'ws5-sequence-b-v1',
    repairInputSha256: '4023515cfc0daef0b1c00089924ca12d5071080da4e97d6e964c03c8596bbceb',
    repositoryId: 73002,
    repository: 'synthetic/fixture-sequence',
    baseSha: '1fd9256afcf0250975c69410a766629c4d4225ad',
    headSha: '1035dc8db9a222447aa774fd9660c224e5d37655',
    repairBaseSha: '1035dc8db9a222447aa774fd9660c224e5d37655',
    repairHeadSha: '1b183caf5f8c518a3acda3fb2d8eea38133eed98',
    policyDigest: 'a'.repeat(64),
    configDigest: 'b'.repeat(64),
    workerCompletionSha256: '6'.repeat(64),
    canonicalEvidenceSha256: '7'.repeat(64),
    gateDecisionSha256: '8'.repeat(64),
    historyLoad: {
      status: 'complete' as const, snapshotId, contextDigest, events, findings,
      eventCount: 1, findingCount: 1, loadedEventCount: 1, loadedFindingCount: 1,
      eventOmittedCount: 0, findingOmittedCount: 0, legacyOmittedCount: 0,
      eventsDigest: createHash('sha256').update(JSON.stringify([eventId])).digest('hex'),
      findingsDigest: createHash('sha256').update(JSON.stringify([findingId])).digest('hex'),
      omissions: [],
    },
  };
}

function validQualificationPlanReceipt() {
  const plan = parseNormalEngineQualificationPlanDescriptor();
  const rootRunId = 'nq_0123456789abcdef0123456789abcdef';
  const cases = plan.steps.map((step) => {
    const runId = `nq_${createHash('sha256').update(`ws6-normal-canary-v1:${rootRunId}:${step.descriptorRunId}`).digest('hex').slice(0, 32)}`;
    return {
      arm: step.arm,
      caseId: step.caseId,
      runId,
      phase: step.phase,
      configurationVariant: 'configured-disputed-blocker-adjudicator-v1',
      inputSha256: step.inputSha256,
      bundleSha256: step.bundleSha256,
      receiptPath: `normal-engine-qualification-store/${runId}/${step.phase}/${step.caseId}/receipt.json`,
      receiptSha256: 'f'.repeat(64),
      terminalStatus: ['provider-failure', 'resource-exhaustion', 'repair-head-verifier-unavailable'].includes(step.arm)
        ? 'incomplete' as const : 'completed' as const,
      budgetProfile: step.budgetProfile,
      providerIdentifiersPath: null,
      providerIdentifiersSha256: null,
      providerCaptureStatus: 'captured' as const,
      providerCapturePath: normalEngineQualificationProviderCaptureRelativePath({ runId, phase: step.phase, caseId: step.caseId }),
      providerCaptureSha256: '8'.repeat(64),
      providerCaptureUnavailableReason: null,
      composedResourcesPath: normalEngineQualificationComposedResourcesRelativePath(runId, step.phase, step.caseId),
      composedResourcesSha256: '9'.repeat(64),
      composedResourcesStatus: 'captured' as const,
      composedResourcesUnavailableReason: null,
    };
  });
  const sourceRunId = cases[0]!.runId;
  const historyArtifacts = [{ kind: 'history' as const, runId: sourceRunId, sourceRunId: null,
    sequenceId: 'ws5-repair-sequence-v1', caseId: 'ws5-sequence-a-v1', findingEventId: null,
    recordPath: `normal-engine-qualification-store/${sourceRunId}/ws5-repair-sequence-v1/ws5-sequence-a-v1/history/record.json`,
    recordSha256: '1'.repeat(64),
    sha256Path: `normal-engine-qualification-store/${sourceRunId}/ws5-repair-sequence-v1/ws5-sequence-a-v1/history/record.json.sha256`,
    sha256FileSha256: '2'.repeat(64) },
  ...cases.filter((item) => ['repair-head-history', 'repair-head-repeat', 'repair-head-empty-history',
    'repair-head-history-unavailable', 'repair-head-verifier-unavailable', 'adjudicator-recheck'].includes(item.arm)).map((item) => ({
    kind: 'verification-set' as const, runId: item.runId,
    sourceRunId: item.arm === 'repair-head-empty-history' ? null : sourceRunId,
    sequenceId: 'ws5-repair-sequence-v1', caseId: item.caseId, findingEventId: null,
    recordPath: `normal-engine-qualification-store/${item.runId}/ws5-repair-sequence-v1/${item.caseId}/verification-set/record.json`,
    recordSha256: '3'.repeat(64),
    sha256Path: `normal-engine-qualification-store/${item.runId}/ws5-repair-sequence-v1/${item.caseId}/verification-set/record.json.sha256`,
    sha256FileSha256: '4'.repeat(64),
  }))];
  return {
    schemaVersion: 'ReviewYetiNormalQualificationPlan.v1',
    purpose: 'normal-engine-qualification-plan',
    planId: 'ws6-normal-canary-v1',
    runId: rootRunId,
    descriptorSha256: plan.descriptorSha256,
    runtime: { sourceRevision: 'c'.repeat(40), workerImageDigest: `sha256:${'d'.repeat(64)}`, runtimeManifestSha256: 'e'.repeat(64) },
    policy: {
      targetRepository: 'synthetic/policy-target',
      selectionPurpose: 'qualification-only-target-binding',
      configurationVariant: 'configured-disputed-blocker-adjudicator-v1',
      source: { repositoryId: 73099, owner: 'synthetic', repo: 'policy-target', ref: 'a'.repeat(40),
        path: 'policy/review-yeti.json', contentSha256: 'b'.repeat(64) },
      effectivePolicyDigest: 'a'.repeat(64), effectiveConfigDigest: 'b'.repeat(64),
    },
    cases,
    historyArtifacts,
    historyArtifactSetComplete: true,
    caseCount: cases.length, expectedReceiptCount: plan.steps.length, completedReceiptCount: cases.length, receiptSetComplete: true,
    publication: { mode: 'disabled', githubWrites: 0, appChecks: 0, reviews: 0, comments: 0,
      ordinaryGateTouched: false, promptsPersisted: false, responsesPersisted: false, providerCredentialsPersisted: false },
    terminal: { status: 'completed', startedAt: '2026-10-06T00:00:00.000Z', completedAt: '2026-10-06T00:01:00.000Z' },
  };
}

describe('normal-engine qualification admission contract', () => {
  it('retains the final P1 claim and grounded source citations in the private case receipt', () => {
    const receipt = validQualificationReceipt() as any;
    receipt.arm = 'repair-introduction';
    receipt.phase = 'repair-introduction';
    receipt.target = { ...receipt.target, repositoryId: 73002, repository: 'synthetic/fixture-sequence', prNumber: 41,
      caseId: 'ws5-current-1dd-v2-sequence-a', bundleVersion: 'WS5ExternalNormalBundle.v2',
      bundleSha256: '99b707383ec16eea3ef81994c623e956f551a1e9d0b6acf2dd503afc5d41cfe1',
      inputSha256: '0e3bade3d6d7a148a2a36515ed1b40b9c1ab3f4cc2b2d92343176f2069ca0da9',
      baseSha: '1fd9256afcf0250975c69410a766629c4d4225ad', headSha: '1035dc8db9a222447aa774fd9660c224e5d37655' };
    receipt.composedResourcesPath = normalEngineQualificationComposedResourcesRelativePath(receipt.runId,
      'repair-introduction', receipt.target.caseId);
    receipt.provider.capturePath = normalEngineQualificationProviderCaptureRelativePath({
      runId: receipt.runId, phase: 'repair-introduction', caseId: receipt.target.caseId,
    });
    receipt.canonicalReviewEvidence = { decisionClassification: 'FIX_FIRST',
      counts: { p0Count: 0, p1Count: 1, p2Count: 0, p3Count: 0, nitCount: 0 }, coverageComplete: true,
      quorumSatisfied: true, blockingFindings: [{ fingerprintSha256: 'c'.repeat(64), severity: 'P1',
        path: 'audience-policy.ts', line: 17, title: 'A missing audience selects the permissive route',
        claim: 'Requests without an audience can pass the allowlist and select a route that requires another audience.',
        blockerEvidence: { trigger: 'The request omits the audience field.',
          impact: 'The route accepts a caller it should reject.', violatedContract: 'The selected route audience must be enforced.' },
        verificationStatus: 'confirmed', causalScope: 'introduced',
        sourceReviewIdentitySha256: 'd'.repeat(64),
        reviewIdentity: { repository: 'synthetic/fixture-sequence', baseSha: '1fd9256afcf0250975c69410a766629c4d4225ad',
          headSha: '1035dc8db9a222447aa774fd9660c224e5d37655' },
        scopeEvidenceSha256: 'e'.repeat(64), blockerEvidenceSha256: 'f'.repeat(64),
        citationEvidence: { sourceWindowManifestDigest: '1'.repeat(64), usedCitationIds: ['head-audience-policy'],
          citations: [{ id: 'head-audience-policy', path: 'audience-policy.ts', repository: 'synthetic/fixture-sequence',
            side: 'head', revisionSha: '1035dc8db9a222447aa774fd9660c224e5d37655',
            headSha: '1035dc8db9a222447aa774fd9660c224e5d37655', baseSha: '1fd9256afcf0250975c69410a766629c4d4225ad',
            sourceDigest: '2'.repeat(64), window: null }] } }] };
    const parsed = assertNormalEngineQualificationReceipt(receipt);
    expect(parsed.canonicalReviewEvidence?.blockingFindings[0]).toMatchObject({
      title: 'A missing audience selects the permissive route',
      claim: expect.stringContaining('select a route'),
      citationEvidence: { citations: [{ id: 'head-audience-policy', path: 'audience-policy.ts', side: 'head' }] },
    });
  });

  it('binds each qualification receipt to the exact grounded v2 semantics', () => {
    const receipt = validQualificationReceipt();
    expect(assertNormalEngineQualificationReceipt(receipt).policy.groundedEvidenceSemanticsVersion)
      .toBe('GroundedReviewEvidenceSemantics.v2');
    expect(() => assertNormalEngineQualificationReceipt({
      ...receipt,
      policy: { ...receipt.policy, groundedEvidenceSemanticsVersion: 'GroundedReviewEvidenceSemantics.v1' },
    })).toThrow(/qualification receipt contract is invalid/u);
  });

  it('requires complete grounded v2 coverage for a completed receipt and keeps null metadata diagnostic-only', () => {
    const completed = validQualificationReceipt();
    expect(() => assertNormalEngineQualificationReceipt({
      ...completed,
      composedResourcesStatus: 'unavailable', composedResourcesPath: null, composedResourcesSha256: null,
      composedResourcesUnavailableReason: 'resource-evidence-unavailable',
    })).toThrow(/composed resource/u);
    expect(() => assertNormalEngineQualificationReceipt({
      ...completed,
      groundedVerification: { evidenceSemanticsVersion: null, callCount: null, outcomeCount: null,
        coverageComplete: null, routeReceipts: [] },
    })).toThrow(/completed receipt lacks agreed complete grounded v2 evidence/u);

    const diagnostic = assertNormalEngineQualificationReceipt({
      ...completed,
      outcome: { workerOutcomeClass: 'incomplete', gateOutcomeClass: 'incomplete', agreement: 'incomplete',
        workerCompletionSha256: null, canonicalEvidenceSha256: null, gateDecisionSha256: null },
      groundedVerification: { evidenceSemanticsVersion: null, callCount: null, outcomeCount: null,
        coverageComplete: null, routeReceipts: [] },
      terminal: { ...completed.terminal, status: 'incomplete' },
    });
    expect(diagnostic.terminal.status).toBe('incomplete');
  });

  it('binds verifier route receipts to the prepared alternate selector without trusting response identity', () => {
    const receipt = validQualificationReceipt();
    const modelAlias = 'bifrost/qualification-adjudicator';
    const route = {
      version: 'GroundedVerifierRoute.v1',
      purpose: 'disputed-blocker-recheck',
      requestedRole: 'disputed-blocker-adjudicator',
      appliedRole: 'disputed-blocker-adjudicator',
      configuredAlternateModel: modelAlias,
      selectedModel: modelAlias,
      responseReportedModel: 'model-label-is-untrusted',
      responseModelUnavailableReason: null,
      upstreamIdentity: { providerId: null, model: null,
        unavailableReason: 'signed gateway identity is recorded per physical request' },
    } as const;
    expect(assertNormalEngineQualificationReceipt({
      ...receipt,
      policy: { ...receipt.policy, disputedBlockerAdjudicator: {
        state: 'available', modelAlias, reasoningEffort: 'high',
      } },
      groundedVerification: {
        evidenceSemanticsVersion: 'GroundedReviewEvidenceSemantics.v2',
        callCount: 1, outcomeCount: 1, coverageComplete: true,
        routeReceipts: [{ findingFingerprint: `fp1_${'a'.repeat(24)}`, path: 'src/interval.ts', severity: 'P1',
          status: 'contradicted', route }],
      },
    })).toMatchObject({ groundedVerification: { routeReceipts: [{ route: { appliedRole: 'disputed-blocker-adjudicator',
      upstreamIdentity: { providerId: null, model: null } } }] } });
    expect(() => assertNormalEngineQualificationReceipt({
      ...receipt,
      groundedVerification: {
        evidenceSemanticsVersion: 'GroundedReviewEvidenceSemantics.v2',
        callCount: 1, outcomeCount: 1, coverageComplete: true,
        routeReceipts: [{ findingFingerprint: `fp1_${'a'.repeat(24)}`, path: 'src/interval.ts', severity: 'P1',
          status: 'contradicted', route }],
      },
    })).toThrow(/prepared adjudicator selector/u);
  });

  it('binds a run to one hard-coded neutral fixture and its exact source pins', () => {
    const request = parseNormalEngineQualificationRequest(VALID_ENV);

    expect(request).toMatchObject({
      purpose: 'normal-engine-qualification',
      runId: 'nq_0123456789abcdef0123456789abcdef',
      arm: 'single',
      phase: 'single',
      fixture: {
        bundleVersion: 'GroundedLifecycleFixtureBundle.v1',
        bundleSha256: '73c7f949da51b0202d6903f795acf10f58b41fd17403ae267bb7297b150f9373',
        caseId: 'lc_0d8f4a7c2b9e41f8',
        inputSha256: '8bd26520e0b3149e0f3b8fdc637f0e5390b737354ee59f53c63e4b32e27b11ef',
        repository: { repositoryId: 73001, owner: 'synthetic', repo: 'fixture-project' },
        prNumber: 41,
        baseSha: 'b5bf7b68ece2f674d88356749aa4575edc5e510d',
        headSha: 'c9b23312180a753ed222814a7ec4380ae0e850a5',
      },
      runtime: {
        sourceRevision: 'c'.repeat(40),
        workerImageDigest: `sha256:${'d'.repeat(64)}`,
        runtimeManifestSha256: 'e'.repeat(64),
      },
      policy: {
      targetRepository: 'synthetic/policy-target',
      sourceRef: 'a'.repeat(40),
        sourcePath: 'policy/review-yeti.json',
      sourceContentSha256: 'b'.repeat(64),
        policyDigest: 'a'.repeat(64),
        configDigest: 'b'.repeat(64),
      },
      publicationMode: 'disabled',
    });
    expect(JSON.stringify(request)).not.toMatch(/expectedOutcome|oracle|mergeEligible|reviewCompleted|SHIP/u);
  });

  it.each([
    ['production publishing mode', { REVIEW_PUBLICATION_MODE: 'app-gate' }],
    ['receipt-only worker mode', { REVIEW_RECEIPT_ONLY: 'true' }],
    ['same-head panel mode', { REVIEW_SAME_HEAD_QUALIFICATION_ONLY: 'true' }],
    ['provider-only mode', { REVIEW_PROVIDER_QUALIFICATION_ONLY: 'true' }],
    ['a GitHub installation token', { GH_TOKEN: 'ghs_test' }],
    ['a GitHub workflow token', { GITHUB_TOKEN: 'ghs_test' }],
    ['a check publisher token', { GITHUB_PUBLISH_TOKEN: 'ghs_test' }],
    ['an App private key', { GITHUB_APP_PRIVATE_KEY: 'private' }],
    ['a completion callback URL', { REVIEW_COMPLETION_URL: 'https://review.invalid/completion' }],
    ['a status callback token', { REVIEW_WORKER_TOKEN: 'worker-token' }],
    ['a preexisting check identity', { REVIEW_CHECK_ID: '123' }],
    ['a caller-selected fixture path', { REVIEW_NORMAL_ENGINE_QUALIFICATION_FIXTURE_ROOT: '/tmp/untrusted' }],
    ['a synthetic fixture claimed as policy target', { REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_TARGET: 'synthetic/fixture-project' }],
    ['an ordinary App selection purpose', { REVIEW_NORMAL_ENGINE_QUALIFICATION_SELECTION_PURPOSE: 'ordinary-app-review' }],
    ['a policy target that differs from the source repository', { REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_REPO: 'other-policy' }],
    ['an oracle payload', { REVIEW_NORMAL_ENGINE_QUALIFICATION_ORACLE_JSON: '{"expected":"BLOCK"}' }],
    ['a target-binding purpose substitution', { REVIEW_NORMAL_ENGINE_QUALIFICATION_SELECTION_PURPOSE: 'ordinary-app-review' }],
    ['an override of global passthrough', { REVIEW_YETI_PASSTHROUGH: 'false' }],
  ])('rejects %s before selecting a worker path', (_name, override) => {
    expect(() => parseNormalEngineQualificationRequest({ ...VALID_ENV, ...override })).toThrow();
  });

  it.each([
    ['an unlisted fixture', { REVIEW_NORMAL_ENGINE_QUALIFICATION_CASE_ID: 'lc_not-allowlisted' }],
    ['a malformed qualification run id', { REVIEW_NORMAL_ENGINE_QUALIFICATION_RUN_ID: 'run_0123456789abcdef0123456789abcdef' }],
    ['a malformed policy digest', { REVIEW_POLICY_DIGEST: 'not-a-digest' }],
    ['a malformed config digest', { REVIEW_CONFIG_DIGEST: 'not-a-digest' }],
    ['a missing prepared effective config', { REVIEW_PREPARED_CONFIG_JSON: '' }],
  ])('refuses %s instead of falling through to ordinary review', (_name, override) => {
    expect(() => parseNormalEngineQualificationRequest({ ...VALID_ENV, ...override })).toThrow();
  });

  it('projects only pinned source input, excluding candidate labels and oracle-side fields', () => {
    const request = parseNormalEngineQualificationRequest(VALID_ENV);
    const input = buildNormalEngineQualificationSourceInput(request);

    expect(input).toMatchObject({
      fixtureId: 'lc_0d8f4a7c2b9e41f8',
      source: {
        repository: { repositoryId: 73001, owner: 'synthetic', repo: 'fixture-project' },
        prNumber: 41,
        baseSha: 'b5bf7b68ece2f674d88356749aa4575edc5e510d',
        headSha: 'c9b23312180a753ed222814a7ec4380ae0e850a5',
        changedPaths: ['download-policy.ts', 'download-route.ts'],
      },
    });
    expect(input).not.toHaveProperty('candidates');
    expect(input).not.toHaveProperty('history');
    expect(input).not.toHaveProperty('replay');
    expect(input).not.toHaveProperty('proposerFindings');
    expect(JSON.stringify(input)).not.toMatch(/expectedOutcome|GroundedLifecycleOracle/u);
  });

  it.each([
    ['repair introduction', 'ws5-sequence-a-v1', 'repair-introduction', null, 'repair-introduction', 1, 2],
    ['repair with stored history', 'ws5-sequence-b-v1', 'repair-head-history', 'nq_11111111111111111111111111111111', 'repair-head', 2, 3],
    ['fresh repeat with stored history', 'ws5-sequence-b-v1', 'repair-head-repeat', 'nq_11111111111111111111111111111111', 'repair-head', 2, 3],
    ['empty-history ablation', 'ws5-sequence-b-v1', 'repair-head-empty-history', null, 'repair-head', 2, 3],
    ['unavailable-history fallback', 'ws5-sequence-b-v1', 'repair-head-history-unavailable', 'nq_11111111111111111111111111111111', 'repair-head', 2, 3],
    ['verifier-unavailable control', 'ws5-sequence-b-v1', 'repair-head-verifier-unavailable', 'nq_11111111111111111111111111111111', 'repair-head', 2, 3],
    ['large cross-file introduction', 'ws5-large-crossfile-v1', 'large-crossfile', null, 'single', 24, 2],
  ] as const)('accepts frozen %s source and exposes no oracle fields', (_name, caseId, arm, historyRunId, phase, changedCount, revisionCount) => {
    const env: NodeJS.ProcessEnv = {
      ...VALID_ENV,
      REVIEW_NORMAL_ENGINE_QUALIFICATION_RUN_ID: 'nq_0123456789abcdef0123456789abcdef',
      REVIEW_NORMAL_ENGINE_QUALIFICATION_CASE_ID: caseId,
      REVIEW_NORMAL_ENGINE_QUALIFICATION_ARM: arm,
      ...(historyRunId ? { REVIEW_NORMAL_ENGINE_QUALIFICATION_HISTORY_RUN_ID: historyRunId } : {}),
    };
    const request = parseNormalEngineQualificationRequest(env);
    const input = buildNormalEngineQualificationSourceInput(request);

    expect(request).toMatchObject({ arm, phase, historyRunId, fixture: { caseId } });
    expect(input.source.changedPaths).toHaveLength(changedCount);
    expect(input.source.revisions).toHaveLength(revisionCount);
    expect(input.source.revisions.every((revision) => Array.isArray(revision.files))).toBe(true);
    expect(input.source.revisions.map((revision) => revision.commitSha)).toContain(request.fixture.headSha);
    expect(input).not.toHaveProperty('candidates');
    expect(input).not.toHaveProperty('history');
    expect(JSON.stringify(input)).not.toMatch(/expectedOutcome|GroundedLifecycleOracle|WS5.*Oracle/iu);
  });

  it('requires distinct source-run lineage for repair history arms', () => {
    const repair = {
      ...VALID_ENV,
      REVIEW_NORMAL_ENGINE_QUALIFICATION_CASE_ID: 'ws5-sequence-b-v1',
      REVIEW_NORMAL_ENGINE_QUALIFICATION_ARM: 'repair-head-repeat',
    };
    expect(() => parseNormalEngineQualificationRequest(repair)).toThrow();
    expect(() => parseNormalEngineQualificationRequest({ ...repair,
      REVIEW_NORMAL_ENGINE_QUALIFICATION_HISTORY_RUN_ID: VALID_ENV.REVIEW_NORMAL_ENGINE_QUALIFICATION_RUN_ID,
    })).toThrow();
    expect(parseNormalEngineQualificationRequest({ ...repair,
      REVIEW_NORMAL_ENGINE_QUALIFICATION_RUN_ID: 'nq_22222222222222222222222222222222',
      REVIEW_NORMAL_ENGINE_QUALIFICATION_HISTORY_RUN_ID: VALID_ENV.REVIEW_NORMAL_ENGINE_QUALIFICATION_RUN_ID,
    }).historyRunId).toBe('nq_0123456789abcdef0123456789abcdef');
  });

  it('routes the exact qualification purpose before ordinary or legacy review runners', async () => {
    const legacyRunner = vi.fn(async () => undefined);
    const normalRunner = vi.fn(async () => undefined);

    await runWorker(VALID_ENV, legacyRunner, undefined, undefined, undefined, undefined,
      undefined, undefined, normalRunner);

    expect(normalRunner).toHaveBeenCalledOnce();
    expect(normalRunner).toHaveBeenCalledWith(VALID_ENV);
    expect(legacyRunner).not.toHaveBeenCalled();
  });

  it.each([
    ['a complete P2-only review', {
      workerConclusion: 'success', workerVerdict: 'SHIP', workerCoverageComplete: true,
      gateDecision: { status: 'success', eligible: true, reason: 'clean-review' }, gateEvidenceValid: true,
    }, { workerOutcomeClass: 'completed_eligible', gateOutcomeClass: 'completed_eligible', agreement: 'agreement' }],
    ['a verified P1 regression', {
      workerConclusion: 'failure', workerVerdict: 'FIX_FIRST', workerCoverageComplete: true,
      gateDecision: { status: 'failure', eligible: false, reason: 'blocking-findings' }, gateEvidenceValid: true,
    }, { workerOutcomeClass: 'completed_ineligible', gateOutcomeClass: 'completed_ineligible', agreement: 'agreement' }],
    ['an unavailable provider result', {
      workerConclusion: 'failure', workerVerdict: 'INCOMPLETE', workerCoverageComplete: false,
      gateDecision: { status: 'failure', eligible: false, reason: 'incomplete-review' }, gateEvidenceValid: true,
    }, { workerOutcomeClass: 'incomplete', gateOutcomeClass: 'incomplete', agreement: 'agreement' }],
  ])('projects %s to qualification-only outcome enums', (_name, input, expected) => {
    const projected = projectNormalEngineQualificationOutcomes(input);

    expect(projected).toEqual(expected);
    expect(JSON.stringify(projected)).not.toMatch(/SHIP|FIX_FIRST|BLOCK|reviewCompleted|mergeEligible|checkId|appId/u);
  });

  it('persists terminal qualification output atomically and idempotently outside the production namespace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'review-yeti-qualification-store-'));
    try {
      const receipt = validQualificationReceipt();
      const first = await persistNormalEngineQualificationReceipt(receipt, root);
      const body = await readFile(first.receiptPath, 'utf8');
      const sidecar = await readFile(first.sha256Path, 'utf8');
      const fileStat = await stat(first.receiptPath);
      const replay = await persistNormalEngineQualificationReceipt(receipt, root);

      expect(first.idempotent).toBe(false);
      expect(first.receiptPath).toContain('/nq_0123456789abcdef0123456789abcdef/single/lc_0d8f4a7c2b9e41f8/receipt.json');
      expect(sidecar).toBe(`${first.receiptSha256}\n`);
      expect(fileStat.mode & 0o777).toBe(0o600);
      expect(body).not.toMatch(/"(?:verdict|conclusion|reviewCompleted|mergeEligible|checkId|appId)"/u);
      expect(replay.idempotent).toBe(true);
      expect(replay.receiptSha256).toBe(first.receiptSha256);
      await expect(persistNormalEngineQualificationReceipt({ ...receipt,
        terminal: { ...receipt.terminal, completedAt: '2026-10-06T00:00:11.000Z' },
      }, root)).rejects.toThrow(/qualification receipt identity conflict/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('persists a receipt into an existing case directory without replacing sibling artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'review-yeti-qualification-existing-case-'));
    try {
      const receipt = validQualificationReceipt();
      const caseDirectory = join(root, receipt.runId, receipt.phase, receipt.target.caseId);
      const providerCapturePath = join(caseDirectory, 'provider-capture.record', 'provider-capture.json');
      const composedResourcesPath = join(caseDirectory, 'composed-resources.record', 'composed-runtime-resources.json');
      await mkdir(join(caseDirectory, 'provider-capture.record'), { recursive: true, mode: 0o700 });
      await mkdir(join(caseDirectory, 'composed-resources.record'), { recursive: true, mode: 0o700 });
      await writeFile(providerCapturePath, '{"fixture":"provider-capture"}\n', { mode: 0o600 });
      await writeFile(composedResourcesPath, '{"fixture":"composed-resources"}\n', { mode: 0o600 });

      const persisted = await persistNormalEngineQualificationReceipt(receipt, root);
      const replay = await persistNormalEngineQualificationReceipt(receipt, root);
      const originalReceipt = await readFile(persisted.receiptPath, 'utf8');
      const originalChecksum = await readFile(persisted.sha256Path, 'utf8');

      expect(persisted.idempotent).toBe(false);
      expect(replay.idempotent).toBe(true);
      expect(await readFile(providerCapturePath, 'utf8')).toBe('{"fixture":"provider-capture"}\n');
      expect(await readFile(composedResourcesPath, 'utf8')).toBe('{"fixture":"composed-resources"}\n');
      expect((await readFile(persisted.sha256Path, 'utf8')).trim()).toBe(persisted.receiptSha256);
      await expect(persistNormalEngineQualificationReceipt({ ...receipt,
        terminal: { ...receipt.terminal, completedAt: '2026-10-06T00:00:11.000Z' },
      }, root)).rejects.toThrow(/qualification receipt identity conflict/u);
      expect(await readFile(persisted.receiptPath, 'utf8')).toBe(originalReceipt);
      expect(await readFile(persisted.sha256Path, 'utf8')).toBe(originalChecksum);
      expect(await readFile(providerCapturePath, 'utf8')).toBe('{"fixture":"provider-capture"}\n');
      expect(await readFile(composedResourcesPath, 'utf8')).toBe('{"fixture":"composed-resources"}\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses to follow a symlinked run directory while persisting a receipt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'review-yeti-qualification-symlink-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'review-yeti-qualification-symlink-target-'));
    try {
      const receipt = validQualificationReceipt();
      await symlink(outside, join(root, receipt.runId), 'dir');

      await expect(persistNormalEngineQualificationReceipt(receipt, root))
        .rejects.toThrow(/qualification store path is invalid/u);
      await expect(lstat(join(outside, receipt.phase))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('persists exact provider request IDs only in a private qualification sidecar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'review-yeti-qualification-provider-ids-'));
    try {
      const ids = [{
        callerRequestId: '11111111-1111-4111-8111-111111111111',
        bifrostLogRequestId: '11111111-1111-4111-8111-111111111111',
        upstreamResponseRequestId: '22222222-2222-4222-8222-222222222222',
      }];
      const first = await persistNormalEngineQualificationProviderIdentifiers(ids,
        'nq_0123456789abcdef0123456789abcdef', 'single', 'lc_0d8f4a7c2b9e41f8', root);
      const body = await readFile(first.identifiersPath, 'utf8');
      const fileStat = await stat(first.identifiersPath);
      const replay = await persistNormalEngineQualificationProviderIdentifiers(ids,
        'nq_0123456789abcdef0123456789abcdef', 'single', 'lc_0d8f4a7c2b9e41f8', root);

      expect(body).toContain(ids[0]!.callerRequestId);
      expect(fileStat.mode & 0o777).toBe(0o600);
      expect(first.privateIdentifiersSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(replay.idempotent).toBe(true);
      await expect(persistNormalEngineQualificationProviderIdentifiers([], 'nq_0123456789abcdef0123456789abcdef',
        'single', 'lc_0d8f4a7c2b9e41f8', root)).rejects.toThrow(/qualification provider identifier identity conflict/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('persists schema-validated composed task and path evidence in a private idempotent sidecar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'review-yeti-qualification-composed-resources-'));
    try {
      const runId = 'nq_0123456789abcdef0123456789abcdef';
      const phase = 'single' as const;
      const caseId = 'lc_0d8f4a7c2b9e41f8';
      const task = { id: 'security', dimension: 'security' as const, paths: ['src/a.ts'],
        question: 'Review the changed source.', rationale: 'The task owns the changed path.' };
      const sourceDelivery = { version: 'TaskSourceDelivery.v1' as const, taskId: task.id,
        headSha: 'c9b23312180a753ed222814a7ec4380ae0e850a5', baseSha: 'b5bf7b68ece2f674d88356749aa4575edc5e510d',
        contextDigests: ['f'.repeat(64)], complete: true,
        files: [{ path: 'src/a.ts', patchDigest: 'a'.repeat(64), totalChars: 1,
          ranges: [[0, 1] as [number, number]], inline: true }] };
      const observer = new ComposedRuntimeResourceObserver({ configDigest: 'b'.repeat(64) });
      observer.configureBudget({ configuredTotalTurns: 1, investigationTurns: 1, verificationReserveTurns: 0 });
      observer.setPlan([task]);
      observer.markTaskStarted(task.id);
      observer.markTaskOutcome(task.id, 'completed', sourceDelivery);
      const observation = observer.snapshot('terminal');
      if (!observation) throw new Error('expected composed resource observation');
      const resources = completeComposedRuntimeResources({ observation, configDigest: 'b'.repeat(64), verifierCalls: 0 });
      if (!resources) throw new Error('expected worker-stage composed resource receipt');

      const first = await persistNormalEngineQualificationComposedResources(resources, runId, phase, caseId, root);
      const resourcePath = join(root, runId, phase, caseId, 'composed-resources.record', 'composed-runtime-resources.json');
      const shaPath = join(root, runId, phase, caseId, 'composed-resources.record', 'composed-runtime-resources.sha256');
      const [body, sidecar] = await Promise.all([readFile(resourcePath, 'utf8'), readFile(shaPath, 'utf8')]);
      const fileStat = await stat(resourcePath);
      const replay = await persistNormalEngineQualificationComposedResources(resources, runId, phase, caseId, root);

      expect(first).toMatchObject({ path: normalEngineQualificationComposedResourcesRelativePath(runId, phase, caseId),
        sha256: createHash('sha256').update(body).digest('hex'), idempotent: false });
      expect(sidecar).toBe(`${first.sha256}\n`);
      expect(fileStat.mode & 0o777).toBe(0o600);
      expect(composedRuntimeResourcesSchema.safeParse(JSON.parse(body)).success).toBe(true);
      expect(body).not.toContain('SECRET');
      expect(replay).toMatchObject({ sha256: first.sha256, idempotent: true });
      await expect(persistNormalEngineQualificationComposedResources({ ...resources,
        usage: { ...resources.usage, engineElapsedMonotonicMs: resources.usage.engineElapsedMonotonicMs + 1 },
      }, runId, phase, caseId, root)).rejects.toThrow(/qualification composed resource identity conflict/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects an artifact that could be mistaken for an official PR review receipt', () => {
    expect(() => assertNormalEngineQualificationReceipt({
      ...validQualificationReceipt(),
      reviewCompleted: false,
    })).toThrow(/qualification receipt contract is invalid/u);
    expect(() => assertNormalEngineQualificationReceipt({
      ...validQualificationReceipt(),
      verdict: 'SHIP',
    })).toThrow(/qualification receipt contract is invalid/u);
  });

  it('binds qualification fixture identity separately from the real prepared policy target', () => {
    const receipt = validQualificationReceipt();
    expect(() => assertNormalEngineQualificationReceipt({
      ...receipt,
      policy: { ...receipt.policy, targetRepository: 'synthetic/fixture-project' },
    })).toThrow(/policy target\/source binding is invalid/u);
    expect(() => assertNormalEngineQualificationReceipt({
      ...receipt,
      policy: { ...receipt.policy, selectionPurpose: 'ordinary-app-review' },
    })).toThrow(/qualification receipt contract is invalid/u);
    const { selectionPurpose: _selectionPurpose, ...policyWithoutPurpose } = receipt.policy;
    expect(() => assertNormalEngineQualificationReceipt({
      ...receipt,
      policy: policyWithoutPurpose,
    })).toThrow(/qualification receipt contract is invalid/u);
    expect(() => assertNormalEngineQualificationReceipt({
      ...receipt,
      policy: { ...receipt.policy, targetRepository: 'synthetic/other-policy' },
    })).toThrow(/qualification policy target\/source binding is invalid/u);
  });

  it('keeps the plan index a non-approval manifest bound to typed receipt paths', () => {
    const plan = validQualificationPlanReceipt();
    expect(assertNormalEngineQualificationPlanReceipt(plan)).toMatchObject({
      schemaVersion: 'ReviewYetiNormalQualificationPlan.v1', planId: 'ws6-normal-canary-v1',
      caseCount: 11, expectedReceiptCount: 11, completedReceiptCount: 11, receiptSetComplete: true,
    });
    expect(JSON.stringify(plan)).not.toMatch(/"(?:SHIP|FIX_FIRST|BLOCK|eligible|reviewCompleted|mergeEligible|AppId|oracle)"/iu);
    expect(() => assertNormalEngineQualificationPlanReceipt({ ...plan,
      cases: [{ ...plan.cases[0]!, receiptPath: 'other/output.json' }],
    })).toThrow(/qualification plan receipt contract is invalid/u);
    expect(() => assertNormalEngineQualificationPlanReceipt({ ...plan,
      completedReceiptCount: 0,
    })).toThrow(/qualification plan receipt contract is invalid/u);
    expect(() => assertNormalEngineQualificationPlanReceipt({ ...plan,
      cases: [{ ...plan.cases[0]!, composedResourcesPath: 'other/resource.json' }],
    })).toThrow(/qualification plan receipt contract is invalid/u);
  });

  it('selects one stable target from the bound confirmed P1 source set and refuses ambiguous event linkage', () => {
    const state = repairHistoryState();
    const input = {
      historyLoad: state.historyLoad,
      qualificationRunId: state.runId,
      workerRunId: `run_${state.runId.slice(3)}`,
      executionAttempt: state.executionAttempt,
      baseSha: state.baseSha,
      headSha: state.headSha,
      policyDigest: state.policyDigest,
      configDigest: state.configDigest,
    };
    const selected = selectQualificationAdjudicatorRecheckTarget(input);
    expect(selected).toEqual(state.adjudicatorRecheckTarget);

    const secondFindingId = '423e4567-e89b-42d3-a456-426614174000';
    const secondEventId = '523e4567-e89b-42d3-a456-426614174000';
    const secondFingerprint = `fp1_${'b'.repeat(24)}`;
    const secondFinding = { ...state.historyLoad.findings[0]!, findingEventId: secondFindingId,
      fingerprint: secondFingerprint, path: 'src/aaa.ts', affectedContextDigest: '9'.repeat(64), evidenceDigest: '8'.repeat(64) };
    const secondEvent = { ...state.historyLoad.events[0]!, eventId: secondEventId, evidenceDigest: '8'.repeat(64),
      verification: { ...state.historyLoad.events[0]!.verification!, findingEventId: secondFindingId,
        fingerprint: secondFingerprint, currentAffectedContextDigest: '9'.repeat(64) } };
    const multiple = selectQualificationAdjudicatorRecheckTarget({ ...input,
      historyLoad: { ...state.historyLoad,
        events: [...state.historyLoad.events, secondEvent], findings: [...state.historyLoad.findings, secondFinding] } });
    expect(multiple).toMatchObject({ path: 'src/aaa.ts', findingFingerprint: secondFingerprint });

    const duplicateLinkage = selectQualificationAdjudicatorRecheckTarget({ ...input,
      historyLoad: { ...state.historyLoad, events: [...state.historyLoad.events,
        { ...state.historyLoad.events[0]!, eventId: '623e4567-e89b-42d3-a456-426614174000' }] } });
    expect(duplicateLinkage).toBeNull();
    expect(selectQualificationAdjudicatorRecheckTarget({ ...input,
      historyLoad: { ...state.historyLoad, findings: [] } })).toBeNull();
  });

  it('loads the same-head adjudicator projection from A history and persists a fresh run-owned verification set', async () => {
    const root = await mkdtemp(join(tmpdir(), 'review-yeti-adjudicator-history-'));
    try {
      const store = new NormalEngineQualificationHistoryStore(root);
      const state = repairHistoryState();
      await store.persistInitial(state);
      const binding = {
        runId: state.runId,
        repairRunId: 'nq_abcdef0123456789abcdef0123456789',
        sequenceId: state.sequenceId,
        sourceCaseId: state.caseId,
        repairCaseId: state.caseId,
        bundleSha256: state.bundleSha256,
        sourceInputSha256: state.inputSha256,
        repairInputSha256: state.inputSha256,
        repositoryId: state.repositoryId,
        repository: state.repository,
        currentBaseSha: state.baseSha,
        currentHeadSha: state.headSha,
        policyDigest: state.policyDigest,
        configDigest: state.configDigest,
        mode: 'same-head-recheck' as const,
        currentInputSha256: state.inputSha256,
      };
      const source = store.sourceForSameHeadAdjudicatorRecheck(binding);
      const loaded = await source.read();
      expect(loaded).toMatchObject({ status: 'complete', authenticatedDisputes: { status: 'complete',
        disputes: [{ findingFingerprint: state.adjudicatorRecheckTarget!.findingFingerprint,
          priorFindingEventId: state.adjudicatorRecheckTarget!.priorFindingEventId,
          priorEvidenceDigest: state.adjudicatorRecheckTarget!.priorEvidenceDigest }],
        paths: [state.adjudicatorRecheckTarget!.path] } });
      expect(await source.recordVerification({ snapshotId: state.historyLoad.snapshotId!,
        findingEventId: state.adjudicatorRecheckTarget!.priorFindingEventId, status: 'confirmed',
        currentContextDigest: state.historyLoad.contextDigest!,
        currentAffectedContextDigest: state.historyLoad.findings[0]!.affectedContextDigest,
        evidence: { semantics: 'GroundedReviewEvidenceSemantics.v2' } })).toBe(true);
      const identity = { runId: binding.repairRunId, sourceRunId: binding.runId,
        sequenceId: binding.sequenceId, sourceCaseId: binding.sourceCaseId, repairCaseId: binding.repairCaseId };
      const set = await store.finalizeVerificationSet(identity, 'adjudicator-recheck', binding);
      const artifacts = await store.artifactsForRepairRun(identity);
      expect(set).toMatchObject({ status: 'complete', expectedFindingEventIds: [state.adjudicatorRecheckTarget!.priorFindingEventId],
        recordedFindingEventIds: [state.adjudicatorRecheckTarget!.priorFindingEventId] });
      expect(artifacts[0]).toMatchObject({ kind: 'verification-set', runId: binding.repairRunId,
        sourceRunId: binding.runId, caseId: 'ws5-sequence-a-v1' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('persists qualification-produced history separately and refuses identity drift on repair read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'review-yeti-qualification-history-'));
    try {
      const store = new NormalEngineQualificationHistoryStore(root);
      const state = repairHistoryState();
      const stored = await store.persistInitial(state);
      const duplicate = await store.persistInitial(state);
      const binding = {
        runId: state.runId,
        repairRunId: 'nq_abcdef0123456789abcdef0123456789',
        sequenceId: state.sequenceId,
        sourceCaseId: state.caseId,
        repairCaseId: state.repairCaseId,
        bundleSha256: state.bundleSha256,
        sourceInputSha256: state.inputSha256,
        repairInputSha256: state.repairInputSha256,
        repositoryId: state.repositoryId,
        repository: state.repository,
        currentBaseSha: state.headSha,
        currentHeadSha: state.repairHeadSha,
        policyDigest: state.policyDigest,
        configDigest: state.configDigest,
        mode: 'repair-head' as const,
        currentInputSha256: state.repairInputSha256,
      };
      const history = store.sourceForRepair(binding);
      const loaded = await history.read();
      const verificationRecorded = await history.recordVerification({
        snapshotId: state.historyLoad.snapshotId,
        findingEventId: state.historyLoad.findings[0]!.findingEventId,
        status: 'contradicted',
        currentContextDigest: state.historyLoad.contextDigest,
        currentAffectedContextDigest: state.historyLoad.findings[0]!.affectedContextDigest,
        evidence: { evidenceDigest: '9'.repeat(64) },
      });
      const sourceArtifactRows = await store.historyArtifactsFor({ runId: state.runId,
        sequenceId: state.sequenceId, caseId: state.caseId });
      const repairIdentity = { runId: binding.repairRunId, sourceRunId: binding.runId,
        sequenceId: binding.sequenceId, sourceCaseId: binding.sourceCaseId, repairCaseId: binding.repairCaseId };
      const verificationSet = await store.finalizeVerificationSet(repairIdentity, 'history', binding);
      const artifactRows = await store.artifactsForRepairRun(repairIdentity);
      const historyArtifact = sourceArtifactRows.find((row) => row.kind === 'history');
      const verificationArtifact = artifactRows.find((row) => row.kind === 'verification');
      const verificationSetArtifact = artifactRows.find((row) => row.kind === 'verification-set');
      const repeatBinding = { ...binding, repairRunId: 'nq_1234567890abcdef1234567890abcdef' };
      const repeatHistory = store.sourceForRepair(repeatBinding);
      await repeatHistory.read();
      expect(await repeatHistory.recordVerification({
        snapshotId: state.historyLoad.snapshotId,
        findingEventId: state.historyLoad.findings[0]!.findingEventId,
        status: 'contradicted',
        currentContextDigest: state.historyLoad.contextDigest,
        currentAffectedContextDigest: state.historyLoad.findings[0]!.affectedContextDigest,
        evidence: { evidenceDigest: '9'.repeat(64) },
      })).toBe(true);
      const repeatIdentity = { ...repairIdentity, runId: repeatBinding.repairRunId };
      await store.finalizeVerificationSet(repeatIdentity, 'history', repeatBinding);
      const repeatArtifacts = await store.artifactsForRepairRun(repeatIdentity);
      const verifierFaultBinding = { ...binding, repairRunId: 'nq_0987654321fedcba0987654321fedcba' };
      const verifierFaultIdentity = { ...repairIdentity, runId: verifierFaultBinding.repairRunId };
      const verifierFaultSet = await store.finalizeVerificationSet(verifierFaultIdentity, 'verifier-unavailable', verifierFaultBinding);
      const unavailableIdentity = { ...repairIdentity, runId: 'nq_00000000000000000000000000000001' };
      const unavailableSet = await store.finalizeVerificationSet(unavailableIdentity, 'history-unavailable');
      const emptyIdentity = { runId: 'nq_fedcba0987654321fedcba0987654321', sourceRunId: null,
        sequenceId: 'ws5-repair-sequence-v1', sourceCaseId: 'ws5-sequence-a-v1', repairCaseId: 'ws5-sequence-b-v1' };
      await store.finalizeVerificationSet(emptyIdentity, 'empty-context');
      const emptyArtifacts = await store.artifactsForRepairRun(emptyIdentity);
      const mismatched = store.sourceForRepair({ ...binding, policyDigest: 'f'.repeat(64) });

      expect(stored.idempotent).toBe(false);
      expect(duplicate.idempotent).toBe(true);
      expect(loaded.status).toBe('complete');
      expect(loaded.findings[0]).toMatchObject({ fingerprint: `fp1_${'a'.repeat(24)}`, path: 'src/interval.ts' });
      expect(verificationRecorded).toBe(true);
      expect(historyArtifact).toMatchObject({ recordPath: `${state.runId}/ws5-repair-sequence-v1/ws5-sequence-a-v1/history/record.json` });
      expect(verificationArtifact).toMatchObject({ kind: 'verification', findingEventId: state.historyLoad.findings[0]!.findingEventId,
        runId: binding.repairRunId, sourceRunId: binding.runId,
        recordPath: `${binding.repairRunId}/ws5-repair-sequence-v1/ws5-sequence-b-v1/verifications/${state.historyLoad.findings[0]!.findingEventId}/record.json` });
      expect(verificationSetArtifact).toMatchObject({ kind: 'verification-set', runId: binding.repairRunId,
        sourceRunId: binding.runId, recordPath: `${binding.repairRunId}/ws5-repair-sequence-v1/ws5-sequence-b-v1/verification-set/record.json` });
      expect(verificationSet).toMatchObject({ status: 'complete', expectedFindingEventIds: [state.historyLoad.findings[0]!.findingEventId],
        recordedFindingEventIds: [state.historyLoad.findings[0]!.findingEventId], missingFindingEventIds: [] });
      expect(repeatArtifacts.find((row) => row.kind === 'verification')?.recordPath)
        .toContain(`${repeatBinding.repairRunId}/ws5-repair-sequence-v1/ws5-sequence-b-v1/verifications/`);
      expect((await repeatHistory.read()).snapshotId).toBe(loaded.snapshotId);
      expect(verifierFaultSet).toMatchObject({ status: 'incomplete',
        expectedFindingEventIds: [state.historyLoad.findings[0]!.findingEventId],
        recordedFindingEventIds: [], missingFindingEventIds: [state.historyLoad.findings[0]!.findingEventId] });
      expect(unavailableSet).toMatchObject({ status: 'unavailable', sourceHistorySha256: null,
        snapshotIdSha256: null, contextDigest: null, expectedFindingEventIds: [], missingFindingEventIds: [] });
      const emptySetBytes = await readFile(join(root, emptyArtifacts.find((row) => row.kind === 'verification-set')!.recordPath));
      expect(JSON.parse(emptySetBytes.toString('utf8'))).toMatchObject({ status: 'empty_context',
        expectedFindingEventIds: [], recordedFindingEventIds: [], missingFindingEventIds: [], verificationRecordDigests: [] });
      for (const artifact of [verificationArtifact!, verificationSetArtifact!, emptyArtifacts.find((row) => row.kind === 'verification-set')!]) {
        const recordPath = join(root, artifact.recordPath);
        const checksumPath = join(root, artifact.sha256Path);
        const [recordBytes, checksumBytes, recordMode, checksumMode] = await Promise.all([
          readFile(recordPath), readFile(checksumPath, 'utf8'), stat(recordPath), stat(checksumPath),
        ]);
        expect(createHash('sha256').update(recordBytes).digest('hex')).toBe(checksumBytes.trim());
        expect(recordMode.mode & 0o777).toBe(0o600);
        expect(checksumMode.mode & 0o777).toBe(0o600);
        expect(recordBytes.toString('utf8')).not.toMatch(/"(?:title|body|prompt|response|oracle|expectedOutcome)"/u);
      }
      const historyBytes = await readFile(join(root, historyArtifact!.recordPath));
      const historyChecksum = await readFile(join(root, historyArtifact!.sha256Path), 'utf8');
      const historyMode = await stat(join(root, historyArtifact!.recordPath));
      expect(createHash('sha256').update(historyBytes).digest('hex')).toBe(historyChecksum.trim());
      expect(historyMode.mode & 0o777).toBe(0o600);
      expect(historyBytes.toString('utf8')).not.toMatch(/"(?:title|body|prompt|response|oracle|expectedOutcome)"/u);
      expect((await mismatched.read()).status).toBe('unavailable');
      expect(stored.historyPath).not.toMatch(/review_runs|review_dispatch|outbox/u);
      const historyBody = await readFile(stored.historyPath, 'utf8');
      expect(historyBody).not.toMatch(/"(?:title|body|prompt|response|oracle|expectedOutcome)"/u);
      await expect(store.persistInitial({ ...state, workerCompletionSha256: '0'.repeat(64) }))
        .rejects.toThrow(/qualification history identity conflict/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('records physical provider metadata as unverified without cloning or persisting the response body', async () => {
    const callerRequestId = '11111111-1111-4111-8111-111111111111';
    const responseRequestId = '22222222-2222-4222-8222-222222222222';
    const collector = new NormalEngineQualificationProviderAttestor(async (_input, init) => {
      expect(new Headers(init?.headers).get('x-request-id')).toBe(callerRequestId);
      return new Response('private completion', {
        status: 200,
        headers: {
        'x-request-id': responseRequestId,
        'x-bifrost-provider': 'selected-provider',
        'x-bifrost-resolved-model': 'selected/model',
        'x-bifrost-fallback-index': '2',
        'x-bifrost-routing-info-provider': 'selected-provider',
        'x-bifrost-routing-info-model': 'selected/model',
        'x-bifrost-routing-info-key': 'never-record-this-key-id',
        'content-type': 'text/plain',
        },
      });
    }, () => callerRequestId);
    let responseBodyStayedUnread = false;

    await collector.run({
      model: 'pr-reviewer',
      messages: [{ role: 'user', content: 'private prompt' }],
      timeoutMs: 1_000,
      stream: true,
      maxTokens: 2048,
      reasoningEffort: 'medium',
      provider: { only: ['vendor-x'] },
    }, async () => {
      const response = await collector.fetch('https://gateway.example.invalid/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'pr-reviewer', stream: true, max_tokens: 2048, reasoning_effort: 'medium' }),
      });
      responseBodyStayedUnread = !response.bodyUsed;
      return { model: 'response-model-unverified', content: 'private completion', usage: { prompt: 11, completion: 7, total: 18 },
        costUSD: null, raw: { provider: 'response-provider-unverified' } };
    });

    const calls = collector.snapshot();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      requestedAlias: 'pr-reviewer',
      requestedProviderPreference: '{"only":["vendor-x"]}',
      requestedEffort: 'medium',
      outputCap: 2048,
      stream: true,
      httpStatus: 200,
      responseReportedModel: 'response-model-unverified',
      responseReportedProvider: 'response-provider-unverified',
      bifrostLogRequestIdSha256: createHash('sha256').update(callerRequestId).digest('hex'),
      upstreamResponseRequestIdSha256: createHash('sha256').update(responseRequestId).digest('hex'),
      tokenUsage: { prompt: 11, completion: 7, total: 18 },
      contentPersisted: false,
      gatewayEvidence: {
        status: 'headers_unverified',
        provider: 'selected-provider',
        originalModel: null,
        resolvedModel: 'selected/model',
        fallbackIndex: 2,
        requestType: null,
        upstreamLatencyMs: null,
        routingInfo: {
          provider: 'selected-provider', model: 'selected/model', isFallback: null,
          primaryProvider: null, primaryModel: null, serverSideFallbackModel: null,
          aliasModelId: null, aliasModelName: null, aliasModelFamily: null,
        },
        exactLogRowStatus: 'not_available',
      },
    });
    expect(responseBodyStayedUnread).toBe(true);
    expect(normalEngineQualificationProviderIdentityStatus(calls)).toBe('response_reported_unverified');
    expect(JSON.stringify(calls)).not.toContain(callerRequestId);
    expect(JSON.stringify(calls)).not.toContain(responseRequestId);
    expect(JSON.stringify(calls)).not.toContain('private completion');
    expect(JSON.stringify(calls)).not.toContain('private prompt');
    const privateRows = collector.privateIdentifiers();
    expect(privateRows[0]).toMatchObject({
      callerRequestId,
      bifrostLogRequestId: callerRequestId,
      upstreamResponseRequestId: responseRequestId,
    });
    expect(JSON.stringify(privateRows)).not.toContain('never-record-this-key-id');
  });
});

describe('WS5 external v2 repair history binding', () => {
  it('loads only the completed fresh v2 A receipt with matching runtime, policy, config, and ancestry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'review-yeti-external-v2-history-'));
    try {
      const store = new NormalEngineQualificationHistoryStore(root);
      const base = repairHistoryState();
      const sequenceId = 'ws5-current-source-external-v2';
      const sourceCaseId = 'ws5-current-1dd-v2-sequence-a';
      const repairCaseId = 'ws5-current-1dd-v2-sequence-b';
      const bundleSha256 = '99b707383ec16eea3ef81994c623e956f551a1e9d0b6acf2dd503afc5d41cfe1';
      const sourceInputSha256 = '0e3bade3d6d7a148a2a36515ed1b40b9c1ab3f4cc2b2d92343176f2069ca0da9';
      const repairInputSha256 = '52cdd6d19fc5dd042412a85df5b4effe8c9793c43cea3104ab5b35d036b1d1aa';
      const policyDigest = 'c7de3af7f4e5c98de86a4a2a8f962a1779d0195e7ab470b25332b0f6fbe0210b';
      const configDigest = 'f737fbef64a7336614e441d092e3899d0c2b674f04ea197c610aaf7db9050df1';
      const runtime = { sourceRevision: '7'.repeat(40), workerImageDigest: `sha256:${'8'.repeat(64)}`,
        runtimeManifestSha256: '9'.repeat(64) };
      const v2State = {
        ...base,
        configurationVariant: 'prepared-policy-default-v1' as const,
        disputedBlockerAdjudicator: { state: 'unconfigured' as const, modelAlias: null, reasoningEffort: null },
        adjudicatorRecheckTarget: null,
        sequenceId,
        caseId: sourceCaseId,
        bundleSha256,
        inputSha256: sourceInputSha256,
        repairCaseId,
        repairInputSha256,
        repairBaseSha: '1035dc8db9a222447aa774fd9660c224e5d37655',
        repairHeadSha: '1b183caf5f8c518a3acda3fb2d8eea38133eed98',
        policyDigest,
        configDigest,
        runtime,
        historyLoad: {
          ...base.historyLoad,
          events: base.historyLoad.events.map((event) => ({ ...event, policyDigest, configDigest })),
        },
      };
      await store.persistInitial(v2State as never);
      const binding = {
        runId: v2State.runId,
        repairRunId: 'nq_abcdef0123456789abcdef0123456789',
        sequenceId,
        sourceCaseId,
        repairCaseId,
        bundleSha256,
        sourceInputSha256,
        repairInputSha256,
        repositoryId: 73002,
        repository: 'synthetic/fixture-sequence',
        currentBaseSha: '1035dc8db9a222447aa774fd9660c224e5d37655',
        currentHeadSha: '1b183caf5f8c518a3acda3fb2d8eea38133eed98',
        policyDigest,
        configDigest,
        configurationVariant: 'prepared-policy-default-v1' as const,
        runtime,
        mode: 'repair-head' as const,
        currentInputSha256: repairInputSha256,
      };
      const loaded = await store.sourceForRepair(binding).read();
      expect(loaded).toMatchObject({ status: 'complete', snapshotId: base.historyLoad.snapshotId,
        contextDigest: base.historyLoad.contextDigest });

      const mismatchedRuntime = await store.sourceForRepair({ ...binding,
        runtime: { ...runtime, workerImageDigest: `sha256:${'a'.repeat(64)}` } }).read();
      const mismatchedPolicy = await store.sourceForRepair({ ...binding, policyDigest: 'b'.repeat(64) }).read();
      const mismatchedRepair = await store.sourceForRepair({ ...binding, repairInputSha256: 'c'.repeat(64) }).read();
      expect(mismatchedRuntime.status).toBe('unavailable');
      expect(mismatchedPolicy.status).toBe('unavailable');
      expect(mismatchedRepair.status).toBe('unavailable');

      const oldV1Binding = store.sourceForRepair({ ...binding, sequenceId: 'ws5-repair-sequence-v1',
        sourceCaseId: 'ws5-sequence-a-v1', repairCaseId: 'ws5-sequence-b-v1',
        bundleSha256: base.bundleSha256, sourceInputSha256: base.inputSha256,
        repairInputSha256: base.repairInputSha256, currentInputSha256: base.repairInputSha256 });
      expect((await oldV1Binding.read()).status).toBe('unavailable');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('WS5 external v2 active/capture deadline split', () => {
  it('keeps a 240-second child deadline separate from the later exact-log capture reserve', () => {
    const deadlineFor = (NormalEngineQualificationWorker as Record<string, unknown>)
      .normalEngineQualificationChildDeadlineAt as ((nowMs: number, activeMs: number, captureOutsideChild: boolean) => string | null) | undefined;
    expect(deadlineFor).toBeTypeOf('function');
    expect(deadlineFor!(1_000, 240_000, true)).toBe(new Date(241_000).toISOString());
    expect(deadlineFor!(1_000, 240_000, false)).toBe(new Date(541_000).toISOString());
  });
});
