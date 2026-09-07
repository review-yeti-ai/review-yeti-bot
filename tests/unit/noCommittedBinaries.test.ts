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

/**
 * This is a public product repository under its own org and MIT licence. Call
 * Telemetry's *own* deployment of the product does not belong in it: a private
 * instance's manifests, namespaces and deploy workflow name internal
 * infrastructure and an operating entity to anyone reading, and having them here
 * is what made it natural to reach for real values as chart defaults and test
 * fixtures in the first place.
 *
 * The product's own Kubernetes support -- charts/review-yeti, the operator,
 * docs/KUBERNETES_MODE.md -- is deliberately public and stays.
 */
describe('no private deployment lives in this public product repository', () => {
  it('tracks no path naming a private instance', () => {
    const offending = tracked()
      .map((entry) => entry.path)
      .filter((file) => /jbjmllc/iu.test(file));
    expect(offending).toEqual([]);
  });

  it('mentions no private instance anywhere', () => {
    // Exactly two exemptions, both named individually rather than by glob so a new
    // file cannot inherit one:
    //
    //  1. this file, which necessarily contains the literal it forbids;
    //  2. one dated plan document from 2026-08-02, a historical record of what was
    //     planned at the time. It is not live configuration, and rewriting a dated
    //     record to match today's naming would falsify it.
    //
    // A blanket docs/superpowers/** carve-out would let any future document name
    // the instance while this still passed, which is the fail-open shape these
    // guards exist to refuse.
    const exempt = [
      ':!tests/unit/noCommittedBinaries.test.ts',
      ':!docs/superpowers/plans/2026-08-02-openrouter-terraform-guide.md',
    ];
    let hits = '';
    try {
      hits = execFileSync('git', ['grep', '-il', 'jbjmllc', '--', '.', ...exempt], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch (error) {
      // git grep exits 1 on no match, which is the passing case; anything else is real.
      if ((error as { status?: number }).status !== 1) throw error;
    }
    expect(hits).toBe('');
  });
});
