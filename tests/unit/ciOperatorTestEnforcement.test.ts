import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const root = process.cwd();

/**
 * REL-896. `k8s-operator/` is a Go module whose controller tests guard how review resources,
 * worker Jobs and run Secrets are created and cleaned up, yet no workflow ran them: the only Go
 * command anywhere in CI was the `go build` inside Dockerfile.operator. A reconciler regression
 * could ship behind a fully green pull request.
 *
 * This asserts that a dedicated CI job vets and tests the operator module, bounded by a timeout,
 * in the exact digest-pinned Go image the shipped binary is built with, so the tested toolchain
 * and the shipped toolchain cannot drift apart.
 */
describe('CI operator test enforcement (REL-896)', () => {
  const workflow = yaml.load(
    fs.readFileSync(path.join(root, '.github/workflows/ci-cd.yaml'), 'utf8'),
  ) as any;
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile.operator'), 'utf8');

  function stepCommands(job: any): string[] {
    return (job.steps ?? [])
      .map((step: any) => step.run)
      .filter((run: unknown): run is string => typeof run === 'string');
  }

  function operatorJobs(): Array<[string, any]> {
    return Object.entries(workflow.jobs as Record<string, any>).filter(([, job]) =>
      job?.defaults?.run?.['working-directory'] === 'k8s-operator'
      && stepCommands(job).some((run) => /\bgo test\b/u.test(run)),
    );
  }

  it('runs the operator Go tests in a dedicated job', () => {
    const names = operatorJobs().map(([name]) => name);
    expect(names).toEqual(['operator-test']);
  });

  it('vets and tests every package, with no package or test narrowing', () => {
    const [, job] = operatorJobs()[0];
    const commands = stepCommands(job);
    expect(commands.some((run) => /\bgo vet \.\/\.\.\.(\s|$)/u.test(run))).toBe(true);
    expect(commands.some((run) => /\bgo test\b.*\.\/\.\.\.(\s|$)/u.test(run))).toBe(true);
    expect(commands.some((run) => /\bgo test\b.*\s-(?:run|skip|short)\b/u.test(run))).toBe(false);
  });

  // REL-1074. `-count=1` was dropped once GOCACHE persisted between runs. Go reuses a cached test
  // result only when the test binary, its flags, every env var the test read and every file it
  // opened are unchanged; checkout gives files fresh mtimes, so tests that read testdata or CRDs
  // still re-run. The operator tests use a fake client and read no external state. What makes
  // that safe is the cache key covering every Go input, so this pins it.
  it('persists GOCACHE and GOMODCACHE under a key that covers every Go input', () => {
    const [, job] = operatorJobs()[0];
    const cache = (job.steps ?? []).find((step: any) => /^actions\/cache@[0-9a-f]{40}$/u.test(String(step.uses ?? '')));
    expect(cache).toBeDefined();
    const paths = String(cache.with.path).split(/\r?\n/u).map((line: string) => line.trim()).filter(Boolean);
    expect(paths).toContain(job.env.GOCACHE);
    expect(paths).toContain(job.env.GOMODCACHE);
    expect(cache.with.key).toContain("hashFiles('k8s-operator/go.sum')");
    expect(cache.with.key).toMatch(/hashFiles\([^)]*'k8s-operator\/\*\*\/\*\.go'/u);
    expect(cache.with.key).toContain("'k8s-operator/go.mod'");
    expect(job.env.GOFLAGS).toBe('-buildvcs=false');
  });

  it('runs on pull requests under the same draft rule as the other validation jobs', () => {
    const [, job] = operatorJobs()[0];
    expect(job.if).toBe(workflow.jobs.typecheck.if);
    expect(workflow.on.pull_request).toBeDefined();
  });

  it('is bounded by an explicit timeout and read-only permissions', () => {
    const [, job] = operatorJobs()[0];
    expect(typeof job['timeout-minutes']).toBe('number');
    expect(job['timeout-minutes']).toBeLessThanOrEqual(15);
    expect(job.permissions).toEqual({ contents: 'read' });
  });

  it('tests in the exact digest-pinned Go image Dockerfile.operator builds with', () => {
    const [, job] = operatorJobs()[0];
    const pinned = /^ARG GO_BASE_IMAGE=(\S+)$/mu.exec(dockerfile)?.[1];
    expect(pinned).toMatch(/^golang:[^@]+@sha256:[0-9a-f]{64}$/u);
    expect(job.container?.image).toBe(pinned);
  });
});
