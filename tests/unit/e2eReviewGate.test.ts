// API-2902: deterministic unit coverage for the E2E review gate's pass/fail classification
// (src/review/e2eReviewGate.js). The live model call itself (scripts/e2e-review-gate.mjs) is
// intentionally NOT part of this deterministic suite -- same precedent as
// scripts/review-intelligence-live-smoke.mjs and scripts/evaluate-dependency-investigation-live.mjs,
// neither of which has offline coverage either, per CONTRIBUTING.md/TEST_INFRA.md's boundary
// ("Live provider credentials are never required for any lane in test:all"). What IS safe and
// valuable to pin down offline is the red/green pass-fail rule itself, so a future edit cannot
// silently make the gate meaningless (e.g. treating an ERRORed lane as "0 findings, fine").
import { describe, expect, it } from 'vitest';
import {
  summarizeFixtureResult, redFixtureOk, greenFixtureOk, evaluateGate, resolveGateTransportBudget,
} from '../../src/review/e2eReviewGate';

describe('e2e review gate classification (API-2902)', () => {
  it('allows a max-reasoning stream to complete while retaining a short TTFT floor', () => {
    expect(resolveGateTransportBudget({})).toEqual({ timeoutMs: 90_000, ttftMs: 30_000 });
  });

  it('bounds explicit gate budgets and never lets TTFT exceed the completion budget', () => {
    expect(resolveGateTransportBudget({
      E2E_REVIEW_GATE_TIMEOUT_MS: '45000',
      E2E_REVIEW_GATE_TTFT_MS: '60000',
    })).toEqual({ timeoutMs: 45_000, ttftMs: 45_000 });
  });

  it('clamps gate budgets at their exact lower and upper boundaries', () => {
    expect(resolveGateTransportBudget({
      E2E_REVIEW_GATE_TIMEOUT_MS: '1',
      E2E_REVIEW_GATE_TTFT_MS: '1',
    })).toEqual({ timeoutMs: 500, ttftMs: 500 });

    expect(resolveGateTransportBudget({
      E2E_REVIEW_GATE_TIMEOUT_MS: '999999',
      E2E_REVIEW_GATE_TTFT_MS: '999999',
    })).toEqual({ timeoutMs: 600_000, ttftMs: 600_000 });
  });

  it('uses defaults for empty or invalid optional environment values', () => {
    expect(resolveGateTransportBudget({
      E2E_REVIEW_GATE_TIMEOUT_MS: '  ',
      E2E_REVIEW_GATE_TTFT_MS: 'invalid',
    })).toEqual({ timeoutMs: 90_000, ttftMs: 30_000 });
    expect(resolveGateTransportBudget(null as any)).toEqual({ timeoutMs: 90_000, ttftMs: 30_000 });
  });

  it('supports a bounded short budget for explicit local canaries', () => {
    expect(resolveGateTransportBudget({
      E2E_REVIEW_GATE_TIMEOUT_MS: '15000',
      E2E_REVIEW_GATE_TTFT_MS: '5000',
    })).toEqual({ timeoutMs: 15_000, ttftMs: 5_000 });
  });

  it('summarizes a completed lane with findings', () => {
    const summary = summarizeFixtureResult({
      decision: 'FINDINGS', findings: [{ severity: 'P0' }], provider: 'openrouter', model: 'm',
    }, 'red-known-bug');
    expect(summary).toMatchObject({
      name: 'red-known-bug', completed: true, findingCount: 1, decision: 'FINDINGS',
    });
    expect(summary.error).toBeUndefined();
  });

  it('summarizes an ERROR lane as not completed, carrying the error reason', () => {
    const summary = summarizeFixtureResult({ decision: 'ERROR', error: 'timeout', findings: [] }, 'green-clean');
    expect(summary).toMatchObject({ name: 'green-clean', completed: false, findingCount: 0, error: 'timeout' });
  });

  it('red fixture passes only with >=1 finding on a completed lane', () => {
    expect(redFixtureOk({ completed: true, findingCount: 1 })).toBe(true);
    expect(redFixtureOk({ completed: true, findingCount: 3 })).toBe(true);
    expect(redFixtureOk({ completed: true, findingCount: 0 })).toBe(false);
    // An ERRORed lane must never pass, even if it happens to carry findings from a partial pass.
    expect(redFixtureOk({ completed: false, findingCount: 1 })).toBe(false);
  });

  it('green fixture passes only with exactly 0 findings on a completed lane', () => {
    expect(greenFixtureOk({ completed: true, findingCount: 0 })).toBe(true);
    expect(greenFixtureOk({ completed: true, findingCount: 1 })).toBe(false);
    // An ERRORed lane must never pass as "0 findings, fine" -- that would let a provider outage
    // masquerade as a clean gate.
    expect(greenFixtureOk({ completed: false, findingCount: 0 })).toBe(false);
  });

  it('evaluateGate passes only when both fixtures individually pass', () => {
    const pass = evaluateGate({
      red: { completed: true, findingCount: 1 },
      green: { completed: true, findingCount: 0 },
    });
    expect(pass.status).toBe('pass');
    expect(pass.red.ok).toBe(true);
    expect(pass.green.ok).toBe(true);
  });

  it('evaluateGate fails when the red fixture found nothing (a real regression: the panel missed a planted P0)', () => {
    const result = evaluateGate({
      red: { completed: true, findingCount: 0 },
      green: { completed: true, findingCount: 0 },
    });
    expect(result.status).toBe('fail');
    expect(result.red.ok).toBe(false);
    expect(result.green.ok).toBe(true);
  });

  it('evaluateGate fails when the green fixture raised a false positive', () => {
    const result = evaluateGate({
      red: { completed: true, findingCount: 1 },
      green: { completed: true, findingCount: 1 },
    });
    expect(result.status).toBe('fail');
    expect(result.green.ok).toBe(false);
  });

  it('evaluateGate fails closed when either lane errored, even if the finding counts would otherwise look right', () => {
    const result = evaluateGate({
      red: { completed: false, findingCount: 1, error: 'ttft_timeout' },
      green: { completed: true, findingCount: 0 },
    });
    expect(result.status).toBe('fail');
    expect(result.red.ok).toBe(false);
  });
});
