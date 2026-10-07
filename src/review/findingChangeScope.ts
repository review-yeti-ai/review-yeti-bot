import { canonicalJson, sha256 } from './reviewCore';
import {
  groundedCitationManifestDigest,
  GROUNDED_SOURCE_WINDOW_VERSION,
  type GroundedCitationV2,
  type GroundedSourceWindowV1,
} from './groundedEvidenceV2';

export const FINDING_CHANGE_SCOPE_VERSION = 'FindingChangeScope.v1' as const;
export const FINDING_CHANGE_SCOPE_PROOF_VERSION = 'FindingChangeScopeProof.v1' as const;
export const FINDING_ROOT_CAUSE_IDENTITY_VERSION = 'ReviewYetiRootCauseIdentity.v1' as const;
export const FINDING_ROOT_CAUSE_EVIDENCE_KEY_VERSION = 'ReviewYetiRootCauseEvidenceKey.v1' as const;
export const MAX_CAUSE_ANCHOR_LINES = 20;

export type FindingCausalScope = 'introduced' | 'exacerbated' | 'preexisting' | 'unproven';
export type FindingCausalDelta = 'introduced' | 'materially-worsened' | 'unaffected' | 'unknown';
export type FindingCausalMateriality = 'reachability' | 'impact' | 'frequency' | 'attack-surface';
export type FindingSourceState = 'present' | 'absent' | 'unknown';
export type FindingContractState = 'violated' | 'not-violated' | 'unknown';
export type FindingCausalPathRelation = 'same-component' | 'dependency-edge' | 'contract-edge' | 'unrelated' | 'unknown';

export interface FindingRootCauseIdentityV1 {
  version: typeof FINDING_ROOT_CAUSE_IDENTITY_VERSION;
  componentId: string;
  behaviorId: string;
  contractId: string;
  failureModeId: string;
}

export interface FindingChangeScopeProofV1 {
  version: typeof FINDING_CHANGE_SCOPE_PROOF_VERSION;
  identity: {
    repository: string;
    baseSha: string;
    headSha: string;
    findingFingerprint: string;
    candidateSide: 'head' | 'base';
    sourceWindowManifestDigest: string;
  };
  independentVerifier: {
    role: 'independent-grounded-verifier';
    status: 'confirmed' | 'contradicted' | 'insufficient';
    evidenceDigest: string;
  };
  rootCause: FindingRootCauseIdentityV1;
  causeAnchor: {
    side: 'head' | 'base';
    componentPath: string;
    startLine: number;
    endLine: number;
    citationIds: string[];
    /** SHA-256 of the exact selected source bytes for this current-head occurrence. */
    contentDigest: string;
  };
  causalPath: { relation: FindingCausalPathRelation; citationIds: string[] };
  baseState: { trigger: FindingSourceState; contract: FindingContractState; citationIds: string[] };
  headState: { trigger: FindingSourceState; contract: FindingContractState; citationIds: string[] };
  causalChange: { relation: FindingCausalDelta; materiality?: FindingCausalMateriality; citationIds: string[] };
}

export interface FindingChangeScopeDecision {
  version: typeof FINDING_CHANGE_SCOPE_VERSION;
  /** Causal classification is independent of the finding's P0/P1/P2/P3/NIT severity. */
  causalScope: FindingCausalScope;
  /** Exact PR identity that issued this in-process decision; not a durable finding identity. */
  reviewIdentity: { repository: string; baseSha: string; headSha: string } | null;
  /** Current-review evidence key only. Durable continuity belongs to the lifecycle ledger. */
  rootCauseEvidenceKey: string | null;
  evidenceDigest: string | null;
  reasonCode: FindingChangeScopeReasonCode;
}

export type FindingChangeScopeReasonCode =
  | 'proof_missing'
  | 'input_identity_invalid'
  | 'proof_identity_mismatch'
  | 'citation_manifest_invalid'
  | 'citation_manifest_mismatch'
  | 'citation_unavailable_or_ambiguous'
  | 'citation_binding_invalid'
  | 'verifier_not_confirming'
  | 'root_cause_identity_invalid'
  | 'cause_anchor_invalid'
  | 'causal_path_unproven'
  | 'side_state_unproven'
  | 'causal_change_unproven'
  | 'causal_change_contradictory'
  | 'introduced_proven'
  | 'exacerbated_proven'
  | 'preexisting_proven';

export interface FindingChangeScopeInput {
  expected: {
    repository: string;
    baseSha: string;
    headSha: string;
    findingFingerprint: string;
    candidateSide: 'head' | 'base';
    candidatePath: string;
  };
  proof: unknown;
  /** Independently retained by the trusted engine/completion boundary; a plain hash is not authentication. */
  trustedProofDigest: string;
  /** Expected manifest digest reconstructed by the trusted engine/completion boundary. */
  sourceWindowManifestDigest: string;
  /** Exact v2 allow-list independently resolved from the pinned source context or completion-verified receipt. */
  citations: readonly GroundedCitationV2[];
}

type ObjectValue = Record<string, unknown>;
type ValidatedCitation = GroundedCitationV2 & { window?: GroundedSourceWindowV1 };

const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const FINDING_FINGERPRINT = /^fp1_[a-f0-9]{24}$/u;
const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/u;
const ROOT_CAUSE_ID = /^[a-z0-9]+(?:[._:/-][a-z0-9]+)*$/u;
const SEVERITIES = new Set(['P0', 'P1', 'P2', 'P3', 'NIT']);
const BLOCKING_SEVERITIES = new Set(['P0', 'P1']);
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const issuedScopeDecisions = new WeakSet<object>();

function isObject(value: unknown): value is ObjectValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export type FindingChangeScopeProofMaterialV1 = Omit<FindingChangeScopeProofV1, 'independentVerifier'> & {
  independentVerifier: Pick<FindingChangeScopeProofV1['independentVerifier'], 'role' | 'status'>;
};

/** Canonical consistency digest only; callers must also supply the expected value from trusted execution context. */
export function findingChangeScopeProofDigest(proof: FindingChangeScopeProofV1): string {
  const material: FindingChangeScopeProofMaterialV1 = {
    version: proof.version,
    identity: proof.identity,
    independentVerifier: { role: proof.independentVerifier.role, status: proof.independentVerifier.status },
    rootCause: proof.rootCause,
    causeAnchor: proof.causeAnchor,
    causalPath: proof.causalPath,
    baseState: proof.baseState,
    headState: proof.headState,
    causalChange: proof.causalChange,
  };
  return sha256(canonicalJson({ version: 'ReviewYetiFindingChangeScopeVerifierEvidence.v1', material }));
}

function isString(value: unknown, maximum = 2_000): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && value.trim() === value;
}

function isSafePath(value: unknown): value is string {
  if (!isString(value, 1_024) || value.startsWith('/') || value.includes('\\') || value.includes('\0')) return false;
  return value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function uniqueStringIds(value: unknown, maximum = 32): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= maximum
    && value.every((id) => isString(id, 512)) && new Set(value).size === value.length;
}

function digestField(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

function dependencyContractId(edge: ObjectValue): string {
  const { contractId: _contractId, ...material } = edge;
  return sha256(canonicalJson(material));
}

function isWindow(value: unknown, citation: ObjectValue, expected: FindingChangeScopeInput['expected']): value is GroundedSourceWindowV1 {
  if (!isObject(value)) return false;
  const window = value;
  const mapping = window.mapping;
  const emptyHeadWindow = window.side === 'head' && window.startLine === 1 && window.endLine === 0
    && window.byteLength === 0 && window.windowSha256 === EMPTY_SHA256;
  if (window.version !== GROUNDED_SOURCE_WINDOW_VERSION
    || !isString(window.id, 512)
    || window.repository !== expected.repository
    || window.path !== citation.path
    || window.side !== citation.side
    || window.revisionSha !== citation.revisionSha
    || window.baseSha !== expected.baseSha
    || window.headSha !== expected.headSha
    || !['candidate', 'mapped-base', 'mapped-head', 'dependency-caller', 'dependency-contract'].includes(String(window.role))
    || !digestField(window.fullContentSha256)
    || !Number.isSafeInteger(window.startLine) || Number(window.startLine) < 1
    || !Number.isSafeInteger(window.endLine)
    || (Number(window.endLine) < Number(window.startLine) && !emptyHeadWindow)
    || !digestField(window.windowSha256)
    || !Number.isSafeInteger(window.byteLength) || Number(window.byteLength) < 0
    || !digestField(window.regionDigest)
    || typeof window.exhaustive !== 'boolean'
    || !isObject(mapping)) return false;
  if (mapping.kind === 'dependency-contract') {
    if (mapping.exhaustive !== true) return false;
    if (!isObject(mapping.edge)) return false;
    const edge = mapping.edge;
    if (edge.resolver !== 'relative-import-v1' || !isSafePath(edge.importerPath)
      || (edge.importerSide !== 'head' && edge.importerSide !== 'base')
      || !digestField(edge.importerFullContentSha256)
      || !Number.isSafeInteger(edge.importerStatementStartLine) || Number(edge.importerStatementStartLine) < 1
      || !Number.isSafeInteger(edge.importerStatementEndLine)
      || Number(edge.importerStatementEndLine) < Number(edge.importerStatementStartLine)
      || !isString(edge.importSpecifier, 1_024) || !isSafePath(edge.resolvedPath)
      || !Array.isArray(edge.contractSymbols) || edge.contractSymbols.length === 0 || edge.contractSymbols.length > 32
      || !edge.contractSymbols.every((symbol) => isString(symbol, 256))
      || new Set(edge.contractSymbols).size !== edge.contractSymbols.length
      || !digestField(edge.importStatementDigest) || !causePart(edge.contractId)
      || !digestField(edge.originRegionDigest) || !digestField(edge.contractFullContentSha256)
      || !Number.isSafeInteger(edge.definitionStartLine) || Number(edge.definitionStartLine) < 1
      || !Number.isSafeInteger(edge.definitionEndLine) || Number(edge.definitionEndLine) < Number(edge.definitionStartLine)
      || !digestField(edge.definitionSha256) || dependencyContractId(edge) !== edge.contractId) return false;
    if (String(window.role) === 'dependency-contract'
      && (edge.resolvedPath !== window.path || edge.importerSide !== window.side
        || edge.contractFullContentSha256 !== window.fullContentSha256
        || Number(edge.definitionStartLine) < Number(window.startLine)
        || Number(edge.definitionEndLine) > Number(window.endLine))) return false;
    if (String(window.role) === 'dependency-caller'
      && (edge.importerPath !== window.path || edge.importerSide !== window.side
        || Number(edge.importerStatementStartLine) < Number(window.startLine)
        || Number(edge.importerStatementEndLine) > Number(window.endLine))) return false;
  } else if (mapping.kind === 'changed-hunk') {
    if ((mapping.candidateSide !== 'head' && mapping.candidateSide !== 'base')
      || !Number.isSafeInteger(mapping.candidateLine) || Number(mapping.candidateLine) < 1
      || !Number.isSafeInteger(mapping.hunkOrdinal) || Number(mapping.hunkOrdinal) < 1
      || !Number.isSafeInteger(mapping.oldStart) || Number(mapping.oldStart) < 0
      || !Number.isSafeInteger(mapping.oldLines) || Number(mapping.oldLines) < 0
      || !Number.isSafeInteger(mapping.newStart) || Number(mapping.newStart) < 0
      || !Number.isSafeInteger(mapping.newLines) || Number(mapping.newLines) < 0
      || !['replaced-region', 'insertion-gap', 'deletion-gap'].includes(String(mapping.relation))) return false;
  } else return false;
  if (window.byteLength === 0
    && !(window.side === 'head' && mapping.kind === 'changed-hunk' && mapping.relation === 'insertion-gap'
      && window.windowSha256 === EMPTY_SHA256
      && (!window.exhaustive || window.fullContentSha256 === EMPTY_SHA256))) return false;
  return window.revisionSha === (citation.side === 'base' ? expected.baseSha : expected.headSha);
}

function isCitation(value: unknown, expected: FindingChangeScopeInput['expected']): value is ValidatedCitation {
  if (!isObject(value) || !isString(value.id, 1_024) || !isSafePath(value.path)
    || value.repository !== expected.repository
    || (value.side !== 'base' && value.side !== 'head' && value.side !== 'diff')
    || value.baseSha !== expected.baseSha || value.headSha !== expected.headSha
    || value.revisionSha !== (value.side === 'base' ? expected.baseSha : expected.headSha)
    || !digestField(value.sourceDigest)) return false;
  if (value.regionDigest !== undefined && !digestField(value.regionDigest)) return false;
  if (value.side === 'diff') {
    return value.window === undefined && value.presence === undefined && digestField(value.regionDigest)
      && value.id === `diff:${value.path}:${value.regionDigest}`;
  }
  if (value.presence === 'absent') {
    return value.window === undefined && value.regionDigest === undefined
      && value.id === `absence:${value.side}:${value.path}`;
  }
  if (value.presence !== undefined || !isWindow(value.window, value, expected)) return false;
  return value.id === `window:${value.window.id}`
    && value.sourceDigest === value.window.windowSha256
    && (value.regionDigest === undefined || value.regionDigest === value.window.regionDigest);
}

function identityMatches(value: unknown, input: FindingChangeScopeInput, manifestDigest: string): boolean {
  if (!isObject(value)) return false;
  return value.repository === input.expected.repository
    && value.baseSha === input.expected.baseSha
    && value.headSha === input.expected.headSha
    && value.findingFingerprint === input.expected.findingFingerprint
    && value.candidateSide === input.expected.candidateSide
    && value.sourceWindowManifestDigest === manifestDigest;
}

function allowedCitationIds(
  ids: unknown,
  side: 'base' | 'head' | 'diff',
  citationById: ReadonlyMap<string, ValidatedCitation>,
): ValidatedCitation[] | null {
  if (!uniqueStringIds(ids)) return null;
  const resolved = (ids as string[]).map((id) => citationById.get(id));
  if (resolved.some((citation) => !citation || citation.side !== side)) return null;
  return resolved as ValidatedCitation[];
}

function hasPath(citations: readonly ValidatedCitation[], path: string): boolean {
  return citations.some((citation) => citation.path === path);
}

function causeAnchorIsBound(
  anchor: ObjectValue,
  expectedSide: 'head' | 'base',
  componentPath: string,
  citationById: ReadonlyMap<string, ValidatedCitation>,
): boolean {
  if (anchor.side !== expectedSide || anchor.componentPath !== componentPath || !isSafePath(anchor.componentPath)
    || !Number.isSafeInteger(anchor.startLine) || Number(anchor.startLine) < 1
    || !Number.isSafeInteger(anchor.endLine) || Number(anchor.endLine) < Number(anchor.startLine)
    || Number(anchor.endLine) - Number(anchor.startLine) + 1 > MAX_CAUSE_ANCHOR_LINES
    || !digestField(anchor.contentDigest) || !uniqueStringIds(anchor.citationIds, 8)) return false;
  const windows = (anchor.citationIds as string[]).map((id) => citationById.get(id));
  if (windows.some((citation) => !citation || citation.side !== expectedSide || citation.path !== componentPath || !citation.window)) return false;
  return (windows as ValidatedCitation[]).some((citation) => {
    const window = citation.window!;
    if (window.startLine > Number(anchor.startLine) || window.endLine < Number(anchor.endLine)) return false;
    if (expectedSide === 'head') return window.role !== 'mapped-base';
    if (window.mapping.kind !== 'changed-hunk' || window.mapping.candidateSide !== 'base'
      || !['deletion-gap', 'replaced-region'].includes(window.mapping.relation)) return false;
    return window.mapping.candidateLine >= Number(anchor.startLine) && window.mapping.candidateLine <= Number(anchor.endLine);
  });
}

function causalPathIsBound(input: {
  relation: FindingCausalPathRelation;
  candidatePath: string;
  candidateSide: 'head' | 'base';
  componentPath: string;
  contractId: string;
  citationIds: unknown;
  citationById: ReadonlyMap<string, ValidatedCitation>;
}): boolean {
  if (!uniqueStringIds(input.citationIds)) return false;
  const rows = (input.citationIds as string[]).map((id) => input.citationById.get(id));
  if (rows.some((citation) => !citation)) return false;
  const citations = rows as ValidatedCitation[];
  const sourceSide = citations.filter((citation) => citation.side === input.candidateSide);
  const head = citations.filter((citation) => citation.side === 'head');
  const diffs = citations.filter((citation) => citation.side === 'diff');
  if (!hasPath(sourceSide, input.candidatePath) || !hasPath(sourceSide, input.componentPath) || diffs.length === 0) return false;
  if (input.relation === 'same-component') {
    return input.candidatePath === input.componentPath && diffs.some((citation) => citation.path === input.candidatePath);
  }
  if (input.relation === 'dependency-edge' || input.relation === 'contract-edge') {
    if (input.candidatePath === input.componentPath || !diffs.some((citation) => citation.path === input.candidatePath)) return false;
    return sourceSide.some((citation) => {
      if (citation.path !== input.componentPath || citation.window?.role !== 'dependency-contract'
        || citation.window.mapping.kind !== 'dependency-contract') return false;
      const edge = citation.window.mapping.edge as unknown as ObjectValue;
      const importer = sourceSide.find((candidate) => {
        const window = candidate.path === input.candidatePath ? candidate.window : undefined;
        if (!window || window.fullContentSha256 !== edge.importerFullContentSha256
          || window.startLine > Number(edge.importerStatementStartLine)
          || window.endLine < Number(edge.importerStatementEndLine)) return false;
        if (String(window.role) !== 'dependency-caller') return true;
        if (window.mapping.kind !== 'dependency-contract') return false;
        const callerEdge = window.mapping.edge as unknown as ObjectValue;
        return canonicalJson(callerEdge) === canonicalJson(edge);
      });
      return edge.importerPath === input.candidatePath && edge.importerSide === input.candidateSide
        && edge.resolvedPath === input.componentPath && edge.contractId === input.contractId
        && citation.window.fullContentSha256 === edge.contractFullContentSha256
        && isString(edge.importSpecifier, 1_024) && digestField(edge.importStatementDigest)
        && importer !== undefined
        && diffs.some((diff) => diff.path === input.candidatePath && diff.regionDigest === edge.originRegionDigest);
    });
  }
  if (input.relation === 'unrelated') {
    const base = citations.filter((citation) => citation.side === 'base');
    return input.candidatePath !== input.componentPath && hasPath(base, input.candidatePath)
      && hasPath(base, input.componentPath) && hasPath(head, input.candidatePath) && hasPath(head, input.componentPath);
  }
  return false;
}

function causePart(value: unknown): string | null {
  if (!isString(value, 128)) return null;
  const normalized = value.toLowerCase().replace(/[\s_]+/gu, '-');
  return ROOT_CAUSE_ID.test(normalized) ? normalized : null;
}

function isExpectedIdentityValid(expected: FindingChangeScopeInput['expected']): boolean {
  return REPOSITORY.test(expected.repository) && SHA.test(expected.baseSha) && SHA.test(expected.headSha)
    && FINDING_FINGERPRINT.test(expected.findingFingerprint)
    && (expected.candidateSide === 'head' || expected.candidateSide === 'base')
    && isSafePath(expected.candidatePath);
}

function unproven(reasonCode: FindingChangeScopeReasonCode): FindingChangeScopeDecision {
  return issueScopeDecision({ version: FINDING_CHANGE_SCOPE_VERSION, causalScope: 'unproven', reviewIdentity: null,
    rootCauseEvidenceKey: null, evidenceDigest: null, reasonCode });
}

function issueScopeDecision(decision: FindingChangeScopeDecision): FindingChangeScopeDecision {
  if (decision.reviewIdentity) Object.freeze(decision.reviewIdentity);
  Object.freeze(decision);
  issuedScopeDecisions.add(decision);
  return decision;
}

function isIssuedScopeDecision(value: unknown): value is FindingChangeScopeDecision {
  return isObject(value) && issuedScopeDecisions.has(value);
}

function proven(
  causalScope: Exclude<FindingCausalScope, 'unproven'>,
  rootCauseEvidenceKey: string,
  proof: FindingChangeScopeProofV1,
  reviewIdentity: { repository: string; baseSha: string; headSha: string },
): FindingChangeScopeDecision {
  const evidenceDigest = sha256(canonicalJson({ version: 'FindingChangeScopeEvidenceBinding.v1', causalScope,
    rootCauseEvidenceKey, proof }));
  const reasonCode = causalScope === 'introduced' ? 'introduced_proven'
    : causalScope === 'exacerbated' ? 'exacerbated_proven' : 'preexisting_proven';
  return issueScopeDecision({ version: FINDING_CHANGE_SCOPE_VERSION, causalScope,
    reviewIdentity: { ...reviewIdentity }, rootCauseEvidenceKey, evidenceDigest, reasonCode });
}

/**
 * Classifies an independently verified defect against exact base/head source and diff evidence.
 * This reducer never infers causality from a changed path or line number; every causal fact must
 * resolve through the exact v2 citation allow-list bound to the same manifest digest.
 */
export function classifyFindingChangeScope(input: FindingChangeScopeInput): FindingChangeScopeDecision {
  if (!isExpectedIdentityValid(input.expected)) return unproven('input_identity_invalid');
  if (!Array.isArray(input.citations) || input.citations.length === 0 || input.citations.length > 64
    || !input.citations.every((citation) => isCitation(citation, input.expected))) {
    return unproven('citation_binding_invalid');
  }
  const citationById = new Map<string, ValidatedCitation>();
  for (const citation of input.citations) {
    if (citationById.has(citation.id)) return unproven('citation_unavailable_or_ambiguous');
    citationById.set(citation.id, citation);
  }
  let manifestDigest: string;
  try { manifestDigest = groundedCitationManifestDigest(input.citations); }
  catch { return unproven('citation_manifest_invalid'); }
  if (!digestField(input.sourceWindowManifestDigest) || input.sourceWindowManifestDigest !== manifestDigest) {
    return unproven('citation_manifest_mismatch');
  }
  if (!isObject(input.proof)) return unproven('proof_missing');
  const proof = input.proof;
  if (proof.version !== FINDING_CHANGE_SCOPE_PROOF_VERSION
    || !identityMatches(proof.identity, input, manifestDigest)) return unproven('proof_identity_mismatch');
  if (!isObject(proof.independentVerifier) || proof.independentVerifier.role !== 'independent-grounded-verifier'
    || proof.independentVerifier.status !== 'confirmed' || !digestField(proof.independentVerifier.evidenceDigest)) {
    return unproven('verifier_not_confirming');
  }
  let recomputedProofDigest: string;
  try { recomputedProofDigest = findingChangeScopeProofDigest(proof as unknown as FindingChangeScopeProofV1); }
  catch { return unproven('verifier_not_confirming'); }
  if (proof.independentVerifier.evidenceDigest !== recomputedProofDigest
    || input.trustedProofDigest !== recomputedProofDigest) return unproven('verifier_not_confirming');
  if (!isObject(proof.rootCause) || proof.rootCause.version !== FINDING_ROOT_CAUSE_IDENTITY_VERSION) {
    return unproven('root_cause_identity_invalid');
  }
  const rootCause = {
    componentId: causePart(proof.rootCause.componentId),
    behaviorId: causePart(proof.rootCause.behaviorId),
    contractId: causePart(proof.rootCause.contractId),
    failureModeId: causePart(proof.rootCause.failureModeId),
  };
  if (!rootCause.componentId || !rootCause.behaviorId || !rootCause.contractId || !rootCause.failureModeId) {
    return unproven('root_cause_identity_invalid');
  }
  const causeAnchor = proof.causeAnchor;
  if (!isObject(causeAnchor) || !causeAnchorIsBound(causeAnchor, input.expected.candidateSide,
    String(causeAnchor.componentPath ?? ''), citationById)) {
    return unproven('cause_anchor_invalid');
  }
  const componentPath = causeAnchor.componentPath as string;
  const causalPath = proof.causalPath;
  if (!isObject(causalPath)
    || !['same-component', 'dependency-edge', 'contract-edge', 'unrelated', 'unknown'].includes(String(causalPath.relation))
    || !causalPathIsBound({ relation: causalPath.relation as FindingCausalPathRelation,
      candidatePath: input.expected.candidatePath, candidateSide: input.expected.candidateSide,
      componentPath, contractId: rootCause.contractId,
      citationIds: causalPath.citationIds, citationById })) return unproven('causal_path_unproven');

  const baseState = proof.baseState;
  const headState = proof.headState;
  if (!isObject(baseState) || !isObject(headState)) return unproven('side_state_unproven');
  const baseCitations = allowedCitationIds(baseState.citationIds, 'base', citationById);
  const headCitations = allowedCitationIds(headState.citationIds, 'head', citationById);
  if (!baseCitations || !headCitations
    || !hasPath(baseCitations, input.expected.candidatePath) || !hasPath(baseCitations, componentPath)
    || !hasPath(headCitations, input.expected.candidatePath) || !hasPath(headCitations, componentPath)) {
    return unproven('side_state_unproven');
  }
  const anchorIds = causeAnchor.citationIds as string[];
  const anchorSideCitations = input.expected.candidateSide === 'head' ? headCitations : baseCitations;
  if (anchorIds.some((id) => !anchorSideCitations.some((citation) => citation.id === id))) return unproven('cause_anchor_invalid');
  if (input.expected.candidateSide === 'base') {
    const oldAnchorWindows = anchorIds.map((id) => citationById.get(id)?.window).filter(Boolean) as GroundedSourceWindowV1[];
    const removedRegion = oldAnchorWindows.some((window) => window.mapping.kind === 'changed-hunk'
      && window.mapping.candidateSide === 'base' && ['deletion-gap', 'replaced-region'].includes(window.mapping.relation));
    const newSide = headCitations.filter((citation) => citation.path === componentPath);
    const authenticatedAbsence = newSide.some((citation) => citation.presence === 'absent');
    const insertionGap = oldAnchorWindows.some((oldWindow) => {
      const oldMapping = oldWindow.mapping;
      if (oldMapping.kind !== 'changed-hunk' || oldMapping.relation !== 'deletion-gap') return false;
      return newSide.some((citation) => {
        const newMapping = citation.window?.mapping;
        return newMapping?.kind === 'changed-hunk' && newMapping.candidateSide === 'head'
          && newMapping.relation === 'insertion-gap' && newMapping.hunkOrdinal === oldMapping.hunkOrdinal
          && newMapping.oldStart === oldMapping.oldStart && newMapping.oldLines === oldMapping.oldLines
          && newMapping.newStart === oldMapping.newStart && newMapping.newLines === oldMapping.newLines;
      });
    });
    const replacedCounterpart = oldAnchorWindows.some((oldWindow) => {
      const oldMapping = oldWindow.mapping;
      if (oldMapping.kind !== 'changed-hunk' || oldMapping.relation !== 'replaced-region') return false;
      return newSide.some((citation) => {
        const newMapping = citation.window?.mapping;
        return newMapping?.kind === 'changed-hunk'
          && newMapping.candidateSide === 'head' && newMapping.relation === 'replaced-region'
          && newMapping.hunkOrdinal === oldMapping.hunkOrdinal
          && newMapping.oldStart === oldMapping.oldStart && newMapping.oldLines === oldMapping.oldLines
          && newMapping.newStart === oldMapping.newStart && newMapping.newLines === oldMapping.newLines;
      });
    });
    if (!removedRegion || (!authenticatedAbsence && !insertionGap && !replacedCounterpart)) {
      return unproven('cause_anchor_invalid');
    }
  }

  const baseTrigger = baseState.trigger;
  const baseContract = baseState.contract;
  const headTrigger = headState.trigger;
  const headContract = headState.contract;
  if (!['present', 'absent'].includes(String(baseTrigger)) || !['present', 'absent'].includes(String(headTrigger))
    || !['violated', 'not-violated'].includes(String(baseContract))
    || !['violated', 'not-violated'].includes(String(headContract))) return unproven('side_state_unproven');
  if ((baseTrigger === 'absent' && baseContract === 'violated')
    || (headTrigger === 'absent' && headContract === 'violated')) return unproven('causal_change_contradictory');

  const causalChange = isObject(proof.causalChange) ? proof.causalChange : null;
  const deltaCitations = causalChange
    ? allowedCitationIds(causalChange.citationIds, 'diff', citationById) : null;
  if (!causalChange || !deltaCitations || deltaCitations.length === 0) return unproven('causal_change_unproven');
  if (!deltaCitations.some((citation) => citation.path === input.expected.candidatePath || citation.path === componentPath)) {
    return unproven('causal_change_unproven');
  }
  const relation = causalChange.relation;
  let causalScope: Exclude<FindingCausalScope, 'unproven'> | null = null;
  if (baseContract === 'not-violated' && headTrigger === 'present' && headContract === 'violated'
    && relation === 'introduced') causalScope = 'introduced';
  else if (baseTrigger === 'present' && baseContract === 'violated' && headTrigger === 'present' && headContract === 'violated'
    && relation === 'materially-worsened'
    && ['reachability', 'impact', 'frequency', 'attack-surface'].includes(String(causalChange.materiality))) {
    causalScope = 'exacerbated';
  } else if (baseTrigger === 'present' && baseContract === 'violated' && headTrigger === 'present' && headContract === 'violated'
    && relation === 'unaffected') causalScope = 'preexisting';
  if (!causalScope) return unproven('causal_change_contradictory');
  if (causalPath.relation === 'unrelated' && causalScope !== 'preexisting') return unproven('causal_path_unproven');

  const rootCauseEvidenceKey = `cause-evidence-v1:${sha256(canonicalJson({
    version: FINDING_ROOT_CAUSE_EVIDENCE_KEY_VERSION,
    repository: input.expected.repository,
    candidateSide: input.expected.candidateSide,
    rootCause,
    componentPath,
    anchorSide: causeAnchor.side,
    startLine: causeAnchor.startLine,
    endLine: causeAnchor.endLine,
    contentDigest: causeAnchor.contentDigest,
  }))}`;
  return proven(causalScope, rootCauseEvidenceKey, proof as unknown as FindingChangeScopeProofV1, input.expected);
}

export interface ScopedFindingForSummary {
  findingId: string;
  severity: 'P0' | 'P1' | 'P2' | 'P3' | 'NIT';
  causalScope: FindingChangeScopeDecision;
}

export interface FindingRootCauseEvidenceGroup {
  rootCauseEvidenceKey: string;
  findingIds: string[];
  severities: Array<'P0' | 'P1' | 'P2' | 'P3' | 'NIT'>;
  causalScopes: Array<Exclude<FindingCausalScope, 'unproven'>>;
}

export interface FindingChangeScopeSummary {
  rootCauseGroups: FindingRootCauseEvidenceGroup[];
  blockingFindingIds: string[];
  blockingRootCauseEvidenceKeys: string[];
  baselineFindingIds: string[];
  incompleteFindingIds: string[];
  advisoryFindingIds: string[];
  unverifiedAdvisoryFindingIds: string[];
  reviewIncomplete: boolean;
}

export interface TrustedFindingChangeScopeReviewIdentity {
  repository: string;
  baseSha: string;
  headSha: string;
}

const UNPROVEN_REASON_CODES = new Set<FindingChangeScopeReasonCode>([
  'proof_missing', 'input_identity_invalid', 'proof_identity_mismatch', 'citation_manifest_invalid',
  'citation_manifest_mismatch', 'citation_unavailable_or_ambiguous', 'citation_binding_invalid',
  'verifier_not_confirming', 'root_cause_identity_invalid', 'cause_anchor_invalid', 'causal_path_unproven',
  'side_state_unproven', 'causal_change_unproven', 'causal_change_contradictory',
]);

function scopeDecisionHasConsistentState(decision: FindingChangeScopeDecision): boolean {
  if (decision.causalScope === 'introduced') return decision.reasonCode === 'introduced_proven';
  if (decision.causalScope === 'exacerbated') return decision.reasonCode === 'exacerbated_proven';
  if (decision.causalScope === 'preexisting') return decision.reasonCode === 'preexisting_proven';
  return decision.causalScope === 'unproven' && UNPROVEN_REASON_CODES.has(decision.reasonCode)
    && decision.reviewIdentity === null && decision.rootCauseEvidenceKey === null && decision.evidenceDigest === null;
}

function matchesTrustedReviewIdentity(
  value: unknown,
  expected: TrustedFindingChangeScopeReviewIdentity,
): boolean {
  return isObject(value) && value.repository === expected.repository
    && value.baseSha === expected.baseSha && value.headSha === expected.headSha;
}

function isTrustedReviewIdentity(value: TrustedFindingChangeScopeReviewIdentity): boolean {
  return REPOSITORY.test(value.repository) && SHA.test(value.baseSha) && SHA.test(value.headSha);
}

/**
 * Reduces already classified findings without rewriting severity. Unknown P0/P1 scope makes the
 * review incomplete; unknown P2/P3/NIT findings are unverified advisories and are omitted from
 * publication. A verified preexisting blocker remains baseline context, and a new P2 stays advisory.
 * Decisions are accepted only as immutable objects issued by this module in the current process and
 * for the exact trusted repository/base/head. After any serialization boundary, re-run classification
 * from the original proof and trusted source context; serialized decisions carry no authority.
 */
export function summarizeFindingChangeScopes(
  findings: readonly ScopedFindingForSummary[],
  trustedReviewIdentity: TrustedFindingChangeScopeReviewIdentity,
): FindingChangeScopeSummary {
  const rootCauseGroups = new Map<string, { findingIds: Set<string>; severities: Set<string>; scopes: Set<string> }>();
  const blockingFindingIds = new Set<string>();
  const blockingRootCauseEvidenceKeys = new Set<string>();
  const baselineFindingIds = new Set<string>();
  const incompleteFindingIds = new Set<string>();
  const advisoryFindingIds = new Set<string>();
  const unverifiedAdvisoryFindingIds = new Set<string>();
  const seenFindingIds = new Set<string>();

  for (const finding of findings) {
    const id = typeof finding?.findingId === 'string' ? finding.findingId : '';
    if (!id || seenFindingIds.has(id)) {
      if (id && BLOCKING_SEVERITIES.has(finding?.severity)) incompleteFindingIds.add(id);
      else if (id) unverifiedAdvisoryFindingIds.add(id);
      continue;
    }
    seenFindingIds.add(id);
    const scope = finding?.causalScope;
    const severity = finding?.severity;
    if (!SEVERITIES.has(severity)) {
      incompleteFindingIds.add(id);
      continue;
    }
    const trustedDecision = isIssuedScopeDecision(scope)
      && scope.version === FINDING_CHANGE_SCOPE_VERSION
      && scopeDecisionHasConsistentState(scope)
      && isTrustedReviewIdentity(trustedReviewIdentity)
      && (scope.causalScope === 'unproven' || matchesTrustedReviewIdentity(scope.reviewIdentity, trustedReviewIdentity));
    if (!trustedDecision || scope.causalScope === 'unproven'
      || !scope.evidenceDigest || !DIGEST.test(scope.evidenceDigest)
      || !scope.rootCauseEvidenceKey || !/^cause-evidence-v1:[a-f0-9]{64}$/u.test(scope.rootCauseEvidenceKey)) {
      if (BLOCKING_SEVERITIES.has(severity)) incompleteFindingIds.add(id);
      else unverifiedAdvisoryFindingIds.add(id);
      continue;
    }
    const group = rootCauseGroups.get(scope.rootCauseEvidenceKey) ?? {
      findingIds: new Set<string>(), severities: new Set<string>(), scopes: new Set<string>(),
    };
    group.findingIds.add(id);
    group.severities.add(severity);
    group.scopes.add(scope.causalScope);
    rootCauseGroups.set(scope.rootCauseEvidenceKey, group);

    if (scope.causalScope === 'preexisting') baselineFindingIds.add(id);
    else if (BLOCKING_SEVERITIES.has(severity)) {
      blockingFindingIds.add(id);
      blockingRootCauseEvidenceKeys.add(scope.rootCauseEvidenceKey);
    } else advisoryFindingIds.add(id);
  }

  return {
    rootCauseGroups: [...rootCauseGroups.entries()].sort(([left], [right]) => left.localeCompare(right))
      .map(([rootCauseEvidenceKey, group]) => ({ rootCauseEvidenceKey,
        findingIds: [...group.findingIds].sort(),
        severities: [...group.severities].sort((left, right) => ['P0', 'P1', 'P2', 'P3', 'NIT'].indexOf(left)
          - ['P0', 'P1', 'P2', 'P3', 'NIT'].indexOf(right)) as FindingRootCauseEvidenceGroup['severities'],
        causalScopes: [...group.scopes].sort() as FindingRootCauseEvidenceGroup['causalScopes'],
      })),
    blockingFindingIds: [...blockingFindingIds].sort(),
    blockingRootCauseEvidenceKeys: [...blockingRootCauseEvidenceKeys].sort(),
    baselineFindingIds: [...baselineFindingIds].sort(),
    incompleteFindingIds: [...incompleteFindingIds].sort(),
    advisoryFindingIds: [...advisoryFindingIds].sort(),
    unverifiedAdvisoryFindingIds: [...unverifiedAdvisoryFindingIds].sort(),
    reviewIncomplete: incompleteFindingIds.size > 0,
  };
}
