import type { ReviewStatusOutput } from './tools/schemas';
import { reviewGateStatusForReason, type ReviewGateDecision } from '../../review/reviewGatePolicy';

export type ReviewStatusVerdict = ReviewStatusOutput['verdict'];
export type ReviewStatusPhase = ReviewStatusOutput['phase'];

type NativeGateStatus = ReviewGateDecision['status'];

type ParsedDecision =
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'verdict'; verdict: ReviewStatusVerdict }
  | { kind: 'gate'; status: NativeGateStatus };

const VERDICT_MAP: Readonly<Record<string, ReviewStatusVerdict>> = {
  SHIP: 'SHIP',
  FIX_FIRST: 'FIX_FIRST',
  BLOCK: 'NACK',
  COMMENT: 'COMMENT',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function gateTimestamp(value: unknown): number | null {
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function validRiskAudit(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const reviewedAt = gateTimestamp(value.reviewedAt);
  const appliedAt = gateTimestamp(value.appliedAt);
  return typeof value.eventId === 'number' && Number.isSafeInteger(value.eventId) && value.eventId > 0
    && typeof value.actorLogin === 'string' && /^[A-Za-z0-9-]+$/u.test(value.actorLogin)
    && typeof value.actorPermission === 'string' && ['admin', 'maintain', 'write'].includes(value.actorPermission)
    && reviewedAt !== null && appliedAt !== null && appliedAt >= reviewedAt;
}

function parseDecision(value: unknown): ParsedDecision {
  if (value === null || value === undefined) return { kind: 'missing' };

  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return { kind: 'invalid' };
    }
  }
  if (!isRecord(parsed)) return { kind: 'invalid' };

  if (hasOwn(parsed, 'verdict')) {
    if (typeof parsed.verdict !== 'string') return { kind: 'invalid' };
    const mapped = VERDICT_MAP[parsed.verdict.toUpperCase()];
    return mapped ? { kind: 'verdict', verdict: mapped } : { kind: 'invalid' };
  }

  const status = parsed.status;
  const reason = parsed.reason;
  const expectedStatus = reviewGateStatusForReason(reason);
  if (typeof status === 'string'
    && expectedStatus !== undefined && expectedStatus === status
    && parsed.eligible === (status === 'success')
    && (reason !== 'human-accepted-risk' || validRiskAudit(parsed.audit))) {
    return { kind: 'gate', status: status as NativeGateStatus };
  }

  return { kind: 'invalid' };
}

function verdictForGateState(state: unknown): ReviewStatusVerdict | undefined {
  switch (state) {
    case 'success': return 'SHIP';
    case 'failure':
    case 'cancelled':
    case 'timed_out': return 'FAILED';
    case 'queued': return 'PENDING';
    case 'in_progress': return 'RUNNING';
    default: return undefined;
  }
}

function verdictForRunStatus(status: unknown): ReviewStatusVerdict {
  switch (status) {
    case 'queued': return 'PENDING';
    case 'running':
    case 'publishing': return 'RUNNING';
    case 'succeeded':
    case 'complete': return 'SHIP';
    default: return 'FAILED';
  }
}

function fallbackVerdict(desiredState: unknown, runStatus: unknown): ReviewStatusVerdict {
  if (hasGateState(desiredState)) return verdictForGateState(desiredState) ?? 'FAILED';
  return verdictForRunStatus(runStatus);
}

function hasGateState(desiredState: unknown): boolean {
  return desiredState !== null && desiredState !== undefined && desiredState !== '';
}

function guardExplicitShip(desiredState: unknown, runStatus: unknown): ReviewStatusVerdict {
  if (hasGateState(desiredState)) return verdictForGateState(desiredState) ?? 'FAILED';

  // An explicit verdict without a gate row remains compatible with older
  // records that lack run status, but a known (or unknown nonempty) status must
  // not turn a queued, active, or failed execution into completed approval.
  if (runStatus === null || runStatus === undefined || runStatus === '') return 'SHIP';
  // The legacy continuation producer persists `completed`, outside the newer
  // run-state vocabulary. Preserve its explicit approval, but do not make this
  // status alone sufficient in the missing-decision fallback.
  if (runStatus === 'completed') return 'SHIP';
  return verdictForRunStatus(runStatus);
}

/** Projects the persisted panel decision and gate/run lifecycle into the MCP enum. */
export function projectReviewStatusVerdict(input: {
  decision: unknown;
  desiredState: unknown;
  runStatus: unknown;
}): ReviewStatusVerdict {
  const decision = parseDecision(input.decision);

  if (decision.kind === 'invalid') return 'FAILED';
  if (decision.kind === 'verdict') {
    if (decision.verdict !== 'SHIP') return decision.verdict;
    return guardExplicitShip(input.desiredState, input.runStatus);
  }

  if (decision.kind === 'gate') {
    if (decision.status === 'failure' || decision.status === 'cancelled' || decision.status === 'timed_out') {
      return 'FAILED';
    }
    if (decision.status === 'pending') {
      const stateVerdict = hasGateState(input.desiredState)
        ? verdictForGateState(input.desiredState) ?? 'FAILED'
        : undefined;
      return stateVerdict === 'FAILED' ? 'FAILED' : stateVerdict === 'RUNNING' ? 'RUNNING' : 'PENDING';
    }
    return guardExplicitShip(input.desiredState, input.runStatus);
  }

  return fallbackVerdict(input.desiredState, input.runStatus);
}

/** A cached or malformed row must never answer for another requested identity. */
export function matchesReviewStatusIdentity(row: unknown, input: {
  owner: string; repo: string; pullNumber: number; headSha?: string;
}): boolean {
  return isRecord(row) && row.owner === input.owner && row.repo === input.repo
    && row.pr_number === input.pullNumber && typeof row.head_sha === 'string'
    && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu.test(row.head_sha)
    && (!input.headSha || row.head_sha.toLowerCase().startsWith(input.headSha.toLowerCase()));
}

/** Current native lifecycle wins over lagging run projection, not approval. */
export function projectReviewStatusPhase(input: {
  desiredState: unknown;
  runStatus: unknown;
  runStage: unknown;
}): ReviewStatusPhase {
  if (input.desiredState === 'success'
    || input.desiredState === 'failure'
    || input.desiredState === 'cancelled'
    || input.desiredState === 'timed_out') {
    return 'completed';
  }
  if (hasGateState(input.desiredState)
    && input.desiredState !== 'queued' && input.desiredState !== 'in_progress') return 'unknown';
  if (input.runStatus === 'queued') {
    // Projection acknowledgement advances the native App gate before the run
    // row or worker pod. It proves control-plane progress, not persona work.
    return input.desiredState === 'in_progress' ? 'running' : 'queued';
  }
  if (input.runStatus === 'running' || input.runStatus === 'publishing') {
    return input.runStage === 'arbitration' || input.runStage === 'publish'
      ? 'arbitration'
      : 'evaluating_personas';
  }
  if (input.desiredState === 'queued' || input.desiredState === 'in_progress') return 'unknown';
  return typeof input.runStatus === 'string'
    && ['succeeded', 'complete', 'completed', 'failed', 'cancelled', 'superseded', 'terminal']
      .includes(input.runStatus) ? 'completed' : 'unknown';
}
