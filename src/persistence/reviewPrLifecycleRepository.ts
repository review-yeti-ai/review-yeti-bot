import { randomUUID } from 'node:crypto';
import { canonicalJson, sha256 } from '../review/reviewCore';
import { constantTimeDigestEqual } from '../utils/constantTimeDigest';

interface QueryResult { rows: any[] }
export interface ReviewLifecycleQueryable {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
}

export interface PrLifecycleHistorySnapshotRequest {
  runId: string;
  executionAttempt: number;
  workerTokenDigest: string;
}

export interface PrLifecycleHistorySnapshot {
  snapshotId: string;
  runId: string;
  executionAttempt: number;
  repositoryId: number;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  policyDigest: string;
  configDigest: string;
  contextDigest: string;
  eventCount: number;
  findingCount: number;
  eventOmittedCount: number;
  findingOmittedCount: number;
  legacyOmittedCount: number;
  eventsDigest: string;
  findingsDigest: string;
  expiresAt: string;
}

export type PrLifecycleHistorySnapshotCreateResult =
  | { status: 'unauthorized' }
  | { status: 'unavailable' }
  | { status: 'ok'; snapshot: PrLifecycleHistorySnapshot };

export type PrLifecycleHistoryCollection = 'events' | 'findings';

export type PrLifecycleHistorySnapshotPageResult =
  | { status: 'unauthorized' }
  | { status: 'not_found' }
  | { status: 'ok'; snapshotId: string; collection: PrLifecycleHistoryCollection; offset: number;
    limit: number; totalCount: number; capturedCount: number; rows: any[]; hasMore: boolean; nextOffset: number | null };

const MAX_CAPTURED_HISTORY_IDS = 10_000;
const HISTORY_SNAPSHOT_TTL_MS = 30 * 60 * 1000;

/** History access needs the live admitted reservation as well as a valid bearer.
 * This rejects a run whose current head/config changed, whose reservation ended,
 * or whose run/outbox has been cancelled or superseded since snapshot creation. */
async function historyExecutionAuthorized(client: ReviewLifecycleQueryable,
  input: { runId: string; executionAttempt: number; workerTokenDigest: string }): Promise<boolean> {
  if (!/^run_[a-f0-9]{32}$/u.test(input.runId) || !Number.isSafeInteger(input.executionAttempt)
    || input.executionAttempt < 1 || !validDigest(input.workerTokenDigest)) return false;
  const binding = (await client.query(`SELECT runs.status, runs.cancel_requested_at, runs.cancel_propagated_at,
      outbox.status AS outbox_status, outbox.cancel_requested_at AS outbox_cancel_requested_at,
      outbox.cancel_propagated_at AS outbox_cancel_propagated_at,
      outbox.worker_token_digest, reservation.status AS reservation_status
    FROM review_runs runs
    JOIN review_dispatch_outbox outbox ON outbox.run_id = runs.run_id
    JOIN review_pr_review_reservations reservation
      ON reservation.run_id = runs.run_id AND reservation.execution_attempt = $2
    JOIN review_pr_lifecycles lifecycle ON lifecycle.lifecycle_id = reservation.lifecycle_id
    WHERE runs.run_id = $1 AND outbox.execution_attempt + 1 = $2
      AND runs.status IN ('queued', 'running') AND runs.cancel_requested_at IS NULL
      AND runs.cancel_propagated_at IS NULL AND outbox.status = 'projected'
      AND outbox.cancel_requested_at IS NULL AND outbox.cancel_propagated_at IS NULL
      AND reservation.status = 'reserved'
      AND runs.repository_id = lifecycle.repository_id AND runs.owner = lifecycle.owner
      AND runs.repo = lifecycle.repo AND runs.pr_number = lifecycle.pr_number
      AND runs.head_sha = reservation.head_sha AND runs.base_sha = reservation.base_sha
      AND runs.effective_policy_digest = reservation.policy_digest
      AND runs.effective_config_digest = reservation.config_digest
      AND runs.snapshot_digest = reservation.context_digest`, [input.runId, input.executionAttempt])).rows[0];
  return Boolean(binding) && constantTimeDigestEqual(binding.worker_token_digest, input.workerTokenDigest)
    && binding.cancel_requested_at == null && binding.cancel_propagated_at == null
    && binding.outbox_cancel_requested_at == null && binding.outbox_cancel_propagated_at == null
    && binding.status !== 'superseded' && binding.outbox_status === 'projected'
    && binding.reservation_status === 'reserved';
}

function uuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch { return []; }
  }
  return [];
}

/**
 * Capture a fixed, bounded view of immutable PR history for the exact live worker execution.
 * The PR coordinates are selected from the admitted run and its lifecycle reservation; the
 * worker cannot choose another repository or PR. A single INSERT...SELECT statement captures
 * all event/finding IDs from one MVCC snapshot, so concurrent appends cannot shift pagination.
 */
export async function createPrLifecycleHistorySnapshot(client: ReviewLifecycleQueryable,
  input: PrLifecycleHistorySnapshotRequest): Promise<PrLifecycleHistorySnapshotCreateResult> {
  if (!/^run_[a-f0-9]{32}$/u.test(input.runId) || !Number.isSafeInteger(input.executionAttempt)
    || input.executionAttempt < 1 || !validDigest(input.workerTokenDigest)) return { status: 'unauthorized' };
  if (!await historyExecutionAuthorized(client, input)) return { status: 'unauthorized' };
  const snapshotId = randomUUID();
  const result = await client.query(`
    WITH admitted AS MATERIALIZED (
      SELECT r.run_id, $2::integer AS execution_attempt, l.lifecycle_id, l.repository_id, l.owner, l.repo,
        l.pr_number, reservation.head_sha, reservation.base_sha, reservation.policy_digest,
        reservation.config_digest, reservation.context_digest
      FROM review_runs r
      JOIN review_dispatch_outbox outbox ON outbox.run_id = r.run_id AND outbox.execution_attempt + 1 = $2
      JOIN review_pr_review_reservations reservation
        ON reservation.run_id = r.run_id AND reservation.execution_attempt = $2
      JOIN review_pr_lifecycles l ON l.lifecycle_id = reservation.lifecycle_id
      WHERE r.run_id = $1 AND outbox.worker_token_digest = $3 AND r.status IN ('queued', 'running')
        AND r.cancel_requested_at IS NULL AND r.cancel_propagated_at IS NULL
        AND outbox.status = 'projected' AND outbox.cancel_requested_at IS NULL AND outbox.cancel_propagated_at IS NULL
        AND reservation.status = 'reserved'
        AND r.repository_id = l.repository_id AND r.owner = l.owner AND r.repo = l.repo AND r.pr_number = l.pr_number
        AND r.head_sha = reservation.head_sha AND r.base_sha = reservation.base_sha
        AND r.effective_policy_digest = reservation.policy_digest AND r.effective_config_digest = reservation.config_digest
        AND r.snapshot_digest = reservation.context_digest
    ), captured AS MATERIALIZED (
      SELECT admitted.*,
        ARRAY(SELECT event.event_id FROM review_pr_lifecycle_events event
          WHERE event.lifecycle_id = admitted.lifecycle_id
          ORDER BY event.created_at DESC, event.event_id DESC LIMIT ${MAX_CAPTURED_HISTORY_IDS}) AS event_ids,
        (SELECT COUNT(*)::integer FROM review_pr_lifecycle_events event
          WHERE event.lifecycle_id = admitted.lifecycle_id) AS event_total_count,
        ARRAY(SELECT finding.finding_event_id FROM review_semantic_finding_events finding
          WHERE finding.lifecycle_id = admitted.lifecycle_id
          ORDER BY finding.created_at DESC, finding.finding_event_id DESC LIMIT ${MAX_CAPTURED_HISTORY_IDS}) AS finding_ids,
        (SELECT COUNT(*)::integer FROM review_semantic_finding_events finding
          WHERE finding.lifecycle_id = admitted.lifecycle_id) AS finding_total_count,
        (SELECT COUNT(*)::integer FROM review_runs legacy
          LEFT JOIN review_worker_completions completion ON completion.run_id = legacy.run_id
          LEFT JOIN review_pr_review_reservations prior_reservation
            ON prior_reservation.run_id = completion.run_id
           AND prior_reservation.execution_attempt = completion.execution_attempt
          WHERE legacy.repository_id = admitted.repository_id AND legacy.owner = admitted.owner
            AND legacy.repo = admitted.repo AND legacy.pr_number = admitted.pr_number
            AND ((completion.execution_attempt IS NULL AND NOT EXISTS (
                   SELECT 1 FROM review_pr_review_reservations current_reservation
                   WHERE current_reservation.run_id = legacy.run_id))
              OR (completion.execution_attempt IS NOT NULL AND prior_reservation.reservation_id IS NULL)))
          AS legacy_omitted_count
      FROM admitted
    )
    INSERT INTO review_pr_lifecycle_history_snapshots (
      snapshot_id, run_id, execution_attempt, lifecycle_id, repository_id, owner, repo, pr_number,
      head_sha, base_sha, policy_digest, config_digest, context_digest, event_ids, finding_ids,
      event_total_count, finding_total_count, event_omitted_count, finding_omitted_count,
      legacy_omitted_count, created_at, expires_at)
    SELECT $4, run_id, execution_attempt, lifecycle_id, repository_id, owner, repo, pr_number,
      head_sha, base_sha, policy_digest, config_digest, context_digest, event_ids, finding_ids,
      event_total_count, finding_total_count,
      GREATEST(0, event_total_count - cardinality(event_ids)),
      GREATEST(0, finding_total_count - cardinality(finding_ids)),
      legacy_omitted_count, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + ($5::integer * INTERVAL '1 millisecond')
    FROM captured
    RETURNING *`, [input.runId, input.executionAttempt, input.workerTokenDigest, snapshotId, HISTORY_SNAPSHOT_TTL_MS]);
  const row = result.rows[0];
  if (!row) return { status: 'unavailable' };
  const eventIds = stringArray(row.event_ids);
  const findingIds = stringArray(row.finding_ids);
  return { status: 'ok', snapshot: {
    snapshotId: String(row.snapshot_id), runId: String(row.run_id), executionAttempt: Number(row.execution_attempt),
    repositoryId: Number(row.repository_id), owner: String(row.owner), repo: String(row.repo), prNumber: Number(row.pr_number),
    headSha: String(row.head_sha), baseSha: String(row.base_sha), policyDigest: String(row.policy_digest),
    configDigest: String(row.config_digest), contextDigest: String(row.context_digest),
    eventCount: Number(row.event_total_count), findingCount: Number(row.finding_total_count),
    eventOmittedCount: Number(row.event_omitted_count), findingOmittedCount: Number(row.finding_omitted_count),
    legacyOmittedCount: Number(row.legacy_omitted_count),
    eventsDigest: sha256(canonicalJson(eventIds)), findingsDigest: sha256(canonicalJson(findingIds)),
    expiresAt: new Date(row.expires_at).toISOString(),
  } };
}

/** Read one page from the immutable ID set captured for this still-authorized exact run. */
export async function readPrLifecycleHistorySnapshotPage(client: ReviewLifecycleQueryable, input: {
  runId: string;
  executionAttempt: number;
  workerTokenDigest: string;
  snapshotId: string;
  collection: PrLifecycleHistoryCollection;
  offset: number;
  limit: number;
}): Promise<PrLifecycleHistorySnapshotPageResult> {
  if (!/^run_[a-f0-9]{32}$/u.test(input.runId) || !Number.isSafeInteger(input.executionAttempt)
    || input.executionAttempt < 1 || !validDigest(input.workerTokenDigest)
    || !uuid(input.snapshotId) || !['events', 'findings'].includes(input.collection)
    || !Number.isSafeInteger(input.offset) || input.offset < 0
    || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 250) return { status: 'not_found' };
  if (!await historyExecutionAuthorized(client, input)) return { status: 'unauthorized' };
  const column = input.collection === 'events' ? 'event_ids' : 'finding_ids';
  const idColumn = input.collection === 'events' ? 'event_id' : 'finding_event_id';
  const relation = input.collection === 'events' ? 'review_pr_lifecycle_events' : 'review_semantic_finding_events';
  const totalColumn = input.collection === 'events' ? 'event_total_count' : 'finding_total_count';
  const omittedColumn = input.collection === 'events' ? 'event_omitted_count' : 'finding_omitted_count';
  const snapshot = (await client.query(`SELECT snapshot.snapshot_id, snapshot.lifecycle_id, snapshot.${column} AS captured_ids,
      snapshot.${totalColumn} AS total_count, snapshot.${omittedColumn} AS omitted_count
    FROM review_pr_lifecycle_history_snapshots snapshot
    JOIN review_runs target ON target.run_id = snapshot.run_id
    JOIN review_dispatch_outbox outbox ON outbox.run_id = target.run_id
      AND outbox.execution_attempt + 1 = snapshot.execution_attempt
    JOIN review_pr_review_reservations reservation ON reservation.run_id = snapshot.run_id
      AND reservation.execution_attempt = snapshot.execution_attempt
    JOIN review_pr_lifecycles lifecycle ON lifecycle.lifecycle_id = reservation.lifecycle_id
    WHERE snapshot.snapshot_id = $1 AND snapshot.run_id = $2 AND snapshot.execution_attempt = $3
      AND snapshot.expires_at > CURRENT_TIMESTAMP AND outbox.worker_token_digest = $4
      AND target.status IN ('queued', 'running') AND target.cancel_requested_at IS NULL AND target.cancel_propagated_at IS NULL
      AND outbox.status = 'projected' AND outbox.cancel_requested_at IS NULL AND outbox.cancel_propagated_at IS NULL
      AND reservation.status = 'reserved' AND reservation.lifecycle_id = snapshot.lifecycle_id
      AND target.repository_id = lifecycle.repository_id AND target.owner = lifecycle.owner
      AND target.repo = lifecycle.repo AND target.pr_number = lifecycle.pr_number
      AND target.head_sha = snapshot.head_sha AND target.base_sha = snapshot.base_sha
      AND target.effective_policy_digest = snapshot.policy_digest
      AND target.effective_config_digest = snapshot.config_digest AND target.snapshot_digest = snapshot.context_digest
      AND reservation.head_sha = snapshot.head_sha AND reservation.base_sha = snapshot.base_sha
      AND reservation.policy_digest = snapshot.policy_digest AND reservation.config_digest = snapshot.config_digest
      AND reservation.context_digest = snapshot.context_digest`,
  [input.snapshotId, input.runId, input.executionAttempt, input.workerTokenDigest])).rows[0];
  if (!snapshot) return { status: 'not_found' };
  const page = await client.query(`
    SELECT item.* FROM unnest($1::uuid[]) WITH ORDINALITY captured(item_id, ordinal)
    JOIN ${relation} item ON item.${idColumn} = captured.item_id
    WHERE item.lifecycle_id = $2 AND captured.ordinal > $3 AND captured.ordinal <= $4
    ORDER BY captured.ordinal`, [snapshot.captured_ids, snapshot.lifecycle_id, input.offset, input.offset + input.limit]);
  const totalCount = Number(snapshot.total_count);
  const capturedCount = Math.max(0, totalCount - Number(snapshot.omitted_count));
  const nextOffset = input.offset + page.rows.length;
  return { status: 'ok', snapshotId: input.snapshotId, collection: input.collection,
    offset: input.offset, limit: input.limit, totalCount, capturedCount, rows: page.rows,
    hasMore: nextOffset < capturedCount, nextOffset: nextOffset < capturedCount ? nextOffset : null };
}

export interface ReviewPrLifecycleIdentity {
  repositoryId: number;
  owner: string;
  repo: string;
  prNumber: number;
}

export interface ReviewPrReservationInput extends ReviewPrLifecycleIdentity {
  runId: string;
  executionAttempt: number;
  deliveryId: string;
  headSha: string;
  baseSha: string;
  policyDigest: string;
  configDigest: string;
  contextDigest: string;
  at?: number;
}

export type ReviewReservationStatus = 'reserved' | 'completed' | 'failed' | 'cancelled' | 'superseded';
export type IndependentVerificationStatus = 'confirmed' | 'contradicted' | 'insufficient';

export interface ReviewSemanticFindingInput {
  fingerprint: string;
  path: string;
  line?: number;
  severity: string;
  sourceSeverity?: string;
  disposition: string;
  blocking: boolean;
  affectedContextDigest: string;
  sourceEvidence: unknown;
  provenance?: Record<string, unknown>;
  independentVerification?: {
    status: IndependentVerificationStatus;
    verifier: string;
    evidenceDigest: string;
    evidence: unknown;
  };
}

export interface ReviewLifecycleReservation {
  lifecycleId: string;
  reservationId: string;
  created: boolean;
  status: ReviewReservationStatus;
}

function validDigest(value: string): boolean { return /^[a-f0-9]{64}$/u.test(value); }
function validSha(value: string): boolean { return /^[a-f0-9]{40}$/u.test(value); }

function requireReservationInput(input: ReviewPrReservationInput): void {
  if (!Number.isSafeInteger(input.repositoryId) || input.repositoryId <= 0
    || !Number.isSafeInteger(input.prNumber) || input.prNumber <= 0
    || !Number.isSafeInteger(input.executionAttempt) || input.executionAttempt <= 0
    || !input.owner || !input.repo || !input.runId || !input.deliveryId
    || !validSha(input.headSha) || !validSha(input.baseSha)
    || !validDigest(input.policyDigest) || !validDigest(input.configDigest) || !validDigest(input.contextDigest)
    || (input.at !== undefined && !Number.isFinite(input.at))) {
    throw new Error('Invalid semantic review reservation identity');
  }
}

async function ensureLifecycle(client: ReviewLifecycleQueryable, input: ReviewPrLifecycleIdentity, at: number): Promise<string> {
  if (!Number.isSafeInteger(input.repositoryId) || input.repositoryId <= 0
    || !Number.isSafeInteger(input.prNumber) || input.prNumber <= 0 || !input.owner || !input.repo) {
    throw new Error('Invalid pull request lifecycle identity');
  }
  const result = await client.query(`INSERT INTO review_pr_lifecycles
      (lifecycle_id, repository_id, owner, repo, pr_number, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0), to_timestamp($6 / 1000.0))
    ON CONFLICT (repository_id, pr_number) DO UPDATE
      SET updated_at = GREATEST(review_pr_lifecycles.updated_at, EXCLUDED.updated_at)
    RETURNING lifecycle_id, owner, repo`,
  [randomUUID(), input.repositoryId, input.owner, input.repo, input.prNumber, at]);
  const row = result.rows[0];
  if (!row || row.owner !== input.owner || row.repo !== input.repo) {
    throw new Error('Pull request lifecycle identity conflicts with its repository binding');
  }
  return String(row.lifecycle_id);
}

async function appendLifecycleEvent(client: ReviewLifecycleQueryable, input: {
  lifecycleId: string;
  reservationId?: string;
  idempotencyKey: string;
  eventType: string;
  identity: ReviewPrLifecycleIdentity;
  runId?: string;
  executionAttempt?: number;
  headSha?: string;
  baseSha?: string;
  policyDigest?: string;
  configDigest?: string;
  contextDigest?: string;
  evidenceDigest?: string;
  actorDigest?: string;
  verificationStatus?: IndependentVerificationStatus;
  payload: unknown;
  at: number;
}): Promise<void> {
  const payloadDigest = sha256(canonicalJson(input.payload));
  const inserted = await client.query(`INSERT INTO review_pr_lifecycle_events
      (event_id, lifecycle_id, reservation_id, idempotency_key, event_type, run_id, execution_attempt,
       repository_id, pr_number, head_sha, base_sha, policy_digest, config_digest, context_digest,
       evidence_digest, actor_digest, verification_status, payload, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
       $18::jsonb, to_timestamp($19 / 1000.0))
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING event_id`,
  [randomUUID(), input.lifecycleId, input.reservationId ?? null, input.idempotencyKey, input.eventType,
    input.runId ?? null, input.executionAttempt ?? null, input.identity.repositoryId, input.identity.prNumber,
    input.headSha ?? null, input.baseSha ?? null, input.policyDigest ?? null, input.configDigest ?? null,
    input.contextDigest ?? null, input.evidenceDigest ?? payloadDigest, input.actorDigest ?? null,
    input.verificationStatus ?? 'insufficient', JSON.stringify(input.payload), input.at]);
  if (inserted.rows.length > 0) return;
  const prior = (await client.query(`SELECT event_type, lifecycle_id, evidence_digest, payload
    FROM review_pr_lifecycle_events WHERE idempotency_key = $1`, [input.idempotencyKey])).rows[0];
  if (!prior || prior.event_type !== input.eventType || prior.lifecycle_id !== input.lifecycleId
    || prior.evidence_digest !== (input.evidenceDigest ?? payloadDigest)
    || canonicalJson(typeof prior.payload === 'string' ? JSON.parse(prior.payload) : prior.payload)
      !== canonicalJson(input.payload)) {
    throw new Error('Lifecycle event idempotency key conflicts with previously recorded evidence');
  }
}

/**
 * Called from the PR-locked webhook admission transaction. The database
 * uniqueness constraints make concurrent deliveries converge on one lifecycle
 * and one reservation for the exact run attempt.
 */
export async function reservePrReview(
  client: ReviewLifecycleQueryable,
  input: ReviewPrReservationInput,
): Promise<ReviewLifecycleReservation> {
  requireReservationInput(input);
  const at = input.at ?? Date.now();
  const identity: ReviewPrLifecycleIdentity = {
    repositoryId: input.repositoryId, owner: input.owner, repo: input.repo, prNumber: input.prNumber,
  };
  const lifecycleId = await ensureLifecycle(client, identity, at);
  const reservationId = randomUUID();
  const inserted = await client.query(`INSERT INTO review_pr_review_reservations
      (reservation_id, lifecycle_id, run_id, execution_attempt, delivery_id, head_sha, base_sha,
       policy_digest, config_digest, context_digest, status, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'reserved',
       to_timestamp($11 / 1000.0), to_timestamp($11 / 1000.0))
    ON CONFLICT (run_id, execution_attempt) DO NOTHING
    RETURNING reservation_id, status`,
  [reservationId, lifecycleId, input.runId, input.executionAttempt, input.deliveryId, input.headSha,
    input.baseSha, input.policyDigest, input.configDigest, input.contextDigest, at]);
  const row = (await client.query(`SELECT reservation_id, lifecycle_id, delivery_id,
      head_sha, base_sha, policy_digest, config_digest, context_digest, status
    FROM review_pr_review_reservations WHERE run_id = $1 AND execution_attempt = $2 FOR UPDATE`,
  [input.runId, input.executionAttempt])).rows[0];
  if (!row || row.lifecycle_id !== lifecycleId || row.head_sha !== input.headSha || row.base_sha !== input.baseSha
    || row.policy_digest !== input.policyDigest || row.config_digest !== input.configDigest
    || row.context_digest !== input.contextDigest) {
    throw new Error('Review reservation conflicts with its immutable exact-head identity');
  }
  const actualReservationId = String(row.reservation_id);
  const created = inserted.rows.length > 0;
  if (created) {
    await appendLifecycleEvent(client, {
      lifecycleId, reservationId: actualReservationId, idempotencyKey: `${actualReservationId}:reserved`,
      eventType: 'review.reserved', identity, runId: input.runId, executionAttempt: input.executionAttempt,
      headSha: input.headSha, baseSha: input.baseSha, policyDigest: input.policyDigest,
      configDigest: input.configDigest, contextDigest: input.contextDigest,
      payload: { deliveryId: input.deliveryId }, at,
    });
  }
  return { lifecycleId, reservationId: actualReservationId, created, status: row.status as ReviewReservationStatus };
}

/** Terminal state is mutable projection; every transition is separately retained as an immutable event. */
export async function transitionPrReviewReservation(client: ReviewLifecycleQueryable, input: {
  runId: string;
  executionAttempt: number;
  status: Exclude<ReviewReservationStatus, 'reserved'>;
  reason?: string;
  completionDigest?: string;
  decisionReceipt?: unknown;
  at?: number;
}): Promise<void> {
  if (!input.runId || !Number.isSafeInteger(input.executionAttempt) || input.executionAttempt <= 0
    || (input.completionDigest !== undefined && !validDigest(input.completionDigest))) {
    throw new Error('Invalid review reservation transition');
  }
  const at = input.at ?? Date.now();
  const result = await client.query(`UPDATE review_pr_review_reservations
      SET status = $3, completion_digest = COALESCE($4, completion_digest),
          decision_receipt = COALESCE($5::jsonb, decision_receipt),
          completed_at = COALESCE(completed_at, to_timestamp($6 / 1000.0)),
          updated_at = to_timestamp($6 / 1000.0)
    WHERE run_id = $1 AND execution_attempt = $2 AND (status = 'reserved' OR status = $3)
    RETURNING lifecycle_id, reservation_id, head_sha, base_sha,
      policy_digest, config_digest, context_digest`,
  [input.runId, input.executionAttempt, input.status, input.completionDigest ?? null,
    input.decisionReceipt === undefined ? null : JSON.stringify(input.decisionReceipt), at]);
  let row = result.rows[0];
  if (!row) {
    const prior = (await client.query(`SELECT status FROM review_pr_review_reservations
      WHERE run_id = $1 AND execution_attempt = $2`, [input.runId, input.executionAttempt])).rows[0];
    if (!prior) return; // Legacy run admitted before this additive ledger existed.
    throw new Error(`Review reservation cannot transition from ${prior.status} to ${input.status}`);
  }
  const identity = (await client.query(`SELECT repository_id, owner, repo, pr_number
    FROM review_pr_lifecycles WHERE lifecycle_id = $1`, [row.lifecycle_id])).rows[0];
  if (!identity) throw new Error('Review reservation has no pull request lifecycle');
  const decision = input.decisionReceipt ?? null;
  const evidenceDigest = input.completionDigest ?? sha256(canonicalJson({ status: input.status, reason: input.reason ?? null, decision }));
  await appendLifecycleEvent(client, {
    lifecycleId: String(row.lifecycle_id), reservationId: String(row.reservation_id),
    idempotencyKey: `${row.reservation_id}:${input.status}`, eventType: `review.${input.status}`,
    identity: { repositoryId: Number(identity.repository_id), owner: String(identity.owner),
      repo: String(identity.repo), prNumber: Number(identity.pr_number) },
    runId: input.runId, executionAttempt: input.executionAttempt,
    headSha: row.head_sha, baseSha: row.base_sha, policyDigest: row.policy_digest,
    configDigest: row.config_digest, contextDigest: row.context_digest, evidenceDigest,
    payload: { reason: input.reason ?? null, decisionReceipt: decision }, at,
  });
}

export async function releaseActivePrReviewReservations(client: ReviewLifecycleQueryable, input: {
  runId: string;
  status: 'cancelled' | 'superseded' | 'failed';
  reason: string;
  at?: number;
}): Promise<void> {
  const reservations = await client.query(`SELECT execution_attempt FROM review_pr_review_reservations
    WHERE run_id = $1 AND status = 'reserved' ORDER BY execution_attempt FOR UPDATE`, [input.runId]);
  for (const row of reservations.rows) {
    await transitionPrReviewReservation(client, {
      runId: input.runId, executionAttempt: Number(row.execution_attempt), status: input.status,
      reason: input.reason, at: input.at,
    });
  }
}

/** Append exact trusted completion and semantic finding history in the same transaction as the Gate decision. */
export async function recordTrustedPrReviewCompletion(client: ReviewLifecycleQueryable, input: {
  runId: string;
  executionAttempt: number;
  status: 'completed' | 'failed' | 'cancelled';
  completionDigest: string;
  decisionReceipt: unknown;
  findings: readonly ReviewSemanticFindingInput[];
  satisfiedRecheckRequestIds?: readonly string[];
  at?: number;
}): Promise<void> {
  if (!validDigest(input.completionDigest)) throw new Error('Invalid trusted completion digest');
  await transitionPrReviewReservation(client, {
    runId: input.runId, executionAttempt: input.executionAttempt,
    status: input.status, completionDigest: input.completionDigest,
    decisionReceipt: input.decisionReceipt, at: input.at,
  });
  const reservation = (await client.query(`SELECT r.reservation_id, r.lifecycle_id, l.repository_id,
      l.pr_number, r.head_sha, r.base_sha, r.policy_digest, r.config_digest, r.context_digest,
      l.owner, l.repo
    FROM review_pr_review_reservations r JOIN review_pr_lifecycles l USING (lifecycle_id)
    WHERE r.run_id = $1 AND r.execution_attempt = $2`,
  [input.runId, input.executionAttempt])).rows[0];
  if (!reservation) return; // Preserve pre-migration completion behavior for an old run.
  const identity = { repositoryId: Number(reservation.repository_id), prNumber: Number(reservation.pr_number),
    owner: String(reservation.owner), repo: String(reservation.repo) };
  await appendLifecycleEvent(client, {
    lifecycleId: String(reservation.lifecycle_id), reservationId: String(reservation.reservation_id),
    idempotencyKey: `${reservation.reservation_id}:completion:${input.completionDigest}`,
    eventType: 'review.completion_recorded', identity, runId: input.runId,
    executionAttempt: input.executionAttempt, headSha: reservation.head_sha, baseSha: reservation.base_sha,
    policyDigest: reservation.policy_digest, configDigest: reservation.config_digest,
    contextDigest: reservation.context_digest, evidenceDigest: input.completionDigest,
    payload: { status: input.status, decisionReceipt: input.decisionReceipt }, at: input.at ?? Date.now(),
  });

  const satisfiedRecheckRequestIds = [...new Set(input.satisfiedRecheckRequestIds ?? [])].sort();
  if (satisfiedRecheckRequestIds.length > 0) {
    if (satisfiedRecheckRequestIds.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id))) {
      throw new Error('Invalid satisfied finding recheck receipt id');
    }
    await appendLifecycleEvent(client, {
      lifecycleId: String(reservation.lifecycle_id), reservationId: String(reservation.reservation_id),
      idempotencyKey: `${reservation.reservation_id}:rechecks-satisfied:${input.completionDigest}`,
      eventType: 'finding.rechecks_satisfied', identity, runId: input.runId,
      executionAttempt: input.executionAttempt, headSha: reservation.head_sha, baseSha: reservation.base_sha,
      policyDigest: reservation.policy_digest, configDigest: reservation.config_digest,
      contextDigest: reservation.context_digest, evidenceDigest: input.completionDigest,
      payload: { requestIds: satisfiedRecheckRequestIds }, at: input.at ?? Date.now(),
    });
  }

  for (const finding of input.findings) {
    if (!finding.fingerprint || !finding.path || !finding.severity || !finding.disposition
      || !validDigest(finding.affectedContextDigest)) throw new Error('Invalid semantic finding history event');
    const verification = finding.independentVerification;
    if (verification && (!verification.verifier || !validDigest(verification.evidenceDigest)
      || verification.status !== 'confirmed' && verification.status !== 'contradicted' && verification.status !== 'insufficient')) {
      throw new Error('Invalid semantic finding verification evidence');
    }
    const evidenceDigest = sha256(canonicalJson(finding.sourceEvidence));
    const first = (await client.query(`SELECT first_seen_head FROM review_semantic_finding_events
      WHERE lifecycle_id = $1 AND fingerprint = $2
      ORDER BY created_at, finding_event_id LIMIT 1`, [reservation.lifecycle_id, finding.fingerprint])).rows[0];
    const firstSeenHead = first?.first_seen_head ?? reservation.head_sha;
    const findingEventId = randomUUID();
    const eventKey = `${reservation.reservation_id}:finding:${finding.fingerprint}`;
    const inserted = await client.query(`INSERT INTO review_semantic_finding_events
        (finding_event_id, lifecycle_id, reservation_id, event_key, run_id, execution_attempt,
         fingerprint, path, region_start, region_end, first_seen_head, last_seen_head,
         affected_context_digest, source_severity, effective_severity, disposition, blocking, verification_status,
         evidence_digest, source_evidence, provenance)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
         $19, $20::jsonb, $21::jsonb)
      ON CONFLICT (event_key) DO NOTHING RETURNING finding_event_id`,
    [findingEventId, reservation.lifecycle_id, reservation.reservation_id, eventKey, input.runId,
      input.executionAttempt, finding.fingerprint, finding.path, finding.line ?? null, finding.line ?? null,
      firstSeenHead, reservation.head_sha, finding.affectedContextDigest, finding.sourceSeverity ?? finding.severity,
      finding.severity, finding.disposition, finding.blocking, verification?.status ?? 'insufficient', evidenceDigest,
      JSON.stringify(finding.sourceEvidence), JSON.stringify(finding.provenance ?? {})]);
    let persistedFindingEventId = inserted.rows[0]?.finding_event_id;
    if (inserted.rows.length === 0) {
      const prior = (await client.query(`SELECT finding_event_id, evidence_digest, affected_context_digest, disposition, verification_status
        FROM review_semantic_finding_events WHERE event_key = $1`, [eventKey])).rows[0];
      if (!prior || prior.evidence_digest !== evidenceDigest
        || prior.affected_context_digest !== finding.affectedContextDigest || prior.disposition !== finding.disposition
        || prior.verification_status !== (verification?.status ?? 'insufficient')) {
        throw new Error('Semantic finding event key conflicts with previously recorded evidence');
      }
      persistedFindingEventId = prior.finding_event_id;
    }
    if (verification) {
      if (!persistedFindingEventId) throw new Error('Semantic finding verification has no persisted source event');
      await recordIndependentFindingVerification(client, {
        findingEventId: String(persistedFindingEventId), status: verification.status, verifier: verification.verifier,
        evidenceDigest: verification.evidenceDigest, contextDigest: finding.affectedContextDigest,
        evidence: verification.evidence, at: input.at,
      });
    }
  }
}

/**
 * Record the existing authenticated, permission-checked MCP recheck request.
 * The caller identifier is hashed by the caller path; this method never accepts
 * an actor identity from a tool payload.
 */
export async function recordPrFindingRecheckRequest(client: ReviewLifecycleQueryable, input: {
  runId: string;
  sourceExecutionAttempt: number;
  requestId: string;
  findingId: string;
  actorDigest: string;
  sourceContentDigest: string;
  sourceContextDigest: string;
  requestDigest: string;
  at?: number;
}): Promise<void> {
  if (!/^[a-f0-9]{64}$/u.test(input.actorDigest) || !validDigest(input.sourceContentDigest)
    || !validDigest(input.sourceContextDigest) || !validDigest(input.requestDigest)) {
    throw new Error('Invalid authenticated finding recheck provenance');
  }
  const reservation = (await client.query(`SELECT r.reservation_id, r.lifecycle_id, l.repository_id, l.pr_number,
      r.head_sha, r.base_sha, r.policy_digest, r.config_digest, r.context_digest, l.owner, l.repo
    FROM review_pr_review_reservations r JOIN review_pr_lifecycles l USING (lifecycle_id)
    WHERE r.run_id = $1 AND r.execution_attempt = $2`, [input.runId, input.sourceExecutionAttempt])).rows[0];
  if (!reservation) return; // Legacy source completions remain usable; their own recheck ledger is still authoritative.
  await appendLifecycleEvent(client, {
    lifecycleId: String(reservation.lifecycle_id), reservationId: String(reservation.reservation_id),
    idempotencyKey: `${input.requestId}:recheck-requested`, eventType: 'finding.recheck_requested',
    identity: { repositoryId: Number(reservation.repository_id), owner: String(reservation.owner),
      repo: String(reservation.repo), prNumber: Number(reservation.pr_number) },
    runId: input.runId, executionAttempt: input.sourceExecutionAttempt,
    headSha: reservation.head_sha, baseSha: reservation.base_sha, policyDigest: reservation.policy_digest,
    configDigest: reservation.config_digest, contextDigest: input.sourceContextDigest,
    evidenceDigest: input.requestDigest, actorDigest: input.actorDigest,
    payload: { requestId: input.requestId, findingId: input.findingId,
      sourceContentDigest: input.sourceContentDigest, sourceReservationContextDigest: reservation.context_digest },
    at: input.at ?? Date.now(),
  });
}

/**
 * Reserve the exact execution admitted by an authenticated finding recheck.
 * The caller holds the PR transaction lock and writes this together with the
 * recheck admission. Its immutable target identity uses the same candidate
 * snapshot digest later supplied by dispatch and trusted completion.
 */
export async function reservePrFindingRecheckTarget(client: ReviewLifecycleQueryable, input: {
  repositoryId: number;
  owner: string;
  repo: string;
  prNumber: number;
  runId: string;
  deliveryId: string;
  sourceExecutionAttempt: number;
  executionAttempt: number;
  requestId: string;
  requestDigest: string;
  sourceContentDigest: string;
  sourceContextDigest: string;
  headSha: string;
  baseSha: string;
  policyDigest: string;
  configDigest: string;
  candidateContextDigest: string;
  actorDigest: string;
  at?: number;
}): Promise<ReviewLifecycleReservation> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(input.requestId)
    || !Number.isSafeInteger(input.sourceExecutionAttempt) || input.sourceExecutionAttempt < 1
    || input.executionAttempt !== input.sourceExecutionAttempt + 1
    || !validDigest(input.requestDigest) || !validDigest(input.sourceContentDigest)
    || !validDigest(input.sourceContextDigest) || input.sourceContextDigest !== input.candidateContextDigest
    || !/^[a-f0-9]{64}$/u.test(input.actorDigest)) {
    throw new Error('Invalid finding recheck target reservation evidence');
  }
  const at = input.at ?? Date.now();
  const reservation = await reservePrReview(client, {
    repositoryId: input.repositoryId, owner: input.owner, repo: input.repo, prNumber: input.prNumber,
    runId: input.runId, executionAttempt: input.executionAttempt, deliveryId: input.deliveryId,
    headSha: input.headSha, baseSha: input.baseSha, policyDigest: input.policyDigest,
    configDigest: input.configDigest, contextDigest: input.candidateContextDigest, at,
  });
  await appendLifecycleEvent(client, {
    lifecycleId: reservation.lifecycleId, reservationId: reservation.reservationId,
    idempotencyKey: `${input.requestId}:recheck-target-admitted`,
    eventType: 'finding.recheck_target_admitted',
    identity: { repositoryId: input.repositoryId, owner: input.owner, repo: input.repo, prNumber: input.prNumber },
    runId: input.runId, executionAttempt: input.executionAttempt,
    headSha: input.headSha, baseSha: input.baseSha, policyDigest: input.policyDigest,
    configDigest: input.configDigest, contextDigest: input.candidateContextDigest,
    evidenceDigest: input.requestDigest, actorDigest: input.actorDigest,
    payload: {
      requestId: input.requestId, requestDigest: input.requestDigest,
      sourceRunId: input.runId, sourceExecutionAttempt: input.sourceExecutionAttempt,
      sourceCompletionDigest: input.sourceContentDigest,
      sourceContextDigest: input.sourceContextDigest,
      targetExecutionAttempt: input.executionAttempt,
      candidate: { headSha: input.headSha, baseSha: input.baseSha,
        policyDigest: input.policyDigest, configDigest: input.configDigest,
        contextDigest: input.candidateContextDigest },
    },
    at,
  });
  return reservation;
}

/** Add a separately evidenced finding verification decision without mutating the source finding row. */
export async function recordIndependentFindingVerification(client: ReviewLifecycleQueryable, input: {
  findingEventId: string;
  status: IndependentVerificationStatus;
  verifier: string;
  evidenceDigest: string;
  contextDigest: string;
  evidence: unknown;
  at?: number;
}): Promise<void> {
  if (!input.verifier || !validDigest(input.evidenceDigest) || !validDigest(input.contextDigest)) {
    throw new Error('Invalid independent finding verification evidence');
  }
  const source = (await client.query(`SELECT f.*, l.repository_id, l.pr_number, l.owner, l.repo
    FROM review_semantic_finding_events f JOIN review_pr_lifecycles l USING (lifecycle_id)
    WHERE finding_event_id = $1`, [input.findingEventId])).rows[0];
  if (!source || source.affected_context_digest !== input.contextDigest) {
    throw new Error('Finding verification does not match the source context');
  }
  const payload = { findingEventId: input.findingEventId, fingerprint: source.fingerprint,
    verifier: input.verifier, status: input.status, evidence: input.evidence };
  await appendLifecycleEvent(client, {
    lifecycleId: String(source.lifecycle_id), reservationId: String(source.reservation_id),
    idempotencyKey: `${input.findingEventId}:verification:${input.evidenceDigest}`,
    eventType: 'finding.independent_verification',
    identity: { repositoryId: Number(source.repository_id), owner: String(source.owner),
      repo: String(source.repo), prNumber: Number(source.pr_number) },
    runId: String(source.run_id), executionAttempt: Number(source.execution_attempt),
    headSha: String(source.last_seen_head), contextDigest: input.contextDigest,
    evidenceDigest: input.evidenceDigest, verificationStatus: input.status, payload,
    at: input.at ?? Date.now(),
  });
}

/**
 * Store an independently retrieved verification for a current admitted run. Unlike a historical
 * source-context receipt, this path binds both ends: the historical finding must belong to the same
 * lifecycle, and the verifier's current-context digest must match the exact target reservation.
 * The independently computed affected-source digest is retained in the immutable payload; a later
 * head can only reuse it after its own verifier has established the same affected context.
 */
export async function recordCurrentPrFindingVerification(client: ReviewLifecycleQueryable, input: {
  findingEventId: string;
  snapshotId: string;
  runId: string;
  executionAttempt: number;
  workerTokenDigest: string;
  status: IndependentVerificationStatus;
  currentContextDigest: string;
  currentAffectedContextDigest: string;
  evidenceDigest: string;
  evidence: unknown;
  at?: number;
}): Promise<'unauthorized' | 'not_found' | 'stale_context' | 'recorded'> {
  if (!uuid(input.findingEventId) || !uuid(input.snapshotId) || !/^run_[a-f0-9]{32}$/u.test(input.runId)
    || !Number.isSafeInteger(input.executionAttempt) || input.executionAttempt < 1
    || !validDigest(input.workerTokenDigest) || !validDigest(input.currentContextDigest)
    || !validDigest(input.currentAffectedContextDigest) || !validDigest(input.evidenceDigest)
    || !['confirmed', 'contradicted', 'insufficient'].includes(input.status)) return 'not_found';
  if (!await historyExecutionAuthorized(client, input)) return 'unauthorized';
  const binding = (await client.query(`SELECT current_reservation.reservation_id AS target_reservation_id,
      current_reservation.lifecycle_id AS target_lifecycle_id,
      current_reservation.head_sha AS target_head_sha, current_reservation.base_sha AS target_base_sha,
      current_reservation.policy_digest AS target_policy_digest, current_reservation.config_digest AS target_config_digest,
      current_reservation.context_digest AS target_context_digest,
      target.repository_id AS target_repository_id, target.owner AS target_owner,
      target.repo AS target_repo, target.pr_number AS target_pr_number,
      source.finding_event_id, source.fingerprint, source.affected_context_digest AS source_affected_context_digest,
      source.lifecycle_id AS source_lifecycle_id, source.reservation_id AS source_reservation_id,
      source_lifecycle.repository_id AS source_repository_id, source_lifecycle.owner AS source_owner,
      source_lifecycle.repo AS source_repo, source_lifecycle.pr_number AS source_pr_number
    FROM review_runs target
    JOIN review_dispatch_outbox outbox ON outbox.run_id = target.run_id AND outbox.execution_attempt + 1 = $2
    JOIN review_pr_review_reservations current_reservation
      ON current_reservation.run_id = target.run_id AND current_reservation.execution_attempt = $2
    JOIN review_pr_lifecycles target_lifecycle ON target_lifecycle.lifecycle_id = current_reservation.lifecycle_id
    JOIN review_semantic_finding_events source ON source.finding_event_id = $3
    JOIN review_pr_lifecycles source_lifecycle ON source_lifecycle.lifecycle_id = source.lifecycle_id
    JOIN review_pr_lifecycle_history_snapshots snapshot
      ON snapshot.snapshot_id = $5 AND snapshot.run_id = target.run_id
     AND snapshot.execution_attempt = $2 AND source.finding_event_id = ANY(snapshot.finding_ids)
    WHERE target.run_id = $1 AND target.repository_id = target_lifecycle.repository_id
      AND outbox.worker_token_digest = $6 AND outbox.status = 'projected'
      AND outbox.cancel_requested_at IS NULL AND outbox.cancel_propagated_at IS NULL
      AND target.status IN ('queued', 'running') AND target.cancel_requested_at IS NULL
      AND target.cancel_propagated_at IS NULL AND current_reservation.status = 'reserved'
      AND target.owner = target_lifecycle.owner AND target.repo = target_lifecycle.repo
      AND target.pr_number = target_lifecycle.pr_number
      AND target.head_sha = current_reservation.head_sha AND target.base_sha = current_reservation.base_sha
      AND target.effective_policy_digest = current_reservation.policy_digest
      AND target.effective_config_digest = current_reservation.config_digest
      AND target.snapshot_digest = current_reservation.context_digest
      AND snapshot.lifecycle_id = current_reservation.lifecycle_id
      AND snapshot.head_sha = current_reservation.head_sha AND snapshot.base_sha = current_reservation.base_sha
      AND snapshot.policy_digest = current_reservation.policy_digest
      AND snapshot.config_digest = current_reservation.config_digest
      AND snapshot.context_digest = current_reservation.context_digest AND snapshot.expires_at > CURRENT_TIMESTAMP
      AND current_reservation.context_digest = $4
      AND source.lifecycle_id = current_reservation.lifecycle_id
      AND source_lifecycle.repository_id = target_lifecycle.repository_id
      AND source_lifecycle.owner = target_lifecycle.owner AND source_lifecycle.repo = target_lifecycle.repo
      AND source_lifecycle.pr_number = target_lifecycle.pr_number`,
  [input.runId, input.executionAttempt, input.findingEventId, input.currentContextDigest, input.snapshotId,
    input.workerTokenDigest])).rows[0];
  if (!binding) {
    const target = (await client.query(`SELECT context_digest FROM review_pr_review_reservations
      WHERE run_id = $1 AND execution_attempt = $2`, [input.runId, input.executionAttempt])).rows[0];
    return target ? 'stale_context' : 'not_found';
  }
  const payload = {
    findingEventId: input.findingEventId,
    fingerprint: String(binding.fingerprint),
    verifier: 'independent_grounded_verifier',
    status: input.status,
    sourceAffectedContextDigest: String(binding.source_affected_context_digest),
    currentAffectedContextDigest: input.currentAffectedContextDigest,
    evidenceDigest: input.evidenceDigest,
    evidence: input.evidence,
  };
  const identity = { repositoryId: Number(binding.target_repository_id), owner: String(binding.target_owner),
    repo: String(binding.target_repo), prNumber: Number(binding.target_pr_number) };
  await appendLifecycleEvent(client, {
    lifecycleId: String(binding.target_lifecycle_id), reservationId: String(binding.target_reservation_id),
    idempotencyKey: `${input.findingEventId}:verification:${input.runId}:${input.executionAttempt}:${input.currentAffectedContextDigest}:${input.evidenceDigest}`,
    eventType: 'finding.independent_verification', identity, runId: input.runId,
    executionAttempt: input.executionAttempt, headSha: String(binding.target_head_sha),
    baseSha: String(binding.target_base_sha), policyDigest: String(binding.target_policy_digest),
    configDigest: String(binding.target_config_digest), contextDigest: String(binding.target_context_digest),
    evidenceDigest: input.evidenceDigest, verificationStatus: input.status, payload, at: input.at ?? Date.now(),
  });
  return 'recorded';
}

export async function readPrLifecycleHistory(client: ReviewLifecycleQueryable, identity: ReviewPrLifecycleIdentity,
  options: { offset?: number; limit?: number } = {}) {
  return readPrLifecycleHistoryPage(client, identity, options);
}

/** Paginated WS3-facing view. Legacy completions remain visible as unverified context. */
export async function readPrLifecycleHistoryPage(client: ReviewLifecycleQueryable, identity: ReviewPrLifecycleIdentity,
  options: { offset?: number; limit?: number } = {}) {
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 250) {
    throw new Error('Invalid lifecycle history page bounds');
  }
  const lifecycle = (await client.query(`SELECT * FROM review_pr_lifecycles
    WHERE repository_id = $1 AND pr_number = $2`, [identity.repositoryId, identity.prNumber])).rows[0];
  if (lifecycle && (lifecycle.owner !== identity.owner || lifecycle.repo !== identity.repo)) {
    throw new Error('Pull request lifecycle identity conflicts with its repository binding');
  }
  const [reservations, events, findings, legacyContext] = await Promise.all([
    lifecycle ? client.query(`SELECT * FROM review_pr_review_reservations WHERE lifecycle_id = $1
      ORDER BY created_at, execution_attempt LIMIT $2 OFFSET $3`, [lifecycle.lifecycle_id, limit + 1, offset])
      : Promise.resolve({ rows: [] }),
    lifecycle ? client.query(`SELECT * FROM review_pr_lifecycle_events WHERE lifecycle_id = $1
      ORDER BY created_at, event_id LIMIT $2 OFFSET $3`, [lifecycle.lifecycle_id, limit + 1, offset])
      : Promise.resolve({ rows: [] }),
    lifecycle ? client.query(`SELECT * FROM review_semantic_finding_events WHERE lifecycle_id = $1
      ORDER BY created_at, finding_event_id LIMIT $2 OFFSET $3`, [lifecycle.lifecycle_id, limit + 1, offset])
      : Promise.resolve({ rows: [] }),
    client.query(`SELECT runs.run_id, runs.head_sha, runs.base_sha, runs.effective_policy_digest,
        runs.effective_config_digest, runs.snapshot_digest, runs.status, runs.attempt,
        completion.execution_attempt, completion.content_digest, completion.payload, completion.created_at
      FROM review_runs runs
      LEFT JOIN review_worker_completions completion ON completion.run_id = runs.run_id
      LEFT JOIN review_pr_review_reservations reservation
        ON reservation.run_id = completion.run_id
       AND reservation.execution_attempt = completion.execution_attempt
      WHERE runs.owner = $1 AND runs.repo = $2 AND runs.pr_number = $3
        AND (runs.repository_id IS NULL OR runs.repository_id = $4)
        AND ((completion.execution_attempt IS NULL AND NOT EXISTS (
               SELECT 1 FROM review_pr_review_reservations current_reservation
                WHERE current_reservation.run_id = runs.run_id))
          OR (completion.execution_attempt IS NOT NULL AND reservation.reservation_id IS NULL))
      ORDER BY runs.created_at, completion.execution_attempt NULLS FIRST
      LIMIT $5 OFFSET $6`, [identity.owner, identity.repo, identity.prNumber, identity.repositoryId, limit + 1, offset]),
  ]);
  const page = (result: QueryResult) => ({ rows: result.rows.slice(0, limit), hasMore: result.rows.length > limit });
  const reservationsPage = page(reservations);
  const eventsPage = page(events);
  const findingsPage = page(findings);
  const legacyPage = page(legacyContext);
  const hasMore = reservationsPage.hasMore || eventsPage.hasMore || findingsPage.hasMore || legacyPage.hasMore;
  if (!lifecycle && legacyPage.rows.length === 0) return null;
  return {
    lifecycle: lifecycle ?? null,
    reservations: reservationsPage.rows,
    events: eventsPage.rows,
    findings: findingsPage.rows,
    legacyContext: legacyPage.rows.map((row) => ({ ...row, historySource: 'legacy_archive', verificationStatus: 'insufficient' as const })),
    offset, limit, hasMore, nextOffset: hasMore ? offset + limit : null,
  };
}
