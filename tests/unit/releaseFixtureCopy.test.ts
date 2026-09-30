import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createScratchOwner, requiredSuiteScratchRoot } from '../support/scratch-lifecycle';
import {
  copyReleaseCommitFixture,
  RELEASE_FIXTURE_EXCLUDED_ROOTS,
} from '../support/release-fixture-copy';

describe('immutable release fixture copy', () => {
  it('rejects a nonempty destination without modifying its retained files', () => {
    const owner = createScratchOwner({ parentDir: requiredSuiteScratchRoot(),
      prefix: 'yeti-release-destination-', kind: 'release-fixture-test' });
    try {
      fs.writeFileSync(path.join(owner.path, 'keep'), 'retained');
      expect(() => copyReleaseCommitFixture(process.cwd(), owner.path, 'HEAD')).toThrow(/must be empty/);
      expect(fs.readFileSync(path.join(owner.path, 'keep'), 'utf8')).toBe('retained');
    } finally { owner.cleanup(); }
  });
  it('archives the selected commit and excludes tracked workstation/runtime trees', () => {
    const owner = createScratchOwner({
      parentDir: requiredSuiteScratchRoot(),
      prefix: 'yeti-release-copy-proof-',
      kind: 'release-fixture-test',
    });
    const source = path.join(owner.path, 'source');
    const destination = path.join(owner.path, 'archive');
    try {
      fs.mkdirSync(path.join(source, 'src'), { recursive: true });
      fs.writeFileSync(path.join(source, 'README.md'), 'commit version\n');
      fs.writeFileSync(path.join(source, 'src', 'kept.ts'), 'export const kept = true;\n');
      for (const root of RELEASE_FIXTURE_EXCLUDED_ROOTS) {
        const directory = path.join(source, root);
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, 'local-evidence.txt'), root);
      }
      fs.mkdirSync(path.join(source, 'fixtures/tmp'), { recursive: true });
      fs.writeFileSync(path.join(source, 'fixtures/tmp', 'leftover.txt'), 'local fixture output');

      execFileSync('git', ['init', '-q'], { cwd: source });
      execFileSync('git', ['config', 'user.name', 'Review Yeti Fixture'], { cwd: source });
      execFileSync('git', ['config', 'user.email', 'review-yeti-fixture@example.invalid'], { cwd: source });
      execFileSync('git', ['add', '--all'], { cwd: source });
      execFileSync('git', ['commit', '-q', '-m', 'fixture source'], { cwd: source });
      const expectedSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();

      fs.writeFileSync(path.join(source, 'README.md'), 'modified working tree\n');
      fs.writeFileSync(path.join(source, 'untracked.txt'), 'not in the commit');

      expect(copyReleaseCommitFixture(source, destination, expectedSha)).toBe(expectedSha);
      expect(fs.readFileSync(path.join(destination, 'README.md'), 'utf8')).toBe('commit version\n');
      expect(fs.readFileSync(path.join(destination, 'src', 'kept.ts'), 'utf8')).toContain('kept');
      expect(fs.existsSync(path.join(destination, 'untracked.txt'))).toBe(false);
      for (const root of RELEASE_FIXTURE_EXCLUDED_ROOTS) {
        expect(fs.existsSync(path.join(destination, root)), `${root} must be excluded even when tracked`).toBe(false);
      }
      expect(fs.existsSync(path.join(destination, 'fixtures/tmp'))).toBe(false);
    } finally {
      owner.cleanup();
    }
  });
});
