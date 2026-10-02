import { describe, expect, it } from 'vitest';
import { formatIncompleteRosterGateSummary, parseIncompleteRosterSummary } from '../../src/review/incompleteRosterSummary';
import { validateReviewGenerationRecoveryEvidence } from '../../src/review/reviewGenerationRecovery';

const HEAD = 'a'.repeat(40);
const RUN = `run_${'b'.repeat(32)}`;
const EXPECTED_GATE_SUMMARY = 'Review Yeti Gate failed: the panel expected 3 review lane(s) but 2 completed. This is an incomplete review, not a findings verdict; re-dispatch the review for this head.';
const WORKER_SUMMARY = `Verdict \`BLOCK\` at \`${HEAD}\`.\n\nFindings: 1 (blocking P0/P1: 0; 1 raw persona finding(s) before clustering).\n\nCoverage: mode=panel; expected lanes=3; completed lanes=2; failed lanes=0; roster valid=false; quorum satisfied=false; full panel complete=false.`;
const CURRENT_P2_WORKER_SUMMARY = `Verdict \`BLOCK\` at \`${HEAD}\`.\n\nFindings: 3 (blocking P0/P1/P2: 3; 4 raw persona finding(s) before clustering).\n\nCoverage: mode=panel; expected lanes=3; completed lanes=2; failed lanes=0; roster valid=false; quorum satisfied=false; full panel complete=false.`;

function evidence(gateSummary = EXPECTED_GATE_SUMMARY, workerSummary = WORKER_SUMMARY) {
  return [{
    generation: 1,
    checkId: 101,
    externalId: `${RUN}:a1`,
    conclusion: 'failure' as const,
    title: 'Review Yeti: BLOCK',
    legacyIncompleteRoster: {
      workerSummary,
      workerStartedAt: '2026-09-29T11:59:58Z',
      workerCompletedAt: '2026-09-29T12:00:00Z',
      gateChecks: [{
        id: 201,
        name: 'Review Yeti Gate',
        head_sha: HEAD,
        external_id: `review-yeti-gate:v1:${'c'.repeat(64)}`,
        status: 'completed',
        conclusion: 'failure',
        app: { id: 77, slug: 'ct-review-bot' },
        completed_at: '2026-09-29T12:00:01Z',
        output: { title: 'Review Yeti Gate: Failed (incomplete panel)', summary: gateSummary },
      }],
    },
  }];
}

describe('incomplete roster Gate summary', () => {
  it('preserves the published bytes and produces the exact summary accepted by recovery validation', () => {
    const summary = formatIncompleteRosterGateSummary(3, 2);
    expect(summary).toBe(EXPECTED_GATE_SUMMARY);
    expect(validateReviewGenerationRecoveryEvidence({
      owner: 'example', repo: 'repo', headSha: HEAD, runId: RUN,
      expectedGeneration: 2, expectedAppId: 77, incompleteP2Recovery: true,
    }, evidence(summary))).toHaveLength(1);
  });

  it('rejects a summary whose published wording or lane counts differ', () => {
    expect(() => validateReviewGenerationRecoveryEvidence({
      owner: 'example', repo: 'repo', headSha: HEAD, runId: RUN,
      expectedGeneration: 2, expectedAppId: 77, incompleteP2Recovery: true,
    }, evidence(EXPECTED_GATE_SUMMARY.replace('2 completed', '1 completed')))).toThrow(/generation recovery ledger/u);
  });

  it('accepts the current publisher P2-inclusive summary only when blocking and canonical counts agree', () => {
    expect(validateReviewGenerationRecoveryEvidence({
      owner: 'example', repo: 'repo', headSha: HEAD, runId: RUN,
      expectedGeneration: 2, expectedAppId: 77, incompleteP2Recovery: true,
    }, evidence(EXPECTED_GATE_SUMMARY, CURRENT_P2_WORKER_SUMMARY))).toHaveLength(1);

    const mismatched = CURRENT_P2_WORKER_SUMMARY.replace('blocking P0/P1/P2: 3', 'blocking P0/P1/P2: 2');
    expect(() => validateReviewGenerationRecoveryEvidence({
      owner: 'example', repo: 'repo', headSha: HEAD, runId: RUN,
      expectedGeneration: 2, expectedAppId: 77, incompleteP2Recovery: true,
    }, evidence(EXPECTED_GATE_SUMMARY, mismatched))).toThrow(/generation recovery ledger/u);
  });

  it('rejects raw persona counts below the canonical finding count', () => {
    const validate = (workerSummary: string) => validateReviewGenerationRecoveryEvidence({
      owner: 'example', repo: 'repo', headSha: HEAD, runId: RUN,
      expectedGeneration: 2, expectedAppId: 77, incompleteP2Recovery: true,
    }, evidence(EXPECTED_GATE_SUMMARY, workerSummary));

    const matchingCounts = CURRENT_P2_WORKER_SUMMARY.replace(
      '4 raw persona finding(s)',
      '3 raw persona finding(s)',
    );
    expect(parseIncompleteRosterSummary(matchingCounts, HEAD)?.rawFindingCount).toBe(3);
    expect(validate(matchingCounts)).toHaveLength(1);

    const rawBelowCanonical = CURRENT_P2_WORKER_SUMMARY.replace(
      '4 raw persona finding(s)',
      '2 raw persona finding(s)',
    );
    expect(parseIncompleteRosterSummary(rawBelowCanonical, HEAD)).toBeNull();
    expect(() => validate(rawBelowCanonical)).toThrow(/generation recovery ledger/u);
  });
});
