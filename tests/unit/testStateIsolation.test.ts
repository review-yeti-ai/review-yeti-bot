import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * REL-560. Every on-disk root a test can write to must live in this worker's own disposable
 * directory, not in the shared `/tmp/ct-review-bot`.
 *
 * Two real bugs motivated this, both invisible in CI because a fresh runner starts with an empty
 * /tmp:
 *
 *  - `CT_REVIEW_RUN_STORE` was never set, so ReviewRunStore fell back to a single
 *    `/tmp/ct-review-bot/review-runs.json` shared by every test file and *persisted across runs*,
 *    accumulating deliveries/heads/previousHeads/threads that later runs then read.
 *  - The per-test store reassignment only ever unlinked the previous path, so the last store of
 *    every worker survived forever: 374,719 files and 17 GB on one developer machine.
 */
describe('worker test-state isolation (REL-560)', () => {
  const isolatedVars = ['CT_REVIEW_RUN_STORE', 'CT_DASHBOARD_STORE', 'CT_REVIEW_DATA_DIR'] as const;

  it('points every writable state root at this worker, never the shared directory', () => {
    for (const name of isolatedVars) {
      const value = process.env[name];
      expect(value, `${name} must be set by tests/setup.ts`).toBeTruthy();
      expect(value, `${name} must not use the shared /tmp/ct-review-bot root`)
        .not.toMatch(/^\/tmp\/ct-review-bot(\/|$)/u);
      expect(path.isAbsolute(value!)).toBe(true);
    }
  });

  it('roots them all in one directory under the OS temp dir, so it can be removed on exit', () => {
    const roots = isolatedVars.map((name) => process.env[name]!);
    const dataDir = process.env.CT_REVIEW_DATA_DIR!;
    // The data dir IS the worker root; the other two live inside it.
    expect(dataDir.startsWith(fs.realpathSync(os.tmpdir())) || dataDir.startsWith(os.tmpdir())).toBe(true);
    for (const root of roots) {
      expect(root.startsWith(dataDir)).toBe(true);
    }
    expect(fs.existsSync(dataDir)).toBe(true);
  });

  it('keeps the per-test store cleanup anchored to a prefix that matches on every platform', () => {
    // The guard used to be `startsWith('/tmp/')`, which never matches on macOS because
    // os.tmpdir() is /var/folders/..., so the cleanup silently did nothing there.
    const setup = fs.readFileSync(path.join(process.cwd(), 'tests/setup.ts'), 'utf8');
    expect(setup).not.toContain("CT_DASHBOARD_STORE.startsWith('/tmp/')");
    expect(setup).toContain('workerStateRoot');
  });
});
