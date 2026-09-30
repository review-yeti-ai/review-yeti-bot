export interface IncompleteRosterSummaryCounts {
  canonicalFindingCount: number;
  rawFindingCount: number;
  /** Keep the source spelling so callers can preserve their previous lexical checks. */
  canonicalFindingCountText: string;
  rawFindingCountText: string;
  expectedLanes: number;
  completedLanes: number;
}

/** Render the exact Gate summary used to describe an incomplete review roster. */
export function formatIncompleteRosterGateSummary(expectedLanes: number, completedLanes: number): string {
  return `Review Yeti Gate failed: the panel expected ${expectedLanes} review lane(s) but ${completedLanes} completed. This is an incomplete review, not a findings verdict; re-dispatch the review for this head.`;
}

/** Parse the worker's incomplete-roster summary without imposing consumer-specific
 * finding-count limits. The persistence layer applies its own archive bounds; the
 * recovery validator retains the older summary contract for zero-finding retries. */
export function parseIncompleteRosterSummary(
  summary: unknown,
  headSha: string,
): IncompleteRosterSummaryCounts | null {
  if (typeof summary !== 'string') return null;
  const lines = summary.split('\n');
  if (lines[0] !== `Verdict \`BLOCK\` at \`${headSha}\`.`) return null;

  const findingLines = lines.filter((line) => line.startsWith('Findings: '));
  const coverageLines = lines.filter((line) => line.startsWith('Coverage: '));
  if (findingLines.length !== 1 || coverageLines.length !== 1) return null;

  const findings = /^Findings: ([0-9]+) \(blocking P0\/P1: 0; ([0-9]+) raw persona finding\(s\) before clustering\)\.$/u.exec(findingLines[0]);
  if (!findings) return null;

  const panel = /^Coverage: mode=panel; expected lanes=([0-9]+); completed lanes=([0-9]+); failed lanes=0; roster valid=false; quorum satisfied=false; full panel complete=false\.$/u.exec(coverageLines[0]);
  const composed = /^Coverage: engine=composed; planned tasks=([0-9]+); expected tasks=([0-9]+); completed tasks=([0-9]+); failed tasks=0; roster valid=false; quorum satisfied=false; task coverage complete=false\.$/u.exec(coverageLines[0]);
  if (!panel && !composed) return null;

  const expectedLanes = Number(panel ? panel[1] : composed![2]);
  const completedLanes = Number(panel ? panel[2] : composed![3]);
  if (!Number.isSafeInteger(expectedLanes) || expectedLanes <= 0
    || !Number.isSafeInteger(completedLanes) || completedLanes < 0
    || completedLanes >= expectedLanes
    || (composed && Number(composed[1]) !== expectedLanes)) return null;

  return {
    canonicalFindingCount: Number(findings[1]),
    rawFindingCount: Number(findings[2]),
    canonicalFindingCountText: findings[1],
    rawFindingCountText: findings[2],
    expectedLanes,
    completedLanes,
  };
}
