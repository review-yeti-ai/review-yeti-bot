import { MAX_PINNED_SOURCE_BYTES, MAX_SOURCE_CACHE_BYTES, MAX_SOURCE_CACHE_ENTRIES } from '../utils/sourceLimits';
import { createHash } from 'node:crypto';
import type { ToolRuntimeContext, ToolRuntimeResult } from './toolRuntime';
import { classifyUnavailablePatch } from '../review/patchAvailability';
import { normalizeRepoPath } from './pathMatch';
import { raceWithPanelAbort, throwIfPanelAborted } from './panelAbort';

/** Offsets count UTF-16 code units, so even one enormous source line is pageable. */
export const EVIDENCE_PAGE_MAX_CHARS = 32_000;
// A run's provider owns a bounded cache; different reviews cannot reuse receipts.
const digestCaches = new WeakMap<object, Map<string, { text: string; digest: string; bytes: number }>>();
function evidenceDigest(owner: object, key: string, text: string): string {
  let cache = digestCaches.get(owner);
  if (!cache) { cache = new Map(); digestCaches.set(owner, cache); }
  const hit = cache.get(key);
  if (hit?.text === text) return hit.digest;
  const digest = createHash('sha256').update(key).update('\0').update(text).digest('hex');
  const bytes = Buffer.byteLength(text);
  cache.delete(key);
  if (bytes <= MAX_PINNED_SOURCE_BYTES) cache.set(key, { text, digest, bytes });
  let total = [...cache.values()].reduce((sum, entry) => sum + entry.bytes, 0);
  while (cache.size > MAX_SOURCE_CACHE_ENTRIES || total > MAX_SOURCE_CACHE_BYTES) {
    const oldest = cache.keys().next().value!;
    total -= cache.get(oldest)!.bytes; cache.delete(oldest);
  }
  return digest;
}

export async function readEvidencePage(
  tool: 'get_diff_page' | 'read_file_page', args: any, context: ToolRuntimeContext,
): Promise<ToolRuntimeResult> {
  const scope = tool === 'get_diff_page' ? 'original-admitted-diff' : 'pinned-repository-source';
  const result = (value: Record<string, unknown>, exhaustive = false): ToolRuntimeResult => ({
    toolScope: scope, isExhaustive: exhaustive, toolOutput: JSON.stringify(value),
  });
  const keys = tool === 'get_diff_page'
    ? ['path', 'startOffset', 'maxChars', 'digest'] : ['path', 'side', 'startOffset', 'maxChars', 'digest'];
  if (!args || typeof args !== 'object' || Array.isArray(args)
    || Object.keys(args).some((key) => !keys.includes(key))
    || typeof args.path !== 'string' || !args.path.trim() || args.path.length > 4096
    || (args.startOffset !== undefined && (!Number.isSafeInteger(args.startOffset) || args.startOffset < 0))
    || (args.maxChars !== undefined && (!Number.isSafeInteger(args.maxChars) || args.maxChars < 1 || args.maxChars > EVIDENCE_PAGE_MAX_CHARS))
    || (args.digest !== undefined && !/^[0-9a-f]{64}$/u.test(args.digest))
    || (tool === 'read_file_page' && !['head', 'merge-base'].includes(args.side))) {
    return result({ status: 'invalid', reason: 'invalid_page_arguments' });
  }
  const path = normalizeRepoPath(args.path);
  if (!path || path.split('/').includes('..') || path.includes('\0')) {
    return result({ status: 'invalid', reason: 'invalid_path' });
  }
  throwIfPanelAborted(context.signal);
  let text: string;
  let sha: string | undefined;
  let identity: { repository: string; baseSha: string; headSha: string } | undefined;
  try {
    if (tool === 'get_diff_page') {
      const original = context.repoFileProvider?.readDiff?.(path)
        ?? (context.originalChangedFiles ?? context.changedFiles).find((file) => file.path === path);
      if (typeof original?.patch !== 'string' || classifyUnavailablePatch(original.patch) !== null
        || (original.originalPatchLength ?? 0) > original.patch.length) {
        return result({ status: 'unavailable', reason: 'original_diff_unavailable', path });
      }
      text = original.patch;
      identity = original.identity;
    } else {
      if (!context.repoFileProvider?.readFileAt) return result({ status: 'unavailable', reason: 'pinned_source_unavailable', path });
      const source = await raceWithPanelAbort(context.repoFileProvider.readFileAt(path, args.side), context.signal);
      if (!/^[0-9a-f]{40}$/u.test(source.sha) || source.content === null) {
        return result({ status: 'unavailable', reason: 'pinned_source_unavailable', path, side: args.side });
      }
      text = source.content;
      sha = source.sha;
    }
  } catch {
    throwIfPanelAborted(context.signal);
    return result({ status: 'unavailable', reason: 'source_lookup_failed', path });
  }
  throwIfPanelAborted(context.signal);
  const digest = evidenceDigest(context.repoFileProvider ?? context.originalChangedFiles ?? context.changedFiles,
    JSON.stringify({ identity, sha, side: args.side, path }), text);
  if (args.digest !== undefined && args.digest !== digest) return result({ status: 'invalid', reason: 'evidence_digest_mismatch', path });
  const startOffset = args.startOffset ?? 0;
  if (startOffset > text.length) return result({ status: 'invalid', reason: 'offset_out_of_range', path });
  const endOffset = Math.min(text.length, startOffset + (args.maxChars ?? 16_000));
  return result({ status: 'ok', path, ...(sha ? { sha, side: args.side } : {}), ...(identity ? { identity } : {}), digest,
    offsetUnit: 'utf16-code-units', totalChars: text.length, startOffset, endOffset,
    nextOffset: endOffset < text.length ? endOffset : null,
    pageComplete: true, content: text.slice(startOffset, endOffset),
  }, startOffset === 0 && endOffset === text.length);
}
