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

import { describe, it, expect } from 'vitest';
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
