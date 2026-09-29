import { isRecoverableFailureTitle, REVIEW_GATE_CHECK_NAME } from './reviewCheckIdentity';

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
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(value)
    ? Date.parse(value) : NaN;
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
  const lines = proof.workerSummary.split('\n');
  const findings = lines.filter((line) => line.startsWith('Findings: '));
  const coverage = lines.filter((line) => line.startsWith('Coverage: '));
  if (lines[0] !== `Verdict \`BLOCK\` at \`${request.headSha}\`.`
    || findings.length !== 1
    || findings[0] !== 'Findings: 0 (blocking P0/P1: 0; 0 raw persona finding(s) before clustering).'
    || coverage.length !== 1) return false;
  const panel = /^Coverage: mode=panel; expected lanes=([0-9]+); completed lanes=([0-9]+); failed lanes=0; roster valid=false; quorum satisfied=false; full panel complete=false\.$/u.exec(coverage[0]);
  const composed = /^Coverage: engine=composed; planned tasks=([0-9]+); expected tasks=([0-9]+); completed tasks=([0-9]+); failed tasks=0; roster valid=false; quorum satisfied=false; task coverage complete=false\.$/u.exec(coverage[0]);
  if (!panel && !composed) return false;
  const [expected, completed] = (panel ? panel.slice(1) : composed!.slice(2)).map(Number);
  if (!Number.isSafeInteger(expected) || expected <= 0 || !Number.isSafeInteger(completed)
    || completed < 0 || completed >= expected || (composed && Number(composed[1]) !== expected)) return false;

  let newest: Record<string, unknown> | undefined;
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
      || gate.status !== 'completed' || !Number.isFinite(completedAt(gate.completed_at))) return false;
    seen.add(id as number);
    if (!newest || completedAt(gate.completed_at) > completedAt(newest.completed_at)
      || (completedAt(gate.completed_at) === completedAt(newest.completed_at) && (id as number) > (newest.id as number))) newest = gate;
  }
  const output = record(newest?.output);
  return newest?.conclusion === 'failure'
    && completedAt(newest.completed_at) >= completedAt(proof.workerCompletedAt)
    && output?.title === 'Review Yeti Gate: Failed (incomplete panel)'
    && output.summary === `Review Yeti Gate failed: the panel expected ${expected} review lane(s) but ${completed} completed. This is an incomplete review, not a findings verdict; re-dispatch the review for this head.`;
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
    if (entry?.generation !== generation
      || !Number.isSafeInteger(entry.checkId) || entry.checkId <= 0
      || entry.externalId !== `${request.runId}:a${generation}`
      || !RECOVERABLE_WORKER_CONCLUSIONS.has(entry.conclusion)
      || !(isRecoverableFailureTitle(entry.title)
        || (entry.title === 'Review Yeti: BLOCK' && hasLegacyIncompleteRosterProof(request, entry.legacyIncompleteRoster)))) refuse();
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
  for (const value of rows) {
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
    }
    evidence.push(entry);
  }

  evidence.sort((left, right) => left.generation - right.generation);
  return validateReviewGenerationRecoveryEvidence(request, evidence);
}
