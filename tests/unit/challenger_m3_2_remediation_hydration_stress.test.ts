import { describe, it, expect } from 'vitest';
import {
  generateRemediation,
  generateRemediationForFinding,
  type FindingRemediation,
} from '../../src/review/remediationSubagent';
import {
  hydrateLeanFindingToCheckAnnotation,
  type CheckAnnotation,
} from '../../src/cli/publishingReview';
import {
  hydrateLeanFindingToCheckAnnotation as gateHydrateLean,
} from '../../src/review/reviewGatePublisher';
import type { LeanFindingSummary, FindingSeverity } from '../../src/reviewTaskContract';

describe('Challenger 2 Empirical Stress: Decoupled Remediation & Finding Hydration', () => {

  // =========================================================================
  // SUITE 1: STRESS TESTING generateRemediationForFinding
  // =========================================================================
  describe('Suite 1: generateRemediation under edge cases and adversarial inputs', () => {

    it('EMP-CHALLENGE-01: handles missing, undefined, and null source code safely without throwing', async () => {
      const finding: LeanFindingSummary = {
        severity: 'P0',
        file: 'src/core/security.ts',
        line: 15,
        fingerprint: '1111222233334444',
        summary: 'Hardcoded crypto secret token.',
      };

      const remUndefined = await generateRemediationForFinding(finding, undefined);
      expect(remUndefined).toBeDefined();
      expect(remUndefined.fingerprint).toBe(finding.fingerprint);
      expect(remUndefined.severity).toBe('P0');
      expect(remUndefined.file).toBe('src/core/security.ts');
      expect(remUndefined.line).toBe(15);
      expect(remUndefined.explanation).toContain('Source context unavailable');
      expect(remUndefined.codeReplacement).toBeUndefined();
      expect(remUndefined.fixOptions).toBeDefined();
      expect(remUndefined.fixOptions?.length).toBeGreaterThanOrEqual(2);

      const remNull = await generateRemediationForFinding(finding, null as unknown as string);
      expect(remNull.explanation).toContain('Source context unavailable');
      expect(remNull.codeReplacement).toBeUndefined();
    });

    it('EMP-CHALLENGE-02: handles empty and whitespace-only source strings', async () => {
      const finding: LeanFindingSummary = {
        severity: 'P1',
        file: 'src/api/auth.ts',
        line: 5,
        fingerprint: '5555666677778888',
        summary: 'Missing rate limiter on endpoint.',
      };

      const emptyInputs = [
        '',
        ' ',
        '   ',
        '\t',
        '\n',
        '\r\n',
        '  \n\t  \r\n \t \n  ',
      ];

      for (const input of emptyInputs) {
        const rem = await generateRemediationForFinding(finding, input);
        expect(rem.explanation).toContain('Source context unavailable');
        expect(rem.codeReplacement).toBeUndefined();
        expect(rem.fingerprint).toBe(finding.fingerprint);
      }
    });

    it('EMP-CHALLENGE-03: handles out-of-range lines (line <= 0, line > total lines, line = 1000000)', async () => {
      const code = [
        'import express from "express";', // line 1
        'const app = express();',         // line 2
        'app.listen(3000);',              // line 3
      ].join('\n');

      // Case A: line = 0
      const findingLineZero: LeanFindingSummary = {
        severity: 'P2',
        file: 'src/index.ts',
        line: 0,
        fingerprint: '0000000000000000',
        summary: 'Non-standard port number.',
      };
      const remZero = await generateRemediationForFinding(findingLineZero, code);
      expect(remZero.codeReplacement).toBeDefined();
      expect(remZero.codeReplacement?.startLine).toBe(0);
      expect(remZero.codeReplacement?.endLine).toBe(0);
      expect(remZero.codeReplacement?.originalSnippet).toBe('import express from "express";');

      // Case B: negative line = -10
      const findingNegative: LeanFindingSummary = {
        severity: 'P1',
        file: 'src/index.ts',
        line: -10,
        fingerprint: 'negnegnegnegneg1',
        summary: 'Invalid negative line coordinate.',
      };
      const remNeg = await generateRemediationForFinding(findingNegative, code);
      expect(remNeg.codeReplacement).toBeDefined();
      expect(remNeg.codeReplacement?.originalSnippet).toBe('import express from "express";');

      // Case C: line exceeding total lines
      const findingExceeding: LeanFindingSummary = {
        severity: 'P0',
        file: 'src/index.ts',
        line: 99999,
        fingerprint: '9999999999999999',
        summary: 'Out-of-range line reference.',
      };
      const remExceeding = await generateRemediationForFinding(findingExceeding, code);
      expect(remExceeding.codeReplacement).toBeDefined();
      expect(remExceeding.codeReplacement?.startLine).toBe(99999);
      expect(remExceeding.codeReplacement?.endLine).toBe(99999);
      // Clamps to last available line
      expect(remExceeding.codeReplacement?.originalSnippet).toBe('app.listen(3000);');
    });

    it('EMP-CHALLENGE-04: preserves complex multiline indentation across spaces, tabs, and mixed whitespace', async () => {
      const complexIndentedCode = [
        'class Service {',
        '  // 2 spaces',
        '  methodA() {',
        '    // 4 spaces',
        '    const a = eval(data);', // line 5
        '  }',
        '\t// 1 tab',
        '\tmethodB() {',
        '\t\t// 2 tabs',
        '\t\tconst b = eval(data);', // line 10
        '\t}',
        '        // 8 spaces',
        '        const c = nonMatchingPattern(x);', // line 13
        '}',
      ].join('\n');

      // Check line 5 (4 spaces with pattern match)
      const findingLine5: LeanFindingSummary = {
        severity: 'P0',
        file: 'src/service.ts',
        line: 5,
        fingerprint: 'line5line5line51',
        summary: 'Remote code execution.',
      };
      const rem5 = await generateRemediationForFinding(findingLine5, complexIndentedCode);
      expect(rem5.codeReplacement?.originalSnippet).toBe('    const a = eval(data);');
      expect(rem5.codeReplacement?.suggestedSnippet.startsWith('    ')).toBe(true);
      expect(rem5.codeReplacement?.suggestedSnippet).toContain('safeHandler');

      // Check line 10 (2 tabs with pattern match)
      const findingLine10: LeanFindingSummary = {
        severity: 'P0',
        file: 'src/service.ts',
        line: 10,
        fingerprint: 'line10line10line',
        summary: 'Remote code execution in tabbed block.',
      };
      const rem10 = await generateRemediationForFinding(findingLine10, complexIndentedCode);
      expect(rem10.codeReplacement?.originalSnippet).toBe('\t\tconst b = eval(data);');
      expect(rem10.codeReplacement?.suggestedSnippet.startsWith('\t\t')).toBe(true);

      // Check line 13 (8 spaces fallback comment pattern)
      const findingLine13: LeanFindingSummary = {
        severity: 'P1',
        file: 'src/service.ts',
        line: 13,
        fingerprint: 'line13line13line',
        summary: 'Unhandled input validation.',
      };
      const rem13 = await generateRemediationForFinding(findingLine13, complexIndentedCode);
      expect(rem13.codeReplacement?.originalSnippet).toBe('        const c = nonMatchingPattern(x);');
      expect(rem13.codeReplacement?.suggestedSnippet.startsWith('        /* safeHandler: remediate P1 */')).toBe(true);
    });

    it('EMP-CHALLENGE-05: handles special characters, regex literals, template backticks, XML, and emojis', async () => {
      const specialSnippets = [
        'const regex = /^[a-zA-Z0-9+_.-]+@[a-zA-Z0-9.-]+$/;',
        'const query = `SELECT * FROM users WHERE id = ${userId} AND flag = "ACTIVE";`;',
        'const element = <div className="test" dangerouslySetInnerHTML={{ __html: rawHtml }} />;',
        'const greeting = "Hello 🚀, world! ✨ 日本語テスト";',
        'const math = a + b + c + d;',
        'const escaped = "Line1\\nLine2\\tTabbed \\"Quotes\\"";',
      ];

      for (let i = 0; i < specialSnippets.length; i++) {
        const snippet = specialSnippets[i];
        const finding: LeanFindingSummary = {
          severity: 'P1',
          file: 'src/special.ts',
          line: 1,
          fingerprint: `spec${i.toString().padStart(12, '0')}`,
          summary: `Finding for snippet ${i}`,
        };

        const rem = await generateRemediationForFinding(finding, snippet);
        expect(rem.codeReplacement).toBeDefined();
        expect(rem.codeReplacement?.originalSnippet).toBe(snippet);
        expect(typeof rem.codeReplacement?.suggestedSnippet).toBe('string');
        expect(rem.codeReplacement?.suggestedSnippet.length).toBeGreaterThan(0);
        expect(rem.codeReplacement?.suggestedSnippet.length).toBeLessThanOrEqual(400);
      }
    });

    it('EMP-CHALLENGE-06: safely handles markdown syntax in code and findings without formatting destruction', async () => {
      const markdownCode = [
        '/**',
        ' * # Section 1: Authentication',
        ' * ```typescript',
        ' * const session = eval(req.headers);', // line 4
        ' * ```',
        ' */',
      ].join('\n');

      const finding: LeanFindingSummary = {
        severity: 'P0',
        file: 'src/docs.ts',
        line: 4,
        fingerprint: 'markdown11112222',
        summary: 'Insecure `eval()` inside code block **warning** [link](https://example.com)',
      };

      const rem = await generateRemediationForFinding(finding, markdownCode);
      expect(rem.codeReplacement?.originalSnippet).toBe(' * const session = eval(req.headers);');
      expect(rem.codeReplacement?.suggestedSnippet).toContain('safeHandler');
      expect(rem.explanation).toContain(finding.summary);
    });

    it('EMP-CHALLENGE-07: clamps oversized lines to <= 400 characters', async () => {
      const massiveLine = 'const bundle = ' + 'a + b + '.repeat(100) + 'c;';
      expect(massiveLine.length).toBeGreaterThan(400);

      const finding: LeanFindingSummary = {
        severity: 'P2',
        file: 'src/bundle.js',
        line: 1,
        fingerprint: 'bundle1234567890',
        summary: 'Minified bundle concatenation.',
      };

      const rem = await generateRemediationForFinding(finding, massiveLine);
      expect(rem.codeReplacement?.suggestedSnippet.length).toBeLessThanOrEqual(400);
    });
  });

  // =========================================================================
  // SUITE 2: STRESS TESTING hydrateLeanFindingToCheckAnnotation
  // =========================================================================
  describe('Suite 2: hydrateLeanFindingToCheckAnnotation line anchoring and clamping constraints', () => {

    it('EMP-CHALLENGE-08: guarantees strict line anchoring (start_line = finding.line = end_line)', () => {
      const testLines = [1, 2, 42, 100, 9999, 1000000];

      for (const line of testLines) {
        const finding: LeanFindingSummary = {
          severity: 'P0',
          file: 'src/core/token.ts',
          line,
          fingerprint: `line${line.toString().padStart(12, '0')}`,
          summary: `Critical finding on line ${line}.`,
        };

        const ann = hydrateLeanFindingToCheckAnnotation(finding);
        expect(ann).not.toBeNull();
        expect(ann?.start_line).toBe(line);
        expect(ann?.end_line).toBe(line);
        expect(ann?.start_line).toBe(ann?.end_line);
      }
    });

    it('EMP-CHALLENGE-09: normalizes boundary / invalid line numbers (0, negative, NaN, floats) to line 1', () => {
      const invalidLines = [0, -1, -500, NaN, 1.5, Infinity, -Infinity];

      for (const line of invalidLines) {
        const finding: LeanFindingSummary = {
          severity: 'P1',
          file: 'src/boundary.ts',
          line: line as number,
          fingerprint: 'bound12345678901',
          summary: `Boundary line test for ${line}.`,
        };

        const ann = hydrateLeanFindingToCheckAnnotation(finding);
        expect(ann).not.toBeNull();
        expect(ann?.start_line).toBe(1);
        expect(ann?.end_line).toBe(1);
        expect(ann?.start_line).toBe(ann?.end_line);
      }
    });

    it('EMP-CHALLENGE-10: enforces title clamping <= 120 chars with required severity prefix for P0, P1, P2', () => {
      const severities: FindingSeverity[] = ['P0', 'P1', 'P2'];
      const testLengths = [10, 50, 110, 115, 116, 120, 121, 200, 500, 5000];

      for (const sev of severities) {
        for (const len of testLengths) {
          const summary = 'X'.repeat(len);
          const finding: LeanFindingSummary = {
            severity: sev,
            file: 'src/service.ts',
            line: 42,
            fingerprint: 'title12345678901',
            summary,
          };

          const ann = hydrateLeanFindingToCheckAnnotation(finding);
          expect(ann).not.toBeNull();
          expect(ann?.title).toBeDefined();
          expect(ann?.title?.length).toBeLessThanOrEqual(120);
          expect(ann?.title?.startsWith(`${sev}: `)).toBe(true);

          if (len <= 116) {
            // "${sev}: " is 4 chars, so total is 4 + len <= 120
            expect(ann?.title).toBe(`${sev}: ${summary}`);
          }
        }
      }
    });

    it('EMP-CHALLENGE-11: handles unicode multi-byte characters and emojis in title clamping <= 120 chars', () => {
      const emojiSummary = '🚨 Security Breach: ' + '🔒'.repeat(150);
      const finding: LeanFindingSummary = {
        severity: 'P0',
        file: 'src/crypto.ts',
        line: 1,
        fingerprint: 'emoji12345678901',
        summary: emojiSummary,
      };

      const ann = hydrateLeanFindingToCheckAnnotation(finding);
      expect(ann?.title?.length).toBeLessThanOrEqual(120);
      expect(ann?.title?.startsWith('P0: ')).toBe(true);
    });

    it('EMP-CHALLENGE-12: strictly clamps message body <= 4000 chars across massive summaries and remediations', () => {
      const finding: LeanFindingSummary = {
        severity: 'P0',
        file: 'src/huge.ts',
        line: 10,
        fingerprint: 'huge123456789012',
        summary: 'Massive finding summary. '.repeat(300), // ~6600 chars
      };

      // Case A: Finding summary alone exceeds 4000 characters
      const annSummaryOnly = hydrateLeanFindingToCheckAnnotation(finding);
      expect(annSummaryOnly?.message.length).toBeLessThanOrEqual(4000);
      expect(annSummaryOnly?.message.length).toBe(4000);

      // Case B: Combined summary, explanation (10k chars), and suggestedSnippet (5k chars)
      const hugeRemediation: FindingRemediation = {
        fingerprint: finding.fingerprint,
        explanation: 'Very long explanation. '.repeat(500),
        codeReplacement: {
          startLine: 10,
          endLine: 10,
          originalSnippet: 'bad();',
          suggestedSnippet: 'good();'.repeat(1000),
        },
      };

      const annCombined = hydrateLeanFindingToCheckAnnotation(finding, hugeRemediation);
      expect(annCombined?.message.length).toBeLessThanOrEqual(4000);
      expect(annCombined?.message.length).toBe(4000);

      // Case C: Exact boundary test: 3999, 4000, 4001 characters
      const f3999: LeanFindingSummary = { ...finding, summary: 'A'.repeat(3999) };
      const f4000: LeanFindingSummary = { ...finding, summary: 'A'.repeat(4000) };
      const f4001: LeanFindingSummary = { ...finding, summary: 'A'.repeat(4001) };

      expect(hydrateLeanFindingToCheckAnnotation(f3999)?.message.length).toBe(3999);
      expect(hydrateLeanFindingToCheckAnnotation(f4000)?.message.length).toBe(4000);
      expect(hydrateLeanFindingToCheckAnnotation(f4001)?.message.length).toBe(4000);
    });

    it('EMP-CHALLENGE-13: maps severity to correct GitHub annotation_level (P0/P1 -> failure, P2 -> notice)', () => {
      const base: LeanFindingSummary = {
        severity: 'P0',
        file: 'src/levels.ts',
        line: 10,
        fingerprint: 'levels1234567890',
        summary: 'Severity level check.',
      };

      const p0Ann = hydrateLeanFindingToCheckAnnotation({ ...base, severity: 'P0' });
      expect(p0Ann?.annotation_level).toBe('failure');

      const p1Ann = hydrateLeanFindingToCheckAnnotation({ ...base, severity: 'P1' });
      expect(p1Ann?.annotation_level).toBe('failure');

      const p2Ann = hydrateLeanFindingToCheckAnnotation({ ...base, severity: 'P2' });
      expect(p2Ann?.annotation_level).toBe('notice');
    });

    it('EMP-CHALLENGE-14: filters out findings not present in changedFiles when whitelist provided', () => {
      const changed = ['src/a.ts', 'src/b.ts'];
      const findingA: LeanFindingSummary = {
        severity: 'P1',
        file: 'src/a.ts',
        line: 1,
        fingerprint: 'fileA12345678901',
        summary: 'Finding in changed file A',
      };
      const findingC: LeanFindingSummary = {
        severity: 'P1',
        file: 'src/c.ts',
        line: 1,
        fingerprint: 'fileC12345678901',
        summary: 'Finding in untouched file C',
      };

      expect(hydrateLeanFindingToCheckAnnotation(findingA, undefined, changed)).not.toBeNull();
      expect(hydrateLeanFindingToCheckAnnotation(findingC, undefined, changed)).toBeNull();

      // If changedFiles is undefined, unconstrained
      expect(hydrateLeanFindingToCheckAnnotation(findingC, undefined, undefined)).not.toBeNull();
    });
  });

  // =========================================================================
  // SUITE 3: PROPERTY-BASED RANDOMIZED STRESS & COMPOSITION
  // =========================================================================
  describe('Suite 3: Property-based fuzzing and composition of remediation -> hydration', () => {

    it('EMP-CHALLENGE-15: 100 randomized finding & code scenarios all satisfy contract invariants', async () => {
      const severities: FindingSeverity[] = ['P0', 'P1', 'P2'];
      const sampleCodes = [
        undefined,
        '',
        '   ',
        'const x = 1;',
        'const data = eval(req.body);',
        'function test() {\n  const x = eval(a);\n  return x;\n}',
        '/* comment */\n\t\tconst inner = innerHTML;\n',
        'line\n'.repeat(50),
        'const special = `hello ${user + 1}`;',
        '<div dangerouslySetInnerHTML={{ __html: x }} />',
      ];

      for (let i = 0; i < 100; i++) {
        const severity = severities[i % severities.length];
        const line = (i % 20 === 0) ? -i : (i % 7 === 0) ? 0 : (i * 3 + 1);
        const code = sampleCodes[i % sampleCodes.length];
        const summary = (i % 3 === 0)
          ? `Defect #${i}: ` + 'details '.repeat(i * 2)
          : `Concise defect #${i}`;

        const finding: LeanFindingSummary = {
          severity,
          file: `src/generated/file_${i % 5}.ts`,
          line,
          fingerprint: `fuzz${i.toString().padStart(12, '0')}`,
          summary,
        };

        const remediation = await generateRemediationForFinding(finding, code);
        expect(remediation.fingerprint).toBe(finding.fingerprint);
        expect(remediation.severity).toBe(finding.severity);

        const annotation = hydrateLeanFindingToCheckAnnotation(finding, remediation);
        expect(annotation).not.toBeNull();
        if (annotation) {
          // Invariant 1: start_line === end_line
          expect(annotation.start_line).toBe(annotation.end_line);

          // Invariant 2: start_line >= 1
          expect(annotation.start_line).toBeGreaterThanOrEqual(1);

          // Invariant 3: title <= 120 chars
          expect(annotation.title?.length).toBeLessThanOrEqual(120);

          // Invariant 4: title starts with severity prefix
          expect(annotation.title?.startsWith(`${severity}: `)).toBe(true);

          // Invariant 5: message body <= 4000 chars
          expect(annotation.message.length).toBeLessThanOrEqual(4000);

          // Invariant 6: annotation_level matches severity
          expect(annotation.annotation_level).toBe(severity === 'P2' ? 'notice' : 'failure');

          // Invariant 7: path matches finding.file
          expect(annotation.path).toBe(finding.file);
        }
      }
    });

    it('EMP-CHALLENGE-16: verified consistency between publishingReview and reviewGatePublisher exports', () => {
      const finding: LeanFindingSummary = {
        severity: 'P1',
        file: 'src/exportTest.ts',
        line: 12,
        fingerprint: 'export1234567890',
        summary: 'Re-export parity verification.',
      };

      const ann1 = hydrateLeanFindingToCheckAnnotation(finding);
      const ann2 = gateHydrateLean(finding);

      expect(ann1).toEqual(ann2);
    });
  });
});
