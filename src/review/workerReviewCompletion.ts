import { z } from 'zod';
import { computeAppVerdict } from './reviewAdapters';
import type { CanonicalArbitration, ReviewChangedFile, ReviewFinding, ReviewLane } from './reviewCore';
import { canonicalJson, sha256, validateReviewFindings } from './reviewCore';
import type { ReviewGateEvidence } from './reviewGatePolicy';
import { workerFailureClasses } from './workerCompletion';

/**
 * The success callback is deliberately smaller than the worker's operational receipt. It carries
 * the persona evidence needed for the service to re-run the existing canonical arbitration, while
 * excluding anything that could select or complete a GitHub check.
 */
export const WORKER_REVIEW_COMPLETION_VERSION = 'WorkerReviewCompletion.v1' as const;
export const WORKER_REVIEW_RESULT_VERSION = 'WorkerReviewResult.v1' as const;

/** The outer JSON document is bounded by UTF-8 bytes; string limits are JavaScript UTF-16 code units. */
export const MAX_COMPLETION_BYTES = 1_000_000;
export const MAX_PERSONAS = 64;
export const MAX_FINDINGS_PER_PERSONA = 400;
export const MAX_TOTAL_FINDINGS = MAX_PERSONAS * MAX_FINDINGS_PER_PERSONA;
export const MAX_CHANGED_FILES = 10_000;
export const MAX_CHANGED_FILE_PATCH_BYTES = 512_000;
export const MAX_TEXT_CHARACTERS = 16_000;
export const MAX_TITLE_CHARACTERS = 4_000;
export const MAX_CODE_CHARACTERS = 10_000;
export const MAX_PATH_CHARACTERS = 4_096;

const sha = z.string().regex(/^[a-f0-9]{40}$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const positiveInteger = z.number().int().positive().safe();
const boundedInteger = z.number().int().nonnegative().safe();
const boundedText = (max = MAX_TEXT_CHARACTERS) => z.string().min(1).max(max);

const findingSchema = z.object({
  severity: z.enum(['P0', 'P1', 'P2']),
  path: z.string().min(1).max(MAX_PATH_CHARACTERS),
  line: positiveInteger,
  startLine: positiveInteger.optional(),
  title: boundedText(MAX_TITLE_CHARACTERS),
  body: boundedText(MAX_TEXT_CHARACTERS),
  suggestion: z.string().max(MAX_TEXT_CHARACTERS).nullable().optional(),
  replacementCode: z.string().max(MAX_CODE_CHARACTERS).nullable().optional(),
  confidence: z.number().finite().min(0).max(100).optional(),
  recommendation: z.string().max(MAX_TEXT_CHARACTERS).optional(),
  fixOptions: z.array(z.object({
    rank: positiveInteger.optional(),
    title: z.string().max(2_000).optional(),
    explanation: z.string().max(MAX_TEXT_CHARACTERS).optional(),
    suggestionCode: z.string().max(MAX_CODE_CHARACTERS).optional(),
  }).strict()).max(8).optional(),
  isArchitectural: z.boolean().optional(),
}).strict().superRefine((finding, context) => {
  if (finding.startLine !== undefined && finding.startLine > finding.line) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['startLine'], message: 'startLine must not exceed line' });
  }
});

const personaSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,127}$/u),
  decision: z.enum(['APPROVE', 'FINDINGS', 'ERROR']),
  status: z.enum(['COMPLETE', 'ERROR']).optional(),
  /** Bounded operational classification only; provider text/transcripts never cross this boundary. */
  errorClass: z.enum(workerFailureClasses).optional(),
  findings: z.array(findingSchema).max(MAX_FINDINGS_PER_PERSONA),
}).strict().superRefine((persona, context) => {
  const errorLane = persona.decision === 'ERROR' || persona.status === 'ERROR';
  if (errorLane && persona.errorClass === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['errorClass'], message: 'errorClass is required for an error lane' });
  }
  if (!errorLane && persona.errorClass !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['errorClass'], message: 'errorClass is only valid for an error lane' });
  }
});

const completionCoordinatesSchema = z.object({
  runId: z.string().regex(/^run_[a-f0-9]{32}$/u),
  repositoryId: positiveInteger,
  owner: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/u),
  repo: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/u),
  prNumber: positiveInteger,
  headSha: sha,
  baseSha: sha,
  policyDigest: digest,
  configDigest: digest,
  executionAttempt: positiveInteger,
}).strict();

const resultSchema = z.object({
  version: z.literal(WORKER_REVIEW_RESULT_VERSION),
  completedAt: z.string().datetime({ offset: true }),
  personas: z.array(personaSchema).max(MAX_PERSONAS),
  coverageComplete: z.boolean(),
  quorumSatisfied: z.boolean(),
  /** Optional worker-computed summaries; consistency checks only, never eligibility authority. */
  verdict: z.enum(['SHIP', 'FIX_FIRST', 'BLOCK']).optional(),
  findingCount: boundedInteger.max(MAX_TOTAL_FINDINGS).optional(),
  blockingFindingCount: boundedInteger.max(MAX_TOTAL_FINDINGS).optional(),
}).strict();

const completionSchema = z.object({
  version: z.literal(WORKER_REVIEW_COMPLETION_VERSION),
  ...completionCoordinatesSchema.shape,
  result: resultSchema,
}).strict();

export const workerReviewCompletionSchema = completionSchema;

export type WorkerReviewCompletion = z.infer<typeof completionSchema>;
export type WorkerReviewResult = z.infer<typeof resultSchema>;
export type WorkerReviewPersonaEvidence = z.infer<typeof personaSchema>;
export type TrustedWorkerReviewCoordinates = z.infer<typeof completionCoordinatesSchema>;

export interface TrustedReviewCoverageContract {
  /** The service-owned run identity that the authenticated worker result must exactly match. */
  expectedCoordinates: TrustedWorkerReviewCoordinates;
  /** Supplied by the service's trusted policy/config resolution, never by the worker. */
  expectedPersonaIds: readonly string[];
  /** Exact changed-file evidence already read by the service for the admitted head. */
  changedFiles: readonly ReviewChangedFile[];
  /** Trusted service-side coverage and quorum decisions. */
  coverageComplete: boolean;
  quorumSatisfied: boolean;
}

export interface DerivedWorkerReviewEvidence {
  valid: true;
  canonical: CanonicalArbitration;
  evidence: ReviewGateEvidence;
}

export interface InvalidWorkerReviewEvidence {
  valid: false;
  reason: 'invalid-evidence';
  message: string;
  canonical?: CanonicalArbitration;
  evidence?: ReviewGateEvidence;
}

export type WorkerReviewEvidenceDerivation = DerivedWorkerReviewEvidence | InvalidWorkerReviewEvidence;

export type WorkerReviewCompletionErrorCode = 'payload-too-large' | 'invalid-schema' | 'invalid-contract';

export class WorkerReviewCompletionError extends Error {
  constructor(public readonly code: WorkerReviewCompletionErrorCode, message: string) {
    super(message);
    this.name = 'WorkerReviewCompletionError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function serializedByteLength(value: unknown): number {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new WorkerReviewCompletionError('invalid-schema', 'worker review completion must be JSON-serializable');
  }
  if (typeof serialized !== 'string') {
    throw new WorkerReviewCompletionError('invalid-schema', 'worker review completion must be a JSON value');
  }
  // MAX_COMPLETION_BYTES applies to the complete serialized UTF-8 JSON document,
  // not to any one text field. Individual text fields use JavaScript string-length limits.
  return Buffer.byteLength(serialized, 'utf8');
}

function issuePath(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue ? `${issue.path.join('.')} ${issue.message}`.trim() : 'schema validation failed';
}

function validateChangedFiles(changedFiles: readonly ReviewChangedFile[]): ReviewChangedFile[] {
  if (!Array.isArray(changedFiles) || changedFiles.length === 0 || changedFiles.length > MAX_CHANGED_FILES) {
    throw new WorkerReviewCompletionError('invalid-contract', 'trusted changed-file coverage must contain one or more bounded files');
  }
  return changedFiles.map((file, index) => {
    if (!file || typeof file.path !== 'string' || file.path.length === 0 || file.path.length > MAX_PATH_CHARACTERS) {
      throw new WorkerReviewCompletionError('invalid-contract', `trusted changed file ${index} has an invalid path`);
    }
    if (file.patch !== undefined && (typeof file.patch !== 'string' || Buffer.byteLength(file.patch, 'utf8') > MAX_CHANGED_FILE_PATCH_BYTES)) {
      throw new WorkerReviewCompletionError('invalid-contract', `trusted changed file ${index} patch exceeds its bound`);
    }
    return { ...file };
  });
}

function validateCoverageContract(contract: TrustedReviewCoverageContract): string[] {
  if (!contract || !Array.isArray(contract.expectedPersonaIds) || contract.expectedPersonaIds.length === 0 || contract.expectedPersonaIds.length > MAX_PERSONAS) {
    throw new WorkerReviewCompletionError('invalid-contract', 'trusted expected persona IDs are required and bounded');
  }
  const expected = contract.expectedPersonaIds.map((id) => {
    if (typeof id !== 'string' || !/^[a-z][a-z0-9_-]{0,127}$/u.test(id)) {
      throw new WorkerReviewCompletionError('invalid-contract', 'trusted expected persona ID is invalid');
    }
    return id;
  });
  if (new Set(expected).size !== expected.length) {
    throw new WorkerReviewCompletionError('invalid-contract', 'trusted expected persona IDs must be unique');
  }
  if (typeof contract.coverageComplete !== 'boolean' || typeof contract.quorumSatisfied !== 'boolean') {
    throw new WorkerReviewCompletionError('invalid-contract', 'trusted coverage contract booleans are required');
  }
  validateChangedFiles(contract.changedFiles);
  return expected;
}

function validateTrustedCoordinates(input: unknown): TrustedWorkerReviewCoordinates {
  const parsed = completionCoordinatesSchema.safeParse(input);
  if (!parsed.success) {
    throw new WorkerReviewCompletionError('invalid-contract', `trusted review coordinates are invalid: ${issuePath(parsed.error)}`);
  }
  return parsed.data;
}

const coordinateKeys: readonly (keyof TrustedWorkerReviewCoordinates)[] = [
  'runId', 'repositoryId', 'owner', 'repo', 'prNumber', 'headSha', 'baseSha',
  'policyDigest', 'configDigest', 'executionAttempt',
];

function coordinatesMatch(completion: WorkerReviewCompletion, expected: TrustedWorkerReviewCoordinates): boolean {
  return coordinateKeys.every((key) => completion[key] === expected[key]);
}

/** Parse the authenticated success payload before any result is treated as review evidence. */
export function parseWorkerReviewCompletion(input: unknown): WorkerReviewCompletion {
  if (!isRecord(input)) {
    throw new WorkerReviewCompletionError('invalid-schema', 'worker review completion must be a JSON object');
  }
  if (serializedByteLength(input) > MAX_COMPLETION_BYTES) {
    throw new WorkerReviewCompletionError('payload-too-large', `worker review completion exceeds ${MAX_COMPLETION_BYTES} bytes`);
  }
  const parsed = completionSchema.safeParse(input);
  if (!parsed.success) {
    throw new WorkerReviewCompletionError('invalid-schema', `invalid WorkerReviewCompletion.v1: ${issuePath(parsed.error)}`);
  }
  return parsed.data;
}

function invalidEvidence(
  message: string,
  canonical?: CanonicalArbitration,
  evidence?: ReviewGateEvidence,
): InvalidWorkerReviewEvidence {
  return { valid: false, reason: 'invalid-evidence', message, ...(canonical ? { canonical } : {}), ...(evidence ? { evidence } : {}) };
}

function hasInfrastructureFailure(persona: WorkerReviewPersonaEvidence): boolean {
  return persona.decision === 'ERROR' || persona.status === 'ERROR' || persona.errorClass !== undefined;
}

function rawFieldsMatchCanonical(result: WorkerReviewResult, canonical: CanonicalArbitration): string | null {
  if (result.verdict !== undefined && result.verdict !== canonical.verdict) {
    return `worker verdict ${result.verdict} disagrees with canonical verdict ${canonical.verdict}`;
  }
  if (result.findingCount !== undefined && result.findingCount !== canonical.metrics.totalFindings) {
    return `worker finding count ${result.findingCount} disagrees with canonical count ${canonical.metrics.totalFindings}`;
  }
  const blockingCount = canonical.metrics.p0Count + canonical.metrics.p1Count;
  if (result.blockingFindingCount !== undefined && result.blockingFindingCount !== blockingCount) {
    return `worker blocking finding count ${result.blockingFindingCount} disagrees with canonical count ${blockingCount}`;
  }
  return null;
}

/**
 * Re-derives service evidence from the worker's persona lanes. The worker's verdict and summary
 * counts are checked for consistency only; `computeAppVerdict` is the decision source. Required
 * lanes and coverage remain service-owned inputs.
 */
export function deriveCanonicalWorkerReviewEvidence(
  input: unknown,
  contract: TrustedReviewCoverageContract,
): WorkerReviewEvidenceDerivation {
  const completion = parseWorkerReviewCompletion(input);
  const expectedCoordinates = validateTrustedCoordinates(contract?.expectedCoordinates);
  const expectedPersonaIds = validateCoverageContract(contract);
  if (!coordinatesMatch(completion, expectedCoordinates)) {
    return invalidEvidence('worker completion coordinates do not match the trusted review run identity');
  }
  const expected = new Set(expectedPersonaIds);
  const seen = new Set<string>();

  for (const persona of completion.result.personas) {
    if (seen.has(persona.id)) return invalidEvidence(`duplicate persona lane: ${persona.id}`);
    if (!expected.has(persona.id)) return invalidEvidence(`unknown persona lane: ${persona.id}`);
    seen.add(persona.id);
  }

  const changedFiles = validateChangedFiles(contract.changedFiles);
  const lanes: ReviewLane[] = [];
  for (const persona of completion.result.personas) {
    const validation = validateReviewFindings(persona.findings, changedFiles);
    if (!validation.valid) {
      const suffix = validation.index === undefined ? '' : ` at index ${validation.index}`;
      return invalidEvidence(`invalid findings for persona ${persona.id}${suffix}: ${validation.error || 'unknown error'}`);
    }
    lanes.push({
      id: persona.id,
      decision: persona.decision,
      ...(persona.status ? { status: persona.status } : {}),
      findings: validation.findings as ReviewFinding[],
    });
  }

  const coverageComplete = contract.coverageComplete && completion.result.coverageComplete;
  const canonical = computeAppVerdict({
    lanes,
    expectedLanes: expectedPersonaIds.length,
    changedFiles,
    coverageComplete,
  });
  const quorumSatisfied = contract.quorumSatisfied && completion.result.quorumSatisfied && canonical.quorumSatisfied;
  const evidence: ReviewGateEvidence = {
    verdict: canonical.verdict,
    completedAt: completion.result.completedAt,
    coverageComplete,
    quorumSatisfied,
    infrastructureFailure: completion.result.personas.some(hasInfrastructureFailure),
    p0Count: canonical.metrics.p0Count,
    p1Count: canonical.metrics.p1Count,
    expectedLanes: expectedPersonaIds.length,
    completedLanes: canonical.completedPersonas,
  };

  const mismatch = rawFieldsMatchCanonical(completion.result, canonical);
  if (mismatch) return invalidEvidence(mismatch, canonical, evidence);
  return { valid: true, canonical, evidence };
}

/** Stable digest helper for the later artifact store integration. */
export function workerReviewCompletionDigest(input: unknown): string {
  return sha256(canonicalJson(parseWorkerReviewCompletion(input)));
}
