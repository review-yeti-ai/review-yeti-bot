import { describe, it, expect } from 'vitest';
import {
  compactMessageWindow,
  DEFAULT_ACTIVE_TURNS,
  PI_TOOL_RESULT_MARKER,
  extractSynopsis,
  parseHunkTarget,
  isEphemeralTool,
  type MessageWindowToolCall,
} from '../../src/panel/messageWindow';
import {
  executeGetHunk,
  get_hunk,
  parseDiffHunks,
  runReadOnlyTool,
} from '../../src/panel/toolRuntime';
import { executeComposedReadOnlyTool } from '../../src/panel/composedEngine';
import type { OpenRouterMessage } from '../../src/gateway/openRouterClient';

describe('Adversarial Challenger M2: Re-entrant Compaction & Deep Hunk Retrieval', () => {

  // =========================================================================
  // 1. RE-ENTRANT COMPACTION STRESS
  // =========================================================================
  describe('Re-entrant Compaction Stress Testing', () => {
    it('EMP-REENTRANT-01: multiple sequential passes of compactMessageWindow produce idempotent receipts without nesting or duplication', () => {
      const messages: OpenRouterMessage[] = [
        { role: 'system', content: 'Authoritative system prompt.' },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Opening prompt with ephemeral cache breakpoint.',
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ];

      const toolCalls: MessageWindowToolCall[] = [];
      const totalTurns = 8;

      for (let t = 0; t < totalTurns; t++) {
        messages.push({ role: 'assistant', content: `Assistant turn ${t} finding hypothesis` });
        messages.push({
          role: 'user',
          content: `${PI_TOOL_RESULT_MARKER} @@ -${t * 10},5 +${t * 10},5 @@ raw diff payload for turn ${t} with secret_${t}`,
        });
        toolCalls.push({
          tool: 'get_hunk',
          args: { filePath: `src/mod_${t}.ts`, startLine: t * 10, endLine: t * 10 + 5 },
          scope: `src/mod_${t}.ts:${t * 10}-${t * 10 + 5}`,
          exhaustive: true,
        });
      }

      // First pass: compacts with activeTurns = 2
      // 8 turns total -> 6 older turns compacted to receipts, 2 active turns preserved raw
      const pass1 = compactMessageWindow(messages, {
        activeTurns: 2,
        toolCalls,
        ephemeralTools: ['get_hunk'],
      });

      expect(pass1).toHaveLength(messages.length);
      expect(pass1[0]).toBe(messages[0]);
      expect(pass1[1]).toBe(messages[1]);

      // Verify pass1 receipts
      const pass1Receipts = pass1.filter(
        (m) => typeof m.content === 'string' && m.content.includes('[DIFF_EVICTION_RECEIPT:'),
      );
      expect(pass1Receipts).toHaveLength(6);

      // Second pass: re-pass pass1 into compactMessageWindow
      const pass2 = compactMessageWindow(pass1, {
        activeTurns: 2,
        toolCalls,
        ephemeralTools: ['get_hunk'],
      });

      // Verify pass2 is identical to pass1
      expect(pass2).toHaveLength(pass1.length);
      expect(pass2[0]).toBe(messages[0]);
      expect(pass2[1]).toBe(messages[1]);

      for (let i = 0; i < pass1.length; i++) {
        expect(pass2[i].role).toBe(pass1[i].role);
        expect(pass2[i].content).toEqual(pass1[i].content);
      }

      // Check for zero nesting of receipts
      for (const m of pass2) {
        if (typeof m.content === 'string') {
          // Must not have nested [PI_TOOL_RESULT]_RECEIPT
          const countMarkerReceipt = (m.content.match(/\[PI_TOOL_RESULT\]_RECEIPT/g) || []).length;
          expect(countMarkerReceipt).toBeLessThanOrEqual(1);

          // Must not have double RECEIPT tag e.g. RECEIPT_RECEIPT
          expect(m.content).not.toContain('_RECEIPT_RECEIPT');

          // Must not have nested [DIFF_EVICTION_RECEIPT:
          const countDiffReceipt = (m.content.match(/\[DIFF_EVICTION_RECEIPT:/g) || []).length;
          expect(countDiffReceipt).toBeLessThanOrEqual(1);
        }
      }

      // Third, fourth, fifth passes (deep re-entrancy)
      let currentPass = pass2;
      for (let p = 3; p <= 5; p++) {
        currentPass = compactMessageWindow(currentPass, {
          activeTurns: 2,
          toolCalls,
          ephemeralTools: ['get_hunk'],
        });
        expect(currentPass.map((m) => m.content)).toEqual(pass1.map((m) => m.content));
      }
    });

    it('EMP-REENTRANT-02: zero active turns (activeTurns: 0) collapses all turns to receipts idempotently', () => {
      const messages: OpenRouterMessage[] = [
        { role: 'system', content: 'Sys' },
        { role: 'user', content: 'User 0' },
        { role: 'assistant', content: 'Inspect turn 1' },
        { role: 'user', content: `${PI_TOOL_RESULT_MARKER} hunk 1` },
        { role: 'assistant', content: 'Inspect turn 2' },
        { role: 'user', content: `${PI_TOOL_RESULT_MARKER} hunk 2` },
      ];

      const toolCalls: MessageWindowToolCall[] = [
        { tool: 'get_hunk', scope: 'file1.ts:1-5' },
        { tool: 'get_hunk', scope: 'file2.ts:10-15' },
      ];

      const pass1 = compactMessageWindow(messages, { activeTurns: 0, toolCalls });
      expect(pass1[3].content).toContain('[DIFF_EVICTION_RECEIPT: file=file1.ts');
      expect(pass1[5].content).toContain('[DIFF_EVICTION_RECEIPT: file=file2.ts');

      const pass2 = compactMessageWindow(pass1, { activeTurns: 0, toolCalls });
      expect(pass2[3].content).toBe(pass1[3].content);
      expect(pass2[5].content).toBe(pass1[5].content);
      expect(pass2[3].content).not.toContain('_RECEIPT_RECEIPT');
    });

    it('EMP-REENTRANT-03: mixed tool results (read_file retained + get_hunk evicted) remains stable across multiple compaction passes', () => {
      const smallReadFile = `${PI_TOOL_RESULT_MARKER} export const config = { timeout: 30 };`;
      const hunk = `${PI_TOOL_RESULT_MARKER} @@ -1,5 +1,5 @@ hunk data`;

      const messages: OpenRouterMessage[] = [
        { role: 'system', content: 'System' },
        { role: 'user', content: 'User' },
        { role: 'assistant', content: 'A1' },
        { role: 'user', content: smallReadFile }, // Turn 0: retained
        { role: 'assistant', content: 'A2' },
        { role: 'user', content: hunk },          // Turn 1: evicted
        { role: 'assistant', content: 'A3' },
        { role: 'user', content: `${PI_TOOL_RESULT_MARKER} active hunk` }, // Active
      ];

      const toolCalls: MessageWindowToolCall[] = [
        { tool: 'read_file', scope: 'src/config.ts' },
        { tool: 'get_hunk', scope: 'src/auth.ts:1-5' },
        { tool: 'get_hunk', scope: 'src/active.ts:10-15' },
      ];

      const pass1 = compactMessageWindow(messages, {
        activeTurns: 1,
        retainSmallToolResults: true,
        toolCalls,
      });

      // Turn 0 is retained verbatim
      expect(pass1[3].content).toBe(smallReadFile);
      // Turn 1 is evicted
      expect(pass1[5].content).toContain('[DIFF_EVICTION_RECEIPT: file=src/auth.ts');
      // Turn 2 is active
      expect(pass1[7].content).toContain('active hunk');

      // Now pass2
      const pass2 = compactMessageWindow(pass1, {
        activeTurns: 1,
        retainSmallToolResults: true,
        toolCalls,
      });

      expect(pass2[3].content).toBe(smallReadFile);
      expect(pass2[5].content).toBe(pass1[5].content);
      expect(pass2[7].content).toContain('active hunk');
    });
  });

  // =========================================================================
  // 2. DEEP HUNK RETRIEVAL & MULTI-FILE SLICING WITH get_hunk
  // =========================================================================
  describe('Deep Hunk Retrieval & Multi-File Slicing', () => {
    // Generate 30 distinct files with 5 hunks each (150 hunks total)
    const multiFilePatches: Record<string, string> = {};
    for (let f = 1; f <= 30; f++) {
      const filePath = `packages/service-${f}/src/handler_${f}.ts`;
      const hunkStrings: string[] = [];
      for (let h = 1; h <= 5; h++) {
        const start = h * 100;
        hunkStrings.push([
          `@@ -${start},10 +${start},12 @@ export function func_${f}_${h}() {`,
          `   // context before`,
          `-  const oldCode_${f}_${h} = "v1";`,
          `+  const newCode_${f}_${h} = "v2";`,
          `+  auditLog("${f}_${h}");`,
          `   // context after`,
          ` }`,
        ].join('\n'));
      }
      multiFilePatches[filePath] = hunkStrings.join('\n');
    }

    it('EMP-DEEP-01: slices specific hunks across 30 different files accurately', () => {
      for (let f = 1; f <= 30; f++) {
        const filePath = `packages/service-${f}/src/handler_${f}.ts`;

        // Request hunk 3 (lines 300 to 315)
        const res = executeGetHunk(
          { filePath, startLine: 300, endLine: 315 },
          multiFilePatches,
        );

        expect(res.status).toBe('success');
        if (res.status === 'success') {
          expect(res.filePath).toBe(filePath);
          const addedLines = res.modifiedLines.filter((m) => m.type === 'add');
          expect(addedLines.length).toBe(2);
          expect(res.modifiedLines.some((m) => m.content.includes(`newCode_${f}_3`))).toBe(true);
          expect(res.modifiedLines.some((m) => m.content.includes(`newCode_${f}_1`))).toBe(false);
          expect(res.modifiedLines.some((m) => m.content.includes(`newCode_${f}_5`))).toBe(false);
        }
      }
    });

    it('EMP-DEEP-02: handles huge multi-hunk file (50 hunks) with selective window retrieval', () => {
      const bigFilePath = 'src/monolith/megaHandler.ts';
      const fiftyHunks: string[] = [];
      for (let h = 1; h <= 50; h++) {
        const line = h * 50;
        fiftyHunks.push([
          `@@ -${line},5 +${line},6 @@`,
          `   // ctx`,
          `-  const val_${h} = ${h};`,
          `+  const val_${h} = ${h * 100};`,
          `+  const check_${h} = true;`,
          `   // ctx`,
        ].join('\n'));
      }
      const patches = { [bigFilePath]: fiftyHunks.join('\n') };

      // Selective fetch of hunk 25
      const resHunk25 = executeGetHunk(
        { filePath: bigFilePath, startLine: 1250, endLine: 1255 },
        patches,
      );
      expect(resHunk25.status).toBe('success');
      if (resHunk25.status === 'success') {
        const addedLines = resHunk25.modifiedLines.filter((m) => m.type === 'add');
        expect(addedLines.length).toBe(2);
        expect(resHunk25.modifiedLines.some((m) => m.content.includes('val_25 = 2500'))).toBe(true);
        expect(resHunk25.modifiedLines.some((m) => m.content.includes('val_24'))).toBe(false);
        expect(resHunk25.modifiedLines.some((m) => m.content.includes('val_26'))).toBe(false);
      }

      // Spanning fetch across hunks 40 through 45 (lines 2000 to 2260)
      const resSpan = executeGetHunk(
        { filePath: bigFilePath, startLine: 2000, endLine: 2260 },
        patches,
      );
      expect(resSpan.status).toBe('success');
      if (resSpan.status === 'success') {
        const addedLines = resSpan.modifiedLines.filter((m) => m.type === 'add');
        expect(addedLines.length).toBe(12); // 6 hunks * 2 added lines
        expect(resSpan.modifiedLines.some((m) => m.content.includes('val_40'))).toBe(true);
        expect(resSpan.modifiedLines.some((m) => m.content.includes('val_45'))).toBe(true);
        expect(resSpan.modifiedLines.some((m) => m.content.includes('val_39'))).toBe(false);
        expect(resSpan.modifiedLines.some((m) => m.content.includes('val_46'))).toBe(false);
      }
    });

    it('EMP-DEEP-03: boundary lines touching hunk exact endpoints with contextLines=0', () => {
      const patch = [
        '@@ -100,5 +100,5 @@',
        ' ctx100',
        '-line101',
        '+line101_new',
        ' ctx102',
        ' ctx103',
        ' ctx104',
      ].join('\n');
      const patches = { 'src/exact.ts': patch };

      // Exact line 101 with contextLines=0
      const resExact = executeGetHunk(
        { filePath: 'src/exact.ts', startLine: 101, endLine: 101, contextLines: 0 },
        patches,
      );
      expect(resExact.status).toBe('success');
      if (resExact.status === 'success') {
        expect(resExact.modifiedLines.some((m) => m.content === 'line101_new')).toBe(true);
        expect(resExact.modifiedLines.every((m) => m.type !== 'context')).toBe(true);
      }

      // Range [105, 120] (strictly outside the hunk [100, 104]) with contextLines=0 -> no diff in range
      const resOutOfRange = executeGetHunk(
        { filePath: 'src/exact.ts', startLine: 105, endLine: 120, contextLines: 0 },
        patches,
      );
      expect(resOutOfRange.status).toBe('rejected');
      if (resOutOfRange.status === 'rejected') {
        expect(resOutOfRange.error).toBe('no_diff_in_range');
      }
    });
  });
});
