/**
 * REL-1113: the worker-side view of the terminal deadline -- the absolute instant the operator
 * projects into a worker, as opposed to the admission window in `./terminalDeadline`. Kept in its
 * own side-effect-free module: `./terminalDeadline` resolves and validates the dispatcher's window
 * env at import time, which a worker must never be made to depend on.
 */
/**
 * REL-1113: the worker env var carrying the run's absolute terminal deadline (RFC 3339, UTC).
 * Must equal the Go operator's `TerminalDeadlineEnv` (k8s-operator/pkg/job/job.go), pinned by a
 * parity test. The operator projects it for app-gate workers when map-reduce is configured; when
 * it is absent a worker is still bounded by its panel deadline (`reviewers.overall_timeout_s`),
 * so readers treat absence as "no additional bound", never as "unbounded review".
 */
export const WORKER_TERMINAL_DEADLINE_ENV = 'REVIEW_TERMINAL_DEADLINE';

/** The worker Job is deleted this long before the terminal deadline (Go `DeadlineReserveSeconds`). */
export const WORKER_TERMINAL_DEADLINE_RESERVE_MS = 60_000;

/** REL-1113: the single parser of `WORKER_TERMINAL_DEADLINE_ENV`: epoch ms, or undefined. */
export function workerTerminalDeadlineAtMs(env: Readonly<Record<string, string | undefined>> = process.env): number | undefined {
  const raw = String(env[WORKER_TERMINAL_DEADLINE_ENV] ?? '').trim();
  if (!raw) return undefined;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? at : undefined;
}
