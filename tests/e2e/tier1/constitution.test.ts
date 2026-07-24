import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { setupE2ETestHarness, E2ETestHarness } from '@harness/e2eTestRunner';
import { FixtureGenerator } from '@harness/fixtureGenerator';
import { parseConstitution, evaluateConstitution, ParsedConstitution } from '@src/constitution/constitutionEngine';

describe('Tier 1 Feature Coverage: Repository Constitution Enforcement Engine', () => {
  let harness: E2ETestHarness;

  beforeAll(async () => {
    harness = await setupE2ETestHarness({
      testRunId: 'tier1-constitution-suite',
    });
  });

  afterAll(async () => {
    await harness.teardown();
  });

  test('1. Extracts directives, forbidden patterns, and mandatory guidelines from constitution.md', () => {
    const rawMarkdown = `
# Engineering Constitution

## Forbidden Patterns
- Prohibit direct eval execution \`/eval\\(.*?\\)/\`.
- Prohibit hardcoded API keys \`/AKIA[0-9A-Z]{16}/\`.

## Directives
- PR description MUST contain detailed testing steps.

## Mandatory Guidelines
- All public functions must include JSDoc comments.
`;

    const parsed: ParsedConstitution = parseConstitution(rawMarkdown);

    expect(parsed.title).toBe('Engineering Constitution');
    expect(parsed.rules.length).toBe(4);

    const evalRule = parsed.rules.find((r) => r.description.includes('eval'));
    expect(evalRule).toBeDefined();
    expect(evalRule?.type).toBe('forbidden_pattern');
    expect(evalRule?.pattern).toBeDefined();

    const directiveRule = parsed.rules.find((r) => r.description.includes('PR description MUST'));
    expect(directiveRule).toBeDefined();
    expect(directiveRule?.type).toBe('directive');
  });

  test('2. Security guideline checks detect forbidden patterns in changed diff files', () => {
    const constitutionMd = `
# Security Constitution

## Forbidden Patterns
- Never commit plaintext AWS access keys \`/AKIA[0-9A-Z]{16}/\`.
- Prohibit raw eval execution \`/eval\\(.*?\\)/\`.
`;

    const constitution = parseConstitution(constitutionMd);

    const result = evaluateConstitution({
      constitution,
      prTitle: 'feat(auth): add AWS upload integration',
      prBody: 'Integrates AWS S3 file upload.',
      changedFiles: [
        {
          path: 'src/aws/s3.ts',
          content: 'const awsKey = "AKIAIOSFODNN7EXAMPLE"; // HARDCODED SECRET',
        },
      ],
    });

    expect(result.compliant).toBe(false);
    expect(result.violations.length).toBe(1);
    expect(result.violations[0]).toContain("Forbidden pattern matched in file 'src/aws/s3.ts'");
    expect(result.violations[0]).toContain('AKIA[0-9A-Z]{16}');
  });

  test('3. Architecture guideline checks detect architecture layer violations in UI components', () => {
    const constitutionMd = `
# Architecture Guidelines

## Forbidden Patterns
- UI layer component must not query raw database directly \`/import.*rawDriver/\`.
`;

    const constitution = parseConstitution(constitutionMd);

    const result = evaluateConstitution({
      constitution,
      prTitle: 'feat(ui): add audit log viewer table',
      prBody: 'Renders audit log table in React dashboard.',
      changedFiles: [
        {
          path: 'src/ui/AuditTable.tsx',
          content: 'import { directDatabaseQuery } from "../db/rawDriver";\nexport const AuditTable = () => {};',
        },
      ],
    });

    expect(result.compliant).toBe(false);
    expect(result.violations.length).toBe(1);
    expect(result.violations[0]).toContain("Forbidden pattern matched in file 'src/ui/AuditTable.tsx'");
  });

  test('4. Compliance output formatting builds structured and readable violation reports', () => {
    const constitutionMd = `
# Compliance Standards

## Forbidden Patterns
- Prohibit console.log statements \`/console\\.log/\`.
`;

    const constitution = parseConstitution(constitutionMd);

    const result = evaluateConstitution({
      constitution,
      prTitle: 'fix(logger): clean debug statements',
      prBody: 'Refactors logging module.',
      changedFiles: [
        {
          path: 'src/logger.ts',
          content: 'console.log("debug message");',
        },
      ],
    });

    expect(result).toHaveProperty('compliant', false);
    expect(result).toHaveProperty('violations');
    expect(Array.isArray(result.violations)).toBe(true);
    expect(result.violations[0]).toMatch(/^Forbidden pattern matched in file 'src\/logger\.ts' \[Rule rule-\d+\]:/);
  });

  test('5. Disabled constitution flag bypasses rule evaluation and returns compliant status', () => {
    const constitutionMd = `
# Security Constitution

## Forbidden Patterns
- Prohibit direct eval execution \`/eval\\(.*?\\)/\`.
`;

    const constitution = parseConstitution(constitutionMd);

    const configDisabled = {
      enabled: false,
      path: '.github/constitution.md',
    };

    // If disabled in config, evaluateConstitution returns bypassed status
    const result = evaluateConstitution({
      constitution,
      config: configDisabled,
      prTitle: 'feat: add eval script execution',
      prBody: 'Uses eval(input);',
      changedFiles: [{ path: 'src/eval.ts', content: 'eval(input);' }],
    });

    expect(result.compliant).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.bypassed).toBe(true);
  });

  test('6. Directive enforcement validates required PR description contents and testing steps', () => {
    const constitutionMd = `
# Operational Directives

## Directives
- PR description MUST contain detailed testing steps.
`;

    const constitution = parseConstitution(constitutionMd);

    // Failing PR description (too short / empty)
    const resultFail = evaluateConstitution({
      constitution,
      prTitle: 'feat: quick fix',
      prBody: 'too short',
    });

    expect(resultFail.compliant).toBe(false);
    expect(resultFail.violations.length).toBe(1);
    expect(resultFail.violations[0]).toContain('Directive violation');
    expect(resultFail.violations[0]).toContain('PR description is missing or insufficient');

    // Compliant PR description
    const resultPass = evaluateConstitution({
      constitution,
      prTitle: 'feat: add user authentication endpoint',
      prBody: 'This PR adds JWT auth. Detailed testing steps: 1. Run unit tests. 2. Verify login endpoint with token payload.',
    });

    expect(resultPass.compliant).toBe(true);
    expect(resultPass.violations).toEqual([]);
  });
});
