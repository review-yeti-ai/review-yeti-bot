import { describe, expect, it, vi } from 'vitest';
import { executeComposedReview } from '../../src/panel/composedEngine';
import { parseAndValidateConfig } from '../../src/config/configLoader';
import { parseChangedFiles } from '../../src/review/changedFiles';
import { openFindingFrom } from '../../src/review/incrementalDelta';
import type { OpenRouterResponse } from '../../src/gateway/openRouterClient';
import type { IncrementalReviewScope } from '../../src/types/incrementalReview';

/**
 * ADR 0770: the composed engine's handling of a delta-scoped re-review.
 *
 * The invariant these tests pin: hunks are ledger items inside the tasks of the ONE plan turn. The
 * number of model calls is `1 plan turn + one call per planned task`, bounded by `deltaMaxTasks`,
 * and never a function of how many hunks or files the delta contains.
 */

const HEAD = 'a'.repeat(40);
const PREV_HEAD = '1'.repeat(40);

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

function config(maxTasks?: number) {
  const parsed = parseAndValidateConfig(mockYaml) as any;
  if (maxTasks !== undefined) parsed.composed = { ...(parsed.composed ?? {}), max_tasks: maxTasks };
  return parsed;
}

function nonceFrom(text: string): string {
  return text.match(/CT_REVIEW_NONCE:([a-f0-9-]+)/)?.[1] ?? 'nonce';
}

function allText(messages: any[]): string {
  return messages.map((message) => (typeof message?.content === 'string' ? message.content
    : Array.isArray(message?.content) ? message.content.map((block: any) => block.text || '').join('\n') : '')).join('\n');
}

function lastText(messages: any[]): string {
  const last = messages[messages.length - 1];
  if (typeof last?.content === 'string') return last.content;
  if (Array.isArray(last?.content)) return last.content.map((block: any) => block.text || '').join('\n');
  return '';
}

function fakeResponse(content: string): OpenRouterResponse {
  return { model: 'test-model', content, usage: { prompt: 10, completion: 10, total: 20 }, costUSD: 0.001, raw: {} };
}

function prFile(path: string): string {
  return [
    `diff --git a/${path} b/${path}`, 'index 1111111..2222222 100644', `--- a/${path}`, `+++ b/${path}`,
    '@@ -10,2 +10,2 @@', ' const keep = 0;', `-const OLD = 1;`, `+const NEW_${path.replace(/\W/gu, '_')} = 2;`,
  ].join('\n') + '\n';
}

const DIFF = prFile('src/a.ts') + prFile('src/b.ts') + prFile('src/open.ts');

function hunks(count: number): string {
  return Array.from({ length: count }, (_, i) => `@@ -${i * 10 + 1},1 +${i * 10 + 1},2 @@\n a\n+b${i}`).join('\n');
}

function scope(hunkCount: number, overrides: Partial<IncrementalReviewScope> = {}): IncrementalReviewScope {
  return {
    previous: { runId: `run_${'9'.repeat(32)}`, executionAttempt: 1, headSha: PREV_HEAD, baseSha: '2'.repeat(40), completionDigest: 'e'.repeat(64) },
    carriedForwardPaths: [],
    openFindingPaths: ['src/open.ts'],
    deltaFiles: [
      { path: 'src/a.ts', patch: hunks(hunkCount), hunks: hunkCount },
      { path: 'src/b.ts', patch: hunks(hunkCount), hunks: hunkCount },
    ],
    openFindings: [openFindingFrom({ path: 'src/open.ts', line: 11, severity: 'P2', title: 'Open defect' })],
    chainDepth: 1,
    previousTaskCount: 5,
    ...overrides,
  };
}

const PLAN = [
  { id: 'logic-a', dimension: 'security', paths: ['src/a.ts', 'src/b.ts'], question: 'Does the change hold?', rationale: 'Delta files.' },
  { id: 'open-finding', dimension: 'testing', paths: ['src/open.ts'], question: 'Is the prior finding fixed?', rationale: 'Open finding file.' },
];

/** A scripted model: plans PLAN, and answers each task with a ledger built from the items it was assigned. */
function scriptedClient(options: { omitLedgerFor?: string; claimFinding?: boolean } = {}) {
  const calls: string[] = [];
  const prompts: string[] = [];
  const omitted = new Set<string>();
  const complete = vi.fn(async (payload: any) => {
    const text = lastText(payload.messages);
    prompts.push(text);
    const nonce = nonceFrom(text);
    if (text.includes('=== PLAN TURN ===')) {
      calls.push('plan');
      return fakeResponse(JSON.stringify({ nonce, tasks: PLAN }));
    }
    const conversation = allText(payload.messages);
    const task = [...conversation.matchAll(/Task id: (\S+)/gu)].at(-1)?.[1] ?? 'unknown';
    calls.push(`task:${task}`);
    const items = [...new Set([...conversation.matchAll(/^- ((?:prior|delta):\S+?): /gmu)].map((match) => match[1]))];
    const ledger = items.map((item) => ({
      item, outcome: item.startsWith('prior:') ? 'resolved' : 'clean', note: 'checked',
    }));
    const includeLedger = !(options.omitLedgerFor === task && !omitted.has(task) && (omitted.add(task), true));
    return fakeResponse(JSON.stringify({
      nonce, task, status: 'COMPLETE', blockedReason: null, findings: [],
      ...(includeLedger && items.length > 0 ? { ledger } : {}),
    }));
  });
  return { complete, calls, prompts };
}

async function review(client: { complete: any }, incremental?: IncrementalReviewScope, maxTasks?: number) {
  return executeComposedReview({
    config: config(maxTasks), changedFiles: parseChangedFiles(DIFF).files as never, repository: 'acme/reviewer-fixture',
    headSha: HEAD, client: client as never, ...(incremental ? { incremental } : {}),
  });
}

describe('composed engine: delta re-review', () => {
  it('makes one plan call plus one call per planned task, whatever the number of hunks', async () => {
    const counts: number[] = [];
    for (const hunkCount of [1, 10, 100, 300]) {
      const client = scriptedClient();
      const result = await review(client, scope(hunkCount));
      expect(result.incremental?.deltaPaths).toEqual(['src/a.ts', 'src/b.ts']);
      expect(result.incremental?.deltaHunkCount).toBe(hunkCount * 2);
      expect(client.calls).toEqual(['plan', 'task:logic-a', 'task:open-finding']);
      counts.push(client.complete.mock.calls.length);
    }
    expect(new Set(counts)).toEqual(new Set([3]));
  });

  it('bounds the plan by the previous review\'s task count, the configured bound and the delta default', async () => {
    const bound = async (previousTaskCount: number | undefined, maxTasks?: number) => {
      const client = scriptedClient();
      // A plan larger than the bound is rejected by the unchanged plan validation; only the bound is read here.
      await review(client, scope(2, { previousTaskCount }), maxTasks).catch(() => undefined);
      return /Use at most (\d+) tasks/u.exec(client.prompts.find((text) => text.includes('=== PLAN TURN ==='))!)?.[1];
    };
    expect(await bound(5)).toBe('3');
    expect(await bound(2)).toBe('2');
    expect(await bound(undefined)).toBe('3');
    expect(await bound(5, 1)).toBe('1');
  });

  it('does not touch the plan bound or prompts for a review that is not delta-scoped', async () => {
    const client = scriptedClient();
    const result = await review(client, scope(2, { deltaFiles: [], openFindings: undefined, previousTaskCount: undefined, chainDepth: undefined, carriedForwardPaths: ['src/b.ts'] }));
    const planPrompt = client.prompts.find((text) => text.includes('=== PLAN TURN ==='))!;
    expect(planPrompt).toMatch(/Use at most 8 tasks/u);
    expect(planPrompt).not.toContain('INCREMENTAL RE-REVIEW');
    expect(client.prompts.some((text) => text.includes('RE-REVIEW LEDGER'))).toBe(false);
    expect(result.incrementalLedger).toBeUndefined();
    expect((await review(scriptedClient())).incrementalLedger).toBeUndefined();
  });

  it('itemizes each task with its share of the ledger and records an outcome for every item', async () => {
    const client = scriptedClient();
    const result = await review(client, scope(3));
    const taskPrompts = client.prompts.filter((text) => text.includes('=== WORK TURN: TASK'));
    const forTask = (id: string) => taskPrompts.find((text) => text.includes(`Task id: ${id}`))!;
    expect(forTask('logic-a')).toContain('RE-REVIEW LEDGER');
    for (const index of [0, 1, 2]) {
      expect(forTask('logic-a')).toContain(`delta:src/a.ts#${index}`);
      expect(forTask('logic-a')).toContain(`delta:src/b.ts#${index}`);
    }
    expect(forTask('logic-a')).not.toMatch(/prior:f_[a-f0-9]{12}/u);
    expect(forTask('open-finding')).toMatch(/prior:f_[a-f0-9]{12}/u);
    expect(forTask('open-finding')).not.toMatch(/delta:src\//u);
    expect(result.incrementalLedger).toMatchObject({ maxTasks: 3, plannedTasks: 2, itemCount: 7, unrecordedTaskIds: [], fallbackRoutedItems: [] });
    const recorded = Object.fromEntries(result.incrementalLedger!.tasks.map((task) => [task.taskId, task.entries.length]));
    expect(recorded).toEqual({ 'logic-a': 6, 'open-finding': 1 });
    expect(result.incrementalLedger!.tasks.flatMap((task) => task.entries).filter((entry) => entry.outcome === 'resolved')).toHaveLength(1);
  });

  it('accepts a ledger field only in a delta re-review', async () => {
    const complete = vi.fn(async (payload: any) => {
      const text = lastText(payload.messages);
      const nonce = nonceFrom(text);
      if (text.includes('=== PLAN TURN ===')) return fakeResponse(JSON.stringify({ nonce, tasks: PLAN }));
      const task = [...allText(payload.messages).matchAll(/Task id: (\S+)/gu)].at(-1)?.[1] ?? 'unknown';
      return fakeResponse(JSON.stringify({ nonce, task, status: 'COMPLETE', blockedReason: null, findings: [], ledger: [] }));
    });
    // Without a delta scope the result schema is unchanged, so the extra field is a contract failure.
    const result = await review({ complete });
    expect(result.personas).toHaveLength(0);
    expect(result.incrementalLedger).toBeUndefined();
  });

  it('rejects a COMPLETE task that omits its ledger, corrects it once, and never counts it as resolved', async () => {
    const client = scriptedClient({ omitLedgerFor: 'open-finding' });
    const result = await review(client, scope(1));
    expect(client.calls.filter((call) => call === 'task:open-finding')).toHaveLength(2);
    const correction = client.prompts.filter((text) => text.includes('TASK_RESULT_CORRECTION')).at(-1) ?? '';
    expect(correction).toContain('ledger');
    expect(result.incrementalLedger!.unrecordedTaskIds).toEqual([]);
    expect(result.incrementalLedger!.tasks.find((task) => task.taskId === 'open-finding')?.entries).toHaveLength(1);
  });

  it('names a task that never produced a valid ledger instead of reporting its items as resolved', async () => {
    const complete = vi.fn(async (payload: any) => {
      const text = lastText(payload.messages);
      const nonce = nonceFrom(text);
      if (text.includes('=== PLAN TURN ===')) return fakeResponse(JSON.stringify({ nonce, tasks: PLAN }));
      const task = [...allText(payload.messages).matchAll(/Task id: (\S+)/gu)].at(-1)?.[1] ?? 'unknown';
      // Always omits the ledger.
      return fakeResponse(JSON.stringify({ nonce, task, status: 'COMPLETE', blockedReason: null, findings: [] }));
    });
    const result = await review({ complete }, scope(1));
    expect(result.personas).toHaveLength(0);
    expect(result.unreportedLanes?.map((lane) => lane.id).sort()).toEqual(['logic-a', 'open-finding']);
    expect(result.incrementalLedger!.tasks).toEqual([]);
    expect(result.incrementalLedger!.unrecordedTaskIds.sort()).toEqual(['logic-a', 'open-finding']);
  });
});
