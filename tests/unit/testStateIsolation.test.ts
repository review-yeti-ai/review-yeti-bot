import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanupSuiteStoreFile, createScratchOwner, isInsideSuiteRoot, readScratchOwnerMetadata } from '../support/scratch-lifecycle';
import { resetAllGlobalState } from '../setup';

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
  const isolatedVars = ['CT_REVIEW_RUN_STORE', 'REVIEW_YETI_DASHBOARD_STORE', 'CT_REVIEW_DATA_DIR'] as const;

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

  it('removes an inside store while preserving outside and prefix-sharing sibling files', () => {
    const parent = createScratchOwner({ parentDir: process.env.CT_REVIEW_DATA_DIR,
      prefix: 'yeti-store-boundary-', kind: 'test-fixture' });
    const suite = createScratchOwner({ parentDir: parent.path, prefix: 'suite-', kind: 'test-fixture' });
    try {
      const inside = path.join(suite.path, 'store.json');
      const outside = path.join(parent.path, 'outside.json');
      const sibling = `${suite.path}-other`;
      fs.mkdirSync(sibling);
      const siblingStore = path.join(sibling, 'store.json');
      for (const file of [inside, outside, siblingStore]) fs.writeFileSync(file, '{}');
      expect(isInsideSuiteRoot(inside, suite.path)).toBe(true);
      expect(isInsideSuiteRoot(suite.path, suite.path)).toBe(false);
      expect(isInsideSuiteRoot('relative.json', suite.path)).toBe(false);
      expect(isInsideSuiteRoot(inside, 'relative-root')).toBe(false);
      expect(cleanupSuiteStoreFile(inside, suite.path)).toBe(true);
      expect(cleanupSuiteStoreFile(inside, suite.path)).toBe(false);
      expect(cleanupSuiteStoreFile(undefined, suite.path)).toBe(false);
      for (const file of [outside, siblingStore]) {
        expect(isInsideSuiteRoot(file, suite.path)).toBe(false);
        expect(cleanupSuiteStoreFile(file, suite.path)).toBe(false);
        expect(fs.readFileSync(file, 'utf8')).toBe('{}');
      }
      fs.symlinkSync(parent.path, path.join(suite.path, 'escape'), 'dir');
      expect(cleanupSuiteStoreFile(path.join(suite.path, 'escape', 'outside.json'), suite.path)).toBe(false);
      expect(fs.existsSync(outside)).toBe(true);
    } finally { suite.cleanup(); parent.cleanup(); }
  });

  it('retires the prior store through the actual reset hook', () => {
    const priorStore = process.env.REVIEW_YETI_DASHBOARD_STORE!;
    fs.writeFileSync(priorStore, '{}');
    expect(fs.existsSync(priorStore)).toBe(true);
    resetAllGlobalState();
    expect(fs.existsSync(priorStore)).toBe(false);
    expect(process.env.REVIEW_YETI_DASHBOARD_STORE).not.toBe(priorStore);
  });
});
