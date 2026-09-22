import type { CtReviewConfigV3 } from '../config/schema';
import { matchOne } from '../pipeline/domainIndex';

type ReviewPersona = CtReviewConfigV3['personas'][number];

export function isSubmoduleEntry(file: unknown): boolean {
  if (!file || typeof file !== 'object') return false;
  const f = file as {
    isSubmodule?: boolean;
    submoduleCandidate?: boolean;
    mode?: string;
    oldMode?: string;
    newMode?: string;
    old_mode?: string;
    new_mode?: string;
  };
  return Boolean(
    f.isSubmodule === true ||
    f.submoduleCandidate === true ||
    f.mode === '160000' ||
    f.oldMode === '160000' ||
    f.newMode === '160000' ||
    f.old_mode === '160000' ||
    f.new_mode === '160000'
  );
}

export function isArchitecturePersona(persona: unknown): boolean {
  if (!persona || typeof persona !== 'object') return false;
  const p = persona as { id?: string; charter?: string; name?: string };
  return Boolean(
    p.id === 'architecture' ||
    p.id === 'arch-lane' ||
    p.charter === 'builtin:architecture' ||
    (typeof p.name === 'string' && p.name.toLowerCase().includes('architecture'))
  );
}

/**
 * Derive the exact immutable-config persona roster for a set of reviewable
 * paths. Ordering follows the prepared policy so worker and service evidence
 * share one canonical lane order.
 */
export function deriveApplicablePersonas(
  personas: readonly ReviewPersona[],
  files: ReadonlyArray<{ path: string; mode?: string; isSubmodule?: boolean; submoduleCandidate?: boolean }>,
): ReviewPersona[] {
  return personas.filter((persona) => {
    const coversSubmodule = isArchitecturePersona(persona) && files.some(isSubmoduleEntry);
    return coversSubmodule || persona.paths
      .some((pattern) => files.some((file) => matchOne(pattern, file.path)));
  });
}

export function deriveApplicablePersonaIds(
  personas: readonly ReviewPersona[],
  files: ReadonlyArray<{ path: string; mode?: string; isSubmodule?: boolean; submoduleCandidate?: boolean }>,
): string[] {
  return deriveApplicablePersonas(personas, files).map((persona) => persona.id);
}

