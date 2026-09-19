import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * `providers.generated.ts` says "AUTO-GENERATED FILE - DO NOT MODIFY DIRECTLY". For a long time
 * that instruction was a trap: the checked-in file was NOT what the generator produced, so anyone
 * who followed the header silently regressed four provider defaults --
 *
 *   openai    openai/gpt-5.6-luna:high        -> gpt-4o
 *   anthropic claude-5-haiku:high             -> claude-3-5-sonnet
 *   gemini    google/gemini-3.7-flash:high    -> gemini-1.5-pro
 *   deepseek  deepseek/deepseek-v4-flash-0731 -> deepseek-v3
 *
 * -- four lines in a sixty-line diff, none obviously wrong in isolation. It was caught by a code
 * review, not by any check.
 *
 * A generated file nobody can safely regenerate is not generated; it is hand-maintained with a
 * misleading header. This test makes the header true.
 */
describe('providers.generated.ts is in sync with its generator', () => {
  const root = path.resolve(__dirname, '../..');
  const generated = path.join(root, 'src/types/providers.generated.ts');

  it('regenerating produces no diff', () => {
    const before = fs.readFileSync(generated, 'utf8');
    try {
      execFileSync('npx', ['ts-node', '--transpile-only', 'scripts/generate-omniroute-providers.ts'], {
        cwd: root, encoding: 'utf8', stdio: 'pipe',
      });
      const after = fs.readFileSync(generated, 'utf8');
      // Restore before asserting, so a failure never leaves the tree dirty.
      if (after !== before) fs.writeFileSync(generated, before, 'utf8');
      expect(after).toBe(before);
    } catch (error: any) {
      fs.writeFileSync(generated, before, 'utf8');
      throw error;
    }
  }, 120_000);
});
