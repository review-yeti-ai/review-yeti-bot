import { describe, expect, it } from 'vitest';
import { publishingWorkerAdapters } from '../../src/review/publishingWorkerAdapters';
import { HttpWorkerCompletionAdapter } from '../../src/review/workerCompletion';
import { HttpWorkerReviewCompletionAdapter } from '../../src/review/workerReviewCompletionHttp';

const endpoint = 'https://review.example.test/api/dispatch/completion';
describe('publishing worker completion adapter selection', () => {
  it('selects only typed review completion for the exact authoritative flag', () => {
    const result = publishingWorkerAdapters({ REVIEW_AUTHORITATIVE_GATE: 'true', REVIEW_COMPLETION_URL: endpoint }, 'ghs_test');
    expect(result.reviewCompletion).toBeInstanceOf(HttpWorkerReviewCompletionAdapter);
    expect(result.completion).toBeUndefined();
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
