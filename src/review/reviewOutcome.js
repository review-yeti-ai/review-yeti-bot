'use strict';

const { validateLaneExecutionReceipt } = require('./evidenceContracts');

const COMPLETE_TERMINATIONS = new Set(['completed', 'reused']);

function deriveReceiptOutcome({ arbitration = {}, unitManifest, laneReceipts = [], findingVerification, headCurrent = true } = {}) {
  const rows = Array.isArray(laneReceipts) ? laneReceipts : [];
  const validations = rows.map((receipt) => validateLaneExecutionReceipt(receipt));
  const terminationReasons = [...new Set(rows.map((receipt) => String(receipt?.termination || 'invalid_receipt')))].sort();
  const invalid = rows.length === 0 || validations.some((row) => !row.valid);
  const completedCount = rows.filter((receipt) => COMPLETE_TERMINATIONS.has(receipt?.termination)).length;
  const incomplete = invalid
    || headCurrent !== true
    || unitManifest?.coverage?.complete !== true
    || findingVerification?.summary?.incomplete === true
    || rows.some((receipt) => !COMPLETE_TERMINATIONS.has(receipt?.termination));

  if (!incomplete) {
    const ship = arbitration.verdict === 'SHIP';
    return {
      ...arbitration,
      status: arbitration.verdict || arbitration.status || 'BLOCK',
      coverageComplete: true,
      coverageStatus: 'complete',
      gateDecision: ship ? 'PASS' : 'BLOCKED',
      mergeEligible: ship,
      promotionReady: ship,
      executionTerminationReasons: [],
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
    gateDecision: 'BLOCKED',
    mergeEligible: false,
    promotionReady: false,
    executionTerminationReasons: terminationReasons,
    rationale: `${arbitration.rationale || 'Review did not complete.'} Evidence execution was not complete; merge approval remains blocked.`,
  };
}

module.exports = { deriveReceiptOutcome };
