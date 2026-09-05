import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CommentPublisher,
  formatInlineCommentBody,
  ASCII_MASCOT,
  PersonaFinding,
} from '../../src/github/commentPublisher';

describe('commentPublisher.ts — Comprehensive Unit Expansion Tests', () => {
  const sampleFinding: PersonaFinding = {
    persona: 'security-tenancy',
    severity: 'critical',
    filePath: 'src/app.ts',
    lineNumber: 42,
    comment: 'SQL Injection vulnerability detected.',
    title: 'SQL Injection',
    confidence: 95,
    recommendation: 'Use parameterized queries instead of string concatenation.',
  };

  it('formatInlineCommentBody formats basic finding details', () => {
    const body = formatInlineCommentBody(sampleFinding);

    expect(body).toContain('### [security-tenancy] SQL Injection — Severity: CRITICAL');
    expect(body).toContain('**Confidence**: 95%');
    expect(body).toContain('**Finding**: SQL Injection vulnerability detected.');
    expect(body).toContain('[RECOMMENDATION] Use parameterized queries instead of string concatenation.');
  });

  it('formatInlineCommentBody includes ASCII mascot when options.mascot is true', () => {
    const body = formatInlineCommentBody(sampleFinding, { mascot: true });

    expect(body).toContain(ASCII_MASCOT);
    expect(body).toContain('CallTelemetry AI Reviewer');
  });

  it('formatInlineCommentBody omits ASCII mascot when options.mascot is false or omitted', () => {
    const body1 = formatInlineCommentBody(sampleFinding, { mascot: false });
    const body2 = formatInlineCommentBody(sampleFinding);

    expect(body1).not.toContain(ASCII_MASCOT);
    expect(body2).not.toContain(ASCII_MASCOT);
  });

  it('formatInlineCommentBody formats ranked fixOptions into suggestion blocks', () => {
    const findingWithFixes: PersonaFinding = {
      ...sampleFinding,
      fixOptions: [
        { rank: 1, title: 'Parameterized Query', explanation: 'Use db.query with params.', suggestionCode: 'db.query("SELECT * FROM users WHERE id = $1", [id])' },
        { rank: 2, title: 'ORM Query', explanation: 'Use Prisma/Kysely builder.', suggestionCode: 'db.user.findUnique({ where: { id } })' },
      ],
    };

    const body = formatInlineCommentBody(findingWithFixes);

    expect(body).toContain('#### Option 1: Parameterized Query (Rank #1)');
    expect(body).toContain('Use db.query with params.');
    expect(body).toContain('```suggestion\ndb.query("SELECT * FROM users WHERE id = $1", [id])\n```');

    expect(body).toContain('#### Option 2: ORM Query (Rank #2)');
    expect(body).toContain('```suggestion\ndb.user.findUnique({ where: { id } })\n```');
  });

  it('formatInlineCommentBody falls back to single suggestion or codeSnippet when fixOptions omitted', () => {
    const findingWithSuggestion: PersonaFinding = {
      ...sampleFinding,
      suggestion: 'const safe = sanitize(input);',
    };

    const body = formatInlineCommentBody(findingWithSuggestion);

    expect(body).toContain('```suggestion\nconst safe = sanitize(input);\n```');
  });

  it('CommentPublisher constructor throws if token does not start with ghs_', () => {
    expect(() => new CommentPublisher({ githubToken: 'ghp_invalid_personal_token' })).toThrow(
      'CommentPublisher requires an explicit GitHub App installation token (ghs_)'
    );
    expect(() => new CommentPublisher({ githubToken: '' })).toThrow(
      'CommentPublisher requires an explicit GitHub App installation token (ghs_)'
    );
  });

  it('CommentPublisher.publishReview sends correct POST request and returns success true', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 123456 }),
      text: async () => JSON.stringify({ id: 123456 }),
      headers: new Headers({ 'x-ratelimit-remaining': '4999' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const publisher = new CommentPublisher({ githubToken: 'ghs_valid_token_123', baseUrl: 'https://api.github.com' });

    const result = await publisher.publishReview({
      owner: 'calltelemetry',
      repo: 'ct-review-bot',
      prNumber: 10,
      commitSha: 'head-sha-10',
      event: 'APPROVE',
      body: 'LGTM!',
      inlineComments: [
        {
          path: 'src/app.ts',
          line: 42,
          finding: sampleFinding,
        },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.reviewId).toBe(123456);
    expect(result.commentsCreated).toBe(1);
    expect(result.rateLimitRemaining).toBe(4999);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/calltelemetry/ct-review-bot/pulls/10/reviews',
      expect.objectContaining({
        method: 'POST',
      })
    );

    vi.unstubAllGlobals();
  });

  it('CommentPublisher.publishReview handles non-200 HTTP responses gracefully', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      text: async () => 'Validation Failed: Review body cannot be empty',
      headers: new Headers(),
    });
    vi.stubGlobal('fetch', mockFetch);

    const publisher = new CommentPublisher({ githubToken: 'ghs_valid_token_123' });

    const result = await publisher.publishReview({
      owner: 'calltelemetry',
      repo: 'ct-review-bot',
      prNumber: 10,
      commitSha: 'head-sha-10',
      event: 'COMMENT',
      body: '',
    });

    expect(result.success).toBe(false);
    expect(result.errors).toContain('HTTP 422: Validation Failed: Review body cannot be empty');

    vi.unstubAllGlobals();
  });

  it('CommentPublisher.publishReview handles network exception gracefully without throwing', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Network connectivity lost'));
    vi.stubGlobal('fetch', mockFetch);

    const publisher = new CommentPublisher({ githubToken: 'ghs_valid_token_123', maxRetries: 0 });

    const result = await publisher.publishReview({
      owner: 'calltelemetry',
      repo: 'ct-review-bot',
      prNumber: 10,
      commitSha: 'head-sha-10',
      event: 'COMMENT',
      body: 'Test body',
    });

    expect(result.success).toBe(false);
    expect(result.errors).toContain('Network connectivity lost');

    vi.unstubAllGlobals();
  });
});
