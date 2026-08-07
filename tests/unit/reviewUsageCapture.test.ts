import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';

const rootRepoDir = fs.existsSync(path.join(path.resolve(__dirname, '../..'), '.github/workflows/pipelines/review-pipeline.js'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');
const pipeline = require(path.join(rootRepoDir, '.github/workflows/pipelines/review-pipeline.js'));

const { reviewWithModel, sumUsage, PERSONA_CHARTERS } = pipeline;
const persona = PERSONA_CHARTERS.find((p: any) => p.id === 'security');
const diffFiles = [{ path: 'src/a.ts', patch: '+x', addedLines: [], deletedLines: [] }];

/** Fetch stub returning a completion with an optional usage block. */
function stub(usage?: any, content = '{"findings":[]}') {
  return async () => ({
    ok: true,
    status: 200,
    text: async () => '',
    json: async () => ({ choices: [{ message: { content } }], ...(usage ? { usage } : {}) }),
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
    expect(res.usage).toEqual({ promptTokens: 0, completionTokens: 0, costUSD: 0 });
  });

  it('still reports usage for a lane whose output could not be parsed', async () => {
    // The request was billed regardless of whether the answer was usable.
    const res = await reviewWithModel(persona, diffFiles, { repo: 'o/r' }, null, {
      apiKey: 'k', fetchImpl: stub({ prompt_tokens: 900, completion_tokens: 12 }, 'sorry, no JSON here'),
    });
    expect(res.decision).toBe('ERROR');
    expect(res.usage.promptTokens).toBe(900);
  });

  it('reports zero usage when the request never completed', async () => {
    const res = await reviewWithModel(persona, diffFiles, { repo: 'o/r' }, null, {
      apiKey: 'k', fetchImpl: async () => { throw new Error('connection refused'); },
    });
    expect(res.decision).toBe('ERROR');
    expect(res.usage).toEqual({ promptTokens: 0, completionTokens: 0, costUSD: 0 });
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
    expect(sumUsage([{}, { usage: { promptTokens: 5, completionTokens: 1, costUSD: 0 } }]).promptTokens).toBe(5);
  });

  it('returns zeros for an empty set', () => {
    expect(sumUsage([])).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0, costUSD: 0 });
  });
});
