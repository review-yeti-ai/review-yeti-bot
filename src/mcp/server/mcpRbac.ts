import type { McpAuthenticatedCaller } from './mcpAuthenticator';
import { MCP_ERRORS, type JsonRpcErrorResponse } from './mcpTypes';

export class McpRbacError extends Error {
  public readonly code: number = MCP_ERRORS.FORBIDDEN;
  public readonly statusCode: number = 403;

  constructor(public readonly owner: string, public readonly repo: string) {
    super(`Forbidden: Access to repository ${owner}/${repo} denied`);
    this.name = 'McpRbacError';
  }
}

const REPO_NAME_REGEX = /^[A-Za-z0-9_.-]+$/u;

export function verifyRepositoryAccess(
  caller: McpAuthenticatedCaller,
  owner: string,
  repo: string
): void {
  if (caller.isAdmin) return;

  if (!REPO_NAME_REGEX.test(owner) || !REPO_NAME_REGEX.test(repo)) {
    throw new McpRbacError(owner, repo);
  }

  const targetRepo = `${owner}/${repo}`.toLowerCase();

  // Check explicit allowed repository set
  if (caller.allowedRepositories?.has(targetRepo)) {
    return;
  }

  // Central dispatch workflow authorization
  if (
    caller.claims?.repository === 'calltelemetry/ct-review-actions' &&
    caller.claims?.event_name === 'repository_dispatch' &&
    owner.toLowerCase() === 'calltelemetry'
  ) {
    return;
  }

  throw new McpRbacError(owner, repo);
}

export function formatRbacErrorResponse(error: McpRbacError): JsonRpcErrorResponse {
  return {
    jsonrpc: '2.0',
    error: {
      code: error.code,
      message: error.message,
    },
    id: null,
  };
}
