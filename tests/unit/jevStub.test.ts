import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  hashJevRequest,
  createCassetteJevStub,
  createFailingJevStub,
  createAllFailureJevStubs,
  createLlmBackedJevStub,
  writeJevCassette,
  JevCassetteMissError,
  JevCassetteNotFoundError,
} from '../support/jevStub';
import { JEV_UNAVAILABLE_REASONS, type JevQuestion } from '../../src/gateway/jevClient';

const QUESTIONS: Record<string, JevQuestion> = {
  is_ambiguous: { type: 'noul', instructions: 'Is this ambiguous?' },
};

describe('hashJevRequest — canonical, order-independent key for cassette lookup', () => {
  it('produces the same hash regardless of object key order', () => {
    const a = hashJevRequest({ b: 2, a: 1 }, { q: QUESTIONS.is_ambiguous });
    const b = hashJevRequest({ a: 1, b: 2 }, { q: QUESTIONS.is_ambiguous });
    expect(a).toBe(b);
  });

  it('produces a different hash for different content', () => {
    const a = hashJevRequest('state one', QUESTIONS);
    const b = hashJevRequest('state two', QUESTIONS);
    expect(a).not.toBe(b);
  });
});

describe('createCassetteJevStub — mode 1: cassette playback (default for unit tests)', () => {
  function tmpCassettePath(): string {
    return path.join(os.tmpdir(), `jev-cassette-${Math.random().toString(36).slice(2)}.json`);
  }

  it('replays the recorded ok outcome for a matching {state, questions} hash', async () => {
    const cassettePath = tmpCassettePath();
    const hash = hashJevRequest('diff text', QUESTIONS);
    writeJevCassette(cassettePath, {
      version: 1,
      interactions: {
        [hash]: {
          model: 'jev-1.13.0',
          answers: { is_ambiguous: { type: 'noul', noul: 0.24 } },
          usage: { input_tokens: 561, output_tokens: 58 },
        },
      },
    });

    const stub = createCassetteJevStub({ cassettePath });
    const outcome = await stub.ask({ state: 'diff text', questions: QUESTIONS });

    expect(outcome).toEqual({
      status: 'ok',
      model: 'jev-1.13.0',
      answers: { is_ambiguous: { type: 'noul', noul: 0.24 } },
      usage: { input_tokens: 561, output_tokens: 58 },
      durationMs: expect.any(Number),
    });
    fs.unlinkSync(cassettePath);
  });

  it('throws (fails loudly, does not silently degrade) when the request hash is not in the cassette', async () => {
    const cassettePath = tmpCassettePath();
    writeJevCassette(cassettePath, { version: 1, interactions: {} });
    const stub = createCassetteJevStub({ cassettePath });

    await expect(stub.ask({ state: 'unrecorded', questions: QUESTIONS })).rejects.toBeInstanceOf(
      JevCassetteMissError,
    );
    fs.unlinkSync(cassettePath);
  });

  it('throws JevCassetteNotFoundError for a missing cassette file', () => {
    expect(() => createCassetteJevStub({ cassettePath: path.join(os.tmpdir(), 'does-not-exist.json') })).toThrow(
      JevCassetteNotFoundError,
    );
  });

  it('assertComplete() flags unconsumed interactions as stale fixtures', async () => {
    const cassettePath = tmpCassettePath();
    const usedHash = hashJevRequest('used', QUESTIONS);
    const staleHash = hashJevRequest('stale', QUESTIONS);
    writeJevCassette(cassettePath, {
      version: 1,
      interactions: {
        [usedHash]: {
          model: 'jev-1.13.0',
          answers: { is_ambiguous: { type: 'noul', noul: 0.5 } },
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        [staleHash]: {
          model: 'jev-1.13.0',
          answers: { is_ambiguous: { type: 'noul', noul: 0.5 } },
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    });
    const stub = createCassetteJevStub({ cassettePath });
    await stub.ask({ state: 'used', questions: QUESTIONS });
    expect(() => stub.assertComplete()).toThrow(/unconsumed/i);
    fs.unlinkSync(cassettePath);
  });
});

describe('createFailingJevStub / createAllFailureJevStubs — mode 2: forced failure', () => {
  it('resolves the requested reason without any network seam', async () => {
    const stub = createFailingJevStub('http_429');
    const outcome = await stub.ask({ state: 's', questions: QUESTIONS });
    expect(outcome).toEqual({ status: 'unavailable', reason: 'http_429', durationMs: expect.any(Number) });
  });

  // Permanently exercised: this is the exit path if the vendor withdraws.
  it.each(JEV_UNAVAILABLE_REASONS)('exercises unavailable reason "%s"', async (reason) => {
    const stubs = createAllFailureJevStubs();
    const outcome = await stubs[reason].ask({ state: 's', questions: QUESTIONS });
    expect(outcome).toEqual({ status: 'unavailable', reason, durationMs: expect.any(Number) });
  });
});

describe('createLlmBackedJevStub — mode 3: LLM-backed adapter, hard-gated off production', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws at construction time when NODE_ENV is production', () => {
    const client = { complete: vi.fn() };
    expect(() =>
      createLlmBackedJevStub({ client, model: 'test/model', nodeEnv: 'production' }),
    ).toThrow(/production/i);
    expect(client.complete).not.toHaveBeenCalled();
  });

  it('does not throw outside production', () => {
    const client = { complete: vi.fn() };
    expect(() => createLlmBackedJevStub({ client, model: 'test/model', nodeEnv: 'test' })).not.toThrow();
  });

  it('answers via the injected model client and coerces the result into a JevAnswer', async () => {
    const client = {
      complete: vi.fn().mockResolvedValue({
        model: 'test/model',
        content: JSON.stringify({ type: 'noul', noul: 0.7 }),
        usage: { prompt: 50, completion: 5, total: 55 },
        costUSD: 0,
        raw: {},
      }),
    };
    const stub = createLlmBackedJevStub({ client, model: 'test/model', nodeEnv: 'test' });
    const outcome = await stub.ask({ state: 's', questions: QUESTIONS });

    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') throw new Error('expected ok');
    expect(outcome.answers.is_ambiguous).toEqual({ type: 'noul', noul: 0.7 });
    expect(client.complete).toHaveBeenCalledTimes(1);
  });

  it('asks the LLM for the LIVE score contract: index-keyed legend and probabilities, score in [0,1] (REL-1100)', async () => {
    const live = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../fixtures/jev/systemone-live-jev-1.13.0.json'), 'utf8'),
    ).score.answers.risk;
    const criteria = Object.values(live.legend) as string[];
    const client = {
      complete: vi.fn().mockResolvedValue({ model: 'test/model', content: JSON.stringify(live), usage: null, costUSD: 0, raw: {} }),
    };
    const stub = createLlmBackedJevStub({ client, model: 'test/model', nodeEnv: 'test' });
    const outcome = await stub.ask({ state: 's', questions: { risk: { type: 'score', instructions: 'How risky?', criteria } } });
    expect(outcome.status).toBe('ok');

    const schema = client.complete.mock.calls[0][0].responseFormat.json_schema.schema;
    expect(schema.properties.score).toMatchObject({ type: 'number', minimum: 0, maximum: 1 });
    expect(schema.properties.legend).toMatchObject({ type: 'object', required: Object.keys(live.legend), additionalProperties: false });
    expect(schema.properties.probabilities).toMatchObject({ type: 'object', required: Object.keys(live.probabilities), additionalProperties: false });
    // Negative proof: the schema no longer describes the array legend the real API never returns.
    expect(schema.properties.legend.type).not.toBe('array');
    for (const [key, text] of Object.entries(live.legend)) expect(schema.properties.legend.properties[key]).toEqual({ const: text });
  });

  it('resolves unavailable/malformed (never rejects) when the LLM output does not parse', async () => {
    const client = { complete: vi.fn().mockResolvedValue({ model: 'test/model', content: 'not json', usage: null, costUSD: 0, raw: {} }) };
    const stub = createLlmBackedJevStub({ client, model: 'test/model', nodeEnv: 'test' });
    const outcome = await stub.ask({ state: 's', questions: QUESTIONS });
    expect(outcome).toEqual({ status: 'unavailable', reason: 'malformed', durationMs: expect.any(Number) });
  });
});
