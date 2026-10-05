import { randomUUID } from 'node:crypto';
import { canonicalJson, sha256 } from '../review/reviewCore';

interface QueryResult { rows: any[] }
export interface ReviewLifecycleQueryable {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
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
         affected_context_digest, source_severity, effective_severity, disposition, blocking,
         evidence_digest, source_evidence, provenance)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
         $18, $19::jsonb, $20::jsonb)
      ON CONFLICT (event_key) DO NOTHING RETURNING finding_event_id`,
    [findingEventId, reservation.lifecycle_id, reservation.reservation_id, eventKey, input.runId,
      input.executionAttempt, finding.fingerprint, finding.path, finding.line ?? null, finding.line ?? null,
      firstSeenHead, reservation.head_sha, finding.affectedContextDigest, finding.sourceSeverity ?? finding.severity,
      finding.severity, finding.disposition, finding.blocking, evidenceDigest,
      JSON.stringify(finding.sourceEvidence), JSON.stringify(finding.provenance ?? {})]);
    if (inserted.rows.length === 0) {
      const prior = (await client.query(`SELECT evidence_digest, affected_context_digest, disposition
        FROM review_semantic_finding_events WHERE event_key = $1`, [eventKey])).rows[0];
      if (!prior || prior.evidence_digest !== evidenceDigest
        || prior.affected_context_digest !== finding.affectedContextDigest || prior.disposition !== finding.disposition) {
        throw new Error('Semantic finding event key conflicts with previously recorded evidence');
      }
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
