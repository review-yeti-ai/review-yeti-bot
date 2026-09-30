import { z } from 'zod';
import { canonicalJson, sha256, validateReviewFindings, type ReviewChangedFile } from './reviewCore';
import { reviewPolicySourceSchema } from './authoritativeReviewIdentity';
import { MAX_TASKS_HARD_CAP, MAX_TASK_TEXT_LENGTH, TASK_DIMENSIONS, TASK_ID_PATTERN,
  validateTaskPlan } from '../reviewTaskContract';
import { MAX_COMPLETION_BYTES, MAX_TURN_USAGES, workerReviewCompletionSchema } from './workerReviewCompletion';
import { MAX_CHANGED_FILES, MAX_CHANGED_FILE_PATCH_BYTES, MAX_PATH_CHARACTERS } from './reviewEvidenceLimits';
import type { ComposedTaskFailureDiagnostics } from '../panel/types';

/** Retention only. No cursor, approval, provider reservation or budget refund. */
export const COMPOSED_TASK_LEDGER_VERSION = 'ComposedTaskLedger.v1' as const;
export const MAX_COMPOSED_LEDGER_BYTES = MAX_COMPLETION_BYTES;
export type ComposedTaskLedgerErrorCode = 'invalid-plan' | 'invalid-outcome' | 'byte-bound'
  | 'integrity' | 'identity-mismatch' | 'fence-expired' | 'storage-unavailable';
export class ComposedTaskLedgerError extends Error {
  constructor(public readonly code: ComposedTaskLedgerErrorCode) {
    super(`Composed task retention: ${code}`);
    this.name = 'ComposedTaskLedgerError';
  }
}

const positive = z.number().int().positive().safe();
const count = z.number().int().nonnegative().safe();
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const sha = z.string().regex(/^[a-f0-9]{40}$/u);
const timestamp = z.string().datetime({ offset: true }).refine(value => new Date(value).toISOString() === value);
const pathSchema = z.string().min(1).max(MAX_PATH_CHARACTERS).refine(value => !value.startsWith('/')
  && !/[\\\u0000-\u001f\u007f]/u.test(value)
  && !value.split('/').some(part => !part || part === '.' || part === '..'));
const identitySchema = z.object({
  runId: z.string().regex(/^run_[a-f0-9]{32}$/u), repositoryId: positive,
  owner: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/u), repo: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/u),
  prNumber: positive, headSha: sha, baseSha: sha, configDigest: digest, policyDigest: digest,
  snapshotDigest: digest, reviewGeneration: count, executionAttempt: positive,
  attemptId: z.string(), expectedAppId: positive, receivedAt: timestamp, terminalDeadline: timestamp,
  semanticDiffDigest: digest, coverageDigest: digest,
  policySources: z.array(reviewPolicySourceSchema).min(1).max(16),
  engine: z.object({ contract: z.literal(COMPOSED_TASK_LEDGER_VERSION), sourceSha: sha,
    imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u), buildManifestDigest: digest }).strict(),
}).strict().refine(value => value.attemptId === `${value.runId}-g${value.reviewGeneration}-e${value.executionAttempt}`
  && Date.parse(value.receivedAt) < Date.parse(value.terminalDeadline));
export type ComposedTaskLedgerIdentity = z.infer<typeof identitySchema>;

/** Internal service port, NOT a worker request contract. The later authenticated
 * adapter must resolve paths/patches, coverage and engine provenance itself.
 * A bearer proves worker ownership; it cannot choose these trusted values. */
export interface TrustedComposedTaskLedgerContext {
  identity: ComposedTaskLedgerIdentity;
  changedFiles: readonly ReviewChangedFile[];
}
const taskSchema = z.object({ id: z.string().regex(TASK_ID_PATTERN), dimension: z.enum(TASK_DIMENSIONS),
  paths: z.array(pathSchema).min(1).max(MAX_CHANGED_FILES),
  question: z.string().min(1).max(MAX_TASK_TEXT_LENGTH), rationale: z.string().min(1).max(MAX_TASK_TEXT_LENGTH),
}).strict();
const planSchema = z.object({ version: z.literal(COMPOSED_TASK_LEDGER_VERSION), identity: identitySchema,
  changedPaths: z.array(pathSchema).min(1).max(MAX_CHANGED_FILES), changedPathsDigest: digest,
  tasks: z.array(taskSchema).min(1).max(MAX_TASKS_HARD_CAP),
}).strict();
export type ComposedTaskPlan = z.infer<typeof planSchema>;
export interface ComposedTaskRecord<T> { digest: string; byteLength: number; payload: T }

// Derive the findings wire contract from the existing public completion schema,
// not a second relaxed/mirrored findings validator. Nothing here invokes a Gate.
const findingsSchema = workerReviewCompletionSchema.shape.result.shape.personas.element.innerType().shape.findings;
const usageSchema = z.object({ turnsUsed: count.max(MAX_TURN_USAGES), physicalCalls: count.nullable(), correctionAttempts: count.max(MAX_TURN_USAGES),
  toolTurns: count.max(MAX_TURN_USAGES), promptTokens: count, completionTokens: count, totalTokens: count, cachedTokens: count,
  durationMs: count, costUSD: z.number().finite().nonnegative().nullable(),
}).strict().refine(value => value.totalTokens === value.promptTokens + value.completionTokens
  && value.cachedTokens <= value.promptTokens && value.correctionAttempts <= value.turnsUsed
  && value.toolTurns <= value.turnsUsed && (value.physicalCalls === null || value.physicalCalls >= value.turnsUsed));
// Compile-time exhaustive against the existing producer's coded diagnostics.
const failureReasons: Record<ComposedTaskFailureDiagnostics['reason'], true> = {
  total_turn_budget_exhausted: true, task_turn_budget_exhausted: true, non_json_task_result: true,
  tool_requested_during_finalization: true, task_id_mismatch: true, nonce_mismatch: true,
  invalid_status: true, invalid_findings: true, invalid_result_fields: true,
};
const diagnosticsSchema: z.ZodType<ComposedTaskFailureDiagnostics> = z.object({
  reason: z.custom<ComposedTaskFailureDiagnostics['reason']>(value => typeof value === 'string'
    && Object.hasOwn(failureReasons, value)),
  turnsUsed: count, correctionAttempts: count, toolTurns: count,
  finishReason: z.enum(['stop', 'length', 'content_filter', 'tool_calls', 'function_call', 'unrecognized']).nullable(),
  lastToolOutcome: z.enum(['none', 'returned', 'requested_after_finalization']),
}).strict();
const outcomeBase = { version: z.literal('ComposedTaskOutcome.v1').default('ComposedTaskOutcome.v1'),
  planDigest: digest, taskId: z.string().regex(TASK_ID_PATTERN), usage: usageSchema };
const outcomeSchema = z.discriminatedUnion('status', [
  z.object({ ...outcomeBase, status: z.literal('complete'), findings: findingsSchema }).strict(),
  z.object({ ...outcomeBase, status: z.literal('blocked') }).strict(),
  z.object({ ...outcomeBase, status: z.literal('exhausted'), diagnostics: diagnosticsSchema }).strict(),
]);
export type ComposedTaskOutcome = z.output<typeof outcomeSchema>;

/** Reject executable objects, accessors, sparse arrays, cycles, unsafe keys and
 * excessive structures before traversing/serializing. Closed schemas keep raw
 * transport fields out; free-form review text is still the producer's duty. */
function requireBoundedJson(input: unknown): void {
  const ancestors = new Set<object>();
  let nodes = 0; let bytes = 0;
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 200_000 || depth > 32) throw new ComposedTaskLedgerError('byte-bound');
    if (typeof item === 'string') {
      bytes += Buffer.byteLength(item, 'utf8');
      if (bytes > MAX_COMPOSED_LEDGER_BYTES) throw new ComposedTaskLedgerError('byte-bound');
      return;
    }
    if (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) return;
    if (!item || typeof item !== 'object' || ancestors.has(item)) throw new Error();
    const array = Array.isArray(item);
    if (array ? Object.getPrototypeOf(item) !== Array.prototype : ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new Error();
    const keys = Reflect.ownKeys(item);
    if (array && keys.length !== item.length + 1) throw new Error();
    ancestors.add(item);
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error();
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (!descriptor.enumerable || !('value' in descriptor)) throw new Error();
      bytes += Buffer.byteLength(key, 'utf8');
      visit(descriptor.value, depth + 1);
    }
    ancestors.delete(item);
  };
  visit(input, 0);
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > MAX_COMPOSED_LEDGER_BYTES) throw new ComposedTaskLedgerError('byte-bound');
}

export function validateComposedTaskLedgerContext(input: TrustedComposedTaskLedgerContext): TrustedComposedTaskLedgerContext {
  try {
    requireBoundedJson(input.identity);
    const identity = identitySchema.parse(input.identity);
    identity.policySources.sort((a, b) => { const left = JSON.stringify(a); const right = JSON.stringify(b);
      return left < right ? -1 : left > right ? 1 : 0; });
    if (new Set(identity.policySources.map(source => `${source.repositoryId}:${source.sha}:${source.path}`)).size !== identity.policySources.length) throw new Error();
    if (!Array.isArray(input.changedFiles) || input.changedFiles.length === 0 || input.changedFiles.length > MAX_CHANGED_FILES) throw new Error();
    const changedFiles = input.changedFiles.map(file => {
      const path = pathSchema.parse(file.path);
      if (file.patch !== undefined && (typeof file.patch !== 'string'
        || Buffer.byteLength(file.patch, 'utf8') > MAX_CHANGED_FILE_PATCH_BYTES)) throw new Error();
      return { path, ...(file.patch !== undefined ? { patch: file.patch } : {}),
        ...(file.mode !== undefined ? { mode: file.mode } : {}), ...(file.isSubmodule !== undefined ? { isSubmodule: file.isSubmodule } : {}) };
    });
    if (new Set(changedFiles.map(file => file.path)).size !== changedFiles.length) throw new Error();
    return { identity, changedFiles };
  } catch (error) {
    if (error instanceof ComposedTaskLedgerError) throw error;
    throw new ComposedTaskLedgerError('invalid-plan');
  }
}

function record<T>(payload: T): ComposedTaskRecord<T> {
  requireBoundedJson(payload);
  const serialized = canonicalJson(payload);
  const byteLength = Buffer.byteLength(serialized, 'utf8');
  if (byteLength > MAX_COMPOSED_LEDGER_BYTES) throw new ComposedTaskLedgerError('byte-bound');
  return { digest: sha256(serialized), byteLength, payload };
}

export function createComposedTaskPlan(context: TrustedComposedTaskLedgerContext, input: unknown): ComposedTaskRecord<ComposedTaskPlan> {
  try {
    const trusted = validateComposedTaskLedgerContext(context);
    requireBoundedJson(input);
    const tasks = z.array(taskSchema).min(1).max(MAX_TASKS_HARD_CAP).parse(input);
    const normalized = validateTaskPlan({ tasks: structuredClone(tasks) }, { changedFiles: trusted.changedFiles.map(file => file.path) });
    // Persistence accepts ONLY an already accepted normalized plan. Never drop,
    // rebind, truncate or inject tasks at this evidence boundary.
    if (!normalized.valid || canonicalJson(normalized.tasks) !== canonicalJson(tasks)) throw new Error();
    const changedPaths = trusted.changedFiles.map(file => file.path);
    return record(planSchema.parse({ version: COMPOSED_TASK_LEDGER_VERSION, identity: trusted.identity,
      changedPaths, changedPathsDigest: sha256(changedPaths), tasks }));
  } catch (error) {
    if (error instanceof ComposedTaskLedgerError) throw error;
    throw new ComposedTaskLedgerError('invalid-plan');
  }
}

export function createComposedTaskOutcome(plan: ComposedTaskRecord<ComposedTaskPlan>, input: unknown,
  changedFiles: readonly ReviewChangedFile[]): ComposedTaskRecord<ComposedTaskOutcome> {
  try {
    const outcome = parseComposedTaskOutcomeInput(input);
    const task = plan.payload.tasks.find(candidate => candidate.id === outcome.taskId);
    if (!task || outcome.planDigest !== plan.digest) throw new Error();
    if (outcome.status === 'complete') {
      if (outcome.findings.some(finding => !task.paths.includes(finding.path))) throw new Error();
      const normalized = validateReviewFindings(outcome.findings, [...changedFiles]);
      if (!normalized.valid || canonicalJson(normalized.findings) !== canonicalJson(outcome.findings)) throw new Error();
    }
    if (outcome.status === 'exhausted' && ['turnsUsed', 'correctionAttempts', 'toolTurns'].some(key =>
      outcome.diagnostics[key as 'turnsUsed'] !== outcome.usage[key as 'turnsUsed'])) throw new Error();
    return record(outcome);
  } catch (error) {
    if (error instanceof ComposedTaskLedgerError) throw error;
    throw new ComposedTaskLedgerError('invalid-outcome');
  }
}

/** Snapshot the closed wire value before waiting on SQL locks. No accessors,
 * caller mutation, raw tool/provider fields or lazy values survive the parse. */
export function parseComposedTaskOutcomeInput(input: unknown): ComposedTaskOutcome {
  try {
    requireBoundedJson(input);
    return outcomeSchema.parse(input);
  } catch (error) {
    if (error instanceof ComposedTaskLedgerError) throw error;
    throw new ComposedTaskLedgerError('invalid-outcome');
  }
}

export function verifyComposedTaskPlan(context: TrustedComposedTaskLedgerContext,
  stored: ComposedTaskRecord<ComposedTaskPlan>): ComposedTaskRecord<ComposedTaskPlan> {
  try {
    requireBoundedJson(stored.payload);
    const parsed = planSchema.parse(stored.payload);
    const verified = createComposedTaskPlan(context, parsed.tasks);
    if (stored.digest !== verified.digest || stored.byteLength !== verified.byteLength
      || canonicalJson(stored.payload) !== canonicalJson(verified.payload)) throw new Error();
    return verified;
  } catch { throw new ComposedTaskLedgerError('integrity'); }
}

export function verifyComposedTaskOutcome(plan: ComposedTaskRecord<ComposedTaskPlan>,
  stored: ComposedTaskRecord<ComposedTaskOutcome>, changedFiles: readonly ReviewChangedFile[]): ComposedTaskRecord<ComposedTaskOutcome> {
  try {
    const verified = createComposedTaskOutcome(plan, stored.payload, changedFiles);
    if (stored.digest !== verified.digest || stored.byteLength !== verified.byteLength) throw new Error();
    return verified;
  } catch { throw new ComposedTaskLedgerError('integrity'); }
}
