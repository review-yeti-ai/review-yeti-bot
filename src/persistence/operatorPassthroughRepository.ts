import { randomUUID } from 'node:crypto';
import { canonicalJson, sha256 } from '../review/reviewCore';
import {
  OperatorPassthroughDeliveryIdentityConflictError,
  OperatorPassthroughOperationDeadlineExceededError,
  OperatorPassthroughPersistenceUnavailableError,
  OperatorPassthroughPreflightResetUnconfirmedError,
  assertOperatorPassthroughOperationActive,
  awaitOperatorPassthroughOperation,
  operatorPassthroughOperationRemainingMs,
  operatorPassthroughIdentity,
  operatorPassthroughIdentityForCandidate,
  operatorPassthroughReadyForShip,
  validateOperatorPassthroughEvent,
  type OperatorPassthroughCandidate,
  type OperatorPassthroughCheckStage,
  type OperatorPassthroughCheckState,
  type OperatorPassthroughPublicationClaim,
  type OperatorPassthroughPublicationNotStarted,
  type OperatorPassthroughPublicationRepository,
  type OperatorPassthroughPublicationSnapshot,
  type OperatorPassthroughReconcileAdmission,
  type OperatorPassthroughReconcileCursor,
  type OperatorPassthroughReconcilePending,
  type OperatorPassthroughRetireRequired,
  type OperatorPassthroughRecordInput,
  type OperatorPassthroughRecordResult,
  type OperatorPassthroughOperationScope,
  type StoredOperatorPassthroughPublication,
} from '../review/operatorPassthrough';
import type { OperatorPassthroughCheckCoordinates, ReviewGateCheck } from '../review/reviewCheckIdentity';
import { reviewDispatchPrLockKey } from './reviewCiPersistence';

interface Queryable { query(sql: string, values?: unknown[]): Promise<{ rows: any[] }> }
interface Client extends Queryable { release(error?: Error): void }
interface Pool extends Queryable { connect(): Promise<Client> }

const RETIREMENT_SWEEP_BATCH_SIZE = 25;

const POSITIVE = (value: unknown): number => {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error('Invalid stored operator passthrough integer');
  return result;
};
const nullableNumber = (value: unknown): number | null => value == null ? null : POSITIVE(value);
const timestamp = (value: unknown): number | null => {
  if (value == null) return null;
  const result = value instanceof Date ? value.getTime() : Date.parse(String(value));
  if (!Number.isFinite(result)) throw new Error('Invalid stored operator passthrough timestamp');
  return result;
};
const json = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { throw new Error('Invalid stored operator passthrough coordinates'); }
};
const STATES = new Set<OperatorPassthroughCheckState>(['reserved', 'creating', 'bound', 'not-created']);

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function storedFromRow(row: any): StoredOperatorPassthroughPublication & {
  reviewRetiredAt: number | null; gateRetiredAt: number | null;
} {
  if (!row) throw new Error('Operator passthrough publication row is missing');
  const candidate: OperatorPassthroughCandidate = {
    owner: row.owner, repo: row.repo, repositoryId: POSITIVE(row.repository_id), prNumber: POSITIVE(row.pr_number),
    headSha: row.head_sha, baseSha: row.base_sha, policyDigest: row.policy_digest,
  };
  const expectedAppId = POSITIVE(row.expected_app_id);
  const publicationSequence = POSITIVE(row.publication_sequence);
  const expected = operatorPassthroughIdentityForCandidate(candidate, expectedAppId, publicationSequence);
  if (row.publication_id !== expected.publicationId || row.audit_digest !== expected.auditDigest
    || row.review_external_id !== expected.reviewExternalId || row.gate_external_id !== expected.gateExternalId
    || !same(json(row.coordinates), expected.coordinates)) {
    throw new Error('Stored operator passthrough candidate identity is inconsistent');
  }
  const reviewState = row.review_creation_state as OperatorPassthroughCheckState;
  const gateState = row.gate_creation_state as OperatorPassthroughCheckState;
  const reviewCheckId = nullableNumber(row.review_check_id);
  const gateCheckId = nullableNumber(row.gate_check_id);
  if (!STATES.has(reviewState) || !STATES.has(gateState)
    || (reviewState === 'bound') !== (reviewCheckId !== null)
    || (gateState === 'bound') !== (gateCheckId !== null)
    || (row.retirement_reason !== null && !['pause-disabled', 'normal-review-admitted', 'candidate-changed'].includes(row.retirement_reason))) {
    throw new Error('Stored operator passthrough publication state is inconsistent');
  }
  const retirementRequestedAt = timestamp(row.retirement_requested_at);
  const retirementReason = row.retirement_reason as StoredOperatorPassthroughPublication['retirementReason'];
  if ((retirementRequestedAt === null) !== (retirementReason === null)) {
    throw new Error('Stored operator passthrough retirement identity is inconsistent');
  }
  return {
    publicationId: expected.publicationId,
    publicationSequence,
    coordinates: expected.coordinates,
    expectedAppId,
    auditDigest: expected.auditDigest,
    reviewExternalId: expected.reviewExternalId,
    gateExternalId: expected.gateExternalId,
    reviewCheckId,
    reviewCreationState: reviewState,
    gateCheckId,
    gateCreationState: gateState,
    retirementRequestedAt,
    retirementReason,
    retiredAt: timestamp(row.retired_at),
    reviewRetiredAt: timestamp(row.review_retired_at),
    gateRetiredAt: timestamp(row.gate_retired_at),
  };
}

function stageState(publication: StoredOperatorPassthroughPublication, stage: OperatorPassthroughCheckStage) {
  return stage === 'review'
    ? { state: publication.reviewCreationState, checkId: publication.reviewCheckId, externalId: publication.reviewExternalId }
    : { state: publication.gateCreationState, checkId: publication.gateCheckId, externalId: publication.gateExternalId };
}

function isRetiredStage(publication: StoredOperatorPassthroughPublication & { reviewRetiredAt: number | null; gateRetiredAt: number | null },
  stage: OperatorPassthroughCheckStage): boolean {
  return stage === 'review' ? publication.reviewRetiredAt !== null : publication.gateRetiredAt !== null;
}

function retirementComplete(publication: Pick<StoredOperatorPassthroughPublication, 'reviewCreationState' | 'gateCreationState'>
  & { reviewRetiredAt: number | null; gateRetiredAt: number | null }): boolean {
  return (publication.reviewCreationState === 'not-created' || publication.reviewRetiredAt !== null)
    && (publication.gateCreationState === 'not-created' || publication.gateRetiredAt !== null);
}

function chooseStage(publication: StoredOperatorPassthroughPublication & { reviewRetiredAt: number | null; gateRetiredAt: number | null }): OperatorPassthroughCheckStage | null {
  const retiring = publication.retirementRequestedAt !== null;
  for (const stage of ['review', 'gate'] as const) {
    const current = stageState(publication, stage);
    if (retiring) {
      if (current.state === 'reserved') continue;
      if (current.state === 'not-created' || isRetiredStage(publication, stage)) continue;
      return stage;
    }
    if (current.state !== 'bound') return stage;
  }
  return null;
}

function clock(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000) throw new Error('Invalid operator passthrough clock');
}

async function prLock(client: Queryable, repositoryId: number, prNumber: number): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [reviewDispatchPrLockKey(repositoryId, prNumber)]);
}

/**
 * The check outbox shares the review PR lock with normal admission/completion.
 * It keeps one durable create intent per official check, and after any uncertain
 * POST it only reconciles that immutable external ID; it never creates again.
 */
export class PostgresOperatorPassthroughRepository implements OperatorPassthroughPublicationRepository {
  private retirementSweepCursor: { repositoryId: number; prNumber: number; headSha: string } | undefined;

  constructor(private readonly pool: Pool) {}

  private async connectWithinScope(scope: OperatorPassthroughOperationScope): Promise<Client> {
    assertOperatorPassthroughOperationActive(scope);
    const connecting = this.pool.connect();
    try {
      return await awaitOperatorPassthroughOperation(() => connecting, scope);
    } catch (error) {
      // Pool acquisition cannot be cancelled by node-postgres. If it completes
      // after the admission deadline, immediately return the unused client.
      void connecting.then((client) => client.release(new Error('Operator pause receipt deadline expired')),
        () => undefined);
      throw error;
    }
  }

  private async rawQueryWithinScope(client: Client, sql: string, values: unknown[] | undefined,
    scope: OperatorPassthroughOperationScope): Promise<{ rows: any[] }> {
    try {
      return await awaitOperatorPassthroughOperation(() => client.query(sql, values), scope);
    } catch (error) {
      const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
      if (code === '57014' || code === '55P03') {
        throw new OperatorPassthroughOperationDeadlineExceededError();
      }
      throw error;
    }
  }

  private async beginWithinScope(client: Client, scope: OperatorPassthroughOperationScope,
    readOnly = false): Promise<void> {
    await this.rawQueryWithinScope(client, readOnly ? 'BEGIN READ ONLY' : 'BEGIN', undefined, scope);
    const remaining = Math.max(1, Math.floor(operatorPassthroughOperationRemainingMs(scope)));
    await this.rawQueryWithinScope(client, `SET LOCAL statement_timeout = '${remaining}ms'`, undefined, scope);
    await this.rawQueryWithinScope(client, `SET LOCAL lock_timeout = '${Math.min(5_000, remaining)}ms'`, undefined, scope);
  }

  private async queryWithinScope(client: Client, sql: string, values: unknown[] | undefined,
    scope: OperatorPassthroughOperationScope): Promise<{ rows: any[] }> {
    assertOperatorPassthroughOperationActive(scope);
    const remaining = Math.max(1, Math.floor(operatorPassthroughOperationRemainingMs(scope)));
    // Refresh both server-side limits for each query. The service deadline is
    // still the authority; the client race below destroys a connection if a
    // statement cannot stop promptly after PostgreSQL's scoped cancellation.
    await this.rawQueryWithinScope(client, `SET LOCAL statement_timeout = '${remaining}ms'`, undefined, scope);
    const lockTimeout = Math.min(5_000, Math.max(1, Math.floor(operatorPassthroughOperationRemainingMs(scope))));
    await this.rawQueryWithinScope(client, `SET LOCAL lock_timeout = '${lockTimeout}ms'`, undefined, scope);
    return this.rawQueryWithinScope(client, sql, values, scope);
  }

  private scopedClient(client: Client, scope: OperatorPassthroughOperationScope): Client {
    return {
      query: (sql, values) => this.queryWithinScope(client, sql, values, scope),
      release: (error) => client.release(error),
    };
  }

  private async transaction<T>(operation: (client: Client) => Promise<T>,
    scope?: OperatorPassthroughOperationScope, readOnly = false): Promise<T> {
    const client = scope ? await this.connectWithinScope(scope) : await this.pool.connect();
    let released = false;
    const release = (error?: Error) => {
      if (!released) {
        released = true;
        client.release(error);
      }
    };
    try {
      if (scope) await this.beginWithinScope(client, scope, readOnly);
      else {
        await client.query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
        await client.query("SET LOCAL lock_timeout = '5s'");
      }
      const transactionClient = scope ? this.scopedClient(client, scope) : client;
      const result = scope
        ? await awaitOperatorPassthroughOperation(() => operation(transactionClient), scope)
        : await operation(transactionClient);
      if (scope) await transactionClient.query('COMMIT');
      else await client.query('COMMIT');
      return result;
    } catch (error) {
      const deadline = scope && (error instanceof OperatorPassthroughOperationDeadlineExceededError
        || scope.signal.aborted || operatorPassthroughOperationRemainingMs(scope) <= 0);
      if (deadline) {
        // Releasing with an error makes node-postgres discard the connection,
        // which cancels an in-flight query and rolls back an open transaction.
        release(new Error('Operator pause receipt deadline expired'));
        throw new OperatorPassthroughOperationDeadlineExceededError();
      }
      try {
        if (scope) await this.rawQueryWithinScope(client, 'ROLLBACK', undefined, scope);
        else await client.query('ROLLBACK');
      } catch {
        release(new Error('Operator pause receipt transaction could not be rolled back'));
      }
      if (error instanceof OperatorPassthroughDeliveryIdentityConflictError
        || error instanceof OperatorPassthroughOperationDeadlineExceededError
        || error instanceof OperatorPassthroughPersistenceUnavailableError) throw error;
      throw new Error('Operator passthrough persistence operation failed');
    } finally { release(); }
  }

  async assertDeliveryIdentity(event: OperatorPassthroughRecordInput['event'],
    scope?: OperatorPassthroughOperationScope): Promise<void> {
    validateOperatorPassthroughEvent(event);
    try {
      const read = async (client: Queryable) => (await client.query(
        'SELECT transport,event_name,delivery_digest FROM review_operator_passthrough_events WHERE delivery_id=$1 LIMIT 1',
        [event.deliveryId],
      )).rows[0];
      const existing = scope
        ? await this.transaction((client) => read(client), scope, true)
        : (await this.pool.query(
          'SELECT transport,event_name,delivery_digest FROM review_operator_passthrough_events WHERE delivery_id=$1 LIMIT 1',
          [event.deliveryId],
        )).rows[0];
      if (existing && (existing.transport !== event.transport || existing.event_name !== event.eventName
        || existing.delivery_digest !== event.deliveryDigest)) {
        throw new OperatorPassthroughDeliveryIdentityConflictError();
      }
    } catch (error) {
      if (error instanceof OperatorPassthroughDeliveryIdentityConflictError
        || error instanceof OperatorPassthroughOperationDeadlineExceededError) throw error;
      throw new OperatorPassthroughPersistenceUnavailableError();
    }
  }

  async record(input: OperatorPassthroughRecordInput, now = Date.now(),
    scope?: OperatorPassthroughOperationScope): Promise<OperatorPassthroughRecordResult> {
    clock(now);
    // Validate external and bounded internal reconciler provenance at the
    // repository boundary before either immutable publication or event writes.
    operatorPassthroughIdentity(input);
    let recordInput = input;
    const baseIdentity = operatorPassthroughIdentityForCandidate(recordInput.candidate, recordInput.expectedAppId);
    const eventAuditDigestFor = (publicationId: string, event = recordInput.event) => sha256(canonicalJson({
      version: 'OperatorPassthroughSourceEvent.v1',
      publicationId,
      candidate: recordInput.candidate,
      expectedAppId: recordInput.expectedAppId,
      transport: event.transport,
      eventName: event.eventName,
      deliveryId: event.deliveryId,
      deliveryDigest: event.deliveryDigest,
    }));
    return this.transaction(async (client) => {
      await prLock(client, recordInput.candidate.repositoryId, recordInput.candidate.prNumber);
      const existingEvent = (await client.query(
        'SELECT * FROM review_operator_passthrough_events WHERE delivery_id=$1 FOR UPDATE', [recordInput.event.deliveryId],
      )).rows[0];
      if (existingEvent) {
        if (existingEvent.transport !== recordInput.event.transport || existingEvent.event_name !== recordInput.event.eventName
          || existingEvent.delivery_digest !== recordInput.event.deliveryDigest) {
          throw new OperatorPassthroughDeliveryIdentityConflictError();
        }
        const existingPublication = (await client.query(
          'SELECT * FROM review_operator_passthrough_publications WHERE publication_id=$1', [existingEvent.publication_id],
        )).rows[0];
        const stored = storedFromRow(existingPublication);
        if (existingEvent.event_audit_digest !== eventAuditDigestFor(stored.publicationId, input.event)
          || !same(stored.coordinates, { ...recordInput.candidate, kind: 'operator-passthrough',
            publicationId: stored.publicationId, publicationSequence: stored.publicationSequence,
            auditDigest: stored.auditDigest })) {
          throw new OperatorPassthroughDeliveryIdentityConflictError();
        }
        if (recordInput.event.transport !== 'service-reconciler' || stored.retiredAt === null) {
          return { status: 'duplicate', publicationId: stored.publicationId,
            auditDigest: stored.auditDigest, verdict: 'SHIP', expectedLanes: 0, completedLanes: 0 };
        }

        const latest = (await client.query(`SELECT * FROM review_operator_passthrough_publications
          WHERE repository_id=$1 AND pr_number=$2 AND head_sha=$3 AND base_sha=$4 AND policy_digest=$5 AND expected_app_id=$6
          ORDER BY publication_sequence DESC LIMIT 1 FOR UPDATE`, [recordInput.candidate.repositoryId,
          recordInput.candidate.prNumber, recordInput.candidate.headSha, recordInput.candidate.baseSha,
          recordInput.candidate.policyDigest, recordInput.expectedAppId])).rows[0];
        let nextSequence = latest ? storedFromRow(latest).publicationSequence : stored.publicationSequence;
        if (latest) {
          const latestStored = storedFromRow(latest);
          if (latestStored.retiredAt === null) {
            if (latestStored.retirementRequestedAt !== null) {
              return { status: 'duplicate', publicationId: latestStored.publicationId,
                auditDigest: latestStored.auditDigest, verdict: 'SHIP', expectedLanes: 0, completedLanes: 0 };
            }
            const cycleEvent = { ...recordInput.event,
              deliveryId: `${input.event.deliveryId}:cycle:${latestStored.publicationSequence}` };
            const alreadyRecorded = (await client.query(
              'SELECT * FROM review_operator_passthrough_events WHERE delivery_id=$1 FOR UPDATE', [cycleEvent.deliveryId],
            )).rows[0];
            if (alreadyRecorded) {
              if (alreadyRecorded.publication_id !== latestStored.publicationId
                || alreadyRecorded.event_audit_digest !== eventAuditDigestFor(latestStored.publicationId, cycleEvent)) {
                throw new OperatorPassthroughDeliveryIdentityConflictError();
              }
            } else {
              await this.insertEvent(client, { ...recordInput, event: cycleEvent }, latestStored.publicationId,
                eventAuditDigestFor(latestStored.publicationId, cycleEvent), now);
            }
            return { status: 'duplicate', publicationId: latestStored.publicationId,
              auditDigest: latestStored.auditDigest, verdict: 'SHIP', expectedLanes: 0, completedLanes: 0 };
          }
        }

        let cycleEvent: OperatorPassthroughRecordInput['event'];
        for (let attempt = 0; attempt < 64; attempt += 1) {
          nextSequence += 1;
          cycleEvent = { ...input.event, deliveryId: `${input.event.deliveryId}:cycle:${nextSequence}` };
          const priorCycle = (await client.query(
            'SELECT * FROM review_operator_passthrough_events WHERE delivery_id=$1 FOR UPDATE', [cycleEvent.deliveryId],
          )).rows[0];
          if (!priorCycle) break;
          const priorPublication = storedFromRow((await client.query(
            'SELECT * FROM review_operator_passthrough_publications WHERE publication_id=$1', [priorCycle.publication_id],
          )).rows[0]);
          if (priorCycle.transport !== cycleEvent.transport || priorCycle.event_name !== cycleEvent.eventName
            || priorCycle.delivery_digest !== cycleEvent.deliveryDigest
            || priorCycle.event_audit_digest !== eventAuditDigestFor(priorPublication.publicationId, cycleEvent)) {
            throw new OperatorPassthroughDeliveryIdentityConflictError();
          }
          if (priorPublication.retiredAt === null) {
            return { status: 'duplicate', publicationId: priorPublication.publicationId,
              auditDigest: priorPublication.auditDigest, verdict: 'SHIP', expectedLanes: 0, completedLanes: 0 };
          }
          nextSequence = Math.max(nextSequence, priorPublication.publicationSequence);
        }
        if (!cycleEvent!) throw new Error('Operator passthrough reconciliation cycle is unavailable');
        recordInput = { ...recordInput, event: cycleEvent! };
        operatorPassthroughIdentity(recordInput);
      }

      const latest = (await client.query(`SELECT * FROM review_operator_passthrough_publications
        WHERE repository_id=$1 AND pr_number=$2 AND head_sha=$3 AND base_sha=$4 AND policy_digest=$5 AND expected_app_id=$6
        ORDER BY publication_sequence DESC LIMIT 1 FOR UPDATE`, [recordInput.candidate.repositoryId, recordInput.candidate.prNumber,
        recordInput.candidate.headSha, recordInput.candidate.baseSha, recordInput.candidate.policyDigest, recordInput.expectedAppId])).rows[0];
      let identity = baseIdentity;
      let resultStatus: 'accepted' | 'duplicate' = 'accepted';
      if (latest) {
        const stored = storedFromRow(latest);
        if (stored.retirementRequestedAt === null) {
          identity = operatorPassthroughIdentityForCandidate(recordInput.candidate, recordInput.expectedAppId,
            stored.coordinates.publicationSequence);
          resultStatus = 'duplicate';
        } else {
          identity = operatorPassthroughIdentityForCandidate(recordInput.candidate, recordInput.expectedAppId,
            stored.coordinates.publicationSequence + 1);
        }
      }
      if (latest && resultStatus === 'duplicate') {
        await this.insertEvent(client, recordInput, identity.publicationId, eventAuditDigestFor(identity.publicationId), now);
      } else {
        // The event audit binds to the selected publication cycle, including a
        // re-enabled pause after a prior cycle was explicitly retired.
        await this.insertPublicationAndEvent(client, recordInput, identity, eventAuditDigestFor(identity.publicationId), now);
      }
      return { status: resultStatus, publicationId: identity.publicationId,
        auditDigest: identity.auditDigest, verdict: 'SHIP', expectedLanes: 0, completedLanes: 0 };
    }, scope);
  }

  private async insertPublicationAndEvent(client: Client, input: OperatorPassthroughRecordInput,
    identity: ReturnType<typeof operatorPassthroughIdentityForCandidate>, eventAuditDigest: string, now: number): Promise<void> {
    await client.query(`INSERT INTO review_operator_passthrough_publications(
      publication_id,repository_id,owner,repo,pr_number,head_sha,base_sha,policy_digest,expected_app_id,
      publication_sequence,coordinates,audit_digest,review_external_id,gate_external_id,
      review_creation_state,gate_creation_state,available_at,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'reserved','reserved',
        to_timestamp($15/1000.0),to_timestamp($15/1000.0),to_timestamp($15/1000.0))`, [
      identity.publicationId, input.candidate.repositoryId, input.candidate.owner, input.candidate.repo,
      input.candidate.prNumber, input.candidate.headSha, input.candidate.baseSha, input.candidate.policyDigest,
      input.expectedAppId, identity.coordinates.publicationSequence, JSON.stringify(identity.coordinates),
      identity.auditDigest, identity.reviewExternalId, identity.gateExternalId, now,
    ]);
    await this.insertEvent(client, input, identity.publicationId, eventAuditDigest, now);
  }

  private async insertEvent(client: Client, input: OperatorPassthroughRecordInput, publicationId: string,
    eventAuditDigest: string, now: number): Promise<void> {
    await client.query(`INSERT INTO review_operator_passthrough_events(
      delivery_id,publication_id,transport,event_name,delivery_digest,event_audit_digest,created_at)
      VALUES($1,$2,$3,$4,$5,$6,to_timestamp($7/1000.0))`, [
      input.event.deliveryId, publicationId, input.event.transport, input.event.eventName,
      input.event.deliveryDigest, eventAuditDigest, now,
    ]);
  }

  async getPublication(publicationId: string,
    scope?: OperatorPassthroughOperationScope): Promise<OperatorPassthroughPublicationSnapshot | null> {
    if (!/^[a-f0-9]{64}$/u.test(publicationId)) throw new Error('Invalid operator passthrough publication id');
    const result = scope
      ? await this.transaction((client) => client.query(
        'SELECT * FROM review_operator_passthrough_publications WHERE publication_id=$1', [publicationId]), scope, true)
      : await this.pool.query('SELECT * FROM review_operator_passthrough_publications WHERE publication_id=$1', [publicationId]);
    if (!result.rows[0]) return null;
    const stored = storedFromRow(result.rows[0]);
    return { ...stored, readyForShip: operatorPassthroughReadyForShip(stored) };
  }

  /** Select the bounded, authenticated existing-admission catch-up page from the owning persistence layer. */
  async listPausedAdmissions(repositoryIds: readonly number[], appIds: readonly number[], limit: number,
    after?: OperatorPassthroughReconcileCursor): Promise<OperatorPassthroughReconcileAdmission[]> {
    const boundedRepositoryIds = [...new Set(repositoryIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
    const boundedAppIds = [...new Set(appIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
    if (!Number.isSafeInteger(limit) || limit < 1
      || (after && (!Number.isSafeInteger(after.repositoryId) || after.repositoryId <= 0
        || !Number.isSafeInteger(after.prNumber) || after.prNumber <= 0))) {
      throw new Error('Operator passthrough reconciliation query is invalid');
    }
    if (boundedRepositoryIds.length === 0 || boundedAppIds.length === 0) return [];
    const { rows } = await this.pool.query(`
      SELECT DISTINCT ON (runs.repository_id,runs.pr_number)
        runs.run_id,runs.repository_id,runs.owner,runs.repo,runs.pr_number,runs.head_sha,runs.base_sha,
        runs.effective_policy_digest AS admitted_policy_digest
      FROM review_runs runs
      WHERE runs.repository_id = ANY($1::bigint[])
        AND runs.authoritative_gate_app_id = ANY($2::bigint[])
        AND runs.publication_mode = 'app-gate'
        AND ($3::bigint IS NULL OR (runs.repository_id,runs.pr_number) > ($3::bigint,$4::integer))
        AND NOT EXISTS (
          SELECT 1 FROM review_operator_passthrough_publications publication
           WHERE publication.repository_id = runs.repository_id AND publication.pr_number = runs.pr_number
             AND publication.head_sha = runs.head_sha AND publication.base_sha = runs.base_sha
             AND publication.policy_digest = runs.effective_policy_digest
             AND publication.expected_app_id = runs.authoritative_gate_app_id
             AND publication.retirement_requested_at IS NULL AND publication.retired_at IS NULL
        )
      ORDER BY runs.repository_id,runs.pr_number,runs.created_at DESC
      LIMIT $5`, [boundedRepositoryIds, boundedAppIds, after?.repositoryId ?? null,
      after?.prNumber ?? null, Math.max(1, Math.min(10, limit))]);
    return rows.map((row: any) => ({ runId: String(row.run_id), repositoryId: Number(row.repository_id),
      owner: String(row.owner), repo: String(row.repo), prNumber: Number(row.pr_number),
      headSha: String(row.head_sha), baseSha: String(row.base_sha),
      admittedPolicyDigest: String(row.admitted_policy_digest) }));
  }

  async requestRetirement(candidate: Pick<OperatorPassthroughCandidate, 'repositoryId' | 'prNumber' | 'headSha'>,
    reason: 'pause-disabled' | 'normal-review-admitted' | 'candidate-changed', now = Date.now()): Promise<number> {
    clock(now);
    return this.transaction(async (client) => {
      await prLock(client, candidate.repositoryId, candidate.prNumber);
      return this.retireInTransaction(client, candidate, reason, now);
    });
  }

  /** Called by ordinary review admission while it already holds the shared PR lock. */
  async retireInTransaction(client: Queryable,
    candidate: Pick<OperatorPassthroughCandidate, 'repositoryId' | 'prNumber' | 'headSha'>,
    reason: 'pause-disabled' | 'normal-review-admitted' | 'candidate-changed', now: number): Promise<number> {
    clock(now);
    const updated = await client.query(`UPDATE review_operator_passthrough_publications SET
      retirement_requested_at=COALESCE(retirement_requested_at,to_timestamp($4/1000.0)),
      retirement_reason=COALESCE(retirement_reason,$5),
      review_creation_state=CASE WHEN review_creation_state='reserved' THEN 'not-created' ELSE review_creation_state END,
      gate_creation_state=CASE WHEN gate_creation_state='reserved' THEN 'not-created' ELSE gate_creation_state END,
      review_retired_at=CASE WHEN review_creation_state='reserved' THEN to_timestamp($4/1000.0) ELSE review_retired_at END,
      gate_retired_at=CASE WHEN gate_creation_state='reserved' THEN to_timestamp($4/1000.0) ELSE gate_retired_at END,
      updated_at=to_timestamp($4/1000.0)
      WHERE repository_id=$1 AND pr_number=$2 AND head_sha=$3 AND retired_at IS NULL
      RETURNING publication_id,review_creation_state,review_retired_at,gate_creation_state,gate_retired_at`,
    [candidate.repositoryId, candidate.prNumber, candidate.headSha, now, reason]);
    for (const row of updated.rows) {
      if (retirementComplete({
        reviewCreationState: row.review_creation_state,
        gateCreationState: row.gate_creation_state,
        reviewRetiredAt: timestamp(row.review_retired_at),
        gateRetiredAt: timestamp(row.gate_retired_at),
      })) {
        await client.query(`UPDATE review_operator_passthrough_publications SET retired_at=to_timestamp($2/1000.0)
          WHERE publication_id=$1 AND retired_at IS NULL`, [row.publication_id, now]);
      }
    }
    return updated.rows.length;
  }

  async requestAllRetirements(reason: 'pause-disabled', now = Date.now()): Promise<number> {
    clock(now);
    const after = this.retirementSweepCursor;
    const candidates = await this.pool.query(`SELECT DISTINCT repository_id,pr_number,head_sha
      FROM review_operator_passthrough_publications WHERE retired_at IS NULL AND retirement_requested_at IS NULL
        AND ($1::bigint IS NULL OR (repository_id,pr_number,head_sha) > ($1::bigint,$2::integer,$3::text))
      ORDER BY repository_id,pr_number,head_sha LIMIT $4`, [
      after?.repositoryId ?? null,
      after?.prNumber ?? null,
      after?.headSha ?? null,
      RETIREMENT_SWEEP_BATCH_SIZE,
    ]);
    if (candidates.rows.length === 0) {
      this.retirementSweepCursor = undefined;
      return 0;
    }
    let requested = 0;
    // Keep one transaction per PR so no sweep holds multiple shared admission
    // locks at once. The bounded cursor advances past pending retirements and
    // retries skipped candidates after wrap, preserving progress without
    // changing the publisher's PR-before-row lock order.
    for (const row of candidates.rows) {
      const candidate = { repositoryId: POSITIVE(row.repository_id),
        prNumber: POSITIVE(row.pr_number), headSha: String(row.head_sha) };
      this.retirementSweepCursor = candidate;
      requested += await this.requestRetirement(candidate, reason, now);
    }
    if (candidates.rows.length < RETIREMENT_SWEEP_BATCH_SIZE) this.retirementSweepCursor = undefined;
    return requested;
  }

  async claimPublication(workerId: string, now: number, leaseMs = 60_000, publicationId?: string,
    scope?: OperatorPassthroughOperationScope): Promise<OperatorPassthroughPublicationClaim | null> {
    clock(now);
    if (!/^[A-Za-z0-9_.:-]{1,100}$/u.test(workerId) || !Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 120_000) {
      throw new Error('Invalid operator passthrough lease');
    }
    return this.transaction(async (client) => {
      const candidates = (await client.query(`SELECT publication_id,repository_id,pr_number FROM review_operator_passthrough_publications
        WHERE available_at <= to_timestamp($1/1000.0)
          AND (lease_expires_at IS NULL OR lease_expires_at <= to_timestamp($1/1000.0))
          AND ($2::text IS NULL OR publication_id=$2)
          AND ((review_creation_state NOT IN ('bound','not-created') OR gate_creation_state NOT IN ('bound','not-created'))
            OR (retirement_requested_at IS NOT NULL AND retired_at IS NULL))
        ORDER BY available_at,created_at LIMIT 50`, [now, publicationId ?? null])).rows;
      for (const candidate of candidates) {
        const repositoryId = POSITIVE(candidate.repository_id);
        const prNumber = POSITIVE(candidate.pr_number);
        const acquired = (await client.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',
          [reviewDispatchPrLockKey(repositoryId, prNumber)])).rows[0]?.acquired === true;
        if (!acquired) continue;
        const row = (await client.query('SELECT * FROM review_operator_passthrough_publications WHERE publication_id=$1 FOR UPDATE',
          [candidate.publication_id])).rows[0];
        if (!row) continue;
        let publication = storedFromRow(row);
        if (publication.retirementRequestedAt !== null) {
          // A create that never left the database is safe to close without a
          // GitHub request. A `creating` row is uncertain and must reconcile.
          if (publication.reviewCreationState === 'reserved') {
            await client.query(`UPDATE review_operator_passthrough_publications SET review_creation_state='not-created',
              review_retired_at=to_timestamp($2/1000.0),updated_at=to_timestamp($2/1000.0) WHERE publication_id=$1`,
            [publication.publicationId, now]);
          }
          if (publication.gateCreationState === 'reserved') {
            await client.query(`UPDATE review_operator_passthrough_publications SET gate_creation_state='not-created',
              gate_retired_at=to_timestamp($2/1000.0),updated_at=to_timestamp($2/1000.0) WHERE publication_id=$1`,
            [publication.publicationId, now]);
          }
          const refreshed = (await client.query('SELECT * FROM review_operator_passthrough_publications WHERE publication_id=$1 FOR UPDATE',
            [publication.publicationId])).rows[0];
          publication = storedFromRow(refreshed);
          if (retirementComplete(publication)) {
            await client.query(`UPDATE review_operator_passthrough_publications SET retired_at=to_timestamp($2/1000.0),
              updated_at=to_timestamp($2/1000.0) WHERE publication_id=$1`, [publication.publicationId, now]);
            continue;
          }
        }
        const stage = chooseStage(publication);
        if (!stage) {
          if (publication.retirementRequestedAt !== null && retirementComplete(publication)) {
            await client.query(`UPDATE review_operator_passthrough_publications SET retired_at=to_timestamp($2/1000.0),
              updated_at=to_timestamp($2/1000.0) WHERE publication_id=$1`, [publication.publicationId, now]);
          }
          continue;
        }
        const selected = stageState(publication, stage);
        const mayCreate = publication.retirementRequestedAt === null && selected.state === 'reserved' && selected.checkId === null;
        if (mayCreate) {
          await client.query(`UPDATE review_operator_passthrough_publications SET ${stage === 'review' ? 'review_creation_state' : 'gate_creation_state'}='creating',
            updated_at=to_timestamp($2/1000.0) WHERE publication_id=$1`, [publication.publicationId, now]);
        }
        const leaseToken = randomUUID();
        const saved = await client.query(`UPDATE review_operator_passthrough_publications SET lease_owner=$2,lease_token=$3,
          lease_expires_at=to_timestamp(($4::double precision+$5::double precision)/1000.0),updated_at=to_timestamp($4/1000.0)
          WHERE publication_id=$1 RETURNING *`, [publication.publicationId, workerId, leaseToken, now, leaseMs]);
        publication = storedFromRow(saved.rows[0]);
        return { ...publication, leaseOwner: workerId, leaseToken, stage, mayCreate,
          retiring: publication.retirementRequestedAt !== null };
      }
      return null;
    }, scope);
  }

  async publishLocked(claim: OperatorPassthroughPublicationClaim,
    publish: (claim: OperatorPassthroughPublicationClaim) => Promise<ReviewGateCheck
      | OperatorPassthroughPublicationNotStarted | OperatorPassthroughReconcilePending | OperatorPassthroughRetireRequired>,
    now: () => number = Date.now, scope?: OperatorPassthroughOperationScope): Promise<'published' | 'stale-claim' | 'retry'> {
    clock(now());
    const client = scope ? await this.connectWithinScope(scope) : await this.pool.connect();
    let released = false;
    const release = (error?: Error) => {
      if (!released) {
        released = true;
        client.release(error);
      }
    };
    try {
      if (scope) await this.beginWithinScope(client, scope);
      else {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout = '5s'");
      }
      const db = scope ? this.scopedClient(client, scope) : client;
      await prLock(db, claim.coordinates.repositoryId, claim.coordinates.prNumber);
      const row = (await db.query(`SELECT * FROM review_operator_passthrough_publications
        WHERE publication_id=$1 AND lease_owner=$2 AND lease_token=$3
          AND lease_expires_at > to_timestamp($4/1000.0) FOR UPDATE`,
      [claim.publicationId, claim.leaseOwner, claim.leaseToken, now()])).rows[0];
      if (!row) { await db.query('COMMIT'); return 'stale-claim'; }
      const publication = storedFromRow(row);
      if (!same(publication.coordinates, claim.coordinates) || publication.expectedAppId !== claim.expectedAppId
        || publication.auditDigest !== claim.auditDigest || publication.retirementRequestedAt !== claim.retirementRequestedAt) {
        await db.query('COMMIT'); return 'stale-claim';
      }
      const selected = stageState(publication, claim.stage);
      const mayCreate = claim.mayCreate && publication.retirementRequestedAt === null
        && selected.state === 'creating' && selected.checkId === null;
      const result = scope
        ? await awaitOperatorPassthroughOperation(() => publish({ ...publication,
          leaseOwner: claim.leaseOwner, leaseToken: claim.leaseToken, stage: claim.stage, mayCreate,
          retiring: publication.retirementRequestedAt !== null }), scope)
        : await publish({ ...publication, leaseOwner: claim.leaseOwner, leaseToken: claim.leaseToken,
          stage: claim.stage, mayCreate, retiring: publication.retirementRequestedAt !== null });
      let notStartedReset = false;
      if ('kind' in result) {
        if (!Number.isSafeInteger(result.retryDelayMs) || result.retryDelayMs < 1_000 || result.retryDelayMs > 300_000) {
          throw new Error('Invalid operator passthrough retry delay');
        }
        if (result.kind === 'not-started') {
          if (!mayCreate) throw new Error('Operator passthrough cannot reset an uncertain create');
          notStartedReset = true;
          try { await db.query(`UPDATE review_operator_passthrough_publications SET
            ${claim.stage === 'review' ? 'review_creation_state' : 'gate_creation_state'}='reserved',
            lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
            available_at=to_timestamp(($2::double precision+$3::double precision)/1000.0),last_error_class='client-preparation',updated_at=to_timestamp($2/1000.0)
            WHERE publication_id=$1`, [claim.publicationId, now(), result.retryDelayMs]); }
          catch { throw new OperatorPassthroughPreflightResetUnconfirmedError(); }
        } else if (result.kind === 'reconcile-pending') {
          if (selected.state !== 'creating' || selected.checkId !== null) throw new Error('Operator passthrough reconcile state is invalid');
          await db.query(`UPDATE review_operator_passthrough_publications SET lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
            available_at=to_timestamp(($2::double precision+$3::double precision)/1000.0),last_error_class='unknown-create',updated_at=to_timestamp($2/1000.0)
            WHERE publication_id=$1`, [claim.publicationId, now(), result.retryDelayMs]);
        } else {
          if (result.reason !== 'candidate-changed' || publication.retirementRequestedAt !== null) {
            throw new Error('Operator passthrough retirement transition is invalid');
          }
          await db.query(`UPDATE review_operator_passthrough_publications SET
            retirement_requested_at=to_timestamp($2/1000.0),retirement_reason='candidate-changed',
            review_creation_state=CASE WHEN review_creation_state='reserved'
              OR ($3 AND $4='review' AND review_creation_state='creating' AND review_check_id IS NULL)
              THEN 'not-created' ELSE review_creation_state END,
            gate_creation_state=CASE WHEN gate_creation_state='reserved'
              OR ($3 AND $4='gate' AND gate_creation_state='creating' AND gate_check_id IS NULL)
              THEN 'not-created' ELSE gate_creation_state END,
            review_retired_at=CASE WHEN review_creation_state='reserved'
              OR ($3 AND $4='review' AND review_creation_state='creating' AND review_check_id IS NULL)
              THEN to_timestamp($2/1000.0) ELSE review_retired_at END,
            gate_retired_at=CASE WHEN gate_creation_state='reserved'
              OR ($3 AND $4='gate' AND gate_creation_state='creating' AND gate_check_id IS NULL)
              THEN to_timestamp($2/1000.0) ELSE gate_retired_at END,
            retired_at=CASE WHEN
              (review_creation_state='reserved' OR ($3 AND $4='review' AND review_creation_state='creating' AND review_check_id IS NULL)
                OR review_creation_state='not-created' OR review_retired_at IS NOT NULL)
              AND (gate_creation_state='reserved' OR ($3 AND $4='gate' AND gate_creation_state='creating' AND gate_check_id IS NULL)
                OR gate_creation_state='not-created' OR gate_retired_at IS NOT NULL)
              THEN to_timestamp($2/1000.0) ELSE retired_at END,
            lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,available_at=to_timestamp(($2::double precision+$5::double precision)/1000.0),
            updated_at=to_timestamp($2/1000.0) WHERE publication_id=$1`,
          [claim.publicationId, now(), mayCreate, claim.stage, result.retryDelayMs]);
        }
        try { await db.query('COMMIT'); }
        catch {
          if (notStartedReset) throw new OperatorPassthroughPreflightResetUnconfirmedError();
          throw new Error('Operator passthrough retry transaction commit failed');
        }
        return 'retry';
      }
      const expectedName = claim.stage === 'review' ? 'Review Yeti' : 'Review Yeti Gate';
      const expectedConclusion = publication.retirementRequestedAt === null ? 'success' : 'failure';
      if (!Number.isSafeInteger(result.id) || result.id <= 0 || result.name !== expectedName
        || result.appId !== publication.expectedAppId || result.headSha !== publication.coordinates.headSha
        || result.externalId !== selected.externalId || (selected.checkId !== null && result.id !== selected.checkId)
        || result.status !== 'completed' || result.conclusion !== expectedConclusion) {
        throw new Error('Operator passthrough check publication identity/state mismatch');
      }
      const stageColumn = claim.stage === 'review' ? 'review' : 'gate';
      await db.query(`UPDATE review_operator_passthrough_publications SET
        ${stageColumn}_check_id=$2,${stageColumn}_creation_state='bound',
        ${stageColumn}_retired_at=CASE WHEN $3 THEN to_timestamp($4/1000.0) ELSE ${stageColumn}_retired_at END,
        retired_at=CASE WHEN $3 AND (
          (review_creation_state IN ('not-created','bound') AND ($5 OR review_retired_at IS NOT NULL)) AND
          (gate_creation_state IN ('not-created','bound') AND ($6 OR gate_retired_at IS NOT NULL))
        ) THEN to_timestamp($4/1000.0) ELSE retired_at END,
        lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,last_error_class=NULL,updated_at=to_timestamp($4/1000.0)
        WHERE publication_id=$1`, [claim.publicationId, result.id, publication.retirementRequestedAt !== null,
        now(), claim.stage === 'review', claim.stage === 'gate']);
      await db.query('COMMIT');
      return 'published';
    } catch (error) {
      const deadline = scope && (error instanceof OperatorPassthroughOperationDeadlineExceededError
        || scope.signal.aborted || operatorPassthroughOperationRemainingMs(scope) <= 0);
      if (error instanceof OperatorPassthroughPreflightResetUnconfirmedError) {
        if (deadline) release(new Error('Operator pause receipt deadline expired'));
        else {
          try {
            if (scope) await this.rawQueryWithinScope(client, 'ROLLBACK', undefined, scope);
            else await client.query('ROLLBACK');
          } catch {
            release(new Error('Operator passthrough reset transaction could not be rolled back'));
          }
        }
        throw error;
      }
      if (deadline) {
        // An in-flight GitHub request may have an unknown outcome. Dropping the
        // transaction preserves its committed `creating` state for reconcile-only recovery.
        release(new Error('Operator pause receipt deadline expired'));
        throw new OperatorPassthroughOperationDeadlineExceededError();
      }
      try {
        if (scope) await this.rawQueryWithinScope(client, 'ROLLBACK', undefined, scope);
        else await client.query('ROLLBACK');
      } catch {
        release(new Error('Operator pause publication transaction could not be rolled back'));
      }
      if (error instanceof OperatorPassthroughOperationDeadlineExceededError) throw error;
      throw new Error('Operator passthrough check publication failed');
    } finally { release(); }
  }

  async retryPublication(claim: OperatorPassthroughPublicationClaim, now: number, delayMs: number,
    scope?: OperatorPassthroughOperationScope): Promise<boolean> {
    clock(now);
    if (!Number.isSafeInteger(delayMs) || delayMs < 1_000 || delayMs > 300_000) throw new Error('Invalid operator passthrough retry delay');
    const sql = `UPDATE review_operator_passthrough_publications SET
      lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,available_at=to_timestamp(($4::double precision+$5::double precision)/1000.0),
      last_error_class='transport',updated_at=to_timestamp($4/1000.0)
      WHERE publication_id=$1 AND lease_owner=$2 AND lease_token=$3 AND lease_expires_at > to_timestamp($4/1000.0)
      RETURNING publication_id`;
    const values = [claim.publicationId, claim.leaseOwner, claim.leaseToken, now, delayMs];
    const result = scope
      ? await this.transaction((client) => client.query(sql, values), scope)
      : await this.pool.query(sql, values);
    return result.rows.length === 1;
  }
}
