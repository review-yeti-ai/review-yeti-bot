import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import { sseBody } from '../support/streamableFetchStub';

const rootRepoDir = fs.existsSync(path.join(path.resolve(__dirname, '../..'), '.github/workflows/pipelines/review-pipeline.js'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');
const pipeline = require(path.join(rootRepoDir, '.github/workflows/pipelines/review-pipeline.js'));
const { HARD_BANNED_PROVIDER_SLUGS } = require(path.join(rootRepoDir, '.github/workflows/pipelines/openRouterPolicy.js'));

const { reviewWithModel: reviewWithModelRaw, resolveModelConfig, PERSONA_CHARTERS, addRunScopedProviderBan, RUN_SCOPED_PROVIDER_BAN_MAX } = pipeline;
const securityPersona = PERSONA_CHARTERS.find((p: any) => p.id === 'security');
const dependencyPersona = PERSONA_CHARTERS.find((p: any) => p.id === 'dependencies');

// reviewWithModel now requires a caller-supplied options.investigationMessages (the legacy
// single-shot prompt-building/parsing path it used to fall back to is gone -- see the deletion
// this test file's own "reviewWithModel" tests were rewritten for). Transport-behavior tests
// (retries, fallback, provider routing, telemetry, lane budget) don't care about message content,
// so they get the same bounded stand-in messages by default unless they supply their own.
const DEFAULT_INVESTIGATION_MESSAGES = [
  { role: 'system', content: 'You are a bounded code-review panel reviewer.' },
  { role: 'user', content: '<review_manifest></review_manifest><pull_request_diff></pull_request_diff>' },
];
function reviewWithModel(persona: any, diffFiles: any, prContext: any, sessionContext: any, options: any = {}) {
  return reviewWithModelRaw(persona, diffFiles, prContext, sessionContext, {
    rawTurn: true,
    investigationMessages: DEFAULT_INVESTIGATION_MESSAGES,
    ...options,
  });
}

const diffFiles = [
  {
    path: 'src/api/user.ts',
    patch: 'diff --git a/src/api/user.ts b/src/api/user.ts\n+const id = req.query.id;\n',
    addedLines: [{ text: 'const id = req.query.id;' }],
    deletedLines: [],
  },
];

/**
 * Builds a fetch stub returning an OpenAI-compatible chat completion. Streaming is unconditional
 * on the real review path (operator directive), so this answers the streaming request directly
 * with a single-chunk SSE body so every test exercises the same transport as production.
 */
function stubFetch(content: string, opts: { ok?: boolean; status?: number; payload?: any } = {}) {
  const calls: any[] = [];
  const impl = async (url: string, init: any) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const payload = opts.payload || { choices: [{ message: { content } }] };
    return {
      ok: opts.ok !== false,
      status: opts.status || 200,
      text: async () => 'error body',
      json: async () => payload,
      body: opts.ok === false ? undefined : sseBody(payload),
    };
  };
  return { impl, calls };
}

const validFindings = JSON.stringify({
  findings: [
    {
      severity: 'P1',
      path: 'src/api/user.ts',
      line: 2,
      title: 'Unvalidated query parameter',
      body: 'req.query.id flows into a query without tenant scoping.',
      suggestion: 'Scope the lookup by orgId.',
    },
  ],
});

describe('resolveModelConfig', () => {
  it('reports disabled when no API key is present', () => {
    const cfg = resolveModelConfig({});
    expect(cfg.enabled).toBe(false);
  });

  it('enables when OPENROUTER_API_KEY is present and defaults to the OpenRouter endpoint', () => {
    const cfg = resolveModelConfig({ OPENROUTER_API_KEY: 'sk-test' });
    expect(cfg.enabled).toBe(true);
    expect(cfg.apiKey).toBe('sk-test');
    expect(cfg.baseUrl).toContain('openrouter.ai');
    expect(cfg.model).toBe('deepseek/deepseek-v4-flash-0731');
  });

  it('allows an explicitly configured OpenRouter-compatible endpoint', () => {
    const cfg = resolveModelConfig({
      OPENROUTER_API_KEY: 'k',
      OPENROUTER_BASE_URL: 'https://openrouter.example/v1/',
      OPENROUTER_MODEL: 'some/model',
    });
    expect(cfg.baseUrl).toBe('https://openrouter.example/v1');
    expect(cfg.model).toBe('some/model');
  });
});

describe('reviewWithModel', () => {
  // Operator directive: "streaming MUST be true. It is not a tunable, not a fallback, not a
  // per-transport preference." `disableStream` used to be able to force a buffered request (the
  // mechanism this test originally proved); it has been deleted entirely -- there is no longer a
  // caller-supplied override that can turn streaming off on the real review path, and an
  // unrecognized option here is silently ignored rather than reintroducing a second disagreeing
  // flag.
  it('streaming cannot be disabled on the real review path -- an unrecognized "disableStream" option has no effect', async () => {
    const { impl, calls } = stubFetch('{"findings":[]}');

    await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r', prNumber: '1' }, null, {
      apiKey: 'k',
      baseUrl: 'https://api.example.com/v1',
      model: 'test/model',
      fetchImpl: impl,
      maxAttempts: 1,
      // `disableStream` is not a recognized option anymore; proving it is inert, not honored.
      disableStream: true,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].body.stream).toBe(true);
  });

  it('uses the configured DeepSeek fallback after the primary model has a transient failure', async () => {
    const calls: any[] = [];
    const fetchImpl = async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      calls.push({ url, init, body });
      // A failed SSE request consumes the configured attempt; model-level fallback then receives
      // its own streamed request.
      if (calls.length <= 1) {
        return {
          ok: false,
          status: 503,
          text: async () => 'provider unavailable',
          json: async () => ({ error: { message: 'provider unavailable' } }),
        };
      }
      const payload = { choices: [{ message: { content: validFindings } }] };
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => payload,
        body: sseBody(payload),
      };
    };

    const result = await reviewWithModel(
      securityPersona,
      diffFiles,
      { repo: 'o/r', prNumber: '1' },
      null,
      {
        apiKey: 'k',
        baseUrl: 'https://api.example.com/v1',
        model: 'openrouter/auto-beta',
        fetchImpl,
        maxAttempts: 1,
        openRouterPolicy: {
          allowedModels: [],
          fallbackModels: ['deepseek/deepseek-v4-flash-0731'],
          costQualityTradeoff: undefined,
          dataCollection: undefined,
          ignoredProviders: HARD_BANNED_PROVIDER_SLUGS,
          providerRouting: { ignore: HARD_BANNED_PROVIDER_SLUGS },
          timeoutMs: 30_000,
        },
      },
    );

    expect(calls).toHaveLength(2);
    expect(calls[0].body.model).toBe('openrouter/auto-beta');
    expect(calls[1].body.model).toBe('deepseek/deepseek-v4-flash-0731');
    expect(result.model).toBe('deepseek/deepseek-v4-flash-0731');
    expect(result.fallbackUsed).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.content).toBe(validFindings);
  });

  // Issue #166: under a guardrailed key, `openrouter/auto-beta` 404s whenever the router's pick
  // lands outside the key's model allowlist ("No endpoints available matching your guardrail
  // restrictions"). That is precisely the case the configured fallback model exists for -- the
  // fallback slug IS admitted by the guardrail -- so an http_404 must be fallback-eligible, not
  // a terminal lane error. Measured live (run 32416975595, PR #167): 5 persona lanes died
  // `http_404` at attempt 1/2 with the deepseek fallback configured and never tried.
  it('falls back to the configured model when the primary 404s under the key guardrail (issue #166)', async () => {
    const calls: any[] = [];
    const fetchImpl = async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      calls.push({ url, init, body });
      if (calls.length <= 1) {
        return {
          ok: false,
          status: 404,
          text: async () => 'No endpoints available matching your guardrail restrictions',
          json: async () => ({ error: { message: 'No endpoints available matching your guardrail restrictions' } }),
        };
      }
      const payload = { choices: [{ message: { content: validFindings } }] };
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => payload,
        body: sseBody(payload),
      };
    };

    const result = await reviewWithModel(
      securityPersona,
      diffFiles,
      { repo: 'o/r', prNumber: '1' },
      null,
      {
        apiKey: 'k',
        baseUrl: 'https://api.example.com/v1',
        model: 'openrouter/auto-beta',
        fetchImpl,
        maxAttempts: 1,
        openRouterPolicy: {
          allowedModels: [],
          fallbackModels: ['deepseek/deepseek-v4-flash-0731'],
          costQualityTradeoff: undefined,
          dataCollection: undefined,
          ignoredProviders: HARD_BANNED_PROVIDER_SLUGS,
          providerRouting: { ignore: HARD_BANNED_PROVIDER_SLUGS },
          timeoutMs: 30_000,
        },
      },
    );

    expect(calls).toHaveLength(2);
    expect(calls[0].body.model).toBe('openrouter/auto-beta');
    expect(calls[1].body.model).toBe('deepseek/deepseek-v4-flash-0731');
    expect(result.model).toBe('deepseek/deepseek-v4-flash-0731');
    expect(result.fallbackUsed).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.content).toBe(validFindings);
  });

  // auto-beta re-rolls its underlying pick per request (measured in the same run: sibling lanes
  // requesting auto-beta resolved via Morph to the deepseek slug and completed), so an in-budget
  // retry of the SAME slug after a 404 is a real second chance, not a guaranteed repeat failure.
  it('re-asks the primary on http_404 while attempts remain, then falls back', async () => {
    const calls: any[] = [];
    const fetchImpl = async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      calls.push({ url, init, body });
      if (calls.length <= 2) {
        return {
          ok: false,
          status: 404,
          text: async () => 'No endpoints available matching your guardrail restrictions',
          json: async () => ({ error: { message: 'No endpoints available matching your guardrail restrictions' } }),
        };
      }
      const payload = { choices: [{ message: { content: validFindings } }] };
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => payload,
        body: sseBody(payload),
      };
    };

    const result = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r', prNumber: '1' }, null, {
      apiKey: 'k',
      baseUrl: 'https://api.example.com/v1',
      model: 'openrouter/auto-beta',
      fetchImpl,
      openRouterPolicy: {
        allowedModels: [],
        fallbackModels: ['deepseek/deepseek-v4-flash-0731'],
        costQualityTradeoff: undefined,
        dataCollection: undefined,
        ignoredProviders: HARD_BANNED_PROVIDER_SLUGS,
        providerRouting: { ignore: HARD_BANNED_PROVIDER_SLUGS },
        timeoutMs: 30_000,
      },
    });

    expect(calls).toHaveLength(3);
    expect(calls[0].body.model).toBe('openrouter/auto-beta');
    expect(calls[1].body.model).toBe('openrouter/auto-beta');
    expect(calls[2].body.model).toBe('deepseek/deepseek-v4-flash-0731');
    expect(result.fallbackUsed).toBe(true);
    expect(result.ok).toBe(true);
  });

  it('retries the primary model before moving to the configured fallback', async () => {
    const calls: any[] = [];
    const fetchImpl = async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      calls.push({ url, init, body });
      // Two full streamed attempts at the primary model before the configured model-level
      // fallback is used.
      if (calls.length <= 2) {
        return {
          ok: false,
          status: 503,
          text: async () => 'provider unavailable',
          json: async () => ({ error: { message: 'provider unavailable' } }),
        };
      }
      const payload = { choices: [{ message: { content: validFindings } }] };
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => payload,
        body: sseBody(payload),
      };
    };

    const result = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r', prNumber: '1' }, null, {
      apiKey: 'k',
      baseUrl: 'https://api.example.com/v1',
      model: 'openrouter/auto-beta',
      fetchImpl,
      openRouterPolicy: {
        allowedModels: [],
        fallbackModels: ['deepseek/deepseek-v4-flash-0731'],
        costQualityTradeoff: undefined,
        dataCollection: undefined,
        ignoredProviders: HARD_BANNED_PROVIDER_SLUGS,
        providerRouting: { ignore: HARD_BANNED_PROVIDER_SLUGS },
        timeoutMs: 30_000,
      },
    });

    expect(calls).toHaveLength(3);
    expect(calls[0].body.model).toBe('openrouter/auto-beta');
    expect(calls[1].body.model).toBe('openrouter/auto-beta');
    expect(calls[2].body.stream).toBe(true);
    expect(calls[2].body.model).toBe('deepseek/deepseek-v4-flash-0731');
    expect(result.fallbackUsed).toBe(true);
  });

  it('moves to the fallback after a client-side timeout', async () => {
    const calls: any[] = [];
    const fetchImpl = async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      calls.push({ url, init, body });
      // The primary model's client-side abort consumes its streamed attempt, then the configured
      // model-level fallback gets its own streamed request.
      if (calls.length <= 1) {
        const error: any = new Error('request aborted');
        error.name = 'AbortError';
        throw error;
      }
      const payload = { choices: [{ message: { content: validFindings } }] };
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => payload,
        body: sseBody(payload),
      };
    };

    const result = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r', prNumber: '1' }, null, {
      apiKey: 'k',
      baseUrl: 'https://api.example.com/v1',
      model: 'openrouter/auto-beta',
      fetchImpl,
      maxAttempts: 1,
      openRouterPolicy: {
        allowedModels: [],
        fallbackModels: ['deepseek/deepseek-v4-flash-0731'],
        costQualityTradeoff: undefined,
        dataCollection: undefined,
        ignoredProviders: HARD_BANNED_PROVIDER_SLUGS,
        providerRouting: { ignore: HARD_BANNED_PROVIDER_SLUGS },
        timeoutMs: 30_000,
      },
    });

    expect(calls).toHaveLength(2);
    expect(calls[0].body.model).toBe('openrouter/auto-beta');
    expect(calls[1].body.model).toBe('deepseek/deepseek-v4-flash-0731');
    expect(calls[1].body.stream).toBe(true);
    expect(result.fallbackUsed).toBe(true);
    expect(result.ok).toBe(true);
  });

  // REL-271 (D3): attempt 2 no longer gets a doubled response budget -- every attempt uses the
  // same flat timeoutMs. The recovery mechanism (force SSE on retry so the resolved provider is
  // visible) still works as long as the provider responds within the *unescalated* budget.
  it('recovers via a retry that uses the same (non-doubled) response budget', async () => {
    const calls: any[] = [];
    const fetchImpl = async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      calls.push({ body });
      if (calls.length === 1) {
        // Streaming is unconditional, so attempt 1 fails as a streamed request. The retry loop
        // then makes one fresh streamed request with the same flat budget.
        throw Object.assign(new Error('request aborted'), { name: 'AbortError' });
      }
      const payload = {
        id: 'gen-recovery',
        model: 'test/model',
        provider: 'ExampleCloud',
        choices: [{ message: { content: '{"findings":[]}' } }],
      };
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => payload,
        body: sseBody(payload),
      };
    };

    const result = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r', prNumber: '1' }, null, {
      apiKey: 'k',
      baseUrl: 'https://api.example.com/v1',
      model: 'test/model',
      fetchImpl,
      maxAttempts: 2,
      timeoutMs: 10,
    });

    expect(calls).toHaveLength(2);
    // Both the initial attempt and retry remain streamed.
    expect(calls[0].body.stream).toBe(true);
    expect(calls[1].body.stream).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.provider).toBe('ExampleCloud');
  });

  it('retries a mid-stream OpenRouter error without adding a provider exclusion', async () => {
    const calls: any[] = [];
    const fetchImpl = async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      calls.push({ body });
      if (calls.length === 1) {
        const payload = {
          id: 'gen-broken-stream',
          model: 'test/model',
          provider: 'ExampleCloud',
          choices: [{ delta: { content: '{"findings":[' } }],
          error: { message: 'upstream stream ended unexpectedly' },
        };
        return {
          ok: true,
          status: 200,
          text: async () => '',
          json: async () => payload,
          body: sseBody(payload),
        };
      }
      const payload = {
        id: 'gen-recovered-stream',
        model: 'test/model',
        provider: 'RecoveredCloud',
        choices: [{ message: { content: '{"findings":[]}' } }],
      };
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => payload,
        body: sseBody(payload),
      };
    };

    const result = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r', prNumber: '1' }, null, {
      apiKey: 'k',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'test/model',
      fetchImpl,
      maxAttempts: 2,
      timeoutMs: 30_000,
      sessionSticky: true,
      providerRouting: {
        allow_fallbacks: true,
        quantizations: ['fp16', 'bf16'],
        ignore: HARD_BANNED_PROVIDER_SLUGS,
      },
    });

    expect(calls).toHaveLength(2);
    expect(calls[0].body.stream).toBe(true);
    expect(calls[0].body.session_id).toBeTruthy();
    expect(calls[1].body.stream).toBe(true);
    expect(calls[1].body.session_id).toBeUndefined();
    expect(calls[1].body.provider.ignore).toEqual(HARD_BANNED_PROVIDER_SLUGS);
    expect(calls[1].body.provider.ignore).not.toContain('examplecloud');
    expect(result.ok).toBe(true);
    expect(result.provider).toBe('RecoveredCloud');
  });

  it('restores session stickiness for a fallback model after streamed retries are exhausted', async () => {
    const calls: any[] = [];
    const fetchImpl = async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      calls.push({ body });
      if (calls.length <= 2) {
        const payload = {
          id: `gen-broken-stream-${calls.length}`,
          model: body.model,
          provider: 'ExampleCloud',
          choices: [{ delta: { content: '{"findings":[' } }],
          error: { message: 'upstream stream ended unexpectedly' },
        };
        return {
          ok: true,
          status: 200,
          text: async () => '',
          json: async () => payload,
          body: sseBody(payload),
        };
      }
      const payload = {
        id: 'gen-fallback-stream',
        model: body.model,
        provider: 'FallbackCloud',
        choices: [{ message: { content: '{"findings":[]}' } }],
      };
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => payload,
        body: sseBody(payload),
      };
    };

    const result = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r', prNumber: '1' }, null, {
      apiKey: 'k',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'primary/model',
      fetchImpl,
      maxAttempts: 2,
      timeoutMs: 30_000,
      sessionSticky: true,
      openRouterPolicy: {
        allowedModels: [],
        fallbackModels: ['fallback/model'],
        costQualityTradeoff: undefined,
        dataCollection: undefined,
        ignoredProviders: HARD_BANNED_PROVIDER_SLUGS,
        providerRouting: {
          allow_fallbacks: true,
          quantizations: ['fp16', 'bf16'],
          ignore: HARD_BANNED_PROVIDER_SLUGS,
        },
        timeoutMs: 30_000,
      },
    });

    expect(calls).toHaveLength(3);
    expect(calls[0].body.model).toBe('primary/model');
    expect(calls[0].body.session_id).toBeTruthy();
    expect(calls[1].body.model).toBe('primary/model');
    expect(calls[1].body.session_id).toBeUndefined();
    expect(calls[2].body.model).toBe('fallback/model');
    expect(calls[2].body.session_id).toBeTruthy();
    expect(calls[2].body.provider.ignore).toEqual(HARD_BANNED_PROVIDER_SLUGS);
    expect(calls[2].body.provider.ignore).not.toContain('examplecloud');
    expect(result.ok).toBe(true);
    expect(result.fallbackUsed).toBe(true);
    expect(result.provider).toBe('FallbackCloud');
  });

  // REL-271 (D3), updated 2026-08-20: the fixed per-call total-duration clock this test used to
  // rely on (a chunk arriving 15ms after dispatch, killed by a flat 10ms `totalAbort` timer) was
  // itself the D1-class bug fixed on 2026-08-20 -- see callOpenRouterChat's `totalAbort` doc
  // comment (successful lanes measured 47-52s total against an old 30s fixed cap; the fixed clock
  // was killing actively-streaming lanes, not stalled ones). The flat-budget-with-no-escalation
  // invariant this test protects is still real, just enforced by the new stall/gap timer instead:
  // a stream that goes silent AFTER its first chunk for longer than `stallMs`, on both attempts
  // equally (no x2 growth), still fails on the final attempt.
  it('does not extend the response budget on retry -- a stall that needed the old x2 escalation now fails', async () => {
    const calls: any[] = [];
    const fetchImpl = async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      calls.push({ body });
      if (calls.length === 1) {
        throw Object.assign(new Error('request aborted'), { name: 'AbortError' });
      }
      return {
        ok: true,
        status: 200,
        body: {
          getReader: () => {
            let sentChunk = false;
            return {
              read: async () => {
                if (!sentChunk) {
                  sentChunk = true;
                  return {
                    done: false,
                    value: Buffer.from(`data: ${JSON.stringify({
                      id: 'gen-recovery',
                      model: 'test/model',
                      provider: 'ExampleCloud',
                      choices: [{ delta: { content: '{"findings":[]}' } }],
                    })}\n\n`),
                  };
                }
                // Exceeds the flat 10ms stall budget after the first chunk, but would have fit
                // inside an old doubled 20ms budget -- this is the regression check for D3, now
                // expressed against the post-first-chunk gap timer instead of the removed
                // fixed-total-duration timer.
                await new Promise((resolve) => setTimeout(resolve, 15));
                return { done: false, value: Buffer.from('data: [DONE]\n\n') };
              },
              cancel: async () => {},
            };
          },
        },
      };
    };

    const result = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r', prNumber: '1' }, null, {
      apiKey: 'k',
      baseUrl: 'https://api.example.com/v1',
      model: 'test/model',
      fetchImpl,
      maxAttempts: 2,
      timeoutMs: 5_000,
      stallMs: 10,
    });

    expect(calls).toHaveLength(2);
    expect(result.decision).toBe('ERROR');
    expect(result.failureClass).toBe('stream_stall');
  });

  it('enforces the total timeout while reading a streamed response and retries the next route', async () => {
    const calls: any[] = [];
    const delayedStream = (provider: string, content: string, delayMs: number) => {
      const payload = { provider, choices: [{ delta: { content } }] };
      let index = 0;
      return {
        getReader: () => ({
          read: async () => {
            if (index++ === 0) return { done: false, value: Buffer.from(`data: ${JSON.stringify(payload)}\n\n`) };
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            throw Object.assign(new Error('request aborted'), { name: 'AbortError' });
          },
          cancel: async () => {},
        }),
      };
    };
    const fetchImpl = async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      calls.push({ url, init, body });
      const firstAttempt = calls.length === 1;
      const payload = { provider: firstAttempt ? 'ExampleCloud' : 'OpenAI', choices: [{ delta: { content: firstAttempt ? '{"findings":' : validFindings } }] };
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: firstAttempt ? delayedStream('ExampleCloud', '{"findings":', 80) : sseBody(payload),
      };
    };

    const startedAt = Date.now();
    const result = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r', prNumber: '1' }, null, {
      apiKey: 'k',
      baseUrl: 'https://api.example.com/v1',
      model: 'test/model',
      fetchImpl,
      // Attempt 1 times out after identifying ExampleCloud; attempt 2 is the recovery route.
      maxAttempts: 2,
      timeoutMs: 20,
    });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1].body.provider.ignore).toContain('examplecloud');
    expect(result.provider).toBe('OpenAI');
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  // REL-271 (D4): a provider identified by a stream timeout used to get a bonus 3rd attempt on a
  // fresh route ("retries once" beyond the configured maxAttempts). That bonus attempt is
  // removed -- the identify-and-quarantine now has to happen within the configured attempt
  // budget itself (here: attempt 1 identifies+bans Cerebras, attempt 2 -- the last one -- is the
  // recovery). No third attempt is ever made regardless of outcome.
  it('quarantines the provider identified by a stream timeout within the configured attempt budget (no bonus attempt)', async () => {
    const calls: any[] = [];
    const streamResponse = (chunks: any[], { delayMs = 0, abortAfter = false } = {}) => {
      let index = 0;
      return {
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read: async () => {
              if (index >= chunks.length) {
                if (!abortAfter) return { done: true, value: undefined };
                if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
                throw Object.assign(new Error('request aborted'), { name: 'AbortError' });
              }
              const chunk = chunks[index++];
              const data = chunk === '[DONE]' ? '[DONE]' : JSON.stringify(chunk);
              return { done: false, value: Buffer.from(`data: ${data}\n\n`) };
            },
            cancel: async () => {},
          }),
        },
      };
    };
    const fetchImpl = async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      calls.push({ url, init, body });
      if (calls.length === 1) {
        return streamResponse([
          { id: 'gen-cerebras', model: 'test/model', provider: 'Cerebras', choices: [{ delta: { content: '{"findings":[]}' } }] },
        ], { delayMs: 25, abortAfter: true });
      }
      return streamResponse([
        { id: 'gen-healthy', model: 'test/model', provider: 'OpenAI', choices: [{ delta: { content: '{"findings":[]}' } }] },
        '[DONE]',
      ]);
    };

    const result = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r', prNumber: '1' }, null, {
      apiKey: 'k',
      baseUrl: 'https://api.example.com/v1',
      model: 'test/model',
      fetchImpl,
      maxAttempts: 2,
      timeoutMs: 10,
      preferStream: true,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0].body.stream).toBe(true);
    expect(calls[1].body.stream).toBe(true);
    expect(calls[1].body.provider.ignore).toContain('cerebras');
    expect(calls[1].body.session_id).toBeUndefined();
    expect(result.provider).toBe('OpenAI');
    expect(result.ok).toBe(true);
  });

  it('lets OpenRouter reroute a timed-out provider when timeout quarantine is disabled', async () => {
    const calls: any[] = [];
    const runTimedOutProviders = new Set<string>();
    let firstRead = true;
    const fetchImpl = async (_url: string, init: any) => {
      calls.push(JSON.parse(init.body));
      if (calls.length === 1) {
        return {
          ok: true,
          status: 200,
          body: {
            getReader: () => ({
              read: async () => {
                if (firstRead) {
                  firstRead = false;
                  return {
                    done: false,
                    value: Buffer.from('data: {"id":"gen-slow","model":"test/model","provider":"ExampleCloud","choices":[{"delta":{"content":"{\\"findings\\":[]}"}}]}\n\n'),
                  };
                }
                await new Promise((resolve) => setTimeout(resolve, 25));
                throw Object.assign(new Error('request aborted'), { name: 'AbortError' });
              },
              cancel: async () => {},
            }),
          },
        };
      }
      return {
        ok: true,
        status: 200,
        body: {
          getReader: () => {
            let sent = false;
            return {
              read: async () => {
                if (sent) return { done: true, value: undefined };
                sent = true;
                return {
                  done: false,
                  value: Buffer.from('data: {"id":"gen-rerouted","model":"test/model","provider":"AnotherCloud","choices":[{"delta":{"content":"{\\"findings\\":[]}"}}]}\n\ndata: [DONE]\n\n'),
                };
              },
              cancel: async () => {},
            };
          },
        },
      };
    };

    const result = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r', prNumber: '1' }, null, {
      apiKey: 'k',
      baseUrl: 'https://openrouter.ai/api/v1',
      gatewayCompat: 'openrouter',
      model: 'test/model',
      fetchImpl,
      maxAttempts: 2,
      timeoutMs: 10,
      preferStream: true,
      providerTimeoutQuarantine: false,
      runTimedOutProviders,
    });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1].provider?.ignore || []).not.toContain('examplecloud');
    expect(calls[1].session_id).toBeUndefined();
    expect(runTimedOutProviders.size).toBe(0);
  });

  // Regression coverage for the "false advertising" ban-scope defect (2026-08-12, evidence:
  // calltelemetry/cisco-cdr run 31601485579). Proof from that run: DigitalOcean was banned by the
  // security lane at 14:41:47 and served the architecture lane again at 14:47:51 -- six minutes
  // later, in the same review run -- despite the (now corrected) log line claiming the provider
  // "will not retry ... for the rest of the review run". `timedOutProviders` inside
  // reviewWithModel is local to one call; each persona lane calls reviewWithModel fresh per turn,
  // so nothing survived between lanes without an explicit, threaded run-scoped ban set.
  describe('run-scoped provider ban (options.runTimedOutProviders)', () => {
    function streamResponse(chunks: any[], { delayMs = 0, abortAfter = false } = {}) {
      let index = 0;
      // Also provides `.text()`/`.json()` (converting the first real chunk's `delta.content`
      // into a `message.content` chat-completion shape) for HTTP-error diagnostics; successful
      // responses are always consumed through the SSE reader.
      const firstChunk = chunks.find((chunk) => chunk !== '[DONE]');
      const jsonPayload = firstChunk
        ? { id: firstChunk.id, model: firstChunk.model, provider: firstChunk.provider, choices: [{ message: { content: firstChunk.choices?.[0]?.delta?.content ?? '' } }] }
        : { choices: [{ message: { content: '' } }] };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(jsonPayload),
        json: async () => jsonPayload,
        body: {
          getReader: () => ({
            read: async () => {
              if (index >= chunks.length) {
                if (!abortAfter) return { done: true, value: undefined };
                if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
                throw Object.assign(new Error('request aborted'), { name: 'AbortError' });
              }
              const chunk = chunks[index++];
              const data = chunk === '[DONE]' ? '[DONE]' : JSON.stringify(chunk);
              return { done: false, value: Buffer.from(`data: ${data}\n\n`) };
            },
            cancel: async () => {},
          }),
        },
      };
    }

    /**
     * A lane whose first attempt identifies a slow provider then times out, and whose second
     * (final) attempt succeeds. Mirrors `laneOneFetch` below -- both stream from the first call,
     * so unlike a fetchImpl that throws, this needs no `.json()` seam.
     */
    function timeoutThenSucceedFetch(bannedProvider: string, calls: any[]) {
      return async (url: string, init: any) => {
        const body = JSON.parse(init.body);
        calls.push({ url, init, body });
        if (calls.length === 1) {
          return streamResponse([
            { id: `gen-${bannedProvider}`, model: 'test/model', provider: bannedProvider, choices: [{ delta: { content: '{"findings":[]}' } }] },
          ], { delayMs: 25, abortAfter: true });
        }
        return streamResponse([
          { id: 'gen-healthy', model: 'test/model', provider: 'OpenAI', choices: [{ delta: { content: '{"findings":[]}' } }] },
          '[DONE]',
        ]);
      };
    }

    it('a provider timed out by one lane is not selected by a later lane in the same run', async () => {
      const runTimedOutProviders = new Set<string>();
      const laneOneCalls: any[] = [];
      // REL-271 (D4): no bonus attempt after a provider is identified, so the ban has to happen
      // within the configured attempt budget itself -- attempt 1 (forced to stream via
      // identifies+bans DigitalOcean, attempt 2 (the last one) is the recovery.
      const laneOneFetch = async (url: string, init: any) => {
        const body = JSON.parse(init.body);
        laneOneCalls.push({ url, init, body });
        if (laneOneCalls.length === 1) {
          return streamResponse([
            { id: 'gen-digitalocean', model: 'test/model', provider: 'DigitalOcean', choices: [{ delta: { content: '{"findings":[]}' } }] },
          ], { delayMs: 25, abortAfter: true });
        }
        return streamResponse([
          { id: 'gen-healthy', model: 'test/model', provider: 'OpenAI', choices: [{ delta: { content: '{"findings":[]}' } }] },
          '[DONE]',
        ]);
      };

      const laneOne = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r', prNumber: '1' }, null, {
        apiKey: 'k',
        baseUrl: 'https://api.example.com/v1',
        model: 'test/model',
        fetchImpl: laneOneFetch,
        maxAttempts: 2,
        timeoutMs: 10,
        preferStream: true,
        runTimedOutProviders,
      });

      expect(laneOne.ok).toBe(true);
      expect(runTimedOutProviders.has('digitalocean')).toBe(true);

      // A second, structurally fresh lane call (a different persona lane in the same review run)
      // -- its own local `timedOutProviders` Set starts empty, so only the shared run-scoped Set
      // can be the source of the ban below.
      const laneTwoCalls: any[] = [];
      const laneTwoFetch = async (url: string, init: any) => {
        const body = JSON.parse(init.body);
        laneTwoCalls.push({ url, init, body });
        return {
          ok: true,
          status: 200,
          text: async () => '',
          json: async () => ({ choices: [{ message: { content: '{"findings":[]}' } }] }),
        };
      };
      await reviewWithModel(dependencyPersona, diffFiles, { repo: 'o/r', prNumber: '1' }, null, {
        apiKey: 'k',
        baseUrl: 'https://api.example.com/v1',
        model: 'test/model',
        fetchImpl: laneTwoFetch,
        maxAttempts: 1,
        timeoutMs: 30_000,
        runTimedOutProviders,
      });

      expect(laneTwoCalls[0].body.provider.ignore).toContain('digitalocean');
    });

    it('does not leak a provider ban across separate review runs', async () => {
      const runOneBans = new Set<string>();
      const laneOneCalls: any[] = [];
      await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r', prNumber: '1' }, null, {
        apiKey: 'k',
        baseUrl: 'https://api.example.com/v1',
        model: 'test/model',
        fetchImpl: timeoutThenSucceedFetch('DigitalOcean', laneOneCalls),
        maxAttempts: 2,
        timeoutMs: 10,
        runTimedOutProviders: runOneBans,
      });
      expect(runOneBans.has('digitalocean')).toBe(true);

      // A second review run (e.g. a later PR review in the same long-lived process, or simply a
      // caller that never opted in to run-scoped banning) must not inherit that ban. There is
      // deliberately no module-level Set backing this feature -- passing nothing here is the
      // regression check for that.
      const laneTwoCalls: any[] = [];
      const laneTwoFetch = async (url: string, init: any) => {
        const body = JSON.parse(init.body);
        laneTwoCalls.push({ url, init, body });
        return {
          ok: true,
          status: 200,
          text: async () => '',
          json: async () => ({ choices: [{ message: { content: '{"findings":[]}' } }] }),
        };
      };
      await reviewWithModel(dependencyPersona, diffFiles, { repo: 'o/r', prNumber: '1' }, null, {
        apiKey: 'k',
        baseUrl: 'https://api.example.com/v1',
        model: 'test/model',
        fetchImpl: laneTwoFetch,
        maxAttempts: 1,
        timeoutMs: 30_000,
        // No runTimedOutProviders passed.
      });

      const secondLaneIgnore = laneTwoCalls[0].body.provider?.ignore || [];
      expect(secondLaneIgnore).not.toContain('digitalocean');
    });

    it('caps the run-scoped ban so enough timeouts cannot reduce the eligible pool to zero', () => {
      const bans = new Set<string>();
      // None of these overlap HARD_BANNED_PROVIDER_SLUGS -- this test is purely about
      // addRunScopedProviderBan's own bound, not the separately-enforced permanent ban list.
      const providers = ['ionstream', 'akashml', 'digitalocean', 'phala', 'cerebras', 'examplecloud', 'groq'];
      expect(providers.length).toBeGreaterThan(RUN_SCOPED_PROVIDER_BAN_MAX);

      for (const provider of providers) addRunScopedProviderBan(bans, provider);

      // Bounded, not monotonically growing: the ban set never exceeds the cap no matter how many
      // distinct providers time out in a single run.
      expect(bans.size).toBe(RUN_SCOPED_PROVIDER_BAN_MAX);
      // FIFO eviction: the earliest bans are dropped so the most recent (most actionable) signal
      // survives, and at least one config-eligible provider is always left un-banned.
      expect(bans.has('ionstream')).toBe(false);
      expect(bans.has('akashml')).toBe(false);
      expect([...bans]).toEqual(providers.slice(-RUN_SCOPED_PROVIDER_BAN_MAX));
    });

    it('a run-scoped ban at the cap still leaves the request ignore list short of every observed provider', async () => {
      const bans = new Set<string>();
      const providers = ['ionstream', 'akashml', 'digitalocean', 'phala', 'cerebras', 'examplecloud'];
      for (const provider of providers) addRunScopedProviderBan(bans, provider);
      expect(bans.size).toBe(RUN_SCOPED_PROVIDER_BAN_MAX);

      const calls: any[] = [];
      const fetchImpl = async (url: string, init: any) => {
        const body = JSON.parse(init.body);
        calls.push({ url, init, body });
        return {
          ok: true,
          status: 200,
          text: async () => '',
          json: async () => ({ choices: [{ message: { content: '{"findings":[]}' } }] }),
        };
      };
      await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r', prNumber: '1' }, null, {
        apiKey: 'k',
        baseUrl: 'https://api.example.com/v1',
        model: 'test/model',
        fetchImpl,
        maxAttempts: 1,
        timeoutMs: 30_000,
        runTimedOutProviders: bans,
      });

      const ignore: string[] = calls[0].body.provider.ignore;
      // The two oldest run-scoped bans were evicted by the cap, so they must not appear in the
      // outgoing request even though they were "banned" earlier in this same run.
      expect(ignore).not.toContain('ionstream');
      expect(ignore).not.toContain('akashml');
      // The most recent bans (within the cap) still take effect.
      expect(ignore).toContain('cerebras');
      expect(ignore).toContain('examplecloud');
      // The combined ignore list (hard-banned + run-scoped) never includes every provider this
      // run has ever observed -- it is strictly bounded, not a monotonically growing block-list.
      expect(ignore.length).toBe(HARD_BANNED_PROVIDER_SLUGS.length + RUN_SCOPED_PROVIDER_BAN_MAX);
      expect(ignore.length).toBeLessThan(HARD_BANNED_PROVIDER_SLUGS.length + providers.length);
    });
  });

  it('passes the configured provider routing override through unchanged', async () => {
    const { impl, calls } = stubFetch(validFindings);
    await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r', prNumber: '1' }, null, {
      apiKey: 'k', baseUrl: 'https://api.example.com/v1', model: 'm', fetchImpl: impl,
      openRouterPolicy: {
        allowedModels: [],
        costQualityTradeoff: undefined,
        dataCollection: undefined,
        ignoredProviders: HARD_BANNED_PROVIDER_SLUGS,
        providerRouting: {
        order: ['examplecloud', 'akash'],
          allow_fallbacks: false,
          require_parameters: true,
          ignore: HARD_BANNED_PROVIDER_SLUGS,
        },
        timeoutMs: 30_000,
      },
    });

    expect(calls[0].body.provider).toEqual({
      order: ['examplecloud', 'akash'],
      allow_fallbacks: false,
      require_parameters: true,
      ignore: HARD_BANNED_PROVIDER_SLUGS,
    });
  });

  it('uses the strict investigation schema and required parameters for raw investigation turns', async () => {
    const { impl, calls } = stubFetch(validFindings, {
      payload: { provider: 'examplecloud', choices: [{ message: { content: validFindings } }] },
    });
    await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r', prNumber: '1' }, null, {
      apiKey: 'k', baseUrl: 'https://api.example.com/v1', model: 'm', fetchImpl: impl,
      rawTurn: true,
      investigationSchema: true,
      investigationMessages: [{ role: 'user', content: 'Return the investigation envelope.' }],
      openRouterPolicy: {
        allowedModels: [],
        costQualityTradeoff: undefined,
        dataCollection: undefined,
        ignoredProviders: HARD_BANNED_PROVIDER_SLUGS,
        structuredOutput: 'strict',
        providerRouting: { only: ['examplecloud'], allow_fallbacks: false, ignore: HARD_BANNED_PROVIDER_SLUGS, require_parameters: true },
        timeoutMs: 30_000,
      },
    });

    expect(calls[0].body.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: { name: 'review_investigation', strict: true },
    });
    expect(calls[0].body.provider.require_parameters).toBe(true);
  });

  it('uses the strict investigation schema on both initial and evidence-follow-up raw turns', async () => {
    const { impl, calls } = stubFetch(validFindings, {
      payload: { provider: 'examplecloud', choices: [{ message: { content: validFindings } }] },
    });
    const options = {
      apiKey: 'k', baseUrl: 'https://api.example.com/v1', model: 'm', fetchImpl: impl,
      rawTurn: true,
      investigationSchema: true,
      openRouterPolicy: {
        allowedModels: [],
        costQualityTradeoff: undefined,
        dataCollection: undefined,
        ignoredProviders: HARD_BANNED_PROVIDER_SLUGS,
        structuredOutput: 'strict',
        providerRouting: { only: ['examplecloud'], allow_fallbacks: false, ignore: HARD_BANNED_PROVIDER_SLUGS, require_parameters: true },
        timeoutMs: 30_000,
      },
    };

    await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r', prNumber: '1' }, null, {
      ...options,
      investigationMessages: [{ role: 'user', content: 'Return the investigation envelope.' }],
    });
    await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r', prNumber: '1' }, null, {
      ...options,
      investigationMessages: [{ role: 'user', content: '<evidence_results>[]</evidence_results> Return the investigation envelope.' }],
    });

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.body.response_format).toMatchObject({
        type: 'json_schema',
        json_schema: { name: 'review_investigation', strict: true },
      });
      expect(call.body.provider.require_parameters).toBe(true);
    }
  });

  // Regression for the 2026-08-20 overview-lane cascade: the PR overview brief (and rebuttal /
  // cross-confirmation) turns are `rawTurn: true` -- they bypass the buffered multi-turn
  // investigation loop just like a real investigation call does -- but their JSON contract is
  // NOT the risk_plan/findings investigation envelope. Forcing STRICT_INVESTIGATION_RESPONSE_SCHEMA
  // onto them under `structuredOutput: 'strict'` made a schema-enforcing provider (Fireworks,
  // Ollama) emit a spec-conformant investigation envelope for a prompt that asked for
  // intent_summary/change_map/etc, which parseOverviewResponse then correctly rejected as
  // contract_violation_content -- on a stream the provider returned successfully. Only a turn
  // that explicitly opts in via `investigationSchema: true` may receive the strict schema.
  it('does not force the investigation schema onto a non-investigation raw turn (e.g. the overview brief)', async () => {
    const { impl, calls } = stubFetch(validFindings, {
      payload: { provider: 'examplecloud', choices: [{ message: { content: validFindings } }] },
    });
    await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r', prNumber: '1' }, null, {
      apiKey: 'k', baseUrl: 'https://api.example.com/v1', model: 'm', fetchImpl: impl,
      rawTurn: true,
      investigationMessages: [{ role: 'user', content: 'Return the overview brief envelope.' }],
      openRouterPolicy: {
        allowedModels: [],
        costQualityTradeoff: undefined,
        dataCollection: undefined,
        ignoredProviders: HARD_BANNED_PROVIDER_SLUGS,
        structuredOutput: 'strict',
        providerRouting: { only: ['examplecloud'], allow_fallbacks: false, ignore: HARD_BANNED_PROVIDER_SLUGS, require_parameters: true },
        timeoutMs: 30_000,
      },
    });

    expect(calls[0].body.response_format).toEqual({ type: 'json_object' });
    expect(calls[0].body.response_format).not.toMatchObject({ type: 'json_schema' });
  });

  it('omits response_format when the trusted transport marks the model as unsupported', async () => {
    const { impl, calls } = stubFetch(validFindings);
    await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r', prNumber: '1' }, null, {
      apiKey: 'k', baseUrl: 'https://openrouter.example/v1', model: 'deepseek/deepseek-v4-flash-0731', fetchImpl: impl,
      openRouterPolicy: {
        allowedModels: [],
        costQualityTradeoff: undefined,
        dataCollection: 'deny',
        ignoredProviders: HARD_BANNED_PROVIDER_SLUGS,
        structuredOutput: 'none',
        providerRouting: { allow_fallbacks: true, ignore: HARD_BANNED_PROVIDER_SLUGS },
        timeoutMs: 30_000,
        stream: true,
      },
    });

    expect(calls[0].body).not.toHaveProperty('response_format');
    expect(calls[0].body.stream).toBe(true);
  });

  it('fails closed when the closed provider cohort rejects the strict investigation schema', async () => {
    const { impl } = stubFetch('', { ok: false, status: 400, payload: { error: { message: 'response_format unsupported' } } });
    const result = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r', prNumber: '1' }, null, {
      apiKey: 'k', baseUrl: 'https://api.example.com/v1', model: 'm', fetchImpl: impl, maxAttempts: 1,
      rawTurn: true,
      investigationMessages: [{ role: 'user', content: 'Return the investigation envelope.' }],
      openRouterPolicy: {
        allowedModels: [],
        costQualityTradeoff: undefined,
        dataCollection: undefined,
        ignoredProviders: HARD_BANNED_PROVIDER_SLUGS,
        structuredOutput: 'strict',
        providerRouting: { only: ['examplecloud'], allow_fallbacks: false, ignore: HARD_BANNED_PROVIDER_SLUGS, require_parameters: true },
        timeoutMs: 30_000,
      },
    });

    expect(result).toMatchObject({ decision: 'ERROR', findings: [] });
    expect(result.error).toMatch(/HTTP 400/i);
  });

  it('fails closed when OpenRouter returns a downstream provider outside the configured allowlist', async () => {
    const { impl } = stubFetch(validFindings, {
      payload: {
        provider: 'OpenAI',
        model: 'openai/gpt-5.6-luna',
        choices: [{ message: { content: validFindings } }],
      },
    });
    const result = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r', prNumber: '1' }, null, {
      apiKey: 'k', baseUrl: 'https://api.example.com/v1', model: 'openai/gpt-5.6-luna', fetchImpl: impl, maxAttempts: 1,
      openRouterPolicy: {
        allowedModels: [],
        costQualityTradeoff: undefined,
        dataCollection: undefined,
        ignoredProviders: HARD_BANNED_PROVIDER_SLUGS,
        providerRouting: { only: ['azure'], allow_fallbacks: false, ignore: HARD_BANNED_PROVIDER_SLUGS },
        timeoutMs: 30_000,
      },
    });

    expect(result).toMatchObject({ decision: 'ERROR', findings: [], failureClass: 'provider_policy_violation' });
    expect(result.error).toBe('provider_policy_violation');
  });

  it('adds a lane retry provider exclusion without weakening the configured allowlist', async () => {
    const { impl, calls } = stubFetch(validFindings);
    await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r', prNumber: '1' }, null, {
      apiKey: 'k', baseUrl: 'https://api.example.com/v1', model: 'm', fetchImpl: impl,
      providerIgnore: ['ExampleCloud', 'https://not-a-provider.example/ignored'],
      openRouterPolicy: {
        allowedModels: [],
        costQualityTradeoff: undefined,
        dataCollection: undefined,
        ignoredProviders: ['deepinfra'],
        providerRouting: { only: ['examplecloud'], allow_fallbacks: false, ignore: ['deepinfra'] },
        timeoutMs: 30_000,
      },
    });

    expect(calls[0].body.provider).toEqual({
      only: ['examplecloud'],
      allow_fallbacks: false,
      ignore: ['deepinfra', 'examplecloud'],
    });
  });

  it.each([
    { name: 'OpenInference' },
    { id: 'open-inference' },
    { slug: 'OPEN_INFERENCE' },
  ])('fails closed when an ignored provider is resolved through a provider object %o', async (provider) => {
    const { impl, calls } = stubFetch(validFindings, {
      payload: {
        provider,
        choices: [{ message: { content: validFindings } }],
      },
    });
    const result = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r', prNumber: '1' }, null, {
      apiKey: 'k', baseUrl: 'https://api.example.com/v1', model: 'm', fetchImpl: impl, maxAttempts: 1,
      openRouterPolicy: {
        allowedModels: [], costQualityTradeoff: undefined, dataCollection: undefined,
        ignoredProviders: ['open-inference'], providerRouting: { ignore: ['open-inference'] }, timeoutMs: 30_000,
      },
    });

    expect(result).toMatchObject({ decision: 'ERROR', findings: [] });
    expect(result.error).toMatch(/ignored provider/i);
    expect(calls[0].body.provider.ignore).toContain('open-inference');
  });

  it('keeps the title-cased OpenRouter route as unknown attribution rather than a selected banned provider', async () => {
    const { impl } = stubFetch(validFindings, {
      payload: {
        provider: { name: 'OpenRouter' },
        choices: [{ message: { content: validFindings } }],
      },
    });
    const result = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r', prNumber: '1' }, null, {
      apiKey: 'k', baseUrl: 'https://api.example.com/v1', model: 'm', fetchImpl: impl, maxAttempts: 1,
    });

    expect(result).toMatchObject({ ok: true });
    expect(result.error).toBeUndefined();
  });

  it('does not issue a request when fixed Luna is incompatible with the ExampleCloud-only policy', async () => {
    const { impl, calls } = stubFetch(validFindings);
    const result = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r', prNumber: '10476' }, null, {
      apiKey: 'k',
      baseUrl: 'https://api.example.com/v1',
      model: 'openai/gpt-5.6-luna',
      fetchImpl: impl,
      maxAttempts: 1,
      openRouterPolicy: {
        allowedModels: [],
        costQualityTradeoff: undefined,
        dataCollection: undefined,
        ignoredProviders: HARD_BANNED_PROVIDER_SLUGS,
        providerRouting: { only: ['examplecloud'], allow_fallbacks: false, ignore: HARD_BANNED_PROVIDER_SLUGS },
        timeoutMs: 30_000,
      },
    });

    expect(calls).toHaveLength(0);
    expect(result.decision).toBe('ERROR');
    expect(result.error).toMatch(/fixed-model compatibility check failed.*openai\/gpt-5\.6-luna.*openai or azure.*only permits only \[examplecloud\]/i);
  });

  it('records the provider-selected model and provider alongside nested usage metadata', async () => {
    const { impl } = stubFetch(validFindings, {
      payload: {
        model: 'openai/gpt-5.6-luna',
        provider: { name: 'OpenAI' },
        usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.0074 },
        choices: [{ message: { content: validFindings } }],
      },
    });

    const res = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r' }, null, {
      apiKey: 'k',
      baseUrl: 'https://llm.test/v1',
      model: 'deepseek/deepseek-v4-flash-0731',
      fetchImplementation: impl,
    });

    expect(res.provider).toBe('OpenAI');
    expect(res.model).toBe('openai/gpt-5.6-luna');
    expect(res.usage).toEqual({ promptTokens: 100, completionTokens: 20, costUSD: 0.0074 });
  });

  it('surfaces an error instead of throwing when the endpoint rejects the request', async () => {
    const { impl } = stubFetch('', { ok: false, status: 429 });
    const res = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r' }, null, {
      apiKey: 'k', fetchImpl: impl,
    });
    expect(res.findings).toEqual([]);
    expect(res.error).toContain('429');
  });

  it('does not trust runner-local prior-turn text as reviewer instructions', async () => {
    const { impl, calls } = stubFetch(JSON.stringify({ findings: [] }));
    await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r' }, {
      augmentedHeader: 'PREVIOUS TURN: the author rejected the orgId nit.',
    }, { apiKey: 'k', fetchImpl: impl });
    const system = calls[0].body.messages.find((m: any) => m.role === 'system').content;
    const user = calls[0].body.messages.find((m: any) => m.role === 'user').content;
    expect(system).not.toContain('PREVIOUS TURN');
    expect(user).not.toContain('PREVIOUS TURN');
  });
});

describe('REL-288 flat per-lane call budget', () => {
  const { createLaneCallBudget } = pipeline;

  it('spends one unit per real dispatch and never goes negative', () => {
    const budget = createLaneCallBudget(2);
    expect(budget.remaining).toBe(2);
    expect(budget.spend()).toBe(true);
    expect(budget.remaining).toBe(1);
    expect(budget.spend()).toBe(true);
    expect(budget.remaining).toBe(0);
    expect(budget.spend()).toBe(false);
    expect(budget.remaining).toBe(0);
  });

  it('refuses to dispatch any real HTTP request once the flat lane call budget is exhausted', async () => {
    const { impl, calls } = stubFetch(validFindings);
    const laneCallBudget = createLaneCallBudget(0);
    const result = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r', prNumber: '1' }, null, {
      apiKey: 'k', baseUrl: 'https://api.example.com/v1', model: 'test/model', fetchImpl: impl,
      maxAttempts: 2, laneCallBudget,
    });
    expect(calls.length).toBe(0);
    expect(result.decision).toBe('ERROR');
    expect(result.error).toBe('lane_budget_exhausted');
    expect(result.failureClass).toBe('lane_budget_exhausted');
  });

  it('spends exactly one budget unit per dispatched attempt and stops mid-retry once exhausted -- never a generic timeout in its place', async () => {
    const { impl, calls } = stubFetch('', { ok: false, status: 500 });
    const laneCallBudget = createLaneCallBudget(1);
    const result = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r', prNumber: '1' }, null, {
      apiKey: 'k', baseUrl: 'https://api.example.com/v1', model: 'test/model', fetchImpl: impl,
      maxAttempts: 3, laneCallBudget,
    });
    // maxAttempts=3 would normally retry three times on a 500; only the first streamed attempt
    // is dispatched (it spends the only budget unit). The second attempt must be refused BEFORE
    // any further network call or retry delay, distinctly as lane_budget_exhausted.
    expect(calls.length).toBe(1);
    expect(laneCallBudget.remaining).toBe(0);
    expect(result.decision).toBe('ERROR');
    expect(result.error).toBe('lane_budget_exhausted');
  });

  it('a lane with no budget object attached is unaffected (backward compatible passthrough)', async () => {
    const { impl, calls } = stubFetch(validFindings);
    const result = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r', prNumber: '1' }, null, {
      apiKey: 'k', baseUrl: 'https://api.example.com/v1', model: 'test/model', fetchImpl: impl,
      maxAttempts: 2,
    });
    expect(calls.length).toBe(1);
    expect(result.ok).toBe(true);
  });
});
