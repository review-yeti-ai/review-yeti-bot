import type { Request, Response } from 'express';
import { z } from 'zod';
import { canonicalJson, sha256 } from '../review/reviewCore';
import {
  createPrLifecycleHistorySnapshot,
  recordCurrentPrFindingVerification,
  readPrLifecycleHistorySnapshotPage,
  type ReviewLifecycleQueryable,
} from '../persistence/reviewPrLifecycleRepository';
import { logger } from '../utils/logger';

export const PR_LIFECYCLE_HISTORY_SNAPSHOT_REQUEST_VERSION = 'PrLifecycleHistorySnapshotRequest.v1' as const;
export const PR_LIFECYCLE_HISTORY_SNAPSHOT_RESPONSE_VERSION = 'PrLifecycleHistorySnapshot.v1' as const;
export const PR_LIFECYCLE_HISTORY_PAGE_REQUEST_VERSION = 'PrLifecycleHistoryPageRequest.v1' as const;
export const PR_LIFECYCLE_HISTORY_PAGE_RESPONSE_VERSION = 'PrLifecycleHistoryPage.v1' as const;
export const PR_LIFECYCLE_FINDING_VERIFICATION_REQUEST_VERSION = 'PrLifecycleFindingVerificationRequest.v1' as const;

const runId = z.string().regex(/^run_[a-f0-9]{32}$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const snapshotRequestSchema = z.object({ version: z.literal(PR_LIFECYCLE_HISTORY_SNAPSHOT_REQUEST_VERSION), runId,
  executionAttempt: z.number().int().positive().safe() }).strict();
const pageRequestSchema = z.object({ version: z.literal(PR_LIFECYCLE_HISTORY_PAGE_REQUEST_VERSION), runId,
  executionAttempt: z.number().int().positive().safe(), snapshotId: z.string().uuid(),
  collection: z.enum(['events', 'findings']), offset: z.number().int().nonnegative().safe(),
  limit: z.number().int().positive().max(250).safe() }).strict();
const verificationRequestSchema = z.object({ version: z.literal(PR_LIFECYCLE_FINDING_VERIFICATION_REQUEST_VERSION), runId,
  executionAttempt: z.number().int().positive().safe(), snapshotId: z.string().uuid(), findingEventId: z.string().uuid(),
  status: z.enum(['confirmed', 'contradicted', 'insufficient']), currentContextDigest: digest,
  currentAffectedContextDigest: digest, evidence: z.record(z.string(), z.unknown()) }).strict();

function bearerToken(request: Request): string | null {
  const match = /^Bearer\s+([^\s]+)$/iu.exec(request.header('authorization') || '');
  return match?.[1] || null;
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return {}; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Source and author prose are intentionally omitted from the bridge projection. */
function eventProjection(row: Record<string, unknown>) {
  const payload = jsonObject(row.payload);
  const verification = row.event_type === 'finding.independent_verification';
  const currentDigest = typeof payload.currentAffectedContextDigest === 'string'
    && digest.safeParse(payload.currentAffectedContextDigest).success ? payload.currentAffectedContextDigest : undefined;
  const sourceDigest = typeof payload.sourceAffectedContextDigest === 'string'
    && digest.safeParse(payload.sourceAffectedContextDigest).success ? payload.sourceAffectedContextDigest : undefined;
  return {
    eventId: String(row.event_id), eventType: String(row.event_type),
    ...(typeof row.run_id === 'string' ? { runId: row.run_id } : {}),
    ...(Number.isSafeInteger(Number(row.execution_attempt)) ? { executionAttempt: Number(row.execution_attempt) } : {}),
    ...(typeof row.head_sha === 'string' ? { headSha: row.head_sha } : {}),
    ...(typeof row.base_sha === 'string' ? { baseSha: row.base_sha } : {}),
    ...(typeof row.policy_digest === 'string' ? { policyDigest: row.policy_digest } : {}),
    ...(typeof row.config_digest === 'string' ? { configDigest: row.config_digest } : {}),
    ...(typeof row.context_digest === 'string' ? { contextDigest: row.context_digest } : {}),
    ...(typeof row.evidence_digest === 'string' ? { evidenceDigest: row.evidence_digest } : {}),
    verificationStatus: row.verification_status === 'confirmed' || row.verification_status === 'contradicted'
      ? row.verification_status : 'insufficient',
    ...(verification ? {
      verification: {
        ...(typeof payload.findingEventId === 'string' ? { findingEventId: payload.findingEventId } : {}),
        ...(typeof payload.fingerprint === 'string' ? { fingerprint: payload.fingerprint } : {}),
        ...(payload.status === 'confirmed' || payload.status === 'contradicted' || payload.status === 'insufficient'
          ? { status: payload.status } : {}),
        ...(currentDigest ? { currentAffectedContextDigest: currentDigest } : {}),
        ...(sourceDigest ? { sourceAffectedContextDigest: sourceDigest } : {}),
      },
    } : {}),
  };
}

function findingProjection(row: Record<string, unknown>) {
  return {
    findingEventId: String(row.finding_event_id), fingerprint: String(row.fingerprint), path: String(row.path),
    ...(Number.isSafeInteger(Number(row.region_start)) && row.region_start !== null ? { regionStart: Number(row.region_start) } : {}),
    ...(Number.isSafeInteger(Number(row.region_end)) && row.region_end !== null ? { regionEnd: Number(row.region_end) } : {}),
    firstSeenHead: String(row.first_seen_head), lastSeenHead: String(row.last_seen_head),
    affectedContextDigest: String(row.affected_context_digest), sourceSeverity: String(row.source_severity),
    effectiveSeverity: String(row.effective_severity), disposition: String(row.disposition), blocking: row.blocking === true,
    verificationStatus: row.verification_status === 'confirmed' || row.verification_status === 'contradicted'
      ? row.verification_status : 'insufficient', evidenceDigest: String(row.evidence_digest),
  };
}

/** Authenticated, run-scoped history bridge. Snapshot identifiers are opaque DB keys; callers
 * cannot supply repository coordinates or enlarge the captured immutable event/finding sets. */
export function createPrLifecycleHistoryHandler(db: ReviewLifecycleQueryable) {
  return async (request: Request, response: Response) => {
    const token = bearerToken(request);
    if (!token || !token.startsWith('ghs_')) return response.status(401).json({ error: 'Worker installation bearer token is required' });
    const workerTokenDigest = sha256(token);
    const body = jsonObject(request.body);
    if (body.version === PR_LIFECYCLE_FINDING_VERIFICATION_REQUEST_VERSION) {
      const parsed = verificationRequestSchema.safeParse(body);
      if (!parsed.success || Buffer.byteLength(canonicalJson(parsed.data.evidence ?? {}), 'utf8') > 32_000) {
        return response.status(400).json({ error: 'Invalid PR lifecycle finding verification request' });
      }
      try {
        const result = await recordCurrentPrFindingVerification(db, {
          ...parsed.data, workerTokenDigest,
          evidenceDigest: sha256(canonicalJson(parsed.data.evidence)),
        });
        if (result === 'unauthorized') return response.status(403).json({ error: 'Worker is not authorized for this run' });
        if (result === 'stale_context') return response.status(409).json({ error: 'Finding verification context is stale' });
        if (result === 'not_found') return response.status(404).json({ error: 'Finding or history snapshot was not found' });
        return response.status(200).json({ version: 'PrLifecycleFindingVerification.v1', status: 'recorded' });
      } catch {
        logger.warn('PR lifecycle finding verification unavailable', { reason: 'persistence_unavailable', runId: parsed.data.runId });
        return response.status(503).json({ error: 'PR lifecycle finding verification is temporarily unavailable' });
      }
    }
    if (body.version === PR_LIFECYCLE_HISTORY_SNAPSHOT_REQUEST_VERSION) {
      const parsed = snapshotRequestSchema.safeParse(body);
      if (!parsed.success) return response.status(400).json({ error: 'Invalid PR lifecycle history snapshot request' });
      try {
        const result = await createPrLifecycleHistorySnapshot(db, { ...parsed.data, workerTokenDigest });
        if (result.status === 'unauthorized') return response.status(403).json({ error: 'Worker is not authorized for this run' });
        if (result.status !== 'ok') return response.status(503).json({ error: 'PR lifecycle history snapshot is unavailable' });
        return response.status(200).json({ version: PR_LIFECYCLE_HISTORY_SNAPSHOT_RESPONSE_VERSION, ...result.snapshot });
      } catch {
        logger.warn('PR lifecycle history snapshot unavailable', { reason: 'persistence_unavailable', runId: parsed.data.runId });
        return response.status(503).json({ error: 'PR lifecycle history snapshot is temporarily unavailable' });
      }
    }
    const parsed = pageRequestSchema.safeParse(body);
    if (!parsed.success) return response.status(400).json({ error: 'Invalid PR lifecycle history page request' });
    try {
      const result = await readPrLifecycleHistorySnapshotPage(db, { ...parsed.data, workerTokenDigest });
      if (result.status === 'unauthorized') return response.status(403).json({ error: 'Worker is not authorized for this run' });
      if (result.status === 'not_found') return response.status(404).json({ error: 'PR lifecycle history snapshot was not found' });
      const rows = result.collection === 'events'
        ? result.rows.map((row) => eventProjection(row))
        : result.rows.map((row) => findingProjection(row));
      return response.status(200).json({ version: PR_LIFECYCLE_HISTORY_PAGE_RESPONSE_VERSION,
        snapshotId: result.snapshotId, collection: result.collection, offset: result.offset, limit: result.limit,
        totalCount: result.totalCount, capturedCount: result.capturedCount, rows,
        hasMore: result.hasMore, nextOffset: result.nextOffset });
    } catch {
      logger.warn('PR lifecycle history page unavailable', { reason: 'persistence_unavailable', runId: parsed.data.runId });
      return response.status(503).json({ error: 'PR lifecycle history page is temporarily unavailable' });
    }
  };
}
