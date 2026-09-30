import { describe, it, expect, vi, afterEach } from 'vitest';
import { runReadOnlyTool, type ToolRuntimeContext } from '../toolRuntime';
import type { RepoFileProvider } from '../panelEngine';

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
    it('labels changed-file fallback as patch-only when no repository provider is wired', async () => {
      const result = await runReadOnlyTool('read_file', {
        path: 'src/auth/multi.ts', startLine: 2, endLine: 3,
      }, baseContext());
      expect(result.toolScope).toBe('changed-patches-only');
      expect(result.isExhaustive).toBe(false);
      expect(result.toolOutput).toContain('Only the PR patch is available');
      expect(result.toolOutput).toContain('cannot be applied to patch hunks');
      expect(result.toolOutput).toContain('export function login() {}');
      expect(result.toolOutput).not.toContain('Full current content');
    });

    it('reads a changed path from the reviewed-head provider and slices source lines, not patch lines', async () => {
      const source = [
        'line 1: module header',
        'line 2: exported entrypoint',
        'line 3: unchanged strict allowlist context',
        'line 4: strictCaseAllowlist = ["known-safe"]',
        'line 5: footer',
      ].join('\n');
      const repoFileProvider: RepoFileProvider = {
        findFiles: vi.fn(),
        readFile: vi.fn().mockResolvedValue(source),
      };
      const result = await runReadOnlyTool(
        'read_file',
        { path: 'src/auth/multi.ts', startLine: 3, endLine: 4 },
        baseContext({ repoFileProvider }),
      );
      expect(result.toolScope).toBe('full-repository');
      expect(result.isExhaustive).toBe(true);
      expect(repoFileProvider.readFile).toHaveBeenCalledExactlyOnceWith('src/auth/multi.ts');
      expect(result.toolOutput).toBe(
        "Tool 'read_file' execution result:\nFile 'src/auth/multi.ts' is changed in this PR; reading the current file at the reviewed head, not the patch. Lines 3-4 of 5 for 'src/auth/multi.ts':\nline 3: unchanged strict allowlist context\nline 4: strictCaseAllowlist = [\"known-safe\"]",
      );
    });

    it('keeps get_diff patch-scoped and does not consult the full-file provider', async () => {
      const repoFileProvider: RepoFileProvider = {
        findFiles: vi.fn(),
        readFile: vi.fn().mockResolvedValue('complete source, not a diff'),
      };
      const result = await runReadOnlyTool('get_diff', { path: 'src/auth/multi.ts' }, baseContext({ repoFileProvider }));
      expect(result.toolScope).toBe('changed-patches-only');
      expect(result.isExhaustive).toBe(false);
      expect(result.toolOutput).toContain('export function login() {}');
      expect(result.toolOutput).not.toContain('complete source');
      expect(repoFileProvider.readFile).not.toHaveBeenCalled();
    });

    it('keeps get_diff unavailable when the changed file has content but no patch', async () => {
      const content = 'CHANGED FILE SOURCE BODY MUST NOT BE RETURNED';
      const providerContent = 'PROVIDER SOURCE BODY MUST NOT BE RETURNED';
      const repoFileProvider: RepoFileProvider = {
        findFiles: vi.fn(),
        readFile: vi.fn().mockResolvedValue(providerContent),
      };
      const result = await runReadOnlyTool('get_diff', {
        path: 'src/auth/multi.ts', startLine: 1, endLine: 1,
      }, baseContext({
        changedFiles: [{ path: 'src/auth/multi.ts', content }],
        repoFileProvider,
      }));
      expect(result).toEqual({
        toolOutput: "Tool 'get_diff' execution result:\nNo PR diff patch text is available for 'src/auth/multi.ts'. get_diff does not return current source content.",
        toolScope: 'changed-patches-only',
        isExhaustive: false,
      });
      expect(result.toolOutput).not.toContain(content);
      expect(result.toolOutput).not.toContain(providerContent);
      expect(repoFileProvider.readFile).not.toHaveBeenCalled();
      expect(repoFileProvider.findFiles).not.toHaveBeenCalled();
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

    it('keeps get_diff diff-only for a path outside the PR and never probes the repository provider', async () => {
      const repoFileProvider: RepoFileProvider = {
        findFiles: vi.fn(),
        readFile: vi.fn().mockResolvedValue(null),
      };
      const result = await runReadOnlyTool('get_diff', { path: 'src/missing.ts' }, baseContext({ repoFileProvider }));
      expect(result).toEqual({
        toolOutput: "Tool 'get_diff' execution result:\nNo PR diff patch is available for 'src/missing.ts'. get_diff is limited to changed-file patch content; use read_file for current file content when the repository provider is available.",
        toolScope: 'changed-patches-only',
        isExhaustive: false,
      });
      expect(repoFileProvider.readFile).not.toHaveBeenCalled();
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

    it('reports changed-file provider failure as unavailable instead of full-file coverage', async () => {
      const repoFileProvider: RepoFileProvider = {
        findFiles: vi.fn(),
        readFile: vi.fn().mockRejectedValue(new Error('head blob unavailable')),
      };
      const result = await runReadOnlyTool('read_file', { path: 'src/auth/multi.ts' }, baseContext({ repoFileProvider }));
      expect(result.toolScope).toBe('changed-patches-only');
      expect(result.isExhaustive).toBe(false);
      expect(result.toolOutput).toContain('head blob unavailable');
      expect(result.toolOutput).toContain('lookup failure');
      expect(result.toolOutput).toContain('Only the PR patch is available');
      expect(result.toolOutput).toContain('export function login() {}');
      expect(result.toolOutput).not.toContain('Full current content');
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

    it('keeps text search diff-only even when the full-file provider is available', async () => {
      const repoFileProvider: RepoFileProvider = {
        findFiles: vi.fn(),
        readFile: vi.fn().mockResolvedValue('outside-only-token'),
      };
      const result = await runReadOnlyTool('grep_search', { query: 'outside-only-token' }, baseContext({
        changedFiles: [{ path: 'src/auth/multi.ts', patch: '+changed token\n' }],
        repoFileProvider,
      }));
      expect(result.toolScope).toBe('changed-patches-only');
      expect(result.isExhaustive).toBe(false);
      expect(result.toolOutput).toContain('No matches');
      expect(repoFileProvider.readFile).not.toHaveBeenCalled();
      expect(repoFileProvider.findFiles).not.toHaveBeenCalled();
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

import { REPO_READ_FILE_MAX_CHARS } from '../panelEngine';

describe('REL-1204 surviving exact-source safety', () => {
  const path = 'src/auth/multi.ts';
  const source = 'LATEST_SOURCE_HEADER\nCURRENT_EXACT_HEAD_SOURCE\nLATEST_SOURCE_TAIL';
  const patch = 'UNRELATED_FIRST_PATCH_PAYLOAD';
  const provider = (readFile = vi.fn().mockResolvedValue(source)): RepoFileProvider => ({
    readFile, findFiles: vi.fn().mockResolvedValue([]),
  });
  const context = (repoFileProvider?: RepoFileProvider, changedFiles: any[] = [{ path, patch }]): ToolRuntimeContext => ({
    changedFiles, ...(repoFileProvider ? { repoFileProvider } : {}),
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it.each([
    {}, { path: '' }, { path: ' /./ ' }, { path: 42 }, { path: null }, { path: {} },
    { filePath: false }, { path: 'src/a.ts', filePath: 'src/b.ts' },
    { path: '', filePath: 'src/auth/multi.ts' }, { path: '../src/auth/multi.ts' },
    { path: 'src/../auth/multi.ts' }, { path: 'src\\auth\\multi.ts' }, { path: 'src/\u0000multi.ts' },
  ])('REL-1204 latest-base unsafe malformed or conflicting aliases %j are refused before I/O', async (args) => {
    const repoFileProvider = provider();
    for (const tool of ['read_file', 'view_file', 'get_diff']) {
      const result = await runReadOnlyTool(tool, args, context(repoFileProvider));
      const observed = { sourceReads: vi.mocked(repoFileProvider.readFile).mock.calls.length,
        treeReads: vi.mocked(repoFileProvider.findFiles).mock.calls.length, ...result };
      expect(observed, JSON.stringify(observed)).toMatchObject({ sourceReads: 0, treeReads: 0,
        toolScope: 'changed-patches-only', isExhaustive: false,
        toolOutput: expect.stringContaining('execution rejected: Expected one exact repository path') });
      expect(result.toolOutput).not.toContain(patch);
      expect(result.toolOutput).not.toContain(source);
    }
  });

  it.each(['multi.ts', 'src/auth/multi', 'src/auth'])('REL-1204 latest-base unsafe partial path %s never selects an unrelated changed patch', async (partial) => {
    for (const tool of ['read_file', 'view_file', 'get_diff']) {
      const result = await runReadOnlyTool(tool, { path: partial }, context());
      expect({ path: partial, ...result }, JSON.stringify(result)).toMatchObject({
        toolScope: 'changed-patches-only', isExhaustive: false,
        toolOutput: expect.not.stringContaining(patch),
      });
      expect(result.toolOutput).toContain(partial);
    }
  });

  it('REL-1204 latest-base unsafe duplicate normalized changed paths are refused', async () => {
    const repoFileProvider = provider();
    for (const tool of ['read_file', 'view_file', 'get_diff']) {
      const result = await runReadOnlyTool(tool, { path }, context(repoFileProvider, [
        { path, patch }, { path: './' + path, patch: 'SECOND_PATCH_PAYLOAD' },
      ]));
      const observed = { sourceReads: vi.mocked(repoFileProvider.readFile).mock.calls.length, ...result };
      expect(observed, JSON.stringify(observed)).toMatchObject({ sourceReads: 0,
        toolScope: 'changed-patches-only', isExhaustive: false,
        toolOutput: expect.stringContaining('Ambiguous changed-file path') });
      expect(result.toolOutput).not.toContain(patch);
    }
  });

  it.each([{ path: './src/auth/multi.ts' }, { filePath: '/src/auth/multi.ts' },
    { path: ' ./src/auth/multi.ts ', filePath: '/src/auth/multi.ts' }])
  ('accepts equal normalized exact aliases %j', async (args) => {
    const repoFileProvider = provider();
    const result = await runReadOnlyTool('view_file', args, context(repoFileProvider, [{ path: './' + path, patch }]));
    expect(repoFileProvider.readFile).toHaveBeenCalledExactlyOnceWith(path);
    expect(result.toolOutput).toContain(source);
    expect(result.toolOutput).not.toContain(patch);
  });

  it.each(['[carried-forward: exact-head content available via tools]', patch])
  ('REL-1204 latest-base view_file changed payload %s reads exact current source once', async (changedPatch) => {
    const repoFileProvider = provider();
    const result = await runReadOnlyTool('view_file', { path }, context(repoFileProvider, [{ path, patch: changedPatch }]));
    const observed = { sourceReads: vi.mocked(repoFileProvider.readFile).mock.calls.length, ...result };
    expect(observed, JSON.stringify(observed)).toMatchObject({ sourceReads: 1, toolScope: 'full-repository',
      isExhaustive: true, toolOutput: expect.stringContaining(source) });
    expect(repoFileProvider.readFile).toHaveBeenCalledExactlyOnceWith(path);
    expect(result.toolOutput).not.toContain(changedPatch);
  });

  it.each(['small', 'capped', 'range'] as const)
  ('REL-1204 latest-base view_file huge patch with %s source uses independent source authority', async (kind) => {
    vi.stubEnv('MAX_FILE_DIFF_CHARS', '20');
    const content = kind === 'small' ? source : 'a'.repeat(REPO_READ_FILE_MAX_CHARS + 10) + '\nTARGET_SOURCE_LINE\nLATEST_SOURCE_TAIL';
    const repoFileProvider = provider(vi.fn().mockResolvedValue(content));
    const args = kind === 'range' ? { filePath: './' + path, start_line: 2, end_line: 2 } : { path };
    const result = await runReadOnlyTool('view_file', args, context(repoFileProvider, [
      { path, patch: 'PATCH_SENTINEL', originalPatchLength: 2000000 },
    ]));
    const shown = kind === 'range' ? 'TARGET_SOURCE_LINE' : kind === 'capped' ? 'a'.repeat(REPO_READ_FILE_MAX_CHARS) : source;
    const observed = { sourceReads: vi.mocked(repoFileProvider.readFile).mock.calls.length, ...result };
    expect(observed, JSON.stringify({ ...observed, toolOutput: observed.toolOutput.slice(0, 1200) }))
      .toMatchObject({ sourceReads: 1, toolScope: 'full-repository', isExhaustive: kind !== 'capped',
        toolOutput: expect.stringContaining(shown) });
    expect(repoFileProvider.readFile).toHaveBeenCalledExactlyOnceWith(path);
    expect(result.toolOutput).not.toContain('PATCH_SENTINEL');
    if (kind === 'capped') {
      expect(result.toolOutput).toContain('Content truncated to the first ' + REPO_READ_FILE_MAX_CHARS);
      expect(result.toolOutput).not.toContain('TARGET_SOURCE_LINE');
      expect(result.toolOutput).not.toContain('Full current content');
    } else if (kind === 'range') {
      expect(result.toolOutput).toContain("Lines 2-2 of 3 for '" + path + "'");
      expect(result.toolOutput).not.toContain('LATEST_SOURCE_TAIL');
      expect(result.toolOutput).not.toContain('Content truncated');
    }
  });

  it('retains read_file exact-request completeness but discloses a capped request as incomplete', async () => {
    const content = 'a'.repeat(REPO_READ_FILE_MAX_CHARS + 1) + '\nSOURCE_END';
    const repoFileProvider = provider(vi.fn().mockResolvedValue(content));
    const capped = await runReadOnlyTool('read_file', { path }, context(repoFileProvider));
    expect(capped.isExhaustive).toBe(false);
    expect(capped.toolOutput).toContain('content truncated');
    const range = await runReadOnlyTool('read_file', { path, startLine: 2, endLine: 2 }, context(repoFileProvider));
    expect(range.isExhaustive).toBe(true);
    expect(range.toolOutput).toContain("Lines 2-2 of 2 for '" + path + "'");
    expect(range.toolOutput).toContain('SOURCE_END');
    expect(range.toolOutput).not.toContain('Full current content');
  });

  it.each(['read_file', 'view_file'])('null/deleted %s uses tree cross-check instead of exposing the changed patch', async (tool) => {
    const repoFileProvider = provider(vi.fn().mockResolvedValue(null));
    const absent = await runReadOnlyTool(tool, { path }, context(repoFileProvider));
    expect(absent.toolOutput).not.toContain(patch);
    expect(absent.toolOutput).toContain('checked the full repository tree');
    expect(absent.isExhaustive).toBe(true);
    expect(repoFileProvider.readFile).toHaveBeenCalledExactlyOnceWith(path);
    vi.mocked(repoFileProvider.findFiles).mockResolvedValue([path]);
    const exists = await runReadOnlyTool(tool, { path }, context(repoFileProvider));
    expect(exists.toolOutput).toContain('EXISTS in the repository tree');
    expect(exists.isExhaustive).toBe(false);
    vi.mocked(repoFileProvider.findFiles).mockResolvedValue([]);
    repoFileProvider.treeTruncated = vi.fn().mockResolvedValue(true);
    const truncated = await runReadOnlyTool(tool, { path }, context(repoFileProvider));
    expect(truncated.isExhaustive).toBe(false);
    expect(truncated.toolOutput).toContain('tree was truncated');
  });

  it.each(['read_file', 'view_file'])('source failure for %s preserves honest bounded patch fallback', async (tool) => {
    const repoFileProvider = provider(vi.fn().mockRejectedValue(new Error('head blob unavailable')));
    const result = await runReadOnlyTool(tool, { path, startLine: 2 }, context(repoFileProvider));
    expect(result).toMatchObject({ toolScope: 'changed-patches-only', isExhaustive: false });
    expect(result.toolOutput).toContain('lookup failure');
    expect(result.toolOutput).toContain('Only the PR patch is available');
    expect(result.toolOutput).toContain('cannot be applied to patch hunks');
    expect(result.toolOutput).toContain(patch);
    expect(result.toolOutput).not.toContain('Full current content');
  });

  it.each(['read_file', 'view_file', 'get_diff'])('pre-aborted %s does not start any provider work', async (tool) => {
    const controller = new AbortController(); controller.abort();
    const repoFileProvider = provider();
    await expect(runReadOnlyTool(tool, { path }, { ...context(repoFileProvider), signal: controller.signal })).rejects.toThrow();
    expect(repoFileProvider.readFile).not.toHaveBeenCalled();
    expect(repoFileProvider.findFiles).not.toHaveBeenCalled();
  });

  it('aborted active view_file rejects rather than publishing fallback evidence', async () => {
    const controller = new AbortController();
    const repoFileProvider = provider(vi.fn().mockImplementation(async () => {
      controller.abort(); throw new Error('cancelled provider');
    }));
    await expect(runReadOnlyTool('view_file', { path }, { ...context(repoFileProvider), signal: controller.signal })).rejects.toThrow();
    expect(repoFileProvider.readFile).toHaveBeenCalledExactlyOnceWith(path);
  });

  it('keeps literal bracket paths exact without glob selection', async () => {
    const repoFileProvider = provider();
    await runReadOnlyTool('view_file', { path: './app/[id]/page.tsx' }, context(repoFileProvider, [
      { path: 'app/[id]/page.tsx', patch }, { path: 'app/user/page.tsx', patch: 'OTHER' },
    ]));
    expect(repoFileProvider.readFile).toHaveBeenCalledExactlyOnceWith('app/[id]/page.tsx');
  });

  it('keeps view_file no-provider fallback explicitly patch-only without source-line slicing', async () => {
    const result = await runReadOnlyTool('view_file', { path, startLine: 2 }, context());
    expect(result).toMatchObject({ toolScope: 'changed-patches-only', isExhaustive: false });
    expect(result.toolOutput).toContain(patch);
    expect(result.toolOutput).toContain('cannot be applied to patch hunks');
  });

  it.each(['read_file', 'view_file', 'get_diff'])('keeps oversized no-provider %s excluded even for a narrow range', async (tool) => {
    vi.stubEnv('MAX_FILE_DIFF_CHARS', '20');
    const result = await runReadOnlyTool(tool, { path, startLine: 2 }, context(undefined, [{ path, patch, originalPatchLength: 2000000 }]));
    expect(result.toolOutput).toContain('SKIPPED');
    expect(result.toolOutput).not.toContain(patch);
    expect(result.isExhaustive).toBe(false);
  });
});

describe('REL-1204 exact-source remaining branch regressions', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('ignores malformed changed-file path entries without treating them as exact matches', async () => {
    const readFile = vi.fn().mockResolvedValue('EXACT_GOOD_SOURCE');
    const result = await runReadOnlyTool('view_file', { path: 'src/good.ts' }, {
      changedFiles: [{ path: null, patch: 'BAD_NULL' }, { path: 42, patch: 'BAD_NUMBER' },
        { path: 'src/good.ts.backup', patch: 'BAD_PARTIAL' }, { path: './src/good.ts', patch: 'EXACT_PATCH' }],
      repoFileProvider: { readFile, findFiles: vi.fn().mockResolvedValue([]) },
    });
    expect(readFile).toHaveBeenCalledExactlyOnceWith('src/good.ts');
    expect(result.toolOutput).toContain('EXACT_GOOD_SOURCE');
    expect(result.toolOutput).not.toContain('BAD_');
    expect(result.toolOutput).not.toContain('EXACT_PATCH');
  });

  it.each(['read_file', 'view_file', 'get_diff'])('caps honest no-provider %s fallback after preserving the separate patch ceiling', async (tool) => {
    vi.stubEnv('MAX_FILE_DIFF_CHARS', String(REPO_READ_FILE_MAX_CHARS + 10));
    const result = await runReadOnlyTool(tool, { path: 'src/a.ts' }, {
      changedFiles: [{ path: 'src/a.ts', patch: 'p'.repeat(REPO_READ_FILE_MAX_CHARS + 1) }],
    });
    expect(result).toMatchObject({ toolScope: 'changed-patches-only', isExhaustive: false });
    expect(result.toolOutput).toContain('Patch for');
    expect(result.toolOutput).toContain('truncated to the first ' + REPO_READ_FILE_MAX_CHARS);
    expect(result.toolOutput.length).toBeLessThan(REPO_READ_FILE_MAX_CHARS + 1000);
  });

  it.each([{ path: 'src/a.ts', content: 'ONLY_REVIEW_PAYLOAD' }, { path: 'src/a.ts' }])
  ('labels no-provider nonpatch payload %j as unverified context', async (file) => {
    const result = await runReadOnlyTool('view_file', { path: file.path }, { changedFiles: [file] });
    expect(result).toMatchObject({ toolScope: 'changed-patches-only', isExhaustive: false });
    expect(result.toolOutput).toContain('Only a changed-file review payload is available');
    expect(result.toolOutput).toContain('not verified complete source context');
    expect(result.toolOutput).toContain(file.content || 'File present in PR scope.');
  });
});
