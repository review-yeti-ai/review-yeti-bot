/**
 * REL-1138: make W5 (risk-ordered review budget, REL-1082) savings measurable.
 *
 * The budget log line counted files by depth but had no before/after size, so the
 * 2026-09-25 calibration could not say what packing saved. This sums, over every budgeted
 * lane and file, the characters the lane would have received with the budget off
 * (`baselineChars`, today's 20k-cut patch) against what it did receive (`sentChars`).
 *
 * - `charsSaved` is the net figure: baseline minus sent, across all lanes. It can be negative
 *   when upgrades past the per-file cut add more than signatures and listing removed.
 * - `charsRemoved` / `charsAdded` split the net into its two directions (`charsAdded` is
 *   mostly whole files sent past the cut, plus the packer's short notes on tiny patches).
 * - A lane that fell back to today's content (`fallback`) saved nothing and is only counted.
 * - A file entry without `baselineChars` (a disclosure from an older writer) is skipped and
 *   counted in `filesWithoutBaseline`, never guessed.
 *
 * Characters, not tokens: the log stays deterministic and free of tokenizer assumptions.
 */
import type { ReviewBudgetDisclosure } from '../types/reviewBudget';

/** Per-depth file counts and character totals for one set of lane-file slots. */
export interface ReviewBudgetSavingsCounts {
  /** Lane-file slots by depth. `filesListedOnly` is `not-deeply-reviewed`. */
  filesFull: number;
  filesTruncated: number;
  filesSignatureOnly: number;
  filesListedOnly: number;
  baselineChars: number;
  sentChars: number;
  charsSaved: number;
  charsRemoved: number;
  charsAdded: number;
  filesWithoutBaseline: number;
}

/** One lane's savings, so the log line shows which lane W5 actually shrank. */
export interface ReviewBudgetLaneSavings extends ReviewBudgetSavingsCounts {
  laneId: string;
  /** True when the lane fell back to today's content (it saved nothing). */
  fallback: boolean;
}

export interface ReviewBudgetSavings extends ReviewBudgetSavingsCounts {
  fallbackLanes: number;
  /** Per-lane breakdown; the totals above are exactly the sums of these rows. */
  perLane: ReviewBudgetLaneSavings[];
}

function emptyCounts(): ReviewBudgetSavingsCounts {
  return {
    filesFull: 0,
    filesTruncated: 0,
    filesSignatureOnly: 0,
    filesListedOnly: 0,
    baselineChars: 0,
    sentChars: 0,
    charsSaved: 0,
    charsRemoved: 0,
    charsAdded: 0,
    filesWithoutBaseline: 0,
  };
}

const COUNT_KEYS = Object.keys(emptyCounts()) as Array<keyof ReviewBudgetSavingsCounts>;

function summarizeLane(lane: ReviewBudgetDisclosure['lanes'][number]): ReviewBudgetLaneSavings {
  const out: ReviewBudgetLaneSavings = { laneId: lane.laneId, fallback: Boolean(lane.fallback), ...emptyCounts() };
  for (const file of lane.files) {
    if (file.depth === 'full') out.filesFull += 1;
    else if (file.depth === 'truncated') out.filesTruncated += 1;
    else if (file.depth === 'signatures') out.filesSignatureOnly += 1;
    else if (file.depth === 'not-deeply-reviewed') out.filesListedOnly += 1;
    const baseline = file.baselineChars;
    if (typeof baseline !== 'number' || !Number.isFinite(baseline) || !Number.isFinite(file.sentChars)) {
      out.filesWithoutBaseline += 1;
      continue;
    }
    out.baselineChars += baseline;
    out.sentChars += file.sentChars;
    const delta = baseline - file.sentChars;
    if (delta >= 0) out.charsRemoved += delta;
    else out.charsAdded += -delta;
  }
  out.charsSaved = out.baselineChars - out.sentChars;
  return out;
}

export function summarizeReviewBudgetSavings(disclosure: Pick<ReviewBudgetDisclosure, 'lanes'>): ReviewBudgetSavings {
  const perLane = disclosure.lanes.map(summarizeLane);
  const out: ReviewBudgetSavings = { ...emptyCounts(), fallbackLanes: 0, perLane };
  for (const lane of perLane) {
    if (lane.fallback) out.fallbackLanes += 1;
    for (const key of COUNT_KEYS) out[key] += lane[key];
  }
  return out;
}
