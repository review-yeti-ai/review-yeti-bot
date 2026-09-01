import {
  computeArbitration,
  CanonicalArbitration,
  ReviewChangedFile,
  ReviewLane,
  ArbitrationOptions,
} from './reviewCore';

export interface AppVerdictOptions extends ArbitrationOptions {
  lanes: ReviewLane[];
  expectedLanes: number;
}

/** The App's typed adapter deliberately delegates all verdict policy to reviewCore. */
export function computeAppVerdict(options: AppVerdictOptions): CanonicalArbitration {
  return computeArbitration(options.lanes, options.expectedLanes, {
    changedFiles: options.changedFiles as ReviewChangedFile[] | undefined,
    coverageComplete: options.coverageComplete,
    coverageGaps: options.coverageGaps,
    candidateVerdict: options.candidateVerdict,
    rationale: options.rationale,
  });
}
