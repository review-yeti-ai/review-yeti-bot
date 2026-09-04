import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';

const rootRepoDir = fs.existsSync(path.join(path.resolve(__dirname, '../..'), '.github/workflows/pipelines/review-pipeline.js'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');
const pipeline = require(path.join(rootRepoDir, '.github/workflows/pipelines/review-pipeline.js'));

const {
  planDiffBudget,
  formatPRComment,
  computeArbitrationQuorum,
  writeStepOutputs,
  calculateTransportDiffCapacity,
  calculateLaneDiffBudget,
  calculateSafeDiffCapacity,
  DIRECT_REASONING_SAFE_PROMPT_TOKENS,
  reviewWithModel,
  PERSONA_CHARTERS,
} = pipeline;

const securityPersona = PERSONA_CHARTERS.find((p: any) => p.id === 'security');

const file = (p: string, size: number) => ({
  path: p,
  patch: 'x'.repeat(size),
  addedLines: [],
  deletedLines: [],
});

describe('planDiffBudget', () => {
  it('reviews everything when the diff fits', () => {
    const plan = planDiffBudget([file('a.ts', 100), file('b.ts', 100)], 10_000);
    expect(plan.reviewed).toEqual(['a.ts', 'b.ts']);
    expect(plan.truncated).toEqual([]);
    expect(plan.omitted).toEqual([]);
  });

  it('truncates an oversized file rather than dropping it, so it still gets reviewed', () => {
    const plan = planDiffBudget([file('huge.ts', 50_000)], 10_000);
    expect(plan.reviewed).toEqual(['huge.ts']);
    expect(plan.truncated).toEqual(['huge.ts']);
    expect(plan.omitted).toEqual([]);
  });

  it('does not let one large file starve the files after it', () => {
    const plan = planDiffBudget([file('huge.ts', 100_000), file('small.ts', 200)], 10_000);
    expect(plan.reviewed).toContain('small.ts');
  });

  it('records overflow files by name instead of dropping them silently', () => {
    const many = Array.from({ length: 200 }, (_, i) => file(`f${i}.ts`, 5_000));
    const plan = planDiffBudget(many, 10_000);
    expect(plan.omitted.length).toBeGreaterThan(0);
    expect(plan.reviewed.length + plan.omitted.length).toBe(200);
    expect(plan.omitted[0]).toMatch(/^f\d+\.ts$/);
  });

  it('keeps the rendered prompt near the budget', () => {
    const many = Array.from({ length: 50 }, (_, i) => file(`f${i}.ts`, 5_000));
    const plan = planDiffBudget(many, 10_000);
    // Allow headroom for per-file headers and truncation notices.
    expect(plan.text.length).toBeLessThan(10_000 * 2);
  });

  it('tells the model what it was not shown', () => {
    const many = Array.from({ length: 200 }, (_, i) => file(`f${i}.ts`, 5_000));
    const plan = planDiffBudget(many, 10_000);
    expect(plan.text).toMatch(/not shown|omitted|truncated/i);
  });

  it('handles an empty diff without throwing', () => {
    const plan = planDiffBudget([], 10_000);
    expect(plan.reviewed).toEqual([]);
    expect(plan.omitted).toEqual([]);
  });
});

describe('Incomplete coverage is disclosed to the human, not just the model', () => {
  const results = [{
    personaId: 'security',
    displayName: '🛡️ Security',
    model: 'm',
    decision: 'APPROVE',
    findings: [],
  }];
  const ctx = { repo: 'o/r', prNumber: '1', headSha: 'abc1234' };

  it('states in the comment when files were not reviewed', () => {
    const coverage = { reviewed: ['a.ts'], truncated: [], omitted: ['b.ts', 'c.ts'] };
    const c = formatPRComment(computeArbitrationQuorum(results, 1), results, ctx, {}, {}, coverage);
    expect(c).toMatch(/not reviewed|omitted/i);
    expect(c).toContain('b.ts');
    expect(c).toContain('c.ts');
  });

  it('states when a reviewed file was only partially shown', () => {
    const coverage = { reviewed: ['a.ts'], truncated: ['a.ts'], omitted: [] };
    const c = formatPRComment(computeArbitrationQuorum(results, 1), results, ctx, {}, {}, coverage);
    expect(c).toMatch(/truncated|partial/i);
  });

  it('says nothing about coverage when the whole diff was reviewed', () => {
    const coverage = { reviewed: ['a.ts'], truncated: [], omitted: [] };
    const c = formatPRComment(computeArbitrationQuorum(results, 1), results, ctx, {}, {}, coverage);
    expect(c).not.toMatch(/not reviewed/i);
  });

  it('does not claim a clean verdict is complete when files were skipped', () => {
    const coverage = { reviewed: ['a.ts'], truncated: [], omitted: ['b.ts'] };
    const c = formatPRComment(computeArbitrationQuorum(results, 1), results, ctx, {}, {}, coverage);
    // The reader must be able to see the verdict covers only part of the change.
    expect(c).toMatch(/⚠️|incomplete|partial|not reviewed/i);
  });
});

// REL-556: a direct-reasoning transport (Ollama/Fireworks) can exhaust its whole output
// ceiling on reasoning alone before emitting a content token, once the prompt is large enough
// -- regardless of reasoning_effort. calculateTransportDiffCapacity / calculateLaneDiffBudget
// give the lane a hard input-side ceiling so that never happens.
describe('calculateTransportDiffCapacity', () => {
  it('does not constrain a context-bound transport (OpenRouter)', () => {
    const cap = calculateTransportDiffCapacity(
      { name: 'openrouter-deepseek', provider: 'openrouter', model: 'deepseek/deepseek-v4-flash-0731' },
      'https://openrouter.ai/api/v1',
    );
    expect(cap).toBe(Infinity);
  });

  it('bounds a direct-reasoning transport (Ollama) well under its evidence-observed failure point', () => {
    const cap = calculateTransportDiffCapacity(
      { name: 'ollama', model: 'deepseek-v4-flash:cloud' },
      'https://ollama.com/v1',
    );
    // Evidence (REL-556): 729,269 chars (~212k prompt tokens) exhausted the model's 65,536-token
    // ceiling on reasoning alone; 65k prompt tokens left enough headroom. The cap must sit
    // comfortably below the observed failure size.
    expect(cap).toBeGreaterThan(0);
    expect(cap).toBeLessThan(300_000);
  });

  it('recognizes Fireworks as reasoning-ceiling-bound the same way as Ollama', () => {
    const cap = calculateTransportDiffCapacity(
      { name: 'fireworks', model: 'accounts/fireworks/models/deepseek-v4-flash-0731' },
      'https://api.fireworks.ai/inference/v1',
    );
    expect(cap).toBeGreaterThan(0);
    expect(Number.isFinite(cap)).toBe(true);
  });

  it('honors a transport-declared override for a route with its own measured ceiling', () => {
    const narrow = calculateTransportDiffCapacity(
      { name: 'ollama', model: 'deepseek-v4-flash:cloud', reasoningSafePromptTokens: 10_000 },
      'https://ollama.com/v1',
    );
    const wide = calculateTransportDiffCapacity(
      { name: 'ollama', model: 'deepseek-v4-flash:cloud', reasoningSafePromptTokens: 90_000 },
      'https://ollama.com/v1',
    );
    expect(narrow).toBeLessThan(wide);
  });
});

describe('calculateLaneDiffBudget', () => {
  const openRouterTransport = { name: 'openrouter-deepseek', provider: 'openrouter', model: 'deepseek/deepseek-v4-flash-0731' };
  const ollamaTransport = { name: 'ollama', model: 'deepseek-v4-flash:cloud' };

  it('keeps the requested budget when no candidate transport is reasoning-ceiling-bound', () => {
    const budget = calculateLaneDiffBudget([openRouterTransport], 400_000);
    expect(budget).toBe(400_000);
  });

  it('tightens the budget to the safest transport in the fallback chain', () => {
    const budget = calculateLaneDiffBudget([openRouterTransport, ollamaTransport], 400_000);
    const ollamaCap = calculateTransportDiffCapacity(ollamaTransport, '');
    expect(budget).toBe(ollamaCap);
    expect(budget).toBeLessThan(400_000);
  });

  it('falls back to the requested budget when no transports are known', () => {
    expect(calculateLaneDiffBudget(null, 400_000)).toBe(400_000);
    expect(calculateLaneDiffBudget([], 400_000)).toBe(400_000);
  });

  it('never returns a non-positive budget even if the requested budget is tiny', () => {
    const budget = calculateLaneDiffBudget([ollamaTransport], 1);
    expect(budget).toBeGreaterThanOrEqual(1);
  });
});

describe('REL-556: an oversized diff never reaches a direct-reasoning transport intact', () => {
  // Mirrors the evidence PR: cisco-cdr #4861, 727,269 chars across 126 files. Build an
  // equivalent-scale synthetic diff and confirm the applied budget for a lane whose fallback
  // chain includes Ollama is far under both the diff total and the OpenRouter-only budget for
  // the same lane, and that priority ordering (files earlier in the caller-supplied order win
  // review slots first -- see PR #419's tail-ordering of generated/lock/vendor/test files) is
  // preserved under the tighter cap.
  const totalChars = 700_000;
  const fileCount = 300;
  const perFileChars = Math.floor(totalChars / fileCount);
  const diffFiles = Array.from({ length: fileCount }, (_, i) => file(`src/file_${String(i).padStart(3, '0')}.ex`, perFileChars));

  it('sizes the synthetic fixture at the evidence scale', () => {
    const actualTotal = diffFiles.reduce((sum, f) => sum + f.patch.length, 0);
    expect(actualTotal).toBeGreaterThan(680_000);
    expect(actualTotal).toBeLessThan(720_000);
  });

  it('applies a materially tighter budget than an OpenRouter-only lane would get', () => {
    const openRouterOnlyBudget = calculateLaneDiffBudget(
      [{ name: 'openrouter-deepseek', provider: 'openrouter', model: 'deepseek/deepseek-v4-flash-0731' }],
      calculateSafeDiffCapacity('deepseek/deepseek-v4-flash-0731'),
    );
    const ollamaFallbackBudget = calculateLaneDiffBudget(
      [
        { name: 'openrouter-deepseek', provider: 'openrouter', model: 'deepseek/deepseek-v4-flash-0731' },
        { name: 'ollama', model: 'deepseek-v4-flash:cloud' },
      ],
      calculateSafeDiffCapacity('deepseek/deepseek-v4-flash-0731'),
    );
    expect(ollamaFallbackBudget).toBeLessThan(openRouterOnlyBudget);
    // The applied budget must leave the diff still oversized relative to the cap (this is a
    // 700k-char fixture on purpose), proving the cap actually bites rather than being a no-op.
    expect(ollamaFallbackBudget).toBeLessThan(totalChars);
  });

  it('keeps the existing priority ordering and honest disclosure under the tighter cap', () => {
    const ollamaFallbackBudget = calculateLaneDiffBudget(
      [{ name: 'ollama', model: 'deepseek-v4-flash:cloud' }],
      calculateSafeDiffCapacity('deepseek/deepseek-v4-flash-0731'),
    );
    const plan = planDiffBudget(diffFiles, ollamaFallbackBudget);

    // Not every file fits under the tightened budget -- some are correctly omitted, not
    // silently dropped.
    expect(plan.omitted.length).toBeGreaterThan(0);
    expect(plan.reviewed.length + plan.omitted.length).toBe(fileCount);

    // Ordering: the files reviewed are exactly a prefix of the caller-supplied order (the
    // priority ordering PR #419 established at the call site is untouched by this change --
    // planDiffBudget still walks the list in the order it was given).
    const reviewedPrefix = diffFiles.slice(0, plan.reviewed.length).map((f) => f.path);
    expect(plan.reviewed).toEqual(reviewedPrefix);

    // Honest disclosure: the model is told what it was not shown.
    expect(plan.text).toMatch(/not shown|omitted|truncated/i);
    expect(plan.text).toContain(plan.omitted[0]);
  });

  it('leaves an OpenRouter-only lane able to see materially more of the same diff', () => {
    const openRouterOnlyBudget = calculateLaneDiffBudget(
      [{ name: 'openrouter-deepseek', provider: 'openrouter', model: 'deepseek/deepseek-v4-flash-0731' }],
      calculateSafeDiffCapacity('deepseek/deepseek-v4-flash-0731'),
    );
    const ollamaFallbackBudget = calculateLaneDiffBudget(
      [{ name: 'ollama', model: 'deepseek-v4-flash:cloud' }],
      calculateSafeDiffCapacity('deepseek/deepseek-v4-flash-0731'),
    );
    const openRouterPlan = planDiffBudget(diffFiles, openRouterOnlyBudget);
    const ollamaPlan = planDiffBudget(diffFiles, ollamaFallbackBudget);
    expect(openRouterPlan.reviewed.length).toBeGreaterThan(ollamaPlan.reviewed.length);
  });
});

describe('REL-556: reviewWithModel applies the tightened budget end to end', () => {
  const totalChars = 700_000;
  const fileCount = 300;
  const perFileChars = Math.floor(totalChars / fileCount);
  const bigDiffFiles = Array.from({ length: fileCount }, (_, i) => file(`src/file_${String(i).padStart(3, '0')}.ex`, perFileChars));

  function stubFetch(content: string) {
    const calls: any[] = [];
    const impl = async (url: string, init: any) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      };
    };
    return { impl, calls };
  }

  it('sends the direct-reasoning transport a diff that fits its safe capacity, not the full 700k-char diff', async () => {
    const { impl, calls } = stubFetch(JSON.stringify({ findings: [] }));
    const result = await reviewWithModel(securityPersona, bigDiffFiles, { repo: 'o/r', prNumber: '1' }, null, {
      fetchImplementation: impl,
      transports: [{ name: 'ollama', baseUrl: 'https://ollama.com/v1', apiKey: 'k', model: 'deepseek-v4-flash:cloud' }],
    });

    expect(calls).toHaveLength(1);
    const userMessage = calls[0].body.messages.find((m: any) => m.role === 'user').content as string;
    // The full diff (700k chars across the patches alone) must not be on the wire -- only the
    // budgeted subset planDiffBudget selected.
    expect(userMessage.length).toBeLessThan(totalChars);
    expect(userMessage).toMatch(/not shown|omitted|truncated/i);

    // The applied per-lane budget and the omission count are reported in the lane's telemetry.
    expect(result.diffBudgetChars).toBeGreaterThan(0);
    expect(result.diffBudgetChars).toBeLessThan(totalChars);
    expect(result.diffOmittedFilesCount).toBeGreaterThan(0);
  });

  it('lets an OpenRouter-only lane see materially more of the same 700k-char diff', async () => {
    const { impl, calls } = stubFetch(JSON.stringify({ findings: [] }));
    const result = await reviewWithModel(securityPersona, bigDiffFiles, { repo: 'o/r', prNumber: '1' }, null, {
      fetchImplementation: impl,
      transports: [{ name: 'openrouter-deepseek', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k', model: 'deepseek/deepseek-v4-flash-0731', provider: 'openrouter' }],
    });

    const userMessage = calls[0].body.messages.find((m: any) => m.role === 'user').content as string;
    expect(result.diffOmittedFilesCount ?? 0).toBeLessThan(fileCount);
    expect(userMessage.length).toBeGreaterThan(0);
  });
});

describe('Coverage is exposed as step outputs so a workflow can gate on it', () => {
  it('emits reviewed and omitted counts', () => {
    const out = path.join(fs.mkdtempSync(path.join(require('os').tmpdir(), 'ct-cov-')), 'o.txt');
    writeStepOutputs(
      { verdict: 'SHIP', completedPersonas: 1, totalPersonas: 1, metrics: {} },
      out,
      { reviewed: ['a.ts', 'b.ts'], truncated: ['a.ts'], omitted: ['c.ts'] },
    );
    const content = fs.readFileSync(out, 'utf-8');
    expect(content).toContain('files-reviewed=2');
    expect(content).toContain('files-omitted=1');
  });
});
