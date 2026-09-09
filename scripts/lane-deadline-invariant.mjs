// Shared lane-deadline arithmetic invariant, used by both emit-policy.mjs (the policy-load-time
// enforcer) and review-yeti-smoke.mjs (the preflight smoke validator). Extracted after this
// invariant drifted between the two copies twice in the same PR round (once missing stall_ms
// validation, once missing lane_overhead_ms entirely) -- see exampleorg/example-meta ADR 0337.
//
// The released runtime re-arms its stall/idle timer on every SSE chunk and also enforces each
// transport's timeout_ms as a hard total generation ceiling. This invariant protects the faster
// dead-transport path -- a transport that
// never produces a first byte (`connect_timeout_ms`) or that goes silent after connecting for a
// full `stall_ms` interval -- summed across every transport, retry attempt, and investigation
// turn, plus the declared non-generation overhead reserve.

/**
 * @param {object} params
 * @param {Array<{name?: string, connect_timeout_ms: number, stall_ms: number}>} params.transports
 * @param {number} params.maxAttempts
 * @param {number} params.maxInvestigationTurns
 * @param {number} params.laneOverheadMs
 * @param {number} params.laneDeadlineMs
 * @returns {{ transportConnectSumMs: number, transportStallSumMs: number, stallEnvelopeMs: number, worstCaseDeadCallMs: number, requiredLaneBudgetMs: number }}
 * @throws {Error} if a transport stall/laneOverheadMs is not a positive safe integer, or if the computed
 *   dead-transport envelope plus overhead exceeds laneDeadlineMs.
 */
export function checkDeadTransportEnvelope({
  transports,
  maxAttempts,
  maxInvestigationTurns,
  laneOverheadMs,
  laneDeadlineMs,
}) {
  const invalidStall = transports.find(
    (transport) => !Number.isSafeInteger(transport.stall_ms) || transport.stall_ms < 1,
  );
  if (invalidStall) {
    throw new Error(`transport ${invalidStall.name || '<unnamed>'}.stall_ms must be a positive safe integer`);
  }
  if (!Number.isSafeInteger(laneOverheadMs) || laneOverheadMs < 1) {
    throw new Error('review_yeti.budget.lane_overhead_ms must be a positive integer string');
  }
  const transportConnectSumMs = transports.reduce((sum, transport) => sum + transport.connect_timeout_ms, 0);
  const transportStallSumMs = transports.reduce((sum, transport) => sum + transport.stall_ms, 0);
  const stallEnvelopeMs = transportConnectSumMs + transportStallSumMs;
  const worstCaseDeadCallMs = stallEnvelopeMs * maxAttempts;
  const requiredLaneBudgetMs = worstCaseDeadCallMs + laneOverheadMs;
  if (requiredLaneBudgetMs > laneDeadlineMs) {
    throw new Error(
      `worst-case dead-transport budget (${worstCaseDeadCallMs}ms = (${transportConnectSumMs}ms connect `
      + `+ ${transportStallSumMs}ms stall) across ${transports.length} transports `
      + `x ${maxAttempts} attempts) plus lane overhead reserve `
      + `(${laneOverheadMs}ms) exceeds review_yeti.budget.lane_deadline_ms (${laneDeadlineMs}ms); a full `
      + 'sequential failover of never-connecting or never-streaming transports could never finish the '
      + 'last transport',
    );
  }
  return {
    transportConnectSumMs,
    transportStallSumMs,
    stallEnvelopeMs,
    worstCaseDeadCallMs,
    requiredLaneBudgetMs,
  };
}

/**
 * A healthy thinking stream is capped by max_wall_clock_ms, not by the dead-TCP
 * envelope. The lane deadline must still fit that generation clock plus the
 * declared overhead reserve, or a live 15-minute Ollama stream is killed by
 * the lane watchdog after undici has already been told to wait.
 *
 * @param {object} params
 * @param {Array<{name?: string, max_wall_clock_ms?: number}>} params.transports
 * @param {number} params.laneOverheadMs
 * @param {number} params.laneDeadlineMs
 * @returns {{ maxWallClockMs: number, requiredLaneBudgetMs: number }}
 */
export function checkGenerationWallClock({
  transports,
  laneOverheadMs,
  laneDeadlineMs,
}) {
  if (!Number.isSafeInteger(laneOverheadMs) || laneOverheadMs < 1) {
    throw new Error('review_yeti.budget.lane_overhead_ms must be a positive integer string');
  }
  const wallClocks = (transports || [])
    .map((transport) => Number(transport.max_wall_clock_ms))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
  if (wallClocks.length === 0) {
    return { maxWallClockMs: 0, requiredLaneBudgetMs: laneOverheadMs };
  }
  const maxWallClockMs = Math.max(...wallClocks);
  const requiredLaneBudgetMs = maxWallClockMs + laneOverheadMs;
  if (requiredLaneBudgetMs > laneDeadlineMs) {
    throw new Error(
      `generation wall clock (${maxWallClockMs}ms) plus lane overhead reserve `
      + `(${laneOverheadMs}ms) exceeds review_yeti.budget.lane_deadline_ms (${laneDeadlineMs}ms); `
      + 'a healthy thinking stream can never finish the lane',
    );
  }
  return { maxWallClockMs, requiredLaneBudgetMs };
}
