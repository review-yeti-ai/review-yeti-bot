import { describe, expect, it, vi } from 'vitest';
import { createDisputedBlockerAdjudicatorClient } from '../../src/review/disputedBlockerAdjudicator';
import type { ReviewModelClient } from '../../src/gateway/openRouterClient';

describe('configured disputed-blocker adjudicator client', () => {
  it('uses the configured Bifrost model/effort and calibrated reasoning/output budget while preserving timeout, signal and response identity', async () => {
    const response = { model: 'gateway-reported-alias', content: '{"status":"confirmed"}', usage: { prompt: 3, completion: 4, total: 7 } } as any;
    const primaryComplete = vi.fn(async (_request: unknown) => response);
    const selection = { version: 'DisputedBlockerAdjudicator.v1' as const,
      model: 'qualified-adjudicator-alias', reasoning_effort: 'high' as const };
    const route = createDisputedBlockerAdjudicatorClient({ complete: primaryComplete } as ReviewModelClient, selection);
    const controller = new AbortController();
    const request = { model: selection.model, messages: [{ role: 'user', content: 'Evidence only' }],
      timeoutMs: 12_000, maxTokens: 2_000, persona: 'independent-grounded-verifier', signal: controller.signal } as any;

    const actual = await route.client.complete(request);

    expect(route).toMatchObject({ model: selection.model, reasoningEffort: 'high' });
    expect(primaryComplete).toHaveBeenCalledOnce();
    expect(primaryComplete.mock.calls[0][0]).toMatchObject({ model: selection.model, reasoningEffort: 'high',
      timeoutMs: 12_000, maxTokens: 4_096, reasoning: { effort: 'high', max_tokens: 2_048 },
      persona: 'independent-grounded-verifier', signal: controller.signal });
    expect(actual).toBe(response);
    expect(actual.model).toBe('gateway-reported-alias');
  });

  it('rejects primary model substitution without fallback', async () => {
    const complete = vi.fn(async () => ({ content: 'unexpected' } as any));
    const route = createDisputedBlockerAdjudicatorClient({ complete } as ReviewModelClient, {
      version: 'DisputedBlockerAdjudicator.v1', model: 'qualified-adjudicator-alias', reasoning_effort: 'xhigh',
    });
    await expect(route.client.complete({ model: 'primary-review-alias', messages: [] } as any))
      .rejects.toThrow(/configured adjudicator model/u);
    expect(complete).not.toHaveBeenCalled();
  });

  it.each([
    ['model fallback', { model: 'qualified-adjudicator-alias', models: ['other-model'] }],
    ['provider override', { model: 'qualified-adjudicator-alias', provider: { order: ['direct-provider'] } }],
    ['retry override', { model: 'qualified-adjudicator-alias', maxRetries: 5 }],
  ])('rejects an adjudicator %s without dispatching it', async (_label, override) => {
    const complete = vi.fn(async () => ({ content: 'unexpected' } as any));
    const route = createDisputedBlockerAdjudicatorClient({ complete } as ReviewModelClient, {
      version: 'DisputedBlockerAdjudicator.v1', model: 'qualified-adjudicator-alias', reasoning_effort: 'high',
    });
    const request = Object.assign({ model: 'qualified-adjudicator-alias', messages: [], timeoutMs: 1_000, maxTokens: 2_000 }, override);
    await expect(route.client.complete(request as any)).rejects.toThrow(/adjudicator/u);
    expect(complete).not.toHaveBeenCalled();
  });
});
