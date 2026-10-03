/**
 * The sample (neutral) repository identities used by the public dashboard UI.
 *
 * Mirror of `cf-orchestrator/src/sampleRepositories.ts`. The two cannot import
 * each other (separate builds: Next.js app vs Cloudflare Worker), so the values
 * are duplicated here deliberately and pinned by
 * `tests/unit/sampleRepositoryIdentity.test.ts`, which asserts the app copy,
 * the orchestrator copy, and the D1 migration seed all agree.
 *
 * That test is what makes this a contract rather than a comment. The failure
 * mode it prevents is silent: if the seed and the query layer disagree, the
 * dashboard queries a Durable Object that no longer matches the seeded
 * repository and renders zeroed state instead of erroring.
 */

export const SAMPLE_REPO_CDR = 'example/sample-cdr';
export const SAMPLE_REPO_META = 'example/sample-meta';

export const SAMPLE_REPOS = [SAMPLE_REPO_CDR, SAMPLE_REPO_META] as const;

export type SampleRepo = (typeof SAMPLE_REPOS)[number];
