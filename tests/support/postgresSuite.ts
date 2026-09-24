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
export function describeWithPostgres(
  name: string,
  body: () => void,
): void {
  if (databaseUrl) describe(name, body);
  else describe.skip(name, body);
}
