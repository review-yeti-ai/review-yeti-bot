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

  // Every accepted spelling must be proven to resolve ALONE. Without this, a
  // typo'd or dropped fallback name passes the whole suite while a deployment
  // configured with that name flips to 503 (REL-1069 review).
  it.each([
    ['REVIEW_YETI_GATEWAY_BASE_URL'],
    ['BIFROST_BASE_URL'],
    ['OPENROUTER_BASE_URL'],
  ])('accepts %s as the only base URL spelling', (name) => {
    const env = { OPENAI_API_KEY: 'sk-bf-x', [name]: 'https://gw.example/v1' } as unknown as NodeJS.ProcessEnv;
    expect(missingGatewaySettings(env)).toEqual([]);
    expect(resolveGatewayBaseUrl(env)).toBe('https://gw.example/v1');
  });

  it.each([
    ['REVIEW_YETI_BIFROST_API_KEY'],
    ['BIFROST_VIRTUAL_KEY'],
    ['OPENROUTER_REVIEW_FLEET_KEY'],
    ['OPENROUTER_PR_REVIEW_API_KEY'],
    ['OPENROUTER_API_KEY'],
  ])('accepts %s as the only gateway key spelling', (name) => {
    const env = { OPENAI_BASE_URL: 'https://gw.example/v1', [name]: 'k' } as unknown as NodeJS.ProcessEnv;
    expect(missingGatewaySettings(env)).toEqual([]);
    expect(resolveGatewayApiKey(env)).toBe('k');
  });

  it('prefers the standard name when several spellings are present', () => {
    const env = {
      OPENAI_API_KEY: 'standard', OPENROUTER_API_KEY: 'legacy',
      OPENAI_BASE_URL: 'https://standard/v1', OPENROUTER_BASE_URL: 'https://legacy/v1',
    } as unknown as NodeJS.ProcessEnv;
    expect(resolveGatewayApiKey(env)).toBe('standard');
    expect(resolveGatewayBaseUrl(env)).toBe('https://standard/v1');
  });
});
