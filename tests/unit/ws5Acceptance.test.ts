import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as benchmark from '../../scripts/competitive-review-benchmark.mjs';
import * as ws5 from '../../scripts/ws5-acceptance.mjs';
import * as sourceProvenance from '../../scripts/ws5-source-provenance.mjs';
import * as repairBuilder from '../../scripts/build-ws5-repair-fixture.mjs';
import * as largeBuilder from '../../scripts/build-ws5-large-crossfile-fixture.mjs';
import * as p2Builder from '../../scripts/build-ws5-p2-display-sort-fixture.mjs';
import * as alibaba from '../../scripts/ws5-alibaba.mjs';
import { createWs5PublicTestFixture } from './ws5PublicTestFixtures';

const repoRoot = process.cwd();
const hostExecutionPin = benchmark.runtimeGitIdentity(repoRoot).hostExecution;
let ws5Fixture: ReturnType<typeof createWs5PublicTestFixture>;
let unitBundle: any;

beforeAll(() => {
  ws5Fixture = createWs5PublicTestFixture(repoRoot);
  unitBundle = ws5Fixture.bundle;
});

afterAll(() => ws5Fixture?.cleanup());

function readyRootDispatchPreflight(bundle: any) {
  return {
    status: 'ready_for_root_dispatch',
    planSha256: bundle.panelSha256,
    manifestSha256: bundle.manifestSha256,
    preparedInputSha256: bundle.plan.publicPanel.preparedInputSha256,
    sourceCases: bundle.plan.publicPanel.caseIds.map((caseId: string) => ({
      caseId, status: 'verified', sourceOmissions: [],
    })),
    alibaba: {
      status: 'READY_FOR_PROVIDER_PREFLIGHT_WITH_DECLARED_COMPARATOR_SCOPE_LIMITATION',
      providerCalls: 0,
      panelCaseIds: bundle.plan.publicPanel.caseIds,
      sourceCompleteCaseCount: bundle.plan.publicPanel.caseIds.length,
      comparatorScopeUnsupportedCaseCount: 1,
      cases: bundle.plan.publicPanel.caseIds.map((caseId: string) => {
        const sourceCase = bundle.preparedDiscovery.cases.find((entry: any) => entry.caseId === caseId);
        const limitation = bundle.plan.publicRunMatrix.arms[2].nativeSourceLimitations?.[caseId];
        if (limitation) {
          return { caseId, status: 'source_scope_unsupported', changedFileCount: sourceCase.changedFiles.length,
            sourceCachePreflight: { status: 'verified' }, preview: { reviewableCount: sourceCase.changedFiles.length - limitation.length,
              changedPathsSha256: 'd'.repeat(64),
              unsupportedExclusions: limitation, unreviewedPaths: limitation } };
        }
        return { caseId, status: 'ready', changedFileCount: sourceCase.changedFiles.length,
          sourceCachePreflight: { status: 'verified' }, preview: { changedPathsSha256: 'd'.repeat(64) } };
      }),
    },
    provider: { status: 'ready', modelAlias: 'pr-reviewer', providerCalls: 0 },
  };
}

function makePinnedYetiDiscoveryEnvelope(bundle: any, armId: string, runtimeShaOverride?: string) {
  const arm = bundle.plan.publicRunMatrix.arms.find((entry: any) => entry.id === armId);
  const baseline = arm.purpose === 'baseline';
  const purpose = baseline ? 'baseline' : 'qualification';
  const effortProfile = arm.effortProfile;
  const policyPath = path.join(bundle.dataRootPath || bundle.rootPath,
    'eval-baselines/competitive-review-benchmark/policy-projections',
    effortProfile === 'native_omitted' ? 'yeti-v1-native-omitted.json' : 'yeti-v1-medium.json');
  const policyInput = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  const policyProjectionSha256 = crypto.createHash('sha256').update(fs.readFileSync(policyPath)).digest('hex');
  const verificationReserveTurns = baseline ? 0 : 12;
  const expectedRuntimeSha = runtimeShaOverride || arm.runtimeSha || 'a'.repeat(40);
  const sourceCasesById = new Map(bundle.preparedDiscovery.cases.map((entry: any) => [entry.caseId, entry]));
  const manifestCasesById = new Map<string, any>(bundle.manifest.cases.map((entry: any) => [entry.id, entry]));
  return {
    expectedRuntimeSha,
    run: {
      task: 'discovery',
      datasetSha256: bundle.plan.publicPanel.datasetSha256,
      heldoutManifestSha256: bundle.plan.publicPanel.manifestSha256,
      preparedInputSha256: bundle.plan.publicPanel.preparedInputSha256,
      sourceSnapshotVerification: 'preparation_stage_only_not_reverified_at_run',
      panelCaseIds: bundle.plan.publicPanel.caseIds,
      selectedCaseIds: arm.caseIds,
      executionPurpose: baseline ? 'actual_production_entrypoint_v1_baseline_input'
        : 'actual_production_entrypoint_qualification_input',
      runtime: { commit: expectedRuntimeSha, tree: 'b'.repeat(40), worktreeClean: true,
        hostExecution: hostExecutionPin },
      policy: {
        sourcePolicySourceRevision: benchmark.V1_POLICY_PROVENANCE.revision,
        sourcePolicySourceSha256: benchmark.V1_POLICY_PROVENANCE.sourceSha256,
        policyProjectionFileSha256: policyProjectionSha256,
        materialization: 'local_benchmark_policy_projection_not_authenticated_service_admission',
        effortProfile,
        effortInjection: 'runtime_native',
        verifierMode: baseline ? 'absent_in_selected_v1_baseline' : 'production_independent_verifier_required',
      },
      requestedResourceLimits: benchmark.discoveryResourceProfile(policyInput.review_yeti || policyInput, {
        verificationReserveTurns, env: {},
      }),
      cases: bundle.plan.publicPanel.caseIds.map((caseId: string) => {
        const sourceCase = sourceCasesById.get(caseId);
        const manifestCase = manifestCasesById.get(caseId);
        const profileCase = bundle.sourceProfile.cases.find((entry: any) => entry.caseId === caseId);
        return {
          caseId,
          status: 'completed',
          executionPurpose: baseline ? 'full_production_envelope_v1_baseline_input' : 'full_production_envelope_quality_input',
          source: {
            repository: manifestCase.repository,
            prNumber: manifestCase.prNumber,
            datasetBaseSha: manifestCase.datasetBaseSha,
            diffBaseSha: manifestCase.diffBaseSha,
            mergeBaseSha: manifestCase.mergeBaseSha,
            headSha: manifestCase.headSha,
            changedFiles: profileCase.changedFileCount,
            sourceOmissions: [],
            sourceReadOmissions: [],
            sourceCachePreflight: { status: 'verified' },
          },
          receipt: { coverage: { rosterValid: true, quorumSatisfied: true, fullPanelComplete: true },
            metrics: { totalTokens: 10, totalDurationMs: 20 } },
          model: { requestedAlias: bundle.plan.providerIdentityGate.primaryModelAlias,
            effortInjection: 'runtime_native', responseReportedModels: [], responseReportedProviders: [], responseRouteHints: [] },
          inputCaseSha256: crypto.createHash('sha256').update(JSON.stringify(sourceCase)).digest('hex'),
        };
      }),
    },
  };
}

describe('WS5 finite acceptance panel', () => {
  it('builds a content-addressed unit-only panel fixture with the production schedule shape', () => {
    const bundle = unitBundle;
    const cases = bundle.manifest.cases;

    expect(bundle.plan.schemaVersion).toBe('ReviewYetiWS5Acceptance.v1');
    expect(bundle.plan.testFixture).toEqual({ classification: 'unit-test-only', runtimeQualificationEligible: false });
    expect(bundle.plan.publicRunMatrix.requiredPublicRunCount).toBe(28);
    expect(bundle.panelSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(bundle.manifestSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(crypto.createHash('sha256').update(fs.readFileSync(bundle.metadataPaths.plan)).digest('hex'))
      .toBe(bundle.panelSha256);
    expect(crypto.createHash('sha256').update(fs.readFileSync(bundle.metadataPaths.manifest)).digest('hex'))
      .toBe(bundle.manifestSha256);
    expect(crypto.createHash('sha256').update(fs.readFileSync(bundle.metadataPaths.sourceProfile)).digest('hex'))
      .toBe(bundle.plan.publicPanel.sourceProfileSha256);
    expect(crypto.createHash('sha256').update(fs.readFileSync(bundle.metadataPaths.preparedDiscovery)).digest('hex'))
      .toBe(bundle.plan.publicPanel.preparedInputs.discovery.sha256);
    expect(crypto.createHash('sha256').update(fs.readFileSync(bundle.metadataPaths.preparedVerification)).digest('hex'))
      .toBe(bundle.plan.publicPanel.preparedInputs.verification.sha256);
    expect(bundle.plan.publicPanel.preparedInputSha256).toBe(bundle.plan.publicPanel.preparedInputs.discovery.sha256);
    expect(bundle.plan.verificationPanel.preparedInputSha256).toBe(bundle.plan.publicPanel.preparedInputs.verification.sha256);
    expect(bundle.plan.publicPanel.caseIds).toHaveLength(7);
    expect(cases.map((entry: any) => entry.id)).toEqual(bundle.plan.publicPanel.caseIds);
    expect(cases.every((entry: any) => entry.repository.startsWith('synthetic/'))).toBe(true);
    expect(benchmark.assertExactCaseIdSet(cases.map((entry: any) => entry.id), bundle.plan.publicPanel.caseIds)).toBe(true);

    for (const entry of cases as any[]) {
      expect(entry.datasetBaseSha).toMatch(/^[a-f0-9]{40}$/u);
      expect(entry.diffBaseSha).toMatch(/^[a-f0-9]{40}$/u);
      expect(entry.baseSha).toBe(entry.diffBaseSha);
      expect(entry.headSha).toMatch(/^[a-f0-9]{40}$/u);
      expect(entry.datasetBaseSha).not.toBe(entry.headSha);
    }

    const uniqueRepos = new Set(cases.map((entry: any) => entry.repository));
    expect(uniqueRepos.size).toBe(cases.length);
    expect(bundle.preparedDiscovery.cases).toHaveLength(7);
    expect(bundle.preparedVerification.cases).toHaveLength(28);
    expect(bundle.liveArms.arms).toHaveLength(10);
    expect(bundle.liveArms.execution.providerFailureControl.physicalModelRequestsMax).toBe(1);
    expect(bundle.liveArms.execution.resourceExhaustionControl.testDeadlineSeconds).toBe(60);
    expect(bundle.plan.publicRunMatrix.arms[2].modelAlias).toBe('pr-reviewer');
    expect(bundle.plan.publicRunMatrix.arms[2].coverageModel).toBe('single_agent_file_manifest_no_persona_quorum');
    expect(benchmark.assertBlindDiscoveryInputCases(bundle.preparedDiscovery.cases)).toBe(true);
    expect(benchmark.assertBlindDiscoveryInputCases(bundle.preparedVerification.cases)).toBe(true);
    const schedule = ws5.createPublicRunCellPlan(bundle.plan);
    expect(schedule).toHaveLength(28);
    expect(schedule.filter((cell: any) => cell.execution === 'model_run')).toHaveLength(27);
    expect(schedule.filter((cell: any) => cell.execution === 'preflight_abstention')).toMatchObject([
      { ordinal: 15, armId: 'alibaba-open-code-review', caseId: bundle.reservedAbstentionCaseId, noModelDispatch: true },
    ]);
  });

  it('keeps generated public source snapshots separate from unit-only labels', () => {
    const bundle = unitBundle;
    const runtimeInputs = bundle.syntheticCases.map((entry: any) =>
      JSON.stringify(fs.readFileSync(path.resolve(ws5Fixture.artifactRoot, entry.inputPath), 'utf8')));
    expect(bundle.syntheticCases).toHaveLength(8);
    expect(bundle.syntheticCases.every((entry: any) => /^[a-f0-9]{64}$/u.test(entry.inputSha256))).toBe(true);
    for (const input of runtimeInputs) {
      expect(input).not.toMatch(/expectedDecision|expectedOutcome|expectedFindings|expectedLabel|oracle/iu);
      expect(input).not.toMatch(/synthetic_positive|synthetic_negative/iu);
    }
    expect(ws5Fixture.unitOnlyLabels).toMatchObject({ classification: 'unit-test-only' });
    expect(ws5Fixture.unitOnlyLabels.cases).toHaveLength(10);
    expect(ws5Fixture.unitOnlyLabels.cases.filter((entry) => entry.label === 'synthetic_positive')).toHaveLength(7);
    expect(ws5Fixture.unitOnlyLabels.cases.filter((entry) => entry.label === 'synthetic_negative')).toHaveLength(3);
    expect(JSON.stringify(bundle)).not.toMatch(/synthetic_positive|synthetic_negative/iu);
    expect(JSON.stringify(bundle.preparedVerification)).not.toMatch(/synthetic_positive|synthetic_negative/iu);
    expect(benchmark.assertBlindDiscoveryInputCases(bundle.syntheticCases.map((entry: any) =>
      JSON.parse(fs.readFileSync(path.resolve(ws5Fixture.artifactRoot, entry.inputPath), 'utf8'))))).toBe(true);

    const repairRoot = path.join(ws5Fixture.artifactRoot, 'generated-repair');
    const repairDescriptor = repairBuilder.buildWs5RepairSequence(repairRoot);
    const repairCases = repairDescriptor.phases.map((entry: any) => ({
      ...entry,
      inputValue: JSON.parse(fs.readFileSync(path.join(repairRoot, 'inputs', entry.caseId + '.json'), 'utf8')),
    }));
    expect(repairCases).toHaveLength(2);
    const [introduction, repair] = repairCases;
    expect(introduction.phase).toBe('introduction');
    expect(repair.phase).toBe('repair');
    expect(introduction.inputValue.history).toBeUndefined();
    expect(repair.inputValue.history).toBeUndefined();
    expect(introduction.inputValue.source.revisions).toHaveLength(2);
    expect(repair.inputValue.source.revisions).toHaveLength(3);
    expect(introduction.inputValue.source.revisions.map((entry: any) => entry.commitSha))
      .not.toContain(repairCases[1].headSha);
    expect(repair.inputValue.source.revisions.map((entry: any) => entry.commitSha))
      .toContain(repairCases[1].headSha);
    expect(repair.inputValue.source.repository).toEqual(introduction.inputValue.source.repository);
    expect(repair.inputValue.source.baseSha).toBe(introduction.inputValue.source.headSha);
    expect(repair.inputValue.source.headSha).not.toBe(introduction.inputValue.source.headSha);
    expect(benchmark.assertBlindDiscoveryInputCases(repairCases.map((entry: any) => entry.inputValue))).toBe(true);

    const largeRoot = path.join(ws5Fixture.artifactRoot, 'generated-large');
    const largeDescriptor = largeBuilder.buildWs5LargeCrossfileFixture(largeRoot);
    const largeInput = JSON.parse(fs.readFileSync(path.join(largeRoot, 'inputs/ws5-large-crossfile-v1.json'), 'utf8'));
    expect(largeInput.source.changedPaths).toHaveLength(24);
    expect(largeInput.source.patches).toHaveLength(24);
    expect(largeInput.source.patches.reduce((sum: number, entry: any) =>
      sum + Buffer.byteLength(entry.patch, 'utf8'), 0)).toBeGreaterThan(24_000);
    expect(largeDescriptor.changedFileCount).toBe(24);
    expect(largeInput.history).toBeUndefined();
    expect(benchmark.assertBlindDiscoveryInputCases([largeInput])).toBe(true);

    const p2Root = path.join(ws5Fixture.artifactRoot, 'generated-display-sort');
    const p2Descriptor = p2Builder.buildWs5P2DisplaySortFixture(p2Root);
    const p2Input = JSON.parse(fs.readFileSync(path.join(p2Root, 'inputs/ws5-p2-display-sort-v1.json'), 'utf8'));
    expect(p2Descriptor.caseId).toBe('ws5-p2-display-sort-v1');
    expect(p2Input.history).toBeUndefined();
    expect(p2Input.candidates).toBeUndefined();
    expect(p2Input.source.revisions).toHaveLength(2);
    expect(p2Input.source.baseSha).toMatch(/^[a-f0-9]{40}$/u);
    expect(p2Input.source.headSha).toMatch(/^[a-f0-9]{40}$/u);
    expect(benchmark.assertBlindDiscoveryInputCases([p2Input])).toBe(true);
  }, 15_000);

  it('requires every exact arm/case receipt and abstains on omissions instead of scoring a partial panel', () => {
    const bundle = unitBundle;
    const reservedCaseId = bundle.reservedAbstentionCaseId;
    const limitation = bundle.plan.publicRunMatrix.arms[2].nativeSourceLimitations[reservedCaseId];
    const unsupportedAlibabaCell = alibaba.buildAlibabaSourceScopeAbstention(bundle, {
      cases: [{
        caseId: reservedCaseId,
        status: 'source_scope_unsupported',
        sourceCachePreflight: { status: 'verified' },
        preview: {
          reviewableCount: 1,
          unsupportedExclusions: limitation,
          unreviewedPaths: limitation,
        },
      }],
    }, reservedCaseId);
    const complete = ws5.expectedPublicRunCells(bundle.plan).map((cell: any) => {
      if (cell.armId === 'alibaba-open-code-review' && cell.caseId === reservedCaseId) return unsupportedAlibabaCell;
      const alibabaArm = cell.armId === 'alibaba-open-code-review';
      return {
        ...cell,
        status: 'completed',
        source: { sourceOmissions: [], sourceReadOmissions: [], sourceCachePreflight: { status: 'verified' } },
        coverage: { rosterValid: true, quorumSatisfied: alibabaArm ? null : true,
          ...(alibabaArm ? { quorumComparable: false } : {}), fullPanelComplete: true },
        metrics: { totalPromptTokens: 12, totalCompletionTokens: 4, totalTokens: 16, totalTurns: 1, totalDurationMs: 50 },
        providerAttestation: { status: 'verified', evidenceSource: 'parent_broker_independent_telemetry',
          evidenceDigest: 'c'.repeat(64), requests: [{
          localAttemptOrdinal: 1, requestIdDigest: 'a'.repeat(16), disposition: 'provider_completed',
          provider: 'provider-a', servedModel: 'model-a', evidenceDigest: 'b'.repeat(64),
        }] },
        model: { httpAttempts: [{ localAttemptOrdinal: 1, logicalDispatchOrdinal: 1,
          gatewayRequestIdDigests: ['a'.repeat(16)] }],
          callAccounting: { logicalCompletionDispatches: 1, localHttpRequestAttempts: 1,
            requestProfileAttemptCount: 1, requestAttemptAccountingMatches: true, dispatchAttemptAccountingMatches: true,
            dispatches: [{ logicalDispatchOrdinal: 1, localAttemptOrdinals: [1], localHttpRequestAttempts: 1 }],
            gatewayRelayCount: null, providerCompletionCount: null, costUsd: null } },
      };
    });
    expect(ws5.validatePublicRunCells(bundle.plan, complete)).toMatchObject({
      status: 'READY_FOR_BLIND_ADJUDICATION_WITH_DECLARED_COMPARATOR_SCOPE_LIMITATION',
      completeCells: 27,
      preflightAbstentionCells: 1,
      accountedCells: 28,
      expectedCells: 28,
      commonComparatorDenominator: 6,
      qualityScore: null,
    });
    const concurrentCompletionOrder = [...complete];
    concurrentCompletionOrder[0] = {
      ...complete[0],
      providerAttestation: {
        status: 'verified',
        evidenceSource: 'parent_broker_independent_telemetry',
        evidenceDigest: 'f'.repeat(64),
        requests: [1, 2, 3].map((ordinal) => ({
          localAttemptOrdinal: ordinal,
          requestIdDigest: ordinal.toString(16).padStart(16, '0'),
          disposition: 'provider_completed',
          provider: 'provider-a',
          servedModel: 'model-a',
          evidenceDigest: ordinal.toString(16).padStart(64, '0'),
        })),
      },
      model: {
        httpAttempts: [
          { localAttemptOrdinal: 1, logicalDispatchOrdinal: 1, gatewayRequestIdDigests: ['1'.padStart(16, '0')] },
          { localAttemptOrdinal: 2, logicalDispatchOrdinal: 2, gatewayRequestIdDigests: ['2'.padStart(16, '0')] },
          { localAttemptOrdinal: 3, logicalDispatchOrdinal: 1, gatewayRequestIdDigests: ['3'.padStart(16, '0')] },
        ],
        callAccounting: {
          logicalCompletionDispatches: 2,
          localHttpRequestAttempts: 3,
          requestProfileAttemptCount: 3,
          requestAttemptAccountingMatches: true,
          dispatchAttemptAccountingMatches: true,
          dispatches: [
            { logicalDispatchOrdinal: 1, localAttemptOrdinals: [1, 3], localHttpRequestAttempts: 2 },
            { logicalDispatchOrdinal: 2, localAttemptOrdinals: [2], localHttpRequestAttempts: 1 },
          ],
        },
      },
    };
    expect(ws5.validatePublicRunCells(bundle.plan, concurrentCompletionOrder).status)
      .toBe('READY_FOR_BLIND_ADJUDICATION_WITH_DECLARED_COMPARATOR_SCOPE_LIMITATION');
    expect(ws5.validatePublicRunCells(bundle.plan, complete.slice(1))).toMatchObject({
      status: 'ABSTAIN',
      completeCells: 26,
      expectedCells: 28,
      qualityScore: null,
    });
    const missingPhysicalAttempt = complete.map((cell: any, index: number) => index === 0 ? {
      ...cell,
      model: {
        ...cell.model,
        callAccounting: {
          ...cell.model.callAccounting,
          localHttpRequestAttempts: 2,
          requestProfileAttemptCount: 2,
          dispatches: [{ localHttpRequestAttempts: 1 }, { localHttpRequestAttempts: 1 }],
        },
      },
    } : cell);
    const rejectedAttemptList = ws5.validatePublicRunCells(bundle.plan, missingPhysicalAttempt);
    expect(rejectedAttemptList.status).toBe('ABSTAIN');
    expect(rejectedAttemptList.issues).toContain('local_http_attempt_record_count_mismatch');
    const droppedLogicalAttempt = complete.map((cell: any, index: number) => index === 0 ? {
      ...cell,
      model: { ...cell.model, callAccounting: { ...cell.model.callAccounting,
        dispatches: [{ logicalDispatchOrdinal: 1, localAttemptOrdinals: [], localHttpRequestAttempts: 1 }] } },
    } : cell);
    const rejectedLogicalMapping = ws5.validatePublicRunCells(bundle.plan, droppedLogicalAttempt);
    expect(rejectedLogicalMapping.status).toBe('ABSTAIN');
    expect(rejectedLogicalMapping.issues).toContain('logical_dispatch_attempt_mapping_mismatch');
    const omittedSource = complete.map((cell: any, index: number) => index === 0
      ? { ...cell, source: { sourceOmissions: ['pinned_source_blob_unavailable'] } }
      : cell);
    expect(ws5.validatePublicRunCells(bundle.plan, omittedSource)).toMatchObject({
      status: 'ABSTAIN',
      qualityScore: null,
    });
  });

  it('keeps the fixed 28-cell order and the single reserved preflight-only cell', () => {
    const bundle = unitBundle;
    const cells = ws5.createPublicRunCellPlan(bundle.plan);

    expect(cells).toHaveLength(28);
    expect(cells.slice(0, 7).map((cell: any) => cell.armId)).toEqual(Array(7).fill('yeti-v1-native-baseline'));
    expect(cells.slice(7, 14).map((cell: any) => cell.armId)).toEqual(Array(7).fill('yeti-revised-medium'));
    expect(cells.slice(14, 21).map((cell: any) => cell.armId)).toEqual(Array(7).fill('alibaba-open-code-review'));
    expect(cells.slice(21, 28).map((cell: any) => cell.armId)).toEqual(Array(7).fill('yeti-revised-medium-repeat'));
    expect(cells[14]).toMatchObject({
      ordinal: 15,
      caseId: bundle.reservedAbstentionCaseId,
      execution: 'preflight_abstention',
      noModelDispatch: true,
      qualityScore: null,
    });
    expect(cells[15]).toMatchObject({ ordinal: 16, caseId: 'unit-case-02', execution: 'model_run' });
  });

  it('runs planned cells serially, writes one receipt per cell, and never retries a failed dispatch', async () => {
    const bundle = unitBundle;
    const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ws5-cell-run-'));
    const dispatches: string[] = [];
    const preflightCalls: string[] = [];
    const eventOrder: string[] = [];
    let activeCells = 0;
    let maxConcurrentCells = 0;
    try {
      const result = await ws5.runPublicRunCells(bundle, {
        outputDirectory,
        authorizeModelDispatch: true,
        preflightPanel: async () => {
          eventOrder.push('panel_preflight');
          return readyRootDispatchPreflight(bundle);
        },
        dispatchCell: async (cell: any) => {
          dispatches.push(`${cell.ordinal}:${cell.armId}:${cell.caseId}`);
          eventOrder.push(`dispatch:${cell.ordinal}`);
          activeCells += 1;
          maxConcurrentCells = Math.max(maxConcurrentCells, activeCells);
          try {
            await new Promise((resolve) => setTimeout(resolve, 1));
            if (dispatches.length === 1) throw new Error('synthetic provider failure');
            return { status: 'completed', armId: cell.armId, caseId: cell.caseId, qualityScore: null };
          } finally {
            activeCells -= 1;
          }
        },
        preflightAbstention: async (cell: any, alibabaPreflight: any) => {
          preflightCalls.push(`${cell.ordinal}:${cell.armId}:${cell.caseId}`);
          eventOrder.push(`abstain:${cell.ordinal}`);
          return alibaba.buildAlibabaSourceScopeAbstention(bundle, alibabaPreflight, cell.caseId);
        },
      });

      expect(dispatches).toHaveLength(27);
      expect(dispatches[0]).toBe(`1:yeti-v1-native-baseline:${bundle.reservedAbstentionCaseId}`);
      expect(preflightCalls).toEqual([`15:alibaba-open-code-review:${bundle.reservedAbstentionCaseId}`]);
      expect(eventOrder[0]).toBe('panel_preflight');
      expect(eventOrder[15]).toBe('abstain:15');
      expect(maxConcurrentCells).toBe(1);
      expect(result.cells).toHaveLength(28);
      expect(result.cells[0]).toMatchObject({ status: 'incomplete', noAutomaticRetry: true });
      expect(result.cells[14]).toMatchObject({ status: 'source_scope_unsupported', noModelDispatch: true });
      expect(fs.readdirSync(outputDirectory)).toHaveLength(29);
      const manifest = JSON.parse(fs.readFileSync(path.join(outputDirectory, 'run-manifest.json'), 'utf8'));
      expect(manifest).toMatchObject({ status: 'incomplete', expectedCells: 28, modelRunCells: 27,
        preflightAbstentions: 1, noAutomaticRetries: true, qualityScore: null,
        preflightPerformedBeforeFirstModelRunCell: true,
        preflightSummary: { sourceCaseIds: bundle.plan.publicPanel.caseIds, allSourceCachesVerified: true } });
      expect(manifest.preflightSummary.alibabaCaseStatuses).toHaveLength(7);
      expect(manifest.preflightSummary.alibabaCaseStatuses[0]).toMatchObject({
        caseId: bundle.reservedAbstentionCaseId, status: 'source_scope_unsupported',
      });
    } finally {
      fs.rmSync(outputDirectory, { recursive: true, force: true });
    }
  });

  it('marks a fully accounted matrix ready for blind adjudication without creating a quality score', async () => {
    const bundle = unitBundle;
    const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ws5-complete-cell-run-'));
    try {
      const result = await ws5.runPublicRunCells(bundle, {
        outputDirectory,
        authorizeModelDispatch: true,
        preflightPanel: async () => readyRootDispatchPreflight(bundle),
        dispatchCell: async (cell: any) => {
          const requestIdDigest = cell.ordinal.toString(16).padStart(16, '0');
          const evidenceDigest = cell.ordinal.toString(16).padStart(64, '0');
          const alibabaArm = cell.armId === 'alibaba-open-code-review';
          return {
            armId: cell.armId,
            caseId: cell.caseId,
            status: 'completed',
            source: { sourceOmissions: [], sourceReadOmissions: [], sourceCachePreflight: { status: 'verified' } },
            coverage: { rosterValid: true, quorumSatisfied: alibabaArm ? null : true,
              ...(alibabaArm ? { quorumComparable: false } : {}), fullPanelComplete: true },
            metrics: { totalTokens: 16, totalDurationMs: 20 },
            model: {
              httpAttempts: [{ localAttemptOrdinal: 1, logicalDispatchOrdinal: 1,
                gatewayRequestIdDigests: [requestIdDigest] }],
              callAccounting: { logicalCompletionDispatches: 1, localHttpRequestAttempts: 1,
                requestProfileAttemptCount: 1, requestAttemptAccountingMatches: true,
                dispatchAttemptAccountingMatches: true,
                dispatches: [{ logicalDispatchOrdinal: 1, localAttemptOrdinals: [1], localHttpRequestAttempts: 1 }] },
            },
            providerAttestation: { status: 'verified', evidenceSource: 'parent_broker_independent_telemetry',
              evidenceDigest: evidenceDigest, requests: [{ localAttemptOrdinal: 1,
              requestIdDigest, disposition: 'provider_completed', provider: 'provider-a',
              servedModel: 'model-a', servedEffort: null, evidenceDigest }] },
            qualityScore: null,
          };
        },
        preflightAbstention: async (cell: any, preflight: any) =>
          alibaba.buildAlibabaSourceScopeAbstention(bundle, preflight, cell.caseId),
      });

      expect(result.manifest).toMatchObject({
        status: 'READY_FOR_BLIND_ADJUDICATION_WITH_DECLARED_COMPARATOR_SCOPE_LIMITATION',
        expectedCells: 28,
        modelRunCells: 27,
        preflightAbstentions: 1,
        incompleteCells: 0,
        localHttpRequestAttempts: 27,
        logicalCompletionDispatches: 27,
        gatewayRelayCount: null,
        providerCompletionCount: null,
        billedRequestCount: null,
        actualCostUsd: null,
        qualityScore: null,
      });
      expect(result.manifest.acceptanceGate.commonComparatorDenominator).toBe(6);
    } finally {
      fs.rmSync(outputDirectory, { recursive: true, force: true });
    }
  });

  it('blocks model dispatch until root authorization and the complete no-call preflight pass', async () => {
    const bundle = unitBundle;
    const outputDirectory = path.join(os.tmpdir(), `ws5-blocked-run-${process.pid}-${Date.now()}`);
    let preflightCalls = 0;
    let dispatchCalls = 0;
    try {
      await expect(ws5.runPublicRunCells(bundle, {
        outputDirectory,
        authorizeModelDispatch: false,
        preflightPanel: async () => { preflightCalls += 1; return {}; },
        dispatchCell: async () => { dispatchCalls += 1; return {}; },
      })).rejects.toThrow('ws5_model_dispatch_not_authorized_by_root');
      expect(preflightCalls).toBe(0);
      expect(dispatchCalls).toBe(0);
      expect(fs.existsSync(outputDirectory)).toBe(false);

      const preflightFailure = await ws5.runPublicRunCells(bundle, {
        outputDirectory,
        authorizeModelDispatch: true,
        preflightPanel: async () => { preflightCalls += 1; return { status: 'not_ready' }; },
        dispatchCell: async () => { dispatchCalls += 1; return {}; },
        preflightAbstention: async () => ({}),
      });
      expect(preflightCalls).toBe(1);
      expect(dispatchCalls).toBe(0);
      expect(preflightFailure.cells).toHaveLength(28);
      expect(preflightFailure.manifest).toMatchObject({
        status: 'incomplete', modelRunCells: 0, incompleteCells: 28, qualityScore: null,
      });
      expect(fs.existsSync(outputDirectory)).toBe(true);
    } finally {
      fs.rmSync(outputDirectory, { recursive: true, force: true });
    }
  });

  it('writes one no-dispatch terminal per planned cell when root preflight fails', async () => {
    const bundle = unitBundle;
    const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ws5-preflight-abort-'));
    let dispatchCalls = 0;
    try {
      const result = await ws5.runPublicRunCells(bundle, {
        outputDirectory,
        authorizeModelDispatch: true,
        preflightPanel: async () => { throw new Error('stale_runtime_pin'); },
        dispatchCell: async () => { dispatchCalls += 1; return {}; },
        preflightAbstention: async () => { throw new Error('must_not_run'); },
      });

      expect(dispatchCalls).toBe(0);
      expect(result.cells).toHaveLength(28);
      expect(result.manifest).toMatchObject({
        status: 'incomplete',
        expectedCells: 28,
        modelRunCells: 0,
        preflightAbstentions: 0,
        incompleteCells: 28,
        noAutomaticRetries: true,
        providerRoutePreflight: 'not_ready',
        qualityScore: null,
      });
      expect(result.cells.every((cell: any) => cell.status === 'incomplete' && cell.noModelDispatch)).toBe(true);
      expect(fs.readdirSync(outputDirectory)).toHaveLength(29);
      const files = result.cells.map((cell: any) => cell.receiptFile);
      expect(new Set(files).size).toBe(28);
      const receipts = files.map((file: string) => JSON.parse(fs.readFileSync(path.join(outputDirectory, file), 'utf8')));
      expect(receipts.every((receipt: any) => receipt.outcome?.failureCode === 'stale_runtime_pin')).toBe(true);
    } finally {
      fs.rmSync(outputDirectory, { recursive: true, force: true });
    }
  });

  it('refuses source-tree output paths before dispatch and strips private receipt fields', async () => {
    const bundle = unitBundle;
    const insideSourceOutput = path.join(repoRoot, `.ws5-run-rejected-${process.pid}-${Date.now()}`);
    let dispatchCalls = 0;
    await expect(ws5.runPublicRunCells(bundle, {
      outputDirectory: insideSourceOutput,
      authorizeModelDispatch: true,
      preflightPanel: async () => readyRootDispatchPreflight(bundle),
      dispatchCell: async () => { dispatchCalls += 1; return {}; },
      preflightAbstention: async (cell: any, preflight: any) =>
        alibaba.buildAlibabaSourceScopeAbstention(bundle, preflight, cell.caseId),
    })).rejects.toThrow('ws5_run_output_must_be_outside_source_tree');
    expect(dispatchCalls).toBe(0);
    expect(fs.existsSync(insideSourceOutput)).toBe(false);

    const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ws5-private-receipt-'));
    try {
      const result = await ws5.runPublicRunCells(bundle, {
        outputDirectory,
        authorizeModelDispatch: true,
        preflightPanel: async () => readyRootDispatchPreflight(bundle),
        dispatchCell: async (cell: any) => {
          dispatchCalls += 1;
          return cell.ordinal === 1
            ? { status: 'completed', armId: cell.armId, caseId: cell.caseId,
              apiKey: 'private-receipt-sentinel', qualityScore: null }
            : { status: 'completed', armId: cell.armId, caseId: cell.caseId, qualityScore: null };
        },
        preflightAbstention: async (cell: any, preflight: any) =>
          alibaba.buildAlibabaSourceScopeAbstention(bundle, preflight, cell.caseId),
      });
      const firstReceipt = fs.readFileSync(path.join(outputDirectory, result.cells[0].receiptFile), 'utf8');
      expect(result.cells[0]).toMatchObject({ status: 'incomplete', runnerFailureCode: 'ws5_private_receipt_field_rejected' });
      expect(firstReceipt).not.toContain('private-receipt-sentinel');
    } finally {
      fs.rmSync(outputDirectory, { recursive: true, force: true });
    }
  });

  it('binds discovery run purpose, runtime, policy, and resources to the selected Yeti arm', () => {
    const bundle = unitBundle;
    const providerAttestations = new Map();
    const baseline = makePinnedYetiDiscoveryEnvelope(bundle, 'yeti-v1-native-baseline');
    const baselineCells = ws5.normalizeDiscoveryRunEnvelope(
      bundle, 'yeti-v1-native-baseline', baseline.run, providerAttestations,
      { expectedHostExecution: hostExecutionPin },
    );
    expect(baselineCells).toHaveLength(7);
    expect(baselineCells[0].caseId).toBe(bundle.reservedAbstentionCaseId);
    expect(baseline.run.cases[0].receipt.groundedReview).toBeUndefined();

    const revised = makePinnedYetiDiscoveryEnvelope(bundle, 'yeti-revised-medium');
    const revisedCells = ws5.normalizeDiscoveryRunEnvelope(
      bundle, 'yeti-revised-medium', revised.run, providerAttestations,
      { expectedRuntimeSha: revised.expectedRuntimeSha, expectedHostExecution: hostExecutionPin },
    );
    expect(revisedCells).toHaveLength(7);
    const repeat = makePinnedYetiDiscoveryEnvelope(bundle, 'yeti-revised-medium-repeat', revised.expectedRuntimeSha);
    expect(ws5.normalizeDiscoveryRunEnvelope(bundle, 'yeti-revised-medium-repeat', repeat.run,
      providerAttestations, { expectedRuntimeSha: revised.expectedRuntimeSha,
        expectedHostExecution: hostExecutionPin })).toHaveLength(7);

    const smokeLabeledAsRevised = structuredClone(revised.run);
    smokeLabeledAsRevised.executionPurpose = 'production_entrypoint_runtime_smoke_only';
    expect(() => ws5.normalizeDiscoveryRunEnvelope(bundle, 'yeti-revised-medium', smokeLabeledAsRevised,
      providerAttestations, { expectedRuntimeSha: revised.expectedRuntimeSha,
        expectedHostExecution: hostExecutionPin }))
      .toThrow('ws5_discovery_execution_purpose_mismatch');

    const wrongPolicy = structuredClone(revised.run);
    wrongPolicy.policy.effortProfile = 'native_omitted';
    expect(() => ws5.normalizeDiscoveryRunEnvelope(bundle, 'yeti-revised-medium', wrongPolicy,
      providerAttestations, { expectedRuntimeSha: revised.expectedRuntimeSha,
        expectedHostExecution: hostExecutionPin }))
      .toThrow('ws5_discovery_policy_binding_mismatch');

    const narrowedResources = structuredClone(revised.run);
    narrowedResources.requestedResourceLimits.effectiveMaxTurnsTotal = 4;
    expect(() => ws5.normalizeDiscoveryRunEnvelope(bundle, 'yeti-revised-medium', narrowedResources,
      providerAttestations, { expectedRuntimeSha: revised.expectedRuntimeSha,
        expectedHostExecution: hostExecutionPin }))
      .toThrow('ws5_discovery_resource_profile_mismatch');

    expect(() => ws5.normalizeDiscoveryRunEnvelope(bundle, 'yeti-revised-medium', revised.run,
      providerAttestations, { expectedRuntimeSha: 'c'.repeat(40), expectedHostExecution: hostExecutionPin }))
      .toThrow('ws5_discovery_runtime_pin_mismatch');
  });

  it('normalizes one exact planned case for a serial per-cell run', () => {
    const bundle = unitBundle;
    const fixture = makePinnedYetiDiscoveryEnvelope(bundle, 'yeti-v1-native-baseline');
    const caseId = bundle.plan.publicPanel.caseIds[0];
    const run = {
      ...fixture.run,
      selectedCaseIds: [caseId],
      cases: fixture.run.cases.filter((entry: any) => entry.caseId === caseId),
    };
    const normalized = ws5.normalizeDiscoveryRunEnvelope(
      bundle,
      'yeti-v1-native-baseline',
      run,
      new Map(),
      { selectedCaseId: caseId, expectedHostExecution: hostExecutionPin },
    );
    expect(normalized).toHaveLength(1);
    expect(normalized[0]).toMatchObject({ armId: 'yeti-v1-native-baseline', caseId, status: 'completed' });
  });

  it('retains sanitized generated findings from the actual runtime receipt through normalization', () => {
    const bundle = unitBundle;
    const fixture = makePinnedYetiDiscoveryEnvelope(bundle, 'yeti-v1-native-baseline');
    const caseId = bundle.plan.publicPanel.caseIds[0];
    const run = {
      ...fixture.run,
      selectedCaseIds: [caseId],
      cases: fixture.run.cases.filter((entry: any) => entry.caseId === caseId).map((entry: any) => ({
        ...entry,
        runtimeReceipt: { findings: [{
          id: 'finding-1', severity: 'P1', path: 'src/queue.ts', line: 24, lane: 'review-lane',
          title: 'Rejected event is retried', comment: 'The retry loop can re-submit a rejected event.',
        }] },
      })),
    };
    const normalized = ws5.normalizeDiscoveryRunEnvelope(
      bundle, 'yeti-v1-native-baseline', run, new Map(),
      { selectedCaseId: caseId, expectedHostExecution: hostExecutionPin },
    );
    expect(normalized[0].runtimeReceipt.findings).toEqual([{
      id: 'finding-1', severity: 'P1', path: 'src/queue.ts', line: 24, lane: 'review-lane',
      title: 'Rejected event is retried', comment: 'The retry loop can re-submit a rejected event.',
    }]);
  });

  it('joins per-request provider evidence by gateway request ID and preserves billing counts as unknown', () => {
    const joined = ws5.joinGatewayRequestAttestation([
      { localAttemptOrdinal: 1, gatewayRequestIdDigests: ['a'.repeat(16)] },
      { localAttemptOrdinal: 2, gatewayRequestIdDigests: [] },
    ], {
      status: 'verified',
      source: 'parent_broker_independent_telemetry',
      evidenceDigest: 'd'.repeat(64),
      requests: [
        { localAttemptOrdinal: 1, requestIdDigest: 'a'.repeat(16), disposition: 'provider_completed', provider: 'provider-a',
          servedModel: 'model-a', servedEffort: null, evidenceDigest: 'b'.repeat(64),
          requestId: 'raw-id-must-not-escape', headers: { authorization: 'raw-header-must-not-escape' } },
        { localAttemptOrdinal: 2, requestIdDigest: null, disposition: 'not_relayed_or_provider_completed',
          reasonCode: 'transport_error_before_gateway', evidenceDigest: 'c'.repeat(64) },
      ],
    });

    expect(joined).toMatchObject({ status: 'verified', localAttemptCount: 2, matchedGatewayRequestCount: 1,
      evidenceSource: 'parent_broker_independent_telemetry', evidenceDigest: 'd'.repeat(64),
      gatewayRelayCount: null, providerCompletionCount: null, billedRequestCount: null, actualCostUsd: null });
    expect(joined.requests).toEqual([
      { localAttemptOrdinal: 1, requestIdDigest: 'a'.repeat(16), disposition: 'provider_completed',
        provider: 'provider-a', servedModel: 'model-a', servedEffort: null, evidenceDigest: 'b'.repeat(64) },
      { localAttemptOrdinal: 2, requestIdDigest: null, disposition: 'not_relayed_or_provider_completed',
        reasonCode: 'transport_error_before_gateway', evidenceDigest: 'c'.repeat(64) },
    ]);
    expect(JSON.stringify(joined)).not.toMatch(/raw-id-must-not-escape|raw-header-must-not-escape/iu);
  });

  it('joins provider evidence by exact local ordinal when concurrent proxy attempts arrive out of order', () => {
    const joined = ws5.joinGatewayRequestAttestation([
      { localAttemptOrdinal: 2, gatewayRequestIdDigests: ['b'.repeat(16)] },
      { localAttemptOrdinal: 1, gatewayRequestIdDigests: ['a'.repeat(16)] },
    ], {
      status: 'verified',
      source: 'parent_broker_independent_telemetry',
      evidenceDigest: 'c'.repeat(64),
      requests: [
        { localAttemptOrdinal: 1, requestIdDigest: 'a'.repeat(16), disposition: 'provider_completed',
          provider: 'provider-a', servedModel: 'model-a', servedEffort: 'medium', evidenceDigest: 'd'.repeat(64) },
        { localAttemptOrdinal: 2, requestIdDigest: 'b'.repeat(16), disposition: 'provider_completed',
          provider: 'provider-a', servedModel: 'model-a', servedEffort: 'medium', evidenceDigest: 'e'.repeat(64) },
      ],
    });
    expect(joined.requests.map((entry: any) => entry.localAttemptOrdinal)).toEqual([1, 2]);
    expect(joined.requests.map((entry: any) => entry.requestIdDigest)).toEqual(['a'.repeat(16), 'b'.repeat(16)]);
    expect(() => ws5.joinGatewayRequestAttestation([
      { localAttemptOrdinal: 1, gatewayRequestIdDigests: ['a'.repeat(16)] },
      { localAttemptOrdinal: 3, gatewayRequestIdDigests: ['b'.repeat(16)] },
    ], {
      status: 'verified', source: 'parent_broker_independent_telemetry', evidenceDigest: 'c'.repeat(64),
      requests: [
        { localAttemptOrdinal: 1, requestIdDigest: 'a'.repeat(16), disposition: 'provider_completed',
          provider: 'provider-a', servedModel: 'model-a', evidenceDigest: 'd'.repeat(64) },
        { localAttemptOrdinal: 3, requestIdDigest: 'b'.repeat(16), disposition: 'provider_completed',
          provider: 'provider-a', servedModel: 'model-a', evidenceDigest: 'e'.repeat(64) },
      ],
    })).toThrow('gateway_local_attempt_ordinal_invalid');
  });

  it('rejects ambiguous or unmatched gateway request IDs instead of attesting a route', () => {
    expect(() => ws5.joinGatewayRequestAttestation([
      { localAttemptOrdinal: 1, gatewayRequestIdDigests: ['a'.repeat(16), 'b'.repeat(16)] },
    ], { status: 'verified', source: 'parent_broker_independent_telemetry', evidenceDigest: 'e'.repeat(64),
      requests: [{ requestIdDigest: 'a'.repeat(16), disposition: 'provider_completed', provider: 'provider-a',
      servedModel: 'model-a', evidenceDigest: 'c'.repeat(64) }] })).toThrow('gateway_request_id_join_ambiguous');
    expect(() => ws5.joinGatewayRequestAttestation([
      { localAttemptOrdinal: 1, gatewayRequestIdDigests: ['a'.repeat(16)] },
    ], { status: 'verified', source: 'parent_broker_independent_telemetry', evidenceDigest: 'e'.repeat(64),
      requests: [{ requestIdDigest: 'd'.repeat(16), disposition: 'provider_completed', provider: 'provider-a',
      servedModel: 'model-a', evidenceDigest: 'c'.repeat(64) }] })).toThrow('gateway_request_id_join_mismatch');
  });

  it('requires an independently verified parent broker receipt before joining route evidence', () => {
    expect(() => ws5.joinGatewayRequestAttestation([
      { localAttemptOrdinal: 1, gatewayRequestIdDigests: ['a'.repeat(16)] },
    ], { requests: [{ requestIdDigest: 'a'.repeat(16), disposition: 'provider_completed', provider: 'provider-a',
      servedModel: 'model-a', evidenceDigest: 'b'.repeat(64) }] })).toThrow('gateway_parent_broker_evidence_unverified');
  });

  it('deduplicates causal findings across runs and reports introduced, preexisting, nit, and unresolved separately', () => {
    const result = ws5.summarizeFindingJudgments([
      { caseId: 'case-a', armId: 'revised', findingId: 'f1', severity: 'P1' },
      { caseId: 'case-a', armId: 'revised-repeat', findingId: 'f2', severity: 'P1' },
      { caseId: 'case-b', armId: 'revised', findingId: 'f3', severity: 'P2' },
      { caseId: 'case-c', armId: 'revised', findingId: 'f4', severity: 'P2' },
      { caseId: 'case-d', armId: 'revised', findingId: 'f5', severity: 'P1' },
    ], {
      judge: { kind: 'independent_human', protocolId: 'ws5-blind-v1' },
      judgments: [
        { findingId: 'f1', causalId: 'cause-introduced', class: 'introduced_defect' },
        { findingId: 'f2', causalId: 'cause-introduced', class: 'introduced_defect' },
        { findingId: 'f3', causalId: 'cause-preexisting', class: 'preexisting_defect' },
        { findingId: 'f4', causalId: 'cause-nit', class: 'nit' },
      ],
    });

    expect(result).toMatchObject({
      uniqueCausalFindingCount: 3,
      introducedDefectCount: 1,
      preexistingFindingCount: 1,
      nitCount: 1,
      unresolvedCount: 1,
      judgmentsComplete: false,
    });
    expect(result.repeatPairs).toEqual([{ causalId: 'cause-introduced', occurrenceCount: 2 }]);
  });

  it('separates local HTTP attempts from logical completion calls and stage turns', async () => {
    const identity = {
      requestedModels: new Set<string>(),
      responseModels: new Set<string>(),
      responseProviders: new Set<string>(),
      responseRouteHints: new Set<string>(),
      requestIdDigests: new Set<string>(),
      fetchFailureClasses: new Set<string>(),
      fetchToHeadersMs: [] as number[],
      httpStatuses: [] as number[],
      requestProfiles: new Map<string, any>(),
      pendingResponseMetadataReads: [] as Promise<void>[],
    };
    let attempts = 0;
    const wrappedFetch = benchmark.trackCompletion(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('synthetic retryable connection failure');
      return new Response(JSON.stringify({ model: 'model-after-retry' }), { status: 200 });
    }, identity);
    const request = { method: 'POST', body: JSON.stringify({ model: 'pr-reviewer', stream: false }) };
    await expect(wrappedFetch('https://gateway.invalid/v1/chat/completions', request)).rejects.toThrow();
    await wrappedFetch('https://gateway.invalid/v1/chat/completions', request);
    await Promise.all(identity.pendingResponseMetadataReads);

    const summary = benchmark.identitySummary(identity);
    expect(summary.localHttpRequestAttempts).toBe(2);
    expect(summary.requestProfileAttemptCount).toBe(2);
    expect(summary.fetchFailureClasses).toEqual(['TRANSPORT_ERROR']);
    expect(summary.responseReportedModels).toEqual(['model-after-retry']);
  });

  it('attributes physical retries to a logical completion without merging stages', async () => {
    const identity = {
      requestedModels: new Set<string>(), responseModels: new Set<string>(), responseProviders: new Set<string>(),
      responseRouteHints: new Set<string>(), requestIdDigests: new Set<string>(), fetchFailureClasses: new Set<string>(),
      fetchToHeadersMs: [], httpStatuses: [], requestProfiles: new Map<string, any>(), pendingResponseMetadataReads: [],
    };
    let attempts = 0;
    const wrappedFetch = benchmark.trackCompletion(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('retryable');
      return new Response(JSON.stringify({ model: 'response-model' }), {
        status: 200, headers: { 'x-bifrost-request-id': 'gateway-request-1' },
      });
    }, identity);
    const dispatches: any[] = [];
    const request = { method: 'POST', body: JSON.stringify({ model: 'pr-reviewer', stream: false }) };
    await benchmark.trackLogicalCompletion('review', dispatches, async () => {
      try { await wrappedFetch('https://gateway.invalid/v1/chat/completions', request); } catch {}
      return wrappedFetch('https://gateway.invalid/v1/chat/completions', request);
    });
    await benchmark.trackLogicalCompletion('verifier', dispatches, async () => 'local-no-http-error');
    await Promise.all(identity.pendingResponseMetadataReads);

    expect(dispatches).toHaveLength(2);
    expect(dispatches[0]).toMatchObject({
      logicalDispatchOrdinal: 1, stage: 'review', outcome: 'returned', localAttemptOrdinals: [1, 2], localHttpRequestAttempts: 2,
      classification: 'http_attempted',
    });
    expect(dispatches[1]).toMatchObject({
      logicalDispatchOrdinal: 2, stage: 'verifier', outcome: 'returned', localAttemptOrdinals: [], localHttpRequestAttempts: 0,
      classification: 'returned_without_http_attempt',
    });
    expect(benchmark.identitySummary(identity).httpAttempts).toMatchObject([
      { localAttemptOrdinal: 1, status: 'transport_error' },
      { localAttemptOrdinal: 2, status: 'http_response', gatewayRequestIdDigests: [crypto.createHash('sha256').update('gateway-request-1').digest('hex').slice(0, 16)] },
    ]);
  });

  it('keeps logical dispatch ordinals in start order when concurrent completions finish out of order', async () => {
    const dispatches: any[] = [];
    const identity = {
      requestedModels: new Set<string>(), responseModels: new Set<string>(), responseProviders: new Set<string>(),
      responseRouteHints: new Set<string>(), requestIdDigests: new Set<string>(), fetchFailureClasses: new Set<string>(),
      fetchToHeadersMs: [] as number[], httpStatuses: [] as number[], requestProfiles: new Map<string, any>(),
      pendingResponseMetadataReads: [] as Promise<void>[],
    };
    let releaseReview!: () => void;
    let releaseVerifier!: () => void;
    let markReviewStarted!: () => void;
    let markVerifierStarted!: () => void;
    const reviewStarted = new Promise<void>((resolve) => { markReviewStarted = resolve; });
    const verifierStarted = new Promise<void>((resolve) => { markVerifierStarted = resolve; });
    const wrappedFetch = benchmark.trackCompletion(async (_url: string, init: any) => {
      const request = JSON.parse(init.body);
      return new Promise<Response>((resolve) => {
        const finish = () => resolve(new Response(JSON.stringify({ model: 'served-model' }), {
          status: 200, headers: { 'x-bifrost-request-id': request.marker },
        }));
        if (request.marker === 'review-request') {
          releaseReview = finish;
          markReviewStarted();
        } else {
          releaseVerifier = finish;
          markVerifierStarted();
        }
      });
    }, identity);
    const request = (marker: string) => ({ method: 'POST', body: JSON.stringify({
      model: 'pr-reviewer', stream: false, marker,
    }) });
    const review = benchmark.trackLogicalCompletion('review', dispatches,
      () => wrappedFetch('https://gateway.invalid/v1/chat/completions', request('review-request')));
    const verifier = benchmark.trackLogicalCompletion('verifier', dispatches,
      () => wrappedFetch('https://gateway.invalid/v1/chat/completions', request('verifier-request')));

    await Promise.all([reviewStarted, verifierStarted]);
    releaseVerifier();
    await verifier;
    releaseReview();
    await review;
    await Promise.all(identity.pendingResponseMetadataReads);

    expect(dispatches.map((entry) => entry.logicalDispatchOrdinal)).toEqual([1, 2]);
    expect(dispatches.map((entry) => entry.stage)).toEqual(['review', 'verifier']);
    expect(dispatches.map((entry) => entry.localAttemptOrdinals)).toEqual([[1], [2]]);
    expect((benchmark.identitySummary(identity).httpAttempts as any[]).map((entry) => ({
      localAttemptOrdinal: entry.localAttemptOrdinal,
      logicalDispatchOrdinal: entry.logicalDispatchOrdinal,
    }))).toEqual([
      { localAttemptOrdinal: 1, logicalDispatchOrdinal: 1 },
      { localAttemptOrdinal: 2, logicalDispatchOrdinal: 2 },
    ]);
  });

  it('normalizes Alibaba output into source coverage and sanitized findings without claiming a quorum or route', () => {
    const sourceCase: any = unitBundle.preparedDiscovery.cases[0];
    const sourcePath = sourceCase.changedFiles[0].path;
    const expectedChangedPaths = [sourcePath];
    const proxyReceipt = {
      receivedCompletionAttempts: 1, logicalCompletionDispatches: 1, forwardedCompletionAttempts: 1,
      resourceCapRejectionCount: 0, invalidRetryHeaderCount: 0, unknownAttemptCount: 0,
      dispatchAttemptAccountingMatches: true,
        dispatches: [{ logicalDispatchOrdinal: 1, localAttemptOrdinals: [1], localHttpRequestAttempts: 1,
          stage: 'alibaba', classification: 'http_attempted' }],
      requests: [{ localAttemptOrdinal: 1, logicalDispatchStart: true, logicalDispatchOrdinal: 1,
        sdkRetryOrdinal: 0, gatewayRequestIdDigest: 'a'.repeat(16), httpStatus: 200, outcome: 'upstream_response_complete',
        responseReportedProvider: 'untrusted-header', responseReportedModel: 'untrusted-body',
        reasoningEffort: 'medium', maxOutputTokens: 1000, stream: true }],
    };
    const output = {
      status: 'complete',
      llm: { provider: 'untrusted-provider', model: 'pr-reviewer' },
      summary: { input_tokens: 3, output_tokens: 5, total_tokens: 8 },
      manifest: {
        terminal_state: 'complete',
        coverage: {
          selected: expectedChangedPaths.map((filePath) => ({ path: filePath })),
          completed: expectedChangedPaths.map((filePath) => ({ path: filePath })),
          reused: [], failed: [], waived: [],
        },
      },
      comments: [{ path: sourcePath, start_line: 1, end_line: 1, severity: 'low', category: 'bug',
        content: 'A public fixture finding.', thinking: 'must be stripped from the normalized receipt' }],
    };
    const normalizationOptions = {
      caseId: sourceCase.caseId, sourceCase, elapsedMs: 100, binarySha256: alibaba.ALIBABA_OPEN_CODE_REVIEW_PIN.binarySha256,
      modelAlias: 'pr-reviewer', proxyReceipt, expectedChangedPaths,
      sourceCachePreflight: { status: 'verified' },
      cliSource: {
        cliFromSha: sourceCase.diffBaseSha, cliToSha: sourceCase.headSha,
        actualMergeBaseSha: sourceCase.diffBaseSha, diffBaseSha: sourceCase.diffBaseSha,
        pinnedHeadSha: sourceCase.headSha, pinnedHeadTreeSha: 'c'.repeat(40),
        projectionCommitSha: null, projectionTreeSha: null,
        projectionMode: 'native_aacr_dataset_base_to_pinned_head',
        ancestryHydration: 'test-native-history', hydrationFailureClass: null,
        diffEvidence: { changedPaths: [sourcePath], sourceLineContentAndHunksExact: true },
      },
      sourceScope: { defaultPathExclusions: [], ruleSha256: null, scopeOverride: 'none' },
    };
    const normalized = alibaba.normalizeAlibabaRun(output, normalizationOptions);

    expect(normalized).toMatchObject({
      status: 'completed',
      coverage: { fullPanelComplete: true, quorumSatisfied: null, quorumComparable: false },
      providerAttestation: null,
      qualityScore: null,
      model: { requestedAlias: 'pr-reviewer', responseReportedModel: 'pr-reviewer', callAccounting: {
        logicalCompletionDispatches: 1, localHttpRequestAttempts: 1, requestAttemptAccountingMatches: true,
      } },
    });
    expect(JSON.stringify(normalized)).not.toContain('must be stripped');
    expect(normalized.model.responseReportedProvider).toBe('untrusted-provider');
    expect(normalized.providerAttestation).toBeNull();
    expect(normalized.model.callAccounting.dispatches[0]).toMatchObject({
      logicalDispatchOrdinal: 1, localAttemptOrdinals: [1], localHttpRequestAttempts: 1,
    });

    const twoFileSourceCase = { ...sourceCase, changedFiles: sourceCase.changedFiles.slice(0, 2) };
    const twoFilePaths = twoFileSourceCase.changedFiles.map((entry: any) => entry.path).sort();
    const malformedPartitions = [
      { completed: [twoFilePaths[0], 'outside-public-case.ts'], reused: [] },
      { completed: [twoFilePaths[0], twoFilePaths[0]], reused: [] },
      { completed: [twoFilePaths[0]], reused: [twoFilePaths[0]] },
    ];
    for (const partition of malformedPartitions) {
      const malformedOutput = structuredClone(output);
      malformedOutput.manifest.coverage = {
        selected: twoFilePaths.map((filePath: string) => ({ path: filePath })),
        completed: partition.completed.map((filePath: string) => ({ path: filePath })),
        reused: partition.reused.map((filePath: string) => ({ path: filePath })),
        failed: [],
        waived: [],
      } as any;
      const invalid = alibaba.normalizeAlibabaRun(malformedOutput, {
        ...normalizationOptions,
        sourceCase: twoFileSourceCase,
        expectedChangedPaths: twoFilePaths,
      });
      expect(invalid.status).toBe('incomplete');
      expect(invalid.coverage.fullPanelComplete).toBe(false);
    }
  });

  it('verifies the exact merge-base diff against GitHub Compare independent of hunk context width', () => {
    const localPatch = [
      'diff --git a/src/app.ts b/src/app.ts',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -10,3 +10,3 @@',
      ' keepOne();',
      '-deny();',
      '+allow();',
      ' keepTwo();',
      '',
    ].join('\n');
    const githubPatch = [
      'diff --git a/src/app.ts b/src/app.ts',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -11 +11 @@',
      '-deny();',
      '+allow();',
      '',
    ].join('\n');
    const evidence = sourceProvenance.verifyPinnedComparison({
      manifestCase: {
        datasetBaseSha: 'a'.repeat(40),
        diffBaseSha: 'b'.repeat(40),
        mergeBaseSha: 'b'.repeat(40),
        baseSha: 'b'.repeat(40),
        headSha: 'c'.repeat(40),
      },
      compare: {
        status: 'diverged',
        mergeBaseSha: 'b'.repeat(40),
        files: [{ filename: 'src/app.ts', patch: githubPatch, additions: 1, deletions: 1 }],
      },
      preparedCase: {
        changedFiles: [{ path: 'src/app.ts', patch: localPatch }],
        sourceOmissions: [],
      },
    });

    expect(evidence).toMatchObject({
      status: 'verified',
      mergeBaseMatchesDiffBase: true,
      pathSetsMatch: true,
      changedLinesMatch: true,
      changedFileCount: 1,
    });
    expect(evidence.datasetBaseSha).toBe('a'.repeat(40));
    expect(evidence.diffBaseSha).toBe('b'.repeat(40));
  });

  it('rejects a comparison that silently substitutes a different merge base', () => {
    expect(() => sourceProvenance.verifyPinnedComparison({
      manifestCase: {
        datasetBaseSha: 'a'.repeat(40),
        diffBaseSha: 'b'.repeat(40),
        mergeBaseSha: 'b'.repeat(40),
        baseSha: 'b'.repeat(40),
        headSha: 'c'.repeat(40),
      },
      compare: {
        mergeBaseSha: 'd'.repeat(40),
        files: [],
      },
      preparedCase: { changedFiles: [], sourceOmissions: [] },
    })).toThrow('github_compare_merge_base_mismatch');
  });

  it('rebuilds the unit-only introduction-to-repair commit chain deterministically', () => {
    const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ws5-repair-fixture-first-'));
    const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ws5-repair-fixture-second-'));
    fs.rmSync(firstRoot, { recursive: true, force: true });
    fs.rmSync(secondRoot, { recursive: true, force: true });
    try {
      const first = repairBuilder.buildWs5RepairSequence(firstRoot);
      const second = repairBuilder.buildWs5RepairSequence(secondRoot);
      expect(first).toEqual(second);
      expect(first.phases).toHaveLength(2);
      const inputs = first.phases.map((entry: any) => {
        const bytes = fs.readFileSync(path.join(firstRoot, 'inputs', entry.caseId + '.json'));
        const input = JSON.parse(bytes.toString('utf8'));
        expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe(entry.inputSha256);
        expect(input.source.baseSha).toBe(entry.baseSha);
        expect(input.source.headSha).toBe(entry.headSha);
        expect(input.source.revisions).toHaveLength(entry.phase === 'introduction' ? 2 : 3);
        return input;
      });
      expect(inputs[0].source.headSha).toBe(inputs[1].source.baseSha);
      expect(benchmark.assertBlindDiscoveryInputCases(inputs)).toBe(true);
    } finally {
      fs.rmSync(firstRoot, { recursive: true, force: true });
      fs.rmSync(secondRoot, { recursive: true, force: true });
    }
  });

  it('rebuilds the bounded large cross-file unit fixture with full source and no scoring labels', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ws5-large-fixture-rebuild-'));
    fs.rmSync(directory, { recursive: true, force: true });
    try {
      const descriptor = largeBuilder.buildWs5LargeCrossfileFixture(directory);
      const inputBytes = fs.readFileSync(path.join(directory, 'inputs/ws5-large-crossfile-v1.json'));
      const input = JSON.parse(inputBytes.toString('utf8'));
      expect(descriptor.baseSha).toBe(input.source.baseSha);
      expect(descriptor.headSha).toBe(input.source.headSha);
      expect(crypto.createHash('sha256').update(inputBytes).digest('hex')).toBe(descriptor.inputSha256);
      expect(descriptor.changedFileCount).toBe(24);
      expect(input.source.revisions).toHaveLength(2);
      expect(input.source.revisions.every((revision: any) => revision.files.length === 24)).toBe(true);
      expect(JSON.stringify(input)).not.toMatch(/expectedDecision|expectedFinding|expectedLabel|oracle/iu);
      expect(benchmark.assertBlindDiscoveryInputCases([input])).toBe(true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it('rebuilds the synthetic display-sort source fixture with exact full snapshots and no labels', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ws5-p2-fixture-rebuild-'));
    fs.rmSync(directory, { recursive: true, force: true });
    try {
      const descriptor = p2Builder.buildWs5P2DisplaySortFixture(directory);
      const inputBytes = fs.readFileSync(path.join(directory, 'inputs/ws5-p2-display-sort-v1.json'));
      const input = JSON.parse(inputBytes.toString('utf8'));
      expect(descriptor.caseId).toBe(input.caseId);
      expect(descriptor.baseSha).toBe(input.source.baseSha);
      expect(descriptor.headSha).toBe(input.source.headSha);
      expect(crypto.createHash('sha256').update(inputBytes).digest('hex')).toBe(descriptor.inputSha256);
      expect(input.source.revisions).toHaveLength(2);
      expect(input.source.revisions.every((revision: any) => revision.files.length === 3)).toBe(true);
      expect(JSON.stringify(input)).not.toMatch(/expectedDecision|expectedFinding|expectedLabel|oracle|candidates|history/iu);
      expect(benchmark.assertBlindDiscoveryInputCases([input])).toBe(true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('binds the Alibaba child to a generated loopback bearer before counting or forwarding requests', async () => {
    const { proxy, localToken } = alibaba.createAlibabaLocalBroker({
      upstreamBaseUrl: 'https://bifrost.invalid',
      apiKey: 'parent-memory-only-sentinel',
      modelAlias: 'pr-reviewer',
      maxForwardedAttempts: 1,
      maxInboundAttempts: 1,
      mode: 'normal',
    });
    const localUrl = await proxy.listen();
    try {
      const childEnvironment = alibaba.createAlibabaChildEnvironment({
        home: path.join(os.tmpdir(), 'ws5-alibaba-child-home'),
        modelAlias: 'pr-reviewer',
        localUrl,
        localToken,
      });
      expect(childEnvironment.OCR_LLM_URL).toBe(localUrl);
      expect(childEnvironment.OCR_LLM_TOKEN).toBe(localToken);
      const body = JSON.stringify({ model: 'pr-reviewer', stream: false, max_tokens: 32 });
      const unauthorized = await fetch(`${localUrl}/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body,
      });
      expect(unauthorized.status).toBe(401);
      const acceptedBoundary = await fetch(`${localUrl}/chat/completions`, {
        method: 'POST', headers: { authorization: `Bearer ${localToken}`, 'content-type': 'application/json' }, body,
      });
      expect(acceptedBoundary.status).toBe(400);
      expect(proxy.snapshot()).toMatchObject({ receivedCompletionAttempts: 1, forwardedCompletionAttempts: 0 });
      expect(JSON.stringify(proxy.snapshot())).not.toContain(localToken);
      expect(JSON.stringify(proxy.snapshot())).not.toContain('parent-memory-only-sentinel');
    } finally {
      await proxy.close();
    }
  });

  it('keeps ingress and forwarded attempts when Alibaba result JSON cannot be parsed', () => {
    const proxyReceipt = {
      receivedCompletionAttempts: 4,
      logicalCompletionDispatches: 2,
      forwardedCompletionAttempts: 2,
      dispatchAttemptAccountingMatches: true,
      dispatches: [
        { logicalDispatchOrdinal: 1, localAttemptOrdinals: [1, 3], localHttpRequestAttempts: 2 },
        { logicalDispatchOrdinal: 2, localAttemptOrdinals: [2, 4], localHttpRequestAttempts: 2 },
      ],
      requests: [1, 2, 3, 4].map((localAttemptOrdinal) => ({
        localAttemptOrdinal,
        logicalDispatchOrdinal: localAttemptOrdinal % 2 === 1 ? 1 : 2,
        sdkRetryOrdinal: localAttemptOrdinal % 2 === 1 ? 0 : 1,
        logicalMappingStatus: 'sdk_retry_linked_by_body_digest_and_retry_ordinal',
        gatewayRequestIdDigest: localAttemptOrdinal === 1 ? 'a'.repeat(16) : null,
        outcome: localAttemptOrdinal <= 2 ? 'forwarded' : 'locally_rejected_resource_cap',
        httpStatus: localAttemptOrdinal <= 2 ? 200 : 429,
        rawRequestId: 'must-not-be-serialized',
      })),
    };
    const receipt = alibaba.normalizeAlibabaOutputOrFailure(Buffer.from('{invalid json'), {
      failureOptions: {
        caseId: 'unit-case-02',
        modelAlias: 'pr-reviewer',
        failureCode: 'alibaba_result_json_invalid',
        elapsedMs: 25,
        sourceCachePreflight: { status: 'verified' },
        proxyReceipt,
      },
    });
    expect(receipt).toMatchObject({
      caseId: 'unit-case-02', status: 'incomplete', qualityScore: null,
      outcome: { failureCode: 'alibaba_result_json_invalid' },
      model: { callAccounting: {
        localHttpRequestAttempts: 4, forwardedCompletionAttempts: 2, logicalCompletionDispatches: 2,
      } },
    });
    expect(receipt.model.httpAttempts).toHaveLength(4);
    expect(JSON.stringify(receipt)).not.toContain('must-not-be-serialized');
  });
});
