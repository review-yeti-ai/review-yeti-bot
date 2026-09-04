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

  it('typechecks scripts rather than excluding them', () => {
    const tsconfig = JSON.parse(fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8'));
    // REL-573: `scripts/` was excluded alongside `tests/`. Including it immediately exposed
    // scripts/publish-real-diff-review.ts importing from '../src/quorum/quorumEngine' -- a module
    // that does not exist anywhere in the tree, so the script could never have loaded.
    expect(tsconfig.exclude).not.toContain('scripts');
  });

  it('keeps skipLibCheck on, as a recorded decision rather than an accident', () => {
    const tsconfig = JSON.parse(fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8'));
    // Measured with skipLibCheck: false -> 17 errors, ALL of them inside node_modules, none in
    // our own code:
    //   * 9 from vitest/@vitest -- `Cannot find module 'vite'`. vite 8 ships its types through an
    //     `exports` map, which `moduleResolution: "node"` (Node10) cannot read. Fixing this means
    //     migrating moduleResolution to bundler/nodenext, which also forces `module` off CommonJS.
    //     That is a real migration, not a flag flip.
    //   * 4 from next -- HeadersAdapter is not assignable to Headers. Upstream Next.js bug.
    //   * 1 from immer -- global `Iterator` declaration conflict with the TS lib.
    //   * 2 from @testing-library/jest-dom, 1 from isomorphic-ws -- fixable, but pointless alone.
    //
    // It is worth re-testing after a moduleResolution migration. It does NOT hide anything in our
    // own source: the `AbortSignal | null` collapse once blamed on it is a TypeScript narrowing
    // rule (`let x: T | null = null` narrows to `null`), reproducible with skipLibCheck either
    // way, and fixed properly by asserting the type on the initializer.
    expect(tsconfig.compilerOptions.skipLibCheck).toBe(true);
  });

  it('typechecks tests rather than excluding them', () => {
    const tsconfig = JSON.parse(fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8'));
    // The whole point of REL-570. If this ever reappears, 464 errors can silently accumulate again.
    expect(tsconfig.exclude).not.toContain('tests');
    expect(tsconfig.include.some((p: string) => p.includes('**/*.ts'))).toBe(true);
  });
});
