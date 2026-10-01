import { describe, expect, it, vi } from 'vitest';
import type { OpenRouterRequest, OpenRouterResponse, ReviewModelClient } from '../../src/gateway/openRouterClient';
import { createPanelDeadlineSignal, validateFindings, PanelFindingsValidationError } from '../../src/panel/panelEngine';
import {
  createPublishingProgress,
  findingCorrectionForCode,
  findingRejectionCodeForCode,
  safePublishingRejectionCode,
} from '../../src/telemetry/publishingProgress';

function providerResponse(model = 'provider/model-v1'): OpenRouterResponse {
  return {
    model,
    content: 'private provider response',
    usage: { prompt: 11, completion: 7, total: 18, cached: 2 },
    costUSD: 0.004,
    raw: { private: 'raw provider payload' },
  };
}

function request(overrides: Partial<OpenRouterRequest> = {}): OpenRouterRequest {
  return {
    model: 'provider/model-v1',
    messages: [{ role: 'user', content: 'private prompt content' }],
    timeoutMs: 1_000,
    providerId: 'bifrost',
    persona: 'security_lane',
    metadata: { role: 'persona', persona: 'security_lane' },
    internalProgress: { turn: 3, lane: 'security_lane' },
    ...overrides,
  };
}

describe('publishing progress diagnostics', () => {
  it('isolates concurrent executions and records safe provider-call timing and usage', async () => {
    const eventsA: Array<Record<string, unknown>> = [];
    const eventsB: Array<Record<string, unknown>> = [];
    let nowA = 100;
    let nowB = 500;
    let resolveA!: (response: OpenRouterResponse) => void;
    let resolveB!: (response: OpenRouterResponse) => void;
    const rawA: ReviewModelClient = { complete: () => new Promise((resolve) => { resolveA = resolve; }) };
    const rawB: ReviewModelClient = { complete: () => new Promise((resolve) => { resolveB = resolve; }) };
    const progressA = createPublishingProgress({ runId: 'run-a', executionAttempt: 2 }, { sink: (event) => eventsA.push(event), now: () => nowA });
    const progressB = createPublishingProgress({ runId: 'run-b', executionAttempt: 1 }, { sink: (event) => eventsB.push(event), now: () => nowB });

    const pendingA = progressA.instrument(rawA).complete(request());
    const pendingB = progressB.instrument(rawB).complete(request({ internalProgress: { turn: 1, lane: 'api_lane' } }));
    expect(eventsA).toHaveLength(1);
    expect(eventsB).toHaveLength(1);
    expect(eventsA[0]).toMatchObject({ runId: 'run-a', executionAttempt: 2, task: 'provider_call', status: 'started', role: 'persona', lane: 'security_lane', turn: 3 });
    expect(eventsB[0]).toMatchObject({ runId: 'run-b', executionAttempt: 1, lane: 'api_lane', turn: 1 });

    nowB = 560;
    resolveB(providerResponse('ghp_fixture_response_model_123456'));
    await pendingB;
    nowA = 175;
    resolveA(providerResponse('ghp_fixture_response_model_123456'));
    await pendingA;

    expect(eventsA[1]).toMatchObject({ runId: 'run-a', executionAttempt: 2, status: 'completed', durationMs: 75,
      usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18, cachedTokens: 2, costUSD: 0.004 } });
    expect(eventsB[1]).toMatchObject({ runId: 'run-b', executionAttempt: 1, status: 'completed', durationMs: 60 });
    expect(eventsA.every((event) => event.model === 'provider/model-v1')).toBe(true);
    expect(eventsB.every((event) => event.model === 'provider/model-v1')).toBe(true);
    expect(JSON.stringify([...eventsA, ...eventsB])).not.toContain('private prompt content');
    expect(JSON.stringify([...eventsA, ...eventsB])).not.toContain('private provider response');
    expect(JSON.stringify([...eventsA, ...eventsB])).not.toContain('ghp_fixture_response_model_123456');
  });

  it('strips the internal turn marker and preserves provider request and rejection behavior', async () => {
    const events: Array<Record<string, unknown>> = [];
    const rawFailure = Object.assign(new Error('SECRET prompt and provider response'), { name: 'OpenRouterResponseError', status: 503 });
    const forwarded: OpenRouterRequest[] = [];
    const raw: ReviewModelClient = { complete: vi.fn(async (input) => { forwarded.push(input); throw rawFailure; }) };
    const progress = createPublishingProgress({ runId: 'run-fail', executionAttempt: 3 }, { sink: (event) => events.push(event) });
    const input = request();

    await expect(progress.instrument(raw).complete(input)).rejects.toBe(rawFailure);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).not.toHaveProperty('internalProgress');
    expect(forwarded[0].messages).toBe(input.messages);
    expect(forwarded[0]).toMatchObject({ model: input.model, providerId: input.providerId, metadata: input.metadata });
    expect(events[1]).toMatchObject({ status: 'failed', rejectionCode: 'provider_error', runId: 'run-fail', executionAttempt: 3 });
    expect(JSON.stringify(events)).not.toContain('SECRET prompt and provider response');
    expect(JSON.stringify(events)).not.toContain('private prompt content');
  });

  it('maps an unknown failureClass to a fixed code without emitting the caller-controlled value', async () => {
    const events: Array<Record<string, unknown>> = [];
    const privateFailureClass = 'ghp_private_failure_class_123456';
    const failure = Object.assign(new Error('private failure detail'), { failureClass: privateFailureClass });
    const raw: ReviewModelClient = { complete: vi.fn(async () => { throw failure; }) };
    const progress = createPublishingProgress({ runId: 'run-unknown-failure', executionAttempt: 1 }, {
      sink: (event) => events.push(event),
    });

    await expect(progress.instrument(raw).complete(request())).rejects.toBe(failure);

    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ task: 'provider_call', status: 'failed', rejectionCode: 'unknown' });
    expect(events[1]).not.toHaveProperty('failureClass');
    expect(JSON.stringify(events)).not.toContain(privateFailureClass);
    expect(JSON.stringify(events)).not.toContain('private failure detail');
  });

  it.each(['__proto__', 'constructor'])('omits inherited-name rejection code %s from emitted events', (untrustedCode) => {
    const events: Array<Record<string, unknown>> = [];
    const progress = createPublishingProgress({ runId: 'run-untrusted-code', executionAttempt: 1 }, {
      sink: (event) => events.push(event),
    });

    const untrustedEvent = { task: 'provider_output', status: 'rejected', rejectionCode: untrustedCode };
    progress.emit(untrustedEvent as unknown as Parameters<typeof progress.emit>[0]);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ task: 'provider_output', status: 'rejected' });
    expect(events[0]).not.toHaveProperty('rejectionCode');
    expect(JSON.stringify(events)).not.toContain(untrustedCode);
  });

  it('handles unmarked classic calls and retains finite worker failure classes', async () => {
    const events: Array<Record<string, unknown>> = [];
    const forwarded: OpenRouterRequest[] = [];
    const raw: ReviewModelClient = { complete: vi.fn(async (input) => { forwarded.push(input); return providerResponse(); }) };
    const progress = createPublishingProgress({ runId: 'run-unmarked', executionAttempt: 1 }, { sink: (event) => events.push(event) });
    await progress.instrument(raw).complete(request({ internalProgress: undefined }));

    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).not.toHaveProperty('internalProgress');
    expect(events[0]).toMatchObject({ role: 'persona', lane: 'security_lane', turn: 1 });
    expect(safePublishingRejectionCode({ failureClass: 'contract' })).toBe('contract');
    expect(safePublishingRejectionCode({ failureClass: 'auth' })).toBe('auth');
  });

  it('uses the canonical cached-token resolver for cache_read_input_tokens', async () => {
    const events: Array<Record<string, unknown>> = [];
    const cachedResponse = {
      ...providerResponse(),
      usage: { prompt: 11, completion: 7, total: 18, cache_read_input_tokens: 6 },
    } as unknown as OpenRouterResponse;
    const progress = createPublishingProgress({ runId: 'run-cache-read', executionAttempt: 1 }, { sink: (event) => events.push(event) });
    await progress.instrument({ complete: vi.fn(async () => cachedResponse) }).complete(request());
    expect(events[1]).toMatchObject({ status: 'completed', usage: { cachedTokens: 6 } });
  });

  it('emits abort progress immediately once and keeps the pending provider result unchanged', async () => {
    const events: Array<Record<string, unknown>> = [];
    const controller = new AbortController();
    let resolve!: (response: OpenRouterResponse) => void;
    const raw: ReviewModelClient = { complete: () => new Promise((finish) => { resolve = finish; }) };
    const progress = createPublishingProgress({ runId: 'run-abort', executionAttempt: 1 }, { sink: (event) => events.push(event) });
    const pending = progress.instrument(raw).complete(request({ signal: controller.signal }));

    controller.abort(new Error('private cancellation reason'));
    expect(events[1]).toMatchObject({ status: 'aborted', rejectionCode: 'aborted', runId: 'run-abort' });
    resolve(providerResponse());
    await pending;
    expect(events).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain('private cancellation reason');
  });

  it('classifies a real panel deadline as timeout while keeping ordinary caller abort as aborted', async () => {
    vi.useFakeTimers();
    const events: Array<Record<string, unknown>> = [];
    let resolve!: (response: OpenRouterResponse) => void;
    const raw: ReviewModelClient = { complete: () => new Promise((finish) => { resolve = finish; }) };
    const progress = createPublishingProgress({ runId: 'run-deadline', executionAttempt: 1 }, { sink: (event) => events.push(event) });
    const deadline = createPanelDeadlineSignal(0.001);
    try {
      const pending = progress.instrument(raw).complete(request({ signal: deadline.signal }));
      await vi.advanceTimersByTimeAsync(2);
      expect(events[1]).toMatchObject({ status: 'aborted', rejectionCode: 'timeout' });
      resolve(providerResponse());
      await pending;
    } finally {
      deadline.cleanup();
      vi.useRealTimers();
    }
  });

  it('classifies composed cancellation from the standard request signal and forwards it unchanged', async () => {
    const events: Array<Record<string, unknown>> = [];
    const controller = new AbortController();
    let resolve!: (response: OpenRouterResponse) => void;
    let forwarded!: OpenRouterRequest;
    const raw: ReviewModelClient = {
      complete: (input) => {
        forwarded = input;
        return new Promise((finish) => { resolve = finish; });
      },
    };
    const progress = createPublishingProgress({ runId: 'run-composed-abort', executionAttempt: 2 }, { sink: (event) => events.push(event) });
    const pending = progress.instrument(raw).complete(request({
      signal: controller.signal,
      internalProgress: { turn: 4, task: 'composed_task', lane: 'composed-task-1' },
    }));

    controller.abort(new Error('private composed cancellation detail'));
    expect(events[1]).toMatchObject({ task: 'provider_call', status: 'aborted', rejectionCode: 'aborted', lane: 'composed-task-1', turn: 4 });
    expect(forwarded).not.toHaveProperty('internalProgress');
    expect(forwarded.signal).toBe(controller.signal);
    resolve(providerResponse());
    await pending;
    expect(events).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain('private composed cancellation detail');
  });

  it('keeps invalid findings fail-closed and selects only fixed, enum-owned correction hints', () => {
    const changedFiles = [{ path: 'src/auth.ts', patch: '@@ -0,0 +1,2 @@\n+const token = 1;\n+use(token);' }];
    const invalidAnchor = [{ severity: 'P1', path: 'src/auth.ts', line: 9, title: 'x', body: 'y' }];
    let failure: unknown;
    try { validateFindings(invalidAnchor, changedFiles); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(PanelFindingsValidationError);
    expect((failure as PanelFindingsValidationError).findingFailureCode).toBe('line_not_added');
    expect(findingCorrectionForCode((failure as PanelFindingsValidationError).findingFailureCode)).toEqual({
      rejectionCode: 'finding_line_not_added',
      hint: 'Correct the finding line to an added line in the supplied changed-file diff, or remove the finding if it cannot be anchored.',
    });

    const invalidSeverity = [{ severity: 'HIGH', path: 'src/auth.ts', line: 1, title: 'x', body: 'y' }];
    expect(() => validateFindings(invalidSeverity, changedFiles)).toThrow(PanelFindingsValidationError);
    expect(findingCorrectionForCode('severity_invalid')?.hint).toContain('P0, P1, or P2');
    expect(findingCorrectionForCode('provider supplied text')).toBeUndefined();
    for (const code of ['path_invalid', 'path_not_changed', 'line_invalid', 'line_not_added', 'line_unanchorable', 'severity_invalid', 'contract_invalid']) {
      expect(findingCorrectionForCode(code)?.hint).toEqual(expect.any(String));
    }
    expect(findingRejectionCodeForCode('path_not_changed')).toBe('finding_path_not_changed');
    expect(findingRejectionCodeForCode('line_unanchorable')).toBe('finding_line_unanchorable');
    expect(findingRejectionCodeForCode('provider supplied text')).toBe('findings_contract_invalid');

    const expectFailureCode = (finding: Record<string, unknown>, code: string, files = changedFiles) => {
      try { validateFindings([finding], files); } catch (error) {
        expect(error).toBeInstanceOf(PanelFindingsValidationError);
        expect((error as PanelFindingsValidationError).findingFailureCode).toBe(code);
        return;
      }
      throw new Error('expected strict finding validation to reject fixture');
    };
    const baseFinding = { severity: 'P1', path: 'src/auth.ts', line: 1, title: 'x', body: 'y' };
    expectFailureCode({ ...baseFinding, path: '' }, 'path_invalid');
    expectFailureCode({ ...baseFinding, path: 'src/other.ts' }, 'path_not_changed');
    expectFailureCode({ ...baseFinding, line: 0 }, 'line_invalid');
    expectFailureCode(baseFinding, 'line_unanchorable', [{ path: 'src/auth.ts', patch: 'content without a hunk' }]);
  });
});

describe('bounded operational timeout observations', () => {
  it('retains only observed calls, numeric availability and immutable finite events when the sink throws', async () => {
    let clock=100; const reporter=createPublishingProgress({runId:'run-observed',executionAttempt:1},{now:()=>clock,sink:()=>{throw new Error('sink');}});
    reporter.emit({task:'panel',status:'started'});
    const raw:ReviewModelClient={complete:vi.fn(async()=>providerResponse())};
    await reporter.instrument(raw).complete(request());
    const saved=reporter.snapshot?.(); expect(saved).toMatchObject({cause:'unknown',providerCalls:{started:1,completed:1,inflight:0},responseUsage:{availability:'known',responses:1,totals:{promptTokens:11,completionTokens:7,totalTokens:18,cachedTokens:2,costUSD:0.004}},panel:{invoked:true,wallClockMs:0}});
    clock=150; reporter.emit({task:'composed_task',status:'blocked',lane:'SECRET path/phone',model:'SECRET model'});
    expect(saved!.recentEvents).toHaveLength(3); expect(reporter.snapshot?.()!.recentEvents).toHaveLength(4);
    expect(JSON.stringify(reporter.snapshot?.())).not.toMatch(/security_lane|provider.model|private|SECRET|phone/);
    expect(reporter.snapshot?.()!.panel.wallClockMs).toBe(50);
  });
  it('records aborted invocations once and ignores a late returned response without inventing usage', async () => {
    const reporter=createPublishingProgress({runId:'run-aborted',executionAttempt:1},{sink:()=>{}});
    const signal=new AbortController(); let answer!:(r:OpenRouterResponse)=>void;
    const pending=reporter.instrument({complete:()=>new Promise(resolve=>{answer=resolve;})}).complete(request({signal:signal.signal}));
    signal.abort(new DOMException('private credential prompt','AbortError'));
    const saved=reporter.snapshot?.(); expect(saved?.providerCalls).toEqual({started:1,completed:0,failed:0,aborted:1,inflight:0});
    answer(providerResponse()); await pending; signal.abort(); expect(reporter.snapshot?.()).toEqual(saved);
    expect(saved?.responseUsage).toMatchObject({availability:'unknown',responses:0,totals:{}});
    expect(saved?.panel).toEqual({invoked:false});
  });
  it('keeps concurrent execution counts separate, bounds recent history, and treats missing/malformed usage as unknown', async () => {
    const a=createPublishingProgress({runId:'run-a',executionAttempt:1},{sink:()=>{}});
    const b=createPublishingProgress({runId:'run-b',executionAttempt:1},{sink:()=>{}});
    const response={...providerResponse(),usage:undefined,costUSD:undefined} as unknown as OpenRouterResponse;
    await a.instrument({complete:async()=>response}).complete(request());
    for(let i=0;i<30;i++)a.emit({task:'provider_output',status:'rejected',rejectionCode:'malformed_output',lane:'SECRET'});
    expect(a.snapshot?.()).toMatchObject({eventCount:32,eventsDropped:16,responseUsage:{availability:'unknown',totals:{}},recentEvents:expect.any(Array)});
    expect(a.snapshot?.()!.recentEvents).toHaveLength(16); expect(b.snapshot?.()!.providerCalls.started).toBe(0);
    const malformed={...providerResponse(),usage:{prompt:-1,completion:Infinity,total:'18',cached:NaN},costUSD:-1} as unknown as OpenRouterResponse;
    await b.instrument({complete:async()=>malformed}).complete(request());
    expect(b.snapshot?.()!.responseUsage).toMatchObject({availability:'unknown',totals:{}});
  });
  it('never turns throwing response metadata into a review failure', async () => {
    const reporter=createPublishingProgress({runId:'run-getter',executionAttempt:1},{sink:()=>{}});
    const response={...providerResponse()}; Object.defineProperty(response,'usage',{get(){throw new Error('SECRET');}});
    await expect(reporter.instrument({complete:async()=>response}).complete(request())).resolves.toBe(response);
    expect(reporter.snapshot?.()).toMatchObject({providerCalls:{completed:1},responseUsage:{availability:'unknown'}});
    reporter.emit({task:'future-secret',status:'raw-prompt'} as never);
    expect(reporter.snapshot?.()!.eventCount).toBe(2);
  });
});
