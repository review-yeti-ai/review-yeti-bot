import type {
  ReviewCompletionDeliveryEngine,
  ReviewCompletionDeliveryOutcome,
  CIRequestClientFactory,
} from './reviewCompletionDeliveryEngine';
import { getGitHubAppRepositoryDispatchToken } from '../github/appAuth';
import { GitHubInstallationClient } from '../github/installationClient';

export interface ReviewCompletionDeliveryLoopOptions {
  signal: AbortSignal;
  idleDelayMs: number;
  activeDelayMs: number;
  errorDelayMs: number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  onOutcome?: (outcome: ReviewCompletionDeliveryOutcome) => void;
  onCycleError?: (outcome: { status: 'cycle-error'; error: unknown }) => void;
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

export async function runReviewCompletionDeliveryLoop(
  engine: Pick<ReviewCompletionDeliveryEngine, 'runOnce'>,
  options: ReviewCompletionDeliveryLoopOptions,
): Promise<void> {
  const sleep = options.sleep || abortableSleep;
  while (!options.signal.aborted) {
    let delay = options.errorDelayMs;
    try {
      const outcome = await engine.runOnce();
      options.onOutcome?.(outcome);
      delay = outcome.status === 'idle' ? options.idleDelayMs : options.activeDelayMs;
    } catch (err: unknown) {
      options.onCycleError?.({ status: 'cycle-error', error: err });
    }
    if (!options.signal.aborted) await sleep(delay, options.signal);
  }
}

export function createGitHubAppCIRequestClientFactory(
  appId: string,
  privateKey: string,
): CIRequestClientFactory {
  return async (owner: string, repo: string) => {
    const tokenResult = await getGitHubAppRepositoryDispatchToken({
      appId,
      privateKey,
      repo,
      owner,
    });
    return new GitHubInstallationClient({ token: tokenResult.token });
  };
}
