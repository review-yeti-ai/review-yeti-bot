/**
 * Single source of truth for the review terminal deadline window.
 *
 * The DOKS execution lane admits a review with `terminalDeadline = receivedAt
 * + 15 minutes`, then hands the worker Job only the *remainder* of that window
 * as `activeDeadlineSeconds`. Queue wait, capacity wait, image pull, review,
 * persistence, and publication all consume the same admitted budget. This is
 * intentionally a hard end-to-end service ceiling, not a worker-only timer.
 *
 * Three components independently re-derive this same invariant --
 * `actionDispatchApi` (admission), `reviewDispatchRepository` (the
 * persistence invariant), and `reviewJobProjection` (the Kubernetes
 * projection) -- and the Go operator (`k8s-operator/pkg/job` and its
 * controller) enforces its own copy against the same CR. All of them MUST
 * agree on the same window or a valid admission fails projection. This module
 * is the only place the TypeScript side computes it. The Go operator and CRD
 * enforce the same exact value; keep them in lockstep.
 */

const ENV_VAR = 'REVIEW_YETI_TERMINAL_DEADLINE_MS';

/** Exact end-to-end review ceiling. */
export const MIN_TERMINAL_DEADLINE_MS = 900_000;

/** Kept as a named bound for shared validators; it intentionally equals MIN. */
export const MAX_TERMINAL_DEADLINE_MS = 900_000;

/**
 * Default and only accepted value: 15 minutes end to end.
 */
export const DEFAULT_TERMINAL_DEADLINE_MS = 900_000;

/**
 * Upper bound used only to finish runs persisted before the exact 15-minute
 * invariant shipped. It must never be used for admission or projection.
 */
export const LEGACY_MAX_TERMINAL_DEADLINE_MS = 3_600_000;

/**
 * Resolves the terminal-deadline window from `REVIEW_YETI_TERMINAL_DEADLINE_MS`,
 * falling back to `DEFAULT_TERMINAL_DEADLINE_MS` when unset. Throws on a value
 * other than the exact service ceiling, so a deployment cannot silently widen
 * the production SLA through configuration.
 */
export function resolveTerminalDeadlineMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[ENV_VAR];
  if (raw === undefined || raw.trim() === '') return DEFAULT_TERMINAL_DEADLINE_MS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < MIN_TERMINAL_DEADLINE_MS || value > MAX_TERMINAL_DEADLINE_MS) {
    throw new Error(
      `${ENV_VAR} must equal the ${DEFAULT_TERMINAL_DEADLINE_MS} millisecond end-to-end review ceiling (got ${JSON.stringify(raw)})`,
    );
  }
  return value;
}

/** The resolved terminal-deadline window in milliseconds, computed once at module load. */
export const TERMINAL_DEADLINE_MS = resolveTerminalDeadlineMs();

/**
 * Validates that `terminalDeadline - receivedAt` is exactly 15 minutes -- the
 * same invariant the CRD's CEL rule and the Go operator enforce. Shared by
 * `reviewDispatchRepository`'s persistence invariant and
 * `reviewJobProjection`'s Kubernetes projection invariant so the two
 * cannot drift apart from each other the way they drifted from the CRD
 * before REL-733.
 */
export function assertTerminalDeadlineWindow(receivedAt: number, terminalDeadline: number): void {
  const window = terminalDeadline - receivedAt;
  if (
    !Number.isFinite(receivedAt)
    || !Number.isFinite(terminalDeadline)
    || !Number.isFinite(window)
    || window !== DEFAULT_TERMINAL_DEADLINE_MS
  ) {
    throw new Error(`terminal deadline must be exactly ${DEFAULT_TERMINAL_DEADLINE_MS}ms after receipt`);
  }
}

/**
 * Validates a previously persisted run so recovery can close pre-migration
 * 15–60-minute attempts. New admissions and Kubernetes projections must use
 * `assertTerminalDeadlineWindow` instead.
 */
export function assertPersistedTerminalDeadlineWindow(receivedAt: number, terminalDeadline: number): void {
  const window = terminalDeadline - receivedAt;
  if (
    !Number.isFinite(receivedAt)
    || !Number.isFinite(terminalDeadline)
    || !Number.isFinite(window)
    || window < DEFAULT_TERMINAL_DEADLINE_MS
    || window > LEGACY_MAX_TERMINAL_DEADLINE_MS
  ) {
    throw new Error(
      `persisted terminal deadline must be between ${DEFAULT_TERMINAL_DEADLINE_MS}ms and ${LEGACY_MAX_TERMINAL_DEADLINE_MS}ms after receipt`,
    );
  }
}
