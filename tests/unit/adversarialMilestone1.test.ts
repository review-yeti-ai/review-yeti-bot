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
import { validateFindings, PanelFinding } from '../../src/panel/panelEngine';

describe('Adversarial Stress Suite: Native Suggestion Diffs & Fallbacks (Milestone 1)', () => {

  describe('1. Malformed Code Snippets and Fence Stripping', () => {
    it('strips language fences with non-alphanumeric characters (C++, C#, F#)', () => {
      const cppCode = '```c++\nvoid process(int* ptr);\n```';
      const resultCpp = formatSuggestionBlock(cppCode);
      expect(resultCpp).toBe('```suggestion\nvoid process(int* ptr);\n```\n');
      expect(resultCpp).not.toContain('++');

      const csharpCode = '```c#\npublic void Run() {}\n```';
      const resultCs = formatSuggestionBlock(csharpCode);
      expect(resultCs).toBe('```suggestion\npublic void Run() {}\n```\n');
      expect(resultCs).not.toContain('#');
    });

    it('strips language fences with info strings or annotations (e.g. filename, highlights)', () => {
      const annotatedCode = '```ts filename="service.ts"\nconst timeout = 5000;\n```';
      const result = formatSuggestionBlock(annotatedCode);
      expect(result).toBe('```suggestion\nconst timeout = 5000;\n```\n');
      expect(result).not.toContain('filename=');
    });

    it('handles code already containing ```suggestion without nesting or duplicating', () => {
      const alreadySuggestion = '```suggestion\nconst answer = 42;\n```';
      const result = formatSuggestionBlock(alreadySuggestion);
      expect(result).toBe('```suggestion\nconst answer = 42;\n```\n');
      expect((result.match(/```suggestion/g) || []).length).toBe(1);
      expect((result.match(/```/g) || []).length).toBe(2);
    });

    it('handles code with 4 or more backtick fences', () => {
      const fourBackticks = '````typescript\nconst multiFence = 100;\n````';
      const result = formatSuggestionBlock(fourBackticks);
      // Either stripped cleanly or safely enclosed
      expect(result).toContain('const multiFence = 100;');
    });

    it('handles code with inner backticks or template literals cleanly', () => {
      const templateLiteral = 'const greeting = `Hello ${user.name}`;';
      const result = formatSuggestionBlock(templateLiteral);
      expect(result).toBe('```suggestion\nconst greeting = `Hello ${user.name}`;\n```\n');
    });

    it('handles empty or whitespace-only code gracefully', () => {
      const emptyCode = '';
      const resultEmpty = formatSuggestionBlock(emptyCode);
      expect(resultEmpty).toBe('```suggestion\n\n```\n');

      const whitespaceCode = '   \n\n  \t  \n';
      const resultWs = formatSuggestionBlock(whitespaceCode);
      expect(resultWs).toBe('```suggestion\n\n```\n');
    });

    it('handles unclosed code fence from LLM output', () => {
      const unclosed = '```typescript\nconst broken = true;';
      const result = formatSuggestionBlock(unclosed);
      expect(result).toContain('const broken = true;');
      expect(result.startsWith('```suggestion\n')).toBe(true);
      expect(result.endsWith('```\n')).toBe(true);
    });
  });

  describe('2. Tricky Line Ranges and Negative/Zero/Inverted Line Numbers', () => {
    it('omits start_line when start_line is 0 (zero is invalid in GitHub API 1-based indexing)', async () => {
      let capturedPayload: any = null;
      const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: any) => {
        capturedPayload = JSON.parse(init.body);
        return new Response(JSON.stringify({ id: 101 }), { status: 200, headers: { 'content-type': 'application/json' } });
      });

      const publisher = new CommentPublisher({
        githubToken: 'ghs_mock_token',
        fetchImplementation: fetchImpl,
        maxRetries: 0,
      });

      await publisher.publishReview({
        owner: 'test-org',
        repo: 'test-repo',
        prNumber: 1,
        commitSha: 'a1b2c3d4e5f67890123456789012345678901234',
        event: 'COMMENT',
        body: 'Review body',
        inlineComments: [
          {
            owner: 'test-org',
            repo: 'test-repo',
            prNumber: 1,
            commitSha: 'a1b2c3d4e5f67890123456789012345678901234',
            path: 'src/index.ts',
            line: 10,
            startLine: 0,
            finding: {
              persona: 'correctness',
              severity: 'P1',
              filePath: 'src/index.ts',
              lineNumber: 10,
              startLine: 0,
              comment: 'Issue at line 10',
              suggestion: 'const x = 1;',
            },
          },
        ],
      });

      expect(capturedPayload.comments[0].line).toBe(10);
      // start_line MUST NOT be 0 because GitHub rejects line 0
      expect(capturedPayload.comments[0].start_line).toBeUndefined();
    });

    it('omits start_line when start_line is negative (e.g. -5)', async () => {
      let capturedPayload: any = null;
      const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: any) => {
        capturedPayload = JSON.parse(init.body);
        return new Response(JSON.stringify({ id: 102 }), { status: 200, headers: { 'content-type': 'application/json' } });
      });

      const publisher = new CommentPublisher({
        githubToken: 'ghs_mock_token',
        fetchImplementation: fetchImpl,
        maxRetries: 0,
      });

      await publisher.publishReview({
        owner: 'test-org',
        repo: 'test-repo',
        prNumber: 1,
        commitSha: 'a1b2c3d4e5f67890123456789012345678901234',
        event: 'COMMENT',
        body: 'Review body',
        inlineComments: [
          {
            owner: 'test-org',
            repo: 'test-repo',
            prNumber: 1,
            commitSha: 'a1b2c3d4e5f67890123456789012345678901234',
            path: 'src/index.ts',
            line: 10,
            startLine: -5,
            finding: {
              persona: 'correctness',
              severity: 'P1',
              filePath: 'src/index.ts',
              lineNumber: 10,
              startLine: -5,
              comment: 'Negative line issue',
              suggestion: 'const x = 1;',
            },
          },
        ],
      });

      expect(capturedPayload.comments[0].line).toBe(10);
      // start_line MUST NOT be negative because GitHub rejects negative lines
      expect(capturedPayload.comments[0].start_line).toBeUndefined();
    });

    it('omits start_line when start_line > line (inverted range)', async () => {
      let capturedPayload: any = null;
      const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: any) => {
        capturedPayload = JSON.parse(init.body);
        return new Response(JSON.stringify({ id: 103 }), { status: 200, headers: { 'content-type': 'application/json' } });
      });

      const publisher = new CommentPublisher({
        githubToken: 'ghs_mock_token',
        fetchImplementation: fetchImpl,
        maxRetries: 0,
      });

      await publisher.publishReview({
        owner: 'test-org',
        repo: 'test-repo',
        prNumber: 1,
        commitSha: 'a1b2c3d4e5f67890123456789012345678901234',
        event: 'COMMENT',
        body: 'Review body',
        inlineComments: [
          {
            owner: 'test-org',
            repo: 'test-repo',
            prNumber: 1,
            commitSha: 'a1b2c3d4e5f67890123456789012345678901234',
            path: 'src/index.ts',
            line: 10,
            startLine: 50,
            finding: {
              persona: 'correctness',
              severity: 'P1',
              filePath: 'src/index.ts',
              lineNumber: 10,
              startLine: 50,
              comment: 'Inverted range',
              suggestion: 'const x = 1;',
            },
          },
        ],
      });

      expect(capturedPayload.comments[0].line).toBe(10);
      expect(capturedPayload.comments[0].start_line).toBeUndefined();
    });

    it('formatFindingFallbackTable does not render inverted range when startLine > lineNumber', () => {
      const finding: PersonaFinding = {
        persona: 'architecture',
        severity: 'P1',
        filePath: 'src/index.ts',
        lineNumber: 10,
        startLine: 50, // inverted!
        title: 'Inverted line test',
        comment: 'Some comment',
        recommendation: 'Fix it',
      };

      const table = formatFindingFallbackTable(finding);
      // Location should NOT be 50-10
      expect(table).not.toContain('`src/index.ts:50-10`');
      expect(table).toContain('`src/index.ts:10`');
    });

    it('handles very large line numbers (e.g. 1000000)', async () => {
      let capturedPayload: any = null;
      const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: any) => {
        capturedPayload = JSON.parse(init.body);
        return new Response(JSON.stringify({ id: 104 }), { status: 200, headers: { 'content-type': 'application/json' } });
      });

      const publisher = new CommentPublisher({
        githubToken: 'ghs_mock_token',
        fetchImplementation: fetchImpl,
        maxRetries: 0,
      });

      await publisher.publishReview({
        owner: 'test-org',
        repo: 'test-repo',
        prNumber: 1,
        commitSha: 'a1b2c3d4e5f67890123456789012345678901234',
        event: 'COMMENT',
        body: 'Review body',
        inlineComments: [
          {
            owner: 'test-org',
            repo: 'test-repo',
            prNumber: 1,
            commitSha: 'a1b2c3d4e5f67890123456789012345678901234',
            path: 'src/big.ts',
            line: 1000010,
            startLine: 1000000,
            finding: {
              persona: 'performance',
              severity: 'P2',
              filePath: 'src/big.ts',
              lineNumber: 1000010,
              startLine: 1000000,
              comment: 'Big file issue',
              suggestion: 'const y = 2;',
            },
          },
        ],
      });

      expect(capturedPayload.comments[0].line).toBe(1000010);
      expect(capturedPayload.comments[0].start_line).toBe(1000000);
    });

    it('validateFindings filters out invalid start_line (zero and negative)', () => {
      const rawFindings = [
        {
          severity: 'P1',
          path: 'src/a.ts',
          line: 10,
          start_line: 0,
          title: 'Zero line',
          body: 'body',
        },
        {
          severity: 'P1',
          path: 'src/b.ts',
          line: 20,
          start_line: -5,
          title: 'Negative line',
          body: 'body',
        },
        {
          severity: 'P1',
          path: 'src/c.ts',
          line: 30,
          start_line: 25,
          title: 'Valid line',
          body: 'body',
        },
      ];

      const validated = validateFindings(rawFindings);
      expect(validated[0].startLine).toBeUndefined();
      expect(validated[1].startLine).toBeUndefined();
      expect(validated[2].startLine).toBe(25);
    });
  });

  describe('3. Multi-Option Fixes (fixOptions) Ranking and Truncation', () => {
    it('sorts fixOptions by rank before formatting and presents Rank #1 first even if passed out of order', () => {
      const finding: PersonaFinding = {
        persona: 'security',
        severity: 'P1',
        filePath: 'src/auth.ts',
        lineNumber: 15,
        title: 'Weak Hashing',
        comment: 'MD5 is insecure.',
        fixOptions: [
          { rank: 2, title: 'SHA-256', suggestionCode: 'const h = crypto.createHash("sha256");' },
          { rank: 1, title: 'Argon2id', suggestionCode: 'const h = await argon2.hash(pwd);' },
          { rank: 3, title: 'PBKDF2', suggestionCode: 'const h = crypto.pbkdf2Sync(...);' },
        ],
      };

      const body = formatInlineCommentBody(finding);

      // Rank #1 (Argon2id) MUST appear first before Rank #2 (SHA-256)
      const rank1Index = body.indexOf('Option 1: Argon2id (Rank #1)');
      const rank2Index = body.indexOf('Option 2: SHA-256 (Rank #2)');

      expect(rank1Index).toBeGreaterThan(-1);
      expect(rank2Index).toBeGreaterThan(-1);
      expect(rank1Index).toBeLessThan(rank2Index);

      // Rank #3 must be truncated out (only max 2 options)
      expect(body).not.toContain('Rank #3');
      expect(body).not.toContain('PBKDF2');
    });

    it('preserves top 2 ranked options when passed with reverse ranks [3, 2, 1]', () => {
      const finding: PersonaFinding = {
        persona: 'perf',
        severity: 'P2',
        filePath: 'src/db.ts',
        lineNumber: 80,
        title: 'Unindexed query',
        comment: 'Add index.',
        fixOptions: [
          { rank: 3, title: 'In-memory filter', suggestionCode: 'rows.filter(...);' },
          { rank: 2, title: 'Composite index', suggestionCode: 'CREATE INDEX idx_a_b;' },
          { rank: 1, title: 'Single index', suggestionCode: 'CREATE INDEX idx_a;' },
        ],
      };

      const body = formatInlineCommentBody(finding);

      // Should keep rank 1 and rank 2, discarding rank 3
      expect(body).toContain('Single index');
      expect(body).toContain('Composite index');
      expect(body).not.toContain('In-memory filter');
    });

    it('formatInlineFindingsFallbackTable selects Rank #1 option when fixOptions are passed out of order', () => {
      const inlineComments: PublishInlineCommentRequest[] = [
        {
          owner: 'test',
          repo: 'test',
          prNumber: 1,
          commitSha: 'abcdef1234567890123456789012345678901234',
          path: 'src/auth.ts',
          line: 15,
          finding: {
            persona: 'security',
            severity: 'P1',
            filePath: 'src/auth.ts',
            lineNumber: 15,
            comment: 'Use modern hash.',
            fixOptions: [
              { rank: 2, title: 'SHA-256', suggestionCode: 'const h = sha256();' },
              { rank: 1, title: 'Argon2id', suggestionCode: 'const h = argon2();' },
            ],
          },
        },
      ];

      const table = formatInlineFindingsFallbackTable(inlineComments);
      // Fallback table Recommended Action should pick rank 1, not rank 2
      expect(table).toContain('const h = argon2();');
    });

    it('handles fixOption without suggestionCode cleanly', () => {
      const finding: PersonaFinding = {
        persona: 'architecture',
        severity: 'P1',
        filePath: 'src/service.ts',
        lineNumber: 40,
        title: 'Coupled service',
        comment: 'Decouple dependencies.',
        fixOptions: [
          { rank: 1, title: 'Dependency injection', explanation: 'Pass repository via constructor.' },
        ],
      };

      const body = formatInlineCommentBody(finding);
      expect(body).toContain('#### Option 1: Dependency injection (Rank #1)');
      expect(body).toContain('Pass repository via constructor.');
      expect(body).not.toContain('```suggestion');
    });
  });

  describe('4. Architectural Findings and Suggestion Fallback', () => {
    it('forces fallback table when isArchitectural: true even if suggestion is present', () => {
      const finding: PersonaFinding = {
        persona: 'architecture',
        severity: 'P1',
        filePath: 'src/core.ts',
        lineNumber: 100,
        startLine: 90,
        isArchitectural: true,
        title: 'Violates Layered Architecture',
        comment: 'Controller directly queries database table.',
        suggestion: 'Move DB query to UserRepository layer.',
      };

      const body = formatInlineCommentBody(finding);

      expect(body).not.toContain('```suggestion');
      expect(body).toContain('| Severity | Location | Finding | Recommended Action |');
      expect(body).toContain('| **P1** | `src/core.ts:90-100` | Violates Layered Architecture | Move DB query to UserRepository layer. |');
    });

    it('forces fallback table when isArchitectural: true even if fixOptions has suggestionCode', () => {
      const finding: PersonaFinding = {
        persona: 'architecture',
        severity: 'P0',
        filePath: 'src/app.ts',
        lineNumber: 50,
        isArchitectural: true,
        title: 'Architectural redesign required',
        comment: 'Stateful singleton cannot scale across pods.',
        fixOptions: [
          { rank: 1, title: 'Use Redis', suggestionCode: 'const redis = new Redis();' },
        ],
      };

      const body = formatInlineCommentBody(finding);

      // Architectural findings should not emit inline 1-click suggestion fences
      expect(body).not.toContain('```suggestion');
      expect(body).toContain('| Severity | Location | Finding | Recommended Action |');
    });

    it('renders fallback table when suggestion is empty string', () => {
      const finding: PersonaFinding = {
        persona: 'security',
        severity: 'P1',
        filePath: 'src/env.ts',
        lineNumber: 12,
        title: 'Secret exposed',
        comment: 'Do not commit secrets to repo.',
        suggestion: '',
        recommendation: 'Use GitHub Actions secrets or HashiCorp Vault.',
      };

      const body = formatInlineCommentBody(finding);

      expect(body).not.toContain('```suggestion');
      expect(body).toContain('| Severity | Location | Finding | Recommended Action |');
      expect(body).toContain('Use GitHub Actions secrets or HashiCorp Vault.');
    });

    it('renders fallback table when suggestion is undefined and codeSnippet is undefined', () => {
      const finding: PersonaFinding = {
        persona: 'correctness',
        severity: 'P2',
        filePath: 'src/calc.ts',
        lineNumber: 33,
        title: 'Precision loss',
        comment: 'Floating point arithmetic can lose precision.',
        recommendation: 'Use Decimal or BigInt for monetary calculations.',
      };

      const body = formatInlineCommentBody(finding);

      expect(body).not.toContain('```suggestion');
      expect(body).toContain('| Severity | Location | Finding | Recommended Action |');
      expect(body).toContain('Use Decimal or BigInt for monetary calculations.');
    });

    it('escapes pipes and handles multiline comments and actions in tables without breaking markdown columns', () => {
      const finding: PersonaFinding = {
        persona: 'security',
        severity: 'P0',
        filePath: 'src/pipe.ts',
        lineNumber: 1,
        title: 'Regex hazard | cat | dog',
        comment: 'First line\nSecond line\nThird line | with pipes',
        recommendation: 'Action line 1\nAction line 2 | with pipes',
      };

      const table = formatFindingFallbackTable(finding);
      const lines = table.split('\n');
      expect(lines).toHaveLength(3); // header, divider, 1 data row
      const dataRow = lines[2];
      // Every pipe except the column separators must be escaped
      // The row should have exactly 4 columns -> 5 '|' characters (leading, 3 between, trailing)
      const unescapedPipes = dataRow.split(/(?<!\\)\|/g).length - 1;
      expect(unescapedPipes).toBe(5);
    });
  });

  describe('5. HTTP 422 Simulation and Fallback Handling', () => {
    it('retries with fallback table when GitHub API returns HTTP 422 Unprocessable Entity', async () => {
      let callCount = 0;
      let firstPayload: any = null;
      let secondPayload: any = null;

      const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: any) => {
        callCount++;
        if (callCount === 1) {
          firstPayload = JSON.parse(init.body);
          return new Response(JSON.stringify({
            message: 'Unprocessable Entity',
            errors: ['Line 999 is outside diff hunk'],
          }), { status: 422, headers: { 'content-type': 'application/json' } });
        }
        secondPayload = JSON.parse(init.body);
        return new Response(JSON.stringify({ id: 9999, comments: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });

      const publisher = new CommentPublisher({
        githubToken: 'ghs_mock_token',
        fetchImplementation: fetchImpl,
        maxRetries: 0,
      });

      const result = await publisher.publishReview({
        owner: 'test-org',
        repo: 'test-repo',
        prNumber: 42,
        commitSha: '1234567890abcdef1234567890abcdef12345678',
        event: 'COMMENT',
        body: 'Initial review summary',
        inlineComments: [
          {
            owner: 'test-org',
            repo: 'test-repo',
            prNumber: 42,
            commitSha: '1234567890abcdef1234567890abcdef12345678',
            path: 'src/far_line.ts',
            line: 999,
            finding: {
              persona: 'security',
              severity: 'critical',
              filePath: 'src/far_line.ts',
              lineNumber: 999,
              title: 'Remote code execution',
              comment: 'eval() used on untrusted string',
              suggestion: 'JSON.parse(untrustedString);',
            },
          },
        ],
      });

      expect(result.success).toBe(true);
      expect(callCount).toBe(2);
      expect(firstPayload.comments).toHaveLength(1);
      expect(secondPayload.comments).toBeUndefined();
      expect(secondPayload.body).toContain('### 📝 Actionable Findings (Diff Line Resolution Fallback)');
      expect(secondPayload.body).toContain('| **CRITICAL** | `src/far_line.ts:999` | Remote code execution | JSON.parse(untrustedString); |');
      expect(secondPayload.body).not.toContain('```suggestion');
    });

    it('handles failure when the 422 fallback retry ALSO fails', async () => {
      const fetchImpl = vi.fn().mockImplementation(async () => {
        return new Response(JSON.stringify({
          message: 'Server error',
        }), { status: 422, headers: { 'content-type': 'application/json' } });
      });

      const publisher = new CommentPublisher({
        githubToken: 'ghs_mock_token',
        fetchImplementation: fetchImpl,
        maxRetries: 0,
      });

      const result = await publisher.publishReview({
        owner: 'test-org',
        repo: 'test-repo',
        prNumber: 42,
        commitSha: '1234567890abcdef1234567890abcdef12345678',
        event: 'COMMENT',
        body: 'Initial review summary',
        inlineComments: [
          {
            owner: 'test-org',
            repo: 'test-repo',
            prNumber: 42,
            commitSha: '1234567890abcdef1234567890abcdef12345678',
            path: 'src/a.ts',
            line: 10,
            finding: {
              persona: 'security',
              severity: 'critical',
              filePath: 'src/a.ts',
              lineNumber: 10,
              comment: 'fail',
            },
          },
        ],
      });

      expect(result.success).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors![0]).toContain('HTTP 422');
    });

    it('does not attempt 422 retry if there were no inlineComments to begin with', async () => {
      let callCount = 0;
      const fetchImpl = vi.fn().mockImplementation(async () => {
        callCount++;
        return new Response('Unprocessable Entity', { status: 422 });
      });

      const publisher = new CommentPublisher({
        githubToken: 'ghs_mock_token',
        fetchImplementation: fetchImpl,
        maxRetries: 0,
      });

      const result = await publisher.publishReview({
        owner: 'test-org',
        repo: 'test-repo',
        prNumber: 42,
        commitSha: '1234567890abcdef1234567890abcdef12345678',
        event: 'COMMENT',
        body: 'Just a summary',
        inlineComments: [],
      });

      expect(result.success).toBe(false);
      expect(callCount).toBe(1); // No retry
    });

    it('falls back to issue comment when review approval is blocked by self-approval error', async () => {
      let callCount = 0;
      let issueCommentPayload: any = null;

      const fetchImpl = vi.fn().mockImplementation(async (url: string, init: any) => {
        callCount++;
        if (url.includes('/reviews')) {
          return new Response(JSON.stringify({
            message: 'Unprocessable Entity',
            errors: ['Can not approve your own pull request'],
          }), { status: 422, headers: { 'content-type': 'application/json' } });
        }
        if (url.includes('/issues/')) {
          issueCommentPayload = JSON.parse(init.body);
          return new Response(JSON.stringify({ id: 555 }), { status: 201, headers: { 'content-type': 'application/json' } });
        }
        return new Response('Not Found', { status: 404 });
      });

      const publisher = new CommentPublisher({
        githubToken: 'ghs_mock_token',
        fetchImplementation: fetchImpl,
        maxRetries: 0,
      });

      const result = await publisher.publishReview({
        owner: 'test-org',
        repo: 'test-repo',
        prNumber: 99,
        commitSha: '1234567890abcdef1234567890abcdef12345678',
        event: 'APPROVE',
        body: 'Approved by AI reviewer',
        inlineComments: [],
      });

      expect(result.success).toBe(true);
      expect(result.reviewId).toBe(555);
      expect(issueCommentPayload).not.toBeNull();
      expect(issueCommentPayload.body).toContain('Approved by AI reviewer');
    });
  });
});
