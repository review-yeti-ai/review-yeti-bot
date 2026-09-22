import { z } from 'zod';
import { computeAppVerdict } from './reviewAdapters';
import type { CanonicalArbitration, ReviewChangedFile, ReviewFinding, ReviewLane } from './reviewCore';
import { canonicalJson, sha256, validateReviewFindings } from './reviewCore';
import type { ReviewGateEvidence } from './reviewGatePolicy';
import { workerFailureClasses, workerFailureDiagnosticsSchema } from './workerCompletion';
import { isDocumentationOrAssetPath } from './reviewableContent';
import { MAX_CHANGED_FILES, MAX_CHANGED_FILE_PATCH_BYTES, MAX_PATH_CHARACTERS } from './reviewEvidenceLimits';
import { getMetrics } from '../telemetry';
import { logger } from '../utils/logger';

export { MAX_CHANGED_FILES, MAX_CHANGED_FILE_PATCH_BYTES, MAX_PATH_CHARACTERS } from './reviewEvidenceLimits';

/**
 * The success callback is deliberately smaller than the worker's operational receipt. It carries
 * the persona evidence needed for the service to re-run the existing canonical arbitration, while
 * excluding anything that could select or complete a GitHub check. A failed result may add only the
 * same bounded diagnostic contract used by the terminal-failure callback; the service redacts it again.
 */
export const WORKER_REVIEW_COMPLETION_VERSION = 'WorkerReviewCompletion.v1' as const;
export const WORKER_REVIEW_RESULT_VERSION = 'WorkerReviewResult.v1' as const;

/** The outer JSON document is bounded by UTF-8 bytes; string limits are JavaScript UTF-16 code units. */
export const MAX_COMPLETION_BYTES = 1_000_000;
export const MAX_PERSONAS = 64;
export const MAX_FINDINGS_PER_PERSONA = 400;
export const MAX_TOTAL_FINDINGS = MAX_PERSONAS * MAX_FINDINGS_PER_PERSONA;
export const MAX_TEXT_CHARACTERS = 16_000;
export const MAX_TITLE_CHARACTERS = 4_000;
export const MAX_CODE_CHARACTERS = 10_000;

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

/** MAX_INVESTIGATION_TURNS in `panelEngine.ts` is 15; this bound is deliberately a little larger
 * so a future increase there does not also require a schema change here, while still rejecting an
 * unbounded array. Not imported directly -- a worker-completion schema must not reach into the
 * panel engine module for a plain numeric constant. */
export const MAX_TURN_USAGES = 32;

/** One real provider call inside a persona lane's `invoke()` loop. Bounded and strictly numeric
 * (plus the resolved model string) -- never provider prompt/response text -- so it is safe on this
 * boundary the same way the rest of this schema is. */
const laneTurnUsageSchema = z.object({
  turn: positiveInteger,
  kind: z.enum(['tool', 'correction', 'final']),
  promptTokens: boundedInteger,
  completionTokens: boundedInteger,
  totalTokens: boundedInteger,
  cachedTokens: boundedInteger,
  costUSD: z.number().finite().nonnegative().nullable(),
  model: z.string().max(256),
  durationMs: boundedInteger,
}).strict();

/**
 * OPTIONAL, additive per-persona telemetry (Stage 0 / ct-meta review-yeti telemetry work): the
 * lane's accumulated usage across every turn its `invoke()` loop made, not just the terminal turn
 * the rest of this schema has always reported. Every field is optional and the object itself is
 * optional on `personaSchema` below, so an older worker that never populates it -- or a panel
 * result with no completed lanes -- still parses cleanly. This keeps `WorkerReviewCompletion.v1`
 * backward compatible: no version bump, no dispatcher change required to read it.
 */
const personaTelemetrySchema = z.object({
  model: z.string().max(256).optional(),
  turnsCount: boundedInteger.optional(),
  toolTurns: boundedInteger.optional(),
  correctionTurns: boundedInteger.optional(),
  /** Count of tool invocations the lane's `invoke()` loop actually made (the `toolCalls` array
   * declared in `panelEngine.ts`), not the array itself -- this boundary carries bounded numeric
   * telemetry only, never the tool names/args a provider or repository file path could leak
   * through. Optional and additive for the same reason every other field here is: an older worker
   * that never populates it must still parse. */
  toolCalls: boundedInteger.optional(),
  promptTokens: boundedInteger.optional(),
  completionTokens: boundedInteger.optional(),
  totalTokens: boundedInteger.optional(),
  cachedTokens: boundedInteger.optional(),
  costUSD: z.number().finite().nonnegative().nullable().optional(),
  durationMs: boundedInteger.optional(),
  turnUsages: z.array(laneTurnUsageSchema).max(MAX_TURN_USAGES).optional(),
}).strict();

export type PersonaTelemetry = z.output<typeof personaTelemetrySchema>;
/** The `turnUsages` entry shape. */
export type LaneTurnUsagePayload = z.output<typeof laneTurnUsageSchema>;

/**
 * The ONLY place that maps a panel lane's turn-accumulation fields onto the wire shape
 * `personaTelemetrySchema` accepts. `buildReviewResult` in `publishingReview.ts` calls this on
 * the publishing worker's SUCCESS path, instead of hand-mirroring the field list a second time in
 * a different module -- co-locating the builder with the schema it targets (rather than relying
 * on `z.output<...>` alone, which TypeScript's excess-property checking does not actually enforce
 * through the conditional spreads a builder like this needs -- confirmed by renaming a field here
 * and re-running `tsc --noEmit` with no error) means an edit to one is an edit to the other, in
 * the same file, in the same diff.
 *
 * TOTAL, never throws: `telemetry` is an OPTIONAL, additive field added specifically so it
 * degrades safely -- this PR exists to make measurement trustworthy, not to make measurement able
 * to fail a review. A lane carrying a malformed field from an unexpected producer (a string token
 * count, a NaN, a non-integer `turn`, ...) must never sink the whole publishing run. On schema
 * failure this OMITS the telemetry field for that lane and records the omission (a counter plus a
 * bounded log line -- never the raw candidate, only zod's issue paths/codes) so the drop is
 * visible rather than silent, then returns `undefined` exactly like the "no telemetry data at
 * all" case the caller already handles. The earlier version of this function ended in
 * `personaTelemetrySchema.parse(...)`, which threw on drift instead of degrading -- that was
 * itself a real regression this rewrite fixes; fail-loud on drift belongs in this function's own
 * unit tests, not on the production success path.
 *
 * Input is loosely typed (`unknown`-per-field, not `PersonaLaneResult` from the panel module):
 * this module must not depend on panel-engine internals, so every field is read defensively by
 * type, exactly as a producer across a process/module boundary should.
 */
export function buildPersonaTelemetryPayload(lane: {
  id?: unknown;
  model?: unknown;
  turnsCount?: unknown;
  toolTurns?: unknown;
  correctionTurns?: unknown;
  durationMs?: unknown;
  aggregateUsage?: unknown;
  turnUsages?: unknown;
  toolCalls?: unknown;
}): PersonaTelemetry | undefined {
  const aggregate = lane.aggregateUsage as Record<string, unknown> | undefined;
  const hasAggregate = !!aggregate && typeof aggregate === 'object';
  const turnUsagesInput = Array.isArray(lane.turnUsages) ? lane.turnUsages : [];
  const hasTurnUsages = turnUsagesInput.length > 0;
  // `lane.toolCalls` is the panel engine's array of individual tool-invocation records
  // (`{ tool, args, scope, exhaustive }`); this boundary only ever reports its length, never the
  // array itself -- see the doc comment on `personaTelemetrySchema.toolCalls`.
  const hasToolCalls = Array.isArray(lane.toolCalls);
  const hasAnyTelemetry = hasAggregate || hasTurnUsages || hasToolCalls
    || typeof lane.turnsCount === 'number' || typeof lane.model === 'string';
  if (!hasAnyTelemetry) return undefined;

  const candidate: Record<string, unknown> = {
    ...(typeof lane.model === 'string' ? { model: lane.model } : {}),
    ...(typeof lane.turnsCount === 'number' ? { turnsCount: lane.turnsCount } : {}),
    ...(typeof lane.toolTurns === 'number' ? { toolTurns: lane.toolTurns } : {}),
    ...(typeof lane.correctionTurns === 'number' ? { correctionTurns: lane.correctionTurns } : {}),
    ...(typeof lane.durationMs === 'number' ? { durationMs: lane.durationMs } : {}),
    ...(hasToolCalls ? { toolCalls: (lane.toolCalls as unknown[]).length } : {}),
    ...(hasAggregate ? {
      promptTokens: aggregate!.promptTokens,
      completionTokens: aggregate!.completionTokens,
      totalTokens: aggregate!.totalTokens,
      cachedTokens: aggregate!.cachedTokens,
      costUSD: aggregate!.costUSD,
    } : {}),
    ...(hasTurnUsages ? {
      turnUsages: turnUsagesInput.map((turn: any) => ({
        turn: turn?.turn,
        kind: turn?.kind,
        promptTokens: turn?.promptTokens,
        completionTokens: turn?.completionTokens,
        totalTokens: turn?.totalTokens,
        cachedTokens: turn?.cachedTokens,
        costUSD: turn?.costUSD,
        model: turn?.model,
        durationMs: turn?.durationMs,
      })),
    } : {}),
  };

  const result = personaTelemetrySchema.safeParse(candidate);
  if (result.success) return result.data;

  const personaId = typeof lane.id === 'string' ? lane.id : 'unknown';
  // Telemetry recording is itself best-effort: a metrics-layer failure must never compound into a
  // review failure either, the same principle this whole function exists to uphold.
  try {
    getMetrics().personaTelemetryDropped.add(1, { persona: personaId });
  } catch (_) {
    // ignore
  }
  logger.warn('Persona telemetry payload failed schema validation; omitting it from the result', {
    persona: personaId,
    // Bounded to zod's structural issue metadata -- never the raw candidate values, which a
    // future producer could make arbitrarily large.
    issues: result.error.issues.map((issue) => ({ path: issue.path.join('.'), code: issue.code })),
  });
  return undefined;
}

const personaSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,127}$/u),
  decision: z.enum(['APPROVE', 'FINDINGS', 'ERROR']),
  status: z.enum(['COMPLETE', 'ERROR']).optional(),
  /** Bounded operational classification only; provider text/transcripts never cross this boundary. */
  errorClass: z.enum(workerFailureClasses).optional(),
  findings: z.array(findingSchema).max(MAX_FINDINGS_PER_PERSONA),
  /** See `personaTelemetrySchema` above. */
  telemetry: personaTelemetrySchema.optional(),
  /**
   * OPTIONAL, additive (shadow-mode review engine comparison, `src/cli/publishingReview.ts`'s
   * `resolveReviewEngine`/`'shadow'`): which engine produced this lane -- the fan-out persona
   * panel (`'panel'`) or the single-context composed engine running alongside it purely as
   * non-gating comparison evidence (`'shadow'`). Every field on this schema stays optional and
   * additive the same way `telemetry` above is, so `WorkerReviewCompletion.v1` stays backward
   * compatible: no version bump, no dispatcher change required, and a worker built before shadow
   * mode existed -- or a lane this field was never populated for -- still parses cleanly. A
   * consumer that wants only gating evidence treats an absent value exactly like `'panel'`; the
   * ingest side already reads `lane.evidenceSource == 'shadow'` to route shadow findings into
   * their own comparison bucket, separate from the findings that gated the published verdict.
   */
  evidenceSource: z.enum(['panel', 'shadow']).optional(),
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
  /**
   * OPTIONAL, additive (Stage 0 / ct-meta review-yeti telemetry work): the panel engine's own
   * wall-clock measurement of the whole run (`panelResult.panelWallClockMs` in `panelEngine.ts`),
   * distinct from summing every persona's `telemetry.durationMs`. Under the panel's concurrent
   * fan-out (`MAX_CONCURRENT_PERSONAS`) a summed-lane figure overstates wall time, so it cannot
   * stand in for how long the run actually took -- comparing a fan-out engine against a
   * single-context engine on the summed figure is not a meaningful comparison. Optional and left
   * off `resultSchema`'s literal `version`, exactly like `telemetry` on `personaTelemetrySchema`,
   * so this stays `WorkerReviewCompletion.v1`: no version bump, no dispatcher change required, and
   * a worker built before this field existed still parses cleanly.
   */
  panelWallClockMs: boundedInteger.optional(),
  /** Optional bounded context for a terminal error result; persisted after a second redaction. */
  failureDiagnostics: workerFailureDiagnosticsSchema.optional(),
}).strict();

const completionSchema = z.object({
  version: z.literal(WORKER_REVIEW_COMPLETION_VERSION),
  ...completionCoordinatesSchema.shape,
  result: resultSchema,
}).strict();

export const workerReviewCompletionSchema = completionSchema;

/**
 * Evidence behind a check the worker published itself (app-gate publication
 * without the authoritative gate). Sent once, right after the check is
 * completed and before any terminal lifecycle callback, for BOTH conclusions:
 * a failing check carries the P0/P1 findings that made it fail. It never
 * transitions the run and never selects or completes a check.
 */
export const WORKER_REVIEW_EVIDENCE_VERSION = 'WorkerReviewEvidence.v1' as const;
const evidenceSchema = z.object({
  version: z.literal(WORKER_REVIEW_EVIDENCE_VERSION),
  ...completionCoordinatesSchema.shape,
  checkId: z.number().int().positive().safe(),
  conclusion: z.enum(['success', 'failure']),
  result: resultSchema,
}).strict();
export const workerReviewEvidenceSchema = evidenceSchema;
export type WorkerReviewEvidence = z.infer<typeof evidenceSchema>;

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

function isDocumentationOnlyCompletion(result: WorkerReviewResult): boolean {
  if (result.personas.length !== 1) return false;
  const lane = result.personas[0];
  return lane?.id === 'documentation-only'
    && lane.decision === 'APPROVE'
    && lane.status === 'COMPLETE'
    && lane.findings.length === 0;
}

function noReviewableContentAuditDigest(
  coordinates: TrustedWorkerReviewCoordinates,
  changedFiles: readonly ReviewChangedFile[],
): string {
  return sha256(canonicalJson({
    version: 'NoReviewableContentAudit.v1',
    repositoryId: coordinates.repositoryId,
    prNumber: coordinates.prNumber,
    headSha: coordinates.headSha,
    baseSha: coordinates.baseSha,
    policyDigest: coordinates.policyDigest,
    configDigest: coordinates.configDigest,
    paths: changedFiles.map((file) => file.path),
  }));
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
  const changedFiles = validateChangedFiles(contract.changedFiles);
  if (isDocumentationOnlyCompletion(completion.result)) {
    if (!changedFiles.every((file) => isDocumentationOrAssetPath(file.path))) {
      return invalidEvidence('documentation-only completion contains analyzable source paths');
    }
    const coverageComplete = contract.coverageComplete && completion.result.coverageComplete;
    const marker = completion.result.personas[0];
    const canonical = computeAppVerdict({
      lanes: [{ id: marker.id, decision: marker.decision, status: marker.status, findings: [] }],
      expectedLanes: 1,
      changedFiles,
      coverageComplete,
    });
    const quorumSatisfied = contract.quorumSatisfied
      && completion.result.quorumSatisfied
      && canonical.quorumSatisfied;
    const evidence: ReviewGateEvidence = {
      verdict: canonical.verdict,
      completedAt: completion.result.completedAt,
      coverageComplete,
      quorumSatisfied,
      infrastructureFailure: false,
      p0Count: 0,
      p1Count: 0,
      exemption: {
        kind: 'no-reviewable-content',
        auditDigest: noReviewableContentAuditDigest(expectedCoordinates, changedFiles),
      },
      expectedLanes: 0,
      completedLanes: 0,
    };
    const mismatch = rawFieldsMatchCanonical(completion.result, canonical);
    if (mismatch) return invalidEvidence(mismatch, canonical, evidence);
    return { valid: true, canonical, evidence };
  }
  const expected = new Set(expectedPersonaIds);
  const seen = new Set<string>();

  for (const persona of completion.result.personas) {
    if (seen.has(persona.id)) return invalidEvidence(`duplicate persona lane: ${persona.id}`);
    if (!expected.has(persona.id)) return invalidEvidence(`unknown persona lane: ${persona.id}`);
    seen.add(persona.id);
  }

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

export function parseWorkerReviewEvidence(input: unknown): WorkerReviewEvidence {
  if (!isRecord(input)) {
    throw new WorkerReviewCompletionError('invalid-schema', 'worker review evidence must be a JSON object');
  }
  if (serializedByteLength(input) > MAX_COMPLETION_BYTES) {
    throw new WorkerReviewCompletionError('payload-too-large', `worker review evidence exceeds ${MAX_COMPLETION_BYTES} bytes`);
  }
  const parsed = evidenceSchema.safeParse(input);
  if (!parsed.success) {
    throw new WorkerReviewCompletionError('invalid-schema', `invalid WorkerReviewEvidence.v1: ${issuePath(parsed.error)}`);
  }
  return parsed.data;
}

export function workerReviewEvidenceDigest(input: unknown): string {
  return sha256(canonicalJson(parseWorkerReviewEvidence(input)));
}
