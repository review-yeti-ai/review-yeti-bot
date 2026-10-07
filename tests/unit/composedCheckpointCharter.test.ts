import { describe, expect, it, vi } from 'vitest';

const analyzerFixture = vi.hoisted(() => ({ summary: undefined as unknown }));
vi.mock('../../src/sandbox/analyzerRunner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/sandbox/analyzerRunner')>();
  return { ...actual, runPreCheckAnalyzers: vi.fn(async (...args: Parameters<typeof actual.runPreCheckAnalyzers>) =>
    analyzerFixture.summary ?? actual.runPreCheckAnalyzers(...args)) };
});

import { executeComposedReview } from '../../src/panel/composedEngine';
import { parseAndValidateConfig } from '../../src/config/configLoader';
import { buildDeterministicCoverageManifest } from '../../src/review/groundedReviewEngine';
import { buildDeterministicReviewPlanningContext, enrichTasksWithPlanningContext,
  reviewTaskCharterDigest } from '../../src/review/prReviewPlanningContext';
import { TaskSourceDelivery } from '../../src/review/taskSourceDelivery';
import type { ReviewTask } from '../../src/panel/reviewTask';
import type { PreCheckSummary } from '../../src/sandbox/analyzerRunner';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const POLICY = 'c'.repeat(64);
const CONFIG = 'd'.repeat(64);
const changedFiles = [
  { path: 'src/auth/guard.ts', patch: '@@ -1 +1 @@\n-const guard = false;\n+export const guard = true;\n' },
  { path: 'src/format.ts', patch: '@@ -1 +1 @@\n-const format = false;\n+export const format = true;\n' },
];
const plannerPlan: ReviewTask[] = [
  { id: 'auth-task', dimension: 'security', paths: ['src/auth/guard.ts'],
    question: 'Inspect the authorization guard.', rationale: 'It protects a changed tenant boundary.' },
  { id: 'format-task', dimension: 'testing', paths: ['src/format.ts'],
    question: 'Inspect formatting behavior.', rationale: 'It changes a utility behavior.' },
];

function summary(hypotheses: PreCheckSummary['hypotheses']): PreCheckSummary {
  return { enabled: true, analyzersExecuted: 1, hypothesesCount: hypotheses.length, status: 'ok',
    receipts: [{ tool: 'semgrep', category: 'security', available: true, exitStatus: 0, durationMs: 1, hypotheses }],
    hypotheses };
}

function config() {
  const parsed = parseAndValidateConfig(`
version: 3
profile: balanced
quorum: 1
review_engine: composed
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
`);
  const value = parsed as any;
  value.pre_checks.zoekt.enabled = false;
  value.pre_checks.symbolAppendix.enabled = false;
  value.pre_checks.analyzers.enabled = true;
  value.composed = { max_tasks: 4, max_turns_total: 20 };
  return value;
}

function nonceFrom(messages: any[]): string {
  const text = messages.flatMap((message) => typeof message.content === 'string' ? [message.content]
    : Array.isArray(message.content) ? message.content.flatMap((block: any) => typeof block.text === 'string' ? [block.text] : []) : []).join('\n');
  return text.match(/CT_REVIEW_NONCE:([a-f0-9-]+)/u)?.[1] ?? 'nonce';
}

function fakeResponse(content: string) {
  return { model: 'fixture-model', content, usage: { prompt: 1, completion: 1, total: 2 }, costUSD: 0, raw: {} } as any;
}

describe('composed exact-head checkpoint task charter qualification', () => {
  it('re-runs only the task whose current analyzer hypothesis changed while reusing an unchanged qualified task', async () => {
    const finding = { id: 'hyp:semgrep:auth-bypass:src/auth/guard.ts:120', analyzer: 'semgrep', category: 'security' as const,
      ruleId: 'auth-bypass', path: 'src/auth/guard.ts', line: 120, message: 'Current auth binding can be bypassed.',
      severity: 'critical' as const, confidence: 'high' as const };
    const cleanSummary = summary([]);
    const currentSummary = summary([finding]);
    const baselineManifest = buildDeterministicReviewPlanningContext({ coverage: buildDeterministicCoverageManifest(changedFiles),
      changedFiles, analyzers: cleanSummary });
    const baselinePlan = enrichTasksWithPlanningContext(plannerPlan, baselineManifest);
    const currentManifest = buildDeterministicReviewPlanningContext({ coverage: buildDeterministicCoverageManifest(changedFiles),
      changedFiles, analyzers: currentSummary });
    const currentPlan = enrichTasksWithPlanningContext(plannerPlan, currentManifest);
    const currentDigests = new Map(currentPlan.tasks.map((task) => [task.id,
      reviewTaskCharterDigest(task, currentPlan.assignments)] as const));
    const priorCharters = new Map(baselinePlan.tasks.map((task) => [task.id,
      reviewTaskCharterDigest(task, baselinePlan.assignments)] as const));
    expect(currentDigests.get('auth-task')).not.toBe(priorCharters.get('auth-task'));
    expect(currentDigests.get('format-task')).toBe(priorCharters.get('format-task'));

    const runId = `run_${'1'.repeat(32)}`;
    const completedTasks = baselinePlan.tasks.map((task) => {
      const file = changedFiles.find((candidate) => candidate.path === task.paths[0])!;
      const delivery = new TaskSourceDelivery({ taskId: task.id, paths: task.paths, files: changedFiles,
        headSha: HEAD, baseSha: BASE, prefix: file.patch, inlinedPaths: task.paths })
        .acknowledgeRequest([{ role: 'user', content: file.patch }]);
      return { id: task.id, findings: [], charterDigest: priorCharters.get(task.id), sourceDelivery: delivery };
    });
    const checkpoint = { version: 'ReviewExecutionCheckpoint.v1' as const, runId, repositoryId: 123,
      owner: 'acme', repo: 'reviewer-fixture', prNumber: 42, headSha: HEAD, baseSha: BASE,
      policyDigest: POLICY, configDigest: CONFIG, executionAttempt: 2, revision: 4,
      plan: baselinePlan.tasks, plannerPlan, completedTasks };
    analyzerFixture.summary = currentSummary;
    const saved: any[] = [];
    const taskCalls: Array<{ id: string; text: string }> = [];
    const complete = vi.fn(async (request: any) => {
      const messages = request.messages;
      const text = messages.flatMap((message: any) => typeof message.content === 'string' ? [message.content]
        : Array.isArray(message.content) ? message.content.flatMap((block: any) => typeof block.text === 'string' ? [block.text] : []) : []).join('\n');
      const nonce = nonceFrom(messages);
      const taskId = text.match(/Task id: ([a-z-]+)/u)?.[1];
      if (taskId) {
        taskCalls.push({ id: taskId, text });
        return fakeResponse(JSON.stringify({ nonce, task: taskId, status: 'COMPLETE', findings: [] }));
      }
      if (text.includes('PLAN TURN')) throw new Error('A valid raw planner plan should resume without another plan call.');
      return fakeResponse(JSON.stringify({ nonce, verdict: 'SHIP', rationale: 'All current task charters were satisfied.' }));
    });

    try {
      await executeComposedReview({ config: config(), changedFiles, repository: 'acme/reviewer-fixture', headSha: HEAD,
        baseSha: BASE, client: { complete }, checkpoint: { resumed: checkpoint,
          save: async (snapshot) => { saved.push(structuredClone(snapshot)); } } });

      expect(taskCalls.map((call) => call.id)).toEqual(['auth-task']);
      expect(taskCalls[0]!.text).toContain('Current auth binding can be bypassed.');
      expect(saved.at(-1)?.completedTasks).toHaveLength(2);
      expect(complete).toHaveBeenCalledTimes(1); // only the changed auth task; the sibling is reused
    } finally {
      analyzerFixture.summary = undefined;
    }
  });
});
