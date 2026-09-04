import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

/**
 * REL-570. `npm run lint` was `tsc --noEmit` against a tsconfig that excluded `tests/`, so it
 * reported a clean tree while two test files were syntactically broken and collecting zero tests.
 * Only the full CI suite caught that, minutes later.
 *
 * That exclusion is now gone: all 464 type errors across 101 test files were burned down and
 * `tests/` is typechecked like everything else. These assertions keep both halves of the gate
 * from quietly regressing -- the exclusion must not come back, and the collection check must
 * keep running, because tsc proves a file *typechecks* while `vitest list` proves it can
 * actually be *collected* (a file can typecheck and still throw at import time).
 */
describe('lint covers test files (REL-570)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

  it('runs a test-file gate as part of lint, not just tsc over src', () => {
    expect(pkg.scripts.lint).toContain('lint:tests');
    expect(pkg.scripts['lint:tests']).toBeTruthy();
    expect(pkg.scripts['lint:src']).toContain('tsc --noEmit');
  });

  it('keeps the gate pointed at a script that actually collects every test file', () => {
    const script = pkg.scripts['lint:tests'];
    expect(script).toContain('check-test-files-parse');
    const checker = fs.readFileSync(path.join(root, 'scripts/check-test-files-parse.mjs'), 'utf8');
    // `vitest list` parses and resolves every file without executing a test. `--filesOnly` only
    // globs the filesystem and would pass on a file that cannot be parsed at all.
    expect(checker).toContain("'list'");
    expect(checker).not.toContain('--filesOnly');
    // It must fail the build, not merely report.
    expect(checker).toMatch(/process\.exit\(/u);
  });

  it('typechecks tests rather than excluding them', () => {
    const tsconfig = JSON.parse(fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8'));
    // The whole point of REL-570. If this ever reappears, 464 errors can silently accumulate again.
    expect(tsconfig.exclude).not.toContain('tests');
    expect(tsconfig.include.some((p: string) => p.includes('**/*.ts'))).toBe(true);
  });
});
