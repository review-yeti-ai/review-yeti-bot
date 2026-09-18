import { createHmac, createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  PostgresReviewDispatchRepository as DurablePostgresReviewDispatchRepository,
  type ReviewDispatchRepositoryOptions,
} from '../../src/persistence/reviewDispatchRepository';
import {
  createGitHubWebhookAdmissionHandler,
  isOptOutLabel,
  isOptInLabel,
  hasOptOutLabel,
  hasOptInLabel,
} from '../../src/review/githubWebhookAdmission';
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
const BASE_NOW = Date.parse('2026-09-18T12:00:00.000Z');
const HEAD_SHA_1 = '1111111111111111111111111111111111111111';
const HEAD_SHA_2 = '2222222222222222222222222222222222222222';
const HEAD_SHA_3 = '3333333333333333333333333333333333333333';
const HEAD_SHA_4 = '4444444444444444444444444444444444444444';
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
          attempt: 0,
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

    // Claim next outbox entry (CTE query)
    if (/WITH candidate AS/u.test(sql) && /UPDATE review_dispatch_outbox AS outbox/u.test(sql)) {
      const [workerId, nowMs, leaseMs] = values || [];
      // Find candidate
      const candidates: Array<{ run: any; outbox: any }> = [];
      for (const run of state.runs.values()) {
        if (run.status !== 'queued') continue;
        if (run.terminal_deadline.getTime() <= nowMs) continue;
        const ob = state.outbox.get(run.run_id);
        if (!ob) continue;
        if (ob.available_at.getTime() > nowMs) continue;
        if (ob.status === 'pending' || (ob.status === 'claimed' && ob.lease_expires_at?.getTime() <= nowMs)) {
          candidates.push({ run, outbox: ob });
        }
      }
      candidates.sort((a, b) => {
        const aAvail = a.outbox.available_at.getTime();
        const bAvail = b.outbox.available_at.getTime();
        if (aAvail !== bAvail) return aAvail - bAvail;
        return a.outbox.created_at.getTime() - b.outbox.created_at.getTime();
      });

      const selected = candidates[0];
      if (!selected) {
        return { rows: [] };
      }

      selected.outbox.status = 'claimed';
      selected.outbox.lease_owner = workerId;
      selected.outbox.lease_expires_at = new Date(nowMs + leaseMs);
      selected.outbox.attempt = (selected.outbox.attempt || 0) + 1;
      selected.outbox.updated_at = new Date(nowMs);

      return {
        rows: [{
          run_id: selected.run.run_id,
          delivery_id: selected.outbox.delivery_id,
          repository_id: selected.run.repository_id,
          installation_id: selected.run.installation_id,
          publication_mode: selected.run.publication_mode,
          authoritative_gate_app_id: selected.run.authoritative_gate_app_id,
          owner: selected.run.owner,
          repo: selected.run.repo,
          pr_number: selected.run.pr_number,
          head_sha: selected.run.head_sha,
          base_sha: selected.run.base_sha,
          received_at: selected.run.received_at,
          terminal_deadline: selected.run.terminal_deadline,
          effective_policy_digest: selected.run.effective_policy_digest,
          effective_config_digest: selected.run.effective_config_digest,
          claim_attempt: selected.outbox.attempt,
          execution_attempt: (selected.outbox.execution_attempt || 0) + 1,
          worker_token_digest: null,
          lease_owner: selected.outbox.lease_owner,
          lease_expires_at: selected.outbox.lease_expires_at,
        }],
      };
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
  const prNumber = overrides.prNumber ?? 42;
  const owner = overrides.owner || 'calltelemetry';
  const repo = overrides.repo || 'dashboard';
  const identity = buildReviewRunIdentity({
    owner,
    repo,
    prNumber,
    headSha,
    baseSha: BASE_SHA,
  });
  return {
    deliveryId: overrides.deliveryId || `delivery-${headSha.slice(0, 8)}`,
    eventName: 'pull_request',
    repositoryId: overrides.repositoryId ?? 614653796,
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
      id: overrides.repositoryId ?? 614653796,
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

describe('Challenger M1-1: Empirical Stress & Adversarial Verification', () => {
  describe('Dimension 1: Debounce Quiet Window Trailing Extension on Rapid Synchronize Pushes', () => {
    it('verifies trailing 60s extension at t=0s, 20s, 40s, 55s with strict available_at timestamps', async () => {
      const { state, pool } = createMockDb();
      const repo = new PostgresReviewDispatchRepository(pool);

      // t=0s push
      const push0 = await repo.admit(sampleInput({
        headSha: HEAD_SHA_1,
        debounce: true,
        receivedAt: BASE_NOW,
      }));
      expect(push0.status).toBe('accepted');
      expect(push0.run.burstStartedAt).toBe(BASE_NOW);
      expect(state.outbox.get(push0.run.runId).available_at.getTime()).toBe(BASE_NOW + 60_000);

      // t=20s push
      const push20 = await repo.admit(sampleInput({
        headSha: HEAD_SHA_2,
        debounce: true,
        receivedAt: BASE_NOW + 20_000,
      }));
      expect(push20.run.burstStartedAt).toBe(BASE_NOW);
      expect(state.outbox.get(push20.run.runId).available_at.getTime()).toBe(BASE_NOW + 20_000 + 60_000); // 80s

      // t=40s push
      const push40 = await repo.admit(sampleInput({
        headSha: HEAD_SHA_3,
        debounce: true,
        receivedAt: BASE_NOW + 40_000,
      }));
      expect(push40.run.burstStartedAt).toBe(BASE_NOW);
      expect(state.outbox.get(push40.run.runId).available_at.getTime()).toBe(BASE_NOW + 40_000 + 60_000); // 100s

      // t=55s push
      const push55 = await repo.admit(sampleInput({
        headSha: HEAD_SHA_4,
        debounce: true,
        receivedAt: BASE_NOW + 55_000,
      }));
      expect(push55.run.burstStartedAt).toBe(BASE_NOW);
      expect(state.outbox.get(push55.run.runId).available_at.getTime()).toBe(BASE_NOW + 55_000 + 60_000); // 115s

      // Verify all prior outbox entries are marked terminal
      expect(state.outbox.get(push0.run.runId).status).toBe('terminal');
      expect(state.outbox.get(push20.run.runId).status).toBe('terminal');
      expect(state.outbox.get(push40.run.runId).status).toBe('terminal');
      expect(state.outbox.get(push55.run.runId).status).toBe('pending');

      // Verify at t=59s (1 second before push0 would have expired), claimNext returns null (no pods!)
      const claimAt59 = await repo.claimNext('worker-1', BASE_NOW + 59_000, 30_000);
      expect(claimAt59).toBeNull();

      // Verify at t=114s, claimNext still returns null
      const claimAt114 = await repo.claimNext('worker-1', BASE_NOW + 114_000, 30_000);
      expect(claimAt114).toBeNull();

      // Verify at t=115s (quiet window elapsed), claimNext succeeds for push55!
      const claimAt115 = await repo.claimNext('worker-1', BASE_NOW + 115_000, 30_000);
      expect(claimAt115).not.toBeNull();
      expect(claimAt115?.runId).toBe(push55.run.runId);
      expect(claimAt115?.headSha).toBe(HEAD_SHA_4);
    });
  });

  describe('Dimension 2: 5-Minute Burst Cap Enforcement Past 300 Seconds', () => {
    it('strictly clamps available_at to burst_started_at + 300s during continuous rapid pushes', async () => {
      const { state, pool } = createMockDb();
      const repo = new PostgresReviewDispatchRepository(pool);

      // Rapid pushes at intervals extending past 300s:
      // t = 0, 30, 60, 90, 120, 150, 180, 210, 240, 260, 280, 299, 300
      const testTimestampsSec = [0, 30, 60, 90, 120, 150, 180, 210, 240, 260, 280, 299, 300];
      let lastRunId = '';

      for (const sec of testTimestampsSec) {
        const headSha = createHash('sha1').update(`commit-sec-${sec}`).digest('hex');
        const admission = await repo.admit(sampleInput({
          headSha,
          debounce: true,
          receivedAt: BASE_NOW + sec * 1000,
        }));
        lastRunId = admission.run.runId;
        expect(admission.run.burstStartedAt).toBe(BASE_NOW);

        const outbox = state.outbox.get(lastRunId);
        const expectedAvailableAt = Math.min(BASE_NOW + sec * 1000 + 60_000, BASE_NOW + 300_000);
        expect(outbox.available_at.getTime()).toBe(expectedAvailableAt);
      }

      // At sec=300, available_at MUST be exactly burst_started_at + 300s (no further extension)
      const finalOutbox = state.outbox.get(lastRunId);
      expect(finalOutbox.available_at.getTime()).toBe(BASE_NOW + 300_000);

      // Now at t=300s, it is claimable!
      const claimAt300 = await repo.claimNext('worker-1', BASE_NOW + 300_000, 30_000);
      expect(claimAt300).not.toBeNull();
      expect(claimAt300?.runId).toBe(lastRunId);
    });

    it('resets burst_started_at when a push arrives at t=320s after burst window expires', async () => {
      const { state, pool } = createMockDb();
      const repo = new PostgresReviewDispatchRepository(pool);

      // Push 1 at T=0
      await repo.admit(sampleInput({
        headSha: HEAD_SHA_1,
        debounce: true,
        receivedAt: BASE_NOW,
      }));

      // Push 2 at T=320s (window expired > 300s)
      const push320 = await repo.admit(sampleInput({
        headSha: HEAD_SHA_2,
        debounce: true,
        receivedAt: BASE_NOW + 320_000,
      }));

      expect(push320.run.burstStartedAt).toBe(BASE_NOW + 320_000);
      const outbox = state.outbox.get(push320.run.runId);
      expect(outbox.available_at.getTime()).toBe(BASE_NOW + 320_000 + 60_000);
    });

    it('handles negative or backwards time skew gracefully without crashing or corrupting burst', async () => {
      const { state, pool } = createMockDb();
      const repo = new PostgresReviewDispatchRepository(pool);

      // Push 1 at T=100s
      await repo.admit(sampleInput({
        headSha: HEAD_SHA_1,
        debounce: true,
        receivedAt: BASE_NOW + 100_000,
      }));

      // Push 2 arrives with clock skew T=50s (< 100s)
      const pushSkewed = await repo.admit(sampleInput({
        headSha: HEAD_SHA_2,
        debounce: true,
        receivedAt: BASE_NOW + 50_000,
      }));

      // Because receivedAt - priorBurst < 0, it resets burstStartedAt to its receivedAt
      expect(pushSkewed.run.burstStartedAt).toBe(BASE_NOW + 50_000);
      const outbox = state.outbox.get(pushSkewed.run.runId);
      expect(outbox.available_at.getTime()).toBe(BASE_NOW + 50_000 + 60_000);
    });
  });

  describe('Dimension 3: In-Queue Superseding & Zero Pod Scheduling', () => {
    it('guarantees obsolete commits in outbox are terminal before claim with 0 pods created', async () => {
      const { state, pool } = createMockDb();
      const repo = new PostgresReviewDispatchRepository(pool);

      // Sequence of 5 rapid commits in the queue:
      // t=0s, 15s, 30s, 45s, 50s
      const commits = [
        { sha: HEAD_SHA_1, t: 0 },
        { sha: HEAD_SHA_2, t: 15_000 },
        { sha: HEAD_SHA_3, t: 30_000 },
        { sha: HEAD_SHA_4, t: 45_000 },
        { sha: createHash('sha1').update('commit-5').digest('hex'), t: 50_000 },
      ];

      const runIds: string[] = [];

      for (const c of commits) {
        const adm = await repo.admit(sampleInput({
          headSha: c.sha,
          debounce: true,
          receivedAt: BASE_NOW + c.t,
        }));
        runIds.push(adm.run.runId);

        // Attempting to claim immediately during debounce window must yield null
        const earlyClaim = await repo.claimNext('worker-test', BASE_NOW + c.t + 1000, 30_000);
        expect(earlyClaim).toBeNull();
      }

      // Check states of all 5 runs:
      // Commits 1..4 MUST be superseded in review_runs and terminal in outbox
      for (let i = 0; i < 4; i++) {
        const runId = runIds[i];
        const outboxRow = state.outbox.get(runId);
        expect(outboxRow.status).toBe('terminal');
      }

      // Commit 5 is the sole pending run
      const lastRunId = runIds[4];
      const lastOutbox = state.outbox.get(lastRunId);
      expect(lastOutbox.status).toBe('pending');
      expect(lastOutbox.available_at.getTime()).toBe(BASE_NOW + 50_000 + 60_000); // 110s

      // Polling at t=60s (when commit 1 would have run): 0 pods scheduled!
      const claim60 = await repo.claimNext('worker-test', BASE_NOW + 60_000, 30_000);
      expect(claim60).toBeNull();

      // Polling at t=100s: 0 pods scheduled!
      const claim100 = await repo.claimNext('worker-test', BASE_NOW + 100_000, 30_000);
      expect(claim100).toBeNull();

      // Polling at t=110s: exactly ONE pod scheduled (for commit 5)!
      const claim110 = await repo.claimNext('worker-test', BASE_NOW + 110_000, 30_000);
      expect(claim110).not.toBeNull();
      expect(claim110?.runId).toBe(lastRunId);
      expect(claim110?.headSha).toBe(commits[4].sha);

      // Polling again at t=110s: 0 pods scheduled!
      const claimAgain = await repo.claimNext('worker-test', BASE_NOW + 110_000, 30_000);
      expect(claimAgain).toBeNull();

      // Across 5 commits, total pods scheduled = 1 (exactly the latest commit).
    });

    it('isolates debouncing across distinct PRs and repositories', async () => {
      const { state, pool } = createMockDb();
      const repo = new PostgresReviewDispatchRepository(pool);

      // PR 42 push at t=0
      const pr42 = await repo.admit(sampleInput({
        prNumber: 42,
        headSha: HEAD_SHA_1,
        debounce: true,
        receivedAt: BASE_NOW,
      }));

      // PR 43 push at t=30
      const pr43 = await repo.admit(sampleInput({
        prNumber: 43,
        headSha: HEAD_SHA_2,
        debounce: true,
        receivedAt: BASE_NOW + 30_000,
      }));

      // PR 43 must have its OWN burst start at t=30s, not inherit PR 42's burst
      expect(pr42.run.burstStartedAt).toBe(BASE_NOW);
      expect(pr43.run.burstStartedAt).toBe(BASE_NOW + 30_000);

      // Neither supersedes the other
      expect(state.outbox.get(pr42.run.runId).status).toBe('pending');
      expect(state.outbox.get(pr43.run.runId).status).toBe('pending');

      // PR 42 available at t=60s
      expect(state.outbox.get(pr42.run.runId).available_at.getTime()).toBe(BASE_NOW + 60_000);
      // PR 43 available at t=90s
      expect(state.outbox.get(pr43.run.runId).available_at.getTime()).toBe(BASE_NOW + 90_000);
    });
  });

  describe('Dimension 4: Opt-Out Labels & Draft Conversions In-Flight Cancellation', () => {
    it('cancels pending outbox and active runs when converted_to_draft arrives', async () => {
      const { state, pool } = createMockDb();
      const repo = new PostgresReviewDispatchRepository(pool);

      // Commit debouncing in outbox
      const admission = await repo.admit(sampleInput({
        debounce: true,
        receivedAt: BASE_NOW,
      }));
      expect(state.outbox.get(admission.run.runId).status).toBe('pending');

      // Webhook handler receiving converted_to_draft
      const handler = createGitHubWebhookAdmissionHandler({
        config: {
          secret: SECRET,
          admissionEnabled: true,
          repositoryIds: new Set(['614653796']),
          ownerIds: new Set(['57884877']),
        },
        admission: repo as any,
        now: () => BASE_NOW + 5_000,
      });

      const event = makeWebhookEvent('pull_request', 'converted_to_draft', { prNumber: 42 });
      const res = await handler(event);

      expect(res).toEqual(expect.objectContaining({
        status: 'accepted',
        reason: 'converted_to_draft',
        cancelled: 1,
      }));

      // Outbox row is now terminal, review_run is cancelled
      const outboxRow = state.outbox.get(admission.run.runId);
      expect(outboxRow.status).toBe('terminal');

      // Subsequent claim yields null even after available_at
      const claim = await repo.claimNext('worker-1', BASE_NOW + 70_000, 30_000);
      expect(claim).toBeNull();
    });

    it.each([
      ['review-yeti:skip'],
      ['WIP'],
      ['  Skip-Review  '],
      ['REVIEW-YETI:SKIP'],
    ])('suppresses synchronize and cancels active runs when PR has opt-out label "%s"', async (label) => {
      const cancelRunsForPullRequest = vi.fn(async () => ({ cancelledRunIds: ['run-old'] }));
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

      // Synchronize event on PR with opt-out label
      const event = makeWebhookEvent('pull_request', 'synchronize', {
        labels: ['feature-branch', label, 'ready-for-qa'],
      });
      const res = await handler(event);

      expect(res).toEqual(expect.objectContaining({
        status: 'ignored',
        reason: 'opt_out_label_present',
      }));
      expect(cancelRunsForPullRequest).toHaveBeenCalledWith(614653796, 42, 'opt_out_label', BASE_NOW);
      expect(admit).not.toHaveBeenCalled();
    });

    it('unlabeling opt-out label admits immediately with debounce: false', async () => {
      const admit = vi.fn(async () => ({ status: 'accepted', run: { runId: 'run-resumed' } }));
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
        extraPayload: { label: { name: 'review-yeti:skip' } },
        labels: [], // remaining labels do not include opt-out
      });
      const res = await handler(event);

      expect(res).toEqual(expect.objectContaining({
        status: 'accepted',
        reason: 'opt_out_label_removed',
      }));
      expect(admit).toHaveBeenCalledOnce();
      expect((admit.mock.calls as any)[0][0].debounce).toBe(false);
    });

    it('label helper functions correctly detect opt-out and opt-in label variations', () => {
      expect(isOptOutLabel('review-yeti:skip')).toBe(true);
      expect(isOptOutLabel('REVIEW-YETI:SKIP')).toBe(true);
      expect(isOptOutLabel('  wip  ')).toBe(true);
      expect(isOptOutLabel('skip-review')).toBe(true);
      expect(isOptOutLabel('other-label')).toBe(false);

      expect(isOptInLabel('review-yeti')).toBe(true);
      expect(isOptInLabel('CT-REVIEW')).toBe(true);
      expect(isOptInLabel('ai-review')).toBe(true);
      expect(isOptInLabel('skip-review')).toBe(false);

      expect(hasOptOutLabel(['documentation', 'WIP'])).toBe(true);
      expect(hasOptOutLabel(['documentation', 'bug'])).toBe(false);

      expect(hasOptInLabel(['documentation', 'ct-review'])).toBe(true);
      expect(hasOptInLabel(['documentation', 'bug'])).toBe(false);
    });
  });

  describe('Dimension 5: On-Demand Bypassing & Acceleration (/review & Opt-in Labels)', () => {
    it('/review command advances pending debounced run and claims immediately', async () => {
      const { state, pool } = createMockDb();
      const repo = new PostgresReviewDispatchRepository(pool);

      // Commit 1 debouncing at t=0s, available at t=60s
      const adm = await repo.admit(sampleInput({
        headSha: HEAD_SHA_1,
        debounce: true,
        receivedAt: BASE_NOW,
      }));

      // At t=10s, developer posts "/review"
      const advanceRes = await repo.advanceDebounceAvailableAt({
        repositoryId: 614653796,
        prNumber: 42,
        headSha: HEAD_SHA_1,
        now: BASE_NOW + 10_000,
      });

      expect(advanceRes).toEqual({ advanced: true, runId: adm.run.runId });
      expect(state.outbox.get(adm.run.runId).available_at.getTime()).toBe(BASE_NOW + 10_000);

      // Now at t=10s, claimNext succeeds immediately without waiting for 60s!
      const claim = await repo.claimNext('worker-fast', BASE_NOW + 10_000, 30_000);
      expect(claim).not.toBeNull();
      expect(claim?.runId).toBe(adm.run.runId);
    });

    it.each([
      ['/review'],
      ['/review please'],
      ['hey bot, /review this diff'],
      ['@review-yeti review'],
      ['@ct-review take a look'],
    ])('webhook admission recognizes review command variant: "%s"', async (commentText) => {
      const advanceDebounceAvailableAt = vi.fn(async () => ({ advanced: true, runId: 'run-1' }));
      const handler = createGitHubWebhookAdmissionHandler({
        config: {
          secret: SECRET,
          admissionEnabled: true,
          repositoryIds: new Set(['614653796']),
          ownerIds: new Set(['57884877']),
        },
        admission: { advanceDebounceAvailableAt } as any,
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
        comment: { body: commentText },
        installation: { id: 456 },
      };
      const rawBody = Buffer.from(JSON.stringify(body));
      const res = await handler({
        deliveryId: 'comm-1',
        eventName: 'issue_comment',
        rawBody,
        body,
        signature256: `sha256=${createHmac('sha256', SECRET).update(rawBody).digest('hex')}`,
      });

      expect(res.status).toBe('accepted');
      expect(res.reason).toBe('debounce_advanced');
    });
  });

  describe('Dimension 6: Configuration Trigger Gating (auto_review.triggers)', () => {
    it('handles defaults when triggers is undefined or empty', () => {
      expect(isTriggerActionAllowed(undefined, 'synchronize')).toBe(true);
      expect(isTriggerActionAllowed(undefined, 'opened')).toBe(true);
      expect(isTriggerActionAllowed(undefined, 'issue_comment', { isCommand: true })).toBe(true);
      expect(isTriggerActionAllowed([], 'synchronize')).toBe(true);
    });

    it('rejects synchronize when triggers = ["pr_opened", "@ct-review"]', () => {
      const triggers = ['pr_opened', '@ct-review'];
      expect(isTriggerActionAllowed(triggers, 'synchronize')).toBe(false);
      expect(isTriggerActionAllowed(triggers, 'opened')).toBe(true);
      expect(isTriggerActionAllowed(triggers, 'issue_comment', { isCommand: true })).toBe(true);
    });

    it('rejects opened and synchronize when triggers = ["pr_ready"]', () => {
      const triggers = ['pr_ready'];
      expect(isTriggerActionAllowed(triggers, 'opened')).toBe(false);
      expect(isTriggerActionAllowed(triggers, 'synchronize')).toBe(false);
      expect(isTriggerActionAllowed(triggers, 'ready_for_review')).toBe(true);
    });

    it('allows only on-demand commands when triggers = ["@ct-review"]', () => {
      const triggers = ['@ct-review'];
      expect(isTriggerActionAllowed(triggers, 'opened')).toBe(false);
      expect(isTriggerActionAllowed(triggers, 'synchronize')).toBe(false);
      expect(isTriggerActionAllowed(triggers, 'ready_for_review')).toBe(false);
      expect(isTriggerActionAllowed(triggers, 'issue_comment', { isCommand: true })).toBe(true);
      expect(isTriggerActionAllowed(triggers, 'labeled', { isTag: true })).toBe(true);
    });
  });
});
