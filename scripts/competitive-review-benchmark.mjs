#!/usr/bin/env node

/**
 * Actual-runtime benchmark support for the review engine.
 *
 * This tool deliberately does not use EvaluationRunner's offline profile simulator. The
 * verification command calls the production `runFindingFalsification` stage and its production
 * model-turn adapter. Discovery runs are a separate arm and must be wired through the effective
 * production-selected review entrypoint before they can qualify an engine release.
 *
 * AACR-Bench is comment-verification data, not an exhaustive discovery oracle. Reference matches
 * are reported as matched recall; generated comments without an independently recorded judgment
 * remain unjudged. No precision or superiority claim is produced without actual adjudications.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';

const require = createRequire(import.meta.url);

export const AACR_BENCHMARK = Object.freeze({
  name: 'AACR-Bench',
  dataset: 'Alibaba-Aone/aacr-bench',
  revision: '47be1d6df1e7faf222cf531587772d92f79fe6b2',
  sha256: '0804505f0a474765ce2840c832cfeaa6c4f0250dd6ccb169fe73c6758b245a86',
  rowCount: 2145,
  license: 'Apache-2.0',
});
export const AACR_HELDOUT_MANIFEST_SHA256 = 'bf3a09a1d8a10097480ed7cafd35f4ef2309312d23f3dface79ac55f765e2aab';
export const WS5_AACR_MANIFEST_SHA256 = '762370e1c595bd5a39d93f670287fca059258fa16b6854d885f4a1e4ed7589df';

export const HELDOUT_LANGUAGES = Object.freeze([
  'C', 'C#', 'C++', 'Go', 'Java', 'JavaScript', 'PHP', 'Python', 'Rust', 'TypeScript',
]);

const SPLIT_SALT = 'review-yeti-ws5-v1|';
const CASE_SALT = 'review-yeti-ws5-selection-v1|';
const CONTEXT_ORDER = Object.freeze(['Diff Level', 'File Level', 'Repo Level']);
const HASH_RE = /^[a-f0-9]{40}$/iu;
const SHA256_RE = /^[a-f0-9]{64}$/iu;
const SOURCE_SNAPSHOT_VERIFICATION = 'preparation_stage_only_not_reverified_at_run';
const completionDispatchScope = new AsyncLocalStorage();
let composedEngineTurnLimitScopeActive = false;
export const V1_BASELINE_RUNTIME_SHA = 'e70749fd4b14cb284b1497974306975cbce2d47a';
export const V1_POLICY_PROVENANCE = Object.freeze({
  revision: '216d33cd75605d97b0e0b8becb7457ce7e326ecd',
  sourceSha256: 'fc8fca2983de662b9ae13269c4085dce07ba3ecf71e1375bc7ce8f9ffd0ee3f2',
  projectionSha256ByEffort: Object.freeze({
    native_omitted: '398d49d717fab231b5bb355ba0b27ccad80ae0525b73a68af2f41e52985e9a0c',
    medium: '403a9276715fece9b9c4c3cafb694ef2dd72f66c98f0164aa8adf3cb039f73d1',
  }),
});
const COMPOSED_BENCHMARK_DEFAULTS = Object.freeze({
  maxTasks: 8,
  maxTurnsTotal: 100,
  planTurns: 4,
  baseTaskTurns: 12,
  dynamicTaskTurnsMax: 18,
  dynamicTaskTurnsPerAdditionalPath: 2,
  dynamicTaskPathIncrementMax: 6,
  taskFinalizationReserveTurns: 3,
  coverageAssignmentCeiling: 24,
  taskConcurrencyCeiling: 3,
});
const MAX_FALSIFICATION_DIFF_CHARS = 24_000;
const MAX_GITHUB_JSON_BYTES = 12 * 1024 * 1024;
const MAX_CHANGED_FILES_API = 600;
const MAX_TREE_ENTRIES_API = 100_000;
const MAX_SOURCE_FILE_BYTES = 1024 * 1024;
const MAX_SOURCE_CASE_BYTES = 32 * 1024 * 1024;
const FALSIFICATION_REASON_CODES = new Set([
  'confirmed', 'refuted', 'model_abstained', 'verifier_timeout', 'verifier_unavailable',
  'stage_budget_exhausted', 'call_budget_exhausted', 'cancelled', 'contract_incomplete',
]);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** Preserve a caller-supplied, provenance-tracked policy projection byte-for-byte by value. */
export function buildDiscoveryPolicy(sourcePolicy, { purpose = 'smoke', effortProfile = 'medium' } = {}) {
  if (!['smoke', 'baseline', 'qualification'].includes(purpose)) throw new Error('unsupported_discovery_purpose');
  if (!sourcePolicy || typeof sourcePolicy !== 'object' || Array.isArray(sourcePolicy)) {
    throw new Error('discovery_policy_must_be_object');
  }
  const policy = structuredClone(sourcePolicy);
  const effective = policy.review_yeti && typeof policy.review_yeti === 'object' ? policy.review_yeti : policy;
  if (purpose === 'baseline' || purpose === 'qualification') {
    const isComposed = effective.review_engine === 'composed'
      || (effective.review_engine === 'dsh' && effective.fallback_review_engine === 'composed');
    if (!isComposed) throw new Error('qualification_policy_does_not_select_composed_engine');
    if (effective.composed && Object.keys(effective.composed).length > 0) {
      throw new Error('qualification_policy_must_preserve_composed_engine_defaults');
    }
    const transports = Array.isArray(effective.transports) ? effective.transports.filter((entry) =>
      entry?.name === 'bifrost' && entry.enabled === true) : [];
    const requestedMediumValid = effective.reviewer_effort === 'medium';
    const mediumProfileValid = requestedMediumValid && effortProfile === 'medium' && transports.length === 1
      && transports[0].reasoning_effort === 'medium';
    const omittedProfileValid = requestedMediumValid && effortProfile === 'native_omitted' && transports.length === 0;
    if (!mediumProfileValid && !omittedProfileValid) {
      throw new Error('qualification_policy_effort_profile_mismatch');
    }
  }
  return policy;
}

/** Project the source-owned composed defaults and the independent-verifier reserve. */
export function discoveryResourceProfile(policy, { verificationReserveTurns = 0, env = {} } = {}) {
  const effective = policy?.review_yeti && typeof policy.review_yeti === 'object' ? policy.review_yeti : policy;
  const composed = effective?.composed || {};
  const composedTurnOverride = Number(env.COMPOSED_ENGINE_MAX_TURNS);
  const configuredTurns = Number.isSafeInteger(composedTurnOverride) && composedTurnOverride > 0
    ? Math.min(composedTurnOverride, 200)
    : Number.isSafeInteger(composed.max_turns_total) && composed.max_turns_total > 0
      ? Math.min(composed.max_turns_total, COMPOSED_BENCHMARK_DEFAULTS.maxTurnsTotal)
      : COMPOSED_BENCHMARK_DEFAULTS.maxTurnsTotal;
  const taskOverride = Number.isSafeInteger(composed.max_tasks) && composed.max_tasks > 0
    ? composed.max_tasks : COMPOSED_BENCHMARK_DEFAULTS.maxTasks;
  const perTaskOverride = Number.isSafeInteger(composed.max_turns_per_task) && composed.max_turns_per_task > 0
    ? composed.max_turns_per_task : null;
  const configuredFindings = Number.isSafeInteger(composed.max_findings_total) && composed.max_findings_total > 0
    ? composed.max_findings_total : null;
  const findingsOverride = Number(env.COMPOSED_ENGINE_MAX_FINDINGS || env.REVIEW_YETI_MAX_FINDINGS);
  const maxFindings = Number.isSafeInteger(findingsOverride) && findingsOverride > 0
    ? Math.min(findingsOverride, 500)
    : Math.min(configuredFindings || 25, 500);
  const laneOverrideText = env.REVIEW_YETI_MAX_CONCURRENT_LANES;
  const laneOverride = typeof laneOverrideText === 'string' && /^\d+$/u.test(laneOverrideText.trim())
    ? Number(laneOverrideText.trim()) : 8;
  const effectiveLanes = Number.isSafeInteger(laneOverride) && laneOverride >= 1 ? Math.min(laneOverride, 16) : 8;
  const reserve = Number.isSafeInteger(verificationReserveTurns) && verificationReserveTurns > 0
    ? Math.min(verificationReserveTurns, Math.max(0, configuredTurns - 1)) : 0;
  return {
    source: 'composed_engine_defaults',
    policyMaxInvestigationTurns: Number.isSafeInteger(effective?.budget?.max_investigation_turns)
      ? effective.budget.max_investigation_turns : null,
    configuredMaxTasks: Number.isSafeInteger(composed.max_tasks) ? composed.max_tasks : null,
    configuredMaxTurnsTotal: Number.isSafeInteger(composed.max_turns_total) ? composed.max_turns_total : null,
    configuredMaxTurnsPerTask: perTaskOverride,
    effectiveMaxTasks: Math.min(taskOverride, COMPOSED_BENCHMARK_DEFAULTS.maxTasks),
    effectiveMaxTurnsTotal: configuredTurns,
    planTurns: COMPOSED_BENCHMARK_DEFAULTS.planTurns,
    baseTaskTurns: Math.min(perTaskOverride ?? COMPOSED_BENCHMARK_DEFAULTS.baseTaskTurns,
      COMPOSED_BENCHMARK_DEFAULTS.baseTaskTurns),
    dynamicTaskTurnsMax: Math.min(perTaskOverride ?? COMPOSED_BENCHMARK_DEFAULTS.dynamicTaskTurnsMax,
      COMPOSED_BENCHMARK_DEFAULTS.dynamicTaskTurnsMax),
    dynamicTaskTurnsPerAdditionalPath: COMPOSED_BENCHMARK_DEFAULTS.dynamicTaskTurnsPerAdditionalPath,
    dynamicTaskPathIncrementMax: COMPOSED_BENCHMARK_DEFAULTS.dynamicTaskPathIncrementMax,
    taskFinalizationReserveTurns: COMPOSED_BENCHMARK_DEFAULTS.taskFinalizationReserveTurns,
    coverageAssignmentCeiling: COMPOSED_BENCHMARK_DEFAULTS.coverageAssignmentCeiling,
    taskConcurrencyCeiling: Math.min(COMPOSED_BENCHMARK_DEFAULTS.taskConcurrencyCeiling, effectiveLanes),
    configuredMaxFindingsTotal: configuredFindings,
    effectiveMaxFindingsTotal: maxFindings,
    verificationReserveTurns: reserve,
    discoveryTurnsAvailable: configuredTurns - reserve,
  };
}

/** Guard the reviewer-input side of a benchmark bundle against attached labels or oracle rows. */
export function assertBlindDiscoveryInputCases(cases) {
  if (!Array.isArray(cases)) throw new Error('discovery_input_cases_missing');
  const forbidden = new Set([
    'label', 'labels', 'expectedlabel', 'expectedlabels', 'expectedverdict', 'expectedfinding', 'expectedfindings',
    'expectedcomment', 'expectedcomments', 'oracle', 'reference', 'groundtruth', 'adjudication', 'annotationid',
  ]);
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const entry of value) visit(entry); return; }
    for (const [key, child] of Object.entries(value)) {
      if (forbidden.has(key.replace(/[^a-z]/giu, '').toLowerCase())) {
        throw new Error('discovery_reviewer_input_contains_expected_label_or_oracle');
      }
      visit(child);
    }
  };
  for (const entry of cases) visit(entry);
  return true;
}

/** Reject operator overrides that would make the compared run narrower than the supported envelope. */
export function assertFullEnvelopeQualificationProfile(policy, {
  verificationReserveTurns = 12,
  env = process.env,
} = {}) {
  const profile = discoveryResourceProfile(policy, { verificationReserveTurns, env });
  if (profile.effectiveMaxTasks !== 8 || profile.effectiveMaxTurnsTotal !== 100
    || profile.baseTaskTurns !== 12 || profile.dynamicTaskTurnsMax !== 18
    || profile.taskConcurrencyCeiling !== 3 || profile.effectiveMaxFindingsTotal !== 25
    || profile.discoveryTurnsAvailable !== 100 - verificationReserveTurns) {
    throw new Error('qualification_resource_profile_differs_from_supported_production_envelope');
  }
  return profile;
}

/** @param {{expectedRuntimeSha?: string, runtimeIdentity?: {commit?: string, worktreeClean?: boolean}, transportEnv?: NodeJS.ProcessEnv}} input */
export function assertQualificationRuntime({ expectedRuntimeSha, runtimeIdentity, transportEnv = process.env } = {}) {
  if (!HASH_RE.test(expectedRuntimeSha || '') || runtimeIdentity?.commit !== expectedRuntimeSha
    || runtimeIdentity?.worktreeClean !== true) {
    throw new Error('qualification_runtime_identity_or_cleanliness_mismatch');
  }
  if (String(transportEnv.REVIEW_MODEL || 'pr-reviewer') !== 'pr-reviewer') {
    throw new Error('qualification_route_alias_mismatch');
  }
  return true;
}

/** @param {{expectedRuntimeSha?: string, runtimeIdentity?: {commit?: string, worktreeClean?: boolean}, transportEnv?: NodeJS.ProcessEnv}} input */
export function assertV1BaselineRuntime({ expectedRuntimeSha, runtimeIdentity, transportEnv = process.env } = {}) {
  if (expectedRuntimeSha !== V1_BASELINE_RUNTIME_SHA) {
    throw new Error('v1_baseline_runtime_sha_mismatch');
  }
  return assertQualificationRuntime({ expectedRuntimeSha, runtimeIdentity, transportEnv });
}

export function assertKnownPolicyProjection(effortProfile, projectionSha256) {
  if (V1_POLICY_PROVENANCE.projectionSha256ByEffort[effortProfile] !== projectionSha256) {
    throw new Error('qualification_policy_projection_provenance_mismatch');
  }
  return true;
}

/**
 * The composed engine reads this operator override from process.env, outside the worker env
 * object. Scope the smoke cap around the production call and restore the caller's value even
 * when the worker throws; otherwise an inherited larger override silently defeats smoke limits.
 */
export async function withScopedComposedEngineTurnLimit(maxTurnsTotal, operation) {
  if (!Number.isSafeInteger(maxTurnsTotal) || maxTurnsTotal < 1 || typeof operation !== 'function') {
    throw new Error('invalid_scoped_composed_turn_limit');
  }
  if (composedEngineTurnLimitScopeActive) throw new Error('composed_engine_turn_limit_scope_already_active');
  const previous = process.env.COMPOSED_ENGINE_MAX_TURNS;
  composedEngineTurnLimitScopeActive = true;
  try {
    process.env.COMPOSED_ENGINE_MAX_TURNS = String(maxTurnsTotal);
    return await operation();
  } finally {
    if (previous === undefined) delete process.env.COMPOSED_ENGINE_MAX_TURNS;
    else process.env.COMPOSED_ENGINE_MAX_TURNS = previous;
    composedEngineTurnLimitScopeActive = false;
  }
}

function groundedVerifierBudgetIsBounded(verification) {
  const budget = verification?.budget;
  return Number.isSafeInteger(verification?.calls) && verification.calls >= 0
    && Number.isSafeInteger(budget?.totalCalls) && budget.totalCalls >= 0 && budget.totalCalls <= 12
    && Number.isSafeInteger(budget?.callsPerTask) && budget.callsPerTask > 0 && budget.callsPerTask <= 12
    && verification.calls <= budget.totalCalls;
}

/** @param {{purpose?: string, verdict?: string, coverage?: {rosterValid?: boolean, quorumSatisfied?: boolean, fullPanelComplete?: boolean}, selectedRunnerInvoked?: boolean, sourceReadOmissions?: string[], groundedReview?: any}} input */
export function assertDiscoveryCaseQualification({
  purpose, verdict, coverage, selectedRunnerInvoked, sourceReadOmissions = [], groundedReview,
} = {}) {
  if (verdict === 'INCOMPLETE' || coverage?.rosterValid !== true || coverage?.quorumSatisfied !== true
    || coverage?.fullPanelComplete !== true || selectedRunnerInvoked !== true
    || !Array.isArray(sourceReadOmissions) || sourceReadOmissions.length > 0) return false;
  if (purpose === 'qualification') {
    return groundedReview?.version === 'GroundedReviewReceipt.v1'
      && groundedReview.coverage?.complete === true
      && Number.isSafeInteger(groundedReview.coverage.regionCount) && groundedReview.coverage.regionCount > 0
      && groundedReview.coverage.coveredRegionCount === groundedReview.coverage.regionCount
      && Number.isSafeInteger(groundedReview.coverage.assignmentCount) && groundedReview.coverage.assignmentCount > 0
      && groundedReview.coverage.assignmentCount <= COMPOSED_BENCHMARK_DEFAULTS.coverageAssignmentCeiling
      && groundedReview.verification?.version === 'GroundedIndependentVerification.v1'
      && groundedReview.verification.coverageComplete === true
      && groundedVerifierBudgetIsBounded(groundedReview.verification);
  }
  return purpose === 'baseline' || purpose === 'smoke';
}

export function discoveryQualificationDisposition({ purpose, completed, total } = {}) {
  const allCompleted = Number.isSafeInteger(completed) && Number.isSafeInteger(total)
    && total > 0 && completed === total;
  if (!allCompleted) return { status: 'ABSTAIN', reason: 'incomplete_source_or_runtime_coverage_no_quality_score' };
  if (purpose === 'qualification') {
    return { status: 'READY_FOR_BLIND_ADJUDICATION', reason: 'selected_source_complete_subset_only' };
  }
  if (purpose === 'baseline') return { status: 'BASELINE_ONLY', reason: 'not_a_standalone_quality_claim' };
  return { status: 'SMOKE_ONLY', reason: 'not_a_quality_run' };
}

export function sanitizePublishingCoverage(value) {
  if (!value || typeof value !== 'object') return null;
  const count = (input) => Number.isSafeInteger(input) && input >= 0 ? input : null;
  const bool = (input) => typeof input === 'boolean' ? input : null;
  return {
    mode: ['panel', 'fast_ship', 'documentation_only'].includes(value.mode) ? value.mode : 'unknown',
    expectedLaneCount: count(value.expectedLaneCount),
    completedLaneCount: count(value.completedLaneCount),
    failedLaneCount: count(value.failedLaneCount),
    rosterValid: bool(value.rosterValid),
    quorumSatisfied: bool(value.quorumSatisfied),
    fullPanelComplete: bool(value.fullPanelComplete),
    groundedReviewComplete: bool(value.groundedReviewComplete),
  };
}

/** Remove all free-form source/model evidence while retaining verifiable WS3 receipt metadata. */
export function sanitizeGroundedReviewReceipt(value) {
  if (!value || typeof value !== 'object') return null;
  const count = (input) => Number.isSafeInteger(input) && input >= 0 ? input : null;
  const digest = (input) => typeof input === 'string' && SHA256_RE.test(input) ? input : null;
  const coverage = value.coverage && typeof value.coverage === 'object' ? {
    digest: digest(value.coverage.digest),
    regionCount: count(value.coverage.regionCount),
    assignmentCount: count(value.coverage.assignmentCount),
    coveredRegionCount: count(value.coverage.coveredRegionCount),
    complete: value.coverage.complete === true,
    omissionCount: Array.isArray(value.coverage.omissions) ? value.coverage.omissions.length : 0,
  } : null;
  const historyValue = value.history && typeof value.history === 'object' ? value.history : {};
  const history = {
    status: ['complete', 'partial', 'unavailable'].includes(historyValue.status) ? historyValue.status : 'unknown',
    snapshotId: typeof historyValue.snapshotId === 'string' && /^[0-9a-f-]{36}$/iu.test(historyValue.snapshotId)
      ? historyValue.snapshotId : null,
    contextDigest: digest(historyValue.contextDigest),
    eventCount: count(historyValue.eventCount),
    findingCount: count(historyValue.findingCount),
    loadedEventCount: count(historyValue.loadedEventCount),
    loadedFindingCount: count(historyValue.loadedFindingCount),
    eventOmittedCount: count(historyValue.eventOmittedCount),
    findingOmittedCount: count(historyValue.findingOmittedCount),
    legacyOmittedCount: count(historyValue.legacyOmittedCount),
    eventsDigest: digest(historyValue.eventsDigest),
    findingsDigest: digest(historyValue.findingsDigest),
    omissionCount: Array.isArray(historyValue.omissions) ? historyValue.omissions.length : 0,
    memorySources: {
      honho: historyValue.memorySources?.honho === 'unavailable' ? 'unavailable' : 'unknown',
      mcp: historyValue.memorySources?.mcp === 'unavailable' ? 'unavailable' : 'unknown',
    },
    verificationWrites: {
      attempted: count(historyValue.verificationWrites?.attempted),
      recorded: count(historyValue.verificationWrites?.recorded),
      failed: count(historyValue.verificationWrites?.failed),
    },
  };
  const verificationValue = value.verification && typeof value.verification === 'object' ? value.verification : {};
  const budget = verificationValue.budget && typeof verificationValue.budget === 'object'
    ? Object.fromEntries(['totalCalls', 'callsPerTask', 'concurrency', 'callTimeoutMs', 'stageBudgetMs']
      .map((key) => [key, count(verificationValue.budget[key])])) : null;
  const outcomes = Array.isArray(verificationValue.outcomes) ? verificationValue.outcomes.map((entry) => ({
    fingerprintDigest: typeof entry?.fingerprint === 'string' ? sha256(entry.fingerprint) : null,
    status: ['confirmed', 'contradicted', 'insufficient', 'unverified'].includes(entry?.status) ? entry.status : 'unknown',
    affectedContextDigest: digest(entry?.affectedContextDigest),
    relatedDiffPaths: Array.isArray(entry?.relatedDiffPaths)
      ? entry.relatedDiffPaths.filter((item) => typeof item === 'string').map((item) => safeRuntimeId(item, 512)) : [],
    evidenceDigest: digest(entry?.evidenceDigest),
  })) : [];
  return {
    version: value.version === 'GroundedReviewReceipt.v1' ? value.version : 'unknown',
    coverage,
    history,
    verification: {
      version: verificationValue.version === 'GroundedIndependentVerification.v1'
        ? verificationValue.version : 'unknown',
      candidates: count(verificationValue.candidates),
      confirmed: count(verificationValue.confirmed),
      contradicted: count(verificationValue.contradicted),
      insufficient: count(verificationValue.insufficient),
      unverifiedBlockerCount: count(verificationValue.unverifiedBlockerCount),
      coverageComplete: verificationValue.coverageComplete === true,
      calls: count(verificationValue.calls),
      budget,
      outcomes,
    },
  };
}

function safeRuntimeId(value, limit = 160) {
  const text = String(value || '').trim();
  try {
    const parsed = new URL(text);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return '[redacted-url]';
  } catch {}
  return text.replace(/[^A-Za-z0-9._:/+@-]/gu, '_').slice(0, limit);
}

function stableTieBreak(value) {
  return sha256(`${CASE_SALT}${value}`);
}

function languageSlug(language) {
  const aliases = { 'C#': 'csharp', 'C++': 'cpp' };
  return aliases[language] || language.toLowerCase().replace(/[^a-z0-9]+/gu, '-');
}

function parsePrUrl(value) {
  const parsed = new URL(String(value || ''));
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'github.com') {
    throw new Error('AACR row has a non-public GitHub pull-request URL');
  }
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length !== 4 || parts[2] !== 'pull' || !/^\d+$/u.test(parts[3])) {
    throw new Error('AACR row has an invalid pull-request URL');
  }
  return { repository: `${parts[0]}/${parts[1]}`, prNumber: Number(parts[3]) };
}

function validateAacrRows(rows, { requirePinnedCount = true } = {}) {
  if (!Array.isArray(rows) || (requirePinnedCount && rows.length !== AACR_BENCHMARK.rowCount)) {
    throw new Error(`AACR dataset row count mismatch; expected ${AACR_BENCHMARK.rowCount}`);
  }
  for (const row of rows) {
    if (!row || ![0, 1].includes(row.label) || !row.note || !row.path
      || !HASH_RE.test(String(row.pr_source_commit || ''))
      || !HASH_RE.test(String(row.pr_target_commit || ''))) {
      throw new Error('AACR dataset contains a row outside the pinned schema');
    }
    parsePrUrl(row.pr_url);
  }
  return rows;
}

export function loadPinnedAacrDataset(datasetPath) {
  const raw = fs.readFileSync(datasetPath);
  const actualDigest = crypto.createHash('sha256').update(raw).digest('hex');
  if (actualDigest !== AACR_BENCHMARK.sha256) {
    throw new Error(`AACR dataset digest mismatch: expected ${AACR_BENCHMARK.sha256}`);
  }
  let rows;
  try {
    rows = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error('AACR dataset is not valid JSON');
  }
  return validateAacrRows(rows);
}

function groupRowsByPr(rows) {
  const groups = new Map();
  for (const row of rows) {
    const { repository, prNumber } = parsePrUrl(row.pr_url);
    const id = `${repository}#${prNumber}`;
    if (!groups.has(id)) groups.set(id, { id, repository, prNumber, rows: [] });
    groups.get(id).rows.push(row);
  }
  return [...groups.values()];
}

function repoHoldout(repositories, fraction = 0.3) {
  if (!(fraction > 0 && fraction < 1)) throw new Error('holdout fraction must be between zero and one');
  const ranked = [...repositories].sort((a, b) =>
    sha256(`${SPLIT_SALT}${a}`).localeCompare(sha256(`${SPLIT_SALT}${b}`)) || a.localeCompare(b));
  const count = Math.ceil(ranked.length * fraction);
  return new Set(ranked.slice(-count));
}

function prSelectionScore(group) {
  const positive = group.rows.filter((row) => row.label === 1).length;
  const negative = group.rows.filter((row) => row.label === 0).length;
  const contexts = new Set(group.rows.map((row) => row.context).filter(Boolean));
  return {
    balancedLabels: Math.min(positive, negative),
    contextCoverage: contexts.size,
    totalLabels: positive + negative,
    tieBreak: stableTieBreak(group.id),
  };
}

function compareSelectionScore(left, right) {
  for (const key of ['balancedLabels', 'contextCoverage', 'totalLabels']) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  return right.tieBreak.localeCompare(left.tieBreak);
}

/**
 * Build one fixed PR per language from a deterministic repository-level holdout split. Labels,
 * reference comments, and comment counts are intentionally absent from the returned manifest.
 */
export function buildAacrManifest(rows, { holdoutFraction = 0.3, requirePinnedDataset = true } = {}) {
  validateAacrRows(rows, { requirePinnedCount: requirePinnedDataset });
  const groups = groupRowsByPr(rows);
  const repositories = [...new Set(groups.map((group) => group.repository))];
  const heldoutRepos = repoHoldout(repositories, holdoutFraction);
  const candidates = groups.filter((group) => heldoutRepos.has(group.repository));
  const cases = [];

  for (const language of HELDOUT_LANGUAGES) {
    const languageGroups = candidates.filter((group) => group.rows[0].project_main_language === language);
    const eligible = languageGroups.filter((group) =>
      group.rows.some((row) => row.label === 1) && group.rows.some((row) => row.label === 0));
    if (eligible.length === 0) throw new Error(`held-out dataset has no mixed-label PR for ${language}`);
    eligible.sort((left, right) => compareSelectionScore(prSelectionScore(left), prSelectionScore(right)));
    const selected = eligible.at(-1);
    const sample = selected.rows[0];
    if (!HASH_RE.test(sample.pr_source_commit) || !HASH_RE.test(sample.pr_target_commit)) {
      throw new Error(`selected PR ${selected.id} is missing immutable source/head commits`);
    }
    const contexts = [...new Set(selected.rows.map((row) => row.context).filter((value) => CONTEXT_ORDER.includes(value)))]
      .sort((a, b) => CONTEXT_ORDER.indexOf(a) - CONTEXT_ORDER.indexOf(b));
    cases.push({
      id: `aacr-${languageSlug(language)}-${selected.prNumber}`,
      repository: selected.repository,
      prNumber: selected.prNumber,
      baseSha: sample.pr_source_commit,
      headSha: sample.pr_target_commit,
      language,
      changedLineCount: Number(sample.pr_change_line_count) || null,
      referenceContextLevels: contexts,
    });
  }

  const duplicateRepos = cases.map((entry) => entry.repository).filter((repo, index, all) => all.indexOf(repo) !== index);
  if (duplicateRepos.length) throw new Error(`held-out sample reused a repository: ${duplicateRepos[0]}`);
  return {
    schemaVersion: 'review-yeti-competitive-benchmark-manifest-v1',
    benchmark: AACR_BENCHMARK.name,
    source: AACR_BENCHMARK.dataset,
    sourceRevision: AACR_BENCHMARK.revision,
    datasetSha256: AACR_BENCHMARK.sha256,
    split: { unit: 'repository', algorithm: 'sha256-ranked-30-percent-v1', salt: SPLIT_SALT },
    sampleUnit: 'pull_request',
    heldoutCaseCount: cases.length,
    cases,
  };
}

function expectedRecordHash(row) {
  const { repository, prNumber } = parsePrUrl(row.pr_url);
  return stableTieBreak(`${repository}#${prNumber}|${row.path}|${row.side}|${row.from_line}|${row.to_line}|${row.note}`);
}

/**
 * Select a bounded, stratified verification panel: at most one correct and one incorrect
 * reference per context stratum and held-out PR by default. Scoring-only annotations stay in
 * `reference`; `prepare-verification` removes them before creating runtime input bundles.
 */
export function buildVerificationCases(rows, manifest, { perLabelPerPr = 1 } = {}) {
  if (!Number.isSafeInteger(perLabelPerPr) || perLabelPerPr < 1 || perLabelPerPr > 3) {
    throw new Error('perLabelPerPr must be in [1, 3]');
  }
  manifestCaseIds(manifest);
  const byPr = new Map(groupRowsByPr(rows).map((group) => [group.id, group]));
  const selected = [];
  for (const pr of manifest.cases) {
    const group = byPr.get(`${pr.repository}#${pr.prNumber}`);
    if (!group) throw new Error(`pinned dataset is missing ${pr.repository}#${pr.prNumber}`);
    for (const label of [1, 0]) {
      for (const context of CONTEXT_ORDER) {
        const candidates = group.rows.filter((row) => row.label === label && row.context === context)
          .sort((a, b) => expectedRecordHash(a).localeCompare(expectedRecordHash(b)));
        for (let index = 0; index < Math.min(perLabelPerPr, candidates.length); index += 1) {
          const row = candidates[index];
          // The ID is deterministic but opaque: neither the expected label nor the benchmark
          // reference ID is exposed to the reviewer or present in the result bundle.
          const id = `aacr-v1-${stableTieBreak(`${pr.id}|${context}|${expectedRecordHash(row)}`).slice(0, 20)}`;
          selected.push({
            id,
            prCaseId: pr.id,
            repository: pr.repository,
            prNumber: pr.prNumber,
            language: pr.language,
            context,
            reference: {
              id: `aacr-comment-${expectedRecordHash(row).slice(0, 16)}`,
              expectedLabel: row.label,
              category: row.category,
              path: row.path,
              side: row.side,
              line: Number.isSafeInteger(Number(row.from_line)) ? Number(row.from_line) : null,
              endLine: Number.isSafeInteger(Number(row.to_line)) ? Number(row.to_line) : null,
              note: row.note,
            },
          });
        }
      }
    }
  }
  return selected;
}

/** The verifier receives the claim, but never the annotation label or its identifier. */
export function toVerifierInput(testCase) {
  const note = String(testCase.reference.note || '').trim();
  const title = note.split(/\n|(?<=[.!?])\s+/u, 1)[0].slice(0, 200) || 'Review hypothesis';
  return {
    caseId: testCase.id || testCase.caseId,
    finding: {
      severity: 'P2',
      path: testCase.reference.path,
      line: testCase.reference.line,
      side: testCase.reference.side,
      title,
      body: note.slice(0, 2_000),
    },
  };
}

export function wilsonInterval(hits, total) {
  if (!Number.isInteger(hits) || !Number.isInteger(total) || hits < 0 || total < hits) {
    throw new Error('Wilson interval requires 0 <= hits <= total');
  }
  if (total === 0) return null;
  const z = 1.96;
  const p = hits / total;
  const denominator = 1 + (z * z) / total;
  const centre = (p + (z * z) / (2 * total)) / denominator;
  const spread = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denominator;
  return [Number(Math.max(0, centre - spread).toFixed(4)), Number(Math.min(1, centre + spread).toFixed(4))];
}

function summarizeVerificationClass(testCases, results, label) {
  const selected = testCases.filter((entry) => entry.reference.expectedLabel === label);
  const byId = new Map(results.map((entry) => [entry.caseId, entry]));
  const comparable = selected.filter((entry) => byId.get(entry.id)?.contextQualification === 'aligned_diff_only');
  const expectedVerdict = label === 1 ? 'CONFIRM' : 'REFUTE';
  const decided = comparable.map((entry) => byId.get(entry.id)).filter((entry) =>
    entry && ['CONFIRM', 'REFUTE'].includes(entry.verdict));
  const correct = decided.filter((entry) => entry.verdict === expectedVerdict).length;
  const abstained = comparable.filter((entry) => byId.get(entry.id)?.verdict === 'ABSTAIN').length;
  const missing = comparable.length - decided.length - abstained;
  return {
    referenceLabel: label === 1 ? 'correct_comment' : 'incorrect_comment',
    panelCases: selected.length,
    comparableCases: comparable.length,
    contextNotSuppliedCases: selected.length - comparable.length,
    n: comparable.length,
    correctDecisions: correct,
    decided: decided.length,
    selectiveAccuracy: decided.length ? correct / decided.length : null,
    selectiveAccuracy95: wilsonInterval(correct, decided.length),
    abstained,
    missingOrErrored: missing,
  };
}

export function scoreVerificationCases(testCases, results) {
  const ids = new Set(testCases.map((entry) => entry.id));
  const resultIds = results.map((entry) => entry.caseId);
  if (new Set(resultIds).size !== resultIds.length || resultIds.some((id) => !ids.has(id))) {
    throw new Error('verification result IDs must be unique members of the fixed panel');
  }
  const labels = summarizeVerificationClass(testCases, results, 1);
  const negatives = summarizeVerificationClass(testCases, results, 0);
  const matchedRows = new Map(results.map((entry) => [entry.caseId, entry]));
  const byContext = Object.fromEntries(CONTEXT_ORDER.map((context) => {
    const contextCases = testCases.filter((entry) => entry.context === context);
    const contextAligned = context === 'Diff Level';
    return [context, {
      cases: contextCases.length,
      modelCompleted: contextCases.filter((entry) => {
        const result = matchedRows.get(entry.id);
        return result?.status === 'completed' && ['CONFIRM', 'REFUTE'].includes(result.verdict);
      }).length,
      comparableCases: contextAligned ? contextCases.length : 0,
      scoredCompleted: contextAligned ? contextCases.filter((entry) => {
        const result = matchedRows.get(entry.id);
        return result?.contextQualification === 'aligned_diff_only'
          && result?.status === 'completed' && ['CONFIRM', 'REFUTE'].includes(result.verdict);
      }).length : null,
      correctDecisions: contextAligned ? contextCases.filter((entry) => {
        const result = matchedRows.get(entry.id);
        return result?.contextQualification === 'aligned_diff_only'
          && result?.status === 'completed'
          && result.verdict === (entry.reference.expectedLabel === 1 ? 'CONFIRM' : 'REFUTE');
      }).length : null,
      contextQualification: contextAligned ? 'diff_only_adapter_matches' : 'not_comparable_context_not_provided',
      abstained: contextCases.filter((entry) => matchedRows.get(entry.id)?.verdict === 'ABSTAIN').length,
    }];
  }));
  return {
    schemaVersion: 'review-yeti-verification-score-v1',
    task: 'comment-verification',
    cases: testCases.length,
    completed: testCases.filter((entry) => {
      const result = matchedRows.get(entry.id);
      return result?.contextQualification === 'aligned_diff_only'
        && result?.status === 'completed' && ['CONFIRM', 'REFUTE'].includes(result.verdict);
    }).length,
    modelCompleted: results.filter((entry) => entry.status === 'completed' && ['CONFIRM', 'REFUTE'].includes(entry.verdict)).length,
    servingIdentity: 'unverified',
    positiveReference: labels,
    negativeReference: negatives,
    byContext,
    note: 'Selective agreement is shown separately from abstention; AACR labels do not measure discovery completeness or severity.',
  };
}

function locationOverlap(finding, reference) {
  if (String(finding?.path || '') !== String(reference?.path || '')) return false;
  const line = Number(finding?.line);
  const start = Number(reference?.from_line ?? reference?.line);
  const end = Number(reference?.to_line ?? reference?.endLine ?? start);
  if (!Number.isSafeInteger(line) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return false;
  return line >= Math.min(start, end) - 2 && line <= Math.max(start, end) + 2;
}

/**
 * Discovery scoring exposes only reference-anchor recall. Unmatched generated findings stay
 * unjudged, and precision stays null until independent adjudication rows are supplied.
 */
export function scoreDiscoveryCases(rows, manifest, adjudicationBundle = null) {
  const correctReferences = rows.filter((row) => row.label === 1);
  const generatedFindings = rows.flatMap((row) => (Array.isArray(row.findings) ? row.findings : []));
  const matched = correctReferences.filter((reference) => generatedFindings.some((finding) => locationOverlap(finding, reference)));
  const adjudicationRows = Array.isArray(adjudicationBundle?.judgments) ? adjudicationBundle.judgments : [];
  const adjudicationCounts = {
    valid: adjudicationRows.filter((entry) => entry.verdict === 'valid').length,
    invalid: adjudicationRows.filter((entry) => entry.verdict === 'invalid').length,
    unresolved: adjudicationRows.filter((entry) => entry.verdict === 'unresolved').length,
  };
  const adjudicated = adjudicationCounts.valid + adjudicationCounts.invalid;
  const judgeIdentity = adjudicationBundle?.judge || null;
  const findingIds = generatedFindings.map((finding) => finding.id).filter((id) => typeof id === 'string' && id.length > 0);
  const judgmentIds = adjudicationRows.map((entry) => entry.findingId);
  const generatedIdCounts = new Map();
  for (const id of findingIds) generatedIdCounts.set(id, (generatedIdCounts.get(id) || 0) + 1);
  const uniquelyIdentifiedFindings = new Set([...generatedIdCounts]
    .filter(([, count]) => count === 1).map(([id]) => id));
  const judgmentsByFindingId = new Map();
  for (const entry of adjudicationRows) {
    if (!uniquelyIdentifiedFindings.has(entry.findingId)) continue;
    if (!judgmentsByFindingId.has(entry.findingId)) judgmentsByFindingId.set(entry.findingId, []);
    judgmentsByFindingId.get(entry.findingId).push(entry);
  }
  const adjudicatedSubset = [...judgmentsByFindingId.values()]
    .filter((entries) => entries.length === 1 && ['valid', 'invalid'].includes(entries[0].verdict))
    .map((entries) => entries[0]);
  const adjudicatedSubsetValid = adjudicatedSubset.filter((entry) => entry.verdict === 'valid').length;
  const adjudicatedSubsetDenominator = adjudicatedSubset.length;
  const completeAdjudication = generatedFindings.length > 0
    && findingIds.length === generatedFindings.length
    && new Set(findingIds).size === findingIds.length
    && adjudicationRows.length === generatedFindings.length
    && adjudicated === adjudicationRows.length
    && new Set(judgmentIds).size === adjudicationRows.length
    && judgmentIds.every((id) => findingIds.includes(id))
    && findingIds.every((id) => judgmentIds.includes(id))
    && adjudicationRows.every((entry) => ['valid', 'invalid'].includes(entry.verdict));
  const judgeIdentityPresent = judgeIdentity?.kind === 'independent_human'
    ? typeof judgeIdentity.protocolId === 'string' && judgeIdentity.protocolId.trim().length > 0
    : judgeIdentity?.kind === 'independent_model'
      && typeof judgeIdentity.requestedModel === 'string'
      && typeof judgeIdentity.responseReportedModel === 'string'
      && judgeIdentity.requestedModel !== judgeIdentity.responseReportedModel;
  const adjudicatedSubsetPrecision = adjudicatedSubsetDenominator
    ? adjudicatedSubsetValid / adjudicatedSubsetDenominator : null;
  const adjudicatedSubsetPrecision95 = adjudicatedSubsetDenominator
    ? wilsonInterval(adjudicatedSubsetValid, adjudicatedSubsetDenominator) : null;
  const qualifiedPrecision = completeAdjudication && judgeIdentityPresent
    ? adjudicationCounts.valid / generatedFindings.length : null;
  const qualifiedPrecision95 = completeAdjudication && judgeIdentityPresent
    ? wilsonInterval(adjudicationCounts.valid, generatedFindings.length) : null;
  return {
    schemaVersion: 'review-yeti-discovery-score-v1',
    task: 'discovery',
    benchmark: AACR_BENCHMARK.name,
    sourceRevision: manifest.sourceRevision,
    pullRequests: manifest.cases.length,
    positiveReferenceComments: correctReferences.length,
    locationMatches: matched.length,
    referenceAnchorRecall: correctReferences.length ? matched.length / correctReferences.length : null,
    referenceAnchorRecall95: wilsonInterval(matched.length, correctReferences.length),
    generatedFindingCount: generatedFindings.length,
    independentlyAdjudicated: adjudicationRows.length,
    adjudicationCounts,
    precision: qualifiedPrecision,
    precision95: qualifiedPrecision95,
    adjudicatedSubsetPrecision,
    adjudicatedSubsetPrecision95,
    adjudicatedSubsetPrecisionDenominator: adjudicatedSubsetDenominator,
    unjudgedGeneratedFindingCount: Math.max(0, generatedFindings.length - adjudicatedSubsetDenominator),
    judgeIdentity: judgeIdentity ? {
      kind: judgeIdentity.kind,
      protocolId: judgeIdentity.kind === 'independent_human' ? judgeIdentity.protocolId : undefined,
      requestedModel: judgeIdentity.kind === 'independent_model' ? judgeIdentity.requestedModel : undefined,
      responseReportedModel: judgeIdentity.kind === 'independent_model' ? judgeIdentity.responseReportedModel : undefined,
    } : null,
    qualified: completeAdjudication && judgeIdentityPresent,
    qualificationReason: !judgeIdentityPresent
      ? 'independent_judge_or_identity_absent'
      : !completeAdjudication ? 'independent_judgment_incomplete' : null,
    note: 'Reference-anchor recall is not exhaustive discovery recall. Unmatched findings are unjudged and are not counted as false positives. Correct-comment labels do not imply P0/P1 severity.',
  };
}

/** The CLI scorer must never turn a transport smoke into a quality statistic. */
export function assertDiscoveryRunEligible(run) {
  if (run?.executionPurpose !== 'paired_heldout_evaluation') {
    throw new Error('discovery_runtime_run_not_quality_eligible');
  }
  if (run?.qualification !== 'eligible_for_independent_adjudication'
    || !run?.completion?.allRuntimeReceiptsComplete
    || !Number.isSafeInteger(run?.panelSize)
    || run?.cases?.length !== run.panelSize
    || run?.completion?.completed !== run.panelSize) {
    throw new Error('discovery_runtime_evaluation_incomplete');
  }
  requirePreparedInputReceipt(run);
}

function manifestCaseIds(manifest) {
  const supportedSchemas = new Set([
    'review-yeti-competitive-benchmark-manifest-v1',
    'review-yeti-ws5-heldout-manifest-v1',
  ]);
  if (!manifest || !supportedSchemas.has(manifest.schemaVersion)
    || manifest.datasetSha256 !== AACR_BENCHMARK.sha256 || !Array.isArray(manifest.cases)) {
    throw new Error('benchmark manifest is incompatible with the pinned AACR dataset');
  }
  if (manifest.schemaVersion === 'review-yeti-ws5-heldout-manifest-v1'
    && manifest.cases.some((entry) => !HASH_RE.test(String(entry.datasetBaseSha || ''))
      || !HASH_RE.test(String(entry.diffBaseSha || ''))
      || !HASH_RE.test(String(entry.mergeBaseSha || ''))
      || !HASH_RE.test(String(entry.headSha || ''))
      || entry.baseSha !== entry.diffBaseSha
      || entry.diffBaseSha !== entry.mergeBaseSha)) {
    throw new Error('ws5_manifest_dataset_and_diff_identities_must_be_bound_separately');
  }
  return new Set(manifest.cases.map((entry) => `${entry.repository}#${entry.prNumber}`));
}

function parseHeldoutManifestBytes(bytes) {
  const raw = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  let manifest;
  try {
    manifest = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error('benchmark manifest is not valid JSON');
  }
  manifestCaseIds(manifest);
  return { manifest, sha256: sha256(raw) };
}

export function assertCanonicalHeldoutManifestBytes(bytes) {
  const binding = parseHeldoutManifestBytes(bytes);
  const expectedSha = binding.manifest.schemaVersion === 'review-yeti-ws5-heldout-manifest-v1'
    ? WS5_AACR_MANIFEST_SHA256 : AACR_HELDOUT_MANIFEST_SHA256;
  if (binding.sha256 !== expectedSha) {
    throw new Error('heldout_manifest_digest_mismatch');
  }
  return binding;
}

export function assertExactCaseIdSet(actualCaseIds, expectedCaseIds) {
  if (!Array.isArray(actualCaseIds) || !Array.isArray(expectedCaseIds)
    || actualCaseIds.length !== expectedCaseIds.length
    || expectedCaseIds.some((caseId) => typeof caseId !== 'string')
    || new Set(actualCaseIds).size !== actualCaseIds.length
    || new Set(expectedCaseIds).size !== expectedCaseIds.length
    || actualCaseIds.some((caseId) => typeof caseId !== 'string' || !expectedCaseIds.includes(caseId))) {
    throw new Error('discovery_input_case_ids_do_not_match_fixed_panel');
  }
  return true;
}

function getRevisionRecords(rows, manifest) {
  const expectedIds = manifestCaseIds(manifest);
  return groupRowsByPr(rows).filter((group) => expectedIds.has(group.id));
}

function runGit(args, cwd, { binary = false, timeoutMs = 90_000 } = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: binary ? undefined : 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
      timeout: timeoutMs,
      env: safeGitEnvironment(),
    });
  } catch (error) {
    const stderr = String(error?.stderr || '').slice(0, 500);
    throw new Error(`public source checkout failed (${args[0] || 'git'}): ${stderr || 'git command failed'}`);
  }
}

function safeGitEnvironment() {
  return {
    ...Object.fromEntries(Object.entries(process.env)
      .filter(([name]) => !/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|GATEWAY|ENDPOINT|BASE_URL)/iu.test(name))),
    // Missing promisor objects must never trigger an unbounded, implicit network fetch from
    // cat-file/diff/show. The benchmark performs bounded explicit exact-commit fetches below.
    GIT_NO_LAZY_FETCH: '1',
  };
}

async function probePublicCommit(repository, sha) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(`https://api.github.com/repos/${repository}/commits/${sha}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'review-yeti-benchmark' },
      signal: controller.signal,
    });
    if (response.status === 200) return 'available';
    if (response.status === 404 || response.status === 422) return 'unavailable';
    return 'unknown';
  } catch {
    return 'unknown';
  } finally {
    clearTimeout(timeout);
  }
}

async function boundedResponseBytes(response, maxBytes, controller) {
  const announcedLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(announcedLength) && announcedLength > maxBytes) {
    controller.abort();
    throw new Error('public_source_byte_budget_exceeded');
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        controller.abort();
        throw new Error('public_source_byte_budget_exceeded');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function fetchPublicJson(repository, apiPath, maxBytes = MAX_GITHUB_JSON_BYTES, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`https://api.github.com/repos/${repository}/${apiPath}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'review-yeti-benchmark' },
      signal: controller.signal,
    });
    if (!response.ok) return { status: response.status, value: null };
    const bytes = await boundedResponseBytes(response, maxBytes, controller);
    return { status: response.status, value: JSON.parse(bytes.toString('utf8')) };
  } finally {
    clearTimeout(timeout);
  }
}

function githubGitBlobSha(bytes) {
  return crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

async function fetchPinnedRawText(repository, commitSha, filePath, expectedBlobSha, maxBytes = MAX_SOURCE_FILE_BYTES) {
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(`https://raw.githubusercontent.com/${repository}/${commitSha}/${encodedPath}`, {
      headers: { 'user-agent': 'review-yeti-benchmark' },
      signal: controller.signal,
    });
    if (!response.ok) return { status: 'unavailable', content: null };
    const bytes = await boundedResponseBytes(response, maxBytes, controller);
    if (githubGitBlobSha(bytes) !== expectedBlobSha) return { status: 'blob_identity_mismatch', content: null };
    if (bytes.includes(0)) return { status: 'binary', content: null };
    return { status: 'available', content: bytes.toString('utf8'), bytes: bytes.length };
  } catch (error) {
    return { status: String(error?.message || '').includes('byte_budget') ? 'file_byte_limit' : 'fetch_failed', content: null };
  } finally {
    clearTimeout(timeout);
  }
}

function treeBlobIndex(treePayload) {
  if (!treePayload || !Array.isArray(treePayload.tree)) return { index: null, paths: [], truncated: true };
  const entries = treePayload.tree.filter((entry) => entry?.type === 'blob'
    && typeof entry.path === 'string' && /^[a-f0-9]{40}$/iu.test(String(entry.sha || '')));
  const index = Object.fromEntries(entries.map((entry) => [entry.path, entry.sha]));
  return { index, paths: entries.map((entry) => entry.path), truncated: treePayload.truncated === true };
}

async function loadPublicPrSnapshotViaApi(prCase, sourceRepoDir) {
  const deadline = Date.now() + 90_000;
  try {
    const [baseCommit, headCommit] = await Promise.all([
      fetchPublicJson(prCase.repository, `git/commits/${prCase.baseSha}`, 2 * 1024 * 1024),
      fetchPublicJson(prCase.repository, `git/commits/${prCase.headSha}`, 2 * 1024 * 1024),
    ]);
    const baseTreeSha = baseCommit.value?.tree?.sha;
    const headTreeSha = headCommit.value?.tree?.sha;
    if (baseCommit.status !== 200 || headCommit.status !== 200
      || !HASH_RE.test(String(baseTreeSha || '')) || !HASH_RE.test(String(headTreeSha || ''))) {
      return null;
    }
    const [baseTree, headTree] = await Promise.all([
      fetchPublicJson(prCase.repository, `git/trees/${baseTreeSha}?recursive=1`, MAX_GITHUB_JSON_BYTES, 12_000),
      fetchPublicJson(prCase.repository, `git/trees/${headTreeSha}?recursive=1`, MAX_GITHUB_JSON_BYTES, 12_000),
    ]);
    if (baseTree.status !== 200 || headTree.status !== 200) return null;
    const base = treeBlobIndex(baseTree.value);
    const head = treeBlobIndex(headTree.value);
    if (!base.index || !head.index || base.paths.length > MAX_TREE_ENTRIES_API || head.paths.length > MAX_TREE_ENTRIES_API) {
      return null;
    }
    const allPaths = [...new Set([...Object.keys(base.index), ...Object.keys(head.index)])].sort();
    const changedPaths = allPaths.filter((filePath) => base.index[filePath] !== head.index[filePath]);
    const omissions = [];
    if (base.truncated || head.truncated) omissions.push('repository_tree_truncated');
    if (changedPaths.length > MAX_CHANGED_FILES_API) {
      return { repository: prCase.repository, baseSha: prCase.baseSha, headSha: prCase.headSha,
        changedFiles: [], omissions: [...omissions, 'changed_file_count_budget_exceeded'], sourceRepoDir,
        sourceAdapter: 'github_exact_commit_trees_and_raw_blobs' };
    }
    let sourceBytes = 0;
    const patchBuilder = require('diff').createTwoFilesPatch;
    const changedFiles = [];
    for (let index = 0; index < changedPaths.length; index += 1) {
      if (Date.now() > deadline) {
        omissions.push('source_lookup_time_budget_exceeded');
        break;
      }
      const filePath = changedPaths[index];
      if (!filePath || filePath.includes('\0') || filePath.includes('\n')
        || filePath.startsWith('/') || filePath.split('/').some((part) => part === '.' || part === '..')) {
        omissions.push('unsupported_source_path');
        continue;
      }
      const baseBlobSha = base.index[filePath] || null;
      const headBlobSha = head.index[filePath] || null;
      let baseContent = '';
      let content;
      if (baseBlobSha) {
        const result = await fetchPinnedRawText(prCase.repository, prCase.baseSha, filePath, baseBlobSha);
        if (result.status !== 'available') {
          omissions.push(result.status === 'binary' ? 'binary_patch' : `base_blob_${result.status}`);
          continue;
        }
        baseContent = result.content;
        sourceBytes += result.bytes;
      }
      if (headBlobSha) {
        const result = await fetchPinnedRawText(prCase.repository, prCase.headSha, filePath, headBlobSha);
        if (result.status !== 'available') {
          omissions.push(result.status === 'binary' ? 'binary_patch' : `head_blob_${result.status}`);
          continue;
        }
        content = result.content;
        sourceBytes += result.bytes;
      }
      if (sourceBytes > MAX_SOURCE_CASE_BYTES) {
        omissions.push('changed_source_byte_budget_exceeded');
        break;
      }
      const rawPatch = patchBuilder(`a/${filePath}`, `b/${filePath}`, baseContent, content || '', '', '', { context: 5 });
      const patch = `diff --git a/${filePath} b/${filePath}\n${rawPatch}`;
      changedFiles.push({ path: filePath, patch, content, baseContent: baseBlobSha ? baseContent : undefined,
        originalPatchLength: Buffer.byteLength(patch, 'utf8'), baseBlobSha, headBlobSha });
    }
    return {
      repository: prCase.repository,
      baseSha: prCase.baseSha,
      headSha: prCase.headSha,
      changedFiles,
      omissions: [...new Set(omissions)],
      sourceRepoDir,
      sourceAdapter: 'github_exact_commit_trees_and_raw_blobs',
      sourceTreeIndex: { base: base.index, head: head.index },
      repositoryPaths: head.paths,
      treeTruncated: base.truncated || head.truncated,
      sourceBytes,
    };
  } catch (error) {
    if (String(error?.message || '').includes('byte_budget')) return {
      repository: prCase.repository, baseSha: prCase.baseSha, headSha: prCase.headSha,
      changedFiles: [], omissions: ['source_tree_byte_budget_exceeded'], sourceRepoDir,
      sourceAdapter: 'github_exact_commit_trees_and_raw_blobs',
    };
    return null;
  }
}

function pathInTree(repoDir, sha, filePath) {
  try {
    runGit(['cat-file', '-e', `${sha}:${filePath}`], repoDir);
    return true;
  } catch {
    return false;
  }
}

/** Prove a prepared Git-backed case still resolves to its exact public repository and pins. */
export function preflightPinnedGitSnapshot(prCase, repoDir) {
  if (!repoDir || !fs.existsSync(path.join(repoDir, '.git'))) {
    throw new Error('pinned_source_cache_unavailable');
  }
  const baseSha = String(prCase?.baseSha || '').toLowerCase();
  const headSha = String(prCase?.headSha || '').toLowerCase();
  if (!HASH_RE.test(baseSha) || !HASH_RE.test(headSha)) throw new Error('pinned_source_reference_unavailable');
  for (const sha of [baseSha, headSha]) {
    try {
      if (runGit(['rev-parse', '--verify', `${sha}^{commit}`], repoDir).trim().toLowerCase() !== sha) {
        throw new Error('pinned_source_reference_unavailable');
      }
    } catch {
      throw new Error('pinned_source_reference_unavailable');
    }
  }
  let origin;
  try { origin = runGit(['remote', 'get-url', 'origin'], repoDir).trim(); }
  catch { throw new Error('pinned_source_repository_mismatch'); }
  let originRepository = '';
  try {
    const parsed = new URL(origin);
    if (parsed.hostname.toLowerCase() === 'github.com') originRepository = parsed.pathname.replace(/^\//u, '').replace(/\.git$/iu, '');
  } catch {
    const ssh = origin.match(/^git@github\.com:(.+?)(?:\.git)?$/iu);
    if (ssh) originRepository = ssh[1];
  }
  if (originRepository.toLowerCase() !== String(prCase?.repository || '').toLowerCase()) {
    throw new Error('pinned_source_repository_mismatch');
  }

  const changedFiles = Array.isArray(prCase?.changedFiles) ? prCase.changedFiles : [];
  const safePath = (value) => typeof value === 'string' && value.length > 0
    && !value.startsWith('/') && !value.split('/').some((part) => part === '..' || part === '.');
  if (changedFiles.some((file) => !safePath(file?.path) || typeof file?.patch !== 'string')) {
    throw new Error('pinned_source_changed_paths_mismatch');
  }
  let changedPaths;
  let basePaths;
  let headPaths;
  try {
    changedPaths = runGit(['diff', '--name-only', '-z', baseSha, headSha], repoDir).split('\0').filter(Boolean);
    basePaths = new Set(runGit(['ls-tree', '-r', '--name-only', '-z', baseSha], repoDir).split('\0').filter(Boolean));
    headPaths = new Set(runGit(['ls-tree', '-r', '--name-only', '-z', headSha], repoDir).split('\0').filter(Boolean));
  } catch {
    throw new Error('pinned_source_tree_unavailable');
  }
  const suppliedPaths = changedFiles.map((file) => file.path);
  if (new Set(suppliedPaths).size !== suppliedPaths.length || changedPaths.length !== suppliedPaths.length
    || changedPaths.some((filePath) => !suppliedPaths.includes(filePath))) {
    throw new Error('pinned_source_changed_paths_mismatch');
  }
  let addedFileCount = 0;
  let deletedFileCount = 0;
  const patchRows = [];
  for (const file of changedFiles) {
    let exactPatch;
    try {
      exactPatch = runGit(['-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--full-index', '--unified=5',
        baseSha, headSha, '--', file.path], repoDir);
    } catch {
      throw new Error('pinned_source_diff_unavailable');
    }
    if (exactPatch !== file.patch) throw new Error('pinned_source_diff_mismatch');
    const basePresent = basePaths.has(file.path);
    const headPresent = headPaths.has(file.path);
    if (!basePresent && !headPresent) throw new Error('pinned_source_changed_paths_mismatch');
    if (!basePresent && headPresent) addedFileCount += 1;
    if (basePresent && !headPresent) deletedFileCount += 1;
    if (file.content !== undefined) {
      if (!headPresent) throw new Error('pinned_source_blob_mismatch');
      let exactContent;
      try { exactContent = runGit(['show', `${headSha}:${file.path}`], repoDir); }
      catch { throw new Error('pinned_source_blob_unavailable'); }
      if (exactContent !== file.content) throw new Error('pinned_source_blob_mismatch');
    }
    patchRows.push([file.path, sha256(file.patch)]);
  }
  patchRows.sort(([left], [right]) => left.localeCompare(right));
  return { status: 'verified', baseSha, headSha, changedFileCount: changedFiles.length,
    addedFileCount, deletedFileCount, patchSetSha256: sha256(JSON.stringify(patchRows)) };
}

/** Validate the local source adapter before entering the model-backed runtime. */
export function preflightDiscoveryCaseSource(snapshot, repoDir, prCase = snapshot) {
  const sourceAdapter = snapshot?.sourceAdapter;
  if (sourceAdapter === 'pinned_git_objects') {
    try {
      return { sourceAdapter, ...preflightPinnedGitSnapshot({
        ...prCase,
        repository: snapshot.repository,
        baseSha: snapshot.baseSha,
        headSha: snapshot.headSha,
        changedFiles: snapshot.changedFiles,
      }, repoDir), immutableSourceRechecked: true };
    } catch (error) {
      const rawReason = String(error?.message || 'source_preflight_failed');
      const reason = /^[a-z0-9_]+$/u.test(rawReason) ? rawReason : 'source_preflight_failed';
      return { status: 'failed', sourceAdapter, reason, immutableSourceRechecked: true };
    }
  }
  if (sourceAdapter === 'github_exact_commit_trees_and_raw_blobs') {
    const identityMatches = snapshot.repository === prCase?.repository
      && snapshot.baseSha === prCase?.baseSha && snapshot.headSha === prCase?.headSha;
    const treesAvailable = snapshot.sourceTreeIndex?.base && snapshot.sourceTreeIndex?.head
      && typeof snapshot.sourceTreeIndex.base === 'object' && typeof snapshot.sourceTreeIndex.head === 'object';
    if (!identityMatches || !treesAvailable || !Array.isArray(snapshot.changedFiles)) {
      return { status: 'failed', sourceAdapter, reason: 'prepared_api_snapshot_incomplete', immutableSourceRechecked: false };
    }
    // API-backed bytes are trusted only as part of the digest-bound, preparer-produced local
    // artifact. This run-stage check does not independently refetch or attest that snapshot.
    return { status: 'prepared_input_only', sourceAdapter, immutableSourceRechecked: false };
  }
  return { status: 'failed', sourceAdapter: sourceAdapter || 'unknown', reason: 'source_adapter_unavailable',
    immutableSourceRechecked: false };
}

/**
 * Fetch exact public base/head Git objects and read their patch without checking out or executing
 * source files. Source paths and untrusted text are returned as data only.
 */
export async function loadPublicPrSnapshot(prCase, cacheRoot) {
  if (!HASH_RE.test(prCase.baseSha) || !HASH_RE.test(prCase.headSha)) throw new Error('invalid pinned base/head SHA');
  const safeRepo = prCase.repository.replace(/[^A-Za-z0-9._-]+/gu, '__');
  const repoDir = path.resolve(cacheRoot, safeRepo);
  const missingPins = [];
  if (fs.existsSync(path.join(repoDir, '.git'))) {
    for (const [label, sha] of [['base', prCase.baseSha], ['head', prCase.headSha]]) {
      try { runGit(['cat-file', '-e', `${sha}^{commit}`], repoDir, { timeoutMs: 5_000 }); }
      catch { missingPins.push([label, sha]); }
    }
  } else {
    missingPins.push(['base', prCase.baseSha], ['head', prCase.headSha]);
  }
  // Probe exact immutable IDs before cloning a repository. A lost SHA must not trigger a large
  // default-branch download or be silently replaced by a current PR ref.
  for (const [label, sha] of missingPins) {
    const availability = await probePublicCommit(prCase.repository, sha);
    if (availability === 'unavailable') {
      return { repository: prCase.repository, baseSha: prCase.baseSha, headSha: prCase.headSha,
        changedFiles: [], omissions: [`pinned_${label}_commit_unavailable`], sourceRepoDir: repoDir };
    }
  }
  try {
    fs.mkdirSync(cacheRoot, { recursive: true });
    if (!fs.existsSync(path.join(repoDir, '.git'))) {
      runGit(['init', '--quiet', repoDir], process.cwd(), { timeoutMs: 5_000 });
      runGit(['remote', 'add', 'origin', `https://github.com/${prCase.repository}.git`], repoDir, { timeoutMs: 5_000 });
    }
    for (const [label, sha] of [['base', prCase.baseSha], ['head', prCase.headSha]]) {
      try {
        runGit(['cat-file', '-e', `${sha}^{commit}`], repoDir, { timeoutMs: 5_000 });
      } catch {
        try {
          runGit(['fetch', '--quiet', '--no-tags', '--filter=blob:limit=1048576', '--depth=1', 'origin', sha], repoDir, { timeoutMs: 30_000 });
        } catch {
          const apiSnapshot = await loadPublicPrSnapshotViaApi(prCase, repoDir);
          if (apiSnapshot) return apiSnapshot;
          return { repository: prCase.repository, baseSha: prCase.baseSha, headSha: prCase.headSha,
            changedFiles: [], omissions: [`pinned_${label}_fetch_failed_or_timed_out`], sourceRepoDir: repoDir };
        }
      }
    }
  } catch {
    const apiSnapshot = await loadPublicPrSnapshotViaApi(prCase, repoDir);
    if (apiSnapshot) return apiSnapshot;
    return { repository: prCase.repository, baseSha: prCase.baseSha, headSha: prCase.headSha,
      changedFiles: [], omissions: ['public_source_fetch_failed'], sourceRepoDir: repoDir };
  }
  const statusRaw = runGit(['diff', '--name-status', '-z', prCase.baseSha, prCase.headSha], repoDir);
  const fields = statusRaw.split('\0').filter((value, index, all) => value !== '' || index < all.length - 1);
  const entries = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (/^[RC]\d+$/u.test(status)) {
      index += 1;
      entries.push({ status, path: fields[index++] });
    } else {
      entries.push({ status, path: fields[index++] });
    }
  }
  const changedFiles = [];
  const omissions = [];
  for (const entry of entries) {
    if (!entry.path || entry.path.includes('\0') || entry.path.includes('\n')) {
      omissions.push('unsupported_path');
      continue;
    }
    let patch;
    try {
      patch = runGit(['-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--unified=5',
        prCase.baseSha, prCase.headSha, '--', entry.path], repoDir, { timeoutMs: 30_000 });
    } catch {
      omissions.push('patch_object_unavailable_or_timed_out');
      continue;
    }
    if (!patch || !patch.startsWith('diff --git ')) {
      omissions.push('patch_unavailable');
      continue;
    }
    const content = entry.status.startsWith('D') || !pathInTree(repoDir, prCase.headSha, entry.path)
      ? undefined
      : runGit(['show', `${prCase.headSha}:${entry.path}`], repoDir, { timeoutMs: 30_000 });
    if (patch.includes('GIT binary patch') || patch.includes('Binary files ')) omissions.push('binary_patch');
    changedFiles.push({
      path: entry.path,
      patch,
      ...(content === undefined ? {} : { content }),
      originalPatchLength: Buffer.byteLength(patch, 'utf8'),
    });
  }
  const baseSha = String(runGit(['rev-parse', `${prCase.baseSha}^{commit}`], repoDir, { timeoutMs: 5_000 })).trim();
  const headSha = String(runGit(['rev-parse', `${prCase.headSha}^{commit}`], repoDir, { timeoutMs: 5_000 })).trim();
  const localSnapshot = { repository: prCase.repository, baseSha, headSha, changedFiles, omissions, sourceRepoDir: repoDir,
    sourceAdapter: 'pinned_git_objects' };
  if (omissions.some((entry) => entry !== 'binary_patch')) {
    const apiSnapshot = await loadPublicPrSnapshotViaApi(prCase, repoDir);
    if (apiSnapshot && (apiSnapshot.omissions.length < omissions.length
      || (apiSnapshot.omissions.length === omissions.length && apiSnapshot.changedFiles.length > changedFiles.length))) {
      return apiSnapshot;
    }
  }
  return localSnapshot;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function readPreparedInput(filePath) {
  const bytes = fs.readFileSync(filePath);
  return { value: JSON.parse(bytes.toString('utf8')), sha256: sha256(bytes) };
}

function requirePreparedInputDigest(value) {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) {
    throw new Error('run_missing_prepared_input_digest');
  }
  return value;
}

function requirePreparedInputReceipt(run) {
  const digest = requirePreparedInputDigest(run?.preparedInputSha256);
  if (run?.sourceSnapshotVerification !== SOURCE_SNAPSHOT_VERIFICATION) {
    throw new Error('run_source_verification_boundary_missing');
  }
  return digest;
}

function writeJson(filePath, payload) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}

export function assertActualModelConfig(pipeline, { transportName = '', transportEnv = process.env } = {}) {
  const config = pipeline.resolveModelConfig(transportEnv);
  const transports = Array.isArray(config.transports) ? config.transports : [];
  if (!config.enabled || transports.length === 0) {
    throw new Error('actual_model_credentials_unavailable');
  }
  const matches = transportName
    ? transports.filter((entry) => String(entry.name || entry.provider || '') === transportName)
    : transports;
  if (matches.length === 0) throw new Error('requested_actual_transport_unavailable');
  if (matches.length !== 1) throw new Error('select_one_actual_transport_to_prevent_fallback');
  const selected = matches[0];
  if (!selected.apiKey) throw new Error('actual_model_credentials_unavailable');
  if (String(selected.name || selected.provider).toLowerCase() === 'synthetic') {
    throw new Error('synthetic_provider_forbidden_for_qualification');
  }
  let selectedTransport = { ...selected };
  let safeConfig = { ...config, apiKey: '' };
  if (transportEnv.WS5_LOOPBACK_BROKER === '1') {
    let loopbackUrl;
    try { loopbackUrl = new URL(transportEnv.OPENROUTER_BASE_URL || ''); }
    catch { throw new Error('ws5_loopback_route_required'); }
    const localToken = transportEnv.OPENROUTER_API_KEY || '';
    if (loopbackUrl.protocol !== 'https:' || loopbackUrl.hostname !== '127.0.0.1' || !loopbackUrl.port
      || loopbackUrl.username || loopbackUrl.password || loopbackUrl.search || loopbackUrl.hash
      || localToken.length < 32) throw new Error('ws5_loopback_route_required');
    for (const key of ['apiKey', 'api_key', 'token', 'accessToken', 'access_token', 'authorization',
      'headers', 'extraHeaders', 'defaultHeaders', 'customHeaders', 'auth', 'credentials', 'providerCredentials',
      'baseURL', 'url', 'endpoint', 'gatewayBaseUrl', 'serverURL', 'apiBaseUrl']) delete selectedTransport[key];
    selectedTransport.baseUrl = loopbackUrl.toString().replace(/\/+$/u, '');
    selectedTransport.apiKey = localToken;
    for (const key of ['token', 'accessToken', 'access_token', 'authorization',
      'headers', 'extraHeaders', 'defaultHeaders', 'customHeaders', 'auth', 'credentials', 'providerCredentials',
      'baseURL', 'url', 'endpoint', 'gatewayBaseUrl', 'serverURL', 'apiBaseUrl']) delete safeConfig[key];
    safeConfig.apiKey = '';
    safeConfig.baseUrl = selectedTransport.baseUrl;
  }
  return {
    ...safeConfig,
    transports: [selectedTransport],
    selectedTransport: {
      name: safeRuntimeId(selected.name || selected.provider || 'unknown', 120),
      requestedModel: safeRuntimeId(selected.model || config.model || 'unknown'),
    },
  };
}

/** Resolve and attest the real pinned transport config without making a model call. */
export function preflightActualLoopbackTransport(pipeline, { expectedModel = 'pr-reviewer', transportEnv = process.env } = {}) {
  const localUrl = transportEnv.OPENROUTER_BASE_URL || '';
  const localToken = transportEnv.OPENROUTER_API_KEY || '';
  const gatewayUrl = transportEnv.REVIEW_YETI_GATEWAY_BASE_URL || '';
  const gatewayToken = transportEnv.REVIEW_YETI_BIFROST_API_KEY || '';
  const caPath = transportEnv.NODE_EXTRA_CA_CERTS || '';
  const forbiddenPlan = transportEnv.REVIEW_YETI_TRANSPORTS || transportEnv.REVIEW_YETI_TRANSPORT_PLAN_B64;
  const allowedCredentialNames = new Set(['OPENROUTER_API_KEY', 'REVIEW_YETI_BIFROST_API_KEY']);
  const inactiveProviderCredentialCount = Object.keys(transportEnv).filter((name) =>
    /(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/iu.test(name) && !allowedCredentialNames.has(name)).length;
  let caBytes;
  try {
    if (!path.isAbsolute(caPath) || !fs.statSync(caPath).isFile()) throw new Error('invalid_ca_path');
    caBytes = fs.readFileSync(caPath);
  } catch { throw new Error('ws5_transport_preflight_ca_certificate_invalid'); }
  const caText = caBytes.toString('ascii');
  if (!caText.includes('-----BEGIN CERTIFICATE-----') || !caText.includes('-----END CERTIFICATE-----')
    || caText.includes('PRIVATE KEY')) throw new Error('ws5_transport_preflight_ca_certificate_invalid');
  let endpoint;
  try { endpoint = new URL(localUrl); } catch { throw new Error('ws5_transport_preflight_loopback_invalid'); }
  if (transportEnv.WS5_LOOPBACK_BROKER !== '1' || endpoint.protocol !== 'https:'
    || endpoint.hostname !== '127.0.0.1' || !endpoint.port || endpoint.username || endpoint.password
    || endpoint.search || endpoint.hash || gatewayUrl !== localUrl || !localToken || gatewayToken !== localToken
    || localToken.length < 32 || forbiddenPlan || inactiveProviderCredentialCount > 0
    || transportEnv.OPENROUTER_MODEL !== expectedModel || transportEnv.REVIEW_TRANSPORT_DESTINATION !== 'gateway') {
    throw new Error('ws5_transport_preflight_loopback_invalid');
  }
  const modelConfig = assertActualModelConfig(pipeline, { transportEnv });
  const selected = modelConfig.transports[0];
  const selectedUrl = new URL(selected.baseUrl);
  if (modelConfig.transports.length !== 1 || selectedUrl.protocol !== 'https:'
    || selectedUrl.hostname !== '127.0.0.1' || selectedUrl.port !== endpoint.port
    || selected.apiKey !== localToken || selected.model !== expectedModel
    || modelConfig.selectedTransport.requestedModel !== expectedModel
    || selected.compat !== 'openrouter' || selected.stream !== true) {
    throw new Error('ws5_transport_preflight_profile_mismatch');
  }
  return {
    schemaVersion: 'ReviewYetiWS5TransportPreflight.v2',
    status: 'ready_without_model_call',
    modelCalls: 0,
    transportName: modelConfig.selectedTransport.name,
    requestedModel: modelConfig.selectedTransport.requestedModel,
    modelConfigDefaults: {
      source: 'pipeline.resolveModelConfig',
      transportName: modelConfig.selectedTransport.name,
      requestedModel: modelConfig.selectedTransport.requestedModel,
      provider: typeof selected.provider === 'string' ? safeRuntimeId(selected.provider, 80) : null,
      compat: selected.compat,
      stream: selected.stream,
      maxTokens: Number.isSafeInteger(selected.maxTokens) ? selected.maxTokens : null,
      timeoutMs: Number.isSafeInteger(selected.timeoutMs) ? selected.timeoutMs : null,
      reasoningEffort: typeof selected.reasoningEffort === 'string'
        ? safeRuntimeId(selected.reasoningEffort, 32) : null,
    },
    loopbackOnly: true,
    childTrust: 'NODE_EXTRA_CA_CERTS_public_certificate_only',
    inactiveProviderCredentialCount,
  };
}

/** @param {any} pipeline @param {{expectedModel?: string, transportEnv?: NodeJS.ProcessEnv}} options */
export function inspectActualLoopbackTransport(pipeline, { expectedModel = 'pr-reviewer', transportEnv = process.env } = {}) {
  const credentialNames = Object.keys(transportEnv).filter((name) =>
    /(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/iu.test(name));
  if (credentialNames.some((name) => !['OPENROUTER_API_KEY', 'REVIEW_YETI_BIFROST_API_KEY'].includes(name))) {
    throw new Error('ws5_transport_preflight_inactive_provider_credential');
  }
  const transportProfile = preflightActualLoopbackTransport(pipeline, { expectedModel, transportEnv });
  return transportProfile;
}

export function trackCompletion(fetchImplementation, identity) {
  return async (url, init) => {
    identity.localHttpRequestAttempts = (Number(identity.localHttpRequestAttempts) || 0) + 1;
    const localAttemptOrdinal = identity.localHttpRequestAttempts;
    const dispatchScope = completionDispatchScope.getStore();
    if (dispatchScope) dispatchScope.localAttemptOrdinals.push(localAttemptOrdinal);
    let request = {};
    try { request = JSON.parse(init?.body || '{}'); } catch {}
    if (typeof request.model === 'string') identity.requestedModels.add(safeRuntimeId(request.model));
    const profile = {
      model: safeRuntimeId(request.model || 'unknown'),
      reasoningEffort: request.reasoning_effort || request.reasoning?.effort || 'omitted',
      maxOutputTokens: Number.isSafeInteger(Number(request.max_tokens)) ? Number(request.max_tokens) : null,
      stream: request.stream === true,
      providerPreferencePresent: request.provider !== undefined,
    };
    const profileKey = JSON.stringify(profile);
    const previousProfile = identity.requestProfiles.get(profileKey);
    identity.requestProfiles.set(profileKey, { ...profile, count: (previousProfile?.count || 0) + 1 });
    const startedAt = Date.now();
    const attemptRecord = {
      localAttemptOrdinal,
      logicalDispatchOrdinal: dispatchScope?.logicalDispatchOrdinal ?? null,
      requestedModel: profile.model,
      reasoningEffort: profile.reasoningEffort,
      maxOutputTokens: profile.maxOutputTokens,
      stream: profile.stream,
      providerPreferencePresent: profile.providerPreferencePresent,
      gatewayRequestIdDigests: [],
      status: 'in_flight',
      httpStatus: null,
      failureClass: null,
      durationMs: null,
      responseReportedProviderHeader: null,
      responseReportedModelHeader: null,
      responseReportedModelBody: null,
    };
    if (!Array.isArray(identity.httpAttempts)) identity.httpAttempts = [];
    identity.httpAttempts.push(attemptRecord);
    let response;
    try {
      let requestInit = init;
      if (process.env.WS5_LOOPBACK_BROKER === '1') {
        const headers = new Headers(init?.headers || {});
        headers.set('x-ws5-local-attempt-ordinal', String(localAttemptOrdinal));
        if (dispatchScope) headers.set('x-ws5-logical-dispatch-ordinal', String(dispatchScope.logicalDispatchOrdinal));
        requestInit = { ...init, headers };
      }
      response = await fetchImplementation(url, requestInit);
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const code = String(error?.cause?.code || '').toUpperCase();
      const failureClass = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE'].includes(code)
        ? code : error?.name === 'AbortError' ? 'ABORTED' : error?.name === 'TimeoutError' ? 'TIMEOUT' : 'TRANSPORT_ERROR';
      attemptRecord.status = 'transport_error';
      attemptRecord.failureClass = failureClass;
      attemptRecord.durationMs = durationMs;
      identity.fetchToHeadersMs.push(durationMs);
      identity.fetchFailureClasses.add(failureClass);
      throw error;
    }
    const durationMs = Date.now() - startedAt;
    identity.fetchToHeadersMs.push(durationMs);
    attemptRecord.status = 'http_response';
    attemptRecord.httpStatus = response.status;
    attemptRecord.durationMs = durationMs;
    for (const name of ['x-bifrost-request-id', 'x-gateway-request-id', 'x-request-id']) {
      const requestId = response.headers.get(name);
      if (requestId) {
        const requestIdDigest = sha256(requestId).slice(0, 16);
        attemptRecord.gatewayRequestIdDigests.push(requestIdDigest);
        identity.requestIdDigests.add(requestIdDigest);
      }
    }
    for (const [name, destination] of [
      ['x-bifrost-provider', 'responseReportedProviderHeader'], ['x-provider', 'responseReportedProviderHeader'],
      ['x-provider-name', 'responseReportedProviderHeader'], ['x-bifrost-model', 'responseReportedModelHeader'],
      ['x-model', 'responseReportedModelHeader'],
    ]) {
      const routeHint = response.headers.get(name);
      if (routeHint) {
        attemptRecord[destination] ||= safeRuntimeId(routeHint, 120);
        identity.responseRouteHints.add(safeRuntimeId(routeHint, 120));
      }
    }
    if (!profile.stream) {
      // Capture buffered response metadata in the background. Never read or tee a live SSE body:
      // that would change backpressure, first-token timing, or the production client's stream.
      const metadataRead = response.clone().json().then((payload) => {
        if (typeof payload?.model === 'string' && payload.model.trim()) {
          attemptRecord.responseReportedModelBody = safeRuntimeId(payload.model);
          identity.responseModels.add(safeRuntimeId(payload.model));
        }
        const provider = payload?.provider || payload?.openrouter_metadata?.provider_name;
        if (typeof provider === 'string' && provider.trim()) identity.responseProviders.add(safeRuntimeId(provider));
      }).catch(() => {
        // The production caller owns error handling; missing identity remains unknown.
      });
      identity.pendingResponseMetadataReads.push(metadataRead);
    }
    identity.httpStatuses.push(response.status);
    return response;
  };
}

function safeCompletionFailureClass(error) {
  const code = String(error?.cause?.code || error?.code || '').toUpperCase();
  if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE'].includes(code)) return code;
  if (error?.name === 'AbortError') return 'ABORTED';
  if (error?.name === 'TimeoutError') return 'TIMEOUT';
  return 'COMPLETION_ERROR';
}

/** Attribute intercepted HTTP attempts to each logical model-client completion, including local failures. */
export async function trackLogicalCompletion(stage, dispatches, operation) {
  if (!['review', 'verifier', 'verification', 'alibaba'].includes(stage) || !Array.isArray(dispatches)
    || typeof operation !== 'function') throw new Error('logical_completion_instrumentation_invalid');
  const logicalDispatchOrdinal = dispatches.length + 1;
  const dispatch = { logicalDispatchOrdinal, stage, localAttemptOrdinals: [], outcome: 'in_progress', failureClass: null };
  dispatches.push(null);
  try {
    return await completionDispatchScope.run(dispatch, async () => {
      try {
        const value = await operation();
        dispatch.outcome = 'returned';
        return value;
      } catch (error) {
        dispatch.outcome = 'error';
        dispatch.failureClass = safeCompletionFailureClass(error);
        throw error;
      }
    });
  } finally {
    const localHttpRequestAttempts = dispatch.localAttemptOrdinals.length;
    dispatches[logicalDispatchOrdinal - 1] = { ...dispatch, localHttpRequestAttempts,
      ...(dispatch.outcome === 'error' && localHttpRequestAttempts === 0
      ? { classification: 'pre_http_dispatch_error' }
      : localHttpRequestAttempts === 0 ? { classification: 'returned_without_http_attempt' }
        : { classification: 'http_attempted' }) };
  }
}

export function identitySummary(identity) {
  const values = (set) => [...set].sort();
  const requestedModels = values(identity.requestedModels);
  const responseModels = values(identity.responseModels);
  const requestProfileAttemptCount = [...identity.requestProfiles.values()]
    .reduce((sum, profile) => sum + (Number(profile.count) || 0), 0);
  return {
    requestedModels,
    responseReportedModels: responseModels,
    responseReportedProviders: values(identity.responseProviders),
    responseRouteHints: values(identity.responseRouteHints),
    requestIdDigests: values(identity.requestIdDigests),
    httpAttempts: Array.isArray(identity.httpAttempts) ? identity.httpAttempts.map((entry) => ({ ...entry })) : [],
    fetchToHeadersMs: identity.fetchToHeadersMs,
    localHttpRequestAttempts: Number(identity.localHttpRequestAttempts) || 0,
    requestProfileAttemptCount,
    requestAttemptAccountingMatches: (Number(identity.localHttpRequestAttempts) || 0) === requestProfileAttemptCount,
    modelIdentity: responseModels.length === 0 ? 'unknown' : 'response_reported_unverified',
    fetchFailureClasses: values(identity.fetchFailureClasses),
    httpStatuses: identity.httpStatuses,
  };
}

/** Execute one real production verifier call. The adapter never serializes prompt, response, key, or endpoint. */
export async function runActualVerificationCase(testCase, snapshot, pipeline, {
  maxOutputTokens = 4096,
  transportName = '',
  falsification = null,
} = {}) {
  const caseId = testCase.caseId || testCase.id;
  const contextQualification = testCase.context === 'Diff Level'
    ? 'aligned_diff_only' : 'not_comparable_context_not_provided';
  const finding = testCase.finding || toVerifierInput(testCase).finding;
  const changedFiles = Array.isArray(snapshot.changedFiles) ? snapshot.changedFiles : [];
  const sourceOmissions = Array.isArray(snapshot.omissions) ? snapshot.omissions : [];
  if (changedFiles.length === 0) {
    return { caseId, context: testCase.context || 'unknown', contextQualification,
      status: 'incomplete', reason: sourceOmissions[0] || 'empty_diff', verdict: 'ABSTAIN', sourceOmissions };
  }
  if (sourceOmissions.length > 0) {
    return { caseId, context: testCase.context || 'unknown', contextQualification,
      status: 'incomplete', reason: 'source_coverage_incomplete', verdict: 'ABSTAIN', sourceOmissions };
  }
  const anchorFile = changedFiles.find((file) => file.path === finding.path);
  if (testCase.referencePathChanged === false || !anchorFile) {
    return { caseId, context: testCase.context || 'unknown', contextQualification,
      status: 'incomplete', reason: 'reference_path_not_changed', verdict: 'ABSTAIN', sourceOmissions };
  }
  const patchChars = changedFiles.reduce((total, file) => total + String(file.patch || '').length, 0);
  const modelConfig = assertActualModelConfig(pipeline, { transportName });
  const falsify = falsification || require('../src/review/findingFalsification.js');
  const identity = { requestedModels: new Set(), responseModels: new Set(), responseProviders: new Set(),
    responseRouteHints: new Set(), requestIdDigests: new Set(), fetchFailureClasses: new Set(),
    fetchToHeadersMs: [], httpStatuses: [], requestProfiles: new Map(), pendingResponseMetadataReads: [] };
  let logicalCompletionDispatches = 0;
  const dispatches = [];
  const result = await falsify.runFindingFalsification({
    findings: [finding],
    changedFiles,
    limits: { maxCandidates: 1, maxCalls: 1, concurrency: 1 },
    falsifyTurn: ({ messages, timeoutMs, signal }) => {
      logicalCompletionDispatches += 1;
      return trackLogicalCompletion('verification', dispatches, () => pipeline.callFalsificationModelTurn(
        { messages, timeoutMs, signal },
        { ...modelConfig, maxOutputTokens, fetchImplementation: trackCompletion(globalThis.fetch, identity) },
      ));
    },
  });
  const outcome = result.outcomes[0] || { verdict: 'ABSTAIN', reason: 'missing_outcome' };
  await Promise.allSettled(identity.pendingResponseMetadataReads);
  const requestIdentity = identitySummary(identity);
  return {
    caseId,
    context: testCase.context || 'unknown',
    contextQualification,
    status: ['CONFIRM', 'REFUTE'].includes(outcome.verdict) ? 'completed' : 'incomplete',
    verdict: outcome.verdict,
    reason: FALSIFICATION_REASON_CODES.has(outcome.reason) ? outcome.reason : 'other',
    patchChars,
    sourceOmissions,
    adapterLimitations: [
      'production_falsifier_receives_diff_only_no_file_or_repo_context',
      ...(patchChars > MAX_FALSIFICATION_DIFF_CHARS ? ['production_falsifier_anchor_first_truncates_diff_to_24000_chars'] : []),
    ],
    usage: result.receipt.usage,
    selectedTransport: modelConfig.selectedTransport,
    callAccounting: {
      logicalCompletionDispatches,
      localHttpRequestAttempts: requestIdentity.localHttpRequestAttempts,
      requestProfileAttemptCount: requestIdentity.requestProfileAttemptCount,
      requestAttemptAccountingMatches: requestIdentity.requestAttemptAccountingMatches,
      dispatches,
      dispatchAttemptAccountingMatches: dispatches.reduce((sum, dispatch) => sum + dispatch.localHttpRequestAttempts, 0)
        === requestIdentity.localHttpRequestAttempts,
      gatewayRelayCount: null,
      providerCompletionCount: null,
      billedRequestCount: null,
      costUsd: null,
    },
    requestProfiles: [...identity.requestProfiles.values()],
    ...requestIdentity,
  };
}

function arg(name, fallback = undefined, argv = process.argv) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

function hostExecutionIdentity(runtimeRoot) {
  const runnerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const runtimeRequire = createRequire(path.join(runtimeRoot, 'package.json'));
  const runnerFiles = [
    'scripts/competitive-review-benchmark.mjs',
    'scripts/ws5-acceptance.mjs',
    'scripts/ws5-alibaba.mjs',
    'scripts/ws5-matrix-runner.mjs',
    'scripts/ws5-verification-runner.mjs',
  ];
  const runtimeFiles = [
    '.github/workflows/pipelines/review-pipeline.js',
    'src/review/findingFalsification.js',
    'src/cli/publishingReview.ts',
    'src/gateway/openRouterClient.ts',
    'src/panel/pathMatch.ts',
    'src/panel/composedEngine.ts',
  ];
  const hashFile = (root, relativePath) => sha256(fs.readFileSync(path.join(root, relativePath)));
  const runnerSourceCommit = String(runGit(['rev-parse', 'HEAD'], runnerRoot)).trim();
  const runnerSourceTree = String(runGit(['rev-parse', 'HEAD^{tree}'], runnerRoot)).trim();
  const runnerWorktreeClean = String(runGit(['status', '--porcelain=v1', '--untracked-files=normal'], runnerRoot)).trim().length === 0;
  const runnerEntryDigests = runnerFiles.map((relativePath) => ({ path: relativePath, sha256: hashFile(runnerRoot, relativePath) }));
  const runtimeEntryDigests = runtimeFiles.map((relativePath) => ({ path: relativePath, sha256: hashFile(runtimeRoot, relativePath) }));
  const tsNodeLoaderPath = runtimeRequire.resolve('ts-node/register/transpile-only');
  const typescriptEntryPath = runtimeRequire.resolve('typescript');
  return {
    executionMode: 'host_node',
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    nodeExecutableSha256: sha256(fs.readFileSync(process.execPath)),
    runnerSourceCommit,
    runnerSourceTree,
    runnerSourceClean: runnerWorktreeClean,
    runnerSourceSha256: sha256(JSON.stringify(runnerEntryDigests)),
    runnerPackageLockSha256: hashFile(runnerRoot, 'package-lock.json'),
    runtimePackageLockSha256: hashFile(runtimeRoot, 'package-lock.json'),
    tsNodeVersion: runtimeRequire('ts-node/package.json').version,
    tsNodeLoaderSha256: sha256(fs.readFileSync(tsNodeLoaderPath)),
    typescriptVersion: runtimeRequire('typescript').version,
    typescriptEntrySha256: sha256(fs.readFileSync(typescriptEntryPath)),
    runtimeEntryFilesSha256: sha256(JSON.stringify(runtimeEntryDigests)),
    workerImageExecution: 'provenance_reference_only_not_executed_by_ws5_host_runner',
  };
}

export function runtimeGitIdentity(runtimeRoot) {
  try {
    const commit = String(runGit(['rev-parse', 'HEAD'], runtimeRoot)).trim();
    const tree = String(runGit(['rev-parse', 'HEAD^{tree}'], runtimeRoot)).trim();
    const worktreeClean = String(runGit(['status', '--porcelain'], runtimeRoot)).trim().length === 0;
    const version = readJson(path.join(runtimeRoot, 'package.json')).version || null;
    const hostExecution = hostExecutionIdentity(path.resolve(runtimeRoot));
    return { commit, tree, version, worktreeClean, hostExecution };
  } catch {
    return { commit: 'unknown', tree: 'unknown', version: null, worktreeClean: false, hostExecution: null };
  }
}

export function loadRuntime(runtimeRoot) {
  const runtimeRequire = createRequire(path.join(runtimeRoot, 'package.json'));
  runtimeRequire('ts-node/register/transpile-only');
  return {
    pipeline: runtimeRequire(path.join(runtimeRoot, '.github/workflows/pipelines/review-pipeline.js')),
    falsification: runtimeRequire(path.join(runtimeRoot, 'src/review/findingFalsification.js')),
    publishing: runtimeRequire(path.join(runtimeRoot, 'src/cli/publishingReview.ts')),
    OpenRouterClient: runtimeRequire(path.join(runtimeRoot, 'src/gateway/openRouterClient.ts')).OpenRouterClient,
    createPathMatcher: runtimeRequire(path.join(runtimeRoot, 'src/panel/pathMatch.ts')).createPathMatcher,
    executeComposedReview: runtimeRequire(path.join(runtimeRoot, 'src/panel/composedEngine.ts')).executeComposedReview,
  };
}

function publicRepoCacheDirectory(repository, cacheRoot) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) throw new Error('invalid_public_repository');
  return path.resolve(cacheRoot, repository.replace(/[^A-Za-z0-9._-]+/gu, '__'));
}

export function createGitSnapshotFileProvider(repoDir, prCase, createPathMatcher) {
  const pathsBySha = new Map();
  const contents = new Map();
  const resourceOmissions = new Set();
  const safePath = (value) => typeof value === 'string' && value.length > 0
    && !value.startsWith('/') && !value.split('/').some((part) => part === '..' || part === '.');
  const pathsAt = (sha) => {
    if (!pathsBySha.has(sha)) {
      try {
        const paths = runGit(['ls-tree', '-r', '--name-only', '-z', sha], repoDir).split('\0').filter(Boolean);
        pathsBySha.set(sha, paths.filter(safePath));
      } catch {
        resourceOmissions.add('pinned_source_tree_unavailable');
        pathsBySha.set(sha, null);
      }
    }
    return pathsBySha.get(sha);
  };
  const read = (sha, filePath) => {
    if (!safePath(filePath)) {
      resourceOmissions.add('pinned_source_path_unavailable');
      return null;
    }
    const key = `${sha}:${filePath}`;
    if (contents.has(key)) return contents.get(key);
    const paths = pathsAt(sha);
    // A path absent from an exact commit is an expected base/head absence for added/deleted
    // files. It is not a failed read; the verifier decides whether that side is sufficient.
    if (!paths || !paths.includes(filePath)) {
      contents.set(key, null);
      return null;
    }
    try { contents.set(key, runGit(['show', key], repoDir)); }
    catch {
      resourceOmissions.add('pinned_source_blob_unavailable');
      contents.set(key, null);
    }
    return contents.get(key);
  };
  return {
    async readFileAt(filePath, side) {
      const sha = side === 'head' ? prCase.headSha : prCase.baseSha;
      return { sha, content: read(sha, filePath) };
    },
    readDiff(filePath) {
      const file = prCase.changedFiles.find((candidate) => candidate.path === filePath);
      return file ? { patch: file.patch, originalPatchLength: file.originalPatchLength,
        identity: { repository: prCase.repository, baseSha: prCase.baseSha, headSha: prCase.headSha } } : null;
    },
    async findFiles(query) {
      const matches = createPathMatcher(query);
      const paths = pathsAt(prCase.headSha);
      return paths ? paths.filter((filePath) => matches(filePath)) : [];
    },
    async readFile(filePath) { return read(prCase.headSha, filePath); },
    async treeTruncated() { return false; },
    sourceReadOmissions() { return [...resourceOmissions].sort(); },
  };
}

function createApiSnapshotFileProvider(snapshot, prCase, createPathMatcher) {
  const changedByPath = new Map((snapshot.changedFiles || []).map((file) => [file.path, file]));
  const trees = snapshot.sourceTreeIndex || {};
  const paths = Array.isArray(snapshot.repositoryPaths) ? snapshot.repositoryPaths : Object.keys(trees.head || {});
  const cache = new Map();
  const resourceOmissions = new Set();
  let readBytes = Number(snapshot.sourceBytes) || 0;
  const readContent = async (filePath, side) => {
    const changed = changedByPath.get(filePath);
    const direct = changed && (side === 'head' ? changed.content : changed.baseContent);
    if (direct !== undefined) return direct;
    const tree = side === 'head' ? trees.head : trees.base;
    const blobSha = tree?.[filePath];
    if (!blobSha) return null;
    const key = `${side}:${filePath}`;
    if (cache.has(key)) return cache.get(key);
    if (readBytes >= MAX_SOURCE_CASE_BYTES) {
      resourceOmissions.add('provider_source_byte_budget_exceeded');
      cache.set(key, null);
      return null;
    }
    const result = await fetchPinnedRawText(prCase.repository, side === 'head' ? prCase.headSha : prCase.baseSha,
      filePath, blobSha, Math.min(MAX_SOURCE_FILE_BYTES, MAX_SOURCE_CASE_BYTES - readBytes));
    if (result.status !== 'available') {
      resourceOmissions.add(`provider_blob_${result.status}`);
      cache.set(key, null);
      return null;
    }
    readBytes += result.bytes;
    cache.set(key, result.content);
    return result.content;
  };
  return {
    async readFileAt(filePath, side) {
      const head = side === 'head';
      return { sha: head ? prCase.headSha : prCase.baseSha, content: await readContent(filePath, head ? 'head' : 'base') };
    },
    readDiff(filePath) {
      const file = changedByPath.get(filePath);
      return file ? { patch: file.patch, originalPatchLength: file.originalPatchLength,
        identity: { repository: prCase.repository, baseSha: prCase.baseSha, headSha: prCase.headSha } } : null;
    },
    async findFiles(query) {
      const matches = createPathMatcher(query);
      return paths.filter((filePath) => matches(filePath));
    },
    async readFile(filePath) { return readContent(filePath, 'head'); },
    async treeTruncated() { return snapshot.treeTruncated === true; },
    sourceReadOmissions() { return [...resourceOmissions].sort(); },
  };
}

export function sanitizePanelResult(panelResult) {
  if (!panelResult || typeof panelResult !== 'object') return null;
  const boundedText = (value, maxLength) => typeof value === 'string'
    ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '').slice(0, maxLength) : null;
  const findings = (Array.isArray(panelResult.personas) ? panelResult.personas : []).flatMap((persona, laneIndex) =>
    (Array.isArray(persona?.findings) ? persona.findings : []).map((finding, findingIndex) => ({
      id: `finding-${laneIndex + 1}-${findingIndex + 1}-${sha256(`${finding?.path || finding?.filePath || ''}:${finding?.line || finding?.lineNumber || ''}:${finding?.title || finding?.comment || ''}`).slice(0, 12)}`,
      severity: safeRuntimeId(finding?.severity || 'unknown', 12),
      path: String(finding?.path || finding?.filePath || ''),
      line: Number.isSafeInteger(Number(finding?.line ?? finding?.lineNumber))
        ? Number(finding?.line ?? finding?.lineNumber) : null,
      lane: safeRuntimeId(persona?.id || persona?.persona || 'unknown', 80),
      ...(boundedText(finding?.title, 300) ? { title: boundedText(finding?.title, 300) } : {}),
      ...(boundedText(finding?.comment ?? finding?.description ?? finding?.body, 2_000)
        ? { comment: boundedText(finding?.comment ?? finding?.description ?? finding?.body, 2_000) } : {}),
      ...(boundedText(finding?.recommendation, 1_000)
        ? { recommendation: boundedText(finding?.recommendation, 1_000) } : {}),
    })));
  const grounded = panelResult.groundedReview || null;
  const history = grounded?.history || panelResult.history || null;
  const verification = grounded?.verification || panelResult.verification || null;
  const summaryObject = (value, allowStrings = []) => {
    if (!value || typeof value !== 'object') return null;
    const result = {};
    for (const key of allowStrings) {
      const entry = value[key];
      if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') result[key] = entry;
      else if (Array.isArray(entry) && entry.every((item) => typeof item === 'string' || typeof item === 'number')) result[key] = entry;
    }
    return result;
  };
  const historySummary = summaryObject(history, [
    'status', 'snapshotId', 'eventCount', 'findingCount', 'legacyOmittedCount', 'eventsDigest', 'findingsDigest',
    'pagesRead', 'complete',
  ]);
  if (historySummary && Array.isArray(history?.omissions)) historySummary.omissionCount = history.omissions.length;
  const verificationSummary = summaryObject(verification, ['candidates', 'confirmed', 'contradicted', 'insufficient', 'coverageComplete']);
  if (verificationSummary && Array.isArray(verification?.omissions)) verificationSummary.omissionCount = verification.omissions.length;
  return {
    findings,
    taskPlan: Array.isArray(panelResult.taskPlan) ? panelResult.taskPlan.map((task) => ({
      id: safeRuntimeId(task?.id || '', 120),
      dimension: safeRuntimeId(task?.dimension || 'unknown', 80),
      paths: Array.isArray(task?.paths) ? task.paths.map((value) => String(value)) : [],
    })) : [],
    coverageComplete: panelResult.coverageComplete ?? grounded?.coverageComplete ?? null,
    quorumSatisfied: panelResult.quorumSatisfied ?? grounded?.quorumSatisfied ?? null,
    // Bounded finding title/comment/recommendation are needed for private post-run adjudication.
    // Other decision/verifier reason text is omitted because it can carry hidden reasoning.
    reviewDecision: summaryObject(panelResult.reviewDecision || grounded?.reviewDecision, ['schemaVersion', 'classification', 'blockingFindingCount', 'advisoryFindingCount', 'eligible']),
    history: historySummary,
    verification: verificationSummary,
    verifierOutcomes: Array.isArray(grounded?.verifierOutcomes || panelResult.verifierOutcomes)
      ? (grounded?.verifierOutcomes || panelResult.verifierOutcomes).map((outcome) => ({
        verdict: safeRuntimeId(outcome?.verdict || 'unknown', 20),
      })) : [],
    incompleteReasonDigests: Array.isArray(grounded?.incompleteReasons || panelResult.incompleteReasons)
      ? (grounded?.incompleteReasons || panelResult.incompleteReasons).map((reason) => sha256(String(reason))) : [],
    gracefulExit: panelResult.gracefulExit ? {
      reasonPresent: typeof panelResult.gracefulExit.reason === 'string',
      completedTaskIds: panelResult.gracefulExit.completedTaskIds,
      pendingTaskIds: panelResult.gracefulExit.pendingTaskIds,
    } : null,
    diffShrink: panelResult.diffShrink ? {
      whitespaceOnlyFiles: panelResult.diffShrink.whitespaceOnlyFiles?.length || 0,
      collapsedWhitespaceHunkFiles: panelResult.diffShrink.collapsedWhitespaceHunks?.length || 0,
      renames: panelResult.diffShrink.renames?.length || 0,
      linguistExcluded: panelResult.diffShrink.linguistExcluded?.length || 0,
      keptFullDepth: panelResult.diffShrink.keptFullDepth?.length || 0,
    } : null,
  };
}

/** Run one public PR through the real production-selected publishing entrypoint. */
export async function runActualDiscoveryCase(prCase, snapshot, runtime, {
  transportEnv = process.env,
  purpose = 'smoke',
  maxTasks = 2,
  maxTurnsTotal = 4,
  maxTurnsPerTask = 1,
  sourcePolicy = null,
  sourcePolicySha256 = null,
  effortProfile = 'medium',
  effortInjection = null,
  verificationReserveTurns = 12,
  historySource = null,
  fileProviderFactory = null,
} = {}) {
  const sourceCachePreflight = preflightDiscoveryCaseSource(snapshot, snapshot.sourceRepoDir, prCase);
  if (sourceCachePreflight.status === 'failed') {
    return {
      status: 'incomplete',
      reason: sourceCachePreflight.reason,
      sourceCachePreflight,
      source: { sourceReadOmissions: [sourceCachePreflight.reason] },
      findings: [],
    };
  }
  const sourceOmissions = snapshot.omissions || [];
  const requiredSourceOmissions = sourceOmissions.filter((entry) => entry !== 'binary_patch');
  if (requiredSourceOmissions.length || !Array.isArray(snapshot.changedFiles) || snapshot.changedFiles.length === 0) {
    return { status: 'incomplete', reason: requiredSourceOmissions[0] || sourceOmissions[0] || 'empty_diff',
      sourceCachePreflight, findings: [] };
  }
  const reviewPolicy = purpose === 'qualification' || purpose === 'baseline'
    ? buildDiscoveryPolicy(sourcePolicy, { purpose, effortProfile })
    : null;
  if ((purpose === 'qualification' || purpose === 'baseline')
    && (maxTasks !== undefined || maxTurnsTotal !== undefined || maxTurnsPerTask !== undefined)) {
    // The qualification profile is intentionally source-defaulted; task/turn knobs are accepted
    // only by the explicitly non-qualifying smoke path below.
    if (arguments[3]?.maxTasks !== undefined || arguments[3]?.maxTurnsTotal !== undefined
      || arguments[3]?.maxTurnsPerTask !== undefined) throw new Error('qualification_resource_overrides_not_allowed');
  }
  if (purpose !== 'smoke' && purpose !== 'baseline' && purpose !== 'qualification') throw new Error('unsupported_discovery_purpose');
  if (purpose === 'smoke' && (!Number.isSafeInteger(maxTasks) || maxTasks < 1 || maxTasks > 2
    || !Number.isSafeInteger(maxTurnsTotal) || maxTurnsTotal < 1 || maxTurnsTotal > 4
    || !Number.isSafeInteger(maxTurnsPerTask) || maxTurnsPerTask !== 1)) {
    throw new Error('discovery_resource_limits_exceed_benchmark_ceiling');
  }
  const gatewayBaseUrl = transportEnv.REVIEW_YETI_GATEWAY_BASE_URL || '';
  const gatewayApiKey = transportEnv.REVIEW_YETI_BIFROST_API_KEY || '';
  if (!gatewayBaseUrl || !gatewayApiKey) throw new Error('actual_model_credentials_unavailable');
  const model = safeRuntimeId(transportEnv.REVIEW_MODEL || 'pr-reviewer');
  const runtimeEnv = {
    NODE_ENV: 'production',
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    REVIEW_PUBLICATION_MODE: 'app-gate',
    REVIEW_RUN_ID: `run_${sha256(JSON.stringify({ repository: prCase.repository, prNumber: prCase.prNumber,
      headSha: prCase.headSha, purpose, effortProfile, effortInjection, sourcePolicySha256, verificationReserveTurns })).slice(0, 32)}`,
    REVIEW_REPOSITORY_ID: String((Number.parseInt(sha256(prCase.repository).slice(0, 7), 16) % 2_000_000_000) + 1),
    REVIEW_REPO: prCase.repository,
    REVIEW_PR_NUMBER: String(prCase.prNumber),
    REVIEW_BASE_SHA: prCase.baseSha,
    REVIEW_HEAD_SHA: prCase.headSha,
    REVIEW_EXECUTION_ATTEMPT: '1',
    REVIEW_REPOSITORY_VISIBILITY: 'public',
    REVIEW_MODEL: model,
    REVIEW_YETI_GATEWAY_BASE_URL: gatewayBaseUrl,
    REVIEW_YETI_BIFROST_API_KEY: gatewayApiKey,
    // The local source provider is injected below. This marker is only the existing factory gate;
    // every dependency that could use this value is replaced by an exact public-source adapter.
    GH_TOKEN: 'benchmark-local-source-adapter',
    REVIEW_POLICY_DIGEST: reviewPolicy
      ? sha256(JSON.stringify(reviewPolicy))
      : sha256(`benchmark-policy|${model}|${maxTasks}|${maxTurnsTotal}|${maxTurnsPerTask}`),
    REVIEW_CONFIG_DIGEST: sha256(JSON.stringify({
      benchmarkPolicyDigest: reviewPolicy ? sha256(JSON.stringify(reviewPolicy)) : null,
      repository: prCase.repository, prNumber: prCase.prNumber, baseSha: prCase.baseSha, headSha: prCase.headSha,
      model, purpose, effortInjection,
    })),
    REVIEW_YETI_POLICY_JSON: reviewPolicy
      ? JSON.stringify(reviewPolicy)
      : JSON.stringify({
        review_engine: 'composed',
        personas: ['security'],
        budget: { max_investigation_turns: Math.max(1, maxTurnsTotal) },
        composed: { max_tasks: maxTasks, max_turns_total: maxTurnsTotal, max_turns_per_task: maxTurnsPerTask },
      }),
  };
  const resourceProfile = purpose === 'qualification' || purpose === 'baseline'
    ? discoveryResourceProfile(reviewPolicy, { verificationReserveTurns, env: process.env }) : null;
  if ((purpose === 'qualification' || purpose === 'baseline')) {
    assertKnownPolicyProjection(effortProfile, sourcePolicySha256);
    assertFullEnvelopeQualificationProfile(reviewPolicy, { verificationReserveTurns, env: process.env });
  }
  const transport = runtime.publishing.openaiTransport(runtimeEnv);
  const effectiveConfig = runtime.publishing.resolveWorkerConfig(runtimeEnv, transport);
  const effectiveEngine = runtime.publishing.resolveReviewEngine(effectiveConfig);
  if (effectiveEngine !== 'composed') throw new Error('effective_review_engine_not_composed');
  const selection = { engineRunnerInvoked: false, result: null };
  const modelIdentity = {
    requestedModels: new Set(), responseModels: new Set(), responseProviders: new Set(),
    responseRouteHints: new Set(), requestIdDigests: new Set(), fetchFailureClasses: new Set(),
    fetchToHeadersMs: [], httpStatuses: [], requestProfiles: new Map(), pendingResponseMetadataReads: [],
  };
  const realClient = new runtime.OpenRouterClient({
    baseUrl: transport.baseUrl,
    apiKey: transport.apiKey,
    fetchImplementation: trackCompletion(globalThis.fetch, modelIdentity),
  });
  let callCount = 0;
  const logicalCallsByStage = { review: 0, verifier: 0 };
  const logicalDispatches = [];
  const clientForStage = (stage) => ({
    async complete(request) {
      callCount += 1;
      logicalCallsByStage[stage] += 1;
      const outboundRequest = effortInjection
        ? { ...request, reasoningEffort: effortInjection }
        : request;
      const response = await trackLogicalCompletion(stage, logicalDispatches,
        () => realClient.complete(outboundRequest));
      if (typeof response?.model === 'string' && response.model.trim()) {
        modelIdentity.responseModels.add(safeRuntimeId(response.model));
      }
      return response;
    },
  });
  const client = clientForStage('review');
  const groundedVerifierClient = clientForStage('verifier');
  const diff = snapshot.changedFiles.map((file) => file.patch).join('');
  let activeFileProvider = null;
  const deps = {
    checkClient: {
      async createCheck() { return 1; },
      async completeCheck() {},
    },
    client,
    visibilityLookup: async () => 'public',
    sourceLoader: async (input) => {
      if (input.repo !== prCase.repository || input.prNumber !== prCase.prNumber
        || input.expectedBaseSha !== prCase.baseSha || input.expectedHeadSha !== prCase.headSha) {
        throw new Error('pinned_source_identity_mismatch');
      }
      return { baseSha: prCase.baseSha, headSha: prCase.headSha, diff,
        diffDigest: sha256(diff), githubReads: 0 };
    },
    currentPullRequestVerifier: async (input) => {
      if (input.repo !== prCase.repository || input.prNumber !== prCase.prNumber
        || input.expectedHeadSha !== prCase.headSha) throw new Error('pinned_current_head_mismatch');
      return { state: 'open', headSha: prCase.headSha };
    },
    repoFileProviderFactory: () => {
      activeFileProvider = fileProviderFactory
        ? fileProviderFactory(snapshot, prCase, runtime)
        : snapshot.sourceAdapter === 'github_exact_commit_trees_and_raw_blobs'
          ? createApiSnapshotFileProvider(snapshot, prCase, runtime.createPathMatcher)
          : createGitSnapshotFileProvider(snapshot.sourceRepoDir, { ...prCase, changedFiles: snapshot.changedFiles }, runtime.createPathMatcher);
      return activeFileProvider;
    },
    ...(historySource ? { prLifecycleHistory: historySource } : {}),
    groundedVerifierClient,
    zoektGrounding: async () => ({ reason: 'disabled_in_public_snapshot_adapter' }),
    composedReviewRunner: async (input) => {
      selection.engineRunnerInvoked = true;
      selection.result = await runtime.executeComposedReview(input);
      return selection.result;
    },
  };
  // The worker emits operator logs that may contain untrusted PR/model text. They are not part
  // of benchmark evidence, so suppress both console and direct stream writes during the run.
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  let receipt;
  try {
    process.stdout.write = () => true;
    process.stderr.write = () => true;
    const runWorker = () => runtime.publishing.runPublishingReviewWorker(runtimeEnv, deps);
    receipt = purpose === 'smoke'
      ? await withScopedComposedEngineTurnLimit(maxTurnsTotal, runWorker)
      : await runWorker();
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
  const sourceReadOmissions = activeFileProvider?.sourceReadOmissions?.() || [];
  const panel = sanitizePanelResult(selection.result);
  const groundedReview = sanitizeGroundedReviewReceipt(receipt.groundedReview);
  const requestIdentity = identitySummary(modelIdentity);
  const binaryOnlySourceOmissions = sourceOmissions.length > 0 && sourceOmissions.every((entry) => entry === 'binary_patch');
  const caseQualityComplete = assertDiscoveryCaseQualification({
    purpose,
    verdict: receipt.verdict,
    coverage: receipt.coverage,
    selectedRunnerInvoked: selection.engineRunnerInvoked,
    sourceReadOmissions,
    groundedReview: receipt.groundedReview,
  });
  const coverageQualified = caseQualityComplete;
  const caseStatus = !coverageQualified || (sourceOmissions.length > 0 && !binaryOnlySourceOmissions)
    ? 'incomplete' : binaryOnlySourceOmissions ? 'diagnostic_text_scope_only' : 'completed';
  const safeReviewDecision = receipt.reviewDecision && typeof receipt.reviewDecision === 'object' ? {
    ...(typeof receipt.reviewDecision.schemaVersion === 'string' ? { schemaVersion: receipt.reviewDecision.schemaVersion } : {}),
    ...(typeof receipt.reviewDecision.classification === 'string' ? { classification: receipt.reviewDecision.classification } : {}),
    ...(Number.isSafeInteger(receipt.reviewDecision.blockingFindingCount)
      ? { blockingFindingCount: receipt.reviewDecision.blockingFindingCount } : {}),
    ...(Number.isSafeInteger(receipt.reviewDecision.advisoryFindingCount)
      ? { advisoryFindingCount: receipt.reviewDecision.advisoryFindingCount } : {}),
    ...(typeof receipt.reviewDecision.eligible === 'boolean' ? { eligible: receipt.reviewDecision.eligible } : {}),
  } : null;
  return {
    status: caseStatus,
    sourceCachePreflight,
    runtimeEntryPoint: 'runPublishingReviewWorker',
    runtimeLane: 'production_selected_composed_discovery',
    executionPurpose: purpose === 'qualification' ? 'full_production_envelope_quality_input'
      : purpose === 'baseline' ? 'full_production_envelope_v1_baseline_input'
        : 'production_entrypoint_runtime_smoke_only',
    groundedVerification: groundedReview ? 'production_grounded_verifier_receipt_present' : 'runtime_has_no_grounded_verifier_receipt',
    engineSelection: {
      requestedByBenchmarkBasePolicy: 'composed',
      effectiveEngine,
      selectedRunnerInvoked: selection.engineRunnerInvoked,
      policyDigest: sha256(runtimeEnv.REVIEW_YETI_POLICY_JSON),
      effectiveConfigDigest: sha256(JSON.stringify({
        review_engine: effectiveConfig.review_engine,
        composed: effectiveConfig.composed,
        default_max_turns: effectiveConfig.default_max_turns,
        reviewer_effort: effectiveConfig.reviewer_effort,
        default_effort: effectiveConfig.default_effort,
        reviewers: effectiveConfig.reviewers,
      })),
      effectiveEffortPolicy: {
        reviewerEffort: safeRuntimeId(effectiveConfig.reviewer_effort || 'unset', 16),
        defaultEffort: safeRuntimeId(effectiveConfig.default_effort || 'unset', 16),
        reviewerProviderEfforts: Array.isArray(effectiveConfig.reviewers?.providers)
          ? [...new Set(effectiveConfig.reviewers.providers.map((provider) => safeRuntimeId(provider?.effort || 'unset', 16)))].sort()
          : [],
      },
      policySourceRevision: reviewPolicy ? V1_POLICY_PROVENANCE.revision : null,
      policySourceSha256: reviewPolicy ? V1_POLICY_PROVENANCE.sourceSha256 : null,
      policyProjectionFileSha256: sourcePolicySha256 || null,
      sourcePolicyDigest: sha256(JSON.stringify(reviewPolicy || {})),
      effectiveConfigReceipt: effectiveConfig.review_configuration_receipt ? {
        schema: effectiveConfig.review_configuration_receipt.schema,
        requested: {
          reviewEngine: effectiveConfig.review_configuration_receipt.requested.review_engine,
          profile: effectiveConfig.review_configuration_receipt.requested.profile,
          severityPolicy: effectiveConfig.review_configuration_receipt.requested.severity_policy || null,
          personas: effectiveConfig.review_configuration_receipt.requested.personas,
          maxInvestigationTurns: effectiveConfig.review_configuration_receipt.requested.max_investigation_turns,
          requestedBifrostEffort: effectiveConfig.review_configuration_receipt.requested.bifrost_reasoning_effort || null,
        },
        effective: {
          reviewEngine: effectiveConfig.review_configuration_receipt.effective.review_engine,
          profile: effectiveConfig.review_configuration_receipt.effective.profile.value,
          provider: {
            id: effectiveConfig.review_configuration_receipt.effective.provider.id,
            model: safeRuntimeId(effectiveConfig.review_configuration_receipt.effective.provider.model),
            requestedEffort: effectiveConfig.review_configuration_receipt.effective.provider.requested_effort,
            upstreamObservedModel: 'unknown',
            upstreamObservedEffort: 'unknown',
          },
          personas: effectiveConfig.review_configuration_receipt.effective.personas.map(({ requested, id }) => ({
            requested: safeRuntimeId(requested, 80), id: safeRuntimeId(id, 80),
          })),
          composedBudget: effectiveConfig.review_configuration_receipt.effective.composed_budget,
          workerLimits: effectiveConfig.review_configuration_receipt.effective.worker_limits,
        },
      } : null,
      resourceProfile,
      defaultEngineQualification: 'not_claimed',
    },
    source: {
      repository: prCase.repository,
      prNumber: prCase.prNumber,
      datasetBaseSha: prCase.datasetBaseSha || prCase.baseSha,
      diffBaseSha: prCase.diffBaseSha || prCase.baseSha,
      mergeBaseSha: prCase.mergeBaseSha || prCase.baseSha,
      baseSha: prCase.baseSha,
      headSha: prCase.headSha,
      changedFiles: snapshot.changedFiles.length,
      changedPatchChars: diff.length,
      sourceOmissions,
      sourceReadOmissions,
      sourceCachePreflight,
      adapters: {
        sourceLoader: snapshot.sourceAdapter || 'pinned_git_objects',
        repoFileProvider: fileProviderFactory ? 'explicit_read_only_fixture' : snapshot.sourceAdapter || 'pinned_git_objects',
        history: historySource ? 'explicit_injected_source' : 'no_authenticated_lifecycle_history_source',
        checkClient: 'no_write_stub',
        currentHeadFence: 'pinned_snapshot',
      },
      changedDiffSha256: sha256(diff),
      preparedCaseSha256: snapshot.preparedCaseSha256 || null,
      reviewableSourceScope: 'text_source_paths_only',
    },
    receipt: {
      version: receipt.version,
      verdict: receipt.verdict,
      conclusion: receipt.conclusion,
      coverage: sanitizePublishingCoverage(receipt.coverage),
      findingCount: receipt.findingCount,
      blockingFindingCount: receipt.blockingFindingCount,
      failureClass: receipt.failureClass,
      metrics: receipt.metrics ? {
        totalPromptTokens: receipt.metrics.totalPromptTokens,
        totalCompletionTokens: receipt.metrics.totalCompletionTokens,
        totalTokens: receipt.metrics.totalTokens,
        totalTurns: receipt.metrics.totalTurns,
        totalDurationMs: receipt.metrics.totalDurationMs,
      } : null,
      reviewDecision: safeReviewDecision,
      groundedReview,
    },
    model: {
      transport: 'Bifrost',
      requestedAlias: model,
      ...requestIdentity,
      calls: callCount,
      callsMeaning: 'logical_completion_dispatches',
      callAccounting: {
        logicalCompletionDispatches: callCount,
        reviewCompletionDispatches: logicalCallsByStage.review,
        verifierCompletionDispatches: logicalCallsByStage.verifier,
        localHttpRequestAttempts: requestIdentity.localHttpRequestAttempts,
        requestProfileAttemptCount: requestIdentity.requestProfileAttemptCount,
        requestAttemptAccountingMatches: requestIdentity.requestAttemptAccountingMatches,
        dispatches: logicalDispatches,
        dispatchAttemptAccountingMatches: logicalDispatches.reduce((sum, dispatch) => sum + dispatch.localHttpRequestAttempts, 0)
          === requestIdentity.localHttpRequestAttempts,
        preHttpDispatchErrorCount: logicalDispatches.filter((dispatch) => dispatch.classification === 'pre_http_dispatch_error').length,
        returnedWithoutHttpAttemptCount: logicalDispatches.filter((dispatch) => dispatch.classification === 'returned_without_http_attempt').length,
        panelTurns: Number.isSafeInteger(receipt.metrics?.totalTurns) ? receipt.metrics.totalTurns : null,
        groundedVerifierReceiptCalls: Number.isSafeInteger(receipt.groundedReview?.verification?.calls)
          ? receipt.groundedReview.verification.calls : null,
        gatewayRelayCount: null,
        providerCompletionCount: null,
        billedRequestCount: null,
        costUsd: null,
      },
      requestedEfforts: [...modelIdentity.requestProfiles.values()].map((entry) => entry.reasoningEffort),
      effortInjection: effortInjection ? 'benchmark_adapter_explicit_request_profile' : 'runtime_native',
      requestProfiles: [...modelIdentity.requestProfiles.values()],
      servingIdentity: modelIdentity.responseModels.size > 0
        && [...modelIdentity.responseModels].some((responseModel) => !modelIdentity.requestedModels.has(responseModel))
        ? 'response_reported_unverified' : 'unknown',
      upstreamProviderIdentity: 'unknown',
    },
    runtimeReceipt: panel,
    githubWrites: 0,
    publication: 'disabled_in_benchmark_adapter',
  };
}

export async function main(argv = process.argv) {
  const command = argv[2];
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (command === 'preflight-transport') {
    const runtimeRoot = path.resolve(arg('--runtime-root', repoRoot, argv));
    const runtime = loadRuntime(runtimeRoot);
    const transport = inspectActualLoopbackTransport(runtime.pipeline, {
      expectedModel: arg('--expected-model', 'pr-reviewer', argv),
      transportEnv: process.env,
    });
    const expectedModel = arg('--expected-model', 'pr-reviewer', argv);
    const gatewayUrl = process.env.REVIEW_YETI_GATEWAY_BASE_URL || '';
    const gatewayToken = process.env.REVIEW_YETI_BIFROST_API_KEY || '';
    const discoveryRuntimeEnv = {
      NODE_ENV: 'production',
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      REVIEW_MODEL: process.env.REVIEW_MODEL,
      REVIEW_YETI_GATEWAY_BASE_URL: gatewayUrl,
      REVIEW_YETI_BIFROST_API_KEY: gatewayToken,
    };
    const discoveryTransport = runtime.publishing.openaiTransport(discoveryRuntimeEnv);
    let discoveryUrl;
    try { discoveryUrl = new URL(discoveryTransport.baseUrl); }
    catch { throw new Error('ws5_discovery_transport_preflight_mismatch'); }
    if (discoveryUrl.protocol !== 'https:' || discoveryUrl.hostname !== '127.0.0.1'
      || discoveryUrl.port !== new URL(gatewayUrl).port
      || discoveryTransport.apiKey !== process.env.OPENROUTER_API_KEY
      || discoveryTransport.model !== expectedModel) {
      throw new Error('ws5_discovery_transport_preflight_mismatch');
    }
    process.stdout.write(JSON.stringify({
      ...transport,
      productionPublishingTransport: {
        resolver: 'runtime.publishing.openaiTransport',
        protocol: discoveryUrl.protocol,
        endpointHost: discoveryUrl.hostname,
        requestedModel: safeRuntimeId(discoveryTransport.model),
        resourceLimits: 'not_exposed_by_publishing_transport_resolver',
      },
      runtime: runtimeGitIdentity(runtimeRoot),
    }) + '\n');
    return 0;
  }
  if (command === 'manifest') {
    const rows = loadPinnedAacrDataset(arg('--dataset', ''));
    const manifest = buildAacrManifest(rows);
    writeJson(arg('--out', path.join(repoRoot, 'eval-baselines/competitive-review-benchmark/aacr-heldout-v1.json')), manifest);
    process.stdout.write(JSON.stringify({ status: 'written', heldoutCaseCount: manifest.heldoutCaseCount, datasetSha256: manifest.datasetSha256 }) + '\n');
    return 0;
  }
  if (command === 'prepare-verification') {
    const rows = loadPinnedAacrDataset(arg('--dataset', ''));
    const manifestBytes = fs.readFileSync(path.resolve(arg('--manifest',
      path.join(repoRoot, 'eval-baselines/competitive-review-benchmark/aacr-heldout-v1.json'))));
    const { manifest, sha256: heldoutManifestSha256 } = assertCanonicalHeldoutManifestBytes(manifestBytes);
    const cases = buildVerificationCases(rows, manifest, { perLabelPerPr: Number(arg('--per-label-per-pr-context', '1')) });
    const cacheRoot = path.resolve(arg('--cache', path.join(os.tmpdir(), 'review-yeti-aacr-public-repos')));
    const outputCases = [];
    const snapshotsByPr = new Map();
    for (const testCase of cases) {
      const prCase = manifest.cases.find((entry) => entry.id === testCase.prCaseId);
      if (!snapshotsByPr.has(testCase.prCaseId)) {
        snapshotsByPr.set(testCase.prCaseId, await loadPublicPrSnapshot(prCase, cacheRoot));
      }
      const snapshot = snapshotsByPr.get(testCase.prCaseId);
      const matchedFile = snapshot.changedFiles.find((file) => file.path === testCase.reference.path);
      const result = {
        ...toVerifierInput(testCase),
        language: testCase.language,
        context: testCase.context,
        changedFiles: snapshot.changedFiles,
        sourceIdentity: {
          repository: snapshot.repository,
          datasetBaseSha: prCase.datasetBaseSha || prCase.baseSha,
          diffBaseSha: prCase.diffBaseSha || prCase.baseSha,
          baseSha: snapshot.baseSha,
          headSha: snapshot.headSha,
        },
        referencePathChanged: Boolean(matchedFile),
        sourceOmissions: snapshot.omissions,
      };
      outputCases.push(result);
    }
    writeJson(arg('--out', path.join(os.tmpdir(), 'review-yeti-aacr-verification-input.json')), {
      schemaVersion: 'review-yeti-verification-cases-v1',
      datasetSha256: AACR_BENCHMARK.sha256,
      heldoutManifestSha256,
      cases: outputCases,
    });
    const strata = Object.fromEntries(CONTEXT_ORDER.map((context) => [context, outputCases.filter((entry) => entry.context === context).length]));
    process.stdout.write(JSON.stringify({ status: 'prepared', cases: outputCases.length, strata, sourceOmissions: outputCases.filter((entry) => entry.sourceOmissions.length).length }) + '\n');
    return 0;
  }
  if (command === 'prepare-discovery') {
    const manifestBytes = fs.readFileSync(path.resolve(arg('--manifest',
      path.join(repoRoot, 'eval-baselines/competitive-review-benchmark/aacr-heldout-v1.json'))));
    const { manifest, sha256: heldoutManifestSha256 } = assertCanonicalHeldoutManifestBytes(manifestBytes);
    const cacheRoot = path.resolve(arg('--cache', path.join(os.tmpdir(), 'review-yeti-aacr-public-repos')));
    const cases = [];
    for (const prCase of manifest.cases) {
      const snapshot = await loadPublicPrSnapshot(prCase, cacheRoot);
      cases.push({
        caseId: prCase.id,
        repository: prCase.repository,
        prNumber: prCase.prNumber,
        language: prCase.language,
        datasetBaseSha: prCase.datasetBaseSha || prCase.baseSha,
        diffBaseSha: prCase.diffBaseSha || prCase.baseSha,
        mergeBaseSha: prCase.mergeBaseSha || prCase.baseSha,
        baseSha: prCase.baseSha,
        headSha: prCase.headSha,
        changedFiles: snapshot.changedFiles,
        sourceOmissions: snapshot.omissions,
        sourceAdapter: snapshot.sourceAdapter,
        ...(snapshot.sourceTreeIndex ? { sourceTreeIndex: snapshot.sourceTreeIndex } : {}),
        ...(snapshot.repositoryPaths ? { repositoryPaths: snapshot.repositoryPaths } : {}),
        treeTruncated: snapshot.treeTruncated === true,
        sourceBytes: snapshot.sourceBytes || 0,
      });
    }
    const out = arg('--out', path.join(os.tmpdir(), 'review-yeti-aacr-discovery-input.json'));
    writeJson(out, { schemaVersion: 'review-yeti-discovery-cases-v1', datasetSha256: AACR_BENCHMARK.sha256,
      heldoutManifestSha256, cases });
    process.stdout.write(JSON.stringify({ status: 'prepared', cases: cases.length,
      sourceOmissions: cases.filter((entry) => entry.sourceOmissions.length).length,
      changedFiles: cases.reduce((total, entry) => total + entry.changedFiles.length, 0) }) + '\n');
    return 0;
  }
  if (command === 'run-discovery') {
    const preparedInput = readPreparedInput(arg('--cases', path.join(os.tmpdir(), 'review-yeti-aacr-discovery-input.json')));
    const input = preparedInput.value;
    if (input.datasetSha256 !== AACR_BENCHMARK.sha256 || !Array.isArray(input.cases)) throw new Error('discovery case bundle is not pinned');
    const executionPurpose = arg('--purpose', 'smoke', argv);
    if (!['smoke', 'baseline', 'qualification'].includes(executionPurpose)) {
      throw new Error('unsupported_discovery_purpose');
    }
    const manifestBytes = fs.readFileSync(path.resolve(arg('--manifest',
      path.join(repoRoot, 'eval-baselines/competitive-review-benchmark/aacr-heldout-v1.json'))));
    const manifestBinding = executionPurpose === 'smoke'
      ? parseHeldoutManifestBytes(manifestBytes) : assertCanonicalHeldoutManifestBytes(manifestBytes);
    const { manifest, sha256: heldoutManifestSha256 } = manifestBinding;
    const expectedCases = new Map(manifest.cases.map((entry) => [entry.id, entry]));
    assertExactCaseIdSet(input.cases.map((entry) => entry.caseId), manifest.cases.map((entry) => entry.id));
    if (executionPurpose !== 'smoke' && input.heldoutManifestSha256 !== heldoutManifestSha256) {
      throw new Error('discovery_input_manifest_digest_mismatch');
    }
    const runtimeRoot = path.resolve(arg('--runtime-root', repoRoot));
    const cacheRoot = path.resolve(arg('--cache', path.join(os.tmpdir(), 'review-yeti-aacr-public-repos')));
    const runtime = loadRuntime(runtimeRoot);
    const runtimeIdentity = runtimeGitIdentity(runtimeRoot);
    const results = [];
    const maxCasesValue = Number(arg('--max-cases', executionPurpose === 'smoke' ? '1' : String(input.cases.length)));
    if (!Number.isSafeInteger(maxCasesValue) || maxCasesValue < 1 || maxCasesValue > input.cases.length) {
      throw new Error('max_cases_must_be_between_one_and_fixed_panel_size');
    }
    let sourcePolicy = null;
    let sourcePolicySha256 = null;
    let effortProfile = 'medium';
    let effortInjection = null;
    let verificationReserveTurns = 12;
    if (executionPurpose === 'qualification' || executionPurpose === 'baseline') {
      const policyPath = arg('--policy-file', '', argv);
      if (!policyPath) throw new Error('qualification_policy_file_required');
      const policyInput = readPreparedInput(path.resolve(policyPath));
      effortProfile = arg('--effort-profile', executionPurpose === 'baseline' ? 'native_omitted' : 'medium', argv);
      sourcePolicy = buildDiscoveryPolicy(policyInput.value, { purpose: executionPurpose, effortProfile });
      sourcePolicySha256 = policyInput.sha256;
      effortInjection = arg('--effort-injection', '', argv) || null;
      if (effortInjection && effortInjection !== 'medium') throw new Error('unsupported_effort_injection');
      if (effortProfile === 'native_omitted' && effortInjection) throw new Error('native_effort_profile_cannot_inject_effort');
      if (executionPurpose === 'baseline') {
        if (arg('--verifier-mode', 'none', argv) !== 'none') throw new Error('v1_baseline_must_not_claim_grounded_verifier');
        verificationReserveTurns = 0;
      } else {
        if (arg('--verifier-mode', 'production', argv) !== 'production') throw new Error('qualification_requires_production_grounded_verifier');
        verificationReserveTurns = 12;
      }
      const forbiddenSmokeOverrides = ['--max-tasks', '--max-turns-total', '--max-turns-per-task'];
      if (forbiddenSmokeOverrides.some((flag) => argv.includes(flag))) {
        throw new Error('qualification_resource_overrides_not_allowed');
      }
      assertKnownPolicyProjection(effortProfile, sourcePolicySha256);
      assertFullEnvelopeQualificationProfile(sourcePolicy, { verificationReserveTurns, env: process.env });
    }
    const exactCaseId = arg('--case-id', '', argv);
    let selectedCases;
    const caseIdsText = arg('--case-ids', '', argv);
    if ((executionPurpose === 'qualification' || executionPurpose === 'baseline')
      && !exactCaseId && !caseIdsText) {
      throw new Error('full_envelope_run_requires_explicit_case_ids');
    }
    if ((executionPurpose === 'qualification' || executionPurpose === 'baseline') && argv.includes('--max-cases')) {
      throw new Error('full_envelope_run_rejects_prefix_case_selection');
    }
    if (exactCaseId && caseIdsText) throw new Error('choose_one_case_selector');
    if (caseIdsText) {
      const requestedIds = caseIdsText.split(',').filter(Boolean);
      if (new Set(requestedIds).size !== requestedIds.length) throw new Error('duplicate_case_id_selector');
      selectedCases = requestedIds.map((caseId) => {
        const candidate = input.cases.find((entry) => entry.caseId === caseId);
        if (!candidate) throw new Error('requested_case_id_not_in_fixed_panel');
        return candidate;
      });
    } else if (exactCaseId) {
      const candidate = input.cases.find((entry) => entry.caseId === exactCaseId);
      if (!candidate) throw new Error('requested_case_id_not_in_fixed_panel');
      selectedCases = [candidate];
    } else {
      selectedCases = input.cases.slice(0, maxCasesValue);
    }
    const maxTasks = executionPurpose === 'smoke' ? Number(arg('--max-tasks', '2')) : undefined;
    const maxTurnsTotal = executionPurpose === 'smoke' ? Number(arg('--max-turns-total', '4')) : undefined;
    const maxTurnsPerTask = executionPurpose === 'smoke' ? Number(arg('--max-turns-per-task', '1')) : undefined;
    if (executionPurpose === 'smoke' && (!Number.isSafeInteger(maxTasks) || maxTasks < 1 || maxTasks > 2
      || !Number.isSafeInteger(maxTurnsTotal) || maxTurnsTotal < 1 || maxTurnsTotal > 4
      || !Number.isSafeInteger(maxTurnsPerTask) || maxTurnsPerTask !== 1)) {
      throw new Error('discovery_resource_limits_exceed_benchmark_ceiling');
    }
    const expectedRuntimeSha = arg('--expected-runtime-sha', '', argv);
    if (executionPurpose === 'qualification' || executionPurpose === 'baseline') {
      if (executionPurpose === 'baseline') {
        assertV1BaselineRuntime({ expectedRuntimeSha, runtimeIdentity, transportEnv: process.env });
      } else {
        if (expectedRuntimeSha === V1_BASELINE_RUNTIME_SHA) throw new Error('v1_baseline_cannot_be_qualified_as_revised');
        assertQualificationRuntime({ expectedRuntimeSha, runtimeIdentity, transportEnv: process.env });
      }
      assertBlindDiscoveryInputCases(selectedCases);
    }
    const panelSourceCoverage = executionPurpose === 'qualification' || executionPurpose === 'baseline' ? {
      fixedPanelCases: input.cases.length,
      completeTextSourceCaseIds: input.cases.filter((entry) => (entry.sourceOmissions || []).length === 0)
        .map((entry) => entry.caseId),
      textScopeOnlyDiagnosticCaseIds: input.cases.filter((entry) => (entry.sourceOmissions || []).length > 0
        && (entry.sourceOmissions || []).every((omission) => omission === 'binary_patch')).map((entry) => entry.caseId),
      incompleteSourceCaseIds: input.cases.filter((entry) => (entry.sourceOmissions || []).some((omission) => omission !== 'binary_patch'))
        .map((entry) => entry.caseId),
    } : null;
    for (const inputCase of selectedCases) {
      const prCase = expectedCases.get(inputCase.caseId);
      if (inputCase.repository !== prCase.repository || inputCase.prNumber !== prCase.prNumber
        || inputCase.baseSha !== prCase.baseSha || inputCase.headSha !== prCase.headSha
        || (prCase.datasetBaseSha && inputCase.datasetBaseSha !== prCase.datasetBaseSha)
        || (prCase.diffBaseSha && inputCase.diffBaseSha !== prCase.diffBaseSha)
        || (prCase.mergeBaseSha && inputCase.mergeBaseSha !== prCase.mergeBaseSha)) {
        throw new Error('discovery input source identity differs from the pinned manifest');
      }
      const snapshot = {
        ...inputCase,
        repository: inputCase.repository,
        baseSha: inputCase.baseSha,
        headSha: inputCase.headSha,
        datasetBaseSha: inputCase.datasetBaseSha || prCase.datasetBaseSha || prCase.baseSha,
        diffBaseSha: inputCase.diffBaseSha || prCase.diffBaseSha || prCase.baseSha,
        mergeBaseSha: inputCase.mergeBaseSha || prCase.mergeBaseSha || prCase.baseSha,
        sourceRepoDir: publicRepoCacheDirectory(inputCase.repository, cacheRoot),
        omissions: inputCase.sourceOmissions || [],
        preparedCaseSha256: sha256(JSON.stringify(inputCase)),
      };
      const result = await runActualDiscoveryCase(prCase, snapshot, runtime, {
        ...(executionPurpose === 'smoke' ? { maxTasks, maxTurnsTotal, maxTurnsPerTask } : {
          purpose: executionPurpose, sourcePolicy, sourcePolicySha256, effortProfile,
          effortInjection, verificationReserveTurns,
        }),
      });
      results.push({ caseId: inputCase.caseId, repository: inputCase.repository, prNumber: inputCase.prNumber,
        language: inputCase.language, ...result });
    }
    const completed = results.filter((entry) => entry.status === 'completed').length;
    const out = arg('--out', path.join(os.tmpdir(), 'review-yeti-aacr-discovery-run.json'));
    if (executionPurpose === 'qualification' || executionPurpose === 'baseline') {
      const sourceComplete = results.filter((entry) => entry.status === 'completed').length;
      const diagnostics = results.filter((entry) => entry.status === 'diagnostic_text_scope_only').length;
      const disposition = discoveryQualificationDisposition({
        purpose: executionPurpose, completed: sourceComplete, total: selectedCases.length,
      });
      writeJson(out, {
        schemaVersion: 'review-yeti-discovery-run-v1',
        task: 'discovery',
        benchmark: AACR_BENCHMARK.name,
        datasetSha256: input.datasetSha256,
        heldoutManifestSha256,
        preparedInputSha256: preparedInput.sha256,
        sourceSnapshotVerification: SOURCE_SNAPSHOT_VERIFICATION,
        runtime: runtimeIdentity,
        panelCaseIds: input.cases.map((entry) => entry.caseId),
        selectedCaseIds: selectedCases.map((entry) => entry.caseId),
        panelSize: input.cases.length,
        panelSourceCoverage,
        executionPurpose: executionPurpose === 'qualification' ? 'actual_production_entrypoint_qualification_input'
          : 'actual_production_entrypoint_v1_baseline_input',
        policy: {
          sourcePolicySourceRevision: V1_POLICY_PROVENANCE.revision,
          sourcePolicySourceSha256: V1_POLICY_PROVENANCE.sourceSha256,
          policyProjectionFileSha256: sourcePolicySha256,
          materialization: 'local_benchmark_policy_projection_not_authenticated_service_admission',
          effortProfile,
          effortInjection: effortInjection ? 'benchmark_adapter_injected' : 'runtime_native',
          verifierMode: verificationReserveTurns === 12 ? 'production_independent_verifier_required'
            : 'absent_in_selected_v1_baseline',
        },
        requestedResourceLimits: discoveryResourceProfile(sourcePolicy, { verificationReserveTurns, env: process.env }),
        sourceCoverage: {
          selectedSubsetSize: selectedCases.length,
          fixedPanelCompleteTextSourceCases: panelSourceCoverage.completeTextSourceCaseIds.length,
          fixedPanelTextScopeOnlyDiagnostics: panelSourceCoverage.textScopeOnlyDiagnosticCaseIds.length,
          fixedPanelIncompleteSourceCases: panelSourceCoverage.incompleteSourceCaseIds.length,
          completeTextSourceCases: sourceComplete,
          textScopeOnlyDiagnostics: diagnostics,
          incompleteCases: results.length - sourceComplete - diagnostics,
          omittedCaseIds: results.filter((entry) => entry.status === 'incomplete').map((entry) => entry.caseId),
        },
        cases: results,
        completion: {
          completed: sourceComplete,
          total: results.length,
          allRuntimeReceiptsComplete: sourceComplete === results.length,
        },
        qualificationStatus: disposition.status,
        qualification: disposition.reason,
        qualityScore: null,
        competitorComparison: 'not_performed',
      });
      process.stdout.write(JSON.stringify({ status: 'run_recorded', selectedCases: results.length,
        completedTextSourceCases: sourceComplete, diagnosticTextOnlyCases: diagnostics,
        incompleteCases: results.length - sourceComplete - diagnostics }) + '\n');
      return 0;
    }
    writeJson(out, {
      schemaVersion: 'review-yeti-discovery-run-v1',
      task: 'discovery',
      benchmark: AACR_BENCHMARK.name,
      datasetSha256: input.datasetSha256,
      heldoutManifestSha256,
      preparedInputSha256: preparedInput.sha256,
      sourceSnapshotVerification: SOURCE_SNAPSHOT_VERIFICATION,
      runtime: runtimeIdentity,
      panelCaseIds: input.cases.map((entry) => entry.caseId),
      selectedCaseIds: selectedCases.map((entry) => entry.caseId),
      panelSize: input.cases.length,
      executionPurpose: 'production_entrypoint_runtime_smoke_only',
      requestedResourceLimits: { maxTasks, maxTurnsTotal, maxTurnsPerTask },
      cases: results,
      completion: { completed, total: results.length, allRuntimeReceiptsComplete: completed === results.length },
      qualification: 'not_established_by_runtime_smoke_or_AACR_reference_match_alone',
    });
    process.stdout.write(JSON.stringify({ status: completed === results.length ? 'complete' : 'incomplete', cases: results.length, completed }) + '\n');
    return completed === results.length ? 0 : 2;
  }
  if (command === 'score-discovery') {
    const rows = loadPinnedAacrDataset(arg('--dataset', ''));
    const manifestBytes = fs.readFileSync(path.resolve(arg('--manifest',
      path.join(repoRoot, 'eval-baselines/competitive-review-benchmark/aacr-heldout-v1.json'))));
    const { manifest, sha256: heldoutManifestSha256 } = assertCanonicalHeldoutManifestBytes(manifestBytes);
    const run = readJson(arg('--run', path.join(os.tmpdir(), 'review-yeti-aacr-discovery-run.json')));
    if (run.datasetSha256 !== AACR_BENCHMARK.sha256 || !Array.isArray(run.cases)) throw new Error('discovery run is not pinned to AACR data');
    if (run.heldoutManifestSha256 !== heldoutManifestSha256) throw new Error('discovery_run_manifest_digest_mismatch');
    const preparedInputSha256 = requirePreparedInputReceipt(run);
    assertDiscoveryRunEligible(run);
    const ids = manifestCaseIds(manifest);
    const generatedByPr = new Map(run.cases.map((entry) => [`${entry.repository}#${entry.prNumber}`, entry.findings || []]));
    const attached = new Set();
    const scoreRows = rows.filter((row) => {
      const parsed = parsePrUrl(row.pr_url);
      return ids.has(`${parsed.repository}#${parsed.prNumber}`);
    }).map((row) => {
      const parsed = parsePrUrl(row.pr_url);
      const prId = `${parsed.repository}#${parsed.prNumber}`;
      if (attached.has(prId)) return { ...row, findings: [] };
      attached.add(prId);
      return { ...row, findings: generatedByPr.get(prId) || [] };
    });
    const adjudicationBundle = arg('--adjudications') ? readJson(arg('--adjudications')) : null;
    const scored = scoreDiscoveryCases(scoreRows, manifest, adjudicationBundle);
    const output = {
      ...scored,
      preparedInputSha256,
      heldoutManifestSha256,
      sourceSnapshotVerification: run.sourceSnapshotVerification || 'unknown',
      runtime: run.runtime,
      runtimeCompletion: run.completion,
      discoveryQualification: 'not_established_by_AACR_reference_match_alone',
    };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return 0;
  }
  if (command === 'run-verification') {
    const preparedInput = readPreparedInput(arg('--cases', path.join(os.tmpdir(), 'review-yeti-aacr-verification-input.json')));
    const input = preparedInput.value;
    if (input.datasetSha256 !== AACR_BENCHMARK.sha256 || !Array.isArray(input.cases)) throw new Error('verification case bundle is not pinned');
    const manifestBytes = fs.readFileSync(path.resolve(arg('--manifest',
      path.join(repoRoot, 'eval-baselines/competitive-review-benchmark/aacr-heldout-v1.json'))));
    const { sha256: heldoutManifestSha256 } = assertCanonicalHeldoutManifestBytes(manifestBytes);
    if (input.heldoutManifestSha256 !== heldoutManifestSha256) throw new Error('verification_input_manifest_digest_mismatch');
    const runtimeRoot = path.resolve(arg('--runtime-root', repoRoot));
    const runtime = loadRuntime(runtimeRoot);
    const transportName = arg('--transport', '');
    const modelConfig = assertActualModelConfig(runtime.pipeline, { transportName });
    const maxOutputTokens = Number(arg('--max-output-tokens', '4096'));
    const requestedLimit = Number(arg('--max-cases', String(input.cases.length)));
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) throw new Error('max_cases_must_be_positive_integer');
    const maxCases = Math.min(requestedLimit, input.cases.length);
    const selectedCases = [];
    const exactCaseId = arg('--case-id', '', argv);
    const exactCaseIdsText = arg('--case-ids', '', argv);
    if (exactCaseId && exactCaseIdsText) throw new Error('choose_one_verification_case_selector');
    if (exactCaseIdsText) {
      if (argv.includes('--max-cases')) throw new Error('exact_verification_case_set_rejects_max_cases');
      const requestedIds = exactCaseIdsText.split(',').filter(Boolean);
      if (requestedIds.length === 0 || new Set(requestedIds).size !== requestedIds.length) {
        throw new Error('verification_case_ids_must_be_nonempty_and_unique');
      }
      for (const caseId of requestedIds) {
        const candidate = input.cases.find((entry) => entry.caseId === caseId);
        if (!candidate) throw new Error('requested_verification_case_id_not_in_fixed_panel');
        selectedCases.push(candidate);
      }
    } else if (exactCaseId) {
      const candidate = input.cases.find((entry) => entry.caseId === exactCaseId);
      if (!candidate) throw new Error('requested_case_id_not_in_fixed_panel');
      selectedCases.push(candidate);
    } else {
      for (const context of CONTEXT_ORDER) {
        const candidate = input.cases.find((entry) => entry.context === context && entry.referencePathChanged === true
          && Array.isArray(entry.changedFiles) && entry.changedFiles.some((file) => file.path === entry.finding?.path));
        if (candidate && !selectedCases.some((entry) => entry.caseId === candidate.caseId) && selectedCases.length < maxCases) {
          selectedCases.push(candidate);
        }
      }
      for (const entry of input.cases) {
        if (selectedCases.length >= maxCases) break;
        if (!selectedCases.some((candidate) => candidate.caseId === entry.caseId)) selectedCases.push(entry);
      }
    }
    const results = [];
    for (const testCase of selectedCases) results.push(await runActualVerificationCase(testCase, {
      changedFiles: testCase.changedFiles,
      omissions: testCase.sourceOmissions || [],
    }, runtime.pipeline, { maxOutputTokens, transportName, falsification: runtime.falsification }));
    const complete = results.filter((entry) => entry.status === 'completed').length;
    writeJson(arg('--out', path.join(os.tmpdir(), 'review-yeti-aacr-verification-run.json')), {
      schemaVersion: 'review-yeti-verification-run-v1',
      task: 'comment-verification',
      lane: 'production_finding_falsification_only',
      benchmark: AACR_BENCHMARK.name,
      datasetSha256: input.datasetSha256,
      heldoutManifestSha256,
      preparedInputSha256: preparedInput.sha256,
      sourceSnapshotVerification: SOURCE_SNAPSHOT_VERIFICATION,
      panelCaseIds: input.cases.map((entry) => entry.caseId),
      selectedCaseIds: selectedCases.map((entry) => entry.caseId),
      panelSize: input.cases.length,
      selectedCaseCount: selectedCases.length,
      requestedActualCallCeiling: Math.min(maxCases, selectedCases.length),
      runtime: runtimeGitIdentity(runtimeRoot),
      requestedConfiguration: {
        transport: modelConfig.selectedTransport,
        maxOutputTokens,
        servingIdentity: 'unverified',
      },
      cases: results,
    });
    process.stdout.write(JSON.stringify({ status: complete === results.length ? 'complete' : 'incomplete', cases: results.length, completed: complete }) + '\n');
    return complete === results.length ? 0 : 2;
  }
  if (command === 'score-verification') {
    const rows = loadPinnedAacrDataset(arg('--dataset', ''));
    const manifestBytes = fs.readFileSync(path.resolve(arg('--manifest',
      path.join(repoRoot, 'eval-baselines/competitive-review-benchmark/aacr-heldout-v1.json'))));
    const { manifest, sha256: heldoutManifestSha256 } = assertCanonicalHeldoutManifestBytes(manifestBytes);
    const testCases = buildVerificationCases(rows, manifest, { perLabelPerPr: Number(arg('--per-label-per-pr-context', '1')) });
    const run = readJson(arg('--run', path.join(os.tmpdir(), 'review-yeti-aacr-verification-run.json')));
    if (run.datasetSha256 !== AACR_BENCHMARK.sha256 || !Array.isArray(run.cases)) throw new Error('verification run is not pinned to AACR data');
    if (run.heldoutManifestSha256 !== heldoutManifestSha256) throw new Error('verification_run_manifest_digest_mismatch');
    const requestedCaseIdsText = arg('--case-ids', '', argv);
    let selectedTestCases = testCases;
    if (manifest.schemaVersion === 'review-yeti-ws5-heldout-manifest-v1') {
      if (!requestedCaseIdsText) throw new Error('ws5_verification_score_requires_exact_case_ids');
      const requestedIds = requestedCaseIdsText.split(',').filter(Boolean);
      assertExactCaseIdSet(run.selectedCaseIds, requestedIds);
      const casesById = new Map(testCases.map((entry) => [entry.id, entry]));
      selectedTestCases = requestedIds.map((caseId) => {
        const entry = casesById.get(caseId);
        if (!entry) throw new Error('verification_score_case_id_not_in_fixed_panel');
        return entry;
      });
    } else if (requestedCaseIdsText) {
      const requestedIds = requestedCaseIdsText.split(',').filter(Boolean);
      assertExactCaseIdSet(run.selectedCaseIds, requestedIds);
      const casesById = new Map(testCases.map((entry) => [entry.id, entry]));
      selectedTestCases = requestedIds.map((caseId) => {
        const entry = casesById.get(caseId);
        if (!entry) throw new Error('verification_score_case_id_not_in_fixed_panel');
        return entry;
      });
    }
    const preparedInputSha256 = requirePreparedInputReceipt(run);
    const scored = scoreVerificationCases(selectedTestCases, run.cases || []);
    process.stdout.write(`${JSON.stringify({
      ...scored,
      preparedInputSha256,
      sourceSnapshotVerification: run.sourceSnapshotVerification || 'unknown',
    }, null, 2)}\n`);
    return scored.completed === scored.cases ? 0 : 2;
  }
  process.stderr.write('usage: competitive-review-benchmark.mjs <manifest|prepare-verification|run-verification|score-verification> [options]\n');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv);
  } catch (error) {
    const candidate = String(error?.message || error);
    const safeCode = /^[A-Za-z0-9_-]{1,100}$/u.test(candidate) ? candidate : 'runtime_error';
    process.stderr.write(`benchmark failed closed: ${safeCode}\n`);
    process.exitCode = 2;
  }
}
