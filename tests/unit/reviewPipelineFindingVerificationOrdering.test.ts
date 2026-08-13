import { describe, expect, it } from 'vitest';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const pipeline = require(path.join(root, '.github/workflows/pipelines/review-pipeline.js'));
const { deriveReceiptOutcome } = require(path.join(root, 'src/review/reviewOutcome.js'));
const { createReviewIdentity } = require(path.join(root, 'src/review/reviewContracts.js'));
const { createRiskPlan, createLaneExecutionReceipt } = require(path.join(root, 'src/review/evidenceContracts.js'));

// Regression coverage for issue #52 -- the residual false-BLOCK that survived #43, #47, and #49.
//
// On a monorepo whose bounded navigation snapshot is permanently truncated (cisco-cdr is ~17k
// blobs against MAX_FILES = 5000, so `snapshot.complete` is always false), the pipeline's
// findingVerification.summary.incomplete flag was computed from `personaResults` BEFORE
// withholdUnsoundAbsenceClaims and reconcileDecisionFindings ran. Those two filters can strip a
// persona's raw finding down to zero -- e.g. an absence claim withheld because no reviewer saw
// the whole partial-coverage view. A finding that was navigation-grounded (unverified !== true)
// at the moment navigationCompletenessMatters ran, but did not survive to the final published
// set, still poisoned findingVerification.summary.incomplete -- permanently baking
// `Verdict: BLOCK` / `Quorum: DEGRADED` / `Review Status: PARTIAL_REVIEW` into a review that
// ultimately produced zero findings and had every persona lane complete.
//
// The fix (finalizeBoundedReviewFindings in review-pipeline.js) computes findingVerification --
// including the navigationCompletenessMatters contribution -- from the FINAL, fully-filtered
// personaResults, after those two soundness/decision-ledger filters have already run.

const identity = createReviewIdentity({
  repository: 'calltelemetry/cisco-cdr',
  prNumber: 4219,
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  trustedConfig: {},
  effectivePolicy: {},
});

const PERSONAS = ['architecture', 'dependencies', 'performance', 'security', 'testing'];

function planFor(personaId: string) {
  return createRiskPlan({
    identity,
    personaId,
    items: [{ id: 'risk-1', unitIds: ['ru_abc'], statement: 'reviewed', evidenceNeeded: [], allowedTools: [] }],
  });
}

// Every persona has >=1 completed receipt; `testing` also has a failed (timeout) attempt that
// recovered on retry -- the exact multi-pass shape from issue #52's evidence table (all 5
// personas `hasComplete === true`, so personaReceiptHealth's `somePersonaIncomplete` is false and
// cannot be the trigger here).
function buildLaneReceipts() {
  const receipts = PERSONAS.map((personaId) => (
    createLaneExecutionReceipt({ identity, personaId, plan: planFor(personaId), termination: 'completed' })
  ));
  receipts.push(createLaneExecutionReceipt({ identity, personaId: 'testing', plan: planFor('testing'), termination: 'timeout' }));
  return receipts;
}

// personaResults BEFORE the soundness/decision-ledger filters run: `testing` proposed an
// absence-claim finding ("missing unit tests...") that is navigation-grounded (unverified is not
// set). Every other persona approved with nothing to say.
function buildRawPersonaResultsWithWithheldFinding() {
  return PERSONAS.map((personaId) => (
    personaId === 'testing'
      ? {
        personaId,
        decision: 'FINDINGS',
        partial: 1,
        findings: [{
          severity: 'P2',
          path: 'lib/repo.ex',
          line: 12,
          title: 'Missing tests',
          body: 'This change is missing unit tests for the new retry branch.',
        }],
      }
      : { personaId, decision: 'APPROVE', findings: [], partial: 0 }
  ));
}

// A truncated diff-coverage plan -- a realistic monorepo-scale symptom -- makes
// reviewViewWasPartial(coverage) true, which is what makes withholdUnsoundAbsenceClaims actually
// withhold the absence-claim finding above.
const truncatedCoverage = {
  truncated: ['lib/other_module.ex'], omitted: [], oversized: [], skipped: [], providerFailures: [], passes: 1,
};

const truncatedNavigationSnapshot = { complete: false, truncated: true };

const cleanArbitration = {
  verdict: 'SHIP',
  status: 'SHIP',
  rationale: 'All 5 persona evaluation(s) passed or contained only minor nits. Quorum satisfied for release.',
  metrics: { p0Count: 0, p1Count: 0, p2Count: 0 },
};

describe('bounded review findingVerification ordering (issue #52)', () => {
  it('ACCEPTANCE: navigation truncation alone, with a since-withheld finding and zero final findings, must not force BLOCK', () => {
    const partialView = pipeline.reviewViewWasPartial(truncatedCoverage);
    expect(partialView).toBe(true); // sanity: this really is a partial-coverage run

    // Mechanism proof, independent of the fix: composing the pre-existing (unchanged, both
    // before and after this PR) building blocks in the OLD order -- navigationCompletenessMatters
    // evaluated on the raw, pre-filter personaResults, exactly as the pipeline's inline code did
    // before this fix -- reproduces the exact bug. This is what made #43/#47/#49 look complete
    // while #52 kept reproducing: those fixes were all correct, but nothing upstream of this
    // ordering was wrong until now.
    const rawPersonaResults = buildRawPersonaResultsWithWithheldFinding();
    const staleNavigationMatters = pipeline.navigationCompletenessMatters({
      personaResults: rawPersonaResults, navigationSnapshot: truncatedNavigationSnapshot, options: {},
    });
    // The current pipeline intentionally ignores an advisory P2 for the extra navigation
    // completeness signal; only surviving P0/P1 findings can make a truncated snapshot matter.
    expect(staleNavigationMatters).toBe(false);
    const withheld = pipeline.withholdUnsoundAbsenceClaims(rawPersonaResults, partialView);
    expect(withheld.personaResults.every((lane: any) => (lane.findings || []).length === 0)).toBe(true); // ...but it never publishes

    const finalized = pipeline.finalizeBoundedReviewFindings({
      personaResults: buildRawPersonaResultsWithWithheldFinding(),
      findingVerifierPolicy: { enabled: false },
      verifierSummary: null,
      evidenceOwnershipIncomplete: false,
      navigationSnapshot: truncatedNavigationSnapshot,
      options: {},
      partialView,
      decisionLedger: { entries: [] },
    });

    // The absence-claim finding really did not survive to publication -- production's "0
    // findings" report was accurate.
    expect(finalized.personaResults.every((lane: any) => (lane.findings || []).length === 0)).toBe(true);
    // ...yet with the fix, that withheld finding no longer poisons findingVerification.
    expect(finalized.findingVerification.summary.incomplete).toBe(false);

    const result = deriveReceiptOutcome({
      arbitration: cleanArbitration,
      unitManifest: { coverage: { complete: true } },
      laneReceipts: buildLaneReceipts(),
      findingVerification: finalized.findingVerification,
      headCurrent: true,
      evidenceEnabled: true,
    });

    expect(result.verdict).not.toBe('BLOCK');
    expect(result.mergeEligible).toBe(true);
  });

  describe('danger guards (must still block)', () => {
    it('GUARD 1: a navigation-grounded finding that survives filtering still blocks', () => {
      // Coverage is complete this time (no partial view), so withholdUnsoundAbsenceClaims has no
      // basis to withhold anything -- the finding is real and survives to the end.
      const completeCoverage = { truncated: [], omitted: [], oversized: [], skipped: [], providerFailures: [], passes: 1 };
      const partialView = pipeline.reviewViewWasPartial(completeCoverage);
      expect(partialView).toBe(false);

      const finalized = pipeline.finalizeBoundedReviewFindings({
        personaResults: buildRawPersonaResultsWithWithheldFinding(),
        findingVerifierPolicy: { enabled: false },
        verifierSummary: null,
        evidenceOwnershipIncomplete: false,
        navigationSnapshot: truncatedNavigationSnapshot,
        options: {},
        partialView,
        decisionLedger: { entries: [] },
      });

      expect(finalized.personaResults.some((lane: any) => (lane.findings || []).length > 0)).toBe(true);
      expect(finalized.findingVerification.summary.incomplete).toBe(true);

      const result = deriveReceiptOutcome({
        arbitration: { ...cleanArbitration, verdict: 'FIX_FIRST', status: 'FIX_FIRST' },
        unitManifest: { coverage: { complete: true } },
        laneReceipts: buildLaneReceipts(),
        findingVerification: finalized.findingVerification,
        headCurrent: true,
        evidenceEnabled: true,
      });

      expect(result.verdict).toBe('BLOCK');
      expect(result.mergeEligible).toBe(false);
    });

    it('GUARD 2: a persona with zero completed receipts still blocks, even with zero findings', () => {
      const partialView = pipeline.reviewViewWasPartial(truncatedCoverage);
      const finalized = pipeline.finalizeBoundedReviewFindings({
        personaResults: PERSONAS.map((personaId) => ({ personaId, decision: 'APPROVE', findings: [], partial: 0 })),
        findingVerifierPolicy: { enabled: false },
        verifierSummary: null,
        evidenceOwnershipIncomplete: false,
        navigationSnapshot: truncatedNavigationSnapshot,
        options: {},
        partialView,
        decisionLedger: { entries: [] },
      });
      expect(finalized.findingVerification.summary.incomplete).toBe(false);

      // `testing` never produced a single completed receipt (only a timeout) -- a genuine lane
      // failure, unrelated to navigation truncation.
      const incompleteLaneReceipts = PERSONAS.filter((personaId) => personaId !== 'testing').map((personaId) => (
        createLaneExecutionReceipt({ identity, personaId, plan: planFor(personaId), termination: 'completed' })
      ));
      incompleteLaneReceipts.push(createLaneExecutionReceipt({ identity, personaId: 'testing', plan: planFor('testing'), termination: 'timeout' }));

      const result = deriveReceiptOutcome({
        arbitration: cleanArbitration,
        unitManifest: { coverage: { complete: true } },
        laneReceipts: incompleteLaneReceipts,
        findingVerification: finalized.findingVerification,
        headCurrent: true,
        evidenceEnabled: true,
      });

      expect(result.verdict).toBe('BLOCK');
      expect(result.mergeEligible).toBe(false);
    });

    it('GUARD 3: verifier incomplete for a reason other than navigation truncation, with findings present, still blocks', () => {
      const partialView = pipeline.reviewViewWasPartial(truncatedCoverage);
      // The finding verifier itself (an exact-blob check, independent of bounded navigation
      // tooling) could not confirm a real finding -- needsReview > 0 -- regardless of navigation
      // truncation or absence-claim withholding.
      const finalized = pipeline.finalizeBoundedReviewFindings({
        personaResults: buildRawPersonaResultsWithWithheldFinding(),
        findingVerifierPolicy: { enabled: true, mode: 'enforce' },
        verifierSummary: { summary: { incomplete: true, needsReview: 1, accepted: 0, rejected: 0 } },
        evidenceOwnershipIncomplete: false,
        navigationSnapshot: { complete: true, truncated: false },
        options: {},
        partialView,
        decisionLedger: { entries: [] },
      });

      expect(finalized.findingVerification.summary.incomplete).toBe(true);

      const result = deriveReceiptOutcome({
        arbitration: cleanArbitration,
        unitManifest: { coverage: { complete: true } },
        laneReceipts: buildLaneReceipts(),
        findingVerification: finalized.findingVerification,
        headCurrent: true,
        evidenceEnabled: true,
      });

      expect(result.verdict).toBe('BLOCK');
      expect(result.mergeEligible).toBe(false);
    });
  });
});
