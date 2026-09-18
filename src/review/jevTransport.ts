import { isHttpsBaseUrl } from '../types/jevContract';

export interface JevTransportConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** TYPESAFE_MODEL_PIN — the last calibrated response-side model version, e.g. "jev-1.13.0". */
  modelPin: string;
}

function value(env: NodeJS.ProcessEnv, name: string): string {
  return String(env[name] || '').trim();
}

export function invalidJevTransportContract(): Error {
  return new Error(
    'TYPESAFE_BASE_URL, TYPESAFE_MODEL, TYPESAFE_API_KEY, and TYPESAFE_MODEL_PIN must be all present or all absent',
  );
}

/**
 * Jev (TypeSafe AI System One) transport configuration.
 *
 * This is the deliberate OPPOSITE of `openaiTransport`, and that asymmetry is intentional:
 * `openaiTransport` throws when its config is missing because without it there is no review
 * at all -- a missing publishing transport is a hard failure with no fallback.
 *
 * Jev has a real fallback: the existing deterministic review pipeline, unchanged. So absent
 * Jev config means "Jev is disabled", not "the review is broken" -- this function returns
 * `null` rather than throwing. That is fail-open in the literal sense, and it is correct here
 * specifically because the fallback is the FULL existing behavior, not a degraded one. Do not
 * "fix" this to throw like openaiTransport; that would turn an optional accelerant into a hard
 * dependency it was never meant to be.
 *
 * A *partial* configuration (some but not all four vars set) is a different case: it is not
 * "disabled", it is a misconfiguration bug, so it throws just like openaiTransport does for a
 * missing var, in order to fail loudly instead of silently limping along on a broken transport.
 */
export function jevTransport(env: NodeJS.ProcessEnv): JevTransportConfig | null {
  const baseUrl = value(env, 'TYPESAFE_BASE_URL');
  const model = value(env, 'TYPESAFE_MODEL');
  const apiKey = value(env, 'TYPESAFE_API_KEY');
  const modelPin = value(env, 'TYPESAFE_MODEL_PIN');

  const presentCount = [baseUrl, model, apiKey, modelPin].filter((entry) => entry.length > 0).length;
  if (presentCount === 0) return null;
  if (presentCount < 4) throw invalidJevTransportContract();

  // Same rule as JevClient's constructor guard, from the one shared definition in
  // ../types/jevContract -- the predicate also rejects an unparseable URL. The error contract
  // differs deliberately: this is transport misconfiguration, not a programmer error.
  if (!isHttpsBaseUrl(baseUrl)) throw invalidJevTransportContract();

  return { baseUrl, apiKey, model, modelPin };
}
