import { type Request, type Response, type NextFunction, type RequestHandler } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { GitHubActionsOidcVerifier, GitHubActionsOidcClaims } from '../../auth/githubActionsOidc';
import { logger } from '../../utils/logger';
import { MCP_ERRORS, buildJsonRpcError, type McpAuthenticatedCaller } from './mcpTypes';
import { canAccessRepository } from './mcpRbac';

export type { McpAuthenticatedCaller };

declare global {
  namespace Express {
    interface Request {
      mcpCaller?: McpAuthenticatedCaller;
    }
  }
}

export class McpAuthError extends Error {
  public readonly statusCode: number = 401;
  public readonly code: number = MCP_ERRORS.UNAUTHORIZED;

  constructor(message: string = 'Unauthorized: Missing or invalid Bearer token') {
    super(message);
    this.name = 'McpAuthError';
  }
}

export function extractBearerToken(request: Request): string | null {
  const authHeader = request.header('authorization') || request.header('Authorization');
  if (authHeader) {
    const match = /^Bearer\s+([^\s]+)$/iu.exec(authHeader.trim());
    if (match?.[1]) return match[1];
  }

  return null;
}

export function timingSafeTokenMatch(candidate: string, expected: string): boolean {
  if (!candidate || !expected) return false;
  try {
    const candidateHash = createHash('sha256').update(candidate).digest();
    const expectedHash = createHash('sha256').update(expected).digest();
    return timingSafeEqual(candidateHash, expectedHash);
  } catch {
    return false;
  }
}

export interface McpAuthenticatorOptions {
  staticAuthToken?: string;
  oidcVerifier?: Pick<GitHubActionsOidcVerifier, 'verify'>;
}

export class McpAuthenticator {
  private readonly staticAuthToken?: string;
  private readonly oidcVerifier?: Pick<GitHubActionsOidcVerifier, 'verify'>;

  constructor(options: McpAuthenticatorOptions = {}) {
    this.staticAuthToken = options.staticAuthToken?.trim();
    this.oidcVerifier = options.oidcVerifier;
  }

  async authenticate(request: Request): Promise<McpAuthenticatedCaller> {
    const token = extractBearerToken(request);
    if (!token) {
      throw new McpAuthError('Missing Bearer token');
    }
    return this.authenticateToken(token);
  }

  async authenticateToken(token: string): Promise<McpAuthenticatedCaller> {
    const trimmedToken = token.trim();
    if (!trimmedToken) {
      throw new McpAuthError('Missing Bearer token');
    }

    const tokenDigest = createHash('sha256').update(trimmedToken).digest('hex').slice(0, 12);

    // 1. Check static token
    if (this.staticAuthToken && timingSafeTokenMatch(trimmedToken, this.staticAuthToken)) {
      return {
        authType: 'static_token',
        tokenDigest,
        isAdmin: true,
        allowedRepositories: null,
        callerId: `admin:${tokenDigest}`,
      };
    }

    // 2. Check GitHub Actions OIDC token if verifier is configured
    if (this.oidcVerifier) {
      try {
        const claims = await this.oidcVerifier.verify(trimmedToken);
        const repo = (claims.repository || '').toLowerCase();
        return {
          authType: 'oidc',
          tokenDigest,
          isAdmin: false,
          allowedRepositories: repo ? new Set([repo]) : new Set(),
          claims,
          callerId: `oidc:${claims.repository}:${claims.run_id || tokenDigest}`,
        };
      } catch (error) {
        logger.warn('MCP OIDC token verification rejected', {
          tokenDigest,
          error: error instanceof Error ? error.message : String(error),
        });
        throw new McpAuthError('Invalid OIDC credentials');
      }
    }

    throw new McpAuthError('Invalid Bearer token');
  }

  checkRepositoryAccess(caller: McpAuthenticatedCaller, owner: string, repo: string): boolean {
    return canAccessRepository(caller, owner, repo);
  }

  middleware(): RequestHandler {
    return async (request: Request, response: Response, next: NextFunction) => {
      try {
        const caller = await this.authenticate(request);
        request.mcpCaller = caller;
        return next();
      } catch {
        response.setHeader(
          'WWW-Authenticate',
          'Bearer error="invalid_token", error_description="Missing or invalid Bearer token"'
        );
        return response.status(401).json(
          buildJsonRpcError(null, MCP_ERRORS.UNAUTHORIZED, 'Unauthorized: Missing or invalid Bearer token')
        );
      }
    };
  }
}
