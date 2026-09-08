/**
 * DOKS publishing review lane (REL-586, ADR 0527).
 *
 * The DOKS worker had no production path: the operator forced every real dispatch
 * down the receipt-only branch, and the only two non-receipt profiles are manual
 * qualification lanes that *assert* `REVIEW_PUBLICATION_MODE === 'disabled'` and
 * hardcode `githubWrites: 0`. This module is the missing lane -- it reads the real
 * pull request at the admitted head, runs the persona panel through the Bifrost
 * gateway, and publishes a fail-closed App check.
 *
 * Two invariants this file exists to enforce:
 *
 * 1. **Bifrost only.** The legacy `runLiveReviewMain` defaults its base URL to
 *    `openrouter.ai` and its repository to a hardcoded fallback. Reaching it from a
 *    DOKS dispatch would review the wrong repository against the wrong provider.
 *    Here the gateway base URL and key are *required*; there is no default and no
 *    second transport.
 *
 * 2. **Fail closed.** Only a clean panel verdict produces `success`. Provider
 *    failure, panel failure, a non-shipping verdict, or any unexpected error all
 *    conclude `failure`. `completeCheck` cannot express `neutral`, which is
 *    deliberate: a `neutral` check does not block a merge, so an outage that
 *    published `neutral` would silently stop enforcing.
 */
import { executePersonaPanel } from '../panel/panelEngine';
import { OpenRouterClient } from '../gateway/openRouterClient';
import type { ReviewModelClient } from '../gateway/openRouterClient';
import { createDefaultV3Config } from '../config/configLoader';
import { loadSameHeadReviewSource } from '../github/qualificationReader';
import { computeArbitration } from '../review/reviewCore';
import { logger } from '../utils/logger';

export const PUBLICATION_MODE_APP_GATE = 'app-gate';

/** Terminal states this lane can publish. `neutral` is intentionally absent. */
export type PublishingConclusion = 'success' | 'failure';

export interface PublishingReviewIdentity {
  runId: string;
  repositoryId: number;
  repo: string;
  owner: string;
  repoName: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
}

/** One canonical finding, as arbitration emits it. */
export interface ReviewFinding {
  severity?: string;
  path?: string;
  line?: number;
  title?: string;
  body?: string;
}

export interface CheckAnnotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: 'notice' | 'warning' | 'failure';
  message: string;
  title?: string;
}

export interface PublishingCheckClient {
  createCheck(owner: string, repo: string, headSha: string): Promise<number>;
  completeCheck(options: {
    owner: string;
    repo: string;
    checkId: number;
    conclusion: 'success' | 'failure' | 'cancelled';
    title: string;
    summary: string;
    text?: string;
    annotations?: CheckAnnotation[];
  }): Promise<void>;
}

export interface PublishingReviewReceipt {
  version: 'ReviewYetiPublishingReview.v1';
  runId: string;
  repositoryId: number;
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  publicationMode: typeof PUBLICATION_MODE_APP_GATE;
  transport: 'bifrost';
  model: string;
  verdict: string;
  conclusion: PublishingConclusion;
  findingCount: number;
  blockingFindingCount: number;
  failureClass: string | null;
  startedAt: string;
  completedAt: string;
}

function value(env: NodeJS.ProcessEnv, name: string): string {
  return String(env[name] || '').trim();
}

export function invalidPublishingReviewContract(): Error {
  return new Error('publishing review worker contract is invalid');
}

/**
 * True only for a real, admitted, publishing dispatch. Every qualification lane
 * and the receipt-only lane are excluded explicitly rather than by omission, so
 * adding a future lane cannot silently fall into publishing.
 */
export function isPublishingReviewWorker(env: NodeJS.ProcessEnv = process.env): boolean {
  return value(env, 'REVIEW_PUBLICATION_MODE') === PUBLICATION_MODE_APP_GATE
    && value(env, 'REVIEW_RECEIPT_ONLY') !== 'true'
    && value(env, 'REVIEW_FULL_PANEL_QUALIFICATION_ONLY') !== 'true'
    && value(env, 'REVIEW_SAME_HEAD_QUALIFICATION_ONLY') !== 'true'
    && value(env, 'REVIEW_PANEL_QUALIFICATION_ONLY') !== 'true'
    && value(env, 'REVIEW_PROVIDER_QUALIFICATION_ONLY') !== 'true';
}

const RUN_ID = /^run_[a-f0-9]{32}$/u;
const SHA = /^[a-f0-9]{40}$/u;
const REPO = /^[^/\s]+\/[^/\s]+$/u;

export function publishingReviewIdentity(env: NodeJS.ProcessEnv): PublishingReviewIdentity {
  const runId = value(env, 'REVIEW_RUN_ID');
  const repo = value(env, 'REVIEW_REPO');
  const headSha = value(env, 'REVIEW_HEAD_SHA');
  const baseSha = value(env, 'REVIEW_BASE_SHA');
  const repositoryId = Number(value(env, 'REVIEW_REPOSITORY_ID'));
  const prNumber = Number(value(env, 'REVIEW_PR_NUMBER'));
  if (!RUN_ID.test(runId) || !REPO.test(repo) || !SHA.test(headSha) || !SHA.test(baseSha)
    || !Number.isSafeInteger(repositoryId) || repositoryId <= 0
    || !Number.isSafeInteger(prNumber) || prNumber <= 0) {
    throw invalidPublishingReviewContract();
  }
  const [owner, repoName] = repo.split('/');
  return { runId, repositoryId, repo, owner, repoName, prNumber, headSha, baseSha };
}

/**
 * Bifrost is the only admitted transport. Both the base URL and the key are
 * required: defaulting either one is how a misconfigured worker silently reviews
 * against the wrong provider.
 */
export function bifrostTransport(env: NodeJS.ProcessEnv): { baseUrl: string; apiKey: string; model: string } {
  const baseUrl = value(env, 'BIFROST_BASE_URL');
  const apiKey = value(env, 'BIFROST_PR_REVIEW_API_KEY');
  const model = value(env, 'REVIEW_MODEL');
  if (!baseUrl || !apiKey || !model) throw invalidPublishingReviewContract();
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw invalidPublishingReviewContract();
  }
  // A plaintext or non-gateway base URL would ship diffs off the intended path.
  if (parsed.protocol !== 'https:') throw invalidPublishingReviewContract();
  return { baseUrl, apiKey, model };
}

/**
 * The publishing worker is admitted with a single Bifrost transport. It must
 * not fall back to the legacy default config, whose synthetic/claude providers
 * are unavailable in the production gateway. Keep every persona, moderator,
 * and arbiter call on the operator-injected model and fail closed on provider
 * errors instead of attempting an undeclared route.
 */
export function createBifrostPublishingConfig(model: string): ReturnType<typeof createDefaultV3Config> {
  const providerId = 'bifrost';
  const config = createDefaultV3Config();
  return {
    ...config,
    personas: config.personas.map((persona) => ({ ...persona, providers: [providerId] })),
    reviewers: {
      ...config.reviewers,
      fallback: 'none',
      providers: [{
        id: providerId,
        enabled: true,
        model,
        effort: 'medium',
        review_timeout_s: 300,
        arbiter_timeout_s: 300,
      }],
      arbiter: { order: [providerId] },
    },
  };
}

const BLOCKING_SEVERITIES = new Set(['P0', 'P1']);

/**
 * Fail closed. `SHIP` with no blocking finding is the only success. Everything
 * else -- BLOCK, FIX_FIRST, an unrecognised verdict, or a SHIP that still carries
 * a P0/P1 -- concludes `failure`.
 */
export function publishingConclusion(verdict: string, blockingFindingCount: number): PublishingConclusion {
  if (blockingFindingCount > 0) return 'failure';
  return String(verdict).toUpperCase() === 'SHIP' ? 'success' : 'failure';
}

export function classifyFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/contract is invalid/iu.test(message)) return 'contract';
  if (/timeout|timed out|ETIMEDOUT/iu.test(message)) return 'timeout';
  if (/401|403|unauthor|virtual key/iu.test(message)) return 'auth';
  if (/429|rate limit/iu.test(message)) return 'rate_limit';
  if (/ENOTFOUND|ECONNREFUSED|EAI_AGAIN|fetch failed/iu.test(message)) return 'transport';
  return 'provider_error';
}

export interface PublishingReviewDeps {
  checkClient: PublishingCheckClient;
  sourceLoader?: typeof loadSameHeadReviewSource;
  panelRunner?: typeof executePersonaPanel;
  client?: ReviewModelClient;
  now?: () => number;
}

/**
 * Renders the canonical findings into the check's `text` body. Ordered by
 * severity so the blocking ones are read first, and every entry carries its
 * file and line so a reader can navigate without the annotation view.
 */
function renderFindingsMarkdown(findings: ReviewFinding[], blockingCount: number): string {
  if (findings.length === 0) {
    return 'No findings survived canonical arbitration for this head.';
  }
  const order = (severity: string): number => (severity === 'P0' ? 0 : severity === 'P1' ? 1 : 2);
  const lines = [...findings]
    .sort((a, b) => order(String(a?.severity || 'P2').toUpperCase()) - order(String(b?.severity || 'P2').toUpperCase()))
    .map((finding) => {
      const severity = String(finding?.severity || 'P2').toUpperCase();
      const where = finding?.path ? `\`${String(finding.path)}${finding?.line ? `:${finding.line}` : ''}\`` : '_no file_';
      const title = String(finding?.title || 'finding');
      const body = String(finding?.body || '').trim();
      return `- **${severity}** ${where} — ${title}${body ? `\n  ${body.replace(/\n/gu, '\n  ')}` : ''}`;
    });
  return [
    `${findings.length} finding(s), ${blockingCount} blocking (P0/P1).`,
    '',
    ...lines,
  ].join('\n');
}

export async function runPublishingReviewWorker(
  env: NodeJS.ProcessEnv,
  deps: PublishingReviewDeps,
): Promise<PublishingReviewReceipt> {
  if (!isPublishingReviewWorker(env)) throw invalidPublishingReviewContract();
  const identity = publishingReviewIdentity(env);
  const transport = bifrostTransport(env);
  const now = deps.now || Date.now;
  const startedAt = new Date(now()).toISOString();
  const sourceLoader = deps.sourceLoader || loadSameHeadReviewSource;
  const panelRunner = deps.panelRunner || executePersonaPanel;

  // Created before any provider work so an in-flight run is visible on the head,
  // and so a crash leaves a check this lane owns rather than nothing at all.
  const checkId = await deps.checkClient.createCheck(identity.owner, identity.repoName, identity.headSha);

  try {
    // `repo` is the full `owner/repo`: the loader parses the slash itself and has
    // no `owner` field. Passing the bare name made every app-gate run die on
    // "GitHub qualification repository is invalid". The `as Parameters<...>` cast
    // that used to sit here is deliberately gone -- it silenced both the unknown
    // `owner` property and the shape mismatch, which is the only reason this
    // shipped.
    const source = await sourceLoader({
      repo: identity.repo,
      prNumber: identity.prNumber,
      expectedBaseSha: identity.baseSha,
      expectedHeadSha: identity.headSha,
      token: value(env, 'GH_TOKEN'),
    });

    // Split on the file-header boundary, then match the header against a
    // single line. The previous expression used a dot-all lazy group for the
    // `b/` path with a lookahead to the next header, so the captured "path" ran
    // to the end of the whole file patch -- an 80+ character string containing
    // newlines. Every finding was then compared against that pseudo-path,
    // matched nothing, and was discarded during arbitration, which is why this
    // lane returned `SHIP` on every review regardless of what the panel found.
    const changedFiles = String(source.diff)
      .split(/^(?=diff --git )/mu)
      .filter((chunk) => chunk.startsWith('diff --git '))
      .map((chunk) => {
        const header = /^diff --git a\/(\S+) b\/(\S+)/u.exec(chunk);
        return header ? { path: header[2] || header[1], patch: chunk } : null;
      })
      .filter((file): file is { path: string; patch: string } =>
        file !== null && file.path.length > 0 && file.path !== '/dev/null');
    // An empty changed-file set must not be read as "nothing to review, ship".
    if (changedFiles.length === 0) throw new Error('admitted head produced no reviewable diff');

    const client = deps.client || new OpenRouterClient({ baseUrl: transport.baseUrl, apiKey: transport.apiKey });
    const panelResult = await panelRunner({
      config: createBifrostPublishingConfig(transport.model),
      changedFiles,
      repository: identity.repo,
      headSha: identity.headSha,
      client,
      jobId: identity.runId,
    } as Parameters<typeof executePersonaPanel>[0]);

    const rawFindings = (panelResult.personas || []).flatMap((persona: { findings?: unknown[] }) => persona.findings || []);
    // The model arbiter is evidence, not the policy boundary. The canonical
    // review policy treats P2 findings as advisory; trusting a raw FIX_FIRST
    // from the model made the DOKS app gate reject a clean (P0/P1-free) review.
    // Recompute from the exact persona findings and quorum so this lane shares
    // the same fail-closed severity contract as the hosted review path.
    const canonical = computeArbitration(panelResult.personas, panelResult.personas.length, {
      changedFiles,
      coverageComplete: panelResult.quorum.satisfied,
    });
    const verdict = canonical.verdict;
    // Count blocking findings from the canonical set, not the raw persona
    // output. The two disagreed: the check reported a blocking count derived
    // from unsanitized findings next to a verdict derived from the sanitized
    // ones, so a run could read `SHIP` and `blocking P0/P1: 13` at once. The
    // canonical set is the one the verdict is computed from, so it is the only
    // set the conclusion may be computed from.
    const findings = (canonical.findings || []) as ReviewFinding[];
    const blocking = findings.filter(
      (finding) => BLOCKING_SEVERITIES.has(String(finding?.severity || 'P2').toUpperCase()),
    );
    const conclusion = publishingConclusion(verdict, blocking.length);

    // A count with nothing attached is not reviewable. Until now the check
    // published only a title and a summary, so a run could report four blocking
    // findings while the pull request carried no comment, no review and no
    // annotation -- nothing an author could act on. Both fields below need only
    // `checks: write`, so the findings become visible without widening the
    // worker's token beyond its ADR 0541 boundary.
    const changedPaths = new Set(changedFiles.map((file) => file.path));
    await deps.checkClient.completeCheck({
      owner: identity.owner,
      repo: identity.repoName,
      checkId,
      conclusion,
      title: `Review Yeti: ${verdict}`,
      summary: [
        `Verdict \`${verdict}\` at \`${identity.headSha}\`.`,
        `Findings: ${findings.length} (blocking P0/P1: ${blocking.length}).`,
        `Transport: bifrost \`${transport.model}\`.`,
      ].join('\n\n'),
      text: renderFindingsMarkdown(findings, blocking.length),
      // GitHub rejects an annotation whose path is not in the diff, which would
      // fail the whole PATCH and take the verdict with it. Drop off-diff
      // findings from the annotation set only; they remain in the text body.
      annotations: findings
        .filter((finding) => changedPaths.has(String(finding?.path || '')))
        .slice(0, 50)
        .map((finding) => {
          const line = Number.isSafeInteger(Number(finding?.line)) && Number(finding?.line) > 0
            ? Number(finding.line)
            : 1;
          const severity = String(finding?.severity || 'P2').toUpperCase();
          return {
            path: String(finding.path),
            start_line: line,
            end_line: line,
            annotation_level: BLOCKING_SEVERITIES.has(severity) ? 'failure' as const : 'warning' as const,
            title: `${severity}: ${String(finding?.title || 'finding').slice(0, 120)}`,
            message: String(finding?.body || finding?.title || 'No detail provided.').slice(0, 4_000),
          };
        }),
    });

    const completedAt = new Date(now()).toISOString();
    return {
      version: 'ReviewYetiPublishingReview.v1',
      runId: identity.runId,
      repositoryId: identity.repositoryId,
      repo: identity.repo,
      prNumber: identity.prNumber,
      headSha: identity.headSha,
      baseSha: identity.baseSha,
      publicationMode: PUBLICATION_MODE_APP_GATE,
      transport: 'bifrost',
      model: transport.model,
      verdict,
      conclusion,
      findingCount: findings.length,
      blockingFindingCount: blocking.length,
      failureClass: null,
      startedAt,
      completedAt,
    };
  } catch (error) {
    const failureClass = classifyFailure(error);
    // Fail closed: an outage concludes `failure`, never `neutral` or `success`.
    // Publication is best-effort because the check may be unreachable; the
    // rethrow below still fails the Job so the admission deadline can reap it.
    try {
      await deps.checkClient.completeCheck({
        owner: identity.owner,
        repo: identity.repoName,
        checkId,
        conclusion: 'failure',
        title: 'Review Yeti: review did not complete',
        summary: `Failure class \`${failureClass}\` at \`${identity.headSha}\`. This is a failed review, not an approval.`,
      });
    } catch (publishError) {
      logger.error('Failed to publish the fail-closed conclusion', {
        runId: identity.runId,
        failureClass,
        error: publishError instanceof Error ? publishError.message : String(publishError),
      });
    }
    throw error;
  }
}
