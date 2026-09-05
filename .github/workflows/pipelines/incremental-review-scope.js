const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const { spawnSync } = require('child_process');

const SCOPE_SCHEMA_VERSION = 'review-scope-v1';
// REL-553: central (repository_dispatch) execution holds run-report artifacts for every consumer
// repository in one executing repo's artifact feed, so a busy day produces many more candidates
// per repo/PR than a same-repo pull_request run ever would. 25 was sized for the same-repo case;
// 60 gives central mode enough depth to still find same-PR candidates on a busy shared executor
// without an unbounded scan.
const MAX_CANDIDATE_ARTIFACTS = 60;
const MAX_DELTA_FILES = 25;

function sha256(value) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function buildReviewScopePlanDigest({
  actionSha, baseSha, personaIds, maxDiffChars, maxIncrementalDiffChars, trustedWorkflow, trustedWorkflowSha,
  indexDigest, maxIncrementalChain, artifactRepo, trustedEvents,
}) {
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
    // REL-553: which repository's artifact feed is trusted for parent reports, and which parent
    // run trigger events are trusted, are both part of the reuse policy. Widening either (for
    // example pointing at a central executing repo, or admitting repository_dispatch) must
    // invalidate any report planned/reused under the narrower same-repo policy.
    artifactRepo: String(artifactRepo || '').toLowerCase(),
    trustedEvents: [...(trustedEvents || [])].map((event) => String(event || '').toLowerCase()),
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
    // REL-586: a lane that SHIPped/FIX_FIRSTed while omitting files from its own diff budget
    // (review-pipeline.js's buildReviewRunReport records diffOmittedFilesCount per lane) never
    // actually reviewed the omitted files. Trusting this report as a carry-forward parent would
    // let planIncrementalLanes carry that lane's evidence -- clean or dirty -- as if it covered
    // every file it owns, silently exempting the omitted files from ever being reviewed by
    // anyone. Mirrors the central backstop's contract (ct-review-actions'
    // check-review-verdict.sh: a reused lane may never assert coverage it does not have) by
    // refusing trust of the whole report up front, before any carry split is computed.
    if (Number(lane.diffOmittedFilesCount) > 0) return false;
    seen.add(lane.personaId);
  }
  return seen.size === expectedIds.size;
}

/**
 * Single source of truth for "this finding is blocking" (P0/P1). Exported so callers outside
 * this module (review-pipeline.js's main()) never re-derive the severity list independently --
 * REL-552 Review Yeti PR #444 finding (architecture, P2): main() previously re-scanned
 * parentReport.lanes with its own inline ['P0','P1'].includes check to compute which live
 * personas are "dirty live" (for prior-findings prompt injection), duplicating the exact rule
 * planIncrementalLanes uses to compute `reviewFullDiff`. A future severity-tier change here would
 * have silently diverged from that duplicate.
 */
function isBlockingFinding(finding) {
  return ['P0', 'P1'].includes(finding?.severity);
}

function laneFindings(lane) {
  return Array.isArray(lane?.findings) ? lane.findings : [];
}

/** True when `lane` (a parentReport.lanes entry) owns any blocking (P0/P1) finding. */
function isDirtyLane(lane) {
  return laneFindings(lane).some(isBlockingFinding);
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
 *
 * REL-586 security floor: an under-mapped domain/class or a narrow roster can otherwise leave a
 * PR author's own delta choosing a single live reviewer. When real domain resolution reaches
 * exactly one live persona (distinct from the empty-live fallback above, which handles zero),
 * `security` is forced live as a floor (`reason: 'security_floor'`) whenever the roster
 * includes it and it is not already that sole live persona.
 *
 * REL-586 P2 carry: `ownsChangedFileFinding` forces a lane live purely because it owns ANY
 * severity finding on a changed file, but only P0/P1 (`isDirty`) triggers `reviewFullDiff` and
 * prior-findings injection. A P2 forced live this way would review only the bounded delta with no
 * memory of what it previously found. `priorFindingsPersonaIds` is the superset of
 * `dirtyLivePersonaIds` that also includes these P2 owners, so main() can hand them their own
 * prior findings as re-verification context without also paying for a full-diff re-review.
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

  const isDirty = (personaId) => isDirtyLane(parentLanesById.get(personaId));
  const ownsChangedFileFinding = (personaId) => laneFindings(parentLanesById.get(personaId))
    .some((finding) => changedPathsLower.has(String(finding?.path || '').toLowerCase()));
  // REL-586: `isDirty` (P0/P1 only) is what forces a full-diff re-review. A P2 owned on a
  // changed file forces the owning lane live via `ownsChangedFileFinding` above, but that live
  // review only sees the bounded delta and, unlike a P0/P1 dirty-live lane, was never told what
  // it previously found -- the P2 silently vanishes if the model does not independently
  // rediscover it from the smaller diff alone. This predicate identifies that case so its
  // finding can be preserved without also paying for a full-diff re-review (see
  // `priorFindingsPersonaIds` below).
  const ownsChangedFileP2 = (personaId) => laneFindings(parentLanesById.get(personaId))
    .some((finding) => finding?.severity === 'P2' && changedPathsLower.has(String(finding?.path || '').toLowerCase()));

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
    // This is a genuinely personaless delta (e.g. a binary asset) -- distinct from the
    // under-mapped-domain floor below, which only applies when domain resolution DID reach a
    // persona but too narrowly. Do not also apply the floor here: an image-only delta reviewed
    // by the sole generalist is the deliberately accepted, already-tested floor for that case.
    const broadReviewer = roster.includes('architecture') ? 'architecture' : roster[0];
    if (broadReviewer) {
      livePersonaIds.push(broadReviewer);
      const cleanIndex = carriedClean.indexOf(broadReviewer);
      if (cleanIndex !== -1) carriedClean.splice(cleanIndex, 1);
      const dirtyIndex = carriedDirty.indexOf(broadReviewer);
      if (dirtyIndex !== -1) carriedDirty.splice(dirtyIndex, 1);
      reason = 'empty_live_fallback';
    }
  } else if (livePersonaIds.length === 1 && roster.includes('security') && !livePersonaIds.includes('security')) {
    // REL-586: an under-mapped domain (e.g. an ecosystem/class gap, or a roster that simply does
    // not include many personas for a given file class) can leave the live set with exactly one
    // persona reached through real domain resolution -- effectively letting whoever authored the
    // delta pick their own single reviewer. Force `security` live as a floor whenever it is
    // configured in the roster and is not already the (sole) live persona.
    livePersonaIds.push('security');
    const cleanIndex = carriedClean.indexOf('security');
    if (cleanIndex !== -1) carriedClean.splice(cleanIndex, 1);
    const dirtyIndex = carriedDirty.indexOf('security');
    if (dirtyIndex !== -1) carriedDirty.splice(dirtyIndex, 1);
    reason = 'security_floor';
  }

  // REL-552 Review Yeti PR #444 (architecture, P2): expose the dirty-live set itself (not just
  // the `reviewFullDiff` boolean derived from it) so main() can inject each dirty-live persona's
  // own prior findings without re-deriving "dirty" independently from parentReport.lanes.
  const dirtyLivePersonaIds = livePersonaIds.filter(isDirty);
  const reviewFullDiff = dirtyLivePersonaIds.length > 0;
  // REL-586: superset of dirtyLivePersonaIds that also includes a live persona forced live only
  // by owning a P2 on a changed file. Unlike dirtyLivePersonaIds, this does NOT feed
  // `reviewFullDiff` -- a P2 nit should not force a full-diff re-review -- but main() uses it to
  // decide which live personas get their own prior findings injected as re-verification context,
  // so the P2 is given a chance to survive rather than vanishing merely because its lane was
  // re-run on the smaller delta.
  const priorFindingsPersonaIds = livePersonaIds.filter((personaId) => isDirty(personaId) || ownsChangedFileP2(personaId));

  return {
    livePersonaIds, carriedClean, carriedDirty, dirtyLivePersonaIds, priorFindingsPersonaIds, reviewFullDiff, reason,
  };
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

/**
 * Trust argument for cross-repository parent-report binding (REL-553).
 *
 * Same-repo mode (the original design): the artifact lives in the *reviewed* repository's own
 * Actions run, which a PR author can influence (workflow_dispatch, re-runs, forks with write
 * access, etc). `run.head_sha === report.headSha` is the anchor that proves the specific run
 * whose trusted-workflow reference we just verified is the same run that actually checked out and
 * reviewed the commit the report claims to be about -- without it, an attacker-influenced run
 * could smuggle in a report for an arbitrary headSha.
 *
 * Cross-repo (central `repository_dispatch`) mode: the artifact instead lives in the *executing*
 * repository (for example the private `calltelemetry/ct-review-actions`), which holds run reports
 * for every consumer repository it reviews on their behalf. A PR author on the reviewed repo has
 * no write access to that executing repo, so they cannot forge, replace, or redirect its artifacts
 * or its runs. `run.head_sha` there is the *executing* repo's own commit (the dispatch workflow's
 * checkout), which has no relationship to the reviewed PR's headSha at all -- requiring the two to
 * match would be both meaningless and always false. The security anchor in this mode is instead:
 * the run belongs to the executing repo we were explicitly told to trust (`artifactRepo`), it ran
 * the trusted reusable workflow at its pinned commit SHA (`isTrustedWorkflowReference`, unchanged),
 * it completed, its trigger event is one we were explicitly told to trust (`trustedEvents`), and
 * the extracted report's own identity fields (repository, prNumber, baseSha, headSha, planDigest,
 * lanes) match the exact request (`isCompleteTrustedReport`, unchanged). That combination proves
 * the report was produced by a legitimate, trusted execution of the review workflow for this exact
 * PR and commit -- the executing run's own head commit is simply not part of that chain of custody.
 */
async function resolveIncrementalReviewScope(options) {
  const artifactRepo = String(options.artifactRepo || options.repo || '');
  const trustedEvents = (Array.isArray(options.trustedEvents) && options.trustedEvents.length > 0
    ? options.trustedEvents
    : ['pull_request', 'pull_request_target']).map((event) => String(event || '').trim().toLowerCase()).filter(Boolean);
  const isCrossRepoArtifactSource = artifactRepo.toLowerCase() !== String(options.repo || '').toLowerCase();

  const fullScope = createFullReviewScope({
    fullDiffText: options.fullDiffText,
    planDigest: options.planDigest,
    fallbackReason: options.enabled ? 'no_trusted_parent' : 'disabled',
  });
  if (!options.enabled) return { reviewedDiffText: options.fullDiffText, scope: fullScope, parentReport: null };
  const trustedWorkflows = String(options.trustedWorkflow || '').split(',').map((item) => item.trim()).filter(Boolean);
  const trustedWorkflowSha = String(options.trustedWorkflowSha || '').toLowerCase();
  if (!options.token || !options.repo || !options.prNumber || !options.baseSha || !options.headSha || !artifactRepo
    || trustedWorkflows.length < 1 || !/^[0-9a-f]{40}$/u.test(trustedWorkflowSha)) {
    return { reviewedDiffText: options.fullDiffText, scope: { ...fullScope, fallbackReason: 'missing_identity' }, parentReport: null };
  }

  const fetchImplementation = options.fetchImplementation || globalThis.fetch;
  const apiBase = String(options.apiBase || 'https://api.github.com').replace(/\/+$/u, '');
  const maxIncrementalChain = Math.max(1, Number.parseInt(String(options.maxIncrementalChain ?? 5), 10) || 5);

  let artifactsPayload;
  try {
    const artifactsResponse = await githubRequest(fetchImplementation, options.token, `${apiBase}/repos/${artifactRepo}/actions/artifacts?per_page=100`);
    artifactsPayload = await artifactsResponse.json();
  } catch (_) {
    // Distinct from the loop-exhausted `no_trusted_parent` fallback below: this means the
    // configured artifact repository could not be read at all (403/404/network failure), which on
    // a central execution path usually means the workflow token lacks `actions: read` on the
    // executing repo, not that no trusted parent exists.
    return { reviewedDiffText: options.fullDiffText, scope: { ...fullScope, fallbackReason: 'artifact_repo_unreadable' }, parentReport: null };
  }
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

      // REL-553: in central mode this artifact feed holds reports for every consumer repository
      // this executor reviews, so most candidates belong to a different repo/PR entirely. Extract
      // and check the report's own identity fields FIRST -- before spending a run-lookup API call
      // on a candidate that can never match.
      const archiveResponse = await githubRequest(fetchImplementation, options.token, artifact.archive_download_url, 'application/vnd.github+json');
      const archiveBytes = Buffer.from(await archiveResponse.arrayBuffer());
      const extracted = (options.extractReport || extractReportFromArtifact)(archiveBytes);
      if (extracted.report?.repository !== options.repo || Number(extracted.report?.prNumber) !== Number(options.prNumber)) continue;

      const runResponse = await githubRequest(fetchImplementation, options.token,
        `${apiBase}/repos/${artifactRepo}/actions/runs/${runId}`);
      const run = await runResponse.json();
      const trustedReference = (Array.isArray(run.referenced_workflows) ? run.referenced_workflows : [])
        .find((reference) => isTrustedWorkflowReference(reference, trustedWorkflows, trustedWorkflowSha));
      if (run.status !== 'completed' || !trustedEvents.includes(String(run.event || '').toLowerCase())) continue;
      if (!trustedReference) continue;
      // Structural artifact/run consistency: the artifact's own recorded run metadata must match
      // the run we just fetched, regardless of same- or cross-repo mode.
      if (run.head_sha !== artifact.workflow_run?.head_sha || Number(run.run_attempt) < 1) continue;
      if (!String(artifact.name).endsWith(`-${run.run_attempt}`)) continue;

      const expected = {
        repo: options.repo,
        prNumber: options.prNumber,
        baseSha: options.baseSha,
        headSha: options.headSha,
        planDigest: options.planDigest,
        personaIds: options.personaIds,
      };
      if (!isCompleteTrustedReport(extracted.report, expected)) continue;
      // Same-repo mode only: bind the parent report to the exact run that produced it (see the
      // trust-argument comment above this function for why cross-repo mode cannot and does not
      // need this check).
      if (!isCrossRepoArtifactSource && run.head_sha !== extracted.report.headSha) continue;

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
          dirtyLivePersonaIds: plan.dirtyLivePersonaIds,
          priorFindingsPersonaIds: plan.priorFindingsPersonaIds,
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
  isBlockingFinding,
  isDirtyLane,
  planIncrementalLanes,
  mergeIncrementalPersonaResults,
  assessReviewAssignmentBudget,
  extractReportFromArtifact,
  resolveIncrementalReviewScope,
};
