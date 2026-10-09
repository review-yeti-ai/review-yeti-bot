import { timingSafeEqual } from 'node:crypto';
import {
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpExecutionContext,
  type McpToolHandler,
  type ToolDefinition,
} from './types.js';

import {
  queryActiveJobsTool,
  queryFindingsTool,
  getCloudflareStatusTool,
  getBillableRuntimeReportTool,
  getRuntimeMetricsTool,
  getAnalyticsDashboardTool,
  triggerReviewTool,
  cancelReviewTool,
  purgeCacheTool,
  attestPrGateTool,
  disputeFindingTool,
  replyReviewThreadTool,
} from './tools/index.js';

export const MUTATING_TOOL_NAMES = new Set([
  'review_yeti_trigger_review',
  'trigger_review',
  'review_yeti_cancel_review',
  'cancel_review',
  'review_yeti_purge_cache',
  'purge_cache',
  'review_yeti_attest_pr_gate',
  'attest_pr_gate',
  'review_yeti_dispute_finding',
  'dispute_finding',
  'review_yeti_reply_review_thread',
  'reply_review_thread',
]);

export function constantTimeEquals(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function validateInputSchema(
  tool: McpToolHandler,
  args: Record<string, any>
): { valid: boolean; error?: string } {
  const schema = tool.definition.inputSchema;
  if (!schema || typeof schema !== 'object') return { valid: true };
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const field of required) {
    if (args[field] === undefined || args[field] === null || args[field] === '') {
      return { valid: false, error: `Missing required parameter: "${field}"` };
    }
  }
  const props = schema.properties || {};
  for (const [key, propDef] of Object.entries(props)) {
    const val = args[key];
    if (val === undefined || val === null) continue;
    const expectedType = (propDef as any).type;
    if (expectedType === 'number' && (typeof val !== 'number' || isNaN(val))) {
      return { valid: false, error: `Parameter "${key}" must be a number` };
    }
    if (expectedType === 'string' && typeof val !== 'string') {
      return { valid: false, error: `Parameter "${key}" must be a string` };
    }
    if (expectedType === 'boolean' && typeof val !== 'boolean') {
      return { valid: false, error: `Parameter "${key}" must be a boolean` };
    }
  }
  return { valid: true };
}

function extractTextContent(res: any): string {
  if (!res || !Array.isArray(res.content)) return '{}';
  const textItem = res.content.find(
    (item: any) => item && item.type === 'text' && typeof item.text === 'string'
  );
  return textItem?.text || '{}';
}

interface SseSession {
  id: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
  createdAt: number;
}

export class McpRouter {
  private readonly tools = new Map<string, McpToolHandler>();
  private readonly sseSessions = new Map<string, SseSession>();

  constructor() {
    this.registerTool(queryActiveJobsTool);
    this.registerTool(queryFindingsTool);
    this.registerTool(getCloudflareStatusTool);
    this.registerTool(getBillableRuntimeReportTool);
    this.registerTool(getRuntimeMetricsTool);
    this.registerTool(getAnalyticsDashboardTool);
    this.registerTool(triggerReviewTool);
    this.registerTool(cancelReviewTool);
    this.registerTool(purgeCacheTool);
    this.registerTool(attestPrGateTool);
    this.registerTool(disputeFindingTool);
    this.registerTool(replyReviewThreadTool);
  }

  public registerTool(handler: McpToolHandler): void {
    this.tools.set(handler.definition.name, handler);
  }

  public listTools(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  public getTool(name: string): McpToolHandler | undefined {
    const direct = this.tools.get(name);
    if (direct) return direct;

    // Check with/without review_yeti_ prefix
    if (name.startsWith('review_yeti_')) {
      const unprefixed = name.replace(/^review_yeti_/, '');
      if (this.tools.has(unprefixed)) return this.tools.get(unprefixed);
    } else {
      const prefixed = `review_yeti_${name}`;
      if (this.tools.has(prefixed)) return this.tools.get(prefixed);
    }

    // Common legacy aliases
    if (name === 'review_yeti_get_review_findings' || name === 'get_review_findings') {
      return this.tools.get('review_yeti_query_findings');
    }

    return undefined;
  }

  public getSseSession(sessionId: string): SseSession | undefined {
    return this.sseSessions.get(sessionId);
  }

  public closeSseSession(sessionId: string): void {
    const session = this.sseSessions.get(sessionId);
    if (session) {
      try {
        session.controller.close();
      } catch {
        // Safe ignore
      }
      this.sseSessions.delete(sessionId);
    }
  }

  public async handleRpc(
    request: JsonRpcRequest,
    context: McpExecutionContext = {}
  ): Promise<JsonRpcResponse> {
    const id = request.id ?? null;

    if (request.jsonrpc !== '2.0') {
      return {
        jsonrpc: '2.0',
        id: id as any,
        error: {
          code: -32600,
          message: 'Invalid Request: jsonrpc must be "2.0"',
        },
      };
    }

    switch (request.method) {
      case 'initialize': {
        return {
          jsonrpc: '2.0',
          id: id as any,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            serverInfo: {
              name: MCP_SERVER_NAME,
              version: MCP_SERVER_VERSION,
            },
            capabilities: {
              tools: {
                listChanged: false,
              },
              resources: {
                subscribe: false,
                listChanged: false,
              },
            },
          },
        };
      }

      case 'ping': {
        return {
          jsonrpc: '2.0',
          id: id as any,
          result: {},
        };
      }

      case 'tools/list': {
        return {
          jsonrpc: '2.0',
          id: id as any,
          result: {
            tools: this.listTools(),
          },
        };
      }

      case 'tools/call': {
        const { name, arguments: args } = request.params || {};
        if (!name || typeof name !== 'string') {
          return {
            jsonrpc: '2.0',
            id: id as any,
            error: {
              code: -32602,
              message: 'Invalid params: "name" must be a non-empty string',
            },
          };
        }

        const tool = this.getTool(name);
        if (!tool) {
          return {
            jsonrpc: '2.0',
            id: id as any,
            error: {
              code: -32601,
              message: `Method not found: unknown tool "${name}"`,
            },
          };
        }

        // Validate inputs against tool definition schema before execution
        const validation = validateInputSchema(tool, args || {});
        if (!validation.valid) {
          return {
            jsonrpc: '2.0',
            id: id as any,
            error: {
              code: -32602,
              message: `Invalid params for "${name}": ${validation.error}`,
            },
          };
        }

        try {
          const result = await tool.execute(args || {}, context);
          return {
            jsonrpc: '2.0',
            id: id as any,
            result,
          };
        } catch (err: any) {
          console.error(`Tool execution error in ${name}:`, err);
          return {
            jsonrpc: '2.0',
            id: id as any,
            result: {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: `Tool execution failed in ${name}: an unexpected error occurred during execution.`,
                },
              ],
            },
          };
        }
      }

      case 'resources/list': {
        return {
          jsonrpc: '2.0',
          id: id as any,
          result: {
            resources: [
              {
                uri: 'reviewyeti://status/cloudflare',
                name: 'Review Yeti Cloudflare Control Plane Status',
                mimeType: 'application/json',
              },
              {
                uri: 'reviewyeti://metrics/runtime',
                name: 'Review Yeti Runtime Latency Percentiles (p50..p99)',
                mimeType: 'application/json',
              },
              {
                uri: 'reviewyeti://analytics/dashboard',
                name: 'Review Yeti KPI & Engineering Analytics Dashboard',
                mimeType: 'application/json',
              },
            ],
          },
        };
      }

      case 'resources/read': {
        const uri = request.params?.uri;
        if (!uri || typeof uri !== 'string') {
          return {
            jsonrpc: '2.0',
            id: id as any,
            error: { code: -32602, message: 'Invalid params: "uri" required' },
          };
        }

        try {
          if (uri === 'reviewyeti://status/cloudflare') {
            const res = await this.getTool('review_yeti_get_cloudflare_status')?.execute({}, context);
            return {
              jsonrpc: '2.0',
              id: id as any,
              result: {
                contents: [{ uri, mimeType: 'application/json', text: extractTextContent(res) }],
              },
            };
          }

          if (uri === 'reviewyeti://metrics/runtime') {
            const res = await this.getTool('review_yeti_get_runtime_metrics')?.execute({}, context);
            return {
              jsonrpc: '2.0',
              id: id as any,
              result: {
                contents: [{ uri, mimeType: 'application/json', text: extractTextContent(res) }],
              },
            };
          }

          if (uri === 'reviewyeti://analytics/dashboard') {
            const res = await this.getTool('review_yeti_get_analytics_dashboard')?.execute({}, context);
            return {
              jsonrpc: '2.0',
              id: id as any,
              result: {
                contents: [{ uri, mimeType: 'application/json', text: extractTextContent(res) }],
              },
            };
          }
        } catch (err: any) {
          console.error(`Error reading resource ${uri}:`, err);
          return {
            jsonrpc: '2.0',
            id: id as any,
            error: { code: -32603, message: `Internal error reading resource "${uri}"` },
          };
        }

        return {
          jsonrpc: '2.0',
          id: id as any,
          error: { code: -32602, message: `Resource not found: "${uri}"` },
        };
      }

      default: {
        return {
          jsonrpc: '2.0',
          id: id as any,
          error: {
            code: -32601,
            message: `Method not found: "${request.method}"`,
          },
        };
      }
    }
  }

  public async handleHttpRequest(request: Request, env: any): Promise<Response> {
    const url = new URL(request.url);
    const reqOrigin = request.headers.get('Origin') || '';
    const configuredOrigins = String(env?.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((entry: string) => entry.trim())
      .filter(Boolean);
    const matchesConfigured = (origin: string): boolean =>
      configuredOrigins.some((entry: string) => {
        if (entry.startsWith('*.')) {
          try {
            const u = new URL(origin);
            return u.protocol === 'https:' && u.hostname.endsWith(entry.slice(1));
          } catch {
            return false;
          }
        }
        return origin === entry;
      });
    const isAllowedOrigin =
      !reqOrigin ||
      matchesConfigured(reqOrigin) ||
      reqOrigin.startsWith('http://localhost:') ||
      reqOrigin.startsWith('http://127.0.0.1:');
    const fallbackOrigin =
      configuredOrigins.find((entry: string) => !entry.startsWith('*.')) ?? url.origin;
    const allowedOrigin = isAllowedOrigin && reqOrigin ? reqOrigin : fallbackOrigin;

    const corsHeaders: Record<string, string> = {
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, mcp-session-id',
      'Access-Control-Expose-Headers': 'Mcp-Session-Id',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Constant-time Authentication
    const authHeader = request.headers.get('Authorization') || '';
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : (request.headers.get('x-api-key') || url.searchParams.get('token') || '').trim();
    const configuredToken = (env.REVIEW_YETI_MCP_AUTH_TOKEN || '').trim();

    let isAuthenticated = false;
    if (configuredToken) {
      isAuthenticated = constantTimeEquals(token, configuredToken);
      if (!isAuthenticated && request.method === 'POST' && env?.PUBLIC_READ_MCP !== 'true') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32000, message: 'Unauthorized: Invalid or missing MCP authorization token' },
          }),
          { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
      }
    }

    // 1. SSE Transport: GET /api/mcp/sse, GET /mcp/sse, or Accept: text/event-stream
    const isSseRequest =
      url.pathname.endsWith('/sse') ||
      request.headers.get('Accept')?.includes('text/event-stream');

    if (request.method === 'GET' && isSseRequest) {
      if (configuredToken && !isAuthenticated && env?.PUBLIC_READ_MCP !== 'true') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32000, message: 'Unauthorized: Invalid or missing MCP authorization token' },
          }),
          { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
      }

      const sessionId = crypto.randomUUID();
      const encoder = new TextEncoder();
      const basePath = url.pathname.startsWith('/mcp') ? '/mcp' : '/api/mcp';

      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          this.sseSessions.set(sessionId, {
            id: sessionId,
            controller,
            createdAt: Date.now(),
          });
          const endpointUri = `${basePath}/messages?sessionId=${sessionId}`;
          controller.enqueue(encoder.encode(`event: endpoint\ndata: ${endpointUri}\n\n`));
        },
        cancel: () => {
          this.sseSessions.delete(sessionId);
        },
      });

      return new Response(stream, {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'Mcp-Session-Id': sessionId,
        },
      });
    }

    // 2. SSE Inbound Messages: POST /api/mcp/messages or POST /mcp/messages
    if (request.method === 'POST' && url.pathname.endsWith('/messages')) {
      const sessionId =
        url.searchParams.get('sessionId') ||
        request.headers.get('mcp-session-id') ||
        '';

      const session = this.sseSessions.get(sessionId);
      if (!session) {
        return Response.json(
          {
            jsonrpc: '2.0',
            id: null,
            error: { code: -32001, message: 'Session expired or not found' },
          },
          { status: 404, headers: corsHeaders }
        );
      }

      let rpcBody: any;
      try {
        rpcBody = await request.json();
      } catch {
        return Response.json(
          {
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'Parse error: invalid JSON' },
          },
          { status: 400, headers: corsHeaders }
        );
      }

      // Check auth if configured
      if (configuredToken && !isAuthenticated && env?.PUBLIC_READ_MCP !== 'true') {
        return Response.json(
          {
            jsonrpc: '2.0',
            id: rpcBody?.id ?? null,
            error: { code: -32000, message: 'Unauthorized: Invalid or missing MCP authorization token' },
          },
          { status: 401, headers: corsHeaders }
        );
      }

      const encoder = new TextEncoder();
      // Asynchronously handle and push to SSE stream
      void (async () => {
        try {
          if (Array.isArray(rpcBody)) {
            const responses = await Promise.all(
              rpcBody.map((item) => this.handleRpc(item, { env }))
            );
            session.controller.enqueue(
              encoder.encode(`event: message\ndata: ${JSON.stringify(responses)}\n\n`)
            );
          } else {
            const response = await this.handleRpc(rpcBody, { env });
            session.controller.enqueue(
              encoder.encode(`event: message\ndata: ${JSON.stringify(response)}\n\n`)
            );
          }
        } catch (err: any) {
          console.error('Error dispatching message over SSE stream:', err);
        }
      })();

      return Response.json(
        { status: 'accepted', sessionId },
        { status: 202, headers: { ...corsHeaders, 'Mcp-Session-Id': sessionId } }
      );
    }

    // 3. GET /api/mcp or /mcp: Tool list & server info
    if (request.method === 'GET') {
      return Response.json(
        {
          name: MCP_SERVER_NAME,
          version: MCP_SERVER_VERSION,
          protocolVersion: MCP_PROTOCOL_VERSION,
          toolsCount: this.tools.size,
          tools: this.listTools().map((t) => ({ name: t.name, description: t.description })),
        },
        { headers: corsHeaders }
      );
    }

    // 4. POST /api/mcp or /mcp: JSON-RPC execution (Streamable HTTP)
    if (request.method === 'POST') {
      let rpcBody: any;
      try {
        rpcBody = await request.json();
      } catch {
        return Response.json(
          {
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'Parse error: invalid JSON' },
          },
          { status: 400, headers: corsHeaders }
        );
      }

      // Handle batch JSON-RPC request
      if (Array.isArray(rpcBody)) {
        if (rpcBody.length === 0) {
          return Response.json(
            {
              jsonrpc: '2.0',
              id: null,
              error: { code: -32600, message: 'Invalid Request: batch is empty' },
            },
            { status: 400, headers: corsHeaders }
          );
        }

        // Check if any tool in batch is mutating
        const hasMutating = rpcBody.some(
          (req) =>
            req?.method === 'tools/call' &&
            typeof req?.params?.name === 'string' &&
            MUTATING_TOOL_NAMES.has(req.params.name)
        );
        if (configuredToken && !isAuthenticated && (hasMutating || env?.PUBLIC_READ_MCP !== 'true')) {
          return Response.json(
            {
              jsonrpc: '2.0',
              id: null,
              error: { code: -32000, message: 'Unauthorized: Invalid or missing MCP authorization token' },
            },
            { status: 401, headers: corsHeaders }
          );
        }

        const responses = await Promise.all(
          rpcBody.map((item) => this.handleRpc(item, { env }))
        );
        return Response.json(responses, { headers: corsHeaders });
      }

      const rpcRequest = rpcBody as JsonRpcRequest;
      const isMutating =
        rpcRequest.method === 'tools/call' &&
        typeof rpcRequest.params?.name === 'string' &&
        MUTATING_TOOL_NAMES.has(rpcRequest.params.name);
      const isPublicReadAllowed = env?.PUBLIC_READ_MCP === 'true' && !isMutating;

      if (
        (rpcRequest.method === 'tools/call' ||
          rpcRequest.method === 'resources/read' ||
          rpcRequest.method === 'resources/list') &&
        !isPublicReadAllowed
      ) {
        const target =
          rpcRequest.method === 'tools/call'
            ? `Tool "${rpcRequest.params?.name || 'unknown'}"`
            : `Resource "${rpcRequest.params?.uri || 'unknown'}"`;
        if (!isAuthenticated) {
          const reason = !configuredToken
            ? `Unauthorized: ${target} requires authentication. Configure REVIEW_YETI_MCP_AUTH_TOKEN.`
            : `Unauthorized: Invalid or missing MCP authorization token.`;
          return Response.json(
            {
              jsonrpc: '2.0',
              id: rpcRequest.id ?? null,
              error: {
                code: -32000,
                message: reason,
              },
            },
            { status: 401, headers: corsHeaders }
          );
        }
      }

      const response = await this.handleRpc(rpcRequest, { env });
      return Response.json(response, { headers: corsHeaders });
    }

    return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });
  }
}

export const defaultMcpRouter = new McpRouter();
