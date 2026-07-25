import { describe, it, expect } from 'vitest';
import { generatePRSummary, parseDiffModules } from '../../src/review/summaryEngine';
import { PersonaFinding } from '../../src/github/commentPublisher';

describe('summaryEngine.ts — Comprehensive Unit Expansion Tests', () => {
  it('parses multi-file diffs with single and nested directory paths', () => {
    const diff = `
diff --git a/src/auth/login.ts b/src/auth/login.ts
--- a/src/auth/login.ts
+++ b/src/auth/login.ts
@@ -1,5 +1,5 @@
+ export function login() {}
diff --git a/src/auth/tokens/jwt.ts b/src/auth/tokens/jwt.ts
--- a/src/auth/tokens/jwt.ts
+++ b/src/auth/tokens/jwt.ts
@@ -10,3 +10,4 @@
+ export function verifyToken() {}
`;
    const modules = parseDiffModules(diff);
    expect(modules.has('src/auth')).toBe(true);
    expect(modules.has('src/auth/tokens')).toBe(true);
    expect(modules.get('src/auth')?.files).toContain('src/auth/login.ts');
    expect(modules.get('src/auth/tokens')?.files).toContain('src/auth/tokens/jwt.ts');
  });

  it('handles diff with root level files', () => {
    const diff = `
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1,1 +1,2 @@
+ # New Title
`;
    const modules = parseDiffModules(diff);
    expect(modules.has('root')).toBe(true);
    expect(modules.get('root')?.files).toContain('README.md');
  });

  it('handles diff with deleted files (/dev/null)', () => {
    const diff = `
diff --git a/src/oldFile.ts b/dev/null
--- a/src/oldFile.ts
+++ /dev/null
@@ -1,10 +0,0 @@
- old content
`;
    const modules = parseDiffModules(diff);
    expect(modules.has('src')).toBe(true);
    expect(modules.get('src')?.files).toContain('src/oldFile.ts');
    expect(modules.get('src')?.files).not.toContain('/dev/null');
  });

  it('handles fallback pattern matching when standard diff headers are omitted', () => {
    const diff = `
  src/gateway/client.ts
  src/utils/logger.ts
`;
    const modules = parseDiffModules(diff);
    expect(modules.has('src/gateway')).toBe(true);
    expect(modules.has('src/utils')).toBe(true);
  });

  it('returns empty module map for empty, null, or undefined diff', () => {
    expect(parseDiffModules('').size).toBe(0);
    expect(parseDiffModules(null as any).size).toBe(0);
    expect(parseDiffModules(undefined as any).size).toBe(0);
  });

  it('generates summary overview with mixed severity findings (P0, P1, critical, major, minor)', () => {
    const diff = `
diff --git a/src/api.ts b/src/api.ts
--- a/src/api.ts
+++ b/src/api.ts
@@ -1,1 +1,2 @@
+ const x = 1;
`;
    const findings: PersonaFinding[] = [
      { persona: 'security', severity: 'P0', filePath: 'src/api.ts', lineNumber: 1, comment: 'P0 finding', title: 'Critical Auth' },
      { persona: 'correctness', severity: 'critical', filePath: 'src/api.ts', lineNumber: 2, comment: 'Critical finding', title: 'Null deref' },
      { persona: 'policy', severity: 'P1', filePath: 'src/api.ts', lineNumber: 3, comment: 'P1 finding', title: 'Policy violation' },
      { persona: 'style', severity: 'minor', filePath: 'src/api.ts', lineNumber: 4, comment: 'Minor finding', title: 'Formatting' },
    ];

    const summary = generatePRSummary(diff, findings);

    expect(summary).toContain('## Executive Overview');
    expect(summary).toContain('Automated review detected 4 finding(s)');
    expect(summary).toContain('2 critical, 1 major');
  });

  it('formats walkthrough section with module bullet points and top finding snippets', () => {
    const diff = `
diff --git a/src/modA/file1.ts b/src/modA/file1.ts
--- a/src/modA/file1.ts
+++ b/src/modA/file1.ts
@@ -1,1 +1,1 @@
+ change
`;
    const findings: PersonaFinding[] = [
      { persona: 'p1', severity: 'major', filePath: 'src/modA/file1.ts', lineNumber: 10, comment: 'Bug found', title: 'Major Bug' },
    ];

    const summary = generatePRSummary(diff, findings);

    expect(summary).toContain('## Walkthrough');
    expect(summary).toContain('- **src/modA**: Updated 1 file(s) (`file1.ts`).');
    expect(summary).toContain('Review Findings Summary');
    expect(summary).toContain('[p1] MAJOR at `src/modA/file1.ts:10`: Bug found');
  });

  it('formats changesets section with per-module file headers', () => {
    const diff = `
diff --git a/src/modB/file2.ts b/src/modB/file2.ts
--- a/src/modB/file2.ts
+++ b/src/modB/file2.ts
@@ -1,1 +1,1 @@
+ change
`;
    const summary = generatePRSummary(diff, []);

    expect(summary).toContain('## Changesets');
    expect(summary).toContain('### `src/modB`');
    expect(summary).toContain('- `src/modB/file2.ts`: Modified in pull request.');
  });

  it('handles findings with missing optional fields like title or comment gracefully', () => {
    const diff = `
diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,1 +1,1 @@
+ code
`;
    const findings: PersonaFinding[] = [
      { persona: 'sec', severity: 'critical', filePath: 'src/app.ts', lineNumber: 5, comment: '' },
    ];

    const summary = generatePRSummary(diff, findings);
    expect(summary).toContain('## Executive Overview');
    expect(summary).toContain('[sec] CRITICAL at `src/app.ts:5`');
  });

  it('handles empty diff with zero findings fallback text', () => {
    const summary = generatePRSummary('', []);
    expect(summary).toContain('All persona checks passed with zero findings detected.');
  });

  it('handles whitespace-only diff string gracefully', () => {
    const summary = generatePRSummary('    \n\t   ', []);
    expect(summary).toContain('All persona checks passed with zero findings detected.');
  });

  it('truncates finding snippets in walkthrough to top 5 findings max', () => {
    const diff = `
diff --git a/src/main.ts b/src/main.ts
--- a/src/main.ts
+++ b/src/main.ts
@@ -1,1 +1,1 @@
+ code
`;
    const findings: PersonaFinding[] = Array.from({ length: 10 }, (_, i) => ({
      persona: `persona-${i}`,
      severity: 'minor',
      filePath: 'src/main.ts',
      lineNumber: i + 1,
      comment: `Finding #${i + 1}`,
    }));

    const summary = generatePRSummary(diff, findings);

    expect(summary).toContain('persona-0');
    expect(summary).toContain('persona-4');
    expect(summary).not.toContain('persona-5');
  });
});
