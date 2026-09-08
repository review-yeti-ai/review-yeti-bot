import { describe, it, expect, vi } from 'vitest';
import { CommentPublisher, PublishReviewRequest } from '../../src/github/commentPublisher';

const request: PublishReviewRequest = {
  owner: 'org', repo: 'repo', prNumber: 1, commitSha: 'head1',
  event: 'APPROVE', body: 'Verdict: SHIP', stickyOverview: true, idempotencyKey: 'arbiter',
};
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

function fixture(publisherLogin: string | undefined = 'review-yeti[bot]') {
  const comments: any[] = [];
  const reviews: any[] = [];
  const inlineComments: any[] = [];
  const writes: { url: string; method: string; body: any }[] = [];
  let head = 'head1';
  const fetchImplementation = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || 'GET';
    if (method === 'GET' && /\/issues\/comments\/\d+$/.test(url)) return response(comments.find(c => url.endsWith(`/${c.id}`)));
    if (method === 'GET') return response(url.includes('/reviews') ? reviews : url.includes('/pulls/') ? inlineComments : comments);
    const body = JSON.parse(String(init?.body));
    writes.push({ url, method, body });
    if (url.includes('/pulls/') && url.endsWith('/comments')) {
      const comment = { ...body, id: inlineComments.length + 100, user: { type: 'Bot', login: 'review-yeti[bot]' } };
      inlineComments.push(comment);
      return response(comment);
    }
    if (url.endsWith('/reviews')) {
      const review = { ...body, id: reviews.length + 1 };
      reviews.push(review);
      return response(review);
    }
    if (method === 'PATCH') Object.assign(comments.find(c => url.endsWith(`/${c.id}`)), body);
    else comments.push({ ...body, id: comments.length + 10, user: { type: 'Bot', login: 'review-yeti[bot]' } });
    return response(comments[comments.length - 1]);
  });
  const publisher = new CommentPublisher({ githubToken: 'ghs_test', publisherLogin, fetchImplementation, currentHeadSha: async () => head });
  return { publisher, comments, reviews, inlineComments, writes, fetchImplementation, setHead: (value: string) => { head = value; } };
}

describe('sticky App overview publication', () => {
  it('updates one overview on a rerun and new push without creating verdict reviews', async () => {
    const f = fixture();
    expect((await f.publisher.publishReview(request)).success).toBe(true);
    await f.publisher.publishReview({ ...request, body: 'Verdict: REVISE' });
    f.setHead('head2');
    await f.publisher.publishReview({ ...request, commitSha: 'head2', body: 'Verdict: SHIP at head2' });
    expect(f.comments).toHaveLength(1);
    expect(f.comments[0].body).toContain('SHIP at head2');
    expect(f.comments[0].body).not.toContain('REVISE');
    expect(f.reviews).toHaveLength(0);
    expect(f.writes.map(w => w.method)).toEqual(['POST', 'PATCH', 'PATCH']);
  });

  it('publishes inline findings with no visible root verdict and avoids duplicate threads on rerun', async () => {
    const f = fixture();
    const req: PublishReviewRequest = { ...request, inlineComments: [{
      path: 'src/a.ts', line: 2, finding: {
        persona: 'design', severity: 'P2', filePath: 'src/a.ts', lineNumber: 2,
        comment: 'Share validation', replacementCode: '  validate();',
      },
    }] };
    await f.publisher.publishReview(req);
    await f.publisher.publishReview({ ...req, body: 'Updated rationale' });
    expect(f.comments).toHaveLength(1);
    expect(f.comments[0].body).toContain('Updated rationale');
    expect(f.reviews).toHaveLength(0);
    expect(f.inlineComments).toHaveLength(1);
    expect(f.inlineComments[0].body).toContain('```suggestion\n  validate();');
  });

  it('publishes unmappable findings as file conversations without suggestions or fake line anchors', async () => {
    const f = fixture();
    await f.publisher.publishReview({ ...request, inlineComments: [{
      subjectType: 'file', path: 'src/a.ts', line: 99,
      finding: { persona: 'design', severity: 'P2', filePath: 'src/a.ts', lineNumber: 99,
        comment: 'Share validation', replacementCode: 'unsafe replacement' },
    }] });
    expect(f.inlineComments).toHaveLength(1);
    expect(f.inlineComments[0].subject_type).toBe('file');
    expect(f.inlineComments[0]).not.toHaveProperty('line');
    expect(f.inlineComments[0]).not.toHaveProperty('side');
    expect(f.inlineComments[0].body).not.toContain('```suggestion');
    expect(f.reviews).toHaveLength(0);
  });

  it('does not overwrite a human comment containing the marker', async () => {
    const f = fixture();
    f.comments.push({ id: 1, body: '<!-- ct-review-bot:overview:v1 --> human', user: { type: 'User' } });
    await f.publisher.publishReview(request);
    expect(f.comments).toHaveLength(2);
    expect(f.comments[0].body).toContain('human');
  });

  it('fails closed when authenticated publisher identity cannot be established', async () => {
    const f = fixture('');
    expect((await f.publisher.publishReview(request)).success).toBe(false);
    expect(f.writes).toHaveLength(0);
  });

  it('reconciles an ambiguous inline POST without creating duplicate findings', async () => {
    const f = fixture();
    const original = f.fetchImplementation.getMockImplementation()!;
    let disconnected = false;
    f.fetchImplementation.mockImplementation(async (input, init) => {
      const result = await original(input, init);
      if (String(input).includes('/pulls/') && init?.method === 'POST' && !disconnected) {
        disconnected = true;
        throw new Error('inline response lost');
      }
      return result;
    });
    const req: PublishReviewRequest = { ...request, inlineComments: [{
      path: 'src/a.ts', line: 2,
      finding: { persona: 'design', severity: 'P2', filePath: 'src/a.ts', lineNumber: 2, comment: 'Share validation' },
    }] };
    expect((await f.publisher.publishReview(req)).success).toBe(true);
    expect((await f.publisher.publishReview(req)).success).toBe(true);
    expect(f.inlineComments).toHaveLength(1);
    expect(f.comments).toHaveLength(1);
  });

  it('does not adopt another app overview even when it copies our marker', async () => {
    const f = fixture();
    f.comments.push({ id: 1, body: '<!-- ct-review-bot:overview:v1 --> other app', user: { type: 'Bot', login: 'other[bot]' } });
    await f.publisher.publishReview(request);
    expect(f.comments).toHaveLength(2);
    expect(f.comments[0].body).toContain('other app');
  });

  it('fails closed if the saved overview differs from the intended update', async () => {
    const f = fixture();
    const original = f.fetchImplementation.getMockImplementation()!;
    f.fetchImplementation.mockImplementation(async (input, init) => {
      if (/\/issues\/comments\/\d+$/.test(String(input)) && init?.method === 'GET') {
        return response({ body: 'overwritten', user: { type: 'Bot', login: 'review-yeti[bot]' } });
      }
      return original(input, init);
    });
    expect((await f.publisher.publishReview(request)).success).toBe(false);
  });

  it('refuses any overview write after a head change', async () => {
    const f = fixture();
    f.setHead('new-head');
    expect((await f.publisher.publishReview(request)).success).toBe(false);
    expect(f.writes).toHaveLength(0);
  });

  it('recovers an ambiguous overview POST without creating a second comment', async () => {
    const f = fixture();
    const original = f.fetchImplementation.getMockImplementation()!;
    let disconnected = false;
    f.fetchImplementation.mockImplementation(async (input, init) => {
      const result = await original(input, init);
      if (init?.method === 'POST' && !disconnected) {
        disconnected = true;
        throw new Error('connection lost after write');
      }
      return result;
    });
    expect((await f.publisher.publishReview(request)).success).toBe(true);
    expect(f.comments).toHaveLength(1);
    expect(f.writes.map(w => w.method)).toEqual(['POST', 'PATCH']);
  });

  it('fails closed on invalid inline ranges instead of moving findings into the overview', async () => {
    const f = fixture();
    const original = f.fetchImplementation.getMockImplementation()!;
    f.fetchImplementation.mockImplementation(async (input, init) => {
      if (String(input).includes('/pulls/') && String(input).endsWith('/comments') && init?.method === 'POST') return response({ message: 'Invalid line' }, 422);
      return original(input, init);
    });
    const result = await f.publisher.publishReview({ ...request, inlineComments: [{
      path: 'src/a.ts', line: 2, finding: { persona: 'design', severity: 'P2', filePath: 'src/a.ts', lineNumber: 2, comment: 'Bad range' },
    }] });
    expect(result.success).toBe(false);
    expect(f.comments).toHaveLength(0);
    expect(f.reviews).toHaveLength(0);
  });
});
