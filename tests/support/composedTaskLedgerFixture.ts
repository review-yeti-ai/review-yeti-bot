import type { ReviewChangedFile } from '../../src/review/reviewCore';

/** Synthetic, zero-provider evidence; these are not deployed provenance receipts. */
export function ledgerFixture(repositoryId = 1_800_000_001, runId = `run_${'a'.repeat(32)}`) {
  const receivedAt = new Date().toISOString();
  const terminalDeadline = new Date(Date.now() + 120_000).toISOString();
  const identity = {
    runId, repositoryId, owner: 'calltelemetry', repo: 'fixture', prNumber: 42,
    headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40),
    configDigest: 'c'.repeat(64), policyDigest: 'd'.repeat(64), snapshotDigest: 'e'.repeat(64),
    reviewGeneration: 0, executionAttempt: 1, attemptId: `${runId}-g0-e1`, expectedAppId: 4385771,
    receivedAt, terminalDeadline, semanticDiffDigest: 'f'.repeat(64), coverageDigest: '1'.repeat(64),
    policySources: [{ repositoryId: 17, repository: 'calltelemetry/ct-meta',
      sha: '2'.repeat(40), path: 'policy/review-yeti.json', contentDigest: '3'.repeat(64) }],
    engine: { contract: 'ComposedTaskLedger.v1' as const, sourceSha: '4'.repeat(40),
      imageDigest: `sha256:${'5'.repeat(64)}`, buildManifestDigest: '6'.repeat(64) },
  };
  const changedFiles: ReviewChangedFile[] = [
    { path: 'src/fixture.ts', patch: '@@ -1 +1 @@\n-before\n+after' },
    { path: 'src/auth.ts', patch: '@@ -1 +1 @@\n-before\n+after' },
  ];
  const tasks = [
    { id: 'test-shape', dimension: 'testing' as const, paths: ['src/fixture.ts'],
      question: 'Check test contracts', rationale: 'Changed behavior requires proof' },
    { id: 'security', dimension: 'security' as const, paths: ['src/auth.ts'],
      question: 'Check authority', rationale: 'Preserve authentication' },
  ];
  const usage = { turnsUsed: 2, physicalCalls: null, correctionAttempts: 0, toolTurns: 1,
    promptTokens: 100, completionTokens: 20, totalTokens: 120, cachedTokens: 0,
    durationMs: 75, costUSD: null };
  const diagnostics = { reason: 'non_json_task_result' as const, turnsUsed: 2,
    correctionAttempts: 0, toolTurns: 1, finishReason: 'length' as const, lastToolOutcome: 'returned' as const };
  const finding = { severity: 'P2' as const, path: 'src/fixture.ts', line: 1,
    title: 'A real defect', body: 'The changed branch loses the receipt.' };
  return { trusted: { identity, changedFiles }, tasks, usage, diagnostics, finding,
    proof: { workerTokenDigest: '7'.repeat(64) } };
}
