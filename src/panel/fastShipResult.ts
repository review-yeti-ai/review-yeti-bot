import { ProviderId } from '../config/schema';
import { ClassifierResult } from './classifierEngine';
import { PanelResult, PersonaLaneResult } from './types';

/**
 * Builds a deterministic, valid PanelResult for fast-shipped PRs.
 * Guarantees that the shape, quorum, moderator, and arbiter outputs remain
 * structurally consistent with standard multi-persona consensus results.
 */
export function buildFastShipPanelResult(
  classifierResult: ClassifierResult,
  headSha: string,
  requiredQuorum: number = 1
): PanelResult {
  const providerId = (classifierResult.providerId as ProviderId) || ('fast-ship' as ProviderId);
  const model = classifierResult.model || 'fast-ship-classifier';
  const durationMs = classifierResult.durationMs || 0;
  const costUSD = classifierResult.costUSD || null;
  const usage = classifierResult.usage || null;

  const fastShipLane: PersonaLaneResult = {
    id: 'fast-ship',
    required: true,
    providerId,
    model,
    decision: 'APPROVE',
    findings: [],
    usage,
    costUSD,
    durationMs,
  };

  const distinctProviders = [providerId];
  const satisfied = distinctProviders.length >= requiredQuorum;

  return {
    headSha,
    personas: [fastShipLane],
    optionalFailures: [],
    quorum: {
      required: requiredQuorum,
      distinctProviders,
      satisfied,
    },
    moderator: {
      providerId,
      model,
      decision: 'RECONCILED',
      findings: [],
      usage: null,
      costUSD: 0,
      durationMs: 0,
    },
    arbiter: {
      providerId,
      model,
      verdict: 'SHIP',
      rationale: `Fast-ship auto-approved: ${classifierResult.rationale}`,
      usage,
      costUSD,
      durationMs,
    },
  };
}
