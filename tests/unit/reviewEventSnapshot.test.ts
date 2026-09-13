import { describe, expect, it, vi } from 'vitest';
import { PostgresReviewEventSnapshotStore } from '../../src/events/reviewEventSnapshot';

const runId = `run_${'a'.repeat(32)}`;
const scope = { repositoryIds: [123] };
const record = (overrides: Record<string, unknown> = {}) => ({
  run_id: runId, repository_id: '123', owner: 'example', repo: 'service', pr_number: 42,
  head_sha: 'b'.repeat(40), base_sha: 'c'.repeat(40), status: 'running', stage: 'review',
  attempt: 0, result_digest: null, created_at: new Date('2026-09-13T00:00:00Z'),
  updated_at: new Date('2026-09-13T00:01:00Z'), lifecycle_sequence: '4',
  failure_class: null, gate_attempt_id: null, gate_check_id: null, gate_app_id: null,
  gate_state: null, gate_published: null, gate_reason: null,
  completion_status: null, validation_request_id: null,
  ...overrides,
});

function fixture(row: ReturnType<typeof record> | null = record()) {
  const query = vi.fn(async () => ({ rows: row ? [row] : [] }));
  return { query, store: new PostgresReviewEventSnapshotStore({ query }) };
}

describe('authoritative review event snapshots', () => {
  it('selects a scoped run once and exposes only the closed observation fields', async () => {
    const { query, store } = fixture(record({ error_text: 'private error', worker_token: 'private token' }));
    const snapshot = await store.getSnapshot(runId, scope);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]).toEqual([expect.stringContaining('SELECT'), [runId, [123]]]);
    expect(snapshot).toMatchObject({ schema: 'review-yeti-snapshot.v1', runId, repositoryId: 123,
      repository: 'example/service', prNumber: 42, status: 'running', stage: 'review',
      lifecycleSequenceDomain: 'legacy_run_v1', lifecycleSequence: 4,
      terminalClass: null, resultDigest: null, gate: null, completion: null });
    expect(JSON.stringify(snapshot)).not.toMatch(/private error|private token|error_text|worker_token/);
  });

  it('does not query invalid, empty, or unauthorized run scopes', async () => {
    const { query, store } = fixture();
    expect(await store.getSnapshot('../other', scope)).toBeNull();
    expect(await store.getSnapshot(runId, { repositoryIds: [] })).toBeNull();
    expect(await store.getSnapshot(runId, { repositoryIds: [123], runIds: ['run_' + 'd'.repeat(32)] })).toBeNull();
    expect(await store.getSnapshot(runId, { repositoryIds: [NaN] })).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('hides absent and foreign rows identically, even from a misbehaving query adapter', async () => {
    expect(await fixture(null).store.getSnapshot(runId, scope)).toBeNull();
    expect(await fixture(record({ repository_id: 999 })).store.getSnapshot(runId, scope)).toBeNull();
    expect(await fixture(record({ run_id: 'run_' + 'd'.repeat(32) })).store.getSnapshot(runId, scope)).toBeNull();
  });

  it.each([
    ['provider_error', 'provider_failure'], ['auth', 'provider_failure'], ['rate_limit', 'provider_failure'],
    ['transport', 'transport_failure'], ['timeout', 'transport_failure'],
    ['unrecognized-private-error', 'unknown'],
  ])('classifies %s without returning freeform diagnostics', async (failure, expected) => {
    const snapshot = await fixture(record({ status: 'failed', failure_class: failure })).store.getSnapshot(runId, scope);
    expect(snapshot?.terminalClass).toBe(expected);
    expect(JSON.stringify(snapshot)).not.toContain('unrecognized-private-error');
  });

  it.each([
    [{ failure_class: 'provider_error' }, 'provider_failure'],
    [{ failure_class: 'transport' }, 'transport_failure'],
    [{ failure_class: 'timeout' }, 'transport_failure'],
    [{ failure_class: 'internal_error' }, 'internal_failure'],
    [{ failure_class: 'contract' }, 'internal_failure'],
    [{ failure_class: 'internal_error', failure_reason: 'superseded_publisher_owned_check' }, 'superseded'],
    [{ failure_class: 'internal_error', failure_reason: 'dispatch_delivery_identity_mismatch' }, 'internal_failure'],
    [{ stage: 'publish' }, 'publication_failure'],
    [{ failure_class: null }, 'unknown'],
  ])('projects actual dispatcher terminal rows without inferring success: %j', async (overrides, expected) => {
    const snapshot = await fixture(record({ status: 'terminal', stage: 'terminal', ...overrides }))
      .store.getSnapshot(runId, scope);
    expect(snapshot).toMatchObject({ status: 'terminal', terminalClass: expected });
    expect(snapshot?.terminalClass).not.toBe('review_verdict');
    expect(JSON.stringify(snapshot)).not.toMatch(/failure_reason|dispatch_delivery_identity_mismatch/);
  });

  it('preserves unknown delivery and distinguishes a verdict from delivery success', async () => {
    const snapshot = await fixture(record({ status: 'succeeded', result_digest: 'd'.repeat(64),
      gate_attempt_id: `${runId}-g0-e1`, gate_check_id: '456', gate_app_id: '4385771',
      gate_state: 'failure', gate_published: false, gate_reason: 'blocking-findings',
      completion_status: 'pending', validation_request_id: 'validation-1',
    })).store.getSnapshot(runId, scope);
    expect(snapshot?.terminalClass).toBe('review_verdict');
    expect(snapshot?.gate).toEqual({ attemptId: `${runId}-g0-e1`, checkId: 456, expectedAppId: 4385771,
      state: 'failure', published: false, reason: 'blocking-findings' });
    expect(snapshot?.completion).toEqual({ state: 'pending', validationRequestId: 'validation-1' });
  });

  it.each(['gate_app_id', 'gate_state', 'gate_published'])('rejects an incomplete gate with missing %s', field => {
    const row = record({ gate_attempt_id: `${runId}-g0-e1`, gate_app_id: 4385771,
      gate_state: 'queued', gate_published: false, [field]: null });
    return expect(fixture(row).store.getSnapshot(runId, scope)).rejects.toThrow(/^Review snapshot unavailable$/);
  });

  it('rejects a completion without its validation request identity', async () => {
    await expect(fixture(record({ completion_status: 'pending', validation_request_id: null }))
      .store.getSnapshot(runId, scope)).rejects.toThrow(/^Review snapshot unavailable$/);
  });

  it('redacts an unrecognized gate reason without changing the durable gate state', async () => {
    const snapshot = await fixture(record({ gate_attempt_id: `${runId}-g0-e1`, gate_app_id: 4385771,
      gate_state: 'failure', gate_published: false, gate_reason: 'unrecognized-private-gate-diagnostic' }))
      .store.getSnapshot(runId, scope);
    expect(snapshot?.gate).toMatchObject({ state: 'failure', published: false, reason: null });
    expect(JSON.stringify(snapshot)).not.toContain('unrecognized-private-gate-diagnostic');
  });

  it.each([
    [{ status: 'superseded' }, 'superseded'],
    [{ status: 'cancelled', gate_attempt_id: `${runId}-g0-e1`, gate_state: 'cancelled',
      gate_published: true, gate_app_id: 4385771, gate_reason: 'pull-request-closed' }, 'pr_terminal'],
    [{ status: 'cancelled' }, 'unknown'],
    [{ status: 'failed', stage: 'publish' }, 'publication_failure'],
  ])('preserves non-success state %j', async (overrides, expected) => {
    expect((await fixture(record(overrides)).store.getSnapshot(runId, scope))?.terminalClass).toBe(expected);
  });

  it.each([{ lifecycle_sequence: '9007199254740993' }, { head_sha: 'invalid' },
    { stage: 'private-stage' }, { result_digest: 'secret-value' }])('rejects malformed durable data without leaking it: %j', async (overrides) => {
    await expect(fixture(record(overrides)).store.getSnapshot(runId, scope)).rejects.toThrow('Review snapshot unavailable');
  });

  it('does not expose the raw database error', async () => {
    const query = vi.fn().mockRejectedValue(new Error('postgres://user:secret@private-db'));
    await expect(new PostgresReviewEventSnapshotStore({ query }).getSnapshot(runId, scope))
      .rejects.toThrow(/^Review snapshot unavailable$/);
  });
});
