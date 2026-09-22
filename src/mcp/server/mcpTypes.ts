/**
 * Model Context Protocol (MCP) TypeScript Type System
 *
 * Implements JSON-RPC 2.0 and MCP protocol version 2024-11-05 specifications
 * with zero runtime dependencies.
 */

import type { GitHubActionsOidcClaims } from '../../auth/githubActionsOidc';

export interface McpAuthenticatedCaller {
  /** Authentication pathway: cluster static admin token or GitHub Actions OIDC */
  readonly authType: 'static_token' | 'oidc';
  /** Truncated SHA-256 digest of token (first 12 chars) for audit logging without leaking secret */
  readonly tokenDigest: string;
  /** True if caller authenticated via the static cluster secret (unrestricted repository reach) */
  readonly isAdmin: boolean;
  /** Set of permitted repository coordinates in lowercase ('owner/repo'). Null indicates unrestricted admin */
  readonly allowedRepositories: ReadonlySet<string> | null;
  /** GitHub Actions OIDC verified claims payload if authType is 'oidc' */
  readonly claims?: GitHubActionsOidcClaims;
  /** Human-readable or machine caller identifier */
  readonly callerId: string;
}

export interface McpExecutionContext {
  sessionId?: string;
  caller?: McpAuthenticatedCaller;
  identity?: string;
  emitProgress?: (progress: number, total?: number, message?: string) => void;
}

/**
 * MCP Protocol Version compatibility constants.
 */
export const MCP_PROTOCOL_VERSION = '2024-11-05';
export const SUPPORTED_PROTOCOL_VERSIONS = [MCP_PROTOCOL_VERSION] as const;

/**
 * Server identification metadata.
 */
export const SERVER_NAME = 'review-yeti-action-dispatch';
export const SERVER_VERSION = '1.45.3';

/**
 * JSON-RPC 2.0 standard error codes.
 */
export const JSONRPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

/**
 * Review Yeti MCP specific error codes.
 */
export const MCP_ERRORS = {
  TOO_MANY_SESSIONS: -32000,
  UNAUTHORIZED: -32001,
  SESSION_EXPIRED: -32002,
  FORBIDDEN: -32003,
  RATE_LIMITED: -32004,
  RATE_LIMITED_ALT: -32029,
} as const;

export type JsonRpcVersion = '2.0';
export type JsonRpcId = string | number | null;

export interface JsonRpcRequest<TMethod extends string = string, TParams = unknown> {
  jsonrpc: JsonRpcVersion;
  id: JsonRpcId;
  method: TMethod;
  params?: TParams;
}

export interface JsonRpcNotification<TMethod extends string = string, TParams = unknown> {
  jsonrpc: JsonRpcVersion;
  method: TMethod;
  params?: TParams;
}

export interface JsonRpcResponse<TResult = unknown> {
  jsonrpc: JsonRpcVersion;
  id: JsonRpcId;
  result: TResult;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: JsonRpcVersion;
  id: JsonRpcId;
  error: JsonRpcError;
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcResponse
  | JsonRpcErrorResponse;

export interface Implementation {
  name: string;
  version: string;
}

export interface ClientCapabilities {
  experimental?: Record<string, unknown>;
  roots?: {
    listChanged?: boolean;
  };
  sampling?: Record<string, unknown>;
}

export interface ServerCapabilities {
  experimental?: Record<string, unknown>;
  logging?: Record<string, unknown>;
  tools?: {
    listChanged?: boolean;
  };
}

/**
 * Initialize request payload sent by client during handshake.
 */
export type InitializeRequest = JsonRpcRequest<
  'initialize',
  {
    protocolVersion: string;
    capabilities?: ClientCapabilities;
    clientInfo?: Implementation;
  }
>;

/**
 * Initialize result returned by server to negotiate protocol features.
 */
export interface InitializeResult {
  protocolVersion: string;
  capabilities: ServerCapabilities;
  serverInfo: Implementation;
  instructions?: string;
}

/**
 * Notification emitted by client after handshake completes.
 */
export type InitializedNotification = JsonRpcNotification<
  'notifications/initialized',
  Record<string, unknown> | undefined
>;

/**
 * Ping request for liveness testing.
 */
export type PingRequest = JsonRpcRequest<'ping', Record<string, unknown> | undefined>;
export type PingResult = Record<string, never>;

export interface ToolInputSchema {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
}

export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema: ToolInputSchema;
}

/**
 * Request to list registered tools.
 */
export type ListToolsRequest = JsonRpcRequest<
  'tools/list',
  {
    cursor?: string;
  } | undefined
>;

export interface ListToolsResult {
  tools: ToolDefinition[];
  nextCursor?: string;
}

/**
 * Request to call a specific tool.
 */
export type CallToolRequest = JsonRpcRequest<
  'tools/call',
  {
    name: string;
    arguments?: Record<string, unknown>;
  }
>;

export interface ToolTextContent {
  type: 'text';
  text: string;
}

export interface ToolImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

export interface ToolEmbeddedResource {
  type: 'resource';
  resource: {
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string;
  };
}

export type ToolContent = ToolTextContent | ToolImageContent | ToolEmbeddedResource;

/**
 * Result returned by a tool invocation.
 */
export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

export type ProgressNotification = JsonRpcNotification<
  'notifications/progress',
  {
    progressToken: string | number;
    progress: number;
    total?: number;
    message?: string;
    details?: unknown;
  }
>;

export type LoggingMessageNotification = JsonRpcNotification<
  'notifications/message',
  {
    level: 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical' | 'alert' | 'emergency';
    data: unknown;
    logger?: string;
  }
>;

// Type Guards and Helper Constructors

export function isJsonRpcRequest(message: unknown): message is JsonRpcRequest {
  if (typeof message !== 'object' || message === null) return false;
  const req = message as Record<string, unknown>;
  return req.jsonrpc === '2.0' && typeof req.method === 'string' && 'id' in req;
}

export function isJsonRpcNotification(message: unknown): message is JsonRpcNotification {
  if (typeof message !== 'object' || message === null) return false;
  const notif = message as Record<string, unknown>;
  return notif.jsonrpc === '2.0' && typeof notif.method === 'string' && !('id' in notif);
}

export function isInitializeRequest(message: unknown): message is InitializeRequest {
  return isJsonRpcRequest(message) && message.method === 'initialize';
}

export function isCallToolRequest(message: unknown): message is CallToolRequest {
  return isJsonRpcRequest(message) && message.method === 'tools/call';
}

export function isListToolsRequest(message: unknown): message is ListToolsRequest {
  return isJsonRpcRequest(message) && message.method === 'tools/list';
}

export function isPingRequest(message: unknown): message is PingRequest {
  return isJsonRpcRequest(message) && message.method === 'ping';
}

export function buildJsonRpcResponse<T>(id: JsonRpcId, result: T): JsonRpcResponse<T> {
  return {
    jsonrpc: '2.0',
    id,
    result,
  };
}

export function buildJsonRpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown
): JsonRpcErrorResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      ...(data !== undefined ? { data } : {}),
    },
  };
}

export function buildToolResultText(text: string, isError = false): ToolResult {
  return {
    content: [{ type: 'text', text }],
    isError,
  };
}

export function buildToolResultJson(data: unknown, isError = false): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    isError,
  };
}
