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
  authorizationHeaderName: 'authorization' | 'cf-aig-authorization';
}

export interface GatewaySettings {
  baseUrl: string;
  apiKey: string;
  authorizationHeaderName: 'authorization' | 'cf-aig-authorization';
}

function value(env: NodeJS.ProcessEnv, name: string): string {
  return String(env[name] || '').trim();
}

export function invalidPublishingReviewContract(): Error {
  return new Error('publishing review worker contract is invalid');
}

/**
 * Review publishing uses the dedicated Cloudflare AI Gateway Run credential
 * and an explicit custom-provider route. Generic OpenAI-compatible credentials
 * remain available to non-publishing callers; retired Bifrost credential names
 * are deliberately not accepted here.
 */
/****INTERNAL****
 * Unpaired read. NOT exported: calling this alone is how two incidents in this
 * file were caused -- readiness answering 200 while the client threw, and the
 * `|| requiredWorkerEnv(...)` fallback reinstating a refused pairing. Callers
 * must use `resolveGatewaySettings` (guarded pair) or `requireGatewaySettings`
 * (throws). Kept module-private so misuse is a compile error, not a review
 * comment (REL-1069 review).
 */
function resolveGatewayApiKey(env: NodeJS.ProcessEnv): string {
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
  cloudflareBaseUrl: 'CLOUDFLARE_AIG_BASE_URL',
  cloudflareRunToken: 'CLOUDFLARE_AIG_RUN_TOKEN',
  baseUrl: ['OPENAI_BASE_URL', 'REVIEW_YETI_GATEWAY_BASE_URL', 'OPENROUTER_BASE_URL'],
  apiKey: ['OPENAI_API_KEY', 'OPENROUTER_REVIEW_FLEET_KEY', 'OPENROUTER_PR_REVIEW_API_KEY', 'OPENROUTER_API_KEY'],
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
  const cloudflareConfigured = Boolean(value(env, GATEWAY_SETTING_NAMES.cloudflareBaseUrl)
    || value(env, GATEWAY_SETTING_NAMES.cloudflareRunToken));
  return cloudflareConfigured
    ? [GATEWAY_SETTING_NAMES.cloudflareBaseUrl, GATEWAY_SETTING_NAMES.cloudflareRunToken]
    : [GATEWAY_SETTING_NAMES.baseUrl[0], GATEWAY_SETTING_NAMES.apiKey[0]];
}

/** Unpaired read; see the note on resolveGatewayApiKey. NOT exported. */
function resolveGatewayBaseUrl(env: NodeJS.ProcessEnv): string {
  return firstValue(env, GATEWAY_SETTING_NAMES.baseUrl);
}

/** The env name that actually wins for a setting, or undefined. */
function winningName(env: NodeJS.ProcessEnv, names: readonly string[]): string | undefined {
  return names.find((n) => value(env, n));
}

/** True when the winning base URL points at the OpenRouter vendor host. */
function isVendorHost(baseUrl: string): boolean {
  try {
    // Strip ALL trailing dots: `openrouter.ai..` is the same endpoint to a
    // resolver, and normalising only one was itself a bypass of this guard.
    const host = new URL(baseUrl).hostname.toLowerCase().replace(/\.+$/, '');
    return host === 'openrouter.ai' || host.endsWith('.openrouter.ai');
  } catch {
    return false;
  }
}

function isCloudflareGatewayHost(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase().replace(/\.+$/u, '');
    return host === 'gateway.ai.cloudflare.com';
  } catch {
    return false;
  }
}

/** Cloudflare provider-native custom routes use /v1/{account}/{gateway}/custom-{provider}/v1. */
function isCloudflareCustomProviderBaseUrl(candidate: string): boolean {
  if (/[\u0000-\u0020\u007f\\?#]/u.test(candidate) || /%(?![0-9a-f]{2})/iu.test(candidate)) return false;
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' && url.hostname.toLowerCase().replace(/\.+$/u, '') === 'gateway.ai.cloudflare.com'
      && !url.username && !url.password && !url.search && !url.hash
      && /^\/v1\/[a-f0-9]{32}\/[a-z0-9-]+\/custom-[a-z0-9-]+\/v1$/iu.test(url.pathname);
  } catch {
    return false;
  }
}

/** True when the base URL parses as an absolute https URL.
 *
 * A scheme-less value like `gateway.internal/v1` (a one-keystroke typo) is not
 * a usable gateway URL, but `isVendorHost`'s catch returned false, so resolution
 * reported `ok` and `/ready` answered 200 while the client threw at request
 * time. Validity is now checked where resolution happens, so readiness and
 * construction agree. https is required for the same reason `openaiTransport`
 * enforces it: a plaintext gateway would ship diffs off the intended path.
 */
function isAbsoluteHttpsUrl(candidate: string): boolean {
  try {
    return new URL(candidate).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Resolve the gateway key and base URL TOGETHER, so they cannot come from
 * different generations of configuration.
 *
 * A generic key (`OPENAI_API_KEY`) paired with the legacy
 * `OPENROUTER_BASE_URL` would ship the CT credential to a third-party vendor.
 * That mixed pairing is refused rather than merely documented: if the key and
 * the URL resolve from different generations, the value is discarded, so the
 * lane fails closed and names what is missing instead of leaking.
 */
export type GatewayResolution =
  | GatewaySettings & { status: 'ok' }
  | { status: 'missing'; missing: string[] }
  /** REFUSED: a non-vendor credential aimed at the vendor host.
   *
   * Distinct from `missing` because a caller that fell back to the raw
   * environment would re-admit the very values this refused -- the review found
   * exactly that hole in `|| requiredWorkerEnv(...)`. Fail closed; never re-read.
   */
  | { status: 'refused'; reason: string };

export function resolveGatewaySettings(env: NodeJS.ProcessEnv): GatewayResolution {
  const cloudflareBaseUrl = value(env, GATEWAY_SETTING_NAMES.cloudflareBaseUrl);
  const cloudflareRunToken = value(env, GATEWAY_SETTING_NAMES.cloudflareRunToken);
  // Once either dedicated Cloudflare setting is present, never fall back to a
  // generic or legacy credential. This keeps a missing Run token from silently
  // selecting another service's key.
  if (cloudflareBaseUrl || cloudflareRunToken) {
    if (!cloudflareBaseUrl || !cloudflareRunToken) {
      return {
        status: 'missing',
        missing: [
          ...(!cloudflareBaseUrl ? [GATEWAY_SETTING_NAMES.cloudflareBaseUrl] : []),
          ...(!cloudflareRunToken ? [GATEWAY_SETTING_NAMES.cloudflareRunToken] : []),
        ],
      };
    }
    if (!isCloudflareCustomProviderBaseUrl(cloudflareBaseUrl)) {
      return { status: 'refused', reason: 'Cloudflare AI Gateway base URL is not a valid custom-provider v1 route' };
    }
    return { status: 'ok', baseUrl: cloudflareBaseUrl, apiKey: cloudflareRunToken,
      authorizationHeaderName: 'cf-aig-authorization' };
  }
  const baseUrl = resolveGatewayBaseUrl(env);
  const apiKey = resolveGatewayApiKey(env);
  if (!baseUrl || !apiKey) return { status: 'missing', missing: missingNames(env) };
  if (!isAbsoluteHttpsUrl(baseUrl)) {
    return {
      status: 'refused',
      reason: 'gateway base URL is not an absolute https URL',
    };
  }
  // Refuse credentials aimed at a vendor host unless they came from that
  // vendor's explicitly named key. A Cloudflare URL also requires the dedicated
  // Run-token pair above; generic keys cannot be sent to it.
  const keyName = winningName(env, GATEWAY_SETTING_NAMES.apiKey);
  if ((isVendorHost(baseUrl) && (keyName === undefined || !keyName.startsWith('OPENROUTER_')))
      || isCloudflareGatewayHost(baseUrl)) {
    return {
      status: 'refused',
      reason: 'gateway destination requires its dedicated credential',
    };
  }
  return { status: 'ok', baseUrl, apiKey, authorizationHeaderName: 'authorization' };
}

/** Name-only check, used before the pairing rule can apply. */
function missingNames(env: NodeJS.ProcessEnv): string[] {
  const cloudflareConfigured = Boolean(value(env, GATEWAY_SETTING_NAMES.cloudflareBaseUrl)
    || value(env, GATEWAY_SETTING_NAMES.cloudflareRunToken));
  if (cloudflareConfigured) {
    return [
      ...(!value(env, GATEWAY_SETTING_NAMES.cloudflareBaseUrl) ? [GATEWAY_SETTING_NAMES.cloudflareBaseUrl] : []),
      ...(!value(env, GATEWAY_SETTING_NAMES.cloudflareRunToken) ? [GATEWAY_SETTING_NAMES.cloudflareRunToken] : []),
    ];
  }
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
export function requireGatewaySettings(env: NodeJS.ProcessEnv): GatewaySettings {
  const resolution = resolveGatewaySettings(env);
  if (resolution.status === 'ok') return {
    baseUrl: resolution.baseUrl,
    apiKey: resolution.apiKey,
    authorizationHeaderName: resolution.authorizationHeaderName,
  };
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
  // The publishing lane additionally requires the dedicated Cloudflare route;
  // generic OpenAI-compatible settings remain available only to other callers.
  const resolution = resolveGatewaySettings(env);
  if (resolution.status !== 'ok' || resolution.authorizationHeaderName !== 'cf-aig-authorization') {
    throw invalidPublishingReviewContract();
  }
  const baseUrl = resolution.baseUrl;
  const apiKey = resolution.apiKey;
  const model = value(env, 'REVIEW_MODEL');
  if (!baseUrl || !apiKey || !model) throw invalidPublishingReviewContract();
  if (['pr-reviewer', 'bifrost/pr-reviewer'].includes(model.toLowerCase())) {
    // The historical alias has no meaning on a provider-native custom route.
    // Require a separately approved upstream model id before any request can run.
    throw invalidPublishingReviewContract();
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw invalidPublishingReviewContract();
  }
  // A plaintext or non-gateway base URL would ship diffs off the intended path.
  if (parsed.protocol !== 'https:') throw invalidPublishingReviewContract();
  return { baseUrl, apiKey, model, authorizationHeaderName: resolution.authorizationHeaderName };
}

export function createOpenAIPublishingConfig(model: string): ReturnType<typeof createDefaultV3Config> {
  // Provider identity remains bound to the central prepared policy until its
  // model selection and route migration are authorized together.
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
