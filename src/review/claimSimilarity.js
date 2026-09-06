'use strict';

/**
 * Claim identity for review findings.
 *
 * A review panel re-reports the same defect under a different title on every push, and two
 * personas reporting one defect eight lines apart look like two defects to any key built from
 * `path + line + title`. Both are title diffs, and a title diff must not defeat deduplication.
 *
 * Everything here works on the *claim* — what the finding says is wrong — rather than on its
 * wording, so it is stable across reruns and across reviewers.
 */

/**
 * Words that carry no claim identity. Deliberately conservative: dropping a domain word would
 * make two unrelated findings look alike, which is a worse failure than leaving a duplicate in.
 */
const STOPWORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'also', 'an', 'and', 'any', 'are',
  'as', 'at', 'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by',
  'can', 'could', 'did', 'do', 'does', 'doing', 'during', 'each', 'even', 'ever', 'every', 'for',
  'from', 'further', 'had', 'has', 'have', 'having', 'here', 'how', 'if', 'in', 'into', 'is', 'it',
  'its', 'itself', 'just', 'least', 'less', 'like', 'may', 'might', 'more', 'most', 'much', 'must',
  'never', 'now', 'of', 'off', 'on', 'once', 'only', 'or', 'other', 'our', 'out', 'over', 'own',
  'same', 'shall', 'she', 'should', 'since', 'so', 'some', 'still', 'such', 'than', 'that', 'the',
  'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'to', 'too',
  'under', 'until', 'up', 'upon', 'very', 'was', 'we', 'were', 'what', 'when', 'where', 'which',
  'while', 'who', 'whom', 'why', 'will', 'with', 'would', 'yet', 'you', 'your',
]);

/** Prefix length below which a token is not stemmed, so short domain words stay intact. */
const MIN_STEM_LENGTH = 4;

/**
 * Reduces a token to a crude stem. This is not linguistics — it only has to make `dropping`,
 * `drops`, and `dropped` agree, because a persona rephrasing a claim changes exactly that much.
 */
function stem(token) {
  let value = token;
  for (const suffix of ['ingly', 'edly', 'ing', 'ies', 'ied', 'ers', 'er', 'ed', 'es', 's']) {
    if (value.length - suffix.length >= MIN_STEM_LENGTH && value.endsWith(suffix)) {
      value = value.slice(0, -suffix.length);
      break;
    }
  }
  // `dropp` from `dropping`, `runn` from `running`: collapse the doubled consonant.
  if (value.length > MIN_STEM_LENGTH && /([bdfglmnprt])\1$/.test(value)) value = value.slice(0, -1);
  return value;
}

/**
 * Splits text into claim tokens.
 *
 * Identifiers are split on camelCase and on `_`/`.`/`/` so `HasInventoryAccessAsync` and
 * "material support" describe the same claim. Numbers are kept: a column count or a threshold is
 * frequently the whole difference between two claims about one line.
 */
function claimTokens(text) {
  if (typeof text !== 'string' || !text) return new Set();
  const words = text
    .replace(/`+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/);

  const tokens = new Set();
  for (const word of words) {
    if (!word) continue;
    if (/^\d+$/.test(word)) { tokens.add(word); continue; }
    if (word.length < 2 || STOPWORDS.has(word)) continue;
    const stemmed = stem(word);
    if (stemmed && !STOPWORDS.has(stemmed)) tokens.add(stemmed);
  }
  return tokens;
}

/** How much of the claim body is read. Enough for the thesis, short of the supporting detail. */
const BODY_CLAIM_CHARS = 400;

function findingText(finding) {
  const title = typeof (finding && finding.title) === 'string' ? finding.title : '';
  const body = typeof (finding && finding.body) === 'string' ? finding.body : '';
  return { title, body: body.slice(0, BODY_CLAIM_CHARS) };
}

/** Token set describing what a finding claims, drawn from its title and the opening of its body. */
function findingClaimTokens(finding) {
  const { title, body } = findingText(finding);
  return claimTokens(`${title} ${body}`);
}

/** Jaccard overlap of two token sets. 0 when either is empty. */
function jaccard(a, b) {
  if (!a || !b || a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/**
 * How much of the similarity score the title carries.
 *
 * The title is where a reviewer states the claim, so two findings titled identically are the same
 * claim even when their explanations diverge. Scoring title and body as one bag of words loses
 * that: two reports of one defect at the same spot scored 0.53 on the pull request this was
 * calibrated against, purely because each persona explained it in its own words.
 */
const TITLE_WEIGHT = 0.6;

/**
 * Similarity of two findings' claims, in [0, 1]. Blends title agreement with agreement across the
 * title and the opening of the body, so neither a reworded title nor a reworded body alone can
 * make one defect look like two.
 */
function claimSimilarity(a, b) {
  const titleSimilarity = jaccard(claimTokens(findingText(a).title), claimTokens(findingText(b).title));
  const fullSimilarity = jaccard(findingClaimTokens(a), findingClaimTokens(b));
  return TITLE_WEIGHT * titleSimilarity + (1 - TITLE_WEIGHT) * fullSimilarity;
}

/**
 * A stable, order-independent string form of a claim. Two findings with the same claim key are
 * the same claim however differently they were titled.
 */
function claimKey(finding) {
  return [...findingClaimTokens(finding)].sort().join(' ');
}

/**
 * Claim archetypes that recur across reviewers and reruns under endlessly varied titles.
 *
 * These are matched, rather than left to token overlap, because the wording of "there is no test
 * for this" has almost nothing in common from one persona to the next while the claim is
 * identical — and because both archetypes are unsound to assert from a partial view of the diff.
 */
const MISSING_TESTS_RE = /\b(?:no|without|lack(?:s|ing)?|missing|add|need(?:s|ed)?|require(?:s|d)?|writ(?:e|ing))\b[^.!?]{0,80}\b(?:tests?|test\s+coverage|regression\s+tests?|unit\s+tests?)\b|\btests?\b[^.!?]{0,60}(?:are|is)?\s*(?:missing|absent|not\s+(?:present|included|provided|written)|do(?:es)?\s+not\s+(?:exist|cover))\b|\b(?:untested|uncovered\s+by\s+tests)\b/i;

/**
 * Something is asserted not to be there. On its own this is far too broad to act on: "dismissal
 * has no authorization check" is a real defect in code that is present, and reads the same way.
 */
const ABSENCE_VERB_RE = /\b(?:is|are|were|was)\s+(?:still\s+)?(?:missing|absent)\b|\bmissing\s+(?:from|in)\b|\bnot\s+(?:defined|declared|included|present|provided|implemented|committed|exposed|shipped|generated|regenerated)\b|\b(?:does|do|did)\s+not\s+(?:exist|include|contain|add|update|define|provide|ship|expose|regenerate)\b|\b(?:adds|contains|includes|introduces)\s+(?:no|neither|none\s+of)\b|\bnever\s+(?:defined|added|committed|generated)\b|\bcannot\s+compile\b|\bomitted\s+from\b|\bhas\s+no\s+published\b/i;

/**
 * The absent thing is scoped to *the change under review* — as opposed to a missing check inside
 * code the change does add. Only this second signal makes an absence claim one that a partial
 * view of the diff cannot support.
 */
const CHANGE_SCOPE_RE = /\b(?:this|the)\s+(?:diff|patch|changeset|pull\s+request|pr)\b|\bin\s+this\s+change\b|\bthis\s+change\s+(?:adds|registers|references|introduces)\b|\banywhere\s+in\s+the\s+(?:diff|patch|change|pr)\b|\bas\s+(?:submitted|supplied|written)\b|\bcannot\s+compile\b|\bnot\s+committed\b/i;

/** The absent thing is a code artifact that should exist somewhere, not a behavior. */
const MISSING_ARTIFACT_RE = /\b(?:missing|no|without|absent|neither|nor)\b[^.!?]{0,70}\b(?:implementations?|artifacts?|source\s+files?|definitions?|declarations?|contracts?|generated\s+\w+|client\s+\w+|api\s+surface)\b|\b(?:implementations?|artifacts?|source\s+files?|definitions?|declarations?|contracts?|api\s+surface)\b[^.!?]{0,50}\b(?:missing|absent|not\s+(?:present|included|provided|generated|exposed))\b/i;

/**
 * Classifies what kind of claim a finding makes. `generic` means "no archetype matched", which is
 * the common case and the one that still relies on token overlap.
 */
function claimType(finding) {
  const { title, body } = findingText(finding);
  const text = `${title}. ${body}`;
  if (MISSING_TESTS_RE.test(text)) return 'missing-tests';
  if (ABSENCE_VERB_RE.test(text) && (CHANGE_SCOPE_RE.test(text) || MISSING_ARTIFACT_RE.test(text))) {
    return 'absence';
  }
  return 'generic';
}

/**
 * True when a finding's claim is that something is not in the change.
 *
 * Such a claim can only be sound if the reviewer saw the whole change. Under multi-pass review, or
 * when paths were excluded by configuration, no reviewer did.
 */
function assertsAbsence(finding) {
  const type = claimType(finding);
  return type === 'absence' || type === 'missing-tests';
}

/*
 * Thresholds below are calibrated against the 65 findings this bot actually posted on
 * example-org/example-app#4821, not chosen for roundness. In that corpus, similarity does not separate
 * duplicates from neighbours cleanly: a genuine duplicate pair scores 0.383 and a genuine
 * *non*-duplicate pair ("cancel must serialize with completion" against "serialize approval with
 * completion") scores 0.377. There is no cut that takes every duplicate and no distinct finding.
 *
 * So these are set to under-merge. Leaving a duplicate in costs the author one extra comment;
 * merging two distinct defects hides one, and hiding a real P0/P1 is the failure this tool cannot
 * afford. Every pair above the bar in that corpus was checked by hand and is a true duplicate.
 */

/** Similarity above which two findings close together on one file are treated as one claim. */
const NEAR_DUPLICATE_THRESHOLD = 0.45;

/**
 * Similarity above which distance stops mattering. Two findings this alike are the same defect
 * whether they were anchored two lines apart or thirty.
 */
const STRONG_DUPLICATE_THRESHOLD = 0.5;

/** Line distance within which two ordinary findings on one file may describe one defect. */
const NEAR_DUPLICATE_LINE_WINDOW = 10;

function lineOf(finding) {
  const line = Number(finding && finding.line);
  return Number.isInteger(line) ? line : null;
}

function normalizedPath(finding) {
  const value = finding && finding.path;
  return typeof value === 'string' ? value.replace(/\\/g, '/').replace(/^\.\//, '').trim() : '';
}

/**
 * Decides whether two findings are the same claim.
 *
 * Findings on different files are never merged: an identical claim about two files is two defects.
 * Within one file:
 *
 * - archetype claims (`missing-tests`, `absence`) merge file-wide, because "this file's new code
 *   has no tests" is one fact about the file and anchoring it to six different lines does not
 *   make it six facts;
 * - everything else merges when the claims overlap strongly enough, either close together or —
 *   at a higher bar — anywhere in the file.
 *
 * @returns {{duplicate: boolean, similarity: number, reason: string}}
 */
function compareClaims(a, b, options = {}) {
  const threshold = options.threshold ?? NEAR_DUPLICATE_THRESHOLD;
  const strongThreshold = options.strongThreshold ?? STRONG_DUPLICATE_THRESHOLD;
  const lineWindow = options.lineWindow ?? NEAR_DUPLICATE_LINE_WINDOW;

  if (!normalizedPath(a) || normalizedPath(a) !== normalizedPath(b)) {
    return { duplicate: false, similarity: 0, reason: 'different file' };
  }

  const similarity = claimSimilarity(a, b);
  const typeA = claimType(a);
  const typeB = claimType(b);

  if (typeA !== 'generic' && typeA === typeB) {
    return { duplicate: true, similarity, reason: `same ${typeA} claim about the same file` };
  }
  if (typeA !== typeB) {
    return { duplicate: false, similarity, reason: 'different kind of claim' };
  }

  if (similarity >= strongThreshold) {
    return { duplicate: true, similarity, reason: 'near-identical claim in the same file' };
  }

  const lineA = lineOf(a);
  const lineB = lineOf(b);
  const bothAnchored = lineA !== null && lineB !== null;
  const withinWindow = bothAnchored ? Math.abs(lineA - lineB) <= lineWindow : !bothAnchored;
  if (withinWindow && similarity >= threshold) {
    return { duplicate: true, similarity, reason: 'overlapping claim within the line window' };
  }

  return { duplicate: false, similarity, reason: 'distinct claim' };
}

/** Convenience predicate over {@link compareClaims}. */
function isNearDuplicate(a, b, options = {}) {
  return compareClaims(a, b, options).duplicate;
}

module.exports = {
  NEAR_DUPLICATE_LINE_WINDOW,
  NEAR_DUPLICATE_THRESHOLD,
  STRONG_DUPLICATE_THRESHOLD,
  TITLE_WEIGHT,
  assertsAbsence,
  claimKey,
  claimSimilarity,
  claimTokens,
  claimType,
  compareClaims,
  findingClaimTokens,
  isNearDuplicate,
  jaccard,
};
