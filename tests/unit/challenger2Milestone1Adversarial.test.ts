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
  findingDedupeKey,
} from '../../src/github/panelPublication';

describe('Challenger 2 Empirical Adversarial Suite: Arbiter & Panel Publication Pipeline', () => {

  describe('1. dedupeActionableFindings Adversarial Scenarios', () => {

    it('1.1 preserves fixOptions when first finding lacks fixOptions but second duplicate has fixOptions', () => {
      const findings: FindingWithPersona[] = [
        {
          persona: 'security',
          severity: 'P1',
          path: 'src/auth/jwt.ts',
          line: 42,
          title: 'Weak JWT Secret',
          body: 'Short explanation of weak secret.',
          recommendation: 'Use high-entropy secret.',
        },
        {
          persona: 'crypto',
          severity: 'P1',
          path: 'src/auth/jwt.ts',
          line: 42,
          title: 'Weak JWT Secret',
          body: 'Detailed crypto analysis.',
          fixOptions: [
            {
              rank: 1,
              title: 'Generate 256-bit random key',
              suggestionCode: 'const secret = crypto.randomBytes(32).toString("hex");',
            },
          ],
        },
      ];

      const deduped = dedupeActionableFindings(findings);
      expect(deduped).toHaveLength(1);
      expect(deduped[0].fixOptions).toBeDefined();
      expect(deduped[0].fixOptions).toHaveLength(1);
      expect(deduped[0].fixOptions![0].suggestionCode).toContain('crypto.randomBytes');
      expect(deduped[0].recommendation).toBe('Use high-entropy secret.');
      expect(deduped[0].body).toContain('**Seen by personas:** `security`, `crypto`');
    });

    it('1.2 preserves fixOptions when first finding has fixOptions and second duplicate lacks them', () => {
      const findings: FindingWithPersona[] = [
        {
          persona: 'crypto',
          severity: 'P1',
          path: 'src/auth/jwt.ts',
          line: 42,
          title: 'Weak JWT Secret',
          body: 'Detailed crypto analysis.',
          fixOptions: [
            {
              rank: 1,
              title: 'Generate 256-bit random key',
              suggestionCode: 'const secret = crypto.randomBytes(32).toString("hex");',
            },
          ],
        },
        {
          persona: 'security',
          severity: 'P1',
          path: 'src/auth/jwt.ts',
          line: 42,
          title: 'Weak JWT Secret',
          body: 'Short explanation of weak secret.',
          recommendation: 'Use high-entropy secret.',
        },
      ];

      const deduped = dedupeActionableFindings(findings);
      expect(deduped).toHaveLength(1);
      expect(deduped[0].fixOptions).toBeDefined();
      expect(deduped[0].fixOptions).toHaveLength(1);
      expect(deduped[0].fixOptions![0].suggestionCode).toContain('crypto.randomBytes');
      expect(deduped[0].recommendation).toBe('Use high-entropy secret.');
      expect(deduped[0].body).toContain('**Seen by personas:** `crypto`, `security`');
    });

    it('1.3 preserves startLine when first duplicate has undefined startLine and second has startLine', () => {
      const findings: FindingWithPersona[] = [
        {
          persona: 'persona-a',
          severity: 'P0',
          path: 'src/db/query.ts',
          line: 30,
          title: 'Unbounded Query Scan',
          body: 'Add limit and cursor pagination.',
        },
        {
          persona: 'persona-b',
          severity: 'P0',
          path: 'src/db/query.ts',
          line: 30,
          startLine: 20,
          title: 'Unbounded Query Scan',
          body: 'Query without LIMIT can exhaust database memory pool.',
        },
      ];

      const deduped = dedupeActionableFindings(findings);
      expect(deduped).toHaveLength(1);
      expect(deduped[0].startLine).toBe(20);
      expect(deduped[0].line).toBe(30);
    });

    it('1.4 preserves existing startLine when second duplicate has conflicting startLine', () => {
      const findings: FindingWithPersona[] = [
        {
          persona: 'persona-a',
          severity: 'P1',
          path: 'src/db/query.ts',
          line: 30,
          startLine: 22,
          title: 'Unbounded Query Scan',
          body: 'First finding body.',
        },
        {
          persona: 'persona-b',
          severity: 'P1',
          path: 'src/db/query.ts',
          line: 30,
          startLine: 25,
          title: 'Unbounded Query Scan',
          body: 'Second finding body with longer explanation text.',
        },
      ];

      const deduped = dedupeActionableFindings(findings);
      expect(deduped).toHaveLength(1);
      expect(deduped[0].startLine).toBe(22);
      expect(deduped[0].line).toBe(30);
    });

    it('1.5 does not lose suggestion when second finding has longer body but no suggestion', () => {
      const findings: FindingWithPersona[] = [
        {
          persona: 'persona-a',
          severity: 'P1',
          path: 'src/util/time.ts',
          line: 15,
          title: 'Missing Timeout',
          body: 'Short note.',
          suggestion: 'const timeout = 5000;',
        },
        {
          persona: 'persona-b',
          severity: 'P1',
          path: 'src/util/time.ts',
          line: 15,
          title: 'Missing Timeout',
          body: 'Much longer and thorough explanation of why timeouts are vital in distributed networks.',
        },
      ];

      const deduped = dedupeActionableFindings(findings);
      expect(deduped).toHaveLength(1);
      expect(deduped[0].suggestion).toBe('const timeout = 5000;');
      expect(deduped[0].body).toContain('Much longer and thorough explanation');
    });

    it('1.6 isolates findings across multiple files even with identical titles and lines', () => {
      const findings: FindingWithPersona[] = [
        {
          persona: 'sec',
          severity: 'P1',
          path: 'src/serviceA/auth.ts',
          line: 10,
          title: 'Missing Auth Check',
          body: 'Auth required.',
        },
        {
          persona: 'sec',
          severity: 'P1',
          path: 'src/serviceB/auth.ts',
          line: 10,
          title: 'Missing Auth Check',
          body: 'Auth required.',
        },
        {
          persona: 'sec',
          severity: 'P0',
          path: 'src/serviceC/auth.ts',
          line: 10,
          title: 'Missing Auth Check',
          body: 'Auth required.',
        },
      ];

      const deduped = dedupeActionableFindings(findings);
      expect(deduped).toHaveLength(3);
      // P0 must be ranked first
      expect(deduped[0].path).toBe('src/serviceC/auth.ts');
      expect(deduped[0].severity).toBe('P0');
      // P1s sorted alphabetically by path
      expect(deduped[1].path).toBe('src/serviceA/auth.ts');
      expect(deduped[2].path).toBe('src/serviceB/auth.ts');
    });

    it('1.7 excludes non-actionable severities (P2) by default and enforces max cap', () => {
      const findings: FindingWithPersona[] = [
        { persona: 'a', severity: 'P0', path: 'src/p0.ts', line: 1, title: 'Critical Bug', body: 'err' },
        { persona: 'b', severity: 'P1', path: 'src/p1_a.ts', line: 2, title: 'Major Bug 1', body: 'err' },
        { persona: 'c', severity: 'P1', path: 'src/p1_b.ts', line: 3, title: 'Major Bug 2', body: 'err' },
        { persona: 'd', severity: 'P2', path: 'src/p2.ts', line: 4, title: 'Minor Style', body: 'nit' },
      ];

      const deduped = dedupeActionableFindings(findings, { max: 2 });
      expect(deduped).toHaveLength(2);
      expect(deduped[0].severity).toBe('P0');
      expect(deduped[1].severity).toBe('P1');
      expect(deduped.find(f => f.severity === 'P2')).toBeUndefined();
    });

    it('1.8 ignores findings with invalid paths or non-positive line numbers', () => {
      const findings: FindingWithPersona[] = [
        { persona: 'a', severity: 'P0', path: '', line: 10, title: 'Empty path', body: 'err' },
        { persona: 'a', severity: 'P0', path: 'src/valid.ts', line: 0, title: 'Zero line', body: 'err' },
        { persona: 'a', severity: 'P0', path: 'src/valid.ts', line: -5, title: 'Negative line', body: 'err' },
        { persona: 'a', severity: 'P0', path: 'src/valid.ts', line: NaN, title: 'NaN line', body: 'err' },
        { persona: 'a', severity: 'P0', path: 'src/valid.ts', line: 10, title: 'Valid line', body: 'valid' },
      ];

      const deduped = dedupeActionableFindings(findings);
      expect(deduped).toHaveLength(1);
      expect(deduped[0].path).toBe('src/valid.ts');
      expect(deduped[0].line).toBe(10);
    });

    it('1.9 preserves isArchitectural flag across deduplication passes', () => {
      const findings: FindingWithPersona[] = [
        {
          persona: 'architect',
          severity: 'P1',
          path: 'src/arch/gateway.ts',
          line: 50,
          title: 'Decouple Ingress Layer',
          body: 'Ingress should be decoupled.',
          isArchitectural: true,
        },
        {
          persona: 'reviewer',
          severity: 'P1',
          path: 'src/arch/gateway.ts',
          line: 50,
          title: 'Decouple Ingress Layer',
          body: 'Ingress should be decoupled from domain handlers directly.',
        },
      ];

      const deduped = dedupeActionableFindings(findings);
      expect(deduped).toHaveLength(1);
      expect(deduped[0].isArchitectural).toBe(true);
    });
  });

  describe('2. buildFinalInlineComments Data Mapping', () => {
    it('2.1 maps startLine, fixOptions, recommendation, confidence, and isArchitectural to request and finding', () => {
      const findings: FindingWithPersona[] = [
        {
          persona: 'security',
          severity: 'P0',
          path: 'src/api/handler.ts',
          line: 45,
          startLine: 35,
          title: 'SQL Injection Vulnerability',
          body: 'Escape user input in raw SQL query.',
          recommendation: 'Use parameterized queries.',
          confidence: 98,
          isArchitectural: false,
          suggestion: 'const [rows] = await db.execute("SELECT * FROM users WHERE id = ?", [id]);',
          fixOptions: [
            {
              rank: 1,
              title: 'Parameterized query',
              suggestionCode: 'const [rows] = await db.execute("SELECT * FROM users WHERE id = ?", [id]);',
            },
          ],
        },
      ];

      const comments = buildFinalInlineComments({
        owner: 'review-yeti-ai',
        repo: 'review-yeti-bot',
        prNumber: 100,
        commitSha: '11223344556677889900aabbccddeeff11223344',
        findings,
      });

      expect(comments).toHaveLength(1);
      const req = comments[0];
      expect(req.owner).toBe('review-yeti-ai');
      expect(req.repo).toBe('review-yeti-bot');
      expect(req.prNumber).toBe(100);
      expect(req.commitSha).toBe('11223344556677889900aabbccddeeff11223344');
      expect(req.path).toBe('src/api/handler.ts');
      expect(req.line).toBe(45);
      expect(req.startLine).toBe(35);

      const f = req.finding;
      expect(f.persona).toBe('security');
      expect(f.severity).toBe('critical'); // P0 -> critical
      expect(f.filePath).toBe('src/api/handler.ts');
      expect(f.lineNumber).toBe(45);
      expect(f.startLine).toBe(35);
      expect(f.title).toBe('SQL Injection Vulnerability');
      expect(f.recommendation).toBe('Use parameterized queries.');
      expect(f.confidence).toBe(98);
      expect(f.isArchitectural).toBe(false);
      expect(f.fixOptions).toHaveLength(1);
    });
  });

  describe('3. GitHub API Review Comments Payload Schema Compliance (publishReview)', () => {

    it('3.1 includes start_line and start_side ONLY when startLine is strictly less than line', async () => {
      let capturedPayload: any = null;

      const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: any) => {
        capturedPayload = JSON.parse(init.body);
        return new Response(JSON.stringify({ id: 101, comments: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });

      const publisher = new CommentPublisher({
        githubToken: 'ghs_test_token',
        fetchImplementation: fetchImpl,
        maxRetries: 0,
      });

      const findingMultiLine: PersonaFinding = {
        persona: 'performance',
        severity: 'major',
        filePath: 'src/loop.ts',
        lineNumber: 50,
        startLine: 40,
        comment: 'Optimize loop.',
        suggestion: 'for (let i = 0; i < len; i++) {}',
      };

      const findingSingleLine: PersonaFinding = {
        persona: 'performance',
        severity: 'major',
        filePath: 'src/single.ts',
        lineNumber: 20,
        startLine: 20, // startLine === line
        comment: 'Inline check.',
        suggestion: 'const valid = true;',
      };

      const findingInverted: PersonaFinding = {
        persona: 'performance',
        severity: 'major',
        filePath: 'src/invert.ts',
        lineNumber: 20,
        startLine: 25, // startLine > line (invalid range)
        comment: 'Bad range.',
        suggestion: 'const valid = true;',
      };

      const findingNoStartLine: PersonaFinding = {
        persona: 'performance',
        severity: 'major',
        filePath: 'src/nostart.ts',
        lineNumber: 15,
        comment: 'No start line.',
        suggestion: 'const x = 1;',
      };

      await publisher.publishReview({
        owner: 'test-org',
        repo: 'test-repo',
        prNumber: 1,
        commitSha: 'abcdef1234567890abcdef1234567890abcdef12',
        event: 'COMMENT',
        body: 'Review body',
        inlineComments: [
          {
            owner: 'test-org',
            repo: 'test-repo',
            prNumber: 1,
            commitSha: 'abcdef1234567890abcdef1234567890abcdef12',
            path: 'src/loop.ts',
            line: 50,
            startLine: 40,
            side: 'RIGHT',
            finding: findingMultiLine,
          },
          {
            owner: 'test-org',
            repo: 'test-repo',
            prNumber: 1,
            commitSha: 'abcdef1234567890abcdef1234567890abcdef12',
            path: 'src/single.ts',
            line: 20,
            startLine: 20,
            finding: findingSingleLine,
          },
          {
            owner: 'test-org',
            repo: 'test-repo',
            prNumber: 1,
            commitSha: 'abcdef1234567890abcdef1234567890abcdef12',
            path: 'src/invert.ts',
            line: 20,
            startLine: 25,
            finding: findingInverted,
          },
          {
            owner: 'test-org',
            repo: 'test-repo',
            prNumber: 1,
            commitSha: 'abcdef1234567890abcdef1234567890abcdef12',
            path: 'src/nostart.ts',
            line: 15,
            finding: findingNoStartLine,
          },
        ],
      });

      expect(capturedPayload).not.toBeNull();
      expect(capturedPayload.comments).toHaveLength(4);

      // 1. Multi-line: startLine < line -> MUST include start_line and start_side
      const c1 = capturedPayload.comments[0];
      expect(c1.path).toBe('src/loop.ts');
      expect(c1.line).toBe(50);
      expect(c1.start_line).toBe(40);
      expect(c1.start_side).toBe('RIGHT');
      expect(c1.side).toBe('RIGHT');

      // 2. Single-line: startLine === line -> MUST NOT include start_line or start_side
      const c2 = capturedPayload.comments[1];
      expect(c2.path).toBe('src/single.ts');
      expect(c2.line).toBe(20);
      expect(c2.start_line).toBeUndefined();
      expect(c2.start_side).toBeUndefined();

      // 3. Inverted: startLine > line -> MUST NOT include start_line or start_side
      const c3 = capturedPayload.comments[2];
      expect(c3.path).toBe('src/invert.ts');
      expect(c3.line).toBe(20);
      expect(c3.start_line).toBeUndefined();
      expect(c3.start_side).toBeUndefined();

      // 4. No startLine -> MUST NOT include start_line or start_side
      const c4 = capturedPayload.comments[3];
      expect(c4.path).toBe('src/nostart.ts');
      expect(c4.line).toBe(15);
      expect(c4.start_line).toBeUndefined();
      expect(c4.start_side).toBeUndefined();
    });

    it('3.2 sets start_side to LEFT when side is LEFT for multi-line deletion diffs', async () => {
      let capturedPayload: any = null;

      const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: any) => {
        capturedPayload = JSON.parse(init.body);
        return new Response(JSON.stringify({ id: 102, comments: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });

      const publisher = new CommentPublisher({
        githubToken: 'ghs_test_token',
        fetchImplementation: fetchImpl,
        maxRetries: 0,
      });

      const finding: PersonaFinding = {
        persona: 'deletion-check',
        severity: 'minor',
        filePath: 'src/deleted.ts',
        lineNumber: 100,
        startLine: 90,
        comment: 'Deleted lines check',
        suggestion: '',
      };

      await publisher.publishReview({
        owner: 'test-org',
        repo: 'test-repo',
        prNumber: 2,
        commitSha: 'abcdef1234567890abcdef1234567890abcdef12',
        event: 'COMMENT',
        body: 'Review body',
        inlineComments: [
          {
            owner: 'test-org',
            repo: 'test-repo',
            prNumber: 2,
            commitSha: 'abcdef1234567890abcdef1234567890abcdef12',
            path: 'src/deleted.ts',
            line: 100,
            startLine: 90,
            side: 'LEFT',
            finding,
          },
        ],
      });

      expect(capturedPayload.comments[0].side).toBe('LEFT');
      expect(capturedPayload.comments[0].start_side).toBe('LEFT');
      expect(capturedPayload.comments[0].start_line).toBe(90);
      expect(capturedPayload.comments[0].line).toBe(100);
    });

    it('3.3 rejects non-integer startLine from generating invalid start_line', async () => {
      let capturedPayload: any = null;

      const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: any) => {
        capturedPayload = JSON.parse(init.body);
        return new Response(JSON.stringify({ id: 103, comments: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });

      const publisher = new CommentPublisher({
        githubToken: 'ghs_test_token',
        fetchImplementation: fetchImpl,
        maxRetries: 0,
      });

      const finding: PersonaFinding = {
        persona: 'test',
        severity: 'minor',
        filePath: 'src/float.ts',
        lineNumber: 10,
        startLine: (1.5 as any),
        comment: 'Float line',
        suggestion: 'const a = 1;',
      };

      await publisher.publishReview({
        owner: 'test-org',
        repo: 'test-repo',
        prNumber: 3,
        commitSha: 'abcdef1234567890abcdef1234567890abcdef12',
        event: 'COMMENT',
        body: 'Review body',
        inlineComments: [
          {
            owner: 'test-org',
            repo: 'test-repo',
            prNumber: 3,
            commitSha: 'abcdef1234567890abcdef1234567890abcdef12',
            path: 'src/float.ts',
            line: 10,
            startLine: (1.5 as any),
            finding,
          },
        ],
      });

      expect(capturedPayload.comments[0].start_line).toBeUndefined();
      expect(capturedPayload.comments[0].start_side).toBeUndefined();
    });
  });

  describe('4. Mixed Architectural and Code-Suggestion Formatting', () => {

    it('4.1 renders fallback table for architectural finding without suggestion block', () => {
      const archFinding: PersonaFinding = {
        persona: 'architecture',
        severity: 'P0',
        filePath: 'src/services/billing.ts',
        lineNumber: 200,
        startLine: 180,
        isArchitectural: true,
        title: 'Tight Coupling with Third-Party Gateway',
        comment: 'BillingService directly instantiates Stripe client without dependency injection.',
        recommendation: 'Introduce PaymentGateway interface and inject provider via constructor.',
        suggestion: 'class BillingService { constructor(private gateway: PaymentGateway) {} }',
      };

      const body = formatInlineCommentBody(archFinding);
      expect(body).not.toContain('```suggestion');
      expect(body).toContain('| Severity | Location | Finding | Recommended Action |');
      expect(body).toContain('| **P0** | `src/services/billing.ts:180-200` | Tight Coupling with Third-Party Gateway | Introduce PaymentGateway interface and inject provider via constructor. |');
    });

    it('4.2 renders native suggestion block for code-suggestion finding with isArchitectural false', () => {
      const codeFinding: PersonaFinding = {
        persona: 'correctness',
        severity: 'P1',
        filePath: 'src/services/billing.ts',
        lineNumber: 45,
        isArchitectural: false,
        title: 'Missing Null Check',
        comment: 'Check customer object before accessing customer.id.',
        suggestion: 'if (!customer) throw new Error("Customer not found");',
      };

      const body = formatInlineCommentBody(codeFinding);
      expect(body).toContain('```suggestion\nif (!customer) throw new Error("Customer not found");\n```');
      expect(body).not.toContain('| Severity | Location |');
    });

    it('4.3 renders native suggestion block when isArchitectural is undefined', () => {
      const standardFinding: PersonaFinding = {
        persona: 'performance',
        severity: 'P1',
        filePath: 'src/utils/calc.ts',
        lineNumber: 12,
        title: 'Unnecessary Cloning',
        comment: 'Do not clone array before iteration.',
        suggestion: 'items.forEach(item => process(item));',
      };

      const body = formatInlineCommentBody(standardFinding);
      expect(body).toContain('```suggestion\nitems.forEach(item => process(item));\n```');
      expect(body).not.toContain('| Severity | Location |');
    });

    it('4.4 renders fallback table when finding has no suggestion, codeSnippet, or fixOptions', () => {
      const generalFinding: PersonaFinding = {
        persona: 'policy',
        severity: 'P1',
        filePath: 'docs/SPEC.md',
        lineNumber: 5,
        title: 'Outdated API Documentation',
        comment: 'Specification references v1 API endpoints which are deprecated.',
        recommendation: 'Update documentation to v2 REST routes.',
      };

      const body = formatInlineCommentBody(generalFinding);
      expect(body).not.toContain('```suggestion');
      expect(body).toContain('| Severity | Location | Finding | Recommended Action |');
      expect(body).toContain('| **P1** | `docs/SPEC.md:5` | Outdated API Documentation | Update documentation to v2 REST routes. |');
    });
  });

  describe('5. formatSuggestionBlock Boundary Robustness', () => {
    it('5.1 cleans pre-fenced markdown from LLM outputs', () => {
      const fenced = '```typescript\nconst a = 1;\nconst b = 2;\n```';
      expect(formatSuggestionBlock(fenced)).toBe('```suggestion\nconst a = 1;\nconst b = 2;\n```\n');
    });

    it('5.2 cleans suggestion-fenced markdown without nested syntax error', () => {
      const alreadySuggestion = '```suggestion\nconst a = 1;\n```';
      expect(formatSuggestionBlock(alreadySuggestion)).toBe('```suggestion\nconst a = 1;\n```\n');
    });

    it('5.3 preserves internal backticks in template literals', () => {
      const codeWithBackticks = 'const msg = `User: ${name}`;';
      const formatted = formatSuggestionBlock(codeWithBackticks);
      expect(formatted).toBe('```suggestion\nconst msg = `User: ${name}`;\n```\n');
    });

    it('5.4 preserves internal blank lines while trimming outer blank lines', () => {
      const codeWithInternalBlanks = '\n\nconst x = 1;\n\nconst y = 2;\n\n';
      const formatted = formatSuggestionBlock(codeWithInternalBlanks);
      expect(formatted).toBe('```suggestion\nconst x = 1;\n\nconst y = 2;\n```\n');
    });
  });

  describe('6. 422 Line Resolution Fallback Table Resiliency', () => {
    it('6.1 formatInlineFindingsFallbackTable escapes pipe characters in titles and actions', () => {
      const inlineComments: PublishInlineCommentRequest[] = [
        {
          owner: 'test-org',
          repo: 'test-repo',
          prNumber: 10,
          commitSha: 'sha',
          path: 'src/regex.ts',
          line: 25,
          startLine: 20,
          finding: {
            persona: 'security',
            severity: 'critical',
            filePath: 'src/regex.ts',
            lineNumber: 25,
            startLine: 20,
            title: 'Pattern A | Pattern B conflict',
            comment: 'Conflict detected',
            recommendation: 'Use (A|B) grouping carefully | Avoid backtracking',
          },
        },
      ];

      const table = formatInlineFindingsFallbackTable(inlineComments);
      expect(table).toContain('Pattern A \\| Pattern B conflict');
      expect(table).toContain('Use (A\\|B) grouping carefully \\| Avoid backtracking');
      expect(table).toContain('`src/regex.ts:20-25`');
    });

    it('6.2 formatInlineFindingsFallbackTable replaces newlines with <br/> in recommended action', () => {
      const inlineComments: PublishInlineCommentRequest[] = [
        {
          owner: 'test-org',
          repo: 'test-repo',
          prNumber: 10,
          commitSha: 'sha',
          path: 'src/app.ts',
          line: 5,
          finding: {
            persona: 'style',
            severity: 'minor',
            filePath: 'src/app.ts',
            lineNumber: 5,
            title: 'Multi-line action',
            comment: 'Finding comment',
            recommendation: 'Line 1\nLine 2\nLine 3',
          },
        },
      ];

      const table = formatInlineFindingsFallbackTable(inlineComments);
      expect(table).toContain('Line 1<br/>Line 2<br/>Line 3');
    });
  });
});

  describe('7. End-to-End Review Publication Fallbacks & Idempotency', () => {

    it('7.1 returns early when existing review with idempotency marker is detected', async () => {
      let fetchCallCount = 0;
      let reviewPosted = false;

      const fetchImpl = vi.fn().mockImplementation(async (url: string, init: any) => {
        fetchCallCount++;
        if (init.method === 'GET' && url.includes('/pulls/42/reviews')) {
          return new Response(JSON.stringify([
            {
              id: 9999,
              body: 'Previous review\n<!-- ct-review-bot:v1:test-org/test-repo#42:c0ffee:idemp-123 -->',
            },
          ]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (init.method === 'POST') {
          reviewPosted = true;
          return new Response(JSON.stringify({ id: 10000 }), { status: 200 });
        }
        return new Response(JSON.stringify([]), { status: 200 });
      });

      const publisher = new CommentPublisher({
        githubToken: 'ghs_test_token',
        fetchImplementation: fetchImpl,
        maxRetries: 0,
      });

      const result = await publisher.publishReview({
        owner: 'test-org',
        repo: 'test-repo',
        prNumber: 42,
        commitSha: 'c0ffee',
        event: 'COMMENT',
        body: 'Review summary',
        idempotencyKey: 'idemp-123',
      });

      expect(result.success).toBe(true);
      expect(result.reviewId).toBe(9999);
      expect(result.commentsCreated).toBe(0);
      expect(reviewPosted).toBe(false);
    });

    it('7.2 falls back to issue comment when GitHub API returns "Can not approve your own pull request"', async () => {
      let postedIssueCommentBody = '';

      const fetchImpl = vi.fn().mockImplementation(async (url: string, init: any) => {
        if (url.includes('/pulls/77/reviews') && init.method === 'POST') {
          return new Response('{"message":"Unprocessable Entity","errors":["Can not approve your own pull request"]}', {
            status: 422,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/issues/77/comments') && init.method === 'POST') {
          const bodyObj = JSON.parse(init.body);
          postedIssueCommentBody = bodyObj.body;
          return new Response(JSON.stringify({ id: 8888 }), {
            status: 201,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify([]), { status: 200 });
      });

      const publisher = new CommentPublisher({
        githubToken: 'ghs_test_token',
        fetchImplementation: fetchImpl,
        maxRetries: 0,
      });

      const result = await publisher.publishReview({
        owner: 'test-org',
        repo: 'test-repo',
        prNumber: 77,
        commitSha: 'c0ffee77',
        event: 'APPROVE',
        body: 'Approved by bot',
      });

      expect(result.success).toBe(true);
      expect(postedIssueCommentBody).toContain('Approved by bot');
    });

    it('7.3 handles 422 diff resolution error by combining review body and fallback table seamlessly', async () => {
      let callIndex = 0;
      let secondPayload: any = null;

      const fetchImpl = vi.fn().mockImplementation(async (url: string, init: any) => {
        callIndex++;
        if (callIndex === 1) {
          return new Response('{"message":"Validation Failed","errors":["Line could not be resolved in diff"]}', {
            status: 422,
            headers: { 'content-type': 'application/json' },
          });
        }
        secondPayload = JSON.parse(init.body);
        return new Response(JSON.stringify({ id: 5555, comments: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });

      const publisher = new CommentPublisher({
        githubToken: 'ghs_test_token',
        fetchImplementation: fetchImpl,
        maxRetries: 0,
      });

      const inlineComments: PublishInlineCommentRequest[] = [
        {
          owner: 'test-org',
          repo: 'test-repo',
          prNumber: 99,
          commitSha: 'sha99',
          path: 'src/config/env.ts',
          line: 30,
          startLine: 20,
          finding: {
            persona: 'security',
            severity: 'critical',
            filePath: 'src/config/env.ts',
            lineNumber: 30,
            startLine: 20,
            title: 'Exposed Database Secret',
            comment: 'Never hardcode DB credentials in repository code.',
            suggestion: 'const dbUrl = process.env.DATABASE_URL;',
          },
        },
        {
          owner: 'test-org',
          repo: 'test-repo',
          prNumber: 99,
          commitSha: 'sha99',
          path: 'src/models/user.ts',
          line: 15,
          finding: {
            persona: 'architecture',
            severity: 'major',
            filePath: 'src/models/user.ts',
            lineNumber: 15,
            isArchitectural: true,
            title: 'Circular Dependency with AccountModel',
            comment: 'Decouple User and Account through event bus.',
            recommendation: 'Emit UserCreatedDomainEvent rather than calling AccountModel directly.',
          },
        },
      ];

      const result = await publisher.publishReview({
        owner: 'test-org',
        repo: 'test-repo',
        prNumber: 99,
        commitSha: 'sha99',
        event: 'COMMENT',
        body: 'Final review verdict: SHIP_WITH_ADVICE',
        inlineComments,
      });

      expect(result.success).toBe(true);
      expect(result.commentsCreated).toBe(0);
      expect(callIndex).toBe(2);
      expect(secondPayload.comments).toBeUndefined();
      expect(secondPayload.body).toContain('Final review verdict: SHIP_WITH_ADVICE');
      expect(secondPayload.body).toContain('### 📝 Actionable Findings (Diff Line Resolution Fallback)');
      expect(secondPayload.body).toContain('| **CRITICAL** | `src/config/env.ts:20-30` | Exposed Database Secret | const dbUrl = process.env.DATABASE_URL; |');
      expect(secondPayload.body).toContain('| **MAJOR** | `src/models/user.ts:15` | Circular Dependency with AccountModel | Emit UserCreatedDomainEvent rather than calling AccountModel directly. |');
      expect(secondPayload.body).not.toContain('```suggestion');
    });
  });
