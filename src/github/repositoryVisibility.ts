/**
 * Repository visibility as a tri-state value with one normalisation rule.
 *
 * Homed in the GitHub adapter layer because that is where it originates (the
 * webhook payload and the repositories API) and because every consumer -- the
 * event handler, the installation client, the publishing lane and the panel --
 * should be able to name the type without depending on the panel engine.
 */
export type RepositoryVisibility = 'PRIVATE' | 'PUBLIC' | 'UNKNOWN';

/**
 * ct-meta#2884 (2026-09-08): the reviewer blocked a PR that archived internal
 * planning material (cluster IPs, registry digest pins, secret variable NAMES,
 * no secret values) into a PRIVATE repository, with four P1s of the shape "if
 * this repository is public, this is reconnaissance-grade disclosure". The
 * repository's visibility was never part of the persona's input -- it is not
 * carried in the diff or the charter -- so the model hedged toward the unsafe
 * assumption and blocked a PR whose entire point was moving material OUT of a
 * public repo and into this private one. This is a missing input, not a model
 * error: visibility must be told to the persona, not guessed.
 */
export const REPOSITORY_VISIBILITY_INSTRUCTION =
  'In a PRIVATE repository, internal hostnames, IP addresses, registry paths, image digests, private repository names and secret variable NAMES are not a disclosure and must not be rated P0/P1 on that basis; only a literal credential VALUE is. In a PUBLIC repository the same material IS a disclosure. If visibility is UNKNOWN, report the concern as P2 and say visibility could not be determined.';

/** Normalizes a webhook `repository.private` boolean or a `visibility` string into the tri-state contract. Never throws. */
export function normalizeRepositoryVisibility(value: unknown): RepositoryVisibility {
  if (value === true) return 'PRIVATE';
  if (value === false) return 'PUBLIC';
  if (typeof value === 'string') {
    const normalized = value.trim().toUpperCase();
    if (normalized === 'PRIVATE' || normalized === 'INTERNAL') return 'PRIVATE';
    if (normalized === 'PUBLIC') return 'PUBLIC';
  }
  return 'UNKNOWN';
}

/** Single source of truth for the visibility fact threaded into every persona and moderator prompt; kept as one exported function so a rewording is testable. */

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
