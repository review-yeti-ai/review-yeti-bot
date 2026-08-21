import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';

const rootRepoDir = fs.existsSync(path.join(path.resolve(__dirname, '../..'), '.github/workflows/pipelines/review-pipeline.js'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');
const pipeline = require(path.join(rootRepoDir, '.github/workflows/pipelines/review-pipeline.js'));

const { planDiffBudget, formatPRComment, computeArbitrationQuorum, writeStepOutputs } = pipeline;

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
