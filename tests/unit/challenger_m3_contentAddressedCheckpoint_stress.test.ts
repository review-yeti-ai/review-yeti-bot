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
  type TaskSourceReceipt,
} from '../../src/review/taskSourceDelivery';
import { runPublishingReviewWorker, parseChangedFiles } from '../../src/cli/publishingReview';
import { preparePublishingPolicy } from '../../src/review/preparedPublishingPolicy';
import { ComposedRuntimeResourceObserver } from '../../src/panel/composedResourceReceipt';
import { groundedFixtureClient, groundedFixtureProvider } from '../support/groundedReviewFixture';
import { preparedCheckpointHistory } from '../support/preparedCheckpointHistory';
import type { ReviewTask } from '../../src/panel/reviewTask';
import type { ReviewExecutionCheckpoint } from '../../src/review/reviewExecutionCheckpoint';

function enableLifecycleHistory(input: {
  policyDigest: string;
  configDigest: string;
  currentHeadSha: string;
  priorHeadSha: string;
  baseSha: string;
}) {
  return preparedCheckpointHistory(input);
}

const COMMIT_SHA_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const COMMIT_SHA_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const BASE_SHA_A   = '1111111111111111111111111111111111111111';
const BASE_SHA_B   = '2222222222222222222222222222222222222222';
const POLICY_DIGEST = 'c'.repeat(64);
const CONFIG_DIGEST = 'd'.repeat(64);

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function testConfig(maxTasks = 8) {
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
  val.composed = { max_tasks: maxTasks, max_turns_total: 30 };
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

function fakeLlmResponse(content: string, tokens = { prompt: 100, completion: 50 }) {
  return {
    model: 'codex/gpt-5.6-sol-high',
    content,
    usage: { prompt: tokens.prompt, completion: tokens.completion, total: tokens.prompt + tokens.completion },
    costUSD: 0.001,
    raw: {},
  };
}

describe('Challenger M3 Stress Test: Content-Addressed Checkpoints', () => {
  // --------------------------------------------------------------------------
  // Scenario 1: Rebase simulation (Commit SHA changes from A to B, content matches)
  // --------------------------------------------------------------------------
  it('SCENARIO 1: Rebase simulation across distinct commit and base SHAs with matching file hashes asserts 0 LLM calls and 0 GPU tokens', async () => {
    const filesOriginal = [
      { path: 'src/utils/calc.ts', patch: '@@ -1,2 +1,2 @@\n-export const calc = 1;\n+export const calc = 2;\n' },
      { path: 'src/utils/format.ts', patch: '@@ -1,2 +1,2 @@\n-export const fmt = "a";\n+export const fmt = "b";\n' },
      { path: 'src/utils/math.ts', patch: '@@ -1,2 +1,2 @@\n-export const math = false;\n+export const math = true;\n' },
    ];

    const tasks: ReviewTask[] = [
      { id: 'calc-task', dimension: 'testing', paths: [filesOriginal[0].path], question: 'Inspect calc.', rationale: 'Calc.' },
      { id: 'format-task', dimension: 'architecture', paths: [filesOriginal[1].path], question: 'Inspect format.', rationale: 'Format.' },
      { id: 'math-task', dimension: 'performance', paths: [filesOriginal[2].path], question: 'Inspect math.', rationale: 'Math.' },
    ];

    const manifestA = buildDeterministicReviewPlanningContext({
      coverage: buildDeterministicCoverageManifest(filesOriginal),
      changedFiles: filesOriginal,
    });
    const planA = enrichTasksWithPlanningContext(tasks, manifestA);
    const charterDigestsA = new Map(
      planA.tasks.map((task) => [task.id, reviewTaskCharterDigest(task, planA.assignments)])
    );

    // Create completed tasks on commit A and base A
    const completedTasksA = planA.tasks.map((task) => {
      const file = filesOriginal.find((f) => f.path === task.paths[0])!;
      const delivery = new TaskSourceDelivery({
        taskId: task.id,
        paths: task.paths,
        files: filesOriginal,
        headSha: COMMIT_SHA_A,
        baseSha: BASE_SHA_A,
        prefix: file.patch,
        inlinedPaths: task.paths,
      }).acknowledgeRequest([{ role: 'user', content: file.patch }]);

      return {
        id: task.id,
        findings: [],
        charterDigest: charterDigestsA.get(task.id),
        sourceDelivery: delivery,
      };
    });

    const checkpoint: ReviewExecutionCheckpoint = {
      version: 'ReviewExecutionCheckpoint.v1',
      runId: `run_${'a'.repeat(32)}`,
      repositoryId: 9999,
      owner: 'acme-corp',
      repo: 'core-service',
      prNumber: 42,
      headSha: COMMIT_SHA_A,
      baseSha: BASE_SHA_A,
      policyDigest: POLICY_DIGEST,
      configDigest: CONFIG_DIGEST,
      executionAttempt: 1,
      revision: 1,
      plan: planA.tasks,
      plannerPlan: tasks,
      completedTasks: completedTasksA,
    };

    // Rebased to COMMIT_SHA_B and BASE_SHA_B, but file contents are 100% identical
    const filesRebased = [...filesOriginal];

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
      return fakeLlmResponse(JSON.stringify({ nonce, verdict: 'SHIP', rationale: 'All cached tasks replayed cleanly.' }));
    });

    const result = await executeComposedReview({
      config: testConfig(),
      changedFiles: filesRebased,
      repository: 'acme-corp/core-service',
      headSha: COMMIT_SHA_B,
      baseSha: BASE_SHA_B,
      client: { complete } as any,
      checkpoint: {
        resumed: checkpoint,
        save: async () => {},
      },
    });

    // Exactly 0 LLM invocations for subtasks across the entire rebase
    expect(taskLlmInvocations).toBe(0);
    expect(invokedTaskIds).toHaveLength(0);

    // All personas replayed with 0 turns and null usage (0 GPU tokens)
    expect(result.personas).toHaveLength(3);
    for (const persona of result.personas) {
      expect(persona.turnsCount).toBe(0);
      expect(persona.usage).toBeNull();
      expect(persona.decision).toBe('APPROVE');
    }
    expect(result.quorum.satisfied).toBe(true);
    expect(result.arbiter.verdict).toBe('SHIP');
  });

  // --------------------------------------------------------------------------
  // Scenario 2: Amend with 1 file modified out of 5
  // --------------------------------------------------------------------------
  it('SCENARIO 2: Amend with 1 file modified out of 5 asserts 4 tasks replayed from cache with 0 tokens and exactly 1 task re-executed', async () => {
    const filesOriginal = [
      { path: 'src/utils/calc.ts', patch: '@@ -1,2 +1,2 @@\n-export const calc = 1;\n+export const calc = 2;\n' },
      { path: 'src/utils/format.ts', patch: '@@ -1,2 +1,2 @@\n-export const fmt = "a";\n+export const fmt = "b";\n' },
      { path: 'src/utils/math.ts', patch: '@@ -1,2 +1,2 @@\n-export const math = 10;\n+export const math = 20;\n' },
      { path: 'src/utils/string.ts', patch: '@@ -1,2 +1,2 @@\n-export const str = "x";\n+export const str = "y";\n' },
      { path: 'src/utils/array.ts', patch: '@@ -1,2 +1,2 @@\n-export const arr = [1];\n+export const arr = [1, 2];\n' },
    ];

    const tasks: ReviewTask[] = [
      { id: 'task-calc', dimension: 'testing', paths: [filesOriginal[0].path], question: 'Inspect calc.', rationale: 'R1.' },
      { id: 'task-format', dimension: 'architecture', paths: [filesOriginal[1].path], question: 'Inspect format.', rationale: 'R2.' },
      { id: 'task-math', dimension: 'performance', paths: [filesOriginal[2].path], question: 'Inspect math.', rationale: 'R3.' },
      { id: 'task-string', dimension: 'testing', paths: [filesOriginal[3].path], question: 'Inspect string.', rationale: 'R4.' },
      { id: 'task-array', dimension: 'architecture', paths: [filesOriginal[4].path], question: 'Inspect array.', rationale: 'R5.' },
    ];

    const manifestA = buildDeterministicReviewPlanningContext({
      coverage: buildDeterministicCoverageManifest(filesOriginal),
      changedFiles: filesOriginal,
    });
    const planA = enrichTasksWithPlanningContext(tasks, manifestA);
    const charterDigestsA = new Map(
      planA.tasks.map((task) => [task.id, reviewTaskCharterDigest(task, planA.assignments)])
    );

    const completedTasksA = planA.tasks.map((task) => {
      const file = filesOriginal.find((f) => f.path === task.paths[0])!;
      const delivery = new TaskSourceDelivery({
        taskId: task.id,
        paths: task.paths,
        files: filesOriginal,
        headSha: COMMIT_SHA_A,
        baseSha: BASE_SHA_A,
        prefix: file.patch,
        inlinedPaths: task.paths,
      }).acknowledgeRequest([{ role: 'user', content: file.patch }]);

      return {
        id: task.id,
        findings: [],
        charterDigest: charterDigestsA.get(task.id),
        sourceDelivery: delivery,
      };
    });

    const checkpoint: ReviewExecutionCheckpoint = {
      version: 'ReviewExecutionCheckpoint.v1',
      runId: `run_${'2'.repeat(32)}`,
      repositoryId: 9999,
      owner: 'acme-corp',
      repo: 'core-service',
      prNumber: 42,
      headSha: COMMIT_SHA_A,
      baseSha: BASE_SHA_A,
      policyDigest: POLICY_DIGEST,
      configDigest: CONFIG_DIGEST,
      executionAttempt: 1,
      revision: 1,
      plan: planA.tasks,
      plannerPlan: tasks,
      completedTasks: completedTasksA,
    };

    // Amend commit: file 3 (src/utils/math.ts) is modified; the other 4 are completely untouched!
    const filesAmended = [
      filesOriginal[0],
      filesOriginal[1],
      { path: 'src/utils/math.ts', patch: '@@ -1,2 +1,2 @@\n-export const math = 10;\n+export const math = computeDynamicPrime();\n' },
      filesOriginal[3],
      filesOriginal[4],
    ];

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

    const result = await executeComposedReview({
      config: testConfig(),
      changedFiles: filesAmended,
      repository: 'acme-corp/core-service',
      headSha: COMMIT_SHA_B,
      baseSha: BASE_SHA_A,
      client: { complete } as any,
      checkpoint: {
        resumed: checkpoint,
        save: async () => {},
      },
    });

    // Assert exactly 1 task was invoked by the LLM
    expect(invokedTasks.map((t) => t.id)).toEqual(['task-math']);
    expect(invokedTasks[0].prompt).toContain('computeDynamicPrime()');

    // Assert 4 tasks replayed from cache with 0 tokens (null usage, 0 turns)
    const cachedTaskIds = ['task-calc', 'task-format', 'task-string', 'task-array'];
    for (const cachedId of cachedTaskIds) {
      const persona = result.personas.find((p) => p.id === cachedId);
      expect(persona).toBeDefined();
      expect(persona?.turnsCount).toBe(0);
      expect(persona?.usage).toBeNull();
    }

    // Assert the 1 modified task was executed and consumed GPU tokens
    const modifiedPersona = result.personas.find((p) => p.id === 'task-math');
    expect(modifiedPersona).toBeDefined();
    expect(modifiedPersona?.turnsCount).toBe(1);
    expect(modifiedPersona?.aggregateUsage?.totalTokens).toBeGreaterThan(0);
  });

  // --------------------------------------------------------------------------
  // Scenario 3: Tampered Patch Digest or Path Collision
  // --------------------------------------------------------------------------
  describe('SCENARIO 3: Tampered Receipts, Path Collisions, and Malformed Receipts Rejection', () => {
    it('rejects tampered patch digest in receipt and forces subtask re-execution', async () => {
      const filesOriginal = [
        { path: 'src/utils/calc.ts', patch: '@@ -1,2 +1,2 @@\n-export const calc = 1;\n+export const calc = 2;\n' },
      ];
      const tasks: ReviewTask[] = [
        { id: 'task-calc', dimension: 'testing', paths: [filesOriginal[0].path], question: 'Inspect calc.', rationale: 'R1.' },
      ];

      const manifestA = buildDeterministicReviewPlanningContext({
        coverage: buildDeterministicCoverageManifest(filesOriginal),
        changedFiles: filesOriginal,
      });
      const planA = enrichTasksWithPlanningContext(tasks, manifestA);

      const delivery = new TaskSourceDelivery({
        taskId: 'task-calc',
        paths: ['src/utils/calc.ts'],
        files: filesOriginal,
        headSha: COMMIT_SHA_A,
        baseSha: BASE_SHA_A,
        prefix: filesOriginal[0].patch,
        inlinedPaths: ['src/utils/calc.ts'],
      }).acknowledgeRequest([{ role: 'user', content: filesOriginal[0].patch }]);

      // TAMPERING: Corrupt the patchDigest in the receipt
      const tamperedDelivery = {
        ...delivery,
        files: [
          {
            ...delivery.files[0],
            patchDigest: 'f'.repeat(64), // Forged / invalid digest
          },
        ],
      };

      // 1. Direct validation check: validateTaskSourceReceipt returns null
      const directCheck = validateTaskSourceReceipt(tamperedDelivery, {
        taskId: 'task-calc',
        paths: ['src/utils/calc.ts'],
        files: filesOriginal,
        headSha: COMMIT_SHA_B,
        baseSha: BASE_SHA_A,
        allowContentAddressed: true,
      });
      expect(directCheck).toBeNull();

      // 2. Engine-level check: composedEngine refuses to use tampered receipt and re-executes task
      const checkpoint: ReviewExecutionCheckpoint = {
        version: 'ReviewExecutionCheckpoint.v1',
        runId: `run_${'3'.repeat(32)}`,
        repositoryId: 9999,
        owner: 'acme-corp',
        repo: 'core-service',
        prNumber: 42,
        headSha: COMMIT_SHA_A,
        baseSha: BASE_SHA_A,
        policyDigest: POLICY_DIGEST,
        configDigest: CONFIG_DIGEST,
        executionAttempt: 1,
        revision: 1,
        plan: planA.tasks,
        plannerPlan: tasks,
        completedTasks: [{
          id: 'task-calc',
          findings: [],
          charterDigest: reviewTaskCharterDigest(planA.tasks[0], planA.assignments),
          sourceDelivery: tamperedDelivery,
        }],
      };

      let taskInvoked = false;
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

        if (text.includes('Task id: task-calc')) {
          taskInvoked = true;
          return fakeLlmResponse(JSON.stringify({ nonce, task: 'task-calc', status: 'COMPLETE', findings: [] }));
        }
        return fakeLlmResponse(JSON.stringify({ nonce, verdict: 'SHIP', rationale: 'Approved.' }));
      });

      const result = await executeComposedReview({
        config: testConfig(),
        changedFiles: filesOriginal,
        repository: 'acme-corp/core-service',
        headSha: COMMIT_SHA_B,
        baseSha: BASE_SHA_A,
        client: { complete } as any,
        checkpoint: {
          resumed: checkpoint,
          save: async () => {},
        },
      });

      // Because receipt was tampered, cached task was rejected and re-executed!
      expect(taskInvoked).toBe(true);
      expect(result.personas[0].turnsCount).toBe(1);
      expect(result.personas[0].aggregateUsage?.totalTokens).toBeGreaterThan(0);
    });

    it('rejects path collision / path swap where receipt file path does not match task paths', () => {
      const files = [
        { path: 'src/utils/a.ts', patch: '@@ -1 +1 @@\n-a\n+a2\n' },
        { path: 'src/utils/b.ts', patch: '@@ -1 +1 @@\n-b\n+b2\n' },
      ];

      const deliveryA = new TaskSourceDelivery({
        taskId: 'task-a',
        paths: ['src/utils/a.ts'],
        files,
        headSha: COMMIT_SHA_A,
        baseSha: BASE_SHA_A,
        prefix: files[0].patch,
        inlinedPaths: ['src/utils/a.ts'],
      }).acknowledgeRequest([{ role: 'user', content: files[0].patch }]);

      // Attempt to validate receipt for task-b using receipt of task-a
      const crossTaskCheck = validateTaskSourceReceipt(deliveryA, {
        taskId: 'task-b',
        paths: ['src/utils/b.ts'],
        files,
        headSha: COMMIT_SHA_B,
        baseSha: BASE_SHA_A,
        allowContentAddressed: true,
      });
      expect(crossTaskCheck).toBeNull();

      // Attempt path collision: swap path to b.ts but keep task-a id
      const swappedReceipt = {
        ...deliveryA,
        files: [{ ...deliveryA.files[0], path: 'src/utils/b.ts' }],
      };
      const collisionCheck = validateTaskSourceReceipt(swappedReceipt, {
        taskId: 'task-a',
        paths: ['src/utils/a.ts'],
        files,
        headSha: COMMIT_SHA_B,
        baseSha: BASE_SHA_A,
        allowContentAddressed: true,
      });
      expect(collisionCheck).toBeNull();
    });

    it('rejects tampered totalChars in receipt', () => {
      const patch = '@@ -1 +1 @@\n-old\n+new\n';
      const file = { path: 'src/a.ts', patch };

      const delivery = new TaskSourceDelivery({
        taskId: 'task-a',
        paths: ['src/a.ts'],
        files: [file],
        headSha: COMMIT_SHA_A,
        baseSha: BASE_SHA_A,
        prefix: patch,
        inlinedPaths: ['src/a.ts'],
      }).acknowledgeRequest([{ role: 'user', content: patch }]);

      const tamperedLengthReceipt = {
        ...delivery,
        files: [{ ...delivery.files[0], totalChars: 99999 }],
      };

      expect(validateTaskSourceReceipt(tamperedLengthReceipt, {
        taskId: 'task-a',
        paths: ['src/a.ts'],
        files: [file],
        headSha: COMMIT_SHA_B,
        baseSha: BASE_SHA_A,
        allowContentAddressed: true,
      })).toBeNull();
    });

    it('rejects incomplete delivery receipt (complete: false)', () => {
      const patch = '@@ -1 +1 @@\n-old\n+new\n';
      const file = { path: 'src/a.ts', patch };

      const delivery = new TaskSourceDelivery({
        taskId: 'task-a',
        paths: ['src/a.ts'],
        files: [file],
        headSha: COMMIT_SHA_A,
        baseSha: BASE_SHA_A,
        prefix: patch,
        inlinedPaths: ['src/a.ts'],
      }).acknowledgeRequest([{ role: 'user', content: patch }]);

      const incompleteReceipt = {
        ...delivery,
        complete: false,
      };

      expect(validateTaskSourceReceipt(incompleteReceipt, {
        taskId: 'task-a',
        paths: ['src/a.ts'],
        files: [file],
        headSha: COMMIT_SHA_B,
        baseSha: BASE_SHA_A,
        allowContentAddressed: true,
      })).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Scenario 4: Worker Level Publishing Review with 1 modified out of 5
  // --------------------------------------------------------------------------
  it('SCENARIO 4: Worker publishing review with 1 file modified out of 5 invalidates only the modified task', async () => {
    const content = JSON.stringify({
      schema: 'exampleorg.review-policy.v1',
      review_yeti: { personas: 'security,testing', review_engine: 'composed', budget: { max_investigation_turns: 1 } },
    });
    const transport = { baseUrl: 'https://gateway.example.invalid/v1', model: 'prepared-review-model' };
    const prepared = preparePublishingPolicy(
      { content, source: { repositoryId: 987, repository: 'exampleorg/repo', sha: 'e'.repeat(40), path: 'policy/review.json',
        contentDigest: sha256(content) } },
      transport
    );

    const makeWorkerEnv = (overrides: Record<string, string> = {}): NodeJS.ProcessEnv => ({
      NODE_ENV: 'test',
      REVIEW_PUBLICATION_MODE: 'app-gate',
      REVIEW_AUTHORITATIVE_GATE: 'true',
      REVIEW_RUN_ID: `run_${'c'.repeat(32)}`,
      REVIEW_REPO: 'exampleorg/example-meta',
      REVIEW_REPOSITORY_ID: '1339040553',
      REVIEW_PR_NUMBER: '2795',
      REVIEW_HEAD_SHA: COMMIT_SHA_B,
      REVIEW_BASE_SHA: BASE_SHA_A,
      REVIEW_POLICY_DIGEST: prepared.policy.effectivePolicyDigest,
      REVIEW_CONFIG_DIGEST: prepared.policy.effectiveConfigDigest,
      REVIEW_PREPARED_CONFIG_JSON: JSON.stringify({ version: 'PreparedReviewExecution.v1', config: prepared.config, transport }),
      REVIEW_MODEL: transport.model,
      OPENAI_BASE_URL: transport.baseUrl,
      OPENAI_API_KEY: 'vk-test',
      GH_TOKEN: 'ghs_test',
      GITHUB_PUBLISH_TOKEN: 'ghs_fake',
      REVIEW_COMPLETION_URL: 'https://dispatch.example.invalid/api/dispatch/completion',
      REVIEW_REPOSITORY_VISIBILITY: 'PRIVATE',
      REVIEW_EXECUTION_ATTEMPT: '1',
      ...overrides,
    });

    const makeWorkerDeps = (overrides: Record<string, unknown> = {}) => ({
      checkClient: {
        createCheck: vi.fn(async () => 4242),
        completeCheck: vi.fn(async () => {}),
      },
      currentPullRequestVerifier: vi.fn(async () => undefined),
      sourceLoader: vi.fn(async () => ({ diff: '', githubReads: 1 })) as never,
      visibilityLookup: vi.fn(async () => 'PRIVATE' as const),
      ...enableLifecycleHistory({
        policyDigest: prepared.policy.effectivePolicyDigest,
        configDigest: prepared.policy.effectiveConfigDigest,
        currentHeadSha: COMMIT_SHA_B,
        priorHeadSha: COMMIT_SHA_A,
        baseSha: BASE_SHA_A,
      }),
      panelRunner: vi.fn(async () => ({
        applicablePersonaIds: ['sec-lane'],
        personas: [{ id: 'sec-lane', findings: [] }],
        optionalFailures: [],
        quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
        arbiter: { verdict: 'SHIP' },
      })) as never,
      client: {} as never,
      groundedVerifierClient: groundedFixtureClient as never,
      repoFileProviderFactory: ((input: any) => groundedFixtureProvider(input)) as never,
      reviewCompletion: { reportReviewResult: vi.fn(async () => {}) },
      ...overrides,
    });

    const diffA = [
      `diff --git a/src/f1.ts b/src/f1.ts\n@@ -1 +1 @@\n-f1_old\n+f1_new\n`,
      `diff --git a/src/f2.ts b/src/f2.ts\n@@ -1 +1 @@\n-f2_old\n+f2_new\n`,
      `diff --git a/src/f3.ts b/src/f3.ts\n@@ -1 +1 @@\n-f3_old\n+f3_new\n`,
      `diff --git a/src/f4.ts b/src/f4.ts\n@@ -1 +1 @@\n-f4_old\n+f4_new\n`,
      `diff --git a/src/f5.ts b/src/f5.ts\n@@ -1 +1 @@\n-f5_old\n+f5_new\n`,
    ].join('');

    const parsedFilesA = parseChangedFiles(diffA).files;

    const plan = [
      { id: 'task-1', dimension: 'testing' as const, paths: ['src/f1.ts'], question: 'q1', rationale: 'r1' },
      { id: 'task-2', dimension: 'architecture' as const, paths: ['src/f2.ts'], question: 'q2', rationale: 'r2' },
      { id: 'task-3', dimension: 'performance' as const, paths: ['src/f3.ts'], question: 'q3', rationale: 'r3' },
      { id: 'task-4', dimension: 'testing' as const, paths: ['src/f4.ts'], question: 'q4', rationale: 'r4' },
      { id: 'task-5', dimension: 'architecture' as const, paths: ['src/f5.ts'], question: 'q5', rationale: 'r5' },
    ];

    const completedTasksA = plan.map((task) => {
      const file = parsedFilesA.find((f) => f.path === task.paths[0])!;
      const delivery = new TaskSourceDelivery({
        taskId: task.id,
        paths: task.paths,
        files: parsedFilesA,
        headSha: COMMIT_SHA_A,
        baseSha: BASE_SHA_A,
        prefix: file.patch!,
        inlinedPaths: task.paths,
      });
      delivery.beginAttempt();
      const receipt = delivery.acknowledgeRequest([{ role: 'user', content: file.patch! }]);
      return { id: task.id, findings: [], sourceDelivery: receipt };
    });

    const checkpoint: ReviewExecutionCheckpoint = {
      version: 'ReviewExecutionCheckpoint.v1',
      runId: `run_${'4'.repeat(32)}`,
      repositoryId: 1339040553,
      owner: 'exampleorg',
      repo: 'example-meta',
      prNumber: 2795,
      headSha: COMMIT_SHA_A,
      baseSha: BASE_SHA_A,
      policyDigest: prepared.policy.effectivePolicyDigest,
      configDigest: prepared.policy.effectiveConfigDigest,
      executionAttempt: 1,
      revision: 1,
      plan,
      completedTasks: completedTasksA,
    };

    // Commit B has file f3 modified!
    const diffB = [
      `diff --git a/src/f1.ts b/src/f1.ts\n@@ -1 +1 @@\n-f1_old\n+f1_new\n`,
      `diff --git a/src/f2.ts b/src/f2.ts\n@@ -1 +1 @@\n-f2_old\n+f2_new\n`,
      `diff --git a/src/f3.ts b/src/f3.ts\n@@ -1 +1 @@\n-f3_old\n+f3_MODIFIED_AMEND\n`,
      `diff --git a/src/f4.ts b/src/f4.ts\n@@ -1 +1 @@\n-f4_old\n+f4_new\n`,
      `diff --git a/src/f5.ts b/src/f5.ts\n@@ -1 +1 @@\n-f5_old\n+f5_new\n`,
    ].join('');
    const parsedFilesB = parseChangedFiles(diffB).files;

    let receivedResumedCompletedTasks: any[] = [];
    const returnedSourceDelivery: Array<{ id: string; sourceDelivery: TaskSourceReceipt }> = [];
    const composedReviewRunner = vi.fn(async (options: any) => {
      receivedResumedCompletedTasks = options.checkpoint?.resumed?.completedTasks ?? [];
      const budget = options.providerAttemptBudget;
      const observer = new ComposedRuntimeResourceObserver({
        configDigest: options.effectiveConfigDigest ?? prepared.policy.effectiveConfigDigest,
        configuration: options.config?.review_configuration_receipt ?? prepared.config.review_configuration_receipt,
        ...(budget ? { providerAttemptBudget: budget } : {}),
      });
      if (budget) {
        observer.configureBudget({
          configuredTotalTurns: budget.limits.totalLimit,
          investigationTurns: budget.limits.investigationLimit,
          verificationReserveTurns: budget.limits.verificationLimit,
        });
      } else {
        observer.configureBudget({ configuredTotalTurns: 1, investigationTurns: 1, verificationReserveTurns: 0 });
      }
      observer.setPlan(plan);
      for (const t of plan) {
        observer.markTaskStarted(t.id);
        const retained = receivedResumedCompletedTasks.find((completed) => completed.id === t.id);
        let receipt: TaskSourceReceipt;
        if (retained) {
          const rebound = validateTaskSourceReceipt(retained.sourceDelivery, {
            taskId: t.id,
            paths: t.paths,
            files: parsedFilesB,
            headSha: COMMIT_SHA_B,
            baseSha: BASE_SHA_A,
            allowContentAddressed: true,
          });
          if (!rebound) throw new Error(`Retained task ${t.id} has no valid current-source receipt`);
          receipt = rebound;
        } else {
          const file = parsedFilesB.find((candidate) => candidate.path === t.paths[0]);
          if (!file?.patch) throw new Error(`Regenerated task ${t.id} has no current source patch`);
          const delivery = new TaskSourceDelivery({
            taskId: t.id,
            paths: t.paths,
            files: parsedFilesB,
            headSha: COMMIT_SHA_B,
            baseSha: BASE_SHA_A,
            prefix: file.patch,
            inlinedPaths: t.paths,
          });
          delivery.beginAttempt();
          receipt = delivery.acknowledgeRequest([{ role: 'user', content: file.patch }]);
        }
        returnedSourceDelivery.push({ id: t.id, sourceDelivery: receipt });
        observer.markTaskOutcome(t.id, 'completed', receipt);
      }
      const resources = observer.snapshot('terminal');
      if (resources) options.resourceObservationCapture(resources);
      return {
        taskPlan: plan,
        applicablePersonaIds: plan.map((p) => p.id),
        personas: plan.map((p) => ({
          id: p.id,
          decision: 'APPROVE',
          findings: [],
          sourceDelivery: returnedSourceDelivery.find((completed) => completed.id === p.id)!.sourceDelivery,
        })),
        optionalFailures: [],
        quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true, coverageMode: 'file_coverage' },
        arbiter: { verdict: 'SHIP' },
        composedResourceObservation: resources,
      };
    });

    const readCheckpoint = vi.fn(async () => ({ checkpoint, disputedFindingRechecks: [] }));

    const result = await runPublishingReviewWorker(
      makeWorkerEnv(),
      makeWorkerDeps({
        composedReviewRunner,
        reviewCheckpoint: { read: readCheckpoint, write: vi.fn(async () => 2) },
        sourceLoader: vi.fn(async () => ({
          baseSha: BASE_SHA_A,
          headSha: COMMIT_SHA_B,
          diff: diffB,
          diffDigest: sha256(diffB),
          githubReads: 0,
        })),
      }) as any
    );

    expect(result).toMatchObject({ verdict: 'SHIP', conclusion: 'success' });
    // Assert exactly 4 tasks (1, 2, 4, 5) were retained, and task-3 was invalidated!
    const retainedIds = receivedResumedCompletedTasks.map((t) => t.id).sort();
    expect(retainedIds).toEqual(['task-1', 'task-2', 'task-4', 'task-5']);
    expect(returnedSourceDelivery.map(({ id }) => id).sort()).toEqual(plan.map(({ id }) => id).sort());
    for (const { id, sourceDelivery } of returnedSourceDelivery) {
      expect(validateTaskSourceReceipt(sourceDelivery, {
        taskId: id,
        paths: plan.find((task) => task.id === id)!.paths,
        files: parsedFilesB,
        headSha: COMMIT_SHA_B,
        baseSha: BASE_SHA_A,
      })).not.toBeNull();
    }
    const regeneratedTaskReceipt = returnedSourceDelivery.find(({ id }) => id === 'task-3')!.sourceDelivery;
    expect(regeneratedTaskReceipt).toMatchObject({ headSha: COMMIT_SHA_B, baseSha: BASE_SHA_A, complete: true });
    expect(validateTaskSourceReceipt(completedTasksA.find(({ id }) => id === 'task-3')!.sourceDelivery, {
      taskId: 'task-3',
      paths: ['src/f3.ts'],
      files: parsedFilesB,
      headSha: COMMIT_SHA_B,
      baseSha: BASE_SHA_A,
      allowContentAddressed: true,
    })).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Scenario 5: Retry Fencing Security Boundary (executionAttempt > 1)
  // --------------------------------------------------------------------------
  it('SCENARIO 5: Retry attempts (executionAttempt > 1) strictly reject non-exact-head checkpoints', async () => {
    const content = JSON.stringify({
      schema: 'exampleorg.review-policy.v1',
      review_yeti: { personas: 'security', review_engine: 'composed', budget: { max_investigation_turns: 1 } },
    });
    const transport = { baseUrl: 'https://gateway.example.invalid/v1', model: 'prepared-review-model' };
    const prepared = preparePublishingPolicy(
      { content, source: { repositoryId: 987, repository: 'exampleorg/repo', sha: 'e'.repeat(40), path: 'policy/review.json',
        contentDigest: sha256(content) } },
      transport
    );

    const diff = `diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n`;
    const checkpoint: ReviewExecutionCheckpoint = {
      version: 'ReviewExecutionCheckpoint.v1',
      runId: `run_${'5'.repeat(32)}`,
      repositoryId: 1339040553,
      owner: 'exampleorg',
      repo: 'example-meta',
      prNumber: 2795,
      headSha: COMMIT_SHA_A, // Differs from REVIEW_HEAD_SHA
      baseSha: BASE_SHA_A,
      policyDigest: prepared.policy.effectivePolicyDigest,
      configDigest: prepared.policy.effectiveConfigDigest,
      executionAttempt: 1,
      revision: 1,
      plan: [],
      completedTasks: [],
    };

    const workerEnvRetry = {
      NODE_ENV: 'test',
      REVIEW_PUBLICATION_MODE: 'app-gate',
      REVIEW_AUTHORITATIVE_GATE: 'true',
      REVIEW_RUN_ID: `run_${'c'.repeat(32)}`,
      REVIEW_REPO: 'exampleorg/example-meta',
      REVIEW_REPOSITORY_ID: '1339040553',
      REVIEW_PR_NUMBER: '2795',
      REVIEW_HEAD_SHA: COMMIT_SHA_B, // Differs from checkpoint headSha
      REVIEW_BASE_SHA: BASE_SHA_A,
      REVIEW_POLICY_DIGEST: prepared.policy.effectivePolicyDigest,
      REVIEW_CONFIG_DIGEST: prepared.policy.effectiveConfigDigest,
      REVIEW_PREPARED_CONFIG_JSON: JSON.stringify({ version: 'PreparedReviewExecution.v1', config: prepared.config, transport }),
      REVIEW_MODEL: transport.model,
      OPENAI_BASE_URL: transport.baseUrl,
      OPENAI_API_KEY: 'vk-test',
      GH_TOKEN: 'ghs_test',
      GITHUB_PUBLISH_TOKEN: 'ghs_fake',
      REVIEW_COMPLETION_URL: 'https://dispatch.example.invalid/api/dispatch/completion',
      REVIEW_REPOSITORY_VISIBILITY: 'PRIVATE',
      REVIEW_EXECUTION_ATTEMPT: '2', // RETRY attempt!
    };

    await expect(
      runPublishingReviewWorker(
        workerEnvRetry as any,
        {
          checkClient: { createCheck: vi.fn(async () => 4242), completeCheck: vi.fn() },
          currentPullRequestVerifier: vi.fn(async () => undefined),
          composedReviewRunner: vi.fn(),
          reviewCheckpoint: { read: vi.fn(async () => ({ checkpoint, disputedFindingRechecks: [] })), write: vi.fn() },
          reviewCompletion: { reportReviewResult: vi.fn() },
          groundedVerifierClient: groundedFixtureClient,
          repoFileProviderFactory: (input: any) => groundedFixtureProvider(input),
          visibilityLookup: vi.fn(async () => 'PRIVATE' as const),
          sourceLoader: vi.fn(async () => ({
            baseSha: BASE_SHA_A,
            headSha: COMMIT_SHA_B,
            diff,
            diffDigest: sha256(diff),
            githubReads: 0,
          })),
          ...enableLifecycleHistory({
            policyDigest: prepared.policy.effectivePolicyDigest,
            configDigest: prepared.policy.effectiveConfigDigest,
            currentHeadSha: COMMIT_SHA_B,
            priorHeadSha: COMMIT_SHA_A,
            baseSha: BASE_SHA_A,
          }),
        } as any
      )
    ).rejects.toThrow('Exact-head checkpoint and disputed finding requests are required for a safe retry');
  });

  // --------------------------------------------------------------------------
  // Scenario 6: Config/Policy Digest Mismatch Prevention
  // --------------------------------------------------------------------------
  it('SCENARIO 6: Policy or config digest mismatch forbids content-addressed checkpoint reuse', async () => {
    const content = JSON.stringify({
      schema: 'exampleorg.review-policy.v1',
      review_yeti: { personas: 'security', review_engine: 'composed', budget: { max_investigation_turns: 1 } },
    });
    const transport = { baseUrl: 'https://gateway.example.invalid/v1', model: 'prepared-review-model' };
    const prepared = preparePublishingPolicy(
      { content, source: { repositoryId: 987, repository: 'exampleorg/repo', sha: 'e'.repeat(40), path: 'policy/review.json',
        contentDigest: sha256(content) } },
      transport
    );

    const diff = `diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n`;
    const checkpoint: ReviewExecutionCheckpoint = {
      version: 'ReviewExecutionCheckpoint.v1',
      runId: `run_${'6'.repeat(32)}`,
      repositoryId: 1339040553,
      owner: 'exampleorg',
      repo: 'example-meta',
      prNumber: 2795,
      headSha: COMMIT_SHA_A,
      baseSha: BASE_SHA_A,
      policyDigest: 'mismatched_policy_digest'.padEnd(64, '0'),
      configDigest: prepared.policy.effectiveConfigDigest,
      executionAttempt: 1,
      revision: 1,
      plan: [],
      completedTasks: [],
    };

    const workerEnvMismatch = {
      NODE_ENV: 'test',
      REVIEW_PUBLICATION_MODE: 'app-gate',
      REVIEW_AUTHORITATIVE_GATE: 'true',
      REVIEW_RUN_ID: `run_${'c'.repeat(32)}`,
      REVIEW_REPO: 'exampleorg/example-meta',
      REVIEW_REPOSITORY_ID: '1339040553',
      REVIEW_PR_NUMBER: '2795',
      REVIEW_HEAD_SHA: COMMIT_SHA_B,
      REVIEW_BASE_SHA: BASE_SHA_A,
      REVIEW_POLICY_DIGEST: prepared.policy.effectivePolicyDigest,
      REVIEW_CONFIG_DIGEST: prepared.policy.effectiveConfigDigest,
      REVIEW_PREPARED_CONFIG_JSON: JSON.stringify({ version: 'PreparedReviewExecution.v1', config: prepared.config, transport }),
      REVIEW_MODEL: transport.model,
      OPENAI_BASE_URL: transport.baseUrl,
      OPENAI_API_KEY: 'vk-test',
      GH_TOKEN: 'ghs_test',
      GITHUB_PUBLISH_TOKEN: 'ghs_fake',
      REVIEW_COMPLETION_URL: 'https://dispatch.example.invalid/api/dispatch/completion',
      REVIEW_REPOSITORY_VISIBILITY: 'PRIVATE',
      REVIEW_EXECUTION_ATTEMPT: '1',
    };

    await expect(
      runPublishingReviewWorker(
        workerEnvMismatch as any,
        {
          checkClient: { createCheck: vi.fn(async () => 4242), completeCheck: vi.fn() },
          currentPullRequestVerifier: vi.fn(async () => undefined),
          composedReviewRunner: vi.fn(),
          reviewCheckpoint: { read: vi.fn(async () => ({ checkpoint, disputedFindingRechecks: [] })), write: vi.fn() },
          reviewCompletion: { reportReviewResult: vi.fn() },
          groundedVerifierClient: groundedFixtureClient,
          repoFileProviderFactory: (input: any) => groundedFixtureProvider(input),
          visibilityLookup: vi.fn(async () => 'PRIVATE' as const),
          sourceLoader: vi.fn(async () => ({
            baseSha: BASE_SHA_A,
            headSha: COMMIT_SHA_B,
            diff,
            diffDigest: sha256(diff),
            githubReads: 0,
          })),
          ...enableLifecycleHistory({
            policyDigest: prepared.policy.effectivePolicyDigest,
            configDigest: prepared.policy.effectiveConfigDigest,
            currentHeadSha: COMMIT_SHA_B,
            priorHeadSha: COMMIT_SHA_A,
            baseSha: BASE_SHA_A,
          }),
        } as any
      )
    ).rejects.toThrow('Review execution checkpoint does not match this exact-head review');
  });
});
