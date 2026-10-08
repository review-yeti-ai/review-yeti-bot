import { reviewYetiPassthroughEnabledFromEnv } from './reviewYetiPassthrough';
import { qualificationRuntimeImageDigestFromReference } from './qualificationRuntimeImage';
import { qualificationDispatchOriginSha256FromEnv } from './qualificationDispatchOrigin';
import {
  PUBLIC_REVIEW_REPOSITORY,
  PUBLIC_REVIEW_REPOSITORY_ID,
  PUBLIC_REVIEW_APP_ID,
  QUALIFICATION_REVIEW_REPOSITORY,
  QUALIFICATION_REVIEW_REPOSITORY_ID,
} from './repositoryReviewAuthorityConstants';

export const SELF_HOSTED_CENTRAL_DISPATCH_REPOSITORY = PUBLIC_REVIEW_REPOSITORY;
export const SELF_HOSTED_CENTRAL_DISPATCH_REPOSITORY_ID = PUBLIC_REVIEW_REPOSITORY_ID;

export interface McpRateLimitConfig {
  windowMs: number;
  max: number;
}

export interface McpServerConfig {
  enabled: boolean;
  path: string;
  authToken?: string;
  maxSessions: number;
  sessionTtlMs: number;
  rateLimitWindowMs: number;
  rateLimitMax: number;
  rateLimit?: McpRateLimitConfig;
}

export interface ActionDispatchConfig {
  /** Skip new review admission after caller authentication and request validation. */
  passthroughEnabled: boolean;
  /** True only for the isolated, one-repository normal-review qualification release. */
  qualificationInstance: boolean;
  /** Digest derived from the service-owned worker image reference; present only in qualification. */
  qualificationRuntimeImageDigest?: string;
  /** Digest of the service-owned qualification action origin; the raw origin is never returned. */
  qualificationDispatchOriginSha256?: string;
  requireExpectedGeneration: boolean;
  centralExternalRepositories: ReadonlyMap<string, number>;
  centralExternalAppCredentials?: {
    appId: string;
    privateKey: string;
  };
  mcp: McpServerConfig;
}

export function parsePositiveInteger(
  value: string | undefined,
  defaultValue: number,
  name: string
): number {
  if (value === undefined || value.trim() === '') return defaultValue;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

interface ActionDispatchEnvironment {
  REVIEW_YETI_PASSTHROUGH?: string;
  REVIEW_YETI_QUALIFICATION_INSTANCE?: string;
  ACTION_DISPATCH_REQUIRE_EXPECTED_GENERATION?: string;
  ACTION_DISPATCH_CENTRAL_EXTERNAL_REPOSITORIES?: string;
  GITHUB_APP_WEBHOOK_ENABLED?: string;
  REVIEW_JOB_WORKER_IMAGE?: string;
  REVIEW_QUALIFICATION_DISPATCH_ORIGIN?: string;
  REVIEW_YETI_PUBLIC_TARGET_APP_ID?: string;
  REVIEW_YETI_PUBLIC_TARGET_APP_PRIVATE_KEY?: string;
  REVIEW_YETI_MCP_ENABLED?: string;
  REVIEW_YETI_MCP_AUTH_TOKEN?: string;
  REVIEW_YETI_MCP_PATH?: string;
  REVIEW_YETI_MCP_MAX_SESSIONS?: string;
  REVIEW_YETI_MCP_SESSION_TTL_MS?: string;
  REVIEW_YETI_MCP_RATE_LIMIT_WINDOW_MS?: string;
  REVIEW_YETI_MCP_RATE_LIMIT_MAX?: string;
}

export interface CentralExternalTargetConfig {
  repositories: ReadonlyMap<string, number>;
  appCredentials?: { appId: string; privateKey: string };
}

export function qualificationInstanceEnabledFromEnv(environment: Pick<ActionDispatchEnvironment,
  'REVIEW_YETI_QUALIFICATION_INSTANCE'> | NodeJS.ProcessEnv): boolean {
  const value = environment.REVIEW_YETI_QUALIFICATION_INSTANCE;
  if (value === undefined || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error('REVIEW_YETI_QUALIFICATION_INSTANCE must be exactly true or false');
}

/**
 * Parses the exact public target and its dedicated App, or the separately
 * marked one-repository qualification target. Both the admission service and
 * worker-token control plane use this parser so lookup, read-token, check-token,
 * and fail-closed publication routing cannot drift onto different identities.
 */
export function centralExternalTargetConfigFromEnv(
  environment: NodeJS.ProcessEnv | ActionDispatchEnvironment,
  options: { allowUnavailableSigningKey?: boolean } = {},
): CentralExternalTargetConfig {
  const configuredRepositories = environment.ACTION_DISPATCH_CENTRAL_EXTERNAL_REPOSITORIES;
  const qualificationInstance = qualificationInstanceEnabledFromEnv(environment);
  if (qualificationInstance) {
    if (environment.REVIEW_YETI_PASSTHROUGH !== 'false') {
      throw new Error('Qualification instance requires REVIEW_YETI_PASSTHROUGH=false');
    }
    if (configuredRepositories !== QUALIFICATION_REVIEW_REPOSITORY) {
      throw new Error('Qualification instance must admit only its source-owned repository');
    }
    const qualificationRuntimeImageDigest = qualificationRuntimeImageDigestFromReference(environment.REVIEW_JOB_WORKER_IMAGE);
    if (!qualificationRuntimeImageDigest) {
      throw new Error('Qualification instance requires a digest-pinned REVIEW_JOB_WORKER_IMAGE');
    }
    return { repositories: new Map([[QUALIFICATION_REVIEW_REPOSITORY, QUALIFICATION_REVIEW_REPOSITORY_ID]]) };
  }
  if (configuredRepositories === undefined) return { repositories: new Map() };
  if (configuredRepositories !== SELF_HOSTED_CENTRAL_DISPATCH_REPOSITORY) {
    throw new Error('ACTION_DISPATCH_CENTRAL_EXTERNAL_REPOSITORIES must contain only explicit supported repositories');
  }
  const publicAppId = environment.REVIEW_YETI_PUBLIC_TARGET_APP_ID?.trim();
  const publicPrivateKey = environment.REVIEW_YETI_PUBLIC_TARGET_APP_PRIVATE_KEY?.trim().replace(/\\n/g, '\n');
  if (!publicAppId || !/^[1-9][0-9]*$/u.test(publicAppId)
    || !Number.isSafeInteger(Number(publicAppId))
    || publicAppId !== String(PUBLIC_REVIEW_APP_ID)
    || (!publicPrivateKey && options.allowUnavailableSigningKey !== true)) {
    throw new Error('Dedicated public-target GitHub App credentials are required for external dispatch');
  }
  return {
    repositories: new Map([
      [SELF_HOSTED_CENTRAL_DISPATCH_REPOSITORY, SELF_HOSTED_CENTRAL_DISPATCH_REPOSITORY_ID],
    ]),
    appCredentials: { appId: publicAppId, privateKey: publicPrivateKey || '' },
  };
}

export function actionDispatchConfigFromEnv(
  environment: NodeJS.ProcessEnv | ActionDispatchEnvironment = process.env,
): ActionDispatchConfig {
  const passthroughEnabled = reviewYetiPassthroughEnabledFromEnv(environment);
  const qualificationInstance = qualificationInstanceEnabledFromEnv(environment);
  const value = environment.ACTION_DISPATCH_REQUIRE_EXPECTED_GENERATION;
  let requireExpectedGeneration: boolean;
  if (value === undefined || value === '' || value === 'false') requireExpectedGeneration = false;
  else if (value === 'true') requireExpectedGeneration = true;
  else throw new Error('ACTION_DISPATCH_REQUIRE_EXPECTED_GENERATION must be exactly true or false');

  const external = centralExternalTargetConfigFromEnv(environment, {
    allowUnavailableSigningKey: passthroughEnabled,
  });
  const centralExternalRepositories = external.repositories;
  const centralExternalAppCredentials = external.appCredentials;
  const qualificationRuntimeImageDigest = qualificationInstance
    ? qualificationRuntimeImageDigestFromReference(environment.REVIEW_JOB_WORKER_IMAGE)
    : undefined;
  if (qualificationInstance && !qualificationRuntimeImageDigest) {
    throw new Error('Qualification instance requires a digest-pinned REVIEW_JOB_WORKER_IMAGE');
  }
  const qualificationDispatchOriginSha256 = qualificationInstance
    ? qualificationDispatchOriginSha256FromEnv(environment.REVIEW_QUALIFICATION_DISPATCH_ORIGIN)
    : undefined;
  if (qualificationInstance && !qualificationDispatchOriginSha256) {
    throw new Error('Qualification instance requires a canonical trusted HTTPS dispatch origin');
  }
  if (!qualificationInstance && environment.REVIEW_QUALIFICATION_DISPATCH_ORIGIN?.trim()) {
    throw new Error('REVIEW_QUALIFICATION_DISPATCH_ORIGIN is allowed only for the qualification instance');
  }

  const mcpEnabledVal = environment.REVIEW_YETI_MCP_ENABLED;
  let mcpEnabled = false;
  if (mcpEnabledVal === 'true') {
    mcpEnabled = true;
  } else if (mcpEnabledVal !== undefined && mcpEnabledVal !== '' && mcpEnabledVal !== 'false') {
    throw new Error('REVIEW_YETI_MCP_ENABLED must be exactly true or false');
  }

  const mcpAuthToken = environment.REVIEW_YETI_MCP_AUTH_TOKEN?.trim();
  if (qualificationInstance && mcpEnabled) {
    throw new Error('Qualification instance does not expose the MCP trigger surface');
  }
  if (mcpEnabled && !mcpAuthToken) {
    throw new Error('REVIEW_YETI_MCP_AUTH_TOKEN is required when REVIEW_YETI_MCP_ENABLED is true');
  }

  const mcpPath = (environment.REVIEW_YETI_MCP_PATH || '/api/mcp').trim();
  if (!mcpPath.startsWith('/')) {
    throw new Error('REVIEW_YETI_MCP_PATH must start with "/"');
  }
  if (qualificationInstance && environment.GITHUB_APP_WEBHOOK_ENABLED !== undefined
    && environment.GITHUB_APP_WEBHOOK_ENABLED !== 'false') {
    throw new Error('Qualification instance does not expose the GitHub App webhook surface');
  }

  const mcpMaxSessions = parsePositiveInteger(
    environment.REVIEW_YETI_MCP_MAX_SESSIONS,
    100,
    'REVIEW_YETI_MCP_MAX_SESSIONS'
  );

  const mcpSessionTtlMs = parsePositiveInteger(
    environment.REVIEW_YETI_MCP_SESSION_TTL_MS,
    1_800_000,
    'REVIEW_YETI_MCP_SESSION_TTL_MS'
  );
  if (mcpSessionTtlMs < 5000) {
    throw new Error('REVIEW_YETI_MCP_SESSION_TTL_MS must be at least 5000ms');
  }

  const mcpRateLimitWindowMs = parsePositiveInteger(
    environment.REVIEW_YETI_MCP_RATE_LIMIT_WINDOW_MS,
    60_000,
    'REVIEW_YETI_MCP_RATE_LIMIT_WINDOW_MS'
  );

  const mcpRateLimitMax = parsePositiveInteger(
    environment.REVIEW_YETI_MCP_RATE_LIMIT_MAX,
    60,
    'REVIEW_YETI_MCP_RATE_LIMIT_MAX'
  );

  return {
    passthroughEnabled,
    qualificationInstance,
    ...(qualificationRuntimeImageDigest ? { qualificationRuntimeImageDigest } : {}),
    ...(qualificationDispatchOriginSha256 ? { qualificationDispatchOriginSha256 } : {}),
    requireExpectedGeneration,
    centralExternalRepositories,
    ...(centralExternalAppCredentials ? { centralExternalAppCredentials } : {}),
    mcp: {
      enabled: mcpEnabled,
      path: mcpPath,
      authToken: mcpAuthToken,
      maxSessions: mcpMaxSessions,
      sessionTtlMs: mcpSessionTtlMs,
      rateLimitWindowMs: mcpRateLimitWindowMs,
      rateLimitMax: mcpRateLimitMax,
      rateLimit: {
        windowMs: mcpRateLimitWindowMs,
        max: mcpRateLimitMax,
      },
    },
  };
}
