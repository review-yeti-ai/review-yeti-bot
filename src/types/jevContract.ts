/**
 * Vendor-contract facts about Jev (TypeSafe AI System One) that more than one layer needs.
 *
 * Lives in `src/types/` (a leaf: nothing here imports anything) and imports NOTHING itself.
 * That location is the point. Both `src/gateway/*` and `src/telemetry/metrics.ts` need these
 * facts, and gateway already depends on telemetry for spans and metrics -- so putting the shared
 * constant under `gateway/` made telemetry import back into gateway and created a module-level
 * cycle, leaving neither layer independently extractable. A leaf both sides depend on has no
 * such direction to reverse.
 *
 * The vendor is in early access and has said it cannot yet prove current pricing is
 * unsubsidised -- treat a repricing as likely, not hypothetical.
 */

/** Input tokens only; output tokens are free/unmetered. */
export const JEV_INPUT_TOKEN_USD_PER_MILLION = 0.042;

/**
 * REL-1138: the one Jev cost computation. The `review_yeti_jev_cost_usd_total` metric, the
 * shadow's per-file decision line and its per-run summary line all call this, so the three
 * figures can differ only in which calls they saw, never in how a call was priced. A
 * non-finite or negative token count prices at 0 rather than poisoning a sum with NaN.
 */
export function jevCostUsd(inputTokens: number): number {
  if (typeof inputTokens !== 'number' || !Number.isFinite(inputTokens) || inputTokens <= 0) return 0;
  return (inputTokens * JEV_INPUT_TOKEN_USD_PER_MILLION) / 1_000_000;
}

/**
 * The https rule, defined once.
 *
 * Both `JevClient`'s constructor and `jevTransport` enforce it -- deliberately, because they
 * guard different entry paths (a directly-constructed client bypasses the transport resolver
 * entirely). Defence in depth is the point; two hand-rolled COPIES of the rule are not, because
 * they drift. Callers keep their own error contracts -- a `TypeError` for a programmer error at
 * the client, the transport-contract error at the resolver -- and share this predicate.
 *
 * An unparseable URL is not https, so this is also the "is it even a URL" guard.
 */
export function isHttpsBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Why the rule exists, stated once so both call sites' messages stay honest. */
export const HTTPS_REQUIRED_REASON =
  'a plaintext base URL would send the Jev API key over the wire in cleartext';
