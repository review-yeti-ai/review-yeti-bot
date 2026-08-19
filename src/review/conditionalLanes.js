'use strict';

const { matchReviewGlob } = require('./reviewIgnorePolicy');

const MAX_LANES = 4;
const MAX_PATTERNS_PER_LANE = 20;
const MAX_ADVISORIES_PER_LANE = 10;

function bounded(value, max) {
  return String(value === undefined || value === null ? '' : value).trim().slice(0, max);
}

/**
 * Conditional secondary lanes (OpenReview ethics-review pattern): extra
 * reviewer personas that run only when the diff touches configured paths,
 * publish ADVISORY findings only, and sit entirely outside the coverage
 * denominator — a conditional lane can neither block a verdict nor satisfy
 * quorum. Promotion to gating is a later, explicit policy decision.
 *
 * Configuration: a JSON array of { persona, paths } entries, e.g.
 *   [{"persona":"licensing","paths":["ct-release/**","**\/cli.sh"]}]
 */
function resolveConditionalLanes(raw) {
  const problems = [];
  if (raw === undefined || raw === null || String(raw).trim() === '') return { lanes: [], problems };
  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (error) {
    return { lanes: [], problems: [`conditional lanes JSON is invalid: ${error.message}`] };
  }
  if (!Array.isArray(parsed)) return { lanes: [], problems: ['conditional lanes must be a JSON array'] };
  const lanes = [];
  for (const entry of parsed.slice(0, MAX_LANES)) {
    const persona = bounded(entry?.persona, 100).toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,99}$/.test(persona)) {
      problems.push('conditional lane persona must be a bounded identifier');
      continue;
    }
    const paths = (Array.isArray(entry?.paths) ? entry.paths : [])
      .map((pattern) => bounded(pattern, 200))
      .filter(Boolean)
      .slice(0, MAX_PATTERNS_PER_LANE);
    if (paths.length === 0) {
      problems.push(`conditional lane ${persona} declares no path patterns`);
      continue;
    }
    lanes.push({ persona, paths });
  }
  return { lanes, problems };
}

function matchConditionalLanes(lanes, changedPaths) {
  const paths = Array.isArray(changedPaths) ? changedPaths : [...(changedPaths || [])];
  return (Array.isArray(lanes) ? lanes : [])
    .map((lane) => ({
      ...lane,
      matchedPaths: paths.filter((path) => lane.paths.some((pattern) => matchReviewGlob(pattern, path))).slice(0, 50),
    }))
    .filter((lane) => lane.matchedPaths.length > 0);
}

/**
 * Every conditional-lane finding publishes as a P2 advisory regardless of the
 * severity the lane reported — the severity the lane believed is preserved in
 * the annotation so a human can judge whether the lane deserves promotion.
 */
function demoteToAdvisories(personaId, findings) {
  return (Array.isArray(findings) ? findings : [])
    .slice(0, MAX_ADVISORIES_PER_LANE)
    .map((finding) => ({
      ...finding,
      severity: 'P2',
      title: bounded(finding.title, 200),
      body: `${bounded(finding.body, 1_600)}\n\n_Advisory from conditional \`${bounded(personaId, 100)}\` lane${String(finding.severity || '').toUpperCase() !== 'P2' ? ` (lane assessed ${bounded(String(finding.severity).toUpperCase(), 4)})` : ''}; does not affect the verdict._`,
      conditionalLane: bounded(personaId, 100),
    }));
}

module.exports = {
  MAX_ADVISORIES_PER_LANE,
  MAX_LANES,
  demoteToAdvisories,
  matchConditionalLanes,
  resolveConditionalLanes,
};
