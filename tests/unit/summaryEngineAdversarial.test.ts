import { describe, it, expect } from 'vitest';
import { generatePRSummary, formatAdversarialMatrix, escapeMarkdownTableCell } from '../../src/review/summaryEngine';
import { PersonaFinding } from '../../src/github/commentPublisher';
import { PanelResult } from '../../src/panel/panelEngine';

describe('summaryEngineAdversarial.test.ts — Requirement R3 Adversarial Matrix Tests', () => {
  const sampleDiff = `
diff --git a/src/db/query.ts b/src/db/query.ts
index 1111111..2222222 100644
--- a/src/db/query.ts
+++ b/src/db/query.ts
@@ -40,3 +40,5 @@
+ export function runRawQuery(userInput: string) {
+   return db.query("SELECT * FROM users WHERE name = " + userInput);
+ }
`;

  it('renders the collapsible Adversarial Attack & Defense Matrix block', () => {
    const summary = generatePRSummary(sampleDiff, []);

    expect(summary).toContain('<details>');
    expect(summary).toContain('<summary><strong>🧬 Adversarial Attack & Defense Matrix</strong></summary>');
    expect(summary).toContain('### 🛡️ Red-Team Cross-Examination Audit');
    expect(summary).toContain('**Status**: 🧬 Active');
    expect(summary).toContain('</details>');
  });

  it('formats table columns and rows when Red-Team attack vectors exist', () => {
    const redTeamFindings: PersonaFinding[] = [
      {
        persona: 'red_team',
        isRedTeam: true,
        crossExaminedModel: 'gpt-5.6-sol',
        filePath: 'src/db/query.ts',
        lineNumber: 42,
        severity: 'critical',
        attackVector: 'SQL Injection Vulnerability',
        failureMode: 'Unsanitized user inputs in query string allow arbitrary SQL execution.',
        mitigation: 'Enforce parameterized queries using query builder.',
        comment: 'Raw query concatenation vulnerable to SQL injection',
      },
    ];

    const matrix = formatAdversarialMatrix(redTeamFindings);

    expect(matrix).toContain('| Persona / Model | Attack Vector / Target | Severity | Potential Failure Mode | Mitigation Recommendation |');
    expect(matrix).toContain('|---|---|---|---|---|');
    expect(matrix).toContain('`red_team` (`gpt-5.6-sol`)');
    expect(matrix).toContain('**SQL Injection Vulnerability**<br>`src/db/query.ts:42`');
    expect(matrix).toContain('`CRITICAL`');
    expect(matrix).toContain('Unsanitized user inputs in query string allow arbitrary SQL execution.');
    expect(matrix).toContain('Enforce parameterized queries using query builder.');
  });

  it('outputs zero-findings statement when no red-team attack vectors exist', () => {
    const matrix = formatAdversarialMatrix([]);

    expect(matrix).toContain('All persona checks and dual-model cross-examinations passed. Zero adversarial attack vectors or failure modes were detected in this pull request.');
    expect(matrix).not.toContain('| Persona / Model | Attack Vector / Target |');
  });

  it('handles PanelResult parameters and cross-examined model info (gpt-5.6-sol, deepseek-v4-pro)', () => {
    const mockPanelResult: PanelResult = {
      headSha: 'abc1234',
      personas: [
        {
          id: 'red_team',
          required: true,
          providerId: 'openai',
          model: 'gpt-5.6-sol',
          crossExaminedModel: 'deepseek-v4-pro',
          isRedTeam: true,
          decision: 'FINDINGS',
          usage: null,
          costUSD: null,
          durationMs: 150,
          findings: [
            {
              severity: 'P0',
              path: 'src/db/query.ts',
              line: 42,
              title: 'Command Injection Danger',
              body: 'Unfiltered input passed to exec()',
              recommendation: 'Use execFile with argument array',
            },
          ],
        },
      ],
      optionalFailures: [],
      quorum: { required: 1, distinctProviders: ['openai'], satisfied: true },
      moderator: {
        providerId: 'openai',
        model: 'gpt-5.6-sol',
        decision: 'RECONCILED',
        findings: [],
        usage: null,
        costUSD: null,
        durationMs: 100,
      },
      arbiter: {
        providerId: 'openai',
        model: 'gpt-5.6-sol',
        verdict: 'FIX_FIRST',
        rationale: 'Critical security issue',
        usage: null,
        costUSD: null,
        durationMs: 100,
      },
    };

    const summary = generatePRSummary(sampleDiff, [], mockPanelResult);

    expect(summary).toContain('`gpt-5.6-sol`');
    expect(summary).toContain('`deepseek-v4-pro`');
    expect(summary).toContain('`red_team` (`deepseek-v4-pro`)');
    expect(summary).toContain('**Command Injection Danger**<br>`src/db/query.ts:42`');
    expect(summary).toContain('`P0`');
    expect(summary).toContain('Unfiltered input passed to exec()');
    expect(summary).toContain('Use execFile with argument array');
  });

  it('maintains backward compatibility with standard PR summaries', () => {
    const standardFindings: PersonaFinding[] = [
      {
        persona: 'code-style',
        severity: 'minor',
        filePath: 'src/db/query.ts',
        lineNumber: 10,
        comment: 'Consider adding return type annotation',
      },
    ];

    const summary = generatePRSummary(sampleDiff, standardFindings);

    expect(summary).toContain('## Executive Overview');
    expect(summary).toContain('## Walkthrough');
    expect(summary).toContain('## Changesets');
    expect(summary).toContain('🧬 Adversarial Attack & Defense Matrix');
    expect(summary).toContain('All persona checks and dual-model cross-examinations passed.');
  });

  it('handles findings with missing title and body without throwing', () => {
    const mockPanelResult: PanelResult = {
      headSha: 'abc1234',
      personas: [
        {
          id: 'red_team',
          required: true,
          providerId: 'openai',
          model: 'gpt-5.6-sol',
          isRedTeam: true,
          decision: 'FINDINGS',
          usage: null,
          costUSD: null,
          durationMs: 150,
          findings: [
            {
              severity: 'P0',
              path: 'src/db/query.ts',
              line: 42,
            } as any,
          ],
        },
      ],
      optionalFailures: [],
      quorum: { required: 1, distinctProviders: ['openai'], satisfied: true },
      moderator: {
        providerId: 'openai',
        model: 'gpt-5.6-sol',
        decision: 'RECONCILED',
        findings: [],
        usage: null,
        costUSD: null,
        durationMs: 100,
      },
      arbiter: {
        providerId: 'openai',
        model: 'gpt-5.6-sol',
        verdict: 'FIX_FIRST',
        rationale: 'Critical security issue',
        usage: null,
        costUSD: null,
        durationMs: 100,
      },
    };

    expect(() => formatAdversarialMatrix([], mockPanelResult)).not.toThrow();
    const matrix = formatAdversarialMatrix([], mockPanelResult);
    expect(matrix).toContain('Adversarial Vulnerability');
    expect(matrix).toContain('`src/db/query.ts:42`');
  });

  it('renders panelResult findings when generatePRSummary is called with (diff, findings, config, panelResult)', () => {
    const mockConfig = {
      version: '3',
      personas: [{ id: 'red_team', name: 'Red Team Persona' }],
    };

    const mockPanelResult: PanelResult = {
      headSha: 'sha999',
      personas: [
        {
          id: 'red_team',
          required: true,
          providerId: 'openai',
          model: 'gpt-5.6-sol',
          isRedTeam: true,
          decision: 'FINDINGS',
          usage: null,
          costUSD: null,
          durationMs: 150,
          findings: [
            {
              severity: 'P0',
              path: 'src/auth/jwt.ts',
              line: 15,
              title: 'JWT Secret Hardcoded',
              body: 'Secret key is stored in source repository',
              recommendation: 'Use environment secret manager',
            },
          ],
        },
      ],
      optionalFailures: [],
      quorum: { required: 1, distinctProviders: ['openai'], satisfied: true },
      moderator: {
        providerId: 'openai',
        model: 'gpt-5.6-sol',
        decision: 'RECONCILED',
        findings: [],
        usage: null,
        costUSD: null,
        durationMs: 100,
      },
      arbiter: {
        providerId: 'openai',
        model: 'gpt-5.6-sol',
        verdict: 'FIX_FIRST',
        rationale: 'Critical security issue',
        usage: null,
        costUSD: null,
        durationMs: 100,
      },
    };

    const summary = generatePRSummary(sampleDiff, [], mockConfig, mockPanelResult);

    expect(summary).toContain('JWT Secret Hardcoded');
    expect(summary).toContain('`src/auth/jwt.ts:15`');
    expect(summary).toContain('Secret key is stored in source repository');
  });

  it('safely ignores null or falsy array items in personas and findings', () => {
    const panelResultWithNulls: PanelResult = {
      headSha: 'shaNull',
      personas: [
        null as any,
        undefined as any,
        {
          id: 'red_team',
          required: true,
          providerId: 'openai',
          model: 'gpt-5.6-sol',
          isRedTeam: true,
          decision: 'FINDINGS',
          usage: null,
          costUSD: null,
          durationMs: 150,
          findings: [
            null as any,
            undefined as any,
            {
              severity: 'P1',
              path: 'src/util/parser.ts',
              line: 88,
              title: 'ReDoS Regex Risk',
              body: 'Catastrophic backtracking in regex pattern',
            },
          ],
        },
      ],
      optionalFailures: [],
      quorum: { required: 1, distinctProviders: ['openai'], satisfied: true },
      moderator: {
        providerId: 'openai',
        model: 'gpt-5.6-sol',
        decision: 'RECONCILED',
        findings: [],
        usage: null,
        costUSD: null,
        durationMs: 100,
      },
      arbiter: {
        providerId: 'openai',
        model: 'gpt-5.6-sol',
        verdict: 'FIX_FIRST',
        rationale: 'Critical security issue',
        usage: null,
        costUSD: null,
        durationMs: 100,
      },
    };

    const findingsWithNulls: PersonaFinding[] = [null as any, undefined as any];

    expect(() => formatAdversarialMatrix(findingsWithNulls, panelResultWithNulls)).not.toThrow();
    const matrix = formatAdversarialMatrix(findingsWithNulls, panelResultWithNulls);
    expect(matrix).toContain('ReDoS Regex Risk');
    expect(matrix).toContain('`src/util/parser.ts:88`');
  });

  it('escapes pipe characters and HTML tags in table cell content to prevent breakout', () => {
    const redTeamFindings: PersonaFinding[] = [
      {
        persona: 'red_team',
        isRedTeam: true,
        crossExaminedModel: 'gpt-5.6-sol',
        filePath: 'src/db/query.ts',
        lineNumber: 42,
        severity: 'critical',
        comment: 'Cross-examination surfaced an unsafe query construction path.',
        attackVector: 'SQLi | RCE Injection <script>alert(1)</script>',
        failureMode: '<!-- comment --> </details>\nBroken pipe | in failure mode',
        mitigation: 'Sanitize | Escape <input> tags',
      },
    ];

    const matrix = formatAdversarialMatrix(redTeamFindings);

    expect(matrix).toContain('SQLi \\| RCE Injection &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(matrix).toContain('&lt;!-- comment --&gt; &lt;/details&gt;');
    expect(matrix).toContain('Broken pipe \\| in failure mode');
    expect(matrix).toContain('Sanitize \\| Escape &lt;input&gt; tags');

    const lines = matrix.split('\n');
    const dataRow = lines.find((l) => l.includes('SQLi'));
    expect(dataRow).toBeDefined();

    const unescapedPipes = dataRow!.match(/(?<!\\)\|/g);
    expect(unescapedPipes?.length).toBe(6);
  });

  it('escapes pipe, newline, and HTML bracket characters using escapeMarkdownTableCell', () => {
    const text = 'Line1\r\nLine2\nOption A | Option B <details></details>';
    const result = escapeMarkdownTableCell(text);
    expect(result).toBe('Line1 Line2 Option A \\| Option B &lt;details&gt;&lt;/details&gt;');
  });
});

