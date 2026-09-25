/**
 * The changed-file and effective-file shapes of the shared applicability
 * decision. A leaf module, so `personaApplicability` and the modules it calls
 * (`newPackageLockfileReview`, REL-1136) share one definition without an
 * import cycle. `personaApplicability` re-exports both.
 */
export interface ReviewApplicabilityInputFile {
  path: string;
  patch?: string;
  content?: string;
  mode?: string;
  isSubmodule?: boolean;
  submoduleCandidate?: boolean;
  size?: number;
  byteSize?: number;
}

export interface EffectiveReviewFile extends ReviewApplicabilityInputFile {
  originalPatchLength: number;
}
