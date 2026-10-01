/**
 * Single source of truth for the review terminal deadline window.
 *
 * The DOKS execution lane admits a review with `terminalDeadline = receivedAt
 * + configured window` (25 minutes by default, bounded at 15-60 minutes for
 * rollout compatibility), then
 * hands the worker Job only the *remainder* of that window
 * as `activeDeadlineSeconds`. Queue wait, capacity wait, image pull, review,
 * persistence, and publication all consume the same admitted budget. This is
 * intentionally a hard end-to-end service ceiling, not a worker-only timer.
 *
 * Three components independently re-derive this same invariant --
 * `actionDispatchApi` (admission), `reviewDispatchRepository` (the
 * persistence invariant), and `reviewJobProjection` (the Kubernetes
 * projection) -- and the Go operator (`k8s-operator/pkg/job` and its
 * controller) enforces its own copy against the same CR. All of them MUST
 * agree on the same configured admission window or a valid admission fails
 * projection. This module is the only place the TypeScript side resolves it.
 * The Go operator and CRD enforce the same supported range; keep them in
 * lockstep.
 */

const ENV_VAR = 'REVIEW_YETI_TERMINAL_DEADLINE_MS';

/**
 * Production default: 25 minutes. The worker reserves the last five minutes
 * for deterministic synthesis, durable completion, and GitHub publication.
 */
export const DEFAULT_TERMINAL_DEADLINE_MS = 1_500_000;

/**
 * Maximum supported admission window: 60 minutes. New admissions use the
 * exact configured value; this upper bound also preserves compatibility with
 * already-admitted longer runs.
 */
export const MAX_TERMINAL_DEADLINE_MS = 3_600_000;

/** Minimum accepted migration value: the former exact 15-minute contract. */
export const MIN_TERMINAL_DEADLINE_MS = 900_000;

/** Retained descriptive name for older callers and migration tests. */
export const LEGACY_MIN_TERMINAL_DEADLINE_MS = MIN_TERMINAL_DEADLINE_MS;

/** Retained name for the persisted-row recovery bound. */
export const LEGACY_MAX_TERMINAL_DEADLINE_MS = MAX_TERMINAL_DEADLINE_MS;

/**
 * Resolves the terminal-deadline window from `REVIEW_YETI_TERMINAL_DEADLINE_MS`,
 * falling back to the 25-minute `DEFAULT_TERMINAL_DEADLINE_MS` when unset.
 * Only decimal integer milliseconds in the inclusive 15–60 minute migration
 * range are accepted; production rollout sets the exact 25-minute value.
 */
export function resolveTerminalDeadlineMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[ENV_VAR];
  if (raw === undefined || raw.trim() === '') return DEFAULT_TERMINAL_DEADLINE_MS;
  const normalized = raw.trim();
  const value = Number(normalized);
  if (
    !/^\d+$/u.test(normalized)
    || !Number.isSafeInteger(value)
    || value < MIN_TERMINAL_DEADLINE_MS
    || value > MAX_TERMINAL_DEADLINE_MS
  ) {
    throw new Error(
      `${ENV_VAR} must be an integer between ${MIN_TERMINAL_DEADLINE_MS} and ${MAX_TERMINAL_DEADLINE_MS} milliseconds (got ${JSON.stringify(raw)})`,
    );
  }
  return value;
}

/** The resolved terminal-deadline window in milliseconds, computed once at module load. */
export const TERMINAL_DEADLINE_MS = resolveTerminalDeadlineMs();

/**
 * Validates that `terminalDeadline - receivedAt` equals this process's
 * configured admission window. New admissions use this exact check before
 * persistence. The CRD and Go operator enforce the broader supported 15–60
 * minute range for durable projections.
 */
export function assertTerminalDeadlineWindow(receivedAt: number, terminalDeadline: number): void {
  const window = terminalDeadline - receivedAt;
  if (
    !Number.isFinite(receivedAt)
    || !Number.isFinite(terminalDeadline)
    || !Number.isFinite(window)
    || window !== TERMINAL_DEADLINE_MS
  ) {
    throw new Error(`terminal deadline must be exactly ${TERMINAL_DEADLINE_MS}ms after receipt`);
  }
}

/**
 * Validates a previously persisted run so dispatch can project it and recovery
 * can close it after the process configuration changes. New admissions must
 * use `assertTerminalDeadlineWindow`; projections preserve the stored window
 * within this supported range.
 */
export function assertPersistedTerminalDeadlineWindow(receivedAt: number, terminalDeadline: number): void {
  const window = terminalDeadline - receivedAt;
  if (
    !Number.isFinite(receivedAt)
    || !Number.isFinite(terminalDeadline)
    || !Number.isFinite(window)
    || window < MIN_TERMINAL_DEADLINE_MS
    || window > MAX_TERMINAL_DEADLINE_MS
  ) {
    throw new Error(
      `persisted terminal deadline must be between ${MIN_TERMINAL_DEADLINE_MS}ms and ${MAX_TERMINAL_DEADLINE_MS}ms after receipt`,
    );
  }
}
