import { describe, it, expect } from 'vitest';
import { resolveModelClientFromEnv } from '../../src/dispatchModelClient';
import { OpenRouterClient } from '../../src/gateway/openRouterClient';

const route = 'https://gateway.ai.cloudflare.com/v1/11111111111111111111111111111111/test/custom-example/v1';

describe('resolveModelClientFromEnv', () => {
  it('returns undefined when no model credential is configured', () => {
    expect(resolveModelClientFromEnv({})).toBeUndefined();
  });

  it('keeps the separate direct OpenRouter credential path', () => {
    const client = resolveModelClientFromEnv({ OPENROUTER_API_KEY: 'openrouter-key', OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1' });
    expect(client).toBeInstanceOf(OpenRouterClient);
    expect((client as any).apiKey).toBe('openrouter-key');
    expect((client as any).authorizationHeaderName).toBe('authorization');
  });

  it('ignores retired Bifrost credentials when no current transport is configured', () => {
    const client = resolveModelClientFromEnv({
      REVIEW_YETI_BIFROST_API_KEY: 'retired-key',
      BIFROST_VIRTUAL_KEY: 'retired-key',
      BIFROST_BASE_URL: 'https://gateway.example.invalid/v1',
    });
    expect(client).toBeUndefined();
  });

  it('uses the dedicated Cloudflare Run token and its explicit route', () => {
    const client = resolveModelClientFromEnv({ CLOUDFLARE_AIG_RUN_TOKEN: 'run-token', CLOUDFLARE_AIG_BASE_URL: route });
    expect(client).toBeInstanceOf(OpenRouterClient);
    expect((client as any).apiKey).toBe('run-token');
    expect((client as any).baseUrl).toBe(route);
    expect((client as any).authorizationHeaderName).toBe('cf-aig-authorization');
  });

  it('does not borrow OpenRouter or generic keys for a partial Cloudflare configuration', () => {
    const client = resolveModelClientFromEnv({
      CLOUDFLARE_AIG_BASE_URL: route,
      OPENROUTER_API_KEY: 'openrouter-key',
      OPENAI_API_KEY: 'generic-key',
    });
    expect(client).toBeUndefined();
  });

  it('does not treat CLOUDFLARE_AIG_API_TOKEN as the dedicated Run token', () => {
    const client = resolveModelClientFromEnv({ CLOUDFLARE_AIG_BASE_URL: route, CLOUDFLARE_AIG_API_TOKEN: 'ambiguous' });
    expect(client).toBeUndefined();
  });
});
