import { IDiffStateStorage, PRDiffState, TrackedFinding, TrackedHunk, FindingStatus } from './db';
import { computeHunkHash, computeFindingHash, HunkInput, FindingInput } from '../utils/diffHash';
import { logger } from '../utils/logger';

export interface IncomingHunkInput {
  filePath: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  hunkContent: string;
}

export interface IncomingFindingInput {
  filePath: string;
  startLine: number;
  endLine: number;
  persona: string;
  severity: 'critical' | 'major' | 'minor' | 'nit';
  comment: string;
  ruleId?: string;
  codeSnippet: string;
}

export interface ProcessPRUpdateInput {
  repoOwner: string;
  repoName: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  hunks: IncomingHunkInput[];
  quorumFindings?: IncomingFindingInput[];
}

export interface ProcessPRUpdateResult {
  previousState: PRDiffState | null;
  currentState: PRDiffState;
  hunksToReview: IncomingHunkInput[];
  activeFindings: TrackedFinding[];
  resolvedFindings: TrackedFinding[];
  suppressedFindingHashes: string[];
}

export class DiffStateManager {
  private storage: IDiffStateStorage;

  constructor(storage: IDiffStateStorage) {
    this.storage = storage;
  }

  public async processPRCommitUpdate(input: ProcessPRUpdateInput): Promise<ProcessPRUpdateResult> {
    const { repoOwner, repoName, prNumber, headSha, baseSha, hunks, quorumFindings = [] } = input;
    const now = new Date().toISOString();

    const previousState = await this.storage.getPRState(repoOwner, repoName, prNumber);

    // Compute hunk hashes for incoming hunks
    const incomingTrackedHunks: TrackedHunk[] = hunks.map(h => ({
      filePath: h.filePath,
      hunkHash: computeHunkHash(h),
      oldStart: h.oldStart,
      oldLines: h.oldLines,
      newStart: h.newStart,
      newLines: h.newLines,
      commitSha: headSha,
      createdAt: now,
    }));

    const previousHunkHashes = new Set(previousState?.hunks.map(h => h.hunkHash) || []);
    
    // Determine which hunks actually require review (new or modified hunks)
    const hunksToReview = hunks.filter(h => {
      const hash = computeHunkHash(h);
      return !previousHunkHashes.has(hash);
    });

    const existingFindingsMap = new Map<string, TrackedFinding>();
    if (previousState) {
      for (const f of previousState.findings) {
        existingFindingsMap.set(f.fingerprintHash, { ...f });
      }
    }

    const incomingFindingsMap = new Map<string, IncomingFindingInput>();
    const incomingFindingHashes: string[] = [];

    for (const f of quorumFindings) {
      const hash = computeFindingHash({
        filePath: f.filePath,
        persona: f.persona,
        severity: f.severity,
        codeSnippet: f.codeSnippet,
        comment: f.comment,
        ruleId: f.ruleId,
        startLine: f.startLine,
        endLine: f.endLine,
      });
      incomingFindingsMap.set(hash, f);
      incomingFindingHashes.push(hash);
    }

    const updatedFindingsMap = new Map<string, TrackedFinding>();
    const suppressedHashesSet = new Set<string>();

    // 1. Process incoming findings from current review pass
    for (const hash of incomingFindingHashes) {
      const incoming = incomingFindingsMap.get(hash)!;
      const existing = existingFindingsMap.get(hash);

      if (existing) {
        if (existing.status === 'RESOLVED') {
          if (incoming.severity === 'critical') {
            // Re-open critical finding
            updatedFindingsMap.set(hash, {
              ...existing,
              status: 'IDENTIFIED',
              lastSeenCommit: headSha,
              resolvedAtCommit: null,
              updatedAt: now,
            });
          } else {
            // Suppress duplicate resolved finding
            suppressedHashesSet.add(hash);
            updatedFindingsMap.set(hash, {
              ...existing,
              status: 'SUPPRESSED',
              lastSeenCommit: headSha,
              updatedAt: now,
            });
          }
        } else {
          // Previously identified, still active
          updatedFindingsMap.set(hash, {
            ...existing,
            lastSeenCommit: headSha,
            startLine: incoming.startLine,
            endLine: incoming.endLine,
            updatedAt: now,
          });
        }
      } else {
        // Brand new finding
        updatedFindingsMap.set(hash, {
          fingerprintHash: hash,
          filePath: incoming.filePath,
          startLine: incoming.startLine,
          endLine: incoming.endLine,
          persona: incoming.persona,
          severity: incoming.severity,
          comment: incoming.comment,
          status: 'IDENTIFIED',
          firstSeenCommit: headSha,
          lastSeenCommit: headSha,
          resolvedAtCommit: null,
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    // 2. Process findings from previous state that were not in incoming findings
    if (previousState) {
      for (const [hash, prevFinding] of existingFindingsMap.entries()) {
        if (updatedFindingsMap.has(hash)) continue;

        const fStart = prevFinding.startLine;
        const fEnd = prevFinding.endLine ?? prevFinding.startLine;

        // Check if any modified hunk line range overlaps with the previous finding's pre-shift line range
        const isFindingInModifiedHunk = hunks.some(h => {
          if (h.filePath !== prevFinding.filePath) return false;

          const oldStart = h.oldStart;
          const oldEnd = h.oldLines > 0 ? h.oldStart + h.oldLines - 1 : h.oldStart;

          if (h.oldLines > 0) {
            return oldStart <= fEnd && oldEnd >= fStart;
          }
          // Pure insertion at oldStart: modified only if finding line was exactly at insertion point
          return fStart === oldStart && fEnd === oldStart;
        });

        if (prevFinding.status === 'IDENTIFIED') {
          if (isFindingInModifiedHunk) {
            // Finding was in a modified hunk line range, but is no longer detected -> RESOLVED
            updatedFindingsMap.set(hash, {
              ...prevFinding,
              status: 'RESOLVED',
              resolvedAtCommit: headSha,
              updatedAt: now,
            });
          } else {
            // Untouched finding in unmodified section of a file remains identified.
            // Calculate line shift delta from hunks inserted/deleted above this finding.
            let lineShift = 0;
            for (const h of hunks) {
              if (h.filePath === prevFinding.filePath && h.oldStart <= prevFinding.startLine) {
                lineShift += (h.newLines - h.oldLines);
              }
            }
            updatedFindingsMap.set(hash, {
              ...prevFinding,
              startLine: Math.max(1, prevFinding.startLine + lineShift),
              endLine: Math.max(1, (prevFinding.endLine ?? prevFinding.startLine) + lineShift),
            });
          }
        } else {
          // Carry over resolved/suppressed as-is
          updatedFindingsMap.set(hash, {
            ...prevFinding,
          });
        }
      }
    }

    const finalFindings = Array.from(updatedFindingsMap.values());
    const currentState: PRDiffState = {
      id: previousState?.id,
      repoOwner,
      repoName,
      prNumber,
      headSha,
      baseSha,
      updatedAt: now,
      hunks: incomingTrackedHunks,
      findings: finalFindings,
    };

    await this.storage.savePRState(currentState);

    const activeFindings = finalFindings.filter(f => f.status === 'IDENTIFIED');
    const resolvedFindings = finalFindings.filter(f => f.status === 'RESOLVED');

    logger.info('Processed PR commit update', {
      prNumber,
      headSha,
      hunksToReviewCount: hunksToReview.length,
      activeFindingsCount: activeFindings.length,
      resolvedFindingsCount: resolvedFindings.length,
      suppressedCount: suppressedHashesSet.size,
    });

    return {
      previousState,
      currentState,
      hunksToReview,
      activeFindings,
      resolvedFindings,
      suppressedFindingHashes: Array.from(suppressedHashesSet),
    };
  }
}
