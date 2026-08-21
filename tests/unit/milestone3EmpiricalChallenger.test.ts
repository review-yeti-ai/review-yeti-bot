import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GitHubInstallationClient } from '../../src/github/installationClient';
import { ReviewRunStore } from '../../src/persistence/reviewRunStore';

describe('Milestone 3 Empirical Stress Tests — Diff-Delta Incremental Review Engine', () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-challenger-'));
    storePath = path.join(tmpDir, 'review-runs.json');
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('1. getIncrementalDiff GitHub Compare API contract', () => {
    it('calls GitHub compare API with proper base and head commit SHAs in URL path', async () => {
      const client = new GitHubInstallationClient({ token: 'ghs_dummy_token_9999' });
      let requestedUrl = '';

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
        requestedUrl = String(url);
        return new Response(
          JSON.stringify({
            files: [
              { filename: 'src/app.ts', patch: '@@ -10,3 +10,5 @@\n+added line' },
              { filename: 'src/utils.ts', patch: '@@ -1,2 +1,4 @@\n+another line' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });

      const result = await client.getIncrementalDiff('myorg', 'myrepo', 'sha_base_111', 'sha_head_222');

      expect(requestedUrl).toContain('/repos/myorg/myrepo/compare/sha_base_111...sha_head_222');
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ path: 'src/app.ts', patch: '@@ -10,3 +10,5 @@\n+added line' });
      expect(result[1]).toEqual({ path: 'src/utils.ts', patch: '@@ -1,2 +1,4 @@\n+another line' });
    });

    it('handles encoded special characters in commit SHAs or ref names', async () => {
      const client = new GitHubInstallationClient({ token: 'ghs_dummy_token_9999' });
      let requestedUrl = '';

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
        requestedUrl = String(url);
        return new Response(JSON.stringify({ files: [] }), { status: 200 });
      });

      await client.getIncrementalDiff('myorg', 'myrepo', 'feature/branch#1', 'feature/branch#2');
      expect(requestedUrl).toContain('/compare/feature%2Fbranch%231...feature%2Fbranch%232');
    });
  });

  describe('2. ReviewRunStore previousHeadSha tracking and timing flaw', () => {
    it('EMPIRICAL BUG: getPreviousHead returns undefined when called BEFORE markHead on first sync event', () => {
      const store = new ReviewRunStore(storePath);

      // Event 1: PR opened with head sha_v1
      // app.ts calls store.getPreviousHead(owner, repo, 100) BEFORE markHead
      const prev1 = store.getPreviousHead('owner', 'repo', 100);
      expect(prev1).toBeUndefined();
      store.markHead('owner', 'repo', 100, 'sha_v1');

      // Event 2: PR synchronize with head sha_v2
      // In app.ts line 192, previousHeadSha is fetched BEFORE line 193 markHead('sha_v2')
      const prev2 = store.getPreviousHead('owner', 'repo', 100);
      expect(prev2).toBeUndefined(); // BUG: returns undefined! So incremental diff is skipped on first sync!

      // Now markHead('sha_v2') is called in app.ts line 193
      store.markHead('owner', 'repo', 100, 'sha_v2');

      // Event 3: PR synchronize with head sha_v3
      // Line 192 fetches previousHeadSha BEFORE markHead('sha_v3')
      const prev3 = store.getPreviousHead('owner', 'repo', 100);
      expect(prev3).toBe('sha_v1'); // BUG: returns sha_v1 instead of sha_v2!
    });
  });

  describe('3. ReviewRunStore filterResolvedNits & thread recording bugs', () => {
    it('correctly filters out RESOLVED and ACTIVE nits when recorded properly', () => {
      const store = new ReviewRunStore(storePath);
      const prNumber = 500;

      const nit1 = { path: 'src/auth.ts', line: 10, title: 'Unchecked null', body: 'Add null check' };
      const nit2 = { path: 'src/db.ts', line: 25, title: 'SQL Injection', body: 'Use parameterized query' };

      // Record nit1 as ACTIVE
      store.recordThreads(prNumber, [nit1]);
      // Record nit2 as RESOLVED
      store.resolveThread(prNumber, nit2.path, nit2.line, nit2.title);

      const filtered = store.filterResolvedNits(prNumber, [nit1, nit2]);
      expect(filtered).toHaveLength(0); // Both active (already posted) and resolved are filtered
    });

    it('properly records and filters line 0 findings', () => {
      const store = new ReviewRunStore(storePath);
      const prNumber = 500;

      const line0Finding = { path: 'src/index.ts', line: 0, title: 'Missing License Header', body: 'Add license' };

      // Record line 0 finding
      store.recordThreads(prNumber, [line0Finding]);

      // Line 0 finding is recorded and filtered out on subsequent pass
      const filtered = store.filterResolvedNits(prNumber, [line0Finding]);
      expect(filtered).toHaveLength(0);
    });
  });
});
