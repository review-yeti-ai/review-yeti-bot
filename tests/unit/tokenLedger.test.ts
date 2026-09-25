import { describe, expect, it, vi } from 'vitest';
import {
  TokenLedger,
  attributeRequest,
  meterModelClient,
  recordProviderCallTokenMetrics,
  renderTokenAccountingSummary,
  tokenAccountingLogFields,
  usageOfResponse,
} from '../../src/telemetry/tokenLedger';
import { getMetrics } from '../../src/telemetry';

/**
 * REL-1132: the run's token accounting counts every provider call, not each role's terminal turn.
 * Bifrost bills every request; the worker used to report about 2.7x fewer tokens than Bifrost.
 */

function response(prompt: number, completion: number, extra: Record<string, unknown> = {}) {
  return { model: 'm', content: '{}', usage: { prompt, completion, total: prompt + completion, ...extra }, costUSD: 0.001, raw: {} };
}

function request(role: string | undefined, persona?: string) {
  return { model: 'm', messages: [], timeoutMs: 1, ...(persona ? { persona } : {}), ...(role ? { metadata: { role } } : {}) };
}

describe('usageOfResponse', () => {
  it('reads the client shape, the raw *_tokens shape, and derives a missing total', () => {
    expect(usageOfResponse(response(10, 5, { cached_tokens: 4 }))).toEqual({
      calls: 1, promptTokens: 10, completionTokens: 5, totalTokens: 15, cachedTokens: 4, costUSD: 0.001,
    });
    expect(usageOfResponse({ usage: { prompt_tokens: 7, completion_tokens: 3 } as never, costUSD: null }))
      .toMatchObject({ promptTokens: 7, completionTokens: 3, totalTokens: 10, costUSD: 0 });
    // A call with no usage still counts as a call, with zero tokens -- never NaN.
    expect(usageOfResponse({ usage: null, costUSD: null })).toEqual({
      calls: 1, promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, costUSD: 0,
    });
  });
});

describe('attributeRequest', () => {
  it('puts persona turns and the map-reduce reduce pass on the lane, and splits moderator/arbiter/other', () => {
    expect(attributeRequest(request('persona', 'arch-lane'))).toEqual({ role: 'lanes', key: 'arch-lane' });
    expect(attributeRequest({ persona: 'sec-lane', metadata: { role: 'map-reduce-reduce' } })).toEqual({ role: 'lanes', key: 'sec-lane' });
    expect(attributeRequest(request('moderator', 'moderator'))).toEqual({ role: 'moderator', key: 'moderator' });
    expect(attributeRequest(request('arbiter', 'arbiter'))).toEqual({ role: 'arbiter', key: 'arbiter' });
    expect(attributeRequest(request(undefined, 'classifier'))).toEqual({ role: 'other', key: 'classifier' });
    expect(attributeRequest(request(undefined))).toEqual({ role: 'other', key: 'unattributed' });
    // A forced label wins over whatever the caller set (the composed shadow engine).
    expect(attributeRequest(request('persona', 'arch-lane'), 'composed-shadow')).toEqual({ role: 'other', key: 'composed-shadow' });
  });
});

describe('TokenLedger + meterModelClient', () => {
  it('sums every turn of every lane plus moderator and arbiter, with the per-role and per-lane split', async () => {
    const ledger = new TokenLedger();
    const inner = { complete: vi.fn() };
    const client = meterModelClient(inner as never, ledger);
    const script: Array<[ReturnType<typeof request>, ReturnType<typeof response>]> = [
      [request('persona', 'arch-lane'), response(100, 20)],
      [request('persona', 'arch-lane'), response(150, 25)],
      [request('persona', 'arch-lane'), response(200, 30)], // terminal turn: 230 of the lane's 525
      [request('persona', 'sec-lane'), response(50, 10)],
      [request('moderator', 'moderator'), response(40, 10)],
      [request('arbiter', 'arbiter'), response(30, 5)],
      [request(undefined, 'classifier'), response(9, 1)],
    ];
    for (const [req, res] of script) {
      inner.complete.mockResolvedValueOnce(res);
      await expect(client.complete(req as never)).resolves.toBe(res);
    }

    const accounting = ledger.snapshot();
    expect(accounting.basis).toBe('every_provider_call');
    expect(accounting.total).toMatchObject({ calls: 7, promptTokens: 579, completionTokens: 101, totalTokens: 680 });
    expect(accounting.byRole.lanes.totalTokens).toBe(585);
    expect(accounting.byRole.moderator.totalTokens).toBe(50);
    expect(accounting.byRole.arbiter.totalTokens).toBe(35);
    expect(accounting.byRole.other.totalTokens).toBe(10);
    expect(accounting.byLane['arch-lane']).toMatchObject({ calls: 3, totalTokens: 525 });
    expect(accounting.byLane['sec-lane']).toMatchObject({ calls: 1, totalTokens: 60 });
    expect(accounting.byOther).toEqual({ classifier: expect.objectContaining({ calls: 1, totalTokens: 10 }) });
    // The snapshot is a copy: later calls do not mutate an already-published figure.
    inner.complete.mockResolvedValueOnce(response(1, 1));
    await client.complete(request('persona', 'arch-lane') as never);
    expect(accounting.byLane['arch-lane'].totalTokens).toBe(525);
  });

  it('passes a failed call through unchanged and records nothing for it', async () => {
    const ledger = new TokenLedger();
    const failure = new Error('fetch failed');
    const client = meterModelClient({ complete: vi.fn().mockRejectedValue(failure) } as never, ledger);
    await expect(client.complete(request('persona', 'arch-lane') as never)).rejects.toBe(failure);
    expect(ledger.calls).toBe(0);
  });

  it('never lets a recording failure change the response', async () => {
    const ledger = new TokenLedger();
    vi.spyOn(ledger, 'record').mockImplementation(() => { throw new Error('boom'); });
    const res = response(1, 1);
    const client = meterModelClient({ complete: vi.fn().mockResolvedValue(res) } as never, ledger);
    await expect(client.complete(request('persona', 'a') as never)).resolves.toBe(res);
  });

  it('bounds the breakdown maps against a caller that labels every call uniquely', () => {
    const ledger = new TokenLedger();
    for (let index = 0; index < 100; index++) ledger.record(request(undefined, `label-${index}`), response(1, 0));
    const accounting = ledger.snapshot();
    expect(Object.keys(accounting.byOther)).toHaveLength(65);
    expect(accounting.byOther['other-labels']).toMatchObject({ calls: 36 });
    expect(accounting.total.calls).toBe(100);
  });
});

describe('renderTokenAccountingSummary / tokenAccountingLogFields', () => {
  it('names the basis, the role split and each lane', () => {
    const ledger = new TokenLedger();
    ledger.record(request('persona', 'arch-lane'), response(100, 20));
    ledger.record(request('persona', 'arch-lane'), response(200, 30));
    ledger.record(request('arbiter', 'arbiter'), response(30, 5));
    const line = renderTokenAccountingSummary(ledger.snapshot());
    expect(line).toContain('Tokens (every provider call): 385 total over 3 calls (prompt 330, completion 55, cached 0; $0.0030).');
    expect(line).toContain('By role: lanes 350, moderator 0, arbiter 35, other 0.');
    expect(line).toContain('Per lane: `arch-lane` 350 (2 calls).');

    const fields = tokenAccountingLogFields(ledger.snapshot());
    expect(fields).toMatchObject({
      tokenBasis: 'every_provider_call', tokensTotal: 385, tokensPrompt: 330, tokensCompletion: 55, providerCalls: 3,
      tokensByRole: { lanes: { calls: 2, total: 350 }, arbiter: { calls: 1, total: 35 } },
      tokensByLane: { 'arch-lane': { calls: 2, total: 350 } },
    });
  });
});

describe('recordProviderCallTokenMetrics', () => {
  it('adds one call to the worker token counters with its labels', () => {
    const metrics = getMetrics();
    const total = vi.spyOn(metrics.tokensTotal, 'add');
    const prompt = vi.spyOn(metrics.tokensPrompt, 'add');
    const labels = { persona: 'arch-lane', provider: 'bifrost', model: 'm' };
    recordProviderCallTokenMetrics(labels, response(100, 20));
    expect(total).toHaveBeenCalledWith(120, labels);
    expect(prompt).toHaveBeenCalledWith(100, labels);
    total.mockRestore();
    prompt.mockRestore();
  });
});
