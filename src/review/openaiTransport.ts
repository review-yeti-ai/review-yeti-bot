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
 * The OpenAI-compatible gateway is the admitted transport for every review lane.
 *
 * OPENAI_API_KEY + OPENAI_BASE_URL is the STANDARD. The key is a Bifrost virtual
 * key (`sk-b...`) and the base URL is the gateway, so a lane never talks to a
 * model vendor directly.
 *
 * The OPENROUTER_* names are LEGACY. They predate the Bifrost migration and are
 * accepted only as a fallback so an older deployment keeps booting during
 * rollout; nothing should be provisioned under them any more, and the review
 * lane is not OpenRouter-backed. New gates must read this resolver rather than
 * naming a vendor, because a hardcoded vendor name is what made the full-app
 * readiness probe report 503 on a correctly-configured Bifrost deployment
 * (REL-1069) while every other review workload was healthy.
 */
const LEGACY_OPENROUTER_KEY_NAMES = [
  'OPENROUTER_REVIEW_FLEET_KEY',
  'OPENROUTER_PR_REVIEW_API_KEY',
  'OPENROUTER_API_KEY',
] as const;

/** Resolve the admitted gateway key, preferring the standard OpenAI name. */
export function resolveGatewayApiKey(env: NodeJS.ProcessEnv): string {
  const standard = value(env, 'OPENAI_API_KEY') || value(env, 'REVIEW_YETI_BIFROST_API_KEY')
    || value(env, 'BIFROST_VIRTUAL_KEY');
  if (standard) return standard;
  for (const name of LEGACY_OPENROUTER_KEY_NAMES) {
    const legacy = value(env, name);
    if (legacy) return legacy;
  }
  return '';
}

/**
 * The gateway settings the review transport requires, with the names it accepts.
 *
 * This is the single source of truth for readiness AND client construction. A
 * gate that re-lists these fields by hand drifts the moment one is added or
 * removed -- which is exactly how `/ready` came to answer 200 while
 * `openRouterClient()` threw on every request (REL-1069 review).
 */
export const GATEWAY_SETTING_NAMES = {
  baseUrl: ['OPENAI_BASE_URL', 'REVIEW_YETI_GATEWAY_BASE_URL', 'BIFROST_BASE_URL', 'OPENROUTER_BASE_URL'],
  apiKey: ['OPENAI_API_KEY', 'REVIEW_YETI_BIFROST_API_KEY', 'BIFROST_VIRTUAL_KEY',
    'OPENROUTER_REVIEW_FLEET_KEY', 'OPENROUTER_PR_REVIEW_API_KEY', 'OPENROUTER_API_KEY'],
} as const;

/**
 * Names of required gateway settings that are absent, primary name first.
 *
 * Returns the FIRST accepted name of each missing setting so a failure can name
 * a variable an operator can actually set, rather than an opaque URL-parse or
 * connection error at request time.
 */
export function missingGatewaySettings(env: NodeJS.ProcessEnv): string[] {
  const missing: string[] = [];
  if (!resolveGatewayBaseUrl(env)) missing.push(GATEWAY_SETTING_NAMES.baseUrl[0]);
  if (!resolveGatewayApiKey(env)) missing.push(GATEWAY_SETTING_NAMES.apiKey[0]);
  return missing;
}

/** Resolve the admitted gateway base URL, preferring the standard OpenAI name. */
export function resolveGatewayBaseUrl(env: NodeJS.ProcessEnv): string {
  return value(env, 'OPENAI_BASE_URL') || value(env, 'REVIEW_YETI_GATEWAY_BASE_URL')
    || value(env, 'BIFROST_BASE_URL') || value(env, 'OPENROUTER_BASE_URL');
}

/** Resolve the canonical webhook secret name.
 *
 * `GITHUB_WEBHOOK_SECRET` is what the app, the wizard and every synced
 * environment already use (see githubWebhookConfig and initWizard);
 * `WEBHOOK_SECRET` was a second spelling that no deployment sets, so a
 * readiness gate requiring it failed on a correct environment.
 */
export function resolveWebhookSecret(env: NodeJS.ProcessEnv): string {
  return value(env, 'GITHUB_WEBHOOK_SECRET') || value(env, 'WEBHOOK_SECRET');
}

/**
 * Both the base URL and the key are required: defaulting either one is refused
 * fail-closed, so a misconfigured lane cannot silently ship diffs to a vendor.
 */
export function openaiTransport(env: NodeJS.ProcessEnv): OpenAITransportConfig {
  const baseUrl = resolveGatewayBaseUrl(env);
  const apiKey = resolveGatewayApiKey(env);
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
