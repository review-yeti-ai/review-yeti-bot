#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildDependencyEvidence, classifyDependencyPath } = require('../src/review/dependencyEvidence.js');

const CATEGORIES = new Set(['fault', 'clean', 'boundary']);
const REQUIRED_FIXTURES = 16;
const DEFAULT_REPETITIONS = 3;

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function responseDecision(response = {}) {
  return Array.isArray(response.findings) && response.findings.length > 0 ? 'FINDINGS' : 'APPROVE';
}

// This is the legacy behavior: findings-only parsing ignored review_status and evidence_requests.
function legacyDecision(response = {}) {
  return responseDecision(response);
}

function candidateDecision(fixture) {
  const initial = fixture.initial || {};
  if (initial.review_status !== 'NEEDS_EVIDENCE') {
    return { decision: responseDecision(initial), evidence: null, followUp: false };
  }

  const evidence = buildDependencyEvidence(
    fixture.files,
    initial.evidence_requests,
    fixture.evidenceOptions || {},
  );
  if (!evidence.complete) {
    return { decision: 'INCOMPLETE_REVIEW', evidence, followUp: true };
  }
  return {
    decision: responseDecision(fixture.followup || {}),
    evidence,
    followUp: true,
  };
}

function validRequest(request) {
  return Boolean(request && typeof request.path === 'string' && classifyDependencyPath(request.path));
}

function validateFixture(fixture, index) {
  const errors = [];
  if (!fixture || typeof fixture !== 'object' || !fixture.id) errors.push(`fixture_${index}_id`);
  if (!CATEGORIES.has(fixture?.category)) errors.push(`${fixture?.id || index}_category`);
  if (!Array.isArray(fixture?.files)) errors.push(`${fixture?.id || index}_files`);
  if (!fixture?.expected?.decision) errors.push(`${fixture?.id || index}_expected_decision`);
  if (fixture?.initial?.review_status === 'NEEDS_EVIDENCE' && !Array.isArray(fixture?.initial?.evidence_requests)) {
    errors.push(`${fixture?.id || index}_evidence_requests`);
  }
  return errors;
}

function summarize(rows, arm) {
  const selected = rows.filter((row) => row.arm === arm);
  const faults = selected.filter((row) => row.category === 'fault');
  const clean = selected.filter((row) => row.category === 'clean');
  const boundaries = selected.filter((row) => row.category === 'boundary' && row.expectedDecision === 'INCOMPLETE_REVIEW');
  const expectedCorrect = selected.filter((row) => row.decision === row.expectedDecision).length;
  const evidenceRequests = selected.flatMap((row) => row.evidenceRequests || []);
  const validEvidenceRequests = evidenceRequests.filter(validRequest).length;
  const postEvidenceRows = selected.filter((row) => row.hasAvailableEvidence);
  return {
    rows: selected.length,
    expectedDecisionAccuracy: selected.length ? Number((expectedCorrect / selected.length).toFixed(4)) : 0,
    faultRecall: faults.length ? Number((faults.filter((row) => row.decision === 'FINDINGS').length / faults.length).toFixed(4)) : 0,
    cleanFalsePositiveRate: clean.length ? Number((clean.filter((row) => row.decision === 'FINDINGS').length / clean.length).toFixed(4)) : 0,
    unsafeShipRate: boundaries.length ? Number((boundaries.filter((row) => row.decision === 'APPROVE').length / boundaries.length).toFixed(4)) : 0,
    validEvidenceRequestRate: evidenceRequests.length ? Number((validEvidenceRequests / evidenceRequests.length).toFixed(4)) : null,
    postEvidenceDecisionAccuracy: postEvidenceRows.length
      ? Number((postEvidenceRows.filter((row) => row.decision === row.expectedDecision).length / postEvidenceRows.length).toFixed(4))
      : null,
    followUps: selected.filter((row) => row.followUp).length,
    tokens: null,
    costUsd: null,
    latencyMsP95: null,
  };
}

export function evaluateDependencyMatrix(matrix = {}) {
  const fixtures = Array.isArray(matrix.fixtures) ? matrix.fixtures : [];
  const repetitions = Number.isInteger(matrix.repetitions) ? matrix.repetitions : DEFAULT_REPETITIONS;
  const failures = fixtures.flatMap(validateFixture);
  if (matrix.schemaVersion !== 'dependency-review-eval-v1') failures.push('schema_version');
  if (fixtures.length !== REQUIRED_FIXTURES) failures.push('fixture_count');
  if (repetitions < 1 || repetitions > 10) failures.push('repetitions');

  const rows = [];
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    for (const fixture of fixtures) {
      const candidate = candidateDecision(fixture);
      const requestCount = Array.isArray(fixture.initial?.evidence_requests) ? fixture.initial.evidence_requests.length : 0;
      const hasAvailableEvidence = candidate.evidence?.complete === true;
      rows.push({
        repetition,
        fixtureId: fixture.id,
        category: fixture.category,
        arm: 'baseline',
        decision: legacyDecision(fixture.initial),
        expectedDecision: fixture.expected.decision,
        followUp: false,
        hasAvailableEvidence,
        evidenceRequests: fixture.initial?.evidence_requests || [],
        requestCount,
      });
      rows.push({
        repetition,
        fixtureId: fixture.id,
        category: fixture.category,
        arm: 'candidate',
        decision: candidate.decision,
        expectedDecision: fixture.expected.decision,
        followUp: candidate.followUp,
        hasAvailableEvidence,
        evidenceRequests: fixture.initial?.evidence_requests || [],
        requestCount,
      });
    }
  }

  const baseline = summarize(rows, 'baseline');
  const candidate = summarize(rows, 'candidate');
  const recallDelta = Number((candidate.faultRecall - baseline.faultRecall).toFixed(4));
  const deterministicGates = {
    noUnsafeShipOnBoundaries: candidate.unsafeShipRate === 0,
    recallImprovement: recallDelta >= 0.15 || candidate.faultRecall - baseline.faultRecall >= (2 / (fixtures.filter((fixture) => fixture.category === 'fault').length || 1)),
    validEvidenceRequests: (candidate.validEvidenceRequestRate || 0) >= 0.9,
    postEvidenceDecisions: (candidate.postEvidenceDecisionAccuracy || 0) >= 0.9,
    cleanFalsePositives: candidate.cleanFalsePositiveRate <= 0.1,
  };
  const deterministicPass = Object.values(deterministicGates).every(Boolean) && failures.length === 0;
  return {
    schemaVersion: 'dependency-review-eval-result-v1',
    status: deterministicPass ? 'pass' : 'fail',
    promotionReady: false,
    promotionBlockers: ['live_provider_cost_and_latency_not_measured'],
    deterministic: true,
    repetitions,
    fixtureCount: fixtures.length,
    failures: [...new Set(failures)],
    baseline,
    candidate,
    deltas: { faultRecall: recallDelta },
    deterministicGates,
    rows,
  };
}

if (process.argv[1]?.endsWith('evaluate-dependency-investigation.mjs')) {
  const fixturePath = path.resolve(process.cwd(), argument('--fixture', 'tests/fixtures/dependency-evaluation.json'));
  const matrix = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const result = evaluateDependencyMatrix(matrix);
  console.log(JSON.stringify(result));
  if (result.status !== 'pass') process.exitCode = 1;
}
