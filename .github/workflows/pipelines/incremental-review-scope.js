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

function buildReviewScopePlanDigest({ actionSha, baseSha, personaIds, maxDiffChars, maxIncrementalDiffChars, trustedWorkflow }) {
  return sha256(JSON.stringify({
    schemaVersion: SCOPE_SCHEMA_VERSION,
    actionSha: String(actionSha || 'unbound').toLowerCase(),
    baseSha: String(baseSha || '').toLowerCase(),
    personaIds: [...(personaIds || [])],
    maxDiffChars: Number(maxDiffChars) || 0,
    maxIncrementalDiffChars: Number(maxIncrementalDiffChars) || 0,
    trustedWorkflow: String(trustedWorkflow || ''),
  }));
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

function selectIncrementalPersonaIds(parentReport, deltaFiles, personaIds) {
  const available = new Set(personaIds || []);
  const selected = new Set();
  const combined = (deltaFiles || [])
    .map((file) => `${file.path || ''}\n${file.patch || ''}`)
    .join('\n')
    .toLowerCase();
  const paths = (deltaFiles || []).map((file) => String(file.path || '').toLowerCase());
  const changedPaths = new Set(paths);

  for (const lane of parentReport?.lanes || []) {
    const ownsBlockingFinding = (lane.findings || []).some((finding) => ['P0', 'P1'].includes(finding?.severity));
    const ownsFindingOnChangedFile = (lane.findings || []).some((finding) => changedPaths.has(String(finding?.path || '').toLowerCase()));
    if (available.has(lane.personaId) && (ownsBlockingFinding || ownsFindingOnChangedFile)) {
      selected.add(lane.personaId);
    }
  }

  // One generalist owns every hunk. Architecture is the stable default; custom rosters fall
  // back to their first configured reviewer rather than silently leaving a hunk unassigned.
  const broadReviewer = available.has('architecture') ? 'architecture' : (personaIds || [])[0];
  if (broadReviewer) selected.add(broadReviewer);

  const addWhen = (personaId, condition) => {
    if (condition && available.has(personaId)) selected.add(personaId);
  };
  const hasPath = (pattern) => paths.some((item) => pattern.test(item));

  addWhen('security', /(auth|authoriz|credential|secret|token|api[_ -]?key|password|crypto|encrypt|permission|privilege|ssrf|xss|csrf|injection)/u.test(combined));
  addWhen('dependencies', hasPath(/(^|\/)(package-lock\.json|package\.json|yarn\.lock|pnpm-lock\.yaml|mix\.exs|mix\.lock|gemfile|go\.(mod|sum)|cargo\.(toml|lock)|requirements[^/]*\.txt)$/u)
    || /(^|\n)[+-].*\b(import|require|dependency|dependencies|devdependencies)\b/u.test(combined));
  addWhen('licensing', hasPath(/(^|\/)(license|notice|copying|third[_-]?party|sbom)(\.|\/|$)/u));
  addWhen('performance', /(benchmark|performance|latency|throughput|concurren|rate.?limit|cache|batch|pool|timeout|query|index|n\+1)/u.test(combined));

  const docsOnly = paths.length > 0 && paths.every((item) => /(^|\/)(docs?|readme|changelog)(\/|\.|$)/u.test(item) || /\.(md|mdx|txt)$/u.test(item));
  addWhen('testing', hasPath(/(^|\/)(tests?|spec|__tests__)(\/|\.|$)/u) || !docsOnly);
  addWhen('documentation', docsOnly);
  addWhen('database', /(migration|schema|database|postgres|sql|ecto|index|query)/u.test(combined));
  addWhen('devops', hasPath(/(^|\/)(\.github|docker|k8s|helm|terraform|deploy)(\/|\.|$)/u));
  addWhen('accessibility', /(aria-|accessib|screen.?reader|tabindex|role=)/u.test(combined));
  addWhen('i18n', /(i18n|localiz|translat|locale)/u.test(combined));

  return (personaIds || []).filter((personaId) => selected.has(personaId));
}

function mergeIncrementalPersonaResults(personas, liveResults, parentReport, reviewedPersonaIds) {
  const liveById = new Map((liveResults || []).map((lane) => [lane.personaId, { ...lane, reuseSource: 'live' }]));
  const parentById = new Map((parentReport?.lanes || []).map((lane) => [lane.personaId, lane]));
  const reviewed = new Set(reviewedPersonaIds || []);

  return (personas || []).map((persona) => {
    if (reviewed.has(persona.id)) return liveById.get(persona.id);
    const lane = parentById.get(persona.id);
    return {
      personaId: persona.id,
      displayName: persona.name,
      decision: lane?.decision || 'ERROR',
      findings: Array.isArray(lane?.findings) ? lane.findings : [],
      reuseSource: 'parent',
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
  if (!options.token || !options.repo || !options.prNumber || !options.baseSha || !options.headSha || trustedWorkflows.length < 1) {
    return { reviewedDiffText: options.fullDiffText, scope: { ...fullScope, fallbackReason: 'missing_identity' }, parentReport: null };
  }

  const fetchImplementation = options.fetchImplementation || globalThis.fetch;
  const apiBase = String(options.apiBase || 'https://api.github.com').replace(/\/+$/u, '');
  const artifactsResponse = await githubRequest(fetchImplementation, options.token, `${apiBase}/repos/${options.repo}/actions/artifacts?per_page=100`);
  const artifactsPayload = await artifactsResponse.json();
  const artifacts = (Array.isArray(artifactsPayload.artifacts) ? artifactsPayload.artifacts : [])
    .filter((artifact) => !artifact.expired && String(artifact.name || '').startsWith('review-yeti-run-report-'))
    .filter((artifact) => artifact.workflow_run?.head_sha !== options.headSha)
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
    .slice(0, MAX_CANDIDATE_ARTIFACTS);

  for (const artifact of artifacts) {
    try {
      const runId = Number(artifact.workflow_run?.id);
      if (!Number.isSafeInteger(runId) || runId < 1) continue;
      const runResponse = await githubRequest(fetchImplementation, options.token,
        `${apiBase}/repos/${options.repo}/actions/runs/${runId}`);
      const run = await runResponse.json();
      const trustedReference = (Array.isArray(run.referenced_workflows) ? run.referenced_workflows : [])
        .find((reference) => trustedWorkflows.includes(String(reference?.path || '')));
      if (run.status !== 'completed' || !['pull_request', 'pull_request_target'].includes(run.event)) continue;
      if (!trustedReference || !/^[0-9a-f]{40}$/iu.test(String(trustedReference.sha || ''))) continue;
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
      const reviewedPersonaIds = selectIncrementalPersonaIds(extracted.report, deltaFiles, options.personaIds);
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
        },
      };
    } catch (_) {
      // Artifacts are advisory candidates. One malformed, expired, or inaccessible artifact
      // cannot authorize a partial review and must not prevent searching older trusted reports.
    }
  }

  return { reviewedDiffText: options.fullDiffText, scope: fullScope, parentReport: null };
}

module.exports = {
  SCOPE_SCHEMA_VERSION,
  buildReviewScopePlanDigest,
  createFullReviewScope,
  isCompleteTrustedReport,
  selectIncrementalPersonaIds,
  mergeIncrementalPersonaResults,
  assessReviewAssignmentBudget,
  extractReportFromArtifact,
  resolveIncrementalReviewScope,
};
