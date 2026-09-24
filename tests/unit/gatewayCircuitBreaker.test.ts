import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isProvider5xxError,
  executePersonaPanel,
  TRANSPORT_MAX_RETRIES,
} from '../../src/panel/panelEngine';
import { OpenRouterResponseError } from '../../src/gateway/openRouterClient';
import { DispatchCircuitBreaker } from '../../src/k8s/dispatchCircuitBreaker';
import { requeueRecoverableIncompletePanelFailure } from '../../src/review/recoverablePanelRetry';
import { createDefaultV3Config } from '../../src/config/configLoader';
import { ctReviewConfigV3Schema } from '../../src/config/schema';

describe('Milestone 5 (R5): Gateway Circuit Breaking & Outage Requeuing', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('isProvider5xxError', () => {
    it('identifies 502 and 503 OpenRouterResponseErrors', () => {
      const err502 = new OpenRouterResponseError('Bad gateway', 502);
      const err503 = new OpenRouterResponseError('Service unavailable', 503);
      const err500 = new OpenRouterResponseError('Internal error', 500);
      const err429 = new OpenRouterResponseError('Rate limited', 429);

      expect(isProvider5xxError(err502)).toBe(true);
      expect(isProvider5xxError(err503)).toBe(true);
      expect(isProvider5xxError(err500)).toBe(false);
      expect(isProvider5xxError(err429)).toBe(false);
    });

    it('identifies 502, 503, Bad Gateway, and Service Unavailable in generic error messages', () => {
      expect(isProvider5xxError(new Error('HTTP 502 Bad Gateway from upstream proxy'))).toBe(true);
      expect(isProvider5xxError(new Error('503 Service Unavailable'))).toBe(true);
      expect(isProvider5xxError(new Error('Bad Gateway occurred on inference'))).toBe(true);
      expect(isProvider5xxError(new Error('Service Unavailable: cluster capacity full'))).toBe(true);
      expect(isProvider5xxError(new Error('SyntaxError: Unexpected token'))).toBe(false);
      expect(isProvider5xxError(new Error('Connection timed out after 30000ms'))).toBe(false);
    });
  });

  describe('DispatchCircuitBreaker', () => {
    it('starts closed and remains closed when below minSamples', () => {
      let currentTime = 1000;
      const cb = new DispatchCircuitBreaker({
        minSamples: 3,
        failureRateThreshold: 0.5,
        now: () => currentTime,
      });

      expect(cb.isOpen()).toBe(false);

      cb.recordFailure('provider_5xx');
      expect(cb.isOpen()).toBe(false);

      cb.recordFailure('provider_5xx');
      expect(cb.isOpen()).toBe(false); // Only 2 samples (< 3 minSamples)
    });

    it('trips open when failure rate crosses threshold with sufficient samples', () => {
      let currentTime = 1000;
      const cb = new DispatchCircuitBreaker({
        minSamples: 3,
        failureRateThreshold: 0.5,
        now: () => currentTime,
      });

      cb.recordFailure('provider_5xx');
      cb.recordFailure('provider_5xx');
      cb.recordSuccess();

      // 2 failures out of 3 samples = 66.7% >= 50%
      expect(cb.isOpen()).toBe(true);
      const stats = cb.getStats();
      expect(stats.isOpen).toBe(true);
      expect(stats.total).toBe(3);
      expect(stats.total5xx).toBe(2);
    });

    it('recovers to closed after successful samples lower the failure rate', () => {
      let currentTime = 1000;
      const cb = new DispatchCircuitBreaker({
        minSamples: 3,
        failureRateThreshold: 0.5,
        now: () => currentTime,
      });

      cb.recordFailure('provider_5xx');
      cb.recordFailure('provider_5xx');
      cb.recordSuccess();
      expect(cb.isOpen()).toBe(true);

      cb.recordSuccess();
      cb.recordSuccess();
      // 2 failures out of 5 samples = 40% < 50%
      expect(cb.isOpen()).toBe(false);
    });

    it('prunes samples older than the sliding window', () => {
      let currentTime = 1000;
      const cb = new DispatchCircuitBreaker({
        windowMs: 5000,
        minSamples: 2,
        failureRateThreshold: 0.5,
        now: () => currentTime,
      });

      cb.recordFailure('provider_5xx', 1000);
      cb.recordFailure('provider_5xx', 2000);
      expect(cb.isOpen(2000)).toBe(true);

      // Advance time beyond window
      currentTime = 8000;
      expect(cb.isOpen(8000)).toBe(false);
      expect(cb.getStats(8000).total).toBe(0);
    });

    it('supports manual pause, resume, and reset', () => {
      const cb = new DispatchCircuitBreaker();
      expect(cb.isOpen()).toBe(false);

      cb.pause();
      expect(cb.isOpen()).toBe(true);
      expect(cb.isPaused()).toBe(true);

      cb.resume();
      expect(cb.isOpen()).toBe(false);
      expect(cb.isPaused()).toBe(false);

      cb.recordFailure('provider_5xx');
      cb.reset();
      expect(cb.getStats().total).toBe(0);
    });
  });

  describe('Outage Requeuing & Exponential Backoff', () => {
    it('applies exponential backoff for provider_5xx failures on attempt 1', async () => {
      const admittedPayloads: any[] = [];
      const fakeRepo = {
        readRunRetryContext: vi.fn(async () => ({
          publicationMode: 'app-gate' as const,
          authoritativeGateAppId: null,
          repositoryId: 123,
          installationId: 456,
          identity: {
            runId: 'run-5xx-test',
            owner: 'calltelemetry',
            repoName: 'review-yeti-bot',
            prNumber: 10,
            headSha: 'head-sha-5xx',
            baseSha: 'base-sha',
            executionAttempt: 1,
          },
        })),
        admit: vi.fn(async (input: any) => {
          admittedPayloads.push(input);
          return {} as any;
        }),
      };

      const now = 1_000_000;
      await requeueRecoverableIncompletePanelFailure({
        input: {
          version: 'WorkerTerminalFailure.v1',
          runId: 'run-5xx-test',
          repositoryId: 123,
          owner: 'calltelemetry',
          repo: 'review-yeti-bot',
          prNumber: 10,
          headSha: 'head-sha-5xx',
          baseSha: 'base-sha',
          executionAttempt: 1,
          failureClass: 'provider_error',
          policyDigest: 'policy-digest',
          configDigest: 'config-digest',
          diagnostics: {
            reason: 'provider_5xx',
            recoverableIncompletePanel: true,
            logTail: '',
          },
        },
        now,
        repository: fakeRepo as any,
        logger: { error: vi.fn() },
      });

      expect(admittedPayloads.length).toBe(1);
      // Attempt 1: 15s * 2^0 = 15,000ms
      expect(admittedPayloads[0].availableAt).toBe(now + 15_000);
      expect(admittedPayloads[0].eventName).toBe('internal_provider_5xx_retry');
    });

    it('scales backoff with attempt number on attempt 2', async () => {
      const admittedPayloads: any[] = [];
      const fakeRepo = {
        readRunRetryContext: vi.fn(async () => ({
          publicationMode: 'app-gate' as const,
          authoritativeGateAppId: null,
          repositoryId: 123,
          installationId: 456,
          identity: {
            runId: 'run-5xx-test-2',
            owner: 'calltelemetry',
            repoName: 'review-yeti-bot',
            prNumber: 10,
            headSha: 'head-sha-5xx',
            baseSha: 'base-sha',
            executionAttempt: 2,
          },
        })),
        admit: vi.fn(async (input: any) => {
          admittedPayloads.push(input);
          return {} as any;
        }),
      };

      const now = 2_000_000;
      await requeueRecoverableIncompletePanelFailure({
        input: {
          version: 'WorkerTerminalFailure.v1',
          runId: 'run-5xx-test-2',
          repositoryId: 123,
          owner: 'calltelemetry',
          repo: 'review-yeti-bot',
          prNumber: 10,
          headSha: 'head-sha-5xx',
          baseSha: 'base-sha',
          executionAttempt: 2,
          failureClass: 'provider_error',
          policyDigest: 'policy-digest',
          configDigest: 'config-digest',
          diagnostics: {
            reason: 'provider_5xx',
            recoverableIncompletePanel: true,
            logTail: '',
          },
        },
        now,
        repository: fakeRepo as any,
        logger: { error: vi.fn() },
      });

      expect(admittedPayloads.length).toBe(1);
      // Attempt 2: 15s * 2^(2-1) = 15s * 2 = 30,000ms
      expect(admittedPayloads[0].availableAt).toBe(now + 30_000);
    });
  });

  describe('5xx Outage Failover Suppression on Large Prompts', () => {
    it('aborts provider loop on 502/503 with promptTokens > 15,000 without trying secondary pool', async () => {
      process.env.INLINE_DIFF_TOKEN_BUDGET = '25000';
      // REL-1113: the SAME provider first rides out the gateway 502 on the transport budget
      // (zero jitter here); only once that is spent does the breaker stop the lane -- still
      // without fanning out to the secondary pool.
      const random = vi.spyOn(Math, 'random').mockReturnValue(0);

      const capturedModels: string[] = [];
      const mockClient = {
        complete: vi.fn(async (req: any) => {
          capturedModels.push(req.model);
          // Simulate 502 Bad Gateway
          throw new OpenRouterResponseError('502 Bad Gateway', 502);
        }),
      };

      // Config with primary and secondary fallback providers
      const config = ctReviewConfigV3Schema.parse({
        ...createDefaultV3Config(),
        pre_checks: {
          classifier: { enabled: false },
          analyzers: { enabled: false },
          zoekt: { enabled: false },
        },
        quorum: 1,
        personas: [
          {
            id: 'sec-lane',
            enabled: true,
            required: true,
            charter: 'Security review',
            paths: ['**/*'],
            providers: ['primary-provider', 'secondary-provider'],
          },
        ],
        reviewers: {
          execution: 'personas',
          fallback: 'ordered', // Fallback is enabled
          overall_timeout_s: 30,
          providers: [
            { id: 'primary-provider', enabled: true, model: 'primary-model', effort: 'medium', review_timeout_s: 30, arbiter_timeout_s: 30 },
            { id: 'secondary-provider', enabled: true, model: 'secondary-model', effort: 'medium', review_timeout_s: 30, arbiter_timeout_s: 30 },
          ],
          arbiter: { order: ['primary-provider'] },
        },
      });

      // 3 files of ~25,000 chars each = ~75,000 chars (> 18,000 tokens)
      const chunk = '@@ -1,1 +1,700 @@\n' + '+ export const secVar = "token_data";\n'.repeat(680);
      const changedFiles = [
        { path: 'src/auth/tokens1.ts', patch: chunk },
        { path: 'src/auth/tokens2.ts', patch: chunk },
        { path: 'src/auth/tokens3.ts', patch: chunk },
      ];

      await expect(
        executePersonaPanel({
          config,
          changedFiles,
          repository: 'calltelemetry/review-yeti-bot',
          headSha: 'outage-head-sha',
          client: mockClient as any,
          requestPolicy: { responseFormat: { type: 'json_object' } },
        })
      ).rejects.toThrow();

      // Only primary-model should have been attempted; secondary-model must NOT be hammered during 5xx outage
      expect(capturedModels).toContain('primary-model');
      expect(capturedModels).not.toContain('secondary-model');
      expect(capturedModels.filter((model) => model === 'primary-model')).toHaveLength(TRANSPORT_MAX_RETRIES + 1);
      random.mockRestore();
    });
  });

  describe('Publishing Review Worker 5xx Handling', () => {
    it('keeps check in_progress and emits recoverable terminal failure on provider_5xx', async () => {
      const { runPublishingReviewWorker } = await import('../../src/cli/publishingReview');
      const completion = {
        reportTerminalFailure: vi.fn(async () => {}),
        reportTerminalSuccess: vi.fn(async () => {}),
      };
      const cc = {
        createCheck: vi.fn(async () => 9999),
        completeCheck: vi.fn(async () => {}),
        updateCheck: vi.fn(async () => {}),
      };
      const error = new Error('502 Bad Gateway');
      (error as any).failureReason = 'provider_5xx';

      const panelRunner = vi.fn(async () => {
        throw error;
      });

      const workerEnv = {
        NODE_ENV: 'test',
        REVIEW_PUBLICATION_MODE: 'app-gate',
        REVIEW_RUN_ID: `run_${'c'.repeat(32)}`,
        REVIEW_REPO: 'calltelemetry/ct-meta',
        REVIEW_REPOSITORY_ID: '1339040553',
        REVIEW_POLICY_DIGEST: 'c'.repeat(64),
        REVIEW_CONFIG_DIGEST: 'd'.repeat(64),
        REVIEW_EXECUTION_ATTEMPT: '1',
        REVIEW_PR_NUMBER: '2795',
        REVIEW_HEAD_SHA: 'a'.repeat(40),
        REVIEW_BASE_SHA: 'b'.repeat(40),
        REVIEW_MODEL: 'ollama/glm-5.3-flash',
        OPENAI_BASE_URL: 'https://gateway.example.invalid/v1',
        OPENAI_API_KEY: 'vk-test',
        GH_TOKEN: 'ghs_test',
        REVIEW_CHECK_ID: '9999',
      };

      await expect(
        runPublishingReviewWorker(workerEnv as any, {
          checkClient: cc as any,
          completion,
          panelRunner: panelRunner as any,
          sourceLoader: vi.fn(async () => ({ diff: 'diff --git a/a b/a', githubReads: 1 })),
          visibilityLookup: vi.fn(async () => 'PRIVATE' as const),
          configLoader: vi.fn(async () => createDefaultV3Config()),
        } as any)
      ).rejects.toThrow();

      // completeCheck with failure must NOT have been called!
      expect(cc.completeCheck).not.toHaveBeenCalled();

      // updateCheck with in_progress MUST have been called!
      expect(cc.updateCheck).toHaveBeenCalledWith(
        expect.objectContaining({
          checkId: 9999,
          status: 'in_progress',
          title: expect.stringContaining('requeuing'),
        })
      );

      // Terminal failure report carries provider_5xx reason and recoverableIncompletePanel: true
      expect(completion.reportTerminalFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          failureClass: 'provider_error',
          diagnostics: expect.objectContaining({
            reason: 'provider_5xx',
            recoverableIncompletePanel: true,
          }),
        })
      );
    });
  });
});
