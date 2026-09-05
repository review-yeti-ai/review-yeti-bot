import { describe, expect, it, vi } from 'vitest';
import {
  CommentPublisher,
  formatInlineCommentBody,
  formatSuggestionBlock,
  formatFindingFallbackTable,
  formatInlineFindingsFallbackTable,
  PersonaFinding,
  PublishInlineCommentRequest,
} from '../../src/github/commentPublisher';
import {
  buildFinalInlineComments,
  dedupeActionableFindings,
  FindingWithPersona,
} from '../../src/github/panelPublication';
import {
  CommentPublisher as FacadeCommentPublisher,
  formatInlineCommentBody as facadeFormatInlineCommentBody,
} from '../../src/publishers/commentPublisher';
import {
  GitHubCheckPublisher,
  GitHubInstallationClient,
} from '../../src/publishers/githubCheckPublisher';
import {
  buildFinalInlineComments as facadeBuildFinalInlineComments,
  dedupeActionableFindings as facadeDedupeActionableFindings,
} from '../../src/arbiter/panelPublication';

describe('Milestone 1: Native 1-Click Suggestion Diffs & Fallback Table (R1)', () => {
  describe('1. Single-Line Suggestion Block Formatting', () => {
    it('formats a single-line code replacement as a native GitHub suggestion block', () => {
      const finding: PersonaFinding = {
        persona: 'correctness',
        severity: 'P1',
        filePath: 'src/auth/jwt.ts',
        lineNumber: 42,
        title: 'Deprecated JWT Algorithm',
        comment: 'Algorithm HS256 is deprecated for service tokens; use RS256.',
        suggestion: 'const algorithm = "RS256";',
      };

      const formatted = formatInlineCommentBody(finding);

      expect(formatted).toContain('### [correctness] Deprecated JWT Algorithm — Severity: P1');
      expect(formatted).toContain('```suggestion\nconst algorithm = "RS256";\n```');
    });

    it('formatSuggestionBlock cleanly strips outer markdown fences and trims extraneous whitespace', () => {
      const fencedCode = '```typescript\nconst timeoutMs = 5000;\n```';
      const block = formatSuggestionBlock(fencedCode);

      expect(block).toBe('```suggestion\nconst timeoutMs = 5000;\n```\n');
    });

    it('formats Option 1 of fixOptions with native suggestion block and preserves Option 2', () => {
      const finding: PersonaFinding = {
        persona: 'performance',
        severity: 'P2',
        filePath: 'src/utils/cache.ts',
        lineNumber: 15,
        title: 'Inefficient Cache Key',
        comment: 'Serializing entire object for key is slow.',
        fixOptions: [
          {
            rank: 1,
            title: 'Use hash key',
            explanation: 'Compute sha256 of object payload',
            suggestionCode: 'const key = crypto.createHash("sha256").update(str).digest("hex");',
          },
          {
            rank: 2,
            title: 'Use composite key',
            explanation: 'Use id and tenant prefix',
            suggestionCode: 'const key = `${tenantId}:${entityId}`;',
          },
        ],
      };

      const formatted = formatInlineCommentBody(finding);

      expect(formatted).toContain('#### Option 1: Use hash key (Rank #1)');
      expect(formatted).toContain('Compute sha256 of object payload');
      expect(formatted).toContain('```suggestion\nconst key = crypto.createHash("sha256").update(str).digest("hex");\n```');
      expect(formatted).toContain('#### Option 2: Use composite key (Rank #2)');
      expect(formatted).toContain('```suggestion\nconst key = `${tenantId}:${entityId}`;\n```');
    });
  });

  describe('2. Multi-Line Suggestion Block Formatting with start_line', () => {
    it('formats multi-line replacement code cleanly inside suggestion fences', () => {
      const multiLineReplacement = [
        'function parseConfig(raw: unknown): Config {',
        '  if (!raw || typeof raw !== "object") {',
        '    throw new Error("Invalid config shape");',
        '  }',
        '  return raw as Config;',
        '}',
      ].join('\n');

      const finding: PersonaFinding = {
        persona: 'contract',
        severity: 'P0',
        filePath: 'src/config.ts',
        lineNumber: 50,
        startLine: 45,
        title: 'Missing Type Guard',
        comment: 'Config parsing lacks object type guard, leading to unhandled TypeError.',
        suggestion: multiLineReplacement,
      };

      const formatted = formatInlineCommentBody(finding);

      expect(formatted).toContain(`\`\`\`suggestion\n${multiLineReplacement}\n\`\`\``);
    });

    it('publishReview maps startLine to start_line and start_side for multi-line suggestions', async () => {
      let capturedPayload: any = null;

      const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: any) => {
        capturedPayload = JSON.parse(init.body);
        return new Response(JSON.stringify({ id: 9001, comments: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });

      const publisher = new CommentPublisher({
        githubToken: 'ghs_mock_test_token',
        fetchImplementation: fetchImpl,
        maxRetries: 0,
      });

      const finding: PersonaFinding = {
        persona: 'security',
        severity: 'critical',
        filePath: 'src/db.ts',
        lineNumber: 30,
        startLine: 25,
        title: 'SQL Injection Risk',
        comment: 'Escape user query parameters.',
        suggestion: 'const res = await db.query("SELECT * FROM users WHERE id = $1", [userId]);',
      };

      const result = await publisher.publishReview({
        owner: 'review-yeti-ai',
        repo: 'review-yeti-bot',
        prNumber: 42,
        commitSha: 'a1b2c3d4e5f67890123456789012345678901234',
        event: 'COMMENT',
        body: 'Review summary',
        inlineComments: [
          {
            owner: 'review-yeti-ai',
            repo: 'review-yeti-bot',
            prNumber: 42,
            commitSha: 'a1b2c3d4e5f67890123456789012345678901234',
            path: 'src/db.ts',
            line: 30,
            startLine: 25,
            side: 'RIGHT',
            finding,
          },
        ],
      });

      expect(result.success).toBe(true);
      expect(capturedPayload).not.toBeNull();
      expect(capturedPayload.comments).toHaveLength(1);
      const comment = capturedPayload.comments[0];
      expect(comment.path).toBe('src/db.ts');
      expect(comment.line).toBe(30);
      expect(comment.start_line).toBe(25);
      expect(comment.start_side).toBe('RIGHT');
      expect(comment.side).toBe('RIGHT');
      expect(comment.body).toContain('```suggestion');
    });

    it('publishReview omits start_line when startLine equals line (single-line diff)', async () => {
      let capturedPayload: any = null;

      const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: any) => {
        capturedPayload = JSON.parse(init.body);
        return new Response(JSON.stringify({ id: 9002 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });

      const publisher = new CommentPublisher({
        githubToken: 'ghs_mock_test_token',
        fetchImplementation: fetchImpl,
        maxRetries: 0,
      });

      const finding: PersonaFinding = {
        persona: 'consistency',
        severity: 'minor',
        filePath: 'src/app.ts',
        lineNumber: 10,
        startLine: 10,
        title: 'Use Strict Equality',
        comment: 'Use === instead of ==',
        suggestion: 'if (x === 1) return;',
      };

      await publisher.publishReview({
        owner: 'review-yeti-ai',
        repo: 'review-yeti-bot',
        prNumber: 43,
        commitSha: 'b2c3d4e5f6a17890123456789012345678901234',
        event: 'COMMENT',
        body: 'Review summary',
        inlineComments: [
          {
            owner: 'review-yeti-ai',
            repo: 'review-yeti-bot',
            prNumber: 43,
            commitSha: 'b2c3d4e5f6a17890123456789012345678901234',
            path: 'src/app.ts',
            line: 10,
            startLine: 10,
            finding,
          },
        ],
      });

      expect(capturedPayload.comments[0].start_line).toBeUndefined();
      expect(capturedPayload.comments[0].line).toBe(10);
    });
  });

  describe('3. Fallback Table Rendering when No Code Suggestion is Present', () => {
    it('renders a structured markdown table when finding has no suggestion or fixOptions', () => {
      const finding: PersonaFinding = {
        persona: 'architecture',
        severity: 'P1',
        filePath: 'src/services/orderService.ts',
        lineNumber: 88,
        title: 'Tight Coupling to Email Transport',
        comment: 'OrderService directly instantiates SMTP transport instead of injecting an event emitter.',
        recommendation: 'Decouple notification delivery using an asynchronous DomainEvent publisher.',
      };

      const formatted = formatInlineCommentBody(finding);

      expect(formatted).toContain('### [architecture] Tight Coupling to Email Transport — Severity: P1');
      expect(formatted).not.toContain('```suggestion');
      expect(formatted).toContain('| Severity | Location | Finding | Recommended Action |');
      expect(formatted).toContain('|---|---|---|---|');
      expect(formatted).toContain('| **P1** | `src/services/orderService.ts:88` | Tight Coupling to Email Transport | Decouple notification delivery using an asynchronous DomainEvent publisher. |');
    });

    it('renders fallback table for architectural advice even when suggestion string is provided', () => {
      const finding: PersonaFinding = {
        persona: 'consistency',
        severity: 'P1',
        filePath: 'src/domain/payment.ts',
        lineNumber: 120,
        startLine: 110,
        isArchitectural: true,
        title: 'Multi-Tenant Isolation Breach',
        comment: 'Cross-tenant aggregation query should be partitioned at database proxy level.',
        suggestion: 'Move tenant aggregation logic to warehouse pipeline rather than OLTP query.',
      };

      const formatted = formatInlineCommentBody(finding);

      expect(formatted).not.toContain('```suggestion');
      expect(formatted).toContain('| Severity | Location | Finding | Recommended Action |');
      expect(formatted).toContain('| **P1** | `src/domain/payment.ts:110-120` | Multi-Tenant Isolation Breach | Move tenant aggregation logic to warehouse pipeline rather than OLTP query. |');
    });

    it('formatFindingFallbackTable escapes pipe characters in action and title', () => {
      const finding: PersonaFinding = {
        persona: 'security',
        severity: 'P0',
        filePath: 'src/regex.ts',
        lineNumber: 5,
        title: 'Unsafe regex | ReDoS hazard',
        comment: 'Use a | b | c safely',
        recommendation: 'Rewrite pattern to avoid nested | operators',
      };

      const table = formatFindingFallbackTable(finding);

      expect(table).toContain('Unsafe regex \\| ReDoS hazard');
      expect(table).toContain('Rewrite pattern to avoid nested \\| operators');
    });
  });

  describe('4. buildFinalInlineComments Preservation', () => {
    it('preserves startLine, fixOptions, recommendation, confidence, and isArchitectural through deduplication and conversion', () => {
      const sampleFindings: FindingWithPersona[] = [
        {
          persona: 'security-tenancy',
          severity: 'P1',
          path: 'src/routes/api.ts',
          line: 25,
          startLine: 20,
          title: 'Missing Tenant Boundary',
          body: 'Verify orgId on all routes.',
          recommendation: 'Add tenant isolation middleware.',
          confidence: 95,
          isArchitectural: false,
          suggestion: 'app.use(tenantGuard());',
          fixOptions: [
            { rank: 1, title: 'Add middleware', suggestionCode: 'app.use(tenantGuard());' },
          ],
        },
        {
          persona: 'policy-compliance',
          severity: 'P1',
          path: 'src/routes/api.ts',
          line: 25,
          startLine: 20,
          title: 'Missing Tenant Boundary',
          body: 'Ensure tenant header is inspected.',
          recommendation: 'Add tenant isolation middleware.',
          confidence: 90,
        },
      ];

      const deduped = dedupeActionableFindings(sampleFindings);
      expect(deduped).toHaveLength(1);
      expect(deduped[0].startLine).toBe(20);
      expect(deduped[0].fixOptions).toHaveLength(1);
      expect(deduped[0].recommendation).toBe('Add tenant isolation middleware.');
      expect(deduped[0].confidence).toBe(95);

      const comments = buildFinalInlineComments({
        owner: 'review-yeti-ai',
        repo: 'review-yeti-bot',
        prNumber: 99,
        commitSha: 'c3d4e5f6a1b27890123456789012345678901234',
        findings: sampleFindings,
      });

      expect(comments).toHaveLength(1);
      const commentReq = comments[0];
      expect(commentReq.startLine).toBe(20);
      expect(commentReq.line).toBe(25);
      expect(commentReq.path).toBe('src/routes/api.ts');

      // Inner finding verification
      const finding = commentReq.finding;
      expect(finding.startLine).toBe(20);
      expect(finding.recommendation).toBe('Add tenant isolation middleware.');
      expect(finding.fixOptions).toEqual([
        { rank: 1, title: 'Add middleware', suggestionCode: 'app.use(tenantGuard());' },
      ]);
      expect(finding.confidence).toBe(95);
      expect(finding.suggestion).toBe('app.use(tenantGuard());');
      expect(finding.isArchitectural).toBe(false);
    });
  });

  describe('5. HTTP 422 Line Resolution Fallback Formatting into Review Body Table', () => {
    it('retries with formatted fallback table when GitHub API returns HTTP 422 Line could not be resolved', async () => {
      let callCount = 0;
      let secondCallPayload: any = null;

      const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: any) => {
        callCount++;
        if (callCount === 1) {
          return new Response(JSON.stringify({
            message: 'Validation Failed',
            errors: [{ message: 'Line could not be resolved in diff' }],
          }), {
            status: 422,
            headers: { 'content-type': 'application/json' },
          });
        }
        secondCallPayload = JSON.parse(init.body);
        return new Response(JSON.stringify({ id: 10001, comments: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });

      const publisher = new CommentPublisher({
        githubToken: 'ghs_mock_test_token',
        fetchImplementation: fetchImpl,
        maxRetries: 0,
      });

      const inlineComments: PublishInlineCommentRequest[] = [
        {
          owner: 'review-yeti-ai',
          repo: 'review-yeti-bot',
          prNumber: 55,
          commitSha: 'd4e5f6a1b2c37890123456789012345678901234',
          path: 'src/server.ts',
          line: 45,
          startLine: 40,
          finding: {
            persona: 'security',
            severity: 'critical',
            filePath: 'src/server.ts',
            lineNumber: 45,
            startLine: 40,
            title: 'Insecure CORS Policy',
            comment: 'Access-Control-Allow-Origin should not be wildcard for credentials.',
            suggestion: 'cors({ origin: allowedOrigins, credentials: true });',
          },
        },
        {
          owner: 'review-yeti-ai',
          repo: 'review-yeti-bot',
          prNumber: 55,
          commitSha: 'd4e5f6a1b2c37890123456789012345678901234',
          path: 'src/auth.ts',
          line: 12,
          finding: {
            persona: 'correctness',
            severity: 'major',
            filePath: 'src/auth.ts',
            lineNumber: 12,
            title: 'Unhandled Promise Rejection',
            comment: 'Await token verification or attach catch handler.',
            recommendation: 'Wrap verifyToken call in try/catch block.',
          },
        },
      ];

      const result = await publisher.publishReview({
        owner: 'review-yeti-ai',
        repo: 'review-yeti-bot',
        prNumber: 55,
        commitSha: 'd4e5f6a1b2c37890123456789012345678901234',
        event: 'COMMENT',
        body: 'Initial review verdict: FIX_FIRST',
        inlineComments,
      });

      expect(result.success).toBe(true);
      expect(result.commentsCreated).toBe(0); // Folded into review body fallback
      expect(callCount).toBe(2);

      expect(secondCallPayload).not.toBeNull();
      expect(secondCallPayload.comments).toBeUndefined(); // Omits rejected inline comments
      expect(secondCallPayload.body).toContain('### 📝 Actionable Findings (Diff Line Resolution Fallback)');
      expect(secondCallPayload.body).toContain('| Severity | Location | Finding | Recommended Action |');
      expect(secondCallPayload.body).toContain('| **CRITICAL** | `src/server.ts:40-45` | Insecure CORS Policy | cors({ origin: allowedOrigins, credentials: true }); |');
      expect(secondCallPayload.body).toContain('| **MAJOR** | `src/auth.ts:12` | Unhandled Promise Rejection | Wrap verifyToken call in try/catch block. |');
      // Verify no unstyled raw suggestion fences in top-level body
      expect(secondCallPayload.body).not.toContain('```suggestion');
    });

    it('formatInlineFindingsFallbackTable returns empty string for empty input', () => {
      expect(formatInlineFindingsFallbackTable([])).toBe('');
    });
  });

  describe('6. Facade Re-Exports Verification', () => {
    it('facades at src/publishers/ and src/arbiter/ export all required members', () => {
      expect(typeof FacadeCommentPublisher).toBe('function');
      expect(typeof facadeFormatInlineCommentBody).toBe('function');
      expect(typeof GitHubCheckPublisher).toBe('function');
      expect(typeof GitHubInstallationClient).toBe('function');
      expect(typeof facadeBuildFinalInlineComments).toBe('function');
      expect(typeof facadeDedupeActionableFindings).toBe('function');
    });
  });
});
