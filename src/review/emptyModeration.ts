/**
 * REL-1139 (ct-meta ADR 0687, proposed): skip the MODERATOR call on a panel run where every lane
 * completed with an empty APPROVE and the run had full coverage. The arbiter still runs, on the
 * deterministic empty ledger. Behind `REVIEW_YETI_SKIP_EMPTY_MODERATION`, default off.
 *
 * This is the one decision. The worker panel (`panelEngine.ts`) evaluates it to decide whether to
 * call the moderator, and logs its answer on every run as `moderator_shadow_skip_eligible`
 * whatever the flag says, so the ADR's evidence can be gathered while the flag stays off. The
 * trusted completion side (`deriveCanonicalWorkerReviewEvidence`) evaluates the SAME function on
 * its own exact-head diff and refuses a completion that claims a skip this decision does not allow.
 *
 * Fail closed: every condition must hold, and a missing or malformed fact is ineligible. The rule
 * never changes lane coverage, depth or the verdict; it only removes a no-op reconciliation step
 * after full coverage has already happened.
 */
import { repositoryFlagEnabledFor } from './repositoryFlag';
import { isSecuritySensitivePath } from './securitySensitivePaths';

export const SKIP_EMPTY_MODERATION_FLAG = 'REVIEW_YETI_SKIP_EMPTY_MODERATION';

/** The completion claim and telemetry value for a run whose moderator call was skipped. */
export const EMPTY_MODERATION_SKIPPED = 'skipped-empty' as const;

/** Model label on the deterministic moderator result, so a skipped run is never mistaken for a model call. */
export const EMPTY_MODERATION_SKIPPED_MODEL = 'skipped-empty-moderation';

/** The one published reason. The worker's check summary carries it verbatim. */
export const EMPTY_MODERATION_SKIP_REASON =
  'Moderator skipped: every review lane completed with an empty APPROVE (no findings of any severity), '
  + 'coverage was full, nothing was truncated, omitted, routed or reduced, and no security-sensitive file changed '
  + `(${SKIP_EMPTY_MODERATION_FLAG}, ct-meta ADR 0687). The arbiter still ran on the empty ledger; `
  + 'the verdict is SHIP because no lane found anything.';

/**
 * `REVIEW_YETI_SKIP_EMPTY_MODERATION` uses the shared per-repository flag grammar
 * (`repositoryFlagEnabledFor`, the same code as `REVIEW_YETI_INCREMENTAL`):
 * - unset, empty, `0`, `false` or `off` is off (the default);
 * - `1`, `true`, `on` or `all` is on for every repository;
 * - anything else is a comma- or space-separated list of `owner/repo` names it is on for
 *   (case-insensitive).
 */
export function skipEmptyModerationEnabledFor(
  env: Readonly<Record<string, string | undefined>>,
  repository: string,
): boolean {
  return repositoryFlagEnabledFor(env, SKIP_EMPTY_MODERATION_FLAG, repository);
}

/** One lane as both sides see it. `findings` absent or not an array is ineligible. */
export interface EmptyModerationLane {
  id: string;
  decision: string;
  status?: string;
  findings?: readonly unknown[] | null;
  notApplicable?: boolean;
  errorClass?: string;
}

/**
 * The run's facts. Every count is the number of files (or entries) in that class; the decision
 * needs each to be exactly 0. A fact a side cannot see is passed as 0 by that side, which is why
 * the worker (which sees more) is at least as strict as the trusted side.
 */
export interface EmptyModerationFacts {
  /** The required lane roster (the shared applicability decision). */
  expectedLaneIds: readonly string[];
  /** The lanes that returned a result. */
  lanes: readonly EmptyModerationLane[];
  /** Lanes that failed, timed out or were never reported (`optionalFailures`). */
  failedLaneCount: number;
  /** The side's own coverage decision (unreadable headers, omitted source, roster). */
  coverageComplete: boolean;
  /** Every changed path of the run; any security-sensitive path (REL-1135 predicate) is ineligible. */
  changedPaths: readonly string[];
  /** REL-1092 disclosures. */
  truncatedFiles: number;
  unavailablePatches: number;
  omittedSourcePaths: number;
  /** REL-1088 routed files, and paths no lane covers. */
  routedFiles: number;
  uncoveredPaths: number;
  /** W2 diff shrink, W5 budget reductions and fallbacks, W6 map-reduce lanes (worker-only). */
  reducedDepthEntries: number;
  /** W7 carried-forward files and W8 cache-served files. */
  incrementalCarriedFiles: number;
  verdictCacheServedFiles: number;
  /** Static-analyzer hypotheses (gitleaks, semgrep, ...) the lanes were asked to adjudicate (worker-only). */
  analyzerHypotheses: number;
}

export const emptyModerationIneligibleReasons = [
  'no-lanes',
  'lane-failed',
  'lane-missing',
  'lane-not-applicable',
  'lane-not-approve',
  'lane-findings',
  'coverage-incomplete',
  'security-sensitive-file',
  'truncated',
  'patch-unavailable',
  'omitted-source',
  'routed-files',
  'uncovered-paths',
  'reduced-depth',
  'incremental-carry-forward',
  'verdict-cache-served',
  'analyzer-hypotheses',
  'malformed',
] as const;
export type EmptyModerationIneligibleReason = typeof emptyModerationIneligibleReasons[number];

export type EmptyModerationDecision =
  | { eligible: true }
  | { eligible: false; reason: EmptyModerationIneligibleReason };

const ineligible = (reason: EmptyModerationIneligibleReason): EmptyModerationDecision => ({ eligible: false, reason });

function zero(value: unknown): boolean | null {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return null;
  return value === 0;
}

/**
 * True only when every condition for an empty, fully covered run holds. The flag is NOT an input:
 * eligibility is logged on every run, and the caller skips only when it is also enabled.
 */
export function decideEmptyModeration(facts: EmptyModerationFacts): EmptyModerationDecision {
  if (!facts || !Array.isArray(facts.expectedLaneIds) || !Array.isArray(facts.lanes) || !Array.isArray(facts.changedPaths)) {
    return ineligible('malformed');
  }
  if (facts.expectedLaneIds.length === 0 || facts.lanes.length === 0) return ineligible('no-lanes');
  const failed = zero(facts.failedLaneCount);
  if (failed === null) return ineligible('malformed');
  if (!failed) return ineligible('lane-failed');
  const ids = new Set<string>();
  for (const lane of facts.lanes) {
    if (!lane || typeof lane.id !== 'string' || ids.has(lane.id)) return ineligible('malformed');
    ids.add(lane.id);
  }
  const expected = new Set(facts.expectedLaneIds);
  if (expected.size !== facts.expectedLaneIds.length) return ineligible('malformed');
  if (facts.lanes.length !== expected.size || [...expected].some((id) => !ids.has(id))) return ineligible('lane-missing');
  for (const lane of facts.lanes) {
    if (lane.status === 'ERROR' || lane.decision === 'ERROR' || lane.errorClass !== undefined) return ineligible('lane-failed');
    if (lane.notApplicable === true) return ineligible('lane-not-applicable');
    if (lane.decision !== 'APPROVE') return ineligible('lane-not-approve');
    if (lane.status !== undefined && lane.status !== 'COMPLETE') return ineligible('lane-failed');
    if (!Array.isArray(lane.findings)) return ineligible('malformed');
    if (lane.findings.length > 0) return ineligible('lane-findings');
  }
  if (facts.coverageComplete !== true) return ineligible('coverage-incomplete');
  if (facts.changedPaths.length === 0) return ineligible('malformed');
  if (facts.changedPaths.some((path) => isSecuritySensitivePath(path))) return ineligible('security-sensitive-file');
  const counts: Array<[unknown, EmptyModerationIneligibleReason]> = [
    [facts.truncatedFiles, 'truncated'],
    [facts.unavailablePatches, 'patch-unavailable'],
    [facts.omittedSourcePaths, 'omitted-source'],
    [facts.routedFiles, 'routed-files'],
    [facts.uncoveredPaths, 'uncovered-paths'],
    [facts.reducedDepthEntries, 'reduced-depth'],
    [facts.incrementalCarriedFiles, 'incremental-carry-forward'],
    [facts.verdictCacheServedFiles, 'verdict-cache-served'],
    [facts.analyzerHypotheses, 'analyzer-hypotheses'],
  ];
  for (const [count, reason] of counts) {
    const isZero = zero(count);
    if (isZero === null) return ineligible('malformed');
    if (!isZero) return ineligible(reason);
  }
  return { eligible: true };
}
