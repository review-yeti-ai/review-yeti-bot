import { describe, expect, it } from 'vitest';
import { missingGatewaySettings, requireGatewaySettings, resolveGatewayBaseUrl, resolveGatewayApiKey, resolveGatewaySettings } from '../../src/review/openaiTransport';

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

  describe('mixed-generation provenance is refused', () => {
    // Security-relevant: a standard Bifrost key paired with the
    // OPENROUTER_BASE_URL would ship the CT credential to a third-party vendor.
    it('refuses a standard key aimed at the vendor host', () => {
      const env = {
        OPENAI_API_KEY: 'sk-bf-bifrost-key', OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
      } as unknown as NodeJS.ProcessEnv;
      expect(resolveGatewaySettings(env).status).toBe('refused');
      // Readiness must not advertise the lane either.
      expect(missingGatewaySettings(env)).toEqual(['OPENAI_BASE_URL', 'OPENAI_API_KEY']);
    });

    it('ALLOWS a legacy key on a non-vendor base URL (no leak, rollout-safe)', () => {
      // Deliberately permitted: the credential goes to OUR gateway, not a
      // vendor. Refusing this would break a mid-rollout deployment for no
      // security benefit -- the harm is the destination, not the name.
      const env = {
        OPENROUTER_API_KEY: 'legacy-key', OPENAI_BASE_URL: 'https://gateway.internal/v1',
      } as unknown as NodeJS.ProcessEnv;
      expect(resolveGatewaySettings(env)).toEqual({
        status: 'ok', baseUrl: 'https://gateway.internal/v1', apiKey: 'legacy-key',
      });
    });

    it('reports a genuinely absent setting as missing, not refused', () => {
      const env = { OPENAI_API_KEY: 'sk-bf-x' } as unknown as NodeJS.ProcessEnv;
      const r = resolveGatewaySettings(env);
      expect(r.status).toBe('missing');
      if (r.status === 'missing') expect(r.missing).toEqual(['OPENAI_BASE_URL']);
    });
  });

  describe('requireGatewaySettings never reinstates a refused pairing', () => {
    // The P1 the panel found: `|| requiredWorkerEnv(env, ...)` re-read the raw
    // env and re-admitted exactly the pair the resolver had refused.
    it('THROWS on a refused pairing instead of returning the raw values', () => {
      const env = {
        OPENAI_API_KEY: 'sk-bf-bifrost-key', OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
      } as unknown as NodeJS.ProcessEnv;
      expect(() => requireGatewaySettings(env)).toThrow(/refused/i);
      // The credential must not appear in the error or the result.
      expect(() => requireGatewaySettings(env)).not.toThrow(/sk-bf-bifrost-key/);
    });

    it('throws naming the variable when a setting is simply absent', () => {
      expect(() => requireGatewaySettings({} as unknown as NodeJS.ProcessEnv))
        .toThrow(/OPENAI_BASE_URL/);
    });

    it('returns the pair when configuration is sound', () => {
      const env = {
        OPENAI_API_KEY: 'sk-bf-x', OPENAI_BASE_URL: 'https://gateway.internal/v1',
      } as unknown as NodeJS.ProcessEnv;
      expect(requireGatewaySettings(env)).toEqual({
        baseUrl: 'https://gateway.internal/v1', apiKey: 'sk-bf-x',
      });
    });
  });
});
