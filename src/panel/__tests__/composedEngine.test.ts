import { describe, it, expect, vi } from 'vitest';
import { executeComposedReview } from '../composedEngine';
import { computeArbitration } from '../../review/reviewCore';
import { parseAndValidateConfig } from '../../config/configLoader';
import type { OpenRouterResponse } from '../../gateway/openRouterClient';
import { OpenRouterResponseError } from '../../gateway/openRouterClient';

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
      repository: 'calltelemetry/ct-meta',
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
    expect(planDirective).toContain('[a-z][a-z0-9_-]*');
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
      repository: 'calltelemetry/ct-meta',
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
    const result = await executeComposedReview({
      config: config(),
      changedFiles: [{ path: 'docs/readme.md', patch: '@@ -1 +1 @@\n-old\n+new' }],
      repository: 'calltelemetry/ct-meta',
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
      repository: 'calltelemetry/ct-meta',
      headSha: 'a'.repeat(40),
      client: { complete },
    });

    expect(result.zeroLaneNonEvidence).toBe(false);
    expect(result.applicablePersonaIds).toEqual(['task-sec']);
    expect(result.personas).toHaveLength(1);
    expect(result.personas[0]).toMatchObject({ id: 'task-sec', decision: 'APPROVE', findings: [] });
    expect(result.optionalFailures).toEqual([]);
  });

  // --- Mutation target 3: "make a BLOCKED task count as a pass" must go red -------------------
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
      repository: 'calltelemetry/ct-meta',
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
      repository: 'calltelemetry/ct-meta',
      headSha: 'a'.repeat(40),
      client: { complete },
    })).rejects.toThrow(/empty_plan/);
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
      repository: 'calltelemetry/ct-meta',
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
      repository: 'calltelemetry/ct-meta',
      headSha: 'a'.repeat(40),
      client: { complete },
    }).catch((e) => e);

    // Either it throws, or it completes with the task absent from the roster. What must NOT
    // happen is an APPROVE lane for a result that was never bound to its request.
    const personas = (result && (result as any).personas) || [];
    expect(personas.some((p: any) => p.decision === 'APPROVE' || p.decision === 'FINDINGS')).toBe(false);
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
      repository: 'calltelemetry/ct-meta',
      headSha: 'a'.repeat(40),
      client: { complete },
    });

    expect(attempts).toBeGreaterThan(1);
    expect(result.personas).toHaveLength(1);
    expect(result.personas[0].id).toBe('task-sec');
  });


  // The retry ladders check their backoff against the run's remaining budget. That check compared
  // against Infinity until the deadline was actually threaded from the orchestrator into
  // `callTurn` -- the guard existed, was described as "budget-aware" in its own commit message,
  // and could not fire. This pins that it is reachable: with no budget left, a retryable error is
  // NOT retried, so exactly one provider call is made.
  it('does not retry when the remaining budget cannot fit the backoff', async () => {
    let calls = 0;
    const complete = vi.fn(async () => {
      calls += 1;
      throw new OpenRouterResponseError('provider returned empty completion content', 200);
    });

    const cfg: any = config();
    cfg.reviewers = { ...cfg.reviewers, overall_timeout_s: 0 };

    await executeComposedReview({
      config: cfg,
      changedFiles: CODE_FILES,
      repository: 'calltelemetry/ct-meta',
      headSha: 'a'.repeat(40),
      client: { complete },
    }).catch(() => undefined);

    expect(calls).toBe(1);
  });

  function threeTasks() {
    return [
      { id: 'task-1', dimension: 'security', paths: ['src/auth/guard.ts'], question: 'Is the first change safe?', rationale: 'first' },
      { id: 'task-2', dimension: 'testing', paths: ['src/auth/guard.ts'], question: 'Is the second change covered?', rationale: 'second' },
      { id: 'task-3', dimension: 'architecture', paths: ['src/auth/guard.ts'], question: 'Does the third change fail closed?', rationale: 'third' },
    ];
  }

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
      if (text.includes('WORK TURN')) {
        const taskId = threeTasks().find((task) => text.includes(`TASK`) && text.includes(task.id))?.id
          ?? threeTasks().find((task) => text.includes(task.id))?.id;
        if (!taskId) throw new Error(`work turn named no task: ${text.slice(0, 120)}`);
        workTurns.push(taskId);
        return fakeResponse(decide(taskId, text, nonce));
      }
      throw new Error(`unexpected turn: ${text.slice(0, 80)}`);
    });
    return { complete, workTurns };
  }

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
      repository: 'calltelemetry/ct-meta',
      headSha: 'a'.repeat(40),
      client: { complete },
    });

    expect(workTurns).toEqual(['task-1', 'task-2', 'task-3']);
    expect(result.personas.map((lane) => lane.id).sort()).toEqual(['task-1', 'task-3']);
    expect(result.personas.every((lane) => lane.decision === 'APPROVE')).toBe(true);
    expect(result.optionalFailures?.[0]).toMatchObject({
      id: 'task-2',
      failureClass: 'malformed_output',
    });
    expect(result.optionalFailures?.[0]?.error).toContain('ran and produced no verdict');
    expect(result.optionalFailures?.[0]?.error).not.toContain('did not start');

    const lanes = [
      ...result.personas,
      ...(result.optionalFailures ?? []).map((failure) => ({
        id: failure.id, decision: 'ERROR', status: 'ERROR', error: failure.error, findings: [],
      })),
    ];
    const arbitration = computeArbitration(lanes, result.applicablePersonaIds!.length, {
      changedFiles: CODE_FILES,
      coverageComplete: true,
      panelSize: 1,
    });
    expect(arbitration.verdict).toBe('BLOCK');
    expect(arbitration.verdict).not.toBe('SHIP');
  });

  it('fails closed when every planned task produces no verdict', async () => {
    const { complete, workTurns } = routedClient(() => 'not a verdict');
    const cfg: any = config();
    cfg.composed = { max_turns_per_task: 1 };

    const result = await executeComposedReview({
      config: cfg,
      changedFiles: CODE_FILES,
      repository: 'calltelemetry/ct-meta',
      headSha: 'a'.repeat(40),
      client: { complete },
    });

    expect(workTurns).toEqual(['task-1', 'task-2', 'task-3']);
    expect(result.personas).toEqual([]);
    expect((result.optionalFailures ?? []).map((failure) => failure.failureClass)).toEqual([
      'malformed_output', 'malformed_output', 'malformed_output',
    ]);
    expect((result.optionalFailures ?? []).every((failure) => String(failure.error).includes('ran and produced no verdict'))).toBe(true);
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
      repository: 'calltelemetry/ct-meta',
      headSha: 'a'.repeat(40),
      client: { complete },
    });

    expect(workTurns).toEqual(['task-1']);
    expect(result.personas.map((lane) => lane.id)).toEqual(['task-1']);
    expect((result.optionalFailures ?? []).map((failure) => failure.id).sort()).toEqual(['task-2', 'task-3']);
    expect((result.optionalFailures ?? []).every((failure) => failure.failureClass === 'budget_exhausted')).toBe(true);
    expect((result.optionalFailures ?? []).every((failure) => String(failure.error).includes('did not start'))).toBe(true);
  });

});
