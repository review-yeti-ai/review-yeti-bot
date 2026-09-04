import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  normalizeOpenRouterModel,
  getStaticModelMetadata,
  resolveModelMetadata,
  calculateSafeDiffCapacity,
  clearModelMetadataCache,
} from '../../src/gateway/openRouterClient';
import { parseAndValidateConfig, ConfigValidationError } from '../../src/config/configLoader';

describe('Adversarial Stress Test: Dynamic Model Discovery & Budget Calculation (Milestone 1)', () => {
  beforeEach(() => {
    clearModelMetadataCache();
    vi.restoreAllMocks();
  });

  describe('1. Extreme & Malformed Model Identifiers', () => {
    it('handles empty strings and whitespace-only model IDs safely', () => {
      const emptyStatic = getStaticModelMetadata('');
      expect(emptyStatic.contextLength).toBe(128_000);
      expect(emptyStatic.supportsTools).toBe(true);

      const whitespaceStatic = getStaticModelMetadata('   \t\n  ');
      expect(whitespaceStatic.contextLength).toBe(128_000);

      const normalizedEmpty = normalizeOpenRouterModel('');
      expect(normalizedEmpty).toBe('');

      const normalizedWs = normalizeOpenRouterModel('   deepseek/deepseek-v4-flash-0731   ');
      expect(normalizedWs).toBe('deepseek/deepseek-v4-flash-0731');
    });

    it('resolves custom and unknown model IDs with safe universal fallback (128k context)', () => {
      const unknown1 = getStaticModelMetadata('unknown/custom-model:deep');
      expect(unknown1.contextLength).toBe(128_000);
      expect(unknown1.contextTokens).toBe(128_000);
      expect(unknown1.id).toBe('unknown/custom-model:deep');

      const unknown2 = getStaticModelMetadata('enterprise-private/finetuned-llama:v1');
      expect(unknown2.contextLength).toBe(128_000);
    });

    it('handles models with arbitrary reasoning suffixes correctly', () => {
      const modelsWithSuffixes = [
        { id: 'deepseek/deepseek-v4-flash-0731:low', expectedContext: 128_000 },
        { id: 'deepseek/deepseek-v4-flash-0731:high', expectedContext: 128_000 },
        { id: 'deepseek/deepseek-v4-flash-0731:deep', expectedContext: 128_000 },
        { id: 'deepseek/deepseek-v4-flash-0731:thought', expectedContext: 128_000 },
        { id: 'google/gemini-3.7-flash:high', expectedContext: 1_048_576 },
        { id: 'google/gemini-3.7-flash:thinking-heavy', expectedContext: 1_048_576 },
        { id: 'google/gemini-2.5-pro:extended', expectedContext: 2_097_152 },
        { id: 'anthropic/claude-3.7-sonnet:thinking', expectedContext: 200_000 },
        { id: 'qwen/qwen-3.8-27b:max', expectedContext: 128_000 },
        { id: 'openai/gpt-5.6-luna:custom-effort', expectedContext: 128_000 },
      ];

      for (const { id, expectedContext } of modelsWithSuffixes) {
        const meta = getStaticModelMetadata(id);
        expect(meta.contextLength).toBe(expectedContext);
      }
    });

    it('handles special characters, unicode, and extreme string lengths safely without crashing', () => {
      const specialInputs = [
        '../malicious/path/traversal',
        '<script>alert("xss")</script>',
        '🤖/gpt-turbo-🔥:high',
        'deepseek/模型:low',
        'model::with:::multiple::::colons',
        'a/'.repeat(500) + 'deepseek-v4-flash',
        'x'.repeat(10_000),
      ];

      for (const input of specialInputs) {
        expect(() => getStaticModelMetadata(input)).not.toThrow();
        const meta = getStaticModelMetadata(input);
        expect(meta.contextLength).toBeGreaterThanOrEqual(128_000);
        expect(meta.id).toBeDefined();
      }
    });

    it('normalizes various legacy provider aliases consistently', () => {
      const cases: Array<[string, string]> = [
        ['claude-opus-4-8', 'anthropic/claude-opus-4.8'],
        ['claude/claude-opus-4-8', 'anthropic/claude-opus-4.8'],
        ['agy/claude-opus-4-6-thinking', 'anthropic/claude-opus-4.8'],
        ['grok-cli/grok-4.5', 'x-ai/grok-4.5'],
        ['codex/gpt-5.6-sol-high', 'openai/gpt-5.6-sol'],
        ['codex-gateway/gpt-5.6-sol-high', 'openai/gpt-5.6-sol'],
        ['opencode-go/glm-5.2', 'z-ai/glm-5.2'],
        ['synthetic/glm-5.2', 'z-ai/glm-5.2'],
        ['synthetic-new/glm-5.2-high', 'z-ai/glm-5.2'],
        ['glm-5.2', 'z-ai/glm-5.2'],
        ['openrouter/5.6-luna-high', 'openai/gpt-5.6-luna'],
        ['5.6-luna-high', 'openai/gpt-5.6-luna'],
        ['openrouter/openai/gpt-5.6-luna', 'openai/gpt-5.6-luna'],
        ['openai/gpt-5.6-luna', 'openai/gpt-5.6-luna'],
        ['openrouter/auto', 'openrouter/auto'],
        ['synthetic/custom-model', 'z-ai/glm-5.2'],
      ];

      for (const [input, expected] of cases) {
        expect(normalizeOpenRouterModel(input)).toBe(expected);
      }
    });
  });

  describe('2. High-Concurrency Deduplication & Network Resilience', () => {
    it('deduplicates 100 simultaneous concurrent resolution requests for the same model to a single network call', async () => {
      let fetchCallCount = 0;
      const mockFetch = vi.fn().mockImplementation(async () => {
        fetchCallCount++;
        // Simulate network latency
        await new Promise((resolve) => setTimeout(resolve, 20));
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'deepseek/deepseek-v4-flash-0731',
                context_length: 131_072,
                pricing: { prompt: '0.00000014', completion: '0.00000028' },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      });

      const promises = Array.from({ length: 100 }, () =>
        resolveModelMetadata('deepseek/deepseek-v4-flash-0731:low', 'test-api-key', {
          baseUrl: 'https://openrouter.test/api/v1',
          fetchImplementation: mockFetch,
        })
      );

      const results = await Promise.all(promises);

      expect(fetchCallCount).toBe(1);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(results).toHaveLength(100);
      for (const res of results) {
        expect(res.contextLength).toBe(131_072);
        expect(res.id).toBe('deepseek/deepseek-v4-flash-0731:low');
      }
    });

    it('shares a single in-flight /models request across 50 concurrent requests for multiple distinct models', async () => {
      let fetchCallCount = 0;
      const mockFetch = vi.fn().mockImplementation(async () => {
        fetchCallCount++;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return new Response(
          JSON.stringify({
            data: [
              { id: 'deepseek/deepseek-v4-flash-0731', context_length: 128_000 },
              { id: 'google/gemini-3.7-flash', context_length: 1_048_576 },
              { id: 'anthropic/claude-3.7-sonnet', context_length: 200_000 },
              { id: 'qwen/qwen-3.8-27b', context_length: 131_072 },
              { id: 'openai/gpt-5.6-luna', context_length: 128_000 },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      });

      const models = [
        'deepseek/deepseek-v4-flash-0731:low',
        'google/gemini-3.7-flash:high',
        'anthropic/claude-3.7-sonnet',
        'qwen/qwen-3.8-27b:high',
        'openrouter/5.6-luna-high',
      ];

      // 50 total concurrent requests spread across 5 models
      const promises = Array.from({ length: 50 }, (_, i) => {
        const modelId = models[i % models.length];
        return resolveModelMetadata(modelId, 'test-api-key', {
          baseUrl: 'https://openrouter.test/api/v1',
          fetchImplementation: mockFetch,
        });
      });

      const results = await Promise.all(promises);

      expect(fetchCallCount).toBe(1);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Verify each model received its correct metadata
      for (let i = 0; i < results.length; i++) {
        const modelId = models[i % models.length];
        const res = results[i];
        if (modelId.includes('gemini')) {
          expect(res.contextLength).toBe(1_048_576);
        } else if (modelId.includes('claude')) {
          expect(res.contextLength).toBe(200_000);
        } else if (modelId.includes('qwen')) {
          expect(res.contextLength).toBe(131_072);
        } else {
          expect(res.contextLength).toBe(128_000);
        }
      }
    });

    it('does not deadlock or leak unhandled rejections when concurrent requests encounter network failure', async () => {
      const mockFetch = vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        throw new Error('Network connection reset by peer (ECONNRESET)');
      });

      const promises = Array.from({ length: 30 }, () =>
        resolveModelMetadata('google/gemini-2.5-pro', 'test-api-key', {
          baseUrl: 'https://openrouter.test/api/v1',
          fetchImplementation: mockFetch,
        })
      );

      const results = await Promise.all(promises);

      expect(results).toHaveLength(30);
      for (const res of results) {
        expect(res.contextLength).toBe(2_097_152); // Fallback static table
      }
    });

    it('handles HTTP 401 Unauthorized, 429 Rate Limit, and 503 Service Unavailable gracefully with static fallback', async () => {
      const errorStatuses = [401, 429, 500, 502, 503, 504];

      for (const status of errorStatuses) {
        clearModelMetadataCache();
        const mockFetch = vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ error: { message: `HTTP Error ${status}` } }), {
            status,
            headers: { 'content-type': 'application/json' },
          })
        );

        const meta = await resolveModelMetadata('deepseek/deepseek-v4-flash-0731:low', 'test-api-key', {
          baseUrl: 'https://openrouter.test/api/v1',
          fetchImplementation: mockFetch,
        });

        expect(meta.contextLength).toBe(128_000);
        expect(meta.supportsTools).toBe(true);
      }
    });

    it('handles timeout abort signals without crashing or hanging', async () => {
      const mockFetch = vi.fn().mockImplementation(
        (_url: string, init?: RequestInit) =>
          new Promise((_, reject) => {
            const signal = init?.signal;
            if (signal) {
              signal.addEventListener('abort', () => {
                const abortError = new Error('The operation was aborted');
                abortError.name = 'AbortError';
                reject(abortError);
              });
            }
          })
      );

      const meta = await resolveModelMetadata('google/gemini-3.7-flash:high', 'test-api-key', {
        baseUrl: 'https://openrouter.test/api/v1',
        fetchImplementation: mockFetch,
        timeoutMs: 50,
      });

      expect(meta.contextLength).toBe(1_048_576);
    });

    it('handles corrupt/non-JSON response bodies gracefully', async () => {
      const corruptBodies = [
        '<html><body>502 Bad Gateway</body></html>',
        'NOT JSON AT ALL',
        '{"data": "not-an-array"}',
        '{"data": [null, undefined, 123, "invalid"]}',
        '{"data": [{"id": null}]}',
        '',
      ];

      for (const body of corruptBodies) {
        clearModelMetadataCache();
        const mockFetch = vi.fn().mockResolvedValue(
          new Response(body, { status: 200, headers: { 'content-type': 'text/html' } })
        );

        const meta = await resolveModelMetadata('openai/gpt-4o', 'test-api-key', {
          baseUrl: 'https://openrouter.test/api/v1',
          fetchImplementation: mockFetch,
        });

        expect(meta.contextLength).toBe(128_000);
      }
    });

    it('respects custom cache TTL and refetches after expiration', async () => {
      clearModelMetadataCache();
      let now = 1_000_000;
      vi.spyOn(Date, 'now').mockImplementation(() => now);

      let fetchCount = 0;
      const mockFetch = vi.fn().mockImplementation(async () => {
        fetchCount++;
        return new Response(
          JSON.stringify({
            data: [{ id: 'google/gemini-3.7-flash', context_length: 1_048_576 }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      });

      const options = {
        baseUrl: 'https://openrouter.test/api/v1',
        fetchImplementation: mockFetch,
        ttlMs: 60_000, // 1 minute TTL
      };

      // 1. Initial call -> fetches from network
      await resolveModelMetadata('google/gemini-3.7-flash', 'test-api-key', options);
      expect(fetchCount).toBe(1);

      // 2. Call at t = +30s -> cached
      now += 30_000;
      await resolveModelMetadata('google/gemini-3.7-flash', 'test-api-key', options);
      expect(fetchCount).toBe(1);

      // 3. Call at t = +61s (expired) -> refetches
      now += 31_000;
      await resolveModelMetadata('google/gemini-3.7-flash', 'test-api-key', options);
      expect(fetchCount).toBe(2);
    });
  });

  describe('3. Safe Diff Capacity (C_safe) Mathematical Resilience', () => {
    it('verifies standard model C_safe calculations match architectural formula', () => {
      // Formula: C_safe = (ContextTokens - 4000 - 16000) * 3.8

      // 128k: (128,000 - 20,000) * 3.8 = 108,000 * 3.8 = 410,400 chars (~10,260 lines @ 40c/line)
      const c128k = calculateSafeDiffCapacity('deepseek/deepseek-v4-flash-0731:low');
      expect(c128k.safeDiffChars).toBe(410_400);
      expect(c128k.usableDiffTokens).toBe(108_000);
      expect(c128k.contextTokens).toBe(128_000);

      // 200k (Claude): (200,000 - 20,000) * 3.8 = 180,000 * 3.8 = 684,000 chars
      const c200k = calculateSafeDiffCapacity('anthropic/claude-3.7-sonnet');
      expect(c200k.safeDiffChars).toBe(684_000);
      expect(c200k.usableDiffTokens).toBe(180_000);

      // 1M (Gemini Flash): (1,048,576 - 20,000) * 3.8 = 1,028,576 * 3.8 = 3,908,588 chars (~97,700 lines)
      const c1M = calculateSafeDiffCapacity('google/gemini-3.7-flash:high');
      expect(c1M.safeDiffChars).toBe(3_908_588);
      expect(c1M.usableDiffTokens).toBe(1_028_576);

      // 2M (Gemini Pro): (2,097,152 - 20,000) * 3.8 = 2,077,152 * 3.8 = 7,893,177 chars
      const c2M = calculateSafeDiffCapacity('google/gemini-2.5-pro');
      expect(c2M.safeDiffChars).toBe(7_893_177);
      expect(c2M.usableDiffTokens).toBe(2_077_152);
    });

    it('never returns NaN, negative numbers, or invalid capacity under extreme options', () => {
      const extremeTestCases = [
        // System prompt tokens exceed total context window
        { tokens: 128_000, opts: { systemPromptTokens: 150_000, toolReserveTokens: 16_000 } },
        // Tool reserve tokens exceed total context window
        { tokens: 128_000, opts: { systemPromptTokens: 4_000, toolReserveTokens: 200_000 } },
        // System prompt + tool reserve exactly equal context tokens
        { tokens: 128_000, opts: { systemPromptTokens: 100_000, toolReserveTokens: 28_000 } },
        // System prompt + tool reserve slightly exceed context tokens
        { tokens: 128_000, opts: { systemPromptTokens: 100_000, toolReserveTokens: 28_001 } },
        // Zero context tokens
        { tokens: 0, opts: {} },
        // Negative context tokens
        { tokens: -50_000, opts: {} },
        // Extreme custom system prompt
        { tokens: 1_000_000, opts: { systemPromptTokens: 999_999, toolReserveTokens: 1 } },
        // Zero reserve options
        { tokens: 128_000, opts: { systemPromptTokens: 0, toolReserveTokens: 0 } },
        // Custom chars per token
        { tokens: 128_000, opts: { charsPerToken: 3.5 } },
        { tokens: 128_000, opts: { charsPerToken: 4.2 } },
      ];

      for (const { tokens, opts } of extremeTestCases) {
        const cap = calculateSafeDiffCapacity(tokens, opts);

        expect(Number.isNaN(cap.safeDiffChars)).toBe(false);
        expect(Number.isNaN(cap.usableDiffTokens)).toBe(false);
        expect(Number.isFinite(cap.safeDiffChars)).toBe(true);
        expect(Number.isFinite(cap.usableDiffTokens)).toBe(true);
        expect(cap.safeDiffChars).toBeGreaterThanOrEqual(0);
        expect(cap.usableDiffTokens).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(cap.safeDiffChars)).toBe(true);
        expect(Number.isInteger(cap.usableDiffTokens)).toBe(true);
      }
    });

    it('proves C_safe eliminates static 24,000 character truncation bottleneck for all models', () => {
      const models = [
        'deepseek/deepseek-v4-flash-0731:low',
        'deepseek/deepseek-v4-flash-0731:high',
        'openrouter/5.6-luna-high',
        'qwen/qwen-3.8-27b:high',
        'anthropic/claude-3.7-sonnet',
        'google/gemini-3.7-flash:high',
        'google/gemini-2.5-pro',
      ];

      for (const model of models) {
        const cap = calculateSafeDiffCapacity(model);
        // All models must yield substantially more capacity than the old 24,000 char static limit
        expect(cap.safeDiffChars).toBeGreaterThan(24_000);
        // 128k models have >= 410,400 chars (17.1x expansion over 24k)
        expect(cap.safeDiffChars).toBeGreaterThanOrEqual(410_400);
        // Supports arithmetic comparisons via valueOf(). TS's `>` operator type-checking
        // doesn't special-case objects with a custom valueOf()/Symbol.toPrimitive, so cast to
        // `number` for the type checker; the cast is erased at runtime and `>` still invokes
        // the object's own coercion, which is exactly what this assertion proves.
        expect(+cap).toBe(cap.safeDiffChars);
        expect((cap as unknown as number) > 24_000).toBe(true);
      }
    });

    it('supports string and primitive coercion transparently', () => {
      const cap = calculateSafeDiffCapacity('deepseek/deepseek-v4-flash-0731:low');
      expect(`${cap}`).toBe('410400');
      expect(cap.toString()).toBe('410400');
      expect(Number(cap)).toBe(410400);
      expect(+cap).toBe(410400);
      expect((cap as unknown as number) + 100).toBe(410500);
    });
  });

  describe('4. Config Schema Limits Boundary Expansion (schema.ts)', () => {
    it('accepts valid configurations with expanded limits (up to 4M tokens, 10MB diff)', () => {
      const validYaml = `
version: 4
quorum: 1
personas:
  - id: sec
    enabled: true
    required: true
    charter: builtin:security
    paths: ["*"]
    providers: [synthetic]
reviewers:
  execution: personas
  fallback: none
  overall_timeout_s: 300
  providers:
    - id: synthetic
      enabled: true
      model: google/gemini-3.7-flash:high
      effort: high
      review_timeout_s: 60
      arbiter_timeout_s: 60
  arbiter:
    order: [synthetic]
limits:
  max_prompt_tokens: 4000000
  max_diff_bytes: 10000000
  max_completion_tokens: 128000
  max_turns: 20
  max_concurrency: 32
`;
      const config = parseAndValidateConfig(validYaml);
      expect(config.version).toBe(4);
      expect((config as any).limits.max_prompt_tokens).toBe(4_000_000);
      expect((config as any).limits.max_diff_bytes).toBe(10_000_000);
      expect((config as any).limits.max_completion_tokens).toBe(128_000);
      expect((config as any).limits.max_concurrency).toBe(32);
    });

    it('rejects configurations exceeding schema maximum limits', () => {
      const baseYaml = (limitOverrides: string) => `
version: 4
quorum: 1
personas:
  - id: sec
    enabled: true
    required: true
    charter: builtin:security
    paths: ["*"]
    providers: [synthetic]
reviewers:
  execution: personas
  fallback: none
  overall_timeout_s: 300
  providers:
    - id: synthetic
      enabled: true
      model: deepseek/deepseek-v4-flash-0731:low
      effort: low
      review_timeout_s: 60
      arbiter_timeout_s: 60
  arbiter:
    order: [synthetic]
limits:
  ${limitOverrides}
`;

      // Exceeds max prompt tokens (4,000,001)
      expect(() => parseAndValidateConfig(baseYaml('max_prompt_tokens: 4000001'))).toThrow(ConfigValidationError);

      // Exceeds max diff bytes (10,000,001)
      expect(() => parseAndValidateConfig(baseYaml('max_diff_bytes: 10000001'))).toThrow(ConfigValidationError);

      // Exceeds max completion tokens (128,001)
      expect(() => parseAndValidateConfig(baseYaml('max_completion_tokens: 128001'))).toThrow(ConfigValidationError);

      // Exceeds max concurrency (33)
      expect(() => parseAndValidateConfig(baseYaml('max_concurrency: 33'))).toThrow(ConfigValidationError);

      // Negative prompt tokens
      expect(() => parseAndValidateConfig(baseYaml('max_prompt_tokens: -1'))).toThrow(ConfigValidationError);

      // Zero diff bytes
      expect(() => parseAndValidateConfig(baseYaml('max_diff_bytes: 0'))).toThrow(ConfigValidationError);
    });
  });
});
