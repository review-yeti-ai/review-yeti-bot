import { describe, it, expect } from 'vitest';
import { parseConstitution, evaluateConstitution } from '../../src/constitution/constitutionEngine';

describe('Operational Constitution Engine', () => {
  const sampleMarkdown = `
# Engineering Constitution

## Forbidden Patterns
- Prohibit direct call to eval \`/eval\\(.*?\\)/\`.
- Never use console.log in production files.

## Directives
- MUST: PR description must contain detailed testing steps.
`;

  it('parses rules and extracts regex patterns from markdown', () => {
    const parsed = parseConstitution(sampleMarkdown);

    expect(parsed.title).toBe('Engineering Constitution');
    expect(parsed.rules.length).toBe(3);

    const evalRule = parsed.rules.find(r => r.description.includes('eval'));
    expect(evalRule).toBeDefined();
    expect(evalRule?.type).toBe('forbidden_pattern');
    expect(evalRule?.pattern).toBeDefined();
    expect(evalRule?.pattern?.test('eval("alert(1)")')).toBe(true);
  });

  it('evaluates forbidden pattern rules against changed files', () => {
    const parsed = parseConstitution(sampleMarkdown);

    const result = evaluateConstitution({
      constitution: parsed,
      prTitle: 'feat: add query runner',
      prBody: 'PR description must contain detailed testing steps for the reviewer.',
      changedFiles: [
        {
          path: 'src/runner.ts',
          content: 'const res = eval("1 + 1");',
        },
      ],
    });

    expect(result.compliant).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.violations[0]).toContain("Forbidden pattern matched in file 'src/runner.ts'");
  });

  it('evaluates directive rules against PR description', () => {
    const parsed = parseConstitution(sampleMarkdown);

    const result = evaluateConstitution({
      constitution: parsed,
      prTitle: 'feat: add new API endpoint',
      prBody: 'Short', // Insufficient description
      changedFiles: [{ path: 'src/api.ts', content: 'export const api = {};' }],
    });

    expect(result.compliant).toBe(false);
    expect(result.violations.some(v => v.includes('Directive violation'))).toBe(true);
  });

  it('passes evaluation when PR and code comply with all rules', () => {
    const parsed = parseConstitution(sampleMarkdown);

    const result = evaluateConstitution({
      constitution: parsed,
      prTitle: 'feat: add clean authentication module',
      prBody: 'PR description must contain detailed testing steps for reviewer verification.',
      changedFiles: [
        {
          path: 'src/auth.ts',
          content: 'export function authenticate() { return true; }',
        },
      ],
    });

    expect(result.compliant).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('handles empty or malformed markdown gracefully', () => {
    const parsed = parseConstitution('');
    expect(parsed.rules).toEqual([]);

    const result = evaluateConstitution({ constitution: parsed });
    expect(result.compliant).toBe(true);
  });

  it('parses backtick regexes containing escaped slashes', () => {

    const md = "# API Security Policy\n- Prohibit internal route exposure `\\/api\\/v1\\/`.";
    const parsed = parseConstitution(md);
    expect(parsed.rules.length).toBe(1);
    expect(parsed.rules[0].pattern).toBeDefined();
    expect(parsed.rules[0].pattern?.test('/api/v1/users')).toBe(true);
  });

  it('evaluates natural language non-regex forbidden rules', () => {
    const md = `
# Code Safety
- Never use eval in code
- Prohibit hardcoded JWT secrets
`;
    const parsed = parseConstitution(md);
    const result = evaluateConstitution({
      constitution: parsed,
      prTitle: 'feat: add auth',
      prBody: 'Implements authentication with testing steps included.',
      changedFiles: [
        {
          path: 'src/secret.ts',
          content: 'const HARDCODED_JWT_SECRETS = "supersecret";',
        },
      ],
    });

    expect(result.compliant).toBe(false);
    expect(result.violations.some(v => v.includes("file 'src/secret.ts'"))).toBe(true);
  });

  it('evaluates expanded directives against PR summary and metadata', () => {
    const md = `
# PR Directives
- PR title must follow conventional commits format.
- PR description must include risk assessment.
`;
    const parsed = parseConstitution(md);
    const result = evaluateConstitution({
      constitution: parsed,
      prTitle: 'bad title format without prefix',
      prBody: 'Detailed description without mentioning any safety issues.',
    });

    expect(result.compliant).toBe(false);
    expect(result.violations.some(v => v.includes('conventional commits'))).toBe(true);
    expect(result.violations.some(v => v.includes('risk assessment'))).toBe(true);
  });
});
