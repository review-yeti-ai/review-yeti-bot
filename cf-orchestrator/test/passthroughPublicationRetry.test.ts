import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PASSTHROUGH_PUBLICATION_MAX_ATTEMPTS,
  isRetryablePublicationFailure,
  publishPassthroughWithRetry,
} from '../src/passthroughPublicationRetry.js';

const unavailable = (errorCode: string) => ({ status: 'unavailable', mergeEligible: false, errorCode }) as any;
const succeeded = { status: 'succeeded', mergeEligible: true } as any;

function harness(results: any[]) {
  const stepNames: string[] = [];
  const sleeps: string[] = [];
  let calls = 0;
  const step = {
    async do(name: string, _config: unknown, fn: () => Promise<unknown>) { stepNames.push(name); return fn(); },
    async sleep(name: string, duration: string) { sleeps.push(`${name}:${duration}`); },
  };
  const publish = async () => results[Math.min(calls++, results.length - 1)];
  return { step, publish, stepNames, sleeps, calls: () => calls };
}

async function withCapturedWarnings<T>(fn: () => Promise<T>): Promise<{ value: T; lines: any[] }> {
  const original = console.warn;
  const lines: any[] = [];
  console.warn = (...args: unknown[]) => { try { lines.push(JSON.parse(String(args[0]))); } catch { lines.push(args); } };
  try { return { value: await fn(), lines }; } finally { console.warn = original; }
}

describe('paused passthrough publication retry', () => {
  it('classifies only transient availability failures as retryable', () => {
    for (const code of ['check_publication_unavailable', 'durable_state_unavailable', 'check_readback_unavailable', 'deadline_exceeded']) {
      assert.equal(isRetryablePublicationFailure(unavailable(code)), true, code);
    }
    for (const code of ['cancel_requested', 'prior_semantic_block', 'check_identity_unverified', 'current_candidate_changed', 'policy_not_current']) {
      assert.equal(isRetryablePublicationFailure(unavailable(code)), false, code);
    }
    assert.equal(isRetryablePublicationFailure(succeeded), false);
  });

  it('resumes the same publication after a transient failure so the half-completed pair is finished', async () => {
    const h = harness([unavailable('check_publication_unavailable'), succeeded]);
    const { value, lines } = await withCapturedWarnings(() =>
      publishPassthroughWithRetry(h.step, 'operator-passthrough-publication', { retries: { limit: 0, delay: '1 second' } }, h.publish,
        { runId: 'run_x', prNumber: 7, headSha: 'a'.repeat(40) }));
    assert.equal(value.status, 'succeeded');
    assert.equal(h.calls(), 2);
    assert.deepEqual(h.stepNames, ['operator-passthrough-publication', 'operator-passthrough-publication-retry-1']);
    assert.deepEqual(h.sleeps, ['operator-passthrough-publication-backoff-1:2 seconds']);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].event, 'operator_passthrough_publication_failed');
    assert.equal(lines[0].errorCode, 'check_publication_unavailable');
    assert.equal(lines[0].willRetry, true);
    assert.equal(lines[0].headSha, 'a'.repeat(12));
  });

  it('does not retry a cancellation or a verdict', async () => {
    const h = harness([unavailable('cancel_requested'), succeeded]);
    const { value, lines } = await withCapturedWarnings(() =>
      publishPassthroughWithRetry(h.step, 'operator-passthrough-publication', {}, h.publish));
    assert.equal(value.status, 'unavailable');
    assert.equal(h.calls(), 1);
    assert.equal(h.sleeps.length, 0);
    assert.equal(lines[0].errorCode, 'cancel_requested');
    assert.equal(lines[0].willRetry, false);
  });

  it('stops after the attempt limit and returns the last failure', async () => {
    const h = harness([unavailable('durable_state_unavailable')]);
    const { value } = await withCapturedWarnings(() =>
      publishPassthroughWithRetry(h.step, 'operator-passthrough-publication', {}, h.publish));
    assert.equal(value.status, 'unavailable');
    assert.equal(h.calls(), PASSTHROUGH_PUBLICATION_MAX_ATTEMPTS);
    assert.equal(h.sleeps.length, PASSTHROUGH_PUBLICATION_MAX_ATTEMPTS - 1);
  });

  it('a first-attempt success runs once, sleeps never and logs nothing', async () => {
    const h = harness([succeeded]);
    const { value, lines } = await withCapturedWarnings(() =>
      publishPassthroughWithRetry(h.step, 'operator-passthrough-publication', {}, h.publish));
    assert.equal(value.status, 'succeeded');
    assert.equal(h.calls(), 1);
    assert.equal(h.sleeps.length, 0);
    assert.equal(lines.length, 0);
  });
});
