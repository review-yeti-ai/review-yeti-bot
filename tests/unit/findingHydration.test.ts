import { describe, it, expect } from 'vitest';
import {
  hydrateLeanFindingToCheckAnnotation,
  hydrateFindingToCheckAnnotation,
  type CheckAnnotation,
} from '../../src/cli/publishingReview';
import {
  hydrateLeanFindingToCheckAnnotation as gateHydrateLean,
  hydrateFindingToCheckAnnotation as gateHydrateFinding,
} from '../../src/review/reviewGatePublisher';
import type { LeanFindingSummary } from '../../src/reviewTaskContract';
import type { FindingRemediation } from '../../src/review/remediationSubagent';

describe('Finding Hydration — Check-Run Annotation Line Anchoring & Formatting', () => {
  const sampleFinding: LeanFindingSummary = {
    severity: 'P0',
    file: 'src/auth/jwt.ts',
    line: 42,
    fingerprint: 'abcdef1234567890',
    summary: 'Missing HMAC verification on webhook.',
  };

  it('hydrates lean digest into GitHub CheckAnnotation with identical start_line and end_line', () => {
    const ann = hydrateLeanFindingToCheckAnnotation(sampleFinding);
    expect(ann).not.toBeNull();
    expect(ann?.path).toBe('src/auth/jwt.ts');
    expect(ann?.start_line).toBe(42);
    expect(ann?.end_line).toBe(42);
  });

  it('maps P0 and P1 required findings to annotation_level: failure', () => {
    const ann0 = hydrateLeanFindingToCheckAnnotation({ ...sampleFinding, severity: 'P0' });
    const ann1 = hydrateLeanFindingToCheckAnnotation({ ...sampleFinding, severity: 'P1' });
    expect(ann0?.annotation_level).toBe('failure');
    expect(ann1?.annotation_level).toBe('failure');
  });

  it('maps P2 advisory findings to annotation_level: notice', () => {
    const ann2 = hydrateLeanFindingToCheckAnnotation({ ...sampleFinding, severity: 'P2' });
    expect(ann2?.annotation_level).toBe('notice');
  });

  it('formats annotation title with severity prefix capped within 120 chars', () => {
    const ann = hydrateLeanFindingToCheckAnnotation(sampleFinding);
    expect(ann?.title).toBe('P0: Missing HMAC verification on webhook.');
    expect(ann!.title!.length).toBeLessThanOrEqual(120);

    const longSummaryFinding: LeanFindingSummary = {
      ...sampleFinding,
      summary: 'Very long defect description '.repeat(20),
    };
    const annLong = hydrateLeanFindingToCheckAnnotation(longSummaryFinding);
    expect(annLong!.title!.length).toBeLessThanOrEqual(120);
    expect(annLong!.title!.startsWith('P0: ')).toBe(true);
  });

  it('embeds finding summary and remediation detail in message body capped within 4000 chars', () => {
    const remediation: FindingRemediation = {
      fingerprint: sampleFinding.fingerprint,
      explanation: 'Signature verification must be performed using timing-safe equal comparison.',
      codeReplacement: {
        startLine: 42,
        endLine: 42,
        originalSnippet: 'verifySignature(req);',
        suggestedSnippet: 'crypto.timingSafeEqual(expected, actual);',
      },
      fixOptions: ['Use crypto.timingSafeEqual', 'Reject mismatched lengths early'],
    };

    const ann = hydrateLeanFindingToCheckAnnotation(sampleFinding, remediation);
    expect(ann?.message).toContain('Missing HMAC verification on webhook.');
    expect(ann?.message).toContain('Remediation:');
    expect(ann?.message).toContain('timing-safe');
    expect(ann?.message).toContain('Suggested fix:');
    expect(ann?.message).toContain('crypto.timingSafeEqual');
    expect(ann?.message.length).toBeLessThanOrEqual(4000);
  });

  it('clamps extremely large message bodies to at most 4000 characters', () => {
    const hugeRemediation: FindingRemediation = {
      fingerprint: sampleFinding.fingerprint,
      explanation: 'A'.repeat(5000),
      codeReplacement: {
        startLine: 42,
        endLine: 42,
        originalSnippet: 'B'.repeat(1000),
        suggestedSnippet: 'C'.repeat(1000),
      },
    };

    const ann = hydrateLeanFindingToCheckAnnotation(sampleFinding, hugeRemediation);
    expect(ann?.message.length).toBeLessThanOrEqual(4000);
  });

  it('filters out findings referencing files outside changedFiles when provided', () => {
    const changedFiles = ['src/auth/jwt.ts', 'src/api/routes.ts'];
    const inside = hydrateLeanFindingToCheckAnnotation(sampleFinding, undefined, changedFiles);
    expect(inside).not.toBeNull();

    const outsideFinding: LeanFindingSummary = {
      ...sampleFinding,
      file: 'src/other/unrelated.ts',
    };
    const outside = hydrateLeanFindingToCheckAnnotation(outsideFinding, undefined, changedFiles);
    expect(outside).toBeNull();
  });

  it('normalizes line number 0 or invalid to line 1 to avoid GitHub 422 errors', () => {
    const lineZeroFinding: LeanFindingSummary = {
      ...sampleFinding,
      line: 0,
    };
    const ann = hydrateLeanFindingToCheckAnnotation(lineZeroFinding);
    expect(ann?.start_line).toBe(1);
    expect(ann?.end_line).toBe(1);
  });

  it('ensures aliases hydrateFindingToCheckAnnotation and reviewGatePublisher exports work identically', () => {
    const ann1 = hydrateFindingToCheckAnnotation(sampleFinding);
    const ann2 = gateHydrateLean(sampleFinding);
    const ann3 = gateHydrateFinding(sampleFinding);
    expect(ann1).toEqual(ann2);
    expect(ann1).toEqual(ann3);
  });
});
