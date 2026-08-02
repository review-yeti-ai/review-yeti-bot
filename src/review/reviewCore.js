'use strict';

const crypto = require('node:crypto');
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
  const normalized = value.replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) return null;
  return normalized;
}

function changedLineNumbers(patch) {
  if (typeof patch !== 'string') return null;
  const lines = new Set();
  let current = 0;
  for (const line of patch.split('\n')) {
    const hunk = line.match(/^@@ .* \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      current = Number(hunk[1]);
      continue;
    }
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) {
      lines.add(current);
      current += 1;
    } else if (line.startsWith('-')) {
      continue;
    } else if (line.length > 0) {
      current += 1;
    }
  }
  return lines;
}

function sanitizeFinding(raw, changedFiles) {
  if (!raw || typeof raw !== 'object') return null;
  if (!Array.isArray(changedFiles)) {
    if (!['P0', 'P1', 'P2'].includes(raw.severity)) return null;
    return { ...raw, severity: raw.severity };
  }
  const path = normalizePath(raw.path);
  const changed = Array.isArray(changedFiles) ? changedFiles.find((file) => normalizePath(file.path) === path) : null;
  if (!path || (Array.isArray(changedFiles) && !changed)) return null;
  const severity = ['P0', 'P1', 'P2'].includes(raw.severity) ? raw.severity : null;
  const line = Number(raw.line);
  if (!severity || !Number.isInteger(line) || line < 1) return null;

  const changedLines = changedLineNumbers(changed && changed.patch);
  if (changedLines && changedLines.size > 0 && !changedLines.has(line)) return null;
  if (changedLines && changedLines.size === 0 && changed && typeof changed.patch === 'string') return null;

  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const body = typeof raw.body === 'string' ? raw.body.trim() : '';
  if (!title || !body) return null;
  const result = { severity, path, line, title, body };
  if (typeof raw.suggestion === 'string' && raw.suggestion.trim()) result.suggestion = raw.suggestion.trim();
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

  if (failedLanes.length > 0) {
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
    if (options.candidateVerdict === 'BLOCK' || (options.candidateVerdict === 'FIX_FIRST' && candidateVerdict === 'SHIP')) {
      candidateVerdict = options.candidateVerdict;
      rationale = typeof options.rationale === 'string' ? options.rationale : rationale;
    } else if (options.candidateVerdict === 'SHIP' && candidateVerdict === 'SHIP') {
      rationale = typeof options.rationale === 'string' ? options.rationale : rationale;
    }
  }

  const coverageComplete = options.coverageComplete !== false;
  const quorumSatisfied = failedLanes.length === 0 && completedResults.length === expected && coverageComplete;
  const incomplete = !quorumSatisfied;
  const verdict = incomplete ? 'BLOCK' : candidateVerdict;
  const status = incomplete ? 'INCOMPLETE_REVIEW' : verdict;

  return {
    totalPersonas: expected,
    completedPersonas: completedResults.length,
    quorumSatisfied,
    verdict,
    status,
    rationale: incomplete
      ? `${rationale} Review is incomplete; publication and merge approval must remain blocked until every expected lane and coverage check completes.`
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
