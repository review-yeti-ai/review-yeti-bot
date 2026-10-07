import { canonicalJson, sha256 } from './reviewCore';
import { GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION } from './groundedEvidenceV2';
import { z } from 'zod';
import type { ReviewPlanningHistoryContext } from './prReviewPlanningContext';
import type { PrLifecycleHistoryEvent, PrLifecycleHistoryFinding, PrLifecycleHistoryLoad } from './prLifecycleHistoryHttp';

export const GROUNDED_FINDING_CONTINUITY_VERSION = 'GroundedFindingContinuity.v1' as const;

export interface GroundedRootCauseIdentity {
  componentId: string;
  behaviorId: string;
  contractId: string;
  failureModeId: string;
}

export interface GroundedCauseAnchor {
  componentPath: string;
  side: 'head' | 'base';
  startLine: number;
  endLine: number;
  citationIds: string[];
  contentDigest: string;
}

export interface GroundedCausalPath {
  relation: 'same-component' | 'dependency-edge' | 'contract-edge' | 'unrelated' | 'unknown';
  candidatePath: string;
  componentPath: string;
  citationIds: string[];
}

export interface GroundedContinuityCandidate {
  currentFingerprint: string;
  candidateSide: 'head' | 'base';
  rootCause: GroundedRootCauseIdentity;
  causeAnchor: GroundedCauseAnchor;
  causalPath: GroundedCausalPath;
  sourceWindowManifestDigest: string;
  currentOutcomeEvidenceDigest: string;
}

export function groundedContinuityCandidateFrom(value: unknown): GroundedContinuityCandidate | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const evidence = row.evidence && typeof row.evidence === 'object' && !Array.isArray(row.evidence)
    ? row.evidence as Record<string, unknown> : row;
  const cause = evidence.rootCause && typeof evidence.rootCause === 'object' && !Array.isArray(evidence.rootCause)
    ? evidence.rootCause as Record<string, unknown> : null;
  const anchor = evidence.causeAnchor && typeof evidence.causeAnchor === 'object' && !Array.isArray(evidence.causeAnchor)
    ? evidence.causeAnchor as Record<string, unknown> : null;
  const causal = evidence.causalPath && typeof evidence.causalPath === 'object' && !Array.isArray(evidence.causalPath)
    ? evidence.causalPath as Record<string, unknown> : null;
  if (typeof row.fingerprint !== 'string' || !/^fp1_[a-f0-9]{24}$/u.test(row.fingerprint)
    || (row.candidateSide !== 'head' && row.candidateSide !== 'base') || !cause || !anchor || !causal
    || typeof evidence.sourceWindowManifestDigest !== 'string' || !digest(evidence.sourceWindowManifestDigest)
    || typeof row.evidenceDigest !== 'string' || !digest(row.evidenceDigest)
    || !['same-component', 'dependency-edge', 'contract-edge', 'unrelated', 'unknown'].includes(String(causal.relation))
    || typeof causal.candidatePath !== 'string' || typeof causal.componentPath !== 'string'
    || !Array.isArray(causal.citationIds) || causal.citationIds.some((id) => typeof id !== 'string')
    || typeof anchor.componentPath !== 'string' || (anchor.side !== 'head' && anchor.side !== 'base')
    || !Number.isSafeInteger(anchor.startLine) || !Number.isSafeInteger(anchor.endLine)
    || !Array.isArray(anchor.citationIds) || anchor.citationIds.length === 0
    || anchor.citationIds.some((id) => typeof id !== 'string' || id.length === 0)
    || typeof anchor.contentDigest !== 'string' || !digest(anchor.contentDigest)
    || ['componentId', 'behaviorId', 'contractId', 'failureModeId'].some((key) => typeof cause[key] !== 'string')) return null;
  return {
    currentFingerprint: row.fingerprint, candidateSide: row.candidateSide,
    rootCause: { componentId: String(cause.componentId), behaviorId: String(cause.behaviorId),
      contractId: String(cause.contractId), failureModeId: String(cause.failureModeId) },
    causeAnchor: { componentPath: anchor.componentPath, side: anchor.side,
      startLine: Number(anchor.startLine), endLine: Number(anchor.endLine),
      citationIds: [...anchor.citationIds] as string[], contentDigest: anchor.contentDigest },
    causalPath: { relation: causal.relation as GroundedCausalPath['relation'], candidatePath: causal.candidatePath,
      componentPath: causal.componentPath, citationIds: [...causal.citationIds] as string[] },
    sourceWindowManifestDigest: evidence.sourceWindowManifestDigest,
    currentOutcomeEvidenceDigest: row.evidenceDigest,
  };
}

export interface GroundedFindingContinuity {
  version: typeof GROUNDED_FINDING_CONTINUITY_VERSION;
  status: 'new' | 'continuous' | 'reopened' | 'unavailable';
  durableFindingId?: string;
  historySnapshotId?: string;
  historyContextDigest?: string;
  sourceEventIds: string[];
  currentFingerprint: string;
  candidateSide: 'head' | 'base';
  rootCause: GroundedRootCauseIdentity;
  causeAnchor: GroundedCauseAnchor;
  sourceWindowManifestDigest: string;
  currentOutcomeEvidenceDigest: string;
  evidenceDigest: string;
  unavailableReason?: string;
}

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const fingerprintSchema = z.string().regex(/^fp1_[a-f0-9]{24}$/u);
const durableFindingIdSchema = z.string().regex(/^lf1_[a-f0-9]{32}$/u);
const rootCauseSchema = z.object({ componentId: z.string().min(1), behaviorId: z.string().min(1),
  contractId: z.string().min(1), failureModeId: z.string().min(1) }).strict();
const causeAnchorSchema = z.object({ componentPath: z.string().min(1), side: z.enum(['head', 'base']),
  startLine: z.number().int().positive().safe(), endLine: z.number().int().positive().safe(),
  citationIds: z.array(z.string().min(1)).min(1).max(64), contentDigest: digestSchema }).strict();
const continuityCommon = {
  version: z.literal(GROUNDED_FINDING_CONTINUITY_VERSION),
  currentFingerprint: fingerprintSchema,
  candidateSide: z.enum(['head', 'base']), rootCause: rootCauseSchema, causeAnchor: causeAnchorSchema,
  sourceWindowManifestDigest: digestSchema, currentOutcomeEvidenceDigest: digestSchema, evidenceDigest: digestSchema,
};
const emptyEventIdsSchema = z.array(z.string().uuid()).length(0);
const nonEmptyEventIdsSchema = z.array(z.string().uuid()).min(1).max(2_000)
  .refine((values) => values.every((value, index) => index === 0 || values[index - 1] < value),
    'source event IDs must be sorted and unique');

/** Strict wire parser shared by publisher and the service lifecycle prevalidator. */
export const groundedFindingContinuitySchema = z.discriminatedUnion('status', [
  z.object({ ...continuityCommon, status: z.literal('new'), historySnapshotId: z.string().uuid(),
    historyContextDigest: digestSchema, sourceEventIds: emptyEventIdsSchema }).strict(),
  z.object({ ...continuityCommon, status: z.enum(['continuous', 'reopened']), durableFindingId: durableFindingIdSchema,
    historySnapshotId: z.string().uuid(), historyContextDigest: digestSchema, sourceEventIds: nonEmptyEventIdsSchema }).strict(),
  z.object({ ...continuityCommon, status: z.literal('unavailable'), sourceEventIds: emptyEventIdsSchema,
    unavailableReason: z.string().min(1).max(500) }).strict(),
]);

function digest(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value); }
function durableId(value: unknown): value is string { return typeof value === 'string' && /^lf1_[a-f0-9]{32}$/u.test(value); }
function sameRootCause(left: GroundedRootCauseIdentity | undefined, right: GroundedRootCauseIdentity): boolean {
  return Boolean(left && left.componentId === right.componentId && left.behaviorId === right.behaviorId
    && left.contractId === right.contractId && left.failureModeId === right.failureModeId);
}

/** Digest of every continuity field except the digest itself. The key is context proof, never identity. */
export function groundedFindingContinuityDigest(receipt: Omit<GroundedFindingContinuity, 'evidenceDigest'>): string {
  return sha256(canonicalJson(receipt));
}

function createUnavailable(candidate: GroundedContinuityCandidate,
  reason: NonNullable<GroundedFindingContinuity['unavailableReason']>): GroundedFindingContinuity {
  const fields = { version: GROUNDED_FINDING_CONTINUITY_VERSION, status: 'unavailable' as const,
    sourceEventIds: [] as string[], currentFingerprint: candidate.currentFingerprint,
    candidateSide: candidate.candidateSide, rootCause: candidate.rootCause, causeAnchor: candidate.causeAnchor,
    sourceWindowManifestDigest: candidate.sourceWindowManifestDigest,
    currentOutcomeEvidenceDigest: candidate.currentOutcomeEvidenceDigest, unavailableReason: reason };
  return { ...fields, evidenceDigest: groundedFindingContinuityDigest(fields) };
}

function eventIdsForFinding(history: PrLifecycleHistoryLoad, findingId: string): string[] {
  return history.events.filter((event) => event.disposition?.findingId === findingId)
    .map((event) => event.eventId).filter((id) => /^[-0-9a-f]{36}$/iu.test(id)).sort();
}

type ReviewContextCoordinates = Pick<PrLifecycleHistoryEvent,
  'runId' | 'executionAttempt' | 'headSha' | 'baseSha' | 'policyDigest' | 'configDigest' | 'contextDigest'>;

function sameReviewContext(left: ReviewContextCoordinates, right: ReviewContextCoordinates): boolean {
  return Boolean(left.runId && left.executionAttempt && left.headSha && left.baseSha
    && left.policyDigest && left.configDigest && left.contextDigest
    && left.runId === right.runId && left.executionAttempt === right.executionAttempt
    && left.headSha === right.headSha && left.baseSha === right.baseSha
    && left.policyDigest === right.policyDigest && left.configDigest === right.configDigest
    && left.contextDigest === right.contextDigest);
}

/**
 * A fixed-run negative semantic row has no current root-cause identity. Retain its event ID only
 * when the service's typed fixed disposition points back to a current-v2 cause row and an exact
 * current-v2 completion plus independent-verification event bind the negative row's ID,
 * fingerprint, status, affected context, and run coordinates. This is audit provenance only; it
 * never supplies a root cause or a durable identity by itself.
 */
export function verifiedFixedVerificationFindingIds(history: PrLifecycleHistoryLoad, findingId: string,
  rootCause: GroundedRootCauseIdentity): string[] {
  if (!durableId(findingId) || history.status !== 'complete' || history.eventOmittedCount > 0
    || history.findingOmittedCount > 0 || history.legacyOmittedCount > 0) return [];

  const currentCauseRows = history.findings.filter((finding) => finding.durableFindingId === findingId
    && finding.groundedEvidenceSemanticsVersion === GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION
    && sameRootCause(finding.rootCause, rootCause));
  const linkedFindingIds = new Set<string>();
  for (const fixedEvent of history.events) {
    const disposition = fixedEvent.disposition;
    if (fixedEvent.eventType !== 'finding.disposition.fixed' || disposition?.kind !== 'fixed'
      || disposition.findingId !== findingId || disposition.provenance.actorType !== 'service'
      || disposition.provenance.source !== 'grounded_verifier'
      || disposition.adjudication.method !== 'independent_grounded_verifier'
      || disposition.adjudication.status !== 'contradicted'
      || disposition.adjudication.changedContextDigest !== disposition.affectedContextDigest
      || fixedEvent.evidenceDigest !== sha256(canonicalJson(disposition))
      || !sameReviewContext(fixedEvent, disposition)) continue;

    const priorCause = currentCauseRows.find((finding) => finding.findingEventId === disposition.adjudication.priorFindingEventId
      && finding.fingerprint === disposition.fingerprint && finding.path === disposition.path);
    if (!priorCause) continue;
    const hasCurrentV2Completion = history.events.some((completion) => completion.eventType === 'review.completion_recorded'
      && completion.evidenceSemanticsVersion === GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION
      && (completion.completionStatus === 'completed' || completion.completionStatus === 'failed')
      && completion.coverageComplete === true && completion.quorumSatisfied === true
      && sameReviewContext(completion, fixedEvent));
    if (!hasCurrentV2Completion) continue;

    const negativeRows = history.findings.filter((finding) => finding.durableFindingId === findingId
      && finding.fingerprint === disposition.fingerprint && finding.path === disposition.path
      && finding.lastSeenHead === disposition.headSha && finding.verificationStatus === 'contradicted'
      && finding.affectedContextDigest === disposition.affectedContextDigest
      && (!finding.groundedEvidenceSemanticsVersion
        || finding.groundedEvidenceSemanticsVersion === GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION)
      && (!finding.rootCause || sameRootCause(finding.rootCause, rootCause)));
    for (const negativeRow of negativeRows) {
      const hasVerificationLink = history.events.some((verification) => verification.eventType === 'finding.independent_verification'
        && verification.verificationStatus === 'contradicted'
        && verification.evidenceDigest === disposition.adjudication.proofDigest
        && verification.verification?.findingEventId === negativeRow.findingEventId
        && verification.verification.fingerprint === negativeRow.fingerprint
        && verification.verification.status === 'contradicted'
        && verification.runId === fixedEvent.runId && verification.executionAttempt === fixedEvent.executionAttempt
        && verification.headSha === fixedEvent.headSha
        && (verification.baseSha === undefined || verification.baseSha === fixedEvent.baseSha)
        && (verification.policyDigest === undefined || verification.policyDigest === fixedEvent.policyDigest)
        && (verification.configDigest === undefined || verification.configDigest === fixedEvent.configDigest)
        && (verification.verification.currentAffectedContextDigest !== undefined
          || verification.verification.sourceAffectedContextDigest !== undefined
          ? verification.verification.currentAffectedContextDigest === negativeRow.affectedContextDigest
            && verification.verification.sourceAffectedContextDigest === priorCause.affectedContextDigest
            && sameReviewContext(verification, fixedEvent)
          : verification.contextDigest === negativeRow.affectedContextDigest));
      if (hasVerificationLink) linkedFindingIds.add(negativeRow.findingEventId);
    }
  }
  return [...linkedFindingIds].sort();
}

function priorCauseRows(history: ReviewPlanningHistoryContext, candidate: GroundedContinuityCandidate,
  continuityFindings?: readonly PrLifecycleHistoryFinding[]): ReviewPlanningHistoryContext['priorFindings'] {
  const rows: readonly ReviewPlanningHistoryContext['priorFindings'][number][] = continuityFindings ?? history.priorFindings;
  return rows.filter((finding) => finding.groundedEvidenceSemanticsVersion === GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION
    && durableId(finding.durableFindingId)
    && sameRootCause(finding.rootCause, candidate.rootCause));
}

/**
 * Resolves a current, independently verified cause to one durable finding only when the exact
 * lifecycle snapshot is complete, its grounded semantics match, ancestry is established, and
 * source/caller evidence supplies a positive causal relation. It never compares or persists the
 * per-review rootCauseEvidenceKey as a durable ID.
 */
export function resolveGroundedFindingContinuity(input: {
  candidate: GroundedContinuityCandidate;
  currentCandidates?: readonly GroundedContinuityCandidate[];
  history: PrLifecycleHistoryLoad;
  planningHistory: ReviewPlanningHistoryContext;
  /** Complete captured cause rows used for identity continuity; planner prompt rows are deliberately pruned. */
  continuityFindings?: readonly PrLifecycleHistoryFinding[];
  priorAncestryVerified: boolean;
}): GroundedFindingContinuity {
  const { candidate, history, planningHistory } = input;
  if (!history.snapshotId || !history.contextDigest || history.status !== 'complete'
    || history.eventOmittedCount > 0 || history.findingOmittedCount > 0 || history.legacyOmittedCount > 0) {
    return createUnavailable(candidate, 'history-unavailable');
  }
  if (!digest(candidate.sourceWindowManifestDigest) || !digest(candidate.currentOutcomeEvidenceDigest)
    || !digest(candidate.causeAnchor.contentDigest)
    || candidate.causeAnchor.side !== candidate.candidateSide
    || !Number.isSafeInteger(candidate.causeAnchor.startLine) || candidate.causeAnchor.startLine < 1
    || !Number.isSafeInteger(candidate.causeAnchor.endLine) || candidate.causeAnchor.endLine < candidate.causeAnchor.startLine
    || !candidate.rootCause.componentId || !candidate.rootCause.behaviorId
    || !candidate.rootCause.contractId || !candidate.rootCause.failureModeId) {
    return createUnavailable(candidate, 'claim-unmatched');
  }
  const matchingRows = priorCauseRows(planningHistory, candidate, input.continuityFindings);
  const durableIds = [...new Set(matchingRows.map((row) => row.durableFindingId!).filter(durableId))];
  if (durableIds.length === 0) {
    const fields = { version: GROUNDED_FINDING_CONTINUITY_VERSION, status: 'new' as const,
      historySnapshotId: history.snapshotId, historyContextDigest: history.contextDigest,
      sourceEventIds: [] as string[], currentFingerprint: candidate.currentFingerprint,
      candidateSide: candidate.candidateSide, rootCause: candidate.rootCause, causeAnchor: candidate.causeAnchor,
      sourceWindowManifestDigest: candidate.sourceWindowManifestDigest,
      currentOutcomeEvidenceDigest: candidate.currentOutcomeEvidenceDigest };
    return { ...fields, evidenceDigest: groundedFindingContinuityDigest(fields) };
  }
  if (!planningHistory.evidenceSemanticsCompatibility.compatibleForContinuity
    || planningHistory.evidenceSemanticsCompatibility.expectedVersion !== GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION) {
    return createUnavailable(candidate, 'stale-context');
  }
  if (durableIds.length !== 1) return createUnavailable(candidate, 'ambiguous-match');
  if (!input.priorAncestryVerified) return createUnavailable(candidate, 'stale-context');
  const related = candidate.causalPath.relation === 'same-component' || candidate.causalPath.relation === 'dependency-edge'
    || candidate.causalPath.relation === 'contract-edge';
  if (!related || candidate.causalPath.citationIds.length === 0) return createUnavailable(candidate, 'claim-unmatched');
  const findingId = durableIds[0]!;
  const sameComponentRows = matchingRows.filter((row) => row.causeAnchor?.componentPath === candidate.causeAnchor.componentPath);
  const currentSameComponentCandidates = (input.currentCandidates ?? [candidate]).filter((other) =>
    sameRootCause(other.rootCause, candidate.rootCause) && other.candidateSide === candidate.candidateSide
      && other.causeAnchor.componentPath === candidate.causeAnchor.componentPath);
  if (currentSameComponentCandidates.length > 1) return createUnavailable(candidate, 'ambiguous-match');
  const sameComponentUnique = sameComponentRows.some((row) => row.durableFindingId === findingId)
    && currentSameComponentCandidates.length === 1;
  if (!sameComponentUnique && candidate.causalPath.relation === 'same-component') {
    return createUnavailable(candidate, 'claim-unmatched');
  }
  const sourceEvents = [...new Set([
    ...matchingRows.filter((row) => row.durableFindingId === findingId
      && sameRootCause(row.rootCause, candidate.rootCause)).map((row) => row.findingEventId),
    ...eventIdsForFinding(history, findingId),
    ...verifiedFixedVerificationFindingIds(history, findingId, candidate.rootCause),
  ])].sort();
  if (sourceEvents.length === 0) return createUnavailable(candidate, 'claim-unmatched');
  const reopened = history.events.some((event) => event.disposition?.findingId === findingId
    && (event.disposition.kind === 'fixed' || event.disposition.kind === 'adjudicated_false_positive'));
  const fields = { version: GROUNDED_FINDING_CONTINUITY_VERSION, status: reopened ? 'reopened' as const : 'continuous' as const,
    durableFindingId: findingId, historySnapshotId: history.snapshotId, historyContextDigest: history.contextDigest,
    sourceEventIds: sourceEvents, currentFingerprint: candidate.currentFingerprint, candidateSide: candidate.candidateSide,
    rootCause: candidate.rootCause, causeAnchor: candidate.causeAnchor,
    sourceWindowManifestDigest: candidate.sourceWindowManifestDigest,
    currentOutcomeEvidenceDigest: candidate.currentOutcomeEvidenceDigest };
  return { ...fields, evidenceDigest: groundedFindingContinuityDigest(fields) };
}

/** Revalidates a receipt against the admitted current candidate and exact captured history. */
export function continuityReceiptMatchesCurrent(input: {
  receipt: GroundedFindingContinuity;
  candidate: GroundedContinuityCandidate;
  history: PrLifecycleHistoryLoad;
}): boolean {
  const { receipt, candidate, history } = input;
  const { evidenceDigest, ...unsigned } = receipt;
  if (groundedFindingContinuityDigest(unsigned) !== evidenceDigest
    || receipt.currentFingerprint !== candidate.currentFingerprint || receipt.candidateSide !== candidate.candidateSide
    || !sameRootCause(receipt.rootCause, candidate.rootCause)
    || canonicalJson(receipt.causeAnchor) !== canonicalJson(candidate.causeAnchor)
    || receipt.sourceWindowManifestDigest !== candidate.sourceWindowManifestDigest
    || receipt.currentOutcomeEvidenceDigest !== candidate.currentOutcomeEvidenceDigest) return false;
  if (receipt.status === 'unavailable') return !receipt.durableFindingId && !receipt.historySnapshotId
    && !receipt.historyContextDigest && receipt.sourceEventIds.length === 0 && Boolean(receipt.unavailableReason);
  if (!receipt.historySnapshotId || receipt.historySnapshotId !== history.snapshotId
    || receipt.historyContextDigest !== history.contextDigest) return false;
  if (receipt.status === 'new') return !receipt.durableFindingId && receipt.sourceEventIds.length === 0 && !receipt.unavailableReason;
  return durableId(receipt.durableFindingId) && receipt.sourceEventIds.length > 0 && !receipt.unavailableReason
    && receipt.sourceEventIds.every((id) => history.findings.some((finding) => finding.findingEventId === id)
      || history.events.some((event) => event.eventId === id && event.disposition?.findingId === receipt.durableFindingId));
}
