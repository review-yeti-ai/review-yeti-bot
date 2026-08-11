import { describe, expect, it, vi, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';

// Resolve path to root repository .github/workflows/pipelines/review-pipeline.js
const rootRepoDir = fs.existsSync(path.join(path.resolve(__dirname, '../..'), '.github/workflows/pipelines/review-pipeline.js'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');
const pipelinePath = path.join(rootRepoDir, '.github/workflows/pipelines/review-pipeline.js');
const pipeline = require(pipelinePath);
const { createPipelineCancellation, callOpenRouterChat } = pipeline;

/**
 * Regression coverage for the "prints the verdict cleanly, then the process crashes anyway"
 * class of bug: a pipeline `cancellation.race(operation)` call whose `operation` loses the
 * race against `shutdown` keeps running in the background. If that abandoned operation later
 * rejects (e.g. an in-flight OpenRouter fetch's AbortError landing after cancellation already
 * won) with nothing observing it, Node treats the late rejection as fatal and exits non-zero
 * even though the review verdict already published successfully.
 */
describe('createPipelineCancellation().race() — abandoned-loser rejection safety', () => {
  let unhandledRejections: unknown[] = [];
  let onUnhandledRejection: (reason: unknown) => void;

  afterEach(() => {
    if (onUnhandledRejection) process.off('unhandledRejection', onUnhandledRejection);
    unhandledRejections = [];
  });

  const withUnhandledRejectionSpy = () => {
    unhandledRejections = [];
    onUnhandledRejection = (reason: unknown) => { unhandledRejections.push(reason); };
    process.on('unhandledRejection', onUnhandledRejection);
  };

  it('resolves to the cancellation sentinel when shutdown wins, discarding the loser', async () => {
    const cancellation = createPipelineCancellation({});
    let rejectLoser: (err: Error) => void = () => {};
    const loser = new Promise((_resolve, reject) => { rejectLoser = reject; });

    const racePromise = cancellation.race(loser);
    cancellation.cancel();

    const result = await racePromise;
    expect(cancellation.isCancellationResult(result)).toBe(true);

    // Clean up the still-pending loser so it doesn't leak into other tests.
    rejectLoser(new Error('cleanup'));
  });

  it('does not surface an unhandled rejection when the raced-away loser rejects after shutdown already won', async () => {
    withUnhandledRejectionSpy();

    const cancellation = createPipelineCancellation({});
    let rejectLoser: (err: Error) => void = () => {};
    // A deferred promise we control explicitly: it does not settle until we call rejectLoser,
    // which happens strictly AFTER the race has already resolved via shutdown. This drives the
    // ordering explicitly instead of relying on a timing-sensitive sleep.
    const loser = new Promise((_resolve, reject) => { rejectLoser = reject; });

    const racePromise = cancellation.race(loser);

    // shutdown wins immediately — the loser has not settled yet.
    cancellation.cancel();
    const result = await racePromise;
    expect(cancellation.isCancellationResult(result)).toBe(true);

    // Now the abandoned operation finally rejects — mirrors an in-flight fetch's AbortError
    // landing after the pipeline has already moved on.
    rejectLoser(new Error('late rejection from raced-away operation'));

    // Give the event loop several turns to surface a Node unhandledRejection event, if any.
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));

    expect(unhandledRejections).toEqual([]);
  });

  it('does not surface an unhandled rejection when a Promise.all(...) fan-out loses the race and one element rejects late', async () => {
    // Mirrors the pipeline's real shape: `cancellation.race(Promise.all(personas.map(...)))`.
    withUnhandledRejectionSpy();

    const cancellation = createPipelineCancellation({});
    const rejecters: Array<(err: Error) => void> = [];
    const laneOperations = [0, 1, 2].map(() => new Promise((_resolve, reject) => {
      rejecters.push(reject);
    }));

    const racePromise = cancellation.race(Promise.all(laneOperations));
    cancellation.cancel();
    const result = await racePromise;
    expect(cancellation.isCancellationResult(result)).toBe(true);

    // One lane rejects after the fan-out already lost the race.
    rejecters[1](new Error('persona lane aborted after cancellation'));

    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));

    expect(unhandledRejections).toEqual([]);

    // Clean up remaining lanes.
    rejecters[0](new Error('cleanup'));
    rejecters[2](new Error('cleanup'));
    await new Promise((resolve) => setImmediate(resolve));
  });
});

/**
 * Leaf-level defense in depth: `nonStreamOnce`'s ok-response branch used to call
 * `await response.json()` unguarded. An abort landing mid-body-read threw a raw AbortError out
 * of `callOpenRouterChat`, instead of the structured `{ ok: false, aborted: true }` shape every
 * other failure branch in the same function already returns.
 */
describe('callOpenRouterChat — response.json() abort safety (non-stream path)', () => {
  it('returns a structured {ok:false, aborted:true} result instead of throwing when response.json() aborts mid-read', async () => {
    const abortError = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    const fetchImpl = vi.fn(async (_url: string, _init: any) => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => { throw abortError; },
    }));

    const result = await callOpenRouterChat(fetchImpl as any, {
      url: 'https://openrouter.ai/api/v1/chat/completions',
      headers: { Authorization: 'Bearer test' },
      body: { model: 'deepseek/deepseek-v4-flash-0731', messages: [] },
      timeoutMs: 5_000,
      // preferStream omitted — exercises the default non-stream nonStreamOnce() path.
    });

    expect(result.ok).toBe(false);
    expect(result.aborted).toBe(true);
    expect(result.streamed).toBe(false);
    expect(result.model).toBe('deepseek/deepseek-v4-flash-0731');
    expect(result.provider).toBe('openrouter');
  });

  it('still resolves normally when response.json() succeeds (no regression on the happy path)', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: any) => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        id: 'gen-happy-path',
        model: 'anthropic/claude-sonnet-4',
        provider: 'Anthropic',
        choices: [{ message: { content: '{"findings":[]}' } }],
        usage: { prompt_tokens: 5, completion_tokens: 1 },
      }),
    }));

    const result = await callOpenRouterChat(fetchImpl as any, {
      url: 'https://openrouter.ai/api/v1/chat/completions',
      headers: { Authorization: 'Bearer test' },
      body: { model: 'deepseek/deepseek-v4-flash-0731', messages: [] },
      timeoutMs: 5_000,
    });

    expect(result.ok).toBe(true);
    expect(result.provider).toBe('Anthropic');
    expect(result.model).toBe('anthropic/claude-sonnet-4');
  });
});
