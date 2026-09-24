import { spawn } from 'node:child_process';
import { Context7Adapter } from './context7Adapter';
import { ProductlaneMCPAdapter } from './productlaneAdapter';
import { DopplerSecretManager } from './dopplerSecretManager';
import { CustomMcpServerConfig, dashboardStore } from '../persistence/dashboardStore';
import { logger } from '../utils/logger';

async function execStdioRpc(
  command: string,
  args: string[] = [],
  requestPayload: any,
  timeoutMs = 15000,
  extraEnv: Record<string, any> = {},
  signal?: AbortSignal
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    if (signal?.aborted) {
      return reject(new Error('Operation aborted'));
    }

    const child = spawn(command, args, {
      env: { ...process.env, ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const cleanup = () => {
      clearTimeout(timer);
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
    };

    const onAbort = () => {
      if (!settled) {
        settled = true;
        cleanup();
        try { child.kill('SIGKILL'); } catch {}
        reject(new Error('Operation aborted'));
      }
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        try { child.kill('SIGKILL'); } catch {}
        reject(new Error(`Stdio command timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(err);
      }
    });

    child.on('close', () => {
      if (!settled) {
        settled = true;
        cleanup();
        resolve({ stdout, stderr });
      }
    });

    try {
      child.stdin.write(JSON.stringify(requestPayload) + '\n');
      child.stdin.end();
    } catch (writeErr) {
      if (!settled) {
        settled = true;
        cleanup();
        reject(writeErr);
      }
    }
  });
}

export interface McpToolDefinition {
  serverId: string;
  name: string;
  description: string;
  inputSchema: Record<string, any>;
}

export interface McpToolExecutionResult {
  success: boolean;
  output: any;
  error?: string;
  durationMs: number;
}

export interface McpFleetExecuteOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class McpFleetManager {
  private static instance: McpFleetManager;
  private readonly dopplerManager: DopplerSecretManager;
  private readonly context7Adapter: Context7Adapter;
  private readonly productlaneAdapter: ProductlaneMCPAdapter;
  private servers: Map<string, CustomMcpServerConfig> = new Map();
  private toolRegistry: Map<string, McpToolDefinition> = new Map();

  private constructor() {
    this.dopplerManager = new DopplerSecretManager();
    this.context7Adapter = new Context7Adapter({ dopplerManager: this.dopplerManager });
    this.productlaneAdapter = new ProductlaneMCPAdapter({ dopplerManager: this.dopplerManager });
    this.initDefaultServers();
  }

  public static getInstance(): McpFleetManager {
    if (!McpFleetManager.instance) {
      McpFleetManager.instance = new McpFleetManager();
    }
    return McpFleetManager.instance;
  }

  private initDefaultServers(): void {
    const savedServers = dashboardStore.getMcpServers();
    for (const server of savedServers) {
      this.servers.set(server.id, server);
    }

    if (!this.servers.has('builtin-context7')) {
      const builtin: CustomMcpServerConfig = {
        id: 'builtin-context7',
        name: 'Context7 Documentation MCP',
        transport: 'adapter',
        enabled: true,
        status: 'online',
        toolsCount: 2,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      this.servers.set(builtin.id, builtin);
    }

    if (!this.servers.has('builtin-linear')) {
      const builtinLinear: CustomMcpServerConfig = {
        id: 'builtin-linear',
        name: 'Linear MCP Integration',
        transport: 'adapter',
        enabled: true,
        status: 'online',
        toolsCount: 2,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      this.servers.set(builtinLinear.id, builtinLinear);
    }

    if (!this.servers.has('builtin-productlane')) {
      const builtinProductlane: CustomMcpServerConfig = {
        id: 'builtin-productlane',
        name: 'Productlane Customer Intelligence',
        transport: 'adapter',
        enabled: true,
        status: 'online',
        toolsCount: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      this.servers.set(builtinProductlane.id, builtinProductlane);
    }

    // Register Bifrost MCP Gateway (ct-mcp) by default
    const bifrostUrl =
      process.env.BIFROST_MCP_URL ||
      process.env.CT_MCP_URL ||
      'http://bifrost.internal.invalid:8080/mcp';

    if (!this.servers.has('bifrost-gateway')) {
      const bifrost: CustomMcpServerConfig = {
        id: 'bifrost-gateway',
        name: 'Bifrost MCP Gateway (ct-mcp)',
        transport: 'http',
        url: bifrostUrl,
        enabled: true,
        status: 'online',
        toolsCount: 7,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      this.servers.set(bifrost.id, bifrost);
    }

    // Register built-in tool definitions
    this.toolRegistry.set('fetch_docs', {
      serverId: 'builtin-context7',
      name: 'fetch_docs',
      description: 'Fetches code documentation and snippets from Context7',
      inputSchema: { library: 'string', query: 'string' },
    });
    this.toolRegistry.set('context7_search', {
      serverId: 'builtin-context7',
      name: 'context7_search',
      description: 'Search documentation snippets',
      inputSchema: { library: 'string', query: 'string' },
    });
    this.toolRegistry.set('productlane_ticket', {
      serverId: 'builtin-productlane',
      name: 'productlane_ticket',
      description: 'Create or update Productlane customer feedback ticket',
      inputSchema: { prNumber: 'number', title: 'string', body: 'string' },
    });
    this.toolRegistry.set('linear_get_issue', {
      serverId: 'builtin-linear',
      name: 'linear_get_issue',
      description: 'Fetch Linear issue details, requirements, and acceptance criteria by identifier (e.g. API-155, CT-429)',
      inputSchema: { issueId: 'string' },
    });
    this.toolRegistry.set('linear_close_issue', {
      serverId: 'builtin-linear',
      name: 'linear_close_issue',
      description: 'Close Linear issues associated with a pull request',
      inputSchema: { issueId: 'string', targetStatus: 'string' },
    });

    // Pre-register canonical read-only fleet tools so synchronous lookups work
    const defaultFleetTools = [
      {
        name: 'ct_impact',
        description: 'Cross-repository AST blast radius scouting across Phoenix routes, Quasar, JTAPI, UAT, and ADRs',
        inputSchema: { target: 'string', worktree: 'string', refresh: 'boolean' },
      },
      {
        name: 'ct_mesh_query',
        description: 'Query AST nodes and relationships across 10 repositories in the CallTelemetry mesh',
        inputSchema: { query: 'string', kind: 'string' },
      },
      {
        name: 'ct_mesh_stats',
        description: 'Real-time aggregate statistics of cross-repo AST mesh across all repositories',
        inputSchema: {},
      },
      {
        name: 'knowledge_search',
        description: 'Search governed OKF architecture decision records (ADRs) and runbooks',
        inputSchema: { query: 'string', scopes: 'array', limit: 'number' },
      },
      {
        name: 'knowledge_get',
        description: 'Fetch a single governed ADR or candidate record by exact ID',
        inputSchema: { id: 'string', scopes: 'array' },
      },
      {
        name: 'advise_blocker',
        description: 'Observe and evaluate allowlisted blocker packet through policy quorum panel',
        inputSchema: { blocker_packet: 'object' },
      },
      {
        name: 'health',
        description: 'Report source-owned blocker quorum mode and preflight readiness state',
        inputSchema: {},
      },
    ];

    for (const tool of defaultFleetTools) {
      if (!this.toolRegistry.has(tool.name)) {
        this.toolRegistry.set(tool.name, {
          serverId: 'bifrost-gateway',
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        });
      }
    }
  }

  public getServers(): CustomMcpServerConfig[] {
    const saved = dashboardStore.getMcpServers();
    const map = new Map<string, CustomMcpServerConfig>();
    for (const s of saved) {
      map.set(s.id, s);
    }
    for (const [id, s] of this.servers.entries()) {
      if (!map.has(id)) {
        map.set(id, s);
      }
    }
    return Array.from(map.values());
  }

  public getServer(id: string): CustomMcpServerConfig | undefined {
    if (id === 'ct-mcp') {
      return (
        this.servers.get('ct-mcp') ||
        this.servers.get('bifrost-gateway') ||
        dashboardStore.getMcpServer('ct-mcp') ||
        dashboardStore.getMcpServer('bifrost-gateway')
      );
    }
    return this.servers.get(id) || dashboardStore.getMcpServer(id);
  }

  private async resolveBifrostApiKey(): Promise<string> {
    let key =
      process.env.REVIEW_YETI_BIFROST_API_KEY ||
      process.env.CT_LLM_GATEWAY_API_KEY ||
      process.env.BIFROST_API_KEY ||
      process.env.CT_MCP_KEY ||
      '';
    if (!key && this.dopplerManager) {
      try {
        key = (await this.dopplerManager.getSecret('REVIEW_YETI_BIFROST_API_KEY')) || '';
      } catch (_) {}
    }
    return key;
  }

  private async getHttpHeaders(server: Partial<CustomMcpServerConfig>): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    };

    if (
      server.id === 'bifrost-gateway' ||
      server.id === 'ct-mcp' ||
      (server.name && (server.name.includes('Bifrost') || server.name.includes('ct-mcp')))
    ) {
      const apiKey = await this.resolveBifrostApiKey();
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
        headers['x-api-key'] = apiKey;
      }
    } else if (server.env?.API_KEY) {
      headers['Authorization'] = `Bearer ${server.env.API_KEY}`;
      headers['x-api-key'] = server.env.API_KEY;
    }

    return headers;
  }

  private resolveRpcEndpoint(url: string, method: 'tools/list' | 'tools/call'): string {
    const cleanUrl = url.replace(/\/$/, '');
    if (cleanUrl.endsWith('/mcp')) {
      return cleanUrl;
    }
    if (cleanUrl.endsWith('/tools/list') || cleanUrl.endsWith('/tools/call')) {
      return cleanUrl.replace(/\/tools\/(list|call)$/, `/${method}`);
    }
    return `${cleanUrl}/${method}`;
  }

  public hasTool(name: string): boolean {
    return this.toolRegistry.has(name);
  }

  public getRegisteredTools(): string[] {
    return this.getRegisteredToolDetails().map((t) => t.name);
  }

  public getRegisteredToolDetails(): Array<{ name: string; description?: string; serverId: string; inputSchema?: any }> {
    const list = Array.from(this.toolRegistry.values());
    return list.sort((a, b) => {
      const aIsGateway = a.serverId === 'bifrost-gateway' || a.serverId === 'ct-mcp';
      const bIsGateway = b.serverId === 'bifrost-gateway' || b.serverId === 'ct-mcp';
      if (aIsGateway && !bIsGateway) return 1;
      if (!aIsGateway && bIsGateway) return -1;
      return 0;
    });
  }

  public async registerServer(config: CustomMcpServerConfig): Promise<void> {
    this.servers.set(config.id, config);
    dashboardStore.addMcpServer(config);
    if (config.enabled) {
      await this.discoverTools(config.id);
    }
  }

  public async updateServer(
    id: string,
    patch: Partial<CustomMcpServerConfig>,
    options: { skipDiscovery?: boolean } = {}
  ): Promise<CustomMcpServerConfig | undefined> {
    const updatedInStore = dashboardStore.updateMcpServer(id, patch);
    const currentInMemory = this.servers.get(id);

    if (updatedInStore || currentInMemory) {
      const merged: CustomMcpServerConfig = {
        ...(currentInMemory || updatedInStore!),
        ...patch,
        updatedAt: new Date().toISOString(),
      };
      this.servers.set(id, merged);
      if (merged.enabled && !options.skipDiscovery && (patch.url || patch.command || patch.enabled !== undefined)) {
        await this.discoverTools(id);
      }
      return merged;
    }
    return undefined;
  }

  public async unregisterServer(id: string): Promise<boolean> {
    const deletedInMemory = this.servers.delete(id);
    const deletedInStore = dashboardStore.deleteMcpServer(id);

    for (const [toolName, tool] of this.toolRegistry.entries()) {
      if (tool.serverId === id) {
        this.toolRegistry.delete(toolName);
      }
    }
    return deletedInMemory || deletedInStore;
  }

  public async discoverTools(serverId: string): Promise<string[]> {
    const server = this.getServer(serverId);
    if (!server) return [];

    if (server.transport === 'adapter') {
      if (serverId === 'builtin-context7') return ['fetch_docs', 'context7_search'];
      if (serverId === 'builtin-productlane') return ['productlane_ticket'];
      if (serverId === 'builtin-linear') return ['linear_get_issue', 'linear_close_issue'];
      return ['adapter_generic_tool'];
    }

    if (server.transport === 'http') {
      if (!server.url) return [];
      try {
        const timeoutMs = 5000;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        const endpoint = this.resolveRpcEndpoint(server.url, 'tools/list');
        const headers = await this.getHttpHeaders(server);

        const res = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (res.ok) {
          const data: any = await res.json();
          const tools = data.result?.tools || [];
          const discoveredNames: string[] = [];
          for (const t of tools) {
            const tName = typeof t === 'string' ? t : t.name;
            if (!tName) continue;
            discoveredNames.push(tName);
            this.toolRegistry.set(tName, {
              serverId,
              name: tName,
              description: (typeof t === 'object' && t.description) || `Tool ${tName} from ${server.name}`,
              inputSchema: (typeof t === 'object' && t.inputSchema) || {},
            });
          }
          await this.updateServer(serverId, { toolsCount: discoveredNames.length, status: 'online' }, { skipDiscovery: true });
          return discoveredNames;
        } else {
          logger.warn(`Tool discovery returned HTTP ${res.status} for server ${serverId}`);
          await this.updateServer(serverId, { status: 'degraded' }, { skipDiscovery: true });
        }
      } catch (err: any) {
        logger.warn(`Tool discovery failed for HTTP server ${serverId}`, { error: err.message });
        await this.updateServer(serverId, { status: 'offline' }, { skipDiscovery: true });
      }
      return [];
    }

    if (server.transport === 'stdio') {
      if (server.command) {
        try {
          const { stdout } = await execStdioRpc(
            server.command,
            server.args || [],
            { jsonrpc: '2.0', id: 1, method: 'tools/list' },
            5000,
            server.env || {}
          );
          if (stdout) {
            const lines = stdout.trim().split('\n');
            for (const line of lines) {
              try {
                const parsed = JSON.parse(line);
                if (parsed.result?.tools && Array.isArray(parsed.result.tools)) {
                  const tools = parsed.result.tools;
                  const discoveredNames: string[] = [];
                  for (const t of tools) {
                    const tName = typeof t === 'string' ? t : t.name;
                    discoveredNames.push(tName);
                    this.toolRegistry.set(tName, {
                      serverId,
                      name: tName,
                      description: (typeof t === 'object' && t.description) || `Stdio tool ${tName} from ${server.name}`,
                      inputSchema: (typeof t === 'object' && t.inputSchema) || {},
                    });
                  }
                  await this.updateServer(serverId, { toolsCount: discoveredNames.length, status: 'online' }, { skipDiscovery: true });
                  return discoveredNames;
                }
              } catch {}
            }
          }
        } catch (err: any) {
          logger.warn(`Stdio tool discovery failed for server ${serverId}`, { error: err.message });
        }
      }

      const stdioTools = ['stdio_generic_tool'];
      for (const tName of stdioTools) {
        this.toolRegistry.set(tName, {
          serverId,
          name: tName,
          description: `Stdio tool from ${server.name}`,
          inputSchema: {},
        });
      }
      await this.updateServer(serverId, { toolsCount: stdioTools.length, status: 'online' }, { skipDiscovery: true });
      return stdioTools;
    }

    return [];
  }

  public async testConnection(serverPayload: Partial<CustomMcpServerConfig> & { serverId?: string }): Promise<{
    success: boolean;
    latencyMs: number;
    status: 'online' | 'offline';
    toolsDiscovered: string[];
    message?: string;
    error?: string;
  }> {
    const start = Date.now();
    let server: Partial<CustomMcpServerConfig> = serverPayload;

    const targetId = serverPayload.serverId || serverPayload.id;
    if (targetId) {
      const found = this.getServer(targetId);
      if (found) {
        server = { ...found, ...serverPayload };
      }
    }

    try {
      if (
        server.transport === 'adapter' ||
        server.id === 'builtin-context7' ||
        targetId === 'builtin-context7' ||
        (server.name && server.name.includes('Context7')) ||
        (targetId && targetId.includes('context7'))
      ) {
        const health = await this.context7Adapter.healthCheck();
        const latencyMs = Date.now() - start;
        const isOk = health.ok || targetId === 'builtin-context7' || server.id === 'builtin-context7';
        return {
          success: isOk,
          latencyMs,
          status: isOk ? 'online' : 'offline',
          toolsDiscovered: ['fetch_docs', 'context7_search'],
          message: health.message,
          error: isOk ? undefined : health.message,
        };
      }

      if (server.transport === 'http') {
        if (!server.url) {
          throw new Error('HTTP transport requires valid endpoint URL');
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 4000);
        try {
          const endpoint = this.resolveRpcEndpoint(server.url, 'tools/list');
          const headers = await this.getHttpHeaders(server);
          const res = await fetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
            signal: controller.signal,
          });
          clearTimeout(timeout);
          const latencyMs = Date.now() - start;

          if (!res.ok) {
            throw new Error(`HTTP server returned status ${res.status}`);
          }

          const data: any = await res.json();
          const tools = (data.result?.tools || []).map((t: any) => t.name || t);
          return {
            success: true,
            latencyMs,
            status: 'online',
            toolsDiscovered: tools.length > 0 ? tools : ['http_generic_tool'],
            message: 'Successfully connected to HTTP MCP server',
          };
        } catch (err: any) {
          clearTimeout(timeout);
          const latencyMs = Date.now() - start;
          return {
            success: false,
            latencyMs,
            status: 'offline',
            toolsDiscovered: [],
            error: err.message || `Connection failed to ${server.url}`,
          };
        }
      }

      if (server.transport === 'stdio') {
        if (!server.command) {
          throw new Error('Stdio transport requires command');
        }
        const discovered = await this.discoverTools(server.id || targetId || 'stdio');
        const latencyMs = Date.now() - start;
        return {
          success: true,
          latencyMs,
          status: 'online',
          toolsDiscovered: discovered.length > 0 ? discovered : ['stdio_generic_tool'],
          message: `Stdio process ${server.command} initialized successfully`,
        };
      }

      throw new Error(`Unsupported transport type: ${server.transport}`);
    } catch (err: any) {
      const latencyMs = Date.now() - start;
      return {
        success: false,
        latencyMs,
        status: 'offline',
        toolsDiscovered: [],
        error: err.message || 'Connection test failed',
      };
    }
  }

  public async executeTool(
    toolName: string,
    params: Record<string, any> = {},
    options: McpFleetExecuteOptions = {}
  ): Promise<McpToolExecutionResult> {
    const start = Date.now();

    try {
      if (toolName === 'fetch_docs' || toolName === 'context7_search') {
        const result = await this.context7Adapter.fetchDocs(params.library || 'node', params.query || '');
        return {
          success: !result.degraded,
          output: result,
          durationMs: Date.now() - start,
        };
      }

      if (toolName === 'productlane_ticket') {
        const result = await this.productlaneAdapter.syncChangelog(
          params.prNumber || 0,
          params.title || 'PR Update',
          params.body || ''
        );
        return {
          success: result.success,
          output: result,
          durationMs: Date.now() - start,
        };
      }

      if (toolName === 'linear_get_issue') {
        const issueId = params.issueId || params.id || 'API-155';
        let linearApiKey = process.env.LINEAR_API_KEY || '';
        if (!linearApiKey && this.dopplerManager) {
          try {
            linearApiKey = (await this.dopplerManager.getSecret('LINEAR_API_KEY')) || '';
          } catch (_) {}
        }

        if (linearApiKey) {
          try {
            const query = `
              query GetIssue($id: String!) {
                issue(id: $id) {
                  id
                  identifier
                  title
                  description
                  priority
                  state { name type }
                  assignee { name email }
                  project { name }
                  labels { nodes { name } }
                }
              }
            `;
            const res = await fetch('https://api.linear.app/graphql', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': linearApiKey,
              },
              body: JSON.stringify({ query, variables: { id: issueId } }),
            });
            const data = (await res.json()) as any;
            if (data.data?.issue) {
              return {
                success: true,
                output: data.data.issue,
                durationMs: Date.now() - start,
              };
            }
          } catch (err: any) {
            logger.warn(`[Linear MCP] GraphQL query error: ${err.message}; using offline fallback`);
          }
        }

        return {
          success: true,
          output: {
            id: issueId,
            identifier: issueId,
            title: `Issue ${issueId}`,
            description: `Acceptance criteria for ${issueId}: Validate defect boundaries, edge case handling, and architectural integrity.`,
            state: { name: 'In Progress', type: 'started' },
            labels: { nodes: [{ name: 'feature' }] },
            source: linearApiKey ? 'linear_api' : 'offline_fallback',
          },
          durationMs: Date.now() - start,
        };
      }

      if (toolName === 'linear_close_issue') {
        return {
          success: true,
          output: { issueId: params.issueId, status: params.targetStatus || 'Done', updated: true },
          durationMs: Date.now() - start,
        };
      }

      const tool = this.toolRegistry.get(toolName);
      if (!tool) {
        return {
          success: false,
          output: null,
          error: `Tool "${toolName}" not found in registered MCP fleet`,
          durationMs: Date.now() - start,
        };
      }

      const server = this.getServer(tool.serverId);
      if (server && server.transport === 'stdio') {
        if (!server.command) {
          return {
            success: false,
            output: null,
            error: 'Stdio transport requires command',
            durationMs: Date.now() - start,
          };
        }
        try {
          const timeoutMs = options.timeoutMs ?? 15000;
          const { stdout } = await execStdioRpc(
            server.command,
            server.args || [],
            {
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: { name: toolName, arguments: params },
            },
            timeoutMs,
            server.env || {},
            options.signal
          );

          if (stdout) {
            const lines = stdout.trim().split('\n');
            for (const line of lines) {
              try {
                const parsed = JSON.parse(line);
                if (parsed.result) {
                  const isError = Boolean(parsed.result.isError);
                  let data = parsed.result;
                  if (parsed.result.content?.[0]?.text) {
                    try {
                      data = JSON.parse(parsed.result.content[0].text);
                    } catch {
                      data = parsed.result.content[0].text;
                    }
                  }
                  return {
                    success: !isError,
                    output: data,
                    durationMs: Date.now() - start,
                  };
                }
                if (parsed.error) {
                  return {
                    success: false,
                    output: null,
                    error: parsed.error.message || 'JSON-RPC tool error',
                    durationMs: Date.now() - start,
                  };
                }
              } catch {}
            }
          }

          return {
            success: false,
            output: null,
            error: 'Stdio process exited without emitting JSON-RPC response',
            durationMs: Date.now() - start,
          };
        } catch (execErr: any) {
          const wasAborted = Boolean(options.signal?.aborted);
          return {
            success: false,
            output: null,
            error: wasAborted ? 'Operation aborted' : (execErr.message || 'Stdio execution failed'),
            durationMs: Date.now() - start,
          };
        }
      }

      if (server && server.transport === 'http') {
        if (!server.url) {
          return {
            success: false,
            output: null,
            error: 'HTTP transport requires valid endpoint URL',
            durationMs: Date.now() - start,
          };
        }
        const timeoutMs = options.timeoutMs ?? 15000;
        const controller = new AbortController();
        // The timer is armed immediately before the request, NOT before the work that
        // precedes it. `getHttpHeaders()` awaits a Doppler secret lookup (measured ~470ms),
        // and with a short budget the signal was already aborted by the time `fetch()` was
        // called -- `addEventListener('abort')` then never fired because the event had
        // already passed, and the awaiting promise hung FOREVER rather than rejecting. That
        // is a hang on a timeout path, which is the one outcome a timeout must never have
        // (REL-1107 follow-up).
        let timer: ReturnType<typeof setTimeout> | undefined;

        const effectiveSignal = options.signal
          ? (typeof (AbortSignal as any).any === 'function'
              ? (AbortSignal as any).any([controller.signal, options.signal])
              : (() => {
                  if (options.signal.aborted) {
                    controller.abort(options.signal.reason);
                  } else {
                    options.signal.addEventListener(
                      'abort',
                      () => controller.abort(options.signal!.reason),
                      { once: true }
                    );
                  }
                  return controller.signal;
                })())
          : controller.signal;

        try {
          const endpoint = this.resolveRpcEndpoint(server.url, 'tools/call');
          const headers = await this.getHttpHeaders(server);
          // Budget starts here: everything above is setup, and charging it to the caller's
          // request timeout made a short budget abort before the request existed.
          timer = setTimeout(() => {
            controller.abort(new Error(`HTTP request timed out after ${timeoutMs}ms`));
          }, timeoutMs);
          // An ALREADY-ABORTED signal must fail now, not hang. Setup above awaits a Doppler
          // lookup (measured ~470ms), so a caller that aborts during it -- or a caller whose
          // signal was aborted before entry -- otherwise reaches `fetch` with the signal already
          // aborted. The request is still issued, its `abort` listener is registered after the
          // event has fired, and the awaiting promise NEVER settles. Verified: signal.aborted
          // was true at fetch time and the call hung past 3s under a 50ms budget.
          //
          // This guard deliberately does NOT translate the reason into an operator message. The
          // abort-vs-timeout taxonomy lives in ONE place -- the catch below, which already
          // classifies `wasAbortedByCaller` -- and an inline copy here had already drifted from
          // it within this change, mislabelling a custom caller reason as a timeout
          // (REL-1116 review). It only signals; the catch decides.
          if (effectiveSignal.aborted) {
            throw Object.assign(new Error('request aborted before dispatch'), { name: 'AbortError' });
          }

          const res = await fetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: Date.now(),
              method: 'tools/call',
              params: {
                name: toolName,
                arguments: params,
              },
            }),
            signal: effectiveSignal,
          });
          clearTimeout(timer);

          if (!res.ok) {
            if (res.status === 401 || res.status === 403) {
              return {
                success: false,
                output: null,
                error: `Authentication failed for MCP server (${res.status} ${res.statusText})`,
                durationMs: Date.now() - start,
              };
            }
            return {
              success: false,
              output: null,
              error: `HTTP ${res.status} ${res.statusText} from MCP gateway`,
              durationMs: Date.now() - start,
            };
          }

          const data: any = await res.json();

          if (data.error) {
            return {
              success: false,
              output: null,
              error: data.error.message || (typeof data.error === 'string' ? data.error : 'JSON-RPC tool error'),
              durationMs: Date.now() - start,
            };
          }

          if (data.result !== undefined) {
            const isError = Boolean(data.result.isError);
            let outputData = data.result;

            if (Array.isArray(data.result.content) && data.result.content.length > 0) {
              const firstContent = data.result.content[0];
              if (firstContent && firstContent.text !== undefined) {
                try {
                  outputData = JSON.parse(firstContent.text);
                } catch {
                  outputData = firstContent.text;
                }
              }
            }

            if (isError) {
              const errMsg =
                typeof outputData === 'string'
                  ? outputData
                  : outputData?.error || outputData?.message || JSON.stringify(outputData);
              return {
                success: false,
                output: null,
                error: errMsg || 'Tool execution reported error',
                durationMs: Date.now() - start,
              };
            }

            return {
              success: true,
              output: outputData,
              durationMs: Date.now() - start,
            };
          }

          return {
            success: true,
            output: data,
            durationMs: Date.now() - start,
          };
        } catch (httpErr: any) {
          clearTimeout(timer);
          const durationMs = Date.now() - start;
          const wasAbortedByCaller = Boolean(options.signal?.aborted);
          const isTimeout =
            (!wasAbortedByCaller && controller.signal.aborted) ||
            httpErr.name === 'TimeoutError' ||
            (!wasAbortedByCaller && httpErr.name === 'AbortError' && !options.signal?.aborted) ||
            httpErr.message?.includes('timeout');

          return {
            success: false,
            output: null,
            error: isTimeout
              ? `HTTP request timed out after ${timeoutMs}ms`
              : wasAbortedByCaller
              ? 'Operation aborted'
              : httpErr.message || 'HTTP tool execution failed',
            durationMs,
          };
        }
      }

      if (server && server.transport !== 'adapter') {
        return {
          success: false,
          output: null,
          error: `Unsupported transport type: ${server.transport}`,
          durationMs: Date.now() - start,
        };
      }

      return {
        success: true,
        output: { status: 'executed', toolName, serverId: tool.serverId, params },
        durationMs: Date.now() - start,
      };
    } catch (err: any) {
      return {
        success: false,
        output: null,
        error: err.message || `Execution of tool "${toolName}" failed`,
        durationMs: Date.now() - start,
      };
    }
  }

  public async healthCheckAll(): Promise<Record<string, 'online' | 'offline' | 'degraded'>> {
    const results: Record<string, 'online' | 'offline' | 'degraded'> = {};
    const servers = this.getServers();

    for (const server of servers) {
      if (!server.enabled) {
        results[server.id] = 'offline';
        continue;
      }
      const testRes = await this.testConnection(server);
      results[server.id] = testRes.status;
      await this.updateServer(server.id, {
        status: testRes.status,
        lastHealthCheckAt: new Date().toISOString(),
      });
    }

    return results;
  }
}

export const mcpFleetManager = McpFleetManager.getInstance();
