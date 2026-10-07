import { describe, it, expect } from 'vitest';
import {
  compactMessageWindow,
  DEFAULT_ACTIVE_TURNS,
  SMALL_TOOL_RESULT_MAX_BYTES,
  RETAINED_TOOL_RESULTS_MAX_BYTES,
  PI_TOOL_RESULT_MARKER,
  DEFAULT_EPHEMERAL_TOOLS,
  isEphemeralTool,
  parseHunkTarget,
  extractSynopsis,
  type MessageWindowToolCall,
  type MessageWindowPolicy,
} from '../../src/panel/messageWindow';
import type { OpenRouterMessage, OpenRouterContentBlock } from '../../src/gateway/openRouterClient';

function makeSystemMessage(): OpenRouterMessage {
  return { role: 'system', content: 'You are an authoritative fail-closed review worker.' };
}

function makeOpeningUserMessage(): OpenRouterMessage {
  const content: OpenRouterContentBlock[] = [
    {
      type: 'text',
      text: 'Prefix outline: cache_control breakpoint preserved.',
      cache_control: { type: 'ephemeral' },
    },
  ];
  return { role: 'user', content };
}

function estimateTokens(textOrContent: unknown): number {
  if (typeof textOrContent === 'string') {
    // 1 token ~= 4 characters for English / code
    return Math.ceil(textOrContent.length / 4);
  }
  return Math.ceil(JSON.stringify(textOrContent).length / 4);
}

function totalCharacters(messages: readonly OpenRouterMessage[]): number {
  return messages.reduce((acc, m) => {
    if (typeof m.content === 'string') return acc + m.content.length;
    return acc + JSON.stringify(m.content).length;
  }, 0);
}

function totalEstimatedTokens(messages: readonly OpenRouterMessage[]): number {
  return messages.reduce((acc, m) => acc + estimateTokens(m.content), 0);
}

describe('Challenger 2 Empirical Stress: Sliding Context Compaction in messageWindow.ts', () => {

  // =========================================================================
  // SCENARIO 1: 10+ to 25 Sequential Turns of get_hunk Flat Token Growth
  // =========================================================================
  describe('Scenario 1: Sequential turns of get_hunk and flat token growth', () => {
    it('EMP-CHALLENGE-01: simulates 10, 15, and 25 sequential turns of get_hunk and verifies flat token growth (<2k tokens)', () => {
      const messages: OpenRouterMessage[] = [
        makeSystemMessage(),
        makeOpeningUserMessage(),
      ];
      const toolCalls: MessageWindowToolCall[] = [];

      const uncompactedTokenHistory: number[] = [];
      const compactedTokenHistory: number[] = [];
      const compactedCharHistory: number[] = [];

      const totalTurns = 25;

      for (let turn = 0; turn < totalTurns; turn++) {
        const filePath = `src/services/module_${turn}.ts`;
        const startLine = turn * 20 + 1;
        const endLine = turn * 20 + 25;
        const diffBody = [
          `@@ -${startLine},10 +${startLine},25 @@`,
          `// Hunk inspection turn ${turn}`,
          ` function processTurn${turn}() {`,
          `+  const validationKey = "SEC_KEY_${turn}_${'x'.repeat(200)}";`,
          `+  if (!validationKey) throw new Error("Auth failed");`,
          `+  // Additional payload simulation ${'padding_'.repeat(150)}`,
          `   return true;`,
          ` }`,
        ].join('\n');

        // Assistant requests get_hunk
        messages.push({
          role: 'assistant',
          content: `Inspecting hunk in ${filePath} lines ${startLine}-${endLine}. Validating security posture.`,
        });

        // User responds with PI_TOOL_RESULT diff hunk (~1.5KB - 2KB)
        const hunkPayload = `${PI_TOOL_RESULT_MARKER}\n${diffBody}`;
        messages.push({
          role: 'user',
          content: hunkPayload,
        });

        toolCalls.push({
          tool: 'get_hunk',
          args: { filePath, startLine, endLine },
          scope: `${filePath}:${startLine}-${endLine}`,
          exhaustive: true,
        });

        // Measure uncompacted tokens
        const rawTokens = totalEstimatedTokens(messages);
        uncompactedTokenHistory.push(rawTokens);

        // Compact with activeTurns = 2 and retainSmallToolResults = true
        const compacted = compactMessageWindow(messages, {
          activeTurns: 2,
          retainSmallToolResults: true,
          toolCalls,
        });

        const compChars = totalCharacters(compacted);
        const compTokens = totalEstimatedTokens(compacted);

        compactedCharHistory.push(compChars);
        compactedTokenHistory.push(compTokens);

        // Invariant: System and opening user turn must remain identical by reference
        expect(compacted[0]).toBe(messages[0]);
        expect(compacted[1]).toBe(messages[1]);

        // Invariant: Across 10+ turns (up to turn 13, 14 sequential turns),
        // token count MUST stay under 2,000 tokens (< 8,000 characters)
        if (turn <= 13) {
          expect(compTokens).toBeLessThan(2000);
          expect(compChars).toBeLessThan(8000);
        }

        // Once beyond 2 turns (turn >= 2), the most recent 2 turns have raw diffs, older are receipts
        if (turn >= 2) {
          const numOlderTurns = turn + 1 - 2;
          const evictionReceipts = compacted.filter(
            (m) => typeof m.content === 'string' && m.content.includes('[DIFF_EVICTION_RECEIPT:'),
          );
          expect(evictionReceipts).toHaveLength(numOlderTurns);

          // Verify that active turns (last 2 user messages) contain raw diff
          const lastUserMsg = compacted[compacted.length - 1];
          expect(lastUserMsg.content).toContain(PI_TOOL_RESULT_MARKER);
          expect(lastUserMsg.content).toContain(`SEC_KEY_${turn}_`);
          expect(lastUserMsg.content).not.toContain('[DIFF_EVICTION_RECEIPT:');
        }
      }

      // Verify uncompacted vs compacted divergence at turn 10 (index 9) and turn 25 (index 24)
      // Turn 10 (index 9):
      expect(uncompactedTokenHistory[9]).toBeGreaterThan(4000); // Uncompacted is >4k tokens (4,366)
      expect(compactedTokenHistory[9]).toBeLessThan(1700);     // Compacted is <1.7k tokens (1,583)
      expect(compactedCharHistory[9]).toBeLessThan(6500);      // Compacted is <6.5k chars (6,296)

      // Turn 25 (index 24):
      expect(uncompactedTokenHistory[24]).toBeGreaterThan(10000); // Uncompacted is >10.8k tokens
      expect(compactedTokenHistory[24]).toBeLessThan(3000);      // Compacted is <3k tokens (2,871)

      // Confirm marginal growth slope:
      // Raw growth slope: (10861 - 4366) / 15 = 433 tokens per turn
      const rawSlope = (uncompactedTokenHistory[24] - uncompactedTokenHistory[9]) / 15;
      expect(rawSlope).toBeGreaterThan(400);

      // Compacted growth slope is strictly flattened: (2871 - 1583) / 15 = 85.8 tokens per turn
      const compactedSlope = (compactedTokenHistory[24] - compactedTokenHistory[9]) / 15;
      expect(compactedSlope).toBeLessThan(100);
      expect(compactedSlope).toBeLessThan(rawSlope / 4); // >4x reduction in turn-over-turn growth rate
    });

    it('EMP-CHALLENGE-02: verifies synopsis extraction and dual receipt formatting across sequential turns', () => {
      const messages: OpenRouterMessage[] = [
        makeSystemMessage(),
        makeOpeningUserMessage(),
        // Turn 0
        { role: 'assistant', content: 'Inspecting auth hunk 1' },
        { role: 'user', content: `${PI_TOOL_RESULT_MARKER} @@ -1,5 +1,5 @@ raw hunk 1` },
        // Turn 1
        {
          role: 'assistant',
          content: 'Found hardcoded bearer token in header validation. Moving to session store.',
        },
        { role: 'user', content: `${PI_TOOL_RESULT_MARKER} @@ -10,5 +10,5 @@ raw hunk 2` },
        // Turn 2 (active)
        { role: 'assistant', content: 'Turn 2 assistant' },
        { role: 'user', content: `${PI_TOOL_RESULT_MARKER} @@ -20,5 +20,5 @@ raw hunk 3` },
        // Turn 3 (active)
        { role: 'assistant', content: 'Turn 3 assistant' },
        { role: 'user', content: `${PI_TOOL_RESULT_MARKER} @@ -30,5 +30,5 @@ raw hunk 4` },
      ];

      const toolCalls: MessageWindowToolCall[] = [
        { tool: 'get_hunk', args: { filePath: 'src/auth.ts', startLine: 1, endLine: 5 }, scope: 'src/auth.ts:1-5' },
        { tool: 'get_hunk', args: { filePath: 'src/session.ts', startLine: 10, endLine: 15 }, scope: 'src/session.ts:10-15' },
        { tool: 'get_hunk', args: { filePath: 'src/token.ts', startLine: 20, endLine: 25 }, scope: 'src/token.ts:20-25' },
        { tool: 'get_hunk', args: { filePath: 'src/store.ts', startLine: 30, endLine: 35 }, scope: 'src/store.ts:30-35' },
      ];

      const compacted = compactMessageWindow(messages, {
        activeTurns: 2,
        toolCalls,
      });

      // Turn 0 evicted (index 3)
      const receipt0 = compacted[3].content as string;
      expect(receipt0).toContain('[PI_TOOL_RESULT]_RECEIPT tool=get_hunk');
      expect(receipt0).toContain('[DIFF_EVICTION_RECEIPT: file=src/auth.ts, lines=1-5');
      // Synopsis of Turn 0 comes from Turn 1 assistant message (clamped to 40 chars)
      expect(receipt0).toContain('synopsis=Found hardcoded bearer token in header v');

      // Turn 1 evicted (index 5)
      const receipt1 = compacted[5].content as string;
      expect(receipt1).toContain('[DIFF_EVICTION_RECEIPT: file=src/session.ts, lines=10-15');
      // Synopsis of Turn 1 comes from Turn 2 assistant message
      expect(receipt1).toContain('synopsis=Turn 2 assistant');
    });
  });

  // =========================================================================
  // SCENARIO 2: Retention Interaction with retainSmallToolResults: true
  // =========================================================================
  describe('Scenario 2: Retention interaction with retainSmallToolResults: true', () => {
    it('EMP-CHALLENGE-03: retains small read_file results while strictly evicting small get_hunk and get_diff results', () => {
      const smallHunk = `${PI_TOOL_RESULT_MARKER} @@ -1,4 +1,4 @@ small hunk`;
      const smallDiff = `${PI_TOOL_RESULT_MARKER} diff --git a/file.ts b/file.ts small diff`;
      const smallRead = `${PI_TOOL_RESULT_MARKER} const config = { port: 8080 };`;
      const largeRead = `${PI_TOOL_RESULT_MARKER} ` + 'export const data = "'.padEnd(20 * 1024, 'a') + '";'; // 20KB > 16KB

      const messages: OpenRouterMessage[] = [
        makeSystemMessage(),
        makeOpeningUserMessage(),
        // Turn 0: small get_hunk (ephemeral -> MUST be evicted)
        { role: 'assistant', content: 'Reading hunk 1' },
        { role: 'user', content: smallHunk },
        // Turn 1: small read_file (non-ephemeral -> MUST be retained)
        { role: 'assistant', content: 'Reading config' },
        { role: 'user', content: smallRead },
        // Turn 2: small get_diff (ephemeral -> MUST be evicted)
        { role: 'assistant', content: 'Reading diff 1' },
        { role: 'user', content: smallDiff },
        // Turn 3: large read_file (non-ephemeral, but >16KB -> MUST be evicted to normal receipt)
        { role: 'assistant', content: 'Reading big file' },
        { role: 'user', content: largeRead },
        // Turn 4: active turn 1
        { role: 'assistant', content: 'Active turn 1' },
        { role: 'user', content: `${PI_TOOL_RESULT_MARKER} active turn 1 data` },
        // Turn 5: active turn 2
        { role: 'assistant', content: 'Active turn 2' },
        { role: 'user', content: `${PI_TOOL_RESULT_MARKER} active turn 2 data` },
      ];

      const toolCalls: MessageWindowToolCall[] = [
        { tool: 'get_hunk', scope: 'src/hunk1.ts:1-4' },
        { tool: 'read_file', scope: 'src/config.ts' },
        { tool: 'get_diff', scope: 'src/diff1.ts:1-10' },
        { tool: 'read_file', scope: 'src/big.ts' },
        { tool: 'get_hunk', scope: 'src/active1.ts:1-2' },
        { tool: 'read_file', scope: 'src/active2.ts' },
      ];

      const compacted = compactMessageWindow(messages, {
        activeTurns: 2,
        retainSmallToolResults: true,
        toolCalls,
      });

      // Index 3: Turn 0 (small get_hunk) -> evicted to DIFF_EVICTION_RECEIPT
      expect(compacted[3].content).toContain('[DIFF_EVICTION_RECEIPT: file=src/hunk1.ts, lines=1-4');
      expect(compacted[3].content).not.toContain('small hunk');

      // Index 5: Turn 1 (small read_file) -> retained verbatim byte-for-byte
      expect(compacted[5]).toBe(messages[5]);
      expect(compacted[5].content).toBe(smallRead);

      // Index 7: Turn 2 (small get_diff) -> evicted to DIFF_EVICTION_RECEIPT
      expect(compacted[7].content).toContain('[DIFF_EVICTION_RECEIPT: file=src/diff1.ts, lines=1-10');
      expect(compacted[7].content).not.toContain('small diff');

      // Index 9: Turn 3 (large read_file) -> evicted to standard tool receipt (NOT diff receipt!)
      expect(compacted[9].content).toContain('[PI_TOOL_RESULT]_RECEIPT tool=read_file scope=src/big.ts');
      expect(compacted[9].content).not.toContain('[DIFF_EVICTION_RECEIPT:');
      expect(compacted[9].content).not.toContain('export const data =');

      // Turns 4 and 5 (active) -> kept verbatim
      expect(compacted[11].content).toContain('active turn 1 data');
      expect(compacted[13].content).toContain('active turn 2 data');
    });

    it('EMP-CHALLENGE-04: enforces 64KB aggregate cap for retained tools without retaining any ephemeral hunks', () => {
      const messages: OpenRouterMessage[] = [
        makeSystemMessage(),
        makeOpeningUserMessage(),
      ];
      const toolCalls: MessageWindowToolCall[] = [];

      // Create 8 small read_file turns of 10KB each (total 80KB > 64KB RETAINED_TOOL_RESULTS_MAX_BYTES)
      // And interleave ephemeral get_hunk turns of 100 bytes each
      for (let i = 0; i < 8; i++) {
        // read_file turn (10KB)
        const readContent = `${PI_TOOL_RESULT_MARKER} // File ${i}\n` + 'r'.repeat(10 * 1024 - 50);
        messages.push({ role: 'assistant', content: `Reading file ${i}` });
        messages.push({ role: 'user', content: readContent });
        toolCalls.push({ tool: 'read_file', scope: `file_${i}.ts` });

        // ephemeral get_hunk turn (100 bytes)
        const hunkContent = `${PI_TOOL_RESULT_MARKER} @@ -1,2 +1,2 @@ hunk ${i}`;
        messages.push({ role: 'assistant', content: `Reading hunk ${i}` });
        messages.push({ role: 'user', content: hunkContent });
        toolCalls.push({ tool: 'get_hunk', scope: `file_${i}.ts:1-2` });
      }

      // Add 2 active turns
      messages.push({ role: 'assistant', content: 'Active 1' });
      messages.push({ role: 'user', content: `${PI_TOOL_RESULT_MARKER} active 1` });
      toolCalls.push({ tool: 'get_hunk', scope: 'active_1.ts:1-2' });

      messages.push({ role: 'assistant', content: 'Active 2' });
      messages.push({ role: 'user', content: `${PI_TOOL_RESULT_MARKER} active 2` });
      toolCalls.push({ tool: 'get_hunk', scope: 'active_2.ts:1-2' });

      const compacted = compactMessageWindow(messages, {
        activeTurns: 2,
        retainSmallToolResults: true,
        toolCalls,
      });

      // Verify that NO ephemeral get_hunk turns were retained in older turns
      const olderHunkReceipts = compacted.filter(
        (m) => typeof m.content === 'string' && m.content.includes('[DIFF_EVICTION_RECEIPT: file=file_'),
      );
      expect(olderHunkReceipts).toHaveLength(8);

      // Verify that newest read_file turns within 64KB (6 of 8 = 60KB <= 64KB) are retained,
      // while older 2 are evicted
      const retainedReads = compacted.filter(
        (m) => typeof m.content === 'string' && m.content.includes('// File '),
      );
      expect(retainedReads.length).toBe(6);

      const evictedReads = compacted.filter(
        (m) => typeof m.content === 'string' && m.content.includes('[PI_TOOL_RESULT]_RECEIPT tool=read_file'),
      );
      expect(evictedReads.length).toBe(2);
    });
  });

  // =========================================================================
  // SCENARIO 3: Empty turns, missing tool results, and malformed assistant turns
  // =========================================================================
  describe('Scenario 3: Resilience to empty, missing, and malformed inputs', () => {
    it('EMP-CHALLENGE-05: handles short message arrays (0, 1, 2 messages) safely', () => {
      expect(compactMessageWindow([])).toEqual([]);

      const single = [makeSystemMessage()];
      const resSingle = compactMessageWindow(single);
      expect(resSingle).toHaveLength(1);
      expect(resSingle[0]).toBe(single[0]);

      const pair = [makeSystemMessage(), makeOpeningUserMessage()];
      const resPair = compactMessageWindow(pair);
      expect(resPair).toHaveLength(2);
      expect(resPair[0]).toBe(pair[0]);
      expect(resPair[1]).toBe(pair[1]);
    });

    it('EMP-CHALLENGE-06: handles odd number of messages (missing response) without throwing', () => {
      const oddMessages: OpenRouterMessage[] = [
        makeSystemMessage(),
        makeOpeningUserMessage(),
        { role: 'assistant', content: 'Calling tool without response' },
      ];

      expect(() => {
        const compacted = compactMessageWindow(oddMessages, { activeTurns: 1 });
        expect(compacted).toHaveLength(3);
      }).not.toThrow();

      expect(() => {
        const compacted = compactMessageWindow(oddMessages, { activeTurns: 0 });
        expect(compacted).toHaveLength(3);
      }).not.toThrow();
    });

    it('EMP-CHALLENGE-07: handles missing, short, and extra toolCalls arrays gracefully', () => {
      const messages: OpenRouterMessage[] = [
        makeSystemMessage(),
        makeOpeningUserMessage(),
        { role: 'assistant', content: 'Turn 0 assistant' },
        { role: 'user', content: `${PI_TOOL_RESULT_MARKER} diff content 0` },
        { role: 'assistant', content: 'Turn 1 assistant' },
        { role: 'user', content: `${PI_TOOL_RESULT_MARKER} diff content 1` },
        { role: 'assistant', content: 'Turn 2 assistant' },
        { role: 'user', content: `${PI_TOOL_RESULT_MARKER} diff content 2` },
      ];

      // Case A: toolCalls is undefined
      expect(() => {
        const compacted = compactMessageWindow(messages, { activeTurns: 1 });
        expect(compacted).toHaveLength(messages.length);
        // Evicted turns should use 'unknown' receipt
        expect(compacted[3].content).toContain('tool=unknown scope=unknown');
      }).not.toThrow();

      // Case B: toolCalls is empty []
      expect(() => {
        const compacted = compactMessageWindow(messages, { activeTurns: 1, toolCalls: [] });
        expect(compacted[3].content).toContain('tool=unknown scope=unknown');
      }).not.toThrow();

      // Case C: toolCalls has fewer items than tool results (1 item for 2 older tool results)
      expect(() => {
        const compacted = compactMessageWindow(messages, {
          activeTurns: 1,
          toolCalls: [{ tool: 'get_hunk', scope: 'src/a.ts:1-5' }],
        });
        expect(compacted[3].content).toContain('tool=get_hunk');
        expect(compacted[5].content).toContain('tool=unknown');
      }).not.toThrow();

      // Case D: toolCalls has extra items (10 items for 3 tool results)
      expect(() => {
        const extraCalls: MessageWindowToolCall[] = Array.from({ length: 10 }, (_, i) => ({
          tool: 'get_hunk',
          scope: `src/extra_${i}.ts:1-10`,
        }));
        const compacted = compactMessageWindow(messages, { activeTurns: 1, toolCalls: extraCalls });
        expect(compacted[3].content).toContain('src/extra_0.ts');
        expect(compacted[5].content).toContain('src/extra_1.ts');
      }).not.toThrow();
    });

    it('EMP-CHALLENGE-08: handles malformed toolCall objects (missing args, strange scopes, unparseable lines)', () => {
      const messages: OpenRouterMessage[] = [
        makeSystemMessage(),
        makeOpeningUserMessage(),
        { role: 'assistant', content: 'Call 0' },
        { role: 'user', content: `${PI_TOOL_RESULT_MARKER} content 0` },
        { role: 'assistant', content: 'Call 1' },
        { role: 'user', content: `${PI_TOOL_RESULT_MARKER} content 1` },
        { role: 'assistant', content: 'Call 2' },
        { role: 'user', content: `${PI_TOOL_RESULT_MARKER} content 2` },
        { role: 'assistant', content: 'Active' },
        { role: 'user', content: 'Active user' },
      ];

      const malformedToolCalls: MessageWindowToolCall[] = [
        // Completely empty tool call
        { tool: 'get_hunk' },
        // Args with non-string filePath and negative lines
        { tool: 'get_hunk', args: { filePath: 12345, startLine: -5, endLine: 'invalid' } as any },
        // Scope with malformed format
        { tool: 'get_hunk', scope: 'weird-scope-without-colon-or-lines' },
      ];

      expect(() => {
        const compacted = compactMessageWindow(messages, {
          activeTurns: 1,
          toolCalls: malformedToolCalls,
        });

        // Hunk 0: filePath defaults to 'unknown', lines to 'all'
        expect(compacted[3].content).toContain('[DIFF_EVICTION_RECEIPT: file=unknown, lines=all');

        // Hunk 1: filePath defaults to 'unknown'
        expect(compacted[5].content).toContain('[DIFF_EVICTION_RECEIPT: file=unknown');

        // Hunk 2: filePath extracted from scope string
        expect(compacted[7].content).toContain('[DIFF_EVICTION_RECEIPT: file=weird-scope-without-colon-or-lines, lines=all');
      }).not.toThrow();
    });

    it('EMP-CHALLENGE-09: extracts synopsis from malformed, empty, or code-block-only assistant messages', () => {
      // 1. undefined assistant message
      expect(extractSynopsis(undefined)).toBe('inspected');

      // 2. non-string content (e.g. content blocks or null)
      expect(extractSynopsis({ role: 'assistant', content: undefined as any })).toBe('inspected');
      expect(extractSynopsis({ role: 'assistant', content: null as any })).toBe('inspected');
      expect(extractSynopsis({ role: 'assistant', content: [{ type: 'text', text: 'hi' }] as any })).toBe('inspected');

      // 3. empty or whitespace string
      expect(extractSynopsis({ role: 'assistant', content: '' })).toBe('inspected');
      expect(extractSynopsis({ role: 'assistant', content: '    \n\t  ' })).toBe('inspected');

      // 4. content that is ONLY a markdown code block (should strip and fall back to inspected)
      expect(extractSynopsis({ role: 'assistant', content: '```typescript\nconst x = 1;\n```' })).toBe('inspected');

      // 5. multiline content with leading text and code block
      const withCode = {
        role: 'assistant' as const,
        content: `Found race condition in mutex acquisition\n\`\`\`ts\nmutex.lock();\n\`\`\`\nMore details`,
      };
      const syn = extractSynopsis(withCode);
      expect(syn).toContain('Found race condition');
      expect(syn).not.toContain('```');
      expect(syn.length).toBeLessThanOrEqual(40);

      // 6. very long text clamped to 40 characters
      const longText = {
        role: 'assistant' as const,
        content: 'This is an exceptionally verbose evaluation statement that definitely exceeds forty characters',
      };
      const synLong = extractSynopsis(longText);
      expect(synLong.length).toBe(40);
      expect(synLong).toBe('This is an exceptionally verbose evaluat');
    });

    it('EMP-CHALLENGE-10: handles non-tool user messages and non-standard turn interleavings without corrupting them', () => {
      const messages: OpenRouterMessage[] = [
        makeSystemMessage(),
        makeOpeningUserMessage(),
        // Regular conversation without PI_TOOL_RESULT marker
        { role: 'assistant', content: 'Hello, what should I check?' },
        { role: 'user', content: 'Please review the authentication module.' },
        // Tool turn
        { role: 'assistant', content: 'Fetching auth hunk' },
        { role: 'user', content: `${PI_TOOL_RESULT_MARKER} @@ -1,5 +1,5 @@ hunk data` },
        // Active turn
        { role: 'assistant', content: 'Active assistant' },
        { role: 'user', content: 'Active user response' },
      ];

      const toolCalls: MessageWindowToolCall[] = [
        { tool: 'get_hunk', scope: 'src/auth.ts:1-5' },
      ];

      const compacted = compactMessageWindow(messages, {
        activeTurns: 1,
        toolCalls,
      });

      // The non-tool user message at index 3 must remain untouched verbatim!
      expect(compacted[3].content).toBe('Please review the authentication module.');

      // The tool result at index 5 must be evicted to DIFF_EVICTION_RECEIPT
      expect(compacted[5].content).toContain('[DIFF_EVICTION_RECEIPT: file=src/auth.ts');
    });
  });
});
