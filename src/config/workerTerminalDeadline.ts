/**
 * REL-1113: the worker-side view of the terminal deadline -- the absolute instant the operator
 * projects into a worker, as opposed to the admission window in `./terminalDeadline`. Kept in its
 * own side-effect-free module: `./terminalDeadline` resolves and validates the dispatcher's window
 * env at import time, which a worker must never be made to depend on.
 */
/**
 * REL-1113: the worker env var carrying the run's absolute terminal deadline (RFC 3339, UTC).
 * Must equal the Go operator's `TerminalDeadlineEnv` (k8s-operator/pkg/job/job.go), pinned by a
 * parity test. The operator projects it for every app-gate worker; when
 * it is absent a worker is still bounded by its panel deadline (`reviewers.overall_timeout_s`),
 * so readers treat absence as "no additional bound", never as "unbounded review".
 */
export const WORKER_TERMINAL_DEADLINE_ENV = 'REVIEW_TERMINAL_DEADLINE';

/** The worker Job is deleted this long before the terminal deadline (Go `DeadlineReserveSeconds`). */
export const WORKER_TERMINAL_DEADLINE_RESERVE_MS = 60_000;

/** Existing time inside the Job for the worker receipt (Go `WorkerReceiptReserveSeconds`). */
export const WORKER_RECEIPT_RESERVE_MS = 60_000;
export const WORKER_PANEL_RESERVE_MS = WORKER_TERMINAL_DEADLINE_RESERVE_MS + WORKER_RECEIPT_RESERVE_MS;
/** Go floors remaining seconds before projecting activeDeadlineSeconds. */
export const WORKER_DEADLINE_FLOOR_MARGIN_MS = 1_000;

export interface WorkerPanelDeadlineBudget {
  readonly deadlineAtMs: number;
  readonly timeoutMs: number;
  readonly terminalBound: boolean;
}

/** A fixed work cutoff, never a fresh timeout when passed to a nested engine. */
export function workerPanelDeadlineBudget(
  overallTimeoutSeconds: number,
  env: Readonly<Record<string, string | undefined>> = process.env,
  nowMs = Date.now(),
): WorkerPanelDeadlineBudget {
  // Preserve upstream's explicit lifecycle validation before admitting any work.
  workerPanelTimeoutMs(overallTimeoutSeconds, env, nowMs);
  if (!Number.isFinite(nowMs)) throw new Error('Worker lifecycle deadline is invalid');
  const configuredMs = Number.isFinite(overallTimeoutSeconds) && overallTimeoutSeconds > 0
    ? Math.max(1, Math.floor(overallTimeoutSeconds * 1_000))
    : 900_000;
  const terminalAt = workerTerminalDeadlineAtMs(env);
  const terminalCutoff = terminalAt === undefined ? Infinity
    : terminalAt - WORKER_PANEL_RESERVE_MS - WORKER_DEADLINE_FLOOR_MARGIN_MS;
  const deadlineAtMs = Math.min(nowMs + configuredMs, terminalCutoff);
  return { deadlineAtMs, timeoutMs: Math.max(0, deadlineAtMs - nowMs), terminalBound: terminalCutoff <= nowMs + configuredMs };
}

/** REL-1113: the single parser of `WORKER_TERMINAL_DEADLINE_ENV`: epoch ms, or undefined. */
export function workerTerminalDeadlineAtMs(env: Readonly<Record<string, string | undefined>> = process.env): number | undefined {
  const raw = String(env[WORKER_TERMINAL_DEADLINE_ENV] ?? '').trim();
  if (!raw) return undefined;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? at : undefined;
}

/**
 * The policy is a ceiling, not a fresh admission window. Queueing, image startup and source/setup
 * work consume the admitted deadline too. Leave both existing reserves without changing the
 * digest-bound config. Absence preserves older operator compatibility; an explicit bad deadline
 * must not silently remove this bound. Zero means no panel can start, never the timer's default.
 */
export function workerPanelTimeoutMs(
  overallTimeoutSeconds: number,
  env: Readonly<Record<string, string | undefined>>,
  nowMs: number,
): number {
  const policyMs = Number.isFinite(overallTimeoutSeconds) && overallTimeoutSeconds > 0
    ? Math.max(1, Math.floor(overallTimeoutSeconds * 1_000)) : 900_000;
  if (!String(env[WORKER_TERMINAL_DEADLINE_ENV] ?? '').trim()) return policyMs;
  const deadline = workerTerminalDeadlineAtMs(env);
  if (deadline === undefined || !Number.isFinite(nowMs)) throw new Error('Worker lifecycle deadline is invalid');
  return Math.max(0, Math.min(policyMs, Math.floor(deadline - nowMs - WORKER_PANEL_RESERVE_MS)));
}
