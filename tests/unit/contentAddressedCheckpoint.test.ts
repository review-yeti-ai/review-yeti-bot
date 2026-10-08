import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { executeComposedReview } from '../../src/panel/composedEngine';
import { parseAndValidateConfig } from '../../src/config/configLoader';
import { buildDeterministicCoverageManifest } from '../../src/review/groundedReviewEngine';
import {
  buildDeterministicReviewPlanningContext,
  enrichTasksWithPlanningContext,
  reviewTaskCharterDigest,
} from '../../src/review/prReviewPlanningContext';
import {
  TaskSourceDelivery,
  validateTaskSourceReceipt,
} from '../../src/review/taskSourceDelivery';
import type { ReviewTask } from '../../src/panel/reviewTask';
import type { ReviewExecutionCheckpoint } from '../../src/review/reviewExecutionCheckpoint';

// Distinct commit SHAs representing rebase / amend
const COMMIT_SHA_ORIGINAL = '1111111111111111111111111111111111111111';
const COMMIT_SHA_AMENDED  = '2222222222222222222222222222222222222222';
const BASE_SHA            = '0000000000000000000000000000000000000000';
const POLICY_DIGEST       = 'a'.repeat(64);
const CONFIG_DIGEST       = 'b'.repeat(64);

const FILE_MATH = {
  path: 'src/utils/math.ts',
  patch: '@@ -10,3 +10,3 @@ export function add(a: number, b: number) {\n-  return a - b;\n+  return a + b;\n }\n',
};

const FILE_AUTH_V1 = {
  path: 'src/auth/guard.ts',
  patch: '@@ -1,3 +1,3 @@\n-export const guard = false;\n+export const guard = true;\n',
};

const FILE_AUTH_V2 = {
  path: 'src/auth/guard.ts',
  patch: '@@ -1,4 +1,4 @@\n-export const guard = false;\n+export const guard = authenticateTenant();\n',
};

const PLAN_TASKS: ReviewTask[] = [
  {
    id: 'math-task',
    dimension: 'testing',
    paths: [FILE_MATH.path],
    question: 'Verify arithmetic helper logic.',
    rationale: 'Arithmetic logic changed.',
  },
  {
    id: 'auth-task',
    dimension: 'security',
    paths: [FILE_AUTH_V1.path],
    question: 'Inspect authorization guard.',
    rationale: 'Guard protects security boundary.',
  },
];

function testConfig() {
  const parsed = parseAndValidateConfig(`
version: 3
profile: balanced
quorum: 1
review_engine: composed
personas:
  - id: security
    charter: builtin:security
    providers: [codex]
    paths: ["**/*"]
    required: true
    enabled: true
reviewers:
  execution: personas
  fallback: none
  overall_timeout_s: 30
  providers:
    - id: codex
      enabled: true
      model: codex/gpt-5.6-sol-high
      effort: high
      review_timeout_s: 5
      arbiter_timeout_s: 5
  arbiter:
    order: [codex]
`);
  const val = parsed as any;
  val.pre_checks = {
    zoekt: { enabled: false },
    symbolAppendix: { enabled: false },
    analyzers: { enabled: false },
  };
  val.composed = { max_tasks: 4, max_turns_total: 20 };
  return val;
}

function nonceFrom(messages: any[]): string {
  const text = messages.flatMap((m) =>
    typeof m.content === 'string'
      ? [m.content]
      : Array.isArray(m.content)
      ? m.content.flatMap((b: any) => (typeof b.text === 'string' ? [b.text] : []))
      : []
  ).join('\n');
  return text.match(/CT_REVIEW_NONCE:([a-f0-9-]+)/u)?.[1] ?? 'test-nonce';
}

function fakeLlmResponse(content: string, tokens = { prompt: 120, completion: 45 }) {
  return {
    model: 'codex/gpt-5.6-sol-high',
    content,
    usage: { prompt: tokens.prompt, completion: tokens.completion, total: tokens.prompt + tokens.completion },
    costUSD: 0.001,
    raw: {},
  };
}

describe('Content-Addressed Subtask Checkpoints (Milestone 3 / R3)', () => {
  it('TEST_M3_01: Reuses cached task outputs across different commit SHAs when file content hashes are identical (amend / rebase) with 0 GPU tokens', async () => {
    // 1. Setup PR files for original commit
    const changedFilesOriginal = [FILE_MATH, FILE_AUTH_V1];

    // Compute planning context and charter digests for original commit
    const manifestOrig = buildDeterministicReviewPlanningContext({
      coverage: buildDeterministicCoverageManifest(changedFilesOriginal),
      changedFiles: changedFilesOriginal,
    });
    const planOrig = enrichTasksWithPlanningContext(PLAN_TASKS, manifestOrig);
    const charterDigestsOrig = new Map(
      planOrig.tasks.map((task) => [task.id, reviewTaskCharterDigest(task, planOrig.assignments)])
    );

    // 2. Synthesize completed tasks checkpoint from COMMIT_SHA_ORIGINAL
    const completedTasksOrig = planOrig.tasks.map((task) => {
      const file = changedFilesOriginal.find((f) => f.path === task.paths[0])!;
      const delivery = new TaskSourceDelivery({
        taskId: task.id,
        paths: task.paths,
        files: changedFilesOriginal,
        headSha: COMMIT_SHA_ORIGINAL,
        baseSha: BASE_SHA,
        prefix: file.patch,
        inlinedPaths: task.paths,
      }).acknowledgeRequest([{ role: 'user', content: file.patch }]);

      return {
        id: task.id,
        findings: [],
        charterDigest: charterDigestsOrig.get(task.id),
        sourceDelivery: delivery,
      };
    });

    const checkpoint: ReviewExecutionCheckpoint = {
      version: 'ReviewExecutionCheckpoint.v1',
      runId: `run_${'1'.repeat(32)}`,
      repositoryId: 4242,
      owner: 'exampleorg',
      repo: 'example-repo',
      prNumber: 99,
      headSha: COMMIT_SHA_ORIGINAL, // Created on original commit
      baseSha: BASE_SHA,
      policyDigest: POLICY_DIGEST,
      configDigest: CONFIG_DIGEST,
      executionAttempt: 1,
      revision: 1,
      plan: planOrig.tasks,
      plannerPlan: PLAN_TASKS,
      completedTasks: completedTasksOrig,
    };

    // 3. User amends commit: New head SHA is COMMIT_SHA_AMENDED, but file contents are IDENTICAL
    const changedFilesAmended = [FILE_MATH, FILE_AUTH_V1];

    let taskLlmInvocations = 0;
    const invokedTaskIds: string[] = [];

    const complete = vi.fn(async (request: any) => {
      const messages = request.messages;
      const text = messages.flatMap((m: any) =>
        typeof m.content === 'string'
          ? [m.content]
          : Array.isArray(m.content)
          ? m.content.flatMap((b: any) => (typeof b.text === 'string' ? [b.text] : []))
          : []
      ).join('\n');
      const nonce = nonceFrom(messages);

      const taskId = text.match(/Task id: ([a-z-]+)/u)?.[1];
      if (taskId) {
        taskLlmInvocations++;
        invokedTaskIds.push(taskId);
        return fakeLlmResponse(JSON.stringify({ nonce, task: taskId, status: 'COMPLETE', findings: [] }));
      }

      if (text.includes('PLAN TURN')) {
        throw new Error('Planner should resume directly from checkpoint without LLM call');
      }

      // Arbiter turn
      return fakeLlmResponse(JSON.stringify({ nonce, verdict: 'SHIP', rationale: 'All cached tasks approved.' }));
    });

    // 4. Execute composed review on COMMIT_SHA_AMENDED with resumed checkpoint from COMMIT_SHA_ORIGINAL
    const result = await executeComposedReview({
      config: testConfig(),
      changedFiles: changedFilesAmended,
      repository: 'exampleorg/example-repo',
      headSha: COMMIT_SHA_AMENDED,
      baseSha: BASE_SHA,
      client: { complete } as any,
      checkpoint: {
        resumed: checkpoint,
        save: async () => {},
      },
    });

    // 5. Verification:
    // Zero LLM calls for subtasks because both math-task and auth-task were replayed from cache!
    expect(taskLlmInvocations).toBe(0);
    expect(invokedTaskIds).toHaveLength(0);

    // Both personas exist in result, marked as cached with 0 duration and null usage
    expect(result.personas).toHaveLength(2);
    for (const persona of result.personas) {
      expect(persona.turnsCount).toBe(0);
      expect(persona.usage).toBeNull(); // 0 GPU tokens!
      expect(persona.decision).toBe('APPROVE');
    }

    // Quorum satisfied and review ships
    expect(result.quorum.satisfied).toBe(true);
    expect(result.arbiter.verdict).toBe('SHIP');
  });

  it('TEST_M3_02: Re-executes tasks for files with changed content hashes while replaying untouched files from cache with 0 GPU tokens', async () => {
    // 1. Setup original checkpoint: both math-task and auth-task were completed on COMMIT_SHA_ORIGINAL
    const changedFilesOrig = [FILE_MATH, FILE_AUTH_V1];
    const manifestOrig = buildDeterministicReviewPlanningContext({
      coverage: buildDeterministicCoverageManifest(changedFilesOrig),
      changedFiles: changedFilesOrig,
    });
    const planOrig = enrichTasksWithPlanningContext(PLAN_TASKS, manifestOrig);
    const charterDigestsOrig = new Map(
      planOrig.tasks.map((task) => [task.id, reviewTaskCharterDigest(task, planOrig.assignments)])
    );

    const completedTasksOrig = planOrig.tasks.map((task) => {
      const file = changedFilesOrig.find((f) => f.path === task.paths[0])!;
      const delivery = new TaskSourceDelivery({
        taskId: task.id,
        paths: task.paths,
        files: changedFilesOrig,
        headSha: COMMIT_SHA_ORIGINAL,
        baseSha: BASE_SHA,
        prefix: file.patch,
        inlinedPaths: task.paths,
      }).acknowledgeRequest([{ role: 'user', content: file.patch }]);

      return {
        id: task.id,
        findings: [],
        charterDigest: charterDigestsOrig.get(task.id),
        sourceDelivery: delivery,
      };
    });

    const checkpoint: ReviewExecutionCheckpoint = {
      version: 'ReviewExecutionCheckpoint.v1',
      runId: `run_${'1'.repeat(32)}`,
      repositoryId: 4242,
      owner: 'exampleorg',
      repo: 'example-repo',
      prNumber: 99,
      headSha: COMMIT_SHA_ORIGINAL,
      baseSha: BASE_SHA,
      policyDigest: POLICY_DIGEST,
      configDigest: CONFIG_DIGEST,
      executionAttempt: 1,
      revision: 1,
      plan: planOrig.tasks,
      plannerPlan: PLAN_TASKS,
      completedTasks: completedTasksOrig,
    };

    // 2. Commit 2 has UNTOUCHED FILE_MATH, but CHANGED FILE_AUTH_V2
    const changedFilesUpdated = [FILE_MATH, FILE_AUTH_V2];

    const invokedTasks: Array<{ id: string; prompt: string }> = [];

    const complete = vi.fn(async (request: any) => {
      const messages = request.messages;
      const text = messages.flatMap((m: any) =>
        typeof m.content === 'string'
          ? [m.content]
          : Array.isArray(m.content)
          ? m.content.flatMap((b: any) => (typeof b.text === 'string' ? [b.text] : []))
          : []
      ).join('\n');
      const nonce = nonceFrom(messages);

      const taskId = text.match(/Task id: ([a-z-]+)/u)?.[1];
      if (taskId) {
        invokedTasks.push({ id: taskId, prompt: text });
        return fakeLlmResponse(JSON.stringify({ nonce, task: taskId, status: 'COMPLETE', findings: [] }));
      }

      return fakeLlmResponse(JSON.stringify({ nonce, verdict: 'SHIP', rationale: 'Approved.' }));
    });

    // 3. Execute review on COMMIT_SHA_AMENDED
    const result = await executeComposedReview({
      config: testConfig(),
      changedFiles: changedFilesUpdated,
      repository: 'exampleorg/example-repo',
      headSha: COMMIT_SHA_AMENDED,
      baseSha: BASE_SHA,
      client: { complete } as any,
      checkpoint: {
        resumed: checkpoint,
        save: async () => {},
      },
    });

    // 4. Verification:
    // Only 'auth-task' was invoked; 'math-task' was replayed from cache with 0 LLM calls!
    expect(invokedTasks.map((t) => t.id)).toEqual(['auth-task']);
    expect(invokedTasks[0].prompt).toContain('authenticateTenant()');

    // math-task persona had 0 turns and null usage (0 GPU tokens)
    const mathPersona = result.personas.find((p) => p.id === 'math-task');
    expect(mathPersona).toBeDefined();
    expect(mathPersona?.turnsCount).toBe(0);
    expect(mathPersona?.usage).toBeNull();

    // auth-task persona had 1 turn and consumed GPU tokens
    const authPersona = result.personas.find((p) => p.id === 'auth-task');
    expect(authPersona).toBeDefined();
    expect(authPersona?.turnsCount).toBe(1);
    expect(authPersona?.aggregateUsage?.totalTokens).toBeGreaterThan(0);
  });

  it('TEST_M3_03: validateTaskSourceReceipt validates across differing headSha when file patch digests match and allowContentAddressed is true', () => {
    const patch = '@@ -1 +1 @@\n-old\n+new\n';
    const sourceFile = { path: 'src/a.ts', patch };
    const patchHash = createHash('sha256').update(patch).digest('hex');

    const receipt = new TaskSourceDelivery({
      taskId: 'test-task',
      paths: ['src/a.ts'],
      files: [sourceFile],
      prefix: patch,
      inlinedPaths: ['src/a.ts'],
      headSha: COMMIT_SHA_ORIGINAL,
      baseSha: BASE_SHA,
    }).acknowledgeRequest([{ role: 'user', content: patch }]);

    // Strict validation without allowContentAddressed fails
    expect(validateTaskSourceReceipt(receipt, {
      taskId: 'test-task',
      paths: ['src/a.ts'],
      files: [sourceFile],
      headSha: COMMIT_SHA_AMENDED,
      baseSha: BASE_SHA,
    })).toBeNull();

    // With allowContentAddressed: true, accepts receipt and rebinds to new head
    const validated = validateTaskSourceReceipt(receipt, {
      taskId: 'test-task',
      paths: ['src/a.ts'],
      files: [sourceFile],
      headSha: COMMIT_SHA_AMENDED,
      baseSha: BASE_SHA,
      allowContentAddressed: true,
    });

    expect(validated).not.toBeNull();
    expect(validated?.headSha).toBe(COMMIT_SHA_AMENDED);
    expect(validated?.files[0].patchDigest).toBe(patchHash);
  });

  it('TEST_M3_04: Reuses checkpoint task matched by dimension and paths even when fresh planning yields new task IDs', async () => {
    const changedFilesOriginal = [FILE_MATH];
    const manifestOrig = buildDeterministicReviewPlanningContext({
      coverage: buildDeterministicCoverageManifest(changedFilesOriginal),
      changedFiles: changedFilesOriginal,
    });
    const planOrig = enrichTasksWithPlanningContext(PLAN_TASKS.slice(0, 1), manifestOrig);
    const charterDigestsOrig = new Map(
      planOrig.tasks.map((task) => [task.id, reviewTaskCharterDigest(task, planOrig.assignments)])
    );

    const delivery = new TaskSourceDelivery({
      taskId: 'math-task',
      paths: [FILE_MATH.path],
      files: changedFilesOriginal,
      headSha: COMMIT_SHA_ORIGINAL,
      baseSha: BASE_SHA,
      prefix: FILE_MATH.patch,
      inlinedPaths: [FILE_MATH.path],
    }).acknowledgeRequest([{ role: 'user', content: FILE_MATH.patch }]);

    const checkpoint: ReviewExecutionCheckpoint = {
      version: 'ReviewExecutionCheckpoint.v1',
      runId: `run_${'1'.repeat(32)}`,
      repositoryId: 4242,
      owner: 'exampleorg',
      repo: 'example-repo',
      prNumber: 99,
      headSha: COMMIT_SHA_ORIGINAL,
      baseSha: BASE_SHA,
      policyDigest: POLICY_DIGEST,
      configDigest: CONFIG_DIGEST,
      executionAttempt: 1,
      revision: 1,
      plan: planOrig.tasks, // task ID is 'math-task'
      plannerPlan: [{ ...PLAN_TASKS[0], id: 'different-math-id' }], // ID changed
      completedTasks: [{
        id: 'math-task',
        findings: [],
        charterDigest: charterDigestsOrig.get('math-task'),
        sourceDelivery: delivery,
      }],
    };

    let subtaskInvoked = false;
    const complete = vi.fn(async (request: any) => {
      const messages = request.messages;
      const text = messages.flatMap((m: any) =>
        typeof m.content === 'string'
          ? [m.content]
          : Array.isArray(m.content)
          ? m.content.flatMap((b: any) => (typeof b.text === 'string' ? [b.text] : []))
          : []
      ).join('\n');
      const nonce = nonceFrom(messages);

      if (text.includes('Task id:')) {
        subtaskInvoked = true;
        return fakeLlmResponse(JSON.stringify({ nonce, task: 'different-math-id', status: 'COMPLETE', findings: [] }));
      }
      return fakeLlmResponse(JSON.stringify({ nonce, verdict: 'SHIP', rationale: 'Approved.' }));
    });

    const result = await executeComposedReview({
      config: testConfig(),
      changedFiles: [FILE_MATH],
      repository: 'exampleorg/example-repo',
      headSha: COMMIT_SHA_AMENDED,
      baseSha: BASE_SHA,
      client: { complete } as any,
      checkpoint: {
        resumed: checkpoint,
        save: async () => {},
      },
    });

    // Matched by dimension and paths, so 0 subtask LLM invocations!
    expect(subtaskInvoked).toBe(false);
    expect(result.personas).toHaveLength(1);
    expect(result.personas[0].turnsCount).toBe(0);
    expect(result.personas[0].usage).toBeNull();
  });
});
