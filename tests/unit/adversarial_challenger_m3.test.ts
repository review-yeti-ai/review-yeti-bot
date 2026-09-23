import { describe, it, expect, vi, afterEach } from 'vitest';
import { runReadOnlyTool, type ToolRuntimeContext } from '../../src/panel/toolRuntime';
import { mcpFleetManager } from '../../src/mcp/mcpFleetManager';

function baseContext(overrides: Partial<ToolRuntimeContext> = {}): ToolRuntimeContext {
  return {
    changedFiles: [{ path: 'src/billing/service.ts', patch: '+ const x = 1;' }],
    ...overrides,
  };
}

describe('Milestone 3 Adversarial & Critic Stress Suite', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // SUITE 1: Adversarial Tool Names & Mutating Operation Injection
  // =========================================================================
  describe('Adversarial Tool Names & Mutating Operation Prevention', () => {
    const prohibitedToolNames = [
      'memory_record',
      'memory_supersede',
      'memory_retire',
      'linear_close_issue',
      'productlane_ticket',
      'system_exec',
      'exec',
      'spawn',
      'sh',
      'bash',
      'eval',
      'rm',
      'write_file',
      'delete_file',
      'rm -rf /',
      'sh -c "cat /etc/passwd"',
      'ct_impact; rm -rf /',
      'ct_impact/../../etc/passwd',
      '__proto__',
      'constructor',
      'toString',
      'valueOf',
      'hasOwnProperty',
      'CT_IMPACT',
      'Knowledge_Search',
      'ADVISE_BLOCKER',
      'ct_impact ',
      ' ct_impact',
      '\nct_impact',
    ];

    for (const toolName of prohibitedToolNames) {
      it(`reliably blocks adversarial tool name: "${toolName.replace(/\n/g, '\\n')}"`, async () => {
        const executeSpy = vi.spyOn(mcpFleetManager, 'executeTool');

        const result = await runReadOnlyTool(toolName, { query: 'test' }, baseContext());

        expect(result.toolOutput).toMatch(/Permission denied|rejected/i);
        expect(result.isExhaustive).toBe(false);
        expect(executeSpy).not.toHaveBeenCalled();
      });
    }

    it('blocks null, undefined, or non-string tool names gracefully', async () => {
      const executeSpy = vi.spyOn(mcpFleetManager, 'executeTool');

      const nullRes = await runReadOnlyTool(null as any, {}, baseContext());
      expect(nullRes.toolOutput).toMatch(/Permission denied|rejected/i);
      expect(nullRes.isExhaustive).toBe(false);

      const undefRes = await runReadOnlyTool(undefined as any, {}, baseContext());
      expect(undefRes.toolOutput).toMatch(/Permission denied|rejected/i);
      expect(undefRes.isExhaustive).toBe(false);

      const numRes = await runReadOnlyTool(12345 as any, {}, baseContext());
      expect(numRes.toolOutput).toMatch(/Permission denied|rejected/i);

      const objRes = await runReadOnlyTool({ tool: 'ct_impact' } as any, {}, baseContext());
      expect(objRes.toolOutput).toMatch(/Permission denied|rejected/i);

      expect(executeSpy).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // SUITE 2: Malformed, Boundary & Missing Argument Stress
  // =========================================================================
  describe('Malformed & Missing Argument Boundaries', () => {
    it('rejects ct_mesh_query with various malformed query payloads', async () => {
      const executeSpy = vi.spyOn(mcpFleetManager, 'executeTool');

      const badQueries = [
        undefined,
        null,
        '',
        '    ',
        '\t\n',
        123,
        true,
        [],
        {},
        { query: 'nested' },
      ];

      for (const bad of badQueries) {
        const res = await runReadOnlyTool('ct_mesh_query', { query: bad }, baseContext());
        expect(res.toolOutput).toContain("Missing required argument 'query'");
        expect(res.isExhaustive).toBe(false);
        expect(res.toolScope).toBe('cross-repository-ast-mesh');
      }

      expect(executeSpy).not.toHaveBeenCalled();
    });

    it('rejects knowledge_search with empty or whitespace queries', async () => {
      const executeSpy = vi.spyOn(mcpFleetManager, 'executeTool');

      const badQueries = [undefined, null, '', '   ', '\n  \t'];
      for (const bad of badQueries) {
        const res = await runReadOnlyTool('knowledge_search', { query: bad }, baseContext());
        expect(res.toolOutput).toContain("Missing required argument 'query'");
        expect(res.isExhaustive).toBe(false);
        expect(res.toolScope).toBe('governed-knowledge-adr');
      }

      expect(executeSpy).not.toHaveBeenCalled();
    });

    it('rejects knowledge_get with invalid or missing id', async () => {
      const executeSpy = vi.spyOn(mcpFleetManager, 'executeTool');

      const badIds = [undefined, null, '', '   ', 1234, {}, []];
      for (const bad of badIds) {
        const res = await runReadOnlyTool('knowledge_get', { id: bad }, baseContext());
        expect(res.toolOutput).toContain("Missing required argument 'id'");
        expect(res.isExhaustive).toBe(false);
        expect(res.toolScope).toBe('governed-knowledge-adr');
      }

      expect(executeSpy).not.toHaveBeenCalled();
    });

    it('rejects advise_blocker with invalid blocker_packet', async () => {
      const executeSpy = vi.spyOn(mcpFleetManager, 'executeTool');

      const badPackets = [undefined, null, '', 'not an object', 123, true];
      for (const bad of badPackets) {
        const res = await runReadOnlyTool('advise_blocker', { blocker_packet: bad }, baseContext());
        expect(res.toolOutput).toContain("Missing required argument 'blocker_packet'");
        expect(res.isExhaustive).toBe(false);
        expect(res.toolScope).toBe('policy-blocker-quorum');
      }

      expect(executeSpy).not.toHaveBeenCalled();
    });

    it('safely handles undefined args object across all fleet tools', async () => {
      const executeSpy = vi.spyOn(mcpFleetManager, 'executeTool');

      const qRes = await runReadOnlyTool('ct_mesh_query', undefined as any, baseContext());
      expect(qRes.toolOutput).toContain("Missing required argument 'query'");

      const ksRes = await runReadOnlyTool('knowledge_search', null as any, baseContext());
      expect(ksRes.toolOutput).toContain("Missing required argument 'query'");

      const kgRes = await runReadOnlyTool('knowledge_get', undefined as any, baseContext());
      expect(kgRes.toolOutput).toContain("Missing required argument 'id'");

      const abRes = await runReadOnlyTool('advise_blocker', null as any, baseContext());
      expect(abRes.toolOutput).toContain("Missing required argument 'blocker_packet'");

      expect(executeSpy).not.toHaveBeenCalled();
    });

    it('passes huge valid argument strings safely to executeTool without blowing stack', async () => {
      const hugeQuery = 'A'.repeat(50_000);
      const executeSpy = vi.spyOn(mcpFleetManager, 'executeTool').mockResolvedValue({
        success: true,
        output: { matches: [] },
        durationMs: 10,
      });

      const res = await runReadOnlyTool('knowledge_search', { query: hugeQuery }, baseContext());
      expect(res.toolOutput).toContain('matches');
      expect(res.isExhaustive).toBe(true);
      expect(executeSpy).toHaveBeenCalledWith('knowledge_search', { query: hugeQuery });
    });
  });

  // =========================================================================
  // SUITE 3: Bifrost Gateway Failure Modes & Non-Fatal Degradation
  // =========================================================================
  describe('Bifrost Gateway Failure Modes & Graceful Degradation', () => {
    const errorStatuses = [500, 502, 503, 504, 401, 403, 404, 429];

    for (const status of errorStatuses) {
      it(`degrades gracefully without throwing when Bifrost returns HTTP ${status}`, async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
          return new Response(JSON.stringify({ error: `Server error ${status}` }), {
            status,
            statusText: `Error ${status}`,
            headers: { 'Content-Type': 'application/json' },
          });
        });

        try {
          const res = await runReadOnlyTool('ct_impact', { target: 'routes' }, baseContext());
          expect(res.toolOutput).toContain('MCP Error:');
          expect(res.isExhaustive).toBe(false);
          expect(res.toolScope).toBe('cross-repository-ast-mesh');
        } finally {
          fetchSpy.mockRestore();
        }
      });
    }

    it('handles Bifrost returning non-JSON HTML error page (e.g. cloudflare 502)', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        return new Response('<html><head><title>502 Bad Gateway</title></head><body>502 Bad Gateway</body></html>', {
          status: 502,
          statusText: 'Bad Gateway',
          headers: { 'Content-Type': 'text/html' },
        });
      });

      try {
        const res = await runReadOnlyTool('ct_mesh_stats', {}, baseContext());
        expect(res.toolOutput).toContain('MCP Error:');
        expect(res.isExhaustive).toBe(false);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('handles Bifrost returning completely empty response body', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        return new Response('', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      try {
        const res = await runReadOnlyTool('ct_mesh_stats', {}, baseContext());
        expect(res.toolOutput).toContain('MCP Error:');
        expect(res.isExhaustive).toBe(false);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('handles Bifrost returning JSON-RPC protocol error object', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            error: { code: -32603, message: 'Internal RPC execution error' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });

      try {
        const res = await runReadOnlyTool('ct_mesh_query', { query: 'UserRouter' }, baseContext());
        expect(res.toolOutput).toContain('Internal RPC execution error');
        expect(res.isExhaustive).toBe(false);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('handles Bifrost returning MCP result with isError: true and empty content', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { isError: true },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });

      try {
        const res = await runReadOnlyTool('advise_blocker', { blocker_packet: { id: 'B-1' } }, baseContext());
        expect(res.toolOutput).toContain('MCP Error:');
        expect(res.isExhaustive).toBe(false);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('handles network ECONNREFUSED without unhandled rejection', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        const err = new TypeError('fetch failed');
        (err as any).cause = { code: 'ECONNREFUSED', syscall: 'connect' };
        throw err;
      });

      try {
        const res = await runReadOnlyTool('ct_impact', { target: 'routes' }, baseContext());
        expect(res.toolOutput).toContain('MCP Error: fetch failed');
        expect(res.isExhaustive).toBe(false);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('handles execution timeout in mcpFleetManager without leaving hanging promises', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const abortErr = new Error('This operation was aborted');
            abortErr.name = 'AbortError';
            reject(abortErr);
          });
        });
      });

      try {
        // Execute with a very short timeout
        const res = await mcpFleetManager.executeTool('ct_impact', { target: 'routes' }, { timeoutMs: 25 });
        expect(res.success).toBe(false);
        expect(res.error).toMatch(/timed out/i);
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  // =========================================================================
  // SUITE 4: Concurrency, AbortSignal & Scope Invariants
  // =========================================================================
  describe('Concurrency, AbortSignal & Scope Envelopes', () => {
    it('executes 25 parallel fleet tool calls cleanly without cross-talk', async () => {
      let callIndex = 0;
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        const body = JSON.parse(String(init?.body || '{}'));
        const idx = ++callIndex;
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ query: body.params.arguments.query, index: idx }),
                },
              ],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });

      try {
        const tasks = Array.from({ length: 25 }, (_, i) =>
          runReadOnlyTool('ct_mesh_query', { query: `query_${i}` }, baseContext())
        );

        const results = await Promise.all(tasks);
        expect(results).toHaveLength(25);
        for (let i = 0; i < 25; i++) {
          expect(results[i].toolOutput).toContain(`query_${i}`);
          expect(results[i].toolScope).toBe('cross-repository-ast-mesh');
          expect(results[i].isExhaustive).toBe(true);
        }
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('aborts cleanly when panel AbortSignal is pre-aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      await expect(
        runReadOnlyTool('ct_impact', { target: 'routes' }, baseContext({ signal: controller.signal }))
      ).rejects.toThrow();
    });

    it('verifies exact scope classification for all 7 fleet tools', async () => {
      vi.spyOn(mcpFleetManager, 'executeTool').mockResolvedValue({
        success: true,
        output: { status: 'ok' },
        durationMs: 5,
      });

      // AST mesh tools
      const r1 = await runReadOnlyTool('ct_impact', {}, baseContext());
      expect(r1.toolScope).toBe('cross-repository-ast-mesh');

      const r2 = await runReadOnlyTool('ct_mesh_query', { query: 'sym' }, baseContext());
      expect(r2.toolScope).toBe('cross-repository-ast-mesh');

      const r3 = await runReadOnlyTool('ct_mesh_stats', {}, baseContext());
      expect(r3.toolScope).toBe('cross-repository-ast-mesh');

      // Knowledge tools
      const r4 = await runReadOnlyTool('knowledge_search', { query: 'adr' }, baseContext());
      expect(r4.toolScope).toBe('governed-knowledge-adr');

      const r5 = await runReadOnlyTool('knowledge_get', { id: 'ADR-1' }, baseContext());
      expect(r5.toolScope).toBe('governed-knowledge-adr');

      // Policy tools
      const r6 = await runReadOnlyTool('advise_blocker', { blocker_packet: {} }, baseContext());
      expect(r6.toolScope).toBe('policy-blocker-quorum');

      const r7 = await runReadOnlyTool('health', {}, baseContext());
      expect(r7.toolScope).toBe('policy-blocker-quorum');
    });
  });
});
