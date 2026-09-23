import { OpenRouterClient } from './gateway/openRouterClient';
import { logger } from './utils/logger';

export function resolveModelClientFromEnv(
  environment: Record<string, string | undefined> = process.env,
): OpenRouterClient | undefined {
  const modelApiKey =
    environment.OPENROUTER_API_KEY ||
    environment.REVIEW_YETI_BIFROST_API_KEY ||
    environment.BIFROST_VIRTUAL_KEY ||
    environment.OPENROUTER_PR_REVIEW_API_KEY;
  const modelBaseUrl =
    environment.OPENROUTER_BASE_URL ||
    environment.BIFROST_BASE_URL;

  if (!modelApiKey) {
    logger.info('No model API key configured; remote MCP tools will operate in heuristic mode');
    return undefined;
  }

  try {
    const client = new OpenRouterClient({
      apiKey: modelApiKey,
      baseUrl: modelBaseUrl,
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
