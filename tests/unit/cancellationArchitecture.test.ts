import { describe, it, expect, vi } from 'vitest';
import { KubernetesReviewJobProjector } from '../../src/k8s/kubernetesReviewJobProjector';
import { WorkerStatusPoller } from '../../src/cli/workerStatusPoller';
import {
  PostgresReviewDispatchRepository,
  type PendingCancellation,
  type RunStatusResult,
} from '../../src/persistence/reviewDispatchRepository';
import { runPublishingReviewWorker } from '../../src/cli/publishingReview';

describe('Two-Tier Cancellation Architecture', () => {
  describe('PostgresReviewDispatchRepository cancellation methods', () => {
    it('findPendingCancellations queries outbox rows with unpropagated cancellations', async () => {
      const mockQuery = vi.fn(async (sql: string, params: any[]) => {
        expect(sql).toContain('cancel_requested_at IS NOT NULL');
        expect(sql).toContain('cancel_propagated_at IS NULL');
        expect(sql).toContain('projection_name IS NOT NULL');
        return {
          rows: [
            {
              run_id: 'run_abc',
              execution_attempt: 1,
              projection_name: 'prj-run-abc',
              cancel_reason: 'superseded_by_new_head',
            },
          ],
        };
      });

      const repo = new PostgresReviewDispatchRepository(
        { connect: vi.fn(), query: mockQuery } as any,
        undefined,
        { lifecycleEvents: 'disabled' },
      );

      const pending = await repo.findPendingCancellations(5);
      expect(pending).toEqual([
        {
          runId: 'run_abc',
          executionAttempt: 1,
          projectionName: 'prj-run-abc',
          cancelReason: 'superseded_by_new_head',
        },
      ]);
    });

    it('markCancelPropagated updates both outbox and runs fenced by executionAttempt', async () => {
      const executedSql: string[] = [];
      const mockClient = {
        query: vi.fn(async (sql: string, params: any[]) => {
          executedSql.push(sql);
          if (sql.includes('UPDATE review_dispatch_outbox')) {
            expect(params[0]).toBe('run_xyz');
            expect(params[1]).toBe(2);
            return { rows: [{ run_id: 'run_xyz' }] };
          }
          if (sql.includes('UPDATE review_runs')) {
            expect(params[0]).toBe('run_xyz');
            return { rows: [{ run_id: 'run_xyz' }] };
          }
          return { rows: [] };
        }),
        release: vi.fn(),
      };

      const repo = new PostgresReviewDispatchRepository(
        mockClient as any,
        undefined,
        { lifecycleEvents: 'disabled' },
      );

      const propagated = await repo.markCancelPropagated('run_xyz', 2, 1_700_000_000_000);
      expect(propagated).toBe(true);
      expect(executedSql.some((s) => s.includes('UPDATE review_dispatch_outbox'))).toBe(true);
      expect(executedSql.some((s) => s.includes('UPDATE review_runs'))).toBe(true);
    });

    it('markCancelPropagated returns false when outbox row does not match attempt or was already propagated', async () => {
      const mockClient = {
        query: vi.fn(async (sql: string) => {
          if (sql.includes('UPDATE review_dispatch_outbox')) {
            return { rows: [] };
          }
          return { rows: [] };
        }),
        release: vi.fn(),
      };

      const repo = new PostgresReviewDispatchRepository(
        mockClient as any,
        undefined,
        { lifecycleEvents: 'disabled' },
      );

      const propagated = await repo.markCancelPropagated('run_xyz', 99, 1_700_000_000_000);
      expect(propagated).toBe(false);
    });

    it('getRunStatus returns full status and evaluates isCurrentHead correctly', async () => {
      const mockQuery = vi.fn(async (sql: string, params: any[]) => {
        if (sql.includes('FROM review_runs AS runs')) {
          return {
            rows: [
              {
                run_id: 'run_test',
                status: 'running',
                head_sha: 'head_old',
                owner: 'org',
                repo: 'repo',
                pr_number: 42,
                cancel_requested_at: new Date(),
                cancel_reason: 'superseded_by_new_head',
                execution_attempt: 0,
                worker_token_digest: 'a'.repeat(64),
                outbox_cancel_requested_at: new Date(),
                outbox_cancel_reason: 'superseded_by_new_head',
              },
            ],
          };
        }
        if (sql.includes('SELECT head_sha FROM review_runs')) {
          return {
            rows: [{ head_sha: 'head_new' }],
          };
        }
        return { rows: [] };
      });

      const repo = new PostgresReviewDispatchRepository(
        { connect: vi.fn(), query: mockQuery } as any,
        undefined,
        { lifecycleEvents: 'disabled' },
      );

      const status = await repo.getRunStatus('run_test', 1);
      expect(status).toEqual({
        current: false,
        status: 'running',
        cancelRequested: true,
        cancelReason: 'superseded_by_new_head',
        currentHeadSha: 'head_new',
        isCurrentHead: false,
        workerTokenDigest: 'a'.repeat(64),
      });
    });
  });

  describe('KubernetesReviewJobProjector.patchCancellation', () => {
    it('applies application/merge-patch+json with cancelRequested: true', async () => {
      const patchNamespacedCustomObject = vi.fn(async () => ({}));
      const client = {
        getNamespacedCustomObject: vi.fn(),
        createNamespacedCustomObject: vi.fn(),
        patchNamespacedCustomObject,
      };

      const projector = new KubernetesReviewJobProjector(client as any);
      await projector.patchCancellation('prj-sample', 'test-ns', 'superseded_by_new_head');

      expect(patchNamespacedCustomObject).toHaveBeenCalledWith(
        {
          group: 'review-yeti.ai',
          version: 'v1alpha2',
          namespace: 'test-ns',
          plural: 'prreviewjobs',
          name: 'prj-sample',
          body: {
            spec: {
              cancelRequested: true,
              cancelReason: 'superseded_by_new_head',
            },
          },
        },
        // REL-1073: a client-node Configuration carrying the header middleware,
        // not a `{ headers }` object (which the generated client ignores). The
        // wire-level content type is asserted against a real HTTP server in
        // kubernetesReviewJobProjector.test.ts.
        expect.objectContaining({ middleware: expect.any(Array) }),
      );
    });

    it('silently ignores 404 NotFound error when patching cancellation', async () => {
      const patchNamespacedCustomObject = vi.fn(async () => {
        const err: any = new Error('not found');
        err.statusCode = 404;
        throw err;
      });
      const client = {
        getNamespacedCustomObject: vi.fn(),
        createNamespacedCustomObject: vi.fn(),
        patchNamespacedCustomObject,
      };

      const projector = new KubernetesReviewJobProjector(client as any);
      await expect(projector.patchCancellation('prj-sample', 'test-ns')).resolves.toEqual({ status: 'not-found' });
    });

    it('re-throws non-404 API errors with structured error message', async () => {
      const patchNamespacedCustomObject = vi.fn(async () => {
        const err: any = new Error('server error');
        err.statusCode = 500;
        throw err;
      });
      const client = {
        getNamespacedCustomObject: vi.fn(),
        createNamespacedCustomObject: vi.fn(),
        patchNamespacedCustomObject,
      };

      const projector = new KubernetesReviewJobProjector(client as any);
      await expect(projector.patchCancellation('prj-sample', 'test-ns')).rejects.toThrow(
        'Kubernetes PRReviewJob patch failed with status 500',
      );
    });
  });

  describe('WorkerStatusPoller', () => {
    it('detects superseded status and triggers onSuperseded callback', async () => {
      const onSuperseded = vi.fn();
      const mockFetch = vi.fn(async () => ({
        status: 200,
        ok: true,
        json: async () => ({
          current: false,
          status: 'superseded',
          cancelRequested: true,
          cancelReason: 'superseded_by_new_head',
          isCurrentHead: false,
        }),
      })) as any;

      const poller = new WorkerStatusPoller({
        statusUrl: 'https://dispatch.local/api/dispatch/runs/run_1/attempts/1/status',
        bearerToken: 'token123',
        fetch: mockFetch,
        onSuperseded,
      });

      expect(poller.isCurrentHead()).toBe(true);
      await poller.pollOnce();

      expect(poller.isCurrentHead()).toBe(false);
      expect(poller.cancelReason).toBe('superseded_by_new_head');
      expect(onSuperseded).toHaveBeenCalledWith('superseded_by_new_head');
    });

    it('detects 404 and triggers onSuperseded with run_not_found', async () => {
      const onSuperseded = vi.fn();
      const mockFetch = vi.fn(async () => ({
        status: 404,
        ok: false,
      })) as any;

      const poller = new WorkerStatusPoller({
        statusUrl: 'https://dispatch.local/api/dispatch/runs/run_1/attempts/1/status',
        bearerToken: 'token123',
        fetch: mockFetch,
        onSuperseded,
      });

      await poller.pollOnce();

      expect(poller.isCurrentHead()).toBe(false);
      expect(onSuperseded).toHaveBeenCalledWith('run_not_found');
    });

    it('fails soft on network errors without flipping isCurrentHead', async () => {
      const onSuperseded = vi.fn();
      const mockFetch = vi.fn(async () => {
        throw new Error('Connection refused');
      }) as any;

      const poller = new WorkerStatusPoller({
        statusUrl: 'https://dispatch.local/api/dispatch/runs/run_1/attempts/1/status',
        bearerToken: 'token123',
        fetch: mockFetch,
        onSuperseded,
      });

      await poller.pollOnce();

      expect(poller.isCurrentHead()).toBe(true);
      expect(onSuperseded).not.toHaveBeenCalled();
    });
  });

  describe('Publishing review worker neutral check on superseded', () => {
    it('publishes neutral conclusion when superseded during review execution', async () => {
      const completeCheck = vi.fn(async () => undefined);
      const mockCheckClient = {
        createCheck: vi.fn(async () => 101),
        completeCheck,
      };

      const workerEnv: NodeJS.ProcessEnv = {
        NODE_ENV: 'test',
        REVIEW_RUN_ID: 'run_' + 'a'.repeat(32),
        REVIEW_DELIVERY_ID: 'del_123',
        REVIEW_REPOSITORY_ID: '12345',
        REVIEW_OWNER: 'calltelemetry',
        REVIEW_REPO: 'calltelemetry/test-repo',
        REVIEW_PR_NUMBER: '42',
        REVIEW_HEAD_SHA: 'a'.repeat(40),
        REVIEW_BASE_SHA: 'b'.repeat(40),
        REVIEW_EXECUTION_ATTEMPT: '1',
        REVIEW_PUBLICATION_MODE: 'app-gate',
        OPENAI_BASE_URL: 'https://bifrost.example.com',
        OPENAI_API_KEY: 'secret-key',
        REVIEW_MODEL: 'test-model',
        GITHUB_PUBLISH_TOKEN: 'ghs_token123',
      };

      const panelRunner = vi.fn(async (options: any) => {
        if (options.isCurrentHead && !options.isCurrentHead()) {
          throw new Error('stale run aborted for calltelemetry/test-repo');
        }
        return {} as any;
      });

      let currentHead = false; // Superseded!

      await expect(
        runPublishingReviewWorker(workerEnv, {
          checkClient: mockCheckClient,
          panelRunner,
          isCurrentHead: () => currentHead,
          sourceLoader: vi.fn(async () => ({
            changedFiles: [{ path: 'file.ts', status: 'modified', additions: 1, deletions: 0 }],
          })) as any,
          visibilityLookup: vi.fn(async () => 'PUBLIC' as const),
        }),
      ).rejects.toThrow();

      expect(completeCheck).toHaveBeenCalledWith({
        owner: 'calltelemetry',
        repo: 'test-repo',
        checkId: 101,
        conclusion: 'neutral',
        title: 'Review Yeti: review superseded',
        summary: 'Superseded by a newer pull request head.',
      });
    });
  });
});
