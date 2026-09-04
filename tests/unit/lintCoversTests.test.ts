import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

/**
 * REL-570. `npm run lint` was `tsc --noEmit` against a tsconfig that excludes `tests/`, so it
 * reported a clean tree while two test files were syntactically broken and collecting zero tests.
 * Only the full CI suite caught that, minutes later.
 *
 * These assertions keep `lint` honest about test files. They deliberately do NOT require tsc to
 * typecheck tests: doing that today surfaces 465 errors (275 with `strict` off), tracked
 * separately. What must not regress is that *some* gate proves every test file still parses.
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

  it('documents why tsc still excludes tests, so the exclusion is a decision and not an accident', () => {
    const tsconfig = JSON.parse(fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8'));
    expect(tsconfig.exclude).toContain('tests');
    const checker = fs.readFileSync(path.join(root, 'scripts/check-test-files-parse.mjs'), 'utf8');
    expect(checker).toMatch(/excludes `tests\/`/u);
  });
});
