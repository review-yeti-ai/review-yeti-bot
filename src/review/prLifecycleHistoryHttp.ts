import { z } from 'zod';
import { isGitHubInstallationToken } from '../github/githubTransportPolicy';
import { canonicalJson, sha256 } from './reviewCore';
import { validateWorkerCompletionEndpoint } from './workerCompletion';
import { findingDispositionEventSchema, type FindingDispositionEvent } from './findingDisposition';
import { MAX_DISPUTE_RECHECKS_PER_BATCH, type AuthenticatedDisputesProjection } from './disputedFindingRecheck';

export type { AuthenticatedDisputesProjection } from './disputedFindingRecheck';

export const PR_LIFECYCLE_HISTORY_PAGE_SIZE = 100;
export const MAX_PR_LIFECYCLE_HISTORY_RESPONSE_BYTES = 4_000_000;
const sha = z.string().regex(/^[a-f0-9]{40}$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const uuid = z.string().uuid();
const authenticatedDisputesSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('complete'), disputes: z.array(z.object({ findingFingerprint: z.string().regex(/^fp1_[a-f0-9]{24}$/u),
    priorFindingEventId: uuid, priorEvidenceDigest: digest }).strict()).max(MAX_DISPUTE_RECHECKS_PER_BATCH),
  paths: z.array(z.string().min(1).max(4_096)).max(MAX_DISPUTE_RECHECKS_PER_BATCH) }).strict(),
  z.object({ status: z.literal('unavailable'), disputes: z.array(z.never()).max(0),
    paths: z.array(z.string().min(1).max(4_096)).max(MAX_DISPUTE_RECHECKS_PER_BATCH),
    reason: z.enum(['source-unavailable', 'ambiguous-linkage', 'history-incomplete']) }).strict(),
]);
const eventSchema = z.object({
  eventId: uuid, eventType: z.string().min(1).max(120), runId: z.string().optional(), executionAttempt: z.number().int().positive().optional(),
  evidenceSemanticsVersion: z.string().min(1).max(120).optional(),
  completionStatus: z.enum(['completed', 'failed', 'cancelled']).optional(),
  coverageComplete: z.boolean().optional(),
  quorumSatisfied: z.boolean().optional(),
  headSha: sha.optional(), baseSha: sha.optional(), policyDigest: digest.optional(), configDigest: digest.optional(),
  contextDigest: digest.optional(), evidenceDigest: digest.optional(),
  verificationStatus: z.enum(['confirmed', 'contradicted', 'insufficient']),
  verification: z.object({ findingEventId: uuid.optional(), fingerprint: z.string().max(500).optional(),
    status: z.enum(['confirmed', 'contradicted', 'insufficient']).optional(),
    currentAffectedContextDigest: digest.optional(), sourceAffectedContextDigest: digest.optional() }).strict().optional(),
  disposition: findingDispositionEventSchema.optional(),
}).strict().superRefine((event, context) => {
  const hasCompletionProjection = event.completionStatus !== undefined || event.coverageComplete !== undefined
    || event.quorumSatisfied !== undefined;
  if (event.eventType !== 'review.completion_recorded' && hasCompletionProjection) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['completionStatus'],
      message: 'completion projection fields are valid only on completion events' });
  }
  const typedEvent = event.eventType.startsWith('finding.disposition.');
  if (typedEvent !== (event.disposition !== undefined)
    || (event.disposition && event.eventType !== `finding.disposition.${event.disposition.kind}`)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['disposition'], message: 'typed disposition event does not match its event type' });
  }
});
const findingSchema = z.object({
  findingEventId: uuid, durableFindingId: z.string().regex(/^lf1_[a-f0-9]{32}$/u).optional(),
  fingerprint: z.string().min(1).max(500), path: z.string().min(1).max(4096),
  claim: z.object({ title: z.string().max(1_000), body: z.string().max(4_000), trust: z.literal('untrusted') }).strict().optional(),
  groundedEvidenceSemanticsVersion: z.string().min(1).max(120).optional(),
  rootCause: z.object({ componentId: z.string().min(1).max(300), behaviorId: z.string().min(1).max(300),
    contractId: z.string().min(1).max(300), failureModeId: z.string().min(1).max(300) }).strict().optional(),
  causeAnchor: z.object({ componentPath: z.string().min(1).max(4096), side: z.enum(['head', 'base']),
    startLine: z.number().int().positive().safe(), endLine: z.number().int().positive().safe(),
    citationIds: z.array(z.string().min(1).max(256)).min(1).max(64), contentDigest: digest })
    .strict().optional(),
  sourceWindowManifestDigest: digest.optional(),
  regionStart: z.number().int().positive().optional(), regionEnd: z.number().int().positive().optional(),
  firstSeenHead: sha, lastSeenHead: sha, affectedContextDigest: digest,
  sourceSeverity: z.string().max(16), effectiveSeverity: z.string().max(16), disposition: z.string().max(32),
  blocking: z.boolean(), verificationStatus: z.enum(['confirmed', 'contradicted', 'insufficient']), evidenceDigest: digest,
}).strict();
const snapshotResponseSchema = z.object({
  version: z.literal('PrLifecycleHistorySnapshot.v1'), snapshotId: uuid,
  runId: z.string().regex(/^run_[a-f0-9]{32}$/u), executionAttempt: z.number().int().positive().safe(),
  repositoryId: z.number().int().positive().safe(), owner: z.string().min(1), repo: z.string().min(1),
  prNumber: z.number().int().positive().safe(), headSha: sha, baseSha: sha, policyDigest: digest,
  configDigest: digest, contextDigest: digest, eventCount: z.number().int().nonnegative().safe(),
  findingCount: z.number().int().nonnegative().safe(), eventOmittedCount: z.number().int().nonnegative().safe(),
  findingOmittedCount: z.number().int().nonnegative().safe(), legacyOmittedCount: z.number().int().nonnegative().safe(),
  authenticatedDisputes: authenticatedDisputesSchema,
  eventsDigest: digest, findingsDigest: digest, expiresAt: z.string().datetime(),
}).strict();
const pageResponseSchema = z.object({
  version: z.literal('PrLifecycleHistoryPage.v1'), snapshotId: uuid,
  collection: z.enum(['events', 'findings']), offset: z.number().int().nonnegative().safe(),
  limit: z.number().int().positive().max(250).safe(), totalCount: z.number().int().nonnegative().safe(),
  capturedCount: z.number().int().nonnegative().safe(), rows: z.array(z.unknown()).max(250),
  hasMore: z.boolean(), nextOffset: z.number().int().nonnegative().safe().nullable(),
}).strict();

export interface PrLifecycleHistoryFinding {
  findingEventId: string;
  durableFindingId?: string;
  fingerprint: string;
  path: string;
  claim?: { title: string; body: string; trust: 'untrusted' };
  groundedEvidenceSemanticsVersion?: string;
  rootCause?: { componentId: string; behaviorId: string; contractId: string; failureModeId: string };
  causeAnchor?: { componentPath: string; side: 'head' | 'base'; startLine: number; endLine: number;
    citationIds: string[]; contentDigest: string };
  sourceWindowManifestDigest?: string;
  regionStart?: number;
  regionEnd?: number;
  firstSeenHead: string;
  lastSeenHead: string;
  affectedContextDigest: string;
  sourceSeverity: string;
  effectiveSeverity: string;
  disposition: string;
  blocking: boolean;
  verificationStatus: 'confirmed' | 'contradicted' | 'insufficient';
  evidenceDigest: string;
}

export interface PrLifecycleHistoryEvent {
  eventId: string;
  eventType: string;
  runId?: string;
  executionAttempt?: number;
  evidenceSemanticsVersion?: string;
  completionStatus?: 'completed' | 'failed' | 'cancelled';
  coverageComplete?: boolean;
  quorumSatisfied?: boolean;
  headSha?: string;
  baseSha?: string;
  policyDigest?: string;
  configDigest?: string;
  contextDigest?: string;
  evidenceDigest?: string;
  verificationStatus: 'confirmed' | 'contradicted' | 'insufficient';
  verification?: { findingEventId?: string; fingerprint?: string; status?: 'confirmed' | 'contradicted' | 'insufficient';
    currentAffectedContextDigest?: string; sourceAffectedContextDigest?: string };
  disposition?: FindingDispositionEvent;
}

export interface PrLifecycleHistoryLoad {
  status: 'complete' | 'partial' | 'unavailable';
  snapshotId?: string;
  contextDigest?: string;
  events: readonly PrLifecycleHistoryEvent[];
  findings: readonly PrLifecycleHistoryFinding[];
  eventCount: number;
  findingCount: number;
  loadedEventCount: number;
  loadedFindingCount: number;
  eventOmittedCount: number;
  findingOmittedCount: number;
  legacyOmittedCount: number;
  eventsDigest?: string;
  findingsDigest?: string;
  omissions: readonly string[];
  authenticatedDisputes?: AuthenticatedDisputesProjection;
}

export interface PrLifecycleHistorySource {
  read(signal?: AbortSignal): Promise<PrLifecycleHistoryLoad>;
  recordVerification(input: {
    snapshotId: string;
    findingEventId: string;
    status: 'confirmed' | 'contradicted' | 'insufficient';
    currentContextDigest: string;
    currentAffectedContextDigest: string;
    evidence: Record<string, unknown>;
  }, signal?: AbortSignal): Promise<boolean>;
}

function unavailableLoad(reason: string): PrLifecycleHistoryLoad {
  return { status: 'unavailable', events: [], findings: [], eventCount: 0, findingCount: 0,
    loadedEventCount: 0, loadedFindingCount: 0, eventOmittedCount: 0, findingOmittedCount: 0,
    legacyOmittedCount: 0, omissions: [reason],
    authenticatedDisputes: { status: 'unavailable', disputes: [], paths: [], reason: 'source-unavailable' } };
}

function unavailable(): Error { return new Error('PR lifecycle history could not be read'); }

/** Sibling endpoint to the worker completion callback, using its exact-run bearer. */
export function prLifecycleHistoryEndpointFor(completionEndpoint: string): string {
  const endpoint = validateWorkerCompletionEndpoint(completionEndpoint);
  const url = new URL(endpoint);
  if (url.search || url.hash || !url.pathname.endsWith('/completion')) throw unavailable();
  url.pathname = `${url.pathname.slice(0, -'/completion'.length)}/pr-lifecycle-history`;
  return url.toString();
}

export class HttpPrLifecycleHistorySource implements PrLifecycleHistorySource {
  private readonly endpoint: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: {
    token: string;
    completionEndpoint: string;
    runId: string;
    executionAttempt: number;
    identity: { repositoryId: number; owner: string; repo: string; prNumber: number; headSha: string; baseSha: string;
      policyDigest: string; configDigest: string };
    timeoutMs?: number;
    fetchImplementation?: typeof fetch;
  }) {
    if (!isGitHubInstallationToken(options.token) || !/^run_[a-f0-9]{32}$/u.test(options.runId)
      || !Number.isSafeInteger(options.executionAttempt) || options.executionAttempt < 1
      || !Number.isSafeInteger(options.identity.repositoryId) || options.identity.repositoryId < 1
      || !Number.isSafeInteger(options.identity.prNumber) || options.identity.prNumber < 1
      || !sha.safeParse(options.identity.headSha).success || !sha.safeParse(options.identity.baseSha).success
      || !digest.safeParse(options.identity.policyDigest).success || !digest.safeParse(options.identity.configDigest).success) throw unavailable();
    this.endpoint = prLifecycleHistoryEndpointFor(options.completionEndpoint);
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 250 || this.timeoutMs > 30_000) throw unavailable();
    this.fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
  }

  async read(signal?: AbortSignal): Promise<PrLifecycleHistoryLoad> {
    try {
      const snapshot = await this.requestSnapshot(signal);
      const bound = snapshot.runId === this.options.runId && snapshot.executionAttempt === this.options.executionAttempt
        && snapshot.repositoryId === this.options.identity.repositoryId && snapshot.owner === this.options.identity.owner
        && snapshot.repo === this.options.identity.repo && snapshot.prNumber === this.options.identity.prNumber
        && snapshot.headSha === this.options.identity.headSha && snapshot.baseSha === this.options.identity.baseSha
        && snapshot.policyDigest === this.options.identity.policyDigest && snapshot.configDigest === this.options.identity.configDigest;
      if (!bound) throw unavailable();
      const events = await this.readCollection(snapshot, 'events', signal);
      const findings = await this.readCollection(snapshot, 'findings', signal);
      const eventCaptured = Math.max(0, snapshot.eventCount - snapshot.eventOmittedCount);
      const findingCaptured = Math.max(0, snapshot.findingCount - snapshot.findingOmittedCount);
      const eventIds = events.map((row) => row.eventId);
      const findingIds = findings.map((row) => row.findingEventId);
      const eventsDigest = sha256(canonicalJson(eventIds));
      const findingsDigest = sha256(canonicalJson(findingIds));
      const complete = events.length === eventCaptured && findings.length === findingCaptured
        && eventsDigest === snapshot.eventsDigest && findingsDigest === snapshot.findingsDigest;
      const omissions = [
        ...(snapshot.eventOmittedCount > 0 ? [`${snapshot.eventOmittedCount} lifecycle event(s) exceeded the snapshot capture bound`] : []),
        ...(snapshot.findingOmittedCount > 0 ? [`${snapshot.findingOmittedCount} finding event(s) exceeded the snapshot capture bound`] : []),
        ...(snapshot.legacyOmittedCount > 0 ? [`${snapshot.legacyOmittedCount} legacy completion record(s) were omitted as unverified context`] : []),
        ...(!complete ? ['history pages or digests were incomplete'] : []),
      ];
      const authenticatedDisputes: AuthenticatedDisputesProjection = complete ? snapshot.authenticatedDisputes : {
        status: 'unavailable', disputes: [] as const, paths: snapshot.authenticatedDisputes.paths, reason: 'history-incomplete',
      };
      return {
        status: complete ? (omissions.length === 0 ? 'complete' : 'partial') : 'partial',
        snapshotId: snapshot.snapshotId,
        contextDigest: snapshot.contextDigest,
        // Partial history is disclosed but unusable as evidence to waive or resolve any finding.
        events: complete ? events : [], findings: complete ? findings : [],
        eventCount: snapshot.eventCount, findingCount: snapshot.findingCount,
        loadedEventCount: events.length, loadedFindingCount: findings.length,
        eventOmittedCount: snapshot.eventOmittedCount, findingOmittedCount: snapshot.findingOmittedCount,
        legacyOmittedCount: snapshot.legacyOmittedCount, eventsDigest, findingsDigest, omissions,
        authenticatedDisputes,
      };
    } catch {
      return unavailableLoad('service-owned lifecycle history could not be loaded completely');
    }
  }

  async recordVerification(input: {
    snapshotId: string;
    findingEventId: string;
    status: 'confirmed' | 'contradicted' | 'insufficient';
    currentContextDigest: string;
    currentAffectedContextDigest: string;
    evidence: Record<string, unknown>;
  }, signal?: AbortSignal): Promise<boolean> {
    const parsed = z.object({ snapshotId: uuid, findingEventId: uuid,
      status: z.enum(['confirmed', 'contradicted', 'insufficient']), currentContextDigest: digest,
      currentAffectedContextDigest: digest, evidence: z.record(z.string(), z.unknown()) }).strict().safeParse(input);
    if (!parsed.success || Buffer.byteLength(canonicalJson(input.evidence), 'utf8') > 32_000) return false;
    try {
      const response = await this.post({
        version: 'PrLifecycleFindingVerificationRequest.v1', runId: this.options.runId,
        executionAttempt: this.options.executionAttempt, ...input,
      }, signal);
      if (response.status !== 200) { void response.body?.cancel().catch(() => undefined); return false; }
      const body = await this.readJson(response);
      return body.version === 'PrLifecycleFindingVerification.v1' && body.status === 'recorded';
    } catch { return false; }
  }

  private async requestSnapshot(signal?: AbortSignal) {
    const response = await this.post({ version: 'PrLifecycleHistorySnapshotRequest.v1', runId: this.options.runId,
      executionAttempt: this.options.executionAttempt }, signal);
    if (response.status !== 200) { void response.body?.cancel().catch(() => undefined); throw unavailable(); }
    return snapshotResponseSchema.parse(await this.readJson(response));
  }

  private async readCollection(snapshot: z.infer<typeof snapshotResponseSchema>, collection: 'events' | 'findings', signal?: AbortSignal) {
    const totalCount = collection === 'events' ? snapshot.eventCount : snapshot.findingCount;
    const omittedCount = collection === 'events' ? snapshot.eventOmittedCount : snapshot.findingOmittedCount;
    const capturedCount = Math.max(0, totalCount - omittedCount);
    const rows: Array<z.infer<typeof eventSchema> | z.infer<typeof findingSchema>> = [];
    let offset = 0;
    while (offset < capturedCount) {
      const response = await this.post({ version: 'PrLifecycleHistoryPageRequest.v1', runId: this.options.runId,
        executionAttempt: this.options.executionAttempt, snapshotId: snapshot.snapshotId, collection, offset,
        limit: PR_LIFECYCLE_HISTORY_PAGE_SIZE }, signal);
      if (response.status !== 200) { void response.body?.cancel().catch(() => undefined); throw unavailable(); }
      const page = pageResponseSchema.parse(await this.readJson(response));
      if (page.snapshotId !== snapshot.snapshotId || page.collection !== collection || page.offset !== offset
        || page.limit !== PR_LIFECYCLE_HISTORY_PAGE_SIZE || page.totalCount !== totalCount || page.capturedCount !== capturedCount
        || page.rows.length === 0 || page.hasMore !== (offset + page.rows.length < capturedCount)
        || page.nextOffset !== (page.hasMore ? offset + page.rows.length : null)) throw unavailable();
      rows.push(...page.rows.map((row) => collection === 'events' ? eventSchema.parse(row) : findingSchema.parse(row)));
      offset = page.nextOffset ?? capturedCount;
    }
    if (rows.length !== capturedCount) throw unavailable();
    return rows as Array<z.infer<typeof eventSchema> & { eventId: string } & z.infer<typeof findingSchema> & { findingEventId: string }>;
  }

  private async post(body: unknown, signal?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImplementation(this.endpoint, { method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { Accept: 'application/json', Authorization: `Bearer ${this.options.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body) });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) controller.abort();
    }
  }

  private async readJson(response: Response): Promise<any> {
    if (!response.body) throw unavailable();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_PR_LIFECYCLE_HISTORY_RESPONSE_BYTES) throw unavailable();
        chunks.push(chunk.value);
      }
    } finally { void reader.cancel().catch(() => undefined); }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  }
}
