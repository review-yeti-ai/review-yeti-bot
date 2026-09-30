import { describe, it, expect, vi } from 'vitest';
import { executeComposedReview, unreportedLaneFailure } from '../composedEngine';
import { computeArbitration } from '../../review/reviewCore';
import { projectPublishingRosterBounds } from '../../cli/publishingReview';
import { parseAndValidateConfig } from '../../config/configLoader';
import type { OpenRouterResponse } from '../../gateway/openRouterClient';
import { OpenRouterConnectionError, OpenRouterResponseError } from '../../gateway/openRouterClient';
import { mcpFleetManager } from '../../mcp/mcpFleetManager';
import * as panelEngine from '../panelEngine';
import * as toolRuntime from '../toolRuntime';
import { executePersonaPanel, PanelConfigurationError } from '../panelEngine';

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


  it.each(['read_file', 'view_file'])('REL-1204 exact-source shared composed loop uses %s on a carried file', async (tool) => {
    const path = 'src/auth/guard.ts';
    const source = 'CURRENT_COMPOSED_HEAD_SOURCE\nexport function guard() { return false; }\nCURRENT_COMPOSED_TAIL';
    const readFile = vi.fn().mockResolvedValue(source);
    let workCalls = 0;
    let observedToolResult = '';
    const complete = vi.fn(async (payload: any) => {
      const nonce = issuedNonce(payload.messages);
      if (lastText(payload.messages).includes('PLAN TURN')) return fakeResponse(JSON.stringify({ nonce, tasks: [
        { id: 'task-sec', dimension: 'security', paths: [path], question: 'Read current guard source.', rationale: 'Carried file needs exact source.' },
      ] }));
      workCalls += 1;
      if (workCalls === 1) return fakeResponse(JSON.stringify({ tool, args: { path } }));
      observedToolResult = JSON.stringify(payload.messages.filter((message: any) => String(message.content).includes('[PI_TOOL_RESULT]')));
      return fakeResponse(JSON.stringify({ nonce, task: 'task-sec', status: 'COMPLETE', findings: [] }));
    });
    const result = await executeComposedReview({ config: config(),
      changedFiles: [{ path, patch: '[carried-forward: exact-head content available via tools]' }],
      repository: 'acme/reviewer-fixture', headSha: 'a'.repeat(40), client: { complete },
      repoFileProvider: { readFile, findFiles: vi.fn().mockResolvedValue([path]) },
    });
    const observed = { sourceReads: readFile.mock.calls.length, observedToolResult };
    expect(observed, JSON.stringify(observed)).toMatchObject({
      sourceReads: 1, observedToolResult: expect.stringContaining('CURRENT_COMPOSED_HEAD_SOURCE'),
    });
    expect(readFile).toHaveBeenCalledExactlyOnceWith(path);
    expect(observedToolResult).toContain('CURRENT_COMPOSED_TAIL');
    expect(observedToolResult).toContain('[SCOPE: full-repository | EXHAUSTIVE: true]');
    expect(observedToolResult).not.toContain('[carried-forward:');
    expect(workCalls).toBe(2);
    expect(result.personas).toMatchObject([{ id: 'task-sec', decision: 'APPROVE', toolTurns: 1 }]);
    expect(result.unreportedLanes).toEqual([]);
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
    // REL-1058: the exemption is the shared applicability decision's, so -- as
    // on the fan-out engine and the service -- it applies only when no enabled
    // persona covers the documentation. A catch-all persona reviews it instead.
    const narrow = parseAndValidateConfig(mockYaml.replace('paths: ["**/*"]', 'paths: ["src/**"]')) as any;
    const result = await executeComposedReview({
      config: narrow,
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
      repository: 'calltelemetry/ct-meta',
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
      repository: 'calltelemetry/ct-meta',
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
      repository: 'calltelemetry/ct-meta',
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
      expect(correction).toContain('Binding task-result schema:');
      expect(correction).toContain('"enum":["P0","P1","P2"]');
      expect(correction).toContain('do not request another tool');
      return fakeResponse(JSON.stringify({ nonce, task: 'task-sec', status: 'BLOCKED', findings: [] }));
    });
    const result = await executeComposedReview({ config: config(), changedFiles: CODE_FILES,
      repository: 'acme/reviewer-fixture', headSha: 'a'.repeat(40), client: { complete } });
    expect(workCalls).toBe(2);
    expect(result.personas).toEqual([]);
    expect(result.optionalFailures).toMatchObject([{ id: 'task-sec' }]);
    expect(result.unreportedLanes).toEqual([]);
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
      repository: 'calltelemetry/ct-meta',
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
        repository: 'calltelemetry/ct-meta', headSha: 'a'.repeat(40), client: { complete } });
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
        repository: 'calltelemetry/ct-meta', headSha: 'a'.repeat(40), client: { complete } })).rejects.toThrow();
      expect(planCalls).toBe(1);
    } finally {
      vi.restoreAllMocks();
    }
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
    const { complete, workTurns } = routedClient((taskId, _text, nonce) => taskId === 'task-2'
      ? 'SYNTHETIC_REASONING_WITHOUT_VERDICT'
      : JSON.stringify({ nonce, task: taskId, status: 'COMPLETE', findings: [] }));
    const cfg = config();
    cfg.composed = { max_turns_total: 6, max_turns_per_task: 4 };
    const result = await executeComposedReview({ config: cfg, changedFiles: CODE_FILES,
      repository: 'acme/reviewer-fixture', headSha: 'a'.repeat(40), client: { complete } });
    expect(workTurns).toEqual(['task-1', 'task-2', 'task-2', 'task-2', 'task-3']);
    expect(result.personas.map((lane) => lane.id)).toEqual(['task-1', 'task-3']);
    expect(result.unreportedLanes).toMatchObject([{ id: 'task-2', failureClass: 'malformed_output',
      error: expect.stringContaining('non_json_task_result') }]);
    expect(projectPublishingRosterBounds(result).returnedIds).toEqual(['task-1', 'task-3']);
    expect(complete).toHaveBeenCalledTimes(6);
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
      repository: 'calltelemetry/ct-meta',
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
      repository: 'calltelemetry/ct-meta',
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
        expect(text).toContain('[SCOPE: cross-repository-ast-mesh | EXHAUSTIVE: true]');
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
        repository: 'calltelemetry/ct-meta',
        headSha: 'a'.repeat(40),
        client: { complete },
      });

      expect(toolResultSeen).toBe(true);
      expect(result.personas.length).toBeGreaterThan(0);
    } finally {
      execSpy.mockRestore();
    }
  });
});
