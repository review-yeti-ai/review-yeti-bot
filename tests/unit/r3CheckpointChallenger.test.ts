import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  runPublishingReviewWorker,
  parseChangedFiles,
} from '../../src/cli/publishingReview';
import { preparePublishingPolicy } from '../../src/review/preparedPublishingPolicy';
import { ComposedRuntimeResourceObserver } from '../../src/panel/composedResourceReceipt';
import { TaskSourceDelivery, validateTaskSourceReceipt } from '../../src/review/taskSourceDelivery';
import { executeComposedReview } from '../../src/panel/composedEngine';
import { parseAndValidateConfig } from '../../src/config/configLoader';
import { buildDeterministicCoverageManifest } from '../../src/review/groundedReviewEngine';
import {
  buildDeterministicReviewPlanningContext,
  enrichTasksWithPlanningContext,
  reviewTaskCharterDigest,
} from '../../src/review/prReviewPlanningContext';
import type { ReviewTask } from '../../src/panel/reviewTask';
import type { ReviewExecutionCheckpoint } from '../../src/review/reviewExecutionCheckpoint';
import { groundedFixtureClient, groundedFixtureProvider } from '../support/groundedReviewFixture';

const BASE = 'b'.repeat(40);
const COMMIT_SHA_ORIGINAL = '1'.repeat(40);
const COMMIT_SHA_AMENDED  = '2'.repeat(40);

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    REVIEW_PUBLICATION_MODE: 'app-gate',
    REVIEW_RUN_ID: `run_${'c'.repeat(32)}`,
    REVIEW_REPO: 'exampleorg/example-meta',
    REVIEW_REPOSITORY_ID: '1339040553',
    REVIEW_POLICY_DIGEST: 'c'.repeat(64),
    REVIEW_CONFIG_DIGEST: 'd'.repeat(64),
    REVIEW_EXECUTION_ATTEMPT: '1',
    REVIEW_PR_NUMBER: '2795',
    REVIEW_HEAD_SHA: COMMIT_SHA_AMENDED,
    REVIEW_BASE_SHA: BASE,
    REVIEW_MODEL: 'prepared-review-model',
    OPENAI_BASE_URL: 'https://gateway.example.invalid/v1',
    OPENAI_API_KEY: 'vk-test',
    GH_TOKEN: 'ghs_test',
    ...overrides,
  };
}

function checkClient() {
  return {
    createCheck: vi.fn(async () => 4242),
    completeCheck: vi.fn(async () => {}),
  };
}

function deps(over: Record<string, unknown> = {}) {
  const defaultRepoFileProviderFactory = (input: {
    owner: string; repo: string; headSha: string; baseSha: string;
    changedFiles: Array<{ path: string; patch?: string }>;
  }) => groundedFixtureProvider(input);

  return {
    checkClient: checkClient(),
    currentPullRequestVerifier: vi.fn(async () => undefined),
    sourceLoader: vi.fn(async () => ({ diff: '', githubReads: 1 })) as never,
    visibilityLookup: vi.fn(async () => 'PRIVATE' as const),
    panelRunner: vi.fn(async () => ({
      applicablePersonaIds: ['sec-lane'],
      personas: [{ id: 'sec-lane', findings: [] }],
      optionalFailures: [],
      quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
      arbiter: { verdict: 'SHIP' },
    })) as never,
    client: {} as never,
    groundedVerifierClient: groundedFixtureClient as never,
    repoFileProviderFactory: defaultRepoFileProviderFactory as never,
    ...over,
  };
}

function setupPolicyAndPrepared() {
  const content = JSON.stringify({
    schema: 'exampleorg.review-policy.v1',
    review_yeti: { personas: 'security,testing', review_engine: 'composed', budget: { max_investigation_turns: 1 } },
  });
  const transport = { baseUrl: 'https://gateway.example.invalid/v1', model: 'prepared-review-model' };
  const prepared = preparePublishingPolicy(
    {
      content,
      source: {
        repositoryId: 987,
        repository: 'exampleorg/repo',
        sha: 'e'.repeat(40),
        path: 'policy/review.json',
        contentDigest: createHash('sha256').update(content).digest('hex'),
      },
    },
    transport
  );
  return { prepared, transport };
}

describe('Empirical Challenger: Retry Safety Fences, Policy Invalidation & Fail-Closed Security', () => {
  const sourceDiff = `diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old();\n+new();\n`;
  const parsedFiles = parseChangedFiles(sourceDiff).files;
  const plan = [{ id: 'task-a', dimension: 'security' as const, paths: ['src/a.ts'], question: 'Safe?', rationale: 'Risk.' }];

  const delivery = new TaskSourceDelivery({
    taskId: 'task-a',
    paths: ['src/a.ts'],
    files: parsedFiles,
    prefix: sourceDiff,
    inlinedPaths: ['src/a.ts'],
    headSha: COMMIT_SHA_ORIGINAL,
    baseSha: BASE,
  });
  delivery.beginAttempt();
  const receipt = delivery.acknowledgeRequest([{ role: 'user', content: sourceDiff }]);

  // =========================================================================
  // PILLAR 1: executionAttempt > 1 Cross-Head Checkpoint Rejection & Retry Fence
  // =========================================================================
  describe('Pillar 1: executionAttempt > 1 Retry Safety Fence', () => {
    it('CHALLENGE_01: executionAttempt > 1 throws if checkpoint headSha does not match current headSha', async () => {
      const { prepared, transport } = setupPolicyAndPrepared();

      const workerInput = env({
        REVIEW_AUTHORITATIVE_GATE: 'true',
        REVIEW_HEAD_SHA: COMMIT_SHA_AMENDED, // Current head is SHA_AMENDED
        REVIEW_EXECUTION_ATTEMPT: '2',        // Attempt 2 (retry)
        REVIEW_POLICY_DIGEST: prepared.policy.effectivePolicyDigest,
        REVIEW_CONFIG_DIGEST: prepared.policy.effectiveConfigDigest,
        REVIEW_PREPARED_CONFIG_JSON: JSON.stringify({ version: 'PreparedReviewExecution.v1', config: prepared.config, transport }),
        REVIEW_MODEL: transport.model,
        OPENAI_BASE_URL: transport.baseUrl,
        GITHUB_PUBLISH_TOKEN: 'ghs_fake',
        REVIEW_COMPLETION_URL: 'https://dispatch.example.invalid/api/dispatch/completion',
        REVIEW_REPOSITORY_VISIBILITY: 'PRIVATE',
      });

      // Checkpoint was recorded on COMMIT_SHA_ORIGINAL (cross-head!)
      const checkpoint: ReviewExecutionCheckpoint = {
        version: 'ReviewExecutionCheckpoint.v1',
        runId: String(workerInput.REVIEW_RUN_ID),
        repositoryId: 1339040553,
        owner: 'exampleorg',
        repo: 'example-meta',
        prNumber: 2795,
        headSha: COMMIT_SHA_ORIGINAL,
        baseSha: BASE,
        policyDigest: prepared.policy.effectivePolicyDigest,
        configDigest: prepared.policy.effectiveConfigDigest,
        executionAttempt: 1,
        revision: 1,
        plan,
        completedTasks: [{ id: 'task-a', findings: [], sourceDelivery: receipt }],
      };

      const composedReviewRunner = vi.fn();
      const readCheckpoint = vi.fn(async () => ({ checkpoint, disputedFindingRechecks: [] }));

      await expect(
        runPublishingReviewWorker(
          workerInput,
          deps({
            composedReviewRunner,
            reviewCheckpoint: { read: readCheckpoint, write: vi.fn(async () => 2) },
            reviewCompletion: { reportReviewResult: vi.fn(async () => {}) },
            sourceLoader: vi.fn(async () => ({
              baseSha: BASE,
              headSha: COMMIT_SHA_AMENDED,
              diff: sourceDiff,
              diffDigest: createHash('sha256').update(sourceDiff).digest('hex'),
              githubReads: 0,
            })),
          }) as never
        )
      ).rejects.toThrow('Exact-head checkpoint and disputed finding requests are required for a safe retry');

      expect(composedReviewRunner).not.toHaveBeenCalled();
    });

    it('CHALLENGE_02: executionAttempt > 1 throws if checkpoint read fails from store', async () => {
      const { prepared, transport } = setupPolicyAndPrepared();

      const workerInput = env({
        REVIEW_AUTHORITATIVE_GATE: 'true',
        REVIEW_HEAD_SHA: COMMIT_SHA_AMENDED,
        REVIEW_EXECUTION_ATTEMPT: '2',
        REVIEW_POLICY_DIGEST: prepared.policy.effectivePolicyDigest,
        REVIEW_CONFIG_DIGEST: prepared.policy.effectiveConfigDigest,
        REVIEW_PREPARED_CONFIG_JSON: JSON.stringify({ version: 'PreparedReviewExecution.v1', config: prepared.config, transport }),
        REVIEW_MODEL: transport.model,
        OPENAI_BASE_URL: transport.baseUrl,
        GITHUB_PUBLISH_TOKEN: 'ghs_fake',
        REVIEW_COMPLETION_URL: 'https://dispatch.example.invalid/api/dispatch/completion',
        REVIEW_REPOSITORY_VISIBILITY: 'PRIVATE',
      });

      const readCheckpoint = vi.fn(async () => {
        throw new Error('Connection refused to checkpoint store');
      });

      await expect(
        runPublishingReviewWorker(
          workerInput,
          deps({
            reviewCheckpoint: { read: readCheckpoint, write: vi.fn(async () => 2) },
            reviewCompletion: { reportReviewResult: vi.fn(async () => {}) },
            sourceLoader: vi.fn(async () => ({
              baseSha: BASE,
              headSha: COMMIT_SHA_AMENDED,
              diff: sourceDiff,
              diffDigest: createHash('sha256').update(sourceDiff).digest('hex'),
              githubReads: 0,
            })),
          }) as never
        )
      ).rejects.toThrow('Exact-head checkpoint and disputed finding requests are required for a safe retry');
    });

    it('CHALLENGE_03: executionAttempt > 1 throws if checkpoint runId differs', async () => {
      const { prepared, transport } = setupPolicyAndPrepared();

      const workerInput = env({
        REVIEW_AUTHORITATIVE_GATE: 'true',
        REVIEW_RUN_ID: `run_${'1'.repeat(32)}`,
        REVIEW_HEAD_SHA: COMMIT_SHA_ORIGINAL,
        REVIEW_EXECUTION_ATTEMPT: '3',
        REVIEW_POLICY_DIGEST: prepared.policy.effectivePolicyDigest,
        REVIEW_CONFIG_DIGEST: prepared.policy.effectiveConfigDigest,
        REVIEW_PREPARED_CONFIG_JSON: JSON.stringify({ version: 'PreparedReviewExecution.v1', config: prepared.config, transport }),
        REVIEW_MODEL: transport.model,
        OPENAI_BASE_URL: transport.baseUrl,
        GITHUB_PUBLISH_TOKEN: 'ghs_fake',
        REVIEW_COMPLETION_URL: 'https://dispatch.example.invalid/api/dispatch/completion',
        REVIEW_REPOSITORY_VISIBILITY: 'PRIVATE',
      });

      const checkpoint: ReviewExecutionCheckpoint = {
        version: 'ReviewExecutionCheckpoint.v1',
        runId: `run_${'2'.repeat(32)}`, // Different runId!
        repositoryId: 1339040553,
        owner: 'exampleorg',
        repo: 'example-meta',
        prNumber: 2795,
        headSha: COMMIT_SHA_ORIGINAL,
        baseSha: BASE,
        policyDigest: prepared.policy.effectivePolicyDigest,
        configDigest: prepared.policy.effectiveConfigDigest,
        executionAttempt: 2,
        revision: 1,
        plan,
        completedTasks: [{ id: 'task-a', findings: [], sourceDelivery: receipt }],
      };

      const readCheckpoint = vi.fn(async () => ({ checkpoint, disputedFindingRechecks: [] }));

      await expect(
        runPublishingReviewWorker(
          workerInput,
          deps({
            reviewCheckpoint: { read: readCheckpoint, write: vi.fn(async () => 2) },
            reviewCompletion: { reportReviewResult: vi.fn(async () => {}) },
            sourceLoader: vi.fn(async () => ({
              baseSha: BASE,
              headSha: COMMIT_SHA_ORIGINAL,
              diff: sourceDiff,
              diffDigest: createHash('sha256').update(sourceDiff).digest('hex'),
              githubReads: 0,
            })),
          }) as never
        )
      ).rejects.toThrow('Exact-head checkpoint and disputed finding requests are required for a safe retry');
    });
  });

  // =========================================================================
  // PILLAR 2: Policy and Config Digest Mismatch Rejection & Stale Finding Leak Prevention
  // =========================================================================
  describe('Pillar 2: Policy/Config Digest Mismatch Rejection & Stale Findings Prevention', () => {
    it('CHALLENGE_04: Rejects checkpoint when policyDigest differs and does NOT leak stale findings (executionAttempt === 1)', async () => {
      const { prepared, transport } = setupPolicyAndPrepared();

      const workerInput = env({
        REVIEW_AUTHORITATIVE_GATE: 'true',
        REVIEW_HEAD_SHA: COMMIT_SHA_ORIGINAL,
        REVIEW_EXECUTION_ATTEMPT: '1',
        REVIEW_POLICY_DIGEST: prepared.policy.effectivePolicyDigest,
        REVIEW_CONFIG_DIGEST: prepared.policy.effectiveConfigDigest,
        REVIEW_PREPARED_CONFIG_JSON: JSON.stringify({ version: 'PreparedReviewExecution.v1', config: prepared.config, transport }),
        REVIEW_MODEL: transport.model,
        OPENAI_BASE_URL: transport.baseUrl,
        GITHUB_PUBLISH_TOKEN: 'ghs_fake',
        REVIEW_COMPLETION_URL: 'https://dispatch.example.invalid/api/dispatch/completion',
        REVIEW_REPOSITORY_VISIBILITY: 'PRIVATE',
      });

      // Checkpoint from a previous run had an OLD policy digest and contained a stale P0 finding!
      const staleFinding = {
        severity: 'P0' as const,
        path: 'src/a.ts',
        line: 1,
        title: 'Stale critical finding',
        body: 'This finding belongs to an outdated policy.',
      };

      const checkpoint: ReviewExecutionCheckpoint = {
        version: 'ReviewExecutionCheckpoint.v1',
        runId: String(workerInput.REVIEW_RUN_ID),
        repositoryId: 1339040553,
        owner: 'exampleorg',
        repo: 'example-meta',
        prNumber: 2795,
        headSha: COMMIT_SHA_ORIGINAL,
        baseSha: BASE,
        policyDigest: 'f'.repeat(64), // MISMATCHED POLICY DIGEST!
        configDigest: prepared.policy.effectiveConfigDigest,
        executionAttempt: 1,
        revision: 1,
        plan,
        completedTasks: [{ id: 'task-a', findings: [staleFinding as any], sourceDelivery: receipt }],
      };

      const composedReviewRunner = vi.fn();
      const readCheckpoint = vi.fn(async () => ({ checkpoint, disputedFindingRechecks: [] }));

      await expect(
        runPublishingReviewWorker(
          workerInput,
          deps({
            composedReviewRunner,
            reviewCheckpoint: { read: readCheckpoint, write: vi.fn(async () => 2) },
            reviewCompletion: { reportReviewResult: vi.fn(async () => {}) },
            sourceLoader: vi.fn(async () => ({
              baseSha: BASE,
              headSha: COMMIT_SHA_ORIGINAL,
              diff: sourceDiff,
              diffDigest: createHash('sha256').update(sourceDiff).digest('hex'),
              githubReads: 0,
            })),
          }) as never
        )
      ).rejects.toThrow('Review execution checkpoint does not match this exact-head review');

      // The runner was NEVER called with the stale finding
      expect(composedReviewRunner).not.toHaveBeenCalled();
    });

    it('CHALLENGE_05: Rejects checkpoint when configDigest differs and does NOT leak stale findings (executionAttempt === 1)', async () => {
      const { prepared, transport } = setupPolicyAndPrepared();

      const workerInput = env({
        REVIEW_AUTHORITATIVE_GATE: 'true',
        REVIEW_HEAD_SHA: COMMIT_SHA_ORIGINAL,
        REVIEW_EXECUTION_ATTEMPT: '1',
        REVIEW_POLICY_DIGEST: prepared.policy.effectivePolicyDigest,
        REVIEW_CONFIG_DIGEST: prepared.policy.effectiveConfigDigest,
        REVIEW_PREPARED_CONFIG_JSON: JSON.stringify({ version: 'PreparedReviewExecution.v1', config: prepared.config, transport }),
        REVIEW_MODEL: transport.model,
        OPENAI_BASE_URL: transport.baseUrl,
        GITHUB_PUBLISH_TOKEN: 'ghs_fake',
        REVIEW_COMPLETION_URL: 'https://dispatch.example.invalid/api/dispatch/completion',
        REVIEW_REPOSITORY_VISIBILITY: 'PRIVATE',
      });

      const checkpoint: ReviewExecutionCheckpoint = {
        version: 'ReviewExecutionCheckpoint.v1',
        runId: String(workerInput.REVIEW_RUN_ID),
        repositoryId: 1339040553,
        owner: 'exampleorg',
        repo: 'example-meta',
        prNumber: 2795,
        headSha: COMMIT_SHA_ORIGINAL,
        baseSha: BASE,
        policyDigest: prepared.policy.effectivePolicyDigest,
        configDigest: '9'.repeat(64), // MISMATCHED CONFIG DIGEST!
        executionAttempt: 1,
        revision: 1,
        plan,
        completedTasks: [{ id: 'task-a', findings: [], sourceDelivery: receipt }],
      };

      const composedReviewRunner = vi.fn();
      const readCheckpoint = vi.fn(async () => ({ checkpoint, disputedFindingRechecks: [] }));

      await expect(
        runPublishingReviewWorker(
          workerInput,
          deps({
            composedReviewRunner,
            reviewCheckpoint: { read: readCheckpoint, write: vi.fn(async () => 2) },
            reviewCompletion: { reportReviewResult: vi.fn(async () => {}) },
            sourceLoader: vi.fn(async () => ({
              baseSha: BASE,
              headSha: COMMIT_SHA_ORIGINAL,
              diff: sourceDiff,
              diffDigest: createHash('sha256').update(sourceDiff).digest('hex'),
              githubReads: 0,
            })),
          }) as never
        )
      ).rejects.toThrow('Review execution checkpoint does not match this exact-head review');

      expect(composedReviewRunner).not.toHaveBeenCalled();
    });

    it('CHALLENGE_06: executionAttempt > 1 throws if policyDigest or configDigest differs', async () => {
      const { prepared, transport } = setupPolicyAndPrepared();

      const workerInput = env({
        REVIEW_AUTHORITATIVE_GATE: 'true',
        REVIEW_HEAD_SHA: COMMIT_SHA_ORIGINAL,
        REVIEW_EXECUTION_ATTEMPT: '2',
        REVIEW_POLICY_DIGEST: prepared.policy.effectivePolicyDigest,
        REVIEW_CONFIG_DIGEST: prepared.policy.effectiveConfigDigest,
        REVIEW_PREPARED_CONFIG_JSON: JSON.stringify({ version: 'PreparedReviewExecution.v1', config: prepared.config, transport }),
        REVIEW_MODEL: transport.model,
        OPENAI_BASE_URL: transport.baseUrl,
        GITHUB_PUBLISH_TOKEN: 'ghs_fake',
        REVIEW_COMPLETION_URL: 'https://dispatch.example.invalid/api/dispatch/completion',
        REVIEW_REPOSITORY_VISIBILITY: 'PRIVATE',
      });

      const checkpoint: ReviewExecutionCheckpoint = {
        version: 'ReviewExecutionCheckpoint.v1',
        runId: String(workerInput.REVIEW_RUN_ID),
        repositoryId: 1339040553,
        owner: 'exampleorg',
        repo: 'example-meta',
        prNumber: 2795,
        headSha: COMMIT_SHA_ORIGINAL,
        baseSha: BASE,
        policyDigest: 'e'.repeat(64), // Mismatched policy digest on attempt 2!
        configDigest: prepared.policy.effectiveConfigDigest,
        executionAttempt: 1,
        revision: 1,
        plan,
        completedTasks: [{ id: 'task-a', findings: [], sourceDelivery: receipt }],
      };

      const readCheckpoint = vi.fn(async () => ({ checkpoint, disputedFindingRechecks: [] }));

      await expect(
        runPublishingReviewWorker(
          workerInput,
          deps({
            reviewCheckpoint: { read: readCheckpoint, write: vi.fn(async () => 2) },
            reviewCompletion: { reportReviewResult: vi.fn(async () => {}) },
            sourceLoader: vi.fn(async () => ({
              baseSha: BASE,
              headSha: COMMIT_SHA_ORIGINAL,
              diff: sourceDiff,
              diffDigest: createHash('sha256').update(sourceDiff).digest('hex'),
              githubReads: 0,
            })),
          }) as never
        )
      ).rejects.toThrow('Exact-head checkpoint and disputed finding requests are required for a safe retry');
    });

    it('CHALLENGE_07: Composed engine drops cached task when charterDigest changed and runs fresh model turn', async () => {
      const fileMath = {
        path: 'src/math.ts',
        patch: '@@ -1,3 +1,3 @@\n-const x = 1;\n+const x = 2;\n',
      };
      const changedFiles = [fileMath];

      const parsedConfig = parseAndValidateConfig(`
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
      const cfg = parsedConfig as any;
      cfg.pre_checks = { zoekt: { enabled: false }, symbolAppendix: { enabled: false }, analyzers: { enabled: false } };
      cfg.composed = { max_tasks: 4, max_turns_total: 20 };

      const taskPlan: ReviewTask[] = [
        {
          id: 'math-task',
          dimension: 'testing',
          paths: [fileMath.path],
          question: 'Verify arithmetic logic.',
          rationale: 'Arithmetic logic changed.',
        },
      ];

      const deliveryMath = new TaskSourceDelivery({
        taskId: 'math-task',
        paths: [fileMath.path],
        files: changedFiles,
        headSha: COMMIT_SHA_ORIGINAL,
        baseSha: BASE,
        prefix: fileMath.patch,
        inlinedPaths: [fileMath.path],
      }).acknowledgeRequest([{ role: 'user', content: fileMath.patch }]);

      // Checkpoint has a stale charterDigest that does NOT match current plan!
      const checkpoint: ReviewExecutionCheckpoint = {
        version: 'ReviewExecutionCheckpoint.v1',
        runId: `run_${'1'.repeat(32)}`,
        repositoryId: 4242,
        owner: 'exampleorg',
        repo: 'example-repo',
        prNumber: 99,
        headSha: COMMIT_SHA_ORIGINAL,
        baseSha: BASE,
        policyDigest: 'a'.repeat(64),
        configDigest: 'b'.repeat(64),
        executionAttempt: 1,
        revision: 1,
        plan: taskPlan,
        plannerPlan: taskPlan,
        completedTasks: [
          {
            id: 'math-task',
            findings: [{
              severity: 'P2',
              path: 'src/math.ts',
              line: 1,
              title: 'Stale cached finding',
              body: 'Should never appear because charter changed',
            }],
            charterDigest: '0'.repeat(64), // STALE CHARTER DIGEST!
            sourceDelivery: deliveryMath,
          },
        ],
      };

      let llmCalls = 0;
      const complete = vi.fn(async (request: any) => {
        const messages = request.messages;
        const text = messages.flatMap((m: any) =>
          typeof m.content === 'string'
            ? [m.content]
            : Array.isArray(m.content)
            ? m.content.flatMap((b: any) => (typeof b.text === 'string' ? [b.text] : []))
            : []
        ).join('\n');
        const nonce = text.match(/CT_REVIEW_NONCE:([a-f0-9-]+)/u)?.[1] ?? 'test-nonce';

        if (text.includes('Task id: math-task')) {
          llmCalls++;
          return {
            model: 'codex/gpt-5.6-sol-high',
            content: JSON.stringify({ nonce, task: 'math-task', status: 'COMPLETE', findings: [] }),
            usage: { prompt: 100, completion: 20, total: 120 },
            costUSD: 0.001,
            raw: {},
          };
        }

        return {
          model: 'codex/gpt-5.6-sol-high',
          content: JSON.stringify({ nonce, verdict: 'SHIP', rationale: 'Approved freshly.' }),
          usage: { prompt: 100, completion: 20, total: 120 },
          costUSD: 0.001,
          raw: {},
        };
      });

      const result = await executeComposedReview({
        config: cfg,
        changedFiles,
        repository: 'exampleorg/example-repo',
        headSha: COMMIT_SHA_ORIGINAL,
        baseSha: BASE,
        client: { complete } as any,
        checkpoint: { resumed: checkpoint, save: async () => {} },
      });

      // Because charterDigest mismatched, the cached task was ignored and re-executed!
      expect(llmCalls).toBe(1);
      // The stale finding was NOT retained!
      const mathPersona = result.personas.find((p) => p.id === 'math-task');
      expect(mathPersona?.findings).toEqual([]);
    });

    it('CHALLENGE_08: validateTaskSourceReceipt invalidates if file patchDigest does not match current source', () => {
      const originalPatch = '@@ -1 +1 @@\n-old\n+new\n';
      const modifiedPatch = '@@ -1 +1 @@\n-old\n+different\n';

      const fileOriginal = { path: 'src/a.ts', patch: originalPatch };
      const fileModified = { path: 'src/a.ts', patch: modifiedPatch };

      const delivery = new TaskSourceDelivery({
        taskId: 'test-task',
        paths: ['src/a.ts'],
        files: [fileOriginal],
        prefix: originalPatch,
        inlinedPaths: ['src/a.ts'],
        headSha: COMMIT_SHA_ORIGINAL,
        baseSha: BASE,
      });
      delivery.beginAttempt();
      const receipt = delivery.acknowledgeRequest([{ role: 'user', content: originalPatch }]);

      // Attempt validation against modified source file
      const validated = validateTaskSourceReceipt(receipt, {
        taskId: 'test-task',
        paths: ['src/a.ts'],
        files: [fileModified],
        headSha: COMMIT_SHA_AMENDED,
        baseSha: BASE,
        allowContentAddressed: true,
      });

      expect(validated).toBeNull();
    });

    it('CHALLENGE_09: validateTaskSourceReceipt rejects differing SHA when allowContentAddressed is false', () => {
      const patch = '@@ -1 +1 @@\n-old\n+new\n';
      const file = { path: 'src/a.ts', patch };

      const delivery = new TaskSourceDelivery({
        taskId: 'test-task',
        paths: ['src/a.ts'],
        files: [file],
        prefix: patch,
        inlinedPaths: ['src/a.ts'],
        headSha: COMMIT_SHA_ORIGINAL,
        baseSha: BASE,
      });
      delivery.beginAttempt();
      const receipt = delivery.acknowledgeRequest([{ role: 'user', content: patch }]);

      // Head differs, and allowContentAddressed is false (default)
      const validated = validateTaskSourceReceipt(receipt, {
        taskId: 'test-task',
        paths: ['src/a.ts'],
        files: [file],
        headSha: COMMIT_SHA_AMENDED,
        baseSha: BASE,
        allowContentAddressed: false,
      });

      expect(validated).toBeNull();
    });
  });
});
