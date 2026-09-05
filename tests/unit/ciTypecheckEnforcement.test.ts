import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const root = process.cwd();

/**
 * REL-585. REL-570/REL-573 removed `tests/` and `scripts/` from `tsconfig.json`'s exclude list
 * and burned down the 464 type errors that surfaced, so `tsc --noEmit` against the default
 * `tsconfig.json` (used by `npm run lint:src`) now typechecks the whole tree. But no CI workflow
 * ever ran it -- `grep -rn "npm run lint\|tsc --noEmit" .github/workflows/` returned nothing --
 * and `npm run build` only compiles `tsconfig.server.json`, whose `include` covers only files under `src`, and
 * which excludes `tests`. The 464 errors could have silently returned and nothing would notice.
 *
 * This asserts a CI job actually runs the typecheck against the default tsconfig, in its own job
 * (not folded into `test`, so a type error is visible at a glance and does not wait on the full
 * suite), with a bounded timeout.
 */
describe('CI typecheck enforcement (REL-585)', () => {
  const workflowPath = path.join(root, '.github/workflows/ci-cd.yaml');
  const workflow = yaml.load(fs.readFileSync(workflowPath, 'utf8')) as any;

  function stepCommands(job: any): string[] {
    return (job.steps ?? [])
      .map((step: any) => step.run)
      .filter((run: unknown): run is string => typeof run === 'string');
  }

  // A command counts as covering the whole tree only if it invokes tsc/lint:src against the
  // *default* tsconfig.json. `-p tsconfig.server.json` only covers `src/**/*` and would not
  // catch a test-file or script regression -- that is the exact gap this closes.
  function isWholeTreeTypecheck(run: string): boolean {
    if (/-p\s+tsconfig\.server\.json/u.test(run)) return false;
    return (
      /\bnpm run lint:src\b/u.test(run) ||
      /^\s*npm run lint\s*$/mu.test(run) ||
      /\btsc --noEmit\b/u.test(run)
    );
  }

  function jobsRunningTypecheck(): Array<[string, any]> {
    return Object.entries(workflow.jobs as Record<string, any>).filter(([, job]) =>
      stepCommands(job).some(isWholeTreeTypecheck),
    );
  }

  it('runs a whole-tree typecheck somewhere in CI', () => {
    expect(jobsRunningTypecheck().length).toBeGreaterThan(0);
  });

  it('runs the typecheck in a dedicated job, not folded into `test`', () => {
    const names = jobsRunningTypecheck().map(([name]) => name);
    expect(names.length).toBeGreaterThan(0);
    expect(names).not.toContain('test');
  });

  it('bounds the typecheck job with an explicit timeout', () => {
    const [, job] = jobsRunningTypecheck()[0];
    expect(typeof job['timeout-minutes']).toBe('number');
    expect(job['timeout-minutes']).toBeGreaterThan(0);
  });

  it('keeps tsconfig.json typechecking tests and scripts, not just src', () => {
    // Guards the flip side: the CI job above is worthless if tsconfig.json's exclude list ever
    // grows `tests` or `scripts` back (REL-570/REL-573 regression).
    const tsconfig = JSON.parse(fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8'));
    expect(tsconfig.exclude).not.toContain('tests');
    expect(tsconfig.exclude).not.toContain('scripts');
  });
});
