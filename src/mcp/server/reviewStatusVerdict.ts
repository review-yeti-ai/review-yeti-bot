import type { ReviewStatusOutput } from './tools/schemas';
import type { ReviewGateDecision } from '../../review/reviewGatePolicy';

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

// Projection validation only: native policy remains the authority. Exhaustive
// keys keep a new durable reason from silently compiling into this parser.
const GATE_REASON_STATUS: Record<ReviewGateDecision['reason'], NativeGateStatus> = {
  'review-pending': 'pending',
  'review-deadline-exceeded': 'timed_out',
  'candidate-superseded': 'cancelled',
  'pull-request-closed': 'cancelled',
  'pull-request-draft': 'cancelled',
  'review-opted-out': 'cancelled',
  'operator-cancelled': 'cancelled',
  'invalid-evidence': 'failure',
  'infrastructure-failure': 'failure',
  'incomplete-review': 'failure',
  'blocking-findings': 'failure',
  'clean-review': 'success',
  'central-exemption': 'success',
  'human-accepted-risk': 'success',
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
  if (typeof status === 'string'
    && typeof reason === 'string' && hasOwn(GATE_REASON_STATUS, reason)
    && GATE_REASON_STATUS[reason as ReviewGateDecision['reason']] === status
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
  if (desiredState) return verdictForGateState(desiredState) ?? 'PENDING';
  return verdictForRunStatus(runStatus);
}

function guardExplicitShip(desiredState: unknown, runStatus: unknown): ReviewStatusVerdict {
  if (desiredState) return verdictForGateState(desiredState) ?? 'PENDING';

  // An explicit verdict without a gate row remains compatible with older
  // records that lack run status, but a known (or unknown nonempty) status must
  // not turn a queued, active, or failed execution into completed approval.
  if (runStatus === null || runStatus === undefined || runStatus === '') return 'SHIP';
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
      const stateVerdict = verdictForGateState(input.desiredState);
      return stateVerdict === 'FAILED' ? 'FAILED' : stateVerdict === 'RUNNING' ? 'RUNNING' : 'PENDING';
    }
    return guardExplicitShip(input.desiredState, input.runStatus);
  }

  return fallbackVerdict(input.desiredState, input.runStatus);
}

/** Projects current-gate terminality while retaining the run row's live phase. */
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
  if (input.runStatus === 'queued') return 'queued';
  if (input.runStatus === 'running' || input.runStatus === 'publishing') {
    return input.runStage === 'arbitration' || input.runStage === 'publish'
      ? 'arbitration'
      : 'evaluating_personas';
  }
  return 'completed';
}
