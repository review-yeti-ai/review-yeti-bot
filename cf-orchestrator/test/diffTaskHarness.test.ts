import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSimplePatch,
  triageFileDiff,
  partitionDiffTasks,
  type RawFileDiff,
} from '../src/diffHarness/diffTriage.js';
import { ActiveChangesLedger } from '../src/diffHarness/activeChangesLedger.js';
import { runDiffTaskHarness, type TaskLLMEvaluator } from '../src/diffHarness/diffTaskHarness.js';

describe('Diff Task Harness & Context Compaction', () => {
  describe('Risk & Size Tiered Task Partitioning (diffTriage.ts)', () => {
    it('detects simple one-liners like "echo true", comment updates, and version bumps', () => {
      assert.equal(isSimplePatch('@@ -1,1 +1,2 @@\n+echo true\n'), true);
      assert.equal(isSimplePatch('@@ -1,1 +1,2 @@\n+console.log("hello");\n'), true);
      assert.equal(isSimplePatch('@@ -1,1 +1,2 @@\n+// Fix typo in docstring\n'), true);
      assert.equal(isSimplePatch('@@ -1,1 +1,2 @@\n+version = "1.0.1"\n'), true);

      // Complex multiline code is NOT simple
      assert.equal(
        isSimplePatch('@@ -1,10 +1,25 @@\n+function auth() {\n+  if (secret) return true;\n+  return false;\n+}'),
        false
      );
    });

    it('triages files into high, medium, and low risk tiers based on patterns and line size', () => {
      // High-risk: security pattern
      const authDiff = triageFileDiff({
        filename: 'src/auth/tokenValidator.ts',
        patch: '+export function verifyToken() {}',
        additions: 10,
        deletions: 2,
        status: 'modified',
      });
      assert.equal(authDiff.risk, 'high');

      // High-risk: large file (>150 lines changed)
      const largeDiff = triageFileDiff({
        filename: 'src/components/table.tsx',
        patch: '+ large refactor...',
        additions: 120,
        deletions: 50,
        status: 'modified',
      });
      assert.equal(largeDiff.risk, 'high');
      assert.equal(largeDiff.sizeTier, 'large');

      // Low-risk: simple one-liner "echo true"
      const simpleScriptDiff = triageFileDiff({
        filename: 'scripts/verify.sh',
        patch: '+echo true',
        additions: 1,
        deletions: 0,
        status: 'modified',
      });
      assert.equal(simpleScriptDiff.risk, 'low');
      assert.equal(simpleScriptDiff.isSimple, true);

      // Low-risk: package-lock.json
      const lockDiff = triageFileDiff({
        filename: 'package-lock.json',
        patch: '+hash updates',
        additions: 20,
        deletions: 20,
        status: 'modified',
      });
      assert.equal(lockDiff.risk, 'low');
      assert.equal(lockDiff.category, 'lockfile');
    });

    it('allocates singular dedicated tasks for high-risk files and lumps simple ones together', () => {
      const diffs: RawFileDiff[] = [
        // 1. High risk / large file -> Must get singular task
        {
          filename: 'src/auth/sessionManager.ts',
          patch: '+export class SessionManager { verify() {} }',
          additions: 80,
          deletions: 10,
          status: 'modified',
        },
        // 2. High risk / large file -> Must get singular task
        {
          filename: 'src/billing/stripeHandler.ts',
          patch: '+export function processPayment() {}',
          additions: 60,
          deletions: 5,
          status: 'modified',
        },
        // 3. Medium risk files -> Module cluster
        {
          filename: 'src/routes/users.ts',
          patch: '+export function getUser() {}',
          additions: 35,
          deletions: 5,
          status: 'modified',
        },
        {
          filename: 'src/routes/posts.ts',
          patch: '+export function getPosts() {}',
          additions: 30,
          deletions: 2,
          status: 'modified',
        },
        // 4. Low risk / simple files -> Must be lumped together in ONE composite task
        {
          filename: 'scripts/build.sh',
          patch: '+echo true',
          additions: 1,
          deletions: 0,
          status: 'modified',
        },
        {
          filename: 'package-lock.json',
          patch: '+lockfile bump',
          additions: 5,
          deletions: 5,
          status: 'modified',
        },
        {
          filename: 'docs/readme.md',
          patch: '+// updated docs',
          additions: 2,
          deletions: 0,
          status: 'modified',
        },
      ];

      const { tasks, triagedFiles } = partitionDiffTasks(diffs);

      // Verify all 7 files are accounted for (ZERO bypassed)
      assert.equal(triagedFiles.length, 7);

      // Verify high-risk files got singular tasks
      const singularTasks = tasks.filter((t) => t.taskType === 'singular_deep');
      assert.equal(singularTasks.length, 2);
      assert.ok(singularTasks.some((t) => t.files[0].filename === 'src/auth/sessionManager.ts'));
      assert.ok(singularTasks.some((t) => t.files[0].filename === 'src/billing/stripeHandler.ts'));
      assert.equal(singularTasks[0].requiresDeepInspection, true);

      // Verify medium-risk files got clustered
      const clusterTasks = tasks.filter((t) => t.taskType === 'module_cluster');
      assert.equal(clusterTasks.length, 1);
      assert.equal(clusterTasks[0].files.length, 2);

      // Verify simple files (echo true, lockfile, docs) got lumped together into 1 task
      const lumpedTasks = tasks.filter((t) => t.taskType === 'lumped_simple');
      assert.equal(lumpedTasks.length, 1);
      assert.equal(lumpedTasks[0].files.length, 3);
      assert.ok(lumpedTasks[0].files.some((f) => f.filename === 'scripts/build.sh'));
      assert.ok(lumpedTasks[0].files.some((f) => f.filename === 'package-lock.json'));
      assert.ok(lumpedTasks[0].files.some((f) => f.filename === 'docs/readme.md'));

      // Verify thinking effort dynamically tiered across task types (low, medium, high, max)
      const authTask = singularTasks.find((t) => t.files[0].filename.includes('auth'))!;
      const stripeTask = singularTasks.find((t) => t.files[0].filename.includes('stripe'))!;
      assert.equal(authTask.thinkingEffort, 'max', 'Mission critical auth task must receive max thinking effort');
      assert.equal(stripeTask.thinkingEffort, 'high', 'Standard high-risk task must receive high thinking effort');
      assert.equal(clusterTasks[0].thinkingEffort, 'medium', 'Module cluster must receive medium thinking effort');
      assert.equal(lumpedTasks[0].thinkingEffort, 'low', 'Lumped simple batch must receive low thinking effort');
    });

    it('flexes thinking effort based on risk: low for mechanical/simple, medium for module clusters, max for critical security', () => {
      const { tasks } = partitionDiffTasks([
        {
          filename: 'src/crypto/fencing.ts',
          patch: '+export function fenceEpoch() {}',
          additions: 100,
          deletions: 5,
          status: 'modified',
        },
        {
          filename: 'src/utils/helpers.ts',
          patch: '+export function formatName() {}',
          additions: 20,
          deletions: 2,
          status: 'modified',
        },
        {
          filename: 'README.md',
          patch: '+# Updated title',
          additions: 1,
          deletions: 1,
          status: 'modified',
        },
      ]);

      const maxTask = tasks.find((t) => t.taskType === 'singular_deep')!;
      const medTask = tasks.find((t) => t.taskType === 'module_cluster')!;
      const lowTask = tasks.find((t) => t.taskType === 'lumped_simple')!;

      assert.equal(maxTask.thinkingEffort, 'max');
      assert.equal(medTask.thinkingEffort, 'medium');
      assert.equal(lowTask.thinkingEffort, 'low');
    });
  });



  describe('Active Changes Ledger & Sliding Context Compaction', () => {
    it('compacts raw diff findings into a trim knowledge snippet (< 100 tokens)', () => {
      const ledger = new ActiveChangesLedger();
      ledger.recordDiffKnowledge({
        filename: 'src/auth/jwt.ts',
        verdict: 'approved',
        summary: 'Added RS256 token verification and clock skew tolerance',
        symbolsModified: ['verifyToken', 'validateClaims'],
        breakingRisks: ['Requires JWT_PUBLIC_KEY in environment'],
        findingFingerprints: ['src/auth/jwt.ts:25:sec-rule-1:warning'],
      });

      const trimContext = ledger.toTrimContextPrompt();
      assert.ok(trimContext.includes('src/auth/jwt.ts'));
      assert.ok(trimContext.includes('verifyToken, validateClaims'));
      assert.ok(trimContext.includes('Requires JWT_PUBLIC_KEY'));

      // Verify context is ultra-compact (< 300 characters / ~75 tokens)
      assert.ok(trimContext.length < 300);

      const snapshot = ledger.getSnapshot();
      assert.equal(snapshot.totalDiffsEvaluated, 1);
      assert.equal(snapshot.accumulatedFindings.length, 1);
      assert.equal(ledger.getOverallVerdict(), 'success');
    });

    it('aggregates overall action_required verdict when any diff flags an issue', () => {
      const ledger = new ActiveChangesLedger();
      ledger.recordDiffKnowledge({
        filename: 'src/api/routes.ts',
        verdict: 'approved',
        summary: 'Added health check route',
        symbolsModified: ['healthCheck'],
        breakingRisks: [],
        findingFingerprints: [],
      });
      ledger.recordDiffKnowledge({
        filename: 'src/billing/charge.ts',
        verdict: 'action_required',
        summary: 'Missing idempotency key on charge customer request',
        symbolsModified: ['createCharge'],
        breakingRisks: ['Duplicate billing on timeout'],
        securityNotes: 'High severity double-charge risk',
        findingFingerprints: ['src/billing/charge.ts:40:billing-double-charge:error'],
      });

      assert.equal(ledger.getOverallVerdict(), 'action_required');
      const trimContext = ledger.toTrimContextPrompt();
      assert.ok(trimContext.includes('⚠️ [src/billing/charge.ts] High severity double-charge risk'));
    });
  });

  describe('Concurrent Tiered Diff Task Harness Execution', () => {
    it('executes singular deep tasks and lumped simple tasks concurrently with Zoekt grounding', async () => {
      const diffs: RawFileDiff[] = [
        // High-risk: Singular deep task
        { filename: 'src/auth/login.ts', patch: '+export function login() { checkPassword(); }', additions: 50, deletions: 5, status: 'modified' },
        // Simple diffs: Lumped together into 1 composite task
        { filename: 'scripts/verify.sh', patch: '+echo true', additions: 1, deletions: 0, status: 'modified' },
        { filename: 'package-lock.json', patch: '+lockfile updates', additions: 10, deletions: 10, status: 'modified' },
      ];

      const zoektCalls: string[] = [];
      const mockGrounding = {
        zoektLookup: async (query: string) => {
          zoektCalls.push(query);
          return ['src/auth/session.ts:export interface Session'];
        },
      };

      const evaluatedTasks: string[] = [];

      const mockEvaluator: TaskLLMEvaluator = {
        async evaluateTask(task, activeKnowledge, grounding) {
          evaluatedTasks.push(task.taskType);

          // If singular deep task, invoke Zoekt symbol lookup
          if (task.taskType === 'singular_deep' && grounding.zoektLookup) {
            await grounding.zoektLookup('checkPassword');
          }

          // Return snippets for all files in this task
          return task.files.map((f) => ({
            filename: f.filename,
            verdict: 'approved',
            summary: `Reviewed ${f.filename} (Task: ${task.taskType})`,
            symbolsModified: [f.filename.split('/').pop()?.replace('.ts', '') || 'symbol'],
            breakingRisks: [],
            findingFingerprints: [],
          }));
        },
      };

      const result = await runDiffTaskHarness({
        runId: 'test_run_tiered_456',
        diffs,
        concurrency: 3,
        evaluator: mockEvaluator,
        grounding: mockGrounding,
      });

      assert.equal(result.totalFiles, 3);
      assert.equal(result.singularTasksCount, 1);
      assert.equal(result.lumpedTasksCount, 1);
      assert.equal(result.tasksExecuted, 2); // 1 singular task + 1 lumped task reviewing 2 files
      assert.equal(result.verdict, 'success');

      // Verify Zoekt was called for the singular deep auth task
      assert.equal(zoektCalls.length, 1);
      assert.equal(zoektCalls[0], 'checkPassword');

      // Verify all 3 files are present in the final compacted markdown
      assert.ok(result.compactLedgerMarkdown.includes('src/auth/login.ts'));
      assert.ok(result.compactLedgerMarkdown.includes('scripts/verify.sh'));
      assert.ok(result.compactLedgerMarkdown.includes('package-lock.json'));
    });
  });
});
