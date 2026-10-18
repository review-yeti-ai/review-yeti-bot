import { describe, expect, it } from 'vitest';
import { missingGatewaySettings, requireGatewaySettings, resolveGatewaySettings } from '../../src/review/openaiTransport';

const cloudflareBaseUrl = 'https://gateway.ai.cloudflare.com/v1/11111111111111111111111111111111/test/custom-example/v1';

describe('gateway setting contract', () => {
  it('accepts the dedicated Cloudflare base URL and Run token as a pair', () => {
    const env = { CLOUDFLARE_AIG_BASE_URL: cloudflareBaseUrl, CLOUDFLARE_AIG_RUN_TOKEN: 'run-token' } as unknown as NodeJS.ProcessEnv;
    expect(missingGatewaySettings(env)).toEqual([]);
    expect(requireGatewaySettings(env)).toEqual({
      baseUrl: cloudflareBaseUrl,
      apiKey: 'run-token',
      authorizationHeaderName: 'cf-aig-authorization',
    });
  });

  it('does not borrow a generic credential when Cloudflare configuration is partial', () => {
    const env = {
      CLOUDFLARE_AIG_BASE_URL: cloudflareBaseUrl,
      OPENAI_API_KEY: 'generic-key',
      OPENAI_BASE_URL: 'https://generic.example.invalid/v1',
    } as unknown as NodeJS.ProcessEnv;
    expect(resolveGatewaySettings(env)).toEqual({ status: 'missing', missing: ['CLOUDFLARE_AIG_RUN_TOKEN'] });
    expect(() => requireGatewaySettings(env)).toThrow(/CLOUDFLARE_AIG_RUN_TOKEN/u);
  });

  it('rejects an ambiguous existing Cloudflare token name', () => {
    const env = { CLOUDFLARE_AIG_API_TOKEN: 'ambiguous', CLOUDFLARE_AIG_BASE_URL: cloudflareBaseUrl } as unknown as NodeJS.ProcessEnv;
    expect(resolveGatewaySettings(env)).toEqual({ status: 'missing', missing: ['CLOUDFLARE_AIG_RUN_TOKEN'] });
  });

  it('rejects a Cloudflare Run token paired with a non Cloudflare route', () => {
    const env = { CLOUDFLARE_AIG_RUN_TOKEN: 'run-token', CLOUDFLARE_AIG_BASE_URL: 'https://gateway.example.invalid/v1' } as unknown as NodeJS.ProcessEnv;
    expect(resolveGatewaySettings(env)).toMatchObject({ status: 'refused' });
  });

  it('rejects a generic key aimed at the Cloudflare Gateway host', () => {
    const env = { OPENAI_API_KEY: 'generic-key', OPENAI_BASE_URL: cloudflareBaseUrl } as unknown as NodeJS.ProcessEnv;
    expect(resolveGatewaySettings(env)).toEqual({
      status: 'refused',
      reason: 'gateway destination requires its dedicated credential',
    });
  });

  it('keeps generic OpenAI-compatible settings available to other callers', () => {
    const env = { OPENAI_API_KEY: 'generic-key', OPENAI_BASE_URL: 'https://gateway.example.invalid/v1' } as unknown as NodeJS.ProcessEnv;
    expect(missingGatewaySettings(env)).toEqual([]);
    expect(requireGatewaySettings(env)).toEqual({
      baseUrl: 'https://gateway.example.invalid/v1',
      apiKey: 'generic-key',
      authorizationHeaderName: 'authorization',
    });
  });

  it('keeps a named OpenRouter pair working for its separate direct transport', () => {
    const env = { OPENROUTER_API_KEY: 'openrouter-key', OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1' } as unknown as NodeJS.ProcessEnv;
    expect(requireGatewaySettings(env)).toEqual({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'openrouter-key',
      authorizationHeaderName: 'authorization',
    });
  });

  it('does not accept retired Bifrost-only names', () => {
    const env = {
      BIFROST_BASE_URL: 'https://gateway.example.invalid/v1',
      REVIEW_YETI_BIFROST_API_KEY: 'retired-key',
      BIFROST_VIRTUAL_KEY: 'retired-key',
    } as unknown as NodeJS.ProcessEnv;
    expect(missingGatewaySettings(env)).toEqual(['OPENAI_BASE_URL', 'OPENAI_API_KEY']);
  });

  it('reports only the dedicated Cloudflare setting missing when its base is configured', () => {
    const env = { CLOUDFLARE_AIG_BASE_URL: cloudflareBaseUrl } as unknown as NodeJS.ProcessEnv;
    expect(missingGatewaySettings(env)).toEqual(['CLOUDFLARE_AIG_RUN_TOKEN']);
  });
});
