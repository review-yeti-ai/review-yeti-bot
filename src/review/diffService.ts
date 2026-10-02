import { LiveStreamBus } from '../live/liveStreamBus';
import { dashboardStore } from '../persistence/dashboardStore';
import { postgresStore } from '../persistence/postgresStore';
import type { PRSnapshot, PRSnapshotFile } from './prSnapshot';
import type { DiffHunk, ChangedFileDiff, ReviewDiffResponse } from '../types/diff';

export type { DiffHunk, ChangedFileDiff, ReviewDiffResponse };

/**
 * Deterministically parse a unified git patch string into structured hunks and additions/deletions counts.
 */
export function parsePatchHunks(patch?: string | null): { hunks: DiffHunk[]; additions: number; deletions: number } {
  if (!patch || typeof patch !== 'string') {
    return { hunks: [], additions: 0, deletions: 0 };
  }

  const rawLines = patch.split(/\r\n|\r|\n/);
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') {
    rawLines.pop();
  }

  const hunks: DiffHunk[] = [];
  let currentHunk: DiffHunk | null = null;
  let additions = 0;
  let deletions = 0;

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (line.charCodeAt(0) === 64 /* @ */ && line.startsWith('@@ -')) {
      const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
      if (match) {
        const oldStart = parseInt(match[1], 10);
        const oldLines = match[2] !== undefined ? parseInt(match[2], 10) : (oldStart === 0 ? 0 : 1);
        const newStart = parseInt(match[3], 10);
        const newLines = match[4] !== undefined ? parseInt(match[4], 10) : (newStart === 0 ? 0 : 1);

        currentHunk = {
          header: line,
          oldStart,
          oldLines,
          newStart,
          newLines,
          lines: [],
        };
        hunks.push(currentHunk);
        continue;
      }
    }

    if (currentHunk) {
      currentHunk.lines.push(line);
      const firstChar = line.charCodeAt(0);
      if (firstChar === 43 /* + */) {
        if (!line.startsWith('+++')) {
          additions++;
        }
      } else if (firstChar === 45 /* - */) {
        if (!line.startsWith('---')) {
          deletions++;
        }
      }
    }
  }

  return { hunks, additions, deletions };
}

/**
 * Normalize file status to 'added' | 'modified' | 'deleted'.
 */
export function normalizeFileStatus(
  file: PRSnapshotFile | { status?: string },
  hunks: DiffHunk[],
): 'added' | 'modified' | 'deleted' {
  const rawStatus = (file.status || '').toLowerCase();
  if (rawStatus === 'added' || rawStatus === 'new') return 'added';
  if (rawStatus === 'deleted' || rawStatus === 'removed') return 'deleted';
  if (rawStatus === 'modified' || rawStatus === 'renamed' || rawStatus === 'copied') return 'modified';

  if (hunks.length > 0) {
    if (hunks[0].oldStart === 0 && hunks[0].oldLines === 0) return 'added';
    if (hunks[0].newStart === 0 && hunks[0].newLines === 0) return 'deleted';
  }
  return 'modified';
}

/**
 * Parse a PRSnapshot into a ReviewDiffResponse.
 */
export function parseSnapshotDiff(jobId: string, snapshot: PRSnapshot): ReviewDiffResponse {
  const files: ChangedFileDiff[] = (snapshot.changedFiles || []).map((file) => {
    const { hunks, additions, deletions } = parsePatchHunks(file.patch);
    const status = normalizeFileStatus(file, hunks);
    return {
      path: file.path,
      status,
      patch: file.patch,
      additions: (file as any).additions !== undefined ? (file as any).additions : additions,
      deletions: (file as any).deletions !== undefined ? (file as any).deletions : deletions,
      hunks: (file as any).hunks !== undefined ? (file as any).hunks : hunks,
    };
  });

  const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0);
  const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);

  return {
    success: true,
    jobId,
    repo: `${snapshot.owner}/${snapshot.repo}`,
    prNumber: snapshot.prNumber,
    headSha: snapshot.headSha,
    baseSha: snapshot.baseSha,
    title: snapshot.title,
    totalFiles: files.length,
    totalAdditions,
    totalDeletions,
    files,
  };
}

/**
 * Multi-tier diff resolution: In-memory LiveStreamBus -> DashboardStore -> Postgres -> Synthetic Fallback.
 */
export async function resolveReviewDiff(jobId: string): Promise<ReviewDiffResponse | null> {
  if (!jobId || typeof jobId !== 'string') return null;
  const cleanJobId = jobId.trim();

  // Tier 1: Check LiveStreamBus in-memory snapshot cache
  const bus = LiveStreamBus.getInstance();
  const liveSnapshot = bus.getJobSnapshot(cleanJobId);
  if (liveSnapshot) {
    return parseSnapshotDiff(cleanJobId, liveSnapshot);
  }

  // Tier 2: Check dashboardStore review logs
  const logs = dashboardStore.getReviewLogs();
  const matchedLog = logs.find(
    (l) =>
      l.id === cleanJobId ||
      new RegExp(`(?:^|[^0-9])pr${l.prNumber}(?:[^0-9]|$)`, 'i').test(cleanJobId) ||
      (l.repo && cleanJobId.includes(l.repo.replace(/\//g, '_'))),
  );

  if (matchedLog) {
    if ((matchedLog as any).snapshot) {
      return parseSnapshotDiff(cleanJobId, (matchedLog as any).snapshot);
    }
    // Synthetic or test review fallback
    if (cleanJobId.startsWith('job-test-') || (matchedLog as any).isSynthetic) {
      return generateSyntheticDiff(cleanJobId, matchedLog.repo || 'exampleorg/example-api', matchedLog.prNumber || 108, matchedLog.title);
    }
  }

  // Tier 3: PostgreSQL review_run_artifacts (if configured)
  if (postgresStore.isConfigured()) {
    try {
      const pool = postgresStore.getPool();

      // Check review_run_artifacts directly by run_id
      const directSql = `SELECT payload FROM review_run_artifacts WHERE run_id = $1 AND stage = 'snapshot'`;
      const directRes = await pool.query(directSql, [cleanJobId]);
      if (directRes.rows.length > 0) {
        const payload = typeof directRes.rows[0].payload === 'string'
          ? JSON.parse(directRes.rows[0].payload)
          : directRes.rows[0].payload;
        return parseSnapshotDiff(cleanJobId, payload as PRSnapshot);
      }

      // Check joined by review_runs
      const joinSql = `
        SELECT a.payload, r.run_id, r.owner, r.repo, r.pr_number, r.head_sha
          FROM review_runs r
          JOIN review_run_artifacts a ON a.run_id = r.run_id
         WHERE (r.run_id = $1 OR r.head_sha = $1 OR (r.owner || '/' || r.repo) = $1)
           AND a.stage = 'snapshot'
         ORDER BY r.created_at DESC
         LIMIT 1
      `;
      const joinRes = await pool.query(joinSql, [cleanJobId]);
      if (joinRes.rows.length > 0) {
        const payload = typeof joinRes.rows[0].payload === 'string'
          ? JSON.parse(joinRes.rows[0].payload)
          : joinRes.rows[0].payload;
        return parseSnapshotDiff(cleanJobId, payload as PRSnapshot);
      }
    } catch {
      // Fall through gracefully on DB error
    }
  }

  // Tier 4: Synthetic generation if jobId indicates a test or demo job
  if (cleanJobId.startsWith('job-test-') || cleanJobId.startsWith('synthetic-') || cleanJobId === 'default-job') {
    return generateSyntheticDiff(cleanJobId, 'exampleorg/example-api', 108, 'Synthetic PR Review Diff');
  }

  return null;
}

/**
 * Generate high-fidelity synthetic diff for testing & offline UI preview.
 */
export function generateSyntheticDiff(jobId: string, repo: string, prNumber: number, title?: string): ReviewDiffResponse {
  const patch1 = [
    '@@ -24,7 +24,10 @@ export class PipelineIngestionService {',
    '   private readonly queue: TaskQueue;',
    ' ',
    '   async processPayload(payload: IngestPayload): Promise<IngestResult> {',
    '-    const validated = validateInput(payload);',
    '+    const validated = await validateInputAsync(payload);',
    '+    if (!validated.isValid) {',
    '+      throw new ValidationError(validated.errors);',
    '+    }',
    '     return this.queue.enqueue(validated);',
    '   }',
  ].join('\n');

  const patch2 = [
    '@@ -10,4 +10,6 @@ export interface IngestResult {',
    '   id: string;',
    '   status: IngestStatus;',
    '+  executionTimeMs: number;',
    '+  correlationId: string;',
    ' }',
  ].join('\n');

  return parseSnapshotDiff(jobId, {
    owner: repo.split('/')[0] || 'exampleorg',
    repo: repo.split('/')[1] || 'example-api',
    prNumber,
    headSha: 'a1b2c3d4e5f678901234567890abcdef12345678',
    baseSha: '0987654321fedcba0987654321fedcba09876543',
    mergeBaseSha: '0987654321fedcba0987654321fedcba09876543',
    title: title || `PR #${prNumber} Review`,
    configRef: 'main',
    configDigest: 'digest_123',
    engineVersion: 'review-core-v1',
    snapshotDigest: 'snapshot_digest_123',
    changedFiles: [
      {
        path: 'src/services/pipelineIngestionService.ts',
        status: 'modified',
        patch: patch1,
      },
      {
        path: 'src/types/ingest.ts',
        status: 'modified',
        patch: patch2,
      },
    ],
  });
}
