const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const { spawnSync } = require('child_process');

const SCOPE_SCHEMA_VERSION = 'review-scope-v1';
const MAX_CANDIDATE_ARTIFACTS = 25;
const MAX_DELTA_FILES = 25;

function sha256(value) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function buildReviewScopePlanDigest({ actionSha, baseSha, personaIds, maxDiffChars, maxIncrementalDiffChars, trustedWorkflow, trustedWorkflowSha, indexDigest, maxIncrementalChain }) {
  return sha256(JSON.stringify({
    schemaVersion: SCOPE_SCHEMA_VERSION,
    actionSha: String(actionSha || 'unbound').toLowerCase(),
    baseSha: String(baseSha || '').toLowerCase(),
    personaIds: [...(personaIds || [])],
    maxDiffChars: Number(maxDiffChars) || 0,
    maxIncrementalDiffChars: Number(maxIncrementalDiffChars) || 0,
    trustedWorkflow: String(trustedWorkflow || ''),
    trustedWorkflowSha: String(trustedWorkflowSha || '').toLowerCase(),
    // REL-552: the domain index drives lane planning and the chain cap bounds how many hops of
    // trusted-delta reuse are admitted. Either changing means an old report's plan digest no
    // longer matches, so it cannot silently keep authorizing reuse under a stale policy.
    indexDigest: String(indexDigest || ''),
    maxIncrementalChain: Number.isFinite(Number(maxIncrementalChain)) ? Number(maxIncrementalChain) : 0,
  }));
}

function splitWorkflowReference(value) {
  const workflowReference = String(value || '');
  const separator = workflowReference.lastIndexOf('@');
  if (separator < 1 || separator === workflowReference.length - 1) return null;
  return {
    path: workflowReference.slice(0, separator),
    ref: workflowReference.slice(separator + 1),
  };
}

function isTrustedWorkflowReference(reference, trustedWorkflows, trustedWorkflowSha) {
  const resolvedSha = String(reference?.sha || '').toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(resolvedSha)
    || resolvedSha !== String(trustedWorkflowSha || '').toLowerCase()) return false;

  const candidatePath = String(reference?.path || '');
  return trustedWorkflows.some((trustedWorkflow) => {
    if (candidatePath === trustedWorkflow) return true;

    // GitHub's run API shortens the `path` suffix to `@v1`, while job.workflow_ref
    // reports `@refs/heads/v1`. Accept that representation only when the API's
    // separate ref field proves the exact full ref and the workflow path is unchanged.
    const trusted = splitWorkflowReference(trustedWorkflow);
    const candidate = splitWorkflowReference(candidatePath);
    if (!trusted || !candidate || trusted.path !== candidate.path) return false;
    if (String(reference?.ref || '') !== trusted.ref) return false;
    const shortRef = trusted.ref.replace(/^refs\/(?:heads|tags)\//u, '');
    return shortRef !== trusted.ref && candidate.ref === shortRef;
  });
}

function createFullReviewScope({ fullDiffText, planDigest, fallbackReason = null }) {
  const digest = sha256(fullDiffText);
  return {
    schemaVersion: SCOPE_SCHEMA_VERSION,
    mode: 'full',
    planDigest,
    fullDiffDigest: digest,
    fullDiffChars: String(fullDiffText || '').length,
    reviewedDiffDigest: digest,
    reviewedDiffChars: String(fullDiffText || '').length,
    parentHeadSha: null,
    parentReportDigest: null,
    reviewedPersonaIds: [],
    reusedPersonaIds: [],
    ...(fallbackReason ? { fallbackReason } : {}),
  };
}

function isCompleteTrustedReport(report, expected) {
  if (!report || report.schemaVersion !== 'review-run-report-v1') return false;
  if (report.repository !== expected.repo || Number(report.prNumber) !== Number(expected.prNumber)) return false;
  if (report.baseSha !== expected.baseSha || report.headSha === expected.headSha) return false;
  if (!/^[0-9a-f]{40}$/iu.test(String(report.headSha || ''))) return false;
  if (!['SHIP', 'FIX_FIRST'].includes(report.verdict)) return false;
  if (report.scope?.schemaVersion !== SCOPE_SCHEMA_VERSION || report.scope.planDigest !== expected.planDigest) return false;
  if (!Array.isArray(report.lanes) || report.lanes.length !== expected.personaIds.length) return false;

  const expectedIds = new Set(expected.personaIds);
  const seen = new Set();
  for (const lane of report.lanes) {
    if (!lane || !expectedIds.has(lane.personaId) || seen.has(lane.personaId)) return false;
    if (!['APPROVE', 'FINDINGS'].includes(lane.decision) || !Array.isArray(lane.findings)) return false;
    seen.add(lane.personaId);
  }
  return seen.size === expectedIds.size;
}

function isBlockingFinding(finding) {
  return ['P0', 'P1'].includes(finding?.severity);
}

function laneFindings(lane) {
  return Array.isArray(lane?.findings) ? lane.findings : [];
}

/**
 * Plans which personas review the delta live, and which carry forward untouched parent
 * evidence, using the Master Domain Index (REL-551) instead of a hardcoded keyword regex.
 *
 * REL-552: the prior `selectIncrementalPersonaIds` forced any P0/P1 owner live regardless of
 * whether the delta touched anything that owner cares about. A blocking parent lane (e.g.
 * `security` owning a P1 on `lib/auth.ex`) forced live on an unrelated delta (a README typo)
 * reviewed ONLY that delta with no prior-findings context, found nothing, and the finding
 * dropped out of arbitration entirely once merged — silently laundering a FIX_FIRST into SHIP.
 * This planner never drops a dirty owner's evidence: an untouched dirty lane is carried forward
 * verbatim (`carriedDirty`) instead of being forced into a live lane that reviews nothing.
 *
 * Carry matrix (per persona in the roster):
 *   touched + clean   -> live
 *   touched + dirty   -> live
 *   untouched + clean -> carriedClean
 *   untouched + dirty -> carriedDirty  (parent findings re-asserted verbatim, zero model calls)
 *
 * "touched" = the persona id is reachable from `resolveFileDomains(path, index).personas` for
 * any delta file, OR the parent lane already owns a finding whose path is a delta file (the
 * pre-existing rule, kept so a reviewer that already flagged a file being edited again stays
 * live). "dirty" = the parent lane has any P0/P1 finding.
 *
 * Fail-closed: any delta file the index does not recognize (`matched: false`) forces every
 * roster persona live for this run -- an unrecognized file class is not a safe signal to carry
 * anything forward on. A recognized-but-personaless file (`matched: true, personas: []`, e.g. a
 * binary asset) contributes nothing and does not by itself trigger fail-closed.
 *
 * If domain resolution touches no persona at all (e.g. an image-only delta), the live set would
 * be empty; that is never a valid outcome (the gate requires at least one live lane so a
 * provider receipt exists), so it falls back to the same "one generalist" rule the old selector
 * used: `architecture` if present in the roster, else the roster's first persona.
 */
function planIncrementalLanes({ parentReport, deltaFiles, personaIds, index, resolveFileDomains }) {
  const roster = Array.isArray(personaIds) ? personaIds : [];
  const paths = (deltaFiles || []).map((file) => String(file.path || ''));
  const changedPathsLower = new Set(paths.map((path) => path.toLowerCase()));
  const parentLanesById = new Map((parentReport?.lanes || []).map((lane) => [lane.personaId, lane]));

  let failClosed = false;
  const touchedPersonas = new Set();
  const resolve = typeof resolveFileDomains === 'function' ? resolveFileDomains : null;
  if (!index || !resolve) {
    failClosed = true;
  } else {
    for (const filePath of paths) {
      const resolution = resolve(filePath, index);
      if (!resolution || resolution.matched !== true) {
        failClosed = true;
        continue;
      }
      for (const persona of resolution.personas || []) touchedPersonas.add(persona);
    }
  }

  const isDirty = (personaId) => laneFindings(parentLanesById.get(personaId)).some(isBlockingFinding);
  const ownsChangedFileFinding = (personaId) => laneFindings(parentLanesById.get(personaId))
    .some((finding) => changedPathsLower.has(String(finding?.path || '').toLowerCase()));

  const livePersonaIds = [];
  const carriedClean = [];
  const carriedDirty = [];

  for (const personaId of roster) {
    const touched = failClosed || touchedPersonas.has(personaId) || ownsChangedFileFinding(personaId);
    if (touched) {
      livePersonaIds.push(personaId);
    } else if (isDirty(personaId)) {
      carriedDirty.push(personaId);
    } else {
      carriedClean.push(personaId);
    }
  }

  let reason = failClosed ? 'unmatched_file' : 'domain_index';

  if (livePersonaIds.length === 0) {
    // One generalist owns every hunk. Architecture is the stable default; custom rosters fall
    // back to their first configured reviewer rather than silently leaving a hunk unassigned.
    const broadReviewer = roster.includes('architecture') ? 'architecture' : roster[0];
    if (broadReviewer) {
      livePersonaIds.push(broadReviewer);
      const cleanIndex = carriedClean.indexOf(broadReviewer);
      if (cleanIndex !== -1) carriedClean.splice(cleanIndex, 1);
      const dirtyIndex = carriedDirty.indexOf(broadReviewer);
      if (dirtyIndex !== -1) carriedDirty.splice(dirtyIndex, 1);
      reason = 'empty_live_fallback';
    }
  }

  const reviewFullDiff = livePersonaIds.some(isDirty);

  return { livePersonaIds, carriedClean, carriedDirty, reviewFullDiff, reason };
}

function mergeIncrementalPersonaResults(personas, liveResults, parentReport, reviewedPersonaIds, reuseKindByPersonaId = null) {
  const liveById = new Map((liveResults || []).map((lane) => [lane.personaId, { ...lane, reuseSource: 'live' }]));
  const parentById = new Map((parentReport?.lanes || []).map((lane) => [lane.personaId, lane]));
  const reviewed = new Set(reviewedPersonaIds || []);
  const reuseKindFor = (personaId) => {
    if (reuseKindByPersonaId instanceof Map) return reuseKindByPersonaId.get(personaId) || null;
    if (reuseKindByPersonaId && typeof reuseKindByPersonaId === 'object') return reuseKindByPersonaId[personaId] || null;
    return null;
  };

  return (personas || []).map((persona) => {
    if (reviewed.has(persona.id)) return liveById.get(persona.id);
    const lane = parentById.get(persona.id);
    const reuseKind = reuseKindFor(persona.id);
    return {
      personaId: persona.id,
      displayName: persona.name,
      decision: lane?.decision || 'ERROR',
      findings: Array.isArray(lane?.findings) ? lane.findings : [],
      reuseSource: 'parent',
      ...(reuseKind ? { reuseKind } : {}),
      provider: 'reused-evidence',
      model: 'prior-exact-head-report',
      inputTokens: 0,
      outputTokens: 0,
      attemptCount: 0,
    };
  });
}

function assessReviewAssignmentBudget(partitionCount, personaCount, maxAssignments) {
  const partitions = Math.max(1, Number.parseInt(String(partitionCount || 1), 10) || 1);
  const personas = Math.max(0, Number.parseInt(String(personaCount || 0), 10) || 0);
  const maximum = Math.max(1, Number.parseInt(String(maxAssignments || 24), 10) || 24);
  const planned = partitions * personas;
  return { planned, maximum, admitted: planned <= maximum };
}

function extractReportFromArtifact(archiveBytes) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'review-yeti-scope-'));
  const archivePath = path.join(directory, 'report.zip');
  try {
    fs.writeFileSync(archivePath, archiveBytes, { mode: 0o600 });
    const listing = spawnSync('unzip', ['-Z1', archivePath], { encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024 });
    if (listing.status !== 0) throw new Error('run-report artifact is not a readable zip archive');
    const entries = listing.stdout.split(/\r?\n/u).filter(Boolean);
    const reportEntry = entries.find((entry) => /^review-yeti-run-report-[^/]+\.json$/u.test(path.basename(entry)) && !entry.includes('..'));
    if (!reportEntry) throw new Error('run-report artifact does not contain the expected JSON file');
    const extracted = spawnSync('unzip', ['-p', archivePath, reportEntry], { encoding: 'utf8', timeout: 5_000, maxBuffer: 2 * 1024 * 1024 });
    if (extracted.status !== 0 || !extracted.stdout) throw new Error('run-report artifact could not be extracted');
    return { report: JSON.parse(extracted.stdout), raw: extracted.stdout };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function githubRequest(fetchImplementation, token, url, accept = 'application/vnd.github+json') {
  const response = await fetchImplementation(url, {
    headers: {
      Accept: accept,
      Authorization: `Bearer ${token}`,
      'User-Agent': 'review-yeti-action',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status}`);
  return response;
}

async function resolveIncrementalReviewScope(options) {
  const fullScope = createFullReviewScope({
    fullDiffText: options.fullDiffText,
    planDigest: options.planDigest,
    fallbackReason: options.enabled ? 'no_trusted_parent' : 'disabled',
  });
  if (!options.enabled) return { reviewedDiffText: options.fullDiffText, scope: fullScope, parentReport: null };
  const trustedWorkflows = String(options.trustedWorkflow || '').split(',').map((item) => item.trim()).filter(Boolean);
  const trustedWorkflowSha = String(options.trustedWorkflowSha || '').toLowerCase();
  if (!options.token || !options.repo || !options.prNumber || !options.baseSha || !options.headSha
    || trustedWorkflows.length < 1 || !/^[0-9a-f]{40}$/u.test(trustedWorkflowSha)) {
    return { reviewedDiffText: options.fullDiffText, scope: { ...fullScope, fallbackReason: 'missing_identity' }, parentReport: null };
  }

  const fetchImplementation = options.fetchImplementation || globalThis.fetch;
  const apiBase = String(options.apiBase || 'https://api.github.com').replace(/\/+$/u, '');
  const maxIncrementalChain = Math.max(1, Number.parseInt(String(options.maxIncrementalChain ?? 5), 10) || 5);
  const artifactsResponse = await githubRequest(fetchImplementation, options.token, `${apiBase}/repos/${options.repo}/actions/artifacts?per_page=100`);
  const artifactsPayload = await artifactsResponse.json();
  const artifacts = (Array.isArray(artifactsPayload.artifacts) ? artifactsPayload.artifacts : [])
    .filter((artifact) => !artifact.expired && String(artifact.name || '').startsWith('review-yeti-run-report-'))
    .filter((artifact) => artifact.workflow_run?.head_sha !== options.headSha)
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
    .slice(0, MAX_CANDIDATE_ARTIFACTS);

  // REL-552: a chain of "trusted repair delta" reuses can in principle extend forever, each hop
  // reviewing an ever-smaller slice while carrying forward evidence from a report nobody has
  // fully reviewed in a long time. `chainDepth` (persisted on each report's `scope`) counts hops
  // since the last full review; once a candidate parent would extend the chain to the cap, it is
  // not a safe reuse target and this run falls back to a full review instead.
  let chainCapped = false;

  for (const artifact of artifacts) {
    try {
      const runId = Number(artifact.workflow_run?.id);
      if (!Number.isSafeInteger(runId) || runId < 1) continue;
      const runResponse = await githubRequest(fetchImplementation, options.token,
        `${apiBase}/repos/${options.repo}/actions/runs/${runId}`);
      const run = await runResponse.json();
      const trustedReference = (Array.isArray(run.referenced_workflows) ? run.referenced_workflows : [])
        .find((reference) => isTrustedWorkflowReference(reference, trustedWorkflows, trustedWorkflowSha));
      if (run.status !== 'completed' || !['pull_request', 'pull_request_target'].includes(run.event)) continue;
      if (!trustedReference) continue;
      if (run.head_sha !== artifact.workflow_run?.head_sha || Number(run.run_attempt) < 1) continue;
      if (!String(artifact.name).endsWith(`-${run.run_attempt}`)) continue;

      const archiveResponse = await githubRequest(fetchImplementation, options.token, artifact.archive_download_url, 'application/vnd.github+json');
      const archiveBytes = Buffer.from(await archiveResponse.arrayBuffer());
      const extracted = (options.extractReport || extractReportFromArtifact)(archiveBytes);
      const expected = {
        repo: options.repo,
        prNumber: options.prNumber,
        baseSha: options.baseSha,
        headSha: options.headSha,
        planDigest: options.planDigest,
        personaIds: options.personaIds,
      };
      if (!isCompleteTrustedReport(extracted.report, expected)) continue;
      if (run.head_sha !== extracted.report.headSha) continue;

      const parentChainDepth = Number(extracted.report.scope?.chainDepth) || 0;
      if (parentChainDepth + 1 >= maxIncrementalChain) {
        chainCapped = true;
        continue;
      }

      const comparisonResponse = await githubRequest(fetchImplementation, options.token,
        `${apiBase}/repos/${options.repo}/compare/${extracted.report.headSha}...${options.headSha}`);
      const comparison = await comparisonResponse.json();
      if (comparison.status !== 'ahead' || comparison.merge_base_commit?.sha !== extracted.report.headSha) continue;
      if (!Number.isInteger(comparison.ahead_by) || comparison.ahead_by < 1 || comparison.ahead_by > 20) continue;
      if (!Array.isArray(comparison.files) || comparison.files.length < 1 || comparison.files.length > MAX_DELTA_FILES) continue;
      if (comparison.files.some((file) => typeof file.patch !== 'string')) continue;

      // The JSON `files[].patch` field may be truncated. Fetch GitHub's canonical diff media
      // separately, then prove its parsed file set matches the bounded comparison metadata.
      const diffResponse = await githubRequest(fetchImplementation, options.token,
        `${apiBase}/repos/${options.repo}/compare/${extracted.report.headSha}...${options.headSha}`,
        'application/vnd.github.diff');
      const deltaDiffText = await diffResponse.text();
      if (!deltaDiffText || deltaDiffText.length > Number(options.maxIncrementalDiffChars) || deltaDiffText.length >= String(options.fullDiffText).length) continue;

      const deltaFiles = options.parseDiff(deltaDiffText);
      if (deltaFiles.length !== comparison.files.length) continue;
      const expectedPaths = new Set(comparison.files.map((file) => String(file.filename || '')));
      if (deltaFiles.some((file) => !expectedPaths.has(String(file.path || '')))) continue;
      const plan = planIncrementalLanes({
        parentReport: extracted.report,
        deltaFiles,
        personaIds: options.personaIds,
        index: options.index,
        resolveFileDomains: options.resolveFileDomains,
      });
      const reviewedPersonaIds = plan.livePersonaIds;
      if (reviewedPersonaIds.length < 1) continue;
      const reusedPersonaIds = options.personaIds.filter((personaId) => !reviewedPersonaIds.includes(personaId));

      return {
        reviewedDiffText: deltaDiffText,
        parentReport: extracted.report,
        scope: {
          schemaVersion: SCOPE_SCHEMA_VERSION,
          mode: 'delta',
          planDigest: options.planDigest,
          fullDiffDigest: sha256(options.fullDiffText),
          fullDiffChars: String(options.fullDiffText).length,
          reviewedDiffDigest: sha256(deltaDiffText),
          reviewedDiffChars: deltaDiffText.length,
          parentHeadSha: extracted.report.headSha,
          parentReportDigest: sha256(extracted.raw),
          reviewedPersonaIds,
          reusedPersonaIds,
          carriedCleanPersonaIds: plan.carriedClean,
          carriedDirtyPersonaIds: plan.carriedDirty,
          reviewFullDiff: plan.reviewFullDiff,
          lanePlanReason: plan.reason,
          chainDepth: parentChainDepth + 1,
          indexDigest: String(options.indexDigest || ''),
        },
      };
    } catch (_) {
      // Artifacts are advisory candidates. One malformed, expired, or inaccessible artifact
      // cannot authorize a partial review and must not prevent searching older trusted reports.
    }
  }

  return {
    reviewedDiffText: options.fullDiffText,
    scope: chainCapped ? { ...fullScope, fallbackReason: 'chain_cap' } : fullScope,
    parentReport: null,
  };
}

module.exports = {
  SCOPE_SCHEMA_VERSION,
  buildReviewScopePlanDigest,
  isTrustedWorkflowReference,
  createFullReviewScope,
  isCompleteTrustedReport,
  planIncrementalLanes,
  mergeIncrementalPersonaResults,
  assessReviewAssignmentBudget,
  extractReportFromArtifact,
  resolveIncrementalReviewScope,
};
