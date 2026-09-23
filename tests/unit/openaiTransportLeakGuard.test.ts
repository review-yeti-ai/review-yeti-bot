import { describe, expect, it } from 'vitest';
import { openaiTransport } from '../../src/review/openaiTransport';

/**
 * REL-1069 review (P1). `openaiTransport` is the publishing lane's transport
 * builder -- the path that actually TRANSMITS the credential. It previously
 * resolved its two settings with the UNPAIRED helpers, so the mixed-generation
 * leak guard never applied here even though `/ready` enforced it.
 *
 * Guarded at this boundary rather than only through the resolver, because the
 * bug was precisely that this call site used a different function.
 */
describe('publishing transport refuses a leaked credential pairing', () => {
  const base = { REVIEW_MODEL: 'pr-reviewer' };

  it('refuses a CT/Bifrost key aimed at the OpenRouter vendor host', () => {
    const env = {
      ...base,
      OPENAI_API_KEY: 'sk-bf-ct-virtual-key',
      OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
    } as unknown as NodeJS.ProcessEnv;
    expect(() => openaiTransport(env)).toThrow();
  });

  it('accepts the same key against the CT gateway', () => {
    const env = {
      ...base,
      OPENAI_API_KEY: 'sk-bf-ct-virtual-key',
      OPENAI_BASE_URL: 'https://gateway-internal.example/v1',
    } as unknown as NodeJS.ProcessEnv;
    expect(openaiTransport(env)).toMatchObject({
      baseUrl: 'https://gateway-internal.example/v1', apiKey: 'sk-bf-ct-virtual-key',
    });
  });

  it('accepts a self-consistent legacy pair so an older deployment still boots', () => {
    const env = {
      ...base,
      OPENROUTER_API_KEY: 'legacy',
      OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
    } as unknown as NodeJS.ProcessEnv;
    expect(openaiTransport(env)).toMatchObject({ baseUrl: 'https://openrouter.ai/api/v1' });
  });
});
