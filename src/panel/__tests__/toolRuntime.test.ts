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
  });

  const baseContext = (overrides: Partial<ToolRuntimeContext> = {}): ToolRuntimeContext => ({
    changedFiles: [{ path: 'src/auth/multi.ts', patch: 'export function login() {}\n' }],
    ...overrides,
  });

  describe('bounded read_files', () => {
    it('returns separate exact-head source ranges in request order without substituting patches', async () => {
      const repoFileProvider: RepoFileProvider = {
        findFiles: vi.fn(),
        readFile: vi.fn(async (path) => path === 'src/auth/multi.ts'
          ? 'auth header\nauth caller contract\nauth footer'
          : 'config header\nconfig allowlist\nconfig footer'),
      };
      const result = await runReadOnlyTool('read_files', { files: [
        { path: 'src/auth/multi.ts', startLine: 2, endLine: 2 },
        { path: 'src/config.ts', startLine: 2, endLine: 2 },
      ] }, baseContext({ repoFileProvider }));
      expect(vi.mocked(repoFileProvider.readFile).mock.calls).toEqual([['src/auth/multi.ts'], ['src/config.ts']]);
      expect(result).toMatchObject({ toolScope: 'full-repository', isExhaustive: true });
      expect(result.toolOutput).toContain('Lines 2-2 of 3');
      expect(result.toolOutput).toContain('auth caller contract');
      expect(result.toolOutput).toContain('config allowlist');
      expect(result.toolOutput).not.toContain('export function login');
      expect(result.toolOutput).not.toContain('auth footer');
      expect(result.toolOutput.indexOf('auth caller contract')).toBeLessThan(result.toolOutput.indexOf('config allowlist'));
    });

    it('keeps a failed lookup and patch fallback non-exhaustive alongside a successful source read', async () => {
      const repoFileProvider: RepoFileProvider = {
        findFiles: vi.fn(),
        readFile: vi.fn(async (path) => {
          if (path === 'src/auth/multi.ts') throw new Error('lookup unavailable');
          return 'real current config';
        }),
      };
      const result = await runReadOnlyTool('read_files', { files: [
        { path: 'src/auth/multi.ts' }, { path: 'src/config.ts' },
      ] }, baseContext({ repoFileProvider }));
      expect(result).toMatchObject({ toolScope: 'mixed-read-only', isExhaustive: false });
      expect(result.toolOutput).toContain('SCOPE: changed-patches-only | EXHAUSTIVE: false');
      expect(result.toolOutput).toContain('lookup failure, not confirmation');
      expect(result.toolOutput).toContain('Only the PR patch is available');
      expect(result.toolOutput).toContain('SCOPE: full-repository | EXHAUSTIVE: true');
      expect(result.toolOutput).toContain('real current config');
    });

    it.each([
      {}, { files: [] }, { files: Array.from({ length: 9 }, () => ({ path: 'src/config.ts' })) },
      { files: [{ path: 'src/config.ts', tool: 'write_file' }] },
      { files: [{ path: 'src/config.ts', startLine: 4, endLine: 2 }] },
      { files: [{ path: 'src/config.ts', startLine: 1.5 }] },
      { files: [{ path: '' }] }, { files: [{ path: 'src/config.ts' }], tool: 'knowledge_get' },
    ])('rejects malformed or nested tool arguments before doing any I/O: %j', async (args) => {
      const repoFileProvider: RepoFileProvider = { findFiles: vi.fn(), readFile: vi.fn() };
      const result = await runReadOnlyTool('read_files', args, baseContext({ repoFileProvider }));
      expect(result.isExhaustive).toBe(false);
      expect(result.toolOutput).toContain('execution rejected');
      expect(repoFileProvider.readFile).not.toHaveBeenCalled();
      expect(mcpFleetManager.executeTool).not.toHaveBeenCalled();
    });

    it('bounds the aggregate UTF-8 output and does not read undisclosed remaining files', async () => {
      const repoFileProvider: RepoFileProvider = {
        findFiles: vi.fn(), readFile: vi.fn().mockResolvedValue('🧪'.repeat(200_000)),
      };
      const result = await runReadOnlyTool('read_files', { files: [
        { path: 'src/large.ts' }, { path: 'src/unread.ts' },
      ] }, baseContext({ repoFileProvider }));
      expect(Buffer.byteLength(result.toolOutput, 'utf8')).toBeLessThanOrEqual(REPO_READ_FILE_MAX_CHARS);
      expect(result.toolOutput).not.toContain('\uFFFD');
      expect(result.toolOutput).toContain('BATCH TRUNCATED');
      expect(result.toolOutput).toContain('1 remaining file(s) were not read');
      expect(result.isExhaustive).toBe(false);
      expect(repoFileProvider.readFile).toHaveBeenCalledExactlyOnceWith('src/large.ts');
    });

    it('propagates the original cancellation without advancing to the next file', async () => {
      const controller = new AbortController();
      const repoFileProvider: RepoFileProvider = {
        findFiles: vi.fn(), readFile: vi.fn(async () => { controller.abort(); return 'source'; }),
      };
      await expect(runReadOnlyTool('read_files', { files: [
        { path: 'src/auth/multi.ts' }, { path: 'src/config.ts' },
      ] }, baseContext({ repoFileProvider, signal: controller.signal }))).rejects.toThrow();
      expect(repoFileProvider.readFile).toHaveBeenCalledTimes(1);
    });
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
