import { describe, expect, it } from 'vitest';
import { filterDiffHunks } from '../../src/pipeline/hunkFilter';
import { TokenBudgetManager, evaluateEffortAndBudget } from '../../src/pipeline/tokenBudgetManager';

describe('Milestone 30: Token Budget Optimization', () => {
  it('filters noise, lockfiles, and generated minified code from diff hunks', () => {
    const rawHunks = [
      { path: 'package-lock.json', patch: '@@ -1,5 +1,5 @@ ...' },
      { path: 'dist/bundle.js', patch: '@@ -1,100 +1,100 @@ ...' },
      { path: 'src/app.ts', patch: '@@ -10,5 +10,12 @@ const app = express();' },
    ];

    const filterResult = filterDiffHunks(rawHunks);
    const includedFiles = filterResult.files.filter((f) => f.status === 'included');
    expect(includedFiles.length).toBe(1);
    expect(includedFiles[0].path).toBe('src/app.ts');
    expect(filterResult.stats.ignoredFilesCount).toBe(2);
  });

  it('scales effort levels low, medium, and high to adjust token budget allocations', () => {
    const budgetManager = new TokenBudgetManager();

    const lowBudget = budgetManager.calculateBudget({ effortLevel: 'low', diffLineCount: 500 });
    const medBudget = budgetManager.calculateBudget({ effortLevel: 'medium', diffLineCount: 500 });
    const highBudget = budgetManager.calculateBudget({ effortLevel: 'high', diffLineCount: 500 });

    expect(lowBudget.maxTokens).toBeLessThan(medBudget.maxTokens);
    expect(medBudget.maxTokens).toBeLessThan(highBudget.maxTokens);
    expect(lowBudget.effortTier).toBe('low');
    expect(highBudget.effortTier).toBe('high');
  });

  it('evaluates effort and budget dynamically based on changed files and sensitivity', () => {
    const normalFiles = [{ path: 'src/components/Header.tsx', patch: 'const Header = () => null;' }];
    const sensitiveFiles = [{ path: 'src/auth/login.ts', patch: 'function login() {}' }];

    const normalBudget = evaluateEffortAndBudget(normalFiles);
    const sensitiveBudget = evaluateEffortAndBudget(sensitiveFiles);

    expect(normalBudget.effortTier).toBe('low');
    expect(sensitiveBudget.effortTier).toBe('high');
  });

  it('ignores non-finite releases without poisoning the reservation', () => {
    const budgetManager = new TokenBudgetManager();
    expect(budgetManager.reserve('run-1', 10, 10)).toBe(true);
    budgetManager.release('run-1', Number.NaN);
    expect(budgetManager.reserved('run-1')).toBe(10);
    expect(budgetManager.reserve('run-1', 1, 10)).toBe(false);
  });
});
