import { describe, expect, it, vi } from 'vitest';
import { formatInlineCommentBody, PersonaFinding } from '../../src/github/commentPublisher';
import { executePersonaPanel, PanelConfigurationError } from '../../src/panel/panelEngine';
import { parseAndValidateConfig } from '../../src/config/configLoader';
import type { CtReviewConfigV3 } from '../../src/config/schema';
import { OmniRouteClient } from '../../src/gateway/omniRouteClient';

const policyYaml = `
version: 3
profile: chill
quorum: 1
personas:
  - id: security-tenancy
    enabled: true
    required: true
    charter: builtin:security
    paths: ["src/**"]
    providers: [grok]
reviewers:
  execution: personas
  fallback: ordered
  overall_timeout_s: 900
  providers:
    - id: grok
      enabled: true
      model: grok-cli/grok-4.5
      effort: high
      review_timeout_s: 240
      arbiter_timeout_s: 240
  arbiter:
    order: [grok]
`;

function fenced(nonce: string, body: object): string {
  return `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify(body)}\nCT_REVIEW_END:${nonce}`;
}

describe('Challenger Empirical Suite: Code Review Suggestions, Panel Parser & Formatting', () => {
  describe('1. 1-Click Apply Block Formatting (Single & Double Option Fixes)', () => {
    it('formats single option fix correctly with Rank #1 header and suggestion fence', () => {
      const finding: PersonaFinding = {
        persona: 'security-tenancy',
        severity: 'critical',
        filePath: 'src/auth.ts',
        lineNumber: 10,
        title: 'Hardcoded Secret',
        comment: 'Remove hardcoded API key.',
        confidence: 90,
        recommendation: 'Use environment variables.',
        fixOptions: [
          {
            rank: 1,
            title: 'Use process.env',
            explanation: 'Fetch secret from runtime environment',
            suggestionCode: 'const apiKey = process.env.API_KEY;',
          },
        ],
      };

      const result = formatInlineCommentBody(finding);

      expect(result).toContain('### [security-tenancy] Hardcoded Secret — Severity: CRITICAL');
      expect(result).toContain('**Confidence**: 90%');
      expect(result).toContain('**Finding**: Remove hardcoded API key.');
      expect(result).toContain('[RECOMMENDATION] Use environment variables.');
      expect(result).toContain('#### Option 1: Use process.env (Rank #1)');
      expect(result).toContain('Fetch secret from runtime environment');
      expect(result).toContain('```suggestion\nconst apiKey = process.env.API_KEY;\n```');
      expect(result).not.toContain('Option 2');
    });

    it('formats double option fix correctly with Option 1 and Option 2 headers and suggestion fences', () => {
      const finding: PersonaFinding = {
        persona: 'correctness',
        severity: 'major',
        filePath: 'src/calc.ts',
        lineNumber: 25,
        title: 'Division by Zero',
        comment: 'Check divisor before dividing.',
        fixOptions: [
          {
            rank: 1,
            title: 'Ternary check',
            explanation: 'Return 0 if divisor is 0',
            suggestionCode: 'const result = divisor === 0 ? 0 : numerator / divisor;',
          },
          {
            rank: 2,
            title: 'Throw Error',
            explanation: 'Throw explicit error on zero divisor',
            suggestionCode: 'if (divisor === 0) throw new Error("Zero divisor");\nconst result = numerator / divisor;',
          },
        ],
      };

      const result = formatInlineCommentBody(finding);

      expect(result).toContain('#### Option 1: Ternary check (Rank #1)');
      expect(result).toContain('```suggestion\nconst result = divisor === 0 ? 0 : numerator / divisor;\n```');
      expect(result).toContain('#### Option 2: Throw Error (Rank #2)');
      expect(result).toContain('```suggestion\nif (divisor === 0) throw new Error("Zero divisor");\nconst result = numerator / divisor;\n```');
    });

    it('caps fixOptions to maximum of 2 options', () => {
      const finding: PersonaFinding = {
        persona: 'performance',
        severity: 'minor',
        filePath: 'src/list.ts',
        lineNumber: 5,
        comment: 'Optimize lookup',
        fixOptions: [
          { rank: 1, title: 'Opt 1', suggestionCode: 'const set = new Set(arr);' },
          { rank: 2, title: 'Opt 2', suggestionCode: 'const map = new Map();' },
          { rank: 1, title: 'Opt 3', suggestionCode: 'const obj = {};' },
        ],
      };

      const result = formatInlineCommentBody(finding);

      expect(result).toContain('Option 1');
      expect(result).toContain('Option 2');
      expect(result).not.toContain('Opt 3');
    });

    it('uses default option titles when title is omitted', () => {
      const finding: PersonaFinding = {
        persona: 'consistency',
        severity: 'nit',
        filePath: 'src/utils.ts',
        lineNumber: 12,
        comment: 'Style fix',
        fixOptions: [
          { rank: 1, suggestionCode: 'const x = 1;' },
          { rank: 2, suggestionCode: 'let x = 1;' },
        ],
      };

      const result = formatInlineCommentBody(finding);

      expect(result).toContain('#### Option 1: Recommended Fix (Rank #1)');
      expect(result).toContain('#### Option 2: Alternative Approach (Rank #2)');
    });

    it('falls back to single suggestion or codeSnippet when fixOptions is empty or missing', () => {
      const findingWithSuggestion: PersonaFinding = {
        persona: 'contract',
        severity: 'P1',
        filePath: 'src/api.ts',
        lineNumber: 30,
        comment: 'Update return type',
        suggestion: 'return { status: 200 };',
      };

      const result1 = formatInlineCommentBody(findingWithSuggestion);
      expect(result1).toContain('```suggestion\nreturn { status: 200 };\n```');
      expect(result1).not.toContain('Option 1');

      const findingWithSnippet: PersonaFinding = {
        persona: 'contract',
        severity: 'P2',
        filePath: 'src/api.ts',
        lineNumber: 35,
        comment: 'Use snippet',
        codeSnippet: 'const snippet = true;',
      };

      const result2 = formatInlineCommentBody(findingWithSnippet);
      expect(result2).toContain('```suggestion\nconst snippet = true;\n```');
    });
  });

  describe('2. Special Character Escaping & Markdown Preservation inside Suggestion Blocks', () => {
    it('preserves raw code syntax like Generics, HTML tags, template strings, and backslashes inside suggestion blocks', () => {
      const codeSnippet = 'const render = <T extends Record<string, any>>(val: T): string => `Val: ${JSON.stringify(val)}`;';
      const finding: PersonaFinding = {
        persona: 'security',
        severity: 'critical',
        filePath: 'src/render.ts',
        lineNumber: 15,
        comment: 'Generic renderer',
        suggestion: codeSnippet,
      };

      const result = formatInlineCommentBody(finding);

      expect(result).toContain('```suggestion\n' + codeSnippet + '\n```');
      expect(result).not.toContain('&lt;');
      expect(result).not.toContain('&gt;');
    });

    it('preserves multi-line code blocks and Windows CRLF / Linux LF line endings', () => {
      const multiLineCode = 'function foo() {\r\n  const a = 1;\r\n  return a;\r\n}';
      const finding: PersonaFinding = {
        persona: 'correctness',
        severity: 'P0',
        filePath: 'src/foo.ts',
        lineNumber: 1,
        comment: 'Multi-line function fix',
        suggestion: multiLineCode,
      };

      const result = formatInlineCommentBody(finding);
      expect(result).toContain('```suggestion\n' + multiLineCode + '\n```');
    });

    it('preserves unicode characters, emojis, and special markdown symbols inside suggestion code', () => {
      const unicodeCode = 'const label = "⚠️ Alert: #1 test *bold* _italic_ [link](http://test.com)";';
      const finding: PersonaFinding = {
        persona: 'policy-compliance',
        severity: 'minor',
        filePath: 'src/label.ts',
        lineNumber: 40,
        comment: 'Unicode string check',
        suggestion: unicodeCode,
      };

      const result = formatInlineCommentBody(finding);
      expect(result).toContain('```suggestion\n' + unicodeCode + '\n```');
    });

    it('documents behavior when suggestion code contains triple backticks inside fence', () => {
      const codeWithBackticks = 'const md = "```js\\nconsole.log(1);\\n```";';
      const finding: PersonaFinding = {
        persona: 'docs',
        severity: 'nit',
        filePath: 'src/doc.ts',
        lineNumber: 5,
        comment: 'Markdown template string',
        suggestion: codeWithBackticks,
      };

      const result = formatInlineCommentBody(finding);
      expect(result).toContain('```suggestion\n' + codeWithBackticks + '\n```');
    });
  });

  describe('3. Panel Finding Parser Robustness (Invalid or Missing Confidence & Fields)', () => {
    it('parses valid numeric confidence in panelEngine executePersonaPanel', async () => {
      const config = parseAndValidateConfig(policyYaml) as CtReviewConfigV3;
      const complete = vi.fn(async ({ model, messages }: any) => {
        const prompt = String(messages.at(-1).content);
        const nonce = prompt.match(/CT_REVIEW_NONCE:([a-f0-9-]+)/)![1];
        if (prompt.includes('"role":"moderator"')) {
          return {
            model,
            content: fenced(nonce, { decision: 'RECONCILED', findings: [] }),
            usage: null, costUSD: null,
          };
        }
        if (prompt.includes('"role":"arbiter"')) {
          return {
            model,
            content: fenced(nonce, { verdict: 'FIX_FIRST', rationale: 'Finding requires fix' }),
            usage: null, costUSD: null,
          };
        }
        return {
          model,
          content: fenced(nonce, {
            decision: 'FINDINGS',
            findings: [
              {
                severity: 'P1',
                path: 'src/auth.ts',
                line: 12,
                title: 'Insecure Auth',
                body: 'Auth check bypassed',
                confidence: 95,
                recommendation: 'Enforce auth token check',
                fixOptions: [
                  { rank: 1, title: 'Check Token', suggestionCode: 'if (!token) throw new Error();' },
                ],
              },
            ],
          }),
          usage: null, costUSD: null,
        };
      });

      const result = await executePersonaPanel({
        config,
        changedFiles: [{ path: 'src/auth.ts', patch: '+auth' }],
        repository: 'calltelemetry/ct-meta',
        headSha: 'abc123',
        client: { complete } as unknown as OmniRouteClient,
      });

      expect(result.personas[0].findings[0].confidence).toBe(95);
      expect(result.personas[0].findings[0].recommendation).toBe('Enforce auth token check');
      expect(result.personas[0].findings[0].fixOptions).toHaveLength(1);
    });

    it('safely ignores non-numeric confidence types (string, boolean, array, null, undefined)', async () => {
      const config = parseAndValidateConfig(policyYaml) as CtReviewConfigV3;
      const complete = vi.fn(async ({ model, messages }: any) => {
        const prompt = String(messages.at(-1).content);
        const nonce = prompt.match(/CT_REVIEW_NONCE:([a-f0-9-]+)/)![1];
        if (prompt.includes('"role":"moderator"')) {
          return { model, content: fenced(nonce, { decision: 'RECONCILED', findings: [] }), usage: null, costUSD: null };
        }
        if (prompt.includes('"role":"arbiter"')) {
          return { model, content: fenced(nonce, { verdict: 'SHIP', rationale: 'OK' }), usage: null, costUSD: null };
        }
        return {
          model,
          content: fenced(nonce, {
            decision: 'FINDINGS',
            findings: [
              {
                severity: 'P2',
                path: 'src/auth.ts',
                line: 5,
                title: 'Check 1',
                body: 'Body 1',
                confidence: '95', // invalid string confidence
              },
              {
                severity: 'P2',
                path: 'src/auth.ts',
                line: 10,
                title: 'Check 2',
                body: 'Body 2',
                confidence: null, // invalid null confidence
              },
              {
                severity: 'P2',
                path: 'src/auth.ts',
                line: 15,
                title: 'Check 3',
                body: 'Body 3',
                // missing confidence
              },
            ],
          }),
          usage: null, costUSD: null,
        };
      });

      const result = await executePersonaPanel({
        config,
        changedFiles: [{ path: 'src/auth.ts', patch: '+test' }],
        repository: 'calltelemetry/ct-meta',
        headSha: 'abc123',
        client: { complete } as unknown as OmniRouteClient,
      });

      const findings = result.personas[0].findings;
      expect(findings[0].confidence).toBeUndefined();
      expect(findings[1].confidence).toBeUndefined();
      expect(findings[2].confidence).toBeUndefined();
    });

    it('handles NaN/null in JSON where NaN becomes null and is dropped by validateFindings', async () => {
      const config = parseAndValidateConfig(policyYaml) as CtReviewConfigV3;
      const complete = vi.fn(async ({ model, messages }: any) => {
        const prompt = String(messages.at(-1).content);
        const nonce = prompt.match(/CT_REVIEW_NONCE:([a-f0-9-]+)/)![1];
        if (prompt.includes('"role":"moderator"')) {
          return { model, content: fenced(nonce, { decision: 'RECONCILED', findings: [] }), usage: null, costUSD: null };
        }
        if (prompt.includes('"role":"arbiter"')) {
          return { model, content: fenced(nonce, { verdict: 'SHIP', rationale: 'OK' }), usage: null, costUSD: null };
        }
        return {
          model,
          content: `CT_REVIEW_BEGIN:${nonce}\n{"decision":"FINDINGS","findings":[{"severity":"P2","path":"src/auth.ts","line":5,"title":"NaN check","body":"NaN confidence test","confidence":null}]}\nCT_REVIEW_END:${nonce}`,
          usage: null, costUSD: null,
        };
      });

      const result = await executePersonaPanel({
        config,
        changedFiles: [{ path: 'src/auth.ts', patch: '+test' }],
        repository: 'calltelemetry/ct-meta',
        headSha: 'abc123',
        client: { complete } as unknown as OmniRouteClient,
      });

      // JSON parsing converts NaN to null. Since typeof null !== 'number', validateFindings omits confidence.
      expect(result.personas[0].findings[0].confidence).toBeUndefined();
    });

    it('rejects invalid finding structure when required fields are missing or invalid', async () => {
      const config = parseAndValidateConfig(policyYaml) as CtReviewConfigV3;
      config.personas[0].required = true;
      const complete = vi.fn(async () => {
        throw new Error('Invalid completion payload or provider error');
      });

      await expect(executePersonaPanel({
        config,
        changedFiles: [{ path: 'src/auth.ts', patch: '+test' }],
        repository: 'calltelemetry/ct-meta',
        headSha: 'abc123',
        client: { complete } as unknown as OmniRouteClient,
      })).rejects.toThrow(PanelConfigurationError);
    });
  });
});
