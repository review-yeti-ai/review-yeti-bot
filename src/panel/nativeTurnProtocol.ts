/** Shared native-turn wire rules. Engine-specific nonce and result contracts stay in their engines. */
export type NativeToolCall = {
  tool: string;
  args: Record<string, unknown>;
};

export function isNativeJsonObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function nativeJsonContent(content: string): string {
  const trimmed = content.trim();
  // Accept only a single Markdown JSON fence around the complete response. Never extract
  // embedded JSON from prose, multiple fences, or a quoted example.
  const fenced = trimmed.match(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

/** A nonce-free, exact tool envelope; a hybrid final-result object must fail closed. */
export function parseNativeToolCallValue(value: unknown): NativeToolCall | null {
  if (!isNativeJsonObject(value)) return null;
  const keys = Object.keys(value);
  if (keys.some((key) => key !== 'tool' && key !== 'args')) return null;
  if (typeof value.tool !== 'string' || !value.tool.trim()) return null;
  if (!Object.prototype.hasOwnProperty.call(value, 'args')) return null;
  if (!isNativeJsonObject(value.args)) return null;
  return { tool: value.tool, args: value.args };
}

export function parseNativeToolCall(content: string): NativeToolCall | null {
  try {
    return parseNativeToolCallValue(JSON.parse(nativeJsonContent(content)));
  } catch {
    return null;
  }
}
