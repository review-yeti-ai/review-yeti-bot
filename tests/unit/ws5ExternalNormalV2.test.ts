import { describe, expect, it } from 'vitest';
import {
  NORMAL_ENGINE_QUALIFICATION_PLAN_CASE_IDS,
  qualificationArmAllowedForFixture,
  qualificationFixturePin,
  validateQualificationFixtureInput,
} from '../../src/qualification/normalEngineQualification';

describe('WS5 external normal v2 fixture boundary', () => {
  it('pins only the new synthetic case identities and their exact source inputs', () => {
    const cases = [
      ['ws5-current-1dd-v2-p2', 'p2-only', 73004, 'synthetic/fixture-display-sort',
        '740ca081f3ec2399ea72a329fbe4b2e7eeb47cd7', 'e4edc4bd9f74fd9ec3e8f8f7d9a83bd821832497'],
      ['ws5-current-1dd-v2-sequence-a', 'repair-introduction', 73002, 'synthetic/fixture-sequence',
        '1fd9256afcf0250975c69410a766629c4d4225ad', '1035dc8db9a222447aa774fd9660c224e5d37655'],
      ['ws5-current-1dd-v2-sequence-b', 'repair-head-history', 73002, 'synthetic/fixture-sequence',
        '1035dc8db9a222447aa774fd9660c224e5d37655', '1b183caf5f8c518a3acda3fb2d8eea38133eed98'],
      ['ws5-current-1dd-v2-coverage-hole', 'no-model-preflight', 73003, 'synthetic/fixture-large-crossfile',
        'f83c7fbab1909ebc8e3b1a905c4d93a6ffdf8448', 'cef2d6d195ad1ec19ec6a745363a804fd679b369'],
      ['ws5-current-1dd-v2-provider-failure', 'provider-failure', 73004, 'synthetic/fixture-display-sort',
        '740ca081f3ec2399ea72a329fbe4b2e7eeb47cd7', 'e4edc4bd9f74fd9ec3e8f8f7d9a83bd821832497'],
      ['ws5-current-1dd-v2-resource-exhaustion', 'resource-exhaustion', 73004, 'synthetic/fixture-display-sort',
        '740ca081f3ec2399ea72a329fbe4b2e7eeb47cd7', 'e4edc4bd9f74fd9ec3e8f8f7d9a83bd821832497'],
    ] as const;

    for (const [caseId, arm, repositoryId, repository, baseSha, headSha] of cases) {
      const pin = qualificationFixturePin(caseId);
      expect(pin, caseId).toBeDefined();
      expect(pin).toMatchObject({ caseId, repository: { repositoryId }, prNumber: repositoryId === 73002 ? 41
        : repositoryId === 73003 ? 42 : 43, baseSha, headSha });
      expect(`${pin!.repository.owner}/${pin!.repository.repo}`).toBe(repository);
      expect(() => validateQualificationFixtureInput(caseId)).not.toThrow();
      expect(qualificationArmAllowedForFixture(caseId, arm === 'no-model-preflight'
        ? 'preflight-source-coverage-control' : arm)).toBe(true);
    }
  });

  it('admits the new source IDs through the qualification-only worker contract', () => {
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
