import { describe, expect, it, vi } from 'vitest';
import { ReviewCompletionDeliveryEngine } from '../../src/k8s/reviewCompletionDeliveryEngine';
import { ReviewCompletionClaim } from '../../src/persistence/reviewCompletionRepository';

describe('ReviewCompletionDeliveryEngine', () => {
  const baseClaim: ReviewCompletionClaim = {
    completionId: 'cpl_test',
    runId: 'run_test',
    repositoryId: 12345,
    repository: 'calltelemetry/dashboard',
    prNumber: 42,
    baseSha: '0'.repeat(40),
    headSha: '1'.repeat(40),
    attemptId: 'att-1',
    policyDigest: `sha256:${'a'.repeat(64)}`,
    validationRequestId: 'val-42-1',
    verdict: 'SHIP',
    conclusion: 'success',
    attempt: 1,
    leaseOwner: 'worker-1',
    leaseExpiresAt: Date.now() + 30000,
  };

  it('emits CI request when verdict is SHIP / conclusion is success', async () => {
    let emitted = false;
    let markedDispatched = false;

    const repo = {
      claimNext: vi.fn(async () => ({ ...baseClaim, verdict: 'SHIP', conclusion: 'success' })),
      markDispatched: vi.fn(async () => {
        markedDispatched = true;
        return true;
      }),
      releaseForRetry: vi.fn(async () => true),
      markError: vi.fn(async () => true),
    };

    const engine = new ReviewCompletionDeliveryEngine({
      repository: repo,
      clientFactory: async () => ({
        emitCIRequest: async () => {
          emitted = true;
        },
      }),
      workerId: 'w1',
    });

    const outcome = await engine.runOnce();
    expect(emitted).toBe(true);
    expect(markedDispatched).toBe(true);
    expect(outcome.status).toBe('dispatched');
  });

  it('emits CI request when verdict is PASS', async () => {
    let emitted = false;

    const repo = {
      claimNext: vi.fn(async () => ({ ...baseClaim, verdict: 'PASS', conclusion: 'neutral' })),
      markDispatched: vi.fn(async () => true),
      releaseForRetry: vi.fn(async () => true),
      markError: vi.fn(async () => true),
    };

    const engine = new ReviewCompletionDeliveryEngine({
      repository: repo,
      clientFactory: async () => ({
        emitCIRequest: async () => {
          emitted = true;
        },
      }),
      workerId: 'w1',
    });

    const outcome = await engine.runOnce();
    expect(emitted).toBe(true);
    expect(outcome.status).toBe('dispatched');
  });

  it('does NOT emit CI request when verdict is BLOCK', async () => {
    let emitted = false;
    let markedTerminal = false;

    const repo = {
      claimNext: vi.fn(async () => ({ ...baseClaim, verdict: 'BLOCK', conclusion: 'failure' })),
      markTerminal: vi.fn(async () => {
        markedTerminal = true;
        return true;
      }),
      markDispatched: vi.fn(async () => true),
      releaseForRetry: vi.fn(async () => true),
      markError: vi.fn(async () => true),
    };

    const engine = new ReviewCompletionDeliveryEngine({
      repository: repo,
      clientFactory: async () => ({
        emitCIRequest: async () => {
          emitted = true;
        },
      }),
      workerId: 'w1',
    });

    const outcome = await engine.runOnce();
    expect(emitted).toBe(false);
    expect(markedTerminal).toBe(true);
    expect(outcome.status).toBe('terminal');
  });

  it('does NOT emit CI request when verdict is FIX_FIRST', async () => {
    let emitted = false;
    let markedTerminal = false;

    const repo = {
      claimNext: vi.fn(async () => ({ ...baseClaim, verdict: 'FIX_FIRST', conclusion: 'failure' })),
      markTerminal: vi.fn(async () => {
        markedTerminal = true;
        return true;
      }),
      markDispatched: vi.fn(async () => true),
      releaseForRetry: vi.fn(async () => true),
      markError: vi.fn(async () => true),
    };

    const engine = new ReviewCompletionDeliveryEngine({
      repository: repo,
      clientFactory: async () => ({
        emitCIRequest: async () => {
          emitted = true;
        },
      }),
      workerId: 'w1',
    });

    const outcome = await engine.runOnce();
    expect(emitted).toBe(false);
    expect(markedTerminal).toBe(true);
    expect(outcome.status).toBe('terminal');
  });

  it('does NOT emit CI request when conclusion is failure even if verdict is missing', async () => {
    let emitted = false;

    const repo = {
      claimNext: vi.fn(async () => ({ ...baseClaim, verdict: undefined, conclusion: 'failure' })),
      markCompleted: vi.fn(async () => true),
      markDispatched: vi.fn(async () => true),
      releaseForRetry: vi.fn(async () => true),
      markError: vi.fn(async () => true),
    };

    const engine = new ReviewCompletionDeliveryEngine({
      repository: repo,
      clientFactory: async () => ({
        emitCIRequest: async () => {
          emitted = true;
        },
      }),
      workerId: 'w1',
    });

    const outcome = await engine.runOnce();
    expect(emitted).toBe(false);
    expect(outcome.status).toBe('terminal');
  });

  it('falls back to markDispatched when neither markTerminal nor markCompleted is available on non-SHIP', async () => {
    let emitted = false;
    let markedDispatched = false;

    const repo = {
      claimNext: vi.fn(async () => ({ ...baseClaim, verdict: 'BLOCK', conclusion: 'failure' })),
      markDispatched: vi.fn(async () => {
        markedDispatched = true;
        return true;
      }),
      releaseForRetry: vi.fn(async () => true),
      markError: vi.fn(async () => true),
    };

    const engine = new ReviewCompletionDeliveryEngine({
      repository: repo,
      clientFactory: async () => ({
        emitCIRequest: async () => {
          emitted = true;
        },
      }),
      workerId: 'w1',
    });

    const outcome = await engine.runOnce();
    expect(emitted).toBe(false);
    expect(markedDispatched).toBe(true);
    expect(outcome.status).toBe('terminal');
  });
});
