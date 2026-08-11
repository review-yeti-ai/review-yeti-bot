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
  // actually expected to run -- do not delete this check, only scope it.
  const receiptsMissing = rows.length === 0 && evidenceEnabled !== false;
  const receiptsInvalid = rows.length > 0 && validations.some((row) => !row.valid);
  const someReceiptIncomplete = rows.length > 0 && rows.some((receipt) => !COMPLETE_TERMINATIONS.has(receipt?.termination));
  const invalid = receiptsMissing || receiptsInvalid || someReceiptIncomplete;

  // The finding verifier can only be "incomplete" about findings it never had evidence tooling
  // to check against the exact immutable snapshot. With evidence tooling unavailable, personas
  // structurally cannot produce a finding carrying valid evidence-receipt ids (see
  // reviewInvestigation.js candidateFindings / review-pipeline.js's evidence-ownership filter),
  // so a run that reaches here with evidence disabled can only mean "every persona approved
  // with nothing to point at" -- there was nothing left for the verifier to establish. Letting
  // that signal force BLOCK regardless is exactly the false-BLOCK bug this fixes; it is not a
  // false-SHIP risk because a persona-reported finding still flows through `arbitration` and
  // decides `ship` below unconditionally.
  const verificationIncomplete = evidenceEnabled !== false && findingVerification?.summary?.incomplete === true;

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
