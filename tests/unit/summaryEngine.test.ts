import { describe, it, expect } from 'vitest';
import { generatePRSummary, parseDiffModules } from '../../src/review/summaryEngine';
import { PersonaFinding } from '../../src/github/commentPublisher';

describe('summaryEngine.ts — CodeRabbit-Grade PR Summary Engine', () => {
  const sampleDiff = `
diff --git a/src/github/commentPublisher.ts b/src/github/commentPublisher.ts
index 1234567..89abcdef 100644
--- a/src/github/commentPublisher.ts
+++ b/src/github/commentPublisher.ts
@@ -10,5 +10,12 @@
+ export interface FixOption { rank: 1 | 2; suggestionCode: string; }
diff --git a/src/review/summaryEngine.ts b/src/review/summaryEngine.ts
new file mode 100644
--- /dev/null
+++ b/src/review/summaryEngine.ts
@@ -0,0 +1,50 @@
+ export function generatePRSummary() {}
diff --git a/tests/unit/summaryEngine.test.ts b/tests/unit/summaryEngine.test.ts
new file mode 100644
--- /dev/null
+++ b/tests/unit/summaryEngine.test.ts
@@ -0,0 +1,30 @@
+ describe('summaryEngine', () => {});
`;

  const sampleFindings: PersonaFinding[] = [
    {
      persona: 'security-tenancy',
      severity: 'critical',
      filePath: 'src/github/commentPublisher.ts',
      lineNumber: 15,
      comment: 'Missing validation check on incoming options',
      title: 'Validation Error',
      confidence: 95,
      recommendation: 'Add schema validation',
    },
    {
      persona: 'policy-compliance',
      severity: 'major',
      filePath: 'src/review/summaryEngine.ts',
      lineNumber: 20,
      comment: 'Function lacks explicit return type annotation',
      title: 'Type Safety Violation',
      confidence: 88,
    },
  ];

  it('parses diff modules and files correctly', () => {
    const modules = parseDiffModules(sampleDiff);
    expect(modules.has('src/github')).toBe(true);
    expect(modules.has('src/review')).toBe(true);
    expect(modules.has('tests/unit')).toBe(true);
    expect(modules.get('src/github')?.files).toContain('src/github/commentPublisher.ts');
  });

  it('generates summary with Executive Overview, Walkthrough, and Changesets', () => {
    const summary = generatePRSummary(sampleDiff, sampleFindings);

    expect(summary).toContain('## Executive Overview');
    expect(summary).toContain('## Walkthrough');
    expect(summary).toContain('## Changesets');

    expect(summary).toContain('3 file(s) in 3 module(s)');
    expect(summary).toContain('Automated review detected 2 finding(s)');
    expect(summary).toContain('1 critical, 1 major');

    expect(summary).toContain('- **src/github**: Updated 1 file(s)');
    expect(summary).toContain('### `src/github`');
    expect(summary).toContain('### `src/review`');
    expect(summary).toContain('### `tests/unit`');
  });

  it('handles empty diff gracefully with fallback metadata summary', () => {
    const summary = generatePRSummary('', []);
    expect(summary).toContain('## Executive Overview');
    expect(summary).toContain('## Walkthrough');
    expect(summary).toContain('## Changesets');
    expect(summary).toContain('All persona checks passed with zero findings detected.');
  });
});
