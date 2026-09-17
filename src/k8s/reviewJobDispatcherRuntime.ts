import type {
  ReviewJobDispatchEngine,
  ReviewJobDispatchOutcome,
} from './reviewJobDispatchEngine';
import {
  DEFAULT_GENERIC_RUNNER_IMAGE,
  GENERIC_RUNNER_IMAGE_PATTERN,
  type RunnerMode,
  TRUSTED_WORKER_IMAGE_REPOSITORIES,
  TRUSTED_WORKER_IMAGE_REPOSITORY,
} from './reviewJobProjection';

const workerImagePattern = new RegExp(
  `^(?:${TRUSTED_WORKER_IMAGE_REPOSITORIES.map((repo) => repo.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|')})@sha256:[a-f0-9]{64}$`,
  'u',
);
const hostnamePattern = /^[a-z0-9](?:[a-z0-9.-]{0,198}[a-z0-9])?$/u;

/**
 * REL-896 defaults for the two env vars below: the reaper limit default
 * matches the pre-REL-896 hardcoded reaper claim size (1; see the comment on
 * `AbandonedRunReaper` construction in `reviewJobDispatcherIndex.ts` for why),
 * and the poll default matches `DEFAULT_DELEGATED_FAILURE_POLL_MS` /
 * `MIN_DELEGATED_FAILURE_POLL_MS` in `./delegatedFailureReader.ts`. These are
 * literals inside `reviewJobDispatcherConfigFromEnv` below, not named
 * constants it references: `tests/unit/reviewRuntimeUpgrade.test.ts` extracts
 * that function's exact source text into an isolated VM sandbox with no
 * module resolver, and an external identifier there fails closed with "is
 * not defined" rather than silently drifting. `reviewJobDispatcherRuntime.test.ts`
 * pins the resulting behavior (1 / 1 / 100 and 15000 / 5000).
 */
export interface ReviewJobDispatcherConfig {
  namespace: 'ct-review-system';
  workerImage: string;
  workerId: string;
  runnerMode: RunnerMode;
  idleDelayMs: 1_000;
  activeDelayMs: 50;
  errorDelayMs: 5_000;
  /** REL-896: number of abandoned publishing runs claimed per reaper cycle.
   * Clamped to [MIN_ABANDONED_REAPER_LIMIT, MAX_ABANDONED_REAPER_LIMIT];
   * an invalid or absent REVIEW_ABANDONED_REAPER_LIMIT falls back to
   * DEFAULT_ABANDONED_REAPER_LIMIT rather than failing startup, since this
   * only bounds sweep throughput and never changes claim safety. */
  abandonedReaperLimit: number;
  /** REL-896: minimum milliseconds between PRReviewJob list polls for the
   * operator's delegated-failure signal. See
   * `../k8s/delegatedFailureReader.ts` for the floor and default. */
  delegatedFailurePollMs: number;
}

export function reviewJobDispatcherConfigFromEnv(
  environment: Record<string, string | undefined>,
): ReviewJobDispatcherConfig {
  if (environment.REVIEW_JOB_DISPATCH_ENABLED !== 'true') {
    throw new Error('REVIEW_JOB_DISPATCH_ENABLED must be true for the dedicated queue consumer');
  }
  if (environment.REVIEW_JOB_NAMESPACE !== 'ct-review-system') {
    throw new Error('REVIEW_JOB_NAMESPACE must remain ct-review-system during qualification');
  }
  const runnerModeRaw = environment.REVIEW_JOB_RUNNER_MODE?.trim() || environment.RUNNER_MODE?.trim() || 'prebaked';
  if (runnerModeRaw !== 'prebaked' && runnerModeRaw !== 'generic') {
    throw new Error('REVIEW_JOB_RUNNER_MODE must be prebaked or generic');
  }
  const runnerMode = runnerModeRaw as RunnerMode;
  let workerImage = environment.REVIEW_JOB_WORKER_IMAGE?.trim() || '';
  if (runnerMode === 'generic') {
    if (!workerImage) {
      workerImage = DEFAULT_GENERIC_RUNNER_IMAGE;
    } else if (!GENERIC_RUNNER_IMAGE_PATTERN.test(workerImage) && !workerImagePattern.test(workerImage)) {
      throw new Error(
        `REVIEW_JOB_WORKER_IMAGE must be a valid generic runner image (${DEFAULT_GENERIC_RUNNER_IMAGE}) or trusted worker image in generic mode`,
      );
    }
  } else {
    if (!workerImagePattern.test(workerImage)) {
      throw new Error(
        `REVIEW_JOB_WORKER_IMAGE must be a digest-pinned trusted worker image (${TRUSTED_WORKER_IMAGE_REPOSITORIES.join(', ')})`,
      );
    }
  }
  const hostname = environment.HOSTNAME?.trim() || '';
  if (!hostnamePattern.test(hostname)) {
    throw new Error('HOSTNAME must be a valid dispatcher pod identity');
  }
  // Inlined rather than a shared helper: this function's exact source text is
  // extracted and re-run in an isolated VM sandbox by
  // tests/unit/reviewRuntimeUpgrade.test.ts, which has no module resolver.
  // An invalid or absent value falls back to the default rather than failing
  // startup -- both env vars only bound sweep throughput/poll cost, never
  // claim safety.
  const boundedIntEnv = (raw: string | undefined, fallback: number, min: number, max: number): number => {
    if (raw === undefined || raw.trim() === '') return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) return fallback;
    return value;
  };
  const abandonedReaperLimit = boundedIntEnv(environment.REVIEW_ABANDONED_REAPER_LIMIT, 1, 1, 100);
  const delegatedFailurePollMs = boundedIntEnv(
    environment.REVIEW_DELEGATED_FAILURE_POLL_MS, 15_000, 5_000, Number.MAX_SAFE_INTEGER,
  );
  return {
    namespace: 'ct-review-system',
    workerImage,
    workerId: `review-job-dispatcher:${hostname}`,
    runnerMode,
    idleDelayMs: 1_000,
    activeDelayMs: 50,
    errorDelayMs: 5_000,
    abandonedReaperLimit,
    delegatedFailurePollMs,
  };
}

type DispatcherEngine = Pick<ReviewJobDispatchEngine, 'runOnce'>;

export interface ReviewJobDispatcherLoopOptions {
  signal: AbortSignal;
  idleDelayMs: number;
  activeDelayMs: number;
  errorDelayMs: number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  onOutcome?: (outcome: ReviewJobDispatchOutcome) => void;
  onCycleError?: (outcome: { status: 'cycle-error'; errorCode?: string }) => void;
}

function safeErrorCode(error: unknown): string | undefined {
  try {
    if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' && /^[A-Z0-9_-]{1,32}$/u.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

async function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    signal.addEventListener('abort', finish, { once: true });
  });
}

export async function runReviewJobDispatcherLoop(
  engine: DispatcherEngine,
  options: ReviewJobDispatcherLoopOptions,
): Promise<void> {
  const sleep = options.sleep || abortableSleep;
  while (!options.signal.aborted) {
    let delay = options.errorDelayMs;
    try {
      const outcome = await engine.runOnce();
      options.onOutcome?.(outcome);
      delay = outcome.status === 'idle' ? options.idleDelayMs : options.activeDelayMs;
    } catch (error: unknown) {
      const errorCode = safeErrorCode(error);
      options.onCycleError?.(errorCode ? { status: 'cycle-error', errorCode } : { status: 'cycle-error' });
    }
    if (!options.signal.aborted) await sleep(delay, options.signal);
  }
}
