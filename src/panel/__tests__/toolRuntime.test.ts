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
    it('returns changed-patches-only scope for a file present in the diff', async () => {
      const result = await runReadOnlyTool('read_file', { path: 'src/auth/multi.ts' }, baseContext());
      expect(result).toEqual({
        toolOutput: "Tool 'read_file' execution result:\nexport function login() {}\n",
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
        "Tool 'read_file' execution result:\nLines 2-3 of 4 for 'src/auth/multi.ts':\nline 2: important logic\nline 3: edge case",
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
      const result = await runReadOnlyTool('get_diff', { path: 'src/missing.ts' }, baseContext({ repoFileProvider }));
      expect(result).toEqual({
        toolOutput: "Tool 'get_diff' execution result:\nFile 'src/missing.ts' does not exist in the repository at the reviewed head (checked the full repository tree, not just the diff).",
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
