import { describe, expect, it } from 'vitest';
import { CommentPublisher } from '../../src/github/commentPublisher';

const request = { owner: 'calltelemetry', repo: 'ct-review-bot', prNumber: 7, commitSha: 'a'.repeat(40), event: 'COMMENT' as const, body: 'review', idempotencyKey: 'run-7' };

describe('GitHub publication replay', () => {
  it('does not duplicate a review after an ambiguous first POST', async () => {
    let postCount = 0;
    const publisher = new CommentPublisher({ githubToken: 'ghs_test', maxRetries: 0, fetchImplementation: async (_url, init) => {
      if (init?.method === 'GET') return new Response('[]', { status: 200 });
      postCount += 1;
      if (postCount === 1) throw new Error('connection reset after GitHub accepted request');
      return new Response(JSON.stringify({ id: 17 }), { status: 201 });
    }, sleep: async () => undefined });
    const first = await publisher.publishReview(request);
    expect(first.success).toBe(false);
    const replayPublisher = new CommentPublisher({ githubToken: 'ghs_test', fetchImplementation: async (_url, init) => {
      if (init?.method === 'GET') return new Response(JSON.stringify([{ id: 17, body: '<!-- ct-review-bot:v1:calltelemetry/ct-review-bot#7:' + request.commitSha + ':run-7 -->' }]), { status: 200 });
      throw new Error('write should be deduplicated');
    } });
    const replay = await replayPublisher.publishReview(request);
    expect(replay).toMatchObject({ success: true, reviewId: 17, commentsCreated: 0 });
  });
});
