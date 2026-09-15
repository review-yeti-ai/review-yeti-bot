export interface IncompletePanelEvidence {
  authoritative: boolean;
  unreadableDiffCount: number;
  mode: string;
  rosterValid: boolean;
  failedLaneCount: number;
  quorumSatisfied: boolean;
  rawFindingCount: number;
  canonicalFindingCount: number;
}

/**
 * Classify execution evidence, never approve code or authorize a retry.
 * The publisher still owns the exact-check failure callback and error class.
 */
export function isRecoverableIncompletePanel(evidence: IncompletePanelEvidence): boolean {
  return evidence.authoritative === false
    && evidence.unreadableDiffCount === 0
    && evidence.mode === 'panel'
    && evidence.rosterValid === true
    && Number.isSafeInteger(evidence.failedLaneCount) && evidence.failedLaneCount > 0
    && evidence.quorumSatisfied === false
    && evidence.rawFindingCount === 0
    && evidence.canonicalFindingCount === 0;
}
