import { describe, expect, it } from 'vitest';
import { evaluatePromotionGate } from '../../scripts/testing-charter-promotion-gate.mjs';

function arm(overrides = {}) {
  return {
    arm: 'candidate',
    detectionRate: 0.8,
    detectionRate95: [0.6, 0.9],
    falsePositiveRate: 0.05,
    outputContractBreaches: 0,
    ...overrides,
  };
}

describe('testing-charter promotion gate', () => {
  it('passes a candidate-only report with a clean false-positive rate', () => {
    const receipt = evaluatePromotionGate({ arms: [arm()] });
    expect(receipt.status).toBe('pass');
    expect(receipt.reasons).toEqual([]);
  });

  it('fails on any output-contract breach regardless of detection/FP numbers', () => {
    const receipt = evaluatePromotionGate({ arms: [arm({ outputContractBreaches: 2, falsePositiveRate: 0 })] });
    expect(receipt.status).toBe('fail');
    expect(receipt.reasons.join(' ')).toContain('outputContractBreaches');
  });

  it('fails when the candidate false-positive rate exceeds the absolute ceiling', () => {
    const receipt = evaluatePromotionGate({ arms: [arm({ falsePositiveRate: 0.25 })] });
    expect(receipt.status).toBe('fail');
    expect(receipt.reasons.join(' ')).toContain('falsePositiveRate');
  });

  it('fails when a candidate raises detection by getting chattier than its own baseline', () => {
    const report = {
      arms: [
        { arm: 'baseline', detectionRate: 0.4, falsePositiveRate: 0.0, outputContractBreaches: 0 },
        arm({ detectionRate: 0.9, falsePositiveRate: 0.4 }),
      ],
    };
    const receipt = evaluatePromotionGate(report);
    expect(receipt.status).toBe('fail');
    expect(receipt.reasons.join(' ')).toMatch(/falsePositiveRate.*worse than baseline/);
  });

  it('fails when candidate detection regresses below baseline even with zero false positives', () => {
    const report = {
      arms: [
        { arm: 'baseline', detectionRate: 0.8, falsePositiveRate: 0.1, outputContractBreaches: 0 },
        arm({ detectionRate: 0.2, falsePositiveRate: 0 }),
      ],
    };
    const receipt = evaluatePromotionGate(report);
    expect(receipt.status).toBe('fail');
    expect(receipt.reasons.join(' ')).toContain('detectionRate=0.2 regresses');
  });

  it('passes when candidate improves both detection and false-positive rate over baseline', () => {
    const report = {
      arms: [
        { arm: 'baseline', detectionRate: 0.4, falsePositiveRate: 0.1, outputContractBreaches: 0 },
        arm({ detectionRate: 0.7, falsePositiveRate: 0.05 }),
      ],
    };
    const receipt = evaluatePromotionGate(report);
    expect(receipt.status).toBe('pass');
  });

  it('respects custom thresholds passed by the caller', () => {
    const receipt = evaluatePromotionGate({ arms: [arm({ falsePositiveRate: 0.15 })] }, { maxFalsePositiveRate: 0.20 });
    expect(receipt.status).toBe('pass');
  });

  it('fails closed when the report has no candidate arm', () => {
    const receipt = evaluatePromotionGate({ arms: [] });
    expect(receipt.status).toBe('fail');
    expect(receipt.reasons).toContain('no candidate arm in report');
  });
});
