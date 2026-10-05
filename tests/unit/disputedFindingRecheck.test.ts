import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ReviewExecutionCheckpoint } from '../../src/review/reviewExecutionCheckpoint';
import { canonicalJson, sha256 } from '../../src/review/reviewCore';
import { getReviewFindingId } from '../../src/mcp/server/tools/findingIdentity';
import { parseWorkerReviewCompletion, workerReviewCompletionDigest } from '../../src/review/workerReviewCompletion';
import {
  disputedFindingRecheckDigest, loadValidatedDisputedFindingRechecks,
  parseDisputedFindingRecheck, validateDisputedFindingRecheckRow, pendingDisputedFindingRechecks, remainingCheckpointTasksAfterRechecks,
} from '../../src/review/disputedFindingRecheck';

const names = {
  request_id: 'requestId', run_id: 'runId', source_execution_attempt: 'sourceExecutionAttempt',
  source_content_digest: 'sourceContentDigest', source_plan_digest: 'sourcePlanDigest',
  source_gate_attempt_id: 'sourceGateAttemptId', repository_id: 'repositoryId', owner: 'owner', repo: 'repo',
  pr_number: 'prNumber', head_sha: 'headSha', base_sha: 'baseSha', policy_digest: 'policyDigest',
  config_digest: 'configDigest', finding_id: 'findingId', persona_id: 'personaId', task_id: 'taskId',
  finding: 'finding', counter_argument: 'counterArgument', counter_argument_digest: 'counterArgumentDigest',
};
function unsigned(row: any): any {
  const request = Object.fromEntries(Object.entries(names).map(([key, name]) => [name, row[key]]));
  for (const key of ['sourceExecutionAttempt', 'repositoryId', 'prNumber']) request[key] = Number(request[key]);
  if (typeof request.finding === 'string') request.finding = JSON.parse(request.finding);
  return request;
}
function sign(row: any): void { row.request_digest = disputedFindingRecheckDigest(unsigned(row)); }
function request(row: any): any { return { ...unsigned(row), requestDigest: row.request_digest }; }
function fixture(): { row: any; run: any } {
  const run = { run_id: `run_${'7'.repeat(32)}`, repository_id: 123, owner: 'review-yeti-ai', repo: 'review-yeti-bot',
    pr_number: 42, head_sha: 'a'.repeat(40), base_sha: 'b'.repeat(40),
    effective_policy_digest: 'c'.repeat(64), effective_config_digest: 'd'.repeat(64) };
  const coordinates = { runId: run.run_id, repositoryId: run.repository_id, owner: run.owner, repo: run.repo,
    prNumber: run.pr_number, headSha: run.head_sha, baseSha: run.base_sha,
    policyDigest: run.effective_policy_digest, configDigest: run.effective_config_digest, executionAttempt: 1 };
  const finding = { severity: 'P2', path: 'src/auth/guard.ts', line: 17, startLine: 15,
    title: 'Binding must survive reload', body: 'The request must name its immutable source finding.' };
  const task = { id: 'security-reviewer', dimension: 'security', paths: [finding.path],
    question: 'Is the source binding preserved?', rationale: 'The source identity crosses a persistence boundary.' };
  const completion = parseWorkerReviewCompletion({ version: 'WorkerReviewCompletion.v1', ...coordinates,
    result: { version: 'WorkerReviewResult.v1', completedAt: '2026-10-01T00:00:00.000Z',
      personas: [{ id: task.id, decision: 'FINDINGS', status: 'COMPLETE', findings: [finding] }],
      taskPlan: [task], coverageComplete: true, quorumSatisfied: true } });
  const content = workerReviewCompletionDigest(completion), attemptId = `${run.run_id}-g1-e1`;
  const { startLine: _startLine, ...snapshot } = finding;
  const { configDigest: _configDigest, ...gateCoordinates } = coordinates;
  const row = { request_id: '11111111-1111-4111-8111-111111111111', ...run, source_execution_attempt: 1,
    policy_digest: coordinates.policyDigest, config_digest: coordinates.configDigest,
    source_content_digest: content, source_plan_digest: sha256(canonicalJson([task])), source_gate_attempt_id: attemptId,
    finding_id: getReviewFindingId(run.run_id, task.id, finding), persona_id: task.id, task_id: task.id, finding: snapshot,
    counter_argument: 'A concrete counterexample for this immutable source finding.', counter_argument_digest: '',
    request_digest: '', completion_execution_attempt: 1, completion_content_digest: content, completion_payload: completion,
    bound_gate_attempt_id: attemptId, gate_worker_result_digest: content,
    gate_coordinates: { ...gateCoordinates, attemptId }, gate_creation_state: 'bound', gate_check_id: '60001',
    gate_desired_state: 'failure', gate_desired_version: '2', gate_published_version: '2' };
  row.counter_argument_digest = sha256(row.counter_argument); sign(row); return { row, run };
}
function rearchive(row: any): void {
  const content = workerReviewCompletionDigest(row.completion_payload);
  row.source_content_digest = row.completion_content_digest = row.gate_worker_result_digest = content; sign(row);
}
const sourceError = 'Disputed finding source binding is invalid';
const archiveError = 'Disputed finding source completion is invalid';
const planError = 'Disputed finding task plan binding is invalid';
const findingError = 'Disputed finding is absent from its immutable source completion';
const gateError = 'Disputed finding Gate binding is invalid';

describe('immutable disputed-finding request validator', () => {
  it('binds canonical signing independently and accepts key reordering', () => {
    const { row } = fixture(), value = unsigned(row);
    const golden = createHash('sha256').update(canonicalJson(value)).digest('hex');
    expect(disputedFindingRecheckDigest(value)).toBe(golden);
    expect(parseDisputedFindingRecheck({ requestDigest: golden, ...Object.fromEntries(Object.entries(value).reverse()) })).toEqual(request(row));
  });
  it.each(['P0', 'P1', 'P2'])('accepts a source snapshot of severity %s', (severity) => {
    const { row, run } = fixture(); row.finding.severity = row.completion_payload.result.personas[0].findings[0].severity = severity;
    rearchive(row); expect(validateDisputedFindingRecheckRow(row, run, 2).finding.severity).toBe(severity);
  });
  it.each(['x'.repeat(10_000), 'Counterexample: 日本語 🦉'])('retains bounded and Unicode argument bytes', (argument) => {
    const { row } = fixture(); row.counter_argument = argument; row.counter_argument_digest = createHash('sha256').update(argument).digest('hex');
    sign(row); expect(parseDisputedFindingRecheck(request(row)).counterArgument).toBe(argument);
  });
  it.each([
    ['requestId', 'bad'], ['runId', 'run_ABC'], ['sourceExecutionAttempt', true], ['repositoryId', 0],
    ['prNumber', 1.5], ['sourceExecutionAttempt', Number.MAX_SAFE_INTEGER + 1], ['headSha', 'A'.repeat(40)],
    ['baseSha', 'short'], ['sourceContentDigest', 'bad'], ['policyDigest', 'bad'], ['taskId', 'Bad task'],
    ['counterArgument', ''], ['counterArgument', 'x'.repeat(10_001)], ['unexpected', 'extra'],
  ])('rejects malformed envelope field %s', (key, value) => {
    const { row } = fixture(); expect(() => parseDisputedFindingRecheck({ ...request(row), [key]: value })).toThrow();
  });
  it('rejects strict snapshot extras and both independently invalid signatures', () => {
    const { row } = fixture(); expect(() => parseDisputedFindingRecheck({ ...request(row), finding: { ...row.finding, extra: true } })).toThrow();
    expect(() => parseDisputedFindingRecheck({ ...request(row), counterArgument: 'changed' })).toThrow('Disputed finding recheck digest mismatch');
    row.counter_argument_digest = 'e'.repeat(64); sign(row);
    expect(() => parseDisputedFindingRecheck(request(row))).toThrow('Disputed finding counter-argument digest mismatch');
  });
  it.each(['success', 'failure'])('accepts published terminal Gate %s and PG numeric strings', (state) => {
    const { row, run } = fixture(); row.gate_desired_state = state; row.gate_published_version = '3';
    row.source_execution_attempt = '1'; row.repository_id = '123'; row.pr_number = '42';
    for (const key of ['finding', 'completion_payload', 'gate_coordinates']) row[key] = JSON.stringify(row[key]);
    expect(validateDisputedFindingRecheckRow(row, run, 2)).toEqual(request(row));
  });
  it.each(['run_id', 'repository_id', 'owner', 'repo', 'pr_number', 'head_sha', 'base_sha', 'policy_digest', 'config_digest'])('rejects re-signed foreign request %s', (key) => {
    const { row, run } = fixture(); row[key] = typeof row[key] === 'number' ? row[key] + 1 : row[key].replace(/.$/, 'e'); sign(row);
    expect(() => validateDisputedFindingRecheckRow(row, run, 2)).toThrow(sourceError);
  });
  it.each([1, 0])('rejects a source not older than current attempt %s', (attempt) => {
    const { row, run } = fixture(); expect(() => validateDisputedFindingRecheckRow(row, run, attempt)).toThrow(sourceError);
  });
  it.each([
    ['completion_execution_attempt', 2], ['completion_content_digest', 'e'.repeat(64)], ['gate_worker_result_digest', 'e'.repeat(64)],
    ['bound_gate_attempt_id', 'foreign'], ['gate_creation_state', 'reserved'], ['gate_creation_state', 'creating'],
    ['gate_check_id', null], ['gate_desired_state', 'pending'], ['gate_published_version', '1'],
  ])('rejects unpublished or unbound source %s=%s', (key, value) => {
    const { row, run } = fixture(); row[key] = value; expect(() => validateDisputedFindingRecheckRow(row, run, 2)).toThrow(sourceError);
  });
  it.each([null, undefined, '{', { version: 'wrong' }])('rejects a lost/malformed source archive', (payload) => {
    const { row, run } = fixture(); row.completion_payload = payload; expect(() => validateDisputedFindingRecheckRow(row, run, 2)).toThrow();
  });
  it('rejects valid-schema archive content with a stale stored digest', () => {
    const { row, run } = fixture(); row.completion_payload.result.completedAt = '2026-10-02T00:00:00.000Z';
    expect(() => validateDisputedFindingRecheckRow(row, run, 2)).toThrow(archiveError);
  });
  it.each(['runId', 'executionAttempt', 'repositoryId', 'owner', 'repo', 'prNumber', 'headSha', 'baseSha', 'policyDigest', 'configDigest'])('rejects re-hashed foreign archive %s', (key) => {
    const { row, run } = fixture(), archive = row.completion_payload;
    archive[key] = typeof archive[key] === 'number' ? archive[key] + 1 : archive[key].replace(/.$/, 'e'); rearchive(row);
    expect(() => validateDisputedFindingRecheckRow(row, run, 2)).toThrow(archiveError);
  });
  it('retains protected responseStatus telemetry in the archive digest', () => {
    const { row, run } = fixture(), zero = { started: 0, completed: 0, failed: 0, aborted: 0, skipped: 0, blocked: 0, rejected: 0 };
    row.completion_payload.result.failureDiagnostics = { reason: 'observed_failure', logTail: '', operationalTelemetry: {
      version: 'OperationalTelemetry.v1', basis: 'observed_worker_client', cause: 'unknown', eventCount: 1, eventsDropped: 0,
      recentEvents: [{ task: 'provider_call', status: 'failed', responseStatus: 429 }],
      phaseCounts: { panel: zero, persona_lane: zero, composed_plan: zero, composed_task: zero, provider_call: { ...zero, failed: 1 }, provider_output: zero },
      providerCalls: { started: 1, completed: 0, failed: 1, aborted: 0, inflight: 0 }, responseUsage: { availability: 'unknown', responses: 0,
        samples: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, costUSD: 0 }, totals: {} }, panel: { invoked: true } } };
    rearchive(row); expect(validateDisputedFindingRecheckRow(row, run, 2)).toEqual(request(row));
    delete row.completion_payload.result.failureDiagnostics.operationalTelemetry.recentEvents[0].responseStatus;
    expect(() => validateDisputedFindingRecheckRow(row, run, 2)).toThrow(archiveError);
  });
  it.each(['missing', 'digest', 'task', 'persona'])('rejects task-plan binding %s', (kind) => {
    const { row, run } = fixture();
    if (kind === 'missing') { delete row.completion_payload.result.taskPlan; rearchive(row); }
    else if (kind === 'digest') { row.source_plan_digest = 'e'.repeat(64); sign(row); }
    else { row[kind === 'task' ? 'task_id' : 'persona_id'] = 'other-reviewer'; sign(row); }
    expect(() => validateDisputedFindingRecheckRow(row, run, 2)).toThrow(planError);
  });
  it('uses canonical I1 identity, with persona and both endpoints independently bound', () => {
    const { row, run } = fixture(), finding = row.completion_payload.result.personas[0].findings[0];
    const golden = createHash('sha256').update(`${run.run_id}:security-reviewer:src/auth/guard.ts:15:17:Binding must survive reload`).digest('hex').slice(0, 16);
    expect(row.finding_id).toBe(golden); expect(validateDisputedFindingRecheckRow(row, run, 2).findingId).toBe(golden);
    row.finding_id = createHash('sha256').update(`${run.run_id}:src/auth/guard.ts:15:${finding.title}`).digest('hex').slice(0, 16); sign(row);
    expect(() => validateDisputedFindingRecheckRow(row, run, 2)).toThrow(findingError);
  });
  it.each(['severity', 'path', 'line', 'title', 'body'])('rejects re-signed snapshot mutation %s', (key) => {
    const { row, run } = fixture(); row.finding[key] = key === 'line' ? 18 : key === 'severity' ? 'P1' : 'different'; sign(row);
    expect(() => validateDisputedFindingRecheckRow(row, run, 2)).toThrow(findingError);
  });
  it.each(['persona', 'finding', 'identity'])('rejects missing immutable source %s', (kind) => {
    const { row, run } = fixture();
    if (kind === 'persona') row.completion_payload.result.personas[0].id = 'other-reviewer';
    else if (kind === 'finding') row.completion_payload.result.personas[0].findings = [];
    else row.finding_id = 'not-the-canonical-id';
    rearchive(row); expect(() => validateDisputedFindingRecheckRow(row, run, 2)).toThrow(findingError);
  });
  it.each(['runId', 'repositoryId', 'owner', 'repo', 'prNumber', 'headSha', 'baseSha', 'policyDigest', 'executionAttempt', 'attemptId'])('rejects foreign Gate coordinate %s', (key) => {
    const { row, run } = fixture(), coordinates = row.gate_coordinates;
    coordinates[key] = typeof coordinates[key] === 'number' ? coordinates[key] + 1 : coordinates[key].replace(/.$/, 'e');
    expect(() => validateDisputedFindingRecheckRow(row, run, 2)).toThrow(gateError);
  });
  it.each([null, '{', 'null', 'false', 1])('rejects lost or malformed Gate JSON', (coordinates) => {
    const { row, run } = fixture(); row.gate_coordinates = coordinates; expect(() => validateDisputedFindingRecheckRow(row, run, 2)).toThrow(gateError);
  });
  it.each([null, '{', undefined])('rejects malformed persisted finding JSON', (finding) => {
    const { row, run } = fixture(); row.finding = finding; expect(() => validateDisputedFindingRecheckRow(row, run, 2)).toThrow();
  });
  it('returns no batch only when current execution has no request or immutable admission evidence', async () => {
    const { run } = fixture(); const query = vi.fn().mockResolvedValue({ rows: [] });
    expect(await loadValidatedDisputedFindingRechecks({ query }, run, 2)).toEqual([]);
    const [sql, values] = query.mock.calls[0]; expect(values).toEqual([run.run_id, 1]);
    for (const binding of ['LEFT JOIN review_worker_completions completion', 'completion.run_id = request.run_id',
      'completion.execution_attempt = request.source_execution_attempt', 'LEFT JOIN review_gate_attempts gate',
      'gate.attempt_id = request.source_gate_attempt_id', 'gate.run_id = request.run_id',
      'gate.execution_attempt = request.source_execution_attempt', 'WHERE request.run_id = $1',
      'request.source_execution_attempt = $2',
      'ORDER BY request.source_execution_attempt, request.created_at, request.request_id', 'LIMIT 9']) expect(sql).toContain(binding);
    expect(sql).not.toContain('JOIN review_finding_recheck_admissions');
    expect(query.mock.calls.every(([statement]) => !/\b(?:INSERT|UPDATE|DELETE)\b/u.test(statement))).toBe(true);
    expect(query).toHaveBeenCalledTimes(5);
  });
  it('loads eight members only after the exact admission, reservations, and immutable events reconcile', async () => {
    const { run, row: base } = fixture();
    const rows = Array.from({ length: 8 }, (_, index) => {
      const row = fixture().row;
      row.request_id = `11111111-1111-4111-8111-${String(index + 1).padStart(12, '0')}`;
      row.requested_by = 'e'.repeat(64); row.created_at = new Date(index).toISOString(); sign(row); return row;
    });
    const snapshot = '9'.repeat(64), targetGateId = `${run.run_id}-g2-e2`;
    const targetGateCoordinates = { runId: run.run_id, repositoryId: run.repository_id, owner: run.owner, repo: run.repo,
      prNumber: run.pr_number, headSha: run.head_sha, baseSha: run.base_sha,
      policyDigest: run.effective_policy_digest, executionAttempt: 2, attemptId: targetGateId };
    const admission = { run_id: run.run_id, source_execution_attempt: 1, trigger_request_id: rows[0]!.request_id,
      execution_attempt: 2, review_generation: 2, gate_attempt_id: targetGateId, requested_by: rows[0]!.requested_by,
      target_gate_generation: 2, target_gate_execution_attempt: 2, target_gate_repository_id: run.repository_id,
      target_gate_pr_number: run.pr_number, target_gate_coordinates: targetGateCoordinates,
      target_gate_expected_app_id: 4385771, target_gate_current_attempt: true,
      current_generation: 2, authoritative_gate_app_id: 4385771 };
    const sourceReservation = { reservation_id: 'source-reservation', lifecycle_id: 'lifecycle',
      run_id: run.run_id, execution_attempt: 1,
      status: 'failed', completion_digest: rows[0]!.source_content_digest, head_sha: run.head_sha, base_sha: run.base_sha,
      policy_digest: run.effective_policy_digest, config_digest: run.effective_config_digest, context_digest: snapshot,
      repository_id: run.repository_id, owner: run.owner, repo: run.repo, pr_number: run.pr_number };
    const targetReservation = { ...sourceReservation, reservation_id: 'target-reservation', execution_attempt: 2,
      status: 'reserved', completion_digest: null };
    const event = (row: any, target: boolean) => ({ event_id: `event-${row.request_id}-${target}`,
      lifecycle_id: 'lifecycle',
      reservation_id: target ? targetReservation.reservation_id : sourceReservation.reservation_id,
      idempotency_key: `${row.request_id}:recheck-${target ? 'target-admitted' : 'requested'}`,
      event_type: target ? 'finding.recheck_target_admitted' : 'finding.recheck_requested',
      run_id: run.run_id, execution_attempt: target ? 2 : 1, repository_id: run.repository_id,
      pr_number: run.pr_number, head_sha: run.head_sha, base_sha: run.base_sha,
      policy_digest: run.effective_policy_digest, config_digest: run.effective_config_digest,
      context_digest: snapshot, evidence_digest: row.request_digest, actor_digest: row.requested_by,
      payload: target ? { requestId: row.request_id, requestDigest: row.request_digest, sourceRunId: run.run_id,
        sourceExecutionAttempt: 1, sourceCompletionDigest: row.source_content_digest, sourceContextDigest: snapshot,
        targetExecutionAttempt: 2, candidate: { headSha: run.head_sha, baseSha: run.base_sha,
          policyDigest: run.effective_policy_digest, configDigest: run.effective_config_digest, contextDigest: snapshot } }
        : { requestId: row.request_id, findingId: row.finding_id, sourceContentDigest: row.source_content_digest,
          sourceReservationContextDigest: snapshot } });
    const events = rows.flatMap((row) => [event(row, false), event(row, true)]);
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM review_finding_rechecks request')) return { rows };
      if (sql.includes('FROM review_finding_recheck_admissions admission')) return { rows: [admission] };
      if (sql.includes('FROM review_pr_lifecycle_events')) return { rows: events };
      if (sql.includes('FROM review_pr_review_reservations reservation')) return { rows: [sourceReservation, targetReservation] };
      if (sql.includes('SELECT snapshot_digest, attempt')) return { rows: [{ snapshot_digest: snapshot, attempt: 2 }] };
      throw new Error(`Unexpected loader query: ${sql}`);
    });
    expect(await loadValidatedDisputedFindingRechecks({ query }, run, 2)).toEqual(rows.map(request));
    expect(base.run_id).toBe(run.run_id);
    expect(query).toHaveBeenCalledTimes(5);
  });
  it('rejects nine rows rather than silently dropping one', async () => {
    const { run } = fixture(); const query = vi.fn().mockResolvedValue({ rows: Array.from({ length: 9 }, () => fixture().row) });
    await expect(loadValidatedDisputedFindingRechecks({ query }, run, 2))
      .rejects.toThrow('Disputed finding re-review batch exceeds its response bound');
  });
  it.each(['completion_payload', 'gate_check_id'])('fails the whole loader for lost LEFT JOIN %s', async (key) => {
    const { row, run } = fixture(); row[key] = null;
    await expect(loadValidatedDisputedFindingRechecks({ query: vi.fn().mockResolvedValue({ rows: [fixture().row, row, fixture().row] }) }, run, 2)).rejects.toThrow();
  });
  it('propagates query failure without inventing an empty request set', async () => {
    const { run } = fixture(), error = new Error('controlled-query-failure');
    await expect(loadValidatedDisputedFindingRechecks({ query: vi.fn().mockRejectedValue(error) }, run, 2)).rejects.toBe(error);
  });
});


describe('checkpoint acknowledgement identity and task receipts', () => {
  function pair() {
    const { row } = fixture();
    const recheck = parseDisputedFindingRecheck(request(row));
    const { result, version: _version, ...identity } = row.completion_payload;
    const checkpoint: ReviewExecutionCheckpoint = {
      version: 'ReviewExecutionCheckpoint.v1', ...identity, revision: 4,
      plan: result.taskPlan, completedTasks: [{ id: recheck.taskId, findings: result.personas[0].findings }],
      satisfiedFindingRecheckIds: [recheck.requestId],
    };
    return { recheck, checkpoint };
  }
  it('invalidates the requested task while preserving unrelated completed findings', () => {
    const { recheck, checkpoint } = pair();
    const unrelated = { id: 'other-reviewer', findings: [] };
    const completed = [...checkpoint.completedTasks, unrelated];
    expect(remainingCheckpointTasksAfterRechecks(completed, [recheck], checkpoint.plan)).toEqual([unrelated]);
    expect(completed).toHaveLength(2);
    expect(remainingCheckpointTasksAfterRechecks(completed, [], checkpoint.plan)).toEqual(completed);
    expect(() => remainingCheckpointTasksAfterRechecks(completed, [recheck], []))
      .toThrow('Disputed finding re-review does not match a validated resumed task plan');
  });
  it('returns no pending work after a matching acknowledged task', () => {
    const { recheck, checkpoint } = pair();
    expect(pendingDisputedFindingRechecks([recheck], checkpoint, 2)).toEqual([]);
  });
  it.each(['runId', 'repositoryId', 'owner', 'repo', 'prNumber', 'headSha', 'baseSha', 'policyDigest', 'configDigest'])
    ('rejects a checkpoint with foreign %s', (key) => {
      const { recheck, checkpoint } = pair();
      const changed = checkpoint as unknown as Record<string, unknown>;
      const value = changed[key];
      changed[key] = typeof value === 'number' ? value + 1 : String(value).replace(/.$/, 'e');
      expect(() => pendingDisputedFindingRechecks([recheck], checkpoint, 2))
        .toThrow('Disputed finding request no longer matches the composed task plan');
    });
  it('rejects a source execution that is not older than the current attempt', () => {
    const { recheck, checkpoint } = pair();
    expect(() => pendingDisputedFindingRechecks([recheck], checkpoint, 1))
      .toThrow('Disputed finding request no longer matches the composed task plan');
  });
  it('rejects a checkpoint from a future attempt', () => {
    const { recheck, checkpoint } = pair(); checkpoint.executionAttempt = 3;
    expect(() => pendingDisputedFindingRechecks([recheck], checkpoint, 2))
      .toThrow('Checkpoint belongs to a future execution');
  });
  it('rejects an unknown acknowledgement ID', () => {
    const { recheck, checkpoint } = pair(); checkpoint.satisfiedFindingRecheckIds = ['unknown-receipt'];
    expect(() => pendingDisputedFindingRechecks([recheck], checkpoint, 2))
      .toThrow('Checkpoint contains an unknown disputed finding receipt');
  });
  it('rejects acknowledgement without the completed task', () => {
    const { recheck, checkpoint } = pair(); checkpoint.completedTasks = [];
    expect(() => pendingDisputedFindingRechecks([recheck], checkpoint, 2))
      .toThrow('Satisfied disputed finding receipt has no completed task');
  });
  it('rejects a checkpoint whose immutable task plan changed', () => {
    const { recheck, checkpoint } = pair(); checkpoint.plan = [{ ...checkpoint.plan[0], question: 'changed' }];
    expect(() => pendingDisputedFindingRechecks([recheck], checkpoint, 2))
      .toThrow('Disputed finding request no longer matches the composed task plan');
  });
});
