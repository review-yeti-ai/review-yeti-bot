import { describe, expect, it, vi } from 'vitest';
import { PostgresReviewGateRepository } from '../../src/persistence/reviewGateRepository';

/**
 * The published gate summary names its terminal cause using three fields that
 * only exist after `fromRow` parses the `decision` and `evidence` JSONB
 * columns. Publisher-level tests build StoredReviewGate fixtures directly, so
 * they never execute that mapping: a regression there (a renamed key, a guard
 * that rejects valid counts, a double-encoded column) would leave all of them
 * green while the check silently reverted to the generic summary — which is
 * exactly the REL-1019 symptom. These tests drive the real read path instead.
 */

const ATTEMPT_ID = 'attempt-1';
const RUN_ID = `run_${'a'.repeat(32)}`;

/** A row shaped the way `claimPublication`'s RETURNING gate.* produces it. */
function claimRow(overrides: Record<string, unknown> = {}) {
  return {
    attempt_id: ATTEMPT_ID,
    run_id: RUN_ID,
    coordinates: JSON.stringify({
      runId: RUN_ID, repositoryId: 1, owner: 'calltelemetry', repo: 'example', prNumber: 42,
      headSha: 'b'.repeat(40), baseSha: 'c'.repeat(40), policyDigest: 'd'.repeat(64),
      configDigest: 'e'.repeat(64), executionAttempt: 1, attemptId: ATTEMPT_ID,
    }),
    review_generation: 2,
    expected_app_id: 4385771,
    external_id: 'gate_ext_1',
    check_id: 1234,
    creation_state: 'bound',
    desired_state: 'failure',
    desired_version: 2,
    published_version: 1,
    current_attempt: true,
    may_create: false,
    lease_token: '11111111-1111-1111-1111-111111111111',
    // The two columns under test. Real drivers hand these back as JSON text.
    decision: null as unknown,
    evidence: null as unknown,
    ...overrides,
  };
}

/** Drives claimPublication with a row and returns the parsed gate, or null. */
async function claimWith(row: Record<string, unknown> | undefined) {
  const client = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('appendLifecycle') || sql.includes('review_lifecycle')) return { rows: [] };
      return { rows: row ? [row] : [] };
    }),
    release: vi.fn(),
  };
  const repository = new PostgresReviewGateRepository(
    { connect: async () => client, query: vi.fn(async () => ({ rows: [] })) } as never,
    { lifecycleEvents: 'disabled' },
  );
  return repository.claimPublication('test-worker', Date.parse('2026-09-22T12:00:00.000Z'));
}

describe('gate decision/evidence row mapping', () => {
  it('parses the terminal decision reason and lane counts from JSON strings', async () => {
    const gate = await claimWith(claimRow({
      decision: JSON.stringify({ status: 'failure', eligible: false, reason: 'incomplete-review' }),
      evidence: JSON.stringify({ expectedLanes: 3, completedLanes: 2 }),
    }));

    expect(gate).toMatchObject({
      decisionReason: 'incomplete-review',
      expectedLanes: 3,
      completedLanes: 2,
    });
  });

  it('parses objects already decoded by the driver, not only JSON strings', async () => {
    // node-pg returns JSONB as an object when a custom type parser is set, so
    // the mapping must not assume a string.
    const gate = await claimWith(claimRow({
      decision: { status: 'failure', eligible: false, reason: 'infrastructure-failure' },
      evidence: { expectedLanes: 5, completedLanes: 0 },
    }));

    expect(gate).toMatchObject({
      decisionReason: 'infrastructure-failure', expectedLanes: 5, completedLanes: 0,
    });
  });

  it('omits every derived field when the row carries no decision or evidence', async () => {
    // A progress row (or any row predating the decision column) must not
    // fabricate a reason; the publisher then falls back to its generic summary.
    const gate = await claimWith(claimRow());
    expect(gate?.decisionReason).toBeUndefined();
    expect(gate?.expectedLanes).toBeUndefined();
    expect(gate?.completedLanes).toBeUndefined();
  });

  it('omits a non-string reason so the summary cannot interpolate arbitrary values', async () => {
    const gate = await claimWith(claimRow({
      decision: JSON.stringify({ status: 'failure', reason: { nested: 'incomplete-review' } }),
      evidence: JSON.stringify({ expectedLanes: 3, completedLanes: 2 }),
    }));

    expect(gate?.decisionReason).toBeUndefined();
    // The counts are independent of the reason and still map.
    expect(gate).toMatchObject({ expectedLanes: 3, completedLanes: 2 });
  });

  it('omits lane counts that fail the safe-integer guard', async () => {
    for (const evidence of [
      { expectedLanes: -1, completedLanes: 2 },
      { expectedLanes: 3.5, completedLanes: 2 },
      { expectedLanes: '3', completedLanes: 2 },
      { expectedLanes: 3, completedLanes: Number.NaN },
    ]) {
      const gate = await claimWith(claimRow({
        decision: JSON.stringify({ status: 'failure', reason: 'incomplete-review' }),
        evidence: JSON.stringify(evidence),
      }));
      // Whatever survives must be a non-negative safe integer or absent; it must
      // never be a value the summary could print as "undefined" or negative.
      for (const value of [gate?.expectedLanes, gate?.completedLanes]) {
        if (value !== undefined) expect(Number.isSafeInteger(value) && value >= 0).toBe(true);
      }
    }
  });

  it('keeps the reason when evidence is absent, so the cause is still named', async () => {
    const gate = await claimWith(claimRow({
      decision: JSON.stringify({ status: 'failure', reason: 'incomplete-review' }),
    }));

    expect(gate?.decisionReason).toBe('incomplete-review');
    expect(gate?.expectedLanes).toBeUndefined();
    expect(gate?.completedLanes).toBeUndefined();
  });
});
