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
} from './tools/index.js';

export const MUTATING_TOOL_NAMES = new Set([
  'review_yeti_trigger_review',
  'review_yeti_cancel_review',
  'review_yeti_purge_cache',
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

export class McpRouter {
  private readonly tools = new Map<string, McpToolHandler>();

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
  }

  public registerTool(handler: McpToolHandler): void {
    this.tools.set(handler.definition.name, handler);
  }

  public listTools(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  public getTool(name: string): McpToolHandler | undefined {
    return this.tools.get(name);
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
    // 1. Scoped CORS headers (reject wildcard * on mutating control endpoint)
    const reqOrigin = request.headers.get('Origin') || '';
    const isAllowedOrigin =
      !reqOrigin ||
      reqOrigin === 'https://review-bot.example.com' ||
      reqOrigin.endsWith('.example.com') ||
      reqOrigin.startsWith('http://localhost:') ||
      reqOrigin.startsWith('http://127.0.0.1:');
    const allowedOrigin = isAllowedOrigin && reqOrigin ? reqOrigin : 'https://review-bot.example.com';

    const corsHeaders: Record<string, string> = {
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // 2. Constant-time Authentication
    const authHeader = request.headers.get('Authorization') || '';
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : (request.headers.get('x-api-key') || '').trim();
    const configuredToken = (env.REVIEW_YETI_MCP_AUTH_TOKEN || '').trim();

    let isAuthenticated = false;
    if (configuredToken) {
      isAuthenticated = constantTimeEquals(token, configuredToken);
      if (!isAuthenticated && request.method === 'POST') {
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

    // 3. GET /api/mcp info or tool list
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

    // 4. POST /api/mcp JSON-RPC execution
    if (request.method === 'POST') {
      let rpcRequest: JsonRpcRequest;
      try {
        rpcRequest = (await request.json()) as JsonRpcRequest;
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

      // Authorization check: mutating tools always require authentication.
      // Read-only tools and resources require authentication unless PUBLIC_READ_MCP === 'true'.
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

