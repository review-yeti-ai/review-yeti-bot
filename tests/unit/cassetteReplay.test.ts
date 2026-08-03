import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCassetteFetch } from '../support/cassetteFetch';

const harnessCassette = path.resolve(__dirname, '../fixtures/cassettes/harness.json');

describe('strict cassette replay', () => {
  afterEach(() => {
    delete process.env.CT_REVIEW_VCR;
  });

  it('matches concurrent requests by canonical fingerprint and consumes every interaction', async () => {
    const cassette = createCassetteFetch({ cassettePath: harnessCassette });

    const [second, first] = await Promise.all([
      cassette.fetchImplementation('https://llm.test/replay', {
        method: 'post',
        headers: {
          Authorization: 'Bearer second-secret',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ b: 2, a: 'second' }),
      }),
      cassette.fetchImplementation('https://llm.test/replay?b=2&a=1', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer first-secret',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ a: 'first', b: 1 }),
      }),
    ]);

    expect(await second.json()).toEqual({ value: 'second' });
    expect(await first.json()).toEqual({ value: 'first' });
    cassette.assertComplete();
    expect(cassette.interactions[0].request).toEqual({
      method: 'POST',
      url: 'https://llm.test/replay?a=1&b=2',
      headers: {
        authorization: '<redacted>',
        'content-type': 'application/json',
      },
      body: {
        a: 'first',
        b: 1,
      },
    });
    expect(cassette.interactions[0].response).toEqual({
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
      body: {
        value: 'first',
      },
    });

    const cassetteText = fs.readFileSync(harnessCassette, 'utf8');
    expect(cassetteText).not.toContain('second-secret');
    expect(cassetteText).not.toContain('first-secret');
  });

  it('fails closed on unmatched requests and incomplete cassettes', async () => {
    const cassette = createCassetteFetch({ cassettePath: harnessCassette });

    await expect(cassette.fetchImplementation('https://llm.test/unrecorded')).rejects.toThrow(
      'No cassette interaction matches'
    );

    const incomplete = createCassetteFetch({ cassettePath: harnessCassette });
    await incomplete.fetchImplementation('https://llm.test/replay?b=2&a=1', {
      method: 'POST',
      headers: { Authorization: 'Bearer first-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ b: 1, a: 'first' }),
    });
    expect(() => incomplete.assertComplete()).toThrow('Unconsumed cassette interactions');
  });

  it('redacts authorization and API secrets from unmatched request diagnostics', async () => {
    const cassette = createCassetteFetch({ cassettePath: harnessCassette });

    let message = '';
    try {
      await cassette.fetchImplementation('https://llm.test/unrecorded?api_key=query-secret', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer header-secret',
          'X-Api-Key': 'header-api-secret',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          apiKey: 'body-api-secret',
          nested: { token: 'body-token-secret' },
          safe: 'visible',
        }),
      });
    } catch (error: any) {
      message = String(error.message);
    }

    expect(message).toContain('No cassette interaction matches');
    expect(message).toContain('<redacted>');
    expect(message).toContain('visible');
    expect(message).not.toContain('query-secret');
    expect(message).not.toContain('header-secret');
    expect(message).not.toContain('header-api-secret');
    expect(message).not.toContain('body-api-secret');
    expect(message).not.toContain('body-token-secret');
  });

  it('never calls the underlying network transport in replay mode', async () => {
    let networkCalls = 0;
    const cassette = createCassetteFetch({
      cassettePath: harnessCassette,
      fetchImplementation: async () => {
        networkCalls += 1;
        throw new Error('network escaped replay');
      },
    });

    const response = await cassette.fetchImplementation('https://llm.test/replay', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer second-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ b: 2, a: 'second' }),
    });
    expect(await response.json()).toEqual({ value: 'second' });
    await expect(cassette.fetchImplementation('https://github.com/unrecorded')).rejects.toThrow(
      'No cassette interaction matches',
    );
    expect(networkCalls).toBe(0);
  });

  it('fails when an expected interaction is removed or a request URL/body is changed', async () => {
    const original = JSON.parse(fs.readFileSync(harnessCassette, 'utf8'));
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-review-mutated-cassette-'));
    const removedInteractionPath = path.join(tempDir, 'removed-interaction.json');
    const changedUrlPath = path.join(tempDir, 'changed-url.json');
    const changedBodyPath = path.join(tempDir, 'changed-body.json');

    const removedInteraction = structuredClone(original);
    removedInteraction.interactions = removedInteraction.interactions.slice(0, 1);
    fs.writeFileSync(removedInteractionPath, `${JSON.stringify(removedInteraction, null, 2)}\n`, 'utf8');

    const changedUrl = structuredClone(original);
    changedUrl.interactions[0].request.url = 'https://llm.test/replay?a=1&b=999';
    fs.writeFileSync(changedUrlPath, `${JSON.stringify(changedUrl, null, 2)}\n`, 'utf8');

    const changedBody = structuredClone(original);
    changedBody.interactions[0].request.body = { a: 'first', b: 999 };
    fs.writeFileSync(changedBodyPath, `${JSON.stringify(changedBody, null, 2)}\n`, 'utf8');

    const request = {
      method: 'POST',
      headers: { Authorization: 'Bearer first-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ b: 1, a: 'first' }),
    };

    await expect(createCassetteFetch({ cassettePath: removedInteractionPath }).fetchImplementation(
      'https://llm.test/replay',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer second-secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({ b: 2, a: 'second' }),
      },
    )).rejects.toThrow('No cassette interaction matches');
    await expect(createCassetteFetch({ cassettePath: changedUrlPath }).fetchImplementation(
      'https://llm.test/replay?b=2&a=1',
      request,
    )).rejects.toThrow('No cassette interaction matches');
    await expect(createCassetteFetch({ cassettePath: changedBodyPath }).fetchImplementation(
      'https://llm.test/replay?b=2&a=1',
      request,
    )).rejects.toThrow('No cassette interaction matches');
  });

  it('requires explicit record mode, the environment switch, and an origin allowlist', async () => {
    const cassettePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ct-review-cassette-')), 'record.json');
    const originalCi = process.env.CI;
    const fetchImplementation = async () => new Response(JSON.stringify({ recorded: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

    try {
      delete process.env.CI;
      await expect(createCassetteFetch({
        cassettePath,
        mode: 'record',
        fetchImplementation,
        allowedRecordOrigins: ['https://llm.test'],
      }).fetchImplementation('https://llm.test/record')).rejects.toThrow('CT_REVIEW_VCR=record');

      process.env.CT_REVIEW_VCR = 'record';
      await expect(createCassetteFetch({
        cassettePath,
        mode: 'record',
        fetchImplementation,
        allowedRecordOrigins: ['https://other.test'],
      }).fetchImplementation('https://llm.test/record')).rejects.toThrow('not allowlisted');

      const recorded = createCassetteFetch({
        cassettePath,
        mode: 'record',
        fetchImplementation,
        allowedRecordOrigins: ['https://llm.test'],
      });
      const response = await recorded.fetchImplementation('https://llm.test/record', {
        headers: { Authorization: 'Bearer live-secret' },
      });
      expect(await response.json()).toEqual({ recorded: true });
      recorded.assertComplete();
      expect(fs.readFileSync(cassettePath, 'utf8')).not.toContain('live-secret');
    } finally {
      if (originalCi === undefined) delete process.env.CI;
      else process.env.CI = originalCi;
    }
  });
});
