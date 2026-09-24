import { describe, expect, it } from 'vitest';
import { openaiTransport, invalidPublishingReviewContract } from '../../src/review/openaiTransport';

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
    // Asserts the CONTRACT message, not merely that something threw: callers
    // match on invalidPublishingReviewContract's text, so a refactor that let
    // a generic error propagate would break them while passing toThrow().
    expect(() => openaiTransport(env)).toThrow(invalidPublishingReviewContract().message);
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

  // The trailing dot is a valid FQDN root and reaches the same endpoint, so the
  // un-normalised form was a silent bypass of the leak guard.
  it('refuses the trailing-dot vendor host', () => {
    const env = {
      ...base,
      OPENAI_API_KEY: 'sk-bf-ct-virtual-key',
      OPENROUTER_BASE_URL: 'https://openrouter.ai./api/v1',
    } as unknown as NodeJS.ProcessEnv;
    expect(() => openaiTransport(env)).toThrow(invalidPublishingReviewContract().message);
  });

  it('refuses a vendor SUBDOMAIN too', () => {
    const env = {
      ...base,
      OPENAI_API_KEY: 'sk-bf-ct-virtual-key',
      OPENROUTER_BASE_URL: 'https://api.openrouter.ai/v1',
    } as unknown as NodeJS.ProcessEnv;
    expect(() => openaiTransport(env)).toThrow(invalidPublishingReviewContract().message);
  });

  it('does not over-refuse a lookalike host', () => {
    // `notopenrouter.ai` must NOT match, or the guard breaks a legitimate lane.
    const env = {
      ...base,
      OPENAI_API_KEY: 'sk-bf-ct-virtual-key',
      OPENROUTER_BASE_URL: 'https://notopenrouter.ai/v1',
    } as unknown as NodeJS.ProcessEnv;
    expect(() => openaiTransport(env)).not.toThrow();
  });

  // A one-keystroke typo must not read as ready: `isVendorHost`'s catch returned
  // false, so resolution reported ok and /ready answered 200 while the client
  // threw at request time.
  it('refuses a scheme-less base URL', () => {
    const env = {
      ...base, OPENAI_API_KEY: 'sk-bf-ct-virtual-key', OPENAI_BASE_URL: 'gateway.internal/v1',
    } as unknown as NodeJS.ProcessEnv;
    expect(() => openaiTransport(env)).toThrow(invalidPublishingReviewContract().message);
  });

  it('refuses a plaintext base URL', () => {
    const env = {
      ...base, OPENAI_API_KEY: 'sk-bf-ct-virtual-key', OPENAI_BASE_URL: 'http://gateway.internal/v1',
    } as unknown as NodeJS.ProcessEnv;
    expect(() => openaiTransport(env)).toThrow(invalidPublishingReviewContract().message);
  });

  it('refuses the multi-dot vendor host', () => {
    // Normalising exactly one trailing dot was itself a bypass.
    const env = {
      ...base,
      OPENAI_API_KEY: 'sk-bf-ct-virtual-key',
      OPENROUTER_BASE_URL: 'https://openrouter.ai../api/v1',
    } as unknown as NodeJS.ProcessEnv;
    expect(() => openaiTransport(env)).toThrow(invalidPublishingReviewContract().message);
  });

  it('still accepts a legitimate https gateway', () => {
    const env = {
      ...base, OPENAI_API_KEY: 'sk-bf-ct-virtual-key', OPENAI_BASE_URL: 'https://gateway-internal.example/v1',
    } as unknown as NodeJS.ProcessEnv;
    expect(() => openaiTransport(env)).not.toThrow();
  });
});
