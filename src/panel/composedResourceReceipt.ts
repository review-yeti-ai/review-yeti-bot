import { createHash } from 'node:crypto';
import { z } from 'zod';
import { effectiveReviewConfigReceiptSchema, type EffectiveReviewConfigReceipt } from '../config/schema';
import { taskSourceReceiptSchema, type TaskSourceReceipt } from '../review/taskSourceDelivery';
import { GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION } from '../review/groundedEvidenceV2';
import type { ReviewTask } from '../reviewTaskContract';

const count = z.number().int().nonnegative().safe();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const taskIds = z.array(z.string().min(1).max(128)).max(64).refine(isSortedUnique);
const pathSet = z.object({ count, sha256 }).strict();

function isSortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1] < value);
}

function nullableReasonPair<T extends z.ZodTypeAny>(value: T) {
  return z.object({ value: value.nullable(), unavailableReason: z.string().min(1).nullable() }).strict()
    .superRefine((pair, context) => {
      if ((pair.value === null) !== (pair.unavailableReason !== null)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['unavailableReason'],
          message: 'unavailable values require a reason and observed values cannot carry one' });
      }
    });
}

export const composedRuntimeResourcesSchema = z.object({
  version: z.literal('ComposedRuntimeResources.v1'),
  stage: z.enum(['composed_engine', 'worker_completion']),
  discoveryScope: z.literal('composed_engine'),
  evidenceSemanticsVersion: z.literal(GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION),
  engineExecutionState: z.enum(['running', 'complete', 'incomplete', 'interrupted']),
  configDigest: nullableReasonPair(sha256),
  configuration: nullableReasonPair(effectiveReviewConfigReceiptSchema),
  budget: z.object({
    configuredTotalTurns: count,
    investigationTurns: count,
    verificationReserveTurns: count,
  }).strict(),
  usage: z.object({
    totalTurns: count,
    planningTurns: count,
    discoveryTurns: count,
    taskFinalizationTurns: count,
    taskFinalizationReservedTurns: count,
    verifierCalls: nullableReasonPair(count),
    clientCallsStarted: count,
    clientResponsesReceived: count,
    settledClientCalls: count,
    clientCallsUnsettled: count,
    settledClientCallElapsedMs: count,
    gatewayAcceptedCalls: z.null(),
    gatewayAcceptedCallsUnavailableReason: z.string().min(1),
    providerCompletions: z.null(),
    providerCompletionsUnavailableReason: z.string().min(1),
    engineElapsedMonotonicMs: count,
  }).strict(),
  tasks: z.object({
    planned: taskIds,
    started: taskIds,
    completed: taskIds,
    blocked: taskIds,
    failed: taskIds,
    interrupted: taskIds,
    pending: taskIds,
    inProgress: taskIds,
  }).strict(),
  coverage: z.object({
    assignedPaths: pathSet,
    investigatedPaths: pathSet,
    remainingPaths: pathSet,
    regions: z.object({ state: z.literal('unavailable'), reason: z.string().min(1) }).strict(),
  }).strict(),
}).strict().superRefine((receipt, context) => {
  const { budget, usage, tasks, coverage } = receipt;
  if (budget.configuredTotalTurns !== budget.investigationTurns + budget.verificationReserveTurns) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['budget'], message: 'turn budget must conserve the verifier reserve' });
  }
  if (usage.totalTurns !== usage.planningTurns + usage.discoveryTurns + usage.taskFinalizationTurns) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['usage', 'totalTurns'], message: 'turn phases must sum to observed total turns' });
  }
  if (usage.clientResponsesReceived > usage.clientCallsStarted || usage.settledClientCalls > usage.clientCallsStarted
    || usage.clientCallsUnsettled + usage.settledClientCalls !== usage.clientCallsStarted) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['usage'], message: 'client responses and timings cannot exceed started calls' });
  }
  const planned = new Set(tasks.planned);
  const started = new Set(tasks.started);
  const terminal = [...tasks.completed, ...tasks.blocked, ...tasks.failed, ...tasks.interrupted,
    ...tasks.pending, ...tasks.inProgress];
  if (terminal.length !== tasks.planned.length || new Set(terminal).size !== terminal.length
    || terminal.some(id => !planned.has(id))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['tasks'], message: 'terminal task states must partition planned tasks' });
  }
  if ([...started].some(id => !planned.has(id))
    || [...tasks.completed, ...tasks.blocked, ...tasks.failed, ...tasks.interrupted, ...tasks.inProgress].some(id => !started.has(id))
    || tasks.pending.some(id => started.has(id))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['tasks', 'started'],
      message: 'started task states must match planned task progress' });
  }
  if (coverage.investigatedPaths.count + coverage.remainingPaths.count !== coverage.assignedPaths.count) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['coverage'], message: 'investigated and remaining paths must account for assigned paths' });
  }
  if (receipt.stage === 'composed_engine' && receipt.usage.verifierCalls.value !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['usage', 'verifierCalls'], message: 'the composed engine cannot claim later verifier usage' });
  }
  if (receipt.engineExecutionState === 'complete'
    && (tasks.completed.length !== tasks.planned.length || tasks.blocked.length > 0 || tasks.failed.length > 0
      || tasks.interrupted.length > 0 || tasks.pending.length > 0 || tasks.inProgress.length > 0
      || coverage.remainingPaths.count > 0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['engineExecutionState'],
      message: 'a complete engine execution requires completed tasks and no remaining assigned paths' });
  }
  if (receipt.engineExecutionState === 'interrupted' && receipt.stage !== 'worker_completion') {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['engineExecutionState'],
      message: 'interrupted is a worker-closeout state' });
  }
});

export type ComposedRuntimeResources = z.infer<typeof composedRuntimeResourcesSchema>;

type TaskStatus = 'pending' | 'started' | 'completed' | 'blocked' | 'failed' | 'interrupted';
type TurnPhase = 'planning' | 'task';
type TurnKind = 'tool' | 'correction' | 'final';

/** Bounded in-process counters for the one composed review; no prompt or provider payload is retained. */
export class ComposedRuntimeResourceObserver {
  private readonly startedAt: number;
  private readonly now: () => number;
  private readonly configDigest: string | null;
  private readonly configuration: EffectiveReviewConfigReceipt | null;
  private configuredTotalTurns: number | null = null;
  private investigationTurns: number | null = null;
  private verificationReserveTurns: number | null = null;
  private readonly plan = new Map<string, ReviewTask>();
  private readonly statuses = new Map<string, TaskStatus>();
  private readonly sourceReceipts = new Map<string, TaskSourceReceipt>();
  private clientCallsStarted = 0;
  private clientResponsesReceived = 0;
  private settledClientCalls = 0;
  private clientCallsUnsettled = 0;
  private settledClientCallElapsedMs = 0;
  private planningTurns = 0;
  private discoveryTurns = 0;
  private taskFinalizationTurns = 0;
  private taskFinalizationReservedTurns = 0;

  constructor(input: {
    configDigest?: string;
    configuration?: EffectiveReviewConfigReceipt;
    now?: () => number;
    onSnapshot?: (snapshot: ComposedRuntimeResources) => void;
  }) {
    this.now = input.now ?? (() => performance.now());
    this.startedAt = this.now();
    this.configDigest = sha256.safeParse(input.configDigest).success ? input.configDigest! : null;
    this.configuration = input.configuration && effectiveReviewConfigReceiptSchema.safeParse(input.configuration).success
      ? input.configuration : null;
    this.onSnapshot = input.onSnapshot;
  }

  private readonly onSnapshot?: (snapshot: ComposedRuntimeResources) => void;

  configureBudget(input: { configuredTotalTurns: number; investigationTurns: number; verificationReserveTurns: number }): void {
    this.configuredTotalTurns = input.configuredTotalTurns;
    this.investigationTurns = input.investigationTurns;
    this.verificationReserveTurns = input.verificationReserveTurns;
    this.emitSnapshot();
  }

  setPlan(tasks: readonly ReviewTask[]): void {
    this.plan.clear();
    this.statuses.clear();
    this.sourceReceipts.clear();
    for (const task of tasks) {
      this.plan.set(task.id, { ...task, paths: [...task.paths] });
      this.statuses.set(task.id, 'pending');
    }
    this.emitSnapshot();
  }

  markTaskStarted(taskId: string): void {
    if (this.statuses.get(taskId) === 'pending') this.statuses.set(taskId, 'started');
    this.emitSnapshot();
  }

  markTaskOutcome(taskId: string, status: 'completed' | 'blocked' | 'failed', sourceDelivery?: unknown): void {
    if (!this.plan.has(taskId)) return;
    this.statuses.set(taskId, status);
    const parsed = taskSourceReceiptSchema.safeParse(sourceDelivery);
    if (status === 'completed' && parsed.success && parsed.data.taskId === taskId && parsed.data.complete) {
      this.sourceReceipts.set(taskId, parsed.data);
    } else {
      this.sourceReceipts.delete(taskId);
    }
    this.emitSnapshot();
  }

  markTaskInterrupted(taskId: string): void {
    // Preserve an explicit cutoff state even if the underlying client promise
    // settles after the worker stops waiting on it.
    if (this.statuses.get(taskId) === 'started') this.statuses.set(taskId, 'interrupted');
    this.emitSnapshot();
  }

  clientCallStarted(): void { this.clientCallsStarted += 1; this.refreshUnsettledCalls(); this.emitSnapshot(); }

  clientCallSettled(durationMs: number, responseReceived: boolean): void {
    this.settledClientCalls += 1;
    if (Number.isFinite(durationMs) && durationMs >= 0) this.settledClientCallElapsedMs += Math.round(durationMs);
    if (responseReceived) this.clientResponsesReceived += 1;
    this.refreshUnsettledCalls();
    this.emitSnapshot();
  }

  recordTurn(phase: TurnPhase, kind: TurnKind): void {
    if (phase === 'planning') this.planningTurns += 1;
    else if (kind === 'tool') this.discoveryTurns += 1;
    else this.taskFinalizationTurns += 1;
    this.emitSnapshot();
  }

  reserveTaskFinalizationTurns(turns: number): void {
    if (Number.isSafeInteger(turns) && turns > 0) this.taskFinalizationReservedTurns += turns;
    this.emitSnapshot();
  }

  snapshot(mode: 'running' | 'terminal' = 'running'): ComposedRuntimeResources | undefined {
    if (this.configuredTotalTurns === null || this.investigationTurns === null || this.verificationReserveTurns === null
      || this.plan.size === 0) return undefined;
    const plannedTasks = [...this.plan.keys()].sort();
    const started = plannedTasks.filter(id => this.statuses.get(id) !== 'pending');
    const completed = plannedTasks.filter(id => this.statuses.get(id) === 'completed');
    const blocked = plannedTasks.filter(id => this.statuses.get(id) === 'blocked');
    const failed = plannedTasks.filter(id => this.statuses.get(id) === 'failed');
    const interrupted = plannedTasks.filter(id => this.statuses.get(id) === 'interrupted');
    const pending = plannedTasks.filter(id => this.statuses.get(id) === 'pending');
    const inProgress = plannedTasks.filter(id => this.statuses.get(id) === 'started');
    const assignedPaths = [...new Set([...this.plan.values()].flatMap(task => task.paths))].sort();
    const investigatedPaths = assignedPaths.filter(path => {
      const owners = [...this.plan.values()].filter(task => task.paths.includes(path));
      return owners.length > 0 && owners.every(task => {
        if (this.statuses.get(task.id) !== 'completed') return false;
        const source = this.sourceReceipts.get(task.id);
        return source?.complete === true && source.files.some(file => file.path === path);
      });
    });
    const investigated = new Set(investigatedPaths);
    const remainingPaths = assignedPaths.filter(path => !investigated.has(path));
    const engineExecutionState = mode === 'running' ? 'running'
      : completed.length === plannedTasks.length && remainingPaths.length === 0 ? 'complete' : 'incomplete';
    const result = {
      version: 'ComposedRuntimeResources.v1' as const,
      stage: 'composed_engine' as const,
      discoveryScope: 'composed_engine' as const,
      evidenceSemanticsVersion: GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION,
      engineExecutionState,
      configDigest: this.configDigest
        ? { value: this.configDigest, unavailableReason: null }
        : { value: null, unavailableReason: 'The composed engine was invoked without a trusted effective configuration digest.' },
      configuration: this.configuration
        ? { value: this.configuration, unavailableReason: null }
        : { value: null, unavailableReason: 'The composed engine configuration did not contain a parsed effective configuration receipt.' },
      budget: {
        configuredTotalTurns: this.configuredTotalTurns,
        investigationTurns: this.investigationTurns,
        verificationReserveTurns: this.verificationReserveTurns,
      },
      usage: {
        totalTurns: this.planningTurns + this.discoveryTurns + this.taskFinalizationTurns,
        planningTurns: this.planningTurns,
        discoveryTurns: this.discoveryTurns,
        taskFinalizationTurns: this.taskFinalizationTurns,
        taskFinalizationReservedTurns: this.taskFinalizationReservedTurns,
        verifierCalls: { value: null, unavailableReason: 'Grounded verification runs after the composed engine returns.' },
        clientCallsStarted: this.clientCallsStarted,
        clientResponsesReceived: this.clientResponsesReceived,
        settledClientCalls: this.settledClientCalls,
        clientCallsUnsettled: this.clientCallsUnsettled,
        settledClientCallElapsedMs: this.settledClientCallElapsedMs,
        gatewayAcceptedCalls: null,
        gatewayAcceptedCallsUnavailableReason: 'The worker client does not expose relay acceptance counters.',
        providerCompletions: null,
        providerCompletionsUnavailableReason: 'No qualified per-provider completion attestation is available to the composed engine.',
        engineElapsedMonotonicMs: Math.max(0, Math.round(this.now() - this.startedAt)),
      },
      tasks: { planned: plannedTasks, started, completed, blocked, failed, interrupted, pending, inProgress },
      coverage: {
        assignedPaths: pathSetDigest(assignedPaths),
        investigatedPaths: pathSetDigest(investigatedPaths),
        remainingPaths: pathSetDigest(remainingPaths),
        regions: {
          state: 'unavailable' as const,
          reason: 'The composed engine is not yet connected to an authenticated changed-region manifest.',
        },
      },
    };
    const parsed = composedRuntimeResourcesSchema.safeParse(result);
    return parsed.success ? parsed.data : undefined;
  }

  private refreshUnsettledCalls(): void {
    this.clientCallsUnsettled = Math.max(0, this.clientCallsStarted - this.settledClientCalls);
  }

  private emitSnapshot(): void {
    if (!this.onSnapshot) return;
    try {
      const snapshot = this.snapshot('running');
      if (snapshot) this.onSnapshot(snapshot);
    } catch {
      // Snapshot publication is observational and cannot alter composed review behavior.
    }
  }

}

/** Final worker bridge. It binds verifier usage only after the worker has observed the verifier result. */
export function completeComposedRuntimeResources(input: {
  observation: unknown;
  configDigest?: string;
  verifierCalls: number | null;
  verifierCallsUnknownReason?: string;
}): ComposedRuntimeResources | undefined {
  const parsed = composedRuntimeResourcesSchema.safeParse(input.observation);
  if (!parsed.success || parsed.data.stage !== 'composed_engine') return undefined;
  const trustedDigest = sha256.safeParse(input.configDigest).success ? input.configDigest! : null;
  const configDigest = trustedDigest !== null && parsed.data.configDigest.value === trustedDigest
    ? { value: trustedDigest, unavailableReason: null }
    : { value: null, unavailableReason: trustedDigest === null
      ? 'The worker completion bridge did not receive a trusted prepared configuration digest.'
      : 'The composed-engine digest did not match the worker completion prepared digest.' };
  const verifierCalls = Number.isSafeInteger(input.verifierCalls) && input.verifierCalls! >= 0
    ? { value: input.verifierCalls!, unavailableReason: null }
    : { value: null, unavailableReason: input.verifierCallsUnknownReason
      || 'The worker completion bridge did not receive an observed grounded-verifier call count.' };
  const completed = {
    ...parsed.data,
    stage: 'worker_completion' as const,
    engineExecutionState: parsed.data.engineExecutionState === 'running' || parsed.data.tasks.interrupted.length > 0
      ? 'interrupted' as const : parsed.data.engineExecutionState,
    configDigest,
    usage: { ...parsed.data.usage, verifierCalls },
  };
  const finalReceipt = composedRuntimeResourcesSchema.safeParse(completed);
  return finalReceipt.success ? finalReceipt.data : undefined;
}

function pathSetDigest(paths: readonly string[]): { count: number; sha256: string } {
  return { count: paths.length, sha256: createHash('sha256').update(JSON.stringify(paths)).digest('hex') };
}
