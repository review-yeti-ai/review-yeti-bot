import { createDefaultV3Config } from '../config/configLoader';
import {
  PUBLISHING_IDLE_TIMEOUT_SECONDS,
  PUBLISHING_MAX_TURNS,
  PUBLISHING_OVERALL_TIMEOUT_SECONDS,
} from '../config/publishingWorkerConfig';

export interface OpenAITransportConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

function value(env: NodeJS.ProcessEnv, name: string): string {
  return String(env[name] || '').trim();
}

export function invalidPublishingReviewContract(): Error {
  return new Error('publishing review worker contract is invalid');
}

/**
 * OpenAI-compatible gateway is the admitted transport for the publishing lane.
 * Both the base URL and the key are required from the environment:
 * OPENAI_BASE_URL and OPENAI_API_KEY. Defaulting either one is refused fail-closed.
 */
export function openaiTransport(env: NodeJS.ProcessEnv): OpenAITransportConfig {
  const baseUrl = value(env, 'OPENAI_BASE_URL');
  const apiKey = value(env, 'OPENAI_API_KEY');
  const model = value(env, 'REVIEW_MODEL');
  if (!baseUrl || !apiKey || !model) throw invalidPublishingReviewContract();
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw invalidPublishingReviewContract();
  }
  // A plaintext or non-gateway base URL would ship diffs off the intended path.
  if (parsed.protocol !== 'https:') throw invalidPublishingReviewContract();
  return { baseUrl, apiKey, model };
}

export function createOpenAIPublishingConfig(model: string): ReturnType<typeof createDefaultV3Config> {
  const providerId = 'bifrost';
  const config = createDefaultV3Config();
  return {
    ...config,
    default_max_turns: PUBLISHING_MAX_TURNS,
    personas: config.personas.map((persona) => ({ ...persona, providers: [providerId] })),
    reviewers: {
      ...config.reviewers,
      overall_timeout_s: PUBLISHING_OVERALL_TIMEOUT_SECONDS,
      fallback: 'none',
      providers: [
        {
          id: providerId,
          enabled: true,
          model,
          effort: 'medium',
          review_timeout_s: PUBLISHING_IDLE_TIMEOUT_SECONDS,
          arbiter_timeout_s: PUBLISHING_IDLE_TIMEOUT_SECONDS,
        },
      ],
      arbiter: {
        order: [providerId],
      },
    },
  };
}
