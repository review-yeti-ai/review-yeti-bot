import { isRecoverableFailureTitle, REVIEW_GATE_CHECK_NAME } from './reviewCheckIdentity';
import {
  formatIncompleteRosterGateSummary,
  parseGracefulComposedSummary,
  parseIncompleteRosterSummary,
} from './incompleteRosterSummary';

export const MAX_RECOVERABLE_REVIEW_GENERATION = 3;
export const REVIEW_WORKER_CHECK_NAME = 'Review Yeti';
export const REVIEW_WORKER_APP_SLUG = 'ct-review-bot';
export const RECOVERABLE_WORKER_CONCLUSIONS: ReadonlySet<string> = new Set([
  'failure',
  'action_required',
]);

export interface ReviewGenerationRecoveryRequest {
  owner: string;
  repo: string;
  headSha: string;
  runId: string;
  expectedGeneration: number;
  expectedAppId: number;
  /** Candidate classification only; durable findings are checked before admission. */
  incompleteP2Recovery?: true;
  /** Internal-only, service-derived mode for the single graceful composed retry. */
  gracefulComposedContinuation?: true;
}

export interface ReviewGenerationRecoveryEvidence {
  generation: number;
  checkId: number;
  externalId: string;
  conclusion: 'failure' | 'action_required';
  title: string;
  /** Raw trusted observations, not a caller-supplied classification or a rewritten verdict. */
  legacyIncompleteRoster?: {
    workerSummary: string;
    workerCompletedAt: string;
    gracefulComposedPartial?: true;
    /** The actual App-owned worker start time, retained so later retries can
     * derive adjacent worker windows without rewriting earlier receipts. */
    workerStartedAt?: string;
    /** The next actual worker bounds older Gate history; absent for the latest worker. */
    nextWorkerStartedAt?: string;
    /** Service-created digest of the composed checkpoint validated at admission. */
    gracefulCheckpointReceipt?: { revision: number; digest: string };
    gateChecks: unknown[];
  };
}

export class ReviewGenerationRecoveryLedgerError extends Error {
  readonly name = 'ReviewGenerationRecoveryLedgerError';

  constructor() {
    super('Review generation recovery ledger is invalid');
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function refuse(): never {
  throw new ReviewGenerationRecoveryLedgerError();
}

function completedAt(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(value)) return NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().replace('.000Z', 'Z') === value ? parsed : NaN;
}

/** Compatibility with the central caller's strict old-publisher no-verdict recovery contract. */
function hasLegacyIncompleteRosterProof(
  request: ReviewGenerationRecoveryRequest,
  proof: ReviewGenerationRecoveryEvidence['legacyIncompleteRoster'],
): boolean {
  if (!proof || typeof proof.workerSummary !== 'string'
    || !Number.isFinite(completedAt(proof.workerCompletedAt))
    || !Array.isArray(proof.gateChecks) || proof.gateChecks.length === 0
    || proof.gateChecks.length >= 1_000) return false;
  const counts = parseIncompleteRosterSummary(proof.workerSummary, request.headSha);
  if (!counts) return false;
  const isZeroFindingSummary = counts.canonicalFindingCountText === '0'
    && counts.rawFindingCountText === '0';
  const isP2FindingSummary = request.incompleteP2Recovery === true
    && /^[1-9][0-9]*$/u.test(counts.canonicalFindingCountText)
    && /^[1-9][0-9]*$/u.test(counts.rawFindingCountText);
  if (!isZeroFindingSummary && !isP2FindingSummary) return false;

  const newest = selectIncompleteRecoveryGate(request, proof);
  const output = record(newest?.output);
  return newest?.conclusion === 'failure'
    && output?.title === 'Review Yeti Gate: Failed (incomplete panel)'
    && output.summary === formatIncompleteRosterGateSummary(counts.expectedLanes, counts.completedLanes);
}

function hasP2FindingSummary(
  request: ReviewGenerationRecoveryRequest,
  proof: ReviewGenerationRecoveryEvidence['legacyIncompleteRoster'],
): boolean {
  const counts = parseIncompleteRosterSummary(proof?.workerSummary, request.headSha);
  return request.incompleteP2Recovery === true && counts !== null
    && /^[1-9][0-9]*$/u.test(counts.canonicalFindingCountText)
    && /^[1-9][0-9]*$/u.test(counts.rawFindingCountText);
}

function hasGracefulComposedProof(
  request: ReviewGenerationRecoveryRequest,
  proof: ReviewGenerationRecoveryEvidence['legacyIncompleteRoster'],
): boolean {
  if (request.gracefulComposedContinuation !== true || proof?.gracefulComposedPartial !== true
    || typeof proof.workerSummary !== 'string') return false;
  const checkpointReceipt = proof.gracefulCheckpointReceipt;
  if (checkpointReceipt !== undefined
    && (!Number.isSafeInteger(checkpointReceipt.revision) || checkpointReceipt.revision <= 0
      || typeof checkpointReceipt.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(checkpointReceipt.digest))) return false;
  const counts = parseGracefulComposedSummary(proof.workerSummary, request.headSha);
  if (!counts || counts.canonicalFindingCount <= 0 || counts.rawFindingCount <= 0) return false;
  const newest = selectIncompleteRecoveryGate(request, proof);
  const output = record(newest?.output);
  return newest?.conclusion === 'failure'
    && output?.title === 'Review Yeti Gate: Failed (incomplete panel)'
    && output.summary === formatIncompleteRosterGateSummary(counts.expectedLanes, counts.completedLanes);
}

/** The latest real Gate within the exact worker's lifetime boundary. Never search
 * backwards past a newer conflicting result to find a convenient failure. */
export function selectIncompleteRecoveryGate(
  request: ReviewGenerationRecoveryRequest,
  proof: NonNullable<ReviewGenerationRecoveryEvidence['legacyIncompleteRoster']>,
): Record<string, unknown> | undefined {
  const lower = completedAt(proof.workerCompletedAt);
  const upper = proof.nextWorkerStartedAt === undefined ? Infinity : completedAt(proof.nextWorkerStartedAt);
  if (!Number.isFinite(lower) || !(upper > lower)
    || !Array.isArray(proof.gateChecks) || proof.gateChecks.length === 0 || proof.gateChecks.length >= 1_000) return undefined;
  let newest: Record<string, unknown> | undefined;
  const candidates: Record<string, unknown>[] = [];
  const seen = new Set<number>();
  for (const value of proof.gateChecks) {
    const gate = record(value);
    const app = record(gate?.app);
    const id = gate?.id;
    if (!Number.isSafeInteger(id) || (id as number) <= 0 || seen.has(id as number)
      || gate?.name !== REVIEW_GATE_CHECK_NAME || gate.head_sha !== request.headSha
      || app?.id !== request.expectedAppId || app.slug !== REVIEW_WORKER_APP_SLUG
      || typeof gate.external_id !== 'string'
      || !/^review-yeti-gate:v1:[a-f0-9]{64}$/u.test(gate.external_id)
      || gate.status !== 'completed' || !Number.isFinite(completedAt(gate.completed_at))) return undefined;
    seen.add(id as number);
    const time = completedAt(gate.completed_at);
    if (time < lower || time >= upper) continue;
    candidates.push(gate);
    if (!newest || completedAt(gate.completed_at) > completedAt(newest.completed_at)
      || (completedAt(gate.completed_at) === completedAt(newest.completed_at) && (id as number) > (newest.id as number))) newest = gate;
  }
  if ((request.incompleteP2Recovery === true || request.gracefulComposedContinuation === true) && newest) {
    const decisionFields = (value: Record<string, unknown>) => {
      const output = record(value.output);
      return JSON.stringify([value.external_id, value.status, value.conclusion, output?.title, output?.summary]);
    };
    const latestDecisions = new Set(candidates.filter((gate) =>
      completedAt(gate.completed_at) === completedAt(newest!.completed_at)).map(decisionFields));
    if (latestDecisions.size !== 1) return undefined;
  }
  return newest;
}

export function validateReviewGenerationRecoveryRequest(
  request: ReviewGenerationRecoveryRequest,
): void {
  if (!/^[A-Za-z0-9_.-]{1,100}$/u.test(request.owner)
    || !/^[A-Za-z0-9_.-]{1,100}$/u.test(request.repo)
    || !/^[a-f0-9]{40}$/u.test(request.headSha)
    || !/^run_[a-f0-9]{32}$/u.test(request.runId)
    || !Number.isSafeInteger(request.expectedAppId) || request.expectedAppId <= 0
    || !Number.isSafeInteger(request.expectedGeneration)
    || request.expectedGeneration < 2
    || request.expectedGeneration > MAX_RECOVERABLE_REVIEW_GENERATION
    || (request.incompleteP2Recovery === true && request.gracefulComposedContinuation === true)
    || (request.gracefulComposedContinuation === true && request.expectedGeneration !== 2)) refuse();
}

function validateReviewGenerationRecoveryEvidenceInternal(
  request: ReviewGenerationRecoveryRequest,
  evidence: ReviewGenerationRecoveryEvidence[],
  allowPersistedLegacyP2StartOmission: boolean,
): ReviewGenerationRecoveryEvidence[] {
  validateReviewGenerationRecoveryRequest(request);
  if (!Array.isArray(evidence) || evidence.length !== request.expectedGeneration - 1) refuse();
  for (let index = 0; index < evidence.length; index += 1) {
    const entry = evidence[index];
    const generation = index + 1;
    const checkpointReceipt = entry?.legacyIncompleteRoster?.gracefulCheckpointReceipt;
    if (checkpointReceipt !== undefined && request.gracefulComposedContinuation !== true) refuse();
    const recoverableFailure = isRecoverableFailureTitle(entry?.title)
      || (entry?.title === 'Review Yeti: BLOCK'
        && (request.incompleteP2Recovery !== true || generation === request.expectedGeneration - 1
          || entry.legacyIncompleteRoster?.nextWorkerStartedAt !== undefined)
        && hasLegacyIncompleteRosterProof(request, entry.legacyIncompleteRoster));
    const gracefulComposedFailure = request.gracefulComposedContinuation === true
      && generation === 1
      && entry?.title === 'Review Yeti: INCOMPLETE (partial evidence published)'
      && entry.conclusion === 'failure'
      && hasGracefulComposedProof(request, entry.legacyIncompleteRoster);
    const markerBoundLegacyP2StartOmission = allowPersistedLegacyP2StartOmission
      && generation === request.expectedGeneration - 1
      && entry?.title === 'Review Yeti: BLOCK'
      && entry.legacyIncompleteRoster?.workerStartedAt === undefined
      && hasP2FindingSummary(request, entry.legacyIncompleteRoster);
    const requiresWorkerInterval = request.incompleteP2Recovery === true
      || request.gracefulComposedContinuation === true;
    const intervalProof = entry?.legacyIncompleteRoster;
    const p2WorkerIntervalValid = !requiresWorkerInterval
      || (entry?.title !== 'Review Yeti: BLOCK'
        && entry?.title !== 'Review Yeti: INCOMPLETE (partial evidence published)')
      || generation < request.expectedGeneration - 1
      || (Number.isFinite(completedAt(intervalProof?.workerStartedAt))
        && completedAt(intervalProof?.workerStartedAt)
        <= completedAt(intervalProof?.workerCompletedAt))
      || markerBoundLegacyP2StartOmission;
    if (entry?.generation !== generation
      || !Number.isSafeInteger(entry.checkId) || entry.checkId <= 0
      || entry.externalId !== `${request.runId}:a${generation}`
      || !RECOVERABLE_WORKER_CONCLUSIONS.has(entry.conclusion)
      || (!recoverableFailure && !gracefulComposedFailure) || !p2WorkerIntervalValid) refuse();
  }
  return evidence;
}

/** Validate an App-ledger proof for new admission. Missing worker start times
 * remain invalid, including for incomplete-P2 retries. */
export function validateReviewGenerationRecoveryEvidence(
  request: ReviewGenerationRecoveryRequest,
  evidence: ReviewGenerationRecoveryEvidence[],
): ReviewGenerationRecoveryEvidence[] {
  return validateReviewGenerationRecoveryEvidenceInternal(request, evidence, false);
}

/** Reader-only compatibility for the already-admitted legacy P2 receipt shape.
 * The caller must reconstruct the context and match its durable admission
 * marker before returning any findings. This accepts only an absent latest
 * worker start; malformed or inverted present intervals still fail closed. */
export function validatePersistedLegacyIncompleteP2RecoveryEvidence(
  request: ReviewGenerationRecoveryRequest,
  evidence: ReviewGenerationRecoveryEvidence[],
  expectedContextDigest: string,
): ReviewGenerationRecoveryEvidence[] {
  if (request.incompleteP2Recovery !== true || !/^[a-f0-9]{64}$/u.test(expectedContextDigest)) refuse();
  return validateReviewGenerationRecoveryEvidenceInternal(request, evidence, true);
}

/** Fetch-stage candidate validation only. Summary counts are deliberately left
 * uninterpreted until the locked archive reader binds the original completion
 * digest and failed Gate. This never authorizes generation allocation. */
export function validateIncompleteP2RecoveryLedgerCandidate(
  request: ReviewGenerationRecoveryRequest,
  evidence: ReviewGenerationRecoveryEvidence[],
): ReviewGenerationRecoveryEvidence[] {
  validateReviewGenerationRecoveryRequest(request);
  if ((request.incompleteP2Recovery !== true && request.gracefulComposedContinuation !== true) || !Array.isArray(evidence)
    || evidence.length !== request.expectedGeneration - 1) refuse();
  let previousCompleted = -Infinity;
  for (let index = 0; index < evidence.length; index += 1) {
    const proof = evidence[index];
    const roster = proof?.legacyIncompleteRoster;
    const start = completedAt(roster?.workerStartedAt);
    const end = completedAt(roster?.workerCompletedAt);
    if (proof?.generation !== index + 1 || !Number.isSafeInteger(proof.checkId) || proof.checkId <= 0
      || proof.externalId !== `${request.runId}:a${index + 1}`
      || proof.conclusion !== 'failure'
      || proof.title !== (request.gracefulComposedContinuation === true
        ? 'Review Yeti: INCOMPLETE (partial evidence published)' : 'Review Yeti: BLOCK')
      || (request.gracefulComposedContinuation === true && roster?.gracefulComposedPartial !== true)
      || typeof roster?.workerSummary !== 'string'
      || !Number.isFinite(start) || !Number.isFinite(end) || start > end || previousCompleted >= start) refuse();
    const gate = selectIncompleteRecoveryGate(request, roster);
    if (gate?.conclusion !== 'failure'
      || record(gate.output)?.title !== 'Review Yeti Gate: Failed (incomplete panel)') refuse();
    previousCompleted = end;
  }
  return evidence;
}

export function evaluateIncompleteP2RecoveryLedgerCandidate(
  request: ReviewGenerationRecoveryRequest,
  rows: unknown[],
  gateChecks: unknown[] = [],
): ReviewGenerationRecoveryEvidence[] {
  if (request.incompleteP2Recovery !== true && request.gracefulComposedContinuation !== true) refuse();
  return evaluateRecoveryLedger(request, rows, gateChecks, true);
}

export function evaluateReviewGenerationRecoveryLedger(
  request: ReviewGenerationRecoveryRequest,
  rows: unknown[],
  gateChecks: unknown[] = [],
): ReviewGenerationRecoveryEvidence[] {
  return evaluateRecoveryLedger(request, rows, gateChecks, false);
}

function evaluateRecoveryLedger(
  request: ReviewGenerationRecoveryRequest,
  rows: unknown[],
  gateChecks: unknown[],
  archiveCandidate: boolean,
): ReviewGenerationRecoveryEvidence[] {
  validateReviewGenerationRecoveryRequest(request);
  if (!Array.isArray(rows)) refuse();

  const evidence: ReviewGenerationRecoveryEvidence[] = [];
  const seenIds = new Set<number>();
  const orderedRows = [...rows].sort((left, right) => {
    const generation = (value: unknown) => Number(/:a([1-9][0-9]*)$/u.exec(String(record(value)?.external_id))?.[1] ?? 0);
    return generation(left) - generation(right);
  });
  if (request.incompleteP2Recovery === true || request.gracefulComposedContinuation === true) {
    const workers = orderedRows.map(record).filter((row) => row?.external_id !== `merge-group:${request.headSha}`);
    let previousCompleted = -Infinity;
    for (const worker of workers) {
      const start = completedAt(worker?.started_at);
      const end = completedAt(worker?.completed_at);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || previousCompleted >= start) refuse();
      previousCompleted = end;
    }
  }
  for (const value of orderedRows) {
    const row = record(value);
    const app = record(row?.app);
    const output = record(row?.output);
    const checkId = row?.id;
    if (!Number.isSafeInteger(checkId) || (checkId as number) <= 0 || seenIds.has(checkId as number)
      || row?.name !== REVIEW_WORKER_CHECK_NAME || row?.head_sha !== request.headSha
      || app?.id !== request.expectedAppId || app?.slug !== REVIEW_WORKER_APP_SLUG
      || typeof row?.external_id !== 'string') refuse();
    seenIds.add(checkId as number);

    if (row.external_id === `merge-group:${request.headSha}`) continue;
    const match = /^(run_[a-f0-9]{32}):a([1-9][0-9]*)$/u.exec(row.external_id);
    if (!match || match[1] !== request.runId) refuse();
    const generation = Number(match[2]);
    if (!Number.isSafeInteger(generation) || generation >= request.expectedGeneration
      || row.status !== 'completed'
      || !RECOVERABLE_WORKER_CONCLUSIONS.has(String(row.conclusion))
      || typeof output?.title !== 'string') refuse();
    const entry: ReviewGenerationRecoveryEvidence = {
      generation,
      checkId: checkId as number,
      externalId: row.external_id,
      conclusion: row.conclusion as 'failure' | 'action_required',
      title: output.title,
    };
    if (output.title === 'Review Yeti: BLOCK') {
      if (typeof output.summary !== 'string' || typeof row.completed_at !== 'string') refuse();
      entry.legacyIncompleteRoster = {
        workerSummary: output.summary, workerCompletedAt: row.completed_at, gateChecks,
      };
      if (request.incompleteP2Recovery === true && generation < request.expectedGeneration - 1) {
        const next = orderedRows.map(record).find((candidate) => candidate?.external_id === `${request.runId}:a${generation + 1}`);
        if (!next || !Number.isFinite(completedAt(next.started_at))) refuse();
        entry.legacyIncompleteRoster.nextWorkerStartedAt = String(next.started_at);
      }
      if (request.incompleteP2Recovery === true) {
        if (!Number.isFinite(completedAt(row.started_at))) refuse();
        entry.legacyIncompleteRoster.workerStartedAt = String(row.started_at);
      }
    }
    if (output.title === 'Review Yeti: INCOMPLETE (partial evidence published)'
      && request.gracefulComposedContinuation === true) {
      if (typeof output.summary !== 'string' || typeof row.completed_at !== 'string'
        || !Number.isFinite(completedAt(row.started_at))) refuse();
      entry.legacyIncompleteRoster = {
        workerSummary: output.summary,
        workerCompletedAt: row.completed_at,
        workerStartedAt: String(row.started_at),
        gracefulComposedPartial: true,
        gateChecks,
      };
    }
    evidence.push(entry);
  }

  evidence.sort((left, right) => left.generation - right.generation);
  return archiveCandidate
    ? validateIncompleteP2RecoveryLedgerCandidate(request, evidence)
    : validateReviewGenerationRecoveryEvidence(request, evidence);
}
