import { afterEach, describe, expect, it, vi } from 'vitest';
import { publishingWorkerAdapters } from '../../src/review/publishingWorkerAdapters';
import { HttpReviewExecutionCheckpointAdapter } from '../../src/review/reviewExecutionCheckpointHttp';
import { HttpWorkerCompletionAdapter } from '../../src/review/workerCompletion';
import { HttpWorkerReviewCompletionAdapter } from '../../src/review/workerReviewCompletionHttp';

const endpoint = 'https://review.example.test/api/dispatch/completion';
describe('publishing worker completion adapter selection', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('selects only typed review completion for the exact authoritative flag', () => {
    const result = publishingWorkerAdapters({ REVIEW_AUTHORITATIVE_GATE: 'true', REVIEW_COMPLETION_URL: endpoint,
      REVIEW_RUN_ID: `run_${'1'.repeat(32)}`, REVIEW_EXECUTION_ATTEMPT: '1' }, 'ghs_test');
    expect(result.reviewCompletion).toBeInstanceOf(HttpWorkerReviewCompletionAdapter);
    expect(result.reviewCheckpoint).toBeInstanceOf(HttpReviewExecutionCheckpointAdapter);
    expect(result.completion).toBeUndefined();
  });
  it('binds the checkpoint read to the exact run and execution attempt', async () => {
    const runId = `run_${'2'.repeat(32)}`;
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      version: 'ReviewExecutionCheckpointReadResult.v1', runId, executionAttempt: 7, checkpoint: null,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetcher);
    const result = publishingWorkerAdapters({ REVIEW_AUTHORITATIVE_GATE: 'true', REVIEW_COMPLETION_URL: endpoint,
      REVIEW_RUN_ID: runId, REVIEW_EXECUTION_ATTEMPT: '7' }, 'ghs_test');

    await expect(result.reviewCheckpoint!.read()).resolves.toBeNull();
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://review.example.test/api/dispatch/review-checkpoint');
    expect(JSON.parse(String(init?.body))).toEqual({
      version: 'ReviewExecutionCheckpointRead.v1', runId, executionAttempt: 7,
    });
  });
  it.each([undefined, '', 'false'])('keeps legacy callback for flag %s', (flag) => {
    const result = publishingWorkerAdapters({ REVIEW_AUTHORITATIVE_GATE: flag, REVIEW_COMPLETION_URL: endpoint }, 'ghs_test');
    expect(result.completion).toBeInstanceOf(HttpWorkerCompletionAdapter);
    expect(result.reviewCompletion).toBeUndefined();
  });
  it('fails closed before a publishing worker runs without its authoritative endpoint', () => {
    expect(() => publishingWorkerAdapters({ REVIEW_AUTHORITATIVE_GATE: 'true' }, 'ghs_test')).toThrow('requires its completion endpoint');
    expect(publishingWorkerAdapters({}, 'ghs_test')).toEqual({});
  });
  it.each(['TRUE', '1', 'yes'])('rejects ambiguous enrollment flag %s', (flag) => {
    expect(() => publishingWorkerAdapters({ REVIEW_AUTHORITATIVE_GATE: flag, REVIEW_COMPLETION_URL: endpoint }, 'ghs_test')).toThrow('Invalid authoritative worker flag');
  });
  it.each(['http://review.example.test/completion', 'https://user:secret@review.example.test/completion'])('does not silently ignore malformed endpoint %s', (value) => {
    expect(() => publishingWorkerAdapters({ REVIEW_AUTHORITATIVE_GATE: 'true', REVIEW_COMPLETION_URL: value }, 'ghs_test')).toThrow();
  });
});
