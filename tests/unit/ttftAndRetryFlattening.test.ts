// REL-271 + REL-272: dedicated RED-first coverage for the TTFT deadline, the flattened retry
// pyramid, and the max-investigation-turns bounded-mode wiring. See the PR body for the D1-D10
// defect-to-test mapping and the captured RED output.
import { describe, expect, it } from 'vitest';
import path from 'path';
import fs from 'fs';
import { runPersonaInvestigation } from '../../src/review/reviewInvestigation';

const rootRepoDir = fs.existsSync(path.join(path.resolve(__dirname, '../..'), '.github/workflows/pipelines/review-pipeline.js'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');
const pipeline = require(path.join(rootRepoDir, '.github/workflows/pipelines/review-pipeline.js'));
const { HARD_BANNED_PROVIDER_SLUGS } = require(path.join(rootRepoDir, '.github/workflows/pipelines/openRouterPolicy.js'));

const {
  callOpenRouterChat,
  reviewWithModel,
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
                provider: 'Morph',
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
    expect(result.provider).toBe('Morph');
    expect(result.timeoutPhase).toBeUndefined();
  });

  it('D2: non-stream path drives its connect budget from ttft-ms when supplied', async () => {
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
      // No connectTimeoutMs supplied -- if ttftMs were not driving the connect budget here, this
      // would fall back to the legacy 8s default and not fire until well past 200ms.
      ttftMs: 40,
      preferStream: false,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(result.ok).toBe(false);
    expect(result.timeoutPhase).toBe('ttft');
    expect(result.failureClass).toBe('ttft_timeout');
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it('D10: preferred_max_latency in the resolved policy follows ttft-ms, not the connect timeout', () => {
    const { resolveOpenRouterPolicy } = require(path.join(rootRepoDir, '.github/workflows/pipelines/openRouterPolicy.js'));
    const policy = resolveOpenRouterPolicy({}, { OPENROUTER_TTFT_MS: '12000', OPENROUTER_CONNECT_TIMEOUT_MS: '8000' });
    expect(policy.providerRouting.preferred_max_latency).toBe(12000);
    expect(policy.connectTimeoutMs).toBe(8000);
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

    expect(calls).toHaveLength(2);
    expect(result.decision).toBe('ERROR');
  });

  it('D9: openrouter-max-attempts is configurable -- 1 means exactly 1 call, no retry at all', async () => {
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
        return {
          ok: true, status: 200, text: async () => '',
          json: async () => ({ choices: [{ message: { content: JSON.stringify({ review_status: 'NEEDS_EVIDENCE', risk_plan: [], evidence_requests: [], risk_dispositions: [], findings: [] }) } }] }),
        };
      }
      // Turn 2 (final): attempt 1 fails (retryable 503), attempt 2 succeeds with COMPLETE.
      if (n === 3) return { ok: false, status: 503, text: async () => 'unavailable', json: async () => ({ error: { message: 'unavailable' } }) };
      return {
        ok: true, status: 200, text: async () => '',
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ review_status: 'COMPLETE', risk_plan: [], evidence_requests: [], risk_dispositions: [], findings: [] }) } }] }),
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

  it('clamp still holds at the 1 and 3 boundaries', () => {
    expect(resolveBoundedInvestigationLimits({}, { MAX_INVESTIGATION_TURNS: '0' }).maxTurns).toBe(1);
    expect(resolveBoundedInvestigationLimits({}, { MAX_INVESTIGATION_TURNS: '1' }).maxTurns).toBe(1);
    expect(resolveBoundedInvestigationLimits({}, { MAX_INVESTIGATION_TURNS: '3' }).maxTurns).toBe(3);
    expect(resolveBoundedInvestigationLimits({}, { MAX_INVESTIGATION_TURNS: '99' }).maxTurns).toBe(3);
  });

  it('default with nothing set is 2, not 4', () => {
    expect(resolveBoundedInvestigationLimits({}, {}).maxTurns).toBe(2);
    expect(resolveBoundedInvestigationLimits({ parsed: {} }, {}).maxTurns).toBe(2);
  });
});
