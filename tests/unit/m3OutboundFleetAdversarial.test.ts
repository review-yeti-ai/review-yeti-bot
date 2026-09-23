import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runReadOnlyTool, type ToolRuntimeContext } from '../../src/panel/toolRuntime';
import { mcpFleetManager, McpFleetManager } from '../../src/mcp/mcpFleetManager';
import { PanelCancellationError } from '../../src/panel/panelEngine';

describe('Milestone 3 Outbound Fleet MCP Federation — Adversarial Challenge Suite', () => {
  const baseContext = (overrides: Partial<ToolRuntimeContext> = {}): ToolRuntimeContext => ({
    changedFiles: [{ path: 'src/gateway/bifrost.ts', patch: '+export const gateway = true;\n' }],
    ...overrides,
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // =========================================================================
  // Section 1: Mutation Blockade Stress Testing
  // =========================================================================
  describe('Section 1: Mutation Blockade Stress Testing', () => {
    const mutatingTools = [
      'memory_record',
      'memory_supersede',
      'memory_request_promotion',
      'memory_retire',
      'deploy_service',
      'reboot_host',
      'linear_close_issue',
      'write_file',
      'delete_file',
      'shell_exec',
      'bash',
      'exec',
      'eval',
      'k8s_delete_pod',
      'cube_exec',
      'factory_reset_appliance',
    ];

    it.each(mutatingTools)('blocks %s immediately with Permission denied and zero dispatch', async (toolName) => {
      const executeToolSpy = vi.spyOn(mcpFleetManager, 'executeTool');
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      const result = await runReadOnlyTool(
        toolName,
        {
          command: 'rm -rf /',
          payload: { action: 'destroy' },
          target: 'production',
        },
        baseContext(),
      );

      // Verify Permission Denied contract
      expect(result.toolOutput).toContain(
        `Tool '${toolName}' execution rejected: Permission denied. Reviewer personas are restricted strictly to read-only code, search, and MCP tools.`,
      );
      expect(result.toolScope).toBe('changed-patches-only');
      expect(result.isExhaustive).toBe(false);

      // Verify zero server or network dispatch
      expect(executeToolSpy).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    describe('Evasion & Bypass Attempts', () => {
      const evasiveToolNames = [
        'MEMORY_RECORD',
        'Memory_Record',
        ' memory_record ',
        '\tlinear_close_issue\n',
        '../memory_record',
        'ct_impact/../memory_record',
        'ct_impact; rm -rf /',
        'ct_impact && memory_record',
        '__proto__',
        'constructor',
        'toString',
        'valueOf',
        'hasOwnProperty',
        'ct_impact*',
        'knowledge_*',
      ];

      it.each(evasiveToolNames)('rejects evasive tool name variant: %j without dispatch', async (evasionName) => {
        const executeToolSpy = vi.spyOn(mcpFleetManager, 'executeTool');
        const fetchSpy = vi.spyOn(globalThis, 'fetch');

        const result = await runReadOnlyTool(evasionName, { foo: 'bar' }, baseContext());

        expect(result.toolOutput).toContain("execution rejected: Permission denied");
        expect(result.toolScope).toBe('changed-patches-only');
        expect(result.isExhaustive).toBe(false);
        expect(executeToolSpy).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
      });
    });
  });

  // =========================================================================
  // Section 2: Input Edge Cases & Fuzzing
  // =========================================================================
  describe('Section 2: Input Edge Cases & Fuzzing', () => {
    describe('Pre-validation Rejection on Required Arguments', () => {
      const fuzzedInvalidQueries = [
        null,
        undefined,
        '',
        '   ',
        '\n\t\r  ',
        12345,
        false,
        true,
        NaN,
        ['query1', 'query2'],
        { nested: 'object' },
      ];

      it.each(fuzzedInvalidQueries)('rejects ct_mesh_query with invalid query: %j', async (invalidQuery) => {
        const executeToolSpy = vi.spyOn(mcpFleetManager, 'executeTool');
        const args = invalidQuery === undefined ? {} : { query: invalidQuery };

        const result = await runReadOnlyTool('ct_mesh_query', args, baseContext());

        expect(result.toolOutput).toBe(
          "Tool 'ct_mesh_query' execution rejected: Missing required argument 'query'.",
        );
        expect(result.toolScope).toBe('cross-repository-ast-mesh');
        expect(result.isExhaustive).toBe(false);
        expect(executeToolSpy).not.toHaveBeenCalled();
      });

      it.each(fuzzedInvalidQueries)('rejects knowledge_search with invalid query: %j', async (invalidQuery) => {
        const executeToolSpy = vi.spyOn(mcpFleetManager, 'executeTool');
        const args = invalidQuery === undefined ? {} : { query: invalidQuery };

        const result = await runReadOnlyTool('knowledge_search', args, baseContext());

        expect(result.toolOutput).toBe(
          "Tool 'knowledge_search' execution rejected: Missing required argument 'query'.",
        );
        expect(result.toolScope).toBe('governed-knowledge-adr');
        expect(result.isExhaustive).toBe(false);
        expect(executeToolSpy).not.toHaveBeenCalled();
      });

      const fuzzedInvalidIds = [
        null,
        undefined,
        '',
        '   ',
        '\n  \t',
        999,
        true,
        ['ADR-001'],
        { id: 'ADR-001' },
      ];

      it.each(fuzzedInvalidIds)('rejects knowledge_get with invalid id: %j', async (invalidId) => {
        const executeToolSpy = vi.spyOn(mcpFleetManager, 'executeTool');
        const args = invalidId === undefined ? {} : { id: invalidId };

        const result = await runReadOnlyTool('knowledge_get', args, baseContext());

        expect(result.toolOutput).toBe(
          "Tool 'knowledge_get' execution rejected: Missing required argument 'id'.",
        );
        expect(result.toolScope).toBe('governed-knowledge-adr');
        expect(result.isExhaustive).toBe(false);
        expect(executeToolSpy).not.toHaveBeenCalled();
      });

      const fuzzedInvalidBlockerPackets = [
        null,
        undefined,
        '',
        'non-object-string',
        12345,
        true,
        false,
      ];

      it.each(fuzzedInvalidBlockerPackets)('rejects advise_blocker with invalid blocker_packet: %j', async (invalidPacket) => {
        const executeToolSpy = vi.spyOn(mcpFleetManager, 'executeTool');
        const args = invalidPacket === undefined ? {} : { blocker_packet: invalidPacket };

        const result = await runReadOnlyTool('advise_blocker', args, baseContext());

        expect(result.toolOutput).toBe(
          "Tool 'advise_blocker' execution rejected: Missing required argument 'blocker_packet'.",
        );
        expect(result.toolScope).toBe('policy-blocker-quorum');
        expect(result.isExhaustive).toBe(false);
        expect(executeToolSpy).not.toHaveBeenCalled();
      });
    });

    describe('Extreme Payloads & Structural Stress', () => {
      it('safely handles 100KB string payload in ct_mesh_query without crashing or truncation errors', async () => {
        const massiveQuery = 'AST_NODE_'.repeat(10240); // > 100KB string
        const mockResponse = {
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: [{ type: 'text', text: JSON.stringify({ matches: 42, sample: 'ASTNode' }) }],
          },
        };

        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
          new Response(JSON.stringify(mockResponse), { status: 200, headers: { 'Content-Type': 'application/json' } }),
        );

        const result = await runReadOnlyTool('ct_mesh_query', { query: massiveQuery }, baseContext());

        expect(result.toolScope).toBe('cross-repository-ast-mesh');
        expect(result.isExhaustive).toBe(true);
        expect(result.toolOutput).toContain('"matches": 42');
        expect(fetchSpy).toHaveBeenCalled();
      });

      it('safely handles 100KB string payload in knowledge_get id', async () => {
        const massiveId = 'ADR_'.repeat(25600); // > 100KB
        const mockResponse = {
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: [{ type: 'text', text: 'ADR document contents' }],
          },
        };

        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
          new Response(JSON.stringify(mockResponse), { status: 200, headers: { 'Content-Type': 'application/json' } }),
        );

        const result = await runReadOnlyTool('knowledge_get', { id: massiveId }, baseContext());

        expect(result.toolScope).toBe('governed-knowledge-adr');
        expect(result.isExhaustive).toBe(true);
        expect(result.toolOutput).toContain('ADR document contents');
        expect(fetchSpy).toHaveBeenCalled();
      });

      it('safely handles 50-level deeply nested object in advise_blocker blocker_packet without call-stack overflow', async () => {
        let nestedObj: any = { leaf: 'deep_value' };
        for (let i = 0; i < 50; i++) {
          nestedObj = { level: i, child: nestedObj };
        }

        const mockResponse = {
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: [{ type: 'text', text: JSON.stringify({ consensus: 'SHIP', blockers_remaining: 0 }) }],
          },
        };

        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
          new Response(JSON.stringify(mockResponse), { status: 200, headers: { 'Content-Type': 'application/json' } }),
        );

        const result = await runReadOnlyTool('advise_blocker', { blocker_packet: nestedObj }, baseContext());

        expect(result.toolScope).toBe('policy-blocker-quorum');
        expect(result.isExhaustive).toBe(true);
        expect(result.toolOutput).toContain('SHIP');
        expect(fetchSpy).toHaveBeenCalled();
      });

      it('safely catches circular references in arguments without crashing the process', async () => {
        const circularArgs: any = { target: 'routes' };
        circularArgs.self = circularArgs;

        const result = await runReadOnlyTool('ct_impact', circularArgs, baseContext());

        expect(result.toolOutput).toContain('MCP Error:');
        expect(result.toolOutput).toMatch(/circular structure|Converting circular/i);
        expect(result.toolScope).toBe('cross-repository-ast-mesh');
        expect(result.isExhaustive).toBe(false);
      });
    });

    describe('Prototype Pollution Resistance', () => {
      it('prevents prototype pollution when args contain __proto__ or constructor payloads', async () => {
        const pollutedPayload = JSON.parse('{"__proto__":{"polluted":true},"query":"security_check"}');
        const constructorPayload = JSON.parse('{"constructor":{"prototype":{"pollutedConstructor":true}},"id":"ADR-100"}');

        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
          new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              result: { content: [{ type: 'text', text: 'ok' }] },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );

        await runReadOnlyTool('ct_mesh_query', pollutedPayload, baseContext());
        await runReadOnlyTool('knowledge_get', constructorPayload, baseContext());

        // Verify global Object prototype remains unpolluted
        expect((Object.prototype as any).polluted).toBeUndefined();
        expect((Object.prototype as any).pollutedConstructor).toBeUndefined();
        expect(({} as any).polluted).toBeUndefined();
      });
    });

    describe('Malformed & Adversarial Gateway Response Handling', () => {
      it('handles non-JSON HTML error page (e.g. 500 Bad Gateway HTML) gracefully', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
          new Response('<html><body>500 Internal Server Error</body></html>', {
            status: 500,
            statusText: 'Internal Server Error',
            headers: { 'Content-Type': 'text/html' },
          }),
        );

        const result = await runReadOnlyTool('ct_impact', { target: 'routes' }, baseContext());

        expect(result.toolOutput).toContain('MCP Error:');
        expect(result.toolOutput).toContain('500 Internal Server Error');
        expect(result.toolScope).toBe('cross-repository-ast-mesh');
        expect(result.isExhaustive).toBe(false);
      });

      it('handles malformed JSON body from HTTP 200 response without uncaught crash', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
          new Response('{"jsonrpc": "2.0", broken_json: ', {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );

        const result = await runReadOnlyTool('health', {}, baseContext());

        expect(result.toolOutput).toContain('MCP Error:');
        expect(result.toolScope).toBe('policy-blocker-quorum');
        expect(result.isExhaustive).toBe(false);
      });

      it('handles empty content array in successful JSON-RPC result', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
          new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              result: { content: [] },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );

        const result = await runReadOnlyTool('ct_mesh_stats', {}, baseContext());

        expect(result.toolScope).toBe('cross-repository-ast-mesh');
        expect(result.isExhaustive).toBe(true);
        expect(result.toolOutput).toContain('"content": []');
      });

      it('handles null result field in JSON-RPC payload gracefully without crashing', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
          new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              result: null,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );

        const result = await runReadOnlyTool('health', {}, baseContext());

        expect(result.toolScope).toBe('policy-blocker-quorum');
        expect(result.isExhaustive).toBe(false);
        expect(result.toolOutput).toContain('MCP Error:');
      });

      it('handles unhandled network socket drop (TypeError: fetch failed)', async () => {
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed: ECONNRESET'));

        const result = await runReadOnlyTool('ct_impact', { target: 'routes' }, baseContext());

        expect(result.toolOutput).toContain('MCP Error: fetch failed: ECONNRESET');
        expect(result.toolScope).toBe('cross-repository-ast-mesh');
        expect(result.isExhaustive).toBe(false);
      });
    });
  });

  // =========================================================================
  // Section 3: Timeout & Abort Mechanics
  // =========================================================================
  describe('Section 3: Timeout & Abort Mechanics', () => {
    it('cleanly enforces 15,000ms timeout on hanging MCP tool execution without stalling the process', async () => {
      vi.useFakeTimers();

      // Simulate an infinite hanging promise in executeTool
      vi.spyOn(mcpFleetManager, 'executeTool').mockImplementation(
        () => new Promise(() => { /* never resolves */ }),
      );

      const toolPromise = runReadOnlyTool('ct_impact', { target: 'routes' }, baseContext());

      // Advance by 14,999ms - should still be pending
      await vi.advanceTimersByTimeAsync(14_999);

      // Advance past 15,000ms boundary
      await vi.advanceTimersByTimeAsync(2);

      const result = await toolPromise;

      expect(result.toolOutput).toContain('MCP Error: Tool execution timed out after 15000ms.');
      expect(result.toolScope).toBe('cross-repository-ast-mesh');
      expect(result.isExhaustive).toBe(false);
    });

    it('enforces HTTP transport AbortController timeout in McpFleetManager', async () => {
      // Simulate hanging fetch that only aborts when signal triggered
      vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
        const signal = init?.signal;
        return new Promise((_resolve, reject) => {
          if (signal) {
            signal.addEventListener('abort', () => {
              const err = new Error('HTTP request timed out after 50ms');
              err.name = 'AbortError';
              reject(err);
            });
          }
        });
      });

      const result = await mcpFleetManager.executeTool('ct_impact', { target: 'timeout_test' }, { timeoutMs: 50 });

      expect(result.success).toBe(false);
      expect(result.error).toContain('HTTP request timed out after 50ms');
      expect(result.output).toBeNull();
    });

    it('propagates caller AbortSignal cancellation immediately and throws PanelCancellationError', async () => {
      const controller = new AbortController();

      // Hanging executeTool
      vi.spyOn(mcpFleetManager, 'executeTool').mockImplementation(
        () => new Promise(() => { /* never resolves */ }),
      );

      const toolPromise = runReadOnlyTool(
        'ct_impact',
        { target: 'routes' },
        baseContext({ signal: controller.signal }),
      );

      // Abort the signal mid-execution
      controller.abort(new PanelCancellationError('Review panel stopped by caller'));

      await expect(toolPromise).rejects.toThrow(PanelCancellationError);
      await expect(toolPromise).rejects.toThrow('Review panel stopped by caller');
    });

    it('immediately rejects pre-aborted signal with PanelCancellationError without waiting for timeout', async () => {
      const controller = new AbortController();
      controller.abort(new PanelCancellationError('Pre-aborted before invocation'));

      // Simulate a hanging promise that would take forever if not aborted
      vi.spyOn(mcpFleetManager, 'executeTool').mockImplementation(
        () => new Promise(() => { /* never resolves */ }),
      );

      const start = Date.now();
      await expect(
        runReadOnlyTool(
          'ct_impact',
          { target: 'routes' },
          baseContext({ signal: controller.signal }),
        ),
      ).rejects.toThrow(PanelCancellationError);

      // Must reject immediately without waiting for 15,000ms timeout
      expect(Date.now() - start).toBeLessThan(500);
    });

    it('immediately rejects pre-aborted signal even on disallowed mutating tools without leak', async () => {
      const controller = new AbortController();
      controller.abort(new PanelCancellationError('Aborted before mutation'));

      const executeToolSpy = vi.spyOn(mcpFleetManager, 'executeTool');

      await expect(
        runReadOnlyTool(
          'memory_record',
          { memory: 'adversarial' },
          baseContext({ signal: controller.signal }),
        ),
      ).rejects.toThrow(PanelCancellationError);

      expect(executeToolSpy).not.toHaveBeenCalled();
    });
  });
});
