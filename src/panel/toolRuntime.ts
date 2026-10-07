/**
 * Read-only tool execution for the persona review loop.
 *
 * Extracted verbatim from `panelEngine.ts`'s `invoke()` tool-handling block (the
 * `if (toolCall && toolCall.tool) { ... }` branch) so a future single-context review engine can
 * execute the exact same tools with the exact same semantics as the persona fan-out. The two
 * engines must never drift on tool behaviour -- if they did, a shadow comparison between engines
 * would be comparing tool behaviour, not engine behaviour, and would be meaningless.
 *
 * This module is intentionally the *pure* half of that block: given a tool name, its args, and
 * the read-only context (changed files, repo file provider, Zoekt/MCP configuration, size limits,
 * abort signal), it returns the tool's output and scope envelope. Loop bookkeeping --
 * incrementing turn counters, recording turn usage, pushing to the tool-call log, pushing the
 * assistant/tool-result message pair, and the `continue` -- stays in `panelEngine.ts`'s loop; it
 * is not tool semantics.
 *
 * The `scope` / `exhaustive` envelope on every branch is deliberate and must not be "tidied": a
 * patch-scoped search that finds nothing must not be reported to the model as "this symbol does
 * not exist anywhere" -- that is the documented root cause of a real false-positive class in this
 * system.
 */
import { readEvidencePage } from './evidencePages';
import { mcpFleetManager } from '../mcp/mcpFleetManager';
import { ASTParser } from '../indexer/astParser';
import {
  REPO_FIND_FILES_MAX_HITS,
  filePatchChars,
  isOversizedFileDiff,
  raceWithPanelAbort,
  resolveMaxFileDiffChars,
  throwIfPanelAborted,
  type RepoFileProvider,
} from './panelEngine';
import { READ_FILES_MAX_BYTES, READ_FILES_MAX_FILES, REPO_READ_FILE_MAX_CHARS } from './toolLimits';
import { createPathMatcher, isGlobQuery, normalizeRepoPath } from './pathMatch';

/** Read-only inputs a tool call may need. Mirrors the subset of `invoke()`'s options the original block closed over. */
export interface ToolRuntimeContext {
  changedFiles: any[];
  originalChangedFiles?: any[];
  repoFileProvider?: RepoFileProvider;
  zoektConfig?: any;
  signal?: AbortSignal;
}

export interface ToolRuntimeResult {
  toolOutput: string;
  toolScope: string;
  isExhaustive: boolean;
}

export interface GetHunkArgs {
  filePath: string;
  startLine?: number;
  endLine?: number;
  contextLines?: number;
}

export interface ModifiedLineItem {
  line: number;
  type: 'add' | 'delete' | 'context';
  content: string;
}

export interface DiffHunkBoundary {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  modifiedLineNumbers: number[];
  section?: string;
}

export type GetHunkResult =
  | {
      status: 'success';
      filePath: string;
      startLine: number;
      endLine: number;
      patch: string;
      modifiedLines: ModifiedLineItem[];
      scope: 'assigned-hunk';
      isExhaustive: boolean;
    }
  | {
      status: 'rejected';
      error: 'path_not_changed' | 'invalid_arguments' | 'no_diff_in_range' | 'range_out_of_bounds';
      message: string;
      filePath: string;
    };

export const GET_HUNK_TOOL_SCHEMA = {
  name: 'get_hunk',
  description: 'Extracts specific diff hunk lines for admitted changed files intersecting [startLine, endLine]. Returns unified diff patch, line annotations, and scope.',
  parameters: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'Relative path of the changed file in the repository.' },
      startLine: { type: 'integer', minimum: 1, description: '1-indexed start line number in head file to inspect.' },
      endLine: { type: 'integer', minimum: 1, description: '1-indexed end line number in head file to inspect.' },
      contextLines: { type: 'integer', minimum: 0, maximum: 10, default: 3, description: 'Number of surrounding context lines to include (0-10, default 3).' },
    },
    required: ['filePath'],
  },
} as const;

export function parseDiffHunks(patch: string): {
  hunkBoundaries: DiffHunkBoundary[];
  additions: number;
  deletions: number;
} {
  if (!patch || !patch.trim()) {
    return { hunkBoundaries: [], additions: 0, deletions: 0 };
  }
  const lines = patch.split('\n');
  const hunkBoundaries: DiffHunkBoundary[] = [];
  let additions = 0;
  let deletions = 0;
  let currentBoundary: DiffHunkBoundary | null = null;
  let currentNewLine = 0;

  for (const line of lines) {
    const hunkHeader = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
    if (hunkHeader) {
      const oldStart = parseInt(hunkHeader[1], 10);
      const oldCount = hunkHeader[2] !== undefined ? parseInt(hunkHeader[2], 10) : 1;
      const newStart = parseInt(hunkHeader[3], 10);
      const newCount = hunkHeader[4] !== undefined ? parseInt(hunkHeader[4], 10) : 1;
      const section = hunkHeader[5]?.trim();
      currentNewLine = newStart;
      currentBoundary = {
        oldStart,
        oldCount,
        newStart,
        newCount,
        modifiedLineNumbers: [],
        section: section || undefined,
      };
      hunkBoundaries.push(currentBoundary);
      continue;
    }

    if (!currentBoundary) continue;

    if (line.startsWith('+') && !line.startsWith('+++')) {
      additions++;
      currentBoundary.modifiedLineNumbers.push(currentNewLine);
      currentNewLine++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      deletions++;
    } else if (!line.startsWith('\\')) {
      currentNewLine++;
    }
  }

  return { hunkBoundaries, additions, deletions };
}

export function executeGetHunk(
  args: GetHunkArgs,
  admittedPatches: any,
): GetHunkResult {
  const rawPath = String(args?.filePath || (args as any)?.path || '');
  const normPath = rawPath.replace(/\\/g, '/').trim();
  if (!normPath || normPath.includes('..') || normPath.startsWith('/')) {
    return {
      status: 'rejected',
      error: 'invalid_arguments',
      message: 'Path traversal or absolute path not allowed',
      filePath: normPath,
    };
  }

  // Find patch in admittedPatches
  let rawPatch: string | null = null;
  let fileFound = false;

  if (Array.isArray(admittedPatches)) {
    const found = admittedPatches.find((f: any) => {
      const p = String(f?.path || f?.filePath || '').replace(/\\/g, '/').trim();
      return p === normPath || p.endsWith('/' + normPath);
    });
    if (found) {
      fileFound = true;
      rawPatch = typeof found.patch === 'string' ? found.patch : '';
    }
  } else if (admittedPatches instanceof Map) {
    if (admittedPatches.has(normPath)) {
      fileFound = true;
      rawPatch = admittedPatches.get(normPath) ?? '';
    }
  } else if (admittedPatches && typeof admittedPatches === 'object') {
    if (normPath in admittedPatches) {
      fileFound = true;
      const val = admittedPatches[normPath];
      rawPatch = typeof val === 'string' ? val : (val?.patch ?? '');
    } else {
      for (const [k, v] of Object.entries(admittedPatches)) {
        const p = k.replace(/\\/g, '/').trim();
        if (p === normPath || p.endsWith('/' + normPath)) {
          fileFound = true;
          rawPatch = typeof v === 'string' ? v : ((v as any)?.patch ?? '');
          break;
        }
      }
    }
  }

  if (!fileFound) {
    return {
      status: 'rejected',
      error: 'path_not_changed',
      message: 'File is not in admitted changed files',
      filePath: normPath,
    };
  }

  if (!rawPatch || !rawPatch.trim()) {
    return {
      status: 'rejected',
      error: 'no_diff_in_range',
      message: 'No diff modifications in requested line range',
      filePath: normPath,
    };
  }

  // Validate line numbers if provided
  if (args.startLine !== undefined) {
    if (typeof args.startLine !== 'number' || !Number.isSafeInteger(args.startLine) || args.startLine <= 0) {
      return {
        status: 'rejected',
        error: 'invalid_arguments',
        message: 'startLine must be <= endLine and >= 1',
        filePath: normPath,
      };
    }
  }

  if (args.endLine !== undefined) {
    if (typeof args.endLine !== 'number' || !Number.isSafeInteger(args.endLine) || args.endLine <= 0) {
      return {
        status: 'rejected',
        error: 'invalid_arguments',
        message: 'startLine must be <= endLine and >= 1',
        filePath: normPath,
      };
    }
  }

  if (args.startLine !== undefined && args.endLine !== undefined && args.startLine > args.endLine) {
    return {
      status: 'rejected',
      error: 'invalid_arguments',
      message: 'startLine must be <= endLine and >= 1',
      filePath: normPath,
    };
  }

  const { hunkBoundaries } = parseDiffHunks(rawPatch);
  const contextLines = Math.min(Math.max(args.contextLines ?? 3, 0), 10);

  const effectiveStart = args.startLine ?? 1;
  const effectiveEnd = args.endLine ?? Number.MAX_SAFE_INTEGER;

  const overlappingHunks = hunkBoundaries.filter((h) => {
    if (h.modifiedLineNumbers.some((ml) => ml >= effectiveStart - contextLines && ml <= effectiveEnd + contextLines)) {
      return true;
    }
    if (h.newCount === 0 && h.newStart >= effectiveStart - contextLines && h.newStart <= effectiveEnd + contextLines) {
      return true;
    }
    const hunkStart = h.newStart;
    const hunkEnd = h.newStart + Math.max(0, h.newCount - 1);
    return hunkStart <= effectiveEnd + contextLines && hunkEnd >= effectiveStart - contextLines;
  });

  if (overlappingHunks.length === 0) {
    return {
      status: 'rejected',
      error: 'no_diff_in_range',
      message: 'No diff modifications in requested line range',
      filePath: normPath,
    };
  }

  const modifiedLines: ModifiedLineItem[] = [];
  const lines = rawPatch.split('\n');
  let inHunk = false;
  let curLine = 0;
  const patchLines: string[] = [];

  for (const l of lines) {
    if (l.startsWith('@@')) {
      const match = l.match(/\+(\d+)/);
      if (match) curLine = parseInt(match[1], 10);
      inHunk = true;
      patchLines.push(l);
      continue;
    }
    if (!inHunk) continue;

    if (l.startsWith('+') && !l.startsWith('+++')) {
      if (curLine >= effectiveStart - contextLines && curLine <= effectiveEnd + contextLines) {
        modifiedLines.push({ line: curLine, type: 'add', content: l.slice(1) });
        patchLines.push(l);
      }
      curLine++;
    } else if (l.startsWith('-') && !l.startsWith('---')) {
      if (curLine >= effectiveStart - contextLines && curLine <= effectiveEnd + contextLines) {
        modifiedLines.push({ line: curLine, type: 'delete', content: l.slice(1) });
        patchLines.push(l);
      }
    } else if (!l.startsWith('\\')) {
      if (curLine >= effectiveStart - contextLines && curLine <= effectiveEnd + contextLines) {
        modifiedLines.push({ line: curLine, type: 'context', content: l.slice(1) });
        patchLines.push(l);
      }
      curLine++;
    }
  }

  return {
    status: 'success',
    filePath: normPath,
    startLine: effectiveStart,
    endLine: args.endLine ?? (modifiedLines.length > 0 ? Math.max(...modifiedLines.map((m) => m.line)) : effectiveStart),
    patch: patchLines.join('\n'),
    modifiedLines,
    scope: 'assigned-hunk',
    isExhaustive: true,
  };
}

export function get_hunk(
  filePathOrArgs: string | GetHunkArgs,
  startLineOrPatches?: number | Record<string, string> | any[],
  endLine?: number,
  contextLines?: number,
  admittedPatches?: Record<string, string> | any[],
): GetHunkResult {
  if (typeof filePathOrArgs === 'object' && filePathOrArgs !== null) {
    return executeGetHunk(filePathOrArgs, startLineOrPatches);
  }
  return executeGetHunk(
    {
      filePath: filePathOrArgs,
      startLine: typeof startLineOrPatches === 'number' ? startLineOrPatches : undefined,
      endLine,
      contextLines,
    },
    admittedPatches,
  );
}

function boundedUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  for (let end = maxBytes; end >= Math.max(0, maxBytes - 3); end--) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end)); }
    catch { /* A cut may intersect the final Unicode code point. */ }
  }
  return '';
}

async function readFiles(args: any, context: ToolRuntimeContext): Promise<ToolRuntimeResult> {
  const files = args?.files;
  const validRange = (value: unknown) => value === undefined
    || (typeof value === 'number' && Number.isSafeInteger(value) && value > 0);
  if (!args || typeof args !== 'object' || Array.isArray(args)
    || Object.keys(args).some((key) => key !== 'files')
    || !Array.isArray(files) || files.length < 1 || files.length > READ_FILES_MAX_FILES
    || files.some((file) => !file || typeof file !== 'object' || Array.isArray(file)
      || Object.keys(file).some((key) => !['path', 'startLine', 'endLine'].includes(key))
      || typeof file.path !== 'string' || !file.path.trim() || file.path.length > 4096
      || !validRange(file.startLine) || !validRange(file.endLine)
      || (file.startLine !== undefined && file.endLine !== undefined && file.endLine < file.startLine))) {
    return { toolOutput: `Tool 'read_files' execution rejected: Supply 1-${READ_FILES_MAX_FILES} files with an exact path and optional positive integer startLine/endLine. No other arguments or tools are allowed.`,
      toolScope: 'changed-patches-only', isExhaustive: false };
  }

  let toolOutput = "Tool 'read_files' execution result:\n";
  let isExhaustive = true;
  const scopes = new Set<string>();
  // Leave room for an engine-owned disclosure even if a source payload fills the batch.
  const payloadLimit = READ_FILES_MAX_BYTES - 256;
  for (let index = 0; index < files.length; index++) {
    throwIfPanelAborted(context.signal);
    const remaining = payloadLimit - Buffer.byteLength(toolOutput, 'utf8');
    if (remaining <= 0) {
      toolOutput += `\n[BATCH TRUNCATED: ${files.length - index} requested file(s) were not read. Request smaller source ranges.]`;
      isExhaustive = false;
      break;
    }
    // Reuse precisely the same exact-head read, source-line slicing and fallback as read_file.
    // Reads stay serial and share the original abort signal; no new tool or provider concurrency.
    const result = await runReadOnlyTool('read_file', files[index], context);
    throwIfPanelAborted(context.signal);
    scopes.add(result.toolScope);
    isExhaustive = isExhaustive && result.isExhaustive;
    const section = `\n[FILE ${JSON.stringify(files[index].path)} | SCOPE: ${result.toolScope} | EXHAUSTIVE: ${result.isExhaustive}]\n${result.toolOutput}\n`;
    if (Buffer.byteLength(section, 'utf8') > remaining) {
      const incompleteSection = `\n[FILE ${JSON.stringify(files[index].path)} | SCOPE: ${result.toolScope} | EXHAUSTIVE: false | OUTPUT: INCOMPLETE]\n${result.toolOutput}\n`;
      toolOutput += boundedUtf8(incompleteSection, remaining);
      toolOutput += `\n[BATCH TRUNCATED: current file output is incomplete; ${files.length - index - 1} remaining file(s) were not read. Request smaller source ranges.]`;
      isExhaustive = false;
      break;
    }
    toolOutput += section;
  }
  return { toolOutput, toolScope: scopes.size === 1 ? [...scopes][0] : 'mixed-read-only', isExhaustive };
}

/**
 * Execute one read-only tool call and return its output plus scope envelope.
 *
 * Moved as-is from `panelEngine.ts`'s `invoke()`; `toolCall` and `options`/`changedFiles` are
 * reconstructed locally from the parameters so the body below is unmodified from its original
 * form.
 */
export async function runReadOnlyTool(
  toolName: string,
  args: any,
  context: ToolRuntimeContext,
): Promise<ToolRuntimeResult> {
  if (toolName === 'deletion_manifest' || toolName === 'deletion_evidence') {
    const scope = 'pinned-deletion-evidence';
    const response = (value: unknown) => ({ toolOutput: JSON.stringify(value), toolScope: scope, isExhaustive: false });
    if (!args || typeof args !== 'object' || Array.isArray(args)) return response({ status: 'invalid' });
    throwIfPanelAborted(context.signal);
    if (toolName === 'deletion_manifest') {
      if (Object.keys(args).some((key) => !['offset', 'limit', 'digest'].includes(key))
        || (args.digest !== undefined && (typeof args.digest !== 'string' || !/^[0-9a-f]{64}$/u.test(args.digest)))
        || (args.offset > 0 && args.digest === undefined)
        || (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || args.offset < 0))
        || (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 24))) return response({ status: 'invalid' });
      return response(context.repoFileProvider?.deletionManifest?.(args.offset ?? 0, args.limit ?? 24, args.digest) ?? { status: 'unavailable' });
    }
    if (Object.keys(args).some((key) => key !== 'path') || typeof args.path !== 'string'
      || !args.path.trim() || args.path.length > 4096 || args.path.includes('\0') || args.path.split(/[\\/]/u).includes('..')) return response({ status: 'invalid' });
    if (!context.repoFileProvider?.deletionEvidence) return response({ status: 'unavailable' });
    const packet = await raceWithPanelAbort(context.repoFileProvider.deletionEvidence(normalizeRepoPath(args.path)), context.signal);
    throwIfPanelAborted(context.signal);
    return response(packet);
  }
  if (toolName === 'read_file_page' || toolName === 'get_diff_page') return readEvidencePage(toolName, args, context);
  if (toolName === 'read_files') return readFiles(args, context);
  const toolCall = { tool: toolName, args };
  const options = context;
  const changedFiles = context.changedFiles;

  const tName = toolCall.tool;
  // A leading './' or '/' would make the contents API return 404 for a file that exists (REL-1102).
  const targetPath = normalizeRepoPath(String(toolCall.args?.path || toolCall.args?.filePath || ''));
  const searchQ = toolCall.args?.query || toolCall.args?.pattern || '';

  // Whitelist check: Code Reading, Context Searching, Dashboard MCPs, Zoekt, Fleet MCPs
  const isCodeReading = ['view_file', 'read_file', 'get_diff', 'get_hunk'].includes(tName);
  const isSearching = ['grep_search', 'find_files', 'symbol_search', 'search_code', 'code_search_zoekt', 'zoekt_search'].includes(tName);
  const readOnlyMcpNames = new Set([
    // External documentation & tracking
    'fetch_docs',
    'context7_search',
    'mcp_context7_query',
    'linear_get_issue',
    // ct-impact (cross-repository AST mesh & blast radius)
    'ct_impact',
    'ct_mesh_query',
    'ct_mesh_stats',
    // ct-knowledge (governed ADRs & runbooks - strictly read-only)
    'knowledge_search',
    'knowledge_get',
    // blocker-quorum (advisories & readiness)
    'advise_blocker',
    'health',
    'blocker_quorum_health',
  ]);
  const isMcp = readOnlyMcpNames.has(tName);

  const isAllowed = isCodeReading || isSearching || isMcp;

  let toolOutput = '';
  let toolScope = 'changed-patches-only';
  let isExhaustive = false;

  if (['ct_impact', 'ct_mesh_query', 'ct_mesh_stats'].includes(tName)) {
    toolScope = 'cross-repository-ast-mesh';
    // A mesh hit can guide investigation; its revision, languages and filters
    // do not establish complete cross-repository consumer coverage.
    isExhaustive = false;
  } else if (['knowledge_search', 'knowledge_get'].includes(tName)) {
    toolScope = 'governed-knowledge-adr';
    isExhaustive = true;
  } else if (['advise_blocker', 'health', 'blocker_quorum_health'].includes(tName)) {
    toolScope = 'policy-blocker-quorum';
    isExhaustive = true;
  }

  if (!isAllowed) {
    toolScope = 'changed-patches-only';
    isExhaustive = false;
    toolOutput = `Tool '${tName}' execution rejected: Permission denied. Reviewer personas are restricted strictly to read-only code, search, and MCP tools.`;
  } else {
    // Validate required arguments for fleet MCP tools
    if (tName === 'ct_impact') {
      const target = toolCall.args?.target ?? toolCall.args?.target_file ?? toolCall.args?.query;
      if (typeof target !== 'string' || !target.trim()) {
        return {
          toolOutput: `Tool '${tName}' execution rejected: Missing required argument 'target'.`,
          toolScope,
          isExhaustive: false,
        };
      }
    } else if (tName === 'ct_mesh_query') {
      if (typeof toolCall.args?.query !== 'string' || !toolCall.args.query.trim()) {
        return {
          toolOutput: `Tool '${tName}' execution rejected: Missing required argument 'query'.`,
          toolScope,
          isExhaustive: false,
        };
      }
    } else if (tName === 'knowledge_search') {
      if (typeof toolCall.args?.query !== 'string' || !toolCall.args.query.trim()) {
        return {
          toolOutput: `Tool '${tName}' execution rejected: Missing required argument 'query'.`,
          toolScope,
          isExhaustive: false,
        };
      }
    } else if (tName === 'knowledge_get') {
      if (typeof toolCall.args?.id !== 'string' || !toolCall.args.id.trim()) {
        return {
          toolOutput: `Tool '${tName}' execution rejected: Missing required argument 'id'.`,
          toolScope,
          isExhaustive: false,
        };
      }
    } else if (tName === 'advise_blocker') {
      if (!toolCall.args?.blocker_packet || typeof toolCall.args.blocker_packet !== 'object') {
        return {
          toolOutput: `Tool '${tName}' execution rejected: Missing required argument 'blocker_packet'.`,
          toolScope,
          isExhaustive: false,
        };
      }
    }

    toolOutput = `Tool '${tName}' execution result:\n`;
    if (isCodeReading) {
      if (tName === 'get_hunk') {
        const rawPath = String(toolCall.args?.filePath || toolCall.args?.path || '');
        const normArgs: GetHunkArgs = {
          filePath: rawPath,
          startLine: toolCall.args?.startLine ?? toolCall.args?.start_line,
          endLine: toolCall.args?.endLine ?? toolCall.args?.end_line,
          contextLines: toolCall.args?.contextLines ?? toolCall.args?.context_lines,
        };
        const res = executeGetHunk(normArgs, changedFiles);
        if (res.status === 'success') {
          return {
            toolOutput: `Tool 'get_hunk' execution result:\n${JSON.stringify(res, null, 2)}`,
            toolScope: 'assigned-hunk',
            isExhaustive: true,
          };
        }
        return {
          toolOutput: `Tool 'get_hunk' execution rejected: [${res.error}] ${res.message}`,
          toolScope: 'assigned-hunk',
          isExhaustive: false,
        };
      }

      const rawStart = toolCall.args?.startLine ?? toolCall.args?.start_line;
      const rawEnd = toolCall.args?.endLine ?? toolCall.args?.end_line;
      const reqStart = typeof rawStart === 'number' && Number.isFinite(rawStart) && rawStart > 0 ? Math.floor(rawStart) : undefined;
      const reqEnd = typeof rawEnd === 'number' && Number.isFinite(rawEnd) && rawEnd > 0 ? Math.floor(rawEnd) : undefined;

      const sliceLines = (text: string): { content: string; start: number; end: number; total: number; sliced: boolean } => {
        const lines = text.split('\n');
        const total = lines.length;
        if (reqStart === undefined && reqEnd === undefined) {
          return { content: text, start: 1, end: total, total, sliced: false };
        }
        const start = Math.max(1, Math.min(total, reqStart ?? 1));
        const end = Math.max(start, Math.min(total, reqEnd ?? total));
        return { content: lines.slice(start - 1, end).join('\n'), start, end, total, sliced: true };
      };

      const matched = changedFiles.find((f: any) => f.path === targetPath || f.path.includes(targetPath));
      const appendChangedPatch = (leadIn = '') => {
        toolScope = 'changed-patches-only';
        isExhaustive = false;
        const maxChars = resolveMaxFileDiffChars();
        if (tName === 'get_diff' && typeof matched.patch !== 'string') {
          toolOutput += `${leadIn}No PR diff patch text is available for '${targetPath}'. get_diff does not return current source content.`;
        } else if (isOversizedFileDiff(matched, maxChars)) {
          toolOutput += `${leadIn}SKIPPED '${targetPath}': patch is ${filePatchChars(matched)} characters, over max-file-diff-chars ${maxChars}. Do not request this payload.`;
        } else {
          const raw = tName === 'get_diff'
            ? matched.patch
            : matched.patch || matched.content || 'File present in PR scope.';
          if (tName === 'read_file') {
            const truncated = raw.length > REPO_READ_FILE_MAX_CHARS;
            const shown = truncated ? raw.slice(0, REPO_READ_FILE_MAX_CHARS) : raw;
            const rangeNote = reqStart !== undefined || reqEnd !== undefined
              ? ' Requested source-line ranges cannot be applied to patch hunks without a full source read.'
              : '';
            const payloadLabel = typeof matched.patch === 'string'
              ? 'Only the PR patch is available'
              : 'Only a changed-file review payload is available';
            toolOutput += `${leadIn}Full current file content at the reviewed head is unavailable. ${payloadLabel} for '${targetPath}'; it is not verified complete source context.${rangeNote}\n`
              + (truncated
                ? `Patch for '${targetPath}' truncated to the first ${REPO_READ_FILE_MAX_CHARS} of ${raw.length} characters. Request a smaller diff or another file; do not ask for the whole PR.\n${shown}`
                : shown);
          } else {
            const sliced = sliceLines(raw);
            const truncated = sliced.content.length > REPO_READ_FILE_MAX_CHARS;
            const shown = truncated ? sliced.content.slice(0, REPO_READ_FILE_MAX_CHARS) : sliced.content;

            const prefixNote = sliced.sliced
              ? `${tName === 'get_diff' ? 'Patch lines' : 'Lines'} ${sliced.start}-${sliced.end} of ${sliced.total} for '${targetPath}':\n`
              : '';
            toolOutput += `${leadIn}${tName === 'get_diff' ? `PR diff patch for '${targetPath}':\n` : ''}`
              + (truncated
                ? `${prefixNote}Patch for '${targetPath}' truncated to the first ${REPO_READ_FILE_MAX_CHARS} of ${sliced.content.length} characters. Request a smaller range or another file; do not ask for the whole PR.\n${shown}`
                : `${prefixNote}${shown}`);
          }
        }
      };

      if (tName === 'get_diff' && !matched) {
        toolScope = 'changed-patches-only';
        isExhaustive = false;
        toolOutput += `No PR diff patch is available for '${targetPath}'. get_diff is limited to changed-file patch content; use read_file for current file content when the repository provider is available.`;
      } else if (options?.repoFileProvider && (tName === 'read_file' || !matched)) {
        try {
          const content = await raceWithPanelAbort(options.repoFileProvider.readFile(targetPath), options?.signal);
          if (content !== null) {
            toolScope = 'full-repository';
            isExhaustive = true;
            const sliced = sliceLines(content);
            const truncated = sliced.content.length > REPO_READ_FILE_MAX_CHARS;
            const shown = truncated ? sliced.content.slice(0, REPO_READ_FILE_MAX_CHARS) : sliced.content;
            if (truncated) isExhaustive = false;
            const prefixNote = sliced.sliced
              ? `Lines ${sliced.start}-${sliced.end} of ${sliced.total} for '${targetPath}':\n`
              : '';
            const sourceNote = matched
              ? `File '${targetPath}' is changed in this PR; reading the current file at the reviewed head, not the patch. `
              : `File '${targetPath}' is not part of this PR's diff, but it exists in the repository at the reviewed head. `;
            const contentLabel = sliced.sliced ? '' : 'Full current content:\n';
            toolOutput += sourceNote
              + (truncated
                ? `${prefixNote}Content truncated to the first ${REPO_READ_FILE_MAX_CHARS} of ${sliced.content.length} characters:\n${shown}\n[... content truncated: ${sliced.content.length - REPO_READ_FILE_MAX_CHARS} more characters not shown]`
                : `${prefixNote}${contentLabel}${shown}`);
          } else {
            toolScope = 'full-repository';
            toolOutput += await describeUnreadablePath(targetPath, options.repoFileProvider, options?.signal)
              .then((d) => { isExhaustive = d.exhaustive; return d.text; });
          }
        } catch (err: any) {
          if (matched) {
            const failure = `Full current source read of '${targetPath}' failed (${err?.message || String(err)}). This is a lookup failure, not confirmation the file is missing -- do not report it as absent or as verified on this basis. `;
            appendChangedPatch(failure);
          } else {
            toolScope = 'full-repository';
            isExhaustive = false;
            toolOutput += `Full-repository read of '${targetPath}' failed (${err?.message || String(err)}). This is a lookup failure, not confirmation the file is missing -- do not report it as absent or as verified on this basis.`;
          }
        }
      } else if (matched) {
        appendChangedPatch();
      } else {
        toolScope = 'changed-patches-only';
        isExhaustive = false;
        toolOutput += `File '${targetPath}' is not part of this PR's diff. This tool's search scope here is changed files only (no full-repository access is wired for this run); the file may still exist elsewhere in the repository. Do not report it as missing, unconfirmed, or unverifiable from this result alone.`;
      }
    } else if (tName === 'search_code' || tName === 'grep_search') {
      const hits = changedFiles.filter((f: any) => (f.patch || f.content || '').toLowerCase().includes(searchQ.toLowerCase()));
      toolScope = 'changed-patches-only';
      isExhaustive = false;
      toolOutput += hits.length > 0
        ? `Matches found in diff: ${hits.map((h: any) => h.path).join(', ')}`
        : `No matches for '${searchQ}' in the diff. This tool's text search scope is changed files only, not the full repository -- a match may still exist outside the diff. Use find_files/read_file to check a specific file directly.`;
    } else if (tName === 'find_files') {
      // REL-1102: glob-aware matching, and the full tree is searched even when the diff has hits.
      // Returning only the diff hits used to hide committed files outside the diff (for example
      // a JSON fixture) without saying so.
      const matches = createPathMatcher(searchQ);
      const how = matches.mode === 'glob' ? 'glob' : 'substring';
      const diffHits: string[] = changedFiles.map((f: any) => String(f.path)).filter((p: string) => matches(p));
      const listHits = (hits: string[]) => (hits.length > REPO_FIND_FILES_MAX_HITS
        ? `${hits.slice(0, REPO_FIND_FILES_MAX_HITS).join(', ')} (showing the first ${REPO_FIND_FILES_MAX_HITS} of ${hits.length}; narrow the query for the rest)`
        : hits.join(', '));
      if (options?.repoFileProvider) {
        try {
          const found = await raceWithPanelAbort(options.repoFileProvider.findFiles(searchQ), options?.signal);
          const repoHits: string[] = Array.isArray(found) ? [...new Set(found)] : [];
          const truncated = await raceWithPanelAbort(options.repoFileProvider.treeTruncated?.() ?? Promise.resolve(false), options?.signal);
          // Deleted PR paths remain useful diff evidence, but are not files at
          // head. Keep them separate from the pinned tree's existence claims.
          const headPaths = new Set(repoHits);
          const diffOnly = [...new Set(diffHits)].filter((path) => !headPaths.has(path));
          toolScope = 'full-repository';
          isExhaustive = !truncated;
          const truncNote = ' The repository tree was TRUNCATED by GitHub (very large repository), so this list may be incomplete.';
          if (repoHits.length > 0) {
            toolOutput += `Found ${repoHits.length} path(s) matching '${searchQ}' (${how} match, full-repository tree at the reviewed head, not just the diff): ${listHits(repoHits)}`
              + (truncated ? truncNote : '');
          } else if (truncated) {
            toolOutput += `No files matching '${searchQ}' (${how} match) in the PORTION of the repository tree the API returned -- the tree was truncated by GitHub, so the file may still exist. Do not report it as missing on this basis; read_file on the exact path is conclusive.`;
          } else {
            toolOutput += `No files matching '${searchQ}' (${how} match) found anywhere in the repository at the reviewed head (full-repository search, not just the diff).`;
          }
          if (diffOnly.length > 0) {
            toolOutput += `\nMatching paths in the PR diff, ${truncated ? 'presence at the reviewed head unconfirmed' : 'absent from the reviewed head tree'}: ${listHits(diffOnly)}. These are diff paths, not verified existing head files; use get_diff or read_file_page with side=merge-base to inspect removed source.`;
          }
        } catch (err: any) {
          toolScope = 'changed-patches-only';
          isExhaustive = false;
          toolOutput += `Full-repository file search for '${searchQ}' failed (${err?.message || String(err)}). This is a lookup failure, not confirmation the file is missing -- do not report it as absent or as verified on this basis.`
            + (diffHits.length > 0 ? ` Matching files in the diff: ${listHits(diffHits)}. Current-head presence of these diff paths is unconfirmed.` : '');
        }
      } else if (diffHits.length > 0) {
        toolScope = 'changed-patches-only';
        isExhaustive = false;
        toolOutput += `Files found in diff: ${listHits(diffHits)} (${how} match; changed files only, so other matching files may still exist elsewhere in the repository). Current-head presence of these diff paths is unconfirmed.`;
      } else {
        toolScope = 'changed-patches-only';
        isExhaustive = false;
        toolOutput += `No files matching '${searchQ}' found in the diff. This tool's search scope here is changed files only (no full-repository access is wired for this run); the file may still exist elsewhere in the repository. Do not report it as missing, unconfirmed, or unverifiable from this result alone.`;
      }
    } else if (tName === 'symbol_search') {
      const parser = new ASTParser();
      const hits: string[] = [];
      for (const f of changedFiles) {
        if (f.patch || f.content) {
          const res = parser.parseSource(f.path, f.content || f.patch || '');
          const matchedSyms = res.symbols.filter((s) => s.name.toLowerCase().includes(searchQ.toLowerCase()));
          if (matchedSyms.length > 0) {
            hits.push(`${f.path}: ${matchedSyms.map((s) => `${s.kind} ${s.name}`).join(', ')}`);
          }
        }
      }
      toolScope = 'changed-patches-only';
      isExhaustive = false;
      toolOutput += hits.length > 0
        ? hits.join('\n')
        : `No symbols found matching '${searchQ}' in the diff. This tool's search scope is changed files only, not the full repository -- the symbol may be defined elsewhere.`;
    } else if (tName === 'code_search_zoekt' || tName === 'zoekt_search') {
      toolScope = 'full-repository-zoekt';
      try {
        const zoektTool = require('../mcp/zoektSearchTool');
        const zoektRes: any = await raceWithPanelAbort(
          zoektTool.executeZoektSearch({ query: searchQ }, (options as any)?.zoektConfig, { signal: options?.signal, session: options?.zoektConfig?.searchSession }),
          options?.signal,
        );
        // This is a wire-envelope guard, not the index completeness policy:
        // reject a contradictory receipt even if its producer says exhaustive.
        // Index exclusions and revision checks remain owned by the search tool.
        isExhaustive = zoektRes.status === 'ok' && zoektRes.exhaustive === true && zoektRes.truncated !== true;
        toolOutput += `[SCOPE: full-repository-zoekt | EXHAUSTIVE: ${isExhaustive}]\n${JSON.stringify(zoektRes, null, 2)}`;
      } catch (err: any) {
        toolOutput += `[SCOPE: full-repository-zoekt | EXHAUSTIVE: false | STATUS: unavailable]\nZoekt search unavailable: ${err?.message || String(err)}`;
      }
    } else {
      // Only documentation/search/fleet MCPs are permitted. Review execution must never mutate
      // candidate memory, Linear, Productlane, GitHub, or an arbitrary custom MCP server.
      const MCP_TOOL_TIMEOUT_MS = 15_000;
      try {
        let timer: NodeJS.Timeout | undefined;
        const timeoutPromise = new Promise<{ success: false; output: null; error: string }>((resolve) => {
          timer = setTimeout(() => {
            resolve({
              success: false,
              output: null,
              error: `Tool execution timed out after ${MCP_TOOL_TIMEOUT_MS}ms.`,
            });
          }, MCP_TOOL_TIMEOUT_MS);
        });

        const execPromise = mcpFleetManager.executeTool(tName, toolCall.args || {})
          .finally(() => {
            if (timer) clearTimeout(timer);
          });

        const mcpResult = await raceWithPanelAbort(
          Promise.race([execPromise, timeoutPromise]),
          options?.signal,
        );

        if (mcpResult.success) {
          toolOutput += typeof mcpResult.output === 'string'
            ? mcpResult.output
            : JSON.stringify(mcpResult.output, null, 2);
        } else {
          toolOutput += `MCP Error: ${mcpResult.error || 'Execution failed'}`;
          isExhaustive = false;
        }
      } catch (err: any) {
        throwIfPanelAborted(options?.signal);
        toolOutput += `MCP Error: ${err?.message || String(err)}`;
        isExhaustive = false;
      }
    }
  }

  throwIfPanelAborted(options?.signal);

  return { toolOutput, toolScope, isExhaustive };
}

/**
 * REL-1102: the contents API returned no file for `path`. That alone does not prove the file is
 * absent. The API also returns no inline content for a glob, a directory, or a file too large to
 * inline. Check the repository tree before telling the model the file does not exist.
 */
async function describeUnreadablePath(
  path: string,
  provider: RepoFileProvider,
  signal?: AbortSignal,
): Promise<{ text: string; exhaustive: boolean }> {
  let treeHits: string[];
  let truncated = false;
  try {
    const found = await raceWithPanelAbort(provider.findFiles(path), signal);
    treeHits = Array.isArray(found) ? found : [];
    truncated = await raceWithPanelAbort(provider.treeTruncated?.() ?? Promise.resolve(false), signal);
  } catch (err: any) {
    throwIfPanelAborted(signal);
    return {
      text: `The contents API returned no file at '${path}', and the repository-tree cross-check failed (${err?.message || String(err)}). This is not confirmation the file is missing -- do not report it as absent on this basis.`,
      exhaustive: false,
    };
  }
  const shown = (hits: string[]) => hits.slice(0, REPO_FIND_FILES_MAX_HITS).join(', ')
    + (hits.length > REPO_FIND_FILES_MAX_HITS ? ` (first ${REPO_FIND_FILES_MAX_HITS} of ${hits.length})` : '');
  if (treeHits.includes(path)) {
    return {
      text: `File '${path}' EXISTS in the repository tree at the reviewed head, but its content could not be fetched through the contents API (typically a large or binary file). Do not report it as missing.`,
      exhaustive: false,
    };
  }
  const dirPrefix = `${path.replace(/\/+$/u, '')}/`;
  const children = treeHits.filter((p) => p.startsWith(dirPrefix));
  if (children.length > 0) {
    return {
      text: `'${path}' is a directory in the repository at the reviewed head, not a file. It contains: ${shown(children)}. Call read_file on one of these exact paths.`,
      exhaustive: true,
    };
  }
  if (isGlobQuery(path)) {
    return treeHits.length > 0
      ? {
        text: `'${path}' is a pattern, not a single file path; read_file needs one exact path. Matching files at the reviewed head: ${shown(treeHits)}.`,
        exhaustive: !truncated,
      }
      : {
        text: `'${path}' is a pattern, not a single file path; read_file needs one exact path. Use find_files to list matching files${truncated ? ' (note: the repository tree was truncated by GitHub, so a zero-hit search is not proof of absence)' : ''}.`,
        exhaustive: false,
      };
  }
  if (truncated) {
    return {
      text: `The contents API returned no file at '${path}', and it is not in the PORTION of the repository tree GitHub returned (the tree was truncated). Treat this as probably absent but not proven; do not raise a blocking finding on this basis alone.`,
      exhaustive: false,
    };
  }
  return {
    text: `File '${path}' does not exist in the repository at the reviewed head (checked the full repository tree, not just the diff).`,
    exhaustive: true,
  };
}
