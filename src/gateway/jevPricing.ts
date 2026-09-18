/**
 * Jev (TypeSafe AI System One) pricing: input tokens only, output tokens are free/unmetered.
 *
 * Defined once here rather than inline in jevClient.ts's cost calculation, because
 * src/telemetry/metrics.ts also restates this rate in prose in the
 * review_yeti_jev_cost_usd_total description. Both import this constant so a repricing
 * cannot leave the metric's documentation silently misstating how the counter is computed.
 *
 * The vendor is in early access and has said it cannot yet prove current pricing is
 * unsubsidised -- treat a repricing as likely, not hypothetical.
 */
export const JEV_INPUT_TOKEN_USD_PER_MILLION = 0.042;
