/**
 * Repository visibility as a tri-state value with one normalisation rule.
 *
 * Homed in the review domain, not in any adapter: the GitHub layer produces it,
 * the panel consumes it, the publishing lane prints it, and none of them should
 * have to import another layer to name the type.
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
 * Reads visibility from any record carrying GitHub's `visibility` string and/or
 * `private` boolean. The string is preferred when it is a value we recognise;
 * an unrecognised string must NOT short-circuit a definite `private` boolean --
 * `{ private: true, visibility: '<new-github-value>' }` is PRIVATE, not UNKNOWN,
 * and that distinction changes how a persona is told to rate internal material.
 */
export function repositoryVisibilityFrom(record: unknown): RepositoryVisibility {
  if (!record || typeof record !== 'object') return 'UNKNOWN';
  const { visibility, private: isPrivate } = record as { visibility?: unknown; private?: unknown };
  if (typeof visibility === 'string') {
    const fromString = normalizeRepositoryVisibility(visibility);
    if (fromString !== 'UNKNOWN') return fromString;
  }
  if (typeof isPrivate === 'boolean') return normalizeRepositoryVisibility(isPrivate);
  return 'UNKNOWN';
}
