import { describe, expect, it, vi } from 'vitest';

/**
 * REL-1069 review: the shared tripwire's ONLY value is its throw branch -- the fix
 * for "CI run reports green having tested zero Postgres assertions". No call site
 * can exercise it incidentally (CI has the URL, local runs have no CI), and the
 * no-op branch is heavily exercised while the diagnostic branch is covered by
 * nothing. A regression that neutered the guard would therefore fail silently,
 * which is the failure mode the module exists to prevent.
 *
 * These tests drive the module directly, re-importing it under each environment.
 */
describe('postgresSuite tripwire', () => {
  it('THROWS when CI is set and the URL is absent', async () => {
    vi.stubEnv('CI', 'true');
    vi.stubEnv('REVIEW_YETI_TEST_DATABASE_URL', '');
    vi.resetModules();
    const mod = await import('../support/postgresSuite');
    expect(() => mod.requireDatabaseUrlInCi()).toThrow(/must be set in CI/);
    vi.unstubAllEnvs();
  });

  it('does NOT throw locally without a URL (a clean skip is intended)', async () => {
    vi.stubEnv('REVIEW_YETI_TEST_DATABASE_URL', '');
    vi.stubEnv('CI', '');
    vi.resetModules();
    const mod = await import('../support/postgresSuite');
    expect(() => mod.requireDatabaseUrlInCi()).not.toThrow();
    vi.unstubAllEnvs();
  });

  it('does NOT throw in CI when the URL is present', async () => {
    vi.stubEnv('CI', 'true');
    vi.stubEnv('REVIEW_YETI_TEST_DATABASE_URL', 'postgresql://example/db');
    vi.resetModules();
    const mod = await import('../support/postgresSuite');
    expect(() => mod.requireDatabaseUrlInCi()).not.toThrow();
    vi.unstubAllEnvs();
  });

  it('the EFFECT follows the decision: run registers, skip skips', async () => {
    // The spy must be ASSERTED, not merely installed. An earlier revision wired a
    // vi.fn() around `describe` and never referenced it, so a broken implementation
    // that kept `return dispatch` but inverted the effect
    // (`if (dispatch === 'run') describe.skip(...)`) passed everything -- while all
    // fifteen suites registered SKIPPED in the CI database job and it reported green
    // with zero Postgres assertions (REL-1069 review).
    const calls: string[] = [];
    vi.stubEnv('REVIEW_YETI_TEST_DATABASE_URL', 'postgresql://example/db');
    vi.resetModules();
    vi.doMock('vitest', async (importOriginal) => {
      const actual = await importOriginal<typeof import('vitest')>();
      const runner = Object.assign(
        (name: string) => { calls.push(`run:${name}`); },
        { ...actual.describe, skip: (name: string) => { calls.push(`skip:${name}`); } },
      );
      return { ...actual, describe: runner };
    });
    const { describeWithPostgres: withDb } = await import('../support/postgresSuite');
    const dispatch = withDb('probe-run', () => {});
    expect(dispatch).toBe('run');
    // The EFFECT, which is what actually decides whether a suite runs.
    expect(calls).toContain('run:probe-run');
    expect(calls).not.toContain('skip:probe-run');
    vi.doUnmock('vitest');
    vi.unstubAllEnvs();
  });

  it('the skip/run decision is a pure function over the URL', async () => {
    // The rule itself, directly testable. An inverted branch would skip all
    // thirteen suites in CI and report the database job green with zero
    // Postgres assertions (REL-1069 review).
    const { postgresSuiteDispatch } = await import('../support/postgresSuite');
    expect(postgresSuiteDispatch('postgresql://example/db')).toBe('run');
    expect(postgresSuiteDispatch('')).toBe('skip');
    expect(postgresSuiteDispatch('   ')).toBe('skip');
  });

  it('every Postgres suite adopts the tripwire (real tree)', async () => {
    // Adoption was hand-added calls nothing verified: a 15th suite wired only with
    // describeWithPostgres would keep the skip-only behaviour this module exists to
    // remove, so a lost CI env var would skip it green while siblings fail loudly.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = path.join(process.cwd(), 'tests/integration');
    const { assertEveryPostgresSuiteAdoptsTripwire } = await import('../support/postgresSuite');
    const readSuites = () => fs.readdirSync(dir)
      .filter((name: string) => name.endsWith('.postgres.test.ts'))
      .map((name: string) => ({
        path: name,
        source: fs.readFileSync(path.join(dir, name), 'utf8'),
      }));
    expect(readSuites().length).toBeGreaterThan(0);
    expect(() => assertEveryPostgresSuiteAdoptsTripwire(readSuites)).not.toThrow();
  });

  it('the adoption guard THROWS on a suite that has not adopted it', async () => {
    // The throw branch is the guard's only value, and asserting only
    // `.not.toThrow()` over the real tree passes identically under a vacuous
    // implementation (`.filter(() => false)`, or a loosened regex). This is the
    // same standard this PR applies to requireDatabaseUrlInCi() (REL-1069 review).
    const { assertEveryPostgresSuiteAdoptsTripwire } = await import('../support/postgresSuite');
    const compliant = { path: 'a.postgres.test.ts', source: 'requireDatabaseUrlInCi();' };
    const nonCompliant = { path: 'forgot.postgres.test.ts', source: "import { describe } from 'vitest';" };

    expect(() => assertEveryPostgresSuiteAdoptsTripwire(() => [compliant])).not.toThrow();
    // Names the offender, so a new suite is actionable rather than merely red.
    expect(() => assertEveryPostgresSuiteAdoptsTripwire(() => [compliant, nonCompliant]))
      .toThrow(/forgot\.postgres\.test\.ts/);
    // ...and reports ONLY the offenders.
    expect(() => assertEveryPostgresSuiteAdoptsTripwire(() => [compliant, nonCompliant]))
      .not.toThrow(/a\.postgres\.test\.ts/);
  });
});
