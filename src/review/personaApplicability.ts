import type { CtReviewConfigV3 } from '../config/schema';
import { matchOne } from '../pipeline/domainIndex';

type ReviewPersona = CtReviewConfigV3['personas'][number];

/**
 * Derive the exact immutable-config persona roster for a set of reviewable
 * paths. Ordering follows the prepared policy so worker and service evidence
 * share one canonical lane order.
 */
export function deriveApplicablePersonas(
  personas: readonly ReviewPersona[],
  files: ReadonlyArray<{ path: string }>,
): ReviewPersona[] {
  return personas.filter((persona) => persona.paths
    .some((pattern) => files.some((file) => matchOne(pattern, file.path))));
}

export function deriveApplicablePersonaIds(
  personas: readonly ReviewPersona[],
  files: ReadonlyArray<{ path: string }>,
): string[] {
  return deriveApplicablePersonas(personas, files).map((persona) => persona.id);
}
