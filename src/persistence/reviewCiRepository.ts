import { randomUUID } from 'node:crypto';
import { sha256 } from '../review/reviewCore';
import {
  normalizeReviewCiBinding, reviewCiCoordinatesSchema, reviewCiExecutionSchema, reviewCiAbsentReconciliationSchema,
  reviewCiIdentityDigest, reviewCiTerminalReceiptSchema,
  type ReviewCiAbsentReconciliation, type ReviewCiCoordinates, type ReviewCiDeliveryClaim,
  type ReviewCiDeliveryKind, type ReviewCiExecution, type ReviewCiRepository, type ReviewCiQueryable,
  type ReviewCiStateTransition, type ReviewCiTransition, type ReviewCiValidationBinding,
  type StoredReviewCiRequest,
} from '../review/reviewCi';

export type { ReviewCiQueryable, ReviewCiStateTransition, ReviewCiTransition } from '../review/reviewCi';
interface Client extends ReviewCiQueryable { release(): void }
interface Pool extends ReviewCiQueryable { connect(): Promise<Client> }
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const ATTEMPT = /^run_[a-f0-9]{32}-g\d+-e[1-9]\d*$/u;
const TERMINAL = new Set(['completed', 'superseded', 'delivery_error']);
export interface ReviewCiRepositoryOptions {
  maxDispatchAttempts?: number;
  /** Bounds external fresh reads, not transaction hooks; default 5s, maximum 15s. */
  admissionTimeoutMs?: number;
  /** Same-transaction persistence only. Receives the post-transition request.
   * Await all SQL on this client; never BEGIN/COMMIT, publish, or perform network I/O. */
  onTransition?: (client: ReviewCiQueryable, request: StoredReviewCiRequest, transition: ReviewCiStateTransition, now: number) => Promise<void>;
  /** Same-transaction predicate for the exact bound, published nonterminal CI
   * check. Required before a new workflow POST claim and first execution.
   * Missing/rejected proof defers pending delivery; it never grants POST authority. */
  assertPendingPublished?: (client: ReviewCiQueryable, request: StoredReviewCiRequest, now: number) => Promise<void>;
}

function clock(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000) throw new Error('Invalid Review CI clock');
}
function id(value: string): void {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('Invalid Review CI request identity');
}
function fromRow(row: any): StoredReviewCiRequest {
  const review = reviewCiCoordinatesSchema.parse(row.review);
  const binding = row.binding === null ? null : normalizeReviewCiBinding(row.binding);
  const result: StoredReviewCiRequest = {
    requestId: row.request_id, review, expectedAppId: Number(row.expected_app_id), state: row.state,
    binding, identityDigest: row.identity_digest, workflowEpoch: Number(row.workflow_epoch),
    execution: row.execution === null ? null : reviewCiExecutionSchema.parse(row.execution),
    terminalReceipt: row.terminal_receipt === null ? null : reviewCiTerminalReceiptSchema.parse(row.terminal_receipt),
  };
  id(result.requestId);
  if (!Number.isSafeInteger(result.expectedAppId) || result.expectedAppId <= 0
    || row.attempt_id !== review.attemptId || Number(row.repository_id) !== review.repositoryId
    || Number(row.pr_number) !== review.prNumber
    || (binding && result.identityDigest !== reviewCiIdentityDigest({ ...result, binding }))
    || (result.terminalReceipt && row.terminal_digest !== sha256(result.terminalReceipt))) {
    throw new Error('Invalid stored Review CI identity');
  }
  return result;
}
async function prLock(client: ReviewCiQueryable, repositoryId: number, prNumber: number): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`review-dispatch:${repositoryId}:${prNumber}`]);
}

async function eligibleGate(client: ReviewCiQueryable, attempt: string, published: boolean): Promise<{
  review: ReviewCiCoordinates; expectedAppId: number;
} | null> {
  const row = (await client.query(`SELECT gate.*, runs.status AS run_status, runs.attempt AS current_generation,
      runs.repository_id AS run_repository_id, runs.owner AS run_owner, runs.repo AS run_repo,
      runs.pr_number AS run_pr_number, runs.head_sha AS run_head_sha, runs.base_sha AS run_base_sha,
      runs.effective_policy_digest AS run_policy_digest, runs.authoritative_gate_app_id,
      outbox.execution_attempt AS current_execution, outbox.status AS outbox_status
    FROM review_gate_attempts gate JOIN review_runs runs USING(run_id)
    JOIN review_dispatch_outbox outbox USING(run_id)
    WHERE gate.attempt_id = $1 FOR UPDATE OF gate, runs, outbox`, [attempt])).rows[0];
  if (!row || !row.current_attempt || row.run_status !== 'succeeded' || row.outbox_status !== 'projected'
    || row.desired_state !== 'success' || row.decision?.status !== 'success' || row.decision?.eligible !== true
    || row.creation_state !== 'bound' || row.check_id === null
    || Number(row.authoritative_gate_app_id) !== Number(row.expected_app_id)
    || Number(row.review_generation) !== Number(row.current_generation)
    || Number(row.execution_attempt) !== Number(row.current_execution) + 1
    || (published && Number(row.published_version) !== Number(row.desired_version))) return null;
  const review = reviewCiCoordinatesSchema.parse({ ...row.coordinates, reviewGeneration: Number(row.review_generation) });
  if (review.attemptId !== row.attempt_id || review.runId !== row.run_id
    || review.executionAttempt !== Number(row.execution_attempt)
    || review.repositoryId !== Number(row.repository_id) || review.prNumber !== Number(row.pr_number)
    || review.repositoryId !== Number(row.run_repository_id) || review.prNumber !== Number(row.run_pr_number)
    || review.owner !== row.run_owner || review.repo !== row.run_repo
    || review.headSha !== row.run_head_sha || review.baseSha !== row.run_base_sha
    || review.policyDigest !== row.run_policy_digest) throw new Error('Review CI gate identity conflict');
  return { review, expectedAppId: Number(row.expected_app_id) };
}

/** Call ONLY in the caller's terminal-review transaction, after its eligible
 * gate/run/outbox updates and under the shared PR lock. Does not BEGIN/COMMIT or
 * enable anything. Reads authoritative persisted fields, never a worker payload.
 * The advisory lock is reentrant when the parent already owns it. */
export async function enqueueReviewCiCompletionInTransaction(
  client: ReviewCiQueryable, attemptId: string, now = Date.now(),
): Promise<StoredReviewCiRequest | null> {
  clock(now);
  if (!ATTEMPT.test(attemptId)) throw new Error('Invalid Review CI gate attempt');
  try {
    const identity = (await client.query('SELECT repository_id, pr_number FROM review_gate_attempts WHERE attempt_id = $1', [attemptId])).rows[0];
    if (!identity) return null;
    await prLock(client, Number(identity.repository_id), Number(identity.pr_number));
    const gate = await eligibleGate(client, attemptId, false);
    if (!gate) return null;
    await client.query(`INSERT INTO review_ci_requests(request_id,attempt_id,repository_id,pr_number,expected_app_id,review,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,to_timestamp($7/1000.0),to_timestamp($7/1000.0)) ON CONFLICT(attempt_id) DO NOTHING`,
    [randomUUID(), attemptId, gate.review.repositoryId, gate.review.prNumber, gate.expectedAppId, JSON.stringify(gate.review), now]);
    const request = fromRow((await client.query('SELECT * FROM review_ci_requests WHERE attempt_id=$1 FOR UPDATE', [attemptId])).rows[0]);
    if (sha256(request.review) !== sha256(gate.review) || request.expectedAppId !== gate.expectedAppId) {
      throw new Error('Review CI completion identity conflict');
    }
    await client.query(`INSERT INTO review_ci_deliveries(request_id,kind,epoch,available_at,created_at,updated_at)
      VALUES($1,'repository',0,to_timestamp($2/1000.0),to_timestamp($2/1000.0),to_timestamp($2/1000.0))
      ON CONFLICT DO NOTHING`, [request.requestId, now]);
    return request;
  } catch { throw new Error('Review CI completion intent could not be saved'); }
}

/** Persistence, not authentication or GitHub transport. Callback/execution/
 * receipt inputs must come from the trusted service after provenance checks.
 * Merely constructing this repository performs no I/O and activates no work. */
export class PostgresReviewCiRepository implements ReviewCiRepository {
  private readonly maxDispatchAttempts: number;
  private readonly admissionTimeoutMs: number;
  constructor(private readonly pool: Pool, private readonly options: ReviewCiRepositoryOptions = {}) {
    this.maxDispatchAttempts = options.maxDispatchAttempts ?? 5;
    this.admissionTimeoutMs = options.admissionTimeoutMs ?? 5_000;
    if (!Number.isInteger(this.maxDispatchAttempts) || this.maxDispatchAttempts < 1 || this.maxDispatchAttempts > 10
      || !Number.isInteger(this.admissionTimeoutMs) || this.admissionTimeoutMs < 50 || this.admissionTimeoutMs > 15_000) {
      throw new Error('Invalid Review CI repository bounds');
    }
    if ((options.onTransition !== undefined && typeof options.onTransition !== 'function')
      || (options.assertPendingPublished !== undefined && typeof options.assertPendingPublished !== 'function')) {
      throw new Error('Invalid Review CI transaction hooks');
    }
  }
  private async transaction<T>(operation: (client: Client) => Promise<T>): Promise<T> {
    let client: Client | undefined;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '5s'");
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch {
      if (client) await client.query('ROLLBACK').catch(() => undefined);
      throw new Error('Review CI persistence operation failed');
    } finally { client?.release(); }
  }
  private async locked(client: Client, requestId: string): Promise<StoredReviewCiRequest | null> {
    const binding = (await client.query('SELECT repository_id,pr_number FROM review_ci_requests WHERE request_id=$1', [requestId])).rows[0];
    if (!binding) return null;
    await prLock(client, Number(binding.repository_id), Number(binding.pr_number));
    const row = (await client.query('SELECT * FROM review_ci_requests WHERE request_id=$1 FOR UPDATE', [requestId])).rows[0];
    return row ? fromRow(row) : null;
  }
  private async notifyTransition(client: Client, requestId: string, transition: ReviewCiStateTransition, now: number): Promise<void> {
    if (!this.options.onTransition) return;
    const request = fromRow((await client.query('SELECT * FROM review_ci_requests WHERE request_id=$1', [requestId])).rows[0]);
    await this.options.onTransition(client, request, transition, now);
  }
  async get(requestId: string): Promise<StoredReviewCiRequest | null> {
    id(requestId);
    return this.transaction(async (client) => {
      const row = (await client.query('SELECT * FROM review_ci_requests WHERE request_id=$1', [requestId])).rows[0];
      return row ? fromRow(row) : null;
    });
  }
  /** Service advances the last requestId cursor and wraps after an empty page.
   * Read-only keyset pagination prevents idle drafts from starving later work. */
  async listPending(limit = 25, afterRequestId?: string): Promise<StoredReviewCiRequest[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid Review CI read bound');
    if (afterRequestId !== undefined) id(afterRequestId);
    return this.transaction(async (client) => (await client.query(`SELECT * FROM review_ci_requests
      WHERE state IN ('pending','admitted','running') AND ($2::uuid IS NULL OR request_id > $2)
      ORDER BY request_id LIMIT $1`, [limit, afterRequestId ?? null])).rows.map(fromRow));
  }
  private async validateFresh(request: StoredReviewCiRequest, validate: (request: StoredReviewCiRequest) => Promise<void>): Promise<void> {
    if (typeof validate !== 'function') throw new Error('Review CI freshness validator is required');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([validate(structuredClone(request)), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Review CI freshness validation timed out')), this.admissionTimeoutMs);
      })]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }
  async admit(requestId: string, input: unknown,
    validateCurrent: (request: StoredReviewCiRequest, binding: ReviewCiValidationBinding) => Promise<void>,
    now = Date.now(),
  ): Promise<ReviewCiTransition | 'busy'> {
    id(requestId); clock(now);
    const binding = normalizeReviewCiBinding(input);
    if (typeof validateCurrent !== 'function') throw new Error('Review CI freshness validator is required');
    return this.transaction(async (client) => {
      const request = await this.locked(client, requestId);
      if (!request) return 'stale';
      if (request.binding) {
        if (sha256(request.binding) !== sha256(binding)) return 'conflict';
        return ['admitted', 'running', 'completed'].includes(request.state) ? 'duplicate' : 'stale';
      }
      if (request.state !== 'pending') return 'stale';
      // First-hop dispatch must have a committed POST intent. A receiver may
      // arrive before the sender's ACK, so dispatching/uncertain are valid;
      // an untouched pending outbox row cannot admit via a service sweep alone.
      const firstHop = (await client.query(`SELECT state FROM review_ci_deliveries
        WHERE request_id=$1 AND kind='repository' AND epoch=0 FOR UPDATE`, [requestId])).rows[0];
      if (!firstHop || !['dispatching', 'uncertain', 'dispatched'].includes(firstHop.state)) return 'stale';
      const gate = await eligibleGate(client, request.review.attemptId, true);
      if (!gate || gate.expectedAppId !== request.expectedAppId || sha256(gate.review) !== sha256(request.review)) return 'stale';
      if ((await client.query(`SELECT request_id FROM review_ci_requests WHERE repository_id=$1 AND pr_number=$2
        AND state IN ('admitted','running')`, [request.review.repositoryId, request.review.prNumber])).rows.length) return 'busy';
      await this.validateFresh(request, (fresh) => validateCurrent(fresh, structuredClone(binding)));
      const identityDigest = reviewCiIdentityDigest({ ...request, binding });
      await client.query(`UPDATE review_ci_requests SET state='admitted',binding=$2,identity_digest=$3,workflow_epoch=1,
        updated_at=to_timestamp($4/1000.0) WHERE request_id=$1`, [requestId, JSON.stringify(binding), identityDigest, now]);
      await client.query(`UPDATE review_ci_deliveries SET state='dispatched',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
        updated_at=to_timestamp($2/1000.0) WHERE request_id=$1 AND kind='repository'`, [requestId, now]);
      await client.query(`INSERT INTO review_ci_deliveries(request_id,kind,epoch,available_at,created_at,updated_at)
        VALUES($1,'workflow',1,to_timestamp($2/1000.0),to_timestamp($2/1000.0),to_timestamp($2/1000.0))`, [requestId, now]);
      await this.notifyTransition(client, requestId, 'admitted', now);
      return 'recorded';
    });
  }
  async supersede(requestId: string, now = Date.now()): Promise<ReviewCiTransition> {
    id(requestId); clock(now);
    return this.transaction(async (client) => {
      const request = await this.locked(client, requestId);
      if (!request || TERMINAL.has(request.state)) return 'stale';
      await client.query(`UPDATE review_ci_requests SET state='superseded',updated_at=to_timestamp($2/1000.0) WHERE request_id=$1`, [requestId, now]);
      await client.query(`UPDATE review_ci_deliveries SET state='fenced',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
        updated_at=to_timestamp($2/1000.0) WHERE request_id=$1 AND state <> 'completed'`, [requestId, now]);
      await this.notifyTransition(client, requestId, 'superseded', now);
      return 'recorded';
    });
  }
  async claimDelivery(kind: ReviewCiDeliveryKind, workerId: string, now = Date.now(), leaseMs = 30_000): Promise<ReviewCiDeliveryClaim | null> {
    clock(now);
    if (!['repository', 'workflow'].includes(kind) || !/^[A-Za-z0-9_.:-]{1,100}$/u.test(workerId)
      || !Number.isInteger(leaseMs) || leaseMs < 100 || leaseMs > 300_000) throw new Error('Invalid Review CI delivery lease');
    return this.transaction(async (client) => {
      // Acquire PR/request before delivery locks in every path, including competing replicas.
      const candidates = (await client.query(`SELECT d.request_id,d.epoch FROM review_ci_deliveries d JOIN review_ci_requests r USING(request_id)
        WHERE d.kind=$1 AND d.state IN ('pending','dispatching','uncertain','dispatched')
        AND d.available_at <= to_timestamp($2/1000.0) AND (d.lease_expires_at IS NULL OR d.lease_expires_at <= to_timestamp($2/1000.0))
        AND (($1='repository' AND r.state='pending' AND d.state <> 'dispatched')
          OR ($1='workflow' AND r.state='admitted' AND d.epoch=r.workflow_epoch))
        ORDER BY d.available_at,d.request_id LIMIT 25`, [kind, now])).rows;
      for (const candidate of candidates) {
        const request = await this.locked(client, candidate.request_id);
        if (!request || request.state !== (kind === 'repository' ? 'pending' : 'admitted')) continue;
        const row = (await client.query(`SELECT * FROM review_ci_deliveries WHERE request_id=$1 AND kind=$2 AND epoch=$3 FOR UPDATE`,
          [request.requestId, kind, candidate.epoch])).rows[0];
        if (!row || !['pending', 'dispatching', 'uncertain', 'dispatched'].includes(row.state)
          || (kind === 'repository' && row.state === 'dispatched')
          || (kind === 'workflow' && Number(row.epoch) !== request.workflowEpoch)
          || new Date(row.available_at).getTime() > now
          || (row.lease_expires_at !== null && new Date(row.lease_expires_at).getTime() > now)) continue;
        const mode = row.state === 'pending' ? 'dispatch' : 'reconcile';
        if (kind === 'workflow' && mode === 'dispatch') {
          // Only a published pending CI check may precede an expensive workflow.
          // Keep earlier uncertain POSTs reconcileable even if publication is
          // temporarily unavailable. Isolate predicate SQL failures/writes so
          // one unready candidate cannot abort the sweep or consume POST intent.
          await client.query('SAVEPOINT review_ci_pending_publication');
          let published = false;
          try {
            if (this.options.assertPendingPublished) {
              await this.options.assertPendingPublished(client, structuredClone(request), now);
              published = true;
            }
          } catch {
            await client.query('ROLLBACK TO SAVEPOINT review_ci_pending_publication');
          }
          await client.query('RELEASE SAVEPOINT review_ci_pending_publication');
          if (!published) {
            // Deferring only availability rotates this row behind other due
            // candidates without a lease, dispatch count, or uncertain state.
            await client.query(`UPDATE review_ci_deliveries SET available_at=to_timestamp(($3::double precision+1000)/1000.0)
              WHERE request_id=$1 AND kind='workflow' AND epoch=$2`, [request.requestId, candidate.epoch, now]);
            continue;
          }
        }
        const token = randomUUID();
        await client.query(`UPDATE review_ci_deliveries SET state=CASE WHEN state='pending' THEN 'dispatching'
            WHEN state='dispatching' THEN 'uncertain' ELSE state END,
          dispatch_count=dispatch_count+$4,dispatch_started_at=CASE WHEN $4=1 THEN to_timestamp($5/1000.0) ELSE dispatch_started_at END,
          lease_owner=$6,lease_token=$7,lease_expires_at=to_timestamp(($5+$8)/1000.0),updated_at=to_timestamp($5/1000.0)
          WHERE request_id=$1 AND kind=$2 AND epoch=$3`,
        [request.requestId, kind, candidate.epoch, mode === 'dispatch' ? 1 : 0, now, workerId, token, leaseMs]);
        return { request, kind, epoch: Number(candidate.epoch), leaseOwner: workerId, leaseToken: token, mode };
      }
      return null;
    });
  }
  private async ownedDelivery(client: Client, claim: ReviewCiDeliveryClaim, now: number): Promise<{ request: StoredReviewCiRequest; row: any } | null> {
    id(claim.request.requestId); clock(now);
    const request = await this.locked(client, claim.request.requestId);
    if (!request || request.state !== (claim.kind === 'repository' ? 'pending' : 'admitted')
      || (claim.kind === 'workflow' && request.workflowEpoch !== claim.epoch)) return null;
    const row = (await client.query(`SELECT * FROM review_ci_deliveries WHERE request_id=$1 AND kind=$2 AND epoch=$3 FOR UPDATE`,
      [request.requestId, claim.kind, claim.epoch])).rows[0];
    if (!row || !['dispatching', 'uncertain', 'dispatched'].includes(row.state)
      || row.lease_owner !== claim.leaseOwner || row.lease_token !== claim.leaseToken
      || row.lease_expires_at === null || new Date(row.lease_expires_at).getTime() <= now) return null;
    return { request, row };
  }
  async markDeliveryUncertain(claim: ReviewCiDeliveryClaim, errorClass: 'transport' | 'timeout', now = Date.now(), delayMs = 1_000): Promise<ReviewCiTransition> {
    this.delay(delayMs); clock(now);
    if (!['transport', 'timeout'].includes(errorClass)) throw new Error('Invalid Review CI error class');
    return this.transaction(async (client) => {
      const owned = await this.ownedDelivery(client, claim, now);
      if (!owned) return 'stale';
      // A known run acknowledgement cannot be erased by a late transport error.
      if (owned.row.acknowledged_run !== null) return 'conflict';
      await client.query(`UPDATE review_ci_deliveries SET state='uncertain',last_error_class=$4,
        lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,available_at=to_timestamp(($5::double precision+$6)/1000.0),updated_at=to_timestamp($5/1000.0)
        WHERE request_id=$1 AND kind=$2 AND epoch=$3`,
      [owned.request.requestId, claim.kind, claim.epoch, errorClass, now, delayMs]);
      return 'recorded';
    });
  }
  async acknowledgeRepositoryDispatch(claim: ReviewCiDeliveryClaim, now = Date.now()): Promise<ReviewCiTransition> {
    clock(now);
    if (claim.kind !== 'repository') return 'conflict';
    return this.transaction(async (client) => {
      if (!await this.ownedDelivery(client, claim, now)) return 'stale';
      await client.query(`UPDATE review_ci_deliveries SET state='dispatched',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
        updated_at=to_timestamp($2/1000.0) WHERE request_id=$1 AND kind='repository' AND epoch=0`, [claim.request.requestId, now]);
      return 'recorded';
    });
  }
  private executionMatches(request: StoredReviewCiRequest, execution: ReviewCiExecution): boolean {
    return execution.requestId === request.requestId && execution.epoch === request.workflowEpoch
      && execution.repositoryId === request.review.repositoryId && execution.workflowId === request.binding?.workflowId
      && execution.workflowSha === request.binding?.workflowSha && execution.candidateSha === request.binding?.candidateSha;
  }
  async acknowledgeWorkflowDispatch(claim: ReviewCiDeliveryClaim, input: unknown, now = Date.now(), delayMs = 1_000): Promise<ReviewCiTransition> {
    clock(now); this.delay(delayMs);
    const execution = reviewCiExecutionSchema.parse(input);
    if (claim.kind !== 'workflow') return 'conflict';
    return this.transaction(async (client) => {
      const owned = await this.ownedDelivery(client, claim, now);
      if (!owned) return 'stale';
      if (!this.executionMatches(owned.request, execution)
        || (owned.row.acknowledged_run && sha256(owned.row.acknowledged_run) !== sha256(execution))) return 'conflict';
      await client.query(`UPDATE review_ci_deliveries SET state='dispatched',acknowledged_run=$3,
        lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,available_at=to_timestamp(($4::double precision+$5)/1000.0),updated_at=to_timestamp($4/1000.0)
        WHERE request_id=$1 AND kind='workflow' AND epoch=$2`,
      [owned.request.requestId, claim.epoch, JSON.stringify(execution), now, delayMs]);
      return 'recorded';
    });
  }
  private delay(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 3_600_000) throw new Error('Invalid Review CI backoff');
  }
  /** No retry without fresh persisted readback AND invalidating the old epoch.
   * Never call with an untrusted receiver's claim that a run was absent. */
  async retryUncertainDelivery(claim: ReviewCiDeliveryClaim, reconciliation: ReviewCiAbsentReconciliation,
    now = Date.now(), delayMs = 1_000,
  ): Promise<ReviewCiTransition | 'exhausted'> {
    clock(now); this.delay(delayMs);
    reconciliation = reviewCiAbsentReconciliationSchema.parse(reconciliation);
    return this.transaction(async (client) => {
      const owned = await this.ownedDelivery(client, claim, now);
      if (!owned) return 'stale';
      const { request, row } = owned;
      if (claim.mode !== 'reconcile' || row.state !== 'uncertain' || row.acknowledged_run !== null
        || reconciliation.outcome !== 'absent' || reconciliation.requestId !== request.requestId
        || reconciliation.kind !== claim.kind || reconciliation.epoch !== claim.epoch
        || !Number.isSafeInteger(reconciliation.observedAt) || reconciliation.observedAt > now
        || reconciliation.observedAt < new Date(row.updated_at).getTime()
        || reconciliation.observedAt < new Date(row.dispatch_started_at).getTime()) return 'conflict';
      const count = Number((await client.query(`SELECT SUM(dispatch_count) AS count FROM review_ci_deliveries WHERE request_id=$1 AND kind=$2`,
        [request.requestId, claim.kind])).rows[0].count);
      const exhausted = count >= this.maxDispatchAttempts;
      await client.query(`UPDATE review_ci_deliveries SET state=$4,reconciliation=$5,
        lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,last_error_class=$6,
        available_at=to_timestamp(($7::double precision+$8)/1000.0),updated_at=to_timestamp($7/1000.0)
        WHERE request_id=$1 AND kind=$2 AND epoch=$3`,
      [request.requestId, claim.kind, claim.epoch, exhausted ? 'terminal_error' : claim.kind === 'workflow' ? 'fenced' : 'pending',
        JSON.stringify(reconciliation), exhausted ? 'delivery-exhausted' : null, now, delayMs]);
      if (exhausted) {
        await client.query(`UPDATE review_ci_requests SET state='delivery_error',updated_at=to_timestamp($2/1000.0) WHERE request_id=$1`, [request.requestId, now]);
        await this.notifyTransition(client, request.requestId, 'delivery_error', now);
        return 'exhausted';
      }
      if (claim.kind === 'workflow') {
        await client.query(`UPDATE review_ci_requests SET workflow_epoch=workflow_epoch+1,updated_at=to_timestamp($2/1000.0) WHERE request_id=$1`, [request.requestId, now]);
        await client.query(`INSERT INTO review_ci_deliveries(request_id,kind,epoch,available_at,created_at,updated_at)
          VALUES($1,'workflow',$2,to_timestamp(($3::double precision+$4)/1000.0),to_timestamp($3/1000.0),to_timestamp($3/1000.0))`,
        [request.requestId, claim.epoch + 1, now, delayMs]);
      }
      return 'recorded';
    });
  }
  async claimExecution(input: unknown, validateCurrent: (request: StoredReviewCiRequest) => Promise<void>, now = Date.now()): Promise<ReviewCiTransition> {
    clock(now);
    if (typeof validateCurrent !== 'function') throw new Error('Review CI freshness validator is required');
    const execution = reviewCiExecutionSchema.parse(input);
    return this.transaction(async (client) => {
      const request = await this.locked(client, execution.requestId);
      if (!request || TERMINAL.has(request.state)) return 'stale';
      if (!this.executionMatches(request, execution)) return execution.epoch !== request.workflowEpoch ? 'stale' : 'conflict';
      if (request.execution) {
        if (sha256(request.execution) !== sha256(execution)) return 'conflict';
        await this.validateFresh(request, validateCurrent);
        return 'duplicate';
      }
      if (request.state !== 'admitted') return 'stale';
      const delivery = (await client.query(`SELECT * FROM review_ci_deliveries WHERE request_id=$1 AND kind='workflow' AND epoch=$2 FOR UPDATE`,
        [request.requestId, execution.epoch])).rows[0];
      // Pending has no committed dispatch intent yet; a forged/manual run cannot jump ahead.
      if (!delivery || !['dispatching', 'uncertain', 'dispatched'].includes(delivery.state)) return 'stale';
      if (delivery.acknowledged_run && sha256(delivery.acknowledged_run) !== sha256(execution)) return 'conflict';
      // Run IDs are globally unique at GitHub. Serialize reuse even across
      // different PR locks, so a racing second binding returns conflict.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`review-ci-run:${execution.runId}`]);
      if ((await client.query('SELECT request_id FROM review_ci_requests WHERE execution_run_id=$1', [execution.runId])).rows.length) return 'conflict';
      await this.validateFresh(request, validateCurrent);
      if (!this.options.assertPendingPublished) throw new Error('Review CI pending publication proof is required');
      await this.options.assertPendingPublished(client, structuredClone(request), now);
      await client.query(`UPDATE review_ci_requests SET state='running',execution=$2,execution_run_id=$3,updated_at=to_timestamp($4/1000.0)
        WHERE request_id=$1`, [request.requestId, JSON.stringify(execution), execution.runId, now]);
      await client.query(`UPDATE review_ci_deliveries SET state='claimed',acknowledged_run=$3,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
        updated_at=to_timestamp($4/1000.0) WHERE request_id=$1 AND kind='workflow' AND epoch=$2`,
      [request.requestId, execution.epoch, JSON.stringify(execution), now]);
      await this.notifyTransition(client, request.requestId, 'running', now);
      return 'recorded';
    });
  }
  async recordTerminalReceipt(input: unknown, validateCurrent: (request: StoredReviewCiRequest) => Promise<void>, now = Date.now()): Promise<ReviewCiTransition> {
    clock(now);
    if (typeof validateCurrent !== 'function') throw new Error('Review CI freshness validator is required');
    const receipt = reviewCiTerminalReceiptSchema.parse(input);
    receipt.jobs.sort((a, b) => a.id - b.id);
    return this.transaction(async (client) => {
      const request = await this.locked(client, receipt.execution.requestId);
      if (!request || !request.execution || !['running', 'completed'].includes(request.state)) return 'stale';
      if (sha256(request.execution) !== sha256(receipt.execution)) return 'conflict';
      if (receipt.conclusion === 'success' && !request.binding!.lanePlan.requiredJobs.every((name) => {
        const jobs = receipt.jobs.filter((job) => job.name === name);
        return jobs.length === 1 && jobs[0].conclusion === 'success';
      })) return 'conflict';
      if (request.terminalReceipt && sha256(request.terminalReceipt) !== sha256(receipt)) return 'conflict';
      await this.validateFresh(request, validateCurrent);
      if (request.terminalReceipt) return 'duplicate';
      await client.query(`UPDATE review_ci_requests SET state='completed',terminal_receipt=$2,terminal_digest=$3,
        updated_at=to_timestamp($4/1000.0) WHERE request_id=$1`,
      [request.requestId, JSON.stringify(receipt), sha256(receipt), now]);
      await client.query(`UPDATE review_ci_deliveries SET state='completed',updated_at=to_timestamp($3/1000.0)
        WHERE request_id=$1 AND kind='workflow' AND epoch=$2`, [request.requestId, receipt.execution.epoch, now]);
      await this.notifyTransition(client, request.requestId, 'completed', now);
      return 'recorded';
    });
  }
}
