import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CommentPublisher,
  formatInlineCommentBody,
  PublishInlineCommentRequest,
  PublishReviewRequest,
} from '../../src/github/commentPublisher';
import { PersonaFinding } from '../../src/quorum/quorumEngine';

describe('Milestone 4: Octokit PR Comment Publisher Unit Tests', () => {
  describe('formatInlineCommentBody', () => {
    it('formats security finding with shield emoji and severity badge', () => {
      const finding: PersonaFinding = {
        persona: 'security',
        severity: 'critical',
        filePath: 'src/auth.ts',
        lineNumber: 15,
        comment: 'Potential SQL injection vulnerability in query builder',
      };

      const formatted = formatInlineCommentBody(finding);
      expect(formatted).toContain('### 🛡️ [SECURITY] Severity: CRITICAL');
      expect(formatted).toContain('Potential SQL injection vulnerability in query builder');
      expect(formatted).not.toContain('```suggestion');
    });

    it('includes ```suggestion code block when suggestion or codeSnippet is provided', () => {
      const finding: PersonaFinding = {
        persona: 'performance',
        severity: 'major',
        filePath: 'src/utils.ts',
        lineNumber: 42,
        comment: 'Use Map lookup instead of Array.find in hot loop',
        suggestion: 'const item = map.get(id);',
      };

      const formatted = formatInlineCommentBody(finding);
      expect(formatted).toContain('### ⚡ [PERFORMANCE] Severity: MAJOR');
      expect(formatted).toContain('Use Map lookup instead of Array.find in hot loop');
      expect(formatted).toContain('```suggestion\nconst item = map.get(id);\n```');
    });
  });

  describe('CommentPublisher Class', () => {
    let mockFetch: any;

    beforeEach(() => {
      mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('publishes inline comment to GitHub API endpoint', async () => {
      // Mock GET existing comments -> empty array
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [],
        headers: new Headers(),
      });

      // Mock POST inline comment -> success
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        headers: new Headers({ 'x-ratelimit-remaining': '4990' }),
        json: async () => ({ id: 12345 }),
      });

      const publisher = new CommentPublisher({ baseUrl: 'http://api.github.test' });
      const req: PublishInlineCommentRequest = {
        owner: 'calltelemetry',
        repo: 'ai-workspace',
        prNumber: 101,
        commitSha: 'sha123',
        path: 'src/index.ts',
        line: 25,
        finding: {
          persona: 'architecture',
          severity: 'minor',
          filePath: 'src/index.ts',
          lineNumber: 25,
          comment: 'Consider separating router logic from server startup',
        },
      };

      const res = await publisher.publishInlineComment(req);
      expect(res.success).toBe(true);
      expect(res.commentsCreated).toBe(1);
      expect(res.rateLimitRemaining).toBe(4990);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      const postCall = mockFetch.mock.calls[1];
      expect(postCall[0]).toBe('http://api.github.test/repos/calltelemetry/ai-workspace/pulls/101/comments');
      const body = JSON.parse(postCall[1].body);
      expect(body.commit_id).toBe('sha123');
      expect(body.path).toBe('src/index.ts');
      expect(body.line).toBe(25);
      expect(body.body).toContain('📐 [ARCHITECTURE] Severity: MINOR');
    });

    it('skips publishing duplicate inline comments on identical path and line', async () => {
      // Mock GET existing comments -> returns an existing comment on src/index.ts:25 for ARCHITECTURE
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [
          {
            path: 'src/index.ts',
            line: 25,
            body: '### 📐 [ARCHITECTURE] Severity: MINOR\nConsider separating router logic',
          },
        ],
        headers: new Headers(),
      });

      const publisher = new CommentPublisher({ baseUrl: 'http://api.github.test' });
      const req: PublishInlineCommentRequest = {
        owner: 'calltelemetry',
        repo: 'ai-workspace',
        prNumber: 101,
        commitSha: 'sha123',
        path: 'src/index.ts',
        line: 25,
        finding: {
          persona: 'architecture',
          severity: 'minor',
          filePath: 'src/index.ts',
          lineNumber: 25,
          comment: 'Consider separating router logic from server startup',
        },
      };

      const res = await publisher.publishInlineComment(req);
      expect(res.success).toBe(true);
      expect(res.commentsCreated).toBe(0);
      // POST call should not have been executed
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('publishes top-level PR review summary', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'x-ratelimit-remaining': '4980' }),
        json: async () => ({ id: 999, state: 'APPROVED' }),
      });

      const publisher = new CommentPublisher({ baseUrl: 'http://api.github.test' });
      const req: PublishReviewRequest = {
        owner: 'calltelemetry',
        repo: 'ai-workspace',
        prNumber: 101,
        commitSha: 'sha123',
        event: 'APPROVE',
        body: 'Automated review approved with zero blocking issues',
      };

      const res = await publisher.publishReview(req);
      expect(res.success).toBe(true);
      expect(res.reviewId).toBe(999);
      expect(res.rateLimitRemaining).toBe(4980);

      const postCall = mockFetch.mock.calls[0];
      expect(postCall[0]).toBe('http://api.github.test/repos/calltelemetry/ai-workspace/pulls/101/reviews');
      const body = JSON.parse(postCall[1].body);
      expect(body.event).toBe('APPROVE');
      expect(body.commit_id).toBe('sha123');
    });

    it('retries on HTTP 429 rate limit with backoff and Retry-After header', async () => {
      // 1st call: HTTP 429 Rate Limit
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Headers({ 'retry-after': '1' }),
        text: async () => 'Rate limit exceeded',
      });

      // 2nd call: HTTP 200 Success
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'x-ratelimit-remaining': '100' }),
        json: async () => ({ id: 888 }),
      });

      const publisher = new CommentPublisher({
        baseUrl: 'http://api.github.test',
        initialRetryDelayMs: 10,
        maxRetries: 2,
      });

      const req: PublishReviewRequest = {
        owner: 'calltelemetry',
        repo: 'ai-workspace',
        prNumber: 101,
        commitSha: 'sha123',
        event: 'COMMENT',
        body: 'Retried review comment',
      };

      const res = await publisher.publishReview(req);
      expect(res.success).toBe(true);
      expect(res.reviewId).toBe(888);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('sets commit status on GitHub status API endpoint', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        headers: new Headers(),
        json: async () => ({ state: 'success', context: 'ct-review-bot / quorum-panel' }),
      });

      const publisher = new CommentPublisher({ baseUrl: 'http://api.github.test' });
      const res = await publisher.setCommitStatus({
        owner: 'calltelemetry',
        repo: 'ai-workspace',
        sha: 'sha123',
        state: 'success',
        context: 'ct-review-bot / quorum-panel',
        description: 'Quorum Review Passed (4/4)',
      });

      expect(res.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const call = mockFetch.mock.calls[0];
      expect(call[0]).toBe('http://api.github.test/repos/calltelemetry/ai-workspace/statuses/sha123');
      const body = JSON.parse(call[1].body);
      expect(body.state).toBe('success');
      expect(body.context).toBe('ct-review-bot / quorum-panel');
    });

    it('creates GitHub Check Run with granular status and conclusion', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        headers: new Headers(),
        json: async () => ({ id: 555, status: 'completed', conclusion: 'success' }),
      });

      const publisher = new CommentPublisher({ baseUrl: 'http://api.github.test' });
      const res = await publisher.createCheckRun({
        owner: 'calltelemetry',
        repo: 'ai-workspace',
        headSha: 'sha123',
        name: 'ct-review-bot / quorum-review',
        conclusion: 'success',
        title: 'Quorum Review Passed',
        summary: 'All 4 personas approved diff.',
      });

      expect(res.success).toBe(true);
      expect(res.checkRunId).toBe(555);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const call = mockFetch.mock.calls[0];
      expect(call[0]).toBe('http://api.github.test/repos/calltelemetry/ai-workspace/check-runs');
      const body = JSON.parse(call[1].body);
      expect(body.name).toBe('ct-review-bot / quorum-review');
      expect(body.head_sha).toBe('sha123');
      expect(body.conclusion).toBe('success');
    });
  });
});

