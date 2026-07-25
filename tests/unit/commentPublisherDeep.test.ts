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
});
