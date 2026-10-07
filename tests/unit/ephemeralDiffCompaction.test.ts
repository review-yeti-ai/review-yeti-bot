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

function systemMessage(): OpenRouterMessage {
  return { role: 'system', content: 'You are a fail-closed review worker.' };
}

function openingUserMessage(): OpenRouterMessage {
  const content: OpenRouterContentBlock[] = [
    {
      type: 'text',
      text: 'Static AST outline prefix requiring cache breakpoint preservation.',
      cache_control: { type: 'ephemeral' },
    },
  ];
  return { role: 'user', content };
}

describe('Ephemeral Diff Compaction & Lifecycle', () => {
  describe('Ephemeral Classification Helpers', () => {
    it('identifies get_hunk and get_diff as ephemeral tools by default', () => {
      expect(isEphemeralTool('get_hunk')).toBe(true);
      expect(isEphemeralTool('get_diff')).toBe(true);
      expect(isEphemeralTool('read_file')).toBe(false);
      expect(isEphemeralTool('symbol_search')).toBe(false);
      expect(isEphemeralTool('undefined')).toBe(false);
      expect(isEphemeralTool(undefined)).toBe(false);
    });

    it('honors custom ephemeralTools configuration list', () => {
      const custom = ['custom_hunk', 'temp_patch'];
      expect(isEphemeralTool('custom_hunk', custom)).toBe(true);
      expect(isEphemeralTool('get_hunk', custom)).toBe(false);
    });

    it('parses target file path and line numbers from toolCall scope and args', () => {
      const fromScope = parseHunkTarget({
        tool: 'get_hunk',
        scope: 'src/auth/jwt.ts:15-30',
      });
      expect(fromScope.filePath).toBe('src/auth/jwt.ts');
      expect(fromScope.startLine).toBe(15);
      expect(fromScope.endLine).toBe(30);

      const fromArgs = parseHunkTarget({
        tool: 'get_hunk',
        args: { filePath: 'src/db/repo.ts', startLine: 100, endLine: 125 },
        scope: 'assigned-hunk',
      });
      expect(fromArgs.filePath).toBe('src/db/repo.ts');
      expect(fromArgs.startLine).toBe(100);
      expect(fromArgs.endLine).toBe(125);
    });

    it('extracts concise synopsis from subsequent assistant evaluation message', () => {
      const assistantMsg: OpenRouterMessage = {
        role: 'assistant',
        content: 'Inspected lines 10-25. The token signature validation lacks expiry check.',
      };
      const synopsis = extractSynopsis(assistantMsg);
      expect(synopsis).toContain('Inspected lines 10-25');
      expect(synopsis.length).toBeLessThanOrEqual(40);

      expect(extractSynopsis(undefined)).toBe('inspected');
      expect(extractSynopsis({ role: 'assistant', content: '   ' })).toBe('inspected');
    });
  });

  describe('compactMessageWindow Eviction Behavior', () => {
    it('preserves system and user messages by reference', () => {
      const sys = systemMessage();
      const openUser = openingUserMessage();
      const messages: OpenRouterMessage[] = [
        sys,
        openUser,
        { role: 'assistant', content: 'Calling get_hunk' },
        { role: 'user', content: `${PI_TOOL_RESULT_MARKER} @@ -1,5 +1,5 @@ raw diff` },
      ];
      const result = compactMessageWindow(messages, { activeTurns: 0 });
      expect(result[0]).toBe(sys);
      expect(result[1]).toBe(openUser);
      expect(Object.is(result[0], sys)).toBe(true);
      expect(Object.is(result[1], openUser)).toBe(true);
    });

    it('evicts get_hunk results older than activeTurns and formats [DIFF_EVICTION_RECEIPT]', () => {
      const rawPayload = `${PI_TOOL_RESULT_MARKER}\n@@ -10,10 +10,15 @@\n+added line 1\n+added line 2\n` + 'x'.repeat(1200);
      const byteCount = Buffer.byteLength(rawPayload, 'utf8');

      const messages: OpenRouterMessage[] = [
        systemMessage(),
        openingUserMessage(),
        // Turn 0 (older, to be evicted)
        { role: 'assistant', content: '{"tool":"get_hunk","args":{"filePath":"src/auth/jwt.ts","startLine":10,"endLine":25}}' },
        { role: 'user', content: rawPayload },
        // Turn 1 (older evaluation turn providing synopsis)
        { role: 'assistant', content: 'Found signature bypass defect on line 12.' },
        { role: 'user', content: 'Continue investigation.' },
        // Turn 2 (active turn)
        { role: 'assistant', content: 'Checking secondary file.' },
        { role: 'user', content: `${PI_TOOL_RESULT_MARKER} active diff content` },
      ];

      const toolCalls: MessageWindowToolCall[] = [
        {
          tool: 'get_hunk',
          args: { filePath: 'src/auth/jwt.ts', startLine: 10, endLine: 25 },
          scope: 'assigned-hunk',
          exhaustive: true,
        },
        {
          tool: 'get_hunk',
          args: { filePath: 'src/sec/gate.ts', startLine: 1, endLine: 5 },
          scope: 'assigned-hunk',
          exhaustive: true,
        },
      ];

      const compacted = compactMessageWindow(messages, { activeTurns: 1, toolCalls });

      // Turn 0 user message (index 3) should be evicted
      const receiptMsg = compacted[3];
      expect(receiptMsg.role).toBe('user');
      expect(typeof receiptMsg.content).toBe('string');
      const text = receiptMsg.content as string;

      expect(text).toContain('tool=get_hunk');
      expect(text).toContain(`bytes_elided=${byteCount}`);
      expect(text).toContain('[DIFF_EVICTION_RECEIPT: file=src/auth/jwt.ts, lines=10-25');
      expect(text).toContain('synopsis=Found signature bypass');

      // The large raw diff payload must be elided
      expect(text).not.toContain('x'.repeat(100));
      expect(text.length).toBeLessThan(250);

      // Active turn remains untouched
      expect(compacted[compacted.length - 1].content).toBe(`${PI_TOOL_RESULT_MARKER} active diff content`);
    });

    it('ensures retainSmallToolResults: true does NOT retain ephemeral diff hunks', () => {
      // Create a small 500-byte get_hunk result and a small 500-byte read_file result
      const smallHunk = `${PI_TOOL_RESULT_MARKER} @@ -1,3 +1,3 @@ small hunk diff payload`;
      const smallRead = `${PI_TOOL_RESULT_MARKER} file contents of config.json`;

      const messages: OpenRouterMessage[] = [
        systemMessage(),
        openingUserMessage(),
        // Turn 0: ephemeral get_hunk (small, but must be evicted)
        { role: 'assistant', content: 'Fetch hunk' },
        { role: 'user', content: smallHunk },
        // Turn 1: non-ephemeral read_file (small, must be retained)
        { role: 'assistant', content: 'Read config' },
        { role: 'user', content: smallRead },
        // Turn 2 & 3: active turns
        { role: 'assistant', content: 'Turn 2' },
        { role: 'user', content: 'Turn 2 response' },
        { role: 'assistant', content: 'Turn 3' },
        { role: 'user', content: 'Turn 3 response' },
      ];

      const toolCalls: MessageWindowToolCall[] = [
        { tool: 'get_hunk', scope: 'src/app.ts:1-10' },
        { tool: 'read_file', scope: 'full-repository', exhaustive: true },
      ];

      const compacted = compactMessageWindow(messages, {
        activeTurns: 2,
        retainSmallToolResults: true,
        toolCalls,
      });

      // Turn 0 (get_hunk) must be evicted into receipt despite small size
      const hunkTurn = compacted[3];
      expect(hunkTurn.content).toContain('[DIFF_EVICTION_RECEIPT:');
      expect(hunkTurn.content).not.toContain('small hunk diff payload');

      // Turn 1 (read_file) must be retained verbatim byte-for-byte because retainSmallToolResults is true
      const readTurn = compacted[5];
      expect(readTurn).toBe(messages[5]);
      expect(readTurn.content).toBe(smallRead);
    });

    it('also evicts get_diff tool results as ephemeral', () => {
      const rawDiff = `${PI_TOOL_RESULT_MARKER} diff --git a/src/a.ts b/src/a.ts\n...`;
      const messages: OpenRouterMessage[] = [
        systemMessage(),
        openingUserMessage(),
        { role: 'assistant', content: 'Fetch get_diff' },
        { role: 'user', content: rawDiff },
        { role: 'assistant', content: 'Evaluated diff.' },
        { role: 'user', content: 'Next action' },
      ];
      const toolCalls: MessageWindowToolCall[] = [
        { tool: 'get_diff', scope: 'src/a.ts:1-50' },
      ];

      const compacted = compactMessageWindow(messages, {
        activeTurns: 0,
        toolCalls,
      });

      const receipt = compacted[3];
      expect(receipt.content).toContain('tool=get_diff');
      expect(receipt.content).toContain('[DIFF_EVICTION_RECEIPT: file=src/a.ts, lines=1-50');
    });
  });

  describe('Token Consumption & Bounded Turn Window Stability', () => {
    it('maintains flat token consumption (<2k tokens / <8000 chars) across 10 sequential hunk reads', () => {
      const messages: OpenRouterMessage[] = [
        systemMessage(),
        openingUserMessage(),
      ];
      const toolCalls: MessageWindowToolCall[] = [];

      for (let turn = 0; turn < 10; turn++) {
        messages.push({
          role: 'assistant',
          content: `Inspecting hunk ${turn} for memory safety.`,
        });
        messages.push({
          role: 'user',
          content: `${PI_TOOL_RESULT_MARKER} @@ -${turn * 10},10 +${turn * 10},15 @@\n` + 'z'.repeat(2500),
        });
        toolCalls.push({
          tool: 'get_hunk',
          args: { filePath: `src/mod_${turn}.ts`, startLine: turn * 10, endLine: turn * 10 + 15 },
          scope: `src/mod_${turn}.ts:${turn * 10}-${turn * 10 + 15}`,
          exhaustive: true,
        });
      }

      // Compact keeping activeTurns = 2
      const compacted = compactMessageWindow(messages, {
        activeTurns: 2,
        retainSmallToolResults: true,
        toolCalls,
      });

      // 8 older hunk results evicted, 2 active hunk results full
      const olderReceipts = compacted.filter(
        (m) => typeof m.content === 'string' && m.content.includes('[DIFF_EVICTION_RECEIPT:'),
      );
      expect(olderReceipts).toHaveLength(8);

      const totalChars = compacted.reduce(
        (acc, m) => acc + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length),
        0,
      );

      // 8000 characters is approximately 2000 tokens
      expect(totalChars).toBeLessThan(8000);
    });
  });
});
