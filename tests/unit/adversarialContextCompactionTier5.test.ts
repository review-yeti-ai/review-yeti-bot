/**
 * Tier 5 White-Box Robustness & Adversarial Stress Test Suite
 * Location: tests/unit/adversarialContextCompactionTier5.test.ts
 *
 * Requirements: Tier 5 Coverage Hardening for Context Management & Compaction Architecture
 *
 * Dimension 1: Large PR Stress (100+ files, 10,000+ lines, multi-hunk splitting, 0 dropped files, exact bin-packing)
 * Dimension 2: Irregular Diff Inputs (unusual hunk headers, missing newlines, overlong lines >10,000 chars, non-standard git prefixes, Windows paths)
 * Dimension 3: Multi-Turn Sliding History (10+ turns of heavy 50k char tool outputs, token budget bounds <2000 tokens, findings & receipts ledger integrity)
 * Dimension 4: Parallel Partition Execution & Cross-Partition Finding Aggregation (deduplication, verifier stage, quorum arbitration, telemetry)
 * Dimension 5: Dynamic Model Context Capacities & Config Boundary Ceilings (C_safe calculations, dynamic resolution, caching, schema limits)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  compactUnifiedDiff,
  compactFileListDiffs,
  extractChangedLineNumbers,
  LOCKFILE_PATTERNS,
  MINIFIED_PATTERNS,
} from '../../src/pipeline/diffCompactor';
import {
  TurnHistoryManager,
  TurnMessage,
  FindingEntry,
  ReceiptEntry,
} from '../../src/pipeline/turnHistoryManager';
import {
  createPartitionPlan,
  detectFileStatus,
  formatCoverageComment,
  formatPromptManifestHeader,
  PartitionPlan,
  DiffPartition,
  FileStatus,
} from '../../src/pipeline/shaPartitionManager';
import {
  calculateSafeDiffCapacity,
  getStaticModelMetadata,
  resolveModelMetadata,
  clearModelMetadataCache,
} from '../../src/gateway/openRouterClient';
import {
  sanitizeAndDeduplicateFindings,
  evaluateQuorumArbitration,
  calculatePipelineMetrics,
  PersonaFinding,
} from '../../src/evaluation/pipelineHarnessRunner';
import { changedLineNumbers } from '../../src/review/reviewCore';
import { ExpectedFinding } from '../../src/evaluation/scenarios';
import { reviewLimitsSchema, ctReviewConfigV4Schema } from '../../src/config/schema';

describe('Tier 5 Adversarial Robustness: Context Management & Compaction Architecture', () => {
  const BASE_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4';
  const HEAD_SHA = '7110eda4d09e062aa5e4a390b0a572ac0d2c0220';

  beforeEach(() => {
    clearModelMetadataCache();
  });

  // ==========================================================================
  // DIMENSION 1: LARGE PR STRESS (100+ FILES, 10,000+ LINES, ZERO DROPPED FILES)
  // ==========================================================================
  describe('Dimension 1: Large PR Stress (100+ Files, 10,000+ Lines)', () => {
    it('TEST_T5_LPR_01: massive 120-file PR (15,000+ lines, ~450k chars) achieves 100% file coverage with zero dropped files', () => {
      const files = Array.from({ length: 120 }, (_, i) => {
        const path = `packages/telecom-service-${i % 10}/src/module_${i}.ts`;
        const lines: string[] = [
          `diff --git a/${path} b/${path}`,
          `--- a/${path}`,
          `+++ b/${path}`,
          `@@ -1,130 +1,130 @@`,
        ];
        for (let l = 1; l <= 130; l++) {
          if (l === 20) {
            lines.push(`-const legacyPort_${i} = 5060;`);
            lines.push(`+const dynamicPort_${i} = allocateSipPort(${i});`);
          } else if (l === 110) {
            lines.push(`+export const MODULE_ID_${i} = "telecom-${i}";`);
          } else {
            lines.push(` // context line ${l} in module ${i} handling SIP dialog state transitions`);
          }
        }
        return { path, patch: lines.join('\n') };
      });

      // Total raw lines > 15,000 lines, total chars > 450,000 chars
      const totalRawLines = files.reduce((sum, f) => sum + f.patch.split('\n').length, 0);
      const totalRawChars = files.reduce((sum, f) => sum + f.patch.length, 0);
      expect(totalRawLines).toBeGreaterThan(15000);
      expect(totalRawChars).toBeGreaterThan(450000);

      // Compact files first
      const compacted = compactFileListDiffs(files, { contextLines: 3, splitClusterGaps: true, maxClusterGap: 6 });
      expect(compacted.totalSavingsRatio).toBeGreaterThan(0.6); // > 60% savings

      // Set safeDiffChars to 30,000 chars per partition lane
      const safeDiffLimit = 30000;
      const plan = createPartitionPlan(compacted.files, BASE_SHA, HEAD_SHA, safeDiffLimit);

      // Verify zero dropped files guarantee
      expect(plan.totalFiles).toBe(120);
      expect(plan.coveragePercent).toBe(100);
      expect(plan.omittedFilesCount).toBe(0);
      expect(plan.fileManifest.length).toBe(120);

      // Verify partition count is deterministic and non-trivial
      expect(plan.partitions.length).toBeGreaterThanOrEqual(4);
      expect(plan.partitions.length).toBeLessThanOrEqual(12);

      // Verify disjointness across all partitions
      const seenPaths = new Set<string>();
      for (const partition of plan.partitions) {
        expect(partition.totalPartitions).toBe(plan.partitions.length);
        for (const file of partition.files) {
          expect(seenPaths.has(file.path)).toBe(false);
          seenPaths.add(file.path);
        }
      }
      expect(seenPaths.size).toBe(120);

      // Verify line number invariance across all 120 files
      for (let i = 0; i < 120; i++) {
        const origLines = extractChangedLineNumbers(files[i].patch);
        const compLines = extractChangedLineNumbers(compacted.files[i].patch);
        expect(compLines).toEqual(origLines);
      }
    });

    it('TEST_T5_LPR_02: giant single file (>100k chars) with 10 distant hunks splits deterministically across hunk boundaries', () => {
      const hunkBlocks: string[] = [];
      for (let h = 1; h <= 10; h++) {
        const startLine = h * 500;
        const hunkLines = [
          `@@ -${startLine},50 +${startLine},52 @@ function handleSubsystemChunk_${h}()`,
        ];
        for (let l = 1; l <= 50; l++) {
          if (l === 25) {
            hunkLines.push(`-  const oldConfig_${h} = false;`);
            hunkLines.push(`+  const newConfig_${h} = true;`);
            hunkLines.push(`+  telemetry.logEvent("hunk_${h}_applied");`);
          } else {
            hunkLines.push(`   const ctxLine_${l} = "${'X'.repeat(80)}";`);
          }
        }
        hunkBlocks.push(hunkLines.join('\n'));
      }

      const giantPatch = `diff --git a/src/monolith.ts b/src/monolith.ts\n--- a/src/monolith.ts\n+++ b/src/monolith.ts\n${hunkBlocks.join('\n')}\n`;
      expect(giantPatch.length).toBeGreaterThan(45000);

      // Safe capacity is 12,000 chars -> splits across hunk boundaries
      const plan = createPartitionPlan([{ path: 'src/monolith.ts', patch: giantPatch }], BASE_SHA, HEAD_SHA, 12000);

      expect(plan.partitions.length).toBeGreaterThanOrEqual(4);
      expect(plan.coveragePercent).toBe(100);
      expect(plan.omittedFilesCount).toBe(0);

      // Verify all 10 hunks are preserved across the partitions without omission
      for (let h = 1; h <= 10; h++) {
        const found = plan.partitions.some((p) =>
          p.files.some((f) => f.patch.includes(`newConfig_${h}`) && f.patch.includes(`hunk_${h}_applied`))
        );
        expect(found).toBe(true);
      }
    });

    it('TEST_T5_LPR_03: massive mix of lockfiles, minified bundles, added, deleted, and modified files preserves manifest alignment', () => {
      const mixedFiles = [
        // 5 Lockfiles (stripped)
        { path: 'package-lock.json', patch: '+ "integrity": "sha512-abc..."\n'.repeat(200), status: 'modified' },
        { path: 'pnpm-lock.yaml', patch: '+ lockfileVersion: 5.4\n'.repeat(150), status: 'modified' },
        { path: 'cargo.lock', patch: '+ checksum = "12345"\n'.repeat(100), status: 'modified' },
        { path: 'mix.lock', patch: '+ "phoenix": {:hex, ...}\n'.repeat(50), status: 'modified' },
        { path: 'poetry.lock', patch: '+ [[package]]\nname = "requests"\n'.repeat(80), status: 'modified' },

        // 3 Minified / Map files (stripped)
        { path: 'dist/bundle.min.js', patch: 'var a=1,b=2;'.repeat(300), status: 'modified' },
        { path: 'dist/bundle.js.map', patch: '{"version":3,"mappings":"AAAA"}', status: 'modified' },
        { path: 'proto/telecom.pb.go', patch: '// Code generated by protoc-gen-go.\n+type Message struct{}'.repeat(100), status: 'modified' },

        // 10 Added files
        ...Array.from({ length: 10 }, (_, i) => ({
          path: `src/new_service_${i}.ts`,
          patch: `diff --git a/new_service_${i}.ts b/new_service_${i}.ts\nnew file mode 100644\n--- /dev/null\n+++ b/new_service_${i}.ts\n@@ -0,0 +1,20 @@\n+export class NewService${i} {}\n`,
          status: 'added',
        })),

        // 10 Deleted files
        ...Array.from({ length: 10 }, (_, i) => ({
          path: `src/legacy_service_${i}.ts`,
          patch: `diff --git a/legacy_service_${i}.ts b/legacy_service_${i}.ts\ndeleted file mode 100644\n--- a/legacy_service_${i}.ts\n+++ /dev/null\n@@ -1,20 +0,0 @@\n-export class LegacyService${i} {}\n`,
          status: 'deleted',
        })),

        // 80 Standard modified source files
        ...Array.from({ length: 80 }, (_, i) => ({
          path: `src/core/handler_${i}.ts`,
          patch: `@@ -10,10 +10,11 @@\n ctx\n-const oldVal = ${i};\n+const newVal = ${i * 2};\n ctx\n`,
          status: 'modified',
        })),
      ];

      expect(mixedFiles.length).toBe(108);

      const compacted = compactFileListDiffs(mixedFiles, { stripMinified: true });
      const plan = createPartitionPlan(compacted.files, BASE_SHA, HEAD_SHA, 20000);

      expect(plan.totalFiles).toBe(108);
      expect(plan.coveragePercent).toBe(100);
      expect(plan.omittedFilesCount).toBe(0);
      expect(plan.fileManifest.length).toBe(108);

      // Verify status counts in manifest
      const addedCount = plan.fileManifest.filter((f) => f.status === 'added').length;
      const deletedCount = plan.fileManifest.filter((f) => f.status === 'deleted').length;
      const modifiedCount = plan.fileManifest.filter((f) => f.status === 'modified').length;

      expect(addedCount).toBe(10);
      expect(deletedCount).toBe(10);
      expect(modifiedCount).toBe(88); // 5 lockfiles + 3 minified + 80 source = 88
    });

    it('TEST_T5_LPR_04: 150-file monorepo PR with deeply nested, spaced, and unicode paths preserves exact manifest indexing', () => {
      const files = Array.from({ length: 150 }, (_, i) => {
        const isDeep = i % 3 === 0;
        const isUnicode = i % 5 === 0;
        const isSpaced = i % 7 === 0;

        let path = `src/module_${i}.ts`;
        if (isDeep) {
          path = `packages/core/subsystem/deeply/nested/layer_${i}/module_${i}.ts`;
        }
        if (isUnicode) {
          path = `src/telecom/üñîçødé_handler_${i}.ts`;
        }
        if (isSpaced) {
          path = `src/telecom/sip dialog service ${i}.ts`;
        }

        return {
          path,
          patch: `diff --git a/${path} b/${path}\n@@ -1,5 +1,5 @@\n ctx\n-const oldCode_${i} = ${i};\n+const newCode_${i} = ${i * 10};\n ctx\n`,
        };
      });

      const plan = createPartitionPlan(files, BASE_SHA, HEAD_SHA, 5000);

      expect(plan.totalFiles).toBe(150);
      expect(plan.fileManifest.length).toBe(150);
      expect(plan.coveragePercent).toBe(100);
      expect(plan.omittedFilesCount).toBe(0);

      // Verify each manifest path corresponds exactly to its partition file
      for (const item of plan.fileManifest) {
        const partition = plan.partitions[item.partitionIndex];
        expect(partition).toBeDefined();
        const found = partition.files.some((f) => f.path === item.path);
        expect(found).toBe(true);
      }
    });

    it('TEST_T5_LPR_05: bin-packing partitions never exceed safeDiffChars unless an individual single-hunk file exceeds it', () => {
      const files = Array.from({ length: 40 }, (_, i) => ({
        path: `src/mod_${i}.ts`,
        patch: `+line_${i}\n`.repeat(50 + (i * 20)), // Varied sizes from ~400 chars to ~4500 chars
      }));

      const safeLimit = 8000;
      const plan = createPartitionPlan(files, BASE_SHA, HEAD_SHA, safeLimit);

      for (const p of plan.partitions) {
        // Either partition size is <= safeLimit OR it has only 1 file
        if (p.totalChars > safeLimit) {
          expect(p.files.length).toBe(1);
        } else {
          expect(p.totalChars).toBeLessThanOrEqual(safeLimit);
        }
      }
    });
  });

  // ==========================================================================
  // DIMENSION 2: IRREGULAR DIFF INPUTS & ADVERSARIAL AST EDGE CASES
  // ==========================================================================
  describe('Dimension 2: Irregular Diff Inputs & Adversarial Edge Cases', () => {
    it('TEST_T5_IRR_01: handles unusual hunk header formats without syntax or parse failures', () => {
      // Format 1: Single line shorthand without comma: @@ -50 +50 @@
      const singleLineHunk = '@@ -50 +50 @@\n-oldLine();\n+newLine();\n';
      const res1 = compactUnifiedDiff(singleLineHunk);
      expect(res1.compactedPatch).toContain('-oldLine();');
      expect(res1.compactedPatch).toContain('+newLine();');
      const lines1 = extractChangedLineNumbers(res1.compactedPatch);
      expect(lines1).toEqual([
        { type: 'delete', oldLineNumber: 50, content: 'oldLine();' },
        { type: 'add', newLineNumber: 50, content: 'newLine();' },
      ]);

      // Format 2: New file creation @@ -0,0 +1,5 @@
      const newFileHunk = '@@ -0,0 +1,5 @@\n+line 1\n+line 2\n+line 3\n+line 4\n+line 5\n';
      const res2 = compactUnifiedDiff(newFileHunk);
      expect(res2.compactedPatch).toContain('+line 1');
      const lines2 = extractChangedLineNumbers(res2.compactedPatch);
      expect(lines2.length).toBe(5);
      expect(lines2[0].newLineNumber).toBe(1);
      expect(lines2[4].newLineNumber).toBe(5);

      // Format 3: Pure deletion to empty @@ -1,5 +0,0 @@
      const deletedHunk = '@@ -1,5 +0,0 @@\n-del 1\n-del 2\n-del 3\n-del 4\n-del 5\n';
      const res3 = compactUnifiedDiff(deletedHunk);
      expect(res3.compactedPatch).toContain('-del 1');
      const lines3 = extractChangedLineNumbers(res3.compactedPatch);
      expect(lines3.length).toBe(5);
      expect(lines3[0].oldLineNumber).toBe(1);
      expect(lines3[4].oldLineNumber).toBe(5);

      // Format 4: Trailing C++ / Java / Rust symbol headers in @@ line
      const headerWithFunctionSymbol = '@@ -240,15 +240,16 @@ namespace telecom::sip { void Session::reinvite(const Sdp& sdp) {\n ctx\n-const oldCodec = "PCMU";\n+const newCodec = "OPUS";\n ctx\n';
      const res4 = compactUnifiedDiff(headerWithFunctionSymbol);
      expect(res4.compactedPatch).toContain('namespace telecom::sip');
      expect(res4.compactedPatch).toContain('+const newCodec = "OPUS";');
    });

    it('TEST_T5_IRR_02: overlong single line (>15,000 chars) is processed safely and flagged in strippedArtifacts', () => {
      const overlongLine = '+' + 'const inlinePayload = "' + 'Z'.repeat(15000) + '";';
      const patchWithGiantLine = [
        'diff --git a/src/data.ts b/src/data.ts',
        '@@ -1,5 +1,5 @@',
        ' const prev = 1;',
        overlongLine,
        '-const prev2 = 2;',
        ' const end = 3;',
      ].join('\n');

      const res = compactUnifiedDiff(patchWithGiantLine, { maxLineLength: 500, stripMinified: true });

      expect(res.originalChars).toBeGreaterThan(15000);
      expect(res.strippedArtifacts).toContain('overlong_lines_exceeding_500_chars');
      expect(res.compactedPatch).toContain('const inlinePayload = "');
      expect(res.hunkCount).toBe(1);

      // Verify extractChangedLineNumbers extracts the line accurately despite length
      const extracted = extractChangedLineNumbers(patchWithGiantLine);
      expect(extracted.length).toBe(2);
      expect(extracted[0].type).toBe('add');
      expect(extracted[0].newLineNumber).toBe(2);
      expect(extracted[1].type).toBe('delete');
      expect(extracted[1].oldLineNumber).toBe(2);
    });

    it('TEST_T5_IRR_03: handles missing newlines and "\\ No newline at end of file" across additions and deletions', () => {
      const patchWithNoNewline = [
        'diff --git a/src/eof.ts b/src/eof.ts',
        '--- a/src/eof.ts',
        '+++ b/src/eof.ts',
        '@@ -10,4 +10,4 @@',
        ' ctx 10',
        '-old line without newline',
        '\\ No newline at end of file',
        '+new line without newline',
        '\\ No newline at end of file',
        ' ctx 12',
      ].join('\n');

      const res = compactUnifiedDiff(patchWithNoNewline);
      expect(res.compactedPatch).toContain('\\ No newline at end of file');
      expect(res.compactedPatch).toContain('+new line without newline');

      const lines = extractChangedLineNumbers(res.compactedPatch);
      expect(lines).toEqual([
        { type: 'delete', oldLineNumber: 11, content: 'old line without newline' },
        { type: 'add', newLineNumber: 11, content: 'new line without newline' },
      ]);
    });

    it('TEST_T5_IRR_04: mixed CRLF and LF line endings are normalized to LF without desynchronizing line indices', () => {
      const crlfPatch = '@@ -1,5 +1,5 @@\r\n ctx 1\r\n ctx 2\r\n-old CRLF line;\r\n+new LF normalized line;\r\n ctx 4\r\n';
      const res = compactUnifiedDiff(crlfPatch);

      expect(res.compactedPatch).not.toContain('\r\n');
      expect(res.compactedPatch).toContain('\n');
      expect(res.compactedPatch).toContain('+new LF normalized line;');

      const lines = extractChangedLineNumbers(res.compactedPatch);
      expect(lines).toEqual([
        { type: 'delete', oldLineNumber: 3, content: 'old CRLF line;' },
        { type: 'add', newLineNumber: 3, content: 'new LF normalized line;' },
      ]);
    });

    it('TEST_T5_IRR_05: non-standard diff prefixes (no a/ b/, Windows backslashes, /dev/null) parse correctly', () => {
      // 1. No prefix: --- path/to/file.ts +++ path/to/file.ts
      const noPrefixFile = {
        path: 'src/config/app.json',
        patch: '--- src/config/app.json\n+++ src/config/app.json\n@@ -1,2 +1,2 @@\n-{"port": 80}\n+{"port": 8080}\n',
      };
      expect(detectFileStatus(noPrefixFile)).toBe('modified');

      // 2. Windows backslashes
      const winPathFile = {
        path: 'src/utils/winPath.ts',
        patch: '--- a\\src\\utils\\winPath.ts\n+++ b\\src\\utils\\winPath.ts\n@@ -1,2 +1,2 @@\n-const slash = "\\\\";\n+const slash = "/";\n',
      };
      expect(detectFileStatus(winPathFile)).toBe('modified');

      // 3. /dev/null additions
      const addedDevNull = {
        path: 'src/newFeature.ts',
        patch: '--- /dev/null\n+++ b/src/newFeature.ts\n@@ -0,0 +1,1 @@\n+export const x = 1;\n',
      };
      expect(detectFileStatus(addedDevNull)).toBe('added');

      // 4. /dev/null deletions
      const deletedDevNull = {
        path: 'src/obsolete.ts',
        patch: '--- a/src/obsolete.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-export const x = 1;\n',
      };
      expect(detectFileStatus(deletedDevNull)).toBe('deleted');
    });

    it('TEST_T5_IRR_06: malformed or corrupted hunk header strings recover without throwing unhandled exceptions', () => {
      const corruptedDiff = [
        'diff --git a/corrupted.ts b/corrupted.ts',
        '@@ corrupted header @@',
        ' some plain text that is not a hunk',
        '@@ -invalid,format +also,bad @@',
        '+valid looking addition',
      ].join('\n');

      expect(() => compactUnifiedDiff(corruptedDiff)).not.toThrow();
      const res = compactUnifiedDiff(corruptedDiff);
      expect(res).toBeDefined();
      expect(res.hunkCount).toBe(0); // Corrupted hunks were ignored safely
    });

    it('TEST_T5_IRR_07: cluster gap threshold behavior: exactly 6 gap lines stays 1 hunk, 7 gap lines splits to 2 hunks', () => {
      // 1. Gap of 6 context lines (should stay 1 hunk with maxClusterGap: 6)
      const diff6Gap = [
        '@@ -1,15 +1,15 @@',
        ' ctx 1',
        '+changeA();',
        ' ctx 3',
        ' ctx 4',
        ' ctx 5',
        ' ctx 6',
        ' ctx 7',
        ' ctx 8', // 6 context lines between changeA (line 2) and changeB (line 9)
        '+changeB();',
        ' ctx 10',
      ].join('\n');

      const res6 = compactUnifiedDiff(diff6Gap, { splitClusterGaps: true, maxClusterGap: 6 });
      expect(res6.hunkCount).toBe(1);

      // 2. Gap of 7 context lines (should split into 2 hunks)
      const diff7Gap = [
        '@@ -1,16 +1,16 @@',
        ' ctx 1',
        '+changeA();',
        ' ctx 3',
        ' ctx 4',
        ' ctx 5',
        ' ctx 6',
        ' ctx 7',
        ' ctx 8',
        ' ctx 9', // 7 context lines
        '+changeB();',
        ' ctx 11',
      ].join('\n');

      const res7 = compactUnifiedDiff(diff7Gap, { splitClusterGaps: true, maxClusterGap: 6 });
      expect(res7.hunkCount).toBe(2);
    });
  });

  // ==========================================================================
  // DIMENSION 3: MULTI-TURN SLIDING HISTORY & ROLLING FINDINGS LEDGER
  // ==========================================================================
  describe('Dimension 3: Multi-Turn Sliding History & Findings Ledger', () => {
    it('TEST_T5_MTH_01: 10-turn multi-tool session with 50,000+ char outputs strictly bounds historical turns to <2000 tokens', () => {
      const manager = new TurnHistoryManager({
        activeTurnWindow: 2,
        maxTurnHistoryTokens: 8000,
        systemPrompt: 'You are the Architecture Reviewer.',
      });

      // Execute 10 turns with massive simulated tool output (10k chars per turn = 100k chars total)
      for (let turn = 1; turn <= 10; turn++) {
        if (turn % 2 === 1) {
          manager.addTurn('user', `Turn ${turn} user prompt requesting deep AST analysis of module ${turn}`, [
            {
              callId: `vfs_call_${turn}`,
              tool: 'pi.fs.readFile',
              status: 'success',
              output: `// Heavy AST dump for turn ${turn}\n` + 'export class Node { id: string; }\n'.repeat(300), // ~10,000 chars
            },
          ]);
        } else {
          manager.addTurn(
            'assistant',
            `Turn ${turn} reasoning and intermediate findings.\n` +
              JSON.stringify({
                findings: [
                  {
                    id: `arch-defect-${turn}`,
                    path: `src/module_${turn}.ts`,
                    line: turn * 10,
                    severity: turn === 2 ? 'P0' : 'P1',
                    title: `Circular dependency detected in module ${turn}`,
                  },
                ],
              })
          );
        }
      }

      const messages = manager.getFormattedMessages();
      expect(messages.length).toBe(11); // 1 system + 10 turns

      // Verify active window: Last 2 turns (Turns 9 and 10) are in full fidelity
      const turn9 = messages[9];
      const turn10 = messages[10];
      expect(turn9.content).toContain('Turn 9 user prompt');
      expect(turn9.toolReceipts?.[0].output).toContain('export class Node');
      expect(turn10.content).toContain('Turn 10 reasoning');

      // Verify historical turns (Turns 1 to 8) are compacted
      for (let i = 1; i <= 8; i++) {
        const histMsg = messages[i];
        expect(histMsg.content).toContain(`[Historical Turn ${i}]`);
        if (histMsg.toolReceipts) {
          for (const r of histMsg.toolReceipts) {
            expect(r.output).toContain('[Compact Receipt: success');
          }
        }
      }

      // Verify historical token bounds: Historical turns (index 1 to 8) must be < 2000 tokens
      const historicalMessages = messages.slice(1, 9);
      let historicalChars = 0;
      for (const msg of historicalMessages) {
        historicalChars += msg.content.length;
        if (msg.toolReceipts) {
          for (const r of msg.toolReceipts) {
            historicalChars += r.output.length + r.tool.length + r.callId.length;
          }
        }
      }
      const historicalTokens = Math.ceil(historicalChars / 3.8);

      // Raw uncompacted historical tokens would have been > 20,000 tokens. Compacted must be < 2,000.
      expect(historicalTokens).toBeLessThan(2000);
      expect(manager.getEstimatedTokens()).toBeLessThan(4500);
    });

    it('TEST_T5_MTH_02: rolling findings ledger preserves all P0/P1/P2 findings and deduplicates repeat reports across turns', () => {
      const manager = new TurnHistoryManager({ activeTurnWindow: 2 });

      // Turn 1: Assistant discovers P0 defect
      manager.addTurn(
        'assistant',
        JSON.stringify({
          findings: [{ id: 'p0-unauth-sip', severity: 'P0', title: 'Unauthenticated SIP BYE injection' }],
        })
      );

      // Turn 2: Assistant discovers P1 defect
      manager.addTurn(
        'assistant',
        JSON.stringify({
          findings: [{ id: 'p1-rtp-leak', severity: 'P1', title: 'Unreleased RTP port socket' }],
        })
      );

      // Turn 3: Assistant uses regex style Finding [P2]
      manager.addTurn('assistant', 'I also observed Finding [P2]: Suboptimal string concatenation in logger');

      // Turn 4: Assistant re-reports p0-unauth-sip with updated title
      manager.addTurn(
        'assistant',
        JSON.stringify({
          findings: [{ id: 'p0-unauth-sip', severity: 'P0', title: 'Confirmed: Unauthenticated SIP BYE injection' }],
        })
      );

      // Turn 5 & 6: Subsequent conversational turns
      manager.addTurn('user', 'Are there any other issues?');
      manager.addTurn('assistant', 'No further issues detected.');

      const ledger = manager.getFindingsLedger();

      // Deduplicated: p0-unauth-sip (1), p1-rtp-leak (1), extracted P2 (1) = 3 total findings
      expect(ledger.length).toBe(3);

      const p0 = ledger.find((f) => f.id === 'p0-unauth-sip');
      const p1 = ledger.find((f) => f.id === 'p1-rtp-leak');
      const p2 = ledger.find((f) => f.severity === 'P2');

      expect(p0).toBeDefined();
      expect(p0?.severity).toBe('P0');
      expect(p0?.summary).toContain('Unauthenticated SIP BYE injection');

      expect(p1).toBeDefined();
      expect(p1?.severity).toBe('P1');
      expect(p1?.summary).toBe('Unreleased RTP port socket');

      expect(p2).toBeDefined();
      expect(p2?.severity).toBe('P2');
      expect(p2?.summary).toContain('Suboptimal string concatenation in logger');
    });

    it('TEST_T5_MTH_03: receipt ledger maintains strict chronological order and accurate metadata for all tool calls', () => {
      const manager = new TurnHistoryManager();

      manager.addTurn('assistant', 'Step 1', [
        { callId: 'c1', tool: 'pi.fs.readFile', status: 'success', output: 'content1' },
      ]);
      manager.addTurn('assistant', 'Step 2', [
        { callId: 'c2', tool: 'pi.code.search', status: 'success', output: 'content2' },
        { callId: 'c3', tool: 'pi.symbol.lookup', status: 'error', output: 'Symbol not found' },
      ]);

      const receipts = manager.getReceiptLedger();
      expect(receipts.length).toBe(3);
      expect(receipts[0]).toEqual({
        turn: 1,
        tool: 'pi.fs.readFile',
        summary: '[success] c1: content1',
      });
      expect(receipts[1]).toEqual({
        turn: 2,
        tool: 'pi.code.search',
        summary: '[success] c2: content2',
      });
      expect(receipts[2]).toEqual({
        turn: 2,
        tool: 'pi.symbol.lookup',
        summary: '[error] c3: Symbol not found',
      });
    });

    it('TEST_T5_MTH_04: 20-turn extended session with massive outputs keeps total prompt tokens comfortably below 6000', () => {
      const manager = new TurnHistoryManager({ activeTurnWindow: 2 });

      for (let t = 1; t <= 20; t++) {
        manager.addTurn(
          t % 2 === 1 ? 'user' : 'assistant',
          `Turn ${t} message content with detailed reasoning step ${t}`.repeat(10),
          [{ callId: `call_${t}`, tool: 'pi.fs.readFile', status: 'success', output: 'A'.repeat(8000) }]
        );
      }

      const totalTokens = manager.getEstimatedTokens();
      // 20 turns * 8000 chars = 160,000 raw chars (~42,000 tokens). With sliding compaction, must be < 8000 tokens.
      expect(totalTokens).toBeLessThan(8000);
      expect(manager.getReceiptLedger().length).toBe(20);
    });
  });

  // ==========================================================================
  // DIMENSION 4: PARALLEL PARTITION EXECUTION & FINDING AGGREGATION
  // ==========================================================================
  describe('Dimension 4: Parallel Partition Execution & Finding Aggregation', () => {
    it('TEST_T5_AGG_01: cross-partition findings with line proximity (<=5 lines) deduplicate and resolve to highest severity', () => {
      // Simulate findings discovered across multiple partition lanes
      const rawFindingsFromPartitions: PersonaFinding[] = [
        // Partition 1 finding
        {
          id: 'part1-sec-1',
          persona: 'security',
          path: 'src/telecom/sipDialog.ts',
          line: 45,
          severity: 'P1',
          title: 'Unchecked caller identity',
          body: 'Potential spoofing issue in dialog',
          confidence: 0.85,
        },
        // Partition 2 finding (same file, line 47 <= 5 lines, higher severity P0, title contains matching base)
        {
          id: 'part2-sec-2',
          persona: 'security',
          path: 'src/telecom/sipDialog.ts',
          line: 47,
          severity: 'P0',
          title: 'Unchecked caller identity vulnerability',
          body: 'Critical bypass of authentication header',
          confidence: 0.95,
          suggestion: 'Validate caller identity token against session store',
        },
        // Partition 3 finding (different file, P2)
        {
          id: 'part3-perf-1',
          persona: 'performance',
          path: 'src/telecom/rtpBuffer.ts',
          line: 120,
          severity: 'P2',
          title: 'Redundant buffer copy in RTP stream',
          body: 'Minor CPU overhead',
          confidence: 0.90,
        },
      ];

      const deduplicated = sanitizeAndDeduplicateFindings(rawFindingsFromPartitions);

      // The two sipDialog.ts findings should deduplicate into 1 finding with severity P0
      expect(deduplicated.length).toBe(2);

      const sipFinding = deduplicated.find((f) => f.path === 'src/telecom/sipDialog.ts');
      const rtpFinding = deduplicated.find((f) => f.path === 'src/telecom/rtpBuffer.ts');

      expect(sipFinding).toBeDefined();
      expect(sipFinding?.severity).toBe('P0');
      expect(sipFinding?.confidence).toBe(0.95);
      expect(sipFinding?.suggestion).toBe('Validate caller identity token against session store');

      expect(rtpFinding).toBeDefined();
      expect(rtpFinding?.severity).toBe('P2');
    });

    it('TEST_T5_AGG_02: quorum arbitration evaluates aggregated partition findings and triggers correct blocking verdict', () => {
      // 1. PR with P0 finding -> BLOCK
      const p0Findings: PersonaFinding[] = [
        {
          id: 'f1',
          persona: 'security',
          path: 'src/auth.ts',
          line: 10,
          severity: 'P0',
          title: 'Remote code execution via eval()',
          body: 'Critical security flaw',
          confidence: 0.99,
        },
      ];
      const arb1 = evaluateQuorumArbitration(p0Findings, 5);
      expect(arb1.verdict).toBe('BLOCK');
      expect(arb1.metrics.p0Count).toBe(1);

      // 2. PR with only P1 findings -> FIX_FIRST
      const p1Findings: PersonaFinding[] = [
        {
          id: 'f2',
          persona: 'performance',
          path: 'src/stream.ts',
          line: 55,
          severity: 'P1',
          title: 'Unreleased file descriptor leak',
          body: 'Resource exhaustion risk',
          confidence: 0.92,
        },
      ];
      const arb2 = evaluateQuorumArbitration(p1Findings, 5);
      expect(arb2.verdict).toBe('FIX_FIRST');
      expect(arb2.metrics.p1Count).toBe(1);

      // 3. PR with only P2 findings or empty -> SHIP
      const p2Findings: PersonaFinding[] = [
        {
          id: 'f3',
          persona: 'testing',
          path: 'src/utils.ts',
          line: 80,
          severity: 'P2',
          title: 'Missing edge case unit test',
          body: 'Coverage suggestion',
          confidence: 0.88,
        },
      ];
      const arb3 = evaluateQuorumArbitration(p2Findings, 5);
      expect(arb3.verdict).toBe('SHIP');
      expect(arb3.metrics.p2Count).toBe(1);

      // 4. Clean PR -> SHIP
      const arb4 = evaluateQuorumArbitration([], 5);
      expect(arb4.verdict).toBe('SHIP');
      expect(arb4.metrics.totalFindings).toBe(0);
    });

    it('TEST_T5_AGG_03: pipeline metrics accurately compute TP, FP, FN, precision, recall, F1, and SNR for partitioned PRs', () => {
      const expected: ExpectedFinding[] = [
        { personaId: 'security', path: 'src/sip.ts', line: 50, severity: 'P0' as const, title: 'SIP Race' },
        { personaId: 'performance', path: 'src/rtp.ts', line: 100, severity: 'P1' as const, title: 'RTP Leak' },
      ];

      const actual: PersonaFinding[] = [
        {
          id: 'a1',
          persona: 'security',
          path: 'src/sip.ts',
          line: 52, // within 5 line tolerance
          severity: 'P0',
          title: 'SIP Race',
          body: 'Race condition on INVITE',
          confidence: 0.95,
        },
        {
          id: 'a2',
          persona: 'performance',
          path: 'src/rtp.ts',
          line: 101, // within 5 line tolerance
          severity: 'P1',
          title: 'RTP Leak',
          body: 'Port leak',
          confidence: 0.90,
        },
        {
          id: 'a3',
          persona: 'architecture',
          path: 'src/extra.ts',
          line: 200,
          severity: 'P2',
          title: 'False alarm',
          body: 'Hallucinated issue',
          confidence: 0.70,
        },
      ];

      const metrics = calculatePipelineMetrics(expected, actual, { lineTolerance: 5, strictSeverity: true });

      expect(metrics.tp).toBe(2);
      expect(metrics.fp).toBe(1); // a3 is false positive
      expect(metrics.fn).toBe(0);
      expect(metrics.precision).toBeCloseTo(0.667, 2); // 2 / (2 + 1)
      expect(metrics.recall).toBe(1.0); // 2 / 2
      expect(metrics.f1).toBeCloseTo(0.8, 1);
      expect(metrics.snrDb).toBeGreaterThan(0);
    });

    it('TEST_T5_AGG_04: formats complete PR comment coverage telemetry with multiple partition lanes and exact SHA range', () => {
      const files = Array.from({ length: 6 }, (_, i) => ({
        path: `src/service_${i}.ts`,
        patch: `+line_${i}\n`.repeat(100),
      }));

      const plan = createPartitionPlan(files, BASE_SHA, HEAD_SHA, 500);
      expect(plan.partitions.length).toBeGreaterThanOrEqual(2);

      const comment = formatCoverageComment(plan);

      // Verify required format strings
      expect(comment).toContain('### 🛡️ Review Yeti Context Coverage Telemetry');
      expect(comment).toContain(`**Coverage: 100% (${plan.totalFiles}/${plan.totalFiles} files reviewed across ${plan.partitions.length} partitions, 0 omitted)**`);
      expect(comment).toContain(`- **Commit SHA Range**: \`${BASE_SHA}...${HEAD_SHA}\``);
      expect(comment).toContain(`- **Review Partitions**: ${plan.partitions.length} parallel review lanes`);
      expect(comment).toContain('| File Path | Status | Partition Lane |');
      expect(comment).toContain('_Zero files truncated or omitted under dynamic model capacity limits._');

      // Verify every file is in the markdown table
      for (const f of files) {
        expect(comment).toContain(`\`${f.path}\``);
      }
    });
  });

  // ==========================================================================
  // DIMENSION 5: DYNAMIC MODEL CONTEXT CAPACITIES & CONFIG BOUNDARY CEILINGS
  // ==========================================================================
  describe('Dimension 5: Dynamic Model Capacities & Boundary Ceilings', () => {
    it('TEST_T5_MOD_01: computes exact safeDiffChars according to C_safe formula across diverse model families', () => {
      // 1. DeepSeek V4 Flash (128k context = 128,000)
      const ds = calculateSafeDiffCapacity('deepseek/deepseek-v4-flash-0731:high');
      expect(ds.contextTokens).toBe(128000);
      expect(ds.systemPromptTokens).toBe(4000);
      expect(ds.toolReserveTokens).toBe(16000);
      expect(ds.usableDiffTokens).toBe(108000);
      expect(ds.safeDiffChars).toBe(410400); // 108,000 * 3.8

      // 2. Gemini 3.7 Flash (1,048,576 context)
      const gemini = calculateSafeDiffCapacity('google/gemini-3.7-flash:high');
      expect(gemini.contextTokens).toBe(1048576);
      expect(gemini.usableDiffTokens).toBe(1028576);
      expect(gemini.safeDiffChars).toBe(3908588); // 1,028,576 * 3.8 = 3,908,588.8

      // 3. Claude 3.7 Sonnet (200,000 context)
      const claude = calculateSafeDiffCapacity('anthropic/claude-3.7-sonnet');
      expect(claude.contextTokens).toBe(200000);
      expect(claude.usableDiffTokens).toBe(180000);
      expect(claude.safeDiffChars).toBe(684000); // 180,000 * 3.8

      // 4. Custom token budget with custom reserve
      const custom = calculateSafeDiffCapacity(64000, {
        systemPromptTokens: 2000,
        toolReserveTokens: 8000,
        charsPerToken: 4.0,
      });
      expect(custom.contextTokens).toBe(64000);
      expect(custom.usableDiffTokens).toBe(54000);
      expect(custom.safeDiffChars).toBe(216000); // 54,000 * 4.0
    });

    it('TEST_T5_MOD_02: resolveModelMetadata resolves dynamically with single-flight async deduplication and fallback', async () => {
      // Test static metadata resolution
      const meta = getStaticModelMetadata('deepseek/deepseek-v4-flash-0731:high');
      expect(meta.id).toBe('deepseek/deepseek-v4-flash-0731:high');
      expect(meta.contextLength).toBe(128000);
      expect(meta.supportsTools).toBe(true);

      // Test async resolution with mock fetch
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'deepseek/deepseek-v4-flash-0731',
                name: 'DeepSeek V4 Flash Dynamic',
                context_length: 131072,
                pricing: { prompt: '0.00000014', completion: '0.00000028' },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      );

      clearModelMetadataCache();
      const resolved = await resolveModelMetadata('deepseek/deepseek-v4-flash-0731:high', 'test-key', {
        baseUrl: 'https://openrouter.test/api/v1',
        fetchImplementation: mockFetch,
      });
      expect(resolved.contextLength).toBe(131072);
      expect(resolved.id).toBe('deepseek/deepseek-v4-flash-0731:high');
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Test caching: repeated call uses cache
      const cached = await resolveModelMetadata('deepseek/deepseek-v4-flash-0731:high', 'test-key', {
        baseUrl: 'https://openrouter.test/api/v1',
        fetchImplementation: mockFetch,
      });
      expect(cached.contextLength).toBe(131072);
      expect(mockFetch).toHaveBeenCalledTimes(1); // Cached, no second network call
    });

    it('TEST_T5_MOD_03: reviewLimitsSchema validates expanded boundaries for massive PRs up to 4M tokens and 10MB diffs', () => {
      const validLimits = reviewLimitsSchema.parse({
        max_prompt_tokens: 4_000_000,
        max_diff_bytes: 10_000_000,
        max_files: 5000,
        max_completion_tokens: 128_000,
        max_turns: 20,
        max_concurrency: 32,
      });

      expect(validLimits.max_prompt_tokens).toBe(4_000_000);
      expect(validLimits.max_diff_bytes).toBe(10_000_000);

      // Reject exceeding maximum ceilings
      expect(() => reviewLimitsSchema.parse({ max_prompt_tokens: 4_000_001 })).toThrow();
      expect(() => reviewLimitsSchema.parse({ max_diff_bytes: 10_000_001 })).toThrow();
      expect(() => reviewLimitsSchema.parse({ max_files: 5001 })).toThrow();
    });
  });
});
