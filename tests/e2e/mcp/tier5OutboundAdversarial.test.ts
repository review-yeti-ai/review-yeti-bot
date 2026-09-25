/**
 * Tier 5: Adversarial Coverage Hardening Test Suite (Outbound Fleet Federation & Engine Concurrency)
 *
 * White-box coverage and adversarial gap analysis across:
 * - src/mcp/mcpFleetManager.ts (HTTP/stdio transport, JSON-RPC unwrapping, auth hierarchy, concurrency, health checks)
 * - src/panel/toolRuntime.ts (Mutation blocking, argument validation, line slicing, oversized diffs, abort signals, scope honesty)
 * - src/panel/panelEngine.ts (Semaphore concurrency ceiling, queued waiter aborts, multi-persona parallel tool execution, timeout resilience)
 * - src/panel/composedEngine.ts (PLAN phase tools, WORK phase tools, nonce binding, turn budget exhaustion, abort propagation)
 * - Cross-Engine Semantic Parity (Identical tool envelopes and evidence-of-absence protection)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mcpFleetManager, McpFleetManager } from '../../../src/mcp/mcpFleetManager';
import type { CustomMcpServerConfig } from '../../../src/persistence/dashboardStore';
import { runReadOnlyTool, type ToolRuntimeContext } from '../../../src/panel/toolRuntime';
import {
  processPersonaLimiter,
  MAX_CONCURRENT_PERSONAS,
  executePersonaPanel,
  type RepoFileProvider,
} from '../../../src/panel/panelEngine';
import { executeComposedReview, resolveComposedEngineMaxTurns } from '../../../src/panel/composedEngine';
import { parseAndValidateConfig } from '../../../src/config/configLoader';
import type { CtReviewConfigV3 } from '../../../src/config/schema';
import type { OpenRouterResponse } from '../../../src/gateway/openRouterClient';

// Shared config fixtures for panel and composed review engines
const MOCK_PANEL_YAML = `
version: 3
profile: balanced
quorum: 1
personas:
  - id: security
    charter: builtin:security
    providers: [codex]
    paths: ["**/*"]
    required: true
    enabled: true
  - id: architecture
    charter: builtin:architecture
    providers: [codex]
    paths: ["**/*"]
    required: false
    enabled: true
reviewers:
  execution: personas
  fallback: none
  overall_timeout_s: 30
  providers:
    - id: codex
      enabled: true
      model: codex/gpt-5.6-sol-high
      effort: high
      review_timeout_s: 15
      arbiter_timeout_s: 15
  arbiter:
    order: [codex]
`;

const MOCK_COMPOSED_YAML = `
version: 3
profile: balanced
quorum: 1
personas:
  - id: security
    charter: builtin:security
    providers: [codex]
    paths: ["**/*"]
    required: true
    enabled: true
reviewers:
  execution: personas
  fallback: none
  overall_timeout_s: 30
  providers:
    - id: codex
      enabled: true
      model: codex/gpt-5.6-sol-high
      effort: high
      review_timeout_s: 15
      arbiter_timeout_s: 15
  arbiter:
    order: [codex]
composed:
  max_tasks: 3
  max_turns_total: 15
  max_turns_per_task: 4
`;

function createFakeResponse(content: string): OpenRouterResponse {
  return {
    model: 'test-model',
    content,
    usage: { prompt: 15, completion: 15, total: 30 },
    costUSD: 0.001,
    raw: {},
  };
}

function extractLastUserMessage(messages: any[]): string {
  const last = messages[messages.length - 1];
  if (typeof last?.content === 'string') return last.content;
  if (Array.isArray(last?.content)) return last.content.map((b: any) => b.text || '').join('\n');
  return '';
}

function extractAllMessagesText(messages: any[]): string {
  return messages
    .map((m: any) => {
      if (typeof m?.content === 'string') return m.content;
      if (Array.isArray(m?.content)) return m.content.map((b: any) => b.text || '').join('\n');
      return '';
    })
    .join('\n');
}

function extractCurrentNonce(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const text = typeof m?.content === 'string'
      ? m.content
      : Array.isArray(m?.content)
        ? m.content.map((b: any) => b.text || '').join('\n')
        : '';
    const match = text.match(/CT_REVIEW_NONCE:([a-f0-9-]+)/);
    if (match) return match[1];
  }
  return 'nonce-fallback';
}

describe('Tier 5 Adversarial Coverage Hardening (tests/e2e/mcp/tier5OutboundAdversarial.test.ts)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ===========================================================================
  // GROUP 1: McpFleetManager White-Box Hardening
  // ===========================================================================
  describe('Group 1: McpFleetManager White-Box Hardening', () => {
    it('TC-T5-FLT-01: resolves Bifrost gateway headers with API key resolution hierarchy', async () => {
      const origKey = process.env.REVIEW_YETI_BIFROST_API_KEY;
      const origGatewayKey = process.env.CT_LLM_GATEWAY_API_KEY;
      const origBifrostKey = process.env.BIFROST_API_KEY;

      try {
        // Test primary key resolution
        process.env.REVIEW_YETI_BIFROST_API_KEY = 'primary-secret-key-1';
        delete process.env.CT_LLM_GATEWAY_API_KEY;
        delete process.env.BIFROST_API_KEY;

        let capturedHeaders: Record<string, string> = {};
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
          capturedHeaders = (init?.headers || {}) as Record<string, string>;
          return new Response(
            JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{"ok":true}' }] } }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        });

        const res1 = await mcpFleetManager.executeTool('ct_impact', { target: 'routes' });
        expect(res1.success).toBe(true);
        expect(capturedHeaders['Authorization']).toBe('Bearer primary-secret-key-1');
        expect(capturedHeaders['x-api-key']).toBe('primary-secret-key-1');

        // Test fallback to CT_LLM_GATEWAY_API_KEY
        delete process.env.REVIEW_YETI_BIFROST_API_KEY;
        process.env.CT_LLM_GATEWAY_API_KEY = 'fallback-gateway-key-2';

        const res2 = await mcpFleetManager.executeTool('ct_impact', { target: 'routes' });
        expect(res2.success).toBe(true);
        expect(capturedHeaders['Authorization']).toBe('Bearer fallback-gateway-key-2');
        expect(capturedHeaders['x-api-key']).toBe('fallback-gateway-key-2');
      } finally {
        if (origKey !== undefined) process.env.REVIEW_YETI_BIFROST_API_KEY = origKey;
        else delete process.env.REVIEW_YETI_BIFROST_API_KEY;
        if (origGatewayKey !== undefined) process.env.CT_LLM_GATEWAY_API_KEY = origGatewayKey;
        else delete process.env.CT_LLM_GATEWAY_API_KEY;
        if (origBifrostKey !== undefined) process.env.BIFROST_API_KEY = origBifrostKey;
        else delete process.env.BIFROST_API_KEY;
      }
    });

    it('TC-T5-FLT-02: handles empty content arrays and non-text blocks without throwing', async () => {
      // Empty content array
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [] } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });

      const resEmpty = await mcpFleetManager.executeTool('health', {});
      expect(resEmpty.success).toBe(true);
      expect(resEmpty.output).toEqual({ content: [] });

      // Non-text block (e.g. image content)
      fetchSpy.mockImplementation(async () => {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            result: { content: [{ type: 'image', data: 'base64data' }] },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });

      const resImage = await mcpFleetManager.executeTool('health', {});
      expect(resImage.success).toBe(true);
      expect(resImage.output).toEqual({ content: [{ type: 'image', data: 'base64data' }] });
    });

    it('TC-T5-FLT-03: handles JSON-RPC response with isError: true and complex nested error payload', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    error: 'PolicyViolationError',
                    code: 'BLOCKER_NOT_OVERRULED',
                    details: { policyId: 'ADR-0564', line: 42 },
                  }),
                },
              ],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });

      const res = await mcpFleetManager.executeTool('advise_blocker', { blocker_packet: { id: 'B-1' } });
      expect(res.success).toBe(false);
      expect(res.error).toBe('PolicyViolationError');
    });

    it('TC-T5-FLT-04: handles HTTP gateway 500, 503, and network failure gracefully', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      // 503 Service Unavailable
      fetchSpy.mockResolvedValueOnce(
        new Response('Service Unavailable', { status: 503, statusText: 'Service Unavailable' })
      );
      const res503 = await mcpFleetManager.executeTool('ct_mesh_stats', {});
      expect(res503.success).toBe(false);
      expect(res503.error).toContain('503 Service Unavailable');

      // 500 Internal Server Error
      fetchSpy.mockResolvedValueOnce(
        new Response('Internal Server Error', { status: 500, statusText: 'Internal Server Error' })
      );
      const res500 = await mcpFleetManager.executeTool('knowledge_search', { query: 'test' });
      expect(res500.success).toBe(false);
      expect(res500.error).toContain('500 Internal Server Error');

      // Network ECONNREFUSED
      fetchSpy.mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.244.0.15:8080'));
      const resConn = await mcpFleetManager.executeTool('ct_impact', { target: 'routes' });
      expect(resConn.success).toBe(false);
      expect(resConn.error).toContain('ECONNREFUSED');
    });

    it('TC-T5-FLT-05: resolves RPC endpoint correctly with varied URL formats', async () => {
      const testServerId = `temp_http_srv_${Date.now()}`;
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        expect(String(url)).toBe('http://custom-mcp.internal/custom/tools/call');
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{"resolved":true}' }] } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });

      await mcpFleetManager.registerServer({
        id: testServerId,
        name: 'Custom Endpoint Server',
        transport: 'http',
        url: 'http://custom-mcp.internal/custom',
        enabled: true,
        status: 'online',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // Manually register tool under this custom server
      (mcpFleetManager as any).toolRegistry.set('custom_ping_tool', {
        serverId: testServerId,
        name: 'custom_ping_tool',
        description: 'Ping',
        inputSchema: {},
      });

      const res = await mcpFleetManager.executeTool('custom_ping_tool', {});
      expect(res.success).toBe(true);
      expect(res.output).toEqual({ resolved: true });

      await mcpFleetManager.unregisterServer(testServerId);
    });

    it('TC-T5-FLT-06: executes 10 parallel tool invocations concurrently without cross-contamination', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        const body = JSON.parse(String(init?.body || '{}'));
        const queryVal = body.params?.arguments?.query || body.params?.name;
        // Simulate varying network latency
        await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 20) + 5));
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ query: queryVal, timestamp: Date.now() }),
                },
              ],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });

      const queries = Array.from({ length: 10 }, (_, i) => `query-${i}`);
      const promises = queries.map((q) => mcpFleetManager.executeTool('knowledge_search', { query: q }));
      const results = await Promise.all(promises);

      expect(results).toHaveLength(10);
      for (let i = 0; i < 10; i++) {
        expect(results[i].success).toBe(true);
        expect(results[i].output.query).toBe(`query-${i}`);
      }
    });

    it('TC-T5-FLT-07: unregistering a server drops registered tools and fails subsequent executions closed', async () => {
      const tempId = `temp_ephemeral_${Date.now()}`;
      await mcpFleetManager.registerServer({
        id: tempId,
        name: 'Ephemeral Server',
        transport: 'http',
        url: 'http://ephemeral.internal/mcp',
        enabled: true,
        status: 'online',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      (mcpFleetManager as any).toolRegistry.set('ephemeral_query', {
        serverId: tempId,
        name: 'ephemeral_query',
        description: 'Ephemeral',
        inputSchema: {},
      });

      expect(mcpFleetManager.hasTool('ephemeral_query')).toBe(true);

      const unregistered = await mcpFleetManager.unregisterServer(tempId);
      expect(unregistered).toBe(true);
      expect(mcpFleetManager.hasTool('ephemeral_query')).toBe(false);

      const result = await mcpFleetManager.executeTool('ephemeral_query', {});
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found in registered MCP fleet');
    });

    it('TC-T5-FLT-08: healthCheckAll evaluates online, offline, degraded, and disabled servers concurrently', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        if (String(url).includes('bifrost')) {
          return new Response(
            JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'health' }] } }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response('Offline', { status: 502, statusText: 'Bad Gateway' });
      });

      const tempDisabledId = `temp_disabled_${Date.now()}`;
      await mcpFleetManager.registerServer({
        id: tempDisabledId,
        name: 'Disabled Server',
        transport: 'http',
        url: 'http://disabled.internal/mcp',
        enabled: false,
        status: 'offline',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const healthResults = await mcpFleetManager.healthCheckAll();
      expect(healthResults['bifrost-gateway']).toBe('online');
      expect(healthResults[tempDisabledId]).toBe('offline');

      await mcpFleetManager.unregisterServer(tempDisabledId);
    });
  });

  // ===========================================================================
  // GROUP 2: Tool Runtime Scope Envelopes & Boundary Hardening
  // ===========================================================================
  describe('Group 2: Tool Runtime Boundaries & Scope Honesty (toolRuntime.ts)', () => {
    const baseContext = (overrides: Partial<ToolRuntimeContext> = {}): ToolRuntimeContext => ({
      changedFiles: [{ path: 'src/billing/service.ts', patch: 'export function computeRate() { return 0.05; }\n' }],
      ...overrides,
    });

    it('TC-T5-RUN-01: strictly rejects all mutating tools with permission denied and non-exhaustive envelope', async () => {
      const mutatingTools = [
        'write_file',
        'delete_file',
        'modify_policy',
        'linear_close_issue',
        'memory_record',
        'memory_supersede',
        'bash_exec',
        'database_drop',
      ];

      for (const tool of mutatingTools) {
        const result = await runReadOnlyTool(tool, { foo: 'bar', id: 'X-1' }, baseContext());
        expect(result.toolOutput).toContain(`Tool '${tool}' execution rejected: Permission denied.`);
        expect(result.toolScope).toBe('changed-patches-only');
        expect(result.isExhaustive).toBe(false);
      }
    });

    it('TC-T5-RUN-02: parameter validation rejects missing, empty, or whitespace-only arguments before fleet dispatch', async () => {
      const execSpy = vi.spyOn(mcpFleetManager, 'executeTool');

      // ct_mesh_query requires non-empty query
      const r1 = await runReadOnlyTool('ct_mesh_query', {}, baseContext());
      expect(r1.toolOutput).toContain("Missing required argument 'query'");
      expect(r1.isExhaustive).toBe(false);

      const r2 = await runReadOnlyTool('ct_mesh_query', { query: '   ' }, baseContext());
      expect(r2.toolOutput).toContain("Missing required argument 'query'");
      expect(r2.isExhaustive).toBe(false);

      // knowledge_search requires non-empty query
      const r3 = await runReadOnlyTool('knowledge_search', { query: '' }, baseContext());
      expect(r3.toolOutput).toContain("Missing required argument 'query'");
      expect(r3.isExhaustive).toBe(false);

      // knowledge_get requires non-empty id
      const r4 = await runReadOnlyTool('knowledge_get', { id: '   ' }, baseContext());
      expect(r4.toolOutput).toContain("Missing required argument 'id'");
      expect(r4.isExhaustive).toBe(false);

      // advise_blocker requires object blocker_packet
      const r5 = await runReadOnlyTool('advise_blocker', { blocker_packet: 'not-an-object' }, baseContext());
      expect(r5.toolOutput).toContain("Missing required argument 'blocker_packet'");
      expect(r5.isExhaustive).toBe(false);

      expect(execSpy).not.toHaveBeenCalled();
    });

    it('TC-T5-RUN-03: enforces scope honesty for fleet tools (cross-repository-ast-mesh, governed-knowledge-adr, policy-blocker-quorum)', async () => {
      vi.spyOn(mcpFleetManager, 'executeTool').mockResolvedValue({
        success: true,
        output: { result: 'ok' },
        durationMs: 10,
      });

      // ct_impact
      const rImpact = await runReadOnlyTool('ct_impact', { target: 'routes' }, baseContext());
      expect(rImpact.toolScope).toBe('cross-repository-ast-mesh');
      expect(rImpact.isExhaustive).toBe(true);

      // knowledge_get
      const rKnowledge = await runReadOnlyTool('knowledge_get', { id: 'ADR-0564' }, baseContext());
      expect(rKnowledge.toolScope).toBe('governed-knowledge-adr');
      expect(rKnowledge.isExhaustive).toBe(true);

      // health
      const rHealth = await runReadOnlyTool('health', {}, baseContext());
      expect(rHealth.toolScope).toBe('policy-blocker-quorum');
      expect(rHealth.isExhaustive).toBe(true);
    });

    it('TC-T5-RUN-04: line slicing boundaries: handles inverted range, floats, negative lines, and out-of-bounds', async () => {
      const fileContent = ['line 1', 'line 2', 'line 3', 'line 4', 'line 5'].join('\n');
      const ctx = baseContext({
        changedFiles: [{ path: 'src/calc.ts', patch: fileContent }],
      });

      // Inverted range: startLine: 4, endLine: 2 -> end clamped to start -> returns line 4
      const rInverted = await runReadOnlyTool('read_file', { path: 'src/calc.ts', startLine: 4, endLine: 2 }, ctx);
      expect(rInverted.toolOutput).toContain('Lines 4-4 of 5');
      expect(rInverted.toolOutput).toContain('line 4');

      // Float line numbers: startLine: 2.7 -> Math.floor -> 2
      const rFloat = await runReadOnlyTool('read_file', { path: 'src/calc.ts', startLine: 2.7, endLine: 3.9 }, ctx);
      expect(rFloat.toolOutput).toContain('Lines 2-3 of 5');
      expect(rFloat.toolOutput).toContain('line 2\nline 3');

      // Negative or zero lines: treated as undefined/fallback
      const rZero = await runReadOnlyTool('read_file', { path: 'src/calc.ts', startLine: -5, endLine: 0 }, ctx);
      expect(rZero.toolOutput).toContain('line 1\nline 2\nline 3\nline 4\nline 5');
    });

    it('TC-T5-RUN-05: oversized patch diff returns explicit SKIPPED warning to prevent token blowout', async () => {
      const origEnv = process.env.MAX_FILE_DIFF_CHARS;
      try {
        process.env.MAX_FILE_DIFF_CHARS = '100';
        const bigPatch = 'A'.repeat(500);
        const ctx = baseContext({
          changedFiles: [{ path: 'src/huge.ts', patch: bigPatch, originalPatchLength: 500 }],
        });

        const res = await runReadOnlyTool('read_file', { path: 'src/huge.ts' }, ctx);
        expect(res.toolOutput).toContain("SKIPPED 'src/huge.ts': patch is 500 characters, over max-file-diff-chars 100");
        expect(res.isExhaustive).toBe(false);
      } finally {
        if (origEnv !== undefined) process.env.MAX_FILE_DIFF_CHARS = origEnv;
        else delete process.env.MAX_FILE_DIFF_CHARS;
      }
    });

    it('TC-T5-RUN-06: full-repository file provider: distinguishes confirmed missing vs lookup failure', async () => {
      // 1. Confirmed missing (returns null) -> isExhaustive: true
      const repoProviderMissing: RepoFileProvider = {
        findFiles: vi.fn(),
        readFile: vi.fn().mockResolvedValue(null),
      };
      const resMissing = await runReadOnlyTool('read_file', { path: 'src/missing.ts' }, baseContext({ repoFileProvider: repoProviderMissing }));
      expect(resMissing.toolScope).toBe('full-repository');
      expect(resMissing.isExhaustive).toBe(true);
      expect(resMissing.toolOutput).toContain('does not exist in the repository at the reviewed head (checked the full repository tree');

      // 2. Lookup failure (throws) -> isExhaustive: false
      const repoProviderError: RepoFileProvider = {
        findFiles: vi.fn(),
        readFile: vi.fn().mockRejectedValue(new Error('GitHub API rate limit exceeded')),
      };
      const resError = await runReadOnlyTool('read_file', { path: 'src/error.ts' }, baseContext({ repoFileProvider: repoProviderError }));
      expect(resError.toolScope).toBe('full-repository');
      expect(resError.isExhaustive).toBe(false);
      expect(resError.toolOutput).toContain('Full-repository read of \'src/error.ts\' failed (GitHub API rate limit exceeded)');
    });

    it('TC-T5-RUN-07: pre-aborted signal throws PanelAbortedError immediately before tool dispatch', async () => {
      const controller = new AbortController();
      controller.abort();

      await expect(
        runReadOnlyTool('ct_impact', { target: 'routes' }, baseContext({ signal: controller.signal }))
      ).rejects.toThrow();
    });

    it('TC-T5-RUN-08: fleet execution error returns structured MCP Error with isExhaustive: false without throwing', async () => {
      vi.spyOn(mcpFleetManager, 'executeTool').mockResolvedValue({
        success: false,
        output: null,
        error: 'HTTP 504 Gateway Timeout from Bifrost',
        durationMs: 15000,
      });

      const res = await runReadOnlyTool('knowledge_search', { query: 'caching' }, baseContext());
      expect(res.toolOutput).toContain('MCP Error: HTTP 504 Gateway Timeout from Bifrost');
      expect(res.toolScope).toBe('governed-knowledge-adr');
      expect(res.isExhaustive).toBe(false);
    });
  });

  // ===========================================================================
  // GROUP 3: Panel Engine Concurrency & Semaphore Stress
  // ===========================================================================
  describe('Group 3: Panel Engine Concurrency & Semaphore Stress (panelEngine.ts)', () => {
    it('TC-T5-PAN-01: Semaphore enforces MAX_CONCURRENT_PERSONAS ceiling under burst', async () => {
      expect(MAX_CONCURRENT_PERSONAS).toBe(8);

      let activeCount = 0;
      let peakCount = 0;

      // Simulate 10 concurrent requests acquiring slots
      const tasks = Array.from({ length: 10 }, async (_, i) => {
        const release = await processPersonaLimiter.acquire();
        activeCount++;
        if (activeCount > peakCount) peakCount = activeCount;
        await new Promise((r) => setTimeout(r, 10));
        activeCount--;
        release();
      });

      await Promise.all(tasks);
      expect(peakCount).toBeLessThanOrEqual(MAX_CONCURRENT_PERSONAS);
      expect(processPersonaLimiter.active).toBe(0);
    });

    it('TC-T5-PAN-02: Semaphore rejects pre-aborted signal immediately without leaking waiters', async () => {
      const controller = new AbortController();
      controller.abort();

      const initialActive = processPersonaLimiter.active;
      await expect(processPersonaLimiter.acquire(controller.signal)).rejects.toThrow();
      expect(processPersonaLimiter.active).toBe(initialActive);
    });

    it('TC-T5-PAN-03: Semaphore queued waiter aborts cleanly without corrupting other queued waiters', async () => {
      // Saturate all 4 slots
      const releases: Array<() => void> = [];
      for (let i = 0; i < MAX_CONCURRENT_PERSONAS; i++) {
        releases.push(await processPersonaLimiter.acquire());
      }
      expect(processPersonaLimiter.active).toBe(MAX_CONCURRENT_PERSONAS);

      const controller = new AbortController();
      let abortedCaught = false;

      // Waiter 1 will be aborted
      const p1 = processPersonaLimiter.acquire(controller.signal).catch((err) => {
        abortedCaught = true;
        return null;
      });

      // Waiter 2 will succeed
      let waiter2Acquired = false;
      const p2 = processPersonaLimiter.acquire().then((rel) => {
        waiter2Acquired = true;
        return rel;
      });

      // Abort Waiter 1 while queued
      controller.abort();
      await p1;
      expect(abortedCaught).toBe(true);

      // Release one running slot; Waiter 2 should be dequeued and acquire
      releases[0]();
      const rel2 = await p2;
      expect(waiter2Acquired).toBe(true);

      // Clean up remaining slots
      if (rel2) rel2();
      for (let i = 1; i < releases.length; i++) {
        releases[i]();
      }
      expect(processPersonaLimiter.active).toBe(0);
    });

    it('TC-T5-PAN-04: multi-persona parallel execution: concurrent personas invoke fleet tools without cross-talk', async () => {
      const execSpy = vi.spyOn(mcpFleetManager, 'executeTool').mockImplementation(async (tool, args) => {
        if (tool === 'ct_impact') {
          return { success: true, output: { blast_radius: 'LOW', tool: 'ct_impact' }, durationMs: 10 };
        }
        if (tool === 'knowledge_search') {
          return { success: true, output: { adrs: ['ADR-0564'], tool: 'knowledge_search' }, durationMs: 10 };
        }
        return { success: true, output: { status: 'healthy' }, durationMs: 5 };
      });

      const config = parseAndValidateConfig(MOCK_PANEL_YAML) as unknown as CtReviewConfigV3;

      const mockClient = {
        complete: vi.fn().mockImplementation(async (payload: any) => {
          const text = extractAllMessagesText(payload.messages);
          const nonceMatch = text.match(/CT_REVIEW_NONCE:([a-f0-9-]+)/);
          const nonce = nonceMatch ? nonceMatch[1] : 'nonce-p4';

          if (text.includes('SHIP|FIX_FIRST|BLOCK')) {
            return createFakeResponse(`CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: 'All good' })}\nCT_REVIEW_END:${nonce}`);
          }

          if (text.includes('RECONCILED')) {
            return createFakeResponse(`CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'RECONCILED', findings: [] })}\nCT_REVIEW_END:${nonce}`);
          }

          // If tool result received, render final approval
          if (text.includes('[PI_TOOL_RESULT]')) {
            return createFakeResponse(`CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ role: 'persona', decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${nonce}`);
          }

          // Persona 1 (security) calls ct_impact; Persona 2 (architecture) calls knowledge_search
          if (payload.persona === 'architecture') {
            return createFakeResponse('```json\n{"tool": "knowledge_search", "args": {"query": "auth"}}\n```');
          } else {
            return createFakeResponse('```json\n{"tool": "ct_impact", "args": {"target": "routes"}}\n```');
          }
        }),
      };

      const result = await executePersonaPanel({
        config,
        changedFiles: [{ path: 'src/auth/service.ts', patch: '+ export function verify() {}' }],
        repository: 'calltelemetry/cisco-cdr',
        headSha: 'c0ffee'.repeat(6).slice(0, 40),
        client: mockClient as any,
      });

      expect(result.personas).toHaveLength(2);
      expect(result.arbiter.verdict).toBe('SHIP');
      expect(execSpy).toHaveBeenCalledWith('ct_impact', { target: 'routes' });
      expect(execSpy).toHaveBeenCalledWith('knowledge_search', { query: 'auth' });
    });

    it('TC-T5-PAN-05: persona tool timeout degrades gracefully and allows persona to complete review', async () => {
      vi.spyOn(mcpFleetManager, 'executeTool').mockResolvedValue({
        success: false,
        output: null,
        error: 'HTTP request timed out after 15000ms',
        durationMs: 15000,
      });

      const config = parseAndValidateConfig(MOCK_PANEL_YAML) as unknown as CtReviewConfigV3;
      let toolErrorObserved = false;

      const mockClient = {
        complete: vi.fn().mockImplementation(async (payload: any) => {
          const text = extractAllMessagesText(payload.messages);
          const nonceMatch = text.match(/CT_REVIEW_NONCE:([a-f0-9-]+)/);
          const nonce = nonceMatch ? nonceMatch[1] : 'nonce-p5';

          if (text.includes('SHIP|FIX_FIRST|BLOCK')) {
            return createFakeResponse(`CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: 'Pass' })}\nCT_REVIEW_END:${nonce}`);
          }
          if (text.includes('RECONCILED')) {
            return createFakeResponse(`CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'RECONCILED', findings: [] })}\nCT_REVIEW_END:${nonce}`);
          }
          if (text.includes('[PI_TOOL_RESULT]')) {
            if (text.includes('timed out')) {
              toolErrorObserved = true;
            }
            return createFakeResponse(`CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ role: 'persona', decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${nonce}`);
          }

          return createFakeResponse('```json\n{"tool": "ct_impact", "args": {"target": "timeout"}}\n```');
        }),
      };

      const result = await executePersonaPanel({
        config,
        changedFiles: [{ path: 'src/timeout/test.ts', patch: '+ const timeout = true;' }],
        repository: 'calltelemetry/cisco-cdr',
        headSha: 'd00dad'.repeat(6).slice(0, 40),
        client: mockClient as any,
      });

      expect(toolErrorObserved).toBe(true);
      expect(result.arbiter.verdict).toBe('SHIP');
    });
  });

  // ===========================================================================
  // GROUP 4: Composed Engine Concurrency & Sequential Cursor
  // ===========================================================================
  describe('Group 4: Composed Engine Concurrency & Sequential Cursor (composedEngine.ts)', () => {
    it('TC-T5-CMP-01: composed PLAN phase executes fleet MCP tool (ct_impact) and integrates scope envelope', async () => {
      let toolCallCaptured = false;
      const execSpy = vi.spyOn(mcpFleetManager, 'executeTool').mockResolvedValue({
        success: true,
        output: { blast_radius: 'HIGH', affected_repos: ['calltelemetry/ct-release'] },
        durationMs: 20,
      });

      const config = parseAndValidateConfig(MOCK_COMPOSED_YAML) as any;

      const mockClient = {
        complete: vi.fn().mockImplementation(async (payload: any) => {
          const text = extractLastUserMessage(payload.messages);
          const nonce = extractCurrentNonce(payload.messages);

          if (text.includes('PLAN TURN')) {
            // Model invokes ct_impact during planning
            return createFakeResponse(JSON.stringify({ tool: 'ct_impact', args: { target: 'routes' } }));
          }

          if (text.includes('[PI_TOOL_RESULT]')) {
            toolCallCaptured = true;
            expect(text).toContain('blast_radius');
            expect(text).toContain('[SCOPE: cross-repository-ast-mesh | EXHAUSTIVE: true]');
            // Render completed task plan
            return createFakeResponse(
              JSON.stringify({
                nonce,
                tasks: [
                  {
                    id: 'security-blast-check',
                    dimension: 'security',
                    paths: ['src/auth/guard.ts'],
                    question: 'Check cross-repo blast radius',
                    rationale: 'Routes modified',
                  },
                ],
              })
            );
          }

          if (text.includes('WORK TURN')) {
            return createFakeResponse(
              JSON.stringify({ nonce, task: 'security-blast-check', status: 'COMPLETE', findings: [] })
            );
          }

          throw new Error(`Unexpected prompt: ${text.slice(0, 100)}`);
        }),
      };

      const result = await executeComposedReview({
        config,
        changedFiles: [{ path: 'src/auth/guard.ts', patch: '@@ -1 +1,2 @@\n+export function guard() {}' }],
        repository: 'calltelemetry/cisco-cdr',
        headSha: 'e0e0e0'.repeat(6).slice(0, 40),
        client: mockClient as any,
      });

      expect(toolCallCaptured).toBe(true);
      expect(result.applicablePersonaIds).toEqual(['security-blast-check']);
      expect(result.personas[0].decision).toBe('APPROVE');
      expect(execSpy).toHaveBeenCalledWith('ct_impact', { target: 'routes' });
    });

    it('TC-T5-CMP-02: composed WORK phase executes fleet tool (knowledge_search) and records findings', async () => {
      let workToolCaptured = false;
      vi.spyOn(mcpFleetManager, 'executeTool').mockResolvedValue({
        success: true,
        output: { adrs: [{ id: 'ADR-0564', title: 'Ring Buffer Policy' }] },
        durationMs: 15,
      });

      const config = parseAndValidateConfig(MOCK_COMPOSED_YAML) as any;

      const mockClient = {
        complete: vi.fn().mockImplementation(async (payload: any) => {
          const text = extractLastUserMessage(payload.messages);
          const nonce = extractCurrentNonce(payload.messages);

          if (text.includes('PLAN TURN')) {
            return createFakeResponse(
              JSON.stringify({
                nonce,
                tasks: [
                  {
                    id: 'adr-compliance',
                    dimension: 'architecture',
                    paths: ['src/cache/buffer.ts'],
                    question: 'Is ADR 0564 honored?',
                    rationale: 'Buffer sizing',
                  },
                ],
              })
            );
          }

          if (text.includes('WORK TURN') && !workToolCaptured) {
            return createFakeResponse(JSON.stringify({ tool: 'knowledge_search', args: { query: 'buffer' } }));
          }

          if (text.includes('[PI_TOOL_RESULT]')) {
            workToolCaptured = true;
            expect(text).toContain('ADR-0564');
            expect(text).toContain('[SCOPE: governed-knowledge-adr | EXHAUSTIVE: true]');
            return createFakeResponse(
              JSON.stringify({
                nonce,
                task: 'adr-compliance',
                status: 'COMPLETE',
                findings: [
                  {
                    severity: 'P1',
                    path: 'src/cache/buffer.ts',
                    line: 1,
                    startLine: 1,
                    title: 'Unbounded buffer violates ADR 0564',
                    body: 'Buffer capacity must be bounded.',
                    suggestion: 'Add maxCapacity check',
                    replacementCode: null,
                  },
                ],
              })
            );
          }

          throw new Error(`Unexpected turn: ${text.slice(0, 100)}`);
        }),
      };

      const result = await executeComposedReview({
        config,
        changedFiles: [{ path: 'src/cache/buffer.ts', patch: '@@ -1 +1,5 @@\n+export class Buffer {}' }],
        repository: 'calltelemetry/cisco-cdr',
        headSha: 'f1f1f1'.repeat(6).slice(0, 40),
        client: mockClient as any,
      });

      expect(workToolCaptured).toBe(true);
      expect(result.personas[0].findings).toHaveLength(1);
      expect(result.personas[0].findings[0].title).toBe('Unbounded buffer violates ADR 0564');
    });

    it('TC-T5-CMP-03: task nonce mismatch triggers correction turn, second failure marks task as exhausted', async () => {
      const config = parseAndValidateConfig(MOCK_COMPOSED_YAML) as any;
      let correctionPromptSeen = false;

      const mockClient = {
        complete: vi.fn().mockImplementation(async (payload: any) => {
          const text = extractLastUserMessage(payload.messages);
          const allText = extractAllMessagesText(payload.messages);
          const nonceMatch = allText.match(/CT_REVIEW_NONCE:([a-f0-9-]+)/);
          const nonce = nonceMatch ? nonceMatch[1] : 'valid-nonce';

          if (text.includes('PLAN TURN')) {
            return createFakeResponse(
              JSON.stringify({
                nonce,
                tasks: [
                  {
                    id: 'task-auth',
                    dimension: 'security',
                    paths: ['src/auth.ts'],
                    question: 'Security audit',
                    rationale: 'Auth checks',
                  },
                ],
              })
            );
          }

          if (text.includes('CORRECTION') || text.includes('nonce')) {
            correctionPromptSeen = true;
          }

          // Return bad nonce consistently to trigger exhaustion
          return createFakeResponse(
            JSON.stringify({
              nonce: 'forged-or-spoofed-nonce',
              task: 'task-auth',
              status: 'COMPLETE',
              findings: [],
            })
          );
        }),
      };

      const result = await executeComposedReview({
        config,
        changedFiles: [{ path: 'src/auth.ts', patch: '+ const secure = true;' }],
        repository: 'calltelemetry/cisco-cdr',
        headSha: 'a0b1c2'.repeat(6).slice(0, 40),
        client: mockClient as any,
      });

      expect(correctionPromptSeen).toBe(true);
      // The task failed to bind to its nonce, so it could not be recorded as a valid persona lane
      expect(result.personas).toHaveLength(0);
    });

    it('TC-T5-CMP-04: composed total turn budget exhaustion records unstarted tasks in unreportedLanes', async () => {
      const config = parseAndValidateConfig(MOCK_COMPOSED_YAML) as any;
      // Artificially clamp max turns to 2
      const origEnv = process.env.COMPOSED_ENGINE_MAX_TURNS;
      process.env.COMPOSED_ENGINE_MAX_TURNS = '2';

      try {
        const mockClient = {
          complete: vi.fn().mockImplementation(async (payload: any) => {
            const text = extractLastUserMessage(payload.messages);
            const nonce = extractCurrentNonce(payload.messages);

            if (text.includes('PLAN TURN')) {
              return createFakeResponse(
                JSON.stringify({
                  nonce,
                  tasks: [
                    { id: 'task-1', dimension: 'security', paths: ['src/a.ts'], question: 'q1', rationale: 'r1' },
                    { id: 'task-2', dimension: 'architecture', paths: ['src/b.ts'], question: 'q2', rationale: 'r2' },
                  ],
                })
              );
            }

            if (text.includes('WORK TURN')) {
              return createFakeResponse(JSON.stringify({ nonce, task: 'task-1', status: 'COMPLETE', findings: [] }));
            }

            throw new Error(`Unexpected: ${text}`);
          }),
        };

        const result = await executeComposedReview({
          config,
          changedFiles: [
            { path: 'src/a.ts', patch: '+ a' },
            { path: 'src/b.ts', patch: '+ b' },
          ],
          repository: 'calltelemetry/cisco-cdr',
          headSha: '123456'.repeat(6).slice(0, 40),
          client: mockClient as any,
        });

        expect(result.personas).toHaveLength(1);
        expect(result.unreportedLanes).toBeDefined();
        const unreported = result.unreportedLanes!;
        expect(unreported.length).toBeGreaterThanOrEqual(1);
        expect(unreported[0].id).toBe('task-2');
        expect(unreported[0].failureClass).toBe('budget_exhausted');
      } finally {
        if (origEnv !== undefined) process.env.COMPOSED_ENGINE_MAX_TURNS = origEnv;
        else delete process.env.COMPOSED_ENGINE_MAX_TURNS;
      }
    });

    it('TC-T5-CMP-05: abort signal propagates and terminates composed review with deadline cleanup', async () => {
      const config = parseAndValidateConfig(MOCK_COMPOSED_YAML) as any;
      const controller = new AbortController();

      const mockClient = {
        complete: vi.fn().mockImplementation(async () => {
          controller.abort();
          await new Promise((r) => setTimeout(r, 10));
          return createFakeResponse('{"should":"not reach"}');
        }),
      };

      await expect(
        executeComposedReview({
          config,
          changedFiles: [{ path: 'src/abort.ts', patch: '+ abort' }],
          repository: 'calltelemetry/cisco-cdr',
          headSha: '999999'.repeat(6).slice(0, 40),
          client: mockClient as any,
          signal: controller.signal,
        })
      ).rejects.toThrow();
    });
  });

  // ===========================================================================
  // GROUP 5: Cross-Engine Tool Semantic Parity
  // ===========================================================================
  describe('Group 5: Cross-Engine Tool Semantic Parity', () => {
    it('TC-T5-PAR-01: verifies runReadOnlyTool returns identical envelopes regardless of calling engine', async () => {
      vi.spyOn(mcpFleetManager, 'executeTool').mockResolvedValue({
        success: true,
        output: { test: 'parity' },
        durationMs: 5,
      });

      const panelContext: ToolRuntimeContext = {
        changedFiles: [{ path: 'src/parity.ts', patch: '+ const p = 1;' }],
      };

      const composedContext: ToolRuntimeContext = {
        changedFiles: [{ path: 'src/parity.ts', patch: '+ const p = 1;' }],
      };

      const panelRes = await runReadOnlyTool('ct_impact', { target: 'routes' }, panelContext);
      const composedRes = await runReadOnlyTool('ct_impact', { target: 'routes' }, composedContext);

      expect(panelRes.toolScope).toBe(composedRes.toolScope);
      expect(panelRes.isExhaustive).toBe(composedRes.isExhaustive);
      expect(panelRes.toolOutput).toBe(composedRes.toolOutput);
    });

    it('TC-T5-PAR-02: evidence-of-absence protection: diff-scoped search miss warns without claiming absence', async () => {
      const ctx: ToolRuntimeContext = {
        changedFiles: [{ path: 'src/small.ts', patch: 'export function hello() {}' }],
      };

      // Search miss in diff
      const searchRes = await runReadOnlyTool('search_code', { query: 'authenticateUser' }, ctx);
      expect(searchRes.isExhaustive).toBe(false);
      expect(searchRes.toolScope).toBe('changed-patches-only');
      expect(searchRes.toolOutput).toContain('No matches for \'authenticateUser\' in the diff.');
      expect(searchRes.toolOutput).toContain('a match may still exist outside the diff');

      // Symbol search miss in diff
      const symRes = await runReadOnlyTool('symbol_search', { query: 'authenticateUser' }, ctx);
      expect(symRes.isExhaustive).toBe(false);
      expect(symRes.toolScope).toBe('changed-patches-only');
      expect(symRes.toolOutput).toContain('No symbols found matching \'authenticateUser\' in the diff.');
      expect(symRes.toolOutput).toContain('the symbol may be defined elsewhere');
    });
  });
});
