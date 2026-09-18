import { createHmac, createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  PostgresReviewDispatchRepository as DurablePostgresReviewDispatchRepository,
  type ReviewDispatchRepositoryOptions,
} from '../../src/persistence/reviewDispatchRepository';
import { createGitHubWebhookAdmissionHandler } from '../../src/review/githubWebhookAdmission';
import { buildReviewRunIdentity } from '../../src/review/reviewAdmission';
import { DEFAULT_AUTO_REVIEW_TRIGGERS } from '../../src/config/schema';
import { isTriggerActionAllowed, normalizeRawConfigToV3 } from '../../src/config/configLoader';
import { TERMINAL_DEADLINE_MS } from '../../src/config/terminalDeadline';

class PostgresReviewDispatchRepository extends DurablePostgresReviewDispatchRepository {
  constructor(pool: any, queryable?: any, options: Partial<ReviewDispatchRepositoryOptions> = {}) {
    super(pool, queryable, { lifecycleEvents: 'disabled', ...options });
  }
}

const SECRET = 'test-webhook-secret-with-at-least-32-chars';
const BASE_NOW = Date.parse('2026-09-18T10:00:00.000Z');
const HEAD_SHA_1 = '1111111111111111111111111111111111111111';
const HEAD_SHA_2 = '2222222222222222222222222222222222222222';
const BASE_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

interface MockDbState {
  runs: Map<string, any>;
  outbox: Map<string, any>;
  deliveries: Map<string, any>;
}

function createMockDb() {
  const state: MockDbState = {
    runs: new Map(),
    outbox: new Map(),
    deliveries: new Map(),
  };

  const query = vi.fn(async (sql: string, values?: any[]) => {
    // Transaction statements & advisory locks
    if (/^(BEGIN|COMMIT|ROLLBACK)$/u.test(sql) || /SELECT pg_advisory_xact_lock/u.test(sql)) {
      return { rows: [] };
    }

    // Check delivery redelivery
    if (/SELECT run_id, attempt, status, authoritative_gate_app_id, received_at FROM review_runs WHERE delivery_id = \$1/u.test(sql)) {
      const deliveryId = values?.[0];
      for (const run of state.runs.values()) {
        if (run.delivery_id === deliveryId) {
          return { rows: [run] };
        }
      }
      return { rows: [] };
    }

    // Prior run query for burst calculation
    if (/SELECT burst_started_at, received_at\s+FROM review_runs\s+WHERE owner = \$1 AND repo = \$2 AND pr_number = \$3/u.test(sql)) {
      const [owner, repo, prNumber] = values || [];
      const matching = Array.from(state.runs.values()).filter(
        r => r.owner === owner && r.repo === repo && r.pr_number === prNumber
      );
      matching.sort((a, b) => {
        const aRec = a.received_at ? new Date(a.received_at).getTime() : 0;
        const bRec = b.received_at ? new Date(b.received_at).getTime() : 0;
        if (bRec !== aRec) return bRec - aRec;
        const aCre = a.created_at ? new Date(a.created_at).getTime() : 0;
        const bCre = b.created_at ? new Date(b.created_at).getTime() : 0;
        return bCre - aCre;
      });
      return { rows: matching.slice(0, 1) };
    }

    // Insert github delivery
    if (/INSERT INTO github_deliveries/u.test(sql)) {
      const deliveryId = values?.[0];
      state.deliveries.set(deliveryId, { delivery_id: deliveryId });
      return { rows: [{ delivery_id: deliveryId }] };
    }

    // Insert / update review_runs
    if (/INSERT INTO review_runs/u.test(sql)) {
      const [
        runId, identityDigest, owner, repo, prNumber, headSha, baseSha,
        snapshotDigest, configDigest, effectivePolicyDigest, indexEpoch,
        identityStr, repositoryId, installationId, deliveryId, receivedAt,
        terminalDeadline, publicationMode, authoritativeGateAppId,
        retryRequested, retryAfterExecutionAttempt, reaperFailureText, burstStartedAt,
      ] = values || [];

      let run = state.runs.get(identityDigest);
      if (!run) {
        run = {
          run_id: runId,
          identity_digest: identityDigest,
          owner, repo, pr_number: prNumber, head_sha: headSha, base_sha: baseSha,
          snapshot_digest: snapshotDigest,
          config_digest: configDigest,
          effective_policy_digest: effectivePolicyDigest,
          effective_config_digest: configDigest,
          index_epoch: indexEpoch,
          identity: typeof identityStr === 'string' ? JSON.parse(identityStr) : identityStr,
          status: 'queued',
          stage: 'admission',
          attempt: 0,
          artifacts: {},
          repository_id: repositoryId,
          installation_id: installationId,
          delivery_id: deliveryId,
          received_at: new Date(receivedAt),
          terminal_deadline: new Date(terminalDeadline),
          publication_mode: publicationMode,
          authoritative_gate_app_id: authoritativeGateAppId,
          burst_started_at: new Date(burstStartedAt),
          created_at: new Date(receivedAt),
          updated_at: new Date(receivedAt),
          error_text: null,
        };
        state.runs.set(identityDigest, run);
      } else {
        run.updated_at = new Date(receivedAt);
        if (!run.burst_started_at) {
          run.burst_started_at = new Date(burstStartedAt);
        }
      }
      return { rows: [{ ...run, retry_from_reaper_failure: false }] };
    }

    // Supersede older runs
    if (/WITH superseded AS/u.test(sql)) {
      const [owner, repo, prNumber, identityDigest, nowMs] = values || [];
      const supersededRunIds: string[] = [];
      for (const run of state.runs.values()) {
        if (
          run.owner === owner &&
          run.repo === repo &&
          run.pr_number === prNumber &&
          run.identity_digest !== identityDigest &&
          ['queued', 'running', 'publishing', 'failed', 'terminal'].includes(run.status)
        ) {
          run.status = 'superseded';
          run.error_text = 'superseded by a newer review identity';
          run.updated_at = new Date(nowMs);
          supersededRunIds.push(run.run_id);
          const outboxEntry = state.outbox.get(run.run_id);
          if (outboxEntry) {
            outboxEntry.status = 'terminal';
            outboxEntry.updated_at = new Date(nowMs);
          }
        }
      }
      return { rows: supersededRunIds.map(run_id => ({ run_id })) };
    }

    // Update github deliveries with run_id
    if (/UPDATE github_deliveries SET run_id/u.test(sql)) {
      return { rows: [] };
    }

    // Insert / update review_dispatch_outbox
    if (/INSERT INTO review_dispatch_outbox/u.test(sql)) {
      const [runId, deliveryId, receivedAt, terminalDeadline, availableAt] = values || [];
      let entry = state.outbox.get(runId);
      if (!entry) {
        entry = {
          run_id: runId,
          delivery_id: deliveryId,
          status: 'pending',
          available_at: new Date(availableAt),
          created_at: new Date(receivedAt),
          updated_at: new Date(receivedAt),
          execution_attempt: 0,
        };
        state.outbox.set(runId, entry);
      } else {
        entry.status = 'pending';
        entry.delivery_id = deliveryId;
        entry.available_at = new Date(availableAt);
        entry.updated_at = new Date(receivedAt);
      }
      return { rows: [] };
    }

    // Advance debounce query: find pending outbox
    if (/SELECT outbox\.run_id\s+FROM review_dispatch_outbox AS outbox\s+JOIN review_runs AS runs/u.test(sql)) {
      const [repositoryId, prNumber, headSha] = values || [];
      for (const run of state.runs.values()) {
        if (
          run.repository_id === repositoryId &&
          run.pr_number === prNumber &&
          (!headSha || run.head_sha === headSha) &&
          run.status === 'queued'
        ) {
          const ob = state.outbox.get(run.run_id);
          if (ob && ob.status === 'pending') {
            return { rows: [{ run_id: run.run_id }] };
          }
        }
      }
      return { rows: [] };
    }

    // Advance debounce query: update available_at
    if (/UPDATE review_dispatch_outbox\s+SET available_at = to_timestamp\(\$2 \/ 1000\.0\)/u.test(sql)) {
      const [runId, nowMs] = values || [];
      const ob = state.outbox.get(runId);
      if (ob) {
        ob.available_at = new Date(nowMs);
        ob.updated_at = new Date(nowMs);
      }
      return { rows: [] };
    }

    // Cancel runs for pull request
    if (/UPDATE review_runs AS runs\s+SET status = 'cancelled'/u.test(sql)) {
      const [repositoryId, prNumber, nowMs, cancelReason] = values || [];
      const cancelledRunIds: string[] = [];
      for (const run of state.runs.values()) {
        if (
          run.repository_id === repositoryId &&
          run.pr_number === prNumber &&
          ['queued', 'running', 'publishing'].includes(run.status)
        ) {
          run.status = 'cancelled';
          run.stage = 'complete';
          run.error_text = cancelReason;
          run.updated_at = new Date(nowMs);
          cancelledRunIds.push(run.run_id);
          const ob = state.outbox.get(run.run_id);
          if (ob) {
            ob.status = 'terminal';
            ob.updated_at = new Date(nowMs);
          }
        }
      }
      return { rows: cancelledRunIds.map(run_id => ({ run_id })) };
    }

    // Select review_runs by run_id
    if (/SELECT runs\.run_id/u.test(sql) || /SELECT .* FROM review_runs WHERE run_id/u.test(sql)) {
      const runId = values?.[0];
      for (const run of state.runs.values()) {
        if (run.run_id === runId) {
          return { rows: [run] };
        }
      }
      return { rows: [] };
    }

    return { rows: [] };
  });

  const pool = {
    connect: vi.fn(async () => ({ query, release: vi.fn() })),
    query,
  };

  return { state, query, pool };
}

function sampleInput(overrides: Record<string, any> = {}) {
  const headSha = overrides.headSha || HEAD_SHA_1;
  const identity = buildReviewRunIdentity({
    owner: 'calltelemetry',
    repo: 'dashboard',
    prNumber: 42,
    headSha,
    baseSha: BASE_SHA,
  });
  return {
    deliveryId: overrides.deliveryId || `delivery-${headSha.slice(0, 8)}`,
    eventName: 'pull_request',
    repositoryId: 614653796,
    installationId: 456,
    receivedAt: overrides.receivedAt ?? BASE_NOW,
    terminalDeadline: (overrides.receivedAt ?? BASE_NOW) + TERMINAL_DEADLINE_MS,
    payloadDigest: 'a'.repeat(64),
    publicationMode: 'app-gate' as const,
    centralActionDispatch: false,
    debounce: overrides.debounce,
    identity,
    ...overrides,
  };
}

function makeWebhookEvent(eventName: string, action: string, overrides: Record<string, any> = {}) {
  const delivery = overrides.delivery || `delivery-${action}-${Date.now()}`;
  const body = {
    action,
    number: overrides.prNumber || 42,
    installation: { id: 456 },
    repository: {
      id: 614653796,
      name: 'dashboard',
      full_name: 'calltelemetry/dashboard',
      owner: { id: 57884877, login: 'calltelemetry' },
    },
    pull_request: {
      number: overrides.prNumber || 42,
      state: overrides.prState || 'open',
      draft: overrides.draft ?? false,
      head: { sha: overrides.headSha || HEAD_SHA_1 },
      base: { sha: BASE_SHA, repo: { full_name: 'calltelemetry/dashboard' } },
      labels: (overrides.labels || []).map((name: string) => ({ name })),
    },
    ...overrides.extraPayload,
  };
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature256 = `sha256=${createHmac('sha256', SECRET).update(rawBody).digest('hex')}`;
  return { deliveryId: delivery, delivery, eventName, rawBody, body, signature256 };
}

describe('Milestone 1 — Hybrid Trigger Model & Commit Debouncing', () => {
  describe('Outbox Debounce & Burst Cap Logic (Repository Layer)', () => {
    it('initial synchronize with debounce=true sets available_at = received_at + 60s and records burst_started_at', async () => {
      const { state, pool } = createMockDb();
      const repo = new PostgresReviewDispatchRepository(pool);

      const res = await repo.admit(sampleInput({ debounce: true, receivedAt: BASE_NOW }));

      expect(res.status).toBe('accepted');
      expect(res.run.burstStartedAt).toBe(BASE_NOW);

      // Verify outbox entry available_at
      const outboxEntry = state.outbox.get(res.run.runId);
      expect(outboxEntry).toBeDefined();
      expect(outboxEntry.status).toBe('pending');
      expect(outboxEntry.available_at.getTime()).toBe(BASE_NOW + 60_000);
    });

    it('successive synchronize push within 60s inherits burst_started_at and extends available_at by 60s', async () => {
      const { state, pool } = createMockDb();
      const repo = new PostgresReviewDispatchRepository(pool);

      // Commit 1 at T=0
      const push1 = await repo.admit(sampleInput({
        headSha: HEAD_SHA_1,
        debounce: true,
        receivedAt: BASE_NOW,
      }));

      // Commit 2 at T=25s
      const push2 = await repo.admit(sampleInput({
        headSha: HEAD_SHA_2,
        debounce: true,
        receivedAt: BASE_NOW + 25_000,
      }));

      // Burst start should still be T=0
      expect(push2.run.burstStartedAt).toBe(BASE_NOW);

      // Commit 2 outbox available_at is pushed to 25s + 60s = 85s
      const outbox2 = state.outbox.get(push2.run.runId);
      expect(outbox2.available_at.getTime()).toBe(BASE_NOW + 25_000 + 60_000);

      // Commit 1 outbox row should have been superseded to terminal (0 pods created for old commit)
      const outbox1 = state.outbox.get(push1.run.runId);
      expect(outbox1.status).toBe('terminal');
    });

    it('enforces 5-minute burst cap clamping available_at to burst_started_at + 300s during continuous pushes', async () => {
      const { state, pool } = createMockDb();
      const repo = new PostgresReviewDispatchRepository(pool);

      // Rapid pushes at T=0, T=50s, T=100s, T=150s, T=200s, T=250s, T=280s
      let lastPush: any;
      const timestamps = [0, 50, 100, 150, 200, 250, 280];
      for (const sec of timestamps) {
        lastPush = await repo.admit(sampleInput({
          headSha: createHash('sha1').update(`commit-${sec}`).digest('hex'),
          debounce: true,
          receivedAt: BASE_NOW + sec * 1000,
        }));
      }

      // At sec=280: received_at + 60s = 340s, but burst_started_at + 300s = 300s!
      // Therefore available_at must be strictly clamped to T + 300s
      expect(lastPush.run.burstStartedAt).toBe(BASE_NOW);
      const outbox = state.outbox.get(lastPush.run.runId);
      expect(outbox.available_at.getTime()).toBe(BASE_NOW + 300_000);
    });

    it('resets burst_started_at when a push arrives after the 5-minute burst window expires', async () => {
      const { state, pool } = createMockDb();
      const repo = new PostgresReviewDispatchRepository(pool);

      // Push 1 at T=0
      await repo.admit(sampleInput({
        headSha: HEAD_SHA_1,
        debounce: true,
        receivedAt: BASE_NOW,
      }));

      // Push 2 at T=301s (after 5m window has elapsed)
      const push2 = await repo.admit(sampleInput({
        headSha: HEAD_SHA_2,
        debounce: true,
        receivedAt: BASE_NOW + 301_000,
      }));

      // Should reset burst_started_at to the new push time
      expect(push2.run.burstStartedAt).toBe(BASE_NOW + 301_000);
      const outbox = state.outbox.get(push2.run.runId);
      expect(outbox.available_at.getTime()).toBe(BASE_NOW + 301_000 + 60_000);
    });

    it('debounce=false sets available_at = received_at immediately with zero delay', async () => {
      const { state, pool } = createMockDb();
      const repo = new PostgresReviewDispatchRepository(pool);

      const res = await repo.admit(sampleInput({ debounce: false, receivedAt: BASE_NOW }));

      const outbox = state.outbox.get(res.run.runId);
      expect(outbox.available_at.getTime()).toBe(BASE_NOW);
    });
  });

  describe('advanceDebounceAvailableAt & cancelRunsForPullRequest', () => {
    it('advanceDebounceAvailableAt advances pending outbox available_at to now', async () => {
      const { state, pool } = createMockDb();
      const repo = new PostgresReviewDispatchRepository(pool);

      const admission = await repo.admit(sampleInput({
        debounce: true,
        receivedAt: BASE_NOW,
      }));

      const outboxBefore = state.outbox.get(admission.run.runId);
      expect(outboxBefore.available_at.getTime()).toBe(BASE_NOW + 60_000);

      // On-demand trigger at T=10s advances available_at to T=10s
      const advanceResult = await repo.advanceDebounceAvailableAt({
        repositoryId: 614653796,
        prNumber: 42,
        headSha: HEAD_SHA_1,
        now: BASE_NOW + 10_000,
      });

      expect(advanceResult).toEqual({ advanced: true, runId: admission.run.runId });
      const outboxAfter = state.outbox.get(admission.run.runId);
      expect(outboxAfter.available_at.getTime()).toBe(BASE_NOW + 10_000);
    });

    it('advanceDebounceAvailableAt returns advanced: false when no pending outbox row exists', async () => {
      const { pool } = createMockDb();
      const repo = new PostgresReviewDispatchRepository(pool);

      const result = await repo.advanceDebounceAvailableAt({
        repositoryId: 614653796,
        prNumber: 999,
        now: BASE_NOW,
      });

      expect(result).toEqual({ advanced: false });
    });

    it('cancelRunsForPullRequest cancels active runs and terminalizes outbox rows', async () => {
      const { state, pool } = createMockDb();
      const repo = new PostgresReviewDispatchRepository(pool);

      const admission = await repo.admit(sampleInput({
        debounce: true,
        receivedAt: BASE_NOW,
      }));

      const cancelResult = await repo.cancelRunsForPullRequest({
        repositoryId: 614653796,
        prNumber: 42,
        cancelReason: 'converted_to_draft',
        now: BASE_NOW + 5_000,
      });

      expect(cancelResult.cancelledRunIds).toContain(admission.run.runId);

      const runRow = state.runs.get(admission.run.identityDigest);
      expect(runRow.status).toBe('cancelled');
      expect(runRow.stage).toBe('complete');
      expect(runRow.error_text).toBe('converted_to_draft');

      const outboxRow = state.outbox.get(admission.run.runId);
      expect(outboxRow.status).toBe('terminal');
    });
  });

  describe('GitHub Webhook Admission — Trigger Routing & Debounce Flagging', () => {
    it('synchronize action admits with debounce: true', async () => {
      const admit = vi.fn(async () => ({ status: 'accepted', run: { runId: 'run-1' } }));
      const handler = createGitHubWebhookAdmissionHandler({
        config: {
          secret: SECRET,
          admissionEnabled: true,
          repositoryIds: new Set(['614653796']),
          ownerIds: new Set(['57884877']),
        },
        admission: { admit } as any,
        now: () => BASE_NOW,
      });

      const event = makeWebhookEvent('pull_request', 'synchronize');
      const res = await handler(event);

      expect(res.status).toBe('accepted');
      expect(admit).toHaveBeenCalledOnce();
      expect((admit.mock.calls as any)[0][0].debounce).toBe(true);
    });

    it.each(['opened', 'reopened', 'ready_for_review'])(
      '%s action admits with debounce: false',
      async (action) => {
        const admit = vi.fn(async () => ({ status: 'accepted', run: { runId: 'run-1' } }));
        const handler = createGitHubWebhookAdmissionHandler({
          config: {
            secret: SECRET,
            admissionEnabled: true,
            repositoryIds: new Set(['614653796']),
            ownerIds: new Set(['57884877']),
          },
          admission: { admit } as any,
          now: () => BASE_NOW,
        });

        const event = makeWebhookEvent('pull_request', action);
        const res = await handler(event);

        expect(res.status).toBe('accepted');
        expect(admit).toHaveBeenCalledOnce();
        expect((admit.mock.calls as any)[0][0].debounce).toBe(false);
      }
    );

    it('opened with draft: true is ignored with reason: draft_pull_request', async () => {
      const admit = vi.fn();
      const handler = createGitHubWebhookAdmissionHandler({
        config: {
          secret: SECRET,
          admissionEnabled: true,
          repositoryIds: new Set(['614653796']),
          ownerIds: new Set(['57884877']),
        },
        admission: { admit } as any,
        now: () => BASE_NOW,
      });

      const event = makeWebhookEvent('pull_request', 'opened', { draft: true });
      const res = await handler(event);

      expect(res).toEqual(expect.objectContaining({
        status: 'ignored',
        reason: 'unsupported_pull_request_state',
      }));
      expect(admit).not.toHaveBeenCalled();
    });

    it('converted_to_draft triggers cancelRunsForPullRequest and returns reason: converted_to_draft', async () => {
      const cancelRunsForPullRequest = vi.fn(async () => ({ cancelledRunIds: ['run-1', 'run-2'] }));
      const handler = createGitHubWebhookAdmissionHandler({
        config: {
          secret: SECRET,
          admissionEnabled: true,
          repositoryIds: new Set(['614653796']),
          ownerIds: new Set(['57884877']),
        },
        admission: { cancelRunsForPullRequest } as any,
        now: () => BASE_NOW,
      });

      const event = makeWebhookEvent('pull_request', 'converted_to_draft');
      const res = await handler(event);

      expect(res).toEqual(expect.objectContaining({
        status: 'accepted',
        reason: 'converted_to_draft',
        cancelled: 2,
      }));
      expect(cancelRunsForPullRequest).toHaveBeenCalledWith(614653796, 42, 'converted_to_draft', BASE_NOW);
    });
  });

  describe('Label Handling (Opt-out & Opt-in)', () => {
    it.each(['review-yeti:skip', 'wip', 'skip-review'])(
      'PR containing opt-out label "%s" cancels in-flight runs and is ignored',
      async (label) => {
        const cancelRunsForPullRequest = vi.fn(async () => ({ cancelledRunIds: ['run-1'] }));
        const admit = vi.fn();
        const handler = createGitHubWebhookAdmissionHandler({
          config: {
            secret: SECRET,
            admissionEnabled: true,
            repositoryIds: new Set(['614653796']),
            ownerIds: new Set(['57884877']),
          },
          admission: { admit, cancelRunsForPullRequest } as any,
          now: () => BASE_NOW,
        });

        const event = makeWebhookEvent('pull_request', 'synchronize', { labels: [label] });
        const res = await handler(event);

        expect(res).toEqual(expect.objectContaining({
          status: 'ignored',
          reason: 'opt_out_label_present',
        }));
        expect(cancelRunsForPullRequest).toHaveBeenCalledWith(614653796, 42, 'opt_out_label', BASE_NOW);
        expect(admit).not.toHaveBeenCalled();
      }
    );

    it('action: labeled with an opt-out label cancels in-flight runs', async () => {
      const cancelRunsForPullRequest = vi.fn(async () => ({ cancelledRunIds: ['run-1'] }));
      const handler = createGitHubWebhookAdmissionHandler({
        config: {
          secret: SECRET,
          admissionEnabled: true,
          repositoryIds: new Set(['614653796']),
          ownerIds: new Set(['57884877']),
        },
        admission: { cancelRunsForPullRequest } as any,
        now: () => BASE_NOW,
      });

      const event = makeWebhookEvent('pull_request', 'labeled', {
        extraPayload: { label: { name: 'review-yeti:skip' } },
      });
      const res = await handler(event);

      expect(res).toEqual(expect.objectContaining({
        status: 'ignored',
        reason: 'opt_out_label_present',
      }));
      expect(cancelRunsForPullRequest).toHaveBeenCalledWith(614653796, 42, 'opt_out_label', BASE_NOW);
    });

    it('action: labeled with an opt-in label advances debounce if pending', async () => {
      const advanceDebounceAvailableAt = vi.fn(async () => ({ advanced: true, runId: 'run-pending' }));
      const admit = vi.fn();
      const handler = createGitHubWebhookAdmissionHandler({
        config: {
          secret: SECRET,
          admissionEnabled: true,
          repositoryIds: new Set(['614653796']),
          ownerIds: new Set(['57884877']),
        },
        admission: { admit, advanceDebounceAvailableAt } as any,
        now: () => BASE_NOW,
      });

      const event = makeWebhookEvent('pull_request', 'labeled', {
        extraPayload: { label: { name: 'review-yeti' } },
      });
      const res = await handler(event);

      expect(res).toEqual(expect.objectContaining({
        status: 'accepted',
        reason: 'debounce_advanced',
        runId: 'run-pending',
      }));
      expect(advanceDebounceAvailableAt).toHaveBeenCalledWith(614653796, 42, HEAD_SHA_1, BASE_NOW);
      expect(admit).not.toHaveBeenCalled();
    });

    it('action: labeled with an opt-in label admits immediately with debounce: false if no run pending', async () => {
      const advanceDebounceAvailableAt = vi.fn(async () => ({ advanced: false }));
      const admit = vi.fn(async () => ({ status: 'accepted', run: { runId: 'run-new' } }));
      const handler = createGitHubWebhookAdmissionHandler({
        config: {
          secret: SECRET,
          admissionEnabled: true,
          repositoryIds: new Set(['614653796']),
          ownerIds: new Set(['57884877']),
        },
        admission: { admit, advanceDebounceAvailableAt } as any,
        now: () => BASE_NOW,
      });

      const event = makeWebhookEvent('pull_request', 'labeled', {
        extraPayload: { label: { name: 'ct-review' } },
      });
      const res = await handler(event);

      expect(res).toEqual(expect.objectContaining({
        status: 'accepted',
        prNumber: 42,
        headSha: HEAD_SHA_1,
      }));
      expect(admit).toHaveBeenCalledOnce();
      expect((admit.mock.calls as any)[0][0].debounce).toBe(false);
    });

    it('action: unlabeled removing an opt-out label admits immediately with debounce: false', async () => {
      const admit = vi.fn(async () => ({ status: 'accepted', run: { runId: 'run-unlabeled' } }));
      const handler = createGitHubWebhookAdmissionHandler({
        config: {
          secret: SECRET,
          admissionEnabled: true,
          repositoryIds: new Set(['614653796']),
          ownerIds: new Set(['57884877']),
        },
        admission: { admit } as any,
        now: () => BASE_NOW,
      });

      const event = makeWebhookEvent('pull_request', 'unlabeled', {
        extraPayload: { label: { name: 'wip' } },
      });
      const res = await handler(event);

      expect(res).toEqual(expect.objectContaining({
        status: 'accepted',
        reason: 'opt_out_label_removed',
      }));
      expect(admit).toHaveBeenCalledOnce();
      expect((admit.mock.calls as any)[0][0].debounce).toBe(false);
    });
  });

  describe('Issue Comments (/review command)', () => {
    it('/review command advances pending debounce outbox row', async () => {
      const advanceDebounceAvailableAt = vi.fn(async () => ({ advanced: true, runId: 'run-comment-adv' }));
      const admit = vi.fn();
      const handler = createGitHubWebhookAdmissionHandler({
        config: {
          secret: SECRET,
          admissionEnabled: true,
          repositoryIds: new Set(['614653796']),
          ownerIds: new Set(['57884877']),
        },
        admission: { admit, advanceDebounceAvailableAt } as any,
        now: () => BASE_NOW,
      });

      const body = {
        action: 'created',
        repository: {
          id: 614653796,
          name: 'dashboard',
          full_name: 'calltelemetry/dashboard',
          owner: { id: 57884877, login: 'calltelemetry' },
        },
        issue: {
          number: 42,
          state: 'open',
          pull_request: {
            head: { sha: HEAD_SHA_1 },
            base: { sha: BASE_SHA, repo: { full_name: 'calltelemetry/dashboard' } },
          },
        },
        comment: {
          body: 'Hey bot, please /review this PR',
        },
        installation: { id: 456 },
      };
      const rawBody = Buffer.from(JSON.stringify(body));
      const res = await handler({
        deliveryId: 'comment-deliv-1',
        eventName: 'issue_comment',
        rawBody,
        body,
        signature256: `sha256=${createHmac('sha256', SECRET).update(rawBody).digest('hex')}`,
      });

      expect(res).toEqual(expect.objectContaining({
        status: 'accepted',
        reason: 'debounce_advanced',
        runId: 'run-comment-adv',
      }));
      expect(advanceDebounceAvailableAt).toHaveBeenCalledWith(614653796, 42, HEAD_SHA_1, BASE_NOW);
      expect(admit).not.toHaveBeenCalled();
    });

    it('/review command admits immediately with debounce: false if no run pending', async () => {
      const advanceDebounceAvailableAt = vi.fn(async () => ({ advanced: false }));
      const admit = vi.fn(async () => ({ status: 'accepted', run: { runId: 'run-comment-new' } }));
      const handler = createGitHubWebhookAdmissionHandler({
        config: {
          secret: SECRET,
          admissionEnabled: true,
          repositoryIds: new Set(['614653796']),
          ownerIds: new Set(['57884877']),
        },
        admission: { admit, advanceDebounceAvailableAt } as any,
        now: () => BASE_NOW,
      });

      const body = {
        action: 'created',
        repository: {
          id: 614653796,
          name: 'dashboard',
          full_name: 'calltelemetry/dashboard',
          owner: { id: 57884877, login: 'calltelemetry' },
        },
        issue: {
          number: 42,
          state: 'open',
          pull_request: {
            head: { sha: HEAD_SHA_1 },
            base: { sha: BASE_SHA, repo: { full_name: 'calltelemetry/dashboard' } },
          },
        },
        comment: {
          body: '/review',
        },
        installation: { id: 456 },
      };
      const rawBody = Buffer.from(JSON.stringify(body));
      const res = await handler({
        deliveryId: 'comment-deliv-2',
        eventName: 'issue_comment',
        rawBody,
        body,
        signature256: `sha256=${createHmac('sha256', SECRET).update(rawBody).digest('hex')}`,
      });

      expect(res).toEqual(expect.objectContaining({
        status: 'accepted',
        reason: 'review_command',
      }));
      expect(admit).toHaveBeenCalledOnce();
      expect((admit.mock.calls as any)[0][0].debounce).toBe(false);
    });

    it('regular issue comment without /review is ignored with reason: not_command', async () => {
      const admit = vi.fn();
      const handler = createGitHubWebhookAdmissionHandler({
        config: {
          secret: SECRET,
          admissionEnabled: true,
          repositoryIds: new Set(['614653796']),
          ownerIds: new Set(['57884877']),
        },
        admission: { admit } as any,
        now: () => BASE_NOW,
      });

      const body = {
        action: 'created',
        repository: {
          id: 614653796,
          name: 'dashboard',
          full_name: 'calltelemetry/dashboard',
          owner: { id: 57884877, login: 'calltelemetry' },
        },
        issue: {
          number: 42,
          state: 'open',
          pull_request: {
            head: { sha: HEAD_SHA_1 },
            base: { sha: BASE_SHA, repo: { full_name: 'calltelemetry/dashboard' } },
          },
        },
        comment: {
          body: 'Looks good to me!',
        },
        installation: { id: 456 },
      };
      const rawBody = Buffer.from(JSON.stringify(body));
      const res = await handler({
        deliveryId: 'comment-deliv-3',
        eventName: 'issue_comment',
        rawBody,
        body,
        signature256: `sha256=${createHmac('sha256', SECRET).update(rawBody).digest('hex')}`,
      });

      expect(res).toEqual(expect.objectContaining({
        status: 'ignored',
        reason: 'not_review_command',
      }));
      expect(admit).not.toHaveBeenCalled();
    });

    it('/review on closed pull request is ignored with reason: pull_request_not_open', async () => {
      const handler = createGitHubWebhookAdmissionHandler({
        config: {
          secret: SECRET,
          admissionEnabled: true,
          repositoryIds: new Set(['614653796']),
          ownerIds: new Set(['57884877']),
        },
        admission: { admit: vi.fn() } as any,
        now: () => BASE_NOW,
      });

      const body = {
        action: 'created',
        repository: {
          id: 614653796,
          name: 'dashboard',
          full_name: 'calltelemetry/dashboard',
          owner: { id: 57884877, login: 'calltelemetry' },
        },
        issue: {
          number: 42,
          state: 'closed',
          pull_request: {
            head: { sha: HEAD_SHA_1 },
            base: { sha: BASE_SHA, repo: { full_name: 'calltelemetry/dashboard' } },
          },
        },
        comment: {
          body: '/review',
        },
        installation: { id: 456 },
      };
      const rawBody = Buffer.from(JSON.stringify(body));
      const res = await handler({
        deliveryId: 'comment-deliv-4',
        eventName: 'issue_comment',
        rawBody,
        body,
        signature256: `sha256=${createHmac('sha256', SECRET).update(rawBody).digest('hex')}`,
      });

      expect(res).toEqual(expect.objectContaining({
        status: 'ignored',
        reason: 'pull_request_not_open',
      }));
    });
  });

  describe('Configuration Trigger Gating (auto_review.triggers)', () => {
    it('pr_ready only mode rejects synchronize and opened, allows ready_for_review', async () => {
      const admit = vi.fn(async () => ({ status: 'accepted', run: { runId: 'run-1' } }));
      const resolveRepositoryConfig = vi.fn(async () =>
        normalizeRawConfigToV3({ auto_review: { triggers: ['pr_ready'] } })
      );

      const handler = createGitHubWebhookAdmissionHandler({
        config: {
          secret: SECRET,
          admissionEnabled: true,
          repositoryIds: new Set(['614653796']),
          ownerIds: new Set(['57884877']),
        },
        admission: { admit } as any,
        resolveRepositoryConfig,
        now: () => BASE_NOW,
      });

      // synchronize is ignored
      const syncRes = await handler(makeWebhookEvent('pull_request', 'synchronize'));
      expect(syncRes).toEqual(expect.objectContaining({
        status: 'ignored',
        reason: 'trigger_not_configured',
      }));

      // opened is ignored
      const openRes = await handler(makeWebhookEvent('pull_request', 'opened'));
      expect(openRes).toEqual(expect.objectContaining({
        status: 'ignored',
        reason: 'trigger_not_configured',
      }));

      // ready_for_review is accepted
      const readyRes = await handler(makeWebhookEvent('pull_request', 'ready_for_review'));
      expect(readyRes.status).toBe('accepted');
    });

    it('@ct-review only mode rejects automatic PR events, allows /review comment', async () => {
      const admit = vi.fn(async () => ({ status: 'accepted', run: { runId: 'run-1' } }));
      const resolveRepositoryConfig = vi.fn(async () =>
        normalizeRawConfigToV3({ auto_review: { triggers: ['@ct-review'] } })
      );

      const handler = createGitHubWebhookAdmissionHandler({
        config: {
          secret: SECRET,
          admissionEnabled: true,
          repositoryIds: new Set(['614653796']),
          ownerIds: new Set(['57884877']),
        },
        admission: { admit } as any,
        resolveRepositoryConfig,
        now: () => BASE_NOW,
      });

      // synchronize is ignored
      const syncRes = await handler(makeWebhookEvent('pull_request', 'synchronize'));
      expect(syncRes).toEqual(expect.objectContaining({
        status: 'ignored',
        reason: 'trigger_not_configured',
      }));

      // /review comment is accepted
      const body = {
        action: 'created',
        repository: {
          id: 614653796,
          name: 'dashboard',
          full_name: 'calltelemetry/dashboard',
          owner: { id: 57884877, login: 'calltelemetry' },
        },
        issue: {
          number: 42,
          state: 'open',
          pull_request: {
            head: { sha: HEAD_SHA_1 },
            base: { sha: BASE_SHA, repo: { full_name: 'calltelemetry/dashboard' } },
          },
        },
        comment: {
          body: '/review',
        },
        installation: { id: 456 },
      };
      const rawBody = Buffer.from(JSON.stringify(body));
      const commentRes = await handler({
        deliveryId: 'comment-ondemand',
        eventName: 'issue_comment',
        rawBody,
        body,
        signature256: `sha256=${createHmac('sha256', SECRET).update(rawBody).digest('hex')}`,
      });
      expect(commentRes.status).toBe('accepted');
    });

    it('auto_review.enabled = false suppresses automatic webhook admission', async () => {
      const admit = vi.fn();
      const resolveRepositoryConfig = vi.fn(async () =>
        normalizeRawConfigToV3({ auto_review: { enabled: false } })
      );

      const handler = createGitHubWebhookAdmissionHandler({
        config: {
          secret: SECRET,
          admissionEnabled: true,
          repositoryIds: new Set(['614653796']),
          ownerIds: new Set(['57884877']),
        },
        admission: { admit } as any,
        resolveRepositoryConfig,
        now: () => BASE_NOW,
      });

      const res = await handler(makeWebhookEvent('pull_request', 'synchronize'));
      expect(res).toEqual(expect.objectContaining({
        status: 'ignored',
        reason: 'auto_review_disabled',
      }));
      expect(admit).not.toHaveBeenCalled();
    });
  });
});
