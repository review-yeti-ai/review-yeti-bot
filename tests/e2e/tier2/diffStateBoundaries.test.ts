import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { setupE2ETestHarness, E2ETestHarness } from '@harness/e2eTestRunner';
import { computeHunkHash, computeFindingHash, normalizeSnippet, normalizeComment } from '@src/utils/diffHash';
import { SqliteDiffStateStorage, JsonFileDiffStateStorage, createDiffStateStorage } from '@src/persistence/db';
import { DiffStateManager, IncomingFindingInput } from '@src/persistence/diffStateManager';

describe('Tier 2 Boundary & Corner Case Tests: Diff State Persistence & Hashing Engine', () => {
  let harness: E2ETestHarness;
  let testTmpDir: string;

  beforeAll(async () => {
    harness = await setupE2ETestHarness({
      testRunId: 'tier2-diffstate-suite',
    });
    testTmpDir = path.resolve(__dirname, '../../tmp/diffstate_tier2_' + Date.now());
    if (!fs.existsSync(testTmpDir)) {
      fs.mkdirSync(testTmpDir, { recursive: true });
    }
  });

  afterAll(async () => {
    await harness.teardown();
    if (fs.existsSync(testTmpDir)) {
      fs.rmSync(testTmpDir, { recursive: true, force: true });
    }
  });

  test('1. Zero-byte diffs boundary - handles empty hunks, zero lines, and empty hunk content', async () => {
    const jsonPath = path.join(testTmpDir, 'zero_byte_pr_states.json');
    const storage = await createDiffStateStorage(':memory:', jsonPath);
    const manager = new DiffStateManager(storage);

    const result = await manager.processPRCommitUpdate({
      repoOwner: 'owner',
      repoName: 'repo',
      prNumber: 1,
      headSha: 'sha-001',
      baseSha: 'sha-000',
      hunks: [],
      quorumFindings: [],
    });

    expect(result.hunksToReview).toHaveLength(0);
    expect(result.activeFindings).toHaveLength(0);
    expect(result.resolvedFindings).toHaveLength(0);
    expect(result.currentState.hunks).toHaveLength(0);

    // Test hunk with empty content string and zero lines
    const zeroLineHunk = await manager.processPRCommitUpdate({
      repoOwner: 'owner',
      repoName: 'repo',
      prNumber: 1,
      headSha: 'sha-002',
      baseSha: 'sha-001',
      hunks: [
        {
          filePath: 'empty.txt',
          oldStart: 0,
          oldLines: 0,
          newStart: 0,
          newLines: 0,
          hunkContent: '',
        },
      ],
    });

    expect(zeroLineHunk.hunksToReview).toHaveLength(1);
    expect(zeroLineHunk.currentState.hunks[0].hunkHash).toBeDefined();

    await storage.close();
  });

  test('2. SHA-256 hash determinism and normalization boundary', () => {
    // CRLF vs LF line ending normalization
    const hunkLF = {
      filePath: 'src/app.ts',
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 2,
      hunkContent: 'const a = 1;\nconst b = 2;\n',
    };

    const hunkCRLF = {
      filePath: 'src/app.ts',
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 2,
      hunkContent: 'const a = 1;\r\nconst b = 2;\r\n',
    };

    const hashLF = computeHunkHash(hunkLF);
    const hashCRLF = computeHunkHash(hunkCRLF);

    expect(hashLF).toHaveLength(64); // Valid SHA-256 hex string
    expect(hashLF).toBe(hashCRLF); // Normalized content yields identical hash

    // Finding hash normalization
    const snippetNorm = normalizeSnippet('  const x = 10;  \r\n\r\n  console.log(x);  ');
    expect(snippetNorm).toBe('const x = 10;\nconsole.log(x);');

    const commentNorm = normalizeComment('  SQL Injection Vulnerability!!  -- Found by Security  ');
    expect(commentNorm).toBe('sql injection vulnerability found by security');

    const findingHash1 = computeFindingHash({
      filePath: 'src/db.ts',
      persona: 'security',
      severity: 'critical',
      codeSnippet: '  const x = 10; \r\n  console.log(x); ',
      comment: 'SQL Injection Vulnerability!! -- Found by Security',
      startLine: 10,
      endLine: 12,
    });

    const findingHash2 = computeFindingHash({
      filePath: 'src/db.ts',
      persona: 'SECURITY',
      severity: 'critical',
      codeSnippet: 'const x = 10;\nconsole.log(x);',
      comment: 'sql injection vulnerability found by security',
      startLine: 10,
      endLine: 12,
    });

    expect(findingHash1).toBe(findingHash2);
  });

  test('3. Corrupt state DB/JSON boundary - handles corrupted JSON file store gracefully', async () => {
    const corruptJsonPath = path.join(testTmpDir, 'corrupt_pr_states.json');
    fs.writeFileSync(corruptJsonPath, '{ invalid JSON file content !!! ', 'utf8');

    const jsonStorage = new JsonFileDiffStateStorage(corruptJsonPath);
    await jsonStorage.init(); // Logs warning, initializes empty store

    const state = await jsonStorage.getPRState('owner', 'repo', 999);
    expect(state).toBeNull();

    // Saving state overwrites corrupt file with valid JSON
    await jsonStorage.savePRState({
      repoOwner: 'owner',
      repoName: 'repo',
      prNumber: 999,
      headSha: 'sha-999',
      baseSha: 'sha-000',
      updatedAt: new Date().toISOString(),
      hunks: [],
      findings: [],
    });

    const recoveredState = await jsonStorage.getPRState('owner', 'repo', 999);
    expect(recoveredState).not.toBeNull();
    expect(recoveredState?.headSha).toBe('sha-999');

    await jsonStorage.close();
  });

  test('4. Commit SHA re-use and finding status state machine transitions', async () => {
    const jsonPath = path.join(testTmpDir, 'state_machine_pr_states.json');
    const storage = await createDiffStateStorage(':memory:', jsonPath);
    const manager = new DiffStateManager(storage);

    const findingInput: IncomingFindingInput = {
      filePath: 'src/auth.ts',
      startLine: 20,
      endLine: 25,
      persona: 'security',
      severity: 'critical',
      comment: 'Hardcoded secret token detected',
      codeSnippet: 'const secret = "supersecret123";',
    };

    const hunkInput = {
      filePath: 'src/auth.ts',
      oldStart: 15,
      oldLines: 15,
      newStart: 15,
      newLines: 15,
      hunkContent: '+ const secret = "supersecret123";',
    };

    // Pass 1: Initial commit -> IDENTIFIED
    const pass1 = await manager.processPRCommitUpdate({
      repoOwner: 'owner',
      repoName: 'repo',
      prNumber: 10,
      headSha: 'sha-commit-1',
      baseSha: 'sha-base',
      hunks: [hunkInput],
      quorumFindings: [findingInput],
    });

    expect(pass1.activeFindings).toHaveLength(1);
    expect(pass1.activeFindings[0].status).toBe('IDENTIFIED');
    const findingHash = pass1.activeFindings[0].fingerprintHash;

    // Pass 2: Finding fixed in modified hunk -> RESOLVED
    const pass2 = await manager.processPRCommitUpdate({
      repoOwner: 'owner',
      repoName: 'repo',
      prNumber: 10,
      headSha: 'sha-commit-2',
      baseSha: 'sha-commit-1',
      hunks: [
        {
          ...hunkInput,
          hunkContent: '+ const secret = process.env.SECRET_TOKEN;',
        },
      ],
      quorumFindings: [], // Finding resolved
    });

    expect(pass2.resolvedFindings).toHaveLength(1);
    expect(pass2.resolvedFindings[0].status).toBe('RESOLVED');
    expect(pass2.resolvedFindings[0].resolvedAtCommit).toBe('sha-commit-2');

    // Pass 3: Re-introduced critical finding in commit 3 -> Re-opened to IDENTIFIED
    const pass3 = await manager.processPRCommitUpdate({
      repoOwner: 'owner',
      repoName: 'repo',
      prNumber: 10,
      headSha: 'sha-commit-3',
      baseSha: 'sha-commit-2',
      hunks: [hunkInput],
      quorumFindings: [findingInput],
    });

    expect(pass3.activeFindings).toHaveLength(1);
    expect(pass3.activeFindings[0].status).toBe('IDENTIFIED');
    expect(pass3.activeFindings[0].resolvedAtCommit).toBeNull();

    await storage.close();
  });

  test('5. Max finding records boundary - handles large volume of hunks and findings accurately', async () => {
    const jsonPath = path.join(testTmpDir, 'large_volume_pr_states.json');
    const storage = await createDiffStateStorage(':memory:', jsonPath);
    const manager = new DiffStateManager(storage);

    const largeHunks = [];
    const largeFindings: IncomingFindingInput[] = [];

    for (let i = 1; i <= 100; i++) {
      largeHunks.push({
        filePath: `src/module_${i}.ts`,
        oldStart: 1,
        oldLines: 20,
        newStart: 1,
        newLines: 20,
        hunkContent: `+ // Module ${i} code\n+ const val = ${i};`,
      });

      largeFindings.push({
        filePath: `src/module_${i}.ts`,
        startLine: 5,
        endLine: 10,
        persona: i % 2 === 0 ? 'security' : 'quality',
        severity: i % 5 === 0 ? 'critical' : 'minor',
        comment: `Finding comment for module ${i}`,
        codeSnippet: `const val = ${i};`,
      });
    }

    const result = await manager.processPRCommitUpdate({
      repoOwner: 'owner',
      repoName: 'repo',
      prNumber: 50,
      headSha: 'sha-large-1',
      baseSha: 'sha-base',
      hunks: largeHunks,
      quorumFindings: largeFindings,
    });

    expect(result.hunksToReview).toHaveLength(100);
    expect(result.activeFindings).toHaveLength(100);
    expect(result.currentState.findings).toHaveLength(100);

    // Verify storage lookup retrieves all 100 findings
    const storedFindings = await storage.getFindings('owner', 'repo', 50);
    expect(storedFindings).toHaveLength(100);

    await storage.close();
  });
});
