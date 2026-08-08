import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCassetteFetch } from '../support/cassetteFetch';
import { buildDecisionLedger, reconcileDecisionFindings, renderDecisionLedger } from '../../src/review/decisionLedger';

const harnessCassette = path.resolve(__dirname, '../fixtures/cassettes/harness.json');
const decisionCassette = path.resolve(__dirname, '../fixtures/cassettes/decision-ledger.json');

describe('strict cassette replay', () => {
  const originalCi = process.env.CI;

  afterEach(() => {
    delete process.env.REVIEW_YETI_VCR;
    if (originalCi === undefined) delete process.env.CI;
    else process.env.CI = originalCi;
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

  it('refuses to record in CI regardless of the environment switch', async () => {
    process.env.CI = 'true';
    process.env.REVIEW_YETI_VCR = 'record';
    const cassettePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'review-yeti-cassette-')), 'ci.json');

    await expect(createCassetteFetch({
      cassettePath,
      mode: 'record',
      fetchImplementation: async () => new Response('{}', { status: 200 }),
      allowedRecordOrigins: ['https://llm.test'],
    }).fetchImplementation('https://llm.test/record')).rejects.toThrow('Cassette replay is mandatory in CI');
  });

  it('requires explicit record mode, the environment switch, and an origin allowlist', async () => {
    // Recording is refused outright under CI (covered above); this case exercises
    // the record-mode contract itself, so it must run outside that guard.
    delete process.env.CI;
    const cassettePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'review-yeti-cassette-')), 'record.json');
    const fetchImplementation = async () => new Response(JSON.stringify({ recorded: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

    await expect(createCassetteFetch({
      cassettePath,
      mode: 'record',
      fetchImplementation,
      allowedRecordOrigins: ['https://llm.test'],
    }).fetchImplementation('https://llm.test/record')).rejects.toThrow('REVIEW_YETI_VCR=record');

    process.env.REVIEW_YETI_VCR = 'record';
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
  });

  it('replays same-PR decision state byte-identically without exposing human reasons', async () => {
    const replay = async () => {
      const cassette = createCassetteFetch({ cassettePath: decisionCassette });
      const response = await cassette.fetchImplementation('https://github.test/graphql', {
        method: 'POST',
        headers: { Authorization: 'Bearer fake-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ operationName: 'DecisionLedgerSnapshot', pullRequest: 7 }),
      });
      const snapshot = await response.json();
      cassette.assertComplete();
      const ledger = buildDecisionLedger(snapshot);
      const rendered = renderDecisionLedger(ledger);
      const reconciliation = reconcileDecisionFindings([], ledger);
      return { ledger, rendered, reconciliation };
    };

    const first = await replay();
    const second = await replay();
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.ledger.entries.map((entry: any) => entry.state)).toEqual([
      'open', 'resolved', 'ignored', 'open', 'obsolete',
    ]);
    expect(first.rendered.text).not.toContain('accepted until API-1234');
    expect(JSON.stringify(first)).not.toContain('API-1234 has landed');
  });
});
