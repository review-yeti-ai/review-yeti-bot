'use strict';

const crypto = require('node:crypto');
const { evaluateCoverage } = require('./coveragePolicy');
const { compareClaims } = require('./claimSimilarity');
const VALID_VERDICTS = new Set(['SHIP', 'FIX_FIRST', 'BLOCK']);
const SEVERITY_RANK = Object.freeze({ P0: 0, P1: 1, P2: 2 });

// Provider/infra failure reasons (src/review/reviewInvestigation.js's failureDiagnostic /
// safeFailureReason) that describe the provider or transport, not the persona's actual review
// judgment. A lane that failed for one of these reasons carries no findings either way -- it is
// missing evidence, not a verdict -- and is what distinguishes an infra outage (API-2902) from a
// genuine review defect. `schema_contract_violation` is included deliberately: a model response
// that fails the JSON contract is a provider/output-shape failure, not a finding about the diff.
const INFRA_FAILURE_REASONS = new Set(['timeout', 'ttft_timeout', 'schema_contract_violation']);

function isInfraFailure(lane) {
  return isFailedLane(lane) && INFRA_FAILURE_REASONS.has(String(lane?.failure?.reason || ''));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = canonicalize(value[key]);
      return result;
    }, {});
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  const input = typeof value === 'string' ? value : canonicalJson(value);
  return crypto.createHash('sha256').update(input).digest('hex');
}

function normalizePath(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) return null;
  return normalized;
}

function changedLineNumbers(patch, side = 'RIGHT') {
  if (typeof patch !== 'string') return null;
  if (side !== 'RIGHT' && side !== 'LEFT') return new Set();
  const lines = new Set();
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  const patchLines = patch.split('\n');
  for (const [index, line] of patchLines.entries()) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      inHunk = false;
      continue;
    }
    if (!inHunk && (line.startsWith('+++') || line.startsWith('---'))) continue;
    if (line.startsWith('\\ No newline at end of file')) continue;
    if (!inHunk) continue;
    if (line.startsWith('+')) {
      if (side === 'RIGHT') lines.add(newLine);
      newLine += 1;
    } else if (line.startsWith('-')) {
      if (side === 'LEFT') lines.add(oldLine);
      oldLine += 1;
    } else if (inHunk && !(line.length === 0 && index === patchLines.length - 1 && patch.endsWith('\n'))) {
      // A blank context line is still a line on both sides. The final empty split item from
      // a trailing newline is only a string delimiter and must not advance the hunk.
      oldLine += 1;
      newLine += 1;
    }
  }
  return lines;
}

function isGitlinkFile(file) {
  return Boolean(file && (
    file.isSubmodule === true
    || file.submoduleCandidate === true
    || [file.mode, file.oldMode, file.newMode, file.old_mode, file.new_mode]
      .some((mode) => String(mode || '') === '160000')
  ));
}

function sanitizeFinding(raw, changedFiles) {
  if (!raw || typeof raw !== 'object') return null;
  const path = normalizePath(raw.path);
  const severity = ['P0', 'P1', 'P2'].includes(raw.severity) ? raw.severity : null;
  const line = Number(raw.line);
  let side = raw.side === undefined ? 'RIGHT' : raw.side;
  const sideWasOmitted = raw.side === undefined;
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const body = typeof raw.body === 'string' ? raw.body.trim() : '';
  if (!path || !severity || !Number.isInteger(line) || line < 1) return null;
  if (side !== 'RIGHT' && side !== 'LEFT' || !title || !body) return null;

  if (!Array.isArray(changedFiles)) return buildSanitizedFinding(raw, { severity, path, line, side, title, body });

  const changed = changedFiles.find((file) => normalizePath(file.path) === path);
  if (!changed) return null;

  // Patchless files and gitlinks can still carry a valid file-level finding. A non-empty patch,
  // including a pure rename or binary description, can also lack hunks. When hunks do exist,
  // however, the model's exact side/line must be changed in one of them.
  if (!isGitlinkFile(changed)) {
    const patch = changed && changed.patch;
    if (typeof patch === 'string' && patch.trim() && /^@@ /m.test(patch)) {
      if (sideWasOmitted) {
        const rightLines = changedLineNumbers(patch, 'RIGHT');
        const leftLines = changedLineNumbers(patch, 'LEFT');
        if (!rightLines.has(line) && leftLines.has(line)) side = 'LEFT';
      }
      const changedLines = changedLineNumbers(patch, side);
      if (!changedLines || !changedLines.has(line)) return null;
    }
  }
  return buildSanitizedFinding(raw, { severity, path, line, side, title, body });
}

function buildSanitizedFinding(raw, result) {
  if (typeof raw.suggestion === 'string' && raw.suggestion.trim()) result.suggestion = raw.suggestion.trim();
  if (typeof raw.replacementCode === 'string' && raw.replacementCode.trim()) result.replacementCode = raw.replacementCode.trim();
  if (typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)) result.confidence = raw.confidence;
  return result;
}

function sanitizeFindings(findings, changedFiles) {
  if (!Array.isArray(findings)) return [];
  return findings.map((finding) => sanitizeFinding(finding, changedFiles)).filter(Boolean);
}

function isFailedLane(lane) {
  return Boolean(lane && (lane.error || lane.status === 'ERROR' || lane.decision === 'ERROR'));
}

/**
 * Clusters findings that make the same claim, for SEVERITY COUNTING ONLY. This is the arbiter's
 * own dedup, distinct from and prior to the publication-stage dedup in findingPublication.js's
 * mergeNearDuplicateClaims: publication decides how many PR comments to post; this decides how
 * many distinct defects the severity thresholds (blockP1, fixP2) should see. Before this,
 * computeArbitration counted raw findings, so three personas independently describing one real
 * defect in their own words could push a count across a blocking threshold for what a human
 * reviewer, reading the same three findings merged into one PR conversation, sees as one defect --
 * a rationale-integrity defect: the comment says "Blocked on 3 P1s" about a claim the human can see
 * deduped right below it. `mergeEligible` is unaffected either way (FIX_FIRST and BLOCK both leave
 * it false; only SHIP sets it true), but the P1/P2 counts feeding candidateVerdict, and the
 * rationale text built from them, were not trustworthy.
 *
 * Reuses claimSimilarity.js's compareClaims unmodified -- same thresholds as publication -- rather
 * than inventing a second, uncalibrated notion of "duplicate". Its header documents why those
 * thresholds are set to under-merge: on the corpus they were calibrated against, a genuine
 * duplicate pair scored 0.383 and a genuine non-duplicate pair scored 0.377, so there is no cut
 * that is safe in both directions -- the thresholds accept leaving some real duplicates uncollapsed
 * over the alternative of merging two distinct defects into one, which would hide a real P0/P1.
 * That under-merge bias is the correct direction here too, for the same reason: a false BLOCK
 * costs one accurate-if-verbose sentence in the rationale; a false collapse could hide a real
 * defect below a blocking threshold. See tests/unit/reviewCore.test.ts for calibration numbers run
 * against this call site specifically (not inherited on faith from the publication corpus).
 *
 * `corroboration` (how many findings collapsed into this cluster) is recorded on the cluster and
 * used only for the rationale note appended in computeArbitration -- it must never feed back into
 * `severity`. Three lanes agreeing is *correlated* evidence (they read the same diff), not three
 * independent confirmations, and confidence/verification is already the finding-verifier's job
 * (findingVerifier.js), not the arbiter's. `severity` is the most severe rating any individual
 * member of the cluster carried on its own -- "most serious wins" on cluster membership, exactly as
 * findingPublication.js's mergeClaimInto already does for the comments it posts -- never an
 * escalation invented from how many times the claim was repeated.
 *
 * Compares every finding against each cluster's ORIGINAL (first-seen) representative, not an
 * evolving one, so a chain of loosely-related findings cannot walk a cluster somewhere its founding
 * claim would not itself have matched.
 */
function clusterFindingsForVerdict(findings) {
  const clusters = [];
  for (const finding of findings) {
    const cluster = clusters.find((candidate) => compareClaims(candidate.representative, finding).duplicate);
    if (cluster) {
      cluster.members.push(finding);
      if (SEVERITY_RANK[finding.severity] < SEVERITY_RANK[cluster.severity]) cluster.severity = finding.severity;
    } else {
      clusters.push({ representative: finding, severity: finding.severity, members: [finding] });
    }
  }
  return clusters.map((cluster) => ({
    severity: cluster.severity,
    corroboration: cluster.members.length,
    path: cluster.representative.path,
    line: cluster.representative.line,
    title: cluster.representative.title,
  }));
}

/**
 * Short factual suffix naming how many of the findings driving this branch of the verdict were
 * corroborating reports of the same claim, counted once. Empty string when nothing in `severities`
 * had corroboration > 1, so branches with no duplicates produce byte-identical rationale text to
 * before this function existed.
 */
function corroborationNote(findingClusters, ...severities) {
  const corroborated = findingClusters.filter((cluster) => severities.includes(cluster.severity) && cluster.corroboration > 1);
  if (!corroborated.length) return '';
  const totalReports = corroborated.reduce((sum, cluster) => sum + cluster.corroboration, 0);
  return ` ${corroborated.length} of these were independently reported ${totalReports} times across personas and counted once each.`;
}

function computeArbitration(personaResults, expectedPersonas, options = {}) {
  const results = Array.isArray(personaResults) ? personaResults : [];
  const expected = Number.isInteger(expectedPersonas) ? expectedPersonas : results.length;
  const failedLanes = results.filter(isFailedLane);
  const completedResults = results.filter((result) => !isFailedLane(result));
  const currentFindings = completedResults.flatMap((result) => sanitizeFindings(result.findings, options.changedFiles));
  const carriedFindings = sanitizeFindings(
    options.carriedFindings,
    options.carriedChangedFiles || options.changedFiles,
  );
  const findings = [...currentFindings, ...carriedFindings];
  // Cluster before counting: severity thresholds (blockP1, fixP2) below must see distinct claims,
  // not raw finding reports. See clusterFindingsForVerdict's doc comment for why and its blast
  // radius. `findings` itself (returned below) stays the raw, unclustered list -- publication
  // (findingPublication.js, called from review-pipeline.js after this function returns) reads
  // `personaResults` directly, not this return value, so it is untouched by construction; the
  // dashboard event builder (reviewDashboard.js) does its own independent fingerprint-based dedup
  // for display. Nothing downstream of `findings` needs it deduplicated -- only the counts below do.
  const findingClusters = clusterFindingsForVerdict(findings);
  let p0Count = 0;
  let p1Count = 0;
  let p2Count = 0;
  for (const cluster of findingClusters) {
    if (cluster.severity === 'P0') p0Count += 1;
    else if (cluster.severity === 'P1') p1Count += 1;
    else if (cluster.severity === 'P2') p2Count += 1;
  }

  const panelSize = Math.max(1, completedResults.length);
  const blockP1 = Math.max(3, Math.ceil(panelSize / 2));
  const fixP2 = Math.max(5, panelSize);
  let candidateVerdict = 'SHIP';
  let rationale = `All ${completedResults.length} persona evaluation(s) passed or contained only minor nits. Quorum satisfied for release.`;

  if (expected <= 0) {
    candidateVerdict = 'BLOCK';
    rationale = 'Blocked because no reviewer personas are enabled; no review evidence exists.';
  } else if (failedLanes.length > 0) {
    candidateVerdict = 'BLOCK';
    rationale = `Blocked because ${failedLanes.length} persona lane(s) failed; provider failures cannot produce a successful verdict.`;
  } else if (p0Count > 0) {
    candidateVerdict = 'BLOCK';
    rationale = `Blocked on ${p0Count} critical P0 finding(s).${corroborationNote(findingClusters, 'P0')}`;
  } else if (p1Count >= blockP1) {
    candidateVerdict = 'BLOCK';
    rationale = `Blocked on ${p1Count} P1 finding(s) across ${panelSize} reviewer(s), at or above the blocking threshold of ${blockP1}.${corroborationNote(findingClusters, 'P1')}`;
  } else if (p1Count > 0) {
    candidateVerdict = 'FIX_FIRST';
    rationale = `Changes requested for ${p1Count} P1 finding(s) and ${p2Count} P2 nit(s).${corroborationNote(findingClusters, 'P1', 'P2')}`;
  } else if (p2Count >= fixP2) {
    candidateVerdict = 'FIX_FIRST';
    rationale = `Changes requested for ${p2Count} P2 finding(s) across ${panelSize} reviewer(s), at or above the nit threshold of ${fixP2}.${corroborationNote(findingClusters, 'P2')}`;
  }

  if (!failedLanes.length && VALID_VERDICTS.has(options.candidateVerdict)) {
    if (
      options.candidateVerdict === 'BLOCK'
      || options.candidateVerdict === candidateVerdict
      || (options.candidateVerdict === 'FIX_FIRST' && candidateVerdict === 'SHIP')
    ) {
      candidateVerdict = options.candidateVerdict;
      rationale = typeof options.rationale === 'string' ? options.rationale : rationale;
    }
  }

  const coverageComplete = options.coverageComplete !== false;
  const coverage = Array.isArray(options.expectedPersonaIds)
    ? evaluateCoverage({
      expectedPersonaIds: options.expectedPersonaIds,
      lanes: results,
      policy: options.coveragePolicy,
    })
    : null;
  const fullCoverage = coverage
    ? coverage.status === 'complete' && coverageComplete
    : expected > 0 && failedLanes.length === 0 && completedResults.length === expected && coverageComplete;
  const partialCoverage = Boolean(coverage && coverage.status === 'partial' && coverageComplete);
  // `quorumSatisfied` here means "every expected persona produced a trustworthy verdict"
  // (full/unanimous coverage) -- it is NOT the configured coverage_policy.quorum threshold
  // (two_thirds / simple_majority / unanimous). That numeric-quorum signal is
  // `coverageQuorumSatisfied` below (coverage.numericQuorumSatisfied). The two are different
  // questions with different answers: a 4-of-5 panel can have coverageQuorumSatisfied: true
  // (two_thirds quorum met) while quorumSatisfied is still false (one lane short of full
  // coverage). Only `quorumSatisfied`/`fullCoverage` gates `verdict` and `mergeEligible` below --
  // the configured quorum affects only whether an incomplete panel is labeled PARTIAL_REVIEW
  // (`partialCoverage`, quorum met) vs INCOMPLETE_REVIEW (quorum not met); it never allows SHIP.
  // This is deliberate, not a bug: see the `partialCoverage` branch a few lines down (verdict
  // stays BLOCK either way), coveragePolicy.js's own `mergeEligible: complete`, and API-2902 --
  // a false SHIP from a review that never actually finished is a worse failure than a slow BLOCK.
  const quorumSatisfied = fullCoverage;
  const coverageQuorumSatisfied = coverage ? coverage.numericQuorumSatisfied : quorumSatisfied;
  const incomplete = !fullCoverage && !partialCoverage;

  // API-2902: an otherwise-incomplete/partial review whose ONLY failed lane(s) failed for a
  // provider/infra reason (never a real review judgment), with the rest of the expected panel
  // (N-1 or better) trustworthy and zero blocking findings among them, is a distinct outcome from
  // both a findings-based BLOCK and a generic INCOMPLETE_REVIEW: it means "infra broke this run",
  // not "the panel found a problem" or "coverage never ran". Evidenced live: cisco-cdr
  // #4411/#4413 blocked twice with 4/5 personas approving and 0 P0/P1/P2 findings because a
  // single lane errored once (schema_contract_violation, then ttft_timeout). Still fails closed
  // -- verdict stays BLOCK and mergeEligible stays false -- only the status label changes so
  // on-call can tell infra apart from a real verdict without reading the lane table.
  const infraFailedLanes = failedLanes.filter(isInfraFailure);
  const nonInfraFailedLanes = failedLanes.filter((lane) => !isInfraFailure(lane));
  const infraOnlyOutage = (incomplete || partialCoverage)
    && expected > 0
    && infraFailedLanes.length > 0
    && nonInfraFailedLanes.length === 0
    && completedResults.length >= expected - 1
    && p0Count === 0
    && p1Count === 0;

  // Coverage quorum (however configured) never overrides this: `partialCoverage` still forces
  // BLOCK. Only `fullCoverage` (every expected persona trustworthy) allows `candidateVerdict`
  // through. See the `quorumSatisfied` comment above.
  const verdict = incomplete || partialCoverage ? 'BLOCK' : candidateVerdict;
  const status = infraOnlyOutage
    ? 'INCOMPLETE_INFRA'
    : incomplete ? 'INCOMPLETE_REVIEW' : partialCoverage ? 'PARTIAL_REVIEW' : verdict;
  const gateDecision = status === 'SHIP' && verdict === 'SHIP' && p0Count === 0 && p1Count === 0
    ? 'PASS'
    : 'BLOCKED';
  const mergeEligible = status === 'SHIP' && gateDecision === 'PASS';
  const coverageStatus = coverage
    ? (coverageComplete ? coverage.status : 'incomplete')
    : (fullCoverage ? 'complete' : 'incomplete');

  return {
    totalPersonas: expected,
    completedPersonas: completedResults.length,
    coverageComplete,
    quorumSatisfied,
    coverageQuorumSatisfied,
    coverageStatus,
    verdict,
    status,
    gateDecision,
    mergeEligible,
    ...(coverage ? { coverage } : {}),
    ...(infraOnlyOutage
      ? { infraFailure: true, infraFailedPersonaIds: infraFailedLanes.map((lane) => lane.personaId || lane.id).filter(Boolean) }
      : {}),
    rationale: infraOnlyOutage
      ? `${rationale} ${infraFailedLanes.length} persona lane(s) failed for a provider/infra reason `
        + `(${[...new Set(infraFailedLanes.map((lane) => lane.failure?.reason).filter(Boolean))].join(', ') || 'infra'}); `
        + `the remaining ${completedResults.length}/${expected} lane(s) completed with zero blocking findings. `
        + 'This is an infra outage, not a review verdict; publication and merge approval remain blocked until it clears.'
      : incomplete
        ? `${rationale} Review is incomplete; publication and merge approval must remain blocked until every expected lane and coverage check completes.`
        : partialCoverage
          ? `${rationale} Numeric coverage quorum met for ${coverage.trustworthyCount}/${coverage.expectedCount} trustworthy lane(s), but the review is partial; publication may retain evidence while merge approval remains blocked.`
          : rationale,
    thresholds: { blockP1, fixP2 },
    // totalFindings is the deduplicated count (== p0Count + p1Count + p2Count, enforced by
    // reviewDispatchReceipt.js's normalizeMetrics) -- it answers "how many distinct defects", the
    // number severity thresholds actually acted on. rawFindingCount is the pre-dedup count, for
    // anyone who wants to see how much corroboration collapsed; `findings` below is still every
    // individual raw finding, unclustered.
    metrics: {
      p0Count, p1Count, p2Count, totalFindings: findingClusters.length, rawFindingCount: findings.length,
    },
    findingClusters,
    findings,
  };
}

module.exports = {
  canonicalize,
  canonicalJson,
  sha256,
  changedLineNumbers,
  sanitizeFinding,
  sanitizeFindings,
  computeArbitration,
  INFRA_FAILURE_REASONS,
  isInfraFailure,
};
