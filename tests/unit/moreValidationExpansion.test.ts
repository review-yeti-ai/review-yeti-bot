import { describe, it, expect } from 'vitest';
import { ctReviewConfigV3Schema } from '../../src/config/schema';

describe('schema.ts — Comprehensive Validation Expansion Tests', () => {
  const baseValidV3Config = {
    version: 3,
    profile: 'balanced' as const,
    quorum: 1,
    personas: [
      {
        id: 'sec-lane',
        enabled: true,
        required: true,
        charter: 'builtin:security',
        paths: ['**'],
        providers: ['claude' as const],
      },
    ],
    reviewers: {
      execution: 'personas' as const,
      fallback: 'ordered' as const,
      overall_timeout_s: 60,
      providers: [
        {
          id: 'claude' as const,
          enabled: true,
          model: 'claude-5-sonnet',
          effort: 'high' as const,
          review_timeout_s: 30,
          arbiter_timeout_s: 30,
        },
      ],
      arbiter: { order: ['claude' as const] },
    },
  };

  it('validates reviewer_effort levels (low, medium, high, xhigh, max)', () => {
    const efforts = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
    for (const effort of efforts) {
      const parsed = ctReviewConfigV3Schema.safeParse({ ...baseValidV3Config, reviewer_effort: effort });
      expect(parsed.success).toBe(true);
    }
  });

  it('validates confidence_threshold range between 0 and 100', () => {
    expect(ctReviewConfigV3Schema.safeParse({ ...baseValidV3Config, confidence_threshold: 0 }).success).toBe(true);
    expect(ctReviewConfigV3Schema.safeParse({ ...baseValidV3Config, confidence_threshold: 100 }).success).toBe(true);
    expect(ctReviewConfigV3Schema.safeParse({ ...baseValidV3Config, confidence_threshold: -1 }).success).toBe(false);
    expect(ctReviewConfigV3Schema.safeParse({ ...baseValidV3Config, confidence_threshold: 101 }).success).toBe(false);
  });

  it('validates mascot display options boolean values', () => {
    const res = ctReviewConfigV3Schema.safeParse({
      ...baseValidV3Config,
      mascot: false,
      display: { mascot: false },
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.mascot).toBe(false);
      expect(res.data.display.mascot).toBe(false);
    }
  });

  it('rejects rules with invalid severity string', () => {
    const res = ctReviewConfigV3Schema.safeParse({
      ...baseValidV3Config,
      rules: [{ id: 'r1', rule: 'Must check auth', severity: 'INVALID' }],
    });
    expect(res.success).toBe(false);
  });

  it('validates path instructions structure', () => {
    const res = ctReviewConfigV3Schema.safeParse({
      ...baseValidV3Config,
      path_instructions: [
        { path: 'src/auth/**', instructions: 'Enforce MFA checks' },
      ],
    });
    expect(res.success).toBe(true);
  });

  it('rejects empty personas array', () => {
    const res = ctReviewConfigV3Schema.safeParse({
      ...baseValidV3Config,
      personas: [],
    });
    expect(res.success).toBe(false);
  });

  it('rejects empty reviewers.providers array', () => {
    const res = ctReviewConfigV3Schema.safeParse({
      ...baseValidV3Config,
      reviewers: {
        ...baseValidV3Config.reviewers,
        providers: [],
      },
    });
    expect(res.success).toBe(false);
  });

  it('rejects empty reviewers.arbiter.order array', () => {
    const res = ctReviewConfigV3Schema.safeParse({
      ...baseValidV3Config,
      reviewers: {
        ...baseValidV3Config.reviewers,
        arbiter: { order: [] },
      },
    });
    expect(res.success).toBe(false);
  });

  it('enforces overall_timeout_s as a positive integer', () => {
    expect(
      ctReviewConfigV3Schema.safeParse({
        ...baseValidV3Config,
        reviewers: { ...baseValidV3Config.reviewers, overall_timeout_s: 0 },
      }).success
    ).toBe(false);

    expect(
      ctReviewConfigV3Schema.safeParse({
        ...baseValidV3Config,
        reviewers: { ...baseValidV3Config.reviewers, overall_timeout_s: -10 },
      }).success
    ).toBe(false);
  });

  it('transforms string version "3" into numeric 3', () => {
    const res = ctReviewConfigV3Schema.safeParse({
      ...baseValidV3Config,
      version: '3',
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.version).toBe(3);
    }
  });
});
