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

  it('keeps policy metadata separate from whole-request budget metadata', () => {
    const coverage = {
      reviewed: ['src/app.ts'],
      skipped: [{ path: 'openapi.generated.json', category: 'generated', reason: 'generated' }],
      oversized: [{ path: 'fixtures/openapi.yaml', category: 'oversized', reason: 'per-file cap' }],
      truncated: [],
      omitted: ['src/tail.ts'],
      passes: 1,
    };

    expect(coverage.skipped.map((entry) => entry.category)).toEqual(['generated']);
    expect(coverage.oversized.map((entry) => entry.category)).toEqual(['oversized']);
    expect(coverage.omitted).toEqual(['src/tail.ts']);
    expect(coverage.oversized).not.toEqual(expect.arrayContaining(coverage.omitted));
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

  it('reports bounded intentional and oversized exclusions as expected policy metadata', () => {
    const coverage = {
      reviewed: ['src/app.ts'],
      skipped: [
        { path: 'generated/one.json', category: 'generated', reason: 'generated artifact' },
        { path: 'configured/two.json', category: 'configured', reason: 'excluded by configuration' },
      ],
      oversized: [
        { path: 'src/oversized.ts', category: 'oversized', reason: 'per-file cap', diffChars: 5_001 },
      ],
      truncated: [],
      omitted: [],
      passes: 1,
    };
    const c = formatPRComment(
      computeArbitrationQuorum(results, 1, { coverageComplete: false }),
      results,
      ctx,
      {},
      {},
      coverage,
    );

    expect(c).toContain('generated/one.json');
    expect(c).toContain('configured/two.json');
    expect(c).toContain('src/oversized.ts');
    expect(c).toMatch(/expected policy exclusion|does not block/i);
    expect(c).not.toContain('x'.repeat(5_001));
  });

  it('describes mixed oversized and skipped coverage as non-blocking policy exclusions', () => {
    const coverage = {
      reviewed: [],
      skipped: [{ path: 'package-lock.json', category: 'lockfile', reason: 'dependency lockfile' }],
      oversized: [{ path: 'src/oversized.ts', category: 'oversized', reason: 'File diff exceeds the per-file review limit.', diffChars: 5_001 }],
      truncated: [],
      omitted: [],
      passes: 1,
    };
    const c = formatPRComment(
      {
        verdict: 'SHIP',
        status: 'SHIP',
        quorumSatisfied: true,
        completedPersonas: 0,
        totalPersonas: 0,
        rationale: 'Only expected policy exclusions remained.',
        metrics: { p0Count: 0, p1Count: 0, p2Count: 0, totalFindings: 0 },
      },
      [],
      ctx,
      {},
      { enabled: true, model: 'm', maxDiffChars: 20_000 },
      coverage,
    );

    expect(c).toContain('Verdict: SHIP');
    expect(c).toMatch(/per-file cap|per-file limit/i);
    expect(c).toContain('max-file-diff-chars');
    expect(c).toContain('intentionally skipped');
    expect(c).toMatch(/does not block|expected policy exclusion/i);
    expect(c).not.toMatch(/The diff exceeded .*characters per reviewer/i);
    expect(c).not.toMatch(/every changed file exceeded/i);
  });

  it('reports eligible files as unreviewed when no persona results exist', () => {
    const coverage = {
      reviewed: [{ path: 'src/eligible.ts', category: 'source' }],
      skipped: [],
      oversized: [{ path: 'src/oversized.ts', category: 'oversized', reason: 'File diff exceeds the per-file review limit.', diffChars: 5_001 }],
      truncated: [],
      omitted: [],
      passes: 1,
    };
    const c = formatPRComment(
      {
        verdict: 'BLOCK',
        status: 'INCOMPLETE_REVIEW',
        quorumSatisfied: false,
        completedPersonas: 0,
        totalPersonas: 0,
        rationale: 'Review is incomplete.',
        metrics: { p0Count: 0, p1Count: 0, p2Count: 0, totalFindings: 0 },
      },
      [],
      ctx,
      {},
      { enabled: true, model: 'm', maxDiffChars: 20_000 },
      coverage,
    );

    expect(c).toMatch(/eligible changed files were present/i);
    expect(c).toMatch(/no reviewer persona results were produced/i);
    expect(c).not.toMatch(/no files remained eligible/i);
    expect(c).not.toMatch(/intentionally skipped/i);
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
    expect(content).toContain('files-oversized=0');
  });
});
