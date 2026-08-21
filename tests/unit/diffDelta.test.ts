import { describe, expect, it, vi, beforeEach } from 'vitest';
import { GitHubInstallationClient } from '../../src/github/installationClient';
import { ReviewRunStore } from '../../src/persistence/reviewRunStore';
import fs from 'node:fs';

describe('Milestone 3: Diff-Delta Incremental Review & Memory Engine', () => {
  const storePath = '/tmp/test-diff-delta-store.json';

  beforeEach(() => {
    try {
      fs.unlinkSync(storePath);
    } catch {}
  });

  describe('GitHubInstallationClient.getIncrementalDiff', () => {
    it('fetches incremental diff from GitHub Compare API', async () => {
      const client = new GitHubInstallationClient({ token: 'ghs_dummy_token_12345' });

      const mockFiles = [
        { filename: 'src/index.ts', patch: '@@ -1,3 +1,5 @@\n+const x = 1;' },
        { filename: 'src/utils.ts', patch: '@@ -10,2 +10,4 @@\n+export const y = 2;' },
      ];

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
        if (String(url).includes('/compare/base123...head456')) {
          return new Response(JSON.stringify({ files: mockFiles }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('Not found', { status: 404 });
      });

      const diff = await client.getIncrementalDiff('owner', 'repo', 'base123', 'head456');
      expect(diff).toHaveLength(2);
      expect(diff[0].path).toBe('src/index.ts');
      expect(diff[0].patch).toContain('const x = 1');
      expect(diff[1].path).toBe('src/utils.ts');
    });
  });

  describe('ReviewRunStore Head & Thread State Tracking', () => {
    it('stores current and previous head SHAs correctly', () => {
      const store = new ReviewRunStore(storePath);

      expect(store.getPreviousHead(101)).toBeUndefined();

      store.setHead('calltelemetry', 'ct-review-bot', 101, 'sha_v1');
      expect(store.isCurrentHead('calltelemetry', 'ct-review-bot', 101, 'sha_v1')).toBe(true);
      expect(store.getPreviousHead(101)).toBeUndefined();

      store.setHead('calltelemetry', 'ct-review-bot', 101, 'sha_v2');
      expect(store.isCurrentHead('calltelemetry', 'ct-review-bot', 101, 'sha_v2')).toBe(true);
      expect(store.getPreviousHead(101)).toBe('sha_v1');
      expect(store.getPreviousHead('calltelemetry', 'ct-review-bot', 101)).toBe('sha_v1');
    });

    it('filters out resolved and active nits using filterResolvedNits', () => {
      const store = new ReviewRunStore(storePath);

      const finding1 = { persona: 'security', severity: 'P1' as const, filePath: 'src/auth.ts', lineNumber: 42, comment: 'Missing token check', title: 'Security Risk' };
      const finding2 = { persona: 'correctness', severity: 'P2' as const, filePath: 'src/math.ts', lineNumber: 15, comment: 'Possible divide by zero', title: 'Divide by Zero' };
      const finding3 = { persona: 'style', severity: 'P2' as const, filePath: 'src/main.ts', lineNumber: 8, comment: 'Unused import', title: 'Unused Import' };

      // Before recording threads, all findings pass filter
      const initialFiltered = store.filterResolvedNits(202, [finding1, finding2, finding3]);
      expect(initialFiltered).toHaveLength(3);

      // Record finding1 as ACTIVE and finding2 as RESOLVED
      store.recordThreads(202, [finding1]);
      store.resolveThread(202, finding2.filePath, finding2.lineNumber, finding2.title);

      // Subsequent push: finding1 (active) and finding2 (resolved) should be filtered out
      const secondFiltered = store.filterResolvedNits(202, [finding1, finding2, finding3]);
      expect(secondFiltered).toHaveLength(1);
      expect(secondFiltered[0].title).toBe('Unused Import');
    });
  });
});
