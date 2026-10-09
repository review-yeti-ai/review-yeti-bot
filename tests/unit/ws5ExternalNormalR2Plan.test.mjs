import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  R2_BUNDLE_PATH,
  R2_BUNDLE_SHA256,
  R2_COHORT_PLAN_SHA256,
  R2_INPUT_MANIFEST_SHA256,
  R2_PHASE_ID,
  validateExternalNormalR2CohortPlan,
} from '../../scripts/ws5-external-normal-r2-plan.mjs';

const bundlePath = 'eval-baselines/competitive-review-benchmark/ws5-external-normal-v3/';
const casePins = [
  {
    caseId: 'ws5-r2-c001', inputPath: 'input-001.json',
    inputSha256: '54bb996bbd1caee73b313bc25676253469bdc9f40496ed937a0cfad32c29b162',
    repositoryId: 73004, owner: 'synthetic', repo: 'fixture-display-sort', prNumber: 51,
    baseSha: '9d9232e0fae8d370ef2570c1129f836b9b1a1c36', headSha: '5440774cbd3465150755f08a917bf724c92a372d',
  },
  {
    caseId: 'ws5-r2-c002', inputPath: 'input-002.json',
    inputSha256: 'f1b5a2f7b838cacd039972da5de7cb066ca838882e31e840190850591ae5c37f',
    repositoryId: 73002, owner: 'synthetic', repo: 'fixture-sequence', prNumber: 52,
    baseSha: 'b2beab2ab2c6369a0d6352a78af795d92246b7f3', headSha: 'e62ac7e8846d80864cacc65699268097caa31223',
  },
  {
    caseId: 'ws5-r2-c003', inputPath: 'input-003.json',
    inputSha256: '6fcfa7a254eb960ae3a2ef79358e06205e6812c748e353679ead1578b11a1e84',
    repositoryId: 73002, owner: 'synthetic', repo: 'fixture-sequence', prNumber: 52,
    baseSha: 'e62ac7e8846d80864cacc65699268097caa31223', headSha: '81d910d8a133563e76e5a700ba65fb58b7dcdc72',
  },
  {
    caseId: 'ws5-r2-c004', inputPath: 'input-004.json',
    inputSha256: 'e3cfadf9e9937c66d4c8fdfd90d97668fc691a185bba6960cb8379b276b9cb97',
    repositoryId: 73003, owner: 'synthetic', repo: 'fixture-large-crossfile', prNumber: 53,
    baseSha: 'a3e317cb730f8001039869c522d79f5793ccdc85', headSha: 'ebd7011b8170dd4b650ce924c335a6cd84fccbfe',
  },
];

function sourceBundle() {
  return {
    schemaVersion: 'WS5ExternalNormalBundle.v3',
    cases: casePins.map((pin) => ({
      caseId: pin.caseId,
      inputPath: `${bundlePath}inputs/${pin.inputPath}`,
      inputSha256: pin.inputSha256,
      schemaVersion: 'WS5RepairReviewInput.v1',
      repository: { repositoryId: pin.repositoryId, owner: pin.owner, repo: pin.repo },
      prNumber: pin.prNumber,
      baseSha: pin.baseSha,
      headSha: pin.headSha,
    })),
  };
}

const descriptorBytes = readFileSync(new URL('../fixtures/qualification/ws5-r2-cohort-plan.json', import.meta.url));
const frozenExecutionPlan = JSON.parse(descriptorBytes.toString('utf8'));

test('admits the frozen R2 host plan and returns pinned normalized runs', () => {
  const bundle = sourceBundle();
  const descriptorSha256 = createHash('sha256').update(descriptorBytes).digest('hex');
  assert.equal(descriptorSha256, R2_COHORT_PLAN_SHA256);
  const admitted = validateExternalNormalR2CohortPlan(
    structuredClone(frozenExecutionPlan), bundle, descriptorSha256, descriptorBytes,
  );

  assert.equal(admitted.phaseId, R2_PHASE_ID);
  assert.equal(admitted.descriptorSha256, R2_COHORT_PLAN_SHA256);
  assert.equal(admitted.sourceBundle.version, 'WS5ExternalNormalBundle.v3');
  assert.equal(admitted.sourceBundle.path, R2_BUNDLE_PATH);
  assert.equal(admitted.sourceBundle.sha256, R2_BUNDLE_SHA256);
  assert.equal(admitted.runs, admitted.steps);
  assert.deepEqual(admitted.runs.map(({ stepId }) => stepId),
    ['r2-s001', 'r2-s002', 'r2-s003', 'r2-s004', 'r2-s005', 'r2-s006', 'r2-s007', 'r2-s008', 'r2-s009']);
  assert.deepEqual(admitted.runs.map(({ arm }) => arm), [
    'p2-only', 'p2-only', 'repair-introduction', 'repair-head-history', 'repair-head-empty-history',
    'preflight-source-coverage-control', 'repair-head-history-unavailable', 'provider-failure', 'resource-exhaustion',
  ]);
  assert.deepEqual(admitted.runs.map(({ clientCallAllocation }) => clientCallAllocation),
    [53, 53, 53, 53, 53, 0, 0, 1, 1]);
  assert.deepEqual(admitted.runs.map(({ reservationMs }) => reservationMs),
    [240_000, 240_000, 240_000, 240_000, 240_000, 15_000, 15_000, 30_000, 60_000]);
  assert.equal(admitted.runs[3].historySourceStepId, 'r2-s003');
  assert.equal(admitted.runs[3].historySequenceId, 'ws5-r2-h001');
  assert.equal(admitted.cases.length, 4);
  assert.equal(admitted.executionEnvelope.maxPhaseClientCalls, 275);
  assert.equal(admitted.executionEnvelope.declaredArmTotal, 267);
  assert.equal(admitted.executionEnvelope.unspendableSharedReserve, 8);
  assert.equal(admitted.executionEnvelope.alreadyConsumedWithinCohort, 25);
  assert.equal(admitted.executionEnvelope.authorizedCohortCap, 300);
  assert.deepEqual(admitted.executionEnvelope.perArmClientCallAllocations, [53, 53, 53, 53, 53, 0, 0, 1, 1]);
  assert.deepEqual(admitted.executionEnvelope.perArmTimeReservationMs,
    [240_000, 240_000, 240_000, 240_000, 240_000, 15_000, 15_000, 30_000, 60_000]);
  assert.deepEqual(admitted.executionEnvelope.perArmClientHttpAttemptAllocation, {
    normalArms: 5,
    outerCapPerNormalArm: 53,
    normalArmAllocationTotal: 265,
    providerAuthControl: 1,
    resourceExhaustionControl: 1,
    coveragePreflightControl: 0,
    requiredHistoryPreflightControl: 0,
    declaredArmTotal: 267,
    unspendableSharedReserve: 8,
  });
  assert.deepEqual(admitted.executionEnvelope.reservationLedgerMs, {
    normalArms: 1_200_000,
    providerAuthControl: 30_000,
    resourceExhaustionControl: 60_000,
    coveragePreflightControl: 15_000,
    requiredHistoryPreflightControl: 15_000,
    exactLogCaptureOutsideChild: 300_000,
    orchestrationAndTeardown: 180_000,
    total: 1_800_000,
  });
  assert.equal(admitted.executionEnvelope.phaseWallLimitMs, 1_800_000);
  assert.equal(admitted.executionEnvelope.maxTasksPerNormalReview, 8);
  assert.equal(admitted.executionEnvelope.maxReviewAssignmentsPerNormalReview, 24);
  assert.deepEqual(admitted.executionEnvelope.trustedProviderAttemptBudget, {
    capabilityVersion: 'ReviewProviderAttemptBudget.v1',
    totalLimit: 100,
    investigationLimit: 88,
    verifierReserve: 12,
    totalIncludesVerifierReserve: true,
    operatorOverride: 'unset',
  });
});

test('rejects descriptor, step identity, input, cap, and ordering substitutions', () => {
  const bundle = sourceBundle();
  const plan = structuredClone(frozenExecutionPlan);
  assert.throws(() => validateExternalNormalR2CohortPlan(plan, bundle, '0'.repeat(64), descriptorBytes));
  const wrongBytes = Buffer.from(descriptorBytes);
  wrongBytes[0] ^= 1;
  assert.throws(() => validateExternalNormalR2CohortPlan(plan, bundle, R2_COHORT_PLAN_SHA256, wrongBytes));

  const wrongId = structuredClone(plan);
  wrongId.steps[0].caseId = 'ws5-r2-c002';
  assert.throws(() => validateExternalNormalR2CohortPlan(wrongId, bundle, R2_COHORT_PLAN_SHA256, descriptorBytes));

  const wrongInput = structuredClone(plan);
  wrongInput.steps[0].inputSha256 = '0'.repeat(64);
  assert.throws(() => validateExternalNormalR2CohortPlan(wrongInput, bundle, R2_COHORT_PLAN_SHA256, descriptorBytes));

  const wrongCap = structuredClone(plan);
  wrongCap.steps[0].clientCallCap = 54;
  assert.throws(() => validateExternalNormalR2CohortPlan(wrongCap, bundle, R2_COHORT_PLAN_SHA256, descriptorBytes));

  const wrongOrder = structuredClone(plan);
  [wrongOrder.steps[0], wrongOrder.steps[1]] = [wrongOrder.steps[1], wrongOrder.steps[0]];
  assert.throws(() => validateExternalNormalR2CohortPlan(wrongOrder, bundle, R2_COHORT_PLAN_SHA256, descriptorBytes));
});

test('rejects altered source tuples, budget ledger, service budget, and label-bearing fields', () => {
  const bundle = sourceBundle();
  const plan = structuredClone(frozenExecutionPlan);

  const wrongSourceTuple = structuredClone(bundle);
  wrongSourceTuple.cases[0].repository.repositoryId = 73002;
  assert.throws(() => validateExternalNormalR2CohortPlan(plan, wrongSourceTuple, R2_COHORT_PLAN_SHA256, descriptorBytes));

  const wrongLedger = structuredClone(plan);
  wrongLedger.timeEnvelope.sumOfReservationsMs -= 1;
  assert.throws(() => validateExternalNormalR2CohortPlan(wrongLedger, bundle, R2_COHORT_PLAN_SHA256, descriptorBytes));

  const wrongBudget = structuredClone(plan);
  wrongBudget.serviceBudget.investigationLimit = 89;
  assert.throws(() => validateExternalNormalR2CohortPlan(wrongBudget, bundle, R2_COHORT_PLAN_SHA256, descriptorBytes));

  const withOracle = structuredClone(plan);
  withOracle.steps[0].oracleLabel = 'expected-pass';
  assert.throws(() => validateExternalNormalR2CohortPlan(withOracle, bundle, R2_COHORT_PLAN_SHA256, descriptorBytes));
});
