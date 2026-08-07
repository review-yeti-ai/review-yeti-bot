'use strict';

const crypto = require('node:crypto');
const { evaluateCoverage } = require('./coveragePolicy');
const VALID_VERDICTS = new Set(['SHIP', 'FIX_FIRST', 'BLOCK']);

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

function computeArbitration(personaResults, expectedPersonas, options = {}) {
  const results = Array.isArray(personaResults) ? personaResults : [];
  const expected = Number.isInteger(expectedPersonas) ? expectedPersonas : results.length;
  const failedLanes = results.filter(isFailedLane);
  const completedResults = results.filter((result) => !isFailedLane(result));
  const findings = completedResults.flatMap((result) => sanitizeFindings(result.findings, options.changedFiles));
  let p0Count = 0;
  let p1Count = 0;
  let p2Count = 0;
  for (const finding of findings) {
    if (finding.severity === 'P0') p0Count += 1;
    else if (finding.severity === 'P1') p1Count += 1;
    else if (finding.severity === 'P2') p2Count += 1;
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
    rationale = `Blocked on ${p0Count} critical P0 finding(s).`;
  } else if (p1Count >= blockP1) {
    candidateVerdict = 'BLOCK';
    rationale = `Blocked on ${p1Count} P1 finding(s) across ${panelSize} reviewer(s), at or above the blocking threshold of ${blockP1}.`;
  } else if (p1Count > 0) {
    candidateVerdict = 'FIX_FIRST';
    rationale = `Changes requested for ${p1Count} P1 finding(s) and ${p2Count} P2 nit(s).`;
  } else if (p2Count >= fixP2) {
    candidateVerdict = 'FIX_FIRST';
    rationale = `Changes requested for ${p2Count} P2 finding(s) across ${panelSize} reviewer(s), at or above the nit threshold of ${fixP2}.`;
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
  const quorumSatisfied = fullCoverage;
  const coverageQuorumSatisfied = coverage ? coverage.numericQuorumSatisfied : quorumSatisfied;
  const incomplete = !fullCoverage && !partialCoverage;
  const verdict = incomplete || partialCoverage ? 'BLOCK' : candidateVerdict;
  const status = incomplete ? 'INCOMPLETE_REVIEW' : partialCoverage ? 'PARTIAL_REVIEW' : verdict;
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
    rationale: incomplete
      ? `${rationale} Review is incomplete; publication and merge approval must remain blocked until every expected lane and coverage check completes.`
      : partialCoverage
        ? `${rationale} Numeric coverage quorum met for ${coverage.trustworthyCount}/${coverage.expectedCount} trustworthy lane(s), but the review is partial; publication may retain evidence while merge approval remains blocked.`
        : rationale,
    thresholds: { blockP1, fixP2 },
    metrics: { p0Count, p1Count, p2Count, totalFindings: findings.length },
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
};
