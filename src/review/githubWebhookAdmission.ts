import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ReviewDispatchRepository } from '../persistence/reviewDispatchRepository';
import { TERMINAL_DEADLINE_MS } from '../config/terminalDeadline';
import type { GitHubWebhookConfig } from '../auth/githubWebhookConfig';
import type { AuthoritativeReviewAdmission } from './authoritativeServiceContracts';
import { buildReviewRunIdentity, deriveReviewRunId } from './reviewAdmission';
import { sha256 } from './reviewCore';
import {
  AUTHORITATIVE_REVIEW_APP_ID, AUTHORITATIVE_REVIEW_APP_SLUG, AUTHORITATIVE_REVIEW_CHECK_NAME,
} from '../auth/authoritativeServiceIdentity';
import {
  githubWebhookRepositorySchema, requireEnrolledGitHubWebhookRepository, UnenrolledGitHubWebhookIdentityError,
} from '../auth/githubWebhookIdentity';
import { MergeGroupGateInProgressError } from './mergeGroupGate';
import {
  RECOVERABLE_FAILURE_TITLES,
  REVIEW_REFRESH_ACTION,
} from './reviewRecoveryPolicy';

const positiveInteger = z.number().int().positive().safe();
const sha = z.string().regex(/^[a-f0-9]{40}$/u);
const pullRequestWebhook = z.object({
  action: z.enum(['opened', 'synchronize', 'reopened', 'ready_for_review']),
  number: positiveInteger,
  installation: z.object({ id: positiveInteger }).passthrough(),
  repository: githubWebhookRepositorySchema,
  pull_request: z.object({
    number: positiveInteger,
    state: z.literal('open'),
    draft: z.literal(false),
    head: z.object({ sha }).passthrough(),
    base: z.object({ sha, repo: z.object({ full_name: z.string().min(3).max(201) }).passthrough() }).passthrough(),
  }).passthrough(),
}).passthrough();

const REFRESH_ACTION_IDENTIFIER = REVIEW_REFRESH_ACTION.identifier;
const refreshExternalId = z.string()
  .regex(/^run_[a-f0-9]{32}:a[1-9][0-9]*$/u)
  .refine((value) => Number.isSafeInteger(Number(value.slice(value.lastIndexOf(':a') + 2))));
const checkRunRepositoryReference = z.union([
  z.object({
    full_name: z.string().min(3).max(201),
  }).passthrough(),
  // GitHub's live check_run.rerequested payload uses this compact repository
  // shape for associated pull requests. It does not include full_name.
  z.object({
    id: positiveInteger,
    url: z.string().url(),
    name: z.string().min(1).max(100),
  }).passthrough(),
]);
const recoverableCheckRun = z.object({
  id: positiveInteger,
  name: z.literal(AUTHORITATIVE_REVIEW_CHECK_NAME),
  head_sha: sha,
  status: z.literal('completed'),
  conclusion: z.literal('failure'),
  external_id: refreshExternalId,
  app: z.object({
    id: z.literal(AUTHORITATIVE_REVIEW_APP_ID),
    slug: z.literal(AUTHORITATIVE_REVIEW_APP_SLUG),
  }).passthrough(),
  output: z.object({
    title: z.string().refine((value) => RECOVERABLE_FAILURE_TITLES.has(value)),
  }).passthrough(),
  // GitHub leaves this array empty for fork pushes. Refuse to guess the PR
  // coordinates in that case: refresh is only valid for a single exact head.
  pull_requests: z.array(z.object({
    number: positiveInteger,
    head: z.object({
      sha,
      repo: checkRunRepositoryReference,
    }).passthrough(),
    base: z.object({
      sha,
      repo: checkRunRepositoryReference,
    }).passthrough(),
  }).passthrough()).length(1),
}).passthrough();
const refreshCheckRunWebhook = z.discriminatedUnion('action', [z.object({
  action: z.literal('requested_action'),
  installation: z.object({ id: positiveInteger }).passthrough(),
  repository: githubWebhookRepositorySchema,
  requested_action: z.object({ identifier: z.literal(REFRESH_ACTION_IDENTIFIER) }).passthrough(),
  check_run: recoverableCheckRun,
}).passthrough(), z.object({
  action: z.literal('rerequested'),
  installation: z.object({ id: positiveInteger }).passthrough(),
  repository: githubWebhookRepositorySchema,
  check_run: recoverableCheckRun,
}).passthrough()]);

export interface GitHubWebhookAdmissionOptions {
  config: GitHubWebhookConfig;
  admission: Pick<ReviewDispatchRepository, 'admit'>;
  authoritativePublishing?: AuthoritativeReviewAdmission;
  now?: () => number;
  mergeGroupGate?(payload: unknown): Promise<{ checkId: number; conclusion: 'success' | 'failure'; constituents: number }>;
}

export interface GitHubWebhookAdmissionEvent {
  eventName: string;
  deliveryId: string;
  rawBody: Buffer;
  body: unknown;
}

function checkRunRepositoryMatches(
  reference: z.infer<typeof checkRunRepositoryReference>,
  repository: z.infer<typeof githubWebhookRepositorySchema>,
): boolean {
  const fields = reference as Record<string, unknown>;
  const expected = {
    full_name: repository.full_name,
    id: repository.id,
    name: repository.name,
    url: `https://api.github.com/repos/${repository.full_name}`,
  } as const;
  for (const [key, value] of Object.entries(expected)) {
    if (Object.hasOwn(fields, key) && fields[key] !== value) return false;
  }
  return fields.full_name === expected.full_name
    || (fields.id === expected.id && fields.name === expected.name && fields.url === expected.url);
}

/** Admit signed, allowlisted GitHub App review events directly. */
export function createGitHubWebhookAdmissionHandler(options: GitHubWebhookAdmissionOptions) {
  const now = options.now || Date.now;
  const authoritativeIds = new Set(options.authoritativePublishing?.repositoryIds || []);
  return async (event: GitHubWebhookAdmissionEvent): Promise<Record<string, unknown>> => {
    const { eventName, deliveryId: delivery } = event;
    if (!options.config.admissionEnabled) return { status: 'ignored', reason: 'admission_paused' };
    if (!Buffer.isBuffer(event.rawBody) || !delivery || delivery.length > 256) {
      throw new Error('GitHub webhook identity is unavailable');
    }
    if (eventName === 'merge_group') {
      const action = event.body && typeof event.body === 'object' && !Array.isArray(event.body)
        ? (event.body as Record<string, unknown>).action : undefined;
      if (typeof action === 'string' && action.length > 0 && action !== 'checks_requested') {
        return { status: 'ignored', reason: 'unsupported_merge_group_action' };
      }
      if (!options.mergeGroupGate) throw new Error('Merge-group webhook gate is unavailable');
      let result;
      try { result = await options.mergeGroupGate(event.body); }
      catch (error) {
        if (error instanceof UnenrolledGitHubWebhookIdentityError) return { status: 'ignored', reason: 'not_enrolled' };
        if (error instanceof MergeGroupGateInProgressError) return { status: 'accepted', reason: 'merge_group_in_progress' };
        throw error;
      }
      return { status: result.conclusion, checkId: result.checkId, constituents: result.constituents };
    }
    if (eventName === 'check_run') {
      const parsed = refreshCheckRunWebhook.safeParse(event.body);
      if (!parsed.success) return { status: 'ignored', reason: 'unsupported_refresh_request' };
      const payload = parsed.data;
      let enrolled;
      try { enrolled = requireEnrolledGitHubWebhookRepository(payload.repository, options.config); }
      catch (error) {
        if (error instanceof UnenrolledGitHubWebhookIdentityError) return { status: 'ignored', reason: 'not_enrolled' };
        throw error;
      }
      const pr = payload.check_run.pull_requests[0];
      const { owner, repo } = enrolled;
      if (payload.repository.full_name !== `${owner}/${repo}`
        || !checkRunRepositoryMatches(pr.head.repo, payload.repository)
        || !checkRunRepositoryMatches(pr.base.repo, payload.repository)
        || pr.head.sha !== payload.check_run.head_sha) {
        return { status: 'ignored', reason: 'not_enrolled' };
      }
      const requested = {
        repositoryId: payload.repository.id, owner, repo, prNumber: pr.number,
        headSha: pr.head.sha, baseSha: pr.base.sha,
      };
      const legacyIdentity = buildReviewRunIdentity(requested);
      const attemptSeparator = payload.check_run.external_id.lastIndexOf(':a');
      const runId = payload.check_run.external_id.slice(0, attemptSeparator);
      const retryAfterExecutionAttempt = Number(payload.check_run.external_id.slice(attemptSeparator + 2));
      const authoritative = options.authoritativePublishing;
      const hasAuthoritativeIdentity = authoritative !== undefined
        && authoritativeIds.has(payload.repository.id);
      // GitHub's native re-request action carries no separately named action
      // identifier. Admit it only where the service can re-read and bind the
      // exact current candidate/policy; legacy enrollment must keep using the
      // explicit Review Yeti refresh button instead.
      if (payload.action === 'rerequested' && !hasAuthoritativeIdentity) {
        return { status: 'ignored', reason: 'native_rerequest_requires_authoritative_identity' };
      }
      if (authoritative?.acceptNewRequests === false && authoritativeIds.has(payload.repository.id)) {
        return { status: 'ignored', reason: 'authoritative_admission_paused' };
      }
      const resolved = authoritative && hasAuthoritativeIdentity
        ? await authoritative.resolver.resolve(requested) : undefined;
      const expectedIdentity = resolved?.identity || legacyIdentity;
      const expectedRunId = deriveReviewRunId(expectedIdentity);
      if (expectedRunId !== runId) {
        return { status: 'ignored', reason: 'refresh_identity_mismatch' };
      }
      const receivedAt = now();
      const admission = await options.admission.admit({
        deliveryId: `github-webhook:${delivery}`,
        eventName,
        repositoryId: payload.repository.id,
        installationId: payload.installation.id,
        receivedAt,
        terminalDeadline: receivedAt + TERMINAL_DEADLINE_MS,
        payloadDigest: createHash('sha256').update(event.rawBody).digest('hex'),
        publicationMode: 'app-gate',
        centralActionDispatch: false,
        // The signed App check_run/requested_action payload is the dedicated
        // recovery authority. The repository still requires exact persisted
        // attempt evidence before re-arming the durable run.
        retryRequested: true,
        retryAfterExecutionAttempt,
        identity: resolved?.identity || legacyIdentity,
        ...(resolved && authoritative ? {
          effectivePolicyDigest: resolved.prepared.policy.effectivePolicyDigest,
          authoritativeGate: { expectedAppId: authoritative.expectedAppId, prepared: resolved.prepared },
        } : {}),
      });
      return {
        status: admission.status,
        deliveryId: delivery,
        prNumber: pr.number,
        headSha: pr.head.sha,
        reason: 'refresh_requested',
      };
    }
    if (eventName !== 'pull_request') return { status: 'ignored', reason: 'unsupported_event' };
    const parsed = pullRequestWebhook.safeParse(event.body);
    if (!parsed.success) return { status: 'ignored', reason: 'unsupported_pull_request_state' };
    const payload = parsed.data;
    let enrolled;
    try { enrolled = requireEnrolledGitHubWebhookRepository(payload.repository, options.config); }
    catch (error) {
      if (error instanceof UnenrolledGitHubWebhookIdentityError) return { status: 'ignored', reason: 'not_enrolled' };
      throw error;
    }
    const { owner, repo } = enrolled;
    const repositoryId = payload.repository.id;
    const pr = payload.pull_request;
    if (payload.number !== pr.number || pr.base.repo.full_name !== payload.repository.full_name) {
      return { status: 'ignored', reason: 'not_enrolled' };
    }
    const requested = {
      repositoryId, owner, repo, prNumber: pr.number,
      headSha: pr.head.sha, baseSha: pr.base.sha,
    };
    const authoritative = options.authoritativePublishing;
    if (authoritative?.acceptNewRequests === false && authoritativeIds.has(repositoryId)) {
      return { status: 'ignored', reason: 'authoritative_admission_paused' };
    }
    const resolved = authoritative && authoritativeIds.has(repositoryId)
      ? await authoritative.resolver.resolve(requested) : undefined;
    const receivedAt = now();
    const admission = await options.admission.admit({
      deliveryId: `github-webhook:${delivery}`,
      eventName,
      repositoryId,
      installationId: payload.installation.id,
      receivedAt,
      terminalDeadline: receivedAt + TERMINAL_DEADLINE_MS,
      payloadDigest: createHash('sha256').update(event.rawBody).digest('hex'),
      publicationMode: 'app-gate',
      centralActionDispatch: false,
      identity: resolved?.identity || buildReviewRunIdentity(requested),
      ...(resolved && authoritative ? {
        effectivePolicyDigest: resolved.prepared.policy.effectivePolicyDigest,
        authoritativeGate: { expectedAppId: authoritative.expectedAppId, prepared: resolved.prepared },
      } : {}),
    });
    return {
      status: admission.status,
      deliveryId: delivery,
      prNumber: pr.number,
      headSha: pr.head.sha,
    };
  };
}
