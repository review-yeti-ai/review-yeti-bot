'use strict';

const { validateLaneExecutionReceipt } = require('./evidenceContracts');

const COMPLETE_TERMINATIONS = new Set(['completed', 'reused']);

function deriveReceiptOutcome({
  arbitration = {},
  unitManifest,
  laneReceipts = [],
  findingVerification,
  headCurrent = true,
  evidenceEnabled = true,
} = {}) {
  const rows = Array.isArray(laneReceipts) ? laneReceipts : [];
  const validations = rows.map((receipt) => validateLaneExecutionReceipt(receipt));
  const terminationReasons = [...new Set(rows.map((receipt) => String(receipt?.termination || 'invalid_receipt')))].sort();

  // Evidence/navigation tooling can be deliberately unavailable for an entire review -- e.g. a
  // monorepo whose file count exceeds the bounded-navigation-snapshot cap (see
  // reviewNavigationTools.js normalizeSnapshot / reviewNavigationSnapshot.js MAX_FILES). That is
  // a known, expected degradation the pipeline fails soft into (PR #37): personas still ran and
  // reached a real verdict, they just never had bounded evidence tools to call. An *empty*
  // receipt list only signals a genuine lane-execution failure when evidence tooling was
  // actually expected to run -- do not delete this check, only scope it. This is purely about
  // whether personas *ran*; it has no bearing on findings (see below).
  const receiptsMissing = rows.length === 0 && evidenceEnabled !== false;
  const receiptsInvalid = rows.length > 0 && validations.some((row) => !row.valid);
  const someReceiptIncomplete = rows.length > 0 && rows.some((receipt) => !COMPLETE_TERMINATIONS.has(receipt?.termination));
  const invalid = receiptsMissing || receiptsInvalid || someReceiptIncomplete;

  // `findingVerification.summary.incomplete` is trusted unconditionally here -- it must NOT be
  // gated by evidenceEnabled. It is tempting to reason "with evidence tooling off, personas can't
  // produce a grounded finding, so this signal can only be vacuous" -- that reasoning is false.
  // reviewInvestigation.js's candidateFindings *retains* a finding reported without evidence
  // receipts when evidence tooling was globally disabled (marked `unverified: true`), specifically
  // so it is not silently dropped and mislabeled APPROVE. That retained finding still needs
  // independent verification (findingVerifier.js, an exact-blob check unrelated to bounded
  // navigation tooling), and `incomplete` can genuinely be true here for reasons that have nothing
  // to do with bounded-navigation availability (e.g. the exact-blob fetch itself failed). Bypassing
  // this check based on evidenceEnabled would let an unverifiable real finding through as SHIP --
  // precisely the false-SHIP class this repo's gate exists to prevent (see the 2026-08-11
  // cisco-cdr incident writeup: an earlier version of this function did exactly that).
  // review-pipeline.js's navigationCompletenessMatters() already scopes the navigation-truncation
  // contribution to this flag correctly at the source, so no further scoping belongs here.
  const verificationIncomplete = findingVerification?.summary?.incomplete === true;

  const completedCount = rows.filter((receipt) => COMPLETE_TERMINATIONS.has(receipt?.termination)).length;
  const incomplete = invalid
    || headCurrent !== true
    || unitManifest?.coverage?.complete !== true
    || verificationIncomplete;

  if (!incomplete) {
    const ship = arbitration.verdict === 'SHIP';
    const degraded = evidenceEnabled === false;
    return {
      ...arbitration,
      status: arbitration.verdict || arbitration.status || 'BLOCK',
      coverageComplete: !degraded,
      coverageStatus: degraded ? 'degraded-tooling' : 'complete',
      evidenceEnabled: evidenceEnabled !== false,
      gateDecision: ship ? 'PASS' : 'BLOCKED',
      mergeEligible: ship,
      promotionReady: ship,
      executionTerminationReasons: [],
      ...(degraded ? {
        rationale: `${arbitration.rationale || ''} Evidence/navigation tooling was unavailable for this review (e.g. a monorepo over the bounded-navigation-snapshot cap); this verdict reflects persona arbitration without bounded evidence tool coverage.`.trim(),
      } : {}),
    };
  }

  const partial = completedCount > 0;
  return {
    ...arbitration,
    verdict: 'BLOCK',
    status: partial ? 'PARTIAL_REVIEW' : 'INCOMPLETE_REVIEW',
    coverageComplete: false,
    coverageStatus: partial ? 'partial' : 'incomplete',
    coverageQuorumSatisfied: false,
    evidenceEnabled: evidenceEnabled !== false,
    gateDecision: 'BLOCKED',
    mergeEligible: false,
    promotionReady: false,
    executionTerminationReasons: terminationReasons,
    rationale: `${arbitration.rationale || 'Review did not complete.'} Evidence execution was not complete; merge approval remains blocked.`,
  };
}

module.exports = { deriveReceiptOutcome };
