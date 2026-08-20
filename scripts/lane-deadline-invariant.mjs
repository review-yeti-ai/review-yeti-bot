// Shared lane-deadline arithmetic invariant, used by both emit-policy.mjs (the policy-load-time
// enforcer) and review-yeti-smoke.mjs (the preflight smoke validator). Extracted after this
// invariant drifted between the two copies twice in the same PR round (once missing stall_ms
// validation, once missing lane_overhead_ms entirely) -- see exampleorg/example-meta ADR 0337.
//
// Post review-yeti-bot#163, an actively-streaming call is never aborted by a duration cap: the
// engine's stall/idle timer re-arms on every SSE chunk, so `timeout_ms` no longer bounds a lane's
// worst-case wall time. What genuinely bounds it is the dead-transport path -- a transport that
// never produces a first byte (`connect_timeout_ms`) or that goes silent after connecting for a
// full `stall_ms` interval -- summed across every transport, retry attempt, and investigation
// turn, plus the declared non-generation overhead reserve.

/**
 * @param {object} params
 * @param {Array<{connect_timeout_ms: number}>} params.transports
 * @param {number} params.stallMs
 * @param {number} params.maxAttempts
 * @param {number} params.maxInvestigationTurns
 * @param {number} params.laneOverheadMs
 * @param {number} params.laneDeadlineMs
 * @returns {{ transportConnectSumMs: number, stallEnvelopeMs: number, worstCaseDeadCallMs: number, requiredLaneBudgetMs: number }}
 * @throws {Error} if stallMs/laneOverheadMs are not positive safe integers, or if the computed
 *   dead-transport envelope plus overhead exceeds laneDeadlineMs.
 */
export function checkDeadTransportEnvelope({
  transports,
  stallMs,
  maxAttempts,
  maxInvestigationTurns,
  laneOverheadMs,
  laneDeadlineMs,
}) {
  if (!Number.isSafeInteger(stallMs) || stallMs < 1) {
    throw new Error('review_yeti.stall_ms must be a positive integer string');
  }
  if (!Number.isSafeInteger(laneOverheadMs) || laneOverheadMs < 1) {
    throw new Error('review_yeti.budget.lane_overhead_ms must be a positive integer string');
  }
  const transportConnectSumMs = transports.reduce((sum, transport) => sum + transport.connect_timeout_ms, 0);
  const stallEnvelopeMs = transportConnectSumMs + transports.length * stallMs;
  const worstCaseDeadCallMs = stallEnvelopeMs * maxAttempts * maxInvestigationTurns;
  const requiredLaneBudgetMs = worstCaseDeadCallMs + laneOverheadMs;
  if (requiredLaneBudgetMs > laneDeadlineMs) {
    throw new Error(
      `worst-case dead-transport budget (${worstCaseDeadCallMs}ms = (${transportConnectSumMs}ms connect `
      + `+ ${transports.length} x ${stallMs}ms stall) across ${transports.length} transports `
      + `x ${maxAttempts} attempts x ${maxInvestigationTurns} turns) plus lane overhead reserve `
      + `(${laneOverheadMs}ms) exceeds review_yeti.budget.lane_deadline_ms (${laneDeadlineMs}ms); a full `
      + 'sequential failover of never-connecting or never-streaming transports could never finish the '
      + 'last transport',
    );
  }
  return { transportConnectSumMs, stallEnvelopeMs, worstCaseDeadCallMs, requiredLaneBudgetMs };
}
