import { canonicalJson, sha256 } from '../review/reviewCore';
import { taskSourceReceiptSchema, type TaskSourceReceipt } from '../review/taskSourceDelivery';
import {
  MAX_TASKS_HARD_CAP,
  MAX_TASK_TEXT_LENGTH,
  TASK_DIMENSIONS,
  TASK_ID_PATTERN,
  validateTaskPlan,
  type ReviewTask,
} from './reviewTask';
import { MAX_CHANGED_FILES, MAX_PATH_CHARACTERS } from '../review/reviewEvidenceLimits';
import { MAX_COMPLETION_BYTES } from '../review/workerReviewCompletion';
import {
  COMPOSED_TASK_FAILURE_REASONS,
  COMPOSED_TASK_FINISH_REASONS,
  COMPOSED_TASK_LAST_TOOL_OUTCOMES,
  COMPOSED_TASK_OUTCOME_STATUSES,
  type ComposedTaskFailureDiagnostics,
  type ComposedTaskOutcomeStatus,
  type ComposedTaskRetentionFailureNotice,
  type LaneTurnUsage,
  type PanelFinding,
} from './types';

export const COMPOSED_TASK_RETENTION_REQUEST_VERSION = 'ComposedTaskRetentionRequest.v1' as const;
export const COMPOSED_TASK_RETENTION_ACK_VERSION = 'ComposedTaskRetentionAck.v1' as const;

export type ComposedTaskRetentionStage = 'plan' | 'outcome';
export type ComposedTaskRetentionFailureCode =
  | 'request_invalid'
  | 'write_failed'
  | 'ack_invalid';

export interface ComposedTaskRetentionSelectors {
  repository: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
}

interface RetentionRequestBase {
  version: typeof COMPOSED_TASK_RETENTION_REQUEST_VERSION;
  stage: ComposedTaskRetentionStage;
  selectors: Readonly<ComposedTaskRetentionSelectors>;
  requestDigest: string;
}

export interface ComposedTaskPlanRetentionRequest extends RetentionRequestBase {
  stage: 'plan';
  evidence: Readonly<{
    changedPaths: readonly string[];
    tasks: readonly Readonly<ReviewTask>[];
  }>;
}

export interface ComposedTaskOutcomeRetentionUsage {
  turnsUsed: number;
  /** HTTP/provider retries are not observable at this engine boundary. */
  physicalCalls: null;
  correctionAttempts: number;
  toolTurns: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  durationMs: number;
  /** Null unless every provider turn reported a cost. */
  costUSD: number | null;
}

export interface ComposedTaskOutcomeRetentionRequest extends RetentionRequestBase {
  stage: 'outcome';
  evidence: Readonly<{
    planDigest: string;
    taskIndex: number;
    taskId: string;
    status: ComposedTaskOutcomeStatus;
    findings?: readonly Readonly<PanelFinding>[];
    diagnostics?: Readonly<ComposedTaskFailureDiagnostics>;
    usage: Readonly<ComposedTaskOutcomeRetentionUsage>;
    sourceDelivery?: Readonly<TaskSourceReceipt>;
  }>;
}

export type ComposedTaskRetentionRequest =
  | ComposedTaskPlanRetentionRequest
  | ComposedTaskOutcomeRetentionRequest;

export interface ComposedTaskRetentionAck {
  version: typeof COMPOSED_TASK_RETENTION_ACK_VERSION;
  stage: ComposedTaskRetentionStage;
  status: 'recorded' | 'duplicate';
  /** Digest of the exact immutable request accepted by the port. */
  requestDigest: string;
  /** Immutable plan/outcome receipt digest returned by the retention owner. */
  receiptDigest: string;
}

export interface ComposedTaskRetentionPort {
  persistPlan(request: ComposedTaskPlanRetentionRequest): Promise<unknown>;
  persistOutcome(request: ComposedTaskOutcomeRetentionRequest): Promise<unknown>;
}

export interface ComposedTaskRetention {
  port: ComposedTaskRetentionPort;
  /** Receives only fixed codes and an engine-owned task index, never review/provider content. */
  onFailure?: (notice: Readonly<ComposedTaskRetentionFailureNotice>) => void;
}

export class ComposedTaskRetentionError extends Error {
  readonly code = 'composed_task_retention_failed' as const;

  constructor(
    readonly stage: ComposedTaskRetentionStage,
    readonly failureCode: ComposedTaskRetentionFailureCode,
    readonly taskIndex: number | null,
  ) {
    super(`Composed task retention failed (${stage}:${failureCode})`);
    this.name = 'ComposedTaskRetentionError';
  }
}

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_SHA = /^[a-f0-9]{40}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u;
const FAILURE_REASONS = new Set<string>(COMPOSED_TASK_FAILURE_REASONS);
const FINISH_REASONS = new Set<string>(COMPOSED_TASK_FINISH_REASONS);
const LAST_TOOL_OUTCOMES = new Set<string>(COMPOSED_TASK_LAST_TOOL_OUTCOMES);
const OUTCOME_STATUSES = new Set<string>(COMPOSED_TASK_OUTCOME_STATUSES);

function ownDataValues(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[] = allowed,
): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string' || !allowed.includes(key))) return null;
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) return null;
    result[key] = descriptor.value;
  }
  if (required.some((key) => !Object.hasOwn(result, key))) return null;
  return result;
}

function hasExactDataKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  const values = ownDataValues(value, expected);
  return values !== null && Object.keys(values).length === expected.length;
}

function denseArrayValues(value: unknown, maximumLength: number): unknown[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  const length = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value : null;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > maximumLength) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1 || keys.some((key) => key !== 'length'
    && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= length))) return null;
  const values: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !('value' in descriptor)) return null;
    values.push(descriptor.value);
  }
  return values;
}

function boundedTaskIndex(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value)
    && value >= 0 && value < MAX_TASKS_HARD_CAP ? value : null;
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function cloneJson<T>(value: T): T {
  const active = new WeakSet<object>();
  const clone = (candidate: unknown): unknown => {
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') return candidate;
    if (typeof candidate === 'number') return Number.isFinite(candidate) ? candidate : null;
    if (!candidate || typeof candidate !== 'object') throw new Error();
    if (active.has(candidate)) throw new Error();
    active.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        const values = denseArrayValues(candidate, MAX_COMPLETION_BYTES);
        if (!values) throw new Error();
        return values.map((item) => item === undefined ? null : clone(item));
      }
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) throw new Error();
      const keys = Reflect.ownKeys(candidate);
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const key of keys) {
        if (typeof key !== 'string' || key === 'toJSON' || key === '__proto__' || key === 'constructor') throw new Error();
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error();
        if (descriptor.value === undefined) continue;
        result[key] = clone(descriptor.value);
      }
      return result;
    } finally {
      active.delete(candidate);
    }
  };
  return clone(value) as T;
}

function normalizedSelectors(input: unknown): Readonly<ComposedTaskRetentionSelectors> {
  const values = ownDataValues(input, ['repository', 'prNumber', 'headSha', 'baseSha']);
  if (!values || typeof values.repository !== 'string' || !REPOSITORY.test(values.repository)
    || typeof values.prNumber !== 'number' || !Number.isSafeInteger(values.prNumber) || values.prNumber < 1
    || typeof values.headSha !== 'string' || !GIT_SHA.test(values.headSha)
    || typeof values.baseSha !== 'string' || !GIT_SHA.test(values.baseSha)) throw new Error();
  return Object.freeze({
    repository: values.repository,
    prNumber: values.prNumber,
    headSha: values.headSha,
    baseSha: values.baseSha,
  });
}

function sealRequest<T extends Omit<ComposedTaskRetentionRequest, 'requestDigest'>>(
  request: T,
): T & { requestDigest: string } {
  const snapshot = cloneJson(request);
  const canonical = canonicalJson(snapshot);
  if (Buffer.byteLength(canonical, 'utf8') > MAX_COMPLETION_BYTES) throw new Error();
  const requestDigest = sha256(canonical);
  return freezeDeep({ ...snapshot, requestDigest });
}

export function createComposedTaskPlanRetentionRequest(input: {
  selectors: ComposedTaskRetentionSelectors;
  changedPaths: readonly string[];
  tasks: readonly ReviewTask[];
}): ComposedTaskPlanRetentionRequest {
  try {
    const values = ownDataValues(input, ['selectors', 'changedPaths', 'tasks']);
    const changedPathValues = denseArrayValues(values?.changedPaths, MAX_CHANGED_FILES);
    const taskValues = denseArrayValues(values?.tasks, MAX_TASKS_HARD_CAP);
    if (!values || !changedPathValues || changedPathValues.length === 0
      || changedPathValues.some((path) => typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH_CHARACTERS)
      || new Set(changedPathValues).size !== changedPathValues.length
      || !taskValues || taskValues.length === 0) throw new Error();
    const changedPaths = changedPathValues as string[];
    const tasks = taskValues.map((task) => {
      const taskFields = ownDataValues(task, ['id', 'dimension', 'paths', 'question', 'rationale']);
      const paths = denseArrayValues(taskFields?.paths, MAX_CHANGED_FILES);
      if (!taskFields || typeof taskFields.id !== 'string' || typeof taskFields.dimension !== 'string'
        || typeof taskFields.question !== 'string' || typeof taskFields.rationale !== 'string' || !paths
        || paths.some((path) => typeof path !== 'string')) throw new Error();
      return {
        id: taskFields.id,
        dimension: taskFields.dimension,
        paths: paths as string[],
        question: taskFields.question,
        rationale: taskFields.rationale,
      };
    }) as ReviewTask[];
    const validation = validateTaskPlan({ tasks }, { changedFiles: [...changedPaths] });
    if (!validation.valid || canonicalJson(validation.tasks) !== canonicalJson(tasks)
      || tasks.some((task) => !TASK_ID_PATTERN.test(task.id)
        || !(TASK_DIMENSIONS as readonly string[]).includes(task.dimension)
        || task.question.length > MAX_TASK_TEXT_LENGTH || task.rationale.length > MAX_TASK_TEXT_LENGTH)) throw new Error();
    const evidence: ComposedTaskPlanRetentionRequest['evidence'] = {
      changedPaths: [...changedPaths],
      tasks: validation.tasks,
    };
    return sealRequest({
      version: COMPOSED_TASK_RETENTION_REQUEST_VERSION,
      stage: 'plan',
      selectors: normalizedSelectors(values.selectors),
      evidence,
    }) as ComposedTaskPlanRetentionRequest;
  } catch {
    throw new ComposedTaskRetentionError('plan', 'request_invalid', null);
  }
}

export function summarizeComposedTaskUsage(
  turnUsages: readonly LaneTurnUsage[],
  correctionAttempts: number,
  toolTurns: number,
  durationMs: number,
): ComposedTaskOutcomeRetentionUsage {
  const safeCount = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
  if (!Array.isArray(turnUsages) || !safeCount(correctionAttempts) || !safeCount(toolTurns)
    || !safeCount(durationMs) || correctionAttempts > turnUsages.length || toolTurns > turnUsages.length) throw new Error();
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let cachedTokens = 0;
  let costUSD = 0;
  let allCostsKnown = true;
  for (const usage of turnUsages) {
    if (!safeCount(usage.promptTokens) || !safeCount(usage.completionTokens)
      || !safeCount(usage.totalTokens) || !safeCount(usage.cachedTokens)
      || !safeCount(usage.durationMs)
      || usage.totalTokens !== usage.promptTokens + usage.completionTokens
      || usage.cachedTokens > usage.promptTokens) throw new Error();
    promptTokens += usage.promptTokens;
    completionTokens += usage.completionTokens;
    totalTokens += usage.totalTokens;
    cachedTokens += usage.cachedTokens;
    if (usage.costUSD === null) allCostsKnown = false;
    else if (!Number.isFinite(usage.costUSD) || usage.costUSD < 0) throw new Error();
    else costUSD += usage.costUSD;
  }
  if (![promptTokens, completionTokens, totalTokens, cachedTokens].every(safeCount)
    || !Number.isFinite(costUSD)) throw new Error();
  return Object.freeze({
    turnsUsed: turnUsages.length,
    physicalCalls: null,
    correctionAttempts,
    toolTurns,
    promptTokens,
    completionTokens,
    totalTokens,
    cachedTokens,
    durationMs,
    costUSD: allCostsKnown ? costUSD : null,
  });
}

export function createComposedTaskOutcomeRetentionRequest(input: {
  selectors: ComposedTaskRetentionSelectors;
  planDigest: string;
  taskIndex: number;
  taskId: string;
  status: ComposedTaskOutcomeStatus;
  findings?: readonly PanelFinding[];
  diagnostics?: ComposedTaskFailureDiagnostics;
  usage: ComposedTaskOutcomeRetentionUsage;
  sourceDelivery?: TaskSourceReceipt;
}): ComposedTaskOutcomeRetentionRequest {
  let taskIndexHint: unknown = null;
  try {
    const values = ownDataValues(input,
      ['selectors', 'planDigest', 'taskIndex', 'taskId', 'status', 'findings', 'diagnostics', 'usage', 'sourceDelivery'],
      ['selectors', 'planDigest', 'taskIndex', 'taskId', 'status', 'usage']);
    if (!values) throw new Error();
    taskIndexHint = values.taskIndex;
    if (typeof values.planDigest !== 'string' || !SHA256.test(values.planDigest)
      || typeof values.taskIndex !== 'number' || !Number.isSafeInteger(values.taskIndex)
      || values.taskIndex < 0 || values.taskIndex >= MAX_TASKS_HARD_CAP
      || typeof values.taskId !== 'string' || !TASK_ID_PATTERN.test(values.taskId)
      || typeof values.status !== 'string' || !OUTCOME_STATUSES.has(values.status)) throw new Error();
    const findingsPresent = values.findings !== undefined;
    const diagnosticsPresent = values.diagnostics !== undefined;
    if ((values.status === 'complete') !== findingsPresent
      || (values.status === 'exhausted') !== diagnosticsPresent) throw new Error();
    const findingValues = findingsPresent ? denseArrayValues(values.findings, MAX_COMPLETION_BYTES) : null;
    if (findingsPresent && !findingValues) throw new Error();
    const usageFields = ownDataValues(values.usage, [
      'turnsUsed', 'physicalCalls', 'correctionAttempts', 'toolTurns', 'promptTokens',
      'completionTokens', 'totalTokens', 'cachedTokens', 'durationMs', 'costUSD',
    ]);
    const usageCountKeys = [
      'turnsUsed', 'correctionAttempts', 'toolTurns', 'promptTokens', 'completionTokens',
      'totalTokens', 'cachedTokens', 'durationMs',
    ] as const;
    if (!usageFields || usageFields.physicalCalls !== null
      || !usageCountKeys.every((key) => typeof usageFields[key] === 'number'
        && Number.isSafeInteger(usageFields[key]) && (usageFields[key] as number) >= 0)
      || usageFields.costUSD !== null && (typeof usageFields.costUSD !== 'number'
        || !Number.isFinite(usageFields.costUSD) || usageFields.costUSD < 0)) throw new Error();
    const usage: ComposedTaskOutcomeRetentionUsage = {
      turnsUsed: usageFields.turnsUsed as number,
      physicalCalls: null,
      correctionAttempts: usageFields.correctionAttempts as number,
      toolTurns: usageFields.toolTurns as number,
      promptTokens: usageFields.promptTokens as number,
      completionTokens: usageFields.completionTokens as number,
      totalTokens: usageFields.totalTokens as number,
      cachedTokens: usageFields.cachedTokens as number,
      durationMs: usageFields.durationMs as number,
      costUSD: usageFields.costUSD as number | null,
    };
    if (usage.totalTokens !== usage.promptTokens + usage.completionTokens
      || usage.cachedTokens > usage.promptTokens || usage.correctionAttempts > usage.turnsUsed
      || usage.toolTurns > usage.turnsUsed) throw new Error();

    let diagnostics: ComposedTaskFailureDiagnostics | undefined;
    if (diagnosticsPresent) {
      const diagnosticFields = ownDataValues(values.diagnostics, [
        'reason', 'turnsUsed', 'correctionAttempts', 'toolTurns', 'finishReason', 'lastToolOutcome',
      ]);
      if (!diagnosticFields || typeof diagnosticFields.reason !== 'string'
        || !FAILURE_REASONS.has(diagnosticFields.reason)
        || typeof diagnosticFields.turnsUsed !== 'number' || !Number.isSafeInteger(diagnosticFields.turnsUsed) || diagnosticFields.turnsUsed < 0
        || typeof diagnosticFields.correctionAttempts !== 'number' || !Number.isSafeInteger(diagnosticFields.correctionAttempts) || diagnosticFields.correctionAttempts < 0
        || typeof diagnosticFields.toolTurns !== 'number' || !Number.isSafeInteger(diagnosticFields.toolTurns) || diagnosticFields.toolTurns < 0
        || (diagnosticFields.finishReason !== null && (typeof diagnosticFields.finishReason !== 'string'
          || !FINISH_REASONS.has(diagnosticFields.finishReason)))
        || typeof diagnosticFields.lastToolOutcome !== 'string'
        || !LAST_TOOL_OUTCOMES.has(diagnosticFields.lastToolOutcome)
        // `turnsUsed` is deliberately NOT compared for equality here. The two
        // values are produced from different expressions and mean different
        // things:
        //   usage.turnsUsed       = turnUsages.length                    (task TOTAL)
        //   diagnostics.turnsUsed = turnUsages.length - attemptStartTurn (FINAL ATTEMPT)
        // The engine keeps one shared usage array across a task's retry attempts
        // ("A task-level retry reuses the shared usage array so every attempt's
        // spend stays accounted"), so on any retried attempt the two differ. An
        // equality check therefore threw on exactly the retry path this feature
        // adds, and the ComposedTaskRetentionError propagated out of
        // runReservedTask into Promise.all(cohortPromises), aborting the WHOLE
        // composed review instead of recording one task outcome.
        //
        // The invariant that actually holds: this attempt cannot have spent more
        // turns than the task has in total. correctionAttempts/toolTurns stay
        // equal to usage because the engine passes those straight through.
        || diagnosticFields.turnsUsed > usage.turnsUsed
        || diagnosticFields.correctionAttempts !== usage.correctionAttempts
        || diagnosticFields.toolTurns !== usage.toolTurns) throw new Error();
      diagnostics = {
        reason: diagnosticFields.reason as ComposedTaskFailureDiagnostics['reason'],
        turnsUsed: diagnosticFields.turnsUsed,
        correctionAttempts: diagnosticFields.correctionAttempts,
        toolTurns: diagnosticFields.toolTurns,
        finishReason: diagnosticFields.finishReason as ComposedTaskFailureDiagnostics['finishReason'],
        lastToolOutcome: diagnosticFields.lastToolOutcome as ComposedTaskFailureDiagnostics['lastToolOutcome'],
      };
    }
    const evidence: ComposedTaskOutcomeRetentionRequest['evidence'] = {
      planDigest: values.planDigest,
      taskIndex: values.taskIndex,
      taskId: values.taskId,
      status: values.status as ComposedTaskOutcomeRetentionRequest['evidence']['status'],
      ...(findingValues ? { findings: cloneJson(findingValues) as PanelFinding[] } : {}),
      ...(diagnostics ? { diagnostics } : {}),
      usage,
      ...(values.sourceDelivery !== undefined ? { sourceDelivery: taskSourceReceiptSchema.parse(cloneJson(values.sourceDelivery)) } : {}),
    };
    return sealRequest({
      version: COMPOSED_TASK_RETENTION_REQUEST_VERSION,
      stage: 'outcome',
      selectors: normalizedSelectors(values.selectors),
      evidence,
    }) as ComposedTaskOutcomeRetentionRequest;
  } catch {
    throw new ComposedTaskRetentionError('outcome', 'request_invalid', boundedTaskIndex(taskIndexHint));
  }
}

/** Strictly parse the port result and return a fresh immutable acknowledgement. */
export function validateComposedTaskRetentionAck(
  input: unknown,
  stage: ComposedTaskRetentionStage,
  requestDigest: string,
  taskIndex: number | null,
): Readonly<ComposedTaskRetentionAck> {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error();
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) throw new Error();
    const expectedKeys = ['version', 'stage', 'status', 'requestDigest', 'receiptDigest'];
    const keys = Reflect.ownKeys(input);
    if (keys.length !== expectedKeys.length || keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))) throw new Error();
    const values: Record<string, unknown> = {};
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new Error();
      values[key] = descriptor.value;
    }
    if (values.version !== COMPOSED_TASK_RETENTION_ACK_VERSION || values.stage !== stage
      || typeof values.status !== 'string' || !['recorded', 'duplicate'].includes(values.status)
      || values.requestDigest !== requestDigest || typeof values.receiptDigest !== 'string'
      || !SHA256.test(values.receiptDigest)) throw new Error();
    return Object.freeze({
      version: COMPOSED_TASK_RETENTION_ACK_VERSION,
      stage,
      status: values.status as 'recorded' | 'duplicate',
      requestDigest,
      receiptDigest: values.receiptDigest,
    });
  } catch {
    throw new ComposedTaskRetentionError(stage, 'ack_invalid', taskIndex);
  }
}

export async function persistComposedTaskPlan(
  retention: ComposedTaskRetention,
  input: Parameters<typeof createComposedTaskPlanRetentionRequest>[0],
): Promise<Readonly<ComposedTaskRetentionAck>> {
  let request: ComposedTaskPlanRetentionRequest;
  try {
    request = createComposedTaskPlanRetentionRequest(input);
  } catch {
    fail(retention, 'plan', 'request_invalid', null);
  }
  return persist(retention, 'plan', null, request, () => retention.port.persistPlan(request));
}

export async function persistComposedTaskOutcome(
  retention: ComposedTaskRetention,
  input: Parameters<typeof createComposedTaskOutcomeRetentionRequest>[0],
): Promise<Readonly<ComposedTaskRetentionAck>> {
  let request: ComposedTaskOutcomeRetentionRequest;
  try {
    request = createComposedTaskOutcomeRetentionRequest(input);
  } catch (error) {
    fail(retention, 'outcome', 'request_invalid',
      error instanceof ComposedTaskRetentionError ? error.taskIndex : null);
  }
  return persist(retention, 'outcome', input.taskIndex, request, () => retention.port.persistOutcome(request));
}

async function persist<T extends ComposedTaskRetentionRequest>(
  retention: ComposedTaskRetention,
  stage: ComposedTaskRetentionStage,
  taskIndex: number | null,
  request: T,
  write: () => Promise<unknown>,
): Promise<Readonly<ComposedTaskRetentionAck>> {
  let result: unknown;
  try {
    if (!retention || typeof write !== 'function') throw new Error();
    result = await write();
  } catch {
    fail(retention, stage, 'write_failed', taskIndex);
  }
  try {
    return validateComposedTaskRetentionAck(result, stage, request.requestDigest, taskIndex);
  } catch {
    fail(retention, stage, 'ack_invalid', taskIndex);
  }
}

function fail(
  retention: ComposedTaskRetention,
  stage: ComposedTaskRetentionStage,
  failureCode: ComposedTaskRetentionFailureCode,
  taskIndex: number | null,
): never {
  const safeTaskIndex = boundedTaskIndex(taskIndex);
  try {
    const diagnostic = retention?.onFailure?.(Object.freeze({ stage, code: failureCode, taskIndex: safeTaskIndex }));
    void Promise.resolve(diagnostic).catch(() => undefined);
  } catch {
    // Diagnostics are best-effort and cannot expose/replace the bounded failure.
  }
  throw new ComposedTaskRetentionError(stage, failureCode, safeTaskIndex);
}
