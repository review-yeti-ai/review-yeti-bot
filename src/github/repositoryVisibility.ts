import { normalizeRepositoryVisibility, type RepositoryVisibility } from '../review/repositoryVisibility';
export { normalizeRepositoryVisibility, repositoryVisibilityFrom, REPOSITORY_VISIBILITY_INSTRUCTION } from '../review/repositoryVisibility';
export type { RepositoryVisibility } from '../review/repositoryVisibility';

/**
 * Resolves the visibility a review run will be told. The webhook payload usually
 * carries it; the lookup is only a fallback for a run mode whose payload did not.
 * A lookup failure must never fail or block the review it was requested for, so
 * this settles to UNKNOWN on any error rather than throwing.
 */
export async function resolveRepositoryVisibility(
  fromPayload: RepositoryVisibility | undefined,
  deps: {
    lookup: () => Promise<RepositoryVisibility>;
    warn?: (message: string, meta: Record<string, unknown>) => void;
  },
): Promise<RepositoryVisibility> {
  if (fromPayload && fromPayload !== 'UNKNOWN') return fromPayload;
  try {
    return normalizeRepositoryVisibility(await deps.lookup());
  } catch (error: any) {
    deps.warn?.('Repository visibility fallback lookup threw unexpectedly; continuing as UNKNOWN', {
      error: error?.message || error,
    });
    return 'UNKNOWN';
  }
}
