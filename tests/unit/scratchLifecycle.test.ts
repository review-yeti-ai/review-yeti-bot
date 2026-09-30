import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  closeResourcesAndCleanupScratch,
  cleanupScratchOwner,
  createScratchOwner,
  readScratchOwnerMetadata,
} from '../support/scratch-lifecycle';

function createTestOwner(prefix: string, kind: string) {
  return createScratchOwner({
    parentDir: process.env.CT_REVIEW_DATA_DIR ?? os.tmpdir(),
    prefix,
    kind,
  });
}

describe('owned test scratch lifecycle (REL-1209)', () => {
  it('rejects invalid labels and unknown owners before mutation', async () => {
    expect(() => createTestOwner('../unsafe-', 'vitest-suite')).toThrow(/simple directory prefix/);
    expect(() => createTestOwner('valid-', '../unsafe')).toThrow(/simple label/);
    expect(() => cleanupScratchOwner({} as any)).toThrow(/requires an owner/);
  });

  it('holds malformed and non-regular ownership manifests', () => {
    const owner = createTestOwner('yeti-invalid-metadata-', 'vitest-suite');
    const originalPath = `${owner.manifestPath}.original`;
    fs.renameSync(owner.manifestPath, originalPath);
    try {
      fs.writeFileSync(owner.manifestPath, '{}');
      expect(() => readScratchOwnerMetadata(owner.path)).toThrow(/Invalid.*manifest/);
      fs.rmSync(owner.manifestPath);
      fs.mkdirSync(owner.manifestPath);
      expect(() => readScratchOwnerMetadata(owner.path)).toThrow(/non-regular/);
    } finally {
      fs.rmSync(owner.manifestPath, { recursive: true });
      fs.renameSync(originalPath, owner.manifestPath);
      owner.cleanup();
    }
  });

  it('holds a run with unowned files or mismatched child ownership', () => {
    const run = createTestOwner('yeti-unowned-run-', 'vitest-run');
    const file = path.join(run.path, 'unowned.txt');
    let child;
    try {
      fs.writeFileSync(file, 'keep');
      expect(() => run.cleanup()).toThrow(/unowned child entry/);
      fs.unlinkSync(file);
      child = createScratchOwner({ parentDir: run.path, prefix: 'wrong-kind-', kind: 'other' });
      expect(() => run.cleanup()).toThrow(/unowned child directory/);
    } finally {
      child?.cleanup();
      run.cleanup();
    }
  });

  it('treats an already removed exact owned root as retired', () => {
    const owner = createTestOwner('yeti-removed-proof-', 'test-fixture');
    fs.rmSync(owner.path, { recursive: true });
    expect(() => owner.cleanup()).not.toThrow();
    expect(() => owner.cleanup()).not.toThrow();
  });

  it('closes all resources and retires only after successful close', async () => {
    const owner = createTestOwner('yeti-close-success-', 'test-fixture');
    await closeResourcesAndCleanupScratch(owner, [() => {
      expect(fs.existsSync(owner.path)).toBe(true);
    }]);
    expect(fs.existsSync(owner.path)).toBe(false);
  });
  it('records PID and process-start identity for hard-kill attribution', () => {
    const owner = createTestOwner('yeti-owner-proof-', 'vitest-suite');
    try {
      const metadata = readScratchOwnerMetadata(owner.path);
      expect(metadata).toMatchObject({
        schema: 'review-yeti-scratch-owner.v1',
        ownerId: owner.metadata.ownerId,
        kind: 'vitest-suite',
        pid: process.pid,
        processStartId: expect.any(String),
        processStartedAt: expect.any(String),
        rootName: path.basename(owner.path),
        runId: owner.metadata.runId,
      });
      expect(metadata.createdAt).toEqual(expect.any(String));
    } finally {
      owner.cleanup();
    }
  });

  it('removes only its exact directory and does not follow a symlink to an external path', () => {
    const external = createTestOwner('yeti-external-proof-', 'external-fixture');
    const owner = createTestOwner('yeti-owned-proof-', 'vitest-suite');
    const sentinel = path.join(external.path, 'keep.txt');
    try {
      fs.writeFileSync(sentinel, 'outside the owned scratch root');
      fs.symlinkSync(external.path, path.join(owner.path, 'external-link'), 'dir');

      owner.cleanup();

      expect(fs.existsSync(owner.path)).toBe(false);
      expect(fs.readFileSync(sentinel, 'utf8')).toBe('outside the owned scratch root');
    } finally {
      owner.cleanup();
      external.cleanup();
    }
  });

  it('refuses cleanup when the ownership manifest no longer matches', () => {
    const owner = createTestOwner('yeti-mismatch-proof-', 'vitest-suite');
    const originalManifest = fs.readFileSync(owner.manifestPath, 'utf8');
    try {
      const altered = { ...JSON.parse(originalManifest), ownerId: 'not-the-created-owner' };
      fs.writeFileSync(owner.manifestPath, `${JSON.stringify(altered)}\n`);

      expect(() => owner.cleanup()).toThrow(/replaced ownership manifest/u);
      expect(fs.existsSync(owner.path)).toBe(true);
    } finally {
      fs.writeFileSync(owner.manifestPath, originalManifest, { mode: 0o600 });
      owner.cleanup();
    }
  });

  it('refuses a byte-identical replacement ownership manifest', () => {
    const owner = createTestOwner('yeti-manifest-inode-proof-', 'vitest-suite');
    const savedManifest = `${owner.manifestPath}.saved`;
    try {
      fs.renameSync(owner.manifestPath, savedManifest);
      fs.copyFileSync(savedManifest, owner.manifestPath);

      expect(() => owner.cleanup()).toThrow(/replaced ownership manifest/u);
    } finally {
      if (fs.existsSync(owner.manifestPath)) fs.rmSync(owner.manifestPath, { force: false });
      if (fs.existsSync(savedManifest)) fs.renameSync(savedManifest, owner.manifestPath);
      owner.cleanup();
    }
  });

  it('refuses cleanup when the original parent directory is replaced', () => {
    const parent = createTestOwner('yeti-parent-proof-', 'test-fixture');
    const owner = createScratchOwner({
      parentDir: parent.path,
      prefix: 'yeti-child-proof-',
      kind: 'vitest-suite',
    });
    const originalParent = `${parent.path}.original`;
    try {
      fs.renameSync(parent.path, originalParent);
      fs.mkdirSync(parent.path);

      expect(() => owner.cleanup()).toThrow(/parent identity changed/u);
      expect(fs.existsSync(originalParent)).toBe(true);
    } finally {
      if (fs.existsSync(parent.path)) fs.rmSync(parent.path, { recursive: true, force: false });
      if (fs.existsSync(originalParent)) fs.renameSync(originalParent, parent.path);
      owner.cleanup();
      parent.cleanup();
    }
  });

  it('refuses a replacement root even when it contains a byte-for-byte copy of the original manifest', () => {
    const owner = createTestOwner('yeti-root-replacement-proof-', 'vitest-suite');
    const originalPath = `${owner.path}.original`;
    try {
      fs.renameSync(owner.path, originalPath);
      fs.mkdirSync(owner.path);
      fs.copyFileSync(path.join(originalPath, path.basename(owner.manifestPath)), owner.manifestPath);

      expect(() => owner.cleanup()).toThrow(/no longer its owned directory/u);
      expect(fs.existsSync(owner.path)).toBe(true);
      expect(fs.existsSync(originalPath)).toBe(true);
    } finally {
      if (fs.existsSync(owner.path)) fs.rmSync(owner.path, { recursive: true, force: false });
      if (fs.existsSync(originalPath)) fs.renameSync(originalPath, owner.path);
      owner.cleanup();
    }
  });

  it('holds run scratch while an owned suite PID is alive', () => {
    const run = createTestOwner('yeti-run-liveness-proof-', 'vitest-run');
    const suite = createScratchOwner({
      parentDir: run.path,
      prefix: 'yeti-suite-liveness-proof-',
      kind: 'vitest-suite',
    });
    try {
      expect(() => run.cleanup()).toThrow(/is still alive/u);
      expect(fs.existsSync(run.path)).toBe(true);
      expect(fs.existsSync(suite.path)).toBe(true);
    } finally {
      suite.cleanup();
      run.cleanup();
    }
  });

  it('closes resources before deleting scratch and holds the root when a close fails', async () => {
    const owner = createTestOwner('yeti-close-order-proof-', 'vitest-suite');
    const order: string[] = [];
    try {
      await expect(closeResourcesAndCleanupScratch(owner, [
        () => {
          expect(fs.existsSync(owner.path)).toBe(true);
          order.push('close-first');
        },
        () => {
          order.push('close-failing');
          throw new Error('resource close failed');
        },
        () => {
          order.push('close-last');
        },
      ])).rejects.toThrow(/Resource close failed; retaining owned scratch/u);

      expect(order).toEqual(['close-first', 'close-failing', 'close-last']);
      expect(fs.existsSync(owner.path)).toBe(true);
    } finally {
      owner.cleanup();
    }
  });

  it.skipIf(process.env.CT_REL1209_FAILURE_PROBE !== '1')(
    'failure cleanup integration probe',
    () => {
      const marker = process.env.CT_REL1209_PROBE_MARKER;
      if (!marker) throw new Error('CT_REL1209_PROBE_MARKER is required for the failure probe');
      fs.writeFileSync(marker, JSON.stringify({
        pid: process.pid,
        suiteRoot: process.env.CT_REVIEW_DATA_DIR,
        runRoot: process.env.CT_REVIEW_TEST_SCRATCH_ROOT,
      }));
      expect('intentional failure probe').toBe('passing assertion');
    },
  );

  it.skipIf(process.env.CT_REL1209_CANCEL_PROBE !== '1')(
    'active worker cancellation integration probe',
    async () => {
      const marker = process.env.CT_REL1209_PROBE_MARKER;
      if (!marker) throw new Error('CT_REL1209_PROBE_MARKER is required for the cancellation probe');
      fs.writeFileSync(marker, JSON.stringify({
        pid: process.pid,
        processStartId: readScratchOwnerMetadata(process.env.CT_REVIEW_DATA_DIR!).processStartId,
        suiteRoot: process.env.CT_REVIEW_DATA_DIR,
        runRoot: process.env.CT_REVIEW_TEST_SCRATCH_ROOT,
      }));
      await new Promise<void>(() => {});
    },
    60_000,
  );
});
