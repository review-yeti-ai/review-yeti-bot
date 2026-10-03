import type { McpAuthenticatedCaller } from './mcpAuthenticator';
import { CENTRAL_REVIEW_CONFIGURED, CENTRAL_REVIEW_OWNER, CENTRAL_REVIEW_REPOSITORY } from '../../review/reviewCheckIdentity';
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

export function canAccessRepository(
  caller: McpAuthenticatedCaller,
  owner: string,
  repo: string
): boolean {
  if (caller.isAdmin) return true;

  if (!REPO_NAME_REGEX.test(owner) || !REPO_NAME_REGEX.test(repo)) {
    return false;
  }

  const targetRepo = `${owner}/${repo}`.toLowerCase();

  // Check explicit allowed repository set
  if (caller.allowedRepositories?.has(targetRepo)) {
    return true;
  }

  // Central dispatch workflow authorization
  if (
    CENTRAL_REVIEW_CONFIGURED &&
    caller.claims?.repository === CENTRAL_REVIEW_REPOSITORY &&
    caller.claims?.event_name === 'repository_dispatch' &&
    owner.toLowerCase() === CENTRAL_REVIEW_OWNER.toLowerCase()
  ) {
    return true;
  }

  return false;
}

export function verifyRepositoryAccess(
  caller: McpAuthenticatedCaller,
  owner: string,
  repo: string
): void {
  if (!canAccessRepository(caller, owner, repo)) {
    throw new McpRbacError(owner, repo);
  }
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
