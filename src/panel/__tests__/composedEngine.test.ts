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
  it('short-circuits the zero-lane path exactly like the fan-out engine, before any provider call', async () => {
    const complete = vi.fn();
    const result = await executeComposedReview({
      config: config(),
      changedFiles: [{ path: 'docs/readme.md', patch: '@@ -1 +1 @@\n-old\n+new' }],
      repository: 'calltelemetry/ct-meta',
      headSha: 'a'.repeat(40),
      client: { complete },
    });
    expect(result.zeroLaneNonEvidence).toBe(true);
    expect(result.personas).toEqual([]);
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

});
