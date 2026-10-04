import { describe, expect, it, vi } from 'vitest';
import { createDefaultV3Config } from '../../src/config/configLoader';
import { ctReviewConfigV3Schema } from '../../src/config/schema';
import { executeComposedReview, type ComposedCheckpointSnapshot } from '../../src/panel/composedEngine';
import {
  type ComposedTaskRetentionRequest,
  type ComposedTaskOutcomeRetentionRequest,
} from '../../src/panel/composedTaskRetention';
import { extractMessageContentText } from '../../src/panel/panelEngine';
import { parseChangedFiles } from '../../src/review/changedFiles';
import { parseComposedTaskOutcomeInput } from '../../src/review/composedTaskLedger';
import { canonicalJson, sha256 } from '../../src/review/reviewCore';
import { logger } from '../../src/utils/logger';
import type { PublishingProgressEvent } from '../../src/telemetry/publishingProgress';

const changedFiles = parseChangedFiles([
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1 +1 @@',
  '-export const value = 1;',
  '+export const value = 2;',
  '',
].join('\n')).files;

const config = ctReviewConfigV3Schema.parse({
  ...createDefaultV3Config(),
  quorum: 1,
  personas: [{ id: 'architecture', enabled: true, required: true, charter: 'builtin:architecture', paths: ['**/*'], providers: ['bifrost'] }],
  reviewers: {
    execution: 'personas', fallback: 'none', overall_timeout_s: 30,
    providers: [{ id: 'bifrost', enabled: true, model: 'pr-reviewer', effort: 'medium', review_timeout_s: 15, arbiter_timeout_s: 15 }],
    arbiter: { order: ['bifrost'] },
  },
  review_engine: 'composed',
  composed: { max_tasks: 1 },
});

const blockedReasons = ['unspecified', 'evidence_insufficient', 'tool_evidence_unavailable', 'analysis_unresolved'] as const;
const privateReason = 'SYNTHETIC_BLOCKED_REASON_SECRET';

/** Real engine, synthetic model/retention ports; no provider or persisted review authority. */
function diagnosticHarness(fields: Record<string, unknown>, options: {
  status?: 'BLOCKED' | 'COMPLETE';
  mutate?: (result: Record<string, unknown>) => void;
  retained?: boolean;
  checkpointed?: boolean;
  outcomeAck?: Promise<void>;
  invalidAck?: boolean;
} = {}) {
  const logs: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  const progress: PublishingProgressEvent[] = [];
  const retained: ComposedTaskRetentionRequest[] = [];
  const checkpoints: ComposedCheckpointSnapshot[] = [];
  const order: string[] = [];
  for (const level of ['info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(logger, level).mockImplementation((message, meta) => {
      logs.push({ message, meta: structuredClone(meta) });
      if (meta?.event === 'composed_task_completed') order.push('log');
    });
  }
  let taskTurns = 0;
  const complete = vi.fn(async (request: any) => {
    const text = request.messages.map((message: any) => extractMessageContentText(message.content)).join('\n');
    const nonce = [...text.matchAll(/CT_REVIEW_NONCE:([a-f0-9-]+)/gu)].at(-1)?.[1];
    if (!nonce) throw new Error('synthetic request nonce missing');
    let body: Record<string, unknown>;
    if (!text.includes('WORK TURN')) {
      body = { nonce, tasks: [{ id: 'verify-change', dimension: 'architecture', paths: ['src/app.ts'],
        question: 'Is this change sound?', rationale: 'Review changed code.' }] };
    } else {
      taskTurns += 1;
      body = { nonce, task: 'verify-change', status: options.status ?? 'BLOCKED', findings: [], ...fields };
      options.mutate?.(body);
    }
    return { model: 'pr-reviewer', content: JSON.stringify(body), usage: { prompt: 1, completion: 1, total: 2 }, costUSD: 0, raw: {} };
  });
  const acknowledgement = (request: ComposedTaskRetentionRequest) => ({
    version: 'ComposedTaskRetentionAck.v1', stage: request.stage, status: 'recorded',
    requestDigest: request.requestDigest, receiptDigest: 'e'.repeat(64),
  });
  const persistOutcome = vi.fn(async (request: ComposedTaskOutcomeRetentionRequest) => {
    retained.push(request);
    order.push('persist');
    await options.outcomeAck;
    order.push('ack');
    const ack = acknowledgement(request);
    return options.invalidAck ? { ...ack, requestDigest: '0'.repeat(64) } : ack;
  });
  const run = () => executeComposedReview({
    config: ctReviewConfigV3Schema.parse({ ...config,
      // Leave enough admitted time for retries to be eligible; BLOCKED must not need a retry.
      reviewers: { ...config.reviewers, overall_timeout_s: 1_200 },
      composed: { max_tasks: 1, max_turns_per_task: 1 },
    }),
    changedFiles, repository: 'acme/app', headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), prNumber: 42,
    client: { complete } as never,
    progress: {
      instrument: (client) => client,
      emit: (event) => {
        progress.push(structuredClone(event));
        if (event.task === 'composed_task' && event.status === 'blocked') order.push('terminal');
      },
    },
    ...(options.retained ? { retention: { port: {
      persistPlan: async (request) => { retained.push(request); return acknowledgement(request); },
      persistOutcome,
    } } } : {}),
    ...(options.checkpointed ? { checkpoint: {
      resumed: null,
      capture: (snapshot) => { checkpoints.push(structuredClone(snapshot)); },
      save: async (snapshot) => { checkpoints.push(structuredClone(snapshot)); },
    } } : {}),
  });
  return { run, logs, progress, retained, checkpoints, order, complete, persistOutcome,
    taskTurns: () => taskTurns,
    taskLogs: () => logs.filter(({ meta }) => meta?.event === 'composed_task_completed') };
}

function expectNoDiagnosticOutsideLogs(value: unknown) {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain('blockedReason');
  expect(serialized).not.toContain('modelReportedBlockedReason');
  expect(serialized).not.toContain(privateReason);
}

describe('composed task logs-only model-reported blocked reason', () => {
  it('requires every strict provider object property, using null for the logs-only diagnostic', async () => {
    const harness = diagnosticHarness({ blockedReason: null });
    await harness.run();
    const format = harness.complete.mock.calls.at(-1)![0].responseFormat;
    expect(format).toMatchObject({ type: 'json_schema', json_schema: { strict: true } });
    const schema = format.json_schema.schema;
    for (const objectSchema of [schema, schema.properties.findings.items]) {
      expect(objectSchema.type).toBe('object');
      expect(objectSchema.additionalProperties).toBe(false);
      expect([...objectSchema.required].sort()).toEqual(Object.keys(objectSchema.properties).sort());
    }
    expect(schema.properties.blockedReason).toEqual({ type: ['string', 'null'], enum: [...blockedReasons, null] });
  });

  it.each(['BLOCKED', 'COMPLETE'] as const)('still admits legacy omitted blockedReason on %s despite provider requiredness', async (status) => {
    const harness = diagnosticHarness({}, { status, retained: true });
    const result = await harness.run();
    const request = harness.complete.mock.calls.at(-1)![0];
    expect(request.responseFormat.json_schema.schema.required).toContain('blockedReason');
    const directives = request.messages.map((message: any) => extractMessageContentText(message.content))
      .filter((text: string) => text.includes('=== WORK TURN:') || text.startsWith('TASK_FINALIZATION'));
    expect(directives).toHaveLength(2);
    for (const directive of directives) {
      expect(directive).toContain('blockedReason is required by the strict provider schema');
      expect(directive).toContain('for COMPLETE use null');
      expect(directive).not.toContain('optional blockedReason');
      expect(directive).not.toContain('plus optional "blockedReason"');
    }
    expect(result.quorum.satisfied).toBe(status === 'COMPLETE');
    expect(harness.taskTurns()).toBe(1);
    if (status === 'BLOCKED') {
      expect(harness.taskLogs()[0].meta?.modelReportedBlockedReason).toBe('unspecified');
      expect(result.optionalFailures).toMatchObject([{ id: 'verify-change', failureClass: 'contract' }]);
    } else {
      expect(harness.taskLogs()[0].meta).not.toHaveProperty('modelReportedBlockedReason');
      expect(result.personas).toMatchObject([{ id: 'verify-change', decision: 'APPROVE', findings: [] }]);
    }
    expectNoDiagnosticOutsideLogs({ result, retained: harness.retained, progress: harness.progress });
  });

  const cases: Array<[string, Record<string, unknown>, string]> = [
    ...blockedReasons.map((reason): [string, Record<string, unknown>, string] => [reason, { blockedReason: reason }, reason]),
    ['legacy omission', {}, 'unspecified'],
    ['null', { blockedReason: null }, 'unspecified'],
    ['unknown enum', { blockedReason: 'unknown_reason' }, 'unspecified'],
    ['planted secret', { blockedReason: privateReason }, 'unspecified'],
    ['control characters', { blockedReason: `${privateReason}\n\u0000` }, 'unspecified'],
    ['number', { blockedReason: 42 }, 'unspecified'],
    ['boolean', { blockedReason: true }, 'unspecified'],
    ['object', { blockedReason: { secret: privateReason } }, 'unspecified'],
    ['array', { blockedReason: [privateReason] }, 'unspecified'],
  ];

  it.each(cases)('logs only the normalized code for %s without changing retained failure authority', async (_name, fields, expected) => {
    const harness = diagnosticHarness(fields, { retained: true });
    const result = await harness.run();
    expect(result.personas).toEqual([]);
    expect(result.optionalFailures).toEqual([{
      id: 'verify-change', failureClass: 'contract',
      error: 'Task verify-change (architecture) reported BLOCKED for path(s) [src/app.ts]: Is this change sound?',
    }]);
    expect(result.unreportedLanes).toEqual([]);
    expect(result.quorum.satisfied).toBe(false);
    expect(harness.taskTurns()).toBe(1);
    expect(harness.complete).toHaveBeenCalledTimes(2); // One plan, one task; no retries/corrections.
    const taskRequest = harness.complete.mock.calls.at(-1)![0];
    const schema = taskRequest.responseFormat.json_schema.schema;
    expect(schema.required).toEqual(['nonce', 'task', 'status', 'blockedReason', 'findings']);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.blockedReason).toEqual({ type: ['string', 'null'], enum: [...blockedReasons, null] });
    expect(harness.taskLogs()).toHaveLength(1);
    expect(harness.taskLogs()[0].meta).toMatchObject({ outcomeType: 'blocked', attempts: 1, turnCount: 1,
      modelReportedBlockedReason: expected });
    expect(JSON.stringify(harness.logs)).not.toContain(privateReason);
    const request = harness.retained.find((entry) => entry.stage === 'outcome')!;
    expect(Object.keys(request.evidence).sort()).toEqual(['planDigest', 'status', 'taskId', 'taskIndex', 'usage']);
    const { taskIndex, ...ledgerInput } = request.evidence;
    expect(taskIndex).toBe(0);
    expect(parseComposedTaskOutcomeInput(ledgerInput).status).toBe('blocked');
    const { requestDigest, ...unsignedRequest } = request;
    expect(requestDigest).toBe(sha256(canonicalJson(unsignedRequest)));
    expectNoDiagnosticOutsideLogs({ result, retained: harness.retained, progress: harness.progress });
    expect(harness.order).toEqual(['log', 'persist', 'ack', 'terminal']);
  });

  it.each(cases)('ignores the diagnostic on COMPLETE (%s)', async (_name, fields) => {
    const harness = diagnosticHarness(fields, { status: 'COMPLETE', retained: true });
    const result = await harness.run();
    expect(result.personas).toMatchObject([{ id: 'verify-change', decision: 'APPROVE', findings: [] }]);
    expect(result.optionalFailures).toEqual([]);
    expect(result.quorum.satisfied).toBe(true);
    expect(harness.taskTurns()).toBe(1);
    expect(harness.taskLogs()).toHaveLength(1);
    expect(harness.taskLogs()[0].meta).not.toHaveProperty('modelReportedBlockedReason');
    expectNoDiagnosticOutsideLogs({ result, retained: harness.retained, progress: harness.progress, logs: harness.logs });
  });

  it.each([
    ['task_id_mismatch', (body: Record<string, unknown>) => { body.task = 'other-task'; }],
    ['nonce_mismatch', (body: Record<string, unknown>) => { body.nonce = 'wrong-nonce'; }],
    ['invalid_status', (body: Record<string, unknown>) => { body.status = 'UNKNOWN'; }],
    ['invalid_findings', (body: Record<string, unknown>) => { body.findings = 'not-an-array'; }],
    ['invalid_result_fields', (body: Record<string, unknown>) => { body.otherField = privateReason; }],
  ] as const)('still rejects %s before the blocked diagnostic can be admitted', async (reason, mutate) => {
    const harness = diagnosticHarness({ blockedReason: privateReason }, { mutate, retained: true });
    const result = await harness.run();
    expect(result.personas).toEqual([]);
    expect(result.optionalFailures).toEqual([]);
    expect(result.quorum.satisfied).toBe(false);
    expect(result.unreportedLanes?.[0].diagnostics?.reason).toBe(reason);
    expect(harness.taskLogs().every(({ meta }) => !Object.hasOwn(meta!, 'modelReportedBlockedReason'))).toBe(true);
    expectNoDiagnosticOutsideLogs({ result, retained: harness.retained, progress: harness.progress, logs: harness.logs });
  });

  it.each(['BLOCKED', 'COMPLETE'] as const)('does not put the diagnostic in legacy %s checkpoints', async (status) => {
    const harness = diagnosticHarness({ blockedReason: 'analysis_unresolved' }, { status, checkpointed: true });
    const result = await harness.run();
    expect(harness.checkpoints.length).toBeGreaterThan(0);
    expect(harness.checkpoints.at(-1)?.completedTasks).toEqual(status === 'BLOCKED' ? [] : [{ id: 'verify-change', findings: [] }]);
    expectNoDiagnosticOutsideLogs({ result, checkpoints: harness.checkpoints, progress: harness.progress });
  });

  it('keeps the lifecycle log before ACK and terminal progress after ACK, never treating the log as durability', async () => {
    let releaseAck!: () => void;
    const outcomeAck = new Promise<void>((resolve) => { releaseAck = resolve; });
    const harness = diagnosticHarness({ blockedReason: 'tool_evidence_unavailable' }, { retained: true, outcomeAck });
    let settled = false;
    const pending = harness.run().then((result) => { settled = true; return result; });
    try {
      await vi.waitFor(() => expect(harness.persistOutcome).toHaveBeenCalledTimes(1));
      expect(harness.order).toEqual(['log', 'persist']);
      expect(harness.taskLogs()[0].meta?.modelReportedBlockedReason).toBe('tool_evidence_unavailable');
      expect(harness.progress.some((event) => event.task === 'composed_task' && event.status === 'blocked')).toBe(false);
      expect(settled).toBe(false);
    } finally {
      releaseAck();
      await pending;
    }
    expect(harness.order).toEqual(['log', 'persist', 'ack', 'terminal']);
  });

  it('still fails a mismatched ACK despite the diagnostic log, with no terminal blocked progress', async () => {
    const harness = diagnosticHarness({ blockedReason: 'analysis_unresolved' }, { retained: true, invalidAck: true });
    await expect(harness.run()).rejects.toMatchObject({ code: 'composed_task_retention_failed', failureCode: 'ack_invalid' });
    expect(harness.taskLogs()[0].meta?.modelReportedBlockedReason).toBe('analysis_unresolved');
    expect(harness.progress.some((event) => event.task === 'composed_task' && event.status === 'blocked')).toBe(false);
    expectNoDiagnosticOutsideLogs({ retained: harness.retained, progress: harness.progress });
  });
});

function makeClient(alwaysRequestToolOnFinal = false) {
  let taskTurns = 0;
  const complete = vi.fn(async (request: any) => {
    const prompt = request.messages.map((message: any) => extractMessageContentText(message.content)).join('\n');
    const nonces = [...prompt.matchAll(/CT_REVIEW_NONCE:([a-f0-9-]+)/gu)];
    const nonce = nonces.at(-1)?.[1];
    if (!nonce) throw new Error('task or plan nonce missing');
    let body: unknown;
    if (!prompt.includes('WORK TURN')) {
      body = { nonce, tasks: [{ id: 'verify-change', dimension: 'architecture', paths: ['src/app.ts'], question: 'Is this change sound?', rationale: 'Review changed code.' }] };
    } else {
      taskTurns += 1;
      body = taskTurns <= 10 || (alwaysRequestToolOnFinal && taskTurns <= 12)
        ? { tool: 'read_file', args: { path: 'src/app.ts' } }
        : { nonce, task: 'verify-change', status: 'COMPLETE', findings: [] };
    }
    return { model: 'pr-reviewer', content: JSON.stringify(body), usage: { prompt: 1, completion: 1, total: 2 }, costUSD: 0, raw: {} };
  });
  return { complete, getTaskTurns: () => taskTurns };
}

describe('composed task finalization', () => {
  it.each([1, 2])('keeps a bound finalization turn with a %i-turn task ceiling', async (ceiling) => {
    let taskTurns = 0;
    const complete = vi.fn(async (request: any) => {
      const prompt = request.messages.map((message: any) => extractMessageContentText(message.content)).join('\n');
      const nonces = [...prompt.matchAll(/CT_REVIEW_NONCE:([a-f0-9-]+)/gu)];
      const nonce = nonces.at(-1)?.[1];
      if (!nonce) throw new Error('task or plan nonce missing');
      let body: unknown;
      if (!prompt.includes('WORK TURN')) {
        body = { nonce, tasks: [{ id: 'verify-change', dimension: 'architecture', paths: ['src/app.ts'], question: 'Is this change sound?', rationale: 'Review changed code.' }] };
      } else {
        taskTurns += 1;
        body = ceiling === 2 && taskTurns === 1
          ? { tool: 'read_file', args: { path: 'src/app.ts' } }
          : { nonce, task: 'verify-change', status: 'COMPLETE', findings: [] };
      }
      return { model: 'pr-reviewer', content: JSON.stringify(body), usage: { prompt: 1, completion: 1, total: 2 }, costUSD: 0, raw: {} };
    });
    const narrowedConfig = ctReviewConfigV3Schema.parse({
      ...config,
      composed: { max_tasks: 1, max_turns_per_task: ceiling },
    });
    const result = await executeComposedReview({
      config: narrowedConfig, changedFiles, repository: 'acme/app', headSha: 'c'.repeat(40), client: { complete } as never,
    });
    const taskCalls = complete.mock.calls.map(([request]) => request as any).filter((request) =>
      request.messages.some((message: any) => extractMessageContentText(message.content).includes('WORK TURN')));
    expect(taskTurns).toBe(ceiling);
    expect(taskCalls).toHaveLength(ceiling);
    expect(taskCalls.at(-1)?.responseFormat.json_schema.name).toBe('ct_review_task_result_v1');
    expect(taskCalls.at(-1)?.messages.some((message: any) => extractMessageContentText(message.content).includes('TASK_FINALIZATION'))).toBe(true);
    if (ceiling === 2) {
      expect(taskCalls[0].responseFormat).toEqual({ type: 'json_object' });
      expect(taskCalls[0].messages.some((message: any) => extractMessageContentText(message.content).includes('TASK_FINALIZATION'))).toBe(false);
    }
    expect(result.personas).toMatchObject([{ id: 'verify-change', decision: 'APPROVE', toolTurns: ceiling - 1 }]);
    expect(result.unreportedLanes).toEqual([]);
  });

  it('accepts a bound verdict after nine read-only turns and one corrected final turn', async () => {
    const client = makeClient();
    const result = await executeComposedReview({
      config, changedFiles, repository: 'acme/app', headSha: 'a'.repeat(40), client: client as never,
    });
    expect(client.getTaskTurns()).toBe(11);
    expect(result.applicablePersonaIds).toEqual(['verify-change']);
    expect(result.personas).toMatchObject([{ id: 'verify-change', decision: 'APPROVE', toolTurns: 9 }]);
    expect(result.unreportedLanes).toEqual([]);
    const finalCall = client.complete.mock.calls.at(-1)?.[0] as any;
    expect(finalCall.responseFormat.json_schema.name).toBe('ct_review_task_result_v1');
    expect(finalCall.messages.some((message: any) => extractMessageContentText(message.content).includes('TASK_FINALIZATION'))).toBe(true);
  });

  it('keeps a task off the roster if every finalization response is still a tool request', async () => {
    const client = makeClient(true);
    const result = await executeComposedReview({
      config, changedFiles, repository: 'acme/app', headSha: 'b'.repeat(40), client: client as never,
    });
    expect(client.getTaskTurns()).toBe(12);
    expect(result.personas).toEqual([]);
    expect(result.unreportedLanes).toMatchObject([{ id: 'verify-change', failureClass: 'malformed_output' }]);
    expect(result.unreportedLanes?.[0]).toMatchObject({
      diagnostics: {
        reason: 'tool_requested_during_finalization', turnsUsed: 12,
        correctionAttempts: 2, toolTurns: 9, lastToolOutcome: 'requested_after_finalization',
      },
    });
  });

  it.each([
    ['non_json_task_result', 'not-json'],
    ['task_id_mismatch', 'wrong-task'],
    ['nonce_mismatch', 'wrong-nonce'],
    ['invalid_status', 'wrong-status'],
    ['invalid_findings', 'wrong-findings'],
    ['invalid_status', 'unknown-finish-reason'],
  ])('retains only the coded %s rejection, never the rejected provider payload', async (reason, variant) => {
    const complete = vi.fn(async (request: any) => {
      const prompt = request.messages.map((message: any) => extractMessageContentText(message.content)).join('\n');
      const nonce = [...prompt.matchAll(/CT_REVIEW_NONCE:([a-f0-9-]+)/gu)].at(-1)?.[1];
      const work = prompt.includes('WORK TURN');
      const result: any = { nonce, task: 'verify-change', status: 'COMPLETE', findings: [] };
      if (variant === 'wrong-task') result.task = 'SENSITIVE_PROVIDER_PAYLOAD';
      if (variant === 'wrong-nonce') result.nonce = 'SENSITIVE_PROVIDER_PAYLOAD';
      if (variant === 'wrong-status' || variant === 'unknown-finish-reason') result.status = 'SENSITIVE_PROVIDER_PAYLOAD';
      if (variant === 'wrong-findings') result.findings = 'SENSITIVE_PROVIDER_PAYLOAD';
      const content = !work
        ? JSON.stringify({ nonce, tasks: [{ id: 'verify-change', dimension: 'architecture', paths: ['src/app.ts'], question: 'Is this sound?', rationale: 'Review.' }] })
        : variant === 'not-json' ? 'SENSITIVE_PROVIDER_PAYLOAD' : JSON.stringify(result);
      return { model: 'pr-reviewer', content, usage: { prompt: 1, completion: 1, total: 2 }, costUSD: 0,
        raw: { choices: [{ finish_reason: variant === 'unknown-finish-reason' ? 'SENSITIVE_PROVIDER_PAYLOAD' : 'length' }], private: 'SENSITIVE_PROVIDER_PAYLOAD' } };
    });
    const narrowedConfig = ctReviewConfigV3Schema.parse({ ...config, composed: { max_tasks: 1, max_turns_per_task: 1 } });
    const result = await executeComposedReview({ config: narrowedConfig, changedFiles, repository: 'acme/app', headSha: 'd'.repeat(40), client: { complete } as never });
    expect(result.personas).toEqual([]);
    expect(result.applicablePersonaIds).toEqual(['verify-change']);
    expect(result.unreportedLanes?.[0]).toMatchObject({ failureClass: 'malformed_output', diagnostics: {
      reason, turnsUsed: 1, correctionAttempts: 0, toolTurns: 0,
      finishReason: variant === 'unknown-finish-reason' ? 'unrecognized' : 'length', lastToolOutcome: 'none',
    } });
    expect(result.unreportedLanes?.[0]?.error).toContain(`reason=${reason}`);
    expect(JSON.stringify(result)).not.toContain('SENSITIVE_PROVIDER_PAYLOAD');
  });
});
