import { isRecoverableFailureTitle } from './reviewCheckIdentity';

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
      || !isRecoverableFailureTitle(entry.title)) refuse();
  }
  return evidence;
}

export function evaluateReviewGenerationRecoveryLedger(
  request: ReviewGenerationRecoveryRequest,
  rows: unknown[],
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
      || typeof output?.title !== 'string'
      || !isRecoverableFailureTitle(output.title)) refuse();
    evidence.push({
      generation,
      checkId: checkId as number,
      externalId: row.external_id,
      conclusion: row.conclusion as 'failure' | 'action_required',
      title: output.title,
    });
  }

  evidence.sort((left, right) => left.generation - right.generation);
  return validateReviewGenerationRecoveryEvidence(request, evidence);
}
