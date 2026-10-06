import { classifyGitHubTransient } from './githubRetry';

export type TransientAuthoritativeReadKind = 'network' | 'deadline' | 'retryable_server' | 'rate_limit';

/** A source-read failure safe to treat as unavailable without asserting current authority. */
export class TransientAuthoritativeReadError extends Error {
  readonly name = 'TransientAuthoritativeReadError';

  constructor(readonly kind: TransientAuthoritativeReadKind) {
    super('Authoritative source read is temporarily unavailable');
  }
}

/** The service-owned GitHub App credential/permission is unavailable. This is
 * distinct from caller authorization and is handled fail-open only by the
 * explicitly enrolled operator-pause path. */
export class InternalGitHubDependencyUnavailableError extends Error {
  readonly name = 'InternalGitHubDependencyUnavailableError';

  constructor() {
    super('Internal GitHub authority dependency is unavailable');
  }
}

/** A non-rate-limited authentication/permission response from an internal
 * GitHub App boundary. Preserve rate-limit semantics before classifying bare
 * 401/403 outcomes. Call only at the bounded internal transport boundary. */
export function internalGitHubDependencyUnavailableForStatus(status: number, headers: Headers):
  InternalGitHubDependencyUnavailableError | undefined {
  if (status !== 401 && status !== 403) return undefined;
  if (classifyGitHubTransient(status, headers)?.kind === 'rate_limit') return undefined;
  return new InternalGitHubDependencyUnavailableError();
}

/** Only explicit source-dependency read failures may take the pause fallback. */
export function isPausedAuthorityReadUnavailable(error: unknown):
  error is TransientAuthoritativeReadError | InternalGitHubDependencyUnavailableError {
  return error instanceof TransientAuthoritativeReadError
    || error instanceof InternalGitHubDependencyUnavailableError;
}

/** Classify only an HTTP status observed at a GitHub read transport boundary. */
export function transientAuthoritativeReadForStatus(status: number, headers: Headers):
  TransientAuthoritativeReadError | undefined {
  if (status >= 500 && status <= 599) return new TransientAuthoritativeReadError('retryable_server');
  const transient = classifyGitHubTransient(status, headers);
  if (transient?.kind === 'rate_limit') return new TransientAuthoritativeReadError('rate_limit');
  return undefined;
}
