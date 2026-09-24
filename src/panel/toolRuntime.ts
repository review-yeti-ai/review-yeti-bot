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
import { mcpFleetManager } from '../mcp/mcpFleetManager';
import { ASTParser } from '../indexer/astParser';
import {
  REPO_FIND_FILES_MAX_HITS,
  REPO_READ_FILE_MAX_CHARS,
  filePatchChars,
  isOversizedFileDiff,
  raceWithPanelAbort,
  resolveMaxFileDiffChars,
  throwIfPanelAborted,
  type RepoFileProvider,
} from './panelEngine';
import { createPathMatcher, isGlobQuery, normalizeRepoPath } from './pathMatch';

/** Read-only inputs a tool call may need. Mirrors the subset of `invoke()`'s options the original block closed over. */
export interface ToolRuntimeContext {
  changedFiles: any[];
  repoFileProvider?: RepoFileProvider;
  zoektConfig?: any;
  signal?: AbortSignal;
}

export interface ToolRuntimeResult {
  toolOutput: string;
  toolScope: string;
  isExhaustive: boolean;
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
  const toolCall = { tool: toolName, args };
  const options = context;
  const changedFiles = context.changedFiles;

  const tName = toolCall.tool;
  // A leading './' or '/' would make the contents API return 404 for a file that exists (REL-1102).
  const targetPath = normalizeRepoPath(String(toolCall.args?.path || toolCall.args?.filePath || ''));
  const searchQ = toolCall.args?.query || toolCall.args?.pattern || '';

  // Whitelist check: Code Reading, Context Searching, Dashboard MCPs, Zoekt, Fleet MCPs
  const isCodeReading = ['view_file', 'read_file', 'get_diff'].includes(tName);
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
    isExhaustive = true;
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
      if (matched) {
        toolScope = 'changed-patches-only';
        isExhaustive = false;
        const maxChars = resolveMaxFileDiffChars();
        if (isOversizedFileDiff(matched, maxChars)) {
          toolOutput += `SKIPPED '${targetPath}': patch is ${filePatchChars(matched)} characters, over max-file-diff-chars ${maxChars}. Do not request this payload.`;
        } else {
          const raw = matched.patch || matched.content || 'File present in PR scope.';
          const sliced = sliceLines(raw);
          const truncated = sliced.content.length > REPO_READ_FILE_MAX_CHARS;
          const shown = truncated ? sliced.content.slice(0, REPO_READ_FILE_MAX_CHARS) : sliced.content;
          const prefixNote = sliced.sliced
            ? `Lines ${sliced.start}-${sliced.end} of ${sliced.total} for '${targetPath}':\n`
            : '';
          toolOutput += truncated
            ? `${prefixNote}Patch for '${targetPath}' truncated to the first ${REPO_READ_FILE_MAX_CHARS} of ${sliced.content.length} characters. Request a smaller range or another file; do not ask for the whole PR.\n${shown}`
            : `${prefixNote}${shown}`;
        }
      } else if (options?.repoFileProvider) {
        try {
          const content = await raceWithPanelAbort(options.repoFileProvider.readFile(targetPath), options?.signal);
          if (content !== null) {
            toolScope = 'full-repository';
            isExhaustive = true;
            const sliced = sliceLines(content);
            const truncated = sliced.content.length > REPO_READ_FILE_MAX_CHARS;
            const shown = truncated ? sliced.content.slice(0, REPO_READ_FILE_MAX_CHARS) : sliced.content;
            const prefixNote = sliced.sliced
              ? `Lines ${sliced.start}-${sliced.end} of ${sliced.total} for '${targetPath}':\n`
              : '';
            toolOutput += `File '${targetPath}' is not part of this PR's diff, but it exists in the repository at the reviewed head. `
              + (truncated
                ? `${prefixNote}Content truncated to the first ${REPO_READ_FILE_MAX_CHARS} of ${sliced.content.length} characters:\n${shown}\n[... content truncated: ${sliced.content.length - REPO_READ_FILE_MAX_CHARS} more characters not shown]`
                : `${prefixNote}Full current content:\n${shown}`);
          } else {
            toolScope = 'full-repository';
            toolOutput += await describeUnreadablePath(targetPath, options.repoFileProvider, options?.signal)
              .then((d) => { isExhaustive = d.exhaustive; return d.text; });
          }
        } catch (err: any) {
          toolScope = 'full-repository';
          isExhaustive = false;
          toolOutput += `Full-repository read of '${targetPath}' failed (${err?.message || String(err)}). This is a lookup failure, not confirmation the file is missing -- do not report it as absent or as verified on this basis.`;
        }
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
          const repoHits: string[] = Array.isArray(found) ? found : [];
          const truncated = await raceWithPanelAbort(options.repoFileProvider.treeTruncated?.() ?? Promise.resolve(false), options?.signal);
          // Diff paths first (the PR's own files), then the rest of the tree. A path deleted by
          // the PR is in the diff but not in the tree at head, so it stays in the list.
          const all = [...new Set([...diffHits, ...repoHits])];
          toolScope = 'full-repository';
          isExhaustive = !truncated;
          const truncNote = ' The repository tree was TRUNCATED by GitHub (very large repository), so this list may be incomplete.';
          if (all.length > 0) {
            toolOutput += `Found ${all.length} path(s) matching '${searchQ}' (${how} match, full-repository tree at the reviewed head, not just the diff): ${listHits(all)}`
              + (truncated ? truncNote : '');
          } else if (truncated) {
            toolOutput += `No files matching '${searchQ}' (${how} match) in the diff, and none in the PORTION of the repository tree the API returned -- the tree was truncated by GitHub, so the file may still exist. Do not report it as missing on this basis; read_file on the exact path is conclusive.`;
          } else {
            toolOutput += `No files matching '${searchQ}' (${how} match) found anywhere in the repository at the reviewed head (full-repository search, not just the diff).`;
          }
        } catch (err: any) {
          toolScope = 'full-repository';
          isExhaustive = false;
          toolOutput += `Full-repository file search for '${searchQ}' failed (${err?.message || String(err)}). This is a lookup failure, not confirmation the file is missing -- do not report it as absent or as verified on this basis.`
            + (diffHits.length > 0 ? ` Matching files in the diff: ${listHits(diffHits)}` : '');
        }
      } else if (diffHits.length > 0) {
        toolScope = 'changed-patches-only';
        isExhaustive = false;
        toolOutput += `Files found in diff: ${listHits(diffHits)} (${how} match; changed files only, so other matching files may still exist elsewhere in the repository)`;
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
          zoektTool.executeZoektSearch({ query: searchQ }, (options as any)?.zoektConfig),
          options?.signal,
        );
        isExhaustive = zoektRes.status === 'ok';
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
