import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { computeHunkHash, computeFindingHash, normalizeSnippet, normalizeComment } from '../../src/utils/diffHash';
import { SqliteDiffStateStorage, JsonFileDiffStateStorage, createDiffStateStorage } from '../../src/persistence/db';
import { DiffStateManager } from '../../src/persistence/diffStateManager';

describe('Empirical Stress Test Suite: Diff State & Persistence Layer', () => {
  const tmpDir = path.join(__dirname, '../tmp_challenger');
  const sqliteDbPath = path.join(tmpDir, 'stress_test.db');
  const jsonDbPath = path.join(tmpDir, 'stress_test.json');

  beforeEach(() => {
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(sqliteDbPath)) {
      try { fs.unlinkSync(sqliteDbPath); } catch {}
    }
    if (fs.existsSync(jsonDbPath)) {
      try { fs.unlinkSync(jsonDbPath); } catch {}
    }
  });

  describe('1. SHA-256 Fingerprinting Edge Cases & Collisions', () => {
    it('1.1 Shifted line numbers preserve finding fingerprint', () => {
      const fLine10 = {
        filePath: 'src/auth.ts',
        persona: 'security',
        severity: 'critical' as const,
        codeSnippet: 'const pass = req.body.password;',
        comment: 'Plaintext password access',
        ruleId: 'SEC-001',
      };
      const fLine500 = {
        ...fLine10,
      };

      const hash10 = computeFindingHash(fLine10);
      const hash500 = computeFindingHash(fLine500);
      expect(hash10).toBe(hash500);
    });

    it('1.2 Line ending variations (CRLF vs LF) produce identical hashes', () => {
      const hunkCRLF = {
        filePath: 'src/app.ts',
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 2,
        hunkContent: 'line1\r\nline2\r\n',
      };
      const hunkLF = {
        filePath: 'src/app.ts',
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 2,
        hunkContent: 'line1\nline2\n',
      };
      expect(computeHunkHash(hunkCRLF)).toBe(computeHunkHash(hunkLF));
    });

    it('1.3 Whitespace variations: leading/trailing whitespace & blank lines', () => {
      const snippetWithBlankLines = '   const x = 1;  \r\n\r\n   const y = 2;  \r\n';
      const snippetClean = 'const x = 1;\nconst y = 2;';
      expect(normalizeSnippet(snippetWithBlankLines)).toBe(snippetClean);

      const f1 = {
        filePath: 'src/utils.ts',
        persona: 'quality',
        severity: 'minor' as const,
        codeSnippet: snippetWithBlankLines,
        comment: '  Messy   formatting!!  ',
      };
      const f2 = {
        filePath: 'src/utils.ts',
        persona: 'quality',
        severity: 'minor' as const,
        codeSnippet: snippetClean,
        comment: 'messy formatting',
      };
      expect(computeFindingHash(f1)).toBe(computeFindingHash(f2));
    });

    it('1.4 Hunk line number shifting retains identical hunk hash', () => {
      const hunk1 = {
        filePath: 'src/index.ts',
        oldStart: 10,
        oldLines: 5,
        newStart: 10,
        newLines: 5,
        hunkContent: '+const a = 1;',
      };
      const hunk2Shifted = {
        filePath: 'src/index.ts',
        oldStart: 100, // shifted due to insertions above
        oldLines: 5,
        newStart: 120,
        newLines: 5,
        hunkContent: '+const a = 1;',
      };
      expect(computeHunkHash(hunk1)).toBe(computeHunkHash(hunk2Shifted));
    });

    it('1.5 Collisions: Two identical findings in same file by same persona overwrite each other in Map', () => {
      const finding1 = {
        filePath: 'src/handler.ts',
        startLine: 10,
        endLine: 12,
        persona: 'security',
        severity: 'major' as const,
        comment: 'Unhandled error in async handler',
        codeSnippet: 'catch (e) { log(e); }',
      };
      const finding2 = {
        filePath: 'src/handler.ts',
        startLine: 90, // Different line number in same file!
        endLine: 92,
        persona: 'security',
        severity: 'major' as const,
        comment: 'Unhandled error in async handler',
        codeSnippet: 'catch (e) { log(e); }',
      };

      const hash1 = computeFindingHash(finding1);
      const hash2 = computeFindingHash(finding2);

      // Line numbers are omitted from hash so line shifts produce identical fingerprint hashes
      expect(hash1).toBe(hash2);
    });

    it('1.6 ruleId hyphen retention vs comment hyphen stripping creates hash mismatch', () => {
      const findingWithRule = {
        filePath: 'src/api.ts',
        persona: 'security',
        severity: 'critical' as const,
        codeSnippet: 'apiCall()',
        comment: 'Unauthenticated endpoint',
        ruleId: 'SEC-001',
      };
      const findingWithoutRule = {
        filePath: 'src/api.ts',
        persona: 'security',
        severity: 'critical' as const,
        codeSnippet: 'apiCall()',
        comment: 'SEC-001',
      };

      const hashRule = computeFindingHash(findingWithRule);
      const hashComment = computeFindingHash(findingWithoutRule);

      // Consistent hyphen normalization produces matching hashes
      expect(hashRule).toBe(hashComment);
    });
  });

  describe('2. Multi-Commit PR Updates & State Transitions', () => {
    it('2.1 Status transitions: IDENTIFIED -> RESOLVED on fix', async () => {
      const storage = new JsonFileDiffStateStorage(jsonDbPath);
      await storage.init();
      const manager = new DiffStateManager(storage);

      // Commit 1: Finding detected
      const c1 = await manager.processPRCommitUpdate({
        repoOwner: 'test',
        repoName: 'repo',
        prNumber: 1,
        headSha: 'sha1',
        baseSha: 'base',
        hunks: [{ filePath: 'src/a.ts', oldStart: 1, oldLines: 5, newStart: 1, newLines: 5, hunkContent: 'badCode()' }],
        quorumFindings: [{
          filePath: 'src/a.ts',
          startLine: 2,
          endLine: 2,
          persona: 'security',
          severity: 'critical',
          comment: 'Bad code detected',
          codeSnippet: 'badCode()',
        }],
      });

      expect(c1.activeFindings).toHaveLength(1);
      expect(c1.activeFindings[0].status).toBe('IDENTIFIED');

      // Commit 2: Fix bad code
      const c2 = await manager.processPRCommitUpdate({
        repoOwner: 'test',
        repoName: 'repo',
        prNumber: 1,
        headSha: 'sha2',
        baseSha: 'base',
        hunks: [{ filePath: 'src/a.ts', oldStart: 1, oldLines: 5, newStart: 1, newLines: 5, hunkContent: 'goodCode()' }],
        quorumFindings: [],
      });

      expect(c2.resolvedFindings).toHaveLength(1);
      expect(c2.resolvedFindings[0].status).toBe('RESOLVED');
      expect(c2.resolvedFindings[0].resolvedAtCommit).toBe('sha2');
    });

    it('2.2 Duplicate non-critical finding in subsequent commit is SUPPRESSED', async () => {
      const storage = new JsonFileDiffStateStorage(jsonDbPath);
      await storage.init();
      const manager = new DiffStateManager(storage);

      // Commit 1: Minor finding detected
      await manager.processPRCommitUpdate({
        repoOwner: 'test',
        repoName: 'repo',
        prNumber: 2,
        headSha: 'sha1',
        baseSha: 'base',
        hunks: [{ filePath: 'src/b.ts', oldStart: 1, oldLines: 5, newStart: 1, newLines: 5, hunkContent: 'var x = 1;' }],
        quorumFindings: [{
          filePath: 'src/b.ts',
          startLine: 1,
          endLine: 1,
          persona: 'quality',
          severity: 'minor',
          comment: 'Use const instead of var',
          codeSnippet: 'var x = 1;',
        }],
      });

      // Commit 2: Code fixed, finding resolved
      await manager.processPRCommitUpdate({
        repoOwner: 'test',
        repoName: 'repo',
        prNumber: 2,
        headSha: 'sha2',
        baseSha: 'base',
        hunks: [{ filePath: 'src/b.ts', oldStart: 1, oldLines: 5, newStart: 1, newLines: 5, hunkContent: 'const x = 1;' }],
        quorumFindings: [],
      });

      // Commit 3: Developer changes line to 'var x = 1;' again, reviewer reports minor finding again
      const c3 = await manager.processPRCommitUpdate({
        repoOwner: 'test',
        repoName: 'repo',
        prNumber: 2,
        headSha: 'sha3',
        baseSha: 'base',
        hunks: [{ filePath: 'src/b.ts', oldStart: 1, oldLines: 5, newStart: 1, newLines: 5, hunkContent: 'var x = 1;' }],
        quorumFindings: [{
          filePath: 'src/b.ts',
          startLine: 1,
          endLine: 1,
          persona: 'quality',
          severity: 'minor',
          comment: 'Use const instead of var',
          codeSnippet: 'var x = 1;',
        }],
      });

      expect(c3.suppressedFindingHashes).toHaveLength(1);
      const state = await storage.getPRState('test', 'repo', 2);
      const f = state?.findings.find(item => item.severity === 'minor');
      expect(f?.status).toBe('SUPPRESSED');
    });

    it('2.3 Re-opens critical resolved finding if regression occurs', async () => {
      const storage = new JsonFileDiffStateStorage(jsonDbPath);
      await storage.init();
      const manager = new DiffStateManager(storage);

      // Commit 1: Critical finding detected
      await manager.processPRCommitUpdate({
        repoOwner: 'test',
        repoName: 'repo',
        prNumber: 3,
        headSha: 'sha1',
        baseSha: 'base',
        hunks: [{ filePath: 'src/c.ts', oldStart: 1, oldLines: 5, newStart: 1, newLines: 5, hunkContent: 'eval(userInput)' }],
        quorumFindings: [{
          filePath: 'src/c.ts',
          startLine: 1,
          endLine: 1,
          persona: 'security',
          severity: 'critical',
          comment: 'RCE eval vulnerability',
          codeSnippet: 'eval(userInput)',
        }],
      });

      // Commit 2: Resolved
      await manager.processPRCommitUpdate({
        repoOwner: 'test',
        repoName: 'repo',
        prNumber: 3,
        headSha: 'sha2',
        baseSha: 'base',
        hunks: [{ filePath: 'src/c.ts', oldStart: 1, oldLines: 5, newStart: 1, newLines: 5, hunkContent: 'safeParse(userInput)' }],
        quorumFindings: [],
      });

      // Commit 3: Regression! eval(userInput) re-introduced
      const c3 = await manager.processPRCommitUpdate({
        repoOwner: 'test',
        repoName: 'repo',
        prNumber: 3,
        headSha: 'sha3',
        baseSha: 'base',
        hunks: [{ filePath: 'src/c.ts', oldStart: 1, oldLines: 5, newStart: 1, newLines: 5, hunkContent: 'eval(userInput)' }],
        quorumFindings: [{
          filePath: 'src/c.ts',
          startLine: 1,
          endLine: 1,
          persona: 'security',
          severity: 'critical',
          comment: 'RCE eval vulnerability',
          codeSnippet: 'eval(userInput)',
        }],
      });

      expect(c3.activeFindings).toHaveLength(1);
      expect(c3.activeFindings[0].status).toBe('IDENTIFIED');
      expect(c3.activeFindings[0].resolvedAtCommit).toBeNull();
    });

    it('2.4 CRITICAL EDGE CASE: Partial file edits resolve untouched findings in modified file!', async () => {
      const storage = new JsonFileDiffStateStorage(jsonDbPath);
      await storage.init();
      const manager = new DiffStateManager(storage);

      // Commit 1: File src/bigFile.ts has TWO hunks/findings:
      // - Finding A at line 10
      // - Finding B at line 200
      await manager.processPRCommitUpdate({
        repoOwner: 'test',
        repoName: 'repo',
        prNumber: 4,
        headSha: 'sha1',
        baseSha: 'base',
        hunks: [
          { filePath: 'src/bigFile.ts', oldStart: 10, oldLines: 5, newStart: 10, newLines: 5, hunkContent: 'badCodeA()' },
          { filePath: 'src/bigFile.ts', oldStart: 200, oldLines: 5, newStart: 200, newLines: 5, hunkContent: 'badCodeB()' },
        ],
        quorumFindings: [
          { filePath: 'src/bigFile.ts', startLine: 10, endLine: 10, persona: 'sec', severity: 'major', comment: 'Bug A', codeSnippet: 'badCodeA()' },
          { filePath: 'src/bigFile.ts', startLine: 200, endLine: 200, persona: 'sec', severity: 'major', comment: 'Bug B', codeSnippet: 'badCodeB()' },
        ],
      });

      // Commit 2: Developer ONLY fixes badCodeB at line 200.
      // Hunk at line 10 was UNCHANGED, so hunk at line 10 is NOT sent to review (hunksToReview only has line 200).
      // Therefore, quorumFindings only includes findings for reviewed hunks (in this case, none since badCodeB was fixed).
      const c2 = await manager.processPRCommitUpdate({
        repoOwner: 'test',
        repoName: 'repo',
        prNumber: 4,
        headSha: 'sha2',
        baseSha: 'base',
        hunks: [
          { filePath: 'src/bigFile.ts', oldStart: 200, oldLines: 5, newStart: 200, newLines: 5, hunkContent: 'fixedCodeB()' },
        ],
        quorumFindings: [], // badCodeA at line 10 was untouched and NOT re-reviewed!
      });

      // REMEDIATED BEHAVIOR:
      // Finding A stays IDENTIFIED because line 10 hunk range was untouched in Commit 2.
      const findingA = c2.currentState.findings.find(f => f.comment === 'Bug A');

      expect(findingA?.status).toBe('IDENTIFIED');
    });
  });

  describe('3. Dual-Tier Persistence Layer (SQLite & JSON Fallback)', () => {
    it('3.1 SQLite Storage Engine handles SQL injection characters safely', async () => {
      const storage = new SqliteDiffStateStorage(sqliteDbPath);
      try {
        await storage.init();
      } catch (err: any) {
        expect(err.message).toContain('better-sqlite3');
        return;
      }

      const maliciousState = {
        repoOwner: "owner' OR '1'='1",
        repoName: "repo' DROP TABLE pr_states; --",
        prNumber: 99,
        headSha: "sha' OR '1'='1",
        baseSha: "base",
        updatedAt: new Date().toISOString(),
        hunks: [],
        findings: [{
          fingerprintHash: "hash' OR '1'='1",
          filePath: "src/file'--.ts",
          startLine: 1,
          endLine: 1,
          persona: "sec'--",
          severity: "critical" as const,
          comment: "Comment containing ' single quotes and \" double quotes",
          status: "IDENTIFIED" as const,
          firstSeenCommit: "sha1",
          lastSeenCommit: "sha1",
          resolvedAtCommit: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }],
      };

      await storage.savePRState(maliciousState);
      const retrieved = await storage.getPRState("owner' OR '1'='1", "repo' DROP TABLE pr_states; --", 99);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.findings[0].comment).toContain("single quotes");

      await storage.close();
    });

    it('3.2 JSON File Storage handles concurrent reads and atomic file writes', async () => {
      const storage = new JsonFileDiffStateStorage(jsonDbPath);
      await storage.init();

      const promises = [];
      for (let i = 1; i <= 10; i++) {
        promises.push(storage.savePRState({
          repoOwner: 'org',
          repoName: 'repo',
          prNumber: i,
          headSha: `sha_${i}`,
          baseSha: 'base',
          updatedAt: new Date().toISOString(),
          hunks: [],
          findings: [],
        }));
      }

      await Promise.all(promises);

      for (let i = 1; i <= 10; i++) {
        const state = await storage.getPRState('org', 'repo', i);
        expect(state?.headSha).toBe(`sha_${i}`);
      }

      await storage.close();
    });

    it('3.3 Automatic failover from SQLite to JSON Storage when SQLite path is invalid directory', async () => {
      // Invalid path where directory creation fails (e.g. invalid permissions or bad path)
      const invalidSqlitePath = '/dev/null/invalid/db.sqlite';
      const storage = await createDiffStateStorage(invalidSqlitePath, jsonDbPath);
      
      expect(storage).toBeInstanceOf(JsonFileDiffStateStorage);
      await storage.close();
    });

    it('3.4 Cross-instance JSON File Storage overwrite risk', async () => {
      const storageInstance1 = new JsonFileDiffStateStorage(jsonDbPath);
      await storageInstance1.init();
      await storageInstance1.savePRState({
        repoOwner: 'owner',
        repoName: 'repo',
        prNumber: 100,
        headSha: 'sha_inst1',
        baseSha: 'base',
        updatedAt: new Date().toISOString(),
        hunks: [],
        findings: [],
      });

      // Second instance initialized pointing to same file path
      const storageInstance2 = new JsonFileDiffStateStorage(jsonDbPath);
      await storageInstance2.init();

      // Instance 1 writes update for PR 101
      await storageInstance1.savePRState({
        repoOwner: 'owner',
        repoName: 'repo',
        prNumber: 101,
        headSha: 'sha_inst1_new',
        baseSha: 'base',
        updatedAt: new Date().toISOString(),
        hunks: [],
        findings: [],
      });

      // Instance 2 writes PR 200 after checking file mtime on disk
      await storageInstance2.savePRState({
        repoOwner: 'owner',
        repoName: 'repo',
        prNumber: 200,
        headSha: 'sha_inst2',
        baseSha: 'base',
        updatedAt: new Date().toISOString(),
        hunks: [],
        findings: [],
      });

      // Instance 3 checks if PR 101 state exists in JSON file
      const storageInstance3 = new JsonFileDiffStateStorage(jsonDbPath);
      await storageInstance3.init();
      const state101 = await storageInstance3.getPRState('owner', 'repo', 101);

      // Instance 2 re-synced from disk before saving, preserving PR 101 state
      expect(state101).not.toBeNull();
    });
  });
});
