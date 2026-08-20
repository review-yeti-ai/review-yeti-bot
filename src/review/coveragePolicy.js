'use strict';

const QUORUMS = new Set(['two_thirds', 'simple_majority', 'unanimous']);
const LANE_STATUSES = new Set(['verdict', 'error', 'timeout', 'empty', 'partial', 'incomplete', 'invalid']);

// `quorum` decides only whether an incomplete panel is labeled 'partial' (numeric quorum met --
// see requiredCoverageCount below) or 'incomplete' (quorum not met). It never widens what can
// merge: `mergeEligible` below is `complete`, i.e. every expected persona produced a trustworthy
// verdict, regardless of which quorum is configured here. A review with 4/5 trustworthy personas
// is 'partial' whether quorum is 'two_thirds' or 'unanimous' -- the *value* of `quorum` changes
// the boundary at which 'partial' degrades further to 'incomplete' (see requiredCoverageCount),
// not whether 'partial' can ever merge. Concretely: setting quorum to 'simple_majority' does not
// make a two-out-of-three-persona review mergeable; it only changes whether that review is
// reported as PARTIAL_REVIEW (evidence retained, quorum met) instead of INCOMPLETE_REVIEW
// (generic incomplete). See reviewCore.js computeArbitration for where `partialCoverage` still
// forces `verdict: 'BLOCK'` even when this quorum is satisfied, and why (API-2902 and the
// find-1/quorum-knob review trace).
const DEFAULT_COVERAGE_POLICY = Object.freeze({
  quorum: 'two_thirds',
  min_personas: 3,
  mandatory_personas: ['security'],
  provider_diversity_min: 2,
});

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeIds(value, name) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  const ids = value.map((id) => String(id ?? '').trim()).filter(Boolean);
  if (ids.length !== value.length) throw new TypeError(`${name} must contain non-empty strings`);
  if (new Set(ids).size !== ids.length) throw new TypeError(`${name} must not contain duplicate IDs`);
  return ids;
}

function positiveInteger(value, name, maximum = 1000) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function normalizeCoveragePolicy(input = {}) {
  if (!isRecord(input)) throw new TypeError('coverage_policy must be an object');
  const quorum = input.quorum ?? DEFAULT_COVERAGE_POLICY.quorum;
  if (!QUORUMS.has(quorum)) throw new TypeError(`coverage_policy.quorum must be one of ${[...QUORUMS].join(', ')}`);
  const min_personas = positiveInteger(
    input.min_personas ?? DEFAULT_COVERAGE_POLICY.min_personas,
    'coverage_policy.min_personas',
  );
  const mandatory_personas = input.mandatory_personas === undefined
    ? [...DEFAULT_COVERAGE_POLICY.mandatory_personas]
    : normalizeIds(input.mandatory_personas, 'coverage_policy.mandatory_personas');
  const provider_diversity_min = positiveInteger(
    input.provider_diversity_min ?? DEFAULT_COVERAGE_POLICY.provider_diversity_min,
    'coverage_policy.provider_diversity_min',
  );

  return { quorum, min_personas, mandatory_personas, provider_diversity_min };
}

function requiredCoverageCount(expectedCount, quorum = DEFAULT_COVERAGE_POLICY.quorum) {
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 0) {
    throw new TypeError('expected persona count must be a non-negative integer');
  }
  if (!QUORUMS.has(quorum)) throw new TypeError(`unknown coverage quorum: ${quorum}`);
  if (expectedCount === 0) return 0;
  if (quorum === 'unanimous') return expectedCount;
  if (quorum === 'simple_majority') return Math.floor(expectedCount / 2) + 1;
  return Math.ceil((2 * expectedCount) / 3);
}

function statusForLane(lane) {
  const explicit = String(lane?.status || '').trim().toLowerCase();
  if (explicit === 'timeout' || explicit === 'timed_out') return 'timeout';
  if (explicit === 'incomplete' || lane?.incomplete === true || lane?.reviewStatus === 'INCOMPLETE_REVIEW' || lane?.decision === 'INCOMPLETE_REVIEW') return 'incomplete';
  if (explicit === 'empty') return 'empty';
  if (explicit === 'error' || explicit === 'failed') return 'error';
  if (lane?.error || lane?.decision === 'ERROR') return 'error';
  // Recovered multi-pass: aggregatePersonaRuns sets partial>0 with APPROVE/FINDINGS when
  // one provider attempt failed but a later pass succeeded. That is still a trustworthy
  // verdict — classifying it as 'partial' made evaluateCoverage incomplete and forced
  // BLOCK/DEGRADED with 0 findings on multi-pass cisco-cdr reviews (#4213).
  if (['APPROVE', 'FINDINGS'].includes(lane?.decision)
      && Array.isArray(lane?.findings)
      && typeof lane?.provider === 'string' && lane.provider.trim()
      && typeof lane?.model === 'string' && lane.model.trim()) {
    return 'verdict';
  }
  if (explicit === 'partial' || Number(lane?.partial) > 0) return 'partial';
  if (!Array.isArray(lane?.findings)) return 'empty';
  if (!['APPROVE', 'FINDINGS'].includes(lane?.decision)) return 'invalid';
  if (typeof lane?.provider !== 'string' || !lane.provider.trim()
      || typeof lane?.model !== 'string' || !lane.model.trim()) return 'invalid';
  return 'verdict';
}

function classifyLane(lane) {
  if (!isRecord(lane)) return { id: '', status: 'invalid', trustworthy: false };
  const id = String(lane.id ?? lane.personaId ?? '').trim();
  const status = statusForLane(lane);
  const provider = typeof lane.provider === 'string' ? lane.provider.trim() : '';
  const model = typeof lane.model === 'string' ? lane.model.trim() : '';
  return {
    id,
    status: LANE_STATUSES.has(status) ? status : 'invalid',
    trustworthy: status === 'verdict',
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
  };
}

function evaluateCoverage({ expectedPersonaIds, lanes, policy } = {}) {
  const expectedIds = normalizeIds(expectedPersonaIds, 'expected_persona_ids');
  if (expectedIds.length === 0) throw new TypeError('expected_persona_ids must contain at least one persona');
  const expectedSet = new Set(expectedIds);
  const normalizedPolicy = normalizeCoveragePolicy(policy);
  const rows = Array.isArray(lanes) ? lanes : [];
  const seen = new Set();
  const classifications = [];

  for (const lane of rows) {
    const classification = classifyLane(lane);
    if (!classification.id) throw new TypeError('lane persona ID is required');
    if (seen.has(classification.id)) throw new Error(`duplicate persona ID: ${classification.id}`);
    if (!expectedSet.has(classification.id)) throw new Error(`unexpected persona ID: ${classification.id}`);
    seen.add(classification.id);
    classifications.push(classification);
  }

  const required = requiredCoverageCount(expectedIds.length, normalizedPolicy.quorum);
  const trustworthyPersonaIds = classifications.filter((row) => row.trustworthy).map((row) => row.id);
  const failedPersonaIds = classifications.filter((row) => !row.trustworthy).map((row) => row.id);
  const incompletePersonaIds = classifications.filter((row) => row.status === 'incomplete').map((row) => row.id);
  const missingPersonaIds = expectedIds.filter((id) => !seen.has(id));
  const missingMandatoryPersonaIds = normalizedPolicy.mandatory_personas
    .filter((id) => !trustworthyPersonaIds.includes(id));
  const distinctProviders = [...new Set(classifications
    .filter((row) => row.trustworthy && row.provider)
    .map((row) => row.provider))].sort();
  const numericQuorumSatisfied = trustworthyPersonaIds.length >= required;
  const minimumRosterSatisfied = expectedIds.length >= normalizedPolicy.min_personas;
  const mandatorySatisfied = missingMandatoryPersonaIds.length === 0;
  const providerDiversitySatisfied = distinctProviders.length >= normalizedPolicy.provider_diversity_min;
  const complete = trustworthyPersonaIds.length === expectedIds.length;
  // `partial` is gated by the configured quorum (numericQuorumSatisfied) plus the roster/mandatory/
  // diversity floors -- this is the one place `quorum` has any effect. It only ever produces the
  // 'partial' label, never 'complete': merge eligibility (mergeEligible below) is unaffected by
  // quorum and requires `complete` in every case.
  const partial = !complete
    && minimumRosterSatisfied
    && numericQuorumSatisfied
    && mandatorySatisfied
    && providerDiversitySatisfied;
  const status = complete ? 'complete' : partial ? 'partial' : 'incomplete';

  return {
    status,
    coverageStatus: status,
    policy: normalizedPolicy,
    expectedPersonaIds: expectedIds,
    expectedCount: expectedIds.length,
    required,
    trustworthyPersonaIds,
    trustworthyCount: trustworthyPersonaIds.length,
    failedPersonaIds,
    incompletePersonaIds,
    missingPersonaIds,
    missingMandatoryPersonaIds,
    mandatorySatisfied,
    minimumRosterSatisfied,
    numericQuorumSatisfied,
    providerDiversitySatisfied,
    distinctProviders,
    classifications,
    // Deliberately `complete`, not `partial || complete`: the configured quorum never makes a
    // review mergeable on its own. See the `quorum` comment on DEFAULT_COVERAGE_POLICY above.
    mergeEligible: complete,
  };
}

module.exports = {
  DEFAULT_COVERAGE_POLICY,
  normalizeCoveragePolicy,
  requiredCoverageCount,
  classifyLane,
  evaluateCoverage,
};
