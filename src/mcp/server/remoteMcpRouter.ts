import { Router, type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import {
  MCP_PROTOCOL_VERSION,
  SERVER_NAME,
  SERVER_VERSION,
  JSONRPC_ERRORS,
  MCP_ERRORS,
  type ToolDefinition,
  type ToolResult,
  type InitializeResult,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcErrorResponse,
  buildJsonRpcResponse,
  buildJsonRpcError,
  buildToolResultText,
  buildToolResultJson,
  type McpExecutionContext,
} from './mcpTypes';
import {
  type McpAuthenticatedCaller,
  type McpAuthenticator,
  extractBearerToken,
  McpAuthError,
} from './mcpAuthenticator';
import { verifyRepositoryAccess, McpRbacError, formatRbacErrorResponse } from './mcpRbac';

import {
  createGetReviewStatusTool,
  createGetReviewFindingsTool,
  createGetModelMatrixTool,
  createTriggerReviewTool,
  createCancelReviewTool,
  createWatchReviewProgressTool,
  createPreflightDiffReviewTool,
  createExplainFindingTool,
  createGenerateFixDiffTool,
  createDisputeFindingTool,
  createAttestPrGateTool,
  createReplyReviewThreadTool,
} from './tools';

import {
  listResourceCatalog,
  readResourceContent,
  parseResourceUri,
} from './resources';

export type { McpExecutionContext };

export interface McpToolHandler {
  definition: ToolDefinition;
  schema?: any;
  execute(args: Record<string, unknown>, context: McpExecutionContext): Promise<ToolResult | unknown>;
}

export interface McpToolRegistry {
  listTools(): ToolDefinition[];
  getTool(name: string): McpToolHandler | undefined;
  registerTool?(handler: McpToolHandler): void;
}

export class DefaultMcpToolRegistry implements McpToolRegistry {
  private readonly tools = new Map<string, McpToolHandler>();

  public registerTool(handler: McpToolHandler): void {
    if (this.tools.has(handler.definition.name)) {
      throw new Error(`Tool already registered: ${handler.definition.name}`);
    }
    this.tools.set(handler.definition.name, handler);
  }

  public listTools(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  public getTool(name: string): McpToolHandler | undefined {
    return this.tools.get(name);
  }
}

export interface McpSessionState {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  identity?: string;
  sseResponse?: Response;
  keepAliveTimer?: NodeJS.Timeout;
  onCloseCallbacks: Array<() => void>;
  subscriptions: Set<string>;
}

export interface McpSessionManager {
  createSession(sseResponse?: Response): McpSessionState;
  getSession(sessionId: string): McpSessionState | undefined;
  touchSession(sessionId: string): void;
  closeSession(sessionId: string): void;
  reapIdleSessions(currentTime?: number): number;
  activeSessionCount(): number;
}

export interface RemoteMcpRouterOptions {
  db?: any;
  admissionRepository?: any;
  authenticator?: McpAuthenticator | {
    authenticate(req: Request | string): Promise<McpAuthenticatedCaller | { authenticated: boolean; identity?: string; error?: string }>;
    authorizeRepository?(identity: string | undefined, owner: string, repo: string): Promise<boolean> | boolean;
    checkRepositoryAccess?(caller: any, owner: string, repo: string): Promise<boolean> | boolean;
  };
  toolRegistry?: McpToolRegistry;
  tools?: McpToolHandler[] | ToolDefinition[];
  sessionManager?: McpSessionManager;
  sessionTtlMs?: number; // default: 1,800,000 (30m)
  maxSessions?: number; // default: 100
  keepAliveMs?: number; // default: 15,000 (15s)
  now?: () => number; // default: Date.now
  uuidGenerator?: () => string; // default: randomUUID
  triggerDeps?: any;
  cancelDeps?: any;
  watchDeps?: any;
  preflightDeps?: any;
  explainDeps?: any;
  generateFixDiffDeps?: any;
  disputeFindingDeps?: any;
  attestPrGateDeps?: any;
  replyReviewThreadDeps?: any;
}

export type RemoteMcpRouter = Router & {
  destroy(): void;
  sessionManager: McpSessionManager;
  toolRegistry: McpToolRegistry;
  notifyResourceUpdated(uri: string, payload?: any): number;
};

export function createDefaultToolRegistry(options?: {
  db?: any;
  admissionRepository?: any;
  matrixBuilder?: any;
  triggerDeps?: any;
  cancelDeps?: any;
  watchDeps?: any;
  preflightDeps?: any;
  explainDeps?: any;
  generateFixDiffDeps?: any;
  disputeFindingDeps?: any;
  attestPrGateDeps?: any;
  replyReviewThreadDeps?: any;
  notifyResourceUpdated?: (uri: string, payload?: any) => number;
}): McpToolRegistry {
  const registry = new DefaultMcpToolRegistry();
  const db = options?.db;

  registry.registerTool(createGetReviewStatusTool(db));
  registry.registerTool(createGetReviewFindingsTool(db));
  registry.registerTool(createGetModelMatrixTool(options?.matrixBuilder));
  registry.registerTool(createTriggerReviewTool({
    queryableDatabase: db,
    admissionRepository: options?.admissionRepository ?? options?.triggerDeps?.admissionRepository,
    ...options?.triggerDeps,
  }));
  registry.registerTool(createCancelReviewTool({ queryableDatabase: db, ...options?.cancelDeps }));
  registry.registerTool(createWatchReviewProgressTool(options?.watchDeps));
  registry.registerTool(createPreflightDiffReviewTool(options?.preflightDeps));
  registry.registerTool(createExplainFindingTool({ queryableDatabase: db, ...options?.explainDeps }));
  registry.registerTool(createGenerateFixDiffTool({ queryableDatabase: db, ...options?.generateFixDiffDeps }));
  registry.registerTool(createDisputeFindingTool({
    queryableDatabase: db,
    notifyResourceUpdated: options?.notifyResourceUpdated,
    ...options?.disputeFindingDeps,
  }));
  registry.registerTool(createAttestPrGateTool({ queryableDatabase: db, ...options?.attestPrGateDeps }));
  registry.registerTool(createReplyReviewThreadTool(options?.replyReviewThreadDeps));

  return registry;
}

export function createRemoteMcpRouter(options: RemoteMcpRouterOptions = {}): RemoteMcpRouter {
  const router = Router() as RemoteMcpRouter;
  const now = options.now ?? Date.now;
  const uuidGenerator = options.uuidGenerator ?? randomUUID;
  const sessionTtlMs = options.sessionTtlMs ?? 1_800_000;
  const maxSessions = options.maxSessions ?? 100;
  const keepAliveMs = options.keepAliveMs ?? 15_000;

  // Build or adapt tool registry
  let toolRegistry: McpToolRegistry;
  if (options.toolRegistry) {
    toolRegistry = options.toolRegistry;
  } else if (options.tools && Array.isArray(options.tools)) {
    const list: ToolDefinition[] = [];
    const map = new Map<string, McpToolHandler>();
    for (const item of options.tools) {
      if ('definition' in item && 'execute' in item) {
        map.set(item.definition.name, item as McpToolHandler);
        list.push(item.definition);
      } else {
        const def = item as ToolDefinition;
        list.push(def);
        map.set(def.name, {
          definition: def,
          execute: async (args) => buildToolResultText(`Executed ${def.name} with ${JSON.stringify(args)}`),
        });
      }
    }
    toolRegistry = {
      listTools: () => list,
      getTool: (name: string) => map.get(name),
    };
  } else {
    toolRegistry = createDefaultToolRegistry({
      ...options,
      notifyResourceUpdated: options.disputeFindingDeps?.notifyResourceUpdated || ((uri, payload) => router.notifyResourceUpdated(uri, payload)),
    });
  }

  // Session state map
  const sessions = new Map<string, McpSessionState>();

  function destroySession(id: string, _reason?: string): void {
    const session = sessions.get(id);
    if (!session) return;

    if (session.keepAliveTimer) {
      clearInterval(session.keepAliveTimer);
      session.keepAliveTimer = undefined;
    }

    if (session.sseResponse && !session.sseResponse.writableEnded) {
      try {
        session.sseResponse.end();
      } catch {
        // Safe ignore
      }
    }

    for (const cb of session.onCloseCallbacks) {
      try {
        cb();
      } catch {
        // Safe ignore
      }
    }

    sessions.delete(id);
  }

  function reapIdleSessions(currentTime = now()): number {
    const cutoff = currentTime - sessionTtlMs;
    let count = 0;
    for (const [id, session] of sessions.entries()) {
      if (session.lastSeenAt < cutoff) {
        destroySession(id, 'Session idle timeout');
        count++;
      }
    }
    return count;
  }

  // Background session reaper
  const reaperTimer = setInterval(() => {
    reapIdleSessions();
  }, Math.min(sessionTtlMs, 60_000));
  if (typeof reaperTimer.unref === 'function') {
    reaperTimer.unref();
  }

  const sessionManager: McpSessionManager = options.sessionManager || {
    createSession: (sseResponse?: Response) => {
      const id = uuidGenerator();
      const session: McpSessionState = {
        id,
        createdAt: now(),
        lastSeenAt: now(),
        sseResponse,
        onCloseCallbacks: [],
        subscriptions: new Set<string>(),
      };
      sessions.set(id, session);
      return session;
    },
    getSession: (sessionId: string) => {
      reapIdleSessions();
      return sessions.get(sessionId);
    },
    touchSession: (sessionId: string) => {
      const s = sessions.get(sessionId);
      if (s) s.lastSeenAt = now();
    },
    closeSession: (sessionId: string) => {
      destroySession(sessionId, 'Explicit close');
    },
    reapIdleSessions: (currentTime?: number) => reapIdleSessions(currentTime),
    activeSessionCount: () => {
      reapIdleSessions();
      return sessions.size;
    },
  };

  router.destroy = () => {
    clearInterval(reaperTimer);
    for (const id of Array.from(sessions.keys())) {
      destroySession(id, 'Router destroyed');
    }
  };

  router.sessionManager = sessionManager;
  router.toolRegistry = toolRegistry;

  router.notifyResourceUpdated = (uri: string, payload?: any): number => {
    let notifiedCount = 0;
    for (const session of sessions.values()) {
      if (session.subscriptions && (session.subscriptions.has(uri) || session.subscriptions.has('*'))) {
        if (session.sseResponse && !session.sseResponse.writableEnded) {
          const notification: any = {
            jsonrpc: '2.0',
            method: 'notifications/resources/updated',
            params: {
              uri,
            },
          };
          if (payload !== undefined) {
            notification.params.payload = payload;
          }
          session.sseResponse.write(`event: message\ndata: ${JSON.stringify(notification)}\n\n`);
          notifiedCount++;
        }
      }
    }
    return notifiedCount;
  };

  // Authentication helper
  async function resolveCaller(req: Request): Promise<McpAuthenticatedCaller> {
    if (req.mcpCaller) {
      return req.mcpCaller;
    }

    const token = extractBearerToken(req);
    if (!token) {
      throw new McpAuthError('Missing Bearer token');
    }

    if (options.authenticator) {
      // Check if authenticator takes (req) or (token)
      let authResult: any;
      try {
        if ('authenticate' in options.authenticator) {
          authResult = await options.authenticator.authenticate(req as any);
        }
      } catch (err) {
        if (err instanceof McpAuthError) throw err;
        throw new McpAuthError(err instanceof Error ? err.message : 'Invalid Bearer token');
      }

      if (authResult && typeof authResult === 'object') {
        if ('authType' in authResult) {
          return authResult as McpAuthenticatedCaller;
        }
        if (authResult.authenticated === true) {
          const caller: McpAuthenticatedCaller = {
            authType: 'static_token',
            tokenDigest: token.slice(0, 12),
            isAdmin: true,
            allowedRepositories: null,
            callerId: authResult.identity || 'authenticated-caller',
          };
          return caller;
        }
        throw new McpAuthError(authResult.error || 'Invalid Bearer token');
      }
    }

    // Default permissive if no authenticator configured in options
    return {
      authType: 'static_token',
      tokenDigest: token.slice(0, 12),
      isAdmin: true,
      allowedRepositories: null,
      callerId: 'test-caller',
    };
  }

  // Authorization helper
  async function checkAuthorization(caller: McpAuthenticatedCaller, owner: string, repo: string): Promise<boolean> {
    if (options.authenticator) {
      if ('authorizeRepository' in options.authenticator && typeof options.authenticator.authorizeRepository === 'function') {
        return Boolean(await options.authenticator.authorizeRepository(caller.callerId, owner, repo));
      }
      if ('checkRepositoryAccess' in options.authenticator && typeof options.authenticator.checkRepositoryAccess === 'function') {
        return Boolean(await options.authenticator.checkRepositoryAccess(caller, owner, repo));
      }
    }
    try {
      verifyRepositoryAccess(caller, owner, repo);
      return true;
    } catch {
      return false;
    }
  }

  // Core JSON-RPC Dispatcher
  async function dispatchJsonRpc(
    msg: any,
    caller: McpAuthenticatedCaller,
    req: Request,
    res: Response,
    explicitSession?: McpSessionState
  ): Promise<{ responseBody: any; statusCode: number; newSessionId?: string }> {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return {
        statusCode: 400,
        responseBody: buildJsonRpcError(msg?.id ?? null, JSONRPC_ERRORS.INVALID_REQUEST, 'Invalid Request'),
      };
    }

    const { id, method, params } = msg as JsonRpcRequest;

    switch (method) {
      case 'initialize': {
        let sessionId = explicitSession?.id;
        if (!sessionId) {
          if (sessionManager.activeSessionCount() >= maxSessions) {
            return {
              statusCode: 429,
              responseBody: buildJsonRpcError(
                null,
                MCP_ERRORS.TOO_MANY_SESSIONS,
                'Maximum concurrent MCP sessions exceeded'
              ),
            };
          }
          const session = sessionManager.createSession();
          sessionId = session.id;
        }

        const result: InitializeResult = {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {
            tools: { listChanged: true },
            resources: { subscribe: true, listChanged: true },
          },
          serverInfo: {
            name: SERVER_NAME,
            version: SERVER_VERSION,
          },
        };

        return {
          statusCode: 200,
          responseBody: buildJsonRpcResponse(id ?? null, result),
          newSessionId: sessionId,
        };
      }

      case 'notifications/initialized': {
        return {
          statusCode: 204,
          responseBody: null,
        };
      }

      case 'ping': {
        return {
          statusCode: 200,
          responseBody: buildJsonRpcResponse(id ?? null, {}),
        };
      }

      case 'tools/list': {
        const tools = toolRegistry.listTools();
        return {
          statusCode: 200,
          responseBody: buildJsonRpcResponse(id ?? null, { tools }),
        };
      }

      case 'tools/call': {
        const { name, arguments: args } = (params || {}) as {
          name?: string;
          arguments?: Record<string, unknown>;
        };

        if (!name || typeof name !== 'string') {
          return {
            statusCode: 200,
            responseBody: buildJsonRpcError(id ?? null, JSONRPC_ERRORS.INVALID_PARAMS, 'Invalid tool name'),
          };
        }

        const handler = toolRegistry.getTool(name);
        if (!handler) {
          return {
            statusCode: 200,
            responseBody: buildJsonRpcError(id ?? null, JSONRPC_ERRORS.METHOD_NOT_FOUND, `Tool not found: ${name}`),
          };
        }

        // RBAC / Tenancy check
        let toolArgs = (args || {}) as Record<string, unknown>;
        let targetOwner = typeof toolArgs.owner === 'string' ? toolArgs.owner.trim() : undefined;
        let targetRepo = typeof toolArgs.repo === 'string' ? toolArgs.repo.trim() : undefined;

        // Support single string parameter "owner/repo" format (e.g. preflight_diff_review)
        if (!targetOwner && targetRepo && targetRepo.includes('/')) {
          const slashIndex = targetRepo.indexOf('/');
          targetOwner = targetRepo.slice(0, slashIndex).trim();
          targetRepo = targetRepo.slice(slashIndex + 1).trim();
        } else if (!targetOwner && targetRepo && caller?.allowedRepositories) {
          // If unqualified repo is passed, resolve owner if caller has a matching repo in allowedRepositories
          for (const allowed of caller.allowedRepositories) {
            const [o, r] = allowed.split('/');
            if (r && r.toLowerCase() === targetRepo.toLowerCase()) {
              targetOwner = o;
              break;
            }
          }
        }

        // If exact empty string was passed for owner/repo, let schema validation reject with INVALID_PARAMS
        const hasEmptyStringCoordinate = toolArgs.owner === '' || toolArgs.repo === '';

        // If either coordinate is supplied, enforce repository RBAC (fail-closed if incomplete for non-admins)
        if (!hasEmptyStringCoordinate && (targetOwner || targetRepo)) {
          if (!caller.isAdmin && (!targetOwner || !targetRepo)) {
            return {
              statusCode: 403,
              responseBody: formatRbacErrorResponse(new McpRbacError(targetOwner || '', targetRepo || '')),
            };
          }

          const authorized = await checkAuthorization(caller, targetOwner || '', targetRepo || '');
          if (!authorized) {
            return {
              statusCode: 403,
              responseBody: formatRbacErrorResponse(new McpRbacError(targetOwner || '', targetRepo || '')),
            };
          }
        }

        // Runtime input validation via schema if defined on handler
        if ('schema' in handler && (handler as any).schema) {
          const parseResult = (handler as any).schema.safeParse(toolArgs);
          if (!parseResult.success) {
            return {
              statusCode: 200,
              responseBody: buildJsonRpcError(
                id ?? null,
                JSONRPC_ERRORS.INVALID_PARAMS,
                `Invalid parameters for tool ${name}: ${parseResult.error.issues.map((i: any) => i.message).join(', ')}`,
                parseResult.error.format()
              ),
            };
          }
          toolArgs = parseResult.data;
        }

        try {
          const context: McpExecutionContext = {
            sessionId: explicitSession?.id,
            caller,
            identity: caller.callerId,
          };
          const toolResult = await handler.execute(toolArgs, context);
          let normalizedResult: ToolResult;
          if (toolResult && typeof toolResult === 'object' && 'content' in toolResult) {
            normalizedResult = toolResult as ToolResult;
          } else {
            normalizedResult = buildToolResultJson(toolResult);
          }
          return {
            statusCode: 200,
            responseBody: buildJsonRpcResponse(id ?? null, normalizedResult),
          };
        } catch (error: any) {
          const code = typeof error?.code === 'number' ? error.code : JSONRPC_ERRORS.INTERNAL_ERROR;
          return {
            statusCode: 200,
            responseBody: buildJsonRpcError(
              id ?? null,
              code,
              error instanceof Error ? error.message : 'Internal error'
            ),
          };
        }
      }

      case 'resources/list': {
        const catalog = listResourceCatalog();
        return {
          statusCode: 200,
          responseBody: buildJsonRpcResponse(id ?? null, catalog),
        };
      }

      case 'resources/read': {
        const { uri } = (params || {}) as { uri?: string };
        if (!uri || typeof uri !== 'string') {
          return {
            statusCode: 200,
            responseBody: buildJsonRpcError(
              id ?? null,
              JSONRPC_ERRORS.INVALID_PARAMS,
              'Resource URI is required and must be a string'
            ),
          };
        }

        const parsed = parseResourceUri(uri);
        if (!parsed) {
          return {
            statusCode: 200,
            responseBody: buildJsonRpcError(
              id ?? null,
              JSONRPC_ERRORS.INVALID_PARAMS,
              `Unsupported or invalid resource URI: ${uri}`
            ),
          };
        }

        const authorized = await checkAuthorization(caller, parsed.owner, parsed.repo);
        if (!authorized) {
          return {
            statusCode: 403,
            responseBody: formatRbacErrorResponse(new McpRbacError(parsed.owner, parsed.repo)),
          };
        }

        try {
          const content = await readResourceContent(uri, options.db);
          return {
            statusCode: 200,
            responseBody: buildJsonRpcResponse(id ?? null, content),
          };
        } catch (err: any) {
          return {
            statusCode: 200,
            responseBody: buildJsonRpcError(
              id ?? null,
              JSONRPC_ERRORS.INTERNAL_ERROR,
              err instanceof Error ? err.message : 'Error reading resource'
            ),
          };
        }
      }

      case 'resources/subscribe': {
        const { uri } = (params || {}) as { uri?: string };
        if (!uri || typeof uri !== 'string') {
          return {
            statusCode: 200,
            responseBody: buildJsonRpcError(
              id ?? null,
              JSONRPC_ERRORS.INVALID_PARAMS,
              'Resource URI is required and must be a string'
            ),
          };
        }

        const parsed = parseResourceUri(uri);
        if (!parsed) {
          return {
            statusCode: 200,
            responseBody: buildJsonRpcError(
              id ?? null,
              JSONRPC_ERRORS.INVALID_PARAMS,
              `Unsupported or invalid resource URI: ${uri}`
            ),
          };
        }

        const authorized = await checkAuthorization(caller, parsed.owner, parsed.repo);
        if (!authorized) {
          return {
            statusCode: 403,
            responseBody: formatRbacErrorResponse(new McpRbacError(parsed.owner, parsed.repo)),
          };
        }

        let targetSession = explicitSession;
        let createdSessionId: string | undefined;
        if (!targetSession) {
          targetSession = sessionManager.createSession();
          createdSessionId = targetSession.id;
        }
        targetSession.subscriptions.add(uri);

        return {
          statusCode: 200,
          responseBody: buildJsonRpcResponse(id ?? null, {}),
          newSessionId: createdSessionId,
        };
      }

      case 'resources/unsubscribe': {
        const { uri } = (params || {}) as { uri?: string };
        if (!uri || typeof uri !== 'string') {
          return {
            statusCode: 200,
            responseBody: buildJsonRpcError(
              id ?? null,
              JSONRPC_ERRORS.INVALID_PARAMS,
              'Resource URI is required and must be a string'
            ),
          };
        }

        const parsed = parseResourceUri(uri);
        if (!parsed) {
          return {
            statusCode: 200,
            responseBody: buildJsonRpcError(
              id ?? null,
              JSONRPC_ERRORS.INVALID_PARAMS,
              `Unsupported or invalid resource URI: ${uri}`
            ),
          };
        }

        const authorized = await checkAuthorization(caller, parsed.owner, parsed.repo);
        if (!authorized) {
          return {
            statusCode: 403,
            responseBody: formatRbacErrorResponse(new McpRbacError(parsed.owner, parsed.repo)),
          };
        }

        if (explicitSession) {
          explicitSession.subscriptions.delete(uri);
        }

        return {
          statusCode: 200,
          responseBody: buildJsonRpcResponse(id ?? null, {}),
        };
      }

      default: {
        return {
          statusCode: 200,
          responseBody: buildJsonRpcError(id ?? null, JSONRPC_ERRORS.METHOD_NOT_FOUND, 'Method not found'),
        };
      }
    }
  }

  // 1. POST / (Streamable HTTP JSON-RPC endpoint)
  router.post('/', async (req: Request, res: Response) => {
    let caller: McpAuthenticatedCaller;
    try {
      caller = await resolveCaller(req);
    } catch {
      res.setHeader('WWW-Authenticate', 'Bearer error="invalid_token", error_description="Missing or invalid Bearer token"');
      return res.status(401).json(
        buildJsonRpcError(null, MCP_ERRORS.UNAUTHORIZED, 'Unauthorized: Missing or invalid Bearer token')
      );
    }

    const sessionIdHeader = req.header('mcp-session-id') || (req.headers['mcp-session-id'] as string | undefined);
    let session: McpSessionState | undefined;

    if (sessionIdHeader) {
      session = sessionManager.getSession(sessionIdHeader);
      if (!session) {
        return res.status(404).json(
          buildJsonRpcError(req.body?.id ?? null, MCP_ERRORS.SESSION_EXPIRED, 'Session expired or not found')
        );
      }
      sessionManager.touchSession(session.id);
    }

    // Handle batch JSON-RPC request
    if (Array.isArray(req.body)) {
      if (req.body.length === 0) {
        return res.status(400).json(
          buildJsonRpcError(null, JSONRPC_ERRORS.INVALID_REQUEST, 'Invalid Request: batch is empty')
        );
      }

      const results = [];
      for (const item of req.body) {
        const { responseBody } = await dispatchJsonRpc(item, caller, req, res, session);
        if (responseBody) results.push(responseBody);
      }
      return res.status(200).json(results);
    }

    const { statusCode, responseBody, newSessionId } = await dispatchJsonRpc(
      req.body,
      caller,
      req,
      res,
      session
    );

    if (newSessionId) {
      res.setHeader('Mcp-Session-Id', newSessionId);
    } else if (session) {
      res.setHeader('Mcp-Session-Id', session.id);
    }

    if (statusCode === 204) {
      return res.status(204).end();
    }

    return res.status(statusCode).json(responseBody);
  });

  // 2. GET /sse (HTTP+SSE Transport)
  router.get('/sse', async (req: Request, res: Response) => {
    let caller: McpAuthenticatedCaller;
    try {
      caller = await resolveCaller(req);
    } catch {
      return res.status(401).json(
        buildJsonRpcError(null, MCP_ERRORS.UNAUTHORIZED, 'Unauthorized: Missing or invalid Bearer token')
      );
    }

    if (sessionManager.activeSessionCount() >= maxSessions) {
      return res.status(429).json({ error: 'Maximum concurrent MCP sessions exceeded' });
    }

    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const sessionId = uuidGenerator();
    const session: McpSessionState = {
      id: sessionId,
      createdAt: now(),
      lastSeenAt: now(),
      identity: caller.callerId,
      sseResponse: res,
      onCloseCallbacks: [],
      subscriptions: new Set<string>(),
    };
    sessions.set(sessionId, session);

    // Initial endpoint declaration event
    res.write(`event: endpoint\ndata: /api/mcp/messages?sessionId=${sessionId}\n\n`);

    // Heartbeat keepalive comments
    const keepAliveTimer = setInterval(() => {
      if (!res.writableEnded) {
        res.write(': keepalive\n\n');
      }
    }, keepAliveMs);
    if (typeof keepAliveTimer.unref === 'function') {
      keepAliveTimer.unref();
    }
    session.keepAliveTimer = keepAliveTimer;

    req.on('close', () => {
      clearInterval(keepAliveTimer);
      destroySession(sessionId, 'Client disconnected');
    });
  });

  // 3. POST /messages (SSE Inbound Gateway)
  router.post('/messages', async (req: Request, res: Response) => {
    const sessionId = req.query.sessionId as string;
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId query parameter is required' });
    }

    const session = sessionManager.getSession(sessionId);
    if (!session || !session.sseResponse || session.sseResponse.writableEnded) {
      return res.status(404).json({ error: 'Active SSE session not found' });
    }

    let caller: McpAuthenticatedCaller;
    try {
      caller = await resolveCaller(req);
    } catch {
      return res.status(401).json(
        buildJsonRpcError(null, MCP_ERRORS.UNAUTHORIZED, 'Unauthorized: Missing or invalid Bearer token')
      );
    }

    sessionManager.touchSession(sessionId);

    // Acknowledge receipt immediately
    res.status(202).json({ status: 'accepted' });

    // Asynchronously dispatch and stream result back to SSE channel
    void (async () => {
      try {
        const { responseBody } = await dispatchJsonRpc(req.body, caller, req, res, session);
        if (responseBody && session.sseResponse && !session.sseResponse.writableEnded) {
          session.sseResponse.write(`event: message\ndata: ${JSON.stringify(responseBody)}\n\n`);
        }
      } catch {
        // Safe ignore
      }
    })();
  });

  return router;
}
