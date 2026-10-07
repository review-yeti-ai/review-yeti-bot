import { describe, expect, it } from 'vitest';
import { groundedFindingContinuityDigest, resolveGroundedFindingContinuity, continuityReceiptMatchesCurrent,
  groundedContinuityCandidateFrom, groundedContinuityOriginRefs, groundedOriginAncestryFromComparison,
  groundedFindingContinuitySchema, selectNewestEligibleGroundedCompletion, verifiedRepairVerificationLinks,
  type GroundedContinuityCandidate, type GroundedOriginAncestryV1 }
  from '../../src/review/findingContinuity';
import { canonicalJson, sha256 } from '../../src/review/reviewCore';
import { GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION } from '../../src/review/groundedEvidenceV2';
import type { PrLifecycleHistoryLoad } from '../../src/review/prLifecycleHistoryHttp';
import { buildReviewPlanningHistoryContext, type ReviewPlanningHistoryContext } from '../../src/review/prReviewPlanningContext';

const head = 'a'.repeat(40), base = 'b'.repeat(40), contextDigest = 'c'.repeat(64);
const semantics = GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION;
const findingId = `lf1_${'e'.repeat(32)}`;
const rootCause = { componentId: 'auth-boundary', behaviorId: 'validate-session', contractId: 'session-required',
  failureModeId: 'missing-session-check' };

function candidate(overrides: Partial<GroundedContinuityCandidate> = {}): GroundedContinuityCandidate {
  return { currentFingerprint: `fp1_${'1'.repeat(24)}`, candidateSide: 'head', rootCause,
    causeAnchor: { componentPath: 'src/auth/guard.ts', side: 'head', startLine: 22, endLine: 25,
      citationIds: ['head:src/auth/guard.ts:22-25'], contentDigest: 'd'.repeat(64) },
    causalPath: { relation: 'same-component', candidatePath: 'src/auth/guard.ts',
      componentPath: 'src/auth/guard.ts', citationIds: ['head:src/auth/guard.ts'] },
    sourceWindowManifestDigest: 'f'.repeat(64), currentOutcomeEvidenceDigest: '8'.repeat(64), ...overrides };
}

function history(options: { matches?: Array<{ durableFindingId: string; eventId: string; rootCause?: typeof rootCause;
  causeAnchor?: GroundedContinuityCandidate['causeAnchor'] }>; fixed?: boolean } = {}): {
  history: PrLifecycleHistoryLoad; planningHistory: ReviewPlanningHistoryContext;
} {
  const matches = options.matches ?? [{ durableFindingId: findingId, eventId: '00000000-0000-4000-8000-000000000001',
    rootCause, causeAnchor: { componentPath: 'src/auth/guard.ts', side: 'head' as const,
      startLine: 21, endLine: 23, citationIds: ['head:src/auth/guard.ts:21-23'], contentDigest: '9'.repeat(64) } }];
  const rows = matches.map((match, index) => ({
    findingEventId: match.eventId, durableFindingId: match.durableFindingId,
    fingerprint: `fp1_${String(index + 2).repeat(24)}`, path: match.causeAnchor?.componentPath ?? 'src/auth/guard.ts',
    firstSeenHead: base, lastSeenHead: base, affectedContextDigest: '8'.repeat(64), sourceSeverity: 'P1',
    effectiveSeverity: 'P1', disposition: 'carried', blocking: true, verificationStatus: 'confirmed' as const,
    evidenceDigest: contextDigest, groundedEvidenceSemanticsVersion: semantics,
    ...(match.rootCause ? { rootCause: match.rootCause } : {}), ...(match.causeAnchor ? { causeAnchor: match.causeAnchor } : {}),
    sourceWindowManifestDigest: '7'.repeat(64),
  }));
  const sourceRunId = `run_${'1'.repeat(32)}`;
  const runId = options.fixed ? `run_${'2'.repeat(32)}` : sourceRunId;
  const negativeFindingEventId = '00000000-0000-4000-8000-000000000006';
  const fixedDisposition = options.fixed ? [{ eventId: '00000000-0000-4000-8000-000000000003',
    eventType: 'finding.disposition.fixed', runId, executionAttempt: 1, headSha: head, baseSha: '9'.repeat(40),
    policyDigest: contextDigest, configDigest: contextDigest, contextDigest,
    verificationStatus: 'contradicted' as const,
    disposition: { version: 'PrFindingDisposition.v1' as const, kind: 'fixed' as const, findingId,
      fingerprint: rows[0]?.fingerprint ?? `fp1_${'2'.repeat(24)}`, path: rows[0]?.path ?? 'src/auth/guard.ts', runId,
      executionAttempt: 1, headSha: head, baseSha: '9'.repeat(40), policyDigest: contextDigest,
      configDigest: contextDigest, contextDigest, affectedContextDigest: contextDigest, evidenceDigest: contextDigest,
      provenance: { actorType: 'service' as const, actorDigest: contextDigest, source: 'grounded_verifier' as const,
        receiptDigest: contextDigest }, adjudication: { method: 'independent_grounded_verifier' as const,
        status: 'contradicted' as const, proofDigest: contextDigest,
        priorFindingEventId: rows[0]?.findingEventId ?? '00000000-0000-4000-8000-000000000004',
        changedContextDigest: contextDigest } } }] : [];
  const negativeFinding = options.fixed && rows[0] ? [{ findingEventId: negativeFindingEventId,
    durableFindingId: rows[0].durableFindingId, fingerprint: rows[0].fingerprint, path: rows[0].path,
    firstSeenHead: base, lastSeenHead: head, affectedContextDigest: contextDigest,
    sourceSeverity: 'P1', effectiveSeverity: 'P1', disposition: 'carried', blocking: true,
    verificationStatus: 'contradicted' as const, evidenceDigest: contextDigest }] : [];
  const repairVerification = options.fixed && rows[0] ? [{ eventId: '00000000-0000-4000-8000-000000000007',
    eventType: 'finding.independent_verification', runId, executionAttempt: 1, headSha: head,
    contextDigest, evidenceDigest: contextDigest, verificationStatus: 'contradicted' as const,
    verification: { findingEventId: negativeFindingEventId, fingerprint: rows[0].fingerprint, status: 'contradicted' as const } }] : [];
  const causeVerificationEvents = rows.map((row, index) => ({ eventId: `00000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`,
    eventType: 'finding.independent_verification', runId: sourceRunId, executionAttempt: 1, headSha: base,
    contextDigest: row.affectedContextDigest, evidenceDigest: contextDigest, verificationStatus: row.verificationStatus,
    verification: { findingEventId: row.findingEventId, fingerprint: row.fingerprint, status: row.verificationStatus } }));
  const sourceCompletion = { eventId: '00000000-0000-4000-8000-000000000008', eventType: 'review.completion_recorded',
    runId: sourceRunId, executionAttempt: 1, headSha: base, baseSha: '9'.repeat(40),
    policyDigest: contextDigest, configDigest: contextDigest, contextDigest,
    evidenceSemanticsVersion: semantics, completionStatus: 'failed' as const,
    coverageComplete: true, quorumSatisfied: true, verificationStatus: 'insufficient' as const };
  const completion = options.fixed ? { ...sourceCompletion, eventId: '00000000-0000-4000-8000-000000000005',
    runId, headSha: head } : sourceCompletion;
  const repairEventPayload = fixedDisposition[0]?.disposition;
  const fixedEvent = repairEventPayload ? [{ ...fixedDisposition[0]!,
    evidenceDigest: sha256(canonicalJson(repairEventPayload)) }] : [];
  const serviceHistory: PrLifecycleHistoryLoad = {
    status: 'complete', snapshotId: '00000000-0000-4000-8000-000000000020', contextDigest,
    events: [...fixedEvent, ...repairVerification, completion,
      ...(options.fixed ? [...causeVerificationEvents, sourceCompletion] : causeVerificationEvents)],
    findings: [...rows, ...negativeFinding], eventCount: 1 + fixedEvent.length + repairVerification.length + causeVerificationEvents.length,
    findingCount: rows.length + negativeFinding.length, loadedEventCount: 1 + fixedEvent.length + repairVerification.length
      + causeVerificationEvents.length, loadedFindingCount: rows.length + negativeFinding.length,
    eventOmittedCount: 0, findingOmittedCount: 0, legacyOmittedCount: 0,
    eventsDigest: contextDigest, findingsDigest: contextDigest, omissions: [],
  };
  const planningHistory: ReviewPlanningHistoryContext = {
    version: 'ReviewPlanningHistoryContext.v1', status: 'complete', snapshotId: serviceHistory.snapshotId,
    contextDigest, expectedHeadSha: head, expectedBaseSha: base,
    evidenceSemanticsCompatibility: { expectedVersion: semantics, sourceVersion: semantics,
      compatibleForContinuity: true, compatibleForCheckpointReuse: true, compatibleForCoverageReuse: true,
      completionCoverageComplete: true, completionQuorumSatisfied: true, sourcePolicyConfigCompatible: true,
      completionStatus: 'completed', reason: 'matching grounded evidence semantics' },
    priorFindings: rows, dispositions: fixedEvent.flatMap((event) => event.disposition ? [event.disposition] : []),
    authenticatedDisputes: { status: 'complete', count: 0, paths: [] },
    priorThreads: [], omissions: [], canWaiveCurrentBlocker: false,
  };
  return { history: serviceHistory, planningHistory };
}

function originProofs(input: { candidate: GroundedContinuityCandidate; history: PrLifecycleHistoryLoad;
  planningHistory: ReviewPlanningHistoryContext; continuityFindings?: PrLifecycleHistoryLoad['findings'];
  results?: readonly GroundedOriginAncestryV1['result'][] }): GroundedOriginAncestryV1[] {
  const refs = groundedContinuityOriginRefs({ candidate: input.candidate, history: input.history,
    currentHeadSha: input.planningHistory.expectedHeadSha, continuityFindings: input.continuityFindings });
  return (refs ?? []).map((ref, index) => groundedOriginAncestryFromComparison(ref,
    input.results?.[index] === 'not-ancestor' ? { status: 'diverged', files: [] } : { status: 'ahead', files: [] }));
}

function resolveWithOriginProofs(input: Parameters<typeof resolveGroundedFindingContinuity>[0]) {
  const verifiedOriginAncestry = input.verifiedOriginAncestry ?? originProofs({ candidate: input.candidate,
    history: input.history, planningHistory: input.planningHistory, continuityFindings: input.continuityFindings });
  return resolveGroundedFindingContinuity({ ...input, verifiedOriginAncestry });
}

describe('verified durable finding continuity', () => {
  it('keeps a stable ID across paraphrase and line/context shifts without comparing per-review keys', () => {
    const fixture = history();
    const current = candidate({ currentFingerprint: `fp1_${'a'.repeat(24)}`, causeAnchor: {
      componentPath: 'src/auth/guard.ts', side: 'head', startLine: 99, endLine: 103,
      citationIds: ['head:src/auth/guard.ts:99-103'], contentDigest: '5'.repeat(64),
    } });
    const receipt = resolveWithOriginProofs({ candidate: current, ...fixture,
      priorAncestryVerified: true });

    expect(receipt).toMatchObject({ status: 'continuous', durableFindingId: findingId,
      currentFingerprint: current.currentFingerprint, sourceEventIds: [fixture.history.findings[0]!.findingEventId] });
    expect(receipt.causeAnchor.citationIds).toEqual(['head:src/auth/guard.ts:99-103']);
    expect(continuityReceiptMatchesCurrent({ receipt, candidate: current, history: fixture.history })).toBe(true);
    expect(receipt).not.toHaveProperty('rootCauseEvidenceKey');
    const { evidenceDigest, ...unsigned } = receipt;
    expect(evidenceDigest).toBe(groundedFindingContinuityDigest(unsigned));
  });

  it('does not let a generic latest-review ancestry boolean authorize a matched cause', () => {
    const fixture = history();
    const receipt = resolveGroundedFindingContinuity({ candidate: candidate(), ...fixture, priorAncestryVerified: true });

    expect(receipt).toMatchObject({ status: 'unavailable', unavailableReason: 'stale-context', sourceEventIds: [] });
    expect(receipt).not.toHaveProperty('durableFindingId');
  });

  it('selects the newest eligible completion from the newest-first snapshot and does not fall back past an ineligible latest row', () => {
    const fixture = history();
    const older = fixture.history.events.find((event) => event.eventType === 'review.completion_recorded')!;
    const newest = { ...older, eventId: '00000000-0000-4000-8000-000000000099',
      runId: `run_${'9'.repeat(32)}`, headSha: head };

    expect(selectNewestEligibleGroundedCompletion([newest, older])).toEqual(newest);
    expect(selectNewestEligibleGroundedCompletion([{ ...newest, coverageComplete: false }, older])).toBeUndefined();
    expect(selectNewestEligibleGroundedCompletion([{ ...newest, evidenceSemanticsVersion: 'GroundedReviewReceipt.v1' }, older]))
      .toBeUndefined();
  });

  it('rejects a cause origin on a force-pushed-away head even when the latest review head is an ancestor', () => {
    const fixture = history();
    const current = candidate();
    const proofs = originProofs({ candidate: current, history: fixture.history, planningHistory: fixture.planningHistory,
      continuityFindings: fixture.history.findings, results: ['not-ancestor'] });
    const receipt = resolveGroundedFindingContinuity({ candidate: current, ...fixture,
      continuityFindings: fixture.history.findings, priorAncestryVerified: true, verifiedOriginAncestry: proofs });

    expect(receipt).toMatchObject({ status: 'unavailable', unavailableReason: 'stale-context', sourceEventIds: [] });
    expect(receipt).not.toHaveProperty('durableFindingId');
  });

  it('rejects a dropped repair origin even when the cause and generic latest head are ancestors', () => {
    const fixture = history({ fixed: true });
    const current = candidate();
    const planningHistory = { ...fixture.planningHistory, expectedHeadSha: 'd'.repeat(40) };
    const proofs = originProofs({ candidate: current, history: fixture.history, planningHistory,
      continuityFindings: fixture.history.findings, results: ['ancestor', 'not-ancestor'] });
    const receipt = resolveGroundedFindingContinuity({ candidate: current, history: fixture.history, planningHistory,
      continuityFindings: fixture.history.findings, priorAncestryVerified: true, verifiedOriginAncestry: proofs });

    expect(receipt).toMatchObject({ status: 'unavailable', unavailableReason: 'stale-context', sourceEventIds: [] });
    expect(receipt).not.toHaveProperty('durableFindingId');
  });

  it('parses the validated v2 cause record while keeping its per-review key outside durable identity', () => {
    const raw = { fingerprint: `fp1_${'1'.repeat(24)}`, ...candidate(),
      evidenceDigest: candidate().currentOutcomeEvidenceDigest, rootCauseEvidenceKey: 'current-window-location-key' };
    const parsed = groundedContinuityCandidateFrom(raw);

    expect(parsed).toMatchObject({ currentFingerprint: `fp1_${'1'.repeat(24)}`, rootCause, causeAnchor: candidate().causeAnchor });
    expect(parsed).not.toHaveProperty('rootCauseEvidenceKey');
  });

  it('requires strict continuity receipts with citation-bound anchors and status-specific identity fields', () => {
    const current = candidate();
    const { history: prior, planningHistory } = history();
    const valid = resolveWithOriginProofs({ candidate: current, history: prior, planningHistory,
      priorAncestryVerified: true });
    expect(groundedFindingContinuitySchema.safeParse(valid).success).toBe(true);
    expect(groundedFindingContinuitySchema.safeParse({ ...valid, causeAnchor: {
      ...valid.causeAnchor, citationIds: [],
    } }).success).toBe(false);
    expect(groundedFindingContinuitySchema.safeParse({ ...valid, status: 'new', sourceEventIds: [] }).success).toBe(false);
  });

  it('resolves an unchanged P2 dependency contract from full history when planner display prunes it', () => {
    const fixture = history();
    const sharedSource = { ...fixture.history.findings[0]!, path: 'src/lib/shared.ts', sourceSeverity: 'P2', effectiveSeverity: 'P2' };
    const fullHistory = { ...fixture.history, findings: [sharedSource], findingCount: 1, loadedFindingCount: 1 };
    const planningHistory = buildReviewPlanningHistoryContext({ history: fullHistory,
      threadSnapshot: { source: 'service', headSha: head, complete: true, omittedCount: 0, threads: [] },
      expectedHeadSha: head, expectedBaseSha: base, changedPaths: ['src/caller.ts'] });
    expect(planningHistory.priorFindings).toHaveLength(0);
    const current = candidate({ causeAnchor: { ...candidate().causeAnchor, componentPath: 'src/lib/shared.ts' },
      causalPath: { relation: 'contract-edge', candidatePath: 'src/caller.ts', componentPath: 'src/lib/shared.ts',
        citationIds: ['caller-contract-edge'] } });
    const receipt = resolveWithOriginProofs({ candidate: current, history: fullHistory, planningHistory,
      continuityFindings: fullHistory.findings, priorAncestryVerified: true });
    expect(receipt).toMatchObject({ status: 'continuous', durableFindingId: findingId,
      sourceEventIds: [sharedSource.findingEventId] });
  });

  it('uses the exact cause row referenced by the trusted repair after planner dedupe', () => {
    const firstEventId = '00000000-0000-4000-8000-000000000031';
    const secondEventId = '00000000-0000-4000-8000-000000000032';
    const fixture = history({ fixed: true, matches: [
      { durableFindingId: findingId, eventId: firstEventId, rootCause,
        causeAnchor: { componentPath: 'src/auth/guard.ts', side: 'head', startLine: 20, endLine: 22,
          citationIds: ['prior:first'], contentDigest: '1'.repeat(64) } },
      { durableFindingId: findingId, eventId: secondEventId, rootCause,
        causeAnchor: { componentPath: 'src/auth/guard.ts', side: 'head', startLine: 24, endLine: 26,
          citationIds: ['prior:second'], contentDigest: '2'.repeat(64) } },
    ] });
    const prunedPlanning = { ...fixture.planningHistory, priorFindings: [fixture.planningHistory.priorFindings[1]!] };
    const receipt = resolveWithOriginProofs({ candidate: candidate(), history: fixture.history,
      planningHistory: prunedPlanning, continuityFindings: fixture.history.findings, priorAncestryVerified: true });
    expect(receipt.status).toBe('reopened');
    expect(receipt.sourceEventIds).toEqual([firstEventId, '00000000-0000-4000-8000-000000000003'].sort());
  });

  it('includes a fixed contradicted finding only through its current-v2 completion and service verification link', () => {
    const fixture = history();
    const priorCause = fixture.history.findings[0]!;
    const runId = `run_${'4'.repeat(32)}`;
    const currentContextDigest = '6'.repeat(64);
    const fixedEventId = '00000000-0000-4000-8000-000000000051';
    const completionEventId = '00000000-0000-4000-8000-000000000052';
    const contradictedFindingEventId = '00000000-0000-4000-8000-000000000053';
    const verificationEventId = '00000000-0000-4000-8000-000000000054';
    const fixedDisposition = {
      version: 'PrFindingDisposition.v1' as const, kind: 'fixed' as const, findingId,
      fingerprint: priorCause.fingerprint, path: priorCause.path, runId, executionAttempt: 2,
      headSha: head, baseSha: base, policyDigest: contextDigest, configDigest: contextDigest,
      contextDigest, affectedContextDigest: currentContextDigest, evidenceDigest: contextDigest,
      provenance: { actorType: 'service' as const, actorDigest: contextDigest,
        source: 'grounded_verifier' as const, receiptDigest: contextDigest },
      adjudication: { method: 'independent_grounded_verifier' as const, status: 'contradicted' as const,
        proofDigest: contextDigest, priorFindingEventId: priorCause.findingEventId,
        changedContextDigest: currentContextDigest },
    };
    const contradictedFinding = {
      findingEventId: contradictedFindingEventId, durableFindingId: findingId,
      fingerprint: priorCause.fingerprint, path: priorCause.path, firstSeenHead: base, lastSeenHead: head,
      affectedContextDigest: currentContextDigest, sourceSeverity: 'P1', effectiveSeverity: 'P1',
      disposition: 'carried', blocking: true, verificationStatus: 'contradicted' as const, evidenceDigest: contextDigest,
    };
    const completionEvent = { eventId: completionEventId, eventType: 'review.completion_recorded', runId,
      executionAttempt: 2, headSha: head, baseSha: base, policyDigest: contextDigest, configDigest: contextDigest,
      contextDigest, evidenceSemanticsVersion: semantics, completionStatus: 'failed' as const,
      coverageComplete: true, quorumSatisfied: true, verificationStatus: 'insufficient' as const };
    const fixedEvent = { eventId: fixedEventId, eventType: 'finding.disposition.fixed', runId, executionAttempt: 2,
      headSha: head, baseSha: base, policyDigest: contextDigest, configDigest: contextDigest, contextDigest,
      evidenceDigest: sha256(canonicalJson(fixedDisposition)), verificationStatus: 'contradicted' as const,
      disposition: fixedDisposition };
    const fixedWithUnknownPriorDisposition = { ...fixedDisposition, adjudication: {
      ...fixedDisposition.adjudication, priorFindingEventId: verificationEventId,
    } };
    const fixedWithUnknownPriorEvent = { ...fixedEvent, disposition: fixedWithUnknownPriorDisposition,
      evidenceDigest: sha256(canonicalJson(fixedWithUnknownPriorDisposition)) };
    const verificationEvent = { eventId: verificationEventId, eventType: 'finding.independent_verification', runId,
      executionAttempt: 2, headSha: head, contextDigest: currentContextDigest,
      evidenceDigest: fixedDisposition.adjudication.proofDigest, verificationStatus: 'contradicted' as const,
      verification: { findingEventId: contradictedFindingEventId, fingerprint: priorCause.fingerprint,
        status: 'contradicted' as const } };
    const detailedVerificationEvent = { ...verificationEvent, baseSha: base, policyDigest: contextDigest,
      configDigest: contextDigest, contextDigest, verification: { ...verificationEvent.verification,
        currentAffectedContextDigest: currentContextDigest, sourceAffectedContextDigest: priorCause.affectedContextDigest } };
    const priorOriginEvents = fixture.history.events.filter((event) => event.eventType === 'review.completion_recorded'
      || event.eventType === 'finding.independent_verification');
    const fixedHistory = { ...fixture.history, findings: [...fixture.history.findings, contradictedFinding],
      events: [fixedEvent, verificationEvent, completionEvent, ...priorOriginEvents],
      eventCount: 3 + priorOriginEvents.length, loadedEventCount: 3 + priorOriginEvents.length,
      findingCount: fixture.history.findings.length + 1, loadedFindingCount: fixture.history.findings.length + 1 };
    const fixedPlanningHistory = { ...fixture.planningHistory, dispositions: [fixedDisposition] };

    expect(contradictedFinding).not.toHaveProperty('rootCause');
    const validOriginProofs = originProofs({ candidate: candidate(), history: fixedHistory,
      planningHistory: fixedPlanningHistory, continuityFindings: fixedHistory.findings });
    const receipt = resolveGroundedFindingContinuity({ candidate: candidate(), history: fixedHistory,
      planningHistory: fixedPlanningHistory, continuityFindings: fixedHistory.findings,
      priorAncestryVerified: false, verifiedOriginAncestry: validOriginProofs });

    expect(receipt.status).toBe('reopened');
    expect(receipt.sourceEventIds).toEqual([priorCause.findingEventId, fixedEventId].sort());
    expect(receipt.verifiedOriginAncestry?.map(({ sourceKind }) => sourceKind)).toEqual(['cause', 'repair']);
    expect(verifiedRepairVerificationLinks(fixedHistory, findingId, rootCause)).toEqual([{
      causeFindingEventId: priorCause.findingEventId, repairEventId: fixedEventId,
      negativeFindingEventId: contradictedFindingEventId,
    }]);
    const detailedHistory = { ...fixedHistory, events: [fixedEvent, detailedVerificationEvent, completionEvent, ...priorOriginEvents] };
    const detailedProofs = originProofs({ candidate: candidate(), history: detailedHistory,
      planningHistory: fixedPlanningHistory, continuityFindings: detailedHistory.findings });
    const detailedReceipt = resolveGroundedFindingContinuity({ candidate: candidate(), history: detailedHistory,
      planningHistory: fixedPlanningHistory, continuityFindings: detailedHistory.findings,
      verifiedOriginAncestry: detailedProofs });
    expect(detailedReceipt.sourceEventIds).toEqual([priorCause.findingEventId, fixedEventId].sort());

    const invalidEventSets = [
      [completionEvent, fixedEvent],
      [{ ...completionEvent, evidenceSemanticsVersion: 'GroundedReviewReceipt.v1' }, fixedEvent, verificationEvent],
      [completionEvent, fixedEvent, { ...verificationEvent, runId: `run_${'5'.repeat(32)}` }],
      [completionEvent, fixedEvent, { ...verificationEvent, contextDigest: '7'.repeat(64) }],
      [completionEvent, fixedEvent, { ...verificationEvent, evidenceDigest: '7'.repeat(64) }],
      [completionEvent, fixedEvent, { ...verificationEvent, verification: {
        ...verificationEvent.verification, findingEventId: priorCause.findingEventId,
      } }],
      [completionEvent, fixedWithUnknownPriorEvent, verificationEvent],
      [completionEvent, fixedEvent, { ...verificationEvent, verification: {
        ...verificationEvent.verification, fingerprint: `fp1_${'9'.repeat(24)}`,
      } }],
      [completionEvent, fixedEvent, { ...verificationEvent, verification: {
        ...verificationEvent.verification, currentAffectedContextDigest: '7'.repeat(64),
      } }],
      [completionEvent, fixedEvent, { ...detailedVerificationEvent, verification: {
        ...detailedVerificationEvent.verification, sourceAffectedContextDigest: '7'.repeat(64),
      } }],
      [{ ...completionEvent, coverageComplete: false }, fixedEvent, verificationEvent],
      [{ ...completionEvent, quorumSatisfied: false }, fixedEvent, verificationEvent],
    ];
    for (const events of invalidEventSets) {
      const invalidHistory = { ...fixedHistory, events: [...events, ...priorOriginEvents] };
      const invalidReceipt = resolveGroundedFindingContinuity({ candidate: candidate(), history: invalidHistory,
        planningHistory: fixedPlanningHistory, continuityFindings: invalidHistory.findings,
        priorAncestryVerified: true, verifiedOriginAncestry: validOriginProofs });
      expect(invalidReceipt).toMatchObject({ status: 'unavailable', unavailableReason: 'stale-context', sourceEventIds: [] });
      expect(invalidReceipt).not.toHaveProperty('durableFindingId');
    }
  });

  it('uses only per-row current semantics when legacy and current rows share a root cause', () => {
    const fixture = history();
    const current = fixture.history.findings[0]!;
    const legacy = { ...current, findingEventId: '00000000-0000-4000-8000-000000000041',
      durableFindingId: `lf1_${'a'.repeat(32)}`, groundedEvidenceSemanticsVersion: 'GroundedReviewReceipt.v1' };
    const mixedHistory = { ...fixture.history, findings: [legacy, current], findingCount: 2, loadedFindingCount: 2 };
    const mixedPlanning = { ...fixture.planningHistory, priorFindings: [legacy, current] };

    const receipt = resolveWithOriginProofs({ candidate: candidate(), history: mixedHistory,
      planningHistory: mixedPlanning, continuityFindings: mixedHistory.findings, priorAncestryVerified: true });

    expect(receipt).toMatchObject({ status: 'continuous', durableFindingId: findingId,
      sourceEventIds: [current.findingEventId] });
    expect(receipt.sourceEventIds).not.toContain(legacy.findingEventId);
  });

  it('does not make a legacy cause row continuity authority after a current-v2 completion', () => {
    const fixture = history();
    const current = fixture.history.findings[0]!;
    const legacy = { ...current, findingEventId: '00000000-0000-4000-8000-000000000042',
      groundedEvidenceSemanticsVersion: 'GroundedReviewReceipt.v1' };
    const legacyOnlyHistory = { ...fixture.history, findings: [legacy], findingCount: 1, loadedFindingCount: 1 };
    const legacyPlanning = { ...fixture.planningHistory, priorFindings: [legacy] };

    const receipt = resolveGroundedFindingContinuity({ candidate: candidate(), history: legacyOnlyHistory,
      planningHistory: legacyPlanning, continuityFindings: legacyOnlyHistory.findings, priorAncestryVerified: true });

    expect(receipt).toMatchObject({ status: 'new', sourceEventIds: [] });
    expect(receipt).not.toHaveProperty('durableFindingId');
  });

  it('keeps a second distinct site with the same root cause ambiguous instead of merging IDs', () => {
    const fixture = history({ matches: [
      { durableFindingId: findingId, eventId: '00000000-0000-4000-8000-000000000011', rootCause,
        causeAnchor: { componentPath: 'src/auth/guard.ts', side: 'head', startLine: 10, endLine: 12,
          citationIds: ['head:src/auth/guard.ts:10-12'], contentDigest: '1'.repeat(64) } },
      { durableFindingId: `lf1_${'a'.repeat(32)}`, eventId: '00000000-0000-4000-8000-000000000012', rootCause,
        causeAnchor: { componentPath: 'src/auth/guard.ts', side: 'head', startLine: 80, endLine: 82,
          citationIds: ['head:src/auth/guard.ts:80-82'], contentDigest: '2'.repeat(64) } },
    ] });
    const receipt = resolveWithOriginProofs({ candidate: candidate(), ...fixture,
      priorAncestryVerified: true });

    expect(receipt).toMatchObject({ status: 'unavailable', unavailableReason: 'ambiguous-match', sourceEventIds: [] });
    expect(receipt).not.toHaveProperty('durableFindingId');
  });

  it('does not map two current source occurrences onto one historical durable ID', () => {
    const fixture = history();
    const current = candidate();
    const second = candidate({ causeAnchor: { ...current.causeAnchor, startLine: 80, endLine: 83 } });
    const receipt = resolveWithOriginProofs({ candidate: current, currentCandidates: [current, second], ...fixture,
      priorAncestryVerified: true });

    expect(receipt).toMatchObject({ status: 'unavailable', unavailableReason: 'ambiguous-match', sourceEventIds: [] });
    expect(receipt).not.toHaveProperty('durableFindingId');
  });

  it('treats a current new P1 after an unrelated resolved advisory as a new cause with no inherited ID', () => {
    const fixture = history({ matches: [{ durableFindingId: findingId,
      eventId: '00000000-0000-4000-8000-000000000021',
      rootCause: { ...rootCause, failureModeId: 'old-style-advisory' },
      causeAnchor: { componentPath: 'src/auth/guard.ts', side: 'head', startLine: 1, endLine: 2,
        citationIds: ['head:src/auth/guard.ts:1-2'], contentDigest: '6'.repeat(64) } }] });
    const current = candidate({ rootCause: { ...rootCause, failureModeId: 'new-auth-bypass' } });
    const receipt = resolveGroundedFindingContinuity({ candidate: current, ...fixture,
      priorAncestryVerified: true });

    expect(receipt).toMatchObject({ status: 'new', sourceEventIds: [], currentFingerprint: current.currentFingerprint });
    expect(receipt).not.toHaveProperty('durableFindingId');
  });

  it('does not reuse a legacy source-complete record without the new evidence semantics version', () => {
    const fixture = history();
    const legacy = { ...fixture.planningHistory, evidenceSemanticsCompatibility: { expectedVersion: semantics,
      sourceVersion: 'GroundedReviewReceipt.v1', compatibleForContinuity: false, compatibleForCheckpointReuse: false,
      compatibleForCoverageReuse: false, completionCoverageComplete: false, completionQuorumSatisfied: false,
      sourcePolicyConfigCompatible: false, reason: 'prior completion uses incompatible grounded evidence semantics' } };
    const receipt = resolveGroundedFindingContinuity({ candidate: candidate(), history: fixture.history,
      planningHistory: legacy, priorAncestryVerified: true });

    expect(receipt).toMatchObject({ status: 'unavailable', unavailableReason: 'stale-context', sourceEventIds: [] });
    expect(receipt).not.toHaveProperty('durableFindingId');
  });

  it('assigns a new candidate context after a legacy snapshot when no prior cause ID exists', () => {
    const fixture = history({ matches: [] });
    const legacy = { ...fixture.planningHistory, evidenceSemanticsCompatibility: { expectedVersion: semantics,
      sourceVersion: 'GroundedReviewReceipt.v1', compatibleForContinuity: false, compatibleForCheckpointReuse: false,
      compatibleForCoverageReuse: false, completionCoverageComplete: false, completionQuorumSatisfied: false,
      sourcePolicyConfigCompatible: false, reason: 'prior completion uses incompatible grounded evidence semantics' } };
    const receipt = resolveGroundedFindingContinuity({ candidate: candidate(), history: fixture.history,
      planningHistory: legacy, priorAncestryVerified: false });

    expect(receipt).toMatchObject({ status: 'new', currentFingerprint: candidate().currentFingerprint, sourceEventIds: [] });
    expect(receipt).not.toHaveProperty('durableFindingId');
  });

  it('marks a verified defect after a fixed disposition as reopened without manufacturing approval', () => {
    const fixture = history({ fixed: true });
    const receipt = resolveWithOriginProofs({ candidate: candidate(), ...fixture,
      priorAncestryVerified: true });

    expect(receipt).toMatchObject({ status: 'reopened', durableFindingId: findingId });
    expect(receipt.sourceEventIds).toEqual([fixture.history.findings[0]!.findingEventId,
      '00000000-0000-4000-8000-000000000003'].sort());
  });
});
