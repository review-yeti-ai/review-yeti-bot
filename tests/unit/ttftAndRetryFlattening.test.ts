// REL-271 + REL-272: dedicated RED-first coverage for the TTFT deadline, the flattened retry
// pyramid, and the max-investigation-turns bounded-mode wiring. See the PR body for the D1-D10
// defect-to-test mapping and the captured RED output.
import { describe, expect, it } from 'vitest';
import path from 'path';
import fs from 'fs';
import { runPersonaInvestigation } from '../../src/review/reviewInvestigation';
import { sseBody } from '../support/streamableFetchStub';

const rootRepoDir = fs.existsSync(path.join(path.resolve(__dirname, '../..'), '.github/workflows/pipelines/review-pipeline.js'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');
const pipeline = require(path.join(rootRepoDir, '.github/workflows/pipelines/review-pipeline.js'));
const { HARD_BANNED_PROVIDER_SLUGS } = require(path.join(rootRepoDir, '.github/workflows/pipelines/openRouterPolicy.js'));

const {
  callOpenRouterChat,
  reviewWithModel,
  reviewWithTransports,
  createStreamingLaneGate,
  callPersonaModelTurn,
  resolveBoundedInvestigationLimits,
  PERSONA_CHARTERS,
} = pipeline;
const securityPersona = PERSONA_CHARTERS.find((p: any) => p.id === 'security');

const diffFiles = [
  {
    path: 'src/api/user.ts',
    patch: 'diff --git a/src/api/user.ts b/src/api/user.ts\n+const id = req.query.id;\n',
    addedLines: [{ text: 'const id = req.query.id;' }],
    deletedLines: [],
  },
];

function neverChunkingStreamResponse() {
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        // Never resolves -- simulates a provider that accepted the connection and then queued
        // silently, with no SSE data ever arriving.
        read: () => new Promise(() => {}),
        cancel: async () => {},
      }),
    },
  };
}

function singleChunkThenSlowDoneStreamResponse(finishDelayMs: number) {
  let sentChunk = false;
  let sentDone = false;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => {
          if (!sentChunk) {
            sentChunk = true;
            return {
              done: false,
              value: Buffer.from(`data: ${JSON.stringify({
                id: 'gen-first-chunk',
                model: 'test/model',
                provider: 'ExampleCloud',
                choices: [{ delta: { content: '{"findings":[]}' } }],
              })}\n\n`),
            };
          }
          if (!sentDone) {
            sentDone = true;
            await new Promise((resolve) => setTimeout(resolve, finishDelayMs));
            return { done: false, value: Buffer.from('data: [DONE]\n\n') };
          }
          return { done: true, value: undefined };
        },
        cancel: async () => {},
      }),
    },
  };
}

function completedStreamWhoseSocketAbortsAfterDone() {
  let readCount = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => {
          readCount += 1;
          if (readCount === 1) {
            return {
              done: false,
              value: Buffer.from(`data: ${JSON.stringify({
                id: 'gen-complete',
                model: 'test/model',
                provider: 'test-provider',
                choices: [{ delta: { content: '{"findings":[]}' } }],
              })}\n\n`),
            };
          }
          if (readCount === 2) return { done: false, value: Buffer.from('data: [DONE]\n\n') };
          throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
        },
        cancel: async () => {},
      }),
    },
  };
}

// Reasoning models (deepseek-v4-flash-0731 at reasoning_effort:max/high) stream reasoning tokens
// in a delta field SEPARATE from `delta.content` -- verified empirically against live Fireworks
// (`delta.reasoning_content`) and OpenRouter (`delta.reasoning`) endpoints during the 2026-08-19
// reasoning-stall investigation (see review-pipeline.js's reasoningDeltaField doc comment). This
// fixture simulates a reasoning-heavy lane: several reasoning-only chunks (no delta.content at
// all) spaced out so their CUMULATIVE duration exceeds a deliberately tight ttftMs, followed by
// the real JSON content and [DONE]. If firstChunk detection were gated on `delta.content`
// specifically (the literal shape of the hypothesis under test), this stream would spuriously
// ttft_timeout even though the provider was demonstrably alive and generating the whole time.
function reasoningThenContentStreamResponse(reasoningField: string, reasoningChunkDelayMs: number, reasoningChunkCount: number) {
  let reasoningSent = 0;
  let contentSent = false;
  let doneSent = false;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => {
          if (reasoningSent < reasoningChunkCount) {
            reasoningSent += 1;
            if (reasoningSent > 1) await new Promise((resolve) => setTimeout(resolve, reasoningChunkDelayMs));
            return {
              done: false,
              value: Buffer.from(`data: ${JSON.stringify({
                id: 'gen-reasoning',
                model: 'test/model',
                provider: 'ReasoningCloud',
                choices: [{ delta: { [reasoningField]: `token${reasoningSent} ` } }],
              })}\n\n`),
            };
          }
          if (!contentSent) {
            contentSent = true;
            return {
              done: false,
              value: Buffer.from(`data: ${JSON.stringify({
                id: 'gen-reasoning',
                model: 'test/model',
                provider: 'ReasoningCloud',
                choices: [{ delta: { content: '{"findings":[]}' } }],
              })}\n\n`),
            };
          }
          if (!doneSent) {
            doneSent = true;
            return { done: false, value: Buffer.from('data: [DONE]\n\n') };
          }
          return { done: true, value: undefined };
        },
        cancel: async () => {},
      }),
    },
  };
}

describe('reasoning-stall investigation: reasoning-only SSE deltas count as TTFT/liveness evidence', () => {
  it.each([
    ['reasoning_content', 'Fireworks/DeepSeek-native field'],
    ['reasoning', 'OpenRouter field'],
    ['thinking', 'Ollama-style field'],
  ])('a %s-only chunk train (%s) clears TTFT and never ttft_timeouts, even though its cumulative duration exceeds ttftMs', async (reasoningField) => {
    const progressEvents: any[] = [];
    const result = await callOpenRouterChat(async () => reasoningThenContentStreamResponse(reasoningField, 12, 4), {
      url: 'https://openrouter.ai/api/v1/chat/completions',
      headers: { Authorization: 'Bearer test' },
      body: { model: 'test/model', messages: [] },
      timeoutMs: 5_000,
      // The FIRST reasoning chunk arrives immediately (well under 8ms); three more follow at 12ms
      // apiece (36ms total reasoning phase) before real content ever appears. If liveness were
      // gated on delta.content, this would spuriously ttft_timeout at the 8ms mark despite the
      // provider demonstrably talking to us the entire time.
      ttftMs: 8,
      preferStream: true,
      onStreamProgress: (event: any) => progressEvents.push(event),
    });

    expect(result.ok).toBe(true);
    expect(result.timeoutPhase).toBeUndefined();
    expect(result.failureClass).not.toBe('ttft_timeout');
    // The reasoning tokens are liveness evidence only -- they must never leak into the
    // accumulated response body that the JSON parser downstream will consume.
    expect(result.content).toBe('{"findings":[]}');
    expect(result.content).not.toContain('token');
    // onStreamProgress fires exactly once, on the first (reasoning) chunk, and reports it as such.
    expect(progressEvents).toHaveLength(1);
    expect(progressEvents[0].firstChunkKind).toBe('reasoning');
  });

  it('a chunk carrying both role and reasoning (no content) still counts as the first-chunk liveness signal', async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      body: {
        getReader: () => {
          let step = 0;
          return {
            read: async () => {
              step += 1;
              if (step === 1) {
                return {
                  done: false,
                  value: Buffer.from(`data: ${JSON.stringify({
                    id: 'gen-role-only',
                    model: 'test/model',
                    provider: 'ReasoningCloud',
                    choices: [{ delta: { role: 'assistant' } }],
                  })}\n\n`),
                };
              }
              if (step === 2) {
                return {
                  done: false,
                  value: Buffer.from(`data: ${JSON.stringify({
                    id: 'gen-role-only',
                    model: 'test/model',
                    provider: 'ReasoningCloud',
                    choices: [{ delta: { content: '{"findings":[]}' } }],
                  })}\n\ndata: [DONE]\n\n`),
                };
              }
              return { done: true, value: undefined };
            },
            cancel: async () => {},
          };
        },
      },
    });

    const progressEvents: any[] = [];
    const result = await callOpenRouterChat(fetchImpl, {
      url: 'https://openrouter.ai/api/v1/chat/completions',
      headers: { Authorization: 'Bearer test' },
      body: { model: 'test/model', messages: [] },
      timeoutMs: 5_000,
      ttftMs: 15,
      preferStream: true,
      onStreamProgress: (event: any) => progressEvents.push(event),
    });

    expect(result.ok).toBe(true);
    expect(progressEvents).toHaveLength(1);
    expect(progressEvents[0].firstChunkKind).toBe('other');
  });
});

describe('REL-271: TTFT deadline (D1, D2, D10)', () => {
  it('D1: fires on a never-chunking stream, aborting with failure class ttft_timeout well before the total budget', async () => {
    const startedAt = Date.now();
    const result = await callOpenRouterChat(async () => neverChunkingStreamResponse(), {
      url: 'https://openrouter.ai/api/v1/chat/completions',
      headers: { Authorization: 'Bearer test' },
      body: { model: 'test/model', messages: [] },
      timeoutMs: 5_000,
      ttftMs: 30,
      preferStream: true,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(result.ok).toBe(false);
    expect(result.timeoutPhase).toBe('ttft');
    expect(result.failureClass).toBe('ttft_timeout');
    // Fired on the 30ms TTFT deadline, nowhere near the 5s total budget.
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it('D1: clears on the first SSE chunk -- a stream that answers in time then takes longer than the TTFT window to finish still succeeds', async () => {
    const result = await callOpenRouterChat(async () => singleChunkThenSlowDoneStreamResponse(40), {
      url: 'https://openrouter.ai/api/v1/chat/completions',
      headers: { Authorization: 'Bearer test' },
      body: { model: 'test/model', messages: [] },
      timeoutMs: 5_000,
      // The first chunk arrives immediately (well under 15ms); the stream then takes 40ms to
      // finish. If the TTFT timer were NOT cleared on the first chunk, this would spuriously
      // abort at 15ms even though a real first token was already observed.
      ttftMs: 15,
      preferStream: true,
    });

    expect(result.ok).toBe(true);
    expect(result.provider).toBe('ExampleCloud');
    expect(result.timeoutPhase).toBeUndefined();
  });

  it('treats the SSE [DONE] marker as successful completion without reading a closing socket again', async () => {
    const result = await callOpenRouterChat(async () => completedStreamWhoseSocketAbortsAfterDone(), {
      url: 'https://openrouter.ai/api/v1/chat/completions',
      headers: { Authorization: 'Bearer test' },
      body: { model: 'test/model', messages: [] },
      timeoutMs: 5_000,
      ttftMs: 1_000,
      preferStream: true,
    });

    expect(result).toMatchObject({
      ok: true,
      streamed: true,
      generationId: 'gen-complete',
      provider: 'test-provider',
      content: '{"findings":[]}',
    });
  });

  it('D2: the streamed path drives its connect budget from ttft-ms', async () => {
    const startedAt = Date.now();
    // Real fetch() rejects when its AbortSignal fires; a hand-rolled mock has to do the same or
    // it hangs forever regardless of any budget.
    const neverRespondingFetch = (_url: string, init: any) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })), { once: true });
    });
    const result = await callOpenRouterChat(neverRespondingFetch, {
      url: 'https://openrouter.ai/api/v1/chat/completions',
      headers: { Authorization: 'Bearer test' },
      body: { model: 'test/model', messages: [] },
      timeoutMs: 5_000,
      // The request remains streamed even when a caller supplies the former opt-out flag.
      ttftMs: 40,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(result.ok).toBe(false);
    expect(result.timeoutPhase).toBe('ttft');
    expect(result.failureClass).toBe('ttft_timeout');
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it('D10: preferred_max_latency in the resolved policy follows ttft-ms, not the connect timeout', () => {
    const { resolveOpenRouterPolicy } = require(path.join(rootRepoDir, '.github/workflows/pipelines/openRouterPolicy.js'));
    const policy = resolveOpenRouterPolicy({}, {
      OPENROUTER_TTFT_MS: '12000',
      OPENROUTER_PROVIDER_ROUTING: JSON.stringify({ only: ['examplecloud'] }),
    });
    expect(policy.providerRouting.preferred_max_latency).toBe(12);
  });
});

// 2026-08-20 fixed-total-budget investigation: `REASONING_ALIVE elapsed_ms=...` heartbeats were
// observed logging past 35s of active, provider-confirmed streaming against a
// `total_budget_ms=30000` lane, while successful lanes independently measured 47-52s total (TTFT
// 406-692ms). The old `totalAbort` was a single fixed-clock `setTimeout(totalMs)` started at
// dispatch and never reset on chunk arrival -- it was killing lanes that were still being
// answered, not lanes that had gone quiet. The fix replaces it with a resettable stall/gap timer
// that only fires when NO chunk (reasoning or content) arrives for `stallMs`.
describe('2026-08-20 fix: a stall/gap timer replaces the fixed total-duration abort for the streaming path', () => {
  function chunkTrainThenHangResponse(chunks: Array<{ delayMs: number; reasoning?: boolean }>) {
    let sent = 0;
    return {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => {
            if (sent < chunks.length) {
              const spec = chunks[sent];
              sent += 1;
              if (spec.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, spec.delayMs));
              const delta = spec.reasoning ? { reasoning: `tok${sent} ` } : { content: `tok${sent} ` };
              return {
                done: false,
                value: Buffer.from(`data: ${JSON.stringify({
                  id: 'gen-train',
                  model: 'test/model',
                  provider: 'ExampleCloud',
                  choices: [{ delta }],
                })}\n\n`),
              };
            }
            // After the scripted chunks, go silent forever -- simulates either a genuinely
            // stalled connection (no [DONE], no further chunk) for the stall test, or a lane that
            // is still actively working but whose remaining generation time this fixture does not
            // need to simulate because the assertion only cares that it was NOT killed by a fixed
            // wall clock before the stall timer itself would ever fire.
            return new Promise(() => {});
          },
          cancel: async () => {},
        }),
      },
    };
  }

  it('headline: an actively-streaming response that exceeds a fixed total cap is NOT aborted by that cap', async () => {
    // Five real content chunks, 15ms apart (75ms of active streaming), against a `timeoutMs` of
    // only 30ms -- under the OLD fixed-clock behavior this lane would be killed by totalAbort
    // partway through even though the provider never stopped answering. `stallMs` is generous
    // (200ms) so the 15ms inter-chunk gaps never trip it either; the assertion is specifically
    // that the fixed 30ms total cap is not what determines the outcome anymore.
    const startedAt = Date.now();
    const result = await callOpenRouterChat(
      async () => chunkTrainThenHangResponse([
        { delayMs: 0 }, { delayMs: 15 }, { delayMs: 15 }, { delayMs: 15 }, { delayMs: 15 },
      ]),
      {
        url: 'https://openrouter.ai/api/v1/chat/completions',
        headers: { Authorization: 'Bearer test' },
        body: { model: 'test/model', messages: [] },
        timeoutMs: 30,
        ttftMs: 500,
        stallMs: 200,
        preferStream: true,
      },
    );
    const elapsedMs = Date.now() - startedAt;

    // The fixture never sends [DONE], so the call is still pending at the 75ms mark when this
    // assertion fires; what matters is that it was not aborted at/near the 30ms fixed cap.
    expect(elapsedMs).toBeGreaterThanOrEqual(50);
    expect(result.ok).toBe(false);
    expect(result.timeoutPhase).not.toBe('response');
    expect(result.aborted).toBe(true);
    // It is still pending on the STALL timer (200ms, never reset because the fixture went silent
    // after 5 chunks) or genuinely still running -- either way, it must not have been killed by
    // the removed fixed-total-duration mechanism at the 30ms mark.
    expect(elapsedMs).toBeGreaterThanOrEqual(170);
  }, 10_000);

  it('non-negotiable companion: a genuinely stalled stream (no bytes for longer than the stall budget) still aborts', async () => {
    const startedAt = Date.now();
    const result = await callOpenRouterChat(
      async () => chunkTrainThenHangResponse([{ delayMs: 0 }]),
      {
        url: 'https://openrouter.ai/api/v1/chat/completions',
        headers: { Authorization: 'Bearer test' },
        body: { model: 'test/model', messages: [] },
        timeoutMs: 5_000,
        ttftMs: 500,
        stallMs: 40,
        preferStream: true,
      },
    );
    const elapsedMs = Date.now() - startedAt;

    expect(result.ok).toBe(false);
    expect(result.aborted).toBe(true);
    expect(result.timeoutPhase).toBe('stall');
    expect(result.failureClass).toBe('stream_stall');
    // Fired on the ~40ms stall budget, nowhere near the 5s total budget -- proves the stall path
    // is genuinely gap-based, not a disguised fixed clock.
    expect(elapsedMs).toBeLessThan(1_000);
    expect(elapsedMs).toBeGreaterThanOrEqual(35);
  });

  it('a never-starting response (connect ok, no first token at all) still aborts on TTFT, unaffected by the stall timer', async () => {
    const result = await callOpenRouterChat(async () => neverChunkingStreamResponse(), {
      url: 'https://openrouter.ai/api/v1/chat/completions',
      headers: { Authorization: 'Bearer test' },
      body: { model: 'test/model', messages: [] },
      timeoutMs: 5_000,
      ttftMs: 25,
      stallMs: 5_000,
      preferStream: true,
    });

    expect(result.ok).toBe(false);
    expect(result.timeoutPhase).toBe('ttft');
    expect(result.failureClass).toBe('ttft_timeout');
  });
});

describe('REL-271: operator directive -- a TTFT abort adds nothing to any ban set (dedicated hard-constraint test)', () => {
  it('a TTFT-aborted retry never populates the run-scoped ban set or the request ignore list beyond the hard-banned baseline', async () => {
    const runTimedOutProviders = new Set<string>();
    const calls: any[] = [];
    const fetchImpl = async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      calls.push({ body });
      if (calls.length === 1) return neverChunkingStreamResponse();
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
                  value: Buffer.from(`data: ${JSON.stringify({
                    id: 'gen-healthy',
                    model: 'test/model',
                    provider: 'OpenAI',
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
      timeoutMs: 5_000,
      ttftMs: 30,
      preferStream: true,
      runTimedOutProviders,
    });

    expect(calls).toHaveLength(2);
    expect(result.decision).toBe('APPROVE');
    expect(result.provider).toBe('OpenAI');
    // The operator's explicit directive: empty, not just "doesn't contain the timed-out
    // provider" -- because the provider was never even resolved before the TTFT deadline fired.
    expect(runTimedOutProviders.size).toBe(0);
    // The retry's own request also carries no ignore entries beyond the permanent hard-banned
    // baseline -- nothing lane-local was added either.
    const secondRequestIgnore: string[] = calls[1].body.provider?.ignore || [];
    expect(secondRequestIgnore.sort()).toEqual([...HARD_BANNED_PROVIDER_SLUGS].sort());
  });
});

describe('fireworks BAN must be impossible by construction: a direct-gateway timeout never bans the transport itself', () => {
  // Evidence: calltelemetry/cisco-cdr review-yeti-actions runs showed `transport=fireworks BAN`
  // x10 -- the bot quarantining the operator's own direct, subscription-backed primary transport
  // after a timeout on that same transport. `provider.ignore`/quarantine is an OpenRouter
  // multi-provider routing concept: it tells OpenRouter which downstream provider slug to avoid.
  // A direct (non-OpenRouter) gateway has no "downstream provider" -- `unknownRouteProvider`
  // resolves to the gateway's OWN id (`gateway.isOpenRouter ? 'openrouter' : gateway.id`), so a
  // timeout on a direct gateway used to ban that same gateway by construction. Operator directive:
  // "fireworks is my primary provider it must not be banned" / "I don't want to ban providers
  // during the call -- OpenRouter should give us good data."
  it('a direct (non-OpenRouter) gateway timeout never populates the run-scoped ban set with its own identity', async () => {
    const runTimedOutProviders = new Set<string>();
    const fetchImpl = async () => neverChunkingStreamResponse();

    const result = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r', prNumber: '1' }, null, {
      apiKey: 'k',
      baseUrl: 'https://api.fireworks.ai/inference/v1',
      model: 'accounts/fireworks/models/deepseek-v4-flash-0731',
      fetchImpl,
      maxAttempts: 1,
      // Total budget expires quickly; ttftMs is deliberately far larger so the TOTAL-budget timer
      // (not the TTFT timer) is what fires -- this reproduces `phase=response`, the branch that
      // used to reach the BAN call, not the already-guarded TTFT path.
      timeoutMs: 200,
      ttftMs: 100_000,
      preferStream: true,
      gatewayCompat: 'openai',
      transportName: 'fireworks',
      runTimedOutProviders,
    });

    expect(result.decision).toBe('ERROR');
    expect(result.provider).toBe('fireworks');
    // The core assertion: the operator's own direct transport identity must never enter the
    // ban/quarantine set, regardless of how many times it times out.
    expect(runTimedOutProviders.size).toBe(0);
  });

  it('a direct-gateway connect-phase abort (non-stream) also never bans', async () => {
    const runTimedOutProviders = new Set<string>();
    // callOpenRouterChat catches this internally and returns a normal `{ok:false, aborted:true}`
    // result (it never rethrows for network failures), so this exercises the SAME `result.aborted`
    // ban guard as the first test above, via the non-stream connect phase instead of the stream
    // read loop -- both call sites in review-pipeline.js share the identical `gateway.isOpenRouter`
    // construction guard, so covering both call shapes locks in that neither regresses alone.
    const fetchImpl = async () => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'AbortError' });
    };

    await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r', prNumber: '1' }, null, {
      apiKey: 'k',
      baseUrl: 'https://api.fireworks.ai/inference/v1',
      model: 'accounts/fireworks/models/deepseek-v4-flash-0731',
      fetchImpl,
      maxAttempts: 1,
      timeoutMs: 5_000,
      gatewayCompat: 'openai',
      transportName: 'fireworks',
      runTimedOutProviders,
    });

    expect(runTimedOutProviders.size).toBe(0);
  });
});

describe('REL-271: flattened retry pyramid (D3, D4, D5, D9)', () => {
  it('D4/D5: no third attempt is ever made, even when every attempt fails', async () => {
    const calls: any[] = [];
    const fetchImpl = async (_url: string, init: any) => {
      calls.push({ body: JSON.parse(init.body) });
      return { ok: false, status: 503, text: async () => 'unavailable', json: async () => ({ error: { message: 'unavailable' } }) };
    };

    const result = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r', prNumber: '1' }, null, {
      apiKey: 'k',
      baseUrl: 'https://api.example.com/v1',
      model: 'test/model',
      fetchImpl,
      maxAttempts: 2,
      timeoutMs: 5_000,
    });

    // Streaming is unconditional, so each configured attempt makes exactly one HTTP call.
    expect(calls).toHaveLength(2);
    expect(result.decision).toBe('ERROR');
  });

  it('D9: openrouter-max-attempts is configurable -- 1 means exactly 1 attempt, no retry at all', async () => {
    const calls: any[] = [];
    const fetchImpl = async (_url: string, init: any) => {
      calls.push({ body: JSON.parse(init.body) });
      return { ok: false, status: 503, text: async () => 'unavailable', json: async () => ({ error: { message: 'unavailable' } }) };
    };

    const result = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r', prNumber: '1' }, null, {
      apiKey: 'k',
      baseUrl: 'https://api.example.com/v1',
      model: 'test/model',
      fetchImpl,
      maxAttempts: 1,
      timeoutMs: 5_000,
    });

    // One configured attempt makes exactly one streamed HTTP call.
    expect(calls).toHaveLength(1);
    expect(result.decision).toBe('ERROR');
  });

  it('D5/D9: a counting mock proves a lane makes at most turns x attempts HTTP calls', async () => {
    const identity = { provider: 'github', repository: 'owner/repo', prNumber: 22, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) };
    const persona = { id: 'security', name: 'Security reviewer', charter: 'Review authorization changes.' };
    const prContext = { repo: 'o/r', prNumber: '1' };
    const maxAttempts = 2;
    const maxTurns = 2;

    const calls: any[] = [];
    const fetchImpl = async (_url: string, init: any) => {
      calls.push({ body: JSON.parse(init.body) });
      const n = calls.length;
      // Turn 1: attempt 1 fails (retryable 503), attempt 2 succeeds with NEEDS_EVIDENCE (empty
      // evidence_requests advances the turn without needing real evidence tooling).
      if (n === 1) return { ok: false, status: 503, text: async () => 'unavailable', json: async () => ({ error: { message: 'unavailable' } }) };
      if (n === 2) {
        const payload = { choices: [{ message: { content: JSON.stringify({ review_status: 'NEEDS_EVIDENCE', risk_plan: [], evidence_requests: [], risk_dispositions: [], findings: [] }) } }] };
        return {
          ok: true, status: 200, text: async () => '',
          json: async () => payload,
          body: sseBody(payload),
        };
      }
      // Turn 2 (final): attempt 1 fails (retryable 503), attempt 2 succeeds with COMPLETE.
      if (n === 3) return { ok: false, status: 503, text: async () => 'unavailable', json: async () => ({ error: { message: 'unavailable' } }) };
      const payload = { choices: [{ message: { content: JSON.stringify({ review_status: 'COMPLETE', risk_plan: [], evidence_requests: [], risk_dispositions: [], findings: [] }) } }] };
      return {
        ok: true, status: 200, text: async () => '',
        json: async () => payload,
        body: sseBody(payload),
      };
    };

    const modelOptions = { apiKey: 'k', baseUrl: 'https://api.example.com/v1', model: 'test/model', fetchImpl, maxAttempts, timeoutMs: 5_000 };
    const result = await runPersonaInvestigation({
      identity,
      persona,
      manifest: 'ru_auth src/a.js',
      diffText: '@@ -1 +1 @@\n+guard()',
      evidenceRegistry: { capabilities: { enabled: true }, call: async () => ({ status: 'ok', content: '', byteCount: 0 }) },
      limits: { maxTurns },
      modelTurn: ({ messages, turn, finalOnly, signal, providerIgnore }: any) => callPersonaModelTurn({
        persona, prContext, sessionContext: null, messages, turn, finalOnly, signal,
        options: { ...modelOptions, providerIgnore },
      }),
    });

    expect(calls.length).toBeLessThanOrEqual(maxTurns * maxAttempts);
    expect(calls).toHaveLength(4);
    expect(result.personaResult.decision).toBe('APPROVE');
    expect(result.executionReceipt).toMatchObject({ termination: 'completed', turns: 2 });
  });
});

describe('REL-271: lane-deadline-ms backstop', () => {
  it('aborts a synthetic slow lane with termination lane_deadline, not a generic cancellation', async () => {
    const identity = { provider: 'github', repository: 'owner/repo', prNumber: 22, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) };
    const persona = { id: 'security', name: 'Security reviewer', charter: 'Review authorization changes.' };
    const laneDeadline = new AbortController();
    setTimeout(() => laneDeadline.abort(), 15);

    const modelTurn = ({ signal }: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      // Simulates a lane stuck mid-request until the wall-clock backstop fires.
      signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    });

    const result = await runPersonaInvestigation({
      identity,
      persona,
      manifest: 'ru_auth src/a.js',
      diffText: '@@ -1 +1 @@\n+guard()',
      evidenceRegistry: { capabilities: { enabled: true }, call: async () => ({ status: 'ok', content: '', byteCount: 0 }) },
      modelTurn,
      signal: laneDeadline.signal,
      laneDeadlineSignal: laneDeadline.signal,
    });

    expect(result.executionReceipt.termination).toBe('lane_deadline');
    expect(result.personaResult.decision).toBe('ERROR');
    expect(result.personaResult.failure?.reason).toBe('lane_deadline');
  });

  it('an ordinary outer cancellation (not the lane deadline) still classifies as cancelled', async () => {
    const identity = { provider: 'github', repository: 'owner/repo', prNumber: 22, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) };
    const persona = { id: 'security', name: 'Security reviewer', charter: 'Review authorization changes.' };
    const jobCancellation = new AbortController();
    const laneDeadline = new AbortController(); // never fires
    setTimeout(() => jobCancellation.abort(), 15);

    const modelTurn = ({ signal }: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    });

    const result = await runPersonaInvestigation({
      identity,
      persona,
      manifest: 'ru_auth src/a.js',
      diffText: '@@ -1 +1 @@\n+guard()',
      evidenceRegistry: { capabilities: { enabled: true }, call: async () => ({ status: 'ok', content: '', byteCount: 0 }) },
      modelTurn,
      signal: jobCancellation.signal,
      laneDeadlineSignal: laneDeadline.signal,
    });

    expect(result.executionReceipt.termination).toBe('cancelled');
  });
});

describe('REL-272: max-investigation-turns reaches bounded mode (D6)', () => {
  it('max-investigation-turns: 1 produces maxTurns == 1 in bounded mode', () => {
    const limits = resolveBoundedInvestigationLimits({ parsed: { review: { investigation: {} } } }, { MAX_INVESTIGATION_TURNS: '1' });
    expect(limits.maxTurns).toBe(1);
  });

  it('precedence: action input beats repo YAML, repo YAML beats the default', () => {
    const yamlOnly = resolveBoundedInvestigationLimits({ parsed: { review: { investigation: { maxTurns: 3 } } } }, {});
    expect(yamlOnly.maxTurns).toBe(3);

    const inputBeatsYaml = resolveBoundedInvestigationLimits({ parsed: { review: { investigation: { maxTurns: 3 } } } }, { MAX_INVESTIGATION_TURNS: '1' });
    expect(inputBeatsYaml.maxTurns).toBe(1);
  });

  it('clamp holds at the 1 and unlocked 8 boundaries', () => {
    expect(resolveBoundedInvestigationLimits({}, { MAX_INVESTIGATION_TURNS: '0' }).maxTurns).toBe(1);
    expect(resolveBoundedInvestigationLimits({}, { MAX_INVESTIGATION_TURNS: '1' }).maxTurns).toBe(1);
    expect(resolveBoundedInvestigationLimits({}, { MAX_INVESTIGATION_TURNS: '6' }).maxTurns).toBe(6);
    expect(resolveBoundedInvestigationLimits({}, { MAX_INVESTIGATION_TURNS: '99' }).maxTurns).toBe(8);
  });

  it('default with nothing set is the unlocked default of 3', () => {
    expect(resolveBoundedInvestigationLimits({}, {}).maxTurns).toBe(3);
    expect(resolveBoundedInvestigationLimits({ parsed: {} }, {}).maxTurns).toBe(3);
  });
});

// 2026-08-19 lane-budget investigation: production logs showed `transport=... TIMEOUT
// phase=response total_budget_ms=30000` on lanes whose real, isolated model-call latency measured
// 1.7-2.8s -- nowhere near 30s. Root cause, confirmed with a real end-to-end repro against
// createStreamingLaneGate + reviewWithTransports + reviewWithModel + callOpenRouterChat: the
// per-lane wall-clock backstop (laneDeadline, ~240s default) is exposed to streaming-lane-gate
// queue-wait (2 slots for a 5-persona panel), and when laneDeadline fires while a request is in
// flight or still queued, callOpenRouterChat's classification previously had no way to tell that
// apart from a genuine per-request total-budget (30-45s) timeout -- both defaulted to
// `timeoutPhase: 'response'`. A call that would have succeeded in ~90ms got logged identically to
// a real, slow-provider timeout.
describe('reasoning-stall/lane-budget investigation: lane_deadline is classified separately from a genuine total-budget timeout', () => {
  function fetchThatWouldSucceedButNeverGetsTheChance() {
    // Honors its abort signal like a real fetch() -- rejects when the signal fires, exactly like
    // an in-flight HTTP request cut off by an AbortController, whether that's totalAbort's own
    // timer or an externally-merged signal (laneDeadline) relayed through it.
    return (_url: string, init: any) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
      }, { once: true });
    });
  }

  it('callOpenRouterChat: an abort via laneDeadlineSignal is classified lane_deadline, not response', async () => {
    const laneDeadline = new AbortController();
    setTimeout(() => laneDeadline.abort(), 20);

    const result = await callOpenRouterChat(fetchThatWouldSucceedButNeverGetsTheChance(), {
      url: 'https://api.fireworks.ai/inference/v1/chat/completions',
      headers: { Authorization: 'Bearer test' },
      body: { model: 'test/model', messages: [] },
      timeoutMs: 5_000, // this call's OWN total budget -- deliberately large, never exhausted
      ttftMs: 5_000,
      preferStream: true,
      signal: laneDeadline.signal, // production wires laneSignal (merge of laneDeadline+cancellation) here
      laneDeadlineSignal: laneDeadline.signal, // the NEW, separately-threaded signal this fix adds
      transportName: 'fireworks',
    });

    expect(result.ok).toBe(false);
    expect(result.aborted).toBe(true);
    // The core assertion: NOT 'response' (which would claim this call's own 5000ms budget
    // genuinely elapsed -- it did not; the abort fired at ~20ms).
    expect(result.timeoutPhase).toBe('lane_deadline');
  });

  it('callOpenRouterChat: a plain outer cancellation without laneDeadlineSignal stays classified response (unchanged, backward compatible)', async () => {
    // A caller that does not thread laneDeadlineSignal (e.g. an older call site, or a genuine
    // outer job cancellation with no lane-deadline concept) gets the SAME outcome reviewWithModel
    // has always produced for this case (`result.timeoutPhase || 'response'` downstream) -- this
    // fix makes that explicit inside callOpenRouterChat itself rather than leaving it to the
    // caller's own default, but the observable classification for a caller that omits
    // laneDeadlineSignal is unchanged. This locks in that the new parameter is additive: omitting
    // it does not change behavior, only omits the one new (correct) distinction.
    const outerCancel = new AbortController();
    setTimeout(() => outerCancel.abort(), 20);

    const result = await callOpenRouterChat(fetchThatWouldSucceedButNeverGetsTheChance(), {
      url: 'https://api.fireworks.ai/inference/v1/chat/completions',
      headers: { Authorization: 'Bearer test' },
      body: { model: 'test/model', messages: [] },
      timeoutMs: 5_000,
      ttftMs: 5_000,
      preferStream: true,
      signal: outerCancel.signal,
      transportName: 'fireworks',
    });

    expect(result.ok).toBe(false);
    expect(result.timeoutPhase).toBe('response');
  });

  it('ordering regression: laneDeadlineSignal is checked even though totalAbort.signal.aborted is ALSO true (totalAbort relays the outer signal)', async () => {
    // totalAbort is itself `createAbortLink({ signals: [signal], timeoutMs })` -- it relays ANY
    // abort of the outer `signal` into its own controller, on top of its own independent timer.
    // So totalAbort.signal.aborted becomes true BOTH when totalMs genuinely elapses AND when the
    // outer signal (laneDeadline, here) fires first. A classifier that checks
    // `totalAbort.signal.aborted` before laneDeadlineSignal would misattribute this case as
    // 'response' even with laneDeadlineSignal wired up -- this test pins the correct order.
    const laneDeadline = new AbortController();
    setTimeout(() => laneDeadline.abort(), 10);

    const result = await callOpenRouterChat(fetchThatWouldSucceedButNeverGetsTheChance(), {
      url: 'https://api.fireworks.ai/inference/v1/chat/completions',
      headers: { Authorization: 'Bearer test' },
      body: { model: 'test/model', messages: [] },
      // Deliberately close to the laneDeadline's own fire time so totalAbort's relay of the outer
      // signal and its own timer are both plausible causes -- the point is laneDeadlineSignal must
      // win the classification regardless.
      timeoutMs: 5_000,
      ttftMs: 5_000,
      preferStream: true,
      signal: laneDeadline.signal,
      laneDeadlineSignal: laneDeadline.signal,
      transportName: 'fireworks',
    });

    expect(result.timeoutPhase).toBe('lane_deadline');
  });

  it('reviewWithModel: a lane_deadline abort is never banned/quarantined and logs LANE_DEADLINE, not a generic RESPONSE timeout', async () => {
    const runTimedOutProviders = new Set<string>();
    const laneDeadline = new AbortController();
    setTimeout(() => laneDeadline.abort(), 20);
    const fetchImpl = async () => neverChunkingStreamResponse();

    const warnLines: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: any[]) => { warnLines.push(args.join(' ')); };
    let result: any;
    try {
      result = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r', prNumber: '1' }, null, {
        apiKey: 'k',
        baseUrl: 'https://api.fireworks.ai/inference/v1',
        model: 'accounts/fireworks/models/deepseek-v4-flash-0731',
        fetchImpl,
        maxAttempts: 1,
        timeoutMs: 5_000,
        ttftMs: 5_000,
        preferStream: true,
        gatewayCompat: 'openai',
        transportName: 'fireworks',
        signal: laneDeadline.signal,
        laneDeadlineSignal: laneDeadline.signal,
        runTimedOutProviders,
      });
    } finally {
      console.warn = originalWarn;
    }

    expect(result.decision).toBe('ERROR');
    // The operator directive that already applies to ttft (REL-271) applies identically here: a
    // lane-deadline abort proves nothing about the provider's health.
    expect(runTimedOutProviders.size).toBe(0);
    expect(warnLines.some((l) => l.includes('LANE_DEADLINE'))).toBe(true);
    expect(warnLines.some((l) => /\bBAN\b/.test(l))).toBe(false);
    // The generic TIMEOUT summary line must say phase=lane_deadline, not phase=response --
    // an operator grepping logs for "phase=response" must not find this case.
    expect(warnLines.some((l) => l.includes('TIMEOUT phase=lane_deadline'))).toBe(true);
    expect(warnLines.some((l) => l.includes('TIMEOUT phase=response'))).toBe(false);
  });

  it('reviewWithTransports: streaming-lane-gate queue-wait is logged with queue_wait_ms', async () => {
    const logLines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: any[]) => { logLines.push(args.join(' ')); };
    let streamGate: any;
    try {
      streamGate = createStreamingLaneGate(1);
      const releaseFirst = await streamGate.acquire();
      const secondAcquire = reviewWithTransports(securityPersona, diffFiles, { repo: 'o/r', prNumber: '1' }, null, {
        apiKey: 'k',
        baseUrl: 'https://api.fireworks.ai/inference/v1',
        model: 'test/model',
        fetchImpl: async () => neverChunkingStreamResponse(),
        maxAttempts: 1,
        timeoutMs: 50,
        ttftMs: 50,
        preferStream: true,
        transportName: 'fireworks',
        streamGate,
        transportPlan: [{ name: 'fireworks', apiKey: 'k', baseUrl: 'https://api.fireworks.ai/inference/v1', model: 'test/model', timeoutMs: 50 }],
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      releaseFirst();
      await secondAcquire;
    } finally {
      console.log = originalLog;
    }
    expect(logLines.some((l) => l.includes('[StreamGate]') && /queue_wait_ms=\d+/.test(l))).toBe(true);
  });
});
