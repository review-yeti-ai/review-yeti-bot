import { describe, it, expect, beforeEach } from 'vitest';
import {
  parsePatchHunks,
  normalizeFileStatus,
  parseSnapshotDiff,
  generateSyntheticDiff,
  resolveReviewDiff,
} from '../../src/review/diffService';
import { LiveStreamBus } from '../../src/live/liveStreamBus';
import type { PRSnapshot } from '../../src/review/prSnapshot';

describe('DiffService Unit Tests', () => {
  beforeEach(() => {
    LiveStreamBus.getInstance().clearHistory();
  });

  describe('parsePatchHunks', () => {
    it('parses standard unified diff hunks with old and new line numbers', () => {
      const patch = [
        '@@ -10,6 +10,8 @@ function test() {',
        '   const a = 1;',
        '-  const b = 2;',
        '+  const b = 3;',
        '+  const c = 4;',
        '   return a + b;',
        ' }',
      ].join('\n');

      const result = parsePatchHunks(patch);
      expect(result.hunks).toHaveLength(1);
      const hunk = result.hunks[0];
      expect(hunk.oldStart).toBe(10);
      expect(hunk.oldLines).toBe(6);
      expect(hunk.newStart).toBe(10);
      expect(hunk.newLines).toBe(8);
      expect(hunk.lines).toHaveLength(6);
      expect(result.additions).toBe(2);
      expect(result.deletions).toBe(1);
    });

    it('handles single-line additions and deletions where line count is omitted', () => {
      const patch = [
        '@@ -15 +15,2 @@',
        '-oldLine',
        '+newLine1',
        '+newLine2',
      ].join('\n');

      const result = parsePatchHunks(patch);
      expect(result.hunks).toHaveLength(1);
      expect(result.hunks[0].oldStart).toBe(15);
      expect(result.hunks[0].oldLines).toBe(1);
      expect(result.hunks[0].newStart).toBe(15);
      expect(result.hunks[0].newLines).toBe(2);
      expect(result.additions).toBe(2);
      expect(result.deletions).toBe(1);
    });

    it('handles file creations (oldStart=0, oldLines=0)', () => {
      const patch = [
        '@@ -0,0 +1,3 @@',
        '+line 1',
        '+line 2',
        '+line 3',
      ].join('\n');

      const result = parsePatchHunks(patch);
      expect(result.hunks).toHaveLength(1);
      expect(result.hunks[0].oldStart).toBe(0);
      expect(result.hunks[0].oldLines).toBe(0);
      expect(result.hunks[0].newStart).toBe(1);
      expect(result.hunks[0].newLines).toBe(3);
      expect(result.additions).toBe(3);
      expect(result.deletions).toBe(0);
    });

    it('handles file deletions (newStart=0, newLines=0)', () => {
      const patch = [
        '@@ -1,4 +0,0 @@',
        '-line 1',
        '-line 2',
        '-line 3',
        '-line 4',
      ].join('\n');

      const result = parsePatchHunks(patch);
      expect(result.hunks).toHaveLength(1);
      expect(result.hunks[0].oldStart).toBe(1);
      expect(result.hunks[0].oldLines).toBe(4);
      expect(result.hunks[0].newStart).toBe(0);
      expect(result.hunks[0].newLines).toBe(0);
      expect(result.additions).toBe(0);
      expect(result.deletions).toBe(4);
    });

    it('handles multiple hunks in a single patch file', () => {
      const patch = [
        '@@ -1,3 +1,3 @@',
        '-first',
        '+first_mod',
        ' context',
        '@@ -20,2 +20,3 @@',
        ' lineA',
        '+lineB',
      ].join('\n');

      const result = parsePatchHunks(patch);
      expect(result.hunks).toHaveLength(2);
      expect(result.additions).toBe(2);
      expect(result.deletions).toBe(1);
    });

    it('returns empty result for empty, null, or undefined patch', () => {
      expect(parsePatchHunks('')).toEqual({ hunks: [], additions: 0, deletions: 0 });
      expect(parsePatchHunks(null)).toEqual({ hunks: [], additions: 0, deletions: 0 });
      expect(parsePatchHunks(undefined)).toEqual({ hunks: [], additions: 0, deletions: 0 });
    });
  });

  describe('normalizeFileStatus', () => {
    it('normalizes status string properly', () => {
      expect(normalizeFileStatus({ status: 'added' }, [])).toBe('added');
      expect(normalizeFileStatus({ status: 'new' }, [])).toBe('added');
      expect(normalizeFileStatus({ status: 'deleted' }, [])).toBe('deleted');
      expect(normalizeFileStatus({ status: 'removed' }, [])).toBe('deleted');
      expect(normalizeFileStatus({ status: 'modified' }, [])).toBe('modified');
      expect(normalizeFileStatus({ status: 'renamed' }, [])).toBe('modified');
    });

    it('infers status from hunks when status property is absent', () => {
      const addHunk = [{ header: '', oldStart: 0, oldLines: 0, newStart: 1, newLines: 5, lines: [] }];
      expect(normalizeFileStatus({} as any, addHunk)).toBe('added');

      const delHunk = [{ header: '', oldStart: 1, oldLines: 5, newStart: 0, newLines: 0, lines: [] }];
      expect(normalizeFileStatus({} as any, delHunk)).toBe('deleted');

      const modHunk = [{ header: '', oldStart: 10, oldLines: 5, newStart: 10, newLines: 6, lines: [] }];
      expect(normalizeFileStatus({} as any, modHunk)).toBe('modified');
    });
  });

  describe('parseSnapshotDiff', () => {
    it('constructs a full ReviewDiffResponse from PRSnapshot', () => {
      const snapshot: PRSnapshot = {
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        prNumber: 99,
        headSha: 'abc1234',
        baseSha: 'def5678',
        mergeBaseSha: 'def5678',
        title: 'Feature PR',
        configRef: 'main',
        configDigest: 'digest',
        engineVersion: 'review-core-v1',
        snapshotDigest: 'snap_digest',
        changedFiles: [
          {
            path: 'src/main.ts',
            status: 'modified',
            patch: '@@ -1,2 +1,3 @@\n-old\n+new1\n+new2',
          },
        ],
      };

      const diff = parseSnapshotDiff('job_test_1', snapshot);
      expect(diff.success).toBe(true);
      expect(diff.jobId).toBe('job_test_1');
      expect(diff.repo).toBe('calltelemetry/cisco-cdr');
      expect(diff.prNumber).toBe(99);
      expect(diff.totalFiles).toBe(1);
      expect(diff.totalAdditions).toBe(2);
      expect(diff.totalDeletions).toBe(1);
      expect(diff.files[0].path).toBe('src/main.ts');
      expect(diff.files[0].hunks).toHaveLength(1);
    });
  });

  describe('generateSyntheticDiff', () => {
    it('generates a synthetic diff with structured hunks', () => {
      const diff = generateSyntheticDiff('synthetic-job-1', 'calltelemetry/review-yeti-bot', 123);
      expect(diff.success).toBe(true);
      expect(diff.jobId).toBe('synthetic-job-1');
      expect(diff.totalFiles).toBe(2);
      expect(diff.totalAdditions).toBeGreaterThan(0);
      expect(diff.files[0].hunks.length).toBeGreaterThan(0);
    });
  });

  describe('resolveReviewDiff', () => {
    it('resolves active review diff from LiveStreamBus cache', async () => {
      const bus = LiveStreamBus.getInstance();
      const mockSnapshot: PRSnapshot = {
        owner: 'test-org',
        repo: 'test-repo',
        prNumber: 42,
        headSha: 'head123',
        baseSha: 'base456',
        mergeBaseSha: 'base456',
        title: 'Active PR',
        configRef: 'main',
        configDigest: 'digest',
        engineVersion: 'review-core-v1',
        snapshotDigest: 'snap',
        changedFiles: [
          {
            path: 'src/active.ts',
            status: 'added',
            patch: '@@ -0,0 +1,2 @@\n+line1\n+line2',
          },
        ],
      };

      bus.setJobSnapshot('job-active-42', mockSnapshot);
      const diff = await resolveReviewDiff('job-active-42');
      expect(diff).not.toBeNull();
      expect(diff?.jobId).toBe('job-active-42');
      expect(diff?.repo).toBe('test-org/test-repo');
      expect(diff?.files[0].path).toBe('src/active.ts');
      expect(diff?.files[0].additions).toBe(2);
    });

    it('resolves synthetic test job diffs', async () => {
      const diff = await resolveReviewDiff('job-test-review-999');
      expect(diff).not.toBeNull();
      expect(diff?.jobId).toBe('job-test-review-999');
      expect(diff?.totalFiles).toBeGreaterThan(0);
    });

    it('returns null for empty or non-existent job ID', async () => {
      expect(await resolveReviewDiff('')).toBeNull();
      expect(await resolveReviewDiff('unknown-job-never-existed-12345')).toBeNull();
    });
  });
});
