import { randomUUID } from 'node:crypto';
import { sha256 } from '../review/reviewCore';
import {
  deriveReviewCiCheckExternalId,
  REVIEW_CI_CHECK_NAME,
  type ReviewCiCheckCoordinates,
  type ReviewGateCheck,
} from '../review/reviewCheckIdentity';
import {
  reviewCiExecutionSchema,
  reviewCiIdentityDigest, reviewCiTerminalReceiptSchema,
  type ReviewCiState, type ReviewCiTerminalReceipt, type StoredReviewCiRequest,
} from '../review/reviewCi';
import type { ReviewCiQueryable, ReviewCiStateTransition } from '../review/reviewCi';
import type {
  ReviewCiCheckCreationState, ReviewCiCheckDesiredState, ReviewCiCheckError,
  ReviewCiCheckPublicationClaim, ReviewCiCheckPublicationNotStarted, ReviewCiCheckRepository,
  StoredReviewCiCheck,
} from '../review/reviewCiCheckContracts';
import { reviewDispatchPrLockKey, storedReviewCiRequestFromRow } from './reviewCiPersistence';
export type {
  ReviewCiCheckClient, ReviewCiCheckCreationState, ReviewCiCheckDesiredState, ReviewCiCheckError,
  ReviewCiCheckPublicationClaim, ReviewCiCheckPublicationNotStarted, StoredReviewCiCheck,
} from '../review/reviewCiCheckContracts';

interface Client extends ReviewCiQueryable { release(): void }
interface Pool extends ReviewCiQueryable { connect(): Promise<Client> }

export type { ReviewCiCheckTransition } from '../review/reviewCiCheckContracts';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const TERMINAL = new Set<ReviewCiState>(['completed', 'superseded', 'delivery_error']);
const checkStates = new Set<ReviewCiCheckDesiredState>(['queued', 'in_progress', 'success', 'failure', 'cancelled', 'timed_out']);

function clock(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000) throw new Error('Invalid Review CI check clock');
}
function requestId(value: string): void {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('Invalid Review CI check request identity');
}
function positive(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`Invalid Review CI check ${field}`);
  return value as number;
}
function sameJson(left: unknown, right: unknown): boolean { return sha256(left) === sha256(right); }

function immutableBindingDigest(request: StoredReviewCiRequest): string {
  if (!request.binding) throw new Error('Review CI check requires an admitted binding');
  return reviewCiIdentityDigest({ requestId: request.requestId, review: request.review,
    expectedAppId: request.expectedAppId, binding: request.binding });
}

function coordinatesFor(request: StoredReviewCiRequest, epoch: number): ReviewCiCheckCoordinates {
  const digest = immutableBindingDigest(request);
  return {
    owner: request.review.owner, repo: request.review.repo, repositoryId: request.review.repositoryId,
    prNumber: request.review.prNumber, headSha: request.review.headSha, baseSha: request.review.baseSha,
    policyDigest: request.review.policyDigest, requestId: request.requestId,
    immutableBindingDigest: digest, epoch,
  };
}

function desiredFromReceipt(receipt: ReviewCiTerminalReceipt): ReviewCiCheckDesiredState {
  if (receipt.conclusion === 'success') return 'success';
  if (receipt.conclusion === 'cancelled') return 'cancelled';
  if (receipt.conclusion === 'timed_out') return 'timed_out';
  return 'failure';
}

function checkFromRows(request: StoredReviewCiRequest, row: any): StoredReviewCiCheck {
  if (!row) throw new Error('Review CI check intent is missing');
  const digest = immutableBindingDigest(request);
  const epoch = Number(row.current_epoch);
  const coordinates = coordinatesFor(request, epoch);
  const expectedExternalId = deriveReviewCiCheckExternalId(coordinates);
  const execution = row.claimed_execution === null ? null : reviewCiExecutionSchema.parse(row.claimed_execution);
  const receipt = row.terminal_receipt === null ? null : reviewCiTerminalReceiptSchema.parse(row.terminal_receipt);
  if (Number(row.repository_id) !== request.review.repositoryId || Number(row.pr_number) !== request.review.prNumber
    || Number(row.expected_app_id) !== request.expectedAppId || !sameJson(row.review, request.review)
    || row.candidate_sha !== request.binding?.candidateSha || row.workflow_sha !== request.binding?.workflowSha
    || row.lane_plan_digest !== request.binding?.lanePlan.digest || row.immutable_binding_digest !== digest
    || row.external_id !== expectedExternalId || !Number.isSafeInteger(epoch) || epoch < 1
    || (execution && (execution.requestId !== request.requestId || execution.epoch !== epoch
      || Number(row.claimed_run_id) !== execution.runId))
    || (receipt && (!request.terminalReceipt || !sameJson(receipt, request.terminalReceipt)))
    || !checkStates.has(row.desired_state)) throw new Error('Invalid stored Review CI check identity');
  const checkId = row.check_id === null ? null : positive(Number(row.check_id), 'check id');
  const desiredVersion = positive(Number(row.desired_version), 'desired version');
  const publishedVersion = Number(row.published_version);
  if (!Number.isSafeInteger(publishedVersion) || publishedVersion > desiredVersion
    || !['reserved', 'creating', 'bound'].includes(row.creation_state)
    || (row.creation_state === 'bound') !== (checkId !== null)
    || (receipt && row.terminal_digest !== sha256(receipt))
    || (row.desired_state === 'success' && !receipt)) throw new Error('Invalid stored Review CI check publication state');
  return {
    request, coordinates, expectedAppId: request.expectedAppId, immutableBindingDigest: digest,
    externalId: expectedExternalId, currentEpoch: epoch, claimedExecution: execution,
    desiredState: row.desired_state, desiredVersion, publishedVersion, checkId,
    creationState: row.creation_state, terminalReceipt: receipt,
  };
}

async function prLock(client: ReviewCiQueryable, repositoryId: number, prNumber: number): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [reviewDispatchPrLockKey(repositoryId, prNumber)]);
}

/** CI check publication persistence. All transition methods with `InTransaction`
 * are called by the admission core before its COMMIT, under the shared PR lock.
 * This class never mints tokens or performs network I/O. */
export class PostgresReviewCiCheckRepository implements ReviewCiCheckRepository {
  constructor(private readonly pool: Pool, private readonly options: {
    clientPreparationRetryMs?: number;
    statementTimeoutMs?: number;
    idleTransactionTimeoutMs?: number;
  } = {}) {
    const retry = options.clientPreparationRetryMs ?? 30_000;
    const statementTimeoutMs = options.statementTimeoutMs ?? 30_000;
    const idleTransactionTimeoutMs = options.idleTransactionTimeoutMs ?? 45_000;
    if (!Number.isSafeInteger(retry) || retry < 1_000 || retry > 300_000
      || !Number.isSafeInteger(statementTimeoutMs) || statementTimeoutMs < 250 || statementTimeoutMs > 120_000
      || !Number.isSafeInteger(idleTransactionTimeoutMs) || idleTransactionTimeoutMs < 250 || idleTransactionTimeoutMs > 120_000
      || idleTransactionTimeoutMs < statementTimeoutMs) throw new Error('Invalid Review CI check transaction bound');
    this.statementTimeoutMs = statementTimeoutMs;
    this.idleTransactionTimeoutMs = idleTransactionTimeoutMs;
  }

  private readonly statementTimeoutMs: number;
  private readonly idleTransactionTimeoutMs: number;

  private async begin(client: Client): Promise<void> {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query(`SET LOCAL statement_timeout = '${this.statementTimeoutMs}ms'`);
    await client.query(`SET LOCAL idle_in_transaction_session_timeout = '${this.idleTransactionTimeoutMs}ms'`);
  }

  private async transaction<T>(operation: (client: Client) => Promise<T>): Promise<T> {
    let client: Client | undefined;
    try {
      client = await this.pool.connect();
      await this.begin(client);
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch {
      await client?.query('ROLLBACK').catch(() => undefined);
      throw new Error('Review CI check persistence operation failed');
    } finally { client?.release(); }
  }

  private async requestFor(client: Client, id: string, lock = false): Promise<StoredReviewCiRequest | null> {
    requestId(id);
    const result = await client.query(`SELECT * FROM review_ci_requests WHERE request_id=$1${lock ? ' FOR UPDATE' : ''}`, [id]);
    return result.rows[0] ? storedReviewCiRequestFromRow(result.rows[0]) : null;
  }

  private async checkFor(client: Client, id: string, lock = false): Promise<any | null> {
    const result = await client.query(`SELECT * FROM review_ci_check_attempts WHERE request_id=$1${lock ? ' FOR UPDATE' : ''}`, [id]);
    return result.rows[0] ?? null;
  }

  private assertStable(request: StoredReviewCiRequest, row: any): void {
    const check = checkFromRows(request, row);
    if (check.externalId !== row.external_id) throw new Error('Review CI check external identity conflict');
  }

  /** Hook used by the admission core. It is transaction-only and therefore
   * rolls the request/outbox transition back if the check intent cannot save. */
  async transitionInTransaction(client: ReviewCiQueryable, request: StoredReviewCiRequest,
    transition: ReviewCiStateTransition, now = Date.now()): Promise<StoredReviewCiCheck | null> {
    clock(now); requestId(request.requestId);
    if (!['admitted', 'running', 'completed', 'superseded', 'delivery_error'].includes(transition)) {
      throw new Error('Invalid Review CI check transition');
    }
    if (!request.binding) return transition === 'admitted' ? null : this.readInTransaction(client, request.requestId);
    if (request.identityDigest !== immutableBindingDigest(request)) throw new Error('Review CI check binding digest conflict');
    const existing = await this.checkFor(client as Client, request.requestId, true);
    if (transition === 'admitted' && !existing) {
      const digest = immutableBindingDigest(request);
      const coordinates = coordinatesFor(request, request.workflowEpoch);
      const externalId = deriveReviewCiCheckExternalId(coordinates);
      await client.query(`INSERT INTO review_ci_check_attempts(
        request_id,repository_id,pr_number,expected_app_id,review,candidate_sha,workflow_sha,lane_plan_digest,
        immutable_binding_digest,external_id,current_epoch,desired_state,desired_version,published_version,
        creation_state,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'queued',1,-1,'reserved',to_timestamp($12/1000.0),to_timestamp($12/1000.0))`,
      [request.requestId, request.review.repositoryId, request.review.prNumber, request.expectedAppId,
        JSON.stringify(request.review), request.binding.candidateSha, request.binding.workflowSha,
        request.binding.lanePlan.digest, digest, externalId, request.workflowEpoch, now]);
      await client.query(`INSERT INTO review_ci_check_outbox(request_id,state,available_at,created_at,updated_at)
        VALUES($1,'pending',to_timestamp($2/1000.0),to_timestamp($2/1000.0),to_timestamp($2/1000.0))`, [request.requestId, now]);
      return this.readInTransaction(client, request.requestId);
    }
    if (!existing) throw new Error('Review CI check transition has no admission intent');
    this.assertStable(request, existing);
    const before = checkFromRows(request, existing);
    if (transition === 'admitted') return before;
    if (TERMINAL.has(request.state) && transition === 'running') throw new Error('Review CI check cannot run after terminal request');
    if (transition === 'running') {
      if (!request.execution || request.state !== 'running') throw new Error('Review CI running transition lacks execution');
      if (before.terminalReceipt) return before;
      if (request.execution.requestId !== request.requestId || request.execution.epoch !== request.workflowEpoch) {
        throw new Error('Review CI execution identity conflict');
      }
      if (before.claimedExecution && sameJson(before.claimedExecution, request.execution)
        && before.currentEpoch === request.workflowEpoch && before.desiredState === 'in_progress') return before;
      if (before.currentEpoch > request.workflowEpoch) throw new Error('Review CI execution epoch regressed');
      await client.query(`UPDATE review_ci_check_attempts SET current_epoch=$2,claimed_execution=$3,claimed_run_id=$4,
        desired_state='in_progress',desired_version=desired_version+1,last_error_class=NULL,updated_at=to_timestamp($5/1000.0)
        WHERE request_id=$1`, [request.requestId, request.workflowEpoch, JSON.stringify(request.execution), request.execution.runId, now]);
    } else if (transition === 'completed') {
      if (!request.terminalReceipt || !request.execution) throw new Error('Review CI completed transition lacks receipt');
      if (request.terminalReceipt.execution.epoch !== request.workflowEpoch
        || !sameJson(request.terminalReceipt.execution, request.execution)) throw new Error('Review CI terminal identity conflict');
      const receipt = request.terminalReceipt;
      if (receipt.conclusion === 'success' && !request.binding.lanePlan.requiredJobs.every((name) => {
        const jobs = receipt.jobs.filter((job) => job.name === name);
        return jobs.length === 1 && jobs[0].status === 'completed' && jobs[0].conclusion === 'success';
      })) throw new Error('Review CI terminal receipt has failed required jobs');
      if (before.terminalReceipt) {
        if (!sameJson(before.terminalReceipt, receipt)) throw new Error('Review CI terminal receipt conflict');
        return before;
      }
      await client.query(`UPDATE review_ci_check_attempts SET current_epoch=$2,claimed_execution=$3,claimed_run_id=$4,
        desired_state=$5,desired_version=desired_version+1,terminal_receipt=$6,terminal_digest=$7,
        last_error_class=NULL,updated_at=to_timestamp($8/1000.0) WHERE request_id=$1`,
      [request.requestId, request.workflowEpoch, JSON.stringify(request.execution), request.execution.runId,
        desiredFromReceipt(receipt), JSON.stringify(receipt), sha256(receipt), now]);
    } else {
      const desired: ReviewCiCheckDesiredState = transition === 'superseded' ? 'cancelled' : 'failure';
      if (before.terminalReceipt) return before;
      await client.query(`UPDATE review_ci_check_attempts SET desired_state=$2,desired_version=desired_version+1,
        last_error_class=NULL,updated_at=to_timestamp($3/1000.0) WHERE request_id=$1`, [request.requestId, desired, now]);
    }
    await client.query(`UPDATE review_ci_check_outbox SET state='pending',lease_owner=NULL,lease_token=NULL,
      lease_expires_at=NULL,available_at=to_timestamp($2/1000.0),last_error_class=NULL,updated_at=to_timestamp($2/1000.0)
      WHERE request_id=$1`, [request.requestId, now]);
    return this.readInTransaction(client, request.requestId);
  }

  /** Required before the first expensive workflow execution claim. It proves
   * the current nonterminal intent has an externally bound, fully published
   * check; a merely inserted queued row is insufficient. */
  async assertPendingPublishedInTransaction(client: ReviewCiQueryable, request: StoredReviewCiRequest, now = Date.now()): Promise<void> {
    clock(now); requestId(request.requestId);
    if (!request.binding || request.state !== 'admitted') throw new Error('Review CI pending check proof is unavailable');
    const row = await this.checkFor(client as Client, request.requestId, true);
    if (!row) throw new Error('Review CI pending check intent is missing');
    const check = checkFromRows(request, row);
    const outbox = (await client.query('SELECT * FROM review_ci_check_outbox WHERE request_id=$1 FOR UPDATE', [request.requestId])).rows[0];
    if (check.currentEpoch > request.workflowEpoch || !['queued', 'in_progress'].includes(check.desiredState)
      || check.creationState !== 'bound' || check.checkId === null || check.publishedVersion !== check.desiredVersion
      || !outbox || outbox.state !== 'published' || outbox.lease_owner !== null) {
      throw new Error('Review CI pending check is not externally published');
    }
  }

  async get(requestIdValue: string): Promise<StoredReviewCiCheck | null> {
    requestId(requestIdValue);
    return this.transaction(async (client) => this.readInTransaction(client, requestIdValue));
  }

  private async readInTransaction(client: ReviewCiQueryable, requestIdValue: string, lock = false): Promise<StoredReviewCiCheck | null> {
    const request = await this.requestFor(client as Client, requestIdValue, lock);
    if (!request) return null;
    const row = await this.checkFor(client as Client, requestIdValue, lock);
    return row ? checkFromRows(request, row) : null;
  }

  async claimPublication(workerId: string, now = Date.now(), leaseMs = 60_000): Promise<ReviewCiCheckPublicationClaim | null> {
    clock(now);
    if (!/^[A-Za-z0-9_.:-]{1,100}$/u.test(workerId) || !Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 120_000) {
      throw new Error('Invalid Review CI check publication lease');
    }
    return this.transaction(async (client) => {
      // Candidate discovery is deliberately unlocked. Core admission takes
      // the PR advisory lock before locking its request/outbox rows; retaining
      // an outbox lock while waiting for that lock would invert the order.
      const candidates = (await client.query(`SELECT o.request_id,r.repository_id,r.pr_number FROM review_ci_check_outbox o
        JOIN review_ci_check_attempts c USING(request_id)
        JOIN review_ci_requests r USING(request_id)
        WHERE c.published_version < c.desired_version
          AND o.available_at <= to_timestamp($1::double precision/1000.0)
          AND (o.lease_expires_at IS NULL OR o.lease_expires_at <= to_timestamp($1::double precision/1000.0))
          AND o.state IN ('pending','claimed')
        ORDER BY o.available_at,c.created_at LIMIT 25`, [now])).rows;
      for (const candidate of candidates) {
        const acquired = (await client.query(
          'SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',
          [reviewDispatchPrLockKey(Number(candidate.repository_id), Number(candidate.pr_number))],
        )).rows[0]?.acquired === true;
        if (!acquired) continue;
        const request = await this.requestFor(client, candidate.request_id, true);
        if (!request || !request.binding) continue;
        await prLock(client, request.review.repositoryId, request.review.prNumber);
        const row = await this.checkFor(client, request.requestId, true);
        const outbox = (await client.query('SELECT * FROM review_ci_check_outbox WHERE request_id=$1 FOR UPDATE', [request.requestId])).rows[0];
        if (!row || !outbox || Number(row.published_version) >= Number(row.desired_version)
          || !['pending', 'claimed'].includes(outbox.state)
          || (outbox.lease_expires_at && new Date(outbox.lease_expires_at).getTime() > now)) continue;
        const check = checkFromRows(request, row);
        const token = randomUUID();
        const mayCreate = check.creationState === 'reserved' && check.checkId === null;
        if (mayCreate) await client.query("UPDATE review_ci_check_attempts SET creation_state='creating',updated_at=to_timestamp($2::double precision/1000.0) WHERE request_id=$1", [request.requestId, now]);
        await client.query(`UPDATE review_ci_check_outbox SET state='claimed',lease_owner=$2,lease_token=$3,
          lease_expires_at=to_timestamp(($4::double precision+$5::double precision)/1000.0),updated_at=to_timestamp($4::double precision/1000.0)
          WHERE request_id=$1`, [request.requestId, workerId, token, now, leaseMs]);
        const claimed = await this.readInTransaction(client, request.requestId);
        if (!claimed) throw new Error('Review CI check claim disappeared');
        return { ...claimed, leaseOwner: workerId, leaseToken: token, mayCreate };
      }
      return null;
    });
  }

  async retryPublication(claim: ReviewCiCheckPublicationClaim, now = Date.now(), delayMs = 30_000, errorClass: ReviewCiCheckError = 'transport'): Promise<boolean> {
    clock(now);
    if (!Number.isSafeInteger(delayMs) || delayMs < 1_000 || delayMs > 300_000 || !['transport', 'unknown-create', 'identity-conflict', 'stale-claim'].includes(errorClass)) {
      throw new Error('Invalid Review CI check publication retry');
    }
    return this.transaction(async (client) => {
      const result = await client.query(`UPDATE review_ci_check_outbox SET state='pending',lease_owner=NULL,lease_token=NULL,
        lease_expires_at=NULL,available_at=to_timestamp(($3::double precision+$4::double precision)/1000.0),last_error_class=$5,updated_at=to_timestamp($3::double precision/1000.0)
        WHERE request_id=$1 AND lease_owner=$2 AND lease_token=$6 AND lease_expires_at > to_timestamp($3::double precision/1000.0)
        RETURNING request_id`, [claim.request.requestId, claim.leaseOwner, now, delayMs, errorClass, claim.leaseToken]);
      return result.rows.length === 1;
    });
  }

  async publishLocked(claim: ReviewCiCheckPublicationClaim,
    publish: (check: StoredReviewCiCheck, mayCreate: boolean) => Promise<ReviewGateCheck | ReviewCiCheckPublicationNotStarted>,
    now = Date.now()): Promise<'published' | 'stale-claim' | 'retry'> {
    clock(now);
    const client = await this.pool.connect();
    try {
      await this.begin(client);
      await prLock(client, claim.request.review.repositoryId, claim.request.review.prNumber);
      const request = await this.requestFor(client, claim.request.requestId, true);
      const row = request ? await this.checkFor(client, request.requestId, true) : null;
      const outbox = request ? (await client.query('SELECT * FROM review_ci_check_outbox WHERE request_id=$1 FOR UPDATE', [request.requestId])).rows[0] : null;
      if (!request || !row || !outbox || outbox.lease_owner !== claim.leaseOwner || outbox.lease_token !== claim.leaseToken
        || !outbox.lease_expires_at || new Date(outbox.lease_expires_at).getTime() <= now
        || Number(row.desired_version) !== claim.desiredVersion || row.external_id !== claim.externalId) {
        await client.query('COMMIT'); return 'stale-claim';
      }
      const check = checkFromRows(request, row);
      const mayCreate = claim.mayCreate && check.creationState === 'creating' && check.checkId === null;
      const result = await publish(check, mayCreate);
      if ('kind' in result) {
        if (!mayCreate || result.kind !== 'not-started' || !Number.isSafeInteger(result.retryDelayMs)
          || result.retryDelayMs < 1_000 || result.retryDelayMs > 300_000) throw new Error('Invalid Review CI check preparation recovery');
        await client.query(`UPDATE review_ci_check_attempts SET creation_state='reserved',updated_at=to_timestamp($2::double precision/1000.0)
          WHERE request_id=$1 AND creation_state='creating' AND check_id IS NULL`, [request.requestId, now]);
        await client.query(`UPDATE review_ci_check_outbox SET state='pending',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
          available_at=to_timestamp(($2::double precision+$3::double precision)/1000.0),last_error_class='transport',updated_at=to_timestamp($2::double precision/1000.0)
          WHERE request_id=$1 AND lease_owner=$4 AND lease_token=$5`,
        [request.requestId, now, result.retryDelayMs, claim.leaseOwner, claim.leaseToken]);
        await client.query('COMMIT'); return 'retry';
      }
      const terminal = !['queued', 'in_progress'].includes(check.desiredState);
      if (!Number.isSafeInteger(result.id) || result.id <= 0 || result.name !== REVIEW_CI_CHECK_NAME
        || result.appId !== check.expectedAppId || result.headSha !== check.request.review.headSha
        || result.externalId !== check.externalId || (check.checkId !== null && result.id !== check.checkId)
        || result.status !== (terminal ? 'completed' : check.desiredState)
        || result.conclusion !== (terminal ? check.desiredState : null)) throw new Error('Published Review CI check identity/state mismatch');
      const saved = await client.query(`UPDATE review_ci_check_attempts SET check_id=$2,creation_state='bound',published_version=desired_version,
        updated_at=to_timestamp($3::double precision/1000.0) WHERE request_id=$1 RETURNING request_id`, [request.requestId, result.id, now]);
      if (saved.rows.length !== 1) throw new Error('Review CI check publication acknowledgement was not durable');
      await client.query(`UPDATE review_ci_check_outbox SET state='published',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
        last_error_class=NULL,updated_at=to_timestamp($2::double precision/1000.0) WHERE request_id=$1`, [request.requestId, now]);
      await client.query('COMMIT'); return 'published';
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined); throw error;
    } finally { client.release(); }
  }
}
