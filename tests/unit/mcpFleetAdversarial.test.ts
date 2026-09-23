import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mcpFleetManager } from '../../src/mcp/mcpFleetManager';
import { runReadOnlyTool, type ToolRuntimeContext } from '../../src/panel/toolRuntime';

describe('Adversarial MCP Fleet & Engine Integration Challenge', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const baseContext = (overrides: Partial<ToolRuntimeContext> = {}): ToolRuntimeContext => ({
    changedFiles: [{ path: 'src/core/router.ts', patch: 'export class CoreRouter {}\n' }],
    ...overrides,
  });

  describe('1. Protocol & Network Degradation: HTTP Error Responses', () => {
    const errorStatuses = [
      { status: 400, statusText: 'Bad Request' },
      { status: 401, statusText: 'Unauthorized' },
      { status: 403, statusText: 'Forbidden' },
      { status: 404, statusText: 'Not Found' },
      { status: 500, statusText: 'Internal Server Error' },
      { status: 502, statusText: 'Bad Gateway' },
      { status: 503, statusText: 'Service Unavailable' },
      { status: 504, statusText: 'Gateway Timeout' },
    ];

    for (const { status, statusText } of errorStatuses) {
      it(`gracefully handles HTTP ${status} ${statusText} without crashing`, async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
          new Response(`Server returned ${status} ${statusText}`, {
            status,
            statusText,
            headers: { 'Content-Type': 'text/plain' },
          })
        );

        try {
          const result = await mcpFleetManager.executeTool('ct_impact', { target: 'routes' });

          expect(result.success).toBe(false);
          expect(result.output).toBeNull();
          expect(typeof result.error).toBe('string');
          expect(result.error?.length).toBeGreaterThan(0);
          expect(result.durationMs).toBeGreaterThanOrEqual(0);

          if (status === 401 || status === 403) {
            expect(result.error).toContain('Authentication failed');
          } else {
            expect(result.error).toContain(String(status));
          }
        } finally {
          fetchSpy.mockRestore();
        }
      });
    }
  });

  describe('2. Malformed HTTP Response Bodies & Ambiguous Protocols', () => {
    it('handles HTML 502 error page (Cloudflare/Nginx format) gracefully', async () => {
      const htmlBody = `
        <!DOCTYPE html>
        <html>
        <head><title>502 Bad Gateway</title></head>
        <body bgcolor="white">
        <center><h1>502 Bad Gateway</h1></center>
        <hr><center>cloudflare / nginx</center>
        </body>
        </html>
      `;

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(htmlBody, {
          status: 200, // Some reverse proxies misconfigure 200 with HTML error body
          statusText: 'OK',
          headers: { 'Content-Type': 'text/html' },
        })
      );

      try {
        const result = await mcpFleetManager.executeTool('ct_mesh_stats', {});
        expect(result.success).toBe(false);
        expect(result.output).toBeNull();
        expect(result.error).toBeDefined();
        // SyntaxError from res.json() parsing HTML
        expect(result.error).toMatch(/JSON|Unexpected token/i);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('handles empty response body "" gracefully', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('', {
          status: 200,
          statusText: 'OK',
          headers: { 'Content-Type': 'application/json' },
        })
      );

      try {
        const result = await mcpFleetManager.executeTool('ct_impact', { target: 'routes' });
        expect(result.success).toBe(false);
        expect(result.output).toBeNull();
        expect(result.error).toMatch(/JSON|Unexpected end/i);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('handles truncated / invalid JSON body gracefully', async () => {
      const truncatedJson = '{"jsonrpc": "2.0", "result": {"content": [{"type": "text", "text": "partial...';
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(truncatedJson, {
          status: 200,
          statusText: 'OK',
          headers: { 'Content-Type': 'application/json' },
        })
      );

      try {
        const result = await mcpFleetManager.executeTool('knowledge_search', { query: 'ADR' });
        expect(result.success).toBe(false);
        expect(result.output).toBeNull();
        expect(result.error).toMatch(/JSON|Unexpected/i);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('handles JSON-RPC response containing BOTH result and error', async () => {
      const ambiguousPayload = {
        jsonrpc: '2.0',
        id: 12345,
        result: {
          content: [{ type: 'text', text: JSON.stringify({ status: 'ok' }) }],
        },
        error: {
          code: -32603,
          message: 'Upstream gateway partial failure',
        },
      };

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify(ambiguousPayload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      try {
        const result = await mcpFleetManager.executeTool('ct_impact', { target: 'routes' });
        // The error property must be prioritized to prevent false success on partial failures
        expect(result.success).toBe(false);
        expect(result.output).toBeNull();
        expect(result.error).toBe('Upstream gateway partial failure');
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('handles JSON-RPC response with non-array content gracefully', async () => {
      const nonArrayPayload = {
        jsonrpc: '2.0',
        id: 12345,
        result: {
          content: 'This should have been an array of text objects',
          isError: false,
        },
      };

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify(nonArrayPayload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      try {
        const result = await mcpFleetManager.executeTool('advise_blocker', { blocker_packet: {} });
        expect(result.success).toBe(true);
        expect(result.output).toEqual(nonArrayPayload.result);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('handles JSON-RPC response with non-array content and isError: true', async () => {
      const nonArrayErrorPayload = {
        jsonrpc: '2.0',
        id: 12345,
        result: {
          content: 'Quorum failed to evaluate blocker packet',
          isError: true,
        },
      };

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify(nonArrayErrorPayload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      try {
        const result = await mcpFleetManager.executeTool('advise_blocker', { blocker_packet: {} });
        expect(result.success).toBe(false);
        expect(result.output).toBeNull();
        expect(result.error).toContain('Quorum failed to evaluate blocker packet');
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('handles JSON-RPC response with null body ("null") gracefully without unhandled exception', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('null', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      try {
        const result = await mcpFleetManager.executeTool('health', {});
        expect(result.success).toBe(false);
        expect(result.output).toBeNull();
        expect(result.error).toBeDefined();
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('handles JSON-RPC response with content items lacking text property', async () => {
      const nonTextPayload = {
        jsonrpc: '2.0',
        id: 12345,
        result: {
          content: [{ type: 'binary', data: 'AQIDBA==' }],
        },
      };

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify(nonTextPayload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      try {
        const result = await mcpFleetManager.executeTool('ct_mesh_stats', {});
        expect(result.success).toBe(true);
        expect(result.output).toEqual(nonTextPayload.result);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('handles JSON-RPC response with unexpected array body [1, 2, 3] gracefully', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify([1, 2, 3]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      try {
        const result = await mcpFleetManager.executeTool('ct_mesh_stats', {});
        expect(result.success).toBe(true);
        expect(result.output).toEqual([1, 2, 3]);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('handles JSON-RPC response with boolean body (false) without crashing', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('false', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      try {
        const result = await mcpFleetManager.executeTool('health', {});
        // Safe fall-through without crashing or throwing
        expect(result.durationMs).toBeGreaterThanOrEqual(0);
        expect(result.output).toBe(false);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('handles non-standard string error field in JSON-RPC response', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 999,
            error: 'Direct string error message from proxy',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      try {
        const result = await mcpFleetManager.executeTool('knowledge_search', { query: 'bad' });
        expect(result.success).toBe(false);
        expect(result.output).toBeNull();
        expect(result.error).toBe('Direct string error message from proxy');
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('handles result with isError: true and structured JSON error in content text', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 999,
            result: {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ error: 'ADR-999 not found in governed repository' }),
                },
              ],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      try {
        const result = await mcpFleetManager.executeTool('knowledge_get', { id: 'ADR-999' });
        expect(result.success).toBe(false);
        expect(result.output).toBeNull();
        expect(result.error).toContain('ADR-999 not found');
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  describe('3. Concurrency Stress Test: 50 Concurrent Mixed Tool Executions', () => {
    it('executes 50 concurrent tool calls with interleaved delays with zero race conditions or timer leaks', async () => {
      const toolsToTest = [
        { name: 'ct_impact', params: { target: 'call_manager' } },
        { name: 'knowledge_search', params: { query: 'transcoding' } },
        { name: 'advise_blocker', params: { blocker_packet: { id: 'BP-101' } } },
        { name: 'ct_mesh_query', params: { query: 'ASTNode' } },
        { name: 'ct_mesh_stats', params: {} },
        { name: 'knowledge_get', params: { id: 'ADR-0441' } },
        { name: 'health', params: {} },
      ];

      let inFlightCount = 0;
      let maxInFlightObserved = 0;
      const completedCalls: Array<{ index: number; toolName: string; duration: number; success: boolean }> = [];

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        inFlightCount++;
        if (inFlightCount > maxInFlightObserved) {
          maxInFlightObserved = inFlightCount;
        }

        const body = JSON.parse(String(init?.body || '{}'));
        const callId = body.id;
        const toolName = body.params?.name;
        const toolArgs = body.params?.arguments;

        // Simulate variable network jitter (5ms - 35ms)
        const delayMs = 5 + Math.floor(Math.random() * 30);
        await new Promise((resolve) => setTimeout(resolve, delayMs));

        inFlightCount--;

        // Inject simulated failure for 20% of calls (indices 0, 5, 10, ...)
        const requestIndex = toolArgs?.requestIndex;
        const isFailureCase = typeof requestIndex === 'number' && requestIndex % 5 === 0;

        if (isFailureCase) {
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: callId,
              error: { code: -32000, message: `Simulated gateway overload on ${toolName}` },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: callId,
            result: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    tool: toolName,
                    callId,
                    echoArgs: toolArgs,
                    timestamp: Date.now(),
                  }),
                },
              ],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });

      try {
        const TOTAL_CONCURRENT = 50;
        const promises = Array.from({ length: TOTAL_CONCURRENT }, async (_, i) => {
          const spec = toolsToTest[i % toolsToTest.length];
          const start = Date.now();
          const result = await mcpFleetManager.executeTool(spec.name, {
            ...spec.params,
            requestIndex: i,
          });
          const duration = Date.now() - start;

          completedCalls.push({
            index: i,
            toolName: spec.name,
            duration,
            success: result.success,
          });

          if (result.success) {
            // Verify payload integrity: no cross-talk between concurrent executions
            expect(result.output).toBeDefined();
            expect(result.output.tool).toBe(spec.name);
            expect(result.output.echoArgs.requestIndex).toBe(i);
          } else {
            expect(result.error).toContain('Simulated gateway overload');
          }

          return result;
        });

        const results = await Promise.all(promises);

        // Verification assertions
        expect(results.length).toBe(TOTAL_CONCURRENT);
        expect(completedCalls.length).toBe(TOTAL_CONCURRENT);
        expect(maxInFlightObserved).toBeGreaterThanOrEqual(10); // Proves real parallel fan-out

        const successfulCount = results.filter((r) => r.success).length;
        const failedCount = results.filter((r) => !r.success).length;

        expect(successfulCount).toBeGreaterThan(0);
        expect(failedCount).toBeGreaterThan(0);
        expect(successfulCount + failedCount).toBe(TOTAL_CONCURRENT);

        // Zero in-flight requests remaining at completion
        expect(inFlightCount).toBe(0);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('handles 50 concurrent requests with partial AbortSignal cancellations cleanly', async () => {
      let activeRequests = 0;
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        activeRequests++;
        const signal = init?.signal;
        const body = JSON.parse(String(init?.body || '{}'));

        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            activeRequests--;
            resolve(
              new Response(
                JSON.stringify({
                  jsonrpc: '2.0',
                  id: body.id,
                  result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, tool: body.params?.name }) }] },
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
              )
            );
          }, 30);

          if (signal) {
            signal.addEventListener('abort', () => {
              clearTimeout(timeout);
              activeRequests--;
              const err = new Error('HTTP request aborted by signal');
              err.name = 'AbortError';
              reject(err);
            });
          }
        });
      });

      try {
        const TOTAL = 50;
        const controllers = Array.from({ length: TOTAL }, () => new AbortController());

        // Abort odd-indexed requests after 10ms
        setTimeout(() => {
          controllers.forEach((c, idx) => {
            if (idx % 2 === 1) c.abort();
          });
        }, 10);

        const promises = controllers.map(async (controller, idx) => {
          return runReadOnlyTool(
            'ct_impact',
            { target: `module_${idx}` },
            baseContext({ signal: controller.signal })
          );
        });

        const settledResults = await Promise.allSettled(promises);
        expect(settledResults.length).toBe(TOTAL);

        const fulfilled = settledResults.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>[];
        const rejected = settledResults.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];

        expect(fulfilled.length).toBe(25);
        expect(rejected.length).toBe(25);

        // Fulfilled calls should have correct scope envelope
        for (const item of fulfilled) {
          expect(item.value.toolScope).toBe('cross-repository-ast-mesh');
          expect(item.value.isExhaustive).toBe(true);
        }

        // Rejected calls should be aborted errors
        for (const item of rejected) {
          expect(item.reason).toBeDefined();
        }

        // Allow background fetch operations to drain
        await new Promise((r) => setTimeout(r, 50));
        expect(activeRequests).toBe(0);
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  describe('4. Scope Envelopes & Degradation Hints via toolRuntime', () => {
    it('sets exhaustive: true and correct scope on successful fleet tool execution', async () => {
      const fleetTests = [
        { tool: 'ct_impact', args: { target: 'routes' }, expectedScope: 'cross-repository-ast-mesh' },
        { tool: 'ct_mesh_query', args: { query: 'CoreRouter' }, expectedScope: 'cross-repository-ast-mesh' },
        { tool: 'ct_mesh_stats', args: {}, expectedScope: 'cross-repository-ast-mesh' },
        { tool: 'knowledge_search', args: { query: 'transcoding' }, expectedScope: 'governed-knowledge-adr' },
        { tool: 'knowledge_get', args: { id: 'ADR-0329' }, expectedScope: 'governed-knowledge-adr' },
        { tool: 'advise_blocker', args: { blocker_packet: { type: 'lint' } }, expectedScope: 'policy-blocker-quorum' },
        { tool: 'health', args: {}, expectedScope: 'policy-blocker-quorum' },
      ];

      for (const { tool, args, expectedScope } of fleetTests) {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
          new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              result: {
                content: [{ type: 'text', text: JSON.stringify({ status: 'ok', tool }) }],
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        );

        try {
          const res = await runReadOnlyTool(tool, args, baseContext());
          expect(res.toolScope).toBe(expectedScope);
          expect(res.isExhaustive).toBe(true);
          expect(res.toolOutput).toContain("execution result:");
          expect(res.toolOutput).toContain(tool);
        } finally {
          fetchSpy.mockRestore();
        }
      }
    });

    it('forces isExhaustive: false when fleet tool execution degrades or fails', async () => {
      const fleetTests = [
        { tool: 'ct_impact', args: { target: 'routes' }, expectedScope: 'cross-repository-ast-mesh' },
        { tool: 'knowledge_search', args: { query: 'transcoding' }, expectedScope: 'governed-knowledge-adr' },
        { tool: 'advise_blocker', args: { blocker_packet: { type: 'lint' } }, expectedScope: 'policy-blocker-quorum' },
      ];

      for (const { tool, args, expectedScope } of fleetTests) {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
          new Response('503 Service Unavailable', {
            status: 503,
            statusText: 'Service Unavailable',
          })
        );

        try {
          const res = await runReadOnlyTool(tool, args, baseContext());
          // CRITICAL INVARIANT: Scope is preserved, but isExhaustive MUST be false!
          expect(res.toolScope).toBe(expectedScope);
          expect(res.isExhaustive).toBe(false);
          expect(res.toolOutput).toContain('MCP Error:');
          expect(res.toolOutput).toContain('503');
        } finally {
          fetchSpy.mockRestore();
        }
      }
    });

    it('forces isExhaustive: false when fleet tool throws network exception', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNRESET: socket hang up'));

      try {
        const res = await runReadOnlyTool('knowledge_search', { query: 'ADR-0441' }, baseContext());
        expect(res.toolScope).toBe('governed-knowledge-adr');
        expect(res.isExhaustive).toBe(false);
        expect(res.toolOutput).toContain('MCP Error:');
        expect(res.toolOutput).toContain('ECONNRESET');
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('enforces isExhaustive: false on missing required arguments without executing network call', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      const testCases = [
        { tool: 'ct_mesh_query', args: {}, expectedMsg: "Missing required argument 'query'" },
        { tool: 'knowledge_search', args: { query: '   ' }, expectedMsg: "Missing required argument 'query'" },
        { tool: 'knowledge_get', args: {}, expectedMsg: "Missing required argument 'id'" },
        { tool: 'advise_blocker', args: {}, expectedMsg: "Missing required argument 'blocker_packet'" },
        { tool: 'advise_blocker', args: { blocker_packet: 'not-an-object' }, expectedMsg: "Missing required argument 'blocker_packet'" },
      ];

      for (const { tool, args, expectedMsg } of testCases) {
        const res = await runReadOnlyTool(tool, args, baseContext());
        expect(res.isExhaustive).toBe(false);
        expect(res.toolOutput).toContain(expectedMsg);
      }

      // Proves network call was never invoked
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('strictly denies mutating tools and sets changed-patches-only + isExhaustive: false', async () => {
      const mutatingTools = [
        'memory_record',
        'memory_supersede',
        'memory_retire',
        'linear_close_issue',
        'shell_exec',
        'update_appliance_cli',
        'vm_action',
      ];

      for (const tool of mutatingTools) {
        const res = await runReadOnlyTool(tool, { foo: 'bar' }, baseContext());
        expect(res.isExhaustive).toBe(false);
        expect(res.toolScope).toBe('changed-patches-only');
        expect(res.toolOutput).toContain("Permission denied");
      }
    });

    it('aborts runReadOnlyTool promptly when AbortSignal fires during tool execution', async () => {
      const controller = new AbortController();
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        return new Promise(() => {
          // Never resolves; waits for abort
        });
      });

      // Abort after 20ms
      setTimeout(() => controller.abort(), 20);

      await expect(
        runReadOnlyTool('ct_impact', { target: 'routes' }, baseContext({ signal: controller.signal }))
      ).rejects.toThrow();

      fetchSpy.mockRestore();
    });

    it('immediately rejects if AbortSignal is already aborted prior to runReadOnlyTool', async () => {
      const controller = new AbortController();
      controller.abort();

      await expect(
        runReadOnlyTool('knowledge_search', { query: 'test' }, baseContext({ signal: controller.signal }))
      ).rejects.toThrow();
    });
  });
});
