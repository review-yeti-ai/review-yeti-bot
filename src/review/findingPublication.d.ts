import type { CompareClaimsOptions } from './claimSimilarity';

export type PublicationSeverity = 'P0' | 'P1' | 'P2';
export type PublicationSide = 'RIGHT' | 'LEFT';

export interface PublicationFindingInput {
  severity: PublicationSeverity | 'critical' | 'major' | 'minor' | 'nit';
  path: string;
  line: number;
  side?: PublicationSide;
  title: string;
  body: string;
  suggestion?: string;
  /** Explicit replacement code. Unlike suggestion, this is rendered as a GitHub suggestion block. */
  replacementCode?: string;
  confidence?: number;
  recommendation?: string;
  persona?: string;
  personaId?: string;
  displayName?: string;
  personas?: string[];
}

export interface PublicationFinding extends Omit<PublicationFindingInput, 'severity' | 'side' | 'personas'> {
  severity: PublicationSeverity;
  side: PublicationSide;
  personas: string[];
  /** Titles of other reports of this same claim, collapsed into this one. */
  mergedTitles?: string[];
}

export interface PublicationLane {
  id?: string;
  persona?: string;
  personaId?: string;
  displayName?: string;
  findings: PublicationFindingInput[];
}

export interface PublicationChangedFile {
  path: string;
  patch?: string | null;
  mode?: string;
  oldMode?: string;
  newMode?: string;
  old_mode?: string;
  new_mode?: string;
  isSubmodule?: boolean;
  submoduleCandidate?: boolean;
}

export interface PatchAnchors {
  right: Set<number>;
  left: Set<number>;
  hasHunks: boolean;
}

export interface PublicationComment {
  path: string;
  line?: number;
  side?: PublicationSide;
  body: string;
  markerKey: string;
  personas: string[];
  finding: PublicationFinding;
}

export interface PublicationAdvisory {
  path: string;
  line: number;
  side: PublicationSide;
  title: string;
  severity: 'P2';
  markerKey: string;
  personas: string[];
  finding: PublicationFinding;
}

export interface RejectedPublicationFinding {
  path: string;
  line?: number;
  side?: PublicationSide;
  title: string;
  severity?: PublicationSeverity;
  personas: string[];
  finding: PublicationFindingInput | Record<string, unknown>;
  reason: string;
}

export interface FindingPublicationPlan {
  lineComments: PublicationComment[];
  fileComments: PublicationComment[];
  advisories: PublicationAdvisory[];
  rejected: RejectedPublicationFinding[];
}

export function parsePatchAnchors(patch?: string | null): PatchAnchors;
export function findingDedupeKey(
  finding: Partial<PublicationFindingInput>,
  subjectType?: 'line' | 'file',
): string;
export function findingMarkerKey(
  finding: Partial<PublicationFindingInput>,
  subjectType?: 'line' | 'file',
): string;
export function formatFindingCommentBody(
  finding: Partial<PublicationFinding> & Pick<PublicationFinding, 'severity' | 'title' | 'body'>,
): string;
export interface PlanFindingPublicationOptions {
  /** Collapse differently-worded reports of one claim. Defaults to true. */
  mergeNearDuplicates?: boolean;
  nearDuplicate?: CompareClaimsOptions;
}

export function mergeNearDuplicateClaims<T extends { subjectType: 'line' | 'file'; finding: PublicationFinding }>(
  entries: T[],
  options?: CompareClaimsOptions,
): T[];

export function planFindingPublication(
  input: Array<PublicationLane | PublicationFindingInput>,
  changedFiles: PublicationChangedFile[],
  options?: PlanFindingPublicationOptions,
): FindingPublicationPlan;

/** Max resolve-required review threads one publish may open. */
export const MAX_PUBLISHED_REVIEW_THREADS: number;

/**
 * Trims a plan to `max` review threads, ranked across line and file comments together.
 * Everything past the cap moves to `overflow` for the caller to render.
 */
export function capPublicationThreads<T extends FindingPublicationPlan>(
  publicationPlan: T,
  max?: number,
): T & { overflow: PublicationComment[] };
