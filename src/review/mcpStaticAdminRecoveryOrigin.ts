import type { McpStaticAdminRecoveryOrigin } from './reviewRun';

const trustedOrigins = new WeakSet<object>();

interface McpStaticAdminRecoveryCallerFields {
  readonly authType: unknown;
  readonly isAdmin: unknown;
  readonly tokenDigest: unknown;
  readonly callerId: unknown;
}

interface McpStaticAdminRecoveryCaller extends McpStaticAdminRecoveryCallerFields {
  readonly authType: 'static_token';
  readonly isAdmin: true;
  readonly tokenDigest: string;
  readonly callerId: string;
}

/** The exact four-field static-admin shape used by both MCP admission and origin minting. */
export function isMcpStaticAdminRecoveryCaller(value: unknown): value is McpStaticAdminRecoveryCaller {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const caller = value as McpStaticAdminRecoveryCallerFields;
  return caller.authType === 'static_token' && caller.isAdmin === true
    && typeof caller.tokenDigest === 'string' && /^[a-f0-9]{12}$/u.test(caller.tokenDigest)
    && caller.callerId === `admin:${caller.tokenDigest}`;
}

/** Create an in-process origin only after the MCP router has authenticated and
 * authorized the exact repository. Plain request/repository objects cannot
 * assert this provenance. */
export function createMcpStaticAdminRecoveryOrigin(
  caller: unknown,
  authorizedRepository: { owner: string; repo: string },
): McpStaticAdminRecoveryOrigin {
  if (!isMcpStaticAdminRecoveryCaller(caller)
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
