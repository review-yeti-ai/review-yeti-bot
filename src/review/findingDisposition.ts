import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

export const FINDING_DISPOSITION_VERSION = 'PrFindingDisposition.v1' as const;

export const FINDING_DISPOSITION_KINDS = [
  'author_explanation',
  'adjudicated_false_positive',
  'accepted_convention',
  'fixed',
  'regressed',
] as const;

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const sha = z.string().regex(/^[a-f0-9]{40}$/u);
const fingerprint = z.string().regex(/^fp1_[a-f0-9]{24}$/u);
const findingId = z.string().regex(/^lf1_[a-f0-9]{32}$/u);
const eventId = z.string().uuid();

const provenanceSchema = z.object({
  actorType: z.enum(['human', 'service']),
  actorDigest: digest,
  source: z.enum(['github_review_thread', 'grounded_verifier', 'trusted_operator_adjudication']),
  receiptDigest: digest,
  sourceIdDigest: digest.optional(),
  permission: z.enum(['admin', 'maintain']).optional(),
}).strict();

const common = {
  version: z.literal(FINDING_DISPOSITION_VERSION),
  findingId,
  fingerprint,
  sourceOccurrenceKey: z.string().min(1).max(512).optional(),
  path: z.string().min(1).max(4_096),
  runId: z.string().regex(/^run_[a-f0-9]{32}$/u),
  executionAttempt: z.number().int().positive().safe(),
  headSha: sha,
  baseSha: sha,
  policyDigest: digest,
  configDigest: digest,
  contextDigest: digest,
  affectedContextDigest: digest,
  evidenceDigest: digest,
  provenance: provenanceSchema,
};

const authorExplanation = z.object({
  ...common,
  kind: z.literal('author_explanation'),
  provenance: provenanceSchema.extend({
    actorType: z.literal('human'), source: z.literal('github_review_thread'), sourceIdDigest: digest,
  }).strict(),
  explanation: z.object({ text: z.string().min(1).max(1_000), trust: z.literal('untrusted') }).strict(),
}).strict();

const adjudicatedFalsePositive = z.object({
  ...common,
  kind: z.literal('adjudicated_false_positive'),
  provenance: provenanceSchema.extend({ actorType: z.literal('service'), source: z.literal('grounded_verifier') }).strict(),
  adjudication: z.object({ method: z.literal('independent_grounded_verifier'), status: z.literal('contradicted'),
    proofDigest: digest }).strict(),
}).strict();

const acceptedConvention = z.object({
  ...common,
  kind: z.literal('accepted_convention'),
  provenance: provenanceSchema.extend({
    actorType: z.literal('human'), source: z.literal('trusted_operator_adjudication'),
    sourceIdDigest: digest, permission: z.enum(['admin', 'maintain']),
  }).strict(),
  adjudication: z.object({ method: z.literal('authorized_human'), conventionId: z.string().min(1).max(200),
    status: z.literal('accepted'), proofDigest: digest }).strict(),
}).strict();

const fixed = z.object({
  ...common,
  kind: z.literal('fixed'),
  provenance: provenanceSchema.extend({ actorType: z.literal('service'), source: z.literal('grounded_verifier') }).strict(),
  adjudication: z.object({ method: z.literal('independent_grounded_verifier'), status: z.literal('contradicted'),
    proofDigest: digest, priorFindingEventId: eventId, changedContextDigest: digest }).strict(),
}).strict();

const regressed = z.object({
  ...common,
  kind: z.literal('regressed'),
  provenance: provenanceSchema.extend({ actorType: z.literal('service'), source: z.literal('grounded_verifier') }).strict(),
  adjudication: z.object({ method: z.literal('independent_grounded_verifier'), status: z.literal('confirmed'),
    proofDigest: digest, priorFixedEventId: eventId, rootCauseEvidenceKey: z.string().min(1).max(512),
    causalScope: z.enum(['introduced', 'exacerbated']) }).strict(),
}).strict();

/**
 * Append-only history categories with different evidence and authority requirements. An author
 * explanation is always untrusted context. Only a service-validated verifier receipt can record
 * a false positive, fix, or regression; accepted conventions require a separate authorized human
 * adjudication receipt. No worker JSON actor field is sufficient provenance for these events.
 */
export const findingDispositionEventSchema = z.discriminatedUnion('kind', [
  authorExplanation,
  adjudicatedFalsePositive,
  acceptedConvention,
  fixed,
  regressed,
]);

export type FindingDispositionKind = typeof FINDING_DISPOSITION_KINDS[number];
export type FindingDispositionEvent = z.infer<typeof findingDispositionEventSchema>;
type WithoutDurableId<T> = T extends unknown ? Omit<T, 'findingId'> & { findingId?: string } : never;
/** Service-only draft; the persistence transaction binds it to the durable ID it assigned. */
export type FindingDispositionDraft = WithoutDurableId<FindingDispositionEvent> & { sourceOccurrenceKey?: string };

export function findingDispositionEventType(kind: FindingDispositionKind): `finding.disposition.${FindingDispositionKind}` {
  if (!FINDING_DISPOSITION_KINDS.includes(kind)) throw new Error('Invalid finding lifecycle disposition');
  return `finding.disposition.${kind}`;
}

/**
 * First-seen durable identity for a PR finding. The current source-window key is deliberately not
 * part of this identity. Cross-path or refactor continuity must be persisted as a verified alias
 * after ancestry, source mapping, and cause evidence have all been checked.
 */
export function durableFindingIdFor(lifecycleId: string, value: string): string {
  if (!z.string().uuid().safeParse(lifecycleId).success || !fingerprint.safeParse(value).success) {
    throw new Error('Invalid lifecycle finding identity input');
  }
  const material = `review-yeti-finding-id.v1\0${lifecycleId.toLowerCase()}\0${value}`;
  return `lf1_${createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 32)}`;
}

/** Opaque first-seen ID. Source path, span, and window digests stay mutable evidence in the ledger. */
export function newDurableFindingId(): string {
  return `lf1_${randomUUID().replaceAll('-', '')}`;
}
