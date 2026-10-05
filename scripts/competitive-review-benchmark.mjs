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

const require = createRequire(import.meta.url);

export const AACR_BENCHMARK = Object.freeze({
  name: 'AACR-Bench',
  dataset: 'Alibaba-Aone/aacr-bench',
  revision: '47be1d6df1e7faf222cf531587772d92f79fe6b2',
  sha256: '0804505f0a474765ce2840c832cfeaa6c4f0250dd6ccb169fe73c6758b245a86',
  rowCount: 2145,
  license: 'Apache-2.0',
});

export const HELDOUT_LANGUAGES = Object.freeze([
  'C', 'C#', 'C++', 'Go', 'Java', 'JavaScript', 'PHP', 'Python', 'Rust', 'TypeScript',
]);

const SPLIT_SALT = 'review-yeti-ws5-v1|';
const CASE_SALT = 'review-yeti-ws5-selection-v1|';
const CONTEXT_ORDER = Object.freeze(['Diff Level', 'File Level', 'Repo Level']);
const HASH_RE = /^[a-f0-9]{40}$/iu;
const SHA256_RE = /^[a-f0-9]{64}$/iu;
const SOURCE_SNAPSHOT_VERIFICATION = 'preparation_stage_only_not_reverified_at_run';
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
  if (!manifest || manifest.schemaVersion !== 'review-yeti-competitive-benchmark-manifest-v1'
    || manifest.datasetSha256 !== AACR_BENCHMARK.sha256 || !Array.isArray(manifest.cases)) {
    throw new Error('benchmark manifest is incompatible with the pinned AACR dataset');
  }
  return new Set(manifest.cases.map((entry) => `${entry.repository}#${entry.prNumber}`));
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

export function assertActualModelConfig(pipeline, { transportName = '' } = {}) {
  const config = pipeline.resolveModelConfig();
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
  return {
    ...config,
    apiKey: '',
    transports: [{ ...selected }],
    selectedTransport: {
      name: safeRuntimeId(selected.name || selected.provider || 'unknown', 120),
      requestedModel: safeRuntimeId(selected.model || config.model || 'unknown'),
    },
  };
}

export function trackCompletion(fetchImplementation, identity) {
  return async (url, init) => {
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
    let response;
    try {
      response = await fetchImplementation(url, init);
    } catch (error) {
      identity.fetchToHeadersMs.push(Date.now() - startedAt);
      const code = String(error?.cause?.code || '').toUpperCase();
      identity.fetchFailureClasses.add(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET'].includes(code)
        ? code : error?.name === 'AbortError' ? 'ABORTED' : 'TRANSPORT_ERROR');
      throw error;
    }
    identity.fetchToHeadersMs.push(Date.now() - startedAt);
    for (const name of ['x-request-id', 'x-bifrost-request-id', 'x-gateway-request-id']) {
      const requestId = response.headers.get(name);
      if (requestId) identity.requestIdDigests.add(sha256(requestId).slice(0, 16));
    }
    for (const name of ['x-provider', 'x-provider-name', 'x-bifrost-provider', 'x-model', 'x-bifrost-model']) {
      const routeHint = response.headers.get(name);
      if (routeHint) identity.responseRouteHints.add(safeRuntimeId(routeHint, 120));
    }
    if (!profile.stream) {
      // Capture buffered response metadata in the background. Never read or tee a live SSE body:
      // that would change backpressure, first-token timing, or the production client's stream.
      const metadataRead = response.clone().json().then((payload) => {
        if (typeof payload?.model === 'string' && payload.model.trim()) identity.responseModels.add(safeRuntimeId(payload.model));
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

export function identitySummary(identity) {
  const values = (set) => [...set].sort();
  const requestedModels = values(identity.requestedModels);
  const responseModels = values(identity.responseModels);
  return {
    requestedModels,
    responseReportedModels: responseModels,
    responseReportedProviders: values(identity.responseProviders),
    responseRouteHints: values(identity.responseRouteHints),
    requestIdDigests: values(identity.requestIdDigests),
    fetchToHeadersMs: identity.fetchToHeadersMs,
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
  const result = await falsify.runFindingFalsification({
    findings: [finding],
    changedFiles,
    limits: { maxCandidates: 1, maxCalls: 1, concurrency: 1 },
    falsifyTurn: ({ messages, timeoutMs, signal }) => pipeline.callFalsificationModelTurn(
      { messages, timeoutMs, signal },
      { ...modelConfig, maxOutputTokens, fetchImplementation: trackCompletion(globalThis.fetch, identity) },
    ),
  });
  const outcome = result.outcomes[0] || { verdict: 'ABSTAIN', reason: 'missing_outcome' };
  await Promise.allSettled(identity.pendingResponseMetadataReads);
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
    requestProfiles: [...identity.requestProfiles.values()],
    ...identitySummary(identity),
  };
}

function arg(name, fallback = undefined, argv = process.argv) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

function runtimeGitIdentity(runtimeRoot) {
  try {
    const commit = String(runGit(['rev-parse', 'HEAD'], runtimeRoot)).trim();
    const version = readJson(path.join(runtimeRoot, 'package.json')).version || null;
    return { commit, version };
  } catch {
    return { commit: 'unknown', version: null };
  }
}

function loadRuntime(runtimeRoot) {
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

function createGitSnapshotFileProvider(repoDir, prCase, createPathMatcher) {
  const pathsBySha = new Map();
  const contents = new Map();
  const safePath = (value) => typeof value === 'string' && value.length > 0
    && !value.startsWith('/') && !value.split('/').some((part) => part === '..' || part === '.');
  const pathsAt = (sha) => {
    if (!pathsBySha.has(sha)) {
      const paths = runGit(['ls-tree', '-r', '--name-only', '-z', sha], repoDir).split('\0').filter(Boolean);
      pathsBySha.set(sha, paths.filter(safePath));
    }
    return pathsBySha.get(sha);
  };
  const read = (sha, filePath) => {
    if (!safePath(filePath)) return null;
    const key = `${sha}:${filePath}`;
    if (!contents.has(key)) {
      try { contents.set(key, runGit(['show', key], repoDir)); }
      catch { contents.set(key, null); }
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
      return pathsAt(prCase.headSha).filter((filePath) => matches(filePath));
    },
    async readFile(filePath) { return read(prCase.headSha, filePath); },
    async treeTruncated() { return false; },
    sourceReadOmissions() { return []; },
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
  const findings = (Array.isArray(panelResult.personas) ? panelResult.personas : []).flatMap((persona, laneIndex) =>
    (Array.isArray(persona?.findings) ? persona.findings : []).map((finding, findingIndex) => ({
      id: `finding-${laneIndex + 1}-${findingIndex + 1}-${sha256(`${finding?.path || ''}:${finding?.line || ''}:${finding?.title || ''}`).slice(0, 12)}`,
      severity: safeRuntimeId(finding?.severity || 'unknown', 12),
      path: String(finding?.path || ''),
      line: Number.isSafeInteger(Number(finding?.line)) ? Number(finding.line) : null,
      lane: safeRuntimeId(persona?.id || 'unknown', 80),
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
  return {
    findings,
    taskPlan: Array.isArray(panelResult.taskPlan) ? panelResult.taskPlan.map((task) => ({
      id: safeRuntimeId(task?.id || '', 120),
      dimension: safeRuntimeId(task?.dimension || 'unknown', 80),
      paths: Array.isArray(task?.paths) ? task.paths.map((value) => String(value)) : [],
    })) : [],
    coverageComplete: panelResult.coverageComplete ?? grounded?.coverageComplete ?? null,
    quorumSatisfied: panelResult.quorumSatisfied ?? grounded?.quorumSatisfied ?? null,
    // Free-form decision/verifier reason strings can contain model or source text. Keep only
    // structured receipt fields in the public proof artifact.
    reviewDecision: summaryObject(panelResult.reviewDecision || grounded?.reviewDecision, ['schemaVersion', 'classification', 'blockingFindingCount', 'advisoryFindingCount', 'eligible']),
    history: summaryObject(history, ['status', 'snapshotId', 'eventCount', 'findingCount', 'legacyOmittedCount', 'eventsDigest', 'findingsDigest', 'omissions', 'pagesRead', 'complete']),
    verification: summaryObject(verification, ['candidates', 'confirmed', 'contradicted', 'insufficient', 'coverageComplete', 'omissions']),
    verifierOutcomes: Array.isArray(grounded?.verifierOutcomes || panelResult.verifierOutcomes)
      ? (grounded?.verifierOutcomes || panelResult.verifierOutcomes).map((outcome) => ({
        verdict: safeRuntimeId(outcome?.verdict || 'unknown', 20),
      })) : [],
    incompleteReasons: Array.isArray(grounded?.incompleteReasons || panelResult.incompleteReasons)
      ? (grounded?.incompleteReasons || panelResult.incompleteReasons).map((reason) => safeRuntimeId(reason, 120)) : [],
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
  maxTasks = 2,
  maxTurnsTotal = 4,
  maxTurnsPerTask = 1,
} = {}) {
  const sourceOmissions = snapshot.omissions || [];
  const requiredSourceOmissions = sourceOmissions.filter((entry) => entry !== 'binary_patch');
  if (requiredSourceOmissions.length || !Array.isArray(snapshot.changedFiles) || snapshot.changedFiles.length === 0) {
    return { status: 'incomplete', reason: requiredSourceOmissions[0] || sourceOmissions[0] || 'empty_diff', findings: [] };
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
    REVIEW_RUN_ID: `run_${sha256(`${prCase.repository}#${prCase.prNumber}|${prCase.headSha}`).slice(0, 32)}`,
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
    REVIEW_POLICY_DIGEST: sha256(`benchmark-policy|${model}|${maxTasks}|${maxTurnsTotal}|${maxTurnsPerTask}`),
    REVIEW_CONFIG_DIGEST: sha256(`benchmark-config|${prCase.repository}|${prCase.headSha}|${model}`),
    REVIEW_YETI_POLICY_JSON: JSON.stringify({
      review_engine: 'composed',
      personas: ['security'],
      budget: { max_investigation_turns: Math.max(1, maxTurnsTotal) },
      composed: { max_tasks: maxTasks, max_turns_total: maxTurnsTotal, max_turns_per_task: maxTurnsPerTask },
    }),
  };
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
  const client = {
    async complete(request) {
      callCount += 1;
      const response = await realClient.complete(request);
      if (typeof response?.model === 'string' && response.model.trim()) {
        modelIdentity.responseModels.add(safeRuntimeId(response.model));
      }
      return response;
    },
  };
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
      activeFileProvider = snapshot.sourceAdapter === 'github_exact_commit_trees_and_raw_blobs'
        ? createApiSnapshotFileProvider(snapshot, prCase, runtime.createPathMatcher)
        : createGitSnapshotFileProvider(snapshot.sourceRepoDir, { ...prCase, changedFiles: snapshot.changedFiles }, runtime.createPathMatcher);
      return activeFileProvider;
    },
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
    receipt = await runtime.publishing.runPublishingReviewWorker(runtimeEnv, deps);
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
  const sourceReadOmissions = activeFileProvider?.sourceReadOmissions?.() || [];
  const panel = sanitizePanelResult(selection.result);
  return {
    status: receipt.verdict === 'INCOMPLETE' || receipt.coverage.quorumSatisfied !== true
      || sourceOmissions.length > 0 || sourceReadOmissions.length > 0 ? 'incomplete' : 'completed',
    runtimeEntryPoint: 'runPublishingReviewWorker',
    runtimeLane: 'production_selected_composed_discovery',
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
      defaultEngineQualification: 'not_claimed',
    },
    source: {
      repository: prCase.repository,
      prNumber: prCase.prNumber,
      baseSha: prCase.baseSha,
      headSha: prCase.headSha,
      changedFiles: snapshot.changedFiles.length,
      changedPatchChars: diff.length,
      sourceOmissions,
      sourceReadOmissions,
      adapters: { sourceLoader: snapshot.sourceAdapter || 'pinned_git_objects', repoFileProvider: snapshot.sourceAdapter || 'pinned_git_objects', checkClient: 'no_write_stub', currentHeadFence: 'pinned_snapshot' },
    },
    receipt: {
      version: receipt.version,
      verdict: receipt.verdict,
      conclusion: receipt.conclusion,
      coverage: receipt.coverage,
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
    },
    model: {
      transport: 'Bifrost',
      requestedAlias: model,
      ...identitySummary(modelIdentity),
      requestedEfforts: [...modelIdentity.requestProfiles.values()].map((entry) => entry.reasoningEffort),
      requestProfiles: [...modelIdentity.requestProfiles.values()],
      servingIdentity: modelIdentity.responseModels.size > 0
        && [...modelIdentity.responseModels].some((responseModel) => !modelIdentity.requestedModels.has(responseModel))
        ? 'response_reported_unverified' : 'unknown',
      upstreamProviderIdentity: 'unknown',
      calls: callCount,
    },
    runtimeReceipt: panel,
    githubWrites: 0,
    publication: 'disabled_in_benchmark_adapter',
  };
}

export async function main(argv = process.argv) {
  const command = argv[2];
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (command === 'manifest') {
    const rows = loadPinnedAacrDataset(arg('--dataset', ''));
    const manifest = buildAacrManifest(rows);
    writeJson(arg('--out', path.join(repoRoot, 'eval-baselines/competitive-review-benchmark/aacr-heldout-v1.json')), manifest);
    process.stdout.write(JSON.stringify({ status: 'written', heldoutCaseCount: manifest.heldoutCaseCount, datasetSha256: manifest.datasetSha256 }) + '\n');
    return 0;
  }
  if (command === 'prepare-verification') {
    const rows = loadPinnedAacrDataset(arg('--dataset', ''));
    const manifest = readJson(arg('--manifest', path.join(repoRoot, 'eval-baselines/competitive-review-benchmark/aacr-heldout-v1.json')));
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
        sourceIdentity: { repository: snapshot.repository, baseSha: snapshot.baseSha, headSha: snapshot.headSha },
        referencePathChanged: Boolean(matchedFile),
        sourceOmissions: snapshot.omissions,
      };
      outputCases.push(result);
    }
    writeJson(arg('--out', path.join(os.tmpdir(), 'review-yeti-aacr-verification-input.json')), {
      schemaVersion: 'review-yeti-verification-cases-v1',
      datasetSha256: AACR_BENCHMARK.sha256,
      cases: outputCases,
    });
    const strata = Object.fromEntries(CONTEXT_ORDER.map((context) => [context, outputCases.filter((entry) => entry.context === context).length]));
    process.stdout.write(JSON.stringify({ status: 'prepared', cases: outputCases.length, strata, sourceOmissions: outputCases.filter((entry) => entry.sourceOmissions.length).length }) + '\n');
    return 0;
  }
  if (command === 'prepare-discovery') {
    const manifest = readJson(arg('--manifest', path.join(repoRoot, 'eval-baselines/competitive-review-benchmark/aacr-heldout-v1.json')));
    manifestCaseIds(manifest);
    const cacheRoot = path.resolve(arg('--cache', path.join(os.tmpdir(), 'review-yeti-aacr-public-repos')));
    const cases = [];
    for (const prCase of manifest.cases) {
      const snapshot = await loadPublicPrSnapshot(prCase, cacheRoot);
      cases.push({
        caseId: prCase.id,
        repository: prCase.repository,
        prNumber: prCase.prNumber,
        language: prCase.language,
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
    writeJson(out, { schemaVersion: 'review-yeti-discovery-cases-v1', datasetSha256: AACR_BENCHMARK.sha256, cases });
    process.stdout.write(JSON.stringify({ status: 'prepared', cases: cases.length,
      sourceOmissions: cases.filter((entry) => entry.sourceOmissions.length).length,
      changedFiles: cases.reduce((total, entry) => total + entry.changedFiles.length, 0) }) + '\n');
    return 0;
  }
  if (command === 'run-discovery') {
    const preparedInput = readPreparedInput(arg('--cases', path.join(os.tmpdir(), 'review-yeti-aacr-discovery-input.json')));
    const input = preparedInput.value;
    if (input.datasetSha256 !== AACR_BENCHMARK.sha256 || !Array.isArray(input.cases)) throw new Error('discovery case bundle is not pinned');
    const manifest = readJson(arg('--manifest', path.join(repoRoot, 'eval-baselines/competitive-review-benchmark/aacr-heldout-v1.json')));
    const expectedCases = new Map(manifest.cases.map((entry) => [entry.id, entry]));
    if (input.cases.length !== expectedCases.size || input.cases.some((entry) => !expectedCases.has(entry.caseId))) {
      throw new Error('discovery input case IDs differ from the fixed held-out panel');
    }
    const runtimeRoot = path.resolve(arg('--runtime-root', repoRoot));
    const cacheRoot = path.resolve(arg('--cache', path.join(os.tmpdir(), 'review-yeti-aacr-public-repos')));
    const runtime = loadRuntime(runtimeRoot);
    const runtimeIdentity = runtimeGitIdentity(runtimeRoot);
    const results = [];
    const maxCasesValue = Number(arg('--max-cases', '1'));
    if (!Number.isSafeInteger(maxCasesValue) || maxCasesValue < 1 || maxCasesValue > input.cases.length) {
      throw new Error('max_cases_must_be_between_one_and_fixed_panel_size');
    }
    const executionPurpose = arg('--purpose', 'smoke', argv);
    if (executionPurpose !== 'smoke') {
      throw new Error('discovery_evaluation_requires_accepted_history_verifier_and_adjudication_adapter');
    }
    const exactCaseId = arg('--case-id', '', argv);
    let selectedCases;
    if (exactCaseId) {
      const candidate = input.cases.find((entry) => entry.caseId === exactCaseId);
      if (!candidate) throw new Error('requested_case_id_not_in_fixed_panel');
      selectedCases = [candidate];
    } else {
      selectedCases = input.cases.slice(0, maxCasesValue);
    }
    const maxTasks = Number(arg('--max-tasks', '2'));
    const maxTurnsTotal = Number(arg('--max-turns-total', '4'));
    const maxTurnsPerTask = Number(arg('--max-turns-per-task', '1'));
    if (!Number.isSafeInteger(maxTasks) || maxTasks < 1 || maxTasks > 2
      || !Number.isSafeInteger(maxTurnsTotal) || maxTurnsTotal < 1 || maxTurnsTotal > 4
      || !Number.isSafeInteger(maxTurnsPerTask) || maxTurnsPerTask !== 1) {
      throw new Error('discovery_resource_limits_exceed_benchmark_ceiling');
    }
    for (const inputCase of selectedCases) {
      const prCase = expectedCases.get(inputCase.caseId);
      if (inputCase.repository !== prCase.repository || inputCase.prNumber !== prCase.prNumber
        || inputCase.baseSha !== prCase.baseSha || inputCase.headSha !== prCase.headSha) {
        throw new Error('discovery input source identity differs from the pinned manifest');
      }
      const snapshot = {
        ...inputCase,
        repository: inputCase.repository,
        baseSha: inputCase.baseSha,
        headSha: inputCase.headSha,
        sourceRepoDir: publicRepoCacheDirectory(inputCase.repository, cacheRoot),
        omissions: inputCase.sourceOmissions || [],
      };
      const result = await runActualDiscoveryCase(prCase, snapshot, runtime, {
        maxTasks,
        maxTurnsTotal,
        maxTurnsPerTask,
      });
      results.push({ caseId: inputCase.caseId, repository: inputCase.repository, prNumber: inputCase.prNumber,
        language: inputCase.language, ...result });
    }
    const completed = results.filter((entry) => entry.status === 'completed').length;
    const out = arg('--out', path.join(os.tmpdir(), 'review-yeti-aacr-discovery-run.json'));
    writeJson(out, {
      schemaVersion: 'review-yeti-discovery-run-v1',
      task: 'discovery',
      benchmark: AACR_BENCHMARK.name,
      datasetSha256: input.datasetSha256,
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
    const manifest = readJson(arg('--manifest', path.join(repoRoot, 'eval-baselines/competitive-review-benchmark/aacr-heldout-v1.json')));
    const run = readJson(arg('--run', path.join(os.tmpdir(), 'review-yeti-aacr-discovery-run.json')));
    if (run.datasetSha256 !== AACR_BENCHMARK.sha256 || !Array.isArray(run.cases)) throw new Error('discovery run is not pinned to AACR data');
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
    if (exactCaseId) {
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
      preparedInputSha256: preparedInput.sha256,
      sourceSnapshotVerification: SOURCE_SNAPSHOT_VERIFICATION,
      panelCaseIds: input.cases.map((entry) => entry.caseId),
      selectedCaseIds: selectedCases.map((entry) => entry.caseId),
      panelSize: input.cases.length,
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
    const manifest = readJson(arg('--manifest', path.join(repoRoot, 'eval-baselines/competitive-review-benchmark/aacr-heldout-v1.json')));
    const testCases = buildVerificationCases(rows, manifest, { perLabelPerPr: Number(arg('--per-label-per-pr-context', '1')) });
    const run = readJson(arg('--run', path.join(os.tmpdir(), 'review-yeti-aacr-verification-run.json')));
    if (run.datasetSha256 !== AACR_BENCHMARK.sha256 || !Array.isArray(run.cases)) throw new Error('verification run is not pinned to AACR data');
    const preparedInputSha256 = requirePreparedInputReceipt(run);
    const scored = scoreVerificationCases(testCases, run.cases || []);
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
