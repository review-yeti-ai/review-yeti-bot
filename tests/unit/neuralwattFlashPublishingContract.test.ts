import { describe, expect, it } from 'vitest';
import { NEURALWATT_FLASH_ROUTE_MODEL, resolveWorkerConfig } from '../../src/config/publishingWorkerConfig';
import { buildOpenRouterChatRequest } from '../../src/gateway/openRouterClient';
import { createOpenAIPublishingConfig, openaiTransport } from '../../src/review/openaiTransport';

const baseUrl = 'https://gateway.ai.cloudflare.com/v1/11111111111111111111111111111111/ct-pilot-neuralwatt/compat';
const model = NEURALWATT_FLASH_ROUTE_MODEL;
const runToken = 'test-run-token';

function selectedTransport() {
  return openaiTransport({
    CLOUDFLARE_AIG_BASE_URL: baseUrl,
    CLOUDFLARE_AIG_RUN_TOKEN: runToken,
    REVIEW_MODEL: model,
  } as unknown as NodeJS.ProcessEnv);
}

function policy(reasoningEffort?: string) {
  return {
    REVIEW_YETI_POLICY_JSON: JSON.stringify({ review_yeti: {
      personas: 'security',
      budget: { max_investigation_turns: 10 },
      ...(reasoningEffort === undefined ? {} : {
        transports: [{ name: 'bifrost', enabled: true, reasoning_effort: reasoningEffort }],
      }),
    } }),
  };
}

describe('Neuralwatt Flash app-gate route contract', () => {
  it('selects the standard dynamic route and sends low effort without worker-side fallback', () => {
    const transport = selectedTransport();
    const config = resolveWorkerConfig(policy('low'), transport);
    const selectedProvider = config.reviewers.providers[0];

    expect(transport).toMatchObject({ baseUrl, model, authorizationHeaderName: 'cf-aig-authorization' });
    expect(config.reviewers).toMatchObject({
      fallback: 'none',
      providers: [{ id: 'bifrost', model, effort: 'low' }],
      arbiter: { order: ['bifrost'] },
    });
    expect(config.reviewer_effort).toBe('low');
    expect(JSON.stringify(config)).not.toContain(runToken);

    const body = buildOpenRouterChatRequest({
      model: selectedProvider.model,
      messages: [{ role: 'user', content: 'Review the supplied diff.' }],
      reasoningEffort: selectedProvider.effort,
      timeoutMs: 5_000,
      stream: false,
    });
    expect(body).toMatchObject({ model, reasoning_effort: 'low' });
    expect(body).not.toHaveProperty('models');
  });

  it('defaults this selected route to low effort but refuses a central policy that requests more', () => {
    const transport = selectedTransport();
    expect(resolveWorkerConfig(policy(), transport).reviewers.providers[0].effort).toBe('low');
    expect(() => resolveWorkerConfig(policy('medium'), transport))
      .toThrow(/review policy could not be parsed/u);
  });

  it('keeps the exported publishing config single-route and low effort for this model', () => {
    const config = createOpenAIPublishingConfig(model);
    expect(config.reviewers).toMatchObject({
      fallback: 'none',
      providers: [{ id: 'bifrost', model, effort: 'low' }],
      arbiter: { order: ['bifrost'] },
    });
  });
});
