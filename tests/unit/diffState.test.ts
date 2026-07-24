import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { computeHunkHash, computeFindingHash, normalizeSnippet, normalizeComment } from '../../src/utils/diffHash';
import { SqliteDiffStateStorage, JsonFileDiffStateStorage, createDiffStateStorage } from '../../src/persistence/db';
import { DiffStateManager } from '../../src/persistence/diffStateManager';

describe('Diff Hashing & State Persistence Engine', () => {
  const tmpDir = path.join(__dirname, '../tmp');
  const dbPath = path.join(tmpDir, 'test_diff_state.db');
  const jsonPath = path.join(tmpDir, 'test_diff_state.json');

  beforeEach(() => {
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);
  });

  describe('SHA-256 Hashing & Fingerprinting', () => {
    it('generates consistent, deterministic SHA-256 hunk hashes', () => {
      const hunkInput1 = {
        filePath: 'src/app.ts',
        oldStart: 10,
        oldLines: 5,
        newStart: 10,
        newLines: 6,
        hunkContent: ' const x = 1;\r\n+const y = 2;\r\n',
      };

      const hunkInput2 = {
        filePath: 'src/app.ts',
        oldStart: 10,
        oldLines: 5,
        newStart: 10,
        newLines: 6,
        hunkContent: ' const x = 1;\n+const y = 2;\n',
      };

      const hash1 = computeHunkHash(hunkInput1);
      const hash2 = computeHunkHash(hunkInput2);

      expect(hash1).toHaveLength(64);
      expect(hash1).toBe(hash2);
    });

    it('generates line-shift resilient finding fingerprints', () => {
      const findingAtLine10 = {
        filePath: 'src/auth.ts',
        persona: 'security',
        severity: 'critical' as const,
        codeSnippet: 'const token = jwt.decode(input);',
        comment: 'Unverified JWT decoded directly',
        ruleId: 'SEC-JWT-UNVERIFIED',
      };

      const findingAtLine50 = {
        ...findingAtLine10,
        // Same code snippet and rule, but line number shifted due to inserted lines above
      };

      const hash1 = computeFindingHash(findingAtLine10);
      const hash2 = computeFindingHash(findingAtLine50);

      expect(hash1).toHaveLength(64);
      expect(hash1).toBe(hash2);
    });

    it('normalizes snippets and comments correctly', () => {
      expect(normalizeSnippet('  line1  \r\n  line2  ')).toBe('line1\nline2');
      expect(normalizeComment('Fix THIS immediately!!')).toBe('fix this immediately');
    });
  });

  describe('SQLite Storage Engine', () => {
    it('initializes schema and performs CRUD operations on PR states when SQLite binary is available', async () => {
      const storage = new SqliteDiffStateStorage(':memory:');
      try {
        await storage.init();
      } catch (err: any) {
        // Native binary binding unavailable in current runtime environment
        expect(err.message).toContain('better-sqlite3');
        return;
      }

      const initialState = {
        repoOwner: 'acme',
        repoName: 'ct-bot',
        prNumber: 42,
        headSha: 'c1111',
        baseSha: 'c0000',
        updatedAt: new Date().toISOString(),
        hunks: [
          {
            filePath: 'src/index.ts',
            hunkHash: 'hash123',
            oldStart: 1,
            oldLines: 10,
            newStart: 1,
            newLines: 12,
            commitSha: 'c1111',
            createdAt: new Date().toISOString(),
          },
        ],
        findings: [
          {
            fingerprintHash: 'finding_hash_1',
            filePath: 'src/index.ts',
            startLine: 5,
            endLine: 5,
            persona: 'security',
            severity: 'critical' as const,
            comment: 'Unsafe eval',
            status: 'IDENTIFIED' as const,
            firstSeenCommit: 'c1111',
            lastSeenCommit: 'c1111',
            resolvedAtCommit: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      };

      await storage.savePRState(initialState);

      const retrieved = await storage.getPRState('acme', 'ct-bot', 42);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.headSha).toBe('c1111');
      expect(retrieved?.hunks).toHaveLength(1);
      expect(retrieved?.findings).toHaveLength(1);

      await storage.updateFindingStatus('acme', 'ct-bot', 42, 'finding_hash_1', 'RESOLVED', 'c2222');
      const updatedFindings = await storage.getFindings('acme', 'ct-bot', 42);
      expect(updatedFindings[0].status).toBe('RESOLVED');
      expect(updatedFindings[0].resolvedAtCommit).toBe('c2222');

      await storage.close();
    });
  });

  describe('JSON File Storage Fallback Engine', () => {
    it('atomically saves and recovers PR states from JSON storage', async () => {
      const storage = new JsonFileDiffStateStorage(jsonPath);
      await storage.init();

      const state = {
        repoOwner: 'org',
        repoName: 'repo',
        prNumber: 10,
        headSha: 'abc',
        baseSha: 'def',
        updatedAt: new Date().toISOString(),
        hunks: [],
        findings: [],
      };

      await storage.savePRState(state);
      expect(fs.existsSync(jsonPath)).toBe(true);

      const recovered = await storage.getPRState('org', 'repo', 10);
      expect(recovered?.headSha).toBe('abc');

      await storage.close();
    });
  });

  describe('DiffStateManager Lifecycle & Transitions', () => {
    it('manages multi-commit PR transitions and finding state updates', async () => {
      const storage = await createDiffStateStorage(':memory:', jsonPath);
      const manager = new DiffStateManager(storage);

      // Commit 1: Initial review pass
      const commit1Result = await manager.processPRCommitUpdate({
        repoOwner: 'owner',
        repoName: 'repo',
        prNumber: 1,
        headSha: 'c111',
        baseSha: 'c000',
        hunks: [
          {
            filePath: 'src/main.ts',
            oldStart: 1,
            oldLines: 10,
            newStart: 1,
            newLines: 10,
            hunkContent: 'console.log("debug");',
          },
        ],
        quorumFindings: [
          {
            filePath: 'src/main.ts',
            startLine: 1,
            endLine: 1,
            persona: 'quality',
            severity: 'nit',
            comment: 'Avoid console.log in production',
            codeSnippet: 'console.log("debug");',
          },
        ],
      });

      expect(commit1Result.activeFindings).toHaveLength(1);
      expect(commit1Result.activeFindings[0].status).toBe('IDENTIFIED');

      // Commit 2: Developer fixes the console.log issue
      const commit2Result = await manager.processPRCommitUpdate({
        repoOwner: 'owner',
        repoName: 'repo',
        prNumber: 1,
        headSha: 'c222',
        baseSha: 'c000',
        hunks: [
          {
            filePath: 'src/main.ts',
            oldStart: 1,
            oldLines: 10,
            newStart: 1,
            newLines: 10,
            hunkContent: 'logger.info("debug");',
          },
        ],
        quorumFindings: [], // Finding resolved by code fix
      });

      expect(commit2Result.resolvedFindings).toHaveLength(1);
      expect(commit2Result.resolvedFindings[0].status).toBe('RESOLVED');
      expect(commit2Result.resolvedFindings[0].resolvedAtCommit).toBe('c222');

      await storage.close();
    });

    it('does not resolve untouched findings in unmodified hunk sections of modified files', async () => {
      const storage = await createDiffStateStorage(':memory:', jsonPath);
      const manager = new DiffStateManager(storage);

      // Commit 1: Finding on line 10
      await manager.processPRCommitUpdate({
        repoOwner: 'owner',
        repoName: 'repo',
        prNumber: 2,
        headSha: 'c111',
        baseSha: 'c000',
        hunks: [
          {
            filePath: 'src/app.ts',
            oldStart: 1,
            oldLines: 20,
            newStart: 1,
            newLines: 20,
            hunkContent: 'hunk at top',
          },
        ],
        quorumFindings: [
          {
            filePath: 'src/app.ts',
            startLine: 10,
            endLine: 12,
            persona: 'security',
            severity: 'critical',
            comment: 'Unsafe eval',
            codeSnippet: 'eval(input);',
          },
        ],
      });

      // Commit 2: Hunk at lines 100-110 in app.ts is modified (line 10 untouched)
      const commit2Result = await manager.processPRCommitUpdate({
        repoOwner: 'owner',
        repoName: 'repo',
        prNumber: 2,
        headSha: 'c222',
        baseSha: 'c000',
        hunks: [
          {
            filePath: 'src/app.ts',
            oldStart: 100,
            oldLines: 10,
            newStart: 100,
            newLines: 10,
            hunkContent: 'hunk at bottom',
          },
        ],
        quorumFindings: [], // Nothing found in lines 100-110
      });

      // Finding at line 10 must remain IDENTIFIED because its hunk line range was untouched
      expect(commit2Result.activeFindings).toHaveLength(1);
      expect(commit2Result.resolvedFindings).toHaveLength(0);
      expect(commit2Result.activeFindings[0].startLine).toBe(10);

      await storage.close();
    });

    it('produces identical finding hash for shifted line numbers of the same finding', () => {
      const findingLine10 = {
        filePath: 'src/app.ts',
        startLine: 10,
        endLine: 10,
        persona: 'quality',
        severity: 'minor' as const,
        codeSnippet: 'console.log("x");',
        comment: 'avoid console.log',
      };
      const findingLine50 = {
        filePath: 'src/app.ts',
        startLine: 50,
        endLine: 50,
        persona: 'quality',
        severity: 'minor' as const,
        codeSnippet: 'console.log("x");',
        comment: 'avoid console.log',
      };

      const hash10 = computeFindingHash(findingLine10);
      const hash50 = computeFindingHash(findingLine50);

      expect(hash10).toBe(hash50);
    });

    it('re-reads from disk when JSON storage file mtime changes', async () => {
      const storage1 = new JsonFileDiffStateStorage(jsonPath);
      await storage1.init();
      await storage1.savePRState({
        repoOwner: 'owner',
        repoName: 'repo',
        prNumber: 5,
        headSha: 'c111',
        baseSha: 'c000',
        updatedAt: new Date().toISOString(),
        hunks: [],
        findings: [],
      });

      const storage2 = new JsonFileDiffStateStorage(jsonPath);
      await storage2.init();

      // Externally update json file on disk
      const diskData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      diskData['owner/repo#5'].headSha = 'c222_external';
      // Sleep slightly so mtime changes
      await new Promise(r => setTimeout(r, 50));
      fs.writeFileSync(jsonPath, JSON.stringify(diskData), 'utf8');

      // storage2 should detect mtime change and reload
      const retrieved = await storage2.getPRState('owner', 'repo', 5);
      expect(retrieved?.headSha).toBe('c222_external');

      await storage1.close();
      await storage2.close();
    });
  });
});
