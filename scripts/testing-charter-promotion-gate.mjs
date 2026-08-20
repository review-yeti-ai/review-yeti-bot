#!/usr/bin/env node
/**
 * Promotion gate for testing-charter / security-charter style detection reports.
 *
 * evaluate-testing-charter.mjs measures detection rate and false-positive rate but never turns
 * those numbers into a keep/reject decision -- a human has to eyeball the JSON and decide. Every
 * other eval surface in this repo that claims to gate a change already encodes an explicit
 * numeric threshold instead (docs/DEPENDENCY_REVIEW_EVALUATION.md's "Keep the feature default-on
 * only when..." list; scripts/run-review-intelligence-promotion.mjs's pass/fail receipt). This
 * script ports that same pattern to the persona-detection reports evaluate-testing-charter.mjs
 * already produces, so "did detection get better without the reviewer getting chattier" stops
 * being an eyeball judgment call.
 *
 * Input is the --out JSON evaluate-testing-charter.mjs writes (schemaVersion
 * testing-charter-eval-report-v1). Thresholds are deliberately the same shape as the
 * dependency-investigation gate:
 *   - zero output-contract breaches (candidate.findings > 3 in any run) -- hard rule, no waiver;
 *   - candidate false-positive rate <= --max-fp-rate (default 0.10), matching the dependency
 *     gate's "no higher than 10%" absolute ceiling;
 *   - if a baseline arm is present: candidate false-positive rate no more than --max-fp-regression
 *     (default 0.05, i.e. five points) worse than baseline's, and candidate detection rate no
 *     more than --max-detection-regression (default 0, i.e. none) worse than baseline's --
 *     chasing precision by getting quieter on real defects is a regression, not an improvement.
 *   - candidate-only reports (no baseline arm, e.g. a brand-new persona corpus) skip the
 *     relative checks and apply only the absolute false-positive ceiling.
 *
 * Wilson intervals from the report are carried through into the receipt so a borderline pass/fail
 * on a small repetition count is visible, not hidden behind a single point estimate.
 *
 *   node scripts/testing-charter-promotion-gate.mjs --report eval-baselines/testing-charter-legacy.json
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

export function evaluatePromotionGate(report, {
  maxFalsePositiveRate = 0.10,
  maxFalsePositiveRegression = 0.05,
  maxDetectionRegression = 0,
} = {}) {
  const candidate = report.arms.find((arm) => arm.arm === 'candidate');
  const baseline = report.arms.find((arm) => arm.arm === 'baseline');
  const reasons = [];

  if (!candidate) {
    return { status: 'fail', reasons: ['no candidate arm in report'], candidate: null, baseline: null };
  }

  if (candidate.outputContractBreaches > 0) {
    reasons.push(`candidate.outputContractBreaches=${candidate.outputContractBreaches} (must be 0; ≤3-findings contract violated)`);
  }

  if (candidate.falsePositiveRate !== null && candidate.falsePositiveRate > maxFalsePositiveRate) {
    reasons.push(`candidate.falsePositiveRate=${candidate.falsePositiveRate} exceeds ceiling ${maxFalsePositiveRate}`);
  }

  if (baseline) {
    const fpBaseline = baseline.falsePositiveRate ?? 0;
    const fpCandidate = candidate.falsePositiveRate ?? 0;
    if (fpCandidate - fpBaseline > maxFalsePositiveRegression) {
      reasons.push(`candidate.falsePositiveRate=${fpCandidate} is more than ${maxFalsePositiveRegression} worse than baseline=${fpBaseline}`);
    }
    const detBaseline = baseline.detectionRate ?? 0;
    const detCandidate = candidate.detectionRate ?? 0;
    if (detBaseline - detCandidate > maxDetectionRegression) {
      reasons.push(`candidate.detectionRate=${detCandidate} regresses more than ${maxDetectionRegression} below baseline=${detBaseline}`);
    }
  }

  return {
    status: reasons.length ? 'fail' : 'pass',
    reasons,
    thresholds: { maxFalsePositiveRate, maxFalsePositiveRegression, maxDetectionRegression },
    candidate: {
      detectionRate: candidate.detectionRate,
      detectionRate95: candidate.detectionRate95,
      falsePositiveRate: candidate.falsePositiveRate,
      outputContractBreaches: candidate.outputContractBreaches,
    },
    baseline: baseline ? {
      detectionRate: baseline.detectionRate,
      falsePositiveRate: baseline.falsePositiveRate,
    } : null,
  };
}

async function main() {
  const reportPath = argument('--report', '');
  if (!reportPath) {
    console.log(JSON.stringify({ status: 'fail', reasons: ['--report <path> is required'] }, null, 2));
    return 1;
  }
  const report = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), reportPath), 'utf8'));
  if (report.status === 'not_run') {
    console.log(JSON.stringify({ status: 'not_run', reasons: [report.reason || 'underlying eval did not run'] }, null, 2));
    return 0;
  }
  const receipt = evaluatePromotionGate(report, {
    maxFalsePositiveRate: Number(argument('--max-fp-rate', 0.10)),
    maxFalsePositiveRegression: Number(argument('--max-fp-regression', 0.05)),
    maxDetectionRegression: Number(argument('--max-detection-regression', 0)),
  });
  console.log(JSON.stringify(receipt, null, 2));
  return receipt.status === 'fail' ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  process.exitCode = await main();
}
