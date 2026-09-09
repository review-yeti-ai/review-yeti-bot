/**
 * Single source of truth for the review terminal deadline window.
 *
 * REL-733: the DOKS execution lane admits a review with `terminalDeadline =
 * receivedAt + <window>`, then only hands the worker Job the *remainder* of
 * that window as `activeDeadlineSeconds` (queue wait, capacity waits, and
 * image pulls all eat into it before the worker container starts). A fixed
 * 900_000ms (15 minute) window left no margin for a cisco-cdr six-persona
 * review on a 1-CPU worker even when the worker started promptly --
 * measured activeDeadlineSeconds of 753s/839s were not enough.
 *
 * Three components independently re-derive this same invariant --
 * `actionDispatchApi` (admission), `reviewDispatchRepository` (the
 * persistence invariant), and `reviewJobProjection` (the Kubernetes
 * projection) -- and the Go operator (`k8s-operator/pkg/job` and its
 * controller) enforces its own copy against the same CR. All of them MUST
 * agree on the same window or a valid admission fails projection. This
 * module is the only place the TypeScript side computes it; the Go side
 * cannot read this env var and instead accepts any window the CRD's CEL
 * rule allows (see charts/review-yeti/templates/crd.yaml and
 * k8s-operator/config/crd/bases/review-yeti.ai_prreviewjobs.yaml) -- keep
 * MIN/MAX here in lockstep with those CEL bounds.
 */

const ENV_VAR = 'REVIEW_YETI_TERMINAL_DEADLINE_MS';

/** Floor: the original window. Never shrink below what already shipped. */
export const MIN_TERMINAL_DEADLINE_MS = 900_000;

/** Ceiling: bounds unbounded growth so a stuck run still terminates inside an hour. */
export const MAX_TERMINAL_DEADLINE_MS = 3_600_000;

/**
 * Default: 30 minutes. Chosen from the REL-733 DOKS measurement -- a
 * cisco-cdr six-persona review needs more than the 15-minute original
 * window even when the worker starts promptly.
 */
export const DEFAULT_TERMINAL_DEADLINE_MS = 1_800_000;

/**
 * Resolves the terminal-deadline window from `REVIEW_YETI_TERMINAL_DEADLINE_MS`,
 * falling back to `DEFAULT_TERMINAL_DEADLINE_MS` when unset. Throws on a value
 * outside `[MIN_TERMINAL_DEADLINE_MS, MAX_TERMINAL_DEADLINE_MS]` or that is not a
 * safe integer, so a misconfigured deployment fails fast instead of admitting
 * reviews against a window the CRD will reject at projection time.
 */
export function resolveTerminalDeadlineMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[ENV_VAR];
  if (raw === undefined || raw.trim() === '') return DEFAULT_TERMINAL_DEADLINE_MS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < MIN_TERMINAL_DEADLINE_MS || value > MAX_TERMINAL_DEADLINE_MS) {
    throw new Error(
      `${ENV_VAR} must be a safe integer between ${MIN_TERMINAL_DEADLINE_MS} and ${MAX_TERMINAL_DEADLINE_MS} milliseconds (got ${JSON.stringify(raw)})`,
    );
  }
  return value;
}

/** The resolved terminal-deadline window in milliseconds, computed once at module load. */
export const TERMINAL_DEADLINE_MS = resolveTerminalDeadlineMs();

/**
 * Validates that `terminalDeadline - receivedAt` falls inside the bounded
 * [MIN_TERMINAL_DEADLINE_MS, MAX_TERMINAL_DEADLINE_MS] window -- the same
 * range the CRD's CEL rule and the Go operator's `validateInput` enforce.
 * Deliberately a range check, not exact equality to the current process's
 * `TERMINAL_DEADLINE_MS`: a run admitted under one env-resolved value must
 * not fail this check later (retry claim, re-admission, projection) just
 * because a dispatcher restart or rolling config update picked up a
 * different `REVIEW_YETI_TERMINAL_DEADLINE_MS`. Shared by
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
    || window < MIN_TERMINAL_DEADLINE_MS
    || window > MAX_TERMINAL_DEADLINE_MS
  ) {
    throw new Error(`terminal deadline must be between ${MIN_TERMINAL_DEADLINE_MS}ms and ${MAX_TERMINAL_DEADLINE_MS}ms after receipt`);
  }
}
