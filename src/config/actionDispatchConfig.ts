export const SELF_HOSTED_CENTRAL_DISPATCH_REPOSITORY = 'review-yeti-ai/review-yeti-bot';
export const SELF_HOSTED_CENTRAL_DISPATCH_REPOSITORY_ID = 1326169548;

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
  ACTION_DISPATCH_REQUIRE_EXPECTED_GENERATION?: string;
  ACTION_DISPATCH_CENTRAL_EXTERNAL_REPOSITORIES?: string;
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

export function actionDispatchConfigFromEnv(
  environment: NodeJS.ProcessEnv | ActionDispatchEnvironment = process.env,
): ActionDispatchConfig {
  const value = environment.ACTION_DISPATCH_REQUIRE_EXPECTED_GENERATION;
  let requireExpectedGeneration: boolean;
  if (value === undefined || value === '' || value === 'false') requireExpectedGeneration = false;
  else if (value === 'true') requireExpectedGeneration = true;
  else throw new Error('ACTION_DISPATCH_REQUIRE_EXPECTED_GENERATION must be exactly true or false');

  const configuredRepositories = environment.ACTION_DISPATCH_CENTRAL_EXTERNAL_REPOSITORIES;
  let centralExternalRepositories: ReadonlyMap<string, number> = new Map();
  if (configuredRepositories !== undefined) {
    if (configuredRepositories !== SELF_HOSTED_CENTRAL_DISPATCH_REPOSITORY) {
      throw new Error('ACTION_DISPATCH_CENTRAL_EXTERNAL_REPOSITORIES must contain only explicit supported repositories');
    }
    centralExternalRepositories = new Map([
      [SELF_HOSTED_CENTRAL_DISPATCH_REPOSITORY, SELF_HOSTED_CENTRAL_DISPATCH_REPOSITORY_ID],
    ]);
  }
  let centralExternalAppCredentials: ActionDispatchConfig['centralExternalAppCredentials'];
  if (centralExternalRepositories.size > 0) {
    const publicAppId = environment.REVIEW_YETI_PUBLIC_TARGET_APP_ID?.trim();
    const publicPrivateKey = environment.REVIEW_YETI_PUBLIC_TARGET_APP_PRIVATE_KEY?.trim().replace(/\\n/g, '\n');
    if (!publicAppId || !/^[1-9][0-9]*$/u.test(publicAppId)
      || !Number.isSafeInteger(Number(publicAppId)) || !publicPrivateKey) {
      throw new Error('Dedicated public-target GitHub App credentials are required for external dispatch');
    }
    centralExternalAppCredentials = { appId: publicAppId, privateKey: publicPrivateKey };
  }

  const mcpEnabledVal = environment.REVIEW_YETI_MCP_ENABLED;
  let mcpEnabled = false;
  if (mcpEnabledVal === 'true') {
    mcpEnabled = true;
  } else if (mcpEnabledVal !== undefined && mcpEnabledVal !== '' && mcpEnabledVal !== 'false') {
    throw new Error('REVIEW_YETI_MCP_ENABLED must be exactly true or false');
  }

  const mcpAuthToken = environment.REVIEW_YETI_MCP_AUTH_TOKEN?.trim();
  if (mcpEnabled && !mcpAuthToken) {
    throw new Error('REVIEW_YETI_MCP_AUTH_TOKEN is required when REVIEW_YETI_MCP_ENABLED is true');
  }

  const mcpPath = (environment.REVIEW_YETI_MCP_PATH || '/api/mcp').trim();
  if (!mcpPath.startsWith('/')) {
    throw new Error('REVIEW_YETI_MCP_PATH must start with "/"');
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
