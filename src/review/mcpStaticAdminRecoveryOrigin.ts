import type { McpAuthenticatedCaller } from '../mcp/server/mcpTypes';
import type { McpStaticAdminRecoveryOrigin } from './reviewRun';

const trustedOrigins = new WeakSet<object>();

/** Create an in-process origin only after the MCP router has authenticated and
 * authorized the exact repository. Plain request/repository objects cannot
 * assert this provenance. */
export function createMcpStaticAdminRecoveryOrigin(
  caller: McpAuthenticatedCaller,
  authorizedRepository: { owner: string; repo: string },
): McpStaticAdminRecoveryOrigin {
  if (caller.authType !== 'static_token' || caller.isAdmin !== true
    || !/^[a-f0-9]{12}$/u.test(caller.tokenDigest)
    || caller.callerId !== `admin:${caller.tokenDigest}`
    || !authorizedRepository.owner.trim() || !authorizedRepository.repo.trim()) {
    throw new Error('MCP recovery origin requires a verified static-token admin');
  }
  const origin = Object.freeze({
    kind: 'mcp_static_admin' as const,
    callerId: caller.callerId,
    authorizedOwner: authorizedRepository.owner,
    authorizedRepo: authorizedRepository.repo,
  });
  trustedOrigins.add(origin);
  return origin;
}

export function isTrustedMcpStaticAdminRecoveryOrigin(
  value: unknown,
): value is McpStaticAdminRecoveryOrigin {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || !trustedOrigins.has(value)) return false;
  const origin = value as Record<string, unknown>;
  const keys = Object.keys(origin).sort();
  return keys.length === 4 && keys.join(',') === 'authorizedOwner,authorizedRepo,callerId,kind'
    && origin.kind === 'mcp_static_admin'
    && typeof origin.callerId === 'string' && /^admin:[a-f0-9]{12}$/u.test(origin.callerId)
    && typeof origin.authorizedOwner === 'string' && origin.authorizedOwner.trim().length > 0
    && typeof origin.authorizedRepo === 'string' && origin.authorizedRepo.trim().length > 0;
}
