/**
 * REL-1139 (ct-meta ADR 0687): the panel side of the empty-moderation skip. The decision itself
 * lives in `src/review/emptyModeration.ts`, shared with the trusted completion side; this module
 * only reduces the panel engine's plans and disclosures to that decision's facts, and builds the
 * deterministic moderator result a skipped run uses.
 *
 * Only the moderator is ever skipped. The arbiter still runs on the empty ledger, and lanes are
 * never skipped or reduced.
 */
import type { ProviderId } from '../config/schema';
import type { MapReducePlan } from '../review/mapReduceReview';
import type { ReviewDepthDisclosure } from '../review/personaApplicability';
import type { ReviewBudgetPlan } from '../review/reviewBudget';
import type { DiffShrinkDisclosure } from '../types/diffShrink';
import type { IncrementalReviewDisclosure } from '../types/incrementalReview';
import type { VerdictCacheDisclosure } from '../types/verdictCache';
import { EMPTY_MODERATION_SKIPPED_MODEL, type EmptyModerationFacts } from '../review/emptyModeration';
import type { PanelResult, PersonaLaneResult } from './types';

export {
  EMPTY_MODERATION_SKIPPED,
  EMPTY_MODERATION_SKIP_REASON,
  SKIP_EMPTY_MODERATION_FLAG,
  decideEmptyModeration,
  skipEmptyModerationEnabledFor,
} from '../review/emptyModeration';

/** W2/W5/W6 entries that sent a lane less than the whole file. Any one makes the run ineligible. */
export function reducedDepthEntriesOf(input: {
  diffShrink?: Pick<DiffShrinkDisclosure, 'whitespaceOnlyFiles' | 'collapsedWhitespaceHunks' | 'renames' | 'linguistExcluded'> | null;
  reviewBudget?: Pick<ReviewBudgetPlan, 'packs' | 'fallbacks'> | null;
  mapReduce?: Pick<MapReducePlan, 'lanes' | 'notApplied'> | null;
}): number {
  let count = 0;
  const shrink = input.diffShrink;
  if (shrink) {
    count += (shrink.whitespaceOnlyFiles?.length ?? 0) + (shrink.collapsedWhitespaceHunks?.length ?? 0)
      + (shrink.renames?.length ?? 0) + (shrink.linguistExcluded?.length ?? 0);
  }
  const budget = input.reviewBudget;
  if (budget) {
    for (const pack of budget.packs.values()) {
      if (pack.disclosure?.fallback) count += 1;
      for (const file of pack.disclosure?.files ?? []) {
        if (file.depth !== 'full') count += 1;
      }
    }
    count += budget.fallbacks?.size ?? 0;
  }
  if (input.mapReduce) count += input.mapReduce.lanes.size + (input.mapReduce.notApplied?.length ?? 0);
  return count;
}

/** The panel run's facts for the shared decision. Absent plans contribute 0. */
export function panelEmptyModerationFacts(input: {
  applicableLaneIds: readonly string[];
  lanes: readonly PersonaLaneResult[];
  failedLaneCount: number;
  quorumSatisfied: boolean;
  unreadableHeaders: number;
  changedPaths: readonly string[];
  depth?: ReviewDepthDisclosure | null;
  routedFiles?: readonly unknown[] | null;
  uncoveredPaths?: readonly unknown[] | null;
  diffShrink?: DiffShrinkDisclosure | null;
  reviewBudget?: Pick<ReviewBudgetPlan, 'packs' | 'fallbacks'> | null;
  mapReduce?: Pick<MapReducePlan, 'lanes' | 'notApplied'> | null;
  incremental?: Pick<IncrementalReviewDisclosure, 'carriedForwardPaths'> | null;
  verdictCache?: Pick<VerdictCacheDisclosure, 'cached'> | null;
  analyzerHypotheses: number;
}): EmptyModerationFacts {
  const depth = input.depth;
  return {
    expectedLaneIds: input.applicableLaneIds,
    lanes: input.lanes.map((lane) => ({
      id: lane.id,
      decision: lane.decision,
      findings: lane.findings,
      ...(lane.notApplicable ? { notApplicable: true } : {}),
    })),
    failedLaneCount: input.failedLaneCount,
    coverageComplete: input.quorumSatisfied === true && input.unreadableHeaders === 0,
    changedPaths: input.changedPaths,
    truncatedFiles: depth?.truncatedFiles?.length ?? 0,
    unavailablePatches: depth?.unavailablePatches?.length ?? 0,
    omittedSourcePaths: depth?.omittedSourcePaths?.length ?? 0,
    routedFiles: input.routedFiles?.length ?? 0,
    uncoveredPaths: input.uncoveredPaths?.length ?? 0,
    reducedDepthEntries: reducedDepthEntriesOf(input),
    incrementalCarriedFiles: input.incremental?.carriedForwardPaths?.length ?? 0,
    verdictCacheServedFiles: input.verdictCache?.cached?.length ?? 0,
    analyzerHypotheses: input.analyzerHypotheses,
  };
}

/** Zero-cost moderator result for a skipped run: RECONCILED with an empty ledger. */
export function skippedModeratorResult(providerId: ProviderId): PanelResult['moderator'] {
  return {
    providerId,
    model: EMPTY_MODERATION_SKIPPED_MODEL,
    decision: 'RECONCILED',
    findings: [],
    usage: null,
    costUSD: 0,
    durationMs: 0,
  };
}
