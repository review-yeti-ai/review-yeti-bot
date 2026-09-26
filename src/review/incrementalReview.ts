/**
 * Incremental re-review on synchronize (REL-1084; plan
 * `docs/superpowers/specs/2026-09-23-review-content-shrinking-and-jev-triage.md`,
 * section 4 W7). Behind `REVIEW_YETI_INCREMENTAL`, default off.
 *
 * W1 measured about 9M of 88.7M weekly review tokens (upper bound 26M) spent
 * re-reviewing files that had not changed since the previous reviewed head.
 * When a pull request gets a new head and its latest completed review is a
 * SHIP-complete review of an ANCESTOR head with the same policy and config,
 * the lanes see only what changed since that head, plus every unchanged file
 * that still carries a finding from it. Every other unchanged file is carried
 * forward: it stays listed to its lanes with a one-line note, and the previous
 * review's verdict on it counts toward this head's SHIP gate.
 *
 * Safety (plan section 3):
 *
 * - One decision. `decideIncrementalReview` is the only function that decides
 *   what may be carried forward. The worker calls it to plan the review; the
 *   trusted completion side calls it again, from the service's own copy of the
 *   prior review record and its own GitHub reads, and refuses a completion that
 *   carried forward anything the decision does not permit
 *   (`verifyIncrementalClaim`).
 * - Applicability first. The engines apply the scope through
 *   `resolveScopedReviewApplicability`, strictly after the shared
 *   `resolveReviewApplicability` decision, and replace only patch text. The
 *   lanes, exemptions and unmatched-path failures stay exactly those the
 *   service derives, so the flag can never make the two sides disagree about
 *   which lanes a diff requires (REL-1056).
 * - Deterministic only. Carry-forward rests on git ancestry and exact SHAs,
 *   never on a model's judgement.
 * - Full-review fallbacks: no prior review, a retry attempt, the previous head
 *   is not an ancestor (force-push or rebase), the merge base moved in a way
 *   that touches a reviewed file, policy or config digests changed, the prior
 *   review is older than the configured age, the prior review is not
 *   SHIP-complete, a comparison is incomplete, nothing left to carry, and any
 *   error. Each is the review that runs today.
 * - Open findings. Any file with a finding from the prior review, of any
 *   severity and from any lane, is always re-reviewed in full.
 * - Disclosure. The check summary lists every carried-forward file and every
 *   file re-reviewed because of an open finding (`renderIncrementalSummary`).
 */
import { z } from 'zod';
import type {
  IncrementalPriorIdentity,
  IncrementalReviewDisclosure,
  IncrementalReviewScope,
} from '../types/incrementalReview';
import { INCREMENTAL_REVIEW_CLAIM_VERSION, type IncrementalReviewClaim } from './incrementalReviewClaim';
import { isRegularFileMode } from './lockfileChangeVerification';
import {
  isSubmoduleEntry,
  type EffectiveReviewFile,
  type ReviewApplicability,
  type ReviewApplicabilityInputFile,
} from './personaApplicability';
import {
  resolveShrunkReviewApplicability,
  type DiffShrinkDisclosure,
} from './diffShrink';
import { canonicalJson } from './reviewCore';
import { MAX_PATH_CHARACTERS } from './reviewEvidenceLimits';
import {
  parseWorkerReviewCompletion,
  parseWorkerReviewEvidence,
  workerReviewCompletionDigest,
  STORED_PRIOR_REFUSALS,
  storedCompletionShipCompleteReason,
  storedEvidenceShipCompleteReason,
  workerReviewEvidenceDigest,
  type StoredPriorRefusal,
  type StoredGateRecord,
  type WorkerReviewResult,
} from './workerReviewCompletion';

export type {
  IncrementalPriorIdentity,
  IncrementalReviewDisclosure,
  IncrementalReviewScope,
} from '../types/incrementalReview';
import { repositoryFlagEnabledFor } from './repositoryFlag';

export const INCREMENTAL_FLAG = 'REVIEW_YETI_INCREMENTAL';
/** Service-side: the oldest prior review a carry-forward may rest on. */
export const INCREMENTAL_MAX_AGE_ENV = 'REVIEW_YETI_INCREMENTAL_MAX_AGE_HOURS';
export const DEFAULT_INCREMENTAL_MAX_AGE_MS = 72 * 60 * 60 * 1000;
const MAX_INCREMENTAL_MAX_AGE_HOURS = 30 * 24;
/** GitHub's compare API lists at most 300 files; a list that long may be cut. */
export const MAX_COMPARISON_LISTED_FILES = 300;

const NOTE_PREFIX = '\\ Review Yeti:';

/**
 * `REVIEW_YETI_INCREMENTAL`: unset, empty, `0`, `false` or `off` is off (the
 * default); `1`, `true`, `on` or `all` is on for every repository; anything
 * else is a comma- or space-separated list of `owner/repo` names it is on for
 * (case-insensitive). Same grammar as `REVIEW_YETI_DIFF_SHRINK`.
 */
export function incrementalReviewEnabledFor(env: Readonly<Record<string, string | undefined>>, repository: string): boolean {
  return repositoryFlagEnabledFor(env, INCREMENTAL_FLAG, repository);
}

/** Whole hours, 1 to 720. Unset or invalid is the 72-hour default. */
export function incrementalMaxAgeMsFrom(env: Readonly<Record<string, string | undefined>>): number {
  const raw = String(env[INCREMENTAL_MAX_AGE_ENV] ?? '').trim();
  if (!/^\d{1,4}$/u.test(raw)) return DEFAULT_INCREMENTAL_MAX_AGE_MS;
  const hours = Number(raw);
  if (!Number.isSafeInteger(hours) || hours < 1 || hours > MAX_INCREMENTAL_MAX_AGE_HOURS) return DEFAULT_INCREMENTAL_MAX_AGE_MS;
  return hours * 60 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// Prior review record
// ---------------------------------------------------------------------------

const sha = z.string().regex(/^[a-f0-9]{40}$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const path = z.string().min(1).max(MAX_PATH_CHARACTERS);

/**
 * The service's summary of the latest completed review of a pull request,
 * derived only by `priorReviewRecordFromRows` from its own stored records. The
 * worker receives it as a planning hint; the trusted completion side derives it
 * again and never trusts the worker's copy.
 */
export const priorReviewRecordSchema = z.object({
  runId: z.string().regex(/^run_[a-f0-9]{32}$/u),
  executionAttempt: z.number().int().positive().safe(),
  repositoryId: z.number().int().positive().safe(),
  prNumber: z.number().int().positive().safe(),
  headSha: sha,
  baseSha: sha,
  policyDigest: digest,
  configDigest: digest,
  completionDigest: digest,
  /** Service clock: current run admission minus the prior record's storage time. */
  ageMs: z.number().int().nonnegative().safe(),
  shipComplete: z.boolean(),
  /** REL-1084: when not SHIP-complete, the check that refused it (disclosure and logs only). */
  shipIncompleteReason: z.enum(STORED_PRIOR_REFUSALS).optional(),
  /** Every path any lane of the prior review reported a finding on. */
  findingPaths: z.array(path).max(10_000),
}).strict();

export type PriorReviewRecord = z.infer<typeof priorReviewRecordSchema>;

/** Rows read by `selectPriorReviewRecord` (persistence). */
export interface PriorReviewRows {
  run: { run_id: unknown; repository_id: unknown; pr_number: unknown; head_sha: unknown; base_sha: unknown; status: unknown;
    /** The prior run's authoritative gate App; null for a non-authoritative run. */
    authoritative_gate_app_id?: unknown };
  completion: { execution_attempt: unknown; content_digest: unknown; payload: unknown; created_at: unknown };
  /**
   * The gate attempt that recorded this exact completion (its `worker_result_digest` is the
   * completion's content digest): the gate's stored evidence and decision. Absent for a
   * non-authoritative WorkerReviewEvidence record, which has no gate.
   */
  gate?: StoredGateRecord | null;
  /** The current run's admission time; ages are measured from it, so a slow worker cannot age a record out. */
  currentReceivedAt: unknown;
  /**
   * REL-1084: the CURRENT run's `review_runs.authoritative_gate_app_id`, raw. Interpreted only by
   * `isNonAuthoritativeRun`: only a non-authoritative current run may rest on a non-authoritative
   * WorkerReviewEvidence prior; an authoritative-gate run keeps requiring the gate's own record.
   */
  currentAuthoritativeGateAppId?: unknown;
}

/**
 * REL-1084: the one reading of `review_runs.authoritative_gate_app_id`. A run is
 * non-authoritative only when the column is present and null; anything else, including an
 * unknown value, is treated as gate-decided, which only ever refuses a non-authoritative prior.
 */
export function isNonAuthoritativeRun(authoritativeGateAppId: unknown): boolean {
  return authoritativeGateAppId === null;
}

function timeOf(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' || typeof value === 'number') return new Date(value).getTime();
  return Number.NaN;
}

/**
 * Derive the prior record from the service's stored run and completion rows.
 * Returns null for anything malformed or inconsistent: a record that cannot be
 * verified is never carried forward.
 */
export function priorReviewRecordFromRows(rows: PriorReviewRows): PriorReviewRecord | null {
  try {
    const raw = typeof rows.completion.payload === 'string' ? JSON.parse(rows.completion.payload) : rows.completion.payload;
    const version = (raw as { version?: unknown } | null)?.version;
    let result: WorkerReviewResult;
    let authoritative = false;
    let conclusion: 'success' | 'failure' = 'failure';
    let coordinates: { runId: string; repositoryId: number; prNumber: number; headSha: string; baseSha: string;
      policyDigest: string; configDigest: string; executionAttempt: number };
    let recomputed: string;
    if (version === 'WorkerReviewCompletion.v1') {
      const completion = parseWorkerReviewCompletion(raw);
      result = completion.result;
      coordinates = completion;
      recomputed = workerReviewCompletionDigest(completion);
      authoritative = true;
    } else if (version === 'WorkerReviewEvidence.v1') {
      const evidence = parseWorkerReviewEvidence(raw);
      result = evidence.result;
      conclusion = evidence.conclusion;
      coordinates = evidence;
      recomputed = workerReviewEvidenceDigest(evidence);
    } else {
      return null;
    }
    const storedDigest = String(rows.completion.content_digest ?? '');
    const executionAttempt = Number(rows.completion.execution_attempt);
    if (recomputed !== storedDigest
      || coordinates.runId !== rows.run.run_id
      || coordinates.repositoryId !== Number(rows.run.repository_id)
      || coordinates.prNumber !== Number(rows.run.pr_number)
      || coordinates.headSha !== rows.run.head_sha
      || coordinates.baseSha !== rows.run.base_sha
      || coordinates.executionAttempt !== executionAttempt) return null;
    const recordedAt = timeOf(rows.completion.created_at);
    const receivedAt = timeOf(rows.currentReceivedAt);
    if (!Number.isFinite(recordedAt) || !Number.isFinite(receivedAt)) return null;
    // An authoritative completion qualifies only through the gate's own record of it. A
    // non-authoritative WorkerReviewEvidence record (the worker published its own check) qualifies
    // only for a non-authoritative current run, from its own stored conclusion, roster and lanes.
    const shipIncompleteReason: StoredPriorRefusal | null = rows.run.status !== 'succeeded' ? 'run-not-succeeded'
      : authoritative ? storedCompletionShipCompleteReason(result, rows.gate, storedDigest)
      : !isNonAuthoritativeRun(rows.currentAuthoritativeGateAppId) ? 'no-gate-evidence-record'
      : !isNonAuthoritativeRun(rows.run.authoritative_gate_app_id) ? 'evidence-prior-run-authoritative'
      : storedEvidenceShipCompleteReason(result, conclusion);
    const findingPaths = [...new Set(result.personas.flatMap((persona) => persona.findings.map((finding) => finding.path)))].sort();
    return priorReviewRecordSchema.parse({
      runId: coordinates.runId,
      executionAttempt,
      repositoryId: coordinates.repositoryId,
      prNumber: coordinates.prNumber,
      headSha: coordinates.headSha,
      baseSha: coordinates.baseSha,
      policyDigest: coordinates.policyDigest,
      configDigest: coordinates.configDigest,
      completionDigest: storedDigest,
      ageMs: Math.max(0, Math.floor(receivedAt - recordedAt)),
      ...(shipIncompleteReason === null ? { shipComplete: true } : { shipComplete: false, shipIncompleteReason }),
      findingPaths,
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// GitHub comparison evidence
// ---------------------------------------------------------------------------

export interface CommitComparison {
  status: 'ahead' | 'behind' | 'diverged' | 'identical';
  mergeBaseSha: string;
  files: Array<{ path: string; previousPath?: string }>;
}

/** `GET /repos/{owner}/{repo}/compare/{base}...{head}`, bound to exact SHAs. */
export interface CommitComparisonReader {
  compare(baseSha: string, headSha: string, signal?: AbortSignal): Promise<CommitComparison>;
}

export interface IncrementalEvidence {
  /** previous head ... current head. */
  heads: CommitComparison;
  /** previous base ... previous head: the prior review's file list and merge base. */
  priorDiff?: CommitComparison;
  /** current base ... current head: this review's merge base. */
  currentDiff?: CommitComparison;
  /** previous merge base ... current merge base, only when the merge base moved. */
  baseMove?: CommitComparison;
}

function listedComplete(comparison: CommitComparison | undefined): comparison is CommitComparison {
  return Boolean(comparison) && comparison!.files.length < MAX_COMPARISON_LISTED_FILES;
}

/**
 * The reads `decideIncrementalReview` needs, in a fixed order, stopping as soon
 * as the answer is a full review. Both sides call this same function, so they
 * read the same immutable comparisons. Read failures propagate.
 */
export async function gatherIncrementalEvidence(
  reader: CommitComparisonReader,
  prior: { headSha: string; baseSha: string },
  current: { headSha: string; baseSha: string },
  signal?: AbortSignal,
): Promise<IncrementalEvidence> {
  const heads = await reader.compare(prior.headSha, current.headSha, signal);
  if (heads.status !== 'ahead' || !listedComplete(heads)) return { heads };
  const priorDiff = await reader.compare(prior.baseSha, prior.headSha, signal);
  const currentDiff = await reader.compare(current.baseSha, current.headSha, signal);
  if (!listedComplete(priorDiff) || priorDiff.mergeBaseSha === currentDiff.mergeBaseSha) {
    return { heads, priorDiff, currentDiff };
  }
  const baseMove = await reader.compare(priorDiff.mergeBaseSha, currentDiff.mergeBaseSha, signal);
  return { heads, priorDiff, currentDiff, baseMove };
}

// ---------------------------------------------------------------------------
// The one decision
// ---------------------------------------------------------------------------

export type IncrementalFallbackReason =
  | 'no-prior-review'
  | 'retry-attempt'
  | 'same-head'
  | 'prior-identity-mismatch'
  | 'prior-not-ship-complete'
  | 'policy-or-config-changed'
  | 'prior-too-old'
  | 'not-ancestor'
  | 'comparison-incomplete'
  | 'base-rewritten'
  | 'base-moved-reviewed-files'
  | 'nothing-carried-forward'
  | 'no-new-reviewable-change'
  | 'error';

export type IncrementalDecision =
  | { mode: 'full'; reason: IncrementalFallbackReason; priorRefusal?: StoredPriorRefusal }
  | {
    mode: 'incremental';
    previous: IncrementalPriorIdentity;
    reviewPaths: string[];
    carriedForwardPaths: string[];
    openFindingPaths: string[];
  };

export interface IncrementalCurrentIdentity {
  runId: string;
  repositoryId: number;
  prNumber: number;
  headSha: string;
  baseSha: string;
  policyDigest: string;
  configDigest: string;
  executionAttempt: number;
}

function full(reason: IncrementalFallbackReason): IncrementalDecision {
  return { mode: 'full', reason };
}

/** The checks that need no GitHub read. Null means "gather evidence next". */
export function incrementalPrecheck(input: {
  prior: PriorReviewRecord | null;
  maxAgeMs: number;
  current: IncrementalCurrentIdentity;
}): IncrementalDecision | null {
  const { prior, current } = input;
  if (!prior) return full('no-prior-review');
  // A retry re-reads the whole diff: the recovery path for any incremental problem.
  if (current.executionAttempt !== 1) return full('retry-attempt');
  if (prior.runId === current.runId || prior.repositoryId !== current.repositoryId || prior.prNumber !== current.prNumber) {
    return full('prior-identity-mismatch');
  }
  if (prior.headSha === current.headSha) return full('same-head');
  if (!prior.shipComplete) {
    return { mode: 'full', reason: 'prior-not-ship-complete',
      ...(prior.shipIncompleteReason ? { priorRefusal: prior.shipIncompleteReason } : {}) };
  }
  if (prior.policyDigest !== current.policyDigest || prior.configDigest !== current.configDigest) {
    return full('policy-or-config-changed');
  }
  if (!Number.isSafeInteger(input.maxAgeMs) || input.maxAgeMs <= 0 || prior.ageMs > input.maxAgeMs) return full('prior-too-old');
  return null;
}

/**
 * THE decision. Pure and deterministic over exact SHAs: the worker and the
 * trusted completion side reach the same answer from the same inputs.
 *
 * A current path is carried forward only when ALL hold:
 * - it was in the prior review's diff;
 * - it is not touched (as old or new path) between the previous and current head;
 * - it carries no finding from the prior review;
 * and the merge base either did not move, or moved without touching any
 * current or previously reviewed path.
 */
export function decideIncrementalReview(input: {
  prior: PriorReviewRecord | null;
  maxAgeMs: number;
  current: IncrementalCurrentIdentity;
  currentPaths: readonly string[];
  evidence: IncrementalEvidence | null;
}): IncrementalDecision {
  const early = incrementalPrecheck(input);
  if (early) return early;
  const prior = input.prior!;
  const evidence = input.evidence;
  if (!evidence) return full('error');
  if (evidence.heads.status !== 'ahead') return full('not-ancestor');
  if (!listedComplete(evidence.heads) || !listedComplete(evidence.priorDiff) || !evidence.currentDiff) {
    return full('comparison-incomplete');
  }
  const currentPaths = [...new Set(input.currentPaths)];
  const priorPaths = new Set(evidence.priorDiff.files.map((file) => file.path));
  if (evidence.priorDiff.mergeBaseSha !== evidence.currentDiff.mergeBaseSha) {
    const baseMove = evidence.baseMove;
    if (!baseMove) return full('comparison-incomplete');
    if (baseMove.status !== 'ahead') return full('base-rewritten');
    if (!listedComplete(baseMove)) return full('comparison-incomplete');
    const reviewed = new Set([...currentPaths, ...priorPaths]);
    const touched = baseMove.files.flatMap((file) => [file.path, ...(file.previousPath ? [file.previousPath] : [])]);
    if (touched.some((file) => reviewed.has(file))) return full('base-moved-reviewed-files');
  }
  const changedSincePrevious = new Set(evidence.heads.files.flatMap((file) => [file.path, ...(file.previousPath ? [file.previousPath] : [])]));
  const open = new Set(prior.findingPaths);
  const reviewPaths: string[] = [];
  const carriedForwardPaths: string[] = [];
  const openFindingPaths: string[] = [];
  for (const file of currentPaths) {
    if (!priorPaths.has(file) || changedSincePrevious.has(file)) {
      reviewPaths.push(file);
    } else if (open.has(file)) {
      reviewPaths.push(file);
      openFindingPaths.push(file);
    } else {
      carriedForwardPaths.push(file);
    }
  }
  if (carriedForwardPaths.length === 0) return full('nothing-carried-forward');
  if (reviewPaths.length === openFindingPaths.length) return full('no-new-reviewable-change');
  return {
    mode: 'incremental',
    previous: {
      runId: prior.runId,
      executionAttempt: prior.executionAttempt,
      headSha: prior.headSha,
      baseSha: prior.baseSha,
      completionDigest: prior.completionDigest,
    },
    reviewPaths: reviewPaths.sort(),
    carriedForwardPaths: carriedForwardPaths.sort(),
    openFindingPaths: openFindingPaths.sort(),
  };
}

// ---------------------------------------------------------------------------
// Engine side: apply the scope after the shared applicability decision
// ---------------------------------------------------------------------------

function estimateTokens(files: readonly EffectiveReviewFile[]): number {
  return Math.ceil(files.reduce((chars, file) => chars + (file.patch?.length ?? 0) + (file.content?.length ?? 0), 0) / 4);
}

function carryForwardPatch(patch: string | undefined, previousHeadSha: string): string {
  const header: string[] = [];
  for (const line of String(patch ?? '').split('\n')) {
    if (line.startsWith('@@ ')) break;
    header.push(line);
  }
  const head = header.length > 0 && header[header.length - 1] === '' ? header.slice(0, -1) : header;
  return `${[...head, `${NOTE_PREFIX} unchanged since the previously reviewed head ${previousHeadSha}; `
    + 'its SHIP verdict is carried forward and the content is not sent'].join('\n')}\n`;
}

/**
 * Replace the patch of every carried-forward file with a one-line note. Files
 * stay in place, so every lane still lists them. Gitlinks, symlinks and mode
 * changes are always sent in full. Returns what was actually applied.
 */
export function applyIncrementalScope(
  files: readonly EffectiveReviewFile[],
  scope: IncrementalReviewScope | undefined,
): { files: EffectiveReviewFile[]; disclosure: IncrementalReviewDisclosure | null } {
  if (!scope || scope.carriedForwardPaths.length === 0) return { files: [...files], disclosure: null };
  const carry = new Set(scope.carriedForwardPaths);
  const open = new Set(scope.openFindingPaths);
  const carried: string[] = [];
  const reviewed: string[] = [];
  const out = files.map((file) => {
    if (carry.has(file.path) && !open.has(file.path) && !isSubmoduleEntry(file) && isRegularFileMode(file.mode)
      && typeof file.patch === 'string' && file.content === undefined) {
      carried.push(file.path);
      return { ...file, patch: carryForwardPatch(file.patch, scope.previous.headSha) };
    }
    reviewed.push(file.path);
    return file;
  });
  if (carried.length === 0) return { files: out, disclosure: null };
  const presentOpen = files.map((file) => file.path).filter((file) => open.has(file));
  return {
    files: out,
    disclosure: {
      previous: { ...scope.previous },
      carriedForwardPaths: carried.sort(),
      reReviewedOpenFindingPaths: presentOpen.sort(),
      reviewedPaths: reviewed.sort(),
      estimatedTokensBefore: estimateTokens(files),
      estimatedTokensAfter: estimateTokens(out),
    },
  };
}

/**
 * The shared applicability decision, then diff shrinking, then the incremental
 * scope, for every engine. Applicability is decided on the unshrunk, unscoped
 * files by the same `resolveReviewApplicability` the trusted completion side
 * calls; both later steps replace only patch text.
 */
export function resolveScopedReviewApplicability<P extends Parameters<typeof resolveShrunkReviewApplicability>[0][number]>(
  enabledPersonas: readonly P[],
  changedFiles: ReadonlyArray<ReviewApplicabilityInputFile>,
  options: NonNullable<Parameters<typeof resolveShrunkReviewApplicability>[2]> & { incremental?: IncrementalReviewScope } = {},
): ReviewApplicability<P> & { diffShrink: DiffShrinkDisclosure | null; incremental: IncrementalReviewDisclosure | null } {
  const { incremental, ...shrinkOptions } = options;
  const decision = resolveShrunkReviewApplicability(enabledPersonas, changedFiles, shrinkOptions);
  if (!incremental || decision.applicable.length === 0) return { ...decision, incremental: null };
  const { files, disclosure } = applyIncrementalScope(decision.effectiveFiles, incremental);
  return { ...decision, effectiveFiles: files, incremental: disclosure };
}

/** Attach the engine's own incremental disclosure to its result. Unchanged when null. */
export function attachIncrementalDisclosure<T extends object>(
  result: T,
  disclosure: IncrementalReviewDisclosure | null,
): T & { incremental?: IncrementalReviewDisclosure } {
  return disclosure ? { ...result, incremental: disclosure } : result;
}

/** The completion claim for what the engine actually carried forward. */
export function incrementalClaimFrom(disclosure: IncrementalReviewDisclosure | null | undefined): IncrementalReviewClaim | undefined {
  if (!disclosure || disclosure.carriedForwardPaths.length === 0) return undefined;
  return {
    version: INCREMENTAL_REVIEW_CLAIM_VERSION,
    previousRunId: disclosure.previous.runId,
    previousExecutionAttempt: disclosure.previous.executionAttempt,
    previousHeadSha: disclosure.previous.headSha,
    previousBaseSha: disclosure.previous.baseSha,
    previousCompletionDigest: disclosure.previous.completionDigest,
    carriedForwardPaths: [...disclosure.carriedForwardPaths],
  };
}

// ---------------------------------------------------------------------------
// Trusted completion side
// ---------------------------------------------------------------------------

export interface IncrementalVerificationInput {
  claim: IncrementalReviewClaim;
  /** The service's own record, from `selectPriorReviewRecord`; never the worker's copy. */
  prior: PriorReviewRecord | null;
  maxAgeMs: number;
  /** The completing run's service-owned identity, beyond what the gate coordinates carry. */
  run: { runId: string; executionAttempt: number; configDigest: string };
}

/**
 * Re-run the one decision from the service's own prior record and GitHub reads,
 * and accept the claim only when it names exactly that record and every path it
 * carried forward is one the decision permits. A claim may carry forward LESS
 * than permitted (re-reviewing more is always safe), never more. Read failures
 * propagate so the caller can treat them as transient.
 */
export async function verifyIncrementalClaim(options: Omit<IncrementalVerificationInput, 'run'> & {
  current: IncrementalCurrentIdentity;
  currentPaths: readonly string[];
  reader: CommitComparisonReader;
  signal?: AbortSignal;
}): Promise<{ verified: boolean; reason: IncrementalFallbackReason | 'claim-mismatch' | 'verified' }> {
  const { claim, prior } = options;
  if (!prior) return { verified: false, reason: 'no-prior-review' };
  const named = { runId: claim.previousRunId, executionAttempt: claim.previousExecutionAttempt,
    headSha: claim.previousHeadSha, baseSha: claim.previousBaseSha, completionDigest: claim.previousCompletionDigest };
  const stored = { runId: prior.runId, executionAttempt: prior.executionAttempt,
    headSha: prior.headSha, baseSha: prior.baseSha, completionDigest: prior.completionDigest };
  if (canonicalJson(named) !== canonicalJson(stored)) return { verified: false, reason: 'claim-mismatch' };
  const early = incrementalPrecheck({ prior, maxAgeMs: options.maxAgeMs, current: options.current });
  if (early && early.mode === 'full') return { verified: false, reason: early.reason };
  const evidence = await gatherIncrementalEvidence(options.reader, prior, options.current, options.signal);
  const decision = decideIncrementalReview({
    prior, maxAgeMs: options.maxAgeMs, current: options.current, currentPaths: options.currentPaths, evidence,
  });
  if (decision.mode !== 'incremental') return { verified: false, reason: decision.reason };
  const permitted = new Set(decision.carriedForwardPaths);
  if (!claim.carriedForwardPaths.every((file) => permitted.has(file))) return { verified: false, reason: 'claim-mismatch' };
  return { verified: true, reason: 'verified' };
}

// ---------------------------------------------------------------------------
// Worker planning
// ---------------------------------------------------------------------------

/** Fetches the service's prior review record for this run. */
export interface IncrementalBaseSource {
  read(signal?: AbortSignal): Promise<{ prior: PriorReviewRecord | null; maxAgeMs: number }>;
}

export interface IncrementalPlan {
  scope: IncrementalReviewScope | null;
  decision: IncrementalDecision;
}

const PLAN_TIMEOUT_MS = 15_000;

/**
 * Plan this run's review. Null when the flag is off for this repository. Never
 * throws: every failure is a full review (fail open to today's behaviour).
 */
export async function planIncrementalReview(options: {
  env: Readonly<Record<string, string | undefined>>;
  repository: string;
  current: IncrementalCurrentIdentity;
  currentPaths: readonly string[];
  base?: IncrementalBaseSource;
  reader?: CommitComparisonReader;
  timeoutMs?: number;
}): Promise<IncrementalPlan | null> {
  if (!incrementalReviewEnabledFor(options.env, options.repository)) return null;
  if (!options.base || !options.reader) return { scope: null, decision: full('error') };
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const plan = async (): Promise<IncrementalPlan> => {
    const { prior, maxAgeMs } = await options.base!.read(abort.signal);
    const early = incrementalPrecheck({ prior, maxAgeMs, current: options.current });
    if (early) return { scope: null, decision: early };
    const evidence = await gatherIncrementalEvidence(options.reader!, prior!, options.current, abort.signal);
    const decision = decideIncrementalReview({ prior, maxAgeMs, current: options.current, currentPaths: options.currentPaths, evidence });
    return decision.mode === 'incremental'
      ? { scope: { previous: decision.previous, carriedForwardPaths: decision.carriedForwardPaths, openFindingPaths: decision.openFindingPaths }, decision }
      : { scope: null, decision };
  };
  try {
    return await Promise.race([plan(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { abort.abort(); reject(new Error('incremental planning timed out')); }, options.timeoutMs ?? PLAN_TIMEOUT_MS);
    })]);
  } catch {
    return { scope: null, decision: full('error') };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    abort.abort();
  }
}

// ---------------------------------------------------------------------------
// Disclosure
// ---------------------------------------------------------------------------

const MAX_LISTED = 15;

function code(value: string): string {
  return `\`${value.replace(/[`\r\n]/gu, ' ')}\``;
}

function listed(items: readonly string[]): string {
  const shown = items.slice(0, MAX_LISTED).map(code).join(', ');
  const more = items.length - MAX_LISTED;
  return more > 0 ? `${shown}, +${more} more` : shown;
}

const FALLBACK_TEXT: Record<IncrementalFallbackReason, string> = {
  'no-prior-review': 'no earlier completed review of this pull request',
  'retry-attempt': 'this is a retry attempt',
  'same-head': 'the previous review was of this same head',
  'prior-identity-mismatch': 'the previous review record did not match this pull request',
  'prior-not-ship-complete': 'the previous review was not a complete SHIP',
  'policy-or-config-changed': 'the review policy or persona configuration changed',
  'prior-too-old': 'the previous review is older than the configured age',
  'not-ancestor': 'the previously reviewed head is not an ancestor of this head (force-push or rebase)',
  'comparison-incomplete': 'a comparison listed too many files to be complete',
  'base-rewritten': 'the merge base was rewritten',
  'base-moved-reviewed-files': 'the merge base moved and changed a reviewed file',
  'nothing-carried-forward': 'every changed file changed again or carries an open finding',
  'no-new-reviewable-change': 'no file changed since the previous review',
  error: 'the previous review could not be read or verified',
};

const PRIOR_REFUSAL_TEXT: Record<StoredPriorRefusal, string> = {
  'run-not-succeeded': 'its run did not succeed',
  'no-gate-evidence-record': 'it was published without the authoritative gate, which this run requires',
  'evidence-prior-run-authoritative': 'its run was bound to the authoritative gate but stored no gate completion',
  'evidence-conclusion-not-success': 'its published check did not succeed',
  'evidence-roster-unknown': 'its record does not list the required lane roster',
  'evidence-roster-mismatch': 'a stored lane is not in its roster or appears twice',
  'evidence-exemption': 'it was a no-reviewable-content exemption',
  'gate-row-missing': 'the gate has no record of that completion',
  'gate-row-mismatch': 'the gate record is for a different completion',
  'gate-record-unreadable': 'the gate record could not be read',
  'gate-not-clean': 'the gate did not pass it as a clean review',
  'gate-exemption': 'it was a no-reviewable-content exemption',
  'gate-lane-missing': 'the gate recorded a required lane as not completed',
  'gate-incomplete': 'the gate recorded incomplete coverage or quorum',
  'gate-infrastructure-failure': 'the gate recorded an infrastructure failure',
  'gate-not-ship': 'the gate verdict was not SHIP',
  'worker-quorum-unmet': 'the worker reported an unmet quorum',
  'worker-coverage-incomplete': 'the worker reported incomplete coverage',
  'blocking-finding': 'it has a P0/P1 finding at published severity',
  'rederived-invalid': 'its lanes could not be re-derived',
  'lane-failed': 'a lane failed',
  'lane-missing': 'a required lane is missing',
  'rederived-not-ship': 'the re-derived verdict is not SHIP',
};

/** ` (reason code: text)` for a refused prior, or nothing. Shared with the verdict-cache summary. */
export function priorRefusalSuffix(refusal: StoredPriorRefusal | undefined): string {
  return refusal ? ` (\`${refusal}\`: ${PRIOR_REFUSAL_TEXT[refusal]})` : '';
}

/** Check-summary lines (plan section 3, invariant 5). Empty when the flag is off. */
export function renderIncrementalSummary(
  disclosure: IncrementalReviewDisclosure | null | undefined,
  plan: IncrementalPlan | null,
): string[] {
  if (disclosure) {
    const lines = [
      `**Incremental re-review** (\`${INCREMENTAL_FLAG}\`): reviewed the changes since the previously reviewed head `
      + `\`${disclosure.previous.headSha}\` (run \`${disclosure.previous.runId}\`, SHIP), `
      + `~${disclosure.estimatedTokensBefore.toLocaleString('en-US')} -> ~${disclosure.estimatedTokensAfter.toLocaleString('en-US')} estimated diff tokens.`,
      `- Carried forward, unchanged since that head, content not sent (${disclosure.carriedForwardPaths.length}): ${listed(disclosure.carriedForwardPaths)}`,
    ];
    if (disclosure.reReviewedOpenFindingPaths.length > 0) {
      lines.push(`- Re-reviewed in full because a finding from that review is still open (${disclosure.reReviewedOpenFindingPaths.length}): `
        + listed(disclosure.reReviewedOpenFindingPaths));
    }
    lines.push(`- Reviewed in full (${disclosure.reviewedPaths.length}): ${listed(disclosure.reviewedPaths)}`);
    return lines;
  }
  if (!plan) return [];
  const reason = plan.decision.mode === 'full'
    ? FALLBACK_TEXT[plan.decision.reason] + priorRefusalSuffix(plan.decision.priorRefusal)
    : 'no file could be carried forward';
  return [`**Incremental re-review** (\`${INCREMENTAL_FLAG}\`): full review, because ${reason}.`];
}
