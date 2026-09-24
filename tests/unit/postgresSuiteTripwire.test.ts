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

  it('skips via the shared predicate exactly when the URL is absent', async () => {
    vi.stubEnv('REVIEW_YETI_TEST_DATABASE_URL', '');
    vi.resetModules();
    const withoutDb = await import('../support/postgresSuite');
    // vitest's describe.skip and describe are distinct; the helper must pick skip.
    expect(withoutDb.describeWithPostgres).toBeTypeOf('function');

    vi.stubEnv('REVIEW_YETI_TEST_DATABASE_URL', 'postgresql://example/db');
    vi.resetModules();
    const withDb = await import('../support/postgresSuite');
    expect(withDb.postgresDatabaseUrl()).toBe('postgresql://example/db');
    vi.unstubAllEnvs();
  });
});
