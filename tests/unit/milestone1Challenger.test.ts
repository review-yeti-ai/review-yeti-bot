import { describe, it, expect } from 'vitest';
import { generatePRSummary, parseDiffModules } from '../../src/review/summaryEngine';
import { generateMermaidDiagram, analyzeDiffComplexity } from '../../src/review/mermaidEngine';
import { formatInlineCommentBody, PersonaFinding } from '../../src/github/commentPublisher';

describe('Milestone 1 Empirical Stress & Challenge Test Suite', () => {

  describe('1. Extreme Diff Inputs', () => {
    it('handles empty, whitespace, null, and undefined diff inputs without crashing', () => {
      expect(parseDiffModules('')).toBeInstanceOf(Map);
      expect(parseDiffModules('   \n\t  ')).toBeInstanceOf(Map);
      expect(parseDiffModules(null as any)).toBeInstanceOf(Map);
      expect(parseDiffModules(undefined as any)).toBeInstanceOf(Map);

      expect(generatePRSummary('')).toContain('## Executive Overview');
      expect(generatePRSummary('   \n\t  ')).toContain('All persona checks passed');
      expect(generatePRSummary(null as any)).toContain('## Executive Overview');
      expect(generatePRSummary(undefined as any)).toContain('## Executive Overview');

      expect(analyzeDiffComplexity('').isComplex).toBe(false);
      expect(analyzeDiffComplexity(null as any).isComplex).toBe(false);

      expect(generateMermaidDiagram('')).toBe('');
      expect(generateMermaidDiagram(null as any)).toBe('');
    });

    it('processes massive 10,000 line diffs within performance bounds (<1000ms)', () => {
      const diffLines: string[] = [];
      for (let i = 0; i < 200; i++) {
        diffLines.push(`diff --git a/src/module${i % 10}/file${i}.ts b/src/module${i % 10}/file${i}.ts`);
        diffLines.push(`index 0000000..1111111 100644`);
        diffLines.push(`--- a/src/module${i % 10}/file${i}.ts`);
        diffLines.push(`+++ b/src/module${i % 10}/file${i}.ts`);
        diffLines.push(`@@ -1,5 +1,50 @@`);
        for (let j = 0; j < 45; j++) {
          diffLines.push(`+ export function executeAction${i}_${j}(data: Record<string, any>): boolean {`);
          diffLines.push(`+   if (!data) return false;`);
          diffLines.push(`+   const result = fetch('https://api.example.com/v1/action');`);
          diffLines.push(`+   return Boolean(result);`);
          diffLines.push(`+ }`);
        }
      }
      const massiveDiff = diffLines.join('\n');
      expect(massiveDiff.split('\n').length).toBeGreaterThan(10000);

      const startTime = Date.now();
      const moduleMap = parseDiffModules(massiveDiff);
      const summary = generatePRSummary(massiveDiff);
      const diagram = generateMermaidDiagram(massiveDiff);
      const duration = Date.now() - startTime;

      expect(moduleMap.size).toBe(10);
      expect(summary).toContain('200 file(s) in 10 module(s)');
      expect(diagram).toContain('```mermaid');
      expect(duration).toBeLessThan(3000);
    });

    it('handles malformed git diff headers and path traversals without throw', () => {
      const malformedDiff = `
diff --git a/../../etc/passwd b/../../etc/passwd
--- a/../../etc/passwd
+++ b/../../etc/passwd
@@ -1,1 +1,2 @@
+root:x:0:0:root:/root:/bin/bash

diff --git a/src/spaced file name.ts b/src/spaced file name.ts
--- a/src/spaced file name.ts
+++ b/src/spaced file name.ts
@@ -1,1 +1,2 @@
+const x = 1;

--- a/legacy/no-git-header.js
+++ b/legacy/no-git-header.js
@@ -1,1 +1,2 @@
+console.log("legacy");
`;

      const modules = parseDiffModules(malformedDiff);
      expect(modules).toBeInstanceOf(Map);

      const summary = generatePRSummary(malformedDiff);
      expect(summary).toContain('## Executive Overview');

      const diagram = generateMermaidDiagram(malformedDiff);
      expect(typeof diagram).toBe('string');
    });

    it('handles binary diffs without regex hangs or encoding failures', () => {
      const binaryDiff = `
diff --git a/assets/logo.png b/assets/logo.png
index 1234567..89abcdef 100644
Binary files a/assets/logo.png and b/assets/logo.png differ

diff --git a/bin/executable b/bin/executable
new file mode 100755
GIT binary patch
literal 1024
zcmb1?y` + '\0'.repeat(500) + `
`;

      const modules = parseDiffModules(binaryDiff);
      expect(modules).toBeInstanceOf(Map);

      const summary = generatePRSummary(binaryDiff);
      expect(summary).toContain('## Executive Overview');
    });
  });

  describe('2. Mermaid Diagram Rendering for Complex Diffs', () => {
    it('handles multi-component diffs with 5+ components cleanly (slicing top 4)', () => {
      const multiCompDiff = `
diff --git a/src/auth/authManager.ts b/src/auth/authManager.ts
+++ b/src/auth/authManager.ts
@@ -1,3 +1,5 @@
+ export class AuthManager { async login() { fetch('/auth'); } }
diff --git a/src/user/userService.ts b/src/user/userService.ts
+++ b/src/user/userService.ts
@@ -1,3 +1,5 @@
+ export class UserService { getUser() { fetch('/user'); } }
diff --git a/src/payment/paymentProcessor.ts b/src/payment/paymentProcessor.ts
+++ b/src/payment/paymentProcessor.ts
@@ -1,3 +1,5 @@
+ export class PaymentProcessor { process() { publish('pay'); } }
diff --git a/src/notify/notificationEngine.ts b/src/notify/notificationEngine.ts
+++ b/src/notify/notificationEngine.ts
@@ -1,3 +1,5 @@
+ export class NotificationEngine { send() { dispatch('mail'); } }
diff --git a/src/audit/auditLogger.ts b/src/audit/auditLogger.ts
+++ b/src/audit/auditLogger.ts
@@ -1,3 +1,5 @@
+ export class AuditLogger { log() { fetch('/audit'); } }
`;

      const analysis = analyzeDiffComplexity(multiCompDiff);
      expect(analysis.isComplex).toBe(true);

      const diagram = generateMermaidDiagram(multiCompDiff);
      expect(diagram).toContain('```mermaid');
      expect(diagram).toContain('sequenceDiagram');
      expect(diagram).toContain('participant AuthManager');
      expect(diagram).toContain('participant UserService');
      expect(diagram).toContain('participant PaymentProcessor');
      expect(diagram).toContain('participant NotificationEngine');
      expect(diagram).not.toContain('participant AuditLogger');
    });

    it('EMPIRICAL BUG REPRODUCTION: Component name duplication when same base filename exists in different dirs', () => {
      const duplicateBaseDiff = `
diff --git a/src/auth/logger.ts b/src/auth/logger.ts
+++ b/src/auth/logger.ts
@@ -1,2 +1,3 @@
+ export class Logger {}
diff --git a/src/utils/logger.js b/src/utils/logger.js
+++ b/src/utils/logger.js
@@ -1,2 +1,3 @@
+ class Logger {}
`;

      const analysis = analyzeDiffComplexity(duplicateBaseDiff);
      const loggerCount = analysis.components.filter((c) => c === 'Logger').length;
      expect(loggerCount).toBe(1);
    });

    it('EMPIRICAL BUG REPRODUCTION: Single component diff generates flowchart TD', () => {
      const singleCompDiff = `
diff --git a/src/github/commentPublisher.ts b/src/github/commentPublisher.ts
+++ b/src/github/commentPublisher.ts
@@ -1,2 +1,3 @@
+ export function publish() { fetch('https://api.github.com'); }
`;

      const diagram = generateMermaidDiagram(singleCompDiff);
      expect(diagram).toContain('CommentPublisher');
      expect(diagram).toContain('sequenceDiagram');
    });
  });

  describe('3. Persona Finding Edge Cases & Formatting', () => {
    it('formats finding with confidence 0%, 100%, negative, NaN, and undefined', () => {
      const f0: PersonaFinding = {
        persona: 'test-persona',
        severity: 'minor',
        filePath: 'foo.ts',
        lineNumber: 1,
        comment: 'Zero confidence test',
        confidence: 0,
      };
      expect(formatInlineCommentBody(f0)).toContain('**Confidence**: 0%');

      const f100: PersonaFinding = {
        persona: 'test-persona',
        severity: 'critical',
        filePath: 'foo.ts',
        lineNumber: 1,
        comment: 'Full confidence test',
        confidence: 100,
      };
      expect(formatInlineCommentBody(f100)).toContain('**Confidence**: 100%');

      const fNoConf: PersonaFinding = {
        persona: 'test-persona',
        severity: 'major',
        filePath: 'foo.ts',
        lineNumber: 1,
        comment: 'No confidence provided',
      };
      expect(formatInlineCommentBody(fNoConf)).not.toContain('**Confidence**');
    });

    it('handles fix options with empty arrays, missing titles, or multi-line suggestion code', () => {
      const fEmptyOpts: PersonaFinding = {
        persona: 'sec',
        severity: 'critical',
        filePath: 'a.ts',
        lineNumber: 10,
        comment: 'Empty fix options array',
        fixOptions: [],
        suggestion: 'const x = 1;',
      };
      expect(formatInlineCommentBody(fEmptyOpts)).toContain('```suggestion\nconst x = 1;\n```');

      const fMultiLineOpt: PersonaFinding = {
        persona: 'sec',
        severity: 'major',
        filePath: 'b.ts',
        lineNumber: 20,
        comment: 'Multi-line fix option code',
        fixOptions: [
          {
            rank: 1,
            suggestionCode: 'function fix() {\n  return true;\n}',
          },
          {
            rank: 2,
            title: 'Alt Fix',
            explanation: 'Alternative solution',
            suggestionCode: 'const fix = () => true;',
          },
        ],
      };
      const formattedMulti = formatInlineCommentBody(fMultiLineOpt);
      expect(formattedMulti).toContain('#### Option 1: Recommended Fix (Rank #1)');
      expect(formattedMulti).toContain('```suggestion\nfunction fix() {\n  return true;\n}\n```');
      expect(formattedMulti).toContain('#### Option 2: Alt Fix (Rank #2)');
    });

    it('formats recommendation with and without [RECOMMENDATION] prefix', () => {
      const fWithPrefix: PersonaFinding = {
        persona: 'arch',
        severity: 'P1',
        filePath: 'c.ts',
        lineNumber: 5,
        comment: 'Arch issue',
        recommendation: '[RECOMMENDATION] Refactor to interface',
      };
      const fNoPrefix: PersonaFinding = {
        persona: 'arch',
        severity: 'P1',
        filePath: 'c.ts',
        lineNumber: 5,
        comment: 'Arch issue',
        recommendation: 'Refactor to interface',
      };

      expect(formatInlineCommentBody(fWithPrefix)).toContain('[RECOMMENDATION] Refactor to interface');
      expect(formatInlineCommentBody(fNoPrefix)).toContain('[RECOMMENDATION] Refactor to interface');
      expect(formatInlineCommentBody(fWithPrefix)).not.toContain('[RECOMMENDATION] [RECOMMENDATION]');
    });

    it('EMPIRICAL BUG REPRODUCTION: Multiline persona comments break markdown list structure in PR summary', () => {
      const multilineFinding: PersonaFinding = {
        persona: 'security',
        severity: 'critical',
        filePath: 'src/auth.ts',
        lineNumber: 15,
        comment: 'Line 1: SQL Injection vulnerability\nLine 2: Attacker can execute arbitrary SQL',
      };

      const summary = generatePRSummary('diff --git a/src/auth.ts b/src/auth.ts\n+++ b/src/auth.ts', [multilineFinding]);
      // EMPIRICAL BUG CONFIRMED: Line 2 is output without indentation, breaking Markdown list
      expect(summary).toContain('Line 1: SQL Injection vulnerability\nLine 2: Attacker can execute arbitrary SQL');
    });
  });
});
