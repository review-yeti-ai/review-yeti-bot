import { describe, expect, it } from 'vitest';
import { openaiTransport, invalidPublishingReviewContract } from '../../src/review/openaiTransport';

const route = 'https://gateway.ai.cloudflare.com/v1/11111111111111111111111111111111/test/compat';
const providerRoute = 'https://gateway.ai.cloudflare.com/v1/11111111111111111111111111111111/test/custom-neuralwatt/v1';

describe('publishing transport admits only the dedicated Cloudflare Run route', () => {
  const base = { REVIEW_MODEL: 'dynamic/nw-flash' };

  it('pairs the Cloudflare compatibility route only with its dedicated Run token', () => {
    const env = {
      ...base,
      CLOUDFLARE_AIG_BASE_URL: route,
      CLOUDFLARE_AIG_RUN_TOKEN: 'test-run-token',
      OPENAI_API_KEY: 'unrelated-generic-key',
      OPENAI_BASE_URL: 'https://generic.example.invalid/v1',
    } as unknown as NodeJS.ProcessEnv;
    expect(openaiTransport(env)).toEqual({
      baseUrl: route,
      apiKey: 'test-run-token',
      model: 'dynamic/nw-flash',
      authorizationHeaderName: 'cf-aig-authorization',
    });
  });

  it('refuses a provider-native custom URL for the dynamic model because it bypasses the dynamic fallback route', () => {
    const env = {
      ...base,
      CLOUDFLARE_AIG_BASE_URL: providerRoute,
      CLOUDFLARE_AIG_RUN_TOKEN: 'test-run-token',
    } as unknown as NodeJS.ProcessEnv;
    expect(() => openaiTransport(env)).toThrow(invalidPublishingReviewContract().message);
  });

  it('rejects a malformed dynamic route name on /compat', () => {
    const env = {
      CLOUDFLARE_AIG_BASE_URL: route,
      CLOUDFLARE_AIG_RUN_TOKEN: 'test-run-token',
      REVIEW_MODEL: 'dynamic/',
    } as unknown as NodeJS.ProcessEnv;
    expect(() => openaiTransport(env)).toThrow(invalidPublishingReviewContract().message);
  });

  it('keeps a provider-native custom URL paired with a concrete upstream model', () => {
    const env = {
      CLOUDFLARE_AIG_BASE_URL: providerRoute,
      CLOUDFLARE_AIG_RUN_TOKEN: 'test-run-token',
      REVIEW_MODEL: 'deepseek-ai/DeepSeek-V4.1-Flash',
    } as unknown as NodeJS.ProcessEnv;
    expect(openaiTransport(env)).toMatchObject({
      baseUrl: providerRoute,
      model: 'deepseek-ai/DeepSeek-V4.1-Flash',
      authorizationHeaderName: 'cf-aig-authorization',
    });
  });

  it.each(['pr-reviewer', 'bifrost/pr-reviewer'])('refuses unresolved historical alias %s', (model) => {
    const env = { CLOUDFLARE_AIG_BASE_URL: route, CLOUDFLARE_AIG_RUN_TOKEN: 'test-run-token', REVIEW_MODEL: model } as unknown as NodeJS.ProcessEnv;
    expect(() => openaiTransport(env)).toThrow(invalidPublishingReviewContract().message);
  });

  it('does not fall back to a generic key when the dedicated token is absent', () => {
    const env = {
      ...base,
      CLOUDFLARE_AIG_BASE_URL: route,
      OPENAI_API_KEY: 'generic-key',
      OPENAI_BASE_URL: route,
    } as unknown as NodeJS.ProcessEnv;
    expect(() => openaiTransport(env)).toThrow(invalidPublishingReviewContract().message);
  });

  it('does not use the ambiguous CLOUDFLARE_AIG_API_TOKEN name', () => {
    const env = {
      ...base,
      CLOUDFLARE_AIG_BASE_URL: route,
      CLOUDFLARE_AIG_API_TOKEN: 'ambiguous-token',
    } as unknown as NodeJS.ProcessEnv;
    expect(() => openaiTransport(env)).toThrow(invalidPublishingReviewContract().message);
  });

  it('rejects a generic OpenAI-compatible publishing route', () => {
    const env = {
      ...base,
      OPENAI_API_KEY: 'generic-key',
      OPENAI_BASE_URL: 'https://gateway.example.invalid/v1',
    } as unknown as NodeJS.ProcessEnv;
    expect(() => openaiTransport(env)).toThrow(invalidPublishingReviewContract().message);
  });

  it('rejects a malformed Cloudflare route before transport construction', () => {
    const env = {
      ...base,
      CLOUDFLARE_AIG_BASE_URL: 'https://gateway.ai.cloudflare.com/v1/account/gateway/custom-provider/v1',
      CLOUDFLARE_AIG_RUN_TOKEN: 'test-run-token',
    } as unknown as NodeJS.ProcessEnv;
    expect(() => openaiTransport(env)).toThrow(invalidPublishingReviewContract().message);
  });
});
