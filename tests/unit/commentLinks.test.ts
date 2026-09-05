import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  CommentPublisher,
  formatInlineCommentBody,
  getJobId,
  getLiveStreamUrl,
  getOrgDashboardUrl,
  formatDashboardFooter,
  PersonaFinding,
  ASCII_MASCOT,
} from '../../src/comments/CommentPublisher';

describe('Comment Publisher Dashboard Links & Markdown Suite', () => {
  const originalEnv = process.env.DASHBOARD_URL;

  beforeEach(() => {
    process.env.DASHBOARD_URL = originalEnv;
  });

  afterEach(() => {
    process.env.DASHBOARD_URL = originalEnv;
  });

  describe('URL Construction & Helper Functions', () => {
    it('formats jobId correctly from owner, repo, prNumber, and commitSha', () => {
      const jobId = getJobId('calltelemetry', 'cisco-cdr', 42, 'a1b2c3d4e5f6789');
      expect(jobId).toBe('job_calltelemetry_cisco-cdr_pr42_a1b2c3d');
    });

    it('generates Live Stream URL and strips trailing slash from domain', () => {
      const url = getLiveStreamUrl('https://review.example.com/', 'job_test_123');
      expect(url).toBe('https://review.example.com/dashboard/live?jobId=job_test_123');
    });

    it('generates Organization Dashboard URL and strips trailing slash from domain', () => {
      const url = getOrgDashboardUrl('https://review.example.com/');
      expect(url).toBe('https://review.example.com/dashboard/organization');
    });

    it('formats dashboard footer string with live stream and org dashboard URLs', () => {
      const liveUrl = 'https://review.example.com/dashboard/live?jobId=job_123';
      const orgUrl = 'https://review.example.com/dashboard/organization';
      const footer = formatDashboardFooter(liveUrl, orgUrl);

      expect(footer).toContain('[📊 Live Terminal Dashboard](https://review.example.com/dashboard/live?jobId=job_123)');
      expect(footer).toContain('[🏢 Org Settings](https://review.example.com/dashboard/organization)');
    });
  });

  describe('Review Body Markdown Footer & Idempotency', () => {
    it('appends dashboard footer using default domain fallback', async () => {
      delete process.env.DASHBOARD_URL;
      let capturedBody = '';

      const publisher = new CommentPublisher({
        githubToken: 'ghs_test_token_12345',
        baseUrl: 'https://api.github.test',
      });

      (publisher as any).fetchWithRetry = async (_url: string, opts: any) => {
        const payload = JSON.parse(opts.body);
        capturedBody = payload.body;
        return {
          ok: true,
          status: 200,
          headers: new Map(),
          json: async () => ({ id: 101 }),
        };
      };

      const result = await publisher.publishReview({
        owner: 'acme',
        repo: 'backend',
        prNumber: 10,
        commitSha: '9876543210fe',
        event: 'APPROVE',
        body: 'LGTM!',
      });

      expect(result.success).toBe(true);
      expect(capturedBody).toContain('https://ct-review-bot.calltelemetry.com/dashboard/live?jobId=job_acme_backend_pr10_9876543');
      expect(capturedBody).toContain('https://ct-review-bot.calltelemetry.com/dashboard/organization');
    });

    it('uses process.env.DASHBOARD_URL override when configured', async () => {
      process.env.DASHBOARD_URL = 'https://custom-bot.company.internal';
      let capturedBody = '';

      const publisher = new CommentPublisher({
        githubToken: 'ghs_test_token_12345',
        baseUrl: 'https://api.github.test',
      });

      (publisher as any).fetchWithRetry = async (_url: string, opts: any) => {
        const payload = JSON.parse(opts.body);
        capturedBody = payload.body;
        return {
          ok: true,
          status: 200,
          headers: new Map(),
          json: async () => ({ id: 102 }),
        };
      };

      await publisher.publishReview({
        owner: 'acme',
        repo: 'backend',
        prNumber: 10,
        commitSha: '9876543210fe',
        event: 'APPROVE',
        body: 'LGTM!',
      });

      expect(capturedBody).toContain('https://custom-bot.company.internal/dashboard/live?jobId=job_acme_backend_pr10_9876543');
    });

    it('ensures dashboard footer is idempotent and NOT duplicated if already present in body', async () => {
      let capturedBody = '';

      const publisher = new CommentPublisher({
        githubToken: 'ghs_test_token_12345',
        baseUrl: 'https://api.github.test',
      });

      (publisher as any).fetchWithRetry = async (_url: string, opts: any) => {
        const payload = JSON.parse(opts.body);
        capturedBody = payload.body;
        return {
          ok: true,
          status: 200,
          headers: new Map(),
          json: async () => ({ id: 103 }),
        };
      };

      const domain = 'https://ct-review-bot.calltelemetry.com';
      const jobId = getJobId('acme', 'backend', 10, '9876543210fe');
      const footer = formatDashboardFooter(getLiveStreamUrl(domain, jobId), getOrgDashboardUrl(domain));
      const initialBody = `## PR Review Summary${footer}`;

      await publisher.publishReview({
        owner: 'acme',
        repo: 'backend',
        prNumber: 10,
        commitSha: '9876543210fe',
        event: 'COMMENT',
        body: initialBody,
      });

      // Count occurrences of live stream text
      const matches = capturedBody.match(/Live Terminal Dashboard/g);
      expect(matches?.length).toBe(1);
    });
  });

  describe('Inline Comment Body Generator (formatInlineCommentBody)', () => {
    it('formats finding with uppercase severity and confidence score', () => {
      const finding: PersonaFinding = {
        persona: 'Security',
        severity: 'critical',
        filePath: 'src/auth.ts',
        lineNumber: 45,
        comment: 'Hardcoded secret detected',
        title: 'Hardcoded API Key',
        confidence: 98,
      };

      const formatted = formatInlineCommentBody(finding);

      expect(formatted).toContain('### [Security] Hardcoded API Key — Severity: CRITICAL');
      expect(formatted).toContain('**Confidence**: 98%');
      expect(formatted).toContain('**Finding**: Hardcoded secret detected');
    });

    it('formats recommendation block properly', () => {
      const finding: PersonaFinding = {
        persona: 'Architecture',
        severity: 'major',
        filePath: 'src/db.ts',
        lineNumber: 12,
        comment: 'Direct database call from UI component',
        recommendation: 'Refactor database access to data service layer',
      };

      const formatted = formatInlineCommentBody(finding);

      expect(formatted).toContain('[RECOMMENDATION] Refactor database access to data service layer');
    });

    it('formats multi-option fix suggestions when fixOptions are provided', () => {
      const finding: PersonaFinding = {
        persona: 'Performance',
        severity: 'minor',
        filePath: 'src/loop.ts',
        lineNumber: 88,
        comment: 'O(N^2) loop detected',
        fixOptions: [
          { rank: 1, title: 'Use Map for O(1) Lookup', explanation: 'Replace inner loop with Map lookup', suggestionCode: 'const map = new Map();' },
          { rank: 2, title: 'Sort and Binary Search', explanation: 'Pre-sort elements first', suggestionCode: 'arr.sort();' },
        ],
      };

      const formatted = formatInlineCommentBody(finding);

      expect(formatted).toContain('#### Option 1: Use Map for O(1) Lookup (Rank #1)');
      expect(formatted).toContain('Replace inner loop with Map lookup');
      expect(formatted).toContain('```suggestion\nconst map = new Map();\n```');
      expect(formatted).toContain('#### Option 2: Sort and Binary Search (Rank #2)');
      expect(formatted).toContain('```suggestion\narr.sort();\n```');
    });

    it('formats single suggestion code block when suggestion string is provided', () => {
      const finding: PersonaFinding = {
        persona: 'Code Quality',
        severity: 'nit',
        filePath: 'src/utils.ts',
        lineNumber: 20,
        comment: 'Use const instead of let',
        suggestion: 'const count = 0;',
      };

      const formatted = formatInlineCommentBody(finding);

      expect(formatted).toContain('Severity: NIT');
      expect(formatted).toContain('```suggestion\nconst count = 0;\n```');
    });

    it('prepends ASCII mascot header when mascot option is enabled', () => {
      const finding: PersonaFinding = {
        persona: 'Security',
        severity: 'critical',
        filePath: 'src/main.ts',
        lineNumber: 1,
        comment: 'Test comment',
      };

      const formatted = formatInlineCommentBody(finding, { mascot: true });

      expect(formatted).toContain(ASCII_MASCOT);
    });
  });

  describe('Nit Suppression Integration (publishReviewWithNitSuppression)', () => {
    it('filters out suppressed nit findings before publishing inline comments', async () => {
      let publishedComments: any[] = [];

      const publisher = new CommentPublisher({
        githubToken: 'ghs_test_token_12345',
        baseUrl: 'https://api.github.test',
      });

      (publisher as any).fetchWithRetry = async (_url: string, opts: any) => {
        const payload = JSON.parse(opts.body);
        publishedComments = payload.comments || [];
        return {
          ok: true,
          status: 200,
          headers: new Map(),
          json: async () => ({ id: 104 }),
        };
      };

      const mockLearningEngine = {
        analyzeAndFilterFindings: async (_repo: string, findings: any[]) => {
          // Keep only non-nit findings
          const filteredFindings = findings.filter((f) => f.severity !== 'P2');
          return { filteredFindings, suppressedNits: [] };
        },
      };

      const inlineComments = [
        {
          path: 'src/index.ts',
          line: 10,
          finding: {
            persona: 'Security',
            severity: 'critical' as const,
            filePath: 'src/index.ts',
            lineNumber: 10,
            comment: 'Critical security flaw',
            title: 'Critical Flaw',
          },
        },
        {
          path: 'src/index.ts',
          line: 15,
          finding: {
            persona: 'Code Quality',
            severity: 'nit' as const,
            filePath: 'src/index.ts',
            lineNumber: 15,
            comment: 'Minor formatting nit',
            title: 'Formatting Nit',
          },
        },
      ];

      const res = await publisher.publishReviewWithNitSuppression(
        {
          owner: 'acme',
          repo: 'backend',
          prNumber: 5,
          commitSha: 'abc1234',
          event: 'COMMENT',
          body: 'Review summary',
          inlineComments,
        },
        mockLearningEngine as any
      );

      expect(res.success).toBe(true);
      expect(publishedComments.length).toBe(1);
      expect(publishedComments[0].body).toContain('CRITICAL');
      expect(publishedComments[0].body).not.toContain('Formatting Nit');
    });
  });
});
