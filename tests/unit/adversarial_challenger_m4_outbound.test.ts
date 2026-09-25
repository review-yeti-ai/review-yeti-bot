/**
 * Milestone 4 Challenger 2 Empirical Stress & Adversarial Hardening Suite
 *
 * Dedicated verification and adversarial stress tests targeting:
 * 1. Stdio process termination without JSON-RPC response (real child processes)
 *    - Process exits code 0 with empty stdout -> fails closed, no false positive
 *    - Process outputs non-JSON logs only -> fails closed
 *    - Process outputs JSON lacking result/error -> fails closed
 *    - Process missing command -> fails closed
 *    - Process succeeds with valid JSON-RPC amidst noise -> correctly unwraps
 * 2. AbortSignal propagation (stdio & HTTP)
 *    - Pre-aborted signal -> fails immediately
 *    - Mid-execution abort of stdio child process -> sends SIGKILL, cleans up, reports aborted
 *    - Mid-execution abort of HTTP fetch -> controller.abort triggered, reports aborted
 *    - TimeoutMs enforcement on HTTP fetch -> reports timeout error
 * 3. Local parameter validation in toolRuntime.ts
 *    - ct_impact missing target, target_file, and query -> rejected before network
 *    - ct_impact empty string or whitespace-only target -> rejected before network
 *    - ct_impact non-string target -> rejected before network
 *    - ct_impact valid target / target_file / query -> accepted and dispatched
 *    - ct_mesh_query, knowledge_search, knowledge_get, advise_blocker validation
 * 4. Outbound Fleet MCP Federation and Review Engine Concurrency
 *    - High-concurrency burst across diverse fleet tools without state cross-talk
 *    - Semaphore ceiling enforcement under burst
 *    - Fault isolation during tool failure or timeout
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mcpFleetManager, McpFleetManager } from '../../src/mcp/mcpFleetManager';
import { runReadOnlyTool, type ToolRuntimeContext } from '../../src/panel/toolRuntime';
import { processPersonaLimiter, MAX_CONCURRENT_PERSONAS } from '../../src/panel/panelEngine';

function baseContext(overrides: Partial<ToolRuntimeContext> = {}): ToolRuntimeContext {
  return {
    changedFiles: [{ path: 'src/billing/service.ts', patch: '+ const x = 1;' }],
    ...overrides,
  };
}

describe('Milestone 4 Challenger 2 — Outbound Fleet & Concurrency Stress Suite', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // SECTION 1: Stdio Process Termination Without JSON-RPC Response (Real OS Processes)
  // =========================================================================
  describe('Section 1: Stdio Process Termination Without JSON-RPC Response (Real OS Processes)', () => {
    it('TC-CHAL2-STDIO-01: returns error when real stdio process exits with empty stdout (zero output)', async () => {
      const serverId = `stdio_real_empty_${Date.now()}`;
      await mcpFleetManager.registerServer({
        id: serverId,
        name: 'Empty Stdio Server',
        transport: 'stdio',
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
        enabled: true,
        status: 'online',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      (mcpFleetManager as any).toolRegistry.set('test_empty_tool', {
        serverId,
        name: 'test_empty_tool',
        description: 'Test empty stdio',
        inputSchema: {},
      });

      const result = await mcpFleetManager.executeTool('test_empty_tool', {});

      expect(result.success).toBe(false);
      expect(result.output).toBeNull();
      expect(result.error).toBe('Stdio process exited without emitting JSON-RPC response');

      await mcpFleetManager.unregisterServer(serverId);
    });

    it('TC-CHAL2-STDIO-02: returns error when real stdio process exits with non-JSON debug logs only', async () => {
      const serverId = `stdio_real_logs_${Date.now()}`;
      await mcpFleetManager.registerServer({
        id: serverId,
        name: 'Logs Stdio Server',
        transport: 'stdio',
        command: process.execPath,
        args: [
          '-e',
          'console.log("INFO: Service booting..."); console.log("DEBUG: DB pool ready"); console.error("WARN: Clean exit"); process.exit(0);',
        ],
        enabled: true,
        status: 'online',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      (mcpFleetManager as any).toolRegistry.set('test_logs_tool', {
        serverId,
        name: 'test_logs_tool',
        description: 'Test logs stdio',
        inputSchema: {},
      });

      const result = await mcpFleetManager.executeTool('test_logs_tool', {});

      expect(result.success).toBe(false);
      expect(result.output).toBeNull();
      expect(result.error).toBe('Stdio process exited without emitting JSON-RPC response');

      await mcpFleetManager.unregisterServer(serverId);
    });

    it('TC-CHAL2-STDIO-03: returns error when real stdio process outputs valid JSON that lacks result/error fields', async () => {
      const serverId = `stdio_real_no_fields_${Date.now()}`;
      await mcpFleetManager.registerServer({
        id: serverId,
        name: 'No Fields Stdio Server',
        transport: 'stdio',
        command: process.execPath,
        args: [
          '-e',
          'console.log(JSON.stringify({ jsonrpc: "2.0", id: 1, ping: "pong", payload: { count: 99 } })); process.exit(0);',
        ],
        enabled: true,
        status: 'online',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      (mcpFleetManager as any).toolRegistry.set('test_no_fields_tool', {
        serverId,
        name: 'test_no_fields_tool',
        description: 'Test no fields stdio',
        inputSchema: {},
      });

      const result = await mcpFleetManager.executeTool('test_no_fields_tool', {});

      expect(result.success).toBe(false);
      expect(result.output).toBeNull();
      expect(result.error).toBe('Stdio process exited without emitting JSON-RPC response');

      await mcpFleetManager.unregisterServer(serverId);
    });

    it('TC-CHAL2-STDIO-04: returns error immediately when stdio server has no command configured', async () => {
      const serverId = `stdio_real_no_cmd_${Date.now()}`;
      await mcpFleetManager.registerServer({
        id: serverId,
        name: 'No Command Stdio Server',
        transport: 'stdio',
        command: '',
        enabled: true,
        status: 'online',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      (mcpFleetManager as any).toolRegistry.set('test_no_cmd_tool', {
        serverId,
        name: 'test_no_cmd_tool',
        description: 'Test no cmd stdio',
        inputSchema: {},
      });

      const result = await mcpFleetManager.executeTool('test_no_cmd_tool', {});

      expect(result.success).toBe(false);
      expect(result.output).toBeNull();
      expect(result.error).toBe('Stdio transport requires command');

      await mcpFleetManager.unregisterServer(serverId);
    });

    it('TC-CHAL2-STDIO-05: correctly unwraps valid JSON-RPC result when valid result line exists amidst noise', async () => {
      const serverId = `stdio_real_valid_${Date.now()}`;
      await mcpFleetManager.registerServer({
        id: serverId,
        name: 'Valid Stdio Server',
        transport: 'stdio',
        command: process.execPath,
        args: [
          '-e',
          'console.log("Debug banner: Welcome"); console.log(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { success: true, count: 42 } })); console.log("Trailing cleanup message"); process.exit(0);',
        ],
        enabled: true,
        status: 'online',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      (mcpFleetManager as any).toolRegistry.set('test_valid_tool', {
        serverId,
        name: 'test_valid_tool',
        description: 'Test valid stdio',
        inputSchema: {},
      });

      const result = await mcpFleetManager.executeTool('test_valid_tool', {});

      expect(result.success).toBe(true);
      expect(result.output).toEqual({ success: true, count: 42 });

      await mcpFleetManager.unregisterServer(serverId);
    });

    it('TC-CHAL2-STDIO-06: returns structured error when stdio process emits JSON-RPC error response', async () => {
      const serverId = `stdio_real_rpc_err_${Date.now()}`;
      await mcpFleetManager.registerServer({
        id: serverId,
        name: 'RPC Err Stdio Server',
        transport: 'stdio',
        command: process.execPath,
        args: [
          '-e',
          'console.log(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "Permission denied for internal tool" } })); process.exit(0);',
        ],
        enabled: true,
        status: 'online',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      (mcpFleetManager as any).toolRegistry.set('test_rpc_err_tool', {
        serverId,
        name: 'test_rpc_err_tool',
        description: 'Test rpc err stdio',
        inputSchema: {},
      });

      const result = await mcpFleetManager.executeTool('test_rpc_err_tool', {});

      expect(result.success).toBe(false);
      expect(result.output).toBeNull();
      expect(result.error).toBe('Permission denied for internal tool');

      await mcpFleetManager.unregisterServer(serverId);
    });
  });

  // =========================================================================
  // SECTION 2: AbortSignal Propagation (Real OS Processes & Network)
  // =========================================================================
  describe('Section 2: AbortSignal Propagation (Real OS Processes & Network)', () => {
    it('TC-CHAL2-ABT-01: aborts stdio process immediately when pre-aborted signal is provided', async () => {
      const serverId = `stdio_preabort_${Date.now()}`;
      await mcpFleetManager.registerServer({
        id: serverId,
        name: 'Preabort Stdio Server',
        transport: 'stdio',
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
        enabled: true,
        status: 'online',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      (mcpFleetManager as any).toolRegistry.set('test_preabort_tool', {
        serverId,
        name: 'test_preabort_tool',
        description: 'Test preabort stdio',
        inputSchema: {},
      });

      const controller = new AbortController();
      controller.abort();

      const result = await mcpFleetManager.executeTool('test_preabort_tool', {}, { signal: controller.signal });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Operation aborted');

      await mcpFleetManager.unregisterServer(serverId);
    });

    it('TC-CHAL2-ABT-02: kills real running stdio child process when signal aborts mid-execution', async () => {
      const serverId = `stdio_midabort_${Date.now()}`;
      // Node script that responds to tools/list immediately on registration, but hangs on tools/call
      const serverScript = `
        const readline = require('readline');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
        rl.on('line', (line) => {
          try {
            const req = JSON.parse(line.trim());
            if (req.method === 'tools/list') {
              console.log(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { tools: [{ name: 'test_midabort_tool' }] } }));
            } else if (req.method === 'tools/call') {
              // Intentionally hang until killed
              setInterval(() => {}, 10000);
            }
          } catch (e) {}
        });
      `;

      await mcpFleetManager.registerServer({
        id: serverId,
        name: 'Midabort Stdio Server',
        transport: 'stdio',
        command: process.execPath,
        args: ['-e', serverScript],
        enabled: true,
        status: 'online',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const controller = new AbortController();
      const executePromise = mcpFleetManager.executeTool('test_midabort_tool', {}, { signal: controller.signal });

      // Trigger abort after 100ms while child process is hanging
      setTimeout(() => {
        controller.abort();
      }, 100);

      const result = await executePromise;

      expect(result.success).toBe(false);
      expect(result.error).toBe('Operation aborted');

      await mcpFleetManager.unregisterServer(serverId);
    });

    it('TC-CHAL2-ABT-03: aborts HTTP request immediately and reports Operation aborted when signal is triggered', async () => {
      const controller = new AbortController();

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        return new Promise((_, reject) => {
          if (init?.signal) {
            init.signal.addEventListener('abort', () => {
              const abortErr = new Error('The operation was aborted');
              abortErr.name = 'AbortError';
              reject(abortErr);
            });
          }
        });
      });

      const execPromise = mcpFleetManager.executeTool('ct_impact', { target: 'routes' }, { signal: controller.signal });

      setTimeout(() => {
        controller.abort();
      }, 15);

      const result = await execPromise;

      expect(result.success).toBe(false);
      expect(result.error).toBe('Operation aborted');
    });

    it('TC-CHAL2-ABT-04: enforces timeoutMs on HTTP requests and reports timeout error', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        return new Promise((_, reject) => {
          if (init?.signal) {
            init.signal.addEventListener('abort', () => {
              const timeoutErr = new Error('The operation was aborted due to timeout');
              timeoutErr.name = 'TimeoutError';
              reject(timeoutErr);
            });
          }
        });
      });

      const result = await mcpFleetManager.executeTool('ct_impact', { target: 'routes' }, { timeoutMs: 30 });

      expect(result.success).toBe(false);
      expect(result.error).toContain('timed out after 30ms');
    });
  });

  // =========================================================================
  // SECTION 3: Local Validation of ct_impact and Fleet Tools
  // =========================================================================
  describe('Section 3: Local Validation of ct_impact and Fleet Tools', () => {
    it('TC-CHAL2-VAL-01: rejects ct_impact with empty args object before dispatch', async () => {
      const execSpy = vi.spyOn(mcpFleetManager, 'executeTool');

      const result = await runReadOnlyTool('ct_impact', {}, baseContext());

      expect(result.toolOutput).toContain("Tool 'ct_impact' execution rejected: Missing required argument 'target'.");
      expect(result.toolScope).toBe('cross-repository-ast-mesh');
      expect(result.isExhaustive).toBe(false);
      expect(execSpy).not.toHaveBeenCalled();
    });

    it('TC-CHAL2-VAL-02: rejects ct_impact with empty string target before dispatch', async () => {
      const execSpy = vi.spyOn(mcpFleetManager, 'executeTool');

      const result = await runReadOnlyTool('ct_impact', { target: '' }, baseContext());

      expect(result.toolOutput).toContain("Tool 'ct_impact' execution rejected: Missing required argument 'target'.");
      expect(result.toolScope).toBe('cross-repository-ast-mesh');
      expect(result.isExhaustive).toBe(false);
      expect(execSpy).not.toHaveBeenCalled();
    });

    it('TC-CHAL2-VAL-03: rejects ct_impact with whitespace-only target before dispatch', async () => {
      const execSpy = vi.spyOn(mcpFleetManager, 'executeTool');

      const result = await runReadOnlyTool('ct_impact', { target: '   \t\n  ' }, baseContext());

      expect(result.toolOutput).toContain("Tool 'ct_impact' execution rejected: Missing required argument 'target'.");
      expect(result.toolScope).toBe('cross-repository-ast-mesh');
      expect(result.isExhaustive).toBe(false);
      expect(execSpy).not.toHaveBeenCalled();
    });

    it('TC-CHAL2-VAL-04: rejects ct_impact with non-string target before dispatch', async () => {
      const execSpy = vi.spyOn(mcpFleetManager, 'executeTool');

      const result = await runReadOnlyTool('ct_impact', { target: 12345 as any }, baseContext());

      expect(result.toolOutput).toContain("Tool 'ct_impact' execution rejected: Missing required argument 'target'.");
      expect(result.isExhaustive).toBe(false);
      expect(execSpy).not.toHaveBeenCalled();
    });

    it('TC-CHAL2-VAL-05: accepts ct_impact when target is a valid non-empty string', async () => {
      const execSpy = vi.spyOn(mcpFleetManager, 'executeTool').mockResolvedValue({
        success: true,
        output: { blastRadius: 'low', impactedRoutes: ['/api/v1/auth'] },
        durationMs: 10,
      });

      const result = await runReadOnlyTool('ct_impact', { target: 'src/routes/auth.ts' }, baseContext());

      expect(execSpy).toHaveBeenCalledWith('ct_impact', { target: 'src/routes/auth.ts' });
      expect(result.toolScope).toBe('cross-repository-ast-mesh');
      expect(result.isExhaustive).toBe(true);
      expect(result.toolOutput).toContain('blastRadius');
    });

    it('TC-CHAL2-VAL-06: accepts ct_impact when target_file is supplied instead of target', async () => {
      const execSpy = vi.spyOn(mcpFleetManager, 'executeTool').mockResolvedValue({
        success: true,
        output: { blastRadius: 'low' },
        durationMs: 5,
      });

      const result = await runReadOnlyTool('ct_impact', { target_file: 'src/routes/auth.ts' }, baseContext());

      expect(execSpy).toHaveBeenCalledWith('ct_impact', { target_file: 'src/routes/auth.ts' });
      expect(result.isExhaustive).toBe(true);
    });

    it('TC-CHAL2-VAL-07: accepts ct_impact when query is supplied instead of target', async () => {
      const execSpy = vi.spyOn(mcpFleetManager, 'executeTool').mockResolvedValue({
        success: true,
        output: { blastRadius: 'low' },
        durationMs: 5,
      });

      const result = await runReadOnlyTool('ct_impact', { query: 'UserToken' }, baseContext());

      expect(execSpy).toHaveBeenCalledWith('ct_impact', { query: 'UserToken' });
      expect(result.isExhaustive).toBe(true);
    });

    it('TC-CHAL2-VAL-08: rejects ct_mesh_query when query is missing or empty', async () => {
      const execSpy = vi.spyOn(mcpFleetManager, 'executeTool');

      const r1 = await runReadOnlyTool('ct_mesh_query', {}, baseContext());
      expect(r1.toolOutput).toContain("Missing required argument 'query'");
      expect(r1.isExhaustive).toBe(false);

      const r2 = await runReadOnlyTool('ct_mesh_query', { query: '  ' }, baseContext());
      expect(r2.toolOutput).toContain("Missing required argument 'query'");
      expect(r2.isExhaustive).toBe(false);

      expect(execSpy).not.toHaveBeenCalled();
    });

    it('TC-CHAL2-VAL-09: rejects knowledge_search when query is missing or empty', async () => {
      const execSpy = vi.spyOn(mcpFleetManager, 'executeTool');

      const r = await runReadOnlyTool('knowledge_search', { query: '' }, baseContext());
      expect(r.toolOutput).toContain("Missing required argument 'query'");
      expect(r.isExhaustive).toBe(false);
      expect(execSpy).not.toHaveBeenCalled();
    });

    it('TC-CHAL2-VAL-10: rejects knowledge_get when id is missing or empty', async () => {
      const execSpy = vi.spyOn(mcpFleetManager, 'executeTool');

      const r = await runReadOnlyTool('knowledge_get', {}, baseContext());
      expect(r.toolOutput).toContain("Missing required argument 'id'");
      expect(r.isExhaustive).toBe(false);
      expect(execSpy).not.toHaveBeenCalled();
    });

    it('TC-CHAL2-VAL-11: rejects advise_blocker when blocker_packet is missing or not an object', async () => {
      const execSpy = vi.spyOn(mcpFleetManager, 'executeTool');

      const r1 = await runReadOnlyTool('advise_blocker', {}, baseContext());
      expect(r1.toolOutput).toContain("Missing required argument 'blocker_packet'");
      expect(r1.isExhaustive).toBe(false);

      const r2 = await runReadOnlyTool('advise_blocker', { blocker_packet: 'string-instead-of-object' }, baseContext());
      expect(r2.toolOutput).toContain("Missing required argument 'blocker_packet'");
      expect(r2.isExhaustive).toBe(false);

      expect(execSpy).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // SECTION 4: Concurrency & Fault Isolation
  // =========================================================================
  describe('Section 4: Concurrency & Fault Isolation', () => {
    it('TC-CHAL2-CON-01: handles high concurrency burst across diverse fleet tools without state bleed', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        const body = JSON.parse(String(init?.body || '{}'));
        const toolName = body.params?.name;
        const args = body.params?.arguments;

        // Artificial jitter
        await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 15) + 5));

        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    toolEcho: toolName,
                    argsEcho: args,
                  }),
                },
              ],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });

      const calls = [
        runReadOnlyTool('ct_impact', { target: 'route-1' }, baseContext()),
        runReadOnlyTool('ct_impact', { target: 'route-2' }, baseContext()),
        runReadOnlyTool('ct_mesh_query', { query: 'ast-node-1' }, baseContext()),
        runReadOnlyTool('knowledge_search', { query: 'adr-cache' }, baseContext()),
        runReadOnlyTool('knowledge_get', { id: 'ADR-100' }, baseContext()),
        runReadOnlyTool('health', {}, baseContext()),
      ];

      const results = await Promise.all(calls);

      expect(results[0].toolOutput).toContain('route-1');
      expect(results[1].toolOutput).toContain('route-2');
      expect(results[2].toolOutput).toContain('ast-node-1');
      expect(results[3].toolOutput).toContain('adr-cache');
      expect(results[4].toolOutput).toContain('ADR-100');
      expect(results[5].toolOutput).toContain('health');
    });

    it('TC-CHAL2-CON-02: isolates tool failures so failing tool does not corrupt subsequent or concurrent tools', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        const body = JSON.parse(String(init?.body || '{}'));
        if (body.params?.arguments?.target === 'fail-target') {
          return new Response('Gateway Error', { status: 502, statusText: 'Bad Gateway' });
        }
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: { content: [{ type: 'text', text: '{"status":"ok"}' }] },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });

      const resFail = await runReadOnlyTool('ct_impact', { target: 'fail-target' }, baseContext());
      expect(resFail.toolOutput).toContain('MCP Error');
      expect(resFail.isExhaustive).toBe(false);

      const resSuccess = await runReadOnlyTool('ct_impact', { target: 'good-target' }, baseContext());
      expect(resSuccess.toolOutput).toContain('"status": "ok"');
      expect(resSuccess.isExhaustive).toBe(true);
    });

    it('TC-CHAL2-CON-03: Semaphore limiter enforces MAX_CONCURRENT_PERSONAS ceiling under heavy burst', async () => {
      expect(MAX_CONCURRENT_PERSONAS).toBe(8);
      let concurrentActive = 0;
      let maxActiveObserved = 0;

      const workers = Array.from({ length: 20 }, async (_, idx) => {
        const release = await processPersonaLimiter.acquire();
        concurrentActive++;
        if (concurrentActive > maxActiveObserved) {
          maxActiveObserved = concurrentActive;
        }
        await new Promise((r) => setTimeout(r, 5));
        concurrentActive--;
        release();
      });

      await Promise.all(workers);

      expect(maxActiveObserved).toBeLessThanOrEqual(MAX_CONCURRENT_PERSONAS);
      expect(processPersonaLimiter.active).toBe(0);
    });
  });
});
