/**
 * Diff Compactor Unit & Invariance Test Suite (Tiers 1-4)
 * Location: tests/unit/diffCompactor.test.ts
 *
 * Requirements: R2 (Diff Compaction Engine & Line Number Invariance)
 * - Tier 1: Standard diff compaction, context collapsing to +/- 3 lines, lockfile/minified stripping, whitespace compaction
 * - Tier 2: Boundary cases (single line edits, zero context lines, empty diff, malformed headers, lines >500 chars)
 * - Tier 3: Line number invariance check ensuring changedLineNumbers(compactedPatch) matches changedLineNumbers(originalPatch) exactly across git diff formats
 * - Tier 4: Large multi-file diffs with cluster splitting (>6 context line gap) and savings ratio verification
 */

import { describe, it, expect } from 'vitest';
import {
  DiffCompactionOptions,
  CompactedDiffResult,
  CompactedFileListResult,
  LOCKFILE_PATTERNS,
  MINIFIED_PATTERNS,
  ChangedLineRecord,
  extractChangedLineNumbers,
  compactUnifiedDiff,
  compactFileListDiffs,
} from '../../src/pipeline/diffCompactor';

export {
  DiffCompactionOptions,
  CompactedDiffResult,
  CompactedFileListResult,
  LOCKFILE_PATTERNS,
  MINIFIED_PATTERNS,
  ChangedLineRecord,
  extractChangedLineNumbers,
  compactUnifiedDiff,
  compactFileListDiffs,
};

// ============================================================================
// TEST SUITE: TIERS 1 TO 4
// ============================================================================

describe('DiffCompactor Unit & Invariance Tests (Tiers 1-4)', () => {

  // ==========================================================================
  // TIER 1: STANDARD DIFF COMPACTION & CONTEXT COLLAPSING
  // ==========================================================================
  describe('Tier 1: Standard Context Compaction (+/- 3 Lines)', () => {
    it('TEST_T1_01: collapses large unchanged context to exactly +/- 3 lines around change', () => {
      const originalDiff = [
        'diff --git a/src/server.ts b/src/server.ts',
        '--- a/src/server.ts',
        '+++ b/src/server.ts',
        '@@ -1,25 +1,25 @@',
        ' context line 1',
        ' context line 2',
        ' context line 3',
        ' context line 4',
        ' context line 5',
        ' context line 6',
        ' context line 7',
        ' context line 8',
        ' context line 9',
        ' context line 10',
        '-const timeout = 1000;',
        '+const timeout = 5000;',
        ' context line 12',
        ' context line 13',
        ' context line 14',
        ' context line 15',
        ' context line 16',
        ' context line 17',
        ' context line 18',
        ' context line 19',
        ' context line 20',
      ].join('\n');

      const result = compactUnifiedDiff(originalDiff, { contextLines: 3 });

      expect(result.compactedChars).toBeLessThan(result.originalChars);
      expect(result.savingsRatio).toBeGreaterThan(0.3);
      expect(result.hunkCount).toBe(1);

      // Verify that only context lines 8, 9, 10 before and 12, 13, 14 after are present
      expect(result.compactedPatch).toContain('context line 8');
      expect(result.compactedPatch).toContain('context line 9');
      expect(result.compactedPatch).toContain('context line 10');
      expect(result.compactedPatch).not.toContain('context line 1\n');
      expect(result.compactedPatch).not.toContain('context line 2\n');
      expect(result.compactedPatch).toContain('context line 14');
      expect(result.compactedPatch).not.toContain('context line 19');
    });

    it('TEST_T1_02: correctly recalculates hunk headers @@ -oldStart,oldCount +newStart,newCount @@', () => {
      const originalDiff = [
        '@@ -100,20 +100,20 @@ function processRequest()',
        ' ctx 100',
        ' ctx 101',
        ' ctx 102',
        ' ctx 103',
        ' ctx 104',
        ' ctx 105',
        '-oldAction();',
        '+newAction();',
        ' ctx 107',
        ' ctx 108',
        ' ctx 109',
        ' ctx 110',
        ' ctx 111',
      ].join('\n');

      const result = compactUnifiedDiff(originalDiff, { contextLines: 3 });

      // Change at 106. 3 lines before: 103, 104, 105 (starts at 103). 3 lines after: 107, 108, 109.
      // Total lines kept: 3 ctx + 1 change + 3 ctx = 7 lines.
      expect(result.compactedPatch).toContain('@@ -103,7 +103,7 @@');
      expect(result.compactedPatch).toContain('-oldAction();');
      expect(result.compactedPatch).toContain('+newAction();');
    });

    it('TEST_T1_03: compactFileListDiffs strips package-lock.json and cargo.lock into summaries', () => {
      const files = [
        { path: 'package-lock.json', patch: '+\"version\": \"2.0.0\"\n'.repeat(500) },
        { path: 'cargo.lock', patch: '+\"checksum\": \"abcdef\"\n'.repeat(300) },
        { path: 'src/main.rs', patch: '@@ -1,5 +1,5 @@\n ctx\n-old\n+new\n ctx\n' },
      ];

      const res = compactFileListDiffs(files, { stripMinified: true });

      expect(res.files.length).toBe(3);
      expect(res.files[0].patch).toContain('Lockfile diff stripped');
      expect(res.files[1].patch).toContain('Lockfile diff stripped');
      expect(res.files[2].patch).toContain('+new');
      expect(res.totalSavingsRatio).toBeGreaterThan(0.8);
    });

    it('TEST_T1_04: strips minified bundle and sourcemap files from diff list', () => {
      const files = [
        { path: 'dist/app.min.js', patch: 'var a=1,b=2,c=3;'.repeat(100) },
        { path: 'dist/app.js.map', patch: '{"version":3,"sources":[]}' },
        { path: 'src/app.ts', patch: '@@ -1,3 +1,3 @@\n-const x = 1;\n+const x = 2;\n' },
      ];

      const res = compactFileListDiffs(files, { stripMinified: true });

      expect(res.files[0].patch).toContain('Generated/Minified artifact stripped');
      expect(res.files[1].patch).toContain('Generated/Minified artifact stripped');
      expect(res.files[2].patch).toContain('+const x = 2;');
    });

    it('TEST_T1_05: normalizes trailing whitespace on context lines while preserving patch semantics', () => {
      const diffWithWhitespace = [
        '@@ -1,7 +1,7 @@',
        ' line 1    \t  ',
        ' line 2        ',
        '-line 3',
        '+line 3 changed',
        ' line 4   ',
      ].join('\n');

      const res = compactUnifiedDiff(diffWithWhitespace);
      expect(res.compactedPatch).toContain(' line 1');
      expect(res.compactedPatch).not.toMatch(/line 1\s{4,}/);
      expect(res.compactedPatch).toContain('+line 3 changed');
    });
  });

  // ==========================================================================
  // TIER 2: BOUNDARY CASES & EDGE CONDITIONS
  // ==========================================================================
  describe('Tier 2: Boundary Cases & Edge Conditions', () => {
    it('TEST_T2_01: single line addition with 0 context lines handles gracefully', () => {
      const diff = '@@ -1,0 +1,1 @@\n+export const VERSION = "1.0.0";\n';
      const res = compactUnifiedDiff(diff, { contextLines: 3 });

      expect(res.hunkCount).toBe(1);
      expect(res.compactedPatch).toContain('+export const VERSION = "1.0.0";');
    });

    it('TEST_T2_02: single line deletion with 0 context lines handles gracefully', () => {
      const diff = '@@ -1,1 +1,0 @@\n-deprecatedFunction();\n';
      const res = compactUnifiedDiff(diff, { contextLines: 3 });

      expect(res.hunkCount).toBe(1);
      expect(res.compactedPatch).toContain('-deprecatedFunction();');
    });

    it('TEST_T2_03: completely empty diff string returns 0 chars and 0 savings safely', () => {
      const res = compactUnifiedDiff('');
      expect(res.compactedChars).toBe(0);
      expect(res.originalChars).toBe(0);
      expect(res.savingsRatio).toBe(0);
      expect(res.hunkCount).toBe(0);
    });

    it('TEST_T2_04: whitespace-only diff returns empty string without error', () => {
      const res = compactUnifiedDiff('   \n\n\t  \n');
      expect(res.compactedChars).toBe(0);
      expect(res.hunkCount).toBe(0);
    });

    it('TEST_T2_05: lines exceeding 500 characters trigger overlong line detection in strippedArtifacts', () => {
      const longLine = '+' + 'a'.repeat(550);
      const diff = `@@ -1,2 +1,2 @@\n context\n${longLine}\n`;

      const res = compactUnifiedDiff(diff, { maxLineLength: 500 });
      expect(res.strippedArtifacts).toContain('overlong_lines_exceeding_500_chars');
    });

    it('TEST_T2_06: exactly 500 char lines do not trigger overlong detection', () => {
      const exact500 = '+' + 'a'.repeat(499); // 1 char '+' + 499 chars = 500
      const diff = `@@ -1,2 +1,2 @@\n context\n${exact500}\n`;

      const res = compactUnifiedDiff(diff, { maxLineLength: 500 });
      expect(res.strippedArtifacts).not.toContain('overlong_lines_exceeding_500_chars');
    });

    it('TEST_T2_07: diff with only header metadata and no hunk content yields clean output', () => {
      const diff = 'diff --git a/file.txt b/file.txt\nnew file mode 100644\n';
      const res = compactUnifiedDiff(diff);
      expect(res.hunkCount).toBe(0);
      expect(res.compactedPatch).toContain('diff --git a/file.txt b/file.txt');
    });

    it('TEST_T2_08: handles "\\ No newline at end of file" marker without corrupting hunk structure', () => {
      const diff = [
        '@@ -1,3 +1,3 @@',
        ' ctx 1',
        '-old end',
        '\\ No newline at end of file',
        '+new end',
        '\\ No newline at end of file',
      ].join('\n');

      const res = compactUnifiedDiff(diff);
      expect(res.compactedPatch).toContain('\\ No newline at end of file');
      expect(res.compactedPatch).toContain('+new end');
    });
  });

  // ==========================================================================
  // TIER 3: LINE NUMBER INVARIANCE GUARANTEE (changedLineNumbers)
  // ==========================================================================
  describe('Tier 3: Line Number Invariance Guarantee', () => {
    it('TEST_T3_01: changedLineNumbers produces identical line numbers before and after compaction', () => {
      const originalDiff = [
        'diff --git a/src/calc.ts b/src/calc.ts',
        '--- a/src/calc.ts',
        '+++ b/src/calc.ts',
        '@@ -50,30 +50,31 @@ export function calculate()',
        ' ctx 50',
        ' ctx 51',
        ' ctx 52',
        ' ctx 53',
        ' ctx 54',
        ' ctx 55',
        ' ctx 56',
        ' ctx 57',
        '-const result = a + b;',
        '+const result = safeAdd(a, b);',
        '+logger.info("calculation complete");',
        ' ctx 59',
        ' ctx 60',
        ' ctx 61',
        ' ctx 62',
        ' ctx 63',
        ' ctx 64',
        ' ctx 65',
        ' ctx 66',
        ' ctx 67',
        ' ctx 68',
      ].join('\n');

      const origLines = extractChangedLineNumbers(originalDiff);
      const compacted = compactUnifiedDiff(originalDiff, { contextLines: 3 });
      const compLines = extractChangedLineNumbers(compacted.compactedPatch);

      expect(compLines.length).toBe(origLines.length);
      expect(compLines).toEqual(origLines);

      // Verify exact line numbers
      expect(origLines[0]).toEqual({
        type: 'delete',
        oldLineNumber: 58,
        content: 'const result = a + b;',
      });
      expect(origLines[1]).toEqual({
        type: 'add',
        newLineNumber: 58,
        content: 'const result = safeAdd(a, b);',
      });
      expect(origLines[2]).toEqual({
        type: 'add',
        newLineNumber: 59,
        content: 'logger.info("calculation complete");',
      });
    });

    it('TEST_T3_02: invariance holds for multi-hunk diffs with different line offsets', () => {
      const multiHunkDiff = [
        'diff --git a/src/multi.ts b/src/multi.ts',
        '@@ -10,20 +10,20 @@',
        ' ctx 10',
        ' ctx 11',
        ' ctx 12',
        ' ctx 13',
        ' ctx 14',
        '-oldHunk1();',
        '+newHunk1();',
        ' ctx 16',
        ' ctx 17',
        ' ctx 18',
        ' ctx 19',
        ' ctx 20',
        '@@ -200,20 +200,20 @@',
        ' ctx 200',
        ' ctx 201',
        ' ctx 202',
        ' ctx 203',
        ' ctx 204',
        '-oldHunk2();',
        '+newHunk2();',
        ' ctx 206',
        ' ctx 207',
        ' ctx 208',
        ' ctx 209',
        ' ctx 210',
      ].join('\n');

      const origLines = extractChangedLineNumbers(multiHunkDiff);
      const compacted = compactUnifiedDiff(multiHunkDiff, { contextLines: 3 });
      const compLines = extractChangedLineNumbers(compacted.compactedPatch);

      expect(compLines).toEqual(origLines);
      expect(origLines[0].oldLineNumber).toBe(15);
      expect(origLines[0].content).toBe('oldHunk1();');
      expect(origLines[1].newLineNumber).toBe(15);
      expect(origLines[1].content).toBe('newHunk1();');
      expect(origLines[2].oldLineNumber).toBe(205);
      expect(origLines[2].content).toBe('oldHunk2();');
      expect(origLines[3].newLineNumber).toBe(205);
      expect(origLines[3].content).toBe('newHunk2();');
    });

    it('TEST_T3_03: invariance holds across varying contextLines configurations (1, 2, 3, 5)', () => {
      const sampleDiff = [
        '@@ -30,25 +30,25 @@',
        ' c30', ' c31', ' c32', ' c33', ' c34', ' c35', ' c36', ' c37', ' c38', ' c39',
        '-modifyOld();',
        '+modifyNew();',
        ' c41', ' c42', ' c43', ' c44', ' c45', ' c46', ' c47', ' c48', ' c49', ' c50',
      ].join('\n');

      const expectedChanges = extractChangedLineNumbers(sampleDiff);

      for (const k of [1, 2, 3, 5]) {
        const compacted = compactUnifiedDiff(sampleDiff, { contextLines: k });
        const compChanges = extractChangedLineNumbers(compacted.compactedPatch);
        expect(compChanges).toEqual(expectedChanges);
      }
    });

    it('TEST_T3_04: multiple contiguous insertions and deletions preserve accurate target line numbers', () => {
      const complexHunk = [
        '@@ -1,15 +1,17 @@',
        ' c1', ' c2', ' c3', ' c4',
        '-del1',
        '-del2',
        '-del3',
        '+add1',
        '+add2',
        '+add3',
        '+add4',
        '+add5',
        ' c8', ' c9', ' c10',
      ].join('\n');

      const origLines = extractChangedLineNumbers(complexHunk);
      const compRes = compactUnifiedDiff(complexHunk, { contextLines: 2 });
      const compLines = extractChangedLineNumbers(compRes.compactedPatch);

      expect(compLines).toEqual(origLines);
      expect(compLines.filter((l) => l.type === 'delete').length).toBe(3);
      expect(compLines.filter((l) => l.type === 'add').length).toBe(5);
    });
  });

  // ==========================================================================
  // TIER 4: CLUSTER SPLITTING & LARGE MULTI-FILE WORKLOADS
  // ==========================================================================
  describe('Tier 4: Cluster Splitting & Large Multi-File Workloads', () => {
    it('TEST_T4_01: splits distant changes (>6 context lines gap) into distinct hunks', () => {
      const distantHunk = [
        '@@ -1,40 +1,40 @@',
        ' ctx 1',
        ' ctx 2',
        '+changeTop();',
        ' ctx 4',
        ' ctx 5',
        ' ctx 6',
        ' ctx 7',
        ' ctx 8',
        ' ctx 9',
        ' ctx 10',
        ' ctx 11',
        ' ctx 12',
        ' ctx 13',
        ' ctx 14',
        ' ctx 15',
        '+changeBottom();',
        ' ctx 17',
        ' ctx 18',
      ].join('\n');

      const res = compactUnifiedDiff(distantHunk, { contextLines: 3, splitClusterGaps: true, maxClusterGap: 6 });

      expect(res.hunkCount).toBe(2);
      expect(res.compactedPatch.match(/@@/g)?.length).toBe(4); // 2 header starts (@@ ... @@)

      // Verify line numbers are still invariant after splitting
      const origLines = extractChangedLineNumbers(distantHunk);
      const compLines = extractChangedLineNumbers(res.compactedPatch);
      expect(compLines).toEqual(origLines);
    });

    it('TEST_T4_02: does not split changes when gap is <= maxClusterGap', () => {
      const nearHunk = [
        '@@ -1,20 +1,20 @@',
        ' ctx 1',
        '+change1();',
        ' ctx 3',
        ' ctx 4',
        ' ctx 5',
        ' ctx 6', // gap of 4 lines <= 6
        '+change2();',
        ' ctx 8',
      ].join('\n');

      const res = compactUnifiedDiff(nearHunk, { contextLines: 3, splitClusterGaps: true, maxClusterGap: 6 });
      expect(res.hunkCount).toBe(1);
    });

    it('TEST_T4_03: massive 1500-line multi-file diff achieves >40% compaction while maintaining 100% line invariance', () => {
      const files: Array<{ path: string; patch: string }> = [];

      for (let f = 1; f <= 10; f++) {
        const hunkLines: string[] = ['diff --git a/mod' + f + '.ts b/mod' + f + '.ts', '@@ -1,150 +1,150 @@'];
        for (let l = 1; l <= 150; l++) {
          if (l === 25) {
            hunkLines.push('-const oldConfig = false;');
            hunkLines.push('+const newConfig = true;');
          } else if (l === 120) {
            hunkLines.push('+emitTelemetryEvent("MOD_' + f + '");');
          } else {
            hunkLines.push(` context line ${l} in module ${f}`);
          }
        }
        files.push({ path: `src/mod${f}.ts`, patch: hunkLines.join('\n') });
      }

      const res = compactFileListDiffs(files, { contextLines: 3, splitClusterGaps: true, maxClusterGap: 6 });

      expect(res.files.length).toBe(10);
      expect(res.totalSavingsRatio).toBeGreaterThan(0.5); // > 50% savings

      // Verify every file maintains exact line number invariance
      for (let f = 0; f < 10; f++) {
        const origChanges = extractChangedLineNumbers(files[f].patch);
        const compChanges = extractChangedLineNumbers(res.files[f].patch);
        expect(compChanges).toEqual(origChanges);
      }
    });
  });
});
