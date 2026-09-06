'use strict';

const { canonicalJson, sha256 } = require('./reviewCore');
const { compareClaims } = require('./claimSimilarity');

const SEVERITY_RANK = Object.freeze({ P0: 0, P1: 1, P2: 2 });
const SEVERITY_ALIASES = Object.freeze({
  P0: 'P0',
  P1: 'P1',
  P2: 'P2',
  CRITICAL: 'P0',
  MAJOR: 'P1',
  MINOR: 'P2',
  NIT: 'P2',
});

function normalizePath(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '').trim();
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) return null;
  return normalized;
}

function normalizeTitle(value) {
  return typeof value === 'string' ? value.toLowerCase().replace(/\s+/g, ' ').trim() : '';
}

function normalizeSeverity(value) {
  return SEVERITY_ALIASES[String(value || '').toUpperCase()] || null;
}

function normalizePersona(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isGitlinkFile(file) {
  return Boolean(file && (
    file.isSubmodule === true
    || file.submoduleCandidate === true
    || [file.mode, file.oldMode, file.newMode, file.old_mode, file.new_mode]
      .some((mode) => String(mode || '') === '160000')
  ));
}

/**
 * Parse every exact changed-line anchor from a unified diff. RIGHT contains additions in the
 * post-image; LEFT contains deletions in the pre-image. Context lines are deliberately excluded.
 */
function parsePatchAnchors(patch) {
  const right = new Set();
  const left = new Set();
  if (typeof patch !== 'string') return { right, left, hasHunks: false };

  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  let hasHunks = false;
  const patchLines = patch.split('\n');

  for (const [index, line] of patchLines.entries()) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      hasHunks = true;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      inHunk = false;
      continue;
    }
    if (!inHunk || line.startsWith('\\ No newline at end of file')) continue;
    if (line.startsWith('+')) {
      right.add(newLine);
      newLine += 1;
    } else if (line.startsWith('-')) {
      left.add(oldLine);
      oldLine += 1;
    } else if (!(line.length === 0 && index === patchLines.length - 1 && patch.endsWith('\n'))) {
      // GitHub patches normally prefix context with a space. Some fixtures omit that prefix for
      // blank context, so any remaining in-hunk line advances both images.
      oldLine += 1;
      newLine += 1;
    }
  }

  return { right, left, hasHunks };
}

function attributionFor(value, includeId = false) {
  if (!value || typeof value !== 'object') return null;
  return normalizePersona(value.displayName)
    || normalizePersona(value.persona)
    || normalizePersona(value.personaId)
    || (includeId ? normalizePersona(value.id) : null);
}

function flattenFindings(input) {
  if (!Array.isArray(input)) return [];
  const flattened = [];
  for (const entry of input) {
    if (!entry || typeof entry !== 'object') continue;
    if (Array.isArray(entry.findings)) {
      const lanePersona = attributionFor(entry, true);
      for (const raw of entry.findings) {
        if (!raw || typeof raw !== 'object') continue;
        const personas = Array.isArray(raw.personas) ? raw.personas.map(normalizePersona).filter(Boolean) : [];
        const directPersona = attributionFor(raw, false) || lanePersona;
        if (directPersona) personas.push(directPersona);
        flattened.push({ raw, personas: [...new Set(personas)].sort((a, b) => a.localeCompare(b)) });
      }
    } else {
      const personas = Array.isArray(entry.personas) ? entry.personas.map(normalizePersona).filter(Boolean) : [];
      const directPersona = attributionFor(entry, false);
      if (directPersona) personas.push(directPersona);
      flattened.push({ raw: entry, personas: [...new Set(personas)].sort((a, b) => a.localeCompare(b)) });
    }
  }
  return flattened;
}

function chooseRicher(current, candidate) {
  if (!candidate) return current;
  if (!current) return candidate;
  if (candidate.length !== current.length) return candidate.length > current.length ? candidate : current;
  return candidate.localeCompare(current) < 0 ? candidate : current;
}

function findingDedupeKey(finding, subjectType) {
  const type = subjectType || (Number.isInteger(Number(finding && finding.line)) ? 'line' : 'file');
  const path = normalizePath(finding && finding.path) || String((finding && finding.path) || '');
  const side = finding && finding.side === 'LEFT' ? 'LEFT' : 'RIGHT';
  const line = Number(finding && finding.line);
  return [
    path,
    type === 'file' ? 'FILE' : `${side}:${Number.isInteger(line) ? line : 0}`,
    normalizeTitle(finding && finding.title),
  ].join('|');
}

function findingMarkerKey(finding, subjectType) {
  const type = subjectType || (Number.isInteger(Number(finding && finding.line)) ? 'line' : 'file');
  const identity = {
    path: normalizePath(finding && finding.path) || String((finding && finding.path) || ''),
    subject: type === 'file'
      ? 'FILE'
      : `${finding && finding.side === 'LEFT' ? 'LEFT' : 'RIGHT'}:${Number(finding && finding.line)}`,
    title: normalizeTitle(finding && finding.title),
  };
  return `review-yeti-finding:${sha256(canonicalJson(identity)).slice(0, 32)}`;
}

function codeFence(value) {
  const matches = String(value).match(/`+/g) || [];
  const width = Math.max(3, ...matches.map((run) => run.length + 1));
  return '`'.repeat(width);
}

function formatFindingCommentBody(finding) {
  const severity = normalizeSeverity(finding && finding.severity) || 'P2';
  const title = typeof finding.title === 'string' ? finding.title.trim().replace(/\s+/g, ' ') : 'Review finding';
  const body = typeof finding.body === 'string' ? finding.body.trim() : '';
  const suggestion = typeof finding.suggestion === 'string' ? finding.suggestion.trim() : '';
  const replacementCode = typeof finding.replacementCode === 'string' ? finding.replacementCode.trim() : '';
  const personas = Array.isArray(finding.personas)
    ? [...new Set(finding.personas.map(normalizePersona).filter(Boolean))].sort((a, b) => a.localeCompare(b))
    : [];
  const alsoTitles = Array.isArray(finding.mergedTitles)
    ? [...new Set(finding.mergedTitles.map((value) => String(value || '').trim().replace(/\s+/g, ' ')).filter(Boolean))]
      .filter((value) => value.toLowerCase() !== title.toLowerCase())
      .sort((a, b) => a.localeCompare(b))
    : [];
  const lines = [`**${severity} · ${title}**`];
  if (body) lines.push('', body);
  if (suggestion) lines.push('', '**Suggested fix**', '', suggestion);
  if (replacementCode) {
    const fence = codeFence(replacementCode);
    lines.push('', '**Suggested replacement**', '', `${fence}suggestion`, replacementCode, fence);
  }
  // Reviewers that reported one defect under different titles are collapsed into this comment.
  // The other titles are kept because they are often the clearer statement of the same problem.
  if (alsoTitles.length > 0) {
    lines.push('', `**Also reported as:** ${alsoTitles.map((value) => `_${value}_`).join(' · ')}`);
  }
  if (personas.length > 0) {
    const labels = personas.map((persona) => `\`${persona.replace(/`/g, "'")}\``).join(', ');
    lines.push('', `**Reported by:** ${labels}`);
  }
  return lines.join('\n');
}

function rejection(raw, personas, reason) {
  const line = Number(raw && raw.line);
  const severity = normalizeSeverity(raw && raw.severity);
  const side = raw && raw.side === undefined ? 'RIGHT' : raw && raw.side;
  return {
    path: normalizePath(raw && raw.path) || String((raw && raw.path) || ''),
    ...(Number.isInteger(line) ? { line } : {}),
    ...(side === 'RIGHT' || side === 'LEFT' ? { side } : {}),
    title: typeof (raw && raw.title) === 'string' ? raw.title.trim() : '',
    ...(severity ? { severity } : {}),
    personas,
    finding: raw,
    reason,
  };
}

function comparePublicationItems(a, b) {
  const severity = (SEVERITY_RANK[a.finding.severity] ?? 9) - (SEVERITY_RANK[b.finding.severity] ?? 9);
  if (severity !== 0) return severity;
  const path = a.path.localeCompare(b.path);
  if (path !== 0) return path;
  const line = (a.line || 0) - (b.line || 0);
  if (line !== 0) return line;
  const side = String(a.side || '').localeCompare(String(b.side || ''));
  if (side !== 0) return side;
  return normalizeTitle(a.finding.title).localeCompare(normalizeTitle(b.finding.title));
}

/**
 * Folds one finding's fields into another that has already been judged the same claim.
 *
 * Shared by the exact-key dedupe in `planFindingPublication` and by `mergeClaimInto`'s
 * near-duplicate clustering. Both used to carry their own copy of these rules, so any field added
 * to a publication finding had to be merged in two places and the two were free to drift.
 */
function mergeFindingFields(merged, candidate) {
  if (SEVERITY_RANK[candidate.severity] < SEVERITY_RANK[merged.severity]) merged.severity = candidate.severity;
  merged.personas = [...new Set([...merged.personas, ...candidate.personas])].sort((a, b) => a.localeCompare(b));
  merged.body = chooseRicher(merged.body, candidate.body);
  merged.suggestion = chooseRicher(merged.suggestion, candidate.suggestion);
  merged.replacementCode = chooseRicher(merged.replacementCode, candidate.replacementCode);
  merged.recommendation = chooseRicher(merged.recommendation, candidate.recommendation);
  if (candidate.confidence !== undefined) {
    merged.confidence = merged.confidence === undefined ? candidate.confidence : Math.max(merged.confidence, candidate.confidence);
  }
  return merged;
}

/**
 * Folds `entry` into `target`, which has already been judged to be the same claim.
 *
 * Nothing is discarded that a reader would miss: the richest wording of each field survives, both
 * reviewers are credited, and the title that lost is preserved so the merge is visible rather than
 * silent. Where one report anchored to an exact line and the other could only anchor to the file,
 * the line wins — it is the more useful place for the conversation to appear.
 */
function mergeClaimInto(target, entry) {
  const merged = target.finding;
  const candidate = entry.finding;

  mergeFindingFields(merged, candidate);

  const titles = new Set(merged.mergedTitles || []);
  for (const title of candidate.mergedTitles || []) titles.add(title);
  if (candidate.title && normalizeTitle(candidate.title) !== normalizeTitle(merged.title)) titles.add(candidate.title);
  if (titles.size > 0) merged.mergedTitles = [...titles];

  if (target.subjectType === 'file' && entry.subjectType === 'line') {
    target.subjectType = 'line';
    merged.line = candidate.line;
    merged.side = candidate.side;
  }
}

/**
 * Collapses findings that state the same claim about the same file.
 *
 * Exact deduplication keys on `path + line + title`, which a reworded title defeats completely:
 * two reviewers describing one bypassed entitlement check two lines apart produce two review
 * conversations, and every rerun produces a fresh set under fresh titles. Claim comparison is what
 * closes that gap — see {@link module:review/claimSimilarity} for how conservative it is and why.
 */
function mergeNearDuplicateClaims(entries, options) {
  const clusters = [];
  for (const entry of entries) {
    const target = clusters.find((cluster) => compareClaims(cluster.finding, entry.finding, options).duplicate);
    if (target) mergeClaimInto(target, entry);
    else clusters.push(entry);
  }
  return clusters;
}

/**
 * Build the one authoritative publication plan used by the Action, App, and hosted publisher.
 * This function never caps results and never guesses a nearby line for an invalid anchor.
 *
 * @param {object} [options]
 * @param {boolean} [options.mergeNearDuplicates=true] - Collapse differently-worded reports of one
 *   claim. Turn off only to inspect the unmerged set; publishing with it off is what produced
 *   five review conversations for one foreign-key defect.
 * @param {object} [options.nearDuplicate] - Threshold overrides forwarded to `compareClaims`.
 */
function planFindingPublication(input, changedFiles, options = {}) {
  const files = new Map();
  if (Array.isArray(changedFiles)) {
    for (const file of changedFiles) {
      const path = normalizePath(file && file.path);
      if (path && !files.has(path)) files.set(path, file);
    }
  }

  const rejected = [];
  const grouped = new Map();
  for (const { raw, personas } of flattenFindings(input)) {
    const severity = normalizeSeverity(raw.severity);
    const path = normalizePath(raw.path);
    const line = Number(raw.line);
    let side = raw.side === undefined ? 'RIGHT' : raw.side;
    const sideWasOmitted = raw.side === undefined;
    const title = typeof raw.title === 'string' ? raw.title.trim().replace(/\s+/g, ' ') : '';
    const body = typeof raw.body === 'string' ? raw.body.trim() : '';

    if (!severity) {
      rejected.push(rejection(raw, personas, 'finding severity must be P0, P1, or P2'));
      continue;
    }
    if (!path) {
      rejected.push(rejection(raw, personas, 'finding path is invalid'));
      continue;
    }
    const file = files.get(path);
    if (!file) {
      rejected.push(rejection(raw, personas, 'finding path is not present in the changed files'));
      continue;
    }
    if (!Number.isInteger(line) || line < 1) {
      rejected.push(rejection(raw, personas, 'finding line must be a positive integer'));
      continue;
    }
    if (side !== 'RIGHT' && side !== 'LEFT') {
      rejected.push(rejection(raw, personas, 'finding side must be RIGHT or LEFT'));
      continue;
    }
    if (!title || !body) {
      rejected.push(rejection(raw, personas, 'finding title and body are required'));
      continue;
    }

    const patch = file.patch;
    const patchless = patch === undefined || patch === null || (typeof patch === 'string' && !patch.trim());
    let subjectType;
    if (isGitlinkFile(file) || patchless) {
      subjectType = 'file';
    } else if (typeof patch !== 'string') {
      rejected.push(rejection(raw, personas, 'changed file patch is not usable'));
      continue;
    } else {
      const anchors = parsePatchAnchors(patch);
      if (!anchors.hasHunks) {
        subjectType = 'file';
      } else {
        // `side` is optional in the model contract. RIGHT remains the default, but a line that
        // exists only in the pre-image is unambiguously a LEFT deletion anchor.
        if (sideWasOmitted && !anchors.right.has(line) && anchors.left.has(line)) side = 'LEFT';
        const validLines = side === 'LEFT' ? anchors.left : anchors.right;
        if (!validLines.has(line)) {
          rejected.push(rejection(raw, personas, `finding line is not an exact changed ${side} line`));
          continue;
        }
        subjectType = 'line';
      }
    }

    const candidate = {
      severity,
      path,
      line,
      side,
      title,
      body,
      ...(typeof raw.suggestion === 'string' && raw.suggestion.trim() ? { suggestion: raw.suggestion.trim() } : {}),
      ...(typeof raw.replacementCode === 'string' && raw.replacementCode.trim() ? { replacementCode: raw.replacementCode.trim() } : {}),
      ...(typeof raw.recommendation === 'string' && raw.recommendation.trim() ? { recommendation: raw.recommendation.trim() } : {}),
      ...(typeof raw.confidence === 'number' && Number.isFinite(raw.confidence) ? { confidence: raw.confidence } : {}),
      personas,
    };
    const key = findingDedupeKey(candidate, subjectType);
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, { subjectType, finding: candidate });
      continue;
    }

    mergeFindingFields(existing.finding, candidate);
  }

  // Deterministic order first: the surviving anchor and title of every merge is the most severe,
  // earliest one, so the same findings always collapse the same way.
  const ordered = [...grouped.values()].sort((a, b) => comparePublicationItems(
    { path: a.finding.path, line: a.finding.line, side: a.finding.side, finding: a.finding },
    { path: b.finding.path, line: b.finding.line, side: b.finding.side, finding: b.finding },
  ));
  const collapsed = options.mergeNearDuplicates === false
    ? ordered
    : mergeNearDuplicateClaims(ordered, options.nearDuplicate);

  const lineComments = [];
  const fileComments = [];
  const advisories = [];
  for (const { subjectType, finding } of collapsed) {
    const common = {
      path: finding.path,
      ...(subjectType === 'line' ? { line: finding.line, side: finding.side } : {}),
      markerKey: findingMarkerKey(finding, subjectType),
      personas: finding.personas,
      finding,
    };
    if (finding.severity === 'P2') {
      advisories.push({
        ...common,
        line: finding.line,
        side: finding.side,
        title: finding.title,
        severity: finding.severity,
      });
    } else if (subjectType === 'file') {
      fileComments.push({ ...common, body: formatFindingCommentBody(finding) });
    } else {
      lineComments.push({ ...common, body: formatFindingCommentBody(finding) });
    }
  }

  lineComments.sort(comparePublicationItems);
  fileComments.sort(comparePublicationItems);
  advisories.sort(comparePublicationItems);
  rejected.sort((a, b) => (
    a.path.localeCompare(b.path)
    || (a.line || 0) - (b.line || 0)
    || normalizeTitle(a.title).localeCompare(normalizeTitle(b.title))
    || a.reason.localeCompare(b.reason)
  ));

  return { lineComments, fileComments, advisories, rejected };
}

module.exports = {
  parsePatchAnchors,
  findingDedupeKey,
  findingMarkerKey,
  formatFindingCommentBody,
  mergeNearDuplicateClaims,
  planFindingPublication,
};
