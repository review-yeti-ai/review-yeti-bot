import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export const R2_PHASE_ID = 'ws5-current-source-external-v2-r2';
export const R2_COHORT_PLAN_SHA256 = '37fcfc37440e249e97b892186c2a0683b31654a540e146232ec579012160c233';
export const R2_BUNDLE_SHA256 = 'd83b08f04890604fd1bfe98105e6db7ad70945afb1e5471218ca62d2204cc3bc';
export const R2_BUNDLE_PATH = 'eval-baselines/competitive-review-benchmark/ws5-external-normal-v3/source-bundle.json';
export const R2_INPUT_MANIFEST_SHA256 = 'fa792e36e552e025b9756a3d7ab58bc02db31f5d51b52156ec76d9be1500649f';
export const R2_SEQUENCE_ID = 'ws5-r2-h001';

const BUNDLE_DIRECTORY = 'eval-baselines/competitive-review-benchmark/ws5-external-normal-v3';
const BUNDLE_SCHEMA_VERSION = 'WS5ExternalNormalBundle.v3';
const PLAN_SCHEMA_VERSION = 'WS5NextExternalNormalV2CohortDraft.v1';
const PLAN_STATUS = 'offline-draft-nondispatchable-awaiting-worker-fixture-admission-and-final-source-image-binding';
const CASES = Object.freeze([
  Object.freeze({
    caseId: 'ws5-r2-c001',
    inputPath: `${BUNDLE_DIRECTORY}/inputs/input-001.json`,
    inputSha256: '54bb996bbd1caee73b313bc25676253469bdc9f40496ed937a0cfad32c29b162',
    schemaVersion: 'WS5RepairReviewInput.v1',
    repository: Object.freeze({ repositoryId: 73004, owner: 'synthetic', repo: 'fixture-display-sort' }),
    prNumber: 51,
    baseSha: '9d9232e0fae8d370ef2570c1129f836b9b1a1c36',
    headSha: '5440774cbd3465150755f08a917bf724c92a372d',
  }),
  Object.freeze({
    caseId: 'ws5-r2-c002',
    inputPath: `${BUNDLE_DIRECTORY}/inputs/input-002.json`,
    inputSha256: 'f1b5a2f7b838cacd039972da5de7cb066ca838882e31e840190850591ae5c37f',
    schemaVersion: 'WS5RepairReviewInput.v1',
    repository: Object.freeze({ repositoryId: 73002, owner: 'synthetic', repo: 'fixture-sequence' }),
    prNumber: 52,
    baseSha: 'b2beab2ab2c6369a0d6352a78af795d92246b7f3',
    headSha: 'e62ac7e8846d80864cacc65699268097caa31223',
  }),
  Object.freeze({
    caseId: 'ws5-r2-c003',
    inputPath: `${BUNDLE_DIRECTORY}/inputs/input-003.json`,
    inputSha256: '6fcfa7a254eb960ae3a2ef79358e06205e6812c748e353679ead1578b11a1e84',
    schemaVersion: 'WS5RepairReviewInput.v1',
    repository: Object.freeze({ repositoryId: 73002, owner: 'synthetic', repo: 'fixture-sequence' }),
    prNumber: 52,
    baseSha: 'e62ac7e8846d80864cacc65699268097caa31223',
    headSha: '81d910d8a133563e76e5a700ba65fb58b7dcdc72',
  }),
  Object.freeze({
    caseId: 'ws5-r2-c004',
    inputPath: `${BUNDLE_DIRECTORY}/inputs/input-004.json`,
    inputSha256: 'e3cfadf9e9937c66d4c8fdfd90d97668fc691a185bba6960cb8379b276b9cb97',
    schemaVersion: 'WS5RepairReviewInput.v1',
    repository: Object.freeze({ repositoryId: 73003, owner: 'synthetic', repo: 'fixture-large-crossfile' }),
    prNumber: 53,
    baseSha: 'a3e317cb730f8001039869c522d79f5793ccdc85',
    headSha: 'ebd7011b8170dd4b650ce924c335a6cd84fccbfe',
  }),
]);

const STEP_SPECS = Object.freeze([
  Object.freeze({
    stepId: 'r2-s001', caseIndex: 0, arm: 'p2-only', kind: 'normal-review',
    historyMode: 'complete-empty-context', clientCallCap: 53, reservationMs: 240_000,
  }),
  Object.freeze({
    stepId: 'r2-s002', caseIndex: 0, arm: 'p2-only', kind: 'normal-review-repeat',
    historyMode: 'complete-empty-context', clientCallCap: 53, reservationMs: 240_000,
    rawExtras: Object.freeze({ repeatOfStepId: 'r2-s001' }),
  }),
  Object.freeze({
    stepId: 'r2-s003', caseIndex: 1, arm: 'repair-introduction', kind: 'normal-review',
    historyMode: 'no-history; persist completed A receipt for B context only',
    clientCallCap: 53, reservationMs: 240_000,
    historySequenceId: R2_SEQUENCE_ID,
    rawExtras: Object.freeze({ historySequenceId: R2_SEQUENCE_ID }),
  }),
  Object.freeze({
    stepId: 'r2-s004', caseIndex: 2, arm: 'repair-head-history', kind: 'normal-review-repair-head',
    historyMode: 'load only the completed A receipt with matching new ancestry/runtime/policy; approval is never reusable',
    historySourceStepId: 'r2-s003', historySequenceId: R2_SEQUENCE_ID,
    clientCallCap: 53, reservationMs: 240_000,
    rawExtras: Object.freeze({ historySequenceId: R2_SEQUENCE_ID, historySourceStepId: 'r2-s003' }),
  }),
  Object.freeze({
    stepId: 'r2-s005', caseIndex: 2, arm: 'repair-head-empty-history', kind: 'normal-review-full-source-contrast',
    historyMode: 'empty context; inspect full current source for same B head',
    clientCallCap: 53, reservationMs: 240_000, historySequenceId: R2_SEQUENCE_ID,
    rawExtras: Object.freeze({ historySequenceId: R2_SEQUENCE_ID, pairedStepId: 'r2-s004' }),
  }),
  Object.freeze({
    stepId: 'r2-s006', caseIndex: 3, arm: 'preflight-source-coverage-control',
    kind: 'zero-call-source-coverage-control', historyMode: null, clientCallCap: null,
    allocation: 0, reservationMs: 15_000,
    rawHistoryMode: false, rawClientCallCap: false,
    rawExtras: Object.freeze({ fault: Object.freeze({ readPath: 'src/queue/selector.ts', availability: 'unavailable' }),
      expectedTransportCalls: 0, expectedDisposition: 'incomplete-or-abstain-before-planning' }),
  }),
  Object.freeze({
    stepId: 'r2-s007', caseIndex: 2, arm: 'repair-head-history-unavailable',
    kind: 'zero-call-required-history-control', historyMode: null,
    historySourceStepId: 'r2-s003', clientCallCap: null, allocation: 0, reservationMs: 15_000,
    rawHistoryMode: false, rawClientCallCap: false,
    historySequenceId: R2_SEQUENCE_ID,
    rawExtras: Object.freeze({ historySequenceId: R2_SEQUENCE_ID, historySourceStepId: 'r2-s003',
      fault: Object.freeze({ historyRead: 'typed-transport-unavailable-before-task-planning' }),
      expectedTransportCalls: 0, expectedDisposition: 'incomplete-or-abstain' }),
  }),
  Object.freeze({
    stepId: 'r2-s008', caseIndex: 0, arm: 'provider-failure',
    kind: 'one-call-invalid-inference-credential-control', historyMode: 'complete-empty-context',
    clientCallCap: 1, reservationMs: 30_000,
    rawExtras: Object.freeze({ credentialMode: 'fixed-disposable-invalid-sentinel-in-child-memory; do not read real inference key',
      expectedTerminal: 'one HTTP 401 and incomplete/ABSTAIN; no approval',
      bifrostRow: 'best-effort only for this expected pre-logging authentication failure' }),
  }),
  Object.freeze({
    stepId: 'r2-s009', caseIndex: 0, arm: 'resource-exhaustion',
    kind: 'one-call-resource-exhaustion-control', historyMode: 'complete-empty-context',
    clientCallCap: 1, reservationMs: 60_000,
    rawExtras: Object.freeze({ expectedTerminal: 'one actual request, then bounded exhaustion; incomplete/ABSTAIN and no approval' }),
  }),
]);

const TIME_ENVELOPE = Object.freeze({
  phaseWallLimitMs: 1_800_000,
  normalArmActiveDeadlineMs: 240_000,
  normalArmActiveReservationTotalMs: 1_200_000,
  providerAuthControlReservationMs: 30_000,
  resourceExhaustionControlReservationMs: 60_000,
  coverageHoleControlReservationMs: 15_000,
  requiredHistoryControlReservationMs: 15_000,
  sharedExactLogCaptureActiveReserveMs: 300_000,
  orchestrationAndTeardownReserveMs: 180_000,
  sumOfReservationsMs: 1_800_000,
  captureDoesNotExtendChildDeadline: true,
  normalCallsSerial: true,
});

const PHYSICAL_CALL_ENVELOPE = Object.freeze({
  authorizedCohortCap: 300,
  alreadyConsumedWithinCohort: 25,
  remainingWithinCohort: 275,
  normalArms: 5,
  outerCapPerNormalArm: 53,
  normalArmAllocationTotal: 265,
  providerAuthControlCap: 1,
  resourceExhaustionControlCap: 1,
  coverageHoleControlCap: 0,
  requiredHistoryUnavailableControlCap: 0,
  allocatedNewCalls: 267,
  unspendableReserve: 8,
  maximumCurrentCohortSpendIncludingPrior25: 292,
  historicalConsumptionBeforeCurrentCohort: 150,
  maximumAuditedCumulativePhysicalAttempts: 442,
  overallHistoricalCeiling: 2700,
  unsuccessfulClientAttemptsCountTowardCap: true,
  stopBeforeAnyRequestWhenArmCapReached: true,
  noAutomaticRetries: true,
  noExtraCallsToFinishAnIncompleteArm: true,
  normalArmAt53WithoutTerminalReceipt: 'incomplete/ABSTAIN; do not continue or extend',
});

const SERVICE_BUDGET = Object.freeze({
  capabilityVersion: 'ReviewProviderAttemptBudget.v1',
  totalLimitPerNormalReview: 100,
  investigationLimit: 88,
  verifierReserve: 12,
  totalIncludesVerifierReserve: true,
  operatorOverride: 'unset',
  centralPolicyMaxTasks: 8,
  maxReviewAssignments: 24,
});

function reject(code) {
  throw new Error(`external_normal_r2_plan_invalid:${code}`);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exact(actual, expected, code) {
  if (!isDeepStrictEqual(actual, expected)) reject(code);
}

function exactKeys(value, keys, code) {
  if (!isRecord(value)) reject(code);
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...keys].sort();
  if (!isDeepStrictEqual(actualKeys, expectedKeys)) reject(code);
}

function rejectOutcomeOrOracleFields(value, code = 'outcome_oracle_field_forbidden') {
  if (Array.isArray(value)) {
    for (const entry of value) rejectOutcomeOrOracleFields(entry, code);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (/oracle|outcome|label/iu.test(key)) {
      const allowedFalseFlag = (key === 'containsOutcomeLabels' || key === 'oracleLabelsIncluded'
        || key === 'privateExpectedOutcomeLabelsInChildInput' || key === 'planManifestAndReviewOracleMountedToWorker')
        && entry === false;
      if (!allowedFalseFlag) reject(code);
    }
    rejectOutcomeOrOracleFields(entry, code);
  }
}

function expectedBundle() {
  return { schemaVersion: BUNDLE_SCHEMA_VERSION, cases: CASES };
}

function expectedTarget(casePin) {
  return {
    repositoryId: casePin.repository.repositoryId,
    repository: `${casePin.repository.owner}/${casePin.repository.repo}`,
    prNumber: casePin.prNumber,
    caseId: casePin.caseId,
    inputPath: `inputs/${casePin.inputPath.split('/').at(-1)}`,
    inputSha256: casePin.inputSha256,
    baseSha: casePin.baseSha,
    headSha: casePin.headSha,
  };
}

function validateBundle(sourceBundle) {
  exactKeys(sourceBundle, ['schemaVersion', 'cases'], 'source_bundle_shape_invalid');
  exact(sourceBundle, expectedBundle(), 'source_bundle_pins_invalid');
  return CASES.map((casePin) => ({
    ...casePin,
    repository: { ...casePin.repository },
    bundleRelativeInputPath: `inputs/${casePin.inputPath.split('/').at(-1)}`,
  }));
}

function validateStep(rawStep, spec, casePin) {
  const keys = [
    'stepId', 'caseId', 'inputPath', 'inputSha256', 'kind',
    ...(spec.rawHistoryMode === false ? [] : ['historyMode']),
    ...(spec.rawClientCallCap === false ? [] : ['clientCallCap']),
    ...Object.keys(spec.rawExtras ?? {}),
  ];
  exactKeys(rawStep, keys, `step_shape_invalid:${spec.stepId}`);
  const expectedRaw = {
    stepId: spec.stepId,
    caseId: casePin.caseId,
    inputPath: `inputs/${casePin.inputPath.split('/').at(-1)}`,
    inputSha256: casePin.inputSha256,
    kind: spec.kind,
    ...(spec.rawHistoryMode === false ? {} : { historyMode: spec.historyMode }),
    ...(spec.rawClientCallCap === false ? {} : { clientCallCap: spec.clientCallCap }),
    ...(spec.rawExtras ?? {}),
  };
  exact(rawStep, expectedRaw, `step_binding_invalid:${spec.stepId}`);
  const allocation = spec.allocation ?? spec.clientCallCap;
  const { inputPath: sourceInputPath, bundleRelativeInputPath, ...caseTuple } = casePin;
  return {
    ...rawStep,
    historyMode: spec.historyMode,
    clientCallCap: spec.clientCallCap,
    arm: spec.arm,
    clientCallAllocation: allocation,
    reservationMs: spec.reservationMs,
    activeDeadlineMs: spec.reservationMs,
    ...caseTuple,
    repositoryId: casePin.repository.repositoryId,
    targetRepositoryId: casePin.repository.repositoryId,
    repositoryName: `${casePin.repository.owner}/${casePin.repository.repo}`,
    sourceInputPath,
    bundleRelativeInputPath,
    ...(spec.historySequenceId ? { historySequenceId: spec.historySequenceId } : {}),
  };
}

function validatePlanShape(plan) {
  exactKeys(plan, [
    'schemaVersion', 'phaseId', 'status', 'dispatchAuthorization', 'sourceBundle', 'targets',
    'rootGo', 'inferenceHttpRequests', 'managementLogGets', 'targetScope', 'steps', 'timeEnvelope',
    'physicalCallEnvelope', 'workerDispatches', 'inputs', 'workerInputBoundary', 'routeBinding',
    'privateLauncherContract', 'runtimeBinding', 'serviceBudget', 'captureAndStopRules',
  ], 'plan_shape_invalid');
  exact(plan.schemaVersion, PLAN_SCHEMA_VERSION, 'schema_version_invalid');
  exact(plan.phaseId, R2_PHASE_ID, 'phase_id_invalid');
  exact(plan.status, PLAN_STATUS, 'status_invalid');
  exact(plan.dispatchAuthorization, false, 'dispatch_must_be_disabled');
  exact(plan.rootGo, false, 'root_go_must_be_disabled');
  exact(plan.inferenceHttpRequests, 0, 'inference_requests_must_be_zero');
  exact(plan.managementLogGets, 0, 'management_log_gets_must_be_zero');
  exact(plan.workerDispatches, 0, 'worker_dispatch_must_be_zero');

  exactKeys(plan.sourceBundle, [
    'schemaVersion', 'draftArtifactPath', 'futureRepositoryPath', 'rawSha256', 'caseCount',
    'containsOutcomeLabels', 'workerImageAdmissionPending',
  ], 'source_bundle_descriptor_shape_invalid');
  exact(plan.sourceBundle, {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    draftArtifactPath: 'source-bundle.json',
    futureRepositoryPath: R2_BUNDLE_PATH,
    rawSha256: R2_BUNDLE_SHA256,
    caseCount: 4,
    containsOutcomeLabels: false,
    workerImageAdmissionPending: true,
  }, 'source_bundle_descriptor_invalid');

  exact(plan.targets, CASES.map(expectedTarget), 'target_tuples_invalid');
  exact(plan.targetScope, {
    syntheticOnly: true,
    githubOrAppWrites: 0,
    newRepositoryIds: false,
    newSyntheticPullRequestNumbers: [51, 52, 53],
    noActualGitHubPullRequests: true,
  }, 'target_scope_invalid');
  exact(plan.steps.length, STEP_SPECS.length, 'step_count_invalid');

  exactKeys(plan.timeEnvelope, Object.keys(TIME_ENVELOPE), 'time_envelope_shape_invalid');
  exact(plan.timeEnvelope, TIME_ENVELOPE, 'time_envelope_invalid');
  exactKeys(plan.physicalCallEnvelope, Object.keys(PHYSICAL_CALL_ENVELOPE), 'physical_call_envelope_shape_invalid');
  exact(plan.physicalCallEnvelope, PHYSICAL_CALL_ENVELOPE, 'physical_call_envelope_invalid');
  exactKeys(plan.inputs, ['manifestPath', 'manifestSha256', 'allInputsSynthetic', 'oracleLabelsIncluded', 'inputCount'],
    'input_manifest_shape_invalid');
  exact(plan.inputs, {
    manifestPath: 'input-manifest.json',
    manifestSha256: R2_INPUT_MANIFEST_SHA256,
    allInputsSynthetic: true,
    oracleLabelsIncluded: false,
    inputCount: 4,
  }, 'input_manifest_invalid');

  exactKeys(plan.workerInputBoundary, [
    'childReceivesSourceInputAndConstrainedExecutionProjection', 'planManifestAndReviewOracleMountedToWorker',
    'sourceBundleManifestMountedToWorker', 'childInputs', 'opaqueCaseIds', 'opaqueStepIds',
    'neutralSyntheticCommitMessages', 'projectionFieldsAreRunnerMetadataNotModelPromptFields',
    'privateExpectedOutcomeLabelsInChildInput', 'modelPromptContainsProjectionMetadata',
    'promptBoundaryMustBeReverifiedAgainstMergedConsumerFix',
  ], 'worker_input_boundary_shape_invalid');
  exact(plan.workerInputBoundary, {
    childReceivesSourceInputAndConstrainedExecutionProjection: true,
    planManifestAndReviewOracleMountedToWorker: false,
    sourceBundleManifestMountedToWorker: false,
    childInputs: ['inputs/input-001.json', 'inputs/input-002.json', 'inputs/input-003.json', 'inputs/input-004.json'],
    opaqueCaseIds: true,
    opaqueStepIds: true,
    neutralSyntheticCommitMessages: true,
    projectionFieldsAreRunnerMetadataNotModelPromptFields: [
      'stepId', 'caseId', 'arm', 'historyMode', 'targetRepositoryId', 'inputSha256', 'runId', 'runtime', 'policy',
    ],
    privateExpectedOutcomeLabelsInChildInput: false,
    modelPromptContainsProjectionMetadata: false,
    promptBoundaryMustBeReverifiedAgainstMergedConsumerFix: true,
  }, 'worker_input_boundary_invalid');

  exactKeys(plan.routeBinding, [
    'status', 'consumerFixSourceRevision', 'consumerFixSourceTree', 'consumerFixPublicationStatus',
    'samePreviouslyApprovedTransportProfileOnly', 'routeIdentityDtoSchema', 'requiredFields',
    'actualPrivateRouteValuesIncluded', 'routeProofRequirement',
  ], 'route_binding_shape_invalid');
  exact(plan.routeBinding, {
    status: 'host-route-consumer-fix-merged; final source/image/runtime binding remains pending',
    consumerFixSourceRevision: '84918c4234841b85688208122249cc87bcfb8aaf',
    consumerFixSourceTree: '84640baba5ea143f37b5275fbc71d6cd41501ee5',
    consumerFixPublicationStatus: 'host source merged; current image publication is still pending',
    samePreviouslyApprovedTransportProfileOnly: true,
    routeIdentityDtoSchema: 'ReviewYetiExternalNormalQualificationRouteIdentity.v1',
    requiredFields: ['routingRuleId', 'routingRuleName', 'provider', 'model', 'sourceConfigurationSha256'],
    actualPrivateRouteValuesIncluded: false,
    routeProofRequirement: 'Every successful normal call must exact-join its caller CID and prove the admitted alias/provider/resolved-model identity. Missing identity stops later normal arms; do not infer a Bifrost alias from the worker request or resolved provider/model.',
  }, 'route_binding_invalid');

  exactKeys(plan.privateLauncherContract, [
    'status', 'routeIdentityDtoIsSeparateFromAdapterPrivateBindingV1', 'routeIdentityDtoPassedThrough',
    'rootGoTupleBindsRouteIdentityDto', 'missingOrWrongDtoMustBeRejected', 'old9945AndAttempt4LaunchersAreIneligible',
    'hostCoordinatorModuleBindingSeparateFromWorkerModuleBinding',
  ], 'private_launcher_contract_shape_invalid');
  exact(plan.privateLauncherContract, {
    status: 'required-before-final-binding',
    routeIdentityDtoIsSeparateFromAdapterPrivateBindingV1: true,
    routeIdentityDtoPassedThrough: [
      'private parent case factory', 'buildExternalNormalV2AuthorizationTuple', 'runExternalNormalQualificationV2',
    ],
    rootGoTupleBindsRouteIdentityDto: true,
    missingOrWrongDtoMustBeRejected: true,
    old9945AndAttempt4LaunchersAreIneligible: true,
    hostCoordinatorModuleBindingSeparateFromWorkerModuleBinding: true,
  }, 'private_launcher_contract_invalid');

  exactKeys(plan.runtimeBinding, [
    'status', 'workerFixtureAdmission', 'legacyFixturePinsMayBeRebound', 'sourceCommit', 'sourceTree',
    'workerImageIndexDigest', 'workerPlatformDigest', 'workerRuntimeManifestSha256',
    'hostCoordinatorSourceAndBuildSha256', 'preparedPolicyAndConfigDigests', 'phaseRootPathAndIdentity',
    'phaseRootMustBeFreshAndEmpty', 'previousRootsMayBeReused',
  ], 'runtime_binding_shape_invalid');
  exact(plan.runtimeBinding, {
    status: 'deferred-until-worker-fixture-admission-and-publisher-image-are-frozen',
    workerFixtureAdmission: 'new source-owned typed pins are required for opaque case IDs and these new input hashes',
    legacyFixturePinsMayBeRebound: false,
    sourceCommit: null,
    sourceTree: null,
    workerImageIndexDigest: null,
    workerPlatformDigest: null,
    workerRuntimeManifestSha256: null,
    hostCoordinatorSourceAndBuildSha256: null,
    preparedPolicyAndConfigDigests: null,
    phaseRootPathAndIdentity: null,
    phaseRootMustBeFreshAndEmpty: true,
    previousRootsMayBeReused: false,
  }, 'runtime_binding_invalid');

  exactKeys(plan.captureAndStopRules, [
    'normalArmOrderIsSerial', 'captureEachNormalArmBeforeStartingTheNext', 'successfulCallsRequireExactCidRow',
    'successfulCallsRequireRouteIdentityProof', 'unknownCidOrRouteIdentityStopsLaterNormalArms',
    'workerFailureNeverRecastAsSuccessfulReview', 'recordActualCallsTokensAndWallTimeOnly',
    'bifrostCostIsCalculatedEstimateNotInvoice', 'actualProviderBilledUsdUnknownUnlessTrustedInvoiceEvidenceExists',
    'servedProviderModelEffortUnknownUnlessDirectlyObserved',
  ], 'capture_stop_rules_shape_invalid');
  exact(plan.captureAndStopRules, {
    normalArmOrderIsSerial: true,
    captureEachNormalArmBeforeStartingTheNext: true,
    successfulCallsRequireExactCidRow: true,
    successfulCallsRequireRouteIdentityProof: true,
    unknownCidOrRouteIdentityStopsLaterNormalArms: true,
    workerFailureNeverRecastAsSuccessfulReview: true,
    recordActualCallsTokensAndWallTimeOnly: true,
    bifrostCostIsCalculatedEstimateNotInvoice: true,
    actualProviderBilledUsdUnknownUnlessTrustedInvoiceEvidenceExists: true,
    servedProviderModelEffortUnknownUnlessDirectlyObserved: true,
  }, 'capture_stop_rules_invalid');

  exactKeys(plan.serviceBudget, Object.keys(SERVICE_BUDGET), 'service_budget_shape_invalid');
  exact(plan.serviceBudget, SERVICE_BUDGET, 'service_budget_invalid');
}

function makeExecutionEnvelope() {
  const allocations = STEP_SPECS.map((spec) => spec.allocation ?? spec.clientCallCap);
  const reservations = STEP_SPECS.map((spec) => spec.reservationMs);
  return {
    maxPhaseClientCalls: PHYSICAL_CALL_ENVELOPE.remainingWithinCohort,
    authorizedCohortCap: PHYSICAL_CALL_ENVELOPE.authorizedCohortCap,
    alreadyConsumedWithinCohort: PHYSICAL_CALL_ENVELOPE.alreadyConsumedWithinCohort,
    declaredArmTotal: PHYSICAL_CALL_ENVELOPE.allocatedNewCalls,
    unspendableSharedReserve: PHYSICAL_CALL_ENVELOPE.unspendableReserve,
    perArmClientHttpAttemptAllocation: {
      normalArms: PHYSICAL_CALL_ENVELOPE.normalArms,
      outerCapPerNormalArm: PHYSICAL_CALL_ENVELOPE.outerCapPerNormalArm,
      normalArmAllocationTotal: PHYSICAL_CALL_ENVELOPE.normalArmAllocationTotal,
      providerAuthControl: PHYSICAL_CALL_ENVELOPE.providerAuthControlCap,
      resourceExhaustionControl: PHYSICAL_CALL_ENVELOPE.resourceExhaustionControlCap,
      coveragePreflightControl: PHYSICAL_CALL_ENVELOPE.coverageHoleControlCap,
      requiredHistoryPreflightControl: PHYSICAL_CALL_ENVELOPE.requiredHistoryUnavailableControlCap,
      declaredArmTotal: PHYSICAL_CALL_ENVELOPE.allocatedNewCalls,
      unspendableSharedReserve: PHYSICAL_CALL_ENVELOPE.unspendableReserve,
    },
    perArmClientCallAllocations: allocations,
    perArmTimeReservationMs: reservations,
    normalArmActiveDeadlineMs: TIME_ENVELOPE.normalArmActiveDeadlineMs,
    normalArmActiveReservationTotalMs: TIME_ENVELOPE.normalArmActiveReservationTotalMs,
    reservationLedgerMs: {
      normalArms: TIME_ENVELOPE.normalArmActiveReservationTotalMs,
      providerAuthControl: TIME_ENVELOPE.providerAuthControlReservationMs,
      resourceExhaustionControl: TIME_ENVELOPE.resourceExhaustionControlReservationMs,
      coveragePreflightControl: TIME_ENVELOPE.coverageHoleControlReservationMs,
      requiredHistoryPreflightControl: TIME_ENVELOPE.requiredHistoryControlReservationMs,
      exactLogCaptureOutsideChild: TIME_ENVELOPE.sharedExactLogCaptureActiveReserveMs,
      orchestrationAndTeardown: TIME_ENVELOPE.orchestrationAndTeardownReserveMs,
      total: TIME_ENVELOPE.phaseWallLimitMs,
    },
    phaseWallLimitMs: TIME_ENVELOPE.phaseWallLimitMs,
    exactLogCaptureReserveMs: TIME_ENVELOPE.sharedExactLogCaptureActiveReserveMs,
    orchestrationAndTeardownReserveMs: TIME_ENVELOPE.orchestrationAndTeardownReserveMs,
    captureOutsideChildDeadline: TIME_ENVELOPE.captureDoesNotExtendChildDeadline,
    normalCallsSerial: TIME_ENVELOPE.normalCallsSerial,
    maxTasksPerNormalReview: SERVICE_BUDGET.centralPolicyMaxTasks,
    maxReviewAssignmentsPerNormalReview: SERVICE_BUDGET.maxReviewAssignments,
    trustedProviderAttemptBudget: {
      capabilityVersion: SERVICE_BUDGET.capabilityVersion,
      totalLimit: SERVICE_BUDGET.totalLimitPerNormalReview,
      investigationLimit: SERVICE_BUDGET.investigationLimit,
      verifierReserve: SERVICE_BUDGET.verifierReserve,
      totalIncludesVerifierReserve: SERVICE_BUDGET.totalIncludesVerifierReserve,
      operatorOverride: SERVICE_BUDGET.operatorOverride,
    },
  };
}

/**
 * Validate a parsed, immutable R2 host plan against its exact public bundle and
 * descriptor digest. This pure boundary only admits the pinned cohort; callers
 * retain ownership of file reads, host bindings, and execution.
 */
export function validateExternalNormalR2CohortPlan(executionPlan, sourceBundle, descriptorSha256, descriptorBytes) {
  if (!(Buffer.isBuffer(descriptorBytes) || descriptorBytes instanceof Uint8Array)) {
    reject('descriptor_bytes_missing');
  }
  const rawDescriptorBytes = Buffer.from(descriptorBytes);
  const actualDescriptorSha256 = createHash('sha256').update(rawDescriptorBytes).digest('hex');
  exact(actualDescriptorSha256, R2_COHORT_PLAN_SHA256, 'descriptor_sha256_invalid');
  exact(descriptorSha256, actualDescriptorSha256, 'descriptor_sha256_argument_mismatch');
  let parsedDescriptor;
  try { parsedDescriptor = JSON.parse(rawDescriptorBytes.toString('utf8')); }
  catch { reject('descriptor_json_invalid'); }
  exact(executionPlan, parsedDescriptor, 'descriptor_object_mismatch');
  rejectOutcomeOrOracleFields(executionPlan);
  rejectOutcomeOrOracleFields(sourceBundle);
  const cases = validateBundle(sourceBundle);
  validatePlanShape(executionPlan);
  const runs = STEP_SPECS.map((spec, index) => {
    const rawStep = executionPlan.steps[index];
    const casePin = cases[spec.caseIndex];
    return validateStep(rawStep, spec, casePin);
  });
  const executionEnvelope = makeExecutionEnvelope();
  return {
    phaseId: R2_PHASE_ID,
    descriptorSha256: R2_COHORT_PLAN_SHA256,
    schemaVersion: PLAN_SCHEMA_VERSION,
    sourceBundle: {
      version: BUNDLE_SCHEMA_VERSION,
      path: R2_BUNDLE_PATH,
      sha256: R2_BUNDLE_SHA256,
    },
    cases,
    runs,
    steps: runs,
    executionEnvelope,
  };
}
