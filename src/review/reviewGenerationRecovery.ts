import { isRecoverableFailureTitle, REVIEW_GATE_CHECK_NAME } from './reviewCheckIdentity';
import { formatIncompleteRosterGateSummary, parseIncompleteRosterSummary } from './incompleteRosterSummary';

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
    /** The actual App-owned worker start time, retained so later retries can
     * derive adjacent worker windows without rewriting earlier receipts. */
    workerStartedAt?: string;
    /** The next actual worker bounds older Gate history; absent for the latest worker. */
    nextWorkerStartedAt?: string;
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
  if (request.incompleteP2Recovery === true && newest) {
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
    || request.expectedGeneration > MAX_RECOVERABLE_REVIEW_GENERATION) refuse();
}

export function validateReviewGenerationRecoveryEvidence(
  request: ReviewGenerationRecoveryRequest,
  evidence: ReviewGenerationRecoveryEvidence[],
): ReviewGenerationRecoveryEvidence[] {
  validateReviewGenerationRecoveryRequest(request);
  if (!Array.isArray(evidence) || evidence.length !== request.expectedGeneration - 1) refuse();
  for (let index = 0; index < evidence.length; index += 1) {
    const entry = evidence[index];
    const generation = index + 1;
    const recoverableFailure = isRecoverableFailureTitle(entry?.title)
      || (entry?.title === 'Review Yeti: BLOCK'
        && (request.incompleteP2Recovery !== true || generation === request.expectedGeneration - 1
          || entry.legacyIncompleteRoster?.nextWorkerStartedAt !== undefined)
        && hasLegacyIncompleteRosterProof(request, entry.legacyIncompleteRoster));
    const p2WorkerIntervalValid = request.incompleteP2Recovery !== true
      || entry?.title !== 'Review Yeti: BLOCK'
      || generation < request.expectedGeneration - 1
      || (Number.isFinite(completedAt(entry.legacyIncompleteRoster?.workerStartedAt))
        && completedAt(entry.legacyIncompleteRoster?.workerStartedAt)
          <= completedAt(entry.legacyIncompleteRoster?.workerCompletedAt));
    if (entry?.generation !== generation
      || !Number.isSafeInteger(entry.checkId) || entry.checkId <= 0
      || entry.externalId !== `${request.runId}:a${generation}`
      || !RECOVERABLE_WORKER_CONCLUSIONS.has(entry.conclusion)
      || !recoverableFailure || !p2WorkerIntervalValid) refuse();
  }
  return evidence;
}

export function evaluateReviewGenerationRecoveryLedger(
  request: ReviewGenerationRecoveryRequest,
  rows: unknown[],
  gateChecks: unknown[] = [],
): ReviewGenerationRecoveryEvidence[] {
  validateReviewGenerationRecoveryRequest(request);
  if (!Array.isArray(rows)) refuse();

  const evidence: ReviewGenerationRecoveryEvidence[] = [];
  const seenIds = new Set<number>();
  const orderedRows = [...rows].sort((left, right) => {
    const generation = (value: unknown) => Number(/:a([1-9][0-9]*)$/u.exec(String(record(value)?.external_id))?.[1] ?? 0);
    return generation(left) - generation(right);
  });
  if (request.incompleteP2Recovery === true) {
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
    evidence.push(entry);
  }

  evidence.sort((left, right) => left.generation - right.generation);
  return validateReviewGenerationRecoveryEvidence(request, evidence);
}
