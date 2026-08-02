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
