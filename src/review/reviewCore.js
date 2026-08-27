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
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) return null;
  return normalized;
}

function changedLineNumbers(patch) {
  if (typeof patch !== 'string') return null;
  const lines = new Set();
  let current = 0;
  let inHunk = false;
  const patchLines = patch.split('\n');
  for (const [index, line] of patchLines.entries()) {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      current = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk && (line.startsWith('+++') || line.startsWith('---'))) continue;
    if (line.startsWith('\\ No newline at end of file')) continue;
    if (line.startsWith('+')) {
      lines.add(current);
      current += 1;
    } else if (line.startsWith('-')) {
      continue;
    } else if (inHunk && !(line.length === 0 && index === patchLines.length - 1 && patch.endsWith('\n'))) {
      // A blank context line is still a line in the new file. The final empty split item from
      // a trailing newline is only a string delimiter and must not advance the hunk.
      current += 1;
    }
  }
  return lines;
}

function isGitlinkFile(file) {
  return Boolean(file && (file.isSubmodule === true || String(file.mode || '') === '160000'));
}

function sanitizeFinding(raw, changedFiles) {
  if (!raw || typeof raw !== 'object') return null;
  if (!Array.isArray(changedFiles)) {
    if (!['P0', 'P1', 'P2'].includes(raw.severity)) return null;
    return { ...raw, severity: raw.severity };
  }
  const path = normalizePath(raw.path);
  const changed = changedFiles.find((file) => normalizePath(file.path) === path);
  if (!path || !changed) return null;
  const severity = ['P0', 'P1', 'P2'].includes(raw.severity) ? raw.severity : null;
  const line = Number(raw.line);
  if (!severity || !Number.isInteger(line) || line < 1) return null;

  const changedLines = changedLineNumbers(changed && changed.patch);
  // A gitlink patch has no line-numbered hunk. Keep a valid finding anchored to the gitlink path
  // instead of silently turning a real submodule finding into an approval.
  if (!isGitlinkFile(changed)) {
    if (changedLines && changedLines.size > 0 && !changedLines.has(line)) return null;
    if (changedLines && changedLines.size === 0 && typeof changed.patch === 'string' && !/^@@ /m.test(changed.patch)) return null;
  }

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

/**
 * Validate the model-facing findings contract before any lossy sanitization occurs.
 *
 * `sanitizeFindings` is intentionally tolerant because it is also used at the final publication
 * boundary to discard findings that cannot be anchored to a diff. Model responses need a stricter
 * boundary: inventing a severity, line, path, title, or body hides a provider contract failure and
 * can turn malformed output into an apparently valid review. This validator therefore rejects the
 * malformed item (and reports its index) without coercing any contract field. Optional UI metadata
 * is kept only when it already has the expected primitive shape; malformed optional metadata is
 * ignored for compatibility because it cannot change the review decision.
 */
function validateReviewFindings(rawFindings, changedFiles) {
  // Some hosted moderator/arbiter compatibility callers omit findings when they are not
  // producing a findings payload. Preserve that established empty-result convention; once a
  // findings field is present, every item is validated strictly below.
  if (rawFindings === undefined) {
    return { valid: true, findings: [] };
  }
  if (!Array.isArray(rawFindings)) {
    return { valid: false, findings: [], error: 'findings must be an array' };
  }

  const changedFileMap = Array.isArray(changedFiles)
    ? new Map(changedFiles.map((file) => [normalizePath(file?.path), file]))
    : null;
  const changedLineMap = changedFileMap
    ? new Map([...changedFileMap.entries()].map(([path, file]) => [path, changedLineNumbers(file?.patch)]))
    : null;
  const findings = [];
  for (const [index, raw] of rawFindings.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { valid: false, findings: [], index, error: 'finding must be an object' };
    }
    if (!['P0', 'P1', 'P2'].includes(raw.severity)) {
      return { valid: false, findings: [], index, error: 'finding severity must be P0, P1, or P2' };
    }
    const path = normalizePath(raw.path);
    if (!path) {
      return { valid: false, findings: [], index, error: 'finding path must be a relative non-empty string' };
    }
    if (!Number.isInteger(raw.line) || raw.line < 1) {
      return { valid: false, findings: [], index, error: 'finding line must be an integer greater than zero' };
    }
    if (changedFileMap) {
      const changed = changedFileMap.get(path);
      if (!changed) {
        return { valid: false, findings: [], index, error: 'finding path must name a changed file' };
      }
      if (!isGitlinkFile(changed)) {
        const changedLines = changedLineMap.get(path);
        // Content-only callers do not provide unified-hunk metadata. We still require a valid
        // relative changed path and integer line, while deferring line anchoring to a caller that
        // has patch data; treating unavailable metadata as an empty hunk would reject valid
        // hosted-panel inputs without improving evidence.
        if (changedLines && changedLines.size > 0 && !changedLines.has(raw.line)) {
          return { valid: false, findings: [], index, error: 'finding line must identify an added line in the changed file' };
        }
        if (changedLines && changedLines.size === 0 && typeof changed.patch === 'string' && !/^@@ /m.test(changed.patch)) {
          return { valid: false, findings: [], index, error: 'finding cannot be anchored because the changed file has no line hunk' };
        }
      }
    }
    if (typeof raw.title !== 'string' || !raw.title.trim()) {
      return { valid: false, findings: [], index, error: 'finding title must be a non-empty string' };
    }
    if (typeof raw.body !== 'string' || !raw.body.trim()) {
      return { valid: false, findings: [], index, error: 'finding body must be a non-empty string' };
    }
    if (raw.suggestion !== undefined && raw.suggestion !== null && typeof raw.suggestion !== 'string') {
      return { valid: false, findings: [], index, error: 'finding suggestion must be a string or null' };
    }
    // Optional UI metadata is deliberately ignored when malformed. It cannot change the
    // review decision, while rejecting an otherwise valid finding would make old panel callers
    // fail for non-contract fields such as confidence. Valid values are preserved below.

    const finding = {
      severity: raw.severity,
      path,
      line: raw.line,
      title: raw.title.trim(),
      body: raw.body.trim(),
    };
    if (typeof raw.suggestion === 'string' && raw.suggestion.trim()) finding.suggestion = raw.suggestion.trim();
    if (typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)) finding.confidence = raw.confidence;
    if (typeof raw.recommendation === 'string' && raw.recommendation.trim()) finding.recommendation = raw.recommendation.trim();
    if (Array.isArray(raw.fixOptions)) finding.fixOptions = raw.fixOptions;
    findings.push(finding);
  }

  return { valid: true, findings };
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
  const quorumSatisfied = expected > 0 && failedLanes.length === 0 && completedResults.length === expected && coverageComplete;
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
  validateReviewFindings,
  computeArbitration,
};
