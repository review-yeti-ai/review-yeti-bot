import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';

const rootRepoDir = fs.existsSync(path.join(path.resolve(__dirname, '../..'), '.github/workflows/pipelines/review-pipeline.js'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');
const pipeline = require(path.join(rootRepoDir, '.github/workflows/pipelines/review-pipeline.js'));
const { HARD_BANNED_PROVIDER_SLUGS } = require(path.join(rootRepoDir, '.github/workflows/pipelines/openRouterPolicy.js'));

const { reviewWithModel, resolveModelConfig, PERSONA_CHARTERS, addRunScopedProviderBan, RUN_SCOPED_PROVIDER_BAN_MAX } = pipeline;
const securityPersona = PERSONA_CHARTERS.find((p: any) => p.id === 'security');
const dependencyPersona = PERSONA_CHARTERS.find((p: any) => p.id === 'dependencies');

const diffFiles = [
  {
    path: 'src/api/user.ts',
    patch: 'diff --git a/src/api/user.ts b/src/api/user.ts\n+const id = req.query.id;\n',
    addedLines: [{ text: 'const id = req.query.id;' }],
    deletedLines: [],
  },
];

/** Builds a fetch stub returning an OpenAI-compatible chat completion. */
function stubFetch(content: string, opts: { ok?: boolean; status?: number; payload?: any } = {}) {
  const calls: any[] = [];
  const impl = async (url: string, init: any) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return {
      ok: opts.ok !== false,
      status: opts.status || 200,
      text: async () => 'error body',
      json: async () => opts.payload || ({ choices: [{ message: { content } }] }),
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
  it('uses bounded non-stream responses when concurrent fan-out disables streaming', async () => {
    const { impl, calls } = stubFetch('{"findings":[]}');

    await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r', prNumber: '1' }, null, {
      apiKey: 'k',
      baseUrl: 'https://api.example.com/v1',
      model: 'test/model',
      fetchImpl: impl,
      maxAttempts: 1,
      preferStream: true,
      disableStream: true,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].body.stream).toBe(false);
  });

  it('puts bounded prior decisions in user data and never in the trusted system prompt', async () => {
    const decisionLedgerText = [
      'Prior Review Yeti decisions (same pull request):',
      '- [P1] src/api/user.ts:42 — Tenant predicate is missing',
    ].join('\n');
    const { impl, calls } = stubFetch('{"findings":[]}');

    await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r', prNumber: '1' }, {
      augmentedHeader: 'accepted until API-1234',
    }, {
      apiKey: 'k',
      baseUrl: 'https://api.example.com/v1',
      model: 'test/model',
      fetchImpl: impl,
      maxAttempts: 1,
      fileManifest: 'Complete pull request file manifest:\n- src/api/user.ts',
      decisionLedgerText,
    });

    const system = calls[0].body.messages.find((message: any) => message.role === 'system').content;
    const user = calls[0].body.messages.find((message: any) => message.role === 'user').content;
    expect(system).toContain('A prior-decisions section may appear');
    expect(system).not.toContain('Tenant predicate is missing');
    expect(system).not.toContain('accepted until API-1234');
    expect(user.indexOf('Complete pull request file manifest')).toBeLessThan(user.indexOf('Prior Review Yeti decisions'));
    expect(user).toContain('[P1] src/api/user.ts:42');
    expect(user).not.toContain('accepted until API-1234');
  });

  it('adds no prior-decision user block when the ledger is empty', async () => {
    const { impl, calls } = stubFetch('{"findings":[]}');
    await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r', prNumber: '1' }, null, {
      apiKey: 'k',
      baseUrl: 'https://api.example.com/v1',
      model: 'test/model',
      fetchImpl: impl,
      maxAttempts: 1,
      decisionLedgerText: '',
    });

    const system = calls[0].body.messages.find((message: any) => message.role === 'system').content;
    const user = calls[0].body.messages.find((message: any) => message.role === 'user').content;
    expect(system).toContain('A prior-decisions section may appear');
    expect(user).not.toContain('Prior Review Yeti decisions');
  });

  it('adds the bounded Honcho advisory block to user data, never the trusted system prompt', async () => {
    const { impl, calls } = stubFetch('{"findings":[]}');
    await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r', prNumber: '1' }, null, {
      apiKey: 'k',
      baseUrl: 'https://api.example.com/v1',
      model: 'test/model',
      fetchImpl: impl,
      maxAttempts: 1,
      honchoContextBlock: 'Honcho advisory memory (untrusted):\n- prior P1 on tenant scoping',
    });

    const system = calls[0].body.messages.find((message: any) => message.role === 'system').content;
    const user = calls[0].body.messages.find((message: any) => message.role === 'user').content;
    expect(system).not.toContain('prior P1 on tenant scoping');
    expect(user).toContain('Honcho advisory memory (untrusted):');
    expect(user).toContain('prior P1 on tenant scoping');
  });

  it('uses the configured DeepSeek fallback after the primary model has a transient failure', async () => {
    const calls: any[] = [];
    const fetchImpl = async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      calls.push({ url, init, body });
      if (calls.length === 1) {
        return {
          ok: false,
          status: 503,
          text: async () => 'provider unavailable',
          json: async () => ({ error: { message: 'provider unavailable' } }),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({ choices: [{ message: { content: validFindings } }] }),
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
          stream: false,
        },
      },
    );

    expect(calls).toHaveLength(2);
    expect(calls[0].body.model).toBe('openrouter/auto-beta');
    expect(calls[1].body.model).toBe('deepseek/deepseek-v4-flash-0731');
    expect(calls[0].body.session_id).not.toBe(calls[1].body.session_id);
    expect(result.model).toBe('deepseek/deepseek-v4-flash-0731');
    expect(result.fallbackUsed).toBe(true);
    expect(result.findings).toHaveLength(1);
  });

  it('retries the primary model before moving to the configured fallback', async () => {
    const calls: any[] = [];
    const fetchImpl = async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      calls.push({ url, init, body });
      if (calls.length < 3) {
        return {
          ok: false,
          status: 503,
          text: async () => 'provider unavailable',
          json: async () => ({ error: { message: 'provider unavailable' } }),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({ choices: [{ message: { content: validFindings } }] }),
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
        stream: false,
      },
    });

    expect(calls).toHaveLength(3);
    expect(calls[0].body.model).toBe('openrouter/auto-beta');
    expect(calls[1].body.model).toBe('openrouter/auto-beta');
    expect(calls[2].body.model).toBe('deepseek/deepseek-v4-flash-0731');
    expect(result.fallbackUsed).toBe(true);
  });

  it('moves to the fallback after a client-side timeout', async () => {
    const calls: any[] = [];
    const fetchImpl = async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      calls.push({ url, init, body });
      if (calls.length === 1) {
        const error: any = new Error('request aborted');
        error.name = 'AbortError';
        throw error;
      }
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({ choices: [{ message: { content: validFindings } }] }),
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
        stream: false,
      },
    });

    expect(calls).toHaveLength(3);
    expect(calls[1].body.model).toBe('deepseek/deepseek-v4-flash-0731');
    expect(calls[1].body.stream).toBe(true);
    expect(calls[2].body.stream).toBe(false);
    expect(result.fallbackUsed).toBe(true);
    expect(result.decision).toBe('FINDINGS');
  });

  // REL-271 (D3): attempt 2 no longer gets a doubled response budget -- every attempt uses the
  // same flat timeoutMs. The recovery mechanism (force SSE on retry so the resolved provider is
  // visible) still works as long as the provider responds within the *unescalated* budget.
  it('streaming recovery retry uses the same (non-doubled) response budget', async () => {
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
            let sent = false;
            return {
              read: async () => {
                if (sent) return { done: true, value: undefined };
                // Comfortably under the flat 10ms budget -- proves recovery survives without
                // needing the removed x2 escalation.
                await new Promise((resolve) => setTimeout(resolve, 3));
                sent = true;
                return {
                  done: false,
                  value: Buffer.from(`data: ${JSON.stringify({
                    id: 'gen-recovery',
                    model: 'test/model',
                    provider: 'Morph',
                    choices: [{ delta: { content: '{"findings":[]}' } }],
                  })}\n\ndata: [DONE]\n\n`),
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
      baseUrl: 'https://api.example.com/v1',
      model: 'test/model',
      fetchImpl,
      maxAttempts: 2,
      timeoutMs: 10,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0].body.stream).toBe(false);
    expect(calls[1].body.stream).toBe(true);
    expect(result.decision).toBe('APPROVE');
    expect(result.provider).toBe('Morph');
  });

  // REL-271 (D3): a delay that would have succeeded under the removed x2 escalation (15ms, twice
  // the 10ms flat budget less a small margin) now fails on the final attempt instead of quietly
  // recovering -- proving there is no budget escalation left anywhere in the retry path.
  it('does not extend the response budget on retry -- a delay that needed the old x2 escalation now fails', async () => {
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
            let sent = false;
            return {
              read: async () => {
                if (sent) return { done: true, value: undefined };
                // Exceeds the flat 10ms budget, but would have fit inside the old doubled 20ms
                // budget -- this is the regression check for D3.
                await new Promise((resolve) => setTimeout(resolve, 15));
                sent = true;
                return {
                  done: false,
                  value: Buffer.from(`data: ${JSON.stringify({
                    id: 'gen-recovery',
                    model: 'test/model',
                    provider: 'Morph',
                    choices: [{ delta: { content: '{"findings":[]}' } }],
                  })}\n\ndata: [DONE]\n\n`),
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
      baseUrl: 'https://api.example.com/v1',
      model: 'test/model',
      fetchImpl,
      maxAttempts: 2,
      timeoutMs: 10,
    });

    expect(calls).toHaveLength(2);
    expect(result.decision).toBe('ERROR');
  });

  it('enforces the total timeout while reading a non-stream response body', async () => {
    const calls: any[] = [];
    const fetchImpl = async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      calls.push({ url, init, body });
      const firstAttempt = calls.length === 1;
      return {
        ok: true,
        status: 200,
        headers: { get: (name: string) => name.toLowerCase() === 'x-openrouter-provider' ? (firstAttempt ? 'Morph' : 'OpenAI') : null },
        json: async () => {
          if (firstAttempt) await new Promise((resolve) => setTimeout(resolve, 80));
          return { choices: [{ message: { content: validFindings } }] };
        },
      };
    };

    const startedAt = Date.now();
    const result = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r', prNumber: '1' }, null, {
      apiKey: 'k',
      baseUrl: 'https://api.example.com/v1',
      model: 'test/model',
      fetchImpl,
      // REL-271 (D3/D4): recovery here now requires 2 real attempts (no bonus attempt after
      // attribution) -- attempt 1 times out during body-read and bans "morph", attempt 2 forces
      // SSE for attribution and succeeds with "OpenAI".
      maxAttempts: 2,
      timeoutMs: 20,
    });

    expect(result.decision).toBe('FINDINGS');
    expect(calls).toHaveLength(3);
    expect(calls[1].body.provider.ignore).toContain('morph');
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
    expect(result.decision).toBe('APPROVE');
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

    expect(result.decision).toBe('APPROVE');
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
    }

    /** A lane whose second attempt times out on a named provider, then a third attempt succeeds. */
    function timeoutThenSucceedFetch(bannedProvider: string, calls: any[]) {
      return async (url: string, init: any) => {
        const body = JSON.parse(init.body);
        calls.push({ url, init, body });
        if (calls.length === 1) {
          throw Object.assign(new Error('request aborted'), { name: 'AbortError' });
        }
        if (calls.length === 2) {
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
      // preferStream) identifies+bans DigitalOcean, attempt 2 (the last one) is the recovery.
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

      expect(laneOne.decision).toBe('APPROVE');
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
      const providers = ['ionstream', 'akashml', 'digitalocean', 'phala', 'cerebras', 'morph', 'groq'];
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
      const providers = ['ionstream', 'akashml', 'digitalocean', 'phala', 'cerebras', 'morph'];
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
      expect(ignore).toContain('morph');
      // The combined ignore list (hard-banned + run-scoped) never includes every provider this
      // run has ever observed -- it is strictly bounded, not a monotonically growing block-list.
      expect(ignore.length).toBe(HARD_BANNED_PROVIDER_SLUGS.length + RUN_SCOPED_PROVIDER_BAN_MAX);
      expect(ignore.length).toBeLessThan(HARD_BANNED_PROVIDER_SLUGS.length + providers.length);
    });
  });

  it('treats empty model output as retryable before using the fallback', async () => {
    const calls: any[] = [];
    const fetchImpl = async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      calls.push({ url, init, body });
      if (calls.length === 1) {
        return {
          ok: true,
          status: 200,
          text: async () => '',
          json: async () => ({ choices: [{ message: { content: '' } }] }),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({ choices: [{ message: { content: validFindings } }] }),
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
        stream: false,
      },
    });

    expect(calls).toHaveLength(2);
    expect(calls[0].body.model).toBe('openrouter/auto-beta');
    expect(calls[1].body.model).toBe('deepseek/deepseek-v4-flash-0731');
    expect(result.fallbackUsed).toBe(true);
    expect(result.decision).toBe('FINDINGS');
  });

  it('posts the persona charter as the system prompt to the chat completions endpoint', async () => {
    const { impl, calls } = stubFetch(validFindings);
    await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r', prNumber: '1' }, null, {
      apiKey: 'k', baseUrl: 'https://api.example.com/v1', model: 'm', fetchImpl: impl,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.example.com/v1/chat/completions');
    expect(calls[0].init.headers.Authorization).toBe('Bearer k');
    expect(calls[0].body.model).toBe('m');
    expect(calls[0].body.provider).toEqual({ ignore: HARD_BANNED_PROVIDER_SLUGS });
    const system = calls[0].body.messages.find((m: any) => m.role === 'system').content;
    expect(system).toContain(securityPersona.charter);
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
        order: ['morph', 'akash'],
          allow_fallbacks: false,
          require_parameters: true,
          ignore: HARD_BANNED_PROVIDER_SLUGS,
        },
        timeoutMs: 30_000,
        stream: false,
      },
    });

    expect(calls[0].body.provider).toEqual({
      order: ['morph', 'akash'],
      allow_fallbacks: false,
      require_parameters: true,
      ignore: HARD_BANNED_PROVIDER_SLUGS,
    });
  });

  it('uses the strict investigation schema and required parameters for raw investigation turns', async () => {
    const { impl, calls } = stubFetch(validFindings, {
      payload: { provider: 'morph', choices: [{ message: { content: validFindings } }] },
    });
    await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r', prNumber: '1' }, null, {
      apiKey: 'k', baseUrl: 'https://api.example.com/v1', model: 'm', fetchImpl: impl,
      rawTurn: true,
      investigationMessages: [{ role: 'user', content: 'Return the investigation envelope.' }],
      openRouterPolicy: {
        allowedModels: [],
        costQualityTradeoff: undefined,
        dataCollection: undefined,
        ignoredProviders: HARD_BANNED_PROVIDER_SLUGS,
        structuredOutput: 'strict',
        providerRouting: { only: ['morph'], allow_fallbacks: false, ignore: HARD_BANNED_PROVIDER_SLUGS, require_parameters: true },
        timeoutMs: 30_000,
        stream: false,
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
      payload: { provider: 'morph', choices: [{ message: { content: validFindings } }] },
    });
    const options = {
      apiKey: 'k', baseUrl: 'https://api.example.com/v1', model: 'm', fetchImpl: impl,
      rawTurn: true,
      openRouterPolicy: {
        allowedModels: [],
        costQualityTradeoff: undefined,
        dataCollection: undefined,
        ignoredProviders: HARD_BANNED_PROVIDER_SLUGS,
        structuredOutput: 'strict',
        providerRouting: { only: ['morph'], allow_fallbacks: false, ignore: HARD_BANNED_PROVIDER_SLUGS, require_parameters: true },
        timeoutMs: 30_000,
        stream: false,
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

  it('does not apply the investigation schema to a legacy review turn', async () => {
    const { impl, calls } = stubFetch(validFindings);
    await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r', prNumber: '1' }, null, {
      apiKey: 'k', baseUrl: 'https://api.example.com/v1', model: 'm', fetchImpl: impl,
      openRouterPolicy: {
        allowedModels: [],
        costQualityTradeoff: undefined,
        dataCollection: undefined,
        ignoredProviders: HARD_BANNED_PROVIDER_SLUGS,
        structuredOutput: 'strict',
        providerRouting: { only: ['morph'], allow_fallbacks: false, ignore: HARD_BANNED_PROVIDER_SLUGS, require_parameters: true },
        timeoutMs: 30_000,
        stream: false,
      },
    });

    expect(calls[0].body.response_format).toEqual({ type: 'json_object' });
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
        providerRouting: { only: ['morph'], allow_fallbacks: false, ignore: HARD_BANNED_PROVIDER_SLUGS, require_parameters: true },
        timeoutMs: 30_000,
        stream: false,
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
        stream: false,
      },
    });

    expect(result).toMatchObject({ decision: 'ERROR', findings: [], failureClass: 'provider_policy_violation' });
    expect(result.error).toBe('provider_policy_violation');
  });

  it('adds a lane retry provider exclusion without weakening the configured allowlist', async () => {
    const { impl, calls } = stubFetch(validFindings);
    await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r', prNumber: '1' }, null, {
      apiKey: 'k', baseUrl: 'https://api.example.com/v1', model: 'm', fetchImpl: impl,
      providerIgnore: ['Morph', 'https://not-a-provider.example/ignored'],
      openRouterPolicy: {
        allowedModels: [],
        costQualityTradeoff: undefined,
        dataCollection: undefined,
        ignoredProviders: ['deepinfra'],
        providerRouting: { only: ['morph'], allow_fallbacks: false, ignore: ['deepinfra'] },
        timeoutMs: 30_000,
        stream: false,
      },
    });

    expect(calls[0].body.provider).toEqual({
      only: ['morph'],
      allow_fallbacks: false,
      ignore: ['deepinfra', 'morph'],
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
        ignoredProviders: ['open-inference'], providerRouting: { ignore: ['open-inference'] }, timeoutMs: 30_000, stream: false,
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

    expect(result).toMatchObject({ decision: 'FINDINGS' });
    expect(result.error).toBeUndefined();
  });

  it('does not issue a request when fixed Luna is incompatible with the Morph-only policy', async () => {
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
        providerRouting: { only: ['morph'], allow_fallbacks: false, ignore: HARD_BANNED_PROVIDER_SLUGS },
        timeoutMs: 30_000,
        stream: false,
      },
    });

    expect(calls).toHaveLength(0);
    expect(result.decision).toBe('ERROR');
    expect(result.error).toMatch(/fixed-model compatibility check failed.*openai\/gpt-5\.6-luna.*openai or azure.*only permits only \[morph\]/i);
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

  it('uses the canonical fetchImplementation boundary and fails closed on malformed provider JSON', async () => {
    const fetchImplementation = async () => new Response('{not-json', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const res = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r' }, null, {
      apiKey: 'k',
      baseUrl: 'https://llm.test/v1',
      model: 'synthetic-reviewer',
      fetchImplementation,
    });

    expect(res.decision).toBe('ERROR');
    expect(res.findings).toEqual([]);
    expect(res.error).toBeTruthy();
  });

  it('returns structured findings parsed from the model response', async () => {
    const { impl } = stubFetch(validFindings);
    const res = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r' }, null, {
      apiKey: 'k', fetchImpl: impl,
    });
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0].severity).toBe('P1');
    expect(res.findings[0].path).toBe('src/api/user.ts');
    expect(res.decision).toBe('FINDINGS');
  });

  it('normalizes a dependency evidence request without treating it as a clean approval', async () => {
    const { impl } = stubFetch(JSON.stringify({
      review_status: 'NEEDS_EVIDENCE',
      evidence_requests: [{ path: 'package-lock.json', kind: 'lockfile', reason: 'verify the resolved integrity entry' }],
      findings: [],
    }));
    const res = await reviewWithModel(dependencyPersona, [{
      path: 'package.json',
      patch: '@@ -1 +1 @@\n+{"dependencies":{"example":"1.0.0"}}',
    }], { repo: 'o/r' }, null, {
      apiKey: 'k', fetchImpl: impl,
    });

    expect(res.reviewStatus).toBe('NEEDS_EVIDENCE');
    expect(res.evidenceRequests).toEqual([{
      path: 'package-lock.json',
      kind: 'lockfile',
      reason: 'verify the resolved integrity entry',
    }]);
    expect(res.decision).toBe('NEEDS_EVIDENCE');
    expect(res.findings).toEqual([]);
  });

  it('bounds string and unsafe evidence requests before they reach the follow-up loop', async () => {
    const { impl } = stubFetch(JSON.stringify({
      review_status: 'NEEDS_EVIDENCE',
      evidence_requests: [
        'package-lock.json',
        { path: '../secrets.txt', kind: 'lockfile' },
        { path: '/absolute.txt', kind: 'lockfile' },
        { path: 'package.json', kind: 'manifest', reason: 'r'.repeat(500) },
      ],
      findings: [],
    }));
    const res = await reviewWithModel(dependencyPersona, [{
      path: 'package-lock.json',
      patch: '@@ -1 +1 @@\n+"lockfileVersion": 3',
    }], { repo: 'o/r' }, null, { apiKey: 'k', fetchImpl: impl });

    expect(res.evidenceRequests).toEqual([
      { path: 'package-lock.json', kind: 'other', reason: 'requested by the reviewer' },
      { path: 'package.json', kind: 'manifest', reason: 'r'.repeat(400) },
    ]);
  });

  it('includes bounded evidence and turn state in an investigation follow-up prompt', async () => {
    const { impl, calls } = stubFetch(JSON.stringify({ findings: [] }));
    const res = await reviewWithModel(dependencyPersona, [{
      path: 'package-lock.json',
      patch: '@@ -1 +1 @@\n+"integrity":"sha512-example"',
    }], { repo: 'o/r' }, {
      investigationContext: 'DEPENDENCY EVIDENCE\n- package-lock.json: integrity=sha512-example',
    }, {
      apiKey: 'k', fetchImpl: impl, turn: 2, maxInvestigationTurns: 2,
    });

    const system = calls[0].body.messages.find((message: any) => message.role === 'system').content;
    const user = calls[0].body.messages.find((message: any) => message.role === 'user').content;
    expect(system).toContain('evidence follow-up');
    expect(system).toContain('kind must match the path');
    expect(user).toContain('Dependency evidence follow-up turn 2 of 2');
    expect(user).toContain('sha512-example');
    expect(res.turn).toBe(2);
    expect(res.reviewStatus).toBe('APPROVE');
  });

  it('runs one bounded dependency evidence follow-up and marks unresolved evidence incomplete', async () => {
    const calls: any[] = [];
    const result = await pipeline.runPersonaInvestigation({
      persona: dependencyPersona,
      diffFiles: [{ path: 'package.json', patch: '@@ -1 +1 @@\n+"example":"1.0.0"' }],
      allDiffFiles: [{ path: 'package.json', patch: '@@ -1 +1 @@\n+"example":"1.0.0"' }],
      prContext: { repo: 'o/r', prNumber: '1' },
      maxInvestigationTurns: 2,
      modelOptions: {
        modelClient: ({ options }: any) => {
          calls.push(options);
          return calls.length === 1
            ? { personaId: 'dependencies', displayName: 'Dependencies', provider: 'test', model: 'test', decision: 'NEEDS_EVIDENCE', reviewStatus: 'NEEDS_EVIDENCE', evidenceRequests: [{ path: 'package-lock.json', kind: 'lockfile', reason: 'check the resolved version' }], findings: [], usage: { promptTokens: 1, completionTokens: 1 } }
            : { personaId: 'dependencies', displayName: 'Dependencies', provider: 'test', model: 'test', decision: 'APPROVE', reviewStatus: 'APPROVE', evidenceRequests: [], findings: [], usage: { promptTokens: 1, completionTokens: 1 } };
        },
      },
    });

    expect(calls).toHaveLength(2);
    expect(calls[1].turn).toBe(2);
    expect(result.reviewStatus).toBe('INCOMPLETE_REVIEW');
    expect(result.decision).toBe('INCOMPLETE_REVIEW');
    expect(result.incomplete).toBe(true);
    expect(result.investigationTurns).toBe(2);
  });

  it('parses findings wrapped in a markdown code fence', async () => {
    const { impl } = stubFetch('Sure!\n```json\n' + validFindings + '\n```\n');
    const res = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r' }, null, {
      apiKey: 'k', fetchImpl: impl,
    });
    expect(res.findings).toHaveLength(1);
  });

  it('discards findings for files absent from the diff', async () => {
    const hallucinated = JSON.stringify({
      findings: [
        { severity: 'P0', path: 'src/does-not-exist.ts', line: 1, title: 'Ghost', body: 'b' },
        { severity: 'P1', path: 'src/api/user.ts', line: 1, title: 'Real', body: 'b' },
      ],
    });
    const { impl } = stubFetch(hallucinated);
    const res = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r' }, null, {
      apiKey: 'k', fetchImpl: impl,
    });
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0].title).toBe('Real');
  });

  it('normalizes unknown severities to P2', async () => {
    const { impl } = stubFetch(JSON.stringify({
      findings: [{ severity: 'CRITICAL', path: 'src/api/user.ts', line: 1, title: 't', body: 'b' }],
    }));
    const res = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r' }, null, {
      apiKey: 'k', fetchImpl: impl,
    });
    expect(res.findings[0].severity).toBe('P2');
  });

  it('returns no findings rather than throwing on unparseable output', async () => {
    const { impl } = stubFetch('I could not analyze this diff, sorry.');
    const res = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r' }, null, {
      apiKey: 'k', fetchImpl: impl,
    });
    expect(res.findings).toEqual([]);
    expect(res.error).toBeTruthy();
  });

  it('surfaces an error instead of throwing when the endpoint rejects the request', async () => {
    const { impl } = stubFetch('', { ok: false, status: 429 });
    const res = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r' }, null, {
      apiKey: 'k', fetchImpl: impl,
    });
    expect(res.findings).toEqual([]);
    expect(res.error).toContain('429');
  });

  it('truncates oversized diffs to the configured character budget', async () => {
    const huge = [{
      path: 'src/api/user.ts',
      patch: 'x'.repeat(50_000),
      addedLines: [],
      deletedLines: [],
    }];
    const { impl, calls } = stubFetch(JSON.stringify({ findings: [] }));
    await reviewWithModel(securityPersona, huge, { repo: 'o/r' }, null, {
      apiKey: 'k', maxDiffChars: 1_000, fetchImpl: impl,
    });
    const user = calls[0].body.messages.find((m: any) => m.role === 'user').content;
    expect(user.length).toBeLessThan(3_000);
    expect(user).toContain('truncated');
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
    // maxAttempts=3 would normally retry three times on a 500; only the first attempt is a real
    // dispatch (it spends the only budget unit and fails with HTTP 500). The second attempt must
    // be refused BEFORE any further network call or retry delay, distinctly as
    // lane_budget_exhausted -- not a third HTTP 500, not a generic timeout.
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
    expect(result.decision).not.toBe('ERROR');
  });
});
