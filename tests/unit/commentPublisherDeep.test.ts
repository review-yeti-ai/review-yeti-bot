import { describe, it, expect, vi } from 'vitest';
import {
  CommentPublisher,
  formatInlineCommentBody,
  PersonaFinding,
} from '../../src/github/commentPublisher';

describe('commentPublisher.ts — Deep Edge Case Unit Tests', () => {
  const baseFinding: PersonaFinding = {
    persona: 'security',
    severity: 'critical',
    filePath: 'src/config.ts',
    lineNumber: 10,
    comment: 'Sensitive key leaked',
    title: 'Secret Leak',
  };

  it('formatInlineCommentBody formats P0 severity as P0', () => {
    const finding: PersonaFinding = { ...baseFinding, severity: 'P0' };
    const body = formatInlineCommentBody(finding);
    expect(body).toContain('Severity: P0');
  });

  it('formatInlineCommentBody formats P1 severity as P1', () => {
    const finding: PersonaFinding = { ...baseFinding, severity: 'P1' };
    const body = formatInlineCommentBody(finding);
    expect(body).toContain('Severity: P1');
  });

  it('formatInlineCommentBody formats P2 severity as P2', () => {
    const finding: PersonaFinding = { ...baseFinding, severity: 'P2' };
    const body = formatInlineCommentBody(finding);
    expect(body).toContain('Severity: P2');
  });

  it('formatInlineCommentBody handles 0% confidence score', () => {
    const finding: PersonaFinding = { ...baseFinding, confidence: 0 };
    const body = formatInlineCommentBody(finding);
    expect(body).toContain('**Confidence**: 0%');
  });

  it('formatInlineCommentBody handles 100% confidence score', () => {
    const finding: PersonaFinding = { ...baseFinding, confidence: 100 };
    const body = formatInlineCommentBody(finding);
    expect(body).toContain('**Confidence**: 100%');
  });

  it('formatInlineCommentBody limits fixOptions to top 2 options max', () => {
    const finding: PersonaFinding = {
      ...baseFinding,
      fixOptions: [
        { rank: 1, title: 'Fix 1', suggestionCode: 'code1' },
        { rank: 2, title: 'Fix 2', suggestionCode: 'code2' },
        { rank: 1, title: 'Fix 3', suggestionCode: 'code3' },
      ],
    };
    const body = formatInlineCommentBody(finding);
    expect(body).toContain('Option 1: Fix 1');
    expect(body).toContain('Option 2: Fix 2');
    expect(body).not.toContain('Fix 3');
  });

  it('formatInlineCommentBody uses fallback titles for rank 1 and rank 2 when title is omitted', () => {
    const finding: PersonaFinding = {
      ...baseFinding,
      fixOptions: [
        { rank: 1, suggestionCode: 'code1' },
        { rank: 2, suggestionCode: 'code2' },
      ],
    };
    const body = formatInlineCommentBody(finding);
    expect(body).toContain('Option 1: Recommended Fix (Rank #1)');
    expect(body).toContain('Option 2: Alternative Approach (Rank #2)');
  });

  it('CommentPublisher retries on HTTP 429 Rate Limit with retry-after header', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Headers({ 'retry-after': '1' }),
        text: async () => 'Rate limited',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'x-ratelimit-remaining': '5000' }),
        json: async () => ({ id: 777 }),
      });
    vi.stubGlobal('fetch', mockFetch);

    const publisher = new CommentPublisher({
      githubToken: 'ghs_test_token',
      initialRetryDelayMs: 10,
      maxRetries: 2,
    });

    const res = await publisher.publishReview({
      owner: 'calltelemetry',
      repo: 'bot',
      prNumber: 1,
      commitSha: 'sha',
      event: 'COMMENT',
      body: 'test body',
    });

    expect(res.success).toBe(true);
    expect(res.reviewId).toBe(777);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    vi.unstubAllGlobals();
  });

  it('uses injectable fetch, clock, sleep, and jitter without touching global fetch', async () => {
    const fetchImplementation = vi.fn()
      .mockResolvedValueOnce(new Response('Rate limited', {
        status: 429,
        headers: { 'retry-after': '1' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 778 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    const sleep = vi.fn().mockResolvedValue(undefined);

    const publisher = new CommentPublisher({
      githubToken: 'ghs_injected_token',
      fetchImplementation,
      now: () => 1_700_000_000_000,
      sleep,
      random: () => 0,
      maxRetries: 1,
      maxDelayMs: 100,
    });

    const result = await publisher.publishReview({
      owner: 'calltelemetry',
      repo: 'bot',
      prNumber: 44,
      commitSha: 'head-sha-injected',
      event: 'COMMENT',
      body: 'injected transport',
    });

    expect(result.success).toBe(true);
    expect(result.reviewId).toBe(778);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(100);
    expect((fetchImplementation.mock.calls[0][1] as RequestInit).headers).toBeInstanceOf(Headers);
  });

  it('CommentPublisher retries on HTTP 403 Forbidden with x-ratelimit-reset header', async () => {
    const resetTimestampSeconds = Math.floor(Date.now() / 1000) + 1;
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        headers: new Headers({ 'x-ratelimit-reset': String(resetTimestampSeconds) }),
        text: async () => 'Rate limit exceeded',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ id: 888 }),
      });
    vi.stubGlobal('fetch', mockFetch);

    const publisher = new CommentPublisher({
      githubToken: 'ghs_test_token',
      initialRetryDelayMs: 10,
      maxRetries: 2,
    });

    const res = await publisher.publishReview({
      owner: 'calltelemetry',
      repo: 'bot',
      prNumber: 2,
      commitSha: 'sha2',
      event: 'APPROVE',
      body: 'Approved',
    });

    expect(res.success).toBe(true);
    expect(res.reviewId).toBe(888);

    vi.unstubAllGlobals();
  });

  it('CommentPublisher fails after maxRetries limit is reached', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Headers({ 'retry-after': '1' }),
      text: async () => 'Still rate limited',
    });
    vi.stubGlobal('fetch', mockFetch);

    const publisher = new CommentPublisher({
      githubToken: 'ghs_test_token',
      initialRetryDelayMs: 10,
      maxRetries: 1,
    });

    const res = await publisher.publishReview({
      owner: 'calltelemetry',
      repo: 'bot',
      prNumber: 3,
      commitSha: 'sha3',
      event: 'REQUEST_CHANGES',
      body: 'Changes requested',
    });

    expect(res.success).toBe(false);
    expect(res.errors).toBeDefined();

    vi.unstubAllGlobals();
  });

  it('uses an exact-head idempotency marker to avoid duplicate reviews on rerun', async () => {
    let posted = false;
    const fetchImplementation = vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      if (init?.method === 'GET' && input.includes('/pulls/9/reviews')) {
        return new Response(JSON.stringify(posted
          ? [{ id: 919, body: '<!-- ct-review-bot:v1:calltelemetry/bot#9:head-9:persona:security -->' }]
          : []), { status: 200 });
      }
      if (init?.method === 'GET') return new Response('[]', { status: 200 });
      posted = true;
      return new Response(JSON.stringify({ id: 919 }), { status: 200 });
    });
    const publisher = new CommentPublisher({
      githubToken: 'ghs_idempotency_token',
      fetchImplementation,
      sleep: vi.fn().mockResolvedValue(undefined),
    });
    const input = {
      owner: 'calltelemetry',
      repo: 'bot',
      prNumber: 9,
      commitSha: 'head-9',
      event: 'COMMENT' as const,
      body: 'persona result',
      idempotencyKey: 'persona:security',
      inlineComments: [{
        path: 'src/app.ts',
        line: 4,
        finding: baseFinding,
      }],
    };

    await expect(publisher.publishReview(input)).resolves.toMatchObject({ success: true, commentsCreated: 1 });
    await expect(publisher.publishReview(input)).resolves.toMatchObject({ success: true, reviewId: 919, commentsCreated: 0 });
    expect(fetchImplementation.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1);
  });

  it('fails closed when one idempotency lookup endpoint is unavailable', async () => {
    const fetchImplementation = vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      if (init?.method === 'GET' && input.includes('/pulls/10/reviews')) return new Response('upstream unavailable', { status: 503 });
      if (init?.method === 'GET') return new Response('[]', { status: 200 });
      return new Response(JSON.stringify({ id: 920 }), { status: 201 });
    });
    const publisher = new CommentPublisher({ githubToken: 'ghs_marker_lookup_token', fetchImplementation });

    await expect(publisher.publishReview({
      owner: 'calltelemetry',
      repo: 'bot',
      prNumber: 10,
      commitSha: 'head-10',
      event: 'COMMENT',
      body: 'review',
      idempotencyKey: 'persona:security',
    })).resolves.toMatchObject({ success: false });
    expect(fetchImplementation.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(0);
  });
});
