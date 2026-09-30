import { describe, it, expect, vi, afterEach } from 'vitest';
import { runReadOnlyTool, type ToolRuntimeContext } from '../toolRuntime';
import { REPO_READ_FILE_MAX_CHARS, type RepoFileProvider } from '../panelEngine';

vi.mock('../../mcp/mcpFleetManager', () => ({
  mcpFleetManager: {
    executeTool: vi.fn(),
  },
}));

import { mcpFleetManager } from '../../mcp/mcpFleetManager';

/**
 * Contract tests for the extracted, pure read-only tool runtime (`toolRuntime.ts`). These pin the
 * exact `toolOutput` / `toolScope` / `isExhaustive` envelope for every tool branch so a future
 * caller (e.g. a composed single-context review engine) can reuse `runReadOnlyTool` and trust it
 * behaves identically to the persona fan-out's tool-handling block it was extracted from.
 */
describe('runReadOnlyTool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const baseContext = (overrides: Partial<ToolRuntimeContext> = {}): ToolRuntimeContext => ({
    changedFiles: [{ path: 'src/auth/multi.ts', patch: 'export function login() {}\n' }],
    ...overrides,
  });

  describe('disallowed tool', () => {
    it('rejects with the exact permission-denied message and the default scope envelope', async () => {
      const result = await runReadOnlyTool('write_file', { path: 'x' }, baseContext());
      expect(result).toEqual({
        toolOutput: "Tool 'write_file' execution rejected: Permission denied. Reviewer personas are restricted strictly to read-only code, search, and MCP tools.",
        toolScope: 'changed-patches-only',
        isExhaustive: false,
      });
    });
  });

  describe('view_file / read_file / get_diff', () => {
    it('returns changed-patches-only scope for a file present in the diff', async () => {
      const result = await runReadOnlyTool('read_file', { path: 'src/auth/multi.ts' }, baseContext());
      expect(result).toEqual({
        toolOutput: "Tool 'read_file' execution result:\nChanged patch only (no full-repository access is wired for this run); this is not full current source.\nexport function login() {}\n",
        toolScope: 'changed-patches-only',
        isExhaustive: false,
      });
    });

    it('slices the requested line range for a diff-scoped file', async () => {
      const multilineContent = ['line 1: header', 'line 2: important logic', 'line 3: edge case', 'line 4: footer'].join('\n');
      const result = await runReadOnlyTool(
        'read_file',
        { path: 'src/auth/multi.ts', startLine: 2, endLine: 3 },
        baseContext({ changedFiles: [{ path: 'src/auth/multi.ts', patch: multilineContent }] }),
      );
      expect(result.toolScope).toBe('changed-patches-only');
      expect(result.isExhaustive).toBe(false);
      expect(result.toolOutput).toBe(
        "Tool 'read_file' execution result:\nChanged patch only (no full-repository access is wired for this run); this is not full current source.\nLines 2-3 of 4 for 'src/auth/multi.ts':\nline 2: important logic\nline 3: edge case",
      );
    });

    it('falls back to full-repository scope, exhaustive, when repoFileProvider has the file', async () => {
      const repoFileProvider: RepoFileProvider = {
        findFiles: vi.fn(),
        readFile: vi.fn().mockResolvedValue('full file content'),
      };
      const result = await runReadOnlyTool('view_file', { path: 'src/other.ts' }, baseContext({ repoFileProvider }));
      expect(result.toolScope).toBe('full-repository');
      expect(result.isExhaustive).toBe(true);
      expect(result.toolOutput).toBe(
        "Tool 'view_file' execution result:\nFile 'src/other.ts' is not part of this PR's diff, but it exists in the repository at the reviewed head. Full current content:\nfull file content",
      );
    });

    it('reports full-repository exhaustive absence when repoFileProvider confirms the file does not exist', async () => {
      const repoFileProvider: RepoFileProvider = {
        findFiles: vi.fn(),
        readFile: vi.fn().mockResolvedValue(null),
      };
      const result = await runReadOnlyTool('read_file', { path: 'src/missing.ts' }, baseContext({ repoFileProvider }));
      expect(result).toEqual({
        toolOutput: "Tool 'read_file' execution result:\nFile 'src/missing.ts' does not exist in the repository at the reviewed head (checked the full repository tree, not just the diff).",
        toolScope: 'full-repository',
        isExhaustive: true,
      });
    });

    it('reports a lookup failure (not confirmed-missing) when repoFileProvider.readFile throws', async () => {
      const repoFileProvider: RepoFileProvider = {
        findFiles: vi.fn(),
        readFile: vi.fn().mockRejectedValue(new Error('network blip')),
      };
      const result = await runReadOnlyTool('read_file', { path: 'src/flaky.ts' }, baseContext({ repoFileProvider }));
      expect(result.toolScope).toBe('full-repository');
      expect(result.isExhaustive).toBe(false);
      expect(result.toolOutput).toBe(
        "Tool 'read_file' execution result:\nFull-repository read of 'src/flaky.ts' failed (network blip). This is a lookup failure, not confirmation the file is missing -- do not report it as absent or as verified on this basis.",
      );
    });

    it('does not claim absence, missing, or unverifiable when no repoFileProvider is wired', async () => {
      const result = await runReadOnlyTool('read_file', { path: 'src/other.ts' }, baseContext());
      expect(result).toEqual({
        toolOutput: "Tool 'read_file' execution result:\nFile 'src/other.ts' is not part of this PR's diff. This tool's search scope here is changed files only (no full-repository access is wired for this run); the file may still exist elsewhere in the repository. Do not report it as missing, unconfirmed, or unverifiable from this result alone.",
        toolScope: 'changed-patches-only',
        isExhaustive: false,
      });
    });
  });


  describe('REL-1204 exact-source code reads', () => {
    const source = ['CURRENT_SOURCE_HEADER', 'export const current = true;', 'CURRENT_SOURCE_TAIL'].join('\n');
    const provider = (overrides: Partial<RepoFileProvider> = {}): RepoFileProvider => ({
      readFile: vi.fn().mockResolvedValue(source), findFiles: vi.fn().mockResolvedValue([]), ...overrides,
    });

    it.each(['read_file', 'view_file'])('REL-1204 exact-source carried placeholder via %s reads current source once', async (tool) => {
      const repoFileProvider = provider();
      const result = await runReadOnlyTool(tool, { path: 'src/auth/multi.ts' }, baseContext({
        changedFiles: [{ path: 'src/auth/multi.ts', patch: '[carried-forward: exact-head content available via tools]' }], repoFileProvider,
      }));
      expect({ sourceReads: vi.mocked(repoFileProvider.readFile).mock.calls.length, output: result.toolOutput }).toEqual({
        sourceReads: 1,
        output: "Tool '" + tool + "' execution result:\nFile 'src/auth/multi.ts' is part of this PR's diff and exists in the repository at the reviewed head. Full current content:\n" + source,
      });
      expect(repoFileProvider.readFile).toHaveBeenCalledWith('src/auth/multi.ts');
      expect(result).toMatchObject({ toolScope: 'full-repository', isExhaustive: true });
    });

    it.each(['read_file', 'view_file'])('REL-1204 exact-source ordinary changed patch via %s is not source', async (tool) => {
      const repoFileProvider = provider();
      const result = await runReadOnlyTool(tool, { path: 'src/auth/multi.ts' }, baseContext({ repoFileProvider }));
      expect(repoFileProvider.readFile).toHaveBeenCalledExactlyOnceWith('src/auth/multi.ts');
      expect(result.toolOutput).toContain(source);
      expect(result.toolOutput).not.toContain('export function login()');
      expect(result).toMatchObject({ toolScope: 'full-repository', isExhaustive: true });
    });

    it.each([
      [{ path: './src/auth/multi.ts' }], [{ filePath: '/src/auth/multi.ts' }],
      [{ path: ' ./src/auth/multi.ts ', filePath: '/src/auth/multi.ts' }],
    ])('accepts normalized exact path aliases %j', async (args) => {
      const repoFileProvider = provider();
      const result = await runReadOnlyTool('read_file', args, baseContext({ repoFileProvider }));
      expect(repoFileProvider.readFile).toHaveBeenCalledExactlyOnceWith('src/auth/multi.ts');
      expect(result.toolOutput).toContain(source);
    });

    it.each([
      {}, { path: '' }, { path: ' /./ ' }, { path: 42 }, { path: null }, { path: {} },
      { filePath: false }, { path: 'src/a.ts', filePath: 'src/b.ts' },
      { path: '', filePath: 'src/auth/multi.ts' }, { path: '../src/auth/multi.ts' },
      { path: 'src/../auth/multi.ts' }, { path: 'src\\auth\\multi.ts' }, { path: 'src/\u0000multi.ts' },
    ])('rejects malformed or ambiguous path %j without reading any file', async (args) => {
      const repoFileProvider = provider();
      for (const tool of ['read_file', 'view_file', 'get_diff']) {
        const result = await runReadOnlyTool(tool, args, baseContext({ repoFileProvider }));
        expect(result.toolOutput).toContain('execution rejected: Expected one exact repository path');
        expect(result.toolOutput).not.toContain('export function login()');
        expect(result).toMatchObject({ toolScope: 'changed-patches-only', isExhaustive: false });
      }
      expect(repoFileProvider.readFile).not.toHaveBeenCalled();
      expect(repoFileProvider.findFiles).not.toHaveBeenCalled();
    });

    it('rejects duplicate normalized changed paths rather than selecting the first', async () => {
      const repoFileProvider = provider();
      const result = await runReadOnlyTool('read_file', { path: 'src/auth/multi.ts' }, baseContext({ repoFileProvider,
        changedFiles: [{ path: 'src/auth/multi.ts', patch: 'FIRST' }, { path: './src/auth/multi.ts', patch: 'SECOND' }],
      }));
      expect(result.toolOutput).toContain('Ambiguous changed-file path');
      expect(result.toolOutput).not.toContain('FIRST');
      expect(repoFileProvider.readFile).not.toHaveBeenCalled();
    });

    it.each(['multi.ts', 'src/auth/multi', 'src/auth', 'src/wrong.ts'])('never substring-selects changed source for %s', async (path) => {
      const repoFileProvider = provider({ readFile: vi.fn().mockResolvedValue(null) });
      const result = await runReadOnlyTool('read_file', { path }, baseContext({ repoFileProvider }));
      expect(repoFileProvider.readFile).toHaveBeenCalledExactlyOnceWith(path);
      expect(result.toolOutput).not.toContain('export function login()');
      const fallback = await runReadOnlyTool('view_file', { path }, baseContext());
      expect(fallback.toolOutput).toContain('may still exist elsewhere');
      expect(fallback.toolOutput).not.toContain('export function login()');
    });

    it('keeps literal bracket paths exact, not glob-selected', async () => {
      const repoFileProvider = provider();
      const result = await runReadOnlyTool('read_file', { path: './app/[id]/page.tsx' }, baseContext({ repoFileProvider,
        changedFiles: [{ path: 'app/[id]/page.tsx', patch: 'PATCH' }],
      }));
      expect(repoFileProvider.readFile).toHaveBeenCalledExactlyOnceWith('app/[id]/page.tsx');
      expect(result.toolOutput).toContain(source);
    });

    it.each([
      [{ startLine: 2, endLine: 2 }, 'Lines 2-2 of 3', 'export const current = true;', false],
      [{ start_line: 2 }, 'Lines 2-3 of 3', 'export const current = true;\nCURRENT_SOURCE_TAIL', false],
      [{ end_line: 2 }, 'Lines 1-2 of 3', 'CURRENT_SOURCE_HEADER\nexport const current = true;', false],
      [{ startLine: 99, endLine: 1 }, 'Lines 3-3 of 3', 'CURRENT_SOURCE_TAIL', false],
      [{ startLine: 0.5, endLine: 99 }, 'Lines 1-3 of 3', source, true],
    ] as const)('slices current source lines and discloses completeness %j', async (range, note, shown, exhaustive) => {
      const result = await runReadOnlyTool('read_file', { path: 'src/auth/multi.ts', ...range }, baseContext({ repoFileProvider: provider() }));
      expect(result.toolOutput).toContain(note + " for 'src/auth/multi.ts':\nCurrent source lines:\n" + shown);
      expect(result.toolOutput).not.toContain('Full current content');
      expect(result).toMatchObject({ toolScope: 'full-repository', isExhaustive: exhaustive });
    });

    it('ignores invalid numeric ranges and accepts an empty current source', async () => {
      const result = await runReadOnlyTool('view_file', { path: 'src/auth/multi.ts', startLine: NaN, endLine: '2' }, baseContext({ repoFileProvider: provider({ readFile: vi.fn().mockResolvedValue('') }) }));
      expect(result.toolOutput).toContain('Full current content:\n');
      expect(result).toMatchObject({ toolScope: 'full-repository', isExhaustive: true });
    });

    it('caps changed current source honestly, and a smaller source range is still available', async () => {
      const oversizedSource = 'a'.repeat(REPO_READ_FILE_MAX_CHARS + 10) + '\nTAIL_SOURCE';
      const repoFileProvider = provider({ readFile: vi.fn().mockResolvedValue(oversizedSource) });
      const capped = await runReadOnlyTool('read_file', { path: 'src/auth/multi.ts' }, baseContext({ repoFileProvider }));
      expect(capped).toMatchObject({ toolScope: 'full-repository', isExhaustive: false });
      expect(capped.toolOutput).toContain('Content truncated to the first ' + REPO_READ_FILE_MAX_CHARS);
      expect(capped.toolOutput).toContain('[... content truncated: 22 more characters not shown]');
      expect(capped.toolOutput).not.toContain('Full current content');
      expect(capped.toolOutput).not.toContain('TAIL_SOURCE');
      const range = await runReadOnlyTool('view_file', { path: 'src/auth/multi.ts', startLine: 2, endLine: 2 }, baseContext({ repoFileProvider }));
      expect(range.toolOutput).toContain('Current source lines:\nTAIL_SOURCE');
      expect(range.isExhaustive).toBe(false);
    });

    it.each(['read_file', 'view_file', 'get_diff'])('preserves changed oversized exclusion before any provider call for %s', async (tool) => {
      vi.stubEnv('MAX_FILE_DIFF_CHARS', '20');
      const repoFileProvider = provider();
      const result = await runReadOnlyTool(tool, { path: 'src/auth/multi.ts', startLine: 2, endLine: 2 }, baseContext({ repoFileProvider,
        changedFiles: [{ path: 'src/auth/multi.ts', patch: 'small placeholder', originalPatchLength: 21 }],
      }));
      expect(result.toolOutput).toContain("SKIPPED 'src/auth/multi.ts': patch is 21 characters, over max-file-diff-chars 20");
      expect(repoFileProvider.readFile).not.toHaveBeenCalled();
      expect(result).toMatchObject({ toolScope: 'changed-patches-only', isExhaustive: false });
    });

    it('get_diff remains patch-only with a provider and applies patch ranges', async () => {
      const repoFileProvider = provider();
      const result = await runReadOnlyTool('get_diff', { filePath: './src/auth/multi.ts', start_line: 2, end_line: 2 }, baseContext({ repoFileProvider,
        changedFiles: [{ path: 'src/auth/multi.ts', patch: 'PATCH_HEADER\n+PATCH_CHANGE\nPATCH_TAIL' }],
      }));
      expect(result.toolOutput).toContain("Changed patch only; this is not full current source.\nLines 2-2 of 3 for 'src/auth/multi.ts':\n+PATCH_CHANGE");
      expect(result).toMatchObject({ toolScope: 'changed-patches-only', isExhaustive: false });
      expect(repoFileProvider.readFile).not.toHaveBeenCalled();
      expect(repoFileProvider.findFiles).not.toHaveBeenCalled();
    });

    it('get_diff outside the exact changed path never reads source or claims repository absence', async () => {
      const repoFileProvider = provider();
      for (const path of ['multi.ts', 'src/other.ts']) {
        const result = await runReadOnlyTool('get_diff', { path }, baseContext({ repoFileProvider }));
        expect(result.toolOutput).toContain('No changed patch');
        expect(result.toolOutput).toContain('not evidence the file is missing');
        expect(result).toMatchObject({ toolScope: 'changed-patches-only', isExhaustive: false });
      }
      expect(repoFileProvider.readFile).not.toHaveBeenCalled();
      expect(repoFileProvider.findFiles).not.toHaveBeenCalled();
    });

    it('retains no-provider content/placeholder fallback as explicitly patch-scoped', async () => {
      for (const file of [{ path: 'src/a.ts', content: 'PATCH_CONTENT' }, { path: 'src/a.ts' }]) {
        const result = await runReadOnlyTool('read_file', { path: 'src/a.ts' }, baseContext({ changedFiles: [file] }));
        expect(result.toolOutput).toContain('no full-repository access is wired');
        expect(result.toolOutput).toContain(file.content || 'File present in PR scope.');
        expect(result).toMatchObject({ toolScope: 'changed-patches-only', isExhaustive: false });
      }
    });

    it('caps patch fallback without allowing a larger patch to bypass the source cap', async () => {
      vi.stubEnv('MAX_FILE_DIFF_CHARS', String(REPO_READ_FILE_MAX_CHARS + 10));
      const result = await runReadOnlyTool('get_diff', { path: 'src/a.ts' }, baseContext({ changedFiles: [{ path: 'src/a.ts', patch: 'p'.repeat(REPO_READ_FILE_MAX_CHARS + 1) }] }));
      expect(result.toolOutput).toContain('Patch for');
      expect(result.toolOutput).toContain('truncated to the first ' + REPO_READ_FILE_MAX_CHARS);
      expect(result.isExhaustive).toBe(false);
    });

    it.each([
      [[], false, 'does not exist in the repository', true],
      [['src/auth/multi.ts'], false, 'EXISTS in the repository tree', false],
      [[], true, 'tree was truncated', false],
    ] as const)('does not reuse deleted/unreadable patches after provider null: %j', async (hits, truncated, message, exhaustive) => {
      const repoFileProvider = provider({ readFile: vi.fn().mockResolvedValue(null), findFiles: vi.fn().mockResolvedValue(hits), treeTruncated: vi.fn().mockResolvedValue(truncated) });
      const result = await runReadOnlyTool('read_file', { path: 'src/auth/multi.ts' }, baseContext({ repoFileProvider }));
      expect(result.toolOutput).toContain(message);
      expect(result.toolOutput).not.toContain('export function login()');
      expect(result).toMatchObject({ toolScope: 'full-repository', isExhaustive: exhaustive });
    });

    it('preserves directory/pattern and failed-tree honesty after a null source read', async () => {
      for (const [path, hits, message] of [
        ['src/auth', ['src/auth/multi.ts'], 'is a directory'],
        ['src/*.ts', ['src/auth/multi.ts'], 'is a pattern'],
        ['src/*.ts', [], 'Use find_files'],
      ] as const) {
        const result = await runReadOnlyTool('read_file', { path }, baseContext({ repoFileProvider: provider({ readFile: vi.fn().mockResolvedValue(null), findFiles: vi.fn().mockResolvedValue(hits) }) }));
        expect(result.toolOutput).toContain(message);
        expect(result.toolOutput).not.toContain('export function login()');
      }
      const failure = await runReadOnlyTool('view_file', { path: 'src/auth/multi.ts' }, baseContext({ repoFileProvider: provider({ readFile: vi.fn().mockResolvedValue(null), findFiles: vi.fn().mockRejectedValue(new Error('tree failed')) }) }));
      expect(failure.toolOutput).toContain('cross-check failed');
      expect(failure.isExhaustive).toBe(false);
    });

    it.each([new Error('source failed'), 'source unavailable'])('does not fall back to a changed patch on provider error %s', async (error) => {
      const result = await runReadOnlyTool('view_file', { path: 'src/auth/multi.ts' }, baseContext({ repoFileProvider: provider({ readFile: vi.fn().mockRejectedValue(error) }) }));
      expect(result.toolOutput).toContain('lookup failure, not confirmation');
      expect(result.toolOutput).not.toContain('export function login()');
      expect(result).toMatchObject({ toolScope: 'full-repository', isExhaustive: false });
    });

    it('cancels source reads, including pre-aborted calls, without reporting absence', async () => {
      const controller = new AbortController();
      const repoFileProvider = provider({ readFile: vi.fn(() => new Promise<string>(() => undefined)) });
      const read = runReadOnlyTool('read_file', { path: 'src/auth/multi.ts' }, baseContext({ repoFileProvider, signal: controller.signal }));
      controller.abort();
      await expect(read).rejects.toMatchObject({ name: 'PanelCancellationError' });
      expect(repoFileProvider.readFile).toHaveBeenCalledTimes(1);
      await expect(runReadOnlyTool('get_diff', {}, baseContext({ repoFileProvider, signal: controller.signal }))).rejects.toMatchObject({ name: 'PanelCancellationError' });
      expect(repoFileProvider.readFile).toHaveBeenCalledTimes(1);
    });
  });

  describe('grep_search / search_code', () => {
    it('reports matches found within the diff', async () => {
      const result = await runReadOnlyTool('grep_search', { query: 'login' }, baseContext());
      expect(result).toEqual({
        toolOutput: "Tool 'grep_search' execution result:\nMatches found in diff: src/auth/multi.ts",
        toolScope: 'changed-patches-only',
        isExhaustive: false,
      });
    });

    it('says a diff-scoped miss does not mean the text does not exist anywhere (scope envelope)', async () => {
      const result = await runReadOnlyTool('search_code', { query: 'nonexistentSymbolXYZ' }, baseContext());
      expect(result.toolScope).toBe('changed-patches-only');
      expect(result.isExhaustive).toBe(false);
      expect(result.toolOutput).toBe(
        "Tool 'search_code' execution result:\nNo matches for 'nonexistentSymbolXYZ' in the diff. This tool's text search scope is changed files only, not the full repository -- a match may still exist outside the diff. Use find_files/read_file to check a specific file directly.",
      );
    });
  });

  describe('symbol_search', () => {
    it('finds a matching symbol parsed out of the changed file', async () => {
      const result = await runReadOnlyTool('symbol_search', { query: 'login' }, baseContext());
      expect(result.toolScope).toBe('changed-patches-only');
      expect(result.isExhaustive).toBe(false);
      expect(result.toolOutput).toContain("Tool 'symbol_search' execution result:");
      expect(result.toolOutput).toContain('src/auth/multi.ts:');
      expect(result.toolOutput).toContain('login');
    });

    it('says a diff-scoped miss does not mean the symbol does not exist anywhere (scope envelope)', async () => {
      const result = await runReadOnlyTool('symbol_search', { query: 'totallyMissingSymbolXYZ' }, baseContext());
      expect(result).toEqual({
        toolOutput: "Tool 'symbol_search' execution result:\nNo symbols found matching 'totallyMissingSymbolXYZ' in the diff. This tool's search scope is changed files only, not the full repository -- the symbol may be defined elsewhere.",
        toolScope: 'changed-patches-only',
        isExhaustive: false,
      });
    });
  });

  describe('code_search_zoekt / zoekt_search', () => {
    it('reports the full-repository-zoekt scope, non-exhaustive, when no zoekt index is configured', async () => {
      const result = await runReadOnlyTool('code_search_zoekt', { query: 'login' }, baseContext());
      expect(result.toolScope).toBe('full-repository-zoekt');
      expect(result.isExhaustive).toBe(false);
      expect(result.toolOutput).toContain('[SCOPE: full-repository-zoekt | EXHAUSTIVE: false]');
      expect(result.toolOutput).toContain('"status": "unavailable"');
    });
  });

  describe('MCP tool dispatch', () => {
    it('executes an allowed MCP tool through mcpFleetManager with the exact args', async () => {
      (mcpFleetManager.executeTool as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, output: { ok: true } });
      const result = await runReadOnlyTool('fetch_docs', { library: 'node' }, baseContext());
      expect(mcpFleetManager.executeTool).toHaveBeenCalledWith('fetch_docs', { library: 'node' });
      expect(result).toEqual({
        toolOutput: `Tool 'fetch_docs' execution result:\n${JSON.stringify({ ok: true }, null, 2)}`,
        toolScope: 'changed-patches-only',
        isExhaustive: false,
      });
    });

    it('surfaces a failed MCP execution as an inline error string, not a thrown error', async () => {
      (mcpFleetManager.executeTool as ReturnType<typeof vi.fn>).mockResolvedValue({ success: false, error: 'boom' });
      const result = await runReadOnlyTool('fetch_docs', {}, baseContext());
      expect(result.toolOutput).toBe("Tool 'fetch_docs' execution result:\nMCP Error: boom");
    });

    it('surfaces a thrown MCP error as an inline MCP Error string', async () => {
      (mcpFleetManager.executeTool as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('mcp down'));
      const result = await runReadOnlyTool('linear_get_issue', { id: 'X-1' }, baseContext());
      expect(result.toolOutput).toBe("Tool 'linear_get_issue' execution result:\nMCP Error: mcp down");
    });
  });

  describe('Fleet MCP Tools & Scope Envelopes', () => {
    it('admits ct-impact tools and sets cross-repository-ast-mesh scope', async () => {
      (mcpFleetManager.executeTool as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        output: { blast_radius: 'LOW', impacted_routes: ['/api/v1/health'] },
      });
      const result = await runReadOnlyTool('ct_impact', { target: 'routes' }, baseContext());
      expect(result.toolScope).toBe('cross-repository-ast-mesh');
      expect(result.isExhaustive).toBe(true);
      expect(result.toolOutput).toContain('blast_radius');
    });

    it('admits ct_mesh_query with valid args and sets cross-repository-ast-mesh scope', async () => {
      (mcpFleetManager.executeTool as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        output: { nodes: [{ id: 'UserRouter', kind: 'router' }] },
      });
      const result = await runReadOnlyTool('ct_mesh_query', { query: 'UserRouter' }, baseContext());
      expect(result.toolScope).toBe('cross-repository-ast-mesh');
      expect(result.isExhaustive).toBe(true);
      expect(result.toolOutput).toContain('UserRouter');
    });

    it('admits ct_mesh_stats and sets cross-repository-ast-mesh scope', async () => {
      (mcpFleetManager.executeTool as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        output: { repositories: 10, total_nodes: 5432 },
      });
      const result = await runReadOnlyTool('ct_mesh_stats', {}, baseContext());
      expect(result.toolScope).toBe('cross-repository-ast-mesh');
      expect(result.isExhaustive).toBe(true);
    });

    it('admits knowledge_search and sets governed-knowledge-adr scope', async () => {
      (mcpFleetManager.executeTool as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        output: [{ id: 'ADR-0329', title: 'Zoekt Search Integration' }],
      });
      const result = await runReadOnlyTool('knowledge_search', { query: 'zoekt' }, baseContext());
      expect(result.toolScope).toBe('governed-knowledge-adr');
      expect(result.isExhaustive).toBe(true);
      expect(result.toolOutput).toContain('ADR-0329');
    });

    it('admits knowledge_get and sets governed-knowledge-adr scope', async () => {
      (mcpFleetManager.executeTool as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        output: 'Full ADR text content',
      });
      const result = await runReadOnlyTool('knowledge_get', { id: 'ADR-0329' }, baseContext());
      expect(result.toolScope).toBe('governed-knowledge-adr');
      expect(result.isExhaustive).toBe(true);
      expect(result.toolOutput).toContain('Full ADR text content');
    });

    it('admits advise_blocker and sets policy-blocker-quorum scope', async () => {
      (mcpFleetManager.executeTool as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        output: { advised: true, consensus: 'SHIP' },
      });
      const result = await runReadOnlyTool('advise_blocker', { blocker_packet: { id: 'B-1' } }, baseContext());
      expect(result.toolScope).toBe('policy-blocker-quorum');
      expect(result.isExhaustive).toBe(true);
      expect(result.toolOutput).toContain('SHIP');
    });

    it('admits health and sets policy-blocker-quorum scope', async () => {
      (mcpFleetManager.executeTool as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        output: { status: 'healthy', quorum_ready: true },
      });
      const result = await runReadOnlyTool('health', {}, baseContext());
      expect(result.toolScope).toBe('policy-blocker-quorum');
      expect(result.isExhaustive).toBe(true);
    });

    it('strictly rejects mutating tools with Permission denied', async () => {
      const mutatingTools = ['memory_record', 'memory_supersede', 'linear_close_issue', 'shell_exec'];
      for (const tool of mutatingTools) {
        const result = await runReadOnlyTool(tool, { foo: 'bar' }, baseContext());
        expect(result.toolOutput).toContain("execution rejected: Permission denied");
        expect(result.toolScope).toBe('changed-patches-only');
        expect(result.isExhaustive).toBe(false);
      }
    });

    it('rejects fleet tools missing required arguments before invoking mcpFleetManager', async () => {
      const impResult = await runReadOnlyTool('ct_impact', {}, baseContext());
      expect(impResult.toolOutput).toContain("Missing required argument 'target'");
      expect(impResult.isExhaustive).toBe(false);

      const qResult = await runReadOnlyTool('ct_mesh_query', {}, baseContext());
      expect(qResult.toolOutput).toContain("Missing required argument 'query'");
      expect(qResult.isExhaustive).toBe(false);

      const ksResult = await runReadOnlyTool('knowledge_search', { query: '   ' }, baseContext());
      expect(ksResult.toolOutput).toContain("Missing required argument 'query'");
      expect(ksResult.isExhaustive).toBe(false);

      const kgResult = await runReadOnlyTool('knowledge_get', {}, baseContext());
      expect(kgResult.toolOutput).toContain("Missing required argument 'id'");
      expect(kgResult.isExhaustive).toBe(false);

      const abResult = await runReadOnlyTool('advise_blocker', {}, baseContext());
      expect(abResult.toolOutput).toContain("Missing required argument 'blocker_packet'");
      expect(abResult.isExhaustive).toBe(false);
    });

    it('handles fleet tool execution failure gracefully with MCP Error and isExhaustive: false', async () => {
      (mcpFleetManager.executeTool as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        error: 'Neo4j connection refused',
      });
      const result = await runReadOnlyTool('knowledge_search', { query: 'auth' }, baseContext());
      expect(result.toolOutput).toContain('MCP Error: Neo4j connection refused');
      expect(result.toolScope).toBe('governed-knowledge-adr');
      expect(result.isExhaustive).toBe(false);
    });
  });
});
