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
/** Resolve the admitted gateway key, in GATEWAY_SETTING_NAMES order. */
export function resolveGatewayApiKey(env: NodeJS.ProcessEnv): string {
  return firstValue(env, GATEWAY_SETTING_NAMES.apiKey);
}

/** The first of `names` present in `env`, trimmed. */
function firstValue(env: NodeJS.ProcessEnv, names: readonly string[]): string {
  for (const name of names) {
    const found = value(env, name);
    if (found) return found;
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
  // Uses the PAIRED resolver: a mixed-generation environment reports both
  // settings missing, so readiness refuses instead of admitting a lane that
  // would ship the credential to the legacy vendor.
  const resolution = resolveGatewaySettings(env);
  if (resolution.status === 'ok') return [];
  if (resolution.status === 'missing') return resolution.missing;
  // A refused pair reports as missing so a probe cannot advertise a lane whose
  // credential would be leaked. Callers needing the distinction use
  // resolveGatewaySettings directly.
  return [GATEWAY_SETTING_NAMES.baseUrl[0], GATEWAY_SETTING_NAMES.apiKey[0]];
}

/** Resolve the admitted gateway base URL, preferring the standard OpenAI name.
 *
 * Resolved as a PAIR with the key by `resolveGatewaySettings`; calling this
 * alone can pair a standard Bifrost key with a legacy vendor URL, which would
 * send the CT credential to a third party.
 */
export function resolveGatewayBaseUrl(env: NodeJS.ProcessEnv): string {
  return firstValue(env, GATEWAY_SETTING_NAMES.baseUrl);
}

/** The env name that actually wins for a setting, or undefined. */
function winningName(env: NodeJS.ProcessEnv, names: readonly string[]): string | undefined {
  return names.find((n) => value(env, n));
}

/** True when the winning base URL points at the OpenRouter vendor host. */
function isVendorHost(baseUrl: string): boolean {
  try {
    // A trailing dot is a valid FQDN root and the same endpoint to every
    // resolver, so `openrouter.ai.` must be refused exactly like
    // `openrouter.ai` (REL-1069 review: the un-normalised form was a silent
    // bypass of the credential-leak guard).
    const host = new URL(baseUrl).hostname.toLowerCase().replace(/\.$/, '');
    return host === 'openrouter.ai' || host.endsWith('.openrouter.ai');
  } catch {
    return false;
  }
}

/**
 * Resolve the gateway key and base URL TOGETHER, so they cannot come from
 * different generations of configuration.
 *
 * A standard Bifrost key (`OPENAI_API_KEY`) paired with the legacy
 * `OPENROUTER_BASE_URL` would ship the CT credential to a third-party vendor.
 * That mixed pairing is refused rather than merely documented: if the key and
 * the URL resolve from different generations, the value is discarded, so the
 * lane fails closed and names what is missing instead of leaking.
 */
export type GatewayResolution =
  | { status: 'ok'; baseUrl: string; apiKey: string }
  | { status: 'missing'; missing: string[] }
  /** REFUSED: a non-vendor credential aimed at the vendor host.
   *
   * Distinct from `missing` because a caller that fell back to the raw
   * environment would re-admit the very values this refused -- the review found
   * exactly that hole in `|| requiredWorkerEnv(...)`. Fail closed; never re-read.
   */
  | { status: 'refused'; reason: string };

export function resolveGatewaySettings(env: NodeJS.ProcessEnv): GatewayResolution {
  const baseUrl = resolveGatewayBaseUrl(env);
  const apiKey = resolveGatewayApiKey(env);
  if (!baseUrl || !apiKey) return { status: 'missing', missing: missingNames(env) };
  // Refuse ONLY the credential-leak case: a key that did NOT come from an
  // OpenRouter variable, aimed at the OpenRouter vendor host. Sending a CT
  // (Bifrost) credential to a third-party vendor is the harm; a legacy key
  // pointed at our own gateway is not, and refusing it would break a rollout.
  // Deliberately NOT a generation-equality rule: that rejects benign
  // combinations and the mixed-but-safe case of a legacy key on a Bifrost URL.
  const keyName = winningName(env, GATEWAY_SETTING_NAMES.apiKey);
  if (isVendorHost(baseUrl) && (keyName === undefined || !keyName.startsWith('OPENROUTER_'))) {
    return {
      status: 'refused',
      reason: 'gateway base URL points at the OpenRouter vendor host but the credential is not an OpenRouter key',
    };
  }
  return { status: 'ok', baseUrl, apiKey };
}

/** Name-only check, used before the pairing rule can apply. */
function missingNames(env: NodeJS.ProcessEnv): string[] {
  const missing: string[] = [];
  if (!resolveGatewayBaseUrl(env)) missing.push(GATEWAY_SETTING_NAMES.baseUrl[0]);
  if (!resolveGatewayApiKey(env)) missing.push(GATEWAY_SETTING_NAMES.apiKey[0]);
  return missing;
}

/** Resolve or THROW, naming what to fix.
 *
 * Never re-reads the raw environment, so a refused pairing cannot be reinstated
 * by a fallback -- the regression this replaces.
 */
export function requireGatewaySettings(env: NodeJS.ProcessEnv): { baseUrl: string; apiKey: string } {
  const resolution = resolveGatewaySettings(env);
  if (resolution.status === 'ok') return { baseUrl: resolution.baseUrl, apiKey: resolution.apiKey };
  if (resolution.status === 'refused') throw new Error(`gateway configuration refused: ${resolution.reason}`);
  throw new Error(`required environment variable ${resolution.missing.join('/')} is missing`);
}

/**
 * Both the base URL and the key are required: defaulting either one is refused
 * fail-closed, so a misconfigured lane cannot silently ship diffs to a vendor.
 */
export function openaiTransport(env: NodeJS.ProcessEnv): OpenAITransportConfig {
  // The PAIR: this is the path that actually TRANSMITS the credential, so the
  // leak guard matters most here. Resolved inline (not via
  // `requireGatewaySettings`) because THIS contract reports every failure as its
  // own `invalidPublishingReviewContract()` -- callers match on that message, so
  // a generic "required environment variable" error would break the contract.
  // The refusal is still honored: both values are discarded, which trips the
  // check below.
  const resolution = resolveGatewaySettings(env);
  const baseUrl = resolution.status === 'ok' ? resolution.baseUrl : '';
  const apiKey = resolution.status === 'ok' ? resolution.apiKey : '';
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
