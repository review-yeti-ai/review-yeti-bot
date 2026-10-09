import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  NORMAL_ENGINE_QUALIFICATION_PLAN_CASE_IDS,
  parseNormalEngineQualificationRequest,
  qualificationArmAllowedForFixture,
  qualificationFixturePin,
  validateQualificationFixtureInput,
  validateQualificationFixtureInputBytes,
} from '../../src/qualification/normalEngineQualification';
import { normalEngineQualificationBudgetProfileForArm } from '../../src/qualification/normalEngineQualificationWorker';

const cases = [
  {
    caseId: 'ws5-r2-c001', input: 'input-001.json',
    sha256: '54bb996bbd1caee73b313bc25676253469bdc9f40496ed937a0cfad32c29b162',
    repositoryId: 73004, repository: 'synthetic/fixture-display-sort', prNumber: 51,
    baseSha: '9d9232e0fae8d370ef2570c1129f836b9b1a1c36', headSha: '5440774cbd3465150755f08a917bf724c92a372d',
    arms: ['p2-only', 'provider-failure', 'resource-exhaustion'],
  },
  {
    caseId: 'ws5-r2-c002', input: 'input-002.json',
    sha256: 'f1b5a2f7b838cacd039972da5de7cb066ca838882e31e840190850591ae5c37f',
    repositoryId: 73002, repository: 'synthetic/fixture-sequence', prNumber: 52,
    baseSha: 'b2beab2ab2c6369a0d6352a78af795d92246b7f3', headSha: 'e62ac7e8846d80864cacc65699268097caa31223',
    arms: ['repair-introduction'],
  },
  {
    caseId: 'ws5-r2-c003', input: 'input-003.json',
    sha256: '6fcfa7a254eb960ae3a2ef79358e06205e6812c748e353679ead1578b11a1e84',
    repositoryId: 73002, repository: 'synthetic/fixture-sequence', prNumber: 52,
    baseSha: 'e62ac7e8846d80864cacc65699268097caa31223', headSha: '81d910d8a133563e76e5a700ba65fb58b7dcdc72',
    arms: ['repair-head-history', 'repair-head-empty-history', 'repair-head-history-unavailable'],
  },
  {
    caseId: 'ws5-r2-c004', input: 'input-004.json',
    sha256: 'e3cfadf9e9937c66d4c8fdfd90d97668fc691a185bba6960cb8379b276b9cb97',
    repositoryId: 73003, repository: 'synthetic/fixture-large-crossfile', prNumber: 53,
    baseSha: 'a3e317cb730f8001039869c522d79f5793ccdc85', headSha: 'ebd7011b8170dd4b650ce924c335a6cd84fccbfe',
    arms: ['preflight-source-coverage-control'],
  },
] as const;

function requestEnv(caseId: string, arm: string, historyRunId?: string): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    REVIEW_NORMAL_ENGINE_QUALIFICATION_ONLY: 'true',
    REVIEW_NORMAL_ENGINE_QUALIFICATION_RUN_ID: 'nq_0123456789abcdef0123456789abcdef',
    REVIEW_NORMAL_ENGINE_QUALIFICATION_CASE_ID: caseId,
    REVIEW_NORMAL_ENGINE_QUALIFICATION_ARM: arm,
    REVIEW_NORMAL_ENGINE_QUALIFICATION_HISTORY_RUN_ID: historyRunId,
    REVIEW_PUBLICATION_MODE: 'disabled',
    REVIEW_RECEIPT_PATH: '/workspace/.review-yeti/normal-engine-qualification.json',
    REVIEW_POLICY_DIGEST: 'a'.repeat(64),
    REVIEW_CONFIG_DIGEST: 'b'.repeat(64),
    REVIEW_PREPARED_CONFIG_JSON: '{}',
    REVIEW_NORMAL_ENGINE_QUALIFICATION_SOURCE_REVISION: 'c'.repeat(40),
    REVIEW_NORMAL_ENGINE_QUALIFICATION_WORKER_IMAGE_DIGEST: `sha256:${'d'.repeat(64)}`,
    REVIEW_NORMAL_ENGINE_QUALIFICATION_RUNTIME_MANIFEST_SHA256: 'e'.repeat(64),
    REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_TARGET: 'synthetic/policy-target',
    REVIEW_NORMAL_ENGINE_QUALIFICATION_SELECTION_PURPOSE: 'qualification-only-target-binding',
    REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_REPOSITORY_ID: '73099',
    REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_OWNER: 'synthetic',
    REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_REPO: 'policy-target',
    REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_REF: 'f'.repeat(40),
    REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_PATH: 'policy/review-yeti.json',
    REVIEW_NORMAL_ENGINE_QUALIFICATION_POLICY_SOURCE_SHA256: '1'.repeat(64),
  };
}

describe('WS5 external normal v3 fixture boundary', () => {
  it('admits only the four exact, blinded source identities and their case-specific arms', () => {
    for (const fixture of cases) {
      const pin = qualificationFixturePin(fixture.caseId);
      expect(pin, fixture.caseId).toBeDefined();
      expect(pin).toMatchObject({
        caseId: fixture.caseId,
        path: `eval-baselines/competitive-review-benchmark/ws5-external-normal-v3/inputs/${fixture.input}`,
        sha256: fixture.sha256,
        schemaVersion: 'WS5RepairReviewInput.v1',
        bundleVersion: 'WS5ExternalNormalBundle.v3',
        bundleSha256: 'd83b08f04890604fd1bfe98105e6db7ad70945afb1e5471218ca62d2204cc3bc',
        repository: { repositoryId: fixture.repositoryId },
        prNumber: fixture.prNumber,
        baseSha: fixture.baseSha,
        headSha: fixture.headSha,
      });
      expect(`${pin!.repository.owner}/${pin!.repository.repo}`).toBe(fixture.repository);
      expect(() => validateQualificationFixtureInput(fixture.caseId)).not.toThrow();
      for (const arm of fixture.arms) expect(qualificationArmAllowedForFixture(fixture.caseId, arm)).toBe(true);
    }
  });

  it('rejects unknown identities and cross-case or cross-arm substitutions', () => {
    expect(qualificationFixturePin('ws5-r2-c001-tampered')).toBeUndefined();
    expect(qualificationArmAllowedForFixture('ws5-r2-c001', 'repair-introduction')).toBe(false);
    expect(qualificationArmAllowedForFixture('ws5-r2-c002', 'repair-head-history')).toBe(false);
    expect(qualificationArmAllowedForFixture('ws5-r2-c003', 'repair-introduction')).toBe(false);
    expect(qualificationArmAllowedForFixture('ws5-r2-c004', 'p2-only')).toBe(false);
  });

  it('rejects changed input identity or source scope bytes before loading a fixture', () => {
    const caseId = 'ws5-r2-c001';
    const pin = qualificationFixturePin(caseId)!;
    const fixturePath = resolve(process.cwd(), pin.path);
    const originalBytes = readFileSync(fixturePath);
    const originalInput = JSON.parse(originalBytes.toString('utf8')) as Record<string, any>;

    for (const tamper of [
      (input: Record<string, any>) => { input.caseId = 'ws5-r2-c002'; },
      (input: Record<string, any>) => { input.source.repository.repositoryId = 73002; },
    ]) {
      const alteredInput = structuredClone(originalInput);
      tamper(alteredInput);
      const alteredBytes = Buffer.from(`${JSON.stringify(alteredInput)}\n`);
      expect(createHash('sha256').update(alteredBytes).digest('hex')).not.toBe(pin.sha256);
      expect(() => validateQualificationFixtureInputBytes(caseId, alteredBytes))
        .toThrow('normal_engine_qualification_fixture_digest_mismatch');
    }
  });

  it('binds the sequence lineage to the new source and repair inputs', () => {
    const historyRunId = 'nq_abcdef0123456789abcdef0123456789';
    const source = parseNormalEngineQualificationRequest(requestEnv('ws5-r2-c002', 'repair-introduction'));
    const repair = parseNormalEngineQualificationRequest(requestEnv('ws5-r2-c003', 'repair-head-history', historyRunId));
    const expected = {
      sequenceId: 'ws5-r2-h001',
      sourceCaseId: 'ws5-r2-c002',
      repairCaseId: 'ws5-r2-c003',
      sourceInputSha256: 'f1b5a2f7b838cacd039972da5de7cb066ca838882e31e840190850591ae5c37f',
      repairInputSha256: '6fcfa7a254eb960ae3a2ef79358e06205e6812c748e353679ead1578b11a1e84',
      repairBaseSha: 'e62ac7e8846d80864cacc65699268097caa31223',
      repairHeadSha: '81d910d8a133563e76e5a700ba65fb58b7dcdc72',
    };
    expect(source.historyLineage).toEqual(expected);
    expect(repair.historyLineage).toEqual(expected);

    const tampered = requestEnv('ws5-r2-c003', 'repair-head-history', historyRunId);
    tampered.REVIEW_NORMAL_ENGINE_QUALIFICATION_HISTORY_SEQUENCE_ID = expected.sequenceId;
    tampered.REVIEW_NORMAL_ENGINE_QUALIFICATION_HISTORY_SOURCE_CASE_ID = expected.sourceCaseId;
    tampered.REVIEW_NORMAL_ENGINE_QUALIFICATION_HISTORY_REPAIR_CASE_ID = expected.repairCaseId;
    tampered.REVIEW_NORMAL_ENGINE_QUALIFICATION_HISTORY_SOURCE_INPUT_SHA256 = expected.sourceInputSha256;
    tampered.REVIEW_NORMAL_ENGINE_QUALIFICATION_HISTORY_REPAIR_INPUT_SHA256 = expected.repairInputSha256;
    tampered.REVIEW_NORMAL_ENGINE_QUALIFICATION_HISTORY_REPAIR_BASE_SHA = expected.repairBaseSha;
    tampered.REVIEW_NORMAL_ENGINE_QUALIFICATION_HISTORY_REPAIR_HEAD_SHA = '0'.repeat(40);
    expect(() => parseNormalEngineQualificationRequest(tampered))
      .toThrow('normal_engine_qualification_history_lineage_binding_invalid');
  });

  it('uses the R2 normal and bounded-control budget profiles by exact case and arm', () => {
    expect(normalEngineQualificationBudgetProfileForArm('p2-only', 'ws5-r2-c001'))
      .toBe('normal-canary-240s-capture-outside-child');
    expect(normalEngineQualificationBudgetProfileForArm('repair-introduction', 'ws5-r2-c002'))
      .toBe('normal-canary-240s-capture-outside-child');
    expect(normalEngineQualificationBudgetProfileForArm('repair-head-history', 'ws5-r2-c003'))
      .toBe('normal-canary-240s-capture-outside-child');
    expect(normalEngineQualificationBudgetProfileForArm('repair-head-empty-history', 'ws5-r2-c003'))
      .toBe('normal-canary-240s-capture-outside-child');
    expect(normalEngineQualificationBudgetProfileForArm('repair-head-history-unavailable', 'ws5-r2-c003'))
      .toBe('required-history-preflight-15s');
    expect(normalEngineQualificationBudgetProfileForArm('provider-failure', 'ws5-r2-c001'))
      .toBe('bifrost-auth-rejection-30s-one-request');
    expect(normalEngineQualificationBudgetProfileForArm('resource-exhaustion', 'ws5-r2-c001'))
      .toBe('resource-exhaustion-60s-one-request');
    expect(normalEngineQualificationBudgetProfileForArm('preflight-source-coverage-control', 'ws5-r2-c004'))
      .toBe('source-coverage-preflight-15s');
  });

  it('admits the four exact IDs through the qualification-only worker contract without changing the v2 cohort', () => {
    for (const fixture of cases) expect(NORMAL_ENGINE_QUALIFICATION_PLAN_CASE_IDS).toContain(fixture.caseId);
    for (const caseId of [
      'ws5-current-1dd-v2-p2',
      'ws5-current-1dd-v2-sequence-a',
      'ws5-current-1dd-v2-sequence-b',
      'ws5-current-1dd-v2-coverage-hole',
      'ws5-current-1dd-v2-provider-failure',
      'ws5-current-1dd-v2-resource-exhaustion',
    ]) expect(NORMAL_ENGINE_QUALIFICATION_PLAN_CASE_IDS).toContain(caseId);
  });
});
