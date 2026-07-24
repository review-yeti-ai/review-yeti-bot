import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import { setupE2ETestHarness, E2ETestHarness } from '@harness/e2eTestRunner';
import { E2EAssertions } from '@harness/assertions';
import { computeHunkHash, computeFindingHash, normalizeSnippet, normalizeComment } from '@src/utils/diffHash';
import { createDiffStateStorage, IDiffStateStorage } from '@src/persistence/db';
import { DiffStateManager } from '@src/persistence/diffStateManager';

describe('Tier 1 Feature Coverage: Diff State Persistence & Hunk Hashing Engine', () => {
  let harness: E2ETestHarness;
  let tmpStorage: IDiffStateStorage;
  let tmpStateManager: DiffStateManager;
  let tmpJsonPath: string;

  beforeAll(async () => {
    harness = await setupE2ETestHarness({
      testRunId: 'tier1-diffstate-suite',
    });
    tmpJsonPath = path.join(harness.ctx.stateDir, 'diffstate_test.json');
    tmpStorage = await createDiffStateStorage(':memory:', tmpJsonPath);
    tmpStateManager = new DiffStateManager(tmpStorage);
  });

  afterAll(async () => {
    if (tmpStorage) {
      await tmpStorage.close();
    }
    await harness.teardown();
  });

  test('1. Computes deterministic SHA-256 hashes for diff hunks and review findings', () => {
    const hunk1 = {
      filePath: 'src/auth/login.ts',
      oldStart: 10,
      oldLines: 3,
      newStart: 10,
      newLines: 5,
      hunkContent: '  const user = await db.findUser(req.body.id);\r\n+  const key = "SECRET";\n',
    };

    const hunk2 = {
      filePath: 'src/auth/login.ts',
      oldStart: 10,
      oldLines: 3,
      newStart: 10,
      newLines: 5,
      hunkContent: '  const user = await db.findUser(req.body.id);\n+  const key = "SECRET";\n',
    };

    const hash1 = computeHunkHash(hunk1);
    const hash2 = computeHunkHash(hunk2);

    expect(hash1).toMatch(/^[a-f0-9]{64}$/);
    expect(hash1).toBe(hash2); // Normalization handles \r\n vs \n

    const findingInput = {
      filePath: 'src/auth/login.ts',
      persona: 'security',
      severity: 'critical' as const,
      codeSnippet: 'const key = "SECRET";\r\n',
      comment: 'Hardcoded secret detected!',
      ruleId: 'SEC-NO-SECRET',
    };

    const findingHash = computeFindingHash(findingInput);
    expect(findingHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test('2. Initial commit finding identification sets previousState to null and tracks new findings', async () => {
    const prCommit1 = {
      repoOwner: 'calltelemetry',
      repoName: 'ai-workspace',
      prNumber: 501,
      headSha: 'commit-sha-1111',
      baseSha: 'commit-sha-0000',
      hunks: [
        {
          filePath: 'src/payment.ts',
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 4,
          hunkContent: '+ const card = req.body.cardNumber;\n+ eval(card);',
        },
      ],
      quorumFindings: [
        {
          filePath: 'src/payment.ts',
          startLine: 2,
          endLine: 2,
          persona: 'security',
          severity: 'critical' as const,
          comment: 'Forbidden eval execution on credit card payload',
          codeSnippet: 'eval(card);',
          ruleId: 'SEC-NO-EVAL',
        },
      ],
    };

    const result = await tmpStateManager.processPRCommitUpdate(prCommit1);

    expect(result.previousState).toBeNull();
    expect(result.hunksToReview).toHaveLength(1);
    expect(result.activeFindings).toHaveLength(1);
    expect(result.activeFindings[0].status).toBe('IDENTIFIED');
    expect(result.activeFindings[0].firstSeenCommit).toBe(prCommit1.headSha);
    expect(result.resolvedFindings).toHaveLength(0);
  });

  test('3. Subsequent commit delta calculation marks resolved findings and tracks commit transitions', async () => {
    const prNumber = 501;

    // Ensure prerequisite commit 1 state exists
    const existingState = await tmpStorage.getPRState('calltelemetry', 'ai-workspace', prNumber);
    if (!existingState) {
      await tmpStateManager.processPRCommitUpdate({
        repoOwner: 'calltelemetry',
        repoName: 'ai-workspace',
        prNumber,
        headSha: 'commit-sha-1111',
        baseSha: 'commit-sha-0000',
        hunks: [
          {
            filePath: 'src/payment.ts',
            oldStart: 1,
            oldLines: 2,
            newStart: 1,
            newLines: 4,
            hunkContent: '+ const card = req.body.cardNumber;\n+ eval(card);',
          },
        ],
        quorumFindings: [
          {
            filePath: 'src/payment.ts',
            startLine: 2,
            endLine: 2,
            persona: 'security',
            severity: 'critical' as const,
            comment: 'Forbidden eval execution on credit card payload',
            codeSnippet: 'eval(card);',
            ruleId: 'SEC-NO-EVAL',
          },
        ],
      });
    }

    // Commit 2: Developer fixes the eval finding
    const prCommit2 = {
      repoOwner: 'calltelemetry',
      repoName: 'ai-workspace',
      prNumber,
      headSha: 'commit-sha-2222',
      baseSha: 'commit-sha-0000',
      hunks: [
        {
          filePath: 'src/payment.ts',
          oldStart: 1,
          oldLines: 4,
          newStart: 1,
          newLines: 4,
          hunkContent: '+ const card = sanitize(req.body.cardNumber);\n+ processCard(card);',
        },
      ],
      quorumFindings: [], // Finding resolved, no findings returned in pass
    };

    const result = await tmpStateManager.processPRCommitUpdate(prCommit2);

    expect(result.previousState).not.toBeNull();
    expect(result.previousState?.headSha).toBe('commit-sha-1111');
    expect(result.currentState.headSha).toBe('commit-sha-2222');

    expect(result.resolvedFindings).toHaveLength(1);
    expect(result.resolvedFindings[0].status).toBe('RESOLVED');
    expect(result.resolvedFindings[0].resolvedAtCommit).toBe('commit-sha-2222');
    expect(result.activeFindings).toHaveLength(0);
  });

  test('4. Resolved nit suppression prevents duplicate alerts for non-critical resolved findings', async () => {
    const prNumber = 601;

    // Commit 1: Minor code quality finding
    await tmpStateManager.processPRCommitUpdate({
      repoOwner: 'calltelemetry',
      repoName: 'ai-workspace',
      prNumber,
      headSha: 'sha-nit-1',
      baseSha: 'sha-base',
      hunks: [
        {
          filePath: 'src/utils.ts',
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 2,
          hunkContent: '+ console.log("debug");',
        },
      ],
      quorumFindings: [
        {
          filePath: 'src/utils.ts',
          startLine: 1,
          endLine: 1,
          persona: 'quality',
          severity: 'minor',
          comment: 'Avoid console.log in production code',
          codeSnippet: 'console.log("debug");',
          ruleId: 'QUAL-NO-CONSOLE',
        },
      ],
    });

    // Commit 2: Resolved
    await tmpStateManager.processPRCommitUpdate({
      repoOwner: 'calltelemetry',
      repoName: 'ai-workspace',
      prNumber,
      headSha: 'sha-nit-2',
      baseSha: 'sha-base',
      hunks: [
        {
          filePath: 'src/utils.ts',
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 1,
          hunkContent: '// removed console log',
        },
      ],
      quorumFindings: [],
    });

    // Commit 3: Duplicate minor finding arrives again
    const result3 = await tmpStateManager.processPRCommitUpdate({
      repoOwner: 'calltelemetry',
      repoName: 'ai-workspace',
      prNumber,
      headSha: 'sha-nit-3',
      baseSha: 'sha-base',
      hunks: [
        {
          filePath: 'src/utils.ts',
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 2,
          hunkContent: '+ console.log("debug");',
        },
      ],
      quorumFindings: [
        {
          filePath: 'src/utils.ts',
          startLine: 1,
          endLine: 1,
          persona: 'quality',
          severity: 'minor',
          comment: 'Avoid console.log in production code',
          codeSnippet: 'console.log("debug");',
          ruleId: 'QUAL-NO-CONSOLE',
        },
      ],
    });

    expect(result3.suppressedFindingHashes.length).toBe(1);
    const suppressedFinding = result3.currentState.findings.find(
      (f) => f.fingerprintHash === result3.suppressedFindingHashes[0]
    );
    expect(suppressedFinding?.status).toBe('SUPPRESSED');
  });

  test('5. Queries stored findings and PR state from state storage engine', async () => {
    let savedState = await tmpStorage.getPRState('calltelemetry', 'ai-workspace', 501);
    if (!savedState) {
      await tmpStateManager.processPRCommitUpdate({
        repoOwner: 'calltelemetry',
        repoName: 'ai-workspace',
        prNumber: 501,
        headSha: 'commit-sha-1111',
        baseSha: 'commit-sha-0000',
        hunks: [
          {
            filePath: 'src/payment.ts',
            oldStart: 1,
            oldLines: 2,
            newStart: 1,
            newLines: 4,
            hunkContent: '+ const card = req.body.cardNumber;\n+ eval(card);',
          },
        ],
        quorumFindings: [
          {
            filePath: 'src/payment.ts',
            startLine: 2,
            endLine: 2,
            persona: 'security',
            severity: 'critical' as const,
            comment: 'Forbidden eval execution on credit card payload',
            codeSnippet: 'eval(card);',
            ruleId: 'SEC-NO-EVAL',
          },
        ],
      });
      await tmpStateManager.processPRCommitUpdate({
        repoOwner: 'calltelemetry',
        repoName: 'ai-workspace',
        prNumber: 501,
        headSha: 'commit-sha-2222',
        baseSha: 'commit-sha-0000',
        hunks: [
          {
            filePath: 'src/payment.ts',
            oldStart: 1,
            oldLines: 4,
            newStart: 1,
            newLines: 4,
            hunkContent: '+ const card = sanitize(req.body.cardNumber);\n+ processCard(card);',
          },
        ],
        quorumFindings: [],
      });
      savedState = await tmpStorage.getPRState('calltelemetry', 'ai-workspace', 501);
    }

    expect(savedState).not.toBeNull();
    expect(savedState?.prNumber).toBe(501);
    expect(savedState?.headSha).toBe('commit-sha-2222');

    const findings = await tmpStorage.getFindings('calltelemetry', 'ai-workspace', 501);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].filePath).toBe('src/payment.ts');
  });

  test('6. Re-opens resolved critical findings if regression occurs in subsequent commit', async () => {
    const prNumber = 701;

    // Commit 1: Critical security vulnerability
    await tmpStateManager.processPRCommitUpdate({
      repoOwner: 'calltelemetry',
      repoName: 'ai-workspace',
      prNumber,
      headSha: 'sha-crit-1',
      baseSha: 'sha-base',
      hunks: [{ filePath: 'src/secret.ts', oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, hunkContent: '+ eval(raw);' }],
      quorumFindings: [
        {
          filePath: 'src/secret.ts',
          startLine: 1,
          endLine: 1,
          persona: 'security',
          severity: 'critical',
          comment: 'Critical security vulnerability: raw eval',
          codeSnippet: 'eval(raw);',
          ruleId: 'SEC-CRIT-EVAL',
        },
      ],
    });

    // Commit 2: Vulnerability resolved
    await tmpStateManager.processPRCommitUpdate({
      repoOwner: 'calltelemetry',
      repoName: 'ai-workspace',
      prNumber,
      headSha: 'sha-crit-2',
      baseSha: 'sha-base',
      hunks: [{ filePath: 'src/secret.ts', oldStart: 1, oldLines: 2, newStart: 1, newLines: 1, hunkContent: '// safe' }],
      quorumFindings: [],
    });

    // Commit 3: Regression occurs (critical finding returns)
    const result3 = await tmpStateManager.processPRCommitUpdate({
      repoOwner: 'calltelemetry',
      repoName: 'ai-workspace',
      prNumber,
      headSha: 'sha-crit-3',
      baseSha: 'sha-base',
      hunks: [{ filePath: 'src/secret.ts', oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, hunkContent: '+ eval(raw);' }],
      quorumFindings: [
        {
          filePath: 'src/secret.ts',
          startLine: 1,
          endLine: 1,
          persona: 'security',
          severity: 'critical',
          comment: 'Critical security vulnerability: raw eval',
          codeSnippet: 'eval(raw);',
          ruleId: 'SEC-CRIT-EVAL',
        },
      ],
    });

    expect(result3.activeFindings.length).toBe(1);
    expect(result3.activeFindings[0].status).toBe('IDENTIFIED');
    expect(result3.activeFindings[0].resolvedAtCommit).toBeNull();
    expect(result3.activeFindings[0].lastSeenCommit).toBe('sha-crit-3');
  });
});
