/**
 * Shared Postgres test wiring for `*.postgres.test.ts` suites.
 *
 * WHY THIS EXISTS (REL-1069 review)
 *
 * Thirteen suites guard themselves with `describe.skip` when
 * `REVIEW_YETI_TEST_DATABASE_URL` is absent. That is right locally -- a
 * developer without Postgres should get a clean skip, not thirteen red files.
 *
 * But a skip-only guard has a silent failure mode: if CI ever loses the env var
 * (renamed, a workflow edit that drops secret access, a new job that forgets the
 * service block), ALL THIRTEEN suites skip and the run reports GREEN while every
 * Postgres assertion silently vanishes. A guard whose failure mode is "report
 * success having tested nothing" is worse than no guard.
 *
 * So: skip locally, FAIL LOUDLY in CI. The invariant "CI always supplies the URL"
 * was previously asserted only in a comment.
 */
import { describe } from 'vitest';

const databaseUrl = process.env.REVIEW_YETI_TEST_DATABASE_URL?.trim() || '';

/**
 * Throws when running under CI without a database URL, before any suite registers.
 *
 * Called at module scope by each `*.postgres.test.ts` suite. `process.env.CI` is
 * set by GitHub Actions, so local runs and CI are distinguished without a
 * bespoke variable.
 */
export function requireDatabaseUrlInCi(): void {
  if (!databaseUrl && process.env.CI) {
    throw new Error(
      'REVIEW_YETI_TEST_DATABASE_URL must be set in CI; without it every '
      + 'postgres suite skips and the run reports green having tested nothing',
    );
  }
}

/** The resolved URL, or '' when Postgres is not configured. */
export function postgresDatabaseUrl(): string {
  return databaseUrl;
}

/**
 * `describe`, or `describe.skip` when no database is configured.
 *
 * The tripwire above makes the skip unreachable in CI, so this cannot hide a
 * missing service block there.
 */
/** Whether a suite registered to RUN (true) or to SKIP (false). */
export type SuiteDispatch = 'run' | 'skip';

/**
 * `describe`, or `describe.skip` when no database is configured.
 *
 * Returns which branch it took so the DECISION is observable and testable. An
 * earlier revision returned void, so a test could only assert the helper "is a
 * function" -- which an INVERTED branch (`if (databaseUrl) describe.skip(...)`)
 * also satisfies. That inversion would skip all thirteen suites in CI, report the
 * database job green with zero assertions, and pass `requireDatabaseUrlInCi()`
 * because the URL is still set: precisely the "green having tested nothing" failure
 * this module exists to eliminate (REL-1069 review).
 */
export function describeWithPostgres(
  name: string,
  body: () => void,
): SuiteDispatch {
  const dispatch = postgresSuiteDispatch(databaseUrl);
  if (dispatch === 'run') describe(name, body);
  else describe.skip(name, body);
  return dispatch;
}

/**
 * The decision alone, separated from the effect.
 *
 * `describe` cannot be called inside a test body, so a decision embedded in the
 * effect is only observable through vitest's own machinery. Extracting it makes the
 * rule directly testable -- and an inverted branch is exactly the regression that
 * would skip all thirteen suites in CI while reporting green (REL-1069 review).
 */
export function postgresSuiteDispatch(url: string): SuiteDispatch {
  return url.trim() === '' ? 'skip' : 'run';
}

/**
 * Assert that EVERY Postgres suite adopts the CI tripwire.
 *
 * The invariant "skip locally, fail loudly in CI" only holds for suites that call
 * `requireDatabaseUrlInCi()` at module scope, and that was thirteen hand-added
 * calls nothing verified. A 14th suite wired only with `describeWithPostgres` would
 * silently keep the skip-only behaviour this module exists to remove.
 *
 * Call from a meta-test with the repo root; throws naming every suite that has not
 * adopted it, so adoption is enforced rather than remembered.
 */
export function assertEveryPostgresSuiteAdoptsTripwire(
  readSuites: () => Array<{ path: string; source: string }>,
): void {
  const missing = readSuites()
    .filter(({ source }) => !/\brequireDatabaseUrlInCi\s*\(/u.test(source))
    .map(({ path }) => path);
  if (missing.length > 0) {
    throw new Error(
      `these Postgres suites do not call requireDatabaseUrlInCi(), so they would `
      + `skip green in CI if the database URL is lost: ${missing.join(', ')}`,
    );
  }
}
