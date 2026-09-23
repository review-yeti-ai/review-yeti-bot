import { describe, it, expect } from 'vitest';
import { resolveModelClientFromEnv } from '../../src/dispatchModelClient';
import { OpenRouterClient } from '../../src/gateway/openRouterClient';

describe('resolveModelClientFromEnv', () => {
  it('returns undefined when no model API key is set in environment', () => {
    const client = resolveModelClientFromEnv({});
    expect(client).toBeUndefined();
  });

  it('initializes OpenRouterClient with OPENROUTER_API_KEY as highest priority', () => {
    const client = resolveModelClientFromEnv({
      OPENROUTER_API_KEY: 'sk-or-primary',
      REVIEW_YETI_BIFROST_API_KEY: 'sk-bifrost',
      BIFROST_VIRTUAL_KEY: 'sk-virtual',
      OPENROUTER_PR_REVIEW_API_KEY: 'sk-fallback',
    });
    expect(client).toBeInstanceOf(OpenRouterClient);
    expect((client as any).apiKey).toBe('sk-or-primary');
  });

  it('falls back to REVIEW_YETI_BIFROST_API_KEY when OPENROUTER_API_KEY is unset', () => {
    const client = resolveModelClientFromEnv({
      REVIEW_YETI_BIFROST_API_KEY: 'sk-bifrost-2',
      BIFROST_VIRTUAL_KEY: 'sk-virtual-2',
      OPENROUTER_PR_REVIEW_API_KEY: 'sk-fallback-2',
    });
    expect(client).toBeInstanceOf(OpenRouterClient);
    expect((client as any).apiKey).toBe('sk-bifrost-2');
  });

  it('falls back to BIFROST_VIRTUAL_KEY when higher priority keys are unset', () => {
    const client = resolveModelClientFromEnv({
      BIFROST_VIRTUAL_KEY: 'sk-virtual-3',
      OPENROUTER_PR_REVIEW_API_KEY: 'sk-fallback-3',
    });
    expect(client).toBeInstanceOf(OpenRouterClient);
    expect((client as any).apiKey).toBe('sk-virtual-3');
  });

  it('falls back to OPENROUTER_PR_REVIEW_API_KEY as last resort', () => {
    const client = resolveModelClientFromEnv({
      OPENROUTER_PR_REVIEW_API_KEY: 'sk-fallback-4',
    });
    expect(client).toBeInstanceOf(OpenRouterClient);
    expect((client as any).apiKey).toBe('sk-fallback-4');
  });

  it('prefers OPENROUTER_BASE_URL over BIFROST_BASE_URL', () => {
    const client = resolveModelClientFromEnv({
      OPENROUTER_API_KEY: 'sk-test',
      OPENROUTER_BASE_URL: 'https://custom-or.ai/v1',
      BIFROST_BASE_URL: 'http://bifrost.internal:8080/v1',
    });
    expect(client).toBeInstanceOf(OpenRouterClient);
    expect((client as any).baseUrl).toBe('https://custom-or.ai/v1');
  });

  it('falls back to BIFROST_BASE_URL when OPENROUTER_BASE_URL is unset', () => {
    const client = resolveModelClientFromEnv({
      OPENROUTER_API_KEY: 'sk-test',
      BIFROST_BASE_URL: 'http://bifrost.internal:8080/v1',
    });
    expect(client).toBeInstanceOf(OpenRouterClient);
    expect((client as any).baseUrl).toBe('http://bifrost.internal:8080/v1');
  });

  it('defaults baseUrl to https://openrouter.ai/api/v1 when neither baseUrl is specified', () => {
    const client = resolveModelClientFromEnv({
      OPENROUTER_API_KEY: 'sk-test',
    });
    expect(client).toBeInstanceOf(OpenRouterClient);
    expect((client as any).baseUrl).toBe('https://openrouter.ai/api/v1');
  });
});
