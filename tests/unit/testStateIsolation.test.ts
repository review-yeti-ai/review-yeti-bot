import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readScratchOwnerMetadata } from '../support/scratch-lifecycle';

/**
 * REL-560 / REL-1209. Every on-disk root a test can write to must live in this test file's suite
 * directory under the current run owner, not in the shared `/tmp/ct-review-bot`.
 *
 * Two real bugs motivated this, both invisible in CI because a fresh runner starts with an empty
 * /tmp:
 *
 *  - `CT_REVIEW_RUN_STORE` was never set, so ReviewRunStore fell back to a single
 *    `/tmp/ct-review-bot/review-runs.json` shared by every test file and *persisted across runs*,
 *    accumulating deliveries/heads/previousHeads/threads that later runs then read.
 *  - The per-test store reassignment only ever unlinked the previous path, so the last store of
 *    every test-file suite survived forever: 374,719 files and 17 GB on one developer machine.
 */
describe('per-suite test-state isolation (REL-560 / REL-1209)', () => {
  const isolatedVars = ['CT_REVIEW_RUN_STORE', 'CT_DASHBOARD_STORE', 'CT_REVIEW_DATA_DIR'] as const;

  it('points every writable state root at this test file suite, never the shared directory', () => {
    for (const name of isolatedVars) {
      const value = process.env[name];
      expect(value, `${name} must be set by tests/setup.ts`).toBeTruthy();
      expect(value, `${name} must not use the shared /tmp/ct-review-bot root`)
        .not.toMatch(/^\/tmp\/ct-review-bot(\/|$)/u);
      expect(path.isAbsolute(value!)).toBe(true);
    }
  });

  it('roots them in one suite directory under the configured run owner', () => {
    const roots = isolatedVars.map((name) => process.env[name]!);
    const dataDir = process.env.CT_REVIEW_DATA_DIR!;
    const runRoot = process.env.CT_REVIEW_TEST_SCRATCH_ROOT!;
    const configuredParent = process.env.CT_REVIEW_TEST_SCRATCH_PARENT || os.tmpdir();
    // The data dir IS this test file's suite root; the other two live inside it.
    expect(path.dirname(dataDir)).toBe(runRoot);
    expect(path.dirname(runRoot)).toBe(fs.realpathSync(configuredParent));
    for (const root of roots) {
      expect(root.startsWith(dataDir)).toBe(true);
    }
    expect(fs.existsSync(dataDir)).toBe(true);
  });

  it('nests the suite root under the run owner with matching attribution', () => {
    const dataDir = process.env.CT_REVIEW_DATA_DIR!;
    const runRoot = process.env.CT_REVIEW_TEST_SCRATCH_ROOT!;
    const suiteMetadata = readScratchOwnerMetadata(dataDir);
    const runMetadata = readScratchOwnerMetadata(runRoot);

    expect(path.dirname(dataDir)).toBe(runRoot);
    expect(suiteMetadata.parentOwnerId).toBe(runMetadata.ownerId);
    expect(suiteMetadata.runId).toBe(runMetadata.runId);
  });

  it('keeps the per-test store cleanup anchored to a prefix that matches on every platform', () => {
    // The guard used to be `startsWith('/tmp/')`, which never matches on macOS because
    // os.tmpdir() is /var/folders/..., so the cleanup silently did nothing there.
    const setup = fs.readFileSync(path.join(process.cwd(), 'tests/setup.ts'), 'utf8');
    expect(setup).not.toContain("CT_DASHBOARD_STORE.startsWith('/tmp/')");
    expect(setup).toContain('suiteStateRoot');
  });
});
