import { describe, expect, it } from 'vitest';
import { missingGatewaySettings, resolveGatewayBaseUrl, resolveGatewayApiKey } from '../../src/review/openaiTransport';

describe('gateway setting contract', () => {
  it('reports the base URL missing when every spelling is absent', () => {
    const env = { OPENAI_API_KEY: 'sk-bf-x' } as unknown as NodeJS.ProcessEnv;
    expect(missingGatewaySettings(env)).toEqual(['OPENAI_BASE_URL']);
  });
  it('reports the key missing when every spelling is absent', () => {
    const env = { OPENAI_BASE_URL: 'https://gw.example/v1' } as unknown as NodeJS.ProcessEnv;
    expect(missingGatewaySettings(env)).toEqual(['OPENAI_API_KEY']);
  });
  it('ignores a base URL that is only whitespace', () => {
    const env = { OPENAI_API_KEY: 'sk-bf-x', OPENAI_BASE_URL: '   ' } as unknown as NodeJS.ProcessEnv;
    expect(missingGatewaySettings(env)).toEqual(['OPENAI_BASE_URL']);
  });
  it('accepts a legacy-only environment (rollout fallback)', () => {
    const env = { OPENROUTER_API_KEY: 'legacy', OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1' } as unknown as NodeJS.ProcessEnv;
    expect(missingGatewaySettings(env)).toEqual([]);
  });
  it('is empty when both standard names are set', () => {
    const env = { OPENAI_API_KEY: 'sk-bf-x', OPENAI_BASE_URL: 'https://gw.example/v1' } as unknown as NodeJS.ProcessEnv;
    expect(missingGatewaySettings(env)).toEqual([]);
    expect(resolveGatewayApiKey(env)).toBe('sk-bf-x');
    expect(resolveGatewayBaseUrl(env)).toBe('https://gw.example/v1');
  });
});
