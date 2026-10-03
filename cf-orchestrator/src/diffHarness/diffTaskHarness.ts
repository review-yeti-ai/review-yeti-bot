/**
 * diffTaskHarness.ts
 *
 * Concurrent DeepSeek-Style Diff Task Harness.
 * - Allocates tasks dynamically by risk and size tiers:
 *   - High-risk / large files get singular dedicated tasks with deep Zoekt context headroom.
 *   - Medium-risk files get grouped into module clusters.
 *   - Simple/low-risk files (echo true, typo fixes, lockfiles) get lumped together into composite batch tasks.
 * - ZERO files bypassed: every diff is evaluated by the agent.
 * - On-demand grounding: invokes Zoekt symbol lookups only when needed.
 * - Sliding context compactor: shrinks and evicts raw diffs and thoughts after each task completes.
 */

import { partitionDiffTasks, type RawFileDiff, type DiffTask, type TriagedFileDiff } from './diffTriage.js';
import { ActiveChangesLedger, type DiffKnowledgeSnippet } from './activeChangesLedger.js';

export interface GroundingToolContext {
  zoektLookup?: (query: string) => Promise<string[]>;
  grepFile?: (path: string, pattern: string) => Promise<string[]>;
}

export interface TaskLLMEvaluator {
  evaluateTask(
    task: DiffTask,
    activeKnowledgeContext: string,
    grounding: GroundingToolContext
  ): Promise<DiffKnowledgeSnippet[]>;
}

export interface HarnessExecutionResult {
  runId: string;
  totalFiles: number;
  singularTasksCount: number;
  clusterTasksCount: number;
  lumpedTasksCount: number;
  tasksExecuted: number;
  verdict: 'success' | 'action_required' | 'neutral';
  findingFingerprints: string[];
  durationMs: number;
  tokensUsed: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  compactLedgerMarkdown: string;
}

/**
 * Executes review across PR diffs using the tiered Task Harness and Sliding Context Ledger.
 */
export async function runDiffTaskHarness(options: {
  runId: string;
  diffs: RawFileDiff[];
  concurrency?: number;
  evaluator: TaskLLMEvaluator;
  grounding?: GroundingToolContext;
}): Promise<HarnessExecutionResult> {
  const startedAt = Date.now();
  const { runId, diffs, concurrency = 5, evaluator, grounding = {} } = options;

  // 1. Partition Diffs into Risk and Size Tiered Tasks
  const { tasks, triagedFiles } = partitionDiffTasks(diffs);
  const ledger = new ActiveChangesLedger();

  let promptTokens = 0;
  let completionTokens = 0;

  let singularTasksCount = 0;
  let clusterTasksCount = 0;
  let lumpedTasksCount = 0;

  for (const t of tasks) {
    if (t.taskType === 'singular_deep') singularTasksCount++;
    else if (t.taskType === 'module_cluster') clusterTasksCount++;
    else if (t.taskType === 'lumped_simple') lumpedTasksCount++;
  }

  // 2. Concurrency-Bounded Execution of Diff Tasks
  // Each task receives only the current trim ActiveChangesLedger context,
  // investigates its assigned diffs, invokes grounding tools on-demand,
  // and yields compacted knowledge snippets.
  const executingQueue = [...tasks];
  const maxWorkers = Math.max(1, Math.min(concurrency, tasks.length || 1));

  async function workerLoop(): Promise<void> {
    while (executingQueue.length > 0) {
      const task = executingQueue.shift();
      if (!task) break;

      // Provide only the current trim sliding context (NOT the full dump of other files)
      const currentKnowledge = ledger.toTrimContextPrompt();

      // Estimate tokens for this task execution
      promptTokens += task.totalTokens + Math.ceil(currentKnowledge.length / 4);

      const snippets = await evaluator.evaluateTask(task, currentKnowledge, grounding);

      // 3. Context Shrinking: Compact and record each file result, discarding raw diff history
      for (const snippet of snippets) {
        ledger.recordDiffKnowledge(snippet);
        completionTokens += 60; // Average compacted snippet tokens
      }
    }
  }

  const workers = Array.from({ length: maxWorkers }, () => workerLoop());
  await Promise.all(workers);

  const durationMs = Date.now() - startedAt;
  const snapshot = ledger.getSnapshot();
  const verdict = ledger.getOverallVerdict();

  return {
    runId,
    totalFiles: triagedFiles.length,
    singularTasksCount,
    clusterTasksCount,
    lumpedTasksCount,
    tasksExecuted: tasks.length,
    verdict,
    findingFingerprints: snapshot.accumulatedFindings,
    durationMs,
    tokensUsed: {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    },
    compactLedgerMarkdown: ledger.toTrimContextPrompt(),
  };
}
