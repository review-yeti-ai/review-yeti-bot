import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  PostgresReviewDispatchRepository as DurablePostgresReviewDispatchRepository,
  type ReviewDispatchRepositoryOptions,
  type PendingCancellation,
  type RunStatusResult,
} from '../../src/persistence/reviewDispatchRepository';
import { ReviewJobDispatchEngine } from '../../src/k8s/reviewJobDispatchEngine';
import { KubernetesReviewJobProjector } from '../../src/k8s/kubernetesReviewJobProjector';
import { createActionDispatchRouter } from '../../src/api/actionDispatchApi';
import { WorkerStatusPoller } from '../../src/cli/workerStatusPoller';
import { buildReviewRunIdentity } from '../../src/review/reviewAdmission';
import { TERMINAL_DEADLINE_MS } from '../../src/config/terminalDeadline';

class PostgresReviewDispatchRepository extends DurablePostgresReviewDispatchRepository {
  constructor(pool: any, queryable?: any, options: Partial<ReviewDispatchRepositoryOptions> = {}) {
    super(pool, queryable, { lifecycleEvents: 'disabled', ...options });
  }
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

const BASE_NOW = Date.parse('2026-09-18T12:00:00.000Z');
const HEAD_SHA_1 = '1111111111111111111111111111111111111111';
const HEAD_SHA_2 = '2222222222222222222222222222222222222222';
const HEAD_SHA_3 = '3333333333333333333333333333333333333333';
const BASE_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

interface MockDbState {
  runs: Map<string, any>;
  outbox: Map<string, any>;
  deliveries: Map<string, any>;
}

function createEmpiricalMockDb() {
  const state: MockDbState = {
    runs: new Map(),
    outbox: new Map(),
    deliveries: new Map(),
  };

  // Mutex lock to simulate Postgres pg_advisory_xact_lock serialization
  let lockChain = Promise.resolve();

  const query = vi.fn(async (sql: string, values?: any[]) => {
    // Transaction control & advisory lock
    if (/^BEGIN$/u.test(sql)) {
      return { rows: [] };
    }
    if (/^COMMIT$/u.test(sql) || /^ROLLBACK$/u.test(sql)) {
      return { rows: [] };
    }

    if (/SELECT pg_advisory_xact_lock/u.test(sql)) {
      // Chain onto existing lock to serialize transactions
      let unlock: () => void = () => {};
      const currentLock = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      const previousLock = lockChain;
      lockChain = lockChain.then(() => currentLock);
      await previousLock;
      // Return release function via client release simulation
      setTimeout(unlock, 5); // Automatically unlock when transaction completes
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
        (r) => r.owner === owner && r.repo === repo && r.pr_number === prNumber,
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
        runId,
        identityDigest,
        owner,
        repo,
        prNumber,
        headSha,
        baseSha,
        snapshotDigest,
        configDigest,
        effectivePolicyDigest,
        indexEpoch,
        identityStr,
        repositoryId,
        installationId,
        deliveryId,
        receivedAt,
        terminalDeadline,
        publicationMode,
        authoritativeGateAppId,
        retryRequested,
        retryAfterExecutionAttempt,
        reaperFailureText,
        burstStartedAt,
      ] = values || [];

      let run = state.runs.get(identityDigest);
      if (!run) {
        run = {
          run_id: runId,
          identity_digest: identityDigest,
          owner,
          repo,
          pr_number: prNumber,
          head_sha: headSha,
          base_sha: baseSha,
          snapshot_digest: snapshotDigest,
          config_digest: configDigest,
          effective_policy_digest: effectivePolicyDigest,
          effective_config_digest: effectivePolicyDigest,
          index_epoch: indexEpoch || 0,
          identity: typeof identityStr === 'string' ? JSON.parse(identityStr) : identityStr,
          repository_id: repositoryId,
          installation_id: installationId,
          delivery_id: deliveryId,
          received_at: new Date(receivedAt),
          terminal_deadline: new Date(terminalDeadline),
          publication_mode: publicationMode || 'disabled',
          authoritative_gate_app_id: authoritativeGateAppId || null,
          status: 'queued',
          stage: 'admitted',
          attempt: 0,
          created_at: new Date(receivedAt),
          updated_at: new Date(receivedAt),
          admitted_at: new Date(receivedAt),
          cancel_requested_at: null,
          cancel_reason: null,
          cancel_propagated_at: null,
        };
        state.runs.set(identityDigest, run);
      }
      return { rows: [run] };
    }

    // Supersede CTE in admit()
    if (/WITH superseded AS/u.test(sql) && /UPDATE review_dispatch_outbox AS outbox/u.test(sql)) {
      const [owner, repo, prNumber, identityDigest, nowMs] = values || [];
      const supersededList: Array<{ run_id: string; cancel_propagated_at: Date | null }> = [];

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
          run.cancel_requested_at = new Date(nowMs);
          run.cancel_reason = 'superseded_by_new_head';
          run.lease_owner = null;
          run.lease_expires_at = null;
          run.updated_at = new Date(nowMs);

          const outboxEntry = state.outbox.get(run.run_id);
          if (outboxEntry) {
            outboxEntry.status = 'terminal';
            outboxEntry.cancel_requested_at = new Date(nowMs);
            outboxEntry.cancel_reason = 'superseded_by_new_head';
            outboxEntry.cancel_propagated_at =
              outboxEntry.projection_name == null ? new Date(nowMs) : null;
            outboxEntry.lease_owner = null;
            outboxEntry.lease_expires_at = null;
            outboxEntry.updated_at = new Date(nowMs);
            supersededList.push({
              run_id: run.run_id,
              cancel_propagated_at: outboxEntry.cancel_propagated_at,
            });
          } else {
            supersededList.push({ run_id: run.run_id, cancel_propagated_at: new Date(nowMs) });
          }
        }
      }
      return { rows: supersededList };
    }

    // UPDATE review_runs SET cancel_propagated_at = ... WHERE run_id = $1
    if (/UPDATE review_runs SET cancel_propagated_at = to_timestamp\(\$2 \/ 1000\.0\) WHERE run_id = \$1/u.test(sql)) {
      const [runId, nowMs] = values || [];
      for (const run of state.runs.values()) {
        if (run.run_id === runId) {
          run.cancel_propagated_at = new Date(nowMs);
        }
      }
      return { rows: [] };
    }

    // UPDATE github_deliveries SET run_id
    if (/UPDATE github_deliveries SET run_id/u.test(sql)) {
      return { rows: [] };
    }

    // INSERT INTO review_dispatch_outbox
    if (/INSERT INTO review_dispatch_outbox/u.test(sql)) {
      const [runId, deliveryId, receivedAt, terminalDeadline, availableAt] = values || [];
      let entry = state.outbox.get(runId);
      if (!entry) {
        entry = {
          run_id: runId,
          delivery_id: deliveryId,
          status: 'pending',
          available_at: new Date(availableAt || receivedAt),
          created_at: new Date(receivedAt),
          updated_at: new Date(receivedAt),
          execution_attempt: 0,
          attempt: 0,
          projection_name: null,
          cancel_requested_at: null,
          cancel_reason: null,
          cancel_propagated_at: null,
          worker_token_digest: null,
          lease_owner: null,
          lease_expires_at: null,
        };
        state.outbox.set(runId, entry);
      } else {
        entry.status = 'pending';
        entry.delivery_id = deliveryId;
        entry.available_at = new Date(availableAt || receivedAt);
        entry.updated_at = new Date(receivedAt);
      }
      return { rows: [] };
    }

    // findPendingCancellations
    if (/WHERE outbox\.cancel_requested_at IS NOT NULL\s+AND outbox\.cancel_propagated_at IS NULL\s+AND outbox\.projection_name IS NOT NULL/u.test(sql)) {
      const limit = values?.[0] || 10;
      const matching: any[] = [];
      for (const entry of state.outbox.values()) {
        if (
          entry.cancel_requested_at != null &&
          entry.cancel_propagated_at == null &&
          entry.projection_name != null
        ) {
          matching.push(entry);
        }
      }
      matching.sort((a, b) => {
        const aTime = a.cancel_requested_at ? new Date(a.cancel_requested_at).getTime() : 0;
        const bTime = b.cancel_requested_at ? new Date(b.cancel_requested_at).getTime() : 0;
        return aTime - bTime;
      });
      const slice = matching.slice(0, limit);
      return {
        rows: slice.map((row) => ({
          run_id: row.run_id,
          execution_attempt: (row.execution_attempt || 0) + 1,
          projection_name: row.projection_name,
          cancel_reason: row.cancel_reason,
        })),
      };
    }

    // markCancelPropagated: update review_dispatch_outbox
    if (/UPDATE review_dispatch_outbox\s+SET cancel_propagated_at = to_timestamp\(\$3 \/ 1000\.0\)/u.test(sql)) {
      const [runId, executionAttempt, nowMs] = values || [];
      const entry = state.outbox.get(runId);
      if (
        entry &&
        (entry.execution_attempt || 0) + 1 === executionAttempt &&
        entry.cancel_requested_at != null &&
        entry.cancel_propagated_at == null
      ) {
        entry.cancel_propagated_at = new Date(nowMs);
        entry.updated_at = new Date(nowMs);
        return { rows: [{ run_id: runId }] };
      }
      return { rows: [] };
    }

    // markCancelPropagated: update review_runs
    if (/UPDATE review_runs\s+SET cancel_propagated_at = to_timestamp\(\$2 \/ 1000\.0\)/u.test(sql)) {
      const [runId, nowMs] = values || [];
      for (const run of state.runs.values()) {
        if (run.run_id === runId && run.cancel_requested_at != null && run.cancel_propagated_at == null) {
          run.cancel_propagated_at = new Date(nowMs);
          run.updated_at = new Date(nowMs);
          return { rows: [{ run_id: runId }] };
        }
      }
      return { rows: [] };
    }

    // getRunStatus: FROM review_runs AS runs LEFT JOIN review_dispatch_outbox AS outbox
    if (/FROM review_runs AS runs\s+LEFT JOIN review_dispatch_outbox AS outbox/u.test(sql)) {
      const [runId, executionAttempt] = values || [];
      let foundRun: any = null;
      for (const run of state.runs.values()) {
        if (run.run_id === runId) {
          foundRun = run;
          break;
        }
      }
      if (!foundRun) return { rows: [] };

      const outboxEntry = state.outbox.get(runId);
      const attemptMatches =
        outboxEntry && (outboxEntry.execution_attempt || 0) + 1 === executionAttempt;

      return {
        rows: [
          {
            run_id: foundRun.run_id,
            status: foundRun.status,
            head_sha: foundRun.head_sha,
            owner: foundRun.owner,
            repo: foundRun.repo,
            pr_number: foundRun.pr_number,
            cancel_requested_at: foundRun.cancel_requested_at,
            cancel_reason: foundRun.cancel_reason,
            execution_attempt: attemptMatches ? outboxEntry.execution_attempt : null,
            worker_token_digest: attemptMatches ? outboxEntry.worker_token_digest : null,
            outbox_cancel_requested_at: attemptMatches ? outboxEntry.cancel_requested_at : null,
            outbox_cancel_reason: attemptMatches ? outboxEntry.cancel_reason : null,
          },
        ],
      };
    }

    // getRunStatus: SELECT head_sha FROM review_runs WHERE owner = $1 AND repo = $2 AND pr_number = $3
    if (/SELECT head_sha FROM review_runs\s+WHERE owner = \$1 AND repo = \$2 AND pr_number = \$3/u.test(sql)) {
      const [owner, repo, prNumber] = values || [];
      const matching = Array.from(state.runs.values()).filter(
        (r) => r.owner === owner && r.repo === repo && r.pr_number === prNumber,
      );
      matching.sort((a, b) => {
        const aAdmit = a.admitted_at ? new Date(a.admitted_at).getTime() : 0;
        const bAdmit = b.admitted_at ? new Date(b.admitted_at).getTime() : 0;
        if (bAdmit !== aAdmit) return bAdmit - aAdmit;
        const aCre = a.created_at ? new Date(a.created_at).getTime() : 0;
        const bCre = b.created_at ? new Date(b.created_at).getTime() : 0;
        return bCre - aCre;
      });
      return { rows: matching.slice(0, 1).map((r) => ({ head_sha: r.head_sha })) };
    }

    // Claim next outbox entry
    if (/WITH candidate AS/u.test(sql) && !/cancelled AS/u.test(sql) && /UPDATE review_dispatch_outbox AS outbox/u.test(sql)) {
      const [workerId, nowMs, leaseMs] = values || [];
      const candidates: Array<{ run: any; outbox: any }> = [];
      for (const run of state.runs.values()) {
        if (run.status !== 'queued') continue;
        if (new Date(run.terminal_deadline).getTime() <= nowMs) continue;
        const ob = state.outbox.get(run.run_id);
        if (!ob) continue;
        if (new Date(ob.available_at).getTime() > nowMs) continue;
        if (
          ob.status === 'pending' ||
          (ob.status === 'claimed' && ob.lease_expires_at && new Date(ob.lease_expires_at).getTime() <= nowMs)
        ) {
          candidates.push({ run, outbox: ob });
        }
      }
      candidates.sort((a, b) => {
        const aAvail = new Date(a.outbox.available_at).getTime();
        const bAvail = new Date(b.outbox.available_at).getTime();
        if (aAvail !== bAvail) return aAvail - bAvail;
        return new Date(a.outbox.created_at).getTime() - new Date(b.outbox.created_at).getTime();
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
        rows: [
          {
            run_id: selected.run.run_id,
            delivery_id: selected.outbox.delivery_id,
            repository_id: selected.run.repository_id,
            installation_id: selected.run.installation_id,
            publication_mode: selected.run.publication_mode,
            authoritative_gate_app_id: selected.run.authoritative_gate_app_id ? Number(selected.run.authoritative_gate_app_id) : undefined,
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
            worker_token_digest: selected.outbox.worker_token_digest,
            lease_owner: selected.outbox.lease_owner,
            lease_expires_at: selected.outbox.lease_expires_at,
          },
        ],
      };
    }

    // bindWorkerTokenDigest
    if (/UPDATE review_dispatch_outbox\s+SET worker_token_digest/u.test(sql)) {
      const [runId, workerId, workerTokenDigest, nowMs, claimAttempt] = values || [];
      const ob = state.outbox.get(runId);
      if (
        ob &&
        ob.status === 'claimed' &&
        ob.lease_owner === workerId &&
        ob.attempt === claimAttempt &&
        ob.lease_expires_at &&
        new Date(ob.lease_expires_at).getTime() > nowMs
      ) {
        ob.worker_token_digest = workerTokenDigest;
        ob.updated_at = new Date(nowMs);
        return { rows: [{ run_id: runId }] };
      }
      return { rows: [] };
    }

    // markProjected
    if (/UPDATE review_dispatch_outbox\s+SET status = 'projected'/u.test(sql)) {
      const [runId, workerId, projectionName, nowMs, workerTokenDigest, claimAttempt] =
        values || [];
      const ob = state.outbox.get(runId);
      if (
        ob &&
        ob.status === 'claimed' &&
        ob.lease_owner === workerId &&
        ob.attempt === claimAttempt &&
        ob.lease_expires_at &&
        new Date(ob.lease_expires_at).getTime() > nowMs
      ) {
        ob.status = 'projected';
        ob.projection_name = projectionName;
        ob.lease_owner = null;
        ob.lease_expires_at = null;
        if (workerTokenDigest) ob.worker_token_digest = workerTokenDigest;
        ob.updated_at = new Date(nowMs);
        return { rows: [{ run_id: runId }] };
      }
      return { rows: [] };
    }

    // markTerminal
    if (/UPDATE review_dispatch_outbox\s+SET status = 'terminal'/u.test(sql)) {
      const [runId, workerId, claimAttempt, nowMs] = values || [];
      const ob = state.outbox.get(runId);
      if (ob && ob.status === 'claimed' && ob.lease_owner === workerId && ob.attempt === claimAttempt) {
        ob.status = 'terminal';
        ob.lease_owner = null;
        ob.lease_expires_at = null;
        ob.updated_at = new Date(nowMs);
        return { rows: [{ run_id: runId }] };
      }
      return { rows: [] };
    }

    // releaseForRetry
    if (/UPDATE review_dispatch_outbox\s+SET status = 'pending'/u.test(sql)) {
      const [runId, workerId, claimAttempt, nowMs, availableAt] = values || [];
      const ob = state.outbox.get(runId);
      if (ob && ob.status === 'claimed' && ob.lease_owner === workerId && ob.attempt === claimAttempt) {
        ob.status = 'pending';
        ob.lease_owner = null;
        ob.lease_expires_at = null;
        ob.available_at = new Date(availableAt);
        ob.updated_at = new Date(nowMs);
        return { rows: [{ run_id: runId }] };
      }
      return { rows: [] };
    }

    // terminalizeRunsForClosedPullRequest
    if (/cancelled AS/u.test(sql) || /UPDATE review_runs AS runs\s+SET status = 'cancelled'/u.test(sql)) { 
      const [repositoryId, prNumber, nowMs, cancelReason] = values || [];
      const cancelledList: Array<{ run_id: string; cancel_propagated_at: Date | null }> = [];
      for (const run of state.runs.values()) {
        if (
          run.repository_id === repositoryId &&
          run.pr_number === prNumber &&
          ['queued', 'running', 'publishing'].includes(run.status)
        ) {
          run.status = 'cancelled';
          run.stage = 'complete';
          run.error_text = cancelReason;
          run.cancel_requested_at = new Date(nowMs);
          run.cancel_reason = cancelReason;
          run.lease_owner = null;
          run.lease_expires_at = null;
          run.updated_at = new Date(nowMs);

          const ob = state.outbox.get(run.run_id);
          if (ob) {
            ob.status = 'terminal';
            ob.cancel_requested_at = new Date(nowMs);
            ob.cancel_reason = cancelReason;
            ob.cancel_propagated_at = ob.projection_name == null ? new Date(nowMs) : null;
            ob.lease_owner = null;
            ob.lease_expires_at = null;
            ob.updated_at = new Date(nowMs);
            cancelledList.push({ run_id: run.run_id, cancel_propagated_at: ob.cancel_propagated_at });
          }
        }
      }
      return { rows: cancelledList };
    }

    return { rows: [] };
  });

  const pool = {
    connect: vi.fn(async () => ({ query, release: vi.fn() })),
    query,
  };

  return { state, query, pool };
}

function createSampleAdmissionInput(overrides: Record<string, any> = {}) {
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
    publicationMode: (overrides.publicationMode || 'app-gate') as 'app-gate' | 'disabled',
    centralActionDispatch: false,
    debounce: overrides.debounce,
    identity,
  };
}

describe('Challenger M2-1 Empirical Stress Tests', () => {
  // =========================================================================
  // Category 1: Concurrent superseding while dispatch engine is claiming or projecting runs
  // =========================================================================
  describe('Category 1: Concurrent superseding while dispatch engine is claiming or projecting runs', () => {
    it('race: concurrent superseding during token binding revokes lease and prevents K8s projection', async () => {
      const { state, pool } = createEmpiricalMockDb();
      const repo = new PostgresReviewDispatchRepository(pool);

      // Admit run 1
      const adm1 = await repo.admit(createSampleAdmissionInput({ headSha: HEAD_SHA_1 }));
      expect(adm1.run.status).toBe('queued');
      const run1Id = adm1.run.runId;

      // Mock projector to track whether ensure() was called
      const projector = {
        ensure: vi.fn(async () => undefined),
        patchCancellation: vi.fn(async () => undefined),
      };

      // Create engine
      const engine = new ReviewJobDispatchEngine({
        repository: repo,
        projector: projector as any,
        runSecretProvisioner: {
          provision: async () => { 
            // Concurrently admit a newer commit BEFORE token binding finishes!
            try { await repo.admit(createSampleAdmissionInput({ headSha: HEAD_SHA_2, receivedAt: BASE_NOW + 1000 })); } catch(e) { console.error("PROVISION ADMIT ERROR:", e); throw e; }
            return { workerTokenDigest: 'a'.repeat(64) };
          },
        },
        workerId: 'worker-engine-1',
        workerImage: 'ghcr.io/review-yeti-ai/review-yeti-worker@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        namespace: 'ct-review-test',
        now: () => BASE_NOW + 500,
      });

      // Run engine
      const outcome = await engine.runOnce(); 

      // The outbox row for run 1 was transitioned to 'terminal' by admission of HEAD_SHA_2,
      // so bindWorkerTokenDigest failed to match 'status = claimed', returning lease-lost!
      expect(outcome).toEqual({ status: 'lease-lost', runId: run1Id });

      // Crucial assertion: projector.ensure was NEVER invoked for the superseded run!
      expect(projector.ensure).not.toHaveBeenCalled();

      // State check: run 1 is superseded, run 2 is queued
      const run1 = Array.from(state.runs.values()).find((r) => r.run_id === run1Id);
      expect(run1.status).toBe('superseded');
      expect(run1.cancel_requested_at).not.toBeNull();
    });

    it('race: concurrent superseding between projector.ensure and markProjected triggers lease-lost and neutral worker self-termination', async () => {
      const { state, pool } = createEmpiricalMockDb();
      const repo = new PostgresReviewDispatchRepository(pool);

      // Admit run 1
      const adm1 = await repo.admit(createSampleAdmissionInput({ headSha: HEAD_SHA_1 }));
      const run1Id = adm1.run.runId;

      const token = 'test-token-sec-12345';
      const tokenDigest = sha256Hex(token);

      const projector = {
        ensure: vi.fn(async () => {
          // Concurrently admit head 2 while projector is talking to Kubernetes!
          await repo.admit(
            createSampleAdmissionInput({ headSha: HEAD_SHA_2, receivedAt: BASE_NOW + 2000 }),
          );
        }),
        patchCancellation: vi.fn(async () => undefined),
      };

      const engine = new ReviewJobDispatchEngine({
        repository: repo,
        projector: projector as any,
        runSecretProvisioner: {
          provision: async () => ({ workerTokenDigest: tokenDigest }),
        },
        workerId: 'worker-engine-2',
        workerImage: 'ghcr.io/review-yeti-ai/review-yeti-worker@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        namespace: 'ct-review-test',
        now: () => BASE_NOW + 500,
      });

      const outcome = await engine.runOnce();
      // markProjected returned false because admission set status = 'terminal' and lease_owner = null
      expect(outcome).toEqual({ status: 'lease-lost', runId: run1Id });

      // Worker Pod launches and polls /status:
      const runStatus = await repo.getRunStatus(run1Id, 1);
      expect(runStatus).not.toBeNull();
      expect(runStatus?.cancelRequested).toBe(true);
      expect(runStatus?.isCurrentHead).toBe(false);
      expect(runStatus?.currentHeadSha).toBe(HEAD_SHA_2);

      // WorkerStatusPoller observes this and flags onSuperseded
      const onSuperseded = vi.fn();
      const poller = new WorkerStatusPoller({
        statusUrl: 'https://test/api/status',
        bearerToken: token,
        fetch: async () =>
          ({
            status: 200,
            ok: true,
            json: async () => runStatus,
          }) as any,
        onSuperseded,
      });

      await poller.pollOnce();
      expect(poller.isCurrentHead()).toBe(false);
      expect(onSuperseded).toHaveBeenCalledWith('superseded_by_new_head');
    });

    it('concurrency stress: sequential admissions serialize properly, latest remains active and prior are superseded', async () => {
      const { state, pool } = createEmpiricalMockDb();
      const repo = new PostgresReviewDispatchRepository(pool);

      // Admit 10 heads sequentially (as guarded by PostgreSQL advisory locks)
      for (let idx = 0; idx < 10; idx++) {
        const headSha = (idx + 1).toString().padStart(40, '0');
        await repo.admit(
          createSampleAdmissionInput({
            headSha,
            receivedAt: BASE_NOW + idx * 100,
          }),
        );
      }

      // Inspect runs state
      const allRuns = Array.from(state.runs.values());
      const queuedRuns = allRuns.filter((r) => r.status === 'queued');
      const supersededRuns = allRuns.filter((r) => r.status === 'superseded');

      // Exactly the latest run remains active
      expect(queuedRuns).toHaveLength(1);
      expect(queuedRuns[0].head_sha).toBe('10'.padStart(40, '0'));

      // All 9 prior runs are superseded with cancel_requested_at populated
      expect(supersededRuns).toHaveLength(9);
      for (const run of supersededRuns) {
        expect(run.cancel_requested_at).not.toBeNull();
        expect(run.cancel_reason).toBe('superseded_by_new_head');
      }
    });

    it('unprojected superseded runs are marked propagated immediately at admission', async () => {
      const { state, pool } = createEmpiricalMockDb();
      const repo = new PostgresReviewDispatchRepository(pool);

      // Run 1 admitted (unprojected, projection_name is null)
      const adm1 = await repo.admit(createSampleAdmissionInput({ headSha: HEAD_SHA_1 }));
      const run1Id = adm1.run.runId;

      // Run 2 admitted
      await repo.admit(
        createSampleAdmissionInput({ headSha: HEAD_SHA_2, receivedAt: BASE_NOW + 1000 }),
      );

      const ob1 = state.outbox.get(run1Id);
      expect(ob1.status).toBe('terminal');
      expect(ob1.cancel_requested_at).not.toBeNull();
      // Unprojected row: cancel_propagated_at is marked immediately!
      expect(ob1.cancel_propagated_at).not.toBeNull();

      // Sweeper finds nothing because cancel_propagated_at is already set
      const pending = await repo.findPendingCancellations(10);
      expect(pending).toHaveLength(0);
    });

    it('projected superseded runs leave cancel_propagated_at as NULL to trigger sweep', async () => {
      const { state, pool } = createEmpiricalMockDb();
      const repo = new PostgresReviewDispatchRepository(pool);

      // Admit run 1
      const adm1 = await repo.admit(createSampleAdmissionInput({ headSha: HEAD_SHA_1 }));
      const run1Id = adm1.run.runId;

      // Simulate projection
      const ob1 = state.outbox.get(run1Id);
      ob1.projection_name = 'prj-test-run-1';
      ob1.status = 'projected';

      // Admit run 2
      await repo.admit(
        createSampleAdmissionInput({ headSha: HEAD_SHA_2, receivedAt: BASE_NOW + 1000 }),
      );

      expect(ob1.status).toBe('terminal');
      expect(ob1.cancel_requested_at).not.toBeNull();
      // Because projection_name WAS NOT NULL, cancel_propagated_at remains NULL!
      expect(ob1.cancel_propagated_at).toBeNull();

      // Sweeper finds this pending cancellation!
      const pending = await repo.findPendingCancellations(10);
      expect(pending).toEqual([
        {
          runId: run1Id,
          executionAttempt: 1,
          projectionName: 'prj-test-run-1',
          cancelReason: 'superseded_by_new_head',
        },
      ]);
    });
  });

  // =========================================================================
  // Category 2: Multiple rapid cancel requests for the same run across outbox and review_runs
  // =========================================================================
  describe('Category 2: Multiple rapid cancel requests across outbox and review_runs', () => {
    it('rapid superseding burst: subsequent heads do not overwrite original cancel timestamp or reason', async () => {
      const { state, pool } = createEmpiricalMockDb();
      const repo = new PostgresReviewDispatchRepository(pool);

      // Run 1 admitted and projected at T0
      const adm1 = await repo.admit(createSampleAdmissionInput({ headSha: HEAD_SHA_1, receivedAt: BASE_NOW }));
      const run1Id = adm1.run.runId;
      const ob1 = state.outbox.get(run1Id);
      ob1.projection_name = 'prj-run-1';

      // Rapid head 2 arrives at T0 + 1000
      const t1 = BASE_NOW + 1000;
      await repo.admit(createSampleAdmissionInput({ headSha: HEAD_SHA_2, receivedAt: t1 }));

      const run1 = Array.from(state.runs.values()).find((r) => r.run_id === run1Id);
      expect(run1.cancel_requested_at).toEqual(new Date(t1));

      // Rapid head 3 arrives at T0 + 2000
      const t2 = BASE_NOW + 2000;
      await repo.admit(createSampleAdmissionInput({ headSha: HEAD_SHA_3, receivedAt: t2 }));

      // Run 1 was already superseded, so its cancel_requested_at is preserved at t1!
      expect(run1.cancel_requested_at).toEqual(new Date(t1));
      expect(ob1.cancel_requested_at).toEqual(new Date(t1));
    });

    it('terminalizeRunsForClosedPullRequest idempotency across rapid close events', async () => {
      const { state, pool } = createEmpiricalMockDb();
      const repo = new PostgresReviewDispatchRepository(pool);

      const adm = await repo.admit(createSampleAdmissionInput({ headSha: HEAD_SHA_1 }));
      const runId = adm.run.runId;
      const ob = state.outbox.get(runId);
      ob.projection_name = 'prj-closed-pr';

      const tClose = BASE_NOW + 5000;
      // Close PR once
      const res1 = await repo.cancelRunsForPullRequest({
        repositoryId: 614653796,
        prNumber: adm.run.identity.prNumber,
        now: tClose,
        cancelReason: 'pull request closed before the review completed',
      });
      expect(res1.cancelledRunIds).toHaveLength(1);

      const run = Array.from(state.runs.values()).find((r) => r.run_id === runId);
      expect(run.status).toBe('cancelled');
      expect(run.cancel_reason).toBe('pull request closed before the review completed');
      expect(ob.status).toBe('terminal');
      expect(ob.cancel_propagated_at).toBeNull(); // Needs sweep

      // Immediate second close call (e.g. duplicate webhook)
      const res2 = await repo.terminalizeRunsForClosedPullRequest({
        repositoryId: adm.repositoryId || 614653796,
        owner: 'calltelemetry',
        repo: 'review-yeti-bot',
        prNumber: adm.run.identity.prNumber,
        merged: false,
        now: tClose + 100,
        deliveryId: 'del-close-2',
      });
      // Idempotent: 0 runs modified
      expect(res2.terminalizedRunIds).toHaveLength(0);
      expect(run.status).toBe('cancelled');
    });

    it('concurrent double sweep on the same cancellation: idempotency under duplicate propagation', async () => {
      const { state, pool } = createEmpiricalMockDb();
      const repo = new PostgresReviewDispatchRepository(pool);

      const adm = await repo.admit(createSampleAdmissionInput({ headSha: HEAD_SHA_1 }));
      const runId = adm.run.runId;
      const ob = state.outbox.get(runId);
      ob.projection_name = 'prj-concurrent-sweep';
      ob.cancel_requested_at = new Date(BASE_NOW + 1000);
      ob.cancel_propagated_at = null;

      // First call to markCancelPropagated succeeds
      const firstPropagate = await repo.markCancelPropagated(runId, 1, BASE_NOW + 2000);
      expect(firstPropagate).toBe(true);

      // Second call is fenced and returns false
      const secondPropagate = await repo.markCancelPropagated(runId, 1, BASE_NOW + 2000);
      expect(secondPropagate).toBe(false);

      // Outbox row has cancel_propagated_at set exactly once
      expect(ob.cancel_propagated_at).toEqual(new Date(BASE_NOW + 2000));
    });
  });

  // =========================================================================
  // Category 3: Attempt fencing
  // =========================================================================
  describe('Category 3: Attempt fencing', () => {
    it('markCancelPropagated rejects stale attempt N when outbox is at attempt N+1', async () => {
      const { state, pool } = createEmpiricalMockDb();
      const repo = new PostgresReviewDispatchRepository(pool);

      const adm = await repo.admit(createSampleAdmissionInput({ headSha: HEAD_SHA_1 }));
      const runId = adm.run.runId;
      const ob = state.outbox.get(runId);
      ob.execution_attempt = 1; // 1-based execution attempt is 2!
      ob.cancel_requested_at = new Date(BASE_NOW);
      ob.cancel_propagated_at = null;

      // Stale attempt 1 cancellation arrives
      const propagated = await repo.markCancelPropagated(runId, 1, BASE_NOW + 5000);
      expect(propagated).toBe(false);

      // Outbox row and review_runs remain unpropagated
      expect(ob.cancel_propagated_at).toBeNull();
      const run = Array.from(state.runs.values()).find((r) => r.run_id === runId);
      expect(run.cancel_propagated_at).toBeNull();
    });

    it('markCancelPropagated succeeds when executionAttempt matches exactly', async () => {
      const { state, pool } = createEmpiricalMockDb();
      const repo = new PostgresReviewDispatchRepository(pool);

      const adm = await repo.admit(createSampleAdmissionInput({ headSha: HEAD_SHA_1 }));
      const runId = adm.run.runId;
      const ob = state.outbox.get(runId);
      ob.execution_attempt = 2; // 1-based execution attempt is 3
      ob.cancel_requested_at = new Date(BASE_NOW);
      ob.cancel_propagated_at = null;

      const run = Array.from(state.runs.values()).find((r) => r.run_id === runId);
      run.cancel_requested_at = new Date(BASE_NOW);
      run.cancel_propagated_at = null;

      const propagated = await repo.markCancelPropagated(runId, 3, BASE_NOW + 5000);
      expect(propagated).toBe(true);

      expect(ob.cancel_propagated_at).toEqual(new Date(BASE_NOW + 5000));
      expect(run.cancel_propagated_at).toEqual(new Date(BASE_NOW + 5000));

      // Duplicate call for attempt 3 returns false (already propagated)
      const duplicate = await repo.markCancelPropagated(runId, 3, BASE_NOW + 6000);
      expect(duplicate).toBe(false);
    });

    it('findPendingCancellations preserves 1-based executionAttempt contract for sweeper', async () => {
      const { state, pool } = createEmpiricalMockDb();
      const repo = new PostgresReviewDispatchRepository(pool);

      const adm = await repo.admit(createSampleAdmissionInput({ headSha: HEAD_SHA_1 }));
      const runId = adm.run.runId;
      const ob = state.outbox.get(runId);
      ob.execution_attempt = 3; // In DB stored as 3 (0-indexed)
      ob.projection_name = 'prj-attempt-test';
      ob.cancel_requested_at = new Date(BASE_NOW);
      ob.cancel_propagated_at = null;

      const pending = await repo.findPendingCancellations(10);
      expect(pending).toHaveLength(1);
      // Must be exposed as 4 (1-based)
      expect(pending[0].executionAttempt).toBe(4);
    });
  });

  // =========================================================================
  // Category 4: Sweep fallback
  // =========================================================================
  describe('Category 4: Sweep fallback', () => {
    it('sweep handles Kubernetes 404 cleanly and marks outbox propagated', async () => {
      const { state, pool } = createEmpiricalMockDb();
      const repo = new PostgresReviewDispatchRepository(pool);

      const adm = await repo.admit(createSampleAdmissionInput({ headSha: HEAD_SHA_1 }));
      const runId = adm.run.runId;
      const ob = state.outbox.get(runId);
      ob.projection_name = 'prj-deleted-cr';
      ob.cancel_requested_at = new Date(BASE_NOW);
      ob.cancel_propagated_at = null;

      // Kubernetes client throws 404
      const mockK8sClient = {
        patchNamespacedCustomObject: vi.fn(async () => {
          const err: any = new Error('not found');
          err.statusCode = 404;
          throw err;
        }),
      };
      const projector = new KubernetesReviewJobProjector(mockK8sClient as any);

      const engine = new ReviewJobDispatchEngine({
        repository: repo,
        projector,
        workerId: 'worker-1',
        workerImage: 'ghcr.io/review-yeti-ai/review-yeti-worker@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        namespace: 'ct-test',
        now: () => BASE_NOW + 10_000,
      });

      const outcome = await engine.sweepPendingCancellations(10);
      expect(outcome).toEqual({ propagated: 1, failed: 0 });

      // Outbox was marked propagated
      expect(ob.cancel_propagated_at).toEqual(new Date(BASE_NOW + 10_000));
    });

    it('sweep recovers from transient Kubernetes 500 error and retries on subsequent sweep', async () => {
      const { state, pool } = createEmpiricalMockDb();
      const repo = new PostgresReviewDispatchRepository(pool);

      const adm = await repo.admit(createSampleAdmissionInput({ headSha: HEAD_SHA_1 }));
      const runId = adm.run.runId;
      const ob = state.outbox.get(runId);
      ob.projection_name = 'prj-flaky-cr';
      ob.cancel_requested_at = new Date(BASE_NOW);
      ob.cancel_propagated_at = null;

      let succeed = false;
      const mockK8sClient = {
        patchNamespacedCustomObject: vi.fn(async () => {
          if (!succeed) {
            const err: any = new Error('Kubernetes API temporary outage');
            err.statusCode = 500;
            throw err;
          }
          return {};
        }),
      };
      const projector = new KubernetesReviewJobProjector(mockK8sClient as any);

      const engine = new ReviewJobDispatchEngine({
        repository: repo,
        projector,
        workerId: 'worker-1',
        workerImage: 'ghcr.io/review-yeti-ai/review-yeti-worker@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        namespace: 'ct-test',
        now: () => BASE_NOW + 10_000,
      });

      // First sweep fails
      const sweep1 = await engine.sweepPendingCancellations(10);
      expect(sweep1).toEqual({ propagated: 0, failed: 1 });
      expect(ob.cancel_propagated_at).toBeNull(); // Still unpropagated!

      // K8s recovers
      succeed = true;

      // Second sweep succeeds
      const sweep2 = await engine.sweepPendingCancellations(10);
      expect(sweep2).toEqual({ propagated: 1, failed: 0 });
      expect(ob.cancel_propagated_at).toEqual(new Date(BASE_NOW + 10_000));
    });

    it('sweep respects batch limit pagination', async () => {
      const { state, pool } = createEmpiricalMockDb();
      const repo = new PostgresReviewDispatchRepository(pool);

      // Create 5 unpropagated cancelled rows
      for (let i = 1; i <= 5; i++) {
        const runId = `run_batch_${i}`;
        state.outbox.set(runId, {
          run_id: runId,
          execution_attempt: 0,
          projection_name: `prj-batch-${i}`,
          cancel_requested_at: new Date(BASE_NOW + i * 100),
          cancel_propagated_at: null,
          cancel_reason: 'superseded_by_new_head',
        });
      }

      const projector = {
        ensure: vi.fn(),
        patchCancellation: vi.fn(async () => undefined),
      };

      const engine = new ReviewJobDispatchEngine({
        repository: repo,
        projector: projector as any,
        workerId: 'worker-1',
        workerImage: 'ghcr.io/review-yeti-ai/review-yeti-worker@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        namespace: 'ct-test',
        now: () => BASE_NOW + 50_000,
      });

      // Sweep with limit = 2
      const s1 = await engine.sweepPendingCancellations(2);
      expect(s1).toEqual({ propagated: 2, failed: 0 });

      // Next batch of 2
      const s2 = await engine.sweepPendingCancellations(2);
      expect(s2).toEqual({ propagated: 2, failed: 0 });

      // Final 1
      const s3 = await engine.sweepPendingCancellations(2);
      expect(s3).toEqual({ propagated: 1, failed: 0 });

      // Empty
      const s4 = await engine.sweepPendingCancellations(2);
      expect(s4).toEqual({ propagated: 0, failed: 0 });
    });
  });

  // =========================================================================
  // Category 5: Action Dispatch API security
  // =========================================================================
  describe('Category 5: Action Dispatch API security', () => {
    const validToken = 'secret-worker-token-test-12345';
    const validDigest = sha256Hex(validToken);

    function buildTestApp(options: {
      statusResult?: RunStatusResult | null;
      hasRepo?: boolean;
      customRepo?: any;
    } = {}) {
      const app = express();
      app.use(express.json());

      const mockRepo = options.customRepo || {
        getRunStatus: vi.fn(async (runId: string, attempt: number) => {
          if (options.statusResult !== undefined) return options.statusResult;
          return {
            current: true,
            status: 'running',
            cancelRequested: false,
            cancelReason: undefined,
            currentHeadSha: 'headsha_live',
            isCurrentHead: true,
            workerTokenDigest: validDigest,
          };
        }),
      };

      const router = createActionDispatchRouter({
        verifier: { verify: vi.fn() } as any,
        admission: { admit: vi.fn() } as any,
        resolveInstallationId: vi.fn(),
        runStatusRepository: options.hasRepo === false ? undefined : mockRepo,
      });

      app.use('/api/dispatch', router);
      return { app, mockRepo };
    }

    it('rejects missing or malformed Authorization headers with 401', async () => {
      const { app } = buildTestApp();

      // Missing
      const r1 = await request(app).get('/api/dispatch/runs/run_1/attempts/1/status');
      expect(r1.status).toBe(401);
      expect(r1.body.error).toContain('Bearer token is required');

      // Basic auth
      const r2 = await request(app)
        .get('/api/dispatch/runs/run_1/attempts/1/status')
        .set('Authorization', 'Basic dXNlcjpwYXNz');
      expect(r2.status).toBe(401);

      // Bearer with no token
      const r3 = await request(app)
        .get('/api/dispatch/runs/run_1/attempts/1/status')
        .set('Authorization', 'Bearer');
      expect(r3.status).toBe(401);

      // Bearer with spaces only
      const r4 = await request(app)
        .get('/api/dispatch/runs/run_1/attempts/1/status')
        .set('Authorization', 'Bearer    ');
      expect(r4.status).toBe(401);

      // Bearer with multiple space-separated words
      const r5 = await request(app)
        .get('/api/dispatch/runs/run_1/attempts/1/status')
        .set('Authorization', 'Bearer tok1 tok2');
      expect(r5.status).toBe(401);
    });

    it('rejects invalid or mismatched token with 401 Unauthorized', async () => {
      const { app } = buildTestApp();

      const res = await request(app)
        .get('/api/dispatch/runs/run_1/attempts/1/status')
        .set('Authorization', 'Bearer wrong-secret-token');

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
    });

    it('constant-time digest verification resists timing attacks and accepts matching digests', async () => {
      const { app } = buildTestApp();

      // Exact match returns 200
      const res = await request(app)
        .get('/api/dispatch/runs/run_1/attempts/1/status')
        .set('Authorization', `Bearer ${validToken}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('running');

      // Verify that inputs of arbitrary length are safely processed via SHA256 constant-time comparison
      const shortTokenRes = await request(app)
        .get('/api/dispatch/runs/run_1/attempts/1/status')
        .set('Authorization', 'Bearer x');
      expect(shortTokenRes.status).toBe(401);

      const longTokenRes = await request(app)
        .get('/api/dispatch/runs/run_1/attempts/1/status')
        .set('Authorization', `Bearer ${'y'.repeat(1024)}`);
      expect(longTokenRes.status).toBe(401);
    });

    it('safely handles non-hex or corrupted database digests without crashing or throwing RangeError', async () => {
      const { app } = buildTestApp({
        statusResult: {
          current: true,
          status: 'running',
          cancelRequested: false,
          currentHeadSha: 'head',
          isCurrentHead: true,
          workerTokenDigest: 'corrupted-short-digest',
        },
      });

      const res = await request(app)
        .get('/api/dispatch/runs/run_1/attempts/1/status')
        .set('Authorization', `Bearer ${validToken}`);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
    });

    it('rejects invalid runId or attempt parameters with 400', async () => {
      const { app } = buildTestApp();

      // Whitespace runId
      const r1 = await request(app)
        .get('/api/dispatch/runs/%20%20/attempts/1/status')
        .set('Authorization', `Bearer ${validToken}`);
      expect(r1.status).toBe(400);

      // Attempt 0
      const r2 = await request(app)
        .get('/api/dispatch/runs/run_1/attempts/0/status')
        .set('Authorization', `Bearer ${validToken}`);
      expect(r2.status).toBe(400);

      // Attempt negative
      const r3 = await request(app)
        .get('/api/dispatch/runs/run_1/attempts/-5/status')
        .set('Authorization', `Bearer ${validToken}`);
      expect(r3.status).toBe(400);

      // Attempt non-numeric
      const r4 = await request(app)
        .get('/api/dispatch/runs/run_1/attempts/abc/status')
        .set('Authorization', `Bearer ${validToken}`);
      expect(r4.status).toBe(400);

      // Attempt float
      const r5 = await request(app)
        .get('/api/dispatch/runs/run_1/attempts/1.5/status')
        .set('Authorization', `Bearer ${validToken}`);
      expect(r5.status).toBe(400);

      // Query param alias with attempt = NaN
      const r6 = await request(app)
        .get('/api/dispatch/status?runId=run_1&attempt=NaN')
        .set('Authorization', `Bearer ${validToken}`);
      expect(r6.status).toBe(400);
    });

    it('returns 404 when run is not found', async () => {
      const { app } = buildTestApp({ statusResult: null });

      const res = await request(app)
        .get('/api/dispatch/runs/nonexistent/attempts/1/status')
        .set('Authorization', `Bearer ${validToken}`);

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Run not found');
    });

    it('attempt fencing across attempts: attempt 1 token cannot read attempt 2 status', async () => {
      const tok1 = 'token-attempt-1';
      const tok2 = 'token-attempt-2';
      const digest2 = sha256Hex(tok2);

      const customRepo = {
        getRunStatus: vi.fn(async (runId: string, attempt: number) => {
          if (attempt === 1) {
            // Outbox has moved to attempt 2, so attempt 1 query yields null workerTokenDigest
            return {
              current: false,
              status: 'running',
              cancelRequested: false,
              currentHeadSha: 'head',
              isCurrentHead: true,
              workerTokenDigest: undefined,
            };
          }
          if (attempt === 2) {
            return {
              current: true,
              status: 'running',
              cancelRequested: false,
              currentHeadSha: 'head',
              isCurrentHead: true,
              workerTokenDigest: digest2,
            };
          }
          return null;
        }),
      };

      const { app } = buildTestApp({ customRepo });

      // Attempt 1 token checking attempt 1 status -> 401
      const r1 = await request(app)
        .get('/api/dispatch/runs/run_multi/attempts/1/status')
        .set('Authorization', `Bearer ${tok1}`);
      expect(r1.status).toBe(401);

      // Attempt 1 token checking attempt 2 status -> 401
      const r2 = await request(app)
        .get('/api/dispatch/runs/run_multi/attempts/2/status')
        .set('Authorization', `Bearer ${tok1}`);
      expect(r2.status).toBe(401);

      // Attempt 2 token checking attempt 2 status -> 200
      const r3 = await request(app)
        .get('/api/dispatch/runs/run_multi/attempts/2/status')
        .set('Authorization', `Bearer ${tok2}`);
      expect(r3.status).toBe(200);
      expect(r3.body.current).toBe(true);
    });

    it('successful response never leaks workerTokenDigest or hashes', async () => {
      const { app } = buildTestApp();

      const res = await request(app)
        .get('/api/dispatch/runs/run_1/attempts/1/status')
        .set('Authorization', `Bearer ${validToken}`);

      expect(res.status).toBe(200);
      expect(res.body.workerTokenDigest).toBeUndefined();
      expect(res.body.tokenDigest).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain(validDigest);
    });

    it('SQL injection attempt in runId is safely neutralized', async () => {
      const { app, mockRepo } = buildTestApp({ statusResult: null });

      const res = await request(app)
        .get("/api/dispatch/runs/'%20OR%201=1%20--/attempts/1/status")
        .set('Authorization', `Bearer ${validToken}`);

      expect(mockRepo.getRunStatus).toHaveBeenCalledWith("' OR 1=1 --", 1);
      expect(res.status).toBe(404);
    });

    it('WorkerStatusPoller fails soft on 401/500/network errors without flipping isCurrentHead', async () => {
      const onSuperseded = vi.fn();

      // 401 response
      const poller401 = new WorkerStatusPoller({
        statusUrl: 'https://test/api/status',
        bearerToken: 'tok',
        fetch: async () => ({ status: 401, ok: false }) as any,
        onSuperseded,
      });
      await poller401.pollOnce();
      expect(poller401.isCurrentHead()).toBe(true);
      expect(onSuperseded).not.toHaveBeenCalled();

      // 500 response
      const poller500 = new WorkerStatusPoller({
        statusUrl: 'https://test/api/status',
        bearerToken: 'tok',
        fetch: async () => ({ status: 500, ok: false }) as any,
        onSuperseded,
      });
      await poller500.pollOnce();
      expect(poller500.isCurrentHead()).toBe(true);
      expect(onSuperseded).not.toHaveBeenCalled();

      // Network exception
      const pollerNet = new WorkerStatusPoller({
        statusUrl: 'https://test/api/status',
        bearerToken: 'tok',
        fetch: async () => {
          throw new Error('ETIMEDOUT');
        },
        onSuperseded,
      });
      await pollerNet.pollOnce();
      expect(pollerNet.isCurrentHead()).toBe(true);
      expect(onSuperseded).not.toHaveBeenCalled();
    });
  });
});
