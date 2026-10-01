/**
 * Commit SHA Range & Zero-Loss Partition Manager Unit Test Suite (Tiers 1-4)
 * Location: tests/unit/shaPartitionManager.test.ts
 *
 * Requirements: R3 (Commit SHA Range & Zero-Loss File Partitioning)
 * - Tier 1: Commit SHA range formatting (base_sha...head_sha) & prompt headers
 * - Tier 2: Deterministic bin-packing partition calculation for diffs exceeding C_safe
 * - Tier 3: 100% file coverage guarantee (0 files omitted, disjoint partitions, complete union)
 * - Tier 4: PR comment coverage telemetry formatting ("Coverage: 100% (X/X files reviewed across Y partitions, 0 omitted)")
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createPartitionPlan,
  detectFileStatus,
  formatCoverageComment,
  formatPromptManifestHeader,
  DiffPartition,
  PartitionPlan,
  FileStatus,
} from '../../src/pipeline/shaPartitionManager';

// Re-export for any test suites importing from this test file
export {
  createPartitionPlan,
  detectFileStatus,
  formatCoverageComment,
  formatPromptManifestHeader,
};
export type { DiffPartition, PartitionPlan, FileStatus };

// ============================================================================
// TEST SUITE: TIERS 1 TO 4
// ============================================================================

describe('ShaPartitionManager Unit & Coverage Tests (Tiers 1-4)', () => {
  const BASE_SHA = '0123456789abcdef0123456789abcdef01234567';
  const HEAD_SHA = 'fedcba9876543210fedcba9876543210fedcba98';

  // ==========================================================================
  // TIER 1: COMMIT SHA RANGE FORMATTING & VALIDATION
  // ==========================================================================
  describe('Tier 1: Commit SHA Range Formatting & Validation', () => {
    it('TEST_T1_01: formats standard 40-character commit SHA range (base_sha...head_sha)', () => {
      const files = [{ path: 'src/main.ts', patch: '+console.log(1);' }];
      const plan = createPartitionPlan(files, BASE_SHA, HEAD_SHA, 100000);

      expect(plan.baseSha).toBe(BASE_SHA);
      expect(plan.headSha).toBe(HEAD_SHA);
      const comment = formatCoverageComment(plan);
      expect(comment).toContain(`\`${BASE_SHA}...${HEAD_SHA}\``);
    });

    it('TEST_T1_02: formats short 7-12 character SHA ranges correctly', () => {
      const shortBase = 'a1b2c3d';
      const shortHead = 'e4f5g6h';
      const plan = createPartitionPlan([{ path: 'src/lib.ts', patch: '+const x = 1;' }], shortBase, shortHead, 50000);

      expect(plan.baseSha).toBe('a1b2c3d');
      expect(plan.headSha).toBe('e4f5g6h');
      const header = formatPromptManifestHeader(plan.partitions[0], plan);
      expect(header).toContain('a1b2c3d...e4f5g6h');
    });

    it('TEST_T1_03: prompt manifest header accurately reflects partition index and total partitions', () => {
      const files = [
        { path: 'file1.ts', patch: 'A'.repeat(6000) },
        { path: 'file2.ts', patch: 'B'.repeat(6000) },
      ];
      const plan = createPartitionPlan(files, BASE_SHA, HEAD_SHA, 7000);

      expect(plan.partitions.length).toBe(2);
      const header1 = formatPromptManifestHeader(plan.partitions[0], plan);
      const header2 = formatPromptManifestHeader(plan.partitions[1], plan);

      expect(header1).toContain('Partition 1 of 2');
      expect(header1).toContain('file1.ts');
      expect(header2).toContain('Partition 2 of 2');
      expect(header2).toContain('file2.ts');
    });

    it('TEST_T1_04: rejects empty or missing SHA strings with descriptive error', () => {
      expect(() => createPartitionPlan([], '', HEAD_SHA, 10000)).toThrow('baseSha and headSha must be non-empty strings');
      expect(() => createPartitionPlan([], BASE_SHA, '', 10000)).toThrow('baseSha and headSha must be non-empty strings');
      expect(() => createPartitionPlan([], '   ', HEAD_SHA, 10000)).toThrow('baseSha and headSha must be non-empty strings');
    });

    it('TEST_T1_05: rejects invalid safeDiffChars (<0, 0, or non-finite)', () => {
      expect(() => createPartitionPlan([], BASE_SHA, HEAD_SHA, 0)).toThrow('safeDiffChars must be a positive finite number');
      expect(() => createPartitionPlan([], BASE_SHA, HEAD_SHA, -500)).toThrow('safeDiffChars must be a positive finite number');
      expect(() => createPartitionPlan([], BASE_SHA, HEAD_SHA, NaN)).toThrow('safeDiffChars must be a positive finite number');
      expect(() => createPartitionPlan([], BASE_SHA, HEAD_SHA, Infinity)).toThrow('safeDiffChars must be a positive finite number');
    });

    it('TEST_T1_06: prompt manifest header lists character count per file in partition', () => {
      const files = [
        { path: 'src/a.ts', patch: 'const a = 123;' },
        { path: 'src/b.ts', patch: 'const b = 456789;' },
      ];
      const plan = createPartitionPlan(files, BASE_SHA, HEAD_SHA, 10000);
      const header = formatPromptManifestHeader(plan.partitions[0], plan);
      expect(header).toContain('src/a.ts');
      expect(header).toContain(`${files[0].patch.length} chars`);
      expect(header).toContain('src/b.ts');
      expect(header).toContain(`${files[1].patch.length} chars`);
    });
  });

  // ==========================================================================
  // TIER 2: DETERMINISTIC BIN-PACKING PARTITION CALCULATION
  // ==========================================================================
  describe('Tier 2: Deterministic Bin-Packing Partition Calculation', () => {
    it('TEST_T2_01: diff with total size <= C_safe creates exactly 1 partition', () => {
      const files = [
        { path: 'src/a.ts', patch: 'const a = 1;'.repeat(100) }, // 1300 chars
        { path: 'src/b.ts', patch: 'const b = 2;'.repeat(100) }, // 1300 chars
      ];
      const plan = createPartitionPlan(files, BASE_SHA, HEAD_SHA, 10000);

      expect(plan.partitions.length).toBe(1);
      expect(plan.partitions[0].files.length).toBe(2);
      expect(plan.partitions[0].partitionIndex).toBe(0);
      expect(plan.partitions[0].totalPartitions).toBe(1);
    });

    it('TEST_T2_02: diff exceeding C_safe splits into minimal required bin-packed partitions', () => {
      const files = [
        { path: 'src/a.ts', patch: 'A'.repeat(4000) },
        { path: 'src/b.ts', patch: 'B'.repeat(4000) },
        { path: 'src/c.ts', patch: 'C'.repeat(4000) },
        { path: 'src/d.ts', patch: 'D'.repeat(4000) },
      ];
      const plan = createPartitionPlan(files, BASE_SHA, HEAD_SHA, 7000);

      expect(plan.partitions.length).toBe(4);
      for (const p of plan.partitions) {
        expect(p.totalChars).toBeLessThanOrEqual(7000);
      }
    });

    it('TEST_T2_03: bin-packing is deterministic across repeated calls', () => {
      const files = Array.from({ length: 20 }, (_, i) => ({
        path: `src/component_${i}.tsx`,
        patch: `export const Comp${i} = () => null;\n`.repeat(100 + (i * 10)),
      }));

      const plan1 = createPartitionPlan(files, BASE_SHA, HEAD_SHA, 30000);
      const plan2 = createPartitionPlan(files, BASE_SHA, HEAD_SHA, 30000);

      expect(plan1.partitions.length).toBe(plan2.partitions.length);
      expect(plan1.totalCompactedChars).toBe(plan2.totalCompactedChars);
      expect(JSON.stringify(plan1)).toBe(JSON.stringify(plan2));
    });

    it('TEST_T2_04: oversized single file exceeding C_safe gets dedicated partition without error', () => {
      const files = [
        { path: 'src/small1.ts', patch: 'small 1' },
        { path: 'src/giant.ts', patch: 'G'.repeat(50000) }, // 50,000 chars > limit 20,000
        { path: 'src/small2.ts', patch: 'small 2' },
      ];

      const plan = createPartitionPlan(files, BASE_SHA, HEAD_SHA, 20000);
      expect(plan.partitions.length).toBe(3);
      expect(plan.partitions[1].files[0].path).toBe('src/giant.ts');
      expect(plan.coveragePercent).toBe(100);
    });

    it('TEST_T2_05: multi-hunk oversized file splits across hunk boundaries into consecutive partitions', () => {
      const hunk1 = '@@ -1,10 +1,15 @@\n' + '+lineA\n'.repeat(500); // ~3500 chars
      const hunk2 = '@@ -50,10 +55,15 @@\n' + '+lineB\n'.repeat(500); // ~3500 chars
      const hunk3 = '@@ -100,10 +110,15 @@\n' + '+lineC\n'.repeat(500); // ~3500 chars
      const multiHunkPatch = `diff --git a/big.ts b/big.ts\n--- a/big.ts\n+++ b/big.ts\n${hunk1}\n${hunk2}\n${hunk3}\n`;

      const files = [
        { path: 'src/big.ts', patch: multiHunkPatch },
      ];

      // Limit 5000 chars => total is ~10,500 chars, splits across 3 partitions without dropping hunks
      const plan = createPartitionPlan(files, BASE_SHA, HEAD_SHA, 5000);

      expect(plan.partitions.length).toBe(3);
      expect(plan.partitions[0].files[0].patch).toContain('+lineA');
      expect(plan.partitions[1].files[0].patch).toContain('+lineB');
      expect(plan.partitions[2].files[0].patch).toContain('+lineC');
      expect(plan.coveragePercent).toBe(100);
      expect(plan.omittedFilesCount).toBe(0);
    });

    it('splits a single oversized unified hunk losslessly and recalculates each fragment range', () => {
      const filePath = 'src/large.ts';
      const fileHeader = `diff --git a/${filePath} b/${filePath}\nindex 0000000..1111111 100644\n--- a/${filePath}\n+++ b/${filePath}\n`;
      const body = [
        ' context-before',
        ...Array.from({ length: 30 }, (_unused, index) => [
          `-removed-${index}`,
          `+added-${index}`,
          `+additional-${index}`,
        ]).flat(),
        ' context-after',
      ];
      const oldCount = body.filter((line) => !line.startsWith('+')).length;
      const newCount = body.filter((line) => !line.startsWith('-')).length;
      const patch = `${fileHeader}@@ -100,${oldCount} +200,${newCount} @@ function changed() {\n${body.join('\n')}\n`;
      const plan = createPartitionPlan([{
        path: filePath,
        patch,
        originalChars: patch.length,
        compactedChars: patch.length,
        status: 'modified',
      }], BASE_SHA, HEAD_SHA, 175, { splitOversizedHunksAtLines: true });
      const pieces = plan.partitions.flatMap((partition) => partition.files);

      expect(pieces.length).toBeGreaterThan(1);
      expect(plan.partitions.every((partition) => partition.totalChars <= 175)).toBe(true);

      const hunks = pieces.flatMap((piece) => {
        const parsed: Array<{ oldStart: number; oldCount: number; newStart: number; newCount: number; body: string[] }> = [];
        let current: typeof parsed[number] | undefined;
        for (const line of piece.patch.split('\n')) {
          const match = line.match(/^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/u);
          if (match) {
            if (current) parsed.push(current);
            current = {
              oldStart: Number(match[1]),
              oldCount: Number(match[2]),
              newStart: Number(match[3]),
              newCount: Number(match[4]),
              body: [],
            };
          } else if (current && line !== '') {
            current.body.push(line);
          }
        }
        if (current) parsed.push(current);
        return parsed;
      });

      expect(hunks.length).toBeGreaterThan(1);
      expect(hunks.flatMap((hunk) => hunk.body)).toEqual(body);
      let oldConsumed = 0;
      let newConsumed = 0;
      for (const hunk of hunks) {
        const actualOldCount = hunk.body.filter((line) => !line.startsWith('+') && line !== '\\ No newline at end of file').length;
        const actualNewCount = hunk.body.filter((line) => !line.startsWith('-') && line !== '\\ No newline at end of file').length;
        const oldCursor = 100 + (oldCount === 0 ? 1 : 0) + oldConsumed;
        const newCursor = 200 + (newCount === 0 ? 1 : 0) + newConsumed;
        expect(hunk.oldStart).toBe(hunk.oldCount === 0 ? oldCursor - 1 : oldCursor);
        expect(hunk.newStart).toBe(hunk.newCount === 0 ? newCursor - 1 : newCursor);
        expect(hunk.oldCount).toBe(actualOldCount);
        expect(hunk.newCount).toBe(actualNewCount);
        oldConsumed += actualOldCount;
        newConsumed += actualNewCount;
      }
      expect(oldConsumed).toBe(oldCount);
      expect(newConsumed).toBe(newCount);
    });

    it('uses canonical zero-count anchors at insertion, deletion, mixed, and omitted-single-count boundaries', () => {
      const filePath = 'src/zero-range.ts';
      const fileHeader = 'diff --git a/' + filePath + ' b/' + filePath + '\n'
        + 'index 0000000..1111111 100644\n'
        + '--- a/' + filePath + '\n'
        + '+++ b/' + filePath + '\n';
      const cases: Array<{
        name: string;
        sourceHeader: string;
        body: string[];
        expected: Array<{ header: string; body: string[] }>;
      }> = [
        {
          name: 'mixed insertion between context lines',
          sourceHeader: '@@ -1,2 +1,4 @@',
          body: [' context-before', '+inserted-one', '+inserted-two', ' context-after'],
          expected: [
            { header: '@@ -1,1 +1,1 @@', body: [' context-before'] },
            { header: '@@ -1,0 +2,1 @@', body: ['+inserted-one'] },
            { header: '@@ -1,0 +3,1 @@', body: ['+inserted-two'] },
            { header: '@@ -2,1 +4,1 @@', body: [' context-after'] },
          ],
        },
        {
          name: 'insertion at the beginning of an empty old range',
          sourceHeader: '@@ -0,0 +1,2 @@',
          body: ['+inserted-one', '+inserted-two'],
          expected: [
            { header: '@@ -0,0 +1,1 @@', body: ['+inserted-one'] },
            { header: '@@ -0,0 +2,1 @@', body: ['+inserted-two'] },
          ],
        },
        {
          name: 'insertion at the end of an empty old range',
          sourceHeader: '@@ -2,0 +3,2 @@',
          body: ['+inserted-one', '+inserted-two'],
          expected: [
            { header: '@@ -2,0 +3,1 @@', body: ['+inserted-one'] },
            { header: '@@ -2,0 +4,1 @@', body: ['+inserted-two'] },
          ],
        },
        {
          name: 'pure deletion with an empty new range',
          sourceHeader: '@@ -3,2 +2,0 @@',
          body: ['-removed-one', '-removed-two'],
          expected: [
            { header: '@@ -3,1 +2,0 @@', body: ['-removed-one'] },
            { header: '@@ -4,1 +2,0 @@', body: ['-removed-two'] },
          ],
        },
        {
          name: 'omitted single counts with replacement',
          sourceHeader: '@@ -1 +1 @@',
          body: ['-old-line', '+new-line'],
          expected: [
            { header: '@@ -1,1 +0,0 @@', body: ['-old-line'] },
            { header: '@@ -1,0 +1,1 @@', body: ['+new-line'] },
          ],
        },
      ];

      for (const testCase of cases) {
        const sourcePatch = fileHeader + testCase.sourceHeader + '\n' + testCase.body.join('\n') + '\n';
        const expectedFragments = testCase.expected.map((fragment) => fragment.header + '\n' + fragment.body.join('\n'));
        const safeDiffChars = fileHeader.length + Math.max(...expectedFragments.map((fragment) => fragment.length + 1));
        expect(sourcePatch.length, testCase.name).toBeGreaterThan(safeDiffChars);

        const plan = createPartitionPlan([{
          path: filePath,
          patch: sourcePatch,
          originalChars: sourcePatch.length,
          compactedChars: sourcePatch.length,
          status: 'modified',
        }], BASE_SHA, HEAD_SHA, safeDiffChars, { splitOversizedHunksAtLines: true });
        const pieces = plan.partitions.flatMap((partition) => partition.files);
        const actualFragments = pieces.map((piece) => piece.patch.slice(fileHeader.length).replace(/\n+$/u, ''));

        expect(plan.partitions.every((partition) => partition.totalChars <= safeDiffChars), testCase.name).toBe(true);
        expect(actualFragments, testCase.name).toEqual(expectedFragments);
      }
    });

    it('accounts for decimal count growth at the exact JS-character cap', () => {
      const filePath = 'src/decimal-count-growth.ts';
      const fileHeader = `diff --git a/${filePath} b/${filePath}\nindex 0000000..1111111 100644\n--- a/${filePath}\n+++ b/${filePath}\n`;
      const body = Array.from({ length: 10 }, () => ' x');
      const sourcePatch = `${fileHeader}@@ -1,10 +1,10 @@\n${body.join('\n')}\n`;
      const firstNine = `@@ -1,9 +1,9 @@\n${body.slice(0, 9).join('\n')}`;
      const safeDiffChars = fileHeader.length + firstNine.length + 1 + 3;
      const plan = createPartitionPlan([{
        path: filePath,
        patch: sourcePatch,
        originalChars: sourcePatch.length,
        compactedChars: sourcePatch.length,
        status: 'modified',
      }], BASE_SHA, HEAD_SHA, safeDiffChars, { splitOversizedHunksAtLines: true });
      const pieces = plan.partitions.flatMap((partition) => partition.files);

      expect(sourcePatch.length).toBeGreaterThan(safeDiffChars);
      expect(pieces.map((piece) => piece.patch.slice(fileHeader.length).replace(/\n+$/u, ''))).toEqual([
        firstNine,
        '@@ -10,1 +10,1 @@\n x',
      ]);
      expect(pieces.every((piece) => piece.patch.length <= safeDiffChars)).toBe(true);
      expect('@@ -1,10 +1,10 @@\n' + body.join('\n')).toHaveLength(firstNine.length + 5);
    });

    it('fails closed when a range-start digit makes the next indivisible atom exceed the cap', () => {
      const filePath = 'src/decimal-start-growth.ts';
      const fileHeader = `diff --git a/${filePath} b/${filePath}\nindex 0000000..1111111 100644\n--- a/${filePath}\n+++ b/${filePath}\n`;
      const body = ['+same-width-line', '+same-width-line'];
      const sourcePatch = `${fileHeader}@@ -0,0 +9,2 @@\n${body.join('\n')}\n`;
      const firstFragment = '@@ -0,0 +9,1 @@\n+same-width-line';
      const safeDiffChars = fileHeader.length + firstFragment.length + 1;
      const plan = createPartitionPlan([{
        path: filePath,
        patch: sourcePatch,
        originalChars: sourcePatch.length,
        compactedChars: sourcePatch.length,
        status: 'modified',
      }], BASE_SHA, HEAD_SHA, safeDiffChars, { splitOversizedHunksAtLines: true });
      const pieces = plan.partitions.flatMap((partition) => partition.files);

      expect(firstFragment.length + fileHeader.length + 1).toBe(safeDiffChars);
      expect('@@ -0,0 +10,1 @@\n+same-width-line'.length + fileHeader.length + 1).toBe(safeDiffChars + 1);
      expect(pieces).toHaveLength(1);
      expect(pieces[0].patch).toBe(sourcePatch);
    });

    it('uses UTF-16 code-unit lengths for an exact-cap supplementary-character atom', () => {
      const filePath = 'src/js-character-cap.ts';
      const fileHeader = `diff --git a/${filePath} b/${filePath}\nindex 0000000..1111111 100644\n--- a/${filePath}\n+++ b/${filePath}\n`;
      const first = '@@ -0,0 +1,1 @@\n+🧪';
      const second = '@@ -0,0 +2,1 @@\n+';
      const sourcePatch = `${fileHeader}@@ -0,0 +1,2 @@\n+🧪\n+\n`;
      const safeDiffChars = fileHeader.length + Math.max(first.length, second.length) + 1;
      const plan = createPartitionPlan([{
        path: filePath,
        patch: sourcePatch,
        originalChars: sourcePatch.length,
        compactedChars: sourcePatch.length,
        status: 'modified',
      }], BASE_SHA, HEAD_SHA, safeDiffChars, { splitOversizedHunksAtLines: true });
      const pieces = plan.partitions.flatMap((partition) => partition.files);

      expect('🧪'.length).toBe(2);
      expect(pieces.map((piece) => piece.patch.slice(fileHeader.length).replace(/\n+$/u, ''))).toEqual([first, second]);
      expect(pieces.every((piece) => piece.patch.length <= safeDiffChars)).toBe(true);
      expect(Math.max(...pieces.map((piece) => piece.patch.length))).toBe(safeDiffChars);
    });

    it('keeps a no-newline marker attached to its source line while splitting', () => {
      const filePath = 'src/no-newline.ts';
      const fileHeader = 'diff --git a/' + filePath + ' b/' + filePath + '\n'
        + 'index 0000000..1111111 100644\n'
        + '--- a/' + filePath + '\n'
        + '+++ b/' + filePath + '\n';
      const oldLine = '-' + 'old-without-newline-'.repeat(3);
      const marker = '\\ No newline at end of file';
      const newLine = '+' + 'new-without-newline-'.repeat(3);
      const sourceHeader = '@@ -1 +1 @@';
      const sourcePatch = fileHeader + sourceHeader + '\n' + oldLine + '\n' + marker + '\n' + newLine + '\n';
      const expectedFragments = [
        '@@ -1,1 +0,0 @@\n' + oldLine + '\n' + marker,
        '@@ -1,0 +1,1 @@\n' + newLine,
      ];
      const safeDiffChars = fileHeader.length + Math.max(...expectedFragments.map((fragment) => fragment.length + 1));
      expect(sourcePatch.length).toBeGreaterThan(safeDiffChars);

      const plan = createPartitionPlan([{
        path: filePath,
        patch: sourcePatch,
        originalChars: sourcePatch.length,
        compactedChars: sourcePatch.length,
        status: 'modified',
      }], BASE_SHA, HEAD_SHA, safeDiffChars, { splitOversizedHunksAtLines: true });
      const pieces = plan.partitions.flatMap((partition) => partition.files);

      expect(pieces.map((piece) => piece.patch.slice(fileHeader.length).replace(/\n+$/u, '')))
        .toEqual(expectedFragments);
      expect(pieces.some((piece) => piece.patch.trimEnd().endsWith('\n' + marker))).toBe(true);
    });

    it('bounds joined-code-unit materialization while splitting a large single hunk', () => {
      const filePath = 'src/large-linear-hunk.ts';
      const fileHeader = `diff --git a/${filePath} b/${filePath}\nindex 0000000..1111111 100644\n--- a/${filePath}\n+++ b/${filePath}\n`;
      const body = Array.from({ length: 360 }, (_unused, index) =>
        ` context-${String(index).padStart(4, '0')}-${'x'.repeat(40)}`);
      const sourcePatch = `${fileHeader}@@ -1,360 +1,360 @@ large body\n${body.join('\n')}\n`;
      const safeDiffChars = fileHeader.length + 900;
      const originalJoin = Array.prototype.join;
      let joinedCodeUnits = 0;
      let plan: PartitionPlan | undefined;
      const joinSpy = vi.spyOn(Array.prototype, 'join').mockImplementation(function (this: any[], separator?: string) {
        const joined = originalJoin.apply(this, [separator]);
        joinedCodeUnits += joined.length;
        return joined;
      });
      try {
        plan = createPartitionPlan([{
          path: filePath,
          patch: sourcePatch,
          originalChars: sourcePatch.length,
          compactedChars: sourcePatch.length,
          status: 'modified',
        }], BASE_SHA, HEAD_SHA, safeDiffChars, { splitOversizedHunksAtLines: true });
      } finally {
        joinSpy.mockRestore();
      }

      expect(plan).toBeDefined();
      expect(joinedCodeUnits).toBeLessThanOrEqual(sourcePatch.length * 4);
      expect(plan!.partitions.every((partition) => partition.totalChars <= safeDiffChars)).toBe(true);
      const emittedContextLines = plan!.partitions.flatMap((partition) => partition.files)
        .flatMap((file) => file.patch.split('\n').filter((line) => line.startsWith(' context-')));
      expect(emittedContextLines).toEqual(body);
    });

    it('bounds joined-code-unit materialization while grouping many small hunks', () => {
      const filePath = 'src/many-linear-hunks.ts';
      const fileHeader = `diff --git a/${filePath} b/${filePath}\nindex 0000000..1111111 100644\n--- a/${filePath}\n+++ b/${filePath}\n`;
      const hunks = Array.from({ length: 900 }, (_unused, index) =>
        `@@ -${index + 1},1 +${index + 1},1 @@ section-${index}\n context-${String(index).padStart(4, '0')}`);
      const sourcePatch = `${fileHeader}${hunks.join('\n')}\n`;
      const safeDiffChars = fileHeader.length + 900;
      const originalJoin = Array.prototype.join;
      let joinedCodeUnits = 0;
      let plan: PartitionPlan | undefined;
      const joinSpy = vi.spyOn(Array.prototype, 'join').mockImplementation(function (this: any[], separator?: string) {
        const joined = originalJoin.apply(this, [separator]);
        joinedCodeUnits += joined.length;
        return joined;
      });
      try {
        plan = createPartitionPlan([{
          path: filePath,
          patch: sourcePatch,
          originalChars: sourcePatch.length,
          compactedChars: sourcePatch.length,
          status: 'modified',
        }], BASE_SHA, HEAD_SHA, safeDiffChars, { splitOversizedHunksAtLines: true });
      } finally {
        joinSpy.mockRestore();
      }

      expect(plan).toBeDefined();
      expect(joinedCodeUnits).toBeLessThanOrEqual(sourcePatch.length * 4);
      expect(plan!.partitions.every((partition) => partition.totalChars <= safeDiffChars)).toBe(true);
      const emittedHunks = plan!.partitions.flatMap((partition) => partition.files)
        .flatMap((file) => file.patch.split('\n').filter((line) => line.startsWith('@@')));
      const emittedContextLines = plan!.partitions.flatMap((partition) => partition.files)
        .flatMap((file) => file.patch.split('\n').filter((line) => line.startsWith(' context-')));
      expect(emittedHunks).toEqual(hunks.map((hunk) => hunk.split('\n')[0]));
      expect(emittedContextLines).toEqual(Array.from({ length: 900 }, (_unused, index) =>
        ` context-${String(index).padStart(4, '0')}`));
    });

    it('TEST_T2_06: empty input files returns single partition with 0 files and 100% coverage', () => {
      const plan = createPartitionPlan([], BASE_SHA, HEAD_SHA, 10000);
      expect(plan.partitions.length).toBe(1);
      expect(plan.partitions[0].files.length).toBe(0);
      expect(plan.totalFiles).toBe(0);
      expect(plan.coveragePercent).toBe(100);
      expect(plan.omittedFilesCount).toBe(0);
      expect(plan.fileManifest.length).toBe(0);
    });
  });

  // ==========================================================================
  // TIER 3: 100% FILE COVERAGE GUARANTEE (0 FILES OMITTED)
  // ==========================================================================
  describe('Tier 3: 100% File Coverage Guarantee (0 Files Omitted)', () => {
    it('TEST_T3_01: coveragePercent is strictly 100 and omittedFilesCount is strictly 0', () => {
      const files = Array.from({ length: 15 }, (_, i) => ({
        path: `src/mod_${i}.ts`,
        patch: `+line_${i}`,
      }));

      const plan = createPartitionPlan(files, BASE_SHA, HEAD_SHA, 50);

      expect(plan.coveragePercent).toBe(100);
      expect(plan.omittedFilesCount).toBe(0);
    });

    it('TEST_T3_02: partition file sets are strictly disjoint (no duplicate file assignments)', () => {
      const files = Array.from({ length: 30 }, (_, i) => ({
        path: `src/service_${i}.ts`,
        patch: `+code_${i}\n`.repeat(50),
      }));

      const plan = createPartitionPlan(files, BASE_SHA, HEAD_SHA, 1000);
      const seenFiles = new Set<string>();

      for (const partition of plan.partitions) {
        for (const f of partition.files) {
          expect(seenFiles.has(f.path)).toBe(false);
          seenFiles.add(f.path);
        }
      }

      expect(seenFiles.size).toBe(30);
    });

    it('TEST_T3_03: union of all partition files equals 100% of input files', () => {
      const files = Array.from({ length: 48 }, (_, i) => ({
        path: `src/telecom/file_${i}.ts`,
        patch: `// Telecom signaling module ${i}\n+export const SIP_${i} = ${i};`,
      }));

      const plan = createPartitionPlan(files, BASE_SHA, HEAD_SHA, 1500);
      const allPartitionPaths = plan.partitions.flatMap((p) => p.files.map((f) => f.path));

      expect(allPartitionPaths.sort()).toEqual(files.map((f) => f.path).sort());
      expect(plan.fileManifest.length).toBe(48);
    });

    it('TEST_T3_04: file manifest correctly marks added, modified, deleted statuses', () => {
      const files = [
        { path: 'src/new.ts', patch: 'new file mode 100644\n+new content' },
        { path: 'src/mod.ts', patch: '@@ -1,1 +1,1 @@\n-old\n+new' },
        { path: 'src/del.ts', patch: 'deleted file mode 100644\n-deleted' },
      ];

      const plan = createPartitionPlan(files, BASE_SHA, HEAD_SHA, 10000);
      expect(plan.fileManifest.find((f) => f.path === 'src/new.ts')?.status).toBe('added');
      expect(plan.fileManifest.find((f) => f.path === 'src/mod.ts')?.status).toBe('modified');
      expect(plan.fileManifest.find((f) => f.path === 'src/del.ts')?.status).toBe('deleted');
    });

    it('TEST_T3_05: supports explicit status overrides from input files', () => {
      const files = [
        { path: 'src/added.ts', patch: '+content', status: 'added' },
        { path: 'src/deleted.ts', patch: '-content', status: 'deleted' },
        { path: 'src/mod.ts', patch: '+content', status: 'modified' },
      ];

      const plan = createPartitionPlan(files, BASE_SHA, HEAD_SHA, 10000);
      expect(plan.fileManifest.find((f) => f.path === 'src/added.ts')?.status).toBe('added');
      expect(plan.fileManifest.find((f) => f.path === 'src/deleted.ts')?.status).toBe('deleted');
      expect(plan.fileManifest.find((f) => f.path === 'src/mod.ts')?.status).toBe('modified');
    });

    it('TEST_T3_06: large 100-file workload preserves 100% manifest and partition index alignment', () => {
      const files = Array.from({ length: 100 }, (_, i) => ({
        path: `packages/service_${i}/src/index.ts`,
        patch: `+export const SERVICE_${i} = "${i}";\n`.repeat(20),
      }));

      const plan = createPartitionPlan(files, BASE_SHA, HEAD_SHA, 5000);
      expect(plan.totalFiles).toBe(100);
      expect(plan.fileManifest.length).toBe(100);
      expect(plan.coveragePercent).toBe(100);
      expect(plan.omittedFilesCount).toBe(0);

      // Verify each manifest entry matches its partition index
      for (const item of plan.fileManifest) {
        const p = plan.partitions[item.partitionIndex];
        expect(p).toBeDefined();
        expect(p.files.some((f) => f.path === item.path)).toBe(true);
      }
    });
  });

  // ==========================================================================
  // TIER 4: PR COMMENT COVERAGE TELEMETRY FORMATTING
  // ==========================================================================
  describe('Tier 4: PR Comment Coverage Telemetry Formatting', () => {
    it('TEST_T4_01: comment matches exact format "Coverage: 100% (X/X files reviewed across Y partitions, 0 omitted)"', () => {
      const files = Array.from({ length: 48 }, (_, i) => ({
        path: `src/file_${i}.ts`,
        patch: `+line_${i}`,
      }));

      const plan = createPartitionPlan(files, BASE_SHA, HEAD_SHA, 200);
      const comment = formatCoverageComment(plan);

      expect(comment).toContain(`Coverage: 100% (48/48 files reviewed across ${plan.partitions.length} partitions, 0 omitted)`);
      expect(comment).toContain('_Zero files truncated or omitted under dynamic model capacity limits._');
    });

    it('TEST_T4_02: 1-file 1-partition PR comment formatting', () => {
      const plan = createPartitionPlan([{ path: 'README.md', patch: '+# Updated' }], BASE_SHA, HEAD_SHA, 10000);
      const comment = formatCoverageComment(plan);

      expect(comment).toContain('Coverage: 100% (1/1 files reviewed across 1 partitions, 0 omitted)');
      expect(comment).toContain('| `README.md` | `modified` | Lane 1/1 |');
    });

    it('TEST_T4_03: markdown table renders all rows and columns properly', () => {
      const files = [
        { path: 'src/auth.ts', patch: 'new file mode 100644\n+auth' },
        { path: 'src/db.ts', patch: '@@ -1,1 +1,1 @@\n-old\n+new' },
      ];

      const plan = createPartitionPlan(files, BASE_SHA, HEAD_SHA, 10000);
      const comment = formatCoverageComment(plan);

      expect(comment).toContain('| File Path | Status | Partition Lane |');
      expect(comment).toContain('| `src/auth.ts` | `added` | Lane 1/1 |');
      expect(comment).toContain('| `src/db.ts` | `modified` | Lane 1/1 |');
    });

    it('TEST_T4_04: formatted comment includes formatted total character count with locale separators', () => {
      const files = [
        { path: 'src/big.ts', patch: 'X'.repeat(12345) },
      ];
      const plan = createPartitionPlan(files, BASE_SHA, HEAD_SHA, 20000);
      const comment = formatCoverageComment(plan);
      expect(comment).toContain('12,345 chars');
      expect(comment).toContain('1 parallel review lanes');
    });

    it('TEST_T4_05: multi-partition PR comment renders all partition lanes in file manifest table', () => {
      const files = [
        { path: 'part1.ts', patch: 'A'.repeat(5000) },
        { path: 'part2.ts', patch: 'B'.repeat(5000) },
        { path: 'part3.ts', patch: 'C'.repeat(5000) },
      ];
      const plan = createPartitionPlan(files, BASE_SHA, HEAD_SHA, 6000);
      expect(plan.partitions.length).toBe(3);

      const comment = formatCoverageComment(plan);
      expect(comment).toContain('| `part1.ts` | `modified` | Lane 1/3 |');
      expect(comment).toContain('| `part2.ts` | `modified` | Lane 2/3 |');
      expect(comment).toContain('| `part3.ts` | `modified` | Lane 3/3 |');
    });
  });
});
