import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(__dirname, '../..');
const fixturePath = path.join(root, 'tests/fixtures/review-intelligence/offline-promotion-matrix.json');

describe('offline review-intelligence promotion gates', () => {
  it('covers repeated PR/feedback, recap, stale, provider, compaction, telemetry, MCP, lease, replay, and receipt cases deterministically', async () => {
    const { evaluateOfflinePromotionMatrix } = await import('../../scripts/evaluate-review-intelligence.mjs');
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    const result = evaluateOfflinePromotionMatrix(fixture);

    expect(result).toMatchObject({ status: 'pass', deterministic: true, liveEvidence: false, score: 1 });
    expect(result.scenarios).toEqual(expect.arrayContaining([
      'repeated-pr-feedback-transitions', 'session-recap-exact-head', 'stale-head-rejected',
      'provider-failure-fail-open', 'compaction-bounded', 'otel-receipt-redacted',
      'mcp-poisoning-rejected', 'lease-loss-fenced', 'replay-dead-letter-authorized', 'secret-free-receipts',
    ]));
  });

  it('fails closed when a matrix overclaims live evidence or permits a poisoned receipt', async () => {
    const { evaluateOfflinePromotionMatrix } = await import('../../scripts/evaluate-review-intelligence.mjs');
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

    expect(evaluateOfflinePromotionMatrix({ ...fixture, liveEvidence: true }).status).toBe('fail');
    fixture.scenarios.find((scenario: any) => scenario.id === 'secret-free-receipts').receipt = { token: 'not-redacted' };
    expect(evaluateOfflinePromotionMatrix(fixture)).toMatchObject({ status: 'fail', failures: expect.arrayContaining(['secret-free-receipts']) });
  });

  it('runs the promotion gate and plain-node Action load without optional live smoke', () => {
    const output = execFileSync(process.execPath, ['scripts/run-review-intelligence-promotion.mjs', '--fixture', fixturePath], { cwd: root, encoding: 'utf8' });
    const receipt = JSON.parse(output);
    expect(receipt).toMatchObject({ status: 'pass', offline: { status: 'pass' }, actionRuntime: { loadedTypescript: false }, liveSmoke: { status: 'not_run' } });
  });
});
