import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import os from 'node:os';
import type { TestProject } from 'vitest/node';
import { createScratchOwner, ScratchChildrenLiveError } from './support/scratch-lifecycle';

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
export default function setup(project: TestProject) {
  const runScratch = createScratchOwner({
    parentDir: process.env.CT_REVIEW_TEST_SCRATCH_PARENT || os.tmpdir(),
    prefix: `ct-review-yeti-run-${process.pid}-`,
    kind: 'vitest-run',
  });
  const previousScratchRoot = process.env.CT_REVIEW_TEST_SCRATCH_ROOT;
  process.env.CT_REVIEW_TEST_SCRATCH_ROOT = runScratch.path;
  let cleaned = false;

  const teardown = () => {
    if (cleaned) return;
    try {
      runScratch.cleanup();
      cleaned = true;
    } finally {
      if (previousScratchRoot === undefined) delete process.env.CT_REVIEW_TEST_SCRATCH_ROOT;
      else process.env.CT_REVIEW_TEST_SCRATCH_ROOT = previousScratchRoot;
    }
  };

  // Vitest 4 invokes global teardown BEFORE pool.close(). onClose handlers run
  // alongside pool.close(), so wait for the exact suite PIDs to become terminal
  // before retiring collection-only leftovers. Identity/unknown errors do not
  // retry or become deletion authority. Watch roots live until the run closes.
  project.vitest.onClose(async () => {
    const deadline = Date.now() + 30_000;
    while (!cleaned) {
      try { teardown(); }
      catch (error) {
        if (!(error instanceof ScratchChildrenLiveError) || Date.now() >= deadline) {
          process.exitCode = 1; // Vitest logs close-hook errors; make CLI failure observable too.
          throw error;
        }
        await new Promise((done) => setTimeout(done, 25));
      }
    }
  });

  try {
    execFileSync(process.execPath, ['scripts/ensure-pipeline-build.js'], {
      cwd: repoRoot,
      stdio: 'inherit',
    });
  } catch (setupError) {
    try {
      teardown();
    } catch (cleanupError) {
      throw new AggregateError([setupError, cleanupError], 'Vitest setup and scratch cleanup both failed');
    }
    throw setupError;
  }

  // Signal/exit handlers never recursively remove the run root. Abrupt CLI
  // termination may skip close hooks; attributable leftovers require owner
  // reconciliation, not prefix/age-based automatic deletion.
}
