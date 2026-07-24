import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { setupE2ETestHarness, E2ETestHarness } from '@harness/e2eTestRunner';
import { parseConstitution, evaluateConstitution } from '@src/constitution/constitutionEngine';

describe('Tier 2 Boundary & Corner Case Tests: Constitution Enforcement Engine', () => {
  let harness: E2ETestHarness;

  beforeAll(async () => {
    harness = await setupE2ETestHarness({
      testRunId: 'tier2-constitution-suite',
    });
  });

  afterAll(async () => {
    await harness.teardown();
  });

  test('1. Empty constitution file boundary - handles empty string and returns compliant result with zero rules', () => {
    const emptyConstitutions = ['', '   ', '\n\n'];

    for (const emptyContent of emptyConstitutions) {
      const parsed = parseConstitution(emptyContent);
      expect(parsed.rules).toEqual([]);
      expect(parsed.title).toBe('Repository Constitution');

      const evaluation = evaluateConstitution({
        constitution: parsed,
        prTitle: 'fix: bad title',
        prBody: 'bad body',
        changedFiles: [{ path: 'src/main.ts', content: 'eval("secret");' }],
      });

      expect(evaluation.compliant).toBe(true);
      expect(evaluation.violations).toHaveLength(0);
    }
  });

  test('2. Invalid markdown formatting boundary - handles unstructured plain text, HTML comments, and random code blocks without failing', () => {
    const invalidMarkdown = `
<!-- HTML Comment block -->
Random plain text without bullet points or headers.
Some random sentence here.

\`\`\`javascript
const foo = "bar";
function test() {}
\`\`\`

Arbitrary text without any rule format.
`;

    const parsed = parseConstitution(invalidMarkdown);
    expect(parsed.rules).toEqual([]);

    const evaluation = evaluateConstitution({
      constitution: parsed,
      prTitle: 'feat: add feature',
      prBody: 'Feature description',
    });

    expect(evaluation.compliant).toBe(true);
  });

  test('3. Rule identification and duplicate rule descriptions boundary - assigns unique IDs sequentially across multiple sections', () => {
    const multiSectionMarkdown = `
# Project Constitution

## Section 1: Directives
- PR Title must follow Conventional Commits format
- PR description must include testing steps

## Section 2: Forbidden Patterns
- Forbidden: hardcoded JWT secrets
- PR description must include testing steps
- Forbidden: \`/eval\\s*\\(/g\`
`;

    const parsed = parseConstitution(multiSectionMarkdown);

    expect(parsed.rules).toHaveLength(5);
    const ruleIds = parsed.rules.map(r => r.id);
    const uniqueIds = new Set(ruleIds);
    expect(uniqueIds.size).toBe(5);
    expect(ruleIds).toEqual(['rule-1', 'rule-2', 'rule-3', 'rule-4', 'rule-5']);
  });

  test('4. Regex syntax errors in embedded patterns boundary - catches invalid RegExp syntax without crashing', () => {
    const badRegexMarkdown = `
# Constitution

## Forbidden Patterns
- Forbidden pattern: \`/[invalid-regex-unclosed-group(/g\`
- Forbidden pattern: \`/(unmatched-paren/g\`
- Never use eval in code: \`/eval\\s*\\(/g\`
`;

    const parsed = parseConstitution(badRegexMarkdown);
    expect(parsed.rules).toHaveLength(3);

    // Bad regex rules fall back to undefined pattern property
    expect(parsed.rules[0].pattern).toBeUndefined();
    expect(parsed.rules[1].pattern).toBeUndefined();

    // Valid regex pattern is compiled
    expect(parsed.rules[2].pattern).toBeDefined();

    // Evaluation handles undefined pattern rules safely
    const evaluation = evaluateConstitution({
      constitution: parsed,
      prTitle: 'feat: valid title',
      prBody: 'valid description',
      changedFiles: [{ path: 'src/main.ts', content: 'const a = 1;' }],
    });

    expect(evaluation.compliant).toBe(true);
  });

  test('5. Disabled constitution boundary - returns compliant: true and bypassed: true regardless of rule violations', () => {
    const strictConstitutionMd = `
# Strict Constitution

## Directives
- PR Title must follow Conventional Commits format
- PR description must include testing steps

## Forbidden Patterns
- Never use eval statement
`;

    const parsed = parseConstitution(strictConstitutionMd);

    // Violation inputs: non-conventional title, short body, eval in code
    const evaluation = evaluateConstitution({
      constitution: parsed,
      config: { enabled: false },
      prTitle: 'bad title',
      prBody: 'short',
      changedFiles: [{ path: 'src/index.ts', content: 'eval("foo");' }],
    });

    expect(evaluation.compliant).toBe(true);
    expect(evaluation.violations).toHaveLength(0);
    expect(evaluation.bypassed).toBe(true);
  });
});
