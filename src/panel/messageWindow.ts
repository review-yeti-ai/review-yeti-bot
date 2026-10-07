import { OpenRouterMessage } from '../gateway/openRouterClient';

/**
 * Structural turn-window compaction for the persona tool loop.
 *
 * `panelEngine.ts`'s `invoke()` grows `messages` by one (assistant, user) pair per turn and
 * re-sends the whole array on every subsequent provider call, up to `MAX_INVESTIGATION_TURNS`
 * (15). A single `read_file` tool result can inject up to `REPO_READ_FILE_MAX_CHARS` (512KB) of
 * file content into one `[PI_TOOL_RESULT]` user message; left uncompacted, that payload is
 * re-sent on every following turn for the rest of the session.
 *
 * `compactMessageWindow` collapses OLDER tool-result turns to a short receipt line while leaving
 * the most recent `activeTurns` turns, and the static system/user prefix, untouched.
 * Production loops additionally retain small older reads within a fixed aggregate byte bound;
 * evidence that fits this window remains byte-for-byte source, never a synthesized summary. It is purely
 * structural: it never reads, extracts, or synthesizes review findings from message content. The
 * receipt line is derived from the caller-supplied `toolCalls[]` record (tool name, scope,
 * exhaustive), never by re-parsing the `[PI_TOOL_RESULT]` string -- the string's format is free to
 * change without silently breaking compaction.
 *
 * Do NOT reach for `src/pipeline/turnHistoryManager.ts` here. Its `TurnMessage.content` is typed
 * `string` only, so wiring its `getFormattedMessages()` output in verbatim would flatten
 * `messages[1]`'s `OpenRouterContentBlock[]` and destroy the `cache_control: {type:'ephemeral'}`
 * breakpoint below. Its `extractFindings` scraper is also an unvalidated second findings path that
 * has no business anywhere near compaction or arbitration.
 */

/** Marker panelEngine.ts prefixes every tool-result turn's user message with. */
export const PI_TOOL_RESULT_MARKER = '[PI_TOOL_RESULT]';

/** Number of most-recent assistant/user turn pairs kept at full fidelity. */
export const DEFAULT_ACTIVE_TURNS = 2;

// Keep small inspected source available across unrelated tool turns. This is
// retained input context, not a limit on model generation or review coverage.
export const SMALL_TOOL_RESULT_MAX_BYTES = 16 * 1024;
export const RETAINED_TOOL_RESULTS_MAX_BYTES = 64 * 1024;

/**
 * One entry per tool call the loop actually executed, in the same left-to-right order as the
 * `[PI_TOOL_RESULT]` user messages appear in `messages`. Mirrors the `toolCalls` array
 * panelEngine.ts's `invoke()` builds in its turn loop: declared once per invocation, pushed
 * exactly once per tool turn immediately before that turn's (assistant, user) message pair.
 */
export interface MessageWindowToolCall {
  tool: string;
  args?: unknown;
  scope?: string;
  exhaustive?: boolean;
}

export interface MessageWindowPolicy {
  /** Preserve newest small older tool results within the fixed aggregate byte bound. */
  retainSmallToolResults?: boolean;
  /** Most-recent assistant/user pairs kept verbatim. Default `DEFAULT_ACTIVE_TURNS` (2). */
  activeTurns?: number;
  /**
   * Tool-call receipts aligned 1:1, in encounter order, with the `[PI_TOOL_RESULT]` messages
   * present in `messages`. Missing or short arrays degrade gracefully to an "unknown" receipt
   * rather than throwing -- compaction must never fail a review turn.
   */
  toolCalls?: readonly MessageWindowToolCall[];
  /** Ephemeral tools whose raw diff payloads are evicted from older turns into finding synopses */
  ephemeralTools?: readonly string[];
}

export const DEFAULT_EPHEMERAL_TOOLS: readonly string[] = ['get_hunk', 'get_diff'];

export function isEphemeralTool(toolName: string | undefined, ephemeralTools?: readonly string[]): boolean {
  if (!toolName) return false;
  if (ephemeralTools) {
    return ephemeralTools.includes(toolName);
  }
  return DEFAULT_EPHEMERAL_TOOLS.includes(toolName);
}

export function parseHunkTarget(call: MessageWindowToolCall | undefined): { filePath: string; startLine?: number; endLine?: number } {
  if (!call) return { filePath: 'unknown' };
  const args = call.args as any;
  let filePath = typeof args?.filePath === 'string' ? args.filePath : (typeof args?.path === 'string' ? args.path : undefined);
  let startLine = typeof args?.startLine === 'number' ? args.startLine : (typeof args?.start_line === 'number' ? args.start_line : undefined);
  let endLine = typeof args?.endLine === 'number' ? args.endLine : (typeof args?.end_line === 'number' ? args.end_line : undefined);

  if (!filePath && call.scope) {
    const match = call.scope.match(/^(.*?):(\d+)-(\d+)$/);
    if (match) {
      filePath = match[1];
      startLine = parseInt(match[2], 10);
      endLine = parseInt(match[3], 10);
    } else {
      filePath = call.scope;
    }
  }

  return { filePath: filePath || 'unknown', startLine, endLine };
}

export function extractSynopsis(assistantMessage: OpenRouterMessage | undefined): string {
  if (!assistantMessage || typeof assistantMessage.content !== 'string') return 'inspected';
  const text = assistantMessage.content.trim();
  const clean = text.replace(/```[\s\S]*?```/g, '').replace(/[\r\n]+/g, ' ').trim();
  if (!clean) return 'inspected';
  return clean.slice(0, 40);
}

function isToolResultMessage(message: OpenRouterMessage): message is OpenRouterMessage & { content: string } {
  return message.role === 'user'
    && typeof message.content === 'string'
    && message.content.startsWith(PI_TOOL_RESULT_MARKER);
}

function formatReceiptLine(
  call: MessageWindowToolCall | undefined,
  elidedBytes: number,
  synopsis?: string,
  ephemeralTools?: readonly string[],
): string {
  const tool = call?.tool ?? 'unknown';
  const scope = call?.scope ?? 'unknown';
  const exhaustive = call?.exhaustive ?? false;

  if (isEphemeralTool(tool, ephemeralTools)) {
    const { filePath, startLine, endLine } = parseHunkTarget(call);
    const lineStr = startLine !== undefined && endLine !== undefined
      ? `${startLine}-${endLine}`
      : 'all';
    const syn = (synopsis || (call as any)?.synopsis || 'inspected').slice(0, 40);
    return `${PI_TOOL_RESULT_MARKER}_RECEIPT tool=${tool} scope=${scope} exhaustive=${exhaustive} bytes_elided=${elidedBytes} [DIFF_EVICTION_RECEIPT: file=${filePath}, lines=${lineStr}, bytes_elided=${elidedBytes}, synopsis=${syn}]`;
  }

  return `${PI_TOOL_RESULT_MARKER}_RECEIPT tool=${tool} scope=${scope} exhaustive=${exhaustive} bytes_elided=${elidedBytes}`;
}

/**
 * Compact the turn-window `messages` array for the next provider call.
 *
 * `messages[0]` (system prompt) and `messages[1]` (the static, cache-breakpointed opening user
 * turn) are returned BY REFERENCE, unmodified -- `result[0] === messages[0]` and
 * `result[1] === messages[1]` always hold. Rebuilding either destroys the OpenRouter
 * `cache_control: {type:'ephemeral'}` breakpoint `messages[1].content` (an `OpenRouterContentBlock[]`)
 * carries on the static prefix, turning every subsequent turn into a cold prefill -- worse
 * latency while looking like "the model got slower".
 *
 * This function never mutates the input array or its elements; `messages` stays the full
 * append-only record in the caller and this is recomputed fresh from it every turn.
 */
export function compactMessageWindow(
  messages: readonly OpenRouterMessage[],
  policy: MessageWindowPolicy = {},
): OpenRouterMessage[] {
  const activeTurns = Math.max(0, policy.activeTurns ?? DEFAULT_ACTIVE_TURNS);
  const toolCalls = policy.toolCalls ?? [];

  // Nothing beyond the static system/user prefix yet -- return the elements as-is (still
  // reference-identical; `.slice()` copies the array container, not its elements).
  if (messages.length <= 2) {
    return messages.slice();
  }

  const head: OpenRouterMessage[] = [messages[0], messages[1]];
  const rest = messages.slice(2);

  // `rest` is always a sequence of (assistant, user) pairs -- panelEngine.ts's `invoke()` pushes
  // both messages of a turn together, in the same code path, with no interruption. The odd-length
  // branch below is defensive only; it should never trigger against the real caller.
  const turns: OpenRouterMessage[][] = [];
  for (let i = 0; i < rest.length;) {
    if (rest[i].role === 'assistant' && i + 1 < rest.length) {
      turns.push([rest[i], rest[i + 1]]);
      i += 2;
    } else {
      turns.push([rest[i]]);
      i += 1;
    }
  }

  const splitAt = Math.max(0, turns.length - activeTurns);
  const olderTurns = turns.slice(0, splitAt);
  const activeTurnMessages = turns.slice(splitAt).flat();

  // `toolResultIndex` walks `toolCalls[]` in lockstep with encounter order of `[PI_TOOL_RESULT]`
  // messages, starting from the very first older turn -- the same order panelEngine.ts populated
  // both arrays in, so this stays aligned without needing to touch the active window.
  // Aligned scan of older tool-result messages with their corresponding toolCall
  const olderToolResults: Array<{ message: OpenRouterMessage & { content: string }; call?: MessageWindowToolCall; turnIndex: number }> = [];
  let trScanIdx = 0;
  for (let t = 0; t < olderTurns.length; t++) {
    for (const msg of olderTurns[t]) {
      if (isToolResultMessage(msg)) {
        olderToolResults.push({ message: msg, call: toolCalls[trScanIdx], turnIndex: t });
        trScanIdx++;
      }
    }
  }

  const retained = new Set<OpenRouterMessage>();
  if (policy.retainSmallToolResults === true) {
    let retainedBytes = 0;
    for (let i = olderToolResults.length - 1; i >= 0; i--) {
      const { message, call } = olderToolResults[i];
      // Ephemeral tool results (get_hunk, get_diff) are evicted regardless of payload size
      if (isEphemeralTool(call?.tool, policy.ephemeralTools)) {
        continue;
      }
      const bytes = Buffer.byteLength(message.content, 'utf8');
      if (bytes <= SMALL_TOOL_RESULT_MAX_BYTES && retainedBytes + bytes <= RETAINED_TOOL_RESULTS_MAX_BYTES) {
        retained.add(message);
        retainedBytes += bytes;
      }
    }
  }

  let toolResultIndex = 0;
  const compactedOlder: OpenRouterMessage[] = [];
  for (let t = 0; t < olderTurns.length; t++) {
    const turn = olderTurns[t];
    for (const message of turn) {
      if (isToolResultMessage(message)) {
        const call = toolCalls[toolResultIndex];
        toolResultIndex += 1;
        if (retained.has(message)) {
          compactedOlder.push(message);
        } else {
          const nextTurn = olderTurns[t + 1] ?? turns[splitAt];
          const nextAssistantMsg = nextTurn?.[0];
          const synopsis = extractSynopsis(nextAssistantMsg);
          compactedOlder.push({
            role: 'user',
            content: formatReceiptLine(
              call,
              Buffer.byteLength(message.content, 'utf8'),
              synopsis,
              policy.ephemeralTools,
            ),
          });
        }
      } else {
        compactedOlder.push(message);
      }
    }
  }

  return [...head, ...compactedOlder, ...activeTurnMessages];
}
