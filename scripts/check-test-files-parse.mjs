#!/usr/bin/env node
/**
 * Prove every test file parses and its imports resolve (REL-570).
 *
 * `npm run lint` is `tsc --noEmit`, and tsconfig.json excludes `tests/`, so no test file has ever
 * been checked by it. That is not an oversight to flip on casually -- including tests today
 * produces 465 errors under the project's settings, 275 even with `strict` off -- but it did mean
 * `npm run lint` reported a clean tree while two test files were syntactically broken and silently
 * collected zero tests. Only the full CI suite caught it, minutes later.
 *
 * `vitest list` collects every test file without executing a single test: it parses each one and
 * resolves its imports, in about 20 seconds across the whole suite. That catches the entire class
 * of "this file no longer runs at all" -- broken syntax, a bad import path, a missing module --
 * which is the failure that actually costs a CI cycle, without waiting on the 465-error type
 * backlog tracked separately.
 */
import { spawnSync } from 'node:child_process';

const result = spawnSync(
  'npx',
  ['vitest', 'list', '--silent'],
  { stdio: ['ignore', 'ignore', 'inherit'], shell: false },
);

if (result.error) {
  console.error(`[check-test-files-parse] could not run vitest list: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error('[check-test-files-parse] at least one test file failed to parse or resolve its imports (see above).');
  process.exit(result.status ?? 1);
}
console.log('[check-test-files-parse] every test file parses and resolves.');
