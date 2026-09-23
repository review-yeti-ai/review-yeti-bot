import type { CtReviewConfigV3 } from '../config/schema';
import { matchOne } from '../pipeline/domainIndex';
import { isDocumentationOrAssetPath } from './reviewableContent';

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
  const p = persona as { id?: string; charter?: string; coversSubmodules?: boolean };
  return Boolean(
    p.coversSubmodules === true ||
    p.id === 'architecture' ||
    p.id === 'arch-lane' ||
    p.charter === 'builtin:architecture'
  );
}

/**
 * Test whether a review persona covers a given file, either by matching one of
 * its configured glob patterns or because the file is a git submodule entry and
 * the persona is an architecture lane.
 */
export function personaCoversFile(
  persona: { paths: readonly string[]; id?: string; charter?: string; coversSubmodules?: boolean },
  file: { path: string; mode?: string; isSubmodule?: boolean; submoduleCandidate?: boolean } | null | undefined,
): boolean {
  if (!file) return false;
  if (isArchitecturePersona(persona) && isSubmoduleEntry(file)) {
    return true;
  }
  return persona.paths.some((pattern) => pattern === '**' || matchOne(pattern, file.path));
}

/**
 * Filter a set of changed files to only those covered by the given persona.
 */
export function scopeFilesForPersona<T extends { path: string; mode?: string; isSubmodule?: boolean; submoduleCandidate?: boolean }>(
  persona: Parameters<typeof personaCoversFile>[0],
  files: readonly T[],
): T[] {
  return files.filter((file) => personaCoversFile(persona, file));
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
  return personas.filter((persona) => files.some((file) => personaCoversFile(persona, file)));
}

export function deriveApplicablePersonaIds(
  personas: readonly ReviewPersona[],
  files: ReadonlyArray<{ path: string; mode?: string; isSubmodule?: boolean; submoduleCandidate?: boolean }>,
): string[] {
  return deriveApplicablePersonas(personas, files).map((persona) => persona.id);
}

/**
 * Computes non-code or uncovered paths that matched no applicable persona in the active roster.
 * A file is considered unmatched only when no applicable persona covers it via personaCoversFile.
 */
export function computeUnmatchedPaths(
  files: ReadonlyArray<{ path?: string; filePath?: string; mode?: string; isSubmodule?: boolean; submoduleCandidate?: boolean }>,
  applicablePersonas: ReadonlyArray<Parameters<typeof personaCoversFile>[0]>,
): string[] {
  return files
    .filter((f) => {
      const fileObj = {
        path: f.path || f.filePath || '',
        mode: f.mode,
        isSubmodule: f.isSubmodule,
        submoduleCandidate: f.submoduleCandidate,
      };
      return !applicablePersonas.some((persona) => personaCoversFile(persona, fileObj));
    })
    .map((f) => f.path || f.filePath || '')
    .filter((p) => p.length > 0)
    .filter((p) => !isDocumentationOrAssetPath(p));
}



