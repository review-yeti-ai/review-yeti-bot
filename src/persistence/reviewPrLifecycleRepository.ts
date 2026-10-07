import { randomUUID } from 'node:crypto';
import { canonicalJson, sha256 } from '../review/reviewCore';
import { newDurableFindingId, durableFindingIdFor, findingDispositionEventSchema, findingDispositionEventType,
  type FindingDispositionDraft } from '../review/findingDisposition';
import { continuityReceiptMatchesCurrent, groundedContinuityCandidateFrom, groundedFindingContinuitySchema,
  groundedContinuityOriginRefs, groundedFixedOriginRefs, groundedOriginAncestryJoin,
  resolveGroundedFindingContinuity, selectNewestEligibleGroundedCompletion, verifiedRepairVerificationLinks,
  type GroundedContinuityCandidate, type GroundedContinuityOriginRef,
  type GroundedFindingContinuity, type GroundedOriginAncestryRequestsByFingerprint, type GroundedOriginAncestryV1 }
  from '../review/findingContinuity';
import type { PrLifecycleHistoryEvent, PrLifecycleHistoryFinding, PrLifecycleHistoryLoad } from '../review/prLifecycleHistoryHttp';
import { constantTimeDigestEqual } from '../utils/constantTimeDigest';
import { GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION, groundedCitationManifestDigest,
  isValidGroundedCitationV2, type GroundedCitationV2 } from '../review/groundedEvidenceV2';
import type { ReviewHeadAncestryReceipt } from '../review/incrementalReview';
import type { ReviewPlanningHistoryContext } from '../review/prReviewPlanningContext';
import type { WorkerReviewResult } from '../review/workerReviewCompletion';
import type { TrustedGroundedHistoryContext as WindowTrustedGroundedHistoryContext,
  TrustedGroundedLifecycleTransitionV1 as WindowTrustedGroundedLifecycleTransitionV1 } from '../review/workerReviewCompletion';
import { findingFingerprint } from '../review/findingConvergence';
import { loadValidatedDisputedFindingRechecks, type AuthenticatedDisputeTuple,
  type AuthenticatedDisputesProjection, type DisputedFindingRecheck } from '../review/disputedFindingRecheck';

type GroundedCompletionOutcomeV2 = Extract<NonNullable<WorkerReviewResult['groundedReview']>,
  { version: 'GroundedReviewReceipt.v2' }>['verification']['outcomes'][number];

interface QueryResult { rows: any[] }
export interface ReviewLifecycleQueryable {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
}

export interface PrLifecycleHistorySnapshotRequest {
  runId: string;
  executionAttempt: number;
  workerTokenDigest: string;
}

export interface PrLifecycleHistorySnapshot {
  snapshotId: string;
  runId: string;
  executionAttempt: number;
  repositoryId: number;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  policyDigest: string;
  configDigest: string;
  contextDigest: string;
  eventCount: number;
  findingCount: number;
  eventOmittedCount: number;
  findingOmittedCount: number;
  legacyOmittedCount: number;
  authenticatedDisputes: AuthenticatedDisputesProjection;
  eventsDigest: string;
  findingsDigest: string;
  expiresAt: string;
}

export type PrLifecycleHistorySnapshotCreateResult =
  | { status: 'unauthorized' }
  | { status: 'unavailable' }
  | { status: 'ok'; snapshot: PrLifecycleHistorySnapshot };

export type PrLifecycleHistoryCollection = 'events' | 'findings';

export type PrLifecycleHistorySnapshotPageResult =
  | { status: 'unauthorized' }
  | { status: 'not_found' }
  | { status: 'ok'; snapshotId: string; collection: PrLifecycleHistoryCollection; offset: number;
    limit: number; totalCount: number; capturedCount: number; rows: any[]; hasMore: boolean; nextOffset: number | null };

const MAX_CAPTURED_HISTORY_IDS = 10_000;
const HISTORY_SNAPSHOT_TTL_MS = 30 * 60 * 1000;

/** History access needs the live admitted reservation as well as a valid bearer.
 * This rejects a run whose current head/config changed, whose reservation ended,
 * or whose run/outbox has been cancelled or superseded since snapshot creation. */
async function historyExecutionAuthorized(client: ReviewLifecycleQueryable,
  input: { runId: string; executionAttempt: number; workerTokenDigest: string }): Promise<boolean> {
  if (!/^run_[a-f0-9]{32}$/u.test(input.runId) || !Number.isSafeInteger(input.executionAttempt)
    || input.executionAttempt < 1 || !validDigest(input.workerTokenDigest)) return false;
  const binding = (await client.query(`SELECT runs.status, runs.cancel_requested_at, runs.cancel_propagated_at,
      outbox.status AS outbox_status, outbox.cancel_requested_at AS outbox_cancel_requested_at,
      outbox.cancel_propagated_at AS outbox_cancel_propagated_at,
      outbox.worker_token_digest, reservation.status AS reservation_status
    FROM review_runs runs
    JOIN review_dispatch_outbox outbox ON outbox.run_id = runs.run_id
    JOIN review_pr_review_reservations reservation
      ON reservation.run_id = runs.run_id AND reservation.execution_attempt = $2
    JOIN review_pr_lifecycles lifecycle ON lifecycle.lifecycle_id = reservation.lifecycle_id
    WHERE runs.run_id = $1 AND outbox.execution_attempt + 1 = $2
      AND runs.status IN ('queued', 'running') AND runs.cancel_requested_at IS NULL
      AND runs.cancel_propagated_at IS NULL AND outbox.status = 'projected'
      AND outbox.cancel_requested_at IS NULL AND outbox.cancel_propagated_at IS NULL
      AND reservation.status = 'reserved'
      AND runs.repository_id = lifecycle.repository_id AND runs.owner = lifecycle.owner
      AND runs.repo = lifecycle.repo AND runs.pr_number = lifecycle.pr_number
      AND runs.head_sha = reservation.head_sha AND runs.base_sha = reservation.base_sha
      AND runs.effective_policy_digest = reservation.policy_digest
      AND runs.effective_config_digest = reservation.config_digest
      AND runs.snapshot_digest = reservation.context_digest`, [input.runId, input.executionAttempt])).rows[0];
  return Boolean(binding) && constantTimeDigestEqual(binding.worker_token_digest, input.workerTokenDigest)
    && binding.cancel_requested_at == null && binding.cancel_propagated_at == null
    && binding.outbox_cancel_requested_at == null && binding.outbox_cancel_propagated_at == null
    && binding.status !== 'superseded' && binding.outbox_status === 'projected'
    && binding.reservation_status === 'reserved';
}

function uuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch { return []; }
  }
  return [];
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return {}; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function sameRootCauseIdentity(left: unknown, right: GroundedContinuityCandidate['rootCause']): boolean {
  const value = jsonObject(left);
  return value.componentId === right.componentId && value.behaviorId === right.behaviorId
    && value.contractId === right.contractId && value.failureModeId === right.failureModeId;
}

type CapturedGroundedFinding = PrLifecycleHistoryFinding & { groundedEvidence: Record<string, unknown> };

function rowsInCapturedOrder(rows: readonly Record<string, unknown>[], ids: readonly string[], key: string): Record<string, unknown>[] {
  const byId = new Map(rows.map((row) => [String(row[key]), row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}

function projectCapturedFindings(rows: readonly Record<string, unknown>[]): CapturedGroundedFinding[] {
  return rows.map((row) => {
    const sourceEvidence = jsonObject(row.source_evidence);
    const groundedEvidence = jsonObject(sourceEvidence.groundedEvidenceV2);
    const cause = jsonObject(groundedEvidence.rootCause);
    const rootCause = ['componentId', 'behaviorId', 'contractId', 'failureModeId'].every((key) =>
      typeof cause[key] === 'string')
      ? { componentId: String(cause.componentId), behaviorId: String(cause.behaviorId),
        contractId: String(cause.contractId), failureModeId: String(cause.failureModeId) } : undefined;
    const anchor = jsonObject(groundedEvidence.causeAnchor);
    const causeAnchor = typeof anchor.componentPath === 'string' && (anchor.side === 'head' || anchor.side === 'base')
      && Number.isSafeInteger(anchor.startLine) && Number.isSafeInteger(anchor.endLine)
      && Array.isArray(anchor.citationIds) && anchor.citationIds.length > 0 && anchor.citationIds.length <= 64
      && anchor.citationIds.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 256)
      && typeof anchor.contentDigest === 'string'
      ? { componentPath: anchor.componentPath, side: anchor.side as 'head' | 'base', startLine: Number(anchor.startLine),
        endLine: Number(anchor.endLine), citationIds: [...anchor.citationIds] as string[], contentDigest: anchor.contentDigest } : undefined;
    return {
      findingEventId: String(row.finding_event_id), durableFindingId: String(row.durable_finding_id),
      fingerprint: String(row.fingerprint), path: String(row.path), firstSeenHead: String(row.first_seen_head),
      lastSeenHead: String(row.last_seen_head), affectedContextDigest: String(row.affected_context_digest),
      sourceSeverity: String(row.source_severity), effectiveSeverity: String(row.effective_severity),
      disposition: String(row.disposition), blocking: row.blocking === true,
      verificationStatus: String(row.verification_status) as 'confirmed' | 'contradicted' | 'insufficient',
      evidenceDigest: String(row.evidence_digest), groundedEvidence,
      ...(rootCause ? { rootCause } : {}), ...(causeAnchor ? { causeAnchor } : {}),
      ...(typeof groundedEvidence.semanticsVersion === 'string'
        ? { groundedEvidenceSemanticsVersion: groundedEvidence.semanticsVersion } : {}),
      ...(typeof groundedEvidence.sourceWindowManifestDigest === 'string'
        ? { sourceWindowManifestDigest: groundedEvidence.sourceWindowManifestDigest } : {}),
    };
  });
}

function projectCapturedEvents(rows: readonly Record<string, unknown>[]): PrLifecycleHistoryEvent[] {
  return rows.map((row) => {
    const payload = jsonObject(row.payload);
    const disposition = findingDispositionEventSchema.safeParse(payload);
    const decisionReceipt = jsonObject(payload.decisionReceipt);
    const evidenceSemanticsVersion = row.event_type === 'review.completion_recorded'
      && typeof decisionReceipt.evidenceSemanticsVersion === 'string'
      && decisionReceipt.evidenceSemanticsVersion.length <= 120 ? decisionReceipt.evidenceSemanticsVersion : undefined;
    const completionStatus: PrLifecycleHistoryLoad['events'][number]['completionStatus'] = row.event_type === 'review.completion_recorded'
      && (payload.status === 'completed' || payload.status === 'failed' || payload.status === 'cancelled')
      ? payload.status : undefined;
    const serviceCoverage = jsonObject(decisionReceipt.serviceCoverage);
    const coverageComplete = row.event_type === 'review.completion_recorded'
      && typeof serviceCoverage.coverageComplete === 'boolean' ? serviceCoverage.coverageComplete : undefined;
    const quorumSatisfied = row.event_type === 'review.completion_recorded'
      && typeof serviceCoverage.quorumSatisfied === 'boolean' ? serviceCoverage.quorumSatisfied : undefined;
    const verificationStatus = row.verification_status === 'confirmed' || row.verification_status === 'contradicted'
      ? row.verification_status : 'insufficient';
    const verificationFindingEventId = typeof payload.findingEventId === 'string' && uuid(payload.findingEventId)
      ? payload.findingEventId : undefined;
    const verificationFingerprint = payload.fingerprint;
    const verificationStatusValue = payload.status === 'confirmed' || payload.status === 'contradicted'
      || payload.status === 'insufficient' ? payload.status : undefined;
    const hasCurrentAffectedContextDigest = Object.prototype.hasOwnProperty.call(payload, 'currentAffectedContextDigest');
    const hasSourceAffectedContextDigest = Object.prototype.hasOwnProperty.call(payload, 'sourceAffectedContextDigest');
    const currentAffectedContextDigest = typeof payload.currentAffectedContextDigest === 'string'
      && validDigest(payload.currentAffectedContextDigest) ? payload.currentAffectedContextDigest : undefined;
    const sourceAffectedContextDigest = typeof payload.sourceAffectedContextDigest === 'string'
      && validDigest(payload.sourceAffectedContextDigest) ? payload.sourceAffectedContextDigest : undefined;
    const verificationDigestsValid = (!hasCurrentAffectedContextDigest || currentAffectedContextDigest !== undefined)
      && (!hasSourceAffectedContextDigest || sourceAffectedContextDigest !== undefined);
    const verification: PrLifecycleHistoryEvent['verification'] = row.event_type === 'finding.independent_verification'
      && verificationFindingEventId !== undefined
      && typeof verificationFingerprint === 'string' && /^fp1_[a-f0-9]{24}$/u.test(verificationFingerprint)
      && verificationStatusValue !== undefined && verificationDigestsValid
      ? { findingEventId: verificationFindingEventId, fingerprint: verificationFingerprint,
        status: verificationStatusValue,
        ...(currentAffectedContextDigest ? { currentAffectedContextDigest } : {}),
        ...(sourceAffectedContextDigest ? { sourceAffectedContextDigest } : {}) } : undefined;
    return { eventId: String(row.event_id), eventType: String(row.event_type),
      ...(typeof row.run_id === 'string' ? { runId: row.run_id } : {}),
      ...(Number.isSafeInteger(Number(row.execution_attempt)) && Number(row.execution_attempt) > 0
        ? { executionAttempt: Number(row.execution_attempt) } : {}),
      ...(typeof row.head_sha === 'string' ? { headSha: row.head_sha } : {}),
      ...(typeof row.base_sha === 'string' ? { baseSha: row.base_sha } : {}),
      ...(typeof row.policy_digest === 'string' ? { policyDigest: row.policy_digest } : {}),
      ...(typeof row.config_digest === 'string' ? { configDigest: row.config_digest } : {}),
      ...(typeof row.context_digest === 'string' ? { contextDigest: row.context_digest } : {}),
      ...(typeof row.evidence_digest === 'string' ? { evidenceDigest: row.evidence_digest } : {}),
      ...(evidenceSemanticsVersion ? { evidenceSemanticsVersion } : {}),
      ...(completionStatus ? { completionStatus } : {}),
      ...(coverageComplete !== undefined ? { coverageComplete } : {}),
      ...(quorumSatisfied !== undefined ? { quorumSatisfied } : {}),
      verificationStatus, ...(verification ? { verification } : {}),
      ...(disposition.success ? { disposition: disposition.data } : {}) };
  });
}

function capturedOriginHistory(input: {
  snapshotId: string; contextDigest: string; findingIds: readonly string[]; eventIds: readonly string[];
  findingRows: readonly Record<string, unknown>[]; eventRows: readonly Record<string, unknown>[];
}): { history: PrLifecycleHistoryLoad; findings: CapturedGroundedFinding[]; events: PrLifecycleHistoryEvent[] } {
  const findingRows = rowsInCapturedOrder(input.findingRows, input.findingIds, 'finding_event_id');
  const eventRows = rowsInCapturedOrder(input.eventRows, input.eventIds, 'event_id');
  const findings = projectCapturedFindings(findingRows);
  const events = projectCapturedEvents(eventRows);
  const findingsDigest = sha256(canonicalJson(input.findingIds));
  const eventsDigest = sha256(canonicalJson(input.eventIds));
  return { history: { status: 'complete', snapshotId: input.snapshotId, contextDigest: input.contextDigest,
    findings: findings.map(({ groundedEvidence: _groundedEvidence, ...row }) => row), events,
    eventCount: input.eventIds.length, findingCount: input.findingIds.length,
    loadedEventCount: input.eventIds.length, loadedFindingCount: input.findingIds.length,
    eventOmittedCount: 0, findingOmittedCount: 0, legacyOmittedCount: 0,
    eventsDigest, findingsDigest, omissions: [] }, findings, events };
}

function planningHistoryForCapturedOrigins(input: {
  history: PrLifecycleHistoryLoad; headSha: string; baseSha: string; policyDigest: string; configDigest: string;
}): ReviewPlanningHistoryContext {
  const completion = selectNewestEligibleGroundedCompletion(input.history.events);
  const semanticsCompatible = completion?.evidenceSemanticsVersion === GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION;
  const sourcePolicyConfigCompatible = Boolean(completion && completion.policyDigest === input.policyDigest
    && completion.configDigest === input.configDigest);
  return { version: 'ReviewPlanningHistoryContext.v1', status: 'complete',
    snapshotId: input.history.snapshotId!, contextDigest: input.history.contextDigest!,
    expectedHeadSha: input.headSha, expectedBaseSha: input.baseSha,
    evidenceSemanticsCompatibility: { expectedVersion: GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION,
      ...(completion?.evidenceSemanticsVersion ? { sourceVersion: completion.evidenceSemanticsVersion } : {}),
      compatibleForContinuity: semanticsCompatible && sourcePolicyConfigCompatible,
      compatibleForCheckpointReuse: false, compatibleForCoverageReuse: false,
      completionCoverageComplete: completion?.coverageComplete === true,
      completionQuorumSatisfied: completion?.quorumSatisfied === true,
      sourcePolicyConfigCompatible,
      ...(completion?.completionStatus ? { completionStatus: completion.completionStatus } : {}),
      reason: semanticsCompatible && sourcePolicyConfigCompatible ? 'matching current completion semantics and policy/config'
        : 'latest completion is ineligible for lifecycle continuity' },
    priorFindings: [...input.history.findings],
    dispositions: input.history.events.flatMap((event) => event.disposition ? [event.disposition] : []),
    authenticatedDisputes: { status: 'complete', count: 0, paths: [] },
    priorThreads: [], omissions: [], canWaiveCurrentBlocker: false };
}

/**
 * Service-side continuity acceptance. The worker receipt must point into the fixed history ID set
 * captured for its authenticated exact run; source rows must have matching v2 cause evidence, and
 * duplicate cause tuples with multiple durable IDs remain ambiguous. Failed or incompatible
 * history only seeds a fresh review and never reuses the old durable identity.
 */
export async function validatePrFindingContinuityReceipt(client: ReviewLifecycleQueryable, input: {
  runId: string;
  executionAttempt: number;
  workerTokenDigest: string;
  repositoryId: number;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  policyDigest: string;
  configDigest: string;
  contextDigest: string;
  currentEvidenceSemanticsVersion: string;
  candidate: GroundedContinuityCandidate;
  currentCandidates?: readonly GroundedContinuityCandidate[];
  receipt: GroundedFindingContinuity;
  verifiedOriginAncestry?: readonly GroundedOriginAncestryV1[];
  priorAncestryVerified: boolean;
}): Promise<boolean> {
  if (input.currentEvidenceSemanticsVersion !== GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION
    || !uuid(input.receipt.historySnapshotId ?? '')
    || !validDigest(input.receipt.historyContextDigest ?? '')
    || !await historyExecutionAuthorized(client, input)) return false;
  const snapshot = (await client.query(`SELECT snapshot.*, lifecycle.repository_id AS bound_repository_id,
      lifecycle.owner AS bound_owner, lifecycle.repo AS bound_repo, lifecycle.pr_number AS bound_pr_number
    FROM review_pr_lifecycle_history_snapshots snapshot
    JOIN review_pr_lifecycles lifecycle ON lifecycle.lifecycle_id = snapshot.lifecycle_id
    WHERE snapshot.snapshot_id = $1 AND snapshot.run_id = $2 AND snapshot.execution_attempt = $3
      AND snapshot.expires_at > CURRENT_TIMESTAMP`,
  [input.receipt.historySnapshotId, input.runId, input.executionAttempt])).rows[0];
  if (!snapshot || Number(snapshot.repository_id) !== input.repositoryId
    || Number(snapshot.bound_repository_id) !== input.repositoryId
    || snapshot.owner !== input.owner || snapshot.bound_owner !== input.owner || snapshot.repo !== input.repo
    || snapshot.bound_repo !== input.repo || Number(snapshot.pr_number) !== input.prNumber
    || Number(snapshot.bound_pr_number) !== input.prNumber || snapshot.head_sha !== input.headSha
    || snapshot.base_sha !== input.baseSha || snapshot.policy_digest !== input.policyDigest
    || snapshot.config_digest !== input.configDigest || snapshot.context_digest !== input.contextDigest
    || input.receipt.historyContextDigest !== snapshot.context_digest
    || Number(snapshot.event_omitted_count) !== 0 || Number(snapshot.finding_omitted_count) !== 0
    || Number(snapshot.legacy_omitted_count) !== 0) return false;

  const capturedFindingIds = stringArray(snapshot.finding_ids);
  const capturedEventIds = stringArray(snapshot.event_ids);
  const sourceIds = input.receipt.sourceEventIds;
  if (new Set(sourceIds).size !== sourceIds.length
    || sourceIds.some((id) => !capturedFindingIds.includes(id) && !capturedEventIds.includes(id))) return false;
  const findingRows = capturedFindingIds.length === 0 ? [] : (await client.query(`SELECT finding_event_id,
      durable_finding_id, fingerprint, path, first_seen_head, last_seen_head, affected_context_digest,
      source_severity, effective_severity, disposition, blocking, verification_status, evidence_digest, source_evidence
    FROM review_semantic_finding_events WHERE lifecycle_id = $1 AND finding_event_id = ANY($2::uuid[])`,
  [snapshot.lifecycle_id, capturedFindingIds])).rows;
  const eventRows = capturedEventIds.length === 0 ? [] : (await client.query(`SELECT event_id, event_type,
      run_id, execution_attempt, head_sha, base_sha, policy_digest, config_digest, context_digest,
      actor_digest, verification_status, evidence_digest, payload, created_at FROM review_pr_lifecycle_events
    WHERE lifecycle_id = $1 AND event_id = ANY($2::uuid[])`, [snapshot.lifecycle_id, capturedEventIds])).rows;
  const projectedHistory = capturedOriginHistory({ snapshotId: String(snapshot.snapshot_id),
    contextDigest: String(snapshot.context_digest), findingIds: capturedFindingIds, eventIds: capturedEventIds,
    findingRows, eventRows });
  const historyFindings = projectedHistory.findings;
  const historyEvents = projectedHistory.events;
  const syntheticHistory = projectedHistory.history;
  if (!groundedFindingContinuitySchema.safeParse(input.receipt).success) return false;
  if (!continuityReceiptMatchesCurrent({ receipt: input.receipt, candidate: input.candidate, history: syntheticHistory })) return false;

  const planningHistory = planningHistoryForCapturedOrigins({ history: syntheticHistory, headSha: input.headSha,
    baseSha: input.baseSha, policyDigest: input.policyDigest, configDigest: input.configDigest });
  const expectedReceipt = resolveGroundedFindingContinuity({ candidate: input.candidate,
    currentCandidates: input.currentCandidates, history: syntheticHistory, planningHistory,
    priorAncestryVerified: input.priorAncestryVerified, verifiedOriginAncestry: input.verifiedOriginAncestry });
  if (canonicalJson(expectedReceipt) !== canonicalJson(input.receipt)) return false;

  const matchingRows = historyFindings.filter((row) => row.groundedEvidence.semanticsVersion === input.currentEvidenceSemanticsVersion
    && sameRootCauseIdentity(row.groundedEvidence.rootCause, input.candidate.rootCause));
  const matchingDurableIds = [...new Set(matchingRows.map((row) => row.durableFindingId)
    .filter((id): id is string => typeof id === 'string' && /^lf1_[a-f0-9]{32}$/u.test(id)))];
  if (input.receipt.status === 'new') return matchingDurableIds.length === 0;
  if (matchingDurableIds.length !== 1 || matchingDurableIds[0] !== input.receipt.durableFindingId) return false;
  const origins = input.receipt.verifiedOriginAncestry ?? [];
  const causeOrigins = origins.filter((origin) => origin.sourceKind === 'cause');
  const repairOrigins = origins.filter((origin) => origin.sourceKind === 'repair');
  if (causeOrigins.length !== 1 || (input.receipt.status === 'continuous' ? repairOrigins.length !== 0
    : repairOrigins.length !== 1) || origins.some((origin) => origin.result !== 'ancestor'
      || origin.currentHeadSha !== input.headSha)) return false;
  const expectedSourceIds = [causeOrigins[0]!.sourceEventId, ...repairOrigins.map((origin) => origin.sourceEventId)].sort();
  if (canonicalJson(expectedSourceIds) !== canonicalJson(input.receipt.sourceEventIds)) return false;
  const referencedFindings = historyFindings.filter((row) => input.receipt.sourceEventIds.includes(row.findingEventId));
  const referencedEvents = historyEvents.filter((row) => input.receipt.sourceEventIds.includes(row.eventId));
  if (referencedFindings.some((row) => {
    if (row.durableFindingId !== input.receipt.durableFindingId) return true;
    return row.groundedEvidence.semanticsVersion !== input.currentEvidenceSemanticsVersion
      || !sameRootCauseIdentity(row.groundedEvidence.rootCause, input.candidate.rootCause);
  })) return false;
  if (referencedFindings.length !== 1 || referencedFindings[0]?.findingEventId !== causeOrigins[0]!.sourceEventId
    || referencedEvents.length !== repairOrigins.length
    || referencedEvents.some((row) => !row.disposition || row.disposition.findingId !== input.receipt.durableFindingId
      || !['fixed', 'adjudicated_false_positive'].includes(row.disposition.kind))) return false;
  if (repairOrigins.length === 1 && (referencedEvents[0]?.eventId !== repairOrigins[0]!.sourceEventId
    || !verifiedRepairVerificationLinks(syntheticHistory, input.receipt.durableFindingId!, input.candidate.rootCause)
      .some((link) => link.causeFindingEventId === causeOrigins[0]!.sourceEventId
        && link.repairEventId === repairOrigins[0]!.sourceEventId))) return false;
  return true;
}

export type TrustedGroundedLifecycleTransitionV1 = WindowTrustedGroundedLifecycleTransitionV1;

/** DB-derived extension to the exact service context consumed by the strict v2 reducer. */
export type TrustedGroundedHistoryContext = WindowTrustedGroundedHistoryContext & {
  expectedTransitionsByFingerprint: Readonly<Record<string, TrustedGroundedLifecycleTransitionV1>>;
  authenticatedDisputePaths: readonly string[];
};

export interface TrustedGroundedHistoryProjection {
  groundedHistory: TrustedGroundedHistoryContext;
  authenticatedDisputes: readonly { findingFingerprint: string; priorFindingEventId: string; priorEvidenceDigest: string }[];
  consumedConventionSourceIdDigests: readonly string[];
  disputedFindingPaths: readonly string[];
}

function exactV2Citations(outcome: GroundedCompletionOutcomeV2, input: {
  owner: string; repo: string; headSha: string; baseSha: string;
}): GroundedCitationV2[] | null {
  const evidence = outcome.evidence;
  if (!evidence || !Array.isArray(evidence.citations) || evidence.citations.length === 0 || evidence.citations.length > 512
    || evidence.citations.some((citation) => !isValidGroundedCitationV2(citation))) return null;
  const citations = evidence.citations as GroundedCitationV2[];
  if (new Set(citations.map((citation) => citation.id)).size !== citations.length
    || citations.some((citation) => citation.repository !== `${input.owner}/${input.repo}`
      || citation.headSha !== input.headSha || citation.baseSha !== input.baseSha)
    || evidence.sourceWindowManifestDigest !== groundedCitationManifestDigest(citations)) return null;
  return citations;
}

function mappedCitationCovers(citation: GroundedCitationV2, anchor: {
  componentPath: string; startLine: number; endLine: number;
}, side: 'head' | 'base'): boolean {
  if (citation.side !== side || citation.path !== anchor.componentPath || !citation.window) return false;
  const window = citation.window;
  if (window.startLine <= anchor.startLine && window.endLine >= anchor.endLine) return true;
  const mapping = window.mapping as unknown as Record<string, unknown>;
  if (mapping.kind !== 'changed-hunk') return false;
  const counterpartStart = mapping.counterpartStartLine;
  const counterpartEnd = mapping.counterpartEndLine;
  if (Number.isSafeInteger(counterpartStart) && Number.isSafeInteger(counterpartEnd)
    && Number(counterpartStart) <= anchor.startLine && Number(counterpartEnd) >= anchor.endLine) return true;
  return Number.isSafeInteger(mapping.candidateLine) && anchor.startLine <= Number(mapping.candidateLine)
    && anchor.endLine >= Number(mapping.candidateLine);
}

function sourceRebindsContradictedPriorCause(input: {
  outcome: GroundedCompletionOutcomeV2;
  citations: readonly GroundedCitationV2[];
  rootCause: GroundedContinuityCandidate['rootCause'];
  causeAnchor: { componentPath: string; startLine: number; endLine: number; contentDigest: string };
}): boolean {
  const evidence = input.outcome.evidence;
  if (!evidence || !('explanation' in evidence) || typeof evidence.explanation !== 'string'
    || !Array.isArray(evidence.causalDiffPaths) || !validDigest(input.causeAnchor.contentDigest)) return false;
  const used = new Set(evidence.usedCitationIds);
  if (used.size === 0) return false;
  const usedCitations = input.citations.filter((citation) => used.has(citation.id));
  const path = input.causeAnchor.componentPath;
  // A fixed transition is emitted only when current base source reproduces the exact prior anchor
  // digest and current head source proves the mapped anchor or authenticated absence. Broader windows
  // without the exact anchor bytes remain insufficient and receive no lifecycle transition.
  const baseMapped = usedCitations.some((citation) => citation.side === 'base' && citation.window
    && citation.path === path && citation.window.path === path
    && citation.window.startLine === input.causeAnchor.startLine
    && citation.window.endLine === input.causeAnchor.endLine
    && citation.window.windowSha256 === input.causeAnchor.contentDigest);
  const headMapped = usedCitations.some((citation) => citation.side === 'head' && citation.window
    && citation.path === path && citation.window.path === path
    && citation.window.startLine === input.causeAnchor.startLine
    && citation.window.endLine === input.causeAnchor.endLine)
    || usedCitations.some((citation) => citation.side === 'head' && citation.path === path && citation.presence === 'absent');
  const diffBound = usedCitations.some((citation) => citation.side === 'diff' && citation.path === path);
  const candidatePath = typeof input.outcome.path === 'string' ? input.outcome.path : '';
  if (candidatePath === path) return baseMapped && headMapped && diffBound && evidence.causalDiffPaths.includes(path);
  const callers = usedCitations.flatMap((citation) => citation.window?.role === 'dependency-caller'
    && citation.window.mapping.kind === 'dependency-contract' ? [citation.window.mapping.edge] : []);
  const contracts = usedCitations.flatMap((citation) => citation.window?.role === 'dependency-contract'
    && citation.window.mapping.kind === 'dependency-contract' ? [citation.window.mapping.edge] : []);
  const dependencyBound = callers.some((caller) => contracts.some((contract) => caller.importerPath === candidatePath
    && caller.resolvedPath === path && contract.resolvedPath === path
    && caller.contractId === contract.contractId && caller.contractId === input.rootCause.contractId));
  return baseMapped && headMapped && diffBound && dependencyBound && evidence.causalDiffPaths.includes(candidatePath);
}

function sourceRebindsPriorCause(input: {
  outcome: GroundedCompletionOutcomeV2;
  citations: readonly GroundedCitationV2[];
  rootCause: GroundedContinuityCandidate['rootCause'];
  causeAnchor: { componentPath: string; startLine: number; endLine: number };
}): boolean {
  const evidence = input.outcome.evidence;
  if (!evidence || !('rootCause' in evidence)) return false;
  const baseState = evidence.baseState;
  const headState = evidence.headState;
  const causalChange = evidence.causalDelta;
  const path = input.causeAnchor.componentPath;
  const stateCitationIds = [baseState.citationIds, headState.citationIds, causalChange.citationIds]
    .flatMap((value) => Array.isArray(value) ? value.filter((id) => typeof id === 'string') as string[] : []);
  if (stateCitationIds.length === 0 || stateCitationIds.some((id) => !input.citations.some((citation) => citation.id === id))
    || !['introduced', 'materially-worsened', 'unaffected'].includes(String(causalChange.kind))) return false;
  const causalPath = evidence.causalPath;
  const relation = causalPath.relation;
  const callers = input.citations.flatMap((citation) => citation.window?.role === 'dependency-caller'
    && citation.window.mapping.kind === 'dependency-contract' ? [citation.window.mapping.edge] : []);
  const contracts = input.citations.flatMap((citation) => citation.window?.role === 'dependency-contract'
    && citation.window.mapping.kind === 'dependency-contract' ? [citation.window.mapping.edge] : []);
  const dependencyBound = callers.some((caller) => contracts.some((contract) => caller.contractId === contract.contractId
    && caller.importerPath === causalPath.candidatePath && caller.resolvedPath === path
    && contract.resolvedPath === path && caller.contractId === input.rootCause.contractId));
  if (['dependency-edge', 'contract-edge'].includes(relation)) return dependencyBound;
  if (relation !== 'same-component') return false;
  if (causalPath.componentPath !== undefined && causalPath.componentPath !== path) return false;
  const baseMapped = input.citations.some((citation) => mappedCitationCovers(citation, input.causeAnchor, 'base'));
  const headMapped = input.citations.some((citation) => mappedCitationCovers(citation, input.causeAnchor, 'head'))
    || input.citations.some((citation) => citation.side === 'head' && citation.path === path && citation.presence === 'absent');
  const diff = input.citations.some((citation) => citation.side === 'diff' && citation.path === path);
  return baseMapped && headMapped && diff;
}

function makeTrustedGroundedTransition(input: Omit<TrustedGroundedLifecycleTransitionV1, 'version' | 'evidenceDigest'>):
  TrustedGroundedLifecycleTransitionV1 {
  const fields = { version: 'GroundedLifecycleTransition.v1' as const, ...input };
  return { ...fields, evidenceDigest: sha256(canonicalJson(fields)) };
}

export async function deriveGroundedOriginAncestryRequests(client: ReviewLifecycleQueryable, input: {
  runId: string; executionAttempt: number; workerTokenDigest: string;
  repositoryId: number; owner: string; repo: string; prNumber: number;
  headSha: string; baseSha: string; policyDigest: string; configDigest: string; contextDigest: string;
  snapshotId: string; outcomes: readonly GroundedCompletionOutcomeV2[];
}): Promise<Readonly<Record<string, readonly GroundedContinuityOriginRef[]>>> {
  if (!uuid(input.snapshotId) || !await historyExecutionAuthorized(client, input)) return {};
  const snapshot = (await client.query(`SELECT snapshot.*, lifecycle.repository_id AS bound_repository_id,
      lifecycle.owner AS bound_owner, lifecycle.repo AS bound_repo, lifecycle.pr_number AS bound_pr_number
    FROM review_pr_lifecycle_history_snapshots snapshot
    JOIN review_pr_lifecycles lifecycle ON lifecycle.lifecycle_id = snapshot.lifecycle_id
    WHERE snapshot.snapshot_id = $1 AND snapshot.run_id = $2 AND snapshot.execution_attempt = $3
      AND snapshot.expires_at > CURRENT_TIMESTAMP`, [input.snapshotId, input.runId, input.executionAttempt])).rows[0];
  if (!snapshot || Number(snapshot.repository_id) !== input.repositoryId
    || Number(snapshot.bound_repository_id) !== input.repositoryId
    || snapshot.owner !== input.owner || snapshot.bound_owner !== input.owner || snapshot.repo !== input.repo
    || snapshot.bound_repo !== input.repo || Number(snapshot.pr_number) !== input.prNumber
    || Number(snapshot.bound_pr_number) !== input.prNumber || snapshot.head_sha !== input.headSha
    || snapshot.base_sha !== input.baseSha || snapshot.policy_digest !== input.policyDigest
    || snapshot.config_digest !== input.configDigest || snapshot.context_digest !== input.contextDigest
    || Number(snapshot.event_omitted_count) !== 0 || Number(snapshot.finding_omitted_count) !== 0
    || Number(snapshot.legacy_omitted_count) !== 0) return {};

  const findingIds = stringArray(snapshot.finding_ids);
  const eventIds = stringArray(snapshot.event_ids);
  const findingRows = findingIds.length === 0 ? [] : (await client.query(`SELECT finding_event_id, durable_finding_id,
      fingerprint, path, first_seen_head, last_seen_head, affected_context_digest, source_severity,
      effective_severity, disposition, blocking, verification_status, evidence_digest, source_evidence
    FROM review_semantic_finding_events WHERE lifecycle_id = $1 AND finding_event_id = ANY($2::uuid[])`,
  [snapshot.lifecycle_id, findingIds])).rows;
  const lifecycleEvents = eventIds.length === 0 ? [] : (await client.query(`SELECT event_id, event_type,
      run_id, execution_attempt, head_sha, base_sha, policy_digest, config_digest, context_digest,
      actor_digest, verification_status, evidence_digest, payload, created_at
    FROM review_pr_lifecycle_events WHERE lifecycle_id = $1 AND event_id = ANY($2::uuid[])`,
  [snapshot.lifecycle_id, eventIds])).rows;
  const projected = capturedOriginHistory({ snapshotId: input.snapshotId, contextDigest: input.contextDigest,
    findingIds, eventIds, findingRows, eventRows: lifecycleEvents });
  const requests: Record<string, readonly GroundedContinuityOriginRef[]> = {};
  const ambiguous = new Set<string>();
  for (const outcome of input.outcomes) {
    if (outcome.evidence?.semanticsVersion !== GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION
      || !/^fp1_[a-f0-9]{24}$/u.test(outcome.fingerprint)) continue;
    let origins: GroundedContinuityOriginRef[] | null = null;
    if (outcome.status === 'confirmed') {
      const candidate = groundedContinuityCandidateFrom(outcome);
      if (candidate) origins = groundedContinuityOriginRefs({ candidate, history: projected.history,
        currentHeadSha: input.headSha, continuityFindings: projected.findings });
    } else if (outcome.status === 'contradicted') {
      origins = groundedFixedOriginRefs({ fingerprint: outcome.fingerprint, path: outcome.path,
        currentHeadSha: input.headSha, history: projected.history, continuityFindings: projected.findings });
    }
    if (!origins || origins.length === 0) continue;
    const prior = requests[outcome.fingerprint];
    if (prior && canonicalJson(prior) !== canonicalJson(origins)) ambiguous.add(outcome.fingerprint);
    else requests[outcome.fingerprint] = origins;
  }
  for (const fingerprint of ambiguous) delete requests[fingerprint];
  return requests;
}

/**
 * Builds the Gate-only history contract from the exact pre-generation DB snapshot. Every continuity
 * alias is independently rederived from captured ledger rows, exact semantics and service-rechecked
 * ancestry; worker IDs/keys alone can never enter this projection.
 */
export async function createTrustedGroundedHistoryContext(client: ReviewLifecycleQueryable, input: {
  runId: string;
  executionAttempt: number;
  workerTokenDigest: string;
  repositoryId: number;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  policyDigest: string;
  configDigest: string;
  contextDigest: string;
  history: { status: string; snapshotId?: string; contextDigest?: string; eventOmittedCount: number;
    findingOmittedCount: number; legacyOmittedCount: number };
  outcomes: readonly GroundedCompletionOutcomeV2[];
  disputedRechecks?: readonly DisputedFindingRecheck[];
  originRequestsByFingerprint: GroundedOriginAncestryRequestsByFingerprint;
  serviceOriginAncestry: readonly GroundedOriginAncestryV1[];
  priorAncestryVerified: boolean;
  serviceAncestry?: ReviewHeadAncestryReceipt;
}): Promise<TrustedGroundedHistoryProjection | undefined> {
  const snapshotId = input.history.snapshotId;
  if (input.history.status !== 'complete' || !uuid(snapshotId ?? '')
    || !validDigest(input.history.contextDigest ?? '') || input.history.contextDigest !== input.contextDigest
    || input.history.eventOmittedCount !== 0 || input.history.findingOmittedCount !== 0
    || input.history.legacyOmittedCount !== 0 || !await historyExecutionAuthorized(client, input)) return undefined;
  const snapshot = (await client.query(`SELECT snapshot.*, lifecycle.repository_id AS bound_repository_id,
      lifecycle.owner AS bound_owner, lifecycle.repo AS bound_repo, lifecycle.pr_number AS bound_pr_number
    FROM review_pr_lifecycle_history_snapshots snapshot
    JOIN review_pr_lifecycles lifecycle ON lifecycle.lifecycle_id = snapshot.lifecycle_id
    WHERE snapshot.snapshot_id = $1 AND snapshot.run_id = $2 AND snapshot.execution_attempt = $3
      AND snapshot.expires_at > CURRENT_TIMESTAMP`, [snapshotId, input.runId, input.executionAttempt])).rows[0];
  if (!snapshot || Number(snapshot.repository_id) !== input.repositoryId
    || Number(snapshot.bound_repository_id) !== input.repositoryId
    || snapshot.owner !== input.owner || snapshot.bound_owner !== input.owner || snapshot.repo !== input.repo
    || snapshot.bound_repo !== input.repo || Number(snapshot.pr_number) !== input.prNumber
    || Number(snapshot.bound_pr_number) !== input.prNumber || snapshot.head_sha !== input.headSha
    || snapshot.base_sha !== input.baseSha || snapshot.policy_digest !== input.policyDigest
    || snapshot.config_digest !== input.configDigest || snapshot.context_digest !== input.contextDigest
    || Number(snapshot.event_omitted_count) !== 0 || Number(snapshot.finding_omitted_count) !== 0
    || Number(snapshot.legacy_omitted_count) !== 0) return undefined;

  const findingIds = stringArray(snapshot.finding_ids);
  const lifecycleEventIds = stringArray(snapshot.event_ids);
  const capturedIds = [...findingIds, ...lifecycleEventIds];
  if (new Set(capturedIds).size !== capturedIds.length || capturedIds.some((id) => !uuid(id))) return undefined;
  const eventRows = lifecycleEventIds.length === 0 ? [] : (await client.query(`SELECT event_id, event_type, run_id,
      execution_attempt, head_sha, base_sha, policy_digest, config_digest, context_digest, actor_digest,
      verification_status, evidence_digest, payload, created_at FROM review_pr_lifecycle_events
    WHERE lifecycle_id = $1 AND event_id = ANY($2::uuid[])`, [snapshot.lifecycle_id, lifecycleEventIds])).rows;
  const priorFindingRows = findingIds.length === 0 ? [] : (await client.query(`SELECT finding_event_id,
      durable_finding_id, run_id, execution_attempt, fingerprint, path, first_seen_head, last_seen_head,
      source_severity, effective_severity, disposition, blocking, verification_status,
      evidence_digest, affected_context_digest, source_evidence, created_at FROM review_semantic_finding_events
    WHERE lifecycle_id = $1 AND finding_event_id = ANY($2::uuid[])`, [snapshot.lifecycle_id, findingIds])).rows;
  const originHistory = capturedOriginHistory({ snapshotId: String(snapshot.snapshot_id),
    contextDigest: String(snapshot.context_digest), findingIds, eventIds: lifecycleEventIds,
    findingRows: priorFindingRows, eventRows });
  const originPlanningHistory = planningHistoryForCapturedOrigins({ history: originHistory.history,
    headSha: input.headSha, baseSha: input.baseSha, policyDigest: input.policyDigest, configDigest: input.configDigest });
  const originRequestsByFingerprint = input.originRequestsByFingerprint;
  const serviceOriginAncestryByEventId = new Map(input.serviceOriginAncestry
    .map((origin) => [origin.sourceEventId, origin]));
  const expectedOriginAncestryByFingerprint: Record<string, readonly GroundedOriginAncestryV1[]> = {};
  const duplicateOriginFingerprints = new Set<string>();
  for (const outcome of originPlanningHistory.evidenceSemanticsCompatibility.compatibleForContinuity
    ? input.outcomes : []) {
    const fingerprint = outcome.fingerprint;
    const requestedRefs = originRequestsByFingerprint[fingerprint];
    if (!requestedRefs || outcome.evidence?.semanticsVersion !== GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION) continue;
    let expectedRefs: readonly GroundedContinuityOriginRef[] | null = null;
    if (outcome.status === 'confirmed') {
      const candidate = groundedContinuityCandidateFrom(outcome);
      if (candidate) expectedRefs = groundedContinuityOriginRefs({ candidate, history: originHistory.history,
        currentHeadSha: input.headSha, continuityFindings: originHistory.findings });
    } else if (outcome.status === 'contradicted') {
      expectedRefs = groundedFixedOriginRefs({ fingerprint, path: outcome.path, currentHeadSha: input.headSha,
        history: originHistory.history, continuityFindings: originHistory.findings });
    }
    if (!expectedRefs || canonicalJson(expectedRefs) !== canonicalJson(requestedRefs)) continue;
    const serviceProofs = expectedRefs.flatMap((ref) => {
      const proof = serviceOriginAncestryByEventId.get(ref.sourceEventId);
      return proof ? [proof] : [];
    });
    const joined = groundedOriginAncestryJoin({ expected: expectedRefs, proofs: serviceProofs, currentHeadSha: input.headSha });
    if (!joined) continue;
    const prior = expectedOriginAncestryByFingerprint[fingerprint];
    if (prior && canonicalJson(prior) !== canonicalJson(joined)) duplicateOriginFingerprints.add(fingerprint);
    else expectedOriginAncestryByFingerprint[fingerprint] = joined;
  }
  for (const fingerprint of duplicateOriginFingerprints) delete expectedOriginAncestryByFingerprint[fingerprint];
  let verifiedAncestry: ReviewHeadAncestryReceipt | undefined;
  const ancestry = input.serviceAncestry;
  const newestEligibleCompletion = selectNewestEligibleGroundedCompletion(originHistory.history.events);
  if (input.priorAncestryVerified && ancestry?.version === 'ReviewHeadAncestry.v1'
    && ancestry.result === 'ancestor' && ancestry.currentHeadSha === input.headSha
    && validDigest(ancestry.comparisonDigest)
    && ancestry.priorRunId === newestEligibleCompletion?.runId
    && ancestry.priorHeadSha === newestEligibleCompletion.headSha) verifiedAncestry = ancestry;

  const currentCandidates = input.outcomes.flatMap((outcome) => {
    const candidate = outcome.status === 'confirmed'
      && outcome.evidence?.semanticsVersion === GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION
      ? groundedContinuityCandidateFrom(outcome) : null;
    return candidate ? [candidate] : [];
  });
  const expectedContinuityByFingerprint: Record<string, GroundedFindingContinuity> = {};
  const expectedTransitionsByFingerprint: Record<string, TrustedGroundedLifecycleTransitionV1> = {};
  const duplicateFingerprintKeys = new Set<string>();
  const duplicateTransitionKeys = new Set<string>();
  const citationsForOutcome = (outcome: GroundedCompletionOutcomeV2) => exactV2Citations(outcome, {
    owner: input.owner, repo: input.repo, headSha: input.headSha, baseSha: input.baseSha,
  });
  const addTransition = (transition: TrustedGroundedLifecycleTransitionV1) => {
    const prior = expectedTransitionsByFingerprint[transition.currentFingerprint];
    if (prior && canonicalJson(prior) !== canonicalJson(transition)) duplicateTransitionKeys.add(transition.currentFingerprint);
    else expectedTransitionsByFingerprint[transition.currentFingerprint] = transition;
  };
  for (const row of input.outcomes) {
    const outcomeEvidence = row.evidence;
    if (!outcomeEvidence || outcomeEvidence.semanticsVersion !== GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION) continue;
    const citations = citationsForOutcome(row);
    const candidate = groundedContinuityCandidateFrom(row);
    if (row.status === 'confirmed' && candidate) {
      const continuity = groundedFindingContinuitySchema.safeParse(row.verifiedContinuity);
      if (continuity.success && continuity.data.status !== 'unavailable') {
        const verifiedOriginAncestry = expectedOriginAncestryByFingerprint[row.fingerprint];
        const valid = await validatePrFindingContinuityReceipt(client, {
          runId: input.runId, executionAttempt: input.executionAttempt, workerTokenDigest: input.workerTokenDigest,
          repositoryId: input.repositoryId, owner: input.owner, repo: input.repo, prNumber: input.prNumber,
          headSha: input.headSha, baseSha: input.baseSha, policyDigest: input.policyDigest,
          configDigest: input.configDigest, contextDigest: input.contextDigest,
          currentEvidenceSemanticsVersion: GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION, candidate,
          currentCandidates, receipt: continuity.data,
          ...(verifiedOriginAncestry ? { verifiedOriginAncestry } : {}),
          priorAncestryVerified: verifiedAncestry !== undefined,
        });
        if (valid) {
          const prior = expectedContinuityByFingerprint[row.fingerprint];
          if (prior && canonicalJson(prior) !== canonicalJson(continuity.data)) duplicateFingerprintKeys.add(row.fingerprint);
          else expectedContinuityByFingerprint[row.fingerprint] = continuity.data;
        }
      }
    }
    if (!citations || typeof row.path !== 'string' || typeof row.fingerprint !== 'string'
      || !/^fp1_[a-f0-9]{24}$/u.test(row.fingerprint)
      || typeof row.affectedContextDigest !== 'string' || !validDigest(row.affectedContextDigest)
      || typeof row.evidenceDigest !== 'string' || !validDigest(row.evidenceDigest)
      || !validDigest(outcomeEvidence.sourceWindowManifestDigest)
      || (row.candidateSide !== 'head' && row.candidateSide !== 'base')) continue;
    if (row.status === 'contradicted') {
      const causeOrigin = expectedOriginAncestryByFingerprint[row.fingerprint]?.find((origin) => origin.sourceKind === 'cause');
      if (!causeOrigin) continue;
      const priorRows = priorFindingRows.filter((prior) => String(prior.fingerprint) === row.fingerprint
        && String(prior.finding_event_id) === causeOrigin.sourceEventId
        && String(prior.path) === row.path && prior.verification_status === 'confirmed'
        && jsonObject(jsonObject(prior.source_evidence).groundedEvidenceV2).semanticsVersion
          === GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION);
      const priorIds = [...new Set(priorRows.map((prior) => String(prior.durable_finding_id))
        .filter((id) => /^lf1_[a-f0-9]{32}$/u.test(id)))];
      if (priorIds.length === 1) {
        const prior = priorRows.filter((candidateRow) => String(candidateRow.durable_finding_id) === priorIds[0])
          .sort((left, right) => new Date(left.created_at).getTime() - new Date(right.created_at).getTime()).at(-1);
        const priorEvidence = jsonObject(jsonObject(prior?.source_evidence).groundedEvidenceV2);
        const cause = jsonObject(priorEvidence.rootCause);
        const anchor = jsonObject(priorEvidence.causeAnchor);
        const priorRootCause = ['componentId', 'behaviorId', 'contractId', 'failureModeId'].every((key) => typeof cause[key] === 'string')
          ? { componentId: String(cause.componentId), behaviorId: String(cause.behaviorId),
            contractId: String(cause.contractId), failureModeId: String(cause.failureModeId) } : undefined;
        const priorAnchor = typeof anchor.componentPath === 'string' && Number.isSafeInteger(anchor.startLine)
          && Number.isSafeInteger(anchor.endLine)
          && typeof anchor.contentDigest === 'string' && validDigest(anchor.contentDigest)
          ? { componentPath: anchor.componentPath, startLine: Number(anchor.startLine), endLine: Number(anchor.endLine),
            contentDigest: anchor.contentDigest } : undefined;
        const alreadyClosed = eventRows.some((event) => {
          const payload = jsonObject(event.payload);
          const disposition = findingDispositionEventSchema.safeParse(payload);
          return disposition.success && disposition.data.findingId === priorIds[0]
            && (disposition.data.kind === 'fixed' || disposition.data.kind === 'adjudicated_false_positive');
        });
        const rebinding = priorRootCause && priorAnchor && sourceRebindsContradictedPriorCause({ outcome: row, citations,
          rootCause: priorRootCause, causeAnchor: priorAnchor });
        if (prior && !alreadyClosed && rebinding) {
          addTransition(makeTrustedGroundedTransition({ kind: 'fixed', durableFindingId: priorIds[0]!,
            priorFindingEventId: String(prior.finding_event_id), changedContextDigest: row.affectedContextDigest,
            currentOutcomeEvidenceDigest: row.evidenceDigest, historySnapshotId: String(snapshot.snapshot_id),
            historyContextDigest: String(snapshot.context_digest), currentFingerprint: row.fingerprint,
            candidateSide: row.candidateSide, outcomeStatus: 'contradicted', baseSha: input.baseSha,
            headSha: input.headSha, sourceWindowManifestDigest: outcomeEvidence.sourceWindowManifestDigest }));
        }
      }
    }
    const causalScope = 'rootCause' in outcomeEvidence ? outcomeEvidence.scopeDecision.causalScope : undefined;
    if (row.status === 'confirmed' && row.candidateSide === 'head' && candidate
      && ['introduced', 'exacerbated'].includes(String(causalScope))) {
      const continuity = expectedContinuityByFingerprint[row.fingerprint];
      if (!continuity || continuity.status !== 'reopened' || !continuity.durableFindingId) continue;
      const repairOrigin = expectedOriginAncestryByFingerprint[row.fingerprint]?.find((origin) => origin.sourceKind === 'repair');
      if (!repairOrigin) continue;
      const priorFixedEvents = eventRows.flatMap((event) => {
        const disposition = findingDispositionEventSchema.safeParse(jsonObject(event.payload));
        return disposition.success && disposition.data.kind === 'fixed'
          && disposition.data.findingId === continuity.durableFindingId && repairOrigin.sourceEventId === String(event.event_id)
          ? [{ eventId: String(event.event_id), createdAt: event.created_at }] : [];
      }).sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
      const priorFixed = priorFixedEvents.at(-1);
      const verifiedCausalScope = causalScope as 'introduced' | 'exacerbated';
      const rebinding = sourceRebindsPriorCause({ outcome: row, citations,
        rootCause: candidate.rootCause, causeAnchor: candidate.causeAnchor });
      if (priorFixed && rebinding) addTransition(makeTrustedGroundedTransition({ kind: 'regressed',
        durableFindingId: continuity.durableFindingId, priorFindingEventId: priorFixed.eventId,
        changedContextDigest: row.affectedContextDigest, currentOutcomeEvidenceDigest: row.evidenceDigest,
        historySnapshotId: String(snapshot.snapshot_id), historyContextDigest: String(snapshot.context_digest),
        currentFingerprint: row.fingerprint, candidateSide: 'head', outcomeStatus: 'confirmed',
        baseSha: input.baseSha, headSha: input.headSha, sourceWindowManifestDigest: outcomeEvidence.sourceWindowManifestDigest,
        causalScope: verifiedCausalScope }));
    }
  }
  for (const key of duplicateFingerprintKeys) delete expectedContinuityByFingerprint[key];
  for (const key of duplicateTransitionKeys) delete expectedTransitionsByFingerprint[key];
  const authenticatedDisputes: Array<{ findingFingerprint: string; priorFindingEventId: string; priorEvidenceDigest: string }> = [];
  const disputedFindingPaths = new Set<string>();
  for (const request of input.disputedRechecks ?? []) {
    disputedFindingPaths.add(request.finding.path.replaceAll('\\', '/').replace(/^\.\//u, ''));
    if (request.finding.severity !== 'P0' && request.finding.severity !== 'P1') continue;
    const targetFingerprint = findingFingerprint(request.finding);
    const matching = priorFindingRows.filter((prior) => String(prior.run_id) === request.runId
      && Number(prior.execution_attempt) === request.sourceExecutionAttempt
      && String(prior.fingerprint) === targetFingerprint && String(prior.path) === request.finding.path
      && prior.verification_status === 'confirmed' && ['P0', 'P1'].includes(String(prior.source_severity))
      && jsonObject(jsonObject(prior.source_evidence).groundedEvidenceV2).semanticsVersion
        === GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION
      && sha256(canonicalJson(jsonObject(prior.source_evidence))) === String(prior.evidence_digest));
    if (matching.length !== 1) continue;
    const prior = matching[0]!;
    authenticatedDisputes.push({ findingFingerprint: targetFingerprint,
      priorFindingEventId: String(prior.finding_event_id), priorEvidenceDigest: String(prior.evidence_digest) });
  }
  const consumedConventionSourceIdDigests = eventRows.flatMap((event) => {
    const parsed = findingDispositionEventSchema.safeParse(jsonObject(event.payload));
    return parsed.success && parsed.data.kind === 'accepted_convention' ? [parsed.data.provenance.sourceIdDigest] : [];
  });
  const continuityEventIds = Object.values(expectedContinuityByFingerprint).flatMap((receipt) => receipt.sourceEventIds);
  const transitionEventIds = Object.values(expectedTransitionsByFingerprint).map((transition) => transition.priorFindingEventId);
  const serviceEventIds = [...new Set([...continuityEventIds, ...transitionEventIds,
    ...authenticatedDisputes.map((dispute) => dispute.priorFindingEventId)])].sort();
  if (serviceEventIds.length > 4_096) {
    for (const key of Object.keys(expectedContinuityByFingerprint)) delete expectedContinuityByFingerprint[key];
    for (const key of Object.keys(expectedTransitionsByFingerprint)) delete expectedTransitionsByFingerprint[key];
    serviceEventIds.splice(0, serviceEventIds.length, ...authenticatedDisputes.map((dispute) => dispute.priorFindingEventId));
  }
  const uniqueServiceEventIds = [...new Set(serviceEventIds)].sort().slice(0, 4_096);
  return { groundedHistory: { snapshotId: String(snapshot.snapshot_id), contextDigest: String(snapshot.context_digest), eventIds: uniqueServiceEventIds,
    currentRunId: input.runId, currentHeadSha: input.headSha, expectedContinuityByFingerprint,
    expectedTransitionsByFingerprint, expectedOriginAncestryByFingerprint,
    authenticatedDisputePaths: [...disputedFindingPaths].sort(),
    ...(verifiedAncestry ? { verifiedAncestry } : {}) },
  authenticatedDisputes, consumedConventionSourceIdDigests, disputedFindingPaths: [...disputedFindingPaths].sort() };
}

/**
 * Capture a fixed, bounded view of immutable PR history for the exact live worker execution.
 * The PR coordinates are selected from the admitted run and its lifecycle reservation; the
 * worker cannot choose another repository or PR. A single INSERT...SELECT statement captures
 * all event/finding IDs from one MVCC snapshot, so concurrent appends cannot shift pagination.
 */
async function authenticatedDisputesForSnapshot(client: ReviewLifecycleQueryable, input: {
  snapshot: Record<string, unknown>;
  runId: string;
  executionAttempt: number;
  repositoryId: number;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  policyDigest: string;
  configDigest: string;
}): Promise<AuthenticatedDisputesProjection> {
  let requests: DisputedFindingRecheck[];
  try {
    requests = await loadValidatedDisputedFindingRechecks(client, {
      run_id: input.runId, repository_id: input.repositoryId, owner: input.owner, repo: input.repo,
      pr_number: input.prNumber, head_sha: input.headSha, base_sha: input.baseSha,
      effective_policy_digest: input.policyDigest, effective_config_digest: input.configDigest,
    }, input.executionAttempt);
  } catch {
    return { status: 'unavailable', disputes: [], paths: [], reason: 'source-unavailable' };
  }
  const paths = [...new Set(requests.map((request) => request.finding.path.replaceAll('\\', '/').replace(/^\.\//u, '')))].sort();
  if (Number(input.snapshot.event_omitted_count) !== 0 || Number(input.snapshot.finding_omitted_count) !== 0
    || Number(input.snapshot.legacy_omitted_count) !== 0) {
    return { status: 'unavailable', disputes: [], paths, reason: 'history-incomplete' };
  }
  const findingIds = stringArray(input.snapshot.finding_ids);
  const findingRows = findingIds.length === 0 ? [] : (await client.query(`SELECT finding_event_id,
      run_id, execution_attempt, durable_finding_id, fingerprint, path, source_severity,
      verification_status, evidence_digest, source_evidence
    FROM review_semantic_finding_events WHERE lifecycle_id = $1 AND finding_event_id = ANY($2::uuid[])`,
  [input.snapshot.lifecycle_id, findingIds])).rows;
  const authenticated: AuthenticatedDisputeTuple[] = [];
  let ambiguous = false;
  for (const request of requests) {
    if (request.finding.severity !== 'P0' && request.finding.severity !== 'P1') continue;
    const fingerprint = findingFingerprint(request.finding);
    const matching = findingRows.filter((row) => String(row.run_id) === request.runId
      && Number(row.execution_attempt) === request.sourceExecutionAttempt
      && String(row.fingerprint) === fingerprint
      && String(row.path).replaceAll('\\', '/').replace(/^\.\//u, '') === request.finding.path.replaceAll('\\', '/').replace(/^\.\//u, '')
      && row.verification_status === 'confirmed' && ['P0', 'P1'].includes(String(row.source_severity))
      && jsonObject(jsonObject(row.source_evidence).groundedEvidenceV2).semanticsVersion
        === GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION
      && sha256(canonicalJson(jsonObject(row.source_evidence))) === String(row.evidence_digest));
    if (matching.length !== 1) { ambiguous = true; continue; }
    const source = matching[0]!;
    authenticated.push({ findingFingerprint: fingerprint, priorFindingEventId: String(source.finding_event_id),
      priorEvidenceDigest: String(source.evidence_digest) });
  }
  if (ambiguous || new Set(authenticated.map((row) => row.findingFingerprint)).size !== authenticated.length) {
    return { status: 'unavailable', disputes: [], paths, reason: 'ambiguous-linkage' };
  }
  return { status: 'complete', disputes: authenticated, paths };
}

export async function createPrLifecycleHistorySnapshot(client: ReviewLifecycleQueryable,
  input: PrLifecycleHistorySnapshotRequest): Promise<PrLifecycleHistorySnapshotCreateResult> {
  if (!/^run_[a-f0-9]{32}$/u.test(input.runId) || !Number.isSafeInteger(input.executionAttempt)
    || input.executionAttempt < 1 || !validDigest(input.workerTokenDigest)) return { status: 'unauthorized' };
  if (!await historyExecutionAuthorized(client, input)) return { status: 'unauthorized' };
  const snapshotId = randomUUID();
  const result = await client.query(`
    WITH admitted AS MATERIALIZED (
      SELECT r.run_id, $2::integer AS execution_attempt, l.lifecycle_id, l.repository_id, l.owner, l.repo,
        l.pr_number, reservation.head_sha, reservation.base_sha, reservation.policy_digest,
        reservation.config_digest, reservation.context_digest
      FROM review_runs r
      JOIN review_dispatch_outbox outbox ON outbox.run_id = r.run_id AND outbox.execution_attempt + 1 = $2
      JOIN review_pr_review_reservations reservation
        ON reservation.run_id = r.run_id AND reservation.execution_attempt = $2
      JOIN review_pr_lifecycles l ON l.lifecycle_id = reservation.lifecycle_id
      WHERE r.run_id = $1 AND outbox.worker_token_digest = $3 AND r.status IN ('queued', 'running')
        AND r.cancel_requested_at IS NULL AND r.cancel_propagated_at IS NULL
        AND outbox.status = 'projected' AND outbox.cancel_requested_at IS NULL AND outbox.cancel_propagated_at IS NULL
        AND reservation.status = 'reserved'
        AND r.repository_id = l.repository_id AND r.owner = l.owner AND r.repo = l.repo AND r.pr_number = l.pr_number
        AND r.head_sha = reservation.head_sha AND r.base_sha = reservation.base_sha
        AND r.effective_policy_digest = reservation.policy_digest AND r.effective_config_digest = reservation.config_digest
        AND r.snapshot_digest = reservation.context_digest
    ), captured AS MATERIALIZED (
      SELECT admitted.*,
        ARRAY(SELECT event.event_id FROM review_pr_lifecycle_events event
          WHERE event.lifecycle_id = admitted.lifecycle_id
          ORDER BY event.created_at DESC, event.event_id DESC LIMIT ${MAX_CAPTURED_HISTORY_IDS}) AS event_ids,
        (SELECT COUNT(*)::integer FROM review_pr_lifecycle_events event
          WHERE event.lifecycle_id = admitted.lifecycle_id) AS event_total_count,
        ARRAY(SELECT finding.finding_event_id FROM review_semantic_finding_events finding
          WHERE finding.lifecycle_id = admitted.lifecycle_id
          ORDER BY finding.created_at DESC, finding.finding_event_id DESC LIMIT ${MAX_CAPTURED_HISTORY_IDS}) AS finding_ids,
        (SELECT COUNT(*)::integer FROM review_semantic_finding_events finding
          WHERE finding.lifecycle_id = admitted.lifecycle_id) AS finding_total_count,
        (SELECT COUNT(*)::integer FROM review_runs legacy
          LEFT JOIN review_worker_completions completion ON completion.run_id = legacy.run_id
          LEFT JOIN review_pr_review_reservations prior_reservation
            ON prior_reservation.run_id = completion.run_id
           AND prior_reservation.execution_attempt = completion.execution_attempt
          WHERE legacy.repository_id = admitted.repository_id AND legacy.owner = admitted.owner
            AND legacy.repo = admitted.repo AND legacy.pr_number = admitted.pr_number
            AND ((completion.execution_attempt IS NULL AND NOT EXISTS (
                   SELECT 1 FROM review_pr_review_reservations current_reservation
                   WHERE current_reservation.run_id = legacy.run_id))
              OR (completion.execution_attempt IS NOT NULL AND prior_reservation.reservation_id IS NULL)))
          AS legacy_omitted_count
      FROM admitted
    )
    INSERT INTO review_pr_lifecycle_history_snapshots (
      snapshot_id, run_id, execution_attempt, lifecycle_id, repository_id, owner, repo, pr_number,
      head_sha, base_sha, policy_digest, config_digest, context_digest, event_ids, finding_ids,
      event_total_count, finding_total_count, event_omitted_count, finding_omitted_count,
      legacy_omitted_count, created_at, expires_at)
    SELECT $4, run_id, execution_attempt, lifecycle_id, repository_id, owner, repo, pr_number,
      head_sha, base_sha, policy_digest, config_digest, context_digest, event_ids, finding_ids,
      event_total_count, finding_total_count,
      GREATEST(0, event_total_count - cardinality(event_ids)),
      GREATEST(0, finding_total_count - cardinality(finding_ids)),
      legacy_omitted_count, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + ($5::integer * INTERVAL '1 millisecond')
    FROM captured
    RETURNING *`, [input.runId, input.executionAttempt, input.workerTokenDigest, snapshotId, HISTORY_SNAPSHOT_TTL_MS]);
  const row = result.rows[0];
  if (!row) return { status: 'unavailable' };
  const eventIds = stringArray(row.event_ids);
  const findingIds = stringArray(row.finding_ids);
  const authenticatedDisputes = await authenticatedDisputesForSnapshot(client, {
    snapshot: row, runId: input.runId, executionAttempt: input.executionAttempt,
    repositoryId: Number(row.repository_id), owner: String(row.owner), repo: String(row.repo),
    prNumber: Number(row.pr_number), headSha: String(row.head_sha), baseSha: String(row.base_sha),
    policyDigest: String(row.policy_digest), configDigest: String(row.config_digest),
  });
  return { status: 'ok', snapshot: {
    snapshotId: String(row.snapshot_id), runId: String(row.run_id), executionAttempt: Number(row.execution_attempt),
    repositoryId: Number(row.repository_id), owner: String(row.owner), repo: String(row.repo), prNumber: Number(row.pr_number),
    headSha: String(row.head_sha), baseSha: String(row.base_sha), policyDigest: String(row.policy_digest),
    configDigest: String(row.config_digest), contextDigest: String(row.context_digest),
    eventCount: Number(row.event_total_count), findingCount: Number(row.finding_total_count),
    eventOmittedCount: Number(row.event_omitted_count), findingOmittedCount: Number(row.finding_omitted_count),
    legacyOmittedCount: Number(row.legacy_omitted_count),
    authenticatedDisputes,
    eventsDigest: sha256(canonicalJson(eventIds)), findingsDigest: sha256(canonicalJson(findingIds)),
    expiresAt: new Date(row.expires_at).toISOString(),
  } };
}

/** Read one page from the immutable ID set captured for this still-authorized exact run. */
export async function readPrLifecycleHistorySnapshotPage(client: ReviewLifecycleQueryable, input: {
  runId: string;
  executionAttempt: number;
  workerTokenDigest: string;
  snapshotId: string;
  collection: PrLifecycleHistoryCollection;
  offset: number;
  limit: number;
}): Promise<PrLifecycleHistorySnapshotPageResult> {
  if (!/^run_[a-f0-9]{32}$/u.test(input.runId) || !Number.isSafeInteger(input.executionAttempt)
    || input.executionAttempt < 1 || !validDigest(input.workerTokenDigest)
    || !uuid(input.snapshotId) || !['events', 'findings'].includes(input.collection)
    || !Number.isSafeInteger(input.offset) || input.offset < 0
    || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 250) return { status: 'not_found' };
  if (!await historyExecutionAuthorized(client, input)) return { status: 'unauthorized' };
  const column = input.collection === 'events' ? 'event_ids' : 'finding_ids';
  const idColumn = input.collection === 'events' ? 'event_id' : 'finding_event_id';
  const relation = input.collection === 'events' ? 'review_pr_lifecycle_events' : 'review_semantic_finding_events';
  const totalColumn = input.collection === 'events' ? 'event_total_count' : 'finding_total_count';
  const omittedColumn = input.collection === 'events' ? 'event_omitted_count' : 'finding_omitted_count';
  const snapshot = (await client.query(`SELECT snapshot.snapshot_id, snapshot.lifecycle_id, snapshot.${column} AS captured_ids,
      snapshot.${totalColumn} AS total_count, snapshot.${omittedColumn} AS omitted_count
    FROM review_pr_lifecycle_history_snapshots snapshot
    JOIN review_runs target ON target.run_id = snapshot.run_id
    JOIN review_dispatch_outbox outbox ON outbox.run_id = target.run_id
      AND outbox.execution_attempt + 1 = snapshot.execution_attempt
    JOIN review_pr_review_reservations reservation ON reservation.run_id = snapshot.run_id
      AND reservation.execution_attempt = snapshot.execution_attempt
    JOIN review_pr_lifecycles lifecycle ON lifecycle.lifecycle_id = reservation.lifecycle_id
    WHERE snapshot.snapshot_id = $1 AND snapshot.run_id = $2 AND snapshot.execution_attempt = $3
      AND snapshot.expires_at > CURRENT_TIMESTAMP AND outbox.worker_token_digest = $4
      AND target.status IN ('queued', 'running') AND target.cancel_requested_at IS NULL AND target.cancel_propagated_at IS NULL
      AND outbox.status = 'projected' AND outbox.cancel_requested_at IS NULL AND outbox.cancel_propagated_at IS NULL
      AND reservation.status = 'reserved' AND reservation.lifecycle_id = snapshot.lifecycle_id
      AND target.repository_id = lifecycle.repository_id AND target.owner = lifecycle.owner
      AND target.repo = lifecycle.repo AND target.pr_number = lifecycle.pr_number
      AND target.head_sha = snapshot.head_sha AND target.base_sha = snapshot.base_sha
      AND target.effective_policy_digest = snapshot.policy_digest
      AND target.effective_config_digest = snapshot.config_digest AND target.snapshot_digest = snapshot.context_digest
      AND reservation.head_sha = snapshot.head_sha AND reservation.base_sha = snapshot.base_sha
      AND reservation.policy_digest = snapshot.policy_digest AND reservation.config_digest = snapshot.config_digest
      AND reservation.context_digest = snapshot.context_digest`,
  [input.snapshotId, input.runId, input.executionAttempt, input.workerTokenDigest])).rows[0];
  if (!snapshot) return { status: 'not_found' };
  const page = await client.query(`
    SELECT item.* FROM unnest($1::uuid[]) WITH ORDINALITY captured(item_id, ordinal)
    JOIN ${relation} item ON item.${idColumn} = captured.item_id
    WHERE item.lifecycle_id = $2 AND captured.ordinal > $3 AND captured.ordinal <= $4
    ORDER BY captured.ordinal`, [snapshot.captured_ids, snapshot.lifecycle_id, input.offset, input.offset + input.limit]);
  const totalCount = Number(snapshot.total_count);
  const capturedCount = Math.max(0, totalCount - Number(snapshot.omitted_count));
  const nextOffset = input.offset + page.rows.length;
  return { status: 'ok', snapshotId: input.snapshotId, collection: input.collection,
    offset: input.offset, limit: input.limit, totalCount, capturedCount, rows: page.rows,
    hasMore: nextOffset < capturedCount, nextOffset: nextOffset < capturedCount ? nextOffset : null };
}

export interface ReviewPrLifecycleIdentity {
  repositoryId: number;
  owner: string;
  repo: string;
  prNumber: number;
}

export interface ReviewPrReservationInput extends ReviewPrLifecycleIdentity {
  runId: string;
  executionAttempt: number;
  deliveryId: string;
  headSha: string;
  baseSha: string;
  policyDigest: string;
  configDigest: string;
  contextDigest: string;
  at?: number;
}

export type ReviewReservationStatus = 'reserved' | 'completed' | 'failed' | 'cancelled' | 'superseded';
export type IndependentVerificationStatus = 'confirmed' | 'contradicted' | 'insufficient';

export interface ReviewSemanticFindingInput {
  fingerprint: string;
  /** Per-review occurrence key; never used as the durable finding ID. */
  rootCauseEvidenceKey?: string;
  /** Set only after the service validates a v2 continuity receipt against its captured ledger snapshot. */
  durableFindingId?: string;
  verifiedContinuity?: GroundedFindingContinuity;
  /** Service-reduced lifecycle transition; worker-supplied transition JSON is never persisted directly. */
  trustedLifecycleTransition?: TrustedGroundedLifecycleTransitionV1;
  path: string;
  line?: number;
  severity: string;
  sourceSeverity?: string;
  disposition: string;
  blocking: boolean;
  affectedContextDigest: string;
  sourceEvidence: unknown;
  provenance?: Record<string, unknown>;
  independentVerification?: {
    status: IndependentVerificationStatus;
    verifier: string;
    evidenceDigest: string;
    evidence: unknown;
  };
}

export interface ReviewLifecycleReservation {
  lifecycleId: string;
  reservationId: string;
  created: boolean;
  status: ReviewReservationStatus;
}

function validDigest(value: string): boolean { return /^[a-f0-9]{64}$/u.test(value); }
function validSha(value: string): boolean { return /^[a-f0-9]{40}$/u.test(value); }

function requireReservationInput(input: ReviewPrReservationInput): void {
  if (!Number.isSafeInteger(input.repositoryId) || input.repositoryId <= 0
    || !Number.isSafeInteger(input.prNumber) || input.prNumber <= 0
    || !Number.isSafeInteger(input.executionAttempt) || input.executionAttempt <= 0
    || !input.owner || !input.repo || !input.runId || !input.deliveryId
    || !validSha(input.headSha) || !validSha(input.baseSha)
    || !validDigest(input.policyDigest) || !validDigest(input.configDigest) || !validDigest(input.contextDigest)
    || (input.at !== undefined && !Number.isFinite(input.at))) {
    throw new Error('Invalid semantic review reservation identity');
  }
}

async function ensureLifecycle(client: ReviewLifecycleQueryable, input: ReviewPrLifecycleIdentity, at: number): Promise<string> {
  if (!Number.isSafeInteger(input.repositoryId) || input.repositoryId <= 0
    || !Number.isSafeInteger(input.prNumber) || input.prNumber <= 0 || !input.owner || !input.repo) {
    throw new Error('Invalid pull request lifecycle identity');
  }
  const result = await client.query(`INSERT INTO review_pr_lifecycles
      (lifecycle_id, repository_id, owner, repo, pr_number, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0), to_timestamp($6 / 1000.0))
    ON CONFLICT (repository_id, pr_number) DO UPDATE
      SET updated_at = GREATEST(review_pr_lifecycles.updated_at, EXCLUDED.updated_at)
    RETURNING lifecycle_id, owner, repo`,
  [randomUUID(), input.repositoryId, input.owner, input.repo, input.prNumber, at]);
  const row = result.rows[0];
  if (!row || row.owner !== input.owner || row.repo !== input.repo) {
    throw new Error('Pull request lifecycle identity conflicts with its repository binding');
  }
  return String(row.lifecycle_id);
}

async function appendLifecycleEvent(client: ReviewLifecycleQueryable, input: {
  lifecycleId: string;
  reservationId?: string;
  idempotencyKey: string;
  eventType: string;
  identity: ReviewPrLifecycleIdentity;
  runId?: string;
  executionAttempt?: number;
  headSha?: string;
  baseSha?: string;
  policyDigest?: string;
  configDigest?: string;
  contextDigest?: string;
  evidenceDigest?: string;
  actorDigest?: string;
  verificationStatus?: IndependentVerificationStatus;
  payload: unknown;
  at: number;
}): Promise<void> {
  const payloadDigest = sha256(canonicalJson(input.payload));
  const inserted = await client.query(`INSERT INTO review_pr_lifecycle_events
      (event_id, lifecycle_id, reservation_id, idempotency_key, event_type, run_id, execution_attempt,
       repository_id, pr_number, head_sha, base_sha, policy_digest, config_digest, context_digest,
       evidence_digest, actor_digest, verification_status, payload, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
       $18::jsonb, to_timestamp($19 / 1000.0))
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING event_id`,
  [randomUUID(), input.lifecycleId, input.reservationId ?? null, input.idempotencyKey, input.eventType,
    input.runId ?? null, input.executionAttempt ?? null, input.identity.repositoryId, input.identity.prNumber,
    input.headSha ?? null, input.baseSha ?? null, input.policyDigest ?? null, input.configDigest ?? null,
    input.contextDigest ?? null, input.evidenceDigest ?? payloadDigest, input.actorDigest ?? null,
    input.verificationStatus ?? 'insufficient', JSON.stringify(input.payload), input.at]);
  if (inserted.rows.length > 0) return;
  const prior = (await client.query(`SELECT event_type, lifecycle_id, evidence_digest, payload
    FROM review_pr_lifecycle_events WHERE idempotency_key = $1`, [input.idempotencyKey])).rows[0];
  if (!prior || prior.event_type !== input.eventType || prior.lifecycle_id !== input.lifecycleId
    || prior.evidence_digest !== (input.evidenceDigest ?? payloadDigest)
    || canonicalJson(typeof prior.payload === 'string' ? JSON.parse(prior.payload) : prior.payload)
      !== canonicalJson(input.payload)) {
    throw new Error('Lifecycle event idempotency key conflicts with previously recorded evidence');
  }
}

/**
 * Called from the PR-locked webhook admission transaction. The database
 * uniqueness constraints make concurrent deliveries converge on one lifecycle
 * and one reservation for the exact run attempt.
 */
export async function reservePrReview(
  client: ReviewLifecycleQueryable,
  input: ReviewPrReservationInput,
): Promise<ReviewLifecycleReservation> {
  requireReservationInput(input);
  const at = input.at ?? Date.now();
  const identity: ReviewPrLifecycleIdentity = {
    repositoryId: input.repositoryId, owner: input.owner, repo: input.repo, prNumber: input.prNumber,
  };
  const lifecycleId = await ensureLifecycle(client, identity, at);
  const reservationId = randomUUID();
  const inserted = await client.query(`INSERT INTO review_pr_review_reservations
      (reservation_id, lifecycle_id, run_id, execution_attempt, delivery_id, head_sha, base_sha,
       policy_digest, config_digest, context_digest, status, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'reserved',
       to_timestamp($11 / 1000.0), to_timestamp($11 / 1000.0))
    ON CONFLICT (run_id, execution_attempt) DO NOTHING
    RETURNING reservation_id, status`,
  [reservationId, lifecycleId, input.runId, input.executionAttempt, input.deliveryId, input.headSha,
    input.baseSha, input.policyDigest, input.configDigest, input.contextDigest, at]);
  const row = (await client.query(`SELECT reservation_id, lifecycle_id, delivery_id,
      head_sha, base_sha, policy_digest, config_digest, context_digest, status
    FROM review_pr_review_reservations WHERE run_id = $1 AND execution_attempt = $2 FOR UPDATE`,
  [input.runId, input.executionAttempt])).rows[0];
  if (!row || row.lifecycle_id !== lifecycleId || row.head_sha !== input.headSha || row.base_sha !== input.baseSha
    || row.policy_digest !== input.policyDigest || row.config_digest !== input.configDigest
    || row.context_digest !== input.contextDigest) {
    throw new Error('Review reservation conflicts with its immutable exact-head identity');
  }
  const actualReservationId = String(row.reservation_id);
  const created = inserted.rows.length > 0;
  if (created) {
    await appendLifecycleEvent(client, {
      lifecycleId, reservationId: actualReservationId, idempotencyKey: `${actualReservationId}:reserved`,
      eventType: 'review.reserved', identity, runId: input.runId, executionAttempt: input.executionAttempt,
      headSha: input.headSha, baseSha: input.baseSha, policyDigest: input.policyDigest,
      configDigest: input.configDigest, contextDigest: input.contextDigest,
      payload: { deliveryId: input.deliveryId }, at,
    });
  }
  return { lifecycleId, reservationId: actualReservationId, created, status: row.status as ReviewReservationStatus };
}

/** Terminal state is mutable projection; every transition is separately retained as an immutable event. */
export async function transitionPrReviewReservation(client: ReviewLifecycleQueryable, input: {
  runId: string;
  executionAttempt: number;
  status: Exclude<ReviewReservationStatus, 'reserved'>;
  reason?: string;
  completionDigest?: string;
  decisionReceipt?: unknown;
  at?: number;
}): Promise<void> {
  if (!input.runId || !Number.isSafeInteger(input.executionAttempt) || input.executionAttempt <= 0
    || (input.completionDigest !== undefined && !validDigest(input.completionDigest))) {
    throw new Error('Invalid review reservation transition');
  }
  const at = input.at ?? Date.now();
  const result = await client.query(`UPDATE review_pr_review_reservations
      SET status = $3, completion_digest = COALESCE($4, completion_digest),
          decision_receipt = COALESCE($5::jsonb, decision_receipt),
          completed_at = COALESCE(completed_at, to_timestamp($6 / 1000.0)),
          updated_at = to_timestamp($6 / 1000.0)
    WHERE run_id = $1 AND execution_attempt = $2 AND (status = 'reserved' OR status = $3)
    RETURNING lifecycle_id, reservation_id, head_sha, base_sha,
      policy_digest, config_digest, context_digest`,
  [input.runId, input.executionAttempt, input.status, input.completionDigest ?? null,
    input.decisionReceipt === undefined ? null : JSON.stringify(input.decisionReceipt), at]);
  let row = result.rows[0];
  if (!row) {
    const prior = (await client.query(`SELECT status FROM review_pr_review_reservations
      WHERE run_id = $1 AND execution_attempt = $2`, [input.runId, input.executionAttempt])).rows[0];
    if (!prior) return; // Legacy run admitted before this additive ledger existed.
    throw new Error(`Review reservation cannot transition from ${prior.status} to ${input.status}`);
  }
  const identity = (await client.query(`SELECT repository_id, owner, repo, pr_number
    FROM review_pr_lifecycles WHERE lifecycle_id = $1`, [row.lifecycle_id])).rows[0];
  if (!identity) throw new Error('Review reservation has no pull request lifecycle');
  const decision = input.decisionReceipt ?? null;
  const evidenceDigest = input.completionDigest ?? sha256(canonicalJson({ status: input.status, reason: input.reason ?? null, decision }));
  await appendLifecycleEvent(client, {
    lifecycleId: String(row.lifecycle_id), reservationId: String(row.reservation_id),
    idempotencyKey: `${row.reservation_id}:${input.status}`, eventType: `review.${input.status}`,
    identity: { repositoryId: Number(identity.repository_id), owner: String(identity.owner),
      repo: String(identity.repo), prNumber: Number(identity.pr_number) },
    runId: input.runId, executionAttempt: input.executionAttempt,
    headSha: row.head_sha, baseSha: row.base_sha, policyDigest: row.policy_digest,
    configDigest: row.config_digest, contextDigest: row.context_digest, evidenceDigest,
    payload: { reason: input.reason ?? null, decisionReceipt: decision }, at,
  });
}

export async function releaseActivePrReviewReservations(client: ReviewLifecycleQueryable, input: {
  runId: string;
  status: 'cancelled' | 'superseded' | 'failed';
  reason: string;
  at?: number;
}): Promise<void> {
  const reservations = await client.query(`SELECT execution_attempt FROM review_pr_review_reservations
    WHERE run_id = $1 AND status = 'reserved' ORDER BY execution_attempt FOR UPDATE`, [input.runId]);
  for (const row of reservations.rows) {
    await transitionPrReviewReservation(client, {
      runId: input.runId, executionAttempt: Number(row.execution_attempt), status: input.status,
      reason: input.reason, at: input.at,
    });
  }
}

/** Append exact trusted completion and semantic finding history in the same transaction as the Gate decision. */
export async function recordTrustedPrReviewCompletion(client: ReviewLifecycleQueryable, input: {
  runId: string;
  executionAttempt: number;
  status: 'completed' | 'failed' | 'cancelled';
  completionDigest: string;
  decisionReceipt: unknown;
  findings: readonly ReviewSemanticFindingInput[];
  dispositions?: readonly FindingDispositionDraft[];
  satisfiedRecheckRequestIds?: readonly string[];
  at?: number;
}): Promise<void> {
  if (!validDigest(input.completionDigest)) throw new Error('Invalid trusted completion digest');
  await transitionPrReviewReservation(client, {
    runId: input.runId, executionAttempt: input.executionAttempt,
    status: input.status, completionDigest: input.completionDigest,
    decisionReceipt: input.decisionReceipt, at: input.at,
  });
  const reservation = (await client.query(`SELECT r.reservation_id, r.lifecycle_id, l.repository_id,
      l.pr_number, r.head_sha, r.base_sha, r.policy_digest, r.config_digest, r.context_digest,
      l.owner, l.repo
    FROM review_pr_review_reservations r JOIN review_pr_lifecycles l USING (lifecycle_id)
    WHERE r.run_id = $1 AND r.execution_attempt = $2`,
  [input.runId, input.executionAttempt])).rows[0];
  if (!reservation) return; // Preserve pre-migration completion behavior for an old run.
  const identity = { repositoryId: Number(reservation.repository_id), prNumber: Number(reservation.pr_number),
    owner: String(reservation.owner), repo: String(reservation.repo) };
  await appendLifecycleEvent(client, {
    lifecycleId: String(reservation.lifecycle_id), reservationId: String(reservation.reservation_id),
    idempotencyKey: `${reservation.reservation_id}:completion:${input.completionDigest}`,
    eventType: 'review.completion_recorded', identity, runId: input.runId,
    executionAttempt: input.executionAttempt, headSha: reservation.head_sha, baseSha: reservation.base_sha,
    policyDigest: reservation.policy_digest, configDigest: reservation.config_digest,
    contextDigest: reservation.context_digest, evidenceDigest: input.completionDigest,
    payload: { status: input.status, decisionReceipt: input.decisionReceipt }, at: input.at ?? Date.now(),
  });

  const satisfiedRecheckRequestIds = [...new Set(input.satisfiedRecheckRequestIds ?? [])].sort();
  if (satisfiedRecheckRequestIds.length > 0) {
    if (satisfiedRecheckRequestIds.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id))) {
      throw new Error('Invalid satisfied finding recheck receipt id');
    }
    await appendLifecycleEvent(client, {
      lifecycleId: String(reservation.lifecycle_id), reservationId: String(reservation.reservation_id),
      idempotencyKey: `${reservation.reservation_id}:rechecks-satisfied:${input.completionDigest}`,
      eventType: 'finding.rechecks_satisfied', identity, runId: input.runId,
      executionAttempt: input.executionAttempt, headSha: reservation.head_sha, baseSha: reservation.base_sha,
      policyDigest: reservation.policy_digest, configDigest: reservation.config_digest,
      contextDigest: reservation.context_digest, evidenceDigest: input.completionDigest,
      payload: { requestIds: satisfiedRecheckRequestIds }, at: input.at ?? Date.now(),
    });
  }

  const currentFindingIdsByOccurrence = new Map<string, string>();
  const currentFindingIdsByFingerprint = new Map<string, Set<string>>();
  for (const finding of input.findings) {
    if (!finding.fingerprint || !finding.path || !finding.severity || !finding.disposition
      || !validDigest(finding.affectedContextDigest)) throw new Error('Invalid semantic finding history event');
    if (finding.rootCauseEvidenceKey !== undefined
      && (typeof finding.rootCauseEvidenceKey !== 'string' || finding.rootCauseEvidenceKey.length < 1
        || finding.rootCauseEvidenceKey.length > 512)) throw new Error('Invalid per-review root-cause evidence key');
    const verification = finding.independentVerification;
    if (verification && (!verification.verifier || !validDigest(verification.evidenceDigest)
      || verification.status !== 'confirmed' && verification.status !== 'contradicted' && verification.status !== 'insufficient')) {
      throw new Error('Invalid semantic finding verification evidence');
    }
    const evidenceDigest = sha256(canonicalJson(finding.sourceEvidence));
    const occurrenceDigest = finding.rootCauseEvidenceKey ? sha256(finding.rootCauseEvidenceKey) : finding.fingerprint;
    const occurrenceKey = `${finding.fingerprint}:${occurrenceDigest}`;
    const eventKey = `${reservation.reservation_id}:finding:${occurrenceDigest}`;
    const priorEvent = (await client.query(`SELECT finding_event_id, durable_finding_id, first_seen_head,
        evidence_digest, affected_context_digest, disposition, verification_status
      FROM review_semantic_finding_events WHERE event_key = $1`, [eventKey])).rows[0];
    const continuityIdentityValid = Boolean(finding.verifiedContinuity
      && ['continuous', 'reopened'].includes(finding.verifiedContinuity.status)
      && finding.verifiedContinuity.durableFindingId === finding.durableFindingId);
    const transition = finding.trustedLifecycleTransition;
    const transitionIdentityValid = Boolean(transition && transition.version === 'GroundedLifecycleTransition.v1'
      && transition.durableFindingId === finding.durableFindingId
      && transition.currentFingerprint === finding.fingerprint
      && transition.changedContextDigest === finding.affectedContextDigest
      && transition.currentOutcomeEvidenceDigest === finding.independentVerification?.evidenceDigest
      && validDigest(transition.evidenceDigest) && validDigest(transition.currentOutcomeEvidenceDigest)
      && uuid(transition.historySnapshotId) && validDigest(transition.historyContextDigest)
      && validDigest(transition.sourceWindowManifestDigest)
      && transition.headSha === reservation.head_sha && transition.baseSha === reservation.base_sha
      && (transition.kind === 'fixed' && transition.outcomeStatus === 'contradicted'
        || transition.kind === 'regressed' && transition.outcomeStatus === 'confirmed'
          && (transition.causalScope === 'introduced' || transition.causalScope === 'exacerbated'))
      && jsonObject(finding.sourceEvidence).trustedLifecycleTransition !== undefined
      && canonicalJson(jsonObject(finding.sourceEvidence).trustedLifecycleTransition) === canonicalJson(transition));
    let transitionReferenceValid = false;
    if (transition && transitionIdentityValid) {
      if (transition.kind === 'fixed') {
        const priorRow = (await client.query(`SELECT durable_finding_id, verification_status
          FROM review_semantic_finding_events WHERE lifecycle_id = $1 AND finding_event_id = $2`,
        [reservation.lifecycle_id, transition.priorFindingEventId])).rows[0];
        transitionReferenceValid = priorRow?.durable_finding_id === transition.durableFindingId
          && priorRow?.verification_status === 'confirmed';
      } else {
        const priorEvent = (await client.query(`SELECT event_type, payload FROM review_pr_lifecycle_events
          WHERE lifecycle_id = $1 AND event_id = $2`, [reservation.lifecycle_id, transition.priorFindingEventId])).rows[0];
        const priorDisposition = priorEvent ? findingDispositionEventSchema.safeParse(jsonObject(priorEvent.payload)) : undefined;
        transitionReferenceValid = priorEvent?.event_type === 'finding.disposition.fixed' && priorDisposition?.success === true
          && priorDisposition.data.kind === 'fixed' && priorDisposition.data.findingId === transition.durableFindingId;
      }
    }
    if (finding.durableFindingId !== undefined && (!/^lf1_[a-f0-9]{32}$/u.test(finding.durableFindingId)
      || (!continuityIdentityValid && !(transitionIdentityValid && transitionReferenceValid)))) {
      throw new Error('Durable finding identity requires a validated continuity receipt');
    }
    const legacyPriorFindingId = priorEvent && !priorEvent.durable_finding_id
      ? durableFindingIdFor(String(reservation.lifecycle_id), finding.fingerprint) : undefined;
    if (legacyPriorFindingId) {
      await client.query(`UPDATE review_semantic_finding_events SET durable_finding_id = $2 WHERE event_key = $1 AND durable_finding_id IS NULL`,
      [eventKey, legacyPriorFindingId]);
    }
    const durableFindingId = priorEvent?.durable_finding_id ?? legacyPriorFindingId ?? finding.durableFindingId ?? newDurableFindingId();
    if (!/^lf1_[a-f0-9]{32}$/u.test(String(durableFindingId))) throw new Error('Invalid durable finding identity');
    const first = priorEvent ? undefined : (finding.durableFindingId ? (await client.query(`SELECT first_seen_head
      FROM review_semantic_finding_events WHERE lifecycle_id = $1 AND durable_finding_id = $2
      ORDER BY created_at, finding_event_id LIMIT 1`, [reservation.lifecycle_id, finding.durableFindingId])).rows[0] : undefined);
    const firstSeenHead = priorEvent?.first_seen_head ?? first?.first_seen_head ?? reservation.head_sha;
    const findingEventId = randomUUID();
    const inserted = await client.query(`INSERT INTO review_semantic_finding_events
        (finding_event_id, lifecycle_id, reservation_id, event_key, run_id, execution_attempt, durable_finding_id,
         fingerprint, path, region_start, region_end, first_seen_head, last_seen_head,
         affected_context_digest, source_severity, effective_severity, disposition, blocking, verification_status,
         evidence_digest, source_evidence, provenance)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
         $20, $21::jsonb, $22::jsonb)
      ON CONFLICT (event_key) DO NOTHING RETURNING finding_event_id`,
    [findingEventId, reservation.lifecycle_id, reservation.reservation_id, eventKey, input.runId,
      input.executionAttempt, durableFindingId, finding.fingerprint, finding.path, finding.line ?? null, finding.line ?? null,
      firstSeenHead, reservation.head_sha, finding.affectedContextDigest, finding.sourceSeverity ?? finding.severity,
      finding.severity, finding.disposition, finding.blocking, verification?.status ?? 'insufficient', evidenceDigest,
      JSON.stringify(finding.sourceEvidence), JSON.stringify(finding.provenance ?? {})]);
    let persistedFindingEventId = inserted.rows[0]?.finding_event_id;
    if (inserted.rows.length === 0) {
      const prior = (await client.query(`SELECT finding_event_id, durable_finding_id, evidence_digest, affected_context_digest, disposition, verification_status
        FROM review_semantic_finding_events WHERE event_key = $1`, [eventKey])).rows[0];
      if (!prior || prior.evidence_digest !== evidenceDigest
        || prior.affected_context_digest !== finding.affectedContextDigest || prior.disposition !== finding.disposition
        || prior.verification_status !== (verification?.status ?? 'insufficient')
        || prior.durable_finding_id !== durableFindingId) {
        throw new Error('Semantic finding event key conflicts with previously recorded evidence');
      }
      persistedFindingEventId = prior.finding_event_id;
    }
    if (verification) {
      if (!persistedFindingEventId) throw new Error('Semantic finding verification has no persisted source event');
      await recordIndependentFindingVerification(client, {
        findingEventId: String(persistedFindingEventId), status: verification.status, verifier: verification.verifier,
        evidenceDigest: verification.evidenceDigest, contextDigest: finding.affectedContextDigest,
        evidence: verification.evidence, at: input.at,
      });
    }
    currentFindingIdsByOccurrence.set(occurrenceKey, String(durableFindingId));
    const ids = currentFindingIdsByFingerprint.get(finding.fingerprint) ?? new Set<string>();
    ids.add(String(durableFindingId));
    currentFindingIdsByFingerprint.set(finding.fingerprint, ids);
  }

  for (const rawDisposition of input.dispositions ?? []) {
    const draft = rawDisposition as FindingDispositionDraft;
    let linkedFindingId = draft.findingId;
    const draftOccurrenceDigest = draft.sourceOccurrenceKey ? sha256(draft.sourceOccurrenceKey) : draft.fingerprint;
    if (!linkedFindingId) linkedFindingId = currentFindingIdsByOccurrence.get(`${draft.fingerprint}:${draftOccurrenceDigest}`);
    if (!linkedFindingId) {
      const currentIds = [...(currentFindingIdsByFingerprint.get(draft.fingerprint) ?? [])];
      if (currentIds.length === 1) linkedFindingId = currentIds[0];
    }
    if (!linkedFindingId) {
      const prior = (await client.query(`SELECT durable_finding_id FROM review_semantic_finding_events
        WHERE lifecycle_id = $1 AND fingerprint = $2 ORDER BY created_at DESC, finding_event_id DESC LIMIT 1`,
      [reservation.lifecycle_id, draft.fingerprint])).rows[0];
      linkedFindingId = typeof prior?.durable_finding_id === 'string' ? prior.durable_finding_id : undefined;
    }
    if (!linkedFindingId) throw new Error('Finding disposition has no unambiguous durable finding identity');
    const parsed = findingDispositionEventSchema.safeParse({ ...draft, findingId: linkedFindingId });
    if (!parsed.success) throw new Error('Invalid typed finding disposition event');
    const disposition = parsed.data;
    if (disposition.runId !== input.runId || disposition.executionAttempt !== input.executionAttempt
      || disposition.headSha !== reservation.head_sha || disposition.baseSha !== reservation.base_sha
      || disposition.policyDigest !== reservation.policy_digest || disposition.configDigest !== reservation.config_digest
      || disposition.contextDigest !== reservation.context_digest) {
      throw new Error('Finding disposition does not match the admitted review context');
    }
    const known = (await client.query(`SELECT durable_finding_id FROM review_semantic_finding_events
      WHERE lifecycle_id = $1 AND durable_finding_id = $2 LIMIT 1`,
    [reservation.lifecycle_id, disposition.findingId])).rows[0];
    if (!known && !currentFindingIdsByOccurrence.has(`${disposition.fingerprint}:${draftOccurrenceDigest}`)
      && !currentFindingIdsByFingerprint.get(disposition.fingerprint)?.has(disposition.findingId)) {
      throw new Error('Finding disposition references an unverified durable finding identity');
    }
    const payloadDigest = sha256(canonicalJson(disposition));
    await appendLifecycleEvent(client, {
      lifecycleId: String(reservation.lifecycle_id), reservationId: String(reservation.reservation_id),
      idempotencyKey: `${reservation.reservation_id}:finding-disposition:${disposition.kind}:${disposition.findingId}:${disposition.evidenceDigest}:${disposition.provenance.sourceIdDigest ?? ''}`,
      eventType: findingDispositionEventType(disposition.kind), identity,
      runId: input.runId, executionAttempt: input.executionAttempt, headSha: reservation.head_sha,
      baseSha: reservation.base_sha, policyDigest: reservation.policy_digest,
      configDigest: reservation.config_digest, contextDigest: reservation.context_digest,
      evidenceDigest: payloadDigest, actorDigest: disposition.provenance.actorDigest,
      payload: disposition, at: input.at ?? Date.now(),
    });
  }
}

/**
 * Record the existing authenticated, permission-checked MCP recheck request.
 * The caller identifier is hashed by the caller path; this method never accepts
 * an actor identity from a tool payload.
 */
export async function recordPrFindingRecheckRequest(client: ReviewLifecycleQueryable, input: {
  runId: string;
  sourceExecutionAttempt: number;
  requestId: string;
  findingId: string;
  actorDigest: string;
  sourceContentDigest: string;
  sourceContextDigest: string;
  requestDigest: string;
  at?: number;
}): Promise<void> {
  if (!/^[a-f0-9]{64}$/u.test(input.actorDigest) || !validDigest(input.sourceContentDigest)
    || !validDigest(input.sourceContextDigest) || !validDigest(input.requestDigest)) {
    throw new Error('Invalid authenticated finding recheck provenance');
  }
  const reservation = (await client.query(`SELECT r.reservation_id, r.lifecycle_id, l.repository_id, l.pr_number,
      r.head_sha, r.base_sha, r.policy_digest, r.config_digest, r.context_digest, l.owner, l.repo
    FROM review_pr_review_reservations r JOIN review_pr_lifecycles l USING (lifecycle_id)
    WHERE r.run_id = $1 AND r.execution_attempt = $2`, [input.runId, input.sourceExecutionAttempt])).rows[0];
  if (!reservation) return; // Legacy source completions remain usable; their own recheck ledger is still authoritative.
  await appendLifecycleEvent(client, {
    lifecycleId: String(reservation.lifecycle_id), reservationId: String(reservation.reservation_id),
    idempotencyKey: `${input.requestId}:recheck-requested`, eventType: 'finding.recheck_requested',
    identity: { repositoryId: Number(reservation.repository_id), owner: String(reservation.owner),
      repo: String(reservation.repo), prNumber: Number(reservation.pr_number) },
    runId: input.runId, executionAttempt: input.sourceExecutionAttempt,
    headSha: reservation.head_sha, baseSha: reservation.base_sha, policyDigest: reservation.policy_digest,
    configDigest: reservation.config_digest, contextDigest: input.sourceContextDigest,
    evidenceDigest: input.requestDigest, actorDigest: input.actorDigest,
    payload: { requestId: input.requestId, findingId: input.findingId,
      sourceContentDigest: input.sourceContentDigest, sourceReservationContextDigest: reservation.context_digest },
    at: input.at ?? Date.now(),
  });
}

/**
 * Reserve the exact execution admitted by an authenticated finding recheck.
 * The caller holds the PR transaction lock and writes this together with the
 * recheck admission. Its immutable target identity uses the same candidate
 * snapshot digest later supplied by dispatch and trusted completion.
 */
export async function reservePrFindingRecheckTarget(client: ReviewLifecycleQueryable, input: {
  repositoryId: number;
  owner: string;
  repo: string;
  prNumber: number;
  runId: string;
  deliveryId: string;
  sourceExecutionAttempt: number;
  executionAttempt: number;
  requestId: string;
  requestDigest: string;
  sourceContentDigest: string;
  sourceContextDigest: string;
  headSha: string;
  baseSha: string;
  policyDigest: string;
  configDigest: string;
  candidateContextDigest: string;
  actorDigest: string;
  at?: number;
}): Promise<ReviewLifecycleReservation> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(input.requestId)
    || !Number.isSafeInteger(input.sourceExecutionAttempt) || input.sourceExecutionAttempt < 1
    || input.executionAttempt !== input.sourceExecutionAttempt + 1
    || !validDigest(input.requestDigest) || !validDigest(input.sourceContentDigest)
    || !validDigest(input.sourceContextDigest) || input.sourceContextDigest !== input.candidateContextDigest
    || !/^[a-f0-9]{64}$/u.test(input.actorDigest)) {
    throw new Error('Invalid finding recheck target reservation evidence');
  }
  const at = input.at ?? Date.now();
  const reservation = await reservePrReview(client, {
    repositoryId: input.repositoryId, owner: input.owner, repo: input.repo, prNumber: input.prNumber,
    runId: input.runId, executionAttempt: input.executionAttempt, deliveryId: input.deliveryId,
    headSha: input.headSha, baseSha: input.baseSha, policyDigest: input.policyDigest,
    configDigest: input.configDigest, contextDigest: input.candidateContextDigest, at,
  });
  await appendLifecycleEvent(client, {
    lifecycleId: reservation.lifecycleId, reservationId: reservation.reservationId,
    idempotencyKey: `${input.requestId}:recheck-target-admitted`,
    eventType: 'finding.recheck_target_admitted',
    identity: { repositoryId: input.repositoryId, owner: input.owner, repo: input.repo, prNumber: input.prNumber },
    runId: input.runId, executionAttempt: input.executionAttempt,
    headSha: input.headSha, baseSha: input.baseSha, policyDigest: input.policyDigest,
    configDigest: input.configDigest, contextDigest: input.candidateContextDigest,
    evidenceDigest: input.requestDigest, actorDigest: input.actorDigest,
    payload: {
      requestId: input.requestId, requestDigest: input.requestDigest,
      sourceRunId: input.runId, sourceExecutionAttempt: input.sourceExecutionAttempt,
      sourceCompletionDigest: input.sourceContentDigest,
      sourceContextDigest: input.sourceContextDigest,
      targetExecutionAttempt: input.executionAttempt,
      candidate: { headSha: input.headSha, baseSha: input.baseSha,
        policyDigest: input.policyDigest, configDigest: input.configDigest,
        contextDigest: input.candidateContextDigest },
    },
    at,
  });
  return reservation;
}

/** Add a separately evidenced finding verification decision without mutating the source finding row. */
export async function recordIndependentFindingVerification(client: ReviewLifecycleQueryable, input: {
  findingEventId: string;
  status: IndependentVerificationStatus;
  verifier: string;
  evidenceDigest: string;
  contextDigest: string;
  evidence: unknown;
  at?: number;
}): Promise<void> {
  if (!input.verifier || !validDigest(input.evidenceDigest) || !validDigest(input.contextDigest)) {
    throw new Error('Invalid independent finding verification evidence');
  }
  const source = (await client.query(`SELECT f.*, l.repository_id, l.pr_number, l.owner, l.repo
    FROM review_semantic_finding_events f JOIN review_pr_lifecycles l USING (lifecycle_id)
    WHERE finding_event_id = $1`, [input.findingEventId])).rows[0];
  if (!source || source.affected_context_digest !== input.contextDigest) {
    throw new Error('Finding verification does not match the source context');
  }
  const payload = { findingEventId: input.findingEventId, fingerprint: source.fingerprint,
    verifier: input.verifier, status: input.status, evidence: input.evidence };
  await appendLifecycleEvent(client, {
    lifecycleId: String(source.lifecycle_id), reservationId: String(source.reservation_id),
    idempotencyKey: `${input.findingEventId}:verification:${input.evidenceDigest}`,
    eventType: 'finding.independent_verification',
    identity: { repositoryId: Number(source.repository_id), owner: String(source.owner),
      repo: String(source.repo), prNumber: Number(source.pr_number) },
    runId: String(source.run_id), executionAttempt: Number(source.execution_attempt),
    headSha: String(source.last_seen_head), contextDigest: input.contextDigest,
    evidenceDigest: input.evidenceDigest, verificationStatus: input.status, payload,
    at: input.at ?? Date.now(),
  });
}

/**
 * Store an independently retrieved verification for a current admitted run. Unlike a historical
 * source-context receipt, this path binds both ends: the historical finding must belong to the same
 * lifecycle, and the verifier's current-context digest must match the exact target reservation.
 * The independently computed affected-source digest is retained in the immutable payload; a later
 * head can only reuse it after its own verifier has established the same affected context.
 */
export async function recordCurrentPrFindingVerification(client: ReviewLifecycleQueryable, input: {
  findingEventId: string;
  snapshotId: string;
  runId: string;
  executionAttempt: number;
  workerTokenDigest: string;
  status: IndependentVerificationStatus;
  currentContextDigest: string;
  currentAffectedContextDigest: string;
  evidenceDigest: string;
  evidence: unknown;
  at?: number;
}): Promise<'unauthorized' | 'not_found' | 'stale_context' | 'recorded'> {
  if (!uuid(input.findingEventId) || !uuid(input.snapshotId) || !/^run_[a-f0-9]{32}$/u.test(input.runId)
    || !Number.isSafeInteger(input.executionAttempt) || input.executionAttempt < 1
    || !validDigest(input.workerTokenDigest) || !validDigest(input.currentContextDigest)
    || !validDigest(input.currentAffectedContextDigest) || !validDigest(input.evidenceDigest)
    || !['confirmed', 'contradicted', 'insufficient'].includes(input.status)) return 'not_found';
  if (!await historyExecutionAuthorized(client, input)) return 'unauthorized';
  const binding = (await client.query(`SELECT current_reservation.reservation_id AS target_reservation_id,
      current_reservation.lifecycle_id AS target_lifecycle_id,
      current_reservation.head_sha AS target_head_sha, current_reservation.base_sha AS target_base_sha,
      current_reservation.policy_digest AS target_policy_digest, current_reservation.config_digest AS target_config_digest,
      current_reservation.context_digest AS target_context_digest,
      target.repository_id AS target_repository_id, target.owner AS target_owner,
      target.repo AS target_repo, target.pr_number AS target_pr_number,
      source.finding_event_id, source.fingerprint, source.affected_context_digest AS source_affected_context_digest,
      source.lifecycle_id AS source_lifecycle_id, source.reservation_id AS source_reservation_id,
      source_lifecycle.repository_id AS source_repository_id, source_lifecycle.owner AS source_owner,
      source_lifecycle.repo AS source_repo, source_lifecycle.pr_number AS source_pr_number
    FROM review_runs target
    JOIN review_dispatch_outbox outbox ON outbox.run_id = target.run_id AND outbox.execution_attempt + 1 = $2
    JOIN review_pr_review_reservations current_reservation
      ON current_reservation.run_id = target.run_id AND current_reservation.execution_attempt = $2
    JOIN review_pr_lifecycles target_lifecycle ON target_lifecycle.lifecycle_id = current_reservation.lifecycle_id
    JOIN review_semantic_finding_events source ON source.finding_event_id = $3
    JOIN review_pr_lifecycles source_lifecycle ON source_lifecycle.lifecycle_id = source.lifecycle_id
    JOIN review_pr_lifecycle_history_snapshots snapshot
      ON snapshot.snapshot_id = $5 AND snapshot.run_id = target.run_id
     AND snapshot.execution_attempt = $2 AND source.finding_event_id = ANY(snapshot.finding_ids)
    WHERE target.run_id = $1 AND target.repository_id = target_lifecycle.repository_id
      AND outbox.worker_token_digest = $6 AND outbox.status = 'projected'
      AND outbox.cancel_requested_at IS NULL AND outbox.cancel_propagated_at IS NULL
      AND target.status IN ('queued', 'running') AND target.cancel_requested_at IS NULL
      AND target.cancel_propagated_at IS NULL AND current_reservation.status = 'reserved'
      AND target.owner = target_lifecycle.owner AND target.repo = target_lifecycle.repo
      AND target.pr_number = target_lifecycle.pr_number
      AND target.head_sha = current_reservation.head_sha AND target.base_sha = current_reservation.base_sha
      AND target.effective_policy_digest = current_reservation.policy_digest
      AND target.effective_config_digest = current_reservation.config_digest
      AND target.snapshot_digest = current_reservation.context_digest
      AND snapshot.lifecycle_id = current_reservation.lifecycle_id
      AND snapshot.head_sha = current_reservation.head_sha AND snapshot.base_sha = current_reservation.base_sha
      AND snapshot.policy_digest = current_reservation.policy_digest
      AND snapshot.config_digest = current_reservation.config_digest
      AND snapshot.context_digest = current_reservation.context_digest AND snapshot.expires_at > CURRENT_TIMESTAMP
      AND current_reservation.context_digest = $4
      AND source.lifecycle_id = current_reservation.lifecycle_id
      AND source_lifecycle.repository_id = target_lifecycle.repository_id
      AND source_lifecycle.owner = target_lifecycle.owner AND source_lifecycle.repo = target_lifecycle.repo
      AND source_lifecycle.pr_number = target_lifecycle.pr_number`,
  [input.runId, input.executionAttempt, input.findingEventId, input.currentContextDigest, input.snapshotId,
    input.workerTokenDigest])).rows[0];
  if (!binding) {
    const target = (await client.query(`SELECT context_digest FROM review_pr_review_reservations
      WHERE run_id = $1 AND execution_attempt = $2`, [input.runId, input.executionAttempt])).rows[0];
    return target ? 'stale_context' : 'not_found';
  }
  const payload = {
    findingEventId: input.findingEventId,
    fingerprint: String(binding.fingerprint),
    verifier: 'independent_grounded_verifier',
    status: input.status,
    sourceAffectedContextDigest: String(binding.source_affected_context_digest),
    currentAffectedContextDigest: input.currentAffectedContextDigest,
    evidenceDigest: input.evidenceDigest,
    evidence: input.evidence,
  };
  const identity = { repositoryId: Number(binding.target_repository_id), owner: String(binding.target_owner),
    repo: String(binding.target_repo), prNumber: Number(binding.target_pr_number) };
  await appendLifecycleEvent(client, {
    lifecycleId: String(binding.target_lifecycle_id), reservationId: String(binding.target_reservation_id),
    idempotencyKey: `${input.findingEventId}:verification:${input.runId}:${input.executionAttempt}:${input.currentAffectedContextDigest}:${input.evidenceDigest}`,
    eventType: 'finding.independent_verification', identity, runId: input.runId,
    executionAttempt: input.executionAttempt, headSha: String(binding.target_head_sha),
    baseSha: String(binding.target_base_sha), policyDigest: String(binding.target_policy_digest),
    configDigest: String(binding.target_config_digest), contextDigest: String(binding.target_context_digest),
    evidenceDigest: input.evidenceDigest, verificationStatus: input.status, payload, at: input.at ?? Date.now(),
  });
  return 'recorded';
}

export async function readPrLifecycleHistory(client: ReviewLifecycleQueryable, identity: ReviewPrLifecycleIdentity,
  options: { offset?: number; limit?: number } = {}) {
  return readPrLifecycleHistoryPage(client, identity, options);
}

/** Paginated WS3-facing view. Legacy completions remain visible as unverified context. */
export async function readPrLifecycleHistoryPage(client: ReviewLifecycleQueryable, identity: ReviewPrLifecycleIdentity,
  options: { offset?: number; limit?: number } = {}) {
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 250) {
    throw new Error('Invalid lifecycle history page bounds');
  }
  const lifecycle = (await client.query(`SELECT * FROM review_pr_lifecycles
    WHERE repository_id = $1 AND pr_number = $2`, [identity.repositoryId, identity.prNumber])).rows[0];
  if (lifecycle && (lifecycle.owner !== identity.owner || lifecycle.repo !== identity.repo)) {
    throw new Error('Pull request lifecycle identity conflicts with its repository binding');
  }
  const [reservations, events, findings, legacyContext] = await Promise.all([
    lifecycle ? client.query(`SELECT * FROM review_pr_review_reservations WHERE lifecycle_id = $1
      ORDER BY created_at, execution_attempt LIMIT $2 OFFSET $3`, [lifecycle.lifecycle_id, limit + 1, offset])
      : Promise.resolve({ rows: [] }),
    lifecycle ? client.query(`SELECT * FROM review_pr_lifecycle_events WHERE lifecycle_id = $1
      ORDER BY created_at, event_id LIMIT $2 OFFSET $3`, [lifecycle.lifecycle_id, limit + 1, offset])
      : Promise.resolve({ rows: [] }),
    lifecycle ? client.query(`SELECT * FROM review_semantic_finding_events WHERE lifecycle_id = $1
      ORDER BY created_at, finding_event_id LIMIT $2 OFFSET $3`, [lifecycle.lifecycle_id, limit + 1, offset])
      : Promise.resolve({ rows: [] }),
    client.query(`SELECT runs.run_id, runs.head_sha, runs.base_sha, runs.effective_policy_digest,
        runs.effective_config_digest, runs.snapshot_digest, runs.status, runs.attempt,
        completion.execution_attempt, completion.content_digest, completion.payload, completion.created_at
      FROM review_runs runs
      LEFT JOIN review_worker_completions completion ON completion.run_id = runs.run_id
      LEFT JOIN review_pr_review_reservations reservation
        ON reservation.run_id = completion.run_id
       AND reservation.execution_attempt = completion.execution_attempt
      WHERE runs.owner = $1 AND runs.repo = $2 AND runs.pr_number = $3
        AND (runs.repository_id IS NULL OR runs.repository_id = $4)
        AND ((completion.execution_attempt IS NULL AND NOT EXISTS (
               SELECT 1 FROM review_pr_review_reservations current_reservation
                WHERE current_reservation.run_id = runs.run_id))
          OR (completion.execution_attempt IS NOT NULL AND reservation.reservation_id IS NULL))
      ORDER BY runs.created_at, completion.execution_attempt NULLS FIRST
      LIMIT $5 OFFSET $6`, [identity.owner, identity.repo, identity.prNumber, identity.repositoryId, limit + 1, offset]),
  ]);
  const page = (result: QueryResult) => ({ rows: result.rows.slice(0, limit), hasMore: result.rows.length > limit });
  const reservationsPage = page(reservations);
  const eventsPage = page(events);
  const findingsPage = page(findings);
  const legacyPage = page(legacyContext);
  const hasMore = reservationsPage.hasMore || eventsPage.hasMore || findingsPage.hasMore || legacyPage.hasMore;
  if (!lifecycle && legacyPage.rows.length === 0) return null;
  return {
    lifecycle: lifecycle ?? null,
    reservations: reservationsPage.rows,
    events: eventsPage.rows,
    findings: findingsPage.rows,
    legacyContext: legacyPage.rows.map((row) => ({ ...row, historySource: 'legacy_archive', verificationStatus: 'insufficient' as const })),
    offset, limit, hasMore, nextOffset: hasMore ? offset + limit : null,
  };
}
