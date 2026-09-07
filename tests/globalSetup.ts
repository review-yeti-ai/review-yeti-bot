import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Guarantees the compiled pipeline modules before any test runs.
 *
 * `npm test` already does this through the `pretest` hook, but npm lifecycle hooks
 * only fire for `npm test` -- `npx vitest`, an IDE runner, or a watch process all
 * skip them. Without `dist/pipeline`, `review-pipeline.js` resolves its inner
 * requires to nothing and silently leaves the modules `null`, so the cassette
 * replay tests compare different request bytes and four unrelated-looking tests
 * fail. Nothing about that failure points at a missing build.
 *
 * `ensure-pipeline-build.js` is idempotent and costs ~50ms when `dist/` is
 * current, so running it here makes the suite correct regardless of how it was
 * invoked rather than relying on the caller to know.
 */
export default function setup() {
  execFileSync(process.execPath, ['scripts/ensure-pipeline-build.js'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
}
