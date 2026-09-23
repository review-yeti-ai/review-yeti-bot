import { ProviderId } from '../config/schema';
import { ClassifierResult } from './classifierEngine';
import { PanelResult, PersonaLaneResult } from './types';

/**
 * Builds a deterministic, valid PanelResult for fast-shipped PRs.
 * Guarantees that the shape, quorum, moderator, and arbiter outputs remain
 * structurally consistent with standard multi-persona consensus results.
 */
export interface FastShipPanelResult extends PanelResult {
  isFastShip: true;
  classifierRationale: string;
  tokensSaved: number;
  /** Set when the approval came from path classification, not the triage classifier. */
  documentationOnly?: true;
}

export function isFastShipPanelResult(result: unknown): result is FastShipPanelResult {
  return Boolean(result && typeof result === 'object' && (result as FastShipPanelResult).isFastShip === true);
}

export function buildFastShipPanelResult(
  classifierResult: ClassifierResult,
  headSha: string,
  requiredQuorum: number = 1
): FastShipPanelResult {
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
  const tokensSaved = (classifierResult as any).tokensSaved ?? Math.max(0, 15_000 - (usage?.total || 0));

  return {
    headSha,
    applicablePersonaIds: [],
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
    isFastShip: true,
    classifierRationale: classifierResult.rationale,
    tokensSaved,
  };
}

/**
 * Builds an approval for a diff that contains no analyzable source.
 *
 * A diff of pure documentation, assets or data files has nothing for a persona
 * to review, so the panel selects no lanes. That previously surfaced as a
 * zero-lane result, which publishing correctly refuses to accept as review
 * evidence -- and the net effect was that a documentation- or evidence-only
 * pull request could never be reviewed at all, only blocked. Nothing about
 * those paths is unsafe; there is simply nothing to analyze, and "nothing to
 * analyze" is an approval, not an absence of evidence.
 *
 * This is deliberately deterministic: no provider is consulted, so it cannot
 * fail open on a transport outage the way a real lane can.
 */
export function buildDocumentationOnlyPanelResult(
  headSha: string,
  providerId: ProviderId,
  rationale: string,
  requiredQuorum: number = 1,
  noReviewableContentKind: 'documentation' | 'lockfile-or-generated' = 'documentation',
): FastShipPanelResult {
  const lane: PersonaLaneResult = {
    id: 'documentation-only',
    required: true,
    providerId,
    model: 'path-classification',
    decision: 'APPROVE',
    findings: [],
    usage: null,
    costUSD: 0,
    durationMs: 0,
  };

  return {
    headSha,
    applicablePersonaIds: [],
    personas: [lane],
    optionalFailures: [],
    quorum: { required: requiredQuorum, distinctProviders: [providerId], satisfied: true },
    moderator: {
      providerId,
      model: 'path-classification',
      decision: 'RECONCILED',
      findings: [],
      usage: null,
      costUSD: 0,
      durationMs: 0,
    },
    arbiter: {
      providerId,
      model: 'path-classification',
      verdict: 'SHIP',
      rationale,
      usage: null,
      costUSD: 0,
      durationMs: 0,
    },
    isFastShip: true,
    documentationOnly: true,
    noReviewableContentKind,
    classifierRationale: rationale,
    tokensSaved: 0,
  };
}
