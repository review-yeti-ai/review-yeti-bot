import { z } from 'zod';
import { constantTimeDigestEqual } from '../utils/constantTimeDigest';
import { canonicalJson, sha256 } from './reviewCore';
import {
  incompleteP2RecoveryClaimSchema,
  type IncompleteP2RecoveryClaim,
} from './incompleteP2RecoveryClaim';

export { incompleteP2RecoveryClaimSchema } from './incompleteP2RecoveryClaim';
export type { IncompleteP2RecoveryClaim } from './incompleteP2RecoveryClaim';

export const INCOMPLETE_P2_RECOVERY_CONTEXT_VERSION = 'IncompleteP2RecoveryContext.v1' as const;
export const MAX_INCOMPLETE_P2_RECOVERY_PRIOR_ATTEMPTS = 2;
export const MAX_INCOMPLETE_P2_RECOVERY_FINDINGS = 100;
export const MAX_INCOMPLETE_P2_RECOVERY_BYTES = 64 * 1024;

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const sha = z.string().regex(/^[a-f0-9]{40}$/u);
const positiveInteger = z.number().int().positive().safe();
const nonnegativeInteger = z.number().int().nonnegative().safe();

const identitySchema = z.object({
  runId: z.string().regex(/^run_[a-f0-9]{32}$/u),
  repositoryId: positiveInteger,
  owner: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/u),
  repo: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/u),
  prNumber: positiveInteger,
  headSha: sha,
  baseSha: sha,
  policyDigest: digest,
  configDigest: digest,
  expectedAppId: positiveInteger,
  executionAttempt: z.number().int().min(2).max(MAX_INCOMPLETE_P2_RECOVERY_PRIOR_ATTEMPTS + 1).safe(),
}).strict();

/** A P2 finding is copied byte-for-byte at the JSON field level from an
 * already-validated WorkerReviewCompletion. No truncation or recalibration is
 * allowed in the carry-forward context. */
const preservedFindingSchema = z.object({
  severity: z.literal('P2'),
  path: z.string().min(1).max(8_000),
  line: positiveInteger,
  startLine: positiveInteger.optional(),
  title: z.string().min(1).max(4_000),
  body: z.string().min(1).max(16_000),
  suggestion: z.string().max(16_000).nullable().optional(),
  replacementCode: z.string().max(10_000).nullable().optional(),
  confidence: z.number().finite().min(0).max(100).optional(),
  recommendation: z.string().max(16_000).optional(),
  fixOptions: z.array(z.object({
    rank: positiveInteger.optional(),
    title: z.string().max(2_000).optional(),
    explanation: z.string().max(16_000).optional(),
    suggestionCode: z.string().max(10_000).optional(),
  }).strict()).max(8).optional(),
  isArchitectural: z.boolean().optional(),
}).strict();

const sourceSchema = z.object({
  executionAttempt: positiveInteger,
  workerResultDigest: digest,
  workerCheckId: positiveInteger,
  gateCheckId: positiveInteger,
  rawFindingCount: z.number().int().min(0).max(MAX_INCOMPLETE_P2_RECOVERY_FINDINGS).safe(),
  canonicalFindingCount: z.number().int().min(0).max(MAX_INCOMPLETE_P2_RECOVERY_FINDINGS).safe(),
}).strict();

const findingWithProvenanceSchema = z.object({
  sourceExecutionAttempt: positiveInteger,
  sourceWorkerResultDigest: digest,
  sourceWorkerCheckId: positiveInteger,
  sourceGateCheckId: positiveInteger,
  personaId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u),
  findingIndex: nonnegativeInteger,
  finding: preservedFindingSchema,
}).strict();

const contextContentObjectSchema = z.object({
  version: z.literal(INCOMPLETE_P2_RECOVERY_CONTEXT_VERSION),
  ...identitySchema.shape,
  sources: z.array(sourceSchema).min(1).max(MAX_INCOMPLETE_P2_RECOVERY_PRIOR_ATTEMPTS),
  findings: z.array(findingWithProvenanceSchema).min(1).max(MAX_INCOMPLETE_P2_RECOVERY_FINDINGS),
}).strict();

function validateContextContent(
  context: z.infer<typeof contextContentObjectSchema>,
  issue: z.RefinementCtx,
): void {
  if (context.sources.length !== context.executionAttempt - 1) {
    issue.addIssue({ code: z.ZodIssueCode.custom, path: ['sources'], message: 'all prior execution attempts are required' });
  }
  const sources = new Map<number, z.infer<typeof sourceSchema>>();
  context.sources.forEach((source, index) => {
    if (source.executionAttempt !== index + 1) {
      issue.addIssue({ code: z.ZodIssueCode.custom, path: ['sources', index, 'executionAttempt'], message: 'source attempts must be contiguous and ordered' });
    }
    sources.set(source.executionAttempt, source);
    if (source.canonicalFindingCount > source.rawFindingCount) {
      issue.addIssue({ code: z.ZodIssueCode.custom, path: ['sources', index, 'canonicalFindingCount'], message: 'canonical count cannot exceed raw count' });
    }
  });

  const findingCounts = new Map<number, number>();
  const seen = new Set<string>();
  context.findings.forEach((entry, index) => {
    const source = sources.get(entry.sourceExecutionAttempt);
    if (!source || source.workerResultDigest !== entry.sourceWorkerResultDigest
      || source.workerCheckId !== entry.sourceWorkerCheckId || source.gateCheckId !== entry.sourceGateCheckId) {
      issue.addIssue({ code: z.ZodIssueCode.custom, path: ['findings', index], message: 'finding provenance does not match its source attempt' });
    }
    const key = `${entry.sourceExecutionAttempt}:${entry.personaId}:${entry.findingIndex}`;
    if (seen.has(key)) issue.addIssue({ code: z.ZodIssueCode.custom, path: ['findings', index], message: 'duplicate source finding' });
    seen.add(key);
    findingCounts.set(entry.sourceExecutionAttempt, (findingCounts.get(entry.sourceExecutionAttempt) || 0) + 1);
  });
  context.sources.forEach((source, index) => {
    if ((findingCounts.get(source.executionAttempt) ?? 0) !== source.rawFindingCount) {
      issue.addIssue({ code: z.ZodIssueCode.custom, path: ['sources', index, 'rawFindingCount'], message: 'raw finding count does not match preserved findings' });
    }
  });
}

const contextContentSchema = contextContentObjectSchema.superRefine(validateContextContent);

export const incompleteP2RecoveryContextSchema = z.object({
  ...contextContentObjectSchema.shape,
  contextDigest: digest,
}).strict().superRefine(validateContextContent);

export type IncompleteP2RecoveryIdentity = z.infer<typeof identitySchema>;
export type IncompleteP2RecoverySource = z.infer<typeof sourceSchema>;
export type IncompleteP2RecoveryFinding = z.infer<typeof findingWithProvenanceSchema>;
export type IncompleteP2RecoveryContext = z.infer<typeof incompleteP2RecoveryContextSchema>;

export class IncompleteP2RecoveryContextError extends Error {
  readonly name = 'IncompleteP2RecoveryContextError';

  constructor() {
    super('Incomplete P2 recovery context is unavailable or invalid');
  }
}

function contextDigestFor(content: z.infer<typeof contextContentSchema>): string {
  return sha256(canonicalJson(content));
}

/** Builds and validates the immutable service-owned context. */
export function createIncompleteP2RecoveryContext(
  content: z.input<typeof contextContentSchema>,
): IncompleteP2RecoveryContext {
  try {
    const parsed = contextContentSchema.parse(content);
    const context = { ...parsed, contextDigest: contextDigestFor(parsed) };
    return parseIncompleteP2RecoveryContext(context);
  } catch {
    throw new IncompleteP2RecoveryContextError();
  }
}

/** Parse an untrusted or persisted context, enforce the payload cap, and
 * verify its content digest before any consumer uses the findings. */
export function parseIncompleteP2RecoveryContext(input: unknown): IncompleteP2RecoveryContext {
  try {
    const parsed = incompleteP2RecoveryContextSchema.parse(input);
    const { contextDigest, ...content } = parsed;
    if (!constantTimeDigestEqual(contextDigest, contextDigestFor(content))) {
      throw new IncompleteP2RecoveryContextError();
    }
    if (Buffer.byteLength(JSON.stringify(parsed), 'utf8') > MAX_INCOMPLETE_P2_RECOVERY_BYTES) {
      throw new IncompleteP2RecoveryContextError();
    }
    return parsed;
  } catch {
    throw new IncompleteP2RecoveryContextError();
  }
}

/** Exact receipt shape required from the worker when a context was admitted. */
export function incompleteP2RecoveryClaimFor(context: IncompleteP2RecoveryContext): IncompleteP2RecoveryClaim {
  const parsed = parseIncompleteP2RecoveryContext(context);
  return incompleteP2RecoveryClaimSchema.parse({
    version: 'IncompleteP2RecoveryClaim.v1',
    contextDigest: parsed.contextDigest,
    sources: parsed.sources.map(({ executionAttempt, workerResultDigest, workerCheckId, gateCheckId }) => ({
      executionAttempt, workerResultDigest, workerCheckId, gateCheckId,
    })),
  });
}

/** Matches the worker receipt to every immutable source in the service's
 * context. A matching top-level digest alone is not enough if source metadata
 * was omitted or reordered. */
export function incompleteP2RecoveryClaimMatches(context: unknown, claim: unknown): boolean {
  try {
    const parsedContext = parseIncompleteP2RecoveryContext(context);
    const parsedClaim = incompleteP2RecoveryClaimSchema.parse(claim);
    return constantTimeDigestEqual(parsedClaim.contextDigest, parsedContext.contextDigest)
      && canonicalJson(parsedClaim.sources) === canonicalJson(incompleteP2RecoveryClaimFor(parsedContext).sources);
  } catch {
    return false;
  }
}
