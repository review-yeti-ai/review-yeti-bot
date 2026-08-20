import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { sseBody } from '../support/streamableFetchStub';

const rootRepoDir = fs.existsSync(path.join(path.resolve(__dirname, '../..'), '.github/workflows/pipelines/review-pipeline.js'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');
const pipeline = require(path.join(rootRepoDir, '.github/workflows/pipelines/review-pipeline.js'));

const { reviewWithModel: reviewWithModelRaw, sumUsage, PERSONA_CHARTERS } = pipeline;
const persona = PERSONA_CHARTERS.find((p: any) => p.id === 'security');
const diffFiles = [{ path: 'src/a.ts', patch: '+x', addedLines: [], deletedLines: [] }];

// reviewWithModel now requires a caller-supplied options.investigationMessages (the legacy
// single-shot prompt-building/parsing path it used to fall back to is gone). These tests are
// about usage/cost metering, not message content, so every call gets the same bounded stand-in
// messages.
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

/** Fetch stub returning a completion with an optional usage block. */
function stub(usage?: any, content = '{"findings":[]}') {
  const payload = { choices: [{ message: { content } }], ...(usage ? { usage } : {}) };
  return async () => ({
    ok: true,
    status: 200,
    text: async () => '',
    json: async () => payload,
    body: sseBody(payload),
  });
}

describe('reviewWithModel captures token usage', () => {
  it('returns prompt and completion tokens reported by the provider', async () => {
    const res = await reviewWithModel(persona, diffFiles, { repo: 'o/r' }, null, {
      apiKey: 'k', fetchImpl: stub({ prompt_tokens: 1200, completion_tokens: 340 }),
    });
    expect(res.usage.promptTokens).toBe(1200);
    expect(res.usage.completionTokens).toBe(340);
  });

  it('carries through a provider-reported cost when present', async () => {
    const res = await reviewWithModel(persona, diffFiles, { repo: 'o/r' }, null, {
      apiKey: 'k', fetchImpl: stub({ prompt_tokens: 10, completion_tokens: 5, cost: 0.0042 }),
    });
    expect(res.usage.costUSD).toBeCloseTo(0.0042);
  });

  it('reports zeros rather than guessing when the provider omits usage', async () => {
    const res = await reviewWithModel(persona, diffFiles, { repo: 'o/r' }, null, {
      apiKey: 'k', fetchImpl: stub(undefined),
    });
    expect(res.usage).toEqual({ promptTokens: 0, completionTokens: 0 });
  });

  it('still reports usage for a lane whose output could not be parsed', async () => {
    // The request was billed regardless of whether the answer was usable. Parsing/validating the
    // raw content is now the caller's job (parseInvestigationResponse); reviewWithModel's own
    // transport layer succeeds (ok:true) as long as the HTTP round trip did, and usage is read
    // from the response before anyone judges whether the content is usable.
    const res = await reviewWithModel(persona, diffFiles, { repo: 'o/r' }, null, {
      apiKey: 'k', fetchImpl: stub({ prompt_tokens: 900, completion_tokens: 12 }, 'sorry, no JSON here'),
    });
    expect(res.ok).toBe(true);
    expect(res.usage.promptTokens).toBe(900);
  });

  it('reports zero usage when the request never completed', async () => {
    const res = await reviewWithModel(persona, diffFiles, { repo: 'o/r' }, null, {
      apiKey: 'k', fetchImpl: async () => { throw new Error('connection refused'); },
    });
    expect(res.decision).toBe('ERROR');
    expect(res.usage).toEqual({ promptTokens: 0, completionTokens: 0 });
  });
});

describe('sumUsage', () => {
  it('totals usage across lanes and passes', () => {
    const total = sumUsage([
      { usage: { promptTokens: 100, completionTokens: 10, costUSD: 0.01 } },
      { usage: { promptTokens: 250, completionTokens: 25, costUSD: 0.02 } },
    ]);
    expect(total.promptTokens).toBe(350);
    expect(total.completionTokens).toBe(35);
    expect(total.costUSD).toBeCloseTo(0.03);
    expect(total.totalTokens).toBe(385);
  });

  it('tolerates lanes with no usage recorded', () => {
    const total = sumUsage([{}, { usage: { promptTokens: 5, completionTokens: 1, costUSD: 0 } }]);
    expect(total.promptTokens).toBe(5);
    expect(total.costUSD).toBe(0);
  });

  it('returns zeros for an empty set', () => {
    expect(sumUsage([])).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  });

  it('preserves absent provider cost through totals and Action outputs', () => {
    const usage = sumUsage([{ usage: { promptTokens: 5, completionTokens: 1 } }]);
    expect(usage).toEqual({ promptTokens: 5, completionTokens: 1, totalTokens: 6 });

    const output = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'review-yeti-no-cost-')), 'github-output.txt');
    pipeline.writeStepOutputs({ verdict: 'SHIP', metrics: {}, coverageStatus: 'complete', gateDecision: 'PASS', mergeEligible: true }, output, null, usage);

    expect(fs.readFileSync(output, 'utf-8')).toContain('cost-usd=');
    expect(fs.readFileSync(output, 'utf-8')).not.toContain('cost-usd=0');
  });

  it('omits aggregate cost when any provider receipt omitted its cost', () => {
    const usage = sumUsage([
      { usage: { promptTokens: 5, completionTokens: 1, costUSD: 0.01 } },
      { usage: { promptTokens: 7, completionTokens: 2 } },
    ]);

    expect(usage).toEqual({ promptTokens: 12, completionTokens: 3, totalTokens: 15 });
    expect(usage).not.toHaveProperty('costUSD');
  });
});
