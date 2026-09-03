import type {
  ReviewJobDispatchEngine,
  ReviewJobDispatchOutcome,
} from './reviewJobDispatchEngine';
import {
  TRUSTED_WORKER_IMAGE_REPOSITORIES,
  TRUSTED_WORKER_IMAGE_REPOSITORY,
} from './reviewJobProjection';

const workerImagePattern = new RegExp(
  `^(?:${TRUSTED_WORKER_IMAGE_REPOSITORIES.map((repo) => repo.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|')})@sha256:[a-f0-9]{64}$`,
  'u',
);
const hostnamePattern = /^[a-z0-9](?:[a-z0-9.-]{0,198}[a-z0-9])?$/u;

export interface ReviewJobDispatcherConfig {
  namespace: 'ct-review-system';
  workerImage: string;
  workerId: string;
  idleDelayMs: 1_000;
  activeDelayMs: 50;
  errorDelayMs: 5_000;
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
  const workerImage = environment.REVIEW_JOB_WORKER_IMAGE?.trim() || '';
  if (!workerImagePattern.test(workerImage)) {
    throw new Error(
      `REVIEW_JOB_WORKER_IMAGE must be a digest-pinned trusted worker image (${TRUSTED_WORKER_IMAGE_REPOSITORIES.join(', ')})`,
    );
  }
  const hostname = environment.HOSTNAME?.trim() || '';
  if (!hostnamePattern.test(hostname)) {
    throw new Error('HOSTNAME must be a valid dispatcher pod identity');
  }
  return {
    namespace: 'ct-review-system',
    workerImage,
    workerId: `review-job-dispatcher:${hostname}`,
    idleDelayMs: 1_000,
    activeDelayMs: 50,
    errorDelayMs: 5_000,
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
  onCycleError?: (outcome: { status: 'cycle-error' }) => void;
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
    } catch {
      options.onCycleError?.({ status: 'cycle-error' });
    }
    if (!options.signal.aborted) await sleep(delay, options.signal);
  }
}
