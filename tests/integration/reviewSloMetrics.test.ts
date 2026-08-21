import { describe, expect, it } from 'vitest';
import { ReviewSlo } from '../../src/ops/reviewSlo';

describe('review SLO metrics', () => {
  it('records queue, first-comment, completion, provider, index, and cost signals', () => {
    const slo = new ReviewSlo();
    slo.markQueued(1_000);
    slo.markStarted(1_500);
    slo.markFirstComment(2_000);
    slo.markCompleted(3_000);
    expect(slo.snapshot({ now: 4_000, providerAvailability: 1.2, indexFreshness: -1, costUSD: 0.12 })).toEqual({ queueLatencyMs: 500, firstCommentLatencyMs: 1_000, completionLatencyMs: 2_000, providerAvailability: 1, indexFreshness: 0, costUSD: 0.12 });
  });
});
