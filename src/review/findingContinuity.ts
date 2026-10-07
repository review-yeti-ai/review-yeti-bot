import { canonicalJson, sha256 } from './reviewCore';
import { GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION } from './groundedEvidenceV2';
import type { GroundedOriginAncestryV1 } from './workerReviewCompletion';
import { z } from 'zod';
import type { ReviewPlanningHistoryContext } from './prReviewPlanningContext';
import type { PrLifecycleHistoryEvent, PrLifecycleHistoryFinding, PrLifecycleHistoryLoad } from './prLifecycleHistoryHttp';

export type { GroundedOriginAncestryV1 } from './workerReviewCompletion';
export const GROUNDED_FINDING_CONTINUITY_VERSION = 'GroundedFindingContinuity.v1' as const;
export const GROUNDED_ORIGIN_ANCESTRY_VERSION = 'GroundedOriginAncestry.v1' as const;

export type GroundedContinuityOriginRef = Pick<GroundedOriginAncestryV1,
  'sourceEventId' | 'sourceKind' | 'priorRunId' | 'priorHeadSha' | 'currentHeadSha'>;
export type GroundedOriginAncestryRequestsByFingerprint = Readonly<Record<string, readonly GroundedContinuityOriginRef[]>>;

export const MAX_GROUNDED_ORIGIN_ANCESTRY_COMPARISONS = 100;

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
  verifiedOriginAncestry?: GroundedOriginAncestryV1[];
  evidenceDigest: string;
  unavailableReason?: string;
}

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const fingerprintSchema = z.string().regex(/^fp1_[a-f0-9]{24}$/u);
const durableFindingIdSchema = z.string().regex(/^lf1_[a-f0-9]{32}$/u);
const runIdSchema = z.string().regex(/^run_[a-f0-9]{32}$/u);
const shaSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const groundedOriginAncestrySchema = z.object({
  version: z.literal(GROUNDED_ORIGIN_ANCESTRY_VERSION),
  sourceEventId: z.string().uuid(), sourceKind: z.enum(['cause', 'repair']),
  priorRunId: runIdSchema, priorHeadSha: shaSchema, currentHeadSha: shaSchema,
  result: z.enum(['ancestor', 'not-ancestor', 'unavailable']), comparisonDigest: digestSchema,
}).strict();
const groundedOriginAncestriesSchema = z.array(groundedOriginAncestrySchema).max(2)
  .refine((values) => values.every((value, index) => index === 0
    || `${values[index - 1]!.sourceKind}:${values[index - 1]!.sourceEventId}`
      < `${value.sourceKind}:${value.sourceEventId}`), 'origin ancestry must be sorted and unique');
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
  verifiedOriginAncestry: groundedOriginAncestriesSchema.optional(),
};
const emptyEventIdsSchema = z.array(z.string().uuid()).length(0);
const nonEmptyEventIdsSchema = z.array(z.string().uuid()).min(1).max(2)
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
]).superRefine((receipt, context) => {
  const origins = receipt.verifiedOriginAncestry;
  if (receipt.status === 'new' || receipt.status === 'unavailable') {
    if (origins !== undefined) context.addIssue({ code: z.ZodIssueCode.custom,
      path: ['verifiedOriginAncestry'], message: 'unmatched continuity cannot carry source origins' });
    return;
  }
  const expectedKinds = receipt.status === 'continuous' ? ['cause'] : ['cause', 'repair'];
  if (!origins || origins.length !== expectedKinds.length
    || origins.some((origin, index) => origin.sourceKind !== expectedKinds[index] || origin.result !== 'ancestor')
    || canonicalJson(receipt.sourceEventIds) !== canonicalJson(origins.map((origin) => origin.sourceEventId).sort())) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['verifiedOriginAncestry'],
      message: 'matched continuity requires exact cause and repair origin ancestry' });
  }
});

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
export interface VerifiedRepairVerificationLink {
  causeFindingEventId: string;
  repairEventId: string;
  negativeFindingEventId: string;
}

export function verifiedRepairVerificationLinks(history: PrLifecycleHistoryLoad, findingId: string,
  rootCause: GroundedRootCauseIdentity): VerifiedRepairVerificationLink[] {
  if (!durableId(findingId) || history.status !== 'complete' || history.eventOmittedCount > 0
    || history.findingOmittedCount > 0 || history.legacyOmittedCount > 0) return [];

  const currentCauseRows = history.findings.filter((finding) => finding.durableFindingId === findingId
    && finding.groundedEvidenceSemanticsVersion === GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION
    && sameRootCause(finding.rootCause, rootCause));
  const linked = new Map<string, VerifiedRepairVerificationLink>();
  for (const repairEvent of history.events) {
    const disposition = repairEvent.disposition;
    if ((disposition?.kind !== 'fixed' && disposition?.kind !== 'adjudicated_false_positive')
      || disposition.findingId !== findingId || disposition.provenance.actorType !== 'service'
      || disposition.provenance.source !== 'grounded_verifier'
      || disposition.adjudication.method !== 'independent_grounded_verifier'
      || disposition.adjudication.status !== 'contradicted'
      || disposition.kind === 'fixed' && disposition.adjudication.changedContextDigest !== disposition.affectedContextDigest
      || repairEvent.eventType !== `finding.disposition.${disposition.kind}`
      || repairEvent.evidenceDigest !== sha256(canonicalJson(disposition))
      || !sameReviewContext(repairEvent, disposition)) continue;

    const causeRows = currentCauseRows.filter((finding) => finding.fingerprint === disposition.fingerprint
      && finding.path === disposition.path && finding.durableFindingId === findingId);
    const priorCause = disposition.kind === 'fixed'
      ? causeRows.find((finding) => finding.findingEventId === disposition.adjudication.priorFindingEventId)
      : causeRows.length === 1 ? causeRows[0] : undefined;
    if (!priorCause) continue;
    const hasCurrentV2Completion = history.events.some((completion) => completion.eventType === 'review.completion_recorded'
      && completion.evidenceSemanticsVersion === GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION
      && (completion.completionStatus === 'completed' || completion.completionStatus === 'failed')
      && completion.coverageComplete === true && completion.quorumSatisfied === true
      && sameReviewContext(completion, repairEvent));
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
        && verification.runId === repairEvent.runId && verification.executionAttempt === repairEvent.executionAttempt
        && verification.headSha === repairEvent.headSha
        && (verification.baseSha === undefined || verification.baseSha === repairEvent.baseSha)
        && (verification.policyDigest === undefined || verification.policyDigest === repairEvent.policyDigest)
        && (verification.configDigest === undefined || verification.configDigest === repairEvent.configDigest)
        && (verification.verification.currentAffectedContextDigest !== undefined
          || verification.verification.sourceAffectedContextDigest !== undefined
          ? verification.verification.currentAffectedContextDigest === negativeRow.affectedContextDigest
            && verification.verification.sourceAffectedContextDigest === priorCause.affectedContextDigest
            && sameReviewContext(verification, repairEvent)
          : verification.contextDigest === negativeRow.affectedContextDigest));
      if (hasVerificationLink) linked.set(repairEvent.eventId, { causeFindingEventId: priorCause.findingEventId,
        repairEventId: repairEvent.eventId, negativeFindingEventId: negativeRow.findingEventId });
    }
  }
  return [...linked.values()].sort((left, right) => left.repairEventId.localeCompare(right.repairEventId));
}

export function verifiedFixedVerificationFindingIds(history: PrLifecycleHistoryLoad, findingId: string,
  rootCause: GroundedRootCauseIdentity): string[] {
  return [...new Set(verifiedRepairVerificationLinks(history, findingId, rootCause)
    .map((link) => link.negativeFindingEventId))].sort();
}

function priorCauseRows(history: PrLifecycleHistoryLoad, candidate: GroundedContinuityCandidate,
  continuityFindings?: readonly PrLifecycleHistoryFinding[]): PrLifecycleHistoryFinding[] {
  const rows = continuityFindings ?? history.findings;
  return rows.filter((finding) => finding.groundedEvidenceSemanticsVersion === GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION
    && durableId(finding.durableFindingId)
    && sameRootCause(finding.rootCause, candidate.rootCause));
}

function causeOriginRef(history: PrLifecycleHistoryLoad, finding: PrLifecycleHistoryFinding,
  currentHeadSha: string): GroundedContinuityOriginRef | null {
  if (finding.verificationStatus !== 'confirmed') return null;
  const verificationEvents = history.events.filter((event) => event.eventType === 'finding.independent_verification'
    && event.verificationStatus === finding.verificationStatus
    && event.verification?.findingEventId === finding.findingEventId
    && event.verification.fingerprint === finding.fingerprint
    && event.verification.status === finding.verificationStatus
    && event.verification.currentAffectedContextDigest === undefined
    && event.verification.sourceAffectedContextDigest === undefined
    && event.contextDigest === finding.affectedContextDigest
    && event.headSha === finding.lastSeenHead
    && event.runId && runIdSchema.safeParse(event.runId).success
    && Number.isSafeInteger(event.executionAttempt) && event.executionAttempt! > 0
    && digest(event.evidenceDigest));
  const origins = [...new Map(verificationEvents.map((event) => [
    `${event.runId}\u0000${event.headSha}`,
    { sourceEventId: finding.findingEventId, sourceKind: 'cause' as const,
      priorRunId: event.runId!, priorHeadSha: event.headSha!, currentHeadSha },
  ])).values()];
  if (origins.length !== 1 || !uuidSchema.safeParse(finding.findingEventId).success
    || !shaSchema.safeParse(finding.lastSeenHead).success || !shaSchema.safeParse(currentHeadSha).success) return null;
  const origin = origins[0]!;
  const qualifiedCompletion = history.events.some((event) => event.eventType === 'review.completion_recorded'
    && event.evidenceSemanticsVersion === GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION
    && (event.completionStatus === 'completed' || event.completionStatus === 'failed')
    && event.coverageComplete === true && event.quorumSatisfied === true
    && event.runId === origin.priorRunId && event.headSha === origin.priorHeadSha
    && event.executionAttempt === verificationEvents[0]!.executionAttempt);
  return qualifiedCompletion ? origin : null;
}

const uuidSchema = z.string().uuid();

function trustedRepairEvent(history: PrLifecycleHistoryLoad, findingId: string,
  rootCause: GroundedRootCauseIdentity): PrLifecycleHistoryEvent | undefined {
  const verifiedIds = new Set(verifiedRepairVerificationLinks(history, findingId, rootCause)
    .map((link) => link.repairEventId));
  return history.events.find((event) => verifiedIds.has(event.eventId));
}

/**
 * Selects the exact cause and repair origins used by a continuity claim. History pages preserve
 * the snapshot's newest-first ID order, so the first eligible repair/cause row is deterministic.
 * A fixed disposition must point to the selected cause row; false-positive adjudication must bind
 * the same original fingerprint and path. The output is bounded to two source heads per finding.
 */
export function groundedContinuityOriginRefs(input: {
  candidate: GroundedContinuityCandidate;
  history: PrLifecycleHistoryLoad;
  currentHeadSha: string;
  continuityFindings?: readonly PrLifecycleHistoryFinding[];
}): GroundedContinuityOriginRef[] | null {
  const currentHeadSha = input.currentHeadSha;
  if (!shaSchema.safeParse(currentHeadSha).success || input.history.status !== 'complete'
    || input.history.eventOmittedCount > 0 || input.history.findingOmittedCount > 0
    || input.history.legacyOmittedCount > 0) return null;
  const matches = priorCauseRows(input.history, input.candidate, input.continuityFindings);
  const durableIds = [...new Set(matches.map((row) => row.durableFindingId!).filter(durableId))];
  if (durableIds.length === 0) return [];
  if (durableIds.length !== 1) return null;
  const findingId = durableIds[0]!;
  const repair = trustedRepairEvent(input.history, findingId, input.candidate.rootCause);
  let cause: typeof matches[number] | undefined;
  const repairDisposition = repair?.disposition;
  if (repairDisposition?.kind === 'fixed') {
    cause = matches.find((row) => row.durableFindingId === findingId
      && row.findingEventId === repairDisposition.adjudication.priorFindingEventId
      && row.fingerprint === repairDisposition.fingerprint && row.path === repairDisposition.path
      && sameRootCause(row.rootCause, input.candidate.rootCause));
  } else if (repairDisposition?.kind === 'adjudicated_false_positive') {
    const linked = matches.filter((row) => row.durableFindingId === findingId
      && row.fingerprint === repairDisposition.fingerprint && row.path === repairDisposition.path
      && sameRootCause(row.rootCause, input.candidate.rootCause));
    if (linked.length !== 1) return null;
    cause = linked[0];
  } else {
    cause = matches.find((row) => row.durableFindingId === findingId
      && sameRootCause(row.rootCause, input.candidate.rootCause));
  }
  if (!cause) return null;
  if (input.candidate.causalPath.relation === 'same-component'
    && cause.causeAnchor?.componentPath !== input.candidate.causeAnchor.componentPath) return null;
  const causeOrigin = causeOriginRef(input.history, cause, currentHeadSha);
  if (!causeOrigin) return null;
  const origins = [causeOrigin];
  if (repair) {
    if (!repair.runId || !runIdSchema.safeParse(repair.runId).success
      || !repair.headSha || !shaSchema.safeParse(repair.headSha).success
      || !uuidSchema.safeParse(repair.eventId).success) return null;
    origins.push({ sourceEventId: repair.eventId, sourceKind: 'repair', priorRunId: repair.runId,
      priorHeadSha: repair.headSha, currentHeadSha });
  }
  return origins.sort((left, right) => left.sourceKind < right.sourceKind ? -1
    : left.sourceKind > right.sourceKind ? 1 : left.sourceEventId.localeCompare(right.sourceEventId));
}

/** Cause-only lineage for a currently contradicted outcome that may support a fixed transition. */
export function groundedFixedOriginRefs(input: {
  fingerprint: string;
  path: string;
  currentHeadSha: string;
  history: PrLifecycleHistoryLoad;
  continuityFindings?: readonly PrLifecycleHistoryFinding[];
}): GroundedContinuityOriginRef[] | null {
  if (!/^fp1_[a-f0-9]{24}$/u.test(input.fingerprint) || !shaSchema.safeParse(input.currentHeadSha).success
    || input.history.status !== 'complete' || input.history.eventOmittedCount > 0
    || input.history.findingOmittedCount > 0 || input.history.legacyOmittedCount > 0) return null;
  const rows = (input.continuityFindings ?? input.history.findings).filter((finding) =>
    finding.groundedEvidenceSemanticsVersion === GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION
      && finding.fingerprint === input.fingerprint && finding.path === input.path
      && finding.verificationStatus === 'confirmed' && durableId(finding.durableFindingId)
      && finding.rootCause !== undefined);
  const durableIds = [...new Set(rows.map((row) => row.durableFindingId!))];
  if (durableIds.length !== 1) return null;
  const causeRows = rows.filter((row) => row.durableFindingId === durableIds[0]);
  if (causeRows.length === 0) return null;
  const causeOrigin = causeOriginRef(input.history, causeRows[0]!, input.currentHeadSha);
  return causeOrigin ? [causeOrigin] : null;
}

/**
 * Snapshot/page order is newest-first. Select its newest completion only when that same record is
 * current-v2 and has complete source coverage/quorum; never fall back to an older run when the
 * newest record is ineligible. Failed reviews with complete coverage remain repair context.
 */
export function selectNewestEligibleGroundedCompletion(events: readonly PrLifecycleHistoryEvent[]):
  PrLifecycleHistoryEvent | undefined {
  const latest = events.find((event) => event.eventType === 'review.completion_recorded');
  if (!latest || latest.evidenceSemanticsVersion !== GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION
    || (latest.completionStatus !== 'completed' && latest.completionStatus !== 'failed')
    || latest.coverageComplete !== true || latest.quorumSatisfied !== true
    || !latest.runId || !runIdSchema.safeParse(latest.runId).success
    || !latest.headSha || !shaSchema.safeParse(latest.headSha).success) return undefined;
  return latest;
}

/** Canonical digest and result reducer shared by the worker origin reader and authoritative source reader. */
export function groundedOriginAncestryFromComparison(input: GroundedContinuityOriginRef,
  comparison: { status: 'ahead' | 'behind' | 'diverged' | 'identical'; files: readonly unknown[] } | null,
  unavailableReason?: string): GroundedOriginAncestryV1 {
  const result: GroundedOriginAncestryV1['result'] = comparison && comparison.files.length < 300
    ? comparison.status === 'ahead' || comparison.status === 'identical' ? 'ancestor' : 'not-ancestor'
    : 'unavailable';
  const fields = { ...input, version: GROUNDED_ORIGIN_ANCESTRY_VERSION, result };
  return { ...fields, comparisonDigest: sha256(canonicalJson({ ...fields, comparison,
    ...(unavailableReason ? { unavailableReason } : {}) })) };
}

/** Exact source/service origin join required before a durable identity may be reused. */
export function groundedOriginAncestryJoin(input: {
  expected: readonly GroundedContinuityOriginRef[];
  proofs: readonly GroundedOriginAncestryV1[] | undefined;
  currentHeadSha: string;
}): GroundedOriginAncestryV1[] | null {
  const proofs = input.proofs;
  if (!proofs || proofs.length !== input.expected.length || proofs.length === 0) return null;
  const parsedProofs: GroundedOriginAncestryV1[] = [];
  for (const proof of proofs) {
    const parsed = groundedOriginAncestrySchema.safeParse(proof);
    if (!parsed.success) return null;
    parsedProofs.push(parsed.data);
  }
  const normalized = parsedProofs.sort((left, right) => left.sourceKind < right.sourceKind ? -1
    : left.sourceKind > right.sourceKind ? 1 : left.sourceEventId.localeCompare(right.sourceEventId));
  const expected = [...input.expected].sort((left, right) => left.sourceKind < right.sourceKind ? -1
    : left.sourceKind > right.sourceKind ? 1 : left.sourceEventId.localeCompare(right.sourceEventId));
  if (!normalized.every((proof, index) => proof.result === 'ancestor'
    && proof.currentHeadSha === input.currentHeadSha
    && canonicalJson({ sourceEventId: proof.sourceEventId, sourceKind: proof.sourceKind,
      priorRunId: proof.priorRunId, priorHeadSha: proof.priorHeadSha, currentHeadSha: proof.currentHeadSha })
      === canonicalJson(expected[index]))) return null;
  return normalized;
}

export function groundedOriginAncestryMatches(input: {
  expected: readonly GroundedContinuityOriginRef[];
  proofs: readonly GroundedOriginAncestryV1[] | undefined;
  currentHeadSha: string;
}): boolean {
  return groundedOriginAncestryJoin(input) !== null;
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
  /** Per-origin comparisons; the generic latest-review boolean cannot grant durable identity. */
  verifiedOriginAncestry?: readonly GroundedOriginAncestryV1[];
  /** Legacy diagnostic only. It is deliberately not an identity authority. */
  priorAncestryVerified?: boolean;
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
  const matchingRows = priorCauseRows(history, candidate, input.continuityFindings);
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
    || planningHistory.evidenceSemanticsCompatibility.expectedVersion !== GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION
    || planningHistory.evidenceSemanticsCompatibility.sourcePolicyConfigCompatible !== true) {
    return createUnavailable(candidate, 'stale-context');
  }
  if (durableIds.length !== 1) return createUnavailable(candidate, 'ambiguous-match');
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
  const origins = groundedContinuityOriginRefs({ candidate, history, currentHeadSha: planningHistory.expectedHeadSha,
    continuityFindings: input.continuityFindings });
  if (!origins || origins.length === 0 || origins.some((origin) => origin.sourceKind === 'cause'
    && !matchingRows.some((row) => row.durableFindingId === findingId
      && row.findingEventId === origin.sourceEventId && sameRootCause(row.rootCause, candidate.rootCause)))) {
    return createUnavailable(candidate, 'claim-unmatched');
  }
  const verifiedOriginAncestry = input.verifiedOriginAncestry;
  if (!groundedOriginAncestryMatches({ expected: origins, proofs: verifiedOriginAncestry,
    currentHeadSha: planningHistory.expectedHeadSha })) return createUnavailable(candidate, 'stale-context');
  const sourceEvents = origins.map((origin) => origin.sourceEventId).sort();
  const reopened = origins.some((origin) => origin.sourceKind === 'repair');
  const fields = { version: GROUNDED_FINDING_CONTINUITY_VERSION, status: reopened ? 'reopened' as const : 'continuous' as const,
    durableFindingId: findingId, historySnapshotId: history.snapshotId, historyContextDigest: history.contextDigest,
    sourceEventIds: sourceEvents, currentFingerprint: candidate.currentFingerprint, candidateSide: candidate.candidateSide,
    rootCause: candidate.rootCause, causeAnchor: candidate.causeAnchor,
    sourceWindowManifestDigest: candidate.sourceWindowManifestDigest,
    currentOutcomeEvidenceDigest: candidate.currentOutcomeEvidenceDigest,
    verifiedOriginAncestry: [...verifiedOriginAncestry!] };
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
  const origins = receipt.verifiedOriginAncestry;
  const expectedKinds = receipt.status === 'continuous' ? ['cause'] : ['cause', 'repair'];
  return durableId(receipt.durableFindingId) && receipt.sourceEventIds.length > 0 && !receipt.unavailableReason
    && Boolean(origins && origins.length === expectedKinds.length
      && origins.every((origin, index) => origin.sourceKind === expectedKinds[index] && origin.result === 'ancestor')
      && canonicalJson(receipt.sourceEventIds) === canonicalJson(origins.map((origin) => origin.sourceEventId).sort()))
    && receipt.sourceEventIds.every((id) => history.findings.some((finding) => finding.findingEventId === id)
      || history.events.some((event) => event.eventId === id && event.disposition?.findingId === receipt.durableFindingId));
}
