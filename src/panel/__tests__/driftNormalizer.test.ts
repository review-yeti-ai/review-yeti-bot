import { describe, it, expect } from 'vitest';
import { normalizeDriftedStructuredOutput } from '../panelEngine';

describe('normalizeDriftedStructuredOutput', () => {
  it('repairs case-only persona decision drift and finding scalars', () => {
    const value = {
      nonce: 'n1',
      decision: 'approve',
      findings: [
        { severity: 'p1', path: 'src/a.ts', line: '12', startLine: '3', title: 't', body: 'b' },
        { severity: 'P2', path: 'src/b.ts', line: 8, startLine: null, title: 't2', body: 'b2' },
      ],
    };
    expect(normalizeDriftedStructuredOutput('persona', value)).toBe(true);
    expect(value.decision).toBe('APPROVE');
    expect(value.findings[0].severity).toBe('P1');
    expect(value.findings[0].line).toBe(12);
    expect(value.findings[0].startLine).toBe(3);
    expect(value.findings[1].line).toBe(8);
    expect(value.findings[1].startLine).toBeNull();
  });

  it('repairs case-only moderator and arbiter enums', () => {
    const moderator = { nonce: 'n', decision: 'reconciled', findings: [] };
    expect(normalizeDriftedStructuredOutput('moderator', moderator)).toBe(true);
    expect(moderator.decision).toBe('RECONCILED');

    const arbiter = { nonce: 'n', verdict: 'fix_first', rationale: 'r' };
    expect(normalizeDriftedStructuredOutput('arbiter', arbiter)).toBe(true);
    expect(arbiter.verdict).toBe('FIX_FIRST');
  });

  it('never maps semantic synonyms — unknown enum values pass through untouched', () => {
    const value = { nonce: 'n', decision: 'pass', findings: [] };
    expect(normalizeDriftedStructuredOutput('persona', value)).toBe(false);
    expect(value.decision).toBe('pass');

    const reject = { nonce: 'n', decision: 'reject', findings: [] };
    expect(normalizeDriftedStructuredOutput('persona', reject)).toBe(false);
    expect(reject.decision).toBe('reject');
  });

  it('is a no-op for already-conformant output and reports no change', () => {
    const value = {
      nonce: 'n',
      decision: 'FINDINGS',
      findings: [{ severity: 'P0', path: 'a', line: 1, startLine: null, title: 't', body: 'b' }],
    };
    expect(normalizeDriftedStructuredOutput('persona', value)).toBe(false);
    expect(value.decision).toBe('FINDINGS');
    expect(value.findings[0].severity).toBe('P0');
  });

  it('ignores non-objects, non-integer strings, and malformed findings entries', () => {
    expect(normalizeDriftedStructuredOutput('persona', null)).toBe(false);
    expect(normalizeDriftedStructuredOutput('persona', 'APPROVE')).toBe(false);
    expect(normalizeDriftedStructuredOutput('persona', ['x'])).toBe(false);

    const value: Record<string, unknown> = {
      nonce: 'n',
      decision: 'APPROVE',
      findings: [
        null,
        'not-an-object',
        { severity: 'urgent', line: 'twelve', path: 'a', title: 't', body: 'b' },
      ],
    };
    expect(normalizeDriftedStructuredOutput('persona', value)).toBe(false);
    const malformed = (value.findings as unknown[])[2] as { severity: string; line: string };
    expect(malformed.severity).toBe('urgent');
    expect(malformed.line).toBe('twelve');
  });
});
