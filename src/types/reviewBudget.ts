/**
 * Value types for the risk-ordered review budget (REL-1082), shared by the
 * worker, both review engines and `PanelResult`. They live in this neutral
 * module, like `diffShrink`, so the panel's result contract does not compile
 * against the packing logic in `../review/reviewBudget`.
 */

/** Worker input for `REVIEW_YETI_BUDGET`. Absent or `enabled: false` sends every lane today's content. */
export interface ReviewBudgetInput {
  enabled: boolean;
}

/**
 * Deterministic packing category, from the path alone. Content is untrusted
 * and never consulted, so a file cannot talk its way into a lower category.
 */
export type BudgetCategory = 'security-sensitive' | 'ci-iac' | 'source' | 'test' | 'config' | 'docs';

/**
 * What a lane received for one file:
 * - `full`: the whole patch, including any part past the 20k per-file cut.
 * - `truncated`: today's 20k-cut patch (only a full-depth file whose whole
 *   patch did not fit the per-request cap).
 * - `signatures`: hunk headers and changed declaration lines, extracted
 *   deterministically from the patch. Never used for a full-depth category.
 * - `not-deeply-reviewed`: a one-line note; the patch stays reachable through
 *   the lane's read-only tools.
 */
export type BudgetDepth = 'full' | 'truncated' | 'signatures' | 'not-deeply-reviewed';

export interface BudgetFileEntry {
  path: string;
  category: BudgetCategory;
  depth: BudgetDepth;
  /** Characters of the whole patch (before any per-file cut). */
  originalChars: number;
  /** Characters of the text this lane received for the file. */
  sentChars: number;
  /** True when the lane received more than the 20k per-file cut would have sent. */
  pastPerFileCut: boolean;
}

export interface ReviewBudgetLaneDisclosure {
  /** Persona id, or `composed` for the composed engine's single context. */
  laneId: string;
  budgetChars: number;
  packedChars: number;
  files: BudgetFileEntry[];
}

export interface ReviewBudgetDisclosure {
  /** What ordered the packing. Jev risk is not used until it is calibrated (plan section 5, item 6). */
  ordering: 'deterministic-category';
  requestCapBytes: number;
  lanes: ReviewBudgetLaneDisclosure[];
}
