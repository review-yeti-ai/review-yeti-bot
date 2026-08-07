import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';

const rootRepoDir = fs.existsSync(path.join(path.resolve(__dirname, '../..'), '.github/workflows/pipelines/review-pipeline.js'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');
const pipeline = require(path.join(rootRepoDir, '.github/workflows/pipelines/review-pipeline.js'));

const { filterReviewableFiles, planDiffPasses, mergeFindings } = pipeline;

const f = (p: string, size = 100) => ({ path: p, patch: 'x'.repeat(size), addedLines: [], deletedLines: [] });
const paths = (files: any[]) => files.map((x) => x.path);

describe('filterReviewableFiles — machine-generated content is not worth a review lane', () => {
  it('excludes dependency lockfiles', () => {
    const r = filterReviewableFiles([
      f('package-lock.json'), f('yarn.lock'), f('pnpm-lock.yaml'),
      f('Gemfile.lock'), f('mix.lock'),
      f('src/index.ts'),
    ]);
    expect(paths(r.files)).toEqual(['src/index.ts']);
    expect(r.skipped).toHaveLength(5);
  });

  it('excludes generated source and snapshots', () => {
    const r = filterReviewableFiles([
      f('server/Migrations/Order.generated.ts'),
      f('tests/__snapshots__/orders.snap'),
      f('server/Services/OrderService.cs'),
    ]);
    expect(paths(r.files)).toEqual(['server/Services/OrderService.cs']);
  });

  it('excludes build output and vendored code', () => {
    const r = filterReviewableFiles([
      f('dist/bundle.js'), f('build/main.js'), f('.next/static/x.js'),
      f('vendor/lib.php'), f('node_modules/pkg/index.js'), f('src/app.ts'),
    ]);
    expect(paths(r.files)).toEqual(['vendor/lib.php', 'src/app.ts']);
  });

  it('excludes minified assets and test snapshots', () => {
    const r = filterReviewableFiles([
      f('public/app.min.js'), f('public/style.min.css'),
      f('tests/__snapshots__/x.snap'), f('src/real.ts'),
    ]);
    expect(paths(r.files)).toEqual(['src/real.ts']);
  });

  it('keeps ordinary source, including migrations that are not generated snapshots', () => {
    const r = filterReviewableFiles([
      f('server/Migrations/20240101_AddOrgId.cs'),
      f('src/api/orders.ts'),
      f('README.md'),
    ]);
    expect(r.files).toHaveLength(3);
    expect(r.skipped).toHaveLength(0);
  });

  it('records why each file was skipped, so the comment can explain itself', () => {
    const r = filterReviewableFiles([f('package-lock.json')]);
    expect(r.skipped[0].path).toBe('package-lock.json');
    expect(r.skipped[0].reason).toBeTruthy();
  });

  it('keeps an oversized OpenAPI fixture out of the reviewable files', () => {
    const r = filterReviewableFiles([
      f('fixtures/openapi.yaml', 5_001),
      f('src/app.ts', 100),
    ], [], { maxFileDiffChars: 5_000 });

    expect(paths(r.files)).toEqual(['src/app.ts']);
    expect(r.oversized).toEqual([
      expect.objectContaining({
        path: 'fixtures/openapi.yaml',
        category: 'oversized',
        reason: expect.stringMatching(/per-file/i),
      }),
    ]);
    expect(r.oversized[0]).not.toHaveProperty('patch');
  });

  it('keeps generated, configured, oversized, and whole-request omissions distinct', () => {
    const r = filterReviewableFiles([
      f('openapi.generated.json'),
      f('fixtures/configured/example.txt'),
      f('src/huge.ts', 5_001),
      f('src/app.ts'),
    ], ['fixtures/configured/**'], { maxFileDiffChars: 5_000 });

    expect(r.skipped.map((entry: any) => entry.category)).toEqual(['generated', 'configured']);
    expect(r.oversized.map((entry: any) => entry.category)).toEqual(['oversized']);
    expect(paths(r.files)).toEqual(['src/app.ts']);

    const budget = pipeline.planDiffBudget([f('src/shown.ts', 100), f('src/tail.ts', 100)], 100);
    expect(budget.omitted).toEqual(['src/tail.ts']);
    expect(r.oversized).not.toEqual(expect.arrayContaining(budget.omitted));
  });

  it('applies the size cap after a negation restores a built-in match', () => {
    const r = filterReviewableFiles(
      [f('src/generated/keep.generated.ts', 5_001)],
      ['!src/generated/keep.generated.ts'],
      { maxFileDiffChars: 5_000 },
    );

    expect(r.files).toEqual([]);
    expect(r.skipped).toEqual([]);
    expect(r.oversized).toEqual([
      expect.objectContaining({ path: 'src/generated/keep.generated.ts', category: 'oversized' }),
    ]);
  });

  it('honours additional exclude globs from repository configuration', () => {
    const r = filterReviewableFiles([f('src/legacy/big.ts'), f('src/app.ts')], ['src/legacy/**']);
    expect(paths(r.files)).toEqual(['src/app.ts']);
  });

  it('restores a configured exclusion with a ! negation', () => {
    const r = filterReviewableFiles(
      [f('src/generated/client.ts'), f('src/entities/generated/domain.ts'), f('src/app.ts')],
      ['**/generated/**', '!src/entities/generated/**'],
    );
    expect(paths(r.files)).toEqual(['src/entities/generated/domain.ts', 'src/app.ts']);
    expect(paths(r.skipped as any)).toEqual(['src/generated/client.ts']);
  });

  // Without this, a repository whose scripts live in bin/ cannot get them reviewed at all:
  // the built-in list is hardcoded and every pattern is first-match-wins.
  it('restores a file a built-in pattern matched', () => {
    const r = filterReviewableFiles([f('bin/deploy.sh'), f('dist/bundle.js')], ['!bin/**']);
    expect(paths(r.files)).toEqual(['bin/deploy.sh']);
    expect(paths(r.skipped as any)).toEqual(['dist/bundle.js']);
  });

  // Hand-edited config should not depend on line order to be correct.
  it('applies negations regardless of where they appear in the list', () => {
    const before = filterReviewableFiles([f('src/generated/keep.ts')], ['!src/generated/keep.ts', '**/generated/**']);
    const after = filterReviewableFiles([f('src/generated/keep.ts')], ['**/generated/**', '!src/generated/keep.ts']);
    expect(paths(before.files)).toEqual(['src/generated/keep.ts']);
    expect(paths(after.files)).toEqual(['src/generated/keep.ts']);
  });

  it('leaves exclusions intact when a negation matches nothing', () => {
    const r = filterReviewableFiles([f('src/legacy/big.ts'), f('src/app.ts')], ['src/legacy/**', '!src/nothing/**']);
    expect(paths(r.files)).toEqual(['src/app.ts']);
  });

  it('never excludes every file, since a diff of only generated code still deserves a verdict', () => {
    const r = filterReviewableFiles([f('package-lock.json'), f('yarn.lock')]);
    expect(r.files.length + r.skipped.length).toBe(2);
  });
});

describe('planDiffPasses — a large diff is reviewed in several passes rather than partly', () => {
  it('uses a single pass when the diff fits', () => {
    const plan = planDiffPasses([f('a.ts', 100), f('b.ts', 100)], 10_000, 3);
    expect(plan.passes).toHaveLength(1);
    expect(plan.omitted).toEqual([]);
  });

  it('splits across passes so nothing is omitted', () => {
    const files = Array.from({ length: 6 }, (_, i) => f(`f${i}.ts`, 4_000));
    const plan = planDiffPasses(files, 10_000, 3);
    expect(plan.passes.length).toBeGreaterThan(1);
    const seen = plan.passes.flat().map((x: any) => x.path);
    expect(seen).toHaveLength(6);
    expect(plan.omitted).toEqual([]);
  });

  it('never exceeds the pass limit, and discloses what that costs', () => {
    const files = Array.from({ length: 100 }, (_, i) => f(`f${i}.ts`, 9_000));
    const plan = planDiffPasses(files, 10_000, 2);
    expect(plan.passes).toHaveLength(2);
    expect(plan.omitted.length).toBeGreaterThan(0);
  });

  it('keeps an oversized single file in a pass of its own rather than dropping it', () => {
    const plan = planDiffPasses([f('huge.ts', 80_000), f('small.ts', 50)], 10_000, 3);
    const seen = plan.passes.flat().map((x: any) => x.path);
    expect(seen).toContain('huge.ts');
    expect(seen).toContain('small.ts');
  });

  it('reports how many passes each reviewer will make, since that multiplies cost', () => {
    const files = Array.from({ length: 6 }, (_, i) => f(`f${i}.ts`, 4_000));
    expect(planDiffPasses(files, 10_000, 3).passes.length).toBe(3);
  });
});

describe('mergeFindings — results from several passes read as one review', () => {
  const a = { severity: 'P1', path: 'a.ts', line: 1, title: 'Same', body: 'b' };
  const b = { severity: 'P2', path: 'b.ts', line: 9, title: 'Other', body: 'b' };

  it('concatenates findings across passes', () => {
    expect(mergeFindings([[a], [b]])).toHaveLength(2);
  });

  it('collapses the same finding reported in more than one pass', () => {
    expect(mergeFindings([[a], [{ ...a }]])).toHaveLength(1);
  });

  it('keeps the higher severity when a duplicate disagrees', () => {
    const merged = mergeFindings([[{ ...a, severity: 'P2' }], [{ ...a, severity: 'P0' }]]);
    expect(merged).toHaveLength(1);
    expect(merged[0].severity).toBe('P0');
  });

  it('handles empty passes', () => {
    expect(mergeFindings([[], []])).toEqual([]);
  });
});
