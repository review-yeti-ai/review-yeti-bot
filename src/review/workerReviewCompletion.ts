import { z } from 'zod';
import { taskSourceReceiptSchema, validateTaskSourceReceipt } from './taskSourceDelivery';
import { evaluateFindingConvergence, findingClaimType, findingFingerprint, findingFingerprintForClaimType,
  type PriorFindingThread } from './findingConvergence';
import { DELETION_CLASSIFICATION_VERSION } from './deletionClassification';
import { computeAppVerdict } from './reviewAdapters';
import type { CanonicalArbitration, ReviewChangedFile, ReviewFinding, ReviewLane } from './reviewCore';
import { canonicalJson, changedLineNumbers, publishFinding, sha256, validateReviewFindings } from './reviewCore';
import { deletedLineNumbers } from './changedFiles';
import { createReviewDecisionV2, reviewDecisionV2Schema, REVIEW_SEVERITY_POLICY_V2,
  type ReviewDecisionV2 } from './reviewDecision';
import type { ReviewGateDecision, ReviewGateEvidence } from './reviewGatePolicy';
import { workerFailureClasses, workerFailureDiagnosticsSchema } from './workerCompletion';
import { isNoReviewableContentFile } from './reviewableContent';
import { MAX_CHANGED_FILES, MAX_CHANGED_FILE_PATCH_BYTES, MAX_PATH_CHARACTERS } from './reviewEvidenceLimits';
import { incrementalReviewClaimSchema } from './incrementalReviewClaim';
import { verdictCacheClaimSchema } from './verdictCacheClaim';
import { incompleteP2RecoveryClaimSchema } from './incompleteP2RecoveryClaim';
import { EMPTY_MODERATION_SKIPPED, decideEmptyModeration } from './emptyModeration';
import { isInfrastructureIncompleteResult } from './laneInfrastructure';
import { getMetrics } from '../telemetry';
import { logger } from '../utils/logger';
import { composedRuntimeResourcesSchema, type ComposedRuntimeResources } from '../panel/composedResourceReceipt';
import { MAX_TASKS_HARD_CAP, MAX_TASK_TEXT_LENGTH, TASK_DIMENSIONS, TASK_ID_PATTERN, validateTaskPlan, type ReviewTask } from '../reviewTaskContract';
import { buildDeterministicCoverageManifest, groundedAffectedContextDigest,
  GROUNDED_VERIFICATION_LEGACY_VERSION, GROUNDED_VERIFICATION_VERSION,
  type AuthenticatedDisputedBlockerV1, type GroundedVerifiedEvidenceV2 } from './groundedReviewEngine';
import { groundedCitationManifestDigest, isValidGroundedCitationV2, isValidGroundedSourceWindowV1,
  GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION, GROUNDED_REVIEW_RECEIPT_V2_VERSION,
  GROUNDED_VERIFICATION_V2_VERSION, sha256Bytes, type GroundedCitationV2, type GroundedDependencyEdgeV1,
  type GroundedImportResolutionSourceV1 } from './groundedEvidenceV2';
import { groundedCandidateHunkProof, groundedPatchRegionDigest } from './groundedSourceWindows';
import { groundedRelativeImportCandidates } from './groundedContractResolver';
import { classifyFindingChangeScope, findingChangeScopeProofDigest, FINDING_CHANGE_SCOPE_PROOF_VERSION,
  FINDING_CHANGE_SCOPE_VERSION, FINDING_ROOT_CAUSE_IDENTITY_VERSION, type FindingChangeScopeDecision,
  type FindingChangeScopeProofV1 } from './findingChangeScope';
import { groundedVerifierRouteV1Schema, type GroundedVerifierRouteV1 } from './groundedVerifierRoute';

export { MAX_CHANGED_FILES, MAX_CHANGED_FILE_PATCH_BYTES, MAX_PATH_CHARACTERS } from './reviewEvidenceLimits';

/**
 * The success callback is deliberately smaller than the worker's operational receipt. It carries
 * the persona evidence needed for the service to re-run the existing canonical arbitration, while
 * excluding anything that could select or complete a GitHub check. A failed result may add only the
 * same bounded diagnostic contract used by the terminal-failure callback; the service redacts it again.
 */
export const WORKER_REVIEW_COMPLETION_VERSION = 'WorkerReviewCompletion.v1' as const;
export const WORKER_REVIEW_RESULT_VERSION = 'WorkerReviewResult.v1' as const;

/** The outer JSON document is bounded by UTF-8 bytes; string limits are JavaScript UTF-16 code units. */
export const MAX_COMPLETION_BYTES = 1_000_000;
export const MAX_PERSONAS = 64;
export const MAX_FINDINGS_PER_PERSONA = 400;
export const MAX_TOTAL_FINDINGS = MAX_PERSONAS * MAX_FINDINGS_PER_PERSONA;
export const MAX_TEXT_CHARACTERS = 16_000;
export const MAX_TITLE_CHARACTERS = 4_000;
export const MAX_CODE_CHARACTERS = 10_000;

const sha = z.string().regex(/^[a-f0-9]{40}$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const positiveInteger = z.number().int().positive().safe();
const boundedInteger = z.number().int().nonnegative().safe();
const boundedText = (max = MAX_TEXT_CHARACTERS) => z.string().min(1).max(max);
const groundedCitationSchema = z.object({ id: z.string().min(1).max(MAX_PATH_CHARACTERS + 16),
  path: z.string().min(1).max(MAX_PATH_CHARACTERS), side: z.enum(['head', 'base', 'diff']),
  sha: sha.nullable(), presence: z.literal('absent').optional() }).strict();
const groundedVerifiedEvidenceSchema = z.union([
  z.object({ violatedInvariant: boundedText(2_000), failurePath: boundedText(2_000), benignCheck: boundedText(2_000),
    changeConnection: boundedText(2_000), citations: z.array(groundedCitationSchema).min(2).max(32),
    causalDiffPaths: z.array(z.string().min(1).max(MAX_PATH_CHARACTERS)).min(1).max(13) }).strict(),
  z.object({ explanation: boundedText(2_000), citations: z.array(groundedCitationSchema).min(3).max(32),
    causalDiffPaths: z.array(z.string().min(1).max(MAX_PATH_CHARACTERS)).max(13) }).strict(),
]);
const groundedOutcomeSchema = z.object({ fingerprint: z.string().min(1).max(500), path: z.string().min(1).max(MAX_PATH_CHARACTERS),
  line: positiveInteger, title: boundedText(MAX_TITLE_CHARACTERS), claimType: z.enum(['generic', 'absence', 'missing-tests']),
  severity: z.enum(['P0', 'P1', 'P2', 'P3', 'NIT']),
  status: z.enum(['confirmed', 'contradicted', 'insufficient']), affectedContextDigest: digest,
  relatedDiffPaths: z.array(z.string().min(1).max(MAX_PATH_CHARACTERS)).max(13),
  evidenceDigest: digest.optional(), evidence: groundedVerifiedEvidenceSchema.optional() }).strict()
  .superRefine((outcome, context) => {
    if ((outcome.status === 'confirmed' || outcome.status === 'contradicted')
      && (!outcome.evidenceDigest || !outcome.evidence)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['evidence'], message: 'verified outcomes require traceable evidence' });
    }
    if (outcome.status === 'insufficient' && (outcome.evidenceDigest !== undefined || outcome.evidence !== undefined)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['evidence'], message: 'insufficient outcomes cannot carry verification proof' });
    }
  });
const groundedCoverageReceiptSchema = z.object({ digest, regionCount: boundedInteger.max(100_000), assignmentCount: boundedInteger.max(24),
  coveredRegionCount: boundedInteger.max(100_000), complete: z.boolean(), omissions: z.array(z.string().min(1).max(500)).max(500) }).strict();
const groundedHistoryReceiptFields = { status: z.enum(['complete', 'partial', 'unavailable']), snapshotId: z.string().uuid().optional(),
    contextDigest: digest.optional(), eventCount: boundedInteger, findingCount: boundedInteger,
    loadedEventCount: boundedInteger, loadedFindingCount: boundedInteger, eventOmittedCount: boundedInteger,
    findingOmittedCount: boundedInteger, legacyOmittedCount: boundedInteger, eventsDigest: digest.optional(),
    findingsDigest: digest.optional(), omissions: z.array(z.string().min(1).max(500)).max(500),
    memorySources: z.object({ honcho: z.literal('unavailable'), mcp: z.literal('unavailable') }).strict(),
    verificationWrites: z.object({ attempted: boundedInteger, recorded: boundedInteger, failed: boundedInteger })
      .strict().refine((value) => value.recorded + value.failed === value.attempted, 'verification writes must be accounted for') };
const groundedHistoryReceiptV1Schema = z.object(groundedHistoryReceiptFields).strict().superRefine((history, context) => {
    if (history.status === 'complete' && (!history.snapshotId || !history.contextDigest || !history.eventsDigest || !history.findingsDigest)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['snapshotId'], message: 'complete history requires its authenticated snapshot digests' });
    }
  });
const reviewHeadAncestryV1Schema = z.object({ version: z.literal('ReviewHeadAncestry.v1'),
  result: z.enum(['ancestor', 'not-ancestor', 'unavailable']), priorRunId: z.string().regex(/^run_[a-f0-9]{32}$/u),
  priorHeadSha: sha, currentHeadSha: sha, comparisonDigest: digest }).strict();
const groundedHistoryReceiptV2Schema = z.object({ ...groundedHistoryReceiptFields,
  /** Historical aggregate hint; retained for receipt parsing but never continuity authority. */
  verifiedAncestry: reviewHeadAncestryV1Schema.optional() }).strict().superRefine((history, context) => {
    if (history.status === 'complete' && (!history.snapshotId || !history.contextDigest || !history.eventsDigest || !history.findingsDigest)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['snapshotId'], message: 'complete history requires its authenticated snapshot digests' });
    }
  });

const groundedHistoryReceiptSchema = groundedHistoryReceiptV1Schema;
const groundedVerificationV1Schema = z.object({ version: z.literal(GROUNDED_VERIFICATION_LEGACY_VERSION), candidates: boundedInteger.max(MAX_TOTAL_FINDINGS),
    confirmed: boundedInteger.max(MAX_TOTAL_FINDINGS), contradicted: boundedInteger.max(MAX_TOTAL_FINDINGS),
    insufficient: boundedInteger.max(MAX_TOTAL_FINDINGS), unverifiedBlockerCount: boundedInteger.max(MAX_TOTAL_FINDINGS),
    coverageComplete: z.boolean(), calls: boundedInteger.max(100),
    budget: z.object({ totalCalls: boundedInteger.max(100), callsPerTask: boundedInteger.max(12),
      concurrency: boundedInteger.max(18), callTimeoutMs: boundedInteger.max(180_000), stageBudgetMs: boundedInteger.max(300_000) }).strict(),
    outcomes: z.array(groundedOutcomeSchema).max(MAX_TOTAL_FINDINGS),
  }).strict().superRefine((verification, context) => {
    const outcomes = verification.outcomes;
    if (verification.candidates !== outcomes.length
      || verification.confirmed !== outcomes.filter((row) => row.status === 'confirmed').length
      || verification.contradicted !== outcomes.filter((row) => row.status === 'contradicted').length
      || verification.insufficient !== outcomes.filter((row) => row.status === 'insufficient').length
      || verification.unverifiedBlockerCount !== outcomes.filter((row) => (row.severity === 'P0' || row.severity === 'P1')
        && row.status === 'insufficient').length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['outcomes'], message: 'verification counts must account for every outcome' });
    }
    if (verification.calls > verification.budget.totalCalls) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['calls'], message: 'verifier calls exceeded the recorded budget' });
    }
  });
const groundedReviewReceiptV1Schema = z.object({
  version: z.literal('GroundedReviewReceipt.v1'),
  coverage: groundedCoverageReceiptSchema,
  history: groundedHistoryReceiptSchema,
  verification: groundedVerificationV1Schema,
}).strict();

const groundedWindowMappingV2Schema = z.union([
  z.object({ kind: z.literal('changed-hunk'), candidateSide: z.enum(['head', 'base']), candidateLine: positiveInteger,
    hunkOrdinal: boundedInteger, oldStart: boundedInteger, oldLines: boundedInteger,
    newStart: boundedInteger, newLines: boundedInteger,
    relation: z.enum(['replaced-region', 'insertion-gap', 'deletion-gap']),
    counterpartStartLine: boundedInteger.nullable(), counterpartEndLine: boundedInteger.nullable(),
    beforeLine: boundedInteger.nullable(), afterLine: boundedInteger.nullable() }).strict(),
  z.object({ kind: z.literal('dependency-contract'), exhaustive: z.literal(true), edge: z.object({
    resolver: z.literal('relative-import-v1'), importerPath: z.string().min(1).max(MAX_PATH_CHARACTERS),
    importerSide: z.enum(['head', 'base']), importerFullContentSha256: digest,
    importerStatementStartLine: positiveInteger, importerStatementEndLine: positiveInteger,
    importSpecifier: z.string().min(1).max(2_000), contractSymbols: z.array(z.string().min(1).max(128)).min(1).max(32),
    resolution: z.object({ version: z.literal('BoundedRelativeImportResolution.v1'), revisionSha: sha,
      state: z.enum(['resolved', 'unresolved']), resolvedPath: z.string().min(1).max(MAX_PATH_CHARACTERS).nullable(),
      probes: z.array(z.object({ path: z.string().min(1).max(MAX_PATH_CHARACTERS),
        presence: z.enum(['present', 'absent']), sourceDigest: digest.nullable() }).strict()).min(1).max(12),
    }).strict().optional(),
    resolvedPath: z.string().min(1).max(MAX_PATH_CHARACTERS), contractFullContentSha256: digest,
    definitionStartLine: positiveInteger, definitionEndLine: positiveInteger, definitionSha256: digest,
    importStatementDigest: digest, contractId: digest, originRegionDigest: digest,
  }).strict() }).strict(),
]);
const groundedSourceWindowV2Schema = z.object({
  version: z.literal('GroundedSourceWindow.v1'), id: digest,
  repository: z.string().min(3).max(500), path: z.string().min(1).max(MAX_PATH_CHARACTERS),
  side: z.enum(['head', 'base']), role: z.enum(['candidate', 'mapped-base', 'mapped-head', 'dependency-contract', 'dependency-caller']),
  revisionSha: sha, headSha: sha, baseSha: sha, fullContentSha256: digest,
  startLine: boundedInteger, endLine: boundedInteger, windowSha256: digest,
  byteLength: boundedInteger.max(24_000), regionDigest: digest, mapping: groundedWindowMappingV2Schema, exhaustive: z.boolean(),
}).strict().superRefine((window, context) => {
  if (!isValidGroundedSourceWindowV1(window)) context.addIssue({ code: z.ZodIssueCode.custom,
    path: ['id'], message: 'source window ID or metadata digest is invalid' });
});
const groundedCitationV2Schema = z.object({
  id: z.string().min(1).max(MAX_PATH_CHARACTERS + 128), path: z.string().min(1).max(MAX_PATH_CHARACTERS),
  repository: z.string().min(3).max(500), side: z.enum(['head', 'base', 'diff']),
  revisionSha: sha, headSha: sha, baseSha: sha, sourceDigest: digest,
  presence: z.literal('absent').optional(), window: groundedSourceWindowV2Schema.optional(), regionDigest: digest.optional(),
}).strict().superRefine((citation, context) => {
  if (!isValidGroundedCitationV2(citation)) context.addIssue({ code: z.ZodIssueCode.custom,
    path: ['id'], message: 'citation ID is not bound to its exact source metadata' });
});
const uniqueBoundedIds = (max = 32) => z.array(z.string().min(1).max(MAX_PATH_CHARACTERS + 128)).max(max)
  .refine((values) => new Set(values).size === values.length, 'citation IDs must be unique');
const groundedRootCauseV2Schema = z.object({
  componentId: z.string().regex(/^[a-z0-9]+(?:[._:/-][a-z0-9]+)*$/u),
  behaviorId: z.string().regex(/^[a-z0-9]+(?:[._:/-][a-z0-9]+)*$/u),
  contractId: z.string().regex(/^[a-z0-9]+(?:[._:/-][a-z0-9]+)*$/u),
  failureModeId: z.string().regex(/^[a-z0-9]+(?:[._:/-][a-z0-9]+)*$/u),
}).strict();
const groundedScopeDecisionV2Schema = z.object({
  version: z.literal(FINDING_CHANGE_SCOPE_VERSION),
  causalScope: z.enum(['introduced', 'exacerbated', 'preexisting', 'unproven']),
  reviewIdentity: z.object({ repository: z.string().min(3).max(500), baseSha: sha, headSha: sha,
    findingFingerprint: z.string().min(1).max(500).optional(), candidateSide: z.enum(['head', 'base']).optional(),
    candidatePath: z.string().min(1).max(MAX_PATH_CHARACTERS).optional() }).strict().nullable(),
  rootCauseEvidenceKey: z.string().regex(/^cause-evidence-v1:[a-f0-9]{64}$/u).nullable(),
  evidenceDigest: digest.nullable(),
  reasonCode: z.enum(['proof_missing', 'input_identity_invalid', 'proof_identity_mismatch', 'citation_manifest_invalid',
    'citation_manifest_mismatch', 'citation_unavailable_or_ambiguous', 'citation_binding_invalid', 'verifier_not_confirming',
    'root_cause_identity_invalid', 'cause_anchor_invalid', 'causal_path_unproven', 'side_state_unproven',
    'causal_change_unproven', 'causal_change_contradictory', 'introduced_proven', 'exacerbated_proven', 'preexisting_proven']),
}).strict();
const groundedCauseAnchorV2Schema = z.object({ componentPath: z.string().min(1).max(MAX_PATH_CHARACTERS),
  side: z.enum(['head', 'base']), startLine: positiveInteger, endLine: positiveInteger,
  citationIds: uniqueBoundedIds(), contentDigest: digest }).strict().superRefine((anchor, context) => {
    if (anchor.endLine < anchor.startLine || anchor.endLine - anchor.startLine + 1 > 20) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['endLine'], message: 'cause anchor exceeds its line bound' });
    }
  });
export interface GroundedOriginAncestryV1 {
  version: 'GroundedOriginAncestry.v1';
  sourceEventId: string;
  sourceKind: 'cause' | 'repair';
  priorRunId: string;
  priorHeadSha: string;
  currentHeadSha: string;
  result: 'ancestor' | 'not-ancestor' | 'unavailable';
  comparisonDigest: string;
}
const groundedOriginAncestryV1Schema = z.object({
  version: z.literal('GroundedOriginAncestry.v1'), sourceEventId: z.string().min(1).max(128),
  sourceKind: z.enum(['cause', 'repair']), priorRunId: z.string().regex(/^run_[a-f0-9]{32}$/u),
  priorHeadSha: sha, currentHeadSha: sha, result: z.enum(['ancestor', 'not-ancestor', 'unavailable']),
  comparisonDigest: digest,
}).strict();
const groundedFindingContinuityV1Schema = z.object({
  version: z.literal('GroundedFindingContinuity.v1'),
  status: z.enum(['new', 'continuous', 'reopened', 'unavailable']),
  durableFindingId: z.string().min(1).max(128).optional(),
  historySnapshotId: z.string().uuid().optional(),
  historyContextDigest: digest.optional(),
  sourceEventIds: z.array(z.string().min(1).max(128)).max(4_096)
    .refine((values) => values.every((value, index) => index === 0 || values[index - 1] < value),
      'source event IDs must be sorted and unique'),
  currentFingerprint: z.string().min(1).max(500),
  candidateSide: z.enum(['head', 'base']),
  rootCause: groundedRootCauseV2Schema,
  causeAnchor: groundedCauseAnchorV2Schema,
  sourceWindowManifestDigest: digest,
  currentOutcomeEvidenceDigest: digest.optional(),
  /** Per-origin ancestry receipts supersede the generic latest-head hint for continuity authority. */
  verifiedOriginAncestry: z.array(groundedOriginAncestryV1Schema).max(2).optional(),
  evidenceDigest: digest,
  unavailableReason: z.string().min(1).max(500).optional(),
}).strict().superRefine((continuity, context) => {
  const hasHistoryBinding = continuity.historySnapshotId !== undefined && continuity.historyContextDigest !== undefined;
  if (continuity.status === 'new') {
    if (!hasHistoryBinding || continuity.sourceEventIds.length !== 0 || continuity.durableFindingId !== undefined
      || continuity.unavailableReason !== undefined) context.addIssue({ code: z.ZodIssueCode.custom,
      path: ['status'], message: 'new continuity requires a complete empty-match snapshot and no durable ID' });
  } else if (continuity.status === 'continuous' || continuity.status === 'reopened') {
    if (!hasHistoryBinding || !continuity.sourceEventIds.length || !continuity.durableFindingId
      || continuity.unavailableReason !== undefined) context.addIssue({ code: z.ZodIssueCode.custom,
      path: ['status'], message: 'matched continuity requires its durable ID, exact snapshot and source events' });
  } else if (!continuity.unavailableReason || continuity.durableFindingId !== undefined
    || continuity.historySnapshotId !== undefined && continuity.historyContextDigest === undefined
    || continuity.historyContextDigest !== undefined && continuity.historySnapshotId === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['status'],
      message: 'unavailable continuity requires a reason and cannot claim a durable match' });
  }
  const origins = continuity.verifiedOriginAncestry;
  if (origins && origins.some((origin, index) => index > 0
    && (origins[index - 1]!.sourceKind > origin.sourceKind
      || origins[index - 1]!.sourceKind === origin.sourceKind
        && origins[index - 1]!.sourceEventId >= origin.sourceEventId))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['verifiedOriginAncestry'],
      message: 'origin ancestry proofs must be sorted and unique by source kind and event ID' });
  }
});
export type GroundedFindingContinuityV1 = z.infer<typeof groundedFindingContinuityV1Schema>;
export type GroundedFindingContinuityV1Material = Omit<GroundedFindingContinuityV1, 'evidenceDigest'>;
export function groundedFindingContinuityDigest(material: GroundedFindingContinuityV1Material): string {
  return sha256(canonicalJson(material));
}
export type ReviewHeadAncestryV1 = z.infer<typeof reviewHeadAncestryV1Schema>;

export interface GroundedLifecycleTransitionV1 {
  version: 'GroundedLifecycleTransition.v1';
  transition: 'fixed' | 'regressed';
  currentFingerprint: string;
  outcomeStatus: 'confirmed' | 'contradicted';
  candidateSide: 'head' | 'base';
  durableFindingId: string;
  priorFindingEventId: string;
  historySnapshotId: string;
  historyContextDigest: string;
  baseSha: string;
  headSha: string;
  changedContextDigest: string;
  sourceWindowManifestDigest: string;
  evidenceDigest: string;
  currentOutcomeEvidenceDigest: string;
  sourceCitationIds: string[];
  causalScope?: 'introduced' | 'exacerbated';
}
const groundedCausalPathV2Schema = z.object({ relation: z.enum(['same-component', 'dependency-edge', 'contract-edge', 'unrelated', 'unknown']),
  candidatePath: z.string().min(1).max(MAX_PATH_CHARACTERS), componentPath: z.string().min(1).max(MAX_PATH_CHARACTERS),
  citationIds: uniqueBoundedIds() }).strict();
const groundedSourceStateV2Schema = z.object({ trigger: z.enum(['present', 'absent', 'unknown']),
  contract: z.enum(['violated', 'not-violated', 'unknown']), citationIds: uniqueBoundedIds() }).strict();
const groundedCausalDeltaV2Schema = z.object({ kind: z.enum(['introduced', 'materially-worsened', 'unaffected', 'unknown']),
  materiality: z.enum(['reachability', 'impact', 'frequency', 'attack-surface']).optional(),
  citationIds: uniqueBoundedIds() }).strict().superRefine((delta, context) => {
    if (delta.kind === 'materially-worsened' && !delta.materiality) context.addIssue({ code: z.ZodIssueCode.custom,
      path: ['materiality'], message: 'materially-worsened requires explicit materiality' });
  });
const groundedScopeProofV2Schema = z.object({
  version: z.literal(FINDING_CHANGE_SCOPE_PROOF_VERSION),
  identity: z.object({ repository: z.string().min(3).max(500), baseSha: sha, headSha: sha,
    findingFingerprint: z.string().min(1).max(500), candidateSide: z.enum(['head', 'base']),
    sourceWindowManifestDigest: digest }).strict(),
  independentVerifier: z.object({ role: z.literal('independent-grounded-verifier'),
    status: z.literal('confirmed'), evidenceDigest: digest }).strict(),
  rootCause: z.object({ version: z.literal(FINDING_ROOT_CAUSE_IDENTITY_VERSION),
    componentId: z.string().min(1).max(128), behaviorId: z.string().min(1).max(128),
    contractId: z.string().min(1).max(128), failureModeId: z.string().min(1).max(128) }).strict(),
  causeAnchor: groundedCauseAnchorV2Schema,
  causalPath: z.object({ relation: z.enum(['same-component', 'dependency-edge', 'contract-edge', 'unrelated', 'unknown']),
    citationIds: uniqueBoundedIds() }).strict(),
  baseState: groundedSourceStateV2Schema,
  headState: groundedSourceStateV2Schema,
  causalChange: z.object({ relation: z.enum(['introduced', 'materially-worsened', 'unaffected', 'unknown']),
    materiality: z.enum(['reachability', 'impact', 'frequency', 'attack-surface']).optional(),
    citationIds: uniqueBoundedIds() }).strict(),
}).strict();
const groundedVerificationEvidenceV2CommonShape = {
  semanticsVersion: z.literal(GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION),
  citations: z.array(groundedCitationV2Schema).min(1).max(64), usedCitationIds: uniqueBoundedIds(),
  causalDiffPaths: z.array(z.string().min(1).max(MAX_PATH_CHARACTERS)).max(13),
  sourceWindowManifestDigest: digest,
};
function refineGroundedVerificationEvidenceV2Manifest(evidence: { citations: GroundedCitationV2[];
  usedCitationIds: string[]; sourceWindowManifestDigest: string }, context: z.RefinementCtx): void {
  const ids = evidence.citations.map((citation) => citation.id);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: z.ZodIssueCode.custom,
    path: ['citations'], message: 'citation manifest IDs must be unique' });
  if (evidence.usedCitationIds.some((id) => !ids.includes(id))) context.addIssue({ code: z.ZodIssueCode.custom,
    path: ['usedCitationIds'], message: 'used citation is outside the source manifest' });
  if (groundedCitationManifestDigest(evidence.citations as GroundedCitationV2[]) !== evidence.sourceWindowManifestDigest) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['sourceWindowManifestDigest'],
      message: 'source-window manifest digest does not match its exact citations' });
  }
}
const groundedConfirmedEvidenceV2Schema = z.object({
  ...groundedVerificationEvidenceV2CommonShape,
  violatedInvariant: boundedText(2_000), failurePath: boundedText(2_000), benignCheck: boundedText(2_000),
  changeConnection: boundedText(2_000), rootCause: groundedRootCauseV2Schema, causeAnchor: groundedCauseAnchorV2Schema,
  causalPath: groundedCausalPathV2Schema, baseState: groundedSourceStateV2Schema, headState: groundedSourceStateV2Schema,
  causalDelta: groundedCausalDeltaV2Schema,
  rootCauseEvidenceKey: z.string().regex(/^cause-evidence-v1:[a-f0-9]{64}$/u).nullable().optional(),
  scopeProof: groundedScopeProofV2Schema, scopeDecision: groundedScopeDecisionV2Schema,
}).strict().superRefine((evidence, context) => {
  refineGroundedVerificationEvidenceV2Manifest(evidence, context);
  const allowed = new Set(evidence.usedCitationIds);
  const claims = [...evidence.causeAnchor.citationIds, ...evidence.causalPath.citationIds,
    ...evidence.baseState.citationIds, ...evidence.headState.citationIds, ...evidence.causalDelta.citationIds];
  if (claims.some((id) => !allowed.has(id))) context.addIssue({ code: z.ZodIssueCode.custom,
    path: ['usedCitationIds'], message: 'structured scope evidence cites an unused source reference' });
  if (evidence.rootCauseEvidenceKey !== evidence.scopeDecision.rootCauseEvidenceKey) context.addIssue({ code: z.ZodIssueCode.custom,
    path: ['rootCauseEvidenceKey'], message: 'scope decision root-cause key disagrees with the evidence key' });
  if (canonicalJson(evidence.scopeProof.rootCause) !== canonicalJson({ version: FINDING_ROOT_CAUSE_IDENTITY_VERSION, ...evidence.rootCause })
    || canonicalJson(evidence.scopeProof.causeAnchor) !== canonicalJson(evidence.causeAnchor)
    || evidence.scopeProof.identity.sourceWindowManifestDigest !== evidence.sourceWindowManifestDigest) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['scopeProof'], message: 'scope proof does not match its grounded evidence' });
  }
});
const groundedContradictedEvidenceV2Schema = z.object({
  ...groundedVerificationEvidenceV2CommonShape,
  explanation: boundedText(2_000),
}).strict().superRefine(refineGroundedVerificationEvidenceV2Manifest);
const groundedOutcomeV2Schema = z.object({
  fingerprint: z.string().min(1).max(500), path: z.string().min(1).max(MAX_PATH_CHARACTERS), line: positiveInteger,
  title: boundedText(MAX_TITLE_CHARACTERS), claimType: z.enum(['generic', 'absence', 'missing-tests']),
  severity: z.enum(['P0', 'P1', 'P2', 'P3', 'NIT']), candidateSide: z.enum(['head', 'base']).optional(),
  status: z.enum(['confirmed', 'contradicted', 'insufficient']), reason: boundedText(2_000).optional(),
  affectedContextDigest: digest, relatedDiffPaths: z.array(z.string().min(1).max(MAX_PATH_CHARACTERS)).max(13),
  evidenceDigest: digest.optional(), evidence: z.union([groundedConfirmedEvidenceV2Schema, groundedContradictedEvidenceV2Schema]).optional(),
  /** Exact current-head ancestry for the matched lifecycle origins; the Gate joins this to trusted history. */
  verifiedOriginAncestry: z.array(groundedOriginAncestryV1Schema).max(2).optional(),
  verifiedContinuity: groundedFindingContinuityV1Schema.optional(),
  verifierRoute: groundedVerifierRouteV1Schema.optional(),
}).strict().superRefine((outcome, context) => {
  if ((outcome.status === 'confirmed' || outcome.status === 'contradicted')
    && (!outcome.evidenceDigest || !outcome.evidence || !outcome.candidateSide)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['evidence'], message: 'v2 verified outcomes require candidate side and evidence' });
  }
  if (outcome.status === 'confirmed' && (!outcome.evidence || !('rootCause' in outcome.evidence))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['evidence'], message: 'confirmed outcomes require scope evidence' });
  }
  if (outcome.status === 'contradicted' && (!outcome.evidence || !('explanation' in outcome.evidence))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['evidence'], message: 'contradicted outcomes require an explanation' });
  }
  if (outcome.status === 'insufficient' && (outcome.evidenceDigest !== undefined || outcome.evidence !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['evidence'], message: 'insufficient outcomes cannot carry verification proof' });
  }
  const origins = outcome.verifiedOriginAncestry;
  if (origins && origins.some((origin, index) => index > 0
    && (origins[index - 1]!.sourceKind > origin.sourceKind
      || origins[index - 1]!.sourceKind === origin.sourceKind
        && origins[index - 1]!.sourceEventId >= origin.sourceEventId))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['verifiedOriginAncestry'],
      message: 'origin ancestry proofs must be sorted and unique by source kind and event ID' });
  }
  // Continuity is an optional, untrusted history hint. It must have a strict shape, but a stale or
  // forged hint cannot invalidate otherwise valid finding verification; the Gate service accepts
  // it only after rechecking the canonical digest, exact authenticated row, and per-origin ancestry.
  if (outcome.claimType === 'absence' && outcome.status === 'confirmed' && outcome.evidence
    && !outcome.evidence.citations.some((citation) => citation.window?.path === outcome.path
      && citation.window.role === 'candidate' && citation.window.exhaustive)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['evidence'], message: 'partial source windows cannot prove an absence claim' });
  }
});
const groundedImportResolutionRefV1Schema = z.object({
  importerPath: z.string().min(1).max(MAX_PATH_CHARACTERS), importerSide: z.enum(['head', 'base']),
  importerFullContentSha256: digest, importerStatementStartLine: positiveInteger,
  importerStatementEndLine: positiveInteger, importSpecifier: z.string().min(1).max(2_000),
  importStatementDigest: digest,
}).strict().refine((reference) => reference.importerStatementEndLine >= reference.importerStatementStartLine,
  'importer statement range must be ordered');
const groundedImportResolutionSourceV1Schema = z.object({
  repository: z.string().min(3).max(500), revisionSha: sha, path: z.string().min(1).max(MAX_PATH_CHARACTERS),
  presence: z.enum(['present', 'absent', 'unavailable']), sourceDigest: digest.nullable(),
  resolutionRefs: z.array(groundedImportResolutionRefV1Schema).min(1).max(100),
}).strict().superRefine((source, context) => {
  if (source.presence === 'present' ? source.sourceDigest === null : source.sourceDigest !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['sourceDigest'],
      message: 'source probe digest is required only for present files' });
  }
  const keys = source.resolutionRefs.map((reference) => canonicalJson(reference));
  if (new Set(keys).size !== keys.length || keys.some((key, index) => index > 0 && keys[index - 1]! >= key)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['resolutionRefs'],
      message: 'source probe resolution references must be sorted and unique' });
  }
});
const groundedFindingCandidateV2Schema = z.object({
  fingerprint: z.string().min(1).max(500), severity: z.enum(['P0', 'P1', 'P2', 'P3', 'NIT']),
}).strict();
const groundedVerificationV2Schema = z.object({
  version: z.literal(GROUNDED_VERIFICATION_V2_VERSION),
  semanticsVersion: z.literal(GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION),
  candidates: boundedInteger.max(MAX_TOTAL_FINDINGS), confirmed: boundedInteger.max(MAX_TOTAL_FINDINGS),
  contradicted: boundedInteger.max(MAX_TOTAL_FINDINGS), insufficient: boundedInteger.max(MAX_TOTAL_FINDINGS),
  unverifiedBlockerCount: boundedInteger.max(MAX_TOTAL_FINDINGS), coverageComplete: z.boolean(),
  calls: boundedInteger.max(100),
  /** New receipts report source API resolution probes separately; older v2 receipts remain readable. */
  sourceResolutionProbes: boundedInteger.max(100).optional(),
  sourceResolutionProbeManifest: z.array(groundedImportResolutionSourceV1Schema).max(100).optional(),
  /** Original pre-filter engine candidate severities; optional only for historical v2 parsing. */
  candidateManifest: z.array(groundedFindingCandidateV2Schema).max(MAX_TOTAL_FINDINGS).optional(),
  budget: z.object({ totalCalls: boundedInteger.max(100), callsPerTask: boundedInteger.max(12),
    concurrency: boundedInteger.max(18), callTimeoutMs: boundedInteger.max(180_000), stageBudgetMs: boundedInteger.max(300_000) }).strict(),
  outcomes: z.array(groundedOutcomeV2Schema).max(MAX_TOTAL_FINDINGS),
}).strict().superRefine((verification, context) => {
  const outcomes = verification.outcomes;
  if (new Set(outcomes.map((row) => row.fingerprint)).size !== outcomes.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['outcomes'],
      message: 'v2 outcomes must uniquely bind one normalized finding identity' });
  }
  if (verification.candidates !== outcomes.length
    || verification.confirmed !== outcomes.filter((row) => row.status === 'confirmed').length
    || verification.contradicted !== outcomes.filter((row) => row.status === 'contradicted').length
    || verification.insufficient !== outcomes.filter((row) => row.status === 'insufficient').length
    || verification.unverifiedBlockerCount !== outcomes.filter((row) => (row.severity === 'P0' || row.severity === 'P1')
      && (row.status === 'insufficient' || (row.status === 'confirmed' && row.evidence && 'rootCause' in row.evidence
        && row.evidence.scopeDecision.causalScope === 'unproven'))).length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['outcomes'], message: 'v2 verification counts must account for every outcome' });
  }
  if (verification.calls > verification.budget.totalCalls) context.addIssue({ code: z.ZodIssueCode.custom,
    path: ['calls'], message: 'verifier calls exceeded the recorded budget' });
  const probeManifest = verification.sourceResolutionProbeManifest;
  if (probeManifest !== undefined && verification.sourceResolutionProbes !== probeManifest.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['sourceResolutionProbeManifest'],
      message: 'source-resolution probe count must equal its canonical unique source manifest' });
  }
  if (probeManifest) {
    const keys = probeManifest.map((source) => `${source.repository}\u0000${source.revisionSha}\u0000${source.path}`);
    if (new Set(keys).size !== keys.length || keys.some((key, index) => index > 0 && keys[index - 1]! >= key)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['sourceResolutionProbeManifest'],
        message: 'source-resolution probes must be sorted and unique by repository, revision, and path' });
    }
  }
  const candidates = verification.candidateManifest;
  if (candidates && (candidates.length !== verification.candidates
    || new Set(candidates.map((candidate) => candidate.fingerprint)).size !== candidates.length
    || candidates.some((candidate, index) => index > 0 && candidates[index - 1]!.fingerprint >= candidate.fingerprint))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['candidateManifest'],
      message: 'pre-filter candidate severity manifest must be complete, unique, and deterministically ordered' });
  }
});
const groundedReviewReceiptV2Schema = z.object({
  version: z.literal(GROUNDED_REVIEW_RECEIPT_V2_VERSION),
  semanticsVersion: z.literal(GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION),
  coverage: groundedCoverageReceiptSchema,
  history: groundedHistoryReceiptV2Schema,
  verification: groundedVerificationV2Schema,
}).strict();
type GroundedReviewReceiptV2 = z.infer<typeof groundedReviewReceiptV2Schema>;
const groundedReviewReceiptSchema = z.union([groundedReviewReceiptV1Schema, groundedReviewReceiptV2Schema]);

const findingSchema = z.object({
  severity: z.enum(['P0', 'P1', 'P2', 'P3', 'NIT']),
  path: z.string().min(1).max(MAX_PATH_CHARACTERS),
  line: positiveInteger,
  startLine: positiveInteger.optional(),
  title: boundedText(MAX_TITLE_CHARACTERS),
  body: boundedText(MAX_TEXT_CHARACTERS),
  suggestion: z.string().max(MAX_TEXT_CHARACTERS).nullable().optional(),
  replacementCode: z.string().max(MAX_CODE_CHARACTERS).nullable().optional(),
  confidence: z.number().finite().min(0).max(100).optional(),
  blockerEvidence: z.object({
    trigger: boundedText(2_000), impact: boundedText(2_000), violatedContract: boundedText(2_000),
  }).strict().nullable().optional(),
  recommendation: z.string().max(MAX_TEXT_CHARACTERS).optional(),
  fixOptions: z.array(z.object({
    rank: positiveInteger.optional(),
    title: z.string().max(2_000).optional(),
    explanation: z.string().max(MAX_TEXT_CHARACTERS).optional(),
    suggestionCode: z.string().max(MAX_CODE_CHARACTERS).optional(),
  }).strict()).max(8).optional(),
  isArchitectural: z.boolean().optional(),
}).strict().superRefine((finding, context) => {
  if (finding.startLine !== undefined && finding.startLine > finding.line) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['startLine'], message: 'startLine must not exceed line' });
  }
});

/** MAX_INVESTIGATION_TURNS in `panelEngine.ts` is 15; this bound is deliberately a little larger
 * so a future increase there does not also require a schema change here, while still rejecting an
 * unbounded array. Not imported directly -- a worker-completion schema must not reach into the
 * panel engine module for a plain numeric constant. */
export const MAX_TURN_USAGES = 32;

/** One real provider call inside a persona lane's `invoke()` loop. Bounded and strictly numeric
 * (plus the resolved model string) -- never provider prompt/response text -- so it is safe on this
 * boundary the same way the rest of this schema is. */
const laneTurnUsageSchema = z.object({
  turn: positiveInteger,
  kind: z.enum(['tool', 'correction', 'final']),
  promptTokens: boundedInteger,
  completionTokens: boundedInteger,
  totalTokens: boundedInteger,
  cachedTokens: boundedInteger,
  costUSD: z.number().finite().nonnegative().nullable(),
  model: z.string().max(256),
  durationMs: boundedInteger,
}).strict();

/**
 * OPTIONAL, additive per-persona telemetry (Stage 0 / example-meta review-yeti telemetry work): the
 * lane's accumulated usage across every turn its `invoke()` loop made, not just the terminal turn
 * the rest of this schema has always reported. Every field is optional and the object itself is
 * optional on `personaSchema` below, so an older worker that never populates it -- or a panel
 * result with no completed lanes -- still parses cleanly. This keeps `WorkerReviewCompletion.v1`
 * backward compatible: no version bump, no dispatcher change required to read it.
 */
const personaTelemetrySchema = z.object({
  model: z.string().max(256).optional(),
  turnsCount: boundedInteger.optional(),
  toolTurns: boundedInteger.optional(),
  correctionTurns: boundedInteger.optional(),
  /** Count of tool invocations the lane's `invoke()` loop actually made (the `toolCalls` array
   * declared in `panelEngine.ts`), not the array itself -- this boundary carries bounded numeric
   * telemetry only, never the tool names/args a provider or repository file path could leak
   * through. Optional and additive for the same reason every other field here is: an older worker
   * that never populates it must still parse. */
  toolCalls: boundedInteger.optional(),
  promptTokens: boundedInteger.optional(),
  completionTokens: boundedInteger.optional(),
  totalTokens: boundedInteger.optional(),
  cachedTokens: boundedInteger.optional(),
  costUSD: z.number().finite().nonnegative().nullable().optional(),
  durationMs: boundedInteger.optional(),
  turnUsages: z.array(laneTurnUsageSchema).max(MAX_TURN_USAGES).optional(),
}).strict();

export type PersonaTelemetry = z.output<typeof personaTelemetrySchema>;
/** The `turnUsages` entry shape. */
export type LaneTurnUsagePayload = z.output<typeof laneTurnUsageSchema>;

/**
 * The ONLY place that maps a panel lane's turn-accumulation fields onto the wire shape
 * `personaTelemetrySchema` accepts. `buildReviewResult` in `publishingReview.ts` calls this on
 * the publishing worker's SUCCESS path, instead of hand-mirroring the field list a second time in
 * a different module -- co-locating the builder with the schema it targets (rather than relying
 * on `z.output<...>` alone, which TypeScript's excess-property checking does not actually enforce
 * through the conditional spreads a builder like this needs -- confirmed by renaming a field here
 * and re-running `tsc --noEmit` with no error) means an edit to one is an edit to the other, in
 * the same file, in the same diff.
 *
 * TOTAL, never throws: `telemetry` is an OPTIONAL, additive field added specifically so it
 * degrades safely -- this PR exists to make measurement trustworthy, not to make measurement able
 * to fail a review. A lane carrying a malformed field from an unexpected producer (a string token
 * count, a NaN, a non-integer `turn`, ...) must never sink the whole publishing run. On schema
 * failure this OMITS the telemetry field for that lane and records the omission (a counter plus a
 * bounded log line -- never the raw candidate, only zod's issue paths/codes) so the drop is
 * visible rather than silent, then returns `undefined` exactly like the "no telemetry data at
 * all" case the caller already handles. The earlier version of this function ended in
 * `personaTelemetrySchema.parse(...)`, which threw on drift instead of degrading -- that was
 * itself a real regression this rewrite fixes; fail-loud on drift belongs in this function's own
 * unit tests, not on the production success path.
 *
 * Input is loosely typed (`unknown`-per-field, not `PersonaLaneResult` from the panel module):
 * this module must not depend on panel-engine internals, so every field is read defensively by
 * type, exactly as a producer across a process/module boundary should.
 */
export function buildPersonaTelemetryPayload(lane: {
  id?: unknown;
  model?: unknown;
  turnsCount?: unknown;
  toolTurns?: unknown;
  correctionTurns?: unknown;
  durationMs?: unknown;
  aggregateUsage?: unknown;
  turnUsages?: unknown;
  toolCalls?: unknown;
}): PersonaTelemetry | undefined {
  const aggregate = lane.aggregateUsage as Record<string, unknown> | undefined;
  const hasAggregate = !!aggregate && typeof aggregate === 'object';
  const turnUsagesInput = Array.isArray(lane.turnUsages) ? lane.turnUsages : [];
  const hasTurnUsages = turnUsagesInput.length > 0;
  // `lane.toolCalls` is the panel engine's array of individual tool-invocation records
  // (`{ tool, args, scope, exhaustive }`); this boundary only ever reports its length, never the
  // array itself -- see the doc comment on `personaTelemetrySchema.toolCalls`.
  const hasToolCalls = Array.isArray(lane.toolCalls);
  const hasAnyTelemetry = hasAggregate || hasTurnUsages || hasToolCalls
    || typeof lane.turnsCount === 'number' || typeof lane.model === 'string';
  if (!hasAnyTelemetry) return undefined;

  const candidate: Record<string, unknown> = {
    ...(typeof lane.model === 'string' ? { model: lane.model } : {}),
    ...(typeof lane.turnsCount === 'number' ? { turnsCount: lane.turnsCount } : {}),
    ...(typeof lane.toolTurns === 'number' ? { toolTurns: lane.toolTurns } : {}),
    ...(typeof lane.correctionTurns === 'number' ? { correctionTurns: lane.correctionTurns } : {}),
    ...(typeof lane.durationMs === 'number' ? { durationMs: lane.durationMs } : {}),
    ...(hasToolCalls ? { toolCalls: (lane.toolCalls as unknown[]).length } : {}),
    ...(hasAggregate ? {
      promptTokens: aggregate!.promptTokens,
      completionTokens: aggregate!.completionTokens,
      totalTokens: aggregate!.totalTokens,
      cachedTokens: aggregate!.cachedTokens,
      costUSD: aggregate!.costUSD,
    } : {}),
    ...(hasTurnUsages ? {
      turnUsages: turnUsagesInput.map((turn: any) => ({
        turn: turn?.turn,
        kind: turn?.kind,
        promptTokens: turn?.promptTokens,
        completionTokens: turn?.completionTokens,
        totalTokens: turn?.totalTokens,
        cachedTokens: turn?.cachedTokens,
        costUSD: turn?.costUSD,
        model: turn?.model,
        durationMs: turn?.durationMs,
      })),
    } : {}),
  };

  const result = personaTelemetrySchema.safeParse(candidate);
  if (result.success) return result.data;

  const personaId = typeof lane.id === 'string' ? lane.id : 'unknown';
  // Telemetry recording is itself best-effort: a metrics-layer failure must never compound into a
  // review failure either, the same principle this whole function exists to uphold.
  try {
    getMetrics().personaTelemetryDropped.add(1, { persona: personaId });
  } catch (_) {
    // ignore
  }
  logger.warn('Persona telemetry payload failed schema validation; omitting it from the result', {
    persona: personaId,
    // Bounded to zod's structural issue metadata -- never the raw candidate values, which a
    // future producer could make arbitrarily large.
    issues: result.error.issues.map((issue) => ({ path: issue.path.join('.'), code: issue.code })),
  });
  return undefined;
}

const personaSchema = z.object({
  sourceDelivery: taskSourceReceiptSchema.optional(),
  id: z.string().regex(TASK_ID_PATTERN),
  decision: z.enum(['APPROVE', 'FINDINGS', 'ERROR']),
  status: z.enum(['COMPLETE', 'ERROR']).optional(),
  /** Bounded operational classification only; provider text/transcripts never cross this boundary. */
  errorClass: z.enum(workerFailureClasses).optional(),
  findings: z.array(findingSchema).max(MAX_FINDINGS_PER_PERSONA),
  /** See `personaTelemetrySchema` above. */
  telemetry: personaTelemetrySchema.optional(),
  /**
   * OPTIONAL, additive (shadow-mode review engine comparison, `src/cli/publishingReview.ts`'s
   * `resolveReviewEngine`/`'shadow'`): which engine produced this lane -- the fan-out persona
   * panel (`'panel'`) or the single-context composed engine running alongside it purely as
   * non-gating comparison evidence (`'shadow'`). Every field on this schema stays optional and
   * additive the same way `telemetry` above is, so `WorkerReviewCompletion.v1` stays backward
   * compatible: no version bump, no dispatcher change required, and a worker built before shadow
   * mode existed -- or a lane this field was never populated for -- still parses cleanly. A
   * consumer that wants only gating evidence treats an absent value exactly like `'panel'`; the
   * ingest side already reads `lane.evidenceSource == 'shadow'` to route shadow findings into
   * their own comparison bucket, separate from the findings that gated the published verdict.
   */
  evidenceSource: z.enum(['panel', 'shadow']).optional(),
}).strict().superRefine((persona, context) => {
  const errorLane = persona.decision === 'ERROR' || persona.status === 'ERROR';
  if (errorLane && persona.errorClass === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['errorClass'], message: 'errorClass is required for an error lane' });
  }
  if (!errorLane && persona.errorClass !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['errorClass'], message: 'errorClass is only valid for an error lane' });
  }
});

const completionCoordinatesSchema = z.object({
  runId: z.string().regex(/^run_[a-f0-9]{32}$/u),
  repositoryId: positiveInteger,
  owner: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/u),
  repo: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/u),
  prNumber: positiveInteger,
  headSha: sha,
  baseSha: sha,
  policyDigest: digest,
  configDigest: digest,
  executionAttempt: positiveInteger,
}).strict();

const resultSchema = z.object({
  version: z.literal(WORKER_REVIEW_RESULT_VERSION),
  completedAt: z.string().datetime({ offset: true }),
  personas: z.array(personaSchema).max(MAX_PERSONAS),
  taskPlan: z.array(z.object({
    id: z.string().regex(TASK_ID_PATTERN),
    dimension: z.enum(TASK_DIMENSIONS),
    paths: z.array(z.string().min(1).max(MAX_PATH_CHARACTERS)).min(1).max(MAX_CHANGED_FILES),
    question: z.string().min(1).max(MAX_TASK_TEXT_LENGTH),
    rationale: z.string().min(1).max(MAX_TASK_TEXT_LENGTH),
  }).strict()).min(1).max(MAX_TASKS_HARD_CAP).optional(),
  coverageComplete: z.boolean(),
  quorumSatisfied: z.boolean(),
  /** Optional classification execution receipt; never coverage or verdict authority. */
  deletionClassification: z.object({
    version: z.literal(DELETION_CLASSIFICATION_VERSION),
    digest: z.string().regex(/^[0-9a-f]{64}$/u),
    status: z.enum(['complete', 'partial', 'unavailable']),
    totalFiles: boundedInteger.max(MAX_CHANGED_FILES),
    classifiedFiles: boundedInteger.max(MAX_CHANGED_FILES),
    unresolvedFiles: boundedInteger.max(MAX_CHANGED_FILES),
    totalGroups: boundedInteger.max(MAX_CHANGED_FILES),
  }).strict().refine((receipt) => receipt.classifiedFiles + receipt.unresolvedFiles === receipt.totalFiles
    && receipt.totalGroups <= receipt.totalFiles, 'classification counts must account for every path').optional(),
  /** Optional worker-computed summaries; consistency checks only, never eligibility authority. */
  verdict: z.enum(['SHIP', 'FIX_FIRST', 'BLOCK']).optional(),
  findingCount: boundedInteger.max(MAX_TOTAL_FINDINGS).optional(),
  blockingFindingCount: boundedInteger.max(MAX_TOTAL_FINDINGS).optional(),
  /** Optional additive receipt. Required and recomputed by the trusted service only under v2 policy. */
  reviewDecision: reviewDecisionV2Schema.optional(),
  /** Exact current source coverage, independently verified claims, and service-history loading receipt. */
  groundedReview: groundedReviewReceiptSchema.optional(),
  /** Composed-only runtime observation; service binds it to the prepared config and task sources. */
  composedResources: composedRuntimeResourcesSchema.optional(),
  /**
   * OPTIONAL, additive (Stage 0 / example-meta review-yeti telemetry work): the panel engine's own
   * wall-clock measurement of the whole run (`panelResult.panelWallClockMs` in `panelEngine.ts`),
   * distinct from summing every persona's `telemetry.durationMs`. Under the panel's concurrent
   * fan-out (`MAX_CONCURRENT_PERSONAS`) a summed-lane figure overstates wall time, so it cannot
   * stand in for how long the run actually took -- comparing a fan-out engine against a
   * single-context engine on the summed figure is not a meaningful comparison. Optional and left
   * off `resultSchema`'s literal `version`, exactly like `telemetry` on `personaTelemetrySchema`,
   * so this stays `WorkerReviewCompletion.v1`: no version bump, no dispatcher change required, and
   * a worker built before this field existed still parses cleanly.
   */
  panelWallClockMs: boundedInteger.optional(),
  /** Optional bounded context for a terminal error result; persisted after a second redaction. */
  failureDiagnostics: workerFailureDiagnosticsSchema.optional(),
  /**
   * OPTIONAL, additive (REL-1084, `REVIEW_YETI_INCREMENTAL`): the files whose content this run
   * carried forward from a named prior review instead of sending. Never evidence on its own: the
   * trusted completion side must verify it (`TrustedReviewCoverageContract.incrementalVerified`)
   * or `deriveCanonicalWorkerReviewEvidence` refuses the completion.
   */
  incremental: incrementalReviewClaimSchema.optional(),
  /** REL-1198: receipt for the exact service-owned retained advisory context. */
  incompleteP2Recovery: incompleteP2RecoveryClaimSchema.optional(),
  /**
   * OPTIONAL, additive (REL-1085, `REVIEW_YETI_VERDICT_CACHE`): this run's clean per-file lane
   * results for later runs, and any files it served from a named earlier record instead of
   * sending. Served files are never evidence on their own: the trusted completion side must verify
   * them (`TrustedReviewCoverageContract.verdictCacheVerified`) or
   * `deriveCanonicalWorkerReviewEvidence` refuses the completion.
   */
  verdictCache: verdictCacheClaimSchema.optional(),
  /**
   * OPTIONAL, additive (REL-1084): the configured lane roster the worker's own verdict required
   * (`panelResult.applicablePersonaIds`), sent only on non-authoritative WorkerReviewEvidence and
   * only for a valid panel roster. A later run may rest on a non-authoritative prior only when
   * every roster lane completed (`storedEvidenceShipCompleteReason`); without it the prior is
   * refused.
   */
  roster: z.array(z.string().regex(TASK_ID_PATTERN)).min(1).max(MAX_PERSONAS)
    .refine((ids) => new Set(ids).size === ids.length, 'roster lane ids must be unique').optional(),
  /**
   * OPTIONAL, additive (REL-1139, `REVIEW_YETI_SKIP_EMPTY_MODERATION`, example-meta ADR 0687): the
   * worker skipped the moderator call because every lane completed with an empty APPROVE and
   * coverage was full. Never evidence on its own: `deriveCanonicalWorkerReviewEvidence` re-runs
   * the shared decision (`decideEmptyModeration`) on the trusted diff and refuses a claim it does
   * not allow.
   */
  moderation: z.literal(EMPTY_MODERATION_SKIPPED).optional(),
}).strict();

const completionSchema = z.object({
  version: z.literal(WORKER_REVIEW_COMPLETION_VERSION),
  ...completionCoordinatesSchema.shape,
  result: resultSchema,
}).strict();

export const workerReviewCompletionSchema = completionSchema;

/**
 * Evidence behind a check the worker published itself (app-gate publication
 * without the authoritative gate). Sent once, right after the check is
 * completed and before any terminal lifecycle callback, for BOTH conclusions:
 * a failing check carries the P0/P1 findings that made it fail. It never
 * transitions the run and never selects or completes a check.
 */
export const WORKER_REVIEW_EVIDENCE_VERSION = 'WorkerReviewEvidence.v1' as const;
const evidenceSchema = z.object({
  version: z.literal(WORKER_REVIEW_EVIDENCE_VERSION),
  ...completionCoordinatesSchema.shape,
  checkId: z.number().int().positive().safe(),
  conclusion: z.enum(['success', 'failure']),
  result: resultSchema,
}).strict();
export const workerReviewEvidenceSchema = evidenceSchema;
export type WorkerReviewEvidence = z.infer<typeof evidenceSchema>;

export type WorkerReviewCompletion = z.infer<typeof completionSchema>;
export type WorkerReviewResult = z.infer<typeof resultSchema>;
export type WorkerReviewPersonaEvidence = z.infer<typeof personaSchema>;
export type TrustedWorkerReviewCoordinates = z.infer<typeof completionCoordinatesSchema>;

export interface TrustedGroundedLifecycleTransitionV1 {
  version: 'GroundedLifecycleTransition.v1';
  kind: 'fixed' | 'regressed';
  durableFindingId: string;
  priorFindingEventId: string;
  changedContextDigest: string;
  historySnapshotId: string;
  historyContextDigest: string;
  currentFingerprint: string;
  candidateSide: 'head' | 'base';
  outcomeStatus: 'confirmed' | 'contradicted';
  baseSha: string;
  headSha: string;
  sourceWindowManifestDigest: string;
  currentOutcomeEvidenceDigest: string;
  evidenceDigest: string;
  causalScope?: 'introduced' | 'exacerbated';
}
const trustedGroundedLifecycleTransitionV1Schema = z.object({
  version: z.literal('GroundedLifecycleTransition.v1'), kind: z.enum(['fixed', 'regressed']),
  durableFindingId: z.string().min(1).max(128), priorFindingEventId: z.string().min(1).max(128),
  changedContextDigest: digest, historySnapshotId: z.string().uuid(), historyContextDigest: digest,
  currentFingerprint: z.string().min(1).max(500), candidateSide: z.enum(['head', 'base']),
  outcomeStatus: z.enum(['confirmed', 'contradicted']), baseSha: sha, headSha: sha,
  sourceWindowManifestDigest: digest, currentOutcomeEvidenceDigest: digest, evidenceDigest: digest,
  causalScope: z.enum(['introduced', 'exacerbated']).optional(),
}).strict().superRefine((transition, context) => {
  if ((transition.kind === 'regressed') !== (transition.causalScope !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['causalScope'],
      message: 'only a regressed transition carries its service-reduced introduced/exacerbated scope' });
  }
});

/** Service-only projection of the authenticated lifecycle snapshot and its independently rechecked ancestry. */
export interface TrustedGroundedHistoryContext {
  snapshotId: string;
  contextDigest: string;
  eventIds: readonly string[];
  currentRunId: string;
  currentHeadSha: string;
  expectedContinuityByFingerprint: Readonly<Record<string, GroundedFindingContinuityV1>>;
  /** Service-rederived exact cause/repair origins for each current candidate; a generic ancestry hint is not authority. */
  expectedOriginAncestryByFingerprint?: Readonly<Record<string, readonly GroundedOriginAncestryV1[]>>;
  verifiedAncestry?: ReviewHeadAncestryV1;
  /** Transitions already rechecked by the service against stored events and current exact source. */
  expectedTransitionsByFingerprint?: Readonly<Record<string, TrustedGroundedLifecycleTransitionV1>>;
}

export interface TrustedGroundedVerifierRouting {
  primaryModel: string;
  disputedBlockerAdjudicatorModel?: string;
}

/** Service-authenticated pinned source state used to revalidate worker import-resolution traces. */
export interface TrustedGroundedImportResolutionSourceV1 {
  repository: string;
  revisionSha: string;
  path: string;
  presence: 'present' | 'absent' | 'unavailable';
  sourceDigest: string | null;
}

function sourcePathSetDigest(paths: readonly string[]): { count: number; sha256: string } {
  return { count: paths.length, sha256: sha256(JSON.stringify(paths)) };
}

function groundedImportResolutionMatches(input: { edge: GroundedDependencyEdgeV1; revisionSha: string;
  repository: string; expected: { state: 'resolved'; path: string } | { state: 'unresolved' };
  workerSources: ReadonlyMap<string, GroundedImportResolutionSourceV1>;
  trustedSources: ReadonlyMap<string, TrustedGroundedImportResolutionSourceV1> }): boolean {
  const resolution = input.edge.resolution;
  const candidates = groundedRelativeImportCandidates(input.edge.importerPath, input.edge.importSpecifier);
  if (!resolution || resolution.revisionSha !== input.revisionSha || candidates.length === 0
    || resolution.probes.map((probe) => probe.path).some((path, index) => path !== candidates[index])) return false;
  const reference = { importerPath: input.edge.importerPath, importerSide: input.edge.importerSide,
    importerFullContentSha256: input.edge.importerFullContentSha256,
    importerStatementStartLine: input.edge.importerStatementStartLine,
    importerStatementEndLine: input.edge.importerStatementEndLine, importSpecifier: input.edge.importSpecifier,
    importStatementDigest: input.edge.importStatementDigest };
  for (const probe of resolution.probes) {
    const key = `${input.repository}\u0000${input.revisionSha}\u0000${probe.path}`;
    const workerSource = input.workerSources.get(key);
    const trustedSource = input.trustedSources.get(key);
    const expectedPresence = probe.presence;
    if (!workerSource || !trustedSource || workerSource.repository !== input.repository
      || workerSource.revisionSha !== input.revisionSha || workerSource.path !== probe.path
      || workerSource.presence !== expectedPresence || workerSource.sourceDigest !== probe.sourceDigest
      || trustedSource.repository !== workerSource.repository || trustedSource.revisionSha !== workerSource.revisionSha
      || trustedSource.path !== workerSource.path || trustedSource.presence !== workerSource.presence
      || trustedSource.sourceDigest !== workerSource.sourceDigest
      || !workerSource.resolutionRefs.some((candidate) => canonicalJson(candidate) === canonicalJson(reference))) return false;
  }
  if (input.expected.state === 'resolved') {
    const last = resolution.probes.at(-1);
    return resolution.state === 'resolved' && resolution.resolvedPath === input.expected.path
      && resolution.probes.length <= candidates.length && last?.path === input.expected.path
      && last.presence === 'present' && last.sourceDigest === input.edge.contractFullContentSha256
      && resolution.probes.slice(0, -1).every((probe) => probe.presence === 'absent' && probe.sourceDigest === null);
  }
  return resolution.state === 'unresolved' && resolution.resolvedPath === null
    && resolution.probes.length === candidates.length
    && resolution.probes.every((probe) => probe.presence === 'absent' && probe.sourceDigest === null);
}

function composedRuntimeResourcesRefusal(input: { result: WorkerReviewResult; tasks: readonly ReviewTask[];
  changedFiles: readonly ReviewChangedFile[]; coordinates: TrustedWorkerReviewCoordinates;
  expectedConfiguration?: ComposedRuntimeResources['configuration']['value'] }): string | null {
  const receipt = input.result.composedResources;
  if (!receipt) return 'composed completion is missing its worker-stage runtime resource receipt';
  if (receipt.stage !== 'worker_completion' || receipt.discoveryScope !== 'composed_engine'
    || receipt.evidenceSemanticsVersion !== GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION) {
    return 'composed runtime resource receipt has the wrong stage or evidence semantics';
  }
  if (receipt.configDigest.value !== input.coordinates.configDigest || receipt.configuration.value === null
    || input.expectedConfiguration === undefined || input.expectedConfiguration === null
    || canonicalJson(receipt.configuration.value) !== canonicalJson(input.expectedConfiguration)) {
    return 'composed runtime resource receipt is not bound to the service-prepared effective configuration';
  }
  const expectedAttemptBudget = input.expectedConfiguration.effective.composed_budget.provider_attempt_budget;
  if (expectedAttemptBudget && (receipt.version !== 'ComposedRuntimeResources.v2' || !receipt.providerAttempts)) {
    return 'current composed review lacks physical provider attempt evidence';
  }
  if (receipt.providerAttempts) {
    const attempts = receipt.providerAttempts;
    const budget = receipt.budget;
    const hardCap = receipt.configuration.value.effective.composed_budget.total_turns_hard_cap;
    const expectedTotal = expectedAttemptBudget?.total_limit
      ?? receipt.configuration.value.effective.composed_budget.central_policy_total_turns;
    if (attempts.totalLimit !== budget.configuredTotalTurns
      || attempts.investigationLimit !== budget.investigationTurns
      || attempts.verificationLimit !== budget.verificationReserveTurns
      || attempts.totalLimit > hardCap
      || attempts.totalLimit !== expectedTotal
      || (expectedAttemptBudget && (attempts.investigationLimit !== expectedAttemptBudget.investigation_limit
        || attempts.verificationLimit !== expectedAttemptBudget.verifier_reserve))
      || attempts.totalStarted !== attempts.investigationStarted + attempts.verificationStarted
      || attempts.totalStarted > attempts.totalLimit
      || attempts.investigationStarted > attempts.investigationLimit
      || attempts.verificationStarted > attempts.verificationLimit) {
      return 'composed physical provider attempts disagree with the prepared and reserved budgets';
    }
  }
  const verifierCalls = input.result.groundedReview?.version === GROUNDED_REVIEW_RECEIPT_V2_VERSION
    ? input.result.groundedReview.verification.calls : null;
  if (verifierCalls === null || receipt.usage.verifierCalls.value !== verifierCalls) {
    return 'composed runtime resource receipt does not match the observed grounded-verifier calls';
  }
  const taskIds = input.tasks.map(task => task.id).sort();
  if (canonicalJson(receipt.tasks.planned) !== canonicalJson(taskIds)) {
    return 'composed runtime resource task plan disagrees with the trusted task plan';
  }
  const personaById = new Map(input.result.personas.filter(persona => persona.evidenceSource !== 'shadow')
    .map(persona => [persona.id, persona] as const));
  const successfulPersonaIds = [...personaById.values()].filter(persona => persona.decision !== 'ERROR'
    && persona.status !== 'ERROR').map(persona => persona.id).sort();
  if (canonicalJson(receipt.tasks.completed) !== canonicalJson(successfulPersonaIds)
    || successfulPersonaIds.some(id => !receipt.tasks.started.includes(id))) {
    return 'composed runtime resource completed-task states disagree with the exact worker lanes';
  }
  const terminalErrorIds = [...personaById.values()].filter(persona => persona.decision === 'ERROR'
    || persona.status === 'ERROR').map(persona => persona.id);
  const failedTaskIds = new Set([...receipt.tasks.blocked, ...receipt.tasks.failed, ...receipt.tasks.interrupted]);
  if (terminalErrorIds.some(id => !failedTaskIds.has(id))) {
    return 'composed runtime resource task failures disagree with the exact worker lanes';
  }
  const taskById = new Map(input.tasks.map(task => [task.id, task] as const));
  const deliveredComplete = new Set<string>();
  for (const taskId of receipt.tasks.completed) {
    const task = taskById.get(taskId);
    const persona = personaById.get(taskId);
    if (!task || !persona?.sourceDelivery) continue;
    const validated = validateTaskSourceReceipt(persona.sourceDelivery, { taskId, paths: task.paths,
      files: input.changedFiles, headSha: input.coordinates.headSha, baseSha: input.coordinates.baseSha });
    if (validated?.complete) deliveredComplete.add(taskId);
  }
  const assignedPaths = [...new Set(input.tasks.flatMap(task => task.paths))].sort();
  const investigatedPaths = assignedPaths.filter(path => {
    const owners = input.tasks.filter(task => task.paths.includes(path));
    return owners.length > 0 && owners.every(task => receipt.tasks.completed.includes(task.id)
      && deliveredComplete.has(task.id));
  });
  const investigated = new Set(investigatedPaths);
  const remainingPaths = assignedPaths.filter(path => !investigated.has(path));
  if (canonicalJson(receipt.coverage.assignedPaths) !== canonicalJson(sourcePathSetDigest(assignedPaths))
    || canonicalJson(receipt.coverage.investigatedPaths) !== canonicalJson(sourcePathSetDigest(investigatedPaths))
    || canonicalJson(receipt.coverage.remainingPaths) !== canonicalJson(sourcePathSetDigest(remainingPaths))) {
    return 'composed runtime resource path coverage disagrees with the trusted plan and source-delivery receipts';
  }
  if (input.result.coverageComplete && (receipt.engineExecutionState !== 'complete' || remainingPaths.length > 0)) {
    return 'worker claims complete coverage with incomplete composed execution or source delivery';
  }
  return null;
}

function groundedVerifierRouteRefusal(result: WorkerReviewResult, contract: TrustedReviewCoverageContract): string | null {
  const receipt = result.groundedReview;
  if (!receipt || receipt.version !== GROUNDED_REVIEW_RECEIPT_V2_VERSION) return null;
  const routing = contract.groundedVerifierRouting;
  const routes = receipt.verification.outcomes.filter((outcome) => outcome.verifierRoute !== undefined);
  if (!routing) return routes.length > 0 ? 'verifier route receipt lacks its trusted prepared model configuration' : null;
  if (typeof routing.primaryModel !== 'string' || !routing.primaryModel.trim()
    || (routing.disputedBlockerAdjudicatorModel !== undefined
      && (typeof routing.disputedBlockerAdjudicatorModel !== 'string' || !routing.disputedBlockerAdjudicatorModel.trim()))) {
    return 'trusted verifier route configuration is malformed';
  }
  const tuples = contract.authenticatedDisputes ?? [];
  const paths = new Set(contract.authenticatedDisputePaths ?? []);
  for (const outcome of receipt.verification.outcomes) {
    const exactDisputes = tuples.filter((tuple) => tuple.findingFingerprint === outcome.fingerprint);
    const disputed = (outcome.severity === 'P0' || outcome.severity === 'P1') && exactDisputes.length === 1
      && paths.has(outcome.path) && exactDisputes[0]!.priorFindingEventId.length > 0
      && /^[a-f0-9]{64}$/u.test(exactDisputes[0]!.priorEvidenceDigest);
    const route = outcome.verifierRoute;
    if (!route) {
      if (disputed && routing.disputedBlockerAdjudicatorModel && outcome.status !== 'insufficient') {
        return 'configured disputed-blocker adjudicator route is missing from verified outcome';
      }
      continue;
    }
    if (route.configuredAlternateModel !== (routing.disputedBlockerAdjudicatorModel ?? null)) {
      return 'worker disputed-blocker route disagrees with the service-prepared alternate model';
    }
    if (disputed) {
      if (route.purpose !== 'disputed-blocker-recheck' || route.requestedRole !== 'disputed-blocker-adjudicator') {
        return 'authenticated disputed blocker was not routed as a disputed-blocker recheck';
      }
      if (routing.disputedBlockerAdjudicatorModel) {
        if (route.appliedRole !== 'disputed-blocker-adjudicator'
          || route.selectedModel !== routing.disputedBlockerAdjudicatorModel) {
          return 'configured disputed blocker did not use the selected adjudicator route';
        }
      } else if (route.appliedRole !== 'primary' || route.selectedModel !== routing.primaryModel) {
        return 'unconfigured disputed-blocker route must stay on primary model';
      }
    } else if (route.purpose !== 'primary' || route.requestedRole !== 'primary' || route.appliedRole !== 'primary'
      || route.selectedModel !== routing.primaryModel) {
      return 'alternate verifier route lacks an exact authenticated disputed P0/P1 context';
    }
  }
  return null;
}

export interface TrustedReviewCoverageContract {
  /** The service-owned run identity that the authenticated worker result must exactly match. */
  expectedCoordinates: TrustedWorkerReviewCoordinates;
  /** Supplied by the service's trusted policy/config resolution, never by the worker. */
  expectedPersonaIds: readonly string[];
  /** Service-owned engine and effective paths. Dynamic task IDs are admitted only for composed. */
  reviewEngine?: 'panel' | 'composed' | 'shadow';
  /** Set only from the checked, service-prepared effective worker config. */
  reviewDecisionPolicy?: typeof REVIEW_SEVERITY_POLICY_V2;
  /** Authenticated DB/history resolution; worker history hints alone never grant continuity. */
  groundedHistory?: TrustedGroundedHistoryContext;
  /** Service-authenticated disputed finding identity and its affected path disclosure. */
  authenticatedDisputes?: readonly AuthenticatedDisputedBlockerV1[];
  authenticatedDisputePaths?: readonly string[];
  /** Effective model route from the service-prepared configuration, not worker self-report. */
  groundedVerifierRouting?: TrustedGroundedVerifierRouting;
  /** Actual pinned provider observations, independently fetched by authoritative completion context. */
  expectedImportResolutionSources?: readonly TrustedGroundedImportResolutionSourceV1[];
  /** Exact effective configuration receipt independently prepared by the service for composed mode. */
  composedEffectiveConfiguration?: ComposedRuntimeResources['configuration']['value'];
  composedChangedPaths?: readonly string[];
  composedMaxTasks?: number;
  /** Exact changed-file evidence already read by the service for the admitted head. */
  changedFiles: readonly ReviewChangedFile[];
  /**
   * ADR 0002: the bot's finding review threads, read by the service for this pull request. Absent
   * means none could be read, which leaves every in-diff P2 required.
   */
  findingThreads?: readonly PriorFindingThread[];
  /** Trusted service-side coverage and quorum decisions. */
  coverageComplete: boolean;
  quorumSatisfied: boolean;
  /**
   * REL-1084: true only when the service re-derived the incremental decision from its own prior
   * review record and GitHub reads and it permits every path the completion carried forward.
   * A completion that carries anything forward without this is refused.
   */
  incrementalVerified?: boolean;
  /**
   * ADR 0771: the service's own previous-head...head patches for the delta-scoped paths of a verified
   * incremental claim. Convergence narrows a P2 on these files to the lines the delta touched.
   */
  incrementalDeltaFiles?: ReadonlyArray<{ path: string; patch: string }>;
  /**
   * REL-1085: true only when the service re-derived the verdict-cache decision from its own
   * source record and GitHub reads and it permits every file the completion served from cache.
   * A completion that served anything from cache without this is refused.
   */
  verdictCacheVerified?: boolean;
  /**
   * REL-1139: the trusted applicability decision's disclosure counts for this exact head, from
   * the same `resolveReviewApplicability` the worker ran. Required before a completion that claims
   * a skipped moderator is accepted; absent refuses such a claim.
   */
  emptyModeration?: TrustedEmptyModerationDisclosures;
}

/** REL-1139: what the trusted side's applicability decision reports, as counts. */
export interface TrustedEmptyModerationDisclosures {
  truncatedFiles: number;
  unavailablePatches: number;
  omittedSourcePaths: number;
  routedFiles: number;
  uncoveredPaths: number;
}

/**
 * REL-1139: re-run the shared empty-moderation decision on trusted facts for a completion that
 * claims the moderator was skipped. Null when the claim stands (or there is none); otherwise the
 * refusal message. Facts the service cannot see (W2/W5/W6 depth reductions, analyzer hypotheses)
 * are the worker's own stricter checks; everything the service can see is re-decided here.
 */
function emptyModerationClaimRefusal(
  result: WorkerReviewResult,
  contract: TrustedReviewCoverageContract,
  expectedPersonaIds: readonly string[],
  changedFiles: readonly ReviewChangedFile[],
  coverageComplete: boolean,
  canonical: CanonicalArbitration,
): string | null {
  if (result.moderation === undefined) return null;
  const disclosures = contract.emptyModeration;
  if (!disclosures) return 'worker skipped the moderator but the trusted context carries no empty-moderation disclosures';
  const decision = decideEmptyModeration({
    expectedLaneIds: expectedPersonaIds,
    lanes: result.personas.filter((persona) => persona.evidenceSource !== 'shadow'),
    failedLaneCount: 0,
    coverageComplete: coverageComplete && contract.quorumSatisfied === true && result.quorumSatisfied === true,
    changedPaths: changedFiles.map((file) => file.path),
    truncatedFiles: disclosures.truncatedFiles,
    unavailablePatches: disclosures.unavailablePatches,
    omittedSourcePaths: disclosures.omittedSourcePaths,
    routedFiles: disclosures.routedFiles,
    uncoveredPaths: disclosures.uncoveredPaths,
    reducedDepthEntries: 0,
    incrementalCarriedFiles: result.incremental?.carriedForwardPaths.length ?? 0,
    verdictCacheServedFiles: result.verdictCache?.hits?.paths.length ?? 0,
    analyzerHypotheses: 0,
  });
  if (!decision.eligible) return `worker skipped the moderator on a run the shared decision does not allow (${decision.reason})`;
  if (canonical.verdict !== 'SHIP') return `worker skipped the moderator but the canonical verdict is ${canonical.verdict}`;
  return null;
}

export interface DerivedWorkerReviewEvidence {
  valid: true;
  canonical: CanonicalArbitration;
  evidence: ReviewGateEvidence;
  /** History hints that match both the verified current outcome and the trusted DB projection. */
  groundedContinuity?: GroundedFindingContinuityV1[];
  /** Lifecycle transitions reduced from exact current proof plus trusted DB/repository proof. */
  groundedTransitions?: GroundedLifecycleTransitionV1[];
}

export interface InvalidWorkerReviewEvidence {
  valid: false;
  reason: 'invalid-evidence';
  message: string;
  canonical?: CanonicalArbitration;
  evidence?: ReviewGateEvidence;
}

export type WorkerReviewEvidenceDerivation = DerivedWorkerReviewEvidence | InvalidWorkerReviewEvidence;

export type WorkerReviewCompletionErrorCode = 'payload-too-large' | 'invalid-schema' | 'invalid-contract';

export class WorkerReviewCompletionError extends Error {
  constructor(public readonly code: WorkerReviewCompletionErrorCode, message: string) {
    super(message);
    this.name = 'WorkerReviewCompletionError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function serializedByteLength(value: unknown): number {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new WorkerReviewCompletionError('invalid-schema', 'worker review completion must be JSON-serializable');
  }
  if (typeof serialized !== 'string') {
    throw new WorkerReviewCompletionError('invalid-schema', 'worker review completion must be a JSON value');
  }
  // MAX_COMPLETION_BYTES applies to the complete serialized UTF-8 JSON document,
  // not to any one text field. Individual text fields use JavaScript string-length limits.
  return Buffer.byteLength(serialized, 'utf8');
}

function issuePath(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue ? `${issue.path.join('.')} ${issue.message}`.trim() : 'schema validation failed';
}

function validateChangedFiles(changedFiles: readonly ReviewChangedFile[]): ReviewChangedFile[] {
  if (!Array.isArray(changedFiles) || changedFiles.length === 0 || changedFiles.length > MAX_CHANGED_FILES) {
    throw new WorkerReviewCompletionError('invalid-contract', 'trusted changed-file coverage must contain one or more bounded files');
  }
  return changedFiles.map((file, index) => {
    if (!file || typeof file.path !== 'string' || file.path.length === 0 || file.path.length > MAX_PATH_CHARACTERS) {
      throw new WorkerReviewCompletionError('invalid-contract', `trusted changed file ${index} has an invalid path`);
    }
    if (file.patch !== undefined && (typeof file.patch !== 'string' || Buffer.byteLength(file.patch, 'utf8') > MAX_CHANGED_FILE_PATCH_BYTES)) {
      throw new WorkerReviewCompletionError('invalid-contract', `trusted changed file ${index} patch exceeds its bound`);
    }
    return { ...file };
  });
}

function validateCoverageContract(contract: TrustedReviewCoverageContract): string[] {
  if (!contract || !Array.isArray(contract.expectedPersonaIds) || contract.expectedPersonaIds.length === 0 || contract.expectedPersonaIds.length > MAX_PERSONAS) {
    throw new WorkerReviewCompletionError('invalid-contract', 'trusted expected persona IDs are required and bounded');
  }
  const expected = contract.expectedPersonaIds.map((id) => {
    if (typeof id !== 'string' || !TASK_ID_PATTERN.test(id)) {
      throw new WorkerReviewCompletionError('invalid-contract', 'trusted expected persona ID is invalid');
    }
    return id;
  });
  if (new Set(expected).size !== expected.length) {
    throw new WorkerReviewCompletionError('invalid-contract', 'trusted expected persona IDs must be unique');
  }
  if (typeof contract.coverageComplete !== 'boolean' || typeof contract.quorumSatisfied !== 'boolean') {
    throw new WorkerReviewCompletionError('invalid-contract', 'trusted coverage contract booleans are required');
  }
  if (contract.reviewDecisionPolicy !== undefined && contract.reviewDecisionPolicy !== REVIEW_SEVERITY_POLICY_V2) {
    throw new WorkerReviewCompletionError('invalid-contract', 'trusted review decision policy is unsupported');
  }
  validateChangedFiles(contract.changedFiles);
  return expected;
}

function validateTrustedCoordinates(input: unknown): TrustedWorkerReviewCoordinates {
  const parsed = completionCoordinatesSchema.safeParse(input);
  if (!parsed.success) {
    throw new WorkerReviewCompletionError('invalid-contract', `trusted review coordinates are invalid: ${issuePath(parsed.error)}`);
  }
  return parsed.data;
}

const coordinateKeys: readonly (keyof TrustedWorkerReviewCoordinates)[] = [
  'runId', 'repositoryId', 'owner', 'repo', 'prNumber', 'headSha', 'baseSha',
  'policyDigest', 'configDigest', 'executionAttempt',
];

function coordinatesMatch(completion: WorkerReviewCompletion, expected: TrustedWorkerReviewCoordinates): boolean {
  return coordinateKeys.every((key) => completion[key] === expected[key]);
}

/** Parse the authenticated success payload before any result is treated as review evidence. */
export function parseWorkerReviewCompletion(input: unknown): WorkerReviewCompletion {
  if (!isRecord(input)) {
    throw new WorkerReviewCompletionError('invalid-schema', 'worker review completion must be a JSON object');
  }
  if (serializedByteLength(input) > MAX_COMPLETION_BYTES) {
    throw new WorkerReviewCompletionError('payload-too-large', `worker review completion exceeds ${MAX_COMPLETION_BYTES} bytes`);
  }
  const parsed = completionSchema.safeParse(input);
  if (!parsed.success) {
    throw new WorkerReviewCompletionError('invalid-schema', `invalid WorkerReviewCompletion.v1: ${issuePath(parsed.error)}`);
  }
  return parsed.data;
}

function invalidEvidence(
  message: string,
  canonical?: CanonicalArbitration,
  evidence?: ReviewGateEvidence,
): InvalidWorkerReviewEvidence {
  return { valid: false, reason: 'invalid-evidence', message, ...(canonical ? { canonical } : {}), ...(evidence ? { evidence } : {}) };
}

function hasInfrastructureFailure(persona: WorkerReviewPersonaEvidence): boolean {
  return persona.decision === 'ERROR' || persona.status === 'ERROR' || persona.errorClass !== undefined;
}

function isDocumentationOnlyCompletion(result: WorkerReviewResult): boolean {
  if (result.personas.length !== 1) return false;
  const lane = result.personas[0];
  return lane?.id === 'documentation-only'
    && lane.decision === 'APPROVE'
    && lane.status === 'COMPLETE'
    && lane.findings.length === 0;
}

function noReviewableContentAuditDigest(
  coordinates: TrustedWorkerReviewCoordinates,
  changedFiles: readonly ReviewChangedFile[],
): string {
  return sha256(canonicalJson({
    version: 'NoReviewableContentAudit.v1',
    repositoryId: coordinates.repositoryId,
    prNumber: coordinates.prNumber,
    headSha: coordinates.headSha,
    baseSha: coordinates.baseSha,
    policyDigest: coordinates.policyDigest,
    configDigest: coordinates.configDigest,
    paths: changedFiles.map((file) => file.path),
  }));
}

function rawFieldsMatchCanonical(result: WorkerReviewResult, canonical: CanonicalArbitration): string | null {
  if (result.verdict !== undefined && result.verdict !== canonical.verdict) {
    return `worker verdict ${result.verdict} disagrees with canonical verdict ${canonical.verdict}`;
  }
  if (result.findingCount !== undefined && result.findingCount !== canonical.metrics.totalFindings) {
    return `worker finding count ${result.findingCount} disagrees with canonical count ${canonical.metrics.totalFindings}`;
  }
  const blockingCount = canonical.metrics.p0Count + canonical.metrics.p1Count;
  if (result.blockingFindingCount !== undefined && result.blockingFindingCount !== blockingCount) {
    return `worker blocking finding count ${result.blockingFindingCount} disagrees with canonical count ${blockingCount}`;
  }
  return null;
}

/**
 * The one canonical arbitration of a completion's persona lanes: strict finding validation, then
 * `computeAppVerdict`. `deriveCanonicalWorkerReviewEvidence` (the gate) and
 * `deriveStoredCompletionVerdict` (a stored prior review, REL-1084/REL-1085) both call it, so the
 * verdict a later run relies on is computed exactly as the gate computed it.
 */
function arbitrateLanes(
  personas: readonly WorkerReviewPersonaEvidence[],
  expectedLanes: number,
  coverageComplete: boolean,
  changedFiles: ReviewChangedFile[] | undefined,
  composed = false,
  severityPolicyVersion?: typeof REVIEW_SEVERITY_POLICY_V2,
): { valid: true; canonical: CanonicalArbitration } | { valid: false; message: string } {
  const lanes: ReviewLane[] = [];
  for (const persona of personas) {
    const validation = validateReviewFindings(persona.findings, changedFiles);
    if (!validation.valid) {
      const suffix = validation.index === undefined ? '' : ` at index ${validation.index}`;
      return { valid: false, message: `invalid findings for persona ${persona.id}${suffix}: ${validation.error || 'unknown error'}` };
    }
    lanes.push({
      id: persona.id,
      decision: persona.decision,
      ...(persona.status ? { status: persona.status } : {}),
      findings: validation.findings as ReviewFinding[],
    });
  }
  return { valid: true, canonical: computeAppVerdict({ lanes, expectedLanes, changedFiles, coverageComplete,
    ...(composed ? { panelSize: 1 } : {}), ...(severityPolicyVersion ? { severityPolicyVersion } : {}) }) };
}

/**
 * REL-1084/REL-1085: the canonical verdict of a completion the service already accepted and
 * stored, for deciding whether a later run may rest on it. The worker's optional `result.verdict`
 * is never read (the authoritative worker does not even set it). The two trusted inputs the gate
 * took from its live coverage contract come from the gate's own stored evidence for this exact
 * completion: how many lanes the service required, whether coverage was complete, and whether
 * the service verified a composed review. Older records without an engine are panel records.
 *
 * The changed files' patch text is not stored, so findings are validated without it. That can
 * only keep a finding the gate dropped as unanchored, never drop one the gate kept, so this is
 * never more lenient than the gate. Null when the lanes do not validate.
 */
export function deriveStoredCompletionVerdict(
  result: WorkerReviewResult,
  trusted: { expectedLanes: number; coverageComplete: boolean; reviewEngine?: 'composed';
    reviewDecisionPolicy?: typeof REVIEW_SEVERITY_POLICY_V2; policyDigest?: string },
): CanonicalArbitration | null {
  if (!Number.isSafeInteger(trusted.expectedLanes) || trusted.expectedLanes <= 0) return null;
  if ((trusted.reviewDecisionPolicy === REVIEW_SEVERITY_POLICY_V2) !== (result.reviewDecision !== undefined)) return null;
  if (result.reviewDecision && (trusted.reviewDecisionPolicy !== REVIEW_SEVERITY_POLICY_V2 || !trusted.policyDigest)) return null;
  const composed = trusted.reviewEngine === 'composed';
  if (composed) {
    if (!composedPlanLaneIds(result.taskPlan, result.personas, trusted.expectedLanes).valid) return null;
  } else if (result.taskPlan) {
    return null;
  }
  // Shadow lanes never gated a verdict; the authoritative completion never carries them.
  const gating = result.personas.filter((persona) => persona.evidenceSource !== 'shadow');
  if (new Set(gating.map((persona) => persona.id)).size !== gating.length) return null;
  const arbitration = arbitrateLanes(gating, trusted.expectedLanes,
    trusted.coverageComplete === true && result.coverageComplete, undefined, composed, trusted.reviewDecisionPolicy);
  if (!arbitration.valid) return null;
  if (result.reviewDecision) {
    const expected = createReviewDecisionV2({
      schemaVersion: result.reviewDecision.schemaVersion,
      policyVersion: REVIEW_SEVERITY_POLICY_V2,
      policyDigest: trusted.policyDigest!,
      coverageComplete: trusted.coverageComplete === true && result.coverageComplete,
      quorumSatisfied: arbitration.canonical.quorumSatisfied && result.quorumSatisfied,
      infrastructureFailure: gating.some(hasInfrastructureFailure),
      expectedLanes: trusted.expectedLanes,
      completedLanes: arbitration.canonical.completedPersonas,
      counts: {
        p0Count: arbitration.canonical.metrics.p0Count, p1Count: arbitration.canonical.metrics.p1Count,
        p2Count: arbitration.canonical.metrics.p2Count, p3Count: arbitration.canonical.metrics.p3Count,
        nitCount: arbitration.canonical.metrics.nitCount,
      },
    });
    if (canonicalJson(expected) !== canonicalJson(result.reviewDecision)) return null;
  }
  return arbitration.canonical;
}

/** Same plan-to-lane admission for live completions and stored prior rechecks. */
function composedPlanLaneIds(
  plan: readonly Pick<ReviewTask, 'id'>[] | undefined,
  personas: readonly WorkerReviewPersonaEvidence[],
  expectedLanes: number,
): { valid: true; ids: string[] } | { valid: false; message: string } {
  if (!plan || plan.length !== expectedLanes) {
    return { valid: false, message: 'composed task plan lane count mismatch' };
  }
  const ids = plan.map((task) => task.id);
  const allowed = new Set(ids);
  if (allowed.size !== ids.length) return { valid: false, message: 'duplicate composed task id' };
  const seen = new Set<string>();
  for (const persona of personas) {
    if (seen.has(persona.id)) return { valid: false, message: `duplicate persona lane: ${persona.id}` };
    if (!allowed.has(persona.id)) return { valid: false, message: `unknown persona lane: ${persona.id}` };
    seen.add(persona.id);
  }
  return { valid: true, ids };
}

/**
 * REL-1084/REL-1085: the gate attempt row that recorded a stored completion
 * (`review_gate_attempts.worker_result_digest/evidence/decision`), as selected beside it. The
 * writer is `PostgresReviewGateRepository.recordWorkerResult`, which stores the
 * `ReviewGateEvidence` from `deriveCanonicalWorkerReviewEvidence` and the `ReviewGateDecision`
 * from `evaluateReviewGate`; `storedCompletionShipComplete` below is its one reader.
 */
export interface StoredGateRecord { worker_result_digest: unknown; evidence: unknown; decision: unknown }

function jsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return undefined; }
}

// Typed against the gate's own vocabulary, so a rename there fails to compile here.
const CLEAN_REVIEW_DECISION: Extract<ReviewGateDecision, { status: 'success' }>['reason'] = 'clean-review';
const SHIP_VERDICT: ReviewGateEvidence['verdict'] = 'SHIP';

/**
 * REL-1084/REL-1085: why a stored prior review is not SHIP-complete, one code per failed check.
 * Logged and disclosed in the incremental / verdict-cache "full review, because" line, so a
 * refused prior can be diagnosed from the check summary and logs alone.
 */
export const STORED_PRIOR_REFUSALS = [
  // Set by `priorReviewRecordFromRows` before this predicate runs.
  'run-not-succeeded',
  // An authoritative-gate run never rests on a record the gate did not decide.
  'no-gate-evidence-record',
  // Non-authoritative WorkerReviewEvidence priors (`storedEvidenceShipCompleteReason`).
  'evidence-prior-run-authoritative',
  'evidence-conclusion-not-success',
  'evidence-roster-unknown',
  'evidence-roster-mismatch',
  'evidence-exemption',
  // Set by `storedCompletionShipCompleteReason`.
  'gate-row-missing',
  'gate-row-mismatch',
  'gate-record-unreadable',
  'gate-not-clean',
  'gate-exemption',
  'gate-lane-missing',
  'gate-incomplete',
  'gate-infrastructure-failure',
  'gate-not-ship',
  'worker-quorum-unmet',
  'worker-coverage-incomplete',
  'blocking-finding',
  'rederived-invalid',
  'lane-failed',
  'lane-missing',
  'rederived-not-ship',
] as const;
export type StoredPriorRefusal = typeof STORED_PRIOR_REFUSALS[number];

/**
 * The severity a finding is published with, through `publishFinding`: the same function
 * `computeArbitration` applies to every finding before clustering. A cluster's severity is the
 * highest its members keep after it, so a finding published as P2 never made any published
 * finding P0/P1.
 */
export function publishedFindingSeverity(finding: { severity: string; title?: string; body?: string }): string {
  return publishFinding(finding as ReviewFinding).severity;
}

/**
 * REL-1084/REL-1085: whether a stored authoritative completion was a complete SHIP review; null
 * when it was, otherwise the first check that refused it.
 *
 * The verdict is derived, never read from the worker's optional `result.verdict`. Two
 * service-side sources must both say SHIP:
 *
 * - the gate's own record of THIS completion (the attempt whose `worker_result_digest` is the
 *   stored content digest): a `clean-review` success whose evidence, computed by
 *   `deriveCanonicalWorkerReviewEvidence` from the service's trusted lane set, is SHIP with every
 *   required lane completed, coverage and quorum met and no P0/P1. A `human-accepted-risk`
 *   success is a FIX_FIRST review and never qualifies;
 * - the canonical verdict re-derived from the stored lanes with the gate's required lane count
 *   (`deriveStoredCompletionVerdict`, the same arbitration the gate ran).
 *
 * Blocking findings are judged at their PUBLISHED severity (`publishedFindingSeverity`), on every
 * lane including shadow lanes: a P0/P1 that survived calibration disqualifies; a raw P1 that
 * calibration re-filed as P2 does not (review-yeti-bot#1034, 82381c85). That is safe because every
 * file with any finding, of any severity, is always re-reviewed in full (`findingPaths`), so
 * the downgraded finding's file is never carried forward.
 *
 * Also refused: an error lane, and an audited no-reviewable-content exemption (it reviewed nothing
 * to carry forward; the gate records it with zero required lanes and an `exemption`).
 */
export function storedCompletionShipCompleteReason(
  result: WorkerReviewResult,
  gate: StoredGateRecord | null | undefined,
  storedDigest: string,
): StoredPriorRefusal | null {
  if (!gate) return 'gate-row-missing';
  if (String(gate.worker_result_digest ?? '') !== storedDigest) return 'gate-row-mismatch';
  const evidence = jsonValue(gate.evidence);
  const decision = jsonValue(gate.decision);
  if (!isRecord(evidence) || !isRecord(decision)) return 'gate-record-unreadable';
  if (decision.status !== 'success' || decision.reason !== CLEAN_REVIEW_DECISION) return 'gate-not-clean';
  if (evidence.exemption != null) return 'gate-exemption';
  const expectedLanes = evidence.expectedLanes;
  if (typeof expectedLanes !== 'number' || !Number.isSafeInteger(expectedLanes) || expectedLanes <= 0) {
    return 'gate-record-unreadable';
  }
  if (evidence.completedLanes !== expectedLanes) return 'gate-lane-missing';
  if (evidence.coverageComplete !== true || evidence.quorumSatisfied !== true) return 'gate-incomplete';
  if (evidence.infrastructureFailure !== false) return 'gate-infrastructure-failure';
  // ADR 0002: the one read-time normalization of a historical record. A gate row written before
  // the required-P2 policy has no p2Count; its decision (above) already encodes what that policy
  // allowed, so absent reads as zero here and nowhere else.
  const p2Count = evidence.p2Count === undefined ? 0 : evidence.p2Count;
  if (evidence.verdict !== SHIP_VERDICT || evidence.p0Count !== 0 || evidence.p1Count !== 0
    || p2Count !== 0) return 'gate-not-ship';
  return storedLanesRefusal(result, expectedLanes, evidence.reviewEngine === 'composed' ? 'composed' : undefined);
}

/**
 * The lane half of both prior predicates: the stored lanes, re-derived with `expectedLanes`
 * required lanes through the same arbitration as the published verdict, must be a complete SHIP
 * with no P0/P1 at published severity on any lane.
 */
function storedLanesRefusal(result: WorkerReviewResult, expectedLanes: number, reviewEngine?: 'composed'): StoredPriorRefusal | null {
  if (result.quorumSatisfied !== true) return 'worker-quorum-unmet';
  if (result.coverageComplete !== true) return 'worker-coverage-incomplete';
  if (result.personas.some((persona) => persona.findings.some((finding) => {
    const severity = publishedFindingSeverity(finding);
    return severity === 'P0' || severity === 'P1';
  }))) return 'blocking-finding';
  // Quorum there needs exactly that many lanes, none failed (error lanes included) and complete
  // coverage, so a missing, extra, duplicate or failed lane is refused.
  const canonical = deriveStoredCompletionVerdict(result, { expectedLanes, coverageComplete: true, reviewEngine });
  if (canonical === null) return 'rederived-invalid';
  const gating = result.personas.filter((persona) => persona.evidenceSource !== 'shadow');
  if (gating.some((persona) => persona.decision === 'ERROR' || persona.status === 'ERROR')) return 'lane-failed';
  if (!canonical.quorumSatisfied || canonical.completedPersonas !== expectedLanes) return 'lane-missing';
  if (canonical.verdict !== 'SHIP') return 'rederived-not-ship';
  return null;
}

/**
 * REL-1084: whether a stored non-authoritative WorkerReviewEvidence record (the worker published
 * its own Review Yeti check; no service gate) was a complete SHIP review. Only a non-authoritative
 * run may rest on one (`priorReviewRecordFromRows`). Requires, from the stored evidence alone:
 *
 * - the published check conclusion for that exact head was `success`;
 * - the configured lane roster the worker's verdict required (`result.roster`); a record without
 *   it cannot show that no lane is missing and is refused;
 * - every gating lane is a roster lane, once, and every roster lane is present
 *   (`evidence-roster-mismatch` / `lane-missing`);
 * - the verdict re-derived from the stored lanes with the roster size as the required lane
 *   count is SHIP, with no P0/P1 at published severity and no failed lane (`storedLanesRefusal`).
 *
 * Head, base and digests are bound to the run row and the policy/config digests are compared by
 * the shared decision, as for authoritative priors.
 */
export function storedEvidenceShipCompleteReason(
  result: WorkerReviewResult,
  conclusion: 'success' | 'failure',
): StoredPriorRefusal | null {
  if (conclusion !== 'success') return 'evidence-conclusion-not-success';
  const gating = result.personas.filter((persona) => persona.evidenceSource !== 'shadow');
  if (gating.length === 1 && gating[0].id === 'documentation-only') return 'evidence-exemption';
  const roster = result.roster;
  if (!roster || roster.length === 0) return 'evidence-roster-unknown';
  const rosterIds = new Set(roster);
  const seen = new Set<string>();
  for (const lane of gating) {
    if (!rosterIds.has(lane.id) || seen.has(lane.id)) return 'evidence-roster-mismatch';
    seen.add(lane.id);
  }
  if (roster.some((id) => !seen.has(id))) return 'lane-missing';
  return storedLanesRefusal(result, roster.length);
}

function groundedReviewReceiptV2Error(input: { receipt: GroundedReviewReceiptV2; result: WorkerReviewResult;
  changedFiles: readonly ReviewChangedFile[]; headSha: string; baseSha: string; repository: string;
  expectedImportResolutionSources?: readonly TrustedGroundedImportResolutionSourceV1[] }): string | null {
  const { receipt, result, changedFiles, headSha, baseSha, repository } = input;
  if (receipt.semanticsVersion !== GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION
    || receipt.verification.semanticsVersion !== GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION) {
    return 'grounded v2 evidence semantics version is unsupported';
  }
  if (receipt.verification.coverageComplete !== (receipt.coverage.complete && receipt.verification.unverifiedBlockerCount === 0)) {
    return 'grounded v2 coverage status is inconsistent';
  }
  if (result.coverageComplete && (!receipt.coverage.complete || !receipt.verification.coverageComplete)) {
    return 'worker claims complete coverage with an unverified v2 blocker or source gap';
  }
  const changedByPath = new Map(changedFiles.map((file) => [file.path, file]));
  const workerResolutionSources = new Map((receipt.verification.sourceResolutionProbeManifest ?? []).map((source) =>
    [`${source.repository}\u0000${source.revisionSha}\u0000${source.path}`, source] as const));
  const trustedResolutionSources = new Map<string, TrustedGroundedImportResolutionSourceV1>();
  const expectedResolutionSources = input.expectedImportResolutionSources;
  if (expectedResolutionSources) {
    let previousKey = '';
    for (const source of expectedResolutionSources) {
      const key = `${source.repository}\u0000${source.revisionSha}\u0000${source.path}`;
      if (source.repository !== repository || ![headSha, baseSha].includes(source.revisionSha)
        || !source.path || source.path.startsWith('/') || source.path.split('/').some((part) => part === '' || part === '.' || part === '..')
        || !['present', 'absent', 'unavailable'].includes(source.presence)
        || (source.presence === 'present' ? !/^[a-f0-9]{64}$/u.test(source.sourceDigest ?? '') : source.sourceDigest !== null)
        || (previousKey && key <= previousKey) || trustedResolutionSources.has(key)) {
        return 'trusted pinned source-resolution context is malformed or unsorted';
      }
      previousKey = key;
      trustedResolutionSources.set(key, source);
    }
  }
  const candidateManifest = receipt.verification.candidateManifest;
  if (receipt.verification.candidates > 0 && !candidateManifest) {
    return 'grounded v2 receipt lacks the original pre-filter candidate severity manifest';
  }
  const candidateSeverityByFingerprint = new Map(candidateManifest?.map((candidate) =>
    [candidate.fingerprint, candidate.severity] as const) ?? []);
  for (const outcome of receipt.verification.outcomes) {
    if (candidateSeverityByFingerprint.get(outcome.fingerprint) !== outcome.severity) {
      return 'grounded v2 outcome severity disagrees with its original engine candidate';
    }
  }
  const currentFindings = result.personas.filter((persona) => persona.evidenceSource !== 'shadow')
    .flatMap((persona) => persona.findings).map((finding) => {
    const claimType = findingClaimType({ path: finding.path, title: finding.title });
    return { fingerprint: findingFingerprintForClaimType({ path: finding.path, title: finding.title }, claimType),
      severity: publishFinding(finding as ReviewFinding, { severityPolicyVersion: REVIEW_SEVERITY_POLICY_V2 }).severity, finding };
  });
  const findingsByFingerprint = new Map<string, typeof currentFindings>();
  for (const row of currentFindings) {
    const rows = findingsByFingerprint.get(row.fingerprint) ?? [];
    rows.push(row);
    findingsByFingerprint.set(row.fingerprint, rows);
  }
  const exactCurrentLaneFinding = (fingerprint: string, severity: string) =>
    (findingsByFingerprint.get(fingerprint) ?? []).some((row) => row.severity === severity);
  for (const row of currentFindings) {
    if ((row.severity === 'P0' || row.severity === 'P1')
      && !receipt.verification.outcomes.some((outcome) => outcome.fingerprint === row.fingerprint
        && outcome.severity === row.severity && outcome.status === 'confirmed')) {
      return 'current blocking finding lacks an exact normalized v2 verification outcome';
    }
  }
  let recomputedUnverifiedBlockers = 0;
  for (const outcome of receipt.verification.outcomes) {
    const normalizedClaimType = findingClaimType({ path: outcome.path, title: outcome.title });
    if (outcome.claimType !== normalizedClaimType
      || findingFingerprintForClaimType({ path: outcome.path, title: outcome.title }, outcome.claimType) !== outcome.fingerprint) {
      return 'grounded v2 outcome identity does not match its normalized lane claim';
    }
    const sameIdentityFindings = findingsByFingerprint.get(outcome.fingerprint) ?? [];
    if (sameIdentityFindings.length > 0 && !exactCurrentLaneFinding(outcome.fingerprint, outcome.severity)) {
      return 'grounded v2 outcome severity does not match its normalized current lane finding';
    }
    const changed = changedByPath.get(outcome.path);
    if (!changed || outcome.relatedDiffPaths.some((path) => !changedByPath.has(path))
      || new Set(outcome.relatedDiffPaths).size !== outcome.relatedDiffPaths.length) {
      return 'grounded v2 outcome references source outside the trusted changed set';
    }
    const currentAffectedContextDigest = groundedAffectedContextDigest(outcome, changedFiles, outcome.relatedDiffPaths);
    if (currentAffectedContextDigest !== outcome.affectedContextDigest) return 'grounded v2 outcome context is stale';
    if (outcome.status === 'insufficient') {
      if (outcome.severity === 'P0' || outcome.severity === 'P1') recomputedUnverifiedBlockers += 1;
      if (exactCurrentLaneFinding(outcome.fingerprint, outcome.severity)) return 'unverified v2 outcome remains in published findings';
      continue;
    }
    const candidateProof = typeof changed.patch === 'string' && outcome.candidateSide
      ? groundedCandidateHunkProof({ patch: changed.patch, candidateLine: outcome.line, candidateSide: outcome.candidateSide }) : null;
    if (!candidateProof) return 'grounded v2 candidate line has no unique exact added/deleted hunk mapping';
    const evidence = outcome.evidence!;
    let recomputedScope: FindingChangeScopeDecision | undefined;
    const citations = evidence.citations as GroundedCitationV2[];
    if (evidence.semanticsVersion !== GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION
      || groundedCitationManifestDigest(citations) !== evidence.sourceWindowManifestDigest) {
      return 'grounded v2 outcome manifest or semantics digest is invalid';
    }
    const citationsById = new Map(citations.map((citation) => [citation.id, citation]));
    if (citationsById.size !== citations.length || evidence.usedCitationIds.some((id) => !citationsById.has(id))) {
      return 'grounded v2 citation allow-list contains duplicate or unresolved references';
    }
    for (const citation of citations) {
      if (!isValidGroundedCitationV2(citation) || citation.repository !== repository
        || citation.headSha !== headSha || citation.baseSha !== baseSha
        || citation.revisionSha !== (citation.side === 'base' ? baseSha : headSha)) {
        return 'grounded v2 citation is not bound to the trusted repository revisions';
      }
      if (citation.presence === 'absent') {
        const marker = changedByPath.get(citation.path)?.sourcePresence;
        if (!marker || marker.repository !== repository || marker.path !== citation.path
          || marker.headSha !== headSha || marker.baseSha !== baseSha || marker.absentSide !== citation.side
          || marker.patchDigest !== sha256(changedByPath.get(citation.path)?.patch ?? '')
          || sha256(canonicalJson(marker)) !== citation.sourceDigest) {
          return 'grounded v2 absence citation is not bound to trusted source-presence evidence';
        }
      }
      if (citation.side === 'diff') {
        const file = changedByPath.get(citation.path);
        if (!file || typeof file.patch !== 'string'
          || citation.sourceDigest !== sha256Bytes(Buffer.from(file.patch, 'utf8'))) {
          return 'grounded v2 diff citation does not match the exact admitted patch';
        }
        const expectedRegionDigest = citation.path === outcome.path ? candidateProof.regionDigest : groundedPatchRegionDigest(file.patch);
        if (!expectedRegionDigest || citation.regionDigest !== expectedRegionDigest) {
          return 'grounded v2 diff region does not match the admitted patch hunk manifest';
        }
      }
    }

    const sourceBytesBySide = new Map<string, number>();
    const evidencePaths = new Set<string>();
    const contractIds = new Set<string>();
    let totalEvidenceBytes = 0;
    for (const citation of citations) {
      evidencePaths.add(citation.path);
      if (citation.window) {
        const key = `${citation.path}:${citation.side}`;
        const next = (sourceBytesBySide.get(key) ?? 0) + citation.window.byteLength;
        sourceBytesBySide.set(key, next);
        if (next > MAX_CHANGED_FILE_PATCH_BYTES) return 'grounded v2 windows exceed the existing per-file-side byte limit';
        totalEvidenceBytes += citation.window.byteLength;
        if (citation.window.role === 'dependency-contract' && citation.window.mapping.kind === 'dependency-contract') {
          const edge = citation.window.mapping.edge;
          contractIds.add(`${edge.importerPath}:${edge.importSpecifier}`);
          const forwardEdge = edge.importerPath === outcome.path && edge.resolvedPath === citation.path;
          const deletedContractReverseEdge = outcome.candidateSide === 'base' && edge.resolvedPath === outcome.path
            && edge.resolvedPath === citation.path && edge.importerPath !== outcome.path && citation.side === 'base';
          if (!forwardEdge && !deletedContractReverseEdge) return 'grounded v2 dependency edge has the wrong caller/contract paths';
          if (deletedContractReverseEdge && !groundedImportResolutionMatches({ edge, revisionSha: baseSha,
            repository, expected: { state: 'resolved', path: outcome.path },
            workerSources: workerResolutionSources, trustedSources: trustedResolutionSources })
            && (outcome.severity === 'P0' || outcome.severity === 'P1')) {
            return 'material deleted-contract evidence does not prove the unique active base import target';
          }
          const importerCitation = citations.find((candidate) => candidate.window && candidate.path === edge.importerPath
            && candidate.side === edge.importerSide && candidate.window.fullContentSha256 === edge.importerFullContentSha256
            && candidate.window.role === 'dependency-caller' && candidate.window.mapping.kind === 'dependency-contract'
            && canonicalJson(candidate.window.mapping.edge) === canonicalJson(edge));
          if (!importerCitation) return 'grounded v2 dependency edge lacks its exact importer source identity';
          if (deletedContractReverseEdge) {
            const headCaller = citations.find((candidate) => candidate.window && candidate.path === edge.importerPath
              && candidate.side === 'head' && candidate.window.role === 'dependency-caller'
              && candidate.window.mapping.kind === 'dependency-contract');
            if (edge.importerSide !== 'base' || !headCaller?.window || headCaller.window.fullContentSha256 !== edge.importerFullContentSha256) {
              return 'deleted-contract evidence lacks the exact unchanged caller on the current head';
            }
            const currentEdge = headCaller.window.mapping.kind === 'dependency-contract' ? headCaller.window.mapping.edge : null;
            if (!currentEdge) return 'deleted-contract evidence lacks its current caller edge';
            if (!groundedImportResolutionMatches({ edge: currentEdge, revisionSha: headSha,
              repository, expected: { state: 'unresolved' },
              workerSources: workerResolutionSources, trustedSources: trustedResolutionSources })
              && (outcome.severity === 'P0' || outcome.severity === 'P1')) {
              return 'material deleted-contract evidence does not prove absence of every current import target';
            }
            const baseLink = { importerPath: edge.importerPath, importSpecifier: edge.importSpecifier,
              contractSymbols: edge.contractSymbols, resolvedPath: edge.resolvedPath,
              contractFullContentSha256: edge.contractFullContentSha256,
              definitionStartLine: edge.definitionStartLine, definitionEndLine: edge.definitionEndLine,
              definitionSha256: edge.definitionSha256, importStatementDigest: edge.importStatementDigest,
              originRegionDigest: edge.originRegionDigest };
            const headLink = currentEdge && { importerPath: currentEdge.importerPath, importSpecifier: currentEdge.importSpecifier,
              contractSymbols: currentEdge.contractSymbols, resolvedPath: currentEdge.resolvedPath,
              contractFullContentSha256: currentEdge.contractFullContentSha256,
              definitionStartLine: currentEdge.definitionStartLine, definitionEndLine: currentEdge.definitionEndLine,
              definitionSha256: currentEdge.definitionSha256, importStatementDigest: currentEdge.importStatementDigest,
              originRegionDigest: currentEdge.originRegionDigest };
            if (currentEdge.importerSide !== 'head' || canonicalJson(baseLink) !== canonicalJson(headLink)) {
              return 'deleted-contract evidence has a stale or different current caller edge';
            }
          }
          if (edge.resolvedPath !== citation.path || edge.contractFullContentSha256 !== citation.window.fullContentSha256
            || edge.definitionStartLine > citation.window.endLine || edge.definitionEndLine < citation.window.startLine) {
            return 'grounded v2 contract window does not cover the resolved definition';
          }
        }
      }
      if (citation.side === 'diff') totalEvidenceBytes += Buffer.byteLength(changedByPath.get(citation.path)?.patch ?? '', 'utf8');
    }
    if (sourceBytesBySide.size > 26 || totalEvidenceBytes > 180_000 || evidencePaths.size > 13 || contractIds.size > 12) {
      return 'grounded v2 evidence exceeds an existing file, import, or aggregate byte bound';
    }

    const candidateWindowCitation = citations.find((citation) => citation.path === outcome.path
      && citation.side === outcome.candidateSide && citation.window?.role === 'candidate');
    const oppositeSide = outcome.candidateSide === 'head' ? 'base' : 'head';
    const counterpartCitation = citations.find((citation) => citation.path === outcome.path && citation.side === oppositeSide
      && (citation.presence === 'absent' || citation.window?.role === (oppositeSide === 'base' ? 'mapped-base' : 'mapped-head')));
    const candidateDiff = citations.find((citation) => citation.path === outcome.path && citation.side === 'diff'
      && citation.regionDigest === candidateProof.regionDigest);
    if (!candidateWindowCitation?.window || candidateWindowCitation.window.regionDigest !== candidateProof.regionDigest
      || canonicalJson(candidateWindowCitation.window.mapping) !== canonicalJson(candidateProof.mapping)
      || outcome.line < candidateWindowCitation.window.startLine || outcome.line > candidateWindowCitation.window.endLine
      || !counterpartCitation || !candidateDiff
      || !evidence.usedCitationIds.includes(candidateWindowCitation.id)
      || !evidence.usedCitationIds.includes(counterpartCitation.id) || !evidence.usedCitationIds.includes(candidateDiff.id)) {
      return 'grounded v2 proof lacks the exact candidate window, mapped old/new side, or causal hunk';
    }
    if (outcome.candidateSide === 'base' && candidateProof.mapping.kind === 'changed-hunk'
      && candidateProof.mapping.relation === 'deletion-gap' && counterpartCitation.presence !== 'absent'
      && counterpartCitation.window?.role !== 'mapped-head') return 'grounded v2 deletion proof lacks current head gap evidence';
    if ('rootCause' in evidence) {
      if ((outcome.candidateSide === 'base' && evidence.causeAnchor.side !== 'base')
        || (outcome.candidateSide === 'head' && evidence.causeAnchor.side !== 'head')) {
        return 'grounded v2 cause anchor side disagrees with the candidate hunk';
      }
      const anchorCitation = evidence.causeAnchor.citationIds.map((id) => citationsById.get(id)).find((citation) => citation?.window
        && citation.path === evidence.causeAnchor.componentPath && citation.side === evidence.causeAnchor.side
        && citation.window.startLine <= evidence.causeAnchor.startLine && citation.window.endLine >= evidence.causeAnchor.endLine);
      if (!anchorCitation || !evidence.usedCitationIds.includes(anchorCitation.id)) return 'grounded v2 cause anchor lacks exact cited source';
      if (evidence.causalPath.candidatePath !== outcome.path || evidence.causalPath.componentPath !== evidence.causeAnchor.componentPath
        || !evidence.causalPath.citationIds.every((id) => evidence.usedCitationIds.includes(id))) {
        return 'grounded v2 causal path does not match its candidate and anchor sources';
      }
      if (!evidence.baseState.citationIds.every((id) => evidence.usedCitationIds.includes(id))
        || !evidence.headState.citationIds.every((id) => evidence.usedCitationIds.includes(id))
        || !evidence.causalDelta.citationIds.every((id) => evidence.usedCitationIds.includes(id))) {
        return 'grounded v2 state or delta assertion references an uncited source';
      }
      const scopeProof = evidence.scopeProof as FindingChangeScopeProofV1;
      if (scopeProof.identity.repository !== repository || scopeProof.identity.baseSha !== baseSha
        || scopeProof.identity.headSha !== headSha || scopeProof.identity.findingFingerprint !== outcome.fingerprint
        || scopeProof.identity.candidateSide !== outcome.candidateSide
        || scopeProof.identity.sourceWindowManifestDigest !== evidence.sourceWindowManifestDigest) {
        return 'grounded v2 scope proof identity does not match the trusted current review';
      }
      if (canonicalJson(scopeProof.rootCause) !== canonicalJson({ version: FINDING_ROOT_CAUSE_IDENTITY_VERSION, ...evidence.rootCause })
        || canonicalJson(scopeProof.causeAnchor) !== canonicalJson(evidence.causeAnchor)
        || scopeProof.causalPath.relation !== evidence.causalPath.relation
        || canonicalJson(scopeProof.causalPath.citationIds) !== canonicalJson(evidence.causalPath.citationIds)
        || canonicalJson(scopeProof.baseState) !== canonicalJson(evidence.baseState)
        || canonicalJson(scopeProof.headState) !== canonicalJson(evidence.headState)
        || scopeProof.causalChange.relation !== evidence.causalDelta.kind
        || scopeProof.causalChange.materiality !== evidence.causalDelta.materiality
        || canonicalJson(scopeProof.causalChange.citationIds) !== canonicalJson(evidence.causalDelta.citationIds)) {
        return 'grounded v2 causal-scope proof disagrees with source-bound outcome evidence';
      }
      const trustedProofDigest = findingChangeScopeProofDigest(scopeProof);
      recomputedScope = classifyFindingChangeScope({
        expected: { repository, baseSha, headSha, findingFingerprint: outcome.fingerprint,
          candidateSide: outcome.candidateSide!, candidatePath: outcome.path },
        proof: scopeProof, trustedProofDigest, sourceWindowManifestDigest: evidence.sourceWindowManifestDigest,
        citations,
      });
      if (canonicalJson(recomputedScope) !== canonicalJson(evidence.scopeDecision)
        || recomputedScope.rootCauseEvidenceKey !== evidence.rootCauseEvidenceKey) {
        return 'grounded v2 causal-scope decision failed trusted proof re-reduction';
      }
    }
    const evidenceDigest = sha256(canonicalJson({ fingerprint: outcome.fingerprint, currentAffectedContextDigest, evidence }));
    if (evidenceDigest !== outcome.evidenceDigest) return 'grounded v2 verification evidence digest is invalid';
    if (outcome.status === 'confirmed' && !('rootCause' in evidence)) return 'confirmed v2 outcome lacks causal scope proof';
    const scope = recomputedScope;
    if (outcome.severity === 'P0' || outcome.severity === 'P1') {
      if (outcome.status === 'confirmed' && scope?.causalScope === 'unproven') recomputedUnverifiedBlockers += 1;
      if ((outcome.status === 'confirmed' && (scope?.causalScope === 'preexisting' || scope?.causalScope === 'unproven')
        || outcome.status === 'contradicted') && exactCurrentLaneFinding(outcome.fingerprint, outcome.severity)) {
        return 'baseline, unproven, or contradicted v2 blocker remains in published findings';
      }
      if (outcome.status === 'confirmed' && (!scope || !['introduced', 'exacerbated', 'preexisting', 'unproven'].includes(scope.causalScope))) {
        return 'material v2 outcome has no trusted causal classification';
      }
      if (outcome.status === 'confirmed' && (scope?.causalScope === 'introduced' || scope?.causalScope === 'exacerbated')
        && !exactCurrentLaneFinding(outcome.fingerprint, outcome.severity)) {
        return 'new or worsened v2 blocker lacks its exact normalized current lane finding';
      }
    }
    if (outcome.status === 'confirmed' && (scope?.causalScope === 'preexisting' || scope?.causalScope === 'unproven')
      && exactCurrentLaneFinding(outcome.fingerprint, outcome.severity)) return 'baseline or unproven v2 finding remains in published findings';
    if ((outcome.status === 'confirmed' && (scope?.causalScope === 'introduced' || scope?.causalScope === 'exacerbated')
      && !exactCurrentLaneFinding(outcome.fingerprint, outcome.severity))
      || (outcome.status === 'contradicted' && exactCurrentLaneFinding(outcome.fingerprint, outcome.severity))) {
      return 'grounded v2 findings were not reconciled with the independent outcome';
    }
  }
  if (recomputedUnverifiedBlockers !== receipt.verification.unverifiedBlockerCount) {
    return 'grounded v2 unverified blocker count disagrees with source-scope reduction';
  }
  return null;
}

function matchedOriginAncestryForOutcome(input: { outcome: GroundedReviewReceiptV2['verification']['outcomes'][number];
  trusted: TrustedGroundedHistoryContext; kinds: readonly ('cause' | 'repair')[];
  currentHeadSha: string; eventIds: ReadonlySet<string> }): GroundedOriginAncestryV1[] | undefined {
  if (input.kinds.length === 0) return undefined;
  const supplied = input.outcome.verifiedOriginAncestry;
  const expected = input.trusted.expectedOriginAncestryByFingerprint?.[input.outcome.fingerprint];
  const parsedExpected = z.array(groundedOriginAncestryV1Schema).max(2).safeParse(expected);
  if (!supplied || !parsedExpected.success || supplied.length !== input.kinds.length
    || parsedExpected.data.length !== input.kinds.length
    || canonicalJson(supplied) !== canonicalJson(parsedExpected.data)) return undefined;
  if (supplied.some((origin, index) => origin.sourceKind !== input.kinds[index]
    || origin.result !== 'ancestor' || origin.currentHeadSha !== input.currentHeadSha
    || origin.currentHeadSha !== input.trusted.currentHeadSha || !input.eventIds.has(origin.sourceEventId))) return undefined;
  return parsedExpected.data;
}

function hasNoExpectedOriginAncestry(input: { outcome: GroundedReviewReceiptV2['verification']['outcomes'][number];
  continuity: GroundedFindingContinuityV1; trusted: TrustedGroundedHistoryContext }): boolean {
  const expected = input.trusted.expectedOriginAncestryByFingerprint?.[input.outcome.fingerprint];
  return (input.outcome.verifiedOriginAncestry === undefined || input.outcome.verifiedOriginAncestry.length === 0)
    && (input.continuity.verifiedOriginAncestry === undefined || input.continuity.verifiedOriginAncestry.length === 0)
    && (expected === undefined || Array.isArray(expected) && expected.length === 0);
}

function groundedContinuityForGate(input: { result: WorkerReviewResult; contract: TrustedReviewCoverageContract;
  coordinates: TrustedWorkerReviewCoordinates }): { accepted: GroundedFindingContinuityV1[];
  transitions: GroundedLifecycleTransitionV1[] } {
  const receipt = input.result.groundedReview;
  const trusted = input.contract.groundedHistory;
  if (!receipt || receipt.version !== GROUNDED_REVIEW_RECEIPT_V2_VERSION || !trusted) return { accepted: [], transitions: [] };
  if (!/^run_[a-f0-9]{32}$/u.test(trusted.currentRunId) || trusted.currentRunId !== input.coordinates.runId
    || trusted.currentHeadSha !== input.coordinates.headSha
    || !z.string().uuid().safeParse(trusted.snapshotId).success || !/^[a-f0-9]{64}$/u.test(trusted.contextDigest)
    || !Array.isArray(trusted.eventIds) || trusted.eventIds.length > 4_096 || new Set(trusted.eventIds).size !== trusted.eventIds.length
    || trusted.eventIds.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 128)) {
    return { accepted: [], transitions: [] };
  }
  const receiptHistory = receipt.history;
  if (receiptHistory.status !== 'complete' || receiptHistory.snapshotId !== trusted.snapshotId
    || receiptHistory.contextDigest !== trusted.contextDigest) return { accepted: [], transitions: [] };
  if (trusted.verifiedAncestry && (trusted.verifiedAncestry.currentHeadSha !== trusted.currentHeadSha
    || !reviewHeadAncestryV1Schema.safeParse(trusted.verifiedAncestry).success)) {
    return { accepted: [], transitions: [] };
  }
  const eventIds = new Set(trusted.eventIds);
  const accepted: GroundedFindingContinuityV1[] = [];
  const transitions: GroundedLifecycleTransitionV1[] = [];
  for (const outcome of receipt.verification.outcomes) {
    const hint = outcome.verifiedContinuity;
    if (hint && hint.status !== 'unavailable' && outcome.status === 'confirmed') {
      const expected = trusted.expectedContinuityByFingerprint[hint.currentFingerprint];
      const { evidenceDigest: hintDigest, ...hintMaterial } = hint;
      const expectedMaterial = expected && (({ evidenceDigest: _expectedDigest, ...material }) => material)(expected);
      const expectedDigestValid = Boolean(expected && expectedMaterial
        && expected.evidenceDigest === groundedFindingContinuityDigest(expectedMaterial));
      const hintEvidence = outcome.evidence;
      const anchorBound = Boolean(hintEvidence && hint.causeAnchor.citationIds.length > 0
        && hint.causeAnchor.citationIds.every((id) => {
          const citation = hintEvidence.citations.find((candidate) => candidate.id === id);
          const window = citation?.window;
          return hintEvidence!.usedCitationIds.includes(id) && Boolean(window
            && window.path === hint.causeAnchor.componentPath && window.side === hint.causeAnchor.side
            && window.startLine <= hint.causeAnchor.startLine && window.endLine >= hint.causeAnchor.endLine);
        }));
      const outcomeCauseBound = Boolean(hintEvidence && (outcome.status === 'confirmed'
        ? 'rootCause' in hintEvidence && canonicalJson(hint.rootCause) === canonicalJson(hintEvidence.rootCause)
          && canonicalJson(hint.causeAnchor) === canonicalJson(hintEvidence.causeAnchor)
        : outcome.status === 'contradicted' && anchorBound));
      const requiredKinds: readonly ('cause' | 'repair')[] = hint.status === 'continuous' ? ['cause']
        : hint.status === 'reopened' ? ['cause', 'repair'] : [];
      const matchedOrigins = requiredKinds.length > 0
        ? matchedOriginAncestryForOutcome({ outcome, trusted, kinds: requiredKinds,
          currentHeadSha: input.coordinates.headSha, eventIds })
        : undefined;
      const originContinuityBound = requiredKinds.length > 0
        ? Boolean(matchedOrigins && hint.verifiedOriginAncestry
          && canonicalJson(hint.verifiedOriginAncestry) === canonicalJson(outcome.verifiedOriginAncestry)
          && canonicalJson(hint.sourceEventIds) === canonicalJson(matchedOrigins.map((origin) => origin.sourceEventId).sort()))
        : hint.status === 'new' && hasNoExpectedOriginAncestry({ outcome, continuity: hint, trusted });
      if (expected && groundedFindingContinuityV1Schema.safeParse(expected).success && expectedDigestValid
        && groundedFindingContinuityV1Schema.safeParse(hint).success
        && hintDigest === groundedFindingContinuityDigest(hintMaterial)
        && outcome.evidenceDigest === hint.currentOutcomeEvidenceDigest && outcomeCauseBound
        && expected.currentFingerprint === hint.currentFingerprint
        && canonicalJson(expected) === canonicalJson(hint)
        && hint.historySnapshotId === trusted.snapshotId && hint.historyContextDigest === trusted.contextDigest
        && hint.sourceEventIds.every((id) => eventIds.has(id))
        && originContinuityBound) accepted.push(hint);
    }

    const trustedTransition = trusted.expectedTransitionsByFingerprint?.[outcome.fingerprint];
    const parsedTransition = trustedGroundedLifecycleTransitionV1Schema.safeParse(trustedTransition);
    if (!parsedTransition.success) continue;
    const transition = parsedTransition.data;
    const { evidenceDigest: transitionDigest, ...transitionMaterial } = transition;
    const evidence = outcome.evidence;
    const requiredTransitionKinds: readonly ('cause' | 'repair')[] | undefined = transition.kind === 'fixed'
      ? outcome.status === 'contradicted' ? ['cause'] : undefined
      : outcome.status === 'confirmed' ? ['cause', 'repair'] : undefined;
    const transitionOrigins = requiredTransitionKinds && matchedOriginAncestryForOutcome({ outcome, trusted,
      kinds: requiredTransitionKinds, currentHeadSha: input.coordinates.headSha, eventIds });
    if (!evidence || transition.currentFingerprint !== outcome.fingerprint
      || sha256(canonicalJson(transitionMaterial)) !== transitionDigest
      || transition.candidateSide !== outcome.candidateSide || transition.outcomeStatus !== outcome.status
      || transition.baseSha !== input.coordinates.baseSha || transition.headSha !== input.coordinates.headSha
      || transition.changedContextDigest !== outcome.affectedContextDigest
      || transition.historySnapshotId !== trusted.snapshotId || transition.historyContextDigest !== trusted.contextDigest
      || !eventIds.has(transition.priorFindingEventId)
      || transition.sourceWindowManifestDigest !== evidence.sourceWindowManifestDigest
      || transition.currentOutcomeEvidenceDigest !== outcome.evidenceDigest
      || !transitionOrigins) continue;
    if (transition.kind === 'fixed' && outcome.status !== 'contradicted') continue;
    if (transition.kind === 'fixed' && transition.priorFindingEventId !== transitionOrigins[0]!.sourceEventId) continue;
    if (transition.kind === 'regressed' && (outcome.status !== 'confirmed' || !('rootCause' in evidence)
      || !['introduced', 'exacerbated'].includes(evidence.scopeDecision.causalScope)
      || transition.causalScope !== evidence.scopeDecision.causalScope
      || transition.priorFindingEventId !== transitionOrigins[1]!.sourceEventId
      || !accepted.some((continuity) => continuity.currentFingerprint === outcome.fingerprint
        && continuity.status === 'reopened'
        && canonicalJson(continuity.verifiedOriginAncestry) === canonicalJson(outcome.verifiedOriginAncestry)))) continue;
    transitions.push({ version: transition.version, transition: transition.kind,
      currentFingerprint: transition.currentFingerprint, outcomeStatus: outcome.status,
      candidateSide: transition.candidateSide, durableFindingId: transition.durableFindingId,
      priorFindingEventId: transition.priorFindingEventId, historySnapshotId: transition.historySnapshotId,
      historyContextDigest: transition.historyContextDigest, baseSha: transition.baseSha, headSha: transition.headSha,
      changedContextDigest: transition.changedContextDigest, sourceWindowManifestDigest: transition.sourceWindowManifestDigest,
      evidenceDigest: transition.evidenceDigest, currentOutcomeEvidenceDigest: transition.currentOutcomeEvidenceDigest,
      sourceCitationIds: [...evidence.usedCitationIds],
      ...(transition.kind === 'regressed' && outcome.status === 'confirmed' && 'rootCause' in evidence
        ? { causalScope: transition.causalScope! } : {}) });
  }
  return { accepted, transitions };
}

/** Validate the deterministic, exact-diff binding before any grounded result can affect arbitration. */
function groundedReviewReceiptError(
  result: WorkerReviewResult,
  changedFiles: ReviewChangedFile[],
  headSha: string,
  baseSha: string,
  repository: string,
  required: boolean,
  expectedImportResolutionSources?: readonly TrustedGroundedImportResolutionSourceV1[],
): string | null {
  const receipt = result.groundedReview;
  if (!receipt) return required ? 'v2 review requires an independent grounded-review receipt' : null;
  const expectedManifest = buildDeterministicCoverageManifest(changedFiles);
  const manifestMatches = receipt.coverage.digest === expectedManifest.digest
    && receipt.coverage.regionCount === expectedManifest.regions.length
    && receipt.coverage.assignmentCount === expectedManifest.assignments.length
    && receipt.coverage.coveredRegionCount === expectedManifest.coveredRegionIds.length
    && receipt.coverage.complete === expectedManifest.complete
    && canonicalJson(receipt.coverage.omissions) === canonicalJson(expectedManifest.omissions);
  // An optional v1 receipt can only add verification evidence; it cannot complete a worker-side
  // source manifest. Preserve an explicit incomplete BLOCK when the worker had only a partial
  // diff, while refusing every mismatch that could claim or imply approval.
  const explicitlyIncompleteOptionalLegacyReceipt = !required && result.coverageComplete === false
    && receipt.coverage.complete === false && receipt.verification.coverageComplete === false;
  if (!manifestMatches && !explicitlyIncompleteOptionalLegacyReceipt) {
    return 'grounded coverage receipt does not match the trusted changed-source manifest';
  }
  if (receipt.verification.coverageComplete !== (receipt.coverage.complete && receipt.verification.unverifiedBlockerCount === 0)) {
    return 'grounded verification coverage status is inconsistent';
  }
  const changedByPath = new Map(changedFiles.map((file) => [file.path, file]));
  for (const file of changedFiles) {
    const presence = file.sourcePresence;
    if (!presence) continue;
    if (presence.version !== 'ReviewSourcePresence.v1' || presence.repository !== repository
      || presence.path !== file.path || presence.headSha !== headSha || presence.baseSha !== baseSha
      || !file.patch || presence.patchDigest !== sha256(file.patch)
      || !['head', 'base'].includes(presence.absentSide)
      || !['unified-diff-null-side', 'comparison-status'].includes(presence.evidence)) {
      return 'changed-source absence evidence is not bound to the trusted repository revisions';
    }
    if (presence.evidence === 'unified-diff-null-side') {
      const absentHeader = presence.absentSide === 'head'
        ? /^\+\+\+ \/dev\/null$/mu.test(file.patch)
        : /^--- \/dev\/null$/mu.test(file.patch);
      if (!absentHeader) return 'changed-source absence evidence does not match its unified diff';
    }
  }
  if (receipt.version === GROUNDED_REVIEW_RECEIPT_V2_VERSION) {
    return groundedReviewReceiptV2Error({ receipt, result, changedFiles, headSha, baseSha, repository,
      expectedImportResolutionSources });
  }
  const outcomes = new Map<string, typeof receipt.verification.outcomes[number]>();
  const currentFindings = result.personas.flatMap((persona) => persona.findings);
  const groundedFingerprint = (finding: { path: string; title: string; body?: string }): string => {
    if (!required) return findingFingerprint(finding);
    const claimType = findingClaimType({ path: finding.path, title: finding.title });
    return findingFingerprintForClaimType({ path: finding.path, title: finding.title }, claimType);
  };
  const legacyGroundedSeverity = (severity: string): string => severity === 'P0' || severity === 'P1' ? severity : 'P2';
  if (required && currentFindings.some((finding) => {
    const claimType = findingClaimType({ path: finding.path, title: finding.title });
    const severity = publishedFindingSeverity(finding);
    return claimType === 'missing-tests' && (severity === 'P0' || severity === 'P1');
  })) return 'test-coverage-only claim cannot be blocking';
  for (const outcome of receipt.verification.outcomes) {
    if (outcomes.has(outcome.fingerprint)) return 'grounded receipt contains duplicate finding identities';
    outcomes.set(outcome.fingerprint, outcome);
    const semanticClaimType = findingClaimType(required
      ? { path: outcome.path, title: outcome.title }
      : { path: outcome.path, title: outcome.title, body: outcome.title });
    if (required && outcome.claimType !== semanticClaimType) {
      return 'grounded outcome claim type does not match its semantic title';
    }
    if (findingFingerprintForClaimType({ path: outcome.path, title: outcome.title }, outcome.claimType) !== outcome.fingerprint) {
      return 'grounded outcome identity does not match its claim locator';
    }
    const sameIdentityFindings = currentFindings.filter((finding) => groundedFingerprint(finding) === outcome.fingerprint);
    if (sameIdentityFindings.length > 0 && !sameIdentityFindings.some((finding) =>
      legacyGroundedSeverity(publishedFindingSeverity(finding)) === legacyGroundedSeverity(outcome.severity))) {
      return 'grounded outcome severity does not match its normalized current lane finding';
    }
    const changed = changedByPath.get(outcome.path);
    if (!changed || outcome.relatedDiffPaths.some((path) => !changedByPath.has(path))
      || new Set(outcome.relatedDiffPaths).size !== outcome.relatedDiffPaths.length) {
      return 'grounded outcome references source outside the trusted changed set';
    }
    const currentAffectedContextDigest = groundedAffectedContextDigest(outcome, changedFiles, outcome.relatedDiffPaths);
    if (currentAffectedContextDigest !== outcome.affectedContextDigest) return 'grounded outcome context does not match the trusted changed set';
    if (outcome.status === 'insufficient') continue;
    const evidence = outcome.evidence!;
    for (const citation of evidence.citations) {
      const marker = changedByPath.get(citation.path)?.sourcePresence;
      const shouldBeAbsent = marker?.absentSide === citation.side;
      if ((citation.presence === 'absent') !== shouldBeAbsent) {
        return 'grounded citation presence does not match trusted source-side evidence';
      }
    }
    const evidenceDigest = sha256(canonicalJson({ fingerprint: outcome.fingerprint,
      currentAffectedContextDigest, evidence }));
    if (evidenceDigest !== outcome.evidenceDigest) return 'grounded verification evidence digest is invalid';
    if (outcome.status === 'confirmed') {
      if (!('violatedInvariant' in evidence) || !evidence.causalDiffPaths.length
        || canonicalJson([...evidence.causalDiffPaths].sort()) !== canonicalJson([...outcome.relatedDiffPaths].sort())) {
        return 'confirmed grounded outcome is missing its causal change binding';
      }
      const headCitation = evidence.citations.find((citation) => citation.id === `head:${outcome.path}`
        && citation.path === outcome.path && citation.side === 'head' && citation.sha === headSha);
      const baseCitation = evidence.citations.find((citation) => citation.id === `base:${outcome.path}`
        && citation.path === outcome.path && citation.side === 'base' && citation.sha === baseSha);
      const citedDiffPaths = evidence.citations.filter((citation) => citation.side === 'diff'
        && outcome.relatedDiffPaths.includes(citation.path) && citation.id === `diff:${citation.path}`)
        .map((citation) => citation.path);
      const changedCausalPath = outcome.relatedDiffPaths.some((path) => {
        const file = changedByPath.get(path);
        const patch = file?.patch;
        return (changedLineNumbers(patch)?.size ?? 0) > 0
          || (file?.sourcePresence?.absentSide === 'head' && (deletedLineNumbers(patch)?.size ?? 0) > 0);
      });
      const directLineChange = changedLineNumbers(changed.patch)?.has(outcome.line) === true;
      const directDeletion = changed.sourcePresence?.absentSide === 'head'
        && deletedLineNumbers(changed.patch)?.has(outcome.line) === true;
      if (!headCitation || !baseCitation || citedDiffPaths.length === 0 || !changedCausalPath
        || (!directLineChange && !directDeletion && outcome.relatedDiffPaths.every((path) => path === outcome.path))) {
        return 'confirmed grounded outcome lacks exact current source or a changed causal path';
      }
    } else {
      if (!('explanation' in evidence) || evidence.causalDiffPaths.length !== outcome.relatedDiffPaths.length
        || !evidence.citations.some((citation) => citation.id === `head:${outcome.path}`
          && citation.path === outcome.path && citation.side === 'head' && citation.sha === headSha)
        || !evidence.citations.some((citation) => citation.id === `base:${outcome.path}`
          && citation.path === outcome.path && citation.side === 'base' && citation.sha === baseSha)
        || !evidence.citations.some((citation) => citation.id === `diff:${outcome.path}`
          && citation.path === outcome.path && citation.side === 'diff')) {
      return 'contradicted grounded outcome lacks exact same-file head, admitted base, and diff evidence';
      }
    }
  }
  for (const outcome of receipt.verification.outcomes) {
    const matching = currentFindings.some((finding) => groundedFingerprint(finding) === outcome.fingerprint
      && legacyGroundedSeverity(publishedFindingSeverity(finding)) === legacyGroundedSeverity(outcome.severity));
    if ((outcome.status === 'confirmed' && !matching) || (outcome.status === 'contradicted' && matching)
      || (outcome.status === 'insufficient' && (outcome.severity === 'P0' || outcome.severity === 'P1') && matching)) {
      return 'grounded findings were not reconciled with the independent outcome';
    }
  }
  for (const finding of currentFindings) {
    const severity = publishedFindingSeverity(finding);
    const outcome = outcomes.get(groundedFingerprint(finding));
    if ((severity === 'P0' || severity === 'P1')
      && (outcome?.severity !== severity || outcome?.status !== 'confirmed')) {
      return 'blocking finding lacks a current confirmed independent verification';
    }
  }
  if ((receipt.verification.unverifiedBlockerCount > 0 || !receipt.coverage.complete || !receipt.verification.coverageComplete)
    && result.coverageComplete) return 'worker claims complete coverage with an unverified blocker or source gap';
  return null;
}

/** `storedCompletionShipCompleteReason(...) === null`. */
export function storedCompletionShipComplete(
  result: WorkerReviewResult,
  gate: StoredGateRecord | null | undefined,
  storedDigest: string,
): boolean {
  return storedCompletionShipCompleteReason(result, gate, storedDigest) === null;
}

/**
 * Re-derives service evidence from the worker's persona lanes. The worker's verdict and summary
 * counts are checked for consistency only; `computeAppVerdict` is the decision source. Required
 * lanes and coverage remain service-owned inputs.
 */
export function deriveCanonicalWorkerReviewEvidence(
  input: unknown,
  contract: TrustedReviewCoverageContract,
): WorkerReviewEvidenceDerivation {
  const completion = parseWorkerReviewCompletion(input);
  const expectedCoordinates = validateTrustedCoordinates(contract?.expectedCoordinates);
  const expectedPersonaIds = validateCoverageContract(contract);
  if (!coordinatesMatch(completion, expectedCoordinates)) {
    return invalidEvidence('worker completion coordinates do not match the trusted review run identity');
  }
  const changedFiles = validateChangedFiles(contract.changedFiles);
  const groundedError = groundedReviewReceiptError(completion.result, changedFiles, expectedCoordinates.headSha, expectedCoordinates.baseSha,
    `${expectedCoordinates.owner}/${expectedCoordinates.repo}`,
    contract.reviewDecisionPolicy === REVIEW_SEVERITY_POLICY_V2, contract.expectedImportResolutionSources);
  if (groundedError) return invalidEvidence(groundedError);
  const routeError = groundedVerifierRouteRefusal(completion.result, contract);
  if (routeError) return invalidEvidence(routeError);
  const continuity = groundedContinuityForGate({ result: completion.result, contract, coordinates: expectedCoordinates });
  if (completion.result.composedResources !== undefined && contract.reviewEngine !== 'composed') {
    return invalidEvidence('panel completion cannot claim composed runtime resources');
  }
  const groundedCoverageComplete = completion.result.groundedReview
    ? completion.result.groundedReview.coverage.complete && completion.result.groundedReview.verification.coverageComplete
    : true;
  // REL-1084: a carried-forward verdict counts toward the gate only when the service verified it
  // against the prior review record it names, and only for files in this exact changed set.
  const carried = completion.result.incremental;
  if (carried) {
    if (contract.incrementalVerified !== true) {
      return invalidEvidence('carried-forward completion was not verified against its prior review record');
    }
    const paths = new Set(changedFiles.map((file) => file.path));
    if (isDocumentationOnlyCompletion(completion.result)
      || !carried.carriedForwardPaths.every((path) => paths.has(path))
      || !(carried.deltaPaths ?? []).every((path) => paths.has(path))
      // A delta claim is only valid with the service's own patches for exactly the paths it names.
      || (carried.deltaPaths !== undefined
        && !carried.deltaPaths.every((path) => (contract.incrementalDeltaFiles ?? []).some((file) => file.path === path)))) {
      return invalidEvidence('carried-forward completion names a file outside the trusted changed set');
    }
  }
  // REL-1085: a verdict served from cache counts toward the gate only when the service verified it
  // against the source record it names, and only for files in this exact changed set.
  const served = completion.result.verdictCache?.hits;
  if (served) {
    if (contract.verdictCacheVerified !== true) {
      return invalidEvidence('verdict-cache completion was not verified against its source record');
    }
    const paths = new Set(changedFiles.map((file) => file.path));
    if (isDocumentationOnlyCompletion(completion.result) || !served.paths.every((path) => paths.has(path))) {
      return invalidEvidence('verdict-cache completion names a file outside the trusted changed set');
    }
  }
  if (isDocumentationOnlyCompletion(completion.result)) {
    if (completion.result.reviewDecision !== undefined) {
      return invalidEvidence('no-reviewable-content exemption cannot carry a panel decision receipt');
    }
    // REL-1139: a documentation-only exemption never ran a moderator to skip.
    if (completion.result.moderation !== undefined) {
      return invalidEvidence('documentation-only completion claims a skipped moderator');
    }
    // REL-972: the exemption also covers registry-verified lockfile changes.
    // The trusted completion context has already required the shared
    // resolveReviewApplicability decision to report no reviewable content,
    // and that decision applies this same per-file rule to the raw changed
    // files, so a worker exemption is never one this check refuses.
    if (!changedFiles.every((file) => isNoReviewableContentFile(file))) {
      return invalidEvidence('documentation-only completion contains analyzable source paths');
    }
    const coverageComplete = contract.coverageComplete && completion.result.coverageComplete && groundedCoverageComplete;
    const marker = completion.result.personas[0];
    const canonical = computeAppVerdict({
      lanes: [{ id: marker.id, decision: marker.decision, status: marker.status, findings: [] }],
      expectedLanes: 1,
      changedFiles,
      coverageComplete,
    });
    const quorumSatisfied = contract.quorumSatisfied
      && completion.result.quorumSatisfied
      && canonical.quorumSatisfied;
    const evidence: ReviewGateEvidence = {
      verdict: canonical.verdict,
      completedAt: completion.result.completedAt,
      coverageComplete,
      quorumSatisfied,
      infrastructureFailure: false,
      p0Count: 0,
      p1Count: 0,
      p2Count: 0,
      exemption: {
        kind: 'no-reviewable-content',
        auditDigest: noReviewableContentAuditDigest(expectedCoordinates, changedFiles),
      },
      expectedLanes: 0,
      completedLanes: 0,
    };
    const mismatch = rawFieldsMatchCanonical(completion.result, canonical);
    if (mismatch) return invalidEvidence(mismatch, canonical, evidence);
    return { valid: true, canonical, evidence };
  }
  let requiredIds = expectedPersonaIds;
  // A thrown infrastructure failure can precede a composed plan (or prevent its return).
  // The publisher reports the configured roster as all ERROR, not fabricated task evidence.
  // Admit only that exact failure envelope so the service can record infrastructure-failure
  // and apply its existing bounded retry. Mixed results/findings still require a real plan;
  // identity, roster membership, raw verdict and cached-success checks remain fail-closed.
  const composedInfrastructureFailure = contract.reviewEngine === 'composed'
    && completion.result.taskPlan === undefined
    && contract.coverageComplete
    && Boolean(contract.composedChangedPaths?.length)
    && isInfrastructureIncompleteResult(completion.result)
    && completion.result.personas.length === expectedPersonaIds.length
    && completion.result.personas.every((persona) => persona.decision === 'ERROR'
      && persona.status === 'ERROR' && persona.evidenceSource !== 'shadow' && persona.findings.length === 0);
  const currentComposedSemantics = contract.reviewDecisionPolicy === REVIEW_SEVERITY_POLICY_V2
    || completion.result.groundedReview?.version === GROUNDED_REVIEW_RECEIPT_V2_VERSION;
  let composedResourceCoverageComplete = contract.reviewEngine !== 'composed' || !currentComposedSemantics;
  if (contract.reviewEngine === 'composed' && !composedInfrastructureFailure) {
    if (!completion.result.taskPlan || !contract.composedChangedPaths?.length) {
      return invalidEvidence('composed completion is missing its trusted task plan or effective paths');
    }
    const validatedPlan = validateTaskPlan({ tasks: completion.result.taskPlan }, {
      changedFiles: [...contract.composedChangedPaths], maxTasks: contract.composedMaxTasks,
    });
    if (!validatedPlan.valid) {
      return invalidEvidence(`composed task plan invalid: ${validatedPlan.reason}`);
    }
    if (canonicalJson(validatedPlan.tasks) !== canonicalJson(completion.result.taskPlan)) {
      return invalidEvidence('composed task plan does not cover the trusted changed files');
    }
    if (currentComposedSemantics || completion.result.composedResources) {
      const resourceRefusal = composedRuntimeResourcesRefusal({ result: completion.result,
        tasks: validatedPlan.tasks, changedFiles, coordinates: expectedCoordinates,
        expectedConfiguration: contract.composedEffectiveConfiguration });
      if (resourceRefusal) return invalidEvidence(resourceRefusal);
      const composedResources = completion.result.composedResources!;
      composedResourceCoverageComplete = composedResources.engineExecutionState === 'complete'
        && composedResources.coverage.remainingPaths.count === 0;
    }
    const admittedIds = composedPlanLaneIds(validatedPlan.tasks, completion.result.personas, validatedPlan.tasks.length);
    if (!admittedIds.valid) return invalidEvidence(admittedIds.message);
    requiredIds = admittedIds.ids;
  } else if (completion.result.taskPlan) {
    return invalidEvidence('panel completion cannot claim a composed task plan');
  } else if (composedInfrastructureFailure) {
    // An infrastructure failure before planning has no source-coverage observation and remains incomplete.
    composedResourceCoverageComplete = false;
  }
  const expected = new Set(requiredIds);
  const seen = new Set<string>();

  for (const persona of completion.result.personas) {
    if (seen.has(persona.id)) return invalidEvidence(`duplicate persona lane: ${persona.id}`);
    if (!expected.has(persona.id)) return invalidEvidence(`unknown persona lane: ${persona.id}`);
    seen.add(persona.id);
  }

  const coverageComplete = contract.coverageComplete && completion.result.coverageComplete && groundedCoverageComplete
    && composedResourceCoverageComplete;
  const arbitration = arbitrateLanes(completion.result.personas, requiredIds.length, coverageComplete, changedFiles,
    contract.reviewEngine === 'composed', contract.reviewDecisionPolicy);
  if (!arbitration.valid) return invalidEvidence(arbitration.message);
  const { canonical } = arbitration;
  const quorumSatisfied = contract.quorumSatisfied && completion.result.quorumSatisfied && canonical.quorumSatisfied;
  const infrastructureFailure = completion.result.personas.some(hasInfrastructureFailure);
  const expectedDecision = contract.reviewDecisionPolicy === REVIEW_SEVERITY_POLICY_V2
    ? createReviewDecisionV2({
      schemaVersion: 'review-yeti-decision.v2',
      policyVersion: REVIEW_SEVERITY_POLICY_V2,
      policyDigest: expectedCoordinates.policyDigest,
      coverageComplete,
      quorumSatisfied,
      infrastructureFailure,
      expectedLanes: requiredIds.length,
      completedLanes: canonical.completedPersonas,
      counts: {
        p0Count: canonical.metrics.p0Count,
        p1Count: canonical.metrics.p1Count,
        p2Count: canonical.metrics.p2Count,
        p3Count: canonical.metrics.p3Count,
        nitCount: canonical.metrics.nitCount,
      },
    }) : undefined;
  if (contract.reviewDecisionPolicy === REVIEW_SEVERITY_POLICY_V2) {
    if (!completion.result.reviewDecision) return invalidEvidence('v2 review decision receipt is required by trusted policy');
    if (canonicalJson(completion.result.reviewDecision) !== canonicalJson(expectedDecision)) {
      return invalidEvidence('worker review decision receipt disagrees with trusted canonical evidence');
    }
  } else if (completion.result.reviewDecision !== undefined) {
    return invalidEvidence('worker review decision receipt is not enabled by trusted policy');
  }
  const evidence: ReviewGateEvidence = {
    verdict: canonical.verdict,
    ...(contract.reviewEngine === 'composed' ? { reviewEngine: 'composed' as const } : {}),
    completedAt: completion.result.completedAt,
    coverageComplete,
    quorumSatisfied,
    infrastructureFailure,
    p0Count: canonical.metrics.p0Count,
    p1Count: canonical.metrics.p1Count,
    // ADR 0002: the same convergence the worker's raw check applies, on the service's own diff
    // and thread read. Only canonical findings count; a satisfied or out-of-diff P2 does not.
    p2Count: evaluateFindingConvergence({
      findings: canonical.findings, changedFiles, priorThreads: contract.findingThreads ?? [],
      ...(contract.incrementalVerified === true && contract.incrementalDeltaFiles?.length
        ? { deltaScope: contract.incrementalDeltaFiles } : {}),
      ...(contract.reviewDecisionPolicy ? { policyVersion: contract.reviewDecisionPolicy } : {}),
    }).counts.requiredP2,
    ...(expectedDecision ? { reviewDecision: expectedDecision } : {}),
    ...(contract.reviewDecisionPolicy === REVIEW_SEVERITY_POLICY_V2 ? {
      blockingFingerprints: [...new Set(canonical.findings
        .filter((finding) => finding.severity === 'P0' || finding.severity === 'P1')
        .map((finding) => findingFingerprint(finding)))].sort(),
      blockingFindings: canonical.findings
        .filter((finding) => (finding.severity === 'P0' || finding.severity === 'P1') && finding.blockerEvidence)
        .map((finding) => ({
          fingerprint: findingFingerprint(finding), severity: finding.severity as 'P0' | 'P1',
          path: finding.path, line: finding.line, title: finding.title, body: finding.body,
          blockerEvidence: finding.blockerEvidence!,
        }))
        .sort((a, b) => a.fingerprint.localeCompare(b.fingerprint)),
    } : {}),
    expectedLanes: requiredIds.length,
    completedLanes: canonical.completedPersonas,
  };

  const mismatch = rawFieldsMatchCanonical(completion.result, canonical);
  if (mismatch) return invalidEvidence(mismatch, canonical, evidence);
  const moderationRefusal = emptyModerationClaimRefusal(
    completion.result, contract, requiredIds, changedFiles, coverageComplete, canonical);
  if (moderationRefusal) return invalidEvidence(moderationRefusal, canonical, evidence);
  return { valid: true, canonical, evidence,
    ...(continuity.accepted.length > 0 ? { groundedContinuity: continuity.accepted } : {}),
    ...(continuity.transitions.length > 0 ? { groundedTransitions: continuity.transitions } : {}) };
}

/** Stable digest helper for the later artifact store integration. */
export function workerReviewCompletionDigest(input: unknown): string {
  return sha256(canonicalJson(parseWorkerReviewCompletion(input)));
}

export function parseWorkerReviewEvidence(input: unknown): WorkerReviewEvidence {
  if (!isRecord(input)) {
    throw new WorkerReviewCompletionError('invalid-schema', 'worker review evidence must be a JSON object');
  }
  if (serializedByteLength(input) > MAX_COMPLETION_BYTES) {
    throw new WorkerReviewCompletionError('payload-too-large', `worker review evidence exceeds ${MAX_COMPLETION_BYTES} bytes`);
  }
  const parsed = evidenceSchema.safeParse(input);
  if (!parsed.success) {
    throw new WorkerReviewCompletionError('invalid-schema', `invalid WorkerReviewEvidence.v1: ${issuePath(parsed.error)}`);
  }
  return parsed.data;
}

export function workerReviewEvidenceDigest(input: unknown): string {
  return sha256(canonicalJson(parseWorkerReviewEvidence(input)));
}
