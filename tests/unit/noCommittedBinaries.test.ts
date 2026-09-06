import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');

function tracked(): Array<{ path: string; bytes: number }> {
  return execFileSync('git', ['ls-tree', '-r', '-l', 'HEAD'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [, , , size, file] = line.split(/\s+/u);
      return { path: file, bytes: Number(size) };
    })
    .filter((entry) => Number.isFinite(entry.bytes));
}

/**
 * This repository is public, and compiled artefacts do not belong in it.
 *
 * A 30 MB `k8s-operator/bin/manager` was committed once. It was a macOS arm64
 * executable -- it could not have run on the Linux cluster it was built for -- and
 * it carried whatever hostnames were baked in at build time. Nothing consumed it:
 * Dockerfile.operator compiles its own binary in a build stage, and the Makefile
 * regenerates it on demand.
 *
 * A committed binary in a public repository is also unverifiable provenance: a
 * reader cannot tell what source produced it.
 */
describe('no compiled artefacts are tracked (public repository)', () => {
  it('does not track the operator binary', () => {
    // Build output. `make build` regenerates it; the image build never reads it.
    expect(tracked().map((entry) => entry.path)).not.toContain('k8s-operator/bin/manager');
  });

  it('tracks nothing under a build output directory', () => {
    const built = tracked().filter((entry) => /(^|\/)bin\/[^/]*$/u.test(entry.path)
      && !entry.path.endsWith('.js')
      && !entry.path.endsWith('.mjs')
      && !entry.path.endsWith('.sh'));
    expect(built.map((entry) => entry.path)).toEqual([]);
  });

  it('tracks no file large enough to be a compiled artefact', () => {
    // 8 MB is comfortably above every legitimate source and fixture here and well
    // below a Go binary, so this fails on a re-commit without flagging data files.
    const large = tracked().filter((entry) => entry.bytes > 8 * 1024 * 1024);
    expect(large.map((entry) => `${entry.path} (${Math.round(entry.bytes / 1048576)}MB)`)).toEqual([]);
  });
});
