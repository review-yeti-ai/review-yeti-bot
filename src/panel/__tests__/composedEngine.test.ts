import { describe, it, expect, vi } from 'vitest';
import {
  COMPOSED_TASK_CONCURRENCY_CEILING,
  buildTaskScopedFiles,
  buildTaskScopedPrefix,
  executeComposedReview,
  orderReviewTasksByRisk,
  resolveComposedEngineMaxFindings,
  resolveComposedTaskConcurrency,
  unreportedLaneFailure,
} from '../composedEngine';
import { TASK_ID_PATTERN } from '../../reviewTaskContract';
import { isBypassDiffOnlyPath } from '../../pathDomainContract';
import { computeArbitration } from '../../review/reviewCore';
import { projectPublishingRosterBounds } from '../../cli/publishingReview';
import { parseAndValidateConfig } from '../../config/configLoader';
import type { OpenRouterResponse } from '../../gateway/openRouterClient';
import { OpenRouterConnectionError, OpenRouterResponseError } from '../../gateway/openRouterClient';
import { mcpFleetManager } from '../../mcp/mcpFleetManager';
import { createPublishingProgress } from '../../telemetry/publishingProgress';
import * as panelEngine from '../panelEngine';
import * as toolRuntime from '../toolRuntime';
import { executePersonaPanel, PanelConfigurationError } from '../panelEngine';
import { READ_FILE_TOOL_GUIDE } from '../pathMatch';
import { TokenLedger, meterModelClient } from '../../telemetry/tokenLedger';
import { initTelemetry, clearSpans, getRecentSpans } from '../../telemetry';
import { canonicalJson, sha256 } from '../../review/reviewCore';
import { disputedFindingRecheckDigest, type DisputedFindingRecheckUnsigned } from '../../review/disputedFindingRecheck';
import type { DeletionClassificationPlan } from '../../review/deletionClassification';

const mockYaml = `
version: 3
profile: balanced
quorum: 1
personas:
  - id: security
    charter: builtin:security
    providers: [codex]
    paths: ["**/*"]
    required: true
    enabled: true
reviewers:
  execution: personas
  fallback: none
  overall_timeout_s: 30
  providers:
    - id: codex
      enabled: true
      model: codex/gpt-5.6-sol-high
      effort: high
      review_timeout_s: 5
      arbiter_timeout_s: 5
  arbiter:
    order: [codex]
`;

function config() {
  return parseAndValidateConfig(mockYaml) as any;
}

function nonceFrom(text: string): string {
  const m = text.match(/CT_REVIEW_NONCE:([a-f0-9-]+)/);
  return m ? m[1] : 'nonce';
}

function lastText(messages: any[]): string {
  const last = messages[messages.length - 1];
  if (typeof last?.content === 'string') return last.content;
  if (Array.isArray(last?.content)) return last.content.map((b: any) => b.text || '').join('\n');
  return '';
}

function fakeResponse(content: string): OpenRouterResponse {
  return {
    model: 'test-model',
    content,
    usage: { prompt: 10, completion: 10, total: 20 },
    costUSD: 0.001,
    raw: {},
  };
}

const CODE_FILES = [
  { path: 'src/auth/guard.ts', patch: '@@ -1,1 +1,2 @@\n+export function guard() { return true; }' },
];

describe('executeComposedReview', () => {
  it.each(['COMPLETE', 'BLOCKED'] as const)(
    're-runs only the disputed task and records satisfaction only for %s output', async (status) => {
      const authTask = { id: 'auth-guard', dimension: 'security' as const,
        paths: ['src/auth/guard.ts'], question: 'Is the guard safe?', rationale: 'Changed authorization code.' };
      const testsTask = { id: 'tests', dimension: 'testing' as const,
        paths: ['src/auth/guard.ts'], question: 'Are the tests adequate?', rationale: 'The changed guard needs coverage.' };
      const plan = [authTask, testsTask];
      const priorAuthFinding = { severity: 'P1' as const, path: 'src/auth/guard.ts', line: 2,
        title: 'Prior disputed finding', body: 'This finding must be independently checked again.' };
      const priorTestsFinding = { severity: 'P2' as const, path: 'src/auth/guard.ts', line: 1,
        title: 'Unrelated checkpoint finding', body: 'This completed task remains valid checkpoint evidence.' };
      const unsigned: DisputedFindingRecheckUnsigned = {
        requestId: '00000000-0000-4000-8000-000000000126',
        runId: `run_${'1'.repeat(32)}`,
        sourceExecutionAttempt: 1,
        sourceContentDigest: 'd'.repeat(64),
        sourcePlanDigest: sha256(canonicalJson(plan)),
        sourceGateAttemptId: 'source-gate-attempt',
        repositoryId: 123,
        owner: 'acme',
        repo: 'reviewer-fixture',
        prNumber: 42,
        headSha: 'a'.repeat(40),
        baseSha: 'b'.repeat(40),
        policyDigest: 'c'.repeat(64),
        configDigest: 'd'.repeat(64),
        findingId: 'source-finding-id',
        personaId: authTask.id,
        taskId: authTask.id,
        finding: { severity: 'P1', path: priorAuthFinding.path, line: priorAuthFinding.line,
          title: priorAuthFinding.title, body: priorAuthFinding.body },
        counterArgument: 'The route enforces the authenticated organization before reading this tenant record.',
        counterArgumentDigest: sha256('The route enforces the authenticated organization before reading this tenant record.'),
      };
      const recheck = { ...unsigned, requestDigest: disputedFindingRecheckDigest(unsigned) };
      const saved: any[] = [];
      const complete = vi.fn(async (payload: any) => {
        const text = lastText(payload.messages);
        expect(text).not.toContain('PLAN TURN');
        expect(text).toContain('=== UNTRUSTED DISPUTED-FINDING EVIDENCE ===');
        expect(text).toContain(unsigned.counterArgument);
        expect(text).toContain(priorAuthFinding.title);
        const nonce = nonceFrom(text);
        return fakeResponse(JSON.stringify({ nonce, task: authTask.id, status, findings: [] }));
      });
      const result = await executeComposedReview({
        config: config(), changedFiles: CODE_FILES, repository: 'acme/reviewer-fixture',
        headSha: 'a'.repeat(40), client: { complete },
        disputedFindingRechecks: [recheck],
        checkpoint: {
          resumed: { version: 'ReviewExecutionCheckpoint.v1', runId: unsigned.runId, repositoryId: 123,
            owner: 'acme', repo: 'reviewer-fixture', prNumber: 42, headSha: unsigned.headSha,
            baseSha: unsigned.baseSha, policyDigest: unsigned.policyDigest, configDigest: unsigned.configDigest,
            executionAttempt: 2, revision: 5, plan,
            completedTasks: [
              { id: authTask.id, findings: [priorAuthFinding] },
              { id: testsTask.id, findings: [priorTestsFinding] },
            ] },
          save: async (snapshot) => { saved.push(structuredClone(snapshot)); },
        },
      });

      expect(complete).toHaveBeenCalledOnce();
      expect(lastText(complete.mock.calls[0]![0].messages)).toContain(`Task id: ${authTask.id}`);
      if (status === 'COMPLETE') {
        expect(result.personas.find((lane) => lane.id === authTask.id)?.findings).toEqual([]);
        expect(saved.at(-1)?.completedTasks).toHaveLength(2);
        // The service read returns no pending requests for acknowledged receipts.
        // Resume that actual response without paying for or recording the task twice.
        const resumeComplete = vi.fn(async () => { throw new Error('A satisfied task must not invoke the provider again'); });
        const latest = saved.at(-1)!;
        const resumed = await executeComposedReview({
          config: config(), changedFiles: CODE_FILES, repository: 'acme/reviewer-fixture', headSha: 'a'.repeat(40),
          client: { complete: resumeComplete }, disputedFindingRechecks: [],
          checkpoint: { resumed: {
            version: 'ReviewExecutionCheckpoint.v1', runId: unsigned.runId, repositoryId: 123,
            owner: 'acme', repo: 'reviewer-fixture', prNumber: 42, headSha: unsigned.headSha,
            baseSha: unsigned.baseSha, policyDigest: unsigned.policyDigest, configDigest: unsigned.configDigest,
            executionAttempt: 2, revision: latest.revision, plan,
            completedTasks: latest.completedTasks, satisfiedFindingRecheckIds: latest.satisfiedFindingRecheckIds,
          }, save: async () => undefined },
        });
        expect(resumeComplete).not.toHaveBeenCalled();
        expect(resumed.personas.find((lane) => lane.id === authTask.id)?.findings).toEqual([]);
        expect(resumed.personas.find((lane) => lane.id === testsTask.id)?.findings).toEqual([priorTestsFinding]);

        expect(result.personas.find((lane) => lane.id === testsTask.id)?.findings).toEqual([priorTestsFinding]);
        expect(saved.at(-1)).toMatchObject({
          satisfiedFindingRecheckIds: [unsigned.requestId],
          completedTasks: expect.arrayContaining([
            { id: testsTask.id, findings: [priorTestsFinding] },
            { id: authTask.id, findings: [] },
          ]),
        });
      } else {
        expect(result.optionalFailures?.some((lane) => lane.id === authTask.id)).toBe(true);
        expect(saved.some((snapshot) => snapshot.satisfiedFindingRecheckIds?.includes(unsigned.requestId))).toBe(false);
        expect(saved.at(-1)?.completedTasks).toEqual([{ id: testsTask.id, findings: [priorTestsFinding] }]);
      }
    },
  );

  it('waits for an acknowledged satisfied-recheck checkpoint before returning a clean result', async () => {
    const task = { id: 'auth', dimension: 'security' as const, paths: ['src/auth/guard.ts'],
      question: 'Is the authorization guard safe?', rationale: 'It protects the changed tenant boundary.' };
    const plan = [task];
    const priorFinding = { severity: 'P1' as const, path: 'src/auth/guard.ts', line: 2,
      title: 'Prior finding', body: 'The original completion found an authorization gap.' };
    const argument = 'The handler now binds the tenant before reading this record.';
    const unsigned: DisputedFindingRecheckUnsigned = {
      requestId: '00000000-0000-4000-8000-000000000127', runId: `run_${'2'.repeat(32)}`,
      sourceExecutionAttempt: 1, sourceContentDigest: 'd'.repeat(64), sourcePlanDigest: sha256(canonicalJson(plan)),
      sourceGateAttemptId: 'historical-g1-e2', repositoryId: 123, owner: 'acme', repo: 'reviewer-fixture',
      prNumber: 42, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), policyDigest: 'c'.repeat(64),
      configDigest: 'd'.repeat(64), findingId: 'source-finding', personaId: task.id, taskId: task.id,
      finding: { severity: 'P1', path: priorFinding.path, line: priorFinding.line,
        title: priorFinding.title, body: priorFinding.body },
      counterArgument: argument, counterArgumentDigest: sha256(argument),
    };
    const recheck = { ...unsigned, requestDigest: disputedFindingRecheckDigest(unsigned) };
    let releaseReceipt!: () => void;
    const receiptWrite = new Promise<void>((resolve) => { releaseReceipt = resolve; });
    let receiptWriteStarted!: () => void;
    const started = new Promise<void>((resolve) => { receiptWriteStarted = resolve; });
    const save = vi.fn(async (snapshot: any) => {
      if (snapshot.satisfiedFindingRecheckIds?.includes(unsigned.requestId)) {
        receiptWriteStarted();
        await receiptWrite;
      }
    });
    const complete = vi.fn(async (payload: any) => {
      const text = lastText(payload.messages);
      return fakeResponse(JSON.stringify({ nonce: nonceFrom(text), task: task.id, status: 'COMPLETE', findings: [] }));
    });
    let returned = false;
    const review = executeComposedReview({ config: config(), changedFiles: CODE_FILES,
      repository: 'acme/reviewer-fixture', headSha: unsigned.headSha, client: { complete },
      disputedFindingRechecks: [recheck], checkpoint: {
        resumed: { version: 'ReviewExecutionCheckpoint.v1', runId: unsigned.runId, repositoryId: 123,
          owner: unsigned.owner, repo: unsigned.repo, prNumber: unsigned.prNumber, headSha: unsigned.headSha,
          baseSha: unsigned.baseSha, policyDigest: unsigned.policyDigest, configDigest: unsigned.configDigest,
          executionAttempt: 2, revision: 4, plan, completedTasks: [{ id: task.id, findings: [priorFinding] }] },
        save,
      },
    }).then((result) => { returned = true; return result; });

    await started;
    expect(complete).toHaveBeenCalledOnce();
    expect(returned).toBe(false);
    releaseReceipt();
    const result = await review;
    expect(returned).toBe(true);
    expect(result.personas).toMatchObject([{ id: task.id, decision: 'APPROVE', findings: [] }]);
    expect(save.mock.calls.at(-1)?.[0]).toMatchObject({ satisfiedFindingRecheckIds: [unsigned.requestId],
      completedTasks: [{ id: task.id, findings: [] }] });
  });

  it('does not return a clean result when the satisfied-recheck checkpoint write is rejected', async () => {
    const task = { id: 'auth', dimension: 'security' as const, paths: ['src/auth/guard.ts'],
      question: 'Is the authorization guard safe?', rationale: 'It protects the changed tenant boundary.' };
    const plan = [task];
    const argument = 'The handler binds the authenticated tenant before reading this record.';
    const unsigned: DisputedFindingRecheckUnsigned = {
      requestId: '00000000-0000-4000-8000-000000000128', runId: `run_${'3'.repeat(32)}`,
      sourceExecutionAttempt: 1, sourceContentDigest: 'd'.repeat(64), sourcePlanDigest: sha256(canonicalJson(plan)),
      sourceGateAttemptId: 'historical-g1-e2', repositoryId: 123, owner: 'acme', repo: 'reviewer-fixture',
      prNumber: 42, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), policyDigest: 'c'.repeat(64),
      configDigest: 'd'.repeat(64), findingId: 'source-finding', personaId: task.id, taskId: task.id,
      finding: { severity: 'P1', path: task.paths[0]!, line: 2, title: 'Prior finding', body: 'Original finding.' },
      counterArgument: argument, counterArgumentDigest: sha256(argument),
    };
    const recheck = { ...unsigned, requestDigest: disputedFindingRecheckDigest(unsigned) };
    const save = vi.fn(async (snapshot: any) => {
      if (snapshot.satisfiedFindingRecheckIds?.includes(unsigned.requestId)) throw new Error('checkpoint unavailable');
    });
    const complete = vi.fn(async (payload: any) => {
      const text = lastText(payload.messages);
      return fakeResponse(JSON.stringify({ nonce: nonceFrom(text), task: task.id, status: 'COMPLETE', findings: [] }));
    });
    await expect(executeComposedReview({ config: config(), changedFiles: CODE_FILES,
      repository: 'acme/reviewer-fixture', headSha: unsigned.headSha, client: { complete },
      disputedFindingRechecks: [recheck], checkpoint: {
        resumed: { version: 'ReviewExecutionCheckpoint.v1', runId: unsigned.runId, repositoryId: 123,
          owner: unsigned.owner, repo: unsigned.repo, prNumber: unsigned.prNumber, headSha: unsigned.headSha,
          baseSha: unsigned.baseSha, policyDigest: unsigned.policyDigest, configDigest: unsigned.configDigest,
          executionAttempt: 2, revision: 4, plan, completedTasks: [] },
        save,
      },
    })).rejects.toThrow('Disputed finding re-review receipt was not durably checkpointed');
    expect(complete).toHaveBeenCalledOnce();
  });

  it('fails closed instead of returning a zero-lane result while a disputed task is pending', async () => {
    const client = { complete: vi.fn() };
    await expect(executeComposedReview({
      config: parseAndValidateConfig(mockYaml.replace('paths: ["**/*"]', 'paths: ["src/**"]')) as any,
      changedFiles: [{ path: 'docs/overview.md', patch: '@@ -1 +1 @@\n+Documentation only.' }],
      repository: 'acme/reviewer-fixture',
      headSha: 'a'.repeat(40),
      client,
      disputedFindingRechecks: [{ requestId: '00000000-0000-4000-8000-000000000126' } as any],
    })).rejects.toThrow('cannot be skipped as a zero-lane review');
    expect(client.complete).not.toHaveBeenCalled();
  });

  it.each([[true, 'complete', 1, 0], [false, 'complete', 1, 0], [true, 'unavailable', 0, 1],
    [true, 'partial', 0, 1], [true, 'partial', 1, 1], [false, 'partial', 1, 1]] as const)
  ('gives real panel personas usable current classification (current=%s, status=%s, classified=%s)', async (current, status, classifiedFiles, unresolvedFiles) => {
    const repository = 'acme/reviewer-fixture', headSha = 'a'.repeat(40);
    const plan: DeletionClassificationPlan = { version: 'deletion-classification.v1', repository,
      headSha: current ? headSha : 'c'.repeat(40), digest: 'b'.repeat(64), status,
      totalFiles: classifiedFiles + unresolvedFiles, classifiedFiles, unresolvedFiles, groups: [{ id: 'guard', label: 'Guard retirement',
        proof: 'individual_path', risk: 'high', paths: ['src/auth/guard.ts'], categories: ['source'], obligationCount: 5 },
        ...(classifiedFiles > 0 && unresolvedFiles > 0 ? [{ id: 'tail', label: 'Unresolved tail', proof: 'individual_path' as const,
          risk: 'unknown' as const, paths: ['src/old-tail.ts'], categories: ['unknown' as const], obligationCount: 5 }] : [])] };
    const roles: string[] = [];
    const client = { complete: vi.fn(async (payload: any) => {
      const role = payload.metadata?.role, nonce = issuedNonce(payload.messages);
      roles.push(role);
      expect(JSON.stringify(payload.messages).includes('DELETION CLASSIFICATION AND REVIEW GROUPS')).toBe(current && classifiedFiles > 0 && role === 'persona');
      expect(JSON.stringify(payload.messages).includes('Guard retirement')).toBe(current && classifiedFiles > 0 && role === 'persona');
      return fakeResponse(JSON.stringify(role === 'persona' ? { nonce, decision: 'APPROVE', findings: [] }
        : role === 'moderator' ? { nonce, decision: 'RECONCILED', findings: [] }
        : { nonce, verdict: 'SHIP', rationale: 'Clean fixture.' }));
    }) };
    const result = await executePersonaPanel({ config: config(), changedFiles: CODE_FILES, repository, headSha, client,
      repoFileProvider: { findFiles: async () => [], readFile: async () => null, deletionPlan: () => plan },
      requestPolicy: { responseFormat: { type: 'json_object' } } });
    expect(roles).toContain('persona');
    expect(result.personas).toMatchObject([{ decision: 'APPROVE' }]);
  });

  it('raises classified contract risk without lowering security floors or losing tasks', () => {
    const tasks = [
      { id: 'source', dimension: 'performance' as const, paths: ['src/a.ts'], question: 'Fast?', rationale: 'Changed.' },
      { id: 'deleted-contract', dimension: 'contract' as const, paths: ['docs/contract.md'], question: 'Contract?', rationale: 'Removed.' },
      { id: 'auth', dimension: 'security' as const, paths: ['src/auth/token.ts'], question: 'Secure?', rationale: 'Auth.' },
    ];
    const plan: DeletionClassificationPlan = { version: 'deletion-classification.v1', repository: 'acme/reviewer-fixture',
      headSha: 'a'.repeat(40), digest: 'b'.repeat(64), status: 'complete', totalFiles: 2, classifiedFiles: 2, unresolvedFiles: 0,
      groups: [{ id: 'contract', label: 'Public contract', proof: 'individual_path', risk: 'high', paths: ['docs/contract.md'], categories: ['docs'], obligationCount: 5 },
        { id: 'auth', label: 'Auth', proof: 'individual_path', risk: 'low', paths: ['src/auth/token.ts'], categories: ['source'], obligationCount: 5 }] };
    expect(orderReviewTasksByRisk(tasks).map((task) => task.id)).toEqual(['auth', 'source', 'deleted-contract']);
    expect(orderReviewTasksByRisk(tasks, plan).map((task) => task.id)).toEqual(['auth', 'deleted-contract', 'source']);
    expect(orderReviewTasksByRisk(tasks, plan)).toHaveLength(tasks.length);
    const partial = { ...plan, status: 'partial' as const, classifiedFiles: 1, unresolvedFiles: 1,
      groups: [plan.groups[0], { ...plan.groups[1], risk: 'unknown' as const }] };
    expect(orderReviewTasksByRisk(tasks, partial).map((task) => task.id)).toEqual(['auth', 'deleted-contract', 'source']);
    expect(orderReviewTasksByRisk(tasks, partial)).toHaveLength(tasks.length);
    expect(orderReviewTasksByRisk(tasks, { ...plan, status: 'disabled' })).toEqual(orderReviewTasksByRisk(tasks));
    expect(orderReviewTasksByRisk(tasks, { ...plan, status: 'unavailable', classifiedFiles: 0, unresolvedFiles: 2 }))
      .toEqual(orderReviewTasksByRisk(tasks));
    expect(orderReviewTasksByRisk(tasks, { ...plan, status: 'partial', classifiedFiles: 0, unresolvedFiles: 2 }))
      .toEqual(orderReviewTasksByRisk(tasks));
  });

  it.each([[true, 'complete', 1, 0], [false, 'complete', 1, 0], [true, 'unavailable', 0, 1],
    [true, 'partial', 0, 1], [true, 'partial', 1, 1], [false, 'partial', 1, 1]] as const)
  ('uses usable classification in real planner and worker prompts (current=%s, status=%s, classified=%s)', async (current, status, classifiedFiles, unresolvedFiles) => {
    const repository = 'acme/reviewer-fixture', headSha = 'a'.repeat(40);
    const plan: DeletionClassificationPlan = { version: 'deletion-classification.v1', repository,
      headSha: current ? headSha : 'c'.repeat(40), digest: 'b'.repeat(64), status,
      totalFiles: classifiedFiles + unresolvedFiles, classifiedFiles, unresolvedFiles, groups: [{ id: 'guard', label: 'Guard retirement',
        proof: 'individual_path', risk: 'high', paths: ['src/auth/guard.ts'], categories: ['source'], obligationCount: 5 },
        ...(classifiedFiles > 0 && unresolvedFiles > 0 ? [{ id: 'tail', label: 'Unresolved tail', proof: 'individual_path' as const,
          risk: 'unknown' as const, paths: ['src/old-tail.ts'], categories: ['unknown' as const], obligationCount: 5 }] : [])] };
    const complete = vi.fn(async (payload: any) => {
      const text = lastText(payload.messages), nonce = nonceFrom(text);
      const prompt = JSON.stringify(payload.messages);
      expect(prompt.includes('DELETION CLASSIFICATION AND REVIEW GROUPS')).toBe(current && classifiedFiles > 0);
      expect(prompt.includes('Guard retirement')).toBe(current && classifiedFiles > 0);
      if (text.includes('PLAN TURN')) return fakeResponse(JSON.stringify({ nonce, tasks: [{ id: 'guard', dimension: 'security',
        paths: ['src/auth/guard.ts'], question: 'Safe?', rationale: 'Changed guard.' }] }));
      return fakeResponse(JSON.stringify({ nonce, task: 'guard', status: 'COMPLETE', findings: [] }));
    });
    const result = await executeComposedReview({ config: config(), changedFiles: CODE_FILES, repository, headSha,
      client: { complete }, repoFileProvider: { findFiles: async () => [], readFile: async () => null, deletionPlan: () => plan } });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(result.personas).toMatchObject([{ id: 'guard', decision: 'APPROVE' }]);
  });

  it('orders security and CI/IaC review work before lower-risk tasks deterministically', () => {
    const ordered = orderReviewTasksByRisk([
      { id: 'tests', dimension: 'testing', paths: ['tests/a.test.ts'], question: 'Tests?', rationale: 'Changed.' },
      { id: 'source', dimension: 'performance', paths: ['src/a.ts'], question: 'Fast?', rationale: 'Changed.' },
      { id: 'ci-contract', dimension: 'contract', paths: ['.github/workflows/review.yml'], question: 'Safe?', rationale: 'CI.' },
      { id: 'auth', dimension: 'security', paths: ['src/auth/token.ts'], question: 'Secure?', rationale: 'Auth.' },
    ]);
    expect(ordered.map((task) => task.id)).toEqual(['auth', 'ci-contract', 'source', 'tests']);
  });

  it('caps composed task concurrency at three, honors lower operator limits, and keeps publisher shadow serial', () => {
    expect(resolveComposedTaskConcurrency({ REVIEW_YETI_MAX_CONCURRENT_LANES: '8' })).toBe(3);
    expect(resolveComposedTaskConcurrency({ REVIEW_YETI_MAX_CONCURRENT_LANES: '2' })).toBe(2);
    expect(resolveComposedTaskConcurrency({ REVIEW_YETI_MAX_CONCURRENT_LANES: '1' })).toBe(1);
    expect(resolveComposedTaskConcurrency({ REVIEW_YETI_MAX_CONCURRENT_LANES: '16' }, true)).toBe(1);
  });

  it.each(['plan', 'work'] as const)('cancels the active %s provider request when the review aborts', async (phase) => {
    const controller = new AbortController();
    let transportCancelled = false;
    let started!: () => void;
    const requestStarted = new Promise<void>((resolve) => { started = resolve; });
    const complete = vi.fn(async (request: any) => {
      const planning = lastText(request.messages).includes('PLAN TURN');
      if (phase === 'work' && planning) {
        return fakeResponse(JSON.stringify({
          nonce: issuedNonce(request.messages),
          tasks: [{ id: 'auth-guard', dimension: 'security', paths: ['src/auth/guard.ts'],
            question: 'Is the guard safe?', rationale: 'Changed authentication guard.' }],
        }));
      }
      started();
      return new Promise<OpenRouterResponse>((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => {
          transportCancelled = true;
          reject(new Error('provider request cancelled'));
        }, { once: true });
      });
    });
    const review = executeComposedReview({ config: config(), changedFiles: CODE_FILES,
      repository: 'acme/reviewer-fixture', headSha: 'a'.repeat(40), client: { complete },
      signal: controller.signal });
    const rejected = expect(review).rejects.toThrow();
    await requestStarted;
    controller.abort();
    await rejected;
    expect(transportCancelled).toBe(true);
    expect(complete).toHaveBeenCalledTimes(phase === 'plan' ? 1 : 2);
  });

  const exhaustionContext = {
    turnsUsed: 2, correctionAttempts: 1, toolTurns: 0,
    finishReason: 'stop', lastToolOutcome: 'none',
  } as const;
  const exhaustionTask = { id: 'task-sec', dimension: 'security', paths: ['src/auth/guard.ts'], question: 'Guard?', rationale: 'Guard.' } as const;

  it.each(['total_turn_budget_exhausted', 'task_turn_budget_exhausted'] as const)(
    'classifies and formats defensive %s diagnostics', (reason) => {
      // Classification/formatting only: this does not establish public mid-task budget reachability.
      const failure = unreportedLaneFailure({ ...exhaustionTask, paths: [...exhaustionTask.paths] }, 'exhausted', {
        ...exhaustionContext, reason,
      });
      expect(failure).toMatchObject({ failureClass: 'budget_exhausted', diagnostics: { reason } });
      expect(failure.error).toContain(`[reason=${reason};`);
      expect(failure.error).not.toContain('result_fields');
      expect(failure.error).not.toContain('contract rejected');
    });

  it('reports the terminal canonical reason after distinct rejection causes, without earlier or raw tokens', async () => {
    let workCalls = 0;
    const complete = vi.fn(async (payload: any) => {
      const nonce = issuedNonce(payload.messages);
      if (lastText(payload.messages).includes('PLAN TURN')) {
        return fakeResponse(JSON.stringify({ nonce, tasks: [exhaustionTask] }));
      }
      workCalls += 1;
      return fakeResponse(JSON.stringify({
        nonce: workCalls === 1 ? 'RAW_NONCE_SHOULD_NOT_LEAK' : nonce,
        task: workCalls === 2 ? 'RAW_TASK_SHOULD_NOT_LEAK' : 'task-sec',
        status: workCalls === 3 ? 'RAW_STATUS_SHOULD_NOT_LEAK' : 'COMPLETE',
        findings: [],
      }));
    });
    const result = await executeComposedReview({ config: config(), changedFiles: CODE_FILES,
      repository: 'acme/reviewer-fixture', headSha: 'a'.repeat(40), client: { complete } });
    expect(workCalls).toBe(3);
    expect(result.personas).toEqual([]);
    expect(result.optionalFailures).toEqual([]);
    expect(result.unreportedLanes).toHaveLength(1);
    expect(result.unreportedLanes?.[0]).toMatchObject({ id: 'task-sec', failureClass: 'malformed_output',
      diagnostics: { reason: 'invalid_status', turnsUsed: 3, correctionAttempts: 2, toolTurns: 0 } });
    const error = result.unreportedLanes?.[0].error;
    expect(error).toContain('[reason=invalid_status;');
    for (const token of ['nonce_mismatch', 'task_id_mismatch', 'status_enum', 'RAW_NONCE_SHOULD_NOT_LEAK',
      'RAW_TASK_SHOULD_NOT_LEAK', 'RAW_STATUS_SHOULD_NOT_LEAK', 'contract rejected']) {
      expect(error).not.toContain(token);
    }
    expect(projectPublishingRosterBounds(result).returnedIds).toEqual([]);
  });

  const toolWire = JSON.stringify({ tool: 'get_diff', args: { path: 'src/auth/guard.ts', nested: { lines: [1, 2] } } });
  const toolFence = `\`\`\`json\n${toolWire}\n\`\`\``;
  it.each([
    ['bare JSON', toolWire, true],
    ['JSON fence', toolFence, true],
    ['uppercase CRLF fence', ` \n\`\`\`JSON\t\r\n${toolWire}\r\n\`\`\`\n `, true],
    ['unlabelled fence', `\`\`\`\n${toolWire}\n\`\`\``, true],
    ['leading prose', `tool request:\n${toolFence}`, false],
    ['trailing prose', `${toolFence}\nfinished`, false],
    ['two fences', `${toolFence}\n${toolFence}`, false],
    ['wrong fence language', `\`\`\`javascript\n${toolWire}\n\`\`\``, false],
    ['two objects', `${toolWire}\n${toolWire}`, false],
    ['missing args', JSON.stringify({ tool: 'get_diff' }), false],
    ['array args', JSON.stringify({ tool: 'get_diff', args: [] }), false],
    ['null args', JSON.stringify({ tool: 'get_diff', args: null }), false],
    ['scalar args', JSON.stringify({ tool: 'get_diff', args: 'src/auth/guard.ts' }), false],
    ['extra envelope field', JSON.stringify({ tool: 'get_diff', args: {}, nonce: 'untrusted' }), false],
    ['blank tool', JSON.stringify({ tool: ' \t', args: {} }), false],
    ['nonstring tool', JSON.stringify({ tool: 3, args: {} }), false],
    ['null response', 'null', false],
    ['array response', `[${toolWire}]`, false],
    ['scalar response', '42', false],
  ] as const)('keeps both engines on the shared native wire contract for %s', async (_shape, content, admitted) => {
    const runTool = vi.spyOn(toolRuntime, 'runReadOnlyTool');
    let workTurns = 0;
    const composedClient = { complete: vi.fn(async (payload: any) => {
      const nonce = issuedNonce(payload.messages);
      if (lastText(payload.messages).includes('PLAN TURN')) return fakeResponse(JSON.stringify({ nonce, tasks: [exhaustionTask] }));
      workTurns += 1;
      return fakeResponse(workTurns === 1 || !admitted ? content
        : JSON.stringify({ nonce, task: 'task-sec', status: 'COMPLETE', findings: [] }));
    }) };
    let personaTurns = 0;
    const panelClient = { complete: vi.fn(async (payload: any) => {
      const nonce = issuedNonce(payload.messages);
      if (payload.metadata?.role === 'persona') {
        personaTurns += 1;
        return fakeResponse(personaTurns === 1 || !admitted ? content
          : JSON.stringify({ nonce, decision: 'APPROVE', findings: [] }));
      }
      return fakeResponse(JSON.stringify(payload.metadata?.role === 'moderator'
        ? { nonce, decision: 'RECONCILED', findings: [] } : { nonce, verdict: 'SHIP', rationale: 'Synthetic fixture.' }));
    }) };
    try {
      const composed = await executeComposedReview({ config: config(), changedFiles: CODE_FILES,
        repository: 'acme/reviewer-fixture', headSha: 'a'.repeat(40), client: composedClient });
      expect(composed.personas).toHaveLength(admitted ? 1 : 0);
      expect(runTool).toHaveBeenCalledTimes(admitted ? 1 : 0);
      runTool.mockClear();
      const panelRun = executePersonaPanel({ config: config(), changedFiles: CODE_FILES,
        repository: 'acme/reviewer-fixture', headSha: 'a'.repeat(40), client: panelClient,
        requestPolicy: { responseFormat: { type: 'json_object' } } });
      if (admitted) {
        const panel = await panelRun;
        expect(panel.personas).toMatchObject([{ decision: 'APPROVE' }]);
      } else {
        await expect(panelRun).rejects.toBeInstanceOf(PanelConfigurationError);
      }
      expect(runTool).toHaveBeenCalledTimes(admitted ? 1 : 0);
    } finally {
      runTool.mockRestore();
    }
  });

  // Regression guards for the 2026-09-21 plan-rejection outage. Both of these
  // failures were unrecoverable: `malformed_ids` burns the single corrective
  // turn, and `security_floor_violation` has no corrective turn at all, so a
  // plan directive that induces either one fails every review it touches.
  it('names security-sensitive paths in the plan directive and never quotes a non-conforming id', async () => {
    let planDirective = '';
    const complete = vi.fn(async (payload: any) => {
      const text = lastText(payload.messages);
      const nonce = nonceFrom(text);
      if (text.includes('PLAN TURN')) {
        planDirective = text;
        return fakeResponse(JSON.stringify({
          nonce,
          tasks: [
            { id: 'security-auth', dimension: 'security', paths: ['src/auth/guard.ts'], question: 'Is auth bypassable?', rationale: 'auth surface' },
          ],
        }));
      }
      return fakeResponse(JSON.stringify({ nonce, task: 'security-auth', status: 'COMPLETE', findings: [] }));
    });

    await executeComposedReview({
      config: config(),
      changedFiles: CODE_FILES,
      repository: 'exampleorg/example-meta',
      headSha: 'b'.repeat(40),
      client: { complete },
    });

    // The engine classifies security-sensitive paths deterministically, so the
    // model must be told which ones they are rather than left to infer it --
    // guessing wrong is rejected outright with no retry.
    expect(planDirective).toContain('SECURITY FLOOR');
    expect(planDirective).toContain('src/auth/guard.ts');

    // Positive id examples only. Quoting the rejected form primed models to
    // emit exactly it (observed: `T1`..`T7` -> malformed_ids).
    expect(planDirective).not.toContain('"T1"');
    expect(planDirective).toContain(TASK_ID_PATTERN.source);
  });

  it('states that no security task is required when no changed path is security-sensitive', async () => {
    let planDirective = '';
    const complete = vi.fn(async (payload: any) => {
      const text = lastText(payload.messages);
      const nonce = nonceFrom(text);
      if (text.includes('PLAN TURN')) {
        planDirective = text;
        return fakeResponse(JSON.stringify({
          nonce,
          tasks: [
            { id: 'perf-hot-path', dimension: 'performance', paths: ['src/util/sum.ts'], question: 'Hot loop?', rationale: 'arithmetic' },
          ],
        }));
      }
      return fakeResponse(JSON.stringify({ nonce, task: 'perf-hot-path', status: 'COMPLETE', findings: [] }));
    });

    await executeComposedReview({
      config: config(),
      changedFiles: [{ path: 'src/util/sum.ts', patch: '@@ -1 +1,2 @@\n+export const sum = (a: number, b: number) => a + b;' }],
      repository: 'exampleorg/example-meta',
      headSha: 'c'.repeat(40),
      client: { complete },
    });

    // Silence here would leave the model to invent a security task or wonder
    // whether the floor applies; say so explicitly.
    expect(planDirective).toContain('No changed path is classified security-sensitive');
    expect(planDirective).not.toContain('SECURITY FLOOR --');
  });

  it('approves a diff with nothing analyzable, before any provider call, exactly like the fan-out engine', async () => {
    const complete = vi.fn();
    // REL-1058: the exemption is the shared applicability decision's, so -- as
    // on the fan-out engine and the service -- it applies only when no enabled
    // persona covers the documentation. A catch-all persona reviews it instead.
    const narrow = parseAndValidateConfig(mockYaml.replace('paths: ["**/*"]', 'paths: ["src/**"]')) as any;
    const result = await executeComposedReview({
      config: narrow,
      changedFiles: [{ path: 'docs/readme.md', patch: '@@ -1 +1 @@\n-old\n+new' }],
      repository: 'exampleorg/example-meta',
      headSha: 'a'.repeat(40),
      client: { complete },
    });
    // Nothing to analyze is an approval, not missing evidence. A zero-lane
    // result is refused by publishing, which made documentation-only pull
    // requests unmergeable on this path too -- the fan-out engine was fixed
    // first and this one silently kept the old shape.
    expect(result.zeroLaneNonEvidence).toBeUndefined();
    expect((result as any).documentationOnly).toBe(true);
    expect(result.arbiter.verdict).toBe('SHIP');
    expect(result.quorum.satisfied).toBe(true);
    expect(result.personas).toHaveLength(1);
    expect(result.personas[0].decision).toBe('APPROVE');
    expect(complete).not.toHaveBeenCalled();
  });

  it('plans once, executes each task with an engine-owned cursor, and produces one lane per COMPLETE task', async () => {
    const events: Array<Record<string, unknown>> = [];
    const progress = createPublishingProgress({ runId: 'run-composed-success', executionAttempt: 1 }, { sink: (event) => events.push(event) });
    const complete = vi.fn(async (payload: any) => {
      const text = lastText(payload.messages);
      const nonce = nonceFrom(text);
      if (text.includes('PLAN TURN')) {
        return fakeResponse(JSON.stringify({
          nonce,
          tasks: [
            { id: 'task-sec', dimension: 'security', paths: ['src/auth/guard.ts'], question: 'Is auth bypassable?', rationale: 'auth-sensitive file' },
          ],
        }));
      }
      if (text.includes('WORK TURN')) {
        return fakeResponse(JSON.stringify({ nonce, task: 'task-sec', status: 'COMPLETE', findings: [] }));
      }
      throw new Error(`unexpected turn: ${text.slice(0, 80)}`);
    });

    const result = await executeComposedReview({
      config: config(),
      changedFiles: CODE_FILES,
      repository: 'exampleorg/example-meta',
      headSha: 'a'.repeat(40),
      client: progress.instrument({ complete }),
      progress,
    });

    expect(result.zeroLaneNonEvidence).toBe(false);
    expect(result.applicablePersonaIds).toEqual(['task-sec']);
    expect(result.personas).toHaveLength(1);
    expect(result.personas[0]).toMatchObject({ id: 'task-sec', decision: 'APPROVE', findings: [] });
    expect(result.optionalFailures).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({ task: 'composed_plan', status: 'completed', role: 'composed_plan', lane: 'composed-plan' }));
    expect(events).toContainEqual(expect.objectContaining({ task: 'composed_task', status: 'completed', role: 'composed_task', lane: 'composed-task-1', model: 'codex/gpt-5.6-sol-high' }));
    expect(events.filter((event) => event.task === 'provider_call' && event.status === 'started')).toMatchObject([
      { role: 'composed_plan', lane: 'composed-plan', turn: 1 },
      { role: 'composed_task', lane: 'composed-task-1', turn: 1 },
    ]);
  });

  it('returns completed evidence at the evidence cutoff and resumes only pending exact-head tasks', async () => {
    vi.useFakeTimers();
    const saved: any[] = [];
    let pendingStarted!: () => void;
    const pendingCall = new Promise<void>((resolve) => { pendingStarted = resolve; });
    const firstComplete = vi.fn(async (payload: any) => {
      const text = lastText(payload.messages);
      const nonce = nonceFrom(text);
      if (text.includes('PLAN TURN')) return fakeResponse(JSON.stringify({ nonce, tasks: [
        { id: 'auth', dimension: 'security', paths: ['src/auth/guard.ts'], question: 'Auth?', rationale: 'Risk first.' },
        { id: 'tests', dimension: 'testing', paths: ['src/auth/guard.ts'], question: 'Tests?', rationale: 'Coverage.' },
      ] }));
      if (text.includes('Task id: auth')) return fakeResponse(JSON.stringify({ nonce, task: 'auth', status: 'COMPLETE', findings: [] }));
      pendingStarted();
      return new Promise<OpenRouterResponse>(() => undefined);
    });
    const startedAt = Date.now();
    const run = executeComposedReview({
      config: config(), changedFiles: CODE_FILES, repository: 'acme/reviewer-fixture', headSha: 'a'.repeat(40),
      client: { complete: firstComplete }, deadlineBudget: { deadlineAtMs: startedAt + 100,
        timeoutMs: 100, terminalBound: true }, deadlineNow: () => Date.now(),
      checkpoint: { resumed: null, save: async (snapshot) => { saved.push(structuredClone(snapshot)); } },
    });
    await pendingCall;
    await vi.advanceTimersByTimeAsync(101);
    const partial = await run;
    expect(partial.gracefulExit).toMatchObject({ reason: 'evidence_deadline', completedTaskIds: ['auth'], pendingTaskIds: ['tests'] });
    expect(partial.personas.map((lane) => lane.id)).toEqual(['auth']);
    expect(partial.unreportedLanes).toEqual([expect.objectContaining({ id: 'tests', failureClass: 'timeout' })]);
    expect(saved.at(-1)).toMatchObject({ revision: 2, completedTasks: [{ id: 'auth', findings: [] }] });

    const resumeCalls = vi.fn(async (payload: any) => {
      const text = lastText(payload.messages);
      expect(text).not.toContain('PLAN TURN');
      const nonce = nonceFrom(text);
      return fakeResponse(JSON.stringify({ nonce, task: 'tests', status: 'COMPLETE', findings: [] }));
    });
    const resumed = await executeComposedReview({
      config: config(), changedFiles: CODE_FILES, repository: 'acme/reviewer-fixture', headSha: 'a'.repeat(40),
      client: { complete: resumeCalls }, checkpoint: {
        resumed: { version: 'ReviewExecutionCheckpoint.v1', runId: `run_${'1'.repeat(32)}`, repositoryId: 1,
          owner: 'acme', repo: 'reviewer-fixture', prNumber: 1, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40),
          policyDigest: 'c'.repeat(64), configDigest: 'd'.repeat(64), executionAttempt: 2,
          ...saved.at(-1) },
        save: async (snapshot) => { saved.push(structuredClone(snapshot)); },
      },
    });
    expect(resumeCalls).toHaveBeenCalledTimes(1);
    expect(resumed.gracefulExit).toBeUndefined();
    expect(resumed.personas.map((lane) => lane.id)).toEqual(['auth', 'tests']);
    vi.useRealTimers();
  });

  it('does not spend the evidence budget waiting for durable checkpoint I/O', async () => {
    vi.useFakeTimers();
    const captured: number[] = [];
    const persisted: number[] = [];
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    let pendingStarted!: () => void;
    const pendingCall = new Promise<void>((resolve) => { pendingStarted = resolve; });
    const complete = vi.fn(async (payload: any) => {
      const text = lastText(payload.messages);
      const nonce = nonceFrom(text);
      if (text.includes('PLAN TURN')) return fakeResponse(JSON.stringify({ nonce, tasks: [
        { id: 'auth', dimension: 'security', paths: ['src/auth/guard.ts'], question: 'Auth?', rationale: 'Risk first.' },
        { id: 'tests', dimension: 'testing', paths: ['src/auth/guard.ts'], question: 'Tests?', rationale: 'Coverage.' },
      ] }));
      if (text.includes('Task id: auth')) return fakeResponse(JSON.stringify({ nonce, task: 'auth', status: 'COMPLETE', findings: [] }));
      pendingStarted();
      return new Promise<OpenRouterResponse>(() => undefined);
    });
    const startedAt = Date.now();
    const run = executeComposedReview({
      config: config(), changedFiles: CODE_FILES, repository: 'acme/reviewer-fixture', headSha: 'a'.repeat(40),
      client: { complete }, deadlineBudget: { deadlineAtMs: startedAt + 100, timeoutMs: 100, terminalBound: true },
      deadlineNow: () => Date.now(), checkpoint: {
        resumed: null,
        capture: (snapshot) => { captured.push(snapshot.revision); },
        save: async (snapshot) => { persisted.push(snapshot.revision); await writeGate; },
      },
    });

    await pendingCall;
    expect(persisted).toEqual([1]);
    await vi.advanceTimersByTimeAsync(101);
    const partial = await run;
    expect(partial.gracefulExit).toMatchObject({
      completedTaskIds: ['auth'], pendingTaskIds: ['tests'], checkpointPersistenceFailed: true,
    });
    expect(captured).toEqual([1, 2]);
    expect(persisted).toEqual([1]);

    releaseWrite();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(persisted).toEqual([1, 2]);
    vi.useRealTimers();
  });

  it('keeps model-produced task ids and response model names out of publishing progress and token labels', async () => {
    const taskId = 'ghp_fixture_credential_shaped_12345';
    const responseModel = 'ghp_fixture_response_model_67890';
    const events: Array<Record<string, unknown>> = [];
    const progress = createPublishingProgress({ runId: 'run-diagnostic-redaction', executionAttempt: 1 }, { sink: (event) => events.push(event) });
    const ledger = new TokenLedger();
    const complete = vi.fn(async (payload: any) => {
      const text = lastText(payload.messages);
      const nonce = nonceFrom(text);
      if (text.includes('PLAN TURN')) {
        return { ...fakeResponse(JSON.stringify({
          nonce,
          tasks: [{ id: taskId, dimension: 'security', paths: ['src/auth/guard.ts'], question: 'Check auth.', rationale: 'Security path.' }],
        })), model: responseModel };
      }
      return { ...fakeResponse(JSON.stringify({ nonce, task: taskId, status: 'COMPLETE', findings: [] })), model: responseModel };
    });

    const result = await executeComposedReview({
      config: config(), changedFiles: CODE_FILES, repository: 'acme/reviewer-fixture',
      headSha: 'a'.repeat(40), client: meterModelClient(progress.instrument({ complete }), ledger), progress,
    });

    expect(result.applicablePersonaIds).toEqual([taskId]);
    expect(result.personas[0].id).toBe(taskId);
    const serializedDiagnostics = JSON.stringify(events);
    const serializedLedger = JSON.stringify(ledger.snapshot());
    expect(serializedDiagnostics).not.toContain(taskId);
    expect(serializedDiagnostics).not.toContain(responseModel);
    expect(serializedLedger).not.toContain(taskId);
    expect(serializedLedger).not.toContain(responseModel);
    expect(ledger.snapshot().byLane).toHaveProperty('composed-task-1');
    const providerCalls = events.filter((event) => event.task === 'provider_call' && event.status === 'started');
    expect(providerCalls).toHaveLength(2);
    expect(providerCalls.every((event) => event.model === 'codex/gpt-5.6-sol-high')).toBe(true);
  });

  it('records an aborted composed provider call by run and server-derived task lane without changing its request', async () => {
    const controller = new AbortController();
    const events: Array<Record<string, unknown>> = [];
    const progress = createPublishingProgress({ runId: 'run-composed-abort', executionAttempt: 2 }, { sink: (event) => events.push(event) });
    let taskStarted!: () => void;
    const taskCallStarted = new Promise<void>((resolve) => { taskStarted = resolve; });
    let releaseTask!: (response: OpenRouterResponse) => void;
    const forwarded: any[] = [];
    const raw = {
      complete: vi.fn((request: any) => {
        forwarded.push(request);
        const text = lastText(request.messages);
        if (text.includes('PLAN TURN')) {
          const nonce = issuedNonce(request.messages);
          return Promise.resolve(fakeResponse(JSON.stringify({ nonce, tasks: [exhaustionTask] })));
        }
        taskStarted();
        return new Promise<OpenRouterResponse>((resolve) => { releaseTask = resolve; });
      }),
    };
    const run = executeComposedReview({
      config: config(), changedFiles: CODE_FILES, repository: 'acme/reviewer-fixture',
      headSha: 'a'.repeat(40), signal: controller.signal, progress,
      client: progress.instrument(raw),
    });

    await taskCallStarted;
    controller.abort(new Error('private cancellation text'));
    await expect(run).rejects.toBeDefined();
    releaseTask(fakeResponse('{}'));
    await Promise.resolve();

    expect(forwarded).toHaveLength(2);
    expect(forwarded.every((request) => !Object.hasOwn(request, 'internalProgress'))).toBe(true);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ task: 'provider_call', status: 'aborted', role: 'composed_task', lane: 'composed-task-1', turn: 1 }),
      expect.objectContaining({ task: 'composed_task', status: 'aborted', lane: 'composed-task-1', rejectionCode: 'aborted' }),
      expect.objectContaining({ task: 'panel', status: 'aborted', rejectionCode: 'aborted' }),
    ]));
    expect(JSON.stringify(events)).not.toContain('private cancellation text');
  });

  it('feeds bounded full reviewed-head source for a changed path and records the truthful scope', async () => {
    let workCalls = 0;
    let systemPrompt = '';
    const source = [
      'line 1: module header',
      'line 2: changed entrypoint',
      'line 3: unchanged caller contract',
      'line 4: strict-case allowlist',
    ].join('\n');
    const repoFileProvider = {
      findFiles: vi.fn(),
      readFile: vi.fn().mockResolvedValue(source),
    };
    const complete = vi.fn(async (payload: any) => {
      const nonce = issuedNonce(payload.messages);
      if (lastText(payload.messages).includes('PLAN TURN')) {
        systemPrompt = String(payload.messages.find((message: any) => message.role === 'system')?.content || '');
        return fakeResponse(JSON.stringify({ nonce, tasks: [exhaustionTask] }));
      }
      workCalls += 1;
      if (workCalls === 1) {
        return fakeResponse(JSON.stringify({ tool: 'read_file', args: { path: 'src/auth/guard.ts', startLine: 3, endLine: 4 } }));
      }
      const transcript = JSON.stringify(payload.messages);
      expect(transcript).toContain('unchanged caller contract');
      expect(transcript).toContain('strict-case allowlist');
      expect(transcript).toContain('[SCOPE: full-repository | EXHAUSTIVE: true]');
      return fakeResponse(JSON.stringify({ nonce, task: 'task-sec', status: 'COMPLETE', findings: [] }));
    });

    const result = await executeComposedReview({
      config: config(),
      changedFiles: CODE_FILES,
      repository: 'acme/reviewer-fixture',
      headSha: 'a'.repeat(40),
      client: { complete },
      repoFileProvider,
    });

    expect(systemPrompt).toContain(READ_FILE_TOOL_GUIDE);
    expect(systemPrompt).toContain('get_diff and text search remain limited to PR diff content');
    expect(repoFileProvider.readFile).toHaveBeenCalledExactlyOnceWith('src/auth/guard.ts');
    expect(result.personas).toMatchObject([{ id: 'task-sec', decision: 'APPROVE', toolTurns: 1 }]);
  });

  // --- Mutation target 3: "make a BLOCKED task count as a pass" must go red -------------------
  it('keeps inspected small source in the actual final model request after several unrelated reads', async () => {
    let workCalls = 0;
    const pin = 'worker: ghcr.io/acme/worker@sha256:' + 'b'.repeat(64);
    const readFile = vi.fn(async (path: string) => path === 'scripts/pins/images.yaml' ? pin : 'related contract');
    const complete = vi.fn(async (payload: any) => {
      const nonce = issuedNonce(payload.messages);
      if (lastText(payload.messages).includes('PLAN TURN')) {
        return fakeResponse(JSON.stringify({ nonce, tasks: [exhaustionTask] }));
      }
      workCalls += 1;
      if (workCalls <= 4) return fakeResponse(JSON.stringify({ tool: 'read_file', args: {
        path: workCalls === 1 ? 'scripts/pins/images.yaml' : `src/related-${workCalls}.ts`,
      } }));
      const transcript = JSON.stringify(payload.messages);
      expect(transcript).toContain(pin);
      expect(transcript).toContain('[SCOPE: full-repository | EXHAUSTIVE: true]');
      return fakeResponse(JSON.stringify({ nonce, task: 'task-sec', status: 'COMPLETE', findings: [] }));
    });
    const result = await executeComposedReview({ config: config(), changedFiles: CODE_FILES,
      repository: 'acme/reviewer-fixture', headSha: 'a'.repeat(40), client: { complete },
      repoFileProvider: { findFiles: async () => [], readFile } });
    expect(readFile).toHaveBeenCalledTimes(4);
    expect(result.personas).toMatchObject([{ id: 'task-sec', decision: 'APPROVE', toolTurns: 4 }]);
  });

  it('can investigate related reviewed-head files in one tool turn and still requires a nonce-bound result', async () => {
    let workCalls = 0;
    const repoFileProvider = {
      findFiles: vi.fn(), readFile: vi.fn(async (path: string) => `current source for ${path}`),
    };
    const complete = vi.fn(async (payload: any) => {
      const nonce = issuedNonce(payload.messages);
      if (lastText(payload.messages).includes('PLAN TURN')) {
        return fakeResponse(JSON.stringify({ nonce, tasks: [exhaustionTask] }));
      }
      workCalls += 1;
      if (workCalls === 1) {
        return fakeResponse(JSON.stringify({ tool: 'read_files', args: { files: [
          { path: 'src/auth/guard.ts' }, { path: 'src/config.ts' },
        ] } }));
      }
      const transcript = JSON.stringify(payload.messages);
      expect(transcript).toContain('current source for src/auth/guard.ts');
      expect(transcript).toContain('current source for src/config.ts');
      expect(transcript).toContain('[SCOPE: full-repository | EXHAUSTIVE: true]');
      // Tool results are evidence only; this provider result is the sole task completion.
      return fakeResponse(JSON.stringify({ nonce, task: 'task-sec', status: 'COMPLETE', findings: [] }));
    });
    const result = await executeComposedReview({ config: config(), changedFiles: CODE_FILES,
      repository: 'acme/reviewer-fixture', headSha: 'a'.repeat(40), client: { complete }, repoFileProvider });
    expect(complete).toHaveBeenCalledTimes(3); // one plan, one batch, one required final result
    expect(repoFileProvider.readFile).toHaveBeenCalledTimes(2);
    expect(result.personas).toMatchObject([{ id: 'task-sec', decision: 'APPROVE', toolTurns: 1 }]);
    expect(result.personas[0].toolCalls).toMatchObject([{ tool: 'read_files', scope: 'full-repository', exhaustive: true }]);
  });

  it('records a BLOCKED task as a failed lane, never a pass', async () => {
    const complete = vi.fn(async (payload: any) => {
      const text = lastText(payload.messages);
      const nonce = nonceFrom(text);
      if (text.includes('PLAN TURN')) {
        return fakeResponse(JSON.stringify({
          nonce,
          tasks: [
            { id: 'task-sec', dimension: 'security', paths: ['src/auth/guard.ts'], question: 'Is auth bypassable?', rationale: 'auth-sensitive file' },
          ],
        }));
      }
      if (text.includes('WORK TURN')) {
        return fakeResponse(JSON.stringify({ nonce, task: 'task-sec', status: 'BLOCKED', findings: [] }));
      }
      throw new Error(`unexpected turn: ${text.slice(0, 80)}`);
    });

    const result = await executeComposedReview({
      config: config(),
      changedFiles: CODE_FILES,
      repository: 'exampleorg/example-meta',
      headSha: 'a'.repeat(40),
      client: { complete },
    });

    // The counterfactual: BLOCKED must land in optionalFailures, never in personas.
    expect(result.personas).toEqual([]);
    expect(result.optionalFailures).toHaveLength(1);
    expect(result.optionalFailures[0].id).toBe('task-sec');

    // And it must actually gate the merge downstream: a single failed lane forces BLOCK, not SHIP.
    const lanes = [
      ...result.personas,
      ...result.optionalFailures.map((f) => ({ id: f.id, decision: 'ERROR', status: 'ERROR', error: f.error, findings: [] })),
    ];
    const arbitration = computeArbitration(lanes, result.applicablePersonaIds!.length, {
      changedFiles: CODE_FILES,
      coverageComplete: true,
      panelSize: 1,
    });
    expect(arbitration.verdict).toBe('BLOCK');
    expect(arbitration.verdict).not.toBe('SHIP');
  });

  // --- Mutation target 2: "make an empty plan on a code diff return SHIP" must go red -----------
  it('fails closed on an empty plan against a real code diff, and never resolves', async () => {
    const complete = vi.fn(async (payload: any) => {
      const text = lastText(payload.messages);
      const nonce = nonceFrom(text);
      if (text.includes('PLAN TURN') || text.includes('PLAN_CORRECTION')) {
        return fakeResponse(JSON.stringify({ nonce, tasks: [] }));
      }
      throw new Error(`unexpected turn: ${text.slice(0, 80)}`);
    });

    await expect(executeComposedReview({
      config: config(),
      changedFiles: CODE_FILES,
      repository: 'exampleorg/example-meta',
      headSha: 'a'.repeat(40),
      client: { complete },
    })).rejects.toThrow(/empty_plan/);
  });

  // Degenerate-provider discrimination for plan rejections (issue #950). During the
  // 2026-09-21 gateway outage the provider returned HTTP 200 with non-empty-but-garbage
  // content -- blank task fields at zero completion tokens -- which sailed through the
  // transport retry ladders (they only catch empty/transport errors) and then published
  // as terminal `contract` failures. Degenerate evidence means the transport produced
  // garbage, so the honest published class is `provider_error`, not a contract breach.
  function degenerateResponse(content: string): OpenRouterResponse {
    return { model: 'test-model', content, usage: { prompt: 10, completion: 0, total: 10 }, costUSD: 0.001, raw: {} };
  }

  const BLANK_FIELD_TASK = { id: 'task-sec', dimension: 'security', paths: ['src/auth/guard.ts'], question: '', rationale: '' };

  it('classifies a blank-field plan rejection as provider_error when the turns were degenerate (0 completion tokens)', async () => {
    const complete = vi.fn(async (payload: any) => {
      const text = lastText(payload.messages);
      const nonce = nonceFrom(text);
      if (text.includes('PLAN TURN') || text.includes('PLAN_CORRECTION')) {
        return degenerateResponse(JSON.stringify({ nonce, tasks: [BLANK_FIELD_TASK] }));
      }
      throw new Error(`unexpected turn: ${text.slice(0, 80)}`);
    });

    await expect(executeComposedReview({
      config: config(),
      changedFiles: CODE_FILES,
      repository: 'exampleorg/example-meta',
      headSha: 'a'.repeat(40),
      client: { complete },
    })).rejects.toMatchObject({ failureClass: 'provider_error' });
  });

  it('keeps contract classification for a blank-field plan rejection backed by healthy token usage', async () => {
    const complete = vi.fn(async (payload: any) => {
      const text = lastText(payload.messages);
      const nonce = nonceFrom(text);
      if (text.includes('PLAN TURN') || text.includes('PLAN_CORRECTION')) {
        return fakeResponse(JSON.stringify({ nonce, tasks: [BLANK_FIELD_TASK] }));
      }
      throw new Error(`unexpected turn: ${text.slice(0, 80)}`);
    });

    await expect(executeComposedReview({
      config: config(),
      changedFiles: CODE_FILES,
      repository: 'exampleorg/example-meta',
      headSha: 'a'.repeat(40),
      client: { complete },
    })).rejects.toMatchObject({ failureClass: 'contract' });
  });

  it('classifies a nonce-mismatch rejection as provider_error when the completion was blank at zero tokens', async () => {
    const complete = vi.fn(async (payload: any) => {
      const text = lastText(payload.messages);
      if (text.includes('PLAN TURN') || text.includes('PLAN_CORRECTION')) {
        // Blank content with present-but-zero-completion usage: the gateway answered
        // with nothing real. This is transport degeneracy, not a contract breach.
        return degenerateResponse('');
      }
      throw new Error(`unexpected turn: ${text.slice(0, 80)}`);
    });

    await expect(executeComposedReview({
      config: config(),
      changedFiles: CODE_FILES,
      repository: 'exampleorg/example-meta',
      headSha: 'a'.repeat(40),
      client: { complete },
    })).rejects.toMatchObject({ failureClass: 'provider_error' });
  });

  // The plan and work prompts both embed untrusted diff text by construction. The nonce is what
  // binds a returned object back to the request that asked for it; without the check the field is
  // decorative and an object echoing an earlier turn's shape -- or one supplied by injected diff
  // content -- would be accepted. The fan-out engine enforces this via
  // `parseNativeJsonObject(content, expectedNonce)`; the composed path must not be weaker.
  it('rejects a plan whose nonce does not match the one issued for the request', async () => {
    const complete = vi.fn(async (payload: any) => {
      const text = lastText(payload.messages);
      if (text.includes('PLAN TURN') || text.includes('PLAN_CORRECTION')) {
        return fakeResponse(JSON.stringify({
          nonce: 'not-the-issued-nonce',
          tasks: [
            { id: 'task-sec', dimension: 'security', paths: ['src/auth/guard.ts'], question: 'q', rationale: 'r' },
          ],
        }));
      }
      throw new Error(`unexpected turn: ${text.slice(0, 80)}`);
    });

    await expect(executeComposedReview({
      config: config(),
      changedFiles: CODE_FILES,
      repository: 'exampleorg/example-meta',
      headSha: 'a'.repeat(40),
      client: { complete },
    })).rejects.toThrow(/nonce/i);
  });

  it('rejects a task result whose nonce does not match, and never records it as a pass', async () => {
    const complete = vi.fn(async (payload: any) => {
      const text = lastText(payload.messages);
      const issued = nonceFrom(text);
      if (text.includes('PLAN TURN')) {
        return fakeResponse(JSON.stringify({
          nonce: issued,
          tasks: [
            { id: 'task-sec', dimension: 'security', paths: ['src/auth/guard.ts'], question: 'q', rationale: 'r' },
          ],
        }));
      }
      // A well-formed, plausible COMPLETE with zero findings -- the shape most dangerous to accept.
      return fakeResponse(JSON.stringify({
        nonce: 'not-the-issued-nonce', task: 'task-sec', status: 'COMPLETE', findings: [],
      }));
    });

    const result = await executeComposedReview({
      config: config(),
      changedFiles: CODE_FILES,
      repository: 'exampleorg/example-meta',
      headSha: 'a'.repeat(40),
      client: { complete },
    }).catch((e) => e);

    // Either it throws, or it completes with the task absent from the roster. What must NOT
    // happen is an APPROVE lane for a result that was never bound to its request.
    const personas = (result && (result as any).personas) || [];
    expect(personas.some((p: any) => p.decision === 'APPROVE' || p.decision === 'FINDINGS')).toBe(false);
  });

  it.each(['json', 'JSON', ''])('accepts only a complete %s Markdown fence around nonce-bound plan and result objects', async (language) => {
    const complete = vi.fn(async (payload: any) => {
      const text = lastText(payload.messages);
      const nonce = issuedNonce(payload.messages);
      const body = text.includes('PLAN TURN')
        ? { nonce, tasks: [{ id: 'task-sec', dimension: 'security', paths: ['src/auth/guard.ts'], question: 'Is the guard sound?', rationale: 'Review the guard.' }] }
        : { nonce, task: 'task-sec', status: 'COMPLETE', findings: [] };
      return fakeResponse(` \n\`\`\`${language}\r\n${JSON.stringify(body)}\r\n\`\`\`\n `);
    });
    const result = await executeComposedReview({ config: config(), changedFiles: CODE_FILES,
      repository: 'acme/reviewer-fixture', headSha: 'a'.repeat(40), client: { complete } });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(result.personas).toMatchObject([{ id: 'task-sec', decision: 'APPROVE' }]);
    expect(result.unreportedLanes).toEqual([]);
  });

  it.each(['prose', 'two-fences', 'two-objects', 'wrong-language'])('does not extract a task result from %s', async (shape) => {
    let workCalls = 0;
    const complete = vi.fn(async (payload: any) => {
      const nonce = issuedNonce(payload.messages);
      if (lastText(payload.messages).includes('PLAN TURN')) {
        return fakeResponse(JSON.stringify({ nonce, tasks: [{ id: 'task-sec', dimension: 'security', paths: ['src/auth/guard.ts'], question: 'Guard?', rationale: 'Guard.' }] }));
      }
      workCalls += 1;
      const body = JSON.stringify({ nonce, task: 'task-sec', status: 'COMPLETE', findings: [] });
      const fence = `\`\`\`json\n${body}\n\`\`\``;
      return fakeResponse(shape === 'prose' ? `Here is the result:\n${fence}`
        : shape === 'two-fences' ? `${fence}\n${fence}`
          : shape === 'two-objects' ? `${body}\n${body}` : `\`\`\`javascript\n${body}\n\`\`\``);
    });
    const result = await executeComposedReview({ config: config(), changedFiles: CODE_FILES,
      repository: 'acme/reviewer-fixture', headSha: 'a'.repeat(40), client: { complete } });
    expect(workCalls).toBe(3); // initial reply, one correction, one fresh recovery; never an unbounded retry
    expect(result.personas).toEqual([]);
    expect(result.unreportedLanes).toMatchObject([{ id: 'task-sec', failureClass: 'malformed_output',
      error: expect.stringContaining('non_json_task_result') }]);
    expect(projectPublishingRosterBounds(result).returnedIds).toEqual([]);
  });

  it('immediately finalizes a malformed finding with the complete strict schema and does not normalize severity', async () => {
    let workCalls = 0;
    const events: Array<Record<string, unknown>> = [];
    const progress = createPublishingProgress({ runId: 'run-findings-recovery', executionAttempt: 1 }, { sink: (event) => events.push(event) });
    const complete = vi.fn(async (payload: any) => {
      const nonce = issuedNonce(payload.messages);
      if (lastText(payload.messages).includes('PLAN TURN')) {
        return fakeResponse(JSON.stringify({ nonce, tasks: [{ id: 'task-sec', dimension: 'security', paths: ['src/auth/guard.ts'], question: 'Guard?', rationale: 'Guard.' }] }));
      }
      workCalls += 1;
      if (workCalls === 1) {
        expect(payload.responseFormat).toEqual({ type: 'json_object' });
        return fakeResponse(JSON.stringify({ nonce, task: 'task-sec', status: 'COMPLETE', findings: [
          { severity: 'HIGH', path: 'src/auth/guard.ts', line: 1, startLine: null, title: 'Synthetic guard defect',
            body: 'The synthetic guard always returns true.', suggestion: null, replacementCode: null },
        ] }));
      }
      expect(payload.responseFormat.json_schema.name).toBe('ct_review_task_result_v1');
      expect(payload.responseFormat.json_schema.strict).toBe(true);
      expect(payload.responseFormat.json_schema.schema.properties.findings.items.required).toEqual([
        'severity', 'path', 'line', 'startLine', 'title', 'body', 'suggestion', 'replacementCode',
      ]);
      const correction = lastText(payload.messages);
      expect(correction).toContain('TASK_RESULT_CORRECTION');
      expect(correction).toContain('findings_contract');
      expect(correction).toContain('Use exactly one declared severity value: P0, P1, or P2. Do not relabel or infer severity.');
      expect(correction).toContain('Binding task-result schema:');
      expect(correction).toContain('"enum":["P0","P1","P2"]');
      expect(correction).toContain('do not request another tool');
      return fakeResponse(JSON.stringify({ nonce, task: 'task-sec', status: 'BLOCKED', findings: [] }));
    });
    const result = await executeComposedReview({ config: config(), changedFiles: CODE_FILES,
      repository: 'acme/reviewer-fixture', headSha: 'a'.repeat(40), client: progress.instrument({ complete }), progress });
    expect(workCalls).toBe(2);
    expect(result.personas).toEqual([]);
    expect(result.optionalFailures).toMatchObject([{ id: 'task-sec' }]);
    expect(result.unreportedLanes).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({ task: 'provider_output', status: 'rejected', lane: 'composed-task-1', rejectionCode: 'finding_severity_invalid' }));
    expect(events).toContainEqual(expect.objectContaining({ task: 'composed_task', status: 'blocked', lane: 'composed-task-1' }));
  });

  it('keeps added-line validation fail-closed after the existing correction and fresh-recovery turns', async () => {
    let workCalls = 0;
    const events: Array<Record<string, unknown>> = [];
    const progress = createPublishingProgress({ runId: 'run-invalid-anchor', executionAttempt: 1 }, { sink: (event) => events.push(event) });
    const complete = vi.fn(async (payload: any) => {
      const nonce = issuedNonce(payload.messages);
      if (lastText(payload.messages).includes('PLAN TURN')) return fakeResponse(JSON.stringify({ nonce, tasks: [exhaustionTask] }));
      workCalls += 1;
      if (workCalls > 1) {
        const correction = lastText(payload.messages);
        expect(correction).toContain('Correct the finding line to an added line in the supplied changed-file diff, or remove the finding if it cannot be anchored.');
      }
      return fakeResponse(JSON.stringify({
        nonce, task: 'task-sec', status: 'COMPLETE',
        findings: [{ severity: 'P1', path: 'src/auth/guard.ts', line: 99, title: 'Synthetic', body: 'Synthetic.' }],
      }));
    });

    const result = await executeComposedReview({
      config: config(), changedFiles: CODE_FILES, repository: 'acme/reviewer-fixture',
      headSha: 'a'.repeat(40), client: progress.instrument({ complete }), progress,
    });

    expect(workCalls).toBe(3);
    expect(result.personas).toEqual([]);
    expect(result.unreportedLanes).toMatchObject([{ id: 'task-sec', failureClass: 'malformed_output', diagnostics: { reason: 'invalid_findings', correctionAttempts: 2 } }]);
    expect(events.filter((event) => event.task === 'provider_output' && event.status === 'rejected'))
      .toMatchObject([{ rejectionCode: 'finding_line_not_added' }, { rejectionCode: 'finding_line_not_added' }, { rejectionCode: 'finding_line_not_added' }]);
  });

  it('uses at most one fresh strict recovery, retaining read-only evidence but not malformed replies', async () => {
    let workCalls = 0;
    const complete = vi.fn(async (payload: any) => {
      const nonce = issuedNonce(payload.messages);
      if (lastText(payload.messages).includes('PLAN TURN')) {
        return fakeResponse(JSON.stringify({ nonce, tasks: [{ id: 'task-sec', dimension: 'security', paths: ['src/auth/guard.ts'], question: 'Guard?', rationale: 'Guard.' }] }));
      }
      workCalls += 1;
      if (workCalls === 1) return fakeResponse(JSON.stringify({ tool: 'get_diff', args: { path: 'src/auth/guard.ts' } }));
      if (workCalls === 2) return fakeResponse('SYNTHETIC_MALFORMED_REPLY_A');
      if (workCalls === 3) return fakeResponse('SYNTHETIC_MALFORMED_REPLY_B');
      expect(payload.responseFormat.json_schema.name).toBe('ct_review_task_result_v1');
      const all = JSON.stringify(payload.messages);
      expect(lastText(payload.messages)).toContain('TASK_RESULT_FRESH_RECOVERY');
      expect(all).toContain('[PI_TOOL_RESULT]');
      expect(all).toContain('export function guard()');
      expect(all).not.toContain('SYNTHETIC_MALFORMED_REPLY');
      return fakeResponse(JSON.stringify({ nonce, task: 'task-sec', status: 'COMPLETE', findings: [] }));
    });
    const result = await executeComposedReview({ config: config(), changedFiles: CODE_FILES,
      repository: 'acme/reviewer-fixture', headSha: 'a'.repeat(40), client: { complete } });
    expect(workCalls).toBe(4);
    expect(result.personas).toMatchObject([{ id: 'task-sec', decision: 'APPROVE', toolTurns: 1, turnsCount: 4 }]);
    expect(result.personas[0].turnUsages?.slice(-4).map((usage) => usage.kind)).toEqual(['tool', 'tool', 'correction', 'correction']);
  });

  it.each([
    ['nonce_mismatch', (nonce: string) => ({ nonce: `wrong-${nonce}`, task: 'task-sec', status: 'COMPLETE', findings: [] })],
    ['task_mismatch', (nonce: string) => ({ nonce, task: 'other-task', status: 'COMPLETE', findings: [] })],
    ['status_enum', (nonce: string) => ({ nonce, task: 'task-sec', status: 'APPROVE', findings: [] })],
    ['result_fields', (nonce: string) => ({ nonce, task: 'task-sec', status: 'COMPLETE', findings: [], tool: 'read_file', args: { path: 'src/auth/guard.ts' } })],
    ['findings_contract', (nonce: string) => ({ nonce, task: 'task-sec', status: 'COMPLETE', findings: [
      { severity: 'P1', path: 'src/not-changed.ts', line: 1, title: 'Synthetic', body: 'Synthetic.' },
    ] })],
  ] as const)('retains the redacted %s reason without accepting a malformed final result', async (reason, badResult) => {
    let workCalls = 0;
    const complete = vi.fn(async (payload: any) => {
      const nonce = issuedNonce(payload.messages);
      if (lastText(payload.messages).includes('PLAN TURN')) {
        return fakeResponse(JSON.stringify({ nonce, tasks: [{ id: 'task-sec', dimension: 'security', paths: ['src/auth/guard.ts'], question: 'Guard?', rationale: 'Guard.' }] }));
      }
      workCalls += 1;
      const body = JSON.stringify(badResult(nonce));
      return fakeResponse(reason === 'nonce_mismatch' ? `\`\`\`json\n${body}\n\`\`\`` : body);
    });
    const result = await executeComposedReview({ config: config(), changedFiles: CODE_FILES,
      repository: 'acme/reviewer-fixture', headSha: 'a'.repeat(40), client: { complete } });
    expect(workCalls).toBe(3);
    expect(result.personas).toEqual([]);
    const diagnosticReason = {
      nonce_mismatch: 'nonce_mismatch', task_mismatch: 'task_id_mismatch',
      status_enum: 'invalid_status', result_fields: 'invalid_result_fields',
      findings_contract: 'invalid_findings',
    }[reason];
    expect(result.unreportedLanes).toMatchObject([{ failureClass: 'malformed_output', error: expect.stringContaining(`reason=${diagnosticReason}`) }]);
    expect(result.unreportedLanes?.[0].error).not.toContain('contract rejected');
    expect(result.unreportedLanes?.[0].diagnostics).toMatchObject({
      reason: diagnosticReason, turnsUsed: 3, correctionAttempts: 2,
    });
    expect(result.unreportedLanes?.[0].error).not.toContain('wrong-');
    expect(result.unreportedLanes?.[0].error).not.toContain('not-changed');
    expect(result.unreportedLanes?.[0].error).not.toContain('Synthetic');
  });

  it.each([
    ['missing args', { tool: 'get_diff' }],
    ['array args', { tool: 'get_diff', args: [{ path: 'src/auth/guard.ts' }] }],
  ] as const)('rejects a tool envelope with %s as result_fields without executing a tool', async (_shape, envelope) => {
    const runTool = vi.spyOn(toolRuntime, 'runReadOnlyTool');
    let workCalls = 0;
    const complete = vi.fn(async (payload: any) => {
      const nonce = issuedNonce(payload.messages);
      if (lastText(payload.messages).includes('PLAN TURN')) return fakeResponse(JSON.stringify({ nonce, tasks: [
        { id: 'task-sec', dimension: 'security', paths: ['src/auth/guard.ts'], question: 'Guard?', rationale: 'Guard.' },
      ] }));
      workCalls += 1;
      return fakeResponse(JSON.stringify(envelope));
    });
    try {
      const result = await executeComposedReview({ config: config(), changedFiles: CODE_FILES,
        repository: 'acme/reviewer-fixture', headSha: 'a'.repeat(40), client: { complete } });
      expect(runTool).not.toHaveBeenCalled();
      expect(workCalls).toBe(3);
      expect(result.personas).toEqual([]);
      expect(projectPublishingRosterBounds(result).returnedIds).toEqual([]);
      expect(result.unreportedLanes?.[0]).toMatchObject({ failureClass: 'malformed_output',
        error: expect.stringContaining('result_fields'), diagnostics: {
          reason: 'invalid_result_fields', lastToolOutcome: 'none',
          toolTurns: 0, turnsUsed: 3, correctionAttempts: 2,
        } });
    } finally {
      runTool.mockRestore();
    }
  });

  it('aligns task-result admission with the exact provider schema and still rejects undeclared fields', async () => {
    let workCalls = 0;
    const complete = vi.fn(async (payload: any) => {
      const nonce = issuedNonce(payload.messages);
      if (lastText(payload.messages).includes('PLAN TURN')) return fakeResponse(JSON.stringify({ nonce, tasks: [
        { id: 'task-sec', dimension: 'security', paths: ['src/auth/guard.ts'], question: 'Guard?', rationale: 'Guard.' },
      ] }));
      workCalls += 1;
      const values: Record<string, unknown> = { nonce, task: 'task-sec', status: 'COMPLETE', findings: [] };
      if (workCalls === 1) return fakeResponse(JSON.stringify({ ...values, undeclaredContractField: 'must reject' }));
      const format = payload.responseFormat;
      const schema = format.json_schema.schema;
      expect(format.json_schema.name).toBe('ct_review_task_result_v1');
      expect(format.json_schema.strict).toBe(true);
      expect(schema.additionalProperties).toBe(false);
      expect(Object.keys(schema.properties).sort()).toEqual([...schema.required].sort());
      expect(lastText(payload.messages)).toContain('result_fields');
      expect(lastText(payload.messages)).toContain(`Binding task-result schema: ${JSON.stringify(format.json_schema)}`);
      // Populate every declared property from the real provider schema. An additive string
      // field must be admitted without another hand-maintained allowlist being updated here.
      const candidate = Object.fromEntries(Object.entries(schema.properties).map(([field, property]) => {
        if (Object.hasOwn(values, field)) return [field, values[field]];
        expect(property).toMatchObject({ type: 'string' });
        return [field, 'schema-declared-fixture'];
      }));
      expect(Object.keys(candidate).sort()).toEqual(Object.keys(schema.properties).sort());
      return fakeResponse(JSON.stringify(candidate));
    });
    const result = await executeComposedReview({ config: config(), changedFiles: CODE_FILES,
      repository: 'acme/reviewer-fixture', headSha: 'a'.repeat(40), client: { complete } });
    expect(workCalls).toBe(2);
    expect(result.personas).toMatchObject([{ id: 'task-sec', decision: 'APPROVE', toolTurns: 0, turnsCount: 2 }]);
    expect(result.unreportedLanes).toEqual([]);
    expect(projectPublishingRosterBounds(result).returnedIds).toEqual(['task-sec']);
  });

  it('rejects tools requested during correction and retains their exact redacted diagnostic', async () => {
    let workCalls = 0;
    const complete = vi.fn(async (payload: any) => {
      const nonce = issuedNonce(payload.messages);
      if (lastText(payload.messages).includes('PLAN TURN')) return fakeResponse(JSON.stringify({ nonce, tasks: [
        { id: 'task-sec', dimension: 'security', paths: ['src/auth/guard.ts'], question: 'Guard?', rationale: 'Guard.' },
      ] }));
      workCalls += 1;
      if (workCalls === 1) return fakeResponse('not a result');
      expect(lastText(payload.messages)).toContain('TASK_FINALIZATION');
      return fakeResponse(JSON.stringify({ tool: 'get_diff', args: { path: 'src/auth/guard.ts' } }));
    });
    const result = await executeComposedReview({ config: config(), changedFiles: CODE_FILES,
      repository: 'acme/reviewer-fixture', headSha: 'a'.repeat(40), client: { complete } });
    expect(workCalls).toBe(3);
    expect(result.personas).toEqual([]);
    expect(result.unreportedLanes?.[0]).toMatchObject({ failureClass: 'malformed_output',
      error: expect.stringContaining('tool_requested_during_finalization'), diagnostics: {
        reason: 'tool_requested_during_finalization', lastToolOutcome: 'requested_after_finalization',
        toolTurns: 0, turnsUsed: 3, correctionAttempts: 2,
      } });
  });

  it('propagates unexpected findings-validator errors without consuming malformed-output recovery', async () => {
    const unexpected = new TypeError('synthetic internal validator defect');
    const validate = vi.spyOn(panelEngine, 'validateFindings').mockImplementation(() => { throw unexpected; });
    let workCalls = 0;
    const complete = vi.fn(async (payload: any) => {
      const nonce = issuedNonce(payload.messages);
      if (lastText(payload.messages).includes('PLAN TURN')) return fakeResponse(JSON.stringify({ nonce, tasks: [
        { id: 'task-sec', dimension: 'security', paths: ['src/auth/guard.ts'], question: 'Guard?', rationale: 'Guard.' },
      ] }));
      workCalls += 1;
      return fakeResponse(JSON.stringify({ nonce, task: 'task-sec', status: 'COMPLETE', findings: [] }));
    });
    try {
      await expect(executeComposedReview({ config: config(), changedFiles: CODE_FILES,
        repository: 'acme/reviewer-fixture', headSha: 'a'.repeat(40), client: { complete } })).rejects.toBe(unexpected);
      expect(workCalls).toBe(1);
      expect(validate).toHaveBeenCalledOnce();
    } finally {
      validate.mockRestore();
    }
  });

  it.each([[100, 1], [100, 2], [2, 12], [3, 12]])('does not enlarge total/task caps %i/%i for recovery', async (totalCap, taskCap) => {
    let workCalls = 0;
    const complete = vi.fn(async (payload: any) => {
      const nonce = issuedNonce(payload.messages);
      if (lastText(payload.messages).includes('PLAN TURN')) return fakeResponse(JSON.stringify({ nonce, tasks: [
        { id: 'task-sec', dimension: 'security', paths: ['src/auth/guard.ts'], question: 'Guard?', rationale: 'Guard.' },
      ] }));
      workCalls += 1;
      return fakeResponse('not a result');
    });
    const cfg = config();
    cfg.composed = { max_turns_total: totalCap, max_turns_per_task: taskCap };
    const result = await executeComposedReview({ config: cfg, changedFiles: CODE_FILES,
      repository: 'acme/reviewer-fixture', headSha: 'a'.repeat(40), client: { complete } });
    expect(workCalls).toBe(Math.min(totalCap - 1, taskCap));
    expect(result.personas).toEqual([]);
  });

  // Collapsing N lanes into one loop deletes the redundancy that used to absorb provider hiccups.
  // In the fan-out engine a transient fault cost one lane and the panel still reached a verdict
  // from the rest; here there is no rest, so one empty completion would end the whole review.
  // Observed twice in one afternoon on a real PR, each clearing on a plain retry.
  it('retries a transient empty completion instead of losing the entire review', async () => {
    let attempts = 0;
    const complete = vi.fn(async (payload: any) => {
      const text = lastText(payload.messages);
      const issued = nonceFrom(text);
      if (text.includes('PLAN TURN')) {
        attempts += 1;
        if (attempts === 1) {
          // Must be the real error type and message the predicate matches on; a look-alike
          // proves nothing about the production path.
          throw new OpenRouterResponseError('provider returned empty completion content', 200);
        }
        return fakeResponse(JSON.stringify({
          nonce: issued,
          tasks: [
            { id: 'task-sec', dimension: 'security', paths: ['src/auth/guard.ts'], question: 'q', rationale: 'r' },
          ],
        }));
      }
      return fakeResponse(JSON.stringify({ nonce: issued, task: 'task-sec', status: 'COMPLETE', findings: [] }));
    });

    const result = await executeComposedReview({
      config: config(),
      changedFiles: CODE_FILES,
      repository: 'exampleorg/example-meta',
      headSha: 'a'.repeat(40),
      client: { complete },
    });

    expect(attempts).toBeGreaterThan(1);
    expect(result.personas).toHaveLength(1);
    expect(result.personas[0].id).toBe('task-sec');
  });


  // REL-1113: the composed engine shares the lane transport predicate. A gateway 502 and an
  // interrupted stream ("terminated") are the path to the model, not an answer: the plan turn
  // rides them out on the transport budget and the review completes. A 413 fails the same way
  // every time and is never retried.
  it('rides out a gateway 502 and a terminated stream on the transport budget', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      let planCalls = 0;
      const complete = vi.fn(async (payload: any) => {
        const text = lastText(payload.messages);
        const issued = nonceFrom(text);
        if (text.includes('PLAN TURN')) {
          planCalls += 1;
          if (planCalls === 1) throw new OpenRouterResponseError('bifrost: gateway-internal HTTP 502: Bad Gateway (nginx)', 502);
          if (planCalls === 2) throw new OpenRouterConnectionError('OpenRouter SDK connection failure for model pr-reviewer: terminated');
          return fakeResponse(JSON.stringify({ nonce: issued, tasks: [
            { id: 'task-sec', dimension: 'security', paths: ['src/auth/guard.ts'], question: 'q', rationale: 'r' },
          ] }));
        }
        return fakeResponse(JSON.stringify({ nonce: issued, task: 'task-sec', status: 'COMPLETE', findings: [] }));
      });
      const result = await executeComposedReview({ config: config(), changedFiles: CODE_FILES,
        repository: 'exampleorg/example-meta', headSha: 'a'.repeat(40), client: { complete } });
      expect(planCalls).toBe(3);
      expect(result.personas.map((persona) => persona.id)).toEqual(['task-sec']);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('never retries a gateway 413 on the transport budget', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      let planCalls = 0;
      const complete = vi.fn(async (payload: any) => {
        if (lastText(payload.messages).includes('PLAN TURN')) {
          planCalls += 1;
          throw new OpenRouterResponseError('bifrost: gateway-internal HTTP 413: Request Entity Too Large', 413);
        }
        return fakeResponse('{}');
      });
      await expect(executeComposedReview({ config: config(), changedFiles: CODE_FILES,
        repository: 'exampleorg/example-meta', headSha: 'a'.repeat(40), client: { complete } })).rejects.toThrow();
      expect(planCalls).toBe(1);
    } finally {
      vi.restoreAllMocks();
    }
  });

  // The retry ladders check their backoff against the run's remaining budget. That check compared
  // against Infinity until the deadline was actually threaded from the orchestrator into
  // `callTurn` -- the guard existed, was described as "budget-aware" in its own commit message,
  // and could not fire. A non-positive configured setting uses the shared 900s fallback, rather
  // than an inline zero cutoff that disagrees with the abort signal's admitted budget.
  it('uses the shared configured fallback when the timeout setting is non-positive', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const complete = vi.fn(async () => {
      calls += 1;
      throw new OpenRouterResponseError('provider returned empty completion content', 200);
    });

    const cfg: any = config();
    cfg.reviewers = { ...cfg.reviewers, overall_timeout_s: 0 };

    const settled = executeComposedReview({
      config: cfg,
      changedFiles: CODE_FILES,
      repository: 'exampleorg/example-meta',
      headSha: 'a'.repeat(40),
      client: { complete },
    }).catch(() => undefined);

    try {
      await vi.advanceTimersByTimeAsync(10_000);
      await settled;
      expect(calls).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the inherited admitted clock and cutoff instead of minting a composed retry window', async () => {
    vi.useFakeTimers();
    // Keep the cutoff in the future according to Date.now(), but advance only the admitted
    // clock to it. If callTurn accidentally consults Date.now() again, it will see retry budget
    // and make another provider call; using the admitted clock must suppress that retry.
    const wallClockMs = Date.now();
    let currentMs = wallClockMs;
    const now = () => currentMs;
    const deadlineAtMs = wallClockMs + 5_000;
    const cancellation = new AbortController();
    const admitted = panelEngine.createPanelDeadlineSignal(1_800, cancellation.signal,
      { deadlineAtMs, timeoutMs: 5_000, terminalBound: true }, now);
    let calls = 0;
    const complete = vi.fn(async () => {
      calls += 1;
      currentMs = deadlineAtMs;
      throw new OpenRouterResponseError('provider returned empty completion content', 200);
    });
    const settled = executeComposedReview({ config: config(), changedFiles: CODE_FILES,
      repository: 'exampleorg/example-meta', headSha: 'a'.repeat(40), client: { complete },
      signal: admitted.signal, deadlineBudget: admitted.budget, deadlineNow: admitted.now }).catch((error) => error);

    try {
      expect(Date.now()).toBeLessThan(deadlineAtMs);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(calls).toBe(1);
      expect(await settled).toBeInstanceOf(OpenRouterResponseError);
    } finally {
      cancellation.abort();
      admitted.cleanup();
      vi.useRealTimers();
    }
  });

  function threeTasks() {
    return [
      { id: 'task-1', dimension: 'security', paths: ['src/auth/guard.ts'], question: 'Is the first change safe?', rationale: 'first' },
      { id: 'task-2', dimension: 'testing', paths: ['src/auth/guard.ts'], question: 'Is the second change covered?', rationale: 'second' },
      { id: 'task-3', dimension: 'architecture', paths: ['src/auth/guard.ts'], question: 'Does the third change fail closed?', rationale: 'third' },
    ];
  }

  function fourTasks() {
    return [
      ...threeTasks(),
      { id: 'task-4', dimension: 'security', paths: ['src/auth/guard.ts'], question: 'Does the fourth change remain available?', rationale: 'fourth' },
    ];
  }

  function manyTasks(count: number) {
    const dimensions = ['security', 'testing', 'architecture'] as const;
    return Array.from({ length: count }, (_, index) => ({
      id: `task-${index + 1}`,
      dimension: dimensions[index % dimensions.length],
      paths: ['src/auth/guard.ts'],
      question: `Review change ${index + 1}?`,
      rationale: `bounded fixture ${index + 1}`,
    }));
  }

  function responseForTask(payload: any, taskId: string) {
    return fakeResponse(JSON.stringify({ nonce: issuedNonce(payload.messages), task: taskId, status: 'COMPLETE', findings: [] }));
  }

  async function withMaxTaskConcurrency<T>(work: () => Promise<T>): Promise<T> {
    vi.stubEnv('REVIEW_YETI_MAX_CONCURRENT_LANES', '8');
    try {
      return await work();
    } finally {
      vi.unstubAllEnvs();
    }
  }

  it('runs three tasks concurrently and folds results in accepted plan order', async () => {
    let active = 0;
    let maxActive = 0;
    const started: string[] = [];
    const complete = vi.fn(async (payload: any) => {
      const text = lastText(payload.messages);
      const nonce = issuedNonce(payload.messages);
      if (text.includes('PLAN TURN')) return fakeResponse(JSON.stringify({ nonce, tasks: manyTasks(6) }));
      const directive = payload.messages.find((message: any) =>
        typeof message.content === 'string' && message.content.includes('=== WORK TURN'))?.content ?? text;
      const taskId = directive.match(/Task id: (task-[0-9]+)/)?.[1];
      if (!taskId) throw new Error(`missing task id in work directive: ${directive.slice(0, 100)}`);
      started.push(taskId);
      active += 1;
      maxActive = Math.max(maxActive, active);
      // Complete out of order within the first cohort; output remains in plan order.
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, 4 - Number(taskId.slice(5))) * 4));
      active -= 1;
      return responseForTask(payload, taskId);
    });

    const result = await withMaxTaskConcurrency(() => executeComposedReview({ config: config(), changedFiles: CODE_FILES,
      repository: 'acme/reviewer-fixture', headSha: 'a'.repeat(40), client: { complete } }));

    expect(maxActive).toBe(3);
    const expectedOrder = orderReviewTasksByRisk(manyTasks(6)).map((task) => task.id);
    expect(started).toEqual(expectedOrder);
    expect(result.personas.map((lane) => lane.id)).toEqual(expectedOrder);
    expect(result.unreportedLanes).toEqual([]);
  });

  it('keeps publisher-owned shadow work serial even when the ordinary task ceiling is three', async () => {
    let active = 0;
    let maxActive = 0;
    const complete = vi.fn(async (payload: any) => {
      const text = lastText(payload.messages);
      const nonce = issuedNonce(payload.messages);
      if (text.includes('PLAN TURN')) return fakeResponse(JSON.stringify({ nonce, tasks: manyTasks(3) }));
      const directive = payload.messages.find((message: any) =>
        typeof message.content === 'string' && message.content.includes('=== WORK TURN'))?.content ?? text;
      const taskId = directive.match(/Task id: (task-[0-9]+)/)?.[1];
      if (!taskId) throw new Error('missing task id in shadow fixture');
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return responseForTask(payload, taskId);
    });

    const result = await withMaxTaskConcurrency(() => executeComposedReview({ config: config(), changedFiles: CODE_FILES,
      repository: 'acme/reviewer-fixture', headSha: 'a'.repeat(40), client: { complete }, publisherShadow: true }));

    expect(maxActive).toBe(1);
    expect(result.personas.map((lane) => lane.id))
      .toEqual(orderReviewTasksByRisk(manyTasks(3)).map((task) => task.id));
  });

  it('refunds unused cohort reservations before admitting waiting tasks without exceeding the total turn cap', async () => {
    const events: Array<Record<string, unknown>> = [];
    const progress = createPublishingProgress({ runId: 'run-composed-budget-cohorts', executionAttempt: 1 }, { sink: (event) => events.push(event) });
    const started: string[] = [];
    const cfg: any = config();
    cfg.composed = { max_turns_total: 5, max_turns_per_task: 2 };
    const complete = vi.fn(async (payload: any) => {
      const text = lastText(payload.messages);
      const nonce = issuedNonce(payload.messages);
      if (text.includes('PLAN TURN')) return fakeResponse(JSON.stringify({ nonce, tasks: manyTasks(5) }));
      const directive = payload.messages.find((message: any) =>
        typeof message.content === 'string' && message.content.includes('=== WORK TURN'))?.content ?? text;
      const taskId = directive.match(/Task id: (task-[0-9]+)/)?.[1];
      if (!taskId) throw new Error('missing task id in budget fixture');
      started.push(taskId);
      return responseForTask(payload, taskId);
    });

    const result = await withMaxTaskConcurrency(() => executeComposedReview({ config: cfg, changedFiles: CODE_FILES,
      repository: 'acme/reviewer-fixture', headSha: 'a'.repeat(40), client: progress.instrument({ complete }), progress }));

    // Plan consumes one turn. The first cohort reserves two full ceilings (2+2) and uses 1+1;
    // after refund task-3 gets a full 2-turn slot and task-4 uses the final partial turn.
    expect(started).toEqual(['task-1', 'task-4', 'task-3', 'task-2']);
    expect(result.personas.map((lane) => lane.id)).toEqual(['task-1', 'task-4', 'task-3', 'task-2']);
    expect((result.personas ?? []).reduce((sum, lane) => sum + (lane.turnUsages?.length ?? 0), 0)).toBe(5);
    expect(result.unreportedLanes).toMatchObject([{ id: 'task-5', failureClass: 'budget_exhausted' }]);
    expect(events).toContainEqual(expect.objectContaining({ task: 'composed_task', lane: 'composed-task-5', status: 'skipped', rejectionCode: 'budget_exhausted' }));
  });

  it('does not give a waiting task a premature partial reservation before an earlier task refunds turns', async () => {
    const cfg: any = config();
    cfg.composed = { max_turns_total: 21, max_turns_per_task: 12 };
    let taskTwoTurns = 0;
    const complete = vi.fn(async (payload: any) => {
      const text = lastText(payload.messages);
      const nonce = issuedNonce(payload.messages);
      if (text.includes('PLAN TURN')) return fakeResponse(JSON.stringify({ nonce, tasks: manyTasks(2) }));
      const directive = payload.messages.find((message: any) =>
        typeof message.content === 'string' && message.content.includes('=== WORK TURN'))?.content ?? text;
      const taskId = directive.match(/Task id: (task-[0-9]+)/)?.[1];
      if (taskId === 'task-1') return responseForTask(payload, taskId);
      if (taskId !== 'task-2') throw new Error('unexpected task in starvation fixture');
      taskTwoTurns += 1;
      if (taskTwoTurns <= 9) {
        return fakeResponse(JSON.stringify({ tool: 'get_diff', args: { path: 'src/auth/guard.ts' } }));
      }
      return responseForTask(payload, taskId);
    });

    const result = await withMaxTaskConcurrency(() => executeComposedReview({ config: cfg, changedFiles: CODE_FILES,
      repository: 'acme/reviewer-fixture', headSha: 'a'.repeat(40), client: { complete } }));

    expect(taskTwoTurns).toBe(10); // Exceeds the 8 turns left after task-1's initial reservation.
    expect(result.personas.map((lane) => lane.id)).toEqual(['task-1', 'task-2']);
    expect(result.personas[1].turnsCount).toBe(10);
    expect(result.unreportedLanes).toEqual([]);
  });

  it('aborts and settles active siblings after a fatal task error without starting later tasks', async () => {
    const started = new Set<string>();
    const aborted = new Set<string>();
    let releaseAllStarted!: () => void;
    const startedBarrier = new Promise<void>((resolve) => { releaseAllStarted = resolve; });
    const complete = vi.fn(async (payload: any) => {
      const text = lastText(payload.messages);
      const nonce = issuedNonce(payload.messages);
      if (text.includes('PLAN TURN')) return fakeResponse(JSON.stringify({ nonce, tasks: manyTasks(4) }));
      const directive = payload.messages.find((message: any) =>
        typeof message.content === 'string' && message.content.includes('=== WORK TURN'))?.content ?? text;
      const taskId = directive.match(/Task id: (task-[0-9]+)/)?.[1];
      if (!taskId) throw new Error('missing task id in fatal fixture');
      started.add(taskId);
      if (started.size === 3) releaseAllStarted();
      if (taskId === 'task-1') {
        await startedBarrier;
        throw new Error('synthetic fatal task failure');
      }
      return new Promise<OpenRouterResponse>((_resolve, reject) => {
        if (payload.signal?.aborted) {
          aborted.add(taskId);
          reject(payload.signal.reason ?? new Error('aborted'));
          return;
        }
        payload.signal?.addEventListener('abort', () => {
          aborted.add(taskId);
          reject(payload.signal.reason ?? new Error('aborted'));
        }, { once: true });
      });
    });

    await withMaxTaskConcurrency(() => expect(executeComposedReview({ config: config(), changedFiles: CODE_FILES,
      repository: 'acme/reviewer-fixture', headSha: 'a'.repeat(40), client: { complete } }))
      .rejects.toThrow('synthetic fatal task failure'));

    expect(started).toEqual(new Set(['task-1', 'task-4', 'task-3']));
    expect(aborted).toEqual(new Set(['task-4', 'task-3']));
    expect(complete).toHaveBeenCalledTimes(4); // one plan request plus the three-task first cohort
  });

  function issuedNonce(messages: any[]): string {
    const text = messages.map((message) => {
      if (typeof message?.content === 'string') return message.content;
      if (Array.isArray(message?.content)) return message.content.map((block: any) => block.text || '').join('\n');
      return '';
    }).join('\n');
    const matches = [...text.matchAll(/CT_REVIEW_NONCE:([a-f0-9-]+)/g)];
    return matches.length ? matches[matches.length - 1][1] : 'nonce';
  }

  function routedClient(decide: (taskId: string, text: string, nonce: string) => string) {
    const workTurns: string[] = [];
    const complete = vi.fn(async (payload: any) => {
      const text = lastText(payload.messages);
      const nonce = issuedNonce(payload.messages);
      if (text.includes('PLAN TURN') || text.includes('PLAN_CORRECTION')) {
        return fakeResponse(JSON.stringify({ nonce, tasks: threeTasks() }));
      }
      if (text.includes('WORK TURN') || text.includes('TASK_FINALIZATION')) {
        const workDirective = payload.messages.find((message: any) =>
          typeof message.content === 'string' && message.content.includes('=== WORK TURN'))?.content ?? text;
        const taskId = threeTasks().find((task) => workDirective.includes(`Task id: ${task.id}`))?.id;
        if (!taskId) throw new Error(`work turn named no task: ${text.slice(0, 120)}`);
        workTurns.push(taskId);
        return fakeResponse(decide(taskId, text, nonce));
      }
      throw new Error(`unexpected turn: ${text.slice(0, 80)}`);
    });
    return { complete, workTurns };
  }

  it('dispatches every funded task branch concurrently', async () => {
    let activeWorkCalls = 0;
    let maxActiveWorkCalls = 0;
    let releaseWork!: () => void;
    const allWorkStarted = new Promise<void>((resolve) => { releaseWork = resolve; });
    const complete = vi.fn(async (payload: any) => {
      const text = lastText(payload.messages);
      const nonce = issuedNonce(payload.messages);
      if (text.includes('PLAN TURN')) {
        return fakeResponse(JSON.stringify({ nonce, tasks: threeTasks() }));
      }
      const taskId = threeTasks().find((task) => payload.messages.some((message: any) =>
        typeof message.content === 'string' && message.content.includes(`Task id: ${task.id}`)))?.id;
      if (!taskId) throw new Error(`work turn named no task: ${text.slice(0, 120)}`);
      activeWorkCalls += 1;
      maxActiveWorkCalls = Math.max(maxActiveWorkCalls, activeWorkCalls);
      if (activeWorkCalls === threeTasks().length) releaseWork();
      await allWorkStarted;
      activeWorkCalls -= 1;
      return fakeResponse(JSON.stringify({ nonce, task: taskId, status: 'COMPLETE', findings: [] }));
    });
    const cfg: any = config();
    cfg.composed = { max_turns_total: 4, max_turns_per_task: 1 };

    const result = await executeComposedReview({
      config: cfg,
      changedFiles: CODE_FILES,
      repository: 'exampleorg/example-meta',
      headSha: 'a'.repeat(40),
      client: { complete },
    });

    expect(maxActiveWorkCalls).toBe(3);
    expect(result.personas.map((lane) => lane.id)).toEqual(['task-1', 'task-3', 'task-2']);
  });

  it('bounds larger plans to three concurrent provider branches', async () => {
    let activeWorkCalls = 0;
    let maxActiveWorkCalls = 0;
    let releaseFirstWave!: () => void;
    const firstWaveStarted = new Promise<void>((resolve) => { releaseFirstWave = resolve; });
    const tasks = fourTasks();
    const complete = vi.fn(async (payload: any) => {
      const text = lastText(payload.messages);
      const nonce = issuedNonce(payload.messages);
      if (text.includes('PLAN TURN')) {
        return fakeResponse(JSON.stringify({ nonce, tasks }));
      }
      const taskId = tasks.find((task) => payload.messages.some((message: any) =>
        typeof message.content === 'string' && message.content.includes(`Task id: ${task.id}`)))?.id;
      if (!taskId) throw new Error(`work turn named no task: ${text.slice(0, 120)}`);
      activeWorkCalls += 1;
      maxActiveWorkCalls = Math.max(maxActiveWorkCalls, activeWorkCalls);
      if (activeWorkCalls === COMPOSED_TASK_CONCURRENCY_CEILING) releaseFirstWave();
      await firstWaveStarted;
      activeWorkCalls -= 1;
      return fakeResponse(JSON.stringify({ nonce, task: taskId, status: 'COMPLETE', findings: [] }));
    });
    const cfg: any = config();
    cfg.composed = { max_tasks: 4, max_turns_total: 5, max_turns_per_task: 1 };

    const result = await executeComposedReview({
      config: cfg,
      changedFiles: CODE_FILES,
      repository: 'exampleorg/example-meta',
      headSha: 'a'.repeat(40),
      client: { complete },
    });

    expect(maxActiveWorkCalls).toBe(COMPOSED_TASK_CONCURRENCY_CEILING);
    expect(result.personas.map((lane) => lane.id)).toEqual(['task-1', 'task-4', 'task-3', 'task-2']);
  });

  it('keeps later lanes running when a middle task produces no verdict', async () => {
    const { complete, workTurns } = routedClient((taskId, _text, nonce) => {
      if (taskId === 'task-2') return 'not a verdict';
      return JSON.stringify({ nonce, task: taskId, status: 'COMPLETE', findings: [] });
    });
    const cfg: any = config();
    cfg.composed = { max_turns_per_task: 1 };

    const result = await executeComposedReview({
      config: cfg,
      changedFiles: CODE_FILES,
      repository: 'exampleorg/example-meta',
      headSha: 'a'.repeat(40),
      client: { complete },
    });

    expect(workTurns).toEqual(['task-1', 'task-3', 'task-2']);
    expect(result.personas.map((lane) => lane.id).sort()).toEqual(['task-1', 'task-3']);
    expect(result.personas.every((lane) => lane.decision === 'APPROVE')).toBe(true);
    expect(result.optionalFailures ?? []).toEqual([]);
    expect(result.unreportedLanes?.[0]).toMatchObject({
      id: 'task-2',
      failureClass: 'malformed_output',
    });
    expect(result.unreportedLanes?.[0]?.error).toContain('ran and produced no verdict');
    const published = projectPublishingRosterBounds(result);
    expect(published.returnedIds).not.toContain('task-2');
    expect(result.applicablePersonaIds).toContain('task-2');
  });

  it('preserves completed and later tasks when a middle task exhausts its fresh contract recovery', async () => {
    const { complete, workTurns } = routedClient((taskId, _text, nonce) => taskId === 'task-3'
      ? 'SYNTHETIC_REASONING_WITHOUT_VERDICT'
      : JSON.stringify({ nonce, task: taskId, status: 'COMPLETE', findings: [] }));
    const cfg = config();
    cfg.composed = { max_turns_total: 6, max_turns_per_task: 4 };
    const result = await executeComposedReview({ config: cfg, changedFiles: CODE_FILES,
      repository: 'acme/reviewer-fixture', headSha: 'a'.repeat(40), client: { complete } });
    // Task 1 uses only one of its reserved turns, which is refunded before task 2 starts.
    // Task 2 can therefore use its full dynamic ceiling and remains bounded by the total cap.
    expect([...workTurns].sort()).toEqual(['task-1', 'task-2', 'task-3', 'task-3', 'task-3']);
    expect(result.personas.map((lane) => lane.id)).toEqual(['task-1', 'task-2']);
    expect(result.unreportedLanes).toMatchObject([{ id: 'task-3', failureClass: 'malformed_output',
      error: expect.stringContaining('non_json_task_result') }]);
    expect(projectPublishingRosterBounds(result).returnedIds).toEqual(['task-1', 'task-2']);
    expect(complete).toHaveBeenCalledTimes(6);
  });

  it('fails closed when every planned task produces no verdict', async () => {
    const { complete, workTurns } = routedClient(() => 'not a verdict');
    const cfg: any = config();
    cfg.composed = { max_turns_per_task: 1 };

    const result = await executeComposedReview({
      config: cfg,
      changedFiles: CODE_FILES,
      repository: 'exampleorg/example-meta',
      headSha: 'a'.repeat(40),
      client: { complete },
    });

    expect(workTurns).toEqual(['task-1', 'task-3', 'task-2']);
    expect(result.personas).toEqual([]);
    expect(result.optionalFailures ?? []).toEqual([]);
    expect((result.unreportedLanes ?? []).map((lane) => lane.failureClass)).toEqual([
      'malformed_output', 'malformed_output', 'malformed_output',
    ]);
    expect(projectPublishingRosterBounds(result).returnedIds).toEqual([]);
  });

  it('settles the tasks that never start once the turn budget is spent', async () => {
    const { complete, workTurns } = routedClient((taskId, _text, nonce) => (
      JSON.stringify({ nonce, task: taskId, status: 'COMPLETE', findings: [] })
    ));
    const cfg: any = config();
    cfg.composed = { max_turns_total: 2, max_turns_per_task: 1 };

    const result = await executeComposedReview({
      config: cfg,
      changedFiles: CODE_FILES,
      repository: 'exampleorg/example-meta',
      headSha: 'a'.repeat(40),
      client: { complete },
    });

    expect(workTurns).toEqual(['task-1']);
    expect(result.personas.map((lane) => lane.id)).toEqual(['task-1']);
    expect(result.optionalFailures ?? []).toEqual([]);
    expect((result.unreportedLanes ?? []).map((lane) => lane.id).sort()).toEqual(['task-2', 'task-3']);
    expect((result.unreportedLanes ?? []).every((lane) => lane.failureClass === 'budget_exhausted')).toBe(true);
    expect((result.unreportedLanes ?? []).every((lane) => lane.error.includes('did not start'))).toBe(true);
    expect(projectPublishingRosterBounds(result).returnedIds).toEqual(['task-1']);
  });

  it('advertises fleet MCP tools in the composed engine system prompt', async () => {
    let capturedSystemPrompt = '';
    const complete = vi.fn(async (payload: any) => {
      capturedSystemPrompt = payload.messages[0]?.content || '';
      const text = lastText(payload.messages);
      const nonce = issuedNonce(payload.messages);
      if (text.includes('PLAN TURN')) {
        return fakeResponse(JSON.stringify({ nonce, tasks: threeTasks() }));
      }
      return fakeResponse(JSON.stringify({ nonce, task: 'task-1', status: 'COMPLETE', findings: [] }));
    });

    const cfg: any = config();
    cfg.composed = { max_turns_total: 2, max_turns_per_task: 1 };

    await executeComposedReview({
      config: cfg,
      changedFiles: CODE_FILES,
      repository: 'exampleorg/example-meta',
      headSha: 'a'.repeat(40),
      client: { complete },
    });

    expect(capturedSystemPrompt).toContain('Fleet MCP (ct-mcp): ct_impact, ct_mesh_query, ct_mesh_stats, knowledge_search, knowledge_get, advise_blocker, health');
  });

  it('executes a fleet MCP tool request during composed review and injects scoped tool result', async () => {
    const execSpy = vi.spyOn(mcpFleetManager, 'executeTool').mockResolvedValue({
      success: true,
      output: { blast_radius: 'LOW', affected_files: ['src/auth/guard.ts'] },
      durationMs: 12,
    });

    let toolResultSeen = false;
    let turn = 0;
    const complete = vi.fn(async (payload: any) => {
      turn++;
      const text = lastText(payload.messages);
      const nonce = issuedNonce(payload.messages);

      if (turn === 1) {
        // Model asks to run ct_impact during plan phase
        return fakeResponse(JSON.stringify({ tool: 'ct_impact', args: { target: 'routes' } }));
      }
      if (turn === 2) {
        expect(text).toContain('[PI_TOOL_RESULT]');
        expect(text).toContain('[SCOPE: cross-repository-ast-mesh | EXHAUSTIVE: false]');
        toolResultSeen = true;
        return fakeResponse(JSON.stringify({ nonce, tasks: threeTasks() }));
      }
      // Work turns
      const taskId = threeTasks().find((task) => text.includes(task.id))?.id || 'task-1';
      return fakeResponse(JSON.stringify({ nonce, task: taskId, status: 'COMPLETE', findings: [] }));
    });

    const cfg: any = config();
    cfg.composed = { max_turns_total: 5, max_turns_per_task: 1 };

    try {
      const result = await executeComposedReview({
        config: cfg,
        changedFiles: CODE_FILES,
        repository: 'exampleorg/example-meta',
        headSha: 'a'.repeat(40),
        client: { complete },
      });

      expect(toolResultSeen).toBe(true);
      expect(result.personas.length).toBeGreaterThan(0);
    } finally {
      execSpy.mockRestore();
    }
  });

  describe('resolveComposedEngineMaxFindings', () => {
    it('defaults to 25 when unconfigured', () => {
      expect(resolveComposedEngineMaxFindings({ NODE_ENV: 'test' }, undefined)).toBe(25);
    });

    it('honours configured max_findings_total narrowed by policy', () => {
      expect(resolveComposedEngineMaxFindings({ NODE_ENV: 'test' }, 10)).toBe(10);
      expect(resolveComposedEngineMaxFindings({ NODE_ENV: 'test' }, 50)).toBe(50);
    });

    it('honours operator env overrides bounded by hard cap', () => {
      expect(resolveComposedEngineMaxFindings({ NODE_ENV: 'test', COMPOSED_ENGINE_MAX_FINDINGS: '15' }, 50)).toBe(15);
      expect(resolveComposedEngineMaxFindings({ NODE_ENV: 'test', REVIEW_YETI_MAX_FINDINGS: '30' }, undefined)).toBe(30);
      expect(resolveComposedEngineMaxFindings({ NODE_ENV: 'test', COMPOSED_ENGINE_MAX_FINDINGS: '9999' }, undefined)).toBe(500);
    });
  });

  describe('isBypassDiffOnlyPath', () => {
    it('identifies lockfiles as bypass paths', () => {
      expect(isBypassDiffOnlyPath('package-lock.json')).toBe(true);
      expect(isBypassDiffOnlyPath('mix.lock')).toBe(true);
      expect(isBypassDiffOnlyPath('yarn.lock')).toBe(true);
      expect(isBypassDiffOnlyPath('pnpm-lock.yaml')).toBe(true);
      expect(isBypassDiffOnlyPath('sub/dir/cargo.lock')).toBe(true);
      expect(isBypassDiffOnlyPath('go.sum')).toBe(true);
    });

    it('identifies json data files as bypass paths while preserving package.json and tsconfig.json', () => {
      expect(isBypassDiffOnlyPath('data/fixtures.json')).toBe(true);
      expect(isBypassDiffOnlyPath('package.json')).toBe(false);
      expect(isBypassDiffOnlyPath('tsconfig.json')).toBe(false);
    });

    it('does not classify source code as bypass', () => {
      expect(isBypassDiffOnlyPath('src/auth/guard.ts')).toBe(false);
      expect(isBypassDiffOnlyPath('lib/cdrcisco/telemetry.ex')).toBe(false);
    });
  });

  it('stops at the findings threshold without approving unfinished tasks', async () => {
    const started: string[] = [];
    const completedTasks: string[] = [];
    const complete = vi.fn(async (payload: any) => {
      const text = lastText(payload.messages);
      const nonce = issuedNonce(payload.messages);
      if (text.includes('PLAN TURN')) return fakeResponse(JSON.stringify({ nonce, tasks: manyTasks(6) }));
      const directive = payload.messages.find((message: any) =>
        typeof message.content === 'string' && message.content.includes('=== WORK TURN'))?.content ?? text;
      const taskId = directive.match(/Task id: (task-[0-9]+)/)?.[1];
      if (!taskId) throw new Error(`missing task id in work directive: ${directive.slice(0, 100)}`);
      started.push(taskId);

      // Task 1 returns 25 findings
      if (taskId === 'task-1') {
        const findings = Array.from({ length: 25 }, (_, i) => ({
          title: `Finding ${i + 1}`,
          severity: 'P1',
          path: 'src/auth/guard.ts',
          line: 1,
          startLine: null,
          body: `Critical issue ${i + 1}`,
          suggestion: null,
          replacementCode: null,
        }));
        completedTasks.push(taskId);
        return fakeResponse(JSON.stringify({ nonce, task: taskId, status: 'COMPLETE', findings }));
      }

      // Other tasks take longer or return clean
      await new Promise((resolve) => setTimeout(resolve, 50));
      completedTasks.push(taskId);
      return responseForTask(payload, taskId);
    });

    const result = await withMaxTaskConcurrency(() => executeComposedReview({
      config: config(),
      changedFiles: CODE_FILES,
      repository: 'acme/reviewer-fixture',
      headSha: 'a'.repeat(40),
      client: { complete },
    }));

    // Finding-stop is not evidence that any other planned task was reviewed.
    expect(result.quorum.satisfied).toBe(false);
    expect(result.personas).toHaveLength(1);
    expect(result.unreportedLanes).toHaveLength(5);
    expect(result.arbiter.verdict).toBe('BLOCK');
    expect(result.arbiter.rationale).toContain('Max review findings limit (25) reached');

    // Task 1 should have its 25 findings
    const task1Persona = result.personas.find((p) => p.id === 'task-1');
    expect(task1Persona?.findings).toHaveLength(25);
    expect(task1Persona?.decision).toBe('FINDINGS');

    // Downstream canonical arbitration should compute BLOCK
    const arbitration = computeArbitration(result.personas, result.applicablePersonaIds!.length, {
      changedFiles: CODE_FILES,
      coverageComplete: true,
      panelSize: 1,
    });
    expect(arbitration.verdict).toBe('BLOCK');
  });

  describe('buildTaskScopedFiles and buildTaskScopedPrefix', () => {
    const multiFiles = [
      { path: 'src/auth/guard.ts', patch: '@@ -1,1 +1,2 @@\n+export function guard() {}' },
      { path: 'src/db/migrate.ts', patch: '@@ -1,1 +1,2 @@\n+export function migrate() {}' },
      { path: 'src/ui/button.tsx', patch: '@@ -1,1 +1,2 @@\n+export function Button() {}' },
    ];

    it('scopes effective files strictly to task paths when paths match', () => {
      const task = { id: 'task-auth', dimension: 'security' as const, paths: ['src/auth/guard.ts'], question: 'Auth safe?', rationale: 'Auth.' };
      const scoped = buildTaskScopedFiles(task, multiFiles);
      expect(scoped).toEqual([multiFiles[0]]);
    });

    it('falls back to all effective files when task paths are unassigned or empty', () => {
      const task = { id: 'task-arch', dimension: 'architecture' as const, paths: [], question: 'Overall arch?', rationale: 'Arch.' };
      const scoped = buildTaskScopedFiles(task, multiFiles);
      expect(scoped).toEqual(multiFiles);
    });

    it('builds a scoped prefix containing only assigned file diffs and sets task scope header', () => {
      const task = { id: 'task-auth', dimension: 'security' as const, paths: ['src/auth/guard.ts'], question: 'Auth safe?', rationale: 'Auth.' };
      const prefix = buildTaskScopedPrefix({
        task,
        effectiveFiles: multiFiles,
        domainLanes: { 'src/auth/guard.ts': 'security_auth', 'src/db/migrate.ts': 'data_persistence', 'src/ui/button.tsx': 'ui_frontend' },
        repository: 'acme/test-repo',
        headSha: 'abc1234',
        repositoryVisibility: 'PUBLIC',
        rules: ['Rule 1'],
        preCheckEvidence: {},
      });

      expect(prefix).toContain('WORK CONTEXT: ASSIGNED TASK (1 path(s))');
      expect(prefix).toContain('TASK-ASSIGNED CHANGED FILES INDEX (1 file(s))');
      expect(prefix).toContain('"src/auth/guard.ts"');
      expect(prefix).toContain('export function guard()');
      expect(prefix).not.toContain('export function migrate()');
      expect(prefix).not.toContain('export function Button()');
    });

    it('recovers an assigned contract omitted by global planner packing without including unrelated files', () => {
      const prefix = buildTaskScopedPrefix({
        task: { id: 'task-auth', dimension: 'security', paths: ['src/auth/guard.ts'], question: 'Auth safe?', rationale: 'Auth.' },
        effectiveFiles: [multiFiles[2]], originalFiles: multiFiles,
        domainLanes: { 'src/auth/guard.ts': 'security_auth' }, repository: 'acme/test-repo',
        headSha: 'abc1234', repositoryVisibility: 'PUBLIC', rules: [], preCheckEvidence: {},
      });
      expect(prefix).toContain('export function guard()');
      expect(prefix).not.toContain('export function Button()');
      expect(prefix).not.toContain('export function migrate()');
    });
  });

  it('isolates subagent swarm context so tasks only receive diffs for their assigned paths', async () => {
    const multiFiles = [
      { path: 'src/auth/guard.ts', patch: '@@ -1,1 +1,2 @@\n+export function guard() {}' },
      { path: 'src/db/migrate.ts', patch: '@@ -1,1 +1,2 @@\n+export function migrate() {}' },
    ];
    const taskAuthMessages: any[] = [];
    const taskDbMessages: any[] = [];

    const complete = vi.fn(async (payload: any) => {
      const nonce = issuedNonce(payload.messages);
      const text = lastText(payload.messages);
      if (text.includes('PLAN TURN')) {
        return fakeResponse(JSON.stringify({
          nonce,
          tasks: [
            { id: 'task-auth', dimension: 'security', paths: ['src/auth/guard.ts'], question: 'Auth safe?', rationale: 'Auth.' },
            { id: 'task-db', dimension: 'architecture', paths: ['src/db/migrate.ts'], question: 'DB safe?', rationale: 'DB.' },
          ],
        }));
      }

      if (text.includes('Task id: task-auth')) {
        taskAuthMessages.push(...payload.messages);
        return fakeResponse(JSON.stringify({ nonce, task: 'task-auth', status: 'COMPLETE', findings: [] }));
      }
      if (text.includes('Task id: task-db')) {
        taskDbMessages.push(...payload.messages);
        return fakeResponse(JSON.stringify({ nonce, task: 'task-db', status: 'COMPLETE', findings: [] }));
      }

      return fakeResponse(JSON.stringify({ nonce, task: 'unknown', status: 'COMPLETE', findings: [] }));
    });

    const result = await executeComposedReview({
      config: config(),
      changedFiles: multiFiles,
      repository: 'acme/reviewer-fixture',
      headSha: 'a'.repeat(40),
      client: { complete },
    });

    expect(result.personas).toHaveLength(2);
    expect(result.personas.map((p) => p.decision)).toEqual(['APPROVE', 'APPROVE']);

    // Verify task-auth only received guard.ts diff and NOT migrate.ts diff
    const authTranscript = JSON.stringify(taskAuthMessages);
    expect(authTranscript).toContain('export function guard()');
    expect(authTranscript).not.toContain('export function migrate()');

    // Verify task-db only received migrate.ts diff and NOT guard.ts diff
    const dbTranscript = JSON.stringify(taskDbMessages);
    expect(dbTranscript).toContain('export function migrate()');
    expect(dbTranscript).not.toContain('export function guard()');
  });

  it('finalizes review early and blocks immediately when a P0 blocker finding is found', async () => {
    let taskAuthExecuted = false;
    let taskDbExecuted = false;

    const multiFiles = [
      { path: 'src/auth/guard.ts', patch: '@@ -1,1 +1,2 @@\n+export function guard() { return true; }' },
      { path: 'src/db/migrate.ts', patch: '@@ -1,1 +1,2 @@\n+export function migrate() { return true; }' },
    ];

    const complete = vi.fn(async (payload: any) => {
      const nonce = issuedNonce(payload.messages);
      const text = lastText(payload.messages);
      if (text.includes('PLAN TURN')) {
        return fakeResponse(JSON.stringify({
          nonce,
          tasks: [
            { id: 'task-auth', dimension: 'security', paths: ['src/auth/guard.ts'], question: 'Auth safe?', rationale: 'Auth.' },
            { id: 'task-db', dimension: 'architecture', paths: ['src/db/migrate.ts'], question: 'DB safe?', rationale: 'DB.' },
          ],
        }));
      }

      if (text.includes('Task id: task-auth')) {
        taskAuthExecuted = true;
        return fakeResponse(JSON.stringify({
          nonce,
          task: 'task-auth',
          status: 'COMPLETE',
          findings: [
            {
              path: 'src/auth/guard.ts',
              line: 1,
              severity: 'P0',
              title: 'Critical bypass',
              body: 'Authentication check is unconditionally bypassed.',
            },
          ],
        }));
      }

      if (text.includes('Task id: task-db')) {
        taskDbExecuted = true;
        return fakeResponse(JSON.stringify({ nonce, task: 'task-db', status: 'COMPLETE', findings: [] }));
      }

      return fakeResponse(JSON.stringify({ nonce, task: 'unknown', status: 'COMPLETE', findings: [] }));
    });

    const result = await executeComposedReview({
      config: config(),
      changedFiles: multiFiles,
      repository: 'acme/reviewer-fixture',
      headSha: 'a'.repeat(40),
      client: { complete },
    });

    expect(taskAuthExecuted).toBe(true);
    expect(taskDbExecuted).toBe(false);
    expect(result.quorum.satisfied).toBe(false);
    expect(result.personas).toHaveLength(1);
    expect(result.unreportedLanes).toMatchObject([{ id: 'task-db', failureClass: 'contract' }]);

    const taskAuthPersona = result.personas.find((p) => p.id === 'task-auth');
    expect(taskAuthPersona?.decision).toBe('FINDINGS');
    expect(taskAuthPersona?.findings).toHaveLength(1);
    expect(taskAuthPersona?.findings[0].severity).toBe('P0');

    // Downstream canonical arbitration must compute BLOCK
    const arbitration = computeArbitration(result.personas, result.applicablePersonaIds!.length, {
      changedFiles: CODE_FILES,
      coverageComplete: true,
      panelSize: 1,
    });
    expect(arbitration.verdict).toBe('BLOCK');
  });

  it('settles funded siblings, retains real outcomes across a plan-order gap, and records known usage once at finding-stop', async () => {
    initTelemetry('review-yeti-bot');
    clearSpans();
    const tasks = orderReviewTasksByRisk(manyTasks(6));
    const started: string[] = [];
    const cancelled: string[] = [];
    const events: Array<Record<string, unknown>> = [];
    const captures: any[] = [];
    let releaseFinding!: () => void;
    const completedSibling = new Promise<void>((resolve) => { releaseFinding = resolve; });
    let releasePaidTurn!: () => void;
    const paidTurnStarted = new Promise<void>((resolve) => { releasePaidTurn = resolve; });
    const progress = createPublishingProgress({ runId: 'run-findings-stop-usage', executionAttempt: 1 }, {
      sink: (event) => {
        events.push(event);
        if (event.task === 'composed_task' && event.status === 'completed' && event.lane === 'composed-task-2') releaseFinding();
      },
    });
    let firstTaskTurns = 0;
    const complete = vi.fn(async (payload: any) => {
      const text = lastText(payload.messages);
      const nonce = issuedNonce(payload.messages);
      if (text.includes('PLAN TURN')) return fakeResponse(JSON.stringify({ nonce, tasks }));
      const directive = payload.messages.find((message: any) => typeof message.content === 'string' && message.content.includes('=== WORK TURN'))?.content;
      const taskId = tasks.find((task) => directive?.includes(`Task id: ${task.id}\n`))?.id;
      if (!taskId) throw new Error('Missing task in finding-stop fixture');
      if (!started.includes(taskId)) started.push(taskId);
      if (taskId === tasks[0].id) {
        if (++firstTaskTurns === 1) return fakeResponse(JSON.stringify({ tool: 'get_diff', args: { path: 'src/auth/guard.ts' } }));
        releasePaidTurn();
        return new Promise<OpenRouterResponse>((_resolve, reject) => {
          payload.signal.addEventListener('abort', () => { cancelled.push(taskId); reject(payload.signal.reason); }, { once: true });
        });
      }
      await paidTurnStarted;
      if (taskId === tasks[1].id) return responseForTask(payload, taskId);
      if (taskId !== tasks[2].id) throw new Error('Finding-stop dispatched an unfunded tail task');
      await completedSibling;
      return fakeResponse(JSON.stringify({ nonce, task: taskId, status: 'COMPLETE', findings: Array.from({ length: 25 }, (_, index) => ({
        severity: 'P2', path: 'src/auth/guard.ts', line: 1, title: `Advisory ${index}`, body: `Local fixture ${index}.`,
      })) }));
    });
    const ledger = new TokenLedger();
    const cfg = config();
    cfg.composed = { max_turns_total: 7, max_turns_per_task: 2 };
    const result = await withMaxTaskConcurrency(() => executeComposedReview({ config: cfg, changedFiles: CODE_FILES,
      repository: 'acme/reviewer-fixture', headSha: 'a'.repeat(40), progress,
      client: meterModelClient(progress.instrument({ complete }), ledger),
      checkpoint: { resumed: null, capture: (snapshot) => captures.push(structuredClone(snapshot)), save: async () => {} },
    }));
    expect(started).toEqual(tasks.slice(0, 3).map((task) => task.id));
    expect(cancelled).toEqual([tasks[0].id]);
    expect(complete).toHaveBeenCalledTimes(5); // Plan + tool + cancelled in-flight call + two real task results.
    expect(result.personas.map((lane) => lane.id)).toEqual(tasks.slice(1, 3).map((task) => task.id));
    expect(result.personas.map((lane) => lane.turnsCount)).toEqual([1, 1]);
    expect(result.personas.reduce((sum, lane) => sum + (lane.turnUsages?.length ?? 0), 0)).toBe(3); // Includes plan exactly once.
    expect(result.personas.reduce((sum, lane) => sum + (lane.aggregateUsage?.totalTokens ?? 0), 0)).toBe(60);
    expect(result.unreportedLanes?.map((lane) => lane.id)).toEqual([tasks[0].id, ...tasks.slice(3).map((task) => task.id)]);
    expect(result.quorum.satisfied).toBe(false);
    expect(events.filter((event) => event.task === 'composed_task' && event.status === 'completed').map((event) => event.lane))
      .toEqual(['composed-task-2', 'composed-task-3']);
    expect(events).toContainEqual(expect.objectContaining({ task: 'composed_task', lane: 'composed-task-1', status: 'aborted', turn: 1,
      usage: expect.objectContaining({ totalTokens: 20 }) }));
    expect(events.filter((event) => event.task === 'composed_task' && event.status === 'skipped')).toHaveLength(3);
    expect(ledger.snapshot().total).toMatchObject({ calls: 4, totalTokens: 80, costUSD: 0.004 });
    expect(ledger.snapshot().byLane['composed-task-1']).toMatchObject({ calls: 1, totalTokens: 20 });
    expect(captures.at(-1).completedTasks.map((task: any) => task.id).sort()).toEqual(tasks.slice(1, 3).map((task) => task.id).sort());
    expect(captures.at(-1).plan).toHaveLength(6);
    const span = getRecentSpans({ name: 'review_yeti_composed_panel' }).at(-1);
    expect(span?.attributes).toMatchObject({ 'review_yeti.composed.funded_task_count': 3,
      'review_yeti.composed.observed_turn_count': 4, 'review_yeti.composed.retained_turn_reservations': 1 });
  });

  it.each(['cancel', 'deadline'] as const)('keeps parent %s authority when it races findings-stop closeout', async (mode) => {
    const cancellation = new AbortController();
    const cfg = config();
    const progress = createPublishingProgress({ runId: 'run-findings-stop-authority', executionAttempt: 1 }, {
      sink: (event) => {
        if (event.task === 'composed_task' && event.status === 'skipped') {
          cancellation.abort(mode === 'deadline' ? new panelEngine.PanelDeadlineExceededError(30_000) : new Error('private cancellation'));
        }
      },
    });
    const complete = vi.fn(async (payload: any) => {
      const nonce = issuedNonce(payload.messages);
      return fakeResponse(JSON.stringify(lastText(payload.messages).includes('PLAN TURN')
        ? { nonce, tasks: manyTasks(2) }
        : { nonce, task: 'task-1', status: 'COMPLETE', findings: [{ severity: 'P0', path: 'src/auth/guard.ts', line: 1,
          title: 'Finding-stop race', body: 'Local fixture.' }] }));
    });
    const run = executeComposedReview({ config: cfg, changedFiles: CODE_FILES, repository: 'acme/reviewer-fixture',
      headSha: 'a'.repeat(40), client: { complete }, signal: cancellation.signal, progress });
    if (mode === 'cancel') await expect(run).rejects.toBeInstanceOf(panelEngine.PanelCancellationError);
    else {
      const result = await run;
      expect(result.gracefulExit).toMatchObject({ reason: 'evidence_deadline', completedTaskIds: ['task-1'], pendingTaskIds: ['task-2'] });
      expect(result.personas).toHaveLength(1);
      expect(result.personas[0].findings).toHaveLength(1);
      expect(result.quorum.satisfied).toBe(false);
    }
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it.each(['P0', 'P2'] as const)('keeps genuine all-tasks-complete evidence at %s finding-stop', async (severity) => {
    const complete = vi.fn(async (payload: any) => {
      const nonce = issuedNonce(payload.messages);
      return fakeResponse(JSON.stringify(lastText(payload.messages).includes('PLAN TURN')
        ? { nonce, tasks: [exhaustionTask] }
        : { nonce, task: exhaustionTask.id, status: 'COMPLETE', findings: Array.from({ length: severity === 'P2' ? 25 : 1 }, (_, index) => ({
          severity, path: 'src/auth/guard.ts', line: 1, title: `Finding ${index}`, body: `Local fixture ${index}.`,
        })) }));
    });
    const result = await executeComposedReview({ config: config(), changedFiles: CODE_FILES, repository: 'acme/reviewer-fixture',
      headSha: 'a'.repeat(40), client: { complete } });
    expect(result.quorum.satisfied).toBe(true);
    expect(result.unreportedLanes).toEqual([]);
    expect(result.personas).toMatchObject([{ id: exhaustionTask.id, turnsCount: 1 }]);
    expect(result.personas[0].turnUsages).toHaveLength(2);
    expect(computeArbitration(result.personas, 1, { changedFiles: CODE_FILES, coverageComplete: true, panelSize: 1 }).verdict)
      .toBe(severity === 'P0' ? 'BLOCK' : 'SHIP');
  });
});
