import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  TriggerReviewInputSchema,
  ReviewEngineParamSchema,
} from '../../src/mcp/server/tools/schemas';
import { createTriggerReviewTool } from '../../src/mcp/server/tools/triggerReview';
import {
  preparePublishingPolicy,
  verifyPreparedPublishingConfig,
} from '../../src/review/preparedPublishingPolicy';
import { AuthoritativePublishingResolver } from '../../src/review/authoritativePublishingResolver';
import {
  fingerprintEffectiveReviewConfig,
  buildAuthoritativeReviewIdentity,
} from '../../src/review/authoritativeReviewIdentity';
import { runPublishingReviewWorker, type PublishingCheckClient, type PublishingReviewDeps } from '../../src/cli/publishingReview';
import { PostgresStore } from '../../src/persistence/postgresStore';
import { PostgresReviewDispatchRepository } from '../../src/persistence/reviewDispatchRepository';
import type { ReviewRunIdentity } from '../../src/review/reviewRun';
import type { PanelResult } from '../../src/panel/types';
import type { WorkerReviewCompletionAdapter } from '../../src/review/workerReviewCompletionHttp';
import { logger } from '../../src/utils/logger';

const HEAD_SHA = '1111111111111111111111111111111111111111';
const BASE_SHA = '2222222222222222222222222222222222222222';
const REPO_ID = 190468701;
const APP_ID = 4385771;

function makeSamplePolicyFile(reviewEngine?: 'composed' | 'panel') {
  const rawContent = JSON.stringify({
    schema: 'calltelemetry.review-policy.v1',
    review_yeti: {
      personas: 'security,architecture,perf',
      budget: { max_investigation_turns: 5 },
      ...(reviewEngine ? { review_engine: reviewEngine } : {}),
    },
  });
  const contentDigest = createHash('sha256').update(rawContent).digest('hex');
  return {
    source: {
      repositoryId: REPO_ID,
      repository: 'calltelemetry/cisco-cdr',
      sha: HEAD_SHA,
      path: '.calltelemetry/review-policy.json',
      contentDigest,
    },
    content: rawContent,
  };
}

const sampleTransport = {
  baseUrl: 'https://bifrost.internal.calltelemetry.com',
  model: 'deepseek/deepseek-v4-flash-0731',
};

describe('Milestone 2 Challenger Stress Suite: Review Engine Selection on trigger_review', () => {

  // =========================================================================
  // SUITE 1: Schema Invariant & Strict Boundary Testing
  // =========================================================================
  describe('SUITE 1: TriggerReviewInputSchema & ReviewEngineParamSchema bounds', () => {
    it('EMP-M2-SCH-01: admits valid engine values (composed, panel) and optional omission', () => {
      const basePayload = {
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pull_number: 100,
        head_sha: HEAD_SHA,
      };

      const resComposed = TriggerReviewInputSchema.safeParse({ ...basePayload, review_engine: 'composed' });
      expect(resComposed.success).toBe(true);
      if (resComposed.success) {
        expect(resComposed.data.review_engine).toBe('composed');
      }

      const resPanel = TriggerReviewInputSchema.safeParse({ ...basePayload, review_engine: 'panel' });
      expect(resPanel.success).toBe(true);
      if (resPanel.success) {
        expect(resPanel.data.review_engine).toBe('panel');
      }

      const resOmitted = TriggerReviewInputSchema.safeParse(basePayload);
      expect(resOmitted.success).toBe(true);
      if (resOmitted.success) {
        expect(resOmitted.data.review_engine).toBeUndefined();
      }
    });

    it('EMP-M2-SCH-02: rejects invalid casing (COMPOSED, PANEL, Composed, Panel)', () => {
      const basePayload = {
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pull_number: 100,
        head_sha: HEAD_SHA,
      };

      for (const invalidCase of ['COMPOSED', 'PANEL', 'Composed', 'Panel']) {
        const res = TriggerReviewInputSchema.safeParse({ ...basePayload, review_engine: invalidCase });
        expect(res.success).toBe(false);
      }
    });

    it('EMP-M2-SCH-03: rejects unpermitted engines (shadow, hybrid, auto, v2, empty string)', () => {
      const basePayload = {
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pull_number: 100,
        head_sha: HEAD_SHA,
      };

      for (const unpermitted of ['shadow', 'hybrid', 'auto', 'v2', '', '   ']) {
        const res = TriggerReviewInputSchema.safeParse({ ...basePayload, review_engine: unpermitted });
        expect(res.success).toBe(false);
      }
    });

    it('EMP-M2-SCH-04: rejects non-string types and prototype pollution keys in strict mode', () => {
      const basePayload = {
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pull_number: 100,
        head_sha: HEAD_SHA,
      };

      expect(TriggerReviewInputSchema.safeParse({ ...basePayload, review_engine: 123 }).success).toBe(false);
      expect(TriggerReviewInputSchema.safeParse({ ...basePayload, review_engine: true }).success).toBe(false);
      expect(TriggerReviewInputSchema.safeParse({ ...basePayload, review_engine: null }).success).toBe(false);
      expect(TriggerReviewInputSchema.safeParse({ ...basePayload, review_engine: ['composed'] }).success).toBe(false);
      expect(TriggerReviewInputSchema.safeParse({ ...basePayload, review_engine: { name: 'composed' } }).success).toBe(false);

      // Strict mode rejects unexpected properties even with valid review_engine
      expect(TriggerReviewInputSchema.safeParse({
        ...basePayload,
        review_engine: 'composed',
        unknown_key: 'malicious',
      }).success).toBe(false);
    });
  });

  // =========================================================================
  // SUITE 2: Cryptographic Policy & Digest Re-Fingerprinting Coherence
  // =========================================================================
  describe('SUITE 2: Authoritative admission re-fingerprinting and config coherence', () => {
    it('EMP-M2-CRYPTO-01: re-fingerprints prepared policy and matches verifyPreparedPublishingConfig', async () => {
      const policyFile = makeSamplePolicyFile();
      const preparedPolicy = preparePublishingPolicy(policyFile, sampleTransport);

      const candidate = {
        repositoryId: REPO_ID,
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        prNumber: 500,
        headSha: HEAD_SHA,
        baseSha: BASE_SHA,
      };

      let capturedAdmissionInput: any = null;
      const admit = vi.fn(async (input: any) => {
        capturedAdmissionInput = input;
        return { run: { runId: `run_${'f'.repeat(32)}` } };
      });

      const resolve = vi.fn(async (req: any) => {
        const identity = buildAuthoritativeReviewIdentity({
          requested: candidate,
          current: { ...candidate, open: true, draft: false },
          policy: preparedPolicy.policy,
        });
        return {
          identity,
          prepared: {
            policy: { ...preparedPolicy.policy },
            config: { ...preparedPolicy.config },
            expectedPersonaIds: [...preparedPolicy.expectedPersonaIds],
            transport: { ...preparedPolicy.transport },
          },
          current: { ...candidate, open: true, draft: false },
        };
      });

      const tool = createTriggerReviewTool({
        queryableDatabase: { query: vi.fn(async () => ({ rows: [] })) },
        admissionRepository: { admit } as any,
        resolveGitHubPullRequest: vi.fn(async () => ({
          headSha: HEAD_SHA,
          baseSha: BASE_SHA,
          repositoryId: REPO_ID,
          installationId: 2001,
        })),
        authoritativePublishing: {
          expectedAppId: APP_ID,
          repositoryIds: [REPO_ID],
          resolver: { resolve },
        },
        now: () => 1_790_060_000_000,
      } as any);

      // Execute with explicit composed engine
      const res = await tool.execute({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pull_number: 500,
        head_sha: HEAD_SHA,
        review_engine: 'composed',
      });

      expect(admit).toHaveBeenCalledOnce();
      expect(capturedAdmissionInput).toBeDefined();
      expect(capturedAdmissionInput.reviewEngine).toBe('composed');

      const admittedGate = capturedAdmissionInput.authoritativeGate;
      expect(admittedGate).toBeDefined();
      expect(admittedGate.prepared.config.review_engine).toBe('composed');

      // CRITICAL CRYPTOGRAPHIC INVARIANT VERIFICATION:
      // verifyPreparedPublishingConfig MUST accept the admitted config when tested against
      // the re-computed effectiveConfigDigest and selected transport!
      const effectiveConfigDigest = admittedGate.prepared.policy.effectiveConfigDigest;
      expect(effectiveConfigDigest).toMatch(/^[a-f0-9]{64}$/);

      // Must not throw when verified against authoritative parser!
      expect(() => {
        verifyPreparedPublishingConfig(
          admittedGate.prepared.config,
          effectiveConfigDigest,
          admittedGate.prepared.transport,
        );
      }).not.toThrow();

      // Output text checks
      const data = JSON.parse((res.content[0] as any).text);
      expect(data.dispatched).toBe(true);
      expect(data.message).toContain('engine: composed');
    });

    it('EMP-M2-CRYPTO-02: preserves unchanged digests and skips engine injection when review_engine is omitted', async () => {
      const policyFile = makeSamplePolicyFile();
      const preparedPolicy = preparePublishingPolicy(policyFile, sampleTransport);

      const candidate = {
        repositoryId: REPO_ID,
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        prNumber: 501,
        headSha: HEAD_SHA,
        baseSha: BASE_SHA,
      };

      const originalConfigDigest = preparedPolicy.policy.effectiveConfigDigest;
      const originalPolicyDigest = preparedPolicy.policy.effectivePolicyDigest;

      let capturedAdmissionInput: any = null;
      const admit = vi.fn(async (input: any) => {
        capturedAdmissionInput = input;
        return { run: { runId: `run_${'f'.repeat(32)}` } };
      });

      const tool = createTriggerReviewTool({
        queryableDatabase: { query: vi.fn(async () => ({ rows: [] })) },
        admissionRepository: { admit } as any,
        resolveGitHubPullRequest: vi.fn(async () => ({
          headSha: HEAD_SHA,
          baseSha: BASE_SHA,
          repositoryId: REPO_ID,
          installationId: 2001,
        })),
        authoritativePublishing: {
          expectedAppId: APP_ID,
          repositoryIds: [REPO_ID],
          resolver: {
            resolve: async () => ({
              identity: buildAuthoritativeReviewIdentity({
                requested: candidate,
                current: { ...candidate, open: true, draft: false },
                policy: preparedPolicy.policy,
              }),
              prepared: {
                policy: { ...preparedPolicy.policy },
                config: { ...preparedPolicy.config },
                expectedPersonaIds: [...preparedPolicy.expectedPersonaIds],
                transport: { ...preparedPolicy.transport },
              },
            }),
          },
        },
      } as any);

      const res = await tool.execute({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pull_number: 501,
        head_sha: HEAD_SHA,
      });

      expect(admit).toHaveBeenCalledOnce();
      expect(capturedAdmissionInput.reviewEngine).toBeUndefined();
      expect(capturedAdmissionInput.authoritativeGate.prepared.policy.effectiveConfigDigest).toBe(originalConfigDigest);
      expect(capturedAdmissionInput.authoritativeGate.prepared.policy.effectivePolicyDigest).toBe(originalPolicyDigest);

      const data = JSON.parse((res.content[0] as any).text);
      expect(data.message).not.toContain('engine:');
    });

    it('EMP-M2-RESOLVER-01: calling trigger_review with review_engine composed or panel against strict AuthoritativePublishingResolver succeeds with { dispatched: true }', async () => {
      const policyFile = makeSamplePolicyFile();
      const resolver = new AuthoritativePublishingResolver({
        policyRepository: { repositoryId: REPO_ID, owner: 'calltelemetry', repo: 'cisco-cdr' },
        policyRef: 'refs/heads/service-policy',
        policyPath: '.calltelemetry/review-policy.json',
        transport: sampleTransport,
        candidateReaderFactory: async () => ({
          currentCandidate: async () => ({
            open: true,
            draft: false,
            repositoryId: REPO_ID,
            owner: 'calltelemetry',
            repo: 'cisco-cdr',
            prNumber: 502,
            headSha: HEAD_SHA,
            baseSha: BASE_SHA,
          }),
        }),
        policyReaderFactory: async () => ({
          resolvePolicyRevision: async () => HEAD_SHA,
          immutablePolicyFile: async () => policyFile,
        }),
      });

      const tool = createTriggerReviewTool({
        admissionRepository: { admit: vi.fn(async () => ({ run: { runId: `run_${'a'.repeat(32)}` } })) } as any,
        resolveGitHubPullRequest: vi.fn(async () => ({
          headSha: HEAD_SHA,
          baseSha: BASE_SHA,
          repositoryId: REPO_ID,
          installationId: 2001,
        })),
        authoritativePublishing: {
          expectedAppId: APP_ID,
          repositoryIds: [REPO_ID],
          resolver,
        } as any,
      });

      // When review_engine is omitted, tool execution with real resolver succeeds!
      const resDefault = await tool.execute({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pull_number: 502,
        head_sha: HEAD_SHA,
      });
      const dataDefault = JSON.parse((resDefault.content[0] as any).text);
      expect(dataDefault).toMatchObject({ dispatched: true });

      // When review_engine is 'composed', execution succeeds with { dispatched: true }
      const resComposed = await tool.execute({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pull_number: 502,
        head_sha: HEAD_SHA,
        review_engine: 'composed',
      });
      const dataComposed = JSON.parse((resComposed.content[0] as any).text);
      expect(dataComposed).toMatchObject({ dispatched: true });
      expect(dataComposed.message).toContain('engine: composed');

      // When review_engine is 'panel', execution succeeds with { dispatched: true }
      const resPanel = await tool.execute({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pull_number: 502,
        head_sha: HEAD_SHA,
        review_engine: 'panel',
      });
      const dataPanel = JSON.parse((resPanel.content[0] as any).text);
      expect(dataPanel).toMatchObject({ dispatched: true });
      expect(dataPanel.message).toContain('engine: panel');
    });
  });

  // =========================================================================
  // SUITE 3: Database Persistence & Artifact Encoding
  // =========================================================================
  describe('SUITE 3: PostgresReviewDispatchRepository & PostgresStore indexing', () => {
    it('EMP-M2-DB-01: PostgresReviewDispatchRepository.admit stores review_engine in artifacts JSON parameter ($25)', async () => {
      let reviewRunsParams: any[] | null = null;

      const fakeClient = {
        query: vi.fn(async (sql: string, params?: any[]) => {
          if (/^(BEGIN|COMMIT|ROLLBACK)$/u.test(sql) || /SELECT pg_advisory_xact_lock/u.test(sql)) {
            return { rows: [] };
          }
          if (sql.includes('INSERT INTO github_deliveries')) {
            return { rows: [{ delivery_id: params?.[0] }] };
          }
          if (sql.includes('INSERT INTO review_runs')) {
            reviewRunsParams = params || null;
            return {
              rows: [
                {
                  run_id: `run_${'1'.repeat(32)}`,
                  status: 'queued',
                  publication_mode: 'app-gate',
                  identity_digest: '2'.repeat(64),
                  attempt: 1,
                  lease_holder: null,
                  lease_expires_at: null,
                  artifacts: params && params[24] ? JSON.parse(params[24]) : {},
                },
              ],
            };
          }
          return { rows: [] };
        }),
        release: vi.fn(),
      };

      const mockPool = {
        connect: vi.fn(async () => fakeClient),
      };

      const repo = new PostgresReviewDispatchRepository(mockPool as any, undefined, { lifecycleEvents: 'disabled' });

      const identity: ReviewRunIdentity = {
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        prNumber: 600,
        headSha: HEAD_SHA,
        baseSha: BASE_SHA,
        snapshotDigest: '3'.repeat(64),
        configDigest: '4'.repeat(64),
      };

      // Case A: explicit reviewEngine: composed
      await repo.admit({
        deliveryId: 'del-001',
        eventName: 'mcp.trigger_review',
        repositoryId: REPO_ID,
        installationId: 2001,
        receivedAt: 1_790_000_000_000,
        terminalDeadline: 1_790_000_000_000 + 900_000,
        payloadDigest: '5'.repeat(64),
        publicationMode: 'app-gate',
        centralActionDispatch: false,
        debounce: false,
        identity,
        reviewEngine: 'composed',
      } as any);

      expect(reviewRunsParams).not.toBeNull();
      expect(reviewRunsParams!.length).toBe(25);
      const artifactsParamComposed = JSON.parse(reviewRunsParams![24]);
      expect(artifactsParamComposed).toEqual({ review_engine: 'composed' });

      // Case B: omitted reviewEngine defaults to panel
      await repo.admit({
        deliveryId: 'del-002',
        eventName: 'mcp.trigger_review',
        repositoryId: REPO_ID,
        installationId: 2001,
        receivedAt: 1_790_000_000_000,
        terminalDeadline: 1_790_000_000_000 + 900_000,
        payloadDigest: '5'.repeat(64),
        publicationMode: 'app-gate',
        centralActionDispatch: false,
        debounce: false,
        identity,
      } as any);

      expect(reviewRunsParams).not.toBeNull();
      const artifactsParamDefault = JSON.parse(reviewRunsParams![24]);
      expect(artifactsParamDefault).toEqual({ review_engine: 'panel' });
    });

    it('EMP-M2-DB-02: PostgresStore ensures review_runs_review_engine_idx index creation', async () => {
      process.env.DATABASE_URL = 'postgresql://fixture:password@127.0.0.1:5432/fixture';
      const store = new PostgresStore();
      const statements: string[] = [];
      const query = vi.fn(async (statement: string) => {
        statements.push(statement);
        return { rows: [] };
      });
      const release = vi.fn();
      vi.spyOn(store.getPool(), 'connect').mockResolvedValue({ query, release } as never);

      try {
        await store.initialize();
        const createdIndex = statements.find((s) =>
          s.includes('CREATE INDEX IF NOT EXISTS review_runs_review_engine_idx') &&
          s.includes("artifacts->>'review_engine'")
        );
        expect(createdIndex).toBeDefined();
      } finally {
        await store.close();
      }
    });
  });

  // =========================================================================
  // SUITE 4: Worker Engine Relaxation & Execution Isolation
  // =========================================================================
  describe('SUITE 4: runPublishingReviewWorker composed engine execution', () => {
    function createWorkerFixture(reviewEngine?: 'composed' | 'panel') {
      const policyFile = makeSamplePolicyFile(reviewEngine);
      const prepared = preparePublishingPolicy(policyFile, sampleTransport);
      if (reviewEngine) {
        prepared.config.review_engine = reviewEngine;
      }

      const envelope = {
        version: 'PreparedReviewExecution.v1',
        config: prepared.config,
        transport: prepared.transport,
      };

      const env: NodeJS.ProcessEnv = {
        NODE_ENV: 'test',
        REVIEW_PUBLICATION_MODE: 'app-gate',
        REVIEW_AUTHORITATIVE_GATE: 'true',
        REVIEW_RUN_ID: `run_${'c'.repeat(32)}`,
        REVIEW_REPOSITORY_ID: '123',
        REVIEW_REPO: 'calltelemetry/cisco-cdr',
        REVIEW_PR_NUMBER: '700',
        REVIEW_HEAD_SHA: HEAD_SHA,
        REVIEW_BASE_SHA: BASE_SHA,
        REVIEW_EXECUTION_ATTEMPT: '2',
        REVIEW_POLICY_DIGEST: prepared.policy.effectivePolicyDigest,
        REVIEW_CONFIG_DIGEST: prepared.policy.effectiveConfigDigest,
        REVIEW_PREPARED_CONFIG_JSON: JSON.stringify(envelope),
        REVIEW_COMPLETION_URL: 'https://dispatch.example.invalid/api/dispatch/completion',
        REVIEW_MODEL: sampleTransport.model,
        OPENAI_BASE_URL: sampleTransport.baseUrl,
        OPENAI_API_KEY: 'vk_fake',
        GH_TOKEN: 'ghs_fake',
        GITHUB_PUBLISH_TOKEN: 'ghs_fake',
        REVIEW_REPOSITORY_VISIBILITY: 'PRIVATE',
      };

      const usage = { prompt: 10, completion: 5, total: 15 };
      const panel: PanelResult = {
        headSha: HEAD_SHA,
        applicablePersonaIds: prepared.expectedPersonaIds,
        personas: prepared.expectedPersonaIds.map((id) => ({
          id,
          required: false,
          providerId: 'bifrost',
          model: sampleTransport.model,
          decision: 'APPROVE',
          findings: [],
          usage,
          costUSD: null,
          durationMs: 25,
        })),
        optionalFailures: [],
        quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
        moderator: {
          providerId: 'bifrost',
          model: sampleTransport.model,
          decision: 'RECONCILED',
          findings: [],
          usage,
          costUSD: null,
          durationMs: 10,
        },
        arbiter: {
          providerId: 'bifrost',
          model: sampleTransport.model,
          verdict: 'SHIP',
          rationale: 'Clean',
          usage,
          costUSD: null,
          durationMs: 10,
        },
      };

      const source = {
        baseSha: BASE_SHA,
        headSha: HEAD_SHA,
        diff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
        diffDigest: createHash('sha256').update('diff').digest('hex'),
        githubReads: 3 as const,
      };

      const checkClient = {
        createCheck: vi.fn<PublishingCheckClient['createCheck']>(async () => 4242),
        completeCheck: vi.fn<PublishingCheckClient['completeCheck']>(async () => undefined),
      };
      const sourceLoader = vi.fn().mockResolvedValue(source);
      const panelRunner = vi.fn().mockResolvedValue(panel);
      const composedReviewRunner = vi.fn().mockResolvedValue(panel);
      const reportReviewResult = vi.fn<WorkerReviewCompletionAdapter['reportReviewResult']>().mockResolvedValue(undefined);
      const now = vi.fn().mockReturnValueOnce(1_000_000).mockReturnValue(1_001_000);

      const deps: PublishingReviewDeps = {
        checkClient,
        sourceLoader: sourceLoader as any,
        panelRunner: panelRunner as any,
        composedReviewRunner: composedReviewRunner as any,
        client: { complete: vi.fn() } as any,
        now,
        visibilityLookup: vi.fn(async () => 'PRIVATE' as const),
        reviewCompletion: { reportReviewResult },
      };

      vi.spyOn(logger, 'error').mockImplementation(() => undefined);
      vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      vi.spyOn(logger, 'info').mockImplementation(() => undefined);

      return { env, deps, panelRunner, composedReviewRunner, reportReviewResult };
    }

    it('EMP-M2-WRK-01: falls back to panelRunner when review_engine is composed in authoritative mode to protect roster contract', async () => {
      const fix = createWorkerFixture('composed');

      await runPublishingReviewWorker(fix.env, fix.deps);

      expect(fix.panelRunner).toHaveBeenCalledOnce();
      expect(fix.composedReviewRunner).not.toHaveBeenCalled();
      expect(fix.reportReviewResult).toHaveBeenCalledOnce();
    });

    it('EMP-M2-WRK-02: invokes panelRunner when review_engine is panel in authoritative mode', async () => {
      const fix = createWorkerFixture('panel');

      await runPublishingReviewWorker(fix.env, fix.deps);

      expect(fix.panelRunner).toHaveBeenCalledOnce();
      expect(fix.composedReviewRunner).not.toHaveBeenCalled();
      expect(fix.reportReviewResult).toHaveBeenCalledOnce();
    });

    it('EMP-M2-WRK-03: falls back to panelRunner when review_engine is omitted', async () => {
      const fix = createWorkerFixture(undefined);

      await runPublishingReviewWorker(fix.env, fix.deps);

      expect(fix.panelRunner).toHaveBeenCalledOnce();
      expect(fix.composedReviewRunner).not.toHaveBeenCalled();
      expect(fix.reportReviewResult).toHaveBeenCalledOnce();
    });
  });

  // =========================================================================
  // SUITE 5: Concurrency Conflict Detection with Engine Selection
  // =========================================================================
  describe('SUITE 5: Concurrency and active run conflict detection with engine selection', () => {
    it('EMP-M2-CNC-01: detects conflict with active run even when specifying review_engine', async () => {
      const mockQuery = vi.fn(async (sql: string) => {
        if (sql.includes('SELECT run_id, attempt, status, head_sha')) {
          return {
            rows: [
              {
                run_id: `run_${'9'.repeat(32)}`,
                attempt: 1,
                status: 'running',
                head_sha: HEAD_SHA,
              },
            ],
          };
        }
        return { rows: [] };
      });

      const admit = vi.fn();
      const tool = createTriggerReviewTool({
        queryableDatabase: { query: mockQuery },
        admissionRepository: { admit } as any,
        resolveGitHubPullRequest: vi.fn(async () => ({
          headSha: HEAD_SHA,
          baseSha: BASE_SHA,
          repositoryId: REPO_ID,
          installationId: 2001,
        })),
        authoritativePublishing: {
          expectedAppId: APP_ID,
          repositoryIds: [REPO_ID],
          resolver: {
            resolve: async () => ({
              identity: {
                owner: 'calltelemetry',
                repo: 'cisco-cdr',
                prNumber: 999,
                headSha: HEAD_SHA,
                baseSha: BASE_SHA,
              },
              prepared: {
                policy: { effectivePolicyDigest: 'a'.repeat(64), effectiveConfigDigest: 'b'.repeat(64) },
                config: {},
              },
            }),
          },
        },
      } as any);

      // Without force: true, must throw 409 Conflict
      await expect(
        tool.execute({
          owner: 'calltelemetry',
          repo: 'cisco-cdr',
          pull_number: 999,
          head_sha: HEAD_SHA,
          review_engine: 'composed',
          force: false,
        }),
      ).rejects.toThrow(/Conflict.*currently running/);

      expect(admit).not.toHaveBeenCalled();
    });
  });
});
