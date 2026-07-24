import { computeFindingHash, computeHunkHash, normalizeSnippet, normalizeComment } from '../../src/utils/diffHash';
import { SqliteDiffStateStorage, JsonFileDiffStateStorage, createDiffStateStorage } from '../../src/persistence/db';
import { DiffStateManager } from '../../src/persistence/diffStateManager';
import fs from 'fs';
import path from 'path';

async function runEmpiricalStressTests() {
  console.log('=== EMPIRICAL STRESS TEST HARNESS (CHALLENGER 2) ===\n');
  const results: { test: string; pass: boolean; details: string }[] = [];

  const tmpDir = path.join(__dirname, 'tmp_empirical');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const sqliteDbPath = path.join(tmpDir, 'test.db');
  const jsonDbPath = path.join(tmpDir, 'test.json');

  const cleanup = () => {
    if (fs.existsSync(sqliteDbPath)) fs.unlinkSync(sqliteDbPath);
    if (fs.existsSync(jsonDbPath)) fs.unlinkSync(jsonDbPath);
  };

  // -------------------------------------------------------------
  // TEST 1: Deletion Hunk Range Overlap Bug (newLines = 0)
  // -------------------------------------------------------------
  try {
    cleanup();
    const storage = new JsonFileDiffStateStorage(jsonDbPath);
    await storage.init();
    const manager = new DiffStateManager(storage);

    // Commit 1: Finding on line 12 inside lines 10..14
    await manager.processPRCommitUpdate({
      repoOwner: 'test',
      repoName: 'repo',
      prNumber: 1,
      headSha: 'commit1',
      baseSha: 'base',
      hunks: [{
        filePath: 'src/app.ts',
        oldStart: 1, oldLines: 20, newStart: 1, newLines: 20, hunkContent: 'lines 1 to 20',
      }],
      quorumFindings: [{
        filePath: 'src/app.ts',
        startLine: 12, endLine: 12, persona: 'security', severity: 'critical',
        comment: 'Vulnerability on line 12', codeSnippet: 'vulnerableCall()',
      }],
    });

    // Commit 2: Lines 10..14 DELETED (newLines = 0)
    const c2 = await manager.processPRCommitUpdate({
      repoOwner: 'test',
      repoName: 'repo',
      prNumber: 1,
      headSha: 'commit2',
      baseSha: 'base',
      hunks: [{
        filePath: 'src/app.ts',
        oldStart: 10, oldLines: 5, newStart: 10, newLines: 0, hunkContent: '-vulnerableCall()',
      }],
      quorumFindings: [],
    });

    const finding = c2.currentState.findings.find(f => f.comment === 'Vulnerability on line 12');
    if (finding && finding.status === 'RESOLVED') {
      results.push({
        test: '1. Deletion Hunk Overlap Detection (newLines = 0)',
        pass: true,
        details: `Finding was correctly RESOLVED when lines 10..14 were deleted.`,
      });
    } else {
      results.push({
        test: '1. Deletion Hunk Overlap Detection (newLines = 0)',
        pass: false,
        details: `BUG DETECTED: Finding status is '${finding?.status}' instead of 'RESOLVED' because newLines=0 caused hEnd to evaluate to 10 instead of covering line 12!`,
      });
    }
  } catch (err: any) {
    results.push({
      test: '1. Deletion Hunk Overlap Detection (newLines = 0)',
      pass: false,
      details: `Exception: ${err.message}`,
    });
  }

  // -------------------------------------------------------------
  // TEST 2: Line-Shifted Finding Fingerprint Hash Resiliency
  // -------------------------------------------------------------
  try {
    const f1 = {
      filePath: 'src/auth.ts', startLine: 10, endLine: 10, persona: 'security',
      severity: 'critical' as const, codeSnippet: 'const pass = req.body.password;', comment: 'Plaintext password access',
    };
    const f2 = {
      filePath: 'src/auth.ts', startLine: 25, endLine: 25, persona: 'security',
      severity: 'critical' as const, codeSnippet: 'const pass = req.body.password;', comment: 'Plaintext password access',
    };

    const hash1 = computeFindingHash(f1);
    const hash2 = computeFindingHash(f2);

    if (hash1 === hash2) {
      results.push({
        test: '2. Line-Shifted Finding Fingerprint Resiliency',
        pass: true,
        details: `Hashes match (${hash1.slice(0, 8)}...) across line shift from line 10 to line 25.`,
      });
    } else {
      results.push({
        test: '2. Line-Shifted Finding Fingerprint Resiliency',
        pass: false,
        details: `BUG DETECTED: Fingerprint hash includes line numbers ('10-10' vs '25-25'). Hash1=${hash1.slice(0, 8)}, Hash2=${hash2.slice(0, 8)}. Line shifts cause duplicate findings!`,
      });
    }
  } catch (err: any) {
    results.push({
      test: '2. Line-Shifted Finding Fingerprint Resiliency',
      pass: false,
      details: `Exception: ${err.message}`,
    });
  }

  // -------------------------------------------------------------
  // TEST 3: SQLite updateFindingStatus Re-Opening Finding resolvedAtCommit Bug
  // -------------------------------------------------------------
  try {
    cleanup();
    const sqliteStorage = new SqliteDiffStateStorage(sqliteDbPath);
    await sqliteStorage.init();

    await sqliteStorage.savePRState({
      repoOwner: 'acme', repoName: 'app', prNumber: 50, headSha: 'c1', baseSha: 'base',
      updatedAt: new Date().toISOString(), hunks: [],
      findings: [{
        fingerprintHash: 'hash_test', filePath: 'src/main.ts', startLine: 1, endLine: 1,
        persona: 'sec', severity: 'critical', comment: 'eval used', status: 'RESOLVED',
        firstSeenCommit: 'c1', lastSeenCommit: 'c1', resolvedAtCommit: 'c1',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      }]
    });

    // Reopen finding to IDENTIFIED via updateFindingStatus
    await sqliteStorage.updateFindingStatus('acme', 'app', 50, 'hash_test', 'IDENTIFIED', 'c2');
    const findings = await sqliteStorage.getFindings('acme', 'app', 50);

    await sqliteStorage.close();

    if (findings[0].status === 'IDENTIFIED' && findings[0].resolvedAtCommit === null) {
      results.push({
        test: '3. SQLite updateFindingStatus Re-Open Clears resolvedAtCommit',
        pass: true,
        details: `resolvedAtCommit was correctly cleared to null when status changed to IDENTIFIED.`,
      });
    } else {
      results.push({
        test: '3. SQLite updateFindingStatus Re-Open Clears resolvedAtCommit',
        pass: false,
        details: `BUG DETECTED: SQLite COALESCE retained old resolvedAtCommit='${findings[0].resolvedAtCommit}' when finding was re-opened to IDENTIFIED!`,
      });
    }
  } catch (err: any) {
    results.push({
      test: '3. SQLite updateFindingStatus Re-Open Clears resolvedAtCommit',
      pass: false,
      details: `Exception: ${err.message}`,
    });
  }

  // -------------------------------------------------------------
  // TEST 4: SQLite Storage CRUD & Prepared Statements
  // -------------------------------------------------------------
  try {
    cleanup();
    const sqliteStorage = new SqliteDiffStateStorage(sqliteDbPath);
    await sqliteStorage.init();

    await sqliteStorage.savePRState({
      repoOwner: 'acme', repoName: 'widget', prNumber: 100, headSha: 'sha100', baseSha: 'base',
      updatedAt: new Date().toISOString(),
      hunks: [{
        filePath: 'src/main.ts', hunkHash: 'h1', oldStart: 1, oldLines: 5, newStart: 1, newLines: 5,
        commitSha: 'sha100', createdAt: new Date().toISOString()
      }],
      findings: [{
        fingerprintHash: 'f1', filePath: 'src/main.ts', startLine: 2, endLine: 2,
        persona: 'quality', severity: 'minor', comment: 'Fix formatting', status: 'IDENTIFIED',
        firstSeenCommit: 'sha100', lastSeenCommit: 'sha100', resolvedAtCommit: null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      }]
    });

    const read1 = await sqliteStorage.getPRState('acme', 'widget', 100);
    const hasData = read1?.hunks.length === 1 && read1?.findings.length === 1;

    await sqliteStorage.close();

    if (hasData) {
      results.push({
        test: '4. SQLite Storage CRUD & Prepared Statements',
        pass: true,
        details: `Successfully inserted and retrieved PR state via SQLite engine.`,
      });
    } else {
      results.push({
        test: '4. SQLite Storage CRUD & Prepared Statements',
        pass: false,
        details: `Failed to retrieve correct PR state data from SQLite.`,
      });
    }
  } catch (err: any) {
    results.push({
      test: '4. SQLite Storage CRUD & Prepared Statements',
      pass: false,
      details: `SQLite test failed: ${err.message}`,
    });
  }

  // -------------------------------------------------------------
  // TEST 5: Atomic JSON Disk Fallback Concurrent Writes
  // -------------------------------------------------------------
  try {
    cleanup();
    const jsonStorage = new JsonFileDiffStateStorage(jsonDbPath);
    await jsonStorage.init();

    await Promise.all([
      jsonStorage.savePRState({ repoOwner: 'org', repoName: 'repo', prNumber: 1, headSha: 's1', baseSha: 'b', updatedAt: new Date().toISOString(), hunks: [], findings: [] }),
      jsonStorage.savePRState({ repoOwner: 'org', repoName: 'repo', prNumber: 2, headSha: 's2', baseSha: 'b', updatedAt: new Date().toISOString(), hunks: [], findings: [] }),
      jsonStorage.savePRState({ repoOwner: 'org', repoName: 'repo', prNumber: 3, headSha: 's3', baseSha: 'b', updatedAt: new Date().toISOString(), hunks: [], findings: [] })
    ]);

    const pr1 = await jsonStorage.getPRState('org', 'repo', 1);
    const pr2 = await jsonStorage.getPRState('org', 'repo', 2);
    const pr3 = await jsonStorage.getPRState('org', 'repo', 3);

    await jsonStorage.close();

    if (pr1 && pr2 && pr3) {
      results.push({
        test: '5. Atomic JSON Disk Fallback Concurrent Writes',
        pass: true,
        details: `All 3 concurrent JSON writes persisted cleanly to disk without corruption.`,
      });
    } else {
      results.push({
        test: '5. Atomic JSON Disk Fallback Concurrent Writes',
        pass: false,
        details: `JSON file state missing keys after concurrent writes: pr1=${!!pr1}, pr2=${!!pr2}, pr3=${!!pr3}`,
      });
    }
  } catch (err: any) {
    results.push({
      test: '5. Atomic JSON Disk Fallback Concurrent Writes',
      pass: false,
      details: `JSON storage test failed: ${err.message}`,
    });
  }

  // Print results summary
  console.log('\n--- EMPIRICAL TEST RESULTS ---');
  let overallPass = true;
  for (const r of results) {
    const statusStr = r.pass ? '✅ PASS' : '❌ FAIL';
    console.log(`${statusStr} | ${r.test}`);
    console.log(`   Details: ${r.details}\n`);
    if (!r.pass) overallPass = false;
  }

  console.log(`OVERALL VERDICT: ${overallPass ? 'PASS' : 'FAIL'}`);
  cleanup();
  if (fs.existsSync(tmpDir)) fs.rmdirSync(tmpDir, { recursive: true });
}

runEmpiricalStressTests().catch(err => {
  console.error('Test runner fatal error:', err);
  process.exit(1);
});
