import { OpenRouterClient } from './gateway/openRouterClient';
import { GATEWAY_SETTING_NAMES, readCloudflareRunToken, resolveGatewaySettings } from './review/openaiTransport';
import { logger } from './utils/logger';

export function resolveModelClientFromEnv(
  environment: Record<string, string | undefined> = process.env,
): OpenRouterClient | undefined {
  const hasCloudflareSetting = Boolean(environment[GATEWAY_SETTING_NAMES.cloudflareBaseUrl]
    || readCloudflareRunToken(environment as NodeJS.ProcessEnv)
    || environment[GATEWAY_SETTING_NAMES.cloudflareRunAuthorization]
    || environment.CT_LLM_GATEWAY_BASE_URL
    || environment.BIFROST_BASE_URL);
  if (hasCloudflareSetting) {
    const resolved = resolveGatewaySettings(environment as NodeJS.ProcessEnv);
    if (resolved.status !== 'ok' || resolved.authorizationHeaderName !== 'cf-aig-authorization') {
      logger.warn('Cloudflare AI Gateway model client configuration is incomplete or refused');
      return undefined;
    }
    logger.info('Inbound model client initialized for remote MCP router', { transport: 'cloudflare-ai-gateway' });
    return new OpenRouterClient({
      baseUrl: resolved.baseUrl,
      apiKey: resolved.apiKey,
      authorizationHeaderName: resolved.authorizationHeaderName,
      ...(resolved.providerAuthorizationKey ? { providerAuthorizationKey: resolved.providerAuthorizationKey } : {}),
    });
  }

  const modelApiKey = environment.OPENROUTER_REVIEW_FLEET_KEY
    || environment.OPENROUTER_PR_REVIEW_API_KEY || environment.OPENROUTER_API_KEY;
  const modelBaseUrl = environment.OPENROUTER_BASE_URL;

  if (!modelApiKey) {
    logger.info('No model API key configured; remote MCP tools will operate in heuristic mode');
    return undefined;
  }

  try {
    const client = new OpenRouterClient({
      apiKey: modelApiKey,
      baseUrl: modelBaseUrl || 'https://openrouter.ai/api/v1',
    });
    logger.info('Inbound model client initialized for remote MCP router', {
      baseUrl: modelBaseUrl || 'https://openrouter.ai/api/v1',
    });
    return client;
  } catch (err) {
    logger.warn('Failed to initialize OpenRouterClient for remote MCP, defaulting to heuristic fallback', {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}
