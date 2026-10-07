import { describe, expect, it } from 'vitest';
import {
  classifyFindingChangeScope,
  findingChangeScopeProofDigest,
  summarizeFindingChangeScopes as summarizeWithContext,
  type FindingChangeScopeProofV1,
} from '../../src/review/findingChangeScope';
import { sha256 } from '../../src/review/reviewCore';
import {
  groundedCitationManifestDigest,
  type GroundedDependencyEdgeV1,
  type GroundedCitationV2,
} from '../../src/review/groundedEvidenceV2';
import { groundedDependencyContractId } from '../../src/review/groundedSourceWindows';

const REPOSITORY = 'sample/review-target';
const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const DIGEST = 'c'.repeat(64);
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const FINDING_A = `fp1_${'d'.repeat(24)}`;
const FINDING_B = `fp1_${'e'.repeat(24)}`;
const REVIEW_CONTEXT = { repository: REPOSITORY, baseSha: BASE, headSha: HEAD };

function sourceCitation(side: 'base' | 'head', path: string): GroundedCitationV2 {
  const revisionSha = side === 'base' ? BASE : HEAD;
  const id = `window:${side}-${path.replaceAll('/', '-')}`;
  const window = {
    version: 'GroundedSourceWindow.v1' as const,
    id: id.slice('window:'.length),
    repository: REPOSITORY,
    path,
    side,
    role: side === 'base' ? 'mapped-base' as const : 'candidate' as const,
    revisionSha,
    headSha: HEAD,
    baseSha: BASE,
    fullContentSha256: DIGEST,
    startLine: 1,
    endLine: 12,
    windowSha256: DIGEST,
    byteLength: 280,
    regionDigest: DIGEST,
    mapping: { kind: 'changed-hunk' as const, candidateSide: 'head' as const, candidateLine: 3, hunkOrdinal: 1,
      oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, relation: 'replaced-region' as const,
      counterpartStartLine: 3, counterpartEndLine: 3, beforeLine: null, afterLine: null },
    exhaustive: true,
  };
  return { id, path, repository: REPOSITORY, side, revisionSha, headSha: HEAD, baseSha: BASE,
    sourceDigest: window.windowSha256, window };
}

const sourceId = (side: 'base' | 'head', path: string) => `window:${side}-${path.replaceAll('/', '-')}`;
const diffId = (path: string) => `diff:${path}:${'f'.repeat(64)}`;

function absentHeadCitation(path: string): GroundedCitationV2 {
  return { id: `absence:head:${path}`, path, repository: REPOSITORY, side: 'head', revisionSha: HEAD,
    headSha: HEAD, baseSha: BASE, sourceDigest: '7'.repeat(64), presence: 'absent' };
}

function diffCitation(path: string): GroundedCitationV2 {
  return { id: `diff:${path}:${'f'.repeat(64)}`, path, repository: REPOSITORY, side: 'diff',
    revisionSha: HEAD, headSha: HEAD, baseSha: BASE, sourceDigest: '9'.repeat(64), regionDigest: 'f'.repeat(64) };
}

function dependencyCitation(path: string, importerPath: string): GroundedCitationV2 {
  const citation = sourceCitation('head', path);
  return { ...citation, window: { ...citation.window!, role: 'dependency-contract', mapping: {
    kind: 'dependency-contract', exhaustive: true, edge: dependencyEdge(importerPath, path),
  } } };
}

function dependencyEdge(importerPath: string, resolvedPath: string): GroundedDependencyEdgeV1 {
  const material: Omit<GroundedDependencyEdgeV1, 'contractId'> = {
    resolver: 'relative-import-v1', importerPath, importerSide: 'head', importerFullContentSha256: DIGEST,
    importerStatementStartLine: 3, importerStatementEndLine: 3, importSpecifier: './routing-contract',
    contractSymbols: ['dispatchContract'], resolvedPath, contractFullContentSha256: DIGEST,
    definitionStartLine: 3, definitionEndLine: 5, definitionSha256: '5'.repeat(64),
    importStatementDigest: '7'.repeat(64), originRegionDigest: 'f'.repeat(64),
  };
  return { ...material, contractId: groundedDependencyContractId(material) };
}

function dependencyCallerCitation(path: string, resolvedPath: string): GroundedCitationV2 {
  const citation = sourceCitation('head', path);
  const window = { ...citation.window!, id: `${citation.window!.id}-caller`, role: 'dependency-caller' as const,
    mapping: { kind: 'dependency-contract' as const, exhaustive: true as const, edge: dependencyEdge(path, resolvedPath) } };
  return { ...citation, id: `window:${window.id}`, window };
}

function deletedBaseCitation(path: string): GroundedCitationV2 {
  const citation = sourceCitation('base', path);
  return { ...citation, window: { ...citation.window!, mapping: {
    kind: 'changed-hunk', candidateSide: 'base', candidateLine: 3, hunkOrdinal: 1,
    oldStart: 3, oldLines: 2, newStart: 0, newLines: 0, relation: 'deletion-gap',
    counterpartStartLine: null, counterpartEndLine: null, beforeLine: 2, afterLine: 3,
  } } };
}

function presentEmptyHeadGapCitation(path: string): GroundedCitationV2 {
  const citation = sourceCitation('head', path);
  const window = { ...citation.window!, startLine: 1, endLine: 0, fullContentSha256: EMPTY_SHA256,
    windowSha256: EMPTY_SHA256, byteLength: 0, mapping: {
    kind: 'changed-hunk' as const, candidateSide: 'head' as const, candidateLine: 1, hunkOrdinal: 1,
    oldStart: 3, oldLines: 2, newStart: 0, newLines: 0, relation: 'insertion-gap' as const,
    counterpartStartLine: null, counterpartEndLine: null, beforeLine: null, afterLine: null,
  } };
  return { ...citation, sourceDigest: EMPTY_SHA256, window };
}

function proofFor(input: {
  findingFingerprint?: string;
  citations: GroundedCitationV2[];
  baseContract?: 'violated' | 'not-violated' | 'unknown';
  headContract?: 'violated' | 'not-violated' | 'unknown';
  baseTrigger?: 'present' | 'absent' | 'unknown';
  headTrigger?: 'present' | 'absent' | 'unknown';
  relation?: 'introduced' | 'materially-worsened' | 'unaffected' | 'unknown';
  materiality?: 'reachability' | 'impact' | 'frequency' | 'attack-surface';
  rootCause?: Partial<FindingChangeScopeProofV1['rootCause']>;
  baseCitationIds?: string[];
  headCitationIds?: string[];
  deltaCitationIds?: string[];
  candidatePath?: string;
  candidateSide?: 'head' | 'base';
  causeAnchor?: Partial<FindingChangeScopeProofV1['causeAnchor']>;
  causalPath?: Partial<FindingChangeScopeProofV1['causalPath']>;
}): FindingChangeScopeProofV1 {
  const sourceWindowManifestDigest = groundedCitationManifestDigest(input.citations);
  const candidatePath = input.candidatePath ?? 'src/conversion.ts';
  const candidateSide = input.candidateSide ?? 'head';
  const causeAnchor = {
    side: candidateSide,
    componentPath: 'src/conversion.ts',
    startLine: 3,
    endLine: 5,
    citationIds: [sourceId('head', 'src/conversion.ts')],
    contentDigest: '6'.repeat(64),
    ...input.causeAnchor,
  };
  const proof: FindingChangeScopeProofV1 = {
    version: 'FindingChangeScopeProof.v1',
    identity: { repository: REPOSITORY, baseSha: BASE, headSha: HEAD,
      findingFingerprint: input.findingFingerprint ?? FINDING_A, candidateSide, sourceWindowManifestDigest },
    independentVerifier: { role: 'independent-grounded-verifier', status: 'confirmed', evidenceDigest: '8'.repeat(64) },
    rootCause: {
      version: 'ReviewYetiRootCauseIdentity.v1',
      componentId: 'request-dispatch.input-normalization',
      behaviorId: 'normalize-before-dispatch',
      contractId: 'dispatch-receives-canonical-input',
      failureModeId: 'normalization-skipped',
      ...input.rootCause,
    },
    causeAnchor,
    causalPath: { relation: 'same-component', citationIds: [sourceId(candidateSide, candidatePath),
      ...(candidatePath === causeAnchor.componentPath ? [] : [sourceId(candidateSide, causeAnchor.componentPath)]), diffId(candidatePath)],
      ...input.causalPath },
    baseState: { trigger: input.baseTrigger ?? 'present', contract: input.baseContract ?? 'violated',
      citationIds: input.baseCitationIds ?? [sourceId('base', candidatePath)] },
    headState: { trigger: input.headTrigger ?? 'present', contract: input.headContract ?? 'violated',
      citationIds: input.headCitationIds ?? [sourceId('head', candidatePath)] },
    causalChange: { relation: input.relation ?? 'unaffected',
      ...(input.materiality ? { materiality: input.materiality } : {}),
      citationIds: input.deltaCitationIds ?? [diffId(candidatePath)] },
  };
  proof.independentVerifier.evidenceDigest = findingChangeScopeProofDigest(proof);
  return proof;
}

function classify(input: {
  citations?: GroundedCitationV2[];
  proof?: FindingChangeScopeProofV1 | null;
  findingFingerprint?: string;
  candidateSide?: 'head' | 'base';
  candidatePath?: string;
  trustedProofDigest?: string;
  trustedSourceWindowManifestDigest?: string;
}) {
  const citations = input.citations ?? [sourceCitation('base', 'src/conversion.ts'),
    sourceCitation('head', 'src/conversion.ts'), diffCitation('src/conversion.ts')];
  const proof = input.proof === undefined ? proofFor({ citations, findingFingerprint: input.findingFingerprint,
    candidatePath: input.candidatePath, causeAnchor: input.candidatePath && input.candidatePath !== 'src/conversion.ts'
      ? { componentPath: input.candidatePath, citationIds: [sourceId('head', input.candidatePath)] } : undefined }) : input.proof;
  return classifyFindingChangeScope({ expected: { repository: REPOSITORY, baseSha: BASE, headSha: HEAD,
    findingFingerprint: input.findingFingerprint ?? FINDING_A, candidateSide: input.candidateSide ?? 'head',
    candidatePath: input.candidatePath ?? 'src/conversion.ts' }, proof,
  trustedProofDigest: input.trustedProofDigest ?? proof?.independentVerifier.evidenceDigest ?? '',
  sourceWindowManifestDigest: input.trustedSourceWindowManifestDigest
    ?? proof?.identity.sourceWindowManifestDigest ?? groundedCitationManifestDigest(citations), citations });
}

function summarizeFindingChangeScopes(
  findings: Parameters<typeof summarizeWithContext>[0],
) {
  return summarizeWithContext(findings, REVIEW_CONTEXT);
}

describe('classifyFindingChangeScope', () => {
  it('keeps a proven, unaffected P1 as baseline context instead of a new PR blocker', () => {
    const result = classify({});
    expect(result).toMatchObject({ causalScope: 'preexisting', rootCauseEvidenceKey: expect.stringMatching(/^cause-evidence-v1:[a-f0-9]{64}$/u) });
    const summary = summarizeFindingChangeScopes([{ findingId: 'baseline-claim-a', severity: 'P1', causalScope: result },
      { findingId: 'baseline-claim-b', severity: 'P1', causalScope: result }]);
    expect(summary.blockingFindingIds).toEqual([]);
    expect(summary.baselineFindingIds).toEqual(['baseline-claim-a', 'baseline-claim-b']);
    expect(summary.rootCauseGroups).toHaveLength(1);
    expect(summary.rootCauseGroups[0].findingIds).toEqual(['baseline-claim-a', 'baseline-claim-b']);
  });

  it('rejects the exact forged preexisting P1 counterexample even with plausible SHA-shaped fields', () => {
    const forgedDecision = {
      version: 'FindingChangeScope.v1',
      causalScope: 'preexisting',
      rootCauseEvidenceKey: `cause-evidence-v1:${'a'.repeat(64)}`,
      evidenceDigest: 'b'.repeat(64),
      reasonCode: 'preexisting_proven',
      reviewIdentity: REVIEW_CONTEXT,
    };
    const summary = summarizeWithContext([{ findingId: 'unverified-new-p1', severity: 'P1',
      causalScope: forgedDecision } as never], REVIEW_CONTEXT);
    expect(summary.blockingFindingIds).toEqual([]);
    expect(summary.baselineFindingIds).toEqual([]);
    expect(summary.incompleteFindingIds).toEqual(['unverified-new-p1']);
    expect(summary.reviewIncomplete).toBe(true);
    const advisory = summarizeWithContext([{ findingId: 'unverified-advisory', severity: 'P2',
      causalScope: forgedDecision } as never], REVIEW_CONTEXT);
    expect(advisory.unverifiedAdvisoryFindingIds).toEqual(['unverified-advisory']);
    expect(advisory.reviewIncomplete).toBe(false);
  });

  it('rejects copied, rehashed, mutated, and deserialized scope decisions', () => {
    const issued = classify({});
    expect(Object.isFrozen(issued)).toBe(true);
    expect(() => Object.assign(issued, { causalScope: 'preexisting' })).toThrow();
    const unchanged = summarizeFindingChangeScopes([{ findingId: 'still-module-issued', severity: 'P1', causalScope: issued }]);
    expect(unchanged.baselineFindingIds).toEqual(['still-module-issued']);

    const copied = { ...issued, causalScope: 'preexisting' as const,
      evidenceDigest: sha256({ copied: issued.evidenceDigest, causalScope: 'preexisting' }) };
    const deserialized = JSON.parse(JSON.stringify(issued));
    const summaries = [copied, deserialized].map((decision, index) => summarizeWithContext([
      { findingId: `forged-p1-${index}`, severity: 'P1', causalScope: decision } as never,
    ], REVIEW_CONTEXT));
    for (const summary of summaries) {
      expect(summary.baselineFindingIds).toEqual([]);
      expect(summary.incompleteFindingIds).toHaveLength(1);
      expect(summary.reviewIncomplete).toBe(true);
    }
  });

  it('rejects an authentic issued decision when the summary is bound to a later review head', () => {
    const issuedForOldHead = classify({});
    const summary = summarizeWithContext([
      { findingId: 'stale-head-p1', severity: 'P1', causalScope: issuedForOldHead },
      { findingId: 'stale-head-p2', severity: 'P2', causalScope: issuedForOldHead },
    ], { ...REVIEW_CONTEXT, headSha: 'c'.repeat(40) });
    expect(summary.baselineFindingIds).toEqual([]);
    expect(summary.incompleteFindingIds).toEqual(['stale-head-p1']);
    expect(summary.unverifiedAdvisoryFindingIds).toEqual(['stale-head-p2']);
    expect(summary.reviewIncomplete).toBe(true);
  });

  it('classifies a materially worsened reachability path as exacerbated', () => {
    const contractEdge = dependencyEdge('src/wrapper.ts', 'src/entry.ts');
    const citations = [sourceCitation('base', 'src/wrapper.ts'), sourceCitation('base', 'src/entry.ts'),
      sourceCitation('head', 'src/wrapper.ts'), dependencyCitation('src/entry.ts', 'src/wrapper.ts'),
      diffCitation('src/wrapper.ts')];
    const result = classify({ citations, candidatePath: 'src/wrapper.ts',
      proof: proofFor({ citations, candidatePath: 'src/wrapper.ts', relation: 'materially-worsened', materiality: 'reachability',
        rootCause: { contractId: contractEdge.contractId },
        causeAnchor: { componentPath: 'src/entry.ts', citationIds: [sourceId('head', 'src/entry.ts')] },
        causalPath: { relation: 'dependency-edge', citationIds: [sourceId('head', 'src/wrapper.ts'),
          sourceId('head', 'src/entry.ts'), diffId('src/wrapper.ts')] },
        baseCitationIds: [sourceId('base', 'src/wrapper.ts'), sourceId('base', 'src/entry.ts')],
        headCitationIds: [sourceId('head', 'src/wrapper.ts'), sourceId('head', 'src/entry.ts')],
        deltaCitationIds: [diffId('src/wrapper.ts')] }) });
    expect(result.causalScope).toBe('exacerbated');
  });

  it('preserves a new cross-file P1 blocker when exact source and changed-contract citations prove introduction', () => {
    const handlerCaller = dependencyCallerCitation('src/handler.ts', 'src/routing-contract.ts');
    const contractEdge = dependencyEdge('src/handler.ts', 'src/routing-contract.ts');
    const citations = [sourceCitation('base', 'src/handler.ts'), sourceCitation('base', 'src/routing-contract.ts'),
      handlerCaller, dependencyCitation('src/routing-contract.ts', 'src/handler.ts'),
      diffCitation('src/handler.ts'), diffCitation('src/routing-contract.ts')];
    const proof = proofFor({ citations, candidatePath: 'src/handler.ts', findingFingerprint: FINDING_B,
      baseContract: 'not-violated', relation: 'introduced',
      causeAnchor: { componentPath: 'src/routing-contract.ts', citationIds: [sourceId('head', 'src/routing-contract.ts')] },
      rootCause: { contractId: contractEdge.contractId },
      causalPath: { relation: 'dependency-edge', citationIds: [handlerCaller.id,
        sourceId('head', 'src/routing-contract.ts'), diffId('src/handler.ts')] },
      baseCitationIds: [sourceId('base', 'src/handler.ts'), sourceId('base', 'src/routing-contract.ts')],
      headCitationIds: [handlerCaller.id, sourceId('head', 'src/routing-contract.ts')],
      deltaCitationIds: [diffId('src/handler.ts'), diffId('src/routing-contract.ts')] });
    const result = classify({ citations, proof, candidatePath: 'src/handler.ts', findingFingerprint: FINDING_B });
    expect(result.causalScope).toBe('introduced');
    const summary = summarizeFindingChangeScopes([{ findingId: 'cross-file-routing-regression', severity: 'P1', causalScope: result }]);
    expect(summary.blockingFindingIds).toEqual(['cross-file-routing-regression']);
  });

  it('deduplicates paraphrases on one verified occurrence while keeping an opposite failure mode distinct', () => {
    const citations = [sourceCitation('base', 'src/conversion.ts'), sourceCitation('head', 'src/conversion.ts'),
      diffCitation('src/conversion.ts')];
    const first = classify({ citations, proof: proofFor({ citations, relation: 'introduced', baseContract: 'not-violated' }),
      findingFingerprint: FINDING_A });
    const lineShiftedParaphrase = classify({ citations,
      proof: proofFor({ citations, relation: 'introduced', baseContract: 'not-violated', findingFingerprint: FINDING_B }),
      findingFingerprint: FINDING_B });
    const oppositeClaim = classify({ citations,
      proof: proofFor({ citations, findingFingerprint: `fp1_${'1'.repeat(24)}`, relation: 'introduced', baseContract: 'not-violated',
        rootCause: { failureModeId: 'double-normalization' } }), findingFingerprint: `fp1_${'1'.repeat(24)}` });
    expect(first.rootCauseEvidenceKey).toBe(lineShiftedParaphrase.rootCauseEvidenceKey);
    expect(first.rootCauseEvidenceKey).not.toBe(oppositeClaim.rootCauseEvidenceKey);
    expect(oppositeClaim.causalScope).toBe('introduced');
    const summary = summarizeFindingChangeScopes([
      { findingId: 'wording-a-at-line-10', severity: 'P1', causalScope: first },
      { findingId: 'wording-b-at-line-42', severity: 'P1', causalScope: lineShiftedParaphrase },
      { findingId: 'opposite-cause', severity: 'P1', causalScope: oppositeClaim },
    ]);
    expect(summary.rootCauseGroups).toHaveLength(2);
    expect(summary.rootCauseGroups.map((group) => group.findingIds)).toContainEqual(['wording-a-at-line-10', 'wording-b-at-line-42']);
    expect(summary.blockingRootCauseEvidenceKeys).toHaveLength(2);
  });

  it('keeps identical generic cause labels separate when verified component evidence differs', () => {
    const firstCitations = [sourceCitation('base', 'src/conversion.ts'), sourceCitation('head', 'src/conversion.ts'),
      diffCitation('src/conversion.ts')];
    const secondCitations = [sourceCitation('base', 'src/format.ts'), sourceCitation('head', 'src/format.ts'),
      diffCitation('src/format.ts')];
    const first = classify({ citations: firstCitations,
      proof: proofFor({ citations: firstCitations, relation: 'introduced', baseContract: 'not-violated' }) });
    const second = classify({ citations: secondCitations,
      candidatePath: 'src/format.ts',
      proof: proofFor({ citations: secondCitations, candidatePath: 'src/format.ts', relation: 'introduced', baseContract: 'not-violated',
        causeAnchor: { componentPath: 'src/format.ts', citationIds: [sourceId('head', 'src/format.ts')] } }) });
    expect(first.rootCauseEvidenceKey).not.toBe(second.rootCauseEvidenceKey);
    expect(summarizeFindingChangeScopes([
      { findingId: 'conversion-defect', severity: 'P1', causalScope: first },
      { findingId: 'format-defect', severity: 'P1', causalScope: second },
    ]).rootCauseGroups).toHaveLength(2);
  });

  it('fails closed when causal change materiality is missing', () => {
    const citations = [sourceCitation('base', 'src/entry.ts'), sourceCitation('head', 'src/entry.ts'),
      diffCitation('src/entry.ts')];
    const result = classify({ citations, candidatePath: 'src/entry.ts',
      proof: proofFor({ citations, candidatePath: 'src/entry.ts', relation: 'materially-worsened',
        causeAnchor: { componentPath: 'src/entry.ts', citationIds: [sourceId('head', 'src/entry.ts')] },
        deltaCitationIds: [diffId('src/entry.ts')] }) });
    expect(result).toMatchObject({ causalScope: 'unproven', rootCauseEvidenceKey: null });
    const summary = summarizeFindingChangeScopes([{ findingId: 'unknown-material-change', severity: 'P1', causalScope: result }]);
    expect(summary.incompleteFindingIds).toEqual(['unknown-material-change']);
    expect(summary.reviewIncomplete).toBe(true);
    expect(summary.blockingFindingIds).toEqual([]);
  });

  it.each([
    ['stale head identity', (proof: FindingChangeScopeProofV1) => ({ ...proof,
      identity: { ...proof.identity, headSha: '0'.repeat(40) } })],
    ['spoofed citation id', (proof: FindingChangeScopeProofV1) => ({ ...proof,
      baseState: { ...proof.baseState, citationIds: ['window:base-invented'] } })],
    ['contradictory base state', (proof: FindingChangeScopeProofV1) => ({ ...proof,
      baseState: { ...proof.baseState, contract: 'violated' as const },
      causalChange: { ...proof.causalChange, relation: 'introduced' as const } })],
  ])('fails closed for %s proof', (_label, alter) => {
    const citations = [sourceCitation('base', 'src/conversion.ts'), sourceCitation('head', 'src/conversion.ts'),
      diffCitation('src/conversion.ts')];
    const result = classify({ citations, proof: alter(proofFor({ citations, relation: 'introduced', baseContract: 'not-violated' })) });
    expect(result).toMatchObject({ causalScope: 'unproven', rootCauseEvidenceKey: null });
  });

  it('rejects a forged anchor even when its public consistency hash is recomputed', () => {
    const citations = [sourceCitation('base', 'src/conversion.ts'), sourceCitation('head', 'src/conversion.ts'),
      diffCitation('src/conversion.ts')];
    const original = proofFor({ citations, relation: 'introduced', baseContract: 'not-violated' });
    const forged: FindingChangeScopeProofV1 = { ...original,
      causeAnchor: { ...original.causeAnchor, contentDigest: '7'.repeat(64) } };
    forged.independentVerifier = { ...forged.independentVerifier, evidenceDigest: findingChangeScopeProofDigest(forged) };
    const result = classify({ citations, proof: forged, trustedProofDigest: original.independentVerifier.evidenceDigest });
    expect(result).toMatchObject({ causalScope: 'unproven', rootCauseEvidenceKey: null, reasonCode: 'verifier_not_confirming' });
  });

  it('rejects rewritten citation bytes and a self-consistent new manifest against the trusted source manifest', () => {
    const source = sourceCitation('base', 'src/conversion.ts');
    const trustedCitations = [source, sourceCitation('head', 'src/conversion.ts'), diffCitation('src/conversion.ts')];
    const trustedProof = proofFor({ citations: trustedCitations, relation: 'introduced', baseContract: 'not-violated' });
    const rewrittenSource = { ...source, sourceDigest: '7'.repeat(64), window: { ...source.window!, windowSha256: '7'.repeat(64) } };
    const forgedCitations = [rewrittenSource, ...trustedCitations.slice(1)];
    const forgedProof = proofFor({ citations: forgedCitations, relation: 'introduced', baseContract: 'not-violated' });
    const result = classify({ citations: forgedCitations, proof: forgedProof,
      trustedSourceWindowManifestDigest: trustedProof.identity.sourceWindowManifestDigest });
    expect(result).toMatchObject({ causalScope: 'unproven', rootCauseEvidenceKey: null,
      reasonCode: 'citation_manifest_mismatch' });
  });

  it('fails closed when a base-side citation comes from a different admitted base SHA', () => {
    const base = sourceCitation('base', 'src/conversion.ts');
    const staleBase = { ...base, baseSha: '0'.repeat(40) };
    const citations = [staleBase, sourceCitation('head', 'src/conversion.ts'), diffCitation('src/conversion.ts')];
    const result = classify({ citations,
      proof: proofFor({ citations: [base, ...citations.slice(1)], relation: 'introduced', baseContract: 'not-violated' }) });
    expect(result).toMatchObject({ causalScope: 'unproven', rootCauseEvidenceKey: null,
      reasonCode: 'citation_binding_invalid' });
  });

  it('fails closed when an allow-listed citation id is ambiguous', () => {
    const base = sourceCitation('base', 'src/conversion.ts');
    const citations = [base, { ...base, sourceDigest: '7'.repeat(64) }, sourceCitation('head', 'src/conversion.ts'),
      diffCitation('src/conversion.ts')];
    const result = classify({ citations, proof: proofFor({ citations, relation: 'introduced', baseContract: 'not-violated' }) });
    expect(result).toMatchObject({ causalScope: 'unproven', rootCauseEvidenceKey: null });
  });

  it('keeps introduced P2 findings advisory and leaves their severity untouched', () => {
    const citations = [sourceCitation('base', 'src/config.ts'), sourceCitation('head', 'src/config.ts'),
      diffCitation('src/config.ts')];
    const causalScope = classify({ citations, candidatePath: 'src/config.ts',
      proof: proofFor({ citations, candidatePath: 'src/config.ts', relation: 'introduced', baseContract: 'not-violated',
        causeAnchor: { componentPath: 'src/config.ts', citationIds: [sourceId('head', 'src/config.ts')] } }) });
    const summary = summarizeFindingChangeScopes([{ findingId: 'configuration-advisory', severity: 'P2', causalScope }]);
    expect(summary.blockingFindingIds).toEqual([]);
    expect(summary.advisoryFindingIds).toEqual(['configuration-advisory']);
    expect(summary.rootCauseGroups[0].severities).toEqual(['P2']);
  });

  it('keeps unsupported P2/P3/NIT advisory claims out of approval completeness while an unproven P1 remains incomplete', () => {
    const citations = [sourceCitation('base', 'src/config.ts'), sourceCitation('head', 'src/config.ts'), diffCitation('src/config.ts')];
    const unproven = classify({ citations, candidatePath: 'src/config.ts',
      proof: proofFor({ citations, candidatePath: 'src/config.ts', relation: 'materially-worsened',
        causeAnchor: { componentPath: 'src/config.ts', citationIds: [sourceId('head', 'src/config.ts')] } }) });
    const findings = [
      { findingId: 'unsupported-p1', severity: 'P1' as const, causalScope: unproven },
      { findingId: 'unsupported-p2-a', severity: 'P2' as const, causalScope: unproven },
      { findingId: 'unsupported-p2-b', severity: 'P2' as const, causalScope: unproven },
      { findingId: 'unsupported-p2-c', severity: 'P2' as const, causalScope: unproven },
      { findingId: 'unsupported-p2-d', severity: 'P2' as const, causalScope: unproven },
      { findingId: 'unsupported-p3-a', severity: 'P3' as const, causalScope: unproven },
      { findingId: 'unsupported-p3-b', severity: 'P3' as const, causalScope: unproven },
      { findingId: 'unsupported-p3-c', severity: 'P3' as const, causalScope: unproven },
      { findingId: 'unsupported-p3-d', severity: 'P3' as const, causalScope: unproven },
      { findingId: 'unsupported-nit-a', severity: 'NIT' as const, causalScope: unproven },
      { findingId: 'unsupported-nit-b', severity: 'NIT' as const, causalScope: unproven },
    ];
    const summary = summarizeFindingChangeScopes(findings);
    const advisoryOnly = summarizeFindingChangeScopes(findings.slice(1));
    expect(summary.incompleteFindingIds).toEqual(['unsupported-p1']);
    expect(summary.unverifiedAdvisoryFindingIds).toHaveLength(10);
    expect(summary.reviewIncomplete).toBe(true);
    expect(advisoryOnly.incompleteFindingIds).toEqual([]);
    expect(advisoryOnly.reviewIncomplete).toBe(false);
  });

  it('distinguishes two cause anchors inside one broad source window', () => {
    const citations = [sourceCitation('base', 'src/conversion.ts'), sourceCitation('head', 'src/conversion.ts'),
      diffCitation('src/conversion.ts')];
    const first = classify({ citations, proof: proofFor({ citations, relation: 'introduced', baseContract: 'not-violated',
      causeAnchor: { startLine: 2, endLine: 3, contentDigest: '4'.repeat(64) } }) });
    const second = classify({ citations, proof: proofFor({ citations, relation: 'introduced', baseContract: 'not-violated',
      causeAnchor: { startLine: 8, endLine: 9, contentDigest: '4'.repeat(64) } }) });
    expect(first.rootCauseEvidenceKey).not.toBe(second.rootCauseEvidenceKey);
  });

  it('keeps paraphrases on one current occurrence together and separates same bytes at another occurrence', () => {
    const citations = [sourceCitation('base', 'src/conversion.ts'), sourceCitation('head', 'src/conversion.ts'),
      diffCitation('src/conversion.ts')];
    const original = classify({ citations, proof: proofFor({ citations, relation: 'introduced', baseContract: 'not-violated',
      causeAnchor: { startLine: 3, endLine: 5, contentDigest: '6'.repeat(64) } }) });
    const paraphrase = classify({ citations, findingFingerprint: FINDING_B,
      proof: proofFor({ citations, findingFingerprint: FINDING_B, relation: 'introduced', baseContract: 'not-violated',
        causeAnchor: { startLine: 3, endLine: 5, contentDigest: '6'.repeat(64) } }) });
    const secondOccurrence = classify({ citations, proof: proofFor({ citations, relation: 'introduced', baseContract: 'not-violated',
      causeAnchor: { startLine: 8, endLine: 10, contentDigest: '6'.repeat(64) } }) });
    expect(original.rootCauseEvidenceKey).toBe(paraphrase.rootCauseEvidenceKey);
    expect(original.rootCauseEvidenceKey).not.toBe(secondOccurrence.rootCauseEvidenceKey);
    expect(summarizeFindingChangeScopes([
      { findingId: 'same-cause-paraphrase', severity: 'P1', causalScope: original },
      { findingId: 'second-site-same-bytes', severity: 'P1', causalScope: secondOccurrence },
    ]).rootCauseGroups).toHaveLength(2);
  });

  it.each([
    ['mapped present-empty gap', presentEmptyHeadGapCitation],
    ['authenticated full-file absence', absentHeadCitation],
  ])('allows a deleted guard to use its exact base anchor with %s evidence', (_label, makeHeadEvidence) => {
    const path = 'src/request-guard.ts';
    const citations = [deletedBaseCitation(path), makeHeadEvidence(path), diffCitation(path)];
    const proof = proofFor({ citations, candidatePath: path, candidateSide: 'base', relation: 'introduced',
      baseContract: 'not-violated',
      causeAnchor: { side: 'base', componentPath: path, startLine: 3, endLine: 4, citationIds: [sourceId('base', path)] },
      baseCitationIds: [sourceId('base', path)], headCitationIds: [makeHeadEvidence(path).id],
      deltaCitationIds: [diffId(path)] });
    const result = classify({ citations, proof, candidatePath: path, candidateSide: 'base' });
    expect(result.causalScope).toBe('introduced');
    expect(summarizeFindingChangeScopes([{ findingId: 'deleted-request-guard', severity: 'P1', causalScope: result }])
      .blockingFindingIds).toEqual(['deleted-request-guard']);
  });

  it('rejects a base-side cause anchor for a non-deletion candidate', () => {
    const path = 'src/conversion.ts';
    const citations = [deletedBaseCitation(path), sourceCitation('head', path), diffCitation(path)];
    const proof = proofFor({ citations, candidatePath: path, candidateSide: 'head', relation: 'introduced',
      baseContract: 'not-violated', causeAnchor: { side: 'base', componentPath: path,
        citationIds: [sourceId('base', path)] } });
    expect(classify({ citations, proof, candidatePath: path, candidateSide: 'head' }).causalScope).toBe('unproven');
  });

  it('fails closed when the cause anchor is outside its cited source window or the cross-file edge is absent', () => {
    const contractEdge = dependencyEdge('src/handler.ts', 'src/routing-contract.ts');
    const citations = [sourceCitation('base', 'src/handler.ts'), sourceCitation('base', 'src/routing-contract.ts'),
      sourceCitation('head', 'src/handler.ts'), dependencyCitation('src/routing-contract.ts', 'src/handler.ts'),
      diffCitation('src/handler.ts')];
    const outsideWindow = proofFor({ citations, candidatePath: 'src/handler.ts', relation: 'introduced',
      baseContract: 'not-violated', rootCause: { contractId: contractEdge.contractId },
      causeAnchor: { componentPath: 'src/routing-contract.ts', startLine: 13, endLine: 14,
        citationIds: [sourceId('head', 'src/routing-contract.ts')] },
      causalPath: { relation: 'dependency-edge', citationIds: [sourceId('head', 'src/handler.ts'),
        sourceId('head', 'src/routing-contract.ts'), diffId('src/handler.ts')] },
      baseCitationIds: [sourceId('base', 'src/handler.ts'), sourceId('base', 'src/routing-contract.ts')],
      headCitationIds: [sourceId('head', 'src/handler.ts'), sourceId('head', 'src/routing-contract.ts')],
      deltaCitationIds: [diffId('src/handler.ts')] });
    expect(classify({ citations, proof: outsideWindow, candidatePath: 'src/handler.ts' }).causalScope).toBe('unproven');
    const noEdge: FindingChangeScopeProofV1 = { ...outsideWindow,
      causeAnchor: { ...outsideWindow.causeAnchor, startLine: 3, endLine: 4 },
      causalPath: { relation: 'unknown' as const, citationIds: [sourceId('head', 'src/handler.ts'), diffId('src/handler.ts')] } };
    noEdge.independentVerifier = { ...noEdge.independentVerifier, evidenceDigest: findingChangeScopeProofDigest(noEdge) };
    expect(classify({ citations, proof: noEdge, candidatePath: 'src/handler.ts' }).causalScope).toBe('unproven');
  });
});
