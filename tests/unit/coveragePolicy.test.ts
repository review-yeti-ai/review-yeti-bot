import { describe, expect, it } from 'vitest';
import {
  classifyLane,
  evaluateCoverage,
  normalizeCoveragePolicy,
  requiredCoverageCount,
} from '../../src/review/coveragePolicy';

const verdictLane = (id: string, provider: string, extra: Record<string, unknown> = {}) => ({
  id,
  provider,
  model: 'review-model',
  decision: 'APPROVE',
  findings: [],
  ...extra,
});

describe('coverage policy quorum math', () => {
  it('uses ceil two-thirds and strict simple-majority boundaries', () => {
    expect(requiredCoverageCount(1, 'two_thirds')).toBe(1);
    expect(requiredCoverageCount(2, 'two_thirds')).toBe(2);
    expect(requiredCoverageCount(3, 'two_thirds')).toBe(2);
    expect(requiredCoverageCount(4, 'two_thirds')).toBe(3);
    expect(requiredCoverageCount(4, 'simple_majority')).toBe(3);
    expect(requiredCoverageCount(5, 'simple_majority')).toBe(3);
    expect(requiredCoverageCount(4, 'unanimous')).toBe(4);
  });

  it('normalizes safe defaults and rejects invalid policy values', () => {
    expect(normalizeCoveragePolicy()).toEqual({
      quorum: 'two_thirds',
      min_personas: 3,
      mandatory_personas: ['security'],
      provider_diversity_min: 2,
    });
    expect(normalizeCoveragePolicy({
      quorum: 'simple_majority',
      min_personas: 4,
      mandatory_personas: ['security', 'contract'],
      provider_diversity_min: 3,
    })).toEqual({
      quorum: 'simple_majority',
      min_personas: 4,
      mandatory_personas: ['security', 'contract'],
      provider_diversity_min: 3,
    });
    expect(() => normalizeCoveragePolicy({ quorum: 'one_lane' as never })).toThrow(/quorum/);
    expect(() => normalizeCoveragePolicy({ min_personas: 0 })).toThrow(/min_personas/);
    expect(() => normalizeCoveragePolicy({ mandatory_personas: ['security', 'security'] })).toThrow(/mandatory/);
    expect(() => normalizeCoveragePolicy({ provider_diversity_min: 0 })).toThrow(/provider/);
  });
});

describe('coverage lane classification', () => {
  it('counts only complete structured verdict lanes as trustworthy', () => {
    expect(classifyLane(verdictLane('security', 'provider-a'))).toMatchObject({
      id: 'security',
      status: 'verdict',
      trustworthy: true,
    });
    expect(classifyLane(verdictLane('security', 'provider-a', { decision: 'ERROR', error: 'provider crashed' }))).toMatchObject({
      status: 'error',
      trustworthy: false,
    });
    expect(classifyLane(verdictLane('security', 'provider-a', { status: 'TIMEOUT' }))).toMatchObject({
      status: 'timeout',
      trustworthy: false,
    });
    expect(classifyLane(verdictLane('security', 'provider-a', { partial: 1 }))).toMatchObject({
      status: 'partial',
      trustworthy: false,
    });
    expect(classifyLane(verdictLane('security', 'provider-a', { findings: undefined }))).toMatchObject({
      status: 'empty',
      trustworthy: false,
    });
    expect(classifyLane(verdictLane('security', '', { model: '' }))).toMatchObject({
      status: 'invalid',
      trustworthy: false,
    });
  });
});

describe('coverage evaluation', () => {
  it('publishes a partial result against the configured denominator', () => {
    const result = evaluateCoverage({
      expectedPersonaIds: ['security', 'testing', 'contract'],
      lanes: [
        verdictLane('security', 'provider-a'),
        verdictLane('testing', 'provider-b', { decision: 'FINDINGS' }),
      ],
      policy: { mandatory_personas: [], provider_diversity_min: 2 },
    });

    expect(result).toMatchObject({
      status: 'partial',
      required: 2,
      expectedCount: 3,
      trustworthyCount: 2,
      mergeEligible: false,
      mandatorySatisfied: true,
      providerDiversitySatisfied: true,
    });
    expect(result.missingPersonaIds).toEqual(['contract']);
  });

  it('does not shrink the denominator to the lanes that launched', () => {
    const result = evaluateCoverage({
      expectedPersonaIds: ['security', 'testing', 'contract'],
      lanes: [verdictLane('security', 'provider-a')],
      policy: { mandatory_personas: [], provider_diversity_min: 1 },
    });

    expect(result.status).toBe('incomplete');
    expect(result.required).toBe(2);
    expect(result.expectedCount).toBe(3);
  });

  it('requires mandatory personas even when numeric quorum is met', () => {
    const result = evaluateCoverage({
      expectedPersonaIds: ['security', 'testing', 'contract'],
      lanes: [
        verdictLane('testing', 'provider-a'),
        verdictLane('contract', 'provider-b'),
      ],
      policy: { mandatory_personas: ['security'], provider_diversity_min: 2 },
    });

    expect(result.status).toBe('incomplete');
    expect(result.mandatorySatisfied).toBe(false);
    expect(result.missingMandatoryPersonaIds).toEqual(['security']);
  });

  it('requires provider diversity for partial publication', () => {
    const result = evaluateCoverage({
      expectedPersonaIds: ['security', 'testing', 'contract'],
      lanes: [
        verdictLane('security', 'provider-a'),
        verdictLane('testing', 'provider-a'),
      ],
      policy: { mandatory_personas: [], provider_diversity_min: 2 },
    });

    expect(result.status).toBe('incomplete');
    expect(result.providerDiversitySatisfied).toBe(false);
    expect(result.distinctProviders).toEqual(['provider-a']);
  });

  it('requires the configured minimum roster for partial publication', () => {
    const result = evaluateCoverage({
      expectedPersonaIds: ['security', 'testing'],
      lanes: [verdictLane('security', 'provider-a')],
      policy: { min_personas: 3, mandatory_personas: ['security'], provider_diversity_min: 1 },
    });

    expect(result).toMatchObject({ status: 'incomplete', minimumRosterSatisfied: false });
  });

  it('rejects empty, duplicate, and unexpected persona IDs', () => {
    expect(() => evaluateCoverage({ expectedPersonaIds: [], lanes: [], policy: {} })).toThrow(/at least one/);
    expect(() => evaluateCoverage({
      expectedPersonaIds: ['security', 'testing', 'contract'],
      lanes: [verdictLane('security', 'provider-a'), verdictLane('security', 'provider-b')],
      policy: {},
    })).toThrow(/duplicate/);
    expect(() => evaluateCoverage({
      expectedPersonaIds: ['security', 'testing', 'contract'],
      lanes: [verdictLane('unknown', 'provider-a')],
      policy: {},
    })).toThrow(/unexpected/);
  });
});
