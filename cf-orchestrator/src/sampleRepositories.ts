/**
 * The sample (neutral) repository identities used throughout the public
 * dashboard surface.
 *
 * WHY THIS EXISTS (REL-1299 / REL-1303 review)
 *
 * The public dashboard ships sample data so the UI has something to render
 * without exposing a real organization. That identity is a contract between
 * three layers that must agree:
 *
 *   1. the D1 migration seed        (cf-orchestrator/migrations/0001_initial_schema.sql)
 *   2. the in-memory store fallback (cf-orchestrator/src/storage/d1Client.ts)
 *   3. the Durable Object query layer (cf-orchestrator/src/api/dashboardRoutes.ts)
 *      and the UI's REPOSITORY_DATA  (src/components/analytics/RepoMemoryPivotPlatform.tsx)
 *
 * Before this file the literal appeared ~30 times. A privacy rename therefore
 * required coordinated edits across four layers plus the test suite, and the
 * failure mode of a missed copy is SILENT: the overview queries a Durable
 * Object name that no longer matches the seeded repository and the dashboard
 * reports zeroed state (`{ activeCount: 0, queueLength: 0 }`) instead of
 * failing loudly.
 *
 * The TypeScript layers import this module. The SQL seed cannot import it, so
 * its rows are asserted against these values by
 * `cf-orchestrator/test/sampleRepositoryIdentity.test.ts` — that test is what
 * makes the contract enforced rather than documented.
 */

/** The repository whose sample data drives the "cisco"/CDR-shaped dashboard view. */
export const SAMPLE_REPO_CDR = 'example/sample-cdr';

/** The repository whose sample data drives the "meta"/analytics-shaped view. */
export const SAMPLE_REPO_META = 'example/sample-meta';

/** Every sample identity, in the order the dashboard presents them. */
export const SAMPLE_REPOS = [SAMPLE_REPO_CDR, SAMPLE_REPO_META] as const;

export type SampleRepo = (typeof SAMPLE_REPOS)[number];
